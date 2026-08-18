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
import { EditorState, PluginKey, TextSelection } from '@milkdown/prose/state'
import { toggleMark } from '@milkdown/prose/commands'
import { AddMarkStep } from '@milkdown/prose/transform'
import { classifyTransactions, commitPlainText, commitTaskToggle, commitCodeLanguage, commitImageAttrs, routeLinkEdit, __atomGuards } from '../src/renderer/src/components/editor-kernel-gateway.js'
import { buildProjectionMap } from '../src/renderer/src/components/editor-kernel-projection-map.js'
import { KERNEL_CODES, createMarkdownDocument, applySourceTransaction, parseKernelMarkdown } from '../src/renderer/src/lib/source-kernel/index.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    hard_break: { group: 'inline', inline: true, selectable: false },
    // The LIVE hardbreak node name is `hardbreak` (@milkdown/preset-commonmark
    // `$nodeSchema("hardbreak")`, probed 2026-08-17), NOT the `hard_break`
    // spelling the older fixtures above use. Both are declared so the P6-1
    // atom relaxation can be pinned against the name the shipped schema
    // actually registers — the relaxation's allowlist must refuse it.
    hardbreak: { group: 'inline', inline: true, atom: true },
    // preset-commonmark's `html` node (node/html.ts): an INLINE atom carrying
    // the raw fragment in `attrs.value` — the same spec
    // scripts/test-kernel-projection-map.mjs uses.
    html: { group: 'inline', inline: true, atom: true, attrs: { value: { default: '' } } },
    // Inline image (@milkdown/preset-commonmark `$nodeSchema("image")`) and
    // Crepe's inline LaTeX node (`math_inline`) — the two other inline atoms
    // the kernel charMap models as width-1 `atom` units. Added for P6 Task 1.
    image: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { src: { default: '' }, alt: { default: '' }, title: { default: null } }
    },
    math_inline: { group: 'inline', inline: true, atom: true, attrs: { value: { default: '' } } },
    // @milkdown/preset-commonmark's heading node: `attrs.id` is the slug
    // `syncHeadingIdPlugin` (a VIEW plugin) writes into the live document and
    // that no Markdown parse can ever produce — the shape the heading-id
    // classification below is built on.
    heading: {
      content: 'inline*',
      group: 'block',
      attrs: { id: { default: '' }, level: { default: 1 } }
    },
    // Plan 3 Task 4: same shape as scripts/test-kernel-projection-map.mjs's
    // schema (content 'text*', `attrs.language`) — the gateway relaxation
    // and the language-switch AttrStep shape both target this node type.
    code_block: { content: 'text*', group: 'block', code: true, attrs: { language: { default: '' } } },
    // A markdown blockquote-wrapped fence parses to mdast `blockquote > code`
    // (verified against the real parser) — buildProjectionMap pairs PM
    // structure against mdast structure 1:1, so a quoted-fence PM fixture
    // needs this wrapper node too, not just the bare code_block.
    blockquote: { content: 'block+', group: 'block' },
    // Plan 5 Task 4 — mirrors @milkdown/preset-gfm's real table nodes
    // (lib/index.js:88-280): `table_header_row table_row+`, `(table_header)*`
    // / `(table_cell)*`, `cellContent: 'paragraph'`. The `table` content
    // expression is widened only so a header-less fixture can be BUILT.
    table: { content: '(table_header_row | table_row)+', group: 'block' },
    table_header_row: { content: '(table_header)*' },
    table_row: { content: '(table_cell)*' },
    table_header: { content: 'paragraph+', attrs: { alignment: { default: 'left' } } },
    table_cell: { content: 'paragraph+', attrs: { alignment: { default: 'left' } } },
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
const img = (src) => schema.node('image', { src })
const mathInline = (value) => schema.node('math_inline', { value })
const inlineHtml = (value) => schema.node('html', { value })
// rows: array of rows; each row an array of cell TEXT strings ('' = empty cell).
const tbl = (rows) => schema.node('table', null, rows.map((cells, rowIndex) =>
  schema.node(rowIndex === 0 ? 'table_header_row' : 'table_row', null,
    cells.map((s) => schema.node(rowIndex === 0 ? 'table_header' : 'table_cell', null,
      [s ? p(text(s)) : p()])))))

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

// Case 6 (FLIPPED by P4-3.5 Fix B — this used to pin the blanket "any mark
// in the textblock refuses all typing" rule): a PLAIN insert into a
// textblock that carries a mark now classifies as plain-text and commits.
// The caret sits at visible 0 of a block STARTING with a mark run — the
// neutral insert resolver must land the plain char BEFORE the opening
// delimiter ('X**bold**', never '**Xbold**').
{
  const md = '**bold**\n'
  const d = doc(p(schema.text('bold', [schema.mark('strong')])))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'a marked paragraph maps (content-size identity holds)')
  // NB: `tr.insertText('X', 1)` would INHERIT the strong mark here
  // ($from.marks() falls through to the adjacent run at a boundary) and
  // correctly stay refused — the plain slice is built explicitly.
  const tr = state.tr.replaceWith(1, 1, text('X'))
  const result = classifyTransactions([tr], state)
  assert.equal(result.kind, 'plain-text')

  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
  assert.equal(committed.ok, true, committed.code)
  assert.deepEqual(committed.transaction.edits, [{ from: 0, to: 0, insert: 'X' }])
  assert.equal(committed.applied.doc.text, 'X**bold**\n')

  // …and the inheriting form IS refused (the mark-inheritance trap pin).
  const trInherit = state.tr.insertText('X', 1)
  assert.equal(classifyTransactions([trInherit], state).kind, 'blocked')
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

// Case 28 (CRLF un-narrowing, 2026-08-17): a CRLF-lineEnding code block is
// EDITABLE and every commit is byte-exact '\r\n'-preserving. Supersedes the
// 2026-08-16 fix-review ADR, which forced such blocks non-editable because
// the vendored @milkdown/components CodeMirrorBlock nodeview dropped '\r'
// from its own CM6 position model; `editor-codeblock-crlf.js` now fixes that
// bridge at the source (locked by scripts/test-codeblock-crlf-ui.mjs), so
// the gateway's own byte math is the only remaining contract — and it is
// proven here.
//
// KEY: the bridge hands PM a slice whose breaks are ALREADY spelled with the
// block's dominant ending ('\r\n'), so the gateway must NOT re-spell them
// (`'\r\n'.split('\n').join('\r\n')` would emit '\r' + '\r\n' — a lone '\r'
// injected into the source, the exact corruption family this is about). It
// requires every break to equal `charMap.lineEnding` and only adds the
// per-line prefix.
// md = '```js\r\nab\r\ncd\r\n```\r\n': '```js' 0-4 \r 5 \n 6 'ab' 7-8 \r 9
// \n 10 'cd' 11-12 \r 13 \n 14 '```' 15-17 \r 18 \n 19.
// PM content 'ab\r\ncd' starts at 1: a@1 b@2 \r@3 \n@4 c@5 d@6.
{
  const md = '```js\r\nab\r\ncd\r\n```\r\n'
  const d = doc(cb('js', 'ab\r\ncd'))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'CRLF code block doc must map')
  const pair = map.blockPairs[0]
  assert.ok(pair.charMap, 'CRLF code_block pair must be EDITABLE')
  assert.equal(pair.charMap.lineEnding, '\r\n')
  assert.equal(pair.charMap.visibleLength, pair.pmNode.content.size)

  // (a) single-char edit on line 2 — the shape the old CM position bug
  // could misalign. Insert before 'c' (PM 5 -> raw 11).
  {
    const tr = state.tr.insertText('X', 5)
    assert.equal(classifyTransactions([tr], state).kind, 'plain-text')
    const kernel = { doc: createMarkdownDocument(md) }
    const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
    assert.equal(committed.ok, true, committed.code)
    assert.equal(committed.applied.doc.text, '```js\r\nab\r\nXcd\r\n```\r\n')
  }

  // (b) multi-line insert. The bridge spells the break '\r\n', so the slice
  // is 'X\r\nY' — committed verbatim (no prefix on a bare fence), NOT
  // re-expanded.
  {
    const tr = state.tr.insertText('X\r\nY', 3)
    assert.equal(tr.steps.length, 1, 'fixture sanity: one ReplaceStep')
    const classified = classifyTransactions([tr], state)
    assert.equal(classified.kind, 'plain-text', "a '\\r\\n'-bearing code slice must classify as plain-text")
    assert.deepEqual(classified.steps[0], { from: 3, to: 3, insertText: 'X\r\nY' })
    const kernel = { doc: createMarkdownDocument(md) }
    const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
    assert.equal(committed.ok, true, committed.code)
    assert.equal(committed.applied.doc.text, '```js\r\nabX\r\nY\r\ncd\r\n```\r\n')
    assert.equal(/\r(?!\n)/.test(committed.applied.doc.text), false, 'no lone \\r may be injected')
  }

  // (c) cross-line-join delete: PM [3,5) is the whole '\r\n' pair (what the
  // patched bridge maps a CM line-start Backspace to). raw [9,11).
  {
    assert.equal(map.pmPosToRaw(3), 9)
    assert.equal(map.pmPosToRaw(5), 11)
    const tr = state.tr.delete(3, 5)
    assert.equal(classifyTransactions([tr], state).kind, 'plain-text')
    const kernel = { doc: createMarkdownDocument(md) }
    const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
    assert.equal(committed.ok, true, committed.code)
    assert.equal(committed.applied.doc.text, '```js\r\nabcd\r\n```\r\n')
  }

  // (d) FAIL-CLOSED: a bare '\n' break in a CRLF block is refused, never
  // silently re-spelled to '\r\n'. This is the residual shape the bridge
  // cannot serve (a block whose current text holds no '\r' — see the ADR in
  // commitPlainText); committing '\r\n' while PM holds '\n' would diverge
  // the view from the bytes and churn the verify repair on every keystroke.
  {
    const tr = state.tr.insertText('X\nY', 3)
    assert.equal(classifyTransactions([tr], state).kind, 'plain-text')
    const kernel = { doc: createMarkdownDocument(md) }
    const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
    assert.equal(committed.ok, false, 'a bare \\n in a CRLF block must fail closed')
    assert.equal(committed.code, KERNEL_CODES.UNMAPPED)
    assert.equal(kernel.doc.text, md, 'kernel bytes must be untouched by a refused edit')
  }
}

// Case 28e (review finding, 2026-08-17): the DELETE-side half of the byte
// contract — a raw range must never BISECT a '\r\n' pair. The code charMap
// models a CRLF ending as two units (a `char` unit for the '\r', then the
// `linebreak` unit for the '\n' which also spans the next line's prefix), so
// it legitimately exposes the boundary between them; a range landing there
// splits the ending. Reviewer-probed corruption shapes, all now refused with
// bytes untouched. (Not reachable through today's UI — the patched bridge's
// `cmToPm` never returns an interior offset — but the defence must live in
// this file, which owns the byte contract, not only in a prototype patch in
// another module.)
// md = '```js\r\nab\r\ncd\r\n```\r\n', PM content 'ab\r\ncd' from 1:
// a@1 b@2 \r@3 \n@4 c@5 d@6; units char[7,8) char[8,9) char[9,10)='\r'
// linebreak[10,11)='\n' char[11,12) char[12,13).
{
  const md = '```js\r\nab\r\ncd\r\n```\r\n'
  const d = doc(cb('js', 'ab\r\ncd'))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map)
  // The bisecting offset is REACHABLE through the map — this is a real
  // boundary, not an impossible one, which is exactly why it needs a guard.
  assert.equal(map.pmPosToRaw(4), 10, 'the map really does expose the mid-pair offset')

  const refuse = (label, tr) => {
    const kernel = { doc: createMarkdownDocument(md) }
    const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
    assert.equal(committed.ok, false, `${label} must fail closed`)
    assert.equal(committed.code, KERNEL_CODES.UNMAPPED)
    assert.equal(kernel.doc.text, md, `${label}: kernel bytes must be untouched`)
  }
  // (a) delete the '\n' half alone -> would leave a lone '\r'.
  refuse("deleting a CRLF pair's '\\n' half", state.tr.delete(4, 5))
  // (b) delete the '\r' half alone -> would leave a bare '\n' (mixed endings).
  refuse("deleting a CRLF pair's '\\r' half", state.tr.delete(3, 4))
  // (c) a zero-width insert landing between the halves would split the pair.
  refuse('inserting between the two halves of a CRLF pair', state.tr.insertText('X', 4))

  // ...while the correctly shaped FULL-pair delete still succeeds: neither
  // end sits between the two units (raw [9,11)).
  const kernel = { doc: createMarkdownDocument(md) }
  const ok = commitPlainText({ kernel, map, transactions: [state.tr.delete(3, 5)], oldState: state })
  assert.equal(ok.ok, true, ok.code)
  assert.equal(ok.applied.doc.text, '```js\r\nabcd\r\n```\r\n')
}

