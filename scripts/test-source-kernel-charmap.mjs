import assert from 'node:assert/strict'
import { buildSyntaxIndex } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { buildCharacterMap } from '../src/renderer/src/lib/source-kernel/character-map.js'

const mapOf = (src, findText = null) => {
  const idx = buildSyntaxIndex(src)
  const offset = findText ? src.indexOf(findText) : 0
  const block = idx.blockAt(offset)
  return { map: buildCharacterMap(src, block.node), idx, block }
}

// 普通文本：一一对应
{
  const { map } = mapOf('abc\n')
  assert.equal(map.visibleLength, 3)
  assert.equal(map.visibleToRaw(0), 0)
  assert.equal(map.visibleToRaw(3), 3)
  assert.deepEqual(map.rawRangeForVisibleRange(1, 2), { from: 1, to: 2 })
}

// 反斜杠转义：可见 1 字符 ↔ raw 2 字符；光标不得落进 raw 内部
{
  const src = 'a\\*b\n'          // 可见 a*b
  const { map } = mapOf(src)
  assert.equal(map.visibleLength, 3)
  assert.equal(map.visibleToRaw(1), 1)   // '*' 左边界
  assert.equal(map.visibleToRaw(2), 3)   // '*' 右边界（跳过整个 \*）
  assert.deepEqual(map.rawRangeForVisibleRange(1, 2), { from: 1, to: 3 })
}

// 实体：&amp; 可见 1 字符 ↔ raw 5 字符
{
  const src = 'x&amp;y\n'        // 可见 x&y
  const { map } = mapOf(src)
  assert.equal(map.visibleLength, 3)
  assert.deepEqual(map.rawRangeForVisibleRange(1, 2), { from: 1, to: 6 })
}

// 数字/十六进制实体 + surrogate pair
{
  const src = 'a&#x1F600;b\n'    // 😀 是 2 个 code unit
  const { map } = mapOf(src)
  assert.equal(map.visibleLength, 4)
  assert.equal(map.visibleToRaw(1), 1)
  assert.equal(map.visibleToRaw(3), 10)  // 实体右边界
  assert.equal(map.visibleToRaw(2), null) // surrogate pair 内部：拒绝
}
{
  const src = 'a😀b\n'           // 字面 surrogate pair：一个单元 width 2
  const { map } = mapOf(src)
  assert.equal(map.visibleToRaw(1), 1)
  assert.equal(map.visibleToRaw(3), 3)
  assert.equal(map.visibleToRaw(2), null)
}

// 引用内段落的软换行：可见 '\n' 1 字符 ↔ raw '换行+引用前缀'
{
  const src = '> 甲\n> 乙\n'
  const { map } = mapOf(src, '甲')
  assert.equal(map.visibleLength, 3)     // 甲 \n 乙
  assert.deepEqual(map.rawRangeForVisibleRange(1, 2), { from: 3, to: 6 }) // '\n> '
  assert.equal(map.visibleToRaw(2), 6)
}

// 行内 atom（image 等）：整体一个不可拆单元
{
  const src = '前 ![a](x.png) 后\n'
  const { map } = mapOf(src)
  const atom = map.units.find((u) => u.kind === 'atom')
  assert.ok(atom)
  assert.equal(src.slice(atom.rawStart, atom.rawEnd), '![a](x.png)')
}

