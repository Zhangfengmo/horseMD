import {
  sourceRawFromVisibleIndex
} from '../../mode-visible-map.js'
import { LEADING_SPACE_SENTINEL } from '../markdown-leading-space.js'
import { markdownComparisonKey } from './roundtrip.js'

export const commonChange = (previous, next) => {
  let start = 0
  const min = Math.min(previous.length, next.length)
  while (start < min && previous[start] === next[start]) start++

  let previousEnd = previous.length
  let nextEnd = next.length
  while (previousEnd > start && nextEnd > start && previous[previousEnd - 1] === next[nextEnd - 1]) {
    previousEnd--
    nextEnd--
  }
  return { start, previousEnd, nextEnd }
}

export const rawOffsetAtVisible = (markdown, position) =>
  sourceRawFromVisibleIndex(markdown, position.visibleIndex, position.visibleAffinity)

export const lineAt = (markdown, offset) => {
  const safe = Math.max(0, Math.min(offset, markdown.length))
  const start = markdown.lastIndexOf('\n', Math.max(0, safe - 1)) + 1
  const next = markdown.indexOf('\n', safe)
  return { start, end: next < 0 ? markdown.length : next }
}

export const rawInsertionAtCanonicalLineEnd = ({
  source,
  previous,
  canonicalOffset,
  mappedSourceOffset,
  sourceVisibleMap
}) => {
  const previousLine = lineAt(previous, canonicalOffset)
  if (canonicalOffset !== previousLine.end) return null
  // An EMPTY canonical line satisfies both "line end" and "line start". It is
  // a block boundary, not the tail of authored text, so the insertion belongs
  // on its own line — mapping it to the end of the previous source line glued
  // the inserted block onto that line. Leave it to the line-start mapping.
  if (
    previousLine.start === previousLine.end &&
    canonicalOffset > 0 &&
    /[\r\n]/.test(previous[canonicalOffset - 1] || '')
  ) return null

  const sourceLine = lineAt(source, mappedSourceOffset)
  const hiddenTail = source.slice(mappedSourceOffset, sourceLine.end)
  let low = 0
  let high = sourceVisibleMap.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (sourceVisibleMap[middle] < mappedSourceOffset) low = middle + 1
    else high = middle
  }
  if (sourceVisibleMap[low] < sourceLine.end) return null

  // Inline closers (``, **, ~~ and closing HTML) are not part of the visible
  // stream. At a line end the generic backward mapping lands before them.
  // Advance past syntax, but stay before authored hard-break whitespace.
  const trailingWhitespace = hiddenTail.match(/[ \t]*$/)?.[0] || ''
  return sourceLine.end - trailingWhitespace.length
}

const PREFIX_TOKENS = {
  quote: /^[ \t]*>[ \t]?/,
  list: /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+/,
  task: /^\[[ xX]\][ \t]+/,
  heading: /^[ \t]*#{1,6}[ \t]+/
}

const prefixTokenKinds = (text) => {
  const kinds = []
  let rest = String(text || '')
  for (;;) {
    const kind = Object.keys(PREFIX_TOKENS).find((name) => PREFIX_TOKENS[name].test(rest))
    if (!kind) return kinds
    rest = rest.slice(rest.match(PREFIX_TOKENS[kind])[0].length)
    kinds.push(kind)
  }
}

// The number of visible characters that lie strictly before a raw offset.
const visibleCountBefore = (map, offset) => {
  let low = 0
  let high = map.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (map[middle] < offset) low = middle + 1
    else high = middle
  }
  return low
}

