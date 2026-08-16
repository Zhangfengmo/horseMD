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
    code_block: { content: 'text*', group: 'block', code: true, attrs: { language: { default: '' } } },
    table: { content: 'table_row+', group: 'block' },
    table_row: { content: 'table_cell+' },
    table_cell: { content: 'paragraph+' },
    image: { group: 'inline', inline: true, atom: true, attrs: { src: { default: '' } } },
    // Crepe's latex feature: `math_inline` is an inline ATOM carrying the TeX
    // source in `attrs.value` (node_modules/@milkdown/crepe/lib/esm/feature/
    // latex/index.js:98-104) — content.size counts it as 1, exactly like the
    // kernel charMap's width-1 `inlineMath` atom unit.
    math_inline: { group: 'inline', inline: true, atom: true, attrs: { value: { default: '' } } },
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
// (content "hi" size 2, content start 5); paragraph2@8 (content start 9,
// size 2 -> range [9,11]).
//
// Plan 3 Task 3 update: `code_block` now gets a real charMap via
// buildCodeMap (it used to be hardcoded non-editable, see the superseded
// history in editor-kernel-projection-map.js's NON_EDITABLE_LEAF_TYPES
// comment) — this pair's charMap is non-null and its content raw-mapped,
// same as any other textblock. This does NOT make code blocks actually
// editable in the live app yet: `editor-kernel-cm-bridge.js` still enforces
// a REAL CodeMirror `readOnly` facet independent of this map (Plan 3's
// gateway relaxation is a later task) — see docs/... Task 3 report.
{
  const md = 'p1\n\n```\nhi\n```\n\np2\n'
  const d = doc(p(text('p1')), schema.node('code_block', null, text('hi')), p(text('p2')))
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'doc containing a non-empty code block must still map')
  assert.equal(map.blockPairs.length, 3)
  assert.ok(map.blockPairs[1].charMap, 'code_block pair now carries a real charMap')
  assert.equal(map.blockPairs[1].charMap.visibleLength, 2)
  assert.equal(map.pmPosToRaw(1), 0) // before p1
  assert.equal(map.pmPosToRaw(3), 2) // after p1
  assert.equal(map.pmPosToRaw(9), 16) // before p2
  assert.equal(map.pmPosToRaw(11), 18) // after p2
  assert.equal(map.pmPosToRaw(5), 8) // before 'h' (code content start)
  assert.equal(map.pmPosToRaw(6), 9) // between 'h' and 'i'
  assert.equal(map.pmPosToRaw(7), 10) // after "hi" (code content end)
  assert.deepEqual(map.rawToPmPos(9), { pos: 6, atom: false }) // raw 9 = 'i' of "hi"
  assert.deepEqual(map.rawToPmPos(8), { pos: 5, atom: false }) // raw 8 = 'h' of "hi"
}

// Case 7: empty fenced code block ('```\n```\n'). mdast code node has NO
// `.children` at all regardless of whether its `.value` is empty or not —
// buildCharacterMap's `collectUnits` (which only reads `.children`) would
// have returned an empty (non-null) units array either way, a false "proof"
// of alignment that motivated keeping `code_block` non-editable altogether
// (see the superseded history in editor-kernel-projection-map.js's
// NON_EDITABLE_LEAF_TYPES comment). `buildCodeMap` (Plan 3 Task 3) has its
// own dedicated empty-value path instead: it anchors the ONE boundary to
// the real raw content start (right after the open fence line's ending,
// raw 4 here: '```\n' is 4 bytes), which is provably correct rather than a
// coincidence of collectUnits never looking at the payload.
{
  const md = '```\n```\n'
  const d = doc(schema.node('code_block', null, []))
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'doc with only an empty code block must still map')
  assert.equal(map.blockPairs.length, 1)
  assert.ok(map.blockPairs[0].charMap, 'empty code_block still carries a (zero-unit) charMap')
  assert.equal(map.blockPairs[0].charMap.visibleLength, 0)
  assert.equal(map.pmPosToRaw(1), 4) // content pos of the empty code block -> right after '```\n'
  assert.equal(map.rawToPmPos(2), null) // third backtick of the opening fence: unmappable
  assert.deepEqual(map.rawToPmPos(4), { pos: 1, atom: false }) // right after the open fence line
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

