// Table structural operations — add/delete row, add/delete column, column
// alignment — as pure source transactions over a GFM table's raw lines.
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
//
// RELATION TO THE SIBLING COMMANDS
// --------------------------------
// block-insert.js CREATES a table (the `/table` skeleton, two padding spaces
// per cell — `emptyCellCharMap`'s addressable shape); table-map.js proves an
// EXISTING table cell-addressable. This module is the third leg: it REWRITES
// an existing table's structure, and it inherits both of their disciplines:
//
//   * every written empty cell is the same `'|  '` spelling block-insert.js
//     established (TABLE_CELL there), because that is the exact byte shape
//     `emptyCellCharMap` can anchor — a new row/column the caret cannot land
//     in would be worse than a refused button;
//   * every candidate is REPARSED and proven on the same two axes
//     block-insert.js established: (a) the table at the same start is exactly
//     the predicted result — row count, column count, align array, every
//     UNTOUCHED cell's bytes and decoded content identical — and (b) the
//     whole document outside the table's lines is structurally identical
//     (`outsideSignature`, walked through containers for quoted tables);
//   * the result must still build its SOURCE cell maps
//     (`buildTableSourceMaps`, the PM-free half of table-map.js's zip) — the
//     proof that the rewritten table stays editable — and the caret anchor is
//     read off those maps, never derived by convention.
//
// WHERE THE BOUNDARIES COME FROM (escaped pipes)
// ----------------------------------------------
// A `\|` inside a cell is CONTENT, not a boundary, and a naive pipe split
// would corrupt exactly the tables that use it. This module therefore never
// scans a CONTENT row for pipes: every cell boundary is the parser's own —
// an mdast `tableCell`'s `position.start` IS its opening `|` (probed:
// '| a \| x | b |' gives cell0 [0,9), cell1 [9,14)). The only line parsed by
// hand is the DELIMITER row, which has no mdast node and CANNOT contain an
// escape (DELIMITER_RE, enforced by buildTableSourceMaps, admits only
// `:-| \t` bytes). The one remaining hand-scan — locating a line's CLOSING
// pipe — carries a backslash-parity check: a final pipe preceded by an odd
// number of backslashes is content ('| a \|' — probed: ONE cell, value
// 'a |'), so the row is not pipe-closed and the op refuses rather than
// splitting it.
//
// WHAT IS DELIBERATELY REFUSED (named, never guessed)
// ---------------------------------------------------
//   * `table-last-row`    — deleting the only body row. GFM can spell a
//     header-only table but the editor's PM schema (`table_header_row
//     table_row+`) cannot hold one: `createAndFill` invents a body row with
//     no mdast counterpart and the whole table degrades to read-only
//     (table-map.js records this). Deleting the whole table stays a
//     source-mode edit.
//   * `table-last-column` — deleting the only column: no zero-column GFM
//     table exists.
//   * `table-op-unsupported` — everything unprovable: rows without opening/
//     closing pipes, a row whose final pipe is escaped, ragged rows (width
//     disagreeing with the delimiter), mixed line prefixes (a lazily-quoted
//     or inconsistently indented table), list-nested tables (the quote walk
//     stops at a list item, as everywhere in this family), out-of-range
//     indexes, and any candidate that fails a reparse proof.
import { parseKernelMarkdown } from '../syntax-index.js'
import { outsideSignature } from './list-merge.js'
import { buildTableSourceMaps } from '../table-map.js'

export const TABLE_OP_CODES = Object.freeze({
  UNSUPPORTED: 'table-op-unsupported',
  LAST_ROW: 'table-last-row',
  LAST_COLUMN: 'table-last-column'
})

const REFUSE = Object.freeze({ ok: false, code: TABLE_OP_CODES.UNSUPPORTED })
const ALIGNMENTS = new Set(['left', 'center', 'right'])

// The empty-cell / empty-spec spellings, byte-identical to block-insert.js's
// TABLE_CELL / TABLE_DELIMITER conventions (the two padding spaces are what
// `emptyCellCharMap` anchors).
const NEW_CELL = '|  '
const NEW_SPEC = '| --- '

