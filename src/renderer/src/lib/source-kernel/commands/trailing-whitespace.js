// 块尾空白：CommonMark 会剥掉块末尾的 ASCII 空白，所以那里的字面空格是死字节。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
//
// WHY THIS COMMAND EXISTS
// ----------------------
// CommonMark strips the ASCII whitespace at the END of a paragraph's /
// heading's raw content (and GFM strips a table cell's padding). So the last
// offset of a block is a second position — after `heading-whitespace.js`'s
// first one — where a literal space is written to disk and then never appears
// again. Measured in kernel mode before this command existed:
//
//   paragraph '末段。' + typing 'a', ' ', 'b'  ->  source '末段。ab '
//                                                 view   '末段。ab'
//
// The space is committed at the block's end (dead), the view is repaired back
// to what the bytes say (so the character is gone), and the NEXT character maps
// to the block's content end — i.e. BEFORE the stranded byte. The user typed
// `a b`; the file holds `ab ` and the screen shows `ab`. Because prose is
// composed left to right, the caret is at a block end for essentially every
// inter-word space, so this is not an edge case.
//
// A blanket refusal is the wrong cure for the same reason: it would fire on
// every space in English prose, and it would still lose the character.
//
// WHAT IS WRITTEN. The one whitespace character CommonMark does NOT strip is
// U+00A0 (no-break space) — the stripping rules are ASCII-only. So the space is
// written as a real U+00A0 character, raw in the source, NOT as `&nbsp;`:
//
//   'a '   -> paragraph text 'a '   (survives; a width-1 `char` unit)
//
// This is the user's explicit requirement after seeing the entity spelling in
// source mode («源码模式里，不接受这个写法» / «就是空白，类似于在源码中也是空
// 格，tab 可能是两个»): the source view must show whitespace, not markup. Space
// -> ONE U+00A0, Tab -> TWO, the same proportion `heading-whitespace.js` uses.
//
// THE SELF-HEAL IS THE POINT, not an optimisation. A no-break space is NOT the
// character the user pressed, so leaving it there would put U+00A0 between every
// two words of the document (every space is typed at a block end). Instead, the
// moment the space stops being last it is rewritten to an ordinary ' ' in the
// SAME edit as the character that displaced it:
//
//   type ' '  -> 'a '   (visible, caret-addressable, deletable, on disk)
//   type 'b'  -> 'a b'       (ordinary bytes — one edit, no intermediate state)
//
// so the steady state of an ordinary sentence is exactly what any other editor
// would write, and U+00A0 exists only while the space really is the last thing
// in the block.
//
// THE HEAL IS DELIBERATELY LIMITED TO A RUN OF EXACTLY ONE U+00A0. Two reasons.
// (1) It keeps the rule unambiguous: a run of two could be one Tab or two
// Spaces, and guessing would be exactly the "wrong success" this kernel refuses
// to make. A Tab at a block end therefore stays two U+00A0 (which is what the
// user asked for), and repeated Spaces still resolve correctly, one at a time:
// ' ' -> 'a ', ' ' -> 'a  ', 'b' -> 'a  b'. (2) It minimises the
// blast radius of the one thing this rule cannot distinguish — a U+00A0 the
// USER put at a block end — to a single character, and only when they go on
// typing straight after it.
//
// FAIL-CLOSED. Nothing here is decided by construction. The candidate document
// is REPARSED and the edited block's decoded text must equal the expected string
// exactly, with the document's block structure unchanged and the block's own
// span shifted by exactly the byte delta. This is the "a committed edit must be
// observable in the reparse" invariant stated for this shape: it is what neither
// the projection check (view vs bytes — both had already lost the character) nor
// a mapper's `preserved:true` can establish. It is also what stops the heal from
// firing where the literal space would die again: at an ATX heading's content
// start ('##  ' + '标') the healed candidate decodes WITHOUT the space, the
// proof fails, and the command falls through to the plain append.
import { parseKernelMarkdown } from '../syntax-index.js'

