// 行首空白：CommonMark 把一行内容前的 ASCII 空白当作块结构（缩进/标记内边距）吃掉，
// 所以那里的字面空格是死字节，字面 Tab 还会把段落改写成缩进代码块。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
//
// WHY THIS COMMAND EXISTS
// ----------------------
// This is the third and last position in the kernel's whitespace family. Its two
// siblings own one offset each:
//   * commands/heading-whitespace.js — the FIRST content position of an ATX
//     heading, where the `#`-to-content spacing run is syntax.
//   * commands/trailing-whitespace.js — the LAST content position of a block,
//     where CommonMark strips the final whitespace run.
// Between them sits the position the user actually hits while writing:
//
//     「tab 在行开头输入容易触发内核不支持此操作」
//
// A LINE's own leading whitespace is block structure everywhere in CommonMark —
// paragraph indentation, a list marker's padding, a blockquote's `>` padding —
// so a literal byte written there is never content. Measured in the built app
// (kernel mode, 2026-08-20 probe, one keystroke at a time; the source view and
// the rendered block are both read back):
//
//   position                              Tab                     Space
//   ------------------------------------  ----------------------  ----------------
//   paragraph, first content position     '\t' written; the        ' ' written; the
//                                         paragraph REPARSES AS    view is repaired
//                                         AN INDENTED CODE BLOCK   back, the byte
//                                         (silent, no toast)       stays on disk
//   continuation line after a SOFT break  '\t' written, stripped   same
//   continuation line after a HARD break  '\t' written, stripped   same
//     (both `\` and two-space spellings)
//   list item, text start                 (INDENT — structural)    ' ' written,
//                                                                  stripped
//   blockquote paragraph, text start      '\t' written, stripped   same
//
// Every one of those cells is a byte on disk that nobody can ever see again —
// the one outcome this kernel forbids — and the Tab-at-a-paragraph-start cell is
// worse still: the user's paragraph silently becomes a code block.
//
// WHAT IS WRITTEN, AND WHY IT SURVIVES. The same spelling both siblings use, for
// the same measured reason: U+00A0 (no-break space) is NOT ASCII whitespace, and
// every rule that eats whitespace here — the ≤3-space paragraph indent, the
// 4-space/Tab indented-code trigger, a list marker's padding run, a blockquote's
// `>` padding — is defined over ASCII space and tab only. So a raw U+00A0 at a
// line start ENDS the structural run and becomes the line's first content
// character. It cannot trigger indented code and it cannot be stripped. Measured
// on the kernel's own parser at every position above, and re-proven per edit by
// the reparse below rather than trusted from this paragraph.
//
// Space -> ONE U+00A0, Tab -> TWO (the user's own proportion,
// «tab 可能是两个，specs 这种可能是一个»), raw characters and never a character
// reference («源码模式里，不接受这个写法»).
//
// WHAT THIS COMMAND DOES NOT TOUCH: LIST INDENTATION. Tab with the caret in a
// list item is the INDENT gesture (router.js -> commands/indent.js), and it stays
// structural. This command is never asked about that shape, because the router
// resolves the list item first and only a `not-structural` answer ever reaches
// the whitespace path — see the wiring in editor-kernel-mode.js. Tab on a list
// item that CANNOT be indented (the first item of its list has no previous
// sibling to nest under) still refuses, loudly and with no bytes written, exactly
// as before; that is a structural refusal about list nesting, not a whitespace
// one, and moving that boundary would turn list indentation into whitespace
// insertion.
//
// FAIL-CLOSED, AND THE LITERAL IS TRIED FIRST. Nothing here is decided from the
// prose above. The command builds the LITERAL candidate, reparses it, and asks
// whether the block really says what the literal claims; only when the literal is
// proven NOT to survive does it try the re-spelled one, under the identical
// proof. So:
//   * `not-structural` — the literal byte is fine at this offset (the prefilter
//     was a false positive, or the shape simply keeps its bytes). The caller
//     keeps EXACTLY its previous behaviour.
//   * `unsupported-structure` — the literal is proven dead here AND no surviving
//     spelling could be proven. The caller must refuse loudly rather than write a
//     byte we have just proven nobody will ever see again.
import { buildCharacterMap } from '../character-map.js'
import { parseKernelMarkdown } from '../syntax-index.js'
import {
  BLOCK_TRAILING_TEXT,
  blockEditIsObservable,
  blockText,
  isOneContiguousReplacement
} from './trailing-whitespace.js'

