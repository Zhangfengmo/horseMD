// Tab/Shift+Tab 列表项缩进/反缩进：只改当前项及其明确归属子树的行前缀，绝不重写
// 整个列表（不触碰兄弟项、不重排编号）。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
import { QUOTE_PREFIX } from '../../markdown-preservation/block-prefix.js'
import { parseKernelMarkdown } from '../syntax-index.js'
import { NO_BREAK_SPACE } from './trailing-whitespace.js'

// Same idiom as syntax-index.js buildItem: QUOTE_PREFIX's leading `[ \t]*` is
// unconditional, so it also matches pure indentation with zero '>' — only
// count it as a real quote prefix when it actually contains '>'.
const linePrefixLength = (line) => {
  const raw = (line.text.match(QUOTE_PREFIX) || [''])[0]
  return raw.includes('>') ? raw.length : 0
}

// index.listItemAt is blind to a line's own quote-prefix span — those chars
// belong to no item (see syntax-index.js: item.start begins AFTER the
// prefix), so probing at a raw line-start offset inside a blockquoted list
// returns null even though the line is clearly owned by some item. Nudge the
// probe past the line's own prefix before giving up.
const itemContaining = (index, offset) => {
  const direct = index.listItemAt(offset)
  if (direct) return direct
  const line = index.lines[index.lineIndexAt(offset)]
  const nudged = line.start + linePrefixLength(line)
  if (nudged <= offset || nudged > line.end) return null
  return index.listItemAt(nudged)
}

// The item's own lines: marker line through its subtree end, skipping blank
// lines. Returns null (fail-closed) if any owned line's own prefix does not
// match the item's quotePrefix byte-for-byte — a mismatch means the edit
// position (computed from item.quotePrefix) would not actually sit right
// after that line's real prefix.
const ownedLineIndexes = (index, item) => {
  const first = item.markerLineIndex
  const last = index.lineIndexAt(Math.max(item.start, item.end - 1))
  const rows = []
  for (let i = first; i <= last; i += 1) {
    const line = index.lines[i]
    if (line.text.slice(0, item.quotePrefix.length) !== item.quotePrefix) return null
    if (line.text.slice(item.quotePrefix.length).trim() !== '') rows.push(i)
  }
  return rows
}

// A flat single delta is wrong once an item owns more than one line: EVERY
// edit at or before `offset` shifts it, not just the one on offset's own
// line (a caret on a continuation/owned line sits after the marker line's
// edit AND its own line's edit). Sum every edit's effect that lands at or
// before offset, in original-document coordinates. These edits are a pure
// insert (from === to), a pure whitespace deletion (insert === ''), or the
// ordered-rescue marker replacement (pad + rewritten marker over the old
// indent+marker span) — the general sum handles all three. Being prefix
// edits placed at a line's own start, offset rarely falls inside a replaced
// range (only a caret parked inside the marker itself); clamp defensively.
const selectionFor = (edits, offset) => {
  let delta = 0
  for (const edit of edits) {
    if (edit.from > offset) break
    const insertLen = String(edit.insert ?? '').length
    if (edit.to <= offset) {
      delta += insertLen - (edit.to - edit.from)
    } else {
      // offset lands inside this edit's deleted range: clamp to the edit's
      // own insertion point plus however much of the deletion precedes it.
      delta += insertLen - (offset - edit.from)
    }
  }
  return offset + delta
}

