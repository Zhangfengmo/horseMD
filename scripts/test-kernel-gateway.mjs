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
import { toggleMark } from '@milkdown/prose/commands'
import { AddMarkStep } from '@milkdown/prose/transform'
import { classifyTransactions, commitPlainText, commitTaskToggle, commitCodeLanguage } from '../src/renderer/src/components/editor-kernel-gateway.js'
import { buildProjectionMap } from '../src/renderer/src/components/editor-kernel-projection-map.js'
import { KERNEL_CODES, createMarkdownDocument } from '../src/renderer/src/lib/source-kernel/index.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    hard_break: { group: 'inline', inline: true, selectable: false },
    // Plan 3 Task 4: same shape as scripts/test-kernel-projection-map.mjs's
    // schema (content 'text*', `attrs.language`) — the gateway relaxation
    // and the language-switch AttrStep shape both target this node type.
    code_block: { content: 'text*', group: 'block', code: true, attrs: { language: { default: '' } } },
    // A markdown blockquote-wrapped fence parses to mdast `blockquote > code`
    // (verified against the real parser) — buildProjectionMap pairs PM
    // structure against mdast structure 1:1, so a quoted-fence PM fixture
    // needs this wrapper node too, not just the bare code_block.
    blockquote: { content: 'block+', group: 'block' },
    text: { group: 'inline' }
  },
  marks: {
    // Mark NAMES mirror the LIVE schema exactly (probed, not guessed):
    // preset-commonmark $markSchema("strong"/"emphasis"/"inlineCode"/"link"),
    // preset-gfm $markSchema("strike_through"), editor-highlight.js
    // $markSchema('highlight') with attrs.color default 'yellow'.
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
const cb = (language, s) => schema.node('code_block', { language }, s ? text(s) : [])
const bq = (...c) => schema.node('blockquote', null, c)

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

// Case 19 (Task 11.5): @milkdown/plugin-trailing's own append — one
// ReplaceStep inserting exactly one EMPTY paragraph at the very end — is
// classified `trailing-append`, never `blocked` (pre-fix it fell through to
// INPUT_TYPE and the veto channel would refuse the plugin's convenience
// node). A NON-empty paragraph, or an insert not at the end, must NOT match.
{
  const d = tdoc(bl(li(null, tp(ttext('甲')))))
  const state = EditorState.create({ schema: taskSchema, doc: d })
  const end = state.doc.content.size
  const tr = state.tr.insert(end, taskSchema.nodes.paragraph.createAndFill())
  assert.equal(classifyTransactions([tr], state).kind, 'trailing-append')

  const nonEmpty = state.tr.insert(end, taskSchema.node('paragraph', null, [ttext('x')]))
  assert.equal(classifyTransactions([nonEmpty], state).kind, 'blocked')

  const notAtEnd = state.tr.insert(0, taskSchema.nodes.paragraph.createAndFill())
  assert.equal(classifyTransactions([notAtEnd], state).kind, 'blocked')
}

// Case 20 (Task 11.5): commitPlainText into the trailing VIRTUAL paragraph.
// markdown '- 甲\n' (length 4) with the live PM doc [bullet_list, empty
// trailing paragraph] — typing '新' at the trailing content position must
// commit '\n新' at raw 4 (blank-line separator + text -> a NEW paragraph),
// byte-for-byte, never the lazy continuation '- 甲\n新'.
{
  const md = '- 甲\n'
  const d = tdoc(bl(li(null, tp(ttext('甲')))), taskSchema.nodes.paragraph.createAndFill())
  const state = EditorState.create({ schema: taskSchema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'trailing-placeholder doc must map')
  // bullet_list@0 nodeSize 7 -> trailing p@7, content start 8.
  const tr = state.tr.insertText('新', 8)
  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
  assert.equal(committed.ok, true)
  assert.deepEqual(committed.transaction.edits, [{ from: 4, to: 4, insert: '\n新' }])
  assert.equal(committed.applied.doc.text, '- 甲\n\n新')
}

// Case 21 (Task 11.5 review fix): the separator prefix is latched ONCE per
// virtual pair per batch. A single transaction with TWO insert steps into
// the trailing paragraph rebases both steps to the pair's content position
// (the coordinate unwind subtracts each step's own delta), so an unlatched
// prefix would emit '\na' + '\nb' — bytes '- 甲\n\na\nb', TWO source
// paragraphs for what PM shows as ONE ('ab'), forcing a verify repair that
// restructures the user's typing. Latched, the batch commits '\na' + 'b':
// bytes '- 甲\n\nab', one paragraph, cheap-path verify passes (the no-churn
// half is locked end-to-end in test-kernel-mode-headless.mjs Case 16).
{
  const md = '- 甲\n'
  const d = tdoc(bl(li(null, tp(ttext('甲')))), taskSchema.nodes.paragraph.createAndFill())
  const state = EditorState.create({ schema: taskSchema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map)
  const tr = state.tr.insertText('a', 8).insertText('b', 9)
  assert.equal(tr.steps.length, 2, 'fixture sanity: one transaction, two ReplaceSteps')
  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
  assert.equal(committed.ok, true)
  assert.deepEqual(committed.transaction.edits, [
    { from: 4, to: 4, insert: '\na' },
    { from: 4, to: 4, insert: 'b' }
  ], 'only the FIRST step carries the separator prefix')
  assert.equal(committed.applied.doc.text, '- 甲\n\nab',
    'multi-step typing stays ONE new paragraph, never one paragraph per step')
}

// ---- Plan 3 Task 4: code-block newline-bearing edits + language switch ----

// Case 22: CM-style multi-line insert landing INSIDE a blockquote-prefixed
// fence — proves both halves of the relaxation at once: classification
// allows a `\n`-bearing slice ONLY because the target textblock is a
// `code_block`, and commitPlainText expands that `\n` into `ending +
// linePrefix`, never a bare byte (which would break the quote prefix every
// OTHER content line in this block carries).
// md = '> ```js\n> ab\n> ```\n' (single content line 'ab') parses to mdast
// `blockquote > code`, so the PM fixture needs the same wrapper: `doc(bq(cb))`
// — blockquote opens pos0 (content start1), code_block opens pos1 (content
// start2): 'a'@2 'b'@3 (content [2,4)).
// Typing 'X\nY' between 'a' and 'b' (PM pos3, content offset1) must commit
// 'X' + ('\n' + '> ') + 'Y' at raw offset (buildCodeMap.visibleToRaw(1)),
// splitting 'ab' into two properly-prefixed lines 'aX' / 'Yb'.
{
  const md = '> ```js\n> ab\n> ```\n'
  const d = doc(bq(cb('js', 'ab')))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'quoted single-line fence must map')
  const tr = state.tr.insertText('X\nY', 3)
  assert.equal(tr.steps.length, 1, 'fixture sanity: one ReplaceStep')
  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'plain-text', 'a \\n inside a code_block must classify as plain-text')
  assert.deepEqual(classified.steps[0], { from: 3, to: 3, insertText: 'X\nY' })

  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text, '> ```js\n> aX\n> Yb\n> ```\n')
}

