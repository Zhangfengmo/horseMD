import assert from 'node:assert/strict'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { commonChange } from '../src/renderer/src/lib/markdown-preservation/core.js'
import {
  buildGfmTableSourceModel,
  createGfmTableSourceParser,
  getGfmTableSourceParser,
  mapGfmTableChange
} from '../src/renderer/src/lib/markdown-preservation/table-source-model.js'

const remark = unified().use(remarkParse).use(remarkGfm)
const parseTables = createGfmTableSourceParser(remark)

const mutableParsedModel = (markdown) => {
  const parsed = parseTables(markdown)
  const model = structuredClone({
    view: {
      raw: parsed.view.raw,
      text: parsed.view.text,
      ...(Array.isArray(parsed.view.toRaw) ? { toRaw: parsed.view.toRaw } : {})
    },
    tables: parsed.tables
  })
  model.view.rawOffset = parsed.view.rawOffset
  model.view.rawRange = parsed.view.rawRange
  return model
}

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

{
  const authored = '| A | B |\n| - | - |\n| <br> | stable |'
  const previousCanonical = '| A | B |\n| - | - |\n| <br /> | stable |'
  const nextCanonical = '| A | B |\n| - | - |\n|  | stable |'
  const result = mapGfmTableChange({ authored, previousCanonical, nextCanonical, parseTables })
  assert.equal(result.status, 'patched', 'a canonical serializer spelling still owns an authored sole hardbreak')
  assert.equal(result.kind, 'cell-text')
  assert.equal(
    result.markdown,
    nextCanonical,
    'deleting an authored sole hardbreak removes its source spelling instead of preserving stale bytes'
  )
}

