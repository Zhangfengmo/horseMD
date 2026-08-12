import assert from 'node:assert/strict'
import { Schema } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { preserveRichMarkdownSource } from '../src/renderer/src/markdown-source-preservation.js'
import {
  advanceTableInsertionCoordinateProof,
  isTableInsertionCoordinateProofComplete,
  tableCoordinatesRemainStable,
  tableInsertionKeepsExistingCoordinates
} from '../src/renderer/src/components/editor-table-transactions.js'
import {
  normalizeEmptyTableCells,
  normalizeSerializerEmptyTableCells,
  normalizeSerializerTablePlaceholdersByContext,
  tableDurableContext
} from '../src/renderer/src/lib/markdown-preservation/tables.js'

const nextWithNewTable = [
  '# Demo',
  '',
  '| Name | Notes |',
  '| --- | --- |',
  '| <br /> | <br /> |'
].join('\n')

const inserted = preserveRichMarkdownSource('# Demo\n', '# Demo\n', nextWithNewTable)
assert.equal(inserted.reason, 'table-structure')
assert.match(inserted.markdown, /\|\s*\|\s*\|/)
assert.doesNotMatch(inserted.markdown, /\|\s*<br\s*\/?>/i)

const movedBreakAuthored = '| A | B |\n| --- | --- |\n| <br /> |  |\n'
const movedBreakPrevious = '| A    | B      |\n| ---- | ------ |\n| <br> | <br /> |\n'
const movedBreakNext = '| A      | B    |\n| ------ | ---- |\n| <br /> | <br> |\n\n'
const movedBreak = preserveRichMarkdownSource(
  movedBreakAuthored,
  movedBreakPrevious,
  movedBreakNext,
  { allowTableCoordinateIdentity: true }
)
assert.equal(movedBreak.preserved, true, 'two proven cell edits may share one serializer batch')
assert.equal(movedBreak.blocked, undefined)
assert.equal(
  movedBreak.markdown,
  '| A | B |\n| --- | --- |\n|  | <br> |\n',
  'moving a real hardbreak between proven cells keeps authored table formatting'
)

const withRealBreak = [
  '# Demo',
  '',
  '| Name | Notes |',
  '| --- | --- |',
  '| horse | first<br>second |',
  '| <br /> | <br /> |'
].join('\n')
const normalized = preserveRichMarkdownSource('', '', withRealBreak)
assert.match(normalized.markdown, /first<br>second/)
assert.doesNotMatch(normalized.markdown, /\|\s*<br\s*\/?>/i)

const mixedCells = [
  '| A | B | C | D |',
  '| --- | --- | --- | --- |',
  '| <br> | <br /> | text<br>text | a \\| b |'
].join('\n')
assert.equal(
  normalizeEmptyTableCells(mixedCells),
  mixedCells,
  'generic authored normalization never treats an exact <br /> spelling as serializer provenance'
)
assert.equal(
  normalizeSerializerEmptyTableCells(mixedCells),
  [
    '| A | B | C | D |',
    '| --- | --- | --- | --- |',
    '| <br> |  | text<br>text | a \\| b |'
  ].join('\n'),
  'explicit serializer provenance clears only its exact placeholder spelling'
)

const authoredBreak = [
  '| A | B |',
  '| --- | --- |',
  '| <br> | a \\| b |'
].join('\n')
const editedBesideAuthoredBreak = preserveRichMarkdownSource(
  authoredBreak,
  authoredBreak,
  authoredBreak.replace('a \\| b', 'a \\| bX'),
  { allowTableCoordinateIdentity: true }
)
assert.equal(editedBesideAuthoredBreak.reason, 'table-cell-text')
assert.equal(
  editedBesideAuthoredBreak.markdown,
  authoredBreak.replace('a \\| b', 'a \\| bX'),
  'a user-authored sole <br> remains a semantic break during a neighboring cell edit'
)

