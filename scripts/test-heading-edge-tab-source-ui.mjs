// Regression: heading-edge whitespace is content, not disposable ATX-heading
// prefix/suffix formatting. Its source must remain portable and savable.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-heading-edge-tab-${process.pid}`
const file = join(root, 'heading.md')
const port = Number(process.env.CDP_PORT || 10014)
const edge = process.env.HEADING_EDGE || 'leading'
const character = process.env.HEADING_CHARACTER === 'space' ? ' ' : '\t'
const portableCharacter = character === ' ' && edge === 'leading'
  ? '&nbsp;'
  : character === '\t'
    ? '&#x9;'
    : ' '
const expectedHeading = edge === 'leading'
  ? `${portableCharacter}二级标题`
  : `二级标题${portableCharacter}`
const expected = `# 一级标题\n\n## ${expectedHeading}\n`
const expectedRichHeading = edge === 'leading'
  ? `${character}二级标题`
  : `二级标题${character}`

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
  await writeFile(file, '# 一级标题\n\n## 二级标题\n')
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    const { evaluate, send } = app
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror h2')]
        .find((node) => node.offsetParent && node.textContent === '二级标题')`),
      'second-level heading did not mount'
    )
    await evaluate('window.__hmGateLog = []')
    assert.equal(await evaluate(`(() => {
      const heading = [...document.querySelectorAll('.ProseMirror h2')]
        .find((node) => node.offsetParent && node.textContent === '二级标题')
      const text = heading?.firstChild
      if (!text) return false
      heading.focus()
      const range = document.createRange()
      range.setStart(text, ${edge === 'leading' ? '0' : 'text.nodeValue.length'})
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`), true, `could not focus the ${edge} of second-level heading text`)

    await send('Input.insertText', { text: character })
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'heading edit did not become dirty')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(1000)
    const saveState = await evaluate(`({
      pending: !!document.querySelector('.hm-save-fab'),
      gate: window.__hmGateLog || []
    })`)
    assert.equal(saveState.pending, false, `heading ${edge} ${JSON.stringify(character)} save did not settle: ${JSON.stringify(saveState)}`)
    assert.deepEqual(app.dialogs.map((dialog) => dialog.message), [], 'heading edge whitespace must not prompt for recovery')
    assert.equal(await readFile(file, 'utf8'), expected, 'heading edge whitespace must use portable source')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await launchBuiltElectron({ profileDir: join(root, 'reopen'), port: port + 100, appArgs: [file] })
    await waitFor(
      () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror h2')].find((node) => node.offsetParent)`),
      'saved heading document did not reopen'
    )
    if (character === '\t') {
      assert.equal(
        await app.evaluate(`[
          ...document.querySelectorAll('.ProseMirror h2')
        ].find((node) => node.offsetParent)?.textContent ?? null`),
        expectedRichHeading,
        'reopened heading did not retain the literal Tab'
      )
    }
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch reopened heading document to source mode')
    await waitFor(
      () => app.evaluate(`!![...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)`),
      'reopened heading source textarea did not appear'
    )
    assert.equal(
      await app.evaluate(`[
        ...document.querySelectorAll('textarea.source-editor')
      ].find((node) => node.offsetParent)?.value ?? null`),
      expected,
      'reopened heading source must retain the authored edge-whitespace spelling'
    )
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

run().then(() => {
  console.log(`PASS heading ${edge} ${JSON.stringify(character)}: populated heading saves as portable source`)
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
