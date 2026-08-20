// TDD evidence + regression lock for `spellMarkerFollowingText`
// (lib/source-kernel/commands/marker-space.js — the second half of the
// bare-marker rule).
//
// THE RULE'S OTHER HALF. `spellMarkerCompletingSpace` states: whitespace that
// completes a marker is SYNTAX, not content. This command states the symmetric
// resolution of the SAME intermediate state: ORDINARY TEXT typed right after a
// bare marker means the marker was never syntax at all — it is CONTENT the
// parser only mistook for structure while it stood alone. `*` then `a` must
// yield the literal paragraph `*a`, exactly as it does in every byte-first
// editor (and exactly what the bytes already say: `*a` reparses as a
// paragraph).
//
// Measured in the built app before the fix (2026-08-21, real keydowns): typing
// `*` on a blank line converted the block to an EMPTY bullet item, threw the
// caret into the trailing placeholder, and the continuation text landed as a
// SEPARATE paragraph at the document end — `甲一\n\n*\n\na` from typing `*a`,
// with a map-refresh-failed + projection-mismatch diagnostic pair and no toast.
//
// Every accepted case is BYTES IN -> BYTES OUT with a reparse-proven shape:
// either the marker DEMOTES to literal text (a text node spelling exactly
// `marker + typed` starts at the marker's own offset), or the command refuses
// and the caller keeps its existing behavior. `>` is deliberately refused here:
// a bare `>` pairs editable through the empty-quote virtual anchor already —
// claiming it would give one byte two owners.
import assert from 'node:assert/strict'
import { spellMarkerFollowingText } from '../src/renderer/src/lib/source-kernel/commands/marker-space.js'
import { parseKernelMarkdown } from '../src/renderer/src/lib/source-kernel/syntax-index.js'

console.log('--- source kernel marker-following text ---')

const doc = (text) => ({ text, revision: 7 })
const at = (text, needle) => {
  const index = text.indexOf(needle)
  assert.notEqual(index, -1, `fixture must contain ${JSON.stringify(needle)}`)
  return index + needle.length
}

// ---------------------------------------------------------------------------
// ACCEPTED — the typed text is written literally at the caret and the bare
// marker demotes to content. One row per marker family and position shape.
// ---------------------------------------------------------------------------
const ACCEPTED = [
  // THE REPORTED GESTURE: `*` on a blank line, then a letter.
  ['star + ascii', '甲\n\n*', '*', 'a', '甲\n\n*a'],
  ['star + cjk', '甲\n\n*', '*', '试', '甲\n\n*试'],
  ['dash', '甲\n\n-', '-', 'a', '甲\n\n-a'],
  ['plus', '甲\n\n+', '+', 'a', '甲\n\n+a'],
  ['ordered dot', '甲\n\n1.', '1.', 'a', '甲\n\n1.a'],
  ['ordered paren', '甲\n\n1)', '1)', 'a', '甲\n\n1)a'],
  // HEADINGS: `#a` (no space) is a paragraph per CommonMark — same demotion.
  ['h1', '甲\n\n#', '#', 'a', '甲\n\n#a'],
  ['h2', '甲\n\n##', '##', 'a', '甲\n\n##a'],
  ['h6', '甲\n\n######', '######', 'a', '甲\n\n######a'],
  // THE SEVENTH `#`: run growth refuses depth 7, so the character falls
  // through to this command — seven hashes are literal text.
  ['seventh hash', '甲\n\n######', '######', '#', '甲\n\n#######'],
  // A DOCUMENT WITH A TRAILING NEWLINE — the byte shape the app repro used
  // (the marker line is followed by the file's own final terminator).
  ['trailing newline', '甲\n\n*\n', '*', 'a', '甲\n\n*a\n'],
  // MID-DOCUMENT blank line: blocks continue after the demoted paragraph.
  ['mid-document', '甲\n\n*\n\n乙', '*', 'a', '甲\n\n*a\n\n乙'],
  // AN EMPTY ITEM MERGED INTO AN EXISTING LIST (`-` typed directly above
  // `- x` joins that list): the demotion splits it back out into a literal
  // paragraph followed by the untouched list.
  ['empty item of a merged list', '-\n- x', '-', 'a', '-a\n- x'],
  // CRLF document — same rows, every line ending '\r\n'.
  ['CRLF star', '甲\r\n\r\n*', '*', 'a', '甲\r\n\r\n*a'],
  ['CRLF trailing newline', '甲\r\n\r\n*\r\n', '*', 'a', '甲\r\n\r\n*a\r\n']
]

