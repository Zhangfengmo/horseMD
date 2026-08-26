// TDD evidence + regression lock for src/renderer/src/lib/source-kernel/
// table-map.js (source-kernel Plan 5 Task 4: GFM table CELL TEXT editing).
//
// Everything asserted below was derived by running the real kernel chain
// (buildSyntaxIndex, i.e. remark-parse + remark-gfm + remark-math + the
// highlight injector) against each fixture and reading the resulting mdast
// positions — never guessed. The probe output that produced these numbers is
// reproduced inline per case as `raw=` slices.
//
// The PM side is a hand-built schema mirroring @milkdown/preset-gfm's real
// table nodes (node_modules/@milkdown/preset-gfm/lib/index.js:88-280):
//   table              content "table_header_row table_row+"
//   table_header_row   content "(table_header)*"
//   table_row          content "(table_cell)*"
//   table_header/table_cell   `cellContent: 'paragraph'` — both parseMarkdown
//                             runners openNode(type).openNode(paragraph)
//   paragraph          content "inline*"
// i.e. the 4 container levels this module zips against mdast's 3.
import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { buildSyntaxIndex } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { buildTableCellMaps } from '../src/renderer/src/lib/source-kernel/table-map.js'
import { replaceVisibleText } from '../src/renderer/src/lib/source-kernel/commands/replace-text.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    // `(table_header_row | table_row)+` rather than preset-gfm's own
    // `table_header_row table_row+` so this file can also BUILD the
    // header-less / body-less shapes it needs to pin as refusals. Node
    // construction via `schema.node` does not content-check either way (only
    // `createChecked` does), so this only affects readability.
    table: { content: '(table_header_row | table_row)+', group: 'block' },
    table_header_row: { content: '(table_header)*' },
    table_row: { content: '(table_cell)*' },
    table_header: { content: 'paragraph+', attrs: { alignment: { default: 'left' } } },
    table_cell: { content: 'paragraph+', attrs: { alignment: { default: 'left' } } },
    image: { group: 'inline', inline: true, atom: true, attrs: { src: { default: '' } } },
    math_inline: { group: 'inline', inline: true, atom: true, attrs: { value: { default: '' } } },
    html: { group: 'inline', inline: true, atom: true, attrs: { value: { default: '' } } },
    hardbreak: { group: 'inline', inline: true, atom: true },
    text: { group: 'inline' }
  },
  marks: {
    strong: {},
    emphasis: {},
    inlineCode: {},
    highlight: { attrs: { color: { default: 'yellow' } } }
  }
})

const text = (s, ...marks) => schema.text(s, marks.map((m) => schema.marks[m].create()))
const p = (...c) => schema.node('paragraph', null, c)
const doc = (...c) => schema.node('doc', null, c)

// rows: array of rows; each row an array of cell inline-content arrays.
const tableNode = (rows) => schema.node('table', null, rows.map((cells, rowIndex) =>
  schema.node(rowIndex === 0 ? 'table_header_row' : 'table_row', null,
    cells.map((content) =>
      schema.node(rowIndex === 0 ? 'table_header' : 'table_cell', null, [p(...content)])))))

const mdTableOf = (markdown) => {
  const index = buildSyntaxIndex(markdown)
  const found = index.tree.children.find((node) => node.type === 'table')
  return found || null
}

// The mdast table nested inside the first block (blockquote / list item).
const nestedTable = (markdown) => {
  const index = buildSyntaxIndex(markdown)
  let found = null
  const walk = (node) => {
    if (found) return
    if (node.type === 'table') {
      found = node
      return
    }
    for (const child of node.children || []) walk(child)
  }
  walk(index.tree)
  return found
}

// Byte-exact description of one cell's units: [rawSlice, kind] per unit plus
// the full visible->raw boundary table. Everything a caller could resolve.
const unitTrace = (markdown, charMap) => charMap.units.map((u) => [
  markdown.slice(u.rawStart, u.rawEnd), u.kind, u.width
])
const boundaries = (charMap) => {
  const out = []
  for (let v = 0; v <= charMap.visibleLength; v += 1) out.push(charMap.visibleToRaw(v))
  return out
}

console.log('--- source kernel table map ---')

// ---------------------------------------------------------------------------
// Case 1: the canonical 2x2 table. Probed mdast (raw slices verbatim):
//   table [0,33)  rows [0,9) and [24,33)
//     cell [0,4)  '| a '   text [2,3) 'a'
//     cell [4,9)  '| b |'  text [6,7) 'b'
//     cell [24,28)'| c '   text [26,27) 'c'
//     cell [28,33)'| d |'  text [30,31) 'd'
// So each cell's ONE content unit is a single char, and the `|` + padding
// bytes around it belong to no unit at all (gap bytes).
// ---------------------------------------------------------------------------
{
  const md = '| a | b |\n| --- | --- |\n| c | d |\n'
  const pm = tableNode([[[text('a')], [text('b')]], [[text('c')], [text('d')]]])
  const result = buildTableCellMaps(md, mdTableOf(md), pm, 0)
  assert.ok(result, 'canonical table must zip')
  assert.equal(result.width, 2)
  assert.equal(result.cells.length, 4)
  // The delimiter row is recovered from the bytes (it has no mdast node).
  assert.equal(md.slice(result.delimiter.start, result.delimiter.end), '| --- | --- |')
  assert.deepEqual(result.cells.map((c) => [c.row, c.column]), [[0, 0], [0, 1], [1, 0], [1, 1]])
  assert.deepEqual(result.cells.map((c) => unitTrace(md, c.charMap)), [
    [['a', 'char', 1]], [['b', 'char', 1]], [['c', 'char', 1]], [['d', 'char', 1]]
  ])
  assert.deepEqual(result.cells.map((c) => boundaries(c.charMap)), [
    [2, 3], [6, 7], [26, 27], [30, 31]
  ])
  // content.size === visibleLength for every cell (the identity the
  // projection map requires).
  for (const cell of result.cells) {
    assert.equal(cell.pmNode.content.size, cell.charMap.visibleLength)
    assert.equal(cell.tableCell, true)
  }
  // PM positions: doc content starts at 0; table@0, so its rows start at 1.
  // A one-char cell's paragraph is nodeSize 3, its cell nodeSize 5, a
  // two-cell row nodeSize 12 -> header row [1,13), body row [13,25).
  //   header  cell0 @2  paragraph @3   cell1 @7  paragraph @8
  //   body    cell0 @14 paragraph @15  cell1 @19 paragraph @20
  assert.deepEqual(result.cells.map((c) => c.pmPos), [3, 8, 15, 20])
  const resolved = result.cells.map((c) => doc(pm).resolve(c.pmPos + 1))
  assert.deepEqual(resolved.map(($p) => $p.parent.type.name),
    ['paragraph', 'paragraph', 'paragraph', 'paragraph'])
  assert.deepEqual(resolved.map(($p) => $p.parent.textContent), ['a', 'b', 'c', 'd'])
}

