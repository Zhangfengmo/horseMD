// setBlockTypeFromQuery command tests (block-type conversion domain).
// Byte-authoritative: every expected string below is the ACTUAL result of
// running the command + applySourceTransaction, and every accepted result is
// additionally REPARSED so the committed bytes are proven to mean the block
// type they claim to (a byte assertion alone cannot tell `## ` from `##x`).
import assert from 'node:assert/strict'
import { createMarkdownDocument, applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { buildSyntaxIndex, parseKernelMarkdown } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { setBlockTypeFromQuery, demoteHeadingAtCaret, BLOCK_TYPE_MARKERS } from '../src/renderer/src/lib/source-kernel/commands/block-type.js'

console.log('--- source kernel block-type ---')

const ctx = (text) => ({ doc: createMarkdownDocument(text), index: buildSyntaxIndex(text) })
const run = (text, offset, target) => {
  const c = ctx(text)
  return { c, r: setBlockTypeFromQuery({ ...c, offset, target }) }
}
const apply = (doc, r) => {
  assert.equal(r.ok, true, r.code)
  return applySourceTransaction(doc, r.transaction).doc.text
}
// Structural signature of the reparsed result — the proof that the bytes MEAN
// the requested block type (a pre-order type walk, one level of children).
const shapeOf = (text) =>
  parseKernelMarkdown(text).children.map((node) => {
    if (node.type === 'heading') return `heading${node.depth}`
    if (node.type === 'list') return `list(${node.ordered ? 'ordered' : 'bullet'})x${node.children.length}`
    return node.type
  })

// ---------------------------------------------------------------------------
// 1. Paragraph -> every supported target. The query paragraph's WHOLE raw span
//    is replaced by the marker, in one edit, with the caret after the marker.
// ---------------------------------------------------------------------------
{
  const cases = [
    ['heading1', '# \n', ['heading1'], 2],
    ['heading2', '## \n', ['heading2'], 3],
    ['heading3', '### \n', ['heading3'], 4],
    ['heading4', '#### \n', ['heading4'], 5],
    ['heading5', '##### \n', ['heading5'], 6],
    ['heading6', '###### \n', ['heading6'], 7],
    ['bullet', '- \n', ['list(bullet)x1'], 2],
    ['ordered', '1. \n', ['list(ordered)x1'], 3]
  ]
  for (const [target, bytes, shape, anchor] of cases) {
    const { c, r } = run('/h2\n', 3, target)
    assert.equal(apply(c.doc, r), bytes, `${target}: bytes`)
    assert.deepEqual(shapeOf(bytes), shape, `${target}: reparsed shape`)
    assert.deepEqual(r.transaction.selection, { anchor, head: anchor }, `${target}: caret`)
    assert.equal(r.transaction.edits.length, 1, `${target}: exactly ONE edit (atomic)`)
    assert.deepEqual(r.transaction.edits[0], { from: 0, to: 3, insert: BLOCK_TYPE_MARKERS[target] })
  }
}

// ---------------------------------------------------------------------------
// 2. Typing the marker's own follow-up character yields the intended block —
//    this is what the trailing space in every marker exists for. Asserted on
//    the REPARSE, not by inspection.
// ---------------------------------------------------------------------------
{
  assert.deepEqual(shapeOf('## T\n'), ['heading2'])
  assert.deepEqual(shapeOf('##T\n'), ['paragraph'], 'a space-less marker would NOT be a heading')
  assert.deepEqual(shapeOf('- x\n'), ['list(bullet)x1'])
  assert.deepEqual(shapeOf('-x\n'), ['paragraph'], 'a space-less bullet would NOT be a list')
}

// ---------------------------------------------------------------------------
// 3. Heading -> heading (level change). The slash menu IS reachable inside a
//    heading (`shouldShow` accepts paragraph|heading), so "/h4" typed into an
//    existing H2 must rewrite the marker, not append one.
// ---------------------------------------------------------------------------
{
  const src = '## /h4\n'
  const { c, r } = run(src, 6, 'heading4')
  assert.equal(apply(c.doc, r), '#### \n')
  assert.deepEqual(shapeOf('#### \n'), ['heading4'])
  assert.deepEqual(r.transaction.selection, { anchor: 5, head: 5 })
}
{
  // Heading -> list, same span rule.
  const { c, r } = run('###### /ul\n', 10, 'bullet')
  assert.equal(apply(c.doc, r), '- \n')
}

// ---------------------------------------------------------------------------
// 4. Content bytes AROUND the block are preserved verbatim — the edit is
//    scoped to the query block's own raw span and nothing else.
// ---------------------------------------------------------------------------
{
  const src = '前面\n\n/h2\n\n后面\n'
  const { c, r } = run(src, src.indexOf('/h2') + 3, 'heading2')
  assert.equal(apply(c.doc, r), '前面\n\n## \n\n后面\n')
  assert.deepEqual(shapeOf('前面\n\n## \n\n后面\n'), ['paragraph', 'heading2', 'paragraph'])
}
{
  // Last block, NO trailing line ending at all.
  const { c, r } = run('甲\n\n/h1', 6, 'heading1')
  assert.equal(apply(c.doc, r), '甲\n\n# ')
  assert.deepEqual(shapeOf('甲\n\n# '), ['paragraph', 'heading1'])
}

// ---------------------------------------------------------------------------
// 5. CRLF. The edit never touches a line ending (it replaces bytes strictly
//    inside one line), so every CRLF ending in the document survives byte for
//    byte — asserted rather than assumed.
// ---------------------------------------------------------------------------
{
  const src = '前面\r\n\r\n/h2\r\n\r\n后面\r\n'
  const offset = src.indexOf('/h2') + 3
  const { c, r } = run(src, offset, 'heading2')
  const out = apply(c.doc, r)
  assert.equal(out, '前面\r\n\r\n## \r\n\r\n后面\r\n')
  assert.equal(out.includes('\n\n'.replace(/\n/g, '\n')) && /(?<!\r)\n/.test(out), false,
    'no lone LF was introduced')
  assert.deepEqual(shapeOf(out), ['paragraph', 'heading2', 'paragraph'])
}
{
  const src = '/ul\r\n'
  const { c, r } = run(src, 3, 'bullet')
  const out = apply(c.doc, r)
  assert.equal(out, '- \r\n')
  assert.deepEqual(shapeOf(out), ['list(bullet)x1'])
}
{
  // CRLF heading -> heading level change.
  const src = '## /h4\r\n'
  const { c, r } = run(src, 6, 'heading4')
  assert.equal(apply(c.doc, r), '#### \r\n')
}

// ---------------------------------------------------------------------------
// 6. REFUSALS. Every one of these must return `unsupported-structure` and
//    produce NO transaction — a shape this command cannot prove is refused,
//    never guessed.
// ---------------------------------------------------------------------------
const refuses = (label, text, offset, target) => {
  const { r } = run(text, offset, target)
  assert.equal(r.ok, false, label + ' must refuse')
  assert.equal(r.code, 'unsupported-structure', label + ' code')
  assert.equal(r.transaction, undefined, label + ' must not carry a transaction')
}

// Unknown / deliberately unsupported targets.
refuses('task target', '/task\n', 5, 'task')
refuses('divider target', '/hr\n', 3, 'divider')
refuses('paragraph target', '/text\n', 5, 'paragraph')
refuses('nonsense target', '/x\n', 2, 'nope')
refuses('missing target', '/x\n', 2, undefined)

// Nested contexts: NOT a root child, so `topLevelNodeAt` never finds it.
refuses('paragraph inside a blockquote', '> /h2\n', 5, 'heading2')
refuses('paragraph inside a list item', '- /h2\n', 5, 'heading2')
refuses('paragraph inside a nested quote', '> > /h2\n', 7, 'heading2')

// Block types whose span is not "marker + one line of content".
refuses('code block', '```\n/h2\n```\n', 8, 'heading2')
refuses('thematic break', '---\n', 3, 'heading2')
refuses('table', '| a |\n| - |\n| b |\n', 17, 'heading2')

// Setext heading: its raw span runs THROUGH the underline, so the caret at
// the end of the visible text is not the block's end.
refuses('setext heading', '/h2\n===\n', 3, 'heading2')

// Caret not at the block's own end (the `atEndOfBlock` contract restated on
// the raw side) — the mid-block case would replace content the user kept.
refuses('caret mid-block', '/h2 tail\n', 3, 'heading2')
refuses('caret at block start', '/h2\n', 0, 'heading2')
refuses('caret on a blank line', '甲\n\n\n', 3, 'heading2')

// ---------------------------------------------------------------------------
// 7. The command NEVER mutates its inputs — it returns a transaction, the
//    caller commits it.
// ---------------------------------------------------------------------------
{
  const c = ctx('/h2\n')
  const before = c.doc.text
  const revision = c.doc.revision
  setBlockTypeFromQuery({ ...c, offset: 3, target: 'heading2' })
  assert.equal(c.doc.text, before)
  assert.equal(c.doc.revision, revision)
}

// ---------------------------------------------------------------------------
// 8. baseRevision is the document's own — a stale transaction must be
//    refusable downstream (applySourceTransaction owns that check).
// ---------------------------------------------------------------------------
{
  const c = ctx('/h2\n')
  const first = setBlockTypeFromQuery({ ...c, offset: 3, target: 'heading2' })
  assert.equal(first.transaction.baseRevision, c.doc.revision)
  const applied = applySourceTransaction(c.doc, first.transaction).doc
  const replay = applySourceTransaction(applied, first.transaction)
  assert.equal(replay.ok, false, 'replaying a spent transaction must be refused')
  assert.equal(replay.code, 'stale-revision')
}

// ---------------------------------------------------------------------------
// 9. demoteHeadingAtCaret — the Backspace/Delete-at-heading-content-start
//    gesture (Milkdown's DowngradeHeading), as byte edits. Three shapes:
//    * H_n (n≥2) -> H_{n-1}: delete ONE `#` from the marker run.
//    * H1 with content -> paragraph: delete the whole ATX opening.
//    * EMPTY H1 -> empty paragraph: no byte spelling exists, so the command
//      delegates to the /text machinery (delete the block, ride a
//      placeholder) and passes its docEnd/mid placeholder flags through.
// ---------------------------------------------------------------------------
const demote = (text, offset) => {
  const c = ctx(text)
  return { c, r: demoteHeadingAtCaret({ ...c, offset }) }
}

// H2 -> H1 with content: one `#` deleted, caret stays at content start.
{
  const { c, r } = demote('## 甲\n', 3)
  assert.equal(apply(c.doc, r), '# 甲\n')
  assert.deepEqual(shapeOf('# 甲\n'), ['heading1'])
  assert.deepEqual(r.transaction.edits, [{ from: 0, to: 1, insert: '' }])
  assert.deepEqual(r.transaction.selection, { anchor: 2, head: 2 })
}
// Every level n≥2 demotes to n-1.
{
  const cases = [
    ['###### t\n', 7, '##### t\n', ['heading5']],
    ['##### t\n', 6, '#### t\n', ['heading4']],
    ['#### t\n', 5, '### t\n', ['heading3']],
    ['### t\n', 4, '## t\n', ['heading2']]
  ]
  for (const [src, offset, expected, shape] of cases) {
    const { c, r } = demote(src, offset)
    assert.equal(apply(c.doc, r), expected, src)
    assert.deepEqual(shapeOf(expected), shape, src)
  }
}
// EMPTY H_n (n≥2) demotes by marker shortening — `# ` stays representable.
{
  const { c, r } = demote('## \n', 3)
  assert.equal(apply(c.doc, r), '# \n')
  assert.deepEqual(shapeOf('# \n'), ['heading1'])
  assert.deepEqual(r.transaction.selection, { anchor: 2, head: 2 })
}
// H1 with content -> paragraph: the whole `# ` opening is deleted.
{
  const { c, r } = demote('# 甲乙\n', 2)
  assert.equal(apply(c.doc, r), '甲乙\n')
  assert.deepEqual(shapeOf('甲乙\n'), ['paragraph'])
  assert.deepEqual(r.transaction.edits, [{ from: 0, to: 2, insert: '' }])
  assert.deepEqual(r.transaction.selection, { anchor: 0, head: 0 })
}
// Mid-document H1 -> paragraph, neighbours untouched byte for byte.
{
  const src = '前\n\n# 中\n\n后\n'
  const { c, r } = demote(src, src.indexOf('中'))
  assert.equal(apply(c.doc, r), '前\n\n中\n\n后\n')
  assert.deepEqual(shapeOf('前\n\n中\n\n后\n'), ['paragraph', 'paragraph', 'paragraph'])
}
// H_n (n≥2) directly above an adjacent line still demotes (the shorter ATX
// heading is still its own line; the paragraph below keeps its meaning).
{
  const { c, r } = demote('## 甲\n乙\n', 3)
  assert.equal(apply(c.doc, r), '# 甲\n乙\n')
  assert.deepEqual(shapeOf('# 甲\n乙\n'), ['heading1', 'paragraph'])
}
// CRLF: the edit stays strictly inside one line — endings survive verbatim.
{
  const { c, r } = demote('## 甲\r\n', 3)
  assert.equal(apply(c.doc, r), '# 甲\r\n')
}
{
  const { c, r } = demote('# 甲\r\n\r\n乙\r\n', 2)
  assert.equal(apply(c.doc, r), '甲\r\n\r\n乙\r\n')
  assert.deepEqual(shapeOf('甲\r\n\r\n乙\r\n'), ['paragraph', 'paragraph'])
}

// EMPTY H1 at the document end (the reported case): delegates to the /text
// machinery — the heading's bytes (plus the doc-end whitespace) are deleted
// and the caret rides the doc-end placeholder session.
{
  const { c, r } = demote('甲\n\n# \n', 5)
  assert.equal(r.ok, true, r.code)
  assert.equal(r.docEndPlaceholder, true, 'doc-end empty H1 rides the placeholder session')
  assert.equal(r.transaction.intent, 'revert-to-text')
  assert.equal(apply(c.doc, r), '甲\n\n')
  assert.deepEqual(r.transaction.selection, { anchor: 3, head: 3 })
}
// EMPTY H1 mid-document: the same delegation, mid-placeholder flavour.
{
  const src = '甲\n\n# \n\n乙\n'
  const { c, r } = demote(src, 5)
  assert.equal(r.ok, true, r.code)
  assert.equal(r.midPlaceholder, true, 'mid-doc empty H1 rides the split-placeholder session')
  assert.equal(apply(c.doc, r), '甲\n\n\n\n乙\n')
  assert.deepEqual(r.transaction.selection, { anchor: 3, head: 3 })
}

// NAMED REFUSALS — the position IS the demote gesture, but the unprefixed
// bytes would mean a DIFFERENT structure, so the command refuses rather than
// silently restructuring (or escaping bytes the user never typed).
const demoteRefuses = (label, text, offset, code = 'heading-demote-unsupported') => {
  const { r } = demote(text, offset)
  assert.equal(r.ok, false, label + ' must refuse')
  assert.equal(r.code, code, label + ' code')
  assert.equal(r.transaction, undefined, label + ' must not carry a transaction')
}
demoteRefuses('H1 whose text is an ordered-list marker', '# 1. 甲\n', 2)
demoteRefuses('H1 whose text is a bullet marker', '# - 甲\n', 2)
demoteRefuses('H1 whose text is another heading', '# # 甲\n', 2)
demoteRefuses('H1 whose text is a quote marker', '# > 甲\n', 2)
demoteRefuses('H1 above a setext underline', '# 甲\n=\n', 2)
demoteRefuses('H1 directly above an adjacent line (paragraphs would merge)', '# 甲\n乙\n', 2)
// Empty H1 directly above an adjacent line: the /text convergence proof
// refuses with ITS name — a character typed in the gap would join 乙.
demoteRefuses('empty H1 directly above an adjacent line', '# \n乙\n', 2, 'text-neighbors-would-merge')

// NOT-STRUCTURAL — not the gesture's position at all; the caller must fall
// through to its previous behaviour (plain character deletion / PM).
const demoteSkips = (label, text, offset) => {
  const { r } = demote(text, offset)
  assert.equal(r.ok, false, label + ' must not run')
  assert.equal(r.code, 'not-structural', label + ' code')
}
demoteSkips('mid-content caret', '## 甲\n', 4)
demoteSkips('marker-interior caret', '## 甲\n', 1)
demoteSkips('paragraph', '甲乙\n', 0)
demoteSkips('heading nested in a blockquote', '> # 甲\n', 4)
demoteSkips('heading nested in a list item', '- # 甲\n', 4)
demoteSkips('setext heading', '甲\n=\n', 0)
demoteSkips('space-less bare marker (a valid empty heading, but read-only)', '#\n', 1)

// The command never mutates its inputs, and its transactions are one-shot.
{
  const c = ctx('## 甲\n')
  const before = c.doc.text
  const revision = c.doc.revision
  demoteHeadingAtCaret({ ...c, offset: 3 })
  assert.equal(c.doc.text, before)
  assert.equal(c.doc.revision, revision)
}
{
  const c = ctx('## 甲\n')
  const first = demoteHeadingAtCaret({ ...c, offset: 3 })
  assert.equal(first.transaction.baseRevision, c.doc.revision)
  const applied = applySourceTransaction(c.doc, first.transaction).doc
  const replay = applySourceTransaction(applied, first.transaction)
  assert.equal(replay.ok, false, 'replaying a spent demote must be refused')
  assert.equal(replay.code, 'stale-revision')
}

console.log('ok - source kernel block-type')
