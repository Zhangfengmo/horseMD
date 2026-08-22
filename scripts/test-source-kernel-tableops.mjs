// Table structural ops (add/delete row & column, column alignment) as pure
// source transactions — lib/source-kernel/commands/table-ops.js.
//
// Byte-authoritative like the sibling suites (blocktype/blockinsert): every
// expected string is the literal spliced result, every accepted result is
// REPARSED and its table shape (rows / columns / align) asserted, and every
// untouched cell's decoded text is compared — a byte assertion alone cannot
// tell "the row landed between the delimiters" from "the row was absorbed as
// ragged trailing cells".
import assert from 'node:assert/strict'
import { createMarkdownDocument, applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { buildSyntaxIndex, parseKernelMarkdown } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import {
  insertTableRow,
  insertTableColumn,
  deleteTableRow,
  deleteTableColumn,
  setTableColumnAlignment,
  TABLE_OP_CODES
} from '../src/renderer/src/lib/source-kernel/commands/table-ops.js'

console.log('--- source kernel table-ops ---')

const ctx = (text) => ({ doc: createMarkdownDocument(text), index: buildSyntaxIndex(text) })
const apply = (doc, r, label) => {
  assert.equal(r.ok, true, `${label}: ${r.code}`)
  const applied = applySourceTransaction(doc, r.transaction)
  assert.equal(applied.ok, true, `${label}: apply ${applied.code}`)
  return applied.doc.text
}

// First table in the tree, descending through blockquotes.
const findTable = (tree) => {
  for (const node of tree.children || []) {
    if (node.type === 'table') return node
    if (node.type === 'blockquote') {
      const inner = findTable(node)
      if (inner) return inner
    }
  }
  return null
}

// Reparsed table shape: row count, per-row cell count, align array and the
// DECODED text of every cell (concatenated inline values).
const cellText = (cell) => {
  const parts = []
  const walk = (n) => {
    if (typeof n.value === 'string') parts.push(n.value)
    for (const c of n.children || []) walk(c)
  }
  for (const c of cell.children || []) walk(c)
  return parts.join('')
}
const tableShape = (text) => {
  const table = findTable(parseKernelMarkdown(text))
  if (!table) return null
  return {
    align: table.align,
    rows: (table.children || []).map((row) => (row.children || []).map(cellText))
  }
}

// ---------------------------------------------------------------------------
// Fixtures are composed from LINE ARRAYS so LF/CRLF variants and expected
// results stay hand-checkable.
// ---------------------------------------------------------------------------
const D = (lines, eol = '\n', trailing = true) => lines.join(eol) + (trailing ? eol : '')

const BASE = ['前文', '', '| a | b |', '| --- | ---: |', '| c | d |', '', '后文']
const baseText = (eol = '\n') => D(BASE, eol)
const tableAt = (text) => text.indexOf('| a | b |')

// ===========================================================================
// 1. insertTableRow
// ===========================================================================
{
  // (a) Before the first body row (between delimiter and `| c | d |`).
  for (const eol of ['\n', '\r\n']) {
    const text = baseText(eol)
    const c = ctx(text)
    const r = insertTableRow({ ...c, offset: tableAt(text), rowIndex: 1 })
    const expected = D(['前文', '', '| a | b |', '| --- | ---: |', '|  |  |', '| c | d |', '', '后文'], eol)
    const out = apply(c.doc, r, `row before body (${JSON.stringify(eol)})`)
    assert.equal(out, expected)
    assert.deepEqual(tableShape(out), {
      align: [null, 'right'],
      rows: [['a', 'b'], ['', ''], ['c', 'd']]
    }, 'row insert: reparsed shape')
    assert.equal(r.transaction.edits.length, 1, 'row insert is ONE edit')
    const anchor = r.transaction.selection.anchor
    assert.equal(expected.slice(anchor - 2, anchor + 2), '|  |', 'caret in the new first cell')
    assert.equal(anchor, expected.indexOf('|  |  |') + 2)
  }

  // (b) Append after the last row (rowIndex === row count).
  {
    const text = baseText()
    const c = ctx(text)
    const r = insertTableRow({ ...c, offset: tableAt(text), rowIndex: 2 })
    const out = apply(c.doc, r, 'row append')
    assert.equal(out, D(['前文', '', '| a | b |', '| --- | ---: |', '| c | d |', '|  |  |', '', '后文']))
    assert.deepEqual(tableShape(out).rows, [['a', 'b'], ['c', 'd'], ['', '']])
  }

  // (c) Append when the table is the document's LAST content and has NO
  //     trailing line ending at all.
  {
    const text = D(['| a | b |', '| --- | ---: |', '| c | d |'], '\n', false)
    const c = ctx(text)
    const r = insertTableRow({ ...c, offset: 0, rowIndex: 2 })
    const out = apply(c.doc, r, 'row append at EOF')
    assert.equal(out, D(['| a | b |', '| --- | ---: |', '| c | d |', '|  |  |'], '\n', false))
    assert.deepEqual(tableShape(out).rows, [['a', 'b'], ['c', 'd'], ['', '']])
  }
  {
    const text = D(['| a | b |', '| --- | ---: |', '| c | d |'], '\r\n', false)
    const c = ctx(text)
    const r = insertTableRow({ ...c, offset: 0, rowIndex: 2 })
    const out = apply(c.doc, r, 'row append at CRLF EOF')
    assert.equal(out, D(['| a | b |', '| --- | ---: |', '| c | d |', '|  |  |'], '\r\n', false))
    assert.equal(/(?<!\r)\n/.test(out), false, 'no lone LF introduced')
  }

  // (d) Between two body rows of a three-row table.
  {
    const text = D(['| a | b |', '| --- | --- |', '| c | d |', '| e | f |'])
    const c = ctx(text)
    const r = insertTableRow({ ...c, offset: 0, rowIndex: 2 })
    const out = apply(c.doc, r, 'row between bodies')
    assert.equal(out, D(['| a | b |', '| --- | --- |', '| c | d |', '|  |  |', '| e | f |']))
    assert.deepEqual(tableShape(out).rows, [['a', 'b'], ['c', 'd'], ['', ''], ['e', 'f']])
  }

  // (d2) Append when a heading DIRECTLY follows the table (no blank line) —
  //      the heading must survive untouched (the outside-signature axis).
  {
    const text = D(['| a | b |', '| --- | --- |', '| c | d |', '# 头'])
    const c = ctx(text)
    const r = insertTableRow({ ...c, offset: 0, rowIndex: 2 })
    const out = apply(c.doc, r, 'row append before heading')
    assert.equal(out, D(['| a | b |', '| --- | --- |', '| c | d |', '|  |  |', '# 头']))
    const types = parseKernelMarkdown(out).children.map((n) => n.type)
    assert.deepEqual(types, ['table', 'heading'], 'the heading stays a sibling, never a row')
  }

  // (e) Refusals: above the header, out of range.
  for (const [label, rowIndex] of [['above header', 0], ['negative', -1], ['past end', 3], ['non-integer', 1.5]]) {
    const text = baseText()
    const c = ctx(text)
    const r = insertTableRow({ ...c, offset: tableAt(text), rowIndex })
    assert.equal(r.ok, false, `${label} must refuse`)
    assert.equal(r.code, TABLE_OP_CODES.UNSUPPORTED, `${label} code`)
    assert.equal(r.transaction, undefined)
  }
}

// ===========================================================================
// 2. insertTableColumn
// ===========================================================================
{
  // (a) Before column 0 — the delimiter gains `| --- ` and align gains null.
  for (const eol of ['\n', '\r\n']) {
    const text = baseText(eol)
    const c = ctx(text)
    const r = insertTableColumn({ ...c, offset: tableAt(text), columnIndex: 0 })
    const expected = D(['前文', '', '|  | a | b |', '| --- | --- | ---: |', '|  | c | d |', '', '后文'], eol)
    const out = apply(c.doc, r, `col before 0 (${JSON.stringify(eol)})`)
    assert.equal(out, expected)
    assert.deepEqual(tableShape(out), {
      align: [null, null, 'right'],
      rows: [['', 'a', 'b'], ['', 'c', 'd']]
    })
    assert.equal(r.transaction.edits.length, 3, 'one edit per line incl. delimiter')
    const anchor = r.transaction.selection.anchor
    assert.equal(expected.slice(anchor - 2, anchor + 2), '|  |', 'caret in the new header cell')
  }

  // (b) Middle (before column 1).
  {
    const text = baseText()
    const c = ctx(text)
    const r = insertTableColumn({ ...c, offset: tableAt(text), columnIndex: 1 })
    const out = apply(c.doc, r, 'col before 1')
    assert.equal(out, D(['前文', '', '| a |  | b |', '| --- | --- | ---: |', '| c |  | d |', '', '后文']))
    assert.deepEqual(tableShape(out).align, [null, null, 'right'])
    assert.deepEqual(tableShape(out).rows, [['a', '', 'b'], ['c', '', 'd']])
  }

  // (c) Append after the last column (columnIndex === width). The existing
  //     `---:` spec must stay byte-identical (alignment is untouched).
  {
    const text = baseText()
    const c = ctx(text)
    const r = insertTableColumn({ ...c, offset: tableAt(text), columnIndex: 2 })
    const out = apply(c.doc, r, 'col append')
    assert.equal(out, D(['前文', '', '| a | b |  |', '| --- | ---: | --- |', '| c | d |  |', '', '后文']))
    assert.deepEqual(tableShape(out).align, [null, 'right', null])
    const anchor = r.transaction.selection.anchor
    assert.equal(out.slice(anchor - 2, anchor + 2), '|  |', 'caret in the appended header cell')
  }

  // (d) Append at EOF without trailing ending.
  {
    const text = D(['| a | b |', '| --- | --- |', '| c | d |'], '\n', false)
    const c = ctx(text)
    const r = insertTableColumn({ ...c, offset: 0, columnIndex: 2 })
    const out = apply(c.doc, r, 'col append at EOF')
    assert.equal(out, D(['| a | b |  |', '| --- | --- | --- |', '| c | d |  |'], '\n', false))
  }

  // (e) Refusals: out of range.
  for (const [label, columnIndex] of [['negative', -1], ['past width', 3], ['non-integer', 0.5]]) {
    const text = baseText()
    const c = ctx(text)
    const r = insertTableColumn({ ...c, offset: tableAt(text), columnIndex })
    assert.equal(r.ok, false, `${label} must refuse`)
    assert.equal(r.code, TABLE_OP_CODES.UNSUPPORTED)
  }
}

// ===========================================================================
// 3. deleteTableRow
// ===========================================================================
{
  const three = () => D(['| a | b |', '| --- | ---: |', '| c | d |', '| e | f |'])
  // (a) Middle body row.
  {
    const c = ctx(three())
    const r = deleteTableRow({ ...c, offset: 0, rowIndex: 1 })
    const out = apply(c.doc, r, 'delete middle row')
    assert.equal(out, D(['| a | b |', '| --- | ---: |', '| e | f |']))
    assert.deepEqual(tableShape(out).rows, [['a', 'b'], ['e', 'f']])
    // Caret lands in the first cell of the row that took its place.
    assert.equal(out[r.transaction.selection.anchor], 'e')
  }
  // (b) Last body row (of two).
  {
    const c = ctx(three())
    const r = deleteTableRow({ ...c, offset: 0, rowIndex: 2 })
    const out = apply(c.doc, r, 'delete last row')
    assert.equal(out, D(['| a | b |', '| --- | ---: |', '| c | d |']))
    assert.equal(out[r.transaction.selection.anchor], 'c', 'caret clamps to the new last row')
  }
  // (c) Last body row when the table ends the document without a trailing
  //     ending: the PRECEDING ending is removed instead.
  {
    const text = D(['| a | b |', '| --- | --- |', '| c | d |', '| e | f |'], '\r\n', false)
    const c = ctx(text)
    const r = deleteTableRow({ ...c, offset: 0, rowIndex: 2 })
    const out = apply(c.doc, r, 'delete EOF row')
    assert.equal(out, D(['| a | b |', '| --- | --- |', '| c | d |'], '\r\n', false))
    assert.equal(/(?<!\r)\n/.test(out), false, 'no lone LF introduced')
  }
  // (d) The ONLY body row: refuse with the named code (a header-only table is
  //     not representable in the editor's PM schema).
  {
    const text = baseText()
    const c = ctx(text)
    const r = deleteTableRow({ ...c, offset: tableAt(text), rowIndex: 1 })
    assert.equal(r.ok, false)
    assert.equal(r.code, TABLE_OP_CODES.LAST_ROW)
    assert.equal(r.transaction, undefined)
  }
  // (e) Header row / out of range.
  for (const [label, rowIndex] of [['header row', 0], ['past end', 3], ['negative', -1]]) {
    const c = ctx(three())
    const r = deleteTableRow({ ...c, offset: 0, rowIndex })
    assert.equal(r.ok, false, `${label} must refuse`)
    assert.equal(r.code, TABLE_OP_CODES.UNSUPPORTED, `${label} code`)
  }
}

// ===========================================================================
// 4. deleteTableColumn
// ===========================================================================
{
  const wide = () => D(['| a | b | c |', '| :--- | --- | ---: |', '| d | e | f |'])
  // (a) First column — align entry drops, later entries shift.
  {
    const c = ctx(wide())
    const r = deleteTableColumn({ ...c, offset: 0, columnIndex: 0 })
    const out = apply(c.doc, r, 'delete col 0')
    assert.equal(out, D(['| b | c |', '| --- | ---: |', '| e | f |']))
    assert.deepEqual(tableShape(out), { align: [null, 'right'], rows: [['b', 'c'], ['e', 'f']] })
    assert.equal(out[r.transaction.selection.anchor], 'b', 'caret in the cell that took its place')
  }
  // (b) Middle column.
  {
    const c = ctx(wide())
    const r = deleteTableColumn({ ...c, offset: 0, columnIndex: 1 })
    const out = apply(c.doc, r, 'delete col 1')
    assert.equal(out, D(['| a | c |', '| :--- | ---: |', '| d | f |']))
    assert.deepEqual(tableShape(out).align, ['left', 'right'])
  }
  // (c) Last column — the closing pipe survives.
  {
    const c = ctx(wide())
    const r = deleteTableColumn({ ...c, offset: 0, columnIndex: 2 })
    const out = apply(c.doc, r, 'delete col 2')
    assert.equal(out, D(['| a | b |', '| :--- | --- |', '| d | e |']))
    assert.deepEqual(tableShape(out).align, ['left', null])
    assert.equal(out[r.transaction.selection.anchor], 'b', 'caret clamps to the new last column')
  }
  // (d) CRLF.
  {
    const text = D(['| a | b | c |', '| :--- | --- | ---: |', '| d | e | f |'], '\r\n')
    const c = ctx(text)
    const r = deleteTableColumn({ ...c, offset: 0, columnIndex: 1 })
    const out = apply(c.doc, r, 'delete col CRLF')
    assert.equal(out, D(['| a | c |', '| :--- | ---: |', '| d | f |'], '\r\n'))
    assert.equal(/(?<!\r)\n/.test(out), false)
  }
  // (e) The ONLY column: named refusal.
  {
    const text = D(['| a |', '| --- |', '| b |'])
    const c = ctx(text)
    const r = deleteTableColumn({ ...c, offset: 0, columnIndex: 0 })
    assert.equal(r.ok, false)
    assert.equal(r.code, TABLE_OP_CODES.LAST_COLUMN)
  }
  // (f) Out of range.
  {
    const c = ctx(wide())
    const r = deleteTableColumn({ ...c, offset: 0, columnIndex: 3 })
    assert.equal(r.ok, false)
    assert.equal(r.code, TABLE_OP_CODES.UNSUPPORTED)
  }
}

// ===========================================================================
// 5. setTableColumnAlignment — the delimiter cell's `:---`/`:---:`/`---:`
//    spellings, dash count preserved.
// ===========================================================================
{
  // (a) null -> each direction.
  const cases = [
    ['left', '| :--- | ---: |', ['left', 'right']],
    ['center', '| :---: | ---: |', ['center', 'right']],
    ['right', '| ---: | ---: |', ['right', 'right']]
  ]
  for (const [alignment, delim, align] of cases) {
    const text = baseText()
    const c = ctx(text)
    const r = setTableColumnAlignment({ ...c, offset: tableAt(text), columnIndex: 0, alignment })
    const out = apply(c.doc, r, `align ${alignment}`)
    assert.equal(out, D(['前文', '', '| a | b |', delim, '| c | d |', '', '后文']))
    assert.deepEqual(tableShape(out).align, align)
    assert.equal(r.transaction.edits.length, 1, 'alignment rewrites only the delimiter cell')
    // Caret in the column's header cell.
    assert.equal(out[r.transaction.selection.anchor], 'a')
  }
  // (b) Changing an existing alignment (right -> center), CRLF.
  {
    const text = baseText('\r\n')
    const c = ctx(text)
    const r = setTableColumnAlignment({ ...c, offset: tableAt(text), columnIndex: 1, alignment: 'center' })
    const out = apply(c.doc, r, 'align right->center CRLF')
    assert.equal(out, D(['前文', '', '| a | b |', '| --- | :---: |', '| c | d |', '', '后文'], '\r\n'))
    assert.deepEqual(tableShape(out).align, [null, 'center'])
  }
  // (c) Dash count preserved: a five-dash spec keeps five dashes.
  {
    const text = D(['| a | b |', '| ----- | --- |', '| c | d |'])
    const c = ctx(text)
    const r = setTableColumnAlignment({ ...c, offset: 0, columnIndex: 0, alignment: 'center' })
    const out = apply(c.doc, r, 'align dash count')
    assert.equal(out, D(['| a | b |', '| :-----: | --- |', '| c | d |']))
  }
  // (d) Noop: the column already has that alignment — ok, no transaction.
  {
    const text = baseText()
    const c = ctx(text)
    const r = setTableColumnAlignment({ ...c, offset: tableAt(text), columnIndex: 1, alignment: 'right' })
    assert.equal(r.ok, true, r.code)
    assert.equal(r.noop, true, 'same alignment is a noop')
    assert.equal(r.transaction, undefined, 'a noop carries no transaction')
    assert.equal(c.doc.text, text, 'noop leaves the document untouched')
  }
  // (e) Invalid alignment values.
  for (const alignment of ['justify', null, undefined, '']) {
    const text = baseText()
    const c = ctx(text)
    const r = setTableColumnAlignment({ ...c, offset: tableAt(text), columnIndex: 0, alignment })
    assert.equal(r.ok, false, `alignment ${String(alignment)} must refuse`)
    assert.equal(r.code, TABLE_OP_CODES.UNSUPPORTED)
  }
}

// ===========================================================================
// 6. QUOTED tables (`> | a |`): every written line carries the quote prefix,
//    the quote survives the reparse, siblings outside the table are untouched.
// ===========================================================================
{
  const QUOTED = ['> 引言', '>', '> | a | b |', '> | --- | --- |', '> | c | d |', '', '尾段']
  const quotedText = (eol = '\n') => D(QUOTED, eol)
  const quotedOffset = (text) => text.indexOf('| a | b |')

  // (a) Add a row.
  for (const eol of ['\n', '\r\n']) {
    const text = quotedText(eol)
    const c = ctx(text)
    const r = insertTableRow({ ...c, offset: quotedOffset(text), rowIndex: 1 })
    const expected = D(['> 引言', '>', '> | a | b |', '> | --- | --- |', '> |  |  |', '> | c | d |', '', '尾段'], eol)
    const out = apply(c.doc, r, `quoted row (${JSON.stringify(eol)})`)
    assert.equal(out, expected)
    const tree = parseKernelMarkdown(out)
    assert.equal(tree.children[0].type, 'blockquote', 'quote survives')
    assert.deepEqual(tableShape(out).rows, [['a', 'b'], ['', ''], ['c', 'd']])
    const anchor = r.transaction.selection.anchor
    assert.equal(expected.slice(anchor - 2, anchor + 2), '|  |', 'caret in the new quoted cell')
  }
  // (b) Add a column.
  {
    const text = quotedText()
    const c = ctx(text)
    const r = insertTableColumn({ ...c, offset: quotedOffset(text), columnIndex: 2 })
    const out = apply(c.doc, r, 'quoted col append')
    assert.equal(out, D(['> 引言', '>', '> | a | b |  |', '> | --- | --- | --- |', '> | c | d |  |', '', '尾段']))
    assert.deepEqual(tableShape(out).rows, [['a', 'b', ''], ['c', 'd', '']])
  }
  // (c) Delete a row (needs two body rows first).
  {
    const text = D(['> | a | b |', '> | --- | --- |', '> | c | d |', '> | e | f |'])
    const c = ctx(text)
    const r = deleteTableRow({ ...c, offset: 2, rowIndex: 1 })
    const out = apply(c.doc, r, 'quoted row delete')
    assert.equal(out, D(['> | a | b |', '> | --- | --- |', '> | e | f |']))
  }
  // (d) Delete a column.
  {
    const text = quotedText()
    const c = ctx(text)
    const r = deleteTableColumn({ ...c, offset: quotedOffset(text), columnIndex: 0 })
    const out = apply(c.doc, r, 'quoted col delete')
    assert.equal(out, D(['> 引言', '>', '> | b |', '> | --- |', '> | d |', '', '尾段']))
  }
  // (e) Alignment.
  {
    const text = quotedText()
    const c = ctx(text)
    const r = setTableColumnAlignment({ ...c, offset: quotedOffset(text), columnIndex: 1, alignment: 'center' })
    const out = apply(c.doc, r, 'quoted align')
    assert.equal(out, D(['> 引言', '>', '> | a | b |', '> | --- | :---: |', '> | c | d |', '', '尾段']))
    assert.deepEqual(tableShape(out).align, [null, 'center'])
  }
  // (f) Nested quote (`> >`).
  {
    const text = D(['> > | a | b |', '> > | --- | --- |', '> > | c | d |'])
    const c = ctx(text)
    const r = insertTableRow({ ...c, offset: 4, rowIndex: 2 })
    const out = apply(c.doc, r, 'nested quote row')
    assert.equal(out, D(['> > | a | b |', '> > | --- | --- |', '> > | c | d |', '> > |  |  |']))
    assert.deepEqual(tableShape(out).rows, [['a', 'b'], ['c', 'd'], ['', '']])
  }
}

// ===========================================================================
// 7. ESCAPED PIPES. `\|` is cell CONTENT, never a boundary: ops around such a
//    cell must preserve it byte-for-byte, ops on its own column must respect
//    the parser's boundaries, and a row whose final pipe is escaped is NOT
//    pipe-closed (refused rather than split).
// ===========================================================================
{
  const esc = () => D(['| a \\| x | b |', '| --- | --- |', '| c | d |'])
  // (a) Add a row below — the escaped cell is untouched.
  {
    const c = ctx(esc())
    const r = insertTableRow({ ...c, offset: 0, rowIndex: 1 })
    const out = apply(c.doc, r, 'escaped: add row')
    assert.equal(out, D(['| a \\| x | b |', '| --- | --- |', '|  |  |', '| c | d |']))
    assert.deepEqual(tableShape(out).rows[0], ['a | x', 'b'], 'decoded pipe content preserved')
  }
  // (b) Insert a column BEFORE the column after the escaped cell: the cell
  //     boundary is the parser's, not a naive pipe split.
  {
    const c = ctx(esc())
    const r = insertTableColumn({ ...c, offset: 0, columnIndex: 1 })
    const out = apply(c.doc, r, 'escaped: add col')
    assert.equal(out, D(['| a \\| x |  | b |', '| --- | --- | --- |', '| c |  | d |']))
    assert.deepEqual(tableShape(out).rows[0], ['a | x', '', 'b'])
  }
  // (c) Delete the escaped cell's own column.
  {
    const c = ctx(esc())
    const r = deleteTableColumn({ ...c, offset: 0, columnIndex: 0 })
    const out = apply(c.doc, r, 'escaped: delete its col')
    assert.equal(out, D(['| b |', '| --- |', '| d |']))
  }
  // (d) `\\|` (escaped backslash, REAL pipe boundary) still splits — the
  //     parity rule, probed against the parser itself.
  {
    const text = D(['| a \\\\| b |', '| --- | --- |', '| x | y |'])
    const c = ctx(text)
    const r = deleteTableColumn({ ...c, offset: 0, columnIndex: 1 })
    const out = apply(c.doc, r, 'parity: delete col 1')
    assert.equal(out, D(['| a \\\\|', '| --- |', '| x |']))
    assert.deepEqual(tableShape(out).rows, [['a \\'], ['x']])
  }
  // (e) A row whose last pipe is ESCAPED is not pipe-closed: refuse.
  {
    const text = D(['| a \\|', '| --- |', '| c |'])
    const c = ctx(text)
    const r = insertTableRow({ ...c, offset: 0, rowIndex: 1 })
    assert.equal(r.ok, false, 'escaped closing pipe must refuse')
    assert.equal(r.code, TABLE_OP_CODES.UNSUPPORTED)
  }
}

// ===========================================================================
// 8. UNTOUCHED-CELL BYTE FIDELITY on unconventional padding: `|a|b|` (none)
//    and `|  a   |` (asymmetric) survive every op byte-for-byte.
// ===========================================================================
{
  const tight = () => D(['|a|b|', '|-|-|', '|c|d|'])
  {
    const c = ctx(tight())
    const r = insertTableRow({ ...c, offset: 0, rowIndex: 2 })
    assert.equal(apply(c.doc, r, 'tight: add row'), D(['|a|b|', '|-|-|', '|c|d|', '|  |  |']))
  }
  {
    const c = ctx(tight())
    const r = deleteTableColumn({ ...c, offset: 0, columnIndex: 0 })
    assert.equal(apply(c.doc, r, 'tight: delete col'), D(['|b|', '|-|', '|d|']))
  }
  {
    const text = D(['|  a   | b |', '| --- | --- |', '| c | d |'])
    const c = ctx(text)
    const r = insertTableColumn({ ...c, offset: 0, columnIndex: 2 })
    assert.equal(apply(c.doc, r, 'padded: add col'),
      D(['|  a   | b |  |', '| --- | --- | --- |', '| c | d |  |']))
  }
  // Row-trailing whitespace survives (after the last pipe).
  {
    const text = '| a | b |  \n| --- | --- |\n| c | d |\n'
    const c = ctx(text)
    const r = insertTableRow({ ...c, offset: 0, rowIndex: 1 })
    assert.equal(apply(c.doc, r, 'trailing ws: add row'),
      '| a | b |  \n| --- | --- |\n|  |  |\n| c | d |\n')
  }
}

// ===========================================================================
// 9. GENERIC REFUSALS — every unprovable shape refuses with a NAMED code and
//    no transaction.
// ===========================================================================
{
  const refuse = (label, text, op, code = TABLE_OP_CODES.UNSUPPORTED) => {
    const c = ctx(text)
    const r = op(c)
    assert.equal(r.ok, false, `${label} must refuse`)
    assert.equal(r.code, code, `${label} code (got ${r.code})`)
    assert.equal(r.transaction, undefined, `${label} carries no transaction`)
    assert.equal(c.doc.text, text, `${label} must not mutate`)
  }

  // Not a table at all.
  refuse('paragraph offset', '甲乙\n', (c) => insertTableRow({ ...c, offset: 0, rowIndex: 1 }))
  // A table inside a LIST item: the walk stops at the list (fail-closed).
  refuse('list-nested table',
    '- | a | b |\n  | --- | --- |\n  | c | d |\n',
    (c) => insertTableRow({ ...c, offset: 2, rowIndex: 1 }))
  // Ragged body row (extra cell) — width disagrees with the delimiter.
  refuse('ragged extra cell',
    D(['| a | b |', '| --- | --- |', '| c | d | e |']),
    (c) => insertTableRow({ ...c, offset: 0, rowIndex: 1 }))
  // Ragged body row (missing cell).
  refuse('ragged missing cell',
    D(['| a | b |', '| --- | --- |', '| c |']),
    (c) => insertTableRow({ ...c, offset: 0, rowIndex: 1 }))
  // Rows without a closing pipe.
  refuse('unclosed rows',
    D(['| a | b', '| --- | ---', '| c | d']),
    (c) => insertTableColumn({ ...c, offset: 0, columnIndex: 0 }))
  // Mixed line prefixes (indentation varies between rows).
  refuse('mixed indentation',
    D(['  | a | b |', '| --- | --- |', '  | c | d |']),
    (c) => insertTableRow({ ...c, offset: 4, rowIndex: 1 }))
  // A paragraph line directly below a table is ABSORBED by the parser as a
  // ragged pipe-less row (the block-insert.js header's probe) — width
  // disagrees, so every op on that table refuses instead of guessing where
  // the table "really" ends.
  refuse('trailing prose absorbed as a ragged row',
    D(['| a | b |', '| --- | --- |', '| c | d |', '后面']),
    (c) => insertTableRow({ ...c, offset: 0, rowIndex: 1 }))
}

// ===========================================================================
// 10. Contract: commands never mutate their inputs, and their transactions
//     are one-shot (stale-revision on replay).
// ===========================================================================
{
  const text = baseText()
  const c = ctx(text)
  const before = c.doc.text
  const revision = c.doc.revision
  insertTableRow({ ...c, offset: tableAt(text), rowIndex: 1 })
  assert.equal(c.doc.text, before)
  assert.equal(c.doc.revision, revision)
}
{
  const text = baseText()
  const c = ctx(text)
  const first = insertTableRow({ ...c, offset: tableAt(text), rowIndex: 1 })
  assert.equal(first.transaction.baseRevision, c.doc.revision)
  const applied = applySourceTransaction(c.doc, first.transaction).doc
  const replay = applySourceTransaction(applied, first.transaction)
  assert.equal(replay.ok, false, 'replaying a spent table op must be refused')
  assert.equal(replay.code, 'stale-revision')
}

console.log('ok - source kernel table-ops')
