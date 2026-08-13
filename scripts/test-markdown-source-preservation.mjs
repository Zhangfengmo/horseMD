import assert from 'node:assert/strict'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import {
  compactGeneratedListSpacing,
  generatedScratchMarkdown,
  preserveGeneratedBulletMarkers,
  preserveRichMarkdownSource,
  preserveTypedBulletInputRule,
  replaceMarkdownFrontmatterBlock,
  replaceMarkdownListBlock,
  restoreTypedBulletMarker
} from '../src/renderer/src/markdown-source-preservation.js'
import { normalizeEmptyListItems } from '../src/renderer/src/lib/markdown-preservation/lists.js'
import { sourceVisibleIndex } from '../src/renderer/src/mode-visible-map.js'
import { adoptAdjacentBulletMarker, commonChange } from '../src/renderer/src/lib/markdown-preservation/core.js'
import { createGfmTableSourceParser } from '../src/renderer/src/lib/markdown-preservation/table-source-model.js'
import {
  preserveLocallyAlignedTextChange,
  preserveUniquelyAnchoredTextChange
} from '../src/renderer/src/lib/markdown-preservation/regions.js'
import {
  applySlashBlockSourceIntent,
  captureSlashBlockSourceIntent
} from '../src/renderer/src/components/editor-slash-source.js'

const source = [
  '# 一级标题',
  '## 二级标题',
  '这里是区间：0~9。',
  '',
  '- 第一项末尾\\',
  '  这是同一个列表项中的换行',
  '- 第二项',
  '',
  '这一段不要修改。'
].join('\n')

const slashSource = '前文\r\n\r\n# /code\r\n\r\n后文\r\n'
const slashIntent = captureSlashBlockSourceIntent({
  source: slashSource,
  queryText: '/code',
  sourceOffset: slashSource.indexOf('/code') + 5,
  id: 'code'
})
assert.ok(slashIntent, 'slash code intent must locate its exact authored block')
assert.equal(
  applySlashBlockSourceIntent({ intent: slashIntent, blockMarkdown: '```js\n\n```\n' }),
  '前文\r\n\r\n```js\r\n\r\n```\r\n\r\n后文\r\n',
  'slash code conversion must atomically replace only its block and retain CRLF'
)
const slashMathSource = '前文\r\n\r\n/math\r\n\r\n后文\r\n'
const slashMathIntent = captureSlashBlockSourceIntent({
  source: slashMathSource,
  queryText: '/math',
  sourceOffset: slashMathSource.indexOf('/math') + 5,
  id: 'math'
})
assert.ok(slashMathIntent, 'slash math intent must locate its exact authored block')
assert.equal(
  applySlashBlockSourceIntent({ intent: slashMathIntent, blockMarkdown: '```latex\nx^2\n```\n' }),
  '前文\r\n\r\n```latex\r\nx^2\r\n```\r\n\r\n后文\r\n',
  'slash math conversion must use the same atomic source replacement as code'
)
assert.equal(
  captureSlashBlockSourceIntent({
    source: '/code\n\n/code\n',
    queryText: '/code',
    sourceOffset: null,
    id: 'code'
  }),
  null,
  'an unmapped repeated slash query must fail closed instead of replacing the wrong block'
)
const repeatedSlashSource = '/code\n\n正文\n\n/code\n'
const repeatedSlashIntent = captureSlashBlockSourceIntent({
  source: repeatedSlashSource,
  queryText: '/code',
  sourceOffset: repeatedSlashSource.lastIndexOf('/code') + 5,
  id: 'code'
})
assert.equal(
  applySlashBlockSourceIntent({ intent: repeatedSlashIntent, blockMarkdown: '```\n\n```\n' }),
  '/code\n\n正文\n\n```\n\n```\n',
  'a mapped repeated slash query must replace only the selected occurrence'
)
const mixedEndingSlashSource = '旧式行尾\r\n邻近行尾\n/code'
const mixedEndingSlashIntent = captureSlashBlockSourceIntent({
  source: mixedEndingSlashSource,
  queryText: '/code',
  sourceOffset: mixedEndingSlashSource.length,
  id: 'code'
})
assert.equal(
  applySlashBlockSourceIntent({ intent: mixedEndingSlashIntent, blockMarkdown: '```\n内容\n```\n' }),
  '旧式行尾\r\n邻近行尾\n```\n内容\n```',
  'a final slash block without its own EOL must inherit the nearest preceding line ending'
)

const slashTableSource = '前文\r\n\r\n/table\r\n\r\n后文\r\n'
const slashTableIntent = captureSlashBlockSourceIntent({
  source: slashTableSource,
  queryText: '/table',
  sourceOffset: slashTableSource.indexOf('/table') + 6,
  id: 'table'
})
assert.ok(slashTableIntent, 'slash table intent must locate its exact authored block')
assert.equal(
  applySlashBlockSourceIntent({
    intent: slashTableIntent,
    blockMarkdown: '| A | B |\n| --- | --- |\n|  | value |\n'
  }),
  '前文\r\n\r\n| A | B |\r\n| --- | --- |\r\n|  | value |\r\n\r\n后文\r\n',
  'slash table conversion must atomically replace only its command block and retain CRLF'
)

assert.equal(
  sourceVisibleIndex('硬换行  \n下一行').text,
  sourceVisibleIndex('硬换行\\\n下一行').text,
  'equivalent Markdown hard-break spellings must share one visible stream'
)

// This is the equivalent Markdown emitted by Crepe before any user edit.
const canonical = [
  '# 一级标题',
  '',
  '## 二级标题',
  '',
  '这里是区间：0\\~9。',
  '',
  '* 第一项末尾\\',
  '  这是同一个列表项中的换行',
  '',
  '* 第二项',
  '',
  '这一段不要修改。'
].join('\n')

const appended = preserveRichMarkdownSource(source, canonical, canonical + '！')
assert.equal(appended.preserved, true)
assert.equal(appended.markdown, source + '！')

const changedText = preserveRichMarkdownSource(
  source,
  canonical,
  canonical.replace('这一段不要修改。', '这一段已经修改。')
)
assert.equal(changedText.preserved, true)
assert.equal(changedText.markdown, source.replace('这一段不要修改。', '这一段已经修改。'))

const mismatch = preserveRichMarkdownSource('原文 A', '原文 B', '原文 C')
assert.equal(mismatch.preserved, false)
assert.equal(mismatch.markdown, '原文 A')
assert.equal(mismatch.reason, 'visible-stream-mismatch')

const mismatchAfterEditedLineSource = [
  '审计起点：0~9。',
  '',
  '后文保留单波浪号 A~B 和 C~D。'
].join('\n')
const mismatchAfterEditedLineCanonical = [
  '审计起点：0\\~9。',
  '',
  '后文保留单波浪号 AB 和 CD。'
].join('\n')
const mismatchAfterEditedLine = preserveRichMarkdownSource(
  mismatchAfterEditedLineSource,
  mismatchAfterEditedLineCanonical,
  mismatchAfterEditedLineCanonical.replace('审计起点', '审计起点X')
)
assert.equal(mismatchAfterEditedLine.preserved, true)
assert.equal(mismatchAfterEditedLine.reason, 'locally-aligned-change')
assert.equal(
  mismatchAfterEditedLine.markdown,
  mismatchAfterEditedLineSource.replace('审计起点', '审计起点X'),
  'a later visible-stream mismatch must not normalize untouched syntax on the locally edited line'
)

const headingEditMustNotRewriteUnchangedLists = preserveRichMarkdownSource(
  'SETEXT_TARGET\n=============\n\n- LIST_CHILD\n\n- [ ] TASK_TARGET\n',
  '# SETEXT\\_TARGET\n\n* LIST\\_CHILD\n\n* [ ] TASK\\_TARGET\n',
  '# SETEXT\\_TARGETX\n\n* LIST\\_CHILD\n\n* [ ] TASK\\_TARGET\n'
)
assert.equal(
  headingEditMustNotRewriteUnchangedLists.markdown,
  'SETEXT_TARGETX\n=============\n\n- LIST_CHILD\n\n- [ ] TASK_TARGET\n',
  'an unchanged canonical list must not consume or normalize an unrelated heading edit'
)

// A visible-stream divergence (source keeps a mid-line `* ` as paragraph text
// while remark parses it as a list item) defeats both locally-aligned and
// line-region mapping. A single-canonical-block text change whose block text
// occurs exactly once in the authored source must still reach the source, or
// a rich-text deletion is silently rolled back and resurrects on save.
const divergedDeleteSource = '# 测试\n\n前段。* **输入设备：** 内容\n\n第二段保留。\n'
const divergedDeletePrevious = '# 测试\n\n前段。\n\n* **输入设备：** 内容\n\n第二段保留。\n'
const divergedDeleteNext = '# 测试\n\n前段。\n\n* **内容**\n\n第二段保留。\n'
const divergedDelete = preserveRichMarkdownSource(
  divergedDeleteSource,
  divergedDeletePrevious,
  divergedDeleteNext
)
assert.equal(
  divergedDelete.reason,
  'diverged-block-change',
  'a diverged-stream deletion must map through the unique-block fallback'
)
assert.equal(
  divergedDelete.markdown,
  '# 测试\n\n前段。* **内容**\n\n第二段保留。\n',
  'the deleted text must vanish from source while the authored mid-line syntax survives'
)

// The real-app canonical spelling escapes the literal `*` as `\*` and the
// surviving trailing space as `&#x20;`. The fallback must use the unescaped
// canonical block to locate the authored occurrence, retain the author's
// literal `*`, and keep the entity where a raw trailing space would be lost on
// reparse.
const divergedEscapedDeleteSource = '# 测试\n\n前段。* **输入设备：** 内容\n\n第二段保留。\n'
const divergedEscapedDeletePrevious = '# 测试\n\n前段。\\* **输入设备：** 内容\n\n第二段保留。\n'
const divergedEscapedDeleteNext = '# 测试\n\n前段。\\*&#x20;\n\n第二段保留。\n'
const divergedEscapedDelete = preserveRichMarkdownSource(
  divergedEscapedDeleteSource,
  divergedEscapedDeletePrevious,
  divergedEscapedDeleteNext
)
assert.equal(
  divergedEscapedDelete.reason,
  'diverged-block-change',
  'a diverged-stream deletion must map through the unescaped unique-block fallback'
)
assert.equal(
  divergedEscapedDelete.markdown,
  '# 测试\n\n前段。*&#x20;\n\n第二段保留。\n',
  'the deleted text must vanish while literal punctuation and the durable trailing space both survive'
)

// A canonical-only empty-paragraph `<br />` placeholder must never reach
// authored source through the diverged-block fallback; those edits belong to
// the paragraph-emptied handlers.
const divergedBrBail = preserveRichMarkdownSource(
  'A\n\nB * **C** D\n',
  'A\n\nB \\* **C** D\n',
  'A\n\n<br />\n'
)
assert.equal(
  /<br\s*\/?>/.test(divergedBrBail.markdown || ''),
  false,
  'a standalone <br /> placeholder must not leak through the diverged-block fallback'
)

// Insertion direction through the same diverged block.
const divergedInsert = preserveRichMarkdownSource(
  divergedDeleteSource,
  divergedDeletePrevious,
  '# 测试\n\n前段。\n\n* **输入设备：** 新内容\n\n第二段保留。\n'
)
assert.equal(divergedInsert.preserved, true)
assert.equal(
  divergedInsert.markdown,
  '# 测试\n\n前段。* **输入设备：** 新内容\n\n第二段保留。\n',
  'a diverged-stream insertion must reach the source block'
)

// A normal standalone paragraph can be unique as a Markdown block even when
// its short text occurs many times inside headings, lists, and blockquotes.
// The real user document below permanently diverges because `- - text` is
// parsed as a nested list and ```text``` is serialized as inline code. Editing
// the standalone `测试` paragraph must still save instead of being
// rejected merely because other blocks contain the word “测试”.
const divergedOrdinarySource = [
  '# 测试',
  '',
  '## 你好',
  '',
  '- 你好 1. 2. 测试',
  '- - 测试 1. 你好',
  '- 测试 - 测试 1. 2. 测试',
  '',
  '```你好```',
  '',
  '> 你是谁',
  '>',
  '> 1',
  '>',
  '>',
  '',
  '测试',
  '',
  '> 测试',
  '>',
  '> 测试',
  ''
].join('\n')
const divergedOrdinaryCanonical = [
  '# 测试',
  '',
  '## 你好',
  '',
  '* 你好 1. 2. 测试',
  '',
  '* <br />',
  '',
  '  * 测试 1. 你好',
  '',
  '* 测试 - 测试 1. 2. 测试',
  '',
  '`你好`',
  '',
  '> 你是谁',
  '>',
  '> 1',
  '',
  '测试',
  '',
  '> 测试',
  '>',
  '> 测试',
  ''
].join('\n')
const divergedOrdinaryEdit = preserveRichMarkdownSource(
  divergedOrdinarySource,
  divergedOrdinaryCanonical,
  divergedOrdinaryCanonical.replace('\n测试\n\n> 测试', '\n测试普通编辑X\n\n> 测试')
)
assert.equal(
  divergedOrdinaryEdit.preserved,
  true,
  'a uniquely identified standalone block edit must not be paused by unrelated canonical divergence'
)
assert.equal(
  divergedOrdinaryEdit.markdown,
  divergedOrdinarySource.replace('\n测试\n\n> 测试', '\n测试普通编辑X\n\n> 测试'),
  'the ordinary paragraph edit must reach source without normalizing any unrelated block'
)

const repeatedDivergedParagraphSource = [
  '# A',
  '',
  '相同。* **输入设备：** 内容',
  '',
  '相同。* **输入设备：** 内容',
  '',
  '相同。* **输入设备：** 内容',
  '',
  '相同。* **输入设备：** 内容',
  ''
].join('\n')
const repeatedDivergedParagraphCanonical = repeatedDivergedParagraphSource.replaceAll('。* ', '。\\* ')
const repeatedDivergedRows = repeatedDivergedParagraphCanonical.split('\n')
repeatedDivergedRows[6] = '相同。\\* **内容**'
const repeatedDivergedParagraphEdit = preserveRichMarkdownSource(
  repeatedDivergedParagraphSource,
  repeatedDivergedParagraphCanonical,
  repeatedDivergedRows.join('\n')
)
assert.equal(
  repeatedDivergedParagraphEdit.preserved,
  true,
  'equal-count repeated standalone blocks must map by their canonical/source ordinal'
)
const repeatedExpectedRows = repeatedDivergedParagraphSource.split('\n')
repeatedExpectedRows[6] = '相同。* **内容**'
assert.equal(
  repeatedDivergedParagraphEdit.markdown,
  repeatedExpectedRows.join('\n'),
  'only the edited repeated block occurrence may change'
)

// Repeated block text is ambiguous: the fallback must fail closed and keep
// the authored source untouched instead of guessing which occurrence to edit.
const divergedRepeatedSource =
  '# A\n\n* **输入设备：** 内容\n\n前段。* **输入设备：** 内容\n'
const divergedRepeatedPrevious =
  '# A\n\n* **输入设备：** 内容\n\n前段。\n\n* **输入设备：** 内容\n'
const divergedRepeatedNext =
  '# A\n\n* **输入设备：** 内容\n\n前段。\n\n* **内容**\n'
const divergedRepeated = preserveRichMarkdownSource(
  divergedRepeatedSource,
  divergedRepeatedPrevious,
  divergedRepeatedNext
)
assert.equal(divergedRepeated.preserved, false)
assert.equal(divergedRepeated.reason, 'visible-stream-mismatch')
assert.equal(
  divergedRepeated.markdown,
  divergedRepeatedSource,
  'a repeated block must not be replaced through the unique-block fallback'
)