// Case 28f: the same guard on the QUOTED fence — the worst probed shape,
// because the `linebreak` unit's raw span carries the next line's '> '
// prefix: deleting the '\n' half alone would eat the quote marker while the
// lone '\r' survives as a line terminator (line 2 silently loses its prefix).
// md = '> ```js\r\n> a\r\n> b\r\n> ```\r\n', PM doc(bq(cb)) content 'a\r\nb'
// from 2: a@2 \r@3 \n@4 b@5; units char[11,12) char[12,13)='\r'
// linebreak[13,16)='\n> ' char[16,17).
{
  const md = '> ```js\r\n> a\r\n> b\r\n> ```\r\n'
  const d = doc(bq(cb('js', 'a\r\nb')))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map)
  assert.equal(map.pmPosToRaw(4), 13, 'the quoted fence exposes the mid-pair offset too')

  const kernel1 = { doc: createMarkdownDocument(md) }
  const refused = commitPlainText({ kernel: kernel1, map, transactions: [state.tr.delete(4, 5)], oldState: state })
  assert.equal(refused.ok, false, "deleting a quoted fence's '\\n' half must fail closed")
  assert.equal(refused.code, KERNEL_CODES.UNMAPPED)
  assert.equal(kernel1.doc.text, md, 'kernel bytes must be untouched')

  // The correctly shaped full-pair delete removes '\r\n> ' — ending AND the
  // next line's prefix — joining the two content lines.
  const kernel2 = { doc: createMarkdownDocument(md) }
  const ok = commitPlainText({ kernel: kernel2, map, transactions: [state.tr.delete(3, 5)], oldState: state })
  assert.equal(ok.ok, true, ok.code)
  assert.equal(ok.applied.doc.text, '> ```js\r\n> ab\r\n> ```\r\n')
}

// Case 28g: the guard is CRLF-specific and must not touch anything else — an
// LF fence's linebreak boundary (no '\r' anywhere) keeps deleting normally.
{
  const md = '> ```js\n> ab\n> cd\n> ```\n'
  const d = doc(bq(cb('js', 'ab\ncd')))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  const kernel = { doc: createMarkdownDocument(md) }
  const ok = commitPlainText({ kernel, map, transactions: [state.tr.delete(4, 5)], oldState: state })
  assert.equal(ok.ok, true, ok.code)
  assert.equal(ok.applied.doc.text, '> ```js\n> abcd\n> ```\n')
}

// Case 28b: quoted CRLF fence — the prefix-bearing shape. The gateway adds
// `linePrefix` after each break WITHOUT re-spelling the break itself.
// md = '> ```js\r\n> ab\r\n> ```\r\n': '>' 0 ' ' 1 '```js' 2-6 \r 7 \n 8
// '>' 9 ' ' 10 'a' 11 'b' 12 \r 13 \n 14 ...
// PM doc(bq(cb)): blockquote@0, code_block@1, content 'ab' start 2.
{
  const md = '> ```js\r\n> ab\r\n> ```\r\n'
  const d = doc(bq(cb('js', 'ab')))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'quoted CRLF single-line fence must map')
  const pair = map.blockPairs.find((candidate) => candidate.pmNode.type.name === 'code_block')
  assert.ok(pair.charMap, 'quoted CRLF code_block pair must be EDITABLE')
  assert.equal(pair.charMap.lineEnding, '\r\n')
  assert.equal(pair.charMap.linePrefix, '> ')
  // Insert 'X\r\nY' between 'a' and 'b' (PM 3 -> raw 12): the break keeps
  // its '\r\n' spelling and gains the '> ' prefix.
  const tr = state.tr.insertText('X\r\nY', 3)
  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text, '> ```js\r\n> aX\r\n> Yb\r\n> ```\r\n')
  assert.equal(/\r(?!\n)/.test(committed.applied.doc.text), false, 'no lone \\r may be injected')
}

// Case 28c: a lone-'\r' (classic Mac) fence is editable on the same terms —
// the break must be spelled '\r' (what the bridge's dominantLineEnding
// returns for such a block) and a '\r\n' or bare '\n' is refused.
// md = '```js\rab\rcd\r```\r': '```js' 0-4 \r 5 'ab' 6-7 \r 8 'cd' 9-10 \r 11
{
  const md = '```js\rab\rcd\r```\r'
  const d = doc(cb('js', 'ab\rcd'))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'lone-CR fence must map')
  assert.equal(map.blockPairs[0].charMap.lineEnding, '\r')

  const ok = commitPlainText({
    kernel: { doc: createMarkdownDocument(md) },
    map,
    transactions: [state.tr.insertText('X\rY', 2)],
    oldState: state
  })
  assert.equal(ok.ok, true, ok.code)
  assert.equal(ok.applied.doc.text, '```js\raX\rYb\rcd\r```\r')

  for (const bad of ['X\r\nY', 'X\nY']) {
    const refused = commitPlainText({
      kernel: { doc: createMarkdownDocument(md) },
      map,
      transactions: [state.tr.insertText(bad, 2)],
      oldState: state
    })
    assert.equal(refused.ok, false, `a ${JSON.stringify(bad)} break in a lone-CR block must fail closed`)
    assert.equal(refused.code, KERNEL_CODES.UNMAPPED)
  }
}

// Case 28d: the mirror guard — a '\r'-bearing break in an LF block is
// refused. The bridge cannot produce one (it only converts breaks for
// blocks whose text already contains '\r'), so such a slice has unknown
// provenance; LF documents keep exactly their pre-2026-08-17 behavior.
{
  const md = '```js\nab\ncd\n```\n'
  const d = doc(cb('js', 'ab\ncd'))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map)
  assert.equal(map.blockPairs[0].charMap.lineEnding, '\n')
  for (const bad of ['X\r\nY', 'X\rY']) {
    const refused = commitPlainText({
      kernel: { doc: createMarkdownDocument(md) },
      map,
      transactions: [state.tr.insertText(bad, 2)],
      oldState: state
    })
    assert.equal(refused.ok, false, `a ${JSON.stringify(bad)} break in an LF block must fail closed`)
    assert.equal(refused.code, KERNEL_CODES.UNMAPPED)
  }
  // ...while the plain '\n' break still commits exactly as before.
  const ok = commitPlainText({
    kernel: { doc: createMarkdownDocument(md) },
    map,
    transactions: [state.tr.insertText('X\nY', 2)],
    oldState: state
  })
  assert.equal(ok.ok, true, ok.code)
  assert.equal(ok.applied.doc.text, '```js\naX\nYb\ncd\n```\n')
}

// Case 21 (review fix, Plan 4 Task 2): gap-aware selection-start resolution
// through `commitPlainText`'s own `pmPosToRawStart` — the same corruption
// class the reviewer live-probed at the `replaceVisibleText`/character-map
// layer (`test-source-kernel-commands.mjs`'s "review fix" section), proven
// again here at the gateway layer.
//
// Note on the fixture shape (an UNMARKED PM paragraph against a MARKED
// markdown source, 'a **bold** b\n'): when this case was written (P4-2
// review), the then-blanket `isPlainTextblock` guard made this path
// unreachable through the live pipeline with a REAL marked PM doc, so the
// case proved `pmPosToRawStart` pre-emptively through a size-compatible
// unmarked stand-in (the projection pairing is content-SIZE-based, not
// mark-aware, so an unmarked 8-char PM paragraph legitimately pairs against
// an 8-visible-char markdown paragraph containing '**' bytes — exercising
// the exact same charMap gap). P4-3.5's Fix B has since relaxed the guard —
// the REAL marked-doc scenarios are covered end-to-end in the "Fix B"
// section below; this fixture stays as the focused pmPosToRawStart lock.
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

// ---- P4-3.5 Fix B: plain typing in marked textblocks (byte matrix) ----
// The blanket refusal is gone; every scenario below runs the REAL pipeline
// (classifyTransactions -> commitPlainText) against a REAL marked PM doc +
// buildProjectionMap. 'a **bold** b\n' raw indices: a=0 sp=1 *=2 *=3 b=4
// o=5 l=6 d=7 *=8 *=9 sp=10 b=11 \n=12. PM: p@0, contentPos 1, children
// 'a '(1..3), 'bold'[strong](3..7), ' b'(7..9).
const markedFixture = () => {
  const md = 'a **bold** b\n'
  const d = doc(p(text('a '), schema.text('bold', [schema.mark('strong')]), text(' b')))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'marked paragraph must map')
  return { md, state, map }
}
const commitOf = (md, map, state, tr) => {
  const kernel = { doc: createMarkdownDocument(md) }
  return { kernel, committed: commitPlainText({ kernel, map, transactions: [tr], oldState: state }) }
}

// (a) type BEFORE the bold run (plain slice): lands before the opening '**'.
{
  const { md, state, map } = markedFixture()
  const tr = state.tr.insertText('X', 3)
  assert.equal(classifyTransactions([tr], state).kind, 'plain-text')
  const { committed } = commitOf(md, map, state, tr)
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text, 'a X**bold** b\n')
}

// (b) type AFTER the bold run with a PLAIN slice: the neutral resolver
// lands the char AFTER the closing '**', never inside it. (Real typing at
// this exact caret inherits the strong mark — `$from.marks()` — and stays
// refused, pinned right below; the plain shape is built explicitly.)
{
  const { md, state, map } = markedFixture()
  const tr = state.tr.replaceWith(7, 7, text('X'))
  assert.equal(classifyTransactions([tr], state).kind, 'plain-text')
  const { committed } = commitOf(md, map, state, tr)
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text, 'a **bold**X b\n')

  // inherited-mark typing at the run's trailing edge → refused (trap pin).
  const trInherit = state.tr.insertText('X', 7)
  assert.equal(classifyTransactions([trInherit], state).kind, 'blocked')
}

// (c) type in the PLAIN run of the marked paragraph.
{
  const { md, state, map } = markedFixture()
  const tr = state.tr.insertText('X', 8) // between the space and trailing 'b'
  const { committed } = commitOf(md, map, state, tr)
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text, 'a **bold** Xb\n')
}

// (d) type BETWEEN two adjacent mark runs: the char lands between the
// closing and opening delimiters.
{
  const md = '**a**_b_\n'
  const d = doc(p(
    schema.text('a', [schema.mark('strong')]),
    schema.text('b', [schema.mark('emphasis')])
  ))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map)
  const tr = state.tr.replaceWith(2, 2, text('X')) // explicit plain slice
  const { committed } = commitOf(md, map, state, tr)
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text, '**a**X_b_\n')
}

// (e) type INSIDE the bold run with an inherited mark (real typing inside a
// run inserts a MARKED slice) → still refused: the storedMarks/
// mark-inheritance trap stays closed.
{
  const { state } = markedFixture()
  const tr = state.tr.replaceWith(5, 5, schema.text('X', [schema.mark('strong')]))
  const result = classifyTransactions([tr], state)
  assert.equal(result.kind, 'blocked')
  assert.equal(result.blockedCode, KERNEL_CODES.INPUT_TYPE)
}

// (f) DELETE straddling a mark boundary (from plain text INTO the run):
// would strand the run's delimiters ('a **' corruption shape) → refused.
{
  const { md, state, map } = markedFixture()
  const tr = state.tr.delete(2, 5) // ' b' of 'a |bo|ld' — crosses into the run
  const result = classifyTransactions([tr], state)
  assert.equal(result.kind, 'blocked')
  const { kernel, committed } = commitOf(md, map, state, tr)
  assert.equal(committed.ok, false)
  assert.equal(committed.code, KERNEL_CODES.INPUT_TYPE)
  assert.equal(kernel.doc.text, md, 'refused deletion leaves bytes untouched')
}

// (f2) …and the mirrored straddle (from inside the run OUT past its end).
{
  const { state } = markedFixture()
  const tr = state.tr.delete(5, 8)
  assert.equal(classifyTransactions([tr], state).kind, 'blocked')
}

// (g) delete the run's EXACT content → '****' residue (byte-consistent,
// pinned by the P4-2 decision — see Case 21(b) and the matching
// test-source-kernel-commands.mjs section).
{
  const { md, state, map } = markedFixture()
  const tr = state.tr.delete(3, 7)
  const { committed } = commitOf(md, map, state, tr)
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text, 'a **** b\n')
}

// (h) delete a range STRICTLY containing the whole run: the raw range
// provably covers the delimiters too — clean removal, no residue.
{
  const { md, state, map } = markedFixture()
  const tr = state.tr.delete(2, 8) // ' bold ' incl. both flanking chars
  const { committed } = commitOf(md, map, state, tr)
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text, 'ab\n')
}

