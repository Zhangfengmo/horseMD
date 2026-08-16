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
import { toggleMark } from '@milkdown/prose/commands'
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
    },
    // Plan 3 Task 4 — needed for Case 12's code-block text-commit +
    // language-switch end-to-end path.
    code_block: { content: 'text*', group: 'block', code: true, attrs: { language: { default: '' } } },
    // Plan 4 Task 4 — needed for the quote-toggle end-to-end cases (mirrors
    // preset-commonmark's real `blockquote` shape: one-or-more block content).
    blockquote: { content: 'block+', group: 'block' },
    // Plan 5 Task 1 — Crepe's latex feature: inline math is an ATOM carrying
    // its TeX source in `attrs.value`; BLOCK math is a `code_block` whose
    // `attrs.language` is 'LaTeX' (crepe's remarkMathBlock rewrites the mdast
    // `math` node to `{type:'code', lang:'LaTeX'}` before the PM parse).
    math_inline: { group: 'inline', inline: true, atom: true, attrs: { value: { default: '' } } }
  },
  // Plan 4 Task 3 — mark names mirror the LIVE schema exactly (probed):
  // preset-commonmark "strong"/"emphasis"/"inlineCode"/"link", preset-gfm
  // "strike_through", editor-highlight.js 'highlight' (color default yellow).
  marks: {
    strong: {},
    emphasis: {},
    strike_through: {},
    inlineCode: {},
    highlight: { attrs: { color: { default: 'yellow' } } },
    link: { attrs: { href: { default: '' } } }
  }
})
const p = (...c) => schema.node('paragraph', null, c)
const doc = (...c) => schema.node('doc', null, c)
const text = (s) => schema.text(s)
const li = (checked, ...c) => schema.node('list_item', { checked }, c)
const bl = (...c) => schema.node('bullet_list', null, c)
const cb = (language, s) => schema.node('code_block', { language }, s ? text(s) : [])
const bq = (...c) => schema.node('blockquote', null, c)
const mif = (value) => schema.node('math_inline', { value })

// Stub parse: kernel markdown bytes -> a freshly built PM doc. Unknown bytes
// throw, exactly like a parser failure would.
const FIXTURE_DOCS = {
  '甲乙\n': () => doc(p(text('甲乙'))),
  '甲丙乙\n': () => doc(p(text('甲丙乙'))),
  '甲\n\n乙\n': () => doc(p(text('甲')), p(text('乙'))),
  '甲\t乙\n': () => doc(p(text('甲\t乙'))),
  '- [x] 乙\n': () => doc(bl(li(true, p(text('乙'))))),
  '- [ ] 乙\n': () => doc(bl(li(false, p(text('乙'))))),
  // Task 11.5 fixtures: trailing-placeholder typing + split placeholder.
  '- 甲\n': () => doc(bl(li(null, p(text('甲'))))),
  '- 甲\n\nX': () => doc(bl(li(null, p(text('甲')))), p(text('X'))),
  '- 甲\n\nab': () => doc(bl(li(null, p(text('甲')))), p(text('ab'))),
  '甲乙\n\n\n': () => doc(p(text('甲乙'))),
  '甲乙\n\n丙\n': () => doc(p(text('甲乙')), p(text('丙'))),
  'X甲乙\n\n\n': () => doc(p(text('X甲乙'))),
  // Task 2 (plan 3) fixtures: repeated Enter inside the trailing placeholder
  // chain — mdast always collapses the blank run to nothing regardless of
  // its length, so every one of these still parses to the single paragraph.
  '甲乙\n\n\n\n': () => doc(p(text('甲乙'))),
  '甲乙\n\n\n\n\n': () => doc(p(text('甲乙'))),
  '甲乙\n\n\n\n丙\n': () => doc(p(text('甲乙')), p(text('丙'))),
  // Plan 3 Task 4 fixtures: a code_block text commit (multi-line CM-style
  // insert) followed by a language switch, both on the same block.
  '```js\nab\n```\n': () => doc(cb('js', 'ab')),
  '```js\naX\nYb\n```\n': () => doc(cb('js', 'aX\nYb')),
  '```python\naX\nYb\n```\n': () => doc(cb('python', 'aX\nYb')),
  // CRLF fixtures (un-narrowing, 2026-08-17): a CRLF code block is editable
  // end to end — Case 13 commits a '\r\n'-spelled multi-line insert into it,
  // then proves the bare-'\n' shape still fails closed and that neither
  // outcome locks the rest of the document out.
  '```js\r\nab\r\ncd\r\n```\r\n甲乙\r\n': () => doc(cb('js', 'ab\r\ncd'), p(text('甲乙'))),
  '```js\r\nabX\r\nY\r\ncd\r\n```\r\n甲乙\r\n': () => doc(cb('js', 'abX\r\nY\r\ncd'), p(text('甲乙'))),
  '```js\r\nabX\r\nY\r\ncd\r\n```\r\n甲丙乙\r\n': () => doc(cb('js', 'abX\r\nY\r\ncd'), p(text('甲丙乙'))),
  // Plan 3 Task 5 fixtures: Mod-Enter code-block exit (doc-end + mid-doc)
  // — CommonMark collapses the exit's blank lines, so the post-exit texts
  // parse back to the same block sequences.
  '```js\nab\n```\n\n\n': () => doc(cb('js', 'ab')),
  '```js\nab\n```\n甲\n': () => doc(cb('js', 'ab'), p(text('甲'))),
  '```js\nab\n```\n\n\n甲\n': () => doc(cb('js', 'ab'), p(text('甲'))),
  '```js\nab\n```\nX\n\n甲\n': () => doc(cb('js', 'ab'), p(text('X')), p(text('甲'))),
  // Final-review fixtures (2026-08-16): the from-readonly language-switch
  // refusal was lifted — a mermaid block can switch straight to a real
  // language and immediately accept a plain-text commit afterward.
  '```mermaid\ngraph TD\n```\n': () => doc(cb('mermaid', 'graph TD')),
  '```js\ngraph TD\n```\n': () => doc(cb('js', 'graph TD')),
  '```js\nXgraph TD\n```\n': () => doc(cb('js', 'Xgraph TD')),
  // Plan 4 Task 3 fixtures: inline mark toggles. The live parse chain
  // (Crepe's, WITH the highlight remark plugin) turns committed marker
  // bytes into real marks — mirrored here exactly.
  '甲乙丙\n': () => doc(p(text('甲乙丙'))),
  '甲**乙**丙\n': () => doc(p(text('甲'), schema.text('乙', [schema.mark('strong')]), text('丙'))),
  '甲==乙==丙\n': () => doc(p(text('甲'), schema.text('乙', [schema.mark('highlight')]), text('丙'))),
  '甲`乙`丙\n': () => doc(p(text('甲'), schema.text('乙', [schema.mark('inlineCode')]), text('丙'))),
  '甲`乙丙`\n': () => doc(p(text('甲'), schema.text('乙丙', [schema.mark('inlineCode')]))),
  // P4-3.5 Fix B fixtures: plain typing inside the already-marked paragraph.
  '甲**乙**丙X\n': () => doc(p(text('甲'), schema.text('乙', [schema.mark('strong')]), text('丙X'))),
  '甲**乙**X丙\n': () => doc(p(text('甲'), schema.text('乙', [schema.mark('strong')]), text('X丙'))),
  // Plan 4 Task 4 fixture: quote-toggle wrap/unwrap round trip. Reused for
  // both directions ('甲乙\n' -> wrap -> this, and this -> unwrap -> '甲乙\n',
  // which already has its own fixture above). Trailing `p()` mirrors
  // `withTrailingParagraph`'s own append (see e.g. the mermaid fixtures
  // above): a doc whose last top-level child is not paragraph/heading always
  // gains one, so the fixture bakes it in directly rather than relying on
  // the (here bypassed for a hand-built parse) append to add it again.
  '> 甲乙\n': () => doc(bq(p(text('甲乙'))), p()),
  // Plan 5 Task 1 fixtures: a document carrying BOTH inline and block math.
  // Before the kernel chain gained remark-math this whole document degraded
  // to legacy at attach (projection map null), so NOTHING in it was
  // kernel-editable — including its ordinary paragraphs. These fixtures
  // mirror the live Crepe parse exactly: `$x$` -> math_inline atom,
  // `$$..$$` -> code_block(language 'LaTeX').
  'a $x$ b\n\n$$\nE=mc^2\n$$\n\n甲乙\n': () => doc(
    p(text('a '), mif('x'), text(' b')), cb('LaTeX', 'E=mc^2'), p(text('甲乙'))),
  'a $x$ b\n\n$$\nE=mc^2\n$$\n\n甲X乙\n': () => doc(
    p(text('a '), mif('x'), text(' b')), cb('LaTeX', 'E=mc^2'), p(text('甲X乙')))
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

// Case 12 (Task 11.5, trailing placeholder): a document ENDING IN A LIST
// attaches live (this is the exact shape @milkdown/plugin-trailing appends
// its empty paragraph after — pre-fix, the map rejected the whole doc and
// kernel mode silently degraded to legacy). Typing into the trailing
// paragraph commits at the raw document end WITH the blank-line separator,
// so the source gains a new paragraph — never a lazy continuation line of
// the last item. Raw '- 甲\n' length 4; trailing p@7, content start 8.
{
  const h = makeHarness('- 甲\n', doc(bl(li(null, p(text('甲')))), p()))
  assert.equal(h.controller.attachAfterCreate(), true,
    'a list-ending doc (with its trailing placeholder) must attach live, not degrade')
  assert.equal(h.controller.isDegraded(), false)
  assert.deepEqual(h.controller.kernel.map.virtualBlockAt(8), { raw: 4, prefix: '\n' })

  const oldState = h.view.state
  const tr = oldState.tr.insertText('X', 8)
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'typing in the trailing paragraph is allowed')
  assert.equal(h.controller.kernel.doc.text, '- 甲\n\nX',
    'the insert carries the blank-line separator: a new paragraph, NOT "- 甲\\nX" (lazy continuation)')
  assert.deepEqual(h.changes.at(-1), ['- 甲\n\nX', false])
  assert.ok(h.view.state.doc.eq(doc(bl(li(null, p(text('甲')))), p(text('X')))))
  assert.ok(h.controller.kernel.map, 'map realigns once the paragraph is real')
}