// THE PROOF THIS COMMAND DID NOT HAVE (2026-08-20).
//
// Indent/outdent used to compute their prefix edits and return them unchecked —
// the ONLY structural command family in this kernel with no reparse behind it.
// The bytes are individually legal, so nothing downstream noticed when they
// reparsed into a DIFFERENT DOCUMENT. Reported by a user with before/after
// screenshots, reproduced on the first attempt through the app's own gestures:
//
//   - 12312          Tab in the empty         - 12312
//   - 123213    -->  third item          -->  - 123213
//   -                                           -
//
// which is `  - ` on its own line, and CommonMark reads that as a SETEXT
// HEADING UNDERLINE, not a nested item: an EMPTY list item cannot interrupt a
// paragraph, so the line becomes the underline for the previous item's text.
// The second item silently turned into an empty paragraph plus an `<h2>`
// carrying the first item's words, rendered big and bold outside the list. The
// user's list had two leading U+00A0 in that item (from the whitespace family),
// which is why the report looked NBSP-specific — it is not: the identical
// corruption happens on plain text, verified as a control.
//
// The invariant is what indent MEANS: it changes CONTAINER NESTING and nothing
// else. So every LEAF block — the blocks that actually carry the user's words —
// must survive with the same type, the same decoded text, and the same order.
// A nested-list level appearing or disappearing does not disturb that; a
// paragraph turning into a heading, or content moving between blocks, does.
//
// Stated over decoded text rather than raw bytes on purpose: the raw bytes
// legitimately change (that is the edit), and the decoded text legitimately
// does not.
const LEAF_BLOCKS = new Set(['paragraph', 'heading', 'code', 'math', 'html', 'thematicBreak', 'table'])

const decodedText = (node) => (
  node.value !== undefined
    ? String(node.value)
    : (node.children || []).map(decodedText).join('')
)

const leafSignature = (text) => {
  const rows = []
  const walk = (node) => {
    if (LEAF_BLOCKS.has(node.type)) {
      rows.push(node.type + '\u0000' + decodedText(node))
      return
    }
    for (const child of node.children || []) walk(child)
  }
  walk(parseKernelMarkdown(text))
  return rows.join('\u0001')
}

// Apply the command's own edits right-to-left (they are ascending and
// non-overlapping by construction) so earlier offsets stay valid.
const applyEdits = (text, edits) => {
  let out = text
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, edit.from) + String(edit.insert ?? '') + out.slice(edit.to)
  }
  return out
}

// Two codes, because the two reachable causes have different remedies and the
// user can act on both:
//   * an EMPTY item cannot open a nested list (in a bullet list its marker
//     line is even read as a setext underline, turning the item ABOVE into a
//     heading; in an ordered list it is swallowed as a lazy continuation) —
//     type something in the item first, and the same Tab works;
//   * anything else that survives the ordered-marker rescue below has no
//     one-line remedy, so its message states the fact rather than inventing
//     advice.
const EMPTY_ITEM = { ok: false, code: 'empty-item-would-become-heading' }
const RESTRUCTURES = { ok: false, code: 'would-restructure-document' }

// Returns null when the edits are proven to change nesting ONLY, or the refusal
// that says which way they would have gone wrong.
const provenNestingOnly = (text, edits, item) => {
  let before
  let after
  try {
    before = leafSignature(text)
    after = leafSignature(applyEdits(text, edits))
  } catch {
    return RESTRUCTURES
  }
  if (before === after) return null
  return item?.empty ? EMPTY_ITEM : RESTRUCTURES
}

const multiTxn = (doc, edits, intent, offset) => {
  const anchor = selectionFor(edits, offset)
  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      edits,
      intent,
      selection: { anchor, head: anchor }
    }
  }
}

// The nearest preceding item at the SAME depth, in the SAME list (same
// listStart) as `item`. Walked line-by-line (not by raw char offset — a raw
// offset such as `candidate.end - 1` is ambiguous because listItemAt is
// inclusive at an item's end, so stepping there and then `+= 1` in the loop
// lands right back on the same offset and never advances; see Task 6 brief
// notes) so every iteration strictly progresses to the next physical line.
//
// Each line is probed at its own MARKER position (past `[ \t>]*`), never at
// the raw line start: a NESTED sibling's line start is its indentation, and
// listItemAt maps those bytes to the ENCLOSING item (an item's own `start`
// begins after its indent), so the raw-start probe resolved to the wrong
// depth and nested items never found their previous sibling — every depth≥2
// Tab refused (2026-08-22 user report: Tab at a nested task's tail
// 「不会自动适配」). A continuation line probed this way resolves to its
// OWNING item, which the depth/listStart filters below judge like any other
// candidate.
const previousSibling = (index, item) => {
  let best = null
  const firstLine = index.lineIndexAt(item.listStart)
  const lastLine = item.markerLineIndex - 1
  for (let li = firstLine; li <= lastLine; li += 1) {
    const line = index.lines[li]
    const contentAt = line.start + (line.text.match(/^[ \t>]*/) || [''])[0].length
    if (contentAt >= line.end) continue
    const candidate = itemContaining(index, contentAt)
    if (
      candidate &&
      candidate.depth === item.depth &&
      candidate.listStart === item.listStart &&
      candidate.start < item.start &&
      (!best || candidate.start > best.start)
    ) {
      best = candidate
    }
  }
  return best
}