// ---------------------------------------------------------------------------
// Case 2: alignment + padding variety. The alignment attr lives on the PM cell
// and the `align` array on the mdast table; NEITHER is writable in this phase,
// but the delimiter column count must AGREE with both.
// Probed: '|   a   |b|\n|---|---|\n|c|   d   |'
//   cell [0,8)  '|   a   ' text [4,5)
//   cell [8,11) '|b|'      text [9,10)
//   cell [22,24)'|c'       text [23,24)
//   cell [24,33)'|   d   |' text [28,29)
// ---------------------------------------------------------------------------
{
  const md = '|   a   |b|\n|---|---|\n|c|   d   |\n'
  const result = buildTableCellMaps(md, mdTableOf(md),
    tableNode([[[text('a')], [text('b')]], [[text('c')], [text('d')]]]), 0)
  assert.ok(result, 'padding variety must zip')
  assert.deepEqual(result.cells.map((c) => boundaries(c.charMap)),
    [[4, 5], [9, 10], [23, 24], [28, 29]])
  // The padding is GAP: nothing maps into it, exactly like a `**` marker run.
  assert.equal(md.slice(4, 5), 'a')
  assert.equal(md.slice(1, 4), '   ')
}

{
  const md = '| a | b | c |\n| :-- | :-: | --: |\n| d | e | f |\n'
  const result = buildTableCellMaps(md, mdTableOf(md), tableNode([
    [[text('a')], [text('b')], [text('c')]],
    [[text('d')], [text('e')], [text('f')]]
  ]), 0)
  assert.ok(result, 'aligned table must zip')
  assert.equal(result.width, 3)
  assert.equal(md.slice(result.delimiter.start, result.delimiter.end), '| :-- | :-: | --: |')
  assert.deepEqual(result.cells.map((c) => boundaries(c.charMap)),
    [[2, 3], [6, 7], [10, 11], [36, 37], [40, 41], [44, 45]])
}

// ---------------------------------------------------------------------------
// Case 3: a table written WITHOUT outer pipes. The first cell of each row has
// no leading `|` at all, so the content region logic must not blindly skip a
// byte. Probed 'a | b\n--- | ---\nc | d':
//   cell [0,2) 'a '  text [0,1)
//   cell [2,5) '| b' text [4,5)
//   cell [16,18) 'c ' text [16,17)
//   cell [18,21) '| d' text [20,21)
// ---------------------------------------------------------------------------
{
  const md = 'a | b\n--- | ---\nc | d\n'
  const result = buildTableCellMaps(md, mdTableOf(md),
    tableNode([[[text('a')], [text('b')]], [[text('c')], [text('d')]]]), 0)
  assert.ok(result, 'pipe-less table must zip')
  assert.equal(md.slice(result.delimiter.start, result.delimiter.end), '--- | ---')
  assert.deepEqual(result.cells.map((c) => boundaries(c.charMap)),
    [[0, 1], [4, 5], [16, 17], [20, 21]])
}

// ---------------------------------------------------------------------------
// Case 4: multi-character cells + a CRLF table. Line endings only ever sit
// BETWEEN rows, so no cell unit ever spans one; the cells' bytes are identical
// to the LF version, only shifted.
// Probed '| ab | cd |\r\n| --- | --- |\r\n| ef | gh |':
//   cells [0,5) [5,11) [28,33) [33,39)  texts [2,4) [7,9) [30,32) [35,37)
// ---------------------------------------------------------------------------
{
  const md = '| ab | cd |\r\n| --- | --- |\r\n| ef | gh |\r\n'
  const result = buildTableCellMaps(md, mdTableOf(md),
    tableNode([[[text('ab')], [text('cd')]], [[text('ef')], [text('gh')]]]), 0)
  assert.ok(result, 'CRLF table must zip')
  assert.equal(md.slice(result.delimiter.start, result.delimiter.end), '| --- | --- |')
  assert.deepEqual(result.cells.map((c) => boundaries(c.charMap)),
    [[2, 3, 4], [7, 8, 9], [30, 31, 32], [35, 36, 37]])
  for (const cell of result.cells) {
    assert.equal(cell.pmNode.content.size, cell.charMap.visibleLength)
  }
}

