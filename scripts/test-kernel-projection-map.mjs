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
    // Mirrors @milkdown/preset-gfm's real table nodes (lib/index.js:88-280):
    // `table_header_row table_row+`, `(table_header)*` / `(table_cell)*`, and
    // `cellContent: 'paragraph'` — the 4th container level that mdast's
    // 3-level table has no counterpart for. The `table` content expression is
    // widened to `(table_header_row | table_row)+` only so this file can also
    // BUILD the header-less shape it pins as a refusal.
    table: { content: '(table_header_row | table_row)+', group: 'block' },
    table_header_row: { content: '(table_header)*' },
    table_row: { content: '(table_cell)*' },
    table_header: { content: 'paragraph+', attrs: { alignment: { default: 'left' } } },
    table_cell: { content: 'paragraph+', attrs: { alignment: { default: 'left' } } },
    image: { group: 'inline', inline: true, atom: true, attrs: { src: { default: '' } } },
    // Crepe's latex feature: `math_inline` is an inline ATOM carrying the TeX
    // source in `attrs.value` (node_modules/@milkdown/crepe/lib/esm/feature/
    // latex/index.js:98-104) — content.size counts it as 1, exactly like the
    // kernel charMap's width-1 `inlineMath` atom unit.
    math_inline: { group: 'inline', inline: true, atom: true, attrs: { value: { default: '' } } },
    // preset-commonmark's `html` node (node/html.ts): an INLINE atom carrying
    // the raw fragment in `attrs.value`. There is no block-level html node in
    // the live schema — `remarkHtmlTransformer` wraps a block-level mdast
    // `html` in a paragraph holding this same inline atom.
    html: { group: 'inline', inline: true, atom: true, attrs: { value: { default: '' } } },
    // preset-commonmark's hard break — `brToBreakRemarkPlugin`
    // (editor-tablebreak.js) rewrites every inline `<br>` html node into one.
    hard_break: { group: 'inline', inline: true, atom: true },
    // Crepe's standalone-image block (@milkdown/components image-block): a
    // block-level ATOM whose mdast counterpart (in the kernel's plugin-free
    // parse) is the plain `paragraph > image` wrapper.
    'image-block': { group: 'block', atom: true, attrs: { src: { default: '' } } },
    // YAML front matter (editor-frontmatter.js `frontmatterSchema`): a
    // block-level ATOM holding the raw YAML in `attrs.value`, whose
    // `parseMarkdown.match` is `node.type === 'yaml'`. Declared with the same
    // `atom/isolating/defining` flags the real schema uses; `atom` is the one
    // that matters here — it makes `isTextblock` false, which is what keeps
    // the pair read-only.
    frontmatter: { group: 'block', atom: true, isolating: true, defining: true, attrs: { value: { default: '' } } },
    // preset-commonmark's thematic break — needed by the front-matter negative
    // control (a mid-document `---` must NOT be read as front matter).
    hr: { group: 'block', atom: true },
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

// Case 9 (HEADLINE, Plan 5 Task 4): a 2x2 GFM table's CELLS are editable, and
// the trailing paragraph keeps its own map. Raw
// '| a | b |\n| - | - |\n| c | d |\n\nP\n':
//   header row [0,9)  cells [0,4)'| a ' [4,9)'| b |'  texts [2,3) [6,7)
//   delimiter  [10,19) '| - | - |' — NO mdast node, recovered from the bytes
//   body row  [20,29) cells [20,24) [24,29)          texts [22,23) [26,27)
//   blank \n@30, 'P'@31, \n@32
// PM (4 levels): table@0; header row [1,13), body row [13,25); each cell's
// PARAGRAPH at 3 / 8 / 15 / 20 (content positions 4 / 9 / 16 / 21); the table
// node itself is [0,26), so the trailing paragraph is at 26 (content 27).
// The document-level zip still records the table as ONE slot on each side —
// the interior is zipped by lib/source-kernel/table-map.js, which consumes the
// extra PM `paragraph` level by pairing it with the mdast `tableCell`.
{
  const md = '| a | b |\n| - | - |\n| c | d |\n\nP\n'
  const cell = (name, s) => schema.node(name, null, [p(text(s))])
  const d = doc(
    schema.node('table', null, [
      schema.node('table_header_row', null, [cell('table_header', 'a'), cell('table_header', 'b')]),
      schema.node('table_row', null, [cell('table_cell', 'c'), cell('table_cell', 'd')])
    ]),
    p(text('P'))
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, '2x2 table + paragraph must map')
  assert.equal(map.blockPairs.length, 5, 'four cell pairs + the trailing paragraph')
  assert.deepEqual(map.blockPairs.slice(0, 4).map((pair) => pair.pmPos), [3, 8, 15, 20])
  assert.deepEqual(map.blockPairs.slice(0, 4).map((pair) => pair.mdBlock.type),
    ['tableCell', 'tableCell', 'tableCell', 'tableCell'])
  for (const pair of map.blockPairs.slice(0, 4)) {
    assert.ok(pair.charMap, 'every cell pair must be EDITABLE')
    assert.equal(pair.tableCell, true)
    assert.equal(pair.charMap.visibleLength, 1)
  }
  // Cell content positions resolve to the cell's own bytes.
  assert.equal(map.pmPosToRaw(4), 2) // before 'a'
  assert.equal(map.pmPosToRaw(5), 3) // after 'a'
  assert.equal(map.pmPosToRaw(9), 6) // before 'b'
  assert.equal(map.pmPosToRaw(16), 22) // before 'c'
  assert.equal(map.pmPosToRaw(21), 26) // before 'd'
  assert.equal(map.rawToPmPos(2).pos, 4)
  assert.equal(map.rawToPmPos(26).pos, 21)
  // The `|` delimiters and padding are GAP bytes: no PM position at all.
  assert.equal(map.rawToPmPos(5), null)
  assert.equal(map.rawToPmPos(0), null)
  // The delimiter row is untouchable — no pair covers any of its bytes.
  for (let raw = 10; raw <= 19; raw += 1) assert.equal(map.rawToPmPos(raw), null)
  // …and the rest of the document is unchanged.
  assert.equal(map.pmPosToRaw(27), 31) // before P
  assert.equal(map.pmPosToRaw(28), 32) // after P
}

// Case 9b: a table shape the cell zip does NOT recognize (here: a PM table
// whose first row is a plain `table_row`, i.e. not the header row preset-gfm
// always produces) degrades to the pre-Task-4 single opaque pair — and the
// rest of the document keeps its map.
{
  const md = '| a | b |\n| - | - |\n| c | d |\n\nP\n'
  const row = (...cells) => schema.node('table_row', null, cells)
  const cell = (s) => schema.node('table_cell', null, [p(text(s))])
  const d = doc(
    schema.node('table', null, [row(cell('a'), cell('b')), row(cell('c'), cell('d'))]),
    p(text('P'))
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'an unrecognized table shape must not null the whole map')
  assert.equal(map.blockPairs.length, 2, 'the table degrades back to ONE opaque pair')
  assert.equal(map.blockPairs[0].pmNode.type.name, 'table')
  assert.equal(map.blockPairs[0].charMap, null, 'table pair is opaque/non-editable')
  assert.ok(map.blockPairs[1].charMap, 'the rest of the document stays editable')
  assert.equal(map.pmPosToRaw(27), 31)
  assert.equal(map.rawToPmPos(5), null)
}

// Case 9c: a RAGGED table (a body row with fewer cells than the delimiter row
// declares) degrades the whole table — ProseMirror's table model is
// rectangular by intent, so this module refuses to claim it knows the PM
// shape. The rest of the document stays editable.
{
  const md = '| a | b |\n| - | - |\n| c |\n\nP\n'
  const d = doc(
    schema.node('table', null, [
      schema.node('table_header_row', null, [
        schema.node('table_header', null, [p(text('a'))]),
        schema.node('table_header', null, [p(text('b'))])
      ]),
      schema.node('table_row', null, [schema.node('table_cell', null, [p(text('c'))])])
    ]),
    p(text('P'))
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'a ragged table must not null the whole map')
  assert.equal(map.blockPairs.length, 2)
  assert.equal(map.blockPairs[0].charMap, null, 'the ragged table is non-editable')
  assert.ok(map.blockPairs[1].charMap, 'the rest of the document stays editable')
}

// Case 9d: PER-CELL degradation. A `<br>` cell and an escaped-`\|` cell are
// each kept read-only (Plan 5 Task 4 scope), but their SIBLING cells — and
// every other block — stay editable. The table itself is NOT degraded.
{
  const md = '| a<br>b | c |\n| - | - |\n| d | e |\n\nP\n'
  const d = doc(
    schema.node('table', null, [
      schema.node('table_header_row', null, [
        schema.node('table_header', null, [p(text('a'), schema.node('hard_break'), text('b'))]),
        schema.node('table_header', null, [p(text('c'))])
      ]),
      schema.node('table_row', null, [
        schema.node('table_cell', null, [p(text('d'))]),
        schema.node('table_cell', null, [p(text('e'))])
      ])
    ]),
    p(text('P'))
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, '<br> table must map')
  assert.equal(map.blockPairs.length, 5)
  assert.equal(map.blockPairs[0].charMap, null, 'the <br> cell degrades')
  assert.ok(map.blockPairs[1].charMap, 'its sibling stays editable')
  assert.ok(map.blockPairs[2].charMap)
  assert.ok(map.blockPairs[3].charMap)
  assert.ok(map.blockPairs[4].charMap, 'the trailing paragraph stays editable')
}
{
  const md = '| a\\|b | c |\n| - | - |\n| d | e |\n\nP\n'
  const d = doc(
    schema.node('table', null, [
      schema.node('table_header_row', null, [
        schema.node('table_header', null, [p(text('a|b'))]),
        schema.node('table_header', null, [p(text('c'))])
      ]),
      schema.node('table_row', null, [
        schema.node('table_cell', null, [p(text('d'))]),
        schema.node('table_cell', null, [p(text('e'))])
      ])
    ]),
    p(text('P'))
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'escaped-pipe table must map')
  assert.equal(map.blockPairs[0].charMap, null, 'the escaped cell degrades')
  assert.ok(map.blockPairs[1].charMap, 'its sibling stays editable')
  assert.ok(map.blockPairs[4].charMap, 'the trailing paragraph stays editable')
}

