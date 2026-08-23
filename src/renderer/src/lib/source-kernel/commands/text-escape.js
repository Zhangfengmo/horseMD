// THE ONE TYPING-SPELLING POLICY (docs/typing-policy-chokepoint-adr.md).
// 本目录(source-kernel)禁止 import electron/react/@milkdown。
//
// A plain-text insert whose LITERAL bytes would restructure the document
// (mint a list marker, deepen a quote, open a heading…) is respelled with
// CommonMark backslash escapes — the same answer remark's own serializer
// gives, driven by the same data: mdast-util-to-markdown's `unsafe` table.
// One function, consulted from every commit channel (gateway plain-text
// core, the kernel edit primitive, the IME commit) — the per-channel policy
// copies this replaced are the route-blindness family's structural end.
//
// TWO LAYERS, cheap gate then real proof:
//   * GATE — the unsafe table. Each entry names a character plus its
//     dangerous context (`atBreak`, `before`, `after` regexes). Only an
//     insert containing a table character in a plausibly-matching context
//     pays for parses; ordinary letters/CJK return null immediately, so the
//     hot typing path stays parse-free (perf assessment §9 discipline).
//   * PROOF — double reparse. The literal candidate must GENUINELY change
//     the block skeleton (otherwise literal is correct: decimals, mid-word
//     dots), and the escaped candidate must keep the skeleton identical
//     while its text leaves grow by exactly the insert's visible content
//     (which also fails closed inside code/math, where a backslash would BE
//     content). Anything unprovable answers null and the caller commits the
//     literal bytes exactly as before — this module can only ever narrow
//     silent restructuring, never widen anything.
//
// The deep node_modules path is deliberate: the package's `exports` exposes
// only its root, and the ADR requires consuming the package's OWN table —
// a vendored copy would drift from the parser it must mirror.
import { unsafe } from '../../../../../../node_modules/mdast-util-to-markdown/lib/unsafe.js'
import { parseKernelMarkdown } from '../syntax-index.js'

const UNSAFE_BY_CHAR = new Map()
for (const entry of unsafe) {
  if (typeof entry.character !== 'string' || entry.character.length !== 1) continue
  if (entry.character === '\n' || entry.character === '\r' || entry.character === ' ' || entry.character === '\t') continue
  if (!UNSAFE_BY_CHAR.has(entry.character)) UNSAFE_BY_CHAR.set(entry.character, [])
  UNSAFE_BY_CHAR.get(entry.character).push(entry)
}