// Case 15 (Task 2, plan 3): N trailing empty placeholders, one for each
// repeated Enter inside the split-placeholder chain (editor-kernel-mode's
// `extendTrailingPlaceholder`). Raw 'P1\n\n\n\n\n' (P1 followed by the
// blank-line run TWO Enters-in-a-row write, nothing after): P=0 1=1 \n=2
// \n=3 \n=4 \n=5 \n=6, length 7. PM: p('P1')@0 (nodeSize 4) -> placeholder1
// p()@4 (nodeSize 2) -> placeholder2 p()@6. Each placeholder maps to one
// more trailing raw offset (4, then 5) — "one PM paragraph per trailing
// newline byte" per the plan.
{
  const md = 'P1\n\n\n\n\n'
  const chain = () => doc(p(text('P1')), p(), p())
  const pendingPlaceholders = [{ pmPos: 4, rawOffset: 4 }, { pmPos: 6, rawOffset: 5 }]
  assert.equal(buildProjectionMap(md, chain()), null, 'unvouched N-trailing chain must reject')
  const map = buildProjectionMap(md, chain(), { pendingPlaceholders })
  assert.ok(map, 'a fully vouched N-trailing chain must map')
  assert.equal(map.blockPairs.length, 3)
  assert.equal(map.blockPairs[1].virtual, true)
  assert.equal(map.blockPairs[1].charMap.visibleToRaw(0), 4)
  assert.equal(map.blockPairs[2].virtual, true)
  assert.equal(map.blockPairs[2].charMap.visibleToRaw(0), 5)
  assert.deepEqual(map.virtualBlockAt(5), { raw: 4, prefix: '' }, 'first placeholder')
  assert.deepEqual(map.virtualBlockAt(7), { raw: 5, prefix: '' }, 'second (last) placeholder')
  assert.equal(map.pmPosToRaw(5), 4)
  assert.equal(map.pmPosToRaw(7), 5)
  assert.equal(map.rawToPmPos(4).pos, 5)
  assert.equal(map.rawToPmPos(5).pos, 7)
  // The real block is unaffected by the chain.
  assert.equal(map.pmPosToRaw(1), 0)

  // Fail-closed: a NON-EMPTY node at one of the vouched positions rejects
  // the WHOLE map, not just that one pair.
  const nonEmptyMiddle = doc(p(text('P1')), p(text('x')), p())
  assert.equal(
    buildProjectionMap(md, nonEmptyMiddle, { pendingPlaceholders }),
    null,
    'a non-empty node at a vouched trailing position must reject'
  )

  // Fail-closed: a NON-PARAGRAPH node at one of the vouched positions
  // rejects the whole map too (a `paragraph` is the only type the chain's
  // virtual pairing ever represents).
  const nonParagraph = doc(p(text('P1')), schema.node('code_block', null, []), p())
  assert.equal(
    buildProjectionMap(md, nonParagraph, { pendingPlaceholders }),
    null,
    'a non-paragraph node at a vouched trailing position must reject'
  )

  // Fail-closed: a voucher entry that never matches ANY real PM node (stale
  // bookkeeping — e.g. a pmPos left over from a prior revision) rejects the
  // whole map, even though the FIRST entry would have matched fine on its
  // own.
  const onlyOnePlaceholder = doc(p(text('P1')), p())
  assert.equal(
    buildProjectionMap(md, onlyOnePlaceholder, {
      pendingPlaceholders: [{ pmPos: 4, rawOffset: 4 }, { pmPos: 999, rawOffset: 5 }]
    }),
    null,
    'an unmatched voucher entry must reject the whole map'
  )
}