// (i) a paragraph holding a HARD BREAK keeps refusing after the P6-1 atom
// relaxation — the break is the one inline atom that stayed out of the
// allowlist (its raw span is a LINE ENDING whose continuation prefix belongs
// to no charMap unit; see the P6-1 section at the end of this file for the
// probe). Both the legacy `hard_break` fixture spelling and the LIVE
// `hardbreak` node name are pinned, so an allowlist that keyed off the wrong
// spelling would fail here.
{
  for (const nodeName of ['hard_break', 'hardbreak']) {
    const d = doc(p(text('ab'), schema.nodes[nodeName].create(), text('cd')))
    const state = EditorState.create({ schema, doc: d })
    const tr = state.tr.insertText('X', 2)
    assert.equal(classifyTransactions([tr], state).kind, 'blocked', `${nodeName} must stay refused`)
  }
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

// Case M5: link is NOT a `mark-toggle` kind — `MARK_TOGGLE_KINDS` has no
// `link` entry, so a link AddMarkStep can never be routed through
// `toggleInlineMark`'s marker-wrapping command (there is no `[text](url)`
// marker pair to wrap with). Plan 5 Task 6 gave it its OWN classification
// instead (`link-edit`, Cases L1-L10 below), so the outcome flipped from
// `blocked` to `link-edit` — what this case still pins is that it never
// becomes a mark toggle.
{
  const d = doc(p(text('abcd')))
  const state = withSelection(EditorState.create({ schema, doc: d }), 1, 3)
  const tr = captureToggle(state, schema.marks.link, { href: 'https://x.example' })
  assert.ok(tr)
  const classified = classifyTransactions([tr], state)
  assert.notEqual(classified.kind, 'mark-toggle')
  assert.equal(classified.kind, 'link-edit')
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

// ===========================================================================
// Plan 5 Task 4 — GFM table CELL text editing through the ordinary plain-text
// path. No new classification kind: a step confined to ONE cell's paragraph
// already satisfies `extractPlainTextSteps`' single-textblock guard, and a
// step spanning two cells already fails it (`$from.sameParent($to)`).
// `commitPlainText` gains exactly one table-specific rule: a literal `|` may
// not be inserted into a cell (it would split the column).
// ===========================================================================

// Case T1: in-cell insert + delete, byte-exact.
// md '| a | b |\n| - | - |\n| c | d |\n' — cells' text at raw 2 / 6 / 22 / 26.
// PM: table@0, header row [1,13), body row [13,25); cell paragraphs at
// 3 / 8 / 15 / 20, so content positions 4 / 9 / 16 / 21.
{
  const md = '| a | b |\n| - | - |\n| c | d |\n'
  const d = doc(tbl([['a', 'b'], ['c', 'd']]))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'table doc must map')
  assert.equal(map.blockPairs.length, 4)
  assert.ok(map.blockPairs.every((pair) => pair.charMap), 'every cell is editable')

  // (a) type 'X' after 'a' (PM 5 -> raw 3).
  {
    const tr = state.tr.insertText('X', 5)
    assert.equal(classifyTransactions([tr], state).kind, 'plain-text')
    const kernel = { doc: createMarkdownDocument(md) }
    const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
    assert.equal(committed.ok, true, committed.code)
    assert.equal(committed.applied.doc.text, '| aX | b |\n| - | - |\n| c | d |\n')
  }
  // (b) type before 'd' in the LAST body cell (PM 21 -> raw 26).
  {
    const tr = state.tr.insertText('Z', 21)
    const kernel = { doc: createMarkdownDocument(md) }
    const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
    assert.equal(committed.ok, true, committed.code)
    assert.equal(committed.applied.doc.text, '| a | b |\n| - | - |\n| c | Zd |\n')
  }
  // (c) delete the cell's only character (PM [4,5) -> raw [2,3)) — the `|`
  // delimiters and padding are untouched, the table keeps its shape.
  {
    const tr = state.tr.delete(4, 5)
    assert.equal(classifyTransactions([tr], state).kind, 'plain-text')
    const kernel = { doc: createMarkdownDocument(md) }
    const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
    assert.equal(committed.ok, true, committed.code)
    assert.equal(committed.applied.doc.text, '|  | b |\n| - | - |\n| c | d |\n')
  }
  // (d) replace a selection inside one cell.
  {
    const tr = state.tr.replaceWith(4, 5, text('YY'))
    const kernel = { doc: createMarkdownDocument(md) }
    const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
    assert.equal(committed.ok, true, committed.code)
    assert.equal(committed.applied.doc.text, '| YY | b |\n| - | - |\n| c | d |\n')
  }
}

// Case T2: a step spanning TWO cells is refused at classification — the
// gateway never sees a cross-cell edit as plain text.
{
  const md = '| a | b |\n| - | - |\n| c | d |\n'
  const d = doc(tbl([['a', 'b'], ['c', 'd']]))
  const state = EditorState.create({ schema, doc: d })
  const tr = state.tr.delete(4, 10) // cell0 content .. cell1 content
  assert.equal(tr.docChanged, true, 'fixture sanity: the delete changed the doc')
  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'blocked', 'a cross-cell range must be refused')
  assert.equal(classified.blockedCode, KERNEL_CODES.INPUT_TYPE)
}
// …and a cross-ROW range too.
{
  const md = '| a | b |\n| - | - |\n| c | d |\n'
  const d = doc(tbl([['a', 'b'], ['c', 'd']]))
  const state = EditorState.create({ schema, doc: d })
  const tr = state.tr.delete(4, 17)
  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'blocked', 'a cross-row range must be refused')
  void md
}

// Case T3: inserting a literal `|` into a cell is refused by
// `commitPlainText` — the byte would split the column, i.e. change the
// table's STRUCTURE, which is out of this phase's scope.
{
  const md = '| a | b |\n| - | - |\n| c | d |\n'
  const d = doc(tbl([['a', 'b'], ['c', 'd']]))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  const tr = state.tr.insertText('|', 5)
  assert.equal(classifyTransactions([tr], state).kind, 'plain-text',
    'it classifies as plain text — the refusal is a byte-level rule, not a shape rule')
  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
  assert.equal(committed.ok, false)
  assert.equal(committed.code, KERNEL_CODES.UNSUPPORTED)
  // The same byte typed into an ORDINARY paragraph is still fine.
  const plain = doc(p(text('ab')))
  const plainState = EditorState.create({ schema, doc: plain })
  const plainMap = buildProjectionMap('ab\n', plainState.doc)
  const plainCommit = commitPlainText({
    kernel: { doc: createMarkdownDocument('ab\n') },
    map: plainMap,
    transactions: [plainState.tr.insertText('|', 2)],
    oldState: plainState
  })
  assert.equal(plainCommit.ok, true, plainCommit.code)
  assert.equal(plainCommit.applied.doc.text, 'a|b\n')
}

// Case T4: a QUOTED table. The '> ' prefix sits before every row's own start
// offset, so it is never inside a cell — the commit only rewrites cell bytes.
// md '> | a | b |\n> | - | - |\n> | c | d |\n': texts at raw 4 / 8 / 32 / 36.
// PM: blockquote@0, table@1, header row [2,14), cell paragraphs at 4 / 9 /
// 16 / 21 -> content positions 5 / 10 / 17 / 22.
{
  const md = '> | a | b |\n> | - | - |\n> | c | d |\n'
  const d = doc(bq(tbl([['a', 'b'], ['c', 'd']])))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'quoted table doc must map')
  const cells = map.blockPairs.filter((pair) => pair.tableCell)
  assert.equal(cells.length, 4)
  assert.equal(map.pmPosToRaw(5), 4)
  const tr = state.tr.insertText('X', 6)
  assert.equal(classifyTransactions([tr], state).kind, 'plain-text')
  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text, '> | aX | b |\n> | - | - |\n> | c | d |\n')
}

// Case T5: a CRLF table. Line endings only ever sit between rows, so a cell
// edit can never touch one — and the file stays uniformly CRLF.
// md '| ab | cd |\r\n| --- | --- |\r\n| ef | gh |\r\n': texts at raw [2,4)
// [7,9) [30,32) [35,37).
{
  const md = '| ab | cd |\r\n| --- | --- |\r\n| ef | gh |\r\n'
  const d = doc(tbl([['ab', 'cd'], ['ef', 'gh']]))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'CRLF table doc must map')
  assert.ok(map.blockPairs.every((pair) => pair.charMap))
  // A 2-char cell: paragraph nodeSize 4, cell 6, row 14 -> cell0's paragraph
  // is at 3, content position 4, so PM 5 sits between 'a' and 'b' (raw 3).
  const tr = state.tr.insertText('X', 5)
  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text,
    '| aXb | cd |\r\n| --- | --- |\r\n| ef | gh |\r\n')
  assert.equal(/\r(?!\n)/.test(committed.applied.doc.text), false, 'no lone \\r')
  assert.equal(/(?<!\r)\n/.test(committed.applied.doc.text), false, 'no bare \\n')
}

// Case T6: typing into an EMPTY cell. mdast gives the cell no children at all
// and its own `position.start` is the leading `|`; table-map.js derives the
// anchor from the padding bytes so the insert lands INSIDE the cell.
// md '| a |  |\n| - | - |\n| c | d |\n' — the empty header cell is raw [4,8),
// anchor 6. PM: cell0 nodeSize 5, cell1 (empty paragraph) nodeSize 4 -> cell1
// paragraph @8, content position 9.
{
  const md = '| a |  |\n| - | - |\n| c | d |\n'
  const d = doc(tbl([['a', ''], ['c', 'd']]))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'table with an empty cell must map')
  assert.ok(map.blockPairs.every((pair) => pair.charMap), 'the empty cell is editable too')
  assert.equal(map.blockPairs[1].charMap.visibleLength, 0)
  const tr = state.tr.insertText('X', 9)
  assert.equal(classifyTransactions([tr], state).kind, 'plain-text')
  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text, '| a | X |\n| - | - |\n| c | d |\n')
}

// Case T7: a DEGRADED table (ragged) refuses every write into it, and the
// delimiter row is unreachable in every table.
{
  const md = '| a | b |\n| - | - |\n| c |\n'
  const d = doc(tbl([['a', 'b'], ['c']]))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'a ragged table must not null the map')
  assert.equal(map.blockPairs.length, 1)
  assert.equal(map.blockPairs[0].charMap, null)
  const tr = state.tr.insertText('X', 5)
  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
  assert.equal(committed.ok, false, 'a write into a degraded table must fail closed')
  assert.equal(committed.code, KERNEL_CODES.UNMAPPED)
}

// ===========================================================================
// Case T8 — WHOLE-BRANCH REVIEW, CRITICAL 1 (2026-08-17): a COMPACT table
// cell must be proven by a REPARSE, not by a byte-level guard on the inserted
// characters.
//
// The pre-fix guard asked `step.insertText.includes('|')`. A backslash
// contains no '|', so it passed — and in a COMPACT (unpadded) table it lands
// directly before the neighbouring delimiter, turning it into '\|', which GFM
// unescapes BEFORE splitting the row. The header then has one column while
// the delimiter row has two, and the whole block stops being a table:
//
//   '|a|b|\n|-|-|\n|c|d|\n' + one '\' after 'a'
//     committed '|a\|b|\n|-|-|\n|c|d|\n'
//     which parseKernelMarkdown reports as a single `paragraph`.
//
// Nothing downstream caught it: `verifyPlainTextProjection` runs AFTER
// `kernel.doc` is advanced, so it repaired the VIEW to match the corrupted
// bytes and the file was saved that way. HorseMD-native PADDED tables hide
// the shape entirely (the '\' lands before a space), which is why fuzzing on
// this repo's own fixtures never produced it.
{
  const compact = '|a|b|\n|-|-|\n|c|d|\n'
  const d = doc(tbl([['a', 'b'], ['c', 'd']]))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(compact, state.doc)
  assert.ok(map, 'a compact table must map')
  assert.ok(map.blockPairs.every((pair) => pair.charMap), 'every compact cell is editable')

  // RED evidence, kept executable: these ARE the bytes the old path
  // committed, and this is what they parse to.
  {
    const corrupted = '|a\\|b|\n|-|-|\n|c|d|\n'
    assert.deepEqual(parseKernelMarkdown(corrupted).children.map((child) => child.type), ['paragraph'],
      'fixture sanity: the escaped delimiter really does destroy the table')
  }

  // (a) the header cell — refused, with the kernel document untouched.
  {
    const kernel = { doc: createMarkdownDocument(compact) }
    const tr = state.tr.insertText('\\', 5)
    assert.equal(classifyTransactions([tr], state).kind, 'plain-text',
      'it still classifies as plain text — the refusal is a proof, not a shape rule')
    const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
    assert.equal(committed.ok, false, "typing '\\' at the end of a compact cell must be refused")
    assert.equal(committed.code, KERNEL_CODES.UNSUPPORTED)
    assert.equal(kernel.doc.text, compact, 'a refused commit must leave kernel.doc byte-identical')
  }

  // (b) a BODY cell of the same table — same refusal (the row loses a column).
  {
    const kernel = { doc: createMarkdownDocument(compact) }
    const tr = state.tr.insertText('\\', 17)
    const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
    assert.equal(committed.ok, false, "'\\' before a body-row delimiter must be refused too")
    assert.equal(committed.code, KERNEL_CODES.UNSUPPORTED)
  }

  // (c) GREEN, byte-exact: an ordinary character in the same compact cell
  //     still commits — the proof refuses corruption, not compact tables.
  {
    const kernel = { doc: createMarkdownDocument(compact) }
    const tr = state.tr.insertText('X', 5)
    const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
    assert.equal(committed.ok, true, committed.code)
    assert.equal(committed.applied.doc.text, '|aX|b|\n|-|-|\n|c|d|\n')
  }

  // (d) GREEN, byte-exact: the SAME backslash in a PADDED table is legal —
  //     it lands before a space, the table keeps its shape, so the proof
  //     passes and the byte is committed verbatim. (This is the assertion
  //     that would catch an over-broad "refuse all backslashes" fix.)
  {
    const padded = '| a | b |\n| - | - |\n| c | d |\n'
    const paddedMap = buildProjectionMap(padded, state.doc)
    const kernel = { doc: createMarkdownDocument(padded) }
    const tr = state.tr.insertText('\\', 5)
    const committed = commitPlainText({ kernel, map: paddedMap, transactions: [tr], oldState: state })
    assert.equal(committed.ok, true, committed.code)
    assert.equal(committed.applied.doc.text, '| a\\ | b |\n| - | - |\n| c | d |\n')
    assert.deepEqual(parseKernelMarkdown(committed.applied.doc.text).children.map((c) => c.type), ['table'],
      'the padded table survives, which is exactly why the commit is allowed')
  }

  // (e) TWO DOCUMENTS ALTERNATING (re-review round 2, finding C2). The
  //     baseline-signature memo is per-`kernel` (a WeakMap), because HorseMD
  //     keeps every tab's editor mounted and a module-global slot would thrash
  //     to a 0% hit rate when two tabs are typed alternately. Correctness must
  //     not depend on which document was touched last: alternate commits into
  //     a COMPACT and a PADDED table and assert each keeps its own verdict.
  {
    const padded = '| a | b |\n| - | - |\n| c | d |\n'
    const compactKernel = { doc: createMarkdownDocument(compact) }
    const paddedKernel = { doc: createMarkdownDocument(padded) }
    const paddedMap = buildProjectionMap(padded, state.doc)
    for (let round = 0; round < 3; round += 1) {
      // The compact table refuses the backslash every time…
      const refused = commitPlainText({
        kernel: compactKernel, map, transactions: [state.tr.insertText('\\', 5)], oldState: state
      })
      assert.equal(refused.ok, false, `round ${round}: the compact cell must still refuse`)
      assert.equal(compactKernel.doc.text, compact)
      // …while the padded one accepts it every time, byte-exact.
      const accepted = commitPlainText({
        kernel: paddedKernel, map: paddedMap, transactions: [state.tr.insertText('\\', 5)], oldState: state
      })
      assert.equal(accepted.ok, true, `round ${round}: the padded cell must still commit (${accepted.code})`)
      assert.equal(accepted.applied.doc.text, '| a\\ | b |\n| - | - |\n| c | d |\n')
      // Advance the padded document so the next round's baseline differs,
      // which is exactly the interleaving that evicts a shared single slot.
      paddedKernel.doc = createMarkdownDocument(padded)
    }
  }

  // (f) the proof is SCOPED to table cells: the same byte in an ordinary
  //     paragraph never pays for a reparse and never refuses.
  {
    const plain = doc(p(text('ab')))
    const plainState = EditorState.create({ schema, doc: plain })
    const plainMap = buildProjectionMap('ab\n', plainState.doc)
    const committed = commitPlainText({
      kernel: { doc: createMarkdownDocument('ab\n') },
      map: plainMap,
      transactions: [plainState.tr.insertText('\\', 2)],
      oldState: plainState
    })
    assert.equal(committed.ok, true, committed.code)
    assert.equal(committed.applied.doc.text, 'a\\b\n')
  }
}

