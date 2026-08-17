// 链接域（Plan 5 Task 6）：把 Milkdown LinkTooltip 的四种链接操作
// —— wrap / unwrap / 改 URL / 空选区插入 —— 写成 `[text](url "title")` 的
// **最小字节改动**，其余字节（尖括号形态、标题引号种类、括号内空格）一律
// 原样保留。本目录（source-kernel）禁止 import electron/react/@milkdown。
//
// WHY A SCAN **PLUS** A REPARSE PROOF (same posture as image-attrs.js)
// -------------------------------------------------------------------
// mdast's `link` reports `url`/`title` as decoded STRINGS and a `position`
// covering the whole `[...](...)` — it does NOT say where inside that span
// each field's bytes live. And unlike an image (a LEAF), a link's LABEL is
// real positioned phrasing, so a wrap/unwrap changes the block's inline TREE,
// not just one leaf's attributes. Both facts mean a hand-rolled segmentation
// (or a hand-rolled "these bytes are safe to inject") is a guess, and this
// kernel does not commit guesses. So every candidate rewrite is PROVEN:
//
//   1. `scanLink` splits an existing link's raw span into label /
//      destination / title segments using CommonMark's own bracket-balancing
//      + backslash-escape rules, and must land its closing `)` exactly on the
//      mdast node's own `position.end.offset`. A span it cannot consume
//      exactly is refused.
//   2. The candidate document (the original text with only the intended
//      bytes changed) is REPARSED through the kernel's own chain
//      (`parseKernelMarkdown`) and checked on THREE axes:
//        a. STRUCTURE OUTSIDE THE BLOCK — every mdast node except the target
//           block's own inline descendants must come back with the same type
//           and the same span once shifted by the edit deltas. This is what
//           rejects a URL byte that would split a GFM table cell (adding a
//           column), end a paragraph, or start a new block.
//        b. THE BLOCK STILL MAPS — `buildCharacterMap` of the candidate block
//           must be non-null with the expected `visibleLength`, and the
//           block's decoded text must be exactly what the operation promised
//           (unchanged for wrap/unwrap/edit; the inserted label spliced in
//           for an empty-selection insert). Bytes that reparse to a DIFFERENT
//           visible document are refused here even when they happen to
//           produce a link node.
//        c. THE LINK ITSELF — for wrap/edit/insert a `link` node must exist at
//           exactly the expected span with exactly the requested `url`/
//           `title` and a label that decodes to the expected text; for unwrap
//           NO link node may overlap the former content range (which is what
//           refuses "unwrapping" `[www.a.com](x)`, whose bare text would
//           immediately become a GFM autolink literal again — the user's
//           removal would visibly not happen).
//
// Escaping is therefore EARNED, never assumed: candidates are tried
// cheapest-first (verbatim bytes), and only when the reparse DISAGREES does
// the next candidate add backslash escapes or switch the destination to the
// `<...>` angle form.
//
// AUTHORED LINKS ONLY. GFM autolink literals (`www.a.com`, a bare
// `https://…`) and CommonMark angle autolinks (`<https://…>`) are `link`
// nodes too, and ProseMirror carries the SAME `link` mark for them — so the
// tooltip's remove/edit flow can target one. They have no `[`…`](…)` bytes to
// rewrite, so this module refuses them (`isAuthoredLink`): a "remove" would
// have to delete the URL text itself, and an "edit" would have to invent a
// syntax the user never wrote. Fail closed instead.
//
// SCOPE. paragraph / heading / tableCell content only (`PHRASING_BLOCKS`) —
// the same domain gate mark-toggle.js states, plus table cells, which Plan 5
// Task 4 made mappable and where the reparse proof is what keeps a `|` inside
// a URL from silently growing a column.
import { parseKernelMarkdown } from '../syntax-index.js'
import { buildCharacterMap } from '../character-map.js'

// The blocks whose mdast content is real inline phrasing AND which the
// projection map can hand this command a character map for. Anything else
// (code, html, math, thematicBreak, a bare `list`/`blockquote` container) is
// out of scope entirely rather than guessed at.
const PHRASING_BLOCKS = new Set(['paragraph', 'heading', 'tableCell'])

