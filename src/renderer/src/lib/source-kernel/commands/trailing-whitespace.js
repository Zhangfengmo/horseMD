// 块尾空白：CommonMark 会剥掉块末尾的空白，所以那里的字面空格是死字节。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
//
// WHY THIS COMMAND EXISTS
// ----------------------
// CommonMark strips the whitespace at the END of a paragraph's / heading's raw
// content (and GFM strips a table cell's padding). So the LAST offset of a
// block is a second position — after `heading-whitespace.js`'s first one —
// where a literal whitespace byte is written to disk and then never appears
// again. Measured in kernel mode before this command existed:
//
//   paragraph '末段。' + typing 'a', ' ', 'b'  ->  source '末段。ab '
//                                                 view   '末段。ab'
//
// The space is committed at the block's end (dead), the view is repaired back
// to what the bytes say (so the character is gone), and the NEXT character maps
// to the block's content end — i.e. BEFORE the stranded byte. The user typed
// `a b`; the file holds `ab ` and the screen shows `ab`. Because prose is
// composed left to right, the caret is at a block end for essentially every
// inter-word space, so this is not an edge case.
//
// A blanket refusal is the wrong cure for the same reason: it would fire on
// every space in English prose, and it would still lose the character. What
// makes the character survivable is a SPELLING the parser decodes AFTER it has
// finished stripping — a character reference, the same device
// `heading-whitespace.js` uses at the other end of the block:
//
//   'a&#32;'   -> paragraph text 'a '   (U+0020, the character actually typed)
//   'a&#9;'    -> paragraph text 'a\t'
//
// `&#32;` and NOT `&nbsp;` here (heading-whitespace.js deliberately chose the
// opposite). That module had to match the bytes HorseMD's legacy writer already
// emits for a heading's leading space, and a leading space needs NBSP to
// survive downstream collapsing. A block-trailing space has no legacy byte to
// match (legacy drops it entirely) and is TRANSIENT: the moment the next
// character arrives the entity is rewritten back to a literal space (see
// `tail` below), so the file ends up byte-identical to what any other editor
// would write. Spelling it as the character the user actually pressed is
// therefore both faithful and temporary; NBSP would be a different character
// baked permanently into the middle of a sentence.
//
// THE SELF-HEAL IS THE POINT, not an optimisation. Without it every space in
// the document would be `&#32;`, since every space is typed at a block end.
// With it:
//
//   type ' '  -> 'a&#32;'          (visible, caret-addressable, on disk)
//   type 'b'  -> 'a b'             (the entity is rewritten to the literal
//                                   space in the SAME edit as the 'b')
//
// so the steady state of an ordinary sentence is ordinary bytes, and the entity
// exists only while the space is genuinely the last thing in the block.
//
// FAIL-CLOSED. Nothing here is decided by construction. The candidate document
// is REPARSED and the edited block's decoded text must equal the baseline text
// plus exactly the character the user pressed, with the document's block
// structure unchanged and the block's own span shifted by exactly the byte
// delta. This is the "a committed edit must be observable in the reparse"
// invariant stated for this shape: it is what neither the projection check
// (view vs bytes — both had already lost the character) nor a mapper's
// `preserved:true` can establish.
import { parseKernelMarkdown } from '../syntax-index.js'

// The portable spelling per typed character. Numeric references, so no HTML
// named-entity table is involved on the way back in.
export const BLOCK_TRAILING_ENTITY = Object.freeze({
  ' ': '&#32;',
  '\t': '&#9;'
})

// The inverse table — deliberately a CLOSED set of the exact spellings this
// module writes. A `&nbsp;` (heading-whitespace.js's spelling), a `&#x20;` from
// another tool or a hand-authored `&#032;` is NOT rewritten: literalizing a
// byte sequence this module did not author would silently rewrite the user's
// own source.
export const TRAILING_ENTITY_LITERAL = Object.freeze({
  '&#32;': ' ',
  '&#9;': '\t'
})

const NOT_STRUCTURAL = { ok: false, code: 'not-structural' }
const UNSUPPORTED = { ok: false, code: 'unsupported-structure' }

// Blocks whose trailing whitespace CommonMark/GFM discards. Deliberately an
// allowlist of the three shapes probed for this task:
//   paragraph / heading — the block's raw content has its final whitespace run
//                         stripped before inline parsing.
//   tableCell           — GFM strips a cell's padding on both sides.
// Everything else keeps its pre-existing behaviour, and the two that matter are
// excluded ON PURPOSE:
//   `code`  — trailing spaces inside a fenced block ARE content and are already
//             byte-preserved; touching them would corrupt real data.
//   `math`  — same, `$$` blocks are verbatim.
const TAIL_STRIPPING_BLOCKS = new Set(['paragraph', 'heading', 'tableCell'])

