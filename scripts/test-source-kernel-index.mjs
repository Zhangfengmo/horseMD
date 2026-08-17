import assert from 'node:assert/strict'
import { buildSyntaxIndex } from '../src/renderer/src/lib/source-kernel/syntax-index.js'

// 行扫描：LF / CRLF / lone-CR / 末尾换行
{
  const idx = buildSyntaxIndex('a\r\nb\rc\nd')
  assert.deepEqual(idx.lines.map((l) => [l.text, l.ending]),
    [['a', '\r\n'], ['b', '\r'], ['c', '\n'], ['d', '']])
  assert.equal(idx.dominantEnding, '\r\n')
  assert.equal(buildSyntaxIndex('x\n').lines.length, 2) // 尾部空行记录
  assert.equal(buildSyntaxIndex('x\n').dominantEnding, '\n')
}

// 块索引
{
  const src = '# 头\n\n段落甲\n'
  const idx = buildSyntaxIndex(src)
  assert.equal(idx.blockAt(1).type, 'heading')
  assert.equal(idx.blockAt(src.indexOf('段落甲')).type, 'paragraph')
  assert.equal(idx.blockAt(src.indexOf('\n\n') + 1), null) // 块间隙
}

// 列表项记录：bullet + 任务 + 有序 + 嵌套 + 引用内
{
  const src = [
    '- 甲',
    '- [x] 乙',
    '  1) 丙',
    '',
    '> * 丁',
    ''
  ].join('\n')
  const idx = buildSyntaxIndex(src)

  const jia = idx.listItemAt(src.indexOf('甲'))
  assert.equal(jia.marker, '-')
  assert.equal(jia.ordered, null)
  assert.equal(jia.task, null)
  assert.equal(jia.spacing, ' ')
  assert.equal(jia.depth, 0)
  assert.equal(jia.quotePrefix, '')
  assert.equal(jia.empty, false)

  const yi = idx.listItemAt(src.indexOf('乙'))
  assert.equal(yi.task.checked, true)
  assert.equal(src.slice(yi.task.from, yi.task.to), '[x]')
  assert.equal(yi.taskSpacing, ' ')
  assert.equal(src.slice(yi.contentStart, yi.contentStart + 1), '乙')

  const bing = idx.listItemAt(src.indexOf('丙'))
  assert.deepEqual(bing.ordered, { number: 1, delimiter: ')' })
  assert.equal(bing.indent, '  ')
  assert.equal(bing.depth, 1)

  const ding = idx.listItemAt(src.indexOf('丁'))
  assert.equal(ding.quotePrefix, '> ')
  assert.equal(ding.marker, '*')

  // 空项
  const empty = buildSyntaxIndex('- 甲\n- \n')
  const item = empty.listItemAt(6)
  assert.equal(item.empty, true)
}

// containerRange：嵌套列表返回最外层列表整行范围
{
  const src = '前段\n\n- 甲\n  - 乙\n\n后段\n'
  const idx = buildSyntaxIndex(src)
  const range = idx.containerRange(src.indexOf('乙'))
  assert.equal(src.slice(range.start, range.end), '- 甲\n  - 乙\n')
}

// ---- 数学域（计划五 Task 1）：内核链加 remark-math 后的解析形状 ----
//
// 为什么必须加：编辑器链（@milkdown/crepe 的 latex feature）本身就 `import
// remarkMath from 'remark-math'` 并以**默认选项**挂载（node_modules/@milkdown/
// crepe/lib/esm/feature/latex/index.js:16,365-367），并把 mdast `math` 重写为
// `{type:'code', lang:'LaTeX'}`（同文件 :370-382）。内核链此前没有 remark-math，
// 于是同一份字节在两侧解析成不同的树 → projection map 整图 null → 含数学的文档
// 在内核模式下**整篇降级**。下面每一条形状都以"内核链与编辑器链逐节点一致"为
// 准绳，而不是以某种直觉上的"数学应该长什么样"为准绳。
const childrenOf = (src) => buildSyntaxIndex(src).tree.children
const shape = (node) => {
  const o = { type: node.type }
  if (node.value !== undefined) o.value = node.value
  if (node.position) o.pos = [node.position.start.offset, node.position.end.offset]
  if (node.children) o.children = node.children.map(shape)
  return o
}

