import assert from 'node:assert/strict'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import {
  createGfmTableSourceParser,
  mapGfmTableChange
} from '../src/renderer/src/lib/markdown-preservation/table-source-model.js'

const remark = unified().use(remarkParse).use(remarkGfm)
const parseTables = createGfmTableSourceParser(remark)

const replaceOnce = (value, from, to) => {
  const index = value.indexOf(from)
  assert.ok(index >= 0, `fixture is missing ${from}`)
  return value.slice(0, index) + to + value.slice(index + from.length)
}

const rectangularEditorView = (authored, shortRows) => {
  let canonical = authored
  for (const { authoredRow, canonicalRow } of shortRows) {
    canonical = canonical.replace(authoredRow, canonicalRow)
  }
  return canonical
}

const mapFullRowEdit = (authored, previousCanonical, from, to) => {
  const nextCanonical = replaceOnce(previousCanonical, from, to)
  const result = mapGfmTableChange({
    authored,
    previousCanonical,
    nextCanonical,
    parseTables
  })
  assert.equal(result.status, 'patched', `full-row edit must be owned by its table: ${result.reason || ''}`)
  return result.markdown
}

{
  const shortRow = '| authored short |'
  const authored = [
    'before-sentinel',
    '| one | two | three | four | five |',
    '| - | -- | --- | :---: | ---: |',
    shortRow,
    '| editable full | b | c | d | e |',
    'after-sentinel'
  ].join('\n')
  const parsed = parseTables(authored)
  assert.equal(typeof parsed.view, 'object', 'parser returns a source-view object rather than a replacement Markdown string')
  assert.equal(parsed.view.raw ?? parsed.view.authored, authored, 'source view retains the exact authored bytes')
  assert.equal(parsed.view.text, authored, 'source view exposes the authored text used for ranges')
  assert.equal(parsed.tables.length, 1, 'parser discovers the GFM table')
  assert.equal(parsed.tables[0].width, 5, 'parser gets table width from the header/delimiter')
  assert.equal(parsed.tables[0].rows[0].range.start, authored.indexOf('| one | two | three | four | five |'), 'rows[0] is the header row')
  assert.equal(parsed.tables[0].rows[0].missingColumns, 0, 'header cells are complete')
  assert.equal(parsed.tables[0].rows[1].range.start, authored.indexOf(shortRow), 'body rows begin after the header')
  assert.equal(parsed.tables[0].rows[1].missingColumns, 4, 'parser records missing trailing body cells without inventing them')
  const previousCanonical = rectangularEditorView(authored, [{
    authoredRow: shortRow,
    canonicalRow: '| authored short |  |  |  |  |'
  }])
  const mapped = mapFullRowEdit(authored, previousCanonical, 'editable full', 'editable full changed')
  assert.equal(mapped, authored.replace('editable full', 'editable full changed'), 'an untouched ragged row is byte-identical while a different full row changes')
  assert.ok(mapped.includes(shortRow), 'short row spelling is retained exactly')
}

{
  const shortRow = '| authored short |'
  const target = 'abc<br>def'
  const authored = [
    '| one | two | three |',
    '| --- | --- | --- |',
    shortRow,
    `| ${target} | second | third |`
  ].join('\n')
  const previousCanonical = rectangularEditorView(authored, [{
    authoredRow: shortRow,
    canonicalRow: '| authored short |  |  |'
  }])
  const mapped = mapFullRowEdit(authored, previousCanonical, target, `${target}X`)
  assert.equal(mapped, authored.replace(target, `${target}X`), 'editing a hard-break cell patches only that cell')
  assert.ok(mapped.includes('abc<br>defX'), 'the target cell preserves its authored <br> spelling')
  assert.ok(mapped.includes(shortRow), 'unrelated ragged row remains byte-identical')
}

for (const delimiter of ['| - | -- | - | -- | - |', '| -- | - | -- | - | -- |']) {
  const authored = [
    '| one | two | three | four | five |',
    delimiter,
    '| short |',
    '| editable | b | c | d | e |'
  ].join('\n')
  const parsed = parseTables(authored)
  assert.equal(parsed.tables.length, 1, `one- and two-dash delimiters parse as a table: ${delimiter}`)
  const previousCanonical = rectangularEditorView(authored, [{
    authoredRow: '| short |',
    canonicalRow: '| short |  |  |  |  |'
  }])
  const mapped = mapFullRowEdit(authored, previousCanonical, 'editable', 'edited')
  assert.equal(mapped, authored.replace('editable', 'edited'), `delimiter spelling stays byte-identical: ${delimiter}`)
}

{
  const shortRow = '| authored short |'
  const target = 'a \\| b<br>tail'
  const authored = [
    '| one | two | three |',
    '| --- | --- | --- |',
    shortRow,
    `| ${target} | second | third |`
  ].join('\n')
  const previousCanonical = rectangularEditorView(authored, [{
    authoredRow: shortRow,
    canonicalRow: '| authored short |  |  |'
  }])
  const mapped = mapFullRowEdit(authored, previousCanonical, target, `${target}X`)
  assert.equal(mapped, authored.replace(target, `${target}X`), 'editing an escaped-pipe hard-break cell patches only that cell')
  assert.ok(mapped.includes('a \\| b<br>tailX'), 'the target cell retains both escaped-pipe and <br> spelling')
  assert.ok(mapped.includes(shortRow), 'unrelated ragged row remains byte-identical')
}

console.log('PASS table source model: ragged authored rows survive neighboring GFM table edits')
