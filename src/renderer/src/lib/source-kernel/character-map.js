// SourceCharacterMap: character-level boundary mapping between "visible"
// (decoded) text and raw source bytes, anchored to mdast node positions.
//
// This module is pure: no Electron/React/@milkdown imports (source-kernel
// convention, see syntax-index.js).
//
// Fail-closed contract: any block this module can't PROVE a lossless mapping
// for returns `null` from buildCharacterMap — callers must not guess.
import { decodeNamedCharacterReference } from 'decode-named-character-reference'
import { rangeFromInlineCode } from './mark-map.js'
import { inlineHtmlRunAt, BREAK_REWRITE_PARENTS } from './inline-html.js'

// Inline "atom" nodes: entire node is one indivisible visible unit — a caret
// may sit on either edge but never inside. Phase 1 needs only nodes whose
// raw span is meaningfully different from a simple decoded-text run.
//
// `inlineCode` is deliberately NOT here (P4-3.5 fix): ProseMirror represents
// an inline-code span as a MARKED TEXT RUN of N characters, so a width-1 atom
// unit made `content.size === visibleLength` fail for every multi-char span —
// one `code span` in a paragraph degraded the WHOLE document's projection map
// at attach. It gets per-value-char units instead (see inlineCodeUnits below);
// the backtick runs become marker gaps, exactly like `**`/`*`/`~~`.
//
// `inlineMath` IS here (Plan 5 Task 1): ProseMirror represents `$x^2$` as a
// single `math_inline` ATOM node (Crepe's latex feature — the TeX source
// lives in `attrs.value`, not as text children), so PM's `content.size`
// counts it as exactly 1. A width-1 atom unit whose raw span is the node's
// own position (both `$` delimiters included) is the only shape that keeps
// `content.size === visibleLength` true — the identity the projection map
// requires. Unlike `inlineCode` (whose PM shape is a marked TEXT RUN, hence
// per-char units), there is no PM interior to address here: a caret can sit
// on either edge of the formula but never inside it.
const ATOMS = new Set([
  'image', 'imageReference', 'break', 'footnoteReference', 'html', 'inlineMath'
])

const ENTITY_RE = /^&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{0,31});/

function decodeEntity(raw) {
  const m = raw.match(ENTITY_RE)
  if (!m) return null
  const body = m[1]
  let decoded = null
  if (body[0] === '#') {
    const code = body[1] === 'x' || body[1] === 'X'
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10)
    if (Number.isFinite(code)) {
      try {
        decoded = String.fromCodePoint(code)
      } catch {
        decoded = null
      }
    }
  } else {
    decoded = decodeNamedCharacterReference(body) || null
  }
  return decoded ? { rawLength: m[0].length, decoded } : null
}

// Soft break: a `\n` in the decoded `value` corresponds to a raw run of
// [line terminator] + [continuation-line prefix] (blockquote `>` markers /
// leading whitespace the parser strips from the visible text). We greedily
// consume the prefix character class, but must land exactly where the next
// decoded character can be matched again — the caller re-verifies alignment
// on the following iteration, so an over-greedy consume here still fails
// closed rather than silently mis-mapping.
//
// That re-verification is what makes the greedy consume safe, and it exists
// only while the fold stays INSIDE this text node (there is more decoded value
// to match against). When the break ENDS the node, nothing is left to
// re-verify and the fold has to be proven instead — see `continuationFoldEnd`
// and its caller below.
function consumeSoftBreak(text, r) {
  let i = r
  if (text[i] === '\r') i += text[i + 1] === '\n' ? 2 : 1
  else if (text[i] === '\n') i += 1
  else return null
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '>')) {
    i += 1
  }
  return i
}

