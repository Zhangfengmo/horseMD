// InlineMarkMap: derives an inline mark's marker/content byte ranges from
// mdast node positions, anchored to raw source offsets.
//
// This module is pure: no Electron/React/@milkdown imports (source-kernel
// convention, see syntax-index.js).
//
// Probed against this repo's actual kernel parse chain (unified + remark-parse
// + remark-gfm, syntax-index.js's `processor` — NOT the editor's remark chain,
// which additionally carries the custom highlight find-and-replace plugin):
//
//   a **bold** b        strong.position   = {2,10}  (includes `**`+`**`)
//                        firstChild(text)  = {4,8}   ("bold")
//                        => openRange {2,4} "**", closeRange {8,10} "**",
//                           contentRange {4,8} "bold"
//   a *em* b             emphasis.position = {2,6}, child text = {3,5}
//   a ~~del~~ b          delete.position   = {2,9}, child text = {4,7}
//   a _em_ b             emphasis.position = {2,6}, child text = {3,5}
//                        (marker bytes read straight from raw source, so `_`
//                         vs `*` needs no special-casing — see rangeFromSpanNode)
//   **a *b* c**           strong{0,11} > emphasis{4,7}: nested span nodes each
//                        keep their own accurate position; only the node whose
//                        CONTENT range exactly equals the query matches, so
//                        selecting just "b" naturally yields the emphasis
//                        (innermost) and never the strong — no extra "pick
//                        innermost" logic is needed, ranges just don't collide.
//   a `code` b            inlineCode.position = {2,8} (includes backticks),
//                        NO children (`value` leaf) — open/close width is
//                        read by counting a literal backtick run directly off
//                        the raw slice from each edge (see rangeFromInlineCode),
//                        not derived from `value.length` (space-stripping
//                        inside the span, e.g. "` foo `" -> value "foo", would
//                        make a raw-length-minus-value-length division wrong
//                        even though it happens to be symmetric; counting the
//                        literal backtick run is exact and needs no arithmetic).
//   a ``code`` b          inlineCode.position = {2,10}; double-backtick run
//                        counted the same way (2 on each edge).
//   a ``a`b`` c            inlineCode.value = "a`b" — a *single* backtick
//                        survives as content because the delimiter run (2) is
//                        strictly longer; counting from each edge stops at the
//                        first non-backtick, so this is handled correctly too.
//   > a **bold** b        blockquote > paragraph > strong: mdast positions are
//                        ABSOLUTE raw offsets over the whole document, so a
//                        mark inside a quoted paragraph needs no prefix
//                        adjustment — probed and confirmed.
//   a ==hl== b             KERNEL'S mdast (no highlight plugin in this chain)
//                        parses this as a single plain `text` node, value
//                        "a ==hl== b" — `==` is NOT a node boundary here. See
//                        the ADR in the highlight section below.
//
// ADR — highlight detection:
// The kernel's own remark chain (this file's caller only ever builds a
// LosslessSyntaxIndex via syntax-index.js, which does NOT load the editor's
// custom highlight plugin) has no dedicated mdast node for `==text==`; it is
// indistinguishable from plain text at the mdast level. Text search over the
// block would violate the "prove, don't search" contract every other mapper
// in this directory follows (character-map.js, syntax-index.js) — a highlight
// pair could reappear elsewhere in the same block, in an atom, in a code
// span's rendered text, etc.
//
// Since Task 2 (toggle command) only ever calls `inlineMarkAt` with a
// [rawFrom, rawTo] pair that a character map has ALREADY proven to be a real,
// lossless raw span for the CURRENT selection (never a search target), we can
// reduce "is this selection an existing highlight?" to a fixed-width, O(1)
// check at those exact proven offsets: are the two bytes immediately before
// rawFrom, and the two bytes immediately after rawTo, both literal `=`? If
// both flanks match, the selection is a highlight's content; if only one
// flank matches (or neither), it is not — never widen the check into a scan.
export const MARK_TYPES = Object.freeze(['strong', 'emphasis', 'delete', 'inlineCode', 'highlight'])

const SPAN_NODE_TYPES = new Set(['strong', 'emphasis', 'delete'])

// Marks meaningful only where remark parses real inline content — table
// cells/code/html/math blocks are out of scope for Task 1 (unprobed) and are
// intentionally excluded rather than guessed at.
const INLINE_CONTENT_BLOCKS = new Set(['paragraph', 'heading'])

const MARKER_BY_KIND = Object.freeze({
  strong: '**',
  emphasis: '*',
  delete: '~~',
  inlineCode: '`',
  highlight: '=='
})

export function markerFor(kind) {
  return MARKER_BY_KIND[kind] ?? null
}

