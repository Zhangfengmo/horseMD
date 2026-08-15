import assert from 'node:assert/strict'
import {
  createMarkdownDocument,
  applySourceTransaction
} from '../src/renderer/src/lib/source-kernel/markdown-document.js'

const doc = createMarkdownDocument('# 标题\n\n段落\n')
assert.equal(doc.revision, 0)

// 单编辑简写：在"段落"后插入文本
let r = applySourceTransaction(doc, {
  baseRevision: 0, from: 8, to: 8, insert: '甲', intent: 'insert-text'
})
assert.equal(r.ok, true)
assert.equal(r.doc.text, '# 标题\n\n段落甲\n')
assert.equal(r.doc.revision, 1)
assert.deepEqual(r.selection, { anchor: 9, head: 9 })

// 过期 revision 必须拒绝且不产生新文档
const stale = applySourceTransaction(doc, { baseRevision: 5, from: 0, to: 0, insert: 'x' })
assert.deepEqual(stale, { ok: false, code: 'stale-revision' })

// 非法范围
assert.deepEqual(
  applySourceTransaction(doc, { baseRevision: 0, from: 3, to: 2, insert: '' }),
  { ok: false, code: 'invalid-range' }
)
assert.deepEqual(
  applySourceTransaction(doc, { baseRevision: 0, from: 0, to: 999, insert: '' }),
  { ok: false, code: 'invalid-range' }
)

// 多编辑：升序、不重叠、一次 revision 递增；逆事务可还原到逐字节相同
const multi = applySourceTransaction(doc, {
  baseRevision: 0,
  edits: [
    { from: 0, to: 1, insert: '##' },   // '#' -> '##'
    { from: 6, to: 8, insert: 'AB' }    // '段落' -> 'AB'
  ],
  intent: 'test-multi'
})
assert.equal(multi.ok, true)
assert.equal(multi.doc.text, '## 标题\n\nAB\n')
assert.equal(multi.doc.revision, 1)
assert.deepEqual(multi.selection, { anchor: 9, head: 9 })
const undo = applySourceTransaction(multi.doc, multi.inverse)
assert.equal(undo.ok, true)
assert.equal(undo.doc.text, doc.text)

// 重叠 edits 拒绝
assert.deepEqual(
  applySourceTransaction(doc, {
    baseRevision: 0,
    edits: [{ from: 0, to: 2, insert: '' }, { from: 1, to: 3, insert: '' }]
  }),
  { ok: false, code: 'invalid-range' }
)

// 降序 edits（非递增）拒绝
assert.deepEqual(
  applySourceTransaction(doc, {
    baseRevision: 0,
    edits: [{ from: 5, to: 7, insert: '' }, { from: 1, to: 3, insert: '' }]
  }),
  { ok: false, code: 'invalid-range' }
)

console.log('PASS source-kernel document')
