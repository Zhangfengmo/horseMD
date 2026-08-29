// POSITION MATRIX (2026-08-29, user: 「你的测试案例不能局限于局部，有时候还需要
// 测试结合大量其他文本的前部，中部，尾部的操作，防止局部成功而全局失败」).
//
// The warning is not hypothetical — it names the bug this suite was written
// alongside: Enter then `##` worked at the DOCUMENT END (the trailing
// placeholder happened to give the caret a home) and silently mis-typed the
// title into the next block anywhere else. A fixture with one paragraph would
// have passed. So every gesture here runs three times, in a document with
// substantial content on both sides: at its HEAD, its MIDDLE and its TAIL.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const port = Number(process.env.CDP_PORT || 10281)
const V = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`

async function waitFor(fn, message, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

// A document with real bulk on both sides of every anchor. The anchors are
// ordinary paragraphs so the gesture under test is the only variable.
const FILLER = (tag, n) => Array.from({ length: n }, (_, i) => `${tag}段落${i + 1}：这一段是为了让文档有真实体量，避免只在小样本上成立。`).join('\n\n')
const HEAD_ANCHOR = '头部锚点'
const MID_ANCHOR = '中部锚点'
const TAIL_ANCHOR = '尾部锚点'
const DOC = [
  HEAD_ANCHOR,
  FILLER('前', 12),
  '## 一个标题',
  FILLER('中', 12),
  MID_ANCHOR,
  FILLER('后', 12),
  '- 列表甲\n- 列表乙',
  FILLER('末', 12),
  TAIL_ANCHOR
].join('\n\n') + '\n'

// ASCII through real key events: the marker machinery keys off keydown, and
// `Input.insertText` carries none (the harness's own blind spot — measured
// twice on this branch). Punctuation has no layout-independent `code`, so it
// goes in as text; the SPACE, which every marker completion turns on, does not.
async function typeKeys(send, text) {
  for (const ch of text) {
    if (ch === ' ') {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 })
      await sleep(20)
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 })
    } else if (/[a-zA-Z0-9]/.test(ch)) {
      const code = /[a-zA-Z]/.test(ch) ? 'Key' + ch.toUpperCase() : 'Digit' + ch
      const vk = ch.toUpperCase().charCodeAt(0)
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
      await sleep(20)
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    } else {
      await send('Input.insertText', { text: ch })
    }
    await sleep(90)
  }
}

let seq = 0
async function atAnchor(anchor, body) {
  seq += 1
  const root = `/tmp/horsemd-position-${process.pid}-${seq}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, DOC)
  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${V})?.textContent?.includes(${JSON.stringify(TAIL_ANCHOR)})`), 'editor mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel mode')
    await sleep(900)
    await evaluate(`(() => {
      window.__t = []
      window.addEventListener('hm:toast', (e) => window.__t.push(e.detail?.msg ?? String(e.detail)))
      return true
    })()`)
    const box = await evaluate(`(() => {
      const n = [...(${V}).querySelectorAll('p')].find((x) => x.textContent === ${JSON.stringify(anchor)})
      if (!n) return null
      n.scrollIntoView({ block: 'center' })
      const r = n.getBoundingClientRect()
      return { x: r.right - 3, y: r.top + r.height / 2 }
    })()`)
    assert.ok(box, `anchor ${anchor} not found`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(400)
    const save = async () => {
      await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
      await sleep(900)
      return readFile(file, 'utf8')
    }
    const noRefusal = async (label) => {
      const toasts = await evaluate(`JSON.stringify(window.__t)`)
      assert.ok(!/无效操作|Invalid operation|未写入|只读/.test(toasts), `${label} @${anchor} — toasts: ${toasts}`)
    }
    return await body({ evaluate, send, save, noRefusal })
  } finally {
    await stopBuiltElectron(app)
  }
}

for (const anchor of [HEAD_ANCHOR, MID_ANCHOR, TAIL_ANCHOR]) {
  // 1) Enter, then a heading marker — the gesture whose failure was invisible
  //    at the document end.
  await atAnchor(anchor, async ({ send, save, noRefusal }) => {
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(700)
    await typeKeys(send, '## 新标题')
    await sleep(900)
    await noRefusal('Enter + `## `')
    const bytes = await save()
    assert.ok(bytes.includes(`${anchor}\n\n## 新标题`),
      `Enter + \`## \` @${anchor}: expected a real H2 right after the anchor\n${bytes.slice(0, 400)}`)
    assert.equal(bytes.includes('##新标题'), false, `@${anchor}: the marker must not stay bare`)
  })

  // 2) Enter, then a list marker.
  await atAnchor(anchor, async ({ send, save, noRefusal }) => {
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(700)
    await typeKeys(send, '- 新条目')
    await sleep(900)
    await noRefusal('Enter + `- `')
    const bytes = await save()
    assert.ok(bytes.includes(`${anchor}\n\n- 新条目`), `Enter + \`- \` @${anchor}: expected a real list item`)
  })

  // 3) Backspace at the anchor's start — the join into whatever sits above.
  await atAnchor(anchor, async ({ send, save, noRefusal }) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 })
    await sleep(300)
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(900)
    await noRefusal('Backspace at a paragraph start')
    const bytes = await save()
    if (anchor === HEAD_ANCHOR) {
      // The document's FIRST block has nothing above it: the key does nothing,
      // silently, and the bytes are untouched.
      assert.equal(bytes, DOC, `Backspace @${anchor}: a no-op must write nothing`)
    } else {
      assert.equal(bytes.includes(`\n\n${anchor}`), false,
        `Backspace @${anchor}: the anchor must have joined the block above`)
      assert.ok(bytes.includes(anchor), `Backspace @${anchor}: the anchor's text must survive the join`)
    }
  })
}

console.log('PASS kernel position matrix: Enter+`## `, Enter+`- ` and a start-of-paragraph Backspace all behave the same at the HEAD, MIDDLE and TAIL of a document with real bulk on both sides')
