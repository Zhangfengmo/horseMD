// The structural-key matrix (2026-08-29, user: 「现有交互逻辑链路不全…补全整个
// markdown 的快捷交互逻辑」). A sweep of every block type x caret position x
// structural key, run in the built app, found the chain's holes; this suite
// pins the ones that got filled, each with the bytes the gesture must write.
//
// Refused before, all of them 「无效操作…未写入」:
//   list / task / heading, caret at the block's END + Delete
//     -> Delete and Backspace are the same seam, and only Backspace answered.
//   list item, caret at its CONTENT START + Backspace (and Delete)
//     -> legacy lifts the item out of the list; the kernel refused.
//   a table cell + Enter
//     -> the editor's own convention is `<br>` (editor-tablebreak.js); the
//        kernel had no answer at all.
//   Tab on a list's FIRST item / Shift-Tab on a TOP-LEVEL item
//     -> nothing can happen there, and the kernel said so with a toast.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const port = Number(process.env.CDP_PORT || 10273)
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
async function run({ body, selector, target, edge, key, modifiers = 0, expect, expectSilent = false, label, type = '' }) {
  seq += 1
  const fixture = `开头段。\n\n${body}\n\n尾段。\n`
  const root = `/tmp/horsemd-structural-${process.pid}-${seq}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture)
  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${V})?.textContent?.includes('尾段')`), `mount (${label})`)
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), `kernel mode (${label})`)
    await sleep(800)
    await evaluate(`(() => {
      window.__t = []
      window.addEventListener('hm:toast', (e) => window.__t.push(e.detail?.msg ?? String(e.detail)))
      return true
    })()`)
    const box = await evaluate(`(() => {
      const nodes = [...(${V}).querySelectorAll(${JSON.stringify(selector)})]
      const n = nodes.find((x) => x.textContent.trim() === ${JSON.stringify(target)}) || nodes[0]
      if (!n) return null
      const r = n.getBoundingClientRect()
      const edge = ${JSON.stringify(edge)}
      const x = edge === 'end' ? r.right - 3 : edge === 'mid' ? r.left + r.width / 2 : r.left + 3
      return { x, y: r.top + r.height / 2 }
    })()`)
    assert.ok(box, `${label}: could not find ${target}`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(400)
    // 'Shift-Tab' is not a DOM key: the event must carry key='Tab' with the
    // shift MODIFIER, or no handler ever sees it and a silence assertion
    // passes vacuously (2026-08-30 branch review, confirmed).
    const domKey = key === 'Shift-Tab' ? 'Tab' : key
    await pressKey(send, { key: domKey, code: domKey === 'Tab' ? 'Tab' : domKey, modifiers })
    await sleep(900)
    if (type) {
      await send('Input.insertText', { text: type })
      await sleep(800)
    }
    const toasts = await evaluate(`JSON.stringify(window.__t)`)
    assert.ok(!/无效操作|Invalid operation|未写入|只读/.test(toasts), `${label}: must not be refused — toasts: ${toasts}`)
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(800)
    const bytes = await readFile(file, 'utf8')
    if (expectSilent) {
      assert.equal(bytes, fixture, `${label}: a no-op must write nothing at all`)
    } else {
      assert.equal(bytes, expect, `${label}: unexpected bytes`)
    }
  } finally {
    await stopBuiltElectron(app)
  }
}

// DELETE IS BACKSPACE'S MIRROR — the block below joins in, whichever key.
await run({ label: 'bullet end + Delete', body: '- 甲\n- 乙', selector: 'li p', target: '乙', edge: 'end', key: 'Delete', expect: '开头段。\n\n- 甲\n- 乙尾段。\n' })
await run({ label: 'task end + Delete', body: '- [ ] 待办', selector: 'li p', target: '待办', edge: 'end', key: 'Delete', expect: '开头段。\n\n- [ ] 待办尾段。\n' })
await run({ label: 'heading end + Delete', body: '## 中间标题', selector: 'h2', target: '中间标题', edge: 'end', key: 'Delete', expect: '开头段。\n\n## 中间标题尾段。\n' })

