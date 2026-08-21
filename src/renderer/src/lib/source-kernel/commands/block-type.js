// setBlockTypeFromQuery: turn the slash menu's own query block into another
// block type, as ONE atomic source transaction.
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
//
// WHY A "FROM QUERY" COMMAND AND NOT A GENERAL BLOCK-TYPE CONVERTER.
// In a source-authoritative kernel "make this a heading" IS "put `## ` at the
// start of the line" — there is no ProseMirror `setBlockType` step involved,
// only marker BYTES. The one entry point that exists for it today is the
// slash menu, and `editor-slash-menu.js`'s `shouldShow` guarantees a very
// specific shape at the moment an item runs:
//
//   * the caret is at the END of its block (`atEndOfBlock`), AND
//   * the block's ENTIRE text is the typed "/query" (`text.startsWith('/')`
//     over `SlashProvider.getContent`, which reads the whole block).
//
// So the target block's raw content is, by construction, exactly the query —
// there is no reachable invocation where "/h2" was typed after real content
// (the same reasoning quote-toggle's own `runQuoteToggleFromQuery` records).
// The conversion is therefore a SINGLE edit: replace the block's whole raw
// span with the target's marker prefix. Doing it as one edit is not a
// convenience — a separate "clear the query" dispatch first would leave a
// fully-empty top-level paragraph, a state CommonMark has no representation
// for (a blank line is a block separator, not a node), which the kernel's own
// self-heal then silently prunes before the conversion ever runs. That exact
// two-transaction window is the bug Plan 4 Task 5 found on the quote item.
//
// A general "convert a block that HAS content" converter (heading level
// change on a written heading, list unwrap, revert-to-paragraph) is
// deliberately NOT built here: nothing in kernel mode can reach it today, and
// an unreachable write path is a proof nobody runs. When a toolbar/shortcut
// entry point exists, it belongs in this module next to this one.
// 2026-08-22: the first such entry point exists — Backspace/Delete at a
// heading's content start (Milkdown's DowngradeHeading gesture) — and its
// converter lives below as `demoteHeadingAtCaret`, exactly where this note
// reserved the spot.

import { parseKernelMarkdown } from '../syntax-index.js'
import { buildCharacterMap } from '../character-map.js'
import { outsideSignature } from './list-merge.js'
import { insertBlockFromQuery } from './block-insert.js'

// Target -> the exact marker bytes written at the block's start.
//
// Every entry ends in a SPACE, and that is load-bearing, not cosmetic:
//   * `'##'` alone is a valid empty ATX heading, but typing the title
//     immediately after it would commit `'##T'`, which is a PARAGRAPH.
//   * `'-'` alone is a valid empty list item, but typing after it commits
//     `'-x'`, which is a paragraph too.
// The projection map applies the same rule from the other side (an empty list
// item / empty ATX heading is only editable when its marker carries real
// spacing), so a marker without one would produce a block the user cannot
// type into. Ordered lists start at `1.` — the CommonMark default and what
// every other list this app writes uses.
export const BLOCK_TYPE_MARKERS = Object.freeze({
  heading1: '# ',
  heading2: '## ',
  heading3: '### ',
  heading4: '#### ',
  heading5: '##### ',
  heading6: '###### ',
  bullet: '- ',
  ordered: '1. '
})

// DELIBERATELY ABSENT, each for a proven reason (see the task report):
//   * task list (`- [ ] `) — the empty form reparses to
//     `list > listItem > paragraph` whose paragraph carries the checkbox
//     bytes in its own raw span, and the projection map refuses to
//     character-map it. The block would be created read-only. (`/task` is
//     served since 2026-08-20 by the block-INSERT domain instead —
//     block-insert.js writes `- [ ] ` + a U+00A0 seed, the one spelling that
//     IS a real task with a caret home — so this marker table still owns no
//     task row on purpose.)
//   * divider (`---`) — a thematic break is a PM leaf with no text position,
//     so the committed caret has nowhere provable to land in the same
//     transaction.
//   * paragraph / "plain text" — stripping the query without writing any
//     marker yields the fully-empty top-level paragraph described above,
//     which has no raw representation at all.
// Each of these must keep refusing rather than guess.

