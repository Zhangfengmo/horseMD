import { decodeNamedCharacterReference } from 'decode-named-character-reference'
import { createMarkdownSourceView } from '../markdown-source-view.js'

const CACHE_ENTRY_LIMIT = 4
const CACHE_CHARACTER_LIMIT = 1_500_000
const HTML_BREAK = /^<br\s*\/?>$/i
const ESCAPABLE = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

const compactSourceView = (source) => {
  const raw = String(source ?? '')
  let text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
  if (text.includes('\r')) text = text.replace(/\r\n?/g, '\n')
  return { raw, text }
}

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

const literalUnits = (view, start, end, expected) => {
  const units = []
  let index = start
  while (index < end) {
    const value = String.fromCodePoint(view.text.codePointAt(index))
    const range = view.rawRange(index, index + value.length)
    if (!range) return null
    units.push({ kind: 'char', value: value === '\n' ? ' ' : value, range })
    index += value.length
  }
  return units.map((unit) => unit.value).join('') === String(expected ?? '')
    ? units
    : null
}

const inlineCodeMappingUnits = (view, node) => {
  const position = positionOffsets(node.position)
  if (!position) return null
  const spelling = view.text.slice(position.start, position.end)
  const opening = spelling.match(/^(`+)/)?.[1] || ''
  const closing = spelling.match(/(`+)$/)?.[1] || ''
  if (!opening || opening.length !== closing.length) return null
  let start = position.start + opening.length
  let end = position.end - closing.length
  const inner = view.text.slice(start, end).replaceAll('\n', ' ')
  if (
    inner.length >= 2 &&
    inner.startsWith(' ') &&
    inner.endsWith(' ') &&
    inner.trim()
  ) {
    start += 1
    end -= 1
  }
  return literalUnits(view, start, end, node.value)
}

const mappingUnitsForNode = (view, node) => {
  if (!node || typeof node !== 'object') return []
  if (node.type === 'text') return textUnits(view, node) || []
  if (node.type === 'inlineCode') return inlineCodeMappingUnits(view, node) || []
  if (node.type === 'break') {
    const range = rawRangeFor(view, node.position)
    return range ? [{ kind: 'break', range }] : []
  }
  if (node.type === 'html') {
    const range = rawRangeFor(view, node.position)
    if (!range) return []
    const spelling = view.raw.slice(range.start, range.end)
    return [{ kind: HTML_BREAK.test(spelling) ? 'break' : 'atom', range }]
  }
  if (['image', 'imageReference', 'inlineMath', 'footnoteReference'].includes(node.type)) {
    const range = rawRangeFor(view, node.position)
    return range ? [{ kind: 'atom', range }] : []
  }
  if (Array.isArray(node.children)) {
    return node.children.flatMap((child) => mappingUnitsForNode(view, child))
  }
  return []
}

const opaqueUnit = (view, node) => {
  const range = rawRangeFor(view, node.position)
  return range
    ? [{ kind: 'opaque', value: JSON.stringify(withoutPositions(node)), range }]
    : []
}

const appendUnits = (target, source) => {
  for (const unit of source) target.push(unit)
}

const unitsForCell = (view, node) => {
  const units = []
  let patchable = true
  for (const child of node.children || []) {
    if (child?.type === 'text') {
      const decoded = textUnits(view, child)
      if (!decoded) {
        patchable = false
        appendUnits(units, opaqueUnit(view, child))
      } else {
        appendUnits(units, decoded)
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
        appendUnits(units, opaqueUnit(view, child))
      }
      continue
    }
    patchable = false
    appendUnits(units, opaqueUnit(view, child))
  }
  if ((node.children || []).some((child) => !rawRangeFor(view, child.position))) patchable = false
  return { units, patchable }
}

export const isUnescapedPipeAt = (text, index, lowerBound = 0) => {
  if (text[index] !== '|') return false
  let precedingBackslashes = 0
  for (let cursor = index - 1; cursor >= lowerBound && text[cursor] === '\\'; cursor -= 1) {
    precedingBackslashes += 1
  }
  return precedingBackslashes % 2 === 0
}

