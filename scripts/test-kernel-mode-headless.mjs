// TDD evidence + regression lock for editor-kernel-mode.js
// (source-kernel integration Plan 2, Task 5).
//
// Drives createKernelMode() directly with a hand-built @milkdown/prose Schema,
// a real EditorState behind a stub view (dispatch applies the tr, updateState
// swaps the state — the same two-phase protocol editor-source-transactions.js
// uses), and a STUB parse that maps kernel markdown bytes to hand-built PM
// docs. Every raw offset / PM position below is derived by hand, same
// convention as scripts/test-kernel-gateway.mjs.
//
// The Editor.jsx wiring itself (props, crepe options, markdownUpdated gate) is
// covered by the Task 9 UI regression; this file locks the DECISIONS:
// pass-through vs veto, kernel byte advancement, structural/history keymap
// handling, caret restore, and full degradation on an unmappable document.
import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { createKernelMode } from '../src/renderer/src/components/editor-kernel-mode.js'

// `bullet_list`/`list_item` (with a `checked` attr, `list_item` content
// `'paragraph block*'`) mirror @milkdown/preset-commonmark + preset-gfm's
// real shape — needed for Case 11's task-checkbox dispatch path.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    bullet_list: { content: 'list_item+', group: 'block' },
    list_item: {
      content: 'paragraph block*',
      attrs: { checked: { default: null } }
    }
  }
})
const p = (...c) => schema.node('paragraph', null, c)
const doc = (...c) => schema.node('doc', null, c)
const text = (s) => schema.text(s)
const li = (checked, ...c) => schema.node('list_item', { checked }, c)
const bl = (...c) => schema.node('bullet_list', null, c)

// Stub parse: kernel markdown bytes -> a freshly built PM doc. Unknown bytes
// throw, exactly like a parser failure would.
const FIXTURE_DOCS = {
  '甲乙\n': () => doc(p(text('甲乙'))),
  '甲丙乙\n': () => doc(p(text('甲丙乙'))),
  '甲\n\n乙\n': () => doc(p(text('甲')), p(text('乙'))),
  '甲\t乙\n': () => doc(p(text('甲\t乙'))),
  '- [x] 乙\n': () => doc(bl(li(true, p(text('乙'))))),
  '- [ ] 乙\n': () => doc(bl(li(false, p(text('乙')))))
}
const stubParse = (markdown) => {
  const build = FIXTURE_DOCS[markdown]
  if (!build) throw new Error('stub parse has no fixture for: ' + JSON.stringify(markdown))
  return build()
}

// Stub view implementing the dispatch protocol handleTransactions relies on:
// a real EditorState, dispatch applies the tr in place (so reconcileProjection
// and caret-restore work), updateState swaps in a pre-applied state.
const makeView = (initialDoc) => {
  let state = EditorState.create({ schema, doc: initialDoc })
  return {
    get state() { return state },
    dispatch(tr) { state = state.apply(tr) },
    updateState(next) { state = next },
    composing: false,
    focus() {}
  }
}

const makeHarness = (initialContent, initialDoc, extra = {}) => {
  const notifications = []
  const changes = []
  const view = makeView(initialDoc)
  const controller = createKernelMode({
    initialContent,
    getView: () => view,
    parse: stubParse,
    notify: (message) => notifications.push(message),
    getT: (key) => key,
    onChange: (markdown, flag) => changes.push([markdown, flag]),
    ...extra
  })
  return { view, controller, notifications, changes }
}

