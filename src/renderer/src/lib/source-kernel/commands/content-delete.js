// 删除侧的可观测性证明：一次删除若把某个物理行的内容全部清空，剩下的字节
// （空行、纯空白行、只剩标记的行）会被 CommonMark 读成完全不同的结构。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
//
// WHY THIS COMMAND EXISTS
// -----------------------
// The insert side of this kernel has a pre-write proof: commands/
// trailing-whitespace.js's `blockEditIsObservable` reparses the candidate and
// refuses unless the edit is observable in what the bytes say. Nothing on the
// DELETE side ever consulted it. `commitPlainText` computes an `observability`
// expectation for deletes too, but that fires AFTER publication and only logs
// (`edit-unobservable`) — by then `verifyPlainTextProjection` has already
// repaired the VIEW to match the corrupted bytes, which makes the damage
// permanent and invisible.
//
// The shape (2026-08-19 audit, every case reproduced against the real parser
// through the real gateway): deleting the ENTIRE TEXT of one physical line
// inside a MULTI-LINE block leaves a line CommonMark reads as blank — or as a
// setext underline:
//
//   'alpha  ' LF 'b  ' LF 'gamma' LF   (ONE paragraph, two hard breaks)
//     Backspace after 'b'
//     -> committed 'alpha  ' LF '  ' LF 'gamma' LF
//     -> reparses as TWO paragraphs; BOTH hard breaks gone.
//
//   '- outer' LF '  - b  ' LF '    tail' LF
//     Backspace after 'b'
//     -> committed '- outer' LF '  -   ' LF '    tail' LF
//     -> reparses as listItem > HEADING(2) 'outer' + paragraph 'tail':
//        one Backspace turned a paragraph into a setext H2 and destroyed a
//        whole list level.
//
// Confirmed for bare paragraphs, blockquotes 1/2/3 deep, bullet/ordered/nested
// lists, quote+list, list+quote, LF and CRLF, and both hard-break spellings.
// The SOFT-break spelling ('a' LF 'b' LF 'c' LF -> 'a' LF LF 'c' LF -> two
// paragraphs) has the identical shape and is PRE-EXISTING — it was not opened
// by the 2026-08-18 hard-break relaxation; both halves are refused here.
//
// Two more members of the same family, also refused by this one proof:
//   * a backslash-spelled hard break whose LAST line is deleted invents visible
//     content: 'a\' LF 'b' LF minus 'b' commits 'a\' LF LF, which reparses to a
//     paragraph whose text literally reads `a\` — a dead escape promoted to a
//     character the user never typed;
//   * the dead-byte leftovers ('a  ' LF 'b' LF minus 'b' -> 'a  ' LF LF, an
//     orphaned hard-break marker; minus 'a' -> '  ' LF 'b' LF). Harmless on
//     reparse, but exactly the "byte nobody can see" class this kernel exists
//     to end.
//
// WHAT IS AND IS NOT CLAIMED
// --------------------------
// This command does not RE-SPELL anything. A delete has no second spelling that
// is obviously the user's intent — swallowing a neighbouring line ending to
// "tidy up" would be the kernel guessing, which is the failure mode every
// corruption in this family started as. So the answer is binary: the literal
// bytes are proven observable, or the keystroke is refused with the source
// untouched. A refused Backspace is recoverable; a document that silently grew
// a heading is not.
//
// THE DECODE CLAUSE IS A CONTIGUOUS-REPLACEMENT PROOF, NOT AN EQUALITY. The
// insert side can state the exact string its block must decode to. The delete
// side cannot: what ProseMirror holds after its own deletion and what mdast
// decodes from the candidate bytes are different alphabets for the same block
// (an inline image or hardbreak is a PM character but contributes NOTHING to
// mdast's decoded text; an inline `html`/`inlineMath` node is the reverse), so
// an "expected" built from either side would refuse correct documents for a
// reason that has nothing to do with the edit. What IS provable, and is what
// the corruptions above all violate, is that the block's decoded text changed
// by exactly ONE contiguous replacement — nothing appeared anywhere else, no
// dead byte was promoted to content, nothing was absorbed from a neighbour.
//
// MULTI-STEP BATCHES (2026-08-19). Everything above is reached from
// `commitPlainText` under `steps.length === 1`. A BATCH of ReplaceSteps that
// deletes is the same corruption class in a different coordinate space, and it
// is answered at the bottom of this file (`batchDeleteRefusal`) — as a refusal,
// not as a proof, because the one-contiguous-replacement sentence this file
// proves is not true of a composition of several.
import { parseKernelMarkdown } from '../syntax-index.js'
import {
  blockEditIsObservable, blockText, isOneContiguousReplacement, literalTailIsStripped
} from './trailing-whitespace.js'