// Case 13 (Task 11.5, splitTextBlock degenerate split): Enter at the END of
// a paragraph writes '\n\n' whose reparse shows no new block (CommonMark
// collapses blank-line runs). The controller must materialize an editable
// placeholder paragraph, park the caret in it, and route the NEXT keystroke
// to the blank-line raw offset — this is the exact caret-misplacement bug
// that made continuation text land in the wrong block (Task 11 Bug 3).
{
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 3))) // end of 甲乙
  const handled = h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view)
  assert.equal(handled, true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n\n', 'split bytes written at the block end')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')), p())),
    'the view shows the new empty paragraph even though the reparse collapses it')
  assert.equal(h.view.state.selection.head, 5, 'caret parked inside the placeholder')
  assert.deepEqual(h.controller.kernel.map.virtualBlockAt(5), { raw: 4, prefix: '' })

  // The continuation keystroke lands at the blank-line offset — the bytes
  // the pure-kernel oracle derives for "Enter then type".
  const tr = h.view.state.tr.insertText('丙', 5)
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n丙\n',
    'typed text becomes the new paragraph — never merged into a neighboring block')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')), p(text('丙')))))
  assert.equal(h.controller.kernel.map.pmPosToRaw(6), 5, 'map realigned to the now-real paragraph')

  // Undo granularity: the typed char and the split are separate groups.
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n\n')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')))),
    'undo of the fill removes the paragraph from the view (the bytes cannot represent it)')
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n', 'undo of the split restores the original bytes')
}

// Case 14 (Task 11.5): typing ELSEWHERE while a split placeholder is
// pending ends the placeholder session — the orphaned empty paragraph (the
// parse never contains it) is removed by the verify repair and the map
// recovers, instead of staying null.
{
  globalThis.__hmKernelDiagnostics = []
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 3)))
  assert.equal(h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view), true)
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')), p())), 'placeholder present')

  const tr = h.view.state.tr.insertText('X', 1) // start of 甲乙 — NOT the placeholder
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, 'X甲乙\n\n\n')
  assert.ok(h.view.state.doc.eq(doc(p(text('X甲乙')))),
    'the orphaned placeholder was reconciled away')
  assert.ok(h.controller.kernel.map, 'map recovered after the orphan cleanup')
  assert.equal(h.controller.kernel.map.pmPosToRaw(1), 0)
}

// Case 15 (Task 11.5): @milkdown/plugin-trailing's own append transaction —
// an empty paragraph inserted at the very end of a list-ending doc — is
// passed through (never vetoed) with no kernel byte change, and the map is
// rebound so the new node pairs as the trailing placeholder.
{
  const h = makeHarness('- [x] 乙\n', doc(bl(li(true, p(text('乙'))))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const oldState = h.view.state
  const end = oldState.doc.content.size
  const tr = oldState.tr.insert(end, schema.nodes.paragraph.createAndFill())
  const verdict = dispatchThrough(h, tr)
  assert.equal(verdict, undefined, 'the trailing append must not be vetoed')
  assert.equal(h.controller.kernel.doc.text, '- [x] 乙\n', 'no kernel bytes for a view-only node')
  assert.equal(h.changes.length, 0, 'nothing published for the trailing append')
  assert.deepEqual(h.controller.kernel.map.virtualBlockAt(end + 1), { raw: 8, prefix: '\n' })
}

// Case 16 (Task 11.5 review fix, prefix latching end-to-end): ONE
// transaction carrying TWO insert steps into the trailing paragraph must
// commit as ONE new source paragraph ('- 甲\n\nab') with the cheap-path
// verify passing — no projection-mismatch, no repair reconcile
// restructuring the user's typing (the unlatched bug produced
// '- 甲\n\na\nb': two source paragraphs for PM's one).
{
  globalThis.__hmKernelDiagnostics = []
  const h = makeHarness('- 甲\n', doc(bl(li(null, p(text('甲')))), p()))
  assert.equal(h.controller.attachAfterCreate(), true)
  const oldState = h.view.state
  const tr = oldState.tr.insertText('a', 8).insertText('b', 9)
  assert.equal(tr.steps.length, 2)
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, '- 甲\n\nab',
    'two-step batch commits one paragraph, prefix latched to the first step')
  assert.ok(h.view.state.doc.eq(doc(bl(li(null, p(text('甲')))), p(text('ab')))),
    'the view keeps the user typing as ONE paragraph — no repair restructuring')
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((entry) => entry.type === 'projection-mismatch').length,
    0,
    'cheap-path verify passes: no repair churn'
  )
}

