// Kernel-mode BLOCKQUOTE deletion (2026-08-28, user: 「引用要求参照代码一样要
// 支持删除」). Measured before the pair of commands existed, kernel default-on:
//
//   caret in an EMPTY quote (`>`), Backspace
//     -> 「无效操作…未写入 (unsupported-input-type)」, shape
//        `replaceAround[5,10] cross-parent open1/0 <paragraph>` — PM's lift,
//        which no classifier owns. The quote could not be removed at all.
//   caret at the CONTENT START of `> 引用内容`, Backspace
//     -> 「无效操作…未写入 (unsupported-structure)」, a named structural
//        refusal at the content offset.
//
// Both now route to source-byte commands (commands/quote-toggle.js), mirroring
// `deleteEmptyCodeBlock`: the empty quote is deleted whole and its caret gets
// the vouched placeholder, the content quote is unwrapped one level through
// the SAME edit `toggleBlockquote` already proves. This script pins both, the
// negative control that keeps ordinary deletes ordinary, and the nested case.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const port = Number(process.env.CDP_PORT || 10257)
const V = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`

async function waitFor(fn, message, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

// One case = one app, so a refusal in one can never be read as another's
// success and the bytes always start from the fixture.
async function withApp(fixture, body) {
  const root = `/tmp/horsemd-quote-delete-${process.pid}-${Math.abs(fixture.length * 31)}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture)
  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${V})?.textContent?.includes('尾段')`), 'editor mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel mode')
    await sleep(700)
    await evaluate(`(() => {
      window.__quoteToasts = []
      window.addEventListener('hm:toast', (e) => window.__quoteToasts.push(e.detail?.msg ?? String(e.detail)))
      return true
    })()`)
    const save = async () => {
      await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
      await sleep(800)
      return readFile(file, 'utf8')
    }
    return await body({ evaluate, send, save })
  } finally {
    await stopBuiltElectron(app)
  }
}

// Click inside the quote's paragraph: `edge: 'start'` for the content start
// (the gesture under test), `edge: 'end'` for the negative control.
async function caretInQuote({ evaluate, send }, edge) {
  const box = await evaluate(`(() => {
    const quote = (${V}).querySelector('blockquote')
    if (!quote) return null
    const target = quote.querySelector('p') || quote
    const r = target.getBoundingClientRect()
    return { left: r.left + 3, right: r.right - 2, y: r.top + r.height / 2 }
  })()`)
  assert.ok(box, 'the fixture must render a blockquote')
  const x = edge === 'end' ? box.right : box.left
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(400)
}

const noRefusal = async (evaluate, label) => {
  const toasts = await evaluate(`JSON.stringify(window.__quoteToasts)`)
  assert.ok(!/无效操作|Invalid operation|未写入|只读/.test(toasts), `${label} must not be refused — toasts: ${toasts}`)
}

// 1) EMPTY QUOTE — deleted whole, and the caret keeps a typable home where it
//    stood (the vouched placeholder; typing lands in the quote's own place).
await withApp('开头段。\n\n>\n\n尾段。\n', async (ctx) => {
  const { evaluate, send, save } = ctx
  await caretInQuote(ctx, 'start')
  await pressKey(send, { key: 'Backspace', code: 'Backspace' })
  await sleep(800)
  await noRefusal(evaluate, 'Backspace in an empty blockquote')
  assert.equal(await evaluate(`!!(${V}).querySelector('blockquote')`), false, 'the empty blockquote must be gone from the view')
  await send('Input.insertText', { text: '甲' })
  await sleep(800)
  assert.equal(await save(), '开头段。\n\n甲\n\n尾段。\n',
    'typing after the delete must land where the quote stood, with no leftover blank run')
})

// 2) CONTENT QUOTE — Backspace at the content start unwraps one level.
await withApp('开头段。\n\n> 引用内容\n\n尾段。\n', async (ctx) => {
  const { evaluate, send, save } = ctx
  await caretInQuote(ctx, 'start')
  await pressKey(send, { key: 'Backspace', code: 'Backspace' })
  await sleep(800)
  await noRefusal(evaluate, 'Backspace at a blockquote content start')
  assert.equal(await evaluate(`!!(${V}).querySelector('blockquote')`), false, 'the blockquote must be unwrapped')
  assert.equal(await save(), '开头段。\n\n引用内容\n\n尾段。\n', 'unwrap must strip exactly the `> ` marker')
})

// 3) NEGATIVE CONTROL — anywhere else in the quote, Backspace is still an
//    ordinary character delete and the quote stays a quote.
await withApp('开头段。\n\n> 引用内容\n\n尾段。\n', async (ctx) => {
  const { evaluate, send, save } = ctx
  await caretInQuote(ctx, 'end')
  await pressKey(send, { key: 'Backspace', code: 'Backspace' })
  await sleep(800)
  await noRefusal(evaluate, 'Backspace inside quoted text')
  assert.equal(await evaluate(`!!(${V}).querySelector('blockquote')`), true, 'a mid-text Backspace must not unwrap the quote')
  assert.equal(await save(), '开头段。\n\n> 引用内\n\n尾段。\n', 'a mid-text Backspace deletes exactly one character')
})

// 4) NESTED — one level per press, never both.
await withApp('开头段。\n\n> > 双层引用\n\n尾段。\n', async (ctx) => {
  const { evaluate, send, save } = ctx
  await caretInQuote(ctx, 'start')
  await pressKey(send, { key: 'Backspace', code: 'Backspace' })
  await sleep(800)
  await noRefusal(evaluate, 'Backspace at a nested blockquote content start')
  assert.equal(await save(), '开头段。\n\n> 双层引用\n\n尾段。\n', 'exactly one quote level may be peeled per press')
  assert.equal(await evaluate(`!!(${V}).querySelector('blockquote')`), true, 'the outer quote must survive')
})

console.log('PASS kernel blockquote delete: an empty quote is removed whole (caret keeps a typable home), a content quote unwraps one level at its content start, nested quotes peel one level per press, and every other position keeps its ordinary character delete')
