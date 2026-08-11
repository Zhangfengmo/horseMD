import assert from 'node:assert/strict'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { normalizeRaggedGfmTables } from '../src/renderer/src/components/editor-table-normalization.js'
import { brToBreakRemarkPlugin } from '../src/renderer/src/components/editor-tablebreak.js'

const remark = unified().use(remarkParse).use(remarkGfm)
const markdown = [
  '| one | two | three | four | five |',
  '| - | -- | --- | :---: | ---: |',
  '| first short |',
  '| second short |',
  '| complete | b | c | d | e |'
].join('\n')

const tree = remark.parse(markdown)
const table = tree.children.find((node) => node.type === 'table')
assert.ok(table, 'fixture must parse as a GFM table')
assert.deepEqual(table.children.map((row) => row.children.length), [5, 1, 1, 5], 'fixture must start ragged')

const normalized = normalizeRaggedGfmTables(tree)
assert.equal(normalized, tree, 'normalization mutates and returns the same mdast tree')

const rows = table.children
assert.deepEqual(rows.map((row) => row.children.length), [5, 5, 5, 5], 'continuous short body rows are padded to the header width')
for (const [index, value] of ['first short', 'second short'].entries()) {
  const row = rows[index + 1]
  assert.equal(row.children[0].children[0]?.value, value, `short row ${index + 1} keeps authored content in column one`)
  assert.deepEqual(
    row.children.slice(1).map((cell) => cell.children),
    [[], [], [], []],
    `short row ${index + 1} receives only empty cells on the right`
  )
}
assert.equal(rows[3].children[4].children[0]?.value, 'e', 'complete rows remain unchanged')

const once = structuredClone(tree)
normalizeRaggedGfmTables(tree)
assert.deepEqual(tree, once, 'normalization is idempotent')

const cell = (value) => ({
  type: 'tableCell',
  children: [{ type: 'text', value }]
})
const overwideCells = ['left', 'middle', 'right'].map(cell)
const overwideTree = {
  type: 'root',
  children: [{
    type: 'table',
    children: [
      { type: 'tableRow', children: [cell('h1'), cell('h2')] },
      { type: 'tableRow', children: overwideCells }
    ]
  }]
}
normalizeRaggedGfmTables(overwideTree)
const overwideRow = overwideTree.children[0].children[1]
assert.equal(overwideRow.children.length, 3, 'a body row wider than its header is never truncated')
assert.deepEqual(
  overwideRow.children.map((entry) => entry.children[0]?.value),
  ['left', 'middle', 'right'],
  'overwide body-cell content keeps its authored order'
)
assert.ok(
  overwideRow.children.every((entry, index) => entry === overwideCells[index]),
  'normalization does not replace or move existing overwide cells'
)

const breakTree = remark.parse('| A | B |\n| - | - |\n| before<br>after | stable |')
const breakCell = breakTree.children[0].children[1].children[0]
const htmlBreak = breakCell.children.find((node) => node.type === 'html')
assert.ok(htmlBreak?.position, 'the parser proves the authored <br> range before transforms run')
const expectedBreakPosition = structuredClone(htmlBreak.position)
brToBreakRemarkPlugin()(breakTree)
const transformedBreak = breakCell.children.find((node) => node.type === 'break')
assert.deepEqual(
  transformedBreak?.position,
  expectedBreakPosition,
  'the HTML-break transform retains the exact parser-owned raw position'
)

console.log('PASS editor table normalization: ragged rows pad right and overwide rows remain intact')
