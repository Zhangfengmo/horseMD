// TDD evidence + regression lock for editor-kernel-projection-map.js
// (source-kernel integration Plan 2, Task 1).
//
// All hardcoded PM positions / raw offsets below were derived by actually
// running the real kernel (buildSyntaxIndex/buildCharacterMap) and a real
// hand-built PM Schema against each markdown fixture (see the derivation
// notes inline) — not guessed. UTF-16 units throughout; PM positions follow
// the standard ProseMirror convention: doc content starts at 0, each
// node-open/close token consumes 1 position.
import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { buildProjectionMap } from '../src/renderer/src/components/editor-kernel-projection-map.js'
import { KERNEL_CODES, buildCharacterMap } from '../src/renderer/src/lib/source-kernel/index.js'

assert.equal(KERNEL_CODES.STALE, 'stale-revision')
assert.equal(KERNEL_CODES.INVALID, 'invalid-range')
assert.equal(KERNEL_CODES.UNMAPPED, 'unmapped-selection')
assert.equal(KERNEL_CODES.UNSUPPORTED, 'unsupported-structure')
assert.equal(KERNEL_CODES.NOT_STRUCTURAL, 'not-structural')
assert.equal(KERNEL_CODES.PROJECTION, 'projection-mismatch')
assert.equal(KERNEL_CODES.INPUT_TYPE, 'unsupported-input-type')

// Hand-built PM schema, same pattern as scripts/test-editor-source-map.mjs:12-31
// (doc/paragraph/heading/bullet_list/list_item/image/text), trimmed to what
// this file's fixtures need. `image` is modeled as an INLINE atom (unlike
// test-editor-source-map.mjs's block-level `image`) because the projection
// map's atom handling lives inside a textblock's charMap, not at the block
// pairing level — an inline image inside a paragraph is the realistic Crepe
// shape for `前![a](x.png)后`.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: { content: 'inline*', group: 'block', attrs: { level: { default: 1 } } },
    blockquote: { content: 'block+', group: 'block' },
    bullet_list: { content: 'list_item+', group: 'block' },
    ordered_list: { content: 'list_item+', group: 'block' },
    list_item: { content: 'paragraph block*' },
    code_block: { content: 'text*', group: 'block', code: true },
    table: { content: 'table_row+', group: 'block' },
    table_row: { content: 'table_cell+' },
    table_cell: { content: 'paragraph+' },
    image: { group: 'inline', inline: true, atom: true, attrs: { src: { default: '' } } },
    // Crepe's standalone-image block (@milkdown/components image-block): a
    // block-level ATOM whose mdast counterpart (in the kernel's plugin-free
    // parse) is the plain `paragraph > image` wrapper.
    'image-block': { group: 'block', atom: true, attrs: { src: { default: '' } } },
    text: { group: 'inline' }
  },
  marks: {}
})
const p = (...c) => schema.node('paragraph', null, c)
const doc = (...c) => schema.node('doc', null, c)
const text = (s) => schema.text(s)

console.log('--- kernel projection map ---')

// Case 0: error codes are frozen and exactly as specified.
{
  assert.throws(() => {
    'use strict'
    KERNEL_CODES.STALE = 'mutated'
  }, TypeError, 'KERNEL_CODES must be frozen')
  assert.equal(Object.isFrozen(KERNEL_CODES), true)
}

// Case 1: pure two-paragraph doc. Raw indices of '甲乙\n\n丙\n':
//   甲=0 乙=1 \n=2 \n=3 丙=4 \n=5
// PM: paragraph1 at pos 0 (content start 1, "甲乙" width 2 -> content
// range [1,3]); paragraph2 at pos 4 (content start 5).
// Derived by running buildSyntaxIndex+buildCharacterMap directly: charMap
// for "甲乙" -> boundaries {0:0, 1:1, 2:2}; charMap for "丙" -> {0:4, 1:5}.
{
  const md = '甲乙\n\n丙\n'
  const d = doc(p(text('甲乙')), p(text('丙')))
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'pure paragraphs: map must build')
  assert.equal(map.blockPairs.length, 2)
  assert.equal(map.pmPosToRaw(1), 0) // before 甲
  assert.equal(map.pmPosToRaw(2), 1) // between 甲 and 乙
  assert.equal(map.pmPosToRaw(3), 2) // after 乙 (end of paragraph1 content)
  const toYi = map.rawToPmPos(4)
  assert.ok(toYi)
  assert.equal(toYi.pos, 5) // before 丙 (paragraph2 content start)
  assert.equal(toYi.atom, false)
  // round trip
  assert.equal(map.pmPosToRaw(map.rawToPmPos(4).pos), 4)
}