// Case 15b (review fix): the `pendingPlaceholders` CHAIN form must reject a
// voucher positioned BEFORE real trailing content, even though every
// per-item check (empty paragraph, all entries matched) would otherwise
// pass. Reuses Case 13's exact fixture and numbers ('P1\n\n\n\nP2\n', voucher
// at pmPos 4 / rawOffset 4 — a blank-line gap that sits BETWEEN P1 and P2,
// not after all real content) to prove the distinction is deliberate: the
// SAME shape is accepted via the single-object `pendingPlaceholder` (Case
// 13, `ensureSplitPlaceholder`'s own legitimate mid-document case) but
// rejected via the plural `pendingPlaceholders` chain (only ever meant for
// `extendTrailingPlaceholder`'s trailing-blank chain, which must never
// vouch anything before the document's real content actually ends).
{
  const md = 'P1\n\n\n\nP2\n'
  const d = doc(p(text('P1')), p(), p(text('P2')))
  assert.ok(
    buildProjectionMap(md, d, { pendingPlaceholder: { pmPos: 4, rawOffset: 4 } }),
    'sanity: the singular form still accepts this exact mid-document shape (Case 13)'
  )
  assert.equal(
    buildProjectionMap(md, d, { pendingPlaceholders: [{ pmPos: 4, rawOffset: 4 }] }),
    null,
    'the chain form must reject a voucher positioned before real trailing content (P2)'
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

// --- Plan 3 Task 3: code_block gets a real, prefix-aware charMap ---

// Case 16: editable js code block, two content lines — proves pmPosToRaw
// resolves real raw offsets INTO the code content, including across the
// line break, not just at the pair's own start/end (the way Case 6 above
// only ever probed a single-line block).
// Raw 'p1\n\n```js\nlet a = 1\nlet b = 2\n```\n\np2\n':
// p1 [0,2) \n\n [2,4) '```js' [4,9) \n [9,10) 'let a = 1' [10,19) \n [19,20)
// 'let b = 2' [20,29) \n [29,30) '```' [30,33) \n\n [33,35) p2 [35,37) \n [37]
// (checked against a real remark parse: code node value is exactly
// 'let a = 1\nlet b = 2', 19 chars.)
// PM: paragraph1@0 (nodeSize 4) -> code_block@4 (content 'let a = 1\nlet b = 2'
// size 19, nodeSize 21, content start 5, content end 24) -> paragraph2@25
// (content start 26).
{
  const md = 'p1\n\n```js\nlet a = 1\nlet b = 2\n```\n\np2\n'
  const codeText = 'let a = 1\nlet b = 2'
  const d = doc(
    p(text('p1')),
    schema.node('code_block', { language: 'js' }, text(codeText)),
    p(text('p2'))
  )
  // Deliverable 2's probe, pinned: Milkdown's codeBlockSchema.parseMarkdown
  // runner does `state.addText(node.value)` with NO transformation (verified
  // by reading node_modules/@milkdown/preset-commonmark's source directly),
  // and ProseMirror's `Schema.text()`/`TextNode` do no newline normalization
  // either (verified by reading node_modules/prosemirror-model's source) —
  // so a code_block's PM textContent is byte-identical to the mdast code
  // node's `.value`, no trailing-newline or other discrepancy to account
  // for. This holds for CRLF too, not just LF: remark does not normalize a
  // code node's (or a prose text node's) line endings either — verified
  // against the real parser — so `buildCodeMap`'s `visibleLength` (which by
  // construction always equals `value.length`, see code-map.js's header
  // comment) matches PM's un-normalized `content.size` for BOTH line-ending
  // styles. A CRLF code block is exercised end-to-end below (Case 16b).
  assert.equal(d.child(1).textContent, codeText, 'PM textContent must equal mdast value verbatim')
  assert.equal(d.child(1).content.size, codeText.length)

  const map = buildProjectionMap(md, d)
  assert.ok(map, 'doc with an editable js code block must map')
  assert.equal(map.blockPairs.length, 3)
  const codePair = map.blockPairs[1]
  assert.ok(codePair.charMap, 'js code_block pair must carry a real charMap')
  assert.equal(codePair.charMap.visibleLength, 19)
  assert.equal(map.pmPosToRaw(5), 10) // before 'l' of "let a = 1"
  assert.equal(map.pmPosToRaw(14), 19) // after "let a = 1" (9 chars), before the linebreak
  assert.equal(map.pmPosToRaw(15), 20) // after the linebreak, before 'l' of "let b = 2"
  assert.equal(map.pmPosToRaw(24), 29) // after "let b = 2" (content end)
  assert.deepEqual(map.rawToPmPos(19), { pos: 14, atom: false })
  assert.deepEqual(map.rawToPmPos(20), { pos: 15, atom: false })
  // Round trip across the line break.
  assert.equal(map.pmPosToRaw(map.rawToPmPos(20).pos), 20)
  // Surrounding paragraphs unaffected.
  assert.equal(map.pmPosToRaw(26), 35) // before p2
  assert.equal(map.pmPosToRaw(28), 37) // after p2
}

// Case 16b: CRLF document — the code block is EDITABLE (CRLF un-narrowing,
// 2026-08-17). This case has flipped twice, so the history matters:
//  - originally editable (buildCodeMap's own CRLF math was always correct);
//  - then forced non-editable (Plan 3 Task 4 fix-review ADR, 2026-08-16),
//    because the VENDORED CodeMirrorBlock bridge dropped '\r' from its own
//    position model and could misalign `forwardUpdate`'s PM step positions;
//  - now editable again: `editor-codeblock-crlf.js` fixes that bridge at
//    the source (bijective CM<->PM position map, inserted breaks spelled
//    with the block's dominant ending, LF-normalized `update()` diff,
//    mapped `setSelection`), locked by scripts/test-codeblock-crlf-ui.mjs.
// The identity this case really proves is the one the projection map needs:
// `pm.node.content.size === charMap.visibleLength` for a '\r\n' block —
// remark keeps a code node's line endings verbatim, and buildCodeMap emits
// one width-1 unit per `value` char (the '\r' is its own `char` unit, the
// '\n' the `linebreak` unit).
// md = 'p1\r\n\r\n```js\r\nlet a = 1\r\nlet b = 2\r\n```\r\n\r\np2\r\n'
// 'p1' 0-1 \r\n 2-3 \r\n 4-5 '```js' 6-10 \r\n 11-12 'let a = 1' 13-21 \r\n
// 22-23 'let b = 2' 24-32 \r\n 33-34 '```' 35-37 \r\n 38-39 \r\n 40-41 'p2'
// 42-43 \r\n 44-45. code value 'let a = 1\r\nlet b = 2' (20 chars) ==
// PM textContent exactly (checked directly, same as Case 16's LF pin).
// PM: paragraph1@0 (nodeSize 4) -> code_block@4 (content size 20, nodeSize
// 22, content start 5, content end 25) -> paragraph2@26 (content start 27).
{
  const md = 'p1\r\n\r\n```js\r\nlet a = 1\r\nlet b = 2\r\n```\r\n\r\np2\r\n'
  const codeText = 'let a = 1\r\nlet b = 2'
  const d = doc(
    p(text('p1')),
    schema.node('code_block', { language: 'js' }, text(codeText)),
    p(text('p2'))
  )
  assert.equal(d.child(1).textContent, codeText)
  assert.equal(d.child(1).content.size, codeText.length)
  assert.equal(codeText.length, 20)

  const map = buildProjectionMap(md, d)
  assert.ok(map, 'CRLF doc with a code block must still map')
  assert.equal(map.blockPairs.length, 3)
  const codePair = map.blockPairs[1]
  assert.ok(codePair.charMap, 'CRLF code_block pair must be EDITABLE (charMap present)')
  // THE identity, stated explicitly: PM's own content size equals the
  // kernel's decoded visible length for a CRLF block.
  assert.equal(codePair.charMap.visibleLength, d.child(1).content.size)
  assert.equal(codePair.charMap.visibleLength, 20)
  assert.equal(codePair.charMap.lineEnding, '\r\n')
  assert.equal(codePair.charMap.linePrefix, '')
  // Raw offsets across the CRLF break. Content starts at PM 5 -> raw 13.
  assert.equal(map.pmPosToRaw(5), 13) // before 'l' of "let a = 1"
  assert.equal(map.pmPosToRaw(14), 22) // after "let a = 1", before the '\r'
  assert.equal(map.pmPosToRaw(15), 23) // between '\r' and '\n'
  assert.equal(map.pmPosToRaw(16), 24) // after the break, before 'l' of "let b = 2"
  assert.equal(map.pmPosToRaw(25), 33) // content end
  assert.deepEqual(map.rawToPmPos(24), { pos: 16, atom: false })
  assert.equal(map.pmPosToRaw(map.rawToPmPos(24).pos), 24)
  // Surrounding paragraphs unaffected.
  assert.equal(map.pmPosToRaw(1), 0) // inside p1
  assert.equal(map.pmPosToRaw(27), 42) // before p2
}

// Case 16c: lone-'\r' (classic Mac) document — same un-narrowing, same
// identity. buildCodeMap treats a lone '\r' as a single-char line ending
// (one `linebreak` unit, width 1), so visibleLength still equals value.length
// and therefore PM's content.size.
// md = '```js\rlet a = 1\rlet b = 2\r```\r'
// '```js' 0-4 \r 5 'let a = 1' 6-14 \r 15 'let b = 2' 16-24 \r 25 '```' 26-28
{
  const md = '```js\rlet a = 1\rlet b = 2\r```\r'
  const codeText = 'let a = 1\rlet b = 2'
  const d = doc(schema.node('code_block', { language: 'js' }, text(codeText)), p())
  assert.equal(codeText.length, 19)
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'lone-CR doc with a code block must map')
  const codePair = map.blockPairs[0]
  assert.ok(codePair.charMap, 'lone-CR code_block pair must be EDITABLE')
  assert.equal(codePair.charMap.visibleLength, d.child(0).content.size)
  assert.equal(codePair.charMap.visibleLength, 19)
  assert.equal(codePair.charMap.lineEnding, '\r')
  assert.equal(map.pmPosToRaw(1), 6) // content start
  assert.equal(map.pmPosToRaw(11), 16) // just after the '\r' break
}

// Case 16d: a '> '-quoted CRLF fence — the prefix-bearing shape. Proves the
// same identity holds when every content line carries a quote prefix, and
// that the '\n' half of the break is the unit that ALSO spans the next
// line's prefix bytes (what makes the gateway's per-break prefix expansion
// and a cross-line delete both land byte-exactly).
// md = '> ```js\r\n> a\r\n> b\r\n> ```\r\n'
// '>' 0 ' ' 1 '```js' 2-6 \r 7 \n 8 '>' 9 ' ' 10 'a' 11 \r 12 \n 13
// '>' 14 ' ' 15 'b' 16 \r 17 \n 18 ...
{
  const md = '> ```js\r\n> a\r\n> b\r\n> ```\r\n'
  const codeText = 'a\r\nb'
  const d = doc(
    schema.node('blockquote', null, [schema.node('code_block', { language: 'js' }, text(codeText))]),
    p()
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'quoted CRLF fence doc must map')
  const codePair = map.blockPairs.find((pair) => pair.pmNode.type.name === 'code_block')
  assert.ok(codePair.charMap, 'quoted CRLF code_block pair must be EDITABLE')
  assert.equal(codePair.charMap.visibleLength, codePair.pmNode.content.size)
  assert.equal(codePair.charMap.visibleLength, 4)
  assert.equal(codePair.charMap.lineEnding, '\r\n')
  assert.equal(codePair.charMap.linePrefix, '> ')
  // content start (PM 2) -> raw 11 ('a'); the break's two halves -> 12/13;
  // the '\n' unit's raw span reaches over '> ' so 'b' lands at 16.
  assert.equal(map.pmPosToRaw(2), 11)
  assert.equal(map.pmPosToRaw(3), 12)
  assert.equal(map.pmPosToRaw(4), 13)
  assert.equal(map.pmPosToRaw(5), 16)
}

// Case 17: a ```mermaid code block stays non-editable even though
// buildCodeMap could map it just fine — Crepe renders it as a diagram
// PREVIEW (editor-crepe-setup.js's codeBlockConfig.renderPreview), not
// literal text, so the kernel must never offer a raw-text edit path into
// it. Matched case-insensitively against the PM node's own attrs.language.
{
  const md = 'p1\n\n```mermaid\ngraph TD\n```\n\np2\n'
  const d = doc(
    p(text('p1')),
    schema.node('code_block', { language: 'mermaid' }, text('graph TD')),
    p(text('p2'))
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'doc with a mermaid code block must still map')
  assert.equal(map.blockPairs.length, 3)
  assert.equal(map.blockPairs[1].charMap, null, 'mermaid code_block pair must stay non-editable')
  // Language match is case-insensitive.
  const upper = doc(
    p(text('p1')),
    schema.node('code_block', { language: 'MERMAID' }, text('graph TD')),
    p(text('p2'))
  )
  assert.equal(buildProjectionMap(md, upper).blockPairs[1].charMap, null)
}

// Case 18: the math/latex shape. Crepe's own math-block feature
// (@milkdown/crepe's blockLatexSchema, verified by reading its source)
// literally REUSES the plain codeBlockSchema for a `$$...$$` block — on the
// PM side, a math block IS a `code_block` with `attrs.language === 'latex'`,
// indistinguishable in shape from a real ```latex code fence. That's the
// half of the guard this test can exercise with a REAL parse: the kernel's
// own buildSyntaxIndex (syntax-index.js) registers only remark-parse +
// remark-gfm, no remark-math, so it can never itself produce an mdast
// `math` node to pair against — `md.type === 'math'` in
// editor-kernel-projection-map.js's codeReadOnly check is accordingly a
// defensive/forward-compatible branch, unreachable via today's kernel
// parser (documented here so the next reader doesn't mistake the missing
// coverage for an oversight).
{
  const md = 'p1\n\n```latex\nx^2\n```\n\np2\n'
  const d = doc(
    p(text('p1')),
    schema.node('code_block', { language: 'latex' }, text('x^2')),
    p(text('p2'))
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'doc with a latex-language code block must still map')
  assert.equal(map.blockPairs.length, 3)
  assert.equal(map.blockPairs[1].charMap, null, 'latex-language code_block pair must stay non-editable')
}

// Case 19 (final-review finding, 2026-08-16): `buildCodeMap` returning null
// for ONE code pair must degrade only THAT pair, never reject the whole map.
// Fixture: a quoted fence whose blank content line is written as a bare '>'
// (no trailing space) instead of '> ' — buildCodeMap's own per-line prefix
// check ('> ') can't reproduce that line byte-for-byte, so it fails closed
// for this block (verified against the real parser: remark still parses
// this as ONE blockquote > code node spanning the bare '>' line, value
// 'a\n\nb'), followed by an ordinary trailing paragraph that must stay fully
// mappable and editable.
// md = '> ```py\n> a\n>\n> b\n> ```\n\n尾\n'
{
  const md = '> ```py\n> a\n>\n> b\n> ```\n\n尾\n'
  const d = doc(
    schema.node('blockquote', null, [
      schema.node('code_block', { language: 'py' }, text('a\n\nb'))
    ]),
    p(text('尾'))
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'a doc with one unmappable quoted-fence pair must still map overall')
  // blockquote (container, its own structural slot) -> code_block -> paragraph.
  assert.equal(map.blockPairs.length, 3)
  const codePair = map.blockPairs[1]
  assert.equal(codePair.pmNode.type.name, 'code_block')
  assert.ok(codePair.mdBlock, 'the pair itself is still structurally recorded, just non-editable')
  assert.equal(codePair.charMap, null, 'the unmappable quoted fence stays non-editable')
  const paraPair = map.blockPairs[2]
  assert.equal(paraPair.pmNode.type.name, 'paragraph')
  assert.ok(paraPair.charMap, 'the unrelated trailing paragraph stays fully editable')
  assert.equal(map.pmPosToRaw(paraPair.pmPos + 1), md.indexOf('尾'), 'the paragraph maps correctly')
}

// --- P4-3.5 headline regression: a document CONTAINING a multi-char inline
// code span must map end-to-end. Before the fix, character-map.js collapsed
// the whole `` `code` `` span to ONE width-1 atom unit while PM keeps a
// 4-char marked text run — `content.size === visibleLength` failed for the
// paragraph and the WHOLE document degraded at attach (reviewer-probed,
// pre-existing since Plan 2). Raw 'a `code` b\n': a=0 sp=1 `=2 c=3 o=4 d=5
// e=6 `=7 sp=8 b=9 \n=10. Visible 'a code b' (8 chars, contentPos 1).
{
  const md = 'a `code` b\n'
  const d = doc(p(text('a code b'))) // marks don't affect content.size; the
  // schema here has none — the identity check is a pure size comparison.
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'doc with a multi-char code span must map (attach-degradation fix)')
  // PM pos 3 = visible boundary 2 (right before rendered 'c'). The
  // gap-before caret convention resolves it to raw 2 (before the opening
  // backtick); the gap-aware range START resolves to raw 3 (the content
  // itself) — same split as strong/emphasis markers.
  assert.equal(map.pmPosToRaw(3), 2)
  assert.equal(map.pmPosToRawStart(3), 3)
  assert.equal(map.pmPosToRaw(7), 7) // after 'e' (code content end, before `)
  assert.equal(map.pmPosToRaw(8), 9) // after the space following the span
  assert.equal(map.pmPosToRaw(9), 10) // content end (after 'b')
  // caret restore into the code content works per-char
  assert.deepEqual(map.rawToPmPos(5), { pos: 5, atom: false })
  // both edges of the opening-backtick gap collapse onto the same PM
  // boundary (pos 3) — the marker has no PM interior.
  assert.deepEqual(map.rawToPmPos(2), { pos: 3, atom: false })
  assert.deepEqual(map.rawToPmPos(3), { pos: 3, atom: false })
}