// Case 9e (review finding, 2026-08-17): TRAILING WHITESPACE — on a row and on
// the delimiter row — must not cost editability. An mdast last-cell position
// runs to the end of the ROW, so a stray space after the closing `|` used to
// leave the delimiter inside the cell's content region (that cell degraded);
// and `DELIMITER_RE` had no trailing `[ \t]*`, so a stray space on the
// delimiter row degraded the WHOLE table. Both are byte shapes every editor
// (this one included) produces routinely.
{
  const cellsOf = (a, b, c, d) => schema.node('table', null, [
    schema.node('table_header_row', null, [
      schema.node('table_header', null, [p(text(a))]),
      schema.node('table_header', null, [p(text(b))])
    ]),
    schema.node('table_row', null, [
      schema.node('table_cell', null, [p(text(c))]),
      schema.node('table_cell', null, [p(text(d))])
    ])
  ])
  for (const [label, md] of [
    ['row-trailing whitespace', '| a | b |   \n| - | - |\n| c | d |\n\nP\n'],
    ['row-trailing tab', '| a | b |\t\n| - | - |\n| c | d |\n\nP\n'],
    ['body-row trailing whitespace', '| a | b |\n| - | - |\n| c | d |  \n\nP\n'],
    ['delimiter-row trailing whitespace', '| a | b |\n| - | - |   \n| c | d |\n\nP\n']
  ]) {
    const map = buildProjectionMap(md, doc(cellsOf('a', 'b', 'c', 'd'), p(text('P'))))
    assert.ok(map, `${label}: map must build`)
    assert.equal(map.blockPairs.length, 5, `${label}: four cell pairs + the paragraph`)
    for (let index = 0; index < 4; index += 1) {
      assert.ok(map.blockPairs[index].charMap, `${label}: cell ${index} must stay EDITABLE`)
      assert.equal(map.blockPairs[index].charMap.visibleLength, 1)
    }
    assert.ok(map.blockPairs[4].charMap, `${label}: the paragraph stays editable`)
  }
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

// Case 17 (REWRITTEN 2026-08-18): a ```mermaid code block is EDITABLE.
//
// This case used to assert the opposite, on the grounds that Crepe renders
// the block as a diagram PREVIEW rather than literal text. See the ADR that
// replaced `READONLY_CODE_LANGUAGES` in editor-kernel-projection-map.js: the
// preview panel is a Vue-rendered SIBLING of the always-mounted CodeMirror
// host, so it contributes nothing to `pmNode.content.size`/`textContent` and
// nothing to the mdast — i.e. it is outside the subject of every proof this
// module makes. The block's PM content is `state.addText(node.value)`
// verbatim, exactly like a ```js block's.
//
// What must therefore hold: the pair carries a REAL charMap whose boundaries
// are the fence CONTENT's own bytes, so a write into it lands inside the
// fence and never on a delimiter.
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
  const pair = map.blockPairs[1]
  assert.ok(pair.charMap, 'mermaid code_block pair must now be editable')
  assert.equal(pair.charMap.visibleLength, 'graph TD'.length)
  // Content start/end are the fence CONTENT's bytes, never the ``` markers.
  assert.equal(md.slice(pair.charMap.visibleToRaw(0)), 'graph TD\n```\n\np2\n')
  assert.equal(md.slice(pair.charMap.visibleToRaw(8)), '\n```\n\np2\n')
  // The caret at the block's PM content start resolves into the fence body.
  assert.equal(map.pmPosToRaw(pair.pmPos + 1), md.indexOf('graph TD'))
  // Language case does not matter — nothing keys off the language any more.
  const upper = doc(
    p(text('p1')),
    schema.node('code_block', { language: 'MERMAID' }, text('graph TD')),
    p(text('p2'))
  )
  assert.ok(buildProjectionMap(md, upper).blockPairs[1].charMap)
}

// Case 17b: a CRLF mermaid fence, including a multi-line diagram. The
// `content.size === visibleLength` identity has to hold for '\r\n' too (see
// the code_block branch's own ADR) or the pair would silently degrade.
{
  const md = 'p1\r\n\r\n```mermaid\r\ngraph TD\r\nA-->B\r\n```\r\n'
  const d = doc(
    p(text('p1')),
    schema.node('code_block', { language: 'mermaid' }, text('graph TD\r\nA-->B'))
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'CRLF mermaid doc must map')
  const pair = map.blockPairs[1]
  assert.ok(pair.charMap, 'CRLF mermaid pair must be editable')
  assert.equal(pair.charMap.visibleLength, 'graph TD\r\nA-->B'.length)
  assert.equal(pair.charMap.lineEnding, '\r\n')
}

// Case 18 (REWRITTEN 2026-08-18): the two shapes that share PM
// `code_block(language='LaTeX')` are BOTH editable, and each is mapped
// against its OWN raw bytes — which is what makes serving them safe.
//
// Crepe's math-block feature (@milkdown/crepe's blockLatexSchema +
// `visitMathBlock`) reuses the plain codeBlockSchema for a `$$...$$` block,
// so on the PM side a math block is indistinguishable in shape from a real
// ```latex fence. The projection map never has to tell them apart from the PM
// node: the pairing is positional and each pair's offsets come from its own
// mdast node, so a `$$` pair's boundaries are the `$$` block's bytes and a
// fence pair's are the fence's. `md.type` is recorded here only to prove the
// two fixtures really are the two different shapes.
//
// The kernel's chain DOES mount remark-math (syntax-index.js, Plan 5 Task 1),
// so the `math` branch is reachable with a real parse — the old comment here
// claiming otherwise was stale.
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
  assert.equal(map.blockPairs[1].mdBlock.type, 'code')
  assert.ok(map.blockPairs[1].charMap, 'a literal ```latex FENCE must be editable')
  assert.equal(map.blockPairs[1].charMap.visibleLength, 3)
  assert.equal(map.pmPosToRaw(map.blockPairs[1].pmPos + 1), md.indexOf('x^2'))

  // Same PM shape, but the raw bytes are a `$$` block -> mdast `math`.
  const mathMd = 'p1\n\n$$\nx^2\n$$\n\np2\n'
  const mathMap = buildProjectionMap(mathMd, doc(
    p(text('p1')),
    schema.node('code_block', { language: 'LaTeX' }, text('x^2')),
    p(text('p2'))
  ))
  assert.ok(mathMap, 'doc with a $$ math block must still map')
  const mathPair = mathMap.blockPairs[1]
  assert.equal(mathPair.mdBlock.type, 'math')
  assert.ok(mathPair.charMap, '$$ math must now be editable')
  assert.equal(mathPair.charMap.visibleLength, 3)
  // The content boundaries are the TeX's own bytes — never a `$` delimiter.
  assert.equal(mathPair.charMap.visibleToRaw(0), mathMd.indexOf('x^2'))
  assert.equal(mathPair.charMap.visibleToRaw(3), mathMd.indexOf('x^2') + 3)
  assert.equal(mathMap.pmPosToRaw(mathPair.pmPos + 1), mathMd.indexOf('x^2'))
}

