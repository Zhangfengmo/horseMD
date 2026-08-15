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

console.log('PASS source-kernel syntax index')
