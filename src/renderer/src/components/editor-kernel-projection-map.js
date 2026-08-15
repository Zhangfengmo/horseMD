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
// Fail-closed: any structural mismatch (block count, block type, or a
// textblock the kernel can't character-map) rejects the WHOLE map (`null`),
// never a partial/best-effort map. See docs referenced by Task 1 brief:
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
  html: ['html']
}

const MD_BLOCK_TYPES = new Set(Object.values(PM_TO_MD).flat())

// Walk every descendant of the PM doc, collecting the ones whose type name
// is a recognized structural pair (containers AND textblocks) in document
// order. `descendants` is guaranteed pre-order (parent before children,
// siblings in order), matching the mdast walk below.
function flattenPm(pmDoc) {
  const result = []
  pmDoc.descendants((node, pos) => {
    if (PM_TO_MD[node.type.name]) result.push({ node, pos })
    return true
  })
  return result
}

// Walk the mdast tree the kernel parsed, collecting the same recognized
// structural set, same pre-order convention (a node is recorded before its
// children are visited) so index i on both sides refers to "the i-th
// structural node encountered in document order".
function flattenMd(tree) {
  const result = []
  const walk = (node) => {
    if (MD_BLOCK_TYPES.has(node.type)) result.push(node)
    for (const child of node.children || []) walk(child)
  }
  for (const child of tree.children || []) walk(child)
  return result
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
  if (pmBlocks.length !== mdBlocks.length) return null

  const blockPairs = []
  for (let i = 0; i < pmBlocks.length; i += 1) {
    const pm = pmBlocks[i]
    const md = mdBlocks[i]
    const allowed = PM_TO_MD[pm.node.type.name] || []
    if (!allowed.includes(md.type)) return null

    const leaf = pm.node.isTextblock
    let charMap = null
    if (leaf) {
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
    }
    blockPairs.push({ mdBlock: md, pmNode: pm.node, pmPos: pm.pos, charMap })
  }

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

  return { blockPairs, pmPosToRaw, rawToPmPos }
}