// ---------------------------------------------------------------------------
// Locate the table: the same exclusive-end quote-descend walk the sibling
// commands use, targeting a `table` node CONTAINING the offset. A list item
// on the chain stops the walk (marker/indent semantics this module has not
// proven).
// ---------------------------------------------------------------------------
const within = (node, offset) => {
  const start = node?.position?.start?.offset
  const end = node?.position?.end?.offset
  return Number.isInteger(start) && Number.isInteger(end) && offset >= start && offset < end
}

function quoteChainTableAt(tree, offset) {
  let children = tree?.children || []
  let quoteDepth = 0
  for (;;) {
    const hit = children.find((node) => within(node, offset))
    if (!hit) return null
    if (hit.type === 'blockquote') {
      quoteDepth += 1
      children = hit.children || []
      continue
    }
    return hit.type === 'table' ? { table: hit, quoteDepth } : null
  }
}

// ---------------------------------------------------------------------------
// Physical-line model of the table. Everything below refuses with null; the
// caller translates that to the named UNSUPPORTED code.
// ---------------------------------------------------------------------------
const lineStartOf = (text, pos) => {
  let start = pos
  while (start > 0 && text[start - 1] !== '\n' && text[start - 1] !== '\r') start -= 1
  return start
}
const lineEndOf = (text, pos) => {
  let end = pos
  while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end += 1
  return end
}
const endingAt = (text, lineEnd) => {
  if (text[lineEnd] === '\r') return text[lineEnd + 1] === '\n' ? '\r\n' : '\r'
  if (text[lineEnd] === '\n') return '\n'
  return ''
}

// The line's closing `|`: scan back over row-trailing whitespace, require an
// UNESCAPED pipe (even number of preceding backslashes), strictly after the
// content start.
function closingPipeOf(text, contentStart, lineEnd) {
  let scan = lineEnd
  while (scan > contentStart && (text[scan - 1] === ' ' || text[scan - 1] === '\t')) scan -= 1
  if (scan <= contentStart || text[scan - 1] !== '|') return null
  const pipe = scan - 1
  let backslashes = 0
  while (pipe - 1 - backslashes >= contentStart && text[pipe - 1 - backslashes] === '\\') backslashes += 1
  if (backslashes % 2 === 1) return null
  return pipe
}

