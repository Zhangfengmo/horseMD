// TDD evidence + regression lock for editor-kernel-composition.js
// (source-kernel integration Plan 2, Task 6).
//
// Hand-built @milkdown/prose Schema + real Node objects, same convention as
// scripts/test-kernel-mode-headless.mjs / test-kernel-reconciler.mjs. This
// module reads `view.state.doc` / `view.state.selection` directly (no
// dispatch protocol — commit/revert are the caller's injected functions, not
// something this module applies to a live view itself), so the stub view is
// just a mutable `{ state: { doc, selection } }`. `commitReplace` /
// `revertProjection` are spies: this file locks WHAT they are called with,
// not what a real editor-kernel-mode.js implementation does with that call
// (that integration is covered by the Task 6 addition to
// test-kernel-mode-headless.mjs).
//
// The diffReplaceRange numbers asserted below (case a's {from:2,to:2,
// insertFrom:2,insertTo:3}, case c's {from:4,to:4,insertFrom:4,insertTo:5},
// and case i's 'hello'->'Hello!' {from:1,to:6,insertFrom:1,insertTo:7}) were
// cross-checked by running the real reconciler against these exact fixtures
// before writing the assertions — not hand-derived blind.
import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { createCompositionSession } from '../src/renderer/src/components/editor-kernel-composition.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' }
  }
})
const p = (s) => schema.node('paragraph', null, s ? schema.text(s) : null)
const doc = (...c) => schema.node('doc', null, c)

// A stub view is just a mutable state bag: onStart/onEnd read
// `.state.doc`/`.state.selection` fresh every call, so a test "composes" by
// mutating `.state.doc` between onStart() and onEnd()/onCancel() — exactly
// like a real EditorView's `.state` swapping between two DOM composition
// events, minus the dispatch machinery (which is out of scope for this pure
// module; see the module header for why).
const makeView = (initialDoc, selection) => ({
  state: { doc: initialDoc, selection: { ...selection } }
})

// pmPosToRaw stub: for a single-block doc whose content spans [1, N+1), the
// raw offset is simply pos-1 (a synthetic 1:1 mapping — this file only needs
// to prove the composition session calls pmPosToRaw with the right PM
// positions and forwards its results, not exercise a real character map).
const linearMap = (contentStart, contentEnd) => ({
  pmPosToRaw: (pos) => (pos >= contentStart && pos <= contentEnd ? pos - contentStart : null)
})

const unmappableMap = { pmPosToRaw: () => null }

