import assert from 'node:assert/strict'
import { buildSyntaxIndex } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { inlineMarkAt, markerFor } from '../src/renderer/src/lib/source-kernel/mark-map.js'

const at = (src, findText) => {
  const idx = buildSyntaxIndex(src)
  const rawFrom = src.indexOf(findText)
  assert.ok(rawFrom >= 0, `fixture text not found: ${findText}`)
  const rawTo = rawFrom + findText.length
  return { idx, rawFrom, rawTo }
}

// --- markerFor -------------------------------------------------------------
{
  assert.equal(markerFor('strong'), '**')
  assert.equal(markerFor('emphasis'), '*')
  assert.equal(markerFor('delete'), '~~')
  assert.equal(markerFor('inlineCode'), '`')
  assert.equal(markerFor('highlight'), '==')
  assert.equal(markerFor('nope'), null)
}

// --- strong: "a **bold** b" -> strong{2,10}, content{4,8} "bold" -----------
{
  const src = 'a **bold** b\n'
  const { idx, rawFrom, rawTo } = at(src, 'bold')
  const mark = inlineMarkAt(idx, rawFrom, rawTo)
  assert.ok(mark, 'strong should be found')
  assert.equal(mark.type, 'strong')
  assert.deepEqual(mark.contentRange, { from: 4, to: 8 })
  assert.deepEqual(mark.openRange, { from: 2, to: 4 })
  assert.deepEqual(mark.closeRange, { from: 8, to: 10 })
  assert.equal(src.slice(mark.openRange.from, mark.openRange.to), '**')
  assert.equal(src.slice(mark.closeRange.from, mark.closeRange.to), '**')
  assert.equal(src.slice(mark.contentRange.from, mark.contentRange.to), 'bold')
}

// --- emphasis (asterisk): "a *em* b" ----------------------------------------
{
  const src = 'a *em* b\n'
  const { idx, rawFrom, rawTo } = at(src, 'em')
  const mark = inlineMarkAt(idx, rawFrom, rawTo)
  assert.ok(mark)
  assert.equal(mark.type, 'emphasis')
  assert.deepEqual(mark.contentRange, { from: 3, to: 5 })
  assert.deepEqual(mark.openRange, { from: 2, to: 3 })
  assert.deepEqual(mark.closeRange, { from: 5, to: 6 })
  assert.equal(src.slice(mark.openRange.from, mark.openRange.to), '*')
  assert.equal(src.slice(mark.closeRange.from, mark.closeRange.to), '*')
}

// --- emphasis (underscore): marker bytes read straight off raw source ------
{
  const src = 'a _em_ b\n'
  const { idx, rawFrom, rawTo } = at(src, 'em')
  const mark = inlineMarkAt(idx, rawFrom, rawTo)
  assert.ok(mark)
  assert.equal(mark.type, 'emphasis')
  assert.equal(src.slice(mark.openRange.from, mark.openRange.to), '_')
  assert.equal(src.slice(mark.closeRange.from, mark.closeRange.to), '_')
}

// --- delete (GFM strikethrough): "a ~~del~~ b" ------------------------------
{
  const src = 'a ~~del~~ b\n'
  const { idx, rawFrom, rawTo } = at(src, 'del')
  const mark = inlineMarkAt(idx, rawFrom, rawTo)
  assert.ok(mark)
  assert.equal(mark.type, 'delete')
  assert.deepEqual(mark.contentRange, { from: 4, to: 7 })
  assert.equal(src.slice(mark.openRange.from, mark.openRange.to), '~~')
  assert.equal(src.slice(mark.closeRange.from, mark.closeRange.to), '~~')
}

// --- inlineCode: single-backtick run ----------------------------------------
{
  const src = 'a `code` b\n'
  const { idx, rawFrom, rawTo } = at(src, 'code')
  const mark = inlineMarkAt(idx, rawFrom, rawTo)
  assert.ok(mark)
  assert.equal(mark.type, 'inlineCode')
  assert.deepEqual(mark.contentRange, { from: 3, to: 7 })
  assert.deepEqual(mark.openRange, { from: 2, to: 3 })
  assert.deepEqual(mark.closeRange, { from: 7, to: 8 })
  assert.equal(src.slice(mark.openRange.from, mark.openRange.to), '`')
  assert.equal(src.slice(mark.closeRange.from, mark.closeRange.to), '`')
}