// Case 23: deletion SPANNING a visible linebreak inside a quoted, two-line
// fence — joining the lines must remove the WHOLE raw span (line ending
// PLUS the next line's quote prefix), never leave a stray '> ' behind. This
// already worked before Task 4 (P3-3's charMap already proves raw ranges
// across a code linebreak; the deleted slice is empty, so the newline
// classification guard never even engages) — locked here as an end-to-end
// gateway regression, not just a projection-map probe.
// md = '> ```js\n> ab\n> cd\n> ```\n' (2 content lines, same fixture as
// scripts/test-source-kernel-codemap.mjs Case 2), PM doc `doc(bq(cb))`:
// content 'ab\ncd' start pos2 -> 'a'@2 'b'@3 '\n'@4 'c'@5 'd'@6.
// Deleting PM[4,5) (the visible '\n', content offset [2,3)) maps to raw
// [12,15) = '\n> ' (per the codemap Case 2 derivation).
{
  const md = '> ```js\n> ab\n> cd\n> ```\n'
  const d = doc(bq(cb('js', 'ab\ncd')))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'quoted two-line fence must map')
  assert.equal(map.pmPosToRaw(4), 12)
  assert.equal(map.pmPosToRaw(5), 15)
  const tr = state.tr.delete(4, 5)
  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'plain-text')
  assert.deepEqual(classified.steps[0], { from: 4, to: 5, insertText: '' })

  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
  assert.equal(committed.ok, true, committed.code)
  assert.deepEqual(committed.transaction.edits, [{ from: 12, to: 15, insert: '' }])
  assert.equal(committed.applied.doc.text, '> ```js\n> abcd\n> ```\n',
    'joining removes the linebreak AND the next line\'s quote prefix, never leaves a stray "> "')
}

