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
//   a ==hl== b            highlight.position = {2,9} (includes both `==`),
//                        child text = {4,6} — a REAL node since Plan 5 Task 3
//                        (syntax-index.js injects positioned `highlight`
//                        nodes via highlight-syntax.js), so it needs no
//                        special case at all: it is a span node like
//                        strong/emphasis/delete. See the ADR below.
//
// ADR — highlight detection (superseded 2026-08-17, Plan 5 Task 3):
// This module used to detect a highlight with an O(1) "flank probe": are the
// two bytes immediately before rawFrom and immediately after rawTo both `=`?
// That heuristic existed only because the kernel's remark chain had no node
// for `==text==` — it was indistinguishable from plain text at the mdast
// level, and a text SEARCH would have violated the "prove, don't search"
// contract every other mapper in this directory follows.
//
// The kernel chain now injects real, positioned `highlight` nodes (the same
// regex the editor's own `highlightRemark` uses, applied to the same mdast
// `text` values, with byte spans derived from the character map's decode
// walk — highlight-syntax.js owns the rule and the reasoning). So the probe
// is GONE: `rangeFromSpanNode` derives the marker/content split from the node
// itself, exactly as it does for `**`/`*`/`~~`.
//
// This is strictly stronger than the flank probe was, and the difference is
// observable: the probe answered "highlight" for any selection with `=` bytes
// on both flanks, including shapes neither parser reads as a highlight
// (`===x===`, `==x= =y==`, an escaped `\=\=x\=\=`). Those now correctly
// return null instead of offering an unwrap that would have deleted four
// meaningless `=` bytes.
export const MARK_TYPES = Object.freeze(['strong', 'emphasis', 'delete', 'inlineCode', 'highlight'])

// THE ONE OWNER of "which inline node's byte span may a wrap not PARTIALLY
// straddle" (2026-08-17 whole-branch review, Critical 2). Two copies of this
// set existed — commands/mark-toggle.js's (marks only) and
// commands/link-toggle.js's (marks + link/image/html/math/footnote/break) —
// and they drifted: Plan 5 Task 3 added `highlight` to the mark-toggle copy
// without widening it, so bolding a drag-selection that crossed a link
// boundary committed a stranded marker INSIDE the link label:
//   'a [b](u) c\n' + bold over the visible "b c"  ->  'a [**b](u) c**\n'
//   'a [b](u) c\n' + bold over the visible "a b"  ->  '**a [b**](u) c\n'
// The mirror-image operation (linking across a bold boundary) was already
// refused by link-toggle's own copy, so this was cross-task incoherence, not
// an unknown. Both commands now import THIS set; adding a node type here
// widens the refusal for every wrap command at once.
//
// Membership rule: a node whose raw span carries DELIMITER bytes of its own
// (`[`…`](…)`, `**`…`**`, `` ` ``, `<span>`…`</span>`, `$`…`$`, `![`…`](…)`,
// `[^1]`, a hard break's trailing spaces). A range that covers such a node
// entirely, or sits entirely inside it, is legal; one that crosses a boundary
// would put the new wrapper's opening marker on one side of the delimiters
// and its closing marker on the other.
//
// The ATOM types (`image`, `imageReference`, `html`, `inlineMath`,
// `footnoteReference`, `break`) are width-1 VISIBLE units, so a visible
// selection can never land mid-atom and their presence here is belt-and-
// braces — pinned as such in scripts/test-source-kernel-commands.mjs rather
// than assumed. `link`/`linkReference` are the ones that were genuinely
// reachable: their label is real, selectable phrasing.
export const OVERLAP_NODE_TYPES = Object.freeze(new Set([
  'strong', 'emphasis', 'delete', 'inlineCode', 'highlight', 'link', 'linkReference',
  'image', 'imageReference', 'html', 'inlineMath', 'footnoteReference', 'break'
]))

const SPAN_NODE_TYPES = new Set(['strong', 'emphasis', 'delete', 'highlight'])

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

// Exported (not just used internally via `rangeForNode`) so a caller that
// already has a concrete inlineCode mdast node in hand — but not a
// [rawFrom,rawTo] query pair `inlineMarkAt` can match against, e.g.
// mark-toggle.js's atom-selection fallback (inlineCode is a single
// indivisible unit in character-map.js, so its content bytes can never
// appear as rawFrom/rawTo on their own) — can derive the same open/close/
// content split without duplicating the backtick-run-counting algorithm.
export function rangeFromInlineCode(node, text) {
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

  // One lookup path for every kind since Plan 5 Task 3 (highlight lost its
  // flank-probe special case — see the ADR above).
  return block.node ? findExactMark(block.node, text, rawFrom, rawTo) : null
}
