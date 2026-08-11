import {
  createMarkdownSourceView,
  normalizedOffsetFromRaw
} from '../markdown-source-view.js'
import {
  adaptCanonicalRegionToSource,
  commonChange
} from './core.js'
import {
  isUnescapedPipeAt,
  isValidGfmTableSourceModel
} from './table-source-parse.js'

const parseModels = (parseTables, values) => {
  if (typeof parseTables !== 'function') return null
  try {
    const models = values.map((value) => parseTables(value))
    return models.every((model, index) => (
      isValidGfmTableSourceModel(model, values[index])
    )) ? models : null
  } catch {
    return null
  }
}

const unitKey = (unit) => `${unit.kind}:${unit.kind === 'break' ? '\n' : String(unit.value ?? '')}`
// `canonical: true` is reserved for previousCanonical/nextCanonical supplied by
// Milkdown's serializer, where an exact sole `<br />` denotes its empty-cell
// placeholder. Authored source always uses `canonical: false`, so the same raw
// spelling remains a semantic break and can never be folded by this comparison.
const cellKey = (cell, model, canonical = false) => {
  if (!cell || cell.presence === 'missing') return ''
  if (canonical && isSerializerPlaceholderCell(cell, model)) return ''
  return cell.units.map(unitKey).join('\u0000')
}

const rowActualCellCount = (row) => {
  let count = row.cells.length
  while (count > 0 && row.cells[count - 1]?.presence === 'missing') count -= 1
  return count
}

const tableShapeEqual = (left, right) => {
  if (!left || !right || left.width !== right.width || left.rows.length !== right.rows.length) return false
  if (left.align.some((value, index) => value !== right.align[index])) return false
  return left.rows.every((row, rowIndex) => row.kind === right.rows[rowIndex]?.kind)
}

const tableDurableContentEqual = (left, leftModel, right, rightModel) => (
  left.rows.every((row, rowIndex) => {
    const other = right.rows[rowIndex]
    const columns = Math.max(row.cells.length, other.cells.length, left.width)
    for (let column = 0; column < columns; column += 1) {
      if (cellKey(row.cells[column], leftModel, true) !== cellKey(other.cells[column], rightModel, true)) {
        return false
      }
    }
    return true
  })
)

const tableDurableEqual = (left, leftModel, right, rightModel) => (
  tableShapeEqual(left, right) &&
  tableDurableContentEqual(left, leftModel, right, rightModel)
)

const authoredMatchesPrevious = (authored, authoredModel, previous, previousModel) => {
  if (!tableShapeEqual(authored, previous)) return false
  return authored.rows.every((row, rowIndex) => {
    const previousRow = previous.rows[rowIndex]
    const columns = Math.max(row.cells.length, previousRow.cells.length, authored.width)
    for (let column = 0; column < columns; column += 1) {
      const sourceCell = row.cells[column]
      const canonicalCell = previousRow.cells[column]
      const sourceKey = cellKey(sourceCell, authoredModel, false)
      const canonicalKey = cellKey(canonicalCell, previousModel, true)
      if (sourceKey !== canonicalKey) return false
      if (
        sourceCell?.presence !== canonicalCell?.presence &&
        sourceKey !== ''
      ) return false
    }
    return true
  })
}

const changedCellCoordinates = (previous, previousModel, next, nextModel) => {
  const changed = []
  for (let row = 0; row < previous.rows.length; row += 1) {
    const left = previous.rows[row]
    const right = next.rows[row]
    const columns = Math.max(left.cells.length, right.cells.length, previous.width)
    for (let column = 0; column < columns; column += 1) {
      if (cellKey(left.cells[column], previousModel, true) !== cellKey(right.cells[column], nextModel, true)) {
        changed.push({ row, column })
      }
    }
  }
  return changed
}

const commonUnitChange = (previous, next) => {
  let start = 0
  while (start < previous.length && start < next.length && unitKey(previous[start]) === unitKey(next[start])) {
    start += 1
  }
  let previousEnd = previous.length
  let nextEnd = next.length
  while (
    previousEnd > start &&
    nextEnd > start &&
    unitKey(previous[previousEnd - 1]) === unitKey(next[nextEnd - 1])
  ) {
    previousEnd -= 1
    nextEnd -= 1
  }
  return { start, previousEnd, nextEnd }
}