// Node types whose byte span a wrap must not PARTIALLY straddle (the same
// rule mark-toggle.js's `hasPartialOverlap` applies): a range that covers a
// node entirely, or sits entirely inside one, is fine; one that crosses a
// boundary would strand the node's delimiters on the far side of a newly
// inserted `[` or `](url)`.
const OVERLAP_NODE_TYPES = new Set([
  'strong', 'emphasis', 'delete', 'inlineCode', 'highlight', 'link', 'linkReference',
  'image', 'imageReference', 'html', 'inlineMath', 'footnoteReference', 'break'
])

const isWs = (ch) => ch === ' ' || ch === '\t'

// Escape ladders. Escaping is only ever a SECOND attempt (after the verbatim
// candidate failed its reparse proof), so these sets are allowed to be
// generous: an over-escape that still decodes to the requested value is
// byte-legal, and one that does not is rejected by the same proof as
// everything else.
const LABEL_ESCAPE = new Set(['\\', '`', '*', '_', '[', ']', '<', '>', '&', '!', '~', '|', '$'])
const BARE_DEST_ESCAPE = new Set(['\\', '(', ')', '<', '>', '&', '|'])
const ANGLE_DEST_ESCAPE = new Set(['\\', '<', '>', '|'])

const escapeWith = (value, chars) => {
  let out = ''
  for (const ch of value) out += chars.has(ch) ? `\\${ch}` : ch
  return out
}

// Splits `text[start, end)` — an mdast `link` node's own raw span — into its
// byte segments. Mirrors image-attrs.js's `scanImage` minus the leading `!`
// (CommonMark's link and image destination/title grammars are identical).
// Returns null (fail-closed) for anything it cannot consume exactly.
function scanLink(text, start, end) {
  if (text[start] !== '[') return null

  let i = start + 1
  const labelStart = i
  let labelEnd = -1
  let depth = 0
  while (i < end) {
    const ch = text[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '[') { depth += 1; i += 1; continue }
    if (ch === ']') {
      if (depth === 0) { labelEnd = i; break }
      depth -= 1
      i += 1
      continue
    }
    i += 1
  }
  if (labelEnd < 0) return null

  i = labelEnd + 1
  if (text[i] !== '(') return null
  i += 1
  while (i < end && isWs(text[i])) i += 1

  const destStart = i
  let angle = false
  if (text[i] === '<') {
    angle = true
    i += 1
    let closed = false
    while (i < end) {
      const ch = text[i]
      if (ch === '\\') { i += 2; continue }
      if (ch === '<') return null
      if (ch === '>') { i += 1; closed = true; break }
      i += 1
    }
    if (!closed) return null
  } else {
    let parens = 0
    while (i < end) {
      const ch = text[i]
      if (ch === '\\') { i += 2; continue }
      if (isWs(ch)) break
      if (ch === '(') { parens += 1; i += 1; continue }
      if (ch === ')') {
        if (parens === 0) break
        parens -= 1
        i += 1
        continue
      }
      i += 1
    }
  }
  const destEnd = Math.min(i, end)

  i = destEnd
  while (i < end && isWs(text[i])) i += 1
  let titleStart = -1
  let titleEnd = -1
  let titleOpen = ''
  const opener = text[i]
  if (i < end && (opener === '"' || opener === "'" || opener === '(')) {
    const closer = opener === '(' ? ')' : opener
    titleStart = i
    titleOpen = opener
    i += 1
    let closed = false
    while (i < end) {
      const ch = text[i]
      if (ch === '\\') { i += 2; continue }
      if (ch === closer) { i += 1; closed = true; break }
      i += 1
    }
    if (!closed) return null
    titleEnd = i
    while (i < end && isWs(text[i])) i += 1
  }

  // The scan must land the closing paren on the parser's OWN end offset — the
  // one piece of external evidence that this segmentation is the same one
  // remark made.
  if (text[i] !== ')' || i + 1 !== end) return null

  return { labelStart, labelEnd, destStart, destEnd, angle, titleStart, titleEnd, titleOpen }
}