// Case 2: backslash-escaped asterisk. Raw 'a\*b\n' indices: a=0 \=1 *=2 b=3
// \n=4 (JS string 'a\\*b\n' is 5 real chars). remark decodes the text node
// value to "a*b" (3 visible chars). buildCharacterMap on the paragraph
// produces units [char a:0-1 w1, escape *:1-3 w1, char b:3-4 w1] -> boundary
// table {0:0, 1:1, 2:3, 3:4} (visible offset 2, "after the decoded *", maps
// to raw 3 — the escape's 2 raw bytes collapse to 1 visible position, so
// there is NO PM/raw position that lands strictly between the backslash and
// the asterisk).
// PM: single paragraph at pos 0, content start 1 -> absolute PM positions
// 1/2/3/4 correspond to visible offsets 0/1/2/3.
{
  const md = 'a\\*b\n'
  const d = doc(p(text('a*b')))
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'escape: map must build')
  assert.equal(map.pmPosToRaw(1), 0) // before a
  assert.equal(map.pmPosToRaw(2), 1) // after a, before the escape run
  assert.equal(map.pmPosToRaw(3), 3) // after the decoded *, before b — raw
  // offset 3 is where 'b' starts: the 2-raw-byte escape collapsed to raw 3,
  // not 4 (a naive "1 visible char = 1 raw char" assumption would wrongly
  // land on raw 2, splitting the escape sequence).
  assert.equal(map.pmPosToRaw(4), 4) // after b (end of content)
  // raw offset 2 (between the backslash and the asterisk) is unmappable —
  // no PM position sits "inside" a decoded escape unit.
  assert.equal(map.rawToPmPos(2), null)
  const beforeB = map.rawToPmPos(3)
  assert.ok(beforeB)
  assert.equal(beforeB.pos, 3)
  assert.equal(beforeB.atom, false)
}

// Case 3: bullet list with a GFM task item. Raw '- 甲\n- [x] 乙\n' indices:
//   -=0 ' '=1 甲=2 \n=3 -=4 ' '=5 [=6 x=7 ]=8 ' '=9 乙=10 \n=11
// mdast: list[0-11] > listItem[0-3] > paragraph[2-3] > text("甲"); and
// listItem[4-11] > paragraph[10-11] > text("乙") (task marker/checkbox is
// stripped from the paragraph's mdast range — the paragraph starts right
// at 乙, offset 10, confirmed by running buildSyntaxIndex directly).
// PM (doc.descendants, pre-order, one open/close token per non-atom node):
//   bullet_list@0 > list_item@1 > paragraph@2 (content start 3) "甲"
//                 > list_item@6 > paragraph@7 (content start 8) "乙"
{
  const md = '- 甲\n- [x] 乙\n'
  const d = doc(schema.node('bullet_list', null, [
    schema.node('list_item', null, [p(text('甲'))]),
    schema.node('list_item', null, [p(text('乙'))])
  ]))
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'list + task: map must build')
  // block sequence: bullet_list, list_item, paragraph(甲), list_item, paragraph(乙)
  assert.equal(map.blockPairs.length, 5)
  assert.equal(map.pmPosToRaw(3), 2) // before 甲
  const rawYi = map.pmPosToRaw(8) // 乙's textblock content start
  assert.equal(rawYi, 10)
  assert.equal(md.slice(rawYi, rawYi + 1), '乙')
  // the task marker "[x] " (raw 6-10) is a gap between blocks — unmappable.
  assert.equal(map.rawToPmPos(7), null)
}