const unitBoundary = (cell, index, side) => {
  if (!cell?.contentRange || !Array.isArray(cell.units)) return null
  if (index <= 0) return cell.units[0]?.range.start ?? cell.contentRange.start
  if (index >= cell.units.length) return cell.units.at(-1)?.range.end ?? cell.contentRange.end
  return side === 'end' ? cell.units[index - 1].range.end : cell.units[index].range.start
}

const unitsRaw = (model, units, start, end) => {
  if (start >= end) return ''
  const first = units[start]?.range
  const last = units[end - 1]?.range
  if (!first || !last || first.start > last.end) return null
  return model.view.raw.slice(first.start, last.end)
}

const isSerializerPlaceholderCell = (cell, model) => Boolean(
  cell?.presence === 'present' &&
  cell.units?.length === 1 &&
  cell.units[0].kind === 'break' &&
  cell.contentRange &&
  model.view.raw.slice(cell.contentRange.start, cell.contentRange.end) === '<br />'
)

export const normalizeGfmTableSerializerPlaceholders = (markdown, parseTables) => {
  const source = String(markdown ?? '')
  let model
  try {
    model = parseTables(source)
  } catch {
    return source
  }
  if (!isValidGfmTableSourceModel(model, source)) return source
  const ranges = []
  for (const table of model.tables) {
    for (const row of table.rows) {
      for (const cell of row.cells) {
        if (isSerializerPlaceholderCell(cell, model)) ranges.push(cell.contentRange)
      }
    }
  }
  ranges.sort((left, right) => right.start - left.start)
  return ranges.reduce(
    (result, range) => result.slice(0, range.start) + result.slice(range.end),
    source
  )
}

const materializeMissingCell = ({ authoredModel, table, row, column, nextCell, nextModel }) => {
  const actual = rowActualCellCount(row)
  if (column < actual || !nextCell || nextCell.presence !== 'present' || !nextCell.patchable) return null
  const contents = []
  for (let index = actual; index <= column; index += 1) {
    const cell = nextModel.tables[table.index].rows[row.index].cells[index]
    if (!cell || cell.presence !== 'present' || !cell.contentRange) return null
    const key = cellKey(cell, nextModel, true)
    if (index < column && key !== '') return null
    const content = isSerializerPlaceholderCell(cell, nextModel)
      ? ''
      : nextModel.view.raw.slice(cell.contentRange.start, cell.contentRange.end)
    contents.push(content)
  }

  const rowRaw = authoredModel.view.raw.slice(row.range.start, row.range.end)
  let first = 0
  let last = rowRaw.length - 1
  while (first <= last && (rowRaw[first] === ' ' || rowRaw[first] === '\t')) first += 1
  while (last >= first && (rowRaw[last] === ' ' || rowRaw[last] === '\t')) last -= 1
  const hasTrailingOuterPipe = isUnescapedPipeAt(rowRaw, last, first)
  const sourceRange = hasTrailingOuterPipe
    ? { start: row.range.start + last, end: row.range.start + last + 1 }
    : { start: row.range.end, end: row.range.end }
  const replacement = hasTrailingOuterPipe
    ? contents.map((content) => `| ${content} `).join('') + '|'
    : contents.map((content) => ` | ${content}`).join('')
  return {
    sourceRange,
    replacement: adaptCanonicalRegionToSource(replacement, authoredModel.view.raw, sourceRange)
  }
}

const rangeTouchesChange = (range, changeRange) => {
  if (!range || !changeRange) return false
  if (changeRange.start === changeRange.end) {
    return changeRange.start >= range.start && changeRange.start < range.end
  }
  return changeRange.start < range.end && changeRange.end > range.start
}

const modelRawRange = (model, start, end) => {
  if (typeof model?.view?.rawRange === 'function') {
    return model.view.rawRange(start, end)
  }
  return createMarkdownSourceView(model?.view?.raw ?? '').rawRange(start, end)
}

const normalizedTableRange = (model, table) => {
  if (!model?.view || !table?.range) return null
  const start = normalizedOffsetFromRaw(model.view, table.range.start)
  const end = normalizedOffsetFromRaw(model.view, table.range.end)
  return Number.isInteger(start) && Number.isInteger(end) && start <= end
    ? { start, end }
    : null
}

const tableContext = (model, table) => {
  const range = normalizedTableRange(model, table)
  if (!range || !table?.range) return null
  return {
    normalizedPrefix: model.view.text.slice(0, range.start),
    normalizedSuffix: model.view.text.slice(range.end),
    rawPrefix: model.view.raw.slice(0, table.range.start),
    rawSuffix: model.view.raw.slice(table.range.end)
  }
}

