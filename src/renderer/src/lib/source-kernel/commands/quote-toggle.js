// toggleBlockquote: wrap/unwrap the TOP-LEVEL block containing `offset` in a
// Markdown blockquote, entirely as raw-byte per-line prefix edits — the same
// multi-edit-atomic idiom indent.js uses for list indent/outdent.
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
import { QUOTE_MARKER_SOURCE } from '../../markdown-preservation/block-prefix.js'

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
