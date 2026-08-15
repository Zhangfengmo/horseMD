// TDD evidence + regression lock for editor-kernel-gateway.js
// (source-kernel integration Plan 2, Task 3).
//
// All PM positions / raw offsets below were derived by hand from the same
// hand-built-schema convention as scripts/test-kernel-projection-map.mjs and
// scripts/test-editor-source-map.mjs — a real @milkdown/prose Schema, real
// `EditorState.create`, and real transactions (`tr.insertText`, `tr.delete`,
// `tr.setMeta`, a hand-built cross-block ReplaceStep via `tr.delete` across a
// paragraph boundary) rather than a mocked transaction shape.
import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { classifyTransactions, commitPlainText, commitTaskToggle } from '../src/renderer/src/components/editor-kernel-gateway.js'
import { buildProjectionMap } from '../src/renderer/src/components/editor-kernel-projection-map.js'
import { KERNEL_CODES, createMarkdownDocument } from '../src/renderer/src/lib/source-kernel/index.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    hard_break: { group: 'inline', inline: true, selectable: false },
    text: { group: 'inline' }
  },
  marks: {
    strong: {}
  }
})
const p = (...c) => schema.node('paragraph', null, c)
const doc = (...c) => schema.node('doc', null, c)
const text = (s) => schema.text(s)

console.log('--- kernel gateway ---')

// Case 1: selection-only — no transaction changed the doc.
{
  const d = doc(p(text('hello')))
  const state = EditorState.create({ schema, doc: d })
  const tr = state.tr.setSelection(TextSelection.create(state.doc, 1, 1))
  assert.equal(tr.docChanged, false)
  const result = classifyTransactions([tr], state)
  assert.equal(result.kind, 'selection-only')
}

// Case 2: caller-labeled composition wins even though the tr also changed
// the doc and would otherwise qualify as plain-text.
{
  const d = doc(p(text('hello')))
  const state = EditorState.create({ schema, doc: d })
  const tr = state.tr.insertText('X', 1)
  assert.equal(tr.docChanged, true)
  const result = classifyTransactions([tr], state, { isComposing: true })
  assert.equal(result.kind, 'composition')
}

// Case 3: `sourceProjection` meta wins over everything else, including drop.
{
  const d = doc(p(text('hello')))
  const state = EditorState.create({ schema, doc: d })
  const tr = state.tr.insertText('X', 1)
  tr.setMeta('sourceProjection', true)
  tr.setMeta('uiEvent', 'drop')
  const result = classifyTransactions([tr], state)
  assert.equal(result.kind, 'projection')
}

// Case 4: drop meta blocks even an otherwise-plain single-textblock edit.
{
  const d = doc(p(text('hello')))
  const state = EditorState.create({ schema, doc: d })
  const tr = state.tr.insertText('X', 1)
  tr.setMeta('uiEvent', 'drop')
  const result = classifyTransactions([tr], state)
  assert.equal(result.kind, 'blocked')
  assert.equal(result.blockedCode, KERNEL_CODES.INPUT_TYPE)
}

// Case 4b: drop meta outranks a stale/lingering composing flag — a drop is
// never a legitimate part of an IME composition, so `isComposing: true`
// must NOT let it pass through as a no-op composition tick.
{
  const d = doc(p(text('hello')))
  const state = EditorState.create({ schema, doc: d })
  const tr = state.tr.insertText('X', 1)
  tr.setMeta('uiEvent', 'drop')
  const result = classifyTransactions([tr], state, { isComposing: true })
  assert.equal(result.kind, 'blocked')
  assert.equal(result.blockedCode, KERNEL_CODES.INPUT_TYPE)
}

// Case 5: cross-block ReplaceStep (delete spanning a paragraph boundary,
// joining 'abc'+'def' into one paragraph) -> blocked. doc(p('abc'), p('def')):
// p1 spans PM [0,5) content [1,4); p2 spans [5,10) content [6,9). Deleting
// [3,7) removes 'c' + the boundary + 'd', producing ONE ReplaceStep whose
// $from (pos 3, inside p1) and $to (pos 7, inside p2) do NOT share a parent.
{
  const d = doc(p(text('abc')), p(text('def')))
  const state = EditorState.create({ schema, doc: d })
  const tr = state.tr.delete(3, 7)
  assert.equal(tr.docChanged, true)
  assert.equal(tr.steps.length, 1)
  assert.equal(tr.steps[0].constructor.name, 'ReplaceStep')
  const result = classifyTransactions([tr], state)
  assert.equal(result.kind, 'blocked')
  assert.equal(result.blockedCode, KERNEL_CODES.INPUT_TYPE)
}

