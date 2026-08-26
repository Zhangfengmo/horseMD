// EXPERIMENT B — what do combined Markdown markers actually write to disk in
// KERNEL mode?
//
// The user reports 「多种标识符组合文本」 → save failures / 「渲染效果丢失」.
// Two candidate mechanisms found by code reading:
//   (i)  lib/source-kernel/commands/text-escape.js commits a proven-restructuring
//        insert WITH a backslash. TRANSIENT_SINGLE = ['-','+','*','>','#','`','~','_']
//        are unwound only if the very NEXT keystroke is Space. '=' and digits
//        are NOT on that list.
//   (ii) commitMarkInputRule falls back to publishing only the literal character
//        when the reparse of the committed bytes is not .eq() to the rule's own
//        doc — the mark silently does not apply.
//
// This is a PROBE, not an assertion suite: every case is typed one character at
// a time into a fresh document, saved, and the DISK BYTES are reported verbatim.
//
// Isolation: one app launch per case (a list/table/heading created by one case
// would contaminate the next block of the next case), each on the same CDP port
// with its own /tmp profile.
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-marker-combo-${process.pid}`
const port = Number(process.env.CDP_PORT || 10751)
const charDelay = Number(process.env.KERNEL_KEY_DELAY || 110)
const ANCHOR = '锚点'
const FIXTURE = ANCHOR + '\n'

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`

async function waitFor(fn, message, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function tryWaitFor(fn, tries = 20) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  return null
}

// A real keydown that ALSO delivers the character. `Input.insertText`
// (typeTextLikeUser) produces NO keydown at all, so anything whose meaning
// lives in a keymap — Space above all, which is what unwinds the kernel's
// TRANSIENT_SINGLE escapes — would take the wrong code path. Verbatim idiom
// from scripts/test-kernel-marker-text-ui.mjs.
async function typeChar(send, ch) {
  const code = ch === ' ' ? 'Space'
    : /^[a-zA-Z]$/.test(ch) ? 'Key' + ch.toUpperCase()
      : /^[0-9]$/.test(ch) ? 'Digit' + ch : 'Unidentified'
  const vk = ch === ' ' ? 32 : /^[A-Za-z0-9]$/.test(ch) ? ch.toUpperCase().charCodeAt(0) : 0
  const common = { key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, text: ch, unmodifiedText: ch })
  await sleep(15)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(charDelay)
}

