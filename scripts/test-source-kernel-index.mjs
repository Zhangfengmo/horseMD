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
// `$5 and $6`、`a $ b $ c`、`$$x$$`（同一行）都会被识别成 inlineMath。
// 这些形状此前在内核链里是纯 text——但在**编辑器链里一直就是数学**（同一个
// remark-math、同一套默认选项），PM 侧一直渲染成 math_inline。内核跟随编辑器
// 才是正确的：不跟随 = 两棵树节点数不等 = 整图 null = 整篇降级。故这里把
// "跟随"钉死，而不是把"货币不得成数学"钉死。
{
  assert.deepEqual(childrenOf('$5 and $6\n')[0].children.map(shape), [
    { type: 'inlineMath', value: '5 and ', pos: [0, 8] },
    { type: 'text', value: '6', pos: [8, 9] }
  ])
  assert.deepEqual(childrenOf('a $ b $ c\n')[0].children.map((c) => c.type),
    ['text', 'inlineMath', 'text'])
  // 同一行上的 `$$x$$` 是行内数学（不是块级）
  assert.deepEqual(childrenOf('inline $$x$$ here\n')[0].children.map((c) => c.type),
    ['text', 'inlineMath', 'text'])
  assert.deepEqual(childrenOf('$$E=mc^2$$\n')[0].children.map((c) => c.type), ['inlineMath'])
  // 跨行的未闭合 `$` 会吞掉中间的 emphasis（同编辑器链）
  assert.deepEqual(childrenOf('$x\n_y_\n$\n')[0].children.map(shape),
    [{ type: 'inlineMath', value: 'x\n_y_\n', pos: [0, 8] }])
}

console.log('PASS source-kernel syntax index')
