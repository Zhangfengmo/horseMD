// `==highlight==` recognition — the SINGLE definition shared by the editor
// chain and the source kernel (same precedent as inline-html.js).
//
// This module is pure: no Electron/React/@milkdown imports (source-kernel
// convention, see syntax-index.js).
//
// ── Why this is NOT a micromark extension (ADR, Plan 5 Task 3) ────────────
// The plan called for a micromark extension + mdast-util pair, on the
// (correct) grounds that `mdast-util-find-and-replace` produces nodes with NO
// `position`, which the kernel's unit contract forbids. Probing the editor
// chain's ACTUAL semantics (scripts/test-source-kernel-highlight-consistency.mjs
// is the executable form of this probe) showed a micromark extension cannot
// reproduce them, because the editor does not recognize `==` during parsing at
// all — it runs a REGEX over the mdast `text` nodes AFTER the whole document
// has been parsed. Three measured consequences no micromark tokenizer can
// have:
//   1. `==*x*==` is NOT a highlight (emphasis already claimed the middle, so
//      no single text node holds the whole `==…==`), while `==a*b==` IS one
//      (the lone `*` stayed text). A tokenizer running DURING the parse would
//      have to predict the attention resolver to agree.
//   2. `==&amp;==` IS a highlight over the decoded `&`, and `\=\=x\=\=` IS a
//      highlight over `x` — the regex sees DECODED values, where the escapes
//      and character references are already gone.
//   3. `==x\ny==` IS a highlight spanning a soft line break inside one text
//      node.
// A tokenizer that guessed differently on (1) would be strictly WORSE than no
// extension at all: `==*x*==` pairs perfectly today (5 visible chars on both
// sides), and a kernel-only highlight node there would collapse it to 1 and
// degrade the block.
//
// So the kernel applies the SAME regex to the SAME input (mdast `text` node
// values) and derives real positions from the character map's own decoded ->
// raw walk (`textUnits`). Agreement is structural — one regex, one match
// scanner, exported here and imported by editor-highlight.js — and what the
// consistency suite locks is the remaining half: that the kernel's derived
// byte spans are exactly the `==…==` runs the editor turned into nodes.
//
// Fail-closed rule: any match whose bytes cannot be PROVEN (a marker that is
// not two literal `=` bytes in the raw source — i.e. it was written escaped or
// as a character reference — or a match edge that does not land on a decode
// unit boundary) produces NO kernel node. The block then holds more visible
// characters than ProseMirror does and degrades to non-editable (P5-2.5), which
// is the intended fail-closed direction; it never mis-maps.
import { textUnits } from './character-map.js'
import { BREAK_REWRITE_PARENTS, inlineHtmlRunAt } from './inline-html.js'

// Match ==text== without tripping on `===` / `a = b`:
//   - not adjacent to another `=` (so `===`/trailing `=` are out)
//   - `==}` cannot open a native highlight; that sequence is the close of
//     source-readable review markup: `{==text==}{>>comment<<}`.
//   - content non-empty, no `=`, no leading/trailing whitespace
// CJK has no word boundaries, so we don't require whitespace around the `==`
// (Typora behaves the same): `这是==高亮==的` works.
//
// Historically this literal lived in editor-highlight.js; it moved here (byte
// identical) so the kernel cannot drift from it. editor-highlight.js imports
// and re-exports it, and passes it to `mdast-util-find-and-replace` exactly as
// before.
export const HIGHLIGHT_RE = /(?<![={])(==)(?!\})([^=\s][^=]*[^=\s]|[^=\s])\1(?![=])/g

// The same rule in the shape a ProseMirror INPUT RULE needs: anchored at the
// caret (`$`) and therefore matched against the text typed so far, not
// scanned globally. Owned here next to `HIGHLIGHT_RE` (it used to be a third
// near-copy inside editor-highlight.js) and asserted EQUIVALENT to it by
// scripts/test-source-kernel-highlight-consistency.mjs: a string matches this
// exactly when `highlightMatches` reports a highlight ENDING at the string's
// end, at the same index.
//
// The literal differs from `HIGHLIGHT_RE` in three inconsequential ways, all
// forced by the anchoring: no `g` flag (one match, at the caret), the closing
// marker spelled out instead of `\1` (there is no need to back-reference a
// two-character constant), and no trailing `(?![=])` (nothing can follow `$`).
// It is a live-typing convenience, not an authority: whatever mark it applies
// is re-derived from the bytes on the next parse by the rule above.
export const HIGHLIGHT_INPUT_RE = /(?<![={])==(?!\})([^=\s][^=]*[^=\s]|[^=\s])==$/