// Emulate createSourceTransactionDispatch: classify first, updateState only
// when not vetoed.
const dispatchThrough = (harness, tr) => {
  const oldState = harness.view.state
  const applied = oldState.apply(tr)
  const verdict = harness.controller.handleTransactions([tr], oldState, {
    ...applied,
    doc: applied.doc,
    tr: applied.tr
  })
  if (!verdict?.veto) harness.view.updateState(applied)
  return verdict
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

console.log('--- kernel mode headless ---')

// Shared harness for cases 1 / 2 / 5 (they form one editing session).
const session = makeHarness('甲乙\n', doc(p(text('甲乙'))))
assert.equal(session.controller.attachAfterCreate(), true, 'initial map must build')
assert.ok(session.controller.kernel.map, 'kernel.map set after attach')

// Case 1: plain-text insert flows through commitPlainText — pass-through
// (undefined), kernel bytes advance, onChange publishes the kernel text.
{
  const oldState = session.view.state
  const tr = oldState.tr.insertText('丙', 2) // between 甲 and 乙 -> raw offset 1
  const verdict = dispatchThrough(session, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'plain-text is allowed (no veto)')
  assert.equal(session.controller.kernel.doc.text, '甲丙乙\n')
  assert.equal(session.controller.kernel.doc.revision, 1)
  assert.deepEqual(session.changes.at(-1), ['甲丙乙\n', false])
  assert.equal(session.view.state.doc.textContent, '甲丙乙')
  // Map was rebound to the new revision/doc: raw 1 (after 甲) -> PM pos 2.
  assert.equal(session.controller.kernel.map.pmPosToRaw(2), 1)
}

// Case 2: a drop transaction is blocked -> {veto:true}, kernel unchanged,
// notify fired; the view keeps its pre-drop state (dispatch protocol skips
// updateState on veto).
{
  const before = session.notifications.length
  const oldState = session.view.state
  const tr = oldState.tr.insertText('X', 1)
  tr.setMeta('uiEvent', 'drop')
  const verdict = dispatchThrough(session, tr)
  assert.deepEqual(verdict, { veto: true })
  assert.equal(session.controller.kernel.doc.text, '甲丙乙\n', 'kernel bytes untouched')
  assert.equal(session.view.state.doc.textContent, '甲丙乙', 'view untouched after veto')
  assert.ok(session.notifications.length > before, 'blocked edit notifies the user')

  // Toast cooldown: an immediately repeated blocked edit (key-repeat veto
  // storm) still vetoes but must NOT stack another toast within the window.
  const notifCount = session.notifications.length
  const repeat = session.view.state.tr.insertText('X', 1)
  repeat.setMeta('uiEvent', 'drop')
  assert.deepEqual(dispatchThrough(session, repeat), { veto: true })
  assert.equal(session.notifications.length, notifCount, 'repeat toast suppressed by cooldown')
}

// Case 3: structural Enter mid-paragraph. Fresh session '甲乙\n', caret at PM
// pos 2 (raw offset 1). splitTextBlock inserts '\n\n' at raw 1 ->
// '甲\n\n乙\n'; the view is reconciled to the parsed two-paragraph doc and the
// caret lands in the second paragraph (raw 3 -> PM pos 4).
{
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 2)))
  const handled = h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view)
  assert.equal(handled, true)
  assert.equal(h.controller.kernel.doc.text, '甲\n\n乙\n')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲')), p(text('乙')))), 'view reconciled to parse output')
  assert.equal(h.view.state.selection.head, 4, 'caret restored into the new block')
  assert.deepEqual(h.changes.at(-1), ['甲\n\n乙\n', false])
}

// Case 4: Tab in a paragraph is not-structural -> replaceVisibleText inserts
// a literal '\t' through the kernel (source-first), swallowing the key.
{
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 2)))
  const handled = h.controller.structuralHandlers.Tab(h.view.state, h.view.dispatch, h.view)
  assert.equal(handled, true)
  assert.equal(h.controller.kernel.doc.text, '甲\t乙\n')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲\t乙')))))
  assert.equal(h.view.state.selection.head, 3, 'caret sits right after the inserted tab')
}

// Case 5: history — undo restores the pre-Case-1 bytes exactly; redo
// reapplies them. Both reconcile the view and both suppress PM history
// (handler returns true even when there is nothing to undo).
{
  const undone = session.controller.historyHandlers.undo(
    session.view.state, session.view.dispatch, session.view
  )
  assert.equal(undone, true)
  assert.equal(session.controller.kernel.doc.text, '甲乙\n', 'undo restores bytes exactly')
  assert.ok(session.view.state.doc.eq(doc(p(text('甲')))) === false)
  assert.ok(session.view.state.doc.eq(doc(p(text('甲乙')))))
  assert.equal(session.view.state.selection.head, 2, 'undo caret at the removed span')

  const redone = session.controller.historyHandlers.redo(
    session.view.state, session.view.dispatch, session.view
  )
  assert.equal(redone, true)
  assert.equal(session.controller.kernel.doc.text, '甲丙乙\n', 'redo reapplies bytes exactly')
  assert.ok(session.view.state.doc.eq(doc(p(text('甲丙乙')))))
  assert.equal(session.view.state.selection.head, 3)

  // Empty redo stack: still true (suppresses PM history), no state change.
  const emptyRedo = session.controller.historyHandlers.redo(
    session.view.state, session.view.dispatch, session.view
  )
  assert.equal(emptyRedo, true)
  assert.equal(session.controller.kernel.doc.text, '甲丙乙\n')
}