const authoredSlashBreak = authoredBreak.replace('<br>', '<br />')
const canonicalSlashBreak = authoredSlashBreak.replace('<br />', '<br>')
const editedBesideAuthoredSlashBreak = preserveRichMarkdownSource(
  authoredSlashBreak,
  canonicalSlashBreak,
  canonicalSlashBreak.replace('a \\| b', 'a \\| bX'),
  { allowTableCoordinateIdentity: true }
)
assert.equal(editedBesideAuthoredSlashBreak.reason, 'table-cell-text')
assert.equal(
  editedBesideAuthoredSlashBreak.markdown,
  authoredSlashBreak.replace('a \\| b', 'a \\| bX'),
  'a user-authored sole <br /> survives a neighboring serializer-origin cell edit'
)

const exactBaselineAuthoredBreak = preserveRichMarkdownSource(
  `${authoredSlashBreak}\n\nold paragraph`,
  `${authoredSlashBreak}\n\nold paragraph`,
  `${authoredSlashBreak}\n\nnew paragraph`
)
assert.equal(
  exactBaselineAuthoredBreak.markdown,
  `${authoredSlashBreak}\n\nnew paragraph`,
  'an exact-baseline non-table edit never globally clears an authored <br /> cell'
)

const recoveryAuthored = [
  '| A | B | C |',
  '| --- | --- | --- |',
  '| <br /> | stable |'
].join('\n')
const recoveryPreviousCanonical = [
  '| A | B | C |',
  '| --- | --- | --- |',
  '| <br /> | stable | <br /> |'
].join('\n')
const recoveryCanonical = [
  recoveryPreviousCanonical,
  '',
  '| New A | New B |',
  '| --- | --- |',
  '| <br /> | <br /> |'
].join('\n')
const recoveryContext = tableDurableContext({
  authored: recoveryAuthored,
  previousCanonical: recoveryPreviousCanonical,
  nextCanonical: recoveryCanonical,
  allowCoordinateIdentity: true
})
assert.ok(recoveryContext, 'recovery normalization needs structural table provenance')
assert.equal(
  normalizeSerializerTablePlaceholdersByContext(recoveryCanonical, recoveryContext),
  [
    '| A | B | C |',
    '| --- | --- | --- |',
    '| <br /> | stable |  |',
    '',
    '| New A | New B |',
    '| --- | --- |',
    '|  |  |'
  ].join('\n'),
  'recovery materialization clears only proven serializer placeholders and keeps an authored sole <br />'
)
assert.equal(
  normalizeSerializerTablePlaceholdersByContext(recoveryCanonical, {
    emptyTableCells: [...recoveryContext.emptyTableCells, { table: 99, row: 0, column: 0 }]
  }),
  recoveryCanonical,
  'a stale recovery coordinate rejects the whole cleanup instead of partially rewriting the export'
)
assert.equal(
  normalizeSerializerTablePlaceholdersByContext(recoveryCanonical, {
    emptyTableCells: [recoveryContext.emptyTableCells[0], recoveryContext.emptyTableCells[0]]
  }),
  recoveryCanonical,
  'duplicate recovery coordinates reject the whole cleanup'
)

const reorderedRowsAuthored = [
  '| Break | Label |',
  '| --- | --- |',
  '| <br /> | real-row |',
  '|  | empty-row |'
].join('\n')
const reorderedRowsPrevious = reorderedRowsAuthored.replace('|  | empty-row |', '| <br /> | empty-row |')
const reorderedRowsNext = [
  '| Break | Label |',
  '| --- | --- |',
  '| <br /> | empty-row |',
  '| <br /> | real-row |'
].join('\n')
const reorderedRowsContext = tableDurableContext({
  authored: reorderedRowsAuthored,
  previousCanonical: reorderedRowsPrevious,
  nextCanonical: reorderedRowsNext
})
assert.equal(
  normalizeSerializerTablePlaceholdersByContext(reorderedRowsNext, reorderedRowsContext),
  reorderedRowsNext,
  'row movement is not inferred from content signatures without operation provenance'
)