// Case 18b: block math in its other provable forms — quoted (per-line `> `
// prefix) and CRLF — plus the ONE form that must still fail closed to that
// single pair: a list-indented `$$` block, whose content lines `buildCodeMap`
// cannot reproduce byte-for-byte. The neighbours keep their maps either way.
{
  const quoted = '> $$\n> E=mc^2\n> $$\n\nafter\n'
  const qMap = buildProjectionMap(quoted, doc(
    schema.node('blockquote', null, [schema.node('code_block', { language: 'LaTeX' }, text('E=mc^2'))]),
    p(text('after'))
  ))
  assert.ok(qMap, 'quoted math doc must map')
  const qPair = qMap.blockPairs.find((pair) => pair.mdBlock?.type === 'math')
  assert.ok(qPair?.charMap, 'quoted $$ math must be editable')
  assert.equal(qPair.charMap.linePrefix, '> ')
  assert.equal(qPair.charMap.visibleLength, 6)

  const crlf = '$$\r\na\r\nb\r\n$$\r\n'
  const cMap = buildProjectionMap(crlf, doc(schema.node('code_block', { language: 'LaTeX' }, text('a\r\nb'))))
  assert.ok(cMap, 'CRLF math doc must map')
  assert.ok(cMap.blockPairs[0].charMap, 'CRLF $$ math must be editable')
  assert.equal(cMap.blockPairs[0].charMap.visibleLength, 'a\r\nb'.length)
  assert.equal(cMap.blockPairs[0].charMap.lineEnding, '\r\n')

  // Fail-closed, per-block: a quoted `$$` block whose blank content line is
  // written as a bare '>' instead of '> ' — buildCodeMap's per-line prefix
  // check cannot reproduce that line byte-for-byte (the same shape Case 19
  // pins for a fence). ONLY this pair degrades; the trailing paragraph keeps
  // its own byte-correct map.
  const ragged = '> $$\n> a\n>\n> b\n> $$\n\nafter\n'
  const rMap = buildProjectionMap(ragged, doc(
    schema.node('blockquote', null, [schema.node('code_block', { language: 'LaTeX' }, text('a\n\nb'))]),
    p(text('after'))
  ))
  assert.ok(rMap, 'an unprovable math block must not reject the whole map')
  assert.equal(rMap.blockPairs.find((pair) => pair.mdBlock?.type === 'math').charMap, null,
    'an unprovable math block degrades to a read-only leaf')
  assert.ok(rMap.blockPairs[rMap.blockPairs.length - 1].charMap,
    'the trailing paragraph keeps its own map')
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
// Both healed by pairing the real math nodes. Block math was NON-EDITABLE
// then; since 2026-08-18 it carries a real `buildCodeMap` charMap (see the
// `code_block` branch's own comment for what that needed proven), so this
// case now asserts the mapped offsets rather than their absence.
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

  // Block math: paired AND editable, addressing the TeX's own bytes. The
  // code_block sits at pmPos 7, so its content start is 8 and the raw offset
  // there is the 'E' of 'E=mc^2' — inside the delimiters, never on a '$'.
  assert.equal(map.blockPairs[1].mdBlock.type, 'math')
  assert.equal(map.blockPairs[1].pmNode.type.name, 'code_block')
  assert.ok(map.blockPairs[1].charMap, 'block math is editable')
  assert.equal(map.blockPairs[1].charMap.visibleLength, 6)
  assert.equal(map.pmPosToRaw(8), md.indexOf('E=mc^2'))
  assert.equal(map.pmPosToRaw(14), md.indexOf('E=mc^2') + 6)
  assert.equal(md[map.pmPosToRaw(8)], 'E')
  // …and the inverse direction agrees.
  assert.deepEqual(map.rawToPmPos(md.indexOf('E=mc^2')), { pos: 8, atom: false })

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
// PM `blockquote > code_block(LaTeX)`; the quote occupies a slot, the math an
// EDITABLE one carrying the quote's per-line '> ' prefix (2026-08-18 — it was
// a non-editable slot before), and a following paragraph still maps.
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
  const qCharMap = map.blockPairs[1].charMap
  assert.ok(qCharMap, 'quoted block math is editable')
  assert.equal(qCharMap.visibleLength, 6)
  // The prefix a newline typed here must be expanded with — the whole reason
  // buildCodeMap exposes it (see commitPlainText's break expansion).
  assert.equal(qCharMap.linePrefix, '> ')
  assert.equal(qCharMap.lineEnding, '\n')
  assert.equal(qCharMap.visibleToRaw(0), md.indexOf('E=mc^2'))
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

// Case M6: a LIST ITEM WHOSE FIRST BLOCK IS NOT A PARAGRAPH.
//
// FLIPPED 2026-08-20 by the task the previous version of this case named
// ("whatever task teaches flattenMd about the filler paragraph"). The cause was
// never math-specific: Milkdown's `list_item` content expression is
// `'paragraph block*'` — the leading paragraph is REQUIRED — so ProseMirror's
// parse runs `createAndFill` and inserts an EMPTY filler paragraph whenever the
// item's first child is anything else. PM had 4 structural nodes (list, item,
// filler paragraph, code_block) where mdast had 3, and a block-COUNT mismatch
// rejects the whole map.
//
// The consequence was much wider than the shapes below: a fenced code block in
// a list item is an everyday thing to write, and ANY document containing one
// ran ENTIRELY in legacy — silently, since the fallback toast fires once at
// attach. The same held for `- - x` (a nested list written on the same line),
// which is also what made typing `- ` at a bullet item's text start
// unfixable: the bytes are exactly right and the projection could not pair
// them.
//
// `flattenMd` now synthesizes that filler slot, exactly as it already does for
// an empty list item and an empty blockquote. FAIL-CLOSED IS UNCHANGED WHERE IT
// COUNTS, and that is what the assertions below spend most of their effort on:
// the filler paragraph pairs `charMap: null` (it holds NO bytes — the item's
// content start is where the nested marker begins — so there is no offset a
// keystroke there could honestly write to), and it is NOT virtual, because a
// virtual pair claims an editable single-point anchor.
{
  const mdMath = '- $$\n  E=mc^2\n  $$\n'
  const dMath = doc(schema.node('bullet_list', null, [
    schema.node('list_item', null, [p(), cbl('LaTeX', 'E=mc^2')])
  ]))
  const mapMath = buildProjectionMap(mdMath, dMath)
  assert.ok(mapMath, 'a list item holding block math must pair, not degrade the document')
  assert.deepEqual(mapMath.blockPairs.map((pair) => pair.pmNode.type.name),
    ['bullet_list', 'list_item', 'paragraph', 'code_block'],
    'the filler paragraph occupies a slot of its own')
  const fillerMath = mapMath.blockPairs[2]
  assert.equal(fillerMath.charMap, null, 'the filler paragraph owns no bytes, so it is never editable')
  assert.equal(fillerMath.mdBlock, null, 'and it has no mdast counterpart to be edited through')
  assert.notEqual(fillerMath.virtual, true, 'it must not claim a virtual insert anchor either')
  assert.equal(mapMath.pmPosToRaw(fillerMath.pmPos + 1), null,
    'no PM position inside the filler paragraph resolves to a raw offset')
  assert.equal(mapMath.pairAt(fillerMath.pmPos + 1), null, 'pairAt skips it, so every write there fails closed')
  assert.equal(mapMath.virtualBlockAt(fillerMath.pmPos + 1), null, 'and it is not a virtual insert target')

  const mdCode = '- ```js\n  ab\n  ```\n'
  const dCode = doc(schema.node('bullet_list', null, [
    schema.node('list_item', null, [p(), cbl('js', 'ab')])
  ]))
  const mapCode = buildProjectionMap(mdCode, dCode)
  assert.ok(mapCode, 'the SAME shape with a plain fenced code block pairs too')
  assert.deepEqual(mapCode.blockPairs.map((pair) => pair.pmNode.type.name),
    ['bullet_list', 'list_item', 'paragraph', 'code_block'])
  assert.equal(mapCode.blockPairs[2].charMap, null)

  // A NESTED LIST WRITTEN ON THE SAME LINE — the shape the marker-completing
  // Space produces when a user types `- ` at a bullet item's text start. The
  // INNER item's paragraph is genuinely editable; only the filler is not.
  const mdNested = '- - 乙一\n'
  const dNested = doc(schema.node('bullet_list', null, [
    schema.node('list_item', null, [
      p(),
      schema.node('bullet_list', null, [schema.node('list_item', null, [p(text('乙一'))])])
    ])
  ]))
  const mapNested = buildProjectionMap(mdNested, dNested)
  assert.ok(mapNested, 'a same-line nested list must pair')
  assert.deepEqual(mapNested.blockPairs.map((pair) => pair.pmNode.type.name),
    ['bullet_list', 'list_item', 'paragraph', 'bullet_list', 'list_item', 'paragraph'])
  const inner = mapNested.blockPairs[5]
  assert.ok(inner.charMap, "the inner item's own paragraph stays editable")
  assert.equal(mapNested.pmPosToRaw(inner.pmPos + 1), mdNested.indexOf('乙一'),
    'and its content start resolves to the right byte')

  // THE CONTROL: an item whose first child IS a paragraph gets no filler and no
  // synthetic slot, so the ordinary shape is untouched.
  const mapPlain = buildProjectionMap('- 乙一\n', doc(schema.node('bullet_list', null, [
    schema.node('list_item', null, [p(text('乙一'))])
  ])))
  assert.ok(mapPlain)
  assert.deepEqual(mapPlain.blockPairs.map((pair) => pair.pmNode.type.name),
    ['bullet_list', 'list_item', 'paragraph'], 'no filler slot is invented where PM fills nothing')
}

// Case M7: fail-closed is preserved — a PM doc that DISAGREES with the
// kernel's math parse (a plain text node where the kernel proved an atom) is
// never guessed at.
//
// FLIPPED by P5-2.5 (deliberate): this disagreement is a CONTENT-level one
// (PM content.size 7 vs the kernel's decoded visibleLength 5 for the same,
// correctly-paired paragraph), so it now degrades only THAT PAIR to a
// non-editable leaf instead of nulling the whole map. Fail-closed is intact
// where it counts: the block carries `charMap: null`, so no offset inside it
// resolves in either direction and every write into it is refused. The
// STRUCTURAL disagreements (Case M6's block-count mismatch, Case 4's type
// mismatch, Case H6/H9's shape/count guards) still reject the whole map.
{
  const md = 'a $x$ b\n'
  const map = buildProjectionMap(md, doc(p(text('a $x$ b'))))
  assert.ok(map, 'a size disagreement degrades the block, not the document')
  assert.equal(map.blockPairs.length, 1)
  assert.equal(map.blockPairs[0].charMap, null, 'the disagreeing paragraph is non-editable')
  assert.equal(map.pmPosToRaw(1), null, 'no PM position inside it maps to raw')
  assert.equal(map.pmPosToRaw(4), null)
  assert.equal(map.rawToPmPos(0), null, 'no raw offset inside it maps to PM')
  assert.equal(map.rawToPmPos(3), null)
  assert.equal(map.virtualBlockAt(1), null, 'a degraded pair is never a virtual insert target')
  assert.equal(map.pairAt(1), null, 'pairAt skips charMap-less pairs')
}

console.log('PASS kernel projection map')

// ---- 行内 HTML（计划五 Task 2）----
//
// 这里的 PM 形状不是猜的：Milkdown 的 `html` schema 是 **行内原子**
// (@milkdown/preset-commonmark/src/node/html.ts: `atom:true, group:'inline'`)，
// 编辑器链的 `remarkMergeInlineHtml` 把 `<span>`/`x`/`</span>` 三个 mdast 节点
// 合成一个（无 position 的）html 节点 → PM 里就是 **一个** 原子；而块级 html
// 由 preset 自带的 `remarkHtmlTransformer` 包进一个 paragraph
// (plugin/remark-html-transformer.ts: parent 是 root/blockquote/listItem 时
// 改写为 paragraph 包住该 html 节点)。
//
// 治降级前：`a <span>x</span> b` 的 pmBlocks 是 [paragraph, html] 而 mdBlocks 是
// [paragraph, html, html] → `mdIndex !== mdBlocks.length` → **整篇文档 null**。
// 任何含行内 HTML 的文档都用不了内核模式。
const inlineHtml = (value) => schema.node('html', { value })
const br = () => schema.node('hard_break')

// Case H1（头条）：含行内 HTML 的文档必须建图成功，且其余块照常可编辑。
// 'a <span>x</span> b\n\nplain\n' 的 raw 下标：
//   'a <span>x</span> b' = 0..17（片段 [2,16)），'\n'=18 '\n'=19，'plain'=20..24，'\n'=25
// PM: paragraph1 pos 0（内容 'a ' + 原子 + ' b' = 5）→ nodeSize 7；paragraph2 pos 7。
{
  const md = 'a <span>x</span> b\n\nplain\n'
  const d = doc(
    p(text('a '), inlineHtml('<span>x</span>'), text(' b')),
    p(text('plain'))
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'inline HTML must no longer degrade the whole document')
  assert.equal(map.blockPairs.length, 2)
  assert.ok(map.blockPairs[0].charMap, 'the inline-HTML paragraph itself is mappable')
  assert.ok(map.blockPairs[1].charMap, 'the plain paragraph stays editable')
  assert.equal(map.pmPosToRaw(1), 0)   // before 'a'
  assert.equal(map.pmPosToRaw(3), 2)   // atom left edge  ('<' of <span>)
  assert.equal(map.pmPosToRaw(4), 16)  // atom right edge (right after </span>)
  assert.equal(map.pmPosToRaw(6), 18)  // end of paragraph1 content
  assert.equal(map.pmPosToRaw(8), 20)  // paragraph2 content start
  assert.equal(map.pmPosToRaw(13), 25) // paragraph2 content end
  // raw offsets INSIDE the fragment snap to the atom's own boundary, exactly
  // like an image/inline-math atom — there is no PM position inside it.
  const inside = map.rawToPmPos(9)
  assert.ok(inside)
  assert.equal(inside.pos, 3)
  assert.equal(inside.atom, true)
}

// Case H2: 不平衡片段 `<span>x b` —— 编辑器链放弃合并，PM 侧是「开标签原子 +
// 文本」。内核用同一条规则，因此同样不合并 → 仍然建图成功（不是降级）。
{
  const md = 'a <span>x b\n'
  const d = doc(p(text('a '), inlineHtml('<span>'), text('x b')))
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'an unbalanced inline-HTML run must still map')
  assert.equal(map.pmPosToRaw(3), 2)  // '<span>' 原子左边界
  assert.equal(map.pmPosToRaw(4), 8)  // 原子右边界
  assert.equal(map.pmPosToRaw(7), 11) // 段末
}

