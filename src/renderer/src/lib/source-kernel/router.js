// 结构路由：把「结构性按键 + 光标位置」映射到具体的源码命令，或声明
// { ok:false, code:'not-structural' }（该按键在此位置只是普通文本编辑，调用
// 方应改走 replace-text 的字符级路径——not-structural 不是错误，是"用文本
// 路径"的信号）。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
import { splitTextBlock, splitListItem, exitEmptyListItem, resolveBlock } from './commands/enter.js'
import { indentListItem, outdentListItem } from './commands/indent.js'
import { liftEmptyListItem, joinParagraphBackward } from './commands/delete.js'

const NOT_STRUCTURAL = { ok: false, code: 'not-structural' }

// ctx: { doc, index, offset, empty? }. `empty`（选区是否折叠）当前决策表未
// 消费任何分支——只是为了签名与调用方（未来可能传入选区状态）保持前向兼
// 容而接受，不在本任务的路由逻辑里判断。
export function routeStructuralKey(key, ctx) {
  const { index, offset } = ctx
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
