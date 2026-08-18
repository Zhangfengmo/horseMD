// 标题首个内容位置的空白字符：只能以字符实体形式写入源码。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
//
// WHY THIS COMMAND EXISTS
// ----------------------
// In CommonMark an ATX heading is `[≤3 spaces] #{1,6} [ \t]+ content`. The
// spacing run between the marker and the content is SYNTAX, not content: the
// parser consumes as much of it as it finds. So the first content position of
// `## Title` (raw offset 3) is the one offset in that block where a LITERAL
// whitespace byte is not addressable — commit ' ' there and the bytes become
// `##  Title`, whose reparse is still the heading `Title`. The byte survives
// on disk, the character never appears, and the kernel's own projection check
// then repairs the VIEW back to what the bytes say. That is exactly what
// kernel mode did before this command existed, for both Space and Tab
// ("为啥标题前面无法使用 tab 或者空格").
//
// The cure is the one HorseMD's legacy (rich-authoritative) writer already
// ships for this same shape: spell the character as a character REFERENCE,
// which the parser decodes AFTER it has finished eating the marker's spacing,
// so it is content. The spellings below are byte-identical to the ones legacy
// commits (`src/renderer/src/lib/markdown-preservation/core.js` writes
// `&nbsp;` for a leading space; `components/editor-list-style.js` writes
// `&#x9;` for a tab), and are locked by
// `scripts/test-heading-leading-tab-source-ui.mjs` +
// `scripts/test-scratch-heading-leading-whitespace-ui.mjs` on the legacy side.
// A document edited in either mode therefore reads the same bytes.
//
// `&nbsp;` decodes to U+00A0, not U+0020 — deliberately, and NOT merely for
// legacy parity. A leading `&#x20;` would decode to a plain space, which
// every downstream Markdown renderer (and HorseMD's own reparse of a
// re-serialized file) is free to collapse again; NBSP is the character that
// actually survives being a leading space. Kernel mode is source-authoritative,
// so the view follows the bytes: the caret ends up after a real NBSP. Legacy
// keeps a plain space in the rich document and normalizes NBSP↔space when it
// compares (`components/editor-durable-semantics.js`), so the two modes agree
// on the FILE, which is the contract that matters.
//
// FAIL-CLOSED. This command never guesses. It refuses in two distinguishable
// ways:
//   * `not-structural` — "this offset is not an ATX heading's first content
//     position". The caller must fall through to whatever it did before;
//     nothing about this shape has changed.
//   * `unsupported-structure` — "it IS that position, but the entity form
//     could not be PROVEN". The caller must refuse loudly, because the literal
//     byte is known-wrong here.
// The proof is a real reparse of the candidate document plus a unit-by-unit
// comparison of the heading's character map before and after: the only
// difference allowed is ONE new width-1 `entity` unit at the insert point,
// every other unit shifted by exactly the entity's byte length, and the
// heading's decoded text equal to the promised character followed by the
// original text.
import { parseKernelMarkdown } from '../syntax-index.js'
import { buildCharacterMap } from '../character-map.js'

export const HEADING_LEADING_WHITESPACE_ENTITY = Object.freeze({
  ' ': '&nbsp;',
  '\t': '&#x9;'
})

// What each entity must DECODE to. Checked against the reparsed heading's own
// text, so a parser that ever disagreed with this table would refuse rather
// than commit a spelling that means something else.
const DECODED = Object.freeze({
  // U+00A0, written as an escape so the table can never be edited by
  // accident into an ordinary space.
  ' ': '\u00A0',
  '\t': '\t'
})

const NOT_STRUCTURAL = { ok: false, code: 'not-structural' }
const UNSUPPORTED = { ok: false, code: 'unsupported-structure' }

// The full ATX opening: optional ≤3 spaces of indentation, the `#` run, then
// the REQUIRED spacing run. The trailing `[ \t]+` is load-bearing — a bare
// `##` (an empty heading with no spacing) has no content position at all:
// anything written straight after the marker makes the line a PARAGRAPH, so
// this returns null and the caller keeps its existing behaviour. Setext
// headings have no `#` run and are likewise never matched.
const ATX_OPENING_RE = /^ {0,3}#{1,6}[ \t]+/

// Raw offset of an ATX heading's first content byte, derived from the block's
// own bytes — no text search, no guess. Returns null when the shape is not an
// ATX heading with real spacing.
const atxContentStart = (text, node) => {
  if (node?.type !== 'heading') return null
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  const opening = text.slice(start, end).match(ATX_OPENING_RE)
  if (!opening) return null
  return start + opening[0].length
}

// Cheap, parse-free PREFILTER for hot paths (editor-kernel-gateway.js's
// per-keystroke plain-text commit): could `rawOffset` be an ATX heading's first
// content position? Walks backwards over the spacing run and then over the `#`
// run — no line scan, so it is container-agnostic (a blockquoted or list-nested
// heading answers `true` just like a top-level one).
//
// It is a NECESSARY condition, never a sufficient one: `'a #  b'` and a `#`
// inside a fenced code block both pass it. `insertHeadingLeadingWhitespace` is
// the authority; this only decides whether it is worth asking.
export const looksLikeAtxContentStart = (text, rawOffset) => {
  if (typeof text !== 'string' || !Number.isInteger(rawOffset)) return false
  if (rawOffset <= 0 || rawOffset > text.length) return false
  let index = rawOffset
  while (index > 0 && (text[index - 1] === ' ' || text[index - 1] === '\t')) index -= 1
  if (index === rawOffset) return false
  let hashes = 0
  while (index > 0 && text[index - 1] === '#') {
    index -= 1
    hashes += 1
  }
  return hashes >= 1 && hashes <= 6
}

