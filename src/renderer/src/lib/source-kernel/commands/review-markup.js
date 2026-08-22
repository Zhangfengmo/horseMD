// CriticMarkup review commands as raw-byte source edits (review domain).
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
//
// WHY THIS IS A KERNEL DOMAIN AT ALL
// ----------------------------------
// CriticMarkup is PLAIN TEXT syntax: `{++ins++}`, `{--del--}`,
// `{==text==}{>>comment<<}`. The editor's own highlight rule was written so
// review markup stays literal — `HIGHLIGHT_RE`'s `(?<![={])` lookbehind and
// `(?!\})` lookahead (highlight-syntax.js) exist precisely so `{==a==}{>>c<<}`
// never becomes a highlight mark — and `{++`/`{--` collide with nothing in
// CommonMark. So in a source-authoritative kernel each review command is a
// byte insertion/replacement at a provable offset, and the projected view
// (the reparse) carries the same literal text the decorations already scan
// (editor-review-decorations.js works on text-node content).
//
// THE ONE KIND THAT IS NOT LITERAL: substitution. `{~~old~>new~~}` embeds a
// GFM strikethrough (`~~old~>new~~`), which the EDITOR chain re-merges into
// one literal text node (editor-criticmarkup-plugins.js
// `remarkReconstructSubstitution`) while the KERNEL chain (syntax-index.js)
// deliberately has no such rule yet — the two parses disagree on the block,
// the pair degrades to `charMap: null`, and any anchor inside it is
// unresolvable. Writing the bytes anyway would commit a marker into a block
// the user could no longer type in, so the wrap REFUSES with its own code
// (`review-substitution`) before touching anything. Documents that already
// contain substitution markers keep today's behavior: the block is a
// read-only pair, the substitution widget still renders (PM side), and
// accept/reject-all — a whole-document string rewrite + reload, no PM
// transaction — still resolves them.
//
// THE PROOF (family style — outsideSignature + predicted content):
//  1. The selection/marker span must be a CONTIGUOUS run of literal `char`
//     units in the block's character map (`review-plain-selection`): no
//     atoms, no entities, no escapes, no mark-delimiter gaps. That makes the
//     raw bytes and the visible text identical over the span, so the marker
//     the file carries is exactly the marker the user saw wrapped.
//  2. The touched span must sit inside ONE mdast text node of the RAW parse.
//     The candidate (an honest splice — re-asserted, not assumed) must
//     reparse with: the same block node at the same start, ending exactly
//     `delta` later, under the same ancestor chain; that text node's DECODED
//     value exactly as predicted (the old value with the written bytes
//     spliced in at the decoded offsets — decode-invariant, so escapes and
//     entities elsewhere in the node cannot fake a match); every OTHER
//     descendant of the block byte-identical modulo the edit's shift; and
//     everything OUTSIDE the block `outsideSignature`-identical. Marker bytes
//     that would interact with surrounding syntax (a `**` forming, a list
//     absorbing the line, …) change one of those facts and refuse.
import { bisectsLineEnding, textUnits } from '../character-map.js'
import { parseKernelMarkdown } from '../syntax-index.js'
import { outsideSignature } from './list-merge.js'
import {
  REVIEW_KINDS,
  makeHighlightCommentMarkup,
  scanReviewMarkup,
  wrapReviewSelection
} from '../../../reviewMarkup.js'

// Same domain gate as mark-toggle.js: paragraphs and headings only. Table
// cells (blockAt answers 'table'), code, math and html are out of scope.
const INLINE_CONTENT_BLOCKS = new Set(['paragraph', 'heading'])

// The wrap kinds the kernel can own. `substitution` is refused by name (see
// the header); `comment` alone is not a UI wrap kind (the comment marker only
// ships glued to a highlight).
const WRAP_KINDS = new Set([
  REVIEW_KINDS.addition,
  REVIEW_KINDS.deletion,
  REVIEW_KINDS.highlight
])