// ---------------------------------------------------------------------------
// Case 5: a table inside a blockquote, and one inside a list item. The per-row
// block prefix ('> ' / '  ') sits BEFORE every row's own start offset, so it
// is never inside a cell — and the delimiter-row recovery has to strip it
// before recognizing the line.
// Probed '> | a | b |\n> | --- | --- |\n> | c | d |':
//   table [2,39); cells [2,6) [6,11) [30,34) [34,39); texts [4,5) [8,9)
//   [32,33) [36,37)
// ---------------------------------------------------------------------------
{
  const md = '> | a | b |\n> | --- | --- |\n> | c | d |\n'
  const result = buildTableCellMaps(md, nestedTable(md),
    tableNode([[[text('a')], [text('b')]], [[text('c')], [text('d')]]]), 0)
  assert.ok(result, 'quoted table must zip')
  assert.equal(md.slice(result.delimiter.start, result.delimiter.end), '> | --- | --- |')
  assert.deepEqual(result.cells.map((c) => boundaries(c.charMap)),
    [[4, 5], [8, 9], [32, 33], [36, 37]])
}
{
  const md = '- | a | b |\n  | --- | --- |\n  | c | d |\n'
  const result = buildTableCellMaps(md, nestedTable(md),
    tableNode([[[text('a')], [text('b')]], [[text('c')], [text('d')]]]), 0)
  assert.ok(result, 'list-indented table must zip')
  assert.equal(md.slice(result.delimiter.start, result.delimiter.end), '  | --- | --- |')
  assert.deepEqual(result.cells.map((c) => boundaries(c.charMap)),
    [[4, 5], [8, 9], [32, 33], [36, 37]])
}

// ---------------------------------------------------------------------------
// Case 6: empty cells. mdast gives a childless `tableCell` whose own
// `position.start` is the LEADING PIPE — serving that as a content anchor
// would write OUTSIDE the cell. table-map.js derives the anchor from the
// padding bytes instead.
// Probed '| a |  |\n| --- | --- |\n|  | d |':
//   cell [4,8) '|  |' (no children); cell [23,26) '|  ' (no children)
// ---------------------------------------------------------------------------
{
  const md = '| a |  |\n| --- | --- |\n|  | d |\n'
  const result = buildTableCellMaps(md, mdTableOf(md),
    tableNode([[[text('a')], []], [[], [text('d')]]]), 0)
  assert.ok(result, 'table with empty cells must zip')
  const [a, empty1, empty2, d] = result.cells
  assert.deepEqual(boundaries(a.charMap), [2, 3])
  assert.deepEqual(boundaries(d.charMap), [28, 29])
  // '|  |' — region [5,7); anchor = one space in, so an insert produces the
  // canonical '| x |'.
  assert.equal(empty1.charMap.visibleLength, 0)
  assert.equal(empty1.charMap.visibleToRaw(0), 6)
  assert.equal(empty1.charMap.visibleToRaw(1), null)
  assert.deepEqual(empty1.charMap.rawRangeForVisibleRange(0, 0), { from: 6, to: 6 })
  assert.equal(md.slice(0, 6) + 'x' + md.slice(6), '| a | x |\n| --- | --- |\n|  | d |\n')
  // '|  ' (a MIDDLE cell — no trailing pipe) — region [24,26).
  assert.equal(empty2.charMap.visibleToRaw(0), 25)
  assert.equal(md.slice(0, 25) + 'y' + md.slice(25), '| a |  |\n| --- | --- |\n| y | d |\n')
  for (const cell of result.cells) {
    assert.equal(cell.pmNode.content.size, cell.charMap.visibleLength)
  }
}
{
  // Zero-padding empty cell: '||' leaves the anchor right after the pipe.
  const md = '|a||\n|---|---|\n|c|d|\n'
  const result = buildTableCellMaps(md, mdTableOf(md),
    tableNode([[[text('a')], []], [[text('c')], [text('d')]]]), 0)
  assert.ok(result, 'zero-padding empty cell must zip')
  assert.equal(result.cells[1].charMap.visibleToRaw(0), 3)
  assert.equal(md.slice(0, 3) + 'b' + md.slice(3), '|a|b|\n|---|---|\n|c|d|\n')
}

// ---------------------------------------------------------------------------
// Case 6b (review finding, 2026-08-17): ROW-TRAILING whitespace. An mdast
// last-cell `position` runs to the end of the ROW, so a stray space after the
// closing `|` lands INSIDE the cell's own raw span:
//   '| a | b |   \n…' -> tableRow [0,12), cells [0,4) '| a ' and
//                        [4,12) '| b |   '  (probed)
// Locating the closing pipe by `text[end - 1]` alone therefore left it inside
// the content region and the padding proof refused the cell — a read-only
// cell caused by nothing but trailing whitespace.
// ---------------------------------------------------------------------------
{
  const md = '| a | b |   \n| --- | --- |\n| c | d |\n'
  const result = buildTableCellMaps(md, mdTableOf(md),
    tableNode([[[text('a')], [text('b')]], [[text('c')], [text('d')]]]), 0)
  assert.ok(result, 'row-trailing whitespace must still zip')
  assert.ok(result.cells.every((c) => c.charMap), 'every cell stays EDITABLE')
  assert.deepEqual(result.cells.map((c) => boundaries(c.charMap)),
    [[2, 3], [6, 7], [29, 30], [33, 34]])
}
{
  // A trailing TAB, and trailing whitespace on a BODY row's last cell.
  const md = '| a | b |\t\n| --- | --- |\n| c | d |  \n'
  const result = buildTableCellMaps(md, mdTableOf(md),
    tableNode([[[text('a')], [text('b')]], [[text('c')], [text('d')]]]), 0)
  assert.ok(result, 'trailing tab / body-row trailing whitespace must still zip')
  assert.ok(result.cells.every((c) => c.charMap))
  assert.deepEqual(result.cells.map((c) => boundaries(c.charMap)),
    [[2, 3], [6, 7], [27, 28], [31, 32]])
}
{
  // A row with NO closing pipe but trailing whitespace: `to` must stay at the
  // cell's end (there is no pipe to pull it in from), which is what keeps the
  // padding proof and the empty-cell anchor rule unchanged.
  const md = '| a | b   \n| --- | --- |\n| c | d |\n'
  const result = buildTableCellMaps(md, mdTableOf(md),
    tableNode([[[text('a')], [text('b')]], [[text('c')], [text('d')]]]), 0)
  assert.ok(result, 'pipe-less row with trailing whitespace must still zip')
  assert.ok(result.cells.every((c) => c.charMap))
  assert.deepEqual(boundaries(result.cells[1].charMap), [6, 7])
}
{
  // CRLF + row-trailing whitespace (both review shapes at once).
  const md = '| a | b |  \r\n| --- | --- |\r\n| c | d |\r\n'
  const result = buildTableCellMaps(md, mdTableOf(md),
    tableNode([[[text('a')], [text('b')]], [[text('c')], [text('d')]]]), 0)
  assert.ok(result, 'CRLF row-trailing whitespace must still zip')
  assert.ok(result.cells.every((c) => c.charMap))
  assert.deepEqual(result.cells.map((c) => boundaries(c.charMap)),
    [[2, 3], [6, 7], [30, 31], [34, 35]])
}

