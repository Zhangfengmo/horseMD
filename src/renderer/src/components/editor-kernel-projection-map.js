// ProjectionMap: structural-path pm-position <-> raw-source-offset mapping.
//
// Kernel-mode integration Task 1 (Plan 2). Consumes the pure Plan-1 kernel
// (buildSyntaxIndex/buildCharacterMap) and a real ProseMirror `doc`, and
// proves a lossless structural alignment between the two trees WITHOUT any
// text search (no indexOf/substring matching anywhere below) — alignment is
// derived purely from node-type pairing walked in document order, exactly
// like `editor-source-map.js`'s block mapping but re-derived here on the
// kernel's mdast (rather than a fresh remark parse) so ProjectionMap can
// reuse the kernel's single source of truth for block boundaries.
//
// Fail-closed, at TWO different granularities (P5-2.5):
//   * STRUCTURAL failures reject the WHOLE map (`null`), never a partial/
//     best-effort map — block count, block type pairing, the ordered flag,
//     the image-block / block-HTML shape guards, a surplus PM node, an
//     unconsumed mdast block, an unconsumed vouched placeholder. Each of
//     those says the two trees are ALIGNED DIFFERENTLY, so no pair's offsets
//     can be trusted.
//   * CONTENT failures degrade only THAT PAIR to a non-editable leaf
//     (`charMap: null`): the kernel couldn't character-map the block, or the
//     kernel's decoded visible length disagrees with PM's own content size.
//     Both are statements about one block, and the pairing is positional —
//     each pair's raw offsets come from its OWN mdast node position — so the
//     neighbours keep byte-correct offsets. Every consumer resolves through
//     `pairForContentPos`/`rawToPmPos`, which skip charMap-less pairs and
//     answer `null`, so an unprovable block is simply read-only and every
//     write into it fails closed. Before P5-2.5 one such block nulled the
//     entire map, silently degrading the whole tab back to legacy.
//
// ==========================================================================
// INVARIANT (P5-2.5 review finding — READ THIS BEFORE ADDING A PLUGIN)
// ==========================================================================
// The per-block degradation above is only safe because A MIS-ALIGNED ZIP
// ALWAYS CHANGES THE BLOCK COUNT. The zip pairs `flattenPm[i]` with
// `flattenMd[i]`; if the two sequences ever describe the same document with
// the same COUNT but a different ORDER/CORRESPONDENCE, then a pair whose type
// and visible length coincidentally agree is served with offsets belonging to
// a DIFFERENT source block — silently, since the map deliberately does no
// text search. Before P5-2.5 that class was caught for free: a mis-aligned
// zip virtually always produced at least ONE length disagreement, and that
// disagreement rejected the WHOLE map. That canary is gone by construction —
// only the offending pair degrades now — so the invariant has to be stated
// and defended explicitly.
//
// Every known way the two sides can differ in block count today, and why each
// is still caught document-wide (verified 2026-08-17):
//   1. `remarkMergeInlineHtml` merging ROOT-LEVEL html siblings (editor side
//      loses a block; Case H9) -> mdast has an unconsumed block ->
//      `mdIndex !== mdBlocks.length`.
//   2. ProseMirror `createAndFill` inserting the schema-required filler
//      paragraph in a list item holding a leading block (PM gains a block;
//      Case M6) -> the surplus/type guards.
//   3. `@milkdown/plugin-trailing` appending an empty final paragraph (PM
//      gains a block) -> the ONE deliberately tolerated surplus, and only as
//      an EMPTY, LAST, top-level paragraph.
//   4. `createMermaidSplitPlugin` (editor-mermaid.js) splitting one mermaid
//      `code_block` into N (PM gains N-1 NON-EMPTY blocks) -> the surplus
//      guard refuses (a non-empty code_block never qualifies as the trailing
//      placeholder). In kernel mode it never even lands: its slice carries
//      node content, so the gateway classifies the appendTransaction as
//      `blocked` and vetoes it.
//   5. `createMathBlockPromotionPlugin` (editor-math.js) replacing typed
//      `$$x$$` with a `code_block` (PM gains blocks) -> same two layers as 4.
//   6. `remark-frontmatter` — FIXED in P6 Task 2, recorded here because the
//      shape it used to produce is instructive. The kernel's processor had no
//      frontmatter extension, so `---\ntitle: x\n---` was
//      `thematicBreak + setext heading` to it while PM held ONE `frontmatter`
//      node (not in PM_TO_MD, so `flattenPm` recorded no slot at all) -> the
//      very first pair was a type mismatch and the counts differed too, so
//      every frontmatter document degraded ENTIRELY. Both chains now mount
//      the same plugin with the same preset (syntax-index.js) and the pair is
//      declared in PM_TO_MD, so this is one slot on each side. It stays a
//      READ-ONLY leaf (`frontmatter` is an atom -> `editable` false ->
//      `charMap: null`), so it still never serves an offset.
// None of these can produce "same count, different correspondence": a merge
// only removes, a fill/split/promotion only adds, and NOTHING in either chain
// REORDERS blocks. A future plugin that removes one block and adds another in
// the same pass WOULD break this invariant — it must either be given an
// explicit pairing here or be kept out of the parse chain.
//
// Second line of defence (not a substitute): `blockEndpointsAgree` below
// cross-checks each SERVED pair's first/last decoded character against the PM
// node's own text. It catches the ordinary mis-zip (neighbouring blocks
// rarely share both endpoints) but not one whose blocks agree on type, length
// AND both endpoint characters — see Case P7b in
// scripts/test-kernel-projection-map.mjs, which pins that residual honestly.
// ==========================================================================
//
// Some block TYPES are non-editable by construction — they still occupy a
// slot in the structural pairing (so a document CONTAINING one still maps
// its other blocks), but never carry a charMap and any offset targeting them
// (or their raw span) resolves to `null`: `html` (no reliable character-level
// decode contract) and `table` (treated as one opaque leaf — see
// OPAQUE_TYPES below). `code_block` (Plan 3 Task 3) gets a real,
// prefix-aware charMap via `buildCodeMap` — EXCEPT when it pairs with mdast
// `math` (TeX source, not the char-per-char prose/code contract) or its own
// `attrs.language` is one Crepe renders as a preview-only diagram instead of
// literal text (mermaid/latex) — see READONLY_CODE_LANGUAGES below.
// See docs referenced by Task 1 brief:
// scripts/test-editor-source-map.mjs for the hand-built-PM-schema precedent
// and src/renderer/src/lib/source-kernel/character-map.js for the unit
// model (`units[]`, `kind` in char|escape|entity|atom|linebreak, boundary
// convention "front unit's end") — `code-map.js`'s `buildCodeMap` returns
// the same shape (`kind` in char|linebreak only, code has no escapes/
// entities).
import { buildSyntaxIndex, buildCharacterMap, buildCodeMap } from '../lib/source-kernel/index.js'
import { buildTableCellMaps } from '../lib/source-kernel/table-map.js'