// The listItem that directly encloses item's own list. `item.listStart` is
// the start of item's own list (the position of that list's FIRST child,
// which — when item itself is that first child — equals item.start; probing
// listItemAt(item.listStart) would then resolve to item itself, not its
// parent). Probing one offset earlier always lands in the parent's own
// content, one level up, regardless of which sibling `item` is.
const parentItem = (index, item) => {
  if (item.listStart <= 0) return null
  return itemContaining(index, item.listStart - 1)
}


// EMPTY-ITEM SEED PROOF (2026-08-22). The bare indent of an empty item is the
// SETEXT trap the named refusal protects against; the SEED spelling —
// `  - ` + U+00A0, the same one representable form /task and the split seeds
// are built on — defeats it (U+00A0 is not ASCII whitespace, so the line is
// no underline; measured: it parses as a REAL nested empty item). Proven,
// never assumed: (a) the candidate's node at the seed offset is a paragraph
// holding EXACTLY the seed, owned by a NESTED item (>= 2 listItem ancestors);
// (b) no heading appeared (the trap's own signature); (c) the leaf VALUES are
// the baseline's plus exactly the one seed — nothing else changed meaning.
const countHeadings = (tree) => {
  let n = 0
  const walk = (node) => {
    if (node?.type === 'heading') n += 1
    for (const child of node?.children || []) walk(child)
  }
  walk(tree)
  return n
}
const sortedLeafValues = (tree) => {
  const out = []
  const walk = (node) => {
    if (typeof node?.value === 'string') out.push(node.value)
    for (const child of node?.children || []) walk(child)
  }
  walk(tree)
  return out.sort()
}
// THE PROOF THE OUTDENT RENUMBER DID NOT HAVE (2026-08-26, corrected same day).
//
// The ORDERED-MARKER RENUMBER below rewrites the outdented item's own marker
// digits, so that an item lifted out of a nested list continues its new
// parent's count. That IS a user-visible change and is meant to be: product
// ruling 2026-08-26, `1. 甲 / 2. 乙 / ␣␣␣1. 丙` + Shift-Tab must read 1, 2, 3.
//
// ERRATUM — the first version of this comment defended the rewrite as having
// "no rendering consequence", on the CommonMark rule that a list's `start` is
// its FIRST item's number and every later item's number is ignored. That rule
// is real, but the defence was FALSE FOR THIS EDITOR and had been for two days
// when it was written: `68a0b38` (2026-08-24) added `sourceOrdinalPlugin`
// (editor-kernel-mode.js), which paints each item's AUTHORED number over
// ProseMirror's own label. Measured in the running app: bytes `1. a / 5. b /
// 9. c` display as 1, 5, 9 — where PM's auto-labels say 1, 2, 3 — so the
// rewritten digit is exactly what the user sees. The premise held for about
// 17 hours (96518af 08-23 22:45 → 68a0b38 08-24 16:08) and nothing noticed.
//
// The CHECK below is unchanged, because it was always doing something true and
// load-bearing; only its stated reason was wrong. What it actually proves:
//
//   the rewritten marker reparses into a listItem that is a NON-FIRST child of
//   an ordered list, so its digits can never become that list's `start`
//
// and therefore the blast radius is exactly the one item the user acted on:
// no SIBLING's number moves, in this editor or in any external renderer
// (Pandoc export, GitHub, downstream tooling), where a `start` rewrite WOULD
// silently renumber the whole list. That is the guarantee worth holding, and
// it is the one `provenNestingOnly` cannot give: its `leafSignature` records
// leaf type + decoded text and never reads a list's `ordered`/`start` at all.
//
// Unprovable → the caller falls back to the plain indentation strip, which
// keeps the author's own number and therefore the author's own `start`. The
// renumber can never make an outdent fail; that contract is unchanged.
//
// (A "measured 8 902 renumbering outdents, first-of-list 0 times" reachability
// claim also stood here. It is removed: no generating script for it exists in
// the repo, so nobody can re-run it. Treat this guard as a net whose
// reachability is unmeasured.)
export const provenNonFirstOrdinal = (candidate, markerAt) => {
  let tree
  try {
    tree = parseKernelMarkdown(candidate)
  } catch {
    return false
  }
  let found = false
  let ignored = false
  const walk = (node) => {
    if (found) return
    if (node?.type === 'list') {
      const items = node.children || []
      for (let i = 0; i < items.length; i += 1) {
        if (items[i]?.position?.start?.offset === markerAt) {
          found = true
          ignored = !!node.ordered && i > 0
          return
        }
      }
    }
    for (const child of node?.children || []) walk(child)
  }
  walk(tree)
  return found && ignored
}