// Case 24: language AttrStep classification + end-to-end commit. markdown
// '```js\nabc\n```\n' -> switch 'js' -> 'python'. `tr.setNodeAttribute` is
// the exact shape a language picker dispatches (mirrors the checkbox click's
// own `setNodeAttribute('checked', …)` shape one AttrStep up).
{
  const md = '```js\nabc\n```\n'
  const d = doc(cb('js', 'abc'))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'plain fence must map')
  const tr = state.tr.setNodeAttribute(0, 'language', 'python')
  const classified = classifyTransactions([tr], state)
  assert.deepEqual(classified, { kind: 'code-language', pmPos: 0, language: 'python' })

  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitCodeLanguage({ kernel, map, pmPos: 0, language: 'python' })
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text, '```python\nabc\n```\n')
}

// Case 25: an AttrStep touching a DIFFERENT attribute on a code_block (not
// `language`) must not be misread as a language switch — mirrors Case 17's
// same guard for the task-toggle shape.
{
  const md = '```js\nabc\n```\n'
  const d = doc(cb('js', 'abc'))
  const state = EditorState.create({ schema, doc: d })
  const tr = state.tr.setNodeAttribute(0, 'someOtherAttr', 'x')
  assert.equal(classifyTransactions([tr], state).kind, 'blocked')
}

// Case 26 (final-review finding, 2026-08-16 — the from-readonly refusal was
// LIFTED, making the language switch bidirectional): a code_block whose
// CURRENT language is one Crepe renders as a preview (READONLY_CODE_LANGUAGES)
// now classifies and COMMITS a switch out of it, exactly like any other
// language switch. `commitCodeLanguage` resolves its anchor via the pair's
// `mdBlock` fence-start fallback (no charMap needed) — see that function's
// own comment. Case-insensitive on the CURRENT language, matching
// editor-kernel-projection-map.js's own guard.
{
  const md = '```mermaid\ngraph TD\n```\n'
  const d = doc(cb('mermaid', 'graph TD'))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'mermaid-only fence must still structurally map')
  assert.equal(map.blockPairs[0].charMap, null, 'sanity: the mermaid pair itself has no charMap')

  const tr = state.tr.setNodeAttribute(0, 'language', 'js')
  const classified = classifyTransactions([tr], state)
  assert.deepEqual(classified, { kind: 'code-language', pmPos: 0, language: 'js' },
    'switching a mermaid block\'s OWN language must now classify, not block')

  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitCodeLanguage({ kernel, map, pmPos: 0, language: 'js' })
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text, '```js\ngraph TD\n```\n',
    'mermaid -> js must commit the exact fence-rewrite bytes, content untouched')

  const upper = doc(cb('MERMAID', 'graph TD'))
  const upperState = EditorState.create({ schema, doc: upper })
  const upperTr = upperState.tr.setNodeAttribute(0, 'language', 'js')
  assert.deepEqual(classifyTransactions([upperTr], upperState), { kind: 'code-language', pmPos: 0, language: 'js' },
    'case-insensitive: MERMAID -> js also classifies')
}

