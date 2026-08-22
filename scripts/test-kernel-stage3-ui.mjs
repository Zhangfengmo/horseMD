// Stage-3 syntax domains, end-to-end in the REAL app (source-kernel Plan 5,
// Task 7).
//
// THE HEADLINE (and the reason this fixture looks the way it does): before
// Plan 5, a document containing inline/block math, an inline-HTML fragment
// or a `==highlight==` could not enter kernel mode AT ALL — each of those
// three shapes made `buildProjectionMap` return null for the WHOLE document
// (`attach-unmappable`), so the entire file silently fell back to the legacy
// preservation pipeline. Tasks 1-3 healed that; Tasks 4-6 then added table
// cell / image attribute / link editing on top. This script is the single
// acceptance check that all six landed together: ONE document that mixes
// every stage-3 construct attaches LIVE (step 1), and then each domain's own
// UI gesture commits byte-exact source (steps 3-10).
//
// WHY ATTACH ALONE IS NOT THE ACCEPTANCE (review finding, and the reason
// step 10 exists): since per-block degradation landed (commit 3b29cdf) the
// two failure regimes are no longer the same. A BLOCK-TYPE disagreement
// (paragraph vs `code_block(LaTeX)` — the pre-cure `$$…$$` shape) still
// nulls the whole map, so the block-math half of the math cure IS guarded by
// the attach assertion. But a CONTENT-SIZE disagreement — exactly what a
// regression of the inline-math, inline-HTML or highlight cure produces —
// leaves the map building and degrades only that block: attach still
// succeeds, and a "typing here is refused" assertion is satisfied by BOTH
// the healed and the degraded state. So each of those three cures gets an
// assertion that can ONLY pass while its block is MAPPED: a byte-exact
// commit landing IN that block (typing for the highlight paragraph, a
// structural Enter for the two atom-bearing paragraphs — `pmPosToRaw` skips
// any pair whose charMap is null, so a degraded block fails closed with zero
// bytes). Step 10(d) is the mirror image: the red `<mark>` paragraph must
// STAY degraded while the rest of the document keeps editing.
//
// Every "expected bytes" string below is DERIVED, not guessed: each one is
// the literal output of running the real kernel primitives this UI drives
// (`replaceVisibleText` / `toggleInlineMark` / `applyLinkEdit` /
// `setImageAttrs` + `applySourceTransaction`, imported straight from
// src/renderer/src/lib/source-kernel/) against this exact fixture in this
// exact order — see task-7-report.md for the derivation transcript. Each one
// happens to also be a single readable `String.replace` of its predecessor,
// which is how they are written here; the oracle proved the equality.
//
// FIXTURE EXCLUSIONS (each one is a KNOWN, pinned limitation that would drag
// this whole document back into `attach-unmappable` and turn every assertion
// below into a false red — they are pinned as `null` in the headless suites
// instead, which is where they belong):
//  - a standalone-line `$$x$$` (task-1-report §4.5): the editor chain
//    pre-normalizes it to a 3-line block before parsing while the kernel
//    holds the ORIGINAL bytes, so the two chains see different block types.
//  - block math (or ANY fenced block) inside a list item (task-1 §4.6):
//    ProseMirror's `list_item` content model inserts a filler paragraph, so
//    PM has one structural node more than mdast.
//  - adjacent root-level `<div>` siblings (task-2 §6.2): the editor chain
//    coalesces them across the blank line, the kernel does not.
// A red `<mark class="hm-hl-red">` highlight is INCLUDED rather than excluded
// (review finding): it round-trips as inline HTML — a width-1 atom on the
// kernel side vs an N-character marked run in PM — so it degrades PER BLOCK,
// not whole-map (task-2 §6.4 / task-3 §3, projection-map Case P3c). Keeping
// it in the fixture is what pins that contract in the live app.
// The document also ENDS in a plain paragraph on purpose: Crepe's always-on
// `@milkdown/plugin-trailing` appends a synthetic empty paragraph whenever
// the last top-level block is anything else, which the projection map does
// not tolerate (see test-kernel-nodeview-ui.mjs's fixture note).
//
// DIAGNOSTICS TOLERANCE — the buffer is never cleared (that would blind
// every later step); instead the count is snapshotted and pinned at each
// point where a mismatch is EXPECTED, so any OTHER recurrence fails:
//  1. task-4-report §6: a document containing a TABLE emits exactly one
//     `projection-mismatch` + repair on its FIRST kernel commit. Pre-existing
//     and proven independent of Task 4 by a control build (the same
//     diagnostic appears with table cell mapping forced off).
//  2. the image `alt` commit costs exactly one more, deterministically:
//     `editor-image-markdown.js` derives `caption: title || alt` at parse
//     time, so the live node's caption is stale until the repair reconcile
//     refreshes it — precisely the staleness task-5-report §8 predicted.
//     Both halves are asserted (one mismatch AND the repaired caption); the
//     `src` commit is the control that no other attribute does this.
// Everything in between must add ZERO. The ring buffer is capped at 100
// entries with shift-out and this session pushes one per accepted AND vetoed
// key, so a `total < 100` sanity assertion guards the pins from silently
// turning into false reds through eviction.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-stage3-${process.pid}`
const file = join(root, 'stage3.md')
const crlfFile = join(root, 'stage3-crlf.md')
const compactFile = join(root, 'stage3-compact-table.md')
const svgFile = join(root, 'stage3.svg')
const port = Number(process.env.CDP_PORT || 10025)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#cde"/></svg>\n'

const FIXTURE = [
  '# 阶段三综合验收',
  '',
  '普通段落用于打字定位。',      // plain typing target (the editable positive control)
  '',
  '行内公式 $x^2$ 结束。',        // inline math -> a non-typable paragraph (documented)
  '',
  '$$',                          // block math, MULTI-LINE form only (see exclusions)
  'E=mc^2',
  '$$',
  '',
  '片段 <span>内联</span> 结束。', // inline HTML coalesced to one atom
  '',
  '已有==高亮==片段。',           // authored YELLOW highlight (a MARK -> mapped)
  '',
  '红色<mark class="hm-hl-red">高亮</mark>片段。', // red highlight = inline HTML -> this BLOCK degrades
  '',
  '| 甲 | 乙 |',                  // GFM table with a real alignment delimiter row
  '| :-- | --: |',
  '| 丙 | 丁 |',
  '',
  '![说明](./stage3.svg)',        // block image -> the alt AttrStep target
  '',
  '![]()',                        // empty image -> the ONE user-reachable src route
  '',
  '参见 [文档](https://a.example) 链接。', // authored link -> the URL-edit target
  '',
  '壹贰叁肆',                     // highlight toolbar target
  '',
  '伍陆柒捌',                     // link toolbar target
  '',
  '尾段落用于占位。',
  ''
].join('\n')