const reorderedColumnsAuthored = [
  '| Real break | Empty | Label |',
  '| --- | --- | --- |',
  '| <br /> |  | stable |'
].join('\n')
const reorderedColumnsPrevious = reorderedColumnsAuthored.replace('| <br /> |  | stable |', '| <br /> | <br /> | stable |')
const reorderedColumnsNext = [
  '| Empty | Real break | Label |',
  '| --- | --- | --- |',
  '| <br /> | <br /> | stable |'
].join('\n')
const reorderedColumnsContext = tableDurableContext({
  authored: reorderedColumnsAuthored,
  previousCanonical: reorderedColumnsPrevious,
  nextCanonical: reorderedColumnsNext
})
assert.equal(
  normalizeSerializerTablePlaceholdersByContext(reorderedColumnsNext, reorderedColumnsContext),
  reorderedColumnsNext,
  'column movement is not inferred from content signatures without operation provenance'
)

const indistinguishableMovementAuthored = [
  '| Break | Label |',
  '| --- | --- |',
  '| <br /> | same |',
  '|  | same |'
].join('\n')
const indistinguishableMovementCanonical = indistinguishableMovementAuthored
  .replace('|  | same |', '| <br /> | same |')
assert.equal(
  tableDurableContext({
    authored: indistinguishableMovementAuthored,
    previousCanonical: indistinguishableMovementCanonical,
    nextCanonical: indistinguishableMovementCanonical,
    allowCoordinateIdentity: false
  }),
  null,
  'a changed document with identical canonical bytes cannot inherit coordinate provenance'
)

const hiddenColumnMoveThenEditAuthored = [
  '| Same | Same |',
  '| --- | --- |',
  '| <br /> |  |'
].join('\n')
const hiddenColumnMoveThenEditPrevious = hiddenColumnMoveThenEditAuthored
  .replace('| <br /> |  |', '| <br /> | <br /> |')
const hiddenColumnMoveThenEditNext = hiddenColumnMoveThenEditAuthored
  .replace('| <br /> |  |', '| x | <br /> |')
const hiddenMoveResult = preserveRichMarkdownSource(
  hiddenColumnMoveThenEditAuthored,
  hiddenColumnMoveThenEditPrevious,
  hiddenColumnMoveThenEditNext
)
assert.equal(hiddenMoveResult.preserved, false, 'a final one-cell diff cannot prove that columns did not move first')
assert.equal(hiddenMoveResult.reason, 'table-coordinate-provenance-required')

const insertedLeadingColumnAuthored = '| <br /> |  |\n| --- | --- |'
const insertedLeadingColumnPrevious = '| <br /> | <br /> |\n| --- | --- |'
const insertedLeadingColumnNext = '| <br /> | <br /> | <br /> |\n| --- | --- | --- |'
const insertedLeadingColumn = preserveRichMarkdownSource(
  insertedLeadingColumnAuthored,
  insertedLeadingColumnPrevious,
  insertedLeadingColumnNext
)
assert.equal(insertedLeadingColumn.preserved, false, 'a column insertion needs operation provenance when real breaks exist')

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    table: { group: 'block', content: 'table_row+' },
    table_row: { content: 'table_cell+' },
    table_cell: { content: 'paragraph' }
  }
})
const paragraph = (text) => schema.node('paragraph', null, text ? [schema.text(text)] : [])
const cell = (text) => schema.node('table_cell', null, [paragraph(text)])
const row = (...values) => schema.node('table_row', null, values.map(cell))
const table = (...rows) => schema.node('table', null, rows)
const transactionDoc = schema.node('doc', null, [
  paragraph('before'),
  table(row('a', 'b'), row('c', 'd')),
  paragraph('after')
])
const initialState = EditorState.create({ doc: transactionDoc })
let textPosition = null
let tablePosition = null
transactionDoc.descendants((node, position) => {
  if (node.isText && node.text === 'b') textPosition = position
  if (node.type.name === 'table') tablePosition = position
})
const textApplied = initialState.applyTransaction(initialState.tr.insertText('X', textPosition + 1))
assert.equal(
  tableCoordinatesRemainStable(textApplied.transactions),
  true,
  'a cell-local text transaction proves that existing table coordinates stayed stable'
)
const originalTable = transactionDoc.nodeAt(tablePosition)
const swappedTable = table(originalTable.child(1), originalTable.child(0))
const swappedApplied = initialState.applyTransaction(
  initialState.tr.replaceWith(tablePosition, tablePosition + originalTable.nodeSize, swappedTable)
)
assert.equal(
  tableCoordinatesRemainStable(swappedApplied.transactions),
  false,
  'transaction mappings reject row movement even when the final table shape is unchanged'
)
const addedColumnTable = table(
  row('new', 'a', 'b'),
  row('new', 'c', 'd')
)
const addedColumnApplied = initialState.applyTransaction(
  initialState.tr.replaceWith(tablePosition, tablePosition + originalTable.nodeSize, addedColumnTable)
)
assert.equal(
  tableCoordinatesRemainStable(addedColumnApplied.transactions),
  false,
  'shape-changing table transactions cannot inherit coordinate identity'
)