const tablesHaveIdenticalOutsideText = (previousModel, previousTable, nextModel, nextTable) => {
  const previousContext = tableContext(previousModel, previousTable)
  const nextContext = tableContext(nextModel, nextTable)
  return previousContext != null &&
    previousContext.normalizedPrefix === nextContext.normalizedPrefix &&
    previousContext.normalizedSuffix === nextContext.normalizedSuffix &&
    previousContext.rawPrefix === nextContext.rawPrefix &&
    previousContext.rawSuffix === nextContext.rawSuffix
}

const changeEquals = (left, right) => Boolean(
  left &&
  Number.isInteger(left.start) &&
  Number.isInteger(left.previousEnd) &&
  Number.isInteger(left.nextEnd) &&
  left.start === right.start &&
  left.previousEnd === right.previousEnd &&
  left.nextEnd === right.nextEnd
)

const changeTouchesOwningTable = (change, previousModel, previousTable, nextModel, nextTable) => {
  const previousRaw = modelRawRange(previousModel, change.start, change.previousEnd)
  const nextRaw = modelRawRange(nextModel, change.start, change.nextEnd)
  return rangeTouchesChange(previousTable?.range, previousRaw) ||
    rangeTouchesChange(nextTable?.range, nextRaw)
}

const unmatchedTableIndex = (shorterModel, longerModel) => {
  if (longerModel.tables.length !== shorterModel.tables.length + 1) return null
  const candidates = []
  for (let skipped = 0; skipped < longerModel.tables.length; skipped += 1) {
    const matches = shorterModel.tables.every((table, index) => {
      const longerIndex = index < skipped ? index : index + 1
      return tableDurableEqual(
        table,
        shorterModel,
        longerModel.tables[longerIndex],
        longerModel
      )
    })
    if (matches) candidates.push(skipped)
  }
  return candidates.length === 1 ? candidates[0] : null
}

const whitespaceOutsideOwnedTable = (text, changeStart, changeEnd, tableRange) => {
  if (
    !tableRange ||
    changeStart > tableRange.start ||
    changeEnd < tableRange.end
  ) return false
  return /^[\t \n]*$/.test(
    text.slice(changeStart, tableRange.start) + text.slice(tableRange.end, changeEnd)
  )
}

const exactBaselineTableCountChange = ({
  authoredModel,
  previousModel,
  nextModel,
  parseTables
}) => {
  if (authoredModel.view.text !== previousModel.view.text) {
    return { status: 'unowned', reason: 'ambiguous-table-count-change' }
  }
  if (Math.abs(previousModel.tables.length - nextModel.tables.length) !== 1) {
    return { status: 'unowned', reason: 'ambiguous-table-count-change' }
  }

  const normalizedNext = normalizeGfmTableSerializerPlaceholders(nextModel.view.raw, parseTables)
  let normalizedNextModel = nextModel
  if (normalizedNext !== nextModel.view.raw) {
    try {
      normalizedNextModel = parseTables(normalizedNext)
    } catch {
      return { status: 'unowned', reason: 'invalid-or-ambiguous-table-model' }
    }
    if (!isValidGfmTableSourceModel(normalizedNextModel, normalizedNext)) {
      return { status: 'unowned', reason: 'invalid-or-ambiguous-table-model' }
    }
  }

  const insertion = normalizedNextModel.tables.length === previousModel.tables.length + 1
  const shorterModel = insertion ? previousModel : normalizedNextModel
  const longerModel = insertion ? normalizedNextModel : previousModel
  const owningIndex = unmatchedTableIndex(shorterModel, longerModel)
  if (owningIndex == null) {
    return { status: 'unowned', reason: 'mixed-table-and-outside-change' }
  }

  const canonicalChange = commonChange(previousModel.view.text, normalizedNextModel.view.text)
  const owningTable = longerModel.tables[owningIndex]
  const owningRange = normalizedTableRange(longerModel, owningTable)
  const shorterChangeIsEmpty = insertion
    ? canonicalChange.previousEnd === canonicalChange.start
    : canonicalChange.nextEnd === canonicalChange.start
  const longerChangeEnd = insertion ? canonicalChange.nextEnd : canonicalChange.previousEnd
  if (
    !shorterChangeIsEmpty ||
    !whitespaceOutsideOwnedTable(
      longerModel.view.text,
      canonicalChange.start,
      longerChangeEnd,
      owningRange
    )
  ) return { status: 'unowned', reason: 'mixed-table-and-outside-change' }

  const sourceRange = modelRawRange(
    authoredModel,
    canonicalChange.start,
    canonicalChange.previousEnd
  )
  const replacementRange = modelRawRange(
    normalizedNextModel,
    canonicalChange.start,
    canonicalChange.nextEnd
  )
  if (!sourceRange || !replacementRange) {
    return { status: 'unowned', reason: 'unmappable-table-count-change' }
  }
  return {
    status: 'patched',
    sourceRange,
    replacement: normalizedNextModel.view.raw.slice(replacementRange.start, replacementRange.end)
  }
}