// Case 6: degraded mode. The initial map cannot be proven (kernel text has
// ONE paragraph, the PM doc has TWO) -> attachAfterCreate degrades with a
// notification; from then on handleTransactions passes EVERYTHING through
// (legacy behavior — even a drop) and every keymap handler returns false.
{
  const h = makeHarness('甲乙\n', doc(p(text('甲')), p(text('乙'))))
  assert.equal(h.controller.attachAfterCreate(), false)
  assert.ok(h.notifications.length >= 1, 'degradation is announced, never silent')
  assert.equal(h.controller.kernel.map, null)

  const oldState = h.view.state
  const drop = oldState.tr.insertText('X', 1)
  drop.setMeta('uiEvent', 'drop')
  assert.equal(h.controller.handleTransactions([drop], oldState, oldState.apply(drop)), undefined)

  const plain = h.view.state.tr.insertText('Y', 1)
  assert.equal(
    h.controller.handleTransactions([plain], h.view.state, h.view.state.apply(plain)),
    undefined
  )
  assert.equal(h.controller.kernel.doc.text, '甲乙\n', 'degraded kernel never advances')
  assert.equal(h.changes.length, 0, 'degraded mode publishes nothing')

  for (const key of ['Enter', 'Tab', 'Shift-Tab', 'Backspace', 'Delete']) {
    assert.equal(
      h.controller.structuralHandlers[key](h.view.state, h.view.dispatch, h.view),
      false,
      key + ' falls back to legacy keymaps in degraded mode'
    )
  }
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), false)
  assert.equal(h.controller.historyHandlers.redo(h.view.state, h.view.dispatch, h.view), false)
  assert.equal(h.controller.isDegraded(), true)

  // Degraded-aware API delegation: every override must reach the captured
  // legacy implementation at call time — the frozen kernel.doc.text is a
  // data-loss trap here (save would silently write the initial content).
  const legacyCalls = []
  h.controller.attachLegacyApi({
    flushMarkdown: () => h.view.state.doc.textContent + '\n',
    flushMarkdownSettled: async () => h.view.state.doc.textContent + '\n',
    replaceMarkdown: (md) => { legacyCalls.push(['replaceMarkdown', md]); return true },
    getVerifiedSyncStatus: () => ({ status: 'committed' }),
    getRecoveryMarkdown: () => 'LEGACY-RECOVERY',
    markdownOffsetFromSelection: () => 42,
    restoreMarkdownOffset: (raw) => { legacyCalls.push(['restore', raw]); return true },
    applyTextFormat: () => true,
    toggleHighlight: () => undefined,
    applyReviewMarkup: () => true
  })
  const api = h.controller.apiOverrides

  // A real text edit passes through to the view (legacy ownership) and the
  // delegated flush then returns the EDITED content, not the frozen bytes.
  const edit = h.view.state.tr.insertText('新', 1)
  const applied = h.view.state.apply(edit)
  assert.equal(h.controller.handleTransactions([edit], h.view.state, applied), undefined)
  h.view.updateState(applied)
  assert.equal(h.view.state.doc.textContent, '新甲乙')
  assert.equal(api.flushMarkdown(), '新甲乙\n', 'flush reflects the edit via legacy delegation')
  assert.notEqual(api.flushMarkdown(), h.controller.kernel.doc.text, 'never the frozen kernel bytes')
  assert.equal(await api.flushMarkdownSettled(), '新甲乙\n')
  assert.notEqual(api.getVerifiedSyncStatus().status, 'kernel-authoritative',
    'degraded tab must not claim kernel authority')
  assert.equal(api.getRecoveryMarkdown(), 'LEGACY-RECOVERY')
  assert.equal(api.markdownOffsetFromSelection(), 42)
  assert.equal(api.restoreMarkdownOffset(7), true)
  assert.equal(api.replaceMarkdown('X\n'), true)
  assert.deepEqual(legacyCalls, [['restore', 7], ['replaceMarkdown', 'X\n']])
  const notifBefore = h.notifications.length
  assert.equal(api.applyTextFormat('bold'), true, 'legacy owns formatting again when degraded')
  assert.equal(api.toggleHighlight(), undefined,
    'a void legacy result propagates (no ?? fallback to the refusal path)')
  assert.equal(api.applyReviewMarkup('insert'), true)
  assert.equal(h.notifications.length, notifBefore, 'no unsupported-API toast in degraded mode')
}

