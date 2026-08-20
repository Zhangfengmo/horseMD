// insertBlockFromQuery: turn the slash menu's own query block into a NEW
// multi-line block (a GFM table skeleton, a fenced code block), as ONE atomic
// source transaction.
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
//
// RELATION TO block-type.js
// -------------------------
// `setBlockTypeFromQuery` (next door) answers "convert THIS block's type",
// which in a source-authoritative kernel is a one-line marker prefix. This
// command answers the other half of the slash menu — "insert a NEW block" —
// and the difference is entirely in what has to be PROVEN, not in the shape of
// the write:
//
//   * a marker prefix cannot change the meaning of any OTHER line, so
//     block-type only has to prove its own block's span;
//   * a MULTI-LINE block can. Probed against the live chain (remark-parse +
//     remark-gfm + remark-math + remark-frontmatter, the kernel's own
//     `processor`): a table whose next line is ordinary paragraph text
//     SWALLOWS that line as a ragged extra row
//     (`|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n后面\n` -> ONE table with
//     three rows, the last holding `后面`), and `甲\n---\n` is not a paragraph
//     plus a thematic break at all but a single SETEXT heading.
//
// So every candidate here is REPARSED before it is returned, and checked on
// two axes — the same discipline `image-attrs.js` established for its own
// rewrites:
//   (a) the root child starting at the insertion offset is exactly the block
//       this command claims to have written: right mdast type, right interior
//       shape, and its `position.end.offset` lands exactly on the last byte
//       written — which is what proves nothing after it was absorbed;
//   (b) the WHOLE remaining document is structurally identical to the
//       baseline parse: same pre-order type sequence, same spans, once every
//       offset after the rewrite is shifted by its delta. This is what
//       catches absorption in the OTHER direction (bytes before the insertion
//       point changing meaning, the setext case above).
// Neither axis alone is sufficient, and a shape that fails either is refused
// rather than guessed at (`unsupported-structure`).
//
// WHERE THE CARET LANDS, AND WHY THAT IS PART OF THE COMMAND
// ----------------------------------------------------------
// An inserted block the user cannot immediately type into is worse than a
// refused menu item, so each target's anchor is derived from the bytes this
// command itself wrote (never searched for):
//   * table  -> the first header cell's content anchor. `table-map.js`'s
//     `emptyCellCharMap` derives an empty cell's only addressable position as
//     "one byte past the opening `|` when the padding can spare it", so the
//     skeleton is written with TWO padding spaces per cell (`|  |`) and the
//     anchor is `cellStart + 2`. The command asserts those exact three bytes
//     before returning, so the anchor is a byte fact, not a convention.
//   * code   -> the offset right after the OPEN fence line's own ending,
//     which is `code-map.js`'s `emptyCodeMap` anchor verbatim
//     (`openLine.end + openLine.ending.length`).
//   * math   -> the SAME anchor, for the same reason. An mdast `math` node is
//     mapped by `buildCodeMap` exactly like a `code` node (both expose
//     `.value` + `.position`, and neither has children), so the empty-content
//     case lands on `emptyCodeMap` identically. The open "fence" here is the
//     `$$` delimiter line, whose length happens to be 2 instead of 3+; the
//     anchor arithmetic is written from the built bytes either way.
// The controller then commits with `requireMap: true`, so the anchor is
// additionally proven to resolve through the REBUILT projection map before
// any byte, history entry or view change happens (editor-kernel-mode.js's
// `runInsertBlockFromQuery`). This command proving the bytes and the
// controller proving the projection is the same division of labour the
// block-type route uses.
//
// DELIBERATELY ABSENT, each for a probed reason (see the task report):
//   * image — Crepe's `image-block` is an ATOM, paired here with `charMap:
//     null` (read-only leaf). Its byte spelling `![]()` is writable, but the
//     caret would have no home inside the created card.
//   * divider (`---`) — a thematic break is a PM leaf with no text position;
//     the caret would have to land in a DIFFERENT block than the one this
//     command writes, which none of the anchors above can prove.
// Each of these must keep refusing rather than guess.
//
// `task` JOINED THE OWNED SET on 2026-08-20, and its spelling is the ONE
// representable form, not a convenience. Probed against the kernel's own
// processor (slash-completion-report.md §3): NO ASCII spelling produces an
// empty GFM task item — `- [ ] `, `- [ ]  `, `- [ ]\t`, `- [x] `, `* [ ] `
// all come back `checked === null` with `[ ]` as ordinary paragraph TEXT.
// The only bytes that parse to a real `checked: false` item with an
// addressable caret position are `- [ ] ` + U+00A0 (the no-break space seed —
// CommonMark's whitespace stripping is ASCII-only, the same fact
// trailing-whitespace.js is built on). The seed is SESSION-TRACKED via the
// document's whitespace provenance ledger (`whitespaceMarks`, `ascii: ''` =
// "stands for no keystroke") and DISSOLVED by commands/task-seed.js the
// moment the first label character lands. It cannot take the whitespace
// HEAL's exit, because it stands for no key and both ASCII outcomes are
// wrong (probed): content-less `- [ ]  ` demotes the whole item back to
// `checked: null`, and `- [ ]  x` forges a label space the user never typed
// — so dissolve-by-deletion is the only clean exit (task-seed.js's own ADR).
// Until it happens the seed is honest bytes: a saved file holds a REAL
// `checked: false` task that survives reload, where the legacy layer demotes
// the transient to plain `- [ ]` text on save.
import { parseKernelMarkdown } from '../syntax-index.js'
import { NO_BREAK_SPACE } from './trailing-whitespace.js'

