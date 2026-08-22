import assert from 'node:assert/strict'
import { createMarkdownDocument, applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { buildSyntaxIndex } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { buildCharacterMap } from '../src/renderer/src/lib/source-kernel/character-map.js'
import { replaceVisibleText } from '../src/renderer/src/lib/source-kernel/commands/replace-text.js'
import { toggleTaskMarker } from '../src/renderer/src/lib/source-kernel/commands/task-toggle.js'
import { splitTextBlock, splitListItem, exitEmptyListItem } from '../src/renderer/src/lib/source-kernel/commands/enter.js'
import { changeCodeLanguage } from '../src/renderer/src/lib/source-kernel/commands/code-language.js'
import { setImageAttrs } from '../src/renderer/src/lib/source-kernel/commands/image-attrs.js'
import { toggleInlineMark } from '../src/renderer/src/lib/source-kernel/commands/mark-toggle.js'
import { applyLinkEdit } from '../src/renderer/src/lib/source-kernel/commands/link-toggle.js'
import { joinParagraphBackward } from '../src/renderer/src/lib/source-kernel/commands/delete.js'
import { deleteEmptyCodeBlock } from '../src/renderer/src/lib/source-kernel/commands/code-exit.js'
import { routeStructuralKey } from '../src/renderer/src/lib/source-kernel/router.js'
import { markerFor } from '../src/renderer/src/lib/source-kernel/mark-map.js'

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

// Case H (final-review finding, 2026-08-16; SCOPE CORRECTED 2026-08-16 after
// re-review — see the correction note in final-fix-report.md): fence-marker
// fail-closed guard, BACKTICK FENCES ONLY. A backtick in a language
// committed onto a BACKTICK fence provably breaks the fence — verified
// against the real parser (remark-parse + remark-gfm): '```js`ts\nabc\n```\n'
// reparses as a paragraph followed by an unrelated EMPTY code block, not a
// 'js`ts'-language fence over 'abc'. Must reject before ever producing those
// bytes. CommonMark places NO such restriction on tilde fences — see Case I.
{
  const src = '```js\nabc\n```\n'
  const c = ctx(src)
  assert.deepEqual(changeCodeLanguage({ ...c, offset: 7, language: 'js`ts' }),
    { ok: false, code: 'unsupported-structure' },
    'a backtick in the language must be refused on a backtick fence')
}

// Case I (SCOPE CORRECTED 2026-08-16): a tilde in a language committed onto
// a TILDE fence is VALID CommonMark and must be ACCEPTED, not refused — the
// original version of this case asserted rejection, which an independent
// re-review's own parse probe disproved: '~~~js~ts\nabc\n~~~\n' parses as
// ONE clean `code` node (lang 'js~ts'), byte-exact; even a language whose
// tilde run matches the fence's own length ('js~~ts' against a 3-tilde
// fence) still parses cleanly, because the closing-fence test is a separate
// whole-line rule the single-line info string never reaches. CommonMark's
// marker restriction is documented for BACKTICK fences only (Case H); this
// case now locks the tilde-fence side of that asymmetry instead of
// over-restricting it.
{
  const src = '~~~js\nabc\n~~~\n'
  const c = ctx(src)
  const r = changeCodeLanguage({ ...c, offset: 7, language: 'js~ts' })
  assert.equal(r.ok, true, 'a tilde in the language is valid CommonMark on a tilde fence, must be accepted')
  assert.equal(applySourceTransaction(c.doc, r.transaction).doc.text, '~~~js~ts\nabc\n~~~\n')
}

// Case J: the CROSS combinations are valid CommonMark and must stay allowed
// — verified against the real parser: both round-trip to the exact
// 'js~ts'/'js`ts' language over the same code content, byte-exact.
// (a) a tilde-containing language on a BACKTICK fence.
{
  const src = '```js\nabc\n```\n'
  const c = ctx(src)
  const r = changeCodeLanguage({ ...c, offset: 7, language: 'js~ts' })
  assert.equal(r.ok, true, 'a tilde in the language is valid CommonMark on a backtick fence')
  assert.equal(applySourceTransaction(c.doc, r.transaction).doc.text, '```js~ts\nabc\n```\n')
}
// (b) a backtick-containing language on a TILDE fence.
{
  const src = '~~~js\nabc\n~~~\n'
  const c = ctx(src)
  const r = changeCodeLanguage({ ...c, offset: 7, language: 'js`ts' })
  assert.equal(r.ok, true, 'a backtick in the language is valid CommonMark on a tilde fence')
  assert.equal(applySourceTransaction(c.doc, r.transaction).doc.text, '~~~js`ts\nabc\n~~~\n')
}

console.log('PASS source-kernel commands (changeCodeLanguage)')

// ---- Plan 3 Task 5: exitCodeBlock（Mod-Enter 退出代码块）----
import { exitCodeBlock } from '../src/renderer/src/lib/source-kernel/commands/code-exit.js'

// Exit A: 文档末尾（闭栅行带终止符）——插入 `ending+ending`，caret 锚在新的
// 文档末尾（trailing-virtual 机制的锚点）。
// src = '```js\nconst a = 1\n```\n'：闭栅行 [18,21)，insertPos = 22 = EOF。
{
  const src = '```js\nconst a = 1\n```\n'
  const c = ctx(src)
  const r = exitCodeBlock({ ...c, offset: 0 })
  assert.equal(r.ok, true)
  assert.equal(r.transaction.from, 22)
  assert.equal(r.transaction.to, 22)
  assert.equal(r.transaction.insert, '\n\n')
  assert.equal(r.transaction.intent, 'exit-code-block')
  assert.deepEqual(r.transaction.selection, { anchor: 24, head: 24 }) // new EOF
  assert.equal(applySourceTransaction(c.doc, r.transaction).doc.text,
    '```js\nconst a = 1\n```\n\n\n')
}

// Exit B: 文档末尾、闭栅行没有终止符（文件不以换行结尾）——第一个 ending
// 终结闭栅行，第二个成为空白行；caret 仍在新 EOF。
{
  const src = '```js\na\n```'
  const c = ctx(src)
  const r = exitCodeBlock({ ...c, offset: 6 })
  assert.equal(r.ok, true)
  assert.equal(r.transaction.from, 11)
  assert.equal(r.transaction.insert, '\n\n')
  assert.deepEqual(r.transaction.selection, { anchor: 13, head: 13 })
  assert.equal(applySourceTransaction(c.doc, r.transaction).doc.text, '```js\na\n```\n\n')
}

// Exit C: 文档中段——caret 锚在第一个空行行首（split-placeholder 锚点）；
// 其后输入 'x' 于该锚点得到 'x\n\nnext'：独立段落，验证行布局正确。
{
  const src = '```js\na\n```\nnext\n'
  const c = ctx(src)
  const r = exitCodeBlock({ ...c, offset: 0 })
  assert.equal(r.ok, true)
  assert.equal(r.transaction.from, 12)
  assert.equal(r.transaction.insert, '\n\n')
  assert.deepEqual(r.transaction.selection, { anchor: 12, head: 12 })
  const applied = applySourceTransaction(c.doc, r.transaction)
  assert.equal(applied.doc.text, '```js\na\n```\n\n\nnext\n')
  // 在锚点补一个字符（模拟占位段的第一次输入），布局必须解析为独立段落
  const typed = applySourceTransaction(applied.doc, {
    baseRevision: applied.doc.revision, from: 12, to: 12, insert: 'x', intent: 'insert-text'
  })
  assert.equal(typed.doc.text, '```js\na\n```\nx\n\nnext\n')
}

// Exit D: 引用内文档中段——插入 `prefix+E+bareQuote+E`，caret 在 prefix 之后。
// src = '> ```js\n> a\n> ```\n> more\n'：闭栅行 [12,17)，insertPos = 18。
{
  const src = '> ```js\n> a\n> ```\n> more\n'
  const c = ctx(src)
  const r = exitCodeBlock({ ...c, offset: 2 })
  assert.equal(r.ok, true)
  assert.equal(r.transaction.from, 18)
  assert.equal(r.transaction.insert, '> \n>\n')
  assert.deepEqual(r.transaction.selection, { anchor: 20, head: 20 })
  assert.equal(applySourceTransaction(c.doc, r.transaction).doc.text,
    '> ```js\n> a\n> ```\n> \n>\n> more\n')
}

// Exit E: CRLF 文档——闭栅行终止符沿用 '\r\n'；insertPos 在闭栅行终止符之后。
// src = '```js\r\na\r\n```\r\n'：'```'闭栅行 [10,13) ending '\r\n' → insertPos 15。
{
  const src = '```js\r\na\r\n```\r\n'
  const c = ctx(src)
  const r = exitCodeBlock({ ...c, offset: 0 })
  assert.equal(r.ok, true)
  assert.equal(r.transaction.from, 15)
  assert.equal(r.transaction.insert, '\r\n\r\n')
  assert.deepEqual(r.transaction.selection, { anchor: 19, head: 19 })
  assert.equal(applySourceTransaction(c.doc, r.transaction).doc.text,
    '```js\r\na\r\n```\r\n\r\n\r\n')
}

// Exit F: 未闭合栅栏——拒绝，不补栅、不写字节。
{
  const src = '```js\nabc'
  const c = ctx(src)
  assert.deepEqual(exitCodeBlock({ ...c, offset: 6 }), { ok: false, code: 'unsupported-structure' })
}
// Exit F2: 只有开栅行的未闭合空块。
{
  const src = '```\n'
  const c = ctx(src)
  assert.deepEqual(exitCodeBlock({ ...c, offset: 0 }), { ok: false, code: 'unsupported-structure' })
}

// Exit G: 波浪线栅栏 + 闭栅游程更长（合法闭栅）→ 接受；同字符校验。
{
  const src = '~~~js\na\n~~~~\nnext\n'
  const c = ctx(src)
  const r = exitCodeBlock({ ...c, offset: 0 })
  assert.equal(r.ok, true)
  assert.equal(r.transaction.from, 13)
}

// Exit H: 非代码块（段落 / math 块）→ 拒绝。
{
  const src = '甲乙\n\n$$\nx+y\n$$\n'
  const c = ctx(src)
  assert.deepEqual(exitCodeBlock({ ...c, offset: 0 }), { ok: false, code: 'unsupported-structure' })
  assert.deepEqual(exitCodeBlock({ ...c, offset: src.indexOf('$$') + 1 }),
    { ok: false, code: 'unsupported-structure' })
}

// Exit I: 列表缩进内的栅栏（前缀是纯缩进，非引用）→ 拒绝（fail-closed：空白
// 行会终结列表续行上下文）。
{
  const src = '- item\n\n  ```js\n  a\n  ```\n'
  const c = ctx(src)
  const at = src.indexOf('```')
  assert.deepEqual(exitCodeBlock({ ...c, offset: at }), { ok: false, code: 'unsupported-structure' })
}

// Exit J: 引用内、引用（及文档）到此为止 → 文档末尾分支：插入裸 ending 对，
// caret 在新 EOF（退出到顶层——trailing-virtual 给它顶层空段落的家）。
{
  const src = '> ```js\n> a\n> ```\n'
  const c = ctx(src)
  const r = exitCodeBlock({ ...c, offset: 2 })
  assert.equal(r.ok, true)
  assert.equal(r.transaction.from, 18)
  assert.equal(r.transaction.insert, '\n\n')
  assert.deepEqual(r.transaction.selection, { anchor: 20, head: 20 })
}

console.log('PASS source-kernel commands (exitCodeBlock)')

// ---- review fix (Plan 4 Task 2 code review): replaceVisibleText over
// already-marked content ----
//
// Live-probed corruption, not a mark-toggle-specific concern: ANY caller of
// `replaceVisibleText` (this generic command predates marks entirely) that
// resolves a selection sitting inside an existing strong/emphasis/delete
// node used to have its `from` silently swallow that mark's opening
// delimiter — `rawRangeForVisibleRange(2,6)` over 'a **bold** b\n' used to
// resolve to raw [2,8) ("**bold", markers-included-on-the-left, excluded-
// on-the-right) instead of [4,8) ("bold", content-only). Fixed centrally in
// character-map.js's `buildCharacterMap` (`rawStartForVisible`, a
// gap-aware mirror of the existing `visibleToRaw` boundary table — see its
// ADR comment) rather than locally in mark-toggle.js, since it is shared
// plumbing every `rawRangeForVisibleRange` consumer relies on.
{
  const src = 'a **bold** b\n'
  const { doc, map } = setup(src, src.indexOf('bold'))

  // Typing 'X' over the fully-selected word must land INSIDE the markers.
  const typed = replaceVisibleText({ doc, map, visFrom: 2, visTo: 6, insert: 'X' })
  assert.equal(typed.ok, true)
  assert.deepEqual(typed.transaction, {
    baseRevision: 0, from: 4, to: 8, insert: 'X', intent: 'insert-text',
    selection: { anchor: 5, head: 5 }
  })
  assert.equal(applySourceTransaction(doc, typed.transaction).doc.text, 'a **X** b\n')

  // Deleting the whole word (insert: ''): pinned decision — produce the
  // empty-marker bytes and stop there. `replaceVisibleText` has no mark
  // awareness (that is `toggleInlineMark`'s domain, a separate command) and
  // this task does not add any here; probed as byte-consistent and safe —
  // 'a **** b\n' reparses to a plain literal '****' text run (not a broken
  // node, not data loss), left for a later mode-level verify/reconcile pass
  // to clean up if ever desired.
  const deleted = replaceVisibleText({ doc, map, visFrom: 2, visTo: 6, insert: '' })
  assert.equal(deleted.ok, true)
  assert.equal(applySourceTransaction(doc, deleted.transaction).doc.text, 'a **** b\n')
}

console.log('PASS source-kernel commands (review fix: replaceVisibleText over marked content)')

// ---- final-review fix: zero-width replaceVisibleText at block end ----
//
// Kernel-mode Tab at a paragraph's end (editor-kernel-mode.js
// insertPlainTextAtSelection, routed here as visFrom===visTo===
// map.visibleLength) used to fail-closed with 'unmapped-selection' because
// character-map.js's `startBoundaries` table has no entry at
// `visibleLength` (nothing "starts" past the last unit). Pre-plan-4 this
// inserted a literal tab; the fix restores that by resolving a zero-width
// range through the insert-neutral resolver on both ends.
{
  const src = 'hello\n'
  const { doc, map } = setup(src, 0)
  const r = replaceVisibleText({ doc, map, visFrom: 5, visTo: 5, insert: '\t' })
  assert.equal(r.ok, true, r.code)
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text, 'hello\t\n')
}

