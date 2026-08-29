// SHORTCUT MATRIX (2026-08-29, user: 「检查还有哪些需要完成的快捷方式都要加入」).
// Every shortcut the app documents, applied in kernel mode, asserted by BYTES.
//
// Measured before this pass: the five mark shortcuts worked, and the BLOCK
// TYPE shortcuts did not — `Mod+1`…`Mod+6` / `Mod+0` (command-definitions.js,
// listed in the onboarding table) were refused in kernel mode while legacy
// converted the block. A documented shortcut that a mode switch silently
// removes is exactly the "restore the operation logic" case, so it is now a
// byte edit of its own (`convertBlockTypeAtCaret`) and pinned here.
//
// The anchors sit in the MIDDLE of a document with real bulk around them —
// the position lesson from test-kernel-position-matrix-ui.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const port = Number(process.env.CDP_PORT || 10289)
const V = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`
async function waitFor(fn, m, t = 90) { for (let i = 0; i < t; i += 1) { const v = await fn(); if (v) return v; await sleep(100) } throw new Error(m) }

const FILLER = (tag) => Array.from({ length: 6 }, (_, i) => `${tag}段落${i + 1}：让文档有真实体量，避免只在小样本上成立。`).join('\n\n')
const TARGET = '中间段落文字'
const docFor = (body) => `${FILLER('前')}\n\n${body}\n\n${FILLER('后')}\n`

// modifiers: 1=Alt 2=Ctrl 4=Meta 8=Shift
const CASES = [
  { name: 'bold Mod-b', body: TARGET, key: 'b', code: 'KeyB', mods: 4, select: true, expect: `**${TARGET}**` },
  { name: 'italic Mod-i', body: TARGET, key: 'i', code: 'KeyI', mods: 4, select: true, expect: `*${TARGET}*` },
  { name: 'inline code Mod-e', body: TARGET, key: 'e', code: 'KeyE', mods: 4, select: true, expect: `\`${TARGET}\`` },
  { name: 'strike Mod-Alt-x', body: TARGET, key: 'x', code: 'KeyX', mods: 5, select: true, expect: `~~${TARGET}~~` },
  { name: 'highlight Mod-Alt-h', body: TARGET, key: 'h', code: 'KeyH', mods: 5, select: true, expect: `==${TARGET}==` },
  { name: 'h1 Mod-1', body: TARGET, key: '1', code: 'Digit1', mods: 4, select: false, expect: `# ${TARGET}` },
  { name: 'h3 Mod-3', body: TARGET, key: '3', code: 'Digit3', mods: 4, select: false, expect: `### ${TARGET}` },
  { name: 'h2 from h3 Mod-2', body: `### ${TARGET}`, key: '2', code: 'Digit2', mods: 4, select: false, expect: `## ${TARGET}` },
  { name: 'paragraph Mod-0 from h3', body: `### ${TARGET}`, key: '0', code: 'Digit0', mods: 4, select: false, expect: TARGET }
]

for (const [index, testCase] of CASES.entries()) {
  const fixture = docFor(testCase.body)
  const root = `/tmp/horsemd-shortcut-pin-${process.pid}-${index}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture)
  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${V})?.textContent?.includes(${JSON.stringify(TARGET)})`), `mount (${testCase.name})`)
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel mode')
    await sleep(900)
    await evaluate(`(() => {
      window.__t = []
      window.addEventListener('hm:toast', (e) => window.__t.push(e.detail?.msg ?? String(e.detail)))
      return true
    })()`)
    const box = await evaluate(`(() => {
      const n = [...(${V}).querySelectorAll('p,h1,h2,h3,h4,h5,h6')].find((x) => x.textContent === ${JSON.stringify(TARGET)})
      if (!n) return null
      n.scrollIntoView({ block: 'center' })
      const r = n.getBoundingClientRect()
      return { left: r.left + 3, right: r.right - 3, y: r.top + r.height / 2 }
    })()`)
    assert.ok(box, `${testCase.name}: target block not found`)
    if (testCase.select) {
      let selected = false
      for (let attempt = 0; attempt < 5 && !selected; attempt += 1) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.left, y: box.y, button: 'left', clickCount: 1 })
        for (let step = 1; step <= 6; step += 1) {
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.left + ((box.right - box.left) * step) / 6, y: box.y, button: 'left', buttons: 1 })
          await sleep(30)
        }
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.right, y: box.y, button: 'left', clickCount: 1 })
        await sleep(350)
        selected = await evaluate(`(() => { const s = window.getSelection(); return !!s && s.toString().length > 0 })()`)
      }
      assert.ok(selected, `${testCase.name}: could not build a selection`)
    } else {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.right, y: box.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.right, y: box.y, button: 'left', clickCount: 1 })
      await sleep(400)
    }
    const vk = testCase.key.toUpperCase().charCodeAt(0)
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: testCase.key, code: testCase.code, modifiers: testCase.mods, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    await sleep(60)
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: testCase.key, code: testCase.code, modifiers: testCase.mods, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    await sleep(900)
    const toasts = await evaluate(`JSON.stringify(window.__t)`)
    assert.ok(!/无效操作|Invalid operation|未写入|只读|先选中/.test(toasts), `${testCase.name}: refused — toasts: ${toasts}`)
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(900)
    const bytes = await readFile(file, 'utf8')
    assert.equal(bytes, docFor(testCase.expect), `${testCase.name}: unexpected bytes`)
  } finally {
    await stopBuiltElectron(app)
  }
}

console.log('PASS kernel shortcut matrix: the five mark shortcuts and the block-type shortcuts (Mod+1/2/3, Mod+0, including heading-to-heading and heading-to-paragraph) all write the bytes legacy writes, in the middle of a document with real bulk around them')