// Case 26b: the reverse direction (js -> mermaid) was always allowed (the
// CURRENT language there is not readonly) — locked here as an explicit byte
// test alongside Case 26's mermaid -> js, so both directions of the switch
// are pinned, not just one.
{
  const md = '```js\nabc\n```\n'
  const d = doc(cb('js', 'abc'))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'plain js fence must map')
  const tr = state.tr.setNodeAttribute(0, 'language', 'mermaid')
  assert.deepEqual(classifyTransactions([tr], state), { kind: 'code-language', pmPos: 0, language: 'mermaid' })

  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitCodeLanguage({ kernel, map, pmPos: 0, language: 'mermaid' })
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text, '```mermaid\nabc\n```\n',
    'js -> mermaid must commit the exact fence-rewrite bytes, content untouched')
}

// Case 27: the relaxation is SCOPED to code_block — a \n-bearing slice
// targeting an ordinary paragraph must still be refused (never silently
// treated as plain text just because Task 4 loosened the code_block path).
{
  const md = '甲乙\n'
  const dd = doc(p(text('甲乙')))
  const state = EditorState.create({ schema, doc: dd })
  const tr = state.tr.insertText('X\nY', 2)
  assert.equal(tr.steps.length, 1, 'fixture sanity: one ReplaceStep')
  assert.equal(classifyTransactions([tr], state).kind, 'blocked',
    'a \\n inside a plain paragraph must stay refused')
}

// Case 28 (fix-review ADR, 2026-08-16): a CRLF-lineEnding code block stays
// structurally paired but NON-EDITABLE (see editor-kernel-projection-map.js's
// ADR comment on the `pmType === 'code_block'` branch for the full
// investigation — the vendored @milkdown/components CodeMirrorBlock nodeview
// silently drops '\r' from its own internal CM6 position model, which can
// misalign `forwardUpdate`'s PM step positions for any edit past a CRLF
// block's first line break, undetectably from this gateway's own vantage
// point). Classification stays PM-structural only (unaffected by the ADR —
// it still says `plain-text`), but `commitPlainText` must fail closed
// (UNMAPPED) for ANY edit targeting the block, single-char OR multi-line,
// never silently corrupting a line ending or reaching the newline-expansion
// path at all.
{
  const md = '```js\r\nab\r\ncd\r\n```\r\n'
  const d = doc(cb('js', 'ab\r\ncd'))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'CRLF code block doc must still map (structural pairing preserved)')
  assert.equal(map.blockPairs[0].charMap, null, 'CRLF code_block pair must be non-editable')

  // (a) a single-char edit on line 2 — content 'ab\r\ncd': a@1 b@2 \r@3 \n@4
  // c@5 d@6 — inserting right before 'c' (PM pos 5) is exactly the shape a
  // CM-bridge position bug could otherwise misalign.
  const tr1 = state.tr.insertText('X', 5)
  const classified1 = classifyTransactions([tr1], state)
  assert.equal(classified1.kind, 'plain-text', 'classification is PM-structural only, unaffected by the ADR')
  const kernel1 = { doc: createMarkdownDocument(md) }
  const committed1 = commitPlainText({ kernel: kernel1, map, transactions: [tr1], oldState: state })
  assert.equal(committed1.ok, false)
  assert.equal(committed1.code, KERNEL_CODES.UNMAPPED)
  assert.equal(kernel1.doc.text, md, 'kernel bytes must be untouched by a refused edit')

  // (b) a multi-line insert (the shape this task set out to support) must
  // ALSO fail closed for a CRLF block.
  const tr2 = state.tr.insertText('X\nY', 3)
  const classified2 = classifyTransactions([tr2], state)
  assert.equal(classified2.kind, 'plain-text')
  const kernel2 = { doc: createMarkdownDocument(md) }
  const committed2 = commitPlainText({ kernel: kernel2, map, transactions: [tr2], oldState: state })
  assert.equal(committed2.ok, false)
  assert.equal(committed2.code, KERNEL_CODES.UNMAPPED)
  assert.equal(kernel2.doc.text, md, 'kernel bytes must be untouched by a refused edit')
}

