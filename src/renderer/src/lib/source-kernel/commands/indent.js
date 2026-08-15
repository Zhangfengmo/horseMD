// Tab/Shift+Tab 列表项缩进/反缩进：只改当前项及其明确归属子树的行前缀，绝不重写
// 整个列表（不触碰兄弟项、不重排编号）。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
import { QUOTE_PREFIX } from '../../markdown-preservation/block-prefix.js'

// Same idiom as syntax-index.js buildItem: QUOTE_PREFIX's leading `[ \t]*` is
// unconditional, so it also matches pure indentation with zero '>' — only
// count it as a real quote prefix when it actually contains '>'.
const linePrefixLength = (line) => {
  const raw = (line.text.match(QUOTE_PREFIX) || [''])[0]
  return raw.includes('>') ? raw.length : 0
}

// index.listItemAt is blind to a line's own quote-prefix span — those chars
// belong to no item (see syntax-index.js: item.start begins AFTER the
// prefix), so probing at a raw line-start offset inside a blockquoted list
// returns null even though the line is clearly owned by some item. Nudge the
// probe past the line's own prefix before giving up.
const itemContaining = (index, offset) => {
  const direct = index.listItemAt(offset)
  if (direct) return direct
  const line = index.lines[index.lineIndexAt(offset)]
  const nudged = line.start + linePrefixLength(line)
  if (nudged <= offset || nudged > line.end) return null
  return index.listItemAt(nudged)
}

// The item's own lines: marker line through its subtree end, skipping blank
// lines. Returns null (fail-closed) if any owned line's own prefix does not
// match the item's quotePrefix byte-for-byte — a mismatch means the edit
// position (computed from item.quotePrefix) would not actually sit right
// after that line's real prefix.
const ownedLineIndexes = (index, item) => {
  const first = item.markerLineIndex
  const last = index.lineIndexAt(Math.max(item.start, item.end - 1))
  const rows = []
  for (let i = first; i <= last; i += 1) {
    const line = index.lines[i]
    if (line.text.slice(0, item.quotePrefix.length) !== item.quotePrefix) return null
    if (line.text.slice(item.quotePrefix.length).trim() !== '') rows.push(i)
  }
  return rows
}

// A flat single delta is wrong once an item owns more than one line: EVERY
// edit at or before `offset` shifts it, not just the one on offset's own
// line (a caret on a continuation/owned line sits after the marker line's
// edit AND its own line's edit). Sum every edit's effect that lands at or
// before offset, in original-document coordinates. These edits are always
// either a pure insert (from === to) or a pure whitespace deletion
// (insert === ''), never both in one edit, and — being prefix edits placed
// at a line's own start — offset can only fall inside a deleted range for a
// deletion, never inside an inserted pad; still clamp defensively.
const selectionFor = (edits, offset) => {
  let delta = 0
  for (const edit of edits) {
    if (edit.from > offset) break
    const insertLen = String(edit.insert ?? '').length
    if (edit.to <= offset) {
      delta += insertLen - (edit.to - edit.from)
    } else {
      // offset lands inside this edit's deleted range: clamp to the edit's
      // own insertion point plus however much of the deletion precedes it.
      delta += insertLen - (offset - edit.from)
    }
  }
  return offset + delta
}

const multiTxn = (doc, edits, intent, offset) => {
  const anchor = selectionFor(edits, offset)
  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      edits,
      intent,
      selection: { anchor, head: anchor }
    }
  }
}

// The nearest preceding item at the SAME depth, in the SAME list (same
// listStart) as `item`. Walked line-by-line (not by raw char offset — a raw
// offset such as `candidate.end - 1` is ambiguous because listItemAt is
// inclusive at an item's end, so stepping there and then `+= 1` in the loop
// lands right back on the same offset and never advances; see Task 6 brief
// notes) so every iteration strictly progresses to the next physical line.
const previousSibling = (index, item) => {
  let best = null
  const firstLine = index.lineIndexAt(item.listStart)
  const lastLine = item.markerLineIndex - 1
  for (let li = firstLine; li <= lastLine; li += 1) {
    const candidate = itemContaining(index, index.lines[li].start)
    if (
      candidate &&
      candidate.depth === item.depth &&
      candidate.listStart === item.listStart &&
      candidate.start < item.start &&
      (!best || candidate.start > best.start)
    ) {
      best = candidate
    }
  }
  return best
}

// The listItem that directly encloses item's own list. `item.listStart` is
// the start of item's own list (the position of that list's FIRST child,
// which — when item itself is that first child — equals item.start; probing
// listItemAt(item.listStart) would then resolve to item itself, not its
// parent). Probing one offset earlier always lands in the parent's own
// content, one level up, regardless of which sibling `item` is.
const parentItem = (index, item) => {
  if (item.listStart <= 0) return null
  return itemContaining(index, item.listStart - 1)
}

export function indentListItem({ doc, index, offset }) {
  const item = index.listItemAt(offset)
  if (!item) return { ok: false, code: 'unsupported-structure' }
  const prev = previousSibling(index, item)
  if (!prev) return { ok: false, code: 'unsupported-structure' }
  const width = prev.indent.length + prev.marker.length + prev.spacing.length -
    item.indent.length
  if (width <= 0) return { ok: false, code: 'unsupported-structure' }
  const rows = ownedLineIndexes(index, item)
  if (!rows) return { ok: false, code: 'unsupported-structure' }
  const pad = ' '.repeat(width)
  const edits = rows.map((i) => {
    const at = index.lines[i].start + item.quotePrefix.length
    return { from: at, to: at, insert: pad }
  })
  return multiTxn(doc, edits, 'indent-list-item', offset)
}

export function outdentListItem({ doc, index, offset }) {
  const item = index.listItemAt(offset)
  if (!item || item.depth === 0) return { ok: false, code: 'unsupported-structure' }
  const parent = parentItem(index, item)
  if (!parent) return { ok: false, code: 'unsupported-structure' }
  const width = item.indent.length - parent.indent.length
  if (width <= 0) return { ok: false, code: 'unsupported-structure' }
  const rows = ownedLineIndexes(index, item)
  if (!rows) return { ok: false, code: 'unsupported-structure' }
  const edits = []
  for (const i of rows) {
    const at = index.lines[i].start + item.quotePrefix.length
    if (!/^[ \t]+$/.test(index.text.slice(at, at + width))) {
      return { ok: false, code: 'unsupported-structure' }
    }
    edits.push({ from: at, to: at + width, insert: '' })
  }
  return multiTxn(doc, edits, 'outdent-list-item', offset)
}
