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
import { KERNEL_CODES } from '../src/renderer/src/lib/source-kernel/index.js'

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
    image: { group: 'inline', inline: true, atom: true, attrs: { src: { default: '' } } },
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

console.log('PASS kernel projection map')