// Same exclusive-end + one-step-back recovery idiom as quote-toggle.js's
// `topLevelNodeAt` (which itself mirrors enter.js's `resolveBlock`), applied
// per nesting level. The walk starts at the ROOT's children and descends
// through BLOCKQUOTES ONLY (2026-08-22; it used to stop at the root, which is
// what made every slash conversion inside a quote refuse): a paragraph whose
// ancestor chain is pure blockquotes starts at its own quoted line's content
// position, so a marker written there spells exactly what it spells at top
// level — and unlike the top-level path, the nested path is additionally
// REPARSE-PROVEN below (`provenQuoteConversion`). Any other container on the
// chain (a list item — marker/indent semantics this command has not proven)
// stops the walk and the command refuses, exactly as before.
function within(node, offset) {
  const start = node?.position?.start?.offset
  const end = node?.position?.end?.offset
  return Number.isInteger(start) && Number.isInteger(end) && offset >= start && offset < end
}

function levelNodeAt(children, offset) {
  const direct = children.find((node) => within(node, offset))
  if (direct) return direct
  if (offset > 0) {
    const before = children.find((node) => within(node, offset - 1))
    if (before && offset === before.position.end.offset) return before
  }
  return null
}

// The deepest node at `offset` reachable through blockquotes alone, plus how
// many quotes were crossed. `quoteDepth: 0` is exactly the old top-level hit.
function quoteChainNodeAt(tree, offset) {
  let children = tree?.children || []
  let quoteDepth = 0
  for (;;) {
    const hit = levelNodeAt(children, offset)
    if (!hit) return null
    if (hit.type === 'blockquote') {
      quoteDepth += 1
      children = hit.children || []
      continue
    }
    return { node: hit, quoteDepth }
  }
}

// An ATX heading's raw span STARTS at its `#` run (up to 3 leading spaces of
// indentation are allowed and are part of the span). A SETEXT heading's span
// starts at its text and runs THROUGH its `===`/`---` underline, so its
// `position.end.offset` can never equal a caret sitting at the end of the
// visible text — the `end !== offset` refusal below already rejects it. This
// pattern is the belt-and-suspenders half of that: a heading whose own bytes
// do not begin with an ATX marker is not one, and is refused rather than
// having its underline silently swallowed by the rewrite.
const ATX_HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/

// The block types whose ENTIRE raw span is safe to replace with a marker.
// `paragraph` carries no marker syntax of its own, and an ATX `heading`'s
// span is exactly `marker + content` on one line — in both cases the span
// the edit replaces is precisely "the block's own syntax plus the query", so
// nothing outside the user's own typed bytes is touched. Every other block
// type (list, blockquote, code, table, html, thematicBreak) either owns
// multi-line syntax or is not reachable from `shouldShow` at all, and is
// refused.
const SOURCE_TYPES = new Set(['paragraph', 'heading'])

