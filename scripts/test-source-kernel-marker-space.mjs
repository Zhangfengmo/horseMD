// TDD evidence + regression lock for lib/source-kernel/commands/marker-space.js.
//
// The rule: WHITESPACE THAT COMPLETES A MARKER IS SYNTAX, NOT CONTENT. Typing
// `- ` on a line is THE fundamental Markdown gesture and in kernel mode it did
// not work, for any marker family, in any of its three positions — measured in
// the built app and tabulated in the command's own header, together with the
// three separate ways the Space was being intercepted.
//
// Every case below is stated as BYTES IN -> BYTES OUT, because that is the whole
// contract: the command writes exactly one literal ASCII space, at exactly the
// caret's raw offset, and only when the reparse proves the marker took.
import assert from 'node:assert/strict'
import {
  spellMarkerCompletingSpace,
  spellMarkerRunGrowth
} from '../src/renderer/src/lib/source-kernel/commands/marker-space.js'
import { buildSyntaxIndex } from '../src/renderer/src/lib/source-kernel/syntax-index.js'

console.log('--- source kernel marker-completing space ---')

const doc = (text) => ({ text, revision: 3 })
const at = (text, needle) => {
  const index = text.indexOf(needle)
  assert.notEqual(index, -1, `fixture must contain ${JSON.stringify(needle)}`)
  return index + needle.length
}

// ---------------------------------------------------------------------------
// ACCEPTED — one row per (marker family x position). `offset` is written as
// "just after this substring" so a fixture edit can never leave a stale number.
// ---------------------------------------------------------------------------
const ACCEPTED = [
  // EMPTY BLOCK — the position where the first marker character has ALREADY
  // converted the block (the kernel is byte-first), so the input rule's own
  // precondition is gone and only these bytes can finish the job.
  ['empty bullet', '甲\n\n-', '-', '甲\n\n- ', '-'],
  ['empty star', '甲\n\n*', '*', '甲\n\n* ', '*'],
  ['empty plus', '甲\n\n+', '+', '甲\n\n+ ', '+'],
  ['empty ordered', '甲\n\n1.', '1.', '甲\n\n1. ', '1.'],
  ['empty ordered paren', '甲\n\n1)', '1)', '甲\n\n1) ', '1)'],
  ['empty quote', '甲\n\n>', '>', '甲\n\n> ', '>'],
  ['empty h1', '甲\n\n#', '#', '甲\n\n# ', '#'],
  ['empty h2', '甲\n\n##', '##', '甲\n\n## ', '##'],
  ['empty h6', '甲\n\n######', '######', '甲\n\n###### ', '######'],
  // NON-EMPTY BLOCK — the position where the preset input rule DOES fire and
  // the gateway vetoes its node transaction.
  ['paragraph bullet', '-甲一', '-', '- 甲一', '-'],
  ['paragraph ordered', '1.甲一', '1.', '1. 甲一', '1.'],
  ['paragraph quote', '>甲一', '>', '> 甲一', '>'],
  ['paragraph h1', '#甲一', '#', '# 甲一', '#'],
  ['paragraph h2', '##甲一', '##', '## 甲一', '##'],
  // INSIDE A LIST ITEM — the position the line-start re-speller was claiming,
  // turning the Space into U+00A0 and silently producing no nested list. This
  // is the row the user reported.
  ['nested bullet in item', '- -乙一', '- -', '- - 乙一', '-'],
  ['nested ordered in item', '- 1.乙一', '- 1.', '- 1. 乙一', '1.'],
  ['heading in item', '- #乙一', '- #', '- # 乙一', '#'],
  ['quote in item', '- >乙一', '- >', '- > 乙一', '>'],
  // GFM TASK — the space after the checkbox is the byte that makes it one.
  ['task unchecked', '- [ ]活', '- [ ]', '- [ ] 活', '[ ]'],
  ['task checked', '- [x]活', '- [x]', '- [x] 活', '[x]'],
  // CONTAINER PREFIXES — indentation and a quote marker in front of the typed
  // marker are ordinary line prefix, not a reason to refuse.
  ['indented bullet', '  -甲一', '  -', '  - 甲一', '-'],
  ['bullet inside a quote', '> -甲一', '> -', '> - 甲一', '-'],
  // The 2026-08-22 "引用内嵌套" report named headings and lists specifically —
  // one pin per family under a quote prefix, plus a two-deep chain.
  ['h1 inside a quote', '> #甲一', '> #', '> # 甲一', '#'],
  ['h3 inside a quote', '> ###甲一', '> ###', '> ### 甲一', '###'],
  ['ordered inside a quote', '> 1.甲一', '> 1.', '> 1. 甲一', '1.'],
  ['second bullet in a quote', '> - 甲\n> -乙', '\n> -', '> - 甲\n> - 乙', '-'],
  ['h2 inside a nested quote', '> > ##甲', '> > ##', '> > ## 甲', '##'],
  // A CONTINUATION LINE of a paragraph: the marker splits the paragraph, which
  // is exactly what Markdown means by it.
  ['second line of a paragraph', '甲一\n-乙一', '\n-', '甲一\n- 乙一', '-'],
  // CRLF — the same rows on a document whose every line ending is '\r\n'. The
  // command reads the line through the kernel's own line index, so the ending
  // must be irrelevant; asserted rather than assumed.
  ['CRLF empty bullet', '甲\r\n\r\n-', '-', '甲\r\n\r\n- ', '-'],
  ['CRLF paragraph bullet', '甲一\r\n-乙一', '\r\n-', '甲一\r\n- 乙一', '-'],
  ['CRLF nested in item', '- 甲\r\n- -乙', '- -', '- 甲\r\n- - 乙', '-']
]

