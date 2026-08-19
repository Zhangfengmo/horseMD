// LEGACY LOCK — not a regression for any source-kernel change.
//
// What it pins: in LEGACY (non-kernel) mode, a Tab typed as the first content
// of an empty ATX heading must be saved as portable source rather than a byte
// CommonMark would strip. It asserts the ENTITY spelling (`&#x9;`) and DISK
// BYTES ONLY — there is no assertion that the character is visible, addressable
// or deletable in the editor, so on its own it cannot tell "portable source"
// apart from a dead byte the user can never see or remove.
//
// It is deliberately kept only because legacy mode still ships and must not
// BREAK while it does. It passes unmodified against builds from before the
// source-kernel work, so it is evidence for nothing that work changed. The
// kernel-mode contract is a different (and stronger) one: real whitespace
// characters (U+00A0), asserted VISIBLE, addressable and deletable, in
// scripts/test-kernel-heading-whitespace-ui.mjs. When legacy mode is removed,
// delete this file with it — do not "upgrade" its expectation, and never cite
// it as proof that kernel-mode whitespace works.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-heading-leading-tab-${process.pid}`
const file = join(root, 'heading.md')
const port = Number(process.env.CDP_PORT || 10013)
const expected = '# 一级标题\n\n## &#x9;\n'

async function waitFor(check, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '# 一级标题\n\n##\n')
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    const { evaluate, send } = app
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror h2')].find((node) => node.offsetParent)`),
      'empty second-level heading did not mount'
    )
    await evaluate('window.__hmGateLog = []')
    assert.equal(await evaluate(`(() => {
      const heading = [...document.querySelectorAll('.ProseMirror h2')].find((node) => node.offsetParent)
      if (!heading) return false
      heading.focus()
      const range = document.createRange()
      range.selectNodeContents(heading)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`), true, 'could not focus the empty second-level heading')

    await send('Input.insertText', { text: '\t' })
    await waitFor(
      () => evaluate(`!!document.querySelector('.hm-save-fab')`),
      'leading Tab heading edit did not mark the document dirty'
    )
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(1000)
    const saveState = await evaluate(`({
      pending: !!document.querySelector('.hm-save-fab'),
      gate: window.__hmGateLog || []
    })`)
    assert.equal(
      saveState.pending,
      false,
      `leading Tab heading save did not settle: ${JSON.stringify(saveState)}`
    )
    assert.deepEqual(app.dialogs.map((dialog) => dialog.message), [], 'heading Tab must not prompt for recovery')
    assert.equal(await readFile(file, 'utf8'), expected, 'empty heading leading Tab must persist as portable source')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('PASS legacy lock — heading leading Tab: an empty heading saves as portable source in LEGACY mode (entity spelling, disk bytes only; the kernel contract lives in test-kernel-heading-whitespace-ui.mjs)')
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