// Analyze one table's bytes into a per-line model. Returns null when any
// structural fact cannot be proven. `source` is the buildTableSourceMaps
// result for the SAME (text, table) pair — passed in so baseline and
// candidate analyses reuse the maps their callers already built.
function analyzeTable(text, table, source) {
  if (!source) return null
  const rows = table.children || []
  const width = source.width

  // Shared line prefix, derived from the header row and required IDENTICAL on
  // every line (a lazily-quoted or mixed-indentation table refuses). Only
  // block-prefix bytes are accepted.
  const headerStart = rows[0].position?.start?.offset
  if (!Number.isInteger(headerStart)) return null
  const headerLineStart = lineStartOf(text, headerStart)
  const prefix = text.slice(headerLineStart, headerStart)
  if (!/^[ \t>]*$/.test(prefix)) return null

  const lines = []
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r]
    const contentStart = row.position?.start?.offset
    const rowEnd = row.position?.end?.offset
    if (!Number.isInteger(contentStart) || !Number.isInteger(rowEnd)) return null
    const lineStart = lineStartOf(text, contentStart)
    if (text.slice(lineStart, contentStart) !== prefix) return null
    const lineEnd = lineEndOf(text, contentStart)
    // A GFM row is one physical line; a row whose span leaves its line is not
    // a shape this module understands.
    if (rowEnd > lineEnd) return null
    if (text[contentStart] !== '|') return null
    const closingPipe = closingPipeOf(text, contentStart, lineEnd)
    if (closingPipe === null) return null
    // Cell boundaries are the PARSER's: boundaries[k] = cell k's opening
    // pipe, boundaries[width] = the closing pipe.
    const cells = row.children || []
    const boundaries = []
    for (let c = 0; c < cells.length; c += 1) {
      const cellStart = cells[c].position?.start?.offset
      if (!Number.isInteger(cellStart)) return null
      if (text[cellStart] !== '|') return null
      if (c > 0 && cellStart <= boundaries[c - 1]) return null
      boundaries.push(cellStart)
    }
    if (boundaries[0] !== contentStart) return null
    if (boundaries[boundaries.length - 1] >= closingPipe) return null
    boundaries.push(closingPipe)
    lines.push({
      lineStart,
      contentStart,
      lineEnd,
      ending: endingAt(text, lineEnd),
      closingPipe,
      boundaries
    })
  }

  // The delimiter line, recovered by buildTableSourceMaps (`delimiter.start`
  // is the physical line start). Its prefix must match, its pipes are found
  // by a plain scan — DELIMITER_RE (already enforced) admits no escapes.
  const delimStart = source.delimiter.start
  const delimEnd = source.delimiter.end
  if (text.slice(delimStart, delimStart + prefix.length) !== prefix) return null
  const delimContent = delimStart + prefix.length
  if (text[delimContent] !== '|') return null
  const delimClosing = closingPipeOf(text, delimContent, delimEnd)
  if (delimClosing === null) return null
  const pipes = []
  for (let i = delimContent; i <= delimClosing; i += 1) {
    if (text[i] === '|') pipes.push(i)
  }
  if (pipes.length !== width + 1) return null
  // Per-column spec runs (`:?-+:?`) between consecutive pipes.
  const specs = []
  for (let k = 0; k < width; k += 1) {
    const segment = text.slice(pipes[k] + 1, pipes[k + 1])
    const match = segment.match(/:?-+:?/)
    if (!match) return null
    specs.push({ start: pipes[k] + 1 + match.index, end: pipes[k] + 1 + match.index + match[0].length })
  }
  const delimiter = {
    lineStart: delimStart,
    contentStart: delimContent,
    lineEnd: delimEnd,
    ending: endingAt(text, delimEnd),
    closingPipe: delimClosing,
    pipes,
    specs
  }
  // Physical order sanity: header line, delimiter line, body lines, strictly
  // ascending and non-overlapping.
  const ordered = [lines[0], delimiter, ...lines.slice(1)]
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].lineStart <= ordered[i - 1].lineEnd) return null
    if (ordered[i - 1].ending === '') return null
  }

  return {
    prefix,
    width,
    rows: lines,
    delimiter,
    // The byte region every edit stays inside (baseline coordinates): the
    // header line's start through the last line's terminator (or text end).
    regionStart: headerLineStart,
    regionEnd: lines[lines.length - 1].lineEnd + lines[lines.length - 1].ending.length
  }
}

// list-merge.js's `outsideSignature` with the container-walk difference the
// quoted paths of block-type.js / block-insert.js document: a node overlapping
// the region is never signed, but its CHILDREN are walked, because a quoted
// table's region sits INSIDE blockquote ancestors whose sibling blocks must
// stay protected. For top-level regions the two agree byte-for-byte.
function outsideSignatureThroughContainers(tree, regionStart, regionEnd, delta) {
  const parts = []
  let ok = true
  const walk = (node) => {
    if (!ok) return
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      ok = false
      return
    }
    if (start < regionEnd && end > regionStart) {
      for (const child of node.children || []) walk(child)
      return
    }
    const from = start <= regionStart ? start : start - delta
    const to = end <= regionStart ? end : end - delta
    parts.push(`${node.type}:${from}:${to}`)
    for (const child of node.children || []) walk(child)
  }
  for (const child of tree.children || []) walk(child)
  return ok ? parts.join('\n') : null
}