// Containers the structure walk descends through. Anything not listed here is
// a leaf for signature purposes — including `paragraph`/`heading`/`tableCell`,
// whose inline content is exactly what this edit changes and is proven
// separately (by the decoded-text equality below). `table`/`tableRow` ARE
// descended so a cell edit that changed the table's shape is caught.
const CONTAINERS = new Set([
  'root', 'blockquote', 'list', 'listItem', 'footnoteDefinition', 'table', 'tableRow'
])

const structureSignature = (tree) => {
  const out = []
  const walk = (node) => {
    out.push(node?.type)
    if (!CONTAINERS.has(node?.type)) return
    for (const child of node?.children || []) walk(child)
  }
  walk(tree)
  return out.join(' ')
}

// Decoded text of one block, in document order. `value`-bearing leaves (`text`,
// `inlineCode`) are the only inline nodes carrying characters; atoms
// (image/break/html/math) contribute nothing, which is why the structure
// signature and the span check are part of the proof too.
const blockText = (node) => {
  const out = []
  const walk = (n) => {
    if (typeof n?.value === 'string') out.push(n.value)
    for (const child of n?.children || []) walk(child)
  }
  for (const child of node?.children || []) walk(child)
  return out.join('')
}

const isSpaceOrTab = (ch) => ch === ' ' || ch === '\t'

// Would a LITERAL whitespace byte written at `offset` be stripped again?
//
// Parse-free and exact: walk forward over the whitespace run that starts at
// `offset` and look at what stops it. The run is discarded when it reaches
//   * the block's own end offset — a paragraph's/heading's final whitespace
//     run (mdast's block span INCLUDES those bytes, probed), or
//   * a `|` inside a table cell — GFM cell padding.
// Anything else (a `\n` inside a multi-line paragraph, a heading's closing `#`
// run, real content) stops the run somewhere this predicate does not claim, and
// it answers `false` so the caller keeps the literal byte.
//
// NOTE the deliberate `\n` exclusion: a run ending at a line ending INSIDE a
// paragraph is the two-space HARD BREAK's own syntax. Re-spelling it would
// change what the line ending means, so that shape is never claimed here.
export const literalTailIsStripped = (text, block, offset) => {
  if (typeof text !== 'string' || !Number.isInteger(offset)) return false
  if (!TAIL_STRIPPING_BLOCKS.has(block?.type)) return false
  const end = block?.position?.end?.offset
  if (!Number.isInteger(end) || offset > end) return false
  let index = offset
  while (index < end && isSpaceOrTab(text[index])) index += 1
  if (index >= end) return true
  return block.type === 'tableCell' && text[index] === '|'
}

// Is the character map's LAST unit one of the entity spellings this module
// itself wrote? Returns `{ rawStart, rawEnd, literal }` or null. Used by the
// caller as a parse-free prefilter and re-derived here as part of the proof.
export const trailingEntityTail = (text, charMap) => {
  const units = charMap?.units
  if (!Array.isArray(units) || !units.length) return null
  const unit = units[units.length - 1]
  if (unit?.kind !== 'entity' || unit.width !== 1) return null
  if (!Number.isInteger(unit.rawStart) || !Number.isInteger(unit.rawEnd)) return null
  const spelling = text.slice(unit.rawStart, unit.rawEnd)
  const literal = TRAILING_ENTITY_LITERAL[spelling]
  if (!literal) return null
  return { rawStart: unit.rawStart, rawEnd: unit.rawEnd, literal }
}

// The observability proof, shared with the caller's own post-commit check.
// Given a candidate document, the baseline block and the text that block must
// decode to, prove that the candidate really says so:
//   1. the document's block structure is unchanged;
//   2. a block of the same type still starts at the same offset;
//   3. its span grew by exactly the byte delta;
//   4. its decoded text is EXACTLY the expected string.
// (4) is the one the projection check cannot make: view-vs-bytes agreement is
// preserved when a character is lost on BOTH sides.
export function blockEditIsObservable({ baselineTree, block, candidate, expectedText, delta }) {
  let candidateTree
  try {
    candidateTree = parseKernelMarkdown(candidate)
  } catch {
    return false
  }
  if (structureSignature(baselineTree) !== structureSignature(candidateTree)) return false
  const start = block?.position?.start?.offset
  const end = block?.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false
  let found = null
  const walk = (node) => {
    if (found) return
    if (node?.type === block.type && node.position?.start?.offset === start) {
      found = node
      return
    }
    for (const child of node?.children || []) walk(child)
  }
  walk(candidateTree)
  if (!found) return false
  if (found.position?.end?.offset !== end + delta) return false
  return blockText(found) === expectedText
}

