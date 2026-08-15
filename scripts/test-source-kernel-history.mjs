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
