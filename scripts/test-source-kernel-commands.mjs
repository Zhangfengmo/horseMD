import assert from 'node:assert/strict'
import { createMarkdownDocument, applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { buildSyntaxIndex } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { buildCharacterMap } from '../src/renderer/src/lib/source-kernel/character-map.js'
import { replaceVisibleText } from '../src/renderer/src/lib/source-kernel/commands/replace-text.js'
import { toggleTaskMarker } from '../src/renderer/src/lib/source-kernel/commands/task-toggle.js'
import { splitTextBlock, splitListItem, exitEmptyListItem } from '../src/renderer/src/lib/source-kernel/commands/enter.js'
import { changeCodeLanguage } from '../src/renderer/src/lib/source-kernel/commands/code-language.js'
import { toggleInlineMark } from '../src/renderer/src/lib/source-kernel/commands/mark-toggle.js'
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
  // bold word, click bold again" scenario). inlineCode is an ATOM in the
  // character map (character-map.js's ATOMS set) — its content bytes can
  // never appear alone as a visible selection, only the whole span
  // (backticks included) can be selected as one indivisible unit — so its
  // round-trip selection targets the atom's OUTER bounds instead of the
  // content-only bounds every other kind uses.
  const doc2 = createMarkdownDocument(expectedWrapped)
  const index2 = buildSyntaxIndex(expectedWrapped)
  const selFrom = kind === 'inlineCode' ? rawFrom : rawFrom + marker.length
  const selTo = kind === 'inlineCode' ? rawTo + 2 * marker.length : rawTo + marker.length
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

// A selection spanning the whole paragraph, including an inlineCode atom,
// is a legal WRAP around the entire content (the atom sits strictly inside
// the selection — full containment, not a straddle).
{
  const src = 'a `code` b\n'
  const { doc, index, map } = blockSetup(src, 0)
  const r = toggleInlineMark({ doc, index, map, visFrom: 0, visTo: map.visibleLength, kind: 'strong' })
  assert.equal(r.ok, true, r.code)
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text, '**a `code` b**\n')
}

console.log('PASS source-kernel commands (toggleInlineMark)')