// Case 17 (Task 2, plan 3: 块尾连续 Enter): repeated Enter INSIDE the
// split-placeholder chain must extend it — a SECOND (and THIRD) Enter at the
// placeholder's own raw anchor used to be refused (`resolveBlock` finds no
// block on a blank-line-run offset). Byte states below are the pure-kernel
// oracle's own output (routeStructuralKey chained three times from '甲乙\n'
// at raw offset 2, the block end — see the task's derivation transcript):
// '甲乙\n\n\n' -> '甲乙\n\n\n\n' -> '甲乙\n\n\n\n\n', then typing '丙' into the
// LAST placeholder yields '甲乙\n\n\n\n丙\n' (4 separator newlines: the K
// Enters pressed = the separator's `K+1` newline-byte count once real
// content replaces the last placeholder — same K=1 shape Case 13 already
// locks with its own '甲乙\n\n丙\n' single-Enter continuation).
{
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 3))) // end of 甲乙

  // Enter #1: unchanged existing degenerate-split behavior (same as Case 13).
  assert.equal(h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n\n')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')), p())))
  assert.equal(h.view.state.selection.head, 5)
  assert.deepEqual(h.controller.kernel.map.virtualBlockAt(5), { raw: 4, prefix: '' })

  // Enter #2: NEW — extends the chain instead of being refused. A second
  // empty placeholder appears, the kernel byte gains exactly one more
  // `ending`, and the caret follows into the new (now last) placeholder.
  assert.equal(h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n\n\n', 'one more ending extends the run')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')), p(), p())),
    'a SECOND empty placeholder is materialized, the first one is NOT discarded')
  assert.equal(h.view.state.selection.head, 7, 'caret follows into the new (last) placeholder')
  assert.deepEqual(h.controller.kernel.map.virtualBlockAt(7), { raw: 5, prefix: '' })
  // The FIRST placeholder is still vouched too — the whole chain, not just
  // the newest link.
  assert.deepEqual(h.controller.kernel.map.virtualBlockAt(5), { raw: 4, prefix: '' })

  // Enter #3: the chain keeps extending — proves this isn't a one-shot
  // special case hardcoded for exactly two placeholders.
  assert.equal(h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n\n\n\n')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')), p(), p(), p())))
  assert.equal(h.view.state.selection.head, 9)
  assert.deepEqual(h.controller.kernel.map.virtualBlockAt(9), { raw: 6, prefix: '' })

  // Typing into the LAST placeholder collapses the WHOLE chain into one real
  // paragraph — every placeholder before it was purely a PM-view convenience
  // (mdast can never distinguish "3 blank lines" from "5 blank lines", only
  // the raw bytes carry that), so the reconcile correctly discards them all
  // once real content exists.
  const tr = h.view.state.tr.insertText('丙', 9)
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n\n\n丙\n',
    'typed text becomes a new paragraph, all three Enters preserved as separator bytes')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')), p(text('丙')))),
    'every placeholder in the chain collapses once real content lands')
  assert.equal(h.controller.kernel.map.pmPosToRaw(5), 6, 'map realigned to the now-real paragraph (before 丙)')
  assert.equal(h.controller.kernel.map.pmPosToRaw(6), 7, 'map realigned to the now-real paragraph (after 丙)')

  // Undo granularity: each Enter (create + 2 extends) and the typed char are
  // FOUR separate undo groups, unwound one at a time.
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n\n\n\n')
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n\n\n')
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n\n')
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n', 'four undos fully unwind back to the original bytes')
}

// Case 18 (review fix): extendTrailingPlaceholder's atomic rollback. Forces
// bindMap's buildProjectionMap call to fail AFTER kernel.doc has already
// advanced and the new placeholder node has already been inserted into the
// view, and proves BOTH sides roll back together — never just one.
//
// The failure is forced the same way Case 9 forces a history desync: by
// directly corrupting `kernel.doc` on the live controller (an accepted
// technique in this file for exercising a defensive path with no other
// entry point). After the first Enter (`kernel.doc.text === '甲乙\n\n\n'`,
// view `doc(p(甲乙), p())`), `kernel.doc` is replaced with a SAME-WIDTH but
// different-character real paragraph ('丁\n\n\n' — 1 char, not 2) while the
// VIEW keeps showing the original 2-char '甲乙'. This is invisible to the
// pure-kernel Enter derivation (routeStructuralKey only cares about the
// trailing-gap OFFSET, which is structurally identical either way) and
// invisible to the CONTROLLER's own map (unchanged, still built against the
// real '甲乙'), so the second Enter is accepted and proceeds exactly like
// Case 17's — right up until the extended chain's bindMap call, which DOES
// notice: the corrupted kernel text's real paragraph is now only 1 char
// wide while the view's real paragraph is still 2 (`buildCharacterMap`'s
// `visibleLength` vs `pm.node.content.size`), so buildProjectionMap rejects
// the WHOLE map.
{
  globalThis.__hmKernelDiagnostics = []
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 3))) // end of 甲乙

  assert.equal(h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n\n\n')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')), p())))
  assert.equal(h.view.state.selection.head, 5)

  // Corrupt: same trailing-blank structure (so the pure Enter derivation and
  // the EXISTING map's pmPosToRaw both still resolve identically), but the
  // real paragraph is now width-mismatched against what the view shows.
  const beforeCorruption = h.controller.kernel.doc
  h.controller.kernel.doc = { text: '丁\n\n\n', revision: beforeCorruption.revision }
  const notifBefore = h.notifications.length

  const handled = h.controller.structuralHandlers.Enter(h.view.state, h.view.dispatch, h.view)
  assert.equal(handled, true, 'the key is swallowed either way, success or refusal')

  // kernel.doc must be back to EXACTLY the corrupted pre-attempt value —
  // never the extended '丁\n\n\n\n' the failed attempt computed internally.
  assert.equal(h.controller.kernel.doc.text, '丁\n\n\n',
    'kernel.doc must roll back to its pre-extend value on a failed chain extension')
  // The view must be back to exactly ONE placeholder — the second (failed)
  // insert removed, not left orphaned.
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')), p())),
    'the view must roll back to the pre-extend shape (one placeholder), not two')

  assert.ok(
    globalThis.__hmKernelDiagnostics.some((entry) => entry.type === 'split-placeholder-unprovable'),
    'the failed extension must be diagnosed'
  )
  assert.ok(h.notifications.length > notifBefore, 'the failed extension must notify the user')
  assert.ok(
    h.notifications.at(-1).includes('projection-mismatch'),
    `notification must carry the actual KERNEL_CODES.PROJECTION code, got: ${h.notifications.at(-1)}`
  )
}

