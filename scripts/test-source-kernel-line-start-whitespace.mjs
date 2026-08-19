// commands/line-start-whitespace.js — the third position in the kernel's
// whitespace family, and the one the user reported directly:
// 「tab 在行开头输入容易触发内核不支持此操作」.
//
// A LINE's own leading whitespace is block structure in CommonMark everywhere it
// appears (paragraph indentation, a list marker's padding, a blockquote's `>`
// padding), so a literal byte written there is not content. Measured in the built
// app in kernel mode before this command existed, one keystroke at a time:
//   * Tab at a top-level paragraph's first content position wrote a literal '\t'
//     and the paragraph REPARSED AS AN INDENTED CODE BLOCK — silently, with no
//     toast, only a `caret-unmappable` diagnostic.
//   * Space at the same position wrote a literal ' ' that CommonMark strips; the
//     projection check repaired the view back and the byte stayed on disk.
//   * The continuation line after a SOFT break, after a HARD break (both the `\`
//     and the two-space spelling), a list item's text start and a blockquote
//     paragraph's text start all wrote the same dead byte, for both keys.
//
// This suite is the BYTE-level lock: every position × both keys × LF and CRLF,
// plus the refusals and the shapes that must keep their literal bytes. The live
// wiring (which keystroke reaches which path) is
// scripts/test-kernel-line-start-whitespace-ui.mjs.
import assert from 'node:assert/strict'
import {
  spellLineStartWhitespace,
  looksLikeBlockLineStart,
  healableLineStartRun
} from '../src/renderer/src/lib/source-kernel/commands/line-start-whitespace.js'
import { parseKernelMarkdown } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { buildCharacterMap } from '../src/renderer/src/lib/source-kernel/character-map.js'
import {
  createMarkdownDocument,
  applySourceTransaction
} from '../src/renderer/src/lib/source-kernel/markdown-document.js'

const NBSP = ' '
const NB2 = NBSP + NBSP

const doc = (text) => createMarkdownDocument(text)

// The mdast block that CONTAINS `offset` and whose type this command claims —
// the same thing the projection map hands the gateway as `pair.mdBlock`.
const blockAt = (text, offset, type = 'paragraph') => {
  let found = null
  const walk = (node) => {
    if (node?.type === type) {
      const start = node.position?.start?.offset
      const end = node.position?.end?.offset
      if (Number.isInteger(start) && start <= offset && offset <= end) {
        if (!found || start > found.position.start.offset) found = node
      }
    }
    for (const child of node?.children || []) walk(child)
  }
  walk(parseKernelMarkdown(text))
  return found
}

const apply = (text, routed) => {
  const result = applySourceTransaction(doc(text), routed.transaction)
  assert.ok(result.ok, `the transaction must apply: ${result.code}`)
  return result
}

// ===========================================================================
// 1) THE PREFILTER. Necessary condition, cheap, and it must NOT fire on
//    ordinary interior typing (which is what keeps the parse off the hot path).
// ===========================================================================
{
  assert.equal(looksLikeBlockLineStart('hello\n', 0), true, 'document start is a line start')
  assert.equal(looksLikeBlockLineStart('a\n\nhello\n', 3), true, 'a line start after a blank line')
  assert.equal(looksLikeBlockLineStart('a\r\n\r\nhello\r\n', 5), true, 'CRLF line start')
  assert.equal(looksLikeBlockLineStart('one\ntwo\n', 4), true, 'a continuation line start')
  assert.equal(looksLikeBlockLineStart('- item\n', 2), true, "a bullet item's text start")
  assert.equal(looksLikeBlockLineStart('1. item\n', 3), true, "an ordered item's text start")
  assert.equal(looksLikeBlockLineStart('- [ ] task\n', 6), true, "a task item's text start")
  assert.equal(looksLikeBlockLineStart('> quoted\n', 2), true, "a blockquote's text start")
  assert.equal(looksLikeBlockLineStart('  indented\n', 2), true, 'inside an indentation run')

  assert.equal(looksLikeBlockLineStart('hello\n', 3), false, 'mid-word is not a line start')
  assert.equal(looksLikeBlockLineStart('hello\n', 5), false, "a block's end is not a line start")
  assert.equal(looksLikeBlockLineStart('hello world\n', 6), false, 'after an interior space')
  assert.equal(looksLikeBlockLineStart('a - b\n', 4), false, 'a dash inside prose is not a marker')
  assert.equal(looksLikeBlockLineStart('hello\n', -1), false, 'out of range')
  assert.equal(looksLikeBlockLineStart(null, 0), false, 'non-string text')
}