// --- inlineCode: double-backtick run ----------------------------------------
{
  const src = 'a ``code`` b\n'
  const { idx, rawFrom, rawTo } = at(src, 'code')
  const mark = inlineMarkAt(idx, rawFrom, rawTo)
  assert.ok(mark)
  assert.equal(mark.type, 'inlineCode')
  assert.deepEqual(mark.openRange, { from: 2, to: 4 })
  assert.deepEqual(mark.closeRange, { from: 8, to: 10 })
  assert.equal(src.slice(mark.openRange.from, mark.openRange.to), '``')
  assert.equal(src.slice(mark.closeRange.from, mark.closeRange.to), '``')
}

// --- inlineCode: double-backtick run with a single embedded backtick -------
// mdast value is "a`b" (the single backtick survives as content because the
// delimiter run, 2, is strictly longer) — counting from each edge must stop
// at the first non-backtick and not over-consume into the content.
{
  const src = 'a ``a`b`` c\n'
  const { idx, rawFrom, rawTo } = at(src, 'a`b')
  const mark = inlineMarkAt(idx, rawFrom, rawTo)
  assert.ok(mark)
  assert.equal(mark.type, 'inlineCode')
  assert.deepEqual(mark.openRange, { from: 2, to: 4 })
  assert.deepEqual(mark.closeRange, { from: 7, to: 9 })
  assert.equal(src.slice(mark.contentRange.from, mark.contentRange.to), 'a`b')
}

// --- nested strong>emphasis: exact-content-range selection picks innermost -
{
  const src = '**a *b* c**\n'
  const { idx, rawFrom, rawTo } = at(src, 'b')
  const inner = inlineMarkAt(idx, rawFrom, rawTo)
  assert.ok(inner)
  assert.equal(inner.type, 'emphasis')
  assert.deepEqual(inner.contentRange, { from: 5, to: 6 })

  // Selecting the strong's full content (which includes the emphasis'
  // markers) resolves to the strong node, not the emphasis.
  const outer = inlineMarkAt(idx, 2, 9)
  assert.ok(outer)
  assert.equal(outer.type, 'strong')
  assert.deepEqual(outer.contentRange, { from: 2, to: 9 })
}

// --- partial overlap: selection covers only part of a mark's content -> null
{
  const src = 'a **bold** b\n'
  const idx = buildSyntaxIndex(src)
  // "bo" only, not the full "bold" content
  assert.equal(inlineMarkAt(idx, 4, 6), null)
  // one byte short on the right edge
  assert.equal(inlineMarkAt(idx, 4, 7), null)
  // includes the closing marker itself (over-selects)
  assert.equal(inlineMarkAt(idx, 4, 9), null)
}

// --- no mark at all: plain text selection -----------------------------------
{
  const src = 'a plain sentence b\n'
  const idx = buildSyntaxIndex(src)
  const rawFrom = src.indexOf('plain')
  const rawTo = rawFrom + 'plain'.length
  assert.equal(inlineMarkAt(idx, rawFrom, rawTo), null)
}

// --- highlight: positive flank detection ------------------------------------
// Kernel's own remark chain (no editor-highlight plugin) parses `==hl==` as
// plain text — inlineMarkAt must derive this from raw-byte flanking, not by
// finding an mdast node.
{
  const src = 'a ==hl== b\n'
  const idx = buildSyntaxIndex(src)
  const rawFrom = src.indexOf('hl')
  const rawTo = rawFrom + 'hl'.length
  const mark = inlineMarkAt(idx, rawFrom, rawTo)
  assert.ok(mark, 'highlight should be found via flank check')
  assert.equal(mark.type, 'highlight')
  assert.deepEqual(mark.contentRange, { from: rawFrom, to: rawTo })
  assert.deepEqual(mark.openRange, { from: rawFrom - 2, to: rawFrom })
  assert.deepEqual(mark.closeRange, { from: rawTo, to: rawTo + 2 })
  assert.equal(src.slice(mark.openRange.from, mark.openRange.to), '==')
  assert.equal(src.slice(mark.closeRange.from, mark.closeRange.to), '==')
}

