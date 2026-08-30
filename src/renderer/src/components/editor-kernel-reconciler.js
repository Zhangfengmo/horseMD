// ProjectionReconciler: minimal-diff projection replay (source-kernel
// integration Plan 2, Task 4).
//
// Pure module — no electron/react/@milkdown imports. Everything it touches
// (a ProseMirror `doc`/`Node`, an object shaped like a live `EditorView`)
// is passed in by the caller. It has exactly one job: given the kernel's
// current doc and a freshly-reparsed `newDoc`, replace ONLY the smallest
// range that actually differs, so every node OUTSIDE that range keeps its
// PM identity (`node ===` unchanged) — which is what lets PM's node views
// (CodeMirror instances, image widgets, …) skip a rebuild instead of
// tearing down and remounting on every kernel-driven doc replacement.
//
// `diffReplaceRange` is built directly on `Fragment#findDiffStart` /
// `Fragment#findDiffEnd` (prosemirror-model), the same primitives
// prosemirror-view uses internally for its own DOM-vs-doc diffing
// (`domchange.ts`'s `findDiff`). Those two calls can report OVERLAPPING
// regions whenever the changed content shares a repeated affix with its
// surroundings — the textbook case is a run of a single repeated
// character/glyph, e.g. 'aaa' -> 'aaaa': every character in the shorter
// doc is simultaneously a valid match for the "common prefix" scan AND the
// "common suffix" scan, so `findDiffStart` walks past where `findDiffEnd`
// already claims the untouched suffix begins. Left unclamped, that overlap
// can produce an inverted range (to < from, or insertTo < insertFrom) —
// an illegal `Node.slice`/`tr.replace` call, not just a wrong-but-valid
// one. The clamp below is the exact
// shape prosemirror-view's own `findDiff` uses (domchange.ts / bundled
// dist/index.js's `findDiff`, minus its caret-`preferredPos` nudging, which
// only matters for placing the cursor after a live DOM edit and has no
// bearing on a pure doc-to-doc diff):
//   - if the new doc is STRICTLY LARGER (growth/insertion-shaped) and the
//     end-scan's old-side boundary (`endA`) still sits before the
//     start-scan boundary (`start`): the whole overlapping stretch is
//     folded into the "untouched" region — `endA` snaps up to `start`
//     (nothing left to remove on the old side) and `endB` is shifted by the
//     same delta, so the ONLY thing left in the diff is the extra content
//     the new doc grew by.
//   - otherwise (shrink/equal-size-replace-shaped), if the end-scan's
//     NEW-side boundary (`endB`) sits before `start`: symmetric fold on the
//     other side — `endB` snaps up to `start`, `endA` shifts by the same
//     delta, leaving only the content the old doc had that the new one
//     doesn't.
// Both branches are exercised by dedicated growth/shrink CJK-repeat tests
// in scripts/test-kernel-reconciler.mjs (a naive single-sided clamp passes
// the growth case but produces an inverted insertFrom/insertTo range on the
// shrink case — see that file's comments for the concrete numbers).
export function diffReplaceRange(oldDoc, newDoc) {
  if (!oldDoc || !newDoc) return null
  const start = oldDoc.content.findDiffStart(newDoc.content)
  if (start == null) return null

  let { a: endA, b: endB } = oldDoc.content.findDiffEnd(newDoc.content)

  if (endA < start && oldDoc.content.size < newDoc.content.size) {
    endB = start + (endB - endA)
    endA = start
  } else if (endB < start) {
    endA = start + (endA - endB)
    endB = start
  }

  return { from: start, to: endA, insertFrom: start, insertTo: endB }
}