// Case 12 (Plan 3 Task 4): code-block end-to-end — a CM-style multi-line
// text commit, then a language switch, both landing in `handleTransactions`
// as pass-through (undefined), never a veto, kernel bytes advancing exactly
// like a real CodeMirror forwardUpdate + language-picker session would drive
// them.
// The live view doc carries an explicit trailing EMPTY paragraph after the
// code_block — mirroring what `@milkdown/plugin-trailing` really appends
// after any non-paragraph/heading final block in the live editor (this
// stub harness has no such plugin, so the test builds it by hand, same
// convention every other bullet_list/code_block-ending fixture in this file
// uses). Without it, `safeParse`'s `withTrailingParagraph` (which the
// verify-diff path always runs) would synthesize one on the PARSED side
// only, a onesided mismatch that has nothing to do with this task's own
// logic.
{
  globalThis.__hmKernelDiagnostics = []
  const h = makeHarness('```js\nab\n```\n', doc(cb('js', 'ab'), p()))
  assert.equal(h.controller.attachAfterCreate(), true, 'code_block-only doc must map')

  // (a) multi-line insert 'X\nY' between 'a' and 'b' (content offset 1 ->
  // PM pos 2, code_block is the doc's sole child: open@0, content start@1).
  const tr1 = h.view.state.tr.insertText('X\nY', 2)
  const verdict1 = dispatchThrough(h, tr1)
  await flushMicrotasks()
  assert.equal(verdict1, undefined, 'code_block newline-bearing insert is allowed (no veto)')
  assert.equal(h.controller.kernel.doc.text, '```js\naX\nYb\n```\n')
  assert.equal(h.controller.kernel.doc.revision, 1)
  assert.deepEqual(h.changes.at(-1), ['```js\naX\nYb\n```\n', false])
  assert.equal(h.view.state.doc.textContent, 'aX\nYb', 'view content unchanged by the pass-through')

  // (b) language switch 'js' -> 'python' on the same (still sole-child, pos
  // 0) code_block.
  const tr2 = h.view.state.tr.setNodeAttribute(0, 'language', 'python')
  const verdict2 = dispatchThrough(h, tr2)
  await flushMicrotasks()
  assert.equal(verdict2, undefined, 'code-language commit is allowed (no veto)')
  assert.equal(h.controller.kernel.doc.text, '```python\naX\nYb\n```\n')
  assert.equal(h.controller.kernel.doc.revision, 2)
  assert.deepEqual(h.changes.at(-1), ['```python\naX\nYb\n```\n', false])
  assert.equal(h.view.state.doc.firstChild.attrs.language, 'python')

  // No diagnostics from either commit (the verify-diff cheap path found no
  // mismatch against either fixture, and the map rebound cleanly both times).
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((entry) =>
      entry.type === 'projection-mismatch' || entry.type === 'map-refresh-failed').length,
    0,
    'neither commit should have needed a projection repair'
  )
}

// Case 13 (CRLF un-narrowing, 2026-08-17): a CRLF-lineEnding code block is
// EDITABLE end to end. Supersedes the 2026-08-16 fix-review ADR, which
// vetoed every such edit because the vendored CodeMirrorBlock bridge dropped
// '\r' from its own position model; `editor-codeblock-crlf.js` fixes that
// bridge at the source, so the slice arriving here already spells its break
// '\r\n' (the block's dominant ending) and the gateway commits it verbatim.
// This case proves (i) the commit is byte-exact CRLF-preserving, (ii) ZERO
// projection-mismatch diagnostics — no repair churn, which was THE P3-4
// symptom, (iii) the residual bare-'\n' shape still fails closed, and (iv)
// neither outcome locks the rest of the document out.
{
  globalThis.__hmKernelDiagnostics = []
  const initialMd = '```js\r\nab\r\ncd\r\n```\r\n甲乙\r\n'
  const h = makeHarness(initialMd, doc(cb('js', 'ab\r\ncd'), p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true, 'CRLF-code + paragraph doc must map')

  // (i) code_block open@0, content 'ab\r\ncd' [1,7) (a@1 b@2 \r@3 \n@4 c@5
  // d@6). PM 3 (after 'b', before the break) -> raw 9. The patched bridge
  // hands the break already spelled '\r\n'.
  const tr1 = h.view.state.tr.insertText('X\r\nY', 3)
  const verdict1 = dispatchThrough(h, tr1)
  await flushMicrotasks()
  assert.equal(verdict1, undefined, 'a CRLF code_block edit must commit, not veto')
  assert.equal(
    h.controller.kernel.doc.text,
    '```js\r\nabX\r\nY\r\ncd\r\n```\r\n甲乙\r\n',
    'kernel bytes must be byte-exact CRLF-preserving'
  )
  assert.equal(/\r(?!\n)/.test(h.controller.kernel.doc.text), false, 'no lone \\r may be injected')
  assert.equal(h.view.state.doc.textContent, 'abX\r\nY\r\ncd甲乙', 'the view carries the same bytes')
  // (ii) THE regression this un-narrowing had to earn: the cheap-path
  // verify must pass, so no repair reconcile is ever scheduled.
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((entry) => entry.type === 'projection-mismatch').length,
    0,
    'a CRLF code commit must pass cheap-path verify — zero repair churn'
  )

  // (iii) fail-closed residual: a bare '\n' break in a CRLF block (what the
  // bridge emits only when the block's own text holds no '\r' — see
  // commitPlainText's ADR) is refused, kernel bytes untouched, and the
  // defensive veto-after-CM-applied resync still runs for a code_block
  // target (pushing its own diagnostic even when the reconcile is a no-op).
  const tr2 = h.view.state.tr.insertText('Z\nW', 3)
  const verdict2 = dispatchThrough(h, tr2)
  await flushMicrotasks()
  assert.deepEqual(verdict2, { veto: true }, 'a bare-\\n break in a CRLF block must be vetoed')
  assert.equal(h.controller.kernel.doc.text, '```js\r\nabX\r\nY\r\ncd\r\n```\r\n甲乙\r\n',
    'kernel bytes untouched by the refused edit')
  assert.equal(h.view.state.doc.textContent, 'abX\r\nY\r\ncd甲乙',
    'view untouched after veto (dispatch protocol skips updateState)')
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((entry) => entry.type === 'cm-veto-resync').length,
    1,
    'a code_block-targeting veto must schedule the defensive nodeview resync'
  )
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((entry) =>
      entry.type === 'cm-veto-resync-failed' || entry.type === 'cm-veto-resync-parse-failure').length,
    0,
    'the resync reconcile must be a clean no-op when the view already agrees with the kernel'
  )

  // (iv) no lockout: an ordinary edit into the paragraph ('甲乙') still
  // commits normally. The code_block's content is now 10 chars
  // ('abX\r\nY\r\ncd'), nodeSize 12, so the paragraph opens at 12 and its
  // content start is 13: 甲@13, 乙@14.
  const tr3 = h.view.state.tr.insertText('丙', 14)
  const verdict3 = dispatchThrough(h, tr3)
  await flushMicrotasks()
  assert.equal(verdict3, undefined, 'an unrelated edit after a refused code-block edit must not be vetoed')
  assert.equal(h.controller.kernel.doc.text, '```js\r\nabX\r\nY\r\ncd\r\n```\r\n甲丙乙\r\n')
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((entry) => entry.type === 'projection-mismatch').length,
    0,
    'the follow-up commit must also pass cheap-path verify cleanly'
  )
}

// ---- Plan 3 Task 5: per-block CM editability gate + Mod-Enter exit ----
import { classifyBlockedCmKeydown } from '../src/renderer/src/components/editor-kernel-cm-bridge.js'

