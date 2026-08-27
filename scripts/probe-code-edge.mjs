// Decisive A/B for one question: clicking at the RIGHT EDGE of an inline-code
// element (not past the paragraph) and typing — what did that do BEFORE the D6
// marked-insert classification existed, and what does it do after?
//
// If the pre-fix answer is '`code`Z' then the marked path has taken over a
// gesture that used to work and the fix regressed inline code. If the pre-fix
// answer is that the keystroke was SWALLOWED, then inline code was never
// exempt at this caret and the fix improved it.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const VISIBLE = "[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)"

async function waitFor(fn, msg, tries = 120) {
  for (let i = 0; i < tries; i += 1) {
    const v = await fn()
    if (v) return v
    await sleep(120)
  }
  throw new Error(`timeout: ${msg}`)
}

const CASES = [
  { name: 'inline code, click at <code> right edge', tag: 'code', line: '甲 `code` 乙' },
  { name: 'highlight, click at <mark> right edge', tag: 'mark', line: '甲 ==high== 乙' },
  { name: 'bold, click at <strong> right edge', tag: 'strong', line: '甲 **bold** 乙' }
]

const root = `/tmp/horsemd-code-edge-${process.pid}`
const rows = []

for (const [index, testCase] of CASES.entries()) {
  const dir = join(root, `case${index}`)
  const file = join(dir, 'doc.md')
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(file, ['# 标记', '', testCase.line, ''].join('\n'))

  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(dir, 'profile'), port: 12020 + index, appArgs: [file], kernelDefault: true })
    const { evaluate, send } = app
    await waitFor(() => evaluate("((" + VISIBLE + ")?.textContent || '').includes('甲')"), 'mount')
    await waitFor(() => evaluate("[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)"), 'kernel attach')
    await sleep(700)
    await evaluate('window.__hmKernelDiagnostics = []')

    const rect = await evaluate(`(() => {
      const t = (${VISIBLE}).querySelector('${testCase.tag}')
      t.scrollIntoView({ block: 'center' })
      const r = t.getBoundingClientRect()
      return { x: r.right - 1, y: r.top + r.height / 2 }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
    await sleep(300)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Z', code: 'KeyZ', text: 'Z', windowsVirtualKeyCode: 90 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Z', code: 'KeyZ', windowsVirtualKeyCode: 90 })
    await sleep(600)

    await evaluate("(() => { const b = [...document.querySelectorAll('.status-btn')].find((n) => n.offsetParent && !n.classList.contains('block-switch-caret-btn') && /源码|Source/.test((n.title||'')+(n.textContent||''))); b?.click(); return !!b })()")
    const source = await waitFor(() => evaluate("[...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)?.value ?? null"), 'source')
    const diag = JSON.parse(await evaluate('JSON.stringify(window.__hmKernelDiagnostics || [])'))
    rows.push({ name: testCase.name, line: source.split('\n')[2] ?? '', code: diag[0]?.code || '' })
  } catch (err) {
    rows.push({ name: testCase.name, line: `ERROR ${err.message}`, code: '' })
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

await rm(root, { recursive: true, force: true })
console.log('\n=== TYPE AT THE RIGHT EDGE OF THE INLINE ELEMENT ===\n')
for (const r of rows) {
  console.log(`  ${r.line.includes('Z') ? 'LANDS    ' : 'SWALLOWED'}  ${r.name.padEnd(40)} ${JSON.stringify(r.line)}  ${r.code}`)
}