// Case 6: editing inside a textblock that already carries a mark (bold) is
// out of scope for the plain-text path, even though the inserted text itself
// carries no mark.
{
  const d = doc(p(schema.text('bold', [schema.mark('strong')])))
  const state = EditorState.create({ schema, doc: d })
  const tr = state.tr.insertText('X', 1)
  const result = classifyTransactions([tr], state)
  assert.equal(result.kind, 'blocked')
  assert.equal(result.blockedCode, KERNEL_CODES.INPUT_TYPE)
}

// Case 7: a slice containing a hard_break (not text) is not plain text.
{
  const d = doc(p(text('ab')))
  const state = EditorState.create({ schema, doc: d })
  const tr = state.tr.replaceWith(2, 2, schema.nodes.hard_break.create())
  assert.equal(tr.docChanged, true)
  const result = classifyTransactions([tr], state)
  assert.equal(result.kind, 'blocked')
  assert.equal(result.blockedCode, KERNEL_CODES.INPUT_TYPE)
}

// Case 8: plain CJK insert, classify + commit. markdown '甲乙\n': 甲=0 乙=1
// \n=2. PM paragraph@0, content start 1. Insert '丙' at PM pos 2 (between 甲
// and 乙) -> raw offset 1 (right after 甲, ascii/CJK 1 visible char == 1 raw
// char here, no escaping involved).
{
  const md = '甲乙\n'
  const d = doc(p(text('甲乙')))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map)
  const tr = state.tr.insertText('丙', 2)
  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'plain-text')
  assert.equal(classified.steps.length, 1)
  assert.deepEqual(classified.steps[0], { from: 2, to: 2, insertText: '丙' })

  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
  assert.equal(committed.ok, true)
  assert.equal(committed.applied.doc.text, '甲丙乙\n')
  assert.equal(committed.applied.doc.revision, 1)
  assert.equal(committed.transaction.baseRevision, 0)
  assert.deepEqual(committed.transaction.edits, [{ from: 1, to: 1, insert: '丙' }])
}

// Case 9: deletion inside one block. markdown 'abcdef\n' -> delete PM [2,4)
// (offsets 1..3, "bc") -> raw [1,3).
{
  const md = 'abcdef\n'
  const d = doc(p(text('abcdef')))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  const tr = state.tr.delete(2, 4)
  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'plain-text')
  assert.deepEqual(classified.steps[0], { from: 2, to: 4, insertText: '' })

  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
  assert.equal(committed.ok, true)
  assert.equal(committed.applied.doc.text, 'adef\n')
}

// Case 10: THE escape case. markdown 'a\*b\n' (JS source 'a\\*b\n', 5 raw
// chars: a=0 \=1 *=2 b=3 \n=4) decodes to PM text 'a*b'. Insert 'x' right
// after the decoded '*' (PM pos 3, content offset 2) -> per
// test-kernel-projection-map.mjs Case 2, pmPosToRaw(3) === 3 (the escape's 2
// raw bytes collapse to 1 visible position, landing exactly on 'b's start,
// not splitting the backslash/asterisk pair). Expected result: 'a\*xb\n'.
{
  const md = 'a\\*b\n'
  const d = doc(p(text('a*b')))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map)
  const tr = state.tr.insertText('x', 3)
  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'plain-text')
  assert.deepEqual(classified.steps[0], { from: 3, to: 3, insertText: 'x' })

  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
  assert.equal(committed.ok, true)
  assert.equal(committed.applied.doc.text, 'a\\*xb\n')
}