{
  const authored = '| A | B |\n| - | - |\n|  | stable |'
  const previousCanonical = '| A | B |\n| - | - |\n| <br /> | stable |'
  const nextCanonical = '| A | B |\n| - | - |\n| <br> | stable |'
  const result = mapGfmTableChange({ authored, previousCanonical, nextCanonical, parseTables })
  assert.equal(result.status, 'patched', 'an empty-cell placeholder can become a real sole hardbreak')
  assert.equal(result.kind, 'cell-text')
  assert.notEqual(result.markdown, authored, 'the hardbreak insertion must change the durable source')
  const materialized = parseTables(result.markdown).tables[0].rows[1].cells[0]
  assert.equal(
    result.markdown.slice(materialized.contentRange.start, materialized.contentRange.end),
    '<br>',
    'inserting a sole hardbreak materializes its authored source spelling instead of leaving the cell empty'
  )
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

{
  const authored = [
    '\uFEFFbefore\r',
    '\r',
    '| one | two | three |\r',
    '| :- | -- | -: |\r',
    '| a \\| b<br>tail | second | third |\r',
    '\r',
    'after\r',
    ''
  ].join('\n')
  const parsed = parseTables(authored)
  assert.equal(parsed.view.raw, authored, 'the source view retains BOM + CRLF bytes exactly')
  assert.equal(parsed.view.text, authored.slice(1).replaceAll('\r\n', '\n'), 'the parser view strips BOM and normalizes CRLF')
  assert.equal(parsed.view.rawOffset(0), 1, 'normalized offset zero maps after the authored BOM')
  assert.deepEqual(
    parsed.view.rawRange({ start: { offset: 0 }, end: { offset: 6 } }),
    { start: 1, end: 7 },
    'mdast positions map back to authored raw offsets'
  )

  const table = parsed.tables[0]
  assert.equal(authored.slice(table.range.start, table.range.end), [
    '| one | two | three |',
    '| :- | -- | -: |',
    '| a \\| b<br>tail | second | third |'
  ].join('\r\n'), 'table range maps through BOM + CRLF without consuming surrounding bytes')
  assert.equal(
    authored.slice(table.delimiterRange.start, table.delimiterRange.end),
    '| :- | -- | -: |',
    'delimiterRange is the exact authored delimiter line even though mdast has no delimiter row'
  )
  assert.deepEqual(table.align, ['left', null, 'right'], 'alignment comes from the parsed table node')

  const target = table.rows[1].cells[0]
  assert.equal(authored.slice(target.contentRange.start, target.contentRange.end), 'a \\| b<br>tail')
  assert.equal(target.patchable, true, 'escaped pipes and HTML breaks have exact parser-proven units')
  assert.equal(target.units.map((unit) => unit.kind === 'break' ? '\n' : unit.value).join(''), 'a | b\ntail')
  const pipe = target.units.find((unit) => unit.kind === 'char' && unit.value === '|')
  const hardBreak = target.units.find((unit) => unit.kind === 'break')
  assert.equal(authored.slice(pipe.range.start, pipe.range.end), '\\|', 'escaped pipe is one unit owning both raw characters')
  assert.equal(authored.slice(hardBreak.range.start, hardBreak.range.end), '<br>', 'break unit preserves the authored HTML spelling')

  const nextCanonical = parsed.view.text.replace('tail', 'tailX')
  const mapped = mapGfmTableChange({
    authored,
    previousCanonical: parsed.view.text,
    nextCanonical,
    parseTables
  })
  assert.equal(mapped.status, 'patched')
  assert.equal(mapped.kind, 'cell-text')
  assert.equal(mapped.markdown, authored.replace('tail', 'tailX'), 'cell patch preserves BOM, CRLF, escape and break bytes')
}

{
  const authored = '| A | B |\n| - | - |\n| &amp; 😀 \\* | stable |'
  const cell = parseTables(authored).tables[0].rows[1].cells[0]
  assert.equal(cell.patchable, true, 'exact entity and backslash decoding remains patchable')
  assert.equal(cell.units.map((unit) => unit.value).join(''), '& 😀 *')
  const entity = cell.units.find((unit) => unit.value === '&')
  const emoji = cell.units.find((unit) => unit.value === '😀')
  const escaped = cell.units.find((unit) => unit.value === '*')
  assert.equal(authored.slice(entity.range.start, entity.range.end), '&amp;')
  assert.equal(authored.slice(emoji.range.start, emoji.range.end), '😀', 'one Unicode character owns its complete UTF-16 raw range')
  assert.equal(authored.slice(escaped.range.start, escaped.range.end), '\\*')
}

{
  const authored = '| A | B |\n| - | - |\n| **&amp; \\*** a \\| b<br>tail | stable |'
  const cell = parseTables(authored).tables[0].rows[1].cells[0]
  assert.equal(cell.patchable, false, 'formatted inline content remains opaque to source patching')
  assert.equal(cell.units[0].kind, 'opaque', 'patch units keep the complete strong node fail-closed')
  assert.equal(
    cell.mappingUnits.map((unit) => unit.kind === 'break' ? '\n' : unit.value || '').join(''),
    '& * a | b\ntail',
    'mapping units recursively decode positioned text and breaks inside formatted content'
  )
  const entity = cell.mappingUnits.find((unit) => unit.value === '&')
  const escapedStar = cell.mappingUnits.find((unit) => unit.value === '*')
  assert.equal(authored.slice(entity.range.start, entity.range.end), '&amp;')
  assert.equal(authored.slice(escapedStar.range.start, escapedStar.range.end), '\\*')
}

{
  const authored = [
    '| one | two | three |',
    '| --- | --- | --- |',
    '| short |',
    '| explicit empty |  |  |'
  ].join('\n')
  const parsed = parseTables(authored)
  const short = parsed.tables[0].rows[1]
  const explicit = parsed.tables[0].rows[2]
  assert.deepEqual(short.cells.map((cell) => cell.presence), ['present', 'missing', 'missing'])
  assert.equal(short.cells[1].range, null, 'virtual missing cells never invent a source range')
  assert.equal(short.cells[1].contentRange, null, 'virtual missing cells never invent a content range')
  assert.deepEqual(explicit.cells.map((cell) => cell.presence), ['present', 'present', 'present'])
  assert.ok(explicit.cells[1].range && explicit.cells[1].contentRange, 'an explicit empty cell owns a real authored range')
  assert.equal(explicit.cells[1].units.length, 0, 'explicit empty is semantically empty but distinct from missing metadata')
}

for (const fixture of [
  {
    label: 'outer pipes',
    authored: '| one | two | three |\n| --- | --- | --- |\n| short |',
    previous: '| one | two | three |\n| --- | --- | --- |\n| short |  |  |',
    next: '| one | two | three |\n| --- | --- | --- |\n| short |  | typed |',
    expected: '| one | two | three |\n| --- | --- | --- |\n| short |  | typed |'
  },
  {
    label: 'no outer pipes',
    authored: 'one | two | three\n--- | --- | ---\nshort',
    previous: 'one | two | three\n--- | --- | ---\nshort |  | ',
    next: 'one | two | three\n--- | --- | ---\nshort |  | typed',
    expected: 'one | two | three\n--- | --- | ---\nshort |  | typed'
  }
]) {
  const result = mapGfmTableChange({
    authored: fixture.authored,
    previousCanonical: fixture.previous,
    nextCanonical: fixture.next,
    parseTables
  })
  assert.equal(result.status, 'patched', `${fixture.label}: editing a virtual trailing cell is table-owned`)
  assert.equal(result.kind, 'materialized-cell', `${fixture.label}: missing cells are materialized deliberately`)
  assert.equal(result.markdown, fixture.expected, `${fixture.label}: the row's outer-pipe style is preserved`)
  assert.ok(result.sourceRange && result.sourceRange.start <= result.sourceRange.end)
}

{
  const authored = 'one | two | three\n--- | --- | ---\nshort \\|'
  const previousCanonical = 'one | two | three\n--- | --- | ---\nshort \\| |  | '
  const nextCanonical = 'one | two | three\n--- | --- | ---\nshort \\| |  | typed'
  const result = mapGfmTableChange({ authored, previousCanonical, nextCanonical, parseTables })
  assert.equal(result.status, 'patched', 'an escaped terminal pipe is cell content, not an outer delimiter')
  assert.equal(result.kind, 'materialized-cell')
  assert.equal(result.markdown, nextCanonical, 'virtual columns append after the complete escaped-pipe cell')
  const reparsedRow = parseTables(result.markdown).tables[0].rows[1]
  assert.equal(reparsedRow.cells[2].presence, 'present')
  assert.equal(
    reparsedRow.cells[2].units.map((unit) => unit.value || '').join(''),
    'typed',
    'the materialized value reparses at logical column 2'
  )
}

{
  const authored = [
    'before-sentinel',
    '| one | two |',
    '| :-- | --: |',
    '| old | row |',
    '',
    'after-sentinel'
  ].join('\n')
  const previousCanonical = authored
  const nextCanonical = [
    'before-sentinel',
    '| one | two |',
    '| --- | ---: |',
    '| old | row |',
    '| new | <br /> |',
    '',
    'after-sentinel'
  ].join('\n')
  const result = mapGfmTableChange({ authored, previousCanonical, nextCanonical, parseTables })
  assert.equal(result.status, 'patched', 'row/alignment changes replace their owning parsed table')
  assert.equal(result.kind, 'table-structure')
  assert.equal(result.markdown, [
    'before-sentinel',
    '| one | two |',
    '| --- | ---: |',
    '| old | row |',
    '| new |  |',
    '',
    'after-sentinel'
  ].join('\n'), 'structural replacement is table-bounded and removes only the serializer empty-cell placeholder')
  assert.equal(
    authored.slice(result.sourceRange.start, result.sourceRange.end),
    '| one | two |\n| :-- | --: |\n| old | row |',
    'structural sourceRange owns only the old table block'
  )
}

{
  const authored = [
    '| A | B | C |',
    '| - | - | - |',
    '| <br> |  | keep |'
  ].join('\n')
  const previousCanonical = [
    '| A | B | C |',
    '| - | - | - |',
    '| <br /> | <br /> | keep |'
  ].join('\n')
  const nextCanonical = `${previousCanonical}\n| new | <br /> | row |`
  const result = mapGfmTableChange({ authored, previousCanonical, nextCanonical, parseTables })
  assert.equal(result.status, 'patched', 'adding a row remains owned when an existing cell has a sole hardbreak')
  assert.equal(result.kind, 'table-structure')
  const table = parseTables(result.markdown).tables[0]
  assert.equal(table.rows[1].cells[0].units[0]?.kind, 'break', 'row add preserves the proven real hardbreak')
  assert.equal(table.rows[1].cells[1].units.length, 0, 'row add clears the proven existing empty-cell placeholder')
  assert.equal(table.rows[1].cells[2].units.map((unit) => unit.value || '').join(''), 'keep', 'row add preserves neighboring text')
  assert.equal(table.rows[2].cells[1].units.length, 0, 'row add clears a placeholder in the newly created row')
}

{
  const authored = [
    '# Before',
    '',
    '| one | two |',
    '| --- | --- |',
    '| old | stable |',
    '',
    'tail'
  ].join('\n')
  const nextCanonical = authored
    .replace('# Before', '# After')
    .replace('| old | stable |', '| typed | stable |')
  const result = mapGfmTableChange({ authored, previousCanonical: authored, nextCanonical, parseTables })
  assert.deepEqual(
    result,
    { status: 'unowned', reason: 'mixed-table-and-outside-change' },
    'one cell edit published with a heading edit fails closed atomically'
  )
}

{
  const authored = [
    'before',
    '',
    '| one | two |',
    '| --- | --- |',
    '| old | stable |',
    '',
    'tail before'
  ].join('\n')
  const nextCanonical = authored
    .replace('| old | stable |', '| old | stable |\n| new | row |')
    .replace('tail before', 'tail after')
  const result = mapGfmTableChange({ authored, previousCanonical: authored, nextCanonical, parseTables })
  assert.deepEqual(
    result,
    { status: 'unowned', reason: 'mixed-table-and-outside-change' },
    'one structural table edit published with a paragraph edit fails closed atomically'
  )
}

{
  const authored = [
    'A',
    '',
    '| one | two |',
    '| --- | --- |',
    '| old | stable |',
    '',
    'B',
    '',
    '',
    'C'
  ].join('\n')
  const nextCanonical = [
    'A',
    '',
    '',
    '',
    'B',
    '| one | two |',
    '| --- | --- |',
    '| typed | stable |',
    '',
    'C'
  ].join('\n')
  const result = mapGfmTableChange({
    authored,
    previousCanonical: authored,
    nextCanonical,
    change: commonChange(authored, nextCanonical),
    parseTables
  })
  assert.deepEqual(
    result,
    { status: 'unowned', reason: 'mixed-table-and-outside-change' },
    'moving and editing a table cannot hide behind equal concatenated outside text'
  )
}

{
  const authored = '| one | two |\n| --- | --- |\n| old | stable |'
  const nextCanonical = authored.replace('old', 'typed')
  const result = mapGfmTableChange({
    authored,
    previousCanonical: authored,
    nextCanonical,
    change: { start: 0, previousEnd: 0, nextEnd: 0 },
    parseTables
  })
  assert.deepEqual(
    result,
    { status: 'unowned', reason: 'invalid-table-change-range' },
    'a supplied transaction change must agree with the canonical common change'
  )
}

{
  const authored = '\uFEFFbefore\r\n\r\n| one | two |\r\n| --- | --- |\r\n| old | stable |\r\n'
  const nextCanonical = authored.replace('old', 'typed')
  const result = mapGfmTableChange({
    authored,
    previousCanonical: authored,
    nextCanonical,
    change: commonChange(authored, nextCanonical),
    parseTables
  })
  assert.equal(result.status, 'patched', 'a raw canonical change remains valid across BOM + CRLF normalization')
  assert.equal(result.markdown, authored.replace('old', 'typed'))
}

{
  const before = '\uFEFF# Demo\r\n\r\nTail\r\n'
  const insertedCanonical = [
    '\uFEFF# Demo',
    '',
    '| Name | Notes |',
    '| --- | --- |',
    '| <br /> | kept |',
    '',
    'Tail',
    ''
  ].join('\r\n')
  const expectedInserted = insertedCanonical.replace('<br />', '')
  const inserted = mapGfmTableChange({
    authored: before,
    previousCanonical: before,
    nextCanonical: insertedCanonical,
    parseTables
  })
  assert.equal(inserted.status, 'patched', 'a pure table insertion is owned')
  assert.equal(inserted.kind, 'table-structure')
  assert.equal(inserted.sourceRange.start, inserted.sourceRange.end, 'table insertion owns one source insertion point')
  assert.equal(inserted.sourceRange.start, before.indexOf('Tail'), 'the insertion point stays immediately before following text')
  assert.equal(inserted.markdown, expectedInserted, 'table insertion preserves BOM, CRLF, following text, and clears only placeholders')

  const deleted = mapGfmTableChange({
    authored: expectedInserted,
    previousCanonical: expectedInserted,
    nextCanonical: before,
    parseTables
  })
  assert.equal(deleted.status, 'patched', 'a pure table deletion is owned')
  assert.equal(deleted.kind, 'table-structure')
  assert.equal(
    expectedInserted.slice(deleted.sourceRange.start, deleted.sourceRange.end),
    ['| Name | Notes |', '| --- | --- |', '|  | kept |', '', ''].join('\r\n'),
    'table deletion owns exactly the parsed table plus its necessary separator'
  )
  assert.equal(deleted.markdown, before, 'table deletion preserves BOM, CRLF, and does not glue following text')
}

{
  const authoredFirst = [
    '| A | B | C |',
    '| - | - | - |',
    '| <br> |  | keep |'
  ].join('\n')
  const canonicalFirst = [
    '| A | B | C |',
    '| - | - | - |',
    '| <br /> | <br /> | keep |'
  ].join('\n')
  const insertedCanonicalTable = [
    '| X | Y |',
    '| - | - |',
    '| new | <br /> |'
  ].join('\n')
  const insertedSourceTable = insertedCanonicalTable.replace('<br />', '')
  const authoredBeforeInsert = `${authoredFirst}\n\nTail`
  const previousBeforeInsert = `${canonicalFirst}\n\nTail`
  const nextAfterInsert = `${canonicalFirst}\n\n${insertedCanonicalTable}\n\nTail`
  const inserted = mapGfmTableChange({
    authored: authoredBeforeInsert,
    previousCanonical: previousBeforeInsert,
    nextCanonical: nextAfterInsert,
    parseTables
  })
  assert.equal(inserted.status, 'patched', 'table insertion is owned across proven hardbreak/placeholder spellings')
  assert.equal(
    inserted.markdown,
    `${authoredFirst}\n\n${insertedSourceTable}\n\nTail`,
    'table insertion preserves the existing real break, empty cell, and text while clearing only the new placeholder'
  )

  const authoredBeforeDelete = `${authoredFirst}\n\n${insertedSourceTable}\n\nTail`
  const previousBeforeDelete = `${canonicalFirst}\n\n${insertedSourceTable}\n\nTail`
  const nextAfterDelete = `${canonicalFirst}\n\nTail`
  const deleted = mapGfmTableChange({
    authored: authoredBeforeDelete,
    previousCanonical: previousBeforeDelete,
    nextCanonical: nextAfterDelete,
    parseTables
  })
  assert.equal(deleted.status, 'patched', 'table deletion is owned across proven hardbreak/placeholder spellings')
  assert.equal(
    deleted.markdown,
    `${authoredFirst}\n\nTail`,
    'table deletion preserves the unchanged real break, empty cell, and neighboring text'
  )
}

for (const fixture of [
  {
    label: 'insert plus heading edit',
    authored: '# Before\n\nTail\n',
    next: '# After\n\n| A | B |\n| - | - |\n| x | y |\n\nTail\n'
  },
  {
    label: 'delete plus trailing paragraph edit',
    authored: '# Before\n\n| A | B |\n| - | - |\n| x | y |\n\nTail before\n',
    next: '# Before\n\nTail after\n'
  }
]) {
  const result = mapGfmTableChange({
    authored: fixture.authored,
    previousCanonical: fixture.authored,
    nextCanonical: fixture.next,
    parseTables
  })
  assert.deepEqual(
    result,
    { status: 'unowned', reason: 'mixed-table-and-outside-change' },
    `${fixture.label} fails closed instead of replacing a whole-document common change`
  )
}

{
  const authored = '| one | two |\n| --- | --- |\n| authored | stable |'
  const previousCanonical = '| one | two |\n| --- | --- |\n| different | stable |'
  const nextCanonical = '| one | two |\n| --- | --- |\n| different | typed |'
  const result = mapGfmTableChange({ authored, previousCanonical, nextCanonical, parseTables })
  assert.equal(result.status, 'unowned', 'a pre-existing authored/canonical token mismatch is never guessed through')
  assert.match(result.reason, /mismatch|ambiguous|unowned/)
}

{
  const authored = [
    '| a | b |',
    '| - | - |',
    '| first | stable |',
    '',
    '| c | d |',
    '| - | - |',
    '| second | stable |'
  ].join('\n')
  const nextCanonical = authored.replace('first', 'firstX').replace('second', 'secondX')
  const result = mapGfmTableChange({
    authored,
    previousCanonical: authored,
    nextCanonical,
    parseTables
  })
  assert.equal(result.status, 'unowned', 'one publication changing multiple parsed tables fails closed atomically')
  assert.match(result.reason, /multiple|ambiguous/)
}

{
  const authored = '| a | b |\n| - | - |\n| value | stable |'
  const ambiguousParseTables = (markdown) => {
    const parsed = parseTables(markdown)
    return parsed.tables.length
      ? { ...parsed, tables: [parsed.tables[0], { ...parsed.tables[0], index: 1 }] }
      : parsed
  }
  const result = mapGfmTableChange({
    authored,
    previousCanonical: authored,
    nextCanonical: authored.replace('value', 'typed'),
    parseTables: ambiguousParseTables
  })
  assert.equal(result.status, 'unowned', 'overlapping/duplicated parser ownership fails closed')
  assert.match(result.reason, /ambiguous|parser|model/)
}

{
  const authored = 'before\n\n| a | b |\n| - | - |\n| value | stable |\n'
  const result = mapGfmTableChange({
    authored,
    previousCanonical: authored,
    nextCanonical: authored.replace('before', 'after'),
    parseTables
  })
  assert.deepEqual(result, { status: 'not-table' }, 'a prose-only edit is not claimed by a neighboring table')
}

{
  const authored = '| a | b |\n| - | - |\n| value | stable |'
  const result = mapGfmTableChange({
    authored,
    previousCanonical: authored,
    nextCanonical: `${authored}\n\nAfter`,
    change: commonChange(authored, `${authored}\n\nAfter`),
    parseTables
  })
  assert.deepEqual(result, { status: 'not-table' }, 'a zero-width append at table.end belongs outside the table')
}

{
  let parseCalls = 0
  const result = mapGfmTableChange({
    authored: 'plain paragraph',
    previousCanonical: 'plain paragraph',
    nextCanonical: 'plain paragraph changed',
    parseTables() {
      parseCalls += 1
      throw new Error('tableless edits must not invoke the table parser')
    }
  })
  assert.deepEqual(result, { status: 'not-table' }, 'three no-pipe inputs take the safe generic fast path')
  assert.equal(parseCalls, 0)
}

{
  const authored = '| ab | cd |\n| - | - |\n| value | stable |'
  const nextCanonical = authored.replace('value', 'typed')
  const corruptions = [
    ['non-monotonic toRaw', (model) => { model.view.toRaw[3] = model.view.toRaw[2] - 1 }],
    ['overlapping rows', (model) => {
      model.tables[0].rows[1].range.start = model.tables[0].rows[0].range.end - 1
    }],
    ['overlapping cells', (model) => {
      model.tables[0].rows[0].cells[1].range.start = model.tables[0].rows[0].cells[0].range.end - 1
    }],
    ['unit outside content', (model) => {
      const cell = model.tables[0].rows[0].cells[0]
      cell.units[0].range.start = cell.contentRange.start - 1
    }],
    ['overlapping mapping units', (model) => {
      const units = model.tables[0].rows[0].cells[0].mappingUnits
      units[1].range.start = units[0].range.start
    }],
    ['wrong missingColumns', (model) => {
      model.tables[0].rows[1].missingColumns = 1
    }]
  ]
  for (const [label, corrupt] of corruptions) {
    const result = mapGfmTableChange({
      authored,
      previousCanonical: authored,
      nextCanonical,
      parseTables(markdown) {
        const model = mutableParsedModel(markdown)
        corrupt(model)
        return model
      }
    })
    assert.equal(result.status, 'unowned', `${label}: invalid parser ownership fails closed`)
    assert.match(result.reason, /invalid|ambiguous/, `${label}: failure identifies the parser model boundary`)
  }
}

{
  let parseCalls = 0
  const parseOnlyRemark = {
    parse(markdown) {
      parseCalls += 1
      return remark.parse(markdown)
    },
    runSync() {
      throw new Error('table source ownership must never run transforms')
    }
  }
  const cached = createGfmTableSourceParser(parseOnlyRemark)
  const markdown = '| one | two |\n| - | - |\n| a | b |'
  assert.equal(cached(markdown).tables.length, 1)
  assert.equal(cached(markdown).tables.length, 1)
  assert.equal(parseCalls, 1, 'the exact-string LRU reuses one parse result without invoking runSync')
  cached(`${markdown}\n`)
  assert.equal(parseCalls, 2, 'a byte-distinct source string gets its own parse result')
  assert.equal(buildGfmTableSourceModel(markdown, parseOnlyRemark).tables.length, 1)
  assert.equal(parseCalls, 3, 'the direct builder also calls remark.parse')
}

{
  let parseCalls = 0
  const instrumentedRemark = {
    parse(markdown) {
      parseCalls += 1
      return remark.parse(markdown)
    }
  }
  const parser = createGfmTableSourceParser(instrumentedRemark)
  const tableless = 'plain text\n'.repeat(2000)
  const compact = parser(tableless)
  assert.equal(parseCalls, 0, 'a no-pipe document bypasses remark table parsing')
  assert.deepEqual(compact.tables, [])
  assert.equal(compact.view.raw, tableless)
  assert.equal(compact.view.text, tableless)
  assert.equal('toRaw' in compact.view, false, 'cached tableless models do not retain a full raw-offset array')
  assert.equal(Object.isFrozen(compact), true)
  assert.equal(Object.isFrozen(compact.view), true)
  assert.equal(Object.isFrozen(compact.tables), true)
  assert.throws(() => compact.tables.push('pollution'), TypeError, 'cached models cannot be mutated by a consumer')
  assert.equal(parser(tableless), compact, 'an immutable exact-string cache hit may safely reuse model identity')

  let retainedSource = ''
  let retainedModel = null
  for (let index = 0; index < 6; index += 1) {
    retainedSource = `| A${index} | B |\n| - | - |\n| x | y |`
    retainedModel = parser(retainedSource)
  }
  const bounded = parser.cacheInfo()
  assert.equal(bounded.entries, 4, `cache must retain exactly its four-entry budget: ${JSON.stringify(bounded)}`)
  assert.ok(bounded.characters <= 1_500_000, `cache character budget exceeded: ${JSON.stringify(bounded)}`)
  assert.equal(parser(retainedSource), retainedModel, 'the most-recent entry remains retained by identity')
  assert.equal(parseCalls, 6, 'a retained cache hit does not reparse')

  const beforeHuge = parser.cacheInfo()
  const hugeTableless = 'x'.repeat(1_500_001)
  const hugeModel = parser(hugeTableless)
  assert.equal(hugeModel.tables.length, 0)
  assert.equal('toRaw' in hugeModel.view, false)
  assert.deepEqual(parser.cacheInfo(), beforeHuge, 'an over-budget document is returned but never retained')
  assert.equal(parseCalls, 6, 'tableless fast paths never call remark.parse, even when over budget')

  const sharedA = getGfmTableSourceParser(instrumentedRemark)
  const sharedB = getGfmTableSourceParser(instrumentedRemark)
  assert.equal(sharedA, sharedB, 'one configured remark processor owns one shared parser/cache')
}

console.log('PASS table source model: AST-owned cells preserve authored bytes and fail closed on ambiguity')