const destCandidates = (value, wasAngle) => {
  const bare = [value, escapeWith(value, BARE_DEST_ESCAPE)]
  const wrapped = [`<${value}>`, `<${escapeWith(value, ANGLE_DEST_ESCAPE)}>`]
  // An empty destination has no bare spelling that survives a following
  // title, so the angle form `<>` leads.
  if (value === '' || wasAngle) return [...wrapped, ...bare]
  return [...bare, ...wrapped]
}

const quoteTitle = (value, open) => {
  const close = open === '(' ? ')' : open
  const escapes = open === '(' ? new Set(['\\', '(', ')']) : new Set(['\\', close])
  return [`${open}${value}${close}`, `${open}${escapeWith(value, escapes)}${close}`]
}

const titleCandidates = (value, existingOpen) => {
  const first = existingOpen || '"'
  const rest = ['"', "'", '('].filter((q) => q !== first)
  return [...quoteTitle(value, first), ...rest.flatMap((q) => quoteTitle(value, q))]
}

const applyEdits = (text, edits) => {
  let out = ''
  let cursor = 0
  for (const edit of edits) {
    out += text.slice(cursor, edit.from) + edit.insert
    cursor = edit.to
  }
  return out + text.slice(cursor)
}

// Enumerates candidate index tuples in escalation order: all-verbatim first,
// then by total escalation (sum of indices), ties broken left-to-right. Same
// helper as image-attrs.js (kept local rather than shared so neither command
// can silently change the other's search order).
function* candidateTuples(lengths) {
  const total = lengths.reduce((sum, n) => sum + n - 1, 0)
  for (let budget = 0; budget <= total; budget += 1) {
    const walk = function* (position, remaining, prefix) {
      if (position === lengths.length) {
        if (remaining === 0) yield prefix
        return
      }
      for (let pick = 0; pick < lengths[position] && pick <= remaining; pick += 1) {
        yield* walk(position + 1, remaining - pick, [...prefix, pick])
      }
    }
    yield* walk(0, budget, [])
  }
}

// Hard cap on reparse attempts — a request needing more escalations than this
// is refused rather than searched.
const MAX_ATTEMPTS = 24

// Innermost mdast node of a phrasing-block type whose span CONTAINS
// [rawFrom, rawTo]. Deliberately NOT `index.blockAt`: that helper's block set
// has no `tableCell` (a cell's enclosing block is the whole `table`), and a
// cell is exactly where Plan 5 Task 4 made editing real.
function phrasingBlockFor(tree, rawFrom, rawTo) {
  let found = null
  const visit = (node) => {
    const start = node?.position?.start?.offset
    const end = node?.position?.end?.offset
    if (PHRASING_BLOCKS.has(node?.type) && Number.isInteger(start) && Number.isInteger(end) &&
        rawFrom >= start && rawTo <= end) {
      if (!found || start >= found.position.start.offset) found = node
    }
    for (const child of node?.children || []) visit(child)
  }
  visit(tree)
  return found
}

// Decoded text of an inline subtree. Only used to compare a BASELINE parse
// against a CANDIDATE parse (never to derive bytes), so what matters is that
// both sides run the identical rule: `text`/`inlineCode` contribute their
// decoded `value`, containers recurse, atoms (image/break/html/math)
// contribute nothing.
function flattenText(node) {
  if (node?.type === 'text' || node?.type === 'inlineCode') return String(node.value ?? '')
  if (!Array.isArray(node?.children)) return ''
  let out = ''
  for (const child of node.children) out += flattenText(child)
  return out
}

// The `[`…`](…)` byte form. A GFM autolink literal's span EQUALS its label's
// span (no syntax bytes at all) and a CommonMark angle autolink opens with
// `<` — neither has anything this command can rewrite.
function isAuthoredLink(node, text) {
  const start = node?.position?.start?.offset
  const end = node?.position?.end?.offset
  const children = node?.children || []
  const first = children[0]?.position?.start?.offset
  const last = children[children.length - 1]?.position?.end?.offset
  if (![start, end, first, last].every(Number.isInteger)) return false
  if (text[start] !== '[' || text[end - 1] !== ')') return false
  return start < first && last < end
}

