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
//      loses a block; Case H9). Since 2026-08-22 this one has an EXPLICIT
//      pairing instead of a rejection: the html-wrapper branch consumes the
//      whole run as ONE read-only pair, gated on the PM atom's value being
//      byte-identical to the run's own concatenation (computed by the SAME
//      shared `inlineHtmlRunAt` the editor's coalescer calls) — so a merge
//      the editor did NOT perform, or performed differently, still leaves an
//      unconsumed mdast block -> `mdIndex !== mdBlocks.length` -> whole-map
//      reject, exactly as before.
//   2. ProseMirror `createAndFill` inserting the schema-required filler
//      paragraph in a list item holding a leading block (PM gains a block;
//      Case M6) -> the surplus/type guards.
//   3. `@milkdown/plugin-trailing` appending an empty final paragraph (PM
//      gains a block) -> the ONE deliberately tolerated surplus, and only as
//      an EMPTY, LAST, top-level paragraph.
//   4. `createMermaidSplitPlugin` (editor-mermaid.js) splitting one mermaid
//      `code_block` into N (PM gains N-1 NON-EMPTY blocks) -> the surplus
//      guard refuses (a non-empty code_block never qualifies as the trailing
//      placeholder). RETIRED in kernel mode (2026-08-18): the plugin is no
//      longer registered at all when `kernelMode` is on
//      (editor-crepe-setup.js), because its appendTransaction carries NODE
//      content and could therefore only ever be classified `blocked` — which
//      vetoes the WHOLE batch, the user's own keystroke included — while
//      rescanning the entire document on every change, so ONE 2-diagram
//      block refused every keystroke anywhere in the document. Legacy mode
//      keeps it unchanged.
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
// explicit pairing here or be kept out of the parse chain. Two such explicit
// pairings exist now, both read-only and both byte-gated: the merged
// root-html run (case 1 above) and the standalone-line `$$x$$` paragraph
// paired against `normalizeDisplayMath`'s code_block (see
// `isNormalizedDisplayMathPair` — a 1:1 TYPE exception, so it cannot shift
// counts at all).
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
// prefix-aware charMap via `buildCodeMap`, with NO type or language
// exceptions as of 2026-08-18: it pairs with mdast `code` AND mdast `math`
// (`$$..$$`), and a language Crepe renders as a diagram/formula PREVIEW
// (mermaid/latex) is mapped like any other. See the ADR that replaced
// `READONLY_CODE_LANGUAGES` below for why a preview is outside this module's
// subject entirely, and the `code_block` branch's own comment for what block
// math needed proven. A block `buildCodeMap` cannot prove (e.g. the
// list-indented form) still degrades to `charMap: null` per-block.
// See docs referenced by Task 1 brief:
// scripts/test-editor-source-map.mjs for the hand-built-PM-schema precedent
// and src/renderer/src/lib/source-kernel/character-map.js for the unit
// model (`units[]`, `kind` in char|escape|entity|atom|linebreak, boundary
// convention "front unit's end") — `code-map.js`'s `buildCodeMap` returns
// the same shape (`kind` in char|linebreak only, code has no escapes/
// entities).
import { buildSyntaxIndex, buildCharacterMap, buildCodeMap } from '../lib/source-kernel/index.js'
import { buildTableCellMaps } from '../lib/source-kernel/table-map.js'
import { inlineHtmlRunAt, BREAK_REWRITE_PARENTS } from '../lib/source-kernel/inline-html.js'

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
// see the `pmType === 'code_block'` branch below, which as of 2026-08-18
// forces non-editable for NOTHING: mdast `code` and mdast `math` are both
// mapped, and a block that cannot be proven degrades on that evidence alone.
const NON_EDITABLE_LEAF_TYPES = new Set(['html'])

