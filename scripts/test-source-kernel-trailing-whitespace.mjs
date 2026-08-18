// TDD evidence + regression lock for
// src/renderer/src/lib/source-kernel/commands/trailing-whitespace.js.
//
// THE BUG THIS FILE PINS. In kernel mode, typing `a b` at the END of a
// paragraph produced source `末段。ab ` and view `末段。ab` — the space the user
// pressed was lost from BOTH, and a dead byte was stranded on disk. CommonMark
// strips a block's trailing whitespace run, so the space was committed at the
// one offset where it can never come back, the projection check then repaired
// the view to match the (character-less) bytes, and the NEXT character mapped
// to the block's content end, i.e. in FRONT of the stranded byte.
//
// Because prose is composed left to right, the caret is at a block end for
// essentially every inter-word space. This is ordinary typing, not an edge
// case, which is why a blanket refusal was rejected: it would fire on every
// word AND still lose the character.
//
// Every expectation below is stated as the committed FILE plus what that file
// REPARSES to — the two halves of 存下来并且能被看到.
import assert from 'node:assert/strict'
import {
  spellBlockTailInsert,
  literalTailIsStripped,
  trailingEntityTail,
  BLOCK_TRAILING_ENTITY,
  TRAILING_ENTITY_LITERAL
} from '../src/renderer/src/lib/source-kernel/commands/trailing-whitespace.js'
import { applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { parseKernelMarkdown } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { buildCharacterMap } from '../src/renderer/src/lib/source-kernel/character-map.js'

assert.equal(BLOCK_TRAILING_ENTITY[' '], '&#32;')
assert.equal(BLOCK_TRAILING_ENTITY['\t'], '&#9;')
assert.equal(TRAILING_ENTITY_LITERAL['&#32;'], ' ')
assert.equal(TRAILING_ENTITY_LITERAL['&#9;'], '\t')

const doc = (text) => ({ text, revision: 3 })

const blocksOf = (text) => {
  const out = []
  const walk = (node) => {
    if (node.type !== 'root') out.push(node)
    for (const child of node.children || []) walk(child)
  }
  walk(parseKernelMarkdown(text))
  return out
}

const blockAt = (text, type, startOffset) =>
  blocksOf(text).find((node) =>
    node.type === type && node.position?.start?.offset === startOffset) || null

const decodedText = (node) => {
  const out = []
  const walk = (n) => {
    if (typeof n?.value === 'string') out.push(n.value)
    for (const child of n?.children || []) walk(child)
  }
  for (const child of node?.children || []) walk(child)
  return out.join('')
}

// The whole point of the module: a committed edit must be OBSERVABLE. So every
// step here goes through the real transaction applier and then reports what the
// resulting bytes actually decode to for the edited block.
function step(text, { type, start }, offset, insert) {
  const block = blockAt(text, type, start)
  assert.ok(block, `no ${type} block at ${start} in ${JSON.stringify(text)}`)
  const map = buildCharacterMap(text, block)
  const tail = map ? trailingEntityTail(text, map) : null
  const routed = spellBlockTailInsert({ doc: doc(text), block, offset, insert, tail })
  if (!routed.ok) return { refused: routed.code }
  assert.equal(routed.transaction.baseRevision, 3, 'transaction must carry the doc revision')
  const applied = applySourceTransaction(doc(text), routed.transaction)
  assert.ok(applied.ok, `applySourceTransaction refused: ${applied.code}`)
  return { bytes: applied.doc.text, spelling: routed.spelling, healed: routed.healed }
}

// Convenience: what the user sees for the block that starts at `start`.
const visible = (text, type, start) => {
  const block = blockAt(text, type, start)
  return block ? decodedText(block) : null
}

// ---------------------------------------------------------------------------
// 1) THE REPORTED SEQUENCE. Typing 'a', ' ', 'b' at the end of a paragraph must
//    end with the file saying `a b` — not `ab `.
// ---------------------------------------------------------------------------
{
  let text = '末段。a\n'
  // the space: block-trailing, so it is spelled portably
  const spaced = step(text, { type: 'paragraph', start: 0 }, 4, ' ')
  assert.equal(spaced.bytes, '末段。a&#32;\n')
  assert.equal(spaced.spelling, 'entity')
  assert.equal(visible(spaced.bytes, 'paragraph', 0), '末段。a ',
    'the typed space must be visible in the reparse')
  text = spaced.bytes

  // the 'b': the space is no longer last, so the entity heals back to a literal
  const healed = step(text, { type: 'paragraph', start: 0 }, 9, 'b')
  assert.equal(healed.bytes, '末段。a b\n', 'the file must hold ordinary bytes once the space is interior')
  assert.equal(healed.healed, true)
  assert.equal(healed.spelling, 'literal')
  assert.equal(visible(healed.bytes, 'paragraph', 0), '末段。a b')
}

// ---------------------------------------------------------------------------
// 2) TWO SPACES IN A ROW at a block end. The first heals to a literal, the
//    second takes the entity — so both survive.
// ---------------------------------------------------------------------------
{
  const first = step('a\n', { type: 'paragraph', start: 0 }, 1, ' ')
  assert.equal(first.bytes, 'a&#32;\n')
  const second = step(first.bytes, { type: 'paragraph', start: 0 }, 6, ' ')
  assert.equal(second.bytes, 'a &#32;\n')
  assert.equal(second.healed, true)
  assert.equal(second.spelling, 'entity')
  assert.equal(visible(second.bytes, 'paragraph', 0), 'a  ', 'both spaces must survive the reparse')

  const third = step(second.bytes, { type: 'paragraph', start: 0 }, 7, 'x')
  assert.equal(third.bytes, 'a  x\n')
  assert.equal(visible(third.bytes, 'paragraph', 0), 'a  x')
}

// ---------------------------------------------------------------------------
// 3) A TAB at a block end takes the numeric-reference spelling too.
// ---------------------------------------------------------------------------
{
  const tabbed = step('a\n', { type: 'paragraph', start: 0 }, 1, '\t')
  assert.equal(tabbed.bytes, 'a&#9;\n')
  assert.equal(visible(tabbed.bytes, 'paragraph', 0), 'a\t')
  const after = step(tabbed.bytes, { type: 'paragraph', start: 0 }, 5, 'z')
  assert.equal(after.bytes, 'a\tz\n')
}

// ---------------------------------------------------------------------------
// 4) A HEADING's end is the same shape.
// ---------------------------------------------------------------------------
{
  const spaced = step('## 乙\n\n末段。\n', { type: 'heading', start: 0 }, 4, ' ')
  assert.equal(spaced.bytes, '## 乙&#32;\n\n末段。\n')
  assert.equal(visible(spaced.bytes, 'heading', 0), '乙 ')
  const healed = step(spaced.bytes, { type: 'heading', start: 0 }, 9, '丙')
  assert.equal(healed.bytes, '## 乙 丙\n\n末段。\n',
    'the heading must end with the ordinary two-character text the user typed')
  assert.equal(visible(healed.bytes, 'heading', 0), '乙 丙')
}

// ---------------------------------------------------------------------------
// 5) PRE-EXISTING dead bytes are never touched. A paragraph that already ends
//    with two stranded spaces keeps them; the new character is inserted at the
//    block's visible end, in front of them.
// ---------------------------------------------------------------------------
{
  const result = step('a  \n\nb\n', { type: 'paragraph', start: 0 }, 1, ' ')
  assert.equal(result.bytes, 'a&#32;  \n\nb\n')
  assert.equal(visible(result.bytes, 'paragraph', 0), 'a ')
}

// ---------------------------------------------------------------------------
// 6) GFM TABLE CELLS. Cell padding is stripped exactly like a block tail, so
//    the same corruption lived there: `a b` typed into a cell used to become
//    `ab`. Both the padded and the compact cell must survive, and the table
//    must still be a table.
// ---------------------------------------------------------------------------
{
  const src = '| a | b |\n| - | - |\n| c | d |\n'
  // the first cell's own span is '| a ' -> its visible end is offset 3
  const spaced = step(src, { type: 'tableCell', start: 0 }, 3, ' ')
  assert.equal(spaced.bytes, '| a&#32; | b |\n| - | - |\n| c | d |\n')
  assert.equal(visible(spaced.bytes, 'tableCell', 0), 'a ')
  const rows = parseKernelMarkdown(spaced.bytes).children[0]
  assert.equal(rows.type, 'table', 'it must still be a table')
  assert.equal(rows.children.length, 2, 'header row + one body row')
  assert.equal(rows.children[0].children.length, 2, 'the column count must not change')

  const healed = step(spaced.bytes, { type: 'tableCell', start: 0 }, 8, 'x')
  assert.equal(healed.bytes, '| a x | b |\n| - | - |\n| c | d |\n')
  assert.equal(visible(healed.bytes, 'tableCell', 0), 'a x')
}
{
  // compact table, last cell (its span includes the closing '|')
  const src = '|a|b|\n|-|-|\n|c|d|\n'
  const cell = blockAt(src, 'tableCell', 2)
  assert.ok(cell, 'the second cell must start at offset 2')
  const spaced = step(src, { type: 'tableCell', start: 2 }, 4, ' ')
  assert.equal(spaced.bytes, '|a|b&#32;|\n|-|-|\n|c|d|\n')
  assert.equal(visible(spaced.bytes, 'tableCell', 2), 'b ')
}

// ---------------------------------------------------------------------------
// 7) MUST NOT TOUCH: the shapes where trailing whitespace is real.
// ---------------------------------------------------------------------------
{
  // 7a) a fenced code block: trailing spaces are CONTENT and byte-preserved.
  //     The command does not claim `code` blocks at all.
  const code = '```js\nlet a = 1 \n```\n'
  const block = blockAt(code, 'code', 0)
  assert.ok(block)
  assert.equal(literalTailIsStripped(code, block, 19), false,
    'a fenced block must never be claimed')
  assert.deepEqual(
    spellBlockTailInsert({ doc: doc(code), block, offset: 19, insert: ' ' }),
    { ok: false, code: 'not-structural' })

  // 7b) the two-space HARD BREAK. The whitespace run before the line ending is
  //     the break's own syntax; the run does not reach the block end, so the
  //     predicate refuses and the literal byte is kept.
  const hard = 'a  \nb\n'
  const para = blockAt(hard, 'paragraph', 0)
  assert.equal(para.children[1].type, 'break', 'the fixture must really hold a hard break')
  assert.equal(literalTailIsStripped(hard, para, 1), false)
  assert.equal(literalTailIsStripped(hard, para, 3), false)
  assert.deepEqual(
    spellBlockTailInsert({ doc: doc(hard), block: para, offset: 3, insert: ' ' }),
    { ok: false, code: 'not-structural' })
  // …but the END of that same paragraph (after 'b') IS claimed, and the hard
  // break survives the rewrite untouched.
  const atEnd = step(hard, { type: 'paragraph', start: 0 }, 5, ' ')
  assert.equal(atEnd.bytes, 'a  \nb&#32;\n')
  const reparsed = blockAt(atEnd.bytes, 'paragraph', 0)
  assert.equal(reparsed.children[1].type, 'break', 'the hard break must still be a hard break')
  assert.equal(decodedText(reparsed), 'ab ')

  // 7c) an INTERIOR space (not at the block's visible end) is not this
  //     command's shape — the plain path already commits it byte-exact.
  const interior = 'ab\n'
  const iPara = blockAt(interior, 'paragraph', 0)
  assert.equal(literalTailIsStripped(interior, iPara, 1), false)
  assert.deepEqual(
    spellBlockTailInsert({ doc: doc(interior), block: iPara, offset: 1, insert: ' ' }),
    { ok: false, code: 'not-structural' })
}

// ---------------------------------------------------------------------------
// 8) The literalization set is CLOSED. A `&nbsp;` (heading-whitespace.js's own
//    spelling) or any entity this module did not write is never rewritten.
// ---------------------------------------------------------------------------
{
  const text = '# &nbsp;\n'
  const heading = blockAt(text, 'heading', 0)
  const map = buildCharacterMap(text, heading)
  assert.equal(trailingEntityTail(text, map), null,
    '&nbsp; is not one of this module\'s spellings')
  const routed = spellBlockTailInsert({
    doc: doc(text), block: heading, offset: 8, insert: 'x',
    tail: { rawStart: 2, rawEnd: 8, literal: ' ' }
  })
  assert.equal(routed.ok, false, 'a caller-supplied tail must be re-proven against the bytes')
  assert.equal(routed.code, 'not-structural')
}

// ---------------------------------------------------------------------------
// 9) Input hygiene: only ONE code point, never a line break, never a
//    stale/foreign block node.
// ---------------------------------------------------------------------------
{
  const text = 'a\n'
  const block = blockAt(text, 'paragraph', 0)
  for (const insert of ['', 'ab', '\n', ' \n']) {
    assert.equal(spellBlockTailInsert({ doc: doc(text), block, offset: 1, insert }).ok, false,
      `insert ${JSON.stringify(insert)} must be refused`)
  }
  // a block whose span does not match the document is not proven -> fall through
  assert.deepEqual(
    spellBlockTailInsert({
      doc: doc(text), offset: 1, insert: ' ',
      block: { type: 'paragraph', position: { start: { offset: 0 }, end: { offset: 99 } } }
    }),
    { ok: false, code: 'not-structural' })
}

// ---------------------------------------------------------------------------
// 10) BLOCKQUOTE and LIST ITEM paragraphs are ordinary paragraphs — the same
//     rewrite must keep their container intact.
// ---------------------------------------------------------------------------
{
  const quoted = step('> q\n', { type: 'paragraph', start: 2 }, 3, ' ')
  assert.equal(quoted.bytes, '> q&#32;\n')
  assert.equal(parseKernelMarkdown(quoted.bytes).children[0].type, 'blockquote')
  assert.equal(visible(quoted.bytes, 'paragraph', 2), 'q ')

  const item = step('- item\n', { type: 'paragraph', start: 2 }, 6, ' ')
  assert.equal(item.bytes, '- item&#32;\n')
  assert.equal(parseKernelMarkdown(item.bytes).children[0].type, 'list')
  assert.equal(visible(item.bytes, 'paragraph', 2), 'item ')
  const healed = step(item.bytes, { type: 'paragraph', start: 2 }, 11, 'x')
  assert.equal(healed.bytes, '- item x\n')
}

// ---------------------------------------------------------------------------
// 11) IDEMPOTENCE / long run: typing a whole sentence one character at a time
//     must produce exactly the sentence, byte for byte.
// ---------------------------------------------------------------------------
{
  let text = '\n'
  // seed a real paragraph first (the empty-document case belongs to the
  // virtual-block path, not to this command)
  text = 'h\n'
  let offset = 1
  for (const ch of 'ello world from horsemd') {
    const block = blockAt(text, 'paragraph', 0)
    const map = buildCharacterMap(text, block)
    const tail = trailingEntityTail(text, map)
    const routed = spellBlockTailInsert({ doc: doc(text), block, offset, insert: ch, tail })
    if (routed.ok) {
      text = applySourceTransaction(doc(text), routed.transaction).doc.text
      offset = routed.transaction.selection.head
    } else {
      assert.equal(routed.code, 'not-structural', `unexpected refusal for ${JSON.stringify(ch)}`)
      text = text.slice(0, offset) + ch + text.slice(offset)
      offset += ch.length
    }
  }
  assert.equal(text, 'hello world from horsemd\n')
  assert.equal(visible(text, 'paragraph', 0), 'hello world from horsemd')
}

console.log('PASS source-kernel block-trailing whitespace: a space typed at a block end survives as source AND as view, and heals to ordinary bytes on the next character')