// A change spanning multiple canonical blocks (deleting a paragraph plus the
// following list item) must not use the block fallback; it keeps the existing
// fail-closed behavior.
const divergedMultiBlock = preserveRichMarkdownSource(
  divergedDeleteSource,
  divergedDeletePrevious,
  '# 测试\n\n第二段保留。\n'
)
assert.equal(
  divergedMultiBlock.preserved,
  false,
  'a multi-block diverged change must stay fail-closed'
)
assert.equal(
  divergedMultiBlock.markdown,
  divergedDeleteSource,
  'a multi-block diverged change must not corrupt the authored source'
)

const crlfSource = '\uFEFF# Windows 标题\r\n\r\n正文 0~9。\r\n\r\n- 紧凑一\r\n- 紧凑二\r\n'
const crlfCanonical = '# Windows 标题\n\n正文 0\\~9。\n\n* 紧凑一\n\n* 紧凑二\n'
const crlfTextEdited = preserveRichMarkdownSource(
  crlfSource,
  crlfCanonical,
  crlfCanonical.replace('正文', '正文X')
)
assert.equal(crlfTextEdited.preserved, true)
assert.equal(
  crlfTextEdited.markdown,
  crlfSource.replace('正文', '正文X'),
  'ordinary rich edits must retain UTF-8 BOM, CRLF, list compactness, and untouched escapes'
)

const crlfHeadingChanged = preserveRichMarkdownSource(
  crlfSource,
  crlfCanonical,
  crlfCanonical.replace('# Windows 标题', '## Windows 标题')
)
assert.equal(crlfHeadingChanged.preserved, true)
assert.equal(
  crlfHeadingChanged.markdown,
  crlfSource.replace('# Windows 标题', '## Windows 标题'),
  'a structural first-line edit must retain BOM and CRLF'
)

const crlfParagraphSplit = preserveRichMarkdownSource(
  crlfSource,
  crlfCanonical,
  crlfCanonical.replace('正文 0\\~9。', '正文\n\n0\\~9。')
)
assert.equal(crlfParagraphSplit.preserved, true)
assert.equal(
  crlfParagraphSplit.markdown,
  crlfSource.replace('正文 0~9。', '正文\r\n\r\n0~9。'),
  'new rich-text block separators must follow the source CRLF convention'
)

const unrelatedFormattingSource = [
  '| A | B |',
  '| --- | --- |',
  '| one | two |',
  '',
  '- tight one',
  '- tight two',
  '',
  'Hard break first\\',
  'target after break',
  '',
  '```js',
  'const after = true',
  '```'
].join('\n')
const unrelatedFormattingCanonical = [
  '| A   | B   |',
  '| --- | --- |',
  '| one | two |',
  '',
  '* tight one',
  '',
  '* tight two',
  '',
  'Hard break first\\',
  'target after break',
  '',
  '```js',
  'const after = true',
  '```'
].join('\n')
const paragraphInsertedAfterHardBreak = preserveRichMarkdownSource(
  unrelatedFormattingSource,
  unrelatedFormattingCanonical,
  unrelatedFormattingCanonical.replace(
    'target after break\n\n```js',
    'target after break\n\nXYZ\n\n```js'
  )
)
assert.equal(paragraphInsertedAfterHardBreak.preserved, true)
assert.equal(paragraphInsertedAfterHardBreak.reason, 'middle-block-inserted')
assert.equal(
  paragraphInsertedAfterHardBreak.markdown,
  unrelatedFormattingSource.replace(
    'target after break\n\n```js',
    'target after break\n\nXYZ\n\n```js'
  ),
  'unrelated table/list formatting must not merge a newly inserted paragraph into a hard-break line'
)

const listTextEdited = preserveRichMarkdownSource(
  source,
  canonical,
  canonical.replace('第一项末尾', '第一项末尾（已修改）')
)
assert.equal(listTextEdited.preserved, true)
assert.equal(listTextEdited.reason, 'batched-list-row-changes')
assert.equal(
  listTextEdited.markdown,
  source.replace('第一项末尾', '第一项末尾（已修改）'),
  'editing list text must not change authored markers or insert loose-list blank lines'
)

const frontmatterSource = [
  '---',
  'name: deploy',
  'description: untouched source spelling',
  '---',
  '',
  '# Keep this heading',
  '',
  'Here is 0~9, which must not be escaped.'
].join('\n')
const frontmatterNext = [
  '---',
  'name: publish',
  'description: changed in rich mode',
  '---',
  '',
  '# Keep this heading',
  '',
  'Here is 0\\~9, which must not be escaped.'
].join('\n')
assert.equal(
  replaceMarkdownFrontmatterBlock({
    source: frontmatterSource,
    next: frontmatterNext,
    sourceOffset: 8,
    nextOffset: 8
  }),
  frontmatterSource.replace(
    'name: deploy\ndescription: untouched source spelling',
    'name: publish\ndescription: changed in rich mode'
  )
)

const tableSource = [
  '# 保持标题格式',
  '',
  '这里是区间：0~9。',
  '',
  'A | B',
  '--- | ---',
  'old-a | old-b',
  '',
  '这段不要改。'
].join('\n')
const tableCanonical = tableSource
  .replace('0~9', '0\\~9')
  .replace('A | B\n--- | ---\nold-a | old-b', [
    '| A     | B     |',
    '| ----- | ----- |',
    '| old-a | old-b |'
  ].join('\n'))
const tableNext = tableCanonical.replace('| old-a | old-b |', '| old-a | old-b |\n| new-a | new-b |')
const tableChanged = preserveRichMarkdownSource(tableSource, tableCanonical, tableNext)
assert.equal(tableChanged.preserved, true)
assert.equal(tableChanged.reason, 'table-structure')
assert.equal(tableChanged.markdown, [
  '# 保持标题格式',
  '',
  '这里是区间：0~9。',
  '',
  '| A     | B     |',
  '| ----- | ----- |',
  '| old-a | old-b |',
  '| new-a | new-b |',
  '',
  '这段不要改。'
].join('\n'))

const tableCellEdited = preserveRichMarkdownSource(
  tableSource,
  tableCanonical,
  tableCanonical.replace('old-a', 'edited-a')
)
assert.equal(tableCellEdited.preserved, true)
assert.equal(
  tableCellEdited.markdown,
  tableSource.replace('old-a', 'edited-a'),
  'editing table text must not normalize the table or unrelated prose'
)

const tableCanonicalRealigned = [
  '| A            |              B |',
  '| :----------- | -------------: |',
  '| TABLE\\_CELL | second<br>line |'
].join('\n')
const tableCanonicalRealignedNext = [
  '| A             |              B |',
  '| :------------ | -------------: |',
  '| TABLE\\_CELLX | second<br>line |'
].join('\n')
const tableRealignedTextEdit = preserveRichMarkdownSource(
  'A | B\n:--- | ---:\nTABLE_CELL | second<br>line',
  tableCanonicalRealigned,
  tableCanonicalRealignedNext
)
assert.equal(tableRealignedTextEdit.reason, 'table-cell-text')
assert.equal(
  tableRealignedTextEdit.markdown,
  'A | B\n:--- | ---:\nTABLE_CELLX | second<br>line',
  'serializer column padding changes must not reformat an authored table during a cell text edit'
)

const configuredTableParser = createGfmTableSourceParser(
  unified().use(remarkParse).use(remarkGfm)
)
let configuredTableParseCalls = 0
const injectedTableParser = (markdown) => {
  configuredTableParseCalls += 1
  return configuredTableParser(markdown)
}
const injectedTableEdit = preserveRichMarkdownSource(
  '| A | B |\n| - | - |\n| source | stable |',
  '| A | B |\n| - | - |\n| source | stable |',
  '| A | B |\n| - | - |\n| sourceX | stable |',
  { parseTables: injectedTableParser }
)
assert.equal(injectedTableEdit.reason, 'table-cell-text')
assert.ok(configuredTableParseCalls >= 3, 'the four-argument API routes table ownership through the injected parser')

const unownedTableEdit = preserveRichMarkdownSource(
  '| A | B |\n| - | - |\n| authored | stable |',
  '| A | B |\n| - | - |\n| different | stable |',
  '| A | B |\n| - | - |\n| different | typed |',
  { parseTables: injectedTableParser }
)
assert.equal(unownedTableEdit.preserved, false)
assert.equal(unownedTableEdit.blocked, true)
assert.equal(unownedTableEdit.reason, 'authored-previous-table-mismatch')
assert.equal(
  unownedTableEdit.markdown,
  '| A | B |\n| - | - |\n| authored | stable |',
  'an unowned table edit must not fall through to the visible or generic line mappers'
)

const listSource = [
  '# 保持标题格式',
  '',
  '这里是区间：0~9。',
  '',
  '- Alpha',
  '  - Child',
  '- Beta',
  '',
  '两个列表之间的正文。',
  '',
  '- [ ] 不要转换的任务',
  '',
  '这段不要改。'
].join('\n')
const listCanonical = [
  '# 保持标题格式',
  '',
  '这里是区间：0\\~9。',
  '',
  '* Alpha',
  '  * Child',
  '',
  '* Beta',
  '',
  '两个列表之间的正文。',
  '',
  '* [ ] 不要转换的任务',
  '',
  '这段不要改。'
].join('\n')
const listNext = [
  '# 保持标题格式',
  '',
  '这里是区间：0\\~9。',
  '',
  '1. Alpha',
  '   1. Child',
  '2. Beta',
  '',
  '两个列表之间的正文。',
  '',
  '* [ ] 不要转换的任务',
  '',
  '这段不要改。'
].join('\n')

const listItemInserted = preserveRichMarkdownSource(
  listSource,
  listCanonical,
  listCanonical.replace('* Beta', '* Inserted\n\n* Beta')
)
assert.equal(listItemInserted.preserved, true)
assert.equal(listItemInserted.markdown, [
  '# 保持标题格式',
  '',
  '这里是区间：0~9。',
  '',
  '- Alpha',
  '  - Child',
  '- Inserted',
  '- Beta',
  '',
  '两个列表之间的正文。',
  '',
  '- [ ] 不要转换的任务',
  '',
  '这段不要改。'
].join('\n'), 'adding one item must keep the authored compact-list and bullet style')

// A delayed markdownUpdated can batch several independent edits before the
// preservation layer sees a new canonical snapshot. Distinct neighbouring
// `-`, `+` and `*` lists must still retain their own authored spelling rather
// than inheriting the serializer's marker from whichever list is first.
const mixedMarkerSource = [
  '- dash-one',
  '- dash-two',
  '',
  '+ plus-one',
  '+ plus-two',
  '',
  '* star-one',
  '* star-two',
  '',
  '1) paren-one',
  '2) paren-two'
].join('\n')
const mixedMarkerCanonical = [
  '* dash-one',
  '',
  '* dash-two',
  '',
  '- plus-one',
  '',
  '- plus-two',
  '',
  '* star-one',
  '',
  '* star-two',
  '',
  '1. paren-one',
  '2. paren-two'
].join('\n')
const mixedMarkerBatch = preserveRichMarkdownSource(
  mixedMarkerSource,
  mixedMarkerCanonical,
  [
    '* dash-one',
    '',
    '* dash-two',
    '',
    '* dash-three',
    '',
    '- plus-one',
    '',
    '- plus-two',
    '',
    '- plus-three',
    '',
    '* star-one',
    '',
    '<br />',
    '',
    '1. paren-one',
    '2. paren-two'
  ].join('\n')
)
assert.equal(mixedMarkerBatch.preserved, true)
assert.equal(mixedMarkerBatch.markdown, [
  '- dash-one',
  '- dash-two',
  '- dash-three',
  '',
  '+ plus-one',
  '+ plus-two',
  '+ plus-three',
  '',
  '* star-one',
  '',
  '1) paren-one',
  '2) paren-two'
].join('\n'), 'batched independent list edits must retain per-list markers and omit transient empty blocks')

const mixedMarkerFirstItemBatch = preserveRichMarkdownSource(
  mixedMarkerSource,
  mixedMarkerCanonical,
  mixedMarkerCanonical
    .replace('- plus-one', '- plus-one-X')
    .replace('* star-two', '* star-two-X')
)
assert.equal(
  mixedMarkerFirstItemBatch.markdown,
  mixedMarkerSource
    .replace('+ plus-one', '+ plus-one-X')
    .replace('* star-two', '* star-two-X'),
  'changing a neighbouring list first item must not absorb, duplicate, or rewrite later list blocks'
)

const equalCountCrossListMove = preserveRichMarkdownSource(
  '- dash-one\n- dash-two\n\n+ plus-one\n+ plus-two',
  '* dash-one\n\n* dash-two\n\n- plus-one\n\n- plus-two',
  '* dash-one\n\n* dash-two\n\n* dash-three\n\n- plus-one'
)
assert.equal(
  equalCountCrossListMove.markdown,
  '- dash-one\n- dash-two\n- dash-three\n\n+ plus-one',
  'equal total row counts must not make an insertion in one list inherit a deleted row identity from another list'
)

const equalCountDeleteNextFirst = preserveRichMarkdownSource(
  '- dash-one\n- dash-two\n\n+ plus-one\n+ plus-two',
  '* dash-one\n\n* dash-two\n\n- plus-one\n\n- plus-two',
  '* dash-one\n\n* dash-two\n\n* dash-three\n\n- plus-two'
)
assert.equal(
  equalCountDeleteNextFirst.markdown,
  '- dash-one\n- dash-two\n- dash-three\n\n+ plus-two',
  'deleting the next list first item must use a surviving fence instead of falling into generic offset mapping'
)

const equalCountDeleteNextFirstCrlf = preserveRichMarkdownSource(
  '- dash-one\r\n- dash-two\r\n\r\n+ plus-one\r\n+ plus-two',
  '* dash-one\n\n* dash-two\n\n- plus-one\n\n- plus-two',
  '* dash-one\n\n* dash-two\n\n* dash-three\n\n- plus-two'
)
assert.equal(
  equalCountDeleteNextFirstCrlf.markdown,
  '- dash-one\r\n- dash-two\r\n- dash-three\r\n\r\n+ plus-two',
  'the surviving-fence batch path must retain CRLF as well as per-list markers'
)

const unownedMultiListBatch = preserveRichMarkdownSource(
  '- dash-one\n- dash-two\n\n+ plus-one\n+ plus-two',
  '* dash-one\n\n* dash-two\n\n- plus-one\n\n- plus-two',
  '* dash-one\n\n* dash-two\n\n* dash-three'
)
assert.equal(unownedMultiListBatch.preserved, false)
assert.equal(unownedMultiListBatch.reason, 'unmapped-batched-list-change')
assert.equal(
  unownedMultiListBatch.markdown,
  '- dash-one\n- dash-two\n\n+ plus-one\n+ plus-two',
  'an unowned multi-list batch must fail closed before any generic mapper can corrupt list boundaries'
)

const typedListItemAppended = preserveRichMarkdownSource(
  '- 第一项\n\n',
  '* 第一项\n\n',
  '* 第一项\n\n* 第二项\n\n'
)
assert.equal(
  typedListItemAppended.markdown,
  '- 第一项\n- 第二项\n\n',
  'a newly typed compact list must keep its authored marker when Enter adds another item'
)

assert.equal(
  preserveRichMarkdownSource(
    '已有正文追加正文\n\n- \n',
    '已有正文追加正文\n\n* <br />\n\n',
    '已有正文追加正文\n\n* 新列表项\n\n'
  ).markdown,
  '已有正文追加正文\n\n- 新列表项\n\n',
  'filling a newly-created final list item must retain its following empty paragraph newline'
)

const listItemAppendedBeforeParagraph = preserveRichMarkdownSource(
  '- first\n- second\n\nparagraph',
  '* first\n\n* second\n\nparagraph',
  '* first\n\n* second\n\n* new\n\nparagraph'
)
assert.equal(
  listItemAppendedBeforeParagraph.markdown,
  '- first\n- second\n- new\n\nparagraph',
  'an item appended at a following paragraph boundary must inherit the compact list marker'
)

