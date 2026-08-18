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
const blockText = (node) => {
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
export function blockEditIsObservable({
  baselineTree, block, candidate, expectedText, delta, decode = blockText, matches = null
}) {
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
//   insert  exactly one code point, no line breaks
//   heal    `healableTrailingSpace(...)` for this block, or null
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
  if ([...insert].length !== 1) return NOT_STRUCTURAL
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