// Case 10b: deletion SPANNING an escape unit. Same 'a\*b\n' fixture as Case
// 10 (JS source 'a\\*b\n': a=0 \=1 *=2 b=3 \n=4, decodes to PM text 'a*b').
// Deleting the single visible '*' character in PM (pos 2 to pos 3) must
// remove the WHOLE 2-raw-byte escape unit, not just the asterisk byte: per
// test-kernel-projection-map.mjs Case 2, pmPosToRaw(2) === 1 (right after
// 'a', before the escape run) and pmPosToRaw(3) === 3 (right after the
// escape, before 'b') — so a 1-visible-char PM deletion maps to a 2-raw-char
// deletion (raw [1,3), the full '\*'). Named risk: a naive "PM delta ==
// raw delta" assumption would only remove 1 raw byte and corrupt the escape.
{
  const md = 'a\\*b\n'
  const d = doc(p(text('a*b')))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  const tr = state.tr.delete(2, 3)
  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'plain-text')
  assert.deepEqual(classified.steps[0], { from: 2, to: 3, insertText: '' })

  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
  assert.equal(committed.ok, true)
  assert.deepEqual(committed.transaction.edits, [{ from: 1, to: 3, insert: '' }])
  assert.equal(committed.applied.doc.text, 'ab\n')
}

// Case 11: multi-step transaction (two sequential ReplaceSteps in ONE tr).
// markdown 'abcdef\n'. Step 1 inserts '1' at PM pos 2 (offset1, between a/b)
// -> doc becomes 'a1bcdef' and every later PM position shifts +1. Step 2
// inserts '2' at PM pos 8, which in step-2's OWN (post-step-1) doc is the
// end of the text ('a1bcdef' has content size 7, content start 1 -> end at
// 8) — in ORIGINAL doc coordinates that is pos 7 (end of 'abcdef', after
// subtracting step 1's PM delta of +1). Locks the cumulative-delta shift.
{
  const md = 'abcdef\n'
  const d = doc(p(text('abcdef')))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  const tr = state.tr
  tr.insertText('1', 2)
  tr.insertText('2', 8)
  assert.equal(tr.steps.length, 2)
  assert.equal(tr.steps[0].from, 2)
  assert.equal(tr.steps[1].from, 8, 'step 2 from is in post-step-1 doc coordinates')

  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'plain-text')
  assert.equal(classified.steps.length, 2)

  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
  assert.equal(committed.ok, true)
  assert.equal(committed.applied.doc.text, 'a1bcdef2\n')
  assert.deepEqual(committed.transaction.edits, [
    { from: 1, to: 1, insert: '1' },
    { from: 6, to: 6, insert: '2' }
  ])
}

// Case 12: an unmapped end (map.pmPosToRaw returns null) -> UNMAPPED, not a
// thrown error or a silently wrong commit.
{
  const md = 'abcdef\n'
  const d = doc(p(text('abcdef')))
  const state = EditorState.create({ schema, doc: d })
  const tr = state.tr.insertText('X', 2)
  const kernel = { doc: createMarkdownDocument(md) }
  const nullMap = { pmPosToRaw: () => null }
  const committed = commitPlainText({ kernel, map: nullMap, transactions: [tr], oldState: state })
  assert.equal(committed.ok, false)
  assert.equal(committed.code, KERNEL_CODES.UNMAPPED)
}

// Case 13: overlap guard. Two ascending, non-overlapping PM steps whose
// (deliberately adversarial, hand-built) map reports raw ranges that are
// NOT in ascending order — commitPlainText must refuse rather than build an
// overlapping/out-of-order kernel edit list.
{
  const md = 'abcdef\n'
  const d = doc(p(text('abcdef')))
  const state = EditorState.create({ schema, doc: d })
  const tr = state.tr
  tr.insertText('1', 2) // step 1: PM pos 2 (old-doc coords: 2)
  tr.insertText('2', 8) // step 2: PM pos 8 (old-doc coords: 8-1=7)
  const adversarialMap = { pmPosToRaw: (pmPos) => (pmPos <= 3 ? 5 : 2) }
  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitPlainText({ kernel, map: adversarialMap, transactions: [tr], oldState: state })
  assert.equal(committed.ok, false)
  assert.equal(committed.code, KERNEL_CODES.UNMAPPED)
}

// Case 14: applySourceTransaction's own failure codes propagate untouched.
// The map was built from 'abcdef\n', but kernel.doc.text is a shorter,
// out-of-sync string ('ab\n') — the mapped raw range (6,6) exceeds
// kernel.doc.text.length (3), so the kernel's own `invalid-range` guard
// fires (revision matches, so it is NOT mistaken for stale-revision).
{
  const md = 'abcdef\n'
  const d = doc(p(text('abcdef')))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  const tr = state.tr.insertText('X', 7) // PM pos 7 = end of 'abcdef' -> raw 6
  const outOfSyncKernelDoc = { text: 'ab\n', revision: 0 }
  const committed = commitPlainText({ kernel: { doc: outOfSyncKernelDoc }, map, transactions: [tr], oldState: state })
  assert.equal(committed.ok, false)
  assert.equal(committed.code, 'invalid-range')
}