const UNSUPPORTED = { ok: false, code: 'unsupported-structure' }
const NOT_STRUCTURAL = { ok: false, code: 'not-structural' }

const isLineBreakChar = (ch) => ch === '\n' || ch === '\r'

// The physical line containing `offset`, as raw [start, end) EXCLUDING the
// terminator. Handles LF / CRLF / lone CR uniformly by scanning for either
// character, so no line-ending assumption is smuggled in (this repo has a whole
// bug family from exactly that).
const lineStartAt = (text, offset) => {
  let index = Math.min(Math.max(offset, 0), text.length)
  while (index > 0 && !isLineBreakChar(text[index - 1])) index -= 1
  return index
}
const lineEndAt = (text, offset) => {
  let index = Math.min(Math.max(offset, 0), text.length)
  while (index < text.length && !isLineBreakChar(text[index])) index += 1
  return index
}

// Decoded content of one block. A verbatim leaf (`code`/`math`) carries its
// characters in `.value` and has no children, so `blockText`'s inline walk
// would report '' for every candidate and prove nothing; everything else is the
// shared inline decoder.
const decodeBlock = (node) => (
  typeof node?.value === 'string' ? node.value : blockText(node)
)

// PARSE-FREE PREFILTER. Does this edit strip the LAST content off the physical
// line(s) it touches, inside a block that spans more than that one line?
//
// "Content-free" is NOT a lexical property of the remaining bytes, which is why
// this is answered from the block's own character map rather than from how the
// line looks: the nested-list case leaves '  -   ', which is not whitespace-only
// yet holds no content — the '-' is a marker byte no unit covers.
//
// So the question asked of each surviving unit is byte-level: does it still
// contribute a NON-WHITESPACE byte to this line? That is deliberately not a
// question about unit KINDS. A hard break is an `atom` unit, not a `linebreak`
// one (character-map.js models `break`/`image`/`math_inline`/`html` alike), and
// its raw span is the two trailing spaces plus the terminator — so a kind-based
// test would read a hard break as surviving content and miss the whole
// hard-break half of this family, which is where the defect was found. Reading
// bytes gets both right: a hard break's surviving bytes on the line are the two
// SPACES (whitespace, i.e. syntax here), while an image or inline-math atom
// keeps real characters and correctly counts as content.
//
// Three conditions, all necessary:
//   * no surviving unit contributes a non-whitespace byte to the affected line;
//   * `insert` contributes no content of its own (no non-whitespace character).
//     A replacement that types real text onto the line cannot blank it;
//   * the block extends BEYOND this line. A single-line block whose text is
//     fully deleted is the ordinary "empty this paragraph/heading/cell"
//     operation — it produces an empty block, not a restructured document, and
//     is deliberately left exactly as it was.
export function deleteClearsBlockLine({ text, charMap, block, from, to, insert = '' }) {
  return editsClearBlockLine({ text, charMap, block, edits: [{ from, to, insert }] })
}

