// Enter 命令族：段落/标题分裂、列表续项、空项退出。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
import { QUOTE_PREFIX } from '../../markdown-preservation/block-prefix.js'
import { parseKernelMarkdown } from '../syntax-index.js'
import { NO_BREAK_SPACE, blockText } from './trailing-whitespace.js'
import { isLedgeredSeedOnlyItem } from './task-seed.js'

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

const txn = (doc, from, to, insert, intent, caret, whitespaceMarks = null) => ({
  ok: true,
  transaction: {
    baseRevision: doc.revision,
    from,
    to,
    insert,
    intent,
    selection: { anchor: caret, head: caret },
    ...(whitespaceMarks?.length ? { whitespaceMarks } : {})
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

// 块尾连续 Enter：offset 落在「最后一个顶层块结束之后、直到文档末尾」的空白
// 字节区——resolveBlock 在那里找不到任何块（CommonMark 把空白行游程折叠成
// 「无节点」），且其后再没有别的块。这正是块尾第一次 Enter 后
// controller（editor-kernel-mode.js ensureSplitPlaceholder）物化的虚拟段落
// 所在：再按一次 Enter 不应被拒，而是把游程再延长一行。用「其后再无块」把它
// 和文档中段两个真实块之间的空行 GAP 区分开——后者必须继续 fail-closed（见
// 下面 '甲乙\n\n丙\n' 的回归用例）。
const isTrailingGap = (index, offset) => {
  const children = index.tree.children || []
  const last = children[children.length - 1]
  const lastEnd = last?.position?.end?.offset
  if (!Number.isInteger(lastEnd)) return false
  return offset >= lastEnd && offset <= index.text.length
}

// 段落/标题内 Enter：插入 `ending + [引用空行] + 引用前缀`；caret 后文本自然成为
// 新块。标题分裂时新块没有 `#` marker，天然成为段落（source-first）。
export function splitTextBlock({ doc, index, offset }) {
  const block = resolveBlock(index, offset)
  if (!block) {
    // 块尾连续 Enter：见 isTrailingGap 注释。这里没有「块」可分，只有空白
    // 游程可延——复用该行本就有的行终止符（同分裂惯例：新块尾复用原终止
    // 符），caret 紧邻它，为下一次 Enter/输入留出同样的锚点。
    if (!isTrailingGap(index, offset)) return { ok: false, code: 'unsupported-structure' }
    const ending = endingAt(index, offset)
    return txn(doc, offset, offset, ending, 'split-block', offset + ending.length)
  }
  if (block.type !== 'paragraph' && block.type !== 'heading') {
    return { ok: false, code: 'unsupported-structure' }
  }
  // Fail-closed: a caret still inside the heading's `#{n} ` marker/spacing
  // region has no well-defined "text before/after the split" — splitting
  // there would tear the marker in two (e.g. offset 1 in '# 头\n' produces
  // '#\n\n 头\n'). Paragraphs have no marker, so they need no guard.
  if (block.type === 'heading' && offset < headingContentStart(block)) {
    return { ok: false, code: 'unsupported-structure' }
  }
  // Fail-closed: never split INSIDE an inline HTML fragment (see
  // syntax-index.js `bisectsInlineHtml`). `a <span>x</span> b` split at the `x`
  // would commit two unbalanced fragments that reparse as escaped text — a
  // different document than the one on screen. Splitting AT either edge of a
  // fragment is fine and is exactly what this guard leaves reachable.
  if (index.bisectsInlineHtml(offset)) return { ok: false, code: 'unsupported-structure' }
  const contentStart = block.type === 'heading' ? headingContentStart(block) : block.start
  if (offset === contentStart) {
    // 段首 Enter (Task 2, plan 3): insert exactly ONE `ending` (plus a bare
    // quote marker if this line is quoted) at the physical LINE START, never
    // at `offset` — everything from `line.start` onward (any quote prefix /
    // heading marker / the content itself) is left byte-for-byte untouched,
    // so nothing is torn. The new blank line lands ABOVE the block; caret
    // stays anchored to the SAME content (its raw offset simply shifts by
    // the inserted byte count — `offset + insert.length`, same formula as
    // every other branch here, valid because the insert is entirely BEFORE
    // `offset`). Repeated presses are legal and additive: each one inserts
    // one more blank (quoted) line above, caret always ending up back at the
    // original text. This replaces the old behavior of inserting `ending +
    // ending` AT `offset` (which produced leading blank-byte accumulation
    // AND left the caret after the separator, not on the original text).
    const line = index.lineAt(offset)
    const ending = endingAt(index, offset)
    const prefix = quotePrefixAt(index, offset)
    const insert = prefix ? bareQuote(prefix) + ending : ending
    return txn(doc, line.start, line.start, insert, 'split-block', offset + insert.length)
  }
  const ending = endingAt(index, offset)
  const prefix = quotePrefixAt(index, offset)
  const insert = prefix
    ? ending + bareQuote(prefix) + ending + prefix
    : ending + ending
  return txn(doc, offset, offset, insert, 'split-block', offset + insert.length)
}

// THE SEED PROOF for a task split (2026-08-21 task-Enter matrix). A split
// that leaves EITHER side of a task item without content used to write that
// side as bare `- [ ] ` — which remark-gfm DEMOTES to `checked: null` with
// literal "[ ]" text (the seven-spelling measurement in
// commands/block-insert.js's task ADR): the checkbox vanished from the view,
// the caret anchor landed on a byte with no character-map unit
// (`caret-unmappable:split-list-item`), and the next keystroke typed into the
// WRONG item. Measured in the built app for end-of-label, checked, quoted,
// nested and CRLF items alike; only the mid-label split (both sides keep
// content) was sound.
//
// The exit is the SAME seed machinery `/task` established — not a second
// implementation: the empty side gets `- [ ] ` + U+00A0 (the ONE representable
// spelling of a label-less task), the byte is session-ledgered with the seed
// provenance (`ascii: ''`, "stands for NO keystroke"), and the FIRST label
// character dissolves it through the existing commands (task-seed.js via the
// gateway's plain-text branch, and via commitReplace for IME commits since
// 5c8a5a8). Nothing new learns to dissolve; this only learns to WRITE the
// spelling those commands already own.
//
// PROVEN, NOT ASSUMED: the candidate document is reparsed and the seeded side
// must come back a listItem with the EXPECTED boolean `checked` (false for
// the new continuation item — a checked item continues unchecked; the
// original item's own state when the split empties the original) whose first
// paragraph decodes to EXACTLY the seed. If the proof fails, the caller falls
// back to the pre-existing unseeded bytes — never a new refusal, never a
// worse outcome than the status quo.
const seedProven = (candidate, seedOffset, expectedChecked) => {
  let tree
  try {
    tree = parseKernelMarkdown(candidate)
  } catch {
    return false
  }
  let proven = false
  const walk = (node, parent) => {
    if (proven) return
    if (node?.type === 'paragraph' && parent?.type === 'listItem' &&
        parent.checked === expectedChecked &&
        Number.isInteger(node.position?.start?.offset) &&
        node.position.start.offset <= seedOffset &&
        seedOffset < (node.position?.end?.offset ?? -1) &&
        blockText(node) === NO_BREAK_SPACE) {
      proven = true
      return
    }
    for (const child of node?.children || []) walk(child, node)
  }
  walk(tree, null)
  return proven
}

// 非空列表项 Enter：插入 `ending + quotePrefix + indent + nextMarker + spacing
// (+ '[ ]' + taskSpacing)`。有序 marker 沿用当前显式编号 + 1 与其分隔符，绝不
// 重排既有兄弟项的编号；任务项新项恒为未勾选，spacing 逐字沿用原项。
// 任务项的空侧带种子（见 seedProven 的 ADR）：分裂后没有内容的那一侧写成
// `[ ]` + taskSpacing + U+00A0 并入账（provenance `ascii:''`），第一个正文字
// 符在同一笔编辑里溶解它——与 `/task` 完全同一套机制。
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
  // Same fragment-bisection guard as splitTextBlock: a list item's content is
  // phrasing too, so `- a <span>x</span> b` must refuse a split at the `x`.
  if (index.bisectsInlineHtml(offset)) return { ok: false, code: 'unsupported-structure' }
  const ending = endingAt(index, offset)
  const marker = item.ordered
    ? String(item.ordered.number + 1) + item.ordered.delimiter
    : item.marker
  const base = ending + item.quotePrefix + item.indent + marker + item.spacing +
    (item.task ? '[ ]' + item.taskSpacing : '')
  if (item.task) {
    const text = index.text
    // Which side of the split ends up with no parser-visible content? ASCII
    // space/tab only — U+00A0 IS content to remark, so an author's own
    // no-break space keeps its side non-empty and is never restyled. `item.end`
    // is the mdast item end, so a multi-line item's continuation bytes (they
    // contain the line ending, which `[^ \t]` matches) keep `afterEmpty`
    // false and the split stays byte-identical to before.
    const beforeEmpty = !/[^ \t]/.test(text.slice(item.contentStart, offset))
    const afterEmpty = !/[^ \t]/.test(text.slice(offset, item.end))
    // Both-empty is unreachable here: an item with no content at all is
    // `empty` (routed to the exit), and a seed-only item is routed to the
    // exit by the router's ledger check before this command runs.
    if (afterEmpty && !beforeEmpty) {
      // The NEW item is the empty side: seed it, caret AFTER the seed (the
      // `/task` ruled design — the seed's end is where the first label
      // character lands, which is what lets the dissolve claim it).
      const insert = base + NO_BREAK_SPACE
      const caret = offset + insert.length
      const candidate = text.slice(0, offset) + insert + text.slice(offset)
      if (seedProven(candidate, caret - 1, false)) {
        return txn(doc, offset, offset, insert, 'split-list-item', caret,
          [{ from: caret - 1, to: caret, ascii: '' }])
      }
    } else if (beforeEmpty && !afterEmpty) {
      // The ORIGINAL item is the empty side (Enter at the label's very
      // start): the label moves down into the new item, the original keeps
      // its own checkbox STATE with the seed as its only content, and the
      // caret rides with the label — exactly the Typora "push the item down"
      // shape, spelled in representable bytes.
      const insert = NO_BREAK_SPACE + base
      const caret = offset + insert.length
      const candidate = text.slice(0, offset) + insert + text.slice(offset)
      if (seedProven(candidate, offset, item.task.checked)) {
        return txn(doc, offset, offset, insert, 'split-list-item', caret,
          [{ from: offset, to: offset + 1, ascii: '' }])
      }
    }
    // Proof failed (an unforeseen nesting/prefix shape): fall through to the
    // pre-existing unseeded bytes below — the status quo, never worse.
  }
  return txn(doc, offset, offset, base, 'split-list-item', offset + base.length)
}

// 空列表项 Enter：删除该 marker 行的 `indent+marker+spacing(+task+taskSpacing)`
// （从引用前缀之后到行尾），保留引用前缀；caret 停在删除点。
// 会话内新建、从未输入正文的种子任务项（isLedgeredSeedOnlyItem——账本为该
// U+00A0 记着 `ascii:''`）走同一出口：种子"不代表任何按键"，对 Enter 而言该
// 项与空项等价（2026-08-21 task-Enter matrix cell 3，Typora 的 lift-out）。
// 重开文件后的 U+00A0 是作者的字节（账本为空），仍走普通分裂，绝不删除。
export function exitEmptyListItem({ doc, index, offset }) {
  const item = index.listItemAt(offset)
  if (!item) return { ok: false, code: 'unsupported-structure' }
  if (!item.empty && !isLedgeredSeedOnlyItem(doc, index.text, item)) {
    return { ok: false, code: 'unsupported-structure' }
  }
  const line = index.lines[item.markerLineIndex]
  const from = line.start + item.quotePrefix.length
  const to = line.end
  return txn(doc, from, to, '', 'exit-empty-list-item', from)
}