console.log('PASS source-kernel commands (final-review: zero-width insert at block end)')

// ---- Task 2 (Plan 4): toggleInlineMark ----

// Test-only helpers that walk a character map's `units` directly to find the
// visible index that STARTS (resp. ENDS) at a given raw offset — mirrors
// character-map.js's own gap-aware `rawStartForVisible`/`rawRangeForVisibleRange`
// (see its ADR comment on `buildCharacterMap`) rather than `map.visibleToRaw`
// alone, which stays ambiguous on the `from` side whenever the target raw
// offset sits right after an existing mark's opening delimiter — using
// `visibleToRaw` here would make it impossible to even construct a realistic
// "select this already-marked word" visFrom in these tests.
const visStartFor = (map, raw) => {
  let v = 0
  for (const unit of map.units) {
    if (unit.rawStart === raw) return v
    v += unit.width
  }
  throw new Error(`no unit starts at raw ${raw}`)
}
const visEndFor = (map, raw) => {
  let v = 0
  for (const unit of map.units) {
    v += unit.width
    if (unit.rawEnd === raw) return v
  }
  throw new Error(`no unit ends at raw ${raw}`)
}

const blockSetup = (text, at) => {
  const doc = createMarkdownDocument(text)
  const index = buildSyntaxIndex(text)
  const block = index.blockAt(at)
  assert.ok(block, `no block at ${at} in ${JSON.stringify(text)}`)
  return { doc, index, map: buildCharacterMap(text, block.node) }
}

// Wrap `needle` inside `src` with `kind`, assert the exact byte result and
// selection, then unwrap it straight back from the wrapped text and assert
// round-trip back to `src`.
const wrapUnwrapRoundtrip = (kind, src, needle) => {
  const marker = markerFor(kind)
  const rawFrom = src.indexOf(needle)
  assert.ok(rawFrom >= 0, `fixture missing needle: ${needle}`)
  const rawTo = rawFrom + needle.length

  const { doc, index, map } = blockSetup(src, rawFrom)
  const visFrom = visStartFor(map, rawFrom)
  const visTo = visEndFor(map, rawTo)

  const wrap = toggleInlineMark({ doc, index, map, visFrom, visTo, kind })
  assert.equal(wrap.ok, true, `wrap(${kind}) failed: ${wrap.code}`)
  const wrapped = applySourceTransaction(doc, wrap.transaction)
  assert.equal(wrapped.ok, true)
  const expectedWrapped = src.slice(0, rawFrom) + marker + needle + marker + src.slice(rawTo)
  assert.equal(wrapped.doc.text, expectedWrapped, `wrap(${kind}) byte mismatch`)
  assert.deepEqual(wrap.transaction.selection, {
    anchor: rawFrom + marker.length,
    head: rawTo + marker.length
  }, `wrap(${kind}) selection mismatch`)

  // Round-trip: build fresh doc/index/map over the WRAPPED text and unwrap
  // straight back from the marked word (a realistic "select the rendered
  // bold word, click bold again" scenario). Since P4-3.5 inlineCode maps as
  // per-value-char units (no more atom), so its round-trip selection targets
  // the content-only bounds exactly like every other kind.
  const doc2 = createMarkdownDocument(expectedWrapped)
  const index2 = buildSyntaxIndex(expectedWrapped)
  const selFrom = rawFrom + marker.length
  const selTo = rawTo + marker.length
  const { map: map2 } = blockSetup(expectedWrapped, selFrom)
  const visFrom2 = visStartFor(map2, selFrom)
  const visTo2 = visEndFor(map2, selTo)

  const unwrap = toggleInlineMark({ doc: doc2, index: index2, map: map2, visFrom: visFrom2, visTo: visTo2, kind })
  assert.equal(unwrap.ok, true, `unwrap(${kind}) failed: ${unwrap.code}`)
  const restored = applySourceTransaction(doc2, unwrap.transaction)
  assert.equal(restored.ok, true)
  assert.equal(restored.doc.text, src, `unwrap(${kind}) did not round-trip`)
  assert.deepEqual(unwrap.transaction.selection, { anchor: rawFrom, head: rawTo },
    `unwrap(${kind}) selection mismatch`)
}

// Wrap + unwrap byte round-trip, one per mark kind.
wrapUnwrapRoundtrip('strong', 'a bold b\n', 'bold')
wrapUnwrapRoundtrip('emphasis', 'a ital b\n', 'ital')
wrapUnwrapRoundtrip('delete', 'a strike b\n', 'strike')
wrapUnwrapRoundtrip('inlineCode', 'a code b\n', 'code')
wrapUnwrapRoundtrip('highlight', 'a light b\n', 'light')

// Heading: the block's inline children start after "# ", so visible offset 0
// is NOT raw offset 0 — proves the command doesn't assume block.start===0.
wrapUnwrapRoundtrip('strong', '# a bold b\n', 'bold')

// Quoted paragraph: mdast positions inside a blockquote are already absolute
// raw offsets (no '>' prefix adjustment needed) — probed by mark-map.js.
wrapUnwrapRoundtrip('emphasis', '> a ital b\n', 'ital')

// CRLF document: line terminator never participates in the inline span.
wrapUnwrapRoundtrip('delete', 'a strike b\r\n', 'strike')

// Whitespace shrink: selecting " bold " (spaces included on both edges)
// shrinks to just "bold" before mapping — the outer spaces are untouched by
// either edit.
{
  const src = 'a bold b\n'
  const rawFrom = src.indexOf(' bold ')
  const rawTo = rawFrom + ' bold '.length
  const { doc, index, map } = blockSetup(src, rawFrom)
  const r = toggleInlineMark({
    doc, index, map, visFrom: visStartFor(map, rawFrom), visTo: visEndFor(map, rawTo), kind: 'strong'
  })
  assert.equal(r.ok, true, r.code)
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text, 'a **bold** b\n')
}

// nbsp-shrink regression (review ride-along, Plan 4 Task 2): an HTML entity
// like `&nbsp;` decodes to a whitespace CHARACTER, but its raw bytes are the
// literal `&nbsp;` text, tagged `kind:'entity'` by the character map —
// `isWhitespaceVisible` deliberately only trusts `char`/`linebreak` units
// (see its own comment), so an entity is never treated as shrinkable
// whitespace even though `/\s/` would match its decoded value. Pin this: a
// selection flanked by `&nbsp;` entities on both sides shrinks NOT AT ALL
// (there is no leading/trailing literal-space unit to trim), so the wrap
// markers land around the ENTIRE selection, entities included.
{
  const src = 'a&nbsp;bold&nbsp;b\n'
  // visible: a(0) nbsp(1) b(2) o(3) l(4) d(5) nbsp(6) b(7) — select
  // [1,7) ("&nbsp;bold&nbsp;" worth of visible chars).
  const { doc, index, map } = blockSetup(src, 0)
  const r = toggleInlineMark({ doc, index, map, visFrom: 1, visTo: 7, kind: 'strong' })
  assert.equal(r.ok, true, r.code)
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text,
    'a**&nbsp;bold&nbsp;**b\n', 'entity flanks are not trimmed by the whitespace shrink')
}

// All-whitespace selection: nothing survives the shrink → reject.
{
  const src = 'a   b\n'
  const rawFrom = src.indexOf('   ')
  const rawTo = rawFrom + 3
  const { doc, index, map } = blockSetup(src, rawFrom)
  assert.deepEqual(
    toggleInlineMark({
      doc, index, map, visFrom: visStartFor(map, rawFrom), visTo: visEndFor(map, rawTo), kind: 'strong'
    }),
    { ok: false, code: 'unsupported-structure' }
  )
}

// Empty selection: also rejected (visFrom === visTo).
{
  const src = 'a bold b\n'
  const raw = src.indexOf('bold')
  const { doc, index, map } = blockSetup(src, raw)
  const vis = visStartFor(map, raw)
  assert.deepEqual(
    toggleInlineMark({ doc, index, map, visFrom: vis, visTo: vis, kind: 'strong' }),
    { ok: false, code: 'unsupported-structure' }
  )
}

// inlineCode wrap whose selection contains a literal backtick → reject
// (fail-closed: no delimiter-run upgrade attempted).
{
  const src = 'a b`c b\n'
  const needle = 'b`c'
  const rawFrom = src.indexOf(needle)
  const rawTo = rawFrom + needle.length
  const { doc, index, map } = blockSetup(src, rawFrom)
  assert.deepEqual(
    toggleInlineMark({
      doc, index, map, visFrom: visStartFor(map, rawFrom), visTo: visEndFor(map, rawTo), kind: 'inlineCode'
    }),
    { ok: false, code: 'unsupported-structure' }
  )
}

// Partial overlap: selection starts inside an existing strong's content and
// ends past its closing marker — neither wrap-around nor sub-span → reject.
// The selection's right edge must land on the non-whitespace 'c' (not the
// space before it) — landing on whitespace would get trimmed away by the
// step-1 shrink, silently pulling the selection back inside the strong's
// content and turning this into a legal sub-span wrap instead.
{
  const src = 'a **bold** c\n'
  const rawFrom = src.indexOf('ld** c') // inside "bold" content, through close marker + trailing text
  const rawTo = rawFrom + 'ld** c'.length
  const { doc, index, map } = blockSetup(src, rawFrom)
  assert.deepEqual(
    toggleInlineMark({
      doc, index, map, visFrom: visStartFor(map, rawFrom), visTo: visEndFor(map, rawTo), kind: 'delete'
    }),
    { ok: false, code: 'unsupported-structure' }
  )
}

