import assert from 'node:assert/strict'
import { createMarkdownDocument, applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { buildSyntaxIndex } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { indentListItem, outdentListItem } from '../src/renderer/src/lib/source-kernel/commands/indent.js'

const run = (src, offset, fn) => {
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  const r = fn({ doc, index, offset })
  if (!r.ok) return r
  return applySourceTransaction(doc, r.transaction).doc.text
}

// bullet 缩进：`- ` 宽 2 → 2 空格
assert.equal(run('- 甲\n- 乙\n', 6, indentListItem), '- 甲\n  - 乙\n')
// 有序 marker `10. ` 宽 4 → 4 空格
assert.equal(run('10. 甲\n11. 乙\n', 8, indentListItem), '10. 甲\n    11. 乙\n')
// 首项无前兄弟 → 拒绝
assert.equal(run('- 甲\n', 2, indentListItem).code, 'unsupported-structure')
// 子树整体随动（子行同加前缀），一个事务
{
  const src = '- 甲\n- 乙\n  - 丙\n'
  assert.equal(run(src, 6, indentListItem), '- 甲\n  - 乙\n    - 丙\n')
}
// 引用内缩进：前缀之后加
assert.equal(run('> - 甲\n> - 乙\n', 10, indentListItem), '> - 甲\n>   - 乙\n')

// 反缩进
assert.equal(run('- 甲\n  - 乙\n', 8, outdentListItem), '- 甲\n- 乙\n')
// 顶层反缩进 → 拒绝
assert.equal(run('- 甲\n', 2, outdentListItem).code, 'unsupported-structure')
// 子树随动
{
  const src = '- 甲\n  - 乙\n    - 丙\n'
  assert.equal(run(src, src.indexOf('乙'), outdentListItem),
    '- 甲\n- 乙\n  - 丙\n')
}

console.log('PASS source-kernel indent')