// Is [visFrom, visTo) a contiguous run of literal `char` units whose raw
// bytes are exactly [rawFrom, rawTo)? Empty ranges pass (nothing to prove —
// the insert point itself was resolved by the map). A linebreak unit inside
// the range answers 'multiline' so the caller can keep legacy's own
// inline-only message; anything else non-literal answers 'plain'.
function literalSelectionIssue(map, visFrom, visTo, rawFrom, rawTo) {
  if (visFrom === visTo) return null
  let v = 0
  let expectRaw = null
  let first = true
  for (const unit of map.units || []) {
    const vEnd = v + unit.width
    if (vEnd > visFrom && v < visTo) {
      if (unit.kind === 'linebreak') return 'multiline'
      if (unit.kind !== 'char') return 'plain'
      if (first) {
        if (unit.rawStart !== rawFrom) return 'plain'
        first = false
      } else if (unit.rawStart !== expectRaw) {
        return 'plain'
      }
      expectRaw = unit.rawEnd
    }
    v = vEnd
    if (v >= visTo) break
  }
  return !first && expectRaw === rawTo ? null : 'plain'
}

// The deepest mdast TEXT node of `blockNode` containing [rawFrom, rawTo]
// (inclusive ends: a zero-width insert may sit exactly on the node's edge).
function textNodeContaining(blockNode, rawFrom, rawTo) {
  let found = null
  const visit = (node) => {
    if (found) return
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (!Number.isInteger(start) || !Number.isInteger(end)) return
    if (node.type === 'text' && start <= rawFrom && rawTo <= end) {
      found = node
      return
    }
    for (const child of node.children || []) visit(child)
  }
  visit(blockNode)
  return found
}

// The VALUE index of raw offset `raw` inside a text node's proven unit walk.
// Only unit boundaries resolve — anything else is unprovable and refuses.
// Units within one text node are contiguous, so "end of unit i" and "start of
// unit i+1" are the same value index.
function valueIndexAtRaw(units, raw) {
  let v = 0
  for (const unit of units) {
    if (unit.rawStart === raw) return v
    if (unit.rawStart > raw) return null
    v += unit.kind === 'linebreak' ? unit.ending.length : unit.width
    if (unit.rawEnd === raw) return v
    if (unit.rawEnd > raw) return null
  }
  return null
}

// Pre-order signature of a block's subtree EXCLUDING one node, every offset
// pushed through `shiftPoint` (identity on the candidate side; the piecewise
// edit shift on the baseline side, where a point strictly inside the edited
// span answers null and refuses). Values ride along JSON-quoted so a value
// containing ':' or a newline cannot forge a frame boundary.
function blockSignatureWithout(node, exclude, shiftPoint) {
  const parts = []
  let ok = true
  const visit = (current) => {
    if (!ok || current === exclude) return
    const start = current.position?.start?.offset
    const end = current.position?.end?.offset
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      ok = false
      return
    }
    const from = shiftPoint(start)
    const to = shiftPoint(end)
    if (from === null || to === null) {
      ok = false
      return
    }
    parts.push(`${current.type}:${from}:${to}:${JSON.stringify(current.value ?? null)}`)
    for (const child of current.children || []) visit(child)
  }
  visit(node)
  return ok ? parts.join('\n') : null
}

// Locate the block node with EXACTLY this span+type in a parse tree, and the
// types of its ancestors (the container chain the reparse must preserve).
function blockNodePath(tree, start, end, type) {
  let found = null
  const visit = (node, ancestors) => {
    if (found) return
    const s = node.position?.start?.offset
    const e = node.position?.end?.offset
    if (!Number.isInteger(s) || !Number.isInteger(e)) return
    if (s === start && e === end && node.type === type) {
      found = { node, ancestors: ancestors.map((a) => a.type) }
      return
    }
    if (s <= start && e >= end) {
      for (const child of node.children || []) visit(child, [...ancestors, node])
    }
  }
  for (const child of tree.children || []) visit(child, [])
  return found
}