// Same, with a second real paragraph after it — the doc-wide degradation was
// the bug, so pin that OTHER blocks stay mapped too.
{
  const md = 'a `code` b\n\n甲乙\n'
  const d = doc(p(text('a code b')), p(text('甲乙')))
  const map = buildProjectionMap(md, d)
  assert.ok(map)
  assert.equal(map.blockPairs.length, 2)
  // paragraph2 pmPos 10, contentPos 11; raw: 甲=12 乙=13.
  assert.equal(map.pmPosToRaw(11), 12) // before 甲
  assert.equal(map.pmPosToRaw(12), 13) // between 甲 and 乙
}

// ---- Math domain (Plan 5 Task 1): the degradation-healing headline ----
//
// Before the kernel chain gained remark-math, a document containing math
// could not be mapped AT ALL:
//   - `an $x^2$ formula` parsed to ONE text node (visibleLength 16) while PM
//     had [text, math_inline atom, text] (content.size 12) -> the
//     `content.size !== charMap.visibleLength` check nulled the WHOLE map.
//   - `$$\nE=mc^2\n$$` parsed to a single PARAGRAPH (the `$$` lines don't
//     break a paragraph without the extension) while PM had a `code_block`
//     (language 'LaTeX') -> `PM_TO_MD.code_block` has no 'paragraph' entry,
//     so the allowed-type check nulled the WHOLE map.
// Both healed by pairing the real math nodes. Block math stays NON-EDITABLE
// (charMap null) — it occupies a structural slot so every OTHER block in the
// document keeps its own map.
const mi = (value) => schema.node('math_inline', { value })
const cbl = (language, s) => schema.node('code_block', { language }, s ? [text(s)] : [])

