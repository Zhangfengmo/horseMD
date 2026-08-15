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
// their raw span) resolves to `null`: `code_block`/`html` (no reliable
// character-level decode contract; math shares `code_block` on the PM
// side) and `table` (treated as one opaque leaf — see OPAQUE_TYPES below).
// See docs referenced by Task 1 brief:
// scripts/test-editor-source-map.mjs for the hand-built-PM-schema precedent
// and src/renderer/src/lib/source-kernel/character-map.js for the unit
// model (`units[]`, `kind` in char|escape|entity|atom|linebreak, boundary
// convention "front unit's end").
import { buildSyntaxIndex, buildCharacterMap } from '../lib/source-kernel/index.js'

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
//  - `code_block` (mdast `code`/`math`): the mdast `code`/`math` node has no
//    `.children` — its text lives in `.value` — so `buildCharacterMap`'s
//    `collectUnits` (which only reads `.children`) sees zero children and
//    returns an EMPTY units array (not null) for any code block, empty or
//    not. That's not a proof of alignment, it's collectUnits never looking
//    at the payload at all — treating it as editable let a non-empty code
//    block null the WHOLE map (content.size mismatch) and let an empty code
//    block silently report its own fence position as if it were a valid
//    content boundary. Both are wrong; the fix is to never claim character
//    mapping for this node type in the first place.
//  - `html`: block HTML is opaque prose (may contain raw markdown-like
//    bytes with no decode contract) — kept non-editable even on schemas
//    where it's declared as a textblock rather than an atom.
const NON_EDITABLE_LEAF_TYPES = new Set(['code_block', 'html'])

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
function flattenMd(tree) {
  const result = []
  const walk = (node) => {
    if (MD_BLOCK_TYPES.has(node.type)) {
      result.push(node)
      if (OPAQUE_TYPES.has(node.type)) return
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

export function buildProjectionMap(markdown, pmDoc) {
  if (typeof markdown !== 'string' || !pmDoc || typeof pmDoc.descendants !== 'function') return null

  const index = buildSyntaxIndex(markdown)
  const pmBlocks = flattenPm(pmDoc)
  const mdBlocks = flattenMd(index.tree)

  const blockPairs = []
  let mdIndex = 0
  for (let pmIndex = 0; pmIndex < pmBlocks.length; pmIndex += 1) {
    const pm = pmBlocks[pmIndex]
    const pmType = pm.node.type.name

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
    if (editable) {
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
  const pmPosToRaw = (pmPos) => {
    for (const pair of blockPairs) {
      if (!pair.charMap) continue
      const contentPos = pair.pmPos + 1
      const size = pair.charMap.visibleLength
      if (pmPos < contentPos || pmPos > contentPos + size) continue
      return pair.charMap.visibleToRaw(pmPos - contentPos)
    }
    return null
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

  return { blockPairs, pmPosToRaw, rawToPmPos, virtualBlockAt }
}
