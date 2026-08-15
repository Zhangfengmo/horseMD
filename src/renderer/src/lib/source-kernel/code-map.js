// SourceCodeMap: character-level boundary mapping between a FENCED CODE
// BLOCK's decoded `.value` and its raw source bytes, prefix-aware (a
// blockquote's `> ` markers / a list item's indentation strip a per-line
// prefix that carries no content, exactly like `markdown-preservation`'s
// QUOTE_PREFIX convention elsewhere in this codebase).
//
// Same charmap-compatible contract as `character-map.js`'s
// `buildCharacterMap`: `{ units, visibleLength, visibleToRaw,
// rawRangeForVisibleRange }`, "front unit's end" boundary convention,
// fail-closed (`null`) on any alignment this module can't prove.
//
// Code content is VERBATIM — unlike prose text (character-map.js's job),
// a fenced code block has no escapes/entities to decode. The only raw/value
// divergence is the per-line PREFIX every content line repeats (derived once
// from the open fence line: the byte string from that line's own start up to
// the fence marker's first byte).
//
// Line terminators are NOT collapsed into a single multi-raw-byte unit —
// remark does not normalize EITHER prose or code line endings (verified
// against the real parser: a CRLF document's `.value`, prose or code,
// literally contains '\r\n' as two separate JS string units, and a lone-CR
// document's `.value` literally contains a bare '\r'). This module follows
// character-map.js's own established convention for the identical situation
// (its `textUnits`, which only special-cases a decoded `ch === '\n'`): a
// '\r' that is the FIRST half of a '\r\n' pair is its own literal 'char'
// unit (verbatim, like any other content byte); only the '\n' (or a lone
// '\r' with no following '\n') triggers the actual line-crossing ('linebreak'
// unit, raw span = the terminator's remaining byte + the next content
// line's prefix). Every unit this module ever produces has width 1 and
// consumes exactly one `value` JS char — this is what keeps `visibleLength`
// equal to `value.length` for ANY line-ending style, matching ProseMirror's
// own un-normalized `content.size` (see editor-kernel-projection-map.js's
// cross-check) rather than manufacturing a false mismatch.
//
// remark's `code` node position spans the OPEN fence line through the CLOSE
// fence line (or the raw end, if the fence is never closed) — this module
// never assumes a closing fence exists; it only ever walks forward from the
// open fence line through however many content lines `.value` accounts for.
//
// CommonMark's "up to N spaces of indentation, whichever are present" rule
// (and a blockquote's optional post-'>' space) can let a content line be
// exactly reproduced by remark using LESS than the open line's own prefix.
// This module does not model that leniency: a content line must reproduce
// the derived prefix BYTE-FOR-BYTE, or the whole block fails closed (null) —
// under-mapping to "not editable" is safe, a silently wrong raw offset is
// not.
//
// This directory (source-kernel) forbids importing electron/react/@milkdown.
import { scanLines } from './syntax-index.js'