// inlineCode 逐字符单元（P4-3.5 attach 退化修复）：多字符 code span 不再是
// width-1 atom —— PM 侧是 N 字符的 marked text run，旧 atom 单元使
// content.size === visibleLength 恒等式对 N>1 失败，整篇文档在 attach 时
// 退化。现在 value 每字符一个 kind:'char' 单元（raw:visible 1:1），反引号
// run 是 marker 缺口（与 ** 同机制）。
{
  const src = '前 `code` 后\n'
  const { map } = mapOf(src)
  assert.equal(map.visibleLength, 8) // 前 sp c o d e sp 后
  const codeUnits = map.units.slice(2, 6)
  assert.deepEqual(codeUnits.map((u) => src.slice(u.rawStart, u.rawEnd)), ['c', 'o', 'd', 'e'])
  assert.ok(codeUnits.every((u) => u.kind === 'char' && u.width === 1))
  // 选中渲染出的 code 内容 → 精确落在 value 字节上（缺口感知起点跳过开
  // 反引号；终点停在闭反引号前）。
  assert.deepEqual(map.rawRangeForVisibleRange(2, 6), { from: 3, to: 7 })
  assert.equal(src.slice(3, 7), 'code')
}

// 双反引号 run + 内容含单反引号：``a`b`` → value 'a`b'，raw 1:1
{
  const src = 'x ``a`b`` y\n'
  const { map } = mapOf(src)
  assert.equal(map.visibleLength, 7) // x sp a ` b sp y
  assert.deepEqual(map.rawRangeForVisibleRange(2, 5), { from: 4, to: 7 })
  assert.equal(src.slice(4, 7), 'a`b')
}

// CommonMark 空格剥离：` x ` → value 'x'（两端各剥一个空格）。剥离的空格是
// 可证明的（slice === ' '+value+' '），按 marker 缺口处理，value 字节仍逐
// 字符映射 —— 展示字面反引号的 `` ` `` 是日常实例，不能让它整篇退化。
{
  const src = 'a ` x ` b\n'
  const { map } = mapOf(src)
  assert.ok(map, 'padded code span must still map')
  assert.equal(map.visibleLength, 5) // a sp x sp b
  assert.deepEqual(map.rawRangeForVisibleRange(2, 3), { from: 4, to: 5 })
  assert.equal(src.slice(4, 5), 'x')
}
{
  const src = 'a `` ` `` b\n' // 字面反引号
  const { map } = mapOf(src)
  assert.ok(map)
  assert.deepEqual(map.rawRangeForVisibleRange(2, 3), { from: 5, to: 6 })
  assert.equal(src.slice(5, 6), '`')
}

// raw↔value 其他分歧（边缘换行也参与剥离：`\nx ` → value 'x'，slice 既不
// 等于 value 也不等于 ' '+value+' '）→ 整块 fail-closed（null）
{
  const src = 'a `\nx ` b\n'
  const idx = buildSyntaxIndex(src)
  const block = idx.blockAt(0)
  assert.equal(buildCharacterMap(src, block.node), null)
}

// 缺口感知的选区起点（Plan 4 Task 2 复审修复）：strong/emphasis/delete 递归
// 进子节点时不为 marker 本身生成 unit，进入/离开该内容时前后各有一段"无主"
// 原始字节（marker 自身）。旧实现的 rawRangeForVisibleRange 的 from 端复用
// "consumed-so-far" 边界表，会把选区起点回退到 marker 之前（把 marker 一起
// 吞进选区）；已验证为真实字节损坏：对 'a **bold** b\n' 精确选中可见词
// "bold"（visFrom 2, visTo 6），旧值解析为 raw [2,8) = "**bold"（含开
// marker、不含闭 marker），对着这个范围输入会吞掉开 marker、留下孤立的闭
// marker。现在 from 端改经 `rawStartForVisible`（跳过 marker 缺口），必须
// 精确落在内容本身（marker 之后）。
{
  const src = 'a **bold** b\n'
  const idx = buildSyntaxIndex(src)
  const block = idx.blockAt(src.indexOf('bold'))
  const map = buildCharacterMap(src, block.node)
  // 可见 "a bold b"：a=0 sp=1 b=2 o=3 l=4 d=5 sp=6 b=7，"bold" 是 visible[2,6)
  assert.equal(map.rawStartForVisible(2), 4, 'skips the opening ** entirely')
  assert.deepEqual(map.rawRangeForVisibleRange(2, 6), { from: 4, to: 8 })
  assert.equal(src.slice(4, 8), 'bold', 'range must start AT the content, after **')
  // visibleToRaw(2) 本身保持不变（单点查询语义不受影响，仍是 2 —— 用于非
  // 选区场景，例如插入符定位）；只有 rawRangeForVisibleRange/
  // rawStartForVisible 的 from 端改用缺口感知解析。
  assert.equal(map.visibleToRaw(2), 2)
}