assert.equal(
  preserveTypedBulletInputRule({
    source: '1. first\n2. second\n\n',
    insertionSource: '1. first\n2. second\n\n* typed dash\n\nfollowing\n',
    previousCanonical: '1. first\n2. second\n\n<br />\n\n',
    canonical: '1. first\n2. second\n\n* typed dash\n\nfollowing\n',
    sourceOffset: 0,
    sourceSlotRawStart: '1. first\n2. second\n\n'.length,
    canonicalOffset: '1. first\n2. second\n\n'.length,
    marker: '-'
  }),
  '1. first\n2. second\n\n- typed dash\n\nfollowing\n',
  'a tail input-rule slot must restore the physical dash even when duplicate text makes its visible offset unusable'
)

assert.equal(
  preserveTypedBulletInputRule({
    source: '1. first\r\n2. second\r\n\r\n',
    insertionSource: '1. first\r\n2. second\r\n\r\n* typed dash\r\n\r\nfollowing\r\n',
    previousCanonical: '1. first\n2. second\n\n<br />\n\n',
    canonical: '1. first\n2. second\n\n* typed dash\n\nfollowing\n',
    sourceOffset: 0,
    sourceSlotRawStart: '1. first\r\n2. second\r\n\r\n'.length,
    canonicalOffset: '1. first\n2. second\n\n'.length,
    marker: '-'
  }),
  '1. first\r\n2. second\r\n\r\n- typed dash\r\n\r\nfollowing\r\n',
  'a CRLF tail input-rule replacement must keep an exact two-EOL block boundary without splitting CRLF bytes'
)

assert.equal(
  restoreTypedBulletMarker({
    markdown: '* 第一项\n* 第二项\n\n',
    previousCanonical: '\\-\n',
    canonical: '* 第一项\n\n* 第二项\n\n',
    canonicalOffset: 4,
    marker: '-'
  }),
  '- 第一项\n- 第二项\n\n',
  'the typed bullet marker must apply to the complete newly-created list level'
)

assert.equal(
  restoreTypedBulletMarker({
    markdown: 'intro\n\n* nested-one\n* nested-two\n',
    previousCanonical: 'intro\n',
    canonical: 'intro\n\n* nested-one\n* nested-two\n',
    // Simulates the old paragraph position after an input rule moved it into
    // a nested list: it is no longer close to the serialized marker row.
    canonicalOffset: 999,
    marker: '-'
  }),
  'intro\n\n- nested-one\n- nested-two\n',
  'a stale pre-input position must fall back to the actual changed list row instead of losing the authored bullet marker'
)

assert.equal(
  restoreTypedBulletMarker({
    markdown: '1. 第一项\n2. 第二项\n1) 重新创建项\n',
    previousCanonical: '1. 第一项\n2. 第二项\n',
    canonical: '1. 第一项\n2. 第二项\n1) 重新创建项\n',
    canonicalOffset: '1. 第一项\n2. 第二项\n'.length,
    marker: '1.'
  }),
  '1. 第一项\n2. 第二项\n1. 重新创建项\n',
  'a recreated ordered list must retain its typed dot without rewriting existing numbering'
)

assert.equal(
  preserveGeneratedBulletMarkers(
    '1. 外层\n   1. 子项\n',
    '1) 外层\n   1) 子项\n'
  ),
  '1. 外层\n   1. 子项\n',
  'a second generated serialization must retain ordered punctuation after the input intent is consumed'
)

assert.equal(
  preserveGeneratedBulletMarkers(
    '- dash one\n',
    '* dash one\n* dash two\n'
  ),
  '- dash one\n- dash two\n',
  'a newly appended scratch-list row must inherit the authored dash instead of reverting to Crepe’s star'
)

assert.equal(
  preserveGeneratedBulletMarkers(
    '1. ordered\n\n- dash one\n- dash two\n',
    '1. ordered\n\n* dash one edited\n* dash two\n'
  ),
  '1. ordered\n\n- dash one edited\n- dash two\n',
  'editing the first item of a generated dash list must not expose Crepe’s default star'
)

assert.equal(
  preserveGeneratedBulletMarkers(
    '- first\n- second\n',
    '* first edited\n* second edited\n'
  ),
  '- first edited\n- second edited\n',
  'editing every item while the generated list shape is stable must retain its authored marker by structural row identity'
)

assert.equal(
  preserveGeneratedBulletMarkers(
    '- dash one\n- dash two\n\n+ plus one\n',
    '* dash one\n* dash two\n* plus one\n* plus two\n'
  ),
  '- dash one\n- dash two\n+ plus one\n+ plus two\n',
  'a newly appended row in a later scratch list must inherit that list’s own marker, even if Crepe merges adjacent bullet nodes'
)

assert.equal(
  preserveGeneratedBulletMarkers(
    '- outer one\n- outer two\n',
    '* outer one\n* outer two\n  * child one\n  * child two\n'
  ),
  '- outer one\n- outer two\n  - child one\n  - child two\n',
  'a Tab-created child list must inherit its parent marker instead of serializing as Crepe’s default star'
)


const adjacentListKinds = preserveRichMarkdownSource(
  '* Existing bullet\n\nConvert this paragraph\n\n* [ ] Existing task\n',
  '* Existing bullet\n\nConvert this paragraph\n\n* [ ] Existing task\n',
  '* Existing bullet\n\n1. Convert this paragraph\n\n* [ ] Existing task\n'
)
assert.equal(
  adjacentListKinds.markdown,
  '* Existing bullet\n\n1. Convert this paragraph\n\n* [ ] Existing task\n',
  'a top-level list type change must not merge adjacent bullet, ordered, and task lists'
)

const paragraphBetweenBulletLists = preserveRichMarkdownSource(
  '* Existing bullet\n\nConvert this paragraph\n\n* [ ] Existing task\n',
  '* Existing bullet\n\nConvert this paragraph\n\n* [ ] Existing task\n',
  '* Existing bullet\n\n* Convert this paragraph\n\n* [ ] Existing task\n'
)
assert.equal(
  paragraphBetweenBulletLists.markdown,
  '* Existing bullet\n\n* Convert this paragraph\n\n* [ ] Existing task\n',
  'wrapping a paragraph must replace only that line even when adjacent bullet lists become contiguous'
)

assert.equal(
  replaceMarkdownListBlock({
    source: '- [ ] Task one\n- [x] Task two\n\n1. First\n   1. First child\n2. Second\n',
    previous: '* [ ] Task one\n\n* [x] Task two\n\n1. First\n\n   1. First child\n2. Second\n',
    next: '* [ ] Task one\n\n* [x] Task two\n\n* First\n\n  1. First child\n* Second\n',
    sourceOffset: 31,
    previousOffset: 32,
    nextOffset: 32
  }),
  // `- First` would sit adjacent to the `- [ ]` task list above: CommonMark
  // merges same-marker lists across a blank line on reparse while the editor
  // keeps two separate blocks. The converted level therefore alternates to
  // `*` exactly like the serializer does (bulletTokenAvoidingMerge).
  '- [ ] Task one\n- [x] Task two\n\n* First\n   1. First child\n* Second\n',
  'a list conversion must not duplicate an adjacent list that canonical Markdown merges into the same block'
)

const mixedLooseOuterCompactInnerSource = [
  '1. 用来做推特运营',
  '',
  '   * 发每日更新',
  '   * 搜索值得收藏的内容',
  '2. 自动写公众号',
  '',
  '   * 找选题、写文章',
  '3. 开发 HorseMD',
  '',
  '   * 监控 issue',
  '   * 实现新功能'
].join('\n')
const mixedLooseOuterCompactInnerPrevious = [
  '1. 用来做推特运营',
  '',
  '   * 发每日更新',
  '',
  '   * 搜索值得收藏的内容',
  '2. 自动写公众号',
  '',
  '   * 找选题、写文章',
  '3. 开发 HorseMD',
  '',
  '   * 监控 issue',
  '',
  '   * 实现新功能'
].join('\n')
const mixedLooseOuterCompactInnerNext = mixedLooseOuterCompactInnerPrevious
  .replace(/^\d+\. /gm, '* ')
assert.equal(
  replaceMarkdownListBlock({
    source: mixedLooseOuterCompactInnerSource,
    previous: mixedLooseOuterCompactInnerPrevious,
    next: mixedLooseOuterCompactInnerNext,
    sourceOffset: 2,
    previousOffset: 2,
    nextOffset: 2
  }),
  mixedLooseOuterCompactInnerSource.replace(/^\d+\. /gm, '- '),
  'converting a loose outer list must change only its markers and preserve compact nested-list bytes'
)
assert.equal(
  replaceMarkdownListBlock({
    source: mixedLooseOuterCompactInnerSource,
    previous: mixedLooseOuterCompactInnerPrevious,
    next: mixedLooseOuterCompactInnerNext.replace('用来做推特运营', '用来立即继续输入'),
    sourceOffset: 2,
    previousOffset: 2,
    nextOffset: 2
  }),
  null,
  'an ambiguous combined conversion/text delta must fail closed instead of replacing the canonical list tree'
)

const leadingSpaceListSource = '- 是的v\n- 色粉色\n- \u200B     色粉色分\n'
const leadingSpaceListCanonical = '* 是的v\n* 色粉色\n* &#x20;    色粉色分\n'
assert.equal(
  replaceMarkdownListBlock({
    source: leadingSpaceListSource,
    previous: leadingSpaceListCanonical,
    next: '1. 是的v\n2. 色粉色\n3. &#x20;    色粉色分\n',
    sourceOffset: 2,
    previousOffset: 2,
    nextOffset: 3
  }),
  '1. 是的v\n2. 色粉色\n3. \u200B     色粉色分\n',
  'list conversion must treat U+200B authored leading spaces and canonical &#x20; as the same item text'
)

const listChanged = preserveRichMarkdownSource(listSource, listCanonical, listNext)
assert.equal(listChanged.preserved, true)
assert.equal(listChanged.reason, 'list-type-change')
assert.equal(listChanged.markdown, [
  '# 保持标题格式',
  '',
  '这里是区间：0~9。',
  '',
  '1. Alpha',
  '   1. Child',
  '2. Beta',
  '',
  '两个列表之间的正文。',
  '',
  '- [ ] 不要转换的任务',
  '',
  '这段不要改。'
].join('\n'))

const headingLevelChanged = preserveRichMarkdownSource(
  source,
  canonical,
  canonical.replace('## 二级标题', '### 二级标题')
)
assert.equal(headingLevelChanged.preserved, true)
assert.equal(
  headingLevelChanged.markdown,
  source.replace('## 二级标题', '### 二级标题'),
  'changing one heading level must not add blank lines elsewhere'
)

const splitParagraph = preserveRichMarkdownSource(
  source,
  canonical,
  canonical.replace('这一段不要修改。', '这一段\n\n不要修改。')
)
assert.equal(splitParagraph.preserved, true)
assert.equal(
  splitParagraph.markdown,
  source.replace('这一段不要修改。', '这一段\n\n不要修改。'),
  'splitting one paragraph must not normalize headings or lists'
)

const appendedParagraphWithoutFinalNewline = preserveRichMarkdownSource(
  '第一段内容',
  '第一段内容\n',
  '第一段内容\n\n第二段内容\n'
)
assert.equal(appendedParagraphWithoutFinalNewline.preserved, true)
assert.equal(
  ['appended-paragraph', 'diverged-tail-block-append'].includes(appendedParagraphWithoutFinalNewline.reason),
  true,
  `paragraph append must be owned by an append mapper, got ${appendedParagraphWithoutFinalNewline.reason}`
)
assert.equal(
  appendedParagraphWithoutFinalNewline.markdown,
  '第一段内容\n\n第二段内容',
  'adding a paragraph must keep two Markdown separator newlines without inventing a final newline'
)

const appendedParagraphWithFinalNewline = preserveRichMarkdownSource(
  '第一段内容\n',
  '第一段内容\n',
  '第一段内容\n\n第二段内容\n'
)
assert.equal(
  appendedParagraphWithFinalNewline.markdown,
  '第一段内容\n\n第二段内容\n',
  'adding a paragraph must retain the authored final-newline style'
)

const appendedParagraphAfterAuthoredBlankLines = preserveRichMarkdownSource(
  '第一段内容\n\n\n',
  '第一段内容\n',
  '第一段内容\n\n第二段内容\n'
)
assert.equal(
  appendedParagraphAfterAuthoredBlankLines.markdown,
  '第一段内容\n\n\n第二段内容\n',
  'adding a paragraph must reuse authored trailing blank lines instead of adding another'
)

const paragraphAfterSettledNewDocumentTitle = preserveRichMarkdownSource(
  '# 看了苏规范\n\n',
  '# 看了苏规范\n\n',
  '# 看了苏规范\n\n阿福两年啦额咖啡呢\n\n'
)
assert.equal(
  ['appended-paragraph', 'diverged-tail-block-append'].includes(paragraphAfterSettledNewDocumentTitle.reason),
  true,
  `title-following paragraph append must be owned by an append mapper, got ${paragraphAfterSettledNewDocumentTitle.reason}`
)
assert.equal(
  paragraphAfterSettledNewDocumentTitle.markdown,
  '# 看了苏规范\n\n阿福两年啦额咖啡呢\n',
  'typing into the trailing paragraph after a settled title must not append text to the heading'
)

const secondParagraphAfterSettledTitle = preserveRichMarkdownSource(
  paragraphAfterSettledNewDocumentTitle.markdown,
  '# 看了苏规范\n\n阿福两年啦额咖啡呢\n\n',
  '# 看了苏规范\n\n阿福两年啦额咖啡呢\n\n阿发了；发挥了；\n\n'
)
assert.equal(
  secondParagraphAfterSettledTitle.markdown,
  '# 看了苏规范\n\n阿福两年啦额咖啡呢\n\n阿发了；发挥了；\n',
  'human-paced consecutive paragraphs must remain separate after canonical snapshots settle'
)

const trailingEmptyParagraphCreated = preserveRichMarkdownSource(
  '# 看了苏规范\n\n',
  '# 看了苏规范\n\n',
  '# 看了苏规范\n\n<br />\n\n'
)
assert.equal(
  ['trailing-empty-block-created', 'diverged-tail-block-append', 'canonical-trailing-newline-drift']
    .includes(trailingEmptyParagraphCreated.reason),
  true,
  `trailing empty paragraph must be owned by an empty/append mapper, got ${trailingEmptyParagraphCreated.reason}`
)
assert.equal(
  trailingEmptyParagraphCreated.markdown,
  '# 看了苏规范\n\n',
  "pressing Enter must not persist Crepe's standalone empty-paragraph <br /> placeholder"
)

assert.equal(
  preserveRichMarkdownSource('', '', '第一段\n\n<br />\n\n第二段\n').markdown,
  '第一段\n\n\n\n第二段\n',
  'a new document must not expose Crepe empty-paragraph placeholders as authored HTML'
)

const trailingEmptyParagraphFilled = preserveRichMarkdownSource(
  trailingEmptyParagraphCreated.markdown,
  '# 看了苏规范\n\n<br />\n\n',
  '# 看了苏规范\n\n阿福两年啦额咖啡呢\n\n'
)
assert.equal(
  ['trailing-empty-block-filled', 'diverged-tail-block-append'].includes(trailingEmptyParagraphFilled.reason),
  true,
  `trailing empty paragraph fill must be owned by an empty/append mapper, got ${trailingEmptyParagraphFilled.reason}`
)
assert.equal(
  trailingEmptyParagraphFilled.markdown,
  '# 看了苏规范\n\n阿福两年啦额咖啡呢\n',
  'typing after Enter must replace the transient empty block with a separate paragraph'
)