// Target -> what this command may build for it. `language: true` means the
// target accepts an (optional) info string; every other target refuses one
// rather than silently dropping it.
export const BLOCK_INSERT_TARGETS = Object.freeze({
  table: Object.freeze({ language: false }),
  code: Object.freeze({ language: true }),
  // `$$` block math (2026-08-18). Added once `editor-kernel-projection-map.js`
  // started pairing an mdast `math` block editably: before that, creating one
  // would have handed the user a block with no caret position inside it.
  // A `$$` delimiter pair has no info string, so `language: false`.
  math: Object.freeze({ language: false }),
  // GFM task item (2026-08-20): `- [ ] ` + U+00A0 — the only representable
  // spelling of an "empty" task; see the seed ADR in this file's header.
  task: Object.freeze({ language: false })
})

// A fence info string this command is willing to write verbatim. Deliberately
// narrow: the byte run goes straight onto the open fence line, so anything
// that could terminate or re-open a fence (a backtick), start another
// construct, or introduce a line ending must never reach it. The slash menu's
// own language table (editor-slash-menu.js `LANGUAGES`) is well inside this,
// and the caller validates the id against that table too — this is the
// kernel-side half, which does not trust the caller.
const LANGUAGE_RE = /^[A-Za-z0-9][A-Za-z0-9_+#.-]*$/

// The GFM table skeleton: a header row, the delimiter row, and ONE body row,
// three columns. Every cell is written with two padding spaces (`|  |`) —
// load-bearing, not cosmetic: that is the exact shape `table-map.js`'s
// `emptyCellCharMap` can anchor (`to - from >= 2 && text[from] === ' '`), so
// each cell is addressable the moment the table exists. A header-only table
// is NOT written: ProseMirror's `table` is `table_header_row table_row+`, so
// `createAndFill` would invent a body row with no mdast counterpart and the
// projection map would refuse the whole table (table-map.js records this).
const TABLE_COLUMNS = 3
const TABLE_CELL = '|  '
const TABLE_ROW = TABLE_CELL.repeat(TABLE_COLUMNS) + '|'
const TABLE_DELIMITER = '| --- '.repeat(TABLE_COLUMNS) + '|'

// The task marker up to and including its checkbox padding space. The seed
// U+00A0 follows it as the item's ONLY content character (probed: paragraph
// span [6,7), one width-1 `char` unit — the caret home the ASCII spellings
// all lack).
const TASK_MARKER = '- [ ] '

// The bytes for one target plus the caret's offset INSIDE those bytes.
function buildBlock(target, language, ending) {
  if (target === 'table') {
    return {
      bytes: [TABLE_ROW, TABLE_DELIMITER, TABLE_ROW].join(ending),
      // `|` + one padding space: `emptyCellCharMap`'s own derivation for the
      // first header cell, asserted against the bytes in `shapeAgrees`.
      anchor: 2
    }
  }
  if (target === 'code') {
    const open = '```' + language
    return {
      // THE EMPTY CONTENT LINE IS LOAD-BEARING (probed, not stylistic).
      // `code-map.js`'s `emptyCodeMap` anchors a zero-content fence at
      // `openLine.end + openLine.ending.length` — the start of the NEXT
      // physical line. For `'```js' + LE + '```'` that line is the CLOSING
      // FENCE, so the first character typed there commits `'```js\nx```'`:
      // the closing fence is destroyed, the block becomes unterminated, and
      // the reparse no longer matches the ProseMirror document (measured
      // against the live parser). Writing one EMPTY content line moves that
      // same anchor onto a line the user owns — `'```js\n\n```'` still has
      // `value === ''` and the same anchor offset, and typing there commits
      // `'```js\nx\n```'`, which reparses to exactly the block on screen.
      bytes: open + ending + ending + '```',
      anchor: open.length + ending.length
    }
  }
  if (target === 'math') {
    // THE EMPTY CONTENT LINE IS LOAD-BEARING here for exactly the reason it is
    // for `code` above, and it was re-probed for this delimiter rather than
    // assumed: `'$$' + LE + '$$'` puts `emptyCodeMap`'s anchor on the CLOSING
    // `$$` line, so the first typed character would commit `'$$\nx$$'` — an
    // unterminated block. One empty content line moves the anchor onto a line
    // the user owns: `'$$\n\n$$'` still parses to `math` with `value === ''`,
    // and typing there commits `'$$\nx\n$$'`, which reparses to exactly the
    // block on screen.
    return {
      bytes: '$$' + ending + ending + '$$',
      anchor: 2 + ending.length
    }
  }
  if (target === 'task') {
    // One line, no interior line endings, so the document's ending never
    // appears in these bytes. The caret lands AFTER the seed (the ruled
    // design): the seed is the block's only character-map unit, and its end
    // offset is exactly where the first label character will be typed — which
    // is what lets commands/task-seed.js delete the seed and insert the label
    // as ONE edit. `seed` is the U+00A0's own span inside `bytes`, returned so
    // the transaction can ledger it (provenance, `ascii: ''`).
    return {
      bytes: TASK_MARKER + NO_BREAK_SPACE,
      anchor: TASK_MARKER.length + 1,
      seed: { from: TASK_MARKER.length, to: TASK_MARKER.length + 1 }
    }
  }
  return null
}

// Does the reparsed node REALLY mean what this command claims to have written?
// Axis (a) of the proof — interior shape, on top of the caller's span check.
function shapeAgrees(target, node, text, language) {
  if (target === 'table') {
    if (node.type !== 'table') return false
    if (!Array.isArray(node.align) || node.align.length !== TABLE_COLUMNS) return false
    const rows = node.children || []
    if (rows.length !== 2) return false
    for (const row of rows) {
      if (row?.type !== 'tableRow') return false
      const cells = row.children || []
      if (cells.length !== TABLE_COLUMNS) return false
      // Every cell must be EMPTY: a cell that came back with children means
      // the bytes carry content this command never wrote.
      if (cells.some((cell) => cell?.type !== 'tableCell' || (cell.children || []).length)) return false
    }
    const firstCell = rows[0].children[0]
    const cellStart = firstCell.position?.start?.offset
    if (!Number.isInteger(cellStart)) return false
    // The three bytes the caret anchor is derived from, asserted directly.
    return text.slice(cellStart, cellStart + TABLE_CELL.length) === TABLE_CELL
  }
  if (target === 'code') {
    if (node.type !== 'code') return false
    if (node.value !== '') return false
    return (node.lang ?? '') === language
  }
  if (target === 'math') {
    // No `lang` to check — a `$$` pair has no info string — and the empty
    // value is what proves nothing after the delimiters was absorbed as
    // content (the caller's span check covers the other direction).
    return node.type === 'math' && node.value === ''
  }
  if (target === 'task') {
    // Exactly ONE bullet item, REALLY a task (`checked === false`, never the
    // `null` every ASCII spelling comes back with), whose paragraph's whole
    // decoded content is the single seed U+00A0 sitting at the marker's end —
    // which is also the byte the caret anchor and the ledger span are derived
    // from, so it is asserted against the candidate bytes directly. A
    // neighbouring list this insert would MERGE into fails the caller's span
    // check (the reparsed list ends past the written bytes — probed:
    // '- [ ]  \n- x\n' is ONE two-item list), so `/task` refuses right
    // above an existing list rather than proving a merge it did not write.
    if (node.type !== 'list' || node.ordered) return false
    const items = node.children || []
    if (items.length !== 1 || items[0]?.type !== 'listItem') return false
    if (items[0].checked !== false) return false
    const blocks = items[0].children || []
    if (blocks.length !== 1 || blocks[0]?.type !== 'paragraph') return false
    const inline = blocks[0].children || []
    if (inline.length !== 1 || inline[0]?.type !== 'text') return false
    if (inline[0].value !== NO_BREAK_SPACE) return false
    const seedStart = inline[0].position?.start?.offset
    const seedEnd = inline[0].position?.end?.offset
    if (!Number.isInteger(seedStart) || seedEnd !== seedStart + 1) return false
    return text.slice(seedStart, seedEnd) === NO_BREAK_SPACE
  }
  return false
}

// Axis (b): the document OUTSIDE the rewritten region, as a pre-order
// type+span signature with post-region offsets normalized back to baseline
// coordinates. A node that overlaps the region at all is skipped on both
// sides — that is the region each side is allowed to differ in — so any
// absorption across the boundary shows up as a node present on one side and
// absent (or differently spanned) on the other.
//
// Returns null when any node lacks a usable position: an unprovable baseline
// is refused, never treated as "nothing to compare".
function outsideSignature(tree, regionStart, regionEnd, delta) {
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
    if (start < regionEnd && end > regionStart) return
    const from = start <= regionStart ? start : start - delta
    const to = end <= regionStart ? end : end - delta
    parts.push(`${node.type}:${from}:${to}`)
    for (const child of node.children || []) walk(child)
  }
  for (const child of tree.children || []) walk(child)
  return ok ? parts.join('\n') : null
}