// ===========================================================================
// 2) EVERY POSITION × BOTH KEYS × BOTH LINE ENDINGS.
//    Space -> ONE U+00A0, Tab -> TWO, raw characters and never an entity, and
//    the resulting bytes must reparse with the run as real, addressable content.
// ===========================================================================
const positions = [
  {
    label: 'top-level paragraph, first content position',
    lines: ['hello', ''],
    offsetIn: (text) => text.indexOf('hello')
  },
  {
    label: 'paragraph after another block',
    lines: ['first', '', 'hello', ''],
    offsetIn: (text) => text.indexOf('hello')
  },
  {
    label: 'continuation line after a SOFT break',
    lines: ['one', 'hello', ''],
    offsetIn: (text) => text.indexOf('hello')
  },
  {
    label: 'continuation line after a HARD break (backslash)',
    lines: ['one\\', 'hello', ''],
    offsetIn: (text) => text.indexOf('hello')
  },
  {
    label: 'continuation line after a HARD break (two spaces)',
    lines: ['one  ', 'hello', ''],
    offsetIn: (text) => text.indexOf('hello')
  },
  {
    label: "bullet list item's text start",
    lines: ['- hello', ''],
    offsetIn: (text) => text.indexOf('hello')
  },
  {
    label: "ordered list item's text start",
    lines: ['1. hello', ''],
    offsetIn: (text) => text.indexOf('hello')
  },
  {
    label: "blockquote paragraph's text start",
    lines: ['> hello', ''],
    offsetIn: (text) => text.indexOf('hello')
  }
]