async function typeString(send, text) {
  for (const ch of [...text]) await typeChar(send, ch)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

async function charRect(evaluate, blockText, offset) {
  return evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p, h1, h2, h3, h4, h5, h6') || [])]
      .find((n) => n.textContent === ${JSON.stringify(blockText)})
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    let count = 0, target = null, targetOffset = 0, n
    while ((n = walker.nextNode())) {
      const len = n.textContent.length
      if (count + len >= ${offset}) { target = n; targetOffset = ${offset} - count; break }
      count += len
    }
    if (!target) return null
    const range = document.createRange()
    range.setStart(target, targetOffset)
    range.setEnd(target, targetOffset)
    const rect = range.getBoundingClientRect()
    return rect ? { left: rect.left, top: rect.top, height: rect.height } : null
  })()`)
}

// A raw DOM Range does NOT sync ProseMirror state — caret placement is a real
// synthetic mouse click at a measured rect.
async function clickAt(evaluate, send, blockText, offset) {
  const rect = await waitFor(() => charRect(evaluate, blockText, offset),
    `could not locate caret offset ${offset} in ${JSON.stringify(blockText)}`)
  await click(send, { x: rect.left + 0.5, y: rect.top + Math.min(12, rect.height / 2) })
  await sleep(250)
}

const snapshotDom = (evaluate) => evaluate(`JSON.stringify((() => {
  const editor = ${VISIBLE_EDITOR}
  if (!editor) return { error: 'no visible editor' }
  const q = (sel) => editor.querySelectorAll(sel).length
  return {
    blocks: [...editor.children].map((n) => n.tagName.toLowerCase() + ':' + JSON.stringify(n.textContent)),
    html: [...editor.children].slice(1).map((n) => n.outerHTML).join('').slice(0, 1400),
    marks: {
      strong: q('strong'),
      em: q('em'),
      code: q('code:not(pre code)'),
      mark: q('mark'),
      del: q('del, s, strike'),
      a: q('a[href]'),
      blockquote: q('blockquote'),
      ul: q('ul'),
      ol: q('ol'),
      li: q('li'),
      table: q('table'),
      heading: q('h1,h2,h3,h4,h5,h6'),
      codeblock: q('pre, .cm-editor, .milkdown-code-block'),
      katex: q('.katex, .math-inline, math-inline'),
      img: q('img')
    }
  }
})())`)

const CASES = [
  { id: 1, label: '**bold**', steps: [['t', '**bold**']] },
  { id: 2, label: '*em*', steps: [['t', '*em*']] },
  { id: 3, label: '~~strike~~', steps: [['t', '~~strike~~']] },
  { id: 4, label: '==highlight==', steps: [['t', '==highlight==']] },
  { id: 5, label: '`code`', steps: [['t', '`code`']] },
  { id: 6, label: '**bold** and *em* and `c`', steps: [['t', '**bold** and *em* and `c`']] },
  { id: 7, label: '[link](http://x)', steps: [['t', '[link](http://x)']] },
  { id: 8, label: '> quote', steps: [['t', '> quote']] },
  { id: 9, label: '- item / Enter / Tab / sub', steps: [['t', '- item'], ['k', 'Enter'], ['k', 'Tab'], ['t', 'sub']] },
  { id: 10, label: '1. one / Enter / 2. two', steps: [['t', '1. one'], ['k', 'Enter'], ['t', '2. two']] },
  { id: 11, label: '# heading', steps: [['t', '# heading']] },
  { id: 12, label: 'table 3 rows', steps: [['t', '| a | b |'], ['k', 'Enter'], ['t', '|---|---|'], ['k', 'Enter'], ['t', '| 1 | 2 |']] },
  { id: 13, label: 'a **b** c `d` e *f* g ==h== i', steps: [['t', 'a **b** c `d` e *f* g ==h== i']] },
  { id: 14, label: '$x^2$', steps: [['t', '$x^2$']] },
  { id: 15, label: 'cost 4.5 usd', steps: [['t', 'cost 4.5 usd']] },
  { id: 16, label: 'a - b', steps: [['t', 'a - b']] },
  { id: 17, label: 'x = 1', steps: [['t', 'x = 1']] }
]

function typedLiteral(steps) {
  return steps.map(([kind, value]) => (kind === 't' ? value : value === 'Enter' ? '\n' : value === 'Tab' ? '\t' : '')).join('')
}

async function runCase(testCase) {
  const dir = join(root, `case-${testCase.id}`)
  const file = join(dir, 'probe.md')
  await mkdir(dir, { recursive: true })
  await writeFile(file, FIXTURE)
  let app = null
  const result = { id: testCase.id, label: testCase.label }
  try {
    app = await launchBuiltElectron({
      profileDir: join(dir, 'profile'),
      port,
      appArgs: [file],
      kernelDefault: true
    })
    const { evaluate, send } = app
    await waitFor(async () => {
      const text = await evaluate(`(${VISIBLE_EDITOR})?.textContent`)
      return text && text.includes(ANCHOR) ? text : null
    }, 'document did not mount')

    // MANDATORY: prove the kernel actually attached; otherwise this measures LEGACY.
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`),
      'kernel did not attach (.hm-kernel-mode absent) — measurement would be about LEGACY')
    await sleep(300)
    const attachDiag = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    result.kernelAttached = true
    result.attachDegradedToLegacy = attachDiag.includes('attach-unmappable')
    result.attachDiagnostics = attachDiag

    await evaluate(`(() => {
      window.__comboToasts = []
      window.addEventListener('hm:toast', (e) => window.__comboToasts.push(e.detail?.msg ?? String(e.detail)))
      window.__hmKernelDiagnostics = []
      return 1
    })()`)

    // Fresh paragraph after the anchor, made the way a user makes one.
    await clickAt(evaluate, send, ANCHOR, ANCHOR.length)
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(500)

    for (const [kind, value] of testCase.steps) {
      if (kind === 't') await typeString(send, value)
      else { await pressKey(send, { key: value, code: value }); await sleep(450) }
    }
    await sleep(1500)

    result.dom = JSON.parse(await snapshotDom(evaluate))
    result.toasts = JSON.parse(await evaluate(`JSON.stringify(window.__comboToasts || [])`))
    result.diagnostics = JSON.parse(await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).map((d) => ({ ...d, at: undefined })))`))

    const fab = await tryWaitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 25)
    result.dirtyBeforeSave = !!fab
    if (fab) {
      await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
      const saved = await tryWaitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 60)
      result.saveSettled = !!saved
    } else {
      result.saveSettled = null
    }
    await sleep(400)
    result.disk = await readFile(file, 'utf8')
    result.dialogs = app.dialogs.map((d) => d.message)
    await evaluate(`(window.confirm = () => true, 1)`).catch(() => {})
  } catch (error) {
    result.error = String(error && error.message ? error.message : error)
    try { result.disk = await readFile(file, 'utf8') } catch {}
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }

  const typed = typedLiteral(testCase.steps)
  const body = typeof result.disk === 'string'
    ? result.disk.replace(FIXTURE, '').replace(/^\n/, '')
    : ''
  result.typed = typed
  result.body = body
  result.strayBackslash = body.includes('\\') && !typed.includes('\\')
  result.nbsp = body.includes(' ')
  return result
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const only = process.env.COMBO_ONLY ? process.env.COMBO_ONLY.split(',').map(Number) : null
  const results = []
  for (const testCase of CASES) {
    if (only && !only.includes(testCase.id)) continue
    const result = await runCase(testCase)
    results.push(result)
    console.log(`\n=== CASE ${result.id}: ${result.label} ===`)
    console.log('  typed   :', JSON.stringify(result.typed))
    console.log('  disk    :', JSON.stringify(result.disk))
    console.log('  body    :', JSON.stringify(result.body))
    console.log('  stray\\  :', result.strayBackslash, ' nbsp:', result.nbsp)
    console.log('  dirty   :', result.dirtyBeforeSave, ' saveSettled:', result.saveSettled)
    console.log('  kernel  :', result.kernelAttached, ' degraded:', result.attachDegradedToLegacy)
    console.log('  blocks  :', JSON.stringify(result.dom?.blocks))
    console.log('  marks   :', JSON.stringify(result.dom?.marks))
    console.log('  html    :', JSON.stringify(result.dom?.html))
    console.log('  toasts  :', JSON.stringify(result.toasts))
    console.log('  diag    :', JSON.stringify(result.diagnostics))
    console.log('  dialogs :', JSON.stringify(result.dialogs))
    if (result.error) console.log('  ERROR   :', result.error)
  }
  console.log('\n\n===== JSON RESULTS =====')
  console.log(JSON.stringify(results, null, 1))
  await rm(root, { recursive: true, force: true })
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