// Private clone so a kernel scan can never disturb the `lastIndex` of the
// instance `mdast-util-find-and-replace` is iterating with (it owns the shared
// export; both reset to 0 per node, but two owners of one stateful regex is a
// trap not worth leaving open).
const SCAN_RE = new RegExp(HIGHLIGHT_RE.source, HIGHLIGHT_RE.flags)

// All highlight matches in one mdast `text` node's DECODED value, as
// `{ start, end, content }` value-index ranges (`end` exclusive, `content` the
// inner text without the `==` markers).
//
// The loop is deliberately shaped like `mdast-util-find-and-replace`'s own
// `handler` (node_modules/mdast-util-find-and-replace/lib/index.js): reset
// `lastIndex` once per node, then `exec` until exhausted, so matches are
// non-overlapping and left-to-right in exactly the same order and with exactly
// the same overlap resolution as the editor's replacement pass.
export function highlightMatches(value) {
  const out = []
  if (typeof value !== 'string' || !value) return out
  SCAN_RE.lastIndex = 0
  let match = SCAN_RE.exec(value)
  while (match) {
    out.push({
      start: match.index,
      end: match.index + match[0].length,
      content: match[2]
    })
    match = SCAN_RE.exec(value)
  }
  return out
}

// Would inserting `==` at `from` and at `to` produce bytes the SAME rule reads
// back as one highlight covering exactly [from, to)? Used by the toggle
// command (commands/mark-toggle.js) to refuse a wrap that would commit inert
// `==` bytes instead of a highlight — e.g. selecting `b` in `a=b` yields
// `a===b==`, which neither parser reads as a highlight (both agree, so the map
// stays healthy, but the user asked for a highlight and would get literal `=`
// noise).
//
// Only ONE character of context is needed on each side: the rule's lookbehind
// (`(?<![={])`) and trailing lookahead (`(?![=])`) are both single-character.
// The caller must have already proven that [from, to) is literal text (its
// character-map units are all `char`/`linebreak`), so the raw slice IS the
// decoded value the editor's regex would see.
export function wrapWouldHighlight(text, from, to) {
  if (typeof text !== 'string') return false
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) return false
  const before = from > 0 ? text[from - 1] : ''
  const after = to < text.length ? text[to] : ''
  const probe = before + '==' + text.slice(from, to) + '==' + after
  const matches = highlightMatches(probe)
  return matches.some((m) => m.start === before.length && m.end === probe.length - after.length)
}

// Value-index -> raw-offset tables for one mdast `text` node, borrowed from
// the character map's own decode walk so the kernel has exactly one definition
// of "which raw bytes does decoded character N come from" (escapes, character
// references, soft breaks with their continuation prefixes, astral pairs).
// Returns null whenever `textUnits` itself cannot prove the alignment.
//
// `nextSibling` is the mdast node FOLLOWING this text node in its parent's
// children — `textUnits`' only evidence for where a trailing soft break's
// continuation prefix ends (character-map.js `continuationFoldEnd`). Borrowing
// the decode walk means borrowing its premises too: omitting the sibling here
// made `textUnits` refuse every text node that ends at a line terminator with
// a prefixed continuation line ('- ==x== a b\n  `c` d'), so no highlight node
// was produced and the block degraded to read-only even though the character
// map itself — which DOES pass the sibling — could prove it. The two callers
// must ask the same question with the same evidence or they answer differently
// about the same bytes.
function offsetTables(text, node, nextSibling) {
  const units = textUnits(text, node, nextSibling)
  if (!units) return null
  const starts = new Map()
  const ends = new Map()
  let v = 0
  for (const unit of units) {
    starts.set(v, unit.rawStart)
    // These tables are keyed by VALUE indices, and a `linebreak` unit's
    // width (always 1, the DECODED width) can undercount the value chars it
    // consumes: a CRLF (or lone-CR) soft break keeps its bytes verbatim in
    // the value, so the unit records the value spelling in `ending` (CRLF
    // widening, 2026-08-21). Advancing by width here would shift every
    // index after the break and silently mis-resolve a highlight's bytes.
    // The index BETWEEN a pair's '\r' and '\n' gets no entry — a match
    // boundary landing there fails closed, as it must.
    v += unit.kind === 'linebreak' && unit.ending ? unit.ending.length : unit.width
    ends.set(v, unit.rawEnd)
  }
  return { starts, ends, length: v }
}

