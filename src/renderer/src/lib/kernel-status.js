// Pure presentation rule for the source kernel's degradation state (P6 Task
// 3). Kept out of StatusBar.jsx so it can be asserted headlessly — the whole
// point of this task is that the indicator must not LIE, and a rule that only
// runs inside JSX can only be checked by a browser session.
//
// Why an indicator exists at all: both kinds of degradation used to be silent.
// A block degraded to `charMap: null` just "won't accept typing", which reads
// as a bug; a whole-document fallback to legacy is completely invisible, and
// legacy is precisely the mode the byte-fidelity bug family lives in. Neither
// is an error — degradation is the correct fail-closed posture — but silence
// about it makes every regression report unattributable.
//
// The counted set is deliberately the SAME predicate `editor-kernel-mode.js`'s
// `degradedPairAt` uses for its per-block toast (a real, non-virtual pair with
// no charMap). Blocks that are non-editable BY CONSTRUCTION (tables' opaque
// fallback, block math, block HTML, image blocks, front matter) are included
// on purpose, because from the user's seat they are the same situation and
// they already raise the same toast. An indicator that disagreed with the
// toast would be worse than no indicator.
//
// `null` means SHOW NOTHING: the kernel is off, still attaching, or disposed.
// A NORMAL document returns a descriptor with `indicator: false` — it has a
// label for the menu ("source kernel active") but must never paint a warning
// mark. A false-positive indicator is worse than silence, so that distinction
// is a return value, not a caller convention.
// ===========================================================================
// THE ONE READ-ONLY PREDICATE (2026-08-20)
// ===========================================================================
// `pairIsReadOnlyToUser` was written for the STATUS COUNT on 2026-08-18, when
// the count's old rule (`!pair.charMap && !pair.virtual` — "a pair the
// projection map refused") was shown to be a statement about the MAP rather
// than about the user: `blockPairs` carries one entry per structural node on
// both sides, CONTAINERS INCLUDED, and a container is never a textblock, so it
// can never claim a charMap. Measured against a real `buildProjectionMap`, a
// two-item bullet list reported THREE read-only blocks (the list plus both
// items) and a blockquote one.
//
// That fix landed in the count and NOT in the toast. `editor-kernel-mode.js`'s
// `degradedPairAt` — the predicate that decides whether a refusal says "this
// paragraph is read-only" or the generic "not supported yet" — kept the old
// rule, and it also took the FIRST matching pair rather than the innermost, so
// it always matched the outermost container first. Measured in the built app
// (2026-08-20): with the caret anywhere inside a bullet list, a refused Tab
// reported 「此段落在内核模式下暂为只读（源码无法证明对应关系）」 about a block whose
// source is fully proven, while the status line said, at the same instant,
// 「本文档中所有能落光标的块都已与 Markdown 源码配对，均可正常编辑」. The two hits
// recorded for that position were `bullet_list` and `list_item`; the paragraph
// the caret was actually in had a charMap. The same gesture in a document of
// plain paragraphs (no container to hit) correctly said "not supported yet".
//
// That is the exact contradiction this file's own header calls worse than no
// indicator, so the rule now lives HERE, once, and both callers use it. It
// takes `isTypable` as a parameter rather than importing it: the inline-shape
// guard lives in editor-kernel-gateway.js (a components/ module), and lib/
// must not depend upward.
//
// `next` is the pair that FOLLOWS `pair` in `blockPairs`, which is in
// pre-order document order — so a pair's first nested pair, if it has one, is
// the very next entry and the containment test is O(1).
export function pairIsReadOnlyToUser(pair, next, isTypable) {
  if (!pair || pair.virtual) return false
  const node = pair.pmNode
  if (!node) return false
  if (node.isTextblock) return pair.charMap ? !isTypable(node) : true
  if (pair.charMap) return false
  const size = node.nodeSize
  if (Number.isFinite(size) && next && Number.isFinite(next.pmPos) &&
      next.pmPos > pair.pmPos && next.pmPos < pair.pmPos + size) {
    return false // a nested pair speaks for this container's interior
  }
  try {
    return !!node.textContent
  } catch {
    return false
  }
}

// The pair a refusal at `pmPos` should be reported AGAINST, or null when no
// block there is read-only to the user (so the caller keeps its generic
// message). Two rules, both of which `degradedPairAt` used to get wrong:
//   * the pair must be read-only BY THE PREDICATE ABOVE, not merely
//     charMap-less — otherwise every container in the document answers yes;
//   * among the pairs whose span contains `pmPos`, the INNERMOST one wins.
//     Pre-order means an enclosing container always comes first, so taking the
//     first match reported the outermost node — a `bullet_list` rather than
//     the paragraph the caret is in.
// Strict containment (`>` / `<`) is deliberate and unchanged: a position at a
// node's own boundary is not inside its content.
export function readOnlyPairAt(blockPairs, pmPos, isTypable) {
  if (!Number.isFinite(pmPos) || !Array.isArray(blockPairs)) return null
  let best = null
  for (let index = 0; index < blockPairs.length; index += 1) {
    const pair = blockPairs[index]
    const size = pair?.pmNode?.nodeSize
    if (!Number.isFinite(size) || !Number.isFinite(pair.pmPos)) continue
    if (pmPos <= pair.pmPos || pmPos >= pair.pmPos + size) continue
    if (!pairIsReadOnlyToUser(pair, blockPairs[index + 1], isTypable)) continue
    if (!best || pair.pmPos >= best.pmPos) best = pair
  }
  return best
}

export function describeKernelStatus(status) {
  const state = status?.state
  if (state === 'legacy') {
    return {
      level: 'legacy',
      indicator: true,
      labelKey: 'kernelStatus.legacy',
      // Reuses the exact message the fallback toast already showed, so the
      // hover detail and the toast cannot drift apart.
      detailKey: status?.reason === 'chunked'
        ? 'kernelMode.unmappableChunked'
        : 'kernelMode.unmappable',
      count: 0
    }
  }
  if (state === 'normal' || state === 'partial') {
    const count = Number.isInteger(status?.readOnlyBlocks) ? status.readOnlyBlocks : 0
    // `partial` is decided by the COUNT, not by the caller's label: a state
    // string that says 'partial' with zero read-only blocks would be the
    // false positive this function exists to prevent.
    if (count > 0) {
      return {
        level: 'partial',
        indicator: true,
        labelKey: 'kernelStatus.partial',
        detailKey: 'kernelStatus.partialDetail',
        count
      }
    }
    return {
      level: 'normal',
      indicator: false,
      labelKey: 'kernelStatus.normal',
      detailKey: 'kernelStatus.normalDetail',
      count: 0
    }
  }
  return null
}