// Innermost authored `link` whose LABEL span is exactly [rawFrom, rawTo) —
// the range the tooltip reports for an existing link (its mark run covers the
// label text, never the syntax bytes). An inexact match (a partial selection
// inside a link, or a selection spilling past it) returns null: partial
// unwrap/re-target is a shape this command cannot own.
function authoredLinkWithContent(block, text, rawFrom, rawTo) {
  let found = null
  const visit = (node) => {
    for (const child of node.children || []) {
      if (child.type === 'link' && isAuthoredLink(child, text)) {
        const kids = child.children
        const first = kids[0].position.start.offset
        const last = kids[kids.length - 1].position.end.offset
        if (first === rawFrom && last === rawTo) found = child
      }
      if (child.children) visit(child)
    }
  }
  visit(block)
  return found
}

// Every node in `block` whose span PARTIALLY straddles [rawFrom, rawTo) —
// neither contained by it nor containing it. See OVERLAP_NODE_TYPES.
function hasPartialOverlap(block, rawFrom, rawTo) {
  let bad = false
  const visit = (node) => {
    for (const child of node.children || []) {
      if (OVERLAP_NODE_TYPES.has(child.type)) {
        const start = child.position?.start?.offset
        const end = child.position?.end?.offset
        if (Number.isInteger(start) && Number.isInteger(end) && start < rawTo && rawFrom < end) {
          const covers = rawFrom <= start && end <= rawTo
          const inside = start <= rawFrom && rawTo <= end
          if (!covers && !inside) bad = true
        }
      }
      if (child.children) visit(child)
    }
  }
  visit(block)
  return bad
}

// Any `link`/`linkReference` intersecting [rawFrom, rawTo)? Links cannot nest
// in CommonMark, so a wrap that touches one at all is refused (this is also
// the autolink-literal guard for the wrap direction: selecting a bare
// `www.a.com` and pressing the link button targets a positioned `link` node).
function intersectsLink(block, rawFrom, rawTo) {
  let hit = false
  const visit = (node) => {
    for (const child of node.children || []) {
      if (child.type === 'link' || child.type === 'linkReference') {
        const start = child.position?.start?.offset
        const end = child.position?.end?.offset
        if (Number.isInteger(start) && Number.isInteger(end) && start < rawTo && rawFrom < end) hit = true
      }
      if (child.children) visit(child)
    }
  }
  visit(block)
  return hit
}

// The innermost `link`/`linkReference` whose span STRICTLY contains `offset`
// (both edges count as outside — a caret there is between two nodes, not
// inside one).
function linkStrictlyContaining(block, offset) {
  let hit = false
  const visit = (node) => {
    for (const child of node.children || []) {
      if (child.type === 'link' || child.type === 'linkReference') {
        const start = child.position?.start?.offset
        const end = child.position?.end?.offset
        if (Number.isInteger(start) && Number.isInteger(end) && offset > start && offset < end) hit = true
      }
      if (child.children) visit(child)
    }
  }
  visit(block)
  return hit
}

// Backslash-escape edits for every LITERAL `[` / `]` byte inside
// [rawFrom, rawTo) that sits in a `text` node of `block`. Restricting to text
// nodes is what makes this provable: a `]` inside an inline-code span or an
// html fragment is not label syntax and must not grow a backslash (which
// would become visible content there). Already-escaped bytes are skipped by
// the same `\X` pair walk `scanLink` uses.
function bracketEscapeEdits(block, text, rawFrom, rawTo) {
  const edits = []
  const visit = (node) => {
    for (const child of node.children || []) {
      if (child.type === 'text') {
        const start = child.position?.start?.offset
        const end = child.position?.end?.offset
        if (Number.isInteger(start) && Number.isInteger(end)) {
          let i = start
          while (i < end) {
            if (text[i] === '\\') { i += 2; continue }
            if ((text[i] === '[' || text[i] === ']') && i >= rawFrom && i < rawTo) {
              edits.push({ from: i, to: i, insert: '\\' })
            }
            i += 1
          }
        }
      }
      if (child.children) visit(child)
    }
  }
  visit(block)
  return edits.sort((a, b) => a.from - b.from)
}

