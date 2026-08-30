// Enter 命令族：段落/标题分裂、列表续项、空项退出。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
import { QUOTE_PREFIX } from '../../markdown-preservation/block-prefix.js'
import { parseKernelMarkdown, buildSyntaxIndex } from '../syntax-index.js'
import { buildCharacterMap } from '../character-map.js'
import { NO_BREAK_SPACE, blockText } from './trailing-whitespace.js'
import { isLedgeredWhitespaceTaskItem } from './task-seed.js'
import { outdentListItem } from './indent.js'

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

// 中段空白游程 Enter 的证明：在 `at` 处插入 `insert`（一个行终止符，或行终止
// 符+引用前缀）后，除「插入点之后的偏移整体平移 insert.length」外，文档全树
// 必须逐节点等价——type、span、叶值全同。跨越插入点的容器（包着这条空行的
// blockquote/list）允许 end 平移；任何块的出现/消失/换型（裸 ending 把引用劈
// 成两半、把松紧列表改判）都会让签名失配而拒绝。解析器裁决，不靠上面的散文。
const gapInsertPreservesStructure = (text, at, insert) => {
  let before
  let after
  try {
    before = parseKernelMarkdown(text)
    after = parseKernelMarkdown(text.slice(0, at) + insert + text.slice(at))
  } catch {
    return false
  }
  const delta = insert.length
  const signature = (tree, shiftFrom) => {
    const rows = []
    const walk = (node) => {
      const start = node.position?.start?.offset
      const end = node.position?.end?.offset
      if (Number.isInteger(start) && Number.isInteger(end)) {
        const s = shiftFrom !== null && start > shiftFrom ? start - delta : start
        const e = shiftFrom !== null && end > shiftFrom ? end - delta : end
        rows.push(`${node.type}:${s}:${e}:${typeof node.value === 'string' ? node.value : ''}:${node.checked ?? ''}:${node.ordered ?? ''}:${node.spread ?? ''}`)
      }
      for (const child of node.children || []) walk(child)
    }
    walk(tree)
    return rows.join('')
  }
  return signature(before, null) === signature(after, at)
}

// 删除方向的同一份证明：删掉 [from,to) 后，除「删除点之后的偏移整体回移
// delta」外全树逐节点等价。落在删除区间内部的任何偏移都映射为哨兵（必然失
// 配）——一个块的边界若真的靠这些字节存在，删除就改变了结构,由解析器裁决。
const gapRemovalPreservesStructure = (text, from, to) => {
  let before
  let after
  try {
    before = parseKernelMarkdown(text)
    after = parseKernelMarkdown(text.slice(0, from) + text.slice(to))
  } catch {
    return false
  }
  const delta = to - from
  const signature = (tree, shift) => {
    const rows = []
    const walk = (node) => {
      const start = node.position?.start?.offset
      const end = node.position?.end?.offset
      if (Number.isInteger(start) && Number.isInteger(end)) {
        const map = (o) => (!shift ? o : o <= from ? o : o >= to ? o - delta : NaN)
        rows.push(`${node.type}:${map(start)}:${map(end)}:${typeof node.value === 'string' ? node.value : ''}:${node.checked ?? ''}:${node.ordered ?? ''}:${node.spread ?? ''}`)
      }
      for (const child of node.children || []) walk(child)
    }
    walk(tree)
    return rows.join('')
  }
  return signature(before, true) === signature(after, false)
}

