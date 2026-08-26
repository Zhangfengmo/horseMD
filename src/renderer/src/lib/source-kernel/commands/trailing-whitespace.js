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
// WHAT THE HEAL CLAIMS: THE RECORDED RUN, AND ONLY IT (2026-08-19).
// Both halves of that sentence were open audit findings, and they have the same
// answer — the document's whitespace provenance ledger (markdown-document.js):
//
//  * WHICH characters. The heal used to claim any single trailing U+00A0,
//    including one the DOCUMENT already had, so a file written elsewhere with
//    U+00A0 for CJK spacing lost one the moment its paragraph was touched. Only
//    a run THIS kernel wrote is claimed now; an authored one is never rewritten.
//  * HOW MANY. The heal used to claim a run of exactly ONE, because a bare run
//    of two is ambiguous — one Tab or two Spaces. So a Tab's two U+00A0 were
//    never healed, and every further whitespace keystroke appended another run
//    to them without bound ('a' + Tab + Tab + Tab left six U+00A0, none of them
//    ever resolving to the keys that were pressed). The ledger records WHICH key
//    each run stands for, so that ambiguity is gone: the whole recorded run
//    heals back to exactly that key, and the accumulation ends because each new
//    whitespace keystroke resolves the previous run to real ASCII first —
//        'a' + Tab  ->  'a' + <2 NBSP>       (the ledger says: that run is a Tab)
//            + Tab  ->  'a\t' + <2 NBSP>     (bounded — two, never four)
//            + 'z'  ->  'a\t\tz'              (exactly what was pressed)
//    Repeated Spaces resolve the same way, one at a time:
//    ' ' -> 'a<NBSP>', ' ' -> 'a <NBSP>', 'b' -> 'a  b'.
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

// The ASCII whitespace run an insert ENDS with — the part of it that lands at
// the block's end and is therefore the part CommonMark discards.
const TRAILING_RUN_RE = /[ \t]*$/
const NO_BREAK_RUN_RE = /^\u00A0+$/
const ASCII_WHITESPACE_RE = /^[ \t]+$/

// That run, re-spelled character by character through the table above. A run of
// one is the single-keystroke case this module was built for; a longer one is
// what a PASTE or an IME commit ending in whitespace produces (2026-08-19 audit
// item 2: `hello ` pasted at a paragraph end wrote a literal trailing space,
// which CommonMark strips — the original dead byte, arriving by a route the
// single-character table could not see). Returns null if any character has no
// spelling, so the caller falls through rather than writing half a run.
export const spellTrailingRun = (run) => {
  if (typeof run !== 'string') return null
  let out = ''
  for (const ch of run) {
    const written = BLOCK_TRAILING_TEXT[ch]
    if (!written) return null
    out += written
  }
  return out
}

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
  if (block.type === 'tableCell' && text[index] === '|') return true
  return block.type === 'heading' && headingTailIsStripped(text, end, index)
}

// The two heading shapes whose VISIBLE end is not the block's end (2026-08-19,
// audit I3′). Both were unclaimed above, so a space typed there was written as a
// literal byte that CommonMark discards — a dead byte, and `edit-unobservable`
// did not even fire for it.
//
//   ATX with a CLOSING SEQUENCE: '## x ##'. The optional closing run of '#' may
//     be preceded by any amount of whitespace, so '## x  ##' still says 'x'.
//     Claimed when the run is followed by '#'s and then nothing but whitespace
//     to the block's end — '## x ###foo' is NOT a closing sequence and is not
//     claimed, so the byte there stays literal (and is real content).
//
//   SETEXT: 'text' LF '----'. The heading's span runs THROUGH its underline, so
//     the whitespace run at the end of the content stops at a line ending rather
//     than at the block end. Claimed only when everything after that line ending
//     is exactly the underline — which is also what keeps a MULTI-LINE setext
//     heading's interior line endings out of it (a run stopping there could be
//     the two-space hard break's own syntax, the shape this predicate has always
//     refused to claim).
const SETEXT_UNDERLINE_RE = /^ {0,3}(?:=+|-+)[ \t]*$/
const headingTailIsStripped = (text, end, index) => {
  const ch = text[index]
  if (ch === '#') {
    let at = index
    while (at < end && text[at] === '#') at += 1
    while (at < end && isSpaceOrTab(text[at])) at += 1
    return at >= end
  }
  if (ch !== '\n' && ch !== '\r') return false
  let at = index
  at += text[at] === '\r' && text[at + 1] === '\n' ? 2 : 1
  return SETEXT_UNDERLINE_RE.test(text.slice(at, end))
}