// Case 7 (wiring guard): before attachAfterCreate has run (Crepe still
// creating / chunks still appending), everything passes through and no key is
// intercepted — otherwise the kernel would veto the editor's own init
// transactions.
{
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  const oldState = h.view.state
  const tr = oldState.tr.insertText('Z', 1)
  assert.equal(h.controller.handleTransactions([tr], oldState, oldState.apply(tr)), undefined)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n')
  assert.equal(h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view), false)
}

// Case 8: apiOverrides surface. flushMarkdown returns the kernel bytes
// directly; sync status reports kernel authority; offset APIs run on the
// projection map (never the ordinal editor-source-map path); unsupported
// rich formatting APIs refuse with a notification.
{
  globalThis.__hmKernelDiagnostics = []
  const prepareCalls = []
  const structureCalls = []
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))), {
    prepareMarkdown: (source) => { prepareCalls.push(source); return source },
    onStructureChange: () => structureCalls.push(1)
  })
  assert.equal(h.controller.attachAfterCreate(), true)
  const api = h.controller.apiOverrides
  assert.equal(api.flushMarkdown(), '甲乙\n')
  assert.equal(await api.flushMarkdownSettled(), '甲乙\n')
  assert.deepEqual(api.getVerifiedSyncStatus(), { status: 'kernel-authoritative' })
  assert.equal(api.getRecoveryMarkdown(), '甲乙\n')
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 2)))
  assert.equal(api.markdownOffsetFromSelection(), 1)
  assert.equal(api.restoreMarkdownOffset(2), true)
  assert.equal(h.view.state.selection.head, 3)
  const before = h.notifications.length
  assert.equal(api.applyTextFormat('bold'), false)
  assert.equal(api.toggleHighlight(), false)
  assert.equal(api.applyReviewMarkup('insert'), false)
  assert.equal(h.notifications.length, before + 1,
    'unsupported APIs notify (cooldown collapses the burst to one toast)')
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((entry) => entry.type === 'unsupported-api').length,
    3,
    'every refusal is individually diagnosed'
  )

  // replaceMarkdown resets the kernel + history, reconciles the view, runs
  // the legacy prepare normalization before parsing, and reports the
  // structure change (outline refresh parity with the legacy path).
  assert.equal(api.replaceMarkdown('甲\n\n乙\n'), true)
  assert.deepEqual(prepareCalls, ['甲\n\n乙\n'], 'prepareMarkdown ran before parse')
  assert.equal(structureCalls.length, 1, 'onStructureChange fired once')
  assert.equal(h.controller.kernel.doc.text, '甲\n\n乙\n')
  assert.equal(h.controller.kernel.doc.revision, 0, 'replace resets the revision line')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲')), p(text('乙')))))
  assert.equal(
    h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view),
    true, 'undo after replace is suppressed (history cleared)'
  )
  assert.equal(h.controller.kernel.doc.text, '甲\n\n乙\n')
}

// Case 9: history-frozen diagnostic. A null undo caused by revision desync
// (the stack still has entries but the doc's revision no longer matches the
// history's rolling pointer) is diagnosed, not silently identical to an
// empty stack.
{
  globalThis.__hmKernelDiagnostics = []
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const oldState = h.view.state
  const tr = oldState.tr.insertText('丙', 2)
  dispatchThrough(h, tr) // records one undo group
  await flushMicrotasks()
  // External desync: same bytes, foreign revision — breaks the linear chain
  // createSourceHistory tracks via its rolling lastKnownRevision pointer.
  h.controller.kernel.doc = { text: h.controller.kernel.doc.text, revision: 99 }
  const handled = h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view)
  assert.equal(handled, true, 'frozen history still swallows the key')
  assert.equal(h.controller.kernel.doc.text, '甲丙乙\n', 'nothing replayed')
  assert.ok(
    globalThis.__hmKernelDiagnostics.some(
      (entry) => entry.type === 'history-frozen' && entry.direction === 'undo'
    ),
    'history-frozen diagnostic recorded'
  )
}