// PM block-level node name -> the mdast block type(s) it may structurally
// pair with. Both sides are walked in document order (pre-order, containers
// included so they occupy a slot in the sequence just like leaves) and
// zipped index-for-index — see flattenPm/flattenMd below.
const PM_TO_MD = {
  // `html` (Plan 5 Task 2): preset-commonmark's own `remarkHtmlTransformer`
  // (node_modules/@milkdown/preset-commonmark/src/plugin/
  // remark-html-transformer.ts) rewrites every mdast `html` node whose parent
  // is root/blockquote/listItem into a `paragraph` WRAPPING that html node,
  // because Milkdown's `html` schema is inline-only (`atom:true,
  // group:'inline'` — node/html.ts). So on the PM side a BLOCK-level
  // `<div>x</div>` is a `paragraph` holding one inline `html` atom, never a
  // block `html` node — hence this pairing (the `image-block: ['paragraph']`
  // precedent below, mirrored). The pairing loop verifies the paragraph
  // really is a single-html-atom wrapper and forces it NON-EDITABLE (block
  // HTML is opaque prose with no character-level decode contract), so a
  // document containing a raw `<table>`/`<div>` block still maps every OTHER
  // block instead of degrading entirely.
  paragraph: ['paragraph', 'html'],
  heading: ['heading'],
  blockquote: ['blockquote'],
  bullet_list: ['list'],
  ordered_list: ['list'],
  list_item: ['listItem'],
  // `math` (Plan 5 Task 1): Crepe's latex feature rewrites the mdast `math`
  // block to `{type:'code', lang:'LaTeX'}` before the PM parse, so a
  // `$$..$$` block is a PM `code_block` with `attrs.language === 'LaTeX'`.
  // The kernel's own parse keeps it as mdast `math` (its remark chain has
  // remark-math but not Crepe's rewrite visitor) — hence this pairing. It
  // was declared here from the start but UNREACHABLE until the kernel chain
  // gained remark-math: before that, `$$\nE=mc^2\n$$` parsed to a plain
  // `paragraph`, `allowed.includes('paragraph')` was false, and the WHOLE
  // document's map was rejected. Block math pairs but is never editable —
  // see the `codeReadOnly` branch below.
  code_block: ['code', 'math'],
  table: ['table'],
  hr: ['thematicBreak'],
  // Kept for schemas that model block html as a real block-level NODE; the
  // live Crepe schema never produces one (see the `paragraph` entry above),
  // and INLINE html atoms are excluded from block pairing entirely by
  // `flattenPm`/`flattenMd`.
  html: ['html'],
  // YAML front matter (P6 Task 2). `editor-frontmatter.js` declares a
  // block-level `frontmatter` ATOM whose `parseMarkdown.match` is
  // `node.type === 'yaml'`, i.e. exactly the node `remark-frontmatter`
  // produces — and since this task the kernel's own chain mounts that same
  // plugin with the same default preset (see syntax-index.js), so both sides
  // now see ONE block here instead of PM's one against the kernel's
  // thematicBreak + setext heading. No shape guard is needed beyond the type
  // pair: `yaml` has no children, `frontmatter` is an atom, and the atom makes
  // `editable` false below, so the pair is served with `charMap: null` — a
  // read-only leaf that can never resolve an offset, let alone write one.
  frontmatter: ['yaml'],
  // Crepe's `@milkdown/components` image-block: a standalone (own-line) image
  // is rendered as a block-level `image-block` ATOM, not a paragraph wrapping
  // an inline image — its remark plugin REPLACES any mdast paragraph whose
  // single child is an `image` with a custom `image-block` mdast node before
  // the PM parse. The kernel's own parse (buildSyntaxIndex) runs WITHOUT that
  // plugin, so on the kernel side the block is still the plain mdast
  // `paragraph > image` wrapper — hence this pairing. The pairing loop below
  // additionally verifies the paragraph really is a single-image wrapper
  // (fail-closed), and the pair is never editable (`isTextblock` is false for
  // an atom, so it can't claim a charMap): image editing is a later phase.
  'image-block': ['paragraph']
}

const MD_BLOCK_TYPES = new Set(Object.values(PM_TO_MD).flat())

// PM leaf types that structurally pair (so a doc CONTAINING one still gets
// a map for its other blocks) but are never treated as character-mappable
// content, regardless of what buildCharacterMap would report:
//  - `html`: block HTML is opaque prose (may contain raw markdown-like
//    bytes with no decode contract) — kept non-editable even on schemas
//    where it's declared as a textblock rather than an atom.
// `code_block` used to be in this set too (mdast `code`/`math` has no
// `.children` — its text lives in `.value` — so `buildCharacterMap`'s
// `collectUnits`, which only reads `.children`, saw zero children and
// returned an EMPTY-but-not-null units array for any code block, a false
// "proof" of alignment). Plan 3 Task 3 gives it a real mapper instead
// (`buildCodeMap`, prefix-aware for blockquote/list-indented fences) —
// see the `pmType === 'code_block'` branch below, which still forces
// non-editable for the two cases `buildCodeMap` genuinely can't/shouldn't
// cover: pairing with mdast `math`, and Crepe's preview-only languages.
const NON_EDITABLE_LEAF_TYPES = new Set(['html'])

// `code_block` languages Crepe renders as a diagram/formula PREVIEW instead
// of literal text (editor-crepe-setup.js's codeBlockConfig.renderPreview) —
// their PM textContent is the SOURCE the preview is generated from, but
// editing that source through the kernel's character-level machinery isn't
// wired up (a later Plan 3 task). Matched case-insensitively against the PM
// node's own `attrs.language` (Milkdown's codeBlockSchema attr).
// Exported for reuse, but note (correction, Plan 5 Task 1 — the previous
// wording here was stale): NOTHING outside this module currently reads it.
// editor-kernel-gateway.js used to refuse a language switch OUT of
// mermaid/latex, but that guard was lifted (final-review fix, 2026-08-16:
// `commitCodeLanguage` resolves such a switch via the pair's `mdBlock` fence
// start when `charMap` is null) and the gateway no longer imports this set —
// only a stale comment there still names it. Once a
// switch commits, `editor-kernel-mode.js` unconditionally rebinds the
// projection map, so a block newly switched AWAY from one of these
// languages gets a real `charMap` (editable) and a block newly switched
// INTO one loses it (preview-only) — always freshly evaluated, never stale.
export const READONLY_CODE_LANGUAGES = new Set(['mermaid', 'latex'])