const provenSeededEmptyIndent = (text, edits, seedAt) => {
  const candidate = applyEdits(text, edits)
  let before
  let after
  try {
    before = parseKernelMarkdown(text)
    after = parseKernelMarkdown(candidate)
  } catch {
    return false
  }
  let seeded = false
  const walk = (node, ancestors) => {
    if (seeded) return
    if (node?.type === 'paragraph' && node.position?.start?.offset === seedAt &&
        node.children?.length === 1 && node.children[0]?.type === 'text' &&
        node.children[0].value === NO_BREAK_SPACE &&
        ancestors.filter((a) => a?.type === 'listItem').length >= 2) {
      seeded = true
      return
    }
    for (const child of node?.children || []) walk(child, [...ancestors, node])
  }
  walk(after, [])
  if (!seeded) return false
  if (countHeadings(after) !== countHeadings(before)) return false
  const expected = [...sortedLeafValues(before), NO_BREAK_SPACE].sort()
  return JSON.stringify(sortedLeafValues(after)) === JSON.stringify(expected)
}

export function indentListItem({ doc, index, offset }) {
  const item = index.listItemAt(offset)
  if (!item) return { ok: false, code: 'unsupported-structure' }
  const prev = previousSibling(index, item)
  if (!prev) return { ok: false, code: 'unsupported-structure' }
  const width = prev.indent.length + prev.marker.length + prev.spacing.length -
    item.indent.length
  if (width <= 0) return { ok: false, code: 'unsupported-structure' }
  const rows = ownedLineIndexes(index, item)
  if (!rows) return { ok: false, code: 'unsupported-structure' }
  const pad = ' '.repeat(width)
  const edits = rows.map((i) => {
    const at = index.lines[i].start + item.quotePrefix.length
    return { from: at, to: at, insert: pad }
  })
  const refused = provenNestingOnly(index.text, edits, item)
  if (!refused) {
    // ORDINAL CONTINUATION (2026-08-31 user report: Tab 降级后「标号没有
    // 修改」). The pad alone keeps the item's AUTHORED number, and this
    // kernel displays authored ordinals faithfully — so a `3.` demoted
    // under a sublist ending in `1.` reads 1, 3. The Typora gesture
    // renumbers the demoted item to CONTINUE its destination run (last
    // nested ordered sibling + 1; 1 when it opens the sublist). Proven the
    // same way as the pad, and only taken when provable — an unprovable
    // rewrite falls back to the plain pad, which was already accepted.
    if (item.ordered) {
      const targetIndentLen = item.indent.length + width
      let lastNumber = null
      for (let li = item.markerLineIndex - 1; li > prev.markerLineIndex; li -= 1) {
        const line = index.lines[li]
        const body = index.text.slice(line.start + item.quotePrefix.length, line.end)
        const match = body.match(/^([ ]*)(\d+)([.)])[ \t]/)
        if (match && match[1].length === targetIndentLen) {
          lastNumber = Number(match[2])
          break
        }
      }
      const desired = lastNumber === null ? 1 : lastNumber + 1
      if (desired !== item.ordered.number) {
        const markerLine = index.lines[item.markerLineIndex]
        const prefixEnd = markerLine.start + item.quotePrefix.length
        const renumbered = rows.map((i) => {
          const at = index.lines[i].start + item.quotePrefix.length
          if (i !== item.markerLineIndex) return { from: at, to: at, insert: pad }
          return {
            from: prefixEnd,
            to: prefixEnd + item.indent.length + item.marker.length,
            insert: pad + item.indent + String(desired) + item.ordered.delimiter
          }
        })
        if (!provenNestingOnly(index.text, renumbered, item)) {
          return multiTxn(doc, renumbered, 'indent-list-item', offset)
        }
      }
    }
    return multiTxn(doc, edits, 'indent-list-item', offset)
  }

  // ORDERED-MARKER RESCUE (2026-08-22, from a user report with both refusal
  // toasts on screen). When the indented line opens a NEW sublist directly
  // after the previous item's paragraph, CommonMark only lets it interrupt
  // that paragraph if its number is 1 — `   4. x` is swallowed as a lazy
  // continuation instead, which is exactly what the proof above refused. The
  // Typora gesture is to renumber the demoted item to 1, so retry ONCE with
  // the item's OWN marker rewritten to `1` (same delimiter; siblings stay
  // untouched, per this file's contract). The marker-line pad and the marker
  // rewrite are ONE combined edit — two edits sharing a `from` would make
  // applyEdits' right-to-left order ambiguous. The same proof gates the
  // rewritten bytes; if they too restructure, the original refusal stands
  // (an EMPTY item still cannot interrupt a paragraph even as `1.`, so the
  // empty-item advice — type first, then indent — is now actually true).
  // EMPTY-ITEM SEED RESCUE (2026-08-22, user: the known refusal deserves a
  // solution). The seed spelling makes the nested empty item REPRESENTABLE,
  // exactly as it does for /task and the split seeds: write the indent PLUS
  // one U+00A0 at the item's content position, ledger it (`ascii: ''` — it
  // stands for NO keystroke and dissolves under the first typed character via
  // the existing seed pipeline; Backspace/Enter exit it through the
  // visually-empty family). An empty ORDERED item composes with the renumber
  // rescue below (as `1.` it may interrupt the paragraph once it has the
  // seed). TASK items keep the empty-task wall untouched.
  if (item.empty && !item.task) {
    const markerLineForSeed = index.lines[item.markerLineIndex]
    const seedPrefixEnd = markerLineForSeed.start + item.quotePrefix.length
    const renumber = !!item.ordered && item.ordered.number !== 1
    const base = !renumber ? edits : rows.map((i) => {
      const at = index.lines[i].start + item.quotePrefix.length
      if (i !== item.markerLineIndex) return { from: at, to: at, insert: pad }
      return {
        from: seedPrefixEnd,
        to: seedPrefixEnd + item.indent.length + item.marker.length,
        insert: pad + item.indent + '1' + item.ordered.delimiter
      }
    })
    const delta = base
      .filter((edit) => edit.from <= item.contentStart)
      .reduce((total, edit) => total + String(edit.insert ?? '').length - (edit.to - edit.from), 0)
    const seedAt = item.contentStart + delta
    const seeded = [...base, { from: item.contentStart, to: item.contentStart, insert: NO_BREAK_SPACE }]
    if (provenSeededEmptyIndent(index.text, seeded, seedAt)) {
      const txn = multiTxn(doc, seeded, 'indent-list-item', offset)
      txn.transaction.selection = { anchor: seedAt + 1, head: seedAt + 1 }
      txn.transaction.whitespaceMarks = [{ from: seedAt, to: seedAt + 1, ascii: '' }]
      return txn
    }
    return refused
  }
  if (!item.ordered || item.ordered.number === 1) return refused
  const markerLine = index.lines[item.markerLineIndex]
  const prefixEnd = markerLine.start + item.quotePrefix.length
  const renumbered = rows.map((i) => {
    const at = index.lines[i].start + item.quotePrefix.length
    if (i !== item.markerLineIndex) return { from: at, to: at, insert: pad }
    return {
      from: prefixEnd,
      to: prefixEnd + item.indent.length + item.marker.length,
      insert: pad + item.indent + '1' + item.ordered.delimiter
    }
  })
  if (provenNestingOnly(index.text, renumbered, item)) return refused
  return multiTxn(doc, renumbered, 'indent-list-item', offset)
}

