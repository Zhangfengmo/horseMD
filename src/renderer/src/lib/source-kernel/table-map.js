// GFM table cell mapping — the 4-level ProseMirror table vs the 3-level mdast
// table (source-kernel Plan 5 Task 4).
//
// This module is pure: no Electron/React/@milkdown imports (source-kernel
// convention, see syntax-index.js). It receives the mdast `table` node the
// kernel already parsed plus the LIVE ProseMirror table node (a plain
// prosemirror-model `Node`, passed in by editor-kernel-projection-map.js) and
// answers ONE question: can this table's cells be paired and character-mapped
// byte-exactly?
//
// ==========================================================================
// The level mismatch, and how the zip consumes it
// ==========================================================================
// ProseMirror (@milkdown/preset-gfm, probed from
// node_modules/@milkdown/preset-gfm/lib/index.js:88-280):
//   table                 content: "table_header_row table_row+"
//     table_header_row    content: "(table_header)*"
//     table_row           content: "(table_cell)*"
//       table_header / table_cell   `cellContent: 'paragraph'` — and BOTH
//         parseMarkdown runners literally `openNode(type).openNode(paragraph)
//         .next(node.children)` — so a cell ALWAYS wraps its phrasing content
//         in a `paragraph`.
//         paragraph       content: "inline*"
// => table / row / cell / paragraph / inline  (4 container levels)
//
// mdast GFM (probed against this repo's own kernel chain, see the probe table
// in scripts/test-source-kernel-tablemap.mjs):
//   table{align:[…]}      children: tableRow[]      (NO thead/tbody grouping;
//     tableRow                                       row 0 IS the header)
//       tableCell         children: PHRASING DIRECTLY (no paragraph)
// => table / row / cell / phrasing  (3 container levels)
//
// The 4th PM level (`paragraph`) therefore has NO mdast counterpart. Rather
// than emit a slot for it and hunt for something to pair it with, this module
// CONSUMES it structurally: the walk descends `table_cell -> paragraph` and
// pairs THE PARAGRAPH with the mdast `tableCell`. The intermediate PM nodes
// (`table_header_row`/`table_row`, `table_header`/`table_cell`) are consumed
// the same way — they are proven to exist in the expected shape and count, but
// they are never pairs. What comes out is exactly one pair per cell, so the
// caller's `blockPairs` stays a flat list of textblock pairs like everywhere
// else.
//
// Because the whole table is zipped HERE (not in the caller's document-level
// zip), a disagreement inside a table can never mis-align the document: the
// caller keeps recording the table as ONE slot on both sides, and a failure
// here degrades the TABLE (one opaque, non-editable pair — the pre-Task-4
// behavior) while every other block keeps its map.
//
// ==========================================================================
// Where the bytes are
// ==========================================================================
// An mdast `tableCell`'s own `position` INCLUDES the cell's leading `|` and
// the padding spaces on both sides ('| a ' for the first cell of '| a | b |').
// Only its inline children carry the tight content span. So this module never
// uses the cell's own start/end as a content anchor. Instead:
//   * content units come from `buildCharacterMap(markdown, tableCell)` — the
//     SAME unit machinery every paragraph/heading uses, since a tableCell's
//     children are ordinary phrasing;
//   * the cell's `|` delimiters and its padding spaces are GAP bytes — no unit
//     covers them, exactly like a `**` marker run. This module PROVES that by
//     requiring every byte of the cell between the delimiters and the first/
//     last unit to be spaces/tabs, so nothing content-bearing is silently
//     unaccounted for.
//
// The delimiter row (`| --- | --- |`) has NO mdast node at all — remark only
// keeps its result in `table.align`. It is recovered here from the bytes (the
// line right after the header row, the technique
// lib/markdown-preservation/table-source-parse.js:260-272 uses) purely as
// EVIDENCE: its column count must agree with `align.length` and with the
// header row's cell count, and no cell's mapped range may touch it. Nothing
// ever writes there — that is what makes "edit the text in a cell" a safe
// subset of table editing.
//
// ==========================================================================
// Scope (Plan 5 Task 4 is deliberately narrow)
// ==========================================================================
// IN : editing the TEXT inside one cell.
// OUT: adding/removing rows or columns, alignment changes, creating a table,
//      editing the delimiter row, selections spanning multiple cells. Those
//      keep being refused upstream (the gateway's `sameParent` guard already
//      refuses a cross-cell step; the structural router refuses everything
//      whose `blockAt` is a `table`).
import { buildCharacterMap } from './character-map.js'
import { isInlineBreakHtml } from './inline-html.js'