// Same exclusive-end + one-step-back recovery idiom as block-type.js's own
// `topLevelNodeAt` (which mirrors quote-toggle.js and enter.js): walking the
// ROOT's children is what proves the target is TOP-LEVEL, so a paragraph
// nested in a blockquote or a list item is never found here and the command
// refuses instead of writing a multi-line block whose meaning inside that
// container it has not proven.
function within(node, offset) {
  const start = node?.position?.start?.offset
  const end = node?.position?.end?.offset
  return Number.isInteger(start) && Number.isInteger(end) && offset >= start && offset < end
}

function topLevelNodeAt(index, offset) {
  const children = index.tree?.children || []
  const direct = children.find((node) => within(node, offset))
  if (direct) return direct
  if (offset > 0) {
    const before = children.find((node) => within(node, offset - 1))
    if (before && offset === before.position.end.offset) return before
  }
  return null
}

// Identical to block-type.js's: a SETEXT heading's span runs through its
// underline, so the `end !== offset` refusal below already rejects it; this is
// the belt-and-suspenders half.
const ATX_HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/
const SOURCE_TYPES = new Set(['paragraph', 'heading'])

export function insertBlockFromQuery({ doc, index, offset, target, language }) {
  const spec = BLOCK_INSERT_TARGETS[target]
  if (!spec) return { ok: false, code: 'unsupported-structure' }
  if (!Number.isInteger(offset) || offset < 1) return { ok: false, code: 'unsupported-structure' }
  const info = language == null ? '' : String(language)
  if (info && (!spec.language || !LANGUAGE_RE.test(info))) {
    return { ok: false, code: 'unsupported-structure' }
  }

  const node = topLevelNodeAt(index, offset)
  if (!node || !SOURCE_TYPES.has(node.type)) return { ok: false, code: 'unsupported-structure' }
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return { ok: false, code: 'unsupported-structure' }
  }
  // The caret MUST sit exactly at the block's own end — `shouldShow`'s
  // `atEndOfBlock` restated on the raw side, and the proof that the span about
  // to be replaced holds nothing but the block's syntax and the typed query.
  if (end !== offset) return { ok: false, code: 'unsupported-structure' }
  const text = doc.text
  if (node.type === 'heading' && !ATX_HEADING_RE.test(text.slice(start, end))) {
    return { ok: false, code: 'unsupported-structure' }
  }

  const built = buildBlock(target, info, index.dominantEnding || '\n')
  if (!built) return { ok: false, code: 'unsupported-structure' }
  const { bytes } = built
  const candidate = text.slice(0, start) + bytes + text.slice(end)
  const insertedEnd = start + bytes.length

  let candidateTree
  let baselineTree
  try {
    candidateTree = parseKernelMarkdown(candidate)
    // The BASELINE is re-parsed here rather than reusing `index.tree`: the
    // index's tree carries `injectHighlightNodes`'s split text nodes, which the
    // candidate parse (a plain `parseKernelMarkdown`) does not, so comparing
    // the two would report differences that are purely an artefact of the
    // injection. Same reasoning image-attrs.js records for its own axis (b).
    baselineTree = parseKernelMarkdown(text)
  } catch {
    return { ok: false, code: 'unsupported-structure' }
  }

  // Axis (a): the block at the insertion point is the one we wrote, and it
  // ends exactly where our bytes end (nothing after it was absorbed).
  const inserted = (candidateTree.children || []).find(
    (child) => child.position?.start?.offset === start
  )
  if (!inserted || inserted.position?.end?.offset !== insertedEnd) {
    return { ok: false, code: 'unsupported-structure' }
  }
  if (!shapeAgrees(target, inserted, candidate, info)) {
    return { ok: false, code: 'unsupported-structure' }
  }

  // Axis (b): nothing outside the rewritten region changed meaning.
  const delta = bytes.length - (end - start)
  const before = outsideSignature(baselineTree, start, end, 0)
  const after = outsideSignature(candidateTree, start, insertedEnd, delta)
  if (before === null || after === null || before !== after) {
    return { ok: false, code: 'unsupported-structure' }
  }

  const anchor = start + built.anchor
  // The task seed's ledger entry (`ascii: ''` — "this U+00A0 stands for NO
  // keystroke; it may only ever be DISSOLVED, never healed to a space"). The
  // span is re-asserted against the candidate bytes here, on top of
  // `shapeAgrees`' own position check, because a ledger entry that vouches for
  // the wrong byte would let the dissolve delete a character the user owns.
  const seedMarks = built.seed &&
    candidate.slice(start + built.seed.from, start + built.seed.to) === NO_BREAK_SPACE
    ? [{ from: start + built.seed.from, to: start + built.seed.to, ascii: '' }]
    : null
  if (built.seed && !seedMarks) return { ok: false, code: 'unsupported-structure' }
  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      edits: [{ from: start, to: end, insert: bytes }],
      intent: 'insert-block',
      selection: { anchor, head: anchor },
      ...(seedMarks ? { whitespaceMarks: seedMarks } : {})
    }
  }
}