// Case 21 (review fix, Plan 4 Task 2): gap-aware selection-start resolution
// through `commitPlainText`'s own `pmPosToRawStart` — the same corruption
// class the reviewer live-probed at the `replaceVisibleText`/character-map
// layer (`test-source-kernel-commands.mjs`'s "review fix" section), proven
// again here at the gateway layer.
//
// Note on WHY this fixture pairs an UNMARKED PM paragraph against a MARKED
// markdown source ('a **bold** b\n'): `extractPlainTextSteps`'
// `isPlainTextblock` guard (used by BOTH `classifyTransactions` and
// `commitPlainText` itself, unconditionally, before any raw-offset
// resolution runs) refuses ANY edit whose PM parent textblock carries a
// mark ANYWHERE in it (see Case 6 above) — so with a REAL marked PM doc,
// `commitPlainText` never reaches `pmPosToRawStart` at all; the bug this
// case targets is unreachable through today's live `classifyTransactions ->
// commitPlainText` pipeline for an ALREADY-mark-toggled paragraph. It
// remains live and directly reachable, unconditionally, through
// `replaceVisibleText` (any future caller of that command against marked
// content — including a mode-level verify/reconcile repair path) and would
// become immediately live here too the moment a future task relaxes
// `isPlainTextblock` for post-mark-toggle paragraphs (exactly the kind of
// relaxation Plan 4 Task 3's kernel-mode routing is expected to need). This
// fixture proves `pmPosToRawStart`/`commitPlainText`'s `oldFrom < oldTo`
// branch is correct NOW, pre-emptively, using `buildProjectionMap` for
// real (not a hand-rolled fake map) — its pairing is content-SIZE-based,
// not mark-aware (see editor-kernel-projection-map.js's own pairing
// comment), so an unmarked 8-char PM paragraph legitimately pairs against
// an 8-visible-char markdown paragraph that happens to contain '**' bytes,
// exercising the exact same charMap gap a real post-mark-toggle paragraph
// would have.
{
  const md = 'a **bold** b\n'
  const d = doc(p(text('a bold b')))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map)
  // PM pos 3..7 = content offset 2..6 = the visible word "bold" (a=1 sp=2
  // b=3 o=4 l=5 d=6 sp=7 b=8 in content-offset terms, contentPos=1).
  assert.equal(map.pmPosToRaw(3), 2, 'old (gap-before) value: right before **')
  assert.equal(map.pmPosToRawStart(3), 4, 'gap-aware value: right after **, at the content')
  assert.equal(map.pmPosToRaw(7), 8, 'the TO side was never ambiguous — content end either way')

  // (a) type 'X' over the fully-selected word: must land INSIDE the markers.
  const tr = state.tr.insertText('X', 3, 7)
  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
  assert.equal(committed.ok, true, committed.code)
  assert.deepEqual(committed.transaction.edits, [{ from: 4, to: 8, insert: 'X' }])
  assert.equal(committed.applied.doc.text, 'a **X** b\n',
    'the opening ** must NOT be eaten and the closing ** must NOT be orphaned')

  // (b) deleting the whole word: pinned decision (see the matching
  // "review fix" section of test-source-kernel-commands.mjs) — the empty-
  // marker bytes 'a **** b\n' are byte-consistent and safe (no data loss,
  // no crash); reparsing them yields a plain literal '****' text run, not a
  // broken/ambiguous structure. commitPlainText does not special-case this
  // (it has no mark awareness — that is `toggleInlineMark`'s domain), and
  // this task deliberately does not add any here; the result is left for a
  // later mode-level verify/reconcile pass to clean up if desired.
  const tr2 = state.tr.delete(3, 7)
  const kernel2 = { doc: createMarkdownDocument(md) }
  const committed2 = commitPlainText({ kernel: kernel2, map, transactions: [tr2], oldState: state })
  assert.equal(committed2.ok, true, committed2.code)
  assert.equal(committed2.applied.doc.text, 'a **** b\n')
}

// ---- Plan 4 Task 3: mark-toggle classification ----
// Every "real toggleMark" below builds its transaction through the actual
// prosemirror-commands `toggleMark` (the exact function Crepe's toolbar
// commands, HorseMD's applyTextFormat, and the preset Mod-b/Mod-i/… keymaps
// all bottom out in), captured via the command's dispatch callback — never a
// hand-mocked step shape.
const captureToggle = (state, markType, attrs = null) => {
  let captured = null
  toggleMark(markType, attrs)(state, (tr) => { captured = tr })
  return captured
}
const withSelection = (state, from, to) =>
  state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)))