// rawNeutralInsert（P4-3.5 Fix B）：PLAIN 插入落点在 marker 之外。
// 'a **bold** b'：a=0 sp=1 **=2,3 b=4 o=5 l=6 d=7 **=8,9 sp=10 b=11
{
  const src = 'a **bold** b\n'
  const idx = buildSyntaxIndex(src)
  const map = buildCharacterMap(src, idx.blockAt(0).node)
  // run 前边界（vis2）：落在开 marker 之前（与 visibleToRaw 相同）
  assert.equal(map.rawNeutralInsert(2), 2)
  // run 尾边界（vis6）：boundaries 给 8（闭 marker 之内）；neutral 跳到
  // strong 节点 end = 10（marker 之外）—— plain 字符不得吞进 bold
  assert.equal(map.visibleToRaw(6), 8)
  assert.equal(map.rawNeutralInsert(6), 10)
  // 无缺口边界：与 visibleToRaw 完全一致（既有行为零变化）
  assert.equal(map.rawNeutralInsert(7), map.visibleToRaw(7))
  assert.equal(map.rawNeutralInsert(0), 0)
}

// 块首以 mark 开头：vis0 的 neutral 落在开 marker 之前（块起点）
{
  const src = '**a** b\n'
  const idx = buildSyntaxIndex(src)
  const map = buildCharacterMap(src, idx.blockAt(0).node)
  assert.equal(map.visibleToRaw(0), 2, 'boundaries[0] 是首 unit 的 rawStart（marker 之后）')
  assert.equal(map.rawNeutralInsert(0), 0, 'neutral 反向跳过开 marker')
}

// 标题前缀不是 mark 缺口：vis0 保持在 '# ' 之后（不得把字符插到 # 前面）
{
  const src = '# abc\n'
  const idx = buildSyntaxIndex(src)
  const map = buildCharacterMap(src, idx.blockAt(0).node)
  assert.equal(map.rawNeutralInsert(0), 2)
}

// 相邻两个 mark 之间：落在闭/开 marker 之间
{
  const src = '**a**_b_\n' // *0 *1 a2 *3 *4 _5 b6 _7
  const idx = buildSyntaxIndex(src)
  const map = buildCharacterMap(src, idx.blockAt(0).node)
  assert.equal(map.rawNeutralInsert(1), 5) // strong end（'_' 之前）
}

// 嵌套 mark 的公共尾边界：链式跳到最外层节点 end
{
  const src = '**a _b_** c\n' // strong[0,9) > em[4,7)；'b' 是两层的共同末位
  const idx = buildSyntaxIndex(src)
  const map = buildCharacterMap(src, idx.blockAt(0).node)
  assert.equal(map.rawNeutralInsert(3), 9) // 'a b' 的 vis3（b 之后）→ 跳过 '_' 和 '**'
}

// inlineCode（含 padding）：尾边界 neutral 跳过 padding + 闭反引号
{
  const src = 'a ` x ` b\n' // a0 sp1 `2 sp3 x4 sp5? 实际 content [3,6)=' x '
  const idx = buildSyntaxIndex(src)
  const map = buildCharacterMap(src, idx.blockAt(0).node)
  // 可见 'a x b'：x 是 vis2，x 之后的边界是 vis3
  assert.equal(map.rawNeutralInsert(3), 7) // inlineCode 节点 end（闭反引号之后）
  assert.equal(map.rawNeutralInsert(2), 2) // x 之前：开反引号之前
}