// Case 4: structural mismatch (heading vs paragraph) -> whole map null.
{
  const md = '# 头\n'
  const d = doc(p(text('头'))) // heading vs paragraph: PM_TO_MD rejects
  assert.equal(buildProjectionMap(md, d), null)
}

// Case 5: inline image atom. Raw '前![a](x.png)后\n' indices:
//   前=0 !=1 [=2 a=3 ]=4 (=5 x=6 .=7 p=8 n=9 g=10 )=11 后=12 \n=13
// mdast paragraph children: text("前")[0-1], image[1-12], text("后")[12-13].
// buildCharacterMap units: [char 前:0-1 w1, atom image:1-12 w1, char 后:12-13 w1]
// -> boundaries {0:0, 1:1, 2:12, 3:13}.
// PM: paragraph@0 (content start 1); text("前") is 1 PM unit -> image atom
// at PM pos 2 (content-relative 1); text("后") at PM pos 3 (content-relative 2).
{
  const md = '前![a](x.png)后\n'
  const d = doc(p(text('前'), schema.node('image'), text('后')))
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'inline image atom: map must build')
  assert.equal(md.slice(map.pmPosToRaw(2), map.pmPosToRaw(3)), '![a](x.png)')
  // raw offset strictly inside the atom's markdown syntax (e.g. raw 6, the
  // 'x' of x.png) has no PM interior position — it snaps to the atom's own
  // boundary (atom:true), it does not return null the way an escape's
  // interior does, because the atom IS a valid, indivisible target.
  const snapped = map.rawToPmPos(6)
  assert.ok(snapped)
  assert.equal(snapped.pos, 2)
  assert.equal(snapped.atom, true)
  // exact atom boundaries are plain (non-atom) positions — you can place a
  // caret there, you're not "on" the atom.
  const before = map.rawToPmPos(1)
  assert.equal(before.pos, 2)
  assert.equal(before.atom, false)
  const after = map.rawToPmPos(12)
  assert.equal(after.pos, 3)
  assert.equal(after.atom, false)
}

// --- Review-fix regressions (non-editable leaf class, opaque table, empty
// textblock guard, ordered-flag cross-check) ---

// Case 6: paragraph, non-empty fenced code block, paragraph. Raw indices of
// 'p1\n\n```\nhi\n```\n\np2\n': p=0 1=1 \n=2 \n=3 `=4 `=5 `=6 \n=7 h=8 i=9
// \n=10 `=11 `=12 `=13 \n=14 \n=15 p=16 2=17 \n=18. mdast (kernel run):
// paragraph[0,2), code[4,14), paragraph[16,18).
// PM: paragraph1@0 (content start 1, size 2 -> range [1,3]); code_block@4
// (non-editable: charMap must be null even though it has real content —
// this is the case that used to null the WHOLE map via the content.size
// mismatch); paragraph2@8 (content start 9, size 2 -> range [9,11]).
{
  const md = 'p1\n\n```\nhi\n```\n\np2\n'
  const d = doc(p(text('p1')), schema.node('code_block', null, text('hi')), p(text('p2')))
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'doc containing a non-empty code block must still map')
  assert.equal(map.blockPairs.length, 3)
  assert.equal(map.blockPairs[1].charMap, null, 'code_block pair must be non-editable')
  assert.equal(map.pmPosToRaw(1), 0) // before p1
  assert.equal(map.pmPosToRaw(3), 2) // after p1
  assert.equal(map.pmPosToRaw(9), 16) // before p2
  assert.equal(map.pmPosToRaw(11), 18) // after p2
  assert.equal(map.pmPosToRaw(5), null) // inside the code block's PM content
  assert.equal(map.rawToPmPos(9), null) // raw 9 = 'i' of "hi", inside the fence
}

// Case 7: empty fenced code block ('```\n```\n'). mdast code node has NO
// `.children` at all regardless of whether its `.value` is empty or not —
// buildCharacterMap would return an empty (non-null) units array either
// way, so this case specifically proves the fix isn't just "big code blocks
// null the whole map" but "code blocks never claim a charMap, period" —
// an empty one must NOT silently report its fence position as a valid
// content boundary.
{
  const md = '```\n```\n'
  const d = doc(schema.node('code_block', null, []))
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'doc with only an empty code block must still map (non-editable, not rejected)')
  assert.equal(map.blockPairs.length, 1)
  assert.equal(map.blockPairs[0].charMap, null)
  assert.equal(map.pmPosToRaw(1), null) // content pos of the empty code block
  assert.equal(map.rawToPmPos(2), null) // third backtick of the opening fence
}