// Spell ONE character inserted at a block's visible end so that it survives the
// reparse — and, in the same edit, rewrite the entity this module wrote for the
// PREVIOUS character back to its literal form now that it is no longer last.
//
// Inputs (all supplied by the caller from state it already holds — this command
// performs exactly ONE parse, of the candidate it is about to propose):
//   doc      the kernel document (`text` + `revision`)
//   block    the mdast node the projection map already paired with this
//            textblock (`pair.mdBlock`) — its span is the baseline
//   offset    the raw insert offset (the caller proved it is the block's
//            visible end)
//   insert    exactly one code point, no line breaks
//   tail      `trailingEntityTail(...)` for this block, or null
//
// Refusals:
//   `not-structural`        — this shape is not claimed; the caller keeps the
//                             literal byte and nothing changes.
//   `unsupported-structure` — the shape IS claimed and no spelling could be
//                             proven; the caller must refuse rather than write
//                             the byte we just proved is dead.
export function spellBlockTailInsert({ doc, block, offset, insert, tail = null }) {
  const text = doc?.text
  if (typeof text !== 'string' || !Number.isInteger(doc?.revision)) return NOT_STRUCTURAL
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return NOT_STRUCTURAL
  if (typeof insert !== 'string' || !insert || /[\r\n]/.test(insert)) return NOT_STRUCTURAL
  if ([...insert].length !== 1) return NOT_STRUCTURAL
  if (!TAIL_STRIPPING_BLOCKS.has(block?.type)) return NOT_STRUCTURAL
  const blockStart = block?.position?.start?.offset
  const blockEnd = block?.position?.end?.offset
  if (!Number.isInteger(blockStart) || !Number.isInteger(blockEnd)) return NOT_STRUCTURAL
  if (offset < blockStart || offset > blockEnd) return NOT_STRUCTURAL

  // Re-derive the tail from the bytes rather than trusting the caller's
  // prefilter: this decides whether five bytes of the user's source get
  // rewritten, so it is proven here too.
  const useTail = tail && tail.rawEnd === offset &&
    TRAILING_ENTITY_LITERAL[text.slice(tail.rawStart, tail.rawEnd)] === tail.literal
    ? tail
    : null

  // `literalTailIsStripped` is re-derived here even though the caller already
  // ran it as a parse-free prefilter: it decides whether a literal byte is
  // known-dead, which is the whole reason this command may rewrite the source.
  const entity = BLOCK_TRAILING_ENTITY[insert]
  const needsEntity = !!entity && literalTailIsStripped(text, block, offset)
  // Nothing to do: an ordinary character that does not follow one of our
  // entities is already byte-exact through the plain path.
  if (!needsEntity && !useTail) return NOT_STRUCTURAL

  let baselineTree
  try {
    baselineTree = parseKernelMarkdown(text)
  } catch {
    return UNSUPPORTED
  }
  // The baseline block is re-read from THIS parse (the caller's `block` may
  // come from a map bound to the same bytes, but the proof must not depend on
  // that): same type, same start offset, same end offset.
  let baseline = null
  const walk = (node) => {
    if (baseline) return
    if (node?.type === block.type && node.position?.start?.offset === blockStart &&
        node.position?.end?.offset === blockEnd) {
      baseline = node
      return
    }
    for (const child of node?.children || []) walk(child)
  }
  walk(baselineTree)
  if (!baseline) return NOT_STRUCTURAL

  const from = useTail ? useTail.rawStart : offset
  const to = useTail ? useTail.rawEnd : offset
  const written = (useTail ? useTail.literal : '') + (needsEntity ? entity : insert)
  const candidate = text.slice(0, from) + written + text.slice(to)
  const delta = written.length - (to - from)
  const expectedText = blockText(baseline) + insert

  if (!blockEditIsObservable({ baselineTree, block: baseline, candidate, expectedText, delta })) {
    // A claimed shape whose spelling could not be proven. Refusing is the only
    // honest answer: the literal byte is the thing we already know is dead.
    return UNSUPPORTED
  }

  const caret = from + written.length
  return {
    ok: true,
    spelling: needsEntity ? 'entity' : 'literal',
    healed: !!useTail,
    edit: { from, to, insert: written },
    transaction: {
      baseRevision: doc.revision,
      from,
      to,
      insert: written,
      intent: 'block-trailing-whitespace',
      selection: { anchor: caret, head: caret }
    }
  }
}
