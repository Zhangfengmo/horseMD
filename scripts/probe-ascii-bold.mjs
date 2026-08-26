// Decisive probe for ONE contested claim: does typing ASCII `**bold**` one key
// at a time in kernel mode lose the 8th character?
//
// Three sources disagree:
//   * `test:kernel-mark-inputrule-ui` PASSES, but types marks embedded in CJK
//     (`*斜*与**粗**与…`) — every delimiter run is flanked by 与.
//   * an exploratory probe reported `"**bold*"` on disk for 8 typed keys, with
//     the paragraph then latching read-only.
//   * a headless check of every intermediate (`**`, `**b`, … `**bold*`,
//     `**bold**`) says ALL of them are provable and editable, so the projection
//     map is not the refusal.
//
// This types the exact ASCII sequence with REAL keydowns and records the source
// bytes after EVERY keystroke, so the disagreement resolves to one observation.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const VISIBLE = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`

async function waitFor(fn, msg, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    const v = await fn()
    if (v) return v
    await sleep(100)
  }
  throw new Error(`timeout: ${msg}`)
}

// A real keydown that also delivers the character. `Input.insertText` produces
// NO keydown, and anything whose meaning lives in a keymap then measures the
// wrong code path (docs/ai-handoff.md 5.2d "测试铁律").
const keyDown = async (send, key, code, text) => {
  const common = { key, code, windowsVirtualKeyCode: key.length === 1 ? key.charCodeAt(0) : 0 }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, ...(text == null ? {} : { text }) })
  await sleep(40)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(90)
}
const codeFor = (ch) =>
  ch === ' ' ? 'Space' : /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : /[0-9]/.test(ch) ? `Digit${ch}` : 'Key'

const readSource = async (evaluate) => {
  // Toggle to source, read the textarea, toggle back — the only way to read the
  // kernel's bytes from a production build (window.__horsemd is DEV-only).
  await evaluate(`(() => { const b = [...document.querySelectorAll('.status-btn')].find((n) => n.offsetParent && !n.classList.contains('block-switch-caret-btn') && /源码|Source/.test((n.title||'')+(n.textContent||''))); b?.click(); return !!b })()`)
  const v = await waitFor(() => evaluate(`[...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)?.value ?? null`), 'source view')
  await evaluate(`(() => { const b = [...document.querySelectorAll('.status-btn')].find((n) => n.offsetParent && !n.classList.contains('block-switch-caret-btn') && /源码|Source|富文本|Rich/.test((n.title||'')+(n.textContent||''))); b?.click(); return !!b })()`)
  await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'rich back')
  return v
}

const CASES = [
  { name: 'ASCII bold, own line', prefix: '', typed: '**bold**' },
  { name: 'ASCII bold after a word', prefix: 'x ', typed: '**bold**' },
  { name: 'CJK bold after CJK (committed-test shape)', prefix: '与', typed: '**粗**' },
  { name: 'ASCII em, own line', prefix: '', typed: '*em*' },
  { name: 'ASCII inline code, own line', prefix: '', typed: '`code`' }
]

const port = Number(process.env.CDP_PORT || 10811)
const root = `/tmp/horsemd-ascii-bold-${process.pid}`
let failures = 0

for (const [index, testCase] of CASES.entries()) {
  const dir = join(root, `case${index}`)
  const file = join(dir, 'doc.md')
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(file, ['# 标记', '', '锚点。', ''].join('\n'))

  let app
  try {
    app = await launchBuiltElectron({
      profileDir: join(dir, 'profile'),
      port: port + index,
      appArgs: [file],
      kernelDefault: true
    })
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${VISIBLE})?.textContent?.includes('锚点')`), 'mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel attach')
    const attachDiag = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!attachDiag.includes('attach-unmappable'), `degraded to legacy: ${attachDiag}`)
    await sleep(500)

    // Caret to the end of 锚点。 — a real click, because a DOM Range does not
    // sync ProseMirror state.
    const rect = await evaluate(`(() => {
      const t = [...(${VISIBLE}).querySelectorAll('p')].find((n) => n.textContent.startsWith('锚点'))
      t.scrollIntoView({ block: 'center' })
      const r = t.getBoundingClientRect()
      return { x: r.right - 2, y: r.top + r.height / 2 }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
    await sleep(250)
    await keyDown(send, 'Enter', 'Enter')
    await sleep(400)

    for (const ch of testCase.prefix) await keyDown(send, ch, codeFor(ch), ch)
    await evaluate(`window.__hmKernelDiagnostics = []`)

    console.log(`\n### ${testCase.name}   prefix=${JSON.stringify(testCase.prefix)} typed=${JSON.stringify(testCase.typed)}`)
    const trace = []
    for (const [i, ch] of [...testCase.typed].entries()) {
      await keyDown(send, ch, codeFor(ch), ch)
      await sleep(260)
      const line = (await readSource(evaluate)).split('\n')[4] ?? ''
      trace.push(line)
      console.log(`  key ${String(i + 1).padStart(2)} ${JSON.stringify(ch)} -> line ${JSON.stringify(line)}`)
    }
    await sleep(700)

    const dom = JSON.parse(await evaluate(`(() => {
      const ed = ${VISIBLE}
      const pick = (sel) => [...ed.querySelectorAll(sel)].map((n) => n.textContent).join(',')
      return JSON.stringify({ em: pick('p em'), strong: pick('p strong'), code: pick('p code') })
    })()`))

    await evaluate(`(window.confirm = () => true, 1)`)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save fab')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save settle')
    const disk = await readFile(file, 'utf8')
    const expectedLine = testCase.prefix + testCase.typed
    const gotLine = disk.split('\n')[4] ?? ''
    const diag = JSON.parse(await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`))
    const refusals = diag.filter((d) => /refus|unsupported|read-only|unmappable|fallback/i.test(JSON.stringify(d)))

    console.log(`  DOM marks : ${JSON.stringify(dom)}`)
    console.log(`  disk line : ${JSON.stringify(gotLine)}`)
    console.log(`  expected  : ${JSON.stringify(expectedLine)}`)
    console.log(`  refusals  : ${refusals.length}${refusals.length ? ' -> ' + JSON.stringify(refusals.slice(0, 4)) : ''}`)
    console.log(`  dialogs   : ${JSON.stringify(app.dialogs.map((d) => d.message))}`)
    if (gotLine === expectedLine) {
      console.log(`  RESULT    : PASS — every typed byte landed`)
    } else {
      failures += 1
      console.log(`  RESULT    : FAIL — ${expectedLine.length} keys typed, ${gotLine.length} bytes on disk`)
    }
  } catch (err) {
    failures += 1
    console.log(`  RESULT    : ERROR — ${err.message}`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

await rm(root, { recursive: true, force: true })
console.log(`\n${failures ? `FAIL: ${failures}/${CASES.length} cases lost bytes` : `PASS: all ${CASES.length} cases landed byte-for-byte`}`)
process.exit(failures ? 1 : 0)