// LINE-ENDING CONTINUATION FOLD — one proof, both break kinds.
//
// HARD BREAK: the same continuation-prefix problem `consumeSoftBreak` solves,
// solved the same way (2026-08-18). An mdast `break` is an ATOM here (one
// width-1 unit), and its own position STOPS at the line terminator:
//
//   'a  \n  b'    text[0,1) break[1,4) text[6,7)
//   '> a  \n> b'  text[2,3) break[3,6) text[8,9)
//
// so the next line's continuation prefix ('  ', '> ') belonged to NO unit.
// That gap is not a cosmetic detail: the visible boundary just after the break
// resolved to the PRE-gap offset through all three resolvers, so an insert
// there committed '> a  \nX> b' — the quote marker demoted to paragraph text —
// and a delete of the break resolved to [3,6), leaving '> a> b'. It is why a
// hard break was kept out of the gateway's typable-atom allowlist, i.e. why
// ANY paragraph containing one was wholly untypable.
//
// A soft break never had the hole because `consumeSoftBreak` folds the prefix
// into its `linebreak` unit. This does the same for the hard break, but PROVES
// the fold instead of consuming greedily: the unit may only be extended up to
// the NEXT SIBLING's own start offset, and every byte in between must be a
// continuation-prefix character (' ', '\t', '>' — the only characters a
// container prefix is made of). The result is that the units tile the block
// contiguously across the break, exactly as they do across a soft one.
//
// TWO SHAPES REFUSE (fail closed, whole block degrades to read-only):
//  1. the break is the LAST child of its container, AND real prefix bytes
//     follow it. Reachable only as a hard break at the very end of a link/
//     emphasis label inside a prefixed container ('> [a  \n> ](u)b'): there is
//     no following sibling whose start offset proves where the prefix ends,
//     and the bytes after the break belong to the container's own closing
//     syntax. The unprefixed version of that shape ('[a  \n](u)b') is NOT
//     refused — no prefix character follows the line ending, so there is
//     provably no gap to account for.
//  2. a `break` node whose raw span does not end at a line terminator. No
//     parser output does this; the check is what makes "the bytes after this
//     unit start a new line" a verified premise rather than an assumption.
//
// SOFT BREAK (D3, 2026-08-26): the hole was never soft-break-proof either, it
// merely moved. `consumeSoftBreak`'s greedy fold is re-verified by the value's
// own next character — but remark ends a `text` node AT the line terminator
// whenever the wrapped line's first inline sibling is NOT text (inlineCode /
// strong / emphasis / link / image / delete / inlineMath / html). The prefix
// bytes then lie in the gap between that node's end and the sibling's start,
// there is no decoded character left to re-verify against, and the greedy
// consume overshot the node's own `position.end.offset`:
//
//   'a b\n  `c` d'   text[0,4) inlineCode[6,9) text[9,11)  -> null (whole block)
//   'a b\n`c` d'     (no prefix)                           -> ok
//   'a b\n  c d'     (plain-text continuation, ONE node)   -> ok
//
// '- a b\n  `c` d' and '> a b\n> **c** d' are the everyday spellings: any
// wrapped list item or quoted paragraph whose continuation line opens with
// code/bold/a link was wholly read-only. The fix is this same function, called
// for the soft break's line-ending span — the fold is proven against the next
// sibling's own start offset, never consumed on faith — so the two break kinds
// ask ONE question and get ONE proof. Both refusals above carry over verbatim:
// a soft break ending a container's last text node with prefix bytes after it
// ('> [a\n> ](u)b') still fails closed, and so does a gap holding any byte a
// container prefix cannot be made of.
//
// CORRECTION (2026-08-26) — what this paragraph originally claimed, that "the
// two break kinds cannot drift apart again", overstated the code. The fold is
// a property of the CALL, not of this function: `nextSibling` is OPTIONAL, and
// a caller that omits it gets the pre-D3 fail-closed answer with no diagnostic
// — this function cannot tell "there is no sibling" from "the caller did not
// look". When the claim was written, only ONE of three callers passed one:
//   * `collectUnits` (below) — passed `children[i]`, which is why plain typing
//     in those shapes started working;
//   * `highlight-syntax.js` `offsetTables` — did NOT, so '- ==x== a b\n  `c` d'
//     produced no `highlight` node at all and the block still held 4 visible
//     characters more than ProseMirror: read-only, for the same bytes D3 had
//     just made typable;
//   * `commands/review-markup.js` `proveInlineTextSplice` — did NOT (its
//     `textNodeContaining` returned the node without its sibling), so a review
//     wrap in '- a b\n  `c` d' refused 'unsupported-structure' while ordinary
//     typing in that very paragraph succeeded.
// All three pass it now, each pinned by its own suite: the nested-continuation
// section of scripts/test-source-kernel-highlight-consistency.mjs and case 4b
// of scripts/test-source-kernel-review.mjs. The accurate invariant is the
// narrower one — EVERY caller that wants a text node's units owes it the
// following sibling — so a FOURTH caller would reintroduce the same silent
// hole. The call-site census at the end of
// scripts/test-source-kernel-highlight-consistency.mjs pins exactly that: it
// enumerates every module importing `textUnits` and fails if any call site
// omits the third argument.
const isContinuationPrefixChar = (ch) => ch === ' ' || ch === '\t' || ch === '>'

