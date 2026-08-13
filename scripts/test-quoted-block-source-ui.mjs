// Regression: a blockquote can wrap ANY block — a fenced code block, a GFM
// table, task lists, mixed-marker lists. The visible-stream projection used to
// classify blocks BEFORE stripping the `> ` prefix, so `> ```go` was not a
// fence and `> | a | b |` was not a table: their raw bytes (language token,
// pipes, delimiter runs, cell padding) leaked into the source stream while
// canonical's did not. The two streams could never realign, so every edit in
// such a document failed closed — the user saw the rebuild prompt and could
// neither open source nor save.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-quoted-block-${process.pid}`
const file = join(root, 'quoted.md')
const port = Number(process.env.CDP_PORT || 9862)
const delay = Number(process.env.QUOTED_KEY_DELAY || 60)
const source = [
  '# Quoted blocks',
  '',
  '> 引言段落',
  '>',
  '> ```Go',
  '> func isURLEncodedByte(b byte) bool {',
  '> \treturn (b >= \'a\' && b <= \'z\') || b == \'-\' || b == \'_\'',
  '> }',
  '> ```',
  '',
  '> # 标题',
  '>',
  '> 锚点段落',
  '>',
  '> * [ ] 任务一',
  '> * [ ] 任务二',
  '>',
  '>',
  '> * [ ] 任务三',
  '>',
  '> | 表头一   | 表头二 |  |',
  '> | :----- | :-- | :----- |',
  '> |  | 单元格   | 值 |',
  '> | 末行    | 尾值  |  |',
  '',
  '> - 项一',
  '> - 项二',
  '',
  '尾段',
  ''
].join('\n')

async function waitFor(check, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)
const toggleMode = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|富文本|Rich|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

// The document is taller than the window, and a rect measured off-screen makes
// the synthetic click miss — which silently turns an edit test into a no-op.
async function clickTextEnd(evaluate, send, text) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = [...(editor?.querySelectorAll('p, td, th') || [])]
      .find((candidate) => candidate.textContent === ${JSON.stringify(text)})
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const rect = node.getBoundingClientRect()
    return { x: rect.left + 8, y: rect.top + Math.min(12, rect.height / 2) }
  })()`)
  assert.ok(point, `missing editable block: ${text}`)
  await sleep(400)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await pressKey(send, { key: 'End', code: 'End', delayMs: delay })
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, source)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    const { evaluate, send } = app
    await waitFor(() => evaluate(`[
      ...document.querySelectorAll('.ProseMirror')
    ].find((node) => node.offsetParent)?.textContent.includes('锚点段落')`), 'quoted document did not mount')

    // Enter at the end of a quoted paragraph that is FOLLOWED by more quoted
    // blocks: the canonical insertion point lands inside the block syntax
    // between them, which is exactly where the mapping used to glue the new
    // paragraph onto the previous one (`> 锚点段落新段`).
    await clickTextEnd(evaluate, send, '锚点段落')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await typeTextLikeUser(send, '新段', { delayMs: delay })
    await waitFor(() => evaluate(`[
      ...document.querySelectorAll('.ProseMirror')
    ].find((node) => node.offsetParent)?.textContent.includes('新段')`), 'the keystroke never reached the editor')

    let expected = source.replace('> 锚点段落\n', '> 锚点段落\n>\n> 新段\n')
    assert.equal(await toggleMode(evaluate), true, 'no mode button')
    const shown = await waitFor(() => visibleSource(evaluate), 'source was refused after a quoted-block edit')
    assert.equal(shown, expected, 'every untouched quoted byte must survive verbatim')

    assert.equal(await toggleMode(evaluate), true, 'could not return to rich')

    // Empty a quoted TASK item. GFM cannot spell an empty task item, so the
    // checkbox is non-durable while the row itself persists as `> * `; the
    // deletion's start also falls inside block syntax, where it used to be
    // resolved to the previous row's text end and swallow the row.
    await clickTextEnd(evaluate, send, '任务三')
    for (let index = 0; index < 3; index += 1) {
      await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: delay })
    }
    await waitFor(() => evaluate(`![
      ...[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        .querySelectorAll('li')
    ].some((item) => item.textContent.trim() === '任务三')`), 'the task item was never emptied')
    expected = expected.replace('> * [ ] 任务三', '> * ')

    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    assert.equal(await readFile(file, 'utf8'), expected, 'disk differs from the source view')
    assert.equal(
      app.dialogs.length,
      0,
      `no rebuild prompt may appear: ${JSON.stringify(app.dialogs.map((dialog) => dialog.message))}`
    )
    console.log('PASS quoted blocks: fence/table/task-list/list inside a blockquote stay byte-exact through edit, source switch and save')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
