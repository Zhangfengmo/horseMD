// source-kernel 聚合导出：源码事务内核对外的唯一入口。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
export { createMarkdownDocument, applySourceTransaction } from './markdown-document.js'
export { buildSyntaxIndex, scanLines, parseKernelMarkdown } from './syntax-index.js'
export { buildCharacterMap, bisectsLineEnding } from './character-map.js'
export { buildCodeMap } from './code-map.js'
export { inlineMarkAt, markerFor, rangeFromInlineCode } from './mark-map.js'
export { toggleInlineMark } from './commands/mark-toggle.js'
export { replaceVisibleText } from './commands/replace-text.js'
export { toggleTaskMarker } from './commands/task-toggle.js'
export { changeCodeLanguage } from './commands/code-language.js'
export { setImageAttrs } from './commands/image-attrs.js'
export { applyLinkEdit } from './commands/link-toggle.js'
export { exitCodeBlock } from './commands/code-exit.js'
export { splitTextBlock, splitListItem, exitEmptyListItem } from './commands/enter.js'
export { indentListItem, outdentListItem } from './commands/indent.js'
export { toggleBlockquote } from './commands/quote-toggle.js'
export { setBlockTypeFromQuery, BLOCK_TYPE_MARKERS } from './commands/block-type.js'
export { insertBlockFromQuery, BLOCK_INSERT_TARGETS } from './commands/block-insert.js'
export { liftEmptyListItem, joinParagraphBackward } from './commands/delete.js'
export {
  insertHeadingLeadingWhitespace,
  looksLikeAtxContentStart,
  HEADING_LEADING_WHITESPACE_TEXT
} from './commands/heading-whitespace.js'
export {
  spellBlockTailInsert,
  spellBlockTailDelete,
  literalTailIsStripped,
  healableTrailingSpace,
  blockEditIsObservable,
  isOneContiguousReplacement,
  blockText,
  BLOCK_TRAILING_TEXT,
  NO_BREAK_SPACE
} from './commands/trailing-whitespace.js'
export {
  spellLineStartWhitespace,
  looksLikeBlockLineStart,
  healableLineStartRun
} from './commands/line-start-whitespace.js'
export { dissolvableTaskSeed, spellTaskSeedInsert, taskSeedDeleteRefusal } from './commands/task-seed.js'
export { spellMarkerCompletingSpace, spellMarkerRunGrowth, spellMarkerFollowingText } from './commands/marker-space.js'
export { trimTrailingBlankLines } from './commands/trailing-placeholder.js'
export {
  proveContentDelete,
  deleteClearsBlockLine,
  editsClearBlockLine,
  editsStrandBlockTail,
  proveBatchDelete
} from './commands/content-delete.js'
export { spellEmptyCodeInsert, EMPTY_VERBATIM_BLOCK_TYPES } from './commands/empty-code-insert.js'
export { routeStructuralKey } from './router.js'
export { createSourceHistory } from './history.js'

// Error codes shared by kernel-mode integration (Plan 2): the pure kernel
// (this directory) stays free of Electron/React/@milkdown imports, but its
// callers (ProjectionMap, dispatch veto, Gateway, ProjectionReconciler, …)
// need a single, frozen vocabulary for why a request was refused so every
// layer fails closed the same way instead of inventing ad-hoc strings.
export const KERNEL_CODES = Object.freeze({
  STALE: 'stale-revision',
  INVALID: 'invalid-range',
  UNMAPPED: 'unmapped-selection',
  UNSUPPORTED: 'unsupported-structure',
  NOT_STRUCTURAL: 'not-structural',
  PROJECTION: 'projection-mismatch',
  INPUT_TYPE: 'unsupported-input-type',
  // A structural edit whose BYTES are legal but whose reparse yields a
  // different document than the command intended (commands/indent.js).
  RESTRUCTURE: 'would-restructure-document',
  EMPTY_ITEM_HEADING: 'empty-item-would-become-heading',
  // A caret-after block insert (/divider, /image) whose following block
  // cannot host the caret (commands/block-insert.js `caretAfterInsert`). Has
  // its own message because the refusal has a concrete, nameable remedy.
  NO_CARET_HOME: 'no-caret-home-after-insert',
  // `/text` on a block that cannot be emptied where it stands
  // (commands/block-insert.js `revertMidDocument`): removing it would let the
  // blocks around it merge, or a character typed in the gap it leaves would
  // join a neighbour instead of starting its own paragraph. Its own code
  // because the remedy is concrete and nameable. (This REPLACED
  // `text-needs-document-end`, the 2026-08-20 stopgap that refused every
  // mid-document `/text`; mid-document works since 2026-08-21.)
  TEXT_NEIGHBORS_MERGE: 'text-neighbors-would-merge',
  // A delete that removes the ledger-vouched `/task` seed and leaves the
  // task paragraph contentless (commands/task-seed.js
  // `taskSeedDeleteRefusal`): no byte spelling of an empty task exists, so
  // the refusal names its two real exits (undo / type the label).
  EMPTY_TASK: 'empty-task-unrepresentable',
  // Delete OR Backspace at a heading's first content character. Diagnosed
  // 2026-08-21 by dumping the transaction (editor-kernel-gateway.js
  // `describeUnclassified`): this key is not a deletion at all —
  // @milkdown/preset-commonmark binds `DowngradeHeading` to BOTH keys at
  // `parentOffset === 0`, so ProseMirror produces a structural
  // `ReplaceAroundStep` that turns H2 into H1 or H1 into a paragraph, and no
  // character is ever removed. The kernel has no byte command for that
  // marker rewrite yet, so it refuses — but with its own message, because the
  // generic "not supported yet" describes the wrong gesture entirely and
  // hides two real remedies. Was the anonymous half of `INPUT_TYPE`; the
  // 2026-08-19 write-path pass deferred it as "needs the app instrumented to
  // dump tr.steps".
  HEADING_DEMOTE: 'heading-demote-unsupported'
})