// Case M1: one document with BOTH inline and block math plus ordinary
// paragraphs. Raw offsets of 'a $x$ b\n\n$$\nE=mc^2\n$$\n\n甲乙\n':
//   a0 sp1 $2 x3 $4 sp5 b6 \n7 | \n8 | $9 $10 \n11 | E12..^17 2^18? -> the
//   math node's own position is [9,21]; blank \n22; 甲23 乙24 \n25.
// PM: paragraph1 pos 0 (content 'a '(2) + atom(1) + ' b'(2) = 5, nodeSize 7);
// code_block pos 7 (content 'E=mc^2' = 6, nodeSize 8); paragraph2 pos 15
// (content start 16).
{
  const md = 'a $x$ b\n\n$$\nE=mc^2\n$$\n\n甲乙\n'
  const d = doc(
    p(text('a '), mi('x'), text(' b')),
    cbl('LaTeX', 'E=mc^2'),
    p(text('甲乙'))
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'math-bearing document must map (this is the degradation fix)')
  assert.equal(map.blockPairs.length, 3)

  // Block math: paired, but never editable.
  assert.equal(map.blockPairs[1].mdBlock.type, 'math')
  assert.equal(map.blockPairs[1].pmNode.type.name, 'code_block')
  assert.equal(map.blockPairs[1].charMap, null, 'block math stays non-editable')
  assert.equal(map.pmPosToRaw(8), null, 'no offset inside block math resolves')

  // Inline math paragraph: fully mapped, the `$...$` bytes are ONE atom.
  assert.equal(map.pmPosToRaw(1), 0)   // before 'a'
  assert.equal(map.pmPosToRaw(3), 2)   // atom left edge (before the opening $)
  assert.equal(map.pmPosToRaw(4), 5)   // atom right edge (after the closing $)
  assert.equal(map.pmPosToRaw(6), 7)   // end of the paragraph
  // raw 2 is simultaneously the PRECEDING char unit's end and the atom's
  // start; the units walk resolves it through whichever unit it reaches
  // first, so the boundary reports `atom:false` (same long-standing
  // convention as an inline image preceded by text — the PM position is
  // identical either way).
  assert.deepEqual(map.rawToPmPos(2), { pos: 3, atom: false })
  assert.deepEqual(map.rawToPmPos(3), { pos: 3, atom: true }) // interior snaps to the atom
  assert.deepEqual(map.rawToPmPos(5), { pos: 4, atom: false })

  // The paragraph AFTER the math block is editable — the whole point.
  assert.equal(map.pmPosToRaw(16), 23)
  assert.equal(map.pmPosToRaw(17), 24)
  assert.equal(map.pmPosToRaw(18), 25)
  assert.deepEqual(map.rawToPmPos(24), { pos: 17, atom: false })
}

