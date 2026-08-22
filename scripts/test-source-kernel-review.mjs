// CriticMarkup review commands as raw-byte source transactions (kernel review
// domain). CriticMarkup is PLAIN TEXT syntax — {++ins++} / {--del--} /
// {==text==}{>>comment<<} — so in a source-authoritative kernel each review
// command is a byte insertion/replacement at a provable offset:
//   * wrapReviewMarkup     — the toolbar/menu "wrap the selection" command
//   * resolveReviewMarker  — the review card's Done/Delete (remove markup,
//                            keep text) and Edit→Save (replace markup)
// Every success case pins the EXACT byte outcome (LF and CRLF), every refusal
// pins its named code, and the no-mutation + stale-revision contracts are
// asserted like every other command suite in this family.
import assert from 'node:assert/strict'
import {
  createMarkdownDocument,
  applySourceTransaction
} from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { buildSyntaxIndex } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { buildCharacterMap } from '../src/renderer/src/lib/source-kernel/character-map.js'
import {
  wrapReviewMarkup,
  resolveReviewMarker
} from '../src/renderer/src/lib/source-kernel/commands/review-markup.js'

// Same setup idiom as test-source-kernel-commands.mjs: the map is the block's
// own charMap, visible offsets are block-content-relative. For the plain-ASCII
// fixtures below visible offset === raw offset − block.start.
const setup = (text, at) => {
  const doc = createMarkdownDocument(text)
  const index = buildSyntaxIndex(text)
  const block = index.blockAt(at)
  assert.ok(block, `no block at offset ${at}`)
  const map = buildCharacterMap(text, block.node)
  assert.ok(map, `block at ${at} must character-map for this fixture`)
  return { doc, index, block, map }
}

const visOf = (src, findText, at = 0) => {
  const rawFrom = src.indexOf(findText, at)
  assert.ok(rawFrom >= 0, `fixture text not found: ${findText}`)
  return { rawFrom, rawTo: rawFrom + findText.length }
}

