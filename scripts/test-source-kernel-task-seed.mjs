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

// ---------------------------------------------------------------------------
// 1c. THE PREDICTED LIST MERGE (2026-08-21). `/task` in a paragraph next to an
//     existing list of the SAME marker used to refuse `unsupported-structure`:
//     a blank line makes a CommonMark list LOOSE, it does not END it, so the
//     written item is absorbed by the neighbour and the structure-identical
//     axes could not tell that from bytes meaning something else.
//     `provePredictedListMerge` (commands/list-merge.js) now predicts the
//     merge and verifies it item by item.
//
//     Every case below asserts the BYTES, then REPARSES them: the merged list
//     is one list holding the neighbours' items and ours, in order, each
//     neighbour's label intact and OUR item a real `checked: false` task whose
//     whole content is the seed — the same standard the standalone insert is
//     held to, asked of an item that now has company.
// ---------------------------------------------------------------------------
{
  // The caret always sits at the query block's own end — derived from the
  // fixture rather than restated as a literal, so a fixture edit can never
  // silently move the caret into a block's interior (where the command
  // refuses for an unrelated reason and the case would pass vacuously).
  const queryEnd = (text) => {
    const at = text.indexOf('/task')
    assert.ok(at >= 0, 'the fixture must contain the query')
    return at + '/task'.length
  }
  // `labels` are the merged list's items in order; `null` marks OUR item,
  // which is additionally proven to be a real task holding only the seed.
  const merge = (label, text, expected, labels) => {
    const { routed, doc } = insertTask(text, queryEnd(text))
    assert.equal(doc.text, expected, label)
    const roots = parseKernelMarkdown(doc.text).children.filter((n) => n.type === 'list')
    assert.equal(roots.length, 1, `${label}: the neighbours and the new item are ONE list`)
    const items = roots[0].children
    assert.equal(items.length, labels.length, `${label}: item count`)
    const ours = labels.indexOf(null)
    items.forEach((item, index) => {
      const decoded = (item.children[0]?.children || []).map((n) => n.value ?? '').join('')
      if (index === ours) {
        assert.equal(item.checked, false, `${label}: our item is a REAL task`)
        assert.equal(decoded, NBSP, `${label}: holding exactly the seed`)
      } else {
        assert.equal(decoded, labels[index],
          `${label}: neighbour item ${index} survives unchanged`)
      }
    })
    // The caret sits after the seed, inside OUR item — derived from the
    // command, then checked against the reparsed item's own span.
    const anchor = routed.transaction.selection.anchor
    assert.ok(anchor > items[ours].position.start.offset &&
      anchor <= items[ours].position.end.offset, `${label}: the caret lands in our item`)
    // The ledger vouches for exactly the byte the reparse calls our content.
    assert.deepEqual(doc.whitespaceMarks,
      [{ from: anchor - 1, to: anchor, ascii: '' }], `${label}: the seed is ledgered`)
    assert.equal(doc.text.slice(anchor - 1, anchor), NBSP, `${label}: and that byte IS the seed`)
    return doc
  }

  // (a) Merge DOWNWARD: the item is written above an existing list and joins
  //     it as the first item. Across a blank line (loose) …
  merge('above a list', '/task\n\n- 乙\n', SEED_BYTES + '\n\n- 乙\n', [null, '乙'])
  // … and with no blank line at all (the list interrupts the paragraph; the
  // merged list stays TIGHT, so this shape has no spread flip whatsoever).
  merge('above a list, no blank line', '/task\n- 乙\n', SEED_BYTES + '\n- 乙\n', [null, '乙'])

  // (b) Merge UPWARD: no root child starts at the insertion offset at all —
  //     the neighbour list swallowed it — which is why axis (a) alone could
  //     never accept this. The shape measured in the real app: a second
  //     `/task` under a fresh task list.
  merge('below a task list', '- [ ] 甲\n\n/task\n', '- [ ] 甲\n\n' + SEED_BYTES + '\n',
    ['甲', null])
  merge('below a bullet list', '- 甲\n\n/task\n', '- 甲\n\n' + SEED_BYTES + '\n',
    ['甲', null])

  // (c) BOTH neighbours at once — three items, ours in the middle.
  merge('between two lists', '- 甲\n\n/task\n\n- 乙\n',
    '- 甲\n\n' + SEED_BYTES + '\n\n- 乙\n', ['甲', null, '乙'])

  // (d) A multi-item neighbour with NESTED content: every item is compared as
  //     a full subtree, so a nested list that moved or changed depth would
  //     fail. Here it must survive byte-identically.
  {
    const doc = merge('below a list with a nested item', '- 甲\n  - 甲1\n- 乙\n\n/task\n',
      '- 甲\n  - 甲1\n- 乙\n\n' + SEED_BYTES + '\n', ['甲', '乙', null])
    const outer = parseKernelMarkdown(doc.text).children[0]
    const nested = outer.children[0].children[1]
    assert.equal(nested.type, 'list', 'the nested list is still nested')
    assert.deepEqual([nested.position.start.offset, nested.position.end.offset], [6, 10],
      'and it did not move a byte')
  }

  // (e) The query block is a HEADING sitting next to a list (delta is
  //     NEGATIVE here — `## /task` is longer than the seed spelling).
  merge('a heading query above a list', '## /task\n\n- 乙\n', SEED_BYTES + '\n\n- 乙\n',
    [null, '乙'])

  // (f) CRLF: the seed bytes carry no line ending, so a merged CRLF document
  //     gains no lone LF.
  {
    const doc = merge('below a list, CRLF', '- 甲\r\n\r\n/task\r\n',
      '- 甲\r\n\r\n' + SEED_BYTES + '\r\n', ['甲', null])
    assert.equal(/(?<!\r)\n/.test(doc.text), false, 'no lone LF was introduced')
  }

  // (g) A DIFFERENT marker does not merge in CommonMark at all (probed:
  //     `- a` beside `* b`, or beside `1. b`, are two lists), so these
  //     shapes take the structure-identical axes and always have. Asserted
  //     as a PREMISE of (a)-(f) rather than assumed: it is what makes the
  //     merge proof necessary only for same-marker neighbours.
  {
    const two = (text, expected) => {
      const { doc } = insertTask(text, queryEnd(text))
      assert.equal(doc.text, expected)
      const lists = parseKernelMarkdown(doc.text).children.filter((n) => n.type === 'list')
      assert.equal(lists.length, 2, 'a different marker keeps them two lists')
      return doc
    }
    two('/task\n\n* 乙\n', SEED_BYTES + '\n\n* 乙\n')
    two('/task\n\n1. 乙\n', SEED_BYTES + '\n\n1. 乙\n')
    two('1. 甲\n\n/task\n', '1. 甲\n\n' + SEED_BYTES + '\n')
  }

  // (h) THE SPREAD FLIP, stated rather than hidden (list-merge.js's one
  //     accepted difference): two TIGHT lists joined across a blank line
  //     become one LOOSE list. mdast's items are structurally identical
  //     either way — which is why the projection map cannot see it and why
  //     the proof accepts it.
  {
    const before = parseKernelMarkdown('- 甲\n- 乙\n').children[0]
    assert.equal(before.spread, false, 'the premise: the neighbour list is tight')
    const { doc } = insertTask('- 甲\n- 乙\n\n/task\n', queryEnd('- 甲\n- 乙\n\n/task\n'))
    const after = parseKernelMarkdown(doc.text).children[0]
    assert.equal(after.spread, true, 'the merged list is loose — the accepted difference')
    assert.deepEqual(after.children.map((item) => item.spread), [false, false, false],
      'every ITEM keeps its own spread; only the list-level flag flipped')
    assert.deepEqual(
      after.children.slice(0, 2).map((item) => [item.position.start.offset, item.position.end.offset]),
      [[0, 3], [4, 7]], 'and no neighbour item moved a byte')
  }
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
  // (Adjacent-list positions are NO LONGER refused — see section 1c. What
  // stays refused is everything that is not a proven merge.)
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

// THE BYTE-WRITING COMMAND RE-CHECKS THE LEDGER ITSELF (2026-08-20
// adversarial panel, Minor). `spellTaskSeedInsert` used to re-prove a
// caller-supplied seed descriptor against the BYTES only, trusting that the
// caller had screened provenance through `dissolvableTaskSeed` — so a forged
// descriptor could spend a U+00A0 the ledger never vouched for (a
// user-authored byte, or a heal-written one standing for a real keystroke)
// as if it were a seed. The command is the last gate before bytes are
// written, so it now requires the `ascii:''` entry in `doc.whitespaceMarks`
// itself — the same "a document with no ledger claims NOTHING" posture as
// `healableTrailingSpace`.
{
  const text = SEED_BYTES + '\n'
  const { paragraph } = taskAt(text)
  const forged = { rawStart: 6, rawEnd: 7 }
  // A user-authored U+00A0: reopened file, ledger empty by construction.
  assert.deepEqual(
    spellTaskSeedInsert({
      doc: createMarkdownDocument(text), block: paragraph, seed: forged, offset: 7, insert: 'x'
    }),
    { ok: false, code: 'not-structural' },
    'a seed descriptor the ledger does not vouch for must never dissolve')
  // A heal-written U+00A0: that byte stands for a pressed key, not a seed.
  assert.deepEqual(
    spellTaskSeedInsert({
      doc: { ...createMarkdownDocument(text), whitespaceMarks: [{ from: 6, to: 7, ascii: ' ' }] },
      block: paragraph, seed: forged, offset: 7, insert: 'x'
    }),
    { ok: false, code: 'not-structural' },
    'heal provenance is not seed provenance — the empty string is the partition')
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

  // ROUTER: Backspace may never take the empty-item exit that silently
  // deletes the marker line — it is a text-path question (`not-structural`;
  // the gateway wall below owns the byte answer). Enter's contract is
  // LEDGER-GATED since the 2026-08-21 task-Enter matrix: on an UNLEDGERED
  // seed (this doc carries no whitespaceMarks — the reopened-file shape) the
  // U+00A0 is the author's content, so Enter must SPLIT, never delete; the
  // session-ledgered seed's deliberate Enter-exit is pinned in section 6.
  const doc = { text, revision: 0 }
  assert.deepEqual(routeStructuralKey('Backspace', { doc, index, offset: seedStart + 1 }),
    { ok: false, code: 'not-structural' },
    'Backspace on the seed must NOT resolve to a structural line deletion')
  const enter = routeStructuralKey('Enter', { doc, index, offset: seedStart + 1 })
  assert.notEqual(enter?.transaction?.intent, 'exit-empty-list-item',
    'Enter on an UNLEDGERED (author-owned) seed must not silently delete the item')
  assert.equal(enter?.transaction?.intent, 'split-list-item',
    'it splits like any other item with content')

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

// ---------------------------------------------------------------------------
// 6. ENTER CONTINUATION (2026-08-21 user report 「任务列表的回车解析目前还是
//    坏的」). splitListItem used to write the empty side of a task split as
//    bare `- [ ] ` — the demoted spelling (checked:null, literal "[ ]" text,
//    caret-unmappable anchor). Now the empty side gets the SAME session-
//    ledgered seed `/task` writes, proven by reparse, and the first label
//    character dissolves it through the same commands. Pre-fix, every case
//    below fails on bytes (no U+00A0, no ledger entry).
// ---------------------------------------------------------------------------
const routeEnter = (doc, offset) =>
  routeStructuralKey('Enter', { doc, index: buildSyntaxIndex(doc.text), offset })

{
  // (a) End of label, LF: the NEW item is seeded, ledgered, caret after the
  // seed — and the seed dissolves under the first label character exactly
  // like a `/task` seed (same commands, same ledger).
  const doc = createMarkdownDocument('- [ ] 甲乙\n')
  const routed = routeEnter(doc, 8)
  assert.equal(routed.ok, true, routed.code)
  assert.equal(routed.transaction.intent, 'split-list-item')
  const applied = applySourceTransaction(doc, routed.transaction)
  assert.equal(applied.doc.text, '- [ ] 甲乙\n- [ ] ' + NBSP + '\n',
    'the continuation item carries the seed, not the demoted bare spelling')
  assert.deepEqual(applied.doc.whitespaceMarks, [{ from: 15, to: 16, ascii: '' }],
    'the new seed is ledgered with the stands-for-no-keystroke provenance')
  assert.deepEqual(routed.transaction.selection, { anchor: 16, head: 16 },
    'the caret lands AFTER the seed — a character-map unit, never a dead anchor')
  const items = parseKernelMarkdown(applied.doc.text).children[0].children
  assert.deepEqual(items.map((i) => i.checked), [false, false],
    'BOTH items are REAL tasks — the new one is not literal "[ ]" text')

  // …and the first label character dissolves it (the same machinery).
  const seed = dissolvableTaskSeed(applied.doc.text,
    buildCharacterMap(applied.doc.text, items[1].children[0]), applied.doc.whitespaceMarks, 16)
  assert.ok(seed, 'the Enter-written seed is claimable by the dissolve')
  const dissolved = spellTaskSeedInsert({
    doc: applied.doc, block: items[1].children[0], seed, offset: 16, insert: 'x'
  })
  assert.equal(dissolved.ok, true, dissolved.code)
  const final = applySourceTransaction(applied.doc, dissolved.transaction)
  assert.equal(final.doc.text, '- [ ] 甲乙\n- [ ] x\n')
  assert.deepEqual(final.doc.whitespaceMarks, [])
}

{
  // (b) A CHECKED item continues UNCHECKED (cell 4): marker `[ ]`, seed, and
  // the original keeps its `[x]`.
  const doc = createMarkdownDocument('- [x] 完毕\n')
  const applied = applySourceTransaction(doc, routeEnter(doc, 8).transaction)
  assert.equal(applied.doc.text, '- [x] 完毕\n- [ ] ' + NBSP + '\n')
  const items = parseKernelMarkdown(applied.doc.text).children[0].children
  assert.deepEqual(items.map((i) => i.checked), [true, false])
}

{
  // (c) Enter at the label's START (beforeEmpty): the label moves down, the
  // ORIGINAL item keeps its own checked state with the seed as its content,
  // and the caret rides with the label.
  const doc = createMarkdownDocument('- [x] 甲\n')
  const routed = routeEnter(doc, 6)
  const applied = applySourceTransaction(doc, routed.transaction)
  assert.equal(applied.doc.text, '- [x] ' + NBSP + '\n- [ ] 甲\n',
    'the original item is seeded, the label becomes the new item')
  assert.deepEqual(applied.doc.whitespaceMarks, [{ from: 6, to: 7, ascii: '' }])
  assert.equal(applied.doc.text.charCodeAt(routed.transaction.selection.anchor), '甲'.charCodeAt(0),
    'the caret lands on the moved label')
  const items = parseKernelMarkdown(applied.doc.text).children[0].children
  assert.deepEqual(items.map((i) => i.checked), [true, false],
    'the original keeps [x]; the pushed-down label item is a fresh [ ]')
}

{
  // (d) Nested + quoted + ordered shapes all carry the seed with their own
  // prefixes (cell 5).
  const nested = createMarkdownDocument('- 父\n  - [ ] 子\n')
  const appliedNested = applySourceTransaction(nested,
    routeEnter(nested, '- 父\n  - [ ] 子'.length).transaction)
  assert.equal(appliedNested.doc.text, '- 父\n  - [ ] 子\n  - [ ] ' + NBSP + '\n')

  const quoted = createMarkdownDocument('> - [ ] 引\n')
  const appliedQuoted = applySourceTransaction(quoted,
    routeEnter(quoted, '> - [ ] 引'.length).transaction)
  assert.equal(appliedQuoted.doc.text, '> - [ ] 引\n> - [ ] ' + NBSP + '\n')

  const ordered = createMarkdownDocument('3. [ ] a\n')
  const appliedOrdered = applySourceTransaction(ordered,
    routeEnter(ordered, '3. [ ] a'.length).transaction)
  assert.equal(appliedOrdered.doc.text, '3. [ ] a\n4. [ ] ' + NBSP + '\n',
    'ordered task continuation: number + 1, unchecked, seeded')
}

{
  // (e) CRLF (cell 5c): the document's own ending is reused, no lone LF, and
  // the seed rides inside the line.
  const doc = createMarkdownDocument('- [ ] 甲\r\n')
  const applied = applySourceTransaction(doc, routeEnter(doc, 7).transaction)
  assert.equal(applied.doc.text, '- [ ] 甲\r\n- [ ] ' + NBSP + '\r\n')
  assert.equal(/(?<!\r)\n/.test(applied.doc.text), false, 'no lone LF was introduced')
  // insert = '\r\n- [ ] ' + seed at offset 7 → the seed byte sits at 15.
  assert.deepEqual(applied.doc.whitespaceMarks, [{ from: 15, to: 16, ascii: '' }])
}

{
  // (f) Mid-label split is UNCHANGED (cell 2 — the one cell that already
  // worked): both sides keep content, no seed, no ledger entry.
  const doc = createMarkdownDocument('- [ ] 甲乙\n')
  const applied = applySourceTransaction(doc, routeEnter(doc, 7).transaction)
  assert.equal(applied.doc.text, '- [ ] 甲\n- [ ] 乙\n')
  assert.deepEqual(applied.doc.whitespaceMarks, [], 'no seed when both sides have content')
}

{
  // (g) Cell 3 — Enter on the SESSION-LEDGERED seed exits the list (the
  // Typora lift-out plain lists already take): the marker line is removed,
  // the ledger entry dies with its byte, and the query bytes come back on
  // undo via the ordinary history path.
  const { doc } = insertTask('/task\n', 5)
  for (const offset of [6, 7]) { // before AND after the seed — same item
    const routed = routeEnter(doc, offset)
    assert.equal(routed.ok, true, routed.code)
    assert.equal(routed.transaction.intent, 'exit-empty-list-item',
      'the ledgered, never-labelled seed item is EFFECTIVELY empty for Enter')
  }
  const applied = applySourceTransaction(doc, routeEnter(doc, 7).transaction)
  assert.equal(applied.doc.text, '\n', 'the marker line is removed — list ended')
  assert.deepEqual(applied.doc.whitespaceMarks, [], 'the seed entry died with its line')

  // The UNLEDGERED twin (reopened file) SPLITS instead — the author's U+00A0
  // is content, so Enter continues the list with a NEW seeded item and the
  // author's byte is never deleted.
  const reopened = createMarkdownDocument(SEED_BYTES + '\n')
  const routedReopened = routeEnter(reopened, 7)
  assert.equal(routedReopened.transaction.intent, 'split-list-item')
  const appliedReopened = applySourceTransaction(reopened, routedReopened.transaction)
  assert.equal(appliedReopened.doc.text, SEED_BYTES + '\n- [ ] ' + NBSP + '\n')
  assert.deepEqual(appliedReopened.doc.whitespaceMarks, [{ from: 14, to: 15, ascii: '' }],
    'only the NEW seed is ledgered — the author\'s byte stays theirs')

  // A heal-provenance U+00A0 (stands for a pressed key) is not a seed item
  // either: split, not exit.
  const healed = { ...createMarkdownDocument(SEED_BYTES + '\n'), whitespaceMarks: [{ from: 6, to: 7, ascii: ' ' }] }
  assert.equal(routeEnter(healed, 7).transaction.intent, 'split-list-item')
}

console.log('ok - source kernel task seed')