// ===========================================================================
// Case H — THE INLINE-HTML TYPING CONTRACT, pinned so the user guide cannot
// drift from it again (2026-08-17 whole-branch review, "Also fix").
//
// HISTORY, because this assertion has now been INVERTED once and the reason
// matters: guide/basics/rich-and-source.md originally claimed that in a
// paragraph holding an inline HTML fragment 「同一段落里片段以外的位置可以正常
// 输入」. At the time that was FALSE — `textblockProfile` returned null for ANY
// textblock with a non-text inline child, so every ReplaceStep in such a
// paragraph was refused wherever the caret sat, and this case pinned the
// refusal. P6 Task 1 made the guide's original claim TRUE by relaxing the
// admission (see the P6-1 section at the end of this file): typing OUTSIDE
// the fragment now commits byte-exactly, and only steps that INTERSECT the
// fragment are refused. The case is kept, inverted, so the pairing stays
// pinned in whichever direction the code actually behaves.
{
  const md = '片段 <span>内联</span> 结束。\n'
  const d = doc(p(text('片段 '), inlineHtml('<span>内联</span>'), text(' 结束。')))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'inline-HTML paragraph must map')
  // PM content: '片段 ' (3) + the html atom (1) + ' 结束。' (4). Typing at
  // EVERY inline position — before the fragment, at both of its edges, and
  // after it — is now plain text, and there is no PM position INSIDE the
  // width-1 atom to type into.
  const lastPos = state.doc.content.size - 1
  assert.equal(lastPos, 9, 'fixture sanity: the paragraph holds 8 inline positions')
  for (let pos = 1; pos <= lastPos; pos += 1) {
    const tr = state.tr.insertText('X', pos)
    const classified = classifyTransactions([tr], state)
    assert.equal(classified.kind, 'plain-text',
      `typing at PM ${pos} in an inline-HTML paragraph must now be plain text`)
  }
  // Bytes at the two fragment edges (raw: '片段 ' = [0,3), fragment [3,17),
  // ' 结束。' = [17,21)).
  {
    const { committed } = commitOf(md, map, state, state.tr.insertText('X', 4))
    assert.equal(committed.ok, true, committed.code)
    assert.equal(committed.applied.doc.text, '片段 X<span>内联</span> 结束。\n')
  }
  {
    const { committed } = commitOf(md, map, state, state.tr.insertText('X', 5))
    assert.equal(committed.ok, true, committed.code)
    assert.equal(committed.applied.doc.text, '片段 <span>内联</span>X 结束。\n')
  }
  // A deletion that swallows the fragment WHOLE commits since P6-1b, removing
  // all fourteen of its bytes and nothing else — a half-deleted tag is what
  // the guard exists to prevent, and that shape stays unrepresentable.
  {
    const { committed } = commitOf(md, map, state, state.tr.delete(4, 5))
    assert.equal(committed.ok, true, committed.code)
    assert.equal(committed.applied.doc.text, '片段  结束。\n')
  }
}

console.log('PASS kernel gateway')

// ---- Image attribute AttrSteps (Plan 5 Task 5) ----
//
// The node/attr shapes below are the REAL ones, probed from the live
// components rather than invented:
//   @milkdown/components image-block/index.js:564-580 — `setAttr(attr, value)`
//     dispatches a bare `tr.setNodeAttribute(pos, attr, value)`; the only call
//     sites are `caption` (:400,:410), `ratio` (:436) and `src` (:545).
//   @milkdown/components image-inline/index.js:257 — the same, `src` only.
//   The `alt` attr on `image-block` is THIS repo's own schema extension
//     (src/renderer/src/components/editor-image-markdown.js:20-65).
const imgSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    // Inline image: @milkdown/preset-commonmark's imageSchema attrs, verbatim.
    image: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { src: { default: '' }, alt: { default: '' }, title: { default: '' } }
    },
    // Block image: upstream `{src, caption, ratio}` PLUS this repo's `alt`.
    'image-block': {
      group: 'block',
      atom: true,
      attrs: {
        src: { default: '' },
        alt: { default: '' },
        caption: { default: '' },
        ratio: { default: 1 }
      }
    },
    text: { group: 'inline' }
  }
})
const imgDoc = (...c) => imgSchema.node('doc', null, c)
const imgP = (...c) => imgSchema.node('paragraph', null, c)
const imgText = (s) => imgSchema.text(s)

// Case I1: the block-image `src` AttrStep (the ONE image path the real UI can
// reach today — the empty-image ImageInput's confirm button) classifies as
// `image-attrs` and commits the destination segment byte-exactly.
{
  const md = '![a](old.png)\n'
  const d = imgDoc(imgSchema.node('image-block', { src: 'old.png', alt: 'a', caption: 'a' }))
  const state = EditorState.create({ schema: imgSchema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'a standalone image maps (image-block <-> paragraph > image)')
  assert.equal(map.blockPairs[0].charMap, null, 'the image-block pair stays NON-editable')

  const tr = state.tr.setNodeAttribute(0, 'src', 'new/pic.png')
  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'image-attrs')
  assert.deepEqual(
    { pmPos: classified.pmPos, blockImage: classified.blockImage, attr: classified.attr, value: classified.value },
    { pmPos: 0, blockImage: true, attr: 'src', value: 'new/pic.png' }
  )

  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitImageAttrs({ kernel, map, ...classified })
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text, '![a](new/pic.png)\n')
  assert.deepEqual(committed.transaction.edits, [{ from: 5, to: 12, insert: 'new/pic.png' }])
  assert.equal(committed.transaction.intent, 'image-attrs')
}

// Case I2: block-image `alt` — no UI reaches it today, but the route is proven
// so a future one does not have to reopen the gateway.
{
  // A three-block document so the commit is provably scoped to the middle
  // block (this schema has no heading node, so the lead-in is a paragraph).
  const md = 't\n\n![a](x.png)\n\n尾\n'
  const d = imgDoc(
    imgP(imgText('t')),
    imgSchema.node('image-block', { src: 'x.png', alt: 'a', caption: 'a' }),
    imgP(imgText('尾'))
  )
  const state = EditorState.create({ schema: imgSchema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map)
  const imagePos = 3 // paragraph@0 (nodeSize 3) -> image-block@3
  assert.equal(state.doc.nodeAt(imagePos)?.type.name, 'image-block')

  const tr = state.tr.setNodeAttribute(imagePos, 'alt', '说明文字')
  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'image-attrs')
  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitImageAttrs({ kernel, map, ...classified })
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text, 't\n\n![说明文字](x.png)\n\n尾\n',
    'only the label segment moves; the blocks around it are untouched')
  assert.deepEqual(committed.transaction.edits, [{ from: 5, to: 6, insert: '说明文字' }])
}

