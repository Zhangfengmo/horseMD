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
// THAT RULE HAS SINCE BEEN PARTLY DISSOLVED, and this note exists so the next
// reader does not re-derive it (2026-08-21 named-refusal sweep; the `/quote`
// precedent is what an un-revisited "impossible" costs). The missing proof
// class arrived with `revertMidDocument`'s CONVERGENCE proof below: type a
// probe character at the anchor and require a root-level paragraph spanning
// exactly the probe with everything else unchanged. Measured against it, the
// refusal above is right for two of the four block kinds its message
// enumerates and WRONG for the other two:
//
//   `---` then a FENCED CODE BLOCK -> converges ('---\nx\n```js…' is
//       thematicBreak, paragraph(x), code)
//   `---` then a TABLE             -> converges
//   `---` then a BULLET LIST       -> does NOT ('x\n- 甲' is ONE paragraph)
//   `---` then a BLOCKQUOTE        -> does NOT (same)
//   `![]()` then a bullet list     -> does NOT (the probe joins the image's
//       own paragraph — an image-block atom has no root-level gap after it)
//
// Not fixed here, and the blocker is specific rather than budgetary: the
// controller's placeholder route verifies a DELETION (`docNode.childCount ===
// childrenBefore - 1`, editor-kernel-mode.js `runInsertBlockFromQuery`). An
// insert keeps the child count, so it needs its own post-commit facts before
// `materializePlaceholder` may be called — a new route, not a widened
// condition. Recorded in named-refusals-report.md §Item 3.
//
// `image` joined the caret-after set the same day. `![]()` is the ONE byte
// answer every reference agrees on (muya writes the identical literal, and
// CommonMark has no grammar ambiguity here — unlike the task-item case):
// mdast `paragraph > image url:'' alt:''`, which is EXACTLY the shape
// Crepe's remarkImageBlock converts to its block-level `image-block` card,
// whose own upload/paste-link UI then routes the src through the
// kernel-proven image-attrs.js. The card is an ATOM (charMap: null), so the
// caret takes the same two proven homes as divider — never a position
// "inside" the card.
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
import { outsideSignature, provePredictedListMerge } from './list-merge.js'

// A caret-after insert whose following block cannot host the caret. Its own
// code (not the generic `unsupported-structure`) because the refusal has a
// concrete remedy the message must name: insert at the document end, or put a
// plain text line below the insertion point first.
const NO_CARET_HOME = 'no-caret-home-after-insert'

// `/text` whose block cannot be emptied WHERE IT STANDS: deleting it would
// change the blocks around it (two lists closing over the gap into one), or a
// character typed in the gap it leaves would join a neighbour instead of
// becoming its own paragraph. Both are the same fact to the user — "the empty
// line here has no source bytes that mean an empty line" — so they share one
// code whose message names the remedy.
const TEXT_NEIGHBORS_MERGE = 'text-neighbors-would-merge'

