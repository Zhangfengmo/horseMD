// 结构路由：把「结构性按键 + 光标位置」映射到具体的源码命令，或声明
// { ok:false, code:'not-structural' }（该按键在此位置只是普通文本编辑，调用
// 方应改走 replace-text 的字符级路径——not-structural 不是错误，是"用文本
// 路径"的信号）。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
import { splitTextBlock, splitListItem, exitEmptyListItem, resolveBlock } from './commands/enter.js'
import { indentListItem, outdentListItem } from './commands/indent.js'
import { liftEmptyListItem, joinParagraphBackward } from './commands/delete.js'
import { splitsCrlfPair } from './character-map.js'

const NOT_STRUCTURAL = { ok: false, code: 'not-structural' }

// ctx: { doc, index, offset, empty? }. `empty`（选区是否折叠）当前决策表未
// 消费任何分支——只是为了签名与调用方（未来可能传入选区状态）保持前向兼
// 容而接受，不在本任务的路由逻辑里判断。
export function routeStructuralKey(key, ctx) {
  const { index, offset } = ctx
  // CRLF bisection, refused at the DOOR of the whole structural family
  // (2026-08-17 review, Critical 3). `applySourceTransaction` enforces the
  // same rule by construction for every write, but a command that routes
  // "successfully" and then produces a transaction nothing can ever apply is
  // a worse contract than one that says no up front — and this is the exact
  // shape the review probed: 'one\r\ntwo three\r\n' at raw offset 4 answered
  // `ok` for Enter and committed a lone CR plus a bare LF.
  //
  // Every branch below resolves blocks/items/lines FROM `offset`, so one
  // check at the top covers Enter / Tab / Shift-Tab / Backspace / Delete
  // together.
  //
  // CONTRACT CHANGE, stated rather than implied (re-review Minor #4): at this
  // one offset Backspace and Delete used to answer `not-structural` — a
  // "use the text path" signal, which `structuralHandler` turns into `return
  // false` so ProseMirror produces its own deletion transaction, which the
  // gateway's plain-text path then refuses via its own `bisectsLineEnding`
  // guard. They now answer `unsupported-structure`, which the handler
  // swallows with a toast. The BYTES are identical either way (both end in
  // zero writes); what changes is that the refusal is now immediate and
  // visible instead of arriving one layer down. That is the intended posture
  // — `not-structural` claims "this is ordinary text editing here", which is
  // false at an offset no text edit may target either.
  if (splitsCrlfPair(index.text, offset)) return { ok: false, code: 'unsupported-structure' }
  const item = index.listItemAt(offset)
  switch (key) {
    case 'Enter':
      if (item) return item.empty ? exitEmptyListItem(ctx) : splitListItem(ctx)
      return splitTextBlock(ctx)
    case 'Tab':
      return item ? indentListItem(ctx) : NOT_STRUCTURAL
    case 'Shift-Tab':
      return item ? outdentListItem(ctx) : NOT_STRUCTURAL
    case 'Backspace': {
      if (item?.empty) return liftEmptyListItem(ctx)
      const block = index.blockAt(offset)
      if (block && offset === block.start && !item) return joinParagraphBackward(ctx)
      return NOT_STRUCTURAL
    }
    case 'Delete': {
      // Delete with the caret inside a list item is a phase-1 text-path case
      // (mirrors the Backspace branch's `!item` guard on the caret side).
      // Without this, `resolveBlock`/`blockAt` below can't tell a list
      // item's own paragraph child from a top-level paragraph — Delete at
      // the end of a list item's text (e.g. '- 甲\n\n乙\n', caret right after
      // "甲") would resolve that paragraph as `block`, find "乙" as the next
      // paragraph, and absorb it into the list item as a lazy continuation
      // line. `joinParagraphBackward`'s own list-item guard (delete.js) is
      // the second net for the few paths that could still reach it via a
      // future caller, but this check keeps the common case from ever
      // starting the forward scan.
      if (item) return NOT_STRUCTURAL
      // offset === block.end 要用 resolveBlock 而非裸 blockAt：blockAt 是
      // exclusive-end，caret 恰好停在段落最后一个字符之后（下一行终止符之
      // 前——Delete 最常见的触发位置）时，直接探测在该偏移处会落空。
      const block = resolveBlock(index, offset)
      if (!block || block.type !== 'paragraph' || offset !== block.end) {
        return NOT_STRUCTURAL
      }
      // 下一个块：从 block.end 起逐字符向后探测，穿过任意宽度的块间空隙，
      // 找到第一个"包含该偏移"的块——与 joinParagraphBackward 的反向扫描
      // 对称，同样不依赖固定间隙长度假设。
      let next = null
      for (let at = block.end; at < index.text.length; at += 1) {
        const candidate = index.blockAt(at)
        if (candidate) { next = candidate; break }
      }
      if (!next || next.type !== 'paragraph') return NOT_STRUCTURAL
      // 委托给同一份合并逻辑：以下一段的起点为「Backspace 发生的位置」，
      // 语义上等价于在下一段段首按 Backspace。
      return joinParagraphBackward({ ...ctx, offset: next.start })
    }
    default:
      return NOT_STRUCTURAL
  }
}
