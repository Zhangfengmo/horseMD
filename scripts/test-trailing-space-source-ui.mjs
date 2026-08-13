// Regression: typing a space at the END of a block could not be saved at all.
//
// Milkdown overrides remark's `text` handler and returns a value ending in
// whitespace VERBATIM, bypassing `state.safe()` — the step that writes a
// trailing space as `&#x20;`. Mid-paragraph that is correct: the space is
// followed by more inline content and survives a re-parse untouched. As the
// LAST inline of a block it is not: a literal trailing space is dropped by the
// parser (and two of them are a hard break), so the bytes stopped describing
// the document, every candidate was refused, and the user was pushed to the
// recovery-copy dialog for one keystroke.
//
// `&#x20;` is a numeric character reference for U+0020: CommonMark decodes it
// to a space while parsing, and HTML collapses trailing whitespace anyway, so
// the rendered result is identical everywhere. It is the only spelling that
// round-trips.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-trailing-space-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 9994)
const delay = Number(process.env.TRAILING_KEY_DELAY || 70)

const CASES = [
  {
    name: 'paragraph',
    source: '# T\n\n段落甲\n\n段落乙\n',
    expected: '# T\n\n段落甲&#x20;\n\n段落乙\n',
    target: '段落甲',
    selector: 'p'
  },
  {
    name: 'quoted paragraph',
    source: '# T\n\n> 引用甲\n>\n> 引用乙\n\n尾段\n',
    expected: '# T\n\n> 引用甲&#x20;\n>\n> 引用乙\n\n尾段\n',
    target: '引用甲',
    selector: 'blockquote > p'
  },
  {
    name: 'list item',
    source: '# T\n\n- 项一\n- 项二\n\n尾段\n',
    expected: '# T\n\n- 项一&#x20;\n- 项二\n\n尾段\n',
    target: '项一',
    selector: 'li > p, li > div'
  }
]

async function waitFor(check, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function runCase(testCase, port) {
  const file = join(root, `${testCase.name.replace(/\s+/g, '-')}.md`)
  await writeFile(file, testCase.source)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, `p-${port}`), port, appArgs: [file] })
    const { evaluate, send } = app
    await waitFor(() => evaluate(`[
      ...document.querySelectorAll('.ProseMirror')
    ].find((node) => node.offsetParent)?.textContent.includes(${JSON.stringify(testCase.target)})`), 'document did not mount')

    const point = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const node = [...editor.querySelectorAll(${JSON.stringify(testCase.selector)})]
        .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(testCase.target)})
      if (!node) return null
      node.scrollIntoView({ block: 'center' })
      const rect = node.getBoundingClientRect()
      return { x: rect.left + 8, y: rect.top + Math.min(10, rect.height / 2) }
    })()`)
    assert.ok(point, `missing block: ${testCase.target}`)
    await sleep(350)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    await pressKey(send, { key: 'End', code: 'End', delayMs: delay })
    await typeTextLikeUser(send, ' ', { delayMs: delay })

    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'the trailing space did not dirty the document')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')

    assert.deepEqual(
      app.dialogs.map((dialog) => dialog.message),
      [],
      `one keystroke must not need a dialog: ${JSON.stringify(app.dialogs.map((d) => d.message))}`
    )
    assert.equal(await readFile(file, 'utf8'), testCase.expected, `${testCase.name}: trailing space must round-trip`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  let port = basePort
  for (const testCase of CASES) {
    await runCase(testCase, port)
    port += 1
  }
  console.log('PASS trailing space: a space at the end of a paragraph, quote or list item saves and round-trips')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