// The SAME question asked of a whole BATCH of edits (2026-08-19, audit hole 6).
// `deleteClearsBlockLine` above is a thin wrapper around this — ONE
// implementation, so the single-step and multi-step answers can never drift
// apart.
//
// Why a batch needs its own evaluation rather than a per-step loop: two steps
// that each remove HALF of a line's content each see the other half surviving,
// so neither of them alone reports a blanked line while their composition
// blanks it. `edits` are raw ranges into the SAME baseline `text` (the
// coordinate space `commitPlainText` resolves every step into), ascending and
// non-overlapping.
export function editsClearBlockLine({ text, charMap, block, edits }) {
  if (typeof text !== 'string' || !Array.isArray(edits) || !edits.length) return false
  let removes = false
  let low = Infinity
  let high = -Infinity
  for (const edit of edits) {
    const from = edit?.from
    const to = edit?.to
    const insert = edit?.insert ?? ''
    if (typeof insert !== 'string') return false
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) return false
    if (from < 0 || to > text.length) return false
    if (/\S/.test(insert)) return false
    if (to > from) removes = true
    low = Math.min(low, from)
    high = Math.max(high, to)
  }
  if (!removes) return false
  const blockStart = block?.position?.start?.offset
  const blockEnd = block?.position?.end?.offset
  if (!Number.isInteger(blockStart) || !Number.isInteger(blockEnd)) return false
  const units = charMap?.units
  if (!Array.isArray(units)) return false

  const lineStart = lineStartAt(text, low)
  const lineEnd = lineEndAt(text, high)
  if (blockStart >= lineStart && blockEnd <= lineEnd) return false // single-line block

  const removed = (index) => edits.some((edit) => index >= edit.from && index < edit.to)

  for (const unit of units) {
    if (!Number.isInteger(unit?.rawStart) || !Number.isInteger(unit?.rawEnd)) continue
    const start = Math.max(unit.rawStart, lineStart)
    const end = Math.min(unit.rawEnd, lineEnd)
    if (start >= end) continue // not on this line
    // A LINE-CROSSING unit is pure syntax, all of it. character-map.js gives a
    // soft break / hard break ONE unit whose raw span is "whatever trailing
    // spaces the break is spelled with + the terminator + the NEXT line's
    // continuation prefix" — so a quoted paragraph's '> ' lives inside it. Those
    // bytes are markers, not content, and scanning them would read every quoted
    // or list-indented block as still having content on the line. A unit is
    // line-crossing exactly when its own raw span holds a line break; an inline
    // image / math / html atom never does, so it is still scanned and still
    // counts as the real content it is.
    if (/[\r\n]/.test(text.slice(unit.rawStart, unit.rawEnd))) continue
    for (let index = start; index < end; index += 1) {
      if (removed(index)) continue // removed by this batch
      const ch = text[index]
      if (ch !== ' ' && ch !== '\t') return false // content survives on this line
    }
  }
  return true
}

// Compose a batch of baseline-coordinate edits into the candidate text.
const composeEdits = (text, edits) => {
  let out = ''
  let cursor = 0
  for (const edit of edits) {
    out += text.slice(cursor, edit.from) + (edit.insert ?? '')
    cursor = edit.to
  }
  return out + text.slice(cursor)
}

// Candidate offset -> baseline offset, or null when the candidate byte was
// WRITTEN by the batch (it has no baseline counterpart, so nothing can be
// claimed about what it used to be).
const baselineOffsetOf = (edits, candidateOffset) => {
  let shift = 0
  for (const edit of edits) {
    const insert = edit.insert ?? ''
    const writtenStart = edit.from + shift
    if (candidateOffset < writtenStart) return candidateOffset - shift
    if (candidateOffset < writtenStart + insert.length) return null
    shift += insert.length - (edit.to - edit.from)
  }
  return candidateOffset - shift
}

