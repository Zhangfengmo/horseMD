// Backspace 命令族：空列表项提升（反缩进一级 / 退出列表）、段落回删合并。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
import { QUOTE_PREFIX } from '../../markdown-preservation/block-prefix.js'
import { parseKernelMarkdown } from '../syntax-index.js'
import { exitEmptyListItem, isVisuallyEmptyListItem } from './enter.js'
import { outdentListItem } from './indent.js'
import { isLedgeredWhitespaceTaskItem } from './task-seed.js'
import { NO_BREAK_SPACE } from './trailing-whitespace.js'

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
  // `listItemAt` spans are end-EXCLUSIVE, and an EMPTY item's caret sits at
  // `contentStart === end` (the `3. 4.` shape: the bare nested item's only
  // caret home is the offset right AFTER its marker, which no span
  // contains). Fall back one byte so the whole-item gesture still resolves
  // its item; the emptiness guard below re-verifies, so a content item's
  // end-of-text caret cannot borrow this path.
  const item = index.listItemAt(offset) ??
    (offset > 0 ? index.listItemAt(offset - 1) : null)
  if (!item?.empty && !isLedgeredWhitespaceTaskItem(doc, index.text, item) &&
      !isVisuallyEmptyListItem(index.text, item)) {
    return { ok: false, code: 'unsupported-structure' }
  }
  // SAME-LINE NESTED EMPTY ITEM (2026-08-24, the `3. 4.` user report). The
  // authored spelling parses as item 3 holding a nested empty ordered item —
  // BOTH items have no paragraph node in mdast, so their PM paragraphs pair
  // mdBlock-null and every character-level edit is refused read-only. The
  // WHOLE-ITEM Backspace, though, is provable: rewrite the nested marker
  // bytes into the ledgered seed NBSP (`3. 4.` -> `3.  `) — exactly the
  // spelling the indent-side EMPTY-ITEM SEED RESCUE writes — which pairs,
  // accepts typing (the seed dissolves under the first character), and exits
  // through the visually-empty family on the next Backspace. Geometric
  // preconditions keep it surgical: the nested item must sit on its PARENT's
  // own marker line, be truly empty, and end exactly where the parent ends
  // (a nested sibling below would be orphaned by the rewrite — refused, and
  // outdent's width<=0 refusal below stays its net).
  if (item.depth > 0 && item.empty && item.contentStart === item.end) {
    const parent = index.listItemAt(item.start - 1)
    if (parent && parent.depth === item.depth - 1 &&
        parent.markerLineIndex === item.markerLineIndex &&
        parent.end === item.end) {
      const candidate = index.text.slice(0, item.start) + NO_BREAK_SPACE + index.text.slice(item.end)
      if (provenSeededSameLineDelete(index.text, candidate, item.start)) {
        return {
          ok: true,
          transaction: {
            baseRevision: doc.revision,
            from: item.start,
            to: item.end,
            insert: NO_BREAK_SPACE,
            intent: 'lift-empty-list-item',
            selection: { anchor: item.start + 1, head: item.start + 1 },
            whitespaceMarks: [{ from: item.start, to: item.start + 1, ascii: '' }]
          }
        }
      }
      return { ok: false, code: 'unsupported-structure' }
    }
  }
  return item.depth > 0
    ? outdentListItem({ doc, index, offset })
    : exitEmptyListItem({ doc, index, offset })
}

// The reparse proof for the same-line rewrite above, modeled on indent.js's
// provenSeededEmptyIndent: the candidate must parse with a paragraph at
// exactly the seed offset whose sole content is the NBSP, sitting inside a
// listItem, with the nested list GONE (one fewer listItem overall) and every
// other text leaf byte-identical.
function provenSeededSameLineDelete(text, candidate, seedAt) {
  let before
  let after
  try {
    before = parseKernelMarkdown(text)
    after = parseKernelMarkdown(candidate)
  } catch {
    return false
  }
  const collect = (node, out, counter) => {
    if (node?.type === 'listItem') counter.items += 1
    if (node?.type === 'heading') counter.headings += 1
    if (node?.value !== undefined && node?.type === 'text') out.push(node.value)
    for (const child of node?.children || []) collect(child, out, counter)
  }
  const beforeLeaves = []
  const afterLeaves = []
  const beforeCount = { items: 0, headings: 0 }
  const afterCount = { items: 0, headings: 0 }
  collect(before, beforeLeaves, beforeCount)
  collect(after, afterLeaves, afterCount)
  if (afterCount.items !== beforeCount.items - 1) return false
  if (afterCount.headings !== beforeCount.headings) return false
  const seedIndex = afterLeaves.indexOf(NO_BREAK_SPACE)
  if (seedIndex === -1) return false
  const rest = afterLeaves.slice(0, seedIndex).concat(afterLeaves.slice(seedIndex + 1))
  if (JSON.stringify(rest) !== JSON.stringify(beforeLeaves)) return false
  // The seed paragraph must sit at exactly the rewritten offset, inside a
  // listItem ancestor.
  let seeded = false
  const walk = (node, ancestors) => {
    if (seeded) return
    if (node?.type === 'paragraph' && node.position?.start?.offset === seedAt &&
        node.children?.length === 1 && node.children[0]?.type === 'text' &&
        node.children[0].value === NO_BREAK_SPACE &&
        ancestors.some((ancestor) => ancestor?.type === 'listItem')) {
      seeded = true
      return
    }
    for (const child of node?.children || []) walk(child, [...ancestors, node])
  }
  walk(after, [])
  return seeded
}

