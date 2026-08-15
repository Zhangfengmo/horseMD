import assert from 'node:assert/strict'
import { createMarkdownDocument, applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { buildSyntaxIndex } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { indentListItem, outdentListItem } from '../src/renderer/src/lib/source-kernel/commands/indent.js'
import { liftEmptyListItem, joinParagraphBackward } from '../src/renderer/src/lib/source-kernel/commands/delete.js'
import { routeStructuralKey } from '../src/renderer/src/lib/source-kernel/router.js'

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

// Caret math regression: an item that owns MORE THAN ONE line (a marker
// line plus a wrapped/continuation line) must shift the caret by the SUM of
// every edit at-or-before it, not just the one edit on its own line. A flat
// single delta under-counted every edit before the marker line's own.
{
  const src = '- 甲\n- 乙 line one\n  line two continued\n'
  const offset = src.indexOf('two')
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  const r = indentListItem({ doc, index, offset })
  assert.equal(r.ok, true)
  const applied = applySourceTransaction(doc, r.transaction)
  assert.equal(applied.doc.text, '- 甲\n  - 乙 line one\n    line two continued\n')
  assert.equal(applied.selection.anchor, applied.doc.text.indexOf('two'))
  assert.equal(applied.selection.head, applied.doc.text.indexOf('two'))
}
{
  // Symmetric outdent counterpart: outdenting the indented doc above back to
  // its original form must land the caret on "two" in the OUTDENTED text.
  const src = '- 甲\n  - 乙 line one\n    line two continued\n'
  const offset = src.indexOf('two')
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  const r = outdentListItem({ doc, index, offset })
  assert.equal(r.ok, true)
  const applied = applySourceTransaction(doc, r.transaction)
  assert.equal(applied.doc.text, '- 甲\n- 乙 line one\n  line two continued\n')
  assert.equal(applied.selection.anchor, applied.doc.text.indexOf('two'))
  assert.equal(applied.selection.head, applied.doc.text.indexOf('two'))
}

console.log('PASS source-kernel indent')

// ---------------------------------------------------------------------------
// Task 7: Backspace/Delete 命令 + 结构路由
// ---------------------------------------------------------------------------

// 空项 Backspace：嵌套先反缩进一级，顶层退出列表。
// Note: the brief's original nested fixture ('- 甲\n  - \n') doesn't actually
// parse as a nested empty list item — remark reads the second line as a
// Setext-heading underline for the paragraph "甲" (a bare '-' line, up to 3
// leading spaces, is valid CommonMark setext syntax), collapsing the whole
// thing into one top-level item containing a heading, with no nested list at
// all. A non-empty nested sibling first ('- 甲\n  - 乙\n  - \n') avoids both
// that trap and the "an empty list item cannot interrupt a paragraph" rule
// (which would otherwise fold a bare '  - ' line straight after "甲" into a
// lazy continuation of its paragraph instead of a new list item).
assert.equal(
  run('- 甲\n  - 乙\n  - \n', 14, liftEmptyListItem),
  '- 甲\n  - 乙\n- \n'
)
// Top-level: the brief's offset (7) was one past the item's actual end (the
// trailing marker-line space is already absorbed into `spacing`, so the
// item's caret-in position is 6, not 7 — verified against buildSyntaxIndex's
// actual output, not hand-derived).
assert.equal(run('- 甲\n- \n', 6, liftEmptyListItem), '- 甲\n\n')

// 段落回删合并：普通 + 引用；标题边界拒绝。
assert.equal(run('甲\n\n乙\n', 3, joinParagraphBackward), '甲\n乙\n')
// The brief's offset (10) is the empty EOF line past the closing '\n' — not
// inside any block, so blockAt(10) is null and the call would reject before
// even reaching the join logic. offset 8 is the actual start of the second
// paragraph ("乙", right after "> ") inside the blockquote.
assert.equal(
  run('> 甲\n>\n> 乙\n', 8, joinParagraphBackward),
  '> 甲\n> 乙\n'
)
assert.equal(run('# 头\n\n乙\n', 5, joinParagraphBackward).code, 'unsupported-structure')

// 路由决策表
{
  const src = '- 甲乙\n'
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  assert.equal(routeStructuralKey('Enter', { doc, index, offset: 4 }).ok, true)
  assert.equal(routeStructuralKey('Tab', { doc, index, offset: 4 }).code,
    'unsupported-structure')  // 无前兄弟
  assert.equal(
    routeStructuralKey('Backspace', { doc, index, offset: 4 }).code,
    'not-structural')          // 项中字符删除走文本路径
}
{
  const src = '段甲\n'
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  assert.equal(routeStructuralKey('Tab', { doc, index, offset: 1 }).code, 'not-structural')
}

// Delete 分支：段落尾 + 下一块是段落 → 委托 join 逻辑（对称于 Backspace 段落
// 首）；段落尾但没有下一个块（文档末尾）→ not-structural。The brief's sketch
// probed `block.end + 1` / `block.end + 2` as fixed-width gap guesses, which
// breaks for any wider gap (e.g. a blockquote's blank `>` line, 5+ chars) —
// replaced with a linear forward scan (mirrors joinParagraphBackward's own
// backward scan) that finds the next block regardless of gap width. Also:
// resolveBlock (not blockAt) is required to resolve the CURRENT block at
// offset === block.end, since blockAt alone is exclusive-end and returns null
// exactly at that boundary.
{
  const src = '甲\n\n乙\n'
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  const r = routeStructuralKey('Delete', { doc, index, offset: 1 })
  assert.equal(r.ok, true)
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text, '甲\n乙\n')
}
{
  const src = '段甲\n'
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  assert.equal(routeStructuralKey('Delete', { doc, index, offset: 2 }).code, 'not-structural')
}

console.log('PASS source-kernel delete + router')