// ---------------------------------------------------------------------------
// demoteHeadingAtCaret — the Backspace/Delete-at-heading-content-start gesture
// (Milkdown's DowngradeHeading binds BOTH keys there), as byte edits.
//
// WHAT IS WRITTEN, per shape:
//   * H_n (n≥2) -> H_{n-1}: delete ONE `#` at the start of the marker run.
//     The result is still an ATX heading (an EMPTY one included — `## ` -> `# `
//     stays representable), so this is a plain in-line byte edit.
//   * H1 with content -> paragraph: delete the whole ATX opening (indentation,
//     `#` run, spacing). The remaining bytes must REPARSE as exactly the same
//     inline content in a paragraph — `# 1. 甲` would become a LIST, `# # 甲`
//     a heading again, `# 甲` directly above `乙` would merge into one
//     paragraph; every such shape REFUSES (named `heading-demote-unsupported`)
//     rather than silently restructuring or inventing escape bytes the user
//     never typed.
//   * EMPTY H1 -> empty paragraph: a fully-empty top-level paragraph has no
//     byte spelling at all (this module's own marker-table note), so the
//     command DELEGATES to the /text machinery — `insertBlockFromQuery`'s
//     `text` target deletes the block's bytes and the caret rides the
//     doc-end/split placeholder session. Its guards pass here BY CONSTRUCTION:
//     an empty heading's content start IS its block end. The delegation's
//     result (transaction + docEndPlaceholder/midPlaceholder flags, or its
//     own named refusal) is passed through verbatim.
//
// TOP-LEVEL ONLY, same posture as setBlockTypeFromQuery above: a heading
// nested in a blockquote/list answers `not-structural` here, falls through to
// ProseMirror's own demote transaction, and keeps the gateway's named refusal
// (editor-kernel-gateway.js `extractHeadingDemotion` stays as the net for
// exactly those shapes).
//
// THE PROOF (non-delegated shapes), same two axes as insertBlockFromQuery:
//   (a) the block at the heading's start is exactly the demoted form — same
//       span shifted by the deletion, heading depth n-1 / paragraph, and an
//       inline signature (type+value walk) identical to the original's;
//   (b) nothing outside the heading's span changed meaning (`outsideSignature`
//       from list-merge.js, offsets shifted by the deletion);
//   (c) the demoted block stays exactly as addressable as the heading was —
//       both character maps build, same visibleLength, every unit shifted by
//       exactly the removed byte count.
const NOT_STRUCTURAL = Object.freeze({ ok: false, code: 'not-structural' })
const DEMOTE_UNSUPPORTED = Object.freeze({ ok: false, code: 'heading-demote-unsupported' })