// Case 8: empty ATX heading ('#\nP\n') followed by a normal paragraph.
// mdast (kernel run): heading[0,1) with 0 children, paragraph[2,3) "P".
// # =0 \n=1 P=2 \n=3.
// PM: heading@0 (content start 1, EMPTY -> content.size 0, so the
// content.size check alone can't catch this — the empty-textblock guard
// is what forces charMap:null here); paragraph@2 (heading's nodeSize is
// 1+0+1=2, so paragraph follows immediately) content start 3, size 1.
// This locks BOTH halves of the guard: a non-paragraph zero-unit textblock
// is rejected, and a real (non-empty) paragraph elsewhere in the SAME doc
// is unaffected by that rejection.
{
  const md = '#\nP\n'
  const d = doc(schema.node('heading', { level: 1 }, []), p(text('P')))
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'doc with an empty heading must still map')
  assert.equal(map.blockPairs.length, 2)
  assert.equal(map.blockPairs[0].charMap, null, 'empty heading must be non-editable')
  assert.equal(map.pmPosToRaw(1), null) // content pos of the empty heading
  assert.equal(map.rawToPmPos(0), null) // the '#' itself
  assert.equal(map.pmPosToRaw(3), 2) // before P — untouched by the heading fix
  assert.equal(map.pmPosToRaw(4), 3) // after P
}

// Case 8b: the kernel-level guarantee the paragraph branch of the guard
// relies on, proven directly against buildCharacterMap. Real CommonMark
// never emits a genuinely empty (0-child) `paragraph` mdast node — a blank
// line simply isn't a paragraph at all — so buildProjectionMap can never
// actually exercise "md.type === 'paragraph' && units.length === 0" via a
// real document. This proves the fallback it relies on IS correct, using a
// hand-built mdast-shaped node (buildCharacterMap is a pure function of
// `(text, node)`, it doesn't require a real remark parse).
{
  const md = 'X\n'
  const fakeEmptyParagraph = { type: 'paragraph', children: [], position: { start: { offset: 0 }, end: { offset: 0 } } }
  const charMap = buildCharacterMap(md, fakeEmptyParagraph)
  assert.ok(charMap)
  assert.equal(charMap.units.length, 0)
  assert.equal(charMap.visibleLength, 0)
  assert.equal(charMap.visibleToRaw(0), 0) // == the fabricated paragraph's own start offset, correctly
}

// Case 9: 2x2 GFM table treated as one opaque pair, plus a trailing
// paragraph. Raw '| a | b |\n| - | - |\n| c | d |\n\nP\n':
// row1 [0,10) row2 [10,20) row3 [20,30) blank \n@30 'P'@31 \n@32.
// mdast (kernel run): table[0,29) (rows/cells nested inside, not walked),
// paragraph[31,32) "P".
// PM (descendants would normally walk table_row/table_cell/paragraph
// inside the table, but flattenPm stops descending once it records the
// `table` pair) -> table@0 (opaque, charMap null), paragraph@26 (content
// start 27, size 1) — position 26 is whatever ProseMirror's own node
// numbering gives the table's full subtree; irrelevant to pairing since we
// never try to look inside it.
{
  const md = '| a | b |\n| - | - |\n| c | d |\n\nP\n'
  const d = doc(
    schema.node('table', null, [
      schema.node('table_row', null, [
        schema.node('table_cell', null, [p(text('a'))]),
        schema.node('table_cell', null, [p(text('b'))])
      ]),
      schema.node('table_row', null, [
        schema.node('table_cell', null, [p(text('c'))]),
        schema.node('table_cell', null, [p(text('d'))])
      ])
    ]),
    p(text('P'))
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, '2x2 table + paragraph must still map')
  assert.equal(map.blockPairs.length, 2, 'table subtree must not be descended into')
  assert.equal(map.blockPairs[0].charMap, null, 'table pair must be opaque/non-editable')
  assert.equal(map.pmPosToRaw(27), 31) // before P
  assert.equal(map.pmPosToRaw(28), 32) // after P
  assert.equal(map.rawToPmPos(5), null) // inside the table's raw span
}