// Case H3: 片段里含 `<br/>`。`brToBreakRemarkPlugin` 在 merge 之前就把它换成
// break 节点，合并因此断开 → PM 是 7 个行内节点（尺寸 9）。内核必须用同一判据
// 断开；否则会跨过 void 标签合成一个原子（尺寸 5）→ 整图 null。
{
  const md = 'a <span>x<br/>y</span> b\n'
  const d = doc(p(
    text('a '), inlineHtml('<span>'), text('x'), br(), text('y'),
    inlineHtml('</span>'), text(' b')
  ))
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'a run cut by <br/> must map on both sides identically')
  assert.equal(map.blockPairs[0].charMap.visibleLength, 9)
  assert.equal(map.pmPosToRaw(3), 2)   // '<span>' 左
  assert.equal(map.pmPosToRaw(4), 8)   // '<span>' 右 / 'x' 左
  assert.equal(map.pmPosToRaw(5), 9)   // '<br/>' 左
  assert.equal(map.pmPosToRaw(6), 14)  // '<br/>' 右 / 'y' 左
  assert.equal(map.pmPosToRaw(7), 15)  // '</span>' 左
  assert.equal(map.pmPosToRaw(8), 22)  // '</span>' 右
}

// Case H4: 片段里含 emphasis —— coalesceChildren 遇到非 html/text 兄弟就放弃，
// 两侧都是「开标签原子 + 强调文本 + 闭标签原子」。
{
  const md = 'a <span>*x*</span> b\n'
  const d = doc(p(
    text('a '), inlineHtml('<span>'), text('x'), inlineHtml('</span>'), text(' b')
  ))
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'a run containing emphasis must map (both chains give up merging)')
  assert.equal(map.pmPosToRaw(4), 8)   // '<span>' 右边界 == emphasis 的 '*' 之前
  assert.equal(map.pmPosToRaw(5), 10)  // 'x' 之后（右侧 '*' 是 mark gap）
  assert.equal(map.pmPosToRaw(6), 18)  // '</span>' 右边界
}

// Case H5（块级 HTML）：`<div>block</div>` 在 PM 里是 **paragraph 包一个行内
// html 原子**（remarkHtmlTransformer），与 mdast 的根级 `html` 节点配对，作为
// 不可编辑叶（charMap null）。文档的其余部分仍然可编辑 —— 这正是「治降级」：
// 从前这份文档整篇拿不到映射。
{
  const md = '<div>block</div>\n\nafter\n'
  const d = doc(p(inlineHtml('<div>block</div>')), p(text('after')))
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'a document containing block HTML must map')
  assert.equal(map.blockPairs.length, 2)
  assert.equal(map.blockPairs[0].mdBlock.type, 'html')
  assert.equal(map.blockPairs[0].charMap, null, 'block HTML stays a non-editable leaf')
  assert.ok(map.blockPairs[1].charMap)
  assert.equal(map.pmPosToRaw(1), null) // 块级 HTML 内部没有可用位置
  assert.equal(map.pmPosToRaw(4), 18)   // 'after' 段落照常可编辑
  assert.equal(map.pmPosToRaw(9), 23)
}

// Case H6: 块级 HTML 的配对是 fail-closed —— PM 侧若不是「单个 html 原子的
// paragraph」（这里是纯文本），说明两棵树已经结构性分家 → 整图拒绝。
{
  const md = '<div>x</div>\n'
  assert.equal(buildProjectionMap(md, doc(p(text('<div>x</div>')))), null)
}

// Case H7: fail-closed 仍然成立 —— PM 说是一整段纯文本、内核证明的是合并原子，
// 尺寸不一致（18 vs 5）。
//
// P5-2.5 **有意翻转**：这是**内容级**分歧（配对本身没错：一个 paragraph 对一个
// paragraph），因此只把该 pair 降级成不可编辑叶，整图仍然可用。fail-closed 没有
// 削弱——该块 charMap 为 null，任何方向的偏移都解析不出来，写入一律被拒。真正说明
// 「两棵树对不齐」的结构性检查（Case H6 的形状守卫、Case H9 的块数不符）依旧整图拒绝。
{
  const md = 'a <span>x</span> b\n'
  const map = buildProjectionMap(md, doc(p(text('a <span>x</span> b'))))
  assert.ok(map, '尺寸分歧只降级该块')
  assert.equal(map.blockPairs[0].charMap, null, '分歧的段落不可编辑')
  assert.equal(map.pmPosToRaw(1), null)
  assert.equal(map.rawToPmPos(0), null)
}

// Case H8: 标题 + 相邻片段 + 列表项里的片段，一份文档里同时出现。
// '# h <span>x</span>\n\n- item <span>y</span>\n' 的 raw 下标：
//   heading: '# ' = 0..1, 'h ' = 2..3, 片段 [4,18)，'\n'=18 '\n'=19
//   list: '- ' = 20..21, 'item ' = 22..26, 片段 [27,41)
{
  const md = '# h <span>x</span>\n\n- item <span>y</span>\n'
  const d = doc(
    schema.node('heading', { level: 1 }, [text('h '), inlineHtml('<span>x</span>')]),
    schema.node('bullet_list', null, [
      schema.node('list_item', null, [p(text('item '), inlineHtml('<span>y</span>'))])
    ])
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'heading + list item with inline HTML must map')
  assert.equal(map.pmPosToRaw(1), 2)   // 标题内容起点（'# ' 之后）
  assert.equal(map.pmPosToRaw(3), 4)   // 标题里片段的左边界
  assert.equal(map.pmPosToRaw(4), 18)  // 右边界
  // heading nodeSize = 1 + 3 + 1 = 5；bullet_list pos 5，list_item pos 6，
  // paragraph pos 7，内容起点 8。
  assert.equal(map.pmPosToRaw(8), 22)  // 'item ' 起点
  assert.equal(map.pmPosToRaw(13), 27) // 列表项里片段的左边界
  assert.equal(map.pmPosToRaw(14), 41) // 右边界
}

// Case H9（已知残留，钉住当前行为）：`remarkMergeInlineHtml` 也会合并 **根级**
// 的 html 兄弟。`<div>\n\n</div>\n` 在内核侧是两个根级 `html` 块（[0,5) 与
// [7,13)），在编辑器侧被合成一个 html 节点 → `remarkHtmlTransformer` 包成 **一个**
// paragraph → pmBlocks 1 vs mdBlocks 2 → 整图 null。
//
// 这是「HTML 包裹层」的真实写法，本任务 **未** 治理：治它需要在 flattenMd 侧同样
// 合并根级 html 兄弟，而合并跨越了块边界（两块之间的空行属于谁没有定义），与
// 「块级 HTML 是不可编辑叶」的现有契约冲突。此处钉住 null，防止将来有人以为它已
// 经工作；若日后治理，本用例应翻转为 map 非 null。
// P5-2.5 复核后 **未** 翻转：这里的失败是 **块数不符**（pmBlocks 1 vs mdBlocks 2），
// 属于「两棵树对不齐」的结构性失败，必须继续整图拒绝；逐块降级只处理内容级分歧。
{
  const md = '<div>\n\n</div>\n'
  assert.equal(
    buildProjectionMap(md, doc(p(inlineHtml('<div></div>')))), null,
    'a merged ROOT-LEVEL block-HTML wrapper still degrades the whole map (known residual)'
  )
}

// Case H10（对照）：中间夹一个段落时，合并被段落打断 —— 两侧都是
// [html, paragraph, html] → 建图成功，中间段落可编辑。
// '<div>\n\ntext\n\n</div>\n' 的 raw 下标：'<div>'=[0,5) '\n'=5 '\n'=6
// 'text'=[7,11) '\n'=11 '\n'=12 '</div>'=[13,19)
{
  const md = '<div>\n\ntext\n\n</div>\n'
  const d = doc(
    p(inlineHtml('<div>')),
    p(text('text')),
    p(inlineHtml('</div>'))
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'a block-HTML wrapper interrupted by a paragraph must map')
  assert.equal(map.blockPairs.length, 3)
  assert.equal(map.blockPairs[0].charMap, null)
  assert.equal(map.blockPairs[2].charMap, null)
  assert.ok(map.blockPairs[1].charMap, 'the wrapped paragraph stays editable')
  // paragraph1 nodeSize 3 -> paragraph2 pos 3, content start 4.
  assert.equal(map.pmPosToRaw(4), 7)
  assert.equal(map.pmPosToRaw(8), 11)
}

console.log('PASS kernel projection map (inline html)')

// ---- P5-2.5: per-block fail-closed degradation ----
//
// The recurring pattern through plans 3/4/5: ONE block the kernel cannot
// prove nulled the ENTIRE map, degrading a whole document to legacy even
// though every other block paired perfectly. Two conditions did that for an
// editable textblock pair — `buildCharacterMap` returning null, and
// `pm.node.content.size !== charMap.visibleLength`. Both now degrade only
// that PAIR (`charMap: null`, the same non-editable-leaf posture
// mermaid/latex/math/table/image-block/block-HTML already had).
//
// SAFETY (the crux — proven by construction in Case P1 below): the pairing is
// POSITIONAL. flattenPm/flattenMd walk their trees pre-order and the loop
// zips them index-for-index, so pair N+1's raw offsets come from
// `mdBlocks[N+1].position` — the kernel's own parse of the raw source — and
// cannot be shifted by a content-level disagreement inside pair N. A
// genuinely mis-ALIGNED zip always changes the block COUNT (a chain merging
// or splitting a block), and every count/type/shape invariant stays
// whole-map fail-closed (Case P5 below).