// A canonical offset that falls BETWEEN two visible characters has no unique
// visible position: line endings, quote prefixes and list markers carry no
// visible text at all. The backward mapping therefore always lands at the
// START of that gap — the end of the previous block's text — so an inserted
// BLOCK is glued onto that text (`> 段落新段` instead of `> 段落\n>\n> 新段`).
//
// The gap itself is the structure. Reproduce the canonical's own place inside
// it: cross the same number of line endings, then skip the source block's own
// prefix exactly when the canonical skipped its own. This replaces guessing
// with the one fact both sides agree on — how many block boundaries the
// insertion point sits past.
export const rawOffsetInCanonicalGap = ({
  source,
  previous,
  canonicalOffset,
  previousVisibleMap,
  mappedSourceOffset,
  sourceVisibleMap
}) => {
  const visibleIndex = visibleCountBefore(previousVisibleMap, canonicalOffset)
  const canonicalGapStart = visibleIndex > 0 ? previousVisibleMap[visibleIndex - 1] + 1 : 0
  if (canonicalOffset < canonicalGapStart) return null
  const canonicalGap = previous.slice(canonicalGapStart, canonicalOffset)
  // No block boundary crossed: the offset is inside one line's own syntax and
  // the generic visible mapping already resolved it.
  if (!/\r\n|\n|\r/.test(canonicalGap)) return null

  if (visibleIndex >= sourceVisibleMap.length) return null
  const sourceGapEnd = sourceVisibleMap[visibleIndex]
  if (!(mappedSourceOffset <= sourceGapEnd)) return null

  // Whatever the canonical consumed AFTER its last line ending is block prefix
  // (`> `, `- `, `[ ] `, `## `). Its emptiness says which side of the gap owns
  // the offset — and that is the whole decision:
  const canonicalTail = canonicalGap.slice(
    canonicalGap.search(/(?:\r\n|\n|\r)(?![^]*(?:\r\n|\n|\r))/) + 1
  )

  if (!canonicalTail) {
    // Nothing consumed: the offset sits ON a line boundary, so it belongs to
    // the run of boundaries itself. Cross the same number the canonical did,
    // clamped to what the source's own spacing offers.
    const lineEndings = (canonicalGap.match(/\r\n|\n|\r/g) || []).length
    let at = mappedSourceOffset
    let crossed = 0
    while (at < sourceGapEnd && crossed < lineEndings) {
      if (source[at] === '\r') at += 1
      if (source[at] === '\n') { at += 1; crossed += 1; continue }
      at += 1
    }
    return crossed ? at : null
  }

  // Something consumed: the offset is inside the prefix of the block the gap
  // ENDS in. Anchor on that block's line — never on a count of blank lines,
  // because the author's spacing and the serializer's differ freely (`>\n>`
  // vs `>`) and counting from the gap's start drifts by exactly that
  // difference. Then consume the same prefix KINDS: the spelling may differ
  // (`*` vs `-`, `1.` vs `1)`) but the structure cannot. A mismatch means the
  // two sides do not describe the same block here, so decline rather than guess.
  const lineStart = source.lastIndexOf('\n', Math.max(0, sourceGapEnd - 1)) + 1
  if (lineStart < mappedSourceOffset) return null
  let at = lineStart
  for (const kind of prefixTokenKinds(canonicalTail)) {
    const matched = source.slice(at, sourceGapEnd).match(PREFIX_TOKENS[kind])
    if (!matched) return null
    at += matched[0].length
  }
  return at
}

export const lineEndingNear = (markdown, offset = 0) => {
  const next = markdown.indexOf('\n', Math.max(0, offset))
  if (next >= 0) return markdown[next - 1] === '\r' ? '\r\n' : '\n'
  const previous = markdown.lastIndexOf('\n', Math.max(0, offset - 1))
  if (previous >= 0) return markdown[previous - 1] === '\r' ? '\r\n' : '\n'
  return markdown.includes('\r\n') ? '\r\n' : '\n'
}