// Does the block END in a U+00A0 THIS KERNEL WROTE? Returns
// `{ rawStart, rawEnd, ascii }` — the span and the ASCII whitespace it stands
// for — or null.
//
// PROVENANCE IS THE GATE (2026-08-19, audit I4′). Before this, the heal claimed
// ANY single trailing U+00A0, so a file authored elsewhere that uses U+00A0 for
// CJK spacing lost one the first time that paragraph was touched: the kernel
// rewriting a character it never wrote, which is the failure it exists to
// prevent. `marks` is the document's session-scoped ledger
// (markdown-document.js): only a run this kernel itself wrote — and that the
// ledger still vouches for byte-for-byte — is claimed, and the recorded ASCII is
// what the heal restores, so nothing is guessed about which key was pressed.
// A document with no ledger (a file just opened, a hand-built test map) claims
// NOTHING; that is the fail-closed direction, and it is why the argument has no
// permissive default.
//
// THE WHOLE RECORDED RUN IS CLAIMED, not one character (2026-08-19, audit I5′).
// A Tab writes TWO U+00A0, and while the heal was length-limited to one, that
// run was never healed and every further whitespace keystroke appended another
// run to it without bound ('a' + Tab + Tab + Tab -> six U+00A0, none of them
// ever resolving to the keys that were pressed). The length limit existed only
// because a bare run of two is ambiguous — one Tab or two Spaces — and the
// ledger is exactly the answer to that: it records WHICH, so the heal restores
// what was pressed instead of guessing. A run that is not recorded, or whose
// span does not line up with whole character-map units, is still claimed by
// nothing.
export const healableTrailingSpace = (text, charMap, marks = null) => {
  const units = charMap?.units
  if (!Array.isArray(units) || !units.length) return null
  const last = units[units.length - 1]
  if (last?.kind !== 'char' || last.width !== 1) return null
  if (text.slice(last.rawStart, last.rawEnd) !== NO_BREAK_SPACE) return null
  const mark = (marks || []).find((entry) => entry?.to === last.rawEnd)
  if (!mark || !Number.isInteger(mark.from) || mark.from >= mark.to) return null
  if (!NO_BREAK_RUN_RE.test(text.slice(mark.from, mark.to))) return null
  if (typeof mark.ascii !== 'string' || !ASCII_WHITESPACE_RE.test(mark.ascii)) return null
  // The recorded span must be exactly a run of whole, width-1 `char` units, so
  // the heal replaces addressable characters and nothing else — a run that only
  // partly covers a unit (or reaches past the block's own content) is refused.
  let index = units.length - 1
  let start = last.rawStart
  while (start > mark.from) {
    const previous = units[index - 1]
    if (previous?.kind !== 'char' || previous.width !== 1) return null
    if (previous.rawEnd !== start) return null
    start = previous.rawStart
    index -= 1
  }
  if (start !== mark.from) return null
  return { rawStart: mark.from, rawEnd: mark.to, ascii: mark.ascii }
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
//   insert  the text being appended, no line breaks. The RE-SPELLING half
//           claims exactly the insert's own TRAILING whitespace run (2026-08-19)
//           — for a single typed Space/Tab that is the whole insert and the
//           bytes are unchanged; for a paste or an IME commit ending in
//           whitespace it is the part that lands at the block's end. The HEAL
//           half accepts any length — see below.
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
  if (!TAIL_STRIPPING_BLOCKS.has(block?.type)) return NOT_STRUCTURAL
  const blockStart = block?.position?.start?.offset
  const blockEnd = block?.position?.end?.offset
  if (!Number.isInteger(blockStart) || !Number.isInteger(blockEnd)) return NOT_STRUCTURAL
  if (offset < blockStart || offset > blockEnd) return NOT_STRUCTURAL

  // Both decisions are re-derived from the bytes rather than trusted from the
  // caller's prefilter: together they decide whether the user's own source gets
  // rewritten, and `literalTailIsStripped` in particular is the one that says a
  // literal byte is known-dead.
  //
  // ONLY THE INSERT'S OWN TRAILING WHITESPACE RUN IS RE-SPELLED (2026-08-19).
  // Everything before it lands inside the block and is byte-exact as it always
  // was; the run is the part that ends up at the block's end, which is the one
  // position CommonMark discards. For a single typed Space/Tab this is the whole
  // insert and the bytes are identical to what this command has always written.
  const trailingRun = TRAILING_RUN_RE.exec(insert)[0]
  const spelledRun = trailingRun ? spellTrailingRun(trailingRun) : ''
  const written = trailingRun && spelledRun !== null
    ? insert.slice(0, insert.length - trailingRun.length) + spelledRun
    : null
  const needsSpelling = !!written && literalTailIsStripped(text, block, offset)
  // The caller's heal span is re-proven against the bytes AND against its own
  // recorded spelling — a span that is not a pure U+00A0 run, or that claims to
  // stand for something other than ASCII whitespace, is not healed — AND
  // against the PROVENANCE LEDGER itself (2026-08-20 adversarial panel,
  // Minor): the byte check cannot tell a run this kernel wrote from one the
  // AUTHOR wrote, so a forged descriptor over a byte-valid U+00A0 run used to
  // heal away a character the kernel never wrote. The command is the
  // byte-writing gate, so it demands the entry from `doc.whitespaceMarks`
  // byte-for-byte, recorded ascii included, rather than trusting the caller
  // to have derived `heal` from `healableTrailingSpace`.
  const healSpan = heal && heal.rawEnd === offset &&
    Number.isInteger(heal.rawStart) && heal.rawStart < heal.rawEnd &&
    NO_BREAK_RUN_RE.test(text.slice(heal.rawStart, heal.rawEnd)) &&
    typeof heal.ascii === 'string' && ASCII_WHITESPACE_RE.test(heal.ascii) &&
    (doc.whitespaceMarks || []).some((entry) =>
      entry?.from === heal.rawStart && entry.to === heal.rawEnd && entry.ascii === heal.ascii)
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
    if (!NO_BREAK_RUN_RE.test(baselineText.slice(-(heal.rawEnd - heal.rawStart)))) return NOT_STRUCTURAL
    // THE RECORDED ASCII, not a hardcoded space: the ledger says which key was
    // pressed, so a Tab-written run restores a Tab rather than the kernel
    // guessing between "one Tab" and "two Spaces".
    const healed = healSpan.ascii
    const runLength = healSpan.rawEnd - healSpan.rawStart
    attempts.push({
      from: healSpan.rawStart,
      to: healSpan.rawEnd,
      write: healed + suffix,
      expected: baselineText.slice(0, -runLength) + healed + suffix,
      healedUnits: runLength
    })
  }
  if (needsSpelling) {
    attempts.push({
      from: offset, to: offset, write: written, expected: baselineText + written, healedUnits: 0
    })
  }

  for (const attempt of attempts) {
    const candidate = text.slice(0, attempt.from) + attempt.write + text.slice(attempt.to)
    const delta = attempt.write.length - (attempt.to - attempt.from)
    if (!blockEditIsObservable({
      baselineTree, block: baseline, candidate, expectedText: attempt.expected, delta
    })) continue
    const caret = attempt.from + attempt.write.length
    // What this edit writes as U+00A0, in POST-edit coordinates, so the ledger
    // can vouch for it on the NEXT keystroke. Only the re-spelled tail run is
    // recorded; a heal that restores ASCII records nothing (and the entry it
    // replaced is dropped by the remap, because the edit covers it).
    const marks = needsSpelling
      ? [{
          from: attempt.from + attempt.write.length - spelledRun.length,
          to: attempt.from + attempt.write.length,
          ascii: trailingRun
        }]
      : []
    return {
      ok: true,
      spelling: needsSpelling ? 'no-break-space' : 'literal',
      healed: attempt.to > attempt.from,
      healedUnits: attempt.healedUnits,
      edit: { from: attempt.from, to: attempt.to, insert: attempt.write },
      whitespaceMarks: marks,
      transaction: {
        baseRevision: doc.revision,
        from: attempt.from,
        to: attempt.to,
        insert: attempt.write,
        intent: 'block-trailing-whitespace',
        selection: { anchor: caret, head: caret },
        whitespaceMarks: marks
      }
    }
  }

  // A byte we have proven is stripped, with no spelling that survives: refuse
  // loudly. A heal that simply could not be proven is not an error — the plain
  // append is still correct, so fall through.
  return needsSpelling ? UNSUPPORTED : NOT_STRUCTURAL
}