// Case 10: bullet_list PM paired against ORDERED markdown -> whole map
// null, even though every block type string ('list'/'listItem'/'paragraph')
// still lines up. md = '1. 甲\n2. 乙\n' parses to an mdast `list` with
// `ordered: true` (confirmed by kernel run); pairing it with a PM
// `bullet_list` must be rejected.
{
  const md = '1. 甲\n2. 乙\n'
  const d = doc(schema.node('bullet_list', null, [
    schema.node('list_item', null, [p(text('甲'))]),
    schema.node('list_item', null, [p(text('乙'))])
  ]))
  assert.equal(buildProjectionMap(md, d), null, 'bullet_list vs ordered markdown must reject the whole map')
}

// --- Task 11.5 regressions: trailing placeholder (plugin-trailing), empty
// list items, pending split placeholder, standalone image-block ---

// Case 11: the trailing synthetic paragraph. Crepe's @milkdown/plugin-trailing
// appends an empty paragraph after any doc whose last block is a
// list/table/code/blockquote/hr/html — the live PM doc for '- 甲\n' is
// [bullet_list, <empty paragraph>]. Raw '- 甲\n': -=0 ' '=1 甲=2 \n=3, length
// 4. PM: bullet_list@0 (li@1, p@2 content start 3), trailing p@7 (content
// start 8), doc content size 9.
{
  const md = '- 甲\n'
  const d = doc(
    schema.node('bullet_list', null, [schema.node('list_item', null, [p(text('甲'))])]),
    p()
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'trailing placeholder must be tolerated, not reject the whole map')
  assert.equal(map.blockPairs.length, 4)
  const trailing = map.blockPairs[3]
  assert.equal(trailing.virtual, true)
  assert.equal(trailing.charMap.visibleToRaw(0), 4, 'virtual boundary = raw document end')
  assert.equal(trailing.insertPrefix, '\n', 'one more terminator makes the blank-line separator')
  assert.deepEqual(map.virtualBlockAt(8), { raw: 4, prefix: '\n' })
  assert.equal(map.pmPosToRaw(8), 4)
  const restored = map.rawToPmPos(4)
  assert.ok(restored)
  assert.equal(restored.pos, 8)
  assert.equal(restored.atom, false)
  // Real blocks unaffected by the tolerance.
  assert.equal(map.pmPosToRaw(3), 2)
  assert.equal(map.virtualBlockAt(3), null, 'real blocks are never virtual')
}

// Case 11b: fail-closed for every OTHER surplus shape.
{
  const md = '- 甲\n'
  const bl = () => schema.node('bullet_list', null, [schema.node('list_item', null, [p(text('甲'))])])
  // two extra trailing paragraphs
  assert.equal(buildProjectionMap(md, doc(bl(), p(), p())), null, 'two extra paragraphs must reject')
  // extra NON-empty paragraph at the end
  assert.equal(buildProjectionMap(md, doc(bl(), p(text('x')))), null, 'non-empty surplus paragraph must reject')
  // extra empty paragraph NOT at the end
  assert.equal(buildProjectionMap(md, doc(p(), bl())), null, 'mid-doc surplus paragraph must reject')
  // extra non-paragraph block at the end
  assert.equal(
    buildProjectionMap(md, doc(bl(), schema.node('code_block', null, []))),
    null,
    'non-paragraph surplus must reject'
  )
}

