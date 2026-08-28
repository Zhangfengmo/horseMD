// toggleBlockquote: wrap/unwrap the TOP-LEVEL block containing `offset` in a
// Markdown blockquote, entirely as raw-byte per-line prefix edits — the same
// multi-edit-atomic idiom indent.js uses for list indent/outdent.
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
import { QUOTE_MARKER_SOURCE } from '../../markdown-preservation/block-prefix.js'
import { parseKernelMarkdown } from '../syntax-index.js'

// One quote level, anchored at line start. Deliberately NOT the (unanchored,
// repeated) QUOTE_PREFIX — this command only ever adds/removes exactly ONE
// layer per call (see ADR below), so it only ever needs to match ONE marker.
const QUOTE_MARKER_RE = new RegExp('^' + QUOTE_MARKER_SOURCE)

// ADR (probed against the live parser — remark-parse + remark-gfm, the same
// processor buildSyntaxIndex uses — not guessed from the brief): this command
// is a pure TOGGLE keyed on the TOP-LEVEL (root-child) node's own type, not a
// separate wrap/unwrap mode:
//   - top-level type === 'blockquote' -> UNWRAP one layer from every owned
//     line (works identically whether the quote is one level or N levels
//     deep: '> > text\n' -> QUOTE_MARKER_RE matches only the FIRST '> ' on
//     each line, so one call peels exactly one level, same as the plan's
//     "嵌套引用...减一层" — probed: processor.parse('> > text\n').children is
//     ONE root-level `blockquote` node spanning the whole span, confirming
//     the top-level walk lands on it regardless of nesting depth).
//   - top-level type is paragraph/heading/list (not already quoted at the
//     OUTERMOST level) -> WRAP one layer onto every owned line.
// A top-level node that is ALREADY a blockquote never reaches the wrap
// branch — there is no "add a second layer to an already-quoted top-level
// block" path in THIS function; repeated invocation instead peels one level
// per call until the content is a plain paragraph/heading/list again, at
// which point the next call re-wraps it. This is the natural reading of
// "toggle" (mirrors toggleInlineMark's same-kind-exact-cover-unwraps
// contract) and keeps the decision provable from ONE signal (the top-level
// node's type) instead of requiring an out-of-band mode the brief's
// `{doc, index, offset} -> result` signature has no slot for.
//
// "定位当前顶层块" (locate the current TOP-LEVEL block) is read literally as
// mdast's own root.children — NOT the nearest textblock ancestor. A caret
// inside a list item resolves to the OUTER list (a root child) even when
// that list nests sub-lists; a caret inside an existing blockquote resolves
// to the OUTER blockquote (also a root child) even when it nests a list or a
// second quote level — both are exactly the "list 整块" / "quote 最外层" cases
// the brief calls out, and both fall out of the SAME single root-children walk
// with no separate case analysis needed.
const SUPPORTED_WRAP_TYPES = new Set(['paragraph', 'heading', 'list'])

function within(node, offset) {
  const start = node?.position?.start?.offset
  const end = node?.position?.end?.offset
  return Number.isInteger(start) && Number.isInteger(end) && offset >= start && offset < end
}

// Same exclusive-end + one-step-back recovery idiom as enter.js's
// resolveBlock (:26-34), applied to the ROOT's own children instead of the
// flattened per-block-type index — the caret sitting right after a top-level
// block's last character (before its line terminator) is the single most
// common "toggle quote from here" position and must resolve, not refuse.
function topLevelNodeAt(index, offset) {
  const children = index.tree?.children || []
  const direct = children.find((node) => within(node, offset))
  if (direct) return direct
  if (offset > 0) {
    const before = children.find((node) => within(node, offset - 1))
    if (before && offset === before.position.end.offset) return before
  }
  return null
}

function ownedRows(index, node) {
  const start = node.position.start.offset
  const end = node.position.end.offset
  const first = index.lineIndexAt(start)
  const last = index.lineIndexAt(Math.max(start, end - 1))
  const rows = []
  for (let i = first; i <= last; i += 1) rows.push(i)
  return rows
}

// Same running-delta caret math as indent.js's selectionFor — every prefix
// edit at or before `offset` shifts it; these edits are always pure inserts
// (wrap) or pure deletions (unwrap) at a line's own start, so `offset` can
// only ever land AFTER an insert or OUTSIDE a deletion's own span in
// practice, but the deletion-interior clamp is kept for defensive symmetry
// with indent.js (a caret that somehow resolved inside a stripped marker
// clamps to the edit's own insertion point).
function selectionFor(edits, offset) {
  let delta = 0
  for (const edit of edits) {
    if (edit.from > offset) break
    const insertLen = String(edit.insert ?? '').length
    if (edit.to <= offset) {
      delta += insertLen - (edit.to - edit.from)
    } else {
      delta += insertLen - (offset - edit.from)
    }
  }
  return offset + delta
}