// Case P1 (neighbour-offset integrity): block 2 has a deliberate size
// mismatch (kernel proves 'BB' = 2 visible chars, PM shows 'BXB' = 3) while
// blocks 1 and 3 are perfectly ordinary. The whole map must survive, block 2
// must be unmappable in BOTH directions, and blocks 1 and 3 must map to
// byte-correct raw offsets.
// 'A\n\nBB\n\nC\n': A=0 \n=1 \n=2 B=3 B=4 \n=5 \n=6 C=7 \n=8.
// PM: p1 pos 0 (content [1,2]), p2 pos 3 (content start 4, size 3),
// p3 pos 8 (content start 9).
{
  const md = 'A\n\nBB\n\nC\n'
  const map = buildProjectionMap(md, doc(p(text('A')), p(text('BXB')), p(text('C'))))
  assert.ok(map, 'one unprovable block must not null the whole map')
  assert.equal(map.blockPairs.length, 3)

  // The offender degrades — and nothing else does.
  assert.equal(map.blockPairs[1].charMap, null, 'the size-mismatched block is non-editable')
  assert.ok(map.blockPairs[0].charMap, 'block 1 stays editable')
  assert.ok(map.blockPairs[2].charMap, 'block 3 stays editable')

  // Neighbours: byte-correct in both directions.
  assert.equal(map.pmPosToRaw(1), 0)
  assert.equal(map.pmPosToRaw(2), 1)
  assert.deepEqual(map.rawToPmPos(0), { pos: 1, atom: false })
  assert.deepEqual(map.rawToPmPos(1), { pos: 2, atom: false })
  assert.equal(map.pmPosToRaw(9), 7)
  assert.equal(map.pmPosToRaw(10), 8)
  assert.deepEqual(map.rawToPmPos(7), { pos: 9, atom: false })
  assert.deepEqual(map.rawToPmPos(8), { pos: 10, atom: false })

  // The degraded block: no position resolves, in either direction, through
  // any resolver — including the gap-aware/insert-role ones.
  for (const pmPos of [4, 5, 6, 7]) {
    assert.equal(map.pmPosToRaw(pmPos), null, `pmPosToRaw(${pmPos}) must fail closed`)
    assert.equal(map.pmPosToRawStart(pmPos), null)
    assert.equal(map.pmPosToRawInsert(pmPos), null)
    assert.equal(map.pairAt(pmPos), null)
    assert.equal(map.virtualBlockAt(pmPos), null)
  }
  for (const raw of [3, 4, 5]) {
    assert.equal(map.rawToPmPos(raw), null, `rawToPmPos(${raw}) must fail closed`)
  }
}

// Case P2 (healed residual — inline HTML fragment containing a NON-ASCII
// autolink). Editor chain: remark-gfm autolinks `www.例子.cn`, then
// `remarkUnwrapNonAsciiAutolinks` splits it and `remarkMergeInlineHtml` can
// no longer coalesce the run — PM keeps [text, html atom, text('www.例子.cn'),
// html atom, text] (content.size 15; the link MARK does not affect size, so
// it is elided here). Kernel chain: keeps a positionless `link` node inside
// the paragraph, so `buildCharacterMap` cannot prove the block's units and
// returns null. Before P5-2.5 that nulled the WHOLE document.
// 'a <span>www.例子.cn</span> b\n\nafter\n': paragraph1 [0,26], 'after' [28,33].
{
  const md = 'a <span>www.例子.cn</span> b\n\nafter\n'
  const d = doc(
    p(text('a '), inlineHtml('<span>'), text('www.例子.cn'), inlineHtml('</span>'), text(' b')),
    p(text('after'))
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'an autolink-bearing HTML fragment must no longer degrade the document')
  assert.equal(map.blockPairs.length, 2)
  // Which of the two conditions healed it: the character map itself is
  // unprovable here (not a size disagreement).
  assert.equal(
    buildCharacterMap(md, map.blockPairs[0].mdBlock), null,
    'the kernel genuinely cannot character-map this paragraph'
  )
  assert.equal(map.blockPairs[0].charMap, null, 'so the block degrades to a non-editable leaf')
  assert.equal(map.pmPosToRaw(1), null)
  assert.equal(map.rawToPmPos(3), null)
  // The OTHER paragraph is editable and byte-correct: paragraph1 nodeSize is
  // 1 + 15 + 1 = 17 -> paragraph2 pos 17, content start 18 -> raw 28.
  assert.ok(map.blockPairs[1].charMap)
  assert.equal(map.pmPosToRaw(18), 28)
  assert.equal(map.pmPosToRaw(23), 33)
  assert.deepEqual(map.rawToPmPos(28), { pos: 18, atom: false })
}

// Case P3 (CURED, Plan 5 Task 3 headline — `==高亮==`). This block used to
// degrade: the kernel chain read six literal characters (visibleLength 6)
// while Crepe's `highlightRemark` gives PM a highlight MARK over '高亮'
// (content.size 2). The kernel now injects a real, positioned `highlight`
// node (highlight-syntax.js) whose `==` markers are marker GAPS and whose
// content is per-character — exactly the strong/emphasis shape — so the
// paragraph PAIRS and is fully EDITABLE.
// '==高亮==\n\nafter\n': paragraph1 [0,6] ('='0 '='1 高2 亮3 '='4 '='5), 'after'
// [8,13].
{
  const md = '==高亮==\n\nafter\n'
  const map = buildProjectionMap(md, doc(p(text('高亮')), p(text('after'))))
  assert.ok(map, 'a highlight-bearing document maps')
  const kernelMap = buildCharacterMap(md, map.blockPairs[0].mdBlock)
  assert.equal(kernelMap.visibleLength, 2, 'the == bytes are marker gaps, not content')
  assert.ok(map.blockPairs[0].charMap, 'the highlight paragraph is EDITABLE (the degradation cure)')
  assert.equal(map.pmPosToRaw(1), 2, 'PM content start lands inside the markers')
  assert.equal(map.pmPosToRaw(2), 3)
  assert.equal(map.pmPosToRaw(3), 4, 'the content end stops before the closing ==')
  assert.deepEqual(map.rawToPmPos(2), { pos: 1, atom: false })
  // paragraph1 nodeSize 1 + 2 + 1 = 4 -> paragraph2 pos 4, content start 5.
  assert.equal(map.pmPosToRaw(5), 8)
  assert.equal(map.pmPosToRaw(10), 13)
}

// Case P3b (Plan 5 Task 3): a highlight in the MIDDLE of prose, next to other
// marks, in a heading, and inside a list item — all editable, byte-correct.
// 'a ==hl== b\n': 'a'0 ' '1 '='2 '='3 h4 l5 '='6 '='7 ' '8 'b'9.
{
  const md = 'a ==hl== b\n'
  const map = buildProjectionMap(md, doc(p(text('a hl b'))))
  assert.ok(map?.blockPairs[0].charMap, 'an inline highlight keeps the paragraph editable')
  assert.equal(map.blockPairs[0].charMap.visibleLength, 6)
  assert.equal(map.pmPosToRaw(1), 0)
  // `visibleToRaw` is gap-BEFORE by contract (see character-map.js's ADR): a
  // caret at the mark's leading edge resolves to the byte before the opening
  // `==`, and one at its trailing edge to the byte after the content.
  assert.equal(map.pmPosToRaw(3), 2, 'caret before the highlight sits before the open marker')
  assert.equal(map.pmPosToRaw(4), 5, 'inside the content, per character')
  assert.equal(map.pmPosToRaw(5), 6, 'the content end stops before the close marker')
  assert.equal(map.pmPosToRaw(6), 9)
  assert.equal(map.pmPosToRaw(7), 10)
}
{
  const md = '# 标 ==题==\n\n- 项 ==目==\n'
  const map = buildProjectionMap(
    md,
    doc(
      schema.node('heading', { level: 1 }, [text('标 题')]),
      schema.node('bullet_list', null, [schema.node('list_item', null, [p(text('项 目'))])])
    )
  )
  assert.ok(map, 'headings and list items with highlights map')
  assert.ok(map.blockPairs.every((pair) => pair.charMap || !pair.pmNode.isTextblock),
    'every textblock pair is editable')
  const heading = map.blockPairs.find((pair) => pair.pmNode.type.name === 'heading')
  assert.ok(heading?.charMap, 'the heading with a highlight is editable')
  assert.equal(heading.charMap.visibleLength, 3, '标 题 — markers are gaps')
}

// Case P3c (Plan 5 Task 3 — the RED/BLUE decision, deliberately NOT cured).
// A non-yellow highlight round-trips as inline HTML: `<mark class="hm-hl-red">`
// … `</mark>`. The editor coalesces that run (remarkMergeInlineHtml) and then
// `coalesceMarkHtml` turns it into a highlight mdast node, so PM holds a
// MARKED TEXT RUN of N characters; the kernel treats the same run as ONE
// inline-HTML atom (Task 2's shared rule), i.e. 1 visible unit. For N > 1
// that is a size disagreement -> this block degrades to read-only while the
// rest of the document stays editable. Supporting it would mean special-casing
// the shared inline-HTML run rule AND teaching the toggle command to write
// tag bytes; out of scope, and the gateway keeps refusing non-yellow colors
// (editor-kernel-gateway.js's markAttrs check).
// '<mark class="hm-hl-red">红字</mark>\n\nafter\n'
{
  const md = '<mark class="hm-hl-red">红字</mark>\n\nafter\n'
  const map = buildProjectionMap(md, doc(p(text('红字')), p(text('after'))))
  assert.ok(map, 'a red-highlight document still maps (only that block degrades)')
  assert.equal(map.blockPairs[0].charMap, null, 'the red/blue highlight paragraph is read-only')
  assert.ok(map.blockPairs[1].charMap, 'the rest of the document stays editable')
}

// Case P4 (degraded block next to the VIRTUAL trailing placeholder): the
// two tolerances are independent — a degraded pair neither consumes nor
// shifts the trailing-placeholder slot, and the placeholder still anchors at
// the raw document end with its separator prefix.
// 'a $x$ b\n\n- 甲\n': paragraph [0,7], list [9,13] ('-'9 ' '10 甲11 \n12).
// PM: paragraph pos 0 (content.size 7 vs the kernel's 5 -> degraded),
// bullet_list pos 9, list_item 10, paragraph 11 (content start 12),
// trailing placeholder paragraph pos 16 (content pos 17).
{
  const md = 'a $x$ b\n\n- 甲\n'
  const d = doc(
    p(text('a $x$ b')),
    schema.node('bullet_list', null, [schema.node('list_item', null, [p(text('甲'))])]),
    p()
  )
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'a degraded block plus the trailing placeholder must both hold')
  assert.equal(map.blockPairs[0].charMap, null, 'the math paragraph degrades')
  assert.equal(map.pmPosToRaw(12), 11, 'the list item stays byte-correct')
  assert.equal(map.pmPosToRaw(13), 12)
  assert.deepEqual(map.virtualBlockAt(17), { raw: 13, prefix: '\n' })
}