// remark-stringify 为保住 round-trip 语义会对部分字符做序列化转义：
//   - `&#x20;`：行首第一个空格（直接输出会被解析成缩进/列表语义）；
//   - `\~`：波浪线（防止被解析成 GFM 删除线 `~~…~~`）。
// ProseMirror 文本节点里存的是解码后的真实字符，这些只是 canonical 的序列化
// 拼写。所有 canonical 片段写入作者源码前必须还原为作者会打的字面字符，否则
// 用户的源文件会出现 HTML 实体或多余反斜杠（`       文字` 变成 `&#x20;     文字`、
// `0~9` 变成 `0\~9`）。
// 注意：`\\`（反斜杠）刻意不在其中——行尾 `\` 是硬换行语法，反转义会改变语义；
// 反斜杠形态需要独立的输入法级方案，见 docs/canonical-escape-audit.md。
const inlineLiteralRanges = (line) => {
  const ranges = []
  let index = 0
  while (index < line.length) {
    if (line[index] === '`') {
      let openEnd = index + 1
      while (line[openEnd] === '`') openEnd += 1
      const length = openEnd - index
      let cursor = openEnd
      while (cursor < line.length) {
        const candidate = line.indexOf('`', cursor)
        if (candidate < 0) break
        let closeEnd = candidate + 1
        while (line[closeEnd] === '`') closeEnd += 1
        if (closeEnd - candidate === length) {
          ranges.push({ start: index, end: closeEnd })
          index = closeEnd
          break
        }
        cursor = closeEnd
      }
      if (index === openEnd - length) index = openEnd
      continue
    }
    if (line.startsWith('<!--', index)) {
      const close = line.indexOf('-->', index + 4)
      const end = close < 0 ? line.length : close + 3
      ranges.push({ start: index, end })
      index = end
      continue
    }
    if (line[index] === '<') {
      const tag = line.slice(index).match(/^<(\/)?([A-Za-z][\w:-]*)(?:\s[^<>]*?)?\s*(\/?)>/)
      if (tag) {
        const tagEnd = index + tag[0].length
        let end = tagEnd
        if (!tag[1] && !tag[3]) {
          const closePattern = new RegExp(`<\/${tag[2]}\\s*>`, 'ig')
          closePattern.lastIndex = tagEnd
          const close = closePattern.exec(line)
          if (close) end = close.index + close[0].length
        }
        ranges.push({ start: index, end })
        index = end
        continue
      }
    }
    index += 1
  }
  return ranges
}

