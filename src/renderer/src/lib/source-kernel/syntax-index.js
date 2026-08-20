// LosslessSyntaxIndex: 物理行 + 块索引 + 列表项记录，全部锚定原始字符偏移。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
//
// 只 parse、不 runSync：remark 的 transform 插件（frontmatter/gfm 的表格标准化等）
// 会改写 mdast 节点，使 position 与原始字符串错位；先例见
// lib/markdown-preservation/table-source-parse.js buildGfmTableSourceModel。
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkFrontmatter from 'remark-frontmatter'
import { QUOTE_PREFIX } from '../markdown-preservation/block-prefix.js'
import { injectHighlightNodes } from './highlight-syntax.js'
import {
  BREAK_REWRITE_PARENTS,
  PHRASING_PARENTS,
  inlineHtmlRunAt,
  isInlineHtml
} from './inline-html.js'

// remark-math (Plan 5 Task 1) — the kernel chain must recognize EXACTLY the
// syntax the editor chain recognizes, because ProjectionMap zips the two
// trees node-for-node. Crepe's latex feature mounts `remark-math` with its
// DEFAULT options (node_modules/@milkdown/crepe/lib/esm/feature/latex/
// index.js:16 + :365-367) and then rewrites the mdast `math` block to
// `{type:'code', lang:'LaTeX'}` (:370-382) before ProseMirror parses it. So
// on the PM side `$x$` is a `math_inline` ATOM and `$$..$$` is a
// `code_block` with `attrs.language === 'LaTeX'`.
//
// Without this plugin the kernel saw `an $x^2$ formula` as ONE text node
// (16 visible chars vs PM's content.size 12) and `$$\nE=mc^2\n$$` as a
// PARAGRAPH (vs PM's code_block) — both mismatches rejected the WHOLE
// projection map, so ANY document containing math degraded entirely to the
// legacy path. Mounting the same plugin with the same options is what makes
// the two parses agree; it is deliberately NOT a place to be stricter than
// the editor (e.g. remark-math reads `$5 and $6` as inline math — so does
// Crepe, so the kernel must too, or the document degrades again).
//
// remark-math only contributes micromark/mdast-util extensions (no tree
// TRANSFORM), so the "parse only, never runSync" rule above is unaffected:
// every node it produces carries a real `position`.
//
// remark-frontmatter (P6 Task 2) — same reason, same rule. The editor chain
// mounts it (editor-crepe-setup.js:365, `options: undefined` i.e. the default
// 'yaml' preset) and `editor-frontmatter.js` gives the resulting mdast `yaml`
// node its own block-level PM node (`frontmatter`, an ATOM holding the raw
// YAML in `attrs.value`). Without the plugin here the kernel read
// `---\ntitle: x\n---` as a thematicBreak plus a setext heading — two blocks
// of the wrong types where PM has one — so the very first pair mismatched and
// the WHOLE document degraded to legacy. Frontmatter is a common shape (this
// repo's own guide uses it), which made that one of the two largest remaining
// document-level degradations.
//
// SCOPE: pairing only. The `frontmatter` PM node is an atom, so
// `buildProjectionMap`'s `editable` test (`pm.node.isTextblock`) is false for
// it and it pairs with `charMap: null` — an opaque read-only leaf, the posture
// tables / block math / block HTML already have. Editing the YAML through the
// kernel is NOT claimed; the existing rich-mode card
// (`renderFrontmatterNodeView` -> `handleFrontmatterValueChange`) is a
// separate, legacy-side path.
//
// The default preset matches the editor's exactly (both `'yaml'`, i.e. `---`
// fences only, only at the very start of the document), so a `---` sitting
// mid-document is still a thematicBreak to BOTH chains — verified, not
// assumed, in scripts/test-source-kernel-index.mjs.
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkFrontmatter)

