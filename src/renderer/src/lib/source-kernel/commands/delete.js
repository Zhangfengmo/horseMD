// Backspace 命令族：空列表项提升（反缩进一级 / 退出列表）、段落回删合并。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
import { QUOTE_PREFIX } from '../../markdown-preservation/block-prefix.js'
import { parseKernelMarkdown } from '../syntax-index.js'
import { exitEmptyListItem, isVisuallyEmptyListItem } from './enter.js'
import { outdentListItem } from './indent.js'
import { isLedgeredWhitespaceTaskItem } from './task-seed.js'

// QUOTE_PREFIX's leading `[ \t]*` is unconditional, so it also matches pure
// leading whitespace with zero '>' — treat a match as a real quote prefix
// only when it actually contains '>' (same idiom as syntax-index.js buildItem,
// enter.js quotePrefixAt, indent.js linePrefixLength).
const quotePrefixOfLine = (line) => {
  const raw = (line.text.match(QUOTE_PREFIX) || [''])[0]
  return raw.includes('>') ? raw : ''
}

// 空列表项 Backspace（Typora 语义）：depth > 0 委托 outdentListItem（先反缩进
// 一级，落到父列表成为其项）；depth 0（顶层）委托 exitEmptyListItem（清空
// marker 行，退出列表）。会话内新建、从未输入正文的种子任务项
// （isLedgeredWhitespaceTaskItem——账本为该 U+00A0 记着 `ascii:''`）视同空项，走
// 同一出口：种子"不代表任何按键"，与 Enter 侧 exitEmptyListItem 的契约对称
// （2026-08-22 用户报告——此前该项唯一的删除路径是字符级删种子字节，被
// empty-task 墙拒绝，形成只能 Enter 或撤销的死角）。重开文件后的 U+00A0 是
// 作者的字节（账本为空），仍拒绝——字符级删除走文本路径。
export function liftEmptyListItem({ doc, index, offset }) {
  const item = index.listItemAt(offset)
  if (!item?.empty && !isLedgeredWhitespaceTaskItem(doc, index.text, item) &&
      !isVisuallyEmptyListItem(index.text, item)) {
    return { ok: false, code: 'unsupported-structure' }
  }
  return item.depth > 0
    ? outdentListItem({ doc, index, offset })
    : exitEmptyListItem({ doc, index, offset })
}