// U+00A0, written as an escape so this table can never be edited by accident
// into an ordinary space (which the parser WOULD strip).
export const NO_BREAK_SPACE = ' '

// The bytes written per typed character.
export const BLOCK_TRAILING_TEXT = Object.freeze({
  ' ': NO_BREAK_SPACE,
  '\t': NO_BREAK_SPACE + NO_BREAK_SPACE
})

const NOT_STRUCTURAL = { ok: false, code: 'not-structural' }
const UNSUPPORTED = { ok: false, code: 'unsupported-structure' }

// Blocks whose trailing ASCII whitespace CommonMark/GFM discards. Deliberately
// an allowlist of the three shapes probed for this task:
//   paragraph / heading — the block's raw content has its final whitespace run
//                         stripped before inline parsing.
//   tableCell           — GFM strips a cell's padding on both sides.
// Everything else keeps its pre-existing behaviour, and the two that matter are
// excluded ON PURPOSE:
//   `code`  — trailing spaces inside a fenced block ARE content and are already
//             byte-preserved; touching them would corrupt real data.
//   `math`  — same, `$$` blocks are verbatim.
const TAIL_STRIPPING_BLOCKS = new Set(['paragraph', 'heading', 'tableCell'])

// Containers the structure walk descends through. Anything not listed here is
// a leaf for signature purposes — including `paragraph`/`heading`/`tableCell`,
// whose inline content is exactly what this edit changes and is proven
// separately (by the decoded-text equality below). `table`/`tableRow` ARE
// descended so a cell edit that changed the table's shape is caught.
const CONTAINERS = new Set([
  'root', 'blockquote', 'list', 'listItem', 'footnoteDefinition', 'table', 'tableRow'
])

const structureSignature = (tree) => {
  const out = []
  const walk = (node) => {
    out.push(node?.type)
    if (!CONTAINERS.has(node?.type)) return
    for (const child of node?.children || []) walk(child)
  }
  walk(tree)
  return out.join(' ')
}

// Decoded text of one block, in document order. `value`-bearing leaves (`text`,
// `inlineCode`) are the only inline nodes carrying characters; atoms
// (image/break/html/math) contribute nothing, which is why the structure
// signature and the span check are part of the proof too.
//
// Exported since 2026-08-19 for commands/content-delete.js, which proves the
// DELETE side of the same observability invariant and needs the identical
// decoder (one decoder, so the two sides can never disagree about what a block
// "says").
export const blockText = (node) => {
  const out = []
  const walk = (n) => {
    if (typeof n?.value === 'string') out.push(n.value)
    for (const child of n?.children || []) walk(child)
  }
  for (const child of node?.children || []) walk(child)
  return out.join('')
}

const isSpaceOrTab = (ch) => ch === ' ' || ch === '\t'

// Would a LITERAL ASCII whitespace byte written at `offset` be stripped again?
//
// Parse-free and exact: walk forward over the whitespace run that starts at
// `offset` and look at what stops it. The run is discarded when it reaches
//   * the block's own end offset — a paragraph's/heading's final whitespace
//     run (mdast's block span INCLUDES those bytes, probed), or
//   * a `|` inside a table cell — GFM cell padding.
// Anything else (a `\n` inside a multi-line paragraph, a heading's closing `#`
// run, real content) stops the run somewhere this predicate does not claim, and
// it answers `false` so the caller keeps the literal byte.
//
// NOTE the deliberate `\n` exclusion: a run ending at a line ending INSIDE a
// paragraph is the two-space HARD BREAK's own syntax. Re-spelling it would
// change what the line ending means, so that shape is never claimed here.
export const literalTailIsStripped = (text, block, offset) => {
  if (typeof text !== 'string' || !Number.isInteger(offset)) return false
  if (!TAIL_STRIPPING_BLOCKS.has(block?.type)) return false
  const end = block?.position?.end?.offset
  if (!Number.isInteger(end) || offset > end) return false
  let index = offset
  while (index < end && isSpaceOrTab(text[index])) index += 1
  if (index >= end) return true
  return block.type === 'tableCell' && text[index] === '|'
}