// Type+value walk of a cell's inline children — the "decoded text identical"
// half of the untouched-cell proof (positions excluded by design: everything
// after an edit shifts).
const inlineSignature = (node) => {
  const out = []
  const walk = (n) => {
    out.push(`${n?.type}${typeof n?.value === 'string' ? ':' + n.value : ''}`)
    for (const child of n?.children || []) walk(child)
  }
  for (const child of node?.children || []) walk(child)
  return out.join('|')
}

// Splice ascending, non-overlapping edits into text.
const splice = (text, edits) => {
  const parts = []
  let cursor = 0
  for (const edit of edits) {
    parts.push(text.slice(cursor, edit.from), edit.insert ?? '')
    cursor = edit.to
  }
  parts.push(text.slice(cursor))
  return parts.join('')
}

// The full cell segment — opening pipe through the byte before the next
// boundary — for untouched-cell byte fidelity.
const cellSegment = (text, line, c) => text.slice(line.boundaries[c], line.boundaries[c + 1])

// ---------------------------------------------------------------------------
// The shared prove-and-package tail: reparse the candidate, find the table at
// the same start/depth, check the predicted shape, compare untouched cells on
// both axes, prove the outside unchanged, prove the result still builds its
// source maps, and derive the caret anchor from those maps.
//
// `predict` = {
//   rowCount, width, align,
//   cellFor(r, c)  -> { row, column } in the BASELINE for an untouched
//                     candidate cell, or null for a written one,
//   newCell(r, c)  -> expected exact segment bytes for a written cell
//                     (undefined = no constraint beyond emptiness),
//   caret          -> { row, column } target cell in the CANDIDATE
// }
// ---------------------------------------------------------------------------
function proveAndPackage({
  doc,
  text,
  edits,
  intent,
  table,
  baselineTree,
  baselineSource,
  baselineAnalysis,
  quoteDepth,
  predict
}) {
  let delta = 0
  for (const edit of edits) delta += (edit.insert ?? '').length - (edit.to - edit.from)
  const candidate = splice(text, edits)

  let candidateTree
  try {
    candidateTree = parseKernelMarkdown(candidate)
  } catch {
    return REFUSE
  }
  const tableStart = table.position.start.offset
  const found = quoteChainTableAt(candidateTree, tableStart)
  if (!found || found.quoteDepth !== quoteDepth) return REFUSE
  const candidateTable = found.table
  if (candidateTable.position?.start?.offset !== tableStart) return REFUSE

  // Axis (a): the predicted table, structurally.
  const candidateSource = buildTableSourceMaps(candidate, candidateTable)
  if (!candidateSource) return REFUSE
  const candidateAnalysis = analyzeTable(candidate, candidateTable, candidateSource)
  if (!candidateAnalysis) return REFUSE
  const rows = candidateTable.children || []
  if (rows.length !== predict.rowCount) return REFUSE
  if (candidateSource.width !== predict.width) return REFUSE
  const align = candidateTable.align || []
  if (align.length !== predict.align.length) return REFUSE
  for (let k = 0; k < align.length; k += 1) {
    if ((align[k] ?? null) !== (predict.align[k] ?? null)) return REFUSE
  }
  if (candidateAnalysis.prefix !== baselineAnalysis.prefix) return REFUSE

  // Untouched cells: byte-identical segments AND identical decoded content.
  // Written cells: empty of content, and — when constrained — the exact
  // bytes this command claims to have written.
  for (let r = 0; r < predict.rowCount; r += 1) {
    for (let c = 0; c < predict.width; c += 1) {
      const from = predict.cellFor(r, c)
      const candidateCell = rows[r].children[c]
      if (from) {
        const baselineCell = table.children[from.row].children[from.column]
        const baseSeg = cellSegment(text, baselineAnalysis.rows[from.row], from.column)
        const candSeg = cellSegment(candidate, candidateAnalysis.rows[r], c)
        if (baseSeg !== candSeg) return REFUSE
        if (inlineSignature(baselineCell) !== inlineSignature(candidateCell)) return REFUSE
        // Mappability must not narrow for a cell this op never touched.
        const baseMapped = !!baselineSource.cells[from.row * baselineSource.width + from.column].charMap
        const candMapped = !!candidateSource.cells[r * candidateSource.width + c].charMap
        if (baseMapped !== candMapped) return REFUSE
      } else {
        if ((candidateCell.children || []).length !== 0) return REFUSE
        const expected = predict.newCell?.(r, c)
        if (expected !== undefined &&
            cellSegment(candidate, candidateAnalysis.rows[r], c) !== expected) {
          return REFUSE
        }
      }
    }
  }

  // Axis (b): nothing outside the table's lines changed meaning.
  const signatureOf = quoteDepth > 0 ? outsideSignatureThroughContainers : outsideSignature
  const before = signatureOf(baselineTree, baselineAnalysis.regionStart, baselineAnalysis.regionEnd, 0)
  const after = signatureOf(candidateTree, baselineAnalysis.regionStart, baselineAnalysis.regionEnd + delta, delta)
  if (before === null || after === null || before !== after) return REFUSE

  // The caret: the target cell's own content anchor, read off the candidate's
  // source maps (an empty `|  |` cell anchors one byte past its padding —
  // emptyCellCharMap's derivation). A degraded target falls back to the first
  // mappable cell; a table with NO mappable cell refuses (a caret with no
  // provable home is the no-caret-home posture of this family).
  const targetIndex = predict.caret.row * candidateSource.width + predict.caret.column
  let anchor = candidateSource.cells[targetIndex]?.charMap?.visibleToRaw?.(0)
  if (!Number.isInteger(anchor)) {
    for (const cell of candidateSource.cells) {
      const fallback = cell.charMap?.visibleToRaw?.(0)
      if (Number.isInteger(fallback)) {
        anchor = fallback
        break
      }
    }
  }
  if (!Number.isInteger(anchor)) return REFUSE

  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      edits,
      intent,
      selection: { anchor, head: anchor }
    }
  }
}