function continuationFoldEnd(text, breakStart, breakEnd, nextSibling) {
  if (!Number.isInteger(breakStart) || !Number.isInteger(breakEnd) || breakEnd <= breakStart) return null
  const last = text[breakEnd - 1]
  if (last !== '\n' && last !== '\r') return null
  const nextStart = nextSibling?.position?.start?.offset
  if (!Number.isInteger(nextStart)) {
    // No following sibling to prove against: accept only when there is
    // provably no continuation prefix at all (the very next byte cannot be
    // part of one).
    return isContinuationPrefixChar(text[breakEnd]) ? null : breakEnd
  }
  if (nextStart < breakEnd) return null
  for (let i = breakEnd; i < nextStart; i += 1) {
    if (!isContinuationPrefixChar(text[i])) return null
  }
  return nextStart
}

// Exported (Plan 5 Task 3) so highlight-syntax.js can derive a `text` node's
// decoded-index -> raw-offset tables from the SAME walk the character map
// itself uses. A highlight's byte span must be provable by exactly the rules
// that already prove every other unit (escape / character reference / soft
// break with its continuation prefix / astral pair), not by a second,
// parallel decoder.
//
// `nextSibling` (D3, 2026-08-26) is the mdast node that FOLLOWS this text node
// in its parent's children — the only thing that can prove where a trailing
// soft break's continuation prefix ends (see `continuationFoldEnd`). It is
// OPTIONAL: omitting it does not change any other unit, it only keeps the
// cross-node fold unprovable, which is the same fail-closed answer the caller
// got before the parameter existed.
export function textUnits(text, node, nextSibling = null) {
  const value = String(node.value ?? '')
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  const units = []
  let r = start
  let v = 0
  // The furthest raw byte this node's units may reach. Normally the node's own
  // end; a PROVEN cross-node continuation fold is the one thing allowed to move
  // it, and only as far as the next sibling's own start offset.
  let rawLimit = end
  while (v < value.length) {
    const cp = value.codePointAt(v)
    const ch = String.fromCodePoint(cp)

    if (ch === '\n' || ch === '\r') {
      // ONE line ending — whatever its spelling — is ONE width-1 `linebreak`
      // unit (CRLF widening, 2026-08-21). remark keeps a soft break's bytes
      // verbatim in the value ('\n', '\r\n', or lone '\r'), but ProseMirror
      // holds exactly ONE character for it, so counting the '\r' of a CRLF
      // pair as its own `char` unit made `visibleLength` exceed
      // `content.size` by one per soft break and every CRLF soft-wrapped
      // block degraded to read-only (the everyday shape: a list item
      // wrapping onto a continuation line). The unit spans the whole ending
      // plus the continuation prefix; `ending` records the VALUE spelling so
      // highlight-syntax.js's `offsetTables` can advance its value index by
      // the true number of value chars (width is always the DECODED width, 1).
      const pair = ch === '\r' && value[v + 1] === '\n'
      const ending = pair ? '\r\n' : ch
      // The raw bytes must spell the ending exactly as the value does — a
      // divergence (e.g. a value ending in a lone '\r' while the raw
      // continues '\r\n') would silently claim the block-final ending's
      // bytes, so it fails closed instead.
      if (!text.startsWith(ending, r)) return null
      if (ch === '\r' && !pair && text[r + 1] === '\n') return null
      const next = consumeSoftBreak(text, r)
      if (next === null) return null
      let unitEnd = next
      if (next > end) {
        // The greedy fold ran past this text node's own end: the prefix bytes
        // sit in the gap before the next inline sibling, so the value cannot
        // re-verify them. Prove the fold instead (`continuationFoldEnd`) —
        // and only for a break that ENDS the value, because with decoded
        // characters still to come, a fold reaching the sibling's start would
        // hand them the SIBLING's bytes to match against.
        if (v + ending.length !== value.length) return null
        const proven = continuationFoldEnd(text, r, r + ending.length, nextSibling)
        if (proven === null) return null
        unitEnd = proven
        rawLimit = Math.max(rawLimit, proven)
      }
      units.push({ rawStart: r, rawEnd: unitEnd, width: 1, kind: 'linebreak', ending })
      r = unitEnd
      v += ending.length
      continue
    }

    if (text[r] === '\\' && ch.length === 1 && text[r + 1] === ch) {
      units.push({ rawStart: r, rawEnd: r + 2, width: 1, kind: 'escape' })
      r += 2
      v += 1
      continue
    }

    if (text[r] === '&') {
      const entity = decodeEntity(text.slice(r, end))
      if (entity && value.startsWith(entity.decoded, v)) {
        units.push({
          rawStart: r,
          rawEnd: r + entity.rawLength,
          width: entity.decoded.length,
          kind: 'entity'
        })
        r += entity.rawLength
        v += entity.decoded.length
        continue
      }
    }

    if (text.startsWith(ch, r)) {
      units.push({ rawStart: r, rawEnd: r + ch.length, width: ch.length, kind: 'char' })
      r += ch.length
      v += ch.length
      continue
    }

    // raw source at `r` doesn't match the decoded value at `v` by any known
    // rule (escape/entity/literal) — can't prove alignment, fail closed.
    return null
  }
  return r <= rawLimit ? units : null
}