// The shared reparse proof: replacing [rawFrom, rawTo) of `text` with
// `insert` (literal ASCII the caller vouches for) must change EXACTLY the one
// text node's decoded value in the predicted way and nothing else anywhere.
// Answers `{ candidate }` or null (the caller refuses 'unsupported-structure').
function proveInlineTextSplice({ text, block, rawFrom, rawTo, insert }) {
  const candidate = text.slice(0, rawFrom) + insert + text.slice(rawTo)
  const delta = insert.length - (rawTo - rawFrom)
  // The byte relation, stated unconditionally (list-merge.js discipline): the
  // candidate IS the baseline with exactly this span replaced.
  if (candidate.length !== text.length + delta) return null
  if (candidate.slice(0, rawFrom) !== text.slice(0, rawFrom)) return null
  if (candidate.slice(rawFrom + insert.length) !== text.slice(rawTo)) return null

  let baselineTree
  let candidateTree
  try {
    // The baseline is re-parsed rather than reusing `index.tree`: the index
    // carries injectHighlightNodes' split text nodes, which a plain
    // parseKernelMarkdown of the candidate does not (block-insert.js records
    // the same reasoning).
    baselineTree = parseKernelMarkdown(text)
    candidateTree = parseKernelMarkdown(candidate)
  } catch {
    return null
  }

  const blockStart = block.start
  const blockEnd = block.end
  const base = blockNodePath(baselineTree, blockStart, blockEnd, block.type)
  if (!base) return null
  const target = textNodeContaining(base.node, rawFrom, rawTo)
  if (!target) return null
  const units = textUnits(text, target)
  if (!units) return null
  const vFrom = valueIndexAtRaw(units, rawFrom)
  const vTo = valueIndexAtRaw(units, rawTo)
  if (vFrom === null || vTo === null || vTo < vFrom) return null
  const value = String(target.value ?? '')
  // `insert` is literal ASCII (marker bytes + a proven-literal selection), so
  // its decoded spelling is itself — the prediction is a plain value splice.
  const predicted = value.slice(0, vFrom) + insert + value.slice(vTo)

  const cand = blockNodePath(candidateTree, blockStart, blockEnd + delta, block.type)
  if (!cand) return null
  if (base.ancestors.length !== cand.ancestors.length ||
      base.ancestors.some((type, i) => type !== cand.ancestors[i])) {
    return null
  }
  const targetStart = target.position.start.offset
  const targetEnd = target.position.end.offset
  let candidateTarget = null
  const findTarget = (node) => {
    if (candidateTarget) return
    if (node.type === 'text' &&
        node.position?.start?.offset === targetStart &&
        node.position?.end?.offset === targetEnd + delta) {
      candidateTarget = node
      return
    }
    for (const child of node.children || []) findTarget(child)
  }
  findTarget(cand.node)
  if (!candidateTarget || String(candidateTarget.value ?? '') !== predicted) return null

  const shift = (p) => (p <= rawFrom ? p : p >= rawTo ? p + delta : null)
  const baseSignature = blockSignatureWithout(base.node, target, shift)
  const candSignature = blockSignatureWithout(cand.node, candidateTarget, (p) => p)
  if (baseSignature === null || candSignature === null || baseSignature !== candSignature) {
    return null
  }

  const before = outsideSignature(baselineTree, blockStart, blockEnd, 0)
  const after = outsideSignature(candidateTree, blockStart, blockEnd + delta, delta)
  if (before === null || after === null || before !== after) return null

  return { candidate, delta }
}

// Resolve + gate the [visFrom, visTo) range shared by both commands: map it,
// refuse CRLF bisection, and require a paragraph/heading block that fully
// contains it. Answers { rawFrom, rawTo, block } or { code }.
function resolveRange({ doc, index, map, visFrom, visTo }) {
  if (!doc || !index || !map || typeof doc.text !== 'string') {
    return { code: 'unsupported-structure' }
  }
  if (!Number.isInteger(visFrom) || !Number.isInteger(visTo) || visTo < visFrom) {
    return { code: 'unsupported-structure' }
  }
  const range = map.rawRangeForVisibleRange(visFrom, visTo)
  if (!range) return { code: 'unmapped-selection' }
  if (bisectsLineEnding(map, doc.text, range.from) ||
      bisectsLineEnding(map, doc.text, range.to)) {
    return { code: 'unmapped-selection' }
  }
  const block = index.blockAt(range.from)
  if (!block || !INLINE_CONTENT_BLOCKS.has(block.type) ||
      range.from < block.start || range.to > block.end) {
    return { code: 'unmapped-selection' }
  }
  return { rawFrom: range.from, rawTo: range.to, block }
}