// ---- kernel-oracle-derived byte checkpoints (see the header) ----
const S1 = FIXTURE.replace('普通段落用于打字定位。', '普通段落用于打字定位。X')
const S2 = S1.replace('| 甲 | 乙 |', '| 甲X | 乙 |')
const S3 = S2.replace('壹贰叁肆', '==壹贰叁肆==')     // highlight wrap; unwrap nets back to S2
const LINK_URL = 'https://x.example'
const AUTHORED_URL_2 = 'https://b.example'
const S4 = S2.replace('伍陆柒捌', `[伍陆柒捌](${LINK_URL})`)
const S5 = S4.replace('https://a.example', AUTHORED_URL_2)
const S6 = S5.replace(`[伍陆柒捌](${LINK_URL})`, '伍陆柒捌')
const IMG_SRC = 'https://z.example/pic.png'
const S7 = S6.replace('![]()', `![](${IMG_SRC})`)
const S8 = S7.replace('![说明](./stage3.svg)', '![新说明](./stage3.svg)')
// kernel/image-caption: the caption AttrStep is a REAL byte edit on an
// unscaled image-block now — it commits into the markdown TITLE slot (the
// legacy byte home, editor-image-markdown.js `caption: title || alt`). It
// runs AFTER the alt probe so the alt-staleness proof (one repaired
// projection-mismatch, see the header) keeps its title-less precondition.
const IMG_CAPTION = '图注入源'
const S8cap = S8.replace('![新说明](./stage3.svg)', `![新说明](./stage3.svg "${IMG_CAPTION}")`)
// The three "this block is really MAPPED" commits (step 10). S10/S11 are
// paragraph-END Enters: `splitTextBlock`'s non-quoted branch inserts
// `ending + ending` at the caret, i.e. exactly one extra blank line.
// P6-1 (2026-08-17): the inline-math paragraph is now TYPABLE around its
// atom, so step 9's 'W' at the paragraph end is a real byte commit — it used
// to be a refusal. The formula itself must SURVIVE every step in this file:
// step 10(b) uses this paragraph as the "the inline-math cure really mapped
// this block" proof, and that proof only means something while the atom is
// still in it. (P6-1b made deleting an atom whole a legal commit; its byte
// contract is pinned headlessly in scripts/test-kernel-gateway.mjs A3/A3b/A5/
// A6/A8, which can assert the exact removed bytes for every atom kind — this
// session deliberately keeps its own atom step a REFUSAL so the snapshot chain
// below still carries '$x^2$'.)
// BLOCK MATH IS EDITABLE since 2026-08-18 (editor-kernel-projection-map.js's
// "READONLY_CODE_LANGUAGES IS GONE" ADR: mdast `math` pairs with the PM
// `code_block(LaTeX)` and `buildCodeMap` maps it like any other fence). Step 9
// used to assert the opposite — it was written when block math was declared
// read-only and was not re-run when that changed. It now types ONE character
// into the formula's CodeMirror and requires the byte commit, which is a
// STRONGER statement than the old refusal: only a genuinely mapped block can
// produce it.
const S8m = S8cap.replace('E=mc^2', 'E=mc^2X')
const S8b = S8m.replace('行内公式 $x^2$ 结束。', '行内公式 $x^2$ 结束。W')
const S9 = S8b.replace('已有==高亮==片段。', '已有==高亮==片段。Y')
const S10 = S9.replace('行内公式 $x^2$ 结束。W\n', '行内公式 $x^2$ 结束。W\n\n\n')
const S11 = S10.replace('片段 <span>内联</span> 结束。\n', '片段 <span>内联</span> 结束。\n\n\n')
// Step 10(e) — the Critical 2 (link-boundary) proof. The straddling bold is
// REFUSED (bytes stay at S11); the control that follows bolds the link LABEL
// itself and then unwraps it, netting back to S11, so every later checkpoint
// (SAVED, the cold reopen) is unaffected.
const S12 = S11.replace(`[文档](${AUTHORED_URL_2})`, `[**文档**](${AUTHORED_URL_2})`)
const SAVED = S11

const CRLF_FIXTURE = [
  '# 阶段三 CRLF',
  '',
  '行内公式 $x^2$ 结束。',
  '',
  '$$',
  'E=mc^2',
  '$$',
  '',
  '片段 <span>内联</span> 结束。',
  '',
  '已有==高亮==片段。',
  '',
  '| 甲 | 乙 |',
  '| :-- | --: |',
  '| 丙 | 丁 |',
  '',
  '![说明](./stage3.svg)',
  '',
  '参见 [文档](https://a.example) 链接。',
  '',
  '尾段落。',
  ''
].join('\r\n')
const CRLF_AFTER_CELL = CRLF_FIXTURE.replace('| 甲 | 乙 |', '| 甲X | 乙 |')

// ---- WHOLE-BRANCH REVIEW, CRITICAL 1: the COMPACT-table fixture ----------
// HorseMD writes PADDED tables ('| 甲 | 乙 |'), and in a padded table a typed
// '\' lands before a SPACE, so it is harmless. Tables pasted from other tools
// are routinely COMPACT ('|甲|乙|') — there the same keystroke lands directly
// before the delimiter, turning it into '\|', which GFM unescapes before
// splitting the row: the header loses a column, the block stops being a
// table, and (because `verifyPlainTextProjection` runs AFTER kernel.doc is
// advanced) the VIEW was repaired to match the destroyed bytes and the file
// was saved that way. Its own isolated session/file so the main fixture's
// byte checkpoints stay untouched.
const COMPACT_FIXTURE = [
  '# 紧凑表格',
  '',
  '|甲|乙|',
  '|-|-|',
  '|丙|丁|',
  '',
  '尾段落。',
  ''
].join('\n')
const COMPACT_AFTER_CELL = COMPACT_FIXTURE.replace('|甲|乙|', '|甲X|乙|')

async function waitFor(check, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

// Every DOM query below is scoped to the VISIBLE editor: N mounted tabs mean
// N `.ProseMirror` roots (and the onboarding document contributes its own
// code blocks), so an unscoped `document.querySelector('.milkdown-code-block')`
// can silently address ANOTHER tab's node.
const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`
const VISIBLE_TOOLBAR = `[...document.querySelectorAll('.milkdown-toolbar')].find((tb) => {
  const r = tb.getBoundingClientRect()
  const s = getComputedStyle(tb)
  return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'
})`

const mounted = (evaluate) => evaluate(`(${VISIBLE_EDITOR})?.textContent`)
const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

async function toggleSourceMode(evaluate) {
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => node.offsetParent && !node.classList.contains('block-switch-caret-btn') &&
        /源码|Source|富文本|Rich|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
    button?.click()
    return !!button
  })()`)
  assert.ok(clicked, 'no source-toggle trigger button')
}

// Round-trips through source mode to read the kernel's authoritative bytes,
// then back to rich. Returns the source string so a caller can add extra
// property assertions (e.g. the untouched delimiter row).
async function assertSource(evaluate, expected, message) {
  await toggleSourceMode(evaluate)
  const shown = await waitFor(() => visibleSource(evaluate), `source view did not appear (${message})`)
  assert.equal(shown, expected, message)
  await toggleSourceMode(evaluate)
  await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), `rich view did not return (${message})`)
  await sleep(200)
  return shown
}

async function toggleKernelMode(evaluate) {
  const opened = await evaluate(`(() => {
    const button = document.querySelector('.block-switch-caret-btn')
    button?.click()
    return !!button
  })()`)
  assert.ok(opened, 'no kernel-mode caret button — tab not kernel-eligible?')
  await sleep(150)
  const clicked = await evaluate(`(() => {
    const item = [...document.querySelectorAll('.block-switch-menu .block-menu-item')]
      .find((node) => node.offsetParent)
    item?.click()
    return !!item
  })()`)
  assert.ok(clicked, 'kernel-toggle menu item missing')
}