// Different-kind exact cover: selection exactly matches an existing strong's
// content, but the requested kind is emphasis → reject (not a same-kind
// unwrap, not a legal wrap over an untouched span).
{
  const src = 'a **bold** c\n'
  const rawFrom = src.indexOf('bold')
  const rawTo = rawFrom + 'bold'.length
  const { doc, index, map } = blockSetup(src, rawFrom)
  assert.deepEqual(
    toggleInlineMark({
      doc, index, map, visFrom: visStartFor(map, rawFrom), visTo: visEndFor(map, rawTo), kind: 'emphasis'
    }),
    { ok: false, code: 'unsupported-structure' }
  )
}

// Wrap-around nesting stays legal: a selection that STRICTLY CONTAINS an
// existing strong node (not just its exact content) wraps around it rather
// than rejecting — the selectionContainsNode branch of the overlap check.
// Selecting the whole visible paragraph "a bold c" (which fully contains the
// word "bold", itself already strong) and toggling `delete` wraps the entire
// raw span, markers and all.
{
  const src = 'a **bold** c\n'
  const rawFrom = 0
  const rawTo = src.indexOf('c') + 1
  const { doc, index, map } = blockSetup(src, rawFrom)
  const r = toggleInlineMark({
    doc, index, map, visFrom: visStartFor(map, rawFrom), visTo: visEndFor(map, rawTo), kind: 'delete'
  })
  assert.equal(r.ok, true, r.code)
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text, '~~a **bold** c~~\n')
}

// A selection spanning the whole paragraph, including an inlineCode span,
// is a legal WRAP around the entire content (the span sits strictly inside
// the selection — full containment, not a straddle).
{
  const src = 'a `code` b\n'
  const { doc, index, map } = blockSetup(src, 0)
  const r = toggleInlineMark({ doc, index, map, visFrom: 0, visTo: map.visibleLength, kind: 'strong' })
  assert.equal(r.ok, true, r.code)
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text, '**a `code` b**\n')
}

// ---- P4-3.5: per-char inlineCode units ----

// Padded span unwrap: `` ` x ` `` renders as value 'x'; selecting that value
// and toggling code off must remove backticks AND the stripped padding
// spaces (paddedInlineCodeAt), restoring the bare value.
{
  const src = 'a ` x ` b\n'
  const rawFrom = src.indexOf('x')
  const { doc, index, map } = blockSetup(src, rawFrom)
  assert.ok(map, 'padded span must map')
  const r = toggleInlineMark({
    doc, index, map,
    visFrom: visStartFor(map, rawFrom), visTo: visEndFor(map, rawFrom + 1),
    kind: 'inlineCode'
  })
  assert.equal(r.ok, true, r.code)
  const restored = applySourceTransaction(doc, r.transaction)
  assert.equal(restored.doc.text, 'a x b\n')
  assert.deepEqual(r.transaction.selection, { anchor: 2, head: 3 })
}

// Sub-span of an existing code span's content (newly selectable now that the
// span is per-char units): wrapping it with ANY kind would inject literal
// marker bytes into the code content → refuse for every kind.
{
  const src = 'a `abcd` b\n'
  const rawFrom = src.indexOf('bc')
  const rawTo = rawFrom + 2
  const { doc, index, map } = blockSetup(src, rawFrom)
  for (const kind of ['strong', 'inlineCode']) {
    assert.deepEqual(
      toggleInlineMark({
        doc, index, map, visFrom: visStartFor(map, rawFrom), visTo: visEndFor(map, rawTo), kind
      }),
      { ok: false, code: 'unsupported-structure' },
      `sub-span wrap inside code content must refuse (${kind})`
    )
  }
}

// Exact-cover unwrap of a MULTI-char span through the normal inlineMarkAt
// path (the atom fallback is gone): select the rendered 'code' of 'a `code`
// b', toggle code → backticks removed.
{
  const src = 'a `code` b\n'
  const rawFrom = src.indexOf('code')
  const rawTo = rawFrom + 4
  const { doc, index, map } = blockSetup(src, rawFrom)
  const r = toggleInlineMark({
    doc, index, map, visFrom: visStartFor(map, rawFrom), visTo: visEndFor(map, rawTo), kind: 'inlineCode'
  })
  assert.equal(r.ok, true, r.code)
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text, 'a code b\n')
}

console.log('PASS source-kernel commands (toggleInlineMark)')

// ---- Inline HTML: structural commands REACH the paragraph, but never split
//      a fragment (Plan 5 Task 2 report §6.1 + its bisect guard) ----
//
// Before the fix `index.blockAt` answered `{type:'html'}` for every offset in
// or beside an inline fragment, so all of these refused. After it, the
// paragraph is resolved and the command runs — except strictly INSIDE a
// fragment, where a split would commit two unbalanced halves
// (`a <span>x` + `</span> b`) that the editor renders as escaped text, i.e. a
// document that no longer matches the ProseMirror doc on screen.
//
// Raw offsets of 'a <span>x</span> b\n':
//   'a '=[0,2)  '<span>'=[2,8)  'x'=8  '</span>'=[9,16)  ' b'=[16,18)  '\n'=18
const routeAt = (src, key, offset) => {
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  const result = routeStructuralKey(key, { doc, index, offset })
  if (!result.ok) return result
  return { ...result, text: applySourceTransaction(doc, result.transaction).doc.text }
}

{
  const src = 'a <span>x</span> b\n'

  // Enter BEFORE the fragment (offset 2 == its opening edge) — legal, and the
  // fragment moves to the new block intact.
  const before = routeAt(src, 'Enter', 2)
  assert.equal(before.ok, true, before.code)
  assert.equal(before.text, 'a \n\n<span>x</span> b\n')
  assert.equal(before.transaction.intent, 'split-block')

  // Enter AFTER the fragment (offset 16 == its closing edge) — legal, the
  // fragment stays whole in the first block.
  const after = routeAt(src, 'Enter', 16)
  assert.equal(after.ok, true, after.code)
  assert.equal(after.text, 'a <span>x</span>\n\n b\n')

  // Enter INSIDE the fragment — refused at every strictly-interior offset,
  // including the `x` between the tags (offset 8, where the merged atom has no
  // addressable interior on the ProseMirror side either).
  for (const offset of [3, 5, 7, 8, 9, 12, 15]) {
    assert.deepEqual(
      routeAt(src, 'Enter', offset),
      { ok: false, code: 'unsupported-structure' },
      `Enter at ${offset} must not bisect the fragment`
    )
  }

  // Control: the same document splits normally everywhere OUTSIDE the
  // fragment, byte-for-byte.
  assert.equal(routeAt(src, 'Enter', 1).text, 'a\n\n <span>x</span> b\n')
  assert.equal(routeAt(src, 'Enter', 17).text, 'a <span>x</span> \n\nb\n')
}

// Enter BETWEEN two fragments in the same paragraph. Offsets of
// 'a <b>x</b> <i>y</i> b\n': fragments [2,10) and [11,19), the space between
// them is 10.
{
  const src = 'a <b>x</b> <i>y</i> b\n'
  const between = routeAt(src, 'Enter', 10)
  assert.equal(between.ok, true, between.code)
  assert.equal(between.text, 'a <b>x</b>\n\n <i>y</i> b\n')
  assert.deepEqual(routeAt(src, 'Enter', 5), { ok: false, code: 'unsupported-structure' })
  assert.deepEqual(routeAt(src, 'Enter', 14), { ok: false, code: 'unsupported-structure' })
}

// A lone `<br/>` and an UNBALANCED fragment are inline atoms too — the editor
// does not merge them, but ProseMirror still holds one indivisible html node,
// so their raw spans are equally unsplittable.
{
  assert.deepEqual(routeAt('a <br/> b\n', 'Enter', 4), { ok: false, code: 'unsupported-structure' })
  assert.equal(routeAt('a <br/> b\n', 'Enter', 7).text, 'a <br/>\n\n b\n')
  assert.deepEqual(routeAt('a <span>x b\n', 'Enter', 5), { ok: false, code: 'unsupported-structure' })
}

// A LIST ITEM's content is phrasing too: splitListItem gets the same guard.
// '- a <span>x</span> b\n': fragment [4,18), item content starts at 2.
{
  const src = '- a <span>x</span> b\n'
  assert.deepEqual(routeAt(src, 'Enter', 10), { ok: false, code: 'unsupported-structure' })
  const ok = routeAt(src, 'Enter', 18)
  assert.equal(ok.ok, true, ok.code)
  assert.equal(ok.text, '- a <span>x</span>\n-  b\n')
  assert.equal(ok.transaction.intent, 'split-list-item')
}

// A HEADING with a fragment: splitTextBlock's heading branch, same guard.
// '# h <span>x</span> t\n': fragment [4,18).
{
  const src = '# h <span>x</span> t\n'
  assert.deepEqual(routeAt(src, 'Enter', 11), { ok: false, code: 'unsupported-structure' })
  const ok = routeAt(src, 'Enter', 18)
  assert.equal(ok.ok, true, ok.code)
  assert.equal(ok.text, '# h <span>x</span>\n\n t\n')
}

// ---- Backspace-join into / out of a fragment-bearing paragraph ----
//
// THE review's exact repro: 'a\n\n<span>x</span> b\n'. The second paragraph
// STARTS with a fragment, so `blockAt(3)` used to answer the html node and the
// ordinary join-with-previous-paragraph was refused with a toast — a real UX
// regression versus legacy, where this merged. It now commits byte-exactly.
// Raw offsets: 'a'=0 '\n'=1 '\n'=2, paragraph2 = [3,19), fragment = [3,17).
{
  const src = 'a\n\n<span>x</span> b\n'
  const joined = routeAt(src, 'Backspace', 3)
  assert.equal(joined.ok, true, joined.code)
  assert.equal(joined.text, 'a\n<span>x</span> b\n')
  assert.equal(joined.transaction.intent, 'join-block-backward')
  assert.deepEqual(joined.transaction.selection, { anchor: 1, head: 1 })

  // The mirrored Delete at the FIRST paragraph's end reaches the same join.
  const forward = routeAt(src, 'Delete', 1)
  assert.equal(forward.ok, true, forward.code)
  assert.equal(forward.text, 'a\n<span>x</span> b\n')

  // Backspace strictly INSIDE the fragment is not a join at all: `offset !==
  // block.start`, so the router hands it to the character path (`not-
  // structural`) — where the fragment is a single width-1 atom with no
  // addressable interior, so no byte inside it is reachable either.
  assert.deepEqual(routeAt(src, 'Backspace', 6), { ok: false, code: 'not-structural' })
  // Called DIRECTLY (a future caller bypassing the router), the command itself
  // refuses an interior offset rather than guessing — fail-closed, not
  // downgraded.
  {
    const doc = createMarkdownDocument(src)
    const index = buildSyntaxIndex(src)
    assert.deepEqual(
      joinParagraphBackward({ doc, index, offset: 6 }),
      { ok: false, code: 'unsupported-structure' }
    )
  }
}

// ---- Deletion RANGES ----
//
// Removing a WHOLE fragment is well-defined and works; a range whose endpoint
// falls strictly inside one does not. The character path can only ever express
// the former (the fragment is one atom unit), which is exactly the invariant
// `bisectsInlineHtml`'s range form states.
{
  const src = 'a <span>x</span> b\n'
  const { doc, index, map } = blockSetup(src, 0)
  // Visible units: 'a'(0) ' '(1) [fragment atom](2) ' '(3) 'b'(4).
  assert.equal(map.visibleLength, 5)
  assert.equal(visStartFor(map, 2), 2, 'the fragment is one visible unit at index 2')
  assert.equal(visEndFor(map, 16), 3)

  const removed = replaceVisibleText({ doc, map, visFrom: 2, visTo: 3, insert: '' })
  assert.equal(removed.ok, true, removed.code)
  assert.deepEqual(
    { from: removed.transaction.from, to: removed.transaction.to },
    { from: 2, to: 16 },
    'the resolved raw range covers the fragment exactly'
  )
  assert.equal(applySourceTransaction(doc, removed.transaction).doc.text, 'a  b\n')
  assert.equal(index.bisectsInlineHtml(2, 16), false, 'a covering range does not bisect')

  // Nudge either endpoint inward and the same range is a bisection.
  assert.equal(index.bisectsInlineHtml(3, 16), true)
  assert.equal(index.bisectsInlineHtml(2, 15), true)
}