// Does a BATCH leave a literal ASCII whitespace byte stranded at the block's
// end — the dead byte `spellBlockTailDelete` re-spells for the single-step
// case? Same three facts that command establishes, asked of the composed
// result: the byte survives from the baseline (it is not one the batch wrote),
// it was CONTENT there (a width-1 `char` unit in the block's character map, the
// check that keeps a GFM cell's own padding from reading as a false positive),
// and CommonMark discards it at its new position.
export function editsStrandBlockTail({ text, charMap, block, edits }) {
  if (typeof text !== 'string' || !Array.isArray(edits) || !edits.length) return false
  const blockStart = block?.position?.start?.offset
  const blockEnd = block?.position?.end?.offset
  if (!Number.isInteger(blockStart) || !Number.isInteger(blockEnd)) return false
  let delta = 0
  let removes = false
  for (const edit of edits) {
    if (!Number.isInteger(edit?.from) || !Number.isInteger(edit?.to) || edit.from > edit.to) return false
    if (edit.from < blockStart || edit.to > blockEnd) return false
    if (edit.to > edit.from) removes = true
    delta += (edit.insert ?? '').length - (edit.to - edit.from)
  }
  if (!removes) return false
  const newEnd = blockEnd + delta
  if (newEnd - 1 < blockStart) return false
  const candidate = composeEdits(text, edits)
  const ch = candidate[newEnd - 1]
  if (ch !== ' ' && ch !== '\t') return false
  const baselineAt = baselineOffsetOf(edits, newEnd - 1)
  if (!Number.isInteger(baselineAt)) return false
  const unit = (charMap?.units || []).find(
    (candidateUnit) => candidateUnit?.kind === 'char' &&
      candidateUnit.rawStart === baselineAt && candidateUnit.rawEnd === baselineAt + 1
  )
  if (!unit) return false
  return literalTailIsStripped(candidate, {
    type: block.type,
    position: { start: { offset: blockStart }, end: { offset: newEnd } }
  }, newEnd - 1)
}

// THE MULTI-STEP GATE (2026-08-19, audit hole 6). Both single-step delete
// guards above are reached from `commitPlainText` under `steps.length === 1`,
// so a BATCH of ReplaceSteps that deletes reached NEITHER: the same corruption
// class, one coordinate space over. "Never observed in a reproduction" is not a
// proof, and this is the one path where an unproven write is forbidden.
//
// HOW A BATCH IS PROVEN: STEP BY STEP, ON THE BYTES. `proveContentDelete`'s
// decode clause states "the block's decoded text changed by exactly ONE
// contiguous replacement", which is simply not true of a composition of
// several — and weakening it to "N replacements" would be close to vacuous for
// small N, i.e. a guess wearing a proof's clothes. So the batch is not proven
// as one edit: each of its steps is applied to the previous CANDIDATE (a string
// that is never published) and proven there with the SAME single-step proof.
// A composition of proven steps is proven, and every intermediate document is
// reparsed, so nothing about the sequence is taken on trust:
//
//   'alpha  ' LF 'bc  ' LF 'gamma'   remove 'b', then remove 'c'
//     step 1 -> 'alpha  ' LF 'c  ' LF 'gamma'   proven (line still has content)
//     step 2 -> 'alpha  ' LF '  ' LF 'gamma'    REFUSED (two paragraphs, both
//                                               hard breaks gone)
//
// while the same two steps inside a fenced block, where an emptied line is
// legitimate content, are proven at both stages and commit exactly as before.
// This is what distinguishes the gate from a blanket refusal of batched
// deletes: it refuses the corruption, not the shape.
//
// The composed PREFILTER decides whether any of that is worth doing, exactly as
// on the single-step path — with one difference that is the whole reason a
// batch needs its own evaluation: it is asked of the WHOLE batch at once,
// because two steps that each remove half of a line's content each see the
// other half surviving.
//
// TWO SHAPES ARE REFUSED WITHOUT AN ATTEMPT, both stated rather than silently
// unhandled:
//   * a batch that strands a literal ASCII space at the block end. The
//     single-step path RE-SPELLS that byte U+00A0 (`spellBlockTailDelete`)
//     under a proof about one contiguous replacement; that proof cannot speak
//     for a composition, and writing the dead byte is the one forbidden
//     outcome, so the batch is refused instead;
//   * a batch that WRITES bytes into the block as well as removing them. The
//     step-by-step proof would have to re-derive the block's span after an
//     insert it did not prove, and an insert's own spelling has already been
//     decided by a different command upstream. Refusing is the honest answer.
//
// Returns `{ ok: true }`, or `{ ok: false, code }` the caller must refuse with,
// or `{ ok: false, code: 'not-structural' }` meaning nothing here applies and
// the caller keeps its pre-existing behaviour.
export function proveBatchDelete({ doc, block, charMap, edits }) {
  const text = doc?.text
  if (typeof text !== 'string' || !Array.isArray(edits) || !edits.length) return NOT_STRUCTURAL
  if (!edits.some((edit) => edit.to > edit.from)) return NOT_STRUCTURAL
  if (editsStrandBlockTail({ text, charMap, block, edits })) return UNSUPPORTED
  if (!editsClearBlockLine({ text, charMap, block, edits })) return NOT_STRUCTURAL
  // From here the batch IS the at-risk shape, so every remaining exit is a
  // refusal — there is no "leave it alone" left.
  if (edits.some((edit) => (edit.insert ?? '') !== '')) return UNSUPPORTED

  let candidate = text
  let start = block?.position?.start?.offset
  let end = block?.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end)) return UNSUPPORTED
  let shift = 0
  for (const edit of edits) {
    const from = edit.from + shift
    const to = edit.to + shift
    const routed = proveContentDelete({
      doc: { text: candidate, revision: 0 },
      block: { type: block.type, position: { start: { offset: start }, end: { offset: end } } },
      from,
      to,
      insert: ''
    })
    // `not-structural` counts as a failure HERE (unlike on the single-step
    // path, where it means "this command does not claim the shape"): the
    // composed batch has already been established as the at-risk shape, so an
    // unproven step is an unproven write.
    if (!routed.ok) return UNSUPPORTED
    candidate = candidate.slice(0, from) + candidate.slice(to)
    const delta = -(to - from)
    end += delta
    shift += delta
  }
  return { ok: true }
}