// ==========================================================================
// ADR (2026-08-18) — `READONLY_CODE_LANGUAGES` IS GONE. READ THIS BEFORE
// REINTRODUCING A LANGUAGE-KEYED EDITABILITY GATE.
// ==========================================================================
// This module used to hold `READONLY_CODE_LANGUAGES = new Set(['mermaid',
// 'latex'])` and force `charMap: null` for any `code_block` whose
// `attrs.language` matched, on the stated grounds that "Crepe renders these
// as a preview, so the block's text is not an ordinary editing surface" —
// explicitly "regardless of what buildCodeMap could prove". That was a
// POLICY gate, not a mathematical one, and the premise it rested on is half
// true in a way that matters:
//
//   TRUE  of the PREVIEW PANEL: a rendered Mermaid diagram / KaTeX formula
//         is not the block's source text.
//   FALSE of the EDITING SURFACE, which is what a charMap actually
//         addresses.
//
// The replacement condition, proven rather than assumed (each half probed
// against the vendored sources on 2026-08-18):
//
//  P1. THIS MODULE'S PROOFS NEVER READ THE DOM. All three are statements
//      about the raw string, the kernel's own mdast, and the ProseMirror
//      NODE: `buildCodeMap` matches every unit byte-for-byte against
//      `mdast.value`; `pm.node.content.size === charMap.visibleLength`
//      compares two independently derived structural counts; and
//      `blockEndpointsAgree` compares `pmNode.textContent`. The preview is a
//      Vue-rendered SIBLING element inside the nodeview and contributes
//      nothing to any of them. So a preview can neither strengthen nor
//      weaken this module's evidence — it is simply outside its subject.
//
//  P2. THE PM CONTENT IS IDENTICAL WITH OR WITHOUT A PREVIEW. Milkdown's
//      `code_block` parseMarkdown runner is `state.addText(node.value)`,
//      verbatim, for every language. A ```mermaid block's PM text IS its
//      fence content, exactly like a ```js block's.
//
//  P3. THE CODEMIRROR EDITOR IS ALWAYS MOUNTED — the load-bearing fact, and
//      the one that makes a "state-dependent charMap" unnecessary rather
//      than merely awkward. In the vendored component
//      (node_modules/@milkdown/components/src/code-block/view/components/
//      code-block.tsx) `onMounted` appends `props.codemirror.dom` to the
//      host UNCONDITIONALLY; `previewOnlyMode` is a Vue ref that only adds a
//      `hidden` CSS CLASS to that same host div. There is no conditional
//      mount, no unmount, and no alternate editing surface. A previewed
//      block is therefore STRUCTURALLY IDENTICAL to an ordinary fenced block
//      on both the PM side and the CM side; only its VISIBILITY differs.
//
//  P4. SO THE GATE MUST NOT BE STATE-DEPENDENT. Keying editability off the
//      preview/edit display state would make a BYTE contract depend on a CSS
//      class, and would reintroduce exactly the staleness window
//      editor-kernel-cm-bridge.js's header argues against for `readOnly`
//      facets. The honest condition is the per-block one this file already
//      proves: `buildCodeMap` + the size check + the endpoint check.
//
//  P5. THE PREVIEWED STATE IS UNREACHABLE, NOT UNSAFE. While the preview is
//      showing, the CM host carries `hidden`, so nothing can focus it and no
//      input event can originate there. When the user clicks the toolbar's
//      Edit toggle, the SAME always-mounted CM becomes visible and every
//      input funnels through editor-kernel-cm-bridge.js's per-event
//      `isEditable(cmView)` gate -> `codePairFromCm` -> `pair.charMap`,
//      i.e. the freshly rebuilt map. (app.css additionally keeps a FOCUSED
//      host visible — `.codemirror-host.hidden:focus-within { display:
//      block }` — so a block being typed into does not vanish mid-edit when
//      its first character makes the preview appear.)
//
// WHAT DID NOT CHANGE. mdast `math` (`$$..$$`) is still decided separately,
// on its own evidence, by the `md.type === 'math'` branch below — lifting a
// language name never silently lifted a different block SHAPE. And a
// `code_block` this module cannot prove (buildCodeMap null, size
// disagreement, endpoint disagreement) still degrades to `charMap: null`
// per-block, exactly as before.
//
// One consequence worth naming: `createMermaidSplitPlugin` (editor-mermaid.js)
// is no longer registered in kernel mode at all (editor-crepe-setup.js). Its
// appendTransaction carries NODE content, so in kernel mode it could only
// ever produce a `blocked` classification that vetoes the WHOLE batch —
// including the user's own keystroke — and it rescans the entire document on
// every change, so a single 2-diagram block made every keystroke ANYWHERE in
// the document refuse. See case 4 in the INVARIANT block at the top of this
// file, which that de-registration retires.
// ==========================================================================

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
      // A LIST ITEM WHOSE FIRST BLOCK IS NOT A PARAGRAPH (2026-08-20). Milkdown's
      // `list_item` content expression is `paragraph block*` — the leading
      // paragraph is REQUIRED — so ProseMirror's `createAndFill` inserts an empty
      // one whenever the item's first child is anything else. mdast has no such
      // node, so the PM side carried one more entry and the WHOLE map was
      // rejected: measured against a real `buildProjectionMap`, `- - x` (a nested
      // list written on the same line), `- # x` and `- > x` each returned null,
      // i.e. ANY document containing one of those shapes ran entirely in legacy —
      // silently, since the fallback toast is the only signal and it fires once
      // at attach.
      //
      // It is also what made typing `- ` at a bullet item's text start
      // unfixable: the bytes `- - x` are exactly right and the projection could
      // not pair them, so the gesture had to be refused after the fact.
      //
      // Same treatment the two synthetic cases above get — a marker object that
      // holds the zip's alignment — and the pair is NON-EDITABLE by construction:
      // that paragraph has no bytes of its own (the item's content start is where
      // the nested marker begins), so there is no offset a keystroke there could
      // honestly write to. `paragraph` and block `html` are excluded because both
      // pair with a PM `paragraph` directly (see PM_TO_MD), so no fill happens.
      if (node.type === 'listItem') {
        const first = (node.children || [])[0]
        if (first && first.type !== 'paragraph' && first.type !== 'html') {
          result.push({ syntheticLeadingItemParagraph: true, node })
        }
      }
      // An EMPTY BLOCKQUOTE ('>' alone on its line) is the same shape one
      // container over, and it was the reason `/quote` could never succeed:
      // mdast gives the blockquote ZERO children, ProseMirror's `blockquote` is
      // `content: "block+"` and the transformer's `createAndFill` therefore
      // fills one empty paragraph in, so the PM side always had one node more
      // than the mdast side. Unsynthesized, that mismatch rejected the WHOLE
      // map — which is why `runQuoteToggleFromQuery` had to refuse a shape
      // whose bytes were perfectly correct, and why ANY document containing a
      // bare '>' line silently degraded to legacy in its entirety.
      if (node.type === 'blockquote' && (!node.children || node.children.length === 0)) {
        result.push({ syntheticEmptyQuoteParagraph: true, node })
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

// An EMPTY ATX heading ('## ') has no inline content for buildCharacterMap to
// anchor to, but its content start IS provable from the heading's own raw
// bytes — no text search, no guess, just CommonMark's ATX grammar applied to
// a span that contains nothing else:
//
//   ATX heading = up to 3 spaces of indentation, 1-6 '#', then — when the
//   heading has content — a REQUIRED run of spaces/tabs, then the content.
//
// When the heading is empty, that prefix IS the whole raw span, so the
// content start is unambiguously the span's own end offset. Typing there
// commits '## x', which reparses as the same heading with content.
//
// The `[ \t]+$` tail is the load-bearing half, and it is the SAME rule the
// empty-list-item pairing applies (`item.spacing !== ''`): a bare '##' with
// no spacing is also an empty heading, but typing at its end would commit
// '##x' — a PARAGRAPH. That shape keeps returning null and stays read-only.
// A closing sequence ('## ##') likewise does not match and stays refused:
// its content start sits between two marker runs and this function does not
// claim to know which side new bytes belong to.
//
// Returns null (never a number) when the shape is not provable, so the caller
// can keep its existing fail-closed branch.
// An EMPTY BLOCKQUOTE's content start, derived from its own raw bytes exactly
// as the empty-heading rule above derives a heading's — no text search, no
// guess, just CommonMark's block-quote grammar: the marker is up to 3 spaces of
// indentation, one '>', and OPTIONALLY one space or tab, all of which the parser
// consumes. Typing at the offset right after that prefix commits '> x' (or
// '>x'), which reparses as the same blockquote holding one paragraph.
//
// The marker (plus its one optional space) must be the WHOLE first line. A line
// like '>  ' (two spaces) is refused rather than anchored: only the first space
// belongs to the marker, so typed text would land after a space the paragraph
// then strips — a dead byte, which is precisely what this kernel must not
// write. Such a blockquote stays read-only (charMap null), fail-closed.
const EMPTY_QUOTE_MARKER_RE = /^ {0,3}>[ \t]?/
const emptyQuoteContentStart = (markdown, node) => {
  const start = node?.position?.start?.offset
  const end = node?.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  let lineEnd = start
  while (lineEnd < end && markdown[lineEnd] !== '\n' && markdown[lineEnd] !== '\r') lineEnd += 1
  const opening = markdown.slice(start, lineEnd).match(EMPTY_QUOTE_MARKER_RE)
  if (!opening) return null
  return start + opening[0].length === lineEnd ? lineEnd : null
}

const EMPTY_ATX_HEADING_RE = /^ {0,3}#{1,6}[ \t]+$/
const emptyAtxHeadingContentStart = (markdown, md) => {
  if (md?.type !== 'heading') return null
  const start = md.position?.start?.offset
  const end = md.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  if (!EMPTY_ATX_HEADING_RE.test(markdown.slice(start, end))) return null
  return end
}

// A STANDALONE-LINE `$$x$$` paragraph paired against the code_block the
// editor chain shows for it (2026-08-22 — the first of the three documented
// whole-tab attach degradations).
//
// The two chains genuinely see DIFFERENT BYTES for this one shape:
// `editor-parse-adapter.js` runs `normalizeDisplayMath` (editor-math.js)
// BEFORE the PM parse, rewriting a line that is exactly `$$…$$` into the
// three-line block form remark-math recognizes — so PM holds a `code_block`
// with `attrs.language === 'LaTeX'` (Crepe's latex feature rewrite) while the
// kernel deliberately holds the ORIGINAL bytes, whose mdast is a `paragraph`
// (remark-math reads single-line `$$x$$` as INLINE math with a 2-dollar
// fence). A type mismatch at that slot used to reject the WHOLE map, i.e.
// every document containing one such line ran entirely in legacy.
//
// The pairing below is a byte-proven derivation, not a tolerance:
//   * the mdast paragraph's ENTIRE raw span must match
//     `/^\$\$[^\n]*\$\$[ \t]*$/` — the same line shape `normalizeDisplayMath`
//     rewrites (its own regex is `^[ \t]*\$\$([^\n]+?)\$\$[ \t]*$` per line).
//     Leading indentation needs no allowance because remark EXCLUDES it from
//     the paragraph span (measured: `'  $$x$$'` → paragraph [2,7)); trailing
//     `[ \t]*` IS needed because remark keeps trailing spaces inside the span
//     (measured: `'$$x$$  '` → paragraph [0,7)) and the rewrite tolerates
//     them. A span with any other content (trailing text, a second line via
//     lazy continuation) does not match and keeps the whole-map rejection.
//   * the PM node must be a `code_block` whose language is LaTeX — the exact
//     node Crepe's latex feature produces from the rewritten bytes. Any other
//     language stays a plain type mismatch.
//
// The pair is NEVER editable (`charMap: null`, decided by the caller): the
// raw side is one line and the PM side three, so no character-level decode
// contract exists — editing must keep refusing, which the read-only-leaf
// posture (tables / block HTML) already implements. Everything around the
// slot keeps its map, which is the entire point.
const STANDALONE_DOLLAR_MATH_RE = /^\$\$[^\n]*\$\$[ \t]*$/
const isNormalizedDisplayMathPair = (markdown, md, pmNode) => {
  if (md?.type !== 'paragraph') return false
  if (String(pmNode?.attrs?.language ?? '').toLowerCase() !== 'latex') return false
  const start = md.position?.start?.offset
  const end = md.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false
  return STANDALONE_DOLLAR_MATH_RE.test(markdown.slice(start, end))
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
  // Chain-only self-check (review finding, Task 2 plan 3; widened
  // 2026-08-23): the `pendingPlaceholders` LIST form is
  // extendTrailingPlaceholder's chain. The original check required every
  // entry at/after the last top-level block's end — the chain was
  // trailing-only, and a voucher sitting inside real content would commit
  // later keystrokes at a wrong offset (the per-item "empty paragraph" check
  // alone can't catch that: an empty PM node with no mdast counterpart looks
  // identical wherever it is). Since Enter now extends MID-document blank
  // runs too (splitTextBlock's proof-gated gap branch, 2026-08-23 — the
  // user-reported "Enter refused on an empty placeholder paragraph"), the
  // floor is restated as what it actually protected: no voucher may sit
  // INSIDE any LEAF block's raw span. Blank-run offsets — trailing OR
  // mid-document, root or inside a blockquote (a `>` blank line is inside
  // the quote CONTAINER's span but no leaf's) — all pass; an offset inside
  // a paragraph/heading/code/table still rejects the map. The single-object
  // `pendingPlaceholder` form keeps its long-standing uncovered shape
  // (ensureSplitPlaceholder's Case 13) unchanged.
  if (pendingIsChain && pendingList.length) {
    const LEAF_SPAN_TYPES = new Set(['paragraph', 'heading', 'code', 'math', 'html', 'thematicBreak', 'table'])
    const insideLeaf = (raw) => {
      let hit = false
      const walk = (node) => {
        if (hit) return
        const start = node.position?.start?.offset
        const end = node.position?.end?.offset
        if (LEAF_SPAN_TYPES.has(node.type) &&
            Number.isInteger(start) && Number.isInteger(end) &&
            raw >= start && raw < end) {
          hit = true
          return
        }
        for (const child of node.children || []) walk(child)
      }
      walk(index.tree)
      return hit
    }
    if (pendingList.some((p) => !Number.isFinite(p.rawOffset) || insideLeaf(p.rawOffset))) {
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
        // '' for the split/doc-end sessions (their separator bytes already
        // exist); the QUOTED list-exit voucher passes '\n> ' so the committed
        // body line stays SEPARATED from the list (a bare `> text` line right
        // after `> - item` is a lazy continuation CommonMark absorbs into the
        // item — measured, 2026-08-22).
        insertPrefix: pendingMatch.insertPrefix ?? ''
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
    // Synthetic wrapper for an EMPTY BLOCKQUOTE's PM auto-filled paragraph (see
    // flattenMd). Editable exactly when the marker prefix is provable from the
    // bytes — see `emptyQuoteContentStart` for the one shape it refuses and why.
    if (md.syntheticEmptyQuoteParagraph) {
      if (pmType !== 'paragraph' || pm.node.content.size !== 0) return null
      const anchor = emptyQuoteContentStart(markdown, md.node)
      const editable = Number.isInteger(anchor)
      blockPairs.push({
        mdBlock: null,
        pmNode: pm.node,
        pmPos: pm.pos,
        charMap: editable ? virtualCharMap(anchor) : null,
        virtual: editable,
        insertPrefix: editable ? '' : undefined
      })
      continue
    }

    // ProseMirror's required leading paragraph for a list item whose first block
    // is a nested list / heading / quote / fence (see flattenMd). It holds no
    // bytes, so it pairs read-only — `virtual` is deliberately NOT set: a
    // virtual pair claims an editable single-point anchor, and there is no
    // offset here a keystroke could honestly write to.
    if (md.syntheticLeadingItemParagraph) {
      if (pmType !== 'paragraph' || pm.node.content.size !== 0) return null
      blockPairs.push({ mdBlock: null, pmNode: pm.node, pmPos: pm.pos, charMap: null })
      continue
    }

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
        insertPrefix: editable ? '' : undefined,
        // The item's OWN byte identity, kept even when the pair is not
        // editable. A BARE marker (`*` with no spacing) pairs charMap: null
        // AND mdBlock: null, which used to leave the pair with no byte
        // anchor at all — so neither the marker keymap routes
        // (`markerRawOffsetAt`) nor the caret resolver (`rawToPmCaret`)
        // could reach the one offset that matters: the marker's end, where
        // a completing Space or a demoting character must land.
        mdItem: item || null
      })
      continue
    }

    // Standalone-line `$$x$$` (see `isNormalizedDisplayMathPair`): the ONE
    // type pair that is legal OUTSIDE PM_TO_MD, because the editor chain
    // rewrote the bytes before parsing (`normalizeDisplayMath`) while the
    // kernel holds the original line. Byte-proven from the paragraph's own
    // span + the PM block's LaTeX language; read-only by construction (the
    // two sides disagree in line structure, so no offset in either direction
    // may ever be served — same contract as block HTML).
    if (pmType === 'code_block' && md.type === 'paragraph' &&
        isNormalizedDisplayMathPair(markdown, md, pm.node)) {
      blockPairs.push({ mdBlock: md, pmNode: pm.node, pmPos: pm.pos, charMap: null })
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
      // MERGED ROOT-LEVEL SIBLINGS (2026-08-22 — the third of the three
      // documented whole-tab attach degradations). `remarkMergeInlineHtml`'s
      // `coalesceChildren` runs on the mdast ROOT too, so N consecutive
      // root-level html blocks that balance (`<div>` … `</div>` split by
      // blank lines — the everyday HTML-wrapper spelling) become ONE html
      // node on the editor side, wrapped in ONE paragraph, while the kernel
      // keeps N positioned blocks. That count mismatch used to reject the
      // WHOLE map.
      //
      // The consumption below is gated on a byte proof, not a tolerance:
      //  * the run is detected by `inlineHtmlRunAt` — the SAME shared
      //    implementation the editor's coalescer calls, invoked with the
      //    identical arguments (`BREAK_REWRITE_PARENTS.has(tree.type)` is
      //    exactly `coalesceChildren`'s own `breakHtmlCuts` for the root,
      //    i.e. false: a root-level `<br/>` stays html and balances across);
      //  * the PM atom's `attrs.value` must equal the run's `value`
      //    byte-for-byte. That value IS what the editor's merged node
      //    carries (the concatenation of the member values, the same
      //    function's same return), so equality proves the editor merged
      //    exactly these blocks — no whitespace guessing is needed because
      //    both sides compute the spelling from the same code. Inequality
      //    means the trees aligned differently → fall through, and the
      //    leftover mdast blocks reject the whole map exactly as before.
      //  * each consumed block must be the NEXT entry in `mdBlocks` by
      //    IDENTITY — the run members are consecutive root children and
      //    html has no walkable children, so this always holds for a real
      //    parse; checking it makes the count bookkeeping self-verifying.
      // The attempt only runs when the single-block pairing CANNOT be what
      // the editor did (`atomValue !== md.value` — a merged value is the
      // concatenation of 2+ non-empty values, so it never equals the first
      // member's own value), which keeps every previously-working 1:1
      // pairing byte-identical, including the value-divergent ones the old
      // branch deliberately never inspected.
      //
      // Root-level ONLY, deliberately: the same merge inside a blockquote /
      // list item still rejects the whole map (the run proof has not been
      // argued through container prefixes) — pinned as a residual in
      // scripts/test-kernel-projection-map.mjs Case H9.
      const atomValue = String(only.attrs?.value ?? '')
      if (atomValue !== String(md.value ?? '')) {
        const rootChildren = index.tree?.children || []
        const runStart = rootChildren.indexOf(md)
        const run = runStart >= 0
          ? inlineHtmlRunAt(rootChildren, runStart, BREAK_REWRITE_PARENTS.has(index.tree.type))
          : null
        if (run && run.value === atomValue) {
          const rest = rootChildren.slice(runStart + 1, run.end)
          const first = rootChildren[runStart]
          const last = rootChildren[run.end - 1]
          const startPoint = first.position?.start
          const endPoint = last.position?.end
          const aligned = rest.length > 0 &&
            Number.isInteger(startPoint?.offset) && Number.isInteger(endPoint?.offset) &&
            rest.every((node, k) => mdBlocks[mdIndex + k] === node)
          if (aligned) {
            mdIndex += rest.length
            blockPairs.push({
              // A synthetic html block spanning the WHOLE run (real point
              // objects from the member nodes), so every position-reading
              // consumer (read-only reporting, content-end floors) sees the
              // run's true extent rather than its first member's.
              mdBlock: { type: 'html', value: run.value, mergedRootHtml: true, position: { start: startPoint, end: endPoint } },
              pmNode: pm.node,
              pmPos: pm.pos,
              charMap: null
            })
            continue
          }
        }
      }
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

    // =======================================================================
    // LAZY CHARACTER MAP (perf assessment §9 #4, 2026-08-21)
    // =======================================================================
    // A NON-EMPTY editable textblock defers its charMap (and its proofs)
    // behind a caching getter: the eager document-wide pass was ~50 % of
    // every buildProjectionMap (103 ms at 200 KB, superlinear at 1 MB) while
    // a keystroke touches ONE block. Nothing about the fail-closed posture
    // changes — the size proof, the endpoint cross-check and the mapper's own
    // byte-for-byte units all run at materialization, which every consumer
    // performs (by reading `pair.charMap`) BEFORE any offset from this pair
    // can be served. A pair whose proof fails materializes to `null`, exactly
    // the degraded shape the eager build produced.
    //
    // EMPTY textblocks (content.size 0) deliberately stay on the eager path
    // below: their build is O(1), and the empty-ATX-heading derivation must
    // set the STATIC `virtual` flag consumers read without touching charMap.
    // The in-map resolvers (`pairForContentPos`, `rawToPmPos`) range-check a
    // deferred pair without materializing it — content.size stands in for
    // visibleLength (the size proof makes them equal for every served map)
    // and the mdast block span pre-filters raw offsets — so a scan across N
    // pairs still builds only the block it lands in. `deferred` is the
    // discriminator those resolvers key on.
    if (editable && pm.node.content.size > 0) {
      const pmNode = pm.node
      const mdNode = md
      const build = pmType === 'code_block'
        ? () => buildCodeMap(markdown, mdNode)
        : () => buildCharacterMap(markdown, mdNode)
      const pair = { mdBlock: md, pmNode, pmPos: pm.pos, deferred: true }
      let materialized = false
      let value = null
      Object.defineProperty(pair, 'charMap', {
        enumerable: true,
        configurable: true,
        get() {
          if (!materialized) {
            materialized = true
            // Same three proofs, same order, as the eager branches below.
            let m = build()
            if (m && pmNode.content.size !== m.visibleLength) m = null
            if (m && !blockEndpointsAgree(markdown, pmNode, m)) m = null
            value = m
          }
          return value
        }
      })
      blockPairs.push(pair)
      continue
    }
    let charMap = null
    // Set only by the empty-ATX-heading derivation at the bottom of this
    // branch: like the empty list item's own placeholder pair, such a pair
    // carries NO real content bytes — it is a single insertion anchor — so it
    // must be excluded from `editablePairForRange` (mark toggles / Tab), which
    // is exactly what `virtual` means to editor-kernel-mode.js.
    let virtual = false
    if (editable && pmType === 'code_block') {
      // BLOCK MATH (`$$..$$`, mdast `math`) IS MAPPED HERE TOO (2026-08-18).
      //
      // It used to be forced non-editable alongside the preview languages,
      // for two stated reasons. The first was the language gate, which is
      // gone (see the ADR above). The second was that `changeCodeLanguage`
      // and `exitCodeBlock` (commands/code-language.js, commands/code-exit.js)
      // both require `block.type === 'code'`, because a `$$` delimiter pair
      // has nowhere to spell an info string and no closing fence run to write
      // after. That is TRUE and stays true — but it is a statement about two
      // OTHER operations, each of which enforces it at its OWN command:
      //   * a language switch is refused by `changeCodeLanguage` itself, and
      //     the refusal vetoes the PM transaction inside `dispatchTransaction`
      //     BEFORE `view.updateState`, so the "PM language switched away while
      //     the source still says `$$`" transient the old comment worried
      //     about cannot occur;
      //   * Mod-Enter is refused by `exitCodeBlock` itself (notify + swallow).
      // Neither needs this pair's charMap to be null, and keeping the whole
      // block unwritable to enforce them was over-broad: it made the TEXT
      // read-only to protect two operations that were already fail-closed.
      //
      // What text editing itself needs, proven rather than assumed:
      //  M1. `buildCodeMap` is type-agnostic — it reads `.value` +
      //      `.position` and proves every unit byte-for-byte. Measured
      //      2026-08-18 across plain/quoted x LF/CRLF x single/multi-line/
      //      empty: visibleLength always equals `value.length`, linePrefix
      //      '' / '> ', lineEnding '\n' / '\r\n'. The list-indented form
      //      still fails closed, degrading that ONE pair.
      //  M2. The PM content is the same verbatim text a fence produces:
      //      Crepe's `visitMathBlock` (feature/latex) rewrites the mdast
      //      `math` node to `{type:'code', lang:'LaTeX', value}` — copying
      //      `value` unchanged — BEFORE the PM parse, so the block goes
      //      through the identical `state.addText(node.value)` runner. Hence
      //      `content.size === visibleLength` holds for `$$` exactly as it
      //      does for ```fenced.
      //  M3. There IS an edit affordance, and it is the same one: the
      //      vendored CodeMirrorBlock mounts CodeMirror unconditionally and
      //      Crepe's latex `renderPreview` (KaTeX) only supplies the preview
      //      panel + its Edit toggle.
      //  M4. Whitespace inside `$$` is CONTENT, not a dead byte — measured:
      //      trailing space/2-spaces/tab and a leading space all survive the
      //      reparse verbatim. So the block-trailing-space respelling
      //      (`spellBlockTailInsert`) correctly excludes `math` from its
      //      allowlist, and no heading/trailing whitespace command fires here.
      //  M5. Every ordinary edit round-trips exactly: typing at the start /
      //      middle / end, Enter (including the quoted form's per-line `> `
      //      prefix expansion) and CRLF Enter all reparse to precisely the
      //      inserted value.
      //
      // The one shape that does NOT round-trip is a user typing a `$$` LINE
      // inside the block, which closes it early. The bytes written are still
      // exactly what was typed — this is the same semantics as typing ``` on
      // its own line inside a fence, and it is caught downstream by
      // `verifyPlainTextProjection`'s reconcile, not silently absorbed.
      charMap = buildCodeMap(markdown, md)
      // `buildCodeMap` fails closed (null) for a content shape it can't
      // prove byte-for-byte, most commonly a blockquote/list-indented
      // fence whose per-line prefix a BLANK content line can't reproduce
      // (e.g. a quoted fence's blank line written as a bare '>' instead of
      // '> ' — see code-map.js's own `text.startsWith(prefix, line.start)`
      // guard). That is a property of THIS ONE block's content, not a
      // structural PM/mdast disagreement — degrade only this pair to
      // non-editable (final-review fix, 2026-08-16; `charMap` stays `null`,
      // same contract as the table/image-block pairs) instead of rejecting
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
    } else if (editable) {
      // Editable (textblock) pairs MUST carry a proof of lossless character
      // alignment. No charMap (the kernel couldn't prove this block's units)
      // — or a charMap whose decoded visible length disagrees with PM's own
      // content size — means THIS BLOCK is unprovable, so it degrades to a
      // non-editable leaf (`charMap = null`, exactly the posture
      // table/image-block/block-HTML pairs already have)
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
      //
      // ONE exception, and it is a DERIVATION rather than a relaxation: an
      // EMPTY ATX heading's content start is provable from its own raw bytes
      // (see `emptyAtxHeadingContentStart`), so instead of serving the wrong
      // boundary or refusing, that case gets a single-point `virtualCharMap`
      // at the derived offset — character-for-character the treatment the
      // empty LIST ITEM already gets ~270 lines above, including its
      // "only when the marker carries real spacing" rule.
      if (charMap && charMap.units.length === 0 && md.type !== 'paragraph') {
        const anchor = emptyAtxHeadingContentStart(markdown, md)
        if (anchor == null) charMap = null
        else {
          charMap = virtualCharMap(anchor)
          virtual = true
        }
      }
    }
    blockPairs.push({ mdBlock: md, pmNode: pm.node, pmPos: pm.pos, charMap, ...(virtual ? { virtual: true } : null) })
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
      // Range-check a deferred pair WITHOUT materializing it: the size proof
      // makes visibleLength === pmNode.content.size for every served map, so
      // the node's own size is the same bound. Only the pair the position
      // lands in pays for its build; a materialization whose proof failed
      // (charMap null) is skipped exactly like the eager degraded pair was.
      let size
      if (pair.deferred) {
        size = pair.pmNode.content.size
      } else {
        if (!pair.charMap) continue
        size = pair.charMap.visibleLength
      }
      const contentPos = pair.pmPos + 1
      if (pmPos < contentPos || pmPos > contentPos + size) continue
      if (!pair.charMap) continue
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
      // Pre-filter a deferred pair by its mdast block span before paying for
      // the build: the charMap's raw range is always contained in the block's
      // own [start, end] (content start can only sit at/after the marker).
      // A span hit still runs the exact range check below on the
      // materialized map, so an offset in the marker region resolves
      // identically to the eager build (skip, keep scanning).
      if (pair.deferred) {
        const s = pair.mdBlock?.position?.start?.offset
        const e = pair.mdBlock?.position?.end?.offset
        if (Number.isInteger(s) && Number.isInteger(e) && (raw < s || raw > e)) continue
      } else if (!pair.charMap) continue
      const { charMap } = pair
      if (!charMap) continue
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

  // CARET resolution for a raw offset the write-path resolver refuses.
  // `rawToPmPos` fails closed outside charMap unit boundaries — correct for
  // WRITES, but a committed selection anchor still needs a home in the view
  // after a structure-changing reconcile (the bare-marker family: typing `*`
  // on a blank line makes an EMPTY bullet item whose pair has no charMap, so
  // the repair reconcile had no caret target and the caret was thrown into
  // the trailing placeholder — the next keystroke landed in the WRONG block,
  // measured 2026-08-21). The weaker, safe question answered here: an EMPTY
  // textblock has exactly ONE caret position, so when the offset falls inside
  // such a pair's own byte span (its mdBlock, or the mdItem record a bare
  // list marker carries), that position is a derivation, not a guess. This
  // never makes an unmappable offset writable — writers keep using
  // `rawToPmPos`/`pmPosToRaw`.
  const rawToPmCaret = (raw) => {
    const direct = rawToPmPos(raw)
    if (direct) return direct
    if (!Number.isFinite(raw)) return null
    for (const pair of blockPairs) {
      if (pair.charMap) continue
      const node = pair.pmNode
      if (!node?.isTextblock || node.content.size !== 0) continue
      const span = pair.mdBlock?.position
        ? { start: pair.mdBlock.position.start?.offset, end: pair.mdBlock.position.end?.offset }
        : pair.mdItem
          ? { start: pair.mdItem.start, end: pair.mdItem.contentStart }
          : null
      if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end)) continue
      if (raw >= span.start && raw <= span.end) return { pos: pair.pmPos + 1, atom: false }
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
    rawToPmCaret,
    virtualBlockAt,
    pairAt: pairForContentPos
  }
}