// shrinkBlankRun：GAP 分支的严格逆操作（2026-08-23 用户报告：占位符空段上按
// Backspace 被 `unsupported-input-type` 拒绝）。caret 必须停在一条空白行的前
// 缀末尾（正是占位符锚点的形状）。两种拼写：
//   * `span`——会话记录的「本次 Enter 写入的原始区间」：整段删除＝字节级精确
//     还原 Enter 之前的文档；
//   * 无 span（emptied-paragraph / exit 占位骑在既有行上）：删除「上一行的行
//     终止符 + 本行前缀」，游程收缩一行。
// 两条路都只允许删空白/前缀字节（内容字节在预筛就拒绝），并且都要过
// gapRemovalPreservesStructure 重解析证明——删掉唯一分隔行会并块（惰性续行、
// 引用劈开），由证明当场拒绝，绝不盲写。
export function shrinkBlankRun({ doc, index, offset, span = null }) {
  const text = index.text
  const line = index.lines[index.lineIndexAt(offset)]
  if (!line) return { ok: false, code: 'unsupported-structure' }
  const prefix = (line.text.match(/^[>\t ]*/) || [''])[0]
  if (line.text.slice(prefix.length).trim() !== '' || offset !== line.start + prefix.length) {
    return { ok: false, code: 'unsupported-structure' }
  }
  let from
  let to
  if (span && Number.isFinite(span.from) && Number.isFinite(span.to) &&
      span.from < span.to && span.to === offset) {
    from = span.from
    to = span.to
  } else {
    if (line.start === 0) return { ok: false, code: 'unsupported-structure' }
    const endingLength = line.start >= 2 && text[line.start - 2] === '\r' ? 2 : 1
    from = line.start - endingLength
    to = offset
  }
  if (!/^[>\t \r\n]*$/.test(text.slice(from, to))) {
    return { ok: false, code: 'unsupported-structure' }
  }
  if (!gapRemovalPreservesStructure(text, from, to)) {
    return { ok: false, code: 'unsupported-structure' }
  }
  return txn(doc, from, to, '', 'shrink-blank-run', from)
}

// MARK-TAIL SNAP (2026-08-23 user report — measured corruption: Enter at the
// end of `- \`npm run test:source-map\`` wrote '…source-map\n- `', silently
// un-closing the old item's inline code). The PM caret at the visible end of
// a marked run maps to the raw boundary BEFORE the mark's closing delimiter
// bytes; a split there tears the mark in two. The block's own character map
// is the oracle: when every visible unit ends at or before `offset` and the
// block's raw span still continues (only syntax bytes remain — gaps carry no
// units by construction), the visible caret IS the block end and the split
// belongs after the delimiters. A caret with visible content after it is
// untouched.
const snapPastMarkTail = (index, offset) => {
  const block = resolveBlock(index, offset)
  if (!block?.node) return offset
  const end = block.node.position?.end?.offset
  if (!Number.isInteger(end) || offset >= end) return offset
  let map = null
  try {
    map = buildCharacterMap(index.text, block.node)
  } catch {
    return offset
  }
  if (!map || !Array.isArray(map.units)) return offset
  const lastVisible = map.units.length ? map.units[map.units.length - 1].rawEnd : null
  if (lastVisible === null || offset < lastVisible) return offset
  return end
}

