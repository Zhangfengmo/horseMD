// 标题首个内容位置的空白字符：写入真正的不换行空格（U+00A0），不写实体。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
//
// WHY THIS COMMAND EXISTS
// ----------------------
// In CommonMark an ATX heading is `[≤3 spaces] #{1,6} [ \t]+ content`. The
// spacing run between the marker and the content is SYNTAX, not content: the
// parser consumes as much of it as it finds. So the first content position of
// `## Title` (raw offset 3) is the one offset in that block where a LITERAL
// ASCII whitespace byte is not addressable — commit ' ' there and the bytes
// become `##  Title`, whose reparse is still the heading `Title`. The byte
// survives on disk, the character never appears, and the kernel's own
// projection check then repairs the VIEW back to what the bytes say. That is
// exactly what kernel mode did before this command existed, for both Space and
// Tab ("为啥标题前面无法使用 tab 或者空格").
//
// WHAT IS WRITTEN, AND WHY IT IS NOT AN ENTITY (2026-08-18, user decision).
// The first version of this command wrote a character REFERENCE (`&nbsp;` /
// `&#x9;`) — byte-identical to what HorseMD's legacy writer emits. The user
// rejected that outright after seeing it in source mode:
//   「源码模式里，不接受这个写法」
//   「这种 tab 字符或者空格的字符都不能直接在源码渲染」
//   「就是空白，类似于在源码中也是空格，tab 可能是两个，specs 这种可能是一个」
// The source file must therefore hold real whitespace CHARACTERS. The only
// whitespace character CommonMark does NOT strip here is U+00A0 (no-break
// space): the ATX spacing run is `[ \t]+`, ASCII only, so a raw U+00A0 ends the
// run and becomes the heading's first content character. Measured, not assumed:
//   '# \u00A0标题'   -> heading text '\u00A0标题'
// and its character map holds an ordinary width-1 `char` unit, so it is
// caret-addressable and one Backspace deletes it — no entity machinery at all.
//
// Space -> ONE U+00A0, Tab -> TWO (the user's own proportion). A Tab cannot be
// written literally for the same reason a space cannot, and a tab-width run of
// no-break spaces is the closest thing that is both real whitespace in the
// source and visible in the view.
//
// LEGACY DIVERGENCE, deliberate and recorded. Legacy (rich-authoritative) keeps
// writing the entity spelling for this shape, and
// `scripts/test-heading-leading-tab-source-ui.mjs` /
// `scripts/test-scratch-heading-leading-whitespace-ui.mjs` still assert it —
// correctly, FOR LEGACY. The two modes now spell the same CHARACTER differently
// (`&nbsp;` and a raw U+00A0 both decode to U+00A0). That is accepted: the user
// has decided legacy will be removed (「旧模式不用管，后续可以直接剔除」), so
// byte-identical output between the modes is no longer a goal. Legacy behaviour
// itself is unchanged.
//
// FAIL-CLOSED. This command never guesses. It refuses in two distinguishable
// ways:
//   * `not-structural` — "this offset is not an ATX heading's first content
//     position". The caller must fall through to whatever it did before;
//     nothing about this shape has changed.
//   * `unsupported-structure` — "it IS that position, but the written form
//     could not be PROVEN". The caller must refuse loudly, because the literal
//     ASCII byte is known-wrong here.
// The proof is a real reparse of the candidate document plus a unit-by-unit
// comparison of the heading's character map before and after: the only
// difference allowed is the new width-1 `char` units at the insert point, every
// other unit shifted by exactly their byte length, and the heading's decoded
// text equal to the promised characters followed by the original text.
import { parseKernelMarkdown } from '../syntax-index.js'
import { buildCharacterMap } from '../character-map.js'

// The bytes written per typed character. Real characters, not references:
// U+00A0 is written as an escape here so the table can never be edited by
// accident into an ordinary space (which the parser WOULD strip).
export const HEADING_LEADING_WHITESPACE_TEXT = Object.freeze({
  ' ': '\u00A0',
  '\t': '\u00A0\u00A0'
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
  const written = HEADING_LEADING_WHITESPACE_TEXT[character]
  if (!written) return NOT_STRUCTURAL
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
  // ASCII byte is known-wrong: every remaining failure is a REFUSAL, never a
  // fall-through.
  const start = heading.position.start.offset
  const end = heading.position.end.offset
  const before = buildCharacterMap(text, heading)
  if (!before) return UNSUPPORTED

  const candidate = text.slice(0, offset) + written + text.slice(offset)
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
  if (after.position?.end?.offset !== end + written.length) return UNSUPPORTED
  // The written form is LITERAL, so what it must decode to is itself.
  if (headingText(after) !== written + headingText(heading)) return UNSUPPORTED

  const map = buildCharacterMap(candidate, after)
  if (!map) return UNSUPPORTED
  if (map.visibleLength !== before.visibleLength + written.length) return UNSUPPORTED
  // Every written character must have become its OWN width-1 `char` unit at the
  // insert point — i.e. the user can put the caret between them and delete them
  // one at a time, which an entity (one unit for several bytes) could not offer.
  for (let index = 0; index < written.length; index += 1) {
    const unit = map.units[index]
    if (unit?.kind !== 'char' || unit.width !== 1) return UNSUPPORTED
    if (unit.rawStart !== offset + index || unit.rawEnd !== offset + index + 1) return UNSUPPORTED
  }
  if (!unitsShiftBy(before.units, map.units.slice(written.length), written.length)) return UNSUPPORTED

  const caret = offset + written.length
  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      from: offset,
      to: offset,
      insert: written,
      intent: 'heading-leading-whitespace',
      selection: { anchor: caret, head: caret }
    }
  }
}