// THE ENDPOINT OF THE PLACEHOLDER: WHAT IS PUBLISHED (2026-08-26, D5)
// ===========================================================================
// Everything above is a TYPING design. Its correctness argument is the heal:
// «U+00A0 exists only while the space really is the last thing in the block».
// That argument has an endpoint it never covered — the keystroke that is
// GENUINELY last. Measured on the built app, real keydowns, kernel mode
// (scripts/test-kernel-whitespace-disk-probe.mjs):
//
//   paragraph end + Space -> save -> disk '# 标题甲\n\n末段。<U+00A0>\n'
//   paragraph end + Tab   -> save -> disk '末段。<U+00A0><U+00A0>\n'
//   Tab x3                -> save -> disk '末段。\t\t<U+00A0><U+00A0>\n'
//
// The save SUCCEEDS — no dialog, no toast, the document round-trips. The file
// simply holds characters the user never typed, the ledger does not persist,
// and on the next open they are AUTHORED content this kernel will preserve
// forever. That is the one outcome the whole placeholder design exists to
// avoid, arriving through the one door it never guarded.
//
// WHAT A TRAILING SPACE SHOULD BECOME ON DISK. Three candidates, and the
// ledger plus a reparse decide between them rather than taste:
//   * KEEP U+00A0 — a character the user did not type, permanently, that
//     renders as nothing at the end of a line in every reader. Rejected: it is
//     the measured defect.
//   * WRITE THE LITERAL ' ' / '\t' — the byte CommonMark deletes. The reparse
//     says so out loud, which is why `literalTailIsStripped` refuses to write
//     it in the first place; publishing it would only move the dead byte from
//     the editor to the file (and a two-space run before a line ending is a
//     HARD BREAK, a meaning nobody asked for). Rejected.
//   * DROP IT — publish no bytes at all. This is what the keystroke MEANS:
//     CommonMark deletes that whitespace, so the faithful spelling of «Space
//     at a block end» is the empty string. Nothing semantic is lost, the file
//     is clean, and the next open sees exactly the document the author wrote.
// The third one is what this function does, and each drop is PROVEN (below).
//
// A LINE START IS A DIFFERENT ANSWER, and deliberately so. There the U+00A0 is
// not a placeholder waiting for a heal: it is DURABLE, VISIBLE indentation —
// it survives the round-trip, it renders as leading space in every reader, and
// it is the only spelling markdown has for what the user asked for (the reason
// commands/line-start-whitespace.js exists at all: «tab 在行开头输入容易触发
// 内核不支持此操作»). Dropping it would silently discard the indentation on
// save. So only a run at a block's END is ever claimed; a run with content
// after it is kept, and for a leading TAB the proof below refuses it anyway
// (the literal '\t' turns the paragraph into an indented code block, so the
// drop and the literal do not say the same thing).
//
// THE PROOF — three documents, no construction-by-argument:
//   O  the document as it stands (the run present)
//   L  the LITERAL spelling: the run replaced by the ASCII the ledger records
//      — i.e. the bytes the user's keystrokes would have written directly
//   D  the DROPPED candidate: those bytes removed
// A drop is accepted only when
//   (1) tree(D) is IDENTICAL to tree(L) — publishing nothing says exactly what
//       the keystroke says. This is what refuses a leading Tab (L is an
//       indented code block), and what would refuse any position where the
//       ASCII actually means something.
//   (2) tree(D) differs from tree(O) in NOTHING but ONE text value, and there
//       only by one contiguous run of whitespace being removed. Same node
//       count, same types, same attributes. This is what refuses a drop that
//       would delete a block (an NBSP-only spacer paragraph) or change one
//       (`- [ ] <NBSP>` -> `- [ ]`, which demotes the checkbox to a
//       literal-bracket bullet on reload).
// (1) alone is not enough — L and D can agree with each other while both
// disagree with O, which is exactly the task-item case. Both are required.
//
// ONLY LEDGERED RUNS. A U+00A0 the author typed, or one that came in from the
// file, is not in `doc.whitespaceMarks` and is never looked at. The task SEED
// (`ascii: ''`, commands/task-seed.js) stands for no keystroke at all — it has
// no literal spelling to compare against and may only ever be dissolved by the
// first label character — so it is excluded by requiring real ASCII whitespace.
//
// THE DOCUMENT IS NOT TOUCHED. This is a pure function of `doc`: it returns the
// bytes to PUBLISH and leaves `kernel.doc.text`, the ledger, the projection and
// the caret exactly where they are. That is not a shortcut, it is the point —
// the space the user typed is still in the editor, still visible, still
// deletable, and the heal still owns it, so typing on after a save produces
// `a b` and not `ab`. (An earlier draft rewrote the document at the flush; it
// makes «type 'hello', Space, Cmd+S, type 'world'» produce 'helloworld'.)
// Which readers publish is decided at the boundary, not here — see
// editor-kernel-mode.js's flush overrides.
//
// FAIL-CLOSED: a run whose drop cannot be proven is LEFT ALONE. The file then
// still holds a U+00A0 — the pre-existing outcome — which is strictly better
// than a guess.

