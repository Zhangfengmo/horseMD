// TDD evidence + regression lock for lib/source-kernel/commands/empty-code-insert.js.
//
// THE DEFECT (2026-08-18, pre-existing, reproduced in the built app before the
// fix — see .superpowers/sdd/2026-08-17-source-kernel-default-on/empty-fence-report.md).
// `code-map.js`'s `emptyCodeMap` gives a zero-content fence ONE addressable raw
// offset — `openLine.end + openLine.ending.length`, "where a first content line
// would begin" — which for the ordinary spelling
//
//     ```js
//     ```
//
// is the CLOSING FENCE's own line start. `commitPlainText` wrote the typed
// character there verbatim, committing '```js\nx```': the terminator destroyed
// and, measured on the kernel's own parser, every following block swallowed into
// the code block's value. The blockquote-prefixed shape failed a second way on
// top of that — the anchor sits BEFORE the closing line's '> ', so the character
// landed in front of the quote marker.
//
// Every fixture below is derived from the real parser (`parseKernelMarkdown`)
// and the real map (`buildCodeMap`), never hand-written offsets.
import assert from 'node:assert/strict'
import { parseKernelMarkdown } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { buildCodeMap } from '../src/renderer/src/lib/source-kernel/code-map.js'
import { createMarkdownDocument, applySourceTransaction, spellEmptyCodeInsert } from '../src/renderer/src/lib/source-kernel/index.js'

console.log('--- source kernel: empty fenced code block, first insert ---')

// Find the (only) mdast `code` node in a document and build its character map,
// exactly the pair `editor-kernel-projection-map.js` hands the gateway.
const codeFixture = (md) => {
  let node = null
  const walk = (candidate) => {
    if (node) return
    if (candidate?.type === 'code') { node = candidate; return }
    for (const child of candidate?.children || []) walk(child)
  }
  walk(parseKernelMarkdown(md))
  assert.ok(node, `fixture has no code node: ${JSON.stringify(md)}`)
  const charMap = buildCodeMap(md, node)
  return { doc: createMarkdownDocument(md), block: node, charMap }
}

// Run the command and apply its edit through the real kernel, so every
// expectation below is a statement about BYTES ON DISK, not about a plan.
const commit = (md, insert) => {
  const { doc, block, charMap } = codeFixture(md)
  assert.ok(charMap, `fixture's empty fence must map: ${JSON.stringify(md)}`)
  assert.equal(charMap.visibleLength, 0, 'fixture sanity: the fence must be EMPTY')
  const offset = charMap.visibleToRaw(0)
  const routed = spellEmptyCodeInsert({ doc, block, charMap, offset, insert })
  if (!routed.ok) return { ok: false, code: routed.code, text: doc.text }
  const applied = applySourceTransaction(doc, {
    baseRevision: doc.revision,
    edits: [routed.edit],
    intent: 'insert-text'
  })
  assert.equal(applied.ok, true, 'the command\'s own edit must apply cleanly')
  return { ok: true, text: applied.doc.text, opened: routed.opened, caret: routed.transaction.selection.anchor }
}

// The character really is observable afterwards: reparsing the committed bytes
// must hand back a `code` node whose value is exactly what was typed. This is
// the assertion the pre-fix behaviour could never have passed.
const reparsedValue = (md) => {
  let node = null
  const walk = (candidate) => {
    if (node) return
    if (candidate?.type === 'code') { node = candidate; return }
    for (const child of candidate?.children || []) walk(child)
  }
  walk(parseKernelMarkdown(md))
  return node?.value ?? null
}

// ---------------------------------------------------------------------------
// COVERED SHAPES — bytes pinned exactly.
// ---------------------------------------------------------------------------

// Case 1: THE DEFECT ITSELF. A bare, terminated empty fence with a language,
// with a following block that the pre-fix bytes swallowed whole.
{
  const md = '```js\n```\n\n尾段落。\n'
  const out = commit(md, 'x')
  assert.equal(out.ok, true, out.code)
  assert.equal(out.text, '```js\nx\n```\n\n尾段落。\n')
  assert.equal(out.opened, true, 'the closing-fence anchor must OPEN a new content line')
  assert.equal(reparsedValue(out.text), 'x')

  // The pre-fix bytes, asserted as the corruption they are — so this file
  // records WHY the fix exists, not only what it does.
  assert.equal(reparsedValue('```js\nx```\n\n尾段落。\n'), 'x```\n\n尾段落。',
    'the pre-fix spelling really did swallow the rest of the document')
}

// Case 2: no language (the info string is absent, not empty-string-vs-null).
{
  const out = commit('```\n```\n', 'x')
  assert.equal(out.ok, true, out.code)
  assert.equal(out.text, '```\nx\n```\n')
  assert.equal(reparsedValue(out.text), 'x')
}

