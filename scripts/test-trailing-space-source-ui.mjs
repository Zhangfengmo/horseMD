// Regression: saving a space typed at the END of a block must preserve the
// literal source spelling. `&#x20;` was introduced as an internal
// round-trip workaround, but it changes the user's Markdown and is not a
// representation other editors produce or need to understand specially.
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
    expected: '# T\n\n段落甲 \n\n段落乙\n',
    target: '段落甲',
    selector: 'p'
  },
  {
    name: 'quoted paragraph',
    source: '# T\n\n> 引用甲\n>\n> 引用乙\n\n尾段\n',
    expected: '# T\n\n> 引用甲 \n>\n> 引用乙\n\n尾段\n',
    target: '引用甲',
    selector: 'blockquote > p'
  },
  {
    name: 'list item',
    source: '# T\n\n- 项一\n- 项二\n\n尾段\n',
    expected: '# T\n\n- 项一 \n- 项二\n\n尾段\n',
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
    const saved = await readFile(file, 'utf8')
    assert.equal(saved, testCase.expected, `${testCase.name}: trailing space must remain literal source`)
    assert.ok(!saved.includes('&#x20;'), `${testCase.name}: source must not gain an HTML space entity`)
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
  console.log('PASS trailing space: terminal spaces stay literal in paragraph, quote and list source')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