// rawRangeForVisibleRange 零宽选区（final-review 修复）：块尾（visFrom ===
// visTo === visibleLength）之前 rawStartForVisible 在此处无条目（没有任何
// unit 从 visibleLength 处"开始"）→ 直接拒绝，导致内核模式下段落末尾按 Tab
// 报 unmapped。现在零宽两端都改经 rawNeutralInsert（与 commitPlainText 的
// 零宽路径同一个解析器），块尾退化为普通 visibleToRaw 值。
{
  const src = 'hello\n'
  const idx = buildSyntaxIndex(src)
  const map = buildCharacterMap(src, idx.blockAt(0).node)
  assert.deepEqual(map.rawRangeForVisibleRange(5, 5), { from: 5, to: 5 })
}
// 同一处 mark-gap 边界的零宽：'a **bold** b\n' 的 vis6（"bold" 之后、闭
// marker 内部的 boundaries 值是 8）——零宽插入必须落在 marker 之外（10），
// 与 rawNeutralInsert(6) 已验证的值一致，而不是 from>to 被拒绝。
{
  const src = 'a **bold** b\n'
  const idx = buildSyntaxIndex(src)
  const map = buildCharacterMap(src, idx.blockAt(0).node)
  assert.deepEqual(map.rawRangeForVisibleRange(6, 6), { from: 10, to: 10 })
  assert.equal(map.rawRangeForVisibleRange(6, 6).from, map.rawNeutralInsert(6))
}

// raw 与 value 无法对齐 → 整块 null（fail-closed）
{
  const idx = buildSyntaxIndex('plain\n')
  const fake = { ...idx.blockAt(0).node }
  fake.children = [{ type: 'text', value: 'DIFFERENT',
    position: fake.children[0].position }]
  assert.equal(buildCharacterMap('plain\n', fake), null)
}

// ---- 行内数学（计划五 Task 1）：inlineMath 是宽度 1 的 atom unit ----
//
// PM 侧 `math_inline` 是 atom（node_modules/@milkdown/crepe/lib/esm/feature/
// latex/index.js:98-104），content.size 记 1。内核侧必须同样记 1，否则
// `content.size === visibleLength` 不成立 → projection map 整图 null → 含行内
// 数学的文档整篇降级。raw 跨度必须覆盖两侧 `$`（光标不得落进 `$...$` 内部）。
{
  const src = 'an $x^2$ formula\n'
  const { map } = mapOf(src)
  assert.deepEqual(map.units.map((u) => [u.kind, u.rawStart, u.rawEnd, u.width]), [
    ['char', 0, 1, 1], ['char', 1, 2, 1], ['char', 2, 3, 1],
    ['atom', 3, 8, 1],
    ['char', 8, 9, 1], ['char', 9, 10, 1], ['char', 10, 11, 1], ['char', 11, 12, 1],
    ['char', 12, 13, 1], ['char', 13, 14, 1], ['char', 14, 15, 1], ['char', 15, 16, 1]
  ])
  assert.equal(map.visibleLength, 12)      // 'an ' + 1 + ' formula'
  assert.equal(map.visibleToRaw(3), 3)     // atom 左边界（`$` 之前）
  assert.equal(map.visibleToRaw(4), 8)     // atom 右边界（闭 `$` 之后）
  // 4..7 是 `$x^2$` 的内部字节：没有任何可见下标映射到它们
  assert.deepEqual([4, 5, 6, 7].filter((raw) =>
    [...Array(map.visibleLength + 1).keys()].some((v) => map.visibleToRaw(v) === raw)), [])
  // 选中整个公式 → raw 恰好是 `$x^2$`
  assert.deepEqual(map.rawRangeForVisibleRange(3, 4), { from: 3, to: 8 })
  assert.equal(src.slice(3, 8), '$x^2$')
}