// Case 3: the fence is the document's LAST block, with no trailing content.
{
  const out = commit('```js\n```\n', 'x')
  assert.equal(out.ok, true, out.code)
  assert.equal(out.text, '```js\nx\n```\n')
}

// Case 4: a `~~~` fence — the marker is not part of the derivation, so this
// must behave identically to the backtick form.
{
  assert.equal(commit('~~~js\n~~~\n', 'x').text, '~~~js\nx\n~~~\n')
  assert.equal(commit('~~~\n~~~\n', 'x').text, '~~~\nx\n~~~\n')
  // A longer fence run is likewise irrelevant to the anchor.
  assert.equal(commit('````js\n````\n', 'x').text, '````js\nx\n````\n')
}

// Case 5: CRLF. The opened line must be terminated with the block's OWN ending,
// never a bare '\n' — this repo has a whole bug family from exactly that.
{
  const out = commit('```js\r\n```\r\n', 'x')
  assert.equal(out.ok, true, out.code)
  assert.equal(out.text, '```js\r\nx\r\n```\r\n')
  assert.equal(/\r(?!\n)/.test(out.text), false, 'no lone \\r may be injected')
  assert.equal(/(?<!\r)\n/.test(out.text), false, 'no bare \\n may be injected into a CRLF document')
}

// Case 6: BLOCKQUOTE-prefixed fence — the shape whose pre-fix bytes put the
// character in FRONT of the closing line's own '> '. The opened line must carry
// the prefix.
{
  const out = commit('> ```js\n> ```\n\n后文\n', 'x')
  assert.equal(out.ok, true, out.code)
  assert.equal(out.text, '> ```js\n> x\n> ```\n\n后文\n')
  assert.equal(reparsedValue(out.text), 'x')

  assert.equal(commit('> > ```js\n> > ```\n', 'x').text, '> > ```js\n> > x\n> > ```\n',
    'a doubly quoted fence reproduces its whole prefix')
}

// Case 7: an INDENTED fence — including the realistic "fenced block inside a
// list item" shape, whose continuation prefix is the indentation (NOT the list
// marker; see Case 12 for the shape where those differ).
{
  assert.equal(commit('  ```js\n  ```\n', 'x').text, '  ```js\n  x\n  ```\n')
  assert.equal(commit('   ```js\n   ```\n', 'x').text, '   ```js\n   x\n   ```\n')
  const inList = commit('- text\n\n  ```js\n  ```\n', 'x')
  assert.equal(inList.ok, true, inList.code)
  assert.equal(inList.text, '- text\n\n  ```js\n  x\n  ```\n')
  assert.equal(reparsedValue(inList.text), 'x')
}

// Case 8: THE SECOND SPELLING. `commands/block-insert.js` writes the slash
// menu's `/code` with one EMPTY CONTENT LINE ('```js\n\n```'), which is still
// `value === ''` at the SAME anchor — but that line already belongs to the
// block, so terminating it again would decode as 'x' plus a newline the user
// never typed. The command must FILL it instead of opening another.
{
  const out = commit('```js\n\n```\n', 'x')
  assert.equal(out.ok, true, out.code)
  assert.equal(out.text, '```js\nx\n```\n')
  assert.equal(out.opened, false, 'an existing empty content line must be FILLED, not doubled')
  assert.equal(reparsedValue(out.text), 'x', 'the value must be exactly the typed character, with no trailing newline')

  const crlf = commit('```js\r\n\r\n```\r\n', 'x')
  assert.equal(crlf.ok, true, crlf.code)
  assert.equal(crlf.text, '```js\r\nx\r\n```\r\n')
}

// Case 9: a MULTI-LINE insert (a paste). Every interior break re-opens the
// per-line prefix, and the whole run is still terminated once.
{
  assert.equal(commit('```js\n```\n', 'a\nb').text, '```js\na\nb\n```\n')
  const quoted = commit('> ```js\n> ```\n', 'a\nb')
  assert.equal(quoted.text, '> ```js\n> a\n> b\n> ```\n')
  assert.equal(reparsedValue(quoted.text), 'a\nb',
    "the quoted lines' '> ' bytes must be SYNTAX, never content")
  assert.equal(commit('```js\r\n```\r\n', 'a\r\nb').text, '```js\r\na\r\nb\r\n```\r\n')
}