// The character the mid-document proof TYPES into the gap to show the caret's
// home converges (see revertMidDocument). An ordinary letter on purpose: it
// carries no CommonMark meaning of its own, so what the proof measures is the
// POSITION, never the character.
const PROBE_CHAR = 'x'

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
  // `merges` (2026-08-21): the ONE target that writes a LIST ITEM, so it is
  // the one whose neighbours CommonMark may legally absorb it into. See the
  // predicted-merge branch below and commands/list-merge.js.
  task: Object.freeze({ language: false, merges: true, ordered: false }),
  // Thematic break (2026-08-20): a caret-AFTER target — the written block has
  // no text position, so the caret lands in the trailing virtual pair (doc
  // end) or the following paragraph/heading's content anchor. See the
  // CARET-AFTER section in this file's header.
  divider: Object.freeze({ language: false }),
  // Empty image card (2026-08-20): `![]()` — the second caret-AFTER target;
  // the created image-block atom carries its own upload UI, so the caret's
  // only honest homes are the divider's two. See the header.
  image: Object.freeze({ language: false }),
  // Revert-to-paragraph (2026-08-20): the ONE target that writes no block at
  // all — a fully-empty top-level paragraph has no raw representation
  // (CommonMark: a blank line is a block separator, not a node), so "/text"
  // means DELETE the query block and hand the caret to the split-placeholder
  // machinery. Works ANYWHERE since 2026-08-21 (mid-document included); the
  // only refusals left are positional and proven, not a stopgap. See
  // revertToTextFromQuery below.
  text: Object.freeze({ language: false })
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
  if (target === 'image') {
    // ONE spelling — every reference agrees on it (muya writes this literal;
    // CommonMark parses it without ambiguity; image-attrs.js's segmenter
    // owns the same `![...](...)` grammar for later src edits). One line, no
    // interior endings, so the document's endings are never touched.
    return { spellings: ['![]()'], caretAfter: true }
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
  // The sibling list the inserted node lives in: root children when the
  // insert was top-level, the enclosing blockquote's children when it was
  // quoted (2026-08-30, the quoted /divider). Found by identity, walking
  // through blockquotes only — the same chain the insert itself used.
  const siblingsOf = (tree) => {
    let found = null
    const walk = (list) => {
      if (found) return
      for (const node of list) {
        if (node === inserted) { found = list; return }
        if (node.type === 'blockquote') walk(node.children || [])
      }
    }
    walk(tree.children || [])
    return found
  }
  const children = siblingsOf(candidateTree) || []
  const index = children.indexOf(inserted)
  if (index < 0) return { ok: false, code: 'unsupported-structure' }
  const next = children[index + 1] || null
  const quoted = children !== (candidateTree.children || []) &&
    !(candidateTree.children || []).includes(inserted)
  // No sibling after: at top level the document end is a proven home (the
  // trailing pair); inside a quote it is not — the named refusal's message
  // tells the user to add a line below first.
  if (!next) return quoted ? { ok: false, code: NO_CARET_HOME } : { ok: true, anchor: candidate.length }
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

// `/text` (2026-08-20) — revert the query block to a plain paragraph. There
// is nothing to WRITE: a fully-empty top-level paragraph has no byte
// spelling (CommonMark: a blank line is a block separator, not a node), so
// the honest edit DELETES the query block's bytes and the caret rides the
// SPLIT-PLACEHOLDER machinery — a view-only empty paragraph the controller
// vouches for at a pmPos, which converges to real bytes the moment content
// lands in it. Two positions, two homes, one dispatcher:
//   * the query is the document's LAST root child -> revertAtDocEnd;
//   * anything else -> revertMidDocument (2026-08-21).
// `/text` INSIDE A QUOTE (2026-08-31): delete the query block's content
// bytes and leave its line as the quote-prefix-only `> ` — a blank quote
// line, CommonMark's own separator, so no neighbour can merge across it.
// Proven by reparse: outside the deleted span (walked THROUGH containers,
// the quoted convention) nothing changes meaning, and the query's line in
// the candidate really is quote markers and nothing else. The caret anchors
// after the prefix and rides the same bare-quote virtual pair / vouched
// placeholder the staged exit and the quote-end /divider use
// (`quotePlaceholder` — the controller places or materializes it).
function revertQuotedText({ doc, index, start, end }) {
  const text = doc.text
  let baselineTree
  let candidateTree
  const candidate = text.slice(0, start) + text.slice(end)
  try {
    baselineTree = parseKernelMarkdown(text)
    candidateTree = parseKernelMarkdown(candidate)
  } catch {
    return { ok: false, code: 'unsupported-structure' }
  }
  // PROOF SHAPE (differs from the shared container-walk signature on
  // purpose): the deletion legitimately SHRINKS the enclosing blockquote's
  // reported span — remark stops counting the now-blank trailing quote
  // lines — so an overlap-driven walk signs the container on one side only
  // (measured: quote-end /text refused while mid-quote passed). Containers
  // are therefore NEVER signed: both walks descend through blockquotes
  // unconditionally, every non-container node must match (candidate offsets
  // past the deletion shifted back), the baseline skips exactly the query
  // block, and the blockquote COUNT is asserted unchanged — the quote
  // itself must survive the revert.
  const shift = end - start
  const signThroughQuotes = (tree, skipQuery) => {
    const parts = []
    let ok = true
    const walk = (node) => {
      if (!ok) return
      const s = node.position?.start?.offset
      const e = node.position?.end?.offset
      if (!Number.isInteger(s) || !Number.isInteger(e)) { ok = false; return }
      if (node.type === 'blockquote') {
        for (const child of node.children || []) walk(child)
        return
      }
      if (skipQuery && s >= start && e <= end) return
      const from = skipQuery ? s : s <= start ? s : s + shift
      const to = skipQuery ? e : e <= start ? e : e + shift
      parts.push(`${node.type}:${from}:${to}`)
      for (const child of node.children || []) walk(child)
    }
    for (const child of tree.children || []) walk(child)
    return ok ? parts.join('\n') : null
  }
  const countQuotes = (tree) => {
    let n = 0
    const walk = (node) => {
      if (node?.type === 'blockquote') n += 1
      for (const child of node?.children || []) walk(child)
    }
    walk(tree)
    return n
  }
  const before = signThroughQuotes(baselineTree, true)
  const after = signThroughQuotes(candidateTree, false)
  if (before === null || after === null || before !== after) {
    return { ok: false, code: 'unsupported-structure' }
  }
  if (countQuotes(baselineTree) !== countQuotes(candidateTree)) {
    return { ok: false, code: 'unsupported-structure' }
  }
  // The candidate's line at the anchor must be quote markers and nothing
  // else — the exact spelling the placeholder machinery vouches for.
  const lineStart = candidate.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  let lineEnd = candidate.indexOf('\n', start)
  if (lineEnd < 0) lineEnd = candidate.length
  if (!/^[ \t]*(?:>[ \t]*)*>[ \t]*$/.test(candidate.slice(lineStart, lineEnd))) {
    return { ok: false, code: 'unsupported-structure' }
  }
  return {
    ok: true,
    quotePlaceholder: true,
    transaction: {
      baseRevision: doc.revision,
      edits: [{ from: start, to: end, insert: '' }],
      intent: 'insert-block',
      selection: { anchor: start, head: start }
    }
  }
}

function revertToTextFromQuery({ doc, start, end }) {
  const text = doc.text
  let baselineTree
  try {
    baselineTree = parseKernelMarkdown(text)
  } catch {
    return { ok: false, code: 'unsupported-structure' }
  }
  const children = baselineTree.children || []
  const queryIndex = children.findIndex((child) => child.position?.start?.offset === start)
  if (queryIndex < 0) return { ok: false, code: 'unsupported-structure' }
  if (children[queryIndex].position?.end?.offset !== end) {
    return { ok: false, code: 'unsupported-structure' }
  }
  return queryIndex === children.length - 1
    ? revertAtDocEnd({ doc, text, baselineTree, start, end })
    : revertMidDocument({ doc, text, baselineTree, start, end })
}

// `/text` on the document's LAST block. The edit deletes the query block plus
// every byte after it — the surplus line the strip would otherwise leave —
// and the caret takes one of the two doc-end homes:
//   * candidate's last block is NOT a paragraph/heading (list/table/fence/
//     atom…, or the candidate is empty): safeParse's trailing paragraph
//     exists by plugin-trailing's own condition, the map pairs it virtual at
//     `candidate.length`, and the controller's `requireMap: true` proves the
//     anchor PRE-commit — the same doc-end home /divider takes.
//   * candidate's last block IS a paragraph/heading: no trailing pair exists,
//     so the controller materializes a VOUCHED placeholder at the document
//     end (`materializePlaceholder` — the split-placeholder session, itself
//     fail-closed: an unprovable voucher removes the placeholder again). A
//     vouched pair commits with NO separator prefix, which is byte-correct
//     here precisely because the blank-line separator that stood before the
//     query block STAYS in the candidate — asserted below, never assumed.
//     Reported to the controller via `docEndPlaceholder: true`.
// THE PROOF: the deletion is a pure suffix removal, so every remaining
// node's span is byte-identical — the candidate's full signature must equal
// the baseline's signature with the query block's region excluded, or the
// command refuses.
function revertAtDocEnd({ doc, text, baselineTree, start, end }) {
  const candidate = text.slice(0, start)
  let candidateTree
  try {
    candidateTree = parseKernelMarkdown(candidate)
  } catch {
    return { ok: false, code: 'unsupported-structure' }
  }
  // Everything between the query block's end and the document end must be
  // whitespace — those are the only other bytes this edit deletes.
  if (!/^[ \t\r\n]*$/.test(text.slice(end))) return { ok: false, code: 'unsupported-structure' }

  // The suffix-removal proof (see above). The empty region at the candidate's
  // end excludes nothing, so `after` is the candidate's FULL signature.
  const before = outsideSignature(baselineTree, start, text.length, 0)
  const after = outsideSignature(candidateTree, candidate.length, candidate.length, 0)
  if (before === null || after === null || before !== after) {
    return { ok: false, code: 'unsupported-structure' }
  }

  const rest = candidateTree.children || []
  const lastKept = rest.length ? rest[rest.length - 1] : null
  const docEndPlaceholder = !!lastKept &&
    (lastKept.type === 'paragraph' || lastKept.type === 'heading')
  if (docEndPlaceholder) {
    const keptEnd = lastKept.position?.end?.offset
    if (!Number.isInteger(keptEnd)) return { ok: false, code: 'unsupported-structure' }
    // The voucher commits with NO separator prefix, so the kept bytes MUST
    // already end in a blank line (the separator that stood before the query
    // block). Proven rather than assumed: a candidate violating this refuses
    // instead of letting the next keystroke commit a lazy continuation line
    // of the last paragraph.
    const sep = candidate.slice(keptEnd)
    if (!/(?:\r\n|\n|\r)[ \t]*(?:\r\n|\n|\r)[ \t\r\n]*$/.test(sep)) {
      return { ok: false, code: 'unsupported-structure' }
    }
  }

  const anchor = candidate.length
  return {
    ok: true,
    docEndPlaceholder,
    transaction: {
      baseRevision: doc.revision,
      edits: [{ from: start, to: text.length, insert: '' }],
      intent: 'revert-to-text',
      selection: { anchor, head: anchor }
    }
  }
}

// `/text` MID-DOCUMENT (2026-08-21) — the shape the 2026-08-20 pass refused
// with `text-needs-document-end`. What dissolved the refusal is that the gap
// it leaves is not a new problem class at all: it is EXACTLY the blank-line
// gap structural Enter has produced mid-document since Task 11.5, served by
// the same controller-vouched split-placeholder session (a single-object
// `pendingPlaceholder`, deliberately exempt from the trailing floor — see
// buildProjectionMap). The bytes are even identical: Enter at the end of `甲`
// in `甲\n\n乙\n` writes `甲\n\n` + `\n\n乙\n`, and deleting the query block
// from `甲\n\n/text\n\n乙\n` leaves the very same `甲\n\n\n\n乙\n`.
//
// The edit is therefore the MINIMAL one — delete exactly the query block's
// own bytes, `{ from: start, to: end, insert: '' }` — leaving the separators
// that stood on either side of it untouched. Two proofs, both pure reparses,
// because a deletion mid-document CAN change what surrounds it in ways a
// suffix deletion never can:
//
//   (1) THE DELETION PROOF. Everything outside the removed region must still
//       mean the same thing, offsets shifted by the deletion delta —
//       `outsideSignature`, axis (b) of this file's standing discipline. The
//       shape this catches is the list merge: `- a` / `/text` / `- b` closes
//       over the gap into ONE loose two-item list (CommonMark 0.28 dropped
//       the two-blank-lines rule), so the baseline's two `list` nodes collapse
//       into one that STRADDLES the region and is skipped — the signatures
//       cannot match, and the command refuses instead of silently restructuring
//       the user's document.
//
//   (2) THE CONVERGENCE PROOF. A placeholder is only honest if the first
//       character typed in it becomes a real paragraph AT THAT OFFSET. That is
//       not implied by (1): `甲\n# /text\n\n乙` deletes cleanly (a heading may
//       interrupt a paragraph, so its removal leaves `甲\n\n\n乙`) yet the
//       anchor sits one line ending away from `甲`, where a typed character
//       would become a LAZY CONTINUATION of it. So the proof TYPES: a probe
//       character is inserted at the anchor and the result must reparse to a
//       root-level `paragraph` holding exactly that probe, spanning exactly
//       the probe's bytes, with everything else unchanged. It is a proof by
//       construction rather than a separator regex, which is why it also
//       ACCEPTS the shapes a regex would wrongly refuse (a heading, list or
//       fence directly below the gap with no blank line — all of which
//       legally interrupt a paragraph).
//
// The anchor is `start` itself: after the deletion that offset sits strictly
// inside the blank run (the next block can only have moved to `start + 1` or
// later — top-level siblings are always separated by at least one line
// ending), so `rawToPmPos` fails closed there exactly as it does for Enter's
// gap, and the vouched virtual pair is the only thing that can serve it.
function revertMidDocument({ doc, text, baselineTree, start, end }) {
  const candidate = text.slice(0, start) + text.slice(end)
  const delta = -(end - start)
  let candidateTree
  try {
    candidateTree = parseKernelMarkdown(candidate)
  } catch {
    return { ok: false, code: 'unsupported-structure' }
  }
  const before = outsideSignature(baselineTree, start, end, 0)
  // The removed region collapses to a POINT in the candidate, so only a node
  // straddling it is excluded there — which is precisely how a merge shows up.
  const after = outsideSignature(candidateTree, start, start, delta)
  if (before === null || after === null || before !== after) {
    return { ok: false, code: TEXT_NEIGHBORS_MERGE }
  }

  // (2) The convergence proof.
  const probe = candidate.slice(0, start) + PROBE_CHAR + candidate.slice(start)
  let probeTree
  try {
    probeTree = parseKernelMarkdown(probe)
  } catch {
    return { ok: false, code: TEXT_NEIGHBORS_MERGE }
  }
  const typed = (probeTree.children || []).find(
    (child) => child.position?.start?.offset === start
  )
  if (!typed || typed.type !== 'paragraph' ||
      typed.position?.end?.offset !== start + PROBE_CHAR.length) {
    return { ok: false, code: TEXT_NEIGHBORS_MERGE }
  }
  const inline = typed.children || []
  if (inline.length !== 1 || inline[0]?.type !== 'text' || inline[0].value !== PROBE_CHAR) {
    return { ok: false, code: TEXT_NEIGHBORS_MERGE }
  }
  const probeSignature = outsideSignature(
    probeTree, start, start + PROBE_CHAR.length, delta + PROBE_CHAR.length
  )
  if (probeSignature === null || probeSignature !== before) {
    return { ok: false, code: TEXT_NEIGHBORS_MERGE }
  }

  return {
    ok: true,
    midPlaceholder: true,
    transaction: {
      baseRevision: doc.revision,
      edits: [{ from: start, to: end, insert: '' }],
      intent: 'revert-to-text',
      selection: { anchor: start, head: start }
    }
  }
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
  if (target === 'image') {
    // Exactly the shape remarkImageBlock converts to the image-block card: a
    // paragraph whose SINGLE inline child is an `image`, empty url/alt, no
    // title, spanning the whole written bytes (probed: `![]()` ->
    // paragraph[0,5) > image url:'' alt:'' title:null). Any inline content
    // beside the image means bytes this command never wrote.
    if (node.type !== 'paragraph') return false
    const inline = node.children || []
    if (inline.length !== 1 || inline[0]?.type !== 'image') return false
    const img = inline[0]
    if (img.url !== '' || (img.alt ?? '') !== '' || img.title != null) return false
    const imgStart = img.position?.start?.offset
    const imgEnd = img.position?.end?.offset
    if (!Number.isInteger(imgStart) || !Number.isInteger(imgEnd)) return false
    // The image IS the paragraph, byte for byte.
    return imgStart === node.position?.start?.offset &&
      imgEnd === node.position?.end?.offset &&
      text.slice(imgStart, imgEnd) === '![]()'
  }
  if (target === 'task') {
    // Exactly ONE bullet item, REALLY a task (`checked === false`, never the
    // `null` every ASCII spelling comes back with), whose paragraph's whole
    // decoded content is the single seed U+00A0 sitting at the marker's end —
    // which is also the byte the caret anchor and the ledger span are derived
    // from, so it is asserted against the candidate bytes directly. A
    // neighbouring list this insert MERGES into fails this reading's span
    // check (the reparsed list ends past the written bytes — probed:
    // '- [ ]  \n- x\n' is ONE two-item list), so `/task` refuses right
    // above an existing list), which is exactly the shape the predicted-merge
    // proof in list-merge.js takes over — that reading calls `taskItemAgrees`
    // on the merged list's own item instead of on a wrapper that no longer
    // exists.
    if (node.type !== 'list' || node.ordered) return false
    const items = node.children || []
    if (items.length !== 1) return false
    return taskItemAgrees(items[0], text)
  }
  return false
}

// The task item's own interior, asked independently of WHICH list holds it.
// The standalone reading above checks the one-item list wrapper and then
// this; the predicted-merge reading (see insertBlockFromQuery) has no
// standalone wrapper to check and asks this of the merged list's own item.
// Splitting the two is what lets the merge accept a neighbour's items
// without ever relaxing what "the item I wrote" has to be.
function taskItemAgrees(item, text) {
  if (item?.type !== 'listItem') return false
  if (item.checked !== false) return false
  const blocks = item.children || []
  if (blocks.length !== 1 || blocks[0]?.type !== 'paragraph') return false
  const inline = blocks[0].children || []
  if (inline.length !== 1 || inline[0]?.type !== 'text') return false
  if (inline[0].value !== NO_BREAK_SPACE) return false
  const seedStart = inline[0].position?.start?.offset
  const seedEnd = inline[0].position?.end?.offset
  if (!Number.isInteger(seedStart) || seedEnd !== seedStart + 1) return false
  return text.slice(seedStart, seedEnd) === NO_BREAK_SPACE
}

// Same exclusive-end + one-step-back recovery idiom as block-type.js's own
// walk (which mirrors quote-toggle.js and enter.js), applied per nesting
// level. Since 2026-08-22 the walk descends through BLOCKQUOTES ONLY — the
// same relaxation block-type.js took for the「引用内嵌套」report: a query
// paragraph under a pure quote chain starts at its own line's content
// position, so a block written there means what it means at top level,
// PROVIDED every continuation line carries the quote prefix (spelled by
// `quoteSpelling` below) — and the two proof axes then run against the
// chain, not the root. A list item on the chain still stops the walk cold.
function within(node, offset) {
  const start = node?.position?.start?.offset
  const end = node?.position?.end?.offset
  return Number.isInteger(start) && Number.isInteger(end) && offset >= start && offset < end
}

function levelNodeAt(children, offset) {
  const direct = children.find((node) => within(node, offset))
  if (direct) return direct
  if (offset > 0) {
    const before = children.find((node) => within(node, offset - 1))
    if (before && offset === before.position.end.offset) return before
  }
  return null
}

function quoteChainNodeAt(tree, offset) {
  let children = tree?.children || []
  let quoteDepth = 0
  for (;;) {
    const hit = levelNodeAt(children, offset)
    if (!hit) return null
    if (hit.type === 'blockquote') {
      quoteDepth += 1
      children = hit.children || []
      continue
    }
    return { node: hit, quoteDepth }
  }
}

// The quoted spelling of a multi-line block: every CONTINUATION line gets the
// query line's own prefix bytes, verbatim — including the trailing space of a
// `> ` and including EMPTY lines (code-map.js checks each content line for
// the FULL derived prefix byte-for-byte; a bare `>` blank would fail it and
// leave the created fence read-only). The anchor is remapped through the same
// transform, with one deliberate asymmetry probed against the projection map:
// an anchor at a continuation line's COLUMN 0 (the code/math "empty content
// line" anchor) stays at the LINE START, before the inserted prefix — the
// quoted code map anchors that line's single visible unit at its raw line
// start (the unit's span swallows the prefix), so the pre-prefix offset is
// the one `rawToPmPos` resolves; the post-prefix offset is interior to the
// unit and resolves to nothing. A mid-line anchor (the table's first-cell
// `|  ` padding) lands after the prefix at the same column, unchanged.
function quoteSpelling(bytes, ending, prefix, anchor) {
  const lines = bytes.split(ending)
  let out = lines[0]
  let outAnchor = anchor <= lines[0].length ? anchor : null
  let consumed = lines[0].length
  for (let i = 1; i < lines.length; i += 1) {
    consumed += ending.length
    out += ending
    if (outAnchor === null && anchor === consumed) outAnchor = out.length
    out += prefix
    if (outAnchor === null && anchor <= consumed + lines[i].length) {
      outAnchor = out.length + (anchor - consumed)
    }
    out += lines[i]
    consumed += lines[i].length
  }
  return { bytes: out, anchor: outAnchor === null ? out.length : outAnchor }
}

// list-merge.js's `outsideSignature` with ONE difference, for the quoted
// path only: a node that overlaps the region is still never signed, but its
// CHILDREN are walked — the region now sits INSIDE blockquote ancestors, and
// pruning their whole subtree would leave the quote's own sibling blocks
// unsigned (i.e. unprotected). Fully-contained descendants all overlap the
// region themselves, so for every top-level region the two functions agree —
// which is why the shared helper (whose merge-proof account is written
// against its skip semantics) stays untouched.
// Duplicated from block-type.js with a note (the same way this module
// duplicates `topLevelNodeAt`): a container's recorded END is remark
// bookkeeping wherever it runs past the last positioned descendant over
// quote-prefix/whitespace bytes only — measured 2026-08-23, a quoted list's
// end depends on what its NEXT SIBLING is, so an insert next to it silently
// re-records the untouched list's end.
const clampedNodeEnd = (node, text) => {
  const end = node.position.end.offset
  if (!node.children?.length || typeof text !== 'string') return end
  // RECURSIVE (2026-08-31, the nested-quoted-list report): a nested
  // container child carries the SAME inflated bookkeeping, so taking raw
  // child ends let one level of nesting pin `last` at the inflated value
  // and the clamp never fired (measured: `> - 甲\n>   - 乙` above a quoted
  // slash query refused every list conversion). Each child is clamped
  // first; the walk then sees content ends only.
  let last = null
  for (const child of node.children) {
    const e = clampedNodeEnd(child, text)
    if (Number.isInteger(e) && (last === null || e > last)) last = e
  }
  if (last === null || last >= end) return end
  return /^[>\t \r\n]*$/.test(text.slice(last, end)) ? last : end
}

function outsideSignatureThroughContainers(tree, regionStart, regionEnd, delta, text) {
  const parts = []
  let ok = true
  const walk = (node) => {
    if (!ok) return
    const start = node.position?.start?.offset
    const rawEnd = node.position?.end?.offset
    if (!Number.isInteger(start) || !Number.isInteger(rawEnd)) {
      ok = false
      return
    }
    // Clamped BEFORE both the overlap test and the signature — see
    // clampedNodeEnd's note.
    const end = clampedNodeEnd(node, text)
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

// The bytes standing between the query line's physical start and the query
// block's own start — accepted as a quote prefix only when they are NOTHING
// BUT quote markers (with CommonMark's optional indentation/padding) and the
// marker count equals the parse-verified chain depth. Anything else (a lazy
// line, list indentation) refuses.
function quotePrefixOf(text, start, quoteDepth) {
  let lineStart = start
  while (lineStart > 0 && text[lineStart - 1] !== '\n' && text[lineStart - 1] !== '\r') {
    lineStart -= 1
  }
  const prefix = text.slice(lineStart, start)
  if (!/^(?:[ \t]{0,3}>[ \t]*)+$/.test(prefix)) return null
  if ((prefix.match(/>/g) || []).length !== quoteDepth) return null
  return prefix
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

  const found = quoteChainNodeAt(index.tree, offset)
  if (!found || !SOURCE_TYPES.has(found.node.type)) {
    return { ok: false, code: 'unsupported-structure' }
  }
  const { node, quoteDepth } = found
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

  // `/text` writes no block — its whole edit is a proven suffix deletion, so
  // it branches before the build/spelling machinery. Inside a quote
  // (2026-08-31, the quote-context audit) the honest edit is smaller than
  // the top-level one: deleting the query's content bytes leaves its line
  // as `> ` — a BLANK QUOTE LINE, which is a first-class separator (never a
  // merge risk), and exactly the caret home the staged exit and quote-end
  // /divider already ride (bare-quote virtual pair / vouched placeholder).
  if (target === 'text') {
    if (quoteDepth > 0) return revertQuotedText({ doc, index, start, end })
    return revertToTextFromQuery({ doc, start, end })
  }

  const built = buildBlock(target, info, index.dominantEnding || '\n')
  if (!built) return { ok: false, code: 'unsupported-structure' }
  // Quoted context: only the caret-INSIDE targets. Caret-AFTER targets
  // (/divider, /image) derive their home from the FOLLOWING block via
  // caretAfterInsert, whose root-children walk (and the placeholder homes
  // behind it) this command has not proven under a quote prefix.
  let quotePrefix = ''
  if (quoteDepth > 0) {
    // Caret-AFTER targets used to refuse wholesale here. `/divider` is
    // proven since 2026-08-30 (user: 「引用无法插入分割符」) and `/image`
    // since 2026-08-31 (the quote-context audit): the quoted caret home is
    // the NEXT quoted textblock's content anchor (caretAfterInsert's
    // quote-chain walk), and when no quoted line follows, the home is
    // WRITTEN — the `quoteTail` blank quoted line below, served by the
    // controller's vouched in-quote placeholder.
    const prefix = quotePrefixOf(text, start, quoteDepth)
    if (prefix === null) return { ok: false, code: 'unsupported-structure' }
    quotePrefix = prefix
  }

  // QUOTE-END /divider (2026-08-31, user report: 「引用为啥无法使用分隔符」).
  // When NO quoted content line follows the query block, caretAfterInsert
  // has no next-sibling home and used to refuse by name. The home is now
  // WRITTEN: the divider bytes gain a trailing blank quoted line
  // (`> ---` + ending + `> `), the anchor sits after that prefix, and the
  // controller serves typing there through the same vouched placeholder the
  // staged quote exit's stage 3 uses (`\n> `-prefixed commits, in-quote).
  // The line scan is conservative: a false "has next" just keeps the old
  // refusal; a blank `>` separator run before real content still counts as
  // "has next" (caretAfterInsert walks to that sibling as before).
  let quoteTail = ''
  if (quoteDepth > 0 && built.caretAfter) {
    const startLineIndex = index.lineIndexAt(start)
    let hasQuotedNext = false
    for (let i = startLineIndex + 1; i < index.lines.length; i += 1) {
      const lineText = index.lines[i].text
      if (!/^[ \t]*>/.test(lineText)) break
      if (lineText.replace(/[>\t ]+/g, '') !== '') { hasQuotedNext = true; break }
    }
    if (!hasQuotedNext) quoteTail = (index.dominantEnding || '\n') + quotePrefix
  }

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
  // Quoted regions sit inside blockquote ancestors, so their axis (b) walks
  // THROUGH overlapping containers (see outsideSignatureThroughContainers);
  // top-level regions keep the shared helper, byte-identically.
  const signatureOf = quoteDepth > 0 ? outsideSignatureThroughContainers : outsideSignature
  const before = signatureOf(baselineTree, start, end, 0, text)

  // Every spelling runs the FULL two-axis proof; the first that passes wins
  // (single-spelling targets just have a one-entry list). A spelling that
  // fails an axis is not an error — the next one is tried — but a target
  // whose every spelling fails refuses exactly as before.
  let accepted = null
  for (const rawBytes of built.spellings || [built.bytes]) {
    // The quoted spelling: continuation lines carry the query line's own
    // quote prefix, and the anchor rides the same transform. At top level
    // this is the identity.
    const spelled = quoteDepth > 0
      ? quoteSpelling(rawBytes, index.dominantEnding || '\n', quotePrefix, built.anchor ?? 0)
      : { bytes: rawBytes, anchor: built.anchor ?? 0 }
    const bytes = spelled.bytes + quoteTail
    const candidate = text.slice(0, start) + bytes + text.slice(end)
    const insertedEnd = start + bytes.length

    let candidateTree
    try {
      candidateTree = parseKernelMarkdown(candidate)
    } catch {
      continue
    }

    const delta = bytes.length - (end - start)

    // THE STRUCTURE-IDENTICAL READING.
    // Axis (a): the block at the insertion point is the one we wrote — found
    // through the SAME quote chain the query lived in (root children when
    // quoteDepth is 0), at the same depth — and it ends exactly where our
    // bytes end (nothing after it was absorbed).
    //
    // ONE proven relaxation of that end check (2026-08-23 user report: a
    // quoted /task refused whenever ANY quote line followed): remark extends
    // a QUOTED list's mdast end across the following blank quote lines
    // (measured: '> - [ ] x\n>\n' spans the bare '>' line, while a root
    // list ends at its item — the '>' byte makes the blank line belong to
    // the container's accounting). Those tail bytes carry no content, so
    // "nothing was absorbed" is restated instead of assumed: every
    // POSITIONED DESCENDANT of the inserted node must end at our bytes' end,
    // and every byte of the span tail beyond them must be
    // quote-prefix/whitespace. A lazy continuation (real content absorbed
    // into the item) fails the descendant check; a sibling merged in fails
    // shapeAgrees' own item count.
    const provenSpanEnd = (nodeArg) => {
      const nodeEnd = nodeArg.position?.end?.offset
      if (nodeEnd === insertedEnd) return true
      if (quoteDepth === 0) return false
      // The MIRROR direction (2026-08-31, quote-end /divider): the command
      // itself appended a blank quoted line (`quoteTail`) as the caret's
      // byte home, so the inserted node legitimately ends BEFORE our bytes
      // do. Proven the same way: every byte between the node's end and ours
      // must be quote-prefix/whitespace — and only when the tail was ours.
      if (Number.isInteger(nodeEnd) && nodeEnd < insertedEnd) {
        return quoteTail !== '' && nodeEnd >= insertedEnd - quoteTail.length &&
          /^[>\t \r\n]*$/.test(candidate.slice(nodeEnd, insertedEnd))
      }
      if (!Number.isInteger(nodeEnd) || nodeEnd < insertedEnd) return false
      if (!/^[>\t \r\n]*$/.test(candidate.slice(insertedEnd, nodeEnd))) return false
      let maxDescendantEnd = null
      const walk = (n) => {
        for (const child of n.children || []) {
          const e = child.position?.end?.offset
          if (!Number.isInteger(e)) return false
          if (maxDescendantEnd === null || e > maxDescendantEnd) maxDescendantEnd = e
          if (walk(child) === false) return false
        }
        return true
      }
      if (walk(nodeArg) === false) return false
      return maxDescendantEnd === insertedEnd
    }
    // Axis (b): nothing outside the rewritten region changed meaning.
    const chainHit = quoteChainNodeAt(candidateTree, start)
    const inserted = chainHit &&
      chainHit.quoteDepth === quoteDepth &&
      chainHit.node.position?.start?.offset === start
      ? chainHit.node
      : undefined
    if (inserted && provenSpanEnd(inserted) &&
        shapeAgrees(target, inserted, candidate, info)) {
      const after = signatureOf(candidateTree, start, insertedEnd, delta, candidate)
      if (before !== null && after !== null && before === after) {
        accepted = { bytes, candidate, candidateTree, inserted, anchorOffset: spelled.anchor }
        break
      }
      continue
    }

    // THE PREDICTED-MERGE READING (2026-08-21), for the one target that
    // writes a list item. A blank line makes a CommonMark list LOOSE, it does
    // not END it, so an item written next to an existing list of the SAME
    // marker is absorbed by it — the reading above then finds either a node
    // running past the written bytes or (merging upward) no root child at the
    // insertion offset at all, and both axes fail on a document that is
    // exactly what CommonMark says these bytes mean.
    //
    // `provePredictedListMerge` accepts precisely that diff and nothing
    // wider: the merged list's items must BE the neighbours' items plus ours,
    // in order, each neighbour item's full subtree signature unchanged modulo
    // the edit's shift, the merged span exactly the union, and everything
    // outside the union `outsideSignature`-identical. The item it hands back
    // still has to pass this command's OWN interior check — the same one the
    // standalone reading runs — so nothing about "the item I wrote" is
    // relaxed; only "what may stand around it" is.
    // The merge reading is a ROOT-LEVEL argument (neighbour lists as root
    // children); inside a quote it is not attempted — a quoted /task beside a
    // quoted list refuses rather than guesses.
    if (!spec.merges || quoteDepth > 0) continue
    const merge = provePredictedListMerge({
      baselineText: text,
      baselineTree,
      candidateText: candidate,
      candidateTree,
      start,
      end,
      insertedLength: bytes.length,
      ordered: spec.ordered
    })
    if (!merge) continue
    if (target !== 'task' || !taskItemAgrees(merge.item, candidate)) continue
    accepted = { bytes, candidate, candidateTree, inserted: merge.merged, anchorOffset: spelled.anchor }
    break
  }
  if (!accepted) return { ok: false, code: 'unsupported-structure' }
  const { bytes, candidate, candidateTree, inserted } = accepted

  let anchor
  let quotePlaceholder = false
  if (built.caretAfter) {
    const caret = caretAfterInsert(candidate, candidateTree, inserted)
    if (caret.ok) {
      anchor = caret.anchor
    } else if (caret.code === NO_CARET_HOME && quoteTail) {
      // The written trailing quoted line IS the home: anchor right after its
      // prefix; the controller materializes the vouched placeholder there.
      anchor = start + bytes.length
      quotePlaceholder = true
    } else {
      return { ok: false, code: caret.code }
    }
  } else {
    anchor = start + accepted.anchorOffset
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
    ...(quotePlaceholder ? { quotePlaceholder: true } : {}),
    transaction: {
      baseRevision: doc.revision,
      edits: [{ from: start, to: end, insert: bytes }],
      intent: 'insert-block',
      selection: { anchor, head: anchor },
      ...(seedMarks ? { whitespaceMarks: seedMarks } : {})
    }
  }
}
