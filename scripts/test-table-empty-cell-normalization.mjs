import assert from 'node:assert/strict'
import { preserveRichMarkdownSource } from '../src/renderer/src/markdown-source-preservation.js'
import { normalizeEmptyTableCells } from '../src/renderer/src/lib/markdown-preservation/tables.js'

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
  [
    '| A | B | C | D |',
    '| --- | --- | --- | --- |',
    '| <br> |  | text<br>text | a \\| b |'
  ].join('\n'),
  'only the exact serializer placeholder is cleared; authored breaks and escaped pipes stay scoped to their parsed cells'
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

console.log('PASS table empty-cell normalization: new tables keep empty cells as GFM blanks')
