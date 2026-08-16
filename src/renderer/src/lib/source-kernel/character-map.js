// SourceCharacterMap: character-level boundary mapping between "visible"
// (decoded) text and raw source bytes, anchored to mdast node positions.
//
// This module is pure: no Electron/React/@milkdown imports (source-kernel
// convention, see syntax-index.js).
//
// Fail-closed contract: any block this module can't PROVE a lossless mapping
// for returns `null` from buildCharacterMap — callers must not guess.
import { decodeNamedCharacterReference } from 'decode-named-character-reference'

// Inline "atom" nodes: entire node is one indivisible visible unit — a caret
// may sit on either edge but never inside. Phase 1 needs only nodes whose
// raw span is meaningfully different from a simple decoded-text run.
const ATOMS = new Set([
  'inlineCode', 'image', 'imageReference', 'break', 'footnoteReference', 'html'
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

function textUnits(text, node) {
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

function collectUnits(text, node) {
  const units = []
  for (const child of node.children || []) {
    if (ATOMS.has(child.type)) {
      const s = child.position?.start?.offset
      const e = child.position?.end?.offset
      if (!Number.isInteger(s) || !Number.isInteger(e)) return null
      units.push({ rawStart: s, rawEnd: e, width: 1, kind: 'atom' })
    } else if (child.type === 'text') {
      const t = textUnits(text, child)
      if (!t) return null
      units.push(...t)
    } else if (child.children) {
      const inner = collectUnits(text, child)
      if (!inner) return null
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
// unit-less raw bytes sits between two units. The only place such a gap
// exists in this schema is a strong/emphasis/delete node's own opening OR
// closing delimiter: `collectUnits` recurses into these nodes' children
// without ever emitting a unit for the marker itself, so entering (or
// leaving) one from/to adjacent content leaves the marker's bytes belonging
// to no unit. `boundaries` resolves that visible index to the position
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
  const units = collectUnits(text, blockNode)
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
    const from = rawStartForVisible(visFrom)
    const to = visibleToRaw(visTo)
    if (from === null || to === null || from > to) return null
    return { from, to }
  }

  return { units, visibleLength, visibleToRaw, rawStartForVisible, rawRangeForVisibleRange }
}
