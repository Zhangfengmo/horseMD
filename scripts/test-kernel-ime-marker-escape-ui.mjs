// IME-COMMITTED RESTRUCTURING DELIMITER (2026-08-24). The marker-escaping
// delimiter first rode only handleTextInput, which a COMPOSITION commit never
// passes through — so an IME-committed `4.` (the normal Chinese-IME path)
// still spelled the literal restructuring bytes and split the item into a
// same-line nested bare pair. The escape is now consulted on the composition
// commit path too (editor-kernel-mode.js commitReplace, next to the
// block-tail heal and the task-seed dissolve — the same route-blindness
// family both of those were about). This suite drives a real composition
// (imeSetComposition -> insertText) committing `4.` at a new item's content
// start and asserts the escaped byte, the unsplit view, and the byte-exact
// save. LF + CRLF.
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
  const root = `/tmp/horsemd-ime-escape-${label}-${process.pid}`
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
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(500)

    // Compose '4.' as one IME session and commit it.
    await send('Input.imeSetComposition', { text: '4', selectionStart: 1, selectionEnd: 1, replacementId: 'e1', location: 0 })
    await sleep(150)
    await send('Input.imeSetComposition', { text: '4.', selectionStart: 2, selectionEnd: 2, replacementId: 'e1', location: 0 })
    await sleep(150)
    await send('Input.insertText', { text: '4.' })
    await sleep(700)

    const lis = await evaluate(`[...(${VISIBLE}).querySelectorAll('li')].map((n) => (n.textContent || '').trim()).join('|')`)
    assert.ok(!lis.split('|').includes(''), `${label}: no bare empty item may appear (lis: ${JSON.stringify(lis)})`)
    assert.ok(lis.includes('4.'), `${label}: the composed "4." renders as literal item text (lis: ${JSON.stringify(lis)})`)

    await evaluate(`(window.confirm = () => true, 1)`)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save fab')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save settle')
    const disk = await readFile(file, 'utf8')
    const expected = ['# 你好啊', '', '1. 2.3121312', '2. 2131', '3. 4\\.', ''].join(ending)
    if (disk !== expected) {
      console.error('  actual  :', JSON.stringify(disk))
      console.error('  expected:', JSON.stringify(expected))
    }
    assert.equal(disk, expected, `${label}: the IME-committed delimiter lands escaped`)
    assert.equal(app.dialogs.length, 0, 'no dialog may appear')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
  console.log(`PASS kernel IME marker escape ${label}`)
}

await runScenario({ ending: '\n', port: Number(process.env.CDP_PORT || 10366) })
await runScenario({ ending: '\r\n', port: Number(process.env.CDP_PORT || 10366) + 4 })
console.log('PASS kernel IME marker escape: a composition-committed `4.` at an item start spells the escaped literal (no same-line nested split), renders as item text, and saves byte-exactly (LF + CRLF)')
