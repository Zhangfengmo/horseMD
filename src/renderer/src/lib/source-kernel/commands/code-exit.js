// 代码块退出（Mod-Enter）：在闭栅行之后写入一个空段落的字节，让 caret 离开
// 代码块、落到新的空段落上。字节契约（source-first，与 enter.js 的分裂惯例
// 同族）：
//  - 文档末尾（闭栅行之后只剩空白）：插入 `ending + ending` —— 尾部空白行
//    游程；caret 锚在新的文档末尾（markdown.length），由 controller 侧的
//    trailing-virtual 机制（editor-kernel-projection-map.js 的尾随占位段容
//    差）给它一个可编辑的 PM 家。
//  - 文档中段（闭栅行之后还有真实内容）：插入两个空行 `ending + ending`，
//    caret 锚在第一个空行的行首 —— 一个 reparse 无法表示的空白行偏移（
//    CommonMark 折叠空行游程），由 controller 的 split-placeholder 机制物化
//    占位段。之后在占位段输入的文本 `typed + ending + ending + next` 恰好
//    解析为独立段落。
//  - 引用内（`> ```` 栅栏）文档中段：插入 `quotePrefix + ending +
//    bareQuote + ending`，caret 锚在 quotePrefix 之后 —— 输入文本成为引用内
//    的段落（`> typed`），且与后续引用内容之间隔一行 `>` 空引用行。
// 未闭合栅栏（mdast code 一直延伸到容器/文档末尾、末行不是合法闭栅）拒绝
// `unsupported-structure` —— 补栅、写字节都不做，fail-closed。
// 列表缩进内的栅栏（前缀是纯缩进而非引用标记）同样拒绝：空白行会终结列表
// 项的续行上下文，无法既保留列表结构又表达"其后的空段落"。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。

// GFM 栅栏标记：反引号或波浪号，至少 3 个同字符连续（与 code-language.js 同式）。
const FENCE_MARKER_RE = /^([`~])\1{2,}/
// 闭栅行内容（去掉容器前缀后）：同字符栅栏游程 + 可选行尾空白，别无其他。
const CLOSE_FENCE_RE = /^([`~]+)[ \t]*$/
// 纯引用前缀：可选缩进 + 一个或多个 '>'（各自可带空白）。不含 '>' 的非空前
// 缀（列表缩进）不满足此式。
const QUOTE_ONLY_PREFIX_RE = /^[ \t]*(>[ \t]*)+$/

const bareQuote = (prefix) => prefix.replace(/[ \t]+$/, '')

const unsupported = { ok: false, code: 'unsupported-structure' }

// `offset` is any raw offset the caller believes sits inside the code block
// (fence lines included) — re-derived via `index.blockAt`, same convention as
// changeCodeLanguage. mdast `math` (`$$` blocks) is NOT `code` and is refused
// here: its delimiters are not GFM fences and Crepe's preview-only rendering
// keeps it outside this command's contract.
export function exitCodeBlock({ doc, index, offset }) {
  const rawOffset = Number(offset)
  const block = Number.isFinite(rawOffset) ? index?.blockAt?.(rawOffset) : null
  if (!block || block.type !== 'code') return unsupported

  const openLine = index.lineAt(block.start)
  if (!openLine || block.start < openLine.start || block.start > openLine.end) return unsupported
  const openMatch = doc.text.slice(block.start, openLine.end).match(FENCE_MARKER_RE)
  if (!openMatch) return unsupported

  // Container prefix: everything on the open fence line before the fence
  // marker (quote markers and/or indentation) — the same derivation
  // buildCodeMap proves byte-for-byte across content lines.
  const prefix = doc.text.slice(openLine.start, block.start)
  if (prefix !== '' && !QUOTE_ONLY_PREFIX_RE.test(prefix)) return unsupported

  // Closed-fence proof: the block's LAST line must be a separate line whose
  // content (after reproducing the container prefix byte-for-byte) is a
  // fence run of the SAME character, at least as long as the open run.
  // An unclosed fence's mdast node ends on a content line (or on the open
  // line itself for '```\n'), which fails one of these checks.
  const closeLine = index.lineAt(Math.max(block.start, block.end - 1))
  if (!closeLine || closeLine.start <= openLine.start) return unsupported
  let closeContent = closeLine.text
  if (prefix) {
    if (!closeContent.startsWith(prefix)) return unsupported
    closeContent = closeContent.slice(prefix.length)
  }
  const closeMatch = closeContent.match(CLOSE_FENCE_RE)
  if (!closeMatch) return unsupported
  if (closeMatch[1][0] !== openMatch[0][0] || closeMatch[1].length < openMatch[0].length) {
    return unsupported
  }

  // Insertion point: right after the close fence line INCLUDING its
  // terminator (at EOF-without-terminator this is simply the line end).
  const insertPos = closeLine.end + closeLine.ending.length
  const ending = closeLine.ending || openLine.ending || index.dominantEnding
  const restAfter = doc.text.slice(insertPos)

  let insert
  let caret
  if (!restAfter.trim()) {
    // Document end (only blank bytes after the fence): extend the trailing
    // blank run; the caret's home is the NEW document end, which the
    // trailing-virtual machinery maps without any voucher.
    insert = ending + ending
    caret = doc.text.length + insert.length
  } else if (prefix) {
    // Mid-quote: a quoted caret line ('> ') then a bare quote blank line
    // ('>') separating it from the following quoted content.
    insert = prefix + ending + bareQuote(prefix) + ending
    caret = insertPos + prefix.length
  } else {
    // Mid-document: caret line first, then the blank line that keeps the
    // following block a separate paragraph once text is typed.
    insert = ending + ending
    caret = insertPos
  }

  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      from: insertPos,
      to: insertPos,
      insert,
      intent: 'exit-code-block',
      selection: { anchor: caret, head: caret }
    }
  }
}
