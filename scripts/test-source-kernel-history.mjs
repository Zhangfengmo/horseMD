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

console.log('PASS source-kernel history')
