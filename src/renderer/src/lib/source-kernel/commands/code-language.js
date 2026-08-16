// 代码块语言切换：替换开栅行的 info string（fence 标记之后到行尾的整段），
// 保留 fence 标记字符/个数与其前的引用/缩进前缀，不做 meta 保留（简单契约 —
// 换语言即丢弃旧的 meta，如需要保留 meta 属未来需求）。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。

// GFM 栅栏标记：反引号或波浪号，至少 3 个同字符连续。
const FENCE_MARKER_RE = /^([`~])\1{2,}/

// `offset` is any raw offset the caller believes sits inside the code
// block (its own fence line included) — this command re-derives the block
// via `index.blockAt`, exactly like every other command in this directory
// re-derives structure from `index`/`offset` rather than trusting a
// caller-supplied node. A non-`code` block (or no block at all) at that
// offset is refused, not guessed at.
export function changeCodeLanguage({ doc, index, offset, language }) {
  const rawOffset = Number(offset)
  const block = Number.isFinite(rawOffset) ? index?.blockAt?.(rawOffset) : null
  if (!block || block.type !== 'code') return { ok: false, code: 'unsupported-structure' }

  const lang = String(language ?? '')
  // GFM's info string is whitespace-delimited (the first token is `lang`,
  // anything after the first run of spaces is `meta`) — a language containing
  // whitespace can't round-trip through that grammar as a single token, so
  // refuse rather than silently splitting it into lang+meta.
  if (/\s/.test(lang)) return { ok: false, code: 'unsupported-structure' }

  const line = index.lineAt(block.start)
  if (!line || block.start < line.start || block.start > line.end) {
    return { ok: false, code: 'unsupported-structure' }
  }
  const markerMatch = doc.text.slice(block.start, line.end).match(FENCE_MARKER_RE)
  if (!markerMatch) return { ok: false, code: 'unsupported-structure' }

  // Fail-closed fence guard: a backtick-fenced block's info string may not
  // contain a backtick (CommonMark's own restriction — a backtick there
  // would be ambiguous with an inline code span and, verified against the
  // real parser, silently un-fences the whole block: `'```js`ts\nabc\n```\n'`
  // reparses as a paragraph followed by an EMPTY, unrelated code block, not
  // a `js\`ts`-language fence). A tilde-fenced block's info string is NOT
  // restricted the same way by the spec (verified against the real parser:
  // both a tilde in a tilde-fenced info string and either marker char in the
  // OTHER fence type's info string reparse to the exact same lang/value —
  // `'~~~js~ts\nabc\n~~~\n'` and `'```js~ts\nabc\n```\n'` both round-trip
  // correctly), so only the marker char matching THIS block's own fence type
  // is refused, not the other one.
  const fenceMarker = markerMatch[1]
  if (lang.includes(fenceMarker)) return { ok: false, code: 'unsupported-structure' }

  const markerEnd = block.start + markerMatch[0].length
  const infoEnd = line.end
  const removedLength = infoEnd - markerEnd
  const delta = lang.length - removedLength

  // Selection stays anchored to wherever the caller's `offset` conceptually
  // sits, clamped through the edit like any other kernel command:
  //  - at/before the marker's own end (never inside the removed info
  //    segment from the caller's own perspective) -> unchanged.
  //  - inside the removed info segment itself -> clamp to right after the
  //    new language token (the segment it was inside no longer exists).
  //  - at/after the line's own end (the common case: a caret parked in the
  //    code CONTENT, past the whole fence line) -> shift by the edit's
  //    delta, same arithmetic every other command here uses.
  let selection = rawOffset
  if (rawOffset > markerEnd && rawOffset < infoEnd) selection = markerEnd + lang.length
  else if (rawOffset >= infoEnd) selection = rawOffset + delta

  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      from: markerEnd,
      to: infoEnd,
      insert: lang,
      intent: 'code-language',
      selection: { anchor: selection, head: selection }
    }
  }
}