const NOT_STRUCTURAL = { ok: false, code: 'not-structural' }
const UNSUPPORTED = { ok: false, code: 'unsupported-structure' }

// Blocks whose LEADING whitespace CommonMark treats as structure. The same
// allowlist posture commands/trailing-whitespace.js takes, and the two
// exclusions are the same ones and for the same reason:
//   `code` / `math` — a verbatim block's leading spaces ARE content and are
//                     already byte-preserved; rewriting them would corrupt real
//                     data (source code indentation, aligned TeX).
// `heading` is excluded too: an ATX heading's first content position belongs to
// commands/heading-whitespace.js, which owns a narrower and better-proven route
// to the same character, and a setext heading's underline is not a content line
// at all.
const LEAD_STRIPPING_BLOCKS = new Set(['paragraph', 'tableCell'])

// The ASCII whitespace run an insert BEGINS with — the part of it that lands at
// the line's start and is therefore the part CommonMark consumes as structure.
const LEADING_RUN_RE = /^[ \t]*/
const NO_BREAK_RUN_RE = /^ +$/
const ASCII_WHITESPACE_RE = /^[ \t]+$/

// That run, re-spelled character by character. Returns null if any character has
// no spelling, so the caller falls through rather than writing half a run.
const spellLeadingRun = (run) => {
  let out = ''
  for (const ch of run) {
    const written = BLOCK_TRAILING_TEXT[ch]
    if (!written) return null
    out += written
  }
  return out
}

// Bytes that can appear in a content line's own structural prefix: indentation,
// a blockquote marker, a list marker (bullet, ordered, GFM task checkbox). The
// set is deliberately LOOSE — this is only a prefilter.
const PREFIX_BYTE = /[ \t>*+\-0-9.)[\]xX]/

// Cheap, parse-free PREFILTER for the hot per-keystroke paths: could `offset` be
// a position where a literal ASCII whitespace byte is block STRUCTURE rather than
// content?
//
// It walks BACKWARDS from the offset and answers `true` only if everything
// between it and the start of the physical line is prefix bytes. The walk stops
// at the FIRST byte that cannot be part of a prefix, so ordinary typing pays one
// character comparison ('hello' + Space: the byte before the caret is 'o', done)
// and only a caret genuinely sitting in a line's opening run walks any distance.
//
// It is a NECESSARY condition, never a sufficient one: it also fires inside a
// fenced code block, on the second space of `a - b`, and on a heading's `# `.
// `spellLineStartWhitespace` is the authority; this only decides whether it is
// worth asking.
export const looksLikeBlockLineStart = (text, offset) => {
  if (typeof text !== 'string' || !Number.isInteger(offset)) return false
  if (offset < 0 || offset > text.length) return false
  let index = offset
  while (index > 0) {
    const ch = text[index - 1]
    if (ch === '\n' || ch === '\r') return true
    if (!PREFIX_BYTE.test(ch)) return false
    index -= 1
  }
  return true
}

// A U+00A0 run THIS KERNEL wrote that starts exactly at `offset` — i.e. the run
// an insert here is about to DISPLACE off the line start. Returns
// `{ rawStart, rawEnd, ascii }` or null.
//
// WHY THE HEAL EXISTS HERE AT ALL. A line-start run normally stays at the line
// start forever: text typed AFTER it lands after it and the run is still the
// line's first character, so unlike the block-TRAILING case there is no steady
// state to return to. There is exactly ONE way it stops being leading — the user
// puts the caret in FRONT of it and types — and then the character is an ordinary
// interior space that should be spelled as one. The ledger
// (markdown-document.js) is what makes that safe: only a run this kernel itself
// wrote is ever rewritten, and the ASCII it stands for is recorded rather than
// guessed, so a Tab's two U+00A0 restore a Tab and a file that legitimately holds
// U+00A0 for CJK spacing is never touched.
export const healableLineStartRun = (text, charMap, marks, offset) => {
  if (typeof text !== 'string' || !Number.isInteger(offset)) return null
  const mark = (marks || []).find((entry) => entry?.from === offset)
  if (!mark || !Number.isInteger(mark.to) || mark.from >= mark.to) return null
  if (!NO_BREAK_RUN_RE.test(text.slice(mark.from, mark.to))) return null
  if (typeof mark.ascii !== 'string' || !ASCII_WHITESPACE_RE.test(mark.ascii)) return null
  // The recorded span must be exactly a run of whole, width-1 `char` units, so
  // the heal replaces addressable characters and nothing else.
  const units = charMap?.units
  if (!Array.isArray(units) || !units.length) return null
  let at = mark.from
  while (at < mark.to) {
    const unit = units.find((entry) => entry?.rawStart === at)
    if (!unit || unit.kind !== 'char' || unit.width !== 1 || unit.rawEnd !== at + 1) return null
    at += 1
  }
  return { rawStart: mark.from, rawEnd: mark.to, ascii: mark.ascii }
}