// Case 10: the caret lands right after the inserted text, on the line just
// opened — past the prefix, never in front of it.
{
  const { doc, block, charMap } = codeFixture('> ```js\n> ```\n')
  const offset = charMap.visibleToRaw(0)
  const routed = spellEmptyCodeInsert({ doc, block, charMap, offset, insert: 'x' })
  assert.equal(routed.ok, true)
  // '> ```js\n' is 8 bytes; the opened line is '> x\n', so the caret sits at 11
  // — after the 'x', before the terminator.
  assert.equal(routed.transaction.selection.anchor, 11)
  assert.equal(routed.transaction.selection.head, 11)
  const applied = applySourceTransaction(doc, {
    baseRevision: doc.revision, edits: [routed.edit], intent: 'insert-text'
  })
  assert.equal(applied.doc.text.slice(0, 11), '> ```js\n> x')
}

// ---------------------------------------------------------------------------
// REFUSED SHAPES — nothing proven, so nothing written. Each one is a byte the
// pre-fix code would have written WRONG.
// ---------------------------------------------------------------------------

const refuse = (md, insert, why) => {
  const out = commit(md, insert)
  assert.equal(out.ok, false, `${why}: must fail closed`)
  assert.equal(out.code, 'unsupported-structure', why)
  assert.equal(out.text, md, `${why}: bytes must be untouched`)
}

// Case 11: a fence with NO TERMINATOR at all, i.e. the document's last line is
// '```js' with no line ending. The empty map's anchor is then the OPEN line's
// own end, so the pre-fix write produced '```jsx' — the character absorbed into
// the LANGUAGE. Spellable in principle (write the missing ending first), but
// only by GUESSING which ending a terminator-less document uses; refused
// instead, deliberately.
{
  refuse('```js', 'x', 'a fence with no terminator at EOF')
  refuse('> ```js', 'x', 'a quoted fence with no terminator at EOF')
}

// Case 12: a fence opened by a LIST MARKER. `emptyCodeMap` derives the prefix
// from the OPEN line, which here is '- ' — but the continuation prefix is '  ',
// so writing '- x' would create a SECOND LIST ITEM. (The non-empty version of
// this same block is already refused one level up: its content line does not
// reproduce '- ', so `buildCodeMap` returns null.) The reparse proof is what
// catches it, and it is the reason this command reparses at all.
{
  refuse('- ```js\n  ```\n', 'x', 'a list-marker-opened empty fence')
  refuse('> - ```js\n>   ```\n', 'x', 'a quoted list-marker-opened empty fence')
}

// Case 13: a break spelled differently from the block's own ending — a bare
// '\n' pasted into a CRLF fence. Re-spelling it would inject a mixed ending;
// refused here for the same reason editor-kernel-gateway.js refuses it for a
// NON-empty block.
{
  refuse('```js\r\n```\r\n', 'a\nb', "a bare '\\n' break inside a CRLF fence")
  refuse('```js\n```\n', 'a\r\nb', "a '\\r\\n' break inside an LF fence")
}

// Case 14: input guards — the command claims nothing outside its own shape and
// says so with `not-structural`, so a caller's prefilter bug can never be read
// as "proven".
{
  const { doc, block, charMap } = codeFixture('```js\n```\n')
  const at = charMap.visibleToRaw(0)
  const notStructural = (args, why) => {
    const routed = spellEmptyCodeInsert({ doc, block, charMap, offset: at, ...args })
    assert.equal(routed.ok, false, why)
    assert.equal(routed.code, 'not-structural', why)
  }
  notStructural({ insert: '' }, 'an empty insert is not this shape')
  notStructural({ insert: 'x', offset: -1 }, 'an out-of-range offset is not this shape')
  notStructural({ insert: 'x', offset: doc.text.length + 1 }, 'an offset past the text is not this shape')

  // A NON-empty code block never reaches this command (the ordinary byte-exact
  // path owns it); asserted so a future prefilter change cannot route it here
  // and silently get an extra line ending.
  const nonEmpty = codeFixture('```js\nab\n```\n')
  assert.equal(nonEmpty.charMap.visibleLength, 2, 'fixture sanity')
  const routed = spellEmptyCodeInsert({
    doc: nonEmpty.doc, block: nonEmpty.block, charMap: nonEmpty.charMap, offset: 6, insert: 'x'
  })
  assert.equal(routed.ok, false)
  assert.equal(routed.code, 'not-structural')

  // A non-`code` block likewise.
  const paragraph = parseKernelMarkdown('甲\n').children[0]
  const asParagraph = spellEmptyCodeInsert({
    doc: createMarkdownDocument('甲\n'), block: paragraph, charMap, offset: 0, insert: 'x'
  })
  assert.equal(asParagraph.ok, false)
  assert.equal(asParagraph.code, 'not-structural')
}

console.log('PASS source kernel empty fenced code block: the first insert opens a terminated, prefixed content line (or fills an existing empty one), byte-exact for LF/CRLF, bare/quoted/indented/tilde/long fences and multi-line pastes; the list-marker fence, the terminator-less fence and every mis-spelled break fail closed with bytes untouched')