const markdownEscapePunctuation = /[\\`*{}\[\]()#+\-.!_>~|]/

const translateInlineCanonicalEscapes = (line, restoreFreshPunctuation = false) => {
  const literals = inlineLiteralRanges(line)
  const hasVisibleTextBefore = (offset) => {
    let prefix = line.slice(0, offset).replace(/^[ \t]*/, '')
    // Block syntax is not visible paragraph text. Repeat because quote, list,
    // and heading prefixes can be nested (`> - `, `> ## `, etc.).
    for (;;) {
      const previous = prefix
      prefix = prefix.replace(/^>[ \t]*/, '')
      prefix = prefix.replace(/^(?:#{1,6}|[-+*]|\d{1,9}[.)])[ \t]+/, '')
      prefix = prefix.replace(/^[ \t]*/, '')
      if (prefix === previous) break
    }
    return /\S/.test(prefix)
  }
  let output = ''
  let index = 0
  while (index < line.length) {
    const literal = literals.find((range) => range.start === index)
    if (literal) {
      output += line.slice(literal.start, literal.end)
      index = literal.end
      continue
    }
    if (line.startsWith('&#x20;', index)) {
      // A real leading space cannot be written as plain ASCII Markdown:
      // 1–3 spaces are parser indentation and 4+ become an indented code
      // block. Typora solves the same problem by placing an invisible U+200B
      // before the authored spaces. Keep mid-line/trailing entities as normal
      // spaces, but use the sentinel when no visible text precedes the entity.
      output += hasVisibleTextBefore(index) ? ' ' : `${LEADING_SPACE_SENTINEL} `
      index += 6
      continue
    }
    if (line.startsWith('\\~', index)) {
      output += '~'
      index += 2
      continue
    }
    if (
      restoreFreshPunctuation &&
      line[index] === '\\' &&
      index + 1 < line.length &&
      markdownEscapePunctuation.test(line[index + 1])
    ) {
      output += line[index + 1]
      index += 2
      continue
    }
    output += line[index]
    index += 1
  }
  return output
}

const htmlBlockStart = (line) => line.match(
  /^ {0,3}<(script|pre|style|textarea)(?:\s|>|$)/i
)?.[1]?.toLowerCase() || null

const genericHtmlBlockStart = (line) => /^ {0,3}<\/?[A-Za-z][\w:-]*(?:\s|\/?>|$)/.test(line)

// Canonical escapes are serializer spelling only in Markdown text. Literal
// regions are different: `&#x20;` and `\~` inside code/HTML are user data and
// must stay byte-for-byte. Keep the translator Markdown-context-aware rather
// than applying global string replacements to the whole document.
export const canonicalTextToSource = (text, { restoreFreshPunctuation = false } = {}) => {
  const input = String(text || '')
  const chunks = input.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) || []
  let fence = null
  let htmlTag = null
  let htmlComment = false
  let htmlUntilBlank = false
  return chunks.map((chunk) => {
    const hasNewline = chunk.endsWith('\n')
    const line = hasNewline ? chunk.slice(0, -1) : chunk
    const newline = hasNewline ? '\n' : ''
    const trimmed = line.trim()

    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null
      return line + newline
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,}).*$/)
    if (open) {
      fence = { char: open[1][0], length: open[1].length }
      return line + newline
    }
    if (htmlComment) {
      if (line.includes('-->')) htmlComment = false
      return line + newline
    }
    if (htmlUntilBlank) {
      if (!trimmed) htmlUntilBlank = false
      return line + newline
    }
    if (line.includes('<!--')) {
      htmlComment = !line.includes('-->', line.indexOf('<!--') + 4)
      return line + newline
    }
    if (htmlTag) {
      if (new RegExp(`</${htmlTag}\\s*>`, 'i').test(line)) htmlTag = null
      return line + newline
    }
    const rawTag = htmlBlockStart(line)
    if (rawTag) {
      if (!new RegExp(`</${rawTag}\\s*>`, 'i').test(line)) htmlTag = rawTag
      return line + newline
    }
    if (genericHtmlBlockStart(line)) {
      htmlUntilBlank = true
      return line + newline
    }
    // Do not classify canonical lines as literal code from indentation alone.
    // Four spaces (or a tab) can be structural indentation for a list
    // continuation, and remark may still emit `&#x20;` immediately after that
    // prefix for a real leading space typed by the author. Treating the whole
    // line as literal leaked the serializer entity back into source. Real code
    // blocks produced by the rich serializer are fenced and are handled above;
    // localized edits inside authored literal regions are protected by
    // `literalSourceRegion` in `adaptCanonicalRegionToSource`.
    if (/^ {0,3}(?:<\?|<!\[CDATA\[|<![A-Z])/.test(line)) {
      return line + newline
    }
    if (!trimmed) return line + newline
    const translated = translateInlineCanonicalEscapes(line, restoreFreshPunctuation)
    if (translated === line) return line + newline
    // Restoring a physical character is only safe when the un-escaped line
    // still MEANS the same thing: `2\.` → `2. ` creates a list marker, `\~` →
    // `~` can open GFM strikethrough, un-escaped backticks can open a fence.
    // Those would change the document on reparse (the round-trip acceptance
    // gate rejects the whole commit), so keep the canonical escape whenever
    // the translation is not provably meaning-preserving. Fresh-typed regions
    // (`restoreFreshPunctuation`) keep their documented reinterpretation
    // semantics: there the user physically typed the characters.
    if (!restoreFreshPunctuation) {
      try {
        if (markdownComparisonKey(translated) !== markdownComparisonKey(line)) {
          return line + newline
        }
      } catch {
        return line + newline
      }
    }
    return translated + newline
  }).join('')
}

// Use only for a region proven to be newly typed ProseMirror text. In that
// context canonical `\X` is serializer spelling for the character the user
// entered. Fenced/inline code and HTML ranges remain byte-exact through the
// context scanner above.
export const canonicalFreshTextToSource = (text) => canonicalTextToSource(text, {
  restoreFreshPunctuation: true
})