// A ledger entry this function may consider at all: a real whitespace key
// (never the empty-`ascii` task seed) over bytes that are still a pure U+00A0
// run.
const publishableMark = (mark, text) =>
  !!mark && Number.isInteger(mark.from) && Number.isInteger(mark.to) && mark.from < mark.to &&
  mark.to <= text.length && typeof mark.ascii === 'string' &&
  ASCII_WHITESPACE_RE.test(mark.ascii) && NO_BREAK_RUN_RE.test(text.slice(mark.from, mark.to))

const safeParse = (text) => {
  try {
    return parseKernelMarkdown(text)
  } catch {
    return null
  }
}

// Every node of a tree, document order. The comparisons below are structural
// and read-only (the parse memo may serve frozen trees).
const nodeList = (tree) => {
  const out = []
  const walk = (node) => {
    out.push(node)
    for (const child of node?.children || []) walk(child)
  }
  walk(tree)
  return out
}

// One node's IDENTITY minus its characters: type plus every own property that
// is neither the span, the children, nor the text value — `depth`, `ordered`,
// `start`, `spread`, `checked`, `lang`, `url`, `alt`, `align`, `data`, … Keys
// are sorted so two parses can never differ by property order alone.
const nodeShape = (node) => {
  const out = {}
  for (const key of Object.keys(node || {}).sort()) {
    if (key === 'position' || key === 'children' || key === 'value') continue
    out[key] = node[key]
  }
  return JSON.stringify(out)
}