// Pre-order `{type, start, end}` list of everything EXCEPT the target block's
// own inline descendants — the structural signature two parses are compared
// on. Recursion stops at the node matching `(blockType, blockStart, blockEnd)`
// (that node itself IS recorded), so a wrap/unwrap's intended inline change is
// not counted as a structural difference while every block boundary, table
// row/cell and list level in the document still is.
function outerSignature(tree, blockType, blockStart, blockEnd) {
  const out = []
  const visit = (node) => {
    const start = node?.position?.start?.offset ?? null
    const end = node?.position?.end?.offset ?? null
    out.push({ type: node?.type, start, end })
    if (node?.type === blockType && start === blockStart && end === blockEnd) return
    for (const child of node?.children || []) visit(child)
  }
  visit(tree)
  return out
}

function findNode(tree, type, start, end) {
  let found = null
  const visit = (node) => {
    if (found) return
    if (node?.type === type && node.position?.start?.offset === start &&
        node.position?.end?.offset === end) {
      found = node
      return
    }
    for (const child of node?.children || []) visit(child)
  }
  visit(tree)
  return found
}

// Block-relative coordinate for the structural comparison. Offsets at or
// before the block's start keep their absolute value ('H'); offsets at or
// after the block's END are expressed relative to it ('T'), so the whole
// document after the block lines up regardless of how many bytes the edit
// added inside it. This replaces per-edit delta arithmetic, which cannot
// answer the boundary question (an insert at the block's own start byte must
// NOT move the block's start, but the same insert MUST move its end) —
// normalizing to the block's two edges sidesteps that ambiguity entirely.
// 'I' (strictly inside the block) is unreachable for the nodes this signature
// records: every ancestor contains the block and every sibling is disjoint.
const normOffset = (offset, blockStart, blockEnd) => {
  if (offset === null || offset === undefined) return null
  if (offset >= blockEnd) return `T${offset - blockEnd}`
  if (offset <= blockStart) return `H${offset}`
  return 'I'
}

// The proof (all three axes — see this file's header).
function verifyCandidate(text, spec) {
  const { blockType, blockStart, blockEnd, expectedText, expectedVisibleLength, baseline, delta, link, forbidLinkRange } = spec
  let tree
  try {
    tree = parseKernelMarkdown(text)
  } catch {
    return false
  }

  // Axis (a): everything outside the block's inline content is untouched.
  // The block's own end must land exactly `delta` bytes later — the edits'
  // net byte count must have gone entirely INTO this block, nowhere else.
  const nextBlockEnd = blockEnd + delta
  const candidate = outerSignature(tree, blockType, blockStart, nextBlockEnd)
  if (candidate.length !== baseline.length) return false
  for (let i = 0; i < candidate.length; i += 1) {
    if (candidate[i].type !== baseline[i].type) return false
    if (normOffset(candidate[i].start, blockStart, nextBlockEnd) !==
        normOffset(baseline[i].start, blockStart, blockEnd)) return false
    if (normOffset(candidate[i].end, blockStart, nextBlockEnd) !==
        normOffset(baseline[i].end, blockStart, blockEnd)) return false
  }

  // Axis (b): the block still character-maps, at the promised visible length,
  // and shows the promised text.
  const block = findNode(tree, blockType, blockStart, nextBlockEnd)
  if (!block) return false
  if (flattenText(block) !== expectedText) return false
  const map = buildCharacterMap(text, block)
  if (!map || map.visibleLength !== expectedVisibleLength) return false

  // Axis (c): the link itself.
  if (link) {
    const node = findNode(tree, 'link', link.start, link.end)
    if (!node) return false
    if (!isAuthoredLink(node, text)) return false
    if ((node.url ?? '') !== link.url) return false
    if ((node.title ?? null) !== link.title) return false
    if (flattenText(node) !== link.label) return false
  }
  if (forbidLinkRange) {
    let overlapping = false
    const visit = (node) => {
      const start = node?.position?.start?.offset
      const end = node?.position?.end?.offset
      if (node?.type === 'link' || node?.type === 'linkReference') {
        if (Number.isInteger(start) && Number.isInteger(end) &&
            start < forbidLinkRange.to && forbidLinkRange.from < end) {
          overlapping = true
        }
      }
      for (const child of node?.children || []) visit(child)
    }
    visit(block)
    if (overlapping) return false
  }
  return true
}