// 行内数学：`$...$` → inlineMath（有 position，覆盖两侧 `$`）
{
  assert.deepEqual(childrenOf('an $x^2$ formula\n').map(shape), [{
    type: 'paragraph',
    pos: [0, 16],
    children: [
      { type: 'text', value: 'an ', pos: [0, 3] },
      { type: 'inlineMath', value: 'x^2', pos: [3, 8] },
      { type: 'text', value: ' formula', pos: [8, 16] }
    ]
  }])
}

// 块级数学：`$$\n..\n$$` → math 块（此前整块是 paragraph 里的一个 text 节点，
// 与 PM 的 code_block 无法配对 → 整图 null）
{
  const [math] = childrenOf('$$\nE=mc^2\n$$\n')
  assert.equal(math.type, 'math')
  assert.equal(math.value, 'E=mc^2')
  assert.deepEqual([math.position.start.offset, math.position.end.offset], [0, 12])
  // blockAt 认得它（BLOCKS 早就含 'math'，此前是死代码）
  assert.equal(buildSyntaxIndex('$$\nE=mc^2\n$$\n').blockAt(4).type, 'math')
}

// 块级数学夹在段落之间：前后段落各自独立成块（此前三者会粘成一个 paragraph）
{
  assert.deepEqual(childrenOf('text\n$$\nx\n$$\ntext2\n').map((n) => n.type),
    ['paragraph', 'math', 'paragraph'])
}

// 引用/列表内的块级数学：仍是 math，position 从 `$$` 首字节起算
{
  const [quote] = childrenOf('> $$\n> E=mc^2\n> $$\n')
  assert.equal(quote.type, 'blockquote')
  assert.equal(quote.children[0].type, 'math')
  assert.deepEqual(
    [quote.children[0].position.start.offset, quote.children[0].position.end.offset], [2, 18])

  const [list] = childrenOf('- $$\n  E=mc^2\n  $$\n')
  assert.equal(list.children[0].children[0].type, 'math')
}

// 引用/列表内的行内数学
{
  const [quote] = childrenOf('> quoted $x$ math\n')
  assert.deepEqual(quote.children[0].children.map((c) => c.type),
    ['text', 'inlineMath', 'text'])
  const [list] = childrenOf('- item $x$ math\n')
  assert.deepEqual(list.children[0].children[0].children.map((c) => c.type),
    ['text', 'inlineMath', 'text'])
}

// CRLF：inlineMath 的 position 与 LF 版一致；块级 math 的 end 含 `$$` 行本体
{
  const [para] = childrenOf('an $x^2$ formula\r\n')
  assert.deepEqual([para.children[1].type,
    para.children[1].position.start.offset, para.children[1].position.end.offset],
  ['inlineMath', 3, 8])
  const [math] = childrenOf('$$\r\nE=mc^2\r\n$$\r\n')
  assert.equal(math.type, 'math')
  assert.equal(math.value, 'E=mc^2')
  assert.deepEqual([math.position.start.offset, math.position.end.offset], [0, 14])
}

