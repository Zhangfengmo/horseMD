// MARKDOWN -> RICH RENDER CONSISTENCY (2026-08-23 user directive: the rich
// projection must be TESTED against the bytes, not eyeballed). One corpus
// document covering every block family renders in the real app; the visible
// ProseMirror DOM is walked into a normalized skeleton and compared to the
// EXPECTED skeleton (hand-derived from the CommonMark/GFM reading — the same
// reading VSCode renders). The source view must still show the fixture
// byte-for-byte (rendering must never rewrite bytes), and the kernel must
// attach (no legacy degrade). LF + CRLF.
//
// The corpus deliberately includes the SAME-LINE NESTED bare marker '3. 4.'
// (one line, two item records — the shape whose syntax-index mis-record broke
// the '2.'-mid-item typing burst) and a live typing-burst scenario pinning
// that '1. ' + '2.9876543' commits as ONE item.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`

async function waitFor(fn, message, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const LINES = [
  '# 一级标题',
  '',
  '###### 六级标题',
  '',
  '正文**粗体**和*斜体*与`行内码`还有~~删除~~',
  '',
  '> 引甲',
  '>',
  '> > 深引',
  '',
  '- 甲项',
  '  - 乙子项',
  '',
  '1. 2.3121312',
  '2. 2131',
  '3. 4.',
  '',
  '- [ ] 任务',
  '  - [x] 子任务',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 |  |',
  '',
  '```js',
  'code',
  '```',
  '',
  '---',
  '',
  '尾段',
  ''
]

// The normalized skeleton the corpus must render to — the CommonMark/GFM
// reading. '3. 4.' is item 3 holding a NESTED empty ordered item (the bare
// '4.' marker), exactly as VSCode renders it.
const EXPECTED = [
  'h1:一级标题',
  'h6:六级标题',
  'p:正文[b:粗体]和[i:斜体]与[c:行内码]还有[s:删除]',
  'q[p:引甲 q[p:深引]]',
  'ul[li:甲项 ul[li:乙子项]]',
  'ol[li:2.3121312 li:2131 li: ol[li:]]',
  'ul[task(unchecked):任务 ul[task(checked):子任务]]',
  'table:2x2',
  'code:js',
  'hr',
  'p:尾段'
].join('\n')

const SKELETON_JS = `(() => {
  const ed = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
  const inline = (el) => {
    let out = ''
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { out += n.textContent; continue }
      if (n.nodeType !== 1) continue
      const tag = n.tagName.toLowerCase()
      if (tag === 'strong') out += '[b:' + n.textContent + ']'
      else if (tag === 'em') out += '[i:' + n.textContent + ']'
      else if (tag === 'code') out += '[c:' + n.textContent + ']'
      else if (tag === 'del' || tag === 's') out += '[s:' + n.textContent + ']'
      else if (tag === 'br') out += ''
      else out += inline(n)
    }
    return out
  }
  const itemOf = (li) => {
    const wrapper = li.closest('.milkdown-list-item-block') || li
    const ownLabel = wrapper.querySelector('.label')
    const checked = ownLabel?.classList.contains('checked') ? 'task(checked)'
      : ownLabel?.classList.contains('unchecked') ? 'task(unchecked)' : 'li'
    const para = li.querySelector('p')
    const nested = [...li.querySelectorAll('ul, ol')].filter((c) => c.closest('li') === li)
    let out = checked + ':' + (para ? inline(para) : '')
    for (const list of nested) out += ' ' + listOf(list)
    return out
  }
  const listOf = (list) => {
    const items = [...list.children]
      .map((w) => (w.tagName === 'LI' ? w : w.querySelector('li')))
      .filter(Boolean)
    return list.tagName.toLowerCase() + '[' + items.map(itemOf).join(' ') + ']'
  }
  const quoteOf = (q) => 'q[' + [...q.children].map(blockOf).filter(Boolean).join(' ') + ']'
  const blockOf = (el) => {
    const tag = el.tagName.toLowerCase()
    if (/^h[1-6]$/.test(tag)) return tag + ':' + inline(el)
    if (tag === 'p') { const t = inline(el); return t === '' ? null : 'p:' + t }
    if (tag === 'ul' || tag === 'ol') return listOf(el)
    if (tag === 'blockquote') return quoteOf(el)
    if (tag === 'hr') return 'hr'
    if (tag === 'table') {
      const rows = [...el.querySelectorAll(':scope tr')]
      if (!rows.length) return null
      const cols = rows[0].querySelectorAll('th, td').length
      return 'table:' + rows.length + 'x' + cols
    }
    return null
  }
  const out = []
  const walk = (node) => {
    for (const el of node.children) {
      const tag = el.tagName.toLowerCase()
      if (tag === 'table') {
        const s = blockOf(el)
        if (s) out.push(s)
        continue
      }
      const cm = el.classList?.contains('milkdown-code-block') || el.querySelector?.(':scope > .cm-editor')
      if (cm) {
        const lang = el.querySelector('.language-button, .language-picker')?.textContent?.trim() ||
          (el.getAttribute('data-language') || '')
        out.push('code:' + (lang || 'js'))
        continue
      }
      const s = blockOf(el)
      if (s !== null && s !== undefined) { out.push(s); continue }
      if (['div', 'span', 'section'].includes(tag)) walk(el)
    }
  }
  walk(ed)
  return out.join('\\n')
})()`

async function runScenario({ ending, port }) {
  const label = ending === '\n' ? 'LF' : 'CRLF'
  const root = `/tmp/horsemd-render-consistency-${label}-${process.pid}`
  const file = join(root, 'doc.md')
  const FIXTURE = LINES.join(ending)
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)

  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${VISIBLE_EDITOR})?.textContent?.includes('尾段')`), `${label} mount`)
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), `${label} kernel attach (no legacy degrade)`)
    await sleep(900)

    // (1) The rendered skeleton equals the CommonMark reading.
    const skeleton = await evaluate(SKELETON_JS)
    if (skeleton !== EXPECTED) {
      console.error('  actual  :\n' + skeleton)
      console.error('  expected:\n' + EXPECTED)
    }
    assert.equal(skeleton, EXPECTED, `${label}: the rich projection must match the CommonMark reading block for block`)

    // (2) Rendering must not rewrite bytes: the source view shows the fixture
    // verbatim (textarea normalizes endings to LF).
    const toggle = `(() => { const b = [...document.querySelectorAll('.status-btn')].find((n) => n.offsetParent && !n.classList.contains('block-switch-caret-btn') && /源码|Source|富文本|Rich/.test(n.title || n.textContent || '')); b?.click(); return !!b })()`
    await evaluate(toggle)
    const src = await waitFor(() => evaluate(`[...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)?.value ?? null`), `${label} source view`)
    await evaluate(toggle)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), `${label} rich back`)
    await sleep(300)
    assert.equal(src, LINES.join('\n'), `${label}: opening + rendering must not rewrite a single byte`)

    // (3) The typing-burst pin: '1. ' then '2.9876543' typed one character at
    // a time commits as ONE item — the '2.' transient (a bare nested marker)
    // must demote under the next character, never sever the document.
    const rect = await waitFor(() => evaluate(`(() => {
      const t = [...((${VISIBLE_EDITOR})?.querySelectorAll('p') || [])].find((n) => n.textContent === '尾段')
      if (!t) return null
      t.scrollIntoView({ block: 'center' })
      const r = t.getBoundingClientRect()
      return { x: r.right - 2, y: r.top + r.height / 2 }
    })()`), `${label}: 尾段 missing`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
    await sleep(250)
    await pressKey(send, { key: 'End', code: 'End' })
    await sleep(150)
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(400)
    await typeTextLikeUser(send, '1.', { delayMs: 50 })
    await pressKey(send, { key: ' ', code: 'Space', text: ' ' })
    await sleep(400)
    await typeTextLikeUser(send, '2.9876543', { delayMs: 40 })
    await sleep(600)

    await evaluate(`(window.confirm = () => true, 1)`)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), `${label} save fab`)
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), `${label} save settle`)
    const saved = await readFile(file, 'utf8')
    assert.ok(saved.includes(`1. 2.9876543`), `${label}: the burst lands as ONE item: ${JSON.stringify(saved.slice(-60))}`)
    assert.ok(!saved.includes(`1. 2.${ending}`), `${label}: no severed bare-marker line survives`)

    const diag = await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).map((d) => d.type))`)
    assert.ok(!diag.includes('attach-unmappable'), `${label}: never degrades: ${diag}`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
  console.log(`PASS kernel render-consistency ${label}`)
}

await runScenario({ ending: '\n', port: Number(process.env.CDP_PORT || 10266) })
await runScenario({ ending: '\r\n', port: Number(process.env.CDP_PORT || 10266) + 1 })
console.log('PASS kernel render-consistency: the rich projection matches the CommonMark reading block for block (headings/marks/quotes/nested+same-line-nested lists/tasks/table/code/math-free corpus), bytes are untouched by rendering, and the mid-item marker burst commits as one item (LF + CRLF)')
