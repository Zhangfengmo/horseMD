import { decodeNamedCharacterReference } from 'decode-named-character-reference'
import {
  createMarkdownSourceView,
  normalizedOffsetFromRaw
} from '../markdown-source-view.js'
import {
  adaptCanonicalRegionToSource,
  commonChange
} from './core.js'

const CACHE_LIMIT = 12
const HTML_BREAK = /^<br\s*\/?>$/i
const ESCAPABLE = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/

const positionOffsets = (position) => {
  const start = position?.start?.offset
  const end = position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end) return null
  return { start, end }
}

const rawRangeFor = (view, position) => {
  const offsets = positionOffsets(position)
  return offsets ? view.rawRange(offsets.start, offsets.end) : null
}

const withoutPositions = (node) => {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(withoutPositions)
  const result = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'position') continue
    result[key] = withoutPositions(value)
  }
  return result
}

const decodeEntity = (body) => {
  if (body[0] !== '#') return decodeNamedCharacterReference(body) || null
  const hex = body[1]?.toLowerCase() === 'x'
  const digits = body.slice(hex ? 2 : 1)
  if (!digits || !(hex ? /^[0-9a-f]+$/i : /^\d+$/).test(digits)) return null
  const value = Number.parseInt(digits, hex ? 16 : 10)
  if (!Number.isFinite(value) || value < 0 || value > 0x10FFFF) return null
  try {
    return String.fromCodePoint(value)
  } catch {
    return null
  }
}

const textUnits = (view, node) => {
  const normalized = positionOffsets(node.position)
  const rawRange = rawRangeFor(view, node.position)
  if (!normalized || !rawRange) return null
  const spelling = view.text.slice(normalized.start, normalized.end)
  const units = []
  let index = 0
  while (index < spelling.length) {
    const rawStart = normalized.start + index
    if (
      spelling[index] === '\\' &&
      index + 1 < spelling.length &&
      ESCAPABLE.test(spelling[index + 1])
    ) {
      const range = view.rawRange(rawStart, rawStart + 2)
      if (!range) return null
      units.push({ kind: 'char', value: spelling[index + 1], range })
      index += 2
      continue
    }
    if (spelling[index] === '&') {
      const match = spelling.slice(index).match(/^&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/i)
      if (match) {
        const value = decodeEntity(match[1])
        if (value != null) {
          const range = view.rawRange(rawStart, rawStart + match[0].length)
          if (!range) return null
          units.push({ kind: 'char', value, range })
          index += match[0].length
          continue
        }
      }
    }
    const value = String.fromCodePoint(spelling.codePointAt(index))
    const range = view.rawRange(rawStart, rawStart + value.length)
    if (!range) return null
    units.push({ kind: 'char', value, range })
    index += value.length
  }
  return units.map((unit) => unit.value).join('') === String(node.value ?? '')
    ? units
    : null
}

const opaqueUnit = (view, node) => {
  const range = rawRangeFor(view, node.position)
  return range
    ? [{ kind: 'opaque', value: JSON.stringify(withoutPositions(node)), range }]
    : []
}

const unitsForCell = (view, node) => {
  const units = []
  let patchable = true
  for (const child of node.children || []) {
    if (child?.type === 'text') {
      const decoded = textUnits(view, child)
      if (!decoded) {
        patchable = false
        units.push(...opaqueUnit(view, child))
      } else {
        units.push(...decoded)
      }
      continue
    }
    if (child?.type === 'html') {
      const range = rawRangeFor(view, child.position)
      const spelling = range ? view.raw.slice(range.start, range.end) : ''
      if (range && HTML_BREAK.test(spelling)) {
        units.push({ kind: 'break', range })
      } else {
        patchable = false
        units.push(...opaqueUnit(view, child))
      }
      continue
    }
    patchable = false
    units.push(...opaqueUnit(view, child))
  }
  if ((node.children || []).some((child) => !rawRangeFor(view, child.position))) patchable = false
  return { units, patchable }
}

const normalizedCellContentRange = (text, position) => {
  const range = positionOffsets(position)
  if (!range) return null
  let start = range.start
  let end = range.end
  if (text[start] === '|') start += 1
  if (end > start && text[end - 1] === '|') end -= 1
  while (start < end && (text[start] === ' ' || text[start] === '\t')) start += 1
  while (end > start && (text[end - 1] === ' ' || text[end - 1] === '\t')) end -= 1
  return { start, end }
}

