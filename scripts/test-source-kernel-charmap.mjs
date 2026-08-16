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

// raw 与 value 无法对齐 → 整块 null（fail-closed）
{
  const idx = buildSyntaxIndex('plain\n')
  const fake = { ...idx.blockAt(0).node }
  fake.children = [{ type: 'text', value: 'DIFFERENT',
    position: fake.children[0].position }]
  assert.equal(buildCharacterMap('plain\n', fake), null)
}

console.log('PASS source-kernel character map')