const makeHarness = (view, map, extra = {}) => {
  const commitCalls = []
  const revertCalls = []
  const notifications = []
  const session = createCompositionSession({
    getView: () => view,
    kernel: { map },
    commitReplace: (args) => commitCalls.push(args),
    revertProjection: (code) => revertCalls.push(code),
    notify: (message) => notifications.push(message),
    getT: (key) => key,
    ...extra
  })
  return { session, commitCalls, revertCalls, notifications }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

console.log('--- kernel composition headless ---')

// Case (a): start -> PM doc mutates within the session's textblock -> end.
// commitReplace receives the raw range the diff maps to (NOT necessarily the
// selection captured at onStart, though here they coincide) and the final
// composed text; no revert, no notification.
{
  const pmBaseDoc = doc(p('ab'))
  const view = makeView(pmBaseDoc, { from: 2, to: 2 })
  const map = linearMap(1, 3) // paragraph content range [1,3)
  const h = makeHarness(view, map)

  h.session.onStart()
  assert.equal(h.session.isActive(), true)

  // Composition lands '甲' between 'a' and 'b'.
  view.state.doc = doc(p('a甲b'))
  h.session.onEnd()
  await tick()

  assert.equal(h.session.isActive(), false, 'session cleared after a committed end')
  assert.deepEqual(h.commitCalls, [{ rawFrom: 1, rawTo: 1, text: '甲', pmFrom: 2 }])
  assert.deepEqual(h.revertCalls, [])
  assert.deepEqual(h.notifications, [])
}

// Case (b): onStart cannot prove either end of the selection (pmPosToRaw
// refuses) -> session {state:'invalid'}; the composition is still allowed to
// play out in the DOM, but onEnd reverts + notifies rather than committing.
{
  const pmBaseDoc = doc(p('ab'))
  const view = makeView(pmBaseDoc, { from: 2, to: 2 })
  const h = makeHarness(view, unmappableMap)

  h.session.onStart()
  assert.equal(h.session.isActive(), true, 'an unproven session is still open until it settles')

  view.state.doc = doc(p('a甲b')) // composition still happens in the DOM
  h.session.onEnd()
  await tick()

  assert.deepEqual(h.commitCalls, [], 'never commits an unproven session')
  assert.deepEqual(h.revertCalls, ['composition-range-invalidated'])
  assert.equal(h.notifications.length, 1, 'invalid revert is user-visible')
  assert.equal(h.session.isActive(), false)
}

// Case (c): the composed edit lands OUTSIDE the block the session started
// in — a stray transaction landed in the second paragraph while composing
// in the first. onEnd's diff-vs-blockRange check catches this at end time
// (there is no per-transaction hook) and reverts.
{
  const pmBaseDoc = doc(p('a'), p('b'))
  const view = makeView(pmBaseDoc, { from: 1, to: 1 }) // caret in the first paragraph
  const map = linearMap(1, 2) // only the session's own block is provable
  const h = makeHarness(view, map)

  h.session.onStart()
  // Edit lands in the SECOND paragraph (diff {from:4,to:4} vs blockRange
  // [1,2] captured for the first paragraph at onStart).
  view.state.doc = doc(p('a'), p('Xb'))
  h.session.onEnd()
  await tick()

  assert.deepEqual(h.commitCalls, [])
  assert.deepEqual(h.revertCalls, ['composition-range-invalidated'])
  assert.equal(h.notifications.length, 1)
}

// Case (d): compositioncancel reverts silently — no notification (a cancel
// is an aborted IME session, not a proof failure).
{
  const pmBaseDoc = doc(p('ab'))
  const view = makeView(pmBaseDoc, { from: 2, to: 2 })
  const map = linearMap(1, 3)
  const h = makeHarness(view, map)

  h.session.onStart()
  view.state.doc = doc(p('a甲b'))
  h.session.onCancel()
  await tick()

  assert.deepEqual(h.commitCalls, [])
  assert.deepEqual(h.revertCalls, [null])
  assert.deepEqual(h.notifications, [], 'cancel never notifies')
  assert.equal(h.session.isActive(), false)
}

// Case (e): settled() resolves only after the session ends — not before, and
// not synchronously with onStart. A no-op composition (doc unchanged) still
// settles cleanly (no commit, no revert).
{
  const pmBaseDoc = doc(p('ab'))
  const view = makeView(pmBaseDoc, { from: 2, to: 2 })
  const map = linearMap(1, 3)
  const h = makeHarness(view, map)

  h.session.onStart()
  let settledFlag = false
  const settledPromise = h.session.settled().then(() => { settledFlag = true })
  await tick()
  assert.equal(settledFlag, false, 'settled() must not resolve while the session is still open')

  h.session.onEnd() // doc unchanged -> no diff -> nothing to commit or revert
  await settledPromise
  assert.equal(settledFlag, true)
  assert.deepEqual(h.commitCalls, [])
  assert.deepEqual(h.revertCalls, [])
}

// Case (f): a composition that never receives its end/cancel event must not
// hang settled() forever — settleTimeoutMs forces a revert and resolves
// every waiter.
{
  const pmBaseDoc = doc(p('ab'))
  const view = makeView(pmBaseDoc, { from: 2, to: 2 })
  const map = linearMap(1, 3)
  const h = makeHarness(view, map, { settleTimeoutMs: 20 })

  h.session.onStart()
  let settledFlag = false
  const settledPromise = h.session.settled().then(() => { settledFlag = true })
  view.state.doc = doc(p('a甲b')) // never followed by onEnd/onCancel

  await new Promise((resolve) => setTimeout(resolve, 60))
  await settledPromise
  assert.equal(settledFlag, true, 'settled() must resolve, never hang, on timeout')
  assert.deepEqual(h.revertCalls, ['composition-range-invalidated'])
  assert.deepEqual(h.commitCalls, [], 'a timed-out composition is never committed')
  assert.equal(h.session.isActive(), false)
}

// Case (g): queueExternal — runs immediately with no active session; queued
// and flushed in order once an active session settles.
{
  const pmBaseDoc = doc(p('ab'))
  const view = makeView(pmBaseDoc, { from: 2, to: 2 })
  const map = linearMap(1, 3)
  const h = makeHarness(view, map)

  const immediateLog = []
  h.session.queueExternal(() => immediateLog.push('ran'))
  assert.deepEqual(immediateLog, ['ran'], 'no active session -> runs synchronously')

  h.session.onStart()
  const queuedLog = []
  h.session.queueExternal(() => queuedLog.push('first'))
  h.session.queueExternal(() => queuedLog.push('second'))
  assert.deepEqual(queuedLog, [], 'queued while a session is active — must not run yet')

  h.session.onCancel()
  await tick()
  assert.deepEqual(queuedLog, ['first', 'second'], 'flushed in order once the session settles')
}

// Case (h): commitReplace REFUSES (returns false — stale revision / invalid
// range / structural reparse failure inside the real editor-kernel-mode.js).
// This must be treated exactly like a failed diff: revert + notify, never
// leave the session settled as if the commit had landed while the view still
// shows the composed text the kernel didn't actually accept.
{
  const pmBaseDoc = doc(p('ab'))
  const view = makeView(pmBaseDoc, { from: 2, to: 2 })
  const map = linearMap(1, 3)
  const commitCalls = []
  const revertCalls = []
  const notifications = []
  const session = createCompositionSession({
    getView: () => view,
    kernel: { map },
    commitReplace: (args) => { commitCalls.push(args); return false },
    revertProjection: (code) => revertCalls.push(code),
    notify: (message) => notifications.push(message),
    getT: (key) => key
  })

  session.onStart()
  view.state.doc = doc(p('a甲b'))
  let settledFlag = false
  const settledPromise = session.settled().then(() => { settledFlag = true })
  session.onEnd()
  await settledPromise

  assert.equal(settledFlag, true, 'a refused commit must still settle (never hang)')
  assert.deepEqual(commitCalls, [{ rawFrom: 1, rawTo: 1, text: '甲', pmFrom: 2 }],
    'commitReplace was called with the derived range even though it refused')
  assert.deepEqual(revertCalls, ['composition-range-invalidated'],
    'a falsy commitReplace return reverts the view, exactly like a failed diff')
  assert.equal(notifications.length, 1, 'a refused commit is user-visible, same as any other revert')
  assert.equal(session.isActive(), false)
}

// Case (i): the diff-derived range DIVERGES from the selection captured at
// onStart — the design-doc deviation this locks in. Base 'hello', collapsed
// cursor at the END (raw offset 5), but the IME's commit rewrites the WHOLE
// word (autocorrect-style: 'hello' -> 'Hello!'). The literal spec wording
// (`commitReplace(session.rawRange, finalText)`) would have committed at
// {rawFrom:5, rawTo:5} — wrong, since it would insert 'Hello!' AFTER the
// unchanged 'hello' instead of replacing it. commitReplace must receive the
// diff-derived {rawFrom:0, rawTo:5} instead.
{
  const pmBaseDoc = doc(p('hello'))
  const view = makeView(pmBaseDoc, { from: 6, to: 6 }) // collapsed at the end of 'hello'
  const map = linearMap(1, 6) // paragraph content range [1,6)
  const h = makeHarness(view, map)

  h.session.onStart()
  view.state.doc = doc(p('Hello!'))
  h.session.onEnd()
  await tick()

  assert.deepEqual(h.commitCalls, [{ rawFrom: 0, rawTo: 5, text: 'Hello!', pmFrom: 1 }],
    'commitReplace receives the range the diff actually covers, not session-start rawRange {5,5}')
  assert.deepEqual(h.revertCalls, [])
  assert.deepEqual(h.notifications, [])
}

// Case (j): a stray SECOND compositionstart while a session is already open
// (fast IME/undo replay) silently reverts the stale session (no
// notification — it's not a proof failure) and opens a fresh one that can
// still commit normally.
{
  const pmBaseDoc = doc(p('ab'))
  const view = makeView(pmBaseDoc, { from: 2, to: 2 })
  const map = linearMap(1, 3)
  const h = makeHarness(view, map)

  h.session.onStart()
  assert.equal(h.session.isActive(), true)

  // A second compositionstart arrives before this one ended.
  h.session.onStart()
  assert.deepEqual(h.commitCalls, [])
  assert.deepEqual(h.revertCalls, [null], 'the stale session reverts silently, no notification')
  assert.deepEqual(h.notifications, [])
  assert.equal(h.session.isActive(), true, 'the second onStart opens a fresh session')

  // The fresh session composes and commits normally.
  view.state.doc = doc(p('a甲b'))
  h.session.onEnd()
  await tick()
  assert.deepEqual(h.commitCalls, [{ rawFrom: 1, rawTo: 1, text: '甲', pmFrom: 2 }])
  assert.deepEqual(h.revertCalls, [null], 'no further revert beyond the double-start one')
}

// Case (k): a LATE compositionend arriving AFTER a timeout already forced a
// rollback must be a safe no-op — no second commit/revert call, no crash,
// isActive() stays false. (Realistic scenario: the DOM's compositionend
// fires just after the settleTimeoutMs safety net already fired.)
{
  const pmBaseDoc = doc(p('ab'))
  const view = makeView(pmBaseDoc, { from: 2, to: 2 })
  const map = linearMap(1, 3)
  const h = makeHarness(view, map, { settleTimeoutMs: 20 })

  h.session.onStart()
  view.state.doc = doc(p('a甲b'))
  await new Promise((resolve) => setTimeout(resolve, 60)) // timeout fires, forces revert
  assert.equal(h.session.isActive(), false)
  assert.deepEqual(h.revertCalls, ['composition-range-invalidated'])

  // The browser's real compositionend arrives late, after the timeout.
  h.session.onEnd()
  await tick()
  assert.deepEqual(h.commitCalls, [], 'a late end must not retroactively commit')
  assert.deepEqual(h.revertCalls, ['composition-range-invalidated'],
    'a late end must not fire a second revert either — it is a pure no-op')
  assert.equal(h.session.isActive(), false)

  // Same for a late cancel arriving after the timeout.
  h.session.onCancel()
  await tick()
  assert.deepEqual(h.revertCalls, ['composition-range-invalidated'], 'a late cancel is also a no-op')
}

console.log('PASS kernel composition headless')
