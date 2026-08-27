// D6 scope probe. The gateway's own comment says typing INSIDE a mark run
// "inherits the mark, so the storedMarks/mark-inheritance trap stays refused".
// If that is true on the running app, D6 is not a paragraph-END defect at all —
// it is "a bold word cannot be edited", which is a much larger hole than the
// leftover note describes. Measured, not assumed.
import { mkdir, rm, writeFile } from 'node:fs/promises'
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

const CASES = [
  { name: 'MIDDLE of **bold**', tag: 'strong', frac: 0.5 },
  { name: 'START of **bold**', tag: 'strong', frac: 0.02 },
  { name: 'end of paragraph (control)', tag: null, frac: 1 }
]

const root = `/tmp/horsemd-mark-interior-${process.pid}`
const out = []

for (const [index, testCase] of CASES.entries()) {
  const dir = join(root, `case${index}`)
  const file = join(dir, 'doc.md')
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await writeFile(file, ['# 标记', '', '甲 **bold** 乙', ''].join('\n'))

  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(dir, 'profile'), port: 10980 + index, appArgs: [file], kernelDefault: true })
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${VISIBLE})?.textContent?.includes('甲')`), 'mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel attach')
    await sleep(400)
    await evaluate(`window.__hmKernelDiagnostics = []`)

    const target = testCase.tag
      ? `(${VISIBLE}).querySelector('${testCase.tag}')`
      : `[...(${VISIBLE}).querySelectorAll('p')].find((n) => n.textContent.startsWith('甲'))`
    const nudge = testCase.frac === 1 ? '- 2' : ''
    const rect = await evaluate(`(() => {
      const t = ${target}
      t.scrollIntoView({ block: 'center' })
      const r = t.getBoundingClientRect()
      return { x: r.left + r.width * ${testCase.frac} ${nudge}, y: r.top + r.height / 2 }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
    await sleep(300)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Z', code: 'KeyZ', text: 'Z', windowsVirtualKeyCode: 90 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Z', code: 'KeyZ', windowsVirtualKeyCode: 90 })
    await sleep(500)

    const dom = await evaluate(`[...(${VISIBLE}).querySelectorAll('p')].find((n) => n.textContent.startsWith('甲'))?.textContent ?? ''`)
    const diag = JSON.parse(await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`))
    out.push({ name: testCase.name, dom, code: diag[0]?.code || '' })
  } catch (err) {
    out.push({ name: testCase.name, dom: `ERROR ${err.message}`, code: '' })
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

await rm(root, { recursive: true, force: true })
console.log('\n=== TYPING INSIDE A BOLD RUN ===\n')
for (const r of out) {
  console.log(`  ${r.dom.includes('Z') ? 'LANDS    ' : 'SWALLOWED'}  ${r.name.padEnd(30)} ${JSON.stringify(r.dom)}  ${r.code}`)
}
