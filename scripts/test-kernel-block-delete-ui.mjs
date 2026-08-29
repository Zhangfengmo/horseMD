// Kernel-mode WHOLE-BLOCK DELETION (2026-08-28, user: 「分割线、图片、表格
// 这些也无法删除，查看原有删除形式，这些需要完成」).
//
// Measured before this route existed, kernel default-on — every one of these
// wrote nothing and raised 「无效操作…未写入」:
//   divider / image, clicked (a NodeSelection) + Backspace
//     -> `replace[6,7]@doc:d0:off6 open0/0 <empty>` — a step that removes a
//        NODE, which no extractor claimed.
//   divider / image / table, Backspace at the start of the paragraph below
//     -> the paragraph-join refusal, because the block above holds no text.
//
// Now: one press SELECTS the block (zero bytes), the next DELETES it, in both
// directions (Backspace from below, Delete from above), for every block that
// is an opaque node — divider, image, table, block math, an empty fence. The
// block's bytes come from the projection map's own pairs (`hr` pairs with
// `thematicBreak`, `image-block` with its mdast node), so nothing is guessed.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const port = Number(process.env.CDP_PORT || 10259)
const V = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`

async function waitFor(fn, message, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function withApp(fixture, body) {
  const root = `/tmp/horsemd-block-delete-${process.pid}-${Math.abs(fixture.length * 7 + fixture.charCodeAt(6))}`
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
      window.__blockToasts = []
      window.addEventListener('hm:toast', (e) => window.__blockToasts.push(e.detail?.msg ?? String(e.detail)))
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

async function clickParagraph({ evaluate, send }, text, edge) {
  const box = await evaluate(`(() => {
    const node = [...(${V}).querySelectorAll('p')].find((x) => x.textContent === ${JSON.stringify(text)})
    if (!node) return null
    const r = node.getBoundingClientRect()
    return { x: ${JSON.stringify(edge)} === 'end' ? r.right - 2 : r.left + 3, y: r.top + r.height / 2 }
  })()`)
  assert.ok(box, `paragraph ${text} not found`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(400)
}

const noRefusal = async (evaluate, label) => {
  const toasts = await evaluate(`JSON.stringify(window.__blockToasts)`)
  assert.ok(!/无效操作|Invalid operation|未写入|只读/.test(toasts), `${label} must not be refused — toasts: ${toasts}`)
}

// The blocks that are opaque nodes, and the selector proving each is gone.
const BLOCKS = [
  { name: 'divider', body: '---', gone: 'hr' },
  { name: 'image', body: '![图](https://example.com/a.png)', gone: 'img' },
  { name: 'table', body: '| A | B |\n| --- | --- |\n| 甲 | 乙 |', gone: 'table' },
  { name: 'block math', body: '$$\nx^2\n$$', gone: '.math-block, .katex-display' }
]

for (const block of BLOCKS) {
  const fixture = `开头段。\n\n${block.body}\n\n尾段。\n`
  // 1) BACKSPACE FROM BELOW — press one selects, press two deletes.
  await withApp(fixture, async (ctx) => {
    const { evaluate, send, save } = ctx
    await clickParagraph(ctx, '尾段。', 'start')
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(700)
    // The selecting press writes nothing at all.
    assert.equal(await save(), fixture, `${block.name}: the selecting Backspace must write no bytes`)
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(800)
    await noRefusal(evaluate, `${block.name}: Backspace from below`)
    assert.equal(await save(), '开头段。\n\n尾段。\n',
      `${block.name}: Backspace from below must delete the block and its separator`)
  })

  // 2) DELETE FROM ABOVE — the same rule, mirrored.
  await withApp(fixture, async (ctx) => {
    const { evaluate, send, save } = ctx
    await clickParagraph(ctx, '开头段。', 'end')
    await pressKey(send, { key: 'Delete', code: 'Delete' })
    await sleep(700)
    await pressKey(send, { key: 'Delete', code: 'Delete' })
    await sleep(800)
    await noRefusal(evaluate, `${block.name}: Delete from above`)
    assert.equal(await save(), '开头段。\n\n尾段。\n',
      `${block.name}: Delete from above must delete the block and its separator`)
  })
}

// 3) THE SURROUNDING BYTES ARE NOT TOUCHED — a divider between two PARAGRAPHS
//    goes without disturbing either.
await withApp('第一段\n\n---\n\n第二段\n\n尾段。\n', async (ctx) => {
  const { evaluate, send, save } = ctx
  const box = await evaluate(`(() => {
    const node = (${V}).querySelector('hr')
    const r = node.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(400)
  await pressKey(send, { key: 'Backspace', code: 'Backspace' })
  await sleep(800)
  await noRefusal(evaluate, 'divider between two paragraphs')
  assert.equal(await save(), '第一段\n\n第二段\n\n尾段。\n',
    'the divider goes and both paragraphs keep their own bytes')
})