// Case M1: strong ADD over plain text — real toggleMark, one AddMarkStep.
{
  const d = doc(p(text('abcd')))
  const state = withSelection(EditorState.create({ schema, doc: d }), 2, 4)
  const tr = captureToggle(state, schema.marks.strong)
  assert.ok(tr, 'toggleMark must dispatch for a non-empty selection')
  assert.equal(tr.steps.length, 1)
  assert.equal(tr.steps[0].constructor.name, 'AddMarkStep')
  const classified = classifyTransactions([tr], state)
  assert.deepEqual(classified, {
    kind: 'mark-toggle', pmFrom: 2, pmTo: 4, markName: 'strong', markKind: 'strong', add: true
  })
}

// Case M2: strong REMOVE — toggleMark over a selection WIDER than the marked
// run removes just the marked subrange (PM's own removeMark semantics); the
// classification reports the STEP's range (the mark's own span), which is
// exactly the exact-cover range the kernel's unwrap wants.
{
  const d = doc(p(text('a'), schema.text('bc', [schema.mark('strong')]), text('d')))
  const state = withSelection(EditorState.create({ schema, doc: d }), 1, 5)
  const tr = captureToggle(state, schema.marks.strong)
  assert.ok(tr)
  assert.equal(tr.steps[0].constructor.name, 'RemoveMarkStep')
  const classified = classifyTransactions([tr], state)
  assert.deepEqual(classified, {
    kind: 'mark-toggle', pmFrom: 2, pmTo: 4, markName: 'strong', markKind: 'strong', add: false
  })
}

// Case M3: kind-mapping table — emphasis/strike_through/inlineCode/highlight
// (yellow) all classify with their kernel kinds; strike_through maps to the
// mdast name 'delete'.
{
  const expectations = [
    ['emphasis', null, 'emphasis'],
    ['strike_through', null, 'delete'],
    ['inlineCode', null, 'inlineCode'],
    ['highlight', { color: 'yellow' }, 'highlight']
  ]
  for (const [markName, attrs, markKind] of expectations) {
    const d = doc(p(text('abcd')))
    const state = withSelection(EditorState.create({ schema, doc: d }), 1, 3)
    const tr = captureToggle(state, schema.marks[markName], attrs)
    assert.ok(tr, markName + ' toggle must dispatch')
    const classified = classifyTransactions([tr], state)
    assert.equal(classified.kind, 'mark-toggle', markName + ' must classify as mark-toggle')
    assert.equal(classified.markKind, markKind, markName + ' -> ' + markKind)
    assert.equal(classified.add, true)
  }
}

// Case M4: coalesce — two CONTIGUOUS AddMarkSteps of the same mark (the
// split-text-node shape toggleMark can emit across an inner mark boundary;
// constructed by hand since PM merges adjacent steps whenever it can) fold
// into ONE [from, to) range.
{
  const d = doc(p(text('ab'), schema.text('cd', [schema.mark('emphasis')]), text('ef')))
  const state = EditorState.create({ schema, doc: d })
  const tr = state.tr
  tr.step(new AddMarkStep(1, 3, schema.mark('strong')))
  tr.step(new AddMarkStep(3, 5, schema.mark('strong')))
  assert.equal(tr.steps.length, 2)
  const classified = classifyTransactions([tr], state)
  assert.deepEqual(classified, {
    kind: 'mark-toggle', pmFrom: 1, pmTo: 5, markName: 'strong', markKind: 'strong', add: true
  })
}

// Case M4b: NON-contiguous steps (a gap — e.g. toggleMark skipping an
// already-marked middle segment) must NOT coalesce: fail-closed to blocked.
{
  const d = doc(p(text('abcdef')))
  const state = EditorState.create({ schema, doc: d })
  const tr = state.tr
  tr.step(new AddMarkStep(1, 2, schema.mark('strong')))
  tr.step(new AddMarkStep(4, 5, schema.mark('strong')))
  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'blocked')
  assert.equal(classified.blockedCode, KERNEL_CODES.INPUT_TYPE)
}