console.log('PASS source-kernel commands (inline html: reachable, never bisected)')

// ---- Image attribute edits (Plan 5 Task 5) ----
//
// Byte cases for `setImageAttrs`. Every expectation below is the FULL document
// text after applying the returned transaction, plus (where the point is
// minimality) the exact edit list — a whole-span rewrite that happens to
// produce the same bytes would pass the first assertion and fail the second,
// which is the difference this command exists to make.
const imageSetup = (text) => ({
  doc: createMarkdownDocument(text),
  index: buildSyntaxIndex(text)
})

const setImage = (text, offset, patch) => {
  const { doc, index } = imageSetup(text)
  const routed = setImageAttrs({ doc, index, offset, ...patch })
  if (!routed.ok) return { ok: false, code: routed.code }
  const applied = applySourceTransaction(doc, routed.transaction)
  assert.equal(applied.ok, true, applied.code)
  return { ok: true, text: applied.doc.text, edits: routed.transaction.edits, transaction: routed.transaction }
}

// Each attribute alone — minimal, single-segment edits.
{
  const alt = setImage('![a](b.png)\n', 0, { alt: 'new alt' })
  assert.equal(alt.text, '![new alt](b.png)\n')
  assert.deepEqual(alt.edits, [{ from: 2, to: 3, insert: 'new alt' }], 'only the label segment is rewritten')

  const src = setImage('![a](b.png)\n', 0, { src: 'c/d.png' })
  assert.equal(src.text, '![a](c/d.png)\n')
  assert.deepEqual(src.edits, [{ from: 5, to: 10, insert: 'c/d.png' }], 'only the destination segment is rewritten')

  const title = setImage('![a](b.png)\n', 0, { title: 'T' })
  assert.equal(title.text, '![a](b.png "T")\n')
  assert.deepEqual(title.edits, [{ from: 10, to: 10, insert: ' "T"' }], 'a missing title is INSERTED, nothing else moves')

  const all = setImage('![a](b.png)\n', 0, { alt: 'A', src: 'B', title: 'C' })
  assert.equal(all.text, '![A](B "C")\n')
  assert.equal(all.edits.length, 3, 'three independent segment edits, never one whole-span rewrite')
}

// Title removal: the title AND the whitespace that introduced it.
{
  assert.equal(setImage('![a](b "t")\n', 0, { title: null }).text, '![a](b)\n')
  // '' is ProseMirror's own "no title" (the image schema defaults title to
  // ''), so it removes rather than writing a literal `""`.
  assert.equal(setImage('![a](b "t")\n', 0, { title: '' }).text, '![a](b)\n')
  const removed = setImage('![a](b "t")\n', 0, { title: null })
  assert.deepEqual(removed.edits, [{ from: 6, to: 10, insert: '' }])
}

// Quote style is PRESERVED (all three CommonMark title forms), and the active
// closing character is escaped rather than refused.
{
  assert.equal(setImage('![a](b "t")\n', 0, { title: 'z' }).text, '![a](b "z")\n')
  assert.equal(setImage("![a](b 't')\n", 0, { title: 'z' }).text, "![a](b 'z')\n")
  assert.equal(setImage('![a](b (t))\n', 0, { title: 'z' }).text, '![a](b (z))\n')
  assert.equal(setImage('![a](b "t")\n', 0, { title: 'x"y' }).text, '![a](b "x\\"y")\n')
  assert.equal(setImage("![a](b 't')\n", 0, { title: "x'y" }).text, "![a](b 'x\\'y')\n")
  assert.equal(setImage('![a](b (t))\n', 0, { title: 'x)y' }).text, '![a](b (x\\)y))\n')

  // Review finding (2026-08-17): the title ladder used to escape ONLY `\\` and
  // the active quote, while alt/dest also carried `&` and `|` — 91 of 8778
  // fuzzed rewrites refused, ALL of them titles. CommonMark decodes character
  // references inside a title, so a verbatim `a&amp;b` came back as `a&b` and
  // no candidate could express the literal; and a raw `|` inside a GFM cell
  // splits the column.
  for (const open of ['"', "'", '(']) {
    const close = open === '(' ? ')' : open
    const src = `![a](b ${open}t${close})\n`
    const entity = setImage(src, 0, { title: 'a&amp;b' })
    assert.equal(entity.ok, true, 'an entity-looking title must be expressible')
    assert.equal(entity.text, `![a](b ${open}a\\&amp;b${close})\n`)
    // …and it really does decode back to the literal the caller asked for.
    const reparsed = buildSyntaxIndex(entity.text)
    assert.equal(reparsed.tree.children[0].children[0].title, 'a&amp;b')
  }
  {
    const table = '| ![a](b "t") | x |\n| --- | --- |\n| y | z |\n'
    const piped = setImage(table, 2, { title: 'a|b' })
    assert.equal(piped.ok, true, 'a piped title must be expressible inside a table cell')
    assert.equal(piped.text, '| ![a](b "a\\|b") | x |\n| --- | --- |\n| y | z |\n')
    const reparsed = buildSyntaxIndex(piped.text)
    assert.equal(reparsed.tree.children[0].type, 'table', 'the table survived')
    assert.equal(reparsed.tree.children[0].children[0].children[0].children[0].title, 'a|b')
  }
}

// Angle-bracket destinations: kept when present, ADOPTED when the new value
// needs them (a URL with whitespace has no bare spelling), never introduced
// gratuitously.
{
  assert.equal(setImage('![a](<b c>)\n', 0, { src: 'd e' }).text, '![a](<d e>)\n')
  assert.equal(setImage('![a](<b c>)\n', 0, { src: 'plain.png' }).text, '![a](<plain.png>)\n')
  assert.equal(setImage('![a](b)\n', 0, { src: 'd e' }).text, '![a](<d e>)\n')
  assert.equal(setImage('![a](b)\n', 0, { src: 'plain.png' }).text, '![a](plain.png)\n')
  assert.equal(setImage('![a](<>)\n', 0, { src: 'u' }).text, '![a](<u>)\n')
}

// Empty alt (both directions), CJK alt, percent-encoded URL.
{
  assert.equal(setImage('![](b)\n', 0, { alt: 'CJK中文说明' }).text, '![CJK中文说明](b)\n')
  assert.equal(setImage('![a](b)\n', 0, { alt: '' }).text, '![](b)\n')
  assert.equal(setImage('![a](foo%20bar.png)\n', 0, { src: 'x%20y.png' }).text, '![a](x%20y.png)\n',
    'percent-encoding is bytes, never re-encoded or decoded')
  assert.equal(setImage('![a](b)\n', 0, { src: '图片/说明.png' }).text, '![a](图片/说明.png)\n')
}

// Escaping is EARNED, not assumed: verbatim bytes first, escapes only when the
// reparse proof says the verbatim spelling would decode to something else.
{
  assert.equal(setImage('![a](b)\n', 0, { alt: 'a]b' }).text, '![a\\]b](b)\n')
  assert.equal(setImage('![a](b)\n', 0, { alt: 'a*b*c' }).text, '![a\\*b\\*c](b)\n')
  assert.equal(setImage('![a](b)\n', 0, { alt: '# not a heading' }).text, '![# not a heading](b)\n',
    'a leading # inside a label is inert — no escape added')
  assert.equal(setImage('![a](b)\n', 0, { src: 'a)b' }).text, '![a](a\\)b)\n')
  assert.equal(setImage('![a](b)\n', 0, { src: 'a(b)c' }).text, '![a](a(b)c)\n',
    'balanced parens need no escape in a bare destination')
}

// Surrounding bytes are untouched: interior whitespace inside the parens, an
// inline image mid-paragraph, a quoted / list-nested image.
{
  assert.equal(setImage('![a]( b  "t" )\n', 0, { src: 'q' }).text, '![a]( q  "t" )\n')
  assert.equal(setImage('text ![a](b) tail\n', 5, { alt: 'z' }).text, 'text ![z](b) tail\n')
  assert.equal(setImage('> ![a](b)\n', 2, { alt: 'q' }).text, '> ![q](b)\n')
  assert.equal(setImage('- ![a](b)\n', 2, { src: 'z' }).text, '- ![a](z)\n')
}

// CONTEXT-SENSITIVE proof. A raw `|` written into an image inside a GFM table
// cell leaves the image node itself intact at the same offset with exactly the
// requested url — while collapsing the whole TABLE into a paragraph. The
// structural (whole-tree) half of the verification is what rejects the
// verbatim candidate and promotes the escaped one.
{
  const table = '| ![a](b) | x |\n| --- | --- |\n| y | z |\n'
  const src = setImage(table, 2, { src: 'p|q' })
  assert.equal(src.text, '| ![a](p\\|q) | x |\n| --- | --- |\n| y | z |\n')
  const alt = setImage(table, 2, { alt: 'x|y' })
  assert.equal(alt.text, '| ![x\\|y](b) | x |\n| --- | --- |\n| y | z |\n')
  // …and the escaped bytes really do reparse to the requested value INSIDE a
  // still-intact table.
  const reindexed = buildSyntaxIndex(src.text)
  const row = reindexed.tree.children[0]
  assert.equal(row.type, 'table', 'the table survived')
  assert.equal(row.children[0].children[0].children[0].url, 'p|q')
}

// A no-op request (the values already ARE the source bytes) is a well-formed
// zero-width transaction, never an `invalid-range` from an empty edit list.
{
  const noop = setImage('![a](b)\n', 0, { alt: 'a', src: 'b' })
  assert.equal(noop.text, '![a](b)\n')
  assert.deepEqual(noop.edits, [{ from: 0, to: 0, insert: '' }])
}

// Refusal shapes — all `unsupported-structure`, all fail-closed.
{
  // A line ending in a written value would end the block it lives in.
  assert.deepEqual(setImage('![a](b)\n', 0, { alt: 'line\nbreak' }), { ok: false, code: 'unsupported-structure' })
  assert.deepEqual(setImage('![a](b)\n', 0, { src: 'a\r\nb' }), { ok: false, code: 'unsupported-structure' })
  // No image at the offset.
  assert.deepEqual(setImage('plain paragraph\n', 3, { alt: 'x' }), { ok: false, code: 'unsupported-structure' })
  // A reference image is a DIFFERENT mdast node type and is never matched.
  assert.deepEqual(
    setImage('![a][ref]\n\n[ref]: b.png\n', 2, { alt: 'x' }),
    { ok: false, code: 'unsupported-structure' }
  )
  // Nothing requested.
  {
    const { doc, index } = imageSetup('![a](b)\n')
    assert.deepEqual(setImageAttrs({ doc, index, offset: 0 }), { ok: false, code: 'unsupported-structure' })
    assert.deepEqual(setImageAttrs({ doc, index, offset: NaN, alt: 'x' }), { ok: false, code: 'unsupported-structure' })
  }
}

// Selection bookkeeping: an anchor before the first rewritten byte survives
// verbatim; one after the last shifts by the edit delta.
{
  const { doc, index } = imageSetup('text ![a](b) tail\n')
  const routed = setImageAttrs({ doc, index, offset: 5, src: 'longer.png' })
  assert.equal(routed.ok, true)
  assert.deepEqual(routed.transaction.selection, { anchor: 5, head: 5 })
  assert.equal(routed.transaction.intent, 'image-attrs')
}

console.log('PASS source-kernel commands (image attrs: minimal segment rewrites, proven byte-for-byte)')

