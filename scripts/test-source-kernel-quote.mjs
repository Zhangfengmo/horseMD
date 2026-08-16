// toggleBlockquote command tests (Plan 4 Task 4). Byte-authoritative: every
// expected string below was derived by actually running toggleBlockquote +
// applySourceTransaction (see the task report's probe transcript), not
// guessed from the brief.
import assert from 'node:assert/strict'
import { createMarkdownDocument, applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { buildSyntaxIndex } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { toggleBlockquote } from '../src/renderer/src/lib/source-kernel/commands/quote-toggle.js'

const ctx = (text) => ({ doc: createMarkdownDocument(text), index: buildSyntaxIndex(text) })
const apply = (doc, r) => {
  assert.equal(r.ok, true, r.code)
  return applySourceTransaction(doc, r.transaction).doc.text
}

// ---- paragraph: wrap, then unwrap back to the original ----
{
  const src = '甲乙\n'
  const c = ctx(src)
  const wrap = toggleBlockquote({ ...c, offset: 1 })
  assert.equal(wrap.ok, true)
  assert.equal(apply(c.doc, wrap), '> 甲乙\n')
  assert.deepEqual(wrap.transaction.selection, { anchor: 3, head: 3 },
    'caret shifted by the 2 inserted bytes ("> ")')

  const wrapped = applySourceTransaction(c.doc, wrap.transaction).doc
  const index2 = buildSyntaxIndex(wrapped.text)
  const unwrap = toggleBlockquote({ doc: wrapped, index: index2, offset: wrap.transaction.selection.anchor })
  assert.equal(unwrap.ok, true)
  assert.equal(apply(wrapped, unwrap), '甲乙\n', 'unwrap round-trips back to the original bytes')
  assert.deepEqual(unwrap.transaction.selection, { anchor: 1, head: 1 })
}

// ---- heading ----
{
  const src = '# 头\n'
  const c = ctx(src)
  const r = toggleBlockquote({ ...c, offset: 3 })
  assert.equal(r.ok, true)
  assert.equal(apply(c.doc, r), '> # 头\n')
}

// ---- offset exactly at block.end (blockAt is exclusive-end; the caret
// right after the last character is the ordinary "toggle from end of line"
// position and must still resolve via the same recovery enter.js's
// resolveBlock uses) ----
{
  const src = '甲乙\n'
  const c = ctx(src)
  const r = toggleBlockquote({ ...c, offset: 2 })
  assert.equal(r.ok, true)
  assert.equal(apply(c.doc, r), '> 甲乙\n')
}

// ---- tight list: whole list wrapped as one block (caret in either item) ----
{
  const src = '- one\n- two\n'
  const c = ctx(src)
  const r = toggleBlockquote({ ...c, offset: 2 })
  assert.equal(r.ok, true)
  assert.equal(apply(c.doc, r), '> - one\n> - two\n')
}

// ---- loose list: the internal blank line (list looseness) gets a BARE '>'
// so the reparse stays ONE blockquote, not two — probed against the live
// parser: leaving that line untouched splits into two separate `blockquote`
// nodes (see quote-toggle.js's wrapEdits comment for the probe transcript).
{
  const src = '- one\n\n- two\n'
  const c = ctx(src)
  const r = toggleBlockquote({ ...c, offset: 2 })
  assert.equal(r.ok, true)
  assert.equal(apply(c.doc, r), '> - one\n>\n> - two\n')

  // Round-trip: unwrapping the wrapped loose list restores the exact
  // original bytes, including the bare blank line (not a bare '>' line).
  const wrapped = applySourceTransaction(c.doc, r.transaction).doc
  const index2 = buildSyntaxIndex(wrapped.text)
  const unwrap = toggleBlockquote({ doc: wrapped, index: index2, offset: r.transaction.selection.anchor })
  assert.equal(unwrap.ok, true)
  assert.equal(apply(wrapped, unwrap), src)
}

// ---- nested (already-quoted) blockquote: unwrap peels exactly ONE layer,
// not all — a second toggle at the same content peels the remaining layer.
// '> > text\n' parses as ONE root-level `blockquote` node (probed), so the
// top-level walk lands on it regardless of nesting depth; QUOTE_MARKER_RE
// only ever matches the leftmost/outermost marker on each line.
{
  const src = '> > text\n'
  const c = ctx(src)
  const offset = src.indexOf('text')
  const r1 = toggleBlockquote({ ...c, offset })
  assert.equal(r1.ok, true)
  const applied1 = applySourceTransaction(c.doc, r1.transaction)
  assert.equal(applied1.doc.text, '> text\n', 'first toggle peels exactly one layer')

  const index2 = buildSyntaxIndex(applied1.doc.text)
  const r2 = toggleBlockquote({ doc: applied1.doc, index: index2, offset: r1.transaction.selection.anchor })
  assert.equal(r2.ok, true)
  const applied2 = applySourceTransaction(applied1.doc, r2.transaction)
  assert.equal(applied2.doc.text, 'text\n', 'second toggle peels the remaining layer')
}

// ---- caret inside a list that is itself nested inside an existing quote:
// the top-level block is the OUTER blockquote (a root child), so toggling
// unwraps the WHOLE thing (list included), not just the inner list. ----
{
  const src = '> - a\n> - b\n'
  const c = ctx(src)
  const r = toggleBlockquote({ ...c, offset: src.indexOf('a') })
  assert.equal(r.ok, true)
  assert.equal(apply(c.doc, r), '- a\n- b\n')
}

// ---- CRLF document: the inserted/removed marker never touches the line
// terminator, which stays '\r\n' throughout. ----
{
  const src = '甲乙\r\n'
  const c = ctx(src)
  const r = toggleBlockquote({ ...c, offset: 1 })
  assert.equal(r.ok, true)
  assert.equal(apply(c.doc, r), '> 甲乙\r\n')
}
{
  const src = '- one\r\n- two\r\n'
  const c = ctx(src)
  const r = toggleBlockquote({ ...c, offset: 2 })
  assert.equal(r.ok, true)
  assert.equal(apply(c.doc, r), '> - one\r\n> - two\r\n')
}

// ---- multi-block document: only the TARGET top-level block is touched; a
// following sibling block (and the blank-line gap that separates them,
// which sits outside the target node's own mdast range) is untouched. ----
{
  const src = '甲乙\n\n丙\n'
  const c = ctx(src)
  const r = toggleBlockquote({ ...c, offset: 1 })
  assert.equal(r.ok, true)
  assert.equal(apply(c.doc, r), '> 甲乙\n\n丙\n')
}

// ---- unsupported top-level node types stay fail-closed rejected: this
// command's domain is paragraph/heading/list (+ blockquote for unwrap)
// only — table/code/thematic-break are explicitly out of scope (separate
// syntax domains, plan 5). ----
{
  const src = '| a |\n| - |\n| b |\n'
  const c = ctx(src)
  assert.deepEqual(toggleBlockquote({ ...c, offset: 2 }), { ok: false, code: 'unsupported-structure' })
}
{
  const src = '```js\nabc\n```\n'
  const c = ctx(src)
  assert.deepEqual(toggleBlockquote({ ...c, offset: 7 }), { ok: false, code: 'unsupported-structure' })
}
{
  const src = '---\n'
  const c = ctx(src)
  assert.deepEqual(toggleBlockquote({ ...c, offset: 1 }), { ok: false, code: 'unsupported-structure' })
}

// ---- offset with no resolvable top-level node (e.g. past EOF/negative)
// stays fail-closed. ----
{
  const src = '甲乙\n'
  const c = ctx(src)
  assert.deepEqual(toggleBlockquote({ ...c, offset: -1 }), { ok: false, code: 'unsupported-structure' })
}

console.log('PASS source-kernel quote-toggle')