for (const [label, text, needle, expected, marker] of ACCEPTED) {
  const offset = at(text, needle)
  const routed = spellMarkerCompletingSpace({ doc: doc(text), offset })
  assert.ok(routed.ok, `${label}: must complete the marker, got ${routed.code}`)
  assert.equal(routed.marker, marker, `${label}: names the marker it completed`)
  assert.deepEqual(routed.edit, { from: offset, to: offset, insert: ' ' },
    `${label}: writes exactly one literal space, at the caret`)
  const written = text.slice(0, offset) + routed.edit.insert + text.slice(offset)
  assert.equal(written, expected, `${label}: byte-exact result`)
  assert.equal(routed.transaction.baseRevision, 3, `${label}: carries the base revision`)
  assert.deepEqual(routed.transaction.selection, { anchor: offset + 1, head: offset + 1 },
    `${label}: the caret lands on the content side of the marker`)
  assert.equal(routed.transaction.intent, 'marker-completing-space')
}

// The written space must genuinely be SYNTAX in the result — invisible, not a
// leading content space. Checked independently of the command, by asking the
// kernel's own index where the block's content starts.
for (const [label, text, needle, expected] of ACCEPTED) {
  const offset = at(text, needle)
  const index = buildSyntaxIndex(expected)
  const block = index.blockAt(offset + 1)
  if (!block) continue // an EMPTY marker block has no content at all — nothing to check
  assert.ok(block.start >= offset || block.type === 'heading',
    `${label}: the space must not have landed inside the block's content`)
  const item = index.listItemAt(offset)
  if (item && item.marker && !item.task) {
    assert.notEqual(item.spacing, '',
      `${label}: the completed list marker must carry real spacing`)
  }
}

