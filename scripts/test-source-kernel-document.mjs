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

// 逆事务的 selection 必须是逆事务自身的 caret（相对"撤销后"文档），不能照搬
// 正向事务的 selection —— 正向 selection 是相对"插入后"（更长）文档的坐标，
// 对撤销后的（更短）文档可能越界。
// probe: 在 'ab\n' 的 offset 1 插入 'XYZ'，显式正向 selection {anchor:4}
// 落在插入后 6 字符文档 'aXYZb\n' 内；若逆事务照搬这个 selection，撤销后的
// 3 字符文档 'ab\n' 就会带着越界的 anchor:4。
{
  const base = createMarkdownDocument('ab\n')
  const r = applySourceTransaction(base, {
    baseRevision: 0, from: 1, to: 1, insert: 'XYZ', intent: 'insert-text',
    selection: { anchor: 4, head: 4 }
  })
  assert.equal(r.ok, true)
  assert.equal(r.doc.text, 'aXYZb\n')
  assert.deepEqual(r.selection, { anchor: 4, head: 4 }) // 正向 selection 原样透传

  // 手工推导：逆事务的编辑是 {from:1, to:4, insert:''}（删掉刚插入的 'XYZ'）；
  // trailingCaret = last.to + delta = 4 + (0 - (4-1)) = 4 - 3 = 1。
  assert.deepEqual(r.inverse.edits, [{ from: 1, to: 4, insert: '' }])
  assert.deepEqual(r.inverse.selection, { anchor: 1, head: 1 })

  const undone = applySourceTransaction(r.doc, r.inverse)
  assert.equal(undone.ok, true)
  assert.equal(undone.doc.text, 'ab\n')
  // 应用逆事务后得到的 selection 必须落在还原后的 3 字符文档范围内。
  assert.ok(undone.selection.anchor <= undone.doc.text.length &&
    undone.selection.head <= undone.doc.text.length,
    'inverse selection must stay within the restored document bounds')
  assert.deepEqual(undone.selection, { anchor: 1, head: 1 })
}

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
