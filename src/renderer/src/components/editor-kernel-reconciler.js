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
// produces either an inverted result: to < from (illegal Node.slice / a
// nonsensical "replace this negative range"). The clamp below is the exact
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
export function reconcileProjection({ view, newDoc, mapMeta = null }) {
  const diff = diffReplaceRange(view.state.doc, newDoc)
  if (!diff) return false

  const { from, to, insertFrom, insertTo } = diff
  const tr = view.state.tr
  tr.replace(from, to, newDoc.slice(insertFrom, insertTo))
  tr.setMeta('sourceProjection', mapMeta || true)
  tr.setMeta('addToHistory', false)
  view.dispatch(tr)
  return true
}