// CommonMark backslash escapes apply to ASCII punctuation only.
const ESCAPABLE_PUNCT = /[!-/:-@[-`{-~]/

// Generous line-prefix shape for the `atBreak` gate: everything a block
// line's structural prefix (indentation, quote markers, list markers, task
// brackets) can be made of. Generosity here only costs a parse — the proof
// decides the truth.
const BREAK_PREFIX = /^[ \t>*+\-\d.)[\]xX]*$/

const lineStartBefore = (text, position) => {
  for (let i = position - 1; i >= 0; i -= 1) {
    const ch = text[i]
    if (ch === '\n' || ch === '\r') return i + 1
  }
  return 0
}

const gateMatches = (virtualText, position, ch) => {
  const entries = UNSAFE_BY_CHAR.get(ch)
  if (!entries) return false
  for (const entry of entries) {
    if (entry.before) {
      try {
        if (!new RegExp(entry.before + '$').test(virtualText.slice(Math.max(0, position - 32), position))) continue
      } catch { /* a table regex this engine rejects: fall through to generous */ }
    } else if (entry.atBreak) {
      const start = lineStartBefore(virtualText, position)
      if (!BREAK_PREFIX.test(virtualText.slice(start, position))) continue
    }
    if (entry.after) {
      try {
        if (!new RegExp('^(?:' + entry.after + ')').test(virtualText.slice(position + 1))) continue
      } catch { /* ditto */ }
    }
    return true
  }
  return false
}

// BLOCK-level nodes only, by whitelist. The policy's charter (the ADR) is
// preventing BLOCK restructuring — minted lists, deepened quotes, opened
// headings. INLINE formation (emphasis/strong/strike closing over existing
// delimiters) is deliberate user Markdown and is owned by the mark
// input-rule path with its own reparse proof; counting inline containers
// here made the policy escape the CLOSING `*` of `*斜*` and break marks
// (caught by mode-headless Case IR1 — the reason this is a whitelist).
const BLOCK_TYPES = new Set(['root', 'paragraph', 'heading', 'list',
  'listItem', 'blockquote', 'code', 'thematicBreak', 'table', 'tableRow',
  'tableCell', 'html', 'math', 'yaml'])
const blockSignature = (tree) => {
  const out = []
  const walk = (node) => {
    if (BLOCK_TYPES.has(node?.type)) out.push(node.type)
    for (const child of node?.children || []) walk(child)
  }
  walk(tree)
  return out.join('|')
}

const textLeaves = (tree) => {
  const out = []
  const walk = (node) => {
    if (node?.type === 'text' && node.value !== undefined) out.push(node.value)
    for (const child of node?.children || []) walk(child)
  }
  walk(tree)
  return out
}

// leaves(after) must equal leaves(before) with `insert` spliced into exactly
// one leaf — or contributed as exactly one NEW leaf (the empty-block case).
const leavesGainExactly = (before, after, insert) => {
  if (after.length === before.length) {
    let changed = -1
    for (let i = 0; i < before.length; i += 1) {
      if (before[i] !== after[i]) {
        if (changed !== -1) return false
        changed = i
      }
    }
    if (changed === -1) return false
    const was = before[changed]
    const now = after[changed]
    if (now.length !== was.length + insert.length) return false
    let split = 0
    while (split < was.length && was[split] === now[split]) split += 1
    return now.slice(split, split + insert.length) === insert &&
      now.slice(split + insert.length) === was.slice(split)
  }
  if (after.length === before.length + 1) {
    let added = -1
    for (let i = 0, j = 0; j < after.length; j += 1) {
      if (before[i] === after[j]) { i += 1; continue }
      if (added !== -1) return false
      added = j
    }
    return added !== -1 ? after[added] === insert : after[after.length - 1] === insert
  }
  return false
}

// ADJUDICATED BARE-MARKER TRANSIENTS — the exception the ADR names ("例外
// 拼写…「用户要结构」的显式手势"). A SINGLE typed marker character is a
// deliberate intermediate state OWNED by other machinery: the completing
// Space turns it into real structure, run growth extends `#`, and the
// following-text/demote path resolves it to literal — and `*`/`_`/`` ` ``/
// `~` may equally be OPENING inline syntax the mark input rules complete
// later. Respelling any of these breaks those adjudicated gestures (measured:
// escaping the opening `*` cascaded the whole mark line into vetoes, and an
// escaped `-` killed type-to-create-a-list). They are classified
// `marker-transient` by the typing-policy sweep — by design, not holes.
const TRANSIENT_SINGLE = new Set(['-', '+', '*', '>', '#', '`', '~', '_'])

export function escapePolicyForInsert({ text, offset, insert }) {
  if (typeof text !== 'string' || typeof insert !== 'string' || !insert.length) return null
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return null
  if (/[\r\n]/.test(insert)) return null
  if (insert.length === 1 && TRANSIENT_SINGLE.has(insert)) return null

  // GATE: any character of the insert in a plausibly-dangerous context?
  const virtualText = text.slice(0, offset) + insert + text.slice(offset)
  let gated = false
  for (let i = 0; i < insert.length; i += 1) {
    if (gateMatches(virtualText, offset + i, insert[i])) { gated = true; break }
  }
  if (!gated) return null

  // THE REFERENCE is a CONTROL candidate — the same offset receiving an
  // inert character — not the base document: an insert into an EMPTY block
  // legitimately grows the textblock that hosts it (an empty list item gains
  // its paragraph node), and "plain text landed here" is DEFINED by what an
  // inert character does at this exact position.
  let baseTree
  let controlTree
  let literalTree
  try {
    baseTree = parseKernelMarkdown(text)
    controlTree = parseKernelMarkdown(text.slice(0, offset) + 'x' + text.slice(offset))
    literalTree = parseKernelMarkdown(virtualText)
  } catch {
    return null
  }
  const controlSignature = blockSignature(controlTree)

  // PROOF 1: the literal bytes must genuinely restructure (differ from what
  // plain text does here). Decimals, mid-word dots, quote-interior '>' all
  // stop here and stay literal.
  if (blockSignature(literalTree) === controlSignature) return null

  // PROOF 2: the escaped spelling must land as plain text (control-equal
  // skeleton) with the block's leaves growing by exactly the insert's
  // visible content — which also fails closed inside code/math, where a
  // backslash would BE content.
  let escaped = ''
  for (const ch of insert) {
    escaped += (UNSAFE_BY_CHAR.has(ch) && ESCAPABLE_PUNCT.test(ch)) ? '\\' + ch : ch
  }
  if (escaped === insert) return null
  let escapedTree
  try {
    escapedTree = parseKernelMarkdown(text.slice(0, offset) + escaped + text.slice(offset))
  } catch {
    return null
  }
  if (blockSignature(escapedTree) !== controlSignature) return null
  if (!leavesGainExactly(textLeaves(baseTree), textLeaves(escapedTree), insert)) return null

  return { insert: escaped }
}
