// Phase-1 evidence for D6. `probe-trailing-mark-append.mjs` shows 4 of 7
// trailing inline shapes swallowing the keystroke; this probe asks WHY on the
// running app rather than reasoning about it.
//
// The PM view handle is NOT reachable in a production build (`window.__horsemd`
// is DEV-only and the doc's `pmViewDesc` carries no `view` back-pointer), so the
// evidence is taken where it is observable: the DOM caret after the click, and
// the gateway's own diagnostic record for the refused keystroke.
//
// Hypothesis under test: the swallowed shapes are exactly the ones where the
// click leaves the caret INSIDE the trailing formatting element, so ProseMirror
// gives the typed character that element's mark and gateway `plainSliceText`
// (which refuses any marked insert slice) rejects it. If the landing shapes put
// the caret OUTSIDE their element, the refusal is mark INHERITANCE — not the
// mere presence of a mark in the block.
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

const keyDown = async (send, key, code, text) => {
  const common = { key, code, windowsVirtualKeyCode: key.length === 1 ? key.charCodeAt(0) : 0 }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, ...(text == null ? {} : { text }) })
  await sleep(40)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(150)
}

const CASES = [
  { name: 'inline code', line: '甲 `code`' },
  { name: '**bold**', line: '甲 **bold**' },
  { name: '*em*', line: '甲 *em*' },
  { name: '~~del~~', line: '甲 ~~del~~' },
  { name: '==high==', line: '甲 ==high==' },
  { name: '[link](u)', line: '甲 [link](http://x)' },
  { name: 'plain', line: '甲 plain' }
]

const port = Number(process.env.CDP_PORT || 10951)
const root = `/tmp/horsemd-mark-inclusive-${process.pid}`
const rows = []

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
    await sleep(400)
    await evaluate(`window.__hmKernelDiagnostics = []`)

    const rect = await evaluate(`(() => {
      const t = [...(${VISIBLE}).querySelectorAll('p')].find((n) => n.textContent.startsWith('甲'))
      t.scrollIntoView({ block: 'center' })
      const r = t.getBoundingClientRect()
      return { x: r.right - 2, y: r.top + r.height / 2 }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
    await sleep(300)

    // Where did the click actually leave the caret? The chain of element tag
    // names from the caret's node up to the paragraph tells us whether the
    // caret is inside the formatting element (mark would be inherited) or a
    // sibling of it (it would not).
    const caret = await evaluate(`(() => {
      const sel = window.getSelection()
      if (!sel || !sel.anchorNode) return { chain: ['NO-SELECTION'] }
      const chain = []
      let n = sel.anchorNode
      while (n && !(n.nodeType === 1 && n.tagName === 'P')) {
        chain.push(n.nodeType === 3 ? 'text(' + JSON.stringify(n.data) + ')' : n.tagName.toLowerCase())
        n = n.parentNode
      }
      chain.push('p')
      return { chain, offset: sel.anchorOffset }
    })()`)

    await keyDown(send, 'Z', 'KeyZ', 'Z')
    await sleep(400)
    const diag = JSON.parse(await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`))
    const domText = await evaluate(`[...(${VISIBLE}).querySelectorAll('p')].find((n) => n.textContent.startsWith('甲'))?.textContent ?? ''`)

    rows.push({ name: testCase.name, caret, domText, diag: diag.slice(0, 2) })
  } catch (err) {
    rows.push({ name: testCase.name, caret: { chain: [`ERROR ${err.message}`] }, domText: '', diag: [] })
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

await rm(root, { recursive: true, force: true })
console.log('\n=== WHERE THE CLICK LEAVES THE CARET, AND WHAT THE KEYSTROKE DID ===\n')
for (const r of rows) {
  console.log(`  ${r.name.padEnd(14)} caretChain=${r.caret.chain.join(' < ')}  @${r.caret.offset}`)
  console.log(`  ${''.padEnd(14)} domAfterZ=${JSON.stringify(r.domText)}`)
  console.log(`  ${''.padEnd(14)} diag=${JSON.stringify(r.diag)}`)
  console.log('')
}