// Common front half: resolve + analyze the baseline. Returns null -> REFUSE.
function resolveBaseline({ doc, offset }) {
  const text = doc?.text
  if (typeof text !== 'string' || !Number.isInteger(offset)) return null
  let baselineTree
  try {
    // Fresh parse rather than index.tree: the index carries
    // injectHighlightNodes' split text nodes, which the candidate parse does
    // not (the same reasoning block-insert.js records for its baseline).
    baselineTree = parseKernelMarkdown(text)
  } catch {
    return null
  }
  const found = quoteChainTableAt(baselineTree, offset)
  if (!found) return null
  const source = buildTableSourceMaps(text, found.table)
  if (!source) return null
  const analysis = analyzeTable(text, found.table, source)
  if (!analysis) return null
  return { text, baselineTree, table: found.table, quoteDepth: found.quoteDepth, source, analysis }
}

// ---------------------------------------------------------------------------
// insertTableRow — a new empty body row BEFORE mdast row `rowIndex`
// (1 <= rowIndex <= rowCount; rowIndex === rowCount appends after the last
// row). Row 0 is the header: nothing can stand above it in GFM.
// ---------------------------------------------------------------------------
export function insertTableRow({ doc, offset, rowIndex }) {
  const resolved = resolveBaseline({ doc, offset })
  if (!resolved) return REFUSE
  const { text, baselineTree, table, quoteDepth, source, analysis } = resolved
  const rowCount = analysis.rows.length
  if (!Number.isInteger(rowIndex) || rowIndex < 1 || rowIndex > rowCount) return REFUSE

  const rowLine = analysis.prefix + NEW_CELL.repeat(analysis.width) + '|'
  let edits
  if (rowIndex < rowCount) {
    // Insert at the target row's line start; the new line takes the ending of
    // the line ABOVE the insertion point (delimiter for the first body slot).
    const target = analysis.rows[rowIndex]
    const previous = rowIndex === 1 ? analysis.delimiter : analysis.rows[rowIndex - 1]
    edits = [{ from: target.lineStart, to: target.lineStart, insert: rowLine + previous.ending }]
  } else {
    const last = analysis.rows[rowCount - 1]
    if (last.ending !== '') {
      const at = last.lineEnd + last.ending.length
      edits = [{ from: at, to: at, insert: rowLine + last.ending }]
    } else {
      // Table ends the document without a terminator: open the new line with
      // the ending style of the line above.
      const previous = rowCount === 1 ? analysis.delimiter : analysis.rows[rowCount - 2]
      const ending = previous.ending || '\n'
      edits = [{ from: last.lineEnd, to: last.lineEnd, insert: ending + rowLine }]
    }
  }

  return proveAndPackage({
    doc,
    text,
    edits,
    intent: 'table-insert-row',
    table,
    baselineTree,
    baselineSource: source,
    baselineAnalysis: analysis,
    quoteDepth,
    predict: {
      rowCount: rowCount + 1,
      width: analysis.width,
      align: table.align || [],
      cellFor: (r, c) => (r === rowIndex ? null : { row: r < rowIndex ? r : r - 1, column: c }),
      newCell: () => NEW_CELL,
      caret: { row: rowIndex, column: 0 }
    }
  })
}

