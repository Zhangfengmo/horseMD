// Probe for a defect surfaced by the Chrome channel and reported as reproducing
// identically on Electron: appending at the END of a paragraph whose last inline
// node carries an emphasis-family mark is refused, while the same append after an
// inline-code span is accepted.
//
// The user-visible gesture is ordinary: click after a bolded word at the end of a
// line and keep typing. If it is refused the keystroke is silently swallowed —
// fail-closed, so no bytes are harmed, but it reads as a dead keyboard.
//
// This is an INDEPENDENT re-run, not a re-report: each case types one real keydown
// into a freshly loaded document and reads the source bytes back.
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

const keyDown = async (send, key, code, text) => {
  const common = { key, code, windowsVirtualKeyCode: key.length === 1 ? key.charCodeAt(0) : 0 }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, ...(text == null ? {} : { text }) })
  await sleep(40)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(120)
}

const readSource = async (evaluate) => {
  await evaluate(`(() => { const b = [...document.querySelectorAll('.status-btn')].find((n) => n.offsetParent && !n.classList.contains('block-switch-caret-btn') && /源码|Source/.test((n.title||'')+(n.textContent||''))); b?.click(); return !!b })()`)
  const v = await waitFor(() => evaluate(`[...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)?.value ?? null`), 'source view')
  await evaluate(`(() => { const b = [...document.querySelectorAll('.status-btn')].find((n) => n.offsetParent && !n.classList.contains('block-switch-caret-btn') && /源码|Source|富文本|Rich/.test((n.title||'')+(n.textContent||''))); b?.click(); return !!b })()`)
  await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'rich back')
  return v
}

// Each fixture's last paragraph ends with one inline shape. We click at its visual
// end and type 'Z'. The whole question is whether the Z lands.
const CASES = [
  { name: 'ends with inline code', line: '甲 `code`' },
  { name: 'ends with **bold**', line: '甲 **bold**' },
  { name: 'ends with *em*', line: '甲 *em*' },
  { name: 'ends with ~~del~~', line: '甲 ~~del~~' },
  { name: 'ends with ==highlight==', line: '甲 ==high==' },
  { name: 'ends with [link](u)', line: '甲 [link](http://x)' },
  { name: 'ends with plain text (control)', line: '甲 plain' }
]

const port = Number(process.env.CDP_PORT || 10911)
const root = `/tmp/horsemd-trailing-mark-${process.pid}`
const results = []

for (const [index, testCase] of CASES.entries()) {
  const dir = join(root, `case${index}`)
  const file = join(dir, 'doc.md')
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(file, ['# 标记', '', testCase.line, ''].join('\n'))

  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(dir, 'profile'), port: port + index, appArgs: [file], kernelDefault: true })
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${VISIBLE})?.textContent?.includes('甲')`), 'mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel attach')
    await sleep(500)
    await evaluate(`window.__hmKernelDiagnostics = []`)

    // Click past the visual end of the paragraph — the gesture a writer makes
    // when continuing a sentence after a formatted word.
    const rect = await evaluate(`(() => {
      const t = [...(${VISIBLE}).querySelectorAll('p')].find((n) => n.textContent.startsWith('甲'))
      t.scrollIntoView({ block: 'center' })
      const r = t.getBoundingClientRect()
      return { x: r.right - 2, y: r.top + r.height / 2 }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
    await sleep(300)
    await keyDown(send, 'Z', 'KeyZ', 'Z')
    await sleep(500)

    const source = await readSource(evaluate)
    const line = source.split('\n')[2] ?? ''
    const landed = line.includes('Z')
    const diag = JSON.parse(await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`))
    const refusals = diag.filter((d) => /refus|unsupported|unclassified|read-only|unmappable/i.test(JSON.stringify(d)))
    results.push({ name: testCase.name, landed, line, refusal: refusals[0]?.code || refusals[0]?.type || '' })
  } catch (err) {
    results.push({ name: testCase.name, landed: null, line: `ERROR ${err.message}`, refusal: '' })
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

await rm(root, { recursive: true, force: true })
console.log('\n=== APPEND ONE CHARACTER AT A PARAGRAPH END ===\n')
for (const r of results) {
  console.log(`  ${r.landed === null ? 'ERR ' : r.landed ? 'LANDS  ' : 'SWALLOWED'}  ${r.name.padEnd(34)} ${JSON.stringify(r.line)}${r.refusal ? '  [' + r.refusal + ']' : ''}`)
}
const swallowed = results.filter((r) => r.landed === false)
console.log(`\n${swallowed.length} / ${results.length} gestures swallowed`)