// atom 位于块首/块尾、以及连续两个公式：边界不塌陷
{
  const { map } = mapOf('$x_1$ and $x^2$\n')
  assert.deepEqual(map.units.map((u) => u.kind),
    ['atom', 'char', 'char', 'char', 'char', 'char', 'atom'])
  assert.equal(map.visibleLength, 7)
  assert.equal(map.visibleToRaw(0), 0)
  assert.equal(map.visibleToRaw(1), 5)
  assert.equal(map.visibleToRaw(7), 15)
  // 块首 atom 之前的零宽插入落在 `$` 之前（atom 不是 mark，没有 gap 可跳）
  assert.equal(map.rawNeutralInsert(0), 0)
  assert.equal(map.rawNeutralInsert(7), 15)
}

// 数学嵌在 strong 里：容器递归 + atom 共存，gap（`**`）语义不变
{
  const src = '**bold $x$ end**\n'
  const { map } = mapOf(src)
  assert.equal(map.visibleLength, 10)      // 'bold ' + 1 + ' end'
  assert.equal(map.visibleToRaw(5), 7)     // atom 左边界
  assert.equal(map.visibleToRaw(6), 10)    // atom 右边界
  assert.equal(map.rawNeutralInsert(10), 16) // 块尾插入落在闭 `**` 之外
}

// CRLF：atom 与 linebreak unit 共存
{
  const { map } = mapOf('a $x$ b\r\nsecond\r\n')
  assert.equal(map.visibleLength, 13)      // 'a ' + 1 + ' b\r\nsecond'
  assert.equal(map.visibleToRaw(2), 2)
  assert.equal(map.visibleToRaw(3), 5)     // 跳过整个 `$x$`
  assert.deepEqual(map.units.filter((u) => u.kind === 'linebreak')
    .map((u) => [u.rawStart, u.rawEnd]), [[8, 9]]) // '\r' 是普通 char，'\n' 才跨行
}

// 货币形状（`$5 and $6`）：内核跟随编辑器链，同样是 atom + 文本（见
// test-source-kernel-index.mjs 的负面集合说明）——两侧一致才不会整图 null
{
  const { map } = mapOf('$5 and $6\n')
  assert.deepEqual(map.units.map((u) => [u.kind, u.rawStart, u.rawEnd]),
    [['atom', 0, 8], ['char', 8, 9]])
  assert.equal(map.visibleLength, 2)
}

// 转义的 `\$x\$`：仍是 escape unit，不是 atom（形状未变）
{
  const { map } = mapOf('a \\$x\\$ b\n')
  assert.deepEqual(map.units.map((u) => u.kind),
    ['char', 'char', 'escape', 'char', 'escape', 'char', 'char'])
  assert.equal(map.visibleLength, 7)
}

console.log('PASS source-kernel character map')

// ---- 行内 HTML 合并（计划五 Task 2）----
//
// 编辑器链的 `remarkMergeInlineHtml`（editor-html.js）把
// html("<span>")/text("x")/html("</span>") 合成 **一个** 无 position 的 html
// 节点；PM 侧因此只有一个 inline `html` 原子（preset-commonmark node/html.ts：
// `atom:true, group:'inline'`），content.size 记 1。内核链不引入该插件（合成
// 节点没有 position，违反 unit 契约），改在这里用同一条规则
// （lib/source-kernel/inline-html.js `inlineHtmlRunAt`，两条链共用同一份实现）
// 识别同样的连续段，产出 **一个** 宽度 1 的 atom unit，raw = 首节点 start →
// 末节点 end（全部有 position，可证明）。
//
// 下面每条的 units/visibleLength 都由真实解析器跑出来（见任务报告的探查记录），
// 且与「编辑器链跑完 brToBreak+merge 后的 PM 尺寸」逐条对账（本文件末尾的
// 跨链一致性用例）。
//
// 注意：本节一律取 `idx.tree.children[i]` 而不是 `idx.blockAt()` —— syntax-index
// 的 BLOCKS 集合含 'html'，而行内 html 节点也是 html，blockAt 的「start 最大者
// 胜」会把行内 html 当成块返回。charMap 的入口是块节点，必须是 paragraph。
const topBlock = (src, i = 0) => buildSyntaxIndex(src).tree.children[i]
const unitsOf = (src, i = 0) => {
  const map = buildCharacterMap(src, topBlock(src, i))
  return { map, shape: map.units.map((u) => [u.kind, u.rawStart, u.rawEnd]) }
}