function rangeFromSpanNode(node) {
  const children = node.children || []
  const first = children[0]
  const last = children[children.length - 1]
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  const firstStart = first?.position?.start?.offset
  const lastEnd = last?.position?.end?.offset
  if (![start, end, firstStart, lastEnd].every(Number.isInteger)) return null
  if (start >= firstStart || lastEnd >= end || firstStart > lastEnd) return null
  return {
    type: node.type,
    openRange: { from: start, to: firstStart },
    closeRange: { from: lastEnd, to: end },
    contentRange: { from: firstStart, to: lastEnd }
  }
}

function rangeFromInlineCode(node, text) {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return null
  let openEnd = start
  while (openEnd < end && text[openEnd] === '`') openEnd += 1
  let closeStart = end
  while (closeStart > openEnd && text[closeStart - 1] === '`') closeStart -= 1
  if (openEnd <= start || closeStart >= end || openEnd > closeStart) return null
  return {
    type: 'inlineCode',
    openRange: { from: start, to: openEnd },
    closeRange: { from: closeStart, to: end },
    contentRange: { from: openEnd, to: closeStart }
  }
}

function rangeForNode(node, text) {
  if (SPAN_NODE_TYPES.has(node.type)) return rangeFromSpanNode(node)
  if (node.type === 'inlineCode') return rangeFromInlineCode(node, text)
  return null
}

function findExactMark(root, text, rawFrom, rawTo) {
  let found = null
  const visit = (node) => {
    for (const child of node.children || []) {
      const range = rangeForNode(child, text)
      if (range && range.contentRange.from === rawFrom && range.contentRange.to === rawTo) {
        // Pre-order traversal: a later (deeper) exact match overwrites an
        // earlier (shallower) one, so nesting naturally resolves to the
        // innermost node — see the nested strong>emphasis note above.
        found = range
      }
      if (child.children) visit(child)
    }
  }
  visit(root)
  return found
}

// Bounds are checked against the BLOCK's own [start,end), not just the whole
// document's length. Given today's line-based CommonMark block structure a
// flank crossing a block boundary can't actually spell literal '==' (a line
// terminator, which is never '=', always sits at the crossing point) — but
// that is a property of the *parser*, not of this function, and this
// function must not rely on it. The block-bound check makes "never resolve
// bytes outside the block that produced this query" a structural invariant
// of `highlightAt` itself, independent of whatever CommonMark happens to
// guarantee about adjacent blocks today.
function highlightAt(text, rawFrom, rawTo, block) {
  if (rawFrom - 2 < block.start || rawTo + 2 > block.end) return null
  const openFlank = text.slice(rawFrom - 2, rawFrom)
  const closeFlank = text.slice(rawTo, rawTo + 2)
  if (openFlank !== '==' || closeFlank !== '==') return null
  return {
    type: 'highlight',
    openRange: { from: rawFrom - 2, to: rawFrom },
    closeRange: { from: rawTo, to: rawTo + 2 },
    contentRange: { from: rawFrom, to: rawTo }
  }
}

// index: a LosslessSyntaxIndex from buildSyntaxIndex(text) — supplies `.text`
// and `.blockAt(offset)`. rawFrom/rawTo: raw source byte offsets (already
// proven by a character map upstream — this function does not itself trust
// arbitrary offsets beyond bounds-checking them).
export function inlineMarkAt(index, rawFrom, rawTo) {
  if (!index || !Number.isInteger(rawFrom) || !Number.isInteger(rawTo) || rawTo <= rawFrom) {
    return null
  }
  const text = index.text
  if (rawFrom < 0 || rawTo > text.length) return null

  const block = index.blockAt(rawFrom)
  // Single gate for BOTH lookup paths: a block outside paragraph/heading is
  // out of scope for this task in its entirety, not just for the highlight
  // flank check. `findExactMark` recurses through the ENTIRE block subtree
  // (e.g. a GFM `table` block's rows/cells), so without this gate it would
  // happily return a byte-correct strong/emphasis/delete/inlineCode match
  // sitting inside a table cell — correct offsets, but table domain is
  // explicitly deferred (unprobed) per the plan, so it must not be resolved
  // here at all. Table cells are ALSO opaque to the projection map at a
  // higher layer (double protection), but this gate is the structural
  // guarantee that THIS module never answers outside its declared scope,
  // regardless of what any caller layer does or forgets to do.
  if (!block || !INLINE_CONTENT_BLOCKS.has(block.type)) return null

  const exact = block.node ? findExactMark(block.node, text, rawFrom, rawTo) : null
  if (exact) return exact

  return highlightAt(text, rawFrom, rawTo, block)
}