// Case 10 (Task 6 integration): apiOverrides.flushMarkdownSettled awaits an
// active IME composition session instead of resolving immediately.
// composition.onStart/onEnd bypass handleTransactions entirely (composition
// transactions are the caller's pass-through concern, not the kernel's — see
// case 'composition' in handleTransactions), so this drives the controller's
// `composition` surface directly and mutates the stub view the same way a
// real compositionupdate would (view.updateState with the composed doc)
// before calling onEnd. Same '甲乙\n' -> insert '丙' at raw 1 -> '甲丙乙\n'
// fixture as case 1, so the committed text is provable by inspection.
{
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 2)))

  h.controller.composition.onStart()
  assert.equal(h.controller.composition.isActive(), true)

  let settled = false
  const flushPromise = h.controller.apiOverrides.flushMarkdownSettled()
    .then((text) => { settled = true; return text })
  await flushMicrotasks()
  assert.equal(settled, false, 'flushMarkdownSettled must wait for the open composition')
  assert.equal(h.controller.kernel.doc.text, '甲乙\n', 'kernel untouched while composing')

  // The composed edit lands in the view (composition transactions never
  // reach the kernel mid-flight — only compositionend's diff does).
  h.view.updateState(h.view.state.apply(h.view.state.tr.insertText('丙', 2)))
  h.controller.composition.onEnd()
  await flushMicrotasks()

  const settledText = await flushPromise
  assert.equal(settled, true)
  assert.equal(settledText, '甲丙乙\n', 'flush resolves to the settled (committed) kernel text')
  assert.equal(h.controller.kernel.doc.text, '甲丙乙\n')
  assert.equal(h.controller.composition.isActive(), false)
}

// Case 11 (Task 9 root-cause fix): the task-checkbox click. Crepe's
// list-item-block node view toggles a task item with a bare
// `tr.setNodeAttribute(pos, 'checked', v)` (an AttrStep, never a keymap and
// never a ReplaceStep) — before the gateway/kernel-mode `task-toggle`
// classification existed, this fell through to `blocked`/`INPUT_TYPE` and
// the dispatch-veto protocol silently discarded every checkbox click in
// kernel mode (found by the Task 9 UI smoke run). Same dispatchThrough
// protocol a real click goes through: pass-through (undefined verdict),
// kernel bytes flip the marker, the view's own attr-flip is what lands
// (no reconcile needed), and the toggle is its own undo group.
{
  const h = makeHarness('- [x] 乙\n', doc(bl(li(true, p(text('乙'))))))
  assert.equal(h.controller.attachAfterCreate(), true, 'task-list map must build')
  const oldState = h.view.state
  const pos = 1
  assert.equal(oldState.doc.nodeAt(pos)?.type.name, 'list_item', 'fixture position sanity check')
  const tr = oldState.tr.setNodeAttribute(pos, 'checked', false)
  assert.equal(tr.steps[0].constructor.name, 'AttrStep')
  const verdict = dispatchThrough(h, tr)
  assert.equal(verdict, undefined, 'task toggle is allowed through (no veto)')
  assert.equal(h.controller.kernel.doc.text, '- [ ] 乙\n')
  assert.equal(h.controller.kernel.doc.revision, 1)
  assert.deepEqual(h.changes.at(-1), ['- [ ] 乙\n', false])
  assert.equal(h.view.state.doc.firstChild.firstChild.attrs.checked, false, 'view reflects the flip')

  // Undo restores '- [x] 乙\n' as ONE group — its own history entry (intent
  // 'toggle-task'), never coalesced with an unrelated insert-text group —
  // and reconciles via the stub parse fixture above.
  const undone = h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view)
  assert.equal(undone, true)
  assert.equal(h.controller.kernel.doc.text, '- [x] 乙\n', 'undo restores the checked marker exactly')
}

console.log('PASS kernel mode headless')