// Case P5 (STRUCTURAL failures must NOT have flipped): every invariant that
// says "the two trees are aligned differently" still rejects the WHOLE map.
// These are the guards the safety argument leans on — if any of them ever
// degrades per-block instead, a mis-aligned zip could serve WRONG offsets for
// the blocks that happen to still look consistent.
{
  // (a) block COUNT: mdast has a block the PM side never produced.
  assert.equal(buildProjectionMap('A\n\nB\n', doc(p(text('A')))), null,
    'unconsumed mdast block must reject the whole map')
  // (b) block COUNT the other way: a surplus, non-tolerable PM block.
  assert.equal(buildProjectionMap('A\n', doc(p(text('A')), p(text('B')))), null,
    'surplus non-empty PM block must reject the whole map')
  // (c) TYPE pairing: heading vs paragraph.
  assert.equal(buildProjectionMap('# h\n', doc(p(text('h')))), null,
    'type-pair mismatch must reject the whole map')
  // (d) ORDERED flag: the marker-numbering scheme is structure, not decoration.
  assert.equal(
    buildProjectionMap('1. 甲\n', doc(schema.node('bullet_list', null, [
      schema.node('list_item', null, [p(text('甲'))])
    ]))),
    null,
    'ordered-flag mismatch must reject the whole map'
  )
  // (e) image-block SHAPE: the pair is only legal for a paragraph whose
  // single child is an image.
  assert.equal(
    buildProjectionMap('前![a](x.png)后\n', doc(schema.node('image-block', { src: 'x.png' }))),
    null,
    'a mixed paragraph paired with image-block must reject the whole map'
  )
  // (f) block-HTML SHAPE: the pair is only legal for the wrapper
  // `remarkHtmlTransformer` produces (a paragraph whose single child is the
  // html atom).
  assert.equal(buildProjectionMap('<div>x</div>\n', doc(p(text('<div>x</div>')))), null,
    'block-HTML shape guard must reject the whole map')
}

// Case P6 (residual, NOT healed — pinned so nobody assumes otherwise): a
// standalone-line `$$x$$`. `editor-parse-adapter.js`'s `normalizeDisplayMath`
// rewrites the line to the multi-line block form BEFORE the PM parse, so PM
// holds a `code_block` (language 'LaTeX') while the kernel holds the RAW
// bytes, whose mdast is a `paragraph` containing one inline-math atom. That
// is a TYPE-pair mismatch (`PM_TO_MD.code_block` has no 'paragraph' entry),
// i.e. a structural failure — deliberately still whole-map. Healing it means
// teaching the pairing about the pre-normalization, not relaxing fail-closed.
{
  const md = '$$x$$\n\nafter\n'
  assert.equal(buildProjectionMap(md, doc(cbl('LaTeX', 'x'), p(text('after')))), null,
    'standalone $$x$$ still degrades the whole map (type-pair mismatch, not a size one)')
}

// ---- The mis-zip canary (P5-2.5 review finding) ----
//
// Per-block degradation removed a canary nobody had named: before it, a
// MIS-ALIGNED zip (the two sequences pairing block i against the wrong block
// i) was caught for free, because at least one pair's lengths disagreed and
// that rejected the WHOLE map. Now only that pair degrades — and a
// coincidentally same-type, same-length pair would be SERVED with offsets
// belonging to a different source block, silently.
//
// The document-wide defence is the INVARIANT documented at the top of
// editor-kernel-projection-map.js (a mis-zip always changes the block COUNT,
// and every count/type/shape guard is still whole-map). `blockEndpointsAgree`
// is the second line: it compares each SERVED pair's first/last decoded
// character against the PM node's own text. These cases pin BOTH the catch
// and its honest residual — a regression in either direction is visible here.

// Case P7: the reviewer's base-vs-head differential. mdast is
// [a, bb, cc, ddd]; the PM doc is shifted by one block (same COUNT, so the
// zip is reached). Raw offsets of 'a\n\nbb\n\ncc\n\nddd\n':
//   a=0 \n1 \n2 b=3 b=4 \n5 \n6 c=7 c=8 \n9 \n10 d=11 d=12 d=13 \n14.
// Pair 1 (PM 'cc' vs mdast 'bb') agrees on TYPE and on LENGTH — the size
// check cannot see it. Pre-endpoint-check this served pmPosToRaw(6) === 4,
// an offset inside the 'bb' block while the view shows 'cc'.
{
  const md = 'a\n\nbb\n\ncc\n\nddd\n'
  const shifted = doc(p(text('bb')), p(text('cc')), p(text('ddd')), p(text('e')))
  const map = buildProjectionMap(md, shifted)
  assert.ok(map, 'the mis-zip still BUILDS a map (this is the behavior change P5-2.5 made)')
  // The pair the size check cannot see: same type, same visible length.
  assert.equal(map.blockPairs[1].pmNode.textContent, 'cc')
  assert.equal(map.blockPairs[1].mdBlock.position.start.offset, 3, 'paired against the bb block')
  // ...caught by the endpoint cross-check instead ('c' vs 'b').
  assert.equal(map.blockPairs[1].charMap, null, 'the mis-zipped pair must NOT be served')
  for (let i = 0; i < map.blockPairs.length; i += 1) {
    assert.equal(map.blockPairs[i].charMap, null, `pair ${i} must degrade`)
  }
  assert.equal(map.pmPosToRaw(6), null,
    'the wrong-block offset (raw 4) must no longer be served')
  assert.equal(map.rawToPmPos(4), null)
}

// Case P7a (positive controls — the endpoint check must NOT degrade a
// legitimately-correct block). Every shape whose first/last unit is NOT a
// plain `char` is skipped by construction; these prove the skips work and
// that ordinary blocks still serve offsets.
{
  // escape at both ends: '\*x\*' -> PM '*x*'
  const esc = buildProjectionMap('\\*x\\*\n', doc(p(text('*x*'))))
  assert.ok(esc?.blockPairs[0].charMap, 'escaped endpoints stay editable')
  assert.equal(esc.pmPosToRaw(1), 0)

  // entity at both ends: '&amp;x&amp;' -> PM '&x&'
  const ent = buildProjectionMap('&amp;x&amp;\n', doc(p(text('&x&'))))
  assert.ok(ent?.blockPairs[0].charMap, 'entity endpoints stay editable')

  // atom endpoints (inline image both sides) — no PM character at all.
  const img = buildProjectionMap(
    '![a](x.png)m![b](y.png)\n',
    doc(p(schema.node('image', { src: 'x.png' }), text('m'), schema.node('image', { src: 'y.png' })))
  )
  assert.ok(img?.blockPairs[0].charMap, 'atom endpoints stay editable')

  // hard break in the middle, plain chars at the ends.
  const hb = buildProjectionMap('a\\\nb\n', doc(p(text('a'), br(), text('b'))))
  assert.ok(hb?.blockPairs[0].charMap, 'a hard break does not disturb the endpoints')

  // marker gaps at both ends: '**bold**' -> PM 'bold' (first/last units are
  // the content chars, not the markers).
  const strong = buildProjectionMap('**bold**\n', doc(p(text('bold'))))
  assert.ok(strong?.blockPairs[0].charMap, 'mark markers are gaps, endpoints are content')
  assert.equal(strong.pmPosToRaw(1), 2)

  // highlight (Plan 5 Task 3) and inline code — same marker-gap shape.
  assert.ok(buildProjectionMap('==hl==\n', doc(p(text('hl'))))?.blockPairs[0].charMap)
  assert.ok(buildProjectionMap('`c`\n', doc(p(text('c'))))?.blockPairs[0].charMap)

  // heading / list item / blockquote: the raw endpoints sit after the marker
  // syntax, which the charMap already accounts for.
  assert.ok(buildProjectionMap('# h\n', doc(schema.node('heading', { level: 1 }, [text('h')])))
    ?.blockPairs[0].charMap)
  const item = buildProjectionMap('- 甲\n', doc(schema.node('bullet_list', null, [
    schema.node('list_item', null, [p(text('甲'))])
  ])))
  assert.ok(item?.blockPairs[2].charMap, 'list item paragraph stays editable')

  // code blocks: LF, CRLF and a quoted fence (per-line prefix) — the
  // endpoints are literal bytes on both sides.
  assert.ok(buildProjectionMap('```js\nab\n```\n', doc(cbl('js', 'ab'), p()))?.blockPairs[0].charMap)
  assert.ok(buildProjectionMap('```js\r\nab\r\ncd\r\n```\r\n',
    doc(cbl('js', 'ab\r\ncd'), p()))?.blockPairs[0].charMap, 'CRLF fence stays editable')
  assert.ok(buildProjectionMap('> ```js\n> ab\n> ```\n',
    doc(schema.node('blockquote', null, [cbl('js', 'ab')]), p()))?.blockPairs[1].charMap,
    'quoted fence stays editable')

  // astral plane: a `char` unit is a whole code point (width 2), compared as
  // its own raw slice on both sides.
  assert.ok(buildProjectionMap('😀x😀\n', doc(p(text('😀x😀'))))?.blockPairs[0].charMap,
    'surrogate-pair endpoints stay editable')

  // empty blocks have no endpoints to compare.
  assert.ok(buildProjectionMap('```js\n```\n', doc(cbl('js', ''), p()))?.blockPairs[0].charMap)
}

// Case P7b (the honest RESIDUAL): the endpoint check is one character deep at
// each end. A mis-zip whose blocks agree on type, on visible length AND on
// both endpoint characters is still served with the WRONG block's offsets.
// mdast [a, xBz, xAz] against a PM doc shifted by one: pair 1 is PM 'xAz'
// against the mdast 'xBz' block — only the middle character differs.
// This is a KNOWN hole, bounded by the count invariant at the top of
// editor-kernel-projection-map.js (no chain in the app can produce a
// same-count reordering today). If a future plugin ever can, this is the
// assertion that must change — closing it needs full content verification,
// not a deeper endpoint probe.
{
  const md = 'a\n\nxBz\n\nxAz\n'
  const shifted = doc(p(text('xBz')), p(text('xAz')), p(text('q')))
  const map = buildProjectionMap(md, shifted)
  assert.ok(map)
  assert.equal(map.blockPairs[0].charMap, null, 'length disagreement still degrades')
  assert.equal(map.blockPairs[2].charMap, null)
  assert.ok(map.blockPairs[1].charMap, 'RESIDUAL: same type, length and endpoints -> still served')
  assert.equal(map.pmPosToRaw(6), 3,
    'RESIDUAL: the served offset belongs to the xBz block while PM shows xAz')
}