const middleSource = '# 标题\n\n前段内容\n\n## 后续标题\n\n后段内容\n'
const middleCanonical = middleSource
const middleEmptyParagraphCreated = preserveRichMarkdownSource(
  middleSource,
  middleCanonical,
  '# 标题\n\n前段内容\n\n<br />\n\n## 后续标题\n\n后段内容\n'
)
assert.equal(
  ['middle-empty-block-created', 'diverged-tail-block-append', 'structural-line-change']
    .includes(middleEmptyParagraphCreated.reason),
  true,
  `middle empty paragraph must be owned by an empty/append mapper, got ${middleEmptyParagraphCreated.reason}`
)
assert.equal(
  middleEmptyParagraphCreated.markdown,
  middleSource,
  'pressing Enter between existing blocks must not leak an editor <br /> placeholder'
)

const middleEmptyParagraphFilled = preserveRichMarkdownSource(
  middleEmptyParagraphCreated.markdown,
  '# 标题\n\n前段内容\n\n<br />\n\n## 后续标题\n\n后段内容\n',
  '# 标题\n\n前段内容\n\n新插入段落\n\n## 后续标题\n\n后段内容\n'
)
assert.equal(middleEmptyParagraphFilled.reason, 'middle-empty-block-filled')
assert.equal(
  middleEmptyParagraphFilled.markdown,
  '# 标题\n\n前段内容\n\n新插入段落\n\n## 后续标题\n\n后段内容\n',
  'filling an empty paragraph between blocks must not merge it into the preceding paragraph'
)

const directMiddleParagraphInserted = preserveRichMarkdownSource(
  middleSource,
  middleCanonical,
  '# 标题\n\n前段内容\n\n立即输入段落\n\n## 后续标题\n\n后段内容\n'
)
assert.equal(directMiddleParagraphInserted.reason, 'middle-block-inserted')
assert.equal(
  directMiddleParagraphInserted.markdown,
  '# 标题\n\n前段内容\n\n立即输入段落\n\n## 后续标题\n\n后段内容\n',
  'typing immediately after Enter must preserve the inserted block boundary'
)

const inlineCodeExitedAtLineEnd = preserveRichMarkdownSource(
  'Type target`awdawdwa`\n',
  'Type target`awdawdwa`\n',
  'Type target`awdawdwa`outside\n'
)
assert.equal(
  inlineCodeExitedAtLineEnd.markdown,
  'Type target`awdawdwa`outside\n',
  'plain text typed after closing inline code must stay outside the backticks'
)

const trailingInlineCodeParagraphStarted = preserveRichMarkdownSource(
  '前一段\n\n\\`\n',
  '前一段\n\n\\`\n',
  '前一段\n\n`f`\n'
)
assert.equal(
  trailingInlineCodeParagraphStarted.markdown,
  '前一段\n\n`f`\n',
  'turning a lone backtick paragraph into inline code must keep its block separator'
)

const nonCanonicalTrailingInlineCodeParagraphStarted = preserveRichMarkdownSource(
  '紧凑第一行\n紧凑第二行\n\n中间段落\n\n\n\n连续段落 D\n\n\\`\n',
  '紧凑第一行\n紧凑第二行\n\n中间段落\n\n连续段落 D\n\n\\`\n',
  '紧凑第一行\n紧凑第二行\n\n中间段落\n\n连续段落 D\n\n`f`\n'
)
assert.equal(
  nonCanonicalTrailingInlineCodeParagraphStarted.markdown,
  '紧凑第一行\n紧凑第二行\n\n中间段落\n\n\n\n连续段落 D\n\n`f`\n',
  'a trailing inline-code paragraph must preserve earlier non-canonical blank lines'
)

const emphasisExitedBeforeHardBreak = preserveRichMarkdownSource(
  '__强调__  \n下一行\n',
  '**强调**\n下一行\n',
  '**强调**outside\n下一行\n'
)
assert.equal(
  emphasisExitedBeforeHardBreak.markdown,
  '__强调__outside  \n下一行\n',
  'line-end inline syntax must close before new text without moving authored hard-break spaces'
)

const linkExitedAtLineEnd = preserveRichMarkdownSource(
  '[HorseMD](https://horsemd.yangsir.net/)\n',
  '[HorseMD](https://horsemd.yangsir.net/)\n',
  '[HorseMD](https://horsemd.yangsir.net/)outside\n'
)
assert.equal(
  linkExitedAtLineEnd.markdown,
  '[HorseMD](https://horsemd.yangsir.net/)outside\n',
  'plain text typed after a line-end link must stay outside the link destination'
)

const middleSpacedParagraphFilled = preserveRichMarkdownSource(
  middleEmptyParagraphFilled.markdown,
  '# 标题\n\n前段内容\n\n新插入段落\n\n<br />\n\n<br />\n\n## 后续标题\n\n后段内容\n',
  '# 标题\n\n前段内容\n\n新插入段落\n\n<br />\n\n间隔后段落\n\n## 后续标题\n\n后段内容\n'
)
assert.equal(
  middleSpacedParagraphFilled.markdown,
  '# 标题\n\n前段内容\n\n新插入段落\n\n\n\n间隔后段落\n\n## 后续标题\n\n后段内容\n',
  'an intentional empty paragraph must become blank source lines without persisting <br />'
)

const emptiedMiddleParagraph = preserveRichMarkdownSource(
  '# 测试\n\n你好\n\n再见\n',
  '# 测试\n\n你好\n\n再见\n',
  '# 测试\n\n<br />\n\n再见\n'
)
assert.equal(
  emptiedMiddleParagraph.markdown,
  '# 测试\n\n\n\n再见\n',
  'emptying a middle paragraph must delete its authored text without persisting <br />'
)

const emptiedTrailingParagraph = preserveRichMarkdownSource(
  '# 测试\n\n你好\n',
  '# 测试\n\n你好\n',
  '# 测试\n\n<br />\n'
)
assert.equal(
  emptiedTrailingParagraph.markdown,
  '# 测试\n',
  'emptying the trailing paragraph must delete its authored text, keep the source trailing newline, and never persist <br />'
)

const emptiedFormattedParagraph = preserveRichMarkdownSource(
  '# 测试\n\n**你好**\n\n再见\n',
  '# 测试\n\n**你好**\n\n再见\n',
  '# 测试\n\n<br />\n\n再见\n'
)
assert.equal(
  emptiedFormattedParagraph.markdown,
  '# 测试\n\n\n\n再见\n',
  'emptying a formatted paragraph must remove its whole authored line (including inline syntax)'
)

const emptiedThenTyped = preserveRichMarkdownSource(
  '# 测试\n\n\n\n再见\n',
  '# 测试\n\n<br />\n\n再见\n',
  '# 测试\n\n.\n\n再见\n'
)
assert.equal(
  emptiedThenTyped.markdown,
  '# 测试\n\n.\n\n再见\n',
  'typing into an emptied paragraph must fill its blank line without persisting <br />'
)

const emptiedDotDance = preserveRichMarkdownSource(
  '# 测试\n\n.\n\n再见\n',
  '# 测试\n\n.\n\n再见\n',
  '# 测试\n\n<br />\n\n再见\n'
)
assert.equal(
  emptiedDotDance.markdown,
  '# 测试\n\n\n\n再见\n',
  'deleting the last character of a paragraph must return to the blank-line form without persisting <br />'
)

const emptiedWithUnrelatedEmptyParagraph = preserveRichMarkdownSource(
  '# A\n\n.\n\n# B\n\n正文\n\n# C\n',
  '# A\n\n.\n\n# B\n\n正文\n\n<br />\n\n# C\n',
  '# A\n\n<br />\n\n# B\n\n正文\n\n<br />\n\n# C\n'
)
assert.equal(
  emptiedWithUnrelatedEmptyParagraph.reason,
  'paragraph-emptied',
  'an emptied paragraph must still map when the document has another unrelated empty paragraph'
)
assert.equal(
  emptiedWithUnrelatedEmptyParagraph.markdown,
  '# A\n\n\n\n# B\n\n正文\n\n# C\n',
  'an unrelated empty paragraph elsewhere must not leak <br /> through the localized replacement'
)

const emptiedWithVisibleStreamMismatch = preserveRichMarkdownSource(
  '# 甲\n\n.\n\n# 乙\n\n存取。* **输入设备：** 内容\n',
  '# 甲\n\n.\n\n# 乙\n\n存取。\n\n* **输入设备：** 内容\n',
  '# 甲\n\n<br />\n\n# 乙\n\n存取。\n\n* **输入设备：** 内容\n'
)
assert.equal(
  emptiedWithVisibleStreamMismatch.reason,
  'paragraph-emptied',
  'an emptied paragraph must still map when a mid-line `* ` elsewhere makes remark split the visible stream differently'
)
assert.equal(
  emptiedWithVisibleStreamMismatch.markdown,
  '# 甲\n\n\n\n# 乙\n\n存取。* **输入设备：** 内容\n',
  'a whole-document visible-stream mismatch must not veto the localized empty-paragraph mapping or leak <br />'
)

// The hard boundary invariant: no matter which heuristic path produced the
// result, an internal standalone `<br />` placeholder can never survive into
// authored source. Inline `text<br>text` and table-cell breaks are not
// standalone lines and must stay untouched.
const boundaryInvariantLeak = preserveRichMarkdownSource(
  '# 甲\n\n正文\n',
  '# 甲\n\n正文\n',
  '# 甲\n\n正文X\n\n<br />\n\n# 乙\n'
)
assert.equal(
  /<br\s*\/?>/.test(boundaryInvariantLeak.markdown || ''),
  false,
  'a standalone <br /> placeholder must never reach authored source through any path'
)
const inlineBreakPreserved = preserveRichMarkdownSource(
  '第一行<br>第二行\n',
  '第一行<br>第二行\n',
  '第一行<br>第二行X\n'
)
assert.equal(
  inlineBreakPreserved.markdown,
  '第一行<br>第二行X\n',
  'an inline authored <br> hard break must survive the boundary invariant'
)

// Full-document deletion: the canonical becomes empty, which is unambiguous.
// Every localized mapping below would fail closed on a diverged source and
// resurrect the old content in source mode, in saves, and after a reopen.
const emptiedDivergedSource = '# 测试\n\n价格是 * 优惠价\n\n- 项一\n- 项二\n\n结尾。\n'
const emptiedDivergedCanonical = '# 测试\n\n价格是 \\* 优惠价\n\n* 项一\n* 项二\n\n结尾。\n'
const emptiedDiverged = preserveRichMarkdownSource(
  emptiedDivergedSource,
  emptiedDivergedCanonical,
  ''
)
assert.equal(emptiedDiverged.reason, 'document-emptied')
assert.equal(
  emptiedDiverged.markdown,
  '',
  'deleting every block in rich mode must empty the source even when the visible stream diverges'
)

const emptiedMarkerDiverged = preserveRichMarkdownSource(
  '# 标题\n\n正文。\n\n- 项一\n- 项二\n\n结尾。',
  '# 标题\n\n正文。\n\n* 项一\n* 项二\n\n结尾。',
  ''
)
assert.equal(
  emptiedMarkerDiverged.markdown,
  '',
  'a list-marker divergence must not leave a `# ` remnant behind after a full deletion'
)

const emptiedCrlfBom = preserveRichMarkdownSource(
  '\uFEFF# Windows 标题\r\n\r\n正文。\r\n',
  '# Windows 标题\n\n正文。\n',
  ''
)
assert.equal(
  emptiedCrlfBom.markdown,
  '',
  'a full deletion must empty the file regardless of BOM/CRLF conventions'
)

// Leading spaces typed in rich mode are serialized by remark-stringify as the
// `&#x20;` entity (a literal space at line start would be parsed as indentation
// or a list). That is a canonical spelling, never authored source: every
// canonical→source translation must restore the real spaces.
const LEADING_SPACE_SENTINEL = '\u200B'
assert.equal(
  generatedScratchMarkdown('# &#x20;       hello\n'),
  `# ${LEADING_SPACE_SENTINEL}        hello\n`,
  'a generated scratch document must spell leading spaces with an invisible Markdown-safe sentinel, not an entity'
)
assert.equal(
  generatedScratchMarkdown('    &#x20;缩进正文\n'),
  `    ${LEADING_SPACE_SENTINEL} 缩进正文\n`,
  'canonical structural indentation must not hide a generated leading-space entity'
)
assert.equal(
  generatedScratchMarkdown('* 父项\n\n    &#x20;列表续行\n'),
  `* 父项\n\n    ${LEADING_SPACE_SENTINEL} 列表续行\n`,
  'a list continuation with four structural spaces must still restore the authored leading space'
)
assert.equal(
  generatedScratchMarkdown('\t&#x20;制表缩进正文\n'),
  `\t${LEADING_SPACE_SENTINEL} 制表缩进正文\n`,
  'canonical tab indentation must not hide a generated leading-space entity'
)
const leadingSpaceChange = preserveRichMarkdownSource(
  '第一段正文。\n',
  '第一段正文。\n',
  '第一段正文。\n\n&#x20;     顶格文字\n'
)
assert.equal(
  leadingSpaceChange.markdown,
  `第一段正文。\n\n${LEADING_SPACE_SENTINEL}      顶格文字\n`,
  'a canonical line-leading `&#x20;` must reach the authored source as a real space'
)
const leadingSpaceNewDocument = preserveRichMarkdownSource('', '', '# &#x20;     顶格文字\n')
assert.equal(
  leadingSpaceNewDocument.markdown,
  `# ${LEADING_SPACE_SENTINEL}      顶格文字\n`,
  'the empty-document canonical path must unescape leading-space entities too'
)

// A held Space key emits multiple whitespace-only canonical snapshots before
// the first visible character. None of those intermediate states may write to
// source or collapse the paragraph separator onto the previous paragraph.
const heldSpaceSource = '# test\n\nanchor\n'
const heldSpaceEmpty = '# test\n\nanchor\n\n<br />\n\n'
const heldSpaceTwo = '# test\n\nanchor\n\n<br />\n\n  \n'
const heldSpaceThree = '# test\n\nanchor\n\n<br />\n\n   \n'
const heldSpaceAfterTwo = preserveRichMarkdownSource(
  heldSpaceSource,
  heldSpaceEmpty,
  heldSpaceTwo
)
assert.equal(
  ['trailing-empty-block-whitespace', 'diverged-tail-block-append'].includes(heldSpaceAfterTwo.reason),
  true,
  `held-space intermediate must be owned by a whitespace/append mapper, got ${heldSpaceAfterTwo.reason}`
)
assert.equal(heldSpaceAfterTwo.markdown, heldSpaceSource)
const heldSpaceAfterThree = preserveRichMarkdownSource(
  heldSpaceSource,
  heldSpaceTwo,
  heldSpaceThree
)
assert.equal(heldSpaceAfterThree.reason, 'trailing-empty-block-whitespace')
assert.equal(heldSpaceAfterThree.markdown, heldSpaceSource)
const heldSpaceText = preserveRichMarkdownSource(
  heldSpaceSource,
  '# test\n\nanchor\n\n<br />\n\n       \n',
  '# test\n\nanchor\n\n<br />\n\n&#x20;       abc\n'
)
assert.equal(
  heldSpaceText.markdown,
  `# test\n\nanchor\n\n${LEADING_SPACE_SENTINEL}        abc\n`,
  'the first visible character after held spaces must append one intact paragraph using Typora-style source spelling'
)
const leadingSpacePartialDelete = preserveRichMarkdownSource(
  `# test\n\nanchor\n\n${LEADING_SPACE_SENTINEL}    abc\n`,
  '# test\n\nanchor\n\n&#x20;   abc\n',
  '# test\n\nanchor\n\n \n'
)
assert.equal(leadingSpacePartialDelete.preserved, true)
assert.equal(
  leadingSpacePartialDelete.markdown,
  `# test\n\nanchor\n\n${LEADING_SPACE_SENTINEL} \n`,
  'deleting visible text and only part of its leading spaces must retain the remaining whitespace paragraph'
)