// ---------------------------------------------------------------------------
// Case 6c (review finding, 2026-08-17): DELIMITER-ROW trailing whitespace.
// Same class as 6b with a much bigger blast radius — `DELIMITER_RE` anchored
// `\|?$` with no trailing `[ \t]*`, so one stray space degraded the WHOLE
// table. Every block-prefix flavour is covered because the recovery strips
// `[ \t>]*` before matching.
// ---------------------------------------------------------------------------
{
  const md = '| a | b |\n| --- | --- |   \n| c | d |\n'
  const result = buildTableCellMaps(md, mdTableOf(md),
    tableNode([[[text('a')], [text('b')]], [[text('c')], [text('d')]]]), 0)
  assert.ok(result, 'delimiter-row trailing whitespace must still zip')
  assert.equal(md.slice(result.delimiter.start, result.delimiter.end), '| --- | --- |   ')
  assert.equal(result.width, 2)
  assert.ok(result.cells.every((c) => c.charMap), 'every cell stays EDITABLE')
  assert.deepEqual(result.cells.map((c) => boundaries(c.charMap)),
    [[2, 3], [6, 7], [29, 30], [33, 34]])
}
{
  // …and inside a blockquote, where the line also carries a '> ' prefix.
  const md = '> | a | b |\n> | --- | --- |\t\n> | c | d |\n'
  const result = buildTableCellMaps(md, nestedTable(md),
    tableNode([[[text('a')], [text('b')]], [[text('c')], [text('d')]]]), 0)
  assert.ok(result, 'quoted delimiter row with a trailing tab must still zip')
  assert.equal(md.slice(result.delimiter.start, result.delimiter.end), '> | --- | --- |\t')
  assert.ok(result.cells.every((c) => c.charMap))
}
{
  // Negative control: a line that is NOT a delimiter row still degrades the
  // whole table (the trailing-whitespace tolerance must not loosen the shape
  // check itself). Here the mdast table's own bytes are re-checked against a
  // hand-made node whose header row claims a delimiter line that isn't one.
  const md = '| a | b |\n| --- | --- |\n| c | d |\n'
  const table = mdTableOf(md)
  const forged = {
    ...table,
    children: [table.children[0]],
    position: { start: { offset: 0 }, end: { offset: 9 } }
  }
  assert.equal(buildTableCellMaps(md, forged, tableNode([[[text('a')], [text('b')]]]), 0), null,
    'a delimiter row outside the table span must still refuse')
}

// ---------------------------------------------------------------------------
// Case 7: rich inline content inside a cell — inline code, inline math, an
// image, a highlight, emphasis. All of these go through exactly the same unit
// machinery a paragraph uses (buildCharacterMap), so they stay editable and
// their marker bytes are gaps.
// ---------------------------------------------------------------------------
{
  // Probed '| `x` | c |': cell [0,6) '| `x` ', inlineCode [2,5) value 'x'.
  const md = '| `x` | c |\n| --- | --- |\n| d | e |\n'
  const result = buildTableCellMaps(md, mdTableOf(md),
    tableNode([[[text('x', 'inlineCode')], [text('c')]], [[text('d')], [text('e')]]]), 0)
  assert.ok(result, 'inline-code cell must zip')
  assert.deepEqual(unitTrace(md, result.cells[0].charMap), [['x', 'char', 1]])
  assert.deepEqual(boundaries(result.cells[0].charMap), [3, 4])
  assert.equal(result.cells[0].pmNode.content.size, 1)
}
{
  // Probed '| $x$ | c |': cell [0,6), inlineMath [2,5) — one width-1 ATOM.
  const md = '| $x$ | c |\n| --- | --- |\n| d | e |\n'
  const result = buildTableCellMaps(md, mdTableOf(md), tableNode([
    [[schema.node('math_inline', { value: 'x' })], [text('c')]],
    [[text('d')], [text('e')]]
  ]), 0)
  assert.ok(result, 'inline-math cell must zip')
  assert.deepEqual(unitTrace(md, result.cells[0].charMap), [['$x$', 'atom', 1]])
  assert.equal(result.cells[0].pmNode.content.size, 1)
}
{
  // Probed '| ![x](y.png) | c |': cell [0,14), image [2,13) — one atom.
  const md = '| ![x](y.png) | c |\n| --- | --- |\n| d | e |\n'
  const result = buildTableCellMaps(md, mdTableOf(md), tableNode([
    [[schema.node('image', { src: 'y.png' })], [text('c')]],
    [[text('d')], [text('e')]]
  ]), 0)
  assert.ok(result, 'image cell must zip')
  assert.deepEqual(unitTrace(md, result.cells[0].charMap), [['![x](y.png)', 'atom', 1]])
}
{
  // Probed '| ==h== | c |': cell [0,8), highlight [2,7) wrapping text [4,5).
  // The `==` runs are gap bytes, same as `**`.
  const md = '| ==h== | c |\n| --- | --- |\n| d | e |\n'
  const result = buildTableCellMaps(md, mdTableOf(md), tableNode([
    [[text('h', 'highlight')], [text('c')]], [[text('d')], [text('e')]]
  ]), 0)
  assert.ok(result, 'highlight cell must zip')
  assert.deepEqual(unitTrace(md, result.cells[0].charMap), [['h', 'char', 1]])
  assert.deepEqual(boundaries(result.cells[0].charMap), [4, 5])
}
{
  // Probed '| **b** | *i* |': strong [2,7) > text [4,5); emphasis [10,13) >
  // text [11,12).
  const md = '| **b** | *i* |\n| --- | --- |\n| d | e |\n'
  const result = buildTableCellMaps(md, mdTableOf(md), tableNode([
    [[text('b', 'strong')], [text('i', 'emphasis')]], [[text('d')], [text('e')]]
  ]), 0)
  assert.ok(result, 'marked cell must zip')
  assert.deepEqual(boundaries(result.cells[0].charMap), [4, 5])
  assert.deepEqual(boundaries(result.cells[1].charMap), [11, 12])
  // A plain insert at the mark run's edge lands OUTSIDE the `**` (the shared
  // rawNeutralInsert contract from character-map.js).
  assert.equal(result.cells[0].charMap.rawNeutralInsert(1), 7)
}
{
  // Probed '| a&amp;b | c |': text [2,9) value 'a&b' -> char/entity/char.
  const md = '| a&amp;b | c |\n| --- | --- |\n| d | e |\n'
  const result = buildTableCellMaps(md, mdTableOf(md), tableNode([
    [[text('a&b')], [text('c')]], [[text('d')], [text('e')]]
  ]), 0)
  assert.ok(result, 'entity cell must zip')
  assert.deepEqual(unitTrace(md, result.cells[0].charMap),
    [['a', 'char', 1], ['&amp;', 'entity', 1], ['b', 'char', 1]])
  assert.deepEqual(boundaries(result.cells[0].charMap), [2, 3, 8, 9])
  assert.equal(result.cells[0].pmNode.content.size, 3)
}