// Case M5: link toggle — a mark with NO kernel kind ([text](url) needs the
// URL-input UI flow, out of scope this plan) → blocked, never mark-toggle.
{
  const d = doc(p(text('abcd')))
  const state = withSelection(EditorState.create({ schema, doc: d }), 1, 3)
  const tr = captureToggle(state, schema.marks.link, { href: 'https://x.example' })
  assert.ok(tr)
  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'blocked')
  assert.equal(classified.blockedCode, KERNEL_CODES.INPUT_TYPE)
}

// Case M6: cross-block toggleMark (selection spanning two paragraphs) emits
// per-block steps whose ranges jump the block boundary — non-contiguous →
// blocked. The single-textblock guard is therefore never even reached, but
// assert the outcome end-to-end with the real command.
{
  const d = doc(p(text('abc')), p(text('def')))
  const state = withSelection(EditorState.create({ schema, doc: d }), 1, 9)
  const tr = captureToggle(state, schema.marks.strong)
  assert.ok(tr)
  assert.ok(tr.steps.length >= 2, 'cross-block toggleMark emits one step per block')
  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'blocked')
  assert.equal(classified.blockedCode, KERNEL_CODES.INPUT_TYPE)
}

// Case M7: mixed Remove+Add in one transaction (applyHighlightInView's
// color-REPLACE shape: removeMark then addMark over a partially-highlighted
// range) → blocked, never misread as a single toggle.
{
  const d = doc(p(text('ab'), schema.text('cd', [schema.mark('highlight', { color: 'yellow' })])))
  const state = EditorState.create({ schema, doc: d })
  const tr = state.tr
  tr.removeMark(1, 5, schema.marks.highlight)
  tr.addMark(1, 5, schema.mark('highlight', { color: 'yellow' }))
  const names = tr.steps.map((step) => step.constructor.name)
  assert.ok(names.includes('RemoveMarkStep') && names.includes('AddMarkStep'),
    'fixture sanity: the replace shape carries both step types: ' + names.join(','))
  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'blocked')
}

// Case M8: non-yellow highlight (red/blue round-trip as <mark class> HTML —
// the byte form the kernel fail-closes on) → blocked even though the mark
// name itself is in the kind table.
{
  const d = doc(p(text('abcd')))
  const state = withSelection(EditorState.create({ schema, doc: d }), 1, 3)
  const tr = captureToggle(state, schema.marks.highlight, { color: 'red' })
  assert.ok(tr)
  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'blocked')
  assert.equal(classified.blockedCode, KERNEL_CODES.INPUT_TYPE)
}

// Case M9 (stored-marks ADR): toggleMark on an EMPTY selection dispatches a
// stored-marks-only transaction — docChanged false. classifyTransactions
// says selection-only (pass-through); the dispatch channel never consults
// the gateway for it at all (editor-source-transactions.js gates on
// docChanged), which is why the empty-selection guard lives in
// editor-kernel-mode.js's marksKeymap, not here. Pinned so a future change
// to either side shows up.
{
  const d = doc(p(text('abcd')))
  const state = withSelection(EditorState.create({ schema, doc: d }), 2, 2)
  const tr = captureToggle(state, schema.marks.strong)
  assert.ok(tr, 'empty-selection toggleMark still dispatches (stored marks)')
  assert.equal(tr.docChanged, false)
  assert.ok(tr.storedMarks, 'fixture sanity: the transaction carries storedMarks')
  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'selection-only')
}

// Case M10: a toggle inside a textblock that ALREADY carries other marks is
// still mark-toggle (the isPlainTextblock guard is a plain-TEXT-path rule;
// unwrap/nesting shapes are exactly what the kernel command owns and
// re-proves against the raw bytes).
{
  const d = doc(p(text('a'), schema.text('bc', [schema.mark('emphasis')]), text('d')))
  const state = withSelection(EditorState.create({ schema, doc: d }), 1, 5)
  const tr = captureToggle(state, schema.marks.strong)
  assert.ok(tr)
  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'mark-toggle')
  assert.equal(classified.markKind, 'strong')
}

console.log('PASS kernel gateway')
