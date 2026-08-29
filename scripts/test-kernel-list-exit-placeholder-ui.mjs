// The 2026-08-30 report, pinned (user: 「富文本为第二行,但在源码中和上一行是
// 同一行,这导致我这里删除失败」). The empty line after a double-Enter list
// exit is the vouched trailing blank line. The ruling recorded in ai-handoff
// (2026-08-30 空行显形裁决): byte fidelity + correct deletion, no phantom
// SYNTAX. Three contracts:
//
//   1. the double-Enter exit leaves exactly ONE extra newline — the visible
//      blank line's own byte. Legacy, measured on the same keys, leaves a
//      junk `- [ ] ` ITEM instead; one honest newline vs junk syntax.
//   2. Backspace on a MID-document blank line removes it and the caret
//      returns to the block above (the user's 「直接点击删除应该是回到上一行」).
//   3. Backspace on the TRAILING blank takes its newline back out — the
//      round trip is byte-identical.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const port = Number(process.env.CDP_PORT || 10291)
const V = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`
async function waitFor(fn, m, t = 90) { for (let i = 0; i < t; i += 1) { const v = await fn(); if (v) return v; await sleep(100) } throw new Error(m) }

const TASKS = '你好\n\n- [ ] 31313\n- [ ] 1321321\n- [ ] 2321321 看见了自己擦的去\n'

let seq = 0
async function withApp(fixture, body) {
  seq += 1
  const root = `/tmp/horsemd-listexit-${process.pid}-${seq}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture)
  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${V})?.textContent?.length > 3`), 'editor mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel mode')
    await sleep(900)
    const save = async () => {
      await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
      await sleep(800)
      return readFile(file, 'utf8')
    }
    const clickLast = async (selector) => {
      const box = await evaluate(`(() => {
        const nodes = [...(${V}).querySelectorAll(${JSON.stringify(selector)})]
        const n = nodes[nodes.length - 1]
        if (!n) return null
        const r = n.getBoundingClientRect()
        return { x: r.right - 8, y: r.top + r.height / 2 }
      })()`)
      assert.ok(box, `no ${selector}`)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
      await sleep(400)
    }
    return await body({ evaluate, send, save, clickLast })
  } finally {
    await stopBuiltElectron(app)
  }
}

// 1 + 3) list exit writes nothing; Backspace on the placeholder goes home.
await withApp(TASKS, async ({ evaluate, send, save, clickLast }) => {
  await clickLast('li')
  await pressKey(send, { key: 'End', code: 'End' })
  await sleep(200)
  await pressKey(send, { key: 'Enter', code: 'Enter' })
  await sleep(700)
  await pressKey(send, { key: 'Enter', code: 'Enter' })
  await sleep(700)
  // The exit leaves exactly ONE extra newline: the visible blank line's own
  // byte (the vouched trailing chain commits it). Legacy, same keys, leaves a
  // junk `- [ ] ` ITEM instead — measured. One honest newline vs junk syntax.
  assert.equal(await save(), TASKS + '\n',
    'the double-Enter list exit leaves exactly the blank line the caret sits on')
  // Backspace on the placeholder: the caret must land back in the last item.
  await pressKey(send, { key: 'Backspace', code: 'Backspace' })
  await sleep(800)
  const caret = await evaluate(`(() => {
    const sel = window.getSelection()
    const node = sel?.anchorNode
    const el = node ? (node.nodeType === 3 ? node.parentElement : node) : null
    return el?.closest('li') ? 'li' : (el?.tagName || null)
  })()`)
  assert.equal(caret, 'li', 'Backspace on the trailing placeholder must return the caret to the last task item')
  assert.equal(await save(), TASKS, 'Backspace takes the blank line back out — byte-identical round trip')
})

// 2) a MID-document blank: Backspace removes the line, caret returns above.
await withApp('你好\n\n- [ ] 甲\n- [ ] 乙 看见了\n\n下面还有内容\n', async ({ evaluate, send, save, clickLast }) => {
  await clickLast('li')
  await pressKey(send, { key: 'End', code: 'End' })
  await sleep(200)
  await pressKey(send, { key: 'Enter', code: 'Enter' })
  await sleep(700)
  await pressKey(send, { key: 'Enter', code: 'Enter' })
  await sleep(700)
  // caret now sits on the blank line between the list and 下面还有内容
  await pressKey(send, { key: 'Backspace', code: 'Backspace' })
  await sleep(800)
  const caret = await evaluate(`(() => {
    const sel = window.getSelection()
    const node = sel?.anchorNode
    const el = node ? (node.nodeType === 3 ? node.parentElement : node) : null
    return el?.closest('li') ? 'li' : (el?.tagName || null)
  })()`)
  assert.equal(caret, 'li', 'Backspace on the mid-document blank must return the caret to the task item above')
  assert.equal(await save(), '你好\n\n- [ ] 甲\n- [ ] 乙 看见了\n\n下面还有内容\n',
    'the round trip leaves the file byte-identical')
})

console.log('PASS kernel list-exit placeholder: the double-Enter task-list exit leaves exactly the visible blank line (no legacy `- [ ]` junk), and Backspace takes it back out with the caret returning to the item above — mid-document and at the tail')
