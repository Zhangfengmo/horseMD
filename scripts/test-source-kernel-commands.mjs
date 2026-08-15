import assert from 'node:assert/strict'
import { createMarkdownDocument, applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { buildSyntaxIndex } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { buildCharacterMap } from '../src/renderer/src/lib/source-kernel/character-map.js'
import { replaceVisibleText } from '../src/renderer/src/lib/source-kernel/commands/replace-text.js'
import { toggleTaskMarker } from '../src/renderer/src/lib/source-kernel/commands/task-toggle.js'
import { splitTextBlock, splitListItem, exitEmptyListItem } from '../src/renderer/src/lib/source-kernel/commands/enter.js'

const setup = (text, at) => {
  const doc = createMarkdownDocument(text)
  const index = buildSyntaxIndex(text)
  const block = index.blockAt(at)
  return { doc, index, map: buildCharacterMap(text, block.node) }
}

// 文本替换走转义感知边界；输入逐字进源码（不转义）
{
  const src = 'a\\*b\n'
  const { doc, map } = setup(src, 0)
  const r = replaceVisibleText({ doc, map, visFrom: 1, visTo: 2, insert: '*X*' })
  assert.equal(r.ok, true)
  const applied = applySourceTransaction(doc, r.transaction)
  assert.equal(applied.doc.text, 'a*X*b\n')   // \* 整体被覆盖，插入原样
}

// 未映射边界 fail-closed
{
  const src = 'a&#x1F600;b\n'
  const { doc, map } = setup(src, 0)
  assert.deepEqual(
    replaceVisibleText({ doc, map, visFrom: 2, visTo: 3, insert: 'x' }),
    { ok: false, code: 'unmapped-selection' }
  )
}

// 任务勾选：只动 3 个字符，[X] 大写也接受
{
  const src = '* [ ] 甲\n* [X] 乙\n\n尾\n'
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  const on = toggleTaskMarker({ doc, index, offset: src.indexOf('甲') })
  assert.equal(on.ok, true)
  assert.equal(applySourceTransaction(doc, on.transaction).doc.text,
    '* [x] 甲\n* [X] 乙\n\n尾\n')
  const off = toggleTaskMarker({ doc, index, offset: src.indexOf('乙') })
  assert.equal(applySourceTransaction(doc, off.transaction).doc.text,
    '* [ ] 甲\n* [ ] 乙\n\n尾\n')
  // 非任务项拒绝
  assert.equal(toggleTaskMarker({ doc, index, offset: src.indexOf('尾') }).code,
    'unsupported-structure')
}

console.log('PASS source-kernel commands (text + task)')

// ---- Task 5: Enter 命令族 ----

const apply = (doc, r) => {
  assert.equal(r.ok, true, r.code)
  return applySourceTransaction(doc, r.transaction).doc.text
}
const ctx = (text) => ({ doc: createMarkdownDocument(text), index: buildSyntaxIndex(text) })

// 段落中 Enter：拆成两段
{
  const src = '甲乙\n'
  const c = ctx(src)
  assert.equal(apply(c.doc, splitTextBlock({ ...c, offset: 1 })), '甲\n\n乙\n')
}
// 引用内段落 Enter：`> 锚\n>\n> 段`（对齐 test-quoted-block-source-ui 的期望）
{
  const src = '> 锚段\n'
  const c = ctx(src)
  assert.equal(apply(c.doc, splitTextBlock({ ...c, offset: src.indexOf('段') })),
    '> 锚\n>\n> 段\n')
}
// 标题中 Enter：后半成为段落（source-first，无新 marker）
{
  const src = '# 头尾\n'
  const c = ctx(src)
  assert.equal(apply(c.doc, splitTextBlock({ ...c, offset: src.indexOf('尾') })),
    '# 头\n\n尾\n')
}
// CRLF 文档沿用 CRLF
{
  const src = '甲乙\r\n'
  const c = ctx(src)
  assert.equal(apply(c.doc, splitTextBlock({ ...c, offset: 1 })), '甲\r\n\r\n乙\r\n')
}

// 列表非空项 Enter：沿用 marker 风格；有序 +1 不重排既有兄弟
{
  const src = '* 甲乙\n'
  const c = ctx(src)
  // offset 校正：brief 原文给的 offset:4 落在“乙”之后、换行符之前，会把整个
  // "甲乙" 都留在原项、新项变空（'* 甲乙\n* \n'）。要让 caret 落在“甲”“乙”之间
  // （对应期望输出 '* 甲\n* 乙\n' 的语义），offset 必须是 3：'*'=0,' '=1,'甲'=2,
  // '乙'=3,'\n'=4，text.slice(0,3)='* 甲'，text.slice(3)='乙\n'。
  assert.equal(apply(c.doc, splitListItem({ ...c, offset: 3 })), '* 甲\n* 乙\n')
}
{
  const src = '3) 甲乙\n7) 丙\n'
  const c = ctx(src)
  assert.equal(apply(c.doc, splitListItem({ ...c, offset: 4 })),
    '3) 甲\n4) 乙\n7) 丙\n')     // 只写 4)，7) 原样
}
// 任务项 Enter：新项未勾选，spacing 逐字沿用
{
  const src = '- [x] 甲乙\n'
  const c = ctx(src)
  assert.equal(apply(c.doc, splitListItem({ ...c, offset: 7 })),
    '- [x] 甲\n- [ ] 乙\n')
}
// 嵌套缩进沿用
{
  const src = '- 甲\n  - 乙丙\n'
  const c = ctx(src)
  assert.equal(apply(c.doc, splitListItem({ ...c, offset: src.indexOf('丙') })),
    '- 甲\n  - 乙\n  - 丙\n')
}

// 空项 Enter：删 marker 退出列表，留空行；引用前缀保留
{
  const src = '- 甲\n- \n'
  const c = ctx(src)
  // offset 校正：brief 原文给的 offset:7 等于 src.length，超出第二项
  // （空项 "- "，start 4 / end 6）的范围，listItemAt 找不到项，直接判
  // unsupported-structure。空项唯一的“项内”offset 是 marker 行末尾，即
  // item.end = 6（'-'=4,' '=5,'\n'=6）——退格/回车时 caret 实际停留的位置。
  assert.equal(apply(c.doc, exitEmptyListItem({ ...c, offset: 6 })), '- 甲\n\n')
}
{
  const src = '> * 甲\n> * \n'
  const c = ctx(src)
  // 同上校正：brief 原文的 offset:11 等于 src.length，落在第二项（start 8 /
  // end 10）范围之外；改用 item.end = 10（引用前缀 '> ' + marker 行 '* ' 之后）。
  assert.equal(apply(c.doc, exitEmptyListItem({ ...c, offset: 10 })), '> * 甲\n> \n')
}

console.log('PASS source-kernel commands (enter)')