// ---- Image CAPTION edits (kernel/image-caption) ----
//
// The byte home is the legacy scheme's own, verified against
// components/editor-image-markdown.js: an UNSCALED image-block's caption is
// the markdown TITLE slot (serialize `title: caption…`, parse
// `caption: title || alt`). `setImageAttrs({ caption })` maps caption→title
// and adds ONE proof axis on top of the existing mdast ladder: the candidate
// bytes' SCHEMA-level interpretation (the imageBlockMarkdownSchema parse
// decision, mirrored) must equal the view's post-AttrStep attrs — this is
// what catches the numeric-alt trap below, which the mdast axes are blind to.
{
  // Replace an existing title — the caption's byte home, minimal edit.
  const replaced = setImage('![a](b "t")\n', 0, { caption: 'z' })
  assert.equal(replaced.text, '![a](b "z")\n')
  assert.deepEqual(replaced.edits, [{ from: 7, to: 10, insert: '"z"' }],
    'only the title segment is rewritten')
  assert.equal(replaced.transaction.intent, 'image-attrs')

  // Insert a title where none existed (alt is prose, not a ratio).
  assert.equal(setImage('![描述](b.png)\n', 0, { caption: '新图注' }).text, '![描述](b.png "新图注")\n')

  // caption === alt still writes the title EXPLICITLY (kernel design
  // decision, see image-attrs.js ADR: the projection `title || alt` reads
  // identically either way; writing the byte makes the round trip literal
  // instead of relying on the alt-fallback shadow).
  assert.equal(setImage('![a](b)\n', 0, { caption: 'a' }).text, '![a](b "a")\n')

  // Quote escaping rides the SAME earned-escape ladder as `title`.
  assert.equal(setImage('![a](b "t")\n', 0, { caption: 'x"y' }).text, '![a](b "x\\"y")\n')
  {
    const table = '| ![a](b "t") | x |\n| --- | --- |\n| y | z |\n'
    const piped = setImage(table, 2, { caption: 'a|b' })
    assert.equal(piped.ok, true, 'a piped caption must be expressible inside a table cell')
    assert.equal(piped.text, '| ![a](b "a\\|b") | x |\n| --- | --- |\n| y | z |\n')
    const reparsed = buildSyntaxIndex(piped.text)
    assert.equal(reparsed.tree.children[0].type, 'table', 'the table survived')
    assert.equal(reparsed.tree.children[0].children[0].children[0].children[0].title, 'a|b')
  }

  // CRLF documents: the image span is single-line, the rewrite is
  // byte-identical, and no `\r\n` pair is ever split.
  assert.equal(setImage('![a](b "t")\r\n', 0, { caption: 'z' }).text, '![a](b "z")\r\n')
  assert.equal(setImage('甲\r\n\r\n![a](b "t")\r\n', 5, { caption: '乙' }).text, '甲\r\n\r\n![a](b "乙")\r\n')
}

// Clearing the caption: representable ONLY while nothing would shadow it —
// the projection is `title || alt`, so with a non-empty alt there is NO byte
// spelling of "alt present, caption empty".
{
  assert.equal(setImage('![](b "t")\n', 0, { caption: '' }).text, '![](b)\n',
    'empty alt: clearing the caption removes the title')
  const noop = setImage('![](b)\n', 0, { caption: '' })
  assert.equal(noop.text, '![](b)\n')
  assert.deepEqual(noop.edits, [{ from: 0, to: 0, insert: '' }],
    'clearing an already-absent caption is the zero-width no-op, never invalid-range')

  assert.deepEqual(setImage('![a](b "t")\n', 0, { caption: '' }),
    { ok: false, code: 'empty-image-caption-unrepresentable' })
  assert.deepEqual(setImage('![a](b)\n', 0, { caption: '' }),
    { ok: false, code: 'empty-image-caption-unrepresentable' })
}

// The ratio-in-alt scheme owns BOTH slots of a scaled image (alt = numeric
// ratio, title = caption), so every caption edit there refuses with the
// NAMED code — at the command layer too, not only in the gateway.
{
  assert.deepEqual(setImage('![1.50](b.png "说明")\n', 0, { caption: '新' }),
    { ok: false, code: 'image-caption-scaled' })
  assert.deepEqual(setImage('![1.50](b.png "说明")\n', 0, { caption: '' }),
    { ok: false, code: 'image-caption-scaled' })

  // The NUMERIC-ALT TRAP: `![2](b.png)` parses UNSCALED today (numeric alt
  // but no title), yet writing a title next to that alt flips
  // editor-image-markdown.js's parse into the legacy-scaled reading — the
  // image would snap to 2x and the alt would vanish. The mdast axes cannot
  // see this (alt/title bytes are exactly as requested); the schema
  // projection axis refuses it.
  assert.deepEqual(setImage('![2](b.png)\n', 0, { caption: '图' }),
    { ok: false, code: 'image-caption-scaled' })
  assert.deepEqual(setImage('![1.00](b.png)\n', 0, { caption: '图' }),
    { ok: false, code: 'image-caption-scaled' })

  // …but a numeric alt WITH a title at ratio≈1 stays legacy-parsed either
  // way (the serializer's own |ratio-1|>0.001 tolerance): the caption edit
  // is provable and commits.
  assert.equal(setImage('![1.00](b.png "t")\n', 0, { caption: '新' }).text, '![1.00](b.png "新")\n')
}

// Caption request hygiene: caption is the WHOLE request (it owns the title
// slot — mixing it with the raw fields is contradictory), and a line ending
// in the value would end the block.
{
  const { doc, index } = imageSetup('![a](b "t")\n')
  assert.deepEqual(setImageAttrs({ doc, index, offset: 0, caption: 'x', title: 'y' }),
    { ok: false, code: 'unsupported-structure' })
  assert.deepEqual(setImageAttrs({ doc, index, offset: 0, caption: 'x', alt: 'y' }),
    { ok: false, code: 'unsupported-structure' })
  assert.deepEqual(setImageAttrs({ doc, index, offset: 0, caption: 'a\nb' }),
    { ok: false, code: 'unsupported-structure' })
}

console.log('PASS source-kernel commands (image caption: title-slot byte home, scaled/shadowed shapes named-refused)')

// ---- Link editing (Plan 5 Task 6) ----
//
// Byte cases for `applyLinkEdit`. Every expectation is the FULL document text
// after applying the returned transaction, and — where minimality is the
// point — the exact edit list, so a whole-span rewrite that happens to
// produce the same bytes still fails.
//
// `visAt` mirrors what the kernel-mode route hands the command: the character
// map of the PHRASING block containing the operation (paragraph / heading /
// tableCell), plus visible offsets inside it. `blockOffset` selects the block
// the same way the projection map's pair lookup does — by a raw offset inside
// it — so a table fixture can address one cell.
const linkBlockAt = (tree, offset) => {
  const kinds = new Set(['paragraph', 'heading', 'tableCell'])
  let found = null
  const visit = (node) => {
    const start = node?.position?.start?.offset
    const end = node?.position?.end?.offset
    if (kinds.has(node?.type) && Number.isInteger(start) && Number.isInteger(end) &&
        offset >= start && offset <= end) {
      if (!found || start >= found.position.start.offset) found = node
    }
    for (const child of node?.children || []) visit(child)
  }
  visit(tree)
  return found
}

const linkEdit = (text, blockOffset, args) => {
  const doc = createMarkdownDocument(text)
  const index = buildSyntaxIndex(text)
  const block = linkBlockAt(index.tree, blockOffset)
  assert.ok(block, 'fixture must have a phrasing block at ' + blockOffset)
  const map = buildCharacterMap(text, block)
  assert.ok(map, 'fixture block must character-map')
  const routed = applyLinkEdit({ doc, index, map, ...args })
  if (!routed.ok) return { ok: false, code: routed.code }
  const applied = applySourceTransaction(doc, routed.transaction)
  assert.equal(applied.ok, true, applied.code)
  return {
    ok: true,
    text: applied.doc.text,
    edits: routed.transaction.edits,
    intent: routed.transaction.intent,
    selection: routed.transaction.selection
  }
}

// WRAP — a selection becomes a link's label; only two zero-width inserts.
{
  const plain = linkEdit('hello world\n', 0, { visFrom: 0, visTo: 5, op: 'wrap', href: 'https://x.com' })
  assert.equal(plain.text, '[hello](https://x.com) world\n')
  assert.deepEqual(plain.edits, [
    { from: 0, to: 0, insert: '[' },
    { from: 5, to: 5, insert: '](https://x.com)' }
  ], 'wrap is exactly two zero-width inserts — the label bytes are never rewritten')
  assert.equal(plain.intent, 'link-wrap')
  // The label content stays selected (the mark commands' contract).
  assert.deepEqual(plain.selection, { anchor: 1, head: 6 })

  // Mid-paragraph, and with a title.
  assert.equal(linkEdit('a bc d\n', 0, { visFrom: 2, visTo: 4, op: 'wrap', href: 'u' }).text, 'a [bc](u) d\n')
  assert.equal(linkEdit('hello\n', 0, { visFrom: 0, visTo: 5, op: 'wrap', href: 'u', title: 'T' }).text,
    '[hello](u "T")\n')
}

// WRAP over text that already contains `]` — the ONE case where the label
// bytes must change. The escape is earned: the verbatim candidate reparses to
// a DIFFERENT document (`[a]b](u)` is plain text, not a link), so the second
// candidate adds a backslash to the literal bracket and nothing else.
{
  const bracket = linkEdit('a]b c\n', 0, { visFrom: 0, visTo: 3, op: 'wrap', href: 'u' })
  assert.equal(bracket.text, '[a\\]b](u) c\n')
  assert.deepEqual(bracket.edits, [
    { from: 0, to: 0, insert: '[' },
    { from: 1, to: 1, insert: '\\' },
    { from: 3, to: 3, insert: '](u)' }
  ])
  assert.deepEqual(bracket.selection, { anchor: 1, head: 5 }, 'head follows the inserted escape byte')
  // …and an ALREADY-escaped bracket is left alone (no double escape).
  assert.equal(linkEdit('a\\]b c\n', 0, { visFrom: 0, visTo: 3, op: 'wrap', href: 'u' }).text, '[a\\]b](u) c\n')
  // An opening bracket needs the same treatment.
  assert.equal(linkEdit('a[b c\n', 0, { visFrom: 0, visTo: 3, op: 'wrap', href: 'u' }).text, '[a\\[b](u) c\n')
}

// UNWRAP — delete `[` and `](url "title")`, keep the label bytes verbatim.
{
  const one = linkEdit('a [b](u) c\n', 0, { visFrom: 2, visTo: 3, op: 'unwrap' })
  assert.equal(one.text, 'a b c\n')
  assert.deepEqual(one.edits, [{ from: 2, to: 3, insert: '' }, { from: 4, to: 8, insert: '' }])
  assert.equal(one.intent, 'link-unwrap')
  assert.deepEqual(one.selection, { anchor: 2, head: 3 })
  assert.equal(linkEdit('[t](u "T")\n', 0, { visFrom: 0, visTo: 1, op: 'unwrap' }).text, 't\n')
  // An escaped bracket in the label survives the unwrap as-is (still escaped,
  // still decoding to `]`).
  assert.equal(linkEdit('[a\\]b](u)\n', 0, { visFrom: 0, visTo: 3, op: 'unwrap' }).text, 'a\\]b\n')
}