// ---- the live ProseMirror EditorView handle -------------------------------
// Nothing in the app exposes the EditorView, and two of this script's
// assertions genuinely need it: the image `alt` AttrStep (task-5-report §1 —
// NO UI in HorseMD or upstream Crepe dispatches `alt`/`title`, so the only
// honest way to cover that route is to dispatch the very step a future alt
// editor would), and the Tab-in-table selection check (proving the caret
// MOVED while zero bytes were written).
//
// Route: prosemirror-view stores each node view's `spec` object on its DOM
// node as `pmViewDesc.spec`, and Milkdown's code-block node view is a
// `CodeMirrorBlock` class instance whose constructor keeps the EditorView as
// a public field (`constructor(public node, public view, …)` —
// @milkdown/components/src/code-block/view/node-view.ts:66). The fixture's
// `$$` block IS such a node view, so the math this script already needs also
// yields the handle. The PM view is told apart from CodeMirror's own
// (`spec.cm`, also an "EditorView") by `state.doc.type` — a CM6 EditorState
// has no node-typed document.
async function resolveView(evaluate) {
  const ok = await evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    if (!editor) return false
    for (const el of editor.querySelectorAll('*')) {
      const spec = el.pmViewDesc && el.pmViewDesc.spec
      const view = spec && spec.view
      if (view && view.state && view.state.doc && view.state.doc.type && view.dispatch) {
        window.__hmStage3View = view
        return true
      }
    }
    return false
  })()`)
  assert.ok(ok, 'could not resolve the live ProseMirror EditorView through any node view spec')
}

async function kernelDiagnostics(evaluate) {
  return JSON.parse(await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`))
}

// Types that mean the kernel lost the document, never merely refused an
// operation. `markdown-updated` is deliberately NOT here: it is pushed for
// EVERY vetoed key too (task-4-report §9.5), so its presence proves nothing.
const FATAL_DIAGNOSTICS = [
  'attach-unmappable',
  'projection-repair-failed',
  'projection-parse-failure',
  'map-refresh-failed',
  'replace-reconcile-failed',
  'structural-parse-failure',
  'history-frozen',
  'cm-veto-resync-failed',
  'cm-veto-resync-parse-failure',
  'composition-revert-failed'
]

async function assertNoFatalDiagnostics(evaluate, label) {
  const entries = await kernelDiagnostics(evaluate)
  const fatal = entries.filter((entry) => FATAL_DIAGNOSTICS.includes(entry.type))
  assert.deepEqual(fatal, [], `${label}: fatal kernel diagnostics: ${JSON.stringify(fatal)}`)
  // The ring buffer shifts out its oldest entry past 100. Every count-based
  // pin below assumes nothing was evicted, so prove it.
  assert.ok(entries.length < 100,
    `${label}: the diagnostics ring reached ${entries.length} entries — at 100 it evicts, which would silently corrupt every count pin in this file`)
  return entries.filter((entry) => entry.type === 'projection-mismatch').length
}

const mismatchCount = async (evaluate) =>
  (await kernelDiagnostics(evaluate)).filter((entry) => entry.type === 'projection-mismatch').length

// ---- mouse / caret helpers (same idiom as test-kernel-marks-ui.mjs) -------
async function charRect(evaluate, blockText, from, to) {
  return evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p, h1, h2, h3, h4, h5, h6') || [])].find((n) => n.textContent === ${JSON.stringify(blockText)})
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    let count = 0
    let startNode = null, startOffset = 0, endNode = null, endOffset = 0
    let n
    while ((n = walker.nextNode())) {
      const len = n.textContent.length
      if (startNode === null && count + len >= ${from}) { startNode = n; startOffset = ${from} - count }
      if (endNode === null && count + len >= ${to}) { endNode = n; endOffset = ${to} - count }
      count += len
      if (startNode && endNode) break
    }
    if (!startNode || !endNode) return null
    const range = document.createRange()
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset)
    const rect = range.getBoundingClientRect()
    if (!rect) return null
    return { left: rect.left, right: rect.right, top: rect.top, height: rect.height }
  })()`)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

async function clickAt(evaluate, send, blockText, offset) {
  const rect = await waitFor(() => charRect(evaluate, blockText, offset, offset),
    `could not locate caret offset ${offset} in ${JSON.stringify(blockText)}`)
  await click(send, { x: rect.left, y: rect.top + Math.min(12, rect.height / 2) })
  await sleep(200)
}

// Caret at the visual END of the block whose rendered text STARTS WITH
// `prefix` — used for the inline-math paragraph, whose rendered text carries
// KaTeX's own duplicated glyph text and therefore cannot be matched exactly.
async function clickBlockEndByPrefix(evaluate, send, prefix) {
  const point = await waitFor(() => evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p') || [])].find((n) => (n.textContent || '').startsWith(${JSON.stringify(prefix)}))
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const r = node.getBoundingClientRect()
    return r.width ? { x: r.right - 4, y: r.top + Math.min(12, r.height / 2) } : null
  })()`), `no paragraph starting with ${JSON.stringify(prefix)}`)
  await click(send, point)
  await sleep(200)
}

async function selectionNonEmpty(evaluate) {
  return evaluate(`(() => { const s = window.getSelection(); return !!s && s.toString().length > 0 })()`)
}

async function selectRange(evaluate, send, blockText, from, to) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rect = await waitFor(() => charRect(evaluate, blockText, from, to),
      `could not locate range [${from},${to}) in ${JSON.stringify(blockText)}`)
    const y = rect.top + Math.min(12, rect.height / 2)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.left + 1, y, button: 'left', clickCount: 1 })
    for (let step = 1; step <= 4; step += 1) {
      const x = rect.left + ((rect.right - rect.left) * step) / 4
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.max(rect.right - 1, rect.left + 1), y, button: 'left', clickCount: 1 })
    await sleep(250)
    if (await selectionNonEmpty(evaluate)) return
    await sleep(200)
  }
  assert.fail(`drag-select never produced a non-empty selection for [${from},${to}) in ${JSON.stringify(blockText)}`)
}

// Crepe's toolbar buttons carry no identifier, only the title HorseMD's own
// scanner injects. The link button MUST be addressed by that title, never by
// index: `CrepeFeature.Latex` (unconditionally on in this app) contributes a
// formula button between inline-code and link, and the off-by-one that
// caused was a real bug — see task-6-report §1.
async function clickToolbarButtonTitled(evaluate, send, pattern) {
  const rect = await waitFor(() => evaluate(`(() => {
    const b = [...((${VISIBLE_TOOLBAR})?.querySelectorAll('.toolbar-item') || [])]
      .find((n) => ${pattern}.test(n.title || ''))
    if (!b) return null
    const r = b.getBoundingClientRect()
    return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  })()`), `toolbar button matching ${pattern} not found/visible`)
  await click(send, rect)
  await sleep(300)
}

// Mod+key (same shape as test-kernel-marks-ui.mjs's helper) — used for the
// Ctrl/Cmd+B path of the link-boundary refusal below.
async function pressMod(send, key, code, keyCode) {
  const params = { key, code, modifiers: 4, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  await sleep(delay)
}

async function clickHighlightYellow(evaluate, send) {
  const itemRect = await waitFor(() => evaluate(`(() => {
    const it = (${VISIBLE_TOOLBAR})?.querySelector('.hm-highlight-item')
    const r = it?.getBoundingClientRect()
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  })()`), 'highlight toolbar item not found')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...itemRect })
  await sleep(200)
  const swatchRect = await waitFor(() => evaluate(`(() => {
    const sw = (${VISIBLE_TOOLBAR})?.querySelector('.hm-highlight-item .hm-hl-swatch.hm-hl-yellow')
    const r = sw?.getBoundingClientRect()
    return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  })()`), 'highlight yellow swatch not hit-testable (hover state?)')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...swatchRect })
  await click(send, swatchRect)
  await sleep(300)
}

