import assert from 'node:assert/strict'
import { preserveRichMarkdownSource } from '../src/renderer/src/markdown-source-preservation.js'
import {
  normalizeEmptyTableCells,
  normalizeSerializerEmptyTableCells
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
  authoredBreak.replace('a \\| b', 'a \\| bX')
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
  canonicalSlashBreak.replace('a \\| b', 'a \\| bX')
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

console.log('PASS table empty-cell normalization: new tables keep empty cells as GFM blanks')
