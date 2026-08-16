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

// inlineCode is an ATOM in the character map (character-map.js's ATOMS set)
// — the whole `` `code` `` span collapses to ONE indivisible visible unit,
// so its content bytes (excluding backticks) can never be independently
// selected via visFrom/visTo the way strong/emphasis/delete content can. A
// real "select this existing inline-code span, toggle code off" selection
// therefore always resolves rawFrom/rawTo to the ATOM's full outer bounds
// (backticks included), which `inlineMarkAt`'s content-only exact match will
// never see. Detect that specific shape directly — an inlineCode child whose
// own [start,end) equals [rawFrom,rawTo) exactly — then derive its
// open/close/content split via mark-map.js's exported `rangeFromInlineCode`
// (the same backtick-run-counting algorithm `inlineMarkAt` itself uses; not
// duplicated here).
function inlineCodeAtomAt(block, text, rawFrom, rawTo) {
  if (!block?.node) return null
  let node = null
  const visit = (n) => {
    for (const child of n.children || []) {
      if (child.type === 'inlineCode' &&
          child.position?.start?.offset === rawFrom &&
          child.position?.end?.offset === rawTo) {
        node = child
      }
      if (child.children) visit(child)
    }
  }
  visit(block.node)
  return node ? rangeFromInlineCode(node, text) : null
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

  // Step 3: exact-cover match against an existing mark. inlineCode's atom
  // shape needs the fallback above (see inlineCodeAtomAt) since its content
  // can never appear as rawFrom/rawTo on its own.
  const existing = inlineMarkAt(index, rawFrom, rawTo) ||
    (kind === 'inlineCode' ? inlineCodeAtomAt(block, doc.text, rawFrom, rawTo) : null)
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
  // an existing mark's byte span (neither wrap-around nor sub-span).
  if (hasPartialOverlap(block, rawFrom, rawTo)) {
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