// ===========================================================================
// Parse memo (perf assessment §9 #3, 2026-08-21)
// ===========================================================================
// One kernel operation parses the SAME full document string several times:
// the route handler builds an index of `kernel.doc.text`, `buildProjectionMap`
// builds another for the identical post-edit text, and the byte-proof
// commands parse their baseline (`doc.text`) on top — 4-6 full parses per
// structural/mark/link/image operation, ~110 ms each at 200 KB. The parse is
// pure and the memo key is the EXACT string (never a hash, never a revision
// number), so a hit is proof the bytes are identical and can never serve a
// stale tree. Small LRU: entries beyond the cap evict oldest-first; the cap
// covers two mounted editors' current+previous texts (the cross-document
// thrash 1e5d2db measured on the table memo cannot recur at cap 8).
//
// TWO SEPARATE CACHES, never shared: `buildSyntaxIndex` MUTATES the tree it
// parses (`injectHighlightNodes` splits text nodes in place), so its memo
// stores the whole INDEX (tree already injected, safe to reshare because no
// consumer mutates it — audited 2026-08-21: the only tree mutation anywhere
// in source-kernel/ or the kernel components is injectHighlightNodes
// itself). `parseKernelMarkdown` serves raw, highlight-free trees and must
// keep doing so — routing it through the index memo (or vice versa) would
// leak the injection into callers that count/walk raw nodes.
//
// Texts above the length cap skip the memo entirely (parse and return):
// entries pin both the string and its mdast for the cache lifetime, and the
// kernel's own operating window is ≤ CHUNK_THRESHOLD (120 K chars), so the
// cap is a leak guard, not a working limit.
const PARSE_MEMO_ENTRIES = 8
const PARSE_MEMO_MAX_TEXT = 1_500_000
const rawParseMemo = new Map()
const indexMemo = new Map()
const memoGet = (memo, key) => {
  if (!memo.has(key)) return null
  const value = memo.get(key)
  memo.delete(key)
  memo.set(key, value) // refresh recency (Map preserves insertion order)
  return value
}
const memoSet = (memo, key, value) => {
  memo.delete(key)
  memo.set(key, value)
  while (memo.size > PARSE_MEMO_ENTRIES) memo.delete(memo.keys().next().value)
}

// The kernel's own parse, exposed for commands that must PROVE a candidate
// rewrite reparses to the document they intend (Plan 5 Task 5's
// `setImageAttrs` re-parses its candidate bytes and asserts the image node
// still starts at the same offset and carries exactly the requested
// alt/url/title). Deliberately the SAME `processor` instance the index uses
// — a second, separately-configured chain could drift from it and turn a
// "proof" into a guess. Highlight injection (a post-parse tree touch that
// only splits text nodes) is not applied here: it never changes a node's
// span and the callers below read block/inline node positions only.
export function parseKernelMarkdown(text) {
  const key = String(text ?? '')
  if (key.length > PARSE_MEMO_MAX_TEXT) return processor.parse(key)
  const hit = memoGet(rawParseMemo, key)
  if (hit) return hit
  const tree = processor.parse(key)
  memoSet(rawParseMemo, key, tree)
  return tree
}

export function scanLines(text) {
  const lines = []
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\n') {
      lines.push({ start, end: i, ending: '\n', text: text.slice(start, i) })
      start = i + 1
    } else if (ch === '\r') {
      const crlf = text[i + 1] === '\n'
      lines.push({ start, end: i, ending: crlf ? '\r\n' : '\r', text: text.slice(start, i) })
      if (crlf) i += 1
      start = i + 1
    }
  }
  lines.push({ start, end: text.length, ending: '', text: text.slice(start) })
  return lines
}

// `html` is in this set for BLOCK-level HTML only (`<div>x</div>` as a
// root/blockquote/listItem child). An INLINE html fragment is also an mdast
// `html` node, and used to be collected here too — which made `blockAt` answer
// `{type:'html'}` for every offset inside `a <span>x</span> b`, so Enter /
// Delete / Backspace / mark-toggle all refused (`unsupported-structure`)
// anywhere near a fragment even though the enclosing paragraph is a perfectly
// ordinary, editable block. `isInlineHtml` (inline-html.js) is the shared
// discriminator that keeps those out; see the `walk` call site.
const BLOCKS = new Set([
  'paragraph', 'heading', 'blockquote', 'list', 'listItem',
  'code', 'table', 'thematicBreak', 'html', 'math'
])
const CONTAINERS = new Set(['list', 'blockquote', 'table', 'code'])