// Case T5a: the pure keydown allowlist for a BLOCKED code block. Mutating
// keys (printables, Enter/Backspace/Delete/Tab, paste/cut combos, the
// defaultKeymap's editing chords) block; navigation/selection/copy/IME/the
// kernel-owned combos pass.
{
  const block = (event) => assert.equal(classifyBlockedCmKeydown(event), 'block', JSON.stringify(event))
  const pass = (event) => assert.equal(classifyBlockedCmKeydown(event), 'pass', JSON.stringify(event))
  block({ key: 'a' })
  block({ key: 'A', shiftKey: true })
  block({ key: 'Enter' })
  block({ key: 'Backspace' })
  block({ key: 'Delete' })
  block({ key: 'Tab' })
  block({ key: 'v', metaKey: true }) // paste
  block({ key: 'x', ctrlKey: true }) // cut
  block({ key: '/', ctrlKey: true }) // toggleComment
  block({ key: '[', metaKey: true }) // indentLess
  block({ key: 'k', metaKey: true, shiftKey: true }) // deleteLine
  // Alt-Arrow vertical chords are doc-mutating in the defaultKeymap
  // (moveLineUp/Down; +Shift copyLineUp/Down) — reviewer-proved leak: left
  // passing they reorder/duplicate a blocked block's CM lines while the
  // kernel vetoes the bytes.
  block({ key: 'ArrowUp', altKey: true }) // moveLineUp
  block({ key: 'ArrowDown', altKey: true }) // moveLineDown
  block({ key: 'ArrowUp', altKey: true, shiftKey: true }) // copyLineUp
  block({ key: 'ArrowDown', altKey: true, shiftKey: true }) // copyLineDown
  pass({ key: 'ArrowUp', altKey: true, metaKey: true }) // addCursor — selection-only
  pass({ key: 'ArrowLeft', altKey: true }) // cursorSyntaxLeft — pure navigation
  pass({ key: 'ArrowLeft' })
  pass({ key: 'ArrowDown', shiftKey: true }) // selection extension
  pass({ key: 'Home' })
  pass({ key: 'End' })
  pass({ key: 'PageDown' })
  pass({ key: 'Escape' })
  pass({ key: 'Shift' }) // bare modifier — must never be eaten
  pass({ key: 'Meta' })
  pass({ key: 'F5' })
  pass({ key: 'c', metaKey: true }) // copy
  pass({ key: 'a', ctrlKey: true }) // select-all
  pass({ key: 'z', metaKey: true }) // kernel undo (bridge keymap owns it)
  pass({ key: 'z', metaKey: true, shiftKey: true }) // kernel redo
  pass({ key: 'y', ctrlKey: true }) // kernel redo (win)
  pass({ key: 'Enter', metaKey: true }) // kernel exit-code (bridge keymap owns it)
  pass({ key: 'Process', keyCode: 229 }) // IME — inputHandler backstops
  pass({ key: 'a', isComposing: true })
  block(null) // no event info -> fail closed
}

// Case T5b: isCmBlockEditable — the per-instance identity is the CM
// editor's DOM resolved through view.posAtDOM into the CURRENT map's
// blockPairs. An LF js block (charMap proven) reports editable, a CRLF block
// now reports editable too (un-narrowing, 2026-08-17), and a failed DOM
// resolution reports non-editable (fail-closed). A `mermaid` block is the
// remaining always-blocked shape.
{
  const h = makeHarness('```js\nab\n```\n甲\n', doc(cb('js', 'ab'), p(text('甲'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const cmDom = {}
  h.view.posAtDOM = (dom) => {
    assert.equal(dom, cmDom, 'identity resolution must use the CM instance dom')
    return 1 // interior of the code_block node [0,4)
  }
  assert.equal(h.controller.isCmBlockEditable({ dom: cmDom }), true, 'LF js block must be editable')
  // A position outside every code_block pair (the paragraph) fails closed.
  h.view.posAtDOM = () => 6
  assert.equal(h.controller.isCmBlockEditable({ dom: cmDom }), false)
  // posAtDOM throwing (detached DOM) fails closed.
  h.view.posAtDOM = () => { throw new Error('not inside the editor') }
  assert.equal(h.controller.isCmBlockEditable({ dom: cmDom }), false)

  const crlf = makeHarness('```js\r\nab\r\ncd\r\n```\r\n甲乙\r\n', doc(cb('js', 'ab\r\ncd'), p(text('甲乙'))))
  assert.equal(crlf.controller.attachAfterCreate(), true)
  crlf.view.posAtDOM = () => 1
  assert.equal(crlf.controller.isCmBlockEditable({ dom: {} }), true, 'CRLF block must now be editable')

  // The still-blocked shape: a preview-rendered language never claims a
  // charMap, so its CM instance stays keydown-gated.
  const mermaid = makeHarness('```mermaid\ngraph TD\n```\n', doc(cb('mermaid', 'graph TD')))
  assert.equal(mermaid.controller.attachAfterCreate(), true)
  mermaid.view.posAtDOM = () => 1
  assert.equal(mermaid.controller.isCmBlockEditable({ dom: {} }), false, 'mermaid block must stay non-editable')
}

// Case T5c: runExitCode at document end — exit bytes are written
// source-first, the view gains the trailing paragraph, and the caret lands
// in it via the trailing-virtual pair (no voucher needed).
{
  const h = makeHarness('```js\nab\n```\n', doc(cb('js', 'ab')))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.posAtDOM = () => 1
  const handled = h.controller.runExitCode({ dom: {} })
  assert.equal(handled, true)
  assert.equal(h.controller.kernel.doc.text, '```js\nab\n```\n\n\n')
  assert.ok(h.view.state.doc.eq(doc(cb('js', 'ab'), p())), 'view gains the trailing empty paragraph')
  assert.equal(h.view.state.selection.head, 5, 'caret parked inside the new trailing paragraph')
  assert.deepEqual(h.changes.at(-1), ['```js\nab\n```\n\n\n', false])
  // The next keystroke lands in the paragraph, not the code block: typing
  // at the caret commits with the trailing-virtual separator semantics.
  const tr = h.view.state.tr.insertText('X', 5)
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, '```js\nab\n```\n\n\nX')
}

// Case T5d: runExitCode mid-document — the caret anchor sits on a blank
// line the reparse cannot show, so the controller materializes a vouched
// placeholder right after the code block; the first typed character fills
// it and becomes its own paragraph between the code block and the
// following content.
{
  const h = makeHarness('```js\nab\n```\n甲\n', doc(cb('js', 'ab'), p(text('甲'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.posAtDOM = () => 1
  const handled = h.controller.runExitCode({ dom: {} })
  assert.equal(handled, true)
  assert.equal(h.controller.kernel.doc.text, '```js\nab\n```\n\n\n甲\n')
  assert.ok(
    h.view.state.doc.eq(doc(cb('js', 'ab'), p(), p(text('甲')))),
    'placeholder paragraph materialized between the code block and the following paragraph'
  )
  assert.equal(h.view.state.selection.head, 5, 'caret parked inside the placeholder')
  // Typing into the placeholder commits at the vouched raw anchor and the
  // typed text parses as its OWN paragraph (blank line before `甲` kept).
  const tr = h.view.state.tr.insertText('X', 5)
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined)
  assert.equal(h.controller.kernel.doc.text, '```js\nab\n```\nX\n\n甲\n')
  assert.ok(h.view.state.doc.eq(doc(cb('js', 'ab'), p(text('X')), p(text('甲')))))
  // Undo grouping (reviewer ride-along): the exit is ONE kernel history
  // group and the placeholder tr rode addToHistory:false — so undo #1 pops
  // only the typed char (back to the post-exit bytes) and undo #2 pops the
  // WHOLE exit in one step (back to the exact pre-exit bytes), never
  // replaying the placeholder as its own undo unit.
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '```js\nab\n```\n\n\n甲\n')
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '```js\nab\n```\n甲\n')
  assert.ok(
    h.view.state.doc.eq(doc(cb('js', 'ab'), p(text('甲')))),
    'undoing the exit reconciles the placeholder away (parse never contains it)'
  )
}

// Case T5e: runExitCode refusals — an unmapped CM instance notifies and
// swallows; kernel state never moves.
{
  const h = makeHarness('```js\nab\n```\n', doc(cb('js', 'ab')))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.posAtDOM = () => { throw new Error('detached') }
  const before = h.notifications.length
  assert.equal(h.controller.runExitCode({ dom: {} }), true, 'refusal still swallows the key')
  assert.equal(h.controller.kernel.doc.text, '```js\nab\n```\n')
  assert.ok(h.notifications.length > before, 'refusal notifies')
}

// Case T5f (final-review finding, 2026-08-16): the from-readonly
// language-switch refusal is lifted — mermaid -> js must commit (not veto),
// and the map's UNCONDITIONAL rebind after a code-language commit (see the
// `code-language` case's own comment) must leave the block genuinely
// editable on the very next transaction: switch then type, end to end.
{
  globalThis.__hmKernelDiagnostics = []
  const h = makeHarness('```mermaid\ngraph TD\n```\n', doc(cb('mermaid', 'graph TD'), p()))
  assert.equal(h.controller.attachAfterCreate(), true, 'mermaid-only doc must map')
  assert.equal(h.controller.kernel.map.blockPairs[0].charMap, null, 'sanity: mermaid pair starts non-editable')

  // (a) mermaid -> js language switch.
  const tr1 = h.view.state.tr.setNodeAttribute(0, 'language', 'js')
  const verdict1 = dispatchThrough(h, tr1)
  await flushMicrotasks()
  assert.equal(verdict1, undefined, 'mermaid -> js switch is allowed through (no veto)')
  assert.equal(h.controller.kernel.doc.text, '```js\ngraph TD\n```\n')
  assert.equal(h.view.state.doc.firstChild.attrs.language, 'js')
  assert.ok(h.controller.kernel.map.blockPairs[0].charMap,
    'the rebound map must carry a real charMap for the block immediately after the switch')

  // (b) typing right after the switch: a plain-text insert at the block's
  // content start (PM pos 1, doc's sole non-placeholder child) must commit,
  // proving the block is genuinely editable now, not just reclassified.
  const tr2 = h.view.state.tr.insertText('X', 1)
  const verdict2 = dispatchThrough(h, tr2)
  await flushMicrotasks()
  assert.equal(verdict2, undefined, 'typing into the newly-js block must commit, not veto')
  assert.equal(h.controller.kernel.doc.text, '```js\nXgraph TD\n```\n')
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((entry) => entry.type === 'projection-mismatch').length,
    0,
    'both the switch and the follow-up type must pass cheap-path verify cleanly'
  )
}

// ---- Plan 4 Task 3: inline mark toggles, end-to-end through the dispatch
// protocol. Every toggle transaction is built by the REAL prosemirror
// `toggleMark` (the function Crepe's toolbar commands / applyTextFormat /
// the preset keymaps bottom out in) against the live view state — the exact
// toolbar-shaped dispatch the gateway classifies.
const toggleVia = (h, markType, from, to) => {
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, from, to)))
  let captured = null
  toggleMark(markType)(h.view.state, (tr) => { captured = tr })
  return captured
}