// 段落首 Backspace：caret 必须落在段落的可见起点（offset === block.start），
// 且紧邻的上一个块也是段落、且引用深度（quotePrefix 逐字相同）一致，才把两
// 段合并——把块间空隙（上一段结尾到本段开头，可能跨越空行/纯 `>` 空引用
// 行）整体替换为 `ending + 当前行的引用前缀`，让本段文本原地续接到上一段末
// 尾，成为其惰性延续行。标题/列表/代码块等任何非段落边界，或引用深度不一
// 致，都判定为 unsupported-structure（fail-closed，不猜测语义）。
// The root-level node whose span contains `offset`.
function rootNodeAt(tree, offset) {
  for (const node of tree?.children || []) {
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (Number.isInteger(start) && Number.isInteger(end) && offset >= start && offset < end) return node
  }
  return null
}

// Every node outside `[regionStart, regionEnd)`, offsets normalised by `delta`
// — the heading join's own signature, lifted out so both branches share ONE
// definition of "nothing else changed meaning".
function outsideJoinSignature(tree, regionStart, regionEnd, delta) {
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

// See the ADR at the call site. Returns a transaction, or null to mean "not
// this shape" (the caller then runs its own paragraph/heading branches), never
// a refusal of its own — a shape this cannot prove simply falls through to the
// guards that refused it before.
function joinIntoContainerLastLine({ doc, index, block, previous }) {
  const text = index.text
  let baseTree
  try {
    baseTree = parseKernelMarkdown(text)
  } catch {
    return null
  }
  const container = rootNodeAt(baseTree, previous.start)
  if (!container || (container.type !== 'list' && container.type !== 'blockquote')) return null
  // The joined paragraph must be a ROOT-LEVEL paragraph. Without this, two
  // paragraphs INSIDE one blockquote (`> 甲\n>\n> 乙`) both resolve to the
  // same container and this branch would delete the gap between them, fusing
  // two quoted lines into one — the existing pinned answer there is the
  // quote's own paragraph join (`> 甲\n> 乙`), which the caller's later
  // branches produce. Caught by test-source-kernel-indent's own case.
  // The joined paragraph must be top-level and single-line: a multi-line
  // paragraph would orphan its continuation lines into the container, and a
  // paragraph already inside a list item is the list domain's own business.
  if (index.listItemAt(block.start)) return null
  const joinedRoot = rootNodeAt(baseTree, block.start)
  if (!joinedRoot || joinedRoot.type !== 'paragraph' || joinedRoot.position?.start?.offset !== block.start) return null
  const line = index.lineAt(block.start)
  if (!line || block.end > line.end) return null
  if (index.bisectsInlineHtml(previous.end, block.start)) return null
  const containerStart = container.position.start.offset
  const gap = block.start - previous.end
  if (gap <= 0) return null
  const candidate = text.slice(0, previous.end) + text.slice(block.start)
  let candTree
  try {
    candTree = parseKernelMarkdown(candidate)
  } catch {
    return null
  }
  const joined = rootNodeAt(candTree, containerStart)
  if (!joined || joined.type !== container.type) return null
  // The container swallowed EXACTLY the paragraph: it now ends where the
  // paragraph ended, shifted by the gap that went away.
  if (joined.position?.end?.offset !== block.end - gap) return null
  const before = outsideJoinSignature(baseTree, containerStart, block.end, 0)
  const after = outsideJoinSignature(candTree, containerStart, block.end - gap, -gap)
  if (before === null || after === null || before !== after) return null
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
  // JOINING INTO A CONTAINER'S LAST LINE (2026-08-28, user: 「继续完成」 —
  // the sweep's remaining refusals). A paragraph directly after a LIST or a
  // BLOCKQUOTE joins that container's last line, which is exactly what the
  // legacy pipeline does with the same keystroke (measured: `- 甲\n- 乙` +
  // Backspace at the paragraph below -> `- 甲\n- 乙尾段。`; `> 引用内容` ->
  // `> 引用内容尾段。`). The byte edit is the heading branch's edit — delete
  // the inter-block gap — and the proof is the heading branch's proof applied
  // to the CONTAINER: after the join it must be the same kind of node, ending
  // exactly where the joined paragraph ended, with every node outside the
  // joined region byte-identical.
  //
  // Asked BEFORE the list-item and quote-prefix guards below, because those
  // exist to keep the plain paragraph-to-paragraph join from reaching these
  // shapes at all — this branch is what proves them instead of assuming.
  const containerJoin = joinIntoContainerLastLine({ doc, index, block, previous })
  if (containerJoin) return containerJoin
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
