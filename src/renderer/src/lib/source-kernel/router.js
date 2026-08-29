// 结构路由：把「结构性按键 + 光标位置」映射到具体的源码命令，或声明
// { ok:false, code:'not-structural' }（该按键在此位置只是普通文本编辑，调用
// 方应改走 replace-text 的字符级路径——not-structural 不是错误，是"用文本
// 路径"的信号）。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
import { splitTextBlock, splitListItem, exitEmptyListItem, exitEmptyQuoteLine, resolveBlock, isVisuallyEmptyListItem } from './commands/enter.js'
import { indentListItem, outdentListItem } from './commands/indent.js'
import { liftEmptyListItem, joinParagraphBackward, liftListItemToParagraph } from './commands/delete.js'
import { isLedgeredWhitespaceTaskItem } from './commands/task-seed.js'
import { deleteEmptyBlockquote, unwrapBlockquoteAtContentStart } from './commands/quote-toggle.js'
import { insertTableCellBreak } from './commands/table-ops.js'
import { splitsCrlfPair } from './character-map.js'

const NOT_STRUCTURAL = { ok: false, code: 'not-structural' }
// "This key has nothing to do HERE, and that is not an error." Distinct from
// not-structural (which sends the key to the text path, where Tab would write
// a literal tab) and from a refusal (which toasts). Added 2026-08-29 for the
// matrix sweep's noise: Shift-Tab on a top-level item and Tab on a list's
// first item both raised 「无效操作」 for gestures whose correct answer is
// simply nothing — the user asked for the state machine to be definite, and a
// toast on a no-op is the opposite of definite.
const SILENT_NO_OP = { ok: false, code: 'silent-no-op' }

// The AUTHORED-SEED DOCTRINE's shape (pinned twice in
// test-source-kernel-commands): an item whose content begins with an
// unledgered U+00A0 is CONTENT, and the whole-item structural gestures must
// leave it to the text path. The content-start lift added 2026-08-29 is such a
// gesture, so it defers here — the doctrine is older than the gesture.
const startsWithAuthoredNbsp = (index, item) =>
  Number.isInteger(item?.contentStart) && index.text[item.contentStart] === '\u00A0'

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
      // Inside a TABLE CELL, Enter is the editor's own `<br>` convention
      // (commands/table-ops.js `insertTableCellBreak`) — GFM cells are
      // single-line, so that is the only break they can hold.
      {
        const cellBreak = insertTableCellBreak(ctx)
        if (cellBreak.ok) return cellBreak
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
    case 'Tab': {
      if (!item) return NOT_STRUCTURAL
      const indented = indentListItem(ctx)
      if (indented.ok) return indented
      // Only the bare "nothing to nest under" answer (a FIRST item — the
      // generic unsupported-structure) is a no-op. The NAMED protective
      // refusals (empty-item-would-become-heading, would-restructure-document)
      // keep their own toasts: collapsing them too silenced deliberately
      // didactic messages (2026-08-30 branch review, confirmed twice).
      return indented.code === 'unsupported-structure' ? SILENT_NO_OP : indented
    }
    case 'Shift-Tab': {
      if (!item) return NOT_STRUCTURAL
      const outdented = outdentListItem(ctx)
      if (outdented.ok) return outdented
      // Same rule: a TOP-LEVEL item's generic refusal is a no-op; anything
      // named passes through.
      return outdented.code === 'unsupported-structure' ? SILENT_NO_OP : outdented
    }
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
      // Backspace at a NON-empty item's content start: outdent a nested item
      // one level (the Shift-Tab answer, which is what every editor gives that
      // caret), and lift a top-level item out of the list. Measured before
      // this: the kernel refused, while legacy lifted — see
      // `liftListItemToParagraph`.
      if (item && offset === item.contentStart && !startsWithAuthoredNbsp(index, item)) {
        const outdented = outdentListItem(ctx)
        if (outdented.ok) return outdented
        const lifted = liftListItemToParagraph(ctx)
        if (lifted.ok) return lifted
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
      if (block && offset === block.start && !item) {
        // Nothing above to join into — the caret is at the document's first
        // block. Backspace there does nothing, and saying so with a toast is
        // the noise the matrix sweep was looking for (measured at a real
        // document's HEAD anchor).
        let hasPrevious = false
        for (let at = block.start - 1; at >= 0; at -= 1) {
          if (index.blockAt(at)) { hasPrevious = true; break }
        }
        if (!hasPrevious) return SILENT_NO_OP
        return joinParagraphBackward(ctx)
      }
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
      // Delete at a list item's CONTENT START is the same gesture Backspace
      // answers there (legacy gives both keys the same answer — measured:
      // `- 甲\n- 乙` with the caret before 乙 becomes `- 甲\n\n  乙` for
      // either key). Matching it keeps a tab's behaviour identical whichever
      // mode it is in, which is worth more here than the Word-style
      // "delete the next character" reading.
      if (item && offset === item.contentStart && !startsWithAuthoredNbsp(index, item)) {
        const outdented = outdentListItem(ctx)
        if (outdented.ok) return outdented
        const lifted = liftListItemToParagraph(ctx)
        if (lifted.ok) return lifted
      }
      // DELETE IS BACKSPACE'S MIRROR (2026-08-29 matrix sweep). Both keys mean
      // "close the seam next to me", and the seam is the same one — so the
      // caret's own block may be a LIST ITEM's paragraph or a HEADING here,
      // not only a top-level paragraph. Measured before this: Delete at the
      // end of `- 乙` or of `## 中间标题` refused, while Backspace at the start
      // of the paragraph below joined them. The delegation below is what makes
      // the two keys ONE rule: the join is always judged at the NEXT block's
      // start, by the same command, with the same proof.
      //
      // The old `if (item) return NOT_STRUCTURAL` bail existed because
      // `resolveBlock` cannot tell a list item's own paragraph from a
      // top-level one, and the forward scan would then absorb prose into the
      // item WITHOUT proof. The proof now exists (delete.js
      // `joinIntoContainerLastLine`, added 2026-08-28), so the guard is no
      // longer the thing standing between this gesture and a wrong byte —
      // and a caret that is NOT at its block's end still returns
      // not-structural, exactly as before.
      const block = resolveBlock(index, offset)
      if (!block || (block.type !== 'paragraph' && block.type !== 'heading') || offset !== block.end) {
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