function multiTxn(doc, edits, intent, offset) {
  const anchor = selectionFor(edits, offset)
  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      edits,
      intent,
      selection: { anchor, head: anchor }
    }
  }
}

// WRAP: every non-blank owned line gets '> ' inserted at its own start
// (position 0 of the line — never "after an existing prefix", because a
// top-level node reaching this branch is, by construction, NOT nested inside
// any outer quote, so every owned line's true start IS the insertion point;
// see the ADR above for why a line that happens to carry ITS OWN unrelated
// '>' — e.g. a nested blockquote inside one list item's content — must still
// receive the new marker at absolute line start, not after that inner '>':
// CommonMark recognizes an outer quote purely by a '> ' prefix consumed
// first from the RAW line, so wrapping the whole list makes that entire raw
// line, inner '>' included, into the new quote's content).
//
// BLANK owned lines get a BARE '>' (no trailing space) instead of being
// skipped — probed against the live parser (remark-parse + remark-gfm): a
// loose list's internal blank line, if left untouched while its neighbor
// lines gain '> ', reparses as TWO separate blockquotes
// ('> - one\n\n> - two\n' -> two root-level `blockquote` nodes), not one
// cohesive quoted list. A bare '>' on that same line keeps it ONE blockquote
// ('> - one\n>\n> - two\n' -> one `blockquote` node spanning the whole
// range) — CommonMark's laziness clause only covers non-blank paragraph
// continuation text, never a genuinely blank line. `bareQuote`-equivalent
// here is simply "no trailing space variant of the marker" since there is no
// existing prefix to trim (mirrors enter.js's own bareQuote helper, which
// exists for the same continuation-line contract).
function wrapEdits(index, rows) {
  return rows.map((i) => {
    const line = index.lines[i]
    const blank = line.text.trim() === ''
    return { from: line.start, to: line.start, insert: blank ? '>' : '> ' }
  })
}

// UNWRAP: strip exactly one QUOTE_MARKER_RE match from every owned line's
// start. Fail-closed (returns null) the instant any owned line does not
// carry a real '>' there — a top-level `blockquote` node's own raw lines
// should always carry one by construction, but this never trusts that by
// omission (same philosophy as indent.js's ownedLineIndexes strict-prefix
// check).
function unwrapEdits(index, rows) {
  const edits = []
  for (const i of rows) {
    const line = index.lines[i]
    const m = line.text.match(QUOTE_MARKER_RE)
    const marker = m?.[0] ?? ''
    if (!marker.includes('>')) return null
    edits.push({ from: line.start, to: line.start + marker.length, insert: '' })
  }
  return edits
}

export function toggleBlockquote({ doc, index, offset }) {
  const node = topLevelNodeAt(index, offset)
  if (!node) return { ok: false, code: 'unsupported-structure' }

  const rows = ownedRows(index, node)

  if (node.type === 'blockquote') {
    const edits = unwrapEdits(index, rows)
    if (!edits) return { ok: false, code: 'unsupported-structure' }
    return multiTxn(doc, edits, 'unwrap-blockquote', offset)
  }

  if (!SUPPORTED_WRAP_TYPES.has(node.type)) {
    return { ok: false, code: 'unsupported-structure' }
  }
  const edits = wrapEdits(index, rows)
  return multiTxn(doc, edits, 'wrap-blockquote', offset)
}


// ===========================================================================
// BACKSPACE ON A BLOCKQUOTE (2026-08-28, user: 「引用要求参照代码一样要支持删除」)
// ===========================================================================
// Measured before this pair existed, kernel default-on:
//   caret in an EMPTY quote (`>`), Backspace
//     -> PM lifted the paragraph out; the gateway could not classify the
//        cross-parent replaceAround and refused: nothing written, the quote
//        unremovable (`unsupported-input-type`).
//   caret at the CONTENT START of `> 引用内容`, Backspace
//     -> routed structurally, and refused (`unsupported-structure`).
// So a blockquote could be created and typed in, but never taken back out —
// the dead end the empty fenced block was in until `deleteEmptyCodeBlock`
// (commands/code-exit.js), which is the shape the user asked these to mirror.

// The blockquote whose own span contains `offset`, at ANY depth: Backspace in
// a nested quote belongs to the innermost one.
function blockquoteAt(index, offset) {
  let found = null
  const walk = (node) => {
    if (!within(node, offset) && !(offset > 0 && within(node, offset - 1))) return
    if (node.type === 'blockquote') found = node
    for (const child of node.children || []) walk(child)
  }
  for (const child of index.tree?.children || []) walk(child)
  return found
}