// Every written character must have become its OWN width-1 `char` unit at the
// insert point — the "存下来并且能被看到" half of the user's standing ruling: the
// character renders, takes the caret, and one Backspace deletes exactly one of
// them. An entity (one unit for several bytes) could not offer that, which is why
// this is proven rather than assumed.
const runIsAddressable = (candidate, node, from, length) => {
  const map = buildCharacterMap(candidate, node)
  if (!map) return false
  for (let index = 0; index < length; index += 1) {
    const at = from + index
    const unit = map.units.find((entry) => entry?.rawStart === at)
    if (!unit || unit.kind !== 'char' || unit.width !== 1 || unit.rawEnd !== at + 1) return false
  }
  return true
}

// Spell an insert whose LEADING whitespace lands at a content line's start so
// that it survives the reparse — and, in the same edit, heal a U+00A0 run this
// module wrote back to the ASCII it stands for when this very insert pushes it
// off the line start.
//
// Inputs (all from state the caller already holds; this command performs ONE
// parse of the baseline and at most two of a candidate, and only once its
// caller's parse-free prefilter says the shape is at risk):
//   doc     the kernel document (`text` + `revision`)
//   block   the mdast node the projection map already paired with this textblock
//           (`pair.mdBlock`) — its span is the baseline
//   offset  the raw insert offset
//   insert  the text being inserted, no line breaks
//   heal    `healableLineStartRun(...)` for this offset, or null
export function spellLineStartWhitespace({ doc, block, offset, insert, heal = null }) {
  const text = doc?.text
  if (typeof text !== 'string' || !Number.isInteger(doc?.revision)) return NOT_STRUCTURAL
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return NOT_STRUCTURAL
  if (typeof insert !== 'string' || !insert || /[\r\n]/.test(insert)) return NOT_STRUCTURAL
  if (!LEAD_STRIPPING_BLOCKS.has(block?.type)) return NOT_STRUCTURAL
  const blockStart = block?.position?.start?.offset
  const blockEnd = block?.position?.end?.offset
  if (!Number.isInteger(blockStart) || !Number.isInteger(blockEnd)) return NOT_STRUCTURAL
  if (offset < blockStart || offset > blockEnd) return NOT_STRUCTURAL

  const leadingRun = LEADING_RUN_RE.exec(insert)[0]
  const spelledRun = leadingRun ? spellLeadingRun(leadingRun) : ''
  // The heal span is re-proven against the bytes AND against its own recorded
  // spelling — a span that is not a pure U+00A0 run, or that claims to stand for
  // something other than ASCII whitespace, is not healed. It only applies when
  // the insert lands exactly at the run's start (i.e. displaces it) and does not
  // itself begin with whitespace: a whitespace insert in front of a leading run
  // simply produces a longer leading run, every character of which must stay
  // U+00A0.
  const healSpan = heal && !leadingRun && heal.rawStart === offset &&
    Number.isInteger(heal.rawEnd) && heal.rawStart < heal.rawEnd &&
    NO_BREAK_RUN_RE.test(text.slice(heal.rawStart, heal.rawEnd)) &&
    typeof heal.ascii === 'string' && ASCII_WHITESPACE_RE.test(heal.ascii)
    ? heal
    : null
  if (!leadingRun && !healSpan) return NOT_STRUCTURAL
  if (leadingRun && spelledRun === null) return NOT_STRUCTURAL

  let baselineTree
  try {
    baselineTree = parseKernelMarkdown(text)
  } catch {
    return NOT_STRUCTURAL
  }
  // The baseline block is re-read from THIS parse (the caller's `block` may come
  // from a map bound to the same bytes, but the proof must not depend on that).
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

  // ATTEMPT 0 — THE LITERAL, TRIED FIRST AND ON EVERY CALL. The prefilter is a
  // necessary condition only, so this is what separates "a line start" from "a
  // line start where the byte actually dies". A literal that survives observably
  // means nothing about this shape changes: the caller writes exactly the bytes
  // it always did. (A heal is never combined with this branch — if the literal
  // survives, the displaced run is being displaced by ordinary content and the
  // heal is proven separately below.)
  if (!healSpan) {
    const literal = text.slice(0, offset) + insert + text.slice(offset)
    if (blockEditIsObservable({
      baselineTree,
      block: baseline,
      candidate: literal,
      delta: insert.length,
      matches: (found) => isOneContiguousReplacement(baselineText, blockText(found), insert)
    })) {
      return NOT_STRUCTURAL
    }
  }

  // FROM HERE ON THE LITERAL IS PROVEN NOT TO SURVIVE, so there is no "leave it
  // alone" exit left: either a spelling is proven, or the write is refused.
  //
  // Attempt 1: heal + insert (only when a recorded run is being displaced).
  // Attempt 2: the re-spelled insert alone, so a heal that cannot be proven never
  // costs the user the character they just typed.
  const written = spelledRun + insert.slice(leadingRun.length)
  const attempts = []
  if (healSpan) {
    const runLength = healSpan.rawEnd - healSpan.rawStart
    if (!NO_BREAK_RUN_RE.test(text.slice(healSpan.rawStart, healSpan.rawEnd))) return NOT_STRUCTURAL
    attempts.push({
      from: healSpan.rawStart,
      to: healSpan.rawEnd,
      // The RECORDED ASCII, not a hardcoded space: the ledger says which key was
      // pressed, so a Tab-written run restores a Tab rather than the kernel
      // guessing between "one Tab" and "two Spaces".
      write: written + healSpan.ascii,
      spelled: spelledRun.length,
      healedUnits: runLength
    })
  }
  if (leadingRun) {
    attempts.push({ from: offset, to: offset, write: written, spelled: spelledRun.length, healedUnits: 0 })
  }

  for (const attempt of attempts) {
    const candidate = text.slice(0, attempt.from) + attempt.write + text.slice(attempt.to)
    const delta = attempt.write.length - (attempt.to - attempt.from)
    let provenNode = null
    const proven = blockEditIsObservable({
      baselineTree,
      block: baseline,
      candidate,
      delta,
      // ONE CONTIGUOUS REPLACEMENT, stated over the DECODED text: the block must
      // read as the baseline with exactly ONE contiguous run replaced by exactly
      // the bytes this attempt writes — which covers both attempts, because a
      // pure insert is the degenerate case where the replaced run is empty.
      // Stated this way rather than as an exact expected string because the
      // baseline's decoded text and its raw bytes are different alphabets (an
      // inline image contributes no characters, an escape contributes fewer than
      // it spells), so an "expected" built from either would refuse correct
      // documents. WHERE the run landed is pinned separately and more strongly:
      // the candidate bytes are built at `attempt.from` by this function, and
      // `runIsAddressable` re-reads the written characters back out of the
      // candidate's own character map at exactly those raw offsets.
      matches: (found) => {
        if (!isOneContiguousReplacement(baselineText, blockText(found), attempt.write)) return false
        provenNode = found
        return true
      }
    })
    if (!proven || !provenNode) continue
    // Every U+00A0 this attempt writes must be caret-addressable in the candidate.
    if (attempt.spelled &&
        !runIsAddressable(candidate, provenNode, attempt.from, attempt.spelled)) continue
    const caret = attempt.from + attempt.write.length -
      (attempt.healedUnits ? healSpan.ascii.length : 0)
    // What this edit writes as U+00A0, in POST-edit coordinates, so the ledger can
    // vouch for it on a later keystroke. A heal that restores ASCII records
    // nothing for the span it replaced (the remap drops that entry, because the
    // edit covers it).
    const marks = attempt.spelled
      ? [{ from: attempt.from, to: attempt.from + attempt.spelled, ascii: leadingRun }]
      : []
    return {
      ok: true,
      spelling: attempt.spelled ? 'no-break-space' : 'literal',
      healed: attempt.to > attempt.from,
      healedUnits: attempt.healedUnits,
      edit: { from: attempt.from, to: attempt.to, insert: attempt.write },
      whitespaceMarks: marks,
      transaction: {
        baseRevision: doc.revision,
        from: attempt.from,
        to: attempt.to,
        insert: attempt.write,
        intent: 'line-start-whitespace',
        selection: { anchor: caret, head: caret },
        whitespaceMarks: marks
      }
    }
  }

  // A byte we have proven is stripped (or that would restructure the block), with
  // no spelling that survives: refuse loudly. A heal that simply could not be
  // proven is not an error on its own — but it only ever runs on a path where the
  // literal was already proven dead, so there is nothing to fall through to.
  return leadingRun ? UNSUPPORTED : NOT_STRUCTURAL
}