const treesIdentical = (a, b) => {
  const left = nodeList(a)
  const right = nodeList(b)
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (nodeShape(left[index]) !== nodeShape(right[index])) return false
    if ((left[index].value ?? null) !== (right[index].value ?? null)) return false
  }
  return true
}

// U+00A0 is written as an ESCAPE, never as a literal: a raw NBSP inside a
// character class is invisible in every diff and in every editor, and if it is
// ever lost to copy/paste, an editor's "normalise whitespace" pass, or a lint
// --fix, the class degrades to ASCII-only with NO error — every publish drop of
// a placeholder run then fails closed and the U+00A0 reaches disk (measured:
// 'a<NBSP>\n' publishes unchanged instead of as 'a\n'). The literal spelling of
// `NO_BREAK_SPACE` at the top of this file is deliberate and documented (it is
// the character itself, not a class member); inside a regex it must not be.
const WHITESPACE_RUN_RE = /^[ \t\u00A0]+$/

// Is `after` the same document as `before` except that ONE text value lost one
// contiguous run of whitespace? Same node count, same shapes, exactly one
// differing value, and that difference is a pure whitespace deletion.
const differsByOneWhitespaceRemoval = (before, after) => {
  const left = nodeList(before)
  const right = nodeList(after)
  if (left.length !== right.length) return false
  let differences = 0
  for (let index = 0; index < left.length; index += 1) {
    if (nodeShape(left[index]) !== nodeShape(right[index])) return false
    const was = left[index].value
    const now = right[index].value
    if (was === now) continue
    if (typeof was !== 'string' || typeof now !== 'string') return false
    differences += 1
    if (differences > 1) return false
    if (now.length >= was.length) return false
    if (!isOneContiguousReplacement(was, now, '')) return false
    let head = 0
    while (head < now.length && was[head] === now[head]) head += 1
    if (!WHITESPACE_RUN_RE.test(was.slice(head, head + (was.length - now.length)))) return false
  }
  return differences === 1
}