// One `==…==` match, resolved to raw byte offsets, or null (fail closed).
function resolveMatch(text, node, tables, match) {
  const value = String(node.value ?? '')
  const rawStart = tables.starts.get(match.start)
  const rawEnd = tables.ends.get(match.end)
  const rawContentStart = tables.starts.get(match.start + 2)
  const rawContentEnd = tables.ends.get(match.end - 2)
  if (![rawStart, rawEnd, rawContentStart, rawContentEnd].every(Number.isInteger)) return null
  // The two markers must be two LITERAL `=` bytes each. `\=\=x\=\=` and
  // `&#61;&#61;x&#61;&#61;` decode to the same value the regex matched, but
  // their raw bytes are not a highlight's markers — no kernel node for those
  // (see the fail-closed rule in this file's header).
  if (rawContentStart - rawStart !== 2 || text.slice(rawStart, rawContentStart) !== '==') return null
  if (rawEnd - rawContentEnd !== 2 || text.slice(rawContentEnd, rawEnd) !== '==') return null
  if (rawContentEnd <= rawContentStart) return null
  const content = value.slice(match.start + 2, match.end - 2)
  if (content !== match.content) return null
  return { rawStart, rawEnd, rawContentStart, rawContentEnd, content }
}

function textNode(value, from, to, pointAt) {
  return {
    type: 'text',
    value,
    position: { start: pointAt(from), end: pointAt(to) }
  }
}

// Split one `text` node into `[text?, highlight, text?, …]`, or return null
// when nothing applies. Every produced node carries a real, derived position.
//
// The produced nodes keep THIS node's own `position` boundaries — the last
// fragment ends at `end`, never at a proven continuation fold's far edge. The
// fold is re-derived downstream by `collectUnits`, which passes whatever now
// follows the fragment (a later split node, or the original sibling), so the
// span a unit claims is proven exactly once, where it is used.
function splitTextNode(text, node, nextSibling, pointAt) {
  const value = String(node.value ?? '')
  const matches = highlightMatches(value)
  if (!matches.length) return null
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  const tables = offsetTables(text, node, nextSibling)
  if (!tables || tables.length !== value.length) return null

  const out = []
  let cursorValue = 0
  let cursorRaw = start
  for (const match of matches) {
    const resolved = resolveMatch(text, node, tables, match)
    if (!resolved) continue // fail closed for THIS match; others may still map
    if (match.start > cursorValue) {
      out.push(textNode(value.slice(cursorValue, match.start), cursorRaw, resolved.rawStart, pointAt))
    }
    out.push({
      type: 'highlight',
      color: 'yellow',
      children: [
        textNode(resolved.content, resolved.rawContentStart, resolved.rawContentEnd, pointAt)
      ],
      position: { start: pointAt(resolved.rawStart), end: pointAt(resolved.rawEnd) }
    })
    cursorValue = match.end
    cursorRaw = resolved.rawEnd
  }
  if (!out.length) return null
  if (cursorValue < value.length) {
    out.push(textNode(value.slice(cursorValue), cursorRaw, end, pointAt))
  }
  return out
}

// Inject positioned `highlight` nodes into a freshly parsed kernel mdast tree.
//
// Mirrors `mdast-util-find-and-replace`'s reach — EVERY `text` node in the
// tree, at any depth (inside emphasis/strong/link/heading/list items…) — with
// one deliberate exclusion: text that belongs to a coalesced inline-HTML run.
// The editor's plugin order puts `remarkMergeInlineHtml` (registered in the
// ConfigReady pass of editor-crepe-setup.js) BEFORE `highlightRemark` (a
// `$remark`, appended only after InitReady, which waits on ConfigReady), so by
// the time the editor's regex runs, the text inside `<span>==x==</span>` is no
// longer a text node at all — it is part of the merged `html` node's value and
// is never highlighted. The kernel must skip it for the same reason twice
// over: character-map.js emits ONE atom unit for that run, and a highlight
// node in the middle would break the run detection itself.
//
// Mutates `tree` in place (it is the kernel's own private parse result) and
// returns it.
export function injectHighlightNodes(tree, text, pointAt) {
  if (!tree || typeof text !== 'string' || typeof pointAt !== 'function') return tree
  const visit = (node) => {
    const children = node.children
    if (!Array.isArray(children) || !children.length) return
    const breakHtmlCuts = BREAK_REWRITE_PARENTS.has(node.type)
    const next = []
    let i = 0
    let changed = false
    while (i < children.length) {
      const run = inlineHtmlRunAt(children, i, breakHtmlCuts)
      if (run) {
        for (let j = i; j < run.end; j += 1) next.push(children[j])
        i = run.end
        continue
      }
      const child = children[i]
      i += 1
      if (child.type === 'text') {
        // `children[i]` is the following sibling (`i` was already advanced
        // past `child`) — the same evidence `collectUnits` hands `textUnits`,
        // so the two derive the same units from the same node.
        const split = splitTextNode(text, child, children[i] || null, pointAt)
        if (split) {
          next.push(...split)
          changed = true
          continue
        }
        next.push(child)
        continue
      }
      next.push(child)
      visit(child)
    }
    if (changed) node.children = next
  }
  visit(tree)
  return tree
}