// Prove that the literal delete really says what it does.
//
// Inputs (raw offsets into `doc.text`, already resolved by the caller through
// the proven projection map):
//   doc     the kernel document (`text` + `revision`)
//   block   the mdast node the projection map paired with this textblock
//   from/to the raw range the edit removes
//   insert  the raw bytes written in its place (the caller's prefilter has
//           already established these carry no content)
//
// Refusals:
//   `not-structural`        — the inputs are not the shape this command claims;
//                             the caller keeps its pre-existing behaviour.
//   `unsupported-structure` — this IS the shape and the bytes could not be
//                             proven. The caller MUST refuse: the literal write
//                             is known to restructure the document.
export function proveContentDelete({ doc, block, from, to, insert = '' }) {
  const text = doc?.text
  if (typeof text !== 'string' || !Number.isInteger(doc?.revision)) return NOT_STRUCTURAL
  if (typeof insert !== 'string') return NOT_STRUCTURAL
  if (!Number.isInteger(from) || !Number.isInteger(to) || from >= to) return NOT_STRUCTURAL
  if (from < 0 || to > text.length) return NOT_STRUCTURAL
  const blockStart = block?.position?.start?.offset
  const blockEnd = block?.position?.end?.offset
  if (!Number.isInteger(blockStart) || !Number.isInteger(blockEnd)) return NOT_STRUCTURAL
  // The edit must live inside this block's span. Anything crossing a block
  // boundary is a structural change no character-level proof can speak for.
  if (from < blockStart || to > blockEnd) return UNSUPPORTED

  // The BASELINE is re-parsed rather than taken from the caller's `block`, for
  // the reason commands/empty-code-insert.js records: the caller's node comes
  // from `buildSyntaxIndex`'s tree, which carries `injectHighlightNodes`' split
  // text nodes the candidate parse does not.
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
  if (!baseline) return UNSUPPORTED

  const baselineText = decodeBlock(baseline)
  const candidate = text.slice(0, from) + insert + text.slice(to)
  const proven = blockEditIsObservable({
    baselineTree,
    block: baseline,
    candidate,
    delta: insert.length - (to - from),
    decode: decodeBlock,
    // No `expectedText`: see this module's header for why the delete side
    // cannot state one, and what it proves instead.
    matches: (found) => isOneContiguousReplacement(baselineText, decodeBlock(found), insert)
  })
  if (!proven) return UNSUPPORTED
  return { ok: true, edit: { from, to, insert } }
}