// The innermost TAIL-STRIPPING block whose span covers the run — the block
// whose content the run belongs to. Deliberately not "the innermost node":
// that is the inline `text` leaf, and deliberately not "any block": a run
// inside a `code`/`math` block is CONTENT and is never claimed (the same
// exclusion `TAIL_STRIPPING_BLOCKS` states for the typing paths).
const innermostBlockCovering = (tree, from, to) => {
  let found = null
  const walk = (node) => {
    const start = node?.position?.start?.offset
    const end = node?.position?.end?.offset
    if (!Number.isInteger(start) || !Number.isInteger(end)) return
    if (start > from || end < to) return
    if (TAIL_STRIPPING_BLOCKS.has(node.type)) found = node
    for (const child of node?.children || []) walk(child)
  }
  walk(tree)
  return found
}

// Try to publish ONE run away. Returns the candidate text plus the raw span
// that was removed, or null (fail-closed: the caller keeps the bytes).
const dropRunForPublish = (text, tree, mark) => {
  const block = innermostBlockCovering(tree, mark.from, mark.to)
  if (!TAIL_STRIPPING_BLOCKS.has(block?.type)) return null
  const blockStart = block.position.start.offset
  const blockEnd = block.position.end.offset
  if (mark.from < blockStart || mark.to > blockEnd) return null
  // BLOCK-END ONLY. Anything but ASCII whitespace between the run and the
  // block's end means the run has content after it — a line start, an interior
  // position — and it is kept (see the ADR).
  if (!/^[ \t]*$/.test(text.slice(mark.to, blockEnd))) return null

  const literal = text.slice(0, mark.from) + mark.ascii + text.slice(mark.to)
  const literalTree = safeParse(literal)
  if (!literalTree) return null

  // The WIDER candidate first: the ASCII whitespace immediately in front of the
  // run dies with it (CommonMark deletes the whole trailing run), and it is the
  // heal's own output — 'a' + Tab + Tab + Tab leaves two real tabs plus one
  // outstanding run, and dropping only the run would strand them. The narrower
  // candidate is the fallback, so an unprovable extension never costs the fix.
  let widened = mark.from
  while (widened > blockStart && isSpaceOrTab(text[widened - 1])) widened -= 1
  const starts = widened === mark.from ? [mark.from] : [widened, mark.from]
  for (const from of starts) {
    const candidate = text.slice(0, from) + text.slice(mark.to)
    const candidateTree = safeParse(candidate)
    if (!candidateTree) continue
    if (!treesIdentical(candidateTree, literalTree)) continue
    if (!differsByOneWhitespaceRemoval(tree, candidateTree)) continue
    return { text: candidate, from, to: mark.to }
  }
  return null
}

// The bytes to PUBLISH for `doc` (save / export / draft persistence), with the
// raw spans that were dropped, ascending. `doc` itself is never modified.
export function resolveWhitespaceForPublish(doc) {
  const text = typeof doc?.text === 'string' ? doc.text : ''
  const marks = (doc?.whitespaceMarks || []).filter((mark) => publishableMark(mark, text))
  if (!marks.length) return { text, drops: [] }
  // RIGHT TO LEFT, so every remaining span keeps its coordinates: each drop
  // only ever removes bytes to the right of the runs still to be considered.
  const ordered = [...marks].sort((a, b) => b.from - a.from)
  const drops = []
  let candidate = text
  for (const mark of ordered) {
    if (drops.length && mark.to > drops[drops.length - 1].from) continue
    const tree = safeParse(candidate)
    if (!tree) break
    const dropped = dropRunForPublish(candidate, tree, mark)
    if (!dropped) continue
    candidate = dropped.text
    drops.push({ from: dropped.from, to: dropped.to })
  }
  drops.reverse()
  return { text: candidate, drops }
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
  // The re-spelled byte joins the document's provenance ledger exactly like an
  // inserted one (markdown-document.js): it stands for the ASCII space that was
  // there before this delete, so the next character heals it back to that space.
  const marks = [{ from: newEnd - 1, to: newEnd, ascii: ' ' }]
  return {
    ok: true,
    edit: { from: editFrom, to: editTo, insert: written },
    whitespaceMarks: marks,
    transaction: {
      baseRevision: doc.revision,
      from: editFrom,
      to: editTo,
      insert: written,
      intent: 'block-trailing-whitespace-delete',
      selection: { anchor: caret, head: caret },
      whitespaceMarks: marks
    }
  }
}