// EDIT — only the destination segment moves; the title, the interior spaces
// and the surrounding text are byte-identical.
{
  const url = linkEdit('a [b](u) c\n', 0, { visFrom: 2, visTo: 3, op: 'edit', href: 'https://z.com' })
  assert.equal(url.text, 'a [b](https://z.com) c\n')
  assert.deepEqual(url.edits, [{ from: 6, to: 7, insert: 'https://z.com' }])
  assert.equal(url.intent, 'link-edit')
  assert.deepEqual(url.selection, { anchor: 3, head: 4 }, 'the label keeps its offsets, so it stays selected')

  assert.equal(linkEdit('[b](u "T")\n', 0, { visFrom: 0, visTo: 1, op: 'edit', href: 'v' }).text, '[b](v "T")\n',
    'an untouched title keeps its bytes — the tooltip only ever supplies href')
  assert.equal(linkEdit('[b]( u  "T" )\n', 0, { visFrom: 0, visTo: 1, op: 'edit', href: 'v' }).text,
    '[b]( v  "T" )\n', 'interior whitespace inside the parens is preserved')

  // Title add / change / remove, quote style preserved and escaped when the
  // value carries the active closing character.
  assert.equal(linkEdit('[b](u)\n', 0, { visFrom: 0, visTo: 1, op: 'edit', href: 'u', title: 'T' }).text, '[b](u "T")\n')
  assert.equal(linkEdit("[b](u 't')\n", 0, { visFrom: 0, visTo: 1, op: 'edit', href: 'u', title: 'z' }).text,
    "[b](u 'z')\n")
  assert.equal(linkEdit('[b](u "t")\n', 0, { visFrom: 0, visTo: 1, op: 'edit', href: 'u', title: 'x"y' }).text,
    '[b](u "x\\"y")\n')
  assert.equal(linkEdit('[b](u "t")\n', 0, { visFrom: 0, visTo: 1, op: 'edit', href: 'u', title: null }).text, '[b](u)\n')
  assert.equal(linkEdit('[b](u "t")\n', 0, { visFrom: 0, visTo: 1, op: 'edit', href: 'u', title: '' }).text, '[b](u)\n')

  // The requested URL already IS the source bytes -> a well-formed zero-width
  // no-op, never an `invalid-range` from an empty edit list.
  const noop = linkEdit('[b](u)\n', 0, { visFrom: 0, visTo: 1, op: 'edit', href: 'u' })
  assert.equal(noop.text, '[b](u)\n')
  assert.deepEqual(noop.edits, [{ from: 1, to: 1, insert: '' }], 'the no-op anchors on the label, not the doc start')
}

// DESTINATION SPELLING — angle form kept when present, ADOPTED when the value
// has no bare spelling, never introduced gratuitously; parens escaped only
// when unbalanced.
{
  assert.equal(linkEdit('[b](<u v>)\n', 0, { visFrom: 0, visTo: 1, op: 'edit', href: 'w x' }).text, '[b](<w x>)\n')
  assert.equal(linkEdit('[b](<u>)\n', 0, { visFrom: 0, visTo: 1, op: 'edit', href: 'plain' }).text, '[b](<plain>)\n')
  assert.equal(linkEdit('hello\n', 0, { visFrom: 0, visTo: 5, op: 'wrap', href: 'a b' }).text, '[hello](<a b>)\n')
  assert.equal(linkEdit('hello\n', 0, { visFrom: 0, visTo: 5, op: 'wrap', href: 'a(1)' }).text, '[hello](a(1))\n',
    'balanced parens need no escape in a bare destination')
  assert.equal(linkEdit('hello\n', 0, { visFrom: 0, visTo: 5, op: 'wrap', href: 'a)b' }).text, '[hello](a\\)b)\n')
  assert.equal(linkEdit('hello\n', 0, { visFrom: 0, visTo: 5, op: 'wrap', href: '' }).text, '[hello](<>)\n',
    'an empty destination has no bare spelling — the angle form leads')
  assert.equal(linkEdit('hello\n', 0, { visFrom: 0, visTo: 5, op: 'wrap', href: 'x%20y' }).text, '[hello](x%20y)\n',
    'percent-encoding is bytes, never re-encoded or decoded')
}

// INSERT — the tooltip's EMPTY-selection semantics, probed from
// @milkdown/components link-tooltip/edit/edit-view.ts:115-122: it types the
// href into the document and marks it, i.e. `[url](url)`.
{
  const inserted = linkEdit('ab\n', 0, {
    visFrom: 1, visTo: 1, op: 'insert', href: 'https://q.com', insertedText: 'https://q.com'
  })
  assert.equal(inserted.text, 'a[https://q.com](https://q.com)b\n')
  assert.equal(inserted.intent, 'link-insert')
  assert.deepEqual(inserted.selection, { anchor: 15, head: 15 }, 'caret parks at the end of the label')
  // A label needing an escape still resolves (the ladder escalates).
  assert.equal(
    linkEdit('ab\n', 0, { visFrom: 1, visTo: 1, op: 'insert', href: 'u', insertedText: 'x]y' }).text,
    'a[x\\]y](u)b\n'
  )
}

// CONTEXT: heading, blockquote, list item, table cell, CJK, CRLF.
{
  assert.equal(linkEdit('# hi there\n', 2, { visFrom: 0, visTo: 2, op: 'wrap', href: 'u' }).text, '# [hi](u) there\n')
  assert.equal(linkEdit('> hi there\n', 2, { visFrom: 0, visTo: 2, op: 'wrap', href: 'u' }).text, '> [hi](u) there\n')
  assert.equal(linkEdit('- hi there\n', 2, { visFrom: 0, visTo: 2, op: 'wrap', href: 'u' }).text, '- [hi](u) there\n')
  assert.equal(linkEdit('中文说明测试\n', 0, { visFrom: 0, visTo: 2, op: 'wrap', href: '中文.md' }).text,
    '[中文](中文.md)说明测试\n')
  assert.equal(linkEdit('hello world\r\n', 0, { visFrom: 0, visTo: 5, op: 'wrap', href: 'u' }).text,
    '[hello](u) world\r\n', 'CRLF endings are untouched')

  const table = '| a | x |\n| --- | --- |\n| y | z |\n'
  assert.equal(linkEdit(table, 2, { visFrom: 0, visTo: 1, op: 'wrap', href: 'u' }).text,
    '| [a](u) | x |\n| --- | --- |\n| y | z |\n')
  // A raw `|` inside a URL would ADD A COLUMN to the table: the verbatim
  // candidate leaves a link node with the requested url at the right offset,
  // and the structural half of the proof is what rejects it in favour of the
  // escaped spelling (which decodes to the same URL inside an intact table).
  const piped = linkEdit(table, 2, { visFrom: 0, visTo: 1, op: 'wrap', href: 'p|q' })
  assert.equal(piped.text, '| [a](p\\|q) | x |\n| --- | --- |\n| y | z |\n')
  const reparsed = buildSyntaxIndex(piped.text)
  assert.equal(reparsed.tree.children[0].type, 'table', 'the table survived')
  assert.equal(reparsed.tree.children[0].children[0].children[0].children[0].url, 'p|q')
}

// REFUSALS — all fail-closed, nothing written.
{
  const refuse = { ok: false, code: 'unsupported-structure' }
  const unmapped = { ok: false, code: 'unmapped-selection' }

  // AUTOLINK LITERALS. GFM turns a bare `www.a.com` into a positioned `link`
  // node with NO syntax bytes, and ProseMirror carries the same `link` mark
  // for it — so the tooltip's remove/edit can target one. There is nothing to
  // rewrite, so both directions refuse.
  assert.deepEqual(linkEdit('see www.a.com ok\n', 0, { visFrom: 4, visTo: 13, op: 'unwrap' }), refuse)
  assert.deepEqual(linkEdit('see www.a.com ok\n', 0, { visFrom: 4, visTo: 13, op: 'edit', href: 'u' }), refuse)
  assert.deepEqual(linkEdit('see www.a.com ok\n', 0, { visFrom: 4, visTo: 13, op: 'wrap', href: 'u' }), refuse)
  // A CommonMark angle autolink is the same story (`<https://a.com>` opens
  // with `<`, not `[`).
  assert.deepEqual(linkEdit('<https://a.com>\n', 0, { visFrom: 0, visTo: 13, op: 'unwrap' }), refuse)

  // An unwrap whose bare text would IMMEDIATELY become an autolink literal
  // again is refused: the user's removal would visibly not happen.
  assert.deepEqual(linkEdit('[www.a.com](u)\n', 0, { visFrom: 0, visTo: 9, op: 'unwrap' }), refuse)

  // Partial coverage of an existing link (the shape `toggleLinkCommand`
  // produces when only part of a link is selected) — neither unwrap nor
  // re-target is expressible.
  assert.deepEqual(linkEdit('[abc](u)\n', 0, { visFrom: 0, visTo: 2, op: 'unwrap' }), refuse)
  assert.deepEqual(linkEdit('[abc](u)\n', 0, { visFrom: 1, visTo: 3, op: 'edit', href: 'v' }), refuse)
  // Links cannot nest: a wrap touching an existing one, or an insert with the
  // caret strictly inside one.
  assert.deepEqual(linkEdit('a [b](u) c\n', 0, { visFrom: 0, visTo: 3, op: 'wrap', href: 'v' }), refuse)
  assert.deepEqual(
    linkEdit('[abc](u)\n', 0, { visFrom: 1, visTo: 1, op: 'insert', href: 'v', insertedText: 'v' }),
    refuse
  )

  // Half-covering another inline mark would strand its delimiters.
  assert.deepEqual(linkEdit('a **bc** d\n', 0, { visFrom: 1, visTo: 4, op: 'wrap', href: 'u' }), refuse)
  // …while a wrap fully INSIDE one is legal and byte-exact.
  assert.equal(linkEdit('a **bc** d\n', 0, { visFrom: 2, visTo: 4, op: 'wrap', href: 'u' }).text,
    'a **[bc](u)** d\n')

  // A line ending in any written value would end the block.
  assert.deepEqual(linkEdit('hello\n', 0, { visFrom: 0, visTo: 5, op: 'wrap', href: 'a\nb' }), refuse)
  assert.deepEqual(linkEdit('[b](u)\n', 0, { visFrom: 0, visTo: 1, op: 'edit', href: 'a\r\nb' }), refuse)

  // Argument shapes.
  assert.deepEqual(linkEdit('hello\n', 0, { visFrom: 0, visTo: 5, op: 'wrap' }), refuse, 'href is required')
  assert.deepEqual(linkEdit('hello\n', 0, { visFrom: 0, visTo: 5, op: 'nope', href: 'u' }), refuse)
  assert.deepEqual(linkEdit('hello\n', 0, { visFrom: 2, visTo: 2, op: 'wrap', href: 'u' }), refuse,
    'a zero-width range is the insert op, never a wrap')
  assert.deepEqual(linkEdit('hello\n', 0, { visFrom: 0, visTo: 5, op: 'insert', href: 'u', insertedText: 'x' }), refuse,
    'insert requires an EMPTY range')
  assert.deepEqual(linkEdit('hello\n', 0, { visFrom: 2, visTo: 2, op: 'insert', href: 'u', insertedText: '' }), refuse)
  // No existing link to act on.
  assert.deepEqual(linkEdit('plain text\n', 0, { visFrom: 0, visTo: 5, op: 'unwrap' }), refuse)
  // An unmapped boundary (mid-entity) never resolves to raw bytes.
  assert.deepEqual(linkEdit('a&#x1F600;b\n', 0, { visFrom: 2, visTo: 3, op: 'wrap', href: 'u' }), unmapped)
}

