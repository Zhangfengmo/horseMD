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

// Exported (Plan 5 Task 3) so highlight-syntax.js can derive a `text` node's
// decoded-index -> raw-offset tables from the SAME walk the character map
// itself uses. A highlight's byte span must be provable by exactly the rules
// that already prove every other unit (escape / character reference / soft
// break with its continuation prefix / astral pair), not by a second,
// parallel decoder.
export function textUnits(text, node) {
  const value = String(node.value ?? '')
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  const units = []
  let r = start
  let v = 0
  while (v < value.length) {
    const cp = value.codePointAt(v)
    const ch = String.fromCodePoint(cp)

    if (ch === '\n') {
      const next = consumeSoftBreak(text, r)
      if (next === null || next > end) return null
      units.push({ rawStart: r, rawEnd: next, width: 1, kind: 'linebreak' })
      r = next
      v += 1
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
  return r <= end ? units : null
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
      units.push({ rawStart: s, rawEnd: e, width: 1, kind: 'atom' })
    } else if (child.type === 'text') {
      const t = textUnits(text, child)
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
export function buildCharacterMap(text, blockNode) {
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