// Does the block's character map end in a run of EXACTLY ONE U+00A0? Returns
// `{ rawStart, rawEnd }` for that unit, or null. A longer run is deliberately
// not claimed (see the header): two U+00A0 could be one Tab or two Spaces.
export const healableTrailingSpace = (text, charMap) => {
  const units = charMap?.units
  if (!Array.isArray(units) || !units.length) return null
  const last = units[units.length - 1]
  if (last?.kind !== 'char' || last.width !== 1) return null
  if (text.slice(last.rawStart, last.rawEnd) !== NO_BREAK_SPACE) return null
  const previous = units[units.length - 2]
  if (previous && previous.kind === 'char' &&
      text.slice(previous.rawStart, previous.rawEnd) === NO_BREAK_SPACE) return null
  return { rawStart: last.rawStart, rawEnd: last.rawEnd }
}

// Is `after` reachable from `before` by replacing exactly ONE contiguous run
// with `insert`? Written as a forward/backward match rather than a diff so it
// states precisely that: a common prefix, then the inserted bytes verbatim,
// then a common suffix. With `insert === ''` (the pure-delete case) it reduces
// to "one contiguous run removed, nothing else touched" — which is what the
// delete side proves in place of an exact expected string (see
// `blockEditIsObservable`'s `expectedText` note and commands/content-delete.js).
export const isOneContiguousReplacement = (before, after, insert) => {
  if (typeof before !== 'string' || typeof after !== 'string' ||
      typeof insert !== 'string') return false
  let head = 0
  const shared = Math.min(before.length, after.length)
  while (head < shared && before[head] === after[head]) head += 1
  if (!after.startsWith(insert, head)) return false
  const tail = after.slice(head + insert.length)
  if (!before.endsWith(tail)) return false
  // The prefix and the suffix must not overlap inside `before`, or the same
  // bytes would be counted twice and a real change could hide between them.
  return before.length - tail.length >= head
}

// The observability proof. Given a candidate document, the baseline block and
// the text that block must decode to, prove that the candidate really says so:
//   1. the document's block structure is unchanged;
//   2. a block of the same type still starts at the same offset;
//   3. its span grew by exactly the byte delta;
//   4. its decoded text is EXACTLY the expected string;
//   5. any EXTRA per-shape fact the caller needs (`matches`).
// (4) is the one the projection check cannot make: view-vs-bytes agreement is
// preserved when a character is lost on BOTH sides.
//
// `decode` and `matches` are optional and default to this module's own
// behaviour, so nothing about the trailing-whitespace proof changes. They exist
// because commands/empty-code-insert.js proves the SAME five facts about a
// value-bearing LEAF block (a fenced `code` node, whose characters live in
// `.value` rather than in inline children, and whose info string is a second
// thing that must survive) — one shared proof rather than a second copy that
// can drift away from this one.
//
// `delta` IS SIGNED (2026-08-19). Nothing here ever assumed a growing span —
// (3) is the arithmetic identity `end + delta`, which reads a shrinking block
// exactly as well — but until commands/content-delete.js there was no caller on
// the negative side, so say it out loud: this is the ONE observability proof for
// edits of either sign. Deletes must not fork a second copy of it.
//
// `expectedText` MAY BE OMITTED, and only then (2026-08-19). The delete side
// cannot state an exact expected string: what ProseMirror holds after its own
// deletion and what mdast decodes from the candidate bytes are different
// alphabets for the same block (an inline image/hardbreak is a PM character but
// contributes NOTHING to `blockText`; an inline `html`/`inlineMath` node is the
// reverse), so an "expected" built from either side would refuse correct
// documents. It supplies a `matches` predicate that proves the decoded text
// changed by exactly ONE contiguous replacement instead. Omitting BOTH is
// refused — a proof with no statement about content is not a proof.
export function blockEditIsObservable({
  baselineTree, block, candidate, expectedText, delta, decode = blockText, matches = null
}) {
  if (expectedText === undefined && !matches) return false
  let candidateTree
  try {
    candidateTree = parseKernelMarkdown(candidate)
  } catch {
    return false
  }
  if (structureSignature(baselineTree) !== structureSignature(candidateTree)) return false
  const start = block?.position?.start?.offset
  const end = block?.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false
  let found = null
  const walk = (node) => {
    if (found) return
    if (node?.type === block.type && node.position?.start?.offset === start) {
      found = node
      return
    }
    for (const child of node?.children || []) walk(child)
  }
  walk(candidateTree)
  if (!found) return false
  if (found.position?.end?.offset !== end + delta) return false
  if (matches && !matches(found)) return false
  if (expectedText === undefined) return true
  return decode(found) === expectedText
}