// 段落首 Backspace：caret 必须落在段落的可见起点（offset === block.start），
// 且紧邻的上一个块也是段落、且引用深度（quotePrefix 逐字相同）一致，才把两
// 段合并——把块间空隙（上一段结尾到本段开头，可能跨越空行/纯 `>` 空引用
// 行）整体替换为 `ending + 当前行的引用前缀`，让本段文本原地续接到上一段末
// 尾，成为其惰性延续行。标题/列表/代码块等任何非段落边界，或引用深度不一
// 致，都判定为 unsupported-structure（fail-closed，不猜测语义）。
export function joinParagraphBackward({ doc, index, offset }) {
  const block = index.blockAt(offset)
  if (!block || block.type !== 'paragraph' || offset !== block.start) {
    return { ok: false, code: 'unsupported-structure' }
  }
  // 上一个块：从 block.start - 1 开始逐字符向前探测，找到第一个"包含该偏
  // 移"的块。blockAt 是含头不含尾（exclusive end），逐位置扫描能穿过任意
  // 宽度的块间空隙（空行、纯 `>` 空引用行……），不依赖固定的间隙长度假设。
  let previous = null
  for (let at = block.start - 1; at >= 0; at -= 1) {
    const candidate = index.blockAt(at)
    if (candidate) { previous = candidate; break }
  }
  if (!previous || (previous.type !== 'paragraph' && previous.type !== 'heading')) {
    return { ok: false, code: 'unsupported-structure' }
  }
  // Neither side may be a paragraph nested inside a list item. blockAt does
  // not distinguish "top-level paragraph" from "a listItem's own paragraph
  // child" — both are plain `paragraph` nodes to it — so without this check
  // a paragraph directly following a list (e.g. '甲\n\n- x\n\n乙\n', 乙 right
  // after the list) would find the list item's paragraph as `previous` and
  // splice 乙 into it as a lazy continuation line of that list item, silently
  // absorbing prose into unrelated list structure. Phase 1 never joins across
  // a list-item boundary in either direction; `listItemAt` (not `blockAt`) is
  // list-aware and is the source of truth here.
  if (index.listItemAt(block.start) || index.listItemAt(previous.start)) {
    return { ok: false, code: 'unsupported-structure' }
  }
  // Fragment-bisection guard on the RANGE this command replaces (the inter-
  // block gap). Like the list-item check above it is a second net rather than
  // the primary defence: both endpoints are block boundaries, and an inline
  // HTML fragment lives strictly inside one block's children, so today no
  // fragment can straddle them. It is asserted here anyway because this file
  // owns the bytes it writes — the same reason `blockAt`'s pre-fix
  // mis-resolution was the ONLY thing stopping this command from running, and
  // that turned out to be an accident rather than a contract.
  if (index.bisectsInlineHtml(previous.end, block.start)) {
    return { ok: false, code: 'unsupported-structure' }
  }
  const line = index.lineAt(offset)
  const prefix = quotePrefixOfLine(line)
  const prevLine = index.lineAt(previous.end - 1)
  const prevPrefix = quotePrefixOfLine(prevLine)
  if (prefix !== prevPrefix) return { ok: false, code: 'unsupported-structure' }
  // 前块是 ATX 标题（2026-08-23 用户报告「有数据的头部按删除则自动将这一行
  // 合并到上一行」）：把整个块间隙删除，本段文本原地续接到标题行——标题是
  // 单行块，没有惰性延续，所以这里的唯一合法拼写是直接并行。约束：本段自身
  // 必须是单行（多行段落并入会把续行孤儿化）、前块必须是 ATX（setext 的 span
  // 穿过下划线，永远不满足 caret==end，双保险再查一次拼写）。重解析证明把
  // 关：合并后 previous.start 处必须是同深度的标题、其 end 恰为平移后的本段
  // 末尾，且被并区域之外的每个节点逐字存活（偏移平移归一）。
  if (previous.type === 'heading') {
    const text = index.text
    if (!/^ {0,3}#{1,6}[ \t]/.test(text.slice(previous.start, previous.end))) {
      return { ok: false, code: 'unsupported-structure' }
    }
    if (block.end > line.end) return { ok: false, code: 'unsupported-structure' }
    const gap = block.start - previous.end
    const candidate = text.slice(0, previous.end) + text.slice(block.start)
    let baseTree
    let candTree
    try {
      baseTree = parseKernelMarkdown(text)
      candTree = parseKernelMarkdown(candidate)
    } catch {
      return { ok: false, code: 'unsupported-structure' }
    }
    const headingAt = (tree, start) => {
      let hit = null
      const walk = (node) => {
        if (hit) return
        if (node.type === 'heading' && node.position?.start?.offset === start) { hit = node; return }
        for (const child of node.children || []) walk(child)
      }
      walk(tree)
      return hit
    }
    const baseHeading = headingAt(baseTree, previous.start)
    const joined = headingAt(candTree, previous.start)
    if (!baseHeading || !joined) return { ok: false, code: 'unsupported-structure' }
    if (joined.depth !== baseHeading.depth) return { ok: false, code: 'unsupported-structure' }
    if (joined.position?.end?.offset !== block.end - gap) {
      return { ok: false, code: 'unsupported-structure' }
    }
    const sig = (tree, regionStart, regionEnd, delta) => {
      const rows = []
      let ok = true
      const walk = (node) => {
        if (!ok) return
        const s = node.position?.start?.offset
        const e = node.position?.end?.offset
        if (!Number.isInteger(s) || !Number.isInteger(e)) { ok = false; return }
        if (s < regionEnd && e > regionStart) {
          for (const child of node.children || []) walk(child)
          return
        }
        rows.push(`${node.type}:${s <= regionStart ? s : s - delta}:${e <= regionStart ? e : e - delta}`)
        for (const child of node.children || []) walk(child)
      }
      for (const child of tree.children || []) walk(child)
      return ok ? rows.join('\n') : null
    }
    const before = sig(baseTree, previous.start, block.end, 0)
    const after = sig(candTree, previous.start, block.end - gap, -gap)
    if (before === null || after === null || before !== after) {
      return { ok: false, code: 'unsupported-structure' }
    }
    return {
      ok: true,
      transaction: {
        baseRevision: doc.revision,
        from: previous.end,
        to: block.start,
        insert: '',
        intent: 'join-block-backward',
        selection: { anchor: previous.end, head: previous.end }
      }
    }
  }
  const ending = prevLine.ending || index.dominantEnding
  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      from: previous.end,
      to: block.start,
      insert: ending + prefix,
      intent: 'join-block-backward',
      selection: { anchor: previous.end, head: previous.end }
    }
  }
}