const PADDING_RE = /^[ \t]*$/
// A GFM delimiter row, after its block prefix ('> ' / list indentation) has
// been stripped: optional outer pipes, and between them only
// `:?-+:?` column specs. The trailing `[ \t]*` is load-bearing (review
// finding, 2026-08-17): CommonMark/GFM allow trailing whitespace on ANY line,
// and editors (including this one) leave it behind routinely — without it a
// single trailing space on the delimiter row made this recovery fail and
// degraded the WHOLE table.
const DELIMITER_RE = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
// What may follow a cell's CONTENT region inside the cell's own raw span:
// its closing `|` (last cell of a pipe-closed row) plus any row-trailing
// whitespace. Proven per cell so nothing content-bearing is left unmapped.
const CELL_TAIL_RE = /^\|?[ \t]*$/
// The block prefix a table line inside a blockquote / list item carries.
const BLOCK_PREFIX_RE = /^[ \t>]*/

const offsetOf = (point) => point?.offset

// The raw range of the delimiter row: the physical line that follows the
// header row. Mirrors table-source-parse.js's `delimiterOffsets`, but reads
// the ORIGINAL bytes (the kernel never normalizes CRLF — see syntax-index.js),
// so the scan has to recognize '\r\n', lone '\r' and '\n' itself.
function delimiterRowRange(text, mdTable) {
  const tableStart = offsetOf(mdTable.position?.start)
  const tableEnd = offsetOf(mdTable.position?.end)
  const headerEnd = offsetOf(mdTable.children?.[0]?.position?.end)
  if (!Number.isInteger(tableStart) || !Number.isInteger(tableEnd) || !Number.isInteger(headerEnd)) {
    return null
  }
  let cursor = headerEnd
  if (text[cursor] === '\r') cursor += text[cursor + 1] === '\n' ? 2 : 1
  else if (text[cursor] === '\n') cursor += 1
  else return null
  const start = cursor
  let end = start
  while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end += 1
  if (start < tableStart || end > tableEnd || start > end) return null
  // A body row must start strictly after the delimiter line.
  const firstBodyStart = offsetOf(mdTable.children?.[1]?.position?.start)
  if (Number.isInteger(firstBodyStart) && firstBodyStart < end) return null
  return { start, end }
}

// How many columns does the recovered delimiter row declare? `null` when the
// line is not a delimiter row at all (which means the bytes are not the table
// this mdast node describes — fail closed).
function delimiterColumnCount(text, range) {
  const line = text.slice(range.start, range.end)
  const body = line.slice(line.match(BLOCK_PREFIX_RE)[0].length)
  if (!DELIMITER_RE.test(body)) return null
  const specs = body.match(/:?-+:?/g)
  return specs ? specs.length : null
}

// The cell's CONTENT region: its own raw span minus the leading `|` (absent
// for the first cell of a row written without outer pipes) and minus the
// trailing `|` (present only on the last cell of a row that closes its pipes).
// Everything inside this region that is not covered by a content unit must be
// padding — that is asserted by the caller below.
//
// ROW-TRAILING WHITESPACE (review finding, 2026-08-17): an mdast last-cell
// `position` runs to the end of the ROW, so `| a | b |   ` gives the second
// cell the raw span `'| b |   '` — the closing `|` is NOT the final byte.
// Looking only at `text[end - 1]` therefore left the delimiter INSIDE the
// content region, the padding proof below saw a `|`, and the cell degraded to
// read-only for nothing more than a stray space. The pipe is located by
// skipping back over trailing spaces/tabs FIRST — but `to` is only pulled in
// when a pipe is actually found there, so a cell with no closing pipe
// (`'| b   '`) and an EMPTY cell (`'|  '`, whose anchor is derived from its
// padding) keep the exact region they had before.
function cellContentRegion(text, mdCell) {
  const start = offsetOf(mdCell.position?.start)
  const end = offsetOf(mdCell.position?.end)
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null
  let from = start
  if (text[from] === '|') from += 1
  let to = end
  let scan = end
  while (scan > from && (text[scan - 1] === ' ' || text[scan - 1] === '\t')) scan -= 1
  if (scan > from && text[scan - 1] === '|') to = scan - 1
  return { from, to }
}