// ---------------------------------------------------------------------------
// REFUSED — `not-structural` means "not mine", and the caller then keeps
// EXACTLY its previous behaviour. Every existing whitespace guarantee lives on
// the other side of these rows, so each one is a promise that this command did
// not take something away.
// ---------------------------------------------------------------------------
const REFUSED = [
  // The marker is ALREADY complete: this Space is ordinary padding and belongs
  // to the line-start re-speller, untouched.
  ['already spaced bullet', '- 甲', '- '],
  ['already spaced heading', '# 甲', '# '],
  // A space already follows the caret — again padding, not completion.
  ['space follows', '-  甲', '-'],
  // Not at a line's structural start.
  ['mid text', '甲-乙', '甲-'],
  ['after a word', 'ab-', 'ab-'],
  // Verbatim blocks own their bytes.
  ['inside a fenced code block', '```js\n-x\n```', '\n-'],
  // Not a marker at all.
  ['plain text', '甲一', '甲'],
  ['seven hashes is not a heading', '#######甲', '#######'],
  ['ten digits is not an ordered marker', '1234567890.甲', '1234567890.'],
  // Four spaces of indentation is an indented code block, not a list.
  ['four-space indent', '    -甲一', '    -'],
  // A blank line's `- ` would be a setext underline for the item above, not a
  // nested list — the reparse says so and the command believes the reparse.
  ['continuation line under an item', '- 甲\n  -', '  -']
]

for (const [label, text, needle] of REFUSED) {
  const routed = spellMarkerCompletingSpace({ doc: doc(text), offset: at(text, needle) })
  assert.equal(routed.ok, false, `${label}: must not claim this Space`)
  assert.equal(routed.code, 'not-structural',
    `${label}: refusing means "not mine", never a loud error`)
}

// Degenerate inputs answer `not-structural` rather than throwing — this command
// sits on the Space keydown path, where an exception would eat the keystroke.
for (const bad of [
  { doc: null, offset: 0 },
  { doc: { text: 'a' }, offset: 0 },
  { doc: doc('a'), offset: -1 },
  { doc: doc('a'), offset: 99 },
  { doc: doc('a'), offset: 1.5 }
]) {
  assert.equal(spellMarkerCompletingSpace(bad).ok, false)
}

// ---------------------------------------------------------------------------
// ATX RUN GROWTH — the `##` half. `#` is the only marker character that is
// already a complete block on its own, so the SECOND `#` is the marker run
// growing, not ordinary text; without it `# ` worked and `## ` did not.
// ---------------------------------------------------------------------------
for (const [label, text, needle, expected] of [
  ['h1 -> h2', '甲\n\n#', '#', '甲\n\n##'],
  ['h2 -> h3', '甲\n\n##', '##', '甲\n\n###'],
  ['h5 -> h6', '甲\n\n#####', '#####', '甲\n\n######'],
  ['CRLF h1 -> h2', '甲\r\n\r\n#', '#', '甲\r\n\r\n##']
]) {
  const offset = at(text, needle)
  const routed = spellMarkerRunGrowth({ doc: doc(text), offset, character: '#' })
  assert.ok(routed.ok, `${label}: must grow the marker run, got ${routed.code}`)
  assert.deepEqual(routed.edit, { from: offset, to: offset, insert: '#' })
  assert.equal(text.slice(0, offset) + '#' + text.slice(offset), expected, `${label}: byte-exact`)
  assert.equal(routed.transaction.intent, 'marker-run-growth')
}

for (const [label, text, needle, character] of [
  ['h6 -> h7 is not a heading', '甲\n\n######', '######', '#'],
  ['a hash in ordinary text', '#甲一', '#', '#'],
  ['a hash that is not already a heading', '甲-', '甲-', '#'],
  ['an already-spaced heading', '# ', '# ', '#'],
  ['any other character', '甲\n\n#', '#', '-']
]) {
  const routed = spellMarkerRunGrowth({ doc: doc(text), offset: at(text, needle), character })
  assert.equal(routed.ok, false, `${label}: must refuse`)
  assert.equal(routed.code, 'not-structural')
}

console.log('PASS source kernel marker-completing space: every marker family completes at an empty block, at a paragraph start, inside a list item and under (nested) quote prefixes; LF and CRLF; padding, verbatim blocks and non-markers keep their previous behaviour')