// A typed `~` is serialized as `\~` (GFM strikethrough guard). The authored
// source must keep the literal tilde: single `~` is never a strikethrough, so
// unescaping is semantics-preserving.
assert.equal(
  generatedScratchMarkdown('# 审计 0\\~9\n'),
  '# 审计 0~9\n',
  'a generated scratch document must spell tildes literally, not as \\~ escapes'
)
assert.equal(
  generatedScratchMarkdown([
    '```text',
    '&#x20;',
    '\\~',
    '```',
    '',
    '`&#x20; \\~`',
    '',
    '<span data-x="\\~">&#x20;</span>',
    '',
    '<div>',
    '&#x20;',
    '\\~',
    '</div>',
    '',
    '# &#x20; hi 0\\~9',
    ''
  ].join('\n')),
  [
    '```text',
    '&#x20;',
    '\\~',
    '```',
    '',
    '`&#x20; \\~`',
    '',
    '<span data-x="\\~">&#x20;</span>',
    '',
    '<div>',
    '&#x20;',
    '\\~',
    '</div>',
    '',
    `# ${LEADING_SPACE_SENTINEL}  hi 0~9`,
    ''
  ].join('\n'),
  'canonical escape translation must not alter fenced or inline-code literals'
)
assert.equal(
  generatedScratchMarkdown('外部 0\\~9 <span data-x="\\~">&#x20;</span> 后续 1\\~2\n'),
  '外部 0~9 <span data-x="\\~">&#x20;</span> 后续 1~2\n',
  'inline HTML must protect only its own token range while surrounding Markdown escapes are restored'
)
assert.equal(
  generatedScratchMarkdown('``code ` &#x20; \\~ literal`` 外部 0\\~9\n'),
  '``code ` &#x20; \\~ literal`` 外部 0~9\n',
  'double-backtick code spans containing a single backtick must remain literal while outside text is restored'
)
assert.equal(
  generatedScratchMarkdown('\\`\\`\\`你好\\`\\`\\`\n'),
  '```你好```\n',
  'same-line triple-backtick text typed in a scratch document must not expose serializer escapes'
)
const mathWithTableLookingLines = [
  '$$',
  '| H |',
  '| - |',
  '| <br /> |',
  '$$',
  ''
].join('\n')
assert.equal(
  generatedScratchMarkdown(
    mathWithTableLookingLines,
    (markdown) => ({ view: { raw: markdown }, tables: [] })
  ),
  mathWithTableLookingLines,
  'generated/rebuild source must use the configured parser and leave table-looking display math untouched'
)
const literalTripleBacktickNewDocument = preserveRichMarkdownSource(
  '',
  '',
  '\\`\\`\\`你好\\`\\`\\`\n'
)
assert.equal(literalTripleBacktickNewDocument.reason, 'new-document')
assert.equal(
  literalTripleBacktickNewDocument.markdown,
  '```你好```\n',
  'an empty-file first edit must restore typed triple backticks before source mode or save'
)
const tildeNewDocument = preserveRichMarkdownSource('', '', '# 审计 0\\~9\n')
assert.equal(
  tildeNewDocument.markdown,
  '# 审计 0~9\n',
  'the empty-document canonical path must unescape \\~ too'
)
// In an existing document the whole-paragraph replacement carries the escaped
// canonical spelling; it must still land as the author's literal tilde.
const tildeWholeParagraph = preserveRichMarkdownSource(
  '审计起点：0~9。\n',
  '审计起点：0\\~9。\n',
  '审计起点：0\\~9X。\n'
)
assert.equal(
  tildeWholeParagraph.markdown,
  '审计起点：0~9X。\n',
  'an escaped canonical tilde must reach the authored source literally'
)

const exactBaselineEscapes = preserveRichMarkdownSource(
  '# 标题\n\n正文\n',
  '# 标题\n\n正文\n',
  '# 标题\n\n正文 0\\~9\n\n&#x20; 后续\n'
)
assert.equal(
  exactBaselineEscapes.markdown,
  `# 标题\n\n正文 0~9\n\n${LEADING_SPACE_SENTINEL}  后续\n`,
  'the exact-canonical baseline must use the same context-aware translation as every other canonical write'
)

// remark parses `- 1. 甲乙` as a NESTED ORDERED LIST (`1. 甲`, `2. 乙`): the
// `1. ` item text leaves the canonical visible stream while the authored
// source keeps it, so the whole document diverges and every list-internal
// text edit used to roll back to the OLD source (typed text silently lost).
// The canonical below is the real Crepe serialization captured from the app.
const nestedListSource = '- 1. 甲乙\n- 丙丁\n'
const nestedListPrevious = '* <br />\n\n  1. 甲\n  2. 乙\n\n* 丙丁\n\n'
const nestedListNext = '* <br />\n\n  1. 甲\n  2. 新乙\n\n* 丙丁\n\n'
const nestedListEnterSplit = preserveRichMarkdownSource(
  nestedListSource,
  '* <br />\n\n  1. 甲乙\n\n* 丙丁\n',
  '* <br />\n\n  1. 甲\n  2. 乙\n\n* 丙丁\n\n'
)
assert.equal(nestedListEnterSplit.preserved, true)
assert.equal(
  nestedListEnterSplit.markdown,
  '- 1. 甲\n  2. 乙\n- 丙丁\n',
  'an Enter split must keep the inserted ordered item inside its original outer bullet'
)
const nestedListSplit = preserveRichMarkdownSource(
  nestedListSource,
  nestedListPrevious,
  nestedListNext
)
assert.equal(
  nestedListSplit.reason,
  'diverged-nested-list-change',
  'a list-internal text edit inside a nested-number-diverged document must map through item-sequence alignment'
)
assert.equal(
  nestedListSplit.markdown,
  '- 1. 甲新乙\n- 丙丁\n',
  'the typed text must reach the authored `- 1. …` spelling instead of vanishing'
)

const nestedListPlainEdit = preserveRichMarkdownSource(
  nestedListSource,
  nestedListPrevious,
  '* <br />\n\n  1. 甲X\n  2. 乙\n\n* 丙丁\n\n'
)
assert.equal(
  nestedListPlainEdit.markdown,
  '- 1. 甲X乙\n- 丙丁\n',
  'a plain text edit on the first nested item must map back into the flat authored text'
)

const nestedBulletSource = [
  '- 你好 1. 2. 测试',
  '- - 测试 1. 你好',
  '- 测试 - 测试 1. 2. 测试',
  ''
].join('\n')
const nestedBulletPrevious = [
  '* 你好 1. 2. 测试',
  '',
  '* <br />',
  '',
  '  * 测试 1. 你好',
  '',
  '* 测试 - 测试 1. 2. 测试',
  ''
].join('\n')
const nestedBulletItemEdited = preserveRichMarkdownSource(
  nestedBulletSource,
  nestedBulletPrevious,
  nestedBulletPrevious.replace('  * 测试 1. 你好', '  * 测试 1. 你好X')
)
assert.equal(nestedBulletItemEdited.preserved, true)
assert.equal(
  nestedBulletItemEdited.markdown,
  nestedBulletSource.replace('- - 测试 1. 你好', '- - 测试 1. 你好X'),
  'editing a `- - text` nested bullet must preserve both authored markers and update only its body'
)
const nestedBulletSiblingEdited = preserveRichMarkdownSource(
  nestedBulletSource,
  nestedBulletPrevious,
  nestedBulletPrevious.replace('* 测试 - 测试 1. 2. 测试', '* 测试 - 测试 1. 2. 测试X')
)
assert.equal(nestedBulletSiblingEdited.preserved, true)
assert.equal(
  nestedBulletSiblingEdited.markdown,
  nestedBulletSource.replace('- 测试 - 测试 1. 2. 测试', '- 测试 - 测试 1. 2. 测试X'),
  'a nested-bullet divergence earlier in the list must not block editing a later sibling row'
)

const nestedListItemRemoved = preserveRichMarkdownSource(
  nestedListSource,
  nestedListPrevious,
  '* <br />\n\n  1. 甲\n\n* 丙丁\n\n'
)
assert.equal(
  nestedListItemRemoved.markdown,
  '- 1. 甲\n- 丙丁\n',
  'removing the nested `2. 乙` item must remove only 乙 from the authored row'
)

const nestedListZeroWidthAppend = preserveRichMarkdownSource(
  nestedListSource,
  nestedListPrevious,
  '* <br />\n\n  1. 甲\n  2. 乙\n  3. 戊\n\n* 丙丁\n\n'
)
assert.equal(
  nestedListZeroWidthAppend.reason,
  'diverged-nested-list-change',
  'a zero-width nested append must use the item-sequence path, not the corrupted line mapper'
)
assert.equal(
  nestedListZeroWidthAppend.markdown,
  '- 1. 甲乙\n  3. 戊\n- 丙丁\n',
  'a nested append must remain an indented sibling in the authored outer row'
)

// Enter at the end of the flat row creates an EMPTY canonical item (`2. `),
// which the visible map would otherwise keep as literal `2. ` text and break
// the anchor. Filling that item must reach the authored row.
const nestedListEmptyItemFilled = preserveRichMarkdownSource(
  '- 1. 甲乙\n- 丙丁\n',
  '* <br />\n\n  1. 甲乙\n  2. <br />\n\n* 丙丁\n\n',
  '* <br />\n\n  1. 甲乙\n  2. 后记\n\n* 丙丁\n\n'
)
assert.equal(
  nestedListEmptyItemFilled.reason,
  'diverged-nested-list-change',
  'filling a canonical empty nested item must map through item-sequence alignment'
)
assert.equal(
  nestedListEmptyItemFilled.markdown,
  '- 1. 甲乙\n  2. 后记\n- 丙丁\n',
  'filling an Entered empty item must remain inside its authored outer row'
)

// Backspace at the start of a nested ordered item removes only that inner
// marker. Crepe keeps the outer bullet wrapper and serializes the lifted text
// as an indented continuation line. This is a marker-only change, not an empty
// item: the authored row must become `- text`, never `- 2. `.
const nestedNumberMarkerRemoved = preserveRichMarkdownSource(
  '- 1. 管理层（总经理）\n- 2. 综合行政部\n- 3. 人力资源部\n',
  '* <br />\n\n  1. 管理层（总经理）\n\n* <br />\n\n  2. 综合行政部\n\n* <br />\n\n  3. 人力资源部\n\n',
  '* <br />\n\n  1. 管理层（总经理）\n\n* <br />\n\n  综合行政部\n\n* <br />\n\n  3. 人力资源部\n\n'
)
assert.equal(nestedNumberMarkerRemoved.reason, 'diverged-nested-list-change')
assert.equal(
  nestedNumberMarkerRemoved.markdown,
  '- 1. 管理层（总经理）\n- 综合行政部\n- 3. 人力资源部\n',
  'removing a nested ordered marker must retain the item text and outer authored bullet'
)

const nestedOuterMarkerRemoved = preserveRichMarkdownSource(
  '- 1. 管理层（总经理）\n- 综合行政部\n- 3. 人力资源部\n',
  '* <br />\n\n  1. 管理层（总经理）\n\n* 综合行政部\n\n* <br />\n\n  3. 人力资源部\n\n',
  '* <br />\n\n  1. 管理层（总经理）\n\n  综合行政部\n\n* <br />\n\n  3. 人力资源部\n\n'
)
assert.equal(nestedOuterMarkerRemoved.reason, 'diverged-nested-list-change')
// The lifted text is a separate paragraph block inside the previous item (the
// canonical blank-line-separates it), so the authored row must carry a
// preceding blank line: without one the indented line lazily continues the
// previous paragraph on reparse and the document changes across a reopen.
assert.equal(
  nestedOuterMarkerRemoved.markdown,
  '- 1. 管理层（总经理）\n\n  综合行政部\n- 3. 人力资源部\n',
  'lifting the outer bullet must retain its text as the preceding item continuation'
)

const nestedWrapperCollapsedWithoutSourceChange = preserveRichMarkdownSource(
  '- 1. 管理层（总经理）\n- 综合行政部\n- 3. 人力资源部\n',
  '* <br />\n\n  1. 管理层（总经理）\n\n* <br />\n\n  综合行政部\n\n* <br />\n\n  3. 人力资源部\n\n',
  '* <br />\n\n  1. 管理层（总经理）\n\n* 综合行政部\n\n* <br />\n\n  3. 人力资源部\n\n'
)
assert.equal(nestedWrapperCollapsedWithoutSourceChange.preserved, true)
assert.equal(
  nestedWrapperCollapsedWithoutSourceChange.markdown,
  '- 1. 管理层（总经理）\n- 综合行政部\n- 3. 人力资源部\n',
  'a canonical-only wrapper collapse must advance the baseline without rewriting authored source'
)

const divergedOrdinaryContinuation = preserveRichMarkdownSource(
  '- 1. 数字项\n\n- alphabeta\n',
  '* <br />\n\n  1. 数字项\n\n* alphabeta\n\n',
  '* <br />\n\n  1. 数字项\n\n* alpha\n  beta\n\n'
)
assert.equal(
  divergedOrdinaryContinuation.markdown,
  '- 1. 数字项\n\n- alpha\n  beta\n',
  'a normal multiline continuation in a diverged document must keep indentation instead of becoming a new bullet'
)

const divergedCrLfEdit = preserveRichMarkdownSource(
  '+ 1. AB\r\n+ tail\r\n',
  '* <br />\n\n  1. AB\n\n* tail\n\n',
  '* <br />\n\n  1. ABX\n\n* tail\n\n'
)
assert.equal(
  divergedCrLfEdit.markdown,
  '+ 1. ABX\r\n+ tail\r\n',
  'diverged list edits must retain CRLF and the authored bullet marker'
)

const divergedAndLaterBatch = preserveRichMarkdownSource(
  '- 1. A\n\n- normal\n',
  '* <br />\n\n  1. A\n\n* normal\n\n',
  '* <br />\n\n  1. AX\n\n* normalX\n\n'
)
assert.equal(
  divergedAndLaterBatch.markdown,
  '- 1. AX\n\n- normalX\n',
  'one deferred callback must commit both a diverged numbered-text list and a later ordinary list'
)

const divergedAndHeadingBatch = preserveRichMarkdownSource(
  '- 1. A\n\n## Heading\n',
  '* <br />\n\n  1. A\n\n## Heading\n',
  '* <br />\n\n  1. AX\n\n# Heading\n'
)
assert.equal(divergedAndHeadingBatch.preserved, false)
assert.equal(
  divergedAndHeadingBatch.markdown,
  '- 1. A\n\n## Heading\n',
  'a partially mapped callback must roll back atomically instead of reporting success while dropping heading structure'
)

const divergedListThenParagraph = preserveRichMarkdownSource(
  '- 1. A\n- B\n\n- target\n\n```\ncode\n```\n',
  '* <br />\n\n  1. A\n\n* B\n\n* target\n\n```\ncode\n```\n\n',
  '* <br />\n\n  1. A\n\n* B\n\n* target继续\n\n* next\n\nprose\n\n```\ncode\n```\n\n'
)
assert.equal(divergedListThenParagraph.preserved, true)
assert.equal(divergedListThenParagraph.reason, 'diverged-list-continuation')
assert.equal(
  divergedListThenParagraph.markdown,
  '- 1. A\n- B\n\n- target继续\n- next\n\nprose\n\n```\ncode\n```\n',
  'continuing a persisted list and immediately typing the following paragraph must commit as one bounded insertion'
)

const divergedListThenParagraphCrLf = preserveRichMarkdownSource(
  '- 1. A\r\n- B\r\n\r\n- target\r\n\r\n```\r\ncode\r\n```\r\n',
  '* <br />\n\n  1. A\n\n* B\n\n* target\n\n```\ncode\n```\n\n',
  '* <br />\n\n  1. A\n\n* B\n\n* target继续\n\n* next\n\nprose\n\n```\ncode\n```\n\n'
)
assert.equal(
  divergedListThenParagraphCrLf.markdown,
  '- 1. A\r\n- B\r\n\r\n- target继续\r\n- next\r\n\r\nprose\r\n\r\n```\r\ncode\r\n```\r\n',
  'a diverged list continuation must splice before CRLF rather than between its CR and LF bytes'
)

