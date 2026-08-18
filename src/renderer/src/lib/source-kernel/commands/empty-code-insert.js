// 空围栏首次输入：空的代码块只有一个可寻址位置，而那个位置是下一物理行的开头
// ——对一个正常闭合的围栏来说，那就是结束围栏本身。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
//
// WHY THIS COMMAND EXISTS
// -----------------------
// `code-map.js`'s `emptyCodeMap` gives a zero-content fence exactly ONE raw
// offset: `openLine.end + openLine.ending.length` — "where a first content
// line would begin". That is an honest statement about the map, but it is NOT
// an insert position: for the ordinary spelling
//
//     ```js
//     ```
//
// the next physical line IS the closing fence, so writing the typed character
// there verbatim commits '```js\nx```'. Measured against this kernel's own
// parser, that is not a cosmetic defect:
//
//     '```js\nx```\n\n尾段落。\n'  ->  ONE code node, value 'x```\n\n尾段落。'
//
// the terminator is gone and the whole remainder of the document is swallowed
// into the code block. The blockquote-prefixed shape fails a second way on top
// of that: the anchor sits BEFORE the closing line's own '> ', so the character
// lands in front of the quote marker ('> ```js\nx> ```\n' — an empty quoted
// fence followed by a paragraph reading literally 'x> ```').
//
// The write path is therefore what has to own this, not each caller: a first
// insert into an empty fence must OPEN A CONTENT LINE — the block's own
// per-line prefix, the text, and the block's own line ending — so that the
// bytes after the edit still say what ProseMirror shows.
//
// NOTHING IS DECIDED BY CONSTRUCTION
// ----------------------------------
// `emptyCodeMap` reports `linePrefix`/`lineEnding` derived from the OPEN FENCE
// LINE alone, because a zero-content block has no content line to prove them
// against (the non-empty branch of `buildCodeMap` proves them byte-for-byte
// against every content line; the empty branch cannot). That derivation is
// WRONG for at least one real shape — a fence opened by a list marker:
//
//     - ```js
//       ```
//
// where the open line's prefix is '- ' but a content line's continuation
// prefix is '  '. Writing '- x' there would create a SECOND LIST ITEM. (The
// non-empty version of that same block is already refused outright: its
// content line does not reproduce '- ', so `buildCodeMap` returns null and the
// block is not editable at all.)
//
// So the candidate document is REPARSED and four things must hold before a
// byte moves — the same discipline commands/trailing-whitespace.js established
// for its own rewrite, reusing its `blockEditIsObservable`:
//   1. the document's block structure is unchanged;
//   2. a `code` node still starts at the same offset;
//   3. its span grew by exactly the number of bytes written;
//   4. its decoded `value` is EXACTLY the text ProseMirror inserted — which is
//      what proves the prefix/ending bytes became SYNTAX and not content, and
//      what catches the list-marker shape above.
// The fence's info string is checked too (5): a fence with no terminator at all
// ('```js' as the document's last line, whose anchor is the open line's own
// end) would otherwise absorb the character into its LANGUAGE ('```jsx'), and
// `value` alone would not notice.
//
// REFUSED, NAMED RATHER THAN GUESSED
// ----------------------------------
// The unterminated shape just mentioned ('```js' with no trailing line ending)
// fails the proof and is refused, bytes untouched. It IS spellable — write the
// missing ending first — but only by GUESSING which ending an empty,
// terminator-less document uses, and this repo has a whole bug family from line
// endings. A refused keystroke is recoverable; a guessed '\n' in a CRLF file is
// a byte nobody asked for. Same for any other shape the reparse cannot confirm.
import { parseKernelMarkdown } from '../syntax-index.js'
import { blockEditIsObservable } from './trailing-whitespace.js'

const UNSUPPORTED = { ok: false, code: 'unsupported-structure' }
const NOT_STRUCTURAL = { ok: false, code: 'not-structural' }

// The decoded content of a fenced code block is its `value` — it has no
// children, so trailing-whitespace.js's default (inline-text) decoder would
// report '' for every candidate and prove nothing.
const codeValue = (node) => (typeof node?.value === 'string' ? node.value : null)