// ---- 回归扫描：remark-math 不得改变以下任何一种既有形状 ----
{
  // 转义的 `\$x\$` 仍是纯 text（解码为 `$x$`）
  assert.deepEqual(childrenOf('a \\$x\\$ b\n').map(shape), [{
    type: 'paragraph',
    pos: [0, 9],
    children: [{ type: 'text', value: 'a $x$ b', pos: [0, 9] }]
  }])
  // 孤立 `$` 仍是纯 text
  assert.deepEqual(childrenOf('lone $ here\n')[0].children.map((c) => c.type), ['text'])
  // 代码围栏内的 `$x$` 仍是代码字节，绝不解析成数学
  const [code] = childrenOf('```js\nlet a = $x$\n```\n')
  assert.equal(code.type, 'code')
  assert.equal(code.value, 'let a = $x$')
  // 行内代码里的 `$x$` 仍是 inlineCode
  assert.deepEqual(childrenOf('`$x$` code\n')[0].children.map((c) => c.type),
    ['inlineCode', 'text'])
  // 反斜杠转义仍在数学内部生效（`$\$$` 不成对 → 纯 text）
  assert.deepEqual(childrenOf('a $\\$$ b\n')[0].children.map(shape),
    [{ type: 'text', value: 'a $$$ b', pos: [0, 8] }])
  // 表格/标题/强调等既有结构在含数学时仍正常嵌套（数学是 phrasing 子节点）
  assert.deepEqual(childrenOf('# head $x$ tail\n')[0].children.map((c) => c.type),
    ['text', 'inlineMath', 'text'])
  assert.deepEqual(childrenOf('**bold $x$ end**\n')[0].children[0].children.map((c) => c.type),
    ['text', 'inlineMath', 'text'])
}

// ---- 已知的"文本形状变了"的负面集合（钉住，不是缺陷）----
//
// remark-math 的默认 `singleDollarTextMath` 语法**只**要求成对的、非转义的
// `$`，不实现 Pandoc 的"开定界符后不得跟空白 / 闭定界符前不得有空白"规则。所以
// `$5 and $6`、`a $ b $ c`、行内的 `text $$x$$ text` 都会被识别成 inlineMath。
// 这些形状此前在内核链里是纯 text——但在**编辑器链里一直就是数学**（同一个
// remark-math、同一套默认选项、同一份字节），PM 侧一直渲染成 math_inline。
// 内核跟随编辑器才是正确的：不跟随 = 两棵树节点数不等 = 整图 null = 整篇降级。
// 故这里把"跟随"钉死，而不是把"货币不得成数学"钉死。
{
  assert.deepEqual(childrenOf('$5 and $6\n')[0].children.map(shape), [
    { type: 'inlineMath', value: '5 and ', pos: [0, 8] },
    { type: 'text', value: '6', pos: [8, 9] }
  ])
  assert.deepEqual(childrenOf('a $ b $ c\n')[0].children.map((c) => c.type),
    ['text', 'inlineMath', 'text'])
  // 行**中**的 `$$x$$`：编辑器与内核一致（normalizeDisplayMath 只重写整行形态，
  // 见下方独立小节），两侧都是行内数学 → 对齐。
  assert.deepEqual(childrenOf('inline $$x$$ here\n')[0].children.map((c) => c.type),
    ['text', 'inlineMath', 'text'])
  // 跨行的未闭合 `$` 会吞掉中间的 emphasis（同编辑器链）
  assert.deepEqual(childrenOf('$x\n_y_\n$\n')[0].children.map(shape),
    [{ type: 'inlineMath', value: 'x\n_y_\n', pos: [0, 8] }])
}