// Case P8 (block-type conversion domain): an EMPTY ATX heading is served a
// single-point `virtualCharMap` at its DERIVED content start, so the heading
// the slash menu (or plain `## ` typing) just created can actually be typed
// into. The derivation is CommonMark's ATX grammar applied to a raw span that
// contains nothing but the marker — see `emptyAtxHeadingContentStart`.
{
  const h = (level, ...c) => schema.node('heading', { level }, c)

  // '## ' -> marker + REAL spacing: editable, anchored at the span's end (3).
  const spaced = buildProjectionMap('## \n', doc(h(2)))
  assert.ok(spaced, 'an empty ATX heading document still maps')
  assert.ok(spaced.blockPairs[0].charMap, 'empty ATX heading with spacing is editable')
  assert.equal(spaced.blockPairs[0].virtual, true,
    'it carries no real content bytes -> virtual, like the empty list item')
  assert.equal(spaced.blockPairs[0].charMap.visibleLength, 0)
  assert.equal(spaced.pmPosToRaw(1), 3, 'the caret inside the heading resolves to the content start')
  assert.deepEqual(spaced.rawToPmPos(3), { pos: 1, atom: false })

  // A TAB is spacing too (CommonMark), same derivation.
  assert.equal(buildProjectionMap('#\t\n', doc(h(1))).pmPosToRaw(1), 2)

  // '##' -> NO spacing: typing there would commit '##x', a paragraph. Stays
  // read-only, exactly like the bare-marker empty list item.
  assert.equal(buildProjectionMap('##\n', doc(h(2))).blockPairs[0].charMap, null,
    'a space-less empty ATX heading stays read-only')

  // A closing sequence's content start is between two marker runs — not
  // derivable from this rule, so it stays read-only rather than guessing.
  assert.equal(buildProjectionMap('## ##\n', doc(h(2))).blockPairs[0].charMap, null,
    'an empty ATX heading with a closing sequence stays read-only')

  // A SETEXT heading can never be empty, and a non-empty heading keeps its
  // ordinary (real, unit-bearing) character map — the derivation must not
  // reach either.
  const written = buildProjectionMap('## x\n', doc(h(2, text('x'))))
  assert.ok(written.blockPairs[0].charMap.units.length > 0, 'a written heading keeps a real char map')
  assert.equal(written.blockPairs[0].virtual, undefined, 'and is not virtual')

  // Mid-document: the derivation must not disturb its neighbours' offsets.
  const mixed = buildProjectionMap('甲\n\n### \n\n乙\n', doc(p(text('甲')), h(3), p(text('乙'))))
  assert.ok(mixed)
  assert.equal(mixed.pmPosToRaw(1), 0, 'preceding paragraph unchanged')
  assert.equal(mixed.pmPosToRaw(4), 7, 'the empty heading anchors at its own content start')
  assert.equal(mixed.pmPosToRaw(6), 9, 'following paragraph unchanged')

  // Other empty non-paragraph textblocks are NOT covered by the derivation.
  assert.equal(buildProjectionMap('```js\n```\n', doc(cbl('js', ''), p()))?.blockPairs[0].charMap
    ? 'code-block-has-its-own-map' : 'none', 'code-block-has-its-own-map',
    'the code path is untouched (buildCodeMap, not buildCharacterMap)')
}

console.log('PASS kernel projection map (per-block degradation)')

// ===========================================================================
// P6 Task 2 — YAML FRONT MATTER PAIRS INSTEAD OF DEGRADING THE DOCUMENT
// ===========================================================================
// Before this task the kernel's unified chain had no `remark-frontmatter`, so
// a leading `---` block parsed as `thematicBreak + setext heading` (TWO blocks,
// both of the wrong type) against PM's ONE `frontmatter` atom — which is not
// even in PM_TO_MD, so `flattenPm` recorded no slot for it at all. The very
// first pair mismatched and `buildProjectionMap` returned null, i.e. EVERY
// document with front matter fell back to legacy in its entirety. This repo's
// own guide pages carry front matter, so that was not a corner case.
//
// The fix is a pairing, not an editing surface: `frontmatter` is a PM ATOM, so
// `pm.node.isTextblock` is false and the pair is served with `charMap: null` —
// the same read-only-leaf posture `table` / block math / block HTML have. The
// assertions below pin BOTH halves: the body is fully editable with exact
// bytes, AND the front matter itself resolves no offset.
const fm = (value) => schema.node('frontmatter', { value })

// F1: the map builds, the body block is editable, and its offsets are the
// BODY's — not shifted by the front matter's own bytes.
{
  const md = '---\ntitle: x\n---\n\n正文一\n\n正文二\n'
  //           0123 4      12  16 17  18            (yaml [0,16), body at 18)
  const map = buildProjectionMap(md, doc(fm('title: x'), p(text('正文一')), p(text('正文二'))))
  assert.ok(map, 'a front-matter document must map instead of degrading whole-document')
  assert.equal(map.blockPairs.length, 3)
  assert.equal(map.blockPairs[0].mdBlock.type, 'yaml', 'the front matter pairs with the mdast yaml node')
  assert.equal(map.blockPairs[0].charMap, null, 'the front-matter block is a read-only leaf')
  assert.ok(map.blockPairs[1].charMap, 'the first body paragraph is editable')
  assert.ok(map.blockPairs[2].charMap, 'the second body paragraph is editable')
  // PM: frontmatter atom [0,1), paragraph1 open at 1 (content 2..5), close 6,
  // paragraph2 open 6 (content 7..10).
  assert.equal(map.pmPosToRaw(2), 18, 'body paragraph 1 starts at the byte after the blank line')
  assert.equal(map.pmPosToRaw(5), 21)
  assert.equal(map.pmPosToRaw(7), 23, 'body paragraph 2 offsets are unshifted too')
  assert.equal(map.pmPosToRaw(10), 26)
  assert.equal(md.slice(18, 21), '正文一')
  assert.equal(md.slice(23, 26), '正文二')
  // Nothing inside the front matter's own bytes may resolve to a PM position.
  for (const raw of [0, 3, 8, 15]) {
    assert.equal(map.rawToPmPos(raw), null, `raw ${raw} is inside the read-only front matter`)
  }
}

// F2: CRLF. The yaml node spans '\r\n'-terminated lines, so the body's offsets
// move by the extra '\r' bytes — the pairing must simply follow the kernel's
// own parse, with no line-ending special case.
{
  const md = '---\r\ntitle: x\r\n---\r\n\r\n正文一\r\n'
  const map = buildProjectionMap(md, doc(fm('title: x'), p(text('正文一'))))
  assert.ok(map, 'a CRLF front-matter document must map')
  assert.equal(map.blockPairs[0].charMap, null)
  assert.ok(map.blockPairs[1].charMap)
  assert.equal(map.pmPosToRaw(2), 22)
  assert.equal(map.pmPosToRaw(5), 25)
  assert.equal(md.slice(22, 25), '正文一')
}

// F3: front matter is ONLY the leading block. A genuine `---` thematic break
// mid-document must still pair as `hr`/`thematicBreak` — the negative control
// that the plugin's default 'yaml' preset was not silently widened.
{
  const md = '甲\n\n---\n\n乙\n'
  const map = buildProjectionMap(md, doc(p(text('甲')), schema.node('hr'), p(text('乙'))))
  assert.ok(map, 'a mid-document thematic break must not be read as front matter')
  assert.equal(map.blockPairs[1].mdBlock.type, 'thematicBreak')
  assert.ok(map.blockPairs[0].charMap)
  assert.ok(map.blockPairs[2].charMap)
  // PM: paragraph1 [0,3), hr [3,4), paragraph2 open 4 (content 5..6).
  assert.equal(map.pmPosToRaw(5), 8)
  assert.equal(md.slice(8, 9), '乙')
}

// F4: front matter followed immediately by a heading, and front matter as the
// document's ONLY block — the two shapes where the pair sits next to the
// document's own boundaries.
{
  const withHeading = buildProjectionMap('---\na: 1\n---\n\n# 标题\n',
    doc(fm('a: 1'), schema.node('heading', { level: 1 }, [text('标题')])))
  assert.ok(withHeading)
  assert.equal(withHeading.blockPairs[0].charMap, null)
  assert.ok(withHeading.blockPairs[1].charMap, 'the heading after the front matter is editable')
  assert.equal(withHeading.pmPosToRaw(2), 16)

  const alone = buildProjectionMap('---\na: 1\n---\n', doc(fm('a: 1')))
  assert.ok(alone, 'a document that is nothing but front matter still maps')
  assert.equal(alone.blockPairs.length, 1)
  assert.equal(alone.blockPairs[0].charMap, null)
}

// F5: the pairing stays fail-closed on a real structural disagreement — a PM
// `frontmatter` node where the source has no yaml block at all (and vice
// versa) must reject the WHOLE map, exactly like every other type mismatch.
{
  assert.equal(buildProjectionMap('甲\n', doc(fm('a: 1'), p(text('甲')))), null,
    'a PM front-matter node with no yaml block in the source rejects the map')
  assert.equal(buildProjectionMap('---\na: 1\n---\n\n甲\n', doc(p(text('甲')))), null,
    'a source yaml block with no PM counterpart rejects the map')
}