// Spell ONE character appended at a block's visible end so that it survives the
// reparse — and, in the same edit, heal the single no-break space this module
// wrote for the PREVIOUS character back to an ordinary space now that it is no
// longer last.
//
// Inputs (all from state the caller already holds — this command performs ONE
// parse of the baseline and at most two of a candidate, and only when its
// caller's parse-free prefilter already said the shape is at risk):
//   doc     the kernel document (`text` + `revision`)
//   block   the mdast node the projection map already paired with this
//           textblock (`pair.mdBlock`) — its span is the baseline
//   offset  the raw insert offset (the caller proved it is the block's visible
//           end)
//   insert  the text being appended, no line breaks. The RE-SPELLING half only
//           ever claims a single space/tab (`BLOCK_TRAILING_TEXT` has no other
//           keys, so a longer string never matches); the HEAL half deliberately
//           accepts any length — see below.
//   heal    `healableTrailingSpace(...)` for this block, or null
//
// THE HEAL ACCEPTS MULTI-CHARACTER INSERTS SINCE 2026-08-19 (audit finding).
// It used to refuse anything but one code point, which meant the heal fired
// from exactly one caller on exactly one shape — a single ASCII keystroke — and
// an IME COMMIT never reached it at all (a whole composition is one multi-char
// replace, committed through its own path). Measured in the built app: typing
// 'HorseMD', Space, then committing the IME word '是一个编辑器' left
// 'HorseMD<U+00A0>是一个编辑器' on disk, and a normally-typed six-line document
// saved with four stray U+00A0. For a user who writes Chinese, IME IS the
// normal input path, so the heal effectively never ran. Nothing about the proof
// changes: the candidate is still reparsed and the block must still decode to
// exactly `baselineText` minus the U+00A0 plus ' ' plus the inserted text — an
// insert that does not decode to itself (an unescaped '*', say) simply fails
// that check and the heal is skipped, which is the pre-existing fall-through.
//
// Refusals:
//   `not-structural`        — this shape is not claimed (or the heal could not
//                             be proven and there was nothing else to do); the
//                             caller keeps the literal byte and NOTHING about
//                             that shape changes.
//   `unsupported-structure` — the literal byte is known-dead here AND no
//                             surviving spelling could be proven. The caller
//                             must refuse rather than write a byte we have just
//                             proven nobody will ever see again.
export function spellBlockTailInsert({ doc, block, offset, insert, heal = null }) {
  const text = doc?.text
  if (typeof text !== 'string' || !Number.isInteger(doc?.revision)) return NOT_STRUCTURAL
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return NOT_STRUCTURAL
  if (typeof insert !== 'string' || !insert || /[\r\n]/.test(insert)) return NOT_STRUCTURAL
  // A multi-character insert is admitted for the HEAL only (see the header):
  // `BLOCK_TRAILING_TEXT` is keyed by ' ' and '\t' alone, so `written` below
  // stays undefined for anything longer and the re-spelling half is unreachable
  // for it — exactly as before.
  if (!insert) return NOT_STRUCTURAL
  if (!TAIL_STRIPPING_BLOCKS.has(block?.type)) return NOT_STRUCTURAL
  const blockStart = block?.position?.start?.offset
  const blockEnd = block?.position?.end?.offset
  if (!Number.isInteger(blockStart) || !Number.isInteger(blockEnd)) return NOT_STRUCTURAL
  if (offset < blockStart || offset > blockEnd) return NOT_STRUCTURAL

  // Both decisions are re-derived from the bytes rather than trusted from the
  // caller's prefilter: together they decide whether the user's own source gets
  // rewritten, and `literalTailIsStripped` in particular is the one that says a
  // literal byte is known-dead.
  const written = BLOCK_TRAILING_TEXT[insert]
  const needsSpelling = !!written && literalTailIsStripped(text, block, offset)
  const healSpan = heal && heal.rawEnd === offset &&
    text.slice(heal.rawStart, heal.rawEnd) === NO_BREAK_SPACE
    ? heal
    : null
  if (!needsSpelling && !healSpan) return NOT_STRUCTURAL

  let baselineTree
  try {
    baselineTree = parseKernelMarkdown(text)
  } catch {
    return UNSUPPORTED
  }
  // The baseline block is re-read from THIS parse (the caller's `block` may come
  // from a map bound to the same bytes, but the proof must not depend on that):
  // same type, same start offset, same end offset.
  let baseline = null
  const walk = (node) => {
    if (baseline) return
    if (node?.type === block.type && node.position?.start?.offset === blockStart &&
        node.position?.end?.offset === blockEnd) {
      baseline = node
      return
    }
    for (const child of node?.children || []) walk(child)
  }
  walk(baselineTree)
  if (!baseline) return NOT_STRUCTURAL

  const baselineText = blockText(baseline)
  const suffix = needsSpelling ? written : insert

  // Attempt 1: heal + append. Attempt 2 (only when the append itself needs a
  // spelling): append alone, so a heal that cannot be proven never costs the
  // user the character they just typed.
  const attempts = []
  if (healSpan) {
    if (!baselineText.endsWith(NO_BREAK_SPACE)) return NOT_STRUCTURAL
    attempts.push({
      from: healSpan.rawStart,
      to: healSpan.rawEnd,
      write: ' ' + suffix,
      expected: baselineText.slice(0, -1) + ' ' + suffix
    })
  }
  if (needsSpelling) {
    attempts.push({ from: offset, to: offset, write: written, expected: baselineText + written })
  }

  for (const attempt of attempts) {
    const candidate = text.slice(0, attempt.from) + attempt.write + text.slice(attempt.to)
    const delta = attempt.write.length - (attempt.to - attempt.from)
    if (!blockEditIsObservable({
      baselineTree, block: baseline, candidate, expectedText: attempt.expected, delta
    })) continue
    const caret = attempt.from + attempt.write.length
    return {
      ok: true,
      spelling: needsSpelling ? 'no-break-space' : 'literal',
      healed: attempt.to > attempt.from,
      edit: { from: attempt.from, to: attempt.to, insert: attempt.write },
      transaction: {
        baseRevision: doc.revision,
        from: attempt.from,
        to: attempt.to,
        insert: attempt.write,
        intent: 'block-trailing-whitespace',
        selection: { anchor: caret, head: caret }
      }
    }
  }

  // A byte we have proven is stripped, with no spelling that survives: refuse
  // loudly. A heal that simply could not be proven is not an error — the plain
  // append is still correct, so fall through.
  return needsSpelling ? UNSUPPORTED : NOT_STRUCTURAL
}