const buildPresentCell = (view, node, row, column) => {
  const range = rawRangeFor(view, node.position)
  const normalizedContent = normalizedCellContentRange(view.text, node.position)
  const contentRange = normalizedContent
    ? view.rawRange(normalizedContent.start, normalizedContent.end)
    : null
  const { units, patchable } = unitsForCell(view, node)
  const positionsAreOwned = Boolean(range && contentRange && units.every((unit) => unit.range))
  return {
    row,
    column,
    presence: 'present',
    range,
    contentRange,
    units,
    patchable: patchable && positionsAreOwned
  }
}

const buildMissingCell = (row, column) => ({
  row,
  column,
  presence: 'missing',
  range: null,
  contentRange: null,
  units: [],
  patchable: false
})

const delimiterOffsets = (text, tableNode, headerNode, firstBodyNode) => {
  const table = positionOffsets(tableNode.position)
  const header = positionOffsets(headerNode?.position)
  const firstBody = positionOffsets(firstBodyNode?.position)
  if (!table || !header) return null
  const newline = text.indexOf('\n', header.end)
  if (newline < 0 || newline >= table.end) return null
  const start = newline + 1
  const nextNewline = text.indexOf('\n', start)
  const end = nextNewline < 0 ? table.end : Math.min(nextNewline, table.end)
  if (start > end || (firstBody && firstBody.start < end)) return null
  return { start, end }
}

const buildTable = (view, node, index) => {
  const rowNodes = Array.isArray(node.children)
    ? node.children.filter((child) => child?.type === 'tableRow')
    : []
  const headerNode = rowNodes[0]
  const width = Array.isArray(headerNode?.children) ? headerNode.children.length : 0
  const normalizedDelimiter = delimiterOffsets(view.text, node, headerNode, rowNodes[1])
  const range = rawRangeFor(view, node.position)
  const delimiterRange = normalizedDelimiter
    ? view.rawRange(normalizedDelimiter.start, normalizedDelimiter.end)
    : null
  const rows = rowNodes.map((rowNode, rowIndex) => {
    const actual = Array.isArray(rowNode.children)
      ? rowNode.children.filter((child) => child?.type === 'tableCell')
      : []
    const cells = actual.map((cell, column) => buildPresentCell(view, cell, rowIndex, column))
    for (let column = cells.length; column < width; column += 1) {
      cells.push(buildMissingCell(rowIndex, column))
    }
    return {
      index: rowIndex,
      kind: rowIndex === 0 ? 'header' : 'body',
      range: rawRangeFor(view, rowNode.position),
      missingColumns: Math.max(0, width - actual.length),
      cells
    }
  })
  return {
    index,
    range,
    delimiterRange,
    width,
    align: Array.from({ length: width }, (_, column) => node.align?.[column] ?? null),
    rows
  }
}

export function buildGfmTableSourceModel(markdown, remark) {
  const view = createMarkdownSourceView(markdown)
  if (!remark || typeof remark.parse !== 'function') {
    throw new TypeError('A configured remark parser is required for GFM table source ownership')
  }
  const tree = remark.parse(view.text)
  const tableNodes = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'table') tableNodes.push(node)
    if (Array.isArray(node.children)) node.children.forEach(walk)
  }
  walk(tree)
  tableNodes.sort((left, right) => (
    (left.position?.start?.offset ?? Number.MAX_SAFE_INTEGER) -
    (right.position?.start?.offset ?? Number.MAX_SAFE_INTEGER)
  ))
  return {
    view,
    tables: tableNodes.map((node, index) => buildTable(view, node, index))
  }
}

export function createGfmTableSourceParser(remark) {
  const cache = new Map()
  return (markdown) => {
    const key = String(markdown ?? '')
    if (cache.has(key)) {
      const value = cache.get(key)
      cache.delete(key)
      cache.set(key, value)
      return value
    }
    const value = buildGfmTableSourceModel(key, remark)
    cache.set(key, value)
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
    return value
  }
}

const isRange = (range, rawLength) => Boolean(
  range &&
  Number.isInteger(range.start) &&
  Number.isInteger(range.end) &&
  range.start >= 0 &&
  range.start <= range.end &&
  range.end <= rawLength
)