const divergedMiddleListSlotFill = preserveRichMarkdownSource(
  '- 1. divergence\n\n轮三正文\n\n```\ncode\n```\n',
  '* <br />\n\n  1. divergence\n\n轮三正文\n\n<br />\n\n```\ncode\n```\n\n',
  '* <br />\n\n  1. divergence\n\n轮三正文\n\n1. 轮四有序\n2. 轮四续项\n\n轮四尾文\n\n```\ncode\n```\n\n'
)
assert.equal(divergedMiddleListSlotFill.preserved, true)
assert.equal(divergedMiddleListSlotFill.reason, 'middle-empty-block-list-filled')
assert.equal(
  divergedMiddleListSlotFill.markdown,
  '- 1. divergence\n\n轮三正文\n\n1. 轮四有序\n2. 轮四续项\n\n轮四尾文\n\n```\ncode\n```\n',
  'a list and its following prose must atomically replace the proven middle empty paragraph slot'
)

const divergedMiddleListSlotFillCrLf = preserveRichMarkdownSource(
  '- 1. divergence\r\n\r\nbefore\r\n\r\n```\r\ncode\r\n```\r\n',
  '* <br />\n\n  1. divergence\n\nbefore\n\n<br />\n\n```\ncode\n```\n\n',
  '* <br />\n\n  1. divergence\n\nbefore\n\n1. item\n2. next\n\nafter\n\n```\ncode\n```\n\n'
)
assert.equal(divergedMiddleListSlotFillCrLf.preserved, true)
assert.equal(
  divergedMiddleListSlotFillCrLf.markdown,
  '- 1. divergence\r\n\r\nbefore\r\n\r\n1. item\r\n2. next\r\n\r\nafter\r\n\r\n```\r\ncode\r\n```\r\n',
  'a CRLF middle list slot must replace the complete left EOL pair without producing a lone carriage return'
)
assert.equal(
  /\r(?!\n)/.test(divergedMiddleListSlotFillCrLf.markdown),
  false,
  'a CRLF middle list slot must never emit a lone carriage return'
)

for (const [authored, expectedExit, expectedSibling] of [
  ['- a\n- b', '- a\n\n', '- a\n\n* new\n'],
  ['- a\n- b\n', '- a\n\n', '- a\n\n* new\n'],
  ['- a\r\n- b\r\n', '- a\r\n\r\n', '- a\r\n\r\n* new\r\n']
]) {
  const exited = preserveRichMarkdownSource(
    authored,
    '* a\n\n* b\n\n',
    '* a\n\n<br />\n\n'
  )
  assert.equal(exited.markdown, expectedExit, 'exiting the final list item must retain a distinct block slot')
  const sibling = preserveRichMarkdownSource(
    exited.markdown,
    '* a\n\n<br />\n\n',
    '* a\n\n* new\n\n<br />\n\n'
  )
  assert.equal(sibling.markdown, expectedSibling, 'a later sibling list must not be compacted into the prior list')
}

const duplicateListThenProse = preserveRichMarkdownSource(
  '- target\n',
  '* target\n\n',
  '* target\n\n* target\n\nprose\n'
)
assert.equal(duplicateListThenProse.preserved, true)
assert.equal(
  duplicateListThenProse.markdown,
  '- target\n\n* target\n\nprose\n',
  'a duplicate list row followed by prose must publish the complete transaction or fail closed atomically'
)

const divergedConsecutiveInsertions = preserveRichMarkdownSource(
  '- 1. A\n- B\n',
  '* <br />\n\n  1. A\n\n* B\n\n',
  '* <br />\n\n  1. A\n  2. X\n  3. Y\n\n* B\n\n'
)
assert.equal(
  divergedConsecutiveInsertions.markdown,
  '- 1. A\n  2. X\n  3. Y\n- B\n',
  'multiple inserted nested siblings must retain both canonical order and nesting'
)

const divergedOnlyRowLift = preserveRichMarkdownSource(
  '- 1. A\n',
  '* <br />\n\n  1. A\n\n',
  'A\n'
)
assert.equal(
  divergedOnlyRowLift.markdown,
  'A\n',
  'fully lifting the first and only diverged row must remove its authored list prefixes'
)

const divergedOnlyRowLiftBeforeParagraph = preserveRichMarkdownSource(
  '- 1. A\n\nparagraph\n',
  '* <br />\n\n  1. A\n\nparagraph\n',
  'A\n\nparagraph\n'
)
assert.equal(
  divergedOnlyRowLiftBeforeParagraph.markdown,
  'A\n\nparagraph\n',
  'lifting an only item before a paragraph must not duplicate the separator newline'
)

const divergedFirstRowLift = preserveRichMarkdownSource(
  '- 1. A\n- 2. B\n',
  '* <br />\n\n  1. A\n\n* <br />\n\n  2. B\n\n',
  'A\n\n* <br />\n\n  2. B\n\n'
)
assert.equal(
  divergedFirstRowLift.markdown,
  'A\n\n- 2. B\n',
  'fully lifting the first diverged row must keep the remaining authored list intact'
)

// Canonical block enumeration contains one outer list tree PLUS one block for
// every nested ordered row. Authored source has only the outer tree. A later,
// unrelated list must therefore be matched by top-level block ordinal; counting
// nested blocks makes this edit incorrectly target a non-existent source block.
const laterListSource = [
  '## 目录',
  '',
  '- 1. 管理层',
  '- 2. 综合行政部',
  '',
  '## 使用说明',
  '',
  '- 适用标准：**ISO 9001:2015**。',
  ''
].join('\n')
const laterListCanonical = [
  '## 目录',
  '',
  '* <br />',
  '',
  '  1. 管理层',
  '',
  '* <br />',
  '',
  '  2. 综合行政部',
  '',
  '## 使用说明',
  '',
  '* 适用标准：**ISO 9001:2015**。',
  ''
].join('\n')
const laterFormattedListEdit = preserveRichMarkdownSource(
  laterListSource,
  laterListCanonical,
  laterListCanonical.replace('适用标准：', '适用标准X：')
)
assert.equal(laterFormattedListEdit.reason, 'diverged-nested-list-change')
assert.equal(
  laterFormattedListEdit.markdown,
  laterListSource.replace('适用标准：', '适用标准X：'),
  'nested canonical blocks must not shift the authored counterpart of a later top-level list'
)

// A deletion spanning SEVERAL canonical blocks (here: the 复核。 item and the
// whole trailing `- ce` item) used to fail every localized mapper in a
// diverged document and roll back to the OLD source — the deletion vanished,
// saving resurrected the content. The canonical is the real Crepe
// serialization captured from the app for this edit.
const tailDeleteSource = [
  '- 1. 甲乙',
  '',
  '- 本表为 AI 生成草稿，正式发布前需经体系负责人 / 质量部门复核。',
  '- ce'
].join('\n') + '\n'
const tailDeletePrevious = [
  '* <br />',
  '',
  '  1. 甲',
  '  2. 乙',
  '',
  '* 本表为 AI 生成草稿，正式发布前需经体系负责人 / 质量部门复核。',
  '',
  '* ce',
  ''
].join('\n')
const tailDeleteNext = [
  '* <br />',
  '',
  '  1. 甲',
  '  2. 乙',
  '',
  '* 本表为 AI 生成草稿，正式发布前需经体系负责人 / 质量部门',
  ''
].join('\n')
const tailDeleted = preserveRichMarkdownSource(
  tailDeleteSource,
  tailDeletePrevious,
  tailDeleteNext
)
assert.equal(
  tailDeleted.reason,
  'diverged-nested-list-change',
  'a multi-block deletion in a diverged document must map through item-sequence alignment'
)
assert.equal(
  tailDeleted.markdown,
  [
    '- 1. 甲乙',
    '',
    '- 本表为 AI 生成草稿，正式发布前需经体系负责人 / 质量部门',
    ''
  ].join('\n'),
  'the deleted rows must vanish while the authored marker spelling survives'
)

// The family matrix deletes an appended paragraph from a document whose
// authored `- - literal` row becomes a nested canonical list. The divergence
// can sit inside the old fixed 24-character anchor while the immediate suffix
// before the deletion is still unique and identical. That local suffix plus
// an exact deleted-text check is sufficient to map the tail without forcing
// the user through recovery.
const divergedLiteralTailSource = [
  '# 测试',
  '',
  '字面序号 1\\. 保持字面。',
  '',
  '- - 嵌套字面',
  '',
  '尾段。',
  '',
  '家族验证123',
  ''
].join('\n')
const divergedLiteralTailPrevious = [
  '# 测试',
  '',
  '字面序号 1. 保持字面。',
  '',
  '* <br />',
  '',
  '  * 嵌套字面',
  '',
  '尾段。',
  '',
  '家族验证123',
  ''
].join('\n')
const divergedLiteralTailDeleted = preserveRichMarkdownSource(
  divergedLiteralTailSource,
  divergedLiteralTailPrevious,
  divergedLiteralTailPrevious.slice(0, divergedLiteralTailPrevious.indexOf('尾段。')) + '尾\n'
)
assert.equal(
  divergedLiteralTailDeleted.reason,
  'diverged-visible-delete',
  'a unique local suffix must map a verified tail deletion across an earlier representation divergence'
)
assert.equal(
  divergedLiteralTailDeleted.markdown,
  divergedLiteralTailSource.slice(0, divergedLiteralTailSource.indexOf('尾段。')) + '尾\n',
  'the tail deletion must preserve every unrelated authored byte and its final line ending'
)

const sourceOnlyDefinition = '[unused]: https://example.com'
const divergedTailWithHiddenSource = preserveRichMarkdownSource(
  [
    '# Doc',
    '',
    '- - nested',
    '',
    'Unique anchor before.',
    '',
    'TARGET1',
    '',
    sourceOnlyDefinition,
    '',
    'TARGET2',
    '',
    'Tail',
    ''
  ].join('\n'),
  [
    '# Doc',
    '',
    '* <br />',
    '',
    '  * nested',
    '',
    'Unique anchor before.',
    '',
    'TARGET1',
    '',
    'TARGET2',
    '',
    'Tail',
    ''
  ].join('\n'),
  [
    '# Doc',
    '',
    '* <br />',
    '',
    '  * nested',
    '',
    'Unique anchor before.',
    '',
    'Tail',
    ''
  ].join('\n')
)
assert.equal(
  divergedTailWithHiddenSource.preserved,
  false,
  'visible deletion fallback must not consume an unused source-only definition hidden from ProseMirror'
)
assert.ok(
  divergedTailWithHiddenSource.markdown.includes(sourceOnlyDefinition),
  'fail-closed deletion must retain the hidden source asset byte-for-byte'
)

// Clearing a quote's text first leaves an authored empty quote line (`>`).
// Pressing Backspace again removes the blockquote node itself. Both source and
// canonical have the same visible stream, so a visible-text mapper sees a
// zero-width change; the syntax-only `>` row still has to be removed or save
// and reopen resurrect the deleted quote.
const removedEmptyQuote = preserveRichMarkdownSource(
  'before\n\n>\n\nafter\n',
  'before\n\n> <br />\n\nafter\n',
  'before\n\nafter\n'
)
assert.equal(
  removedEmptyQuote.markdown,
  'before\n\nafter\n',
  'removing an empty blockquote must remove its syntax-only authored `>` row'
)
assert.equal(
  removedEmptyQuote.reason,
  'empty-blockquote-removed',
  'empty blockquote deletion must use the dedicated syntax-only mapping path'
)

const divergedQuoteSource = [
  '前文。* **输入设备：** 内容足够长，使分叉点远离后面的引用边界。',
  '',
  'before',
  '',
  '>',
  '',
  'after',
  ''
].join('\n')
const divergedQuotePrevious = divergedQuoteSource
  .replace('。* ', '。\\* ')
  .replace('\n>\n', '\n> <br />\n')
const divergedQuoteNext = divergedQuotePrevious.replace('\n> <br />\n\n', '\n')
const removedDivergedEmptyQuote = preserveRichMarkdownSource(
  divergedQuoteSource,
  divergedQuotePrevious,
  divergedQuoteNext
)
assert.equal(
  removedDivergedEmptyQuote.markdown,
  divergedQuoteSource.replace('\nbefore\n\n>\n\nafter\n', '\nbefore\n\nafter\n'),
  'empty quote removal must use local anchors even when source and canonical diverge elsewhere'
)

const appendedAfterDivergedQuote = preserveRichMarkdownSource(
  '- - nested\n\n> same\n>\n> same\n',
  '* <br />\n\n  * nested\n\n> same\n>\n> same\n\n',
  '* <br />\n\n  * nested\n\n> same\n>\n> same\n\ntail\n'
)
assert.equal(
  appendedAfterDivergedQuote.markdown,
  '- - nested\n\n> same\n>\n> same\n\ntail\n',
  'typing into the trailing empty paragraph after a quote must append at the document end even when earlier visible streams diverge'
)
assert.equal(
  ['appended-paragraph', 'diverged-tail-block-append'].includes(appendedAfterDivergedQuote.reason),
  true,
  `tail append after a diverged quote must be owned by an append mapper, got ${appendedAfterDivergedQuote.reason}`
)

const removedOneOfTwoEmptyQuotes = preserveRichMarkdownSource(
  '# 标题\n\n>\n\n>\n\n## 后文\n',
  '# 标题\n\n> <br />\n\n> <br />\n\n## 后文\n',
  '# 标题\n\n> <br />\n\n## 后文\n'
)
assert.equal(
  removedOneOfTwoEmptyQuotes.markdown,
  '# 标题\n\n>\n\n## 后文\n',
  'removing one of consecutive empty quotes must retain exactly one authored quote row'
)
assert.equal(
  removedOneOfTwoEmptyQuotes.reason,
  'empty-blockquote-removed',
  'consecutive empty quotes must use the same syntax-only quote mapping path'
)

// A serializer escape near the beginning can permanently shift the canonical
// visible stream. A later, uniquely anchored one-line edit must still update
// only its authored source range rather than falling back to stale bytes.
const uniqueAnchorPadding =
  '这是足够长的中间内容，用于隔离前面的可见流分叉并保持局部上下文一致。'.repeat(2)
const uniqueAnchorSource =
  `前文。* **输入设备：** ${uniqueAnchorPadding}\n\n尾部原文\n`
const uniqueAnchorPrevious =
  `前文。\\* **输入设备：** ${uniqueAnchorPadding}\n\n尾部原文\n`
const uniqueAnchorNext =
  `前文。\\* **输入设备：** ${uniqueAnchorPadding}\n\n尾部原文新增\n`
const uniqueAnchorChange = commonChange(uniqueAnchorPrevious, uniqueAnchorNext)
const uniquelyAnchoredText = preserveUniquelyAnchoredTextChange({
  source: uniqueAnchorSource,
  previous: uniqueAnchorPrevious,
  next: uniqueAnchorNext,
  ...uniqueAnchorChange
})
assert.equal(
  uniquelyAnchoredText?.markdown,
  uniqueAnchorSource.replace('尾部原文', '尾部原文新增'),
  'a unique later text edit must survive an earlier source/canonical visible-stream divergence'
)
assert.equal(
  uniquelyAnchoredText?.reason,
  'uniquely-anchored-text-change',
  'the divergent one-line edit must be proven by its unique local visible context'
)

const typedLiteralNumberInOrderedItem = preserveRichMarkdownSource(
  '1. 第一\n2. 第二\n3. \n',
  '1. 第一\n2. 第二\n3. <br />\n',
  '1. 第一\n2. 第二\n3. 2\\. 测试\n'
)
assert.equal(
  typedLiteralNumberInOrderedItem.markdown,
  '1. 第一\n2. 第二\n3. 2\\. 测试\n',
  'literal numbering inside an ordered item must retain the escape required to prevent accidental nesting'
)

