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
  INPUT_TYPE: 'unsupported-input-type'
})