// Per-value-char units for an mdast `inlineCode` node (P4-3.5). The node has
// no children — its text lives in `.value` — and its position spans the
// backtick runs. Open/close run widths come from counting the literal
// backtick runs off the raw slice (mark-map.js's exported
// `rangeFromInlineCode`, the same algorithm `inlineMarkAt` uses). CommonMark
// can normalize the value relative to the raw content bytes; probed against
// this repo's real parser (2026-08-16):
//   `code`      -> value 'code'  (raw content === value, the common case)
//   ` x `       -> value 'x'     (ONE leading + trailing space stripped when
//                                 both edges are spaces and the content has
//                                 non-space — `` ` `` (literal backtick via
//                                 padding) is the everyday instance)
//   `  x  `     -> value ' x '   (still exactly one space per edge)
//   `  ` (all-space) -> kept verbatim (no strip)
//   `x\ny`      -> value 'x\ny'  (line endings are KEPT in the mdast value,
//                                 NOT converted to spaces — raw === value)
//   `\nx `      -> value 'x'     (an EDGE line ending strips like a space;
//                                 this shape diverges from the space-pad rule
//                                 below and fails closed)
// Proof contract: the raw content slice must equal the value exactly, or
// equal ' ' + value + ' ' (the one verifiable CommonMark space-strip). Any
// other divergence returns null — the block (and, per the projection map's
// convention for prose blocks, the whole map) fails closed rather than
// guessing an alignment.
function inlineCodeUnits(text, node) {
  const range = rangeFromInlineCode(node, text)
  if (!range) return null
  const value = String(node.value ?? '')
  const slice = text.slice(range.contentRange.from, range.contentRange.to)
  let r
  if (slice === value) r = range.contentRange.from
  else if (slice === ' ' + value + ' ') r = range.contentRange.from + 1
  else return null
  const units = []
  let v = 0
  while (v < value.length) {
    const ch = String.fromCodePoint(value.codePointAt(v))
    units.push({ rawStart: r, rawEnd: r + ch.length, width: ch.length, kind: 'char' })
    r += ch.length
    v += ch.length
  }
  return units
}