function lineIndexAt(lines, offset) {
  let lo = 0
  let hi = lines.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lines[mid].start <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

// Zero-content code block ('```\n```\n'): the only meaningful raw position is
// right after the open fence line's own ending — where a closing fence (or a
// user's first typed line) would begin. No content lines to prefix-check.
// `linePrefix`/`lineEnding` are exposed anyway (Plan 3 Task 4): a first
// multi-line insert into an EMPTY code block still needs to know what to
// expand each `\n` in the inserted text into, and there is no content line
// yet to derive them from — the open fence line's own prefix/ending are the
// only proof available, and are exactly what every content line would have
// to reproduce byte-for-byte once one exists (see the main branch below).
function emptyCodeMap(rawOffset, linePrefix, lineEnding) {
  return {
    units: [],
    visibleLength: 0,
    visibleToRaw: (vis) => (vis === 0 ? rawOffset : null),
    rawRangeForVisibleRange: (from, to) => (
      from === 0 && to === 0 ? { from: rawOffset, to: rawOffset } : null
    ),
    linePrefix,
    lineEnding
  }
}

export function buildCodeMap(text, codeNode) {
  const value = String(codeNode?.value ?? '')
  const start = codeNode?.position?.start?.offset
  const end = codeNode?.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null

  const lines = scanLines(text)
  const openIdx = lineIndexAt(lines, start)
  const openLine = lines[openIdx]
  if (start < openLine.start || start > openLine.end) return null

  // Everything from the open fence line's own start up to the fence
  // marker's first byte: quote markers + indentation. Applied identically,
  // byte-for-byte, to every content line below.
  const prefix = text.slice(openLine.start, start)

  if (value.length === 0) {
    return emptyCodeMap(openLine.end + openLine.ending.length, prefix, openLine.ending || '\n')
  }

  let lineIdx = openIdx + 1
  if (lineIdx >= lines.length) return null
  let line = lines[lineIdx]
  if (!text.startsWith(prefix, line.start)) return null
  // The first content line's own terminator is the canonical `lineEnding`
  // this block's newlines use (buildCodeMap already fails closed, below, if
  // a LATER content line's own ending diverges from what `.value`'s '\n'/
  // '\r' chars predict for it — so a real, provably-mapped block never
  // actually has a mixed-ending interior; only ONE ending style ever reaches
  // the return below). Falls back to the open fence line's own ending for
  // the degenerate "no terminator at all" case (captured before the walk
  // below can mutate `line`).
  const lineEnding = line.ending || openLine.ending || '\n'
  let r = line.start + prefix.length
  let lineContentEnd = line.end
  // True right after this line's '\r' half (of a '\r\n' ending) was consumed
  // as its own literal 'char' unit below — the very next `value` char MUST
  // be the matching '\n', which is what actually crosses into the next
  // line. A dangling true at loop end (a '\r' with nothing after it in
  // `value`) fails closed, same as any other divergence.
  let crlfPending = false

  const units = []
  let v = 0
  while (v < value.length) {
    const ch = value[v]

    if (crlfPending) {
      if (ch !== '\n' || text[r] !== '\n') return null
      lineIdx += 1
      if (lineIdx >= lines.length) return null
      const nextLine = lines[lineIdx]
      if (!text.startsWith(prefix, nextLine.start)) return null
      const rawEnd = nextLine.start + prefix.length
      units.push({ rawStart: r, rawEnd, width: 1, kind: 'linebreak' })
      r = rawEnd
      v += 1
      line = nextLine
      lineContentEnd = line.end
      crlfPending = false
      continue
    }

    if (r === lineContentEnd) {
      // End of this raw line's content: `value`'s next char must encode
      // this line's own terminator, and (once the terminator is fully
      // consumed) the FOLLOWING raw line must reproduce the same prefix —
      // any divergence (a short/mismatched ending, no next line, a content
      // line with less indentation/prefix than the fence) can't be proven
      // aligned, fail closed.
      const ending = line.ending
      if (!ending) return null
      if (ending === '\r\n') {
        // Only the '\r' half is consumed here — see character-map.js's own
        // convention for the identical case (its `textUnits` only
        // special-cases a decoded '\n'; a raw '\r' that precedes it is an
        // ordinary literal char). The '\n' half (crlfPending, above) is what
        // actually performs the line-crossing.
        if (ch !== '\r' || text[r] !== '\r') return null
        units.push({ rawStart: r, rawEnd: r + 1, width: 1, kind: 'char' })
        r += 1
        v += 1
        crlfPending = true
        continue
      }
      // Lone '\n' or lone '\r' ending: a single `value` char performs the
      // whole line-crossing.
      if (ch !== ending || text[r] !== ending) return null
      lineIdx += 1
      if (lineIdx >= lines.length) return null
      const nextLine = lines[lineIdx]
      if (!text.startsWith(prefix, nextLine.start)) return null
      const rawEnd = nextLine.start + prefix.length
      units.push({ rawStart: r, rawEnd, width: 1, kind: 'linebreak' })
      r = rawEnd
      v += 1
      line = nextLine
      lineContentEnd = line.end
      continue
    }

    // Verbatim content char: no escapes/entities, so the raw byte at `r`
    // must be the exact same JS string unit as `value[v]` (per UTF-16 code
    // unit, not per code point — a literal surrogate pair is just two
    // matching units in both strings, needing no special handling here).
    if (text[r] !== ch) return null
    units.push({ rawStart: r, rawEnd: r + 1, width: 1, kind: 'char' })
    r += 1
    v += 1
  }
  // The last content char must land exactly at its line's own end — proves
  // the whole final content line was consumed, not a truncated prefix of it
  // — and there must be no dangling half-consumed '\r\n'.
  if (crlfPending || r !== lineContentEnd) return null

  let visibleLength = 0
  const boundaries = new Map()
  boundaries.set(0, units[0].rawStart)
  for (const unit of units) {
    visibleLength += unit.width
    boundaries.set(visibleLength, unit.rawEnd)
  }

  const visibleToRaw = (vis) => (boundaries.has(vis) ? boundaries.get(vis) : null)
  const rawRangeForVisibleRange = (visFrom, visTo) => {
    const from = visibleToRaw(visFrom)
    const to = visibleToRaw(visTo)
    if (from === null || to === null || from > to) return null
    return { from, to }
  }

  // `linePrefix`/`lineEnding` (Plan 3 Task 4): the exact bytes a NEW `\n`
  // typed into this block's content must expand into — a bare '\n' inserted
  // verbatim would break a quoted/indented fence's per-line prefix contract
  // this whole module exists to prove. Exposed here (not re-derived by
  // callers) because this function is the only place that has already
  // proven `prefix` is byte-for-byte consistent across every content line.
  return { units, visibleLength, visibleToRaw, rawRangeForVisibleRange, linePrefix: prefix, lineEnding }
}