// ---------------------------------------------------------------------------
// insertTableColumn — a new empty column BEFORE `columnIndex`
// (0 <= columnIndex <= width; width appends after the last column). One edit
// per physical line, including the delimiter.
// ---------------------------------------------------------------------------
export function insertTableColumn({ doc, offset, columnIndex }) {
  const resolved = resolveBaseline({ doc, offset })
  if (!resolved) return REFUSE
  const { text, baselineTree, table, quoteDepth, source, analysis } = resolved
  const width = analysis.width
  if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex > width) return REFUSE

  // Physical order: header, delimiter, body rows — ascending by construction.
  const edits = []
  const rowInsertAt = (line) => line.boundaries[columnIndex]
  edits.push({ from: rowInsertAt(analysis.rows[0]), to: rowInsertAt(analysis.rows[0]), insert: NEW_CELL })
  const delimAt = columnIndex === width
    ? analysis.delimiter.closingPipe
    : analysis.delimiter.pipes[columnIndex]
  edits.push({ from: delimAt, to: delimAt, insert: NEW_SPEC })
  for (let r = 1; r < analysis.rows.length; r += 1) {
    const at = rowInsertAt(analysis.rows[r])
    edits.push({ from: at, to: at, insert: NEW_CELL })
  }

  const align = table.align || []
  const predictedAlign = [...align.slice(0, columnIndex), null, ...align.slice(columnIndex)]
  return proveAndPackage({
    doc,
    text,
    edits,
    intent: 'table-insert-column',
    table,
    baselineTree,
    baselineSource: source,
    baselineAnalysis: analysis,
    quoteDepth,
    predict: {
      rowCount: analysis.rows.length,
      width: width + 1,
      align: predictedAlign,
      cellFor: (r, c) => (c === columnIndex ? null : { row: r, column: c < columnIndex ? c : c - 1 }),
      newCell: () => NEW_CELL,
      caret: { row: 0, column: columnIndex }
    }
  })
}

// ---------------------------------------------------------------------------
// deleteTableRow — remove body row `rowIndex` (1 <= rowIndex <= rowCount-1)
// with its line and one line ending. The only body row refuses with
// `table-last-row` (a header-only table is unrepresentable in the editor).
// ---------------------------------------------------------------------------
export function deleteTableRow({ doc, offset, rowIndex }) {
  const resolved = resolveBaseline({ doc, offset })
  if (!resolved) return REFUSE
  const { text, baselineTree, table, quoteDepth, source, analysis } = resolved
  const rowCount = analysis.rows.length
  if (!Number.isInteger(rowIndex) || rowIndex < 1 || rowIndex > rowCount - 1) return REFUSE
  if (rowCount === 2) return { ok: false, code: TABLE_OP_CODES.LAST_ROW }

  const line = analysis.rows[rowIndex]
  let edits
  if (line.ending !== '') {
    edits = [{ from: line.lineStart, to: line.lineEnd + line.ending.length, insert: '' }]
  } else {
    // Last physical line without a terminator: remove the PRECEDING ending
    // together with the line.
    const previous = rowIndex === 1 ? analysis.delimiter : analysis.rows[rowIndex - 1]
    edits = [{ from: previous.lineEnd, to: line.lineEnd, insert: '' }]
  }

  return proveAndPackage({
    doc,
    text,
    edits,
    intent: 'table-delete-row',
    table,
    baselineTree,
    baselineSource: source,
    baselineAnalysis: analysis,
    quoteDepth,
    predict: {
      rowCount: rowCount - 1,
      width: analysis.width,
      align: table.align || [],
      cellFor: (r, c) => ({ row: r < rowIndex ? r : r + 1, column: c }),
      caret: { row: Math.min(rowIndex, rowCount - 2), column: 0 }
    }
  })
}