const countNodeType = (tree, type) => {
  let n = 0
  const walk = (node) => {
    if (node?.type === type) n += 1
    for (const child of node?.children || []) walk(child)
  }
  walk(tree)
  return n
}

const leafValues = (tree) => {
  const out = []
  const walk = (node) => {
    if (typeof node?.value === 'string') out.push(node.value)
    for (const child of node?.children || []) walk(child)
  }
  walk(tree)
  return out.sort()
}

// A quote with nothing in it: `>` on its own line(s), no content node at all.
// `> ` with trailing spaces parses the same way — the spaces are not content.
const quoteIsEmpty = (node) => !(node?.children || []).length

// Backspace inside an EMPTY blockquote deletes it, in `deleteEmptyCodeBlock`'s
// posture exactly: the edit runs from the first line's content (AFTER any
// OUTER quote prefix, so a nested empty quote keeps its parent) through the
// last line's end, leaving one prefix-only line with its ending for the
// controller's placeholder machinery to land the caret on.
//
// PROVEN, NOT ASSUMED, on the same three axes the code-block twin uses: one
// fewer blockquote, the heading count unchanged (the setext trap this family
// shares), and every leaf value identical — an empty quote owns no leaf, so
// the multiset may not move at all.
export function deleteEmptyBlockquote({ doc, index, offset }) {
  const text = doc?.text
  if (typeof text !== 'string' || !Number.isInteger(doc?.revision)) return { ok: false, code: 'unsupported-structure' }
  if (!Number.isInteger(offset)) return { ok: false, code: 'unsupported-structure' }
  const node = blockquoteAt(index, offset)
  if (!node || !quoteIsEmpty(node)) return { ok: false, code: 'unsupported-structure' }
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end)) return { ok: false, code: 'unsupported-structure' }
  const first = index.lineAt(start)
  const last = index.lineAt(Math.max(start, end - 1))
  if (!first || !last || last.start < first.start) return { ok: false, code: 'unsupported-structure' }
  // Everything before this quote's OWN marker: outer quote levels only. Any
  // other prefix (list indent, a marker) is a container this command has not
  // proven, so it refuses rather than cutting into it.
  const outerMatch = first.text.slice(0, start - first.start).match(/^[ \t]*(?:>[ \t]*)*$/)
  if (!outerMatch) return { ok: false, code: 'unsupported-structure' }
  const from = first.start + outerMatch[0].length
  const to = last.end
  if (to <= from) return { ok: false, code: 'unsupported-structure' }
  const candidate = text.slice(0, from) + text.slice(to)
  let baseline
  let after
  try {
    baseline = parseKernelMarkdown(text)
    after = parseKernelMarkdown(candidate)
  } catch {
    return { ok: false, code: 'unsupported-structure' }
  }
  if (countNodeType(after, 'blockquote') !== countNodeType(baseline, 'blockquote') - 1) {
    return { ok: false, code: 'unsupported-structure' }
  }
  if (countNodeType(after, 'heading') !== countNodeType(baseline, 'heading')) {
    return { ok: false, code: 'unsupported-structure' }
  }
  if (JSON.stringify(leafValues(after)) !== JSON.stringify(leafValues(baseline))) {
    return { ok: false, code: 'unsupported-structure' }
  }
  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      edits: [{ from, to, insert: '' }],
      intent: 'delete-empty-blockquote',
      selection: { anchor: from, head: from }
    }
  }
}

// Backspace at the CONTENT START of a quote's first line unwraps one level —
// the gesture every editor binds there, and byte-wise the exact edit
// `toggleBlockquote` already proves (one `> ` stripped from every owned row).
// Delegating keeps ONE unwrap spelling in the codebase instead of a second
// copy that could drift from it.
export function unwrapBlockquoteAtContentStart({ doc, index, offset }) {
  const node = blockquoteAt(index, offset)
  if (!node || quoteIsEmpty(node)) return { ok: false, code: 'unsupported-structure' }
  const start = node.position?.start?.offset
  if (!Number.isInteger(start)) return { ok: false, code: 'unsupported-structure' }
  const line = index.lineAt(start)
  if (!line) return { ok: false, code: 'unsupported-structure' }
  // The caret must sit at the first content byte of the quote's FIRST line:
  // anywhere else Backspace is an ordinary character delete.
  const marker = line.text.slice(start - line.start).match(/^>[ \t]?/)
  if (!marker) return { ok: false, code: 'unsupported-structure' }
  if (offset !== start + marker[0].length) return { ok: false, code: 'unsupported-structure' }
  return toggleBlockquote({ doc, index, offset })
}
