// Task-seed command tests: `/task`'s U+00A0 seed insert (block-insert.js's
// `task` target), the provenance ledger entry it records, and the
// first-content DISSOLVE (commands/task-seed.js).
//
// Byte-authoritative like every suite in this family: every expected string is
// the ACTUAL output of the command + applySourceTransaction, and every
// accepted result is REPARSED so the committed bytes are proven to mean a real
// task (`checked` boolean, label exact) — a byte assertion alone cannot tell a
// task item from a bullet showing literal "[ ]" text, which is precisely the
// distinction this feature exists for.
import assert from 'node:assert/strict'
import { createMarkdownDocument, applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { buildSyntaxIndex, parseKernelMarkdown } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { insertBlockFromQuery, BLOCK_INSERT_TARGETS } from '../src/renderer/src/lib/source-kernel/commands/block-insert.js'
import { dissolvableTaskSeed, spellTaskSeedInsert, taskSeedDeleteRefusal, EMPTY_TASK_CODE } from '../src/renderer/src/lib/source-kernel/commands/task-seed.js'
import { buildCharacterMap } from '../src/renderer/src/lib/source-kernel/character-map.js'
import { NO_BREAK_SPACE } from '../src/renderer/src/lib/source-kernel/commands/trailing-whitespace.js'
import { routeStructuralKey } from '../src/renderer/src/lib/source-kernel/router.js'

console.log('--- source kernel task seed ---')

const NBSP = ' '
assert.equal(NO_BREAK_SPACE, NBSP, 'the seed byte IS the family constant')
const SEED_BYTES = '- [ ] ' + NBSP

// The first task item of a parse, with its paragraph and char map — one
// resolver so every case reads the same facts the same way.
const taskAt = (text) => {
  const tree = parseKernelMarkdown(text)
  const find = (node) => {
    if (node.type === 'listItem') return node
    for (const child of node.children || []) {
      const hit = find(child)
      if (hit) return hit
    }
    return null
  }
  const item = find(tree)
  const paragraph = item?.children?.[0]
  return {
    item,
    paragraph,
    charMap: paragraph ? buildCharacterMap(text, paragraph) : null,
    label: paragraph ? (paragraph.children || []).map((n) => n.value ?? '').join('') : null
  }
}

const insertTask = (text, offset) => {
  const doc = createMarkdownDocument(text)
  const routed = insertBlockFromQuery({ doc, index: buildSyntaxIndex(text), offset, target: 'task' })
  assert.equal(routed.ok, true, `insert must succeed: ${routed.code}`)
  const applied = applySourceTransaction(doc, routed.transaction)
  assert.equal(applied.ok, true)
  return { routed, doc: applied.doc }
}

// ---------------------------------------------------------------------------
// 1. INSERT: `/task` becomes the seed spelling — a REAL `checked: false` item
//    (never the `checked: null` + literal "[ ]" every ASCII spelling yields),
//    the caret AFTER the seed, and the ledger vouching for the seed byte.
// ---------------------------------------------------------------------------
{
  const { routed, doc } = insertTask('/task\n', 5)
  assert.equal(doc.text, SEED_BYTES + '\n')
  assert.deepEqual(routed.transaction.edits, [{ from: 0, to: 5, insert: SEED_BYTES }],
    'one atomic edit: strip the query, write the seed spelling')
  assert.deepEqual(routed.transaction.selection, { anchor: 7, head: 7 },
    'the caret lands AFTER the seed (the ruled design)')
  assert.deepEqual(doc.whitespaceMarks, [{ from: 6, to: 7, ascii: '' }],
    'the seed is ledgered with ascii "" — the stands-for-NO-keystroke provenance')

  const task = taskAt(doc.text)
  assert.equal(task.item.checked, false, 'a REAL task, not checked:null')
  assert.equal(task.label, NBSP, 'whose only content is the seed')
  assert.ok(task.charMap, 'and the seed is character-mappable (the caret home)')
  assert.deepEqual(
    task.charMap.units.map((u) => [u.kind, u.rawStart, u.rawEnd, u.width]),
    [['char', 6, 7, 1]]
  )
}

// The CONTRAST that makes case 1 non-vacuous: the ASCII spelling really is
// not a task on this parser — pinned so the seed can never be "simplified"
// back to it.
{
  const ascii = parseKernelMarkdown('- [ ] \n').children[0].children[0]
  assert.equal(ascii.checked, null, 'bare "- [ ] " is NOT a task item to remark-gfm')
}

// Mid-document + no-trailing-newline positions.
{
  const src = '前面\n\n/task\n\n后面\n'
  const { doc } = insertTask(src, src.indexOf('/task') + 5)
  assert.equal(doc.text, '前面\n\n' + SEED_BYTES + '\n\n后面\n')
  assert.deepEqual(doc.whitespaceMarks, [{ from: 10, to: 11, ascii: '' }])
}
{
  const { doc } = insertTask('甲\n\n/task', 8)
  assert.equal(doc.text, '甲\n\n' + SEED_BYTES)
}

// CRLF: the seed bytes carry NO line ending of their own, so a CRLF document
// keeps its endings untouched and gains no lone LF.
{
  const src = '前面\r\n\r\n/task\r\n\r\n后面\r\n'
  const { doc } = insertTask(src, src.indexOf('/task') + 5)
  assert.equal(doc.text, '前面\r\n\r\n' + SEED_BYTES + '\r\n\r\n后面\r\n')
  assert.equal(/(?<!\r)\n/.test(doc.text), false, 'no lone LF was introduced')
  assert.equal(taskAt(doc.text).item.checked, false)
}

// REFUSALS specific to the task target.
{
  const refuse = (label, text, offset, language) => {
    const routed = insertBlockFromQuery({
      doc: createMarkdownDocument(text), index: buildSyntaxIndex(text), offset, target: 'task', language
    })
    assert.equal(routed.ok, false, label)
    assert.equal(routed.code, 'unsupported-structure', label)
  }
  // Directly above an existing list the written item would MERGE into it —
  // the reparsed list ends past the written bytes (probed: ONE two-item
  // list), so axis (a) refuses rather than proving a merge it did not write.
  refuse('directly above an existing list', '/task\n- x\n', 5)
  // Directly BELOW one merges the same way even across a blank line (a blank
  // line makes a CommonMark list LOOSE, it does not end it): the reparsed
  // list then STARTS before the written bytes, so no root child starts at
  // the insertion offset and axis (a) refuses. Measured first in the real
  // app: a second `/task` under a fresh task list. The remedy is the one the
  // toast names — or simply Enter at the first item's end, which continues
  // the list through the kernel's own split command.
  refuse('directly below an existing list', '- [ ] 甲\n\n/task\n', 14)
  // No info string exists for a task item.
  refuse('language on a task', '/task\n', 5, 'js')
  // Non-top-level contexts, like every other target.
  refuse('inside a blockquote', '> /task\n', 7)
  refuse('inside a list item', '- /task\n', 7)
}

// The exported target table is the menu's routing contract — pin the new row.
// (The full key-set pin lives in test-source-kernel-blockinsert.mjs section 8;
// this suite pins only its OWN row so it does not have to change every time a
// different target joins the table.)
{
  assert.ok(Object.hasOwn(BLOCK_INSERT_TARGETS, 'task'))
  assert.equal(BLOCK_INSERT_TARGETS.task.language, false)
}

// ---------------------------------------------------------------------------
// 2. DISSOLVE: the first label character deletes the seed in the SAME edit,
//    reparse-proven to be a task whose label is exactly the typed text.
// ---------------------------------------------------------------------------
const dissolve = (doc, offset, insert) => {
  const task = taskAt(doc.text)
  const seed = dissolvableTaskSeed(doc.text, task.charMap, doc.whitespaceMarks, offset)
  assert.ok(seed, 'the ledgered seed must be claimable')
  const routed = spellTaskSeedInsert({ doc, block: task.paragraph, seed, offset, insert })
  return { routed, task }
}

{
  const { doc } = insertTask('/task\n', 5)
  const { routed } = dissolve(doc, 7, '待')
  assert.equal(routed.ok, true, routed.code)
  assert.deepEqual(routed.edit, { from: 6, to: 7, insert: '待' },
    'ONE edit: delete the seed, insert the character')
  assert.equal(routed.dissolvedUnits, 1)
  assert.deepEqual(routed.transaction.selection, { anchor: 7, head: 7 })
  const applied = applySourceTransaction(doc, routed.transaction)
  assert.equal(applied.doc.text, '- [ ] 待\n', 'no U+00A0 survives the first label character')
  assert.deepEqual(applied.doc.whitespaceMarks, [], 'the seed entry dies with the edit')
  const task = taskAt(applied.doc.text)
  assert.equal(task.item.checked, false)
  assert.equal(task.label, '待', 'the label is exactly the typed text')
}

// Typing at the seed's START (Home/click) dissolves to the same bytes.
{
  const { doc } = insertTask('/task\n', 5)
  const { routed } = dissolve(doc, 6, 'a')
  assert.equal(routed.ok, true)
  assert.equal(applySourceTransaction(doc, routed.transaction).doc.text, '- [ ] a\n')
}

// A multi-character insert (an IME commit) dissolves under the whole run.
{
  const { doc } = insertTask('/task\n', 5)
  const { routed } = dissolve(doc, 7, '待办事项')
  assert.equal(routed.ok, true)
  assert.equal(applySourceTransaction(doc, routed.transaction).doc.text, '- [ ] 待办事项\n')
  assert.equal(taskAt('- [ ] 待办事项\n').label, '待办事项')
}

// CRLF document: the dissolve edit is interior to the line, endings untouched.
{
  const src = '前面\r\n\r\n/task\r\n'
  const { doc } = insertTask(src, src.indexOf('/task') + 5)
  const task = taskAt(doc.text)
  const seedAt = doc.whitespaceMarks[0]
  const seed = dissolvableTaskSeed(doc.text, task.charMap, doc.whitespaceMarks, seedAt.to)
  const routed = spellTaskSeedInsert({ doc, block: task.paragraph, seed, offset: seedAt.to, insert: 'x' })
  assert.equal(routed.ok, true, routed.code)
  const out = applySourceTransaction(doc, routed.transaction).doc.text
  assert.equal(out, '前面\r\n\r\n- [ ] x\r\n')
  assert.equal(/(?<!\r)\n/.test(out), false)
}

// A toggle between insert and first keystroke survives: the `- [x] ` seed
// dissolves to `- [x] label`, same checked state, proven not assumed.
{
  const text = '- [x] ' + NBSP + '\n'
  const doc = { ...createMarkdownDocument(text), whitespaceMarks: [{ from: 6, to: 7, ascii: '' }] }
  const { routed } = dissolve(doc, 7, '完')
  assert.equal(routed.ok, true)
  const out = applySourceTransaction(doc, routed.transaction).doc.text
  assert.equal(out, '- [x] 完\n')
  assert.equal(taskAt(out).item.checked, true, 'checked state preserved through the dissolve')
}

// A first-content SPACE cannot be proven (GFM strips it as checkbox padding —
// the dead-byte shape the header ADR names) and falls through, never refuses:
// the plain seed lands and the whitespace family owns the space.
{
  const { doc } = insertTask('/task\n', 5)
  const { routed } = dissolve(doc, 7, ' ')
  assert.equal(routed.ok, false)
  assert.equal(routed.code, 'not-structural', 'fall-through, not a refusal')
}

// ---------------------------------------------------------------------------
// 3. PROVENANCE: only a U+00A0 THIS kernel ledgered as a seed is dissolved.
// ---------------------------------------------------------------------------
{
  const text = SEED_BYTES + '\n'
  const { charMap } = taskAt(text)
  // A user-authored U+00A0 (file just opened — ledger empty) is NEVER claimed.
  assert.equal(dissolvableTaskSeed(text, charMap, [], 7), null,
    'a user-authored U+00A0 must never be dissolved')
  // A heal-written U+00A0 (whitespace provenance, non-empty ascii) is not a
  // seed either — that byte stands for a key the user pressed.
  assert.equal(dissolvableTaskSeed(text, charMap, [{ from: 6, to: 7, ascii: ' ' }], 7), null)
  assert.equal(dissolvableTaskSeed(text, charMap, [{ from: 6, to: 7, ascii: '\t' }], 7), null)
  // A seed entry only claims the byte it vouches for: an insert elsewhere
  // does not abut it.
  assert.equal(dissolvableTaskSeed(text, charMap, [{ from: 6, to: 7, ascii: '' }], 3), null)
  // And a ledger span whose bytes are no longer a U+00A0 claims nothing.
  assert.equal(dissolvableTaskSeed('- [ ] x\n', charMap, [{ from: 6, to: 7, ascii: '' }], 7), null)
}

// The ledger itself: `ascii: ''` is accepted by the document chokepoint, junk
// is not, and the remap drops the entry the moment any edit touches its span.
{
  const doc = createMarkdownDocument('- [ ] x\n')
  const seeded = applySourceTransaction(doc, {
    baseRevision: 0,
    edits: [{ from: 6, to: 7, insert: NBSP }],
    intent: 'insert-text',
    whitespaceMarks: [
      { from: 6, to: 7, ascii: '' }, // the seed provenance — must be kept
      { from: 6, to: 7, ascii: 'x' } // not whitespace provenance — must be dropped
    ]
  })
  assert.equal(seeded.ok, true)
  assert.deepEqual(seeded.doc.whitespaceMarks, [{ from: 6, to: 7, ascii: '' }])
  // The inverse (undo) restores the pre-seed bytes and the remap drops the
  // entry — no stale ledger row survives the byte it described.
  const undone = applySourceTransaction(seeded.doc, seeded.inverse)
  assert.equal(undone.doc.text, '- [ ] x\n')
  assert.deepEqual(undone.doc.whitespaceMarks, [])
}

// ---------------------------------------------------------------------------
// 4. SAVE BEFORE THE LABEL (the awkward instant) + COLD REOPEN. The bytes on
//    disk are the seed spelling; a reopened document (fresh ledger) still
//    holds a REAL checked:false task — and its U+00A0 is now the AUTHOR's:
//    typing appends after it instead of dissolving it.
// ---------------------------------------------------------------------------
{
  const { doc } = insertTask('/task\n', 5)
  const saved = doc.text // what saveTab would write — the kernel text IS the file
  assert.equal(saved, SEED_BYTES + '\n')

  // Cold reopen: a NEW document from the saved bytes, ledger empty by
  // construction (provenance is session-scoped, never persisted).
  const reopened = createMarkdownDocument(saved)
  assert.deepEqual(reopened.whitespaceMarks, [])
  const task = taskAt(reopened.text)
  assert.equal(task.item.checked, false, 'the file holds a REAL task across reopen')
  assert.equal(task.label, NBSP)
  assert.ok(task.charMap, 'still character-mappable — still editable')
  // The seed survived as the user's byte: no dissolve is claimable.
  assert.equal(dissolvableTaskSeed(reopened.text, task.charMap, reopened.whitespaceMarks, 7), null)
}

// ---------------------------------------------------------------------------
// 5. BACKSPACE ON THE FRESH SEED (2026-08-20 adversarial audit, Critical).
//    The documented contract (guide 被拒绝的操作, ai-handoff §5.2g) is a
//    refusal — "empty task unrepresentable" — but the wall was never reached:
//    syntax-index.js computed `empty` with String.trim(), which strips
//    U+00A0, so the seeded item classified EMPTY and the router sent
//    Backspace to exitEmptyListItem, silently deleting the whole `- [ ]  `
//    line (zero toasts, caret-unmappable, item-less bytes on save). Pre-fix
//    this section fails at its FIRST assertion (`empty` is true), then at
//    the router pin (`Backspace` answers ok/exit-empty-list-item), then at
//    the wall (the function does not exist).
// ---------------------------------------------------------------------------
{
  const text = '甲段\n\n' + SEED_BYTES + '\n\n末段\n'
  const index = buildSyntaxIndex(text)
  const seedStart = text.indexOf(NBSP)
  const item = index.listItemAt(seedStart + 1)

  // ROOT CAUSE: `empty` must agree with the parser this index is built from.
  // The seed item HAS content (a paragraph whose text is the U+00A0), so it
  // is not empty — String.trim()'s Unicode whitespace table said otherwise.
  assert.equal(item.empty, false,
    'the seeded item is NOT empty — its U+00A0 is parser-visible content')
  assert.equal(taskAt(text).label, NBSP, 'the parser itself says so')

  // ROUTER: neither Backspace nor Enter may take the empty-item exit that
  // silently deletes the marker line. Backspace is a text-path question
  // (`not-structural` — the gateway wall below owns the byte answer); Enter
  // routes to the ordinary task-item split, same as any non-empty task item.
  const doc = { text, revision: 0 }
  assert.deepEqual(routeStructuralKey('Backspace', { doc, index, offset: seedStart + 1 }),
    { ok: false, code: 'not-structural' },
    'Backspace on the seed must NOT resolve to a structural line deletion')
  const enter = routeStructuralKey('Enter', { doc, index, offset: seedStart + 1 })
  assert.notEqual(enter?.transaction?.intent, 'exit-empty-list-item',
    'Enter on the seed must not silently delete the item either')

  // CONTROL: a genuinely empty ASCII item keeps the Typora exit semantics —
  // this fix narrows `empty`, it does not disable the empty-item commands.
  const asciiIndex = buildSyntaxIndex('- 甲\n- \n')
  assert.equal(asciiIndex.listItemAt(6).empty, true)
  assert.equal(
    routeStructuralKey('Backspace', { doc: { text: '- 甲\n- \n', revision: 0 }, index: asciiIndex, offset: 6 })
      .transaction?.intent,
    'exit-empty-list-item',
    'Backspace in a real empty item still lifts out of the list'
  )
}

// THE WALL (`taskSeedDeleteRefusal`): a delete consuming the ledgered seed
// with nothing left in the paragraph refuses with its own code; every other
// provenance and every content-preserving shape is left unclaimed.
{
  const text = SEED_BYTES + '\n'
  const doc = createMarkdownDocument(text)
  const block = taskAt(text).paragraph
  const seedLedger = [{ from: 6, to: 7, ascii: '' }]
  const wall = (marks, edits, docOverride) =>
    taskSeedDeleteRefusal({ doc: docOverride || doc, block, marks, edits })

  // The audit's exact keystroke: one Backspace on the fresh seed.
  assert.deepEqual(wall(seedLedger, [{ from: 6, to: 7, insert: '' }]),
    { ok: false, code: EMPTY_TASK_CODE },
    'deleting the ledgered seed refuses — the documented empty-task wall')
  assert.equal(EMPTY_TASK_CODE, 'empty-task-unrepresentable',
    'the code is the i18n key suffix — the toast names the exits')
  // Replacing the seed with ASCII whitespace is the same demotion in
  // disguise (`- [ ]  ` with a trailing ASCII space is checked:null too).
  assert.deepEqual(wall(seedLedger, [{ from: 6, to: 7, insert: ' ' }]),
    { ok: false, code: EMPTY_TASK_CODE })

  // NOT CLAIMED — each of these keeps its pre-existing behaviour:
  const NO_CLAIM = { ok: false, code: 'not-structural' }
  // a user-authored U+00A0 (reopened file — empty ledger),
  assert.deepEqual(wall([], [{ from: 6, to: 7, insert: '' }]), NO_CLAIM)
  // a heal-written one (stands for a pressed Space),
  assert.deepEqual(wall([{ from: 6, to: 7, ascii: ' ' }], [{ from: 6, to: 7, insert: '' }]), NO_CLAIM)
  // a replace that types real content over the seed (the dissolve's bytes),
  assert.deepEqual(wall(seedLedger, [{ from: 6, to: 7, insert: 'x' }]), NO_CLAIM)
  // and a delete of the seed that leaves other label content standing —
  // `- [ ] x` is still a task, the literal delete is honest.
  {
    const withLabel = SEED_BYTES + 'x\n'
    const labelDoc = createMarkdownDocument(withLabel)
    const labelBlock = taskAt(withLabel).paragraph
    assert.deepEqual(
      taskSeedDeleteRefusal({
        doc: labelDoc, block: labelBlock, marks: seedLedger,
        edits: [{ from: 6, to: 7, insert: '' }]
      }),
      NO_CLAIM
    )
    // …while deleting seed AND label together empties the item: refused.
    assert.deepEqual(
      taskSeedDeleteRefusal({
        doc: labelDoc, block: labelBlock, marks: seedLedger,
        edits: [{ from: 6, to: 8, insert: '' }]
      }),
      { ok: false, code: EMPTY_TASK_CODE }
    )
  }
  // An edit escaping the block's own span belongs to the cross-block guards.
  assert.deepEqual(wall(seedLedger, [{ from: 2, to: 7, insert: '' }]), NO_CLAIM)
}

console.log('ok - source kernel task seed')