// ---------------------------------------------------------------------------
// deleteTableColumn — remove column `columnIndex` from every line including
// the delimiter. The only column refuses with `table-last-column`.
// ---------------------------------------------------------------------------
export function deleteTableColumn({ doc, offset, columnIndex }) {
  const resolved = resolveBaseline({ doc, offset })
  if (!resolved) return REFUSE
  const { text, baselineTree, table, quoteDepth, source, analysis } = resolved
  const width = analysis.width
  if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex > width - 1) return REFUSE
  if (width === 1) return { ok: false, code: TABLE_OP_CODES.LAST_COLUMN }

  const edits = []
  const rowRange = (line) => ({ from: line.boundaries[columnIndex], to: line.boundaries[columnIndex + 1], insert: '' })
  edits.push(rowRange(analysis.rows[0]))
  edits.push({
    from: analysis.delimiter.pipes[columnIndex],
    to: analysis.delimiter.pipes[columnIndex + 1],
    insert: ''
  })
  for (let r = 1; r < analysis.rows.length; r += 1) edits.push(rowRange(analysis.rows[r]))

  const align = table.align || []
  const predictedAlign = [...align.slice(0, columnIndex), ...align.slice(columnIndex + 1)]
  return proveAndPackage({
    doc,
    text,
    edits,
    intent: 'table-delete-column',
    table,
    baselineTree,
    baselineSource: source,
    baselineAnalysis: analysis,
    quoteDepth,
    predict: {
      rowCount: analysis.rows.length,
      width: width - 1,
      align: predictedAlign,
      cellFor: (r, c) => ({ row: r, column: c < columnIndex ? c : c + 1 }),
      caret: { row: 0, column: Math.min(columnIndex, width - 2) }
    }
  })
}

// ---------------------------------------------------------------------------
// setTableColumnAlignment — rewrite ONLY the delimiter cell's spec run:
// `:---` / `:---:` / `---:`, preserving the existing dash count (a
// pretty-printed five-dash spec keeps its five dashes). Setting the alignment
// a column already has is a NOOP (`{ ok: true, noop: true }`) — no byte the
// user authored is canonicalized for a no-change click.
// ---------------------------------------------------------------------------
export function setTableColumnAlignment({ doc, offset, columnIndex, alignment }) {
  if (!ALIGNMENTS.has(alignment)) return REFUSE
  const resolved = resolveBaseline({ doc, offset })
  if (!resolved) return REFUSE
  const { text, baselineTree, table, quoteDepth, source, analysis } = resolved
  const width = analysis.width
  if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex > width - 1) return REFUSE

  const align = table.align || []
  if ((align[columnIndex] ?? null) === alignment) return { ok: true, noop: true }

  const spec = analysis.delimiter.specs[columnIndex]
  const dashes = (text.slice(spec.start, spec.end).match(/-/g) || []).length
  if (dashes < 1) return REFUSE
  const run = '-'.repeat(dashes)
  const spelled = alignment === 'left' ? `:${run}` : alignment === 'right' ? `${run}:` : `:${run}:`
  const edits = [{ from: spec.start, to: spec.end, insert: spelled }]

  const predictedAlign = [...align.slice(0, columnIndex), alignment, ...align.slice(columnIndex + 1)]
  return proveAndPackage({
    doc,
    text,
    edits,
    intent: 'table-align-column',
    table,
    baselineTree,
    baselineSource: source,
    baselineAnalysis: analysis,
    quoteDepth,
    predict: {
      rowCount: analysis.rows.length,
      width,
      align: predictedAlign,
      cellFor: (r, c) => ({ row: r, column: c }),
      caret: { row: 0, column: columnIndex }
    }
  })
}