// Case M2: quoted block math. mdast `blockquote > math` [2,18] pairs against
// PM `blockquote > code_block(LaTeX)`; the quote occupies a slot, the math a
// non-editable one, and a following paragraph still maps.
{
  const md = '> $$\n> E=mc^2\n> $$\n\n甲\n'
  const d = doc(
    schema.node('blockquote', null, [cbl('LaTeX', 'E=mc^2')]),
    p(text('甲'))
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'quoted block math must map')
  assert.equal(map.blockPairs.length, 3)
  assert.equal(map.blockPairs[1].mdBlock.type, 'math')
  assert.equal(map.blockPairs[1].charMap, null)
  // '> $$\n> E=mc^2\n> $$\n' is 19 bytes, blank line 19, 甲 20.
  assert.equal(map.pmPosToRaw(map.blockPairs[2].pmPos + 1), 20)
}

// Case M3: list-embedded INLINE math. '- item $x$ math\n':
//   '-'0 sp1 i2..m6 sp7? -> paragraph [2,15]; text 'item ' [2,7], atom
//   [7,10), text ' math' [10,15].
// PM: bullet_list 0, list_item 1, paragraph 2 (content start 3).
{
  const md = '- item $x$ math\n'
  const d = doc(schema.node('bullet_list', null, [
    schema.node('list_item', null, [p(text('item '), mi('x'), text(' math'))])
  ]))
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'list-embedded inline math must map')
  assert.equal(map.pmPosToRaw(3), 2)   // before 'i'
  assert.equal(map.pmPosToRaw(8), 7)   // atom left edge
  assert.equal(map.pmPosToRaw(9), 10)  // atom right edge
  assert.equal(map.pmPosToRaw(14), 15) // end of the item's paragraph
}

