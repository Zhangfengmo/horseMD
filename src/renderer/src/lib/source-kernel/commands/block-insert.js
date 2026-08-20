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
// CARET-AFTER TARGETS (divider, 2026-08-20). A thematic break is a PM leaf
// with no text position, so the caret's home is NECESSARILY outside the bytes
// this command writes. That used to be the refusal reason; what dissolved it
// is that both homes the caret can take are now proven by machinery that
// already exists, with no new anchor class:
//   * LAST root child -> the trailing virtual pair. `safeParse` mirrors
//     `@milkdown/plugin-trailing` (an atom-ending document always gains one
//     empty trailing paragraph), `buildProjectionMap` pairs it editable at
//     `markdown.length`, and the controller's `requireMap: true` proves —
//     PRE-commit — that this command's anchor (`candidate.length`) resolves
//     through the REBUILT map. Typing there is the same virtual-pair commit
//     the trailing placeholder has always taken (locked by
//     test-kernel-trailing-atom-typing.mjs).
//   * followed by a PARAGRAPH/HEADING -> that block's own content anchor,
//     `buildCharacterMap(candidate, next).visibleToRaw(0)` — the exact
//     primitive heading-whitespace.js / line-start-whitespace.js /
//     link-toggle.js already anchor with. Axis (b) proves `next` is the same
//     block it was (type + shifted span), block spans are disjoint, and the
//     preceding block is the just-written atom (charMap: null), so
//     `rawToPmPos(anchor)` can only resolve inside `next` — never
//     "resolvable but wrong".
//   * followed by anything else (list, fence, table, quote, another leaf…) —
//     REFUSED with its own code (`no-caret-home-after-insert`) whose message
//     names the workaround, per the standing rule against inventing an
//     anchor-into-an-unwritten-block proof class.
//
// DELIBERATELY ABSENT, for a probed reason (see the task report):
//   * image — Crepe's `image-block` is an ATOM, paired here with `charMap:
//     null` (read-only leaf). Its byte spelling `![]()` is writable, but the
//     caret would have no home inside the created card.
// It must keep refusing rather than guess.
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
import { buildCharacterMap } from '../character-map.js'
import { NO_BREAK_SPACE } from './trailing-whitespace.js'

// A caret-after insert whose following block cannot host the caret. Its own
// code (not the generic `unsupported-structure`) because the refusal has a
// concrete remedy the message must name: insert at the document end, or put a
// plain text line below the insertion point first.
const NO_CARET_HOME = 'no-caret-home-after-insert'

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
  task: Object.freeze({ language: false }),
  // Thematic break (2026-08-20): a caret-AFTER target — the written block has
  // no text position, so the caret lands in the trailing virtual pair (doc
  // end) or the following paragraph/heading's content anchor. See the
  // CARET-AFTER section in this file's header.
  divider: Object.freeze({ language: false })
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
  if (target === 'divider') {
    // TWO spellings, tried cheapest-first under the SAME two-axis proof —
    // the candidate-list discipline image-attrs.js established. `---` is the
    // human convention (what Typora/Mark Text write, what this repo's own
    // fixtures use) and wins whenever it parses as a thematicBreak. The one
    // shape where it cannot: the query is the document's FIRST block and a
    // later `---` line exists, so remark-frontmatter reads the pair as a YAML
    // block swallowing everything between (probed: '---\n\nabc\n\n---' is ONE
    // `yaml[0,13)` node — axis (a) catches it, the inserted node's end is not
    // the written bytes' end). `***` is the same thematicBreak to every
    // CommonMark parser and can never open frontmatter, so it is the fallback
    // spelling for exactly that shape rather than a refusal.
    // `caretAfter`: the caret's home is OUTSIDE the written bytes — derived
    // after the axis proofs, from the accepted candidate's own parse (see
    // caretAfterInsert).
    return { spellings: ['---', '***'], caretAfter: true }
  }
  return null
}