// `gaps` (P4-3.5, Fix B): records, for every recursed container child
// (strong/emphasis/delete/link/…) and every inlineCode span, where its
// marker-syntax gap bytes sit — `starts.get(firstUnitRawStart) ===
// nodeStartRaw` and `ends.get(lastUnitRawEnd) === nodeEndRaw`. Backs
// `rawNeutralInsert` below (the "a PLAIN insert at a marker boundary lands
// OUTSIDE the markers" resolver). An outer container is recorded after its
// inner child returns, overwriting the same key; `rawNeutralInsert`'s chase
// loop follows nesting either way.
function collectUnits(text, node, gaps = null) {
  const units = []
  const recordGaps = (child, inner) => {
    if (!gaps || !inner.length) return
    const s = child.position?.start?.offset
    const e = child.position?.end?.offset
    if (Number.isInteger(s) && s < inner[0].rawStart) gaps.starts.set(inner[0].rawStart, s)
    if (Number.isInteger(e) && e > inner[inner.length - 1].rawEnd) {
      gaps.ends.set(inner[inner.length - 1].rawEnd, e)
    }
  }
  const children = node.children || []
  // Same question the editor's coalescer asks of each container: has
  // `brToBreakRemarkPlugin` already turned this node's `<br>` html children
  // into `break` nodes? Every container the kernel reaches here (paragraph /
  // heading / tableCell, then emphasis / strong / delete / link on recursion)
  // is in the set, so this is `true` in practice — but `linkReference` is not,
  // and passing the flag rather than hardcoding `true` keeps the kernel's runs
  // identical to the editor's for that shape too, instead of relying on
  // "Milkdown throws on linkReference anyway".
  const breakHtmlCuts = BREAK_REWRITE_PARENTS.has(node.type)
  let i = 0
  while (i < children.length) {
    // Coalesced inline-HTML fragment (Plan 5 Task 2): the editor chain's
    // `remarkMergeInlineHtml` turns `<span>`,`x`,`</span>` into ONE inline
    // `html` atom, so ProseMirror counts the whole fragment as 1. Emit the
    // matching single width-1 atom unit here, spanning the FIRST node's
    // position.start to the LAST node's position.end — the run's members are
    // contiguous siblings in the raw source, so that span is exactly the
    // fragment's bytes (verified per shape in
    // scripts/test-source-kernel-charmap.mjs). Shapes the editor does NOT
    // merge (a lone `<br/>`, an unbalanced `<span>x`, a run containing
    // emphasis/inline math/a hard break) return `null` from `inlineHtmlRunAt`
    // and fall through to the per-child path below, where each `html` node is
    // its own atom — which is also what the editor leaves in PM. One shared
    // rule, so the two chains cannot drift.
    const run = inlineHtmlRunAt(children, i, breakHtmlCuts)
    if (run) {
      const s = children[i].position?.start?.offset
      const e = children[run.end - 1].position?.end?.offset
      if (!Number.isInteger(s) || !Number.isInteger(e)) return null
      units.push({ rawStart: s, rawEnd: e, width: 1, kind: 'atom' })
      i = run.end
      continue
    }
    const child = children[i]
    i += 1
    if (ATOMS.has(child.type)) {
      const s = child.position?.start?.offset
      const e = child.position?.end?.offset
      if (!Number.isInteger(s) || !Number.isInteger(e)) return null
      // A `break` (hard break) is the one atom whose raw span ends at a LINE
      // ENDING, so its unit has to swallow the next line's continuation prefix
      // the way a soft break's does — see `continuationFoldEnd` above for the
      // proof and the refused shapes. `children[i]` is the following sibling:
      // `i` was already advanced past `child`.
      const rawEnd = child.type === 'break'
        ? continuationFoldEnd(text, s, e, children[i])
        : e
      if (rawEnd === null) return null
      units.push({ rawStart: s, rawEnd, width: 1, kind: 'atom' })
    } else if (child.type === 'text') {
      // `children[i]` is the following sibling (`i` was already advanced past
      // `child`) — the offset a trailing soft break's continuation fold is
      // proven against, exactly as for the hard break above.
      const t = textUnits(text, child, children[i])
      if (!t) return null
      units.push(...t)
    } else if (child.type === 'inlineCode') {
      const t = inlineCodeUnits(text, child)
      if (!t) return null
      recordGaps(child, t)
      units.push(...t)
    } else if (child.children) {
      const inner = collectUnits(text, child, gaps)
      if (!inner) return null
      recordGaps(child, inner)
      units.push(...inner)
    } else {
      // Unknown leaf node type with no `.value` and no `.children` — nothing
      // we can safely map. Fail closed rather than silently dropping it.
      return null
    }
  }
  return units
}