// PM/mdast types whose subtree is intentionally NOT walked into by the
// DOCUMENT-level zip: `table` occupies exactly ONE slot on both sides. A PM
// table has four container levels (table / row / cell / paragraph) where
// mdast has three (table / tableRow / tableCell -> phrasing directly), so
// descending into both subtrees here would zip a PM `paragraph` against no
// mdast counterpart and null the WHOLE document.
//
// Since Plan 5 Task 4 that no longer means "a table is one opaque leaf": the
// interior is zipped SEPARATELY by `buildTableCellMaps`
// (lib/source-kernel/table-map.js), which consumes the extra PM level itself
// and hands back one editable pair per CELL. Keeping the table opaque at THIS
// level is what makes that safe — a disagreement inside a table (a ragged
// row, a PM shape the sub-zip doesn't recognize) can never shift the
// document-level correspondence, because the document-level zip still saw one
// slot on each side; the table simply degrades back to the single opaque pair
// this constant originally described. See the INVARIANT block at the top of
// this file: table interiors are outside it by construction.
const OPAQUE_TYPES = new Set(['table'])

// Walk every descendant of the PM doc, collecting the ones whose type name
// is a recognized structural pair (containers AND textblocks) in document
// order. `descendants` is guaranteed pre-order (parent before children,
// siblings in order), matching the mdast walk below. Opaque types are
// recorded but their subtree is skipped (`return false`).
//
// INLINE nodes never participate in BLOCK pairing (Plan 5 Task 2). Milkdown's
// `html` node is inline (`atom:true, group:'inline'`), so before this guard a
// paragraph containing `<span>x</span>` pushed TWO entries (the paragraph and
// the html atom) while the kernel's mdast pushed the paragraph plus its two
// separate `<span>`/`</span>` html nodes — a 2-vs-3 zip that rejected the
// WHOLE document's map, i.e. any document with inline HTML degraded entirely.
// Inline html is now the paragraph's charMap business (one coalesced atom
// unit, see character-map.js + lib/source-kernel/inline-html.js), never a
// block slot. `isInline` covers text/image/math_inline/html alike and skipping
// their (non-existent) subtrees is free.
function flattenPm(pmDoc) {
  const result = []
  pmDoc.descendants((node, pos) => {
    if (node.isInline) return false
    if (PM_TO_MD[node.type.name]) {
      result.push({ node, pos })
      if (OPAQUE_TYPES.has(node.type.name)) return false
    }
    return true
  })
  return result
}

// mdast types whose children are PHRASING content only (Plan 5 Task 2): the
// block walk must stop here, exactly as `flattenPm` stops at PM's inline
// boundary. `html` is the only phrasing type that also appears in
// MD_BLOCK_TYPES, so this changes nothing else — but without it every INLINE
// html node was recorded as a block pair. `tableCell` needs no entry: `table`
// is opaque and never descended into.
const MD_PHRASING_PARENTS = new Set(['paragraph', 'heading'])

// Walk the mdast tree the kernel parsed, collecting the same recognized
// structural set, same pre-order convention (a node is recorded before its
// children are visited) so index i on both sides refers to "the i-th
// structural node encountered in document order". Opaque types are
// recorded but their children are not walked.
//
// Empty list items ('- \n', the exact byte shape splitListItem's Enter
// leaves behind before the user types the new item's text): mdast gives the
// `listItem` ZERO children, but ProseMirror's parse goes through
// `createAndFill`, which fills the schema-required `paragraph` in — so the
// PM side always has one more node than the mdast side for every empty
// item. Synthesize the missing wrapper here (a marker object, not a fake
// mdast node) so the zip stays aligned; the pairing loop below turns it
// into a virtual pair anchored at the item's contentStart (right after the
// marker + spacing), which is exactly where typed text must land in the raw
// source ('- ' + typed -> '- x').
function flattenMd(tree, index) {
  const result = []
  const walk = (node) => {
    if (MD_BLOCK_TYPES.has(node.type)) {
      result.push(node)
      if (OPAQUE_TYPES.has(node.type)) return
      if (MD_PHRASING_PARENTS.has(node.type)) return
      if (node.type === 'listItem' && (!node.children || node.children.length === 0)) {
        const start = node.position?.start?.offset
        const item = Number.isInteger(start) ? index.listItemAt(start) : null
        result.push({ syntheticEmptyItemParagraph: true, item })
        return
      }
    }
    for (const child of node.children || []) walk(child)
  }
  for (const child of tree.children || []) walk(child)
  return result
}

// charMap-shaped mapping for a virtual (PM-only) empty paragraph: exactly
// one boundary, visible offset 0 <-> `rawOffset`. Same public contract as
// buildCharacterMap's zero-unit result, so pmPosToRaw/rawToPmPos consume it
// through the identical code path.
const virtualCharMap = (rawOffset) => {
  const visibleToRaw = (vis) => (vis === 0 ? rawOffset : null)
  return {
    units: [],
    visibleLength: 0,
    visibleToRaw,
    // Single-point map (no units, no gap possible) — plain alias, kept for
    // interface uniformity with buildCharacterMap/buildCodeMap. See
    // character-map.js's ADR comment on `buildCharacterMap`.
    rawStartForVisible: visibleToRaw,
    rawRangeForVisibleRange: (visFrom, visTo) => (
      visFrom === 0 && visTo === 0 ? { from: rawOffset, to: rawOffset } : null
    )
  }
}

// The separator bytes a plain-text insert at the very end of the document
// needs BEFORE the typed text so the reparse yields a new paragraph instead
// of a lazy continuation line of the final list/blockquote ('- item\n' +
// '甲' would parse as '- item 甲' — one item; '- item\n' + '\n甲' parses as
// [list, paragraph]). Rule: the raw text must end with a BLANK LINE (or be
// empty) before the typed text starts:
//   '- item\n'   -> one more terminator  -> ending
//   '- item'     -> two                  -> ending + ending
//   '- item\n\n' -> already blank-line-terminated -> ''
//   '' / '\n'    -> nothing before the text -> ''
// `ending` is the document's dominant line ending, so CRLF sources get
// '\r\n' separators, never a mixed-ending file.
const trailingInsertPrefix = (markdown, ending) => {
  let rest = markdown
  if (rest.endsWith('\r\n')) rest = rest.slice(0, -2)
  else if (rest.endsWith('\n') || rest.endsWith('\r')) rest = rest.slice(0, -1)
  else return markdown === '' ? '' : ending + ending
  if (rest === '' || rest.endsWith('\n') || rest.endsWith('\r')) return ''
  return ending
}