// ---- 已知残留限制：**独占一行**的 `$$…$$` 两侧仍不对齐（文档整篇降级）----
//
// 这不是"跟随编辑器"能解决的：两条链**看到的字节就不一样**。
//   - 编辑器链在 parse 之前先跑 `prepareEditorMarkdown`
//     （`editor-parse-adapter.js:6` → `editor-math.js` 的 `normalizeDisplayMath`），
//     把独占一行的 `$$E=mc^2$$` **改写**成多行块形态 `$$\nE=mc^2\n$$`，
//     于是 PM 得到 `code_block(language='LaTeX')`；
//   - 内核 `kernel.doc` 刻意持有**原始未 prepare 的字节**
//     （`editor-kernel-mode.js` 的 `createMarkdownDocument(source)`），
//     所以内核侧看到的仍是 `$$E=mc^2$$` 一行 → `paragraph > inlineMath`。
// 结果：块序 `code_block` vs `paragraph` 无法配对 → buildProjectionMap 返回 null
// → 该文档整篇降级到 legacy 路径（fail-closed，无字节风险，但**不是**已治好）。
//
// 下面钉住的是**内核侧的真相**（内核就该按它拿到的字节解析），同时把"这一形状
// 仍降级"这件事显式记录下来，免得阶段 3 的验收误以为数学域已经全治。
// 两条原则性修法（留给后续任务，二选一）：
//   (a) 让内核也持有 PREPARED 字节（则保存/导出的字节语义随之改变，需单独论证）；
//   (b) 内核模式下不跑 `normalizeDisplayMath`（则单行 `$$…$$` 在内核模式下按
//       remark-math 的原义渲染成行内数学，与 legacy 模式的观感不同）。
{
  assert.deepEqual(childrenOf('$$E=mc^2$$\n')[0].children.map((c) => c.type), ['inlineMath'])
  assert.equal(childrenOf('$$E=mc^2$$\n')[0].type, 'paragraph')
  // 对照：编辑器 prepare 之后的字节，内核解析出的才是 math 块——证明分歧的
  // 唯一来源是 prepare 改写，而不是两条 remark 链的选项差异。
  assert.equal(childrenOf('$$\nE=mc^2\n$$\n')[0].type, 'math')
}

console.log('PASS source-kernel syntax index')

// ---- Inline HTML resolves as PHRASING, not as a block ----
//
// Regression (Plan 5 Task 2 report §6.1): `BLOCKS` contains 'html', and
// `blockAt` is "largest start wins", so an INLINE html node — `<span>` inside
// an ordinary paragraph — used to win over its own paragraph. Every structural
// command resolves its block through `blockAt`, so Enter / Delete / Backspace /
// mark-toggle all refused (`unsupported-structure`) at any offset inside or
// adjacent to an inline HTML fragment, even though the enclosing paragraph is
// a perfectly ordinary editable block.
//
// The discriminator is `isInlineHtml` (inline-html.js), shared with the
// character map / projection map: an html node whose PARENT is a phrasing
// container is inline; block-level html (a root/blockquote/listItem child,
// which preset-commonmark's remark-html-transformer wraps into
// `paragraph > html` before ProseMirror sees it) is unchanged.
{
  // Raw offsets of 'a <span>x</span> b\n':
  //   'a '=[0,2)  '<span>'=[2,8)  'x'=8  '</span>'=[9,16)  ' b'=[16,18)
  const src = 'a <span>x</span> b\n'
  const idx = buildSyntaxIndex(src)
  for (let offset = 0; offset < 18; offset += 1) {
    const block = idx.blockAt(offset)
    assert.equal(block?.type, 'paragraph', `offset ${offset} must resolve to the paragraph`)
    assert.equal(block.start, 0)
    assert.equal(block.end, 18)
  }
  assert.equal(idx.blockAt(18), null, 'past the block end is still null (exclusive end)')

  // The fragment itself is recorded as ONE indivisible span — first node start
  // to last node end, the merged run's interior 'x' included, exactly the raw
  // span character-map.js emits its width-1 atom unit for.
  assert.deepEqual(idx.inlineHtmlSpans, [{ start: 2, end: 16 }])

  // Strict interior only: both edges are legal caret positions.
  assert.equal(idx.inlineHtmlSpanAt(2), null, 'the opening edge is outside')
  assert.equal(idx.inlineHtmlSpanAt(16), null, 'the closing edge is outside')
  assert.deepEqual(idx.inlineHtmlSpanAt(3), { start: 2, end: 16 })
  assert.deepEqual(idx.inlineHtmlSpanAt(8), { start: 2, end: 16 }, 'the fragment TEXT is interior too')
  assert.deepEqual(idx.inlineHtmlSpanAt(15), { start: 2, end: 16 })

  // Range form: a range bisects when EITHER endpoint is strictly interior; a
  // range that COVERS the whole fragment does not.
  assert.equal(idx.bisectsInlineHtml(8), true)
  assert.equal(idx.bisectsInlineHtml(2), false)
  assert.equal(idx.bisectsInlineHtml(2, 16), false, 'deleting the WHOLE fragment is well-defined')
  assert.equal(idx.bisectsInlineHtml(0, 18), false, 'deleting the whole paragraph is too')
  assert.equal(idx.bisectsInlineHtml(0, 9), true, 'a range ENDING inside the fragment bisects')
  assert.equal(idx.bisectsInlineHtml(9, 18), true, 'a range STARTING inside the fragment bisects')
}

