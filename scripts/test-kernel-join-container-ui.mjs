// Kernel-mode JOIN INTO A CONTAINER'S LAST LINE (2026-08-28).
//
// The deletion sweep's remaining refusals were all one shape: a paragraph
// sitting after a LIST or a BLOCKQUOTE, Backspace at its start. The kernel
// refused (`unsupported-structure`) while legacy merged the paragraph into the
// container's last line — measured on the same fixtures, and those legacy
// bytes are what this suite asserts, because "what the editor means" is not a
// thing the kernel gets to redefine:
//
//   - 甲 / - 乙   + Backspace  ->  `- 甲\n- 乙尾段。`
//   1. 甲 / 2. 乙 + Backspace  ->  `1. 甲\n2. 乙尾段。`
//   - [ ] 待办    + Backspace  ->  `- [ ] 待办尾段。`
//   > 引用内容    + Backspace  ->  `> 引用内容尾段。`
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const port = Number(process.env.CDP_PORT || 10265)
const V = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`

async function waitFor(fn, message, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const CASES = [
  { name: 'bullet list', body: '- 甲\n- 乙', joined: '开头段。\n\n- 甲\n- 乙尾段。\n' },
  { name: 'ordered list', body: '1. 甲\n2. 乙', joined: '开头段。\n\n1. 甲\n2. 乙尾段。\n' },
  { name: 'task item', body: '- [ ] 待办', joined: '开头段。\n\n- [ ] 待办尾段。\n' },
  { name: 'blockquote', body: '> 引用内容', joined: '开头段。\n\n> 引用内容尾段。\n' }
]

for (const testCase of CASES) {
  const fixture = `开头段。\n\n${testCase.body}\n\n尾段。\n`
  const root = `/tmp/horsemd-join-container-${process.pid}-${testCase.name.replace(/\W/g, '')}`
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
      window.__joinToasts = []
      window.addEventListener('hm:toast', (e) => window.__joinToasts.push(e.detail?.msg ?? String(e.detail)))
      return true
    })()`)
    const box = await evaluate(`(() => {
      const node = [...(${V}).querySelectorAll('p')].find((x) => x.textContent === '尾段。')
      const r = node.getBoundingClientRect()
      return { x: r.left + 3, y: r.top + r.height / 2 }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await sleep(400)
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(900)
    const toasts = await evaluate(`JSON.stringify(window.__joinToasts)`)
    assert.ok(!/无效操作|Invalid operation|未写入|只读/.test(toasts),
      `${testCase.name}: the join must not be refused — toasts: ${toasts}`)
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(800)
    assert.equal(await readFile(file, 'utf8'), testCase.joined,
      `${testCase.name}: the paragraph must join the container's last line, byte for byte as legacy does`)
    // The joined text is typable straight away — a join that leaves the caret
    // homeless is the failure this domain has seen before.
    await send('Input.insertText', { text: '甲' })
    await sleep(700)
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(800)
    assert.equal(await readFile(file, 'utf8'), testCase.joined.replace('尾段。', '甲尾段。'),
      `${testCase.name}: typing right after the join must land at the join point, where the caret was left`)
  } finally {
    await stopBuiltElectron(app)
  }
}

console.log('PASS kernel container join: a paragraph after a bullet / ordered / task list or a blockquote joins that container\'s last line on Backspace, byte-identical to legacy, and the caret stays typable')