// COORDINATE SYSTEM (review finding, 2026-08-17). The command's
// `visibleTextOf` must count exactly what `buildCharacterMap` counts, or every
// visible offset AFTER an inline ATOM means something different to the two
// sides and the expected-label / expected-text strings get sliced in the wrong
// space. It charged atoms 0 and the map charges 1, so each shape below —
// perfectly ordinary prose — refused. The raw range was right all along; only
// the proof's own expectations were shifted.
{
  // inline image
  assert.equal(linkEdit('see ![i](p.png) more words here\n', 0, { visFrom: 6, visTo: 10, op: 'wrap', href: 'u' }).text,
    'see ![i](p.png) [more](u) words here\n')
  assert.equal(linkEdit('see ![i](p.png) more words here\n', 0, { visFrom: 0, visTo: 3, op: 'wrap', href: 'u' }).text,
    '[see](u) ![i](p.png) more words here\n', 'the control that always worked: nothing before the atom')
  // inline math
  assert.equal(linkEdit('a $x^2$ word here\n', 0, { visFrom: 4, visTo: 8, op: 'wrap', href: 'u' }).text,
    'a $x^2$ [word](u) here\n')
  // hard break
  assert.equal(linkEdit('aa\\\nbb cc\n', 0, { visFrom: 3, visTo: 5, op: 'wrap', href: 'u' }).text,
    'aa\\\n[bb](u) cc\n')
  // a COALESCED inline-HTML run is ONE unit on both sides — text after it, and
  // the run itself as a whole label.
  assert.equal(linkEdit('x <span>y</span> z w\n', 0, { visFrom: 4, visTo: 5, op: 'wrap', href: 'u' }).text,
    'x <span>y</span> [z](u) w\n')
  assert.equal(linkEdit('x <span>y</span> z w\n', 0, { visFrom: 2, visTo: 3, op: 'wrap', href: 'u' }).text,
    'x [<span>y</span>](u) z w\n')
  // …and the same alignment holds for the other three ops around an atom.
  assert.equal(linkEdit('see ![i](p.png) [more](u) words\n', 0, { visFrom: 6, visTo: 10, op: 'edit', href: 'v' }).text,
    'see ![i](p.png) [more](v) words\n')
  assert.equal(linkEdit('see ![i](p.png) [more](u) words\n', 0, { visFrom: 6, visTo: 10, op: 'unwrap' }).text,
    'see ![i](p.png) more words\n')
  assert.equal(
    linkEdit('see ![i](p.png) more\n', 0, { visFrom: 6, visTo: 6, op: 'insert', href: 'u', insertedText: 'q' }).text,
    'see ![i](p.png) [q](u)more\n'
  )
}

// CRLF (widening, 2026-08-21 — supersedes the 2026-08-17 bisection cases).
// The map now models a '\r\n' pair as ONE width-1 `linebreak` unit, so the
// old intra-pair boundary is no longer any visible offset at all — the three
// former refusal cases are unreachable by construction (no visible index
// resolves between the '\r' and the '\n'; `splitsCrlfPair` still refuses any
// raw-arithmetic write there at the applySourceTransaction chokepoint). The
// visible text of 'one\r\ntwo three' is 'one\ntwo three' (13 chars), exactly
// what ProseMirror holds.
{
  const crlf = 'one\r\ntwo three\r\n'
  assert.equal(linkEdit(crlf, 0, { visFrom: 0, visTo: 3, op: 'wrap', href: 'u' }).text, '[one](u)\r\ntwo three\r\n')
  assert.equal(linkEdit(crlf, 0, { visFrom: 4, visTo: 7, op: 'wrap', href: 'u' }).text, 'one\r\n[two](u) three\r\n')
  // A label that spans the soft break keeps the raw CRLF bytes verbatim.
  assert.equal(linkEdit(crlf, 0, { visFrom: 0, visTo: 7, op: 'wrap', href: 'u' }).text, '[one\r\ntwo](u) three\r\n')
  // An insert at the continuation line's visible start lands AFTER the whole
  // linebreak unit — never inside the pair.
  assert.equal(linkEdit(crlf, 0, { visFrom: 4, visTo: 4, op: 'insert', href: 'u', insertedText: 'q' }).text,
    'one\r\n[q](u)two three\r\n')
}

console.log('PASS source-kernel commands (link: wrap/unwrap/url+title edits, proven byte-for-byte)')

// ===========================================================================
// WHOLE-BRANCH REVIEW, CRITICAL 2 (2026-08-17): a wrap must not partially
// straddle a LINK.
//
// mark-toggle.js kept its own private `OVERLAP_NODE_TYPES` (marks only) while
// link-toggle.js built the correct superset (marks + link/image/html/math/
// footnote/break). Plan 5 Task 3 edited the mark-toggle copy to add
// `highlight` without widening it, so a drag-selection crossing a link
// boundary committed a marker stranded INSIDE the link label. `requireMap`
// could not catch it: the resulting bytes reparse into a document that maps
// cleanly (content.size 9 == visibleLength 9), it is just not the document
// the user asked for. The mirror-image operation (linking across a bold
// boundary) was already refused by link-toggle's own copy, so this was
// cross-task incoherence.
//
// Both commands now import ONE set from mark-map.js.
// ===========================================================================
{
  const src = 'a [b](u) c\n'
  // Visible: 'a b c' — 'a'=0, ' '=1, 'b'=2, ' '=3, 'c'=4. The link node's raw
  // span is [2,8); its label 'b' is raw [3,4).
  const straddle = (visFrom, visTo, kind = 'strong') => {
    const { doc, index, map } = blockSetup(src, 0)
    assert.equal(map.visibleLength, 5, 'fixture sanity: the link contributes ONE visible char')
    return toggleInlineMark({ doc, index, map, visFrom, visTo, kind })
  }

  // RED (the bytes this used to commit — asserted as NEVER produced again).
  assert.deepEqual(straddle(2, 5), { ok: false, code: 'unsupported-structure' },
    "bolding the visible 'b c' used to commit 'a [**b](u) c**\\n'")
  assert.deepEqual(straddle(0, 3), { ok: false, code: 'unsupported-structure' },
    "bolding the visible 'a b' used to commit '**a [b**](u) c\\n'")
  // …and the same for every other kind the toggle owns.
  for (const kind of ['emphasis', 'delete', 'inlineCode', 'highlight']) {
    assert.equal(straddle(2, 5, kind).ok, false, `${kind} must refuse the same straddle`)
    assert.equal(straddle(0, 3, kind).ok, false, `${kind} must refuse the mirrored straddle`)
  }

  // GREEN controls — the shapes that must KEEP working, byte-exact. A wrap
  // fully INSIDE the link label, a wrap fully CONTAINING the link, and a wrap
  // that never touches it.
  const commit = (visFrom, visTo, kind = 'strong') => {
    const { doc, index, map } = blockSetup(src, 0)
    const routed = toggleInlineMark({ doc, index, map, visFrom, visTo, kind })
    assert.equal(routed.ok, true, `expected a commit, got ${routed.code}`)
    const applied = applySourceTransaction(doc, routed.transaction)
    assert.equal(applied.ok, true, applied.code)
    return applied.doc.text
  }
  assert.equal(commit(2, 3), 'a [**b**](u) c\n', 'bold INSIDE the link label still commits')
  assert.equal(commit(0, 5), '**a [b](u) c**\n', 'bold CONTAINING the whole link still commits')
  assert.equal(commit(4, 5), 'a [b](u) **c**\n', 'bold entirely after the link still commits')
  assert.equal(commit(0, 1), '**a** [b](u) c\n', 'bold entirely before the link still commits')
}

// The same class, pinned for every OTHER delimiter-bearing node type in the
// shared set. These are width-1 visible ATOMS, so a visible offset can never
// land mid-node and the refusal is belt-and-braces rather than the reachable
// hole `link` was — but "unreachable today" is a claim that has to be
// re-provable, not remembered, so each one is exercised: a range that CONTAINS
// the atom commits, and the atom's own interior is simply not addressable.
{
  const atomCase = (src, needle, visAtom) => {
    const { doc, index, map } = blockSetup(src, 0)
    // The atom occupies exactly ONE visible slot.
    const before = toggleInlineMark({ doc, index, map, visFrom: 0, visTo: visAtom, kind: 'strong' })
    const covering = toggleInlineMark({ doc, index, map, visFrom: visAtom, visTo: visAtom + 1, kind: 'strong' })
    return { before, covering, needle }
  }
  // inline image: 'a ![i](p.png) b\n' -> visible 'a X b' (X = the atom at 2).
  {
    const { covering } = atomCase('a ![i](p.png) b\n', '![i](p.png)', 2)
    assert.equal(covering.ok, true, 'a range covering the whole image atom is legal')
    const applied = applySourceTransaction(createMarkdownDocument('a ![i](p.png) b\n'), covering.transaction)
    assert.equal(applied.doc.text, 'a **![i](p.png)** b\n')
  }
  // inline math
  {
    const { covering } = atomCase('a $x^2$ b\n', '$x^2$', 2)
    assert.equal(covering.ok, true, 'a range covering the whole inline-math atom is legal')
    const applied = applySourceTransaction(createMarkdownDocument('a $x^2$ b\n'), covering.transaction)
    assert.equal(applied.doc.text, 'a **$x^2$** b\n')
  }
  // inline HTML (a coalesced run is ONE atom on both chains)
  {
    const { covering } = atomCase('a <span>y</span> b\n', '<span>y</span>', 2)
    assert.equal(covering.ok, true, 'a range covering the whole inline-HTML run is legal')
    const applied = applySourceTransaction(createMarkdownDocument('a <span>y</span> b\n'), covering.transaction)
    assert.equal(applied.doc.text, 'a **<span>y</span>** b\n')
  }
  // footnoteReference — remark-gfm parses `[^1]` as an atom when a definition
  // exists. Whatever it decodes to, no wrap may straddle it.
  {
    const src = 'a [^1] b\n\n[^1]: note\n'
    const { doc, index, map } = blockSetup(src, 0)
    for (let visFrom = 0; visFrom <= map.visibleLength; visFrom += 1) {
      for (let visTo = visFrom + 1; visTo <= map.visibleLength; visTo += 1) {
        const routed = toggleInlineMark({ doc, index, map, visFrom, visTo, kind: 'strong' })
        if (!routed.ok) continue
        const applied = applySourceTransaction(doc, routed.transaction)
        assert.equal(applied.ok, true, applied.code)
        // Every ACCEPTED wrap must leave the footnote reference's own bytes
        // contiguous — never '[^**1]' or '**[^**1]'.
        assert.ok(!/\[\^\*|\*\]/.test(applied.doc.text),
          `a wrap straddled the footnote reference: ${JSON.stringify(applied.doc.text)}`)
      }
    }
  }
}