// Reconstruct a raw -> visible-offset lookup for one block's charMap, by
// replaying the exact same forward accumulation buildCharacterMap uses to
// build `units[]` into its (private) boundaries map — buildCharacterMap
// only exposes the forward direction (`visibleToRaw`), so the inverse has
// to be re-derived from the public `units[]` contract, not text search.
// Endpoint cross-check for a pair about to be SERVED (P5-2.5 review finding;
// see the INVARIANT block at the top of this file). The count/type/shape
// guards prove the two sequences are aligned; the size check proves this
// block's two counts agree. Neither can tell a correctly-zipped pair from a
// mis-zipped one whose blocks happen to have the same type and the same
// visible length — and this module deliberately does no text search, so
// nothing else would notice either. Comparing ONE character at each end is
// the cheapest possible content evidence: O(1) per block, and it turns the
// ordinary mis-zip (neighbouring blocks with different text) from "served
// with wrong offsets" into "degraded, read-only".
//
// It is applied ONLY where the decode is the IDENTITY, so it can never
// degrade a legitimately-correct block:
//   - `char` units carry exactly their own raw bytes (`rawEnd - rawStart ===
//     width`, see character-map.js/code-map.js), so the raw slice IS the
//     visible text there;
//   - `escape` (`\*` -> `*`), `entity` (`&amp;` -> `&`), `atom` (image /
//     inline math / inline html — no PM character at all) and `linebreak`
//     (whose raw span can include a blockquote/list line prefix) units are
//     SKIPPED, never guessed at;
//   - a zero-unit charMap (empty paragraph, empty code fence) has no
//     endpoints and always passes.
// `textContent` is the PM node's own text (atoms contribute nothing to it,
// which is why an atom endpoint is skipped rather than compared).
function blockEndpointsAgree(markdown, pmNode, charMap) {
  const units = charMap?.units
  if (!Array.isArray(units) || units.length === 0) return true
  let text
  try {
    text = pmNode.textContent
  } catch {
    return true
  }
  if (typeof text !== 'string') return true
  const first = units[0]
  if (first.kind === 'char') {
    const raw = markdown.slice(first.rawStart, first.rawEnd)
    if (raw && text.slice(0, raw.length) !== raw) return false
  }
  const last = units[units.length - 1]
  if (last.kind === 'char') {
    const raw = markdown.slice(last.rawStart, last.rawEnd)
    if (raw && text.slice(text.length - raw.length) !== raw) return false
  }
  return true
}

function walkUnits(charMap, onUnit) {
  let vis = 0
  for (const unit of charMap.units) {
    onUnit(unit, vis)
    vis += unit.width
  }
  return vis
}

