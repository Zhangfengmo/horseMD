// TDD evidence + regression lock for
// src/renderer/src/lib/source-kernel/commands/trailing-whitespace.js.
//
// THE BUG THIS FILE PINS. In kernel mode, typing `a b` at the END of a
// paragraph produced source `末段。ab ` and view `末段。ab` — the space the user
// pressed was lost from BOTH, and a dead byte was stranded on disk. CommonMark
// strips a block's trailing ASCII whitespace run, so the space was committed at
// the one offset where it can never come back, the projection check then
// repaired the view to match the (character-less) bytes, and the NEXT character
// mapped to the block's content end, i.e. in FRONT of the stranded byte.
//
// Because prose is composed left to right, the caret is at a block end for
// essentially every inter-word space. This is ordinary typing, not an edge
// case, which is why a blanket refusal was rejected: it would fire on every
// word AND still lose the character.
//
// WHAT IS WRITTEN. A real U+00A0 (the one whitespace character CommonMark does
// not strip), raw in the source — never `&nbsp;`, which the user rejected on
// sight in source mode. It is HEALED back to an ordinary space in the same edit
// as the character that displaces it, so a finished sentence holds exactly the
// bytes any other editor would write.
//
// Every expectation below is stated as the committed FILE plus what that file
// REPARSES to — the two halves of 存下来并且能被看到.
import assert from 'node:assert/strict'
import {
  spellBlockTailInsert,
  literalTailIsStripped,
  healableTrailingSpace,
  BLOCK_TRAILING_TEXT,
  NO_BREAK_SPACE
} from '../src/renderer/src/lib/source-kernel/commands/trailing-whitespace.js'
import { applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { parseKernelMarkdown } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { buildCharacterMap } from '../src/renderer/src/lib/source-kernel/character-map.js'

const NBSP = NO_BREAK_SPACE
assert.equal(NBSP, '\u00A0')
assert.equal(BLOCK_TRAILING_TEXT[' '], NBSP, 'a Space is ONE no-break space')
assert.equal(BLOCK_TRAILING_TEXT['\t'], NBSP + NBSP, 'a Tab is TWO')

// THE PROVENANCE LEDGER travels on the document (markdown-document.js), and the
// heal may only ever claim a U+00A0 THIS kernel wrote — so every sequence below
// carries the ledger forward exactly as the live kernel does. `marks` defaults
// to the empty ledger a freshly opened file has.
const doc = (text, marks = []) => ({ text, revision: 3, whitespaceMarks: marks })

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
function step(text, { type, start }, offset, insert, marks = []) {
  const block = blockAt(text, type, start)
  assert.ok(block, `no ${type} block at ${start} in ${JSON.stringify(text)}`)
  const map = buildCharacterMap(text, block)
  const heal = map ? healableTrailingSpace(text, map, marks) : null
  const routed = spellBlockTailInsert({ doc: doc(text, marks), block, offset, insert, heal })
  if (!routed.ok) return { refused: routed.code }
  assert.equal(routed.transaction.baseRevision, 3, 'transaction must carry the doc revision')
  const applied = applySourceTransaction(doc(text, marks), routed.transaction)
  assert.ok(applied.ok, `applySourceTransaction refused: ${applied.code}`)
  return {
    bytes: applied.doc.text,
    marks: applied.doc.whitespaceMarks,
    spelling: routed.spelling,
    healed: routed.healed
  }
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
  // the space: block-trailing, so it is written as a character that survives
  const spaced = step(text, { type: 'paragraph', start: 0 }, 4, ' ')
  assert.equal(spaced.bytes, '末段。a' + NBSP + '\n')
  assert.equal(spaced.spelling, 'no-break-space')
  assert.ok(!/&[#a-zA-Z0-9]+;/.test(spaced.bytes),
    'the source must hold whitespace, never a character reference')
  assert.equal(visible(spaced.bytes, 'paragraph', 0), '末段。a' + NBSP,
    'the typed space must be visible in the reparse')
  text = spaced.bytes

  // the 'b': the space is no longer last, so it heals back to an ordinary space
  const healed = step(text, { type: 'paragraph', start: 0 }, 5, 'b', spaced.marks)
  assert.equal(healed.bytes, '末段。a b\n',
    'the file must hold ordinary bytes once the space is interior')
  assert.equal(healed.healed, true)
  assert.equal(healed.spelling, 'literal')
  assert.equal(visible(healed.bytes, 'paragraph', 0), '末段。a b')
}

// ---------------------------------------------------------------------------
// 2) TWO SPACES IN A ROW at a block end. The first heals to an ordinary space,
//    the second takes the no-break form — so both survive, one at a time.
// ---------------------------------------------------------------------------
{
  const first = step('a\n', { type: 'paragraph', start: 0 }, 1, ' ')
  assert.equal(first.bytes, 'a' + NBSP + '\n')
  const second = step(first.bytes, { type: 'paragraph', start: 0 }, 2, ' ', first.marks)
  assert.equal(second.bytes, 'a ' + NBSP + '\n')
  assert.equal(second.healed, true)
  assert.equal(visible(second.bytes, 'paragraph', 0), 'a ' + NBSP,
    'both spaces must survive the reparse')

  const third = step(second.bytes, { type: 'paragraph', start: 0 }, 3, 'x', second.marks)
  assert.equal(third.bytes, 'a  x\n', 'and both must resolve to ordinary spaces')
  assert.equal(visible(third.bytes, 'paragraph', 0), 'a  x')
}

// ---------------------------------------------------------------------------
// 3) A TAB at a block end takes TWO no-break spaces — the user's own
//    proportion — and the WHOLE recorded run heals back to a Tab when a
//    character displaces it (2026-08-19, audit I5′). Before the ledger existed
//    the run was never healed and further whitespace kept appending to it
//    without bound.
// ---------------------------------------------------------------------------
{
  const tabbed = step('a\n', { type: 'paragraph', start: 0 }, 1, '\t')
  assert.equal(tabbed.bytes, 'a' + NBSP + NBSP + '\n')
  assert.equal(visible(tabbed.bytes, 'paragraph', 0), 'a' + NBSP + NBSP)
  assert.deepEqual(tabbed.marks, [{ from: 1, to: 3, ascii: '\t' }],
    'the ledger records the run AND which key it stands for')

  // the next character heals the whole run back to the Tab that was pressed
  const healed = step(tabbed.bytes, { type: 'paragraph', start: 0 }, 3, 'z', tabbed.marks)
  assert.equal(healed.bytes, 'a\tz\n')
  assert.equal(visible(healed.bytes, 'paragraph', 0), 'a\tz')
  assert.deepEqual(healed.marks, [], 'the spent entry is dropped')

  // ACCUMULATION IS BOUNDED: a second Tab resolves the first one instead of
  // appending to it, so the run at the block end is always the last keystroke's.
  const twice = step(tabbed.bytes, { type: 'paragraph', start: 0 }, 3, '\t', tabbed.marks)
  assert.equal(twice.bytes, 'a\t' + NBSP + NBSP + '\n', 'two U+00A0, never four')
  const thrice = step(twice.bytes, { type: 'paragraph', start: 0 }, 4, '\t', twice.marks)
  assert.equal(thrice.bytes, 'a\t\t' + NBSP + NBSP + '\n')
  const finished = step(thrice.bytes, { type: 'paragraph', start: 0 }, 5, 'z', thrice.marks)
  assert.equal(finished.bytes, 'a\t\t\tz\n',
    'three Tabs and a character must land exactly three Tabs and a character')

  // A U+00A0 run with NO provenance is still claimed by nothing.
  const authored = 'a' + NBSP + NBSP + '\n'
  assert.equal(healableTrailingSpace(authored,
    buildCharacterMap(authored, blockAt(authored, 'paragraph', 0)), []), null,
    "a run this kernel did not write is the author's")
}

// ---------------------------------------------------------------------------
// 4) A HEADING's end is the same shape.
// ---------------------------------------------------------------------------
{
  const spaced = step('## 乙\n\n末段。\n', { type: 'heading', start: 0 }, 4, ' ')
  assert.equal(spaced.bytes, '## 乙' + NBSP + '\n\n末段。\n')
  assert.equal(visible(spaced.bytes, 'heading', 0), '乙' + NBSP)
  const healed = step(spaced.bytes, { type: 'heading', start: 0 }, 5, '丙', spaced.marks)
  assert.equal(healed.bytes, '## 乙 丙\n\n末段。\n',
    'the heading must end with the ordinary two-character text the user typed')
  assert.equal(visible(healed.bytes, 'heading', 0), '乙 丙')
}

// ---------------------------------------------------------------------------
// 4b) THE HEAL MUST NOT FIRE where the healed space would die again: at an ATX
//     heading's own content start the ordinary space is stripped, so the proof
//     fails and the command falls through to the plain append — keeping the
//     no-break space that heading-whitespace.js put there.
// ---------------------------------------------------------------------------
{
  const text = '## ' + NBSP + '\n'
  const block = blockAt(text, 'heading', 0)
  const map = buildCharacterMap(text, block)
  // The ledger is seeded by hand with exactly what a Space typed there would
  // have recorded, so this case tests the PROOF and not the provenance gate.
  const marks = [{ from: 3, to: 4, ascii: ' ' }]
  const heal = healableTrailingSpace(text, map, marks)
  assert.ok(heal, 'the no-break space IS a single trailing run this kernel wrote')
  const routed = spellBlockTailInsert({ doc: doc(text, marks), block, offset: 4, insert: '标', heal })
  assert.deepEqual(routed, { ok: false, code: 'not-structural' },
    'healing at an ATX content start would delete the character — it must fall through')
}

// ---------------------------------------------------------------------------
// 5) PRE-EXISTING dead bytes are never touched. A paragraph that already ends
//    with two stranded spaces keeps them; the new character is written at the
//    block's visible end, in front of them.
// ---------------------------------------------------------------------------
{
  const result = step('a  \n\nb\n', { type: 'paragraph', start: 0 }, 1, ' ')
  assert.equal(result.bytes, 'a' + NBSP + '  \n\nb\n')
  assert.equal(visible(result.bytes, 'paragraph', 0), 'a' + NBSP)
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
  assert.equal(spaced.bytes, '| a' + NBSP + ' | b |\n| - | - |\n| c | d |\n')
  assert.equal(visible(spaced.bytes, 'tableCell', 0), 'a' + NBSP)
  const rows = parseKernelMarkdown(spaced.bytes).children[0]
  assert.equal(rows.type, 'table', 'it must still be a table')
  assert.equal(rows.children.length, 2, 'header row + one body row')
  assert.equal(rows.children[0].children.length, 2, 'the column count must not change')

  const healed = step(spaced.bytes, { type: 'tableCell', start: 0 }, 4, 'x', spaced.marks)
  assert.equal(healed.bytes, '| a x | b |\n| - | - |\n| c | d |\n')
  assert.equal(visible(healed.bytes, 'tableCell', 0), 'a x')
}
{
  // compact table, second cell (its span includes the closing '|')
  const src = '|a|b|\n|-|-|\n|c|d|\n'
  assert.ok(blockAt(src, 'tableCell', 2), 'the second cell must start at offset 2')
  const spaced = step(src, { type: 'tableCell', start: 2 }, 4, ' ')
  assert.equal(spaced.bytes, '|a|b' + NBSP + '|\n|-|-|\n|c|d|\n')
  assert.equal(visible(spaced.bytes, 'tableCell', 2), 'b' + NBSP)
}

// ---------------------------------------------------------------------------
// 7) MUST NOT TOUCH: the shapes where trailing whitespace is real.
// ---------------------------------------------------------------------------
{
  // 7a) a fenced code block: trailing spaces are CONTENT and byte-preserved.
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
  // …but the END of that same paragraph IS claimed, and the hard break survives.
  const atEnd = step(hard, { type: 'paragraph', start: 0 }, 5, ' ')
  assert.equal(atEnd.bytes, 'a  \nb' + NBSP + '\n')
  const reparsed = blockAt(atEnd.bytes, 'paragraph', 0)
  assert.equal(reparsed.children[1].type, 'break', 'the hard break must still be a hard break')
  assert.equal(decodedText(reparsed), 'ab' + NBSP)

  // 7c) an INTERIOR space is not this command's shape — the plain path already
  //     commits it byte-exact.
  const interior = 'ab\n'
  const iPara = blockAt(interior, 'paragraph', 0)
  assert.equal(literalTailIsStripped(interior, iPara, 1), false)
  assert.deepEqual(
    spellBlockTailInsert({ doc: doc(interior), block: iPara, offset: 1, insert: ' ' }),
    { ok: false, code: 'not-structural' })
}

// ---------------------------------------------------------------------------
// 8) The heal claims a run of EXACTLY ONE no-break space, and re-proves the
//    caller's span against the bytes.
// ---------------------------------------------------------------------------
{
  const text = 'ax\n'
  const block = blockAt(text, 'paragraph', 0)
  const routed = spellBlockTailInsert({
    doc: doc(text), block, offset: 2, insert: 'y',
    heal: { rawStart: 1, rawEnd: 2, ascii: ' ' }
  })
  assert.deepEqual(routed, { ok: false, code: 'not-structural' },
    'a caller-supplied heal span must be re-proven against the bytes')
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
  assert.equal(quoted.bytes, '> q' + NBSP + '\n')
  assert.equal(parseKernelMarkdown(quoted.bytes).children[0].type, 'blockquote')
  assert.equal(visible(quoted.bytes, 'paragraph', 2), 'q' + NBSP)

  const item = step('- item\n', { type: 'paragraph', start: 2 }, 6, ' ')
  assert.equal(item.bytes, '- item' + NBSP + '\n')
  assert.equal(parseKernelMarkdown(item.bytes).children[0].type, 'list')
  assert.equal(visible(item.bytes, 'paragraph', 2), 'item' + NBSP)
  const healed = step(item.bytes, { type: 'paragraph', start: 2 }, 7, 'x', item.marks)
  assert.equal(healed.bytes, '- item x\n')
}

// ---------------------------------------------------------------------------
// 11) IDEMPOTENCE / long run: typing a whole sentence one character at a time
//     must produce exactly the sentence, byte for byte — no no-break space may
//     survive anywhere in the middle of it.
// ---------------------------------------------------------------------------
{
  let text = 'h\n'
  let offset = 1
  let marks = []
  for (const ch of 'ello world from horsemd') {
    const block = blockAt(text, 'paragraph', 0)
    const map = buildCharacterMap(text, block)
    const heal = healableTrailingSpace(text, map, marks)
    const routed = spellBlockTailInsert({ doc: doc(text, marks), block, offset, insert: ch, heal })
    if (routed.ok) {
      const applied = applySourceTransaction(doc(text, marks), routed.transaction)
      text = applied.doc.text
      marks = applied.doc.whitespaceMarks
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

// ---------------------------------------------------------------------------
// 12) AN INSERT THAT *ENDS* IN WHITESPACE (2026-08-19, audit item 2). Pasting
//     `hello ` at a paragraph end wrote that trailing space literally, and
//     CommonMark strips it — the original dead byte, arriving by a route the
//     single-character table could not see. Only the insert's own trailing run
//     is re-spelled; everything before it is byte-exact as it always was.
// ---------------------------------------------------------------------------
{
  const pasted = step('a\n', { type: 'paragraph', start: 0 }, 1, 'hello ')
  assert.equal(pasted.bytes, 'ahello' + NBSP + '\n',
    'the trailing space must survive; the pasted text itself must not change')
  assert.equal(pasted.spelling, 'no-break-space')
  assert.equal(visible(pasted.bytes, 'paragraph', 0), 'ahello' + NBSP,
    'the pasted trailing space must be visible in the reparse')

  // The interior of the paste is untouched: a space INSIDE it is an ordinary
  // byte, because only the run at the very end lands at the block's end.
  const inner = step('a\n', { type: 'paragraph', start: 0 }, 1, 'two words ')
  assert.equal(inner.bytes, 'atwo words' + NBSP + '\n')

  // A paste with NO trailing whitespace is not this command's business at all.
  assert.deepEqual(step('a\n', { type: 'paragraph', start: 0 }, 1, 'hello'),
    { refused: 'not-structural' })

  // A trailing TAB takes the same two-character spelling a typed Tab does.
  const tabbed = step('a\n', { type: 'paragraph', start: 0 }, 1, 'x\t')
  assert.equal(tabbed.bytes, 'ax' + NBSP + NBSP + '\n')

  // A HEADING's end behaves identically, and the next character still heals.
  const heading = step('## t\n', { type: 'heading', start: 0 }, 4, 'ail ')
  assert.equal(heading.bytes, '## tail' + NBSP + '\n')
  const healed = step(heading.bytes, { type: 'heading', start: 0 }, 8, 'x', heading.marks)
  assert.equal(healed.bytes, '## tail x\n')
}

// ---------------------------------------------------------------------------
// 13) PROVENANCE (2026-08-19, audit I4′). The heal used to claim ANY single
//     trailing U+00A0, so a document that ALREADY used one — a file authored
//     elsewhere with U+00A0 for CJK spacing — lost it the first time that
//     paragraph was touched: this kernel rewriting a character it never wrote.
//     Only a run recorded in the document's own session ledger is claimed.
// ---------------------------------------------------------------------------
{
  // A file just opened: the ledger is empty, so the U+00A0 in it is the
  // author's and survives every keystroke.
  const authored = '甲' + NBSP + '\n'
  const block = blockAt(authored, 'paragraph', 0)
  const map = buildCharacterMap(authored, block)
  assert.equal(healableTrailingSpace(authored, map, []), null,
    "a U+00A0 with no provenance is the author's and must never be claimed")
  assert.deepEqual(step(authored, { type: 'paragraph', start: 0 }, 2, '乙'),
    { refused: 'not-structural' },
    'so the next character falls through and the character is preserved')

  // The SAME bytes, once this kernel is the one that wrote them, do heal.
  const typed = step('甲\n', { type: 'paragraph', start: 0 }, 1, ' ')
  assert.equal(typed.bytes, authored, 'the bytes are identical either way')
  assert.deepEqual(typed.marks, [{ from: 1, to: 2, ascii: ' ' }],
    'the ledger records the span and the key that was pressed')
  const healed = step(typed.bytes, { type: 'paragraph', start: 0 }, 2, '乙', typed.marks)
  assert.equal(healed.bytes, '甲 乙\n')

  // The ledger is re-validated against the committed bytes, so an entry can
  // never outlive the character it was recorded for: once the heal has spent
  // it, nothing is left claiming that offset.
  assert.deepEqual(healed.marks, [], 'a spent entry is dropped')

  // An entry whose span is no longer a U+00A0 run is dropped too, whatever
  // rewrote it — the ledger cannot vouch for bytes it does not match.
  const applied = applySourceTransaction(
    doc('甲' + NBSP + '\n', [{ from: 1, to: 2, ascii: ' ' }]),
    { baseRevision: 3, edits: [{ from: 0, to: 1, insert: '乙' }], intent: 'insert-text' }
  )
  assert.ok(applied.ok)
  assert.deepEqual(applied.doc.whitespaceMarks, [{ from: 1, to: 2, ascii: ' ' }],
    'an untouched entry shifts with the bytes it describes')
  const clobbered = applySourceTransaction(
    doc('甲' + NBSP + '\n', [{ from: 1, to: 2, ascii: ' ' }]),
    { baseRevision: 3, edits: [{ from: 1, to: 2, insert: 'x' }], intent: 'insert-text' }
  )
  assert.deepEqual(clobbered.doc.whitespaceMarks, [], 'an overwritten entry is dropped')
}

console.log('PASS source-kernel block-trailing whitespace: a space typed at a block end survives as real whitespace in the source AND in the view, and heals to an ordinary space on the next character')
