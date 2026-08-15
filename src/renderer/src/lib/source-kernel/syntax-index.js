// LosslessSyntaxIndex: 物理行 + 块索引 + 列表项记录，全部锚定原始字符偏移。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
//
// 只 parse、不 runSync：remark 的 transform 插件（frontmatter/gfm 的表格标准化等）
// 会改写 mdast 节点，使 position 与原始字符串错位；先例见
// lib/markdown-preservation/table-source-parse.js buildGfmTableSourceModel。
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { QUOTE_PREFIX } from '../markdown-preservation/block-prefix.js'

const processor = unified().use(remarkParse).use(remarkGfm)

export function scanLines(text) {
  const lines = []
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\n') {
      lines.push({ start, end: i, ending: '\n', text: text.slice(start, i) })
      start = i + 1
    } else if (ch === '\r') {
      const crlf = text[i + 1] === '\n'
      lines.push({ start, end: i, ending: crlf ? '\r\n' : '\r', text: text.slice(start, i) })
      if (crlf) i += 1
      start = i + 1
    }
  }
  lines.push({ start, end: text.length, ending: '', text: text.slice(start) })
  return lines
}

const BLOCKS = new Set([
  'paragraph', 'heading', 'blockquote', 'list', 'listItem',
  'code', 'table', 'thematicBreak', 'html', 'math'
])
const CONTAINERS = new Set(['list', 'blockquote', 'table', 'code'])

const MARKER_RE = /^([ \t]*)([*+-]|\d{1,9}[.)])([ \t]+|$)/
const TASK_RE = /^\[( |x|X)\]([ \t]*)/

export function buildSyntaxIndex(text) {
  const lines = scanLines(text)
  const dominantEnding = lines.find((l) => l.ending)?.ending || '\n'
  const tree = processor.parse(text)

  const offsetOf = (point) => point?.offset

  const lineIndexAt = (offset) => {
    let lo = 0
    let hi = lines.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lines[mid].start <= offset) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  const buildItem = (node, ancestors, start, end) => {
    const list = ancestors[ancestors.length - 1] // 直接父 list
    const depth = ancestors.filter((a) => a.type === 'listItem').length
    const line = lines[lineIndexAt(start)]
    // QUOTE_PREFIX's leading `[ \t]*` is unconditional (CommonMark allows up to
    // 3 spaces before a blockquote marker), so on a line with NO '>' at all it
    // still matches — and would wrongly swallow a nested list item's own
    // indentation as "quote prefix". Only treat the match as a real quote
    // prefix when it actually contains a '>'.
    const rawPrefix = (line.text.match(QUOTE_PREFIX) || [''])[0]
    const quotePrefix = rawPrefix.includes('>') ? rawPrefix : ''
    const rest = line.text.slice(quotePrefix.length)
    const m = rest.match(MARKER_RE)
    if (!m) return null
    const indent = m[1]
    const marker = m[2]
    const spacing = m[3]
    const markerEnd = line.start + quotePrefix.length + indent.length + marker.length + spacing.length
    let task = null
    let taskSpacing = ''
    let contentStart = markerEnd
    if (node.checked === true || node.checked === false) {
      const t = text.slice(markerEnd).match(TASK_RE)
      if (t) {
        task = { from: markerEnd, to: markerEnd + 3, checked: t[1].toLowerCase() === 'x' }
        taskSpacing = t[2]
        contentStart = task.to + taskSpacing.length
      }
    }
    const markerLineTail = text.slice(contentStart, line.start + line.text.length)
    const singleLine = lineIndexAt(Math.max(start, end - 1)) === lineIndexAt(start)
    return {
      start,
      end,
      markerLineIndex: lineIndexAt(start),
      quotePrefix,
      indent,
      marker,
      ordered: /^\d/.test(marker)
        ? { number: parseInt(marker, 10), delimiter: marker[marker.length - 1] }
        : null,
      spacing,
      task,
      taskSpacing,
      contentStart,
      listStart: offsetOf(list?.position?.start),
      listEnd: offsetOf(list?.position?.end),
      depth,
      empty: singleLine && markerLineTail.trim() === ''
    }
  }

  const blocks = [] // { type, start, end, node, ancestors }
  const items = [] // 列表项记录（可能含 null，构建失败的项）
  const walk = (node, ancestors) => {
    const start = offsetOf(node.position?.start)
    const end = offsetOf(node.position?.end)
    if (BLOCKS.has(node.type) && Number.isInteger(start) && Number.isInteger(end)) {
      blocks.push({ type: node.type, start, end, node, ancestors: [...ancestors] })
      if (node.type === 'listItem') items.push(buildItem(node, ancestors, start, end))
    }
    const nextAncestors = [...ancestors, node]
    for (const child of node.children || []) walk(child, nextAncestors)
  }

  walk(tree, [])
  const validItems = items.filter(Boolean)

  const within = (b, offset) => offset >= b.start && offset < b.end

  const blockAt = (offset) => {
    let best = null
    for (const b of blocks) {
      if (b.type === 'list' || b.type === 'blockquote') continue
      if (within(b, offset) && (!best || b.start >= best.start)) best = b
    }
    return best ? { type: best.type, start: best.start, end: best.end, node: best.node } : null
  }

  // A list item's mdast end sits right BEFORE its last line's terminator (same
  // convention as every other block here), so an empty item's only "inside"
  // offset — right after the marker, at the caret position a user would sit at
  // — lands exactly ON item.end. Blocks use exclusive end; items use inclusive
  // end so that boundary offset still resolves (the next item, if any, only
  // ever starts after the line terminator, so this can't collide).
  const withinItem = (item, offset) => offset >= item.start && offset <= item.end
  const listItemAt = (offset) => {
    let best = null
    for (const item of validItems) {
      if (withinItem(item, offset) && (!best || item.start >= best.start)) best = item
    }
    return best
  }

  const lineRange = (start, end) => {
    const first = lines[lineIndexAt(start)]
    const last = lines[lineIndexAt(Math.max(start, end - 1))]
    return { start: first.start, end: last.end + last.ending.length }
  }

  const containerRange = (offset) => {
    let top = null
    for (const b of blocks) {
      if (!within(b, offset)) continue
      if (CONTAINERS.has(b.type) && (!top || b.start <= top.start)) top = b
    }
    if (top) return lineRange(top.start, top.end)
    const block = blockAt(offset)
    if (block) return lineRange(block.start, block.end)
    const line = lines[lineIndexAt(offset)]
    return { start: line.start, end: line.end + line.ending.length }
  }

  return {
    text,
    tree,
    lines,
    dominantEnding,
    lineIndexAt,
    lineAt: (offset) => lines[lineIndexAt(offset)],
    blockAt,
    listItemAt,
    containerRange
  }
}
