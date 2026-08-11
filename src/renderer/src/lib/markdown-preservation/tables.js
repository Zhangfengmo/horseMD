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

// Crepe's serializer spells its otherwise-empty table-cell paragraph as the
// exact token `<br />`. Parser-owned cell ranges let us remove only that sole
// placeholder. Authored `<br>`, `<br/>`, text beside a break, and escaped pipes
// remain untouched because no line splitting or global table regex is used.
export const normalizeEmptyTableCells = (markdown, parseTables = defaultParseTables) =>
  normalizeGfmTableSerializerPlaceholders(String(markdown ?? ''), parseTables)