// ---------------------------------------------------------------------------
// Case 8: FAIL-CLOSED — per-CELL degradation. The shape is proven for the
// table, so its OTHER cells stay editable; only the unprovable cell loses its
// charMap.
// ---------------------------------------------------------------------------
{
  // `<br>` in a cell: mdast keeps an `html` node, the editor chain rewrites it
  // to a PM `hardbreak` — both count 1, so the map is provable, but stage 4
  // deliberately keeps the shape read-only (the gateway's textblockProfile
  // refuses a non-text inline child anyway).
  const md = '| a<br>b | c |\n| --- | --- |\n| d | e |\n'
  const result = buildTableCellMaps(md, mdTableOf(md), tableNode([
    [[text('a'), schema.node('hardbreak'), text('b')], [text('c')]],
    [[text('d')], [text('e')]]
  ]), 0)
  assert.ok(result, '<br> table still zips structurally')
  assert.equal(result.cells[0].charMap, null, 'the <br> cell degrades')
  assert.ok(result.cells[1].charMap, 'its sibling stays editable')
  assert.ok(result.cells[2].charMap)
  assert.ok(result.cells[3].charMap)
}
{
  // Escaped `\|`: GFM unescapes it into a literal `|` BEFORE inline parsing —
  // a table-specific decode this phase does not own. mdast text value is
  // 'a|b' over raw 'a\|b'.
  const md = '| a\\|b | c |\n| --- | --- |\n| d | e |\n'
  const table = mdTableOf(md)
  assert.equal(table.children[0].children[0].children[0].value, 'a|b',
    'sanity: the parser really does unescape the pipe')
  const result = buildTableCellMaps(md, table, tableNode([
    [[text('a|b')], [text('c')]], [[text('d')], [text('e')]]
  ]), 0)
  assert.ok(result, 'escaped-pipe table still zips structurally')
  assert.equal(result.cells[0].charMap, null, 'the escaped cell degrades')
  assert.ok(result.cells[1].charMap, 'its sibling stays editable')
}
{
  // An unbalanced inline-HTML fragment in a cell: the kernel emits one atom
  // per html node while the editor leaves the same nodes alone, so the shape
  // is provable and stays editable — pinned so a future change to the shared
  // coalescer is noticed here too.
  const md = '| <span>x</span> | c |\n| --- | --- |\n| d | e |\n'
  const result = buildTableCellMaps(md, mdTableOf(md), tableNode([
    [[schema.node('html', { value: '<span>x</span>' })], [text('c')]],
    [[text('d')], [text('e')]]
  ]), 0)
  assert.ok(result, 'inline-html cell table must zip')
  assert.deepEqual(unitTrace(md, result.cells[0].charMap), [['<span>x</span>', 'atom', 1]])
  assert.equal(result.cells[0].pmNode.content.size, 1)
}