// Does this cell hold an in-cell line break? `<br>` is the ONLY way to spell
// one in a GFM cell, and the editor chain rewrites it into a PM `hardbreak`
// atom (editor-tablebreak.js `brToBreakRemarkPlugin`) while the kernel keeps a
// raw `html` node. Both sides count it as exactly one unit, so the character
// map itself is provable — but the shape is deliberately kept NON-EDITABLE for
// stage 3 (a break carries the cell's only multi-line semantics and the
// gateway's `textblockProfile` refuses any textblock holding a non-text inline
// child anyway, so nothing is lost by degrading the cell here, and the byte
// contract stays obviously safe).
function hasCellBreak(node) {
  if (!node) return false
  if (node.type === 'break') return true
  if (node.type === 'html' && isInlineBreakHtml(node.value)) return true
  return (node.children || []).some(hasCellBreak)
}

// Which character does an `escape` unit spell? `character-map.js`'s
// `textUnits` emits the unit ONLY when `text[r] === '\\'` and `text[r + 1]` IS
// the decoded character, so `text[rawStart + 1]` is that character by the
// unit's own construction — read off the text rather than carried on the unit,
// so the unit shape (and every consumer of it, in the kernel and in the
// char-map suites that deep-compare `[kind, rawStart, rawEnd, width]`) stays
// untouched. Anything not spelling exactly `\<char>` is a shape this module
// has not proven and answers `null`, which its caller treats as unprovable.
function escapedCharOf(text, unit) {
  if (unit.rawEnd !== unit.rawStart + 2) return null
  if (text[unit.rawStart] !== '\\') return null
  const ch = text[unit.rawStart + 1]
  return typeof ch === 'string' ? ch : null
}

// charMap-shaped object for an EMPTY cell ('| |', '|  |', '||'). The generic
// `buildCharacterMap` returns a zero-unit map whose only boundary falls back
// to the block node's own `position.start.offset` — which for a tableCell is
// the LEADING PIPE, not a content position, so serving it would write text
// outside the cell. The anchor is derived from the bytes instead: one space
// after the cell's opening delimiter when the padding can spare it (so typing
// into '|  |' produces the canonical '| x |'), otherwise the region start.
// Same public surface as buildCharacterMap/buildCodeMap's zero-unit result.
function emptyCellCharMap(text, region) {
  const { from, to } = region
  const anchor = to - from >= 2 && (text[from] === ' ' || text[from] === '\t') ? from + 1 : from
  const visibleToRaw = (vis) => (vis === 0 ? anchor : null)
  return {
    units: [],
    visibleLength: 0,
    visibleToRaw,
    rawStartForVisible: visibleToRaw,
    rawNeutralInsert: (vis) => (vis === 0 ? anchor : null),
    rawRangeForVisibleRange: (visFrom, visTo) => (
      visFrom === 0 && visTo === 0 ? { from: anchor, to: anchor } : null
    )
  }
}

