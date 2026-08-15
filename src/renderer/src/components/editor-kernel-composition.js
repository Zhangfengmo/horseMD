// CompositionSession: bounds one IME composition (pinyin / cangjie / kana /
// …) to a single textblock and settles it into ONE kernel commit (or a
// clean revert) at compositionend/compositioncancel — never a byte-by-byte
// kernel write mid-composition (source-kernel integration Plan 2, Task 6).
//
// Pure module: no electron/react/@milkdown/DOM imports beyond the reconciler
// helper below (itself pure — see editor-kernel-reconciler.js). `getView()`
// returns anything shaped like a live EditorView (`.state.doc`,
// `.state.selection`); `kernel.map.pmPosToRaw` is the ONLY channel this
// module uses to prove a PM position corresponds to a raw source offset,
// same contract as every other proof-first path in editor-kernel-mode.js.
// `commitReplace`/`revertProjection` are injected by the caller
// (editor-kernel-mode.js supplies the real ones, wired to
// kernel.doc/history/the live view) so this module never touches the kernel
// or the view directly — it is driven and asserted against with pure stubs
// in scripts/test-kernel-composition-headless.mjs.
//
// State machine (binding spec, task-6-brief.md):
//  - onStart proves the CURRENT selection's both ends via
//    kernel.map.pmPosToRaw against the PM doc at composition start
//    (`pmBaseDoc`). Success -> session {state:'composing', blockRange,
//    pmBaseDoc}. Failure -> session {state:'invalid'} — the composition is
//    still allowed to run (the browser owns it either way); the revert
//    happens at onEnd, not at onStart. A stray SECOND compositionstart while
//    a session is already open (fast IME/undo replay) silently reverts the
//    stale one first — see onStart below; this is a deliberate, pinned
//    choice (regression-locked), not an accident.
//  - No per-transaction hook exists (matching the onStart/onEnd/onCancel
//    surface): a composition edit that spilled outside the block it started
//    in is detected AT onEnd by diffing `pmBaseDoc` against the live doc
//    (`diffReplaceRange`, reused from the ProjectionReconciler) and checking
//    the diffed range against the `blockRange` captured at onStart.
//  - onEnd: state 'composing' AND the diff is confined to the block ->
//    extract the composed text and call `commitReplace({rawFrom, rawTo,
//    text})` (ONE kernel commit for the whole composition), where rawFrom/
//    rawTo are derived from the DIFF, not from the selection captured at
//    onStart — see the "design-doc deviation" comment at the call site
//    below for why. A falsy `commitReplace` return (kernel refused: stale
//    revision / invalid range / structural reparse failure) is treated
//    exactly like a failed diff: revert, never leave the view showing
//    composed text the kernel did not actually accept. No diff at all
//    (composition produced no net doc change) -> settle with nothing to
//    commit. Otherwise (state 'invalid', the diff spilled outside the
//    block, or the diff can't be mapped back to raw offsets) ->
//    `revertProjection(code)` + a user-facing notification.
//  - onCancel -> revert silently (no notification; compositioncancel is not
//    a proof failure, just an aborted IME session).
//  - settled(): no active session -> resolved immediately. An active
//    session -> a pending promise resolved when onEnd/onCancel finishes
//    (commit or revert). `settleTimeoutMs` (default 3000) is a safety net —
//    a composition that never receives its end/cancel event forces a revert
//    and resolves every waiter; settled() NEVER rejects and NEVER hangs
//    forever (save paths await it).
//  - queueExternal(fn): queued while a session is active, flushed in order
//    right after that session settles; run immediately when no session is
//    active. Mirrors the waiters-Set pattern in
//    src/renderer/src/lib/editor-api-registry.js (never rejects, always
//    resolves/flushes).
import { diffReplaceRange } from './editor-kernel-reconciler.js'

const COMPOSITION_INVALIDATED = 'composition-range-invalidated'

// The textblock (paragraph/heading/list-item text/…) whose PM content range
// [start, end] contains `pos`, walked from the resolved position's own
// depth outward — the same "nearest textblock ancestor" convention
// ProseMirror's own selection classes use.
function resolveTextblockRange(doc, pos) {
  let $pos
  try {
    $pos = doc.resolve(pos)
  } catch {
    return null
  }
  for (let depth = $pos.depth; depth >= 0; depth -= 1) {
    const node = $pos.node(depth)
    if (node.isTextblock) return { start: $pos.start(depth), end: $pos.end(depth) }
  }
  return null
}