// Block-level HTML keeps its old behavior: `blockAt` still answers 'html'.
{
  const idx = buildSyntaxIndex('<div>block</div>\n')
  assert.equal(idx.blockAt(0).type, 'html')
  assert.equal(idx.blockAt(7).type, 'html')
  assert.deepEqual(idx.inlineHtmlSpans, [], 'block-level html is not a fragment')

  // …including as a blockquote / listItem child (the other two
  // BLOCK_CONTAINER_TYPES of remark-html-transformer).
  const quoted = buildSyntaxIndex('> <div>x</div>\n')
  assert.equal(quoted.blockAt(2).type, 'html')
  const listed = buildSyntaxIndex('- <div>x</div>\n')
  assert.equal(listed.blockAt(2).type, 'html')
}

// Headings, list items, blockquotes and table cells: the fragment never wins
// over the enclosing block.
{
  // '# h <span>x</span> t\n' — fragment [4,18), heading [0,20)
  const heading = buildSyntaxIndex('# h <span>x</span> t\n')
  assert.equal(heading.blockAt(5).type, 'heading')
  assert.equal(heading.blockAt(12).type, 'heading')
  assert.deepEqual(heading.inlineHtmlSpans, [{ start: 4, end: 18 }])

  // '- a <span>x</span> b\n' — the item's own paragraph child [2,20)
  const item = buildSyntaxIndex('- a <span>x</span> b\n')
  assert.equal(item.blockAt(5).type, 'paragraph')
  assert.equal(item.blockAt(5).start, 2)
  assert.ok(item.listItemAt(5), 'still recognized as a list item')
  assert.deepEqual(item.inlineHtmlSpans, [{ start: 4, end: 18 }])

  // '> a <span>x</span> b\n' — the quote's paragraph child [2,20)
  const quoted = buildSyntaxIndex('> a <span>x</span> b\n')
  assert.equal(quoted.blockAt(5).type, 'paragraph')
  assert.equal(quoted.blockAt(5).start, 2)
  assert.deepEqual(quoted.inlineHtmlSpans, [{ start: 4, end: 18 }])

  // A table cell is phrasing too; `table` is the enclosing block (cells are
  // not blocks in this index).
  const table = buildSyntaxIndex('| a <span>x</span> b |\n| --- |\n| c |\n')
  assert.equal(table.blockAt(5).type, 'table')
  assert.deepEqual(table.inlineHtmlSpans, [{ start: 4, end: 18 }])
}

// Shapes the editor does NOT coalesce are still inline atoms, one span each —
// splitting inside a lone `<br/>` or an unbalanced `<span>x` is just as wrong
// as splitting a merged fragment.
{
  assert.deepEqual(buildSyntaxIndex('a <br/> b\n').inlineHtmlSpans, [{ start: 2, end: 7 }])
  assert.deepEqual(buildSyntaxIndex('a <span>x b\n').inlineHtmlSpans, [{ start: 2, end: 8 }])
  // A fragment containing emphasis is not merged either (the run stops at the
  // first non-html/text sibling) — two separate atoms, two separate spans, and
  // the gap between them (the `*x*`) stays freely editable.
  const emphasized = buildSyntaxIndex('a <span>*x*</span> b\n')
  assert.deepEqual(emphasized.inlineHtmlSpans, [{ start: 2, end: 8 }, { start: 11, end: 18 }])
  assert.equal(emphasized.bisectsInlineHtml(9), false, 'the emphasis between them is editable')
  // Nested tags merge into ONE atom.
  assert.deepEqual(buildSyntaxIndex('a <b><i>x</i></b> b\n').inlineHtmlSpans, [{ start: 2, end: 17 }])
  // Two adjacent fragments in one paragraph are two spans (shortest balanced
  // prefix wins), and the space between them is not interior to either.
  const pair = buildSyntaxIndex('a <b>x</b> <i>y</i> b\n')
  assert.deepEqual(pair.inlineHtmlSpans, [{ start: 2, end: 10 }, { start: 11, end: 19 }])
  assert.equal(pair.bisectsInlineHtml(10), false)
}

