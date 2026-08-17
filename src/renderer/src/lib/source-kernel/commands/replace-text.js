// 字符级替换：把一段可见区间的内容换成给定文本，边界一律由 charMap 证明。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
import { bisectsLineEnding } from '../character-map.js'

export function replaceVisibleText({ doc, map, visFrom, visTo, insert, intent = 'insert-text' }) {
  const range = map?.rawRangeForVisibleRange(visFrom, visTo)
  if (!range) return { ok: false, code: 'unmapped-selection' }
  // CRLF bisection (2026-08-17 review, Critical 3): a resolved boundary
  // sitting strictly between a '\r' and its '\n' would split ONE line ending
  // into a lone CR plus a bare LF. `applySourceTransaction` refuses the same
  // write by construction; stating it here gives the caller the precise code
  // instead of a generic invalid-range from one layer down.
  if (bisectsLineEnding(map, doc?.text, range.from) ||
      bisectsLineEnding(map, doc?.text, range.to)) {
    return { ok: false, code: 'unmapped-selection' }
  }
  const text = String(insert ?? '')
  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      from: range.from,
      to: range.to,
      insert: text,
      intent,
      selection: { anchor: range.from + text.length, head: range.from + text.length }
    }
  }
}
