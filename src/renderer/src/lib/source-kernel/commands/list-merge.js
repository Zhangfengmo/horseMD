// 结构签名 + 「可预测的列表合并」证明：插入一个列表项时，相邻列表按 CommonMark
// 规则与它合并——这不是失败，而是可以事先预测、事后逐项核对的结果。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
//
// WHY THIS MODULE EXISTS
// ----------------------
// `block-insert.js` proves every candidate on two axes: (a) the block at the
// insertion offset is exactly what the command wrote, and (b) the document
// OUTSIDE the rewritten region is structurally identical to the baseline. Axis
// (b) is `outsideSignature`, which lives here because the merge proof below is
// its GENERALIZATION — the same pre-order type+span comparison, run over a
// WIDER region, plus an item-by-item account of what that region became.
//
// THE SHAPE THE PLAIN AXES CANNOT ACCEPT (probed against the kernel's own
// processor, not argued from the spec):
//
//   `- a` / blank / `/task` / blank / `- b`
//
// Writing `- [ ] ` + U+00A0 over the query block does NOT produce a
// standalone one-item list next to two others. CommonMark 0.28 dropped the
// two-blank-lines rule, so a blank line makes a list LOOSE, it does not END
// it: the three lists close into ONE three-item list. Axis (a) then finds
// either a node ending far past the written bytes (merge downward) or no root
// child starting at the insertion offset at all (merge upward), and refuses —
// correctly, because until this module it had no way to tell "the neighbour
// list swallowed my item, exactly as CommonMark says it must" from "the bytes
// I wrote mean something else entirely".
//
// SO THE PROOF PREDICTS THE MERGE AND THEN VERIFIES IT. Byte-exactness stays
// absolute: the command still writes exactly the bytes it claims, and the
// candidate is still fully reparsed. What widens is the ACCEPTED DIFF — from
// "the structure outside my block is identical" to "the structure outside my
// block is identical, and the structure AT my block is precisely the merge
// CommonMark was going to perform":
//
//   * the merged node is a `list` of the expected orderedness, spanning
//     exactly [firstMergedNeighbour.start, lastMergedNeighbour.end + delta);
//   * its items are, in order, the up-neighbour's items (offsets unchanged —
//     they sit entirely before the edit), then the ONE new item spanning
//     exactly the written bytes, then the down-neighbour's items (offsets
//     shifted by the edit's delta);
//   * every neighbour item is compared as a full pre-order subtree signature
//     — type, span, `checked`, `spread`, `ordered`, `start` — so an item that
//     gained a child, lost a checkbox, changed nesting depth or moved by one
//     byte fails;
//   * everything outside the union region is `outsideSignature`-identical.
//
// A merge that involves NEITHER neighbour is not a merge and is refused here
// (the plain axes own that case); a merged list that absorbed a block beyond
// the neighbours fails the span assertion AND shows up as a node missing from
// the candidate's outside signature — caught twice, deliberately.
//
// WHAT IS DELIBERATELY NOT COMPARED, AND WHY (the one real judgement call)
// -----------------------------------------------------------------------
// The MERGED list's own `spread`. Two tight lists joined across a blank line
// become one LOOSE list, and looseness is a property of the list, so it can
// flip from `false` to `true` for items the user never touched. Every OTHER
// spread in the tree — each `listItem.spread`, each NESTED list's `spread` —
// IS compared and must be unchanged (probed: they are; a `listItem` with two
// paragraphs keeps `spread: true`, a nested tight list stays tight).
//
// Accepting the top-level flip is a decision, not an oversight:
//   1. It is what the bytes mean. The user asked for an item next to that
//      list with a blank line's worth of separation; "one loose list" is
//      CommonMark's answer, and a source-authoritative kernel does not get to
//      prefer a different one.
//   2. It is invisible in this editor. mdast's tight and loose items are
//      structurally IDENTICAL (both `listItem > paragraph` — probed), so the
//      projection map pairs the same PM nodes either way; looseness only
//      reappears in an external renderer's `<p>` wrapping.
//   3. Refusing it would refuse the single most common `/task` position in a
//      real document. The 2026-08-21 real-document campaign skipped its whole
//      `/task` step on `docs/handoff-mode-switch.md` because all SEVEN
//      candidate paragraphs neighbour a list.
// The alternative — refuse whenever the flip would occur — is recorded here
// rather than in a report so the next reader can weigh it: it would leave the
// command refusing the majority of real positions in exchange for a
// distinction this editor cannot render.
//
// MARKERS DECIDE WHETHER A MERGE HAPPENS AT ALL (probed): `- a` and `* b` do
// NOT merge, nor do `- a` and `1. b`, nor `1. a` and `1) b` — CommonMark
// starts a new list when the marker character changes. Those shapes therefore
// never reach this module; they pass the PLAIN axes and always have.

