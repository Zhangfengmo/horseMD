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
// 有序 marker `10. ` 宽 4 → 4 空格。REWRITTEN 2026-08-20: this used to assert the
// BYTES `10. 甲\n    11. 乙\n` and never asked what they reparse to — they
// reparse to ONE paragraph, `甲\n11. 乙`, because an ordered list can only
// interrupt a paragraph when its number is 1. So the "working" ordered indent
// was silently merging the two items, and the reparse proof added with the
// empty-item fix refuses it. Making it WORK means renumbering the nested marker
// to `1.`, which is its own task (named in the report); until then it fails
// closed instead of corrupting.
assert.equal(run('10. 甲\n11. 乙\n', 8, indentListItem).code, 'would-restructure-document')
{
  const merged = buildSyntaxIndex('10. 甲\n    11. 乙\n').tree
  const paras = []
  const dec = (n) => (n.value !== undefined ? String(n.value) : (n.children || []).map(dec).join(''))
  const walk = (n) => { if (n.type === 'paragraph') paras.push(dec(n)); for (const c of n.children || []) walk(c) }
  walk(merged)
  assert.deepEqual(paras, ['甲\n11. 乙'],
    'the refused bytes really do merge the two items into one paragraph')
}
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

// Regression: joinParagraphBackward / the Delete branch must never join
// across a list-item boundary. blockAt treats a list item's own paragraph
// child the same as a top-level paragraph, so without an explicit
// listItemAt-based guard both directions can splice unrelated prose into a
// list item as a lazy continuation line — a silent, wrong structural edit
// (code review finding, both repros confirmed against the pre-fix code
// before the guards were added).
{
  // Repro A (Backspace): 乙 sits right after a list ('- x'); caret at 乙's
  // start must NOT merge it into the list item's paragraph as a lazy
  // continuation line.
  const src = '甲\n\n- x\n\n乙\n'
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  const offset = src.indexOf('乙')
  assert.equal(
    routeStructuralKey('Backspace', { doc, index, offset }).code,
    'unsupported-structure'
  )
  assert.equal(
    joinParagraphBackward({ doc, index, offset }).code,
    'unsupported-structure'
  )
}
{
  // Repro B (Delete): caret at the end of a list item's own text ('甲'); the
  // next paragraph ('乙') must NOT be absorbed into the item.
  const src = '- 甲\n\n乙\n'
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  const offset = src.indexOf('甲') + 1 // right after "甲", == the item's block.end
  assert.equal(
    routeStructuralKey('Delete', { doc, index, offset }).code,
    'not-structural'
  )
}
{
  // Positive control: an ordinary paragraph-into-paragraph join with a list
  // elsewhere in the document (not adjacent to the join point) must still
  // succeed — the list-item guard must not become a blanket "any list
  // anywhere in the doc" rejection.
  const src = '- x\n\n甲\n\n乙\n'
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  const offset = src.indexOf('乙')
  const r = routeStructuralKey('Backspace', { doc, index, offset })
  assert.equal(r.ok, true)
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text, '- x\n\n甲\n乙\n')
}

