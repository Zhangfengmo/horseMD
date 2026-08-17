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