const mixedListLiteralNumberEdit = preserveRichMarkdownSource(
  '1. 第一项\n2. 有序占位\n\n- 普通项\n- 无序占位\n',
  '1. 第一项\n2. 有序占位\n\n* 普通项\n\n* 无序占位\n',
  '1. 第一项\n2. 2\\. 测试\n\n* 普通项\n\n* 无序占位\n\n'
)
assert.equal(
  mixedListLiteralNumberEdit.markdown,
  '1. 第一项\n2. 2\\. 测试\n\n- 普通项\n- 无序占位\n',
  'editing one ordered row must retain literal-text semantics without normalizing a later bullet list'
)

const typedLiteralNumberInBulletItem = preserveRichMarkdownSource(
  '- 第一\n- \n',
  '* 第一\n* <br />\n',
  '* 第一\n* 1\\. 测试\n'
)
assert.equal(
  typedLiteralNumberInBulletItem.markdown,
  '- 第一\n- 1\\. 测试\n',
  'literal numbering inside a bullet item must retain the escape required to prevent accidental nesting'
)

const authoredEscapedNumberStillPreserved = preserveRichMarkdownSource(
  '- 2\\. 作者原文\n',
  '* 2\\. 作者原文\n',
  '* 2\\. 作者原文新增\n'
)
assert.equal(
  authoredEscapedNumberStillPreserved.markdown,
  '- 2\\. 作者原文新增\n',
  'an existing authored number escape must remain when later text is edited'
)

const literalListMarkersInsideItems = preserveRichMarkdownSource(
  [
    '1. 有序短横占位',
    '2. 有序加号占位',
    '3. 有序星号占位',
    '4. 有序括号占位',
    '',
    '- 无序短横占位',
    '- 无序加号占位',
    '- 无序星号占位',
    '- 无序括号占位',
    ''
  ].join('\n'),
  [
    '1. 有序短横占位',
    '2. 有序加号占位',
    '3. 有序星号占位',
    '4. 有序括号占位',
    '',
    '* 无序短横占位',
    '',
    '* 无序加号占位',
    '',
    '* 无序星号占位',
    '',
    '* 无序括号占位',
    ''
  ].join('\n'),
  [
    '1. \\- 测试',
    '2. \\+ 测试',
    '3. \\* 测试',
    '4. 2\\) 测试',
    '',
    '* \\- 测试',
    '',
    '* \\+ 测试',
    '',
    '* \\* 测试',
    '',
    '* 1\\) 测试',
    ''
  ].join('\n')
)
assert.equal(
  literalListMarkersInsideItems.markdown,
  [
    '1. \\- 测试',
    '2. \\+ 测试',
    '3. \\* 测试',
    '4. 2\\) 测试',
    '',
    '- \\- 测试',
    '- \\+ 测试',
    '- \\* 测试',
    '- 1\\) 测试',
    ''
  ].join('\n'),
  'all list-marker-shaped item text must retain only the escapes required for literal-text semantics'
)

const laterLiteralMarkerEdit = preserveRichMarkdownSource(
  '- \\- 测试\n',
  '* \\- 测试\n',
  '* \\- 测试新增\n'
)
assert.equal(
  laterLiteralMarkerEdit.markdown,
  '- \\- 测试新增\n',
  'a later edit must preserve the structural escape established by the first verified edit'
)

const authoredEscapedMarkerStillPreserved = preserveRichMarkdownSource(
  '- \\- 作者原文\n',
  '* \\- 作者原文\n',
  '* \\- 作者原文新增\n'
)
assert.equal(
  authoredEscapedMarkerStillPreserved.markdown,
  '- \\- 作者原文新增\n',
  'an authored list-marker escape must remain when later text is edited'
)

const filledEmptyWithRawBacktick = preserveRichMarkdownSource(
  'before\n\n\nafter\n',
  'before\n\n<br />\n\nafter\n',
  'before\n\n\\`\n\nafter\n'
)
assert.equal(
  filledEmptyWithRawBacktick.markdown,
  'before\n\n`\n\nafter\n',
  'a newly typed unmatched backtick must keep the raw character the user entered'
)

const editedAfterCanonicalEmptyRows = preserveRichMarkdownSource(
  '# heading\n\n\n\nplaceholder\n\nafter\n',
  '# heading\n\n<br />\n\nplaceholder\n\nafter\n',
  '# heading\n\n<br />\n\nchanged\n\nafter\n'
)
assert.equal(
  editedAfterCanonicalEmptyRows.markdown,
  '# heading\n\n\n\nchanged\n\nafter\n',
  'an empty rich paragraph before the edited row must not map the edit onto the heading boundary'
)

const typedRawBacktickAfterCanonicalEmptyRows = preserveRichMarkdownSource(
  '# heading\n\n\n\nplaceholder\n\nafter\n',
  '# heading\n\n<br />\n\nplaceholder\n\nafter\n',
  '# heading\n\n<br />\n\n\\`\n\nafter\n'
)
assert.equal(
  typedRawBacktickAfterCanonicalEmptyRows.markdown,
  '# heading\n\n\n\n`\n\nafter\n',
  'fresh escaped punctuation after an empty rich paragraph must map by row and keep raw source spelling'
)

const replacedTextWithRawBacktick = preserveRichMarkdownSource(
  'before\n\nplaceholder\n\nafter\n',
  'before\n\nplaceholder\n\nafter\n',
  'before\n\n\\`\n\nafter\n'
)
assert.equal(
  replacedTextWithRawBacktick.markdown,
  'before\n\n`\n\nafter\n',
  'replacing a normal line with one raw backtick must not leak serializer escaping'
)

const deletedRawBacktickLine = preserveRichMarkdownSource(
  'before\n\n`\n\nafter\n',
  'before\n\n\\`\n\nafter\n',
  'before\n\n<br />\n\nafter\n'
)
assert.equal(
  deletedRawBacktickLine.markdown,
  'before\n\n\n\nafter\n',
  'deleting an unmatched raw backtick must not fail closed or resurrect it'
)
assert.equal(deletedRawBacktickLine.reason, 'escaped-literal-line-emptied')

const partiallyDeletedRawBacktickLine = preserveRichMarkdownSource(
  'before\n\n```\n\nafter\n',
  'before\n\n\\`\\`\\`\n\nafter\n',
  'before\n\n\\`\n\nafter\n'
)
assert.equal(
  partiallyDeletedRawBacktickLine.markdown,
  'before\n\n`\n\nafter\n',
  'deleting two of three unmatched backticks must retain the remaining raw backtick'
)
assert.equal(partiallyDeletedRawBacktickLine.reason, 'escaped-literal-line-changed')

const changedSecondRepeatedRawBacktickLine = preserveRichMarkdownSource(
  'before\n\n`\n\n`\n\nafter\n',
  'before\n\n\\`\n\n\\`\n\nafter\n',
  'before\n\n\\`\n\n\\`\\`\n\nafter\n'
)
assert.equal(
  changedSecondRepeatedRawBacktickLine.markdown,
  'before\n\n`\n\n``\n\nafter\n',
  'repeated punctuation-only rows must map by row identity rather than global text uniqueness'
)

const replacedSecondRepeatedRawBacktickLine = preserveRichMarkdownSource(
  'before\n\n`\n\n`\n\nafter\n',
  'before\n\n\\`\n\n\\`\n\nafter\n',
  'before\n\n\\`\n\n删除围栏后继续写作\n\nafter\n'
)
assert.equal(
  replacedSecondRepeatedRawBacktickLine.markdown,
  'before\n\n`\n\n删除围栏后继续写作\n\nafter\n',
  'replacing the second repeated raw backtick row with normal text must not lock later source sync'
)

const filledEmptyWithRawTripleBacktick = preserveRichMarkdownSource(
  'before\n\n\nafter\n',
  'before\n\n<br />\n\nafter\n',
  'before\n\n\\`\\`\\`\n\nafter\n'
)
assert.equal(
  filledEmptyWithRawTripleBacktick.markdown,
  'before\n\n```\n\nafter\n',
  'literal triple backticks retained by the editor must remain exactly user-typed source'
)

const exactBaselineKeepsUntouchedAuthoredEscape = preserveRichMarkdownSource(
  'authored \\* stays\n\nplaceholder\n',
  'authored \\* stays\n\nplaceholder\n',
  'authored \\* stays\n\nchanged\n'
)
assert.equal(
  exactBaselineKeepsUntouchedAuthoredEscape.markdown,
  'authored \\* stays\n\nchanged\n',
  'fresh escape restoration must remain local and leave untouched authored escapes byte-exact'
)

// Deeply diverged document, final line spelled with a different backtick run
// in source than in canonical: appending text at the document end must
// continue the authored final line instead of failing closed.
const divergedTailInlineAppend = preserveRichMarkdownSource(
  '# 测试\n\n1\n```ces```\n',
  '# 测试\n\n1\n`ces`\n',
  '# 测试\n\n1\n`ces`末段新增验证\n'
)
assert.equal(
  divergedTailInlineAppend.markdown,
  '# 测试\n\n1\n```ces```末段新增验证\n',
  'tail append on a diverged inline-code row must continue the authored final line'
)
assert.equal(divergedTailInlineAppend.reason, 'diverged-tail-block-append')

const divergedTailRejectsDifferentSourceLine = preserveRichMarkdownSource(
  'A\n\n```x```\n',
  'A\n\ny\n',
  'A\n\nyZ\n'
)
assert.equal(
  divergedTailRejectsDifferentSourceLine.preserved,
  false,
  'tail-line append must refuse when the authored final line has different inline text'
)

const {
  preserveDivergedTailBlockAppend
} = await import('../src/renderer/src/lib/markdown-preservation/regions.js')
assert.equal(
  preserveDivergedTailBlockAppend({
    source: 'A\n\n```x```\n\nB\n',
    previous: 'A\n\nx\n\nB\n',
    next: 'A\n\nxZ\n\nB\n',
    nextEnd: 'A\n\nxZ\n\nB\n'.length
  }),
  null,
  'tail-line append must refuse when the edit is not on the final line'
)

// Input-rule merge on the final authored line (`2` + typed `1. …` folds into
// `21. …`): the authored line becomes the first list row and the remaining
// canonical rows are appended verbatim.
const mergedTail = preserveDivergedTailBlockAppend({
  source: 'A\n\nB\n\n2\n',
  previous: 'A\n\nB\n\n2\n',
  next: 'A\n\nB\n\n21. 序列验证X\n22. 有序二\n',
  start: commonChange('A\n\nB\n\n2\n', 'A\n\nB\n\n21. 序列验证X\n22. 有序二\n').start,
  nextEnd: 'A\n\nB\n\n21. 序列验证X\n22. 有序二\n'.length - 1
})
assert.equal(
  mergedTail?.markdown,
  'A\n\nB\n\n21. 序列验证X\n22. 有序二\n',
  'input-rule merge on the final authored line must fold into the first list row'
)
assert.equal(mergedTail?.reason, 'diverged-tail-block-append')

// Diverged-tail append must unescape the serializer's `&#x20;` spelling for
// item-leading spaces; leaking the entity corrupts authored source.
const tailAppendUnescapesSpaceEntities = preserveRichMarkdownSource(
  'A\n\n1. 测试\n',
  'A\n\n1. 测试\n',
  'A\n\n1. 测试\n\n2. &#x20;   新内容\n'
)
assert.equal(
  tailAppendUnescapesSpaceEntities?.markdown,
  'A\n\n1. 测试\n2. \u200B    新内容\n',
  'diverged-tail append must unescape &#x20; item-leading spaces'
)

// A second edit cycle can exit an ordered list into an empty trailing
// paragraph, then create a sibling bullet list before markdownUpdated runs.
// Crepe's terminal `<br />` is not authored content and must not make the
// structural tail mapper reject the real bullet block. Rejecting it lets the
// generic visible mapper splice `* item` before the last source newline and
// corrupt the file as `3. previous* item`.
const siblingListAfterTrailingPlaceholder = preserveRichMarkdownSource(
  '1. 第一项\n2. 第二项\n3. 第三项\n',
  '1. 第一项\n2. 第二项\n3. 第三项\n\n<br />\n\n',
  '1. 第一项\n2. 第二项\n3. 第三项\n\n* 新无序项\n\n<br />\n\n'
)
assert.equal(
  siblingListAfterTrailingPlaceholder.markdown,
  '1. 第一项\n2. 第二项\n3. 第三项\n\n* 新无序项\n',
  'terminal empty-paragraph placeholder must not glue a sibling list onto the previous item'
)
assert.equal(
  siblingListAfterTrailingPlaceholder.reason,
  'diverged-tail-block-append',
  'a sibling structural block must stay on the dedicated tail mapper'
)

const multilineLocalFallback = preserveLocallyAlignedTextChange({
  source: '1. 第一项\n2. 第二项\n3. 第三项\n',
  previous: '1. 第一项\n2. 第二项\n3. 第三项\n\n<br />\n\n',
  next: '1. 第一项\n2. 第二项\n3. 第三项\n\n* 新无序项\n\n<br />\n\n',
  ...commonChange(
    '1. 第一项\n2. 第二项\n3. 第三项\n\n<br />\n\n',
    '1. 第一项\n2. 第二项\n3. 第三项\n\n* 新无序项\n\n<br />\n\n'
  )
})
assert.equal(
  multilineLocalFallback,
  null,
  'generic visible-text fallback must never own a multiline structural insertion'
)

