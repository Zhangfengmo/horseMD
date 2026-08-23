// BACKSPACE IN THE SAME-LINE NESTED BARE ITEM (2026-08-24 user report,
// screenshot: caret in the `4.` of `3. 4.`, Backspace refused read-only).
// The authored spelling pairs both empty items mdBlock-null, so no charMap
// position covers the caret — the structural handler now falls back to the
// marker derivation (`markerRawOffsetAt`), and `liftEmptyListItem` rewrites
// the nested marker into the ledgered seed NBSP; the second Backspace exits
// through the visually-empty family. This suite drives the full chain in the
// real app: two Backspaces, then typing, byte-exact save, cold reopen.
// LF + CRLF.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

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
  const root = `/tmp/horsemd-nested-bare-${label}-${process.pid}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, ['# 你好啊', '', '1. 2.3121312', '2. 2131', '3. 4.', ''].join(ending))

  let app = await launchBuiltElectron({ profileDir: join(root, `profile-${port}`), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${VISIBLE})?.textContent?.includes('你好啊')`), 'mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel attach')
    await sleep(800)

    // caret into the bare nested `4.` (the last list item)
    const rect = await evaluate(`(() => {
      const items = [...(${VISIBLE}).querySelectorAll('li')]
      const t = items[items.length - 1]
      t.scrollIntoView({ block: 'center' })
      const r = t.getBoundingClientRect()
      return { x: r.left + 30, y: r.top + 10 }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
    await sleep(300)

    const toast = () => evaluate(`document.querySelector('.hm-toast')?.textContent ?? null`)
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(600)
    assert.equal(await toast(), null, `${label}: the first Backspace must not refuse`)
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(600)
    assert.equal(await toast(), null, `${label}: the second Backspace must not refuse`)
    await typeTextLikeUser(send, '好了', { delayMs: 50 })
    await sleep(500)

    await evaluate(`(window.confirm = () => true, 1)`)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save fab')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save settle')
    const disk = await readFile(file, 'utf8')
    const expected = ['# 你好啊', '', '1. 2.3121312', '2. 2131', '', '好了', ''].join(ending)
    if (disk !== expected) {
      console.error('  actual  :', JSON.stringify(disk))
      console.error('  expected:', JSON.stringify(expected))
    }
    assert.equal(disk, expected, `${label}: two Backspaces delete both bare items and the typed text lands as its own paragraph`)
    if (ending === '\r\n') {
      assert.equal(/(?<!\r)\n/.test(disk), false, 'a CRLF document must not gain a lone LF')
    }
    assert.equal(app.dialogs.length, 0, 'no dialog may appear')
  } finally {
    await stopBuiltElectron(app, { removeProfile: false })
  }

  // cold reopen: the cleaned document renders (no ordered items left)
  app = await launchBuiltElectron({ profileDir: join(root, `profile-${port + 1}`), port: port + 1, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate } = app
    await waitFor(() => evaluate(`(${VISIBLE})?.textContent?.includes('好了')`), 'reopen mount')
    const liTexts = await evaluate(`[...(${VISIBLE}).querySelectorAll('li')].map((n) => (n.textContent || '').trim()).join('|')`)
    assert.ok(!liTexts.includes('4.') && !liTexts.split('|').includes(''),
      `${label} reopen: no bare empty items survive (li texts: ${JSON.stringify(liTexts)})`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
  console.log(`PASS kernel nested-bare Backspace ${label}`)
}

await runScenario({ ending: '\n', port: Number(process.env.CDP_PORT || 10356) })
await runScenario({ ending: '\r\n', port: Number(process.env.CDP_PORT || 10356) + 4 })
console.log('PASS kernel nested-bare Backspace: the `3. 4.` bare items delete with two Backspaces (seed rewrite -> visually-empty exit), typed text lands as a paragraph, bytes exact on disk, clean cold reopen (LF + CRLF)')
