// Regression: a real Tab typed as the first character of an empty rich-text
// paragraph must save as standard Markdown/HTML source, not enter recovery.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-leading-tab-${process.pid}`
const file = join(root, 'leading-tab.md')
const port = Number(process.env.CDP_PORT || 10011)
const expected = '# T\n\n锚点\n\n&#x9;\n'

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

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
  await writeFile(file, '# T\n\n锚点\n')
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    const { evaluate, send } = app
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent && node.textContent.includes('锚点'))`),
      'editor did not mount'
    )
    await evaluate('window.__hmGateLog = []')
    assert.equal(await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent && node.textContent.includes('锚点'))
      if (!editor) return false
      editor.focus()
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`), true, 'could not focus the document end')

    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 80 })
    await send('Input.insertText', { text: '\t' })
    await waitFor(
      () => evaluate(`!!document.querySelector('.hm-save-fab')`),
      'leading Tab edit did not mark the document dirty'
    )
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(1000)
    const saveState = await evaluate(`({
      pending: !!document.querySelector('.hm-save-fab'),
      source: [...document.querySelectorAll('textarea.source-editor')]
        .find((node) => node.offsetParent)?.value ?? null,
      gate: window.__hmGateLog || []
    })`)
    assert.equal(
      saveState.pending,
      false,
      `leading Tab save did not settle: ${JSON.stringify(saveState)}`
    )
    assert.deepEqual(
      app.dialogs.map((dialog) => dialog.message),
      [],
      'a leading Tab must save without a recovery dialog'
    )
    assert.equal(await readFile(file, 'utf8'), expected, 'an otherwise empty leading Tab paragraph must persist as portable source')

    // The numeric character reference is portable authored source, so a cold
    // renderer must reconstruct the literal Tab rather than falling back to
    // an indented code block or recovery.
    await stopBuiltElectron(app, { removeProfile: true })
    app = await launchBuiltElectron({ profileDir: join(root, 'reopen'), port: port + 1, appArgs: [file] })
    await waitFor(
      () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent && node.textContent.includes('锚点'))`),
      'saved leading Tab document did not reopen'
    )
    const reopenedText = await app.evaluate(`[
      ...document.querySelectorAll('.ProseMirror')
    ].find((node) => node.offsetParent)?.textContent ?? ''`)
    assert.ok(reopenedText.includes('\t'), 'reopened rich document did not retain the literal Tab')
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch reopened document to source mode')
    await waitFor(
      () => app.evaluate(`!![...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)`),
      'reopened source textarea did not appear'
    )
    assert.equal(
      await app.evaluate(`[
        ...document.querySelectorAll('textarea.source-editor')
      ].find((node) => node.offsetParent)?.value ?? null`),
      expected,
      'reopened source must retain the portable leading-Tab spelling'
    )
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log('PASS leading Tab: first-character Tab saves as portable source')
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
