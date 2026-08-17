import assert from 'node:assert/strict'
import { createMarkdownDocument, applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { createSourceHistory } from '../src/renderer/src/lib/source-kernel/history.js'

let doc = createMarkdownDocument('ab\n')
const history = createSourceHistory()
const commit = (txn) => {
  const r = applySourceTransaction(doc, txn)
  assert.equal(r.ok, true)
  history.record(r, txn)
  doc = r.doc
  return r
}

// 连续打字合并为一个 undo 组
commit({ baseRevision: 0, from: 1, to: 1, insert: 'X', intent: 'insert-text' })
commit({ baseRevision: 1, from: 2, to: 2, insert: 'Y', intent: 'insert-text' })
assert.equal(doc.text, 'aXYb\n')
assert.equal(history.depth(), 1)

// 结构命令不合并
commit({ baseRevision: 2, from: 4, to: 4, insert: '\n\n', intent: 'split-block' })
assert.equal(history.depth(), 2)

// undo 逐组回退，逐字节还原
let u = history.undo(doc)
doc = applySourceTransaction(doc, u).doc
assert.equal(doc.text, 'aXYb\n')
u = history.undo(doc)
doc = applySourceTransaction(doc, u).doc
assert.equal(doc.text, 'ab\n')
assert.equal(history.undo(doc), null)

// redo 前滚；新录入清空 redo
let r = history.redo(doc)
doc = applySourceTransaction(doc, r).doc
assert.equal(doc.text, 'aXYb\n')
commit({ baseRevision: doc.revision, from: 0, to: 0, insert: 'Z', intent: 'insert-text' })
assert.equal(history.redo(doc), null)

// breakGroup 阻断合并（IME 提交单元边界）
{
  let d = createMarkdownDocument('')
  const h = createSourceHistory()
  const c = (txn) => { const res = applySourceTransaction(d, txn); h.record(res, txn); d = res.doc }
  c({ baseRevision: 0, from: 0, to: 0, insert: 'a', intent: 'insert-text' })
  h.breakGroup()
  c({ baseRevision: 1, from: 1, to: 1, insert: 'b', intent: 'insert-text' })
  assert.equal(h.depth(), 2)
}

// undo/redo 本身是一个合并边界：撤销/重做之后紧跟在同一位置的输入，
// 不得与被重做回来的组合并——否则一次 undo 会把 X+Y 连同新输入的 Z 一起撤掉。
{
  let d = createMarkdownDocument('ab\n')
  const h = createSourceHistory()
  const c = (txn) => { const res = applySourceTransaction(d, txn); h.record(res, txn); d = res.doc; return res }
  c({ baseRevision: 0, from: 1, to: 1, insert: 'X', intent: 'insert-text' })
  c({ baseRevision: 1, from: 2, to: 2, insert: 'Y', intent: 'insert-text' })
  assert.equal(d.text, 'aXYb\n')
  assert.equal(h.depth(), 1)

  const undone = h.undo(d)
  d = applySourceTransaction(d, undone).doc
  assert.equal(d.text, 'ab\n')

  const redone = h.redo(d)
  d = applySourceTransaction(d, redone).doc
  assert.equal(d.text, 'aXYb\n')

  // Z 紧接在重做组的插入终点（位置3）打字，若合并逻辑没有被 undo/redo 打断，
  // 会被错误地并入 X+Y 那一组。
  c({ baseRevision: d.revision, from: 3, to: 3, insert: 'Z', intent: 'insert-text' })
  assert.equal(d.text, 'aXYZb\n')
  assert.equal(h.depth(), 2, 'undo/redo must break coalescing for the next commit')

  const undoZOnly = h.undo(d)
  d = applySourceTransaction(d, undoZOnly).doc
  assert.equal(d.text, 'aXYb\n', 'one undo after the boundary must remove only Z')
}

// 历史与文档失步（外部事务绕过 history.record 直接 apply）时 undo 必须拒绝
{
  let d = createMarkdownDocument('ab\n')
  const h = createSourceHistory()
  const first = applySourceTransaction(d, { baseRevision: 0, from: 1, to: 1, insert: 'X', intent: 'insert-text' })
  h.record(first, { baseRevision: 0, from: 1, to: 1, insert: 'X', intent: 'insert-text' })
  d = first.doc
  assert.equal(d.text, 'aXb\n')

  // 绕过 history：直接对当前文档再 apply 一次未被记录的事务
  const external = applySourceTransaction(d, { baseRevision: d.revision, from: 0, to: 0, insert: 'Q', intent: 'insert-text' })
  assert.equal(external.ok, true)
  const desynced = external.doc
  assert.equal(h.undo(desynced), null, 'undo must refuse once doc has drifted from history state')

  // 在正确同步的文档上仍然可用
  assert.notEqual(h.undo(d), null)
}

// undo -> undo -> redo -> redo 跨越一个结构命令边界，
// 校验每次返回事务的 baseRevision 都等于调用时的 doc.revision
{
  let d = createMarkdownDocument('ab\n')
  const h = createSourceHistory()
  const c = (txn) => { const res = applySourceTransaction(d, txn); h.record(res, txn); d = res.doc; return res }
  c({ baseRevision: 0, from: 1, to: 1, insert: 'X', intent: 'insert-text' })
  c({ baseRevision: 1, from: 2, to: 2, insert: 'Y', intent: 'insert-text' })
  c({ baseRevision: 2, from: 4, to: 4, insert: '\n\n', intent: 'split-block' })
  assert.equal(h.depth(), 2)

  let txn = h.undo(d)
  assert.equal(txn.baseRevision, d.revision)
  d = applySourceTransaction(d, txn).doc

  txn = h.undo(d)
  assert.equal(txn.baseRevision, d.revision)
  d = applySourceTransaction(d, txn).doc
  assert.equal(d.text, 'ab\n')

  txn = h.redo(d)
  assert.equal(txn.baseRevision, d.revision)
  d = applySourceTransaction(d, txn).doc

  txn = h.redo(d)
  assert.equal(txn.baseRevision, d.revision)
  d = applySourceTransaction(d, txn).doc
  assert.equal(d.text, 'aXYb\n\n\n')
}

// undo(doc) 返回的事务的 selection 必须落在撤销后文档的范围内 —— 不能是
// 正向事务那个（可能更长的）文档坐标系下的残留 selection。
{
  let d = createMarkdownDocument('ab\n')
  const h = createSourceHistory()
  const c = (txn) => { const res = applySourceTransaction(d, txn); h.record(res, txn); d = res.doc; return res }
  c({
    baseRevision: 0, from: 1, to: 1, insert: 'XYZ', intent: 'insert-text',
    selection: { anchor: 4, head: 4 }
  })
  assert.equal(d.text, 'aXYZb\n')

  const undoTxn = h.undo(d)
  // 单步组直接复用 applySourceTransaction 产出的 inverse，selection 应为其
  // 自身推导出的 caret（1），而不是正向 selection 的 4。
  assert.deepEqual(undoTxn.selection, { anchor: 1, head: 1 })

  const applied = applySourceTransaction(d, undoTxn)
  assert.equal(applied.ok, true)
  d = applied.doc
  assert.equal(d.text, 'ab\n')
  assert.ok(applied.selection.anchor <= d.text.length && applied.selection.head <= d.text.length,
    'undo selection must stay within the restored document bounds')
  assert.deepEqual(applied.selection, { anchor: 1, head: 1 })
}

console.log('PASS source-kernel history')

// ===========================================================================
// RE-REVIEW (2026-08-17): the CRLF chokepoint must never freeze the stack.
//
// `applySourceTransaction`'s CRLF chokepoint (Critical 3) refuses any edit
// boundary that splits a '\r\n'. Any forward edit that CREATES such an
// adjacency at its own boundary has an inverse whose insert point lands
// exactly there — even though that inverse restores the document to bytes it
// already had. 122 of 4239 accepted forward edits across 6 mixed-ending
// documents had one. Worse, `pop` moves the group between the stacks and
// advances `lastKnownRevision` BEFORE the caller applies, so ONE refusal
// desynced the pointer and every LATER undo AND redo returned null.
//
// Two independent fixes, both pinned here: the `history-invert` exemption
// (correctness) and `rollbackReplay` (robustness for any other refusal).
// ===========================================================================

// (1) THE EXACT REPRO. Mixed-ending document, two edits, then undo/undo/redo.
{
  let d = createMarkdownDocument('a\rb\nc\n')
  const h = createSourceHistory()
  const step = (txn) => {
    const r = applySourceTransaction(d, txn)
    assert.equal(r.ok, true, `forward edit refused: ${r.code}`)
    h.record(r, txn)
    d = r.doc
  }
  // edit 1: append 'Q' after 'c' -> 'a\rb\ncQ\n'
  step({ baseRevision: 0, from: 5, to: 5, insert: 'Q', intent: 'insert-text' })
  assert.equal(d.text, 'a\rb\ncQ\n')
  // edit 2: delete 'b' -> 'a\r\ncQ\n'. This CREATES the '\r\n' adjacency, so
  // its inverse inserts at the offset between them.
  h.breakGroup()
  step({ baseRevision: 1, from: 2, to: 3, insert: '', intent: 'split-block' })
  assert.equal(d.text, 'a\r\ncQ\n')

  // undo 1 — this is the one that used to be refused with `invalid-range`.
  const undo1 = h.undo(d)
  assert.ok(undo1, 'undo 1 must produce a transaction')
  assert.equal(undo1.intent, 'history-invert')
  let applied = applySourceTransaction(d, undo1)
  assert.equal(applied.ok, true, `undo 1 refused: ${applied.code}`)
  d = applied.doc
  assert.equal(d.text, 'a\rb\ncQ\n', 'undo 1 must restore the exact pre-edit bytes')

  // undo 2 — used to return null (the stack was frozen by the refusal).
  const undo2 = h.undo(d)
  assert.ok(undo2, 'undo 2 must NOT be null: one refusal may not freeze the stack')
  applied = applySourceTransaction(d, undo2)
  assert.equal(applied.ok, true, `undo 2 refused: ${applied.code}`)
  d = applied.doc
  assert.equal(d.text, 'a\rb\nc\n', 'undo 2 must restore the original document')

  // redo — used to return null too.
  const redo1 = h.redo(d)
  assert.ok(redo1, 'redo must NOT be null after the undos')
  applied = applySourceTransaction(d, redo1)
  assert.equal(applied.ok, true, `redo refused: ${applied.code}`)
  d = applied.doc
  assert.equal(d.text, 'a\rb\ncQ\n', 'redo must replay forward byte-exact')
  const redo2 = h.redo(d)
  assert.ok(redo2, 'redo 2 must NOT be null')
  d = applySourceTransaction(d, redo2).doc
  assert.equal(d.text, 'a\r\ncQ\n', 'redo 2 must reach the post-edit-2 bytes')
}

// (2) The exemption is EXACTLY the `history-invert` intent — the same edit
//     under any other intent is still refused, so the chokepoint's own
//     Critical-3 contract is untouched.
{
  const d = createMarkdownDocument('a\r\ncQ\n')
  const edit = { baseRevision: 0, from: 2, to: 2, insert: 'b' }
  assert.equal(applySourceTransaction(d, { ...edit, intent: 'insert-text' }).code, 'invalid-range')
  assert.equal(applySourceTransaction(d, { ...edit, intent: 'split-block' }).code, 'invalid-range')
  const restored = applySourceTransaction(d, { ...edit, intent: 'history-invert' })
  assert.equal(restored.ok, true, 'an inverse restoring bytes the document had must apply')
  assert.equal(restored.doc.text, 'a\rb\ncQ\n')
}

// (3) `rollbackReplay`: a caller whose apply FAILS (for any reason — the
//     mode layer's parse/projection refusals, not just kernel codes) puts the
//     group back and the stack behaves as if the replay never happened.
{
  let d = createMarkdownDocument('ab\n')
  const h = createSourceHistory()
  const step = (txn) => {
    const r = applySourceTransaction(d, txn)
    assert.equal(r.ok, true)
    h.record(r, txn)
    d = r.doc
  }
  step({ baseRevision: 0, from: 1, to: 1, insert: 'X', intent: 'insert-text' })
  h.breakGroup()
  step({ baseRevision: 1, from: 2, to: 2, insert: 'Y', intent: 'insert-text' })
  assert.equal(d.text, 'aXYb\n')
  assert.equal(h.depth(), 2)

  // Pop, pretend the apply failed, roll back.
  const first = h.undo(d)
  assert.ok(first)
  assert.equal(h.depth(), 1, 'the pop really did move the group')
  assert.equal(h.rollbackReplay(), true, 'rollbackReplay must report that it restored something')
  assert.equal(h.depth(), 2, 'the group must be back on the undo stack')
  // ONE-SHOT: an immediate second call has nothing pending.
  assert.equal(h.rollbackReplay(), false, 'a second rollback with nothing pending must be a no-op')

  // The very next undo returns the SAME transaction (the pointer was
  // restored too — without that, `lastKnownRevision` was one ahead of the
  // document and this returned null).
  const retry = h.undo(d)
  assert.ok(retry, 'the retried undo must not be null')
  assert.deepEqual(retry, first, 'the retried undo must be the identical transaction')
  d = applySourceTransaction(d, retry).doc
  assert.equal(d.text, 'aXb\n')

  // …and redo still works afterwards, i.e. the roll-back/retry pair left the
  // opposite stack consistent.
  const redone = h.redo(d)
  assert.ok(redone, 'redo after a rolled-back undo must not be null')
  d = applySourceTransaction(d, redone).doc
  assert.equal(d.text, 'aXYb\n')

  // A real commit disarms whatever the last replay armed: the group the
  // redo above moved must NOT be rewindable once new bytes exist on top of
  // it (that would resurrect a group the redo stack no longer owns).
  const forward = { baseRevision: d.revision, from: 1, to: 1, insert: 'Z', intent: 'split-block' }
  const committed = applySourceTransaction(d, forward)
  assert.equal(committed.ok, true)
  h.record(committed, forward)
  d = committed.doc
  assert.equal(h.rollbackReplay(), false, 'record() must disarm a pending rollback')
}

console.log('PASS source-kernel history (CRLF chokepoint: inverses stay appliable, refusals never freeze the stack)')