// Spell the FIRST insert into an empty fenced code block as a complete content
// line.
//
// Inputs (all state the caller already holds):
//   doc     the kernel document (`text` + `revision`)
//   block   the mdast `code` node the projection map paired with this block
//   charMap `emptyCodeMap`'s output for it (`visibleLength === 0`, plus the
//           `linePrefix`/`lineEnding` derived from the open fence line)
//   offset  the raw insert offset the map resolved (the empty map's only one)
//   insert  the text ProseMirror inserted — non-empty; any line breaks in it
//           must already be spelled with this block's own `lineEnding`, which
//           is re-checked here rather than trusted
//
// Refusals:
//   `not-structural`        — this is not the shape the command claims (the
//                             caller's prefilter should already have excluded
//                             it); nothing is written and nothing changes.
//   `unsupported-structure` — this IS the shape, and no spelling could be
//                             proven. The caller must refuse: the pre-existing
//                             literal write is known to destroy the fence.
export function spellEmptyCodeInsert({ doc, block, charMap, offset, insert }) {
  const text = doc?.text
  if (typeof text !== 'string' || !Number.isInteger(doc?.revision)) return NOT_STRUCTURAL
  if (block?.type !== 'code') return NOT_STRUCTURAL
  if (charMap?.visibleLength !== 0) return NOT_STRUCTURAL
  if (typeof insert !== 'string' || insert === '') return NOT_STRUCTURAL
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return NOT_STRUCTURAL

  const linePrefix = charMap.linePrefix
  const lineEnding = charMap.lineEnding
  if (typeof linePrefix !== 'string' || typeof lineEnding !== 'string' || lineEnding === '') {
    return UNSUPPORTED
  }
  // Break spelling, re-derived (the gateway's own break check is skipped for
  // this shape because this command owns the whole spelling): every break in
  // the inserted text must be the block's OWN ending, so a bare '\n' pasted
  // into a CRLF fence is refused here rather than silently re-spelled — the
  // same rule, and the same reason, as editor-kernel-gateway.js's.
  const breaks = insert.match(/\r\n|\r|\n/g) || []
  if (breaks.some((brk) => brk !== lineEnding)) return UNSUPPORTED

  // The text, with every interior break re-opening the block's per-line prefix
  // — the same expansion the gateway applies to a NON-empty fence, for the same
  // reason (`buildCodeMap` requires every content line to reproduce the prefix
  // byte-for-byte).
  const body = linePrefix +
    (linePrefix ? insert.split(lineEnding).join(lineEnding + linePrefix) : insert)

  // TWO CANDIDATE SPELLINGS, tried in order and each proven identically. They
  // differ in exactly one fact the empty character map cannot express: whether
  // the anchor line is a line the block ALREADY OWNS or the closing fence.
  //
  //   'open'  '```js' LE '```'      the anchor line IS the closing fence, so a
  //                                 new content line has to be opened and
  //                                 terminated -> body + LE.
  //   'fill'  '```js' LE LE '```'   the block already has one EMPTY content
  //                                 line (still `value === ''`, same anchor) —
  //                                 this is the spelling commands/block-insert.js
  //                                 writes for the slash menu's `/code`. Adding
  //                                 a terminator here would decode as 'x' + a
  //                                 newline, i.e. a character the user did not
  //                                 type -> body alone.
  //
  // Deciding by trial-and-PROOF rather than by inspecting the bytes at the
  // anchor is deliberate: the decision is exactly "what does the parser make of
  // this?", and the parser is the authority this kernel defers to everywhere
  // else. 'open' is tried first because it is the shape every ordinary document
  // has; a first-match win is safe because a passing proof already establishes
  // that the candidate says exactly what ProseMirror shows.
  const attempts = [body + lineEnding, body]

  const blockStart = block.position?.start?.offset
  const blockEnd = block.position?.end?.offset
  if (!Number.isInteger(blockStart) || !Number.isInteger(blockEnd)) return UNSUPPORTED
  // The insert must land strictly INSIDE this block's span — never before its
  // opening fence, never past its end. (`emptyCodeMap`'s anchor satisfies this
  // for every terminated fence; the degenerate terminator-less shape is caught
  // by the reparse below, not here.)
  if (offset <= blockStart || offset > blockEnd) return UNSUPPORTED

  // The BASELINE is re-parsed rather than taken from the caller's `block`: that
  // node comes from `buildSyntaxIndex`'s tree, which carries
  // `injectHighlightNodes`' split text nodes the candidate parse does not, so
  // comparing the two structures directly would report differences that are
  // purely an artefact of the injection. Same reasoning block-insert.js and
  // image-attrs.js record for their own axis-(b) comparisons. The baseline node
  // is then re-found by type AND span, so the proof never depends on the map
  // having been bound to these exact bytes.
  let baselineTree
  try {
    baselineTree = parseKernelMarkdown(text)
  } catch {
    return UNSUPPORTED
  }
  let baseline = null
  const walk = (node) => {
    if (baseline) return
    if (node?.type === 'code' && node.position?.start?.offset === blockStart &&
        node.position?.end?.offset === blockEnd) {
      baseline = node
      return
    }
    for (const child of node?.children || []) walk(child)
  }
  walk(baselineTree)
  if (!baseline || codeValue(baseline) !== '') return UNSUPPORTED

  for (const written of attempts) {
    const candidate = text.slice(0, offset) + written + text.slice(offset)
    const proven = blockEditIsObservable({
      baselineTree,
      block: baseline,
      candidate,
      // (4): the block must decode to EXACTLY what ProseMirror holds — no
      // prefix bytes leaking in as content, no ending leaking in as a trailing
      // newline, nothing absorbed from after the block.
      expectedText: insert,
      delta: written.length,
      decode: codeValue,
      // (5): the info string must survive untouched. Without this, a fence with
      // no terminator ('```js' at EOF, whose anchor is the open line's own end)
      // could absorb the character into its LANGUAGE ('```jsx') — a shape
      // `expectedText` also rejects, but for a less precise reason. Checked
      // explicitly so the refusal is about the right fact.
      matches: (found) => (found.lang ?? null) === (baseline.lang ?? null)
    })
    if (!proven) continue
    const caret = offset + linePrefix.length + insert.length
    return {
      ok: true,
      opened: written.length > body.length,
      edit: { from: offset, to: offset, insert: written },
      transaction: {
        baseRevision: doc.revision,
        from: offset,
        to: offset,
        insert: written,
        intent: 'empty-code-insert',
        selection: { anchor: caret, head: caret }
      }
    }
  }
  return UNSUPPORTED
}