// 基础形状 `<span>x</span>`：三个 mdast 节点 → 一个 atom，raw 覆盖完整片段
{
  const src = 'a <span>x</span> b\n'
  const { map, shape } = unitsOf(src)
  assert.deepEqual(shape, [
    ['char', 0, 1], ['char', 1, 2], ['atom', 2, 16], ['char', 16, 17], ['char', 17, 18]
  ])
  assert.equal(map.visibleLength, 5)
  assert.equal(src.slice(2, 16), '<span>x</span>')
  assert.equal(map.visibleToRaw(2), 2)   // atom 左边界
  assert.equal(map.visibleToRaw(3), 16)  // atom 右边界（跳过整个片段）
}

// 嵌套 `<b><i>x</i></b>`：四个 html + 一个 text → 仍是一个 atom
{
  const src = 'a <b><i>x</i></b> b\n'
  const { map, shape } = unitsOf(src)
  assert.deepEqual(shape, [
    ['char', 0, 1], ['char', 1, 2], ['atom', 2, 17], ['char', 17, 18], ['char', 18, 19]
  ])
  assert.equal(src.slice(2, 17), '<b><i>x</i></b>')
  assert.equal(map.visibleLength, 5)
}

// 自闭合 `<br/>`：单节点本来就平衡，编辑器链 **不合并**（`j > i + 1` 不成立），
// 而且 `brToBreakRemarkPlugin` 早已把它换成 mdast `break`。内核侧照旧是它自己
// 的一个 atom（宽度 1，与 PM 的 hard break 原子相等）。
{
  const src = 'a<br/>b\n'
  const { map, shape } = unitsOf(src)
  assert.deepEqual(shape, [['char', 0, 1], ['atom', 1, 6], ['char', 6, 7]])
  assert.equal(map.visibleLength, 3)
}

// `<br/>` 落在片段内部：编辑器链在 merge 之前就把它变成了 break 节点，合并因此
// 在 break 处断开 → PM 是 7 个行内节点。内核必须用同一判据断开（否则会跨过
// void 标签直接平衡成一个 atom，5 vs 9 的尺寸差会把整图打成 null）。
{
  const src = 'a <span>x<br/>y</span> b\n'
  const { map, shape } = unitsOf(src)
  assert.deepEqual(shape, [
    ['char', 0, 1], ['char', 1, 2], ['atom', 2, 8], ['char', 8, 9], ['atom', 9, 14],
    ['char', 14, 15], ['atom', 15, 22], ['char', 22, 23], ['char', 23, 24]
  ])
  assert.equal(map.visibleLength, 9)
}

// 不平衡 `<span>x b`：两条链都不合并 → 开标签自己一个 atom，其余是普通字符
{
  const src = 'a <span>x b\n'
  const { map, shape } = unitsOf(src)
  assert.deepEqual(shape, [
    ['char', 0, 1], ['char', 1, 2], ['atom', 2, 8],
    ['char', 8, 9], ['char', 9, 10], ['char', 10, 11]
  ])
  assert.equal(map.visibleLength, 6)
}

// 片段内含 emphasis：编辑器链的 coalesceChildren 在非 html/text 兄弟处放弃合并
// → PM 侧是 开标签原子 + emphasis 文本 + 闭标签原子。内核同形（`*` 是 mark gap）。
{
  const src = 'a <span>*x*</span> b\n'
  const { map, shape } = unitsOf(src)
  assert.deepEqual(shape, [
    ['char', 0, 1], ['char', 1, 2], ['atom', 2, 8], ['char', 9, 10], ['atom', 11, 18],
    ['char', 18, 19], ['char', 19, 20]
  ])
  assert.equal(map.visibleLength, 7)
}

