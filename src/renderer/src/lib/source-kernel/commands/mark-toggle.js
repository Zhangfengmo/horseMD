// toggleInlineMark: apply/remove an inline mark (strong/emphasis/delete/
// inlineCode/highlight) over a visible selection, entirely as raw-byte
// source edits — no ProseMirror mark commands involved.
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
import { inlineMarkAt, markerFor, rangeFromInlineCode } from '../mark-map.js'

// Same domain gate as mark-map.js's inlineMarkAt (table cells / code blocks /
// html / math are unprobed for this task and stay out of scope entirely —
// see mark-map.js's INLINE_CONTENT_BLOCKS comment for why this must be a
// hard gate rather than something callers are trusted to pre-filter).
const INLINE_CONTENT_BLOCKS = new Set(['paragraph', 'heading'])

// Node types with a real mdast span (marker bytes are part of node.position)
// that a wrap must not partially straddle. `highlight` is deliberately
// excluded — the kernel's own remark chain has no dedicated node for `==`
// (see mark-map.js's ADR), so there is nothing to walk for it; the only
// provable highlight check remains mark-map.js's O(1) exact-flank probe.
const OVERLAP_NODE_TYPES = new Set(['strong', 'emphasis', 'delete', 'inlineCode'])

// Whether the visible character at `visIndex` is whitespace, decided only
// from evidence the character map already proved (never re-decoded/guessed):
// a literal single-width `char` unit whose raw byte is itself the character,
// or a `linebreak` unit (always decodes to '\n'). Multi-width units (wide
// codepoints), atoms, entities, and escapes are never treated as whitespace
// — an entity like `&nbsp;`'s raw bytes are `&nbsp;`, not a space, so
// widening this to "decoded value is whitespace" would require decoding
// logic this module doesn't own; those positions simply stop the shrink.
function isWhitespaceVisible(map, text, visIndex) {
  if (visIndex < 0 || visIndex >= map.visibleLength) return false
  let v = 0
  for (const unit of map.units) {
    if (visIndex < v + unit.width) {
      if (unit.kind === 'linebreak') return true
      if (unit.kind === 'char' && unit.width === 1) return /\s/.test(text[unit.rawStart])
      return false
    }
    v += unit.width
  }
  return false
}

// Shrinks [visFrom, visTo) inward past leading/trailing whitespace. Returns
// null for an empty or all-whitespace selection (fail-closed — the caller
// rejects with 'unsupported-structure', there is no content left to mark).
function shrinkToNonWhitespace(map, text, visFrom, visTo) {
  let from = visFrom
  let to = visTo
  while (from < to && isWhitespaceVisible(map, text, from)) from += 1
  while (to > from && isWhitespaceVisible(map, text, to - 1)) to -= 1
  if (from >= to) return null
  return { from, to }
}

function collectOverlapRanges(node, out) {
  for (const child of node.children || []) {
    if (OVERLAP_NODE_TYPES.has(child.type)) {
      const start = child.position?.start?.offset
      const end = child.position?.end?.offset
      if (Number.isInteger(start) && Number.isInteger(end)) out.push({ start, end })
    }
    if (child.children) collectOverlapRanges(child, out)
  }
  return out
}

// Since P4-3.5 an inlineCode span maps as per-VALUE-char units (no more
// width-1 atom — see character-map.js's inlineCodeUnits), so selecting the
// rendered code text resolves rawFrom/rawTo to the value's own byte range and
// `inlineMarkAt`'s exact content match handles the common unwrap directly.
// One shape it can't see: a PADDED span (`` ` x ` `` — CommonMark strips one
// leading+trailing space, the everyday case being a literal backtick shown
// via `` `` ` `` ``), where the char map's units cover only the VALUE bytes,
// so the selection resolves one byte inside the raw content on each edge.
// Accept that as a same-kind exact cover too: open/close ranges are widened
// to swallow the padding spaces along with the backtick runs, restoring the
// bare value on unwrap.
function paddedInlineCodeAt(block, text, rawFrom, rawTo) {
  if (!block?.node) return null
  let found = null
  const visit = (n) => {
    for (const child of n.children || []) {
      if (child.type === 'inlineCode') {
        const range = rangeFromInlineCode(child, text)
        if (range &&
            range.contentRange.from + 1 === rawFrom &&
            range.contentRange.to - 1 === rawTo &&
            text[range.contentRange.from] === ' ' &&
            text[range.contentRange.to - 1] === ' ') {
          found = {
            type: 'inlineCode',
            openRange: { from: range.openRange.from, to: rawFrom },
            closeRange: { from: rawTo, to: range.closeRange.to },
            contentRange: { from: rawFrom, to: rawTo }
          }
        }
      }
      if (child.children) visit(child)
    }
  }
  visit(block.node)
  return found
}

// True if [rawFrom, rawTo) sits entirely inside an existing inline-code
// span's content. Newly REACHABLE since P4-3.5 (an atom's interior could
// never be selected; per-char units make sub-span selections real): wrapping
// a sub-span of literal code content with ANY marker would just inject
// marker bytes into the code span (rendered literally, or worse, a nested-
// backtick mess for kind inlineCode) — refuse for every kind. Exact/padded
// covers are handled (unwrap or different-kind reject) before this check.
function insideInlineCodeContent(block, text, rawFrom, rawTo) {
  if (!block?.node) return false
  let inside = false
  const visit = (n) => {
    for (const child of n.children || []) {
      if (child.type === 'inlineCode') {
        const range = rangeFromInlineCode(child, text)
        if (range && rawFrom >= range.contentRange.from && rawTo <= range.contentRange.to) {
          inside = true
        }
      }
      if (child.children) visit(child)
    }
  }
  visit(block.node)
  return inside
}