// ENTER INSIDE A TABLE CELL (2026-08-29 matrix sweep). GFM cells are
// single-line, so the editor's own convention for a break inside one is the
// literal `<br>` (components/editor-tablebreak.js: a keymap inserts a
// hardbreak and the serializer writes `<br>` ONLY inside a tableCell). Kernel
// mode had no answer at all and refused the key — measured 「无效操作…未写入」
// on Enter in any cell.
//
// The byte edit is that convention, written directly: `<br>` at the caret.
// PROVEN by reparse — the table must come back with the same row and column
// counts (a stray `|` or newline would restructure it) and every cell's text
// must survive, with exactly the edited cell gaining the break.
export function insertTableCellBreak({ doc, index, offset }) {
  const text = doc?.text
  if (typeof text !== 'string' || !Number.isInteger(doc?.revision)) {
    return { ok: false, code: 'unsupported-structure' }
  }
  if (!Number.isInteger(offset)) return { ok: false, code: 'unsupported-structure' }
  let baseTree
  try {
    baseTree = parseKernelMarkdown(text)
  } catch {
    return { ok: false, code: 'unsupported-structure' }
  }
  const cellAt = (tree, at) => {
    let hit = null
    const walk = (node) => {
      if (hit) return
      const start = node.position?.start?.offset
      const end = node.position?.end?.offset
      if (!Number.isInteger(start) || !Number.isInteger(end)) return
      if (at < start || at > end) return
      if (node.type === 'tableCell') hit = node
      for (const child of node.children || []) walk(child)
    }
    for (const child of tree.children || []) walk(child)
    return hit
  }
  const cell = cellAt(baseTree, offset)
  if (!cell) return { ok: false, code: 'unsupported-structure' }
  const insert = '<br>'
  const candidate = text.slice(0, offset) + insert + text.slice(offset)
  let candTree
  try {
    candTree = parseKernelMarkdown(candidate)
  } catch {
    return { ok: false, code: 'unsupported-structure' }
  }
  const shape = (tree) => {
    const rows = []
    const walk = (node) => {
      if (node?.type === 'table') {
        rows.push(`table:${(node.children || []).length}`)
        for (const row of node.children || []) rows.push(`row:${(row.children || []).length}`)
      }
      for (const child of node?.children || []) walk(child)
    }
    walk(tree)
    return rows.join('|')
  }
  if (shape(candTree) !== shape(baseTree)) return { ok: false, code: 'unsupported-structure' }
  // The cell's own text must be unchanged: a `<br>` is a BREAK, not content.
  const cellTexts = (tree) => {
    const out = []
    const walk = (node) => {
      if (node?.type === 'tableCell') {
        let text = ''
        // TEXT leaves only: the `<br>` we write parses as an `html` node, and
        // counting it as content would make the command refuse its own edit.
        const collect = (child) => {
          if (child?.type === 'text' && typeof child.value === 'string') text += child.value
          for (const grand of child?.children || []) collect(grand)
        }
        for (const child of node.children || []) collect(child)
        out.push(text)
      }
      for (const child of node?.children || []) walk(child)
    }
    walk(tree)
    return out
  }
  if (JSON.stringify(cellTexts(candTree)) !== JSON.stringify(cellTexts(baseTree))) {
    return { ok: false, code: 'unsupported-structure' }
  }
  const caret = offset + insert.length
  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      from: offset,
      to: offset,
      insert,
      intent: 'table-cell-break',
      selection: { anchor: caret, head: caret }
    }
  }
}
