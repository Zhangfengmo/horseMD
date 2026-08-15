// source-kernel 聚合导出：源码事务内核对外的唯一入口。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
export { createMarkdownDocument, applySourceTransaction } from './markdown-document.js'
export { buildSyntaxIndex, scanLines } from './syntax-index.js'
export { buildCharacterMap } from './character-map.js'
export { replaceVisibleText } from './commands/replace-text.js'
export { toggleTaskMarker } from './commands/task-toggle.js'
export { splitTextBlock, splitListItem, exitEmptyListItem } from './commands/enter.js'
export { indentListItem, outdentListItem } from './commands/indent.js'
export { liftEmptyListItem, joinParagraphBackward } from './commands/delete.js'
export { routeStructuralKey } from './router.js'
export { createSourceHistory } from './history.js'
