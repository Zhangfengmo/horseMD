import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import {
  buildGfmTableSourceModel,
  createGfmTableSourceParser,
  mapGfmTableChange,
  normalizeGfmTableSerializerPlaceholders
} from './table-source-model.js'

const defaultParseTables = createGfmTableSourceParser(
  unified().use(remarkParse).use(remarkGfm)
)

export {
  buildGfmTableSourceModel,
  createGfmTableSourceParser,
  mapGfmTableChange
}

export const parseGfmTableSource = (markdown, parseTables = defaultParseTables) =>
  parseTables(String(markdown ?? ''))

export const mapTableSourceChange = (options) => mapGfmTableChange({
  ...options,
  parseTables: options?.parseTables || defaultParseTables
})

// Authored Markdown has no intrinsic way to prove that a sole `<br />` is an
// editor placeholder, so the generic API is deliberately a no-op. Only callers
// holding serializer provenance may opt in to placeholder removal.
export const normalizeEmptyTableCells = (
  markdown,
  parseTables = defaultParseTables,
  options = {}
) => {
  const source = String(markdown ?? '')
  return options.provenance === 'serializer'
    ? normalizeGfmTableSerializerPlaceholders(source, parseTables)
    : source
}

export const normalizeSerializerEmptyTableCells = (
  markdown,
  parseTables = defaultParseTables
) => normalizeEmptyTableCells(markdown, parseTables, { provenance: 'serializer' })