// ===========================================================================
// WHOLE-BRANCH REVIEW, CRITICAL 3 (2026-08-17): no raw-offset write may
// bisect a CRLF pair.
//
// `bisectsLineEnding` answered `true` at such an offset, but only three of
// the five raw-offset write paths asked it. The structural path never did:
//   'one\r\ntwo three\r\n', visible 4 -> raw 4, bisectsLineEnding = true
//   routeStructuralKey('Enter') -> ok
//   result: 'one\r\r\n\r\n\ntwo three\r\n'  (lone CR + bare LF)
// The fix is layered: `applySourceTransaction` (markdown-document.js) refuses
// the write BY CONSTRUCTION for every command, and the three paths that were
// unguarded/incidentally-safe now say so explicitly. Both layers are pinned.
// ===========================================================================
{
  const crlf = 'one\r\ntwo three\r\n'
  const doc = createMarkdownDocument(crlf)
  const index = buildSyntaxIndex(crlf)

  // (a) the structural router — the reachable-from-a-keypress hole.
  for (const key of ['Enter', 'Tab', 'Shift-Tab', 'Backspace', 'Delete']) {
    assert.deepEqual(routeStructuralKey(key, { doc, index, offset: 4, empty: true }),
      { ok: false, code: 'unsupported-structure' },
      `${key} at an intra-CRLF offset must refuse`)
  }
  // The SAME keys one byte either side keep their pre-fix answers — the guard
  // is a point refusal, not a CRLF-document-wide freeze.
  assert.equal(routeStructuralKey('Enter', { doc, index, offset: 3, empty: true }).ok, true,
    'Enter at the end of the first visual line still splits')
  assert.equal(routeStructuralKey('Enter', { doc, index, offset: 5, empty: true }).ok, true,
    'Enter at the start of the second visual line still splits')

  // (b) the chokepoint — a hand-built transaction at the same offset, i.e.
  // any future command that forgets to ask. This is the RED assertion: the
  // committed text must NEVER be the lone-CR/bare-LF document again.
  const splitEnter = { baseRevision: 0, from: 4, to: 4, insert: '\r\n\r\n', intent: 'split-block' }
  const applied = applySourceTransaction(doc, splitEnter)
  assert.deepEqual(applied, { ok: false, code: 'invalid-range' },
    "applySourceTransaction must refuse the write that produced 'one\\r\\r\\n\\r\\n\\ntwo three\\r\\n'")
  // both ends are checked, and multi-edit transactions too
  assert.equal(applySourceTransaction(doc, { baseRevision: 0, from: 2, to: 4, insert: 'X' }).code, 'invalid-range')
  assert.equal(applySourceTransaction(doc, { baseRevision: 0, from: 4, to: 6, insert: 'X' }).code, 'invalid-range')
  assert.equal(applySourceTransaction(doc, {
    baseRevision: 0,
    edits: [{ from: 0, to: 1, insert: 'O' }, { from: 4, to: 4, insert: 'X' }]
  }).code, 'invalid-range', 'a bisecting edit anywhere in the list refuses the whole transaction')
  // GREEN control: writes that do NOT bisect the pair still commit, and the
  // document stays uniformly CRLF.
  const ok = applySourceTransaction(doc, { baseRevision: 0, from: 3, to: 5, insert: '\r\n\r\n' })
  assert.equal(ok.ok, true, ok.code)
  assert.equal(ok.doc.text, 'one\r\n\r\ntwo three\r\n')
  assert.equal(/\r(?!\n)/.test(ok.doc.text), false, 'no lone \\r')
  assert.equal(/(?<!\r)\n/.test(ok.doc.text), false, 'no bare \\n')

  // (c) replaceVisibleText — under the widened model (2026-08-21) the
  // intra-pair boundary is NOT a visible offset at all: vis 4 is the start
  // of 'two'. The former refusals are unreachable by construction (the
  // byte-level chokepoint in (b) still refuses raw-arithmetic writes there);
  // these are ordinary edits now, and each must keep the file uniformly CRLF.
  const block = index.blockAt(0)
  const map = buildCharacterMap(crlf, block.node)
  const insertAt4 = replaceVisibleText({ doc, map, visFrom: 4, visTo: 4, insert: 'X' })
  assert.equal(insertAt4.ok, true, insertAt4.code)
  assert.equal(applySourceTransaction(doc, insertAt4.transaction).doc.text, 'one\r\nXtwo three\r\n')
  const acrossBreak = replaceVisibleText({ doc, map, visFrom: 0, visTo: 4, insert: 'X' })
  assert.equal(acrossBreak.ok, true, acrossBreak.code)
  assert.equal(applySourceTransaction(doc, acrossBreak.transaction).doc.text, 'Xtwo three\r\n')
  const fromBreak = replaceVisibleText({ doc, map, visFrom: 4, visTo: 8, insert: 'X' })
  assert.equal(fromBreak.ok, true, fromBreak.code)
  assert.equal(applySourceTransaction(doc, fromBreak.transaction).doc.text, 'one\r\nXthree\r\n')
  const kept = replaceVisibleText({ doc, map, visFrom: 0, visTo: 3, insert: 'ONE' })
  assert.equal(kept.ok, true, kept.code)
  assert.equal(applySourceTransaction(doc, kept.transaction).doc.text, 'ONE\r\ntwo three\r\n')

  // (d) toggleInlineMark — safe only INCIDENTALLY before this fix (its
  // whitespace shrink treats a `linebreak` unit as whitespace and steps past
  // it), now stated explicitly. The shrink is why these two still commit
  // rather than refuse: the assertion is that whatever they commit keeps the
  // file uniformly CRLF.
  for (const [visFrom, visTo] of [[0, 4], [4, 8], [0, 8]]) {
    const routed = toggleInlineMark({ doc, index, map, visFrom, visTo, kind: 'strong' })
    if (!routed.ok) continue
    const out = applySourceTransaction(doc, routed.transaction)
    assert.equal(out.ok, true, out.code)
    assert.equal(/\r(?!\n)/.test(out.doc.text), false, `lone \\r from a mark toggle [${visFrom},${visTo})`)
    assert.equal(/(?<!\r)\n/.test(out.doc.text), false, `bare \\n from a mark toggle [${visFrom},${visTo})`)
  }
}

// ---------------------------------------------------------------------------
// Visually-empty list items (2026-08-22): a plain bullet/ordered item whose
// decoded content is ONLY invisible whitespace (authored U+00A0 from older
// builds' undissolved seeds, stray spaces/tabs) LOOKS empty but is byte-non-
// empty, so every deletion path refused it — the user-reported "无法删除"
// wedge. The structural gestures now treat it as empty (the task-seed
// precedent, extended to AUTHORED whitespace for the explicit whole-item
// gesture): Backspace/Enter exit deletes the whole marker line, whitespace
// included. TASK items keep their pinned authored-seed doctrine untouched,
// and any real content keeps the previous not-structural answer.
{
  const src = '- 你好啊\n- \u00A0\n\n3132312\n'
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  const offset = src.indexOf('- \u00A0') + 2
  for (const key of ['Backspace', 'Enter']) {
    const r = routeStructuralKey(key, { doc, index, offset, empty: true })
    assert.equal(r.ok, true, key + ' must route the visually-empty item to the exit: ' + (r.code || ''))
    assert.equal(applySourceTransaction(doc, r.transaction).doc.text,
      '- 你好啊\n\n\n3132312\n', key + ' must delete the whole marker line, NBSP included (the surplus blank collapses on reparse — the established exit spelling)')
  }
}
{
  // Trailing-run variant deletes its whole line too.
  const src = '- \u00A0  \n'
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  const r = routeStructuralKey('Backspace', { doc, index, offset: 2, empty: true })
  assert.equal(r.ok, true, 'whitespace-run item must exit: ' + (r.code || ''))
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text, '\n')
}
{
  // CONTROLS. Real content keeps the text path; an authored-NBSP TASK item
  // keeps the pinned doctrine (never deleted by the structural gesture).
  const src = '- \u00A0甲\n'
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  const r = routeStructuralKey('Backspace', { doc, index, offset: 2, empty: true })
  assert.equal(r.ok, false, 'NBSP followed by real text is CONTENT')
  assert.equal(r.code, 'not-structural')
  const tsrc = '- [ ] \u00A0\n'
  const tdoc = createMarkdownDocument(tsrc)
  const tindex = buildSyntaxIndex(tsrc)
  const rt = routeStructuralKey('Backspace', { doc: tdoc, index: tindex, offset: 6, empty: true })
  assert.equal(rt.ok, false, 'an authored task seed keeps its own doctrine (no ledger entry -> content)')
}

// ---------------------------------------------------------------------------
// SESSION-LEDGERED WHITESPACE TASK ITEM (2026-08-22, user screenshot: a task
// list where Space-then-Enter on a fresh item bred endless seeded siblings).
// Enter splits a seeded task, Space is spelled U+00A0 by the trailing
// machinery \u2014 the label is now TWO session NBSPs. Byte-wise that is a real
// task, but every byte of it is ledger-vouched session whitespace: the item
// stands for NO content, so Enter/Backspace must take the SAME empty exit the
// single seed takes. The provenance partition is what keeps the pinned
// authored-seed doctrine intact: any unledgered NBSP keeps the item CONTENT
// (an author's honest `- [ ] \u00A0` still splits, never deletes).
{
  const NB = '\u00A0'
  // Earn the ledger through the real commands: Enter at \u7532's end seeds the
  // continuation; the spelled Space arrives as a transaction carrying its own
  // mark (the exact shape trailing-whitespace.js commits).
  let doc = createMarkdownDocument('- [ ] \u7532\n')
  let index = buildSyntaxIndex(doc.text)
  const split = routeStructuralKey('Enter', { doc, index, offset: 7, empty: false })
  assert.equal(split.ok, true, 'the split must seed: ' + (split.code || ''))
  doc = applySourceTransaction(doc, split.transaction).doc
  assert.equal(doc.text, '- [ ] \u7532\n- [ ] ' + NB + '\n')
  const seedAt = doc.text.lastIndexOf(NB)
  doc = applySourceTransaction(doc, {
    baseRevision: doc.revision,
    from: seedAt + 1,
    to: seedAt + 1,
    insert: NB,
    intent: 'block-trailing-whitespace',
    selection: { anchor: seedAt + 2, head: seedAt + 2 },
    whitespaceMarks: [{ from: seedAt + 1, to: seedAt + 2, ascii: ' ' }]
  }).doc
  assert.equal(doc.text, '- [ ] \u7532\n- [ ] ' + NB + NB + '\n')
  assert.equal(doc.whitespaceMarks.length, 2, 'both bytes are vouched')
  index = buildSyntaxIndex(doc.text)
  const enter = routeStructuralKey('Enter', { doc, index, offset: seedAt + 2, empty: true })
  assert.equal(enter.ok, true,
    'Enter on an all-ledgered whitespace task label must take the empty exit: ' + (enter.code || ''))
  assert.equal(enter.transaction.intent, 'exit-empty-list-item',
    'Enter must exit, not split another seed (got ' + enter.transaction.intent + ')')
  assert.equal(applySourceTransaction(doc, enter.transaction).doc.text, '- [ ] \u7532\n\n')
  // Backspace keeps its per-keystroke granularity on the two-byte label: the
  // text path deletes the spelled space (a representable task remains), so
  // the router answers not-structural here \u2014 and routes the LINE exit only
  // once a single character is left.
  const back = routeStructuralKey('Backspace', { doc, index, offset: seedAt + 2, empty: true })
  assert.equal(back.ok, false, 'two-byte label: Backspace stays on the text path')
  assert.equal(back.code, 'not-structural')
  // CONTROL: the SAME bytes with an empty ledger (a reopened file) are the
  // author's content \u2014 Enter still splits, Backspace still refuses.
  const cold = createMarkdownDocument(doc.text)
  const cindex = buildSyntaxIndex(cold.text)
  const ce = routeStructuralKey('Enter', { doc: cold, index: cindex, offset: seedAt + 2, empty: false })
  assert.equal(ce.ok && ce.transaction.intent, 'split-list-item',
    'unledgered NBSPs are authored content \u2014 Enter splits')
  const cb = routeStructuralKey('Backspace', { doc: cold, index: cindex, offset: seedAt + 2, empty: true })
  assert.equal(cb.ok, false, 'unledgered NBSPs are authored content \u2014 Backspace keeps the refusal')
  // CONTROL: a PARTIAL ledger (one vouched byte next to an authored one) is
  // not claimed either \u2014 the partition never rounds up.
  const partial = createMarkdownDocument(doc.text)
  partial.whitespaceMarks.push({ from: seedAt, to: seedAt + 1, ascii: '' })
  const pindex = buildSyntaxIndex(partial.text)
  const pe = routeStructuralKey('Enter', { doc: partial, index: pindex, offset: seedAt + 2, empty: false })
  assert.equal(pe.ok && pe.transaction.intent, 'split-list-item',
    'a half-vouched label stays content \u2014 Enter splits')
}

// ---------------------------------------------------------------------------
// deleteEmptyCodeBlock (2026-08-22): an EMPTY fence — especially as a quote's
// LAST block — was an unremovable island (no line below to stand on, the
// block handle hidden in kernel mode). Backspace inside the empty CM editor
// now deletes the whole fence: the exitEmptyListItem posture, keeping the
// line prefix so the caret machinery lands a quote-body line.
{
  const src = '> 甲\n> ```\n> ```\n\n# 后\n'
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  const start = src.indexOf('```')
  const r = deleteEmptyCodeBlock({ doc, index, offset: start })
  assert.equal(r.ok, true, 'quoted empty fence must delete: ' + (r.code || ''))
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text, '> 甲\n> \n\n# 后\n')
  assert.equal(r.transaction.selection.anchor, src.indexOf('```'))
}
{
  // Top-level empty fence deletes to a blank line.
  const src = '甲\n\n```js\n```\n\n乙\n'
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  const r = deleteEmptyCodeBlock({ doc, index, offset: src.indexOf('```') })
  assert.equal(r.ok, true, 'top-level empty fence must delete: ' + (r.code || ''))
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text, '甲\n\n\n\n乙\n')
}
{
  // NON-empty fences refuse — deletion is only for the empty island.
  const src = '```js\nx\n```\n'
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  const r = deleteEmptyCodeBlock({ doc, index, offset: 0 })
  assert.equal(r.ok, false, 'a fence with content must refuse')
}

console.log('PASS source-kernel commands (whole-branch review: link-boundary wraps + CRLF bisection chokepoint)')