// Case 11c: insertPrefix per document tail shape, including CRLF.
{
  const bl = (s) => schema.node('bullet_list', null, [schema.node('list_item', null, [p(text(s))])])
  // CRLF: '- 甲\r\n' length 5 -> prefix is the dominant '\r\n'.
  const crlf = buildProjectionMap('- 甲\r\n', doc(bl('甲'), p()))
  assert.ok(crlf, 'CRLF doc must map')
  assert.deepEqual(crlf.virtualBlockAt(8), { raw: 5, prefix: '\r\n' })
  // No final newline: '- 甲' length 3 -> a full blank line ('\n\n') is needed.
  const bare = buildProjectionMap('- 甲', doc(bl('甲'), p()))
  assert.ok(bare)
  assert.deepEqual(bare.virtualBlockAt(8), { raw: 3, prefix: '\n\n' })
  // Raw-offset ambiguity at the doc end resolves to the REAL block first:
  // raw 3 is both 甲's text end and the virtual anchor; rawToPmPos walks
  // pairs in document order, so the item's own end wins.
  assert.equal(bare.rawToPmPos(3).pos, 4)
  // Already blank-line-terminated: '- 甲\n\n' length 5 -> no prefix needed.
  const blank = buildProjectionMap('- 甲\n\n', doc(bl('甲'), p()))
  assert.ok(blank)
  assert.deepEqual(blank.virtualBlockAt(8), { raw: 5, prefix: '' })
}

// Case 11d: empty document. '' parses to ZERO mdast blocks while the PM doc
// always holds one empty paragraph (schema minimum) — the same virtual
// pairing makes an empty kernel-mode document editable instead of degraded.
{
  const map = buildProjectionMap('', doc(p()))
  assert.ok(map, 'empty document must map')
  assert.equal(map.blockPairs.length, 1)
  assert.equal(map.blockPairs[0].virtual, true)
  assert.deepEqual(map.virtualBlockAt(1), { raw: 0, prefix: '' })
  assert.equal(map.rawToPmPos(0).pos, 1)
}

// Case 12: empty list item — the byte shape splitListItem's Enter leaves
// ('- \n'). mdast gives the listItem ZERO children; PM's createAndFill fills
// the required empty paragraph in. Raw '- 甲\n- \n': -=0 ' '=1 甲=2 \n=3 -=4
// ' '=5 \n=6, length 7; item 2's contentStart = 6. PM: bullet_list@0, li@1,
// p@2 (甲), li@6, p@7 (empty), trailing p@11 (content start 12).
{
  const md = '- 甲\n- \n'
  const d = doc(
    schema.node('bullet_list', null, [
      schema.node('list_item', null, [p(text('甲'))]),
      schema.node('list_item', null, [p()])
    ]),
    p()
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'empty list item must map')
  assert.equal(map.blockPairs.length, 6)
  const emptyItemParagraph = map.blockPairs[4]
  assert.equal(emptyItemParagraph.virtual, true)
  assert.equal(emptyItemParagraph.charMap.visibleToRaw(0), 6, 'anchored right after the marker + spacing')
  assert.deepEqual(map.virtualBlockAt(8), { raw: 6, prefix: '' })
  assert.equal(map.pmPosToRaw(8), 6)
  assert.equal(map.rawToPmPos(6).pos, 8)
  // The trailing placeholder coexists with the empty-item pairing.
  assert.deepEqual(map.virtualBlockAt(12), { raw: 7, prefix: '\n' })
}

// Case 12b: a BARE marker with no spacing ('-' alone). Typing at its
// "content start" would produce '-x' — not a list item at all — so the pair
// must stay NON-editable (charMap null), while the rest of the doc still
// maps. Raw '- 甲\n-\n': item 2 = [4,5], spacing ''.
{
  const md = '- 甲\n-\n'
  const d = doc(
    schema.node('bullet_list', null, [
      schema.node('list_item', null, [p(text('甲'))]),
      schema.node('list_item', null, [p()])
    ]),
    p()
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'bare-marker empty item must still map the rest of the doc')
  assert.equal(map.blockPairs[4].charMap, null, 'bare-marker item paragraph must be non-editable')
  assert.equal(map.virtualBlockAt(8), null)
  assert.equal(map.pmPosToRaw(8), null)
}