export function buildProjectionMap(markdown, pmDoc, options = {}) {
  if (typeof markdown !== 'string' || !pmDoc || typeof pmDoc.descendants !== 'function') return null

  const index = buildSyntaxIndex(markdown)
  const pmBlocks = flattenPm(pmDoc)
  const mdBlocks = flattenMd(index.tree, index)
  // Split-block placeholder(s) the kernel-mode controller itself just
  // created (editor-kernel-mode.js `ensureSplitPlaceholder` /
  // `extendTrailingPlaceholder`): empty PM paragraphs at exactly the vouched
  // `pmPos`s, representing a caret parked on a blank line the reparse cannot
  // show (CommonMark collapses any run of blank lines to one block boundary,
  // so an Enter at the end of a paragraph — or another Enter inside the
  // resulting placeholder — writes real bytes that parse back to NO new
  // block, regardless of how many). The controller vouches for each
  // explicitly per map build (`pendingPlaceholders`, a list — one entry per
  // Enter in the trailing-blank chain; a single-object `pendingPlaceholder`
  // is still accepted for the common one-placeholder case). This is NOT a
  // general mid-document tolerance — without the option, an extra mid-doc
  // empty paragraph still rejects the whole map below, and every vouched
  // entry MUST be consumed by a real PM node or the whole map rejects too
  // (stale bookkeeping is a caller bug, not a best-effort map).
  const pendingIsChain = Array.isArray(options.pendingPlaceholders)
  const pendingList = pendingIsChain
    ? options.pendingPlaceholders.filter((p) => Number.isFinite(p?.pmPos) && Number.isFinite(p?.rawOffset))
    : options.pendingPlaceholder &&
        Number.isFinite(options.pendingPlaceholder.pmPos) &&
        Number.isFinite(options.pendingPlaceholder.rawOffset)
      ? [options.pendingPlaceholder]
      : []
  // Chain-only self-check (review finding, Task 2 plan 3): the `pendingPlaceholders`
  // LIST form exists for exactly one caller shape — extendTrailingPlaceholder's
  // trailing-blank chain, where every entry's rawOffset must sit at/after the
  // TRUE end of the document's real content (enter.js's own `isTrailingGap`
  // floor). Without this, a voucher could sit BEFORE real trailing content
  // that keeps flowing normally elsewhere in the pm/md sequences — the per-item
  // "empty paragraph" check alone can't catch that, because an empty PM node
  // with no mdast counterpart looks identical whether it is genuinely trailing
  // or a mid-document placeholder. The single-object `pendingPlaceholder` form
  // is NOT covered by this floor: that shape is `ensureSplitPlaceholder`'s own,
  // long-standing "Enter at the end of a paragraph that still has more content
  // AFTER it elsewhere in the document" case (see Case 13 in
  // scripts/test-kernel-projection-map.mjs) — a legitimately mid-document
  // placeholder, not a trailing one, and must keep working unchanged.
  if (pendingIsChain && pendingList.length) {
    const topLevel = index.tree.children || []
    const trailingFloor = topLevel.length
      ? topLevel[topLevel.length - 1].position?.end?.offset
      : 0
    if (!Number.isFinite(trailingFloor) || pendingList.some((p) => p.rawOffset < trailingFloor)) {
      return null
    }
  }
  const matchedPending = new Set()

  const blockPairs = []
  let mdIndex = 0
  for (let pmIndex = 0; pmIndex < pmBlocks.length; pmIndex += 1) {
    const pm = pmBlocks[pmIndex]
    const pmType = pm.node.type.name

    // Controller-vouched split placeholder: pair it as a virtual editable
    // block anchored at the blank-line raw offset the split's caret sits on.
    // Anything other than an empty paragraph at that exact position means
    // the caller's bookkeeping is stale — reject the whole map (the caller
    // fails closed and removes the placeholder again).
    const pendingMatch = pendingList.find((p) => p.pmPos === pm.pos)
    if (pendingMatch) {
      if (pmType !== 'paragraph' || pm.node.content.size !== 0) return null
      matchedPending.add(pendingMatch)
      blockPairs.push({
        mdBlock: null,
        pmNode: pm.node,
        pmPos: pm.pos,
        charMap: virtualCharMap(pendingMatch.rawOffset),
        virtual: true,
        insertPrefix: ''
      })
      continue
    }

    if (mdIndex >= mdBlocks.length) {
      // Crepe ships `@milkdown/plugin-trailing` UNCONDITIONALLY: its
      // appendTransaction inserts an EMPTY `paragraph` after the document's
      // last top-level child whenever that child's type is anything other
      // than `heading`/`paragraph` — a "there's always somewhere to click
      // below the content" convenience with NO markdown-source counterpart.
      // Left unhandled, this one synthetic node made EVERY document ending
      // in a list/table/code-block/blockquote/thematic-break/html block fail
      // the length check and reject the WHOLE map, silently degrading kernel
      // mode to full legacy for a huge share of real documents (Task 11's
      // Bug 2). Tolerate EXACTLY ONE such node: it must be the LAST pm block
      // AND a top-level doc child (its end reaches the very end of the whole
      // document) AND empty. It pairs as a virtual EDITABLE block whose only
      // boundary maps to the raw document end (markdown.length); a
      // plain-text insert there must carry `insertPrefix` (see
      // trailingInsertPrefix above) so the typed text becomes a new
      // paragraph rather than a lazy continuation of the final block. Any
      // OTHER surplus (two extra paragraphs, a non-paragraph, a non-empty or
      // non-final paragraph) still rejects the whole map — fail-closed.
      const isLast = pmIndex === pmBlocks.length - 1
      const isTrailingPlaceholder = isLast && pmType === 'paragraph' &&
        pm.node.content.size === 0 &&
        pm.pos + pm.node.nodeSize === pmDoc.content.size
      if (!isTrailingPlaceholder) return null
      blockPairs.push({
        mdBlock: null,
        pmNode: pm.node,
        pmPos: pm.pos,
        charMap: virtualCharMap(markdown.length),
        virtual: true,
        insertPrefix: trailingInsertPrefix(markdown, index.dominantEnding)
      })
      continue
    }

    const md = mdBlocks[mdIndex]
    mdIndex += 1

    // Synthetic wrapper for an empty list item's PM auto-filled paragraph
    // (see flattenMd): editable only when the item record proves a real
    // marker with spacing ('- ' — typing at contentStart yields '- x', a
    // valid item). A bare marker with no spacing ('-') would turn typed text
    // into '-x', which is not a list item at all — that pairing stays
    // non-editable (typing there is refused, fail-closed).
    if (md.syntheticEmptyItemParagraph) {
      if (pmType !== 'paragraph' || pm.node.content.size !== 0) return null
      const item = md.item
      const editable = !!item && item.empty &&
        Number.isFinite(item.contentStart) && item.spacing !== ''
      blockPairs.push({
        mdBlock: null,
        pmNode: pm.node,
        pmPos: pm.pos,
        charMap: editable ? virtualCharMap(item.contentStart) : null,
        virtual: editable,
        insertPrefix: editable ? '' : undefined
      })
      continue
    }

    const allowed = PM_TO_MD[pmType] || []
    if (!allowed.includes(md.type)) return null

    // image-block only ever replaces a paragraph whose SINGLE child is an
    // `image` (its remark plugin's exact condition) — pairing it against any
    // other paragraph shape means the two trees have diverged structurally.
    if (pmType === 'image-block') {
      const children = md.children || []
      if (children.length !== 1 || children[0].type !== 'image') return null
    }

    // BLOCK-level mdast `html` paired with its PM `paragraph` wrapper (Plan 5
    // Task 2, see the PM_TO_MD `paragraph` entry): accept it only in the exact
    // shape `remarkHtmlTransformer` produces — a paragraph whose SINGLE child
    // is the inline `html` atom — and never as an editable surface. mdast
    // `html` has no `children` (its text is `.value`), so letting it fall
    // through to the generic branch below would hand `buildCharacterMap` a
    // zero-child node and get an EMPTY units array back: a false "proof" of
    // alignment against a PM paragraph whose content.size is 1 (the atom).
    if (md.type === 'html' && pmType !== 'html') {
      const content = pm.node.content
      const only = content.childCount === 1 ? content.firstChild : null
      if (!only || only.type.name !== 'html') return null
      blockPairs.push({ mdBlock: md, pmNode: pm.node, pmPos: pm.pos, charMap: null })
      continue
    }

    // `bullet_list`/`ordered_list` both structurally pair with mdast
    // `list`, but the ordered flag itself is part of the structure (a
    // marker-numbering scheme, not decoration) — a `bullet_list` PM node
    // over an `ordered: true` mdast list (or vice versa) must reject the
    // whole map, not silently pass because the block-type strings matched.
    if (md.type === 'list') {
      const ordered = !!md.ordered
      if (pmType === 'ordered_list' && !ordered) return null
      if (pmType === 'bullet_list' && ordered) return null
    }

    // GFM table (Plan 5 Task 4). The document-level zip above consumed the
    // table as ONE slot on each side (see OPAQUE_TYPES); its INTERIOR is
    // zipped here by `buildTableCellMaps`, which owns the 4-level PM vs
    // 3-level mdast mismatch and returns one pair per CELL — the PM
    // `table_cell > paragraph` wrapper paired with the mdast `tableCell`,
    // whose `|` delimiters and padding spaces are gap bytes.
    //
    // Each cell pair then goes through the SAME two content guards every
    // other textblock pair does (PM's own content size vs the kernel's
    // decoded visible length, then the endpoint cross-check), so a cell is
    // served only on the evidence a paragraph would need.
    //
    // Failure is layered exactly like everywhere else in this file:
    //   * the sub-zip returning null is a STRUCTURAL statement about this one
    //     table (ragged rows, a PM shape it doesn't recognize, a delimiter
    //     row it can't recover) -> the table degrades to the single opaque
    //     non-editable pair it was before this task, and the rest of the
    //     document keeps its map;
    //   * one cell failing its own content proof degrades only THAT cell
    //     (charMap null), leaving its siblings editable.
    // Note the table itself gets NO pair when its cells map: the cell pairs
    // cover its editable surface, and a whole-table pair sitting in front of
    // them would shadow them in `degradedPairAt`'s "which block is read-only"
    // scan (editor-kernel-mode.js).
    if (pmType === 'table') {
      const table = buildTableCellMaps(markdown, md, pm.node, pm.pos)
      if (!table) {
        blockPairs.push({ mdBlock: md, pmNode: pm.node, pmPos: pm.pos, charMap: null })
        continue
      }
      for (const cell of table.cells) {
        let cellMap = cell.charMap
        if (cellMap && cell.pmNode.content.size !== cellMap.visibleLength) cellMap = null
        if (cellMap && !blockEndpointsAgree(markdown, cell.pmNode, cellMap)) cellMap = null
        blockPairs.push({
          mdBlock: cell.mdBlock,
          pmNode: cell.pmNode,
          pmPos: cell.pmPos,
          charMap: cellMap,
          tableCell: true
        })
      }
      continue
    }

    const editable = pm.node.isTextblock &&
      !NON_EDITABLE_LEAF_TYPES.has(pmType) &&
      !OPAQUE_TYPES.has(pmType)
    let charMap = null
    if (editable && pmType === 'code_block') {
      // mdast `math` shares the PM `code_block` type but stays NON-EDITABLE
      // (Plan 5 Task 1 keeps this deliberately; the task's goal was healing
      // the whole-document degradation, not editing TeX). Two independent
      // reasons, either of which alone is sufficient:
      //  1. the PM node's `attrs.language` for a `$$..$$` block is always
      //     'LaTeX' (Crepe's remarkMathBlock sets it), which is already in
      //     READONLY_CODE_LANGUAGES — Crepe renders these as a preview, so
      //     the block's text is not an ordinary editing surface. Lifting the
      //     math case alone would change nothing without ALSO removing
      //     'latex' from that set, which would equally unblock a literal
      //     ```latex fence — a different domain (preview-only code blocks),
      //     decided by the same set on THIS module's own authority. (The
      //     gateway does NOT consult this set: its `extractLanguageStep`
      //     refusal was lifted 2026-08-16 and only a stale comment there
      //     still names it — verified, there is no import.)
      //  2. `commitCodeLanguage` (commands/code-language.js) resolves a
      //     language switch through the block's FENCE bytes and refuses any
      //     block whose kernel type isn't `code` — a `$$` delimiter pair has
      //     no place to spell a language at all. Keeping this branch force-
      //     read-only also covers the transient where a PM code_block's
      //     language has been switched away from 'LaTeX' while the raw
      //     source is still spelled `$$..$$`.
      // (Measured, for the record: `buildCodeMap` DOES map an mdast `math`
      // node byte-exactly for the plain and `> `-quoted forms — visibleLength
      // 6 / linePrefix '' and '> ' for `$$\nE=mc^2\n$$\n` — and fails closed
      // on the list-indented form. So the remaining blocker is the language/
      // command semantics above, not the character mapping.)
      // Otherwise, a language Crepe renders as a preview-only
      // diagram/formula (mermaid/latex, checked case-insensitively on the PM
      // node's own `attrs.language`) also stays non-editable, regardless of
      // what buildCodeMap could prove.
      const language = String(pm.node.attrs?.language || '').toLowerCase()
      const codeReadOnly = md.type === 'math' || READONLY_CODE_LANGUAGES.has(language)
      if (!codeReadOnly) {
        charMap = buildCodeMap(markdown, md)
        // `buildCodeMap` fails closed (null) for a content shape it can't
        // prove byte-for-byte, most commonly a blockquote/list-indented
        // fence whose per-line prefix a BLANK content line can't reproduce
        // (e.g. a quoted fence's blank line written as a bare '>' instead of
        // '> ' — see code-map.js's own `text.startsWith(prefix, line.start)`
        // guard). That is a property of THIS ONE block's content, not a
        // structural PM/mdast disagreement — degrade only this pair to
        // non-editable (final-review fix, 2026-08-16; `charMap` stays `null`,
        // same contract as mermaid/latex/math above) instead of rejecting
        // the WHOLE map, so the rest of the document (including any OTHER
        // code block) stays fully mappable. The check below only runs when
        // `buildCodeMap` DID prove a charMap, and since P5-2.5 it degrades
        // the same way (see the generic branch's own P5-2.5 comment): a
        // size disagreement is a statement about THIS block's content, and
        // every invariant that proves the two trees are ALIGNED (counts,
        // types, shapes) stays whole-map fail-closed.
        //
        // Same structural (not textual) consistency check as the generic
        // path below: PM's own content size must equal the kernel's decoded
        // visible length. Milkdown's own code_block parseMarkdown runner
        // (`state.addText(node.value)`) inserts the mdast `.value` string
        // into the PM text child completely verbatim, so `content.size`
        // (== textContent.length for a text-only content model, no atoms)
        // equals `value.length` exactly. This holds for ANY line-ending
        // style, including CRLF: remark does NOT normalize a code node's
        // (or a prose text node's) line endings — verified against the real
        // parser — and `buildCodeMap` matches that by construction, every
        // unit it produces has width 1 and consumes exactly one `value` JS
        // char (see code-map.js's own header comment), so `visibleLength`
        // always equals `value.length` too. No separate empty-textblock
        // guard is needed here (unlike the generic path below):
        // buildCodeMap's own empty-value case already anchors to the real
        // content start (right after the open fence line's ending), never
        // to the block's own marker position.
        if (charMap && pm.node.content.size !== charMap.visibleLength) charMap = null
        // Endpoint cross-check (see `blockEndpointsAgree` + the INVARIANT
        // block at the top of this file): a code block's units are
        // char/linebreak only, so this compares the fence content's first and
        // last literal byte against PM's own code text.
        if (charMap && !blockEndpointsAgree(markdown, pm.node, charMap)) charMap = null
        // ADR (2026-08-17) — the former "non-'\n' lineEnding => non-editable"
        // gate is REMOVED here. It never described a defect in THIS module's
        // math: the identity asserted right above (`content.size ===
        // visibleLength`) holds byte-for-byte for '\r\n' and lone-'\r'
        // blocks too, because remark keeps a `code` node's line endings
        // verbatim and `buildCodeMap` emits one width-1 unit per `value`
        // char (a '\r' is its own `char` unit, the following '\n' the
        // `linebreak` unit that also spans the next line's prefix). Measured
        // for '```js\r\nlet a = 1\r\nlet b = 2\r\n```\r\n': content.size ===
        // visibleLength === 20; for the '> '-quoted CRLF fence: 4.
        //
        // The gate existed because the VENDORED `@milkdown/components`
        // CodeMirrorBlock node view applied CM6 coordinates directly as PM
        // offsets while CM6's `Text` model structurally DISCARDS '\r' — so
        // every CM position past a block's first line break undercounted the
        // dropped bytes and a one-char edit could silently commit to the
        // wrong raw range. That defect is fixed at its source by
        // `editor-codeblock-crlf.js` (prototype patch: a bijective CM<->PM
        // position map per call, inserted breaks spelled with the block's
        // dominant ending, `update()` diffing on LF-normalized text,
        // `setSelection` mapped both ways), locked by
        // `scripts/test-codeblock-crlf-ui.mjs`. With the bridge honest, the
        // whole reason for the narrowing is gone.
        //
        // What replaces it is a NARROWER, byte-provable guard one layer
        // down, in `editor-kernel-gateway.js` `commitPlainText`: an inserted
        // line break must ALREADY be spelled exactly as this block's raw
        // source spells it (`charMap.lineEnding`), and the gateway only adds
        // the per-line prefix — it never re-spells a break. That refuses the
        // one residual shape the bridge cannot serve (a code block whose
        // CURRENT text holds no '\r' at all — a single-line or empty fence
        // in a CRLF document — where the bridge's own `hasCarriageReturn`
        // fast path delegates to the vendor and an inserted break arrives as
        // a bare '\n'), while leaving every other CRLF edit (typing,
        // deleting, joining lines, adding lines in a multi-line CRLF fence)
        // fully editable. See that function's comment for the trace.
      }
    } else if (editable) {
      // Editable (textblock) pairs MUST carry a proof of lossless character
      // alignment. No charMap (the kernel couldn't prove this block's units)
      // — or a charMap whose decoded visible length disagrees with PM's own
      // content size — means THIS BLOCK is unprovable, so it degrades to a
      // non-editable leaf (`charMap = null`, exactly the posture
      // mermaid/latex/math/table/image-block/block-HTML pairs already have)
      // and the rest of the document keeps its map.
      //
      // P5-2.5 — why per-BLOCK, not per-DOCUMENT (this used to `return null`):
      //  * Both conditions are statements about ONE block's CONTENT, not
      //    about the pairing. The pairing itself is positional: `flattenPm`
      //    and `flattenMd` walk their trees pre-order and the loop zips them
      //    index-for-index, so pair N+1's raw offsets come from
      //    `mdBlocks[N+1].position` — the kernel's own parse of the raw text
      //    — and cannot be shifted by anything that happens inside pair N.
      //  * A genuinely mis-ALIGNED zip (the editor chain merging or splitting
      //    a block relative to the kernel's parse) always changes the block
      //    COUNT, and every count/shape invariant below and above stays
      //    whole-map fail-closed: the type-pair check, the ordered-flag
      //    check, the image-block and block-HTML shape guards, the
      //    surplus-PM-node guard, the `mdIndex !== mdBlocks.length` check,
      //    and the placeholder-consumption check. So an alignment failure is
      //    still the loud, document-wide signal it always was; only a
      //    localized content disagreement degrades quietly.
      //  * Serving a null charMap for a textblock is not a new contract:
      //    `buildCodeMap`'s own failure (above) and the empty-textblock guard
      //    (below) already produce exactly that, and every consumer resolves
      //    a position through `pairForContentPos`/`rawToPmPos`, which SKIP
      //    charMap-less pairs and answer `null` — i.e. the block is read-only
      //    and every write into it fails closed (see the consumer audit in
      //    the P5-2.5 report).
      // The one thing this deliberately trades away: a document whose single
      // unprovable block used to force the WHOLE tab back to legacy (where
      // that block was editable) now stays in kernel mode with that block
      // read-only. That is the intended direction — legacy is the mode with
      // the fidelity bug family, and every other block becomes source-first.
      charMap = buildCharacterMap(markdown, md)
      // Structural (not textual) consistency check: PM's own content size
      // (sum of each child's nodeSize — text nodes contribute their char
      // length, atom nodes contribute 1) must equal the kernel's decoded
      // visible length. This is a numeric comparison of two independently
      // derived structural counts, not a text/string match.
      if (charMap && pm.node.content.size !== charMap.visibleLength) charMap = null
      // Endpoint cross-check: the last content evidence before this pair's
      // offsets are served to writers (see `blockEndpointsAgree` + the
      // INVARIANT block at the top of this file).
      if (charMap && !blockEndpointsAgree(markdown, pm.node, charMap)) charMap = null
      // Empty-textblock guard: a zero-unit charMap's ONLY boundary is
      // `boundaries[0] = blockNode.position.start.offset` (buildCharacterMap's
      // fallback when there's no first unit to anchor to) — i.e. literally
      // the mdast block's own start offset. For `paragraph` that fallback
      // is genuinely the content start: a paragraph carries no leading
      // marker syntax, so its own start offset IS where content would
      // begin. For any other textblock type (e.g. an empty ATX heading
      // `'#\n'`) the block's start offset is the MARKER's position (the
      // `#`), not the content start — serving that as a boundary would be
      // a silent wrong mapping, so treat it as non-editable instead. (This
      // guard is the OLDEST per-block degradation in this file — P5-2.5
      // generalized exactly this posture to the two conditions above.)
      if (charMap && charMap.units.length === 0 && md.type !== 'paragraph') charMap = null
    }
    blockPairs.push({ mdBlock: md, pmNode: pm.node, pmPos: pm.pos, charMap })
  }
  // Every mdast block must have been consumed — a PM side that ran out first
  // (e.g. a PM node type flattenPm doesn't recognize while mdast still has
  // its counterpart) rejects the whole map, exactly like the old length
  // check did.
  if (mdIndex !== mdBlocks.length) return null
  // Every vouched placeholder must have been consumed by a real PM node at
  // its exact pmPos — an entry that never matched means the caller's
  // bookkeeping (a stale pmPos from a prior revision, a placeholder the view
  // no longer has) has drifted from reality, and that must reject the WHOLE
  // map rather than silently map only the placeholders that happened to
  // still line up.
  if (matchedPending.size !== pendingList.length) return null

  // pmPos -> raw: locate the textblock pair whose content range
  // [contentPos, contentPos + visibleLength] contains pmPos (both ends
  // inclusive — the end boundary is the most common caret spot, e.g. end
  // of a paragraph), then convert the in-block PM offset straight to a
  // charMap visible offset. PM atoms count 1 (matching charMap atom units,
  // width 1) and PM text chars count 1-per-char (matching char/escape/
  // entity/linebreak unit widths, which are always the *decoded* width) —
  // so the in-block PM offset IS the charMap visible offset directly, no
  // separate PM-side walk needed (verified by the content.size check above,
  // which proves the two counts agree for this block).
  // Locates the editable block pair whose CONTENT range [contentPos,
  // contentPos + visibleLength] contains `pmPos` — the shared search
  // `pmPosToRaw` itself uses, factored out (Plan 3 Task 4) so a caller that
  // needs the PAIR itself (not just the raw offset) can get it without
  // re-walking `blockPairs` with a hand-rolled copy of this exact range
  // check. `commitPlainText`'s code-block newline expansion is the first
  // such caller: it needs the pair's `charMap.linePrefix`/`lineEnding`, not
  // just where one `\n` maps to.
  const pairForContentPos = (pmPos) => {
    for (const pair of blockPairs) {
      if (!pair.charMap) continue
      const contentPos = pair.pmPos + 1
      const size = pair.charMap.visibleLength
      if (pmPos < contentPos || pmPos > contentPos + size) continue
      return pair
    }
    return null
  }

  const pmPosToRaw = (pmPos) => {
    const pair = pairForContentPos(pmPos)
    if (!pair) return null
    const contentPos = pair.pmPos + 1
    return pair.charMap.visibleToRaw(pmPos - contentPos)
  }

  // Start-role counterpart of `pmPosToRaw`, for a caller resolving the LEFT
  // edge of a genuine (non-empty) selection about to be replaced/deleted —
  // see character-map.js's ADR comment on `buildCharacterMap` for why a
  // range's `from` needs the gap-aware resolver (`rawStartForVisible`) while
  // a bare/single PM position (a caret, or a range's `to`) keeps using
  // `pmPosToRaw`/`visibleToRaw` unchanged. Every charMap-shaped object this
  // module consumes (buildCharacterMap, buildCodeMap, `virtualCharMap`
  // above) exposes `rawStartForVisible`, so no fallback branch is needed
  // here.
  const pmPosToRawStart = (pmPos) => {
    const pair = pairForContentPos(pmPos)
    if (!pair) return null
    const contentPos = pair.pmPos + 1
    return pair.charMap.rawStartForVisible(pmPos - contentPos)
  }

  // Insert-role counterpart (P4-3.5, Fix B): resolves a PLAIN zero-width
  // insert's landing point through the charMap's marker-gap-neutral resolver
  // (`rawNeutralInsert`, see character-map.js) so a plain char typed at a
  // mark run's boundary lands OUTSIDE the markers — matching the unmarked
  // slice the gateway proved — instead of silently extending the run.
  // charMap shapes without the resolver (buildCodeMap, virtualCharMap: no
  // inline markers exist there, no gap possible) fall back to the plain
  // boundary table, which is identical for gap-free content.
  const pmPosToRawInsert = (pmPos) => {
    const pair = pairForContentPos(pmPos)
    if (!pair) return null
    const contentPos = pair.pmPos + 1
    const { charMap } = pair
    if (typeof charMap.rawNeutralInsert === 'function') {
      return charMap.rawNeutralInsert(pmPos - contentPos)
    }
    return charMap.visibleToRaw(pmPos - contentPos)
  }

  // raw -> pmPos: locate the pair whose charMap raw range contains the
  // offset, then walk its units (front-to-back) looking for an exact
  // boundary match:
  //  - raw === unit.rawStart: the boundary right before this unit (for an
  //    atom unit this IS "the atom" -> atom:true).
  //  - raw strictly inside an atom's raw span (its multi-byte markdown
  //    syntax, e.g. inside `![a](x.png)`): there's no PM position "inside"
  //    an atom, so any interior offset snaps to the atom's own boundary
  //    (atom:true) rather than failing — the atom is indivisible, but it IS
  //    a valid target.
  //  - raw === unit.rawEnd: the boundary right after this unit (needed to
  //    catch the very last unit's end, which has no "next unit" to catch it
  //    via rawStart).
  // Any other raw offset (mid-escape, mid-entity, or in the gap between
  // sibling blocks — list markers, task checkboxes, blank lines) has no
  // faithful PM position and returns null (fail-closed; caller decides the
  // fallback).
  const rawToPmPos = (raw) => {
    for (const pair of blockPairs) {
      if (!pair.charMap) continue
      const { charMap } = pair
      const rawMin = charMap.visibleToRaw(0)
      const rawMax = charMap.visibleToRaw(charMap.visibleLength)
      if (raw < rawMin || raw > rawMax) continue
      const contentPos = pair.pmPos + 1
      let found = null
      const finalVis = walkUnits(charMap, (unit, visBefore) => {
        if (found) return
        if (raw === unit.rawStart) {
          found = { pos: contentPos + visBefore, atom: unit.kind === 'atom' }
          return
        }
        if (unit.kind === 'atom' && raw > unit.rawStart && raw < unit.rawEnd) {
          found = { pos: contentPos + visBefore, atom: true }
          return
        }
        if (raw === unit.rawEnd) {
          found = { pos: contentPos + visBefore + unit.width, atom: false }
        }
      })
      if (found) return found
      // Zero-unit (empty) block: the only boundary is content start ===
      // content end (rawMin === rawMax === raw, already range-checked).
      if (charMap.units.length === 0 && raw === rawMin) return { pos: contentPos + finalVis, atom: false }
      return null
    }
    return null
  }

  // Writers (gateway commitPlainText, kernel-mode commitReplace) consult
  // this BEFORE the generic pmPosToRaw path: a virtual pair's raw anchor can
  // be byte-ambiguous with a real block's end (e.g. a doc without a final
  // newline, where the last item's text ends exactly at markdown.length), so
  // the virtual-block decision must be made by PM position — which is
  // unique — never by raw offset. Returns the pair's raw anchor plus the
  // separator bytes an insert there must be prefixed with ('' for split
  // placeholders and empty list items, whose separators already exist in
  // the raw bytes).
  const virtualBlockAt = (pmPos) => {
    for (const pair of blockPairs) {
      if (!pair.virtual || !pair.charMap) continue
      if (pmPos === pair.pmPos + 1) {
        return { raw: pair.charMap.visibleToRaw(0), prefix: pair.insertPrefix || '' }
      }
    }
    return null
  }

  return {
    blockPairs,
    pmPosToRaw,
    pmPosToRawStart,
    pmPosToRawInsert,
    rawToPmPos,
    virtualBlockAt,
    pairAt: pairForContentPos
  }
}