const eachHeading = (tree, visit) => {
  const walk = (node) => {
    if (node?.type === 'heading') {
      visit(node)
      return
    }
    for (const child of node?.children || []) walk(child)
  }
  walk(tree)
}

// Pre-order BLOCK-type walk of the whole document, stopping at any node that
// is not a block container. Offsets are deliberately not part of it (every
// offset after the insert point shifts by construction); what it proves is
// that no block appeared, disappeared or changed kind — the same posture
// `editor-kernel-gateway.js`'s table-structure proof takes, and it stops at
// the same granularity, for the same reason: the edited block's own inline
// content is precisely what changed, and it is proven separately (by the
// decoded-text equality and the unit-by-unit comparison below).
//
// Stopping matters here, not just for cost: an EMPTY heading gains its first
// `text` child from this very edit, so a walk that descended into phrasing
// would report "the tree changed" for the one shape the command exists to
// support.
const BLOCK_CONTAINERS = new Set([
  'root', 'blockquote', 'list', 'listItem', 'footnoteDefinition'
])

const typeSignature = (tree) => {
  const out = []
  const walk = (node) => {
    out.push(node?.type)
    if (!BLOCK_CONTAINERS.has(node?.type)) return
    for (const child of node?.children || []) walk(child)
  }
  walk(tree)
  return out.join(' ')
}

// Decoded text of one heading, in document order. `value`-bearing leaves
// (`text`, `inlineCode`) are the only inline nodes that carry characters; an
// atom (image/break/html/math) contributes nothing here, which is fine — the
// unit comparison below is what pins those.
const headingText = (node) => {
  const out = []
  const walk = (n) => {
    if (typeof n?.value === 'string') out.push(n.value)
    for (const child of n?.children || []) walk(child)
  }
  for (const child of node?.children || []) walk(child)
  return out.join('')
}

const unitsShiftBy = (before, after, shift) => {
  if (after.length !== before.length) return false
  for (let index = 0; index < before.length; index += 1) {
    const a = before[index]
    const b = after[index]
    if (!a || !b) return false
    if (a.kind !== b.kind || a.width !== b.width) return false
    if (b.rawStart !== a.rawStart + shift || b.rawEnd !== a.rawEnd + shift) return false
  }
  return true
}

export function insertHeadingLeadingWhitespace({ doc, offset, character }) {
  const entity = HEADING_LEADING_WHITESPACE_ENTITY[character]
  if (!entity) return NOT_STRUCTURAL
  const text = doc?.text
  if (typeof text !== 'string' || !Number.isInteger(offset)) return NOT_STRUCTURAL
  if (!Number.isInteger(doc?.revision)) return NOT_STRUCTURAL

  let tree
  try {
    tree = parseKernelMarkdown(text)
  } catch {
    return NOT_STRUCTURAL
  }
  let heading = null
  eachHeading(tree, (node) => {
    if (heading) return
    if (atxContentStart(text, node) === offset) heading = node
  })
  if (!heading) return NOT_STRUCTURAL

  // Past this point the offset IS the position CommonMark strips, so a literal
  // byte is known-wrong: every remaining failure is a REFUSAL, never a
  // fall-through.
  const start = heading.position.start.offset
  const end = heading.position.end.offset
  const before = buildCharacterMap(text, heading)
  if (!before) return UNSUPPORTED

  const candidate = text.slice(0, offset) + entity + text.slice(offset)
  let candidateTree
  try {
    candidateTree = parseKernelMarkdown(candidate)
  } catch {
    return UNSUPPORTED
  }
  if (typeSignature(tree) !== typeSignature(candidateTree)) return UNSUPPORTED

  let after = null
  eachHeading(candidateTree, (node) => {
    if (after) return
    if (node.position?.start?.offset === start) after = node
  })
  if (!after) return UNSUPPORTED
  if (after.depth !== heading.depth) return UNSUPPORTED
  if (after.position?.end?.offset !== end + entity.length) return UNSUPPORTED
  if (headingText(after) !== DECODED[character] + headingText(heading)) return UNSUPPORTED

  const map = buildCharacterMap(candidate, after)
  if (!map) return UNSUPPORTED
  if (map.visibleLength !== before.visibleLength + 1) return UNSUPPORTED
  const head = map.units[0]
  if (head?.kind !== 'entity' || head.width !== 1) return UNSUPPORTED
  if (head.rawStart !== offset || head.rawEnd !== offset + entity.length) return UNSUPPORTED
  if (!unitsShiftBy(before.units, map.units.slice(1), entity.length)) return UNSUPPORTED

  const caret = offset + entity.length
  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      from: offset,
      to: offset,
      insert: entity,
      intent: 'heading-leading-whitespace',
      selection: { anchor: caret, head: caret }
    }
  }
}
