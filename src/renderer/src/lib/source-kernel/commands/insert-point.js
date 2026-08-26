// THE INVERSE OF THE KERNEL'S OWN ZERO-WIDTH INSERT POINT (2026-08-26).
//
// WHAT WAS BROKEN
// ---------------
// Every kernel writer places a PLAIN (unmarked) zero-width insert through ONE
// resolver: the projection map's `pmPosToRawInsert`, which routes through
// character-map.js's `rawNeutralInsert`. That resolver deliberately chases the
// recorded mark gaps so a typed character lands OUTSIDE a mark's delimiters
// ('a **bold**' + X -> 'a **bold**X', never the silently-bolding
// 'a **boldX**'; for `inlineCode`, whose schema mark is `inclusive:false`,
// landing inside would contradict the schema itself).
//
// The committed transaction's selection anchor is then that same byte. But
// `applyKernelTransaction` resolved it back to a PM position with
// `rawToPmPos`, the WRITE resolver, which only accepts a charMap UNIT
// boundary. A mark's delimiter bytes belong to no unit, so an offset just
// outside a closing (or before an opening) delimiter run is not a unit
// boundary and `rawToPmPos` refuses it — correctly, for its own question.
//
// The consequence was that the kernel could write a byte to an offset it could
// not then NAME, and its own `requireMap` guard therefore refused its own
// already-proven commit. Measured 2026-08-26: typing ASCII `**bold**` one key
// at a time lost the 8th keystroke (disk `**bold*`), with diagnostics
// `mark-input-rule-literal-fallback` then `projection-unmappable-refused`; the
// verify's repair lost the caret one keystroke earlier (`caret-unmappable`,
// intent `projection-repair`). CJK `与**粗**` was unaffected only because
// CommonMark's rule of 3 keeps `与**粗*` literal, so that shape never reaches
// the literal fallback at all — which is why a CJK-only test fixture
// (`*斜*与**粗**与…`) let this survive.
//
// WHAT THIS IS
// ------------
// The missing mirror table, and a DERIVATION rather than a nearest-neighbour
// snap. A PM position P is the answer for raw offset R only when
//
//     map.pmPosToRawInsert(P) === R
//
// i.e. only when this kernel's own writer would have placed a plain insert at
// exactly that byte for exactly that position — confirmed by calling that very
// function, so the two can never drift apart into a wrong answer. The match
// must also be UNIQUE across the whole map; an ambiguous offset refuses.
//
// WHAT IT IS NOT
// --------------
// `rawToPmPos` is untouched, so NO raw offset becomes WRITABLE. Only naming an
// ALREADY-WRITTEN byte gets more provable. Everything unprovable still returns
// null and the caller still fails closed:
//   * an offset strictly inside a delimiter run has no preimage;
//   * a DEGRADED pair (Case M4c, `see ==www.a.com== ok`) carries `charMap:
//     null`, so it is skipped — the half of the `requireMap` guard that stops
//     the kernel writing into a paragraph the user could not then edit keeps
//     its full meaning;
//   * a VIRTUAL pair is skipped: the projection map's own ADR records that a
//     virtual pair's raw anchor is byte-ambiguous with a real block's end, so
//     that decision must be made by PM position, never by raw offset;
//   * a code map has no marker gaps, hence no gap-chasing insert point to
//     invert; its boundaries are already unit boundaries `rawToPmPos` serves.
//
// COST. Only pairs whose mdast block span CONTAINS the offset are considered,
// and the span check reads `mdBlock.position` without materializing a deferred
// charMap — the same pre-filter `rawToPmPos` uses. Editable textblock spans do
// not overlap, so at most a couple of pairs are ever materialized, and this
// runs only AFTER `rawToPmPos` has already refused (which materialized that
// pair anyway). The per-pair scan is linear over one block's visible length;
// deliberately not a binary search, because `rawNeutralInsert`'s monotonicity
// is not proven by the module that owns it and assuming it would be assuming
// more.

// Mirrors `pmPosToRawInsert`'s own two-branch resolution (projection map):
// charMap shapes without the gap-aware resolver (buildCodeMap, virtualCharMap)
// have no markers and fall back to the plain boundary table. Used only to
// generate CANDIDATES — every candidate is then confirmed through
// `map.pmPosToRawInsert` itself, so a drift between the two makes the resolver
// refuse, never answer wrongly.
const candidateRawInsert = (charMap, vis) => {
  if (typeof charMap.rawNeutralInsert === 'function') return charMap.rawNeutralInsert(vis)
  if (typeof charMap.visibleToRaw === 'function') return charMap.visibleToRaw(vis)
  return null
}

/**
 * PM position whose plain zero-width insert point is exactly `raw`, or null.
 * Never a snap: the answer is confirmed through the writer's own resolver.
 */
export function pmPosForRawInsertPoint(map, raw) {
  if (!map || !Number.isFinite(raw)) return null
  if (typeof map.pmPosToRawInsert !== 'function') return null
  const pairs = Array.isArray(map.blockPairs) ? map.blockPairs : null
  if (!pairs) return null

  const candidates = []
  for (const pair of pairs) {
    if (!pair || pair.virtual) continue
    const start = pair.mdBlock?.position?.start?.offset
    const end = pair.mdBlock?.position?.end?.offset
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue
    if (raw < start || raw > end) continue
    // Eager pairs whose proofs failed (charMap null) are non-editable and are
    // skipped WITHOUT touching `.charMap` on a deferred pair — same order as
    // `rawToPmPos`, so no extra materialization happens here.
    if (!pair.deferred && !pair.charMap) continue
    const { charMap } = pair
    if (!charMap || !Number.isInteger(charMap.visibleLength)) continue
    const contentPos = pair.pmPos + 1
    for (let vis = 0; vis <= charMap.visibleLength; vis += 1) {
      if (candidateRawInsert(charMap, vis) === raw) candidates.push(contentPos + vis)
    }
  }

  // Exactly one PM position may claim the byte. Zero -> unprovable; more than
  // one -> genuinely ambiguous, and an ambiguous position is not a derivation.
  if (candidates.length !== 1) return null
  const pos = candidates[0]
  if (map.pmPosToRawInsert(pos) !== raw) return null
  // An INSERT point is a boundary between units by construction — it is never
  // an atom's own identity (that offset is a unit rawStart, which `rawToPmPos`
  // serves and `resolveCommittedRawOffset` below asks about first).
  return { pos, atom: false }
}

/**
 * The resolver `applyKernelTransaction` (and the verify's repair) must use for
 * a COMMITTED source transaction's selection offset: first the write resolver
 * — the byte may well be an ordinary unit boundary — and only then the inverse
 * of the writer's own insert point above. Ordering matters: `rawToPmPos` is
 * the authority on unit boundaries (including atom identity), and this keeps
 * its answers byte-for-byte unchanged.
 */
export function resolveCommittedRawOffset(map, raw) {
  if (!map || !Number.isFinite(raw)) return null
  const direct = map.rawToPmPos?.(raw)
  if (direct) return direct
  return pmPosForRawInsertPoint(map, raw)
}
