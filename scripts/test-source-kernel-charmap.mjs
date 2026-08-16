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

// 行内 atom（inlineCode/image）：整体一个不可拆单元
{
  const src = '前 `code` 后\n'
  const { map } = mapOf(src)
  const atom = map.units.find((u) => u.kind === 'atom')
  assert.ok(atom)
  assert.equal(src.slice(atom.rawStart, atom.rawEnd), '`code`')
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

// raw 与 value 无法对齐 → 整块 null（fail-closed）
{
  const idx = buildSyntaxIndex('plain\n')
  const fake = { ...idx.blockAt(0).node }
  fake.children = [{ type: 'text', value: 'DIFFERENT',
    position: fake.children[0].position }]
  assert.equal(buildCharacterMap('plain\n', fake), null)
}

console.log('PASS source-kernel character map')
