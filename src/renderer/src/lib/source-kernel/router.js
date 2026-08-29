// 结构路由：把「结构性按键 + 光标位置」映射到具体的源码命令，或声明
// { ok:false, code:'not-structural' }（该按键在此位置只是普通文本编辑，调用
// 方应改走 replace-text 的字符级路径——not-structural 不是错误，是"用文本
// 路径"的信号）。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
import { splitTextBlock, splitListItem, exitEmptyListItem, exitEmptyQuoteLine, resolveBlock, isVisuallyEmptyListItem } from './commands/enter.js'
import { indentListItem, outdentListItem } from './commands/indent.js'
import { liftEmptyListItem, joinParagraphBackward } from './commands/delete.js'
import { isLedgeredWhitespaceTaskItem } from './commands/task-seed.js'
import { deleteEmptyBlockquote, unwrapBlockquoteAtContentStart } from './commands/quote-toggle.js'
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
  // CONTRACT CHANGE, stated rather than implied (re-review Minor #4). The
  // guard sits at the TOP of this function, so at this one offset it changes
  // the answer for THREE of the five keys, not just the delete pair:
  //  * Backspace / Delete used to answer `not-structural` — a "use the text
  //    path" signal, which `structuralHandler` turns into `return false` so
  //    ProseMirror produces its own deletion transaction, which the gateway's
  //    plain-text path then refuses via its own `bisectsLineEnding` guard.
  //    Now they refuse here, one layer earlier.
  //  * Tab outside a list used to answer `not-structural` too, which the
  //    handler turns into `insertPlainTextAtSelection('\t')` — that path is
  //    itself guarded now (replace-text.js), so it also ended in a refusal,
  //    just later.
  //  * Shift-Tab outside a list used to be swallowed SILENTLY (`return true`,
  //    no message). It now produces a toast. This is the one user-visible
  //    difference, and it is the intended one.
  // The BYTES are identical in every case (all of them end in zero writes);
  // what changes is that the refusal is immediate and visible instead of
  // arriving one layer down or not at all. `not-structural` asserts "this is
  // ordinary text editing here", which is false at an offset no text edit may
  // target either.
  if (splitsCrlfPair(index.text, offset)) return { ok: false, code: 'unsupported-structure' }
  const item = index.listItemAt(offset)
  switch (key) {
    case 'Enter':
      // A session-created `/task`/split seed the user never labelled is
      // EFFECTIVELY empty for Enter (the U+00A0 stands for NO keystroke —
      // task-seed.js `isLedgeredWhitespaceTaskItem`), so it takes the same
      // lift-out exit a plain empty item takes (2026-08-21 task-Enter
      // matrix cell 3). The check is LEDGER-gated: a reopened file's U+00A0
      // is the author's byte, the item has real content, and Enter splits —
      // never deletes — exactly as the 2026-08-20 audit pinned. Backspace
      // takes the SAME ledger-gated exit since 2026-08-22 (see its branch
      // below) — an earlier note here argued it must not, but that reasoning
      // was about the CHARACTER-delete the text path produces (which demotes
      // to `- [ ] ` and is the empty-task wall's refusal), not about routing
      // the key structurally, which deletes the whole representable line.
      if (item) {
        return item.empty || isLedgeredWhitespaceTaskItem(ctx.doc, index.text, item) ||
          isVisuallyEmptyListItem(index.text, item)
          ? exitEmptyListItem(ctx)
          : splitListItem(ctx)
      }
      // An EMPTY quote line takes the list's exit, for the list's reason: the
      // only other answer is a second empty quoted line, and the user pressing
      // Enter on a blank quote line is leaving the quote. See
      // `exitEmptyQuoteLine` for the measured before/after.
      {
        const quoteExit = exitEmptyQuoteLine(ctx)
        if (quoteExit.ok) return quoteExit
      }
      return splitTextBlock(ctx)
    case 'Tab':
      return item ? indentListItem(ctx) : NOT_STRUCTURAL
    case 'Shift-Tab':
      return item ? outdentListItem(ctx) : NOT_STRUCTURAL
    case 'Backspace': {
      // A session-ledgered, never-labelled seed item is EFFECTIVELY empty
      // for Backspace by the same doctrine as Enter above (2026-08-22 user
      // report: the user was culling the item, and the only text-path
      // outcome — deleting the seed character — is the empty-task wall's
      // refusal, a dead end whose exits were Enter or undo). Routing the
      // key structurally deletes/outdents the whole marker LINE, which is
      // representable, and stays ledger-gated: a reopened file's U+00A0 is
      // the author's content and keeps the text-path answer.
      //
      // Unlike Enter, the whole-line exit claims the task item only at ONE
      // remaining character: Backspace is a per-keystroke gesture, and on a
      // WIDER session-whitespace label (seed + a spelled space) the text
      // path's single-character deletion still lands on a representable
      // task (`- [ ] ` + seed), so the finer gesture must win — type a
      // space, Backspace, and you are back on the seed, not minus the whole
      // item. Only the last character has no deletable spelling (removing
      // it demotes the checkbox), so only there does the key route to the
      // line exit.
      if (item?.empty ||
          (isLedgeredWhitespaceTaskItem(ctx.doc, index.text, item) &&
            item.end - item.contentStart === 1) ||
          isVisuallyEmptyListItem(index.text, item)) {
        return liftEmptyListItem(ctx)
      }
      // BLOCKQUOTE (2026-08-28, 「引用要求参照代码一样要支持删除」). Asked
      // before joinParagraphBackward: an empty quote is deleted whole (the
      // empty-code-block twin) and a quote's content start unwraps one level.
      // Both refuse for any other position, so the paragraph join keeps every
      // case it owned. List items keep their own branch above — a quote
      // inside a list item is not proven here.
      if (!item) {
        const emptyQuote = deleteEmptyBlockquote(ctx)
        if (emptyQuote.ok) return emptyQuote
        const unwrapped = unwrapBlockquoteAtContentStart(ctx)
        if (unwrapped.ok) return unwrapped
      }
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