// 4) THE NAMED LIMIT, pinned as a limit rather than left to be discovered: a
//    divider BETWEEN TWO LISTS. Deleting it makes the two lists ONE list —
//    that is what the remaining bytes mean in CommonMark, and no spelling
//    avoids it (a blank line does not separate lists either). The neighbour
//    proof therefore refuses: a block nobody touched would change meaning.
//    Accepting it needs the predicted-merge machinery (commands/list-merge.js),
//    which is a different domain; until then this stays a refusal, and the
//    refusal is what this case holds in place.
await withApp('- 甲\n\n---\n\n- 乙\n\n尾段。\n', async (ctx) => {
  const { evaluate, send, save } = ctx
  const box = await evaluate(`(() => {
    const node = (${V}).querySelector('hr')
    const r = node.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(400)
  await pressKey(send, { key: 'Backspace', code: 'Backspace' })
  await sleep(800)
  const toasts = await evaluate(`JSON.stringify(window.__blockToasts)`)
  assert.ok(/无效操作|Invalid operation/.test(toasts),
    `a divider whose removal would merge two lists must refuse, loudly — toasts: ${toasts}`)
  assert.equal(await save(), '- 甲\n\n---\n\n- 乙\n\n尾段。\n', 'a refused deletion writes nothing')
})

// 5) CROSS-CELL CLEAR (2026-08-30, user: 「表格的删除也有问题」): click one
//    cell, Shift+click another — prosemirror-tables makes it a CellSelection —
//    Backspace clears BOTH cells' text, legacy's own answer byte for byte.
await withApp('开头段。\n\n| A | B |\n| --- | --- |\n| 甲甲甲 | 乙乙乙 |\n\n尾段。\n', async (ctx) => {
  const { evaluate, send, save } = ctx
  const cellBox = async (text) => evaluate(`(() => {
    const n = [...(${V}).querySelectorAll('td')].find((x) => x.textContent.includes(${JSON.stringify(text)}))
    const r = n.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  const a = await cellBox('甲甲甲')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x, y: a.y, button: 'left', clickCount: 1 })
  await sleep(300)
  const b = await cellBox('乙乙乙')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1, modifiers: 8 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, modifiers: 8 })
  await sleep(400)
  await pressKey(send, { key: 'Backspace', code: 'Backspace' })
  await sleep(900)
  await noRefusal(evaluate, 'cross-cell CellSelection Backspace')
  assert.equal(await save(), '开头段。\n\n| A | B |\n| --- | --- |\n|  |  |\n\n尾段。\n',
    'a CellSelection Backspace clears every selected cell, byte-identical to legacy')
})

// 6) RANGE ACROSS THE TABLE (2026-08-30, user: 「直接删除整个表格也是有问题的」):
//    select from the paragraph above across the whole table into the paragraph
//    below, Backspace — everything selected goes, PM's own result as bytes.
await withApp('开头段。\n\n| A | B |\n| --- | --- |\n| 甲甲甲 | 乙乙乙 |\n\n尾段。\n', async (ctx) => {
  const { evaluate, send, save } = ctx
  const box = await evaluate(`(() => {
    const p1 = [...(${V}).querySelectorAll('p')].find((x) => x.textContent === '开头段。')
    const p2 = [...(${V}).querySelectorAll('p')].find((x) => x.textContent === '尾段。')
    const r1 = p1.getBoundingClientRect()
    const r2 = p2.getBoundingClientRect()
    return { x1: r1.left + 3, y1: r1.top + r1.height / 2, x2: r2.right - 3, y2: r2.top + r2.height / 2 }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x1, y: box.y1, button: 'left', clickCount: 1 })
  for (let i = 1; i <= 5; i += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x1 + ((box.x2 - box.x1) * i) / 5, y: box.y1 + ((box.y2 - box.y1) * i) / 5, button: 'left', buttons: 1 })
    await sleep(40)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x2, y: box.y2, button: 'left', clickCount: 1 })
  await sleep(400)
  await pressKey(send, { key: 'Backspace', code: 'Backspace' })
  await sleep(1000)
  await noRefusal(evaluate, 'range-across-table Backspace')
  const bytes = await save()
  assert.equal(bytes.includes('|'), false, `the table inside the selection must be gone: ${bytes}`)
})

console.log('PASS kernel block delete: divider, image, table and block math delete from either side (one press selects, one deletes), the selecting press writes nothing, and the deletion never disturbs its neighbours')