export function mapGfmTableChange({
  authored,
  previousCanonical,
  nextCanonical,
  change = null,
  parseTables
}) {
  const source = String(authored ?? '')
  const previous = String(previousCanonical ?? '')
  const next = String(nextCanonical ?? '')
  if (!source.includes('|') && !previous.includes('|') && !next.includes('|')) {
    return { status: 'not-table' }
  }
  const models = parseModels(parseTables, [source, previous, next])
  if (!models) return { status: 'unowned', reason: 'invalid-or-ambiguous-table-model' }
  const [authoredModel, previousModel, nextModel] = models
  if (models.every((model) => model.tables.length === 0)) {
    return { status: 'not-table' }
  }
  const rawCanonicalChange = commonChange(previous, next)
  if (change != null && !changeEquals(change, rawCanonicalChange)) {
    return { status: 'unowned', reason: 'invalid-table-change-range' }
  }
  const canonicalChange = commonChange(previousModel.view.text, nextModel.view.text)

  if (previousModel.tables.length !== nextModel.tables.length) {
    const exact = exactBaselineTableCountChange({
      authoredModel,
      previousModel,
      nextModel,
      parseTables
    })
    if (exact.status !== 'patched') return exact
    const replacement = adaptCanonicalRegionToSource(exact.replacement, source, exact.sourceRange)
    return {
      status: 'patched',
      markdown: source.slice(0, exact.sourceRange.start) + replacement + source.slice(exact.sourceRange.end),
      kind: 'table-structure',
      sourceRange: exact.sourceRange
    }
  }

  const changedTables = []
  for (let index = 0; index < previousModel.tables.length; index += 1) {
    const previousTable = previousModel.tables[index]
    const nextTable = nextModel.tables[index]
    const shapeEqual = tableShapeEqual(previousTable, nextTable)
    if (
      !shapeEqual ||
      !tableDurableContentEqual(previousTable, previousModel, nextTable, nextModel)
    ) changedTables.push({ index, shapeEqual })
  }

  if (!changedTables.length) {
    const normalizedChange = commonChange(previousModel.view.text, nextModel.view.text)
    const previousRawChange = modelRawRange(
      previousModel,
      normalizedChange.start,
      normalizedChange.previousEnd
    )
    const nextRawChange = modelRawRange(
      nextModel,
      normalizedChange.start,
      normalizedChange.nextEnd
    )
    const touched = previousModel.tables.filter((table, index) => (
      rangeTouchesChange(table.range, previousRawChange) ||
      rangeTouchesChange(nextModel.tables[index]?.range, nextRawChange)
    ))
    if (!touched.length) return { status: 'not-table' }
    if (touched.length > 1) return { status: 'unowned', reason: 'ambiguous-multiple-table-format-change' }
    const index = touched[0].index
    if (!tablesHaveIdenticalOutsideText(
      previousModel,
      previousModel.tables[index],
      nextModel,
      nextModel.tables[index]
    )) return { status: 'unowned', reason: 'mixed-table-and-outside-change' }
    if (!authoredMatchesPrevious(
      authoredModel.tables[index],
      authoredModel,
      previousModel.tables[index],
      previousModel
    )) return { status: 'unowned', reason: 'authored-previous-table-mismatch' }
    return {
      status: 'patched',
      markdown: source,
      kind: 'cell-text',
      sourceRange: authoredModel.tables[index].range
    }
  }

  if (changedTables.length > 1) {
    return { status: 'unowned', reason: 'ambiguous-multiple-table-change' }
  }
  const { index, shapeEqual } = changedTables[0]
  const authoredTable = authoredModel.tables[index]
  const previousTable = previousModel.tables[index]
  const nextTable = nextModel.tables[index]
  if (!tablesHaveIdenticalOutsideText(previousModel, previousTable, nextModel, nextTable)) {
    return { status: 'unowned', reason: 'mixed-table-and-outside-change' }
  }
  if (!changeTouchesOwningTable(
    canonicalChange,
    previousModel,
    previousTable,
    nextModel,
    nextTable
  )) return { status: 'unowned', reason: 'table-change-outside-owning-range' }
  if (!authoredTable || !authoredMatchesPrevious(
    authoredTable,
    authoredModel,
    previousTable,
    previousModel
  )) return { status: 'unowned', reason: 'authored-previous-table-mismatch' }

  if (!shapeEqual) {
    const nextBlock = nextModel.view.raw.slice(nextTable.range.start, nextTable.range.end)
    // Normalize against the already parsed whole document instead of trusting
    // a line-oriented table split. Ranges are table-local here.
    const placeholderRanges = []
    for (const row of nextTable.rows) {
      for (const cell of row.cells) {
        if (isSerializerPlaceholderCell(cell, nextModel)) {
          placeholderRanges.push({
            start: cell.contentRange.start - nextTable.range.start,
            end: cell.contentRange.end - nextTable.range.start
          })
        }
      }
    }
    placeholderRanges.sort((left, right) => right.start - left.start)
    const replacementBlock = placeholderRanges.reduce(
      (value, range) => value.slice(0, range.start) + value.slice(range.end),
      nextBlock
    )
    const replacement = adaptCanonicalRegionToSource(replacementBlock, source, authoredTable.range)
    return {
      status: 'patched',
      markdown: source.slice(0, authoredTable.range.start) + replacement + source.slice(authoredTable.range.end),
      kind: 'table-structure',
      sourceRange: authoredTable.range
    }
  }

  const changedCells = changedCellCoordinates(previousTable, previousModel, nextTable, nextModel)
  if (changedCells.length !== 1) return { status: 'unowned', reason: 'ambiguous-table-cell-change' }
  const coordinate = changedCells[0]
  const authoredRow = authoredTable.rows[coordinate.row]
  const authoredCell = authoredRow?.cells[coordinate.column]
  const previousCell = previousTable.rows[coordinate.row]?.cells[coordinate.column]
  const nextCell = nextTable.rows[coordinate.row]?.cells[coordinate.column]
  if (!authoredRow || !previousCell || !nextCell) {
    return { status: 'unowned', reason: 'missing-table-cell-coordinate' }
  }

  if (authoredCell?.presence === 'missing') {
    const materialized = materializeMissingCell({
      authoredModel,
      table: authoredTable,
      row: authoredRow,
      column: coordinate.column,
      nextCell,
      nextModel
    })
    if (!materialized) return { status: 'unowned', reason: 'unowned-missing-cell-materialization' }
    return {
      status: 'patched',
      markdown: source.slice(0, materialized.sourceRange.start) +
        materialized.replacement +
        source.slice(materialized.sourceRange.end),
      kind: 'materialized-cell',
      sourceRange: materialized.sourceRange
    }
  }

  if (!authoredCell?.patchable || !previousCell.patchable || !nextCell.patchable) {
    return { status: 'unowned', reason: 'table-cell-unpatchable-token' }
  }
  if (cellKey(authoredCell, authoredModel, false) !== cellKey(previousCell, previousModel, true)) {
    return { status: 'unowned', reason: 'authored-previous-cell-token-mismatch' }
  }
  const unitChange = commonUnitChange(previousCell.units, nextCell.units)
  const rawStart = unitBoundary(authoredCell, unitChange.start, 'start')
  const rawEnd = unitBoundary(authoredCell, unitChange.previousEnd, 'end')
  const rawReplacement = unitsRaw(nextModel, nextCell.units, unitChange.start, unitChange.nextEnd)
  if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd) || rawStart > rawEnd || rawReplacement == null) {
    return { status: 'unowned', reason: 'unmappable-table-cell-unit-range' }
  }
  const sourceRange = { start: rawStart, end: rawEnd }
  const replacement = adaptCanonicalRegionToSource(rawReplacement, source, sourceRange)
  return {
    status: 'patched',
    markdown: source.slice(0, sourceRange.start) + replacement + source.slice(sourceRange.end),
    kind: 'cell-text',
    sourceRange
  }
}