// --- highlight: negative — only one flank present -> null ------------------
{
  // Left flank only: "==hl" then a non-`=` close.
  const src = 'a ==hl-- b\n'
  const idx = buildSyntaxIndex(src)
  const rawFrom = src.indexOf('hl')
  const rawTo = rawFrom + 'hl'.length
  assert.equal(inlineMarkAt(idx, rawFrom, rawTo), null)
}
{
  // Right flank only: "hl==" preceded by a non-`=` open.
  const src = 'a --hl== b\n'
  const idx = buildSyntaxIndex(src)
  const rawFrom = src.indexOf('hl')
  const rawTo = rawFrom + 'hl'.length
  assert.equal(inlineMarkAt(idx, rawFrom, rawTo), null)
}
{
  // Neither flank.
  const src = 'a hl b\n'
  const idx = buildSyntaxIndex(src)
  const rawFrom = src.indexOf('hl')
  const rawTo = rawFrom + 'hl'.length
  assert.equal(inlineMarkAt(idx, rawFrom, rawTo), null)
}
{
  // Selection flush against the start/end of the document: not enough room
  // for a flank on one side — must fail closed, not throw or read out of
  // bounds.
  const src = 'hl== b\n'
  const idx = buildSyntaxIndex(src)
  assert.equal(inlineMarkAt(idx, 0, 2), null)
}

// --- CRLF document: mark earlier on the first line is unaffected -----------
{
  const src = 'a **bold** b\r\nsecond line\r\n'
  const { idx, rawFrom, rawTo } = at(src, 'bold')
  const mark = inlineMarkAt(idx, rawFrom, rawTo)
  assert.ok(mark)
  assert.equal(mark.type, 'strong')
  assert.deepEqual(mark.contentRange, { from: 4, to: 8 })
  assert.equal(src.slice(mark.openRange.from, mark.openRange.to), '**')
  assert.equal(src.slice(mark.closeRange.from, mark.closeRange.to), '**')
}

// --- CRLF document: highlight flank check on the second line ---------------
{
  const src = 'first line\r\na ==hl== b\r\n'
  const idx = buildSyntaxIndex(src)
  const rawFrom = src.indexOf('hl')
  const rawTo = rawFrom + 'hl'.length
  const mark = inlineMarkAt(idx, rawFrom, rawTo)
  assert.ok(mark)
  assert.equal(mark.type, 'highlight')
}

// --- quoted paragraph: mdast positions are absolute raw offsets, so a mark
// inside a blockquote needs no prefix adjustment.
{
  const src = '> a **bold** b\n'
  const { idx, rawFrom, rawTo } = at(src, 'bold')
  const mark = inlineMarkAt(idx, rawFrom, rawTo)
  assert.ok(mark, 'strong inside a blockquote should still resolve')
  assert.equal(mark.type, 'strong')
  assert.deepEqual(mark.contentRange, { from: 6, to: 10 })
  assert.equal(src.slice(mark.openRange.from, mark.openRange.to), '**')
  assert.equal(src.slice(mark.closeRange.from, mark.closeRange.to), '**')
}

// --- quoted paragraph: highlight flank check also holds under a `> ` prefix
{
  const src = '> a ==hl== b\n'
  const idx = buildSyntaxIndex(src)
  const rawFrom = src.indexOf('hl')
  const rawTo = rawFrom + 'hl'.length
  const mark = inlineMarkAt(idx, rawFrom, rawTo)
  assert.ok(mark)
  assert.equal(mark.type, 'highlight')
}

// --- heading: marks resolve inside heading blocks too -----------------------
{
  const src = '# a **bold** b\n'
  const { idx, rawFrom, rawTo } = at(src, 'bold')
  const mark = inlineMarkAt(idx, rawFrom, rawTo)
  assert.ok(mark)
  assert.equal(mark.type, 'strong')
}

// --- fenced code block: highlight flank check does not fire on code content
// (INLINE_CONTENT_BLOCKS excludes 'code' — literal `==` inside a fence is not
// a highlight mark).
{
  const src = '```\na ==hl== b\n```\n'
  const idx = buildSyntaxIndex(src)
  const rawFrom = src.indexOf('hl')
  const rawTo = rawFrom + 'hl'.length
  assert.equal(inlineMarkAt(idx, rawFrom, rawTo), null)
}

// --- invalid ranges: rawTo <= rawFrom, out of bounds -> null, never throws -
{
  const src = 'a **bold** b\n'
  const idx = buildSyntaxIndex(src)
  assert.equal(inlineMarkAt(idx, 5, 5), null)
  assert.equal(inlineMarkAt(idx, 5, 3), null)
  assert.equal(inlineMarkAt(idx, -1, 3), null)
  assert.equal(inlineMarkAt(idx, 0, src.length + 100), null)
}

console.log('PASS source-kernel mark map')