// Character map for ONE cell, or `null` when this cell cannot be proven
// byte-exactly (the caller degrades just that cell, keeping its siblings and
// the rest of the document editable).
function buildCellCharMap(text, mdCell) {
  const region = cellContentRegion(text, mdCell)
  if (!region) return null
  // Whatever the cell's own raw span holds AFTER the content region must be
  // exactly its closing `|` and/or row-trailing whitespace — nothing
  // content-bearing may sit outside the mapped region.
  if (!CELL_TAIL_RE.test(text.slice(region.to, offsetOf(mdCell.position?.end)))) return null
  const children = mdCell.children || []
  if (!children.length) {
    // A childless cell must be padding-only between its delimiters, or the
    // bytes say something the mdast node does not.
    if (!PADDING_RE.test(text.slice(region.from, region.to))) return null
    return emptyCellCharMap(text, region)
  }
  // UNLOCKED 2026-08-29 (user: 「表格内部需要支持换行不可能都是单行噻」). The
  // note above this function's `hasCellBreak` helper said the map itself was
  // provable and the degrade was a stage-3 CHOICE — measured, it is: a cell
  // holding `甲<br>乙` maps to [char, atom(width 1), char], the `<br>` counted
  // once on both sides. Keeping the degrade meant Enter in a cell produced a
  // visible second line the user could not type on (the cell answered
  // 「此段落…暂为只读」), which is a break in name only.
  const charMap = buildCharacterMap(text, mdCell)
  if (!charMap || !charMap.units.length) return null
  // `\|` — and ONLY `\|` — is refused. A GFM table cell unescapes `\|` into a
  // literal `|` BEFORE inline parsing: a table-specific rule layered on top of
  // the ordinary CommonMark escape the unit model encodes (it fires even
  // inside a code span, where a CommonMark backslash escape does nothing), so
  // an edit that lands next to one would have to reason about both decodes.
  // That cell degrades to read-only.
  //
  // Every OTHER escape in a cell is the ORDINARY CommonMark escape — the exact
  // same `textUnits` walk, with the exact same width-1-over-two-raw-bytes
  // unit, that `buildCharacterMap` already serves in every paragraph and
  // heading of every document. This guard used to be written over ALL escapes
  // ("a scope decision, not a defect"), and that scope cost 330 read-only
  // blocks = 63.7% of the entire read-only surface across 197 real documents
  // (scripts/measure-kernel-readonly-causes.mjs, cause B), because
  // remark-stringify writes `claude\-haiku\-4\.5` and `4\.00` inside cells as
  // a matter of routine — one measured price list lost 110 of its 111 cells to
  // it. Narrowing the guard to its true condition proves the same thing about
  // less; it does not assume anything new.
  //
  // NOTE this reads the escape UNITS, i.e. the decode the unit model owns. A
  // `\|` elsewhere in the cell's raw span (a link destination, an image `src`)
  // is GAP bytes — no unit covers it, exactly like a `**` marker run — and no
  // cell-text edit can address it, so it is out of this guard's scope by
  // construction, not by omission (pinned in the table-map suite, Case 11).
  for (const unit of charMap.units) {
    if (unit.kind !== 'escape') continue
    const escaped = escapedCharOf(text, unit)
    if (escaped === null || escaped === '|') return null
  }
  // The cell's inline children span [childStart, childEnd) — everything the
  // character map is allowed to touch. What sits between that span and the
  // cell's own delimiters must be PADDING: that is the proof that the `|`
  // bytes and the surrounding spaces belong to no unit (they are gap bytes,
  // like a `**` marker run) and that no content byte went unmapped.
  //
  // The check deliberately brackets the CHILDREN, not the first/last UNIT: a
  // child's own marker syntax (an inline-code span's backticks, a `**`/`==`
  // run) legitimately sits inside the child span with no unit covering it,
  // and is gap bytes by the same shared rule every paragraph uses.
  const childStart = offsetOf(children[0].position?.start)
  const childEnd = offsetOf(children[children.length - 1].position?.end)
  if (!Number.isInteger(childStart) || !Number.isInteger(childEnd)) return null
  if (childStart < region.from || childEnd > region.to) return null
  if (!PADDING_RE.test(text.slice(region.from, childStart))) return null
  if (!PADDING_RE.test(text.slice(childEnd, region.to))) return null
  const first = charMap.units[0]
  const last = charMap.units[charMap.units.length - 1]
  if (first.rawStart < childStart || last.rawEnd > childEnd) return null
  return charMap
}

// Walk the live PM table, consuming the two intermediate levels and the
// paragraph wrapper. Returns `rows[][]` of `{ pmNode: paragraph, pmPos }`, or
// `null` for any shape other than the exact one preset-gfm produces.
function walkPmTable(pmTable, pmPos) {
  const rows = []
  let ok = true
  pmTable.forEach((rowNode, offset) => {
    if (!ok) return
    const rowName = rowNode.type?.name
    const isHeaderRow = rowName === 'table_header_row'
    if (!isHeaderRow && rowName !== 'table_row') {
      ok = false
      return
    }
    if (isHeaderRow !== (rows.length === 0)) {
      // Exactly one header row, and it must come first.
      ok = false
      return
    }
    const rowPos = pmPos + 1 + offset
    const cells = []
    rowNode.forEach((cellNode, cellOffset) => {
      if (!ok) return
      const cellName = cellNode.type?.name
      const expected = isHeaderRow ? 'table_header' : 'table_cell'
      if (cellName !== expected) {
        ok = false
        return
      }
      if (cellNode.childCount !== 1) {
        ok = false
        return
      }
      const paragraph = cellNode.firstChild
      if (paragraph?.type?.name !== 'paragraph' || !paragraph.isTextblock) {
        ok = false
        return
      }
      const cellPos = rowPos + 1 + cellOffset
      cells.push({ pmNode: paragraph, pmPos: cellPos + 1 })
    })
    // Only a fully-collected row is recorded: a row whose cell loop bailed
    // out has partial data that nothing may read (the whole walk fails
    // anyway), and leaving it out keeps `rows` honest for the `rows.length
    // === 0` header-position check above.
    if (ok) rows.push(cells)
  })
  return ok ? rows : null
}