const MARKER_RE = /^([ \t]*)([*+-]|\d{1,9}[.)])([ \t]+|$)/
const TASK_RE = /^\[( |x|X)\]([ \t]*)/

export function buildSyntaxIndex(text) {
  const key = String(text ?? '')
  if (key.length <= PARSE_MEMO_MAX_TEXT) {
    const hit = memoGet(indexMemo, key)
    if (hit) return hit
  }
  const index = buildSyntaxIndexUncached(key)
  if (key.length <= PARSE_MEMO_MAX_TEXT) memoSet(indexMemo, key, index)
  return index
}

function buildSyntaxIndexUncached(text) {
  const lines = scanLines(text)
  const dominantEnding = lines.find((l) => l.ending)?.ending || '\n'
  const tree = processor.parse(text)

  const offsetOf = (point) => point?.offset

  const lineIndexAt = (offset) => {
    let lo = 0
    let hi = lines.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lines[mid].start <= offset) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  // `==highlight==` (Plan 5 Task 3). The editor chain has no `==` micromark
  // construct either — it runs a REGEX over the parsed mdast's `text` nodes
  // (editor-highlight.js's `highlightRemark`), so the kernel recognizes the
  // shape the same way, from the same regex, and derives real positions for
  // the nodes it injects (highlight-syntax.js owns the whole rule and its
  // ADR). Without this, `甲==乙==丙` was 9 literal characters to the kernel
  // and 3 to ProseMirror (which holds a highlight MARK) — a content-size
  // disagreement that made the paragraph non-editable and kept the highlight
  // toolbar button refused.
  //
  // This is the one post-parse tree touch this module allows, and it is
  // compatible with the "only parse, never runSync" rule at the top: it
  // rewrites no existing node's position, it only SPLITS a text node into
  // pieces whose positions are computed from the character map's own decode
  // walk. `pointAt` gives those pieces a full unist point (line/column too),
  // so an injected node is indistinguishable from a parsed one.
  const pointAt = (offset) => {
    const index = lineIndexAt(offset)
    return { line: index + 1, column: offset - lines[index].start + 1, offset }
  }
  injectHighlightNodes(tree, text, pointAt)

  const buildItem = (node, ancestors, start, end) => {
    const list = ancestors[ancestors.length - 1] // 直接父 list
    const depth = ancestors.filter((a) => a.type === 'listItem').length
    const line = lines[lineIndexAt(start)]
    // QUOTE_PREFIX's leading `[ \t]*` is unconditional (CommonMark allows up to
    // 3 spaces before a blockquote marker), so on a line with NO '>' at all it
    // still matches — and would wrongly swallow a nested list item's own
    // indentation as "quote prefix". Only treat the match as a real quote
    // prefix when it actually contains a '>'.
    const rawPrefix = (line.text.match(QUOTE_PREFIX) || [''])[0]
    const quotePrefix = rawPrefix.includes('>') ? rawPrefix : ''
    const rest = line.text.slice(quotePrefix.length)
    const m = rest.match(MARKER_RE)
    if (!m) return null
    const indent = m[1]
    const marker = m[2]
    const spacing = m[3]
    const markerEnd = line.start + quotePrefix.length + indent.length + marker.length + spacing.length
    let task = null
    let taskSpacing = ''
    let contentStart = markerEnd
    if (node.checked === true || node.checked === false) {
      const t = text.slice(markerEnd).match(TASK_RE)
      if (t) {
        task = { from: markerEnd, to: markerEnd + 3, checked: t[1].toLowerCase() === 'x' }
        taskSpacing = t[2]
        contentStart = task.to + taskSpacing.length
      }
    }
    const markerLineTail = text.slice(contentStart, line.start + line.text.length)
    const singleLine = lineIndexAt(Math.max(start, end - 1)) === lineIndexAt(start)
    return {
      start,
      end,
      markerLineIndex: lineIndexAt(start),
      quotePrefix,
      indent,
      marker,
      ordered: /^\d/.test(marker)
        ? { number: parseInt(marker, 10), delimiter: marker[marker.length - 1] }
        : null,
      spacing,
      task,
      taskSpacing,
      contentStart,
      listStart: offsetOf(list?.position?.start),
      listEnd: offsetOf(list?.position?.end),
      depth,
      // CommonMark blankness is ASCII-only ("a line containing only spaces
      // or tabs"), and `empty` must answer what THE PARSER this index is
      // built from answers — never what JavaScript's Unicode whitespace
      // table answers. `String.trim()` strips U+00A0 (the `/task` seed and
      // every whitespace-heal byte), U+3000, \f, … — every one of which
      // remark reads as REAL content (the item gets a paragraph child). The
      // trim() spelling therefore contradicted this index's own `tree`: the
      // seeded task item (`- [ ] ` + U+00A0, checked:false, one addressable
      // character) classified as EMPTY, so the router sent Backspace/Enter
      // to exitEmptyListItem, which silently deleted a line the parser
      // proves has content (2026-08-20 adversarial audit, Critical — the
      // documented refusal was never reached).
      empty: singleLine && !/[^ \t]/.test(markerLineTail)
    }
  }

  // Raw spans of the INLINE HTML fragments a caret must never split (see
  // `bisectsInlineHtml`). Recorded per phrasing container with the SAME shared
  // rule `character-map.js` uses to emit its width-1 atom units, so a span here
  // is exactly one ProseMirror inline atom:
  //  - a coalesced run (`<span>` + `x` + `</span>` -> one atom) spans the FIRST
  //    node's start to the LAST node's end, interior text included;
  //  - an html node the editor does NOT merge (a lone `<br/>`, an unbalanced
  //    `<span>x`) is still an inline atom on its own, so its own span counts.
  const inlineHtmlSpans = []
  const collectInlineHtmlSpans = (node) => {
    const children = node.children || []
    // Same question `character-map.js`'s `collectUnits` asks, answered from the
    // same set — every container reached here is a phrasing parent, so this is
    // `true` in practice; asking rather than hardcoding keeps the two scans
    // literally identical.
    const breakHtmlCuts = BREAK_REWRITE_PARENTS.has(node.type)
    let i = 0
    while (i < children.length) {
      const run = inlineHtmlRunAt(children, i, breakHtmlCuts)
      if (run) {
        const s = offsetOf(children[i].position?.start)
        const e = offsetOf(children[run.end - 1].position?.end)
        if (Number.isInteger(s) && Number.isInteger(e)) inlineHtmlSpans.push({ start: s, end: e })
        i = run.end
        continue
      }
      const child = children[i]
      i += 1
      if (child.type !== 'html') continue
      const s = offsetOf(child.position?.start)
      const e = offsetOf(child.position?.end)
      if (Number.isInteger(s) && Number.isInteger(e)) inlineHtmlSpans.push({ start: s, end: e })
    }
  }

  const blocks = [] // { type, start, end, node, ancestors }
  const items = [] // 列表项记录（可能含 null，构建失败的项）
  const walk = (node, ancestors) => {
    const start = offsetOf(node.position?.start)
    const end = offsetOf(node.position?.end)
    // An inline html fragment is NOT a block candidate — the enclosing
    // paragraph/heading/tableCell is the block, and it is what every structural
    // command must resolve to. Block-level html (root/blockquote/listItem
    // child) is unaffected and keeps behaving exactly as before.
    const inline = isInlineHtml(node, ancestors[ancestors.length - 1])
    if (BLOCKS.has(node.type) && !inline && Number.isInteger(start) && Number.isInteger(end)) {
      blocks.push({ type: node.type, start, end, node, ancestors: [...ancestors] })
      if (node.type === 'listItem') items.push(buildItem(node, ancestors, start, end))
    }
    if (PHRASING_PARENTS.has(node.type)) collectInlineHtmlSpans(node)
    const nextAncestors = [...ancestors, node]
    for (const child of node.children || []) walk(child, nextAncestors)
  }

  walk(tree, [])
  const validItems = items.filter(Boolean)

  const within = (b, offset) => offset >= b.start && offset < b.end

  const blockAt = (offset) => {
    let best = null
    for (const b of blocks) {
      if (b.type === 'list' || b.type === 'blockquote') continue
      if (within(b, offset) && (!best || b.start >= best.start)) best = b
    }
    return best ? { type: best.type, start: best.start, end: best.end, node: best.node } : null
  }

  // A list item's mdast end sits right BEFORE its last line's terminator (same
  // convention as every other block here), so an empty item's only "inside"
  // offset — right after the marker, at the caret position a user would sit at
  // — lands exactly ON item.end. Blocks use exclusive end; items use inclusive
  // end so that boundary offset still resolves (the next item, if any, only
  // ever starts after the line terminator, so this can't collide).
  const withinItem = (item, offset) => offset >= item.start && offset <= item.end
  const listItemAt = (offset) => {
    let best = null
    for (const item of validItems) {
      if (withinItem(item, offset) && (!best || item.start >= best.start)) best = item
    }
    return best
  }

  // The inline HTML fragment STRICTLY containing `offset`, or null. Both edges
  // are "outside": a caret may sit before `<span>` or after `</span>`, never
  // between them — mirroring the character map, where the whole fragment is a
  // single width-1 atom with no addressable interior.
  const inlineHtmlSpanAt = (offset) => {
    for (const span of inlineHtmlSpans) {
      if (offset > span.start && offset < span.end) return span
    }
    return null
  }

  // Bisection guard for STRUCTURAL commands, the same shape as the gateway's
  // `bisectsLineEnding` (editor-kernel-gateway.js) CRLF-pair guard: some raw
  // offsets are byte-legal but structurally indivisible, and a command that
  // writes there must refuse rather than produce bytes that reparse into a
  // different document.
  //
  // Why it became necessary: with inline html no longer masquerading as a
  // block, `blockAt` finally resolves the enclosing paragraph, so Enter /
  // Backspace / Delete are REACHABLE at offsets that previously refused by
  // accident. Most of those offsets should now work — but the ones INSIDE a
  // fragment must not: splitting `a <span>x</span> b` at the `x` would commit
  // `a <span>x` and `</span> b`, two UNBALANCED fragments that the editor
  // renders as escaped text, i.e. a document that no longer matches the
  // ProseMirror doc the user was looking at.
  //
  // Range form: a range bisects when EITHER endpoint sits strictly inside a
  // fragment. A range that COVERS a whole fragment (`from <= span.start` and
  // `to >= span.end`) does not — deleting an entire fragment is well-defined
  // and stays allowed.
  const bisectsInlineHtml = (from, to = from) => {
    if (!Number.isFinite(from) || !Number.isFinite(to)) return false
    return !!(inlineHtmlSpanAt(from) || inlineHtmlSpanAt(to))
  }

  const lineRange = (start, end) => {
    const first = lines[lineIndexAt(start)]
    const last = lines[lineIndexAt(Math.max(start, end - 1))]
    return { start: first.start, end: last.end + last.ending.length }
  }

  const containerRange = (offset) => {
    let top = null
    for (const b of blocks) {
      if (!within(b, offset)) continue
      if (CONTAINERS.has(b.type) && (!top || b.start <= top.start)) top = b
    }
    if (top) return lineRange(top.start, top.end)
    const block = blockAt(offset)
    if (block) return lineRange(block.start, block.end)
    const line = lines[lineIndexAt(offset)]
    return { start: line.start, end: line.end + line.ending.length }
  }

  return {
    text,
    tree,
    lines,
    dominantEnding,
    lineIndexAt,
    lineAt: (offset) => lines[lineIndexAt(offset)],
    blockAt,
    listItemAt,
    containerRange,
    inlineHtmlSpans,
    inlineHtmlSpanAt,
    bisectsInlineHtml
  }
}