const normalizedCellContentRange = (text, position) => {
  const range = positionOffsets(position)
  if (!range) return null
  let start = range.start
  let end = range.end
  if (text[start] === '|') start += 1
  if (end > start && isUnescapedPipeAt(text, end - 1, start)) end -= 1
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
  const mappingUnits = mappingUnitsForNode(view, node)
  const positionsAreOwned = Boolean(range && contentRange && units.every((unit) => unit.range))
  return {
    row,
    column,
    presence: 'present',
    range,
    contentRange,
    units,
    mappingUnits,
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
  mappingUnits: [],
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
  if (!remark || typeof remark.parse !== 'function') {
    throw new TypeError('A configured remark parser is required for GFM table source ownership')
  }
  const raw = String(markdown ?? '')
  if (!raw.includes('|')) {
    return deepFreeze({
      view: compactSourceView(raw),
      tables: []
    })
  }
  const view = createMarkdownSourceView(raw)
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
  if (!tableNodes.length) {
    return deepFreeze({
      view: compactSourceView(raw),
      tables: []
    })
  }
  return deepFreeze({
    view,
    tables: tableNodes.map((node, index) => buildTable(view, node, index))
  })
}

export function createGfmTableSourceParser(remark) {
  const cache = new Map()
  let cachedCharacters = 0
  let revisionModels = new Map()
  const cachedModel = (key) => {
    if (revisionModels.has(key)) return revisionModels.get(key)
    if (cache.has(key)) {
      const value = cache.get(key)
      cache.delete(key)
      cache.set(key, value)
      return value
    }
    return null
  }
  const remember = (key, value) => {
    if (key.length > CACHE_CHARACTER_LIMIT) return
    cache.set(key, value)
    cachedCharacters += key.length
    while (
      cache.size > CACHE_ENTRY_LIMIT ||
      cachedCharacters > CACHE_CHARACTER_LIMIT
    ) {
      const oldest = cache.keys().next().value
      cachedCharacters -= oldest.length
      cache.delete(oldest)
    }
  }
  const parse = (markdown) => {
    const key = String(markdown ?? '')
    const cached = cachedModel(key)
    if (cached) return cached
    const value = buildGfmTableSourceModel(key, remark)
    remember(key, value)
    return value
  }
  // Source preservation verifies authored, previous-canonical, and
  // next-canonical as one immutable editor revision. Keep exactly that
  // revision's models together instead of letting the generic character LRU
  // evict one member while the same transaction is still being checked. The
  // next revision replaces this working set atomically, so memory is bounded
  // by the current triple and overlapping baselines are reused.
  parse.revisionSet = (markdownValues) => {
    const nextRevisionModels = new Map()
    const models = []
    for (const markdown of markdownValues || []) {
      const key = String(markdown ?? '')
      let value = nextRevisionModels.get(key) || cachedModel(key)
      if (!value) {
        value = buildGfmTableSourceModel(key, remark)
        remember(key, value)
      }
      nextRevisionModels.set(key, value)
      models.push(value)
    }
    revisionModels = nextRevisionModels
    return models
  }
  parse.cacheInfo = () => Object.freeze({
    entries: cache.size,
    characters: cachedCharacters
  })
  return parse
}

const sharedParsers = new WeakMap()

export function getGfmTableSourceParser(remark) {
  if (!remark || (typeof remark !== 'object' && typeof remark !== 'function')) return null
  let parser = sharedParsers.get(remark)
  if (!parser) {
    parser = createGfmTableSourceParser(remark)
    sharedParsers.set(remark, parser)
  }
  return parser
}

const isRange = (range, rawLength) => Boolean(
  range &&
  Number.isInteger(range.start) &&
  Number.isInteger(range.end) &&
  range.start >= 0 &&
  range.start <= range.end &&
  range.end <= rawLength
)

const hasValidOffsetMap = (view) => {
  if (
    !Array.isArray(view?.toRaw) ||
    view.toRaw.length !== view.text.length + 1 ||
    typeof view.rawRange !== 'function' ||
    typeof view.rawOffset !== 'function'
  ) return false
  for (let index = 0; index < view.toRaw.length; index += 1) {
    const offset = view.toRaw[index]
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > view.raw.length ||
      (index > 0 && offset <= view.toRaw[index - 1])
    ) return false
  }
  return view.toRaw.at(-1) === view.raw.length
}

const hasOrderedOwnedRanges = (items, owner, kinds, rawLength) => {
  if (!Array.isArray(items)) return false
  let previousEnd = owner.start
  for (const item of items) {
    if (
      !kinds.includes(item?.kind) ||
      !isRange(item.range, rawLength) ||
      item.range.start < owner.start ||
      item.range.end > owner.end ||
      item.range.start < previousEnd
    ) return false
    previousEnd = item.range.end
  }
  return true
}

export const isValidGfmTableSourceModel = (model, markdown) => {
  if (!model || model.view?.raw !== String(markdown ?? '') || !Array.isArray(model.tables)) return false
  if (model.tables.length && !hasValidOffsetMap(model.view)) return false
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
    let previousRowEnd = table.range.start
    for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
      const row = table.rows[rowIndex]
      if (
        row?.index !== rowIndex ||
        row.kind !== (rowIndex === 0 ? 'header' : 'body') ||
        !isRange(row.range, model.view.raw.length) ||
        row.range.start < table.range.start ||
        row.range.end > table.range.end ||
        row.range.start < previousRowEnd ||
        !Array.isArray(row.cells) ||
        row.cells.length < table.width ||
        !Number.isInteger(row.missingColumns) ||
        row.missingColumns < 0
      ) return false
      previousRowEnd = row.range.end
      let sawMissing = false
      let missingColumns = 0
      let previousCellEnd = row.range.start
      for (let column = 0; column < row.cells.length; column += 1) {
        const cell = row.cells[column]
        if (cell?.row !== rowIndex || cell.column !== column) return false
        if (cell.presence === 'missing') {
          sawMissing = true
          missingColumns += 1
          if (
            cell.range !== null ||
            cell.contentRange !== null ||
            cell.units?.length ||
            cell.mappingUnits?.length
          ) return false
          continue
        }
        if (cell.presence !== 'present' || sawMissing) return false
        if (
          !isRange(cell.range, model.view.raw.length) ||
          !isRange(cell.contentRange, model.view.raw.length) ||
          cell.range.start < row.range.start ||
          cell.range.end > row.range.end ||
          cell.range.start < previousCellEnd ||
          cell.contentRange.start < cell.range.start ||
          cell.contentRange.end > cell.range.end ||
          !hasOrderedOwnedRanges(
            cell.units,
            cell.contentRange,
            ['char', 'break', 'opaque'],
            model.view.raw.length
          ) ||
          !hasOrderedOwnedRanges(
            cell.mappingUnits,
            cell.contentRange,
            ['char', 'break', 'atom'],
            model.view.raw.length
          )
        ) return false
        previousCellEnd = cell.range.end
      }
      if (row.missingColumns !== missingColumns) return false
    }
  }
  return true
}