async function linkEditTooltipState(evaluate) {
  return evaluate(`(() => {
    const t = [...document.querySelectorAll('.milkdown-link-edit')].find((n) => n.getAttribute('data-show') === 'true')
    const input = t?.querySelector('input.input-area')
    if (!input) return null
    return { value: input.value, focused: document.activeElement === input }
  })()`)
}

async function hoverLink(evaluate, send, href) {
  const rect = await waitFor(() => evaluate(`(() => {
    const a = (${VISIBLE_EDITOR})?.querySelector('a[href=${JSON.stringify(href)}]')
    if (!a) return null
    a.scrollIntoView({ block: 'center' })
    const r = a.getBoundingClientRect()
    return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  })()`), `link ${href} is not rendered in the view`)
  for (let step = 0; step < 4; step += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + step, y: rect.y })
    await sleep(80)
  }
}

// ---- code-block (block math) helpers -------------------------------------
const MATH_BLOCK = `[...(${VISIBLE_EDITOR})?.querySelectorAll('.milkdown-code-block') || []]
  .find((b) => (b.querySelector('.language-button')?.textContent || '').trim().toLowerCase() === 'latex')`

const cmContent = (evaluate) => evaluate(`(${MATH_BLOCK})?.querySelector('.cm-content')?.textContent ?? null`)

const mathCmVisible = (evaluate) => evaluate(`(() => {
  const content = (${MATH_BLOCK})?.querySelector('.cm-editor .cm-content')
  return !!(content && content.offsetParent)
})()`)

async function revealMathCodeMirror(evaluate, send) {
  if (await mathCmVisible(evaluate)) return
  const point = await waitFor(() => evaluate(`(() => {
    const block = ${MATH_BLOCK}
    if (!block) return null
    block.scrollIntoView({ block: 'center' })
    const btn = block.querySelector('.preview-toggle-button')
    const r = btn?.getBoundingClientRect()
    return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  })()`), 'the block-math preview toggle ("编辑代码") is not hit-testable')
  await sleep(200)
  await click(send, point)
  await waitFor(() => mathCmVisible(evaluate), "clicking Edit did not reveal the block math's CodeMirror editor")
  await sleep(200)
}

async function clickMathCmLineEnd(evaluate, send) {
  const point = await waitFor(() => evaluate(`(() => {
    const block = ${MATH_BLOCK}
    if (!block) return null
    block.scrollIntoView({ block: 'center' })
    const lines = [...block.querySelectorAll('.cm-editor .cm-line')]
    const line = lines[lines.length - 1]
    const r = line?.getBoundingClientRect()
    return r && r.width ? { x: r.right - 2, y: r.top + r.height / 2 } : null
  })()`), "the block math's CodeMirror line is not hit-testable")
  await sleep(300)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(200)
  await pressKey(send, { key: 'End', code: 'End', delayMs: delay })
}

async function pressTab(send) {
  const params = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  await sleep(delay + 150)
}

// The PM block the caret currently sits in — the anti-vacuity control for
// every "click then type" step below (a missed click would otherwise make
// "bytes unchanged" trivially true).
async function selectionBlockText(evaluate) {
  await resolveView(evaluate)
  return evaluate(`(() => {
    const v = window.__hmStage3View
    if (!v) return null
    return v.state.selection.$head.parent.textContent
  })()`)
}

// Same, plus whether the caret really sits at the block's END — the two
// structural-Enter probes in step 10 are only meaningful at the end (an
// Enter in the middle of an inline-HTML fragment is refused by
// `bisectsInlineHtml`, which would make the probe pass for the wrong reason
// if it silently landed there).
async function selectionState(evaluate) {
  await resolveView(evaluate)
  return JSON.parse(await evaluate(`(() => {
    const v = window.__hmStage3View
    if (!v) return 'null'
    const head = v.state.selection.$head
    return JSON.stringify({ text: head.parent.textContent, atEnd: head.parentOffset === head.parent.content.size })
  })()`))
}

