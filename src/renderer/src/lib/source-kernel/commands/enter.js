// Enter 命令族：段落/标题分裂、列表续项、空项退出。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
import { QUOTE_PREFIX } from '../../markdown-preservation/block-prefix.js'

const endingAt = (index, offset) => {
  const line = index.lineAt(offset)
  return line.ending || index.dominantEnding
}

// QUOTE_PREFIX's leading `[ \t]*` is unconditional, so it also matches pure
// leading whitespace with zero '>' — treat a match as a real quote prefix
// only when it actually contains '>' (same idiom as syntax-index.js buildItem).
const quotePrefixAt = (index, offset) => {
  const raw = (index.lineAt(offset).text.match(QUOTE_PREFIX) || [''])[0]
  return raw.includes('>') ? raw : ''
}

const bareQuote = (prefix) => prefix.replace(/[ \t]+$/, '')

// index.blockAt uses exclusive-end containment, so the caret position right
// after a block's last char (before its line terminator) — the single most
// common Enter position — resolves to null. Recover it by trying the block
// ending exactly at `offset` one position back, WITHOUT letting a blank-line
// gap (an offset that is not any block's end either) fall through to a
// preceding block it doesn't belong to.
// Exported (Task 7): router.js needs the same "block whose end sits exactly
// at offset" fallback for Delete-at-block-end (blockAt alone is exclusive-end
// and returns null right at that boundary).
export const resolveBlock = (index, offset) => {
  const direct = index.blockAt(offset)
  if (direct) return direct
  if (offset > 0) {
    const before = index.blockAt(offset - 1)
    if (before && offset === before.end) return before
  }
  return null
}

const txn = (doc, from, to, insert, intent, caret) => ({
  ok: true,
  transaction: {
    baseRevision: doc.revision,
    from,
    to,
    insert,
    intent,
    selection: { anchor: caret, head: caret }
  }
})

// A heading has no separate "marker region" record like list items do, so
// derive its content start straight from the mdast node: the first child's
// start offset, or — for an empty heading with no children (e.g. '#\n' /
// '# \n', where the marker consumes the whole block) — the block's own end.
const headingContentStart = (block) => {
  const first = block.node.children?.[0]
  return first ? first.position.start.offset : block.end
}

// 段落/标题内 Enter：插入 `ending + [引用空行] + 引用前缀`；caret 后文本自然成为
// 新块。标题分裂时新块没有 `#` marker，天然成为段落（source-first）。
export function splitTextBlock({ doc, index, offset }) {
  const block = resolveBlock(index, offset)
  if (!block || (block.type !== 'paragraph' && block.type !== 'heading')) {
    return { ok: false, code: 'unsupported-structure' }
  }
  // Fail-closed: a caret still inside the heading's `#{n} ` marker/spacing
  // region has no well-defined "text before/after the split" — splitting
  // there would tear the marker in two (e.g. offset 1 in '# 头\n' produces
  // '#\n\n 头\n'). Paragraphs have no marker, so they need no guard.
  if (block.type === 'heading' && offset < headingContentStart(block)) {
    return { ok: false, code: 'unsupported-structure' }
  }
  const ending = endingAt(index, offset)
  const prefix = quotePrefixAt(index, offset)
  const insert = prefix
    ? ending + bareQuote(prefix) + ending + prefix
    : ending + ending
  return txn(doc, offset, offset, insert, 'split-block', offset + insert.length)
}

// 非空列表项 Enter：插入 `ending + quotePrefix + indent + nextMarker + spacing
// (+ '[ ]' + taskSpacing)`。有序 marker 沿用当前显式编号 + 1 与其分隔符，绝不
// 重排既有兄弟项的编号；任务项新项恒为未勾选，spacing 逐字沿用原项。
export function splitListItem({ doc, index, offset }) {
  const item = index.listItemAt(offset)
  // Fail-closed: offset must sit at-or-after the item's content start. A
  // caret still inside the indent/marker/spacing (or task-checkbox) region
  // has no well-defined "text before/after the split", and inserting a new
  // marker there would tear the existing marker in two (e.g. '*' + '\n* ' +
  // ' 甲乙' from an offset of 1 in '* 甲乙\n').
  if (!item || item.empty || offset < item.contentStart) {
    return { ok: false, code: 'unsupported-structure' }
  }
  const ending = endingAt(index, offset)
  const marker = item.ordered
    ? String(item.ordered.number + 1) + item.ordered.delimiter
    : item.marker
  const insert = ending + item.quotePrefix + item.indent + marker + item.spacing +
    (item.task ? '[ ]' + item.taskSpacing : '')
  return txn(doc, offset, offset, insert, 'split-list-item', offset + insert.length)
}

// 空列表项 Enter：删除该 marker 行的 `indent+marker+spacing(+task+taskSpacing)`
// （从引用前缀之后到行尾），保留引用前缀；caret 停在删除点。
export function exitEmptyListItem({ doc, index, offset }) {
  const item = index.listItemAt(offset)
  if (!item?.empty) return { ok: false, code: 'unsupported-structure' }
  const line = index.lines[item.markerLineIndex]
  const from = line.start + item.quotePrefix.length
  const to = line.end
  return txn(doc, from, to, '', 'exit-empty-list-item', from)
}