// True if [rawFrom, rawTo) straddles some existing mark node's byte span
// without either fully containing it (wrap-around nesting, legal) or being
// fully contained by it (wrap of a sub-span of that node's content, legal —
// CommonMark-parseability of the result is not this module's job; the
// mode-level cheap-path reparse-verify is the backstop for structural
// surprises, per the plan's Global Constraints).
function hasPartialOverlap(block, rawFrom, rawTo) {
  if (!block?.node) return false
  const ranges = collectOverlapRanges(block.node, [])
  return ranges.some(({ start, end }) => {
    if (!(start < rawTo && rawFrom < end)) return false // no intersection at all
    const selectionContainsNode = rawFrom <= start && end <= rawTo
    const nodeContainsSelection = start <= rawFrom && rawTo <= end
    return !(selectionContainsNode || nodeContainsSelection)
  })
}

export function toggleInlineMark({ doc, index, map, visFrom, visTo, kind }) {
  const marker = markerFor(kind)
  if (!marker || !map || !index || !doc) return { ok: false, code: 'unsupported-structure' }
  if (!Number.isInteger(visFrom) || !Number.isInteger(visTo) || visTo < visFrom) {
    return { ok: false, code: 'unsupported-structure' }
  }

  // Step 1: whitespace shrink (empty/all-whitespace selection rejects here).
  const shrunk = shrinkToNonWhitespace(map, doc.text, visFrom, visTo)
  if (!shrunk) return { ok: false, code: 'unsupported-structure' }

  // Step 2: map proof. `rawRangeForVisibleRange` resolves `from` through the
  // map's gap-aware `rawStartForVisible` (see character-map.js's ADR comment
  // on `buildCharacterMap`) — a null result covers unmapped boundaries AND
  // atoms (an atom is always exactly 1 visible unit wide, so no visible
  // offset can ever land mid-atom — the map's boundary tables simply have no
  // entry there).
  const range = map.rawRangeForVisibleRange(shrunk.from, shrunk.to)
  if (!range) return { ok: false, code: 'unmapped-selection' }
  const { from: rawFrom, to: rawTo } = range

  // Defensive: the caller guarantees a single-block selection (the map was
  // built for exactly one block), but this module doesn't trust that by
  // omission — verify the mapped raw range actually sits inside a
  // paragraph/heading block before doing anything with it. Anything else
  // (cross-block, or a block type this task didn't probe) can't be proven,
  // same bucket as an unmapped boundary.
  const block = index.blockAt(rawFrom)
  if (!block || !INLINE_CONTENT_BLOCKS.has(block.type) ||
      rawFrom < block.start || rawTo > block.end) {
    return { ok: false, code: 'unmapped-selection' }
  }

  // Step 3: exact-cover match against an existing mark. A PADDED inline-code
  // span needs the fallback (see paddedInlineCodeAt): its stripped padding
  // spaces sit between the selectable value bytes and the backtick runs, so
  // `inlineMarkAt`'s raw-content exact match never sees the selection.
  const existing = inlineMarkAt(index, rawFrom, rawTo) ||
    (kind === 'inlineCode' ? paddedInlineCodeAt(block, doc.text, rawFrom, rawTo) : null)
  if (existing) {
    if (existing.type !== kind) return { ok: false, code: 'unsupported-structure' }
    const { openRange, closeRange, contentRange } = existing
    const openLen = openRange.to - openRange.from
    const anchor = contentRange.from - openLen
    const head = contentRange.to - openLen
    return {
      ok: true,
      transaction: {
        baseRevision: doc.revision,
        edits: [
          { from: openRange.from, to: openRange.to, insert: '' },
          { from: closeRange.from, to: closeRange.to, insert: '' }
        ],
        intent: 'unwrap-inline-mark',
        selection: { anchor, head }
      }
    }
  }

  // Step 3b: no exact cover — reject any selection that partially straddles
  // an existing mark's byte span (neither wrap-around nor sub-span), and any
  // sub-span of an inline-code span's literal content (see
  // insideInlineCodeContent above).
  if (hasPartialOverlap(block, rawFrom, rawTo) ||
      insideInlineCodeContent(block, doc.text, rawFrom, rawTo)) {
    return { ok: false, code: 'unsupported-structure' }
  }

  // Step 4: wrap. inlineCode can't swallow a literal backtick into its
  // content (an ambiguous/longer delimiter run would be needed, which this
  // task deliberately does not attempt — fail-closed).
  if (kind === 'inlineCode' && doc.text.slice(rawFrom, rawTo).includes('`')) {
    return { ok: false, code: 'unsupported-structure' }
  }

  const markerLen = marker.length
  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      edits: [
        { from: rawFrom, to: rawFrom, insert: marker },
        { from: rawTo, to: rawTo, insert: marker }
      ],
      intent: 'wrap-inline-mark',
      // Step 5: content span in NEW coordinates, inside the inserted markers.
      selection: { anchor: rawFrom + markerLen, head: rawTo + markerLen }
    }
  }
}