// 段落/标题内 Enter：插入 `ending + [引用空行] + 引用前缀`；caret 后文本自然成为
// 新块。标题分裂时新块没有 `#` marker，天然成为段落（source-first）。
export function splitTextBlock({ doc, index, offset: rawOffset }) {
  const offset = snapPastMarkTail(index, rawOffset)
  const block = resolveBlock(index, offset)
  if (!block) {
    // 块尾连续 Enter：见 isTrailingGap 注释。这里没有「块」可分，只有空白
    // 游程可延——复用该行本就有的行终止符（同分裂惯例：新块尾复用原终止
    // 符），caret 紧邻它，为下一次 Enter/输入留出同样的锚点。
    const ending = endingAt(index, offset)
    if (isTrailingGap(index, offset)) {
      return txn(doc, offset, offset, ending, 'split-block', offset + ending.length)
    }
    // 文档中段的空白行（2026-08-23 用户报告：占位符段落上再按一次 Enter 被
    // 拒）。历史上这里必须 fail-closed，因为 split-placeholder 只会在文档末
    // 尾物化；/text 中段化（2026-08-21）之后同一会话已服务任意中段空行，所
    // 以 Enter 在这里的含义与块尾一致——把空白游程再延一行，caret 骑到新行
    // 上。每个拼写都要过重解析证明（gapInsertPreservesStructure：除插入点之
    // 后的偏移平移外，全树 type/span/叶值逐一不变）：裸 ending 在引用内会把
    // blockquote 劈成两半，由证明当场拒绝，改试 ending + 该行自己的引用前
    // 缀；两个拼写都证不出才维持具名拒绝。
    const line = index.lines[index.lineIndexAt(offset)]
    const prefix = (line.text.match(/^[>\t ]*/) || [''])[0]
    if (line.text.slice(prefix.length).trim() !== '' || offset < line.start + prefix.length) {
      return { ok: false, code: 'unsupported-structure' }
    }
    const attempts = [ending]
    if (prefix.includes('>')) attempts.push(ending + prefix)
    for (const insert of attempts) {
      if (gapInsertPreservesStructure(index.text, offset, insert)) {
        return txn(doc, offset, offset, insert, 'split-block', offset + insert.length)
      }
    }
    return { ok: false, code: 'unsupported-structure' }
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
export function splitListItem({ doc, index, offset: rawOffset }) {
  // Same mark-tail snap as splitTextBlock — the reported corruption's exact
  // home (the list item ending in inline code). Snapped BEFORE the item
  // resolution so a snapped-to-end offset still resolves through
  // listItemAt's own containment (the paragraph end is inside the item).
  const offset = snapPastMarkTail(index, rawOffset)
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
  // NUMBER-ADOPTING ENTER (2026-08-24「回车出现两个序列号」终局). The manual
  // numberer types their own `3.` into the item Enter just created; the
  // typing policy (text-escape.js) keeps it literal (`2. 3\.`), which
  // doubled the view: auto ordinal + typed number. Their continuation key is
  // ENTER — so when the item's ENTIRE content is that escaped typed number,
  // Enter ADOPTS it as the item's own marker and continues the list from
  // N+1: `2. 3\.` + Enter -> `3. ` + `4. ` with the caret in the new item.
  // The workflow converges even if they keep typing numbers — every Enter
  // folds the typed number into the marker. Space adoption (the marker-space
  // RENUMBER arm) is this gesture's sibling. Reparse-proven: both resulting
  // items must carry the expected numbers as REAL empty ordered items, and
  // the document's text leaves must lose exactly the typed `N.` and nothing
  // else.
  if (item.ordered && !item.task && offset === item.end) {
    const adopted = /^(\d{1,9})\\([.)])$/.exec(index.text.slice(item.contentStart, item.end))
    if (adopted) {
      const markerStart = index.lines[item.markerLineIndex].start +
        item.quotePrefix.length + item.indent.length
      const lineEnding = endingAt(index, offset)
      // DELIMITER FOLLOWS THE LIST (undecided-edges finding #1): the typed
      // delimiter may differ from the list's (`4)` in a `.` list) and
      // CommonMark would split the list on it — adopt the NUMBER, keep the
      // item's own delimiter.
      const adoptedDelimiter = item.ordered.delimiter || adopted[2]
      const nextMarker = String(Number(adopted[1]) + 1) + adoptedDelimiter
      const insert = `${adopted[1]}${adoptedDelimiter} ${lineEnding}${item.quotePrefix}${item.indent}${nextMarker} `
      const candidate = index.text.slice(0, markerStart) + insert + index.text.slice(item.end)
      const proven = (() => {
        let before
        let after
        try {
          before = buildSyntaxIndex(index.text)
          after = buildSyntaxIndex(candidate)
        } catch {
          return false
        }
        const first = after.listItemAt(markerStart)
        const second = after.listItemAt(markerStart + insert.length - 1)
        if (!first?.ordered || String(first.ordered.number) !== adopted[1]) return false
        if (!second?.ordered || String(second.ordered.number) !== String(Number(adopted[1]) + 1)) return false
        if (first.task || second.task || first === second) return false
        const leaves = (idx) => {
          const out = []
          const walk = (node) => {
            if (node?.type === 'text') out.push(node.value)
            for (const child of node?.children || []) walk(child)
          }
          walk(idx.tree)
          return out
        }
        const beforeLeaves = leaves(before)
        const afterLeaves = leaves(after)
        return afterLeaves.length === beforeLeaves.length - 1 &&
          afterLeaves.every((leaf) => beforeLeaves.includes(leaf)) &&
          beforeLeaves.filter((leaf) => !afterLeaves.includes(leaf))
            .join('') === adopted[1] + adopted[2]
      })()
      if (proven) {
        return txn(doc, markerStart, item.end, insert, 'split-list-item', markerStart + insert.length)
      }
    }
  }
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
// 会话内新建、从未输入过真实正文的任务项（isLedgeredWhitespaceTaskItem——内容
// 全为不可见空白且每个 U+00A0 都有账本条目：种子的 `ascii:''` 或拼写空格的
// `ascii:' '`）走同一出口：这些字节"不代表任何内容"，对 Enter 而言该项与
// 空项等价（2026-08-21 task-Enter matrix cell 3；2026-08-22 由 seed-only 拓宽，
// 否则种子+拼写空格的项会被再次分裂、无限繁殖种子兄弟）。
// 重开文件后的 U+00A0 是作者的字节（账本为空），仍走普通分裂，绝不删除。

// 视觉空项（2026-08-22，用户报告「无法删除」）：普通（非任务）列表项的解码
// 内容若只剩不可见空白（旧构建未溶解种子存盘后的作者化 U+00A0、游离空格/
// Tab），对用户就是空项，但 item.empty 为假，结构手势全部按内容项拒绝——
// 无路可删。对显式的整项手势（Backspace/Enter），按任务种子先例把它判空：
// exitEmptyListItem 删除整个 marker 行，空白随行而去，重解析可证（内容与
// marker 同在一行——[\u00A0 \t] 不含换行，多行项由构造排除）。任务项刻意
// 排除：作者化任务种子的「绝不结构删除」doctrine 由 task-seed 套件钉死。
export const isVisuallyEmptyListItem = (text, item) => {
  if (!item || item.task || item.empty) return false
  if (!Number.isInteger(item.contentStart) || !Number.isInteger(item.end)) return false
  const content = text.slice(item.contentStart, item.end)
  return content.length > 0 && /^[\u00A0 \t]+$/.test(content)
}

// EXITING AN EMPTY QUOTE LINE (2026-08-29, user: 「引用有时候按回车是换行但是
// 有时候又能切到引用第二行，这个状态切换需要明确而不是随机触发」).
//
// It was never random — it was UNFINISHED. Measured before this command:
//   `> 引用内容`, Enter at the end   -> `> 引用内容\n>\n> ` — a new quoted
//                                       line, correct.
//   the empty quote line, Enter again -> the caret left the quote (typing
//                                       landed at top level) but the `>` and
//                                       `> ` lines STAYED, so the document
//                                       kept junk the user did not write.
//   legacy, same keys                 -> the quote is gone entirely.
// So the exit existed for the CARET and not for the BYTES, and that gap is
// what read as a random state switch.
//
// The rule is now the list's rule, stated once and true both times:
//   * Enter on a quote line WITH content -> stay in the quote, new quoted line
//   * Enter on an EMPTY quote line       -> leave the quote, and that line
//                                           goes with you
// The edit is `exitEmptyListItem`'s edit: delete from the OUTER prefix (so a
// nested quote drops one level and keeps its parent) through the line's end,
// leaving one prefix-only line for the controller's placeholder machinery.
export function exitEmptyQuoteLine({ doc, index, offset }) {
  const line = index.lineAt(offset)
  if (!line) return { ok: false, code: 'unsupported-structure' }
  // The line must be quote markers and nothing else — `>`, `> `, `> > `.
  // This is strictly stronger than the old `listItemAt(offset)` guard (a
  // quote-only line is never an item's line), and that guard actively
  // misfired: at the line-end boundary of a trailing `> ` line, listItemAt
  // still claimed the NEIGHBOURING list whose mdast span touches the
  // boundary, refusing the exit (measured 2026-08-30 — the caret then fell
  // through to split-list-item and was tossed out of the quote).
  const match = line.text.match(/^([ \t]*(?:>[ \t]*)*?)(>[ \t]*)$/)
  if (!match) return { ok: false, code: 'unsupported-structure' }
  // And the caret must be ON that line, at its content position (its end).
  if (offset < line.start || offset > line.end) return { ok: false, code: 'unsupported-structure' }
  // Walk UP through any contiguous quote-only lines: `> 甲\n>\n> ` is what
  // two Enters produce, and the `>` separator exists only to hold the line we
  // are now abandoning. Legacy removes both (measured), and leaving one behind
  // is exactly the junk that made this gesture feel unfinished.
  let firstIndex = index.lineIndexAt(line.start)
  while (firstIndex > 0) {
    const above = index.lines[firstIndex - 1]
    if (!above || !/^[ \t]*(?:>[ \t]*)*>[ \t]*$/.test(above.text)) break
    firstIndex -= 1
  }
  const firstLine = index.lines[firstIndex]
  const from = firstLine.start + match[1].length
  const to = line.end
  if (to <= from) return { ok: false, code: 'unsupported-structure' }
  const text = index.text
  const candidate = text.slice(0, from) + text.slice(to)
  let baseTree
  let candTree
  try {
    baseTree = parseKernelMarkdown(text)
    candTree = parseKernelMarkdown(candidate)
  } catch {
    return { ok: false, code: 'unsupported-structure' }
  }
  // PROVEN: the leaves are untouched (an empty quote line owns none) and the
  // document loses exactly one blockquote when the line was the whole quote,
  // or keeps its count when the quote still has content lines. Anything else
  // means the deletion reached content, and it refuses.
  const leaves = (tree) => {
    const out = []
    const walk = (node) => {
      if (typeof node?.value === 'string') out.push(node.value)
      for (const child of node?.children || []) walk(child)
    }
    walk(tree)
    return out.sort()
  }
  if (JSON.stringify(leaves(candTree)) !== JSON.stringify(leaves(baseTree))) {
    return { ok: false, code: 'unsupported-structure' }
  }
  const countQuotes = (tree) => {
    let n = 0
    const walk = (node) => {
      if (node?.type === 'blockquote') n += 1
      for (const child of node?.children || []) walk(child)
    }
    walk(tree)
    return n
  }
  const before = countQuotes(baseTree)
  const after = countQuotes(candTree)
  if (after !== before && after !== before - 1) return { ok: false, code: 'unsupported-structure' }
  return txn(doc, from, to, '', 'exit-empty-quote-line', from)
}

export function exitEmptyListItem({ doc, index, offset }) {
  const item = index.listItemAt(offset)
  if (!item) return { ok: false, code: 'unsupported-structure' }
  if (!item.empty && !isLedgeredWhitespaceTaskItem(doc, index.text, item) &&
      !isVisuallyEmptyListItem(index.text, item)) {
    return { ok: false, code: 'unsupported-structure' }
  }
  // STAGED EXIT (2026-08-30 user report). A NESTED empty item outdents one
  // level per Enter (Typora/Feishu convention) instead of jumping straight
  // to the container line — inside a quote that jump read as "one Enter
  // threw me out". The line-delete below stays the top-level answer, and
  // the fallback when the outdent cannot prove itself.
  if (item.depth > 0) {
    const outdented = outdentListItem({ doc, index, offset })
    if (outdented.ok) return outdented
  }
  const line = index.lines[item.markerLineIndex]
  const from = line.start + item.quotePrefix.length
  const to = line.end
  return txn(doc, from, to, '', 'exit-empty-list-item', from)
}
