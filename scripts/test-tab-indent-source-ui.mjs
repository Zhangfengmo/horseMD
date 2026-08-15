// Regression: pressing Tab in a rich list creates a nested item. Its source
// must use ordinary portable Markdown indentation, never an HTML-space escape.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-tab-indent-${process.pid}`
const file = join(root, 'tab-indent.md')
const port = Number(process.env.CDP_PORT || 9997)
const delay = Number(process.env.TAB_KEY_DELAY || 70)
const expected = '# T\n\n- 父项\n  - 子项\n\n尾段\n'

async function waitFor(check, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const visibleSource = (evaluate) => evaluate(`[
  ...document.querySelectorAll('textarea.source-editor')
].find((node) => node.offsetParent)?.value ?? null`)

async function toggleSource(evaluate) {
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
    button?.click()
    return !!button
  })()`)
  assert.ok(clicked, 'source-mode button is unavailable')
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '# T\n\n- 父项\n- 子项\n\n尾段\n')
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    const { evaluate, send } = app
    const point = await waitFor(() => evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const item = [...(editor?.querySelectorAll('li > p, li > div') || [])]
        .find((node) => node.textContent.trim() === '子项')
      if (!item) return null
      const rect = item.getBoundingClientRect()
      return { x: rect.left + 8, y: rect.top + Math.min(12, rect.height / 2) }
    })()`), 'target list item did not mount')
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    await pressKey(send, { key: 'Tab', code: 'Tab', delayMs: delay })

    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'Tab did not dirty the document')
    await toggleSource(evaluate)
    const source = await waitFor(() => visibleSource(evaluate), 'source textarea did not appear')
    assert.equal(source, expected, 'Tab-created nesting must use portable Markdown indentation')
    assert.ok(!source.includes('&#x20;'), 'Tab-created nesting must not leak an HTML space entity')

    await toggleSource(evaluate)
    await waitFor(() => evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`), 'rich editor did not return')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    assert.deepEqual(app.dialogs.map((dialog) => dialog.message), [], 'Tab indentation must save without a recovery dialog')
    assert.equal(await readFile(file, 'utf8'), expected, 'saved Tab indentation must remain portable source')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().then(() => {
  console.log('PASS Tab indentation: nested list source is portable and has no HTML-space entity')
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