// 片段内含行内数学：两条链都有 remark-math（计划五 Task 1），inlineMath 同样是
// 非 html/text 兄弟 → 两侧都不合并
{
  const src = 'a <span>$x$</span> b\n'
  const { shape } = unitsOf(src)
  assert.deepEqual(shape, [
    ['char', 0, 1], ['char', 1, 2], ['atom', 2, 8], ['atom', 8, 11], ['atom', 11, 18],
    ['char', 18, 19], ['char', 19, 20]
  ])
}

// 相邻片段：合并是「最短平衡前缀」，所以是两个 atom，不是一个
{
  const src = 'a <span>x</span><span>y</span> b\n'
  const { map, shape } = unitsOf(src)
  assert.deepEqual(shape, [
    ['char', 0, 1], ['char', 1, 2], ['atom', 2, 16], ['atom', 16, 30],
    ['char', 30, 31], ['char', 31, 32]
  ])
  assert.equal(map.visibleLength, 6)
}

// 带属性的开标签
{
  const src = 'a <span class="k">x</span> b\n'
  const { shape } = unitsOf(src)
  assert.deepEqual(shape, [
    ['char', 0, 1], ['char', 1, 2], ['atom', 2, 26], ['char', 26, 27], ['char', 27, 28]
  ])
  assert.equal(src.slice(2, 26), '<span class="k">x</span>')
}

// 片段内含反斜杠转义：合并节点的 value 是 **解码后** 的（`a*b`），但 raw 跨度
// 仍是原始字节（含 `\`）——这正是内核不能复用编辑器合并节点的原因。
{
  const src = 'a <span>a\\*b</span> c\n'
  const { map, shape } = unitsOf(src)
  assert.deepEqual(shape, [
    ['char', 0, 1], ['char', 1, 2], ['atom', 2, 19], ['char', 19, 20], ['char', 20, 21]
  ])
  assert.equal(src.slice(2, 19), '<span>a\\*b</span>')
  assert.equal(map.visibleLength, 5)
}

// HTML 注释：不是开标签（isOpeningInlineTag 排除 `<!--`）→ 不合并
{
  const src = 'a <!-- c --> b\n'
  const { shape } = unitsOf(src)
  assert.deepEqual(shape, [
    ['char', 0, 1], ['char', 1, 2], ['atom', 2, 12], ['char', 12, 13], ['char', 13, 14]
  ])
}

// 整段就是一个片段：paragraph 的唯一 unit 是这个 atom
{
  const src = '<span>x</span>\n'
  const { map, shape } = unitsOf(src)
  assert.deepEqual(shape, [['atom', 0, 14]])
  assert.equal(map.visibleLength, 1)
}

// CRLF：合并段之后仍能正常继续（linebreak unit 只吞 '\n'，'\r' 是普通 char）
{
  const src = 'a <span>x</span> b\r\nnext\r\n'
  const { map, shape } = unitsOf(src)
  assert.deepEqual(shape, [
    ['char', 0, 1], ['char', 1, 2], ['atom', 2, 16], ['char', 16, 17], ['char', 17, 18],
    ['char', 18, 19], ['linebreak', 19, 20],
    ['char', 20, 21], ['char', 21, 22], ['char', 22, 23], ['char', 23, 24]
  ])
  assert.equal(map.visibleLength, 11)
}

// 标题里的片段（heading 也是 phrasing 容器）
{
  const src = '# h <span>x</span>\n'
  const { map, shape } = unitsOf(src)
  assert.deepEqual(shape, [['char', 2, 3], ['char', 3, 4], ['atom', 4, 18]])
  assert.equal(map.visibleLength, 3)
}

console.log('PASS source-kernel character map (inline html)')
