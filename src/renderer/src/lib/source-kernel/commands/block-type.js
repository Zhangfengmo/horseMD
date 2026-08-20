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
// to the ROOT's own children. Walking `index.tree.children` rather than the
// flattened block index is what proves the target is TOP-LEVEL: a paragraph
// nested in a blockquote (reachable — `shouldShow` excludes list items but
// NOT blockquotes) is not a root child, so it is never found here and the
// command refuses instead of writing a marker whose meaning inside a quote
// this function has not proven.
function within(node, offset) {
  const start = node?.position?.start?.offset
  const end = node?.position?.end?.offset
  return Number.isInteger(start) && Number.isInteger(end) && offset >= start && offset < end
}

function topLevelNodeAt(index, offset) {
  const children = index.tree?.children || []
  const direct = children.find((node) => within(node, offset))
  if (direct) return direct
  if (offset > 0) {
    const before = children.find((node) => within(node, offset - 1))
    if (before && offset === before.position.end.offset) return before
  }
  return null
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

export function setBlockTypeFromQuery({ doc, index, offset, target }) {
  const marker = BLOCK_TYPE_MARKERS[target]
  if (!marker) return { ok: false, code: 'unsupported-structure' }
  if (!Number.isInteger(offset) || offset < 1) return { ok: false, code: 'unsupported-structure' }

  const node = topLevelNodeAt(index, offset)
  if (!node || !SOURCE_TYPES.has(node.type)) return { ok: false, code: 'unsupported-structure' }

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