for (const { label, lines, offsetIn } of positions) {
  for (const ending of ['\n', '\r\n']) {
    const endingName = ending === '\n' ? 'LF' : 'CRLF'
    const text = lines.join(ending)
    const offset = offsetIn(text)
    const block = blockAt(text, offset)
    assert.ok(block, `${label} / ${endingName}: no paragraph block resolved`)

    for (const [key, character, written] of [['Space', ' ', NBSP], ['Tab', '\t', NB2]]) {
      const routed = spellLineStartWhitespace({ doc: doc(text), block, offset, insert: character })
      assert.ok(routed.ok, `${label} / ${endingName} / ${key}: refused (${routed.code})`)
      assert.equal(routed.spelling, 'no-break-space',
        `${label} / ${endingName} / ${key}: must re-spell, not write the literal`)
      assert.equal(routed.transaction.insert, written,
        `${label} / ${endingName} / ${key}: ${key === 'Space' ? 'one' : 'two'} raw U+00A0`)
      assert.ok(!/&[#a-zA-Z0-9]+;/.test(routed.transaction.insert),
        `${label} / ${endingName} / ${key}: never a character reference`)

      // The bytes must apply and the run must survive the reparse AS CONTENT.
      const result = apply(text, routed)
      assert.equal(result.doc.text, text.slice(0, offset) + written + text.slice(offset),
        `${label} / ${endingName} / ${key}: the bytes must be the raw run at the offset`)
      const after = blockAt(result.doc.text, offset)
      assert.ok(after, `${label} / ${endingName} / ${key}: the block must still be a paragraph`)
      const map = buildCharacterMap(result.doc.text, after)
      assert.ok(map, `${label} / ${endingName} / ${key}: the block must still map`)
      for (let index = 0; index < written.length; index += 1) {
        const unit = map.units.find((entry) => entry.rawStart === offset + index)
        assert.ok(unit && unit.kind === 'char' && unit.width === 1 && unit.rawEnd === offset + index + 1,
          `${label} / ${endingName} / ${key}: every written character must be one addressable unit`)
      }
      // The ledger entry records WHICH key it stands for, in post-edit
      // coordinates, so a later heal restores what was pressed.
      assert.deepEqual(routed.whitespaceMarks,
        [{ from: offset, to: offset + written.length, ascii: character }],
        `${label} / ${endingName} / ${key}: the provenance ledger entry`)
      assert.deepEqual(result.doc.whitespaceMarks, routed.whitespaceMarks,
        `${label} / ${endingName} / ${key}: the ledger must survive the commit`)
    }
  }
}

// ===========================================================================
// 3) THE LITERAL IS TRIED FIRST, so nothing that already worked changes.
//    Every one of these must answer `not-structural` — "keep your bytes".
// ===========================================================================
{
  const interior = 'hello\n'
  assert.equal(
    spellLineStartWhitespace({
      doc: doc(interior), block: blockAt(interior, 3), offset: 3, insert: ' '
    }).code,
    'not-structural',
    'an interior space is content and must stay a literal byte'
  )
  assert.equal(
    spellLineStartWhitespace({
      doc: doc(interior), block: blockAt(interior, 3), offset: 3, insert: '\t'
    }).code,
    'not-structural',
    'an interior tab is content and must stay a literal byte'
  )
  // A GFM TASK ITEM's text start is the one line-start position in this family
  // where the literal byte is already CONTENT, measured on the kernel's own
  // parser: the checkbox consumes exactly ONE following space as syntax, so
  // '- [ ]  hello' and '- [ ] \thello' both decode to a paragraph that KEEPS the
  // extra character (' hello' / '\thello'). The literal-first attempt is what
  // discovers that, so this shape keeps its pre-existing bytes and this command
  // never touches it. (The regular bullet and ordered markers behave the other
  // way — their whole padding run is syntax — and are covered above.)
  for (const [key, character] of [['Space', ' '], ['Tab', '\t']]) {
    const task = '- [ ] hello\n'
    const at = task.indexOf('hello')
    assert.equal(
      spellLineStartWhitespace({
        doc: doc(task), block: blockAt(task, at), offset: at, insert: character
      }).code,
      'not-structural',
      `${key} at a task item's text start is already content and must stay literal`
    )
  }
  // A code block's leading whitespace IS content — the command's allowlist must
  // keep it out entirely (rewriting it would corrupt real source indentation).
  const fence = '```\nhello\n```\n'
  const code = blockAt(fence, 4, 'code')
  assert.equal(
    spellLineStartWhitespace({ doc: doc(fence), block: code, offset: 4, insert: '\t' }).code,
    'not-structural',
    "a fenced block's leading whitespace must never be re-spelled"
  )
  // No leading whitespace in the insert and no run to heal: nothing to do.
  assert.equal(
    spellLineStartWhitespace({
      doc: doc('hello\n'), block: blockAt('hello\n', 0), offset: 0, insert: 'x'
    }).code,
    'not-structural',
    'an ordinary character at a line start is not this command’s business'
  )
  // Line breaks are never claimed here.
  assert.equal(
    spellLineStartWhitespace({
      doc: doc('hello\n'), block: blockAt('hello\n', 0), offset: 0, insert: ' \n'
    }).code,
    'not-structural',
    'an insert carrying a line break is refused as not-structural'
  )
}

// ===========================================================================
// 4) A PASTE whose LEADING run would die. The re-spelling claims exactly the
//    insert's own opening whitespace run; everything after it is byte-exact.
// ===========================================================================
{
  const text = 'hello\n'
  const routed = spellLineStartWhitespace({
    doc: doc(text), block: blockAt(text, 0), offset: 0, insert: '  world '
  })
  assert.ok(routed.ok, `a paste at a line start must be spelled, not refused (${routed.code})`)
  assert.equal(routed.transaction.insert, NB2 + 'world ',
    'only the LEADING run is re-spelled; the rest is byte-exact')
  assert.deepEqual(routed.whitespaceMarks, [{ from: 0, to: 2, ascii: '  ' }],
    'the ledger records the ASCII the leading run stands for')
}

// ===========================================================================
// 5) THE DISPLACEMENT HEAL. A line-start run stays leading forever unless the
//    user types IN FRONT of it — and then it is an ordinary interior space and
//    must be restored to the key that was pressed.
// ===========================================================================
{
  // Space first, then a character typed in front of the U+00A0 it wrote.
  const base = 'hello\n'
  const first = apply(base, spellLineStartWhitespace({
    doc: doc(base), block: blockAt(base, 0), offset: 0, insert: ' '
  }))
  assert.equal(first.doc.text, NBSP + 'hello\n')
  const charMap = buildCharacterMap(first.doc.text, blockAt(first.doc.text, 0))
  const heal = healableLineStartRun(first.doc.text, charMap, first.doc.whitespaceMarks, 0)
  assert.deepEqual(heal, { rawStart: 0, rawEnd: 1, ascii: ' ' },
    'the ledger must vouch for the run this kernel wrote')
  const healed = spellLineStartWhitespace({
    doc: first.doc, block: blockAt(first.doc.text, 0), offset: 0, insert: 'x', heal
  })
  assert.ok(healed.ok, `the displacement heal must be proven (${healed.code})`)
  const after = apply(first.doc.text, { transaction: { ...healed.transaction, baseRevision: 0 } })
  assert.equal(after.doc.text, 'x hello\n',
    'a character typed in front of a line-start run restores the ASCII it stood for')
  assert.equal(healed.transaction.selection.anchor, 1,
    'the caret lands after the typed character, before the restored space')

  // A Tab's TWO U+00A0 restore a TAB, not two spaces — the ambiguity the ledger
  // exists to resolve.
  const tabbed = apply(base, spellLineStartWhitespace({
    doc: doc(base), block: blockAt(base, 0), offset: 0, insert: '\t'
  }))
  assert.equal(tabbed.doc.text, NB2 + 'hello\n')
  const tabMap = buildCharacterMap(tabbed.doc.text, blockAt(tabbed.doc.text, 0))
  const tabHeal = healableLineStartRun(tabbed.doc.text, tabMap, tabbed.doc.whitespaceMarks, 0)
  assert.deepEqual(tabHeal, { rawStart: 0, rawEnd: 2, ascii: '\t' })
  const tabRouted = spellLineStartWhitespace({
    doc: tabbed.doc, block: blockAt(tabbed.doc.text, 0), offset: 0, insert: 'x', heal: tabHeal
  })
  assert.ok(tabRouted.ok, `the tab heal must be proven (${tabRouted.code})`)
  assert.equal(
    apply(tabbed.doc.text, { transaction: { ...tabRouted.transaction, baseRevision: 0 } }).doc.text,
    'x\thello\n',
    'the whole recorded run restores the single Tab that was pressed'
  )

  // PROVENANCE IS THE GATE: a U+00A0 the DOCUMENT already had (a file authored
  // elsewhere that uses it for CJK spacing) is never claimed.
  const authored = NBSP + 'hello\n'
  const authoredMap = buildCharacterMap(authored, blockAt(authored, 0))
  assert.equal(healableLineStartRun(authored, authoredMap, [], 0), null,
    'a document with no ledger entry claims nothing')
  assert.equal(healableLineStartRun(authored, authoredMap, null, 0), null,
    'a missing ledger claims nothing')
  // …and with no heal, typing in front of it simply writes the literal.
  assert.equal(
    spellLineStartWhitespace({
      doc: doc(authored), block: blockAt(authored, 0), offset: 0, insert: 'x'
    }).code,
    'not-structural',
    'an unvouched U+00A0 is left exactly as the author wrote it'
  )

  // Whitespace typed IN FRONT of a recorded run is not a displacement: the run
  // is still leading, so both runs stay U+00A0 rather than one healing to ASCII.
  const stacked = spellLineStartWhitespace({
    doc: first.doc, block: blockAt(first.doc.text, 0), offset: 0, insert: ' ', heal
  })
  assert.ok(stacked.ok, `a second space at a line start must still be spelled (${stacked.code})`)
  assert.equal(stacked.transaction.insert, NBSP, 'it writes its own U+00A0 and heals nothing')
  assert.equal(stacked.transaction.to, stacked.transaction.from, 'a pure insert, no heal range')
}

// ===========================================================================
// 6) REFUSALS AND MALFORMED INPUT — no silent literal write is ever allowed.
// ===========================================================================
{
  const text = 'hello\n'
  const block = blockAt(text, 0)
  for (const [label, args] of [
    ['no document', { doc: null, block, offset: 0, insert: ' ' }],
    ['no revision', { doc: { text }, block, offset: 0, insert: ' ' }],
    ['offset out of range', { doc: doc(text), block, offset: 999, insert: ' ' }],
    ['empty insert', { doc: doc(text), block, offset: 0, insert: '' }],
    ['no block', { doc: doc(text), block: null, offset: 0, insert: ' ' }],
    ['offset outside the block', { doc: doc('a\n\nhello\n'), block: blockAt('a\n\nhello\n', 0), offset: 3, insert: ' ' }]
  ]) {
    const routed = spellLineStartWhitespace(args)
    assert.equal(routed.ok, false, `${label}: must not succeed`)
    assert.equal(routed.code, 'not-structural', `${label}: must fall through, never claim`)
  }
}

console.log('PASS source-kernel line-start whitespace: Space -> one U+00A0, Tab -> two, at a paragraph / continuation / list-item / blockquote line start, LF and CRLF, with the displacement heal and the literal-first fall-through')