// Where the caret lands for a `caretAfter` target, derived from the ACCEPTED
// candidate's own parse (never searched for in the pre-insert document):
//   * no root child after the inserted block -> the document end. The
//     controller's `requireMap: true` then proves `candidate.length` resolves
//     through the rebuilt map's trailing virtual pair before any byte moves.
//   * next root child is a paragraph/heading -> its content anchor,
//     `buildCharacterMap(candidate, next).visibleToRaw(0)` — asserted to sit
//     inside `next`'s own span. A paragraph whose SINGLE child is an image is
//     excluded first: that is exactly the shape Crepe's remarkImageBlock
//     turns into a block-level `image-block` ATOM (charMap: null), so the
//     "paragraph" has no addressable content position in the projection.
//   * anything else -> `no-caret-home-after-insert`, whose message names the
//     workaround (document end, or a text line below first).
function caretAfterInsert(candidate, candidateTree, inserted) {
  const children = candidateTree.children || []
  const index = children.indexOf(inserted)
  if (index < 0) return { ok: false, code: 'unsupported-structure' }
  const next = children[index + 1] || null
  if (!next) return { ok: true, anchor: candidate.length }
  if (next.type !== 'paragraph' && next.type !== 'heading') {
    return { ok: false, code: NO_CARET_HOME }
  }
  if (next.type === 'paragraph') {
    const inline = next.children || []
    if (inline.length === 1 && inline[0]?.type === 'image') {
      return { ok: false, code: NO_CARET_HOME }
    }
  }
  let map = null
  try {
    map = buildCharacterMap(candidate, next)
  } catch {
    map = null
  }
  const anchor = map ? map.visibleToRaw(0) : null
  const nextStart = next.position?.start?.offset
  const nextEnd = next.position?.end?.offset
  if (!Number.isInteger(anchor) || !Number.isInteger(nextStart) || !Number.isInteger(nextEnd) ||
      anchor < nextStart || anchor > nextEnd) {
    return { ok: false, code: NO_CARET_HOME }
  }
  return { ok: true, anchor }
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
  if (target === 'divider') {
    // A thematicBreak has no interior at all, so the caller's span check
    // (`position.end.offset === insertedEnd`) carries the whole absorption
    // proof; the type is what rejects the frontmatter reading (`yaml`) and
    // the setext reading (`heading` — impossible here since the query block
    // is preceded by a blank line, but proven rather than assumed).
    return node.type === 'thematicBreak'
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

  let baselineTree
  try {
    // The BASELINE is re-parsed here rather than reusing `index.tree`: the
    // index's tree carries `injectHighlightNodes`'s split text nodes, which the
    // candidate parse (a plain `parseKernelMarkdown`) does not, so comparing
    // the two would report differences that are purely an artefact of the
    // injection. Same reasoning image-attrs.js records for its own axis (b).
    baselineTree = parseKernelMarkdown(text)
  } catch {
    return { ok: false, code: 'unsupported-structure' }
  }
  const before = outsideSignature(baselineTree, start, end, 0)

  // Every spelling runs the FULL two-axis proof; the first that passes wins
  // (single-spelling targets just have a one-entry list). A spelling that
  // fails an axis is not an error — the next one is tried — but a target
  // whose every spelling fails refuses exactly as before.
  let accepted = null
  for (const bytes of built.spellings || [built.bytes]) {
    const candidate = text.slice(0, start) + bytes + text.slice(end)
    const insertedEnd = start + bytes.length

    let candidateTree
    try {
      candidateTree = parseKernelMarkdown(candidate)
    } catch {
      continue
    }

    // Axis (a): the block at the insertion point is the one we wrote, and it
    // ends exactly where our bytes end (nothing after it was absorbed).
    const inserted = (candidateTree.children || []).find(
      (child) => child.position?.start?.offset === start
    )
    if (!inserted || inserted.position?.end?.offset !== insertedEnd) continue
    if (!shapeAgrees(target, inserted, candidate, info)) continue

    // Axis (b): nothing outside the rewritten region changed meaning.
    const delta = bytes.length - (end - start)
    const after = outsideSignature(candidateTree, start, insertedEnd, delta)
    if (before === null || after === null || before !== after) continue

    accepted = { bytes, candidate, candidateTree, inserted }
    break
  }
  if (!accepted) return { ok: false, code: 'unsupported-structure' }
  const { bytes, candidate, candidateTree, inserted } = accepted

  let anchor
  if (built.caretAfter) {
    const caret = caretAfterInsert(candidate, candidateTree, inserted)
    if (!caret.ok) return { ok: false, code: caret.code }
    anchor = caret.anchor
  } else {
    anchor = start + built.anchor
  }
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