// Cases 15-18: the task-checkbox click shape. `@milkdown/components`'
// list-item-block node view toggles a task item with a bare
// `tr.setNodeAttribute(pos, 'checked', v)` — an `AttrStep`, never a
// `ReplaceStep` — which used to fall through every existing branch straight
// to `blocked`/`INPUT_TYPE` (root cause of the "checkbox does nothing in
// kernel mode" bug found in Task 9's UI smoke run). A minimal schema with
// `list_item`/`bullet_list` (mirroring @milkdown/preset-commonmark +
// preset-gfm's real shape: `list_item` content is `'paragraph block*'`)
// stands in for the real one, same hand-built-schema convention as the rest
// of this file.
const taskSchema = new Schema({
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
const tp = (...c) => taskSchema.node('paragraph', null, c)
const tdoc = (...c) => taskSchema.node('doc', null, c)
const ttext = (s) => taskSchema.text(s)
const li = (checked, ...c) => taskSchema.node('list_item', { checked }, c)
const bl = (...c) => taskSchema.node('bullet_list', null, c)

// Case 15: classifyTransactions recognizes the AttrStep shape as
// `task-toggle` (checked list_item), ahead of the plain-text guard (an
// AttrStep is never a ReplaceStep, so it would otherwise fall through to
// `blocked`/`INPUT_TYPE`).
{
  const d = tdoc(bl(li(true, tp(ttext('乙')))))
  const state = EditorState.create({ schema: taskSchema, doc: d })
  assert.equal(state.doc.nodeAt(1)?.type.name, 'list_item', 'fixture position sanity check')
  const tr = state.tr.setNodeAttribute(1, 'checked', false)
  assert.equal(tr.steps[0].constructor.name, 'AttrStep')
  assert.equal(tr.docChanged, true)
  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'task-toggle')
  assert.equal(classified.pos, 1)
}

// Case 16: end-to-end commit. markdown '- [x] 乙\n' -> click flips it off:
// '- [ ] 乙\n'.
{
  const md = '- [x] 乙\n'
  const d = tdoc(bl(li(true, tp(ttext('乙')))))
  const state = EditorState.create({ schema: taskSchema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'projection map must pair list_item/bullet_list against listItem/list')
  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitTaskToggle({ kernel, map, pos: 1 })
  assert.equal(committed.ok, true)
  assert.equal(committed.applied.doc.text, '- [ ] 乙\n')
  assert.equal(committed.transaction.intent, 'toggle-task')
}

// Case 17: an AttrStep touching a DIFFERENT attribute (not `checked`) must
// not be misread as a task toggle — falls through to the plain-text guard,
// which also refuses an AttrStep, so it ends up `blocked`.
{
  const d = tdoc(bl(li(null, tp(ttext('甲')))))
  const state = EditorState.create({ schema: taskSchema, doc: d })
  const tr = state.tr.setNodeAttribute(1, 'checked', true)
  // Re-labelled as a different attr name to prove the `attr !== 'checked'`
  // guard, since this schema only declares `checked`; simulate by directly
  // asserting the guard function's contract via a non-checked-attr AttrStep
  // built from the same step class.
  tr.steps[0].attr = 'other'
  const classified = classifyTransactions([tr], state)
  assert.notEqual(classified.kind, 'task-toggle')
}

// Case 18: commitTaskToggle re-derives from `pos` and fails closed
// (`unsupported-structure`, from `toggleTaskMarker`) when the raw markdown
// line the mapped position lands on is not actually a task item — proves
// the fix never trusts the PM attr alone, only the raw bytes.
{
  const md = '- 甲\n'
  const d = tdoc(bl(li(null, tp(ttext('甲')))))
  const state = EditorState.create({ schema: taskSchema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitTaskToggle({ kernel, map, pos: 1 })
  assert.equal(committed.ok, false)
  assert.equal(committed.code, 'unsupported-structure')
}

console.log('PASS kernel gateway')