const isValidModel = (model, markdown) => {
  if (!model || model.view?.raw !== String(markdown ?? '') || !Array.isArray(model.tables)) return false
  let previousEnd = -1
  for (let index = 0; index < model.tables.length; index += 1) {
    const table = model.tables[index]
    if (
      table?.index !== index ||
      !Number.isInteger(table.width) ||
      table.width < 1 ||
      !isRange(table.range, model.view.raw.length) ||
      !isRange(table.delimiterRange, model.view.raw.length) ||
      table.range.start < previousEnd ||
      table.delimiterRange.start < table.range.start ||
      table.delimiterRange.end > table.range.end ||
      !Array.isArray(table.align) ||
      table.align.length !== table.width ||
      !Array.isArray(table.rows) ||
      !table.rows.length
    ) return false
    previousEnd = table.range.end
    for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
      const row = table.rows[rowIndex]
      if (
        row?.index !== rowIndex ||
        row.kind !== (rowIndex === 0 ? 'header' : 'body') ||
        !isRange(row.range, model.view.raw.length) ||
        row.range.start < table.range.start ||
        row.range.end > table.range.end ||
        !Array.isArray(row.cells) ||
        row.cells.length < table.width
      ) return false
      let sawMissing = false
      for (let column = 0; column < row.cells.length; column += 1) {
        const cell = row.cells[column]
        if (cell?.row !== rowIndex || cell.column !== column) return false
        if (cell.presence === 'missing') {
          sawMissing = true
          if (cell.range !== null || cell.contentRange !== null || cell.units?.length) return false
          continue
        }
        if (cell.presence !== 'present' || sawMissing) return false
        if (
          !isRange(cell.range, model.view.raw.length) ||
          !isRange(cell.contentRange, model.view.raw.length) ||
          cell.range.start < row.range.start ||
          cell.range.end > row.range.end ||
          cell.contentRange.start < cell.range.start ||
          cell.contentRange.end > cell.range.end ||
          !Array.isArray(cell.units) ||
          cell.units.some((unit) => !['char', 'break', 'opaque'].includes(unit?.kind) || !isRange(unit.range, model.view.raw.length))
        ) return false
      }
    }
  }
  return true
}

const parseModels = (parseTables, values) => {
  if (typeof parseTables !== 'function') return null
  try {
    const models = values.map((value) => parseTables(value))
    return models.every((model, index) => isValidModel(model, values[index])) ? models : null
  } catch {
    return null
  }
}

const unitKey = (unit) => `${unit.kind}:${unit.kind === 'break' ? '\n' : String(unit.value ?? '')}`
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
  if (!isValidModel(model, source)) return source
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
  const hasTrailingOuterPipe = rowRaw[last] === '|'
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
    return changeRange.start >= range.start && changeRange.start <= range.end
  }
  return changeRange.start < range.end && changeRange.end > range.start
}

const normalizedTableRange = (model, table) => {
  if (!model?.view || !table?.range) return null
  const start = normalizedOffsetFromRaw(model.view, table.range.start)
  const end = normalizedOffsetFromRaw(model.view, table.range.end)
  return Number.isInteger(start) && Number.isInteger(end) && start <= end
    ? { start, end }
    : null
}

const textOutsideTable = (model, table) => {
  const range = normalizedTableRange(model, table)
  return range
    ? model.view.text.slice(0, range.start) + model.view.text.slice(range.end)
    : null
}

const tablesHaveIdenticalOutsideText = (previousModel, previousTable, nextModel, nextTable) => {
  const previousOutside = textOutsideTable(previousModel, previousTable)
  const nextOutside = textOutsideTable(nextModel, nextTable)
  return previousOutside != null && previousOutside === nextOutside
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
  const previousRaw = previousModel.view.rawRange(change.start, change.previousEnd)
  const nextRaw = nextModel.view.rawRange(change.start, change.nextEnd)
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
    if (!isValidModel(normalizedNextModel, normalizedNext)) {
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

  const sourceRange = authoredModel.view.rawRange(
    canonicalChange.start,
    canonicalChange.previousEnd
  )
  const replacementRange = normalizedNextModel.view.rawRange(
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
  const models = parseModels(parseTables, [source, previous, next])
  if (!models) return { status: 'unowned', reason: 'invalid-or-ambiguous-table-model' }
  const [authoredModel, previousModel, nextModel] = models
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
    const previousRawChange = previousModel.view.rawRange(normalizedChange.start, normalizedChange.previousEnd)
    const nextRawChange = nextModel.view.rawRange(normalizedChange.start, normalizedChange.nextEnd)
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