// ===========================================================================
// MULTI-REGION DIFF (the chunk-load repair, 2026-08-21)
// ===========================================================================
// `diffReplaceRange` above answers ONE range, because that is exactly right
// for the hot path: a keystroke changes one place, so the first and the last
// disagreement bracket that one place and nothing else.
//
// The chunked-load repair is the opposite shape. `appendChunks`
// (editor-chunked-parse.js) parses each ~40 KB chunk SEPARATELY, so a
// document that gets cut at N boundaries can disagree with its
// whole-document parse at up to N SCATTERED places. `findDiffStart` /
// `findDiffEnd` then bracket the FIRST and the LAST of them and the single
// range swallows everything in between: measured on a 646 KB concatenation
// of this repo's own docs/, the one-range answer is **90.8 % of the
// document** (13 genuinely-differing regions, first at pos 53 848, last at
// 602 570). Replacing 90 % of a 646 KB document means remounting ~90 % of
// its node views — every CodeMirror, every image, every Mermaid diagram —
// which is precisely the freeze the chunked loader exists to avoid.
//
// So the repair walks the two documents' TOP-LEVEL children and resyncs
// after each disagreement, emitting one region per disagreement. Same
// corpus: 13 regions, **7.8 %** touched. On the synthetic chunk-trap corpus
// (a loose list straddling every chunk boundary — the canonical shape) it is
// 2 regions and **0.14 %** at 400 KB.
//
// The resync is an expanding-radius search: for a total displacement `d`,
// every split of `d` into (skip `da` old nodes, skip `db` new ones) is tried
// in turn, and the first split whose nodes line up again wins — so the
// smallest number of nodes that can explain the disagreement is the number
// replaced. A single match is not enough to resync on (a document is full of
// repeated paragraphs); the NEXT pair must line up too. Nothing is assumed
// about WHERE the disagreements are: chunk boundaries are never consulted,
// which is what keeps this a proof about two documents rather than a bet on
// the loader's arithmetic (see the rejected-mirroring ADR in
// editor-kernel-mode.js).
function findResync(a, b, i, j, lookahead) {
  for (let d = 1; d <= lookahead; d += 1) {
    for (let da = 0; da <= d; da += 1) {
      const db = d - da
      const ia = i + da
      const jb = j + db
      if (ia > a.length || jb > b.length) continue
      // Both sides exhausted together: the tail itself is the region.
      if (ia === a.length && jb === b.length) return { da, db }
      if (ia >= a.length || jb >= b.length) continue
      if (!a[ia].eq(b[jb])) continue
      // Confirm with the NEXT pair so a single repeated paragraph cannot
      // fake a resync. Running off either end counts as confirmation.
      const nextA = ia + 1
      const nextB = jb + 1
      if (nextA >= a.length || nextB >= b.length || a[nextA].eq(b[nextB])) return { da, db }
    }
  }
  return null
}

// One disagreement, expressed as a replace range: `from`/`to` in OLD-document
// coordinates, `insertFrom`/`insertTo` in NEW-document coordinates. When a
// region is exactly one old node against one new node of IDENTICAL markup
// (same type, attrs and marks — so the difference is purely interior), the
// range is narrowed one level with `diffReplaceRange`, which is why a
// 2 535-wide bullet list that gained one item costs ~7 positions and not
// 2 535. Differing markup is NOT narrowed: attrs live on the node, and
// replacing only its content would leave the old attrs in place.
function regionFor(a, b, i, j, da, db, posA, posB, sizeA, sizeB) {
  if (da === 1 && db === 1 && !a[i].isLeaf && a[i].sameMarkup(b[j])) {
    const inner = diffReplaceRange(a[i], b[j])
    if (inner) {
      return {
        from: posA + 1 + inner.from,
        to: posA + 1 + inner.to,
        insertFrom: posB + 1 + inner.insertFrom,
        insertTo: posB + 1 + inner.insertTo,
        nodesFrom: da,
        nodesTo: db
      }
    }
  }
  return {
    from: posA,
    to: posA + sizeA,
    insertFrom: posB,
    insertTo: posB + sizeB,
    nodesFrom: da,
    nodesTo: db
  }
}