// buildTableSourceMaps: the SOURCE-SIDE half of buildTableCellMaps, exported
// on its own (2026-08-22, table-ops) so commands/table-ops.js can prove that
// a candidate table it is about to write stays cell-addressable WITHOUT a
// live ProseMirror node (a pure command has none). Same structural refusals
// as the full zip minus the PM-shape checks; per-cell failure degrades only
// that cell (`charMap: null`), exactly as before.
//
// Returns `{ cells, delimiter, width }` — one `{ mdBlock, charMap, row,
// column }` entry per cell in document order — or `null` when the table's
// own structure cannot be proven:
//   * anything other than `table`/`tableRow` mdast shape;
//   * a non-rectangular (ragged / over-wide) table — the delimiter row
//     declares the column count and every row must match it;
//   * a delimiter row that cannot be recovered from the bytes or disagrees
//     with `align.length` / the header's cell count.
export function buildTableSourceMaps(text, mdTable) {
  if (typeof text !== 'string') return null
  if (mdTable?.type !== 'table') return null
  const mdRows = mdTable.children || []
  if (!mdRows.length || mdRows.some((row) => row?.type !== 'tableRow')) return null

  const delimiter = delimiterRowRange(text, mdTable)
  if (!delimiter) return null
  const declared = delimiterColumnCount(text, delimiter)
  if (declared === null) return null
  const align = mdTable.align
  if (!Array.isArray(align) || align.length !== declared) return null

  const width = mdRows[0].children?.length || 0
  if (width !== declared) return null
  for (const row of mdRows) {
    const cells = row.children || []
    if (cells.length !== width) return null
    if (cells.some((cell) => cell?.type !== 'tableCell')) return null
  }

  const cells = []
  for (let r = 0; r < mdRows.length; r += 1) {
    const mdCells = mdRows[r].children
    for (let c = 0; c < width; c += 1) {
      const mdCell = mdCells[c]
      const charMap = buildCellCharMap(text, mdCell)
      // No cell's mapped bytes may reach the delimiter row.
      const touchesDelimiter = charMap && charMap.units.length
        ? charMap.units[0].rawStart < delimiter.end &&
          charMap.units[charMap.units.length - 1].rawEnd > delimiter.start
        : false
      cells.push({
        mdBlock: mdCell,
        charMap: touchesDelimiter ? null : charMap,
        row: r,
        column: c
      })
    }
  }
  return { cells, delimiter, width }
}

// buildTableCellMaps: the full source<->PM zip (the module's original export).
//
// Returns `{ cells, delimiter, width }` where `cells` is one entry per cell in
// document order — `{ mdBlock, pmNode, pmPos, charMap }`, the exact shape the
// projection map's `blockPairs` uses, with `charMap: null` for a cell whose
// bytes could not be proven. Returns `null` when the TABLE as a whole cannot
// be zipped (the caller then records the table as one opaque, non-editable
// pair, which is the pre-Task-4 behavior and keeps the rest of the map).
//
// Structural refusals (whole table degrades): everything
// `buildTableSourceMaps` above refuses, plus the PM side:
//   * a header-only markdown table: `table_header_row table_row+` forces
//     ProseMirror's `createAndFill` to invent an empty body row that has no
//     mdast counterpart, so the row counts disagree;
//   * any PM shape other than row -> cell -> paragraph.
export function buildTableCellMaps(text, mdTable, pmTable, pmPos) {
  if (!pmTable || !Number.isInteger(pmPos)) return null
  const source = buildTableSourceMaps(text, mdTable)
  if (!source) return null
  const { cells: sourceCells, delimiter, width } = source
  const mdRows = mdTable.children || []

  const pmRows = walkPmTable(pmTable, pmPos)
  if (!pmRows || pmRows.length !== mdRows.length) return null
  for (let r = 0; r < pmRows.length; r += 1) {
    if (pmRows[r].length !== width) return null
  }

  const cells = sourceCells.map((cell) => ({
    mdBlock: cell.mdBlock,
    pmNode: pmRows[cell.row][cell.column].pmNode,
    pmPos: pmRows[cell.row][cell.column].pmPos,
    charMap: cell.charMap,
    tableCell: true,
    row: cell.row,
    column: cell.column
  }))
  return { cells, delimiter, width }
}