const insertedTableDoc = schema.node('doc', null, [
  paragraph('before'),
  table(row('a', 'b'), row('c', 'd')),
  table(row('', ''), row('', '')),
  paragraph('after')
])
const insertedTableApplied = initialState.applyTransaction(
  initialState.tr.replaceWith(0, initialState.doc.content.size, insertedTableDoc.content)
)
assert.equal(
  tableInsertionKeepsExistingCoordinates(insertedTableApplied.transactions),
  false,
  'replacing the whole document with an extra table is not proof that old cell coordinates survived'
)

const queryDoc = schema.node('doc', null, [
  table(row('a', 'b'), row('c', 'd')),
  paragraph('/table')
])
const queryState = EditorState.create({ doc: queryDoc })
let queryPosition = null
queryDoc.descendants((node, position) => {
  if (node.type.name === 'paragraph' && node.textContent === '/table') queryPosition = position
})
const slashTable = table(row('', '', ''), row('', '', ''), row('', '', ''))
const slashApplied = queryState.applyTransaction(
  queryState.tr.replaceWith(queryPosition, queryPosition + queryDoc.nodeAt(queryPosition).nodeSize, slashTable)
)
assert.equal(
  tableInsertionKeepsExistingCoordinates(slashApplied.transactions),
  true,
  'a block-local slash insertion proves that every pre-existing table cell kept its logical coordinate'
)
assert.equal(
  isTableInsertionCoordinateProofComplete(advanceTableInsertionCoordinateProof({
    proof: null,
    baselineProven: false,
    transactions: slashApplied.transactions
  })),
  false,
  'a safe slash batch cannot override an untrusted baseline'
)

const clearApplied = queryState.applyTransaction(
  queryState.tr.delete(queryPosition + 1, queryPosition + 1 + '/table'.length)
)
const emptyQueryBlock = clearApplied.state.doc.nodeAt(queryPosition)
const addAfterClearApplied = clearApplied.state.applyTransaction(
  clearApplied.state.tr.replaceWith(
    queryPosition,
    queryPosition + emptyQueryBlock.nodeSize,
    slashTable
  )
)
let splitDispatchProof = advanceTableInsertionCoordinateProof({
  proof: null,
  baselineProven: true,
  transactions: clearApplied.transactions
})
assert.equal(
  isTableInsertionCoordinateProofComplete(splitDispatchProof),
  false,
  'clearing the slash query is a valid pre-batch but is not yet an insertion proof'
)
splitDispatchProof = advanceTableInsertionCoordinateProof({
  proof: splitDispatchProof,
  baselineProven: true,
  transactions: addAfterClearApplied.transactions
})
assert.equal(
  isTableInsertionCoordinateProofComplete(splitDispatchProof),
  true,
  'clearText then addBlock must accumulate into one table insertion proof'
)

let invalidatedProof = advanceTableInsertionCoordinateProof({
  proof: null,
  baselineProven: true,
  transactions: swappedApplied.transactions
})
invalidatedProof = advanceTableInsertionCoordinateProof({
  proof: invalidatedProof,
  baselineProven: true,
  transactions: slashApplied.transactions
})
assert.equal(
  isTableInsertionCoordinateProofComplete(invalidatedProof),
  false,
  'a later safe insertion cannot overwrite an earlier invalid coordinate transition'
)

console.log('PASS table empty-cell normalization: new tables keep empty cells as GFM blanks')
