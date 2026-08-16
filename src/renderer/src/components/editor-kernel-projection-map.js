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
// Fail-closed: any structural mismatch (block count, block type, ordered
// flag, or a textblock the kernel can't character-map) rejects the WHOLE
// map (`null`), never a partial/best-effort map. Some block TYPES are
// non-editable by construction, though — they still occupy a slot in the
// structural pairing (so a document CONTAINING one still maps its other
// blocks), but never carry a charMap and any offset targeting them (or
// their raw span) resolves to `null`: `html` (no reliable character-level
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

// PM block-level node name -> the mdast block type(s) it may structurally
// pair with. Both sides are walked in document order (pre-order, containers
// included so they occupy a slot in the sequence just like leaves) and
// zipped index-for-index — see flattenPm/flattenMd below.
const PM_TO_MD = {
  paragraph: ['paragraph'],
  heading: ['heading'],
  blockquote: ['blockquote'],
  bullet_list: ['list'],
  ordered_list: ['list'],
  list_item: ['listItem'],
  code_block: ['code', 'math'],
  table: ['table'],
  hr: ['thematicBreak'],
  html: ['html'],
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
// Exported (Plan 3 Task 4): editor-kernel-gateway.js's `extractLanguageStep`
// consults the same set — NOT to refuse switching languages (that guard was
// lifted, final-review fix, 2026-08-16: a switch OUT of mermaid/latex is now
// allowed, `commitCodeLanguage` resolves it via the pair's `mdBlock` fence
// start when `charMap` is null), only so a language picker can tell whether
// the block it is about to switch FROM is currently preview-only. Once a
// switch commits, `editor-kernel-mode.js` unconditionally rebinds the
// projection map, so a block newly switched AWAY from one of these
// languages gets a real `charMap` (editable) and a block newly switched
// INTO one loses it (preview-only) — always freshly evaluated, never stale.
export const READONLY_CODE_LANGUAGES = new Set(['mermaid', 'latex'])

// PM/mdast types whose subtree is intentionally NOT walked into for
// pairing purposes: `table` is recorded as ONE opaque pair. A typical PM
// table schema wraps cell content in `table_cell > paragraph`, but GFM
// `tableCell` in mdast holds phrasing content directly (no paragraph
// wrapper) — descending into both subtrees would zip a PM `paragraph` pair
// against no mdast counterpart and null the WHOLE document. Treating the
// table as opaque (no interior offsets, like an atom) keeps every other
// block in the document mappable.
const OPAQUE_TYPES = new Set(['table'])

// Walk every descendant of the PM doc, collecting the ones whose type name
// is a recognized structural pair (containers AND textblocks) in document
// order. `descendants` is guaranteed pre-order (parent before children,
// siblings in order), matching the mdast walk below. Opaque types are
// recorded but their subtree is skipped (`return false`).
function flattenPm(pmDoc) {
  const result = []
  pmDoc.descendants((node, pos) => {
    if (PM_TO_MD[node.type.name]) {
      result.push({ node, pos })
      if (OPAQUE_TYPES.has(node.type.name)) return false
    }
    return true
  })
  return result
}

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
const virtualCharMap = (rawOffset) => ({
  units: [],
  visibleLength: 0,
  visibleToRaw: (vis) => (vis === 0 ? rawOffset : null),
  rawRangeForVisibleRange: (visFrom, visTo) => (
    visFrom === 0 && visTo === 0 ? { from: rawOffset, to: rawOffset } : null
  )
})

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

    const editable = pm.node.isTextblock &&
      !NON_EDITABLE_LEAF_TYPES.has(pmType) &&
      !OPAQUE_TYPES.has(pmType)
    let charMap = null
    if (editable && pmType === 'code_block') {
      // mdast `math` shares the PM `code_block` type but is TeX source, not
      // the char-per-char code contract `buildCodeMap` proves — never claim
      // a charMap for it. Otherwise, a language Crepe renders as a
      // preview-only diagram/formula (mermaid/latex, checked
      // case-insensitively on the PM node's own `attrs.language`) also stays
      // non-editable, regardless of what buildCodeMap could prove.
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
        // code block) stays fully mappable. The two checks below only run
        // when `buildCodeMap` DID prove a charMap; they still reject the
        // WHOLE map on their own failures (a genuine PM/mdast structural
        // mismatch, or the CRLF-bridge ADR), which is unrelated to this
        // per-block content-shape case.
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
        if (charMap && pm.node.content.size !== charMap.visibleLength) return null
        // ADR (Plan 3 Task 4 fix-review, 2026-08-16): a code_block whose
        // dominant line ending is NOT bare '\n' stays non-editable, for a
        // reason entirely outside this module's own math — it is a
        // pre-existing defect in the VENDORED `@milkdown/components`
        // CodeMirrorBlock nodeview (node_modules/@milkdown/components/lib/
        // code-block/index.js), not something buildCodeMap/pmPosToRaw gets
        // wrong. Investigation findings:
        //  - `initializeCodeMirror()` feeds the PM node's literal (CRLF-
        //    preserving) `textContent` into `new EditorView({ doc, ... })`.
        //    CodeMirror6 builds its OWN internal `Text` model by splitting
        //    on `/\r\n?|\n/` (verified by reading
        //    node_modules/@codemirror/state/dist/index.cjs) — the
        //    separator bytes are DISCARDED, never stored. Empirically:
        //    `EditorState.create({doc:"let a = 1\r\nlet b = 2"}).doc.length`
        //    is 19, not the raw string's 20 — CM's internal doc is missing
        //    the '\r'. Every CM position at/after the block's first
        //    line-break is therefore off by one PM offset (more for
        //    further lines) relative to the PM node's own '\r\n'-preserving
        //    positions, from the moment the nodeview mounts — independent
        //    of any particular edit.
        //  - `forwardUpdate` (CM -> PM) computes PM step positions as
        //    `offset + fromA` / `offset + toA` using CM's own (already
        //    deficient) coordinates with no correction for the dropped
        //    '\r' bytes. A ReplaceStep built this way is structurally
        //    indistinguishable from a correct one by the time it reaches
        //    editor-kernel-gateway.js's classification — there is no
        //    signal at the gateway/kernel layer that could detect "this
        //    position undercounts N dropped bytes". A single-character
        //    edit anywhere past the block's first line break can silently
        //    commit to the WRONG raw range (e.g. a Backspace meant to join
        //    two CRLF lines instead deletes only the '\r' half, quietly
        //    converting that one line ending to a bare '\n' while the rest
        //    of the block stays CRLF) — this predates Plan 3 Task 4
        //    entirely; it was already reachable the moment code_block
        //    became editable at all.
        //  - Separately (and independent of the bug above), `Text.
        //    prototype.toString()` (used to build `forwardUpdate`'s
        //    inserted text) always joins with a bare '\n' — CM can never
        //    itself emit a '\r'. So even a text-commit confined to a
        //    block's first line (where CM's position math is still
        //    correct) leaves the block's OWN PM node with a bare '\n' at
        //    the newly-typed line break, while the correctly-committed raw
        //    bytes (via this module's `lineEnding`-aware expansion in
        //    editor-kernel-gateway.js `commitPlainText`) correctly carry a
        //    2-byte '\r\n' there — a guaranteed cheap-path verify mismatch
        //    (editor-kernel-mode.js `verifyPlainTextProjection`) on every
        //    such commit, triggering an async repair reconcile every time.
        //    `CodeMirrorBlock.update()`'s own resync then re-absorbs the
        //    repaired node content through the SAME '\r'-stripping split,
        //    so this manifests as repeat churn, not the injected-'\r'
        //    lockout a first-pass hypothesis suspected — but churn (lost
        //    scroll/cursor stability, noisy projection-mismatch
        //    diagnostics) is still a real defect.
        // Fixing the CM bridge's own position math (or teaching it to
        // preserve/reconstruct '\r') is out of scope here: it lives in a
        // vendored dependency, and normalizing kernel.doc's own bytes is
        // forbidden (source bytes are the one truth). Until a dedicated
        // task addresses the CM bridge (or proves a different safe
        // contract), the SAME fail-closed posture already used for
        // mermaid/latex/math (structurally paired, never charMap-editable)
        // is the coherent, in-scope choice — it removes the whole attack
        // surface (both the confirmed churn and the deeper, undetectable
        // position-corruption risk) rather than trying to special-case
        // "currently single-line, might become multi-line" blocks, which
        // would just delay the same failure to the user's very next Enter.
        if (charMap && charMap.lineEnding !== '\n') charMap = null
      }
    } else if (editable) {
      // Editable (textblock) pairs MUST carry a proof of lossless character
      // alignment — no charMap means the kernel couldn't prove the raw
      // source round-trips through this block's decoded text, so the whole
      // map is rejected rather than silently degrading this one block.
      charMap = buildCharacterMap(markdown, md)
      if (!charMap) return null
      // Structural (not textual) consistency check: PM's own content size
      // (sum of each child's nodeSize — text nodes contribute their char
      // length, atom nodes contribute 1) must equal the kernel's decoded
      // visible length. This is a numeric comparison of two independently
      // derived structural counts, not a text/string match.
      if (pm.node.content.size !== charMap.visibleLength) return null
      // Empty-textblock guard: a zero-unit charMap's ONLY boundary is
      // `boundaries[0] = blockNode.position.start.offset` (buildCharacterMap's
      // fallback when there's no first unit to anchor to) — i.e. literally
      // the mdast block's own start offset. For `paragraph` that fallback
      // is genuinely the content start: a paragraph carries no leading
      // marker syntax, so its own start offset IS where content would
      // begin. For any other textblock type (e.g. an empty ATX heading
      // `'#\n'`) the block's start offset is the MARKER's position (the
      // `#`), not the content start — serving that as a boundary would be
      // a silent wrong mapping, so treat it as non-editable instead.
      if (charMap.units.length === 0 && md.type !== 'paragraph') charMap = null
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

  return { blockPairs, pmPosToRaw, rawToPmPos, virtualBlockAt, pairAt: pairForContentPos }
}
