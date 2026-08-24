// MANUAL-NUMBER ADOPTION (2026-08-24 user report「回车出现两个序列号」).
// The manual numberer's workflow: Enter makes an item (auto ordinal), they
// type THEIR number (`4.`) — the typing policy keeps it literal (`4\.`), so
// the view showed auto ordinal + typed number, doubled. The completing
// Space's RENUMBER arm (marker-space.js) now adopts the typed number as the
// item's own marker: `3. 4\.` + Space -> `4. ` — one number in the view,
// the author's number in the source, and the next Enter continues from N+1.
// LF + CRLF, byte-exact save.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const VISIBLE = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`

async function waitFor(fn, message, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function runScenario({ ending, port }) {
  const label = ending === '\n' ? 'LF' : 'CRLF'
  const root = `/tmp/horsemd-manual-number-${label}-${process.pid}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, ['# 你好啊', '', '1. 2.3121312', '2. 2131', ''].join(ending))

  const app = await launchBuiltElectron({ profileDir: join(root, `profile-${port}`), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${VISIBLE})?.textContent?.includes('2131')`), 'mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel attach')
    await sleep(800)
    const rect = await evaluate(`(() => {
      const t = [...(${VISIBLE}).querySelectorAll('li p')].find((n) => n.textContent === '2131')
      t.scrollIntoView({ block: 'center' })
      const r = t.getBoundingClientRect()
      return { x: r.right - 2, y: r.top + r.height / 2 }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
    await sleep(250)
    await pressKey(send, { key: 'End', code: 'End' })
    const kd = async (key, code, text) => {
      const vk = /[a-z0-9]/i.test(key) ? key.toUpperCase().charCodeAt(0) : key === '.' ? 190 : 0
      const common = { key, code, modifiers: 0, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, text })
      await sleep(50)
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
      await sleep(150)
    }
    const step = async (k) => {
      if (k === 'Enter') { await pressKey(send, { key: 'Enter', code: 'Enter' }); await sleep(400); return }
      if (k === ' ') { await pressKey(send, { key: ' ', code: 'Space', text: ' ' }); await sleep(400); return }
      await kd(k, k === '.' ? 'Period' : /[a-z]/.test(k) ? 'Key' + k.toUpperCase() : 'Digit' + k, k)
    }
    for (const k of ['Enter', '4', '.', ' ', 'x', 'Enter', '5', '.', ' ', 'y']) await step(k)
    await sleep(500)
    // ENTER adoption (the user's actual continuation key — the reported
    // sequence): typed `N.` + Enter folds the number into the marker and
    // continues from N+1, converging even when every item is hand-numbered.
    for (const k of ['Enter', '7', '.', 'Enter', '8', '.', 'Enter', 'z']) await step(k)
    await sleep(500)

    // ONE number per item in the view — the typed number was adopted, never
    // doubled next to the auto ordinal.
    // (li textContent includes the DISPLAYED ordinal, e.g. "3.x" — the
    // doubled failure shape would be "3.4.x" / "4.5.y": ordinal + retained
    // typed number + content.)
    const lis = await evaluate(`[...(${VISIBLE}).querySelectorAll('li')].map((n) => (n.textContent || '').trim()).join('|')`)
    assert.ok(!lis.includes('4.x') && !lis.includes('5.y') && !lis.includes('7.') === false,
      `${label}: the typed number must be ADOPTED, not remain as item text (lis: ${JSON.stringify(lis)})`)
    assert.ok(!/\d\.\d+\.(\||$)/.test(lis),
      `${label}: no item may show a doubled ordinal (lis: ${JSON.stringify(lis)})`)
    assert.ok(lis.includes('x') && lis.includes('y'), `${label}: the typed content landed (lis: ${JSON.stringify(lis)})`)

    await evaluate(`(window.confirm = () => true, 1)`)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save fab')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save settle')
    const disk = await readFile(file, 'utf8')
    const expected = ['# 你好啊', '', '1. 2.3121312', '2. 2131', '4. x', '5. y', '7. ', '8. ', '9. z', ''].join(ending)
    if (disk !== expected) {
      console.error('  actual  :', JSON.stringify(disk))
      console.error('  expected:', JSON.stringify(expected))
    }
    assert.equal(disk, expected, `${label}: the adopted numbers reach disk as the markers`)
    if (ending === '\r\n') {
      assert.equal(/(?<!\r)\n/.test(disk), false, 'a CRLF document must not gain a lone LF')
    }
    assert.equal(app.dialogs.length, 0, 'no dialog may appear')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
  console.log(`PASS kernel manual-number adoption ${label}`)
}

await runScenario({ ending: '\n', port: Number(process.env.CDP_PORT || 10386) })
await runScenario({ ending: '\r\n', port: Number(process.env.CDP_PORT || 10386) + 4 })
console.log('PASS kernel manual-number adoption: typed `N.` + Space at an empty item adopts N as the marker (one number, byte-exact save, Enter continues from N+1) — LF + CRLF')