// ADR — selection-range `from` is gap-aware, `visibleToRaw` alone is not
// (both intentional; see below):
//
// `boundaries` records, for each visible index, the rawEnd of whatever unit
// was JUST consumed — correct whenever the next unit's raw bytes pick up
// exactly where the last one left off, but AMBIGUOUS the moment a gap of
// unit-less raw bytes sits between two units. Such gaps exist in this schema
// for a strong/emphasis/delete (or link/…) node's own opening OR closing
// delimiter — `collectUnits` recurses into these nodes' children without
// ever emitting a unit for the marker itself — and, since P4-3.5, for an
// inlineCode span's backtick runs (plus its stripped padding space, when
// present): entering (or leaving) one from/to adjacent content leaves the
// marker's bytes belonging to no unit. `boundaries` resolves that visible index to the position
// BEFORE the gap (end of whatever came before) — correct as a range END
// (content genuinely ends there, the gap is irrelevant to what was just
// consumed) but WRONG as a range START: naively used as `from`, it silently
// folds an existing mark's own delimiter into what should be a
// marker-exclusive selection.
//
// This is not a theoretical concern — it was proven live: for `a **bold**
// b`, selecting the rendered word "bold" (visFrom 2, visTo 6) and replacing
// it via `rawRangeForVisibleRange` used to resolve to raw `[2,8)` (the
// literal bytes `"**bold"`), so typing 'X' over the selection produced
// `a X** b` (the opening marker silently eaten, the closing marker
// orphaned) instead of `a **X** b`. Reachable through ordinary typing over
// a selection in shipped kernel mode (`editor-kernel-gateway.js`'s
// `commitPlainText`, which resolves each step's raw range through this same
// per-block map), not just through mark-toggle commands.
//
// Fix: `startBoundaries` is the mirror table — for each visible index, the
// rawSTART of the unit that begins there (skip-FORWARD past any gap,
// symmetric to how index 0 already had to special-case skipping a LEADING
// gap before any unit existed to record one). `rawRangeForVisibleRange`
// resolves its `from` through this table and its `to` through the original
// (gap-before, content-end-accurate) `boundaries` table — no caller of a
// SELECTION RANGE legitimately wants the old pre-gap `from`; none was found
// depending on it (`replace-text.js`'s `replaceVisibleText`, this task's
// `mark-toggle.js`, and `editor-kernel-gateway.js`'s `commitPlainText` for a
// genuine non-empty selection all want "start strictly after any marker
// that precedes the selected content").
//
// `visibleToRaw` itself is intentionally left with its original semantics
// and is NOT retargeted at `startBoundaries`: it is also used standalone
// (not as a range) for CARET/POSITION queries (e.g.
// `editor-kernel-projection-map.js`'s `pmPosToRaw` for a bare, zero-width
// PM position, and `rawToPmPos`'s own boundary walk) where there is no
// "selection" to reason about, only a single point that may legitimately
// sit on either side of an adjacent gap — changing its contract there is
// out of scope for the range-selection corruption this ADR fixes, and would
// itself risk changing caret-placement/typing-at-a-boundary behavior that
// was never reported as broken. Callers that need the gap-aware start for a
// non-range, single-position use (as `editor-kernel-gateway.js` does for a
// real multi-character selection's `from`, itself not going through this
// module's `rawRangeForVisibleRange`) use `rawStartForVisible` directly.
// Call-count instrumentation (integration review Condition 3, 2026-08-21):
// counts every real per-block map construction so the perf guard can pin a
// deterministic upper bound per keystroke/attach — the lazy-charMap
// optimization's whole point (#4). Read-only; no decision consults it.
let buildCalls = 0
export function getCharacterMapStats() {
  return { buildCalls }
}

