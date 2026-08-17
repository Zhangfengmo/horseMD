// Regression: a literal Tab as the first content of an empty heading must be
// saved as portable source, not treated as disposable heading whitespace.
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
  console.log('PASS heading leading Tab: empty heading saves as portable source')
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