// Q1-Q4: THE EMPTY BLOCKQUOTE (2026-08-19). mdast gives a '>' line ZERO
// children; ProseMirror's `blockquote` is `content: "block+"` and the Milkdown
// transformer's `createAndFill` always puts an empty paragraph inside — so the
// PM side had one node more than the mdast side and the WHOLE map was rejected.
// Two consequences, both real: `/quote` (which commits exactly these bytes)
// could never succeed, and ANY document merely CONTAINING a bare '>' line
// degraded to legacy in its entirety.
//
// Synthesized exactly like an empty list item's auto-filled paragraph: a
// VIRTUAL editable pair anchored right after the marker.
{
  const bq = (...c) => schema.node('blockquote', null, c)

  // Q1: the bare marker. The anchor is the offset right after '>', which is
  // where typed text must land ('>' + 'x' -> '>x', still one blockquote).
  {
    const map = buildProjectionMap('>\n', doc(bq(p())))
    assert.ok(map, 'an empty blockquote must not reject the map')
    const pair = map.blockPairs[map.blockPairs.length - 1]
    assert.equal(pair.virtual, true)
    assert.equal(pair.charMap.visibleToRaw(0), 1, 'the anchor sits after the marker')
    assert.equal(pair.insertPrefix, '', 'no separator bytes: the line is already the quote')
  }
  // Q2: the marker's one optional space is part of the marker, so the anchor
  // moves past it.
  {
    const map = buildProjectionMap('> \n', doc(bq(p())))
    assert.ok(map)
    assert.equal(map.blockPairs[map.blockPairs.length - 1].charMap.visibleToRaw(0), 2)
  }
  // Q3: FAIL-CLOSED on the shape whose anchor is not provable. Only the FIRST
  // space belongs to the marker, so text typed after a second one would land
  // behind a byte the paragraph then strips — the dead byte this kernel must
  // never write. That blockquote stays read-only instead.
  {
    const map = buildProjectionMap('>  \n', doc(bq(p())))
    assert.ok(map, 'the document still maps')
    const pair = map.blockPairs[map.blockPairs.length - 1]
    assert.equal(pair.charMap, null, 'but the quote itself is not typable')
    assert.equal(pair.virtual, false)
  }
  // Q4: the rest of the document keeps its own map — this was the wider
  // regression: one bare '>' line used to take the whole file to legacy.
  {
    const md = '甲\n\n>\n\n乙\n'
    const map = buildProjectionMap(md, doc(p(text('甲')), bq(p()), p(text('乙'))))
    assert.ok(map, 'a mid-document empty blockquote must not reject the map')
    assert.equal(map.pmPosToRaw(1), 0)
    assert.equal(md.slice(map.pmPosToRaw(8), map.pmPosToRaw(8) + 1), '乙')
  }
}

// ===========================================================================
// CRLF SOFT-BREAK WIDENING (2026-08-21) — A CRLF SOFT-WRAPPED BLOCK MAPS
// ===========================================================================
// The former KNOWN LIMITATION pin (2026-08-20) is flipped per its own
// instruction: `textUnits` now emits ONE width-1 `linebreak` unit for the
// whole '\r\n' pair (plus continuation prefix), so `visibleLength` equals
// ProseMirror's `content.size` and the size check keeps the charMap. The
// everyday user-report shape — a bullet item wrapping onto a continuation
// line in a CRLF file — is editable again.
{
  const listDoc = (s) => doc(schema.node('bullet_list', null, [
    schema.node('list_item', null, [p(text(s))])
  ]))
  // CONTROL: the LF spelling maps and is editable (unchanged).
  {
    const md = '- 甲\n  乙\n'
    const map = buildProjectionMap(md, listDoc('甲\n乙'))
    assert.ok(map, 'the LF soft-wrapped list item maps')
    const pair = map.blockPairs[map.blockPairs.length - 1]
    assert.equal(pair.pmNode.type.name, 'paragraph')
    assert.ok(pair.charMap, 'and is editable — the wrapped item itself is not the problem')
  }
  // THE WIDENING: the same item spelled with CRLF maps identically.
  {
    const md = '- 甲\r\n  乙\r\n'
    const map = buildProjectionMap(md, listDoc('甲\n乙'))
    assert.ok(map, 'the CRLF document maps')
    const pair = map.blockPairs[map.blockPairs.length - 1]
    assert.equal(pair.pmNode.type.name, 'paragraph')
    assert.ok(pair.charMap,
      'a CRLF soft-wrapped list item must carry a charMap — the widening landed')
    assert.equal(pair.charMap.visibleLength, pair.pmNode.content.size,
      'the two counts agree: one visible unit per soft break, either spelling')
    // The linebreak unit owns the WHOLE ending plus the continuation indent,
    // so a delete of the soft break resolves to exactly those bytes.
    assert.deepEqual(pair.charMap.rawRangeForVisibleRange(1, 2), { from: 3, to: 7 })
  }
  // Lone-CR (classic Mac) continuation: same widening, same outcome.
  {
    const md = '- 甲\r  乙\r'
    const map = buildProjectionMap(md, listDoc('甲\n乙'))
    assert.ok(map, 'the lone-CR document maps')
    const pair = map.blockPairs[map.blockPairs.length - 1]
    assert.ok(pair.charMap, 'a lone-CR soft-wrapped list item must carry a charMap')
    assert.equal(pair.charMap.visibleLength, pair.pmNode.content.size)
  }
}

// ===========================================================================
// Case: rawToPmCaret — CARET resolution for offsets the write path refuses
// ===========================================================================
// `rawToPmPos` fails closed on any offset outside a charMap unit boundary —
// correct for WRITES (a wrong success writes a wrong byte), but a committed
// selection anchor still needs a HOME in the view after a structure-changing
// reconcile. The measured failure (2026-08-21): typing `*` on a blank line
// commits the byte, the reparse makes an empty bullet item (charMap: null, no
// mdBlock — the syntheticEmptyItemParagraph pair), the repair reconcile had no
// caret target, and the caret was thrown into the trailing placeholder — the
// continuation text landed in the WRONG BLOCK, silently.
//
// The caret resolver answers the weaker, safe question "where may the caret
// SIT for this raw offset": the write-path answer when it exists, else the
// single caret position of the empty textblock whose marker span contains the
// offset — an empty textblock has exactly one, so this is a derivation, not a
// guess. It never makes an unmappable offset writable.
{
  // '甲\n\n*' — 甲(0) \n(1) \n(2) *(3). PM: p('甲')[0..3), bullet_list(4:
  // list_item(5: paragraph(6..6))). Empty-item pair: pmPos 5? paragraph node
  // begins at 5 → contentPos 6. Derived below from the pair itself, so the
  // assertion cannot rot if node sizes shift.
  const md = '甲\n\n*'
  const d = doc(p(text('甲')), schema.node('bullet_list', null, [
    schema.node('list_item', null, [p()])
  ]))
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'the bare-marker document maps (the empty item pairs read-only)')
  const itemPair = map.blockPairs.find((pair) => !pair.charMap && pair.pmNode.type.name === 'paragraph')
  assert.ok(itemPair, 'the empty item paragraph pairs with charMap null')
  assert.equal(map.rawToPmPos(4), null, 'the WRITE path still refuses the marker-end offset')
  const caret = map.rawToPmCaret(4)
  assert.ok(caret, 'the CARET path resolves it')
  assert.equal(caret.pos, itemPair.pmPos + 1, 'to the empty item paragraph, its only caret position')
  // Direct passthrough: an offset the write path CAN resolve answers identically.
  assert.deepEqual(map.rawToPmCaret(1), map.rawToPmPos(1))
  // An offset on the blank line belongs to no block: still null (fail-closed).
  assert.equal(map.rawToPmCaret(2), null)
}
{
  // Bare heading: '甲\n\n#' — the heading pairs generically (mdBlock present,
  // charMap null because a spacing-less ATX heading has no provable content
  // start), so the caret resolver must serve the mdBlock span too.
  const md = '甲\n\n#'
  const d = doc(p(text('甲')), schema.node('heading', { level: 1 }))
  const map = buildProjectionMap(md, d)
  assert.ok(map)
  const headingPair = map.blockPairs.find((pair) => pair.pmNode.type.name === 'heading')
  assert.ok(headingPair && !headingPair.charMap)
  assert.equal(map.rawToPmPos(4), null)
  assert.deepEqual(map.rawToPmCaret(4), { pos: headingPair.pmPos + 1, atom: false })
}

console.log('PASS kernel projection map (front matter pairs, stays read-only)')

// ===========================================================================
// Lazy character maps (perf assessment §9 #4): building the map must not pay
// for every block's charMap up front — the document-wide buildCharacterMap
// pass was ~50 % of buildProjectionMap (103 ms at 200 KB, superlinear at
// 1 MB) while a keystroke touches ONE block. A non-empty textblock pair's
// `charMap` therefore materializes on first ACCESS; every proof (size,
// endpoints, byte-for-byte units) still runs at materialization, i.e. before
// any offset from that pair can be served — the fail-closed posture is
// unchanged, only its timing is.
// ===========================================================================
{
  const md = '甲乙\n\n丙丁\n\n戊\n'
  const pmDoc = doc(p(text('甲乙')), p(text('丙丁')), p(text('戊')))
  const map = buildProjectionMap(md, pmDoc)
  assert.ok(map, 'the map builds')
  const pair = map.blockPairs[0]
  const descriptor = Object.getOwnPropertyDescriptor(pair, 'charMap')
  assert.equal(typeof descriptor.get, 'function',
    'a non-empty textblock pair defers its charMap behind a getter')
  // Materialization serves the SAME proven map the eager build produced —
  // and caches it (same object on the second read).
  const first = pair.charMap
  assert.ok(first, 'materialized charMap is served')
  assert.equal(pair.charMap, first, 'materialization is cached, not rebuilt per access')
  assert.equal(first.visibleLength, 2)
  // Resolution through the deferred pairs is byte-identical to the eager
  // behavior: content scans, raw scans, and the marker-gap resolvers.
  assert.equal(map.pmPosToRaw(1), 0)
  assert.equal(map.pmPosToRaw(3), 2)
  assert.equal(map.pmPosToRaw(5), 4) // second paragraph '丙' start
  assert.equal(map.rawToPmPos(4)?.pos, 5)
  assert.equal(map.rawToPmPos(8)?.pos, 9) // '戊' start: contentPos 9 + vis 0
}

// A deferred pair whose proof FAILS at materialization degrades exactly like
// the eager build did: charMap null, the pair is skipped by every resolver,
// the neighbours keep serving. (PM text disagreeing with the source at an
// endpoint is the cheapest way to force the proof to fail.)
{
  const md = '甲乙\n\n丙丁\n'
  const pmDoc = doc(p(text('甲乙')), p(text('丙X')))
  const map = buildProjectionMap(md, pmDoc)
  assert.ok(map, 'a content disagreement degrades the pair, never the map')
  assert.equal(map.blockPairs[1].charMap, null, 'the disagreeing pair fails its proof lazily')
  assert.equal(map.pmPosToRaw(5), null, 'no offset is ever served from it')
  assert.equal(map.pmPosToRaw(1), 0, 'the healthy neighbour still serves')
}
console.log('PASS kernel projection map (lazy charMaps)')