// Disjoint, ascending replace regions turning `oldDoc` into `newDoc`.
// Returns `[]` when the two documents are already equal — a genuine no-op the
// caller can treat as "nothing to repair".
export function diffReplaceRegions(oldDoc, newDoc, { lookahead = 400 } = {}) {
  if (!oldDoc || !newDoc) return []
  const a = []
  oldDoc.forEach((node) => a.push(node))
  const b = []
  newDoc.forEach((node) => b.push(node))
  const regions = []
  let i = 0
  let j = 0
  let posA = 0
  let posB = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].eq(b[j])) {
      posA += a[i].nodeSize
      posB += b[j].nodeSize
      i += 1
      j += 1
      continue
    }
    // No resync inside the window: replace everything that is left. Coarse,
    // but still CORRECT — and it is the branch that must never be silently
    // mistaken for a minimal one, so callers get `nodesFrom`/`nodesTo` and
    // can budget on them.
    const sync = findResync(a, b, i, j, lookahead) || { da: a.length - i, db: b.length - j }
    let sizeA = 0
    for (let k = 0; k < sync.da; k += 1) sizeA += a[i + k].nodeSize
    let sizeB = 0
    for (let k = 0; k < sync.db; k += 1) sizeB += b[j + k].nodeSize
    regions.push(regionFor(a, b, i, j, sync.da, sync.db, posA, posB, sizeA, sizeB))
    posA += sizeA
    posB += sizeB
    i += sync.da
    j += sync.db
  }
  return regions
}

// Apply `diffReplaceRegions`' answer to a live view in ONE transaction.
//
// Regions are applied BACK TO FRONT: every region's coordinates were computed
// against the original document, and a replace at a higher position cannot
// move a lower one, so no position mapping is needed (and none is done — a
// mapped position would be a second, unproven derivation of the same range).
//
// Same two metas as `reconcileProjection`: `sourceProjection` so the gateway
// never reads the repair as a user edit, and `addToHistory: false` so undo
// after attach cannot step backwards into the load.
export function reconcileProjectionRegions({ view, newDoc, regions, mapMeta = null }) {
  if (!regions || !regions.length) return 0
  const tr = view.state.tr
  for (let k = regions.length - 1; k >= 0; k -= 1) {
    const region = regions[k]
    tr.replace(region.from, region.to, newDoc.slice(region.insertFrom, region.insertTo))
  }
  tr.setMeta('sourceProjection', mapMeta || true)
  tr.setMeta('addToHistory', false)
  view.dispatch(tr)
  return regions.length
}

// reconcileProjection: applies the minimal-diff replace to a live view.
// `view` only needs `.state` (a real EditorState, so `.tr`/`.doc` work) and
// a `.dispatch(tr)` method — it is never required to be a real
// `EditorView`, which is what lets tests use a plain stub.
//
// No diff -> no dispatch, returns `false` (a true no-op: the caller can
// treat "false" as "nothing changed, don't bump any revision/version
// counters"). A real diff builds ONE `tr.replace(from, to, slice)`, tags it
// with `sourceProjection` meta (the gateway's Task 3 `classifyTransactions`
// checks this meta FIRST, ahead of drop/composition/plain-text — see
// editor-kernel-gateway.js) so the projection round-trip is never
// misclassified as a user edit, and `addToHistory: false` so replaying the
// kernel's canonical text back into PM never pollutes undo/redo with a
// synthetic step. `mapMeta` (when provided) rides along under the same
// `sourceProjection` key instead of a bare `true`, letting the caller stash
// whatever provenance (e.g. the raw transaction that produced this
// projection) downstream consumers of the meta might want.
//
// `decorateTransaction` (when provided) runs on the built transaction right
// before dispatch — the sanctioned hook for a caller to put a SELECTION on
// the SAME transaction that changes the doc. This matters for async node
// views (Crepe's Vue-rendered list-item blocks): a doc-change dispatch
// followed by a SEPARATE selection-only dispatch leaves the DOM caret
// behind whenever the selection targets content whose node-view DOM has not
// mounted yet, and PM's DOM observer then drags the state selection back to
// the stale DOM caret — the "typed text lands in the wrong block" family
// (Task 11 Bug 3). One transaction carrying both the content change and the
// selection is exactly how PM's own commands behave, and the DOM caret
// follows correctly. Kept as a callback (not a position parameter) so this
// module stays free of prosemirror-state imports.
// Nearest `table` ancestor of a resolved position: its span, the row index
// the position sits in (null when the position is at the table's own child
// boundary — i.e. BETWEEN rows), and whether it is deeper than the row
// (inside a cell).
function tableLocusAt($pos) {
  for (let depth = $pos.depth; depth >= 1; depth -= 1) {
    if ($pos.node(depth).type.name === 'table') {
      return {
        start: $pos.before(depth),
        end: $pos.after(depth),
        row: $pos.depth > depth ? $pos.index(depth) : null,
        insideCell: $pos.depth > depth + 1
      }
    }
  }
  return null
}