const fencedCodeAt = (markdown, offset) => {
  let fence = null
  for (const line of markdownLines(String(markdown || ''))) {
    if (line.start > offset) break
    if (fence) {
      const close = line.text.match(/^ {0,3}(`{3,}|~{3,})\s*\r?$/)
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null
      continue
    }
    const open = line.text.match(/^ {0,3}(`{3,}|~{3,}).*\r?$/)
    if (open) fence = { char: open[1][0], length: open[1].length }
  }
  return Boolean(fence)
}

const literalSourceRegion = (source, region) => {
  if (fencedCodeAt(source, region.start)) return true
  const line = lineAt(source, region.start)
  if (region.end > line.end) return false
  const start = Math.max(0, region.start - line.start)
  const end = Math.max(start, region.end - line.start)
  return inlineLiteralRanges(source.slice(line.start, line.end))
    .some((range) => start >= range.start && end <= range.end)
}

// Which list does an inserted bullet row belong to? Under CommonMark, a row
// joins the list of the authored row directly adjacent to it — same block
// prefix, same indent — and a change of marker character STARTS A NEW LIST.
// So writing the serializer's `*` next to an authored `-` does not merely look
// different, it splits one list in two; the candidate then describes a document
// the editor is not showing and the verified commit refuses it. Adopting the
// adjacent row's marker is therefore not a preference for its spelling, it is
// the only spelling that keeps the row in the list it is displayed in.
const BULLET_ROW = /^([ \t]*(?:>[ \t]?)*)([-+*])([ \t])/
const bulletRowAt = (line) => {
  const matched = String(line ?? '').match(BULLET_ROW)
  if (!matched) return null
  // Compare the prefix by SHAPE, not bytes: `>   ` and `> ` are the same quote
  // depth, and only rows at the same depth and indent share a list.
  return {
    depth: (matched[1].match(/>/g) || []).length,
    indent: matched[1].replace(/[^ \t]/g, '').length,
    marker: matched[2]
  }
}
const nearestContentLine = (text, fromEnd) => {
  const lines = text.split(/\r?\n/)
  if (fromEnd) lines.reverse()
  for (const line of lines) if (line.trim()) return line
  return null
}
const sameList = (row, other) =>
  !!row && !!other && row.depth === other.depth && row.indent === other.indent

export const adoptAdjacentBulletMarker = (adapted, source, region) => {
  // Only a pure INSERTION may take its identity from its surroundings. A
  // replacement can span several authored lists, and those rows' identities are
  // established by the replaced region itself — rewriting them by an adjacent
  // row would merge lists the author deliberately kept apart.
  if (region.start !== region.end) return adapted
  const lines = String(adapted).split('\n')
  const rows = lines.map(bulletRowAt)
  const first = rows.find(Boolean)
  if (!first) return adapted

  const before = bulletRowAt(nearestContentLine(source.slice(0, region.start), true))
  const after = bulletRowAt(nearestContentLine(source.slice(region.end), false))
  // A neighbour at a different depth or indent is a DIFFERENT list (an outer
  // row, a nested child); it says nothing about this row.
  const candidates = [before, after].filter((row) => sameList(row, first))
  if (!candidates.length) return adapted
  // Inserting between two differently-marked lists: the row cannot join both,
  // and the format cannot express the ambiguity. Keep the serializer's
  // spelling, which stays a separate list — exactly what the editor shows.
  if (candidates.length === 2 && candidates[0].marker !== candidates[1].marker) return adapted
  const authored = candidates[0].marker

  return lines.map((line, index) => {
    const row = rows[index]
    if (!sameList(row, first) || row.marker === authored) return line
    return line.replace(BULLET_ROW, (whole, prefix, marker, space) => `${prefix}${authored}${space}`)
  }).join('\n')
}

export const adaptCanonicalRegionToSource = (replacement, source, region) => {
  const eol = lineEndingNear(source, region.start)
  let adapted = (literalSourceRegion(source, region)
    ? String(replacement || '')
    : canonicalTextToSource(replacement)).replace(/\r\n?|\n/g, eol)
  const sourceRegion = source.slice(region.start, region.end)
  if (region.start === 0 && source.startsWith('\uFEFF') && !adapted.startsWith('\uFEFF')) {
    adapted = '\uFEFF' + adapted
  }
  if (
    sourceRegion.endsWith('\r') &&
    source[region.end] === '\n' &&
    !adapted.endsWith('\r')
  ) {
    adapted += '\r'
  }
  return adapted
}

export const isTableLine = (line) => line.includes('|')

export const listMarker = (line) => line.match(/^(\s*)(?:[-+*]|\d{1,9}[.)])\s+/)

export const markdownLines = (markdown) => {
  const lines = []
  let start = 0
  while (start <= markdown.length) {
    const next = markdown.indexOf('\n', start)
    const end = next < 0 ? markdown.length : next
    lines.push({ start, end, text: markdown.slice(start, end) })
    if (next < 0) break
    start = next + 1
  }
  return lines
}

export const lineIndexAt = (lines, offset) => {
  const safe = Math.max(0, offset)
  return lines.findIndex((line) => safe >= line.start && safe <= line.end)
}