// ---------------------------------------------------------------------------
// Case 9: FAIL-CLOSED — whole-TABLE structural refusals. Each returns null, so
// the projection map records the table as one opaque non-editable pair and
// every other block in the document keeps its own map.
// ---------------------------------------------------------------------------
{
  // Ragged row (fewer cells than the delimiter row declares).
  const md = '| a | b |\n| --- | --- |\n| c |\n'
  const result = buildTableCellMaps(md, mdTableOf(md),
    tableNode([[[text('a')], [text('b')]], [[text('c')]]]), 0)
  assert.equal(result, null, 'ragged table must refuse')
}
{
  // Over-wide row (more cells than declared).
  const md = '| a | b |\n| --- | --- |\n| c | d | e |\n'
  const result = buildTableCellMaps(md, mdTableOf(md),
    tableNode([[[text('a')], [text('b')]], [[text('c')], [text('d')], [text('e')]]]), 0)
  assert.equal(result, null, 'over-wide table must refuse')
}
{
  // Header-only markdown table: ProseMirror's `table_header_row table_row+`
  // forces createAndFill to invent an empty body row with no mdast
  // counterpart, so the row counts disagree.
  const md = '| a | b |\n| --- | --- |\n'
  const result = buildTableCellMaps(md, mdTableOf(md),
    tableNode([[[text('a')], [text('b')]], [[], []]]), 0)
  assert.equal(result, null, 'header-only table must refuse')
}
{
  // PM shape this module does not recognize: a body row masquerading as the
  // first row (no `table_header_row`).
  const md = '| a | b |\n| --- | --- |\n| c | d |\n'
  const bodyFirst = schema.node('table', null, [
    schema.node('table_row', null, [
      schema.node('table_cell', null, [p(text('a'))]),
      schema.node('table_cell', null, [p(text('b'))])
    ]),
    schema.node('table_row', null, [
      schema.node('table_cell', null, [p(text('c'))]),
      schema.node('table_cell', null, [p(text('d'))])
    ])
  ])
  assert.equal(buildTableCellMaps(md, mdTableOf(md), bodyFirst, 0), null,
    'a table whose first row is not a header row must refuse')
}
{
  // PM cell holding TWO blocks (not the single-paragraph wrapper).
  const md = '| a | b |\n| --- | --- |\n| c | d |\n'
  const twoBlocks = schema.node('table', null, [
    schema.node('table_header_row', null, [
      schema.node('table_header', null, [p(text('a')), p(text('x'))]),
      schema.node('table_header', null, [p(text('b'))])
    ]),
    schema.node('table_row', null, [
      schema.node('table_cell', null, [p(text('c'))]),
      schema.node('table_cell', null, [p(text('d'))])
    ])
  ])
  assert.equal(buildTableCellMaps(md, mdTableOf(md), twoBlocks, 0), null,
    'a multi-block cell must refuse')
}
{
  // A PM table with more ROWS than the source.
  const md = '| a | b |\n| --- | --- |\n| c | d |\n'
  const extraRow = tableNode([
    [[text('a')], [text('b')]], [[text('c')], [text('d')]], [[text('e')], [text('f')]]
  ])
  assert.equal(buildTableCellMaps(md, mdTableOf(md), extraRow, 0), null,
    'a PM row with no mdast counterpart must refuse')
}
{
  // Bad inputs fail closed rather than throwing.
  const md = '| a | b |\n| --- | --- |\n| c | d |\n'
  const pm = tableNode([[[text('a')], [text('b')]], [[text('c')], [text('d')]]])
  assert.equal(buildTableCellMaps(md, null, pm, 0), null)
  assert.equal(buildTableCellMaps(md, mdTableOf(md), null, 0), null)
  assert.equal(buildTableCellMaps(md, mdTableOf(md), pm, null), null)
  assert.equal(buildTableCellMaps(null, mdTableOf(md), pm, 0), null)
  assert.equal(buildTableCellMaps(md, { type: 'paragraph' }, pm, 0), null)
}

// ---------------------------------------------------------------------------
// Case 10: the delimiter row is never inside a cell's mapped bytes, and it is
// recovered even when the table has no trailing newline.
// ---------------------------------------------------------------------------
{
  const md = '| a | b |\n| --- | --- |\n| c | d |'
  const result = buildTableCellMaps(md, mdTableOf(md),
    tableNode([[[text('a')], [text('b')]], [[text('c')], [text('d')]]]), 0)
  assert.ok(result, 'table without a trailing newline must zip')
  assert.equal(md.slice(result.delimiter.start, result.delimiter.end), '| --- | --- |')
  for (const cell of result.cells) {
    for (const unit of cell.charMap.units) {
      assert.ok(unit.rawEnd <= result.delimiter.start || unit.rawStart >= result.delimiter.end,
        'no cell unit may overlap the delimiter row')
    }
  }
}