// The pathological shape: the range's ends sit in DIFFERENT rows and at
// least one is inside a cell — the deep-open slice then crosses a row
// boundary mid-cell. Row-boundary-aligned multi-row replaces (add/delete
// row) and same-row/cell edits are the historically safe shapes and stay
// minimal.
function crossesRowsInsideCells(a, b) {
  if (!a || !b) return false
  if (a.row === null && b.row === null) return false
  if (a.row === b.row && a.start === b.start) return false
  return a.insideCell || b.insideCell
}

// A minimal replace range whose ends land INSIDE table cells produces a
// deep-open slice across row boundaries; ProseMirror's replace fitting can
// then close rows with the wrong cell count and prosemirror-tables'
// fixTables pads the ragged rows with empty cells (measured on the row
// drag-reorder: bytes right, view grew a third column). Widening each end
// that sits inside a table to that table's NODE boundary makes the replace
// node-level — one valid table swaps for another, nothing to pad. The
// start widening is symmetric by construction (both docs are identical
// before `start`, so the table starts coincide); each end widens against
// its own document.
export function widenReplaceForTables(oldDoc, newDoc, diff) {
  let { from, to, insertFrom, insertTo } = diff
  const startOld = tableLocusAt(oldDoc.resolve(from))
  const endOld = tableLocusAt(oldDoc.resolve(to))
  const startNew = tableLocusAt(newDoc.resolve(insertFrom))
  const endNew = tableLocusAt(newDoc.resolve(insertTo))
  // Only the pathological shape widens — a whole-table replace remounts the
  // table-block component, so the safe shapes must keep their cheap minimal
  // range.
  if (!crossesRowsInsideCells(startOld, endOld) && !crossesRowsInsideCells(startNew, endNew)) {
    return diff
  }
  // Start: everything before `from` (=== `insertFrom`) is a shared prefix,
  // so a table containing both starts begins at the same position in both
  // docs — widening reproduces prefix bytes verbatim. Positions differing
  // means structurally different tables: leave that side alone.
  if (startOld && startNew && startOld.start === startNew.start) {
    from = startOld.start
    insertFrom = startNew.start
  }
  // End: everything after `to`/`insertTo` is a shared suffix, so the two
  // table ends must sit the same distance into it for the widened ranges to
  // still describe identical content.
  if (endOld && endNew && endOld.end - to === endNew.end - insertTo) {
    to = endOld.end
    insertTo = endNew.end
  }
  if (from === diff.from && to === diff.to) return diff
  return { from, to, insertFrom, insertTo }
}

export function reconcileProjection({ view, newDoc, mapMeta = null, decorateTransaction = null }) {
  const minimal = diffReplaceRange(view.state.doc, newDoc)
  if (!minimal) return false
  const diff = widenReplaceForTables(view.state.doc, newDoc, minimal)

  const { from, to, insertFrom, insertTo } = diff
  const tr = view.state.tr
  tr.replace(from, to, newDoc.slice(insertFrom, insertTo))
  tr.setMeta('sourceProjection', mapMeta || true)
  tr.setMeta('addToHistory', false)
  if (typeof decorateTransaction === 'function') decorateTransaction(tr)
  view.dispatch(tr)
  return true
}