// The full ATX opening, captured in parts: ≤3 spaces of indentation, the `#`
// run, the REQUIRED spacing run (a bare `#` has no content position at all —
// it is read-only in the projection — so `[ \t]+` is load-bearing, exactly as
// in heading-whitespace.js's ATX_OPENING_RE).
const ATX_DEMOTE_RE = /^( {0,3})(#{1,6})([ \t]+)/

// Type+value walk of a node's children — the "same inline content" half of
// axis (a). Positions are deliberately not part of it (everything after the
// deletion shifts by construction); values pin text/inlineCode characters.
const inlineSignature = (node) => {
  const out = []
  const walk = (n) => {
    out.push(`${n?.type}${typeof n?.value === 'string' ? ':' + n.value : ''}`)
    for (const child of n?.children || []) walk(child)
  }
  for (const child of node?.children || []) walk(child)
  return out.join('|')
}

// Identical to heading-whitespace.js's (duplicated with a note, the same way
// block-insert.js duplicates this module's `topLevelNodeAt`): every unit keeps
// its kind and width and moves by exactly `shift` bytes.
const unitsShiftBy = (before, after, shift) => {
  if (after.length !== before.length) return false
  for (let i = 0; i < before.length; i += 1) {
    const a = before[i]
    const b = after[i]
    if (!a || !b) return false
    if (a.kind !== b.kind || a.width !== b.width) return false
    if (b.rawStart !== a.rawStart + shift || b.rawEnd !== a.rawEnd + shift) return false
  }
  return true
}

export function demoteHeadingAtCaret({ doc, index, offset }) {
  const text = doc?.text
  if (typeof text !== 'string' || !Number.isInteger(doc?.revision)) return NOT_STRUCTURAL
  if (!Number.isInteger(offset) || offset < 1 || offset > text.length) return NOT_STRUCTURAL

  // Resolve: the TOP-LEVEL ATX heading whose first content position is the
  // caret. Walking root children (not a flattened index) is what proves
  // top-level, exactly as topLevelNodeAt above.
  let heading = null
  let opening = null
  for (const node of index.tree?.children || []) {
    if (node?.type !== 'heading') continue
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue
    const match = text.slice(start, end).match(ATX_DEMOTE_RE)
    if (!match || start + match[0].length !== offset) continue
    heading = node
    opening = match
    break
  }
  if (!heading) return NOT_STRUCTURAL

  const start = heading.position.start.offset
  const end = heading.position.end.offset
  const level = opening[2].length
  // The bytes and mdast cannot disagree on an ATX heading's level; a mismatch
  // means the shape is not what this command understands — refuse, don't guess.
  if (Number.isInteger(heading.depth) && heading.depth !== level) return DEMOTE_UNSUPPORTED

  // EMPTY H1 (content start IS the block end): the /text delegation.
  if (level === 1 && offset === end) {
    return insertBlockFromQuery({ doc, index, offset, target: 'text' })
  }

  const removedFrom = level >= 2 ? start + opening[1].length : start
  const removedTo = level >= 2 ? removedFrom + 1 : offset
  const removed = removedTo - removedFrom
  const candidate = text.slice(0, removedFrom) + text.slice(removedTo)
  const delta = -removed

  // Fresh parses on both sides (index.tree carries injectHighlightNodes'
  // split text nodes — same reasoning as insertBlockFromQuery's baseline).
  let baselineTree = null
  let candidateTree = null
  try {
    baselineTree = parseKernelMarkdown(text)
    candidateTree = parseKernelMarkdown(candidate)
  } catch {
    return DEMOTE_UNSUPPORTED
  }
  const baseHeading = (baselineTree.children || []).find(
    (node) => node?.type === 'heading' &&
      node.position?.start?.offset === start && node.position?.end?.offset === end
  )
  if (!baseHeading) return DEMOTE_UNSUPPORTED

  // Axis (b): nothing outside the heading's own span changed meaning.
  const before = outsideSignature(baselineTree, start, end, 0)
  const after = outsideSignature(candidateTree, start, end - removed, delta)
  if (before === null || after === null || before !== after) return DEMOTE_UNSUPPORTED

  // Axis (a): the block at the heading's start is exactly the demoted form.
  const result = (candidateTree.children || []).find(
    (node) => node?.position?.start?.offset === start
  )
  if (!result || result.position?.end?.offset !== end - removed) return DEMOTE_UNSUPPORTED
  if (level >= 2) {
    if (result.type !== 'heading' || result.depth !== level - 1) return DEMOTE_UNSUPPORTED
  } else if (result.type !== 'paragraph') {
    return DEMOTE_UNSUPPORTED
  }
  if (inlineSignature(result) !== inlineSignature(baseHeading)) return DEMOTE_UNSUPPORTED

  // Axis (c): addressability preserved unit for unit.
  let beforeMap = null
  let afterMap = null
  try {
    beforeMap = buildCharacterMap(text, baseHeading)
    afterMap = buildCharacterMap(candidate, result)
  } catch {
    return DEMOTE_UNSUPPORTED
  }
  if (!beforeMap || !afterMap) return DEMOTE_UNSUPPORTED
  if (afterMap.visibleLength !== beforeMap.visibleLength) return DEMOTE_UNSUPPORTED
  if (!unitsShiftBy(beforeMap.units, afterMap.units, delta)) return DEMOTE_UNSUPPORTED

  const anchor = offset - removed
  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      edits: [{ from: removedFrom, to: removedTo, insert: '' }],
      intent: 'demote-heading',
      selection: { anchor, head: anchor }
    }
  }
}

export function setBlockTypeFromQuery({ doc, index, offset, target }) {
  const marker = BLOCK_TYPE_MARKERS[target]
  if (!marker) return { ok: false, code: 'unsupported-structure' }
  if (!Number.isInteger(offset) || offset < 1) return { ok: false, code: 'unsupported-structure' }

  const found = quoteChainNodeAt(index.tree, offset)
  if (!found || !SOURCE_TYPES.has(found.node.type)) {
    return { ok: false, code: 'unsupported-structure' }
  }
  const { node, quoteDepth } = found

  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return { ok: false, code: 'unsupported-structure' }
  }
  // The caret MUST sit exactly at the block's own end. This is `shouldShow`'s
  // `atEndOfBlock` restated on the raw side, and it is the proof that the
  // span about to be replaced contains nothing but the block's syntax and the
  // typed query — never content the user still wants.
  if (end !== offset) return { ok: false, code: 'unsupported-structure' }

  const raw = doc.text.slice(start, end)
  if (node.type === 'heading' && !ATX_HEADING_RE.test(raw)) {
    return { ok: false, code: 'unsupported-structure' }
  }
  if (quoteDepth > 0) {
    // A quoted block's raw span could in principle carry continuation lines
    // (`> a\n> b` is ONE paragraph). `shouldShow` already excludes that shape
    // (the whole visible text is the single-line query), but the nested path
    // proves rather than assumes: a span with a line ending would swallow
    // lines beyond the query, so it refuses.
    if (/[\r\n]/.test(raw)) return { ok: false, code: 'unsupported-structure' }
    if (!provenQuoteConversion({ text: doc.text, start, end, marker, target, quoteDepth })) {
      return { ok: false, code: 'unsupported-structure' }
    }
  }

  const anchor = start + marker.length
  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      edits: [{ from: start, to: end, insert: marker }],
      intent: 'set-block-type',
      selection: { anchor, head: anchor }
    }
  }
}