export function outdentListItem({ doc, index, offset }) {
  const item = index.listItemAt(offset)
  if (!item || item.depth === 0) return { ok: false, code: 'unsupported-structure' }
  const parent = parentItem(index, item)
  if (!parent) return { ok: false, code: 'unsupported-structure' }
  const width = item.indent.length - parent.indent.length
  if (width <= 0) return { ok: false, code: 'unsupported-structure' }
  const rows = ownedLineIndexes(index, item)
  if (!rows) return { ok: false, code: 'unsupported-structure' }
  const edits = []
  for (const i of rows) {
    const at = index.lines[i].start + item.quotePrefix.length
    if (!/^[ \t]+$/.test(index.text.slice(at, at + width))) {
      return { ok: false, code: 'unsupported-structure' }
    }
    edits.push({ from: at, to: at + width, insert: '' })
  }
  // ORDERED-MARKER RENUMBER (outdent side, 2026-08-23 — the mirror of the
  // indent rescue above, found by the computer-use round's real-keyboard
  // repro: `1. one / 2. two / [Tab] 1. nested / [Shift+Tab] out` saved
  // `2. out`, the nested item's own number carried back to the root). The
  // stale number is already CommonMark-correct (ordinals follow sequence),
  // so this is a SOURCE-SPELLING gesture, not a semantics fix: an ordered
  // item landing under an ORDERED parent continues that list's count
  // (parent.number + 1) in the parent list's delimiter. A bullet parent has
  // no count to continue and an already-correct marker keeps its bytes —
  // byte-minimal, mirroring the indent side's no-renumber-when-joining. The
  // same reparse proof gates the rewritten bytes; if it refuses, the plain
  // strip below still runs (renumber never makes an outdent fail).
  //
  // SECOND proof since 2026-08-26: `provenNestingOnly` is blind to list
  // ordinals, so it can only show that no LEAF content moved — not that the
  // digits we spell are confined to this item. `provenNonFirstOrdinal` (above)
  // supplies the missing half: the rewritten item is not its list's first
  // child, so the digits cannot become the list's `start` and no sibling's
  // number moves anywhere downstream. Both must pass. (This renumber IS
  // visible to the user — that is the point of the gesture — so read that
  // function's ERRATUM before citing "inert" anywhere near it.)
  if (item.ordered && parent.ordered) {
    const marker = String(parent.ordered.number + 1) + parent.ordered.delimiter
    if (marker !== item.marker) {
      const markerLineAt = index.lines[item.markerLineIndex].start + item.quotePrefix.length
      const keptIndent = index.text.slice(markerLineAt + width, markerLineAt + item.indent.length)
      const renumbered = rows.map((i) => {
        const at = index.lines[i].start + item.quotePrefix.length
        if (i !== item.markerLineIndex) return { from: at, to: at + width, insert: '' }
        return {
          from: markerLineAt,
          to: markerLineAt + item.indent.length + item.marker.length,
          insert: keptIndent + marker
        }
      })
      // Where the rewritten marker lands in the CANDIDATE. The marker line is
      // `rows[0]` by construction (ownedLineIndexes starts at markerLineIndex
      // and only skips blank lines, which the marker line never is), so no
      // sibling edit precedes it — the sum is defensive, and stays correct if
      // that ordering assumption ever changes.
      const shift = renumbered
        .filter((edit) => edit.from < markerLineAt)
        .reduce((total, edit) => total + String(edit.insert ?? '').length - (edit.to - edit.from), 0)
      const markerAt = markerLineAt + shift + keptIndent.length
      if (!provenNestingOnly(index.text, renumbered, item) &&
          provenNonFirstOrdinal(applyEdits(index.text, renumbered), markerAt)) {
        return multiTxn(doc, renumbered, 'outdent-list-item', offset)
      }
    }
  }
  const refused = provenNestingOnly(index.text, edits, item)
  if (refused) return refused
  return multiTxn(doc, edits, 'outdent-list-item', offset)
}