// Case M1: strong wrap → source gains '**', the veto'd PM transaction is
// replaced by the kernel's own reconcile whose doc carries a REAL strong
// mark, and the content stays SELECTED (range restore — the toolbar must
// stay up for an immediate second toggle).
{
  const h = makeHarness('甲乙丙\n', doc(p(text('甲乙丙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const before = h.notifications.length
  const tr = toggleVia(h, schema.marks.strong, 2, 3) // select 乙
  assert.ok(tr, 'toggleMark must dispatch')
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.deepEqual(verdict, { veto: true }, 'the original PM mark transaction is always vetoed')
  assert.equal(h.controller.kernel.doc.text, '甲**乙**丙\n', 'source gains the ** markers, byte-exact')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲'), schema.text('乙', [schema.mark('strong')]), text('丙')))),
    'the reconciled PM doc carries a real strong mark (reparse authority)')
  assert.equal(h.view.state.selection.from, 2, 'content stays selected: from')
  assert.equal(h.view.state.selection.to, 3, 'content stays selected: to')
  assert.equal(h.view.state.selection.empty, false)
  assert.deepEqual(h.changes.at(-1), ['甲**乙**丙\n', false], 'onChange publishes the kernel text')
  assert.equal(h.notifications.length, before, 'a successful toggle never toasts')

  // Case M2 (same session): toggling the SAME range again unwraps — the
  // toolbar-shaped RemoveMarkStep routes to the kernel's exact-cover unwrap.
  const tr2 = toggleVia(h, schema.marks.strong, 2, 3)
  assert.equal(tr2.steps[0].constructor.name, 'RemoveMarkStep')
  const verdict2 = dispatchThrough(h, tr2)
  await flushMicrotasks()
  assert.deepEqual(verdict2, { veto: true })
  assert.equal(h.controller.kernel.doc.text, '甲乙丙\n', 'unwrap removes both marker runs, byte-exact')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙丙')))))
  assert.equal(h.view.state.selection.from, 2)
  assert.equal(h.view.state.selection.to, 3)

  // Case M3 (same session): kernel history owns the toggles — each is its
  // own undo group. Undo #1 restores the wrapped bytes; undo #2 the plain
  // original; redo re-wraps.
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲**乙**丙\n', 'undo #1 restores the wrap')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲'), schema.text('乙', [schema.mark('strong')]), text('丙')))))
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙丙\n', 'undo #2 restores the original')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙丙')))))
  assert.equal(h.controller.historyHandlers.redo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲**乙**丙\n', 'redo re-wraps')
}

// Case M4 (ADR pin — the pre-commit map guard, `requireMap`): a toggle whose
// RESULT document cannot rebuild a projection map refuses FAIL-CLOSED,
// BEFORE any mutation — bytes, view, history all unchanged, with a
// notification. One shape still hits it today (probe evidence in the Task 3
// report):
//  - highlight (ANY selection): the committed `==` bytes are literal text
//    to the kernel chain (no highlight plugin there) but invisible to the
//    Crepe parse — the block's content-size identity check always fails.
// (Multi-char inline code used to be pinned here too — P4-3.5's per-char
// inlineCode units healed it; it now COMMITS, see Case M4b below.)
// When the projection map learns the highlight pairing, this assertion is
// the one to flip.
for (const [markName, from, to, label] of [
  ['highlight', 2, 3, 'highlight']
]) {
  const h = makeHarness('甲乙丙\n', doc(p(text('甲乙丙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const before = h.notifications.length
  const tr = toggleVia(h, schema.marks[markName], from, to)
  assert.ok(tr)
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.deepEqual(verdict, { veto: true }, label + ' toggle must veto')
  assert.equal(h.controller.kernel.doc.text, '甲乙丙\n', label + ': kernel bytes untouched')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙丙')))), label + ': view untouched')
  assert.ok(h.notifications.length > before, label + ': refusal notifies')
  assert.ok(
    globalThis.__hmKernelDiagnostics.some((entry) => entry.type === 'projection-unmappable-refused'),
    label + ': the pre-commit map guard is the refusing party'
  )
}

// Case M4b: inline-code wrap/unwrap commits end-to-end — single-char AND,
// since P4-3.5's per-char inlineCode units, multi-char too (the old atom
// unit made `requireMap` refuse any N>1 wrap; the flipped pin lives here).
{
  const h = makeHarness('甲乙丙\n', doc(p(text('甲乙丙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const tr = toggleVia(h, schema.marks.inlineCode, 2, 3)
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.deepEqual(verdict, { veto: true })
  assert.equal(h.controller.kernel.doc.text, '甲`乙`丙\n', 'single-char code wrap commits, byte-exact')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲'), schema.text('乙', [schema.mark('inlineCode')]), text('丙')))),
    'the reconciled doc carries a real inlineCode mark')
  assert.ok(h.controller.kernel.map, 'the map rebinds — no post-toggle lock-up')
  // Unwrap it again: the marked run's content range resolves through the
  // normal inlineMarkAt exact-cover path (the atom fallback is gone).
  const tr2 = toggleVia(h, schema.marks.inlineCode, 2, 3)
  const verdict2 = dispatchThrough(h, tr2)
  await flushMicrotasks()
  assert.deepEqual(verdict2, { veto: true })
  assert.equal(h.controller.kernel.doc.text, '甲乙丙\n', 'single-char code unwrap restores the original')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙丙')))))

  // Multi-char wrap (P4-3.5 flipped pin): select 乙丙, toggle code →
  // requireMap passes because the reparse now maps (per-char units), the
  // source gains the backticks byte-exactly, selection stays on the content.
  const before = h.notifications.length
  const tr3 = toggleVia(h, schema.marks.inlineCode, 2, 4)
  const verdict3 = dispatchThrough(h, tr3)
  await flushMicrotasks()
  assert.deepEqual(verdict3, { veto: true })
  assert.equal(h.controller.kernel.doc.text, '甲`乙丙`\n', 'multi-char code wrap commits, byte-exact')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲'), schema.text('乙丙', [schema.mark('inlineCode')])))),
    'the reconciled doc carries a real multi-char inlineCode run')
  assert.ok(h.controller.kernel.map, 'the rebound map is live (no lock-up)')
  assert.equal(h.view.state.selection.from, 2, 'content stays selected: from')
  assert.equal(h.view.state.selection.to, 4, 'content stays selected: to')
  assert.equal(h.notifications.length, before, 'a successful multi-char wrap never toasts')

  // …and unwrap straight back.
  const tr4 = toggleVia(h, schema.marks.inlineCode, 2, 4)
  const verdict4 = dispatchThrough(h, tr4)
  await flushMicrotasks()
  assert.deepEqual(verdict4, { veto: true })
  assert.equal(h.controller.kernel.doc.text, '甲乙丙\n', 'multi-char code unwrap restores the original')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙丙')))))
}

// Case M7 (P4-3.5 Fix B — flips the old blanket "any mark in the textblock
// refuses all typing" behavior): after a real strong wrap, PLAIN typing in
// the same paragraph commits through the normal plain-text path; a plain
// char at the run's trailing edge lands OUTSIDE the closing markers
// (rawNeutralInsert); typing with an INHERITED mark stays refused.
{
  const h = makeHarness('甲乙丙\n', doc(p(text('甲乙丙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const tr = toggleVia(h, schema.marks.strong, 2, 3) // bold 乙
  dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(h.controller.kernel.doc.text, '甲**乙**丙\n')

  // (a) plain X at the end of the paragraph (inside the plain 丙 run).
  const before = h.notifications.length
  const trType = h.view.state.tr.replaceWith(4, 4, text('X'))
  const verdict = dispatchThrough(h, trType)
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'plain typing in a marked paragraph must commit (no veto)')
  assert.equal(h.controller.kernel.doc.text, '甲**乙**丙X\n', 'bytes commit at the right raw offset')
  assert.equal(h.notifications.length, before, 'no toast for legitimate typing')
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((e) => e.type === 'projection-mismatch').length, 0,
    'cheap-path verify passes — PM view and committed bytes agree'
  )

  // undo the typing, then (b) plain X right AFTER the bold run: the neutral
  // resolver writes it after the closing '**', never inside.
  assert.equal(h.controller.historyHandlers.undo(h.view.state, h.view.dispatch, h.view), true)
  assert.equal(h.controller.kernel.doc.text, '甲**乙**丙\n')
  const trEdge = h.view.state.tr.replaceWith(3, 3, text('X'))
  const verdictEdge = dispatchThrough(h, trEdge)
  await flushMicrotasks()
  assert.equal(verdictEdge, undefined)
  assert.equal(h.controller.kernel.doc.text, '甲**乙**X丙\n',
    'plain char at the run edge lands OUTSIDE the markers')
  assert.equal(
    globalThis.__hmKernelDiagnostics.filter((e) => e.type === 'projection-mismatch').length, 0,
    'edge insert also verifies cleanly'
  )

  // (c) typing WITH the inherited strong mark (real keystroke inside the
  // run) → marked slice → veto + toast: the inheritance trap stays closed.
  const notifBefore = h.notifications.length
  const trMarked = h.view.state.tr.replaceWith(3, 3, schema.text('Y', [schema.mark('strong')]))
  const verdictMarked = dispatchThrough(h, trMarked)
  assert.deepEqual(verdictMarked, { veto: true })
  assert.equal(h.controller.kernel.doc.text, '甲**乙**X丙\n', 'kernel bytes untouched')
  assert.ok(h.notifications.length > notifBefore, 'marked-slice refusal notifies')
}

// Case M5: link toggle (no kernel kind) → blocked/veto, nothing changes.
{
  const h = makeHarness('甲乙丙\n', doc(p(text('甲乙丙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  const before = h.notifications.length
  const tr = toggleVia(h, schema.marks.link, 2, 3)
  assert.ok(tr)
  const verdict = dispatchThrough(h, tr)
  assert.deepEqual(verdict, { veto: true })
  assert.equal(h.controller.kernel.doc.text, '甲乙丙\n')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙丙')))))
  assert.ok(h.notifications.length > before, 'link refusal notifies')
}

// Case M6 (stored-marks ADR): the empty-selection mark-shortcut guard.
// Empty selection → swallowed (true) + "select text first" toast, so the
// preset toggleMark never runs and no stored mark ever arms (the typing
// trap: an armed stored mark makes every next keystroke a marked-slice
// veto). Non-empty selection → pass-through (false) to the preset, whose
// transaction the gateway owns (Case M1). Inactive controller → false.
{
  const h = makeHarness('甲乙丙\n', doc(p(text('甲乙丙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 2, 2)))
  const before = h.notifications.length
  assert.equal(h.controller.markShortcutGuard(h.view.state), true, 'empty selection: swallowed')
  assert.ok(h.notifications.length > before, 'empty selection: toasts "select text first"')
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 2, 3)))
  assert.equal(h.controller.markShortcutGuard(h.view.state), false, 'real selection: falls through to the preset')
  assert.equal(typeof h.controller.marksKeymap, 'function', 'marksKeymap is exposed for registration')
  assert.ok(h.controller.marksKeymap(), 'marksKeymap builds a plugin')
}

// ---- Plan 4 Task 4: quote toggle. `runQuoteToggle` is NOT reached via
// dispatchThrough (no PM `wrapInBlockTypeCommand`/AddMarkStep transaction is
// ever built) — the slash menu's 'quote' item calls straight into
// `controller.runQuoteToggle(view)` (see editor-slash-menu.js's `quoteRun` /
// editor-crepe-setup.js's `quoteToggle` option), so these cases call it
// directly, mirroring runExitCode's own direct-call pattern (Case T5c-T5f)
// rather than toggleVia's PM-dispatch shape (Case M1 and friends).

// Case Q1: wrap a plain paragraph. Caret at PM pos 2 (raw offset 1, between
// 甲 and 乙) in '甲乙\n' — the kernel gains a blockquote wrapping the SAME
// paragraph, the view reconciles to it, and the caret is restored at the
// equivalent raw position (still between 甲 and 乙, shifted by the 2 inserted
// bytes) — same "stay on the same character" contract every other structural
// command here locks (splitTextBlock's own 段首 Enter cases, indentListItem).
{
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 2)))
  const handled = h.controller.runQuoteToggle(h.view)
  assert.equal(handled, true)
  assert.equal(h.controller.kernel.doc.text, '> 甲乙\n')
  // withTrailingParagraph appends an empty trailing paragraph: the doc's
  // only top-level child is now `blockquote`, not paragraph/heading — same
  // append @milkdown/plugin-trailing performs live (see the mermaid/code
  // fixtures above for the same convention).
  assert.ok(h.view.state.doc.eq(doc(bq(p(text('甲乙'))), p())), 'view reconciled to the quoted paragraph')
  assert.equal(h.view.state.selection.head, 3, 'caret restored between 甲 and 乙, inside the new blockquote')
  assert.deepEqual(h.changes.at(-1), ['> 甲乙\n', false])

  // Case Q2: toggling AGAIN at the same (now-quoted) content unwraps it back
  // to the exact original bytes and PM shape — the round-trip this command's
  // whole ADR rests on (see quote-toggle.js's header comment).
  const handled2 = h.controller.runQuoteToggle(h.view)
  assert.equal(handled2, true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n')
  assert.ok(h.view.state.doc.eq(doc(p(text('甲乙')))), 'view reconciled back to the plain paragraph')
  assert.equal(h.view.state.selection.head, 2, 'caret restored to the original PM position')
  assert.deepEqual(h.changes.at(-1), ['甲乙\n', false])

  // Case Q3: undo grouping — each toggle is its own history group (default
  // `record: true` via applyKernelTransaction), so one undo exactly reverses
  // the unwrap (back to quoted) and a second undo exactly reverses the wrap
  // (back to the original plain paragraph), never merging the two.
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '> 甲乙\n', 'first undo restores the quoted form')
  assert.equal(h.controller.runHistory('undo'), true)
  assert.equal(h.controller.kernel.doc.text, '甲乙\n', 'second undo restores the original plain paragraph')
}

// Case Q4: refusal — no projection map (pre-attach) swallows the call with a
// notification and leaves the kernel doc untouched, same fail-closed shape
// every other kernel entry point uses when `kernel.map` isn't proven yet.
{
  const h = makeHarness('甲乙\n', doc(p(text('甲乙'))))
  // Deliberately no attachAfterCreate(): kernel.map stays null.
  const before = h.notifications.length
  const handled = h.controller.runQuoteToggle(h.view)
  assert.equal(handled, false, 'inactive controller (never attached) does not intercept the call')
  assert.equal(h.controller.kernel.doc.text, '甲乙\n', 'kernel bytes untouched')
  assert.equal(h.notifications.length, before, 'inactive controller does not notify either')
}

// Case Q5: a top-level node type this command does not own (a code block —
// its own domain, plan 3) refuses end-to-end: `toggleBlockquote` returns
// `unsupported-structure`, `runQuoteToggle` notifies and swallows (true), and
// neither the kernel bytes nor the view move at all.
{
  const h = makeHarness('```js\nab\n```\n', doc(cb('js', 'ab')))
  assert.equal(h.controller.attachAfterCreate(), true)
  h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 2)))
  const before = h.notifications.length
  const handled = h.controller.runQuoteToggle(h.view)
  assert.equal(handled, true, 'refusal still swallows the call')
  assert.equal(h.controller.kernel.doc.text, '```js\nab\n```\n', 'kernel bytes untouched')
  assert.ok(h.view.state.doc.eq(doc(cb('js', 'ab'))), 'view untouched')
  assert.ok(h.notifications.length > before, 'refusal notifies')
}

// ---- Plan 5 Task 1: math domain, degradation healed at the controller
// level. The proof is end-to-end and byte-level: attach succeeds on a
// math-bearing document (it used to return false -> full legacy degradation),
// and a keystroke in an ORDINARY paragraph of that document commits the exact
// expected bytes with the math left untouched.
{
  const md = 'a $x$ b\n\n$$\nE=mc^2\n$$\n\n甲乙\n'
  const h = makeHarness(md, doc(
    p(text('a '), mif('x'), text(' b')), cb('LaTeX', 'E=mc^2'), p(text('甲乙'))))
  assert.equal(h.controller.attachAfterCreate(), true,
    'a document containing inline AND block math attaches (no degradation)')

  // Block math is paired but non-editable (charMap null) — it occupies a
  // structural slot so the rest of the document stays mapped.
  const pairs = h.controller.kernel.map.blockPairs
  assert.equal(pairs.length, 3)
  assert.equal(pairs[1].mdBlock.type, 'math')
  assert.equal(pairs[1].charMap, null, 'block math stays read-only for now')

  // Type 'X' between 甲 and 乙. PM: paragraph1 nodeSize 7, code_block
  // nodeSize 8 -> paragraph3 at pos 15, content start 16, caret 17.
  const tr = h.view.state.tr.insertText('X', 17)
  const verdict = dispatchThrough(h, tr)
  await flushMicrotasks()
  assert.equal(verdict, undefined, 'typing in a plain paragraph of a math document is allowed')
  assert.equal(h.controller.kernel.doc.text, 'a $x$ b\n\n$$\nE=mc^2\n$$\n\n甲X乙\n',
    'commit is byte-exact and leaves both math shapes untouched')
  assert.deepEqual(h.changes.at(-1), ['a $x$ b\n\n$$\nE=mc^2\n$$\n\n甲X乙\n', false])
  // Map rebound on the new revision: the inline-math atom still resolves to
  // its own `$...$` byte span, unmoved.
  assert.equal(h.controller.kernel.map.pmPosToRaw(3), 2)
  assert.equal(h.controller.kernel.map.pmPosToRaw(4), 5)
}

console.log('PASS kernel mode headless')