// The nested path's own two-axis proof (the block-insert idiom, applied to a
// conversion): the candidate bytes must (a) parse to the TARGET structure at
// the query's own start, inside a blockquote chain of the SAME depth, still
// empty of content — and (b) leave every node outside the replaced span
// byte-identical, offsets after it shifted by exactly the edit's delta. The
// top-level path deliberately keeps its purely positional safety (long locked
// by the suites); this proof exists because a quote prefix is CONTEXT, and
// context is exactly what a positional argument cannot see.
function provenQuoteConversion({ text, start, end, marker, target, quoteDepth }) {
  const candidate = text.slice(0, start) + marker + text.slice(end)
  let baselineTree
  let candidateTree
  try {
    baselineTree = parseKernelMarkdown(text)
    candidateTree = parseKernelMarkdown(candidate)
  } catch {
    return false
  }
  // Axis (a): the structure the marker claims, at the same place, same depth.
  const found = quoteChainNodeAt(candidateTree, start)
  if (!found || found.quoteDepth !== quoteDepth) return false
  const node = found.node
  if (node.position?.start?.offset !== start) return false
  if (target === 'bullet' || target === 'ordered') {
    if (node.type !== 'list') return false
    if (!!node.ordered !== (target === 'ordered')) return false
    const items = node.children || []
    if (items.length !== 1) return false
    const item = items[0]
    if (item.position?.start?.offset !== start) return false
    if (item.checked === true || item.checked === false) return false
    if ((item.children || []).length !== 0) return false
  } else {
    if (node.type !== 'heading') return false
    if (node.depth !== Number(target.slice('heading'.length))) return false
    if ((node.children || []).length !== 0) return false
  }
  // Axis (b): nothing outside the replaced span changed meaning. The quote
  // ancestors overlap the region on both sides and are skipped symmetrically;
  // every sibling — inside the quote or after it — must survive.
  const delta = marker.length - (end - start)
  const before = outsideSignatureThroughContainers(baselineTree, start, end, 0)
  const after = outsideSignatureThroughContainers(candidateTree, start, start + marker.length, delta)
  return before !== null && after !== null && before === after
}

// Byte-identity signature of every node OUTSIDE [regionStart, regionEnd),
// offsets after the region normalized back by `delta`. The block-insert
// idiom with ONE deliberate difference: a node that overlaps the region is
// skipped but its CHILDREN are still walked — here the region sits INSIDE
// blockquote ancestors, and pruning their whole subtree would leave the
// quote's own sibling paragraphs unsigned (i.e. unprotected). block-insert's
// regions are top-level, so it never meets this case.
function outsideSignatureThroughContainers(tree, regionStart, regionEnd, delta) {
  const parts = []
  let ok = true
  const walk = (node) => {
    if (!ok) return
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      ok = false
      return
    }
    if (start < regionEnd && end > regionStart) {
      for (const child of node.children || []) walk(child)
      return
    }
    const from = start <= regionStart ? start : start - delta
    const to = end <= regionStart ? end : end - delta
    parts.push(`${node.type}:${from}:${to}`)
    for (const child of node.children || []) walk(child)
  }
  for (const child of tree.children || []) walk(child)
  return ok ? parts.join('\n') : null
}