// ---------------------------------------------------------------------------
// Case 11: the escape guard is `\|`-SHAPED, not escape-shaped (D2).
//
// The refusal at buildCellCharMap used to be
// `units.some(u => u.kind === 'escape') -> null`, which owned 330 read-only
// blocks = 63.7% of the entire read-only surface across 197 real documents
// (scripts/measure-kernel-readonly-causes.mjs, cause B) — because
// remark-stringify writes `claude\-haiku\-4\.5` and `4\.00` inside cells as a
// matter of routine, and those are ORDINARY CommonMark escapes, byte-identical
// to the ones `buildCharacterMap` already serves in every paragraph.
//
// Only `\|` carries the GFM-table-specific decode (a cell unescapes it into a
// literal `|` BEFORE inline parsing, and it applies even inside a code span,
// where a CommonMark backslash escape does nothing). That one spelling — and
// nothing else — stays refused.
// ---------------------------------------------------------------------------
{
  // NEGATIVE CONTROL 1 — a literal `\|` in a cell's text is STILL read-only.
  // Probed '| a\|b | c |': text [2,6) value 'a|b', units char/escape/char with
  // the escape's raw bytes '\|' at [3,5).
  const md = '| a\\|b | c |\n| --- | --- |\n| d | e |\n'
  const table = mdTableOf(md)
  assert.equal(table.children[0].children[0].children[0].value, 'a|b',
    'sanity: the parser really does unescape the pipe')
  const result = buildTableCellMaps(md, table, tableNode([
    [[text('a|b')], [text('c')]], [[text('d')], [text('e')]]
  ]), 0)
  assert.ok(result, 'escaped-pipe table still zips structurally')
  assert.equal(result.cells[0].charMap, null,
    'NARROWING IS NOT REMOVAL: a `\\|` cell must stay read-only')
  assert.ok(result.cells[1].charMap, 'its sibling stays editable')
  assert.ok(result.cells[2].charMap)
  assert.ok(result.cells[3].charMap)
}
{
  // NEGATIVE CONTROL 2 — the `\|` may be nested inside an inline container
  // (the unit is emitted by the same `textUnits` walk either way). Probed
  // '| **a\|b** | c |': strong [2,10) > text [4,8), units char/escape/char.
  const md = '| **a\\|b** | c |\n| --- | --- |\n| d | e |\n'
  const result = buildTableCellMaps(md, mdTableOf(md), tableNode([
    [[text('a|b', 'strong')], [text('c')]], [[text('d')], [text('e')]]
  ]), 0)
  assert.ok(result, 'nested escaped-pipe table still zips structurally')
  assert.equal(result.cells[0].charMap, null,
    'a `\\|` inside a strong run must stay read-only too')
  assert.ok(result.cells[1].charMap, 'its sibling stays editable')
}
{
  // NEGATIVE CONTROL 3 — a `\|` inside an inline CODE span is where the GFM
  // decode and the CommonMark one genuinely disagree; `inlineCodeUnits`
  // already refuses it (raw content slice '\|' !== value '|'), so the cell has
  // NO charMap at all and never reaches the escape guard. Pinned so the two
  // refusals cannot silently swap places.
  const md = '| `a\\|b` | c |\n| --- | --- |\n| d | e |\n'
  const result = buildTableCellMaps(md, mdTableOf(md), tableNode([
    [[text('a|b', 'inlineCode')], [text('c')]], [[text('d')], [text('e')]]
  ]), 0)
  assert.ok(result, 'code-span escaped-pipe table still zips structurally')
  assert.equal(result.cells[0].charMap, null,
    'a `\\|` inside a code span must stay read-only')
  assert.ok(result.cells[1].charMap)
}
{
  // POSITIVE — the ordinary CommonMark escapes become EDITABLE, with the
  // escape mapped as exactly one width-1 unit spanning both raw bytes.
  // Probed '| a\-b | 4\.00 |\n| --- | --- |\n| c\*d | e\_f |\n':
  //   [0,0] cell [0,7)  '| a\-b '   text [2,6)  units a / \- / b
  //   [0,1] cell [7,16) '| 4\.00 |' text [9,14) units 4 / \. / 0 / 0
  //   [1,0] cell [31,38)'| c\*d '   text [33,37) units c / \* / d
  //   [1,1] cell [38,46)'| e\_f |'  text [40,44) units e / \_ / f
  const md = '| a\\-b | 4\\.00 |\n| --- | --- |\n| c\\*d | e\\_f |\n'
  const result = buildTableCellMaps(md, mdTableOf(md), tableNode([
    [[text('a-b')], [text('4.00')]], [[text('c*d')], [text('e_f')]]
  ]), 0)
  assert.ok(result, 'ordinary-escape table must zip')
  assert.ok(result.cells.every((c) => c.charMap),
    'every ordinary-escape cell must be EDITABLE')
  assert.deepEqual(unitTrace(md, result.cells[0].charMap),
    [['a', 'char', 1], ['\\-', 'escape', 1], ['b', 'char', 1]])
  assert.deepEqual(unitTrace(md, result.cells[1].charMap),
    [['4', 'char', 1], ['\\.', 'escape', 1], ['0', 'char', 1], ['0', 'char', 1]])
  assert.deepEqual(unitTrace(md, result.cells[2].charMap),
    [['c', 'char', 1], ['\\*', 'escape', 1], ['d', 'char', 1]])
  assert.deepEqual(unitTrace(md, result.cells[3].charMap),
    [['e', 'char', 1], ['\\_', 'escape', 1], ['f', 'char', 1]])
  assert.deepEqual(boundaries(result.cells[0].charMap), [2, 3, 5, 6])
  assert.deepEqual(boundaries(result.cells[1].charMap), [9, 10, 12, 13, 14])
  // The visible length the PM side counts and the map's own must agree — the
  // whole point of a width-1 escape unit.
  for (const cell of result.cells) {
    assert.equal(cell.pmNode.content.size, cell.charMap.visibleLength)
  }
}
{
  // POSITIVE — `\\` (an escaped BACKSLASH). Probed '| a\\b | c |': text [2,6)
  // value 'a\b', units a / \\ / b.
  const md = '| a\\\\b | c |\n| --- | --- |\n| d | e |\n'
  const result = buildTableCellMaps(md, mdTableOf(md), tableNode([
    [[text('a\\b')], [text('c')]], [[text('d')], [text('e')]]
  ]), 0)
  assert.ok(result, 'escaped-backslash table must zip')
  assert.ok(result.cells[0].charMap, 'a `\\\\` cell must be EDITABLE')
  assert.deepEqual(unitTrace(md, result.cells[0].charMap),
    [['a', 'char', 1], ['\\\\', 'escape', 1], ['b', 'char', 1]])
  assert.equal(result.cells[0].pmNode.content.size, 3)
}
{
  // THE MEASURED REAL-WORLD SHAPE (~/Downloads/灵影网关模型价格清单.md, which
  // lost 110 of its 111 cells to the blanket guard). Probed
  // '| claude\-haiku\-4\.5 | 4\.00 |': cell [0,22), text [2,21) value
  // 'claude-haiku-4.5' (16 visible chars over 19 raw bytes).
  const md = '| claude\\-haiku\\-4\\.5 | 4\\.00 |\n| --- | --- |\n| a | b |\n'
  const result = buildTableCellMaps(md, mdTableOf(md), tableNode([
    [[text('claude-haiku-4.5')], [text('4.00')]], [[text('a')], [text('b')]]
  ]), 0)
  assert.ok(result, 'price-list table must zip')
  assert.ok(result.cells.every((c) => c.charMap), 'every price-list cell editable')
  const map = result.cells[0].charMap
  assert.equal(map.visibleLength, 16)
  assert.equal(result.cells[0].pmNode.content.size, 16)
  assert.deepEqual(boundaries(map),
    [2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 17, 18, 20, 21])
  assert.deepEqual(map.units.filter((u) => u.kind === 'escape')
    .map((u) => md.slice(u.rawStart, u.rawEnd)), ['\\-', '\\-', '\\.'])

  // ---- an EDIT into such a cell lands byte-exactly and never disturbs an
  // escape. `replaceVisibleText` is the real commit primitive (it resolves the
  // raw range through this very map and consults the typing-spelling policy),
  // and every result is REPARSED to prove the escape survived as an escape.
  const doc = { text: md, revision: 7 }
  const apply = (tx) => md.slice(0, tx.from) + tx.insert + md.slice(tx.to)
  const cellValueOf = (source) => {
    const t = mdTableOf(source)
    return t?.children?.[0]?.children?.[0]?.children?.[0]?.value ?? null
  }

  // (a) replace the trailing '5' (visible [15,16)) -> raw [20,21).
  const a = replaceVisibleText({ doc, map, visFrom: 15, visTo: 16, insert: '6' })
  assert.ok(a.ok, 'replacing a plain char in an escaped cell must be provable')
  assert.deepEqual([a.transaction.from, a.transaction.to, a.transaction.insert], [20, 21, '6'])
  assert.equal(apply(a.transaction),
    '| claude\\-haiku\\-4\\.6 | 4\\.00 |\n| --- | --- |\n| a | b |\n')
  assert.equal(cellValueOf(apply(a.transaction)), 'claude-haiku-4.6')

  // (b) a zero-width insert BEFORE the '\.' escape (visible 14) -> raw 18,
  //     i.e. in front of the backslash, never between `\` and `.`.
  const b = replaceVisibleText({ doc, map, visFrom: 14, visTo: 14, insert: 'Z' })
  assert.ok(b.ok)
  assert.deepEqual([b.transaction.from, b.transaction.to, b.transaction.insert], [18, 18, 'Z'])
  assert.equal(apply(b.transaction),
    '| claude\\-haiku\\-4Z\\.5 | 4\\.00 |\n| --- | --- |\n| a | b |\n')
  assert.equal(cellValueOf(apply(b.transaction)), 'claude-haiku-4Z.5')

  // (c) a zero-width insert AFTER the '\.' escape (visible 15) -> raw 20.
  const c = replaceVisibleText({ doc, map, visFrom: 15, visTo: 15, insert: 'Z' })
  assert.ok(c.ok)
  assert.deepEqual([c.transaction.from, c.transaction.to, c.transaction.insert], [20, 20, 'Z'])
  assert.equal(apply(c.transaction),
    '| claude\\-haiku\\-4\\.Z5 | 4\\.00 |\n| --- | --- |\n| a | b |\n')
  assert.equal(cellValueOf(apply(c.transaction)), 'claude-haiku-4.Z5')

  // (d) replacing the ESCAPED character itself consumes BOTH of its raw bytes
  //     — an escape is one indivisible unit, never half-written.
  const d = replaceVisibleText({ doc, map, visFrom: 14, visTo: 15, insert: 'X' })
  assert.ok(d.ok)
  assert.deepEqual([d.transaction.from, d.transaction.to, d.transaction.insert], [18, 20, 'X'])
  assert.equal(apply(d.transaction),
    '| claude\\-haiku\\-4X5 | 4\\.00 |\n| --- | --- |\n| a | b |\n')
  assert.equal(cellValueOf(apply(d.transaction)), 'claude-haiku-4X5')

  // (e) after any of these the cell is STILL cell-addressable (the edit did
  //     not push the table out of the provable set).
  for (const tx of [a, b, c, d]) {
    const next = apply(tx.transaction)
    const nextTable = mdTableOf(next)
    const nextResult = buildTableCellMaps(next, nextTable, tableNode([
      [[text(cellValueOf(next))], [text('4.00')]], [[text('a')], [text('b')]]
    ]), 0)
    assert.ok(nextResult && nextResult.cells[0].charMap,
      'the edited cell must remain editable')
  }
}
{
  // UNCHANGED — a `<br>` cell degrades even when its escapes are the ordinary
  // kind: `hasCellBreak` runs BEFORE the escape guard and is untouched by the
  // narrowing. Probed '| a\-b<br>c | d |': cell [0,12), children
  // text/html/text, units a / \- / b / <br> / c.
  const md = '| a\\-b<br>c | d |\n| --- | --- |\n| e | f |\n'
  const result = buildTableCellMaps(md, mdTableOf(md), tableNode([
    [[text('a-b'), schema.node('hardbreak'), text('c')], [text('d')]],
    [[text('e')], [text('f')]]
  ]), 0)
  assert.ok(result, '<br>+escape table still zips structurally')
  assert.equal(result.cells[0].charMap, null,
    'a <br> cell degrades regardless of the escapes it holds')
  assert.ok(result.cells[1].charMap, 'its sibling stays editable')
}
{
  // UNCHANGED — the whole-TABLE ragged refusal is independent of escapes.
  const md = '| a\\-b | c |\n| --- | --- |\n| d |\n'
  assert.equal(buildTableCellMaps(md, mdTableOf(md),
    tableNode([[[text('a-b')], [text('c')]], [[text('d')]]]), 0), null,
  'a ragged table refuses as a whole, escapes or not')
}
{
  // SCOPE STATEMENT — the guard reads the escape UNITS, i.e. the decode the
  // unit model owns. A `\|` sitting in a link DESTINATION is gap bytes: no
  // unit covers it, and no cell-text edit can address it (the map's only
  // visible content is the label). Probed '| [x](a\|b) | c |': cell [0,12),
  // link [2,11), the ONE unit is the label char 'x' at [3,4).
  const md = '| [x](a\\|b) | c |\n| --- | --- |\n| d | e |\n'
  const result = buildTableCellMaps(md, mdTableOf(md), tableNode([
    [[text('x')], [text('c')]], [[text('d')], [text('e')]]
  ]), 0)
  assert.ok(result, 'link-destination table must zip')
  const map = result.cells[0].charMap
  assert.ok(map, 'the cell is editable — its escape is not in the unit model')
  assert.deepEqual(unitTrace(md, map), [['x', 'char', 1]])
  // Every addressable range stays strictly inside the label, so the `\|` in
  // the destination is unreachable from a text edit.
  const doc = { text: md, revision: 1 }
  const edit = replaceVisibleText({ doc, map, visFrom: 0, visTo: 1, insert: 'y' })
  assert.ok(edit.ok)
  assert.deepEqual([edit.transaction.from, edit.transaction.to], [3, 4])
  assert.equal(md.slice(0, 3) + 'y' + md.slice(4),
    '| [y](a\\|b) | c |\n| --- | --- |\n| d | e |\n')
}

console.log('PASS source-kernel table map')