// The live PM attrs of the block image whose alt is `alt` (null when none) —
// the discriminating control for the caption veto, which "zero bytes" alone
// cannot provide.
async function imageBlockAttrs(evaluate, alt) {
  await resolveView(evaluate)
  return JSON.parse(await evaluate(`(() => {
    const v = window.__hmStage3View
    let attrs = null
    v.state.doc.forEach((node) => { if (node.type.name === 'image-block' && node.attrs.alt === ${JSON.stringify(alt)}) attrs = node.attrs })
    return JSON.stringify(attrs)
  })()`))
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)
  await writeFile(crlfFile, CRLF_FIXTURE)
  await writeFile(compactFile, COMPACT_FIXTURE)
  await writeFile(svgFile, SVG)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    let { evaluate, send } = app
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('尾段落用于占位') && text.includes('壹贰叁肆') ? text : null
    }, 'initial document did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on plain mount')

    // ============================================================
    // 1) THE HEADLINE: enable kernel mode on a document that mixes math,
    //    inline HTML, a highlight, a table, images and a link — and assert
    //    it attaches LIVE. Before Plan 5 stage 3 any ONE of the first three
    //    made buildProjectionMap return null for the whole file.
    // ============================================================
    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('尾段落用于占位') ? text : null
    }, 'document did not remount after enabling kernel mode')
    await sleep(400)
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy fallback for this fixture — the whole point of stage 3 is that it must not: ${attachDiagnostics}`)

    // Anti-vacuity for the headline: the live document really does contain
    // every stage-3 construct (a fixture that silently lost one of them
    // would attach trivially and prove nothing).
    await resolveView(evaluate)
    const shapes = JSON.parse(await evaluate(`(() => {
      const v = window.__hmStage3View
      const found = { mathBlock: false, mathInline: false, htmlInline: false, highlightYellow: false, highlightRed: false, table: false, imageBlocks: 0, link: false }
      v.state.doc.descendants((node) => {
        const name = node.type.name
        if (name === 'code_block' && (node.attrs.language || '').toLowerCase() === 'latex') found.mathBlock = true
        if (name === 'math_inline') found.mathInline = true
        if (name === 'html') found.htmlInline = true
        if (name === 'table') found.table = true
        if (name === 'image-block') found.imageBlocks += 1
        for (const mark of node.marks || []) {
          if (mark.type.name === 'highlight') found[(mark.attrs.color || 'yellow') === 'red' ? 'highlightRed' : 'highlightYellow'] = true
          if (mark.type.name === 'link') found.link = true
        }
        return true
      })
      return JSON.stringify(found)
    })()`))
    assert.deepEqual(shapes, {
      mathBlock: true, mathInline: true, htmlInline: true, highlightYellow: true, highlightRed: true, table: true, imageBlocks: 2, link: true
    }, `the attached document must really contain every stage-3 construct: ${JSON.stringify(shapes)}`)

    // ============================================================
    // 2) Positive control: an ordinary paragraph in this mixed document
    //    types normally (proves the attach above is a live, editing kernel
    //    and not merely a mounted one).
    // ============================================================
    await clickAt(evaluate, send, '普通段落用于打字定位。', 11)
    assert.equal(await selectionBlockText(evaluate), '普通段落用于打字定位。',
      'the caret must be inside the plain paragraph before typing (positive control)')
    await typeTextLikeUser(send, 'X', { delayMs: delay })
    await waitFor(async () => (await mounted(evaluate) || '').includes('普通段落用于打字定位。X'), 'the typed X never landed')
    await assertSource(evaluate, S1, 'typing in a plain paragraph of the mixed document must commit byte-exact')

    // The table document's FIRST kernel commit emits one pre-existing
    // `projection-mismatch` + repair (task-4-report §6). Snapshot it here
    // and require that it never grows again.
    const mismatchesAfterFirstCommit = await assertNoFatalDiagnostics(evaluate, 'after the first commit')
    assert.ok(mismatchesAfterFirstCommit <= 1,
      `at most ONE first-commit projection-mismatch is tolerated, saw ${mismatchesAfterFirstCommit}`)

    // ============================================================
    // 3) TABLE: edit a header cell. The delimiter row and its alignment
    //    markers must not move by a single byte.
    // ============================================================
    await clickAt(evaluate, send, '甲', 1)
    assert.equal(await selectionBlockText(evaluate), '甲', 'the caret must be inside the 甲 cell (positive control)')
    await typeTextLikeUser(send, 'X', { delayMs: delay })
    await waitFor(async () => (await mounted(evaluate) || '').includes('甲X'), 'the typed cell character never landed')
    const tableSource = await assertSource(evaluate, S2, 'editing a table cell must rewrite ONLY that cell')
    assert.ok(tableSource.includes('| :-- | --: |'),
      'the delimiter row (and its alignment markers) must be byte-identical after a cell edit')

    // ============================================================
    // 4) TABLE Tab: preset-gfm's own cell navigation must run, moving the
    //    caret to the next cell while writing ZERO bytes (task-4-report
    //    §9.1 — before that fix Tab inserted an invisible literal tab into
    //    the cell, dirtying the file on every press).
    // ============================================================
    await clickAt(evaluate, send, '甲X', 2)
    assert.equal(await selectionBlockText(evaluate), '甲X', 'the caret must start in the 甲X cell (positive control)')
    await pressTab(send)
    assert.equal(await selectionBlockText(evaluate), '乙', 'Tab must move the caret to the NEXT cell')
    await assertSource(evaluate, S2, 'Tab in a table cell must write NO bytes')

    // ============================================================
    // 5) HIGHLIGHT: drag-select a word -> the toolbar's yellow swatch ->
    //    `==` bytes; then unwrap back.
    // ============================================================
    await selectRange(evaluate, send, '壹贰叁肆', 0, 4)
    assert.ok(await waitFor(() => evaluate(`!!(${VISIBLE_TOOLBAR})`), 'selection toolbar did not appear (positive control)'),
      'the toolbar must appear on a real selection before any toggle')
    await clickHighlightYellow(evaluate, send)
    await assertSource(evaluate, S3, 'the toolbar highlight must wrap the selection with ==')
    // The fixture already ships an authored YELLOW highlight ("高亮") and a
    // RED one, so this reads all rendered YELLOW marks rather than the first
    // `mark.hm-highlight` (which would be the authored one) — the authored
    // yellow mark doubles as the negative control for the unwrap below.
    const yellowMarks = `[...(${VISIBLE_EDITOR})?.querySelectorAll('mark.hm-highlight.hm-hl-yellow') || []].map((n) => n.textContent)`
    const highlightsAfterWrap = await waitFor(async () => {
      const parsed = JSON.parse(await evaluate(`JSON.stringify(${yellowMarks})`))
      return parsed.includes('壹贰叁肆') ? parsed : null
    }, 'the committed highlight did not render as a yellow <mark> in the view')
    assert.deepEqual(highlightsAfterWrap.slice().sort(), ['壹贰叁肆', '高亮'].sort(),
      `exactly the authored yellow mark plus the new one may be rendered: ${JSON.stringify(highlightsAfterWrap)}`)

    await selectRange(evaluate, send, '壹贰叁肆', 0, 4)
    await clickHighlightYellow(evaluate, send)
    await assertSource(evaluate, S2, 'clicking the highlight swatch again must restore the original bytes')
    assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify(${yellowMarks})`)),
      ['高亮'], "unwrapping must remove ONLY the new mark and leave the fixture's authored one")
    assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify([...(${VISIBLE_EDITOR})?.querySelectorAll('mark.hm-highlight.hm-hl-red') || []].map((n) => n.textContent))`)),
      ['高亮'], 'the red <mark> paragraph must be rendered throughout (it is step 10(d)\'s subject)')

    // ============================================================
    // 6) LINK — three flows on real UI surfaces:
    //    (a) wrap a plain word via the toolbar (button found BY TITLE),
    //    (b) change the AUTHORED link's URL through the preview tooltip,
    //    (c) remove the wrapped link again via the toolbar.
    // ============================================================
    await selectRange(evaluate, send, '伍陆柒捌', 0, 4)
    await clickToolbarButtonTitled(evaluate, send, '/^(链接|Link)$/')
    const editOpened = await waitFor(() => linkEditTooltipState(evaluate), 'the link edit tooltip did not open')
    assert.equal(editOpened.focused, true, 'the link tooltip input must be focused (positive control)')
    assert.equal(editOpened.value, '', 'a NEW link starts with an empty URL field')
    await typeTextLikeUser(send, LINK_URL, { delayMs: delay })
    assert.equal((await linkEditTooltipState(evaluate)).value, LINK_URL, 'the typed URL really reached the tooltip input')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await sleep(400)
    assert.equal(app.dialogs.length, 0, 'no dialog from the link confirm')
    const linkRendered = await waitFor(() => evaluate(`(() => {
      const el = (${VISIBLE_EDITOR})?.querySelector('a[href=${JSON.stringify(LINK_URL)}]')
      return el ? el.textContent : null
    })()`), 'the committed link did not render as an <a> in the view')
    assert.equal(linkRendered, '伍陆柒捌', 'the rendered link covers exactly the selected word')
    await assertSource(evaluate, S4, 'the toolbar link flow must commit [伍陆柒捌](url) byte-exactly')

    // (b) the AUTHORED link's URL, through the hover preview's edit button.
    await clickAt(evaluate, send, '壹贰叁肆', 0) // re-focus the view after the source round trip
    await hoverLink(evaluate, send, 'https://a.example')
    const previewShown = await waitFor(() => evaluate(`(() => {
      const t = [...document.querySelectorAll('.milkdown-link-preview')].find((n) => n.getAttribute('data-show') === 'true')
      const a = t?.querySelector('a.link-display')
      return a ? a.getAttribute('href') : null
    })()`), 'hovering the authored link did not open the preview tooltip')
    assert.equal(previewShown, 'https://a.example', 'the preview tooltip shows the authored URL (positive control)')
    const editBtn = await waitFor(() => evaluate(`(() => {
      const t = [...document.querySelectorAll('.milkdown-link-preview')].find((n) => n.getAttribute('data-show') === 'true')
      const r = t?.querySelector('.link-edit-button')?.getBoundingClientRect()
      return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
    })()`), 'the preview tooltip has no edit button')
    await click(send, editBtn)
    await sleep(400)
    const prefilled = await waitFor(() => linkEditTooltipState(evaluate), 'the edit tooltip did not reopen from the preview')
    assert.equal(prefilled.value, 'https://a.example', 'editing prefills the CURRENT url (positive control)')
    assert.equal(prefilled.focused, true, 'the reopened tooltip input must be focused')
    for (let index = 0; index < 'https://a.example'.length; index += 1) {
      await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 6 })
    }
    assert.equal((await linkEditTooltipState(evaluate)).value, '', 'the URL field was really cleared')
    await typeTextLikeUser(send, AUTHORED_URL_2, { delayMs: delay })
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await sleep(400)
    await assertSource(evaluate, S5, "editing an AUTHORED link must rewrite ONLY its destination segment")

    // (c) remove the wrapped link.
    await selectRange(evaluate, send, '伍陆柒捌', 0, 4)
    await clickToolbarButtonTitled(evaluate, send, '/^(链接|Link)$/')
    await sleep(400)
    assert.equal(await evaluate(`!!(${VISIBLE_EDITOR})?.querySelector('a[href=${JSON.stringify(LINK_URL)}]')`), false,
      'the link mark is gone from the view')
    await assertSource(evaluate, S6, 'removing the link must restore the plain word bytes exactly')

    // ============================================================
    // 7) IMAGE (a): the ONE user-reachable kernel image route — a source
    //    that already contains `![]()` renders Crepe's src input; typing a
    //    URL and confirming dispatches `setAttr('src', …)`
    //    (task-5-report §1: no UI anywhere dispatches alt/title).
    // ============================================================
    // `.link-input-area` only exists in the ImageInput half of the image-block
    // component (rendered when the node has NO src), so it addresses the
    // `![]()` block — but only as long as exactly one such input exists.
    // Assert that rather than relying on first-match order.
    assert.equal(await evaluate(`(${VISIBLE_EDITOR})?.querySelectorAll('.milkdown-image-block .link-input-area').length`), 1,
      'exactly ONE image src input may exist (it is how this step addresses the ![]() block)')
    const inputPoint = await waitFor(() => evaluate(`(() => {
      const input = (${VISIBLE_EDITOR})?.querySelector('.milkdown-image-block .link-input-area')
      if (!input) return null
      input.scrollIntoView({ block: 'center' })
      const r = input.getBoundingClientRect()
      return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
    })()`), 'the empty image did not render a src input')
    await click(send, inputPoint)
    await sleep(200)
    assert.ok(await evaluate(`document.activeElement?.classList.contains('link-input-area')`),
      'the image src input must be focused before typing (positive control)')
    await typeTextLikeUser(send, IMG_SRC, { delayMs: delay })
    assert.equal(await evaluate(`(${VISIBLE_EDITOR})?.querySelector('.milkdown-image-block .link-input-area')?.value`), IMG_SRC,
      'the typed URL really reached the image src input')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await sleep(500)
    assert.equal(app.dialogs.length, 0, 'no dialog from the image src confirm')
    await assertSource(evaluate, S7, 'confirming the image src must rewrite ONLY the destination of ![]()')

    // ============================================================
    // 8) IMAGE (b): the `alt` AttrStep, dispatched directly (no UI exists —
    //    see resolveView's comment), THEN the `caption` AttrStep — a real
    //    byte edit since kernel/image-caption (the alt goes first so its
    //    staleness proof keeps the title-less precondition; a title would
    //    pin the derived caption and erase the mismatch this step exists to
    //    measure).
    // ============================================================
    // Everything from the first commit up to here — table cell, Tab,
    // highlight wrap/unwrap, three link flows and the image `src` commit —
    // must not have produced a SINGLE further projection-mismatch beyond the
    // tolerated first-commit table repair.
    assert.equal(await mismatchCount(evaluate), mismatchesAfterFirstCommit,
      'no interaction up to the image src commit may produce a further projection-mismatch')

    await resolveView(evaluate)
    const altResult = await evaluate(`(() => {
      const v = window.__hmStage3View
      let pos = null
      v.state.doc.forEach((node, p) => { if (node.type.name === 'image-block' && node.attrs.alt === '说明') pos = p })
      if (pos === null) return 'no-image-block'
      v.dispatch(v.state.tr.setNodeAttribute(pos, 'alt', '新说明'))
      return 'dispatched'
    })()`)
    assert.equal(altResult, 'dispatched', 'the block image with alt="说明" must be present for the alt probe')
    await sleep(400)
    assert.equal(app.dialogs.length, 0, 'no dialog from the image alt rewrite')
    await assertSource(evaluate, S8, 'an alt AttrStep must rewrite ONLY the image label bytes')

    // The alt commit costs exactly ONE further projection-mismatch + repair,
    // and that is EXPECTED, deterministic and self-healing rather than a
    // defect: `editor-image-markdown.js`'s parse runner derives
    // `caption: title || alt`, so after a kernel alt write the LIVE PM node
    // still carries the old caption while a fresh parse of the new bytes
    // derives the new one — exactly the staleness task-5-report §8
    // predicted ("a future alt UI must set the caption too"). The repair
    // reconcile is what closes it, so this asserts both halves: one new
    // mismatch, and the live node's derived caption really did catch up.
    // The `src` commit in step 7 is the control that this is alt-specific:
    // `src` feeds no derived attribute and produced no mismatch above.
    const mismatchesAfterAlt = await assertNoFatalDiagnostics(evaluate, 'after the alt AttrStep')
    assert.equal(mismatchesAfterAlt, mismatchesAfterFirstCommit + 1,
      'the alt AttrStep must cost exactly one (repaired) projection-mismatch — no more, and not zero (the caption-derivation staleness is real)')
    const repairedImage = await imageBlockAttrs(evaluate, '新说明')
    assert.ok(repairedImage, 'the live image-block must carry the new alt after the commit')
    assert.equal(repairedImage.caption, '新说明',
      'the repair reconcile must have refreshed the parse-derived caption to match the new alt')

    // 8b) CAPTION: commits into the markdown TITLE slot — the legacy byte
    //    home (`caption: title || alt`). Unlike alt, the pass-through costs
    //    ZERO further mismatches: the AttrStep already put the caption in
    //    the view and the fresh parse of the committed bytes derives the
    //    same value, so view and projection agree by construction. (The
    //    scaled-image refusal and the shadowed-clear refusal are pinned in
    //    test-kernel-image-caption-ui.mjs against real caption-input
    //    gestures, and headlessly in gateway I4b/I5/I6b and mode 22d2.)
    await resolveView(evaluate)
    const captionResult = await evaluate(`(() => {
      const v = window.__hmStage3View
      let pos = null
      v.state.doc.forEach((node, p) => { if (node.type.name === 'image-block' && node.attrs.alt === '新说明') pos = p })
      if (pos === null) return 'no-image-block'
      v.dispatch(v.state.tr.setNodeAttribute(pos, 'caption', ${JSON.stringify(IMG_CAPTION)}))
      return 'dispatched'
    })()`)
    assert.equal(captionResult, 'dispatched', 'the repaired image must be present for the caption edit')
    await sleep(400)
    assert.equal(app.dialogs.length, 0, 'no dialog from the caption edit')
    await assertSource(evaluate, S8cap, 'the caption must commit into the TITLE slot — and nothing else may move')
    assert.equal((await imageBlockAttrs(evaluate, '新说明'))?.caption, IMG_CAPTION,
      'the live node carries the committed caption (the AttrStep passed through)')
    assert.equal(await mismatchCount(evaluate), mismatchesAfterAlt,
      'a caption commit must cost ZERO further projection-mismatches — view and projection agree by construction')

    // ============================================================
    // 9) MATH. Block math is MAPPED AND EDITABLE since 2026-08-18 (see the
    //    S8m comment above): typing in its CodeMirror must commit byte-exact.
    //    The paragraph holding INLINE math is typable around the formula
    //    (P6 Task 1 relaxed `textblockProfile` to admit inline atoms), so
    //    typing there is a real byte commit too; a range that LEAVES the
    //    paragraph is still refused with zero bytes, and no dialog may appear
    //    on either path.
    // ============================================================
    await revealMathCodeMirror(evaluate, send)
    await clickMathCmLineEnd(evaluate, send)
    assert.ok((await evaluate(`document.activeElement?.className || ''`)).includes('cm-content'),
      "the click did not focus the block math's CodeMirror editor (positive control)")
    const mathBefore = await cmContent(evaluate)
    assert.equal(mathBefore, 'E=mc^2', 'the block math CodeMirror must hold the authored formula (positive control)')
    await typeTextLikeUser(send, 'X', { delayMs: delay })
    await waitFor(async () => (await cmContent(evaluate)) === 'E=mc^2X',
      'the character typed into the block math never reached its CodeMirror content')
    await assertSource(evaluate, S8m,
      'typing in block math must commit byte-exact — the block really is mapped')

    await clickBlockEndByPrefix(evaluate, send, '行内公式')
    assert.equal(await selectionBlockText(evaluate), '行内公式  结束。',
      'the caret must be inside the inline-math paragraph (positive control)')
    await typeTextLikeUser(send, 'W', { delayMs: delay })
    await waitFor(async () => ((await mounted(evaluate)) || '').includes('结束。W'),
      'the typed W never landed in the inline-math paragraph (P6-1 made it typable)')
    await assertSource(evaluate, S8b,
      'typing in the inline-math paragraph must now commit byte-exact, next to the untouched $x^2$')

    // ...and a step that leaves the paragraph is still refused with zero bytes.
    // (P6-1b admits a step that swallows an atom WHOLE — its exact removed
    // bytes are pinned headlessly for every atom kind in
    // scripts/test-kernel-gateway.mjs. What this session keeps is the
    // end-to-end proof that a refusal really travels the dispatch-veto path
    // and writes nothing: the range below starts at the atom and runs past the
    // paragraph's end, so `sameParent` refuses it and '$x^2$' survives for
    // step 10(b)'s inline-math cure proof.) Dispatched directly, the same
    // channel step 8's AttrStep uses, because a drag-selection across a
    // KaTeX-rendered formula is not reliably addressable by character rects.
    const atomCross = await evaluate(`(() => {
      const v = window.__hmStage3View
      if (!v) return 'no-view'
      let pos = null
      v.state.doc.descendants((node, p) => { if (pos === null && node.type.name === 'math_inline') pos = p })
      if (pos === null) return 'no-math-inline'
      const $pos = v.state.doc.resolve(pos)
      const end = $pos.end()
      if (end <= pos + 1) return 'atom-at-block-end'
      v.dispatch(v.state.tr.delete(pos, end + 2))
      return 'dispatched'
    })()`)
    assert.equal(atomCross, 'dispatched', 'the inline-math atom must be locatable (positive control)')
    await sleep(400)
    await assertSource(evaluate, S8b,
      'a range leaving the inline-math paragraph must not change a single byte')
    assert.equal(app.dialogs.length, 0, 'no dialog from either math refusal')

    // ============================================================
    // 10) THE CURE PROOFS (see the header's "why attach alone is not the
    //     acceptance"). Every assertion here can ONLY pass while the block
    //     in question is MAPPED — `pmPosToRaw` skips any pair whose charMap
    //     is null, so a block degraded by a regression of the highlight /
    //     inline-math / inline-HTML cure fails closed with zero bytes and
    //     these byte checkpoints go red. The refusals in step 9 cannot do
    //     this job: they are satisfied by the healed AND the degraded state.
    // ============================================================
    // (a) highlight cure — the AUTHORED `==高亮==` paragraph is a plain
    //     marked textblock, so it takes ordinary typing.
    await clickAt(evaluate, send, '已有高亮片段。', 7)
    assert.equal(await selectionBlockText(evaluate), '已有高亮片段。',
      'the caret must be inside the authored-highlight paragraph (positive control)')
    await typeTextLikeUser(send, 'Y', { delayMs: delay })
    await waitFor(async () => (await mounted(evaluate) || '').includes('已有高亮片段。Y'), 'the typed Y never landed in the highlight paragraph')
    await assertSource(evaluate, S9,
      'typing in the AUTHORED-highlight paragraph must commit byte-exact — this is what proves that block is MAPPED, not merely non-degrading')

    // (b) inline-math cure — step 9 already typed into this paragraph (P6-1),
    //     so its text now ends in the committed 'W'; the structural Enter at
    //     its end stays as the second, independent mapped-block proof.
    await clickBlockEndByPrefix(evaluate, send, '行内公式')
    let caret = await selectionState(evaluate)
    assert.deepEqual(caret, { text: '行内公式  结束。W', atEnd: true },
      `Enter must be pressed at the END of the inline-math paragraph: ${JSON.stringify(caret)}`)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await sleep(400)
    await assertSource(evaluate, S10,
      'a structural Enter at the end of the INLINE-MATH paragraph must commit byte-exact — the mapped-block proof for the math cure')

    // (c) inline-HTML cure — same shape (commit 1c0d311 exists precisely to
    //     let structural commands reach inline-HTML paragraphs).
    await clickBlockEndByPrefix(evaluate, send, '片段')
    caret = await selectionState(evaluate)
    assert.deepEqual(caret, { text: '片段  结束。', atEnd: true },
      `Enter must be pressed at the END of the inline-HTML paragraph: ${JSON.stringify(caret)}`)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await sleep(400)
    await assertSource(evaluate, S11,
      'a structural Enter at the end of the INLINE-HTML paragraph must commit byte-exact — the mapped-block proof for the inline-HTML cure')
    assert.equal(app.dialogs.length, 0, 'no dialog from the three cure proofs')

    // (d) the mirror image: the RED `<mark>` paragraph is inline HTML in the
    //     source but an N-character marked run in PM, so it must stay
    //     DEGRADED — both typing and a structural Enter refuse with zero
    //     bytes, while (a)-(c) above just proved the rest of the document is
    //     fully mapped. That contrast IS the per-block degradation contract.
    await clickBlockEndByPrefix(evaluate, send, '红色')
    caret = await selectionState(evaluate)
    assert.deepEqual(caret, { text: '红色高亮片段。', atEnd: true },
      `the caret must sit at the end of the red-mark paragraph: ${JSON.stringify(caret)}`)
    await typeTextLikeUser(send, 'Z', { delayMs: delay })
    await sleep(300)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await sleep(400)
    await assertSource(evaluate, S11,
      'the red-<mark> block must stay degraded: neither typing nor Enter may write a byte, while every other block above committed')
    assert.equal(app.dialogs.length, 0, 'no dialog from the degraded-block refusals')

    // (e) WHOLE-BRANCH REVIEW, CRITICAL 2: a bold whose drag-selection
    //     CROSSES a link boundary must be refused. Before the fix
    //     mark-toggle.js's private overlap set had no `link` in it, so this
    //     exact gesture committed a stranded marker inside the label
    //     ('a [**b](u) c**'), which `requireMap` could not catch because the
    //     result still maps cleanly. The mirror-image operation (linking
    //     across a bold boundary) was already refused, which is what made
    //     this cross-task incoherence rather than an unknown.
    //     Rendered text here is '参见 文档 链接。' (the link label is '文档'
    //     at visible [3,5)), so [4,7) starts inside the label and ends
    //     outside it.
    await selectRange(evaluate, send, '参见 文档 链接。', 4, 7)
    await pressMod(send, 'b', 'KeyB', 66)
    await sleep(400)
    await assertSource(evaluate, S11,
      'bolding a selection that straddles a link boundary must write ZERO bytes')
    // …and the control that keeps this from being a "bold is broken" pass:
    // a selection entirely INSIDE the link label still commits.
    await selectRange(evaluate, send, '参见 文档 链接。', 3, 5)
    await pressMod(send, 'b', 'KeyB', 66)
    await sleep(400)
    await assertSource(evaluate, S12,
      'bolding the link LABEL itself must still commit byte-exact')
    await selectRange(evaluate, send, '参见 文档 链接。', 3, 5)
    await pressMod(send, 'b', 'KeyB', 66)
    await sleep(400)
    await assertSource(evaluate, S11, 'unbolding the label nets back to the previous bytes')
    assert.equal(app.dialogs.length, 0, 'no dialog from the link-boundary refusal')

    // ---- diagnostics: no fatal entry anywhere, and only the two explained
    //      mismatches (first-commit table repair + alt caption derivation) ----
    const mismatchesAtEnd = await assertNoFatalDiagnostics(evaluate, 'end of the interaction chain')
    assert.equal(mismatchesAtEnd, mismatchesAfterAlt,
      `projection-mismatch recurred after the alt commit (${mismatchesAfterAlt} -> ${mismatchesAtEnd}) — only the pre-existing first-commit table repair and the alt caption-derivation repair are tolerated`)

    // ============================================================
    // 11) Save -> disk bytes exact; dialogs empty; full quit; cold reopen.
    //     NOTE: kernel mode is not persisted, so the reopened tab comes back
    //     in LEGACY mode — this is a cross-pipeline check (legacy reads back
    //     exactly what the kernel wrote), not a kernel re-attach.
    // ============================================================
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    assert.equal(await readFile(file, 'utf8'), SAVED, 'disk bytes must match the kernel-derived expectation exactly')
    assert.equal(app.dialogs.length, 0, `no rebuild prompt may appear: ${JSON.stringify(app.dialogs.map((d) => d.message))}`)

    await stopBuiltElectron(app, { removeProfile: false })
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, cleanProfile: false, appArgs: [file] })
    ;({ evaluate, send } = app)
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('尾段落用于占位') && text.includes('甲X') ? text : null
    }, 'reopened document did not mount with the saved content')
    await toggleSourceMode(evaluate)
    assert.equal(await waitFor(() => visibleSource(evaluate), 'source view did not appear after cold reopen'), SAVED,
      'cold reopen must reproduce the saved kernel-mode bytes exactly, byte-for-byte')
    assert.equal(app.dialogs.length, 0, 'no rebuild prompt may appear on cold reopen')

    // ============================================================
    // 12) CRLF variant, isolated session: the same mixture with '\r\n'
    //     endings must attach too, and a cell edit must keep every ending
    //     intact on disk (the source view shows an LF projection —
    //     see test-codeblock-crlf-ui.mjs).
    // ============================================================
    await stopBuiltElectron(app, { removeProfile: true })
    app = await launchBuiltElectron({ profileDir: join(root, 'profile-crlf'), port: port + 2, appArgs: [crlfFile] })
    ;({ evaluate, send } = app)
    await waitFor(async () => (await mounted(evaluate) || '').includes('尾段落'), 'CRLF fixture did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on the CRLF fixture mount')
    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the CRLF tab')
    await sleep(400)
    const crlfDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!crlfDiagnostics.includes('attach-unmappable'),
      `the CRLF mixture degraded to legacy fallback: ${crlfDiagnostics}`)

    await clickAt(evaluate, send, '甲', 1)
    assert.equal(await selectionBlockText(evaluate), '甲', 'the caret must be inside the CRLF 甲 cell (positive control)')
    await typeTextLikeUser(send, 'X', { delayMs: delay })
    await waitFor(async () => (await mounted(evaluate) || '').includes('甲X'), 'the typed CRLF cell character never landed')
    await assertSource(evaluate, CRLF_AFTER_CELL.replace(/\r\n/g, '\n'),
      'the CRLF table cell edit must commit byte-exact (LF projection in the source view)')

    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'CRLF save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'CRLF save did not finish')
    const crlfDisk = await readFile(crlfFile, 'utf8')
    assert.equal(crlfDisk, CRLF_AFTER_CELL, 'CRLF disk bytes must match the kernel-derived expectation exactly')
    assert.ok(!/\r(?!\n)/.test(crlfDisk), 'the CRLF document must contain no lone \\r')
    assert.ok(!/(?<!\r)\n/.test(crlfDisk), 'the CRLF document must contain no bare \\n')
    assert.equal(app.dialogs.length, 0, 'no dialog from the CRLF save')
    await assertNoFatalDiagnostics(evaluate, 'CRLF session')

    // ============================================================
    // 13) WHOLE-BRANCH REVIEW, CRITICAL 1 — a COMPACT table, isolated
    //     session: typing '\' at the end of a cell must be REFUSED (the
    //     table survives, on screen and on disk), while ordinary typing in
    //     the same cell still commits byte-exact.
    // ============================================================
    await stopBuiltElectron(app, { removeProfile: true })
    app = await launchBuiltElectron({ profileDir: join(root, 'profile-compact'), port: port + 4, appArgs: [compactFile] })
    ;({ evaluate, send } = app)
    await waitFor(async () => (await mounted(evaluate) || '').includes('尾段落'), 'compact-table fixture did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on the compact-table mount')
    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the compact-table tab')
    await sleep(400)
    const compactDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!compactDiagnostics.includes('attach-unmappable'),
      `the compact table degraded to legacy fallback: ${compactDiagnostics}`)

    // (a) the corruption gesture: caret after 甲, type one backslash.
    await clickAt(evaluate, send, '甲', 1)
    assert.equal(await selectionBlockText(evaluate), '甲', 'the caret must be inside the compact 甲 cell')
    await typeTextLikeUser(send, '\\', { delayMs: delay })
    await sleep(500)
    await assertSource(evaluate, COMPACT_FIXTURE,
      "typing '\\' at the end of a COMPACT table cell must write ZERO bytes — it used to commit '|甲\\|乙|' and destroy the table")
    // The table is still a TABLE in the live view — the pre-fix behavior
    // repaired the view into a single paragraph to match the ruined bytes.
    assert.equal(await evaluate(`!!(${VISIBLE_EDITOR})?.querySelector('table')`), true,
      'the compact table must still be rendered as a table after the refusal')
    assert.equal(app.dialogs.length, 0, 'no dialog from the compact-cell refusal')

    // (b) the control: an ordinary character in the SAME cell still commits.
    await clickAt(evaluate, send, '甲', 1)
    await typeTextLikeUser(send, 'X', { delayMs: delay })
    await waitFor(async () => (await mounted(evaluate) || '').includes('甲X'), 'the ordinary compact-cell character never landed')
    await assertSource(evaluate, COMPACT_AFTER_CELL,
      'ordinary typing in a compact cell must still commit byte-exact — the proof refuses corruption, not compact tables')

    // (c) disk bytes after save, and a cold reopen that still reads a table.
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'compact save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'compact save did not finish')
    assert.equal(await readFile(compactFile, 'utf8'), COMPACT_AFTER_CELL,
      'the compact table must reach disk with its structure intact')
    await assertNoFatalDiagnostics(evaluate, 'compact-table session')

    console.log('PASS kernel-mode stage-3 domains UI regression: a document mixing inline+block math, inline HTML, a highlight, a table, two images and a link attaches LIVE, then table cell editing, Tab navigation, the highlight swatch, the link wrap/edit/remove flows, the image src input, the image alt AttrStep, the caption commit into the title slot, the block-math byte commit, the inline-math cross-block refusal, the link-boundary bold refusal, save, cold reopen, the CRLF variant and the compact-table backslash refusal all match the kernel-derived byte strings')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