// A LIST ITEM'S CONTENT START — the item leaves the list, both keys.
await run({ label: 'bullet start + Backspace', body: '- 甲\n- 乙', selector: 'li p', target: '乙', edge: 'start', key: 'Backspace', expect: '开头段。\n\n- 甲\n\n乙\n\n尾段。\n' })
await run({ label: 'bullet start + Delete', body: '- 甲\n- 乙', selector: 'li p', target: '乙', edge: 'start', key: 'Delete', expect: '开头段。\n\n- 甲\n\n乙\n\n尾段。\n' })

// A TABLE CELL + Enter — the editor's own `<br>`.
await run({
  label: 'table cell + Enter',
  body: '| A | B |\n| --- | --- |\n| 甲 | 乙 |',
  selector: 'td p, td',
  target: '甲',
  edge: 'mid',
  key: 'Enter',
  expect: '开头段。\n\n| A | B |\n| --- | --- |\n| 甲<br> | 乙 |\n\n尾段。\n'
})

// A CELL BREAK IS USABLE, not just visible: the second line must accept
// typing. The guide has documented this since before kernel mode
// (guide/editing/tables.md: 「在表格单元格内按 Enter 或 Shift+Enter 会插入
// 换行」), and kernel mode used to render the break and then refuse the block
// as read-only — a break in name only.
for (const [label, key, modifiers] of [['Enter', 'Enter', 0], ['Shift+Enter', 'Enter', 8], ['Mod+Enter', 'Enter', 4]]) {
  await run({
    label: `table cell + ${label} then typing`,
    body: '| A | B |\n| --- | --- |\n| 甲 | 乙 |',
    selector: 'td p, td',
    target: '甲',
    edge: 'mid',
    key,
    modifiers,
    type: '第二行',
    expect: '开头段。\n\n| A | B |\n| --- | --- |\n| 甲<br>第二行 | 乙 |\n\n尾段。\n'
  })
}

// A RANGE SELECTION IS NOT A CARET GESTURE (2026-08-30 review finding, fixed):
// select a list item's text backward so the selection HEAD lands on the item's
// content start, press Backspace — the SELECTION is deleted; the item keeps
// its marker and is never outdented/lifted.
{
  const fixture = `开头段。\n\n- 甲\n- 乙末尾\n\n尾段。\n`
  const root = `/tmp/horsemd-structural-${process.pid}-sel`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture)
  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${V})?.textContent?.includes('乙末尾')`), 'selection-guard mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel mode')
    await sleep(800)
    const box = await evaluate(`(() => {
      const n = [...(${V}).querySelectorAll('li p')].find((x) => x.textContent === '乙末尾')
      const r = n.getBoundingClientRect()
      return { x: r.right - 3, y: r.top + r.height / 2 }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(300)
    await pressKey(send, { key: 'End', code: 'End' })
    await sleep(200)
    // Shift+Home: select the item's text backward — the head lands at the
    // content start, the exact offset the outdent/lift branches key on.
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Home', code: 'Home', modifiers: 8, windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', modifiers: 8, windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 })
    await sleep(400)
    const selected = await evaluate(`(() => { const s = window.getSelection(); return s ? s.toString() : '' })()`)
    assert.equal(selected, '乙末尾', 'Shift+Home must select the item text backward')
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(900)
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(800)
    assert.equal(await readFile(file, 'utf8'), '开头段。\n\n- 甲\n- \n\n尾段。\n',
      'Backspace over the selection deletes the TEXT — the item keeps its marker and is never outdented')
  } finally {
    await stopBuiltElectron(app)
  }
}

// NO-OPS ARE SILENT — no bytes, and no toast either.
await run({ label: 'Tab on a first item', body: '- 甲\n- 乙', selector: 'li p', target: '甲', edge: 'end', key: 'Tab', expectSilent: true })
await run({ label: 'Shift-Tab on a top-level item', body: '- 甲\n- 乙', selector: 'li p', target: '乙', edge: 'end', key: 'Shift-Tab', modifiers: 8, expectSilent: true })

console.log('PASS kernel structural matrix: Delete mirrors Backspace at a block seam (list / task / heading), a list item leaves the list from its content start with either key, Enter in a table cell writes the editor\'s own <br>, and a gesture that cannot do anything does nothing — silently')