export function buildCharacterMap(text, blockNode) {
  buildCalls += 1
  const gaps = { starts: new Map(), ends: new Map() }
  const units = collectUnits(text, blockNode, gaps)
  if (!units) return null

  let visibleLength = 0
  const boundaries = new Map()
  const startBoundaries = new Map()
  const blockStart = blockNode.position?.start?.offset ?? 0
  boundaries.set(0, units[0] ? units[0].rawStart : blockStart)
  startBoundaries.set(0, units[0] ? units[0].rawStart : blockStart)
  for (const unit of units) {
    startBoundaries.set(visibleLength, unit.rawStart)
    visibleLength += unit.width
    boundaries.set(visibleLength, unit.rawEnd)
  }

  const visibleToRaw = (vis) => (boundaries.has(vis) ? boundaries.get(vis) : null)
  const rawStartForVisible = (vis) => (startBoundaries.has(vis) ? startBoundaries.get(vis) : null)

  const rawRangeForVisibleRange = (visFrom, visTo) => {
    if (visFrom === visTo) {
      // Zero-width range (a bare caret insert, e.g. Tab at a paragraph's
      // end or mid-typing at any boundary): neither `rawStartForVisible`
      // (undefined past the LAST unit's own start — nothing "starts" at
      // `visibleLength`, so an end-of-block insert used to refuse outright)
      // nor plain `visibleToRaw` (gap-BEFORE, would land an unmarked insert
      // INSIDE an adjacent mark's closing delimiter) is the right resolver
      // for a genuinely empty range. Resolve BOTH ends through the same
      // insert-neutral point `commitPlainText`'s zero-width path already
      // uses (`rawNeutralInsert`, see its own comment below) — degenerates
      // to the ordinary `visibleToRaw` value at every gap-free boundary
      // (including every interior offset, which always has a unit starting
      // there too), so this only changes behavior exactly at the two shapes
      // that used to fail: block end, and a mark-gap boundary.
      const point = rawNeutralInsert(visFrom)
      if (point === null) return null
      return { from: point, to: point }
    }
    const from = rawStartForVisible(visFrom)
    const to = visibleToRaw(visTo)
    if (from === null || to === null || from > to) return null
    return { from, to }
  }

  // rawNeutralInsert (P4-3.5, Fix B): where must a PLAIN (unmarked) zero-width
  // insert at visible boundary `vis` land in the raw bytes? Neither existing
  // table answers this at a marker-gap boundary:
  //  - `boundaries` (gap-BEFORE) resolves the trailing edge of a mark run to
  //    its content end — a plain char inserted there would land INSIDE the
  //    closing marker ('a **bold**' + X at the run's end -> 'a **boldX**',
  //    silently bolding an unmarked insert; for the inclusive:false inlineCode
  //    mark this contradicts the schema's own "typed char is NOT code" rule).
  //  - `startBoundaries` (gap-AFTER) has the mirrored problem at a leading
  //    edge, and between two adjacent marks BOTH tables put the char inside
  //    one of the runs.
  // The neutral point is "outside every marker that closes at this boundary,
  // before any marker that opens here": chase the recorded mark-node end
  // offsets (`gaps.ends`) from the content-end boundary outward — each hop
  // jumps past one closing marker run; nested marks chain (strictly
  // increasing, so the loop terminates). A boundary with no closing markers
  // chases zero hops and degenerates to the plain `boundaries` value, so
  // unmarked blocks (and every currently-editable shape) resolve EXACTLY as
  // before. Visible index 0 is the mirrored special case: `boundaries[0]` is
  // the first unit's own rawStart (already past any opening markers), so
  // chase `gaps.starts` backwards instead — a block STARTING with a mark run
  // gets the insert before its opening marker ('**a**' + X at 0 ->
  // 'X**a**'), while a heading's `# ` prefix (not a recorded mark gap)
  // stays put.
  const rawNeutralInsert = (vis) => {
    if (vis === 0) {
      if (!units[0]) return blockStart
      let s = units[0].rawStart
      while (gaps.starts.has(s)) s = gaps.starts.get(s)
      return s
    }
    if (!boundaries.has(vis)) return null
    let e = boundaries.get(vis)
    while (gaps.ends.has(e)) e = gaps.ends.get(e)
    return e
  }

  return {
    units,
    visibleLength,
    visibleToRaw,
    rawStartForVisible,
    rawRangeForVisibleRange,
    rawNeutralInsert
  }
}