// ---------------------------------------------------------------------------
// 1) wrap addition (LF): plain word in a plain paragraph
// ---------------------------------------------------------------------------
{
  const src = 'a bold b\n'
  const { doc, index, map, block } = setup(src, 0)
  const { rawFrom, rawTo } = visOf(src, 'bold')
  const r = wrapReviewMarkup({
    doc, index, map,
    visFrom: rawFrom - block.start, visTo: rawTo - block.start,
    kind: 'addition'
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  const applied = applySourceTransaction(doc, r.transaction)
  assert.equal(applied.ok, true)
  assert.equal(applied.doc.text, 'a {++bold++} b\n')
  // The legacy contract: the wrapped text stays selected inside the marker.
  assert.deepEqual(r.transaction.selection, { anchor: 5, head: 9 })
  // No mutation of the input doc.
  assert.equal(doc.text, src)
  assert.equal(doc.revision, 0)
}

// ---------------------------------------------------------------------------
// 2) wrap deletion (CRLF): soft-wrapped paragraph, selection on the first line
// ---------------------------------------------------------------------------
{
  const src = 'one two\r\nnext line\r\n'
  const { doc, index, map, block } = setup(src, 0)
  const { rawFrom, rawTo } = visOf(src, 'two')
  const r = wrapReviewMarkup({
    doc, index, map,
    visFrom: rawFrom - block.start, visTo: rawTo - block.start,
    kind: 'deletion'
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text,
    'one {--two--}\r\nnext line\r\n')
}

// ---------------------------------------------------------------------------
// 3) wrap highlight+comment: edge spaces stay OUTSIDE the marker (the legacy
//    wrapReviewSelection spelling, byte-identical), caret between >> and <<
// ---------------------------------------------------------------------------
{
  const src = 'pre core post\n'
  const { doc, index, map, block } = setup(src, 0)
  const rawFrom = src.indexOf(' core ')
  const rawTo = rawFrom + ' core '.length
  const r = wrapReviewMarkup({
    doc, index, map,
    visFrom: rawFrom - block.start, visTo: rawTo - block.start,
    kind: 'highlight'
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text,
    'pre {==core==}{>><<} post\n')
  const caret = 'pre {==core==}{>>'.length
  assert.deepEqual(r.transaction.selection, { anchor: caret, head: caret })
}

// ---------------------------------------------------------------------------
// 4) wrap inside a list item and inside a blockquote (nested containers whose
//    ancestor chain must survive the reparse proof)
// ---------------------------------------------------------------------------
{
  const src = '- item text\n- other\n'
  const { doc, index, map, block } = setup(src, src.indexOf('text'))
  const { rawFrom, rawTo } = visOf(src, 'text')
  const r = wrapReviewMarkup({
    doc, index, map,
    visFrom: rawFrom - block.start, visTo: rawTo - block.start,
    kind: 'addition'
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text,
    '- item {++text++}\n- other\n')
}
{
  const src = '> quoted words here\n\nafter\n'
  const { doc, index, map, block } = setup(src, src.indexOf('words'))
  const { rawFrom, rawTo } = visOf(src, 'words')
  const r = wrapReviewMarkup({
    doc, index, map,
    visFrom: rawFrom - block.start, visTo: rawTo - block.start,
    kind: 'deletion'
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text,
    '> quoted {--words--} here\n\nafter\n')
}

// ---------------------------------------------------------------------------
// 5) wrap fully INSIDE an existing mark's content is provable (the marker
//    lands inside the strong span; the display scan still sees one text node)
// ---------------------------------------------------------------------------
{
  const src = 'a **bold** b\n'
  const { doc, index, map } = setup(src, 0)
  // Visible text is 'a bold b'; select 'ol' (visible 3..5).
  const r = wrapReviewMarkup({ doc, index, map, visFrom: 3, visTo: 5, kind: 'deletion' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text,
    'a **b{--ol--}d** b\n')
}

// ---------------------------------------------------------------------------
// 6) refusals: selection straddling a mark boundary / covering an atom /
//    covering an entity — all 'review-plain-selection' (the wrap needs a
//    contiguous run of literal characters)
// ---------------------------------------------------------------------------
{
  const src = 'a **bold** b\n'
  const { doc, index, map } = setup(src, 0)
  // 'a bo' — visible 0..4 crosses the strong's opening delimiter gap.
  const r = wrapReviewMarkup({ doc, index, map, visFrom: 0, visTo: 4, kind: 'deletion' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'review-plain-selection')
  assert.equal(doc.text, src)
}
{
  const src = 'p $x$ q\n'
  const { doc, index, map } = setup(src, 0)
  // Visible 'p ? q' where the inline math is one atom: select 'p ?' (0..3).
  const r = wrapReviewMarkup({ doc, index, map, visFrom: 0, visTo: 3, kind: 'addition' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'review-plain-selection')
}
{
  const src = 'x &amp; y\n'
  const { doc, index, map } = setup(src, 0)
  // Visible 'x & y': select '& y' (2..5) — covers the entity unit.
  const r = wrapReviewMarkup({ doc, index, map, visFrom: 2, visTo: 5, kind: 'addition' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'review-plain-selection')
}

// ---------------------------------------------------------------------------
// 7) refusal: multiline selection (across the soft break) — 'review-multiline'
//    (the mode layer shows the same review.inlineOnly toast legacy shows)
// ---------------------------------------------------------------------------
{
  const src = 'one two\nnext line\n'
  const { doc, index, map } = setup(src, 0)
  const visFrom = 'one '.length
  const visTo = 'one two\nnext'.length // 'two\nnext' — crosses the linebreak unit
  const r = wrapReviewMarkup({ doc, index, map, visFrom, visTo, kind: 'deletion' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'review-multiline')
}

// ---------------------------------------------------------------------------
// 8) refusal: substitution wrap is a named refusal — its `{~~a~>b~~}` bytes
//    parse as GFM strikethrough in the kernel chain while the editor chain
//    reconstructs the literal marker (editor-criticmarkup-plugins.js), so the
//    two sides disagree on the block and the result could not be mapped.
//    Fail-closed with its own code instead of committing bytes into a block
//    the user could no longer type in.
// ---------------------------------------------------------------------------
{
  const src = 'a bold b\n'
  const { doc, index, map } = setup(src, 0)
  const r = wrapReviewMarkup({ doc, index, map, visFrom: 2, visTo: 6, kind: 'substitution' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'review-substitution')
  assert.equal(doc.text, src)
}

// ---------------------------------------------------------------------------
// 9) refusal: unsupported kinds and non-paragraph/heading blocks
// ---------------------------------------------------------------------------
{
  const src = 'a bold b\n'
  const { doc, index, map } = setup(src, 0)
  assert.equal(wrapReviewMarkup({ doc, index, map, visFrom: 2, visTo: 6, kind: 'comment' }).code,
    'unsupported-structure')
  assert.equal(wrapReviewMarkup({ doc, index, map, visFrom: 2, visTo: 6, kind: 'nope' }).code,
    'unsupported-structure')
}
{
  // A table cell: blockAt answers 'table', which is out of the wrap's domain.
  const src = '| a | b |\n| - | - |\n| cell | d |\n'
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  const cellStart = src.indexOf('cell')
  // Hand-build a map for the cell text so the refusal is the BLOCK gate, not a
  // missing map.
  const map = {
    visibleLength: 4,
    units: [],
    rawRangeForVisibleRange: () => ({ from: cellStart, to: cellStart + 4 })
  }
  const r = wrapReviewMarkup({ doc, index, map, visFrom: 0, visTo: 4, kind: 'addition' })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'unmapped-selection')
}

// ---------------------------------------------------------------------------
// 10) empty selection: the marker pair is inserted at the caret with the
//     caret inside it (the legacy menu path allows exactly this)
// ---------------------------------------------------------------------------
{
  const src = 'ab cd\n'
  const { doc, index, map } = setup(src, 0)
  const r = wrapReviewMarkup({ doc, index, map, visFrom: 3, visTo: 3, kind: 'addition' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text, 'ab {++++}cd\n')
  assert.deepEqual(r.transaction.selection, { anchor: 6, head: 6 })
}

// ---------------------------------------------------------------------------
// 11) heading block (allowed) + wrap in a heading keeps the marker after the
//     ATX prefix
// ---------------------------------------------------------------------------
{
  const src = '# title here\n\nbody\n'
  const { doc, index, map, block } = setup(src, 2)
  const { rawFrom, rawTo } = visOf(src, 'title')
  // Heading content starts at raw 2 — visible offsets are content-relative.
  const contentStart = block.node.children[0].position.start.offset
  const r = wrapReviewMarkup({
    doc, index, map,
    visFrom: rawFrom - contentStart, visTo: rawTo - contentStart,
    kind: 'addition'
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text,
    '# {++title++} here\n\nbody\n')
}

// ---------------------------------------------------------------------------
// 12) stale revision: the transaction is pinned to the doc revision it was
//     built against
// ---------------------------------------------------------------------------
{
  const src = 'a bold b\n'
  const { doc, index, map } = setup(src, 0)
  const r = wrapReviewMarkup({ doc, index, map, visFrom: 2, visTo: 6, kind: 'addition' })
  assert.equal(r.ok, true)
  const moved = { ...doc, revision: doc.revision + 1 }
  assert.deepEqual(
    applySourceTransaction(moved, r.transaction),
    { ok: false, code: 'stale-revision' }
  )
}

// ---------------------------------------------------------------------------
// 13) resolveReviewMarker: Done/Delete removes the markup, keeps the text
//     (LF + CRLF), and Edit→Save replaces the whole marker span
// ---------------------------------------------------------------------------
{
  const src = 'x {==aim==}{>>note<<} y\n'
  const { doc, index, map } = setup(src, 0)
  const rawFrom = src.indexOf('{==')
  const rawTo = src.indexOf('<<}') + 3
  const r = resolveReviewMarker({
    doc, index, map,
    visFrom: rawFrom, visTo: rawTo,
    expected: { text: 'aim', comment: 'note' },
    action: 'remove'
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text, 'x aim y\n')
  assert.equal(doc.text, src)
}
{
  const src = 'x {==aim==}{>>note<<} y\r\nnext\r\n'
  const { doc, index, map } = setup(src, 0)
  const rawFrom = src.indexOf('{==')
  const rawTo = src.indexOf('<<}') + 3
  const r = resolveReviewMarker({
    doc, index, map,
    visFrom: rawFrom, visTo: rawTo,
    expected: { text: 'aim', comment: 'note' },
    action: 'remove'
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text, 'x aim y\r\nnext\r\n')
}
{
  const src = 'x {==aim==}{>>note<<} y\n'
  const { doc, index, map } = setup(src, 0)
  const rawFrom = src.indexOf('{==')
  const rawTo = src.indexOf('<<}') + 3
  const r = resolveReviewMarker({
    doc, index, map,
    visFrom: rawFrom, visTo: rawTo,
    expected: { text: 'aim', comment: 'note' },
    action: 'replace',
    replacement: { text: 'goal', comment: 'better note' }
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text,
    'x {==goal==}{>>better note<<} y\n')
}

// ---------------------------------------------------------------------------
// 14) resolve refusals: stale content, span that is not a marker, invalid
//     replacement fields, and a replacement whose text would parse as marks
// ---------------------------------------------------------------------------
{
  const src = 'x {==aim==}{>>note<<} y\n'
  const { doc, index, map } = setup(src, 0)
  const rawFrom = src.indexOf('{==')
  const rawTo = src.indexOf('<<}') + 3
  // Stale: the annotation the card holds no longer matches the source.
  assert.equal(resolveReviewMarker({
    doc, index, map, visFrom: rawFrom, visTo: rawTo,
    expected: { text: 'aim', comment: 'OTHER' }, action: 'remove'
  }).code, 'review-marker-not-found')
  // Not a marker span at all.
  assert.equal(resolveReviewMarker({
    doc, index, map, visFrom: 0, visTo: 5,
    expected: { text: 'aim', comment: 'note' }, action: 'remove'
  }).code, 'review-marker-not-found')
  // Invalid fields (empty / delimiter-unsafe).
  assert.equal(resolveReviewMarker({
    doc, index, map, visFrom: rawFrom, visTo: rawTo,
    expected: { text: 'aim', comment: 'note' },
    action: 'replace', replacement: { text: '', comment: 'c' }
  }).code, 'review-invalid-fields')
  assert.equal(resolveReviewMarker({
    doc, index, map, visFrom: rawFrom, visTo: rawTo,
    expected: { text: 'aim', comment: 'note' },
    action: 'replace', replacement: { text: 'a', comment: 'evil<<}x' }
  }).code, 'review-invalid-fields')
  // A replacement text that would PARSE (strong) breaks the literal-marker
  // prediction — refused by the reparse proof, bytes untouched.
  const structural = resolveReviewMarker({
    doc, index, map, visFrom: rawFrom, visTo: rawTo,
    expected: { text: 'aim', comment: 'note' },
    action: 'replace', replacement: { text: '**bold**', comment: 'c' }
  })
  assert.equal(structural.ok, false)
  assert.equal(structural.code, 'unsupported-structure')
  assert.equal(doc.text, src)
}

// ---------------------------------------------------------------------------
// 15) outside-the-block safety: a wrap in one block leaves every other block
//     byte-identical (assert the full document, blocks before AND after)
// ---------------------------------------------------------------------------
{
  const src = '# head\n\nfirst para\n\n- li one\n- li two\n\ntail para\n'
  const { doc, index, map, block } = setup(src, src.indexOf('first'))
  const { rawFrom, rawTo } = visOf(src, 'para')
  const r = wrapReviewMarkup({
    doc, index, map,
    visFrom: rawFrom - block.start, visTo: rawTo - block.start,
    kind: 'highlight'
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text,
    '# head\n\nfirst {==para==}{>><<}\n\n- li one\n- li two\n\ntail para\n')
}

console.log('PASS source-kernel review markup (wrap + resolve, LF/CRLF, named refusals, no-mutation, stale-revision)')