// Wrap the visible selection in a CriticMarkup marker — the kernel-mode form
// of editor-review.js's applyReviewMarkupInView. Byte spellings (including
// highlight's edge-space redistribution and the in-marker selection/caret)
// come from the SAME wrapReviewSelection the legacy paths use, applied at the
// proven raw offsets, so the two modes can never drift on what the marker
// looks like.
export function wrapReviewMarkup({ doc, index, map, visFrom, visTo, kind }) {
  if (kind === REVIEW_KINDS.substitution) {
    return { ok: false, code: 'review-substitution' }
  }
  if (!WRAP_KINDS.has(kind)) return { ok: false, code: 'unsupported-structure' }
  const resolved = resolveRange({ doc, index, map, visFrom, visTo })
  if (resolved.code) return { ok: false, code: resolved.code }
  const { rawFrom, rawTo, block } = resolved

  const issue = literalSelectionIssue(map, visFrom, visTo, rawFrom, rawTo)
  if (issue === 'multiline') return { ok: false, code: 'review-multiline' }
  if (issue) return { ok: false, code: 'review-plain-selection' }
  // Belt-and-suspenders with literalSelectionIssue (a linebreak unit's raw
  // run also carries the ending): the written marker must never span lines.
  if (/[\r\n]/.test(doc.text.slice(rawFrom, rawTo))) {
    return { ok: false, code: 'review-multiline' }
  }

  const wrapped = wrapReviewSelection(doc.text, rawFrom, rawTo, kind)
  if (wrapped.error === 'multiline') return { ok: false, code: 'review-multiline' }
  if (wrapped.error) return { ok: false, code: 'unsupported-structure' }
  const insert = wrapped.text.slice(rawFrom, rawTo + (wrapped.text.length - doc.text.length))

  const proven = proveInlineTextSplice({ text: doc.text, block, rawFrom, rawTo, insert })
  if (!proven) return { ok: false, code: 'unsupported-structure' }

  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      from: rawFrom,
      to: rawTo,
      insert,
      intent: 'review-wrap',
      // wrapReviewSelection's contract: addition/deletion keep the wrapped
      // text selected inside the marker; highlight parks the caret between
      // `>>` and `<<` so the comment can be typed immediately.
      selection: { anchor: wrapped.selectionStart, head: wrapped.selectionEnd }
    }
  }
}

// Resolve ONE existing highlight-comment marker — the review card's
// Done/Delete ('remove': markup goes, highlighted text stays) and Edit→Save
// ('replace': the whole marker span becomes the re-spelled markup). The
// marker is located by RESCANNING THE SOURCE (scanReviewMarkup — the same
// scanner the display uses) and must sit exactly on the mapped span with
// exactly the content the card showed; anything else is stale and refuses.
export function resolveReviewMarker({
  doc,
  index,
  map,
  visFrom,
  visTo,
  expected,
  action,
  replacement
}) {
  if (action !== 'remove' && action !== 'replace') {
    return { ok: false, code: 'unsupported-structure' }
  }
  const resolved = resolveRange({ doc, index, map, visFrom, visTo })
  if (resolved.code) return { ok: false, code: resolved.code }
  const { rawFrom, rawTo, block } = resolved

  const marker = scanReviewMarkup(doc.text).find(
    (m) => m.kind === REVIEW_KINDS.highlight && m.start === rawFrom && m.end === rawTo
  )
  if (!marker) return { ok: false, code: 'review-marker-not-found' }
  if (expected &&
      (marker.content.text !== String(expected.text ?? '') ||
       marker.content.comment !== String(expected.comment ?? ''))) {
    return { ok: false, code: 'review-marker-not-found' }
  }

  let insert
  if (action === 'remove') {
    insert = marker.content.text
  } else {
    if (!replacement || !replacement.text || !replacement.comment) {
      return { ok: false, code: 'review-invalid-fields' }
    }
    try {
      insert = makeHighlightCommentMarkup(replacement.text, replacement.comment)
    } catch {
      return { ok: false, code: 'review-invalid-fields' }
    }
  }

  const proven = proveInlineTextSplice({ text: doc.text, block, rawFrom, rawTo, insert })
  if (!proven) return { ok: false, code: 'unsupported-structure' }

  const caret = rawFrom + insert.length
  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      from: rawFrom,
      to: rawTo,
      insert,
      intent: 'review-resolve',
      selection: { anchor: caret, head: caret }
    }
  }
}