for (const [label, text, needle, typed, expected] of ACCEPTED) {
  const offset = at(text, needle)
  const routed = spellMarkerFollowingText({ doc: doc(text), offset, text: typed })
  assert.ok(routed.ok, `${label}: must demote the marker, got ${routed.code}`)
  assert.deepEqual(routed.edit, { from: offset, to: offset, insert: typed },
    `${label}: writes exactly the typed text, at the caret`)
  const written = text.slice(0, offset) + routed.edit.insert + text.slice(offset)
  assert.equal(written, expected, `${label}: byte-exact result`)
  assert.equal(routed.transaction.baseRevision, 7, `${label}: carries the base revision`)
  assert.deepEqual(routed.transaction.selection,
    { anchor: offset + typed.length, head: offset + typed.length },
    `${label}: the caret lands after the typed text`)
  assert.equal(routed.transaction.intent, 'marker-following-text')

  // The DEMOTION really happened: in the result, a text node spelling exactly
  // `marker + typed` starts at the marker's own offset — checked against the
  // kernel's own parser, independently of the command.
  const markerStart = offset - needle.length
  const marker = text.slice(markerStart, offset)
  const tree = parseKernelMarkdown(written)
  let demoted = null
  const walk = (node) => {
    if (node.type === 'text' && node.position?.start?.offset === markerStart) demoted = node
    for (const child of node.children || []) walk(child)
  }
  walk(tree)
  assert.ok(demoted, `${label}: a literal text node must start at the marker`)
  assert.ok(String(demoted.value).startsWith(marker + typed),
    `${label}: the text spells marker + typed, got ${JSON.stringify(demoted.value)}`)
}

// ---------------------------------------------------------------------------
// REFUSED — every refusal answers `not-structural`, so the caller keeps its
// existing behavior (the ordinary character path, or its own refusal).
// ---------------------------------------------------------------------------
const REFUSED = [
  // Whitespace belongs to the marker-completion / re-speller family, never here.
  ['space', '甲\n\n*', '*', ' '],
  ['tab', '甲\n\n*', '*', '\t'],
  ['newline', '甲\n\n*', '*', '\n'],
  ['nbsp', '甲\n\n*', '*', '\u00a0'],
  // A bare `>` pairs editable through the empty-quote virtual anchor — that
  // path owns typing there.
  ['blockquote', '甲\n\n>', '>', 'a'],
  // The block is NOT an empty structure: `*a` is already a paragraph, ordinary
  // typing owns it.
  ['already text', '甲\n\n*a', '*a', 'b'],
  // A completed marker (`- `) is an editable empty item — the virtual-anchor
  // path owns typing there.
  ['completed marker', '甲\n\n- ', '- ', 'a'],
  // A bare task checkbox has literal `[ ]` content (checked: null) — not empty,
  // not this command's shape.
  ['bare checkbox', '- [ ]', '- [ ]', 'a'],
  // Caret midway through the marker run: the structure the line spells does not
  // end at the caret.
  ['mid-run caret', '甲\n\n##', '#', 'a'],
  // Inside a fence the marker is verbatim content.
  ['inside a fence', '```\n*\n```', '```\n*', 'a'],
  // Empty / invalid inputs.
  ['empty text', '甲\n\n*', '*', ''],
  ['multi-line text', '甲\n\n*', '*', 'a\nb']
]

for (const [label, text, needle, typed] of REFUSED) {
  const offset = at(text, needle)
  const routed = spellMarkerFollowingText({ doc: doc(text), offset, text: typed })
  assert.ok(!routed.ok, `${label}: must refuse`)
  assert.equal(routed.code, 'not-structural', `${label}: refusal is the quiet kind`)
}

// A refusal must never be reached by throwing: hostile inputs answer, not crash.
for (const args of [
  {},
  { doc: null, offset: 0, text: 'a' },
  { doc: { text: '*', revision: 1 }, offset: 99, text: 'a' },
  { doc: { text: '*', revision: 1 }, offset: -1, text: 'a' },
  { doc: { text: '*', revision: 1 }, offset: 1, text: null }
]) {
  const routed = spellMarkerFollowingText(args)
  assert.equal(routed.ok, false)
}

console.log('PASS marker-following text: bare markers demote to literal content under ordinary typing, whitespace/quote/non-empty shapes refuse')