// applyLinkEdit — the single entry point for all four link operations.
//
// `op`:
//   'wrap'    a non-empty selection becomes `[selection](href)` (+ title).
//   'unwrap'  an existing authored link's syntax bytes are deleted, leaving
//             its label text.
//   'edit'    an existing authored link's destination (and, when `title` is
//             supplied, its title) is replaced; every other byte survives.
//   'insert'  an empty selection becomes `[insertedText](href)` — the
//             tooltip's own empty-selection semantics, where `insertedText`
//             is the URL it types into the document before marking it.
//
// `visFrom`/`visTo` are VISIBLE offsets inside the block `map` was built for
// (the same convention `toggleInlineMark` uses); `title: undefined` on an
// edit leaves the existing title bytes alone, `title: null`/`''` removes it.
export function applyLinkEdit({ doc, index, map, visFrom, visTo, op, href, title, insertedText }) {
  if (!doc || !index?.tree || !map) return { ok: false, code: 'unsupported-structure' }
  if (!Number.isInteger(visFrom) || !Number.isInteger(visTo) || visTo < visFrom) {
    return { ok: false, code: 'unsupported-structure' }
  }
  if (op !== 'wrap' && op !== 'unwrap' && op !== 'edit' && op !== 'insert') {
    return { ok: false, code: 'unsupported-structure' }
  }

  const wantsHref = op !== 'unwrap'
  if (wantsHref && typeof href !== 'string') return { ok: false, code: 'unsupported-structure' }
  const nextTitle = title === undefined ? undefined : (title == null || title === '' ? null : String(title))
  // A line ending inside any written value would end the block (or the table
  // row) the link lives in — a structural change this command does not own.
  for (const value of [wantsHref ? href : null, nextTitle, op === 'insert' ? insertedText : null]) {
    if (typeof value === 'string' && /[\r\n]/.test(value)) {
      return { ok: false, code: 'unsupported-structure' }
    }
  }
  if (op === 'insert' && (typeof insertedText !== 'string' || !insertedText.length)) {
    return { ok: false, code: 'unsupported-structure' }
  }
  if ((op === 'insert') !== (visFrom === visTo)) return { ok: false, code: 'unsupported-structure' }

  const range = map.rawRangeForVisibleRange(visFrom, visTo)
  if (!range) return { ok: false, code: 'unmapped-selection' }
  const { from: rawFrom, to: rawTo } = range

  const text = doc.text
  const block = phrasingBlockFor(index.tree, rawFrom, rawTo)
  if (!block) return { ok: false, code: 'unmapped-selection' }
  const blockType = block.type
  const blockStart = block.position.start.offset
  const blockEnd = block.position.end.offset
  // An inline HTML fragment is ONE indivisible ProseMirror atom; a `[` or
  // `](url)` injected into its interior would commit an unbalanced fragment.
  if (index.bisectsInlineHtml(rawFrom, rawTo)) return { ok: false, code: 'unsupported-structure' }

  const baselineMap = buildCharacterMap(text, block)
  if (!baselineMap) return { ok: false, code: 'unmapped-selection' }
  const baselineText = flattenText(block)
  const baseline = outerSignature(parseKernelMarkdown(text), blockType, blockStart, blockEnd)

  // ---- unwrap / edit: an existing authored link must cover the range ----
  if (op === 'unwrap' || op === 'edit') {
    const node = authoredLinkWithContent(block, text, rawFrom, rawTo)
    if (!node) return { ok: false, code: 'unsupported-structure' }
    const start = node.position.start.offset
    const end = node.position.end.offset
    const seg = scanLink(text, start, end)
    if (!seg) return { ok: false, code: 'unsupported-structure' }
    // The scan's own label bounds must be the range the caller selected —
    // otherwise the two segmentations disagree and nothing below is provable.
    if (seg.labelStart !== rawFrom || seg.labelEnd !== rawTo) {
      return { ok: false, code: 'unsupported-structure' }
    }

    if (op === 'unwrap') {
      const edits = [
        { from: start, to: rawFrom, insert: '' },
        { from: rawTo, to: end, insert: '' }
      ]
      const openLen = rawFrom - start
      const candidateText = applyEdits(text, edits)
      const ok = verifyCandidate(candidateText, {
        blockType,
        blockStart,
        blockEnd,
        expectedText: baselineText,
        expectedVisibleLength: baselineMap.visibleLength,
        baseline,
        delta: -openLen - (end - rawTo),
        link: null,
        forbidLinkRange: { from: rawFrom - openLen, to: rawTo - openLen }
      })
      if (!ok) return { ok: false, code: 'unsupported-structure' }
      return {
        ok: true,
        transaction: {
          baseRevision: doc.revision,
          edits,
          intent: 'link-unwrap',
          selection: { anchor: rawFrom - openLen, head: rawTo - openLen }
        }
      }
    }

    // edit: destination (+ optional title) only.
    const hasTitle = seg.titleStart >= 0
    const destList = destCandidates(href, seg.angle)
    let titleList
    if (nextTitle === undefined) titleList = [hasTitle ? text.slice(seg.titleStart, seg.titleEnd) : null]
    else if (nextTitle === null) titleList = [null]
    else titleList = titleCandidates(nextTitle, hasTitle ? seg.titleOpen : '')

    let attempts = 0
    for (const [destPick, titlePick] of candidateTuples([destList.length, titleList.length])) {
      if (attempts >= MAX_ATTEMPTS) break
      attempts += 1
      const edits = []
      const push = (from, to, insert) => {
        if (from === to && insert === '') return
        if (text.slice(from, to) === insert) return
        edits.push({ from, to, insert })
      }
      push(seg.destStart, seg.destEnd, destList[destPick])
      const titleBytes = titleList[titlePick]
      if (titleBytes === null) {
        if (hasTitle) push(seg.destEnd, seg.titleEnd, '')
      } else if (hasTitle) {
        push(seg.titleStart, seg.titleEnd, titleBytes)
      } else {
        push(seg.destEnd, seg.destEnd, ` ${titleBytes}`)
      }

      // Nothing to write (the requested URL already IS the source bytes):
      // a zero-width no-op keeps the caller's transaction well-formed.
      if (!edits.length) {
        return {
          ok: true,
          transaction: {
            baseRevision: doc.revision,
            edits: [{ from: rawFrom, to: rawFrom, insert: '' }],
            intent: 'link-edit',
            selection: { anchor: rawFrom, head: rawTo }
          }
        }
      }

      const delta = edits.reduce((sum, edit) => sum + edit.insert.length - (edit.to - edit.from), 0)
      const candidateText = applyEdits(text, edits)
      const expectedTitle = nextTitle === undefined ? (node.title ?? null) : nextTitle
      const ok = verifyCandidate(candidateText, {
        blockType,
        blockStart,
        blockEnd,
        expectedText: baselineText,
        expectedVisibleLength: baselineMap.visibleLength,
        baseline,
        delta,
        link: { start, end: end + delta, url: href, title: expectedTitle, label: flattenText(node) }
      })
      if (!ok) continue
      return {
        ok: true,
        transaction: {
          baseRevision: doc.revision,
          edits,
          intent: 'link-edit',
          // Every edit sits after the label, so the label's own offsets survive.
          selection: { anchor: rawFrom, head: rawTo }
        }
      }
    }
    return { ok: false, code: 'unsupported-structure' }
  }

  // ---- insert: an empty selection becomes a whole new link ----
  if (op === 'insert') {
    // A caret parked STRICTLY inside an existing link would nest one link in
    // another (not expressible in CommonMark); on either edge is fine.
    if (linkStrictlyContaining(block, rawFrom)) return { ok: false, code: 'unsupported-structure' }
    const labelList = [insertedText, escapeWith(insertedText, LABEL_ESCAPE)]
    const destList = destCandidates(href, false)
    const titleList = nextTitle == null ? [null] : titleCandidates(nextTitle, '')
    let attempts = 0
    for (const [labelPick, destPick, titlePick] of candidateTuples([labelList.length, destList.length, titleList.length])) {
      if (attempts >= MAX_ATTEMPTS) break
      attempts += 1
      const titleBytes = titleList[titlePick]
      const bytes = `[${labelList[labelPick]}](${destList[destPick]}${titleBytes === null ? '' : ` ${titleBytes}`})`
      const edits = [{ from: rawFrom, to: rawFrom, insert: bytes }]
      const candidateText = applyEdits(text, edits)
      const visiblePos = visFrom
      const expectedText = baselineText.slice(0, visiblePos) + insertedText + baselineText.slice(visiblePos)
      const ok = verifyCandidate(candidateText, {
        blockType,
        blockStart,
        blockEnd,
        expectedText,
        expectedVisibleLength: baselineMap.visibleLength + insertedText.length,
        baseline,
        delta: bytes.length,
        link: {
          start: rawFrom,
          end: rawFrom + bytes.length,
          url: href,
          title: nextTitle == null ? null : nextTitle,
          label: insertedText
        }
      })
      if (!ok) continue
      const labelEnd = rawFrom + 1 + labelList[labelPick].length
      return {
        ok: true,
        transaction: {
          baseRevision: doc.revision,
          edits,
          intent: 'link-insert',
          selection: { anchor: labelEnd, head: labelEnd }
        }
      }
    }
    return { ok: false, code: 'unsupported-structure' }
  }

  // ---- wrap: the selection becomes a link's label ----
  if (rawFrom >= rawTo) return { ok: false, code: 'unsupported-structure' }
  if (intersectsLink(block, rawFrom, rawTo)) return { ok: false, code: 'unsupported-structure' }
  if (hasPartialOverlap(block, rawFrom, rawTo)) return { ok: false, code: 'unsupported-structure' }

  const escapes = bracketEscapeEdits(block, text, rawFrom, rawTo)
  const labelPlans = escapes.length ? [[], escapes] : [[]]
  const destList = destCandidates(href, false)
  const titleList = nextTitle == null ? [null] : titleCandidates(nextTitle, '')
  let attempts = 0
  for (const [labelPick, destPick, titlePick] of candidateTuples([labelPlans.length, destList.length, titleList.length])) {
    if (attempts >= MAX_ATTEMPTS) break
    attempts += 1
    const titleBytes = titleList[titlePick]
    const tail = `](${destList[destPick]}${titleBytes === null ? '' : ` ${titleBytes}`})`
    const edits = [
      { from: rawFrom, to: rawFrom, insert: '[' },
      ...labelPlans[labelPick],
      { from: rawTo, to: rawTo, insert: tail }
    ]
    const delta = edits.reduce((sum, edit) => sum + edit.insert.length - (edit.to - edit.from), 0)
    const candidateText = applyEdits(text, edits)
    const ok = verifyCandidate(candidateText, {
      blockType,
      blockStart,
      blockEnd,
      expectedText: baselineText,
      expectedVisibleLength: baselineMap.visibleLength,
      baseline,
      delta,
      link: {
        start: rawFrom,
        end: rawTo + delta,
        url: href,
        title: nextTitle == null ? null : nextTitle,
        label: baselineText.slice(visFrom, visTo)
      }
    })
    if (!ok) continue
    const labelDelta = labelPlans[labelPick].length
    return {
      ok: true,
      transaction: {
        baseRevision: doc.revision,
        edits,
        intent: 'link-wrap',
        // Keep the label content selected (the mark commands' contract, so a
        // follow-up toolbar action still has a range to act on).
        selection: { anchor: rawFrom + 1, head: rawTo + 1 + labelDelta }
      }
    }
  }
  return { ok: false, code: 'unsupported-structure' }
}