// True when `rawOffset` sits strictly INSIDE a '\r\n' line ending, i.e. on the
// boundary between the unit holding the '\r' and the `linebreak` unit holding
// the '\n'. Such an offset is byte-legal and genuinely addressable from
// ProseMirror, but structurally indivisible: writing there splits ONE line
// ending into a lone CR plus a separate LF, so a two-line CRLF document
// silently becomes three lines. Every command that resolves a raw offset from
// a character map must refuse it.
//
// Since the CRLF widening (2026-08-21) only a CODE map still exposes that
// boundary: `buildCodeMap` deliberately models a '\r\n' as TWO units (the
// '\r' its own `char` unit — CodeMirror's own Text model needs the per-byte
// addressing, see editor-codeblock-crlf.js). A PROSE map now emits ONE
// width-1 `linebreak` unit for the whole ending (any spelling, plus its
// continuation prefix), so no visible boundary resolves inside the pair at
// all and this predicate is simply unreachable there — the byte-level
// superset below still refuses raw-arithmetic writes in every block kind.
//
// This lives here — in the module that owns the unit model — so the gateway's
// plain-text path (editor-kernel-gateway.js `commitPlainText`) and the pure
// commands under commands/ enforce ONE predicate rather than two copies that
// can drift. Character maps without a `units` array (the projection map's
// `virtualCharMap`, hand-built maps in older tests) can carry no such
// boundary and answer `false`.
//
// The cheap text test is the fast path AND a necessary condition; the unit
// walk is what actually PROVES the offset is that boundary in THIS block's
// map, rather than a '\r\n' that merely happens to sit in surrounding source.
// The BYTE-LEVEL half of the predicate, standing alone (2026-08-17 review,
// Critical 3). `bisectsLineEnding` below needs a character map to prove the
// offset is a real unit boundary in THIS block; `splitsCrlfPair` needs
// nothing but the text, and is therefore a strict SUPERSET of it: every
// offset the map-aware predicate refuses, this one refuses too.
//
// That superset property is what lets `markdown-document.js`'s
// `applySourceTransaction` — the single place every raw-offset write in this
// kernel is applied — enforce the rule BY CONSTRUCTION, with no map in hand.
// Before that chokepoint existed, only three of the five raw-offset write
// paths consulted `bisectsLineEnding`, and a structural Enter at an
// intra-CRLF offset committed 'one\r\ntwo\r\n' -> 'one\r\r\n\r\n\ntwo\r\n'
// (a lone CR plus a bare LF in a uniform-CRLF file).
export function splitsCrlfPair(text, rawOffset) {
  if (typeof text !== 'string' || !Number.isFinite(rawOffset)) return false
  return text.charCodeAt(rawOffset - 1) === 13 && text.charCodeAt(rawOffset) === 10
}

export function bisectsLineEnding(charMap, text, rawOffset) {
  if (!charMap || !splitsCrlfPair(text, rawOffset)) return false
  const units = charMap.units
  if (!Array.isArray(units)) return false
  for (let index = 0; index < units.length - 1; index += 1) {
    const unit = units[index]
    const next = units[index + 1]
    if (unit?.kind !== 'char' || next?.kind !== 'linebreak') continue
    if (unit.rawEnd === rawOffset && next.rawStart === rawOffset) return true
  }
  return false
}
