// TDD evidence + regression lock for
// lib/source-kernel/commands/trailing-placeholder.js.
//
// User report, with a screenshot: the caret sits in the empty paragraph at the
// very END of the document (the one showing the 「输入 / 唤起命令，或开始写…」
// placeholder), immediately after an ordered list, and Backspace raises
// 「源码权威内核实验阶段暂未支持此操作 (unsupported-input-type)」.
//
// The load-bearing finding is about which block that is, and it is asserted
// here rather than assumed: a trailing blank line produces NO BLOCK AT ALL in
// CommonMark, so the trailing empty paragraph can only ever be
// plugin-trailing's synthetic node or a controller-vouched split placeholder —
// never a real one. Backspace there therefore has nothing to delete, and the
// answer is a view-only caret move (asserted in the controller/UI suites).
//
// What THIS command owns is the one case where real bytes exist: Enter at the
// document end writes a blank line, and the Backspace that takes it back should
// take the bytes back too. Only the SURPLUS line endings go; a file ending in
// exactly one newline is the conventional state and is left alone.
import assert from 'node:assert/strict'
import { trimTrailingBlankLines } from '../src/renderer/src/lib/source-kernel/commands/trailing-placeholder.js'
import { buildSyntaxIndex, parseKernelMarkdown } from '../src/renderer/src/lib/source-kernel/syntax-index.js'

console.log('--- source kernel trailing placeholder ---')

const doc = (text) => ({ text, revision: 7 })

// ---------------------------------------------------------------------------
// THE PREMISE, proven rather than stated: trailing blank lines produce no block.
// If this ever stops holding, the whole "there is nothing to delete" argument
// behind the caret-move behaviour collapses, and this file should be the first
// thing that fails.
// ---------------------------------------------------------------------------
for (const [bare, padded] of [
  ['a\n\n1. 甲\n2. 乙', 'a\n\n1. 甲\n2. 乙\n\n'],
  ['a\n\n- 甲', 'a\n\n- 甲\n\n\n'],
  ['前言\n\n末段', '前言\n\n末段\n\n'],
  ['a\r\n\r\n1. 甲', 'a\r\n\r\n1. 甲\r\n\r\n']
]) {
  const count = (text) => (parseKernelMarkdown(text).children || []).length
  assert.equal(count(bare), count(padded),
    `trailing blank lines must add no block: ${JSON.stringify(padded)}`)
}

// ---------------------------------------------------------------------------
// TRIMMED — the round trip. `contentEnd` is the end of the document's last real
// block, which the caller reads off the projection map's last paired mdast
// block, so it is derived here the same way rather than hand-counted.
// ---------------------------------------------------------------------------
const lastBlockEnd = (text) => {
  const index = buildSyntaxIndex(text)
  let end = null
  const walk = (node) => {
    const at = node.position?.end?.offset
    if (node.type !== 'root' && Number.isInteger(at) && (end === null || at > end)) end = at
    for (const child of node.children || []) walk(child)
  }
  walk(index.tree)
  return end
}

for (const [label, text, expected] of [
  ['one blank line after a list', 'a\n\n1. 甲\n2. 乙\n\n', 'a\n\n1. 甲\n2. 乙\n'],
  ['several blank lines', 'a\n\n1. 甲\n\n\n\n', 'a\n\n1. 甲\n'],
  ['after a paragraph', '前言\n\n末段\n\n', '前言\n\n末段\n'],
  ['CRLF keeps its own ending', 'a\r\n\r\n1. 甲\r\n\r\n', 'a\r\n\r\n1. 甲\r\n'],
  ['CRLF, several blanks', 'a\r\n\r\n1. 甲\r\n\r\n\r\n', 'a\r\n\r\n1. 甲\r\n'],
  // The loose/tight boundary the trailing blank line is suspected of touching:
  // the blank line BETWEEN the items is content-bearing and must survive; only
  // the one past the end goes.
  ['loose list keeps its interior blank line', '- 甲\n\n- 乙\n\n', '- 甲\n\n- 乙\n'],
  ['nested list', '- 甲\n  - 乙\n\n', '- 甲\n  - 乙\n']
]) {
  const contentEnd = lastBlockEnd(text)
  const routed = trimTrailingBlankLines({ doc: doc(text), contentEnd })
  assert.ok(routed.ok, `${label}: must trim, got ${routed.code}`)
  const written = text.slice(0, routed.edit.from) + routed.edit.insert + text.slice(routed.edit.to)
  assert.equal(written, expected, `${label}: byte-exact`)
  assert.equal(routed.edit.insert, '', `${label}: a trim only ever deletes`)
  assert.equal(routed.transaction.intent, 'trim-trailing-blank-lines')
  assert.deepEqual(routed.transaction.selection, { anchor: contentEnd, head: contentEnd },
    `${label}: the caret lands at the end of the last real block`)
  assert.equal(routed.transaction.baseRevision, 7)
  // ...and the trim really did preserve every block, checked independently of
  // the command's own proof.
  const before = parseKernelMarkdown(text)
  const after = parseKernelMarkdown(written)
  assert.equal((before.children || []).length, (after.children || []).length,
    `${label}: the block count must be unchanged`)
  assert.deepEqual((before.children || []).map((n) => n.type), (after.children || []).map((n) => n.type),
    `${label}: and so must every block type`)
}

// ---------------------------------------------------------------------------
// REFUSED — `not-structural` means "nothing of mine here", and the caller then
// does the caret move alone. The first two rows are the important ones: they are
// the ORDINARY end-of-file states, and trimming either of them would dirty a
// document the user only moved the caret in.
// ---------------------------------------------------------------------------
for (const [label, text] of [
  ['a file ending in exactly one newline', 'a\n\n1. 甲\n'],
  ['a file ending in no newline at all', 'a\n\n1. 甲'],
  ['CRLF ending in exactly one newline', 'a\r\n\r\n1. 甲\r\n']
]) {
  const routed = trimTrailingBlankLines({ doc: doc(text), contentEnd: lastBlockEnd(text) })
  assert.equal(routed.ok, false, `${label}: must not touch the bytes`)
  assert.equal(routed.code, 'not-structural')
}

// A tail that is not pure line endings is not this command's business either —
// including the U+00A0 the whitespace family deliberately writes.
for (const [label, text, contentEnd] of [
  ['trailing spaces', 'a\n\n甲   ', 3],
  ['a no-break space', 'a\n\n甲 ', 3],
  ['real content after contentEnd', 'a\n\n甲乙', 3],
  ['contentEnd past the end', 'a\n', 99],
  ['contentEnd negative', 'a\n', -1]
]) {
  const routed = trimTrailingBlankLines({ doc: doc(text), contentEnd })
  assert.equal(routed.ok, false, `${label}: must refuse`)
}

// Degenerate inputs answer `not-structural` rather than throwing — this command
// sits on the Backspace path, where an exception would eat the keystroke.
for (const bad of [
  { doc: null, contentEnd: 0 },
  { doc: { text: 'a\n\n' }, contentEnd: 1 },
  { doc: doc('a\n\n'), contentEnd: 1.5 }
]) {
  assert.equal(trimTrailingBlankLines(bad).ok, false)
}

console.log('PASS source kernel trailing placeholder: trailing blank lines make no block; only the SURPLUS endings are trimmed, byte-exact for LF and CRLF, and the ordinary one-newline / no-newline endings are left alone')