// ===========================================================================
// THE PROOF INDENT DID NOT HAVE (2026-08-20) — a user report with before/after
// screenshots, reproduced on the first attempt through the app's own gestures.
// ===========================================================================
// Tab in an EMPTY last list item wrote `  - ` on its own line. Those bytes are
// individually legal and there was NO reparse behind this command — the only
// structural family in the kernel without one — so nothing noticed that
// CommonMark reads that line as a SETEXT HEADING UNDERLINE rather than a nested
// item: an empty list item cannot interrupt a paragraph. The previous item
// silently became an empty paragraph plus an `<h2>` carrying its words, rendered
// big and bold outside the list.
//
// The user's list had two leading U+00A0 in that item, which made the report
// look NBSP-specific. It is not, and the control below is the load-bearing
// half of that claim: the identical corruption happens on plain text.
{
  // THE REPORTED SHAPE — refused now, with a code of its own so the toast can
  // say what actually happened.
  const src = '- 12312\n- 123213\n- '
  const refusal = run(src, src.length, indentListItem)
  assert.equal(refusal.ok, false, 'indenting an empty item must not commit')
  assert.equal(refusal.code, 'empty-item-would-become-heading',
    'and must name the cause, so the toast can offer the remedy')

  // ...and the bytes it would have written really do reparse to a heading —
  // asserted here so the refusal is pinned to a real hazard rather than to a
  // guess about one.
  const wouldHaveWritten = '- 12312\n- 123213\n  - '
  const tree = buildSyntaxIndex(wouldHaveWritten).tree
  const types = []
  const walk = (n) => { if (n.type !== 'root') types.push(n.type); for (const c of n.children || []) walk(c) }
  walk(tree)
  assert.ok(types.includes('heading'),
    `the refused bytes must be the ones that produce a heading — got ${types.join(',')}`)
}
{
  // THE NBSP CONTROL: same refusal, same reason, with the user's own U+00A0
  // run present. The whitespace family is not implicated.
  const NB = '\u00a0'
  const src = '- 12312\n- ' + NB + NB + '123213\n- '
  assert.equal(run(src, src.length, indentListItem).code, 'empty-item-would-become-heading')
}
{
  // THE EMPTY ITEM IS NOT THE LAST ONE — same hazard, same refusal.
  const src = '- 甲\n- 乙\n- \n- 丁\n'
  assert.equal(run(src, src.indexOf('- \n- 丁') + 2, indentListItem).code, 'empty-item-would-become-heading')
}

// ===========================================================================
// ...AND THE PROOF MUST NOT REFUSE WHAT ALWAYS WORKED. Each of these is a shape
// the user or the suite exercises daily; if the invariant were stated over raw
// bytes (which legitimately change) instead of decoded leaf blocks (which do
// not), every one of them would start refusing.
// ===========================================================================
{
  const NB = '\u00a0'
  // A NON-EMPTY item indents — the escape hatch the refusal message names.
  assert.equal(run('- 12312\n- 123213\n- x', 20, indentListItem), '- 12312\n- 123213\n  - x')
  // The current item carries the U+00A0 run.
  const cur = '- 甲\n- ' + NB + NB + '乙\n'
  assert.equal(run(cur, cur.indexOf('乙'), indentListItem), '- 甲\n  - ' + NB + NB + '乙\n')
  // The PREVIOUS sibling carries it — the report's own suspicion, which the
  // arithmetic handles because U+00A0 is content, not indentation.
  const sib = '- ' + NB + NB + '甲\n- 乙\n'
  assert.equal(run(sib, sib.indexOf('乙'), indentListItem), '- ' + NB + NB + '甲\n  - 乙\n')
  // The PREVIOUS item is empty and the current one carries the run.
  const prevEmpty = '- 甲\n- \n- ' + NB + NB + '丙\n'
  assert.equal(run(prevEmpty, prevEmpty.indexOf('丙'), indentListItem),
    '- 甲\n- \n  - ' + NB + NB + '丙\n')
  // OUTDENT beside a U+00A0 sibling, and outdent generally.
  const out = '- 甲\n- ' + NB + '乙\n  - 丙\n'
  assert.equal(run(out, out.indexOf('丙'), outdentListItem), '- 甲\n- ' + NB + '乙\n- 丙\n')
  assert.equal(run('- 甲\n  - 乙\n  - 丙\n', 12, outdentListItem), '- 甲\n  - 乙\n- 丙\n')
  // Subtree carry-along still moves as one transaction.
  assert.equal(run('- 甲\n- 乙\n  - 丙\n', 6, indentListItem), '- 甲\n  - 乙\n    - 丙\n')
}

console.log('PASS source-kernel delete + router (list-boundary guard)')