export function createCompositionSession({
  getView,
  kernel,
  commitReplace,
  revertProjection,
  notify,
  getT,
  settleTimeoutMs = 3000
}) {
  let session = null // { state: 'composing'|'invalid', pmBaseDoc, blockRange, timer }
  let waiters = []
  let queued = []

  const tOr = (key, fallback) => {
    const value = getT?.(key)
    return !value || value === key ? fallback : value
  }

  const clearTimer = () => {
    if (session?.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }
  }

  // Settle the current session: drop it, resolve every settled() waiter,
  // then flush anything queued during it — in that order, so a queued
  // callback that itself calls settled() sees "no session" immediately.
  const finish = () => {
    session = null
    const pending = waiters
    waiters = []
    for (const resolve of pending) resolve()
    const flushing = queued
    queued = []
    for (const fn of flushing) {
      try {
        fn()
      } catch {
        // A queued callback's own failure is that caller's concern, not the
        // composition session's — it must never block settling the rest.
      }
    }
  }

  const revert = (code) => {
    if (code) {
      notify?.(tOr(
        'kernelMode.compositionReverted',
        'Kernel mode could not confine this input method edit; reverted to the last confirmed text'
      ))
    }
    try {
      revertProjection?.(code)
    } finally {
      finish()
    }
  }

  const commit = () => {
    const view = getView?.()
    const s = session
    if (!view || !s) {
      revert(COMPOSITION_INVALIDATED)
      return
    }
    const currentDoc = view.state.doc
    let diff
    try {
      diff = diffReplaceRange(s.pmBaseDoc, currentDoc)
    } catch {
      diff = undefined
    }
    if (diff === undefined) {
      revert(COMPOSITION_INVALIDATED)
      return
    }
    if (!diff) {
      // No net doc change during the whole composition — nothing to commit,
      // nothing to revert either (the view already matches pmBaseDoc).
      finish()
      return
    }
    if (diff.from < s.blockRange.start || diff.to > s.blockRange.end) {
      revert(COMPOSITION_INVALIDATED)
      return
    }
    // Design-doc deviation (intentional, pinned by a headless test): the
    // brief's literal wording is `commitReplace(session.rawRange,
    // finalText)` — replace exactly the raw range proven from the selection
    // at compositionstart. That is wrong for autocorrect-style IME/input
    // method behavior, where the commit can rewrite text BEFORE a collapsed
    // cursor (e.g. an English autocorrect fixing 'helllo' -> 'hello' as part
    // of committing the word, or an IME revising an already-typed span
    // earlier in the same textblock while composing). `session.rawRange`
    // only covers the selection as it was AT START — it would silently miss
    // that earlier rewrite and commit the wrong raw range. Deriving
    // rawFrom/rawTo from the actual `diff` (still confined to the session's
    // blockRange, checked above) instead captures whatever the composition
    // really changed, so a collapsed start-of-session cursor can still
    // legitimately produce a wide committed range.
    const rawFrom = kernel?.map?.pmPosToRaw?.(diff.from)
    const rawTo = kernel?.map?.pmPosToRaw?.(diff.to)
    if (!Number.isFinite(rawFrom) || !Number.isFinite(rawTo) || rawFrom > rawTo) {
      revert(COMPOSITION_INVALIDATED)
      return
    }
    let text
    try {
      text = currentDoc.textBetween(diff.insertFrom, diff.insertTo, '\n\n', '\n\n')
    } catch {
      revert(COMPOSITION_INVALIDATED)
      return
    }
    let applied
    try {
      applied = commitReplace?.({ rawFrom, rawTo, text })
    } catch {
      applied = false
    }
    if (!applied) {
      // The kernel refused the commit (stale revision / invalid range /
      // structural reparse failure inside editor-kernel-mode.js's
      // applyKernelTransaction). kernel.doc was NOT advanced, but the PM
      // view still shows the composed candidate text — left alone, the next
      // flush/save would silently drop those on-screen characters. Treat
      // this exactly like a failed diff: revert the view back to
      // parse(kernel.doc.text) instead of leaving the desync in place.
      revert(COMPOSITION_INVALIDATED)
      return
    }
    finish()
  }

  const onStart = () => {
    // A stray second compositionstart before a matching end (fast IME/undo
    // replay) must not silently overwrite an in-flight session: close the
    // stale one first, silently (it is not a proof failure). Pinned by a
    // regression case (double-start reverts the stale session, then a fresh
    // one still commits normally).
    if (session) revert(null)

    const view = getView?.()
    if (!view) {
      session = { state: 'invalid', pmBaseDoc: null, blockRange: null, timer: null }
    } else {
      const { from, to } = view.state.selection
      // Proof-of-mappability only: onEnd derives the ACTUAL committed range
      // from the diff (see the "design-doc deviation" comment in commit()
      // above), not from these values — they are not retained on the
      // session, only used to decide 'composing' vs 'invalid'.
      const rawFrom = kernel?.map?.pmPosToRaw?.(from)
      const rawTo = kernel?.map?.pmPosToRaw?.(to)
      const blockRange = resolveTextblockRange(view.state.doc, from)
      const proven = Number.isFinite(rawFrom) && Number.isFinite(rawTo) &&
        rawFrom <= rawTo && !!blockRange
      session = proven
        ? { state: 'composing', pmBaseDoc: view.state.doc, blockRange, timer: null }
        : { state: 'invalid', pmBaseDoc: view.state.doc, blockRange: null, timer: null }
    }
    session.timer = setTimeout(() => {
      if (!session) return
      revert(COMPOSITION_INVALIDATED)
    }, settleTimeoutMs)
  }

  const onEnd = () => {
    if (!session) return
    clearTimer()
    if (session.state !== 'composing') {
      revert(COMPOSITION_INVALIDATED)
      return
    }
    commit()
  }

  const onCancel = () => {
    if (!session) return
    clearTimer()
    revert(null)
  }

  const isActive = () => session !== null

  const settled = () => {
    if (!session) return Promise.resolve()
    return new Promise((resolve) => { waiters.push(resolve) })
  }

  const queueExternal = (fn) => {
    if (typeof fn !== 'function') return
    if (session) {
      queued.push(fn)
    } else {
      fn()
    }
  }

  const dispose = () => {
    clearTimer()
    session = null
    const pending = waiters
    waiters = []
    for (const resolve of pending) resolve()
    queued = []
  }

  return { onStart, onEnd, onCancel, isActive, settled, queueExternal, dispose }
}