// Canonical serialization adds a TERMINAL newline without a user edit when a
// document ends with a table (verified against the real app: trailing run
// 1 -> 2). That drift breaks the common suffix, so the delta grew from "one
// character in a paragraph" to "everything through the table to end of file";
// the table router then claimed a delta it does not own and failed closed on
// the text outside the table, making EVERY edit before a terminal table
// unsavable. These shapes lock the delta on the real edit and the authored
// table spelling (`| --- |`, never the canonical `| - |`) byte for byte.
{
  const TABLE_AUTHORED = '| a | b |\n| --- | --- |\n| 1 | 2 |\n'
  const TABLE_CANONICAL = '| a | b |\n| - | - |\n| 1 | 2 |\n'
  const outsideEdits = [
    {
      name: 'paragraph before a terminal table',
      source: `编辑区段落\n\n${TABLE_AUTHORED}`,
      previous: `编辑区段落\n\n${TABLE_CANONICAL}`,
      next: `编辑区段落甲\n\n${TABLE_CANONICAL}\n`,
      expected: `编辑区段落甲\n\n${TABLE_AUTHORED}`
    },
    {
      name: 'heading before a terminal table',
      source: `## 标题\n\n${TABLE_AUTHORED}`,
      previous: `## 标题\n\n${TABLE_CANONICAL}`,
      next: `## 标题甲\n\n${TABLE_CANONICAL}\n`,
      expected: `## 标题甲\n\n${TABLE_AUTHORED}`
    },
    {
      name: 'list item before a terminal table',
      source: `- 条目\n\n${TABLE_AUTHORED}`,
      previous: `* 条目\n\n${TABLE_CANONICAL}`,
      next: `* 条目甲\n\n${TABLE_CANONICAL}\n`,
      expected: `- 条目甲\n\n${TABLE_AUTHORED}`
    },
    {
      name: 'paragraph between two tables',
      source: `${TABLE_AUTHORED}\n中间段落\n\n${TABLE_AUTHORED}`,
      previous: `${TABLE_CANONICAL}\n中间段落\n\n${TABLE_CANONICAL}`,
      next: `${TABLE_CANONICAL}\n中间段落甲\n\n${TABLE_CANONICAL}\n`,
      expected: `${TABLE_AUTHORED}\n中间段落甲\n\n${TABLE_AUTHORED}`
    },
    {
      name: 'reverse drift (previous carries the extra newline)',
      source: `编辑区段落\n\n${TABLE_AUTHORED}`,
      previous: `编辑区段落\n\n${TABLE_CANONICAL}\n`,
      next: `编辑区段落甲\n\n${TABLE_CANONICAL}`,
      expected: `编辑区段落甲\n\n${TABLE_AUTHORED}`
    },
    {
      name: 'no drift at all (must stay on the same mapping)',
      source: `编辑区段落\n\n${TABLE_AUTHORED}`,
      previous: `编辑区段落\n\n${TABLE_CANONICAL}`,
      next: `编辑区段落甲\n\n${TABLE_CANONICAL}`,
      expected: `编辑区段落甲\n\n${TABLE_AUTHORED}`
    },
    {
      name: 'paragraph after the table (was already passing)',
      source: `${TABLE_AUTHORED}\n尾段\n`,
      previous: `${TABLE_CANONICAL}\n尾段\n`,
      next: `${TABLE_CANONICAL}\n尾段甲\n`,
      expected: `${TABLE_AUTHORED}\n尾段甲\n`
    }
  ]
  for (const shape of outsideEdits) {
    const mapped = preserveRichMarkdownSource(shape.source, shape.previous, shape.next)
    assert.notEqual(
      mapped.preserved,
      false,
      `editing outside a table must stay mappable (${shape.name}): ${mapped.reason}`
    )
    assert.equal(
      mapped.markdown,
      shape.expected,
      `editing outside a table must patch only that edit (${shape.name})`
    )
  }
  // The edit INSIDE a table keeps its dedicated owner while the same drift is
  // present, so the equalization must not divert cell edits to generic text
  // mapping.
  const insideEdit = preserveRichMarkdownSource(
    `前段\n\n${TABLE_AUTHORED}`,
    `前段\n\n${TABLE_CANONICAL}`,
    `前段\n\n| a | b |\n| - | - |\n| 1甲 | 2 |\n\n`
  )
  assert.notEqual(insideEdit.preserved, false, `a table cell edit must stay mappable: ${insideEdit.reason}`)
  assert.ok(
    insideEdit.markdown.includes('| --- | --- |'),
    'a table cell edit must keep the authored delimiter spelling'
  )
  assert.ok(
    insideEdit.markdown.includes('1甲'),
    'a table cell edit must reach authored source'
  )
}

// GFM has no spelling for an EMPTY task item: a checkbox must be followed by
// content, so `- [ ] ` re-parses as a plain bullet whose literal text is
// `[ ]`. That is a state the rich model can hold and the format cannot carry.
// The contract is NOT to invent a byte convention for it: the checkbox is
// declared non-durable on an empty item (see editor-durable-semantics.js) and
// the row persists as a plain empty item, so the authored bytes stay standard
// Markdown. Locking the normalization here keeps the two halves in step.
{
  const emptyTaskItem = normalizeEmptyListItems('* [ ] 待办\n\n* [ ] <br />\n')
  assert.equal(
    emptyTaskItem,
    '* [ ] 待办\n\n* \n',
    'an emptied task item must normalize to a plain empty item, never to an invented spelling'
  )
  assert.ok(
    !/&#x20;|\u200B/.test(emptyTaskItem),
    'an emptied task item must not carry an entity or sentinel spelling'
  )
  assert.equal(
    normalizeEmptyListItems('* 普通\n\n* <br />\n'),
    '* 普通\n\n* \n',
    'a plain empty item keeps its (legal) empty body'
  )
  // A task item WITH content keeps its checkbox untouched.
  assert.equal(
    normalizeEmptyListItems('* [x] 已完成\n'),
    '* [x] 已完成\n',
    'a task item with content must not lose its checkbox'
  )
}

// Enter on a list item makes an empty item; Enter again LIFTS that empty item
// out of the list into a standalone paragraph. The canonical then replaces the
// list row with a bare `<br />`. The authored empty row must go with it: an
// empty paragraph has no Markdown spelling, and keeping the row left the
// source describing an item the document no longer has. The lifted row is
// itself empty, so it cannot be located by visible text — the item above it is
// the anchor. (Field report: "无序列表填写后，第二个回车放入然后删除这个时候
// 保存就会报错" — every mid-document exit-the-list became unsavable.)
{
  const source = '# T\n\n段落\n\n- 有内容的项\n- \n\n后续段落\n\n- 1\n- 2\n'
  const previous = '# T\n\n段落\n\n* 有内容的项\n\n* <br />\n\n后续段落\n\n* 1\n\n* 2\n\n'
  const next = '# T\n\n段落\n\n* 有内容的项\n\n<br />\n\n后续段落\n\n* 1\n\n* 2\n\n'
  const lifted = preserveRichMarkdownSource(source, previous, next)
  assert.notEqual(lifted.preserved, false, `lifting an empty item must stay mappable: ${lifted.reason}`)
  assert.equal(
    lifted.markdown,
    '# T\n\n段落\n\n- 有内容的项\n\n后续段落\n\n- 1\n- 2\n',
    'the lifted empty row must be removed, and nothing added in its place'
  )
  assert.ok(
    !/^- \s*$/m.test(lifted.markdown),
    'no empty list row may survive the lift'
  )
  // The same shape at the END of the document keeps its existing handling.
  const tailSource = '# T\n\n- 有内容的项\n- \n'
  const tailPrevious = '# T\n\n* 有内容的项\n\n* <br />\n'
  const tailNext = '# T\n\n* 有内容的项\n\n<br />\n'
  const tail = preserveRichMarkdownSource(tailSource, tailPrevious, tailNext)
  assert.notEqual(tail.preserved, false, `a trailing lift must stay mappable: ${tail.reason}`)
  assert.ok(!/^- \s*$/m.test(tail.markdown), 'a trailing lifted row must be removed too')
}

// The lifted row is empty, so it cannot identify itself by text. Row ORDINAL
// is the identity — both sides describe the same document — and text is only
// the fallback, because a document may legitimately repeat an item's text.
// Guessing there could delete a row the user still has, so ambiguity refuses.
{
  const repeated = preserveRichMarkdownSource(
    '# T\n\n- 重复\n\n段落\n\n- 重复\n- \n\n尾段\n',
    '# T\n\n* 重复\n\n段落\n\n* 重复\n\n* <br />\n\n尾段\n',
    '# T\n\n* 重复\n\n段落\n\n* 重复\n\n<br />\n\n尾段\n'
  )
  assert.notEqual(repeated.preserved, false, `a repeated anchor must not fail closed: ${repeated.reason}`)
  assert.equal(
    repeated.markdown,
    '# T\n\n- 重复\n\n段落\n\n- 重复\n\n尾段\n',
    'the lifted row is identified by ordinal, so a repeated item text stays intact'
  )
  assert.equal(
    (repeated.markdown.match(/^- 重复$/gm) || []).length,
    2,
    'neither repeated row may be consumed by the lift'
  )
}

// A block inserted inside a blockquote must land on its own quoted line, and a
// row joining an authored list must carry that list's marker: CommonMark starts
// a NEW list when the bullet changes, so a serializer `*` beside an authored
// `-` splits one list in two and the verified commit refuses the write.
{
  const quotedRow = preserveRichMarkdownSource(
    '# T\n\n> - 项一\n\n后续\n',
    '# T\n\n> * 项一\n\n后续\n',
    '# T\n\n> * 项一\n>\n> * 项二\n\n后续\n'
  )
  assert.equal(
    quotedRow.markdown,
    '# T\n\n> - 项一\n>\n> - 项二\n\n后续\n',
    'a row added to a quoted list keeps the authored bullet and stays inside the quote'
  )

  const quotedParagraph = preserveRichMarkdownSource(
    '# T\n\n> 3123331\n>\n> - 3123213\n\n后续\n',
    '# T\n\n> 3123331\n>\n> * 3123213\n\n后续\n',
    '# T\n\n> 3123331\n>\n> * 3123213\n>\n> 新正文\n\n后续\n'
  )
  assert.equal(
    quotedParagraph.markdown,
    '# T\n\n> 3123331\n>\n> - 3123213\n>\n> 新正文\n\n后续\n',
    'a paragraph appended after a quoted list starts on its own line, not glued to the row'
  )
}

// `-`, `+` and `*` are three DIFFERENT lists in CommonMark, and the serializer
// alternates markers precisely to keep adjacent lists apart. A mapper that
// reformats the edited list must respect that boundary, or it rewrites the
// neighbours' markers too and the candidate describes one merged list.
{
  const neighbours = preserveRichMarkdownSource(
    '- a\n- b\n\n+ c\n+ d\n\n* e\n* \n',
    '* a\n\n* b\n\n- c\n\n- d\n\n* e\n\n* <br />\n',
    '* a\n\n* b\n\n- c\n\n- d\n\n* e\n\n* f\n'
  )
  assert.equal(
    neighbours.markdown,
    '- a\n- b\n\n+ c\n+ d\n\n* e\n* f\n',
    'filling an empty item must not rewrite the neighbouring lists own markers'
  )
}

// Compaction REWRITES authored spacing, and a rewrite can change the parse.
// The generator does not try to predict which spellings are safe: it proposes
// the compact one and keeps the serializer-spaced one, and the commit gate —
// which has the parser — decides. These two assertions are why that ladder
// exists and why it can help.
{
  const shape = (markdown) => JSON.stringify(
    unified().use(remarkParse).use(remarkGfm).parse(markdown).children.map(function describe (node) {
      return node.children ? { [node.type]: node.children.map(describe) } : node.type
    })
  )
  // `-` is also a setext underline and CommonMark forbids an EMPTY list item
  // from interrupting a paragraph, so removing the blank line here turns the
  // nested row into an `<h2>` inside the item.
  assert.notEqual(
    shape('- c\n\n  - \n'),
    shape('- c\n  - \n'),
    'compaction can change the parse — this is the hazard, stated as a parser fact'
  )
  const canonical = '# T\n\n1. a\n2. b\n\n* c\n\n  * <br />\n'
  const spacious = generatedScratchMarkdown(canonical, undefined, { compactSpacing: false })
  assert.notEqual(
    compactGeneratedListSpacing(spacious),
    spacious,
    'the generator must offer the gate two distinct spellings to choose between'
  )
}

// A blockquote prefix is block SYNTAX and can wrap any block. Until it was
// stripped before block classification, `> | a | b |` was not recognised as a
// table and `> ```go` was not recognised as a fence, so their raw bytes leaked
// into the visible stream while canonical's did not — every document quoting a
// table or a code block desynced permanently and refused every edit.
{
  const quotedTable = sourceVisibleIndex(
    '> | 23132  | 2311   |  |\n> | :----- | :----- | :----- |\n> |  | 3132   | 3123 |\n'
  ).text
  const plainTable = sourceVisibleIndex(
    '| 23132 | 2311 |  |\n| :-- | :-- | :-- |\n|  | 3132 | 3123 |\n'
  ).text
  assert.equal(quotedTable, plainTable, 'a quoted table must project the same visible text as a plain one')

  assert.equal(
    sourceVisibleIndex('> ```Go\n> func f() {\n>   return b == 1\n> }\n> ```\n').text,
    '\nfunc f() {\n  return b == 1\n}\n',
    'a quoted fence keeps its code verbatim and drops the language token'
  )
  // The mirror case: inside a fence that was NOT opened in a quote, a leading
  // `>` is code content (a diff, a shell transcript) and must survive.
  assert.equal(
    sourceVisibleIndex('```\n> not a quote\n```\n').text,
    '\n> not a quote\n',
    'a `>` line inside a top-level fence is code, not a quote prefix'
  )
}

// A canonical offset can fall BETWEEN two visible characters — inside line
// endings, quote prefixes and list markers, none of which carry visible text.
// The backward mapping always lands at the START of that gap, so a new quoted
// block was glued onto the previous paragraph (`> 段落新段`) instead of
// starting its own block. The insertion point must keep the canonical's own
// place inside the gap: the same number of block boundaries crossed, and the
// same prefix kinds consumed after the last one.
{
  const gapInsertion = preserveRichMarkdownSource(
    '# T\n\n> 段落\n>\n> * [ ] 任务\n>\n> | a | b |  |\n> | :-- | :-- | :-- |\n> | c | d |  |\n\n尾段\n',
    '# T\n\n> 段落\n>\n> * [ ] 任务\n>\n> | a | b | <br /> |\n> | :--- | :--- | :--- |\n> | c | d | <br /> |\n\n尾段\n',
    '# T\n\n> 段落\n>\n> 新段\n>\n> * [ ] 任务\n>\n> | a | b | <br /> |\n> | :--- | :--- | :--- |\n> | c | d | <br /> |\n\n尾段\n'
  )
  assert.equal(
    gapInsertion.markdown,
    '# T\n\n> 段落\n>\n> 新段\n>\n> * [ ] 任务\n>\n> | a | b |  |\n> | :-- | :-- | :-- |\n> | c | d |  |\n\n尾段\n',
    'a new quoted paragraph starts its own block instead of being glued onto the previous one'
  )
}

// Emptying a task item INSIDE a blockquote. Two separate defects met here:
// the `<br />` placeholder normalizer did not tolerate the `> ` prefix, and the
// deletion's start offset fell inside block syntax, so it was resolved to the
// end of the previous row's text and the deletion swallowed both blank quote
// lines and the row itself. The row must survive as a plain empty item (the
// checkbox is non-durable — GFM cannot spell an empty task item).
{
  const source   = '# T\n\n> * [ ] a\n> * [ ] b\n>\n>\n> * [ ] 12312\n>\n>\n>\n> | x | y |  |\n> | :-- | :-- | :-- |\n> | c | d |  |\n\n尾\n'
  const previous = '# T\n\n> * [ ] a\n>\n> * [ ] b\n>\n> * [ ] 12312\n>\n> | x | y | <br /> |\n> | :--- | :--- | :--- |\n> | c | d | <br /> |\n\n尾\n'
  const emptied = preserveRichMarkdownSource(source, previous, previous.replace('> * [ ] 12312', '> * [ ] <br />'))
  assert.equal(
    emptied.markdown,
    '# T\n\n> * [ ] a\n> * [ ] b\n>\n>\n> * \n>\n>\n>\n> | x | y |  |\n> | :-- | :-- | :-- |\n> | c | d |  |\n\n尾\n',
    'an emptied quoted task item keeps its row and every surrounding byte'
  )
}

// A bullet row joins the list of the authored row directly adjacent to it —
// SAME quote depth and SAME indent. A change of marker starts a new list in
// CommonMark, so the adjacent row's marker is the only spelling that keeps the
// inserted row in the list the editor displays it in. A neighbour at another
// depth or indent belongs to a different list and says nothing about this row.
{
  const at = (text) => ({ start: text.length, end: text.length })
  const nested = '- 顶层\n  * 嵌套\n'
  assert.equal(
    adoptAdjacentBulletMarker('* 新顶层\n', nested, at(nested)),
    '* 新顶层\n',
    'a nested neighbour must not lend its marker to a top-level row'
  )
  const quoted = '> - 引用项\n'
  assert.equal(
    adoptAdjacentBulletMarker('> * 新项\n', quoted, at(quoted)),
    '> - 新项\n',
    'a row joining a quoted list adopts that list own marker'
  )
  assert.equal(
    adoptAdjacentBulletMarker('* 顶层新项\n', quoted, at(quoted)),
    '* 顶层新项\n',
    'a quoted neighbour must not lend its marker to a top-level row'
  )
  const mixed = '- 甲\n'
  assert.equal(
    adoptAdjacentBulletMarker('* 乙\n', mixed, { start: 0, end: mixed.length }),
    '* 乙\n',
    'only a pure insertion takes its identity from its surroundings'
  )
}

console.log('PASS markdown source preservation: text and structural edits retain untouched source; table/list changes stay block-bounded')
