import assert from 'node:assert/strict'
import { createMarkdownDocument, applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { buildSyntaxIndex } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { buildCharacterMap } from '../src/renderer/src/lib/source-kernel/character-map.js'
import { replaceVisibleText } from '../src/renderer/src/lib/source-kernel/commands/replace-text.js'
import { toggleTaskMarker } from '../src/renderer/src/lib/source-kernel/commands/task-toggle.js'
import { splitTextBlock, splitListItem, exitEmptyListItem } from '../src/renderer/src/lib/source-kernel/commands/enter.js'
import { changeCodeLanguage } from '../src/renderer/src/lib/source-kernel/commands/code-language.js'

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

// ---- Task 5 fix-review regressions ----

// splitListItem must fail-closed when offset sits inside the marker/spacing
// region (before item.contentStart) — inserting a new marker there would
// tear the existing marker apart instead of producing a well-defined split.
// For '* 甲乙\n' ('*'=0,' '=1,'甲'=2,'乙'=3,'\n'=4) contentStart is 2.
{
  const src = '* 甲乙\n'
  const c = ctx(src)
  assert.deepEqual(splitListItem({ ...c, offset: 0 }),
    { ok: false, code: 'unsupported-structure' })   // offset 0: before the marker itself
  assert.deepEqual(splitListItem({ ...c, offset: 1 }),
    { ok: false, code: 'unsupported-structure' })   // offset 1: inside 'marker+spacing', still before content
}

// splitTextBlock must succeed when offset sits exactly at block.end (right
// after the last character, before the line terminator) — the ordinary
// "press Enter at end of line" position. index.blockAt is exclusive-end so
// a naive blockAt(offset) call would wrongly reject this as unsupported.
{
  // '甲乙\n': block.end === 2 (offset right after '乙', before '\n').
  // Splitting there yields an empty second paragraph: '甲乙' + blank line +
  // the original line terminator = '甲乙\n\n\n'.
  const src = '甲乙\n'
  const c = ctx(src)
  assert.equal(apply(c.doc, splitTextBlock({ ...c, offset: 2 })), '甲乙\n\n\n')
}
{
  // '# 头\n': block.end === 3 (offset right after '头'). Same shape as above,
  // an empty paragraph after the heading: '# 头\n\n\n'.
  const src = '# 头\n'
  const c = ctx(src)
  assert.equal(apply(c.doc, splitTextBlock({ ...c, offset: 3 })), '# 头\n\n\n')
}
// A blank-line GAP between two paragraphs must stay rejected: it is not any
// block's end (block1 '甲乙' ends at 2, block2 '丙' starts at 4), so the
// end-boundary recovery must not let it fall through to block1.
{
  const src = '甲乙\n\n丙\n'
  const c = ctx(src)
  assert.deepEqual(splitTextBlock({ ...c, offset: 3 }),
    { ok: false, code: 'unsupported-structure' })
}

// splitTextBlock must fail-closed inside a heading's `#{n} ` marker/spacing
// region — inserting the block-separator there tears the marker in two
// (offset 1 in '# 头\n' previously produced the mangled '#\n\n 头\n').
// contentStart for '# 头\n' is 2 (right after '# ', before '头').
{
  const src = '# 头\n'
  const c = ctx(src)
  assert.deepEqual(splitTextBlock({ ...c, offset: 0 }),
    { ok: false, code: 'unsupported-structure' })   // offset 0: before the '#' itself
  assert.deepEqual(splitTextBlock({ ...c, offset: 1 }),
    { ok: false, code: 'unsupported-structure' })   // offset 1: inside 'marker+spacing', still before content
  // A valid split right at contentStart (and further into the content) must
  // still work — regression guard for the guard above. Semantic note (Task 2,
  // plan 3): offset 2 IS the heading's content start, so this is now the
  // 段首 Enter branch — a blank line inserted ABOVE the intact '# 头' line
  // (caret shifts to raw 3, still right before '头') — not the old mid-split
  // that tore the heading into an empty '# ' heading plus a plain-paragraph
  // '头'. See the dedicated 段首 Enter block below for the byte derivation.
  assert.equal(apply(c.doc, splitTextBlock({ ...c, offset: 2 })), '\n# 头\n')
}

console.log('PASS source-kernel commands (enter)')

// ---- Task 2 (plan 3): splitTextBlock 抛光 — 段首 Enter · 连续 Enter ----
// Byte-authoritative: every string below was derived by actually running
// splitTextBlock/applySourceTransaction (see the task's oracle transcript),
// not guessed.

// 段首 Enter: caret at the block's visible content start inserts exactly ONE
// `ending` ABOVE the block (at the physical line start, never at `offset`),
// caret shifts by the inserted byte count so it stays anchored on the SAME
// original character. Replaces the old "ending+ending AT offset" behavior,
// which produced leading blank-byte accumulation with the caret left after
// the separator instead of on the text.
{
  const src = '甲乙\n'
  const c = ctx(src)
  assert.equal(apply(c.doc, splitTextBlock({ ...c, offset: 0 })), '\n甲乙\n')
  const r = splitTextBlock({ ...c, offset: 0 })
  assert.equal(r.transaction.selection.anchor, 1, 'caret raw 1: right before 甲, shifted by the 1 inserted byte')
}

// 段首 Enter inside a blockquote: the new blank line is itself a bare quote
// line ('>' with no trailing space, via bareQuote) so the blockquote is
// never broken — CommonMark tolerates a blank line WITHIN a blockquote.
{
  const src = '> 甲\n'
  const c = ctx(src)
  const offset = src.indexOf('甲')
  const r = splitTextBlock({ ...c, offset })
  assert.equal(r.ok, true)
  assert.equal(apply(c.doc, r), '>\n> 甲\n')
  assert.equal(r.transaction.selection.anchor, 4, 'caret raw 4: 甲 shifted by the 2 inserted bytes (">" + ending)')
}

// 段首 Enter mid-document: a paragraph preceded by another block gets one
// MORE blank line above it (not "leading blank accumulation" in any bad
// sense — every repeat is a legitimate extra blank line, caret always
// returns to the original text).
{
  const src = '甲\n\n乙\n'
  const c = ctx(src)
  const offset = src.indexOf('乙')
  assert.equal(apply(c.doc, splitTextBlock({ ...c, offset })), '甲\n\n\n乙\n')
}

// CRLF 段首 Enter: the inserted blank line reuses the document's own '\r\n'.
{
  const src = '甲乙\r\n'
  const c = ctx(src)
  assert.equal(apply(c.doc, splitTextBlock({ ...c, offset: 0 })), '\r\n甲乙\r\n')
}

// CRLF 段首 Enter inside a blockquote.
{
  const src = '> 甲\r\n'
  const c = ctx(src)
  const offset = src.indexOf('甲')
  assert.equal(apply(c.doc, splitTextBlock({ ...c, offset })), '>\r\n> 甲\r\n')
}

// Repeated 段首 Enter: each press adds one more blank line above, caret
// staying anchored on the original text every time (verified two presses
// deep, feeding the first press's own caret back in as the next offset —
// exactly how the live kernel-mode controller re-derives `offset` from the
// restored caret before routing the next keystroke).
{
  const src = '甲乙\n'
  const doc0 = createMarkdownDocument(src)
  const index0 = buildSyntaxIndex(src)
  const r1 = splitTextBlock({ doc: doc0, index: index0, offset: 0 })
  const applied1 = applySourceTransaction(doc0, r1.transaction)
  assert.equal(applied1.doc.text, '\n甲乙\n')
  const index1 = buildSyntaxIndex(applied1.doc.text)
  const r2 = splitTextBlock({ doc: applied1.doc, index: index1, offset: r1.transaction.selection.anchor })
  const applied2 = applySourceTransaction(applied1.doc, r2.transaction)
  assert.equal(applied2.doc.text, '\n\n甲乙\n')
  assert.equal(r2.transaction.selection.anchor, 2, 'caret still right before 甲')
}

// 块尾连续 Enter: the FIRST Enter at a block's end is unchanged (the existing
// degenerate-split branch, general/mid-offset path — inserts `ending+ending`
// at the block end). Enter pressed AGAIN at the resulting trailing raw
// offset (the exact spot editor-kernel-mode.js's ensureSplitPlaceholder
// anchors its virtual paragraph to) used to be refused (`resolveBlock`
// returns null there — no block claims a blank-line-run offset). It must now
// extend the blank-line run by exactly one more `ending`, reusing the line's
// own convention, so a THIRD/FOURTH… Enter keeps working identically.
{
  const src = '标题\n\n段落\n'
  let doc = createMarkdownDocument(src)
  let offset = src.indexOf('段落') + '段落'.length // block.end of '段落'
  const expected = [
    '标题\n\n段落\n\n\n',
    '标题\n\n段落\n\n\n\n',
    '标题\n\n段落\n\n\n\n\n'
  ]
  for (let i = 0; i < 3; i += 1) {
    const index = buildSyntaxIndex(doc.text)
    const r = splitTextBlock({ doc, index, offset })
    assert.equal(r.ok, true, `enter #${i + 1} must not be refused`)
    const applied = applySourceTransaction(doc, r.transaction)
    assert.equal(applied.doc.text, expected[i], `enter #${i + 1} byte state`)
    doc = applied.doc
    offset = r.transaction.selection.anchor
  }
}

// 块尾连续 Enter must NOT swallow a genuine mid-document blank-line GAP
// between two real blocks — the existing regression this file already locks
// (line ~176 above) stays true with the new fallback branch in place: a gap
// offset that has a REAL block starting somewhere after it is never treated
// as a "trailing" run.
{
  const src = '甲乙\n\n丙\n'
  const c = ctx(src)
  assert.deepEqual(splitTextBlock({ ...c, offset: 3 }),
    { ok: false, code: 'unsupported-structure' })
}

console.log('PASS source-kernel commands (splitTextBlock polish: paragraph-start + repeated-enter)')

// ---- Task: final-review coverage gaps (`+` marker, lone-CR ending) ----

// (a) '+' bullet marker was never exercised by any suite. Same mid-content
// split shape as the '*'/'-' cases above.
{
  const src = '+ 甲乙\n'
  const c = ctx(src)
  // '+'=0,' '=1,'甲'=2,'乙'=3,'\n'=4 — offset 3 splits between '甲' and '乙'.
  assert.equal(apply(c.doc, splitListItem({ ...c, offset: 3 })), '+ 甲\n+ 乙\n')
}

// (b) lone-CR ('\r', no '\n') line ending. remark treats a lone '\r' the same
// as any other line ending for a *soft break inside a paragraph*: '甲乙\r丙\r'
// parses as ONE paragraph block spanning both physical lines (verified with a
// direct probe against buildSyntaxIndex — the tree has a single top-level
// paragraph node covering the whole '甲乙\r丙' text), not two separate
// blocks. So this fixture exercises splitTextBlock's line-ending lookup
// (`endingAt` → `index.lineAt(offset).ending`) rather than block boundaries:
// splitting mid-paragraph, right at the lone-CR line break, must reuse '\r'
// (not '\n') as the inserted block separator.
{
  const src = '甲乙\r丙\r'
  const c = ctx(src)
  assert.equal(c.index.lineAt(2).ending, '\r') // scanLines-level: confirms the fixture actually has a lone-CR ending
  assert.equal(apply(c.doc, splitTextBlock({ ...c, offset: 2 })), '甲乙\r\r\r丙\r')
}

console.log('PASS source-kernel commands (splitTextBlock final-review coverage gaps)')

// ---- Plan 3 Task 4: changeCodeLanguage ----
//
// src = '```js\nabc\n```\n'
// ` 0 ` 1 ` 2 j 3 s 4 \n 5 | a 6 b 7 c 8 \n 9 | ` 10 ` 11 ` 12 \n 13
// open fence line "```js" [0,5); marker "```" [0,3); info segment "js" [3,5).

// Case A: plain top-level fence, language change with all three selection
// clamp branches ("before the removed info segment" / "inside it" / "at or
// after the line's own end").
{
  const src = '```js\nabc\n```\n'
  const c = ctx(src)
  // (a) offset inside the code CONTENT ('b' at 7) — the common case, past
  // the whole info segment: shifted by the edit's delta (+4, 'python' vs 'js').
  {
    const r = changeCodeLanguage({ ...c, offset: 7, language: 'python' })
    assert.equal(r.ok, true)
    assert.equal(r.transaction.from, 3)
    assert.equal(r.transaction.to, 5)
    assert.equal(r.transaction.insert, 'python')
    assert.equal(applySourceTransaction(c.doc, r.transaction).doc.text, '```python\nabc\n```\n')
    assert.deepEqual(r.transaction.selection, { anchor: 11, head: 11 })
  }
  // (b) offset BEFORE the marker's own end (0, the very start of the fence)
  // — unaffected by the edit, unchanged.
  {
    const r = changeCodeLanguage({ ...c, offset: 0, language: 'python' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.transaction.selection, { anchor: 0, head: 0 })
  }
  // (c) offset INSIDE the removed info segment (4, between 'j' and 's') —
  // that exact spot no longer exists; clamps to right after the new token.
  {
    const r = changeCodeLanguage({ ...c, offset: 4, language: 'python' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.transaction.selection, { anchor: 3 + 'python'.length, head: 3 + 'python'.length })
  }
}

// Case B: blockquote-prefixed fence — the marker/info region sits AFTER the
// '> ' prefix (remark's own node.position.start.offset convention, same one
// buildCodeMap relies on); the prefix itself must never be touched.
// src = '> ```js\n> abc\n> ```\n'
// '> ' 0-1 '```js' 2-6 \n 7 | '> ' 8-9 'abc' 10-12 \n 13 | '> ' 14-15 '```' 16-18 \n 19
{
  const src = '> ```js\n> abc\n> ```\n'
  const c = ctx(src)
  const r = changeCodeLanguage({ ...c, offset: 10, language: '' }) // remove language
  assert.equal(r.ok, true)
  assert.equal(r.transaction.from, 5)
  assert.equal(r.transaction.to, 7)
  assert.equal(r.transaction.insert, '')
  assert.equal(applySourceTransaction(c.doc, r.transaction).doc.text, '> ```\n> abc\n> ```\n')
  assert.deepEqual(r.transaction.selection, { anchor: 8, head: 8 }) // 10 shifted by delta -2
}

// Case C: tilde fence.
// src = '~~~js\nabc\n~~~\n' — identical layout to Case A, tilde marker.
{
  const src = '~~~js\nabc\n~~~\n'
  const c = ctx(src)
  const r = changeCodeLanguage({ ...c, offset: 7, language: 'python' })
  assert.equal(r.ok, true)
  assert.equal(applySourceTransaction(c.doc, r.transaction).doc.text, '~~~python\nabc\n~~~\n')
}

// Case D: CRLF fence — line boundaries (marker/info-segment end) must land
// on the CONTENT end, never inside the '\r\n' terminator.
// src = '```js\r\nabc\r\n```\r\n'
// ` 0 ` 1 ` 2 j 3 s 4 \r 5 \n 6 | a 7 b 8 c 9 \r 10 \n 11 | ...
{
  const src = '```js\r\nabc\r\n```\r\n'
  const c = ctx(src)
  const r = changeCodeLanguage({ ...c, offset: 7, language: 'jsx' })
  assert.equal(r.ok, true)
  assert.equal(r.transaction.from, 3)
  assert.equal(r.transaction.to, 5)
  assert.equal(applySourceTransaction(c.doc, r.transaction).doc.text, '```jsx\r\nabc\r\n```\r\n')
  assert.deepEqual(r.transaction.selection, { anchor: 8, head: 8 }) // 7 + delta(+1, 'jsx' vs 'js')
}

// Case E: bare fence (no language) -> add one. info segment is EMPTY
// (markerEnd === infoEnd), insert lands there untouched.
// src = '```\nabc\n```\n' — marker [0,3), info segment [3,3) (empty).
{
  const src = '```\nabc\n```\n'
  const c = ctx(src)
  const r = changeCodeLanguage({ ...c, offset: 4, language: 'js' })
  assert.equal(r.ok, true)
  assert.equal(r.transaction.from, 3)
  assert.equal(r.transaction.to, 3)
  assert.equal(r.transaction.insert, 'js')
  assert.equal(applySourceTransaction(c.doc, r.transaction).doc.text, '```js\nabc\n```\n')
}

// Case F: language containing whitespace -> reject (GFM info string can't
// round-trip a multi-token "language" through a single lang field).
{
  const src = '```js\nabc\n```\n'
  const c = ctx(src)
  assert.deepEqual(changeCodeLanguage({ ...c, offset: 7, language: 'js ts' }),
    { ok: false, code: 'unsupported-structure' })
}

// Case G: offset outside any code block (a plain paragraph) -> reject.
{
  const src = '甲乙\n\n```js\nabc\n```\n'
  const c = ctx(src)
  assert.deepEqual(changeCodeLanguage({ ...c, offset: 0, language: 'js' }),
    { ok: false, code: 'unsupported-structure' })
}

console.log('PASS source-kernel commands (changeCodeLanguage)')