// Axis (b): the document OUTSIDE the rewritten region, as a pre-order
// type+span signature with post-region offsets normalized back to baseline
// coordinates. A node that overlaps the region at all is skipped on both
// sides — that is the region each side is allowed to differ in — so any
// absorption across the boundary shows up as a node present on one side and
// absent (or differently spanned) on the other.
//
// Returns null when any node lacks a usable position: an unprovable baseline
// is refused, never treated as "nothing to compare".
export function outsideSignature(tree, regionStart, regionEnd, delta) {
  const parts = []
  let ok = true
  const walk = (node) => {
    if (!ok) return
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      ok = false
      return
    }
    if (start < regionEnd && end > regionStart) return
    const from = start <= regionStart ? start : start - delta
    const to = end <= regionStart ? end : end - delta
    parts.push(`${node.type}:${from}:${to}`)
    for (const child of node.children || []) walk(child)
  }
  for (const child of tree.children || []) walk(child)
  return ok ? parts.join('\n') : null
}

// A full pre-order signature of ONE subtree, offsets shifted by `delta` into
// baseline coordinates. Stricter than `outsideSignature` on purpose: inside
// the merge region the list node is genuinely REBUILT by the parser, so every
// semantic attribute a list construct carries is stated rather than inferred
// from "the bytes did not move". Returns null on an unpositioned node.
function subtreeSignature(node, delta) {
  const parts = []
  let ok = true
  const walk = (current) => {
    if (!ok) return
    const start = current?.position?.start?.offset
    const end = current?.position?.end?.offset
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      ok = false
      return
    }
    parts.push([
      current.type,
      start + delta,
      end + delta,
      current.checked ?? '',
      current.spread ?? '',
      current.ordered ?? '',
      current.start ?? ''
    ].join(':'))
    for (const child of current.children || []) walk(child)
  }
  walk(node)
  return ok ? parts.join('\n') : null
}