// Case 13: pending split placeholder (editor-kernel-mode's
// ensureSplitPlaceholder). Raw 'P1\n\n\n\nP2\n' (the bytes after Enter at
// the end of 'P1'): P=0 1=1 \n=2 \n=3 \n=4 \n=5 P=6 2=7 \n=8. The caret raw
// offset 4 sits on a blank line NO reparse can represent; the controller
// materializes an empty PM paragraph at pos 4 (after p('P1'), nodeSize 4)
// and vouches for it. WITHOUT the voucher the same doc must reject.
{
  const md = 'P1\n\n\n\nP2\n'
  const d = doc(p(text('P1')), p(), p(text('P2')))
  assert.equal(buildProjectionMap(md, d), null, 'unvouched mid-doc empty paragraph must reject')
  const map = buildProjectionMap(md, d, { pendingPlaceholder: { pmPos: 4, rawOffset: 4 } })
  assert.ok(map, 'vouched split placeholder must map')
  assert.equal(map.blockPairs.length, 3)
  assert.equal(map.blockPairs[1].virtual, true)
  assert.deepEqual(map.virtualBlockAt(5), { raw: 4, prefix: '' })
  assert.equal(map.pmPosToRaw(5), 4)
  assert.equal(map.rawToPmPos(4).pos, 5)
  // Surrounding real paragraphs unaffected.
  assert.equal(map.pmPosToRaw(1), 0)
  assert.equal(map.pmPosToRaw(7), 6)
  // A voucher pointing at a NON-empty paragraph is stale bookkeeping — reject.
  assert.equal(
    buildProjectionMap(md, d, { pendingPlaceholder: { pmPos: 0, rawOffset: 4 } }),
    null,
    'voucher on a non-empty block must reject'
  )
}

// Case 14: standalone image-block. Raw '# t\n\n![a](x.png)\n\n尾\n':
// #=0 ' '=1 t=2 \n=3 \n=4 image [5,16) \n=16 \n=17 尾=18 \n=19. The kernel's
// plugin-free parse keeps the `paragraph > image` wrapper; Crepe's PM doc
// holds a block-level `image-block` atom instead. PM: heading@0 (content
// start 1, 't'), image-block@3 (nodeSize 1), p@4 (content start 5, '尾').
{
  const md = '# t\n\n![a](x.png)\n\n尾\n'
  const d = doc(
    schema.node('heading', { level: 1 }, [text('t')]),
    schema.node('image-block', { src: 'x.png' }),
    p(text('尾'))
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'standalone image-block must map')
  assert.equal(map.blockPairs.length, 3)
  assert.equal(map.blockPairs[1].charMap, null, 'image-block pair must be non-editable')
  assert.equal(map.blockPairs[1].mdBlock.type, 'paragraph', 'pairs the mdast image wrapper paragraph')
  assert.equal(map.pmPosToRaw(1), 2) // before 't'
  assert.equal(map.pmPosToRaw(2), 3) // after 't'
  assert.equal(map.pmPosToRaw(5), 18) // before 尾
  assert.equal(map.pmPosToRaw(6), 19) // after 尾
  assert.equal(map.rawToPmPos(8), null, 'offsets inside the image markdown stay unmappable')
}

// Case 14b: image-block fail-closed — it only ever replaces a paragraph
// whose SINGLE child is an image.
{
  const textMd = '甲乙\n'
  const dImg = doc(schema.node('image-block', { src: 'x.png' }))
  assert.equal(buildProjectionMap(textMd, dImg), null, 'image-block vs text paragraph must reject')
  const mixedMd = '前![a](x.png)后\n'
  assert.equal(buildProjectionMap(mixedMd, dImg), null, 'image-block vs mixed paragraph must reject')
}

// Case 14c: a document ENDING in a standalone image gets the trailing
// placeholder too (image-block is not paragraph/heading) — both fixes
// compose. Raw '![a](x.png)\n' length 12.
{
  const md = '![a](x.png)\n'
  const d = doc(schema.node('image-block', { src: 'x.png' }), p())
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'image-ending doc must map with its trailing placeholder')
  assert.equal(map.blockPairs.length, 2)
  assert.equal(map.blockPairs[1].virtual, true)
  // image-block@0 has nodeSize 1 (atom) -> trailing p@1, content start 2.
  assert.deepEqual(map.virtualBlockAt(2), { raw: 12, prefix: '\n' })
}

console.log('PASS kernel projection map')
