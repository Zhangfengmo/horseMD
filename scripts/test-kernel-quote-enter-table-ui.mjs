// Two gestures the user asked to make DEFINITE (2026-08-29):
//
// 1) 「引用有时候按回车是换行但是有时候又能切到引用第二行，这个状态切换需要
//    明确而不是随机触发」. It was never random, it was half-built: Enter on an
//    empty quote line moved the CARET out of the quote but left its `>` lines
//    in the file (measured: `> 引用内容\n>\n> \n甲` — junk the user never
//    typed, and typing landed outside). The rule is now the list's rule,
//    stated once: a quote line WITH content keeps you in the quote, an EMPTY
//    quote line takes you out and goes with you. Legacy's bytes are the
//    reference, and this suite asserts them.
//
// 2) 「富文本的表格该怎么删除…如果表头第一个及全部内容为空就应该是删除」.
//    Backspace at the start of an EMPTY table's first cell deletes the table.
//    The emptiness scan short-circuits on the first cell that has content, so
//    a big table pays for one cell — and a big table with data never needs
//    this gesture anyway (select-and-delete, test:kernel-block-delete-ui).
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const port = Number(process.env.CDP_PORT || 10271)
const V = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`

async function waitFor(fn, message, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

let seq = 0
async function withApp(fixture, body) {
  seq += 1
  const root = `/tmp/horsemd-quote-enter-table-${process.pid}-${seq}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture)
  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${V})?.textContent?.includes('尾段')`), 'editor mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel mode')
    await sleep(800)
    await evaluate(`(() => {
      window.__t = []
      window.addEventListener('hm:toast', (e) => window.__t.push(e.detail?.msg ?? String(e.detail)))
      return true
    })()`)
    const save = async () => {
      await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
      await sleep(800)
      return readFile(file, 'utf8')
    }
    const noRefusal = async (label) => {
      const toasts = await evaluate(`JSON.stringify(window.__t)`)
      assert.ok(!/无效操作|Invalid operation|未写入|只读/.test(toasts), `${label} — toasts: ${toasts}`)
    }
    return await body({ evaluate, send, save, noRefusal })
  } finally {
    await stopBuiltElectron(app)
  }
}

const clickQuoteEnd = async ({ evaluate, send }) => {
  const box = await evaluate(`(() => {
    const quote = (${V}).querySelector('blockquote')
    const paras = [...quote.querySelectorAll('p')]
    const target = paras[paras.length - 1] || quote
    const r = target.getBoundingClientRect()
    return { x: r.right - 2, y: r.top + r.height / 2 }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(400)
}

// 1a) A quote line WITH content: Enter stays in the quote.
await withApp('开头段。\n\n> 引用内容\n\n尾段。\n', async (ctx) => {
  const { send, save, noRefusal } = ctx
  await clickQuoteEnd(ctx)
  await pressKey(send, { key: 'Enter', code: 'Enter' })
  await sleep(800)
  await send('Input.insertText', { text: '甲' })
  await sleep(800)
  await noRefusal('Enter on a content quote line')
  assert.equal(await save(), '开头段。\n\n> 引用内容\n>\n> 甲\n\n尾段。\n',
    'Enter on a content quote line starts a new QUOTED line')
})

// 1b) Enter again, on the empty quote line it just made: leave the quote, and
//     both the blank quote line and its separator go with it — legacy's bytes.
await withApp('开头段。\n\n> 引用内容\n\n尾段。\n', async (ctx) => {
  const { send, save, noRefusal } = ctx
  await clickQuoteEnd(ctx)
  await pressKey(send, { key: 'Enter', code: 'Enter' })
  await sleep(800)
  await pressKey(send, { key: 'Enter', code: 'Enter' })
  await sleep(800)
  await send('Input.insertText', { text: '甲' })
  await sleep(800)
  await noRefusal('Enter on the empty quote line')
  assert.equal(await save(), '开头段。\n\n> 引用内容\n\n甲\n\n尾段。\n',
    'the second Enter leaves the quote and takes its empty lines with it')
})

// 1d) Quote CONTINUATION at the document end of a FILE WITHOUT A TRAILING
//     TERMINATOR (FIXED 2026-08-31, the 500.md report): the split's anchor
//     (after the written `>` prefix) EQUALS text.length, which is also the
//     trailing virtual pair's raw anchor — the resolver answered the
//     paragraph OUTSIDE the quote, the caret was thrown out, and the next
//     keystroke committed outside with the blank quote lines left as junk.
//     The anchor now takes the vouched in-quote split placeholder instead.
await withApp('尾段。\n\n>你好啊', async (ctx) => {
  const { send, save, noRefusal, evaluate } = ctx
  await clickQuoteEnd(ctx)
  await pressKey(send, { key: 'Enter', code: 'Enter' })
  await sleep(800)
  const inQuote = await evaluate(`(() => {
    const sel = document.getSelection()
    const bq = (${V}).querySelector('blockquote')
    return sel?.anchorNode ? !!bq?.contains(sel.anchorNode) : null
  })()`)
  assert.equal(inQuote, true, 'the continuation caret must stay INSIDE the quote')
  await send('Input.insertText', { text: '乙' })
  await sleep(800)
  await noRefusal('quote continuation at an unterminated document end')
  assert.equal(await save(), '尾段。\n\n>你好啊\n>\n>乙',
    'the typed character continues the quote — never a paragraph outside it')
})

// 1c) A standalone (whole-empty) quote: Enter is a SILENT NO-OP.
//     FLIPPED 2026-08-31 (user decision 「改成不退」): this case used to pin
//     "one Enter and the quote is gone" — a freshly created quote the user
//     had not written into was thrown away by the very key that elsewhere
//     CONTINUES a quote, and the user hit exactly that. Now the key is
//     swallowed (no toast, no bytes), typing fills the quote's first line,
//     and Backspace remains the keyboard way to delete the empty quote.
await withApp('开头段。\n\n>\n\n尾段。\n', async (ctx) => {
  const { send, save, noRefusal, evaluate } = ctx
  const box = await evaluate(`(() => {
    const quote = (${V}).querySelector('blockquote')
    const r = quote.getBoundingClientRect()
    return { x: r.left + 8, y: r.top + r.height / 2 }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(400)
  await pressKey(send, { key: 'Enter', code: 'Enter' })
  await sleep(800)
  await send('Input.insertText', { text: '甲' })
  await sleep(800)
  await noRefusal('Enter in a standalone empty quote')
  assert.equal(await save(), '开头段。\n\n>甲\n\n尾段。\n',
    'Enter is swallowed and the typing fills the quote\'s first line — the quote survives')
})

// 2a) An EMPTY table: Backspace at the first cell's start deletes it.
await withApp('开头段。\n\n|  |  |\n| --- | --- |\n|  |  |\n\n尾段。\n', async (ctx) => {
  const { evaluate, send, save, noRefusal } = ctx
  const box = await evaluate(`(() => {
    const cell = (${V}).querySelector('table th, table td')
    const r = cell.getBoundingClientRect()
    return { x: r.left + 6, y: r.top + r.height / 2 }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(500)
  await pressKey(send, { key: 'Backspace', code: 'Backspace' })
  await sleep(900)
  await noRefusal('Backspace in an empty table')
  assert.equal(await evaluate(`!!(${V}).querySelector('table')`), false, 'the empty table must be gone')
  assert.equal(await save(), '开头段。\n\n尾段。\n', 'the empty table and its separator go, the neighbours stay')
})

// 2b) NEGATIVE CONTROL — a table WITH content keeps its table on the same
//     keystroke. (That table is deleted by selecting it; see
//     test:kernel-block-delete-ui.)
await withApp('开头段。\n\n| A | B |\n| --- | --- |\n| 甲 | 乙 |\n\n尾段。\n', async (ctx) => {
  const { evaluate, send, save } = ctx
  const box = await evaluate(`(() => {
    const cell = (${V}).querySelector('table th, table td')
    const r = cell.getBoundingClientRect()
    return { x: r.left + 6, y: r.top + r.height / 2 }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(500)
  await pressKey(send, { key: 'Backspace', code: 'Backspace' })
  await sleep(900)
  assert.equal(await evaluate(`!!(${V}).querySelector('table')`), true, 'a table with content must survive')
  assert.equal(await save(), '开头段。\n\n| A | B |\n| --- | --- |\n| 甲 | 乙 |\n\n尾段。\n',
    'a table with content is untouched by this gesture')
})

console.log('PASS kernel quote-Enter + empty-table delete: Enter on a content quote line stays in the quote and on an empty one leaves it (taking the blank quote lines along, byte-identical to legacy), and Backspace at an empty table\'s first cell deletes the table while a table with content is untouched')