// Prove that the candidate differs from the baseline in EXACTLY the predicted
// list merge, and nothing else.
//
// Inputs are all facts the caller already holds: the two documents and their
// parses, the replaced region [start, end), how many bytes were written in
// its place, and the orderedness of the list the caller claims to have
// written one item of.
//
// Answers `null` for "not this shape / not proven" (the caller keeps
// refusing) or `{ item, merged, mergedUp, mergedDown }`, where `item` is the
// newly written list item — handed back so the caller can run its own
// interior shape check on it, exactly as it would on a standalone block.
export function provePredictedListMerge({
  baselineText,
  baselineTree,
  candidateText,
  candidateTree,
  start,
  end,
  insertedLength,
  ordered
}) {
  if (typeof baselineText !== 'string' || typeof candidateText !== 'string') return null
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null
  if (!Number.isInteger(insertedLength) || insertedLength < 0) return null
  const insertedEnd = start + insertedLength
  const delta = insertedLength - (end - start)

  // THE BYTE RELATION, first and unconditionally: the candidate must BE the
  // baseline with exactly [start, end) replaced by `insertedLength` bytes.
  // Everything below is then a statement about what the PARSER did with an
  // honest splice — never about whether the caller handed over an honest one.
  // Stating it here rather than trusting `insertBlockFromQuery` (which does
  // build the candidate by splicing) is what keeps this proof safe to reuse:
  // a future caller that assembles a candidate some other way cannot smuggle
  // a byte past the item comparison, which compares STRUCTURE and would not
  // notice a neighbour whose text changed without moving.
  if (candidateText.length !== baselineText.length + delta) return null
  if (candidateText.slice(0, start) !== baselineText.slice(0, start)) return null
  if (candidateText.slice(insertedEnd) !== baselineText.slice(end)) return null

  const baseChildren = baselineTree?.children || []
  const queryIndex = baseChildren.findIndex(
    (child) => child.position?.start?.offset === start
  )
  if (queryIndex < 0) return null
  if (baseChildren[queryIndex].position?.end?.offset !== end) return null

  // The candidate's root child that COVERS the bytes we wrote. Found by
  // containment rather than by a start offset, because a merge upward moves
  // the node's start to the neighbour's.
  const merged = (candidateTree?.children || []).find((child) => {
    const from = child.position?.start?.offset
    const to = child.position?.end?.offset
    return Number.isInteger(from) && Number.isInteger(to) &&
      from <= start && to >= insertedEnd
  })
  if (!merged || merged.type !== 'list') return null
  if (!!merged.ordered !== !!ordered) return null
  const mergedStart = merged.position.start.offset
  const mergedEnd = merged.position.end.offset

  // Which neighbours the merge claims. A boundary that did NOT move must be
  // exactly the written bytes' own boundary; one that DID must land precisely
  // on the adjacent root child, which must itself be a list of the same
  // orderedness. Anything else is an absorption this command did not predict.
  let up = null
  let down = null
  if (mergedStart !== start) {
    up = queryIndex > 0 ? baseChildren[queryIndex - 1] : null
    if (!up || up.type !== 'list' || !!up.ordered !== !!ordered) return null
    if (up.position?.start?.offset !== mergedStart) return null
  }
  if (mergedEnd !== insertedEnd) {
    down = baseChildren[queryIndex + 1] || null
    if (!down || down.type !== 'list' || !!down.ordered !== !!ordered) return null
    if (down.position?.end?.offset !== mergedEnd - delta) return null
  }
  // No neighbour moved a boundary: this is not a merge, and the plain axes
  // are the only thing entitled to accept it.
  if (!up && !down) return null

  // The item account: up's items, then ours, then down's — same count, same
  // order, each neighbour item byte-identical modulo the edit's shift.
  const items = merged.children || []
  const upItems = up ? (up.children || []) : []
  const downItems = down ? (down.children || []) : []
  if (items.length !== upItems.length + 1 + downItems.length) return null
  for (let i = 0; i < upItems.length; i += 1) {
    // Up-neighbour items sit entirely before the edit, so their offsets are
    // unchanged (delta 0 on both sides).
    const expected = subtreeSignature(upItems[i], 0)
    if (expected === null || expected !== subtreeSignature(items[i], 0)) return null
  }
  for (let i = 0; i < downItems.length; i += 1) {
    // Down-neighbour items sit entirely after the edit: the baseline's
    // offsets shift forward by delta to meet the candidate's.
    const expected = subtreeSignature(downItems[i], delta)
    if (expected === null ||
        expected !== subtreeSignature(items[upItems.length + 1 + i], 0)) {
      return null
    }
  }

  const item = items[upItems.length]
  if (item?.type !== 'listItem') return null
  if (item.position?.start?.offset !== start) return null
  if (item.position?.end?.offset !== insertedEnd) return null
  // The merged list spans exactly the union of what merged, and no more.
  const unionStart = up ? up.position.start.offset : start
  const unionEnd = down ? down.position.end.offset : end
  if (mergedStart !== unionStart || mergedEnd !== unionEnd + delta) return null

  // Axis (b) over the WIDER region: outside the whole merge, nothing changed.
  const before = outsideSignature(baselineTree, unionStart, unionEnd, 0)
  const after = outsideSignature(candidateTree, unionStart, unionEnd + delta, delta)
  if (before === null || after === null || before !== after) return null

  return { item, merged, mergedUp: !!up, mergedDown: !!down }
}