// THE DELETE SIDE OF THE SAME RULE (2026-08-19, audit finding)
// ===========================================================================
// Everything above is an INSERT-path design, and a delete can put a literal
// ASCII space at a block end just as easily — at which point the original
// defect is back, byte for byte, plus a second one on the next keystroke.
// Measured in the built app, one keystroke at a time (<NBSP> = U+00A0):
//
//   type 'ab', Space   source 'ab<NBSP>'   view 'ab '
//   type 'c'           source 'ab c'       view 'ab c'   (the heal, correct)
//   ONE Backspace      source 'ab '        view 'ab'     <- bytes != view
//   type 'd'           source 'abd '       view 'abd'
//
// The user typed `a b Space c Backspace d` and expects `ab d`; the file holds
// `abd` plus a space nobody can ever see again, because the stranded byte is at
// the block end and the next insert maps IN FRONT of it. Three
// `projection-mismatch` diagnostics fire and nothing refuses. "Type a word,
// backspace it, retype" is one of the most common sequences in an editor.
//
// The cure is the same one the insert side uses and nothing new: the space that
// the delete has just stranded is re-spelled U+00A0 IN THE SAME EDIT, proven by
// the same reparse, so the bytes still say what ProseMirror shows and the
// existing single-U+00A0 heal restores an ordinary space the moment a character
// displaces it again.
//
// DELIBERATELY NARROW: exactly ONE stranded ASCII space is claimed.
//   * A longer run, or a tab, is REFUSED rather than guessed at. Two U+00A0
//     could be one Tab or two Spaces — the same ambiguity the heal refuses to
//     resolve at the top of this file — and a delete is not the place to invent
//     a convention. A refused Backspace is recoverable.
//   * `insert` must be empty: a REPLACEMENT ending in whitespace is a different
//     shape (the written bytes are not the ones already on disk) and is left to
//     its pre-existing behaviour rather than half-claimed here.
// Both refusals are stated at the caller as `unsupported-structure`, never as a
// silent literal write.
export function spellBlockTailDelete({ doc, block, charMap, from, to, insert = '' }) {
  const text = doc?.text
  if (typeof text !== 'string' || !Number.isInteger(doc?.revision)) return NOT_STRUCTURAL
  if (insert !== '') return NOT_STRUCTURAL
  if (!Number.isInteger(from) || !Number.isInteger(to) || from >= to) return NOT_STRUCTURAL
  if (from < 0 || to > text.length) return NOT_STRUCTURAL
  if (!TAIL_STRIPPING_BLOCKS.has(block?.type)) return NOT_STRUCTURAL
  const blockStart = block?.position?.start?.offset
  const blockEnd = block?.position?.end?.offset
  if (!Number.isInteger(blockStart) || !Number.isInteger(blockEnd)) return NOT_STRUCTURAL
  if (from < blockStart || to > blockEnd) return NOT_STRUCTURAL

  // EVERY CHEAP CHECK FIRST — this runs on every Backspace, so no string is
  // built and no parse is spent until the shape is already established.
  //
  // `newEnd` is where the block will end after the literal delete; the byte
  // before it is the one at risk. Its position in the ORIGINAL text depends on
  // which side of the removed range it sits (before it: unmoved; after it:
  // shifted by the removed width).
  const removed = to - from
  const delta = -removed
  const newEnd = blockEnd + delta
  if (newEnd - 1 < blockStart) return NOT_STRUCTURAL
  const originalOffset = (at) => (at < from ? at : at + removed)
  const spaceAt = originalOffset(newEnd - 1)
  if (!isSpaceOrTab(text[spaceAt])) return NOT_STRUCTURAL

  // THE BYTE MUST HAVE BEEN CONTENT BEFORE THIS DELETE. The character map is
  // the kernel's proven statement about which raw bytes carry content, and
  // consulting it is what separates "a space the user typed, which this delete
  // has just stranded" from "a byte that was always syntax". Without it a GFM
  // TABLE CELL reads as a false positive on every cell-emptying delete: mdast
  // gives `tableCell` a span that INCLUDES its own '| ' / ' ' padding, so
  // `literalTailIsStripped` is true for that padding both before and after the
  // edit — nothing was stranded, the cell simply became empty, and claiming it
  // would have refused the ordinary "clear this cell" operation.
  const coveringUnit = (offset) => (charMap?.units || []).find(
    (unit) => Number.isInteger(unit?.rawStart) && unit.rawStart <= offset && offset < unit.rawEnd
  ) || null
  const strandedUnit = coveringUnit(spaceAt)
  if (!strandedUnit || strandedUnit.kind !== 'char' ||
      strandedUnit.rawStart !== spaceAt || strandedUnit.rawEnd !== spaceAt + 1) {
    return NOT_STRUCTURAL
  }

  // Only now is a candidate string built. `literalTailIsStripped` reads only
  // `type` and `position.end.offset`, so this stand-in block is exactly as good
  // as a real node for the one question asked of it: does CommonMark really
  // discard the byte at `newEnd - 1`? If it does not (a table cell with a
  // following '|' that is not padding, a shape this predicate does not claim),
  // the literal delete is already correct and nothing here applies.
  const candidate = text.slice(0, from) + text.slice(to)
  const candidateBlock = {
    type: block.type,
    position: { start: { offset: blockStart }, end: { offset: newEnd } }
  }
  if (!literalTailIsStripped(candidate, candidateBlock, newEnd - 1)) return NOT_STRUCTURAL

  // FROM HERE ON THE BYTE IS PROVEN DEAD, so there is no "leave it alone" exit
  // left: either a surviving spelling is proven, or the delete is refused.
  // Exactly ONE ASCII space is claimed. A tab, or a run of two or more, is the
  // ambiguity the heal at the top of this file deliberately refuses to resolve
  // (two U+00A0 could be one Tab or two Spaces), and a delete is not the place
  // to invent that convention — so those refuse rather than strand a byte
  // nobody will ever see again.
  if (text[spaceAt] !== ' ') return UNSUPPORTED
  const beforeAt = originalOffset(newEnd - 2)
  if (newEnd - 2 >= blockStart && isSpaceOrTab(text[beforeAt]) && coveringUnit(beforeAt)) {
    return UNSUPPORTED
  }

  let baselineTree
  try {
    baselineTree = parseKernelMarkdown(text)
  } catch {
    return UNSUPPORTED
  }
  let baseline = null
  const walk = (node) => {
    if (baseline) return
    if (node?.type === block.type && node.position?.start?.offset === blockStart &&
        node.position?.end?.offset === blockEnd) {
      baseline = node
      return
    }
    for (const child of node?.children || []) walk(child)
  }
  walk(baselineTree)
  // A block this parse cannot re-find is not a reason to fall back to the
  // literal write: the byte is already proven dead above, so this is a refusal
  // like any other on this side of the guard.
  if (!baseline) return UNSUPPORTED

  const baselineText = blockText(baseline)
  // THE WRITTEN BYTES: the literal delete, with the now-last ASCII space
  // rewritten as U+00A0 — expressed as ONE edit range covering both changes, so
  // history sees a single step exactly like the insert side's heal does.
  const final = candidate.slice(0, newEnd - 1) + NO_BREAK_SPACE + candidate.slice(newEnd)
  const editFrom = Math.min(from, spaceAt)
  const editTo = Math.max(to, spaceAt + 1)
  const written = final.slice(editFrom, editTo + delta)
  const respelled = text.slice(0, editFrom) + written + text.slice(editTo)
  const proven = blockEditIsObservable({
    baselineTree,
    block: baseline,
    candidate: respelled,
    delta: written.length - (editTo - editFrom),
    // The stranded space must SURVIVE, as U+00A0, and nothing else may have
    // moved: reading the trailing U+00A0 back as an ordinary space must leave a
    // string reachable from the baseline by removing exactly one contiguous run
    // — the same statement commands/content-delete.js proves, from the same
    // helper, so the two delete guards cannot drift apart.
    matches: (found) => {
      const decoded = blockText(found)
      if (!decoded.endsWith(NO_BREAK_SPACE)) return false
      return isOneContiguousReplacement(baselineText, decoded.slice(0, -1) + ' ', '')
    }
  })
  if (!proven) return UNSUPPORTED
  const caret = editFrom + written.length
  return {
    ok: true,
    edit: { from: editFrom, to: editTo, insert: written },
    transaction: {
      baseRevision: doc.revision,
      from: editFrom,
      to: editTo,
      insert: written,
      intent: 'block-trailing-whitespace-delete',
      selection: { anchor: caret, head: caret }
    }
  }
}