// Case I3: the INLINE image is already an atom UNIT inside its paragraph's
// charMap, so its AttrStep resolves through the ordinary `pmPosToRaw` — all
// three of src/alt/title route and commit.
{
  const md = '前![a](x.png)后\n'
  const d = imgDoc(imgP(imgText('前'), imgSchema.node('image', { src: 'x.png', alt: 'a' }), imgText('后')))
  const state = EditorState.create({ schema: imgSchema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'a paragraph with an inline image maps (the image is one width-1 atom)')
  assert.equal(state.doc.nodeAt(2)?.type.name, 'image')
  assert.equal(map.pmPosToRaw(2), 1, "the atom's PM position resolves to the '!' of ![a](x.png)")

  for (const [attr, value, expected] of [
    ['src', 'y.png', '前![a](y.png)后\n'],
    ['alt', 'B', '前![B](x.png)后\n'],
    ['title', '标题', '前![a](x.png "标题")后\n']
  ]) {
    const tr = state.tr.setNodeAttribute(2, attr, value)
    const classified = classifyTransactions([tr], state)
    assert.equal(classified.kind, 'image-attrs', `${attr} must classify`)
    assert.equal(classified.blockImage, false)
    const kernel = { doc: createMarkdownDocument(md) }
    const committed = commitImageAttrs({ kernel, map, ...classified })
    assert.equal(committed.ok, true, committed.code)
    assert.equal(committed.applied.doc.text, expected)
  }
}

// Case I4: DISPLAY-ONLY attrs. `caption` (caption editing) and `ratio` (the
// resize handle) are ProseMirror-side state whose only Markdown expression is
// the historical ratio-in-alt convention owned by
// components/editor-image-markdown.js. They are deliberately NOT classified,
// so the batch stays `blocked`/INPUT_TYPE and the dispatch veto refuses it —
// never a silent PM-only change the next reparse would discard.
{
  const md = '![a](x.png)\n'
  const d = imgDoc(imgSchema.node('image-block', { src: 'x.png', alt: 'a', caption: 'a' }))
  const state = EditorState.create({ schema: imgSchema, doc: d })

  const caption = classifyTransactions([state.tr.setNodeAttribute(0, 'caption', '新标题')], state)
  assert.equal(caption.kind, 'blocked')
  assert.equal(caption.blockedCode, KERNEL_CODES.INPUT_TYPE)

  const ratio = classifyTransactions([state.tr.setNodeAttribute(0, 'ratio', 0.5)], state)
  assert.equal(ratio.kind, 'blocked')
  assert.equal(ratio.blockedCode, KERNEL_CODES.INPUT_TYPE)
  assert.equal(md, '![a](x.png)\n', 'nothing was committed')
}

// Case I5: RATIO-IN-ALT PRESERVATION. A genuinely resized image-block
// (|ratio-1| > 0.001 — the exact predicate editor-image-markdown.js:51
// serializes on) has its raw `alt` slot occupied by the numeric ratio and its
// `title` slot by the caption. Every kernel attr route is refused for such a
// node, so no user-supplied alt can ever overwrite the persisted resize.
{
  const md = '![1.50](x.png "说明")\n'
  const d = imgDoc(imgSchema.node('image-block', { src: 'x.png', alt: '', caption: '说明', ratio: 1.5 }))
  const state = EditorState.create({ schema: imgSchema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'a resized image still MAPS — it is only the attr route that is refused')

  for (const attr of ['src', 'alt', 'title']) {
    const classified = classifyTransactions([state.tr.setNodeAttribute(0, attr, 'x')], state)
    assert.equal(classified.kind, 'blocked', `${attr} on a resized image-block must be refused`)
    assert.equal(classified.blockedCode, KERNEL_CODES.INPUT_TYPE)
  }

  // A ratio of exactly 1 (and one within the 0.001 tolerance) is NOT resized —
  // those keep routing normally.
  const unresized = imgDoc(imgSchema.node('image-block', { src: 'x.png', alt: 'a', caption: 'a', ratio: 1.0005 }))
  const unresizedState = EditorState.create({ schema: imgSchema, doc: unresized })
  assert.equal(
    classifyTransactions([unresizedState.tr.setNodeAttribute(0, 'src', 'y.png')], unresizedState).kind,
    'image-attrs'
  )
}

// Case I6: `commitImageAttrs` fails closed on inputs it cannot resolve — a
// pmPos with no matching pair, a non-string value, a missing map.
{
  const md = '![a](x.png)\n'
  const d = imgDoc(imgSchema.node('image-block', { src: 'x.png', alt: 'a', caption: 'a' }))
  const state = EditorState.create({ schema: imgSchema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  const kernel = { doc: createMarkdownDocument(md) }

  assert.deepEqual(
    commitImageAttrs({ kernel, map, pmPos: 99, blockImage: true, attr: 'src', value: 'y' }),
    { ok: false, code: KERNEL_CODES.UNMAPPED }
  )
  assert.deepEqual(
    commitImageAttrs({ kernel, map, pmPos: 0, blockImage: true, attr: 'ratio', value: '2' }),
    { ok: false, code: KERNEL_CODES.INPUT_TYPE }
  )
  assert.deepEqual(
    commitImageAttrs({ kernel, map, pmPos: 0, blockImage: true, attr: 'src', value: 2 }),
    { ok: false, code: KERNEL_CODES.INPUT_TYPE }
  )
  assert.deepEqual(
    commitImageAttrs({ kernel, map: null, pmPos: 0, blockImage: true, attr: 'src', value: 'y' }),
    { ok: false, code: KERNEL_CODES.UNMAPPED }
  )
  // A value the command cannot prove byte-for-byte (a line ending would end
  // the block) surfaces the command's own code, not a generic one.
  assert.deepEqual(
    commitImageAttrs({ kernel, map, pmPos: 0, blockImage: true, attr: 'alt', value: 'a\nb' }),
    { ok: false, code: KERNEL_CODES.UNSUPPORTED }
  )
  assert.equal(kernel.doc.text, md, 'no refusal path mutated the document')
}

// Case I6b (review finding, 2026-08-17): `commitImageAttrs` must RE-DERIVE the
// ratio-in-alt guard, not inherit it from classification. Called directly —
// the shape a future caller, a replay, or a refactor that reorders the
// classification chain would produce — it used to write straight through and
// destroy the persisted resize. This is the reviewer's exact probe.
{
  const md = '![1.50](x.png "说明")\n'
  const d = imgDoc(imgSchema.node('image-block', { src: 'x.png', alt: '', caption: '说明', ratio: 1.5 }))
  const state = EditorState.create({ schema: imgSchema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map)
  const kernel = { doc: createMarkdownDocument(md) }

  for (const attr of ['alt', 'title', 'src']) {
    assert.deepEqual(
      commitImageAttrs({ kernel, map, pmPos: 0, blockImage: true, attr, value: 'user alt' }),
      { ok: false, code: KERNEL_CODES.UNSUPPORTED },
      `${attr} must be refused at COMMIT even when classification is bypassed`
    )
  }
  assert.equal(kernel.doc.text, md, 'the numeric ratio alt and the caption title are intact')

  // The predicate is the SERIALIZER's, verbatim (editor-image-markdown.js:51):
  // `ratio > 0` is part of it, so a non-positive ratio is NOT the resized
  // state and keeps routing normally on both boundaries.
  const zeroDoc = imgDoc(imgSchema.node('image-block', { src: 'x.png', alt: 'a', caption: 'a', ratio: 0 }))
  const zeroState = EditorState.create({ schema: imgSchema, doc: zeroDoc })
  const zeroMd = '![a](x.png)\n'
  const zeroMap = buildProjectionMap(zeroMd, zeroState.doc)
  assert.equal(
    classifyTransactions([zeroState.tr.setNodeAttribute(0, 'src', 'y.png')], zeroState).kind,
    'image-attrs'
  )
  const zeroKernel = { doc: createMarkdownDocument(zeroMd) }
  const zeroCommit = commitImageAttrs({ kernel: zeroKernel, map: zeroMap, pmPos: 0, blockImage: true, attr: 'src', value: 'y.png' })
  assert.equal(zeroCommit.ok, true, zeroCommit.code)
  assert.equal(zeroCommit.applied.doc.text, '![a](y.png)\n')
}

// Case I7: an AttrStep on a NON-image node with an image attr name (or a
// multi-step batch) is not an image edit.
{
  const d = imgDoc(imgP(imgText('abc')), imgSchema.node('image-block', { src: 'x.png' }))
  const state = EditorState.create({ schema: imgSchema, doc: d })
  // Built as a real AttrStep on the image, then re-pointed at the paragraph —
  // the same "re-label the step" technique Case 17 uses, because this schema
  // (like the real one) gives `paragraph` no `src` attr to set.
  const tr = state.tr.setNodeAttribute(5, 'src', 'y.png')
  assert.equal(classifyTransactions([tr], state).kind, 'image-attrs')
  tr.steps[0].pos = 0
  assert.notEqual(classifyTransactions([tr], state).kind, 'image-attrs',
    'the node at step.pos must actually BE an image node')

  // A batch carrying more than the one AttrStep is never an image edit.
  const multi = state.tr.setNodeAttribute(5, 'src', 'y.png').insertText('x', 1)
  assert.notEqual(classifyTransactions([multi], state).kind, 'image-attrs')
}

console.log('PASS kernel gateway (image attrs: src/alt/title route, caption/ratio refused, ratio-in-alt preserved)')

// ---- Link editing (Plan 5 Task 6) ----
//
// Every transaction below is built the way @milkdown/components' LinkTooltip
// builds it (`#confirmEdit` / `removeLink`, link-tooltip/edit/edit-view.ts:
// 102-129 and :188-196) — same step ORDER, same `type.create({ href })`
// (title defaults to null), same "insert the href text then mark it" for an
// empty selection. Nothing is hand-shaped into the classifier's expectations.
const linkMark = (href) => schema.mark('link', { href })

// The tooltip's four dispatch shapes, as functions of (state, from, to, href).
const tooltipWrap = (state, from, to, href) => {
  const tr = state.tr
  tr.addMark(from, to, linkMark(href))
  return tr
}
const tooltipEdit = (state, from, to, oldHref, href) => {
  const tr = state.tr
  tr.removeMark(from, to, linkMark(oldHref))
  tr.addMark(from, to, linkMark(href))
  return tr
}
const tooltipRemove = (state, from, to) => {
  const tr = state.tr
  tr.removeMark(from, to, schema.marks.link)
  return tr
}
const tooltipInsert = (state, at, href) => {
  const tr = state.tr
  tr.insertText(href, at)
  tr.addMark(at, at + href.length, linkMark(href))
  return tr
}

// The kernel-mode route's own pair lookup (editor-kernel-mode.js
// `editablePairForRange`), reproduced here so the commit assertions exercise
// the same PM->visible conversion the live route performs.
const pairForRange = (map, from, to) =>
  (map?.blockPairs || []).find((candidate) => {
    if (!candidate.charMap || candidate.virtual) return false
    const contentPos = candidate.pmPos + 1
    return from >= contentPos && to <= contentPos + candidate.charMap.visibleLength
  }) || null

const commitLink = (md, pmDoc, classified) => {
  const map = buildProjectionMap(md, pmDoc)
  assert.ok(map, 'fixture must build a projection map')
  const pair = pairForRange(map, classified.pmFrom, classified.pmTo)
  assert.ok(pair, 'fixture must resolve an editable pair')
  const kernel = { doc: createMarkdownDocument(md) }
  const routed = routeLinkEdit({ kernel, pair, ...classified })
  if (!routed.ok) return { ok: false, code: routed.code }
  const applied = applySourceTransaction(kernel.doc, routed.transaction)
  assert.equal(applied.ok, true, applied.code)
  return { ok: true, text: applied.doc.text, intent: routed.transaction.intent }
}

// Case L1: WRAP — `addLink` on a non-empty selection is one AddMarkStep.
{
  const md = 'hello world\n'
  const d = doc(p(text('hello world')))
  const state = withSelection(EditorState.create({ schema, doc: d }), 1, 6)
  const tr = tooltipWrap(state, 1, 6, 'https://x.example')
  assert.deepEqual(tr.steps.map((s) => s.constructor.name), ['AddMarkStep'])
  const classified = classifyTransactions([tr], state)
  assert.deepEqual(classified, { kind: 'link-edit', op: 'wrap', pmFrom: 1, pmTo: 6, href: 'https://x.example' })
  const committed = commitLink(md, d, classified)
  assert.equal(committed.text, '[hello](https://x.example) world\n')
  assert.equal(committed.intent, 'link-wrap')
}

// Case L2: EDIT — `editLink` removes the old mark and adds the new one in ONE
// transaction. This is precisely the mixed Add+Remove shape `extractMarkToggle`
// refuses; the link classifier owns it instead (Case M7 below still refuses
// the highlight version — that regression guard is asserted in Case L6).
{
  const md = '[hello](https://old.example) world\n'
  const d = doc(p(schema.text('hello', [linkMark('https://old.example')]), text(' world')))
  const state = withSelection(EditorState.create({ schema, doc: d }), 1, 6)
  const tr = tooltipEdit(state, 1, 6, 'https://old.example', 'https://new.example')
  assert.deepEqual(tr.steps.map((s) => s.constructor.name), ['RemoveMarkStep', 'AddMarkStep'])
  const classified = classifyTransactions([tr], state)
  assert.deepEqual(classified, { kind: 'link-edit', op: 'edit', pmFrom: 1, pmTo: 6, href: 'https://new.example' })
  const committed = commitLink(md, d, classified)
  assert.equal(committed.text, '[hello](https://new.example) world\n')
  assert.equal(committed.intent, 'link-edit')
}

// Case L3: UNWRAP — `removeLink` is a lone RemoveMarkStep, and carries no
// href (there is nothing to write).
{
  const md = '[hello](https://x.example) world\n'
  const d = doc(p(schema.text('hello', [linkMark('https://x.example')]), text(' world')))
  const state = withSelection(EditorState.create({ schema, doc: d }), 1, 6)
  const tr = tooltipRemove(state, 1, 6)
  assert.deepEqual(tr.steps.map((s) => s.constructor.name), ['RemoveMarkStep'])
  const classified = classifyTransactions([tr], state)
  assert.deepEqual(classified, { kind: 'link-edit', op: 'unwrap', pmFrom: 1, pmTo: 6 })
  const committed = commitLink(md, d, classified)
  assert.equal(committed.text, 'hello world\n')
  assert.equal(committed.intent, 'link-unwrap')
}

// Case L4: INSERT — an EMPTY selection makes the tooltip type the href into
// the document and mark it. The AddMarkStep's range is expressed AFTER the
// ReplaceStep, so the classification collapses back to the zero-width insert
// point in pre-batch coordinates.
{
  const md = 'ab\n'
  const d = doc(p(text('ab')))
  const state = withSelection(EditorState.create({ schema, doc: d }), 2, 2)
  const tr = tooltipInsert(state, 2, 'https://q.example')
  assert.deepEqual(tr.steps.map((s) => s.constructor.name), ['ReplaceStep', 'AddMarkStep'])
  const classified = classifyTransactions([tr], state)
  assert.deepEqual(classified, {
    kind: 'link-edit', op: 'insert', pmFrom: 2, pmTo: 2,
    href: 'https://q.example', insertedText: 'https://q.example'
  })
  const committed = commitLink(md, d, classified)
  assert.equal(committed.text, 'a[https://q.example](https://q.example)b\n')
  assert.equal(committed.intent, 'link-insert')
}

// Case L5: contiguous multi-step coalescing (the split-text-node shape) folds
// into ONE range, exactly like `extractMarkToggle` does for ordinary marks.
{
  const d = doc(p(text('ab'), schema.text('cd', [schema.mark('emphasis')]), text('ef')))
  const state = EditorState.create({ schema, doc: d })
  const tr = state.tr
  tr.step(new AddMarkStep(1, 3, linkMark('u')))
  tr.step(new AddMarkStep(3, 5, linkMark('u')))
  assert.deepEqual(classifyTransactions([tr], state), {
    kind: 'link-edit', op: 'wrap', pmFrom: 1, pmTo: 5, href: 'u'
  })
}

// Case L6: REGRESSION GUARD — the mixed Remove+Add rule `extractMarkToggle`
// enforces is NOT loosened by the link classifier. `applyHighlightInView`'s
// color-replace shape (removeMark then addMark of the HIGHLIGHT mark) still
// falls through to `blocked`, and so does any mixed batch of two different
// mark types.
{
  const d = doc(p(text('ab'), schema.text('cd', [schema.mark('highlight', { color: 'yellow' })])))
  const state = EditorState.create({ schema, doc: d })
  const tr = state.tr
  tr.removeMark(1, 5, schema.marks.highlight)
  tr.addMark(1, 5, schema.mark('highlight', { color: 'yellow' }))
  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'blocked')
  assert.equal(classified.blockedCode, KERNEL_CODES.INPUT_TYPE)

  const mixed = state.tr
  mixed.removeMark(1, 5, schema.marks.highlight)
  mixed.addMark(1, 5, linkMark('u'))
  const mixedClass = classifyTransactions([mixed], state)
  assert.equal(mixedClass.kind, 'blocked', 'a remove of one mark + an add of link is not a link edit')
  assert.equal(mixedClass.blockedCode, KERNEL_CODES.INPUT_TYPE)
}

// Case L7: cross-block and non-contiguous shapes refuse.
{
  const d = doc(p(text('abc')), p(text('def')))
  const state = EditorState.create({ schema, doc: d })
  const cross = state.tr
  cross.step(new AddMarkStep(1, 4, linkMark('u')))
  cross.step(new AddMarkStep(6, 9, linkMark('u')))
  assert.equal(classifyTransactions([cross], state).kind, 'blocked', 'a cross-block jump never coalesces')

  const gap = EditorState.create({ schema, doc: doc(p(text('abcdef'))) })
  const tr = gap.tr
  tr.step(new AddMarkStep(1, 2, linkMark('u')))
  tr.step(new AddMarkStep(4, 5, linkMark('u')))
  assert.equal(classifyTransactions([tr], gap).kind, 'blocked')
}

// Case L8: shapes the tooltip never dispatches are refused rather than
// guessed at — steps out of order, an add whose range does not match the
// insert, a second ReplaceStep riding along, a non-link mark type.
{
  const d = doc(p(text('abcd')))
  const state = EditorState.create({ schema, doc: d })

  const addThenRemove = state.tr
  addThenRemove.step(new AddMarkStep(1, 3, linkMark('u')))
  addThenRemove.removeMark(1, 3, schema.marks.link)
  assert.equal(classifyTransactions([addThenRemove], state).kind, 'blocked', 'removes must precede adds')

  const badRange = state.tr
  badRange.insertText('uu', 2)
  badRange.step(new AddMarkStep(1, 3, linkMark('uu')))
  assert.equal(classifyTransactions([badRange], state).kind, 'blocked',
    "the marked range must be exactly the inserted text's")

  const twoInserts = state.tr
  twoInserts.insertText('u', 2)
  twoInserts.insertText('v', 4)
  twoInserts.step(new AddMarkStep(2, 3, linkMark('u')))
  assert.equal(classifyTransactions([twoInserts], state).kind, 'blocked')

  // A strong toggle is still a `mark-toggle`, never a link edit.
  const strong = captureToggle(withSelection(state, 1, 3), schema.marks.strong)
  assert.equal(classifyTransactions([strong], state).kind, 'mark-toggle')
}

// Case L9: `routeLinkEdit` fails closed on inputs it cannot resolve, and
// surfaces the COMMAND's own refusal code rather than a generic one.
{
  const md = 'see www.a.com ok\n'
  const d = doc(p(text('see '), schema.text('www.a.com', [linkMark('http://www.a.com')]), text(' ok')))
  const map = buildProjectionMap(md, d)
  assert.ok(map, 'a paragraph holding a GFM autolink literal still maps')
  const kernel = { doc: createMarkdownDocument(md) }
  const pair = pairForRange(map, 5, 14)

  // The autolink literal has no `[`…`](…)` bytes — every direction refuses.
  assert.deepEqual(
    routeLinkEdit({ kernel, pair, op: 'unwrap', pmFrom: 5, pmTo: 14 }),
    { ok: false, code: KERNEL_CODES.UNSUPPORTED }
  )
  assert.deepEqual(
    routeLinkEdit({ kernel, pair, op: 'edit', pmFrom: 5, pmTo: 14, href: 'u' }),
    { ok: false, code: KERNEL_CODES.UNSUPPORTED }
  )
  assert.deepEqual(
    routeLinkEdit({ kernel, pair, op: 'wrap', pmFrom: 5, pmTo: 14, href: 'u' }),
    { ok: false, code: KERNEL_CODES.UNSUPPORTED }
  )
  assert.deepEqual(
    routeLinkEdit({ kernel, pair: null, op: 'wrap', pmFrom: 1, pmTo: 4, href: 'u' }),
    { ok: false, code: KERNEL_CODES.UNMAPPED }
  )
  assert.deepEqual(
    routeLinkEdit({ kernel, pair, op: 'wrap', pmFrom: NaN, pmTo: 4, href: 'u' }),
    { ok: false, code: KERNEL_CODES.UNMAPPED }
  )
  assert.equal(kernel.doc.text, md, 'no refusal path mutated the document')
}

// Case L10: the autolink literal's PM shape reaches the classifier as a real
// `link` mark, so the REFUSAL has to happen in the kernel command (Case L9),
// not by the batch failing to classify. Pin that it does classify.
{
  const d = doc(p(text('see '), schema.text('www.a.com', [linkMark('http://www.a.com')]), text(' ok')))
  const state = withSelection(EditorState.create({ schema, doc: d }), 5, 14)
  const tr = tooltipRemove(state, 5, 14)
  assert.deepEqual(classifyTransactions([tr], state), {
    kind: 'link-edit', op: 'unwrap', pmFrom: 5, pmTo: 14
  })
}

// Case L11: two CONTIGUOUS AddMarkSteps that disagree on `href` refuse rather
// than silently coalescing to the second one's destination. The tooltip never
// emits this (one confirm produces ONE mark), so it is unreachable today —
// which is precisely why it must refuse: this classifier's contract is "prove
// the shape I probed, refuse everything else", not "pick a plausible value".
{
  const d = doc(p(text('ab'), schema.text('cd', [schema.mark('emphasis')]), text('ef')))
  const state = EditorState.create({ schema, doc: d })
  const tr = state.tr
  tr.step(new AddMarkStep(1, 3, linkMark('u')))
  tr.step(new AddMarkStep(3, 5, linkMark('DIFFERENT')))
  const classified = classifyTransactions([tr], state)
  assert.equal(classified.kind, 'blocked')
  assert.equal(classified.blockedCode, KERNEL_CODES.INPUT_TYPE)
}

// Case L12: `routeLinkEdit` re-checks `pair.virtual` itself rather than
// trusting the caller's `editablePairForRange` to have filtered placeholders
// out — a placeholder pair (trailing/split placeholder, empty list item) has
// no real source bytes. Same fail-open SHAPE the image route's ratio guard was
// corrected for.
{
  const md = 'hello world\n'
  const d = doc(p(text('hello world')))
  const map = buildProjectionMap(md, d)
  const real = pairForRange(map, 1, 6)
  assert.ok(real, 'sanity: the real pair resolves')
  const kernel = { doc: createMarkdownDocument(md) }
  assert.equal(routeLinkEdit({ kernel, pair: real, op: 'wrap', pmFrom: 1, pmTo: 6, href: 'u' }).ok, true)
  assert.deepEqual(
    routeLinkEdit({ kernel, pair: { ...real, virtual: true }, op: 'wrap', pmFrom: 1, pmTo: 6, href: 'u' }),
    { ok: false, code: KERNEL_CODES.UNMAPPED }
  )
  assert.equal(kernel.doc.text, md, 'routeLinkEdit never applies — it only routes')
}

console.log('PASS kernel gateway (link tooltip: wrap/edit/unwrap/insert classified, mixed-batch guard intact)')

// ===========================================================================
// P6 Task 1 — TYPING AROUND INLINE ATOMS
// ===========================================================================
// Before this task `textblockProfile` returned null the moment ANY inline
// child had `isText === false`, so a paragraph holding an inline image /
// inline formula / inline HTML fragment was entirely untypable — the single
// largest coverage hole blocking kernel mode from becoming the default.
//
// PROBE (2026-08-17, run against the real kernel parser + buildCharacterMap,
// not assumed). Every inline atom the kernel models is a width-1 `atom` unit
// whose raw span is EXACTLY the node's own mdast position, and at BOTH of its
// visible boundaries the charMap's three resolvers agree on one byte offset:
//
//   'a![x](y.png)b'  text[0,1) image[1,12) text[12,13)
//                    units char[0,1) atom[1,12) char[12,13)
//                    vis 1 -> 1/1/1   vis 2 -> 12/12/12   (raw/start/neutral)
//   'a$x^2$b'        inlineMath[1,6)   vis 1 -> 1/1/1  vis 2 -> 6/6/6
//   'a<span>q</span>b' the coalesced html run [1,15) is ONE atom
//                    vis 1 -> 1/1/1  vis 2 -> 15/15/15
//   'a[^1]b'         footnoteReference[1,5)  vis 1 -> 1/1/1  vis 2 -> 5/5/5
//
// So an insert at either atom EDGE is byte-exact, and this task allows it.
//
// P6 TASK 1b WIDENED THIS to whole-atom deletion ("select an image, press
// Backspace" — the most common thing a user does to an image, which used to
// toast a refusal). The probe above already contained the proof: the image's
// PM range [2,3) resolves through `pmPosToRawStart(2) = 1` and
// `pmPosToRaw(3) = 12`, i.e. EXACTLY the atom unit's own [1,12) bytes. So a
// range that CONTAINS one or more whole atoms (with or without surrounding
// text) commits; a range that only PARTIALLY overlaps an atom stays refused,
// as does a range swallowing a MARKED atom (a linked image's '[' / '](url)'
// delimiters are invisible to the marked-run guard, which walks text children
// only — deleting the atom alone would strand them). Both halves are proved:
// PM-side by `stepRespectsAtoms`, raw-side by `rangeSplitsAtomUnit` inside
// `commitPlainText`, before any byte is written.
//
// HARD BREAKS ARE THE EXCEPTION and stay refused. Probed:
//
//   'a  \n  b'    text[0,1) break[1,4) text[6,7)   <- units [1,4) then [6,7)
//   '> a  \n> b'  text[2,3) break[3,6) text[8,9)   <- units [3,6) then [8,9)
//
// A hard break's raw span STOPS at the line ending; the next line's
// continuation prefix (indentation, or a blockquote's '> ' marker) belongs to
// NO unit. That leaves a gap, and the insert boundary right after the break
// resolves to the PRE-gap offset — typing there would commit
// '> a  \nX> b', turning the quote marker into paragraph text. (A SOFT break
// has no such hole: `consumeSoftBreak` folds the continuation prefix into the
// `linebreak` unit, which is why soft breaks were always typable.) A smaller
// correct relaxation beats a larger unproven one, so `break`/`hardbreak` is
// left out of the allowlist and recorded in the blocking matrix.

const atomFixture = (md, d) => {
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, `fixture must map: ${JSON.stringify(md)}`)
  return { md, state, map }
}
const atomBytes = ({ md, state, map }, tr) => {
  const classified = classifyTransactions([tr], state)
  if (classified.kind !== 'plain-text') return { kind: classified.kind, code: classified.blockedCode }
  const { committed } = commitOf(md, map, state, tr)
  return committed.ok ? { kind: 'plain-text', text: committed.applied.doc.text } : { kind: 'refused', code: committed.code }
}

// A1: an inline image no longer blocks its paragraph — every boundary types,
// and the bytes land on the correct side of the `![alt](src)` syntax.
{
  const f = atomFixture('a![x](y.png)b\n', doc(p(text('a'), img('y.png'), text('b'))))
  assert.deepEqual(atomBytes(f, f.state.tr.insertText('X', 1)), { kind: 'plain-text', text: 'Xa![x](y.png)b\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.insertText('X', 2)), { kind: 'plain-text', text: 'aX![x](y.png)b\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.insertText('X', 3)), { kind: 'plain-text', text: 'a![x](y.png)Xb\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.insertText('X', 4)), { kind: 'plain-text', text: 'a![x](y.png)bX\n' })
}

// A2: the atom is ONE PM position wide, so "an insert strictly inside an
// atom" is not a representable step — pinned rather than left implicit,
// because the intersect guard's zero-width branch is written for it anyway
// (a future inline node with content would make it reachable).
{
  const f = atomFixture('a![x](y.png)b\n', doc(p(text('a'), img('y.png'), text('b'))))
  const atom = f.state.doc.nodeAt(2)
  assert.equal(atom.type.name, 'image')
  assert.equal(atom.nodeSize, 1, 'an inline image occupies exactly one PM position')
}

// A3 (rewritten by P6-1b): a step that swallows the atom WHOLE now commits,
// and the bytes removed are exactly the atom's own — alone, together with the
// text on either side, or together with the entire paragraph content. Typing
// OVER a selected atom is the same proof (the raw range is replaced, not just
// removed).
{
  const f = atomFixture('a![x](y.png)b\n', doc(p(text('a'), img('y.png'), text('b'))))
  assert.deepEqual(atomBytes(f, f.state.tr.delete(2, 3)), { kind: 'plain-text', text: 'ab\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.delete(1, 3)), { kind: 'plain-text', text: 'b\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.delete(2, 4)), { kind: 'plain-text', text: 'a\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.delete(1, 4)), { kind: 'plain-text', text: '\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.replaceWith(2, 3, text('Z'))),
    { kind: 'plain-text', text: 'aZb\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.replaceWith(1, 4, text('Z'))),
    { kind: 'plain-text', text: 'Z\n' })
}

// A3b: the atom at the paragraph's START and at its END — the two boundary
// shapes where the resolved range touches the block's own first/last byte.
{
  const head = atomFixture('![x](y.png)tail\n', doc(p(img('y.png'), text('tail'))))
  assert.deepEqual(atomBytes(head, head.state.tr.delete(1, 2)), { kind: 'plain-text', text: 'tail\n' })
  const tail = atomFixture('head![x](y.png)\n', doc(p(text('head'), img('y.png'))))
  assert.deepEqual(atomBytes(tail, tail.state.tr.delete(5, 6)), { kind: 'plain-text', text: 'head\n' })
}

// A3c: a PARTIAL overlap of an atom must still be refused — the rule the
// widening rests on. No LIVE inline atom can express such a step (every one is
// a nodeSize-1 leaf, pinned by A2: any range meeting it must contain it), so
// the two guards are exercised directly against a synthetic wider node. That
// is the only way to state the contract for the inline-node-with-content a
// future schema could introduce, instead of leaving it as an unwritten
// consequence of today's node sizes.
{
  const { stepRespectsAtoms, rangeSplitsAtomUnit } = __atomGuards
  // children: text[1,2) atom[2,5) text[5,6) — a three-position inline node.
  const wide = (marks = []) => ({
    forEach: (fn) => {
      fn({ isText: true, nodeSize: 1 })
      fn({ isText: false, nodeSize: 3, marks })
      fn({ isText: true, nodeSize: 1 })
    }
  })
  const respects = (from, to, marks) => stepRespectsAtoms(wide(marks), 1, from, to)
  assert.equal(respects(2, 5), true, 'the whole node is admissible')
  assert.equal(respects(1, 6), true, 'the whole node plus surrounding text is admissible')
  assert.equal(respects(3, 5), false, 'a range starting inside it is refused')
  assert.equal(respects(2, 4), false, 'a range ending inside it is refused')
  assert.equal(respects(3, 4), false, 'a range strictly inside it is refused')
  assert.equal(respects(3, 3), false, 'a caret strictly inside it is refused')
  assert.equal(respects(2, 2), true, 'a caret on its left edge is admissible')
  assert.equal(respects(5, 5), true, 'a caret on its right edge is admissible')
  assert.equal(respects(1, 6, [{}]), false, 'a MARKED node swallowed whole is refused')

  // The raw half, on the same shape: an `atom` unit spanning bytes [4,9).
  const units = { units: [{ kind: 'char', rawStart: 3, rawEnd: 4, width: 1 }, { kind: 'atom', rawStart: 4, rawEnd: 9, width: 1 }, { kind: 'char', rawStart: 9, rawEnd: 10, width: 1 }] }
  assert.equal(rangeSplitsAtomUnit(units, 4, 9), false, 'exactly the atom bytes')
  assert.equal(rangeSplitsAtomUnit(units, 3, 10), false, 'the atom bytes plus its neighbours')
  assert.equal(rangeSplitsAtomUnit(units, 3, 4), false, 'disjoint on the left')
  assert.equal(rangeSplitsAtomUnit(units, 9, 10), false, 'disjoint on the right')
  assert.equal(rangeSplitsAtomUnit(units, 5, 9), true, 'a range starting inside the atom bytes')
  assert.equal(rangeSplitsAtomUnit(units, 4, 8), true, 'a range ending inside the atom bytes')
  assert.equal(rangeSplitsAtomUnit(units, 3, 6), true, 'a range half-covering the atom bytes')
  assert.equal(rangeSplitsAtomUnit(units, 6, 6), true, 'a caret strictly inside the atom bytes')
  assert.equal(rangeSplitsAtomUnit(units, 4, 4), false, 'a caret on the atom bytes left edge')
  assert.equal(rangeSplitsAtomUnit(units, 9, 9), false, 'a caret on the atom bytes right edge')
  assert.equal(rangeSplitsAtomUnit(null, 4, 9), false, 'a map without units answers false')
  assert.equal(rangeSplitsAtomUnit({ units: null }, 4, 9), false, 'a virtual/hand-built map answers false')
}

// A4: deletions that do NOT touch the atom commit normally, on both sides.
{
  const f = atomFixture('ab![x](y.png)cd\n', doc(p(text('ab'), img('y.png'), text('cd'))))
  assert.deepEqual(atomBytes(f, f.state.tr.delete(1, 2)), { kind: 'plain-text', text: 'b![x](y.png)cd\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.delete(2, 3)), { kind: 'plain-text', text: 'a![x](y.png)cd\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.delete(4, 5)), { kind: 'plain-text', text: 'ab![x](y.png)d\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.delete(5, 6)), { kind: 'plain-text', text: 'ab![x](y.png)c\n' })
  // and the atom deleted together with one character of text on each side
  assert.deepEqual(atomBytes(f, f.state.tr.delete(2, 5)), { kind: 'plain-text', text: 'ad\n' })
}

// A5: BETWEEN two adjacent atoms — the boundary shared by two atom units.
{
  const f = atomFixture('![a](1.png)![b](2.png)\n', doc(p(img('1.png'), img('2.png'))))
  assert.deepEqual(atomBytes(f, f.state.tr.insertText('X', 1)), { kind: 'plain-text', text: 'X![a](1.png)![b](2.png)\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.insertText('X', 2)), { kind: 'plain-text', text: '![a](1.png)X![b](2.png)\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.insertText('X', 3)), { kind: 'plain-text', text: '![a](1.png)![b](2.png)X\n' })
  // each atom deleted on its own, and BOTH deleted by one range (the P6-1b
  // "two adjacent atoms" case: the resolved range must be exactly the union of
  // the two atom units' bytes, with nothing between them left behind).
  assert.deepEqual(atomBytes(f, f.state.tr.delete(1, 2)), { kind: 'plain-text', text: '![b](2.png)\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.delete(2, 3)), { kind: 'plain-text', text: '![a](1.png)\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.delete(1, 3)), { kind: 'plain-text', text: '\n' })
}

// A6: inline math and inline HTML take the identical route.
{
  const m = atomFixture('a$x^2$b\n', doc(p(text('a'), mathInline('x^2'), text('b'))))
  assert.deepEqual(atomBytes(m, m.state.tr.insertText('X', 2)), { kind: 'plain-text', text: 'aX$x^2$b\n' })
  assert.deepEqual(atomBytes(m, m.state.tr.insertText('X', 3)), { kind: 'plain-text', text: 'a$x^2$Xb\n' })
  assert.deepEqual(atomBytes(m, m.state.tr.delete(2, 3)), { kind: 'plain-text', text: 'ab\n' })

  const h = atomFixture('a<span>q</span>b\n', doc(p(text('a'), inlineHtml('<span>q</span>'), text('b'))))
  assert.deepEqual(atomBytes(h, h.state.tr.insertText('X', 2)), { kind: 'plain-text', text: 'aX<span>q</span>b\n' })
  assert.deepEqual(atomBytes(h, h.state.tr.insertText('X', 3)), { kind: 'plain-text', text: 'a<span>q</span>Xb\n' })
  // the whole coalesced fragment is ONE atom unit, so deleting the single PM
  // position removes all of '<span>q</span>' — never half a tag.
  assert.deepEqual(atomBytes(h, h.state.tr.delete(2, 3)), { kind: 'plain-text', text: 'ab\n' })
}

// A7: the atom guard STACKS with the P4-3.5 marked-run guard rather than
// replacing it. '**bo**![x](y.png)c': raw *=0 *=1 b=2 o=3 *=4 *=5 image[6,17)
// c=17. PM: strong text 'bo' (1..3), image (3..4), 'c' (4..5).
{
  const f = atomFixture('**bo**![x](y.png)c\n',
    doc(p(schema.text('bo', [schema.mark('strong')]), img('y.png'), text('c'))))
  // plain insert at the strong run's trailing edge == the atom's left edge:
  // the neutral resolver puts it AFTER '**' and BEFORE '!'.
  assert.deepEqual(atomBytes(f, f.state.tr.replaceWith(3, 3, text('X'))),
    { kind: 'plain-text', text: '**bo**X![x](y.png)c\n' })
  // before the opening '**'
  assert.deepEqual(atomBytes(f, f.state.tr.replaceWith(1, 1, text('X'))),
    { kind: 'plain-text', text: 'X**bo**![x](y.png)c\n' })
  // right after the atom
  assert.deepEqual(atomBytes(f, f.state.tr.insertText('X', 4)),
    { kind: 'plain-text', text: '**bo**![x](y.png)Xc\n' })
  // a delete INSIDE the marked run still commits (marked-run guard: insideRun)
  assert.deepEqual(atomBytes(f, f.state.tr.delete(2, 3)),
    { kind: 'plain-text', text: '**b**![x](y.png)c\n' })
  // deleting the run's EXACT content leaves the empty delimiters — the pinned
  // P4-2 byte-consistent outcome, unchanged by this task.
  assert.deepEqual(atomBytes(f, f.state.tr.delete(1, 3)),
    { kind: 'plain-text', text: '****![x](y.png)c\n' })
  // a range straddling the run's edge AND the atom is refused by both guards.
  assert.equal(classifyTransactions([f.state.tr.delete(2, 4)], f.state).kind, 'blocked')
}

// A8: CRLF document — the atom's raw span sits inside one line, so neither
// resolved offset can bisect a '\r\n' pair; the surrounding CRLF bytes are
// untouched.
{
  const md = 'a![x](y.png)b\r\n\r\nnext\r\n'
  const f = atomFixture(md, doc(p(text('a'), img('y.png'), text('b')), p(text('next'))))
  assert.deepEqual(atomBytes(f, f.state.tr.insertText('X', 2)),
    { kind: 'plain-text', text: 'aX![x](y.png)b\r\n\r\nnext\r\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.insertText('X', 3)),
    { kind: 'plain-text', text: 'a![x](y.png)Xb\r\n\r\nnext\r\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.insertText('X', 6)),
    { kind: 'plain-text', text: 'a![x](y.png)b\r\n\r\nXnext\r\n' })
  // ...and the same is true of the P6-1b deletions: the atom's bytes are all
  // that leave, every '\r\n' in the document survives byte-identical.
  assert.deepEqual(atomBytes(f, f.state.tr.delete(2, 3)),
    { kind: 'plain-text', text: 'ab\r\n\r\nnext\r\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.delete(1, 4)),
    { kind: 'plain-text', text: '\r\n\r\nnext\r\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.replaceWith(2, 3, text('Z'))),
    { kind: 'plain-text', text: 'aZb\r\n\r\nnext\r\n' })
}

// A8b: CRLF with TWO adjacent atoms, and with the atom at the block's start —
// the shapes where a resolved endpoint sits closest to a line ending.
{
  const md = '![a](1.png)![b](2.png)\r\n\r\nnext\r\n'
  const f = atomFixture(md, doc(p(img('1.png'), img('2.png')), p(text('next'))))
  assert.deepEqual(atomBytes(f, f.state.tr.delete(1, 2)),
    { kind: 'plain-text', text: '![b](2.png)\r\n\r\nnext\r\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.delete(2, 3)),
    { kind: 'plain-text', text: '![a](1.png)\r\n\r\nnext\r\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.delete(1, 3)),
    { kind: 'plain-text', text: '\r\n\r\nnext\r\n' })
}

// A9: hard breaks stay refused, under BOTH the legacy fixture spelling and
// the live `hardbreak` node name — see the probe in this section's header for
// the continuation-prefix gap that makes them unprovable today. The refusal
// is block-wide, so a paragraph mixing an image with a hard break is refused
// too (fail-closed: one unprovable atom refuses the block, it is never
// silently narrowed to "the safe half of the paragraph").
{
  for (const nodeName of ['hard_break', 'hardbreak']) {
    const d = doc(p(text('a'), schema.nodes[nodeName].create(), text('b')))
    const state = EditorState.create({ schema, doc: d })
    for (const pos of [1, 2, 3, 4]) {
      assert.equal(classifyTransactions([state.tr.insertText('X', pos)], state).kind, 'blocked',
        `${nodeName}: typing at PM ${pos} must stay refused`)
    }
  }
  const mixed = doc(p(text('a'), img('y.png'), schema.nodes.hardbreak.create(), text('b')))
  const mixedState = EditorState.create({ schema, doc: mixed })
  assert.equal(classifyTransactions([mixedState.tr.insertText('X', 2)], mixedState).kind, 'blocked',
    'an image + hard break paragraph is refused as a whole')
}

// A10: fail-closed chain — classification admitting the shape is NOT the
// proof. When the block itself is DEGRADED (PM and the kernel disagree on the
// inline count, so buildProjectionMap serves `charMap: null`), the batch still
// classifies as plain-text and `commitPlainText` refuses with UNMAPPED, with
// the source bytes untouched.
{
  const md = 'a![x](y.png)b\n'
  const d = doc(p(text('a'), img('y.png'), img('z.png'), text('b')))
  const state = EditorState.create({ schema, doc: d })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'the map still builds — the degradation is per-block')
  assert.equal(map.blockPairs[0].charMap, null, 'the mismatched paragraph degrades to read-only')
  const tr = state.tr.insertText('X', 2)
  assert.equal(classifyTransactions([tr], state).kind, 'plain-text')
  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
  assert.equal(committed.ok, false)
  assert.equal(committed.code, KERNEL_CODES.UNMAPPED)
  assert.equal(kernel.doc.text, md, 'no bytes were written')
}

// A11: a LINKED image — the atom itself carries a mark, so the atom guard and
// the marker-gap resolver have to cooperate. '[![x](y.png)](url)' wrapped in
// 'a…b': the image atom is [2,13) and the link's own '](url)' gap follows it,
// so a plain insert at the atom's RIGHT edge must chase past the closing
// delimiter (raw 19), not land inside it.
{
  const md = 'a[![x](y.png)](url)b\n'
  const linked = schema.node('image', { src: 'y.png' }, null, [schema.mark('link', { href: 'url' })])
  const f = atomFixture(md, doc(p(text('a'), linked, text('b'))))
  assert.deepEqual(atomBytes(f, f.state.tr.insertText('X', 1)),
    { kind: 'plain-text', text: 'Xa[![x](y.png)](url)b\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.insertText('X', 2)),
    { kind: 'plain-text', text: 'aX[![x](y.png)](url)b\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.replaceWith(3, 3, text('X'))),
    { kind: 'plain-text', text: 'a[![x](y.png)](url)Xb\n' })
  assert.deepEqual(atomBytes(f, f.state.tr.insertText('X', 4)),
    { kind: 'plain-text', text: 'a[![x](y.png)](url)bX\n' })
  // Real typing at PM 3 INHERITS the link mark from the atom, so the
  // pre-existing plain-slice guard refuses it — unchanged by this task.
  assert.equal(classifyTransactions([f.state.tr.insertText('X', 3)], f.state).kind, 'blocked')
  // Deleting the atom stays REFUSED even after P6-1b, and this is the reason
  // the whole-atom rule carries its unmarked condition: the link's own '[' and
  // '](url)' bytes belong to no unit, so the resolved range would be the
  // image's [2,13) alone and the source would keep 'a[](url)b' — orphaned
  // delimiters, the P4-2 corruption shape. `stepRespectsMarkedRuns` cannot
  // catch it (it walks TEXT children only), so `stepRespectsAtoms` does.
  assert.equal(classifyTransactions([f.state.tr.delete(2, 3)], f.state).kind, 'blocked')
  assert.equal(classifyTransactions([f.state.tr.delete(1, 4)], f.state).kind, 'blocked')
  assert.equal(classifyTransactions([f.state.tr.replaceWith(2, 3, text('Z'))], f.state).kind, 'blocked')
}

console.log('PASS kernel gateway (P6-1: typing around inline atoms; P6-1b: whole-atom deletion; hard breaks still refused)')

// --- H: syncHeadingIdPlugin's heading-`id` refresh (2026-08-17 veto-divergence)
//
// `@milkdown/preset-commonmark`'s `syncHeadingIdPlugin` re-slugs every stale
// `heading.attrs.id` on EVERY document change and dispatches the result as
// `tr.setMeta(MILKDOWN_HEADING_ID, true).setNodeMarkup(pos, undefined, attrs)`
// — a `ReplaceAroundStep` batch that `extractPlainTextSteps` (rightly) refuses
// and that therefore used to land in `blocked`/`INPUT_TYPE`: the veto channel
// discarded it, the plugin retried on the next change, and EVERY kernel-mode
// document holding one non-empty heading raised the "not supported yet" toast
// once per keystroke. `heading.attrs.id` has no Markdown representation, so a
// batch that changes only it cannot touch an authored byte — hence the
// view-only pass-through. These cases pin the two gates that keep it from
// becoming "any setNodeMarkup batch is fine".
{
  const headingKey = new PluginKey('MILKDOWN_HEADING_ID')
  const h = (attrs, s) => schema.node('heading', attrs, s ? text(s) : [])
  const base = doc(
    h({ id: '', level: 1 }, 'Title'),
    p(text('body')),
    h({ id: '', level: 2 }, 'Second')
  )
  const state = EditorState.create({ schema, doc: base })
  // Positions: heading#1 at 0, paragraph at 7, heading#2 at 13.
  assert.equal(state.doc.child(0).type.name, 'heading')
  assert.equal(state.doc.nodeAt(0)?.type.name, 'heading')

  const idTr = () => {
    const tr = state.tr.setMeta(headingKey, true)
    tr.setNodeMarkup(0, undefined, { ...state.doc.nodeAt(0).attrs, id: 'title' })
    const second = state.doc.child(0).nodeSize + state.doc.child(1).nodeSize
    tr.setNodeMarkup(second, undefined, { ...state.doc.nodeAt(second).attrs, id: 'second' })
    return tr
  }

  // H1: the real plugin shape — both gates hold, so it is view-only.
  const classified = classifyTransactions([idTr()], state)
  assert.equal(classified.kind, 'heading-id', 'the plugin batch is classified view-only')
  assert.equal(classified.headings, 2, 'both stale headings ride the same batch')

  // H2: the identical STRUCTURE without the plugin's meta stays refused — the
  // classification is provenance-gated, not a free pass for setNodeMarkup.
  const noMeta = state.tr
  noMeta.setNodeMarkup(0, undefined, { ...state.doc.nodeAt(0).attrs, id: 'title' })
  assert.equal(classifyTransactions([noMeta], state).kind, 'blocked')
  assert.equal(classifyTransactions([noMeta], state).blockedCode, KERNEL_CODES.INPUT_TYPE)

  // H3: the meta with a step that also changes `level` — a real content change
  // (`#` vs `##` IS authored bytes) — must be refused, not smuggled through.
  const levelToo = state.tr.setMeta(headingKey, true)
  levelToo.setNodeMarkup(0, undefined, { ...state.doc.nodeAt(0).attrs, id: 'title', level: 3 })
  assert.equal(classifyTransactions([levelToo], state).kind, 'blocked')

  // H4: the meta on a batch that ALSO edits text is refused whole. This is the
  // narrowness requirement stated as a test: a mixed batch is never view-only.
  const mixed = state.tr.setMeta(headingKey, true)
  mixed.setNodeMarkup(0, undefined, { ...state.doc.nodeAt(0).attrs, id: 'title' })
  mixed.insertText('X', mixed.doc.child(0).nodeSize + 1)
  assert.equal(classifyTransactions([mixed], state).kind, 'blocked')

  // H5: the meta on a NON-heading attrs rewrite (a code_block language flip
  // wearing the heading plugin's meta) is refused — the structural half of the
  // gate resolves the real node and checks its type.
  const cbState = EditorState.create({ schema, doc: doc(cb('js', 'x'), p(text('a'))) })
  const wrongType = cbState.tr.setMeta(headingKey, true)
  wrongType.setNodeMarkup(0, undefined, { ...cbState.doc.nodeAt(0).attrs, language: 'ts' })
  assert.equal(classifyTransactions([wrongType], cbState).kind, 'blocked')

  // H6: a SECOND doc-changing transaction riding the same batch is refused,
  // even when both carry the meta — `extractHeadingIdSync` demands exactly one.
  const second = state.tr.setMeta(headingKey, true)
  second.insertText('Y', 8)
  assert.equal(classifyTransactions([idTr(), second], state).kind, 'blocked')
}

console.log('PASS kernel gateway (heading-id sync: classified view-only; meta/structure/mixed-batch gates hold)')

// --- L: syncListOrderPlugin's relabel shape stays REFUSED (deliberate).
//
// `syncListOrderPlugin` is an `appendTransaction`, so its `setNodeMarkup`
// relabel steps would fold into the SAME batch as the user's keystroke and
// take the whole batch (the user's own edit included) down with it. That trap
// was investigated on the built app on 2026-08-17 and could NOT be reached in
// kernel mode: across typing / Enter / Backspace / Tab / nested items on
// ordered lists numbered `1.1.1.`, `1.2.3.` and `3.4.`, the plugin never
// dispatched once — the labels always come from the kernel's own reparse of
// the authored bytes (remark computes the true ordinal), so the plugin's
// `expectedLabel` already matches, and every kernel-driven projection
// transaction sets `addToHistory: false`, which the plugin's own guard skips.
// No pass-through is therefore granted for this shape: an unreachable risk is
// not worth a second hole in the blocking matrix. THIS CASE IS THE PIN — if a
// future change makes the plugin reachable, it fails closed (a refused batch,
// never a silent byte), and this assertion is where the decision is recorded.
{
  const listSchema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block' },
      ordered_list: { content: 'list_item+', group: 'block', attrs: { order: { default: 1 } } },
      list_item: { content: 'paragraph+', attrs: { label: { default: '1.' }, listType: { default: 'ordered' } } },
      text: { group: 'inline' }
    }
  })
  const lp = (s) => listSchema.node('paragraph', null, [listSchema.text(s)])
  const li = (label, s) => listSchema.node('list_item', { label, listType: 'ordered' }, [lp(s)])
  const listDoc = listSchema.node('doc', null, [
    listSchema.node('ordered_list', { order: 1 }, [li('1.', 'one'), li('1.', 'two')])
  ])
  const listState = EditorState.create({ schema: listSchema, doc: listDoc })
  // The plugin's own shape: relabel item #2 from '1.' to '2.'.
  const relabel = listState.tr
  const secondItemPos = 1 + listState.doc.child(0).child(0).nodeSize
  relabel.setNodeMarkup(secondItemPos, undefined, { label: '2.', listType: 'ordered' })
  assert.equal(classifyTransactions([relabel], listState).kind, 'blocked')
  assert.equal(classifyTransactions([relabel], listState).blockedCode, KERNEL_CODES.INPUT_TYPE)
  // And folded onto a user keystroke (the appendTransaction shape) it is still
  // refused as a whole — fail-closed, exactly as before this task.
  const folded = listState.tr.insertText('X', 4)
  folded.setNodeMarkup(folded.mapping.map(secondItemPos), undefined, { label: '2.', listType: 'ordered' })
  assert.equal(classifyTransactions([folded], listState).kind, 'blocked')
}

console.log('PASS kernel gateway (syncListOrderPlugin relabel stays refused — unreachable in kernel mode, pinned fail-closed)')

// --- T: block-TRAILING whitespace (2026-08-18) --------------------------------
//
// The bug this section pins, measured on the built app BEFORE the fix: typing
// `a`, ` `, `b` at the end of a paragraph committed source `末段。ab ` while the
// view showed `末段。ab`. The space is stripped by CommonMark at a block's end,
// so the byte was dead on arrival, the projection repair pulled the view back to
// the character-less bytes, and the NEXT character mapped IN FRONT of the
// stranded byte. Both the file and the screen disagreed with what was typed.
//
// These cases drive the REAL gateway (classify -> commitPlainText) against a
// real projection map, and every expectation is stated as committed BYTES plus
// what those bytes reparse to — 存下来并且能被看到.
{
  const decoded = (markdown, index = 0) => {
    const out = []
    const walk = (n) => {
      if (typeof n?.value === 'string') out.push(n.value)
      for (const child of n?.children || []) walk(child)
    }
    walk(parseKernelMarkdown(markdown).children[index])
    return out.join('')
  }
  // Type ONE character at PM position `at` and return the committed bytes.
  const type = (markdown, pmDoc, at, ch) => {
    const state = EditorState.create({ schema, doc: pmDoc })
    const map = buildProjectionMap(markdown, state.doc)
    assert.ok(map, 'the fixture must map')
    const tr = state.tr.insertText(ch, at)
    assert.equal(classifyTransactions([tr], state).kind, 'plain-text')
    const kernel = { doc: createMarkdownDocument(markdown) }
    const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
    return committed.ok
      ? { bytes: committed.applied.doc.text, edits: committed.transaction.edits }
      : { refused: committed.code }
  }

  // T1: THE REPORTED SEQUENCE. `a b` must end up as `a b`, not `ab `.
  {
    const first = type('末段。a\n', doc(p(text('末段。a'))), 5, ' ')
    assert.equal(first.bytes, '末段。a&#32;\n', 'the space must be spelled portably')
    assert.equal(decoded(first.bytes), '末段。a ', 'and it must be OBSERVABLE in the reparse')
    const second = type(first.bytes, doc(p(text('末段。a '))), 6, 'b')
    assert.equal(second.bytes, '末段。a b\n', 'the entity must heal back to a literal space')
    assert.equal(decoded(second.bytes), '末段。a b')
    assert.deepEqual(second.edits, [{ from: 4, to: 9, insert: ' b' }],
      'the heal and the new character must be ONE edit')
  }

  // T2: a heading's end is the same shape.
  {
    const first = type('## 乙\n', doc(schema.node('heading', { level: 2 }, [text('乙')])), 2, ' ')
    assert.equal(first.bytes, '## 乙&#32;\n')
    assert.equal(decoded(first.bytes), '乙 ')
  }

  // T3: MUST NOT TOUCH — a fenced code block's trailing spaces are content.
  //     The pair's charMap is a codeMap and the mdast block is `code`, which
  //     the command's allowlist excludes, so the literal byte is committed
  //     byte-for-byte exactly as before.
  {
    const md = '```js\nlet a = 1\n```\n'
    const result = type(md, doc(cb('js', 'let a = 1')), 10, ' ')
    assert.equal(result.bytes, '```js\nlet a = 1 \n```\n',
      'a trailing space inside a fence must stay a literal byte')
    assert.equal(parseKernelMarkdown(result.bytes).children[0].value, 'let a = 1 ',
      'and it must still be part of the code block\'s value')
  }

  // T4: MUST NOT TOUCH — the two-space hard break. A paragraph carrying a
  //     hardbreak is refused WHOLESALE by this gateway (the atom allowlist
  //     deliberately excludes `hardbreak` — see TYPABLE_INLINE_ATOMS), so the
  //     trailing-whitespace path can never reach it. Pinned here so a future
  //     relaxation of that allowlist has to come past this assertion, and the
  //     byte-level guard is pinned separately in
  //     scripts/test-source-kernel-trailing-whitespace.mjs (§7b).
  {
    const md = 'a  \nb\n'
    const pmDoc = doc(p(text('a'), schema.node('hardbreak'), text('b')))
    const state = EditorState.create({ schema, doc: pmDoc })
    const tr = state.tr.insertText(' ', 2)
    assert.equal(classifyTransactions([tr], state).kind, 'blocked',
      'a hardbreak-bearing paragraph is refused before any spelling decision')
    const trEnd = state.tr.insertText(' ', 4)
    assert.equal(classifyTransactions([trEnd], state).kind, 'blocked')
    assert.equal(parseKernelMarkdown(md).children[0].children[1].type, 'break',
      'the fixture really is a hard break')
  }

  // T5: a GFM table cell. Cell padding is stripped exactly like a block tail,
  //     so `a b` inside a cell used to become `ab`; the table must stay a table.
  {
    const md = '| a | b |\n| - | - |\n| c | d |\n'
    const pmDoc = doc(tbl([['a', 'b'], ['c', 'd']]))
    const first = type(md, pmDoc, 5, ' ')
    assert.equal(first.bytes, '| a&#32; | b |\n| - | - |\n| c | d |\n')
    const table = parseKernelMarkdown(first.bytes).children[0]
    assert.equal(table.type, 'table')
    assert.equal(table.children[0].children.length, 2, 'the column count must not change')
  }

  // T6: an INTERIOR space is untouched — the plain path is already byte-exact,
  //     and no parse is spent (the prefilter's `rawFrom >= lastUnit.rawEnd`
  //     gate is what keeps ordinary typing off the proof path).
  {
    const result = type('ab\n', doc(p(text('ab'))), 2, ' ')
    assert.equal(result.bytes, 'a b\n')
    assert.deepEqual(result.edits, [{ from: 1, to: 1, insert: ' ' }])
  }

  // T7: the heading's LEADING whitespace command still wins at its own offset —
  //     `## ` (an empty heading with real marker spacing) is BOTH the ATX
  //     content start and a block tail, and the leading command's legacy-byte
  //     spelling (`&nbsp;`) is the one that must be committed.
  {
    const md = '## \n'
    const pmDoc = doc(schema.node('heading', { level: 2 }, []))
    const result = type(md, pmDoc, 1, ' ')
    assert.equal(result.bytes, '## &nbsp;\n',
      'the heading-leading command keeps precedence at the ATX content start')
  }
}

console.log('PASS kernel gateway (block-trailing whitespace: portable spelling + self-heal; code fences, hard breaks and interior typing untouched)')