// Case M4: heading + strong containing inline math — the atom coexists with
// marker gaps (`**`) inside the same charMap.
{
  const md = '# head $x$ tail\n\n**bold $y$ end**\n'
  const d = doc(
    schema.node('heading', { level: 1 }, [text('head '), mi('x'), text(' tail')]),
    p(text('bold '), mi('y'), text(' end'))
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'heading/strong with inline math must map')
  assert.equal(map.pmPosToRaw(1), 2)   // heading content start (after '# ')
  assert.equal(map.pmPosToRaw(6), 7)   // atom left edge
  assert.equal(map.pmPosToRaw(7), 10)  // atom right edge
  // paragraph2 pos 13 (heading nodeSize 1+11+1 = 13), content start 14.
  // raw: '**bold $y$ end**' starts at 17; strong content 'bold ' at 19.
  assert.equal(map.pmPosToRaw(14), 19)
  assert.equal(map.pmPosToRaw(19), 24) // atom left edge ($y$ at [24,27))
  assert.equal(map.pmPosToRaw(20), 27) // atom right edge
}

// Case M5: the `$5 and $6` currency shape. remark-math (default options, the
// SAME instance and options Crepe's latex feature mounts) reads it as inline
// math, so PM has a math_inline atom there too — the kernel must agree, or
// the document degrades. Pinned as a pairing, not as "currency is text".
{
  const md = '$5 and $6\n'
  const d = doc(p(mi('5 and '), text('6')))
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'currency-shaped inline math must still map (kernel follows the editor chain)')
  assert.equal(map.pmPosToRaw(1), 0)
  assert.equal(map.pmPosToRaw(2), 8)
  assert.equal(map.pmPosToRaw(3), 9)
}

// Case M6: fail-closed is preserved — a PM doc that DISAGREES with the
// kernel's math parse (a plain text node where the kernel proved an atom)
// still rejects the whole map rather than guessing.
{
  const md = 'a $x$ b\n'
  const map = buildProjectionMap(md, doc(p(text('a $x$ b'))))
  assert.equal(map, null, 'PM/kernel disagreement about math still fails closed')
}

console.log('PASS kernel projection map')