console.log('PASS source-kernel syntax index (inline html is phrasing)')

// ===========================================================================
// P6 Task 2 — YAML FRONT MATTER IS PARSED, NOT MISREAD
// ===========================================================================
// The kernel chain now mounts `remark-frontmatter` with the same default
// preset the editor chain uses (editor-crepe-setup.js passes
// `options: undefined`), because without it a leading `---` block parsed as
// `thematicBreak + setext heading` and every front-matter document degraded
// whole-document. remark-frontmatter contributes micromark/mdast-util
// EXTENSIONS only — no tree transform — so this file's "only parse, never
// runSync" rule is untouched and every node still carries a real position.
{
  const idx = buildSyntaxIndex('---\ntitle: x\n---\n\n正文\n')
  const top = idx.tree.children.map((c) => c.type)
  assert.deepEqual(top, ['yaml', 'paragraph'],
    'a leading --- block is ONE yaml node, not thematicBreak + setext heading')
  const yaml = idx.tree.children[0]
  assert.equal(yaml.position.start.offset, 0)
  assert.equal(yaml.position.end.offset, 16, 'the yaml node spans its own fences exactly')
  assert.equal(yaml.value, 'title: x')
  assert.equal(idx.tree.children[1].position.start.offset, 18)

  // `yaml` is deliberately NOT in this module's BLOCKS set: it is a read-only
  // leaf on the projection side, so every structural command resolving an
  // offset inside it must find no block and fail closed.
  for (const offset of [0, 3, 8, 15]) {
    assert.equal(idx.blockAt(offset), null, `offset ${offset} inside the front matter has no block`)
  }
  assert.equal(idx.blockAt(18)?.type, 'paragraph', 'the body block still resolves (positive control)')
}

// CRLF front matter: same single node, offsets simply follow the extra bytes.
{
  const idx = buildSyntaxIndex('---\r\ntitle: x\r\n---\r\n\r\n正文\r\n')
  assert.deepEqual(idx.tree.children.map((c) => c.type), ['yaml', 'paragraph'])
  assert.equal(idx.tree.children[0].position.end.offset, 18)
  assert.equal(idx.tree.children[1].position.start.offset, 22)
  assert.equal(idx.dominantEnding, '\r\n')
}

// Negative control: the default preset matches only at the very start of the
// document, so an ordinary `---` divider is still a thematicBreak and a `---`
// UNDER a paragraph is still a setext heading. Widening the preset (e.g. to
// allow `+++`, or anchoring anywhere) would break this and would also silently
// diverge from the editor chain.
{
  assert.deepEqual(buildSyntaxIndex('甲\n\n---\n\n乙\n').tree.children.map((c) => c.type),
    ['paragraph', 'thematicBreak', 'paragraph'])
  assert.deepEqual(buildSyntaxIndex('text\n---\ntitle: x\n---\n').tree.children.map((c) => c.type),
    ['heading', 'heading'])
  assert.deepEqual(buildSyntaxIndex('+++\ntitle = "x"\n+++\n\n甲\n').tree.children.map((c) => c.type),
    ['paragraph', 'paragraph'], 'TOML front matter is NOT enabled — the editor does not enable it either')
}

console.log('PASS source-kernel syntax index (front matter)')
