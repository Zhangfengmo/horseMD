// 文末占位空段落：它不对应任何字节，所以在它上面按 Backspace 不是删除，而是把
// 光标移回上一个块的末尾；只有用户自己按 Enter 写出来的多余空行才需要真正删字节。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
//
// WHY THIS COMMAND EXISTS
// -----------------------
// User report, with a screenshot: the caret sits in the empty paragraph at the
// very END of the document — the one showing the 「输入 / 唤起命令，或开始写…」
// placeholder, right after an ordered list — and Backspace raises
// 「源码权威内核实验阶段暂未支持此操作 (unsupported-input-type)」.
//
// WHICH EMPTY PARAGRAPH IS IT? Measured in the built app, and the answer is not
// the one the shape suggests. There are only ever TWO ways that trailing empty
// paragraph can exist, and NEITHER of them is a real block:
//
//   1. `@milkdown/plugin-trailing`'s synthetic node — Crepe ships it
//      unconditionally, and it appends an empty paragraph whenever the
//      document's last top-level child is not a heading/paragraph. A list
//      qualifies, which is exactly the reported document.
//   2. A controller-vouched SPLIT placeholder — the user pressed Enter at the
//      end of the document, which writes real blank-line bytes that CommonMark
//      then collapses to nothing, so the caret needs a PM home the reparse
//      cannot supply.
//
// A "real empty last paragraph backed by a trailing blank line" DOES NOT EXIST
// and cannot be constructed: CommonMark discards trailing blank lines, so they
// produce no block at all. Verified in the app — a document ending
// '...213123\n\n' renders the SAME three blocks as one ending '...213123', and
// the last one is the synthetic node either way.
//
// So the byte answer for Backspace there is: THERE IS NOTHING TO DELETE. The
// placeholder owns no bytes; the correct behaviour is a view-only caret move
// back to the end of the previous block's content, and a refusal toast for a
// zero-byte view adjustment is a UX bug rather than safety.
//
// WHAT THIS COMMAND DOES OWN is the one case where bytes ARE involved: the user
// pressed Enter at the document end (writing a blank line), then pressed
// Backspace to take it back. Those surplus line endings are real bytes, they
// are invisible, and leaving them behind makes the round trip dirty the file
// for nothing. They are also the only trailing bytes it is safe to touch:
//
//   * a document ending in ONE line ending is the ordinary, conventional state
//     of a text file — never trimmed here;
//   * a document ending in NO line ending is equally fine — never extended;
//   * only the SURPLUS (a second and further line ending, i.e. a genuine blank
//     line) is removed, and even then only after a reparse proves the block
//     sequence is byte-for-byte unchanged.
//
// That last proof is what makes this safe rather than merely plausible. It is
// stated over EVERY block's type and span, so a trim that shifted, merged, split
// or re-typed any block — including the loose/tight list boundary a trailing
// blank line can be suspected of touching — refuses instead of writing.
import { buildSyntaxIndex } from '../syntax-index.js'

const NOT_STRUCTURAL = { ok: false, code: 'not-structural' }

// One line ending, in any of the three spellings, at `at`. Returns its length
// or 0.
const endingAt = (text, at) => {
  if (text[at] === '\r') return text[at + 1] === '\n' ? 2 : 1
  return text[at] === '\n' ? 1 : 0
}

// Every block's identity, as the flat evidence the trim must not disturb.
const blockSignature = (text) => {
  const index = buildSyntaxIndex(text)
  const rows = []
  const walk = (node) => {
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (node.type !== 'root') rows.push(`${node.type}:${start}-${end}`)
    for (const child of node.children || []) walk(child)
  }
  walk(index.tree)
  return rows.join('|')
}

// Inputs:
//   doc         the kernel document (`text` + `revision`)
//   contentEnd  the raw offset where the document's LAST real block ends — the
//               caller reads it from the projection map's last paired mdast
//               block, so this command never has to guess where content stops
export function trimTrailingBlankLines({ doc, contentEnd }) {
  const text = doc?.text
  if (typeof text !== 'string' || !Number.isInteger(doc?.revision)) return NOT_STRUCTURAL
  if (!Number.isInteger(contentEnd) || contentEnd < 0 || contentEnd > text.length) return NOT_STRUCTURAL

  const tail = text.slice(contentEnd)
  if (tail === '' || !/^[\r\n]+$/.test(tail)) return NOT_STRUCTURAL
  // Keep the FIRST line ending: a file that ends with exactly one newline is the
  // conventional state and is not this command's business.
  const keep = endingAt(text, contentEnd)
  if (!keep) return NOT_STRUCTURAL
  const from = contentEnd + keep
  if (from >= text.length) return NOT_STRUCTURAL // no surplus — nothing to trim

  const candidate = text.slice(0, from)
  // THE PROOF: trimming must leave every block exactly where and what it was.
  let before
  let after
  try {
    before = blockSignature(text)
    after = blockSignature(candidate)
  } catch {
    return NOT_STRUCTURAL
  }
  if (before !== after) return NOT_STRUCTURAL

  return {
    ok: true,
    trimmed: text.length - from,
    edit: { from, to: text.length, insert: '' },
    transaction: {
      baseRevision: doc.revision,
      from,
      to: text.length,
      insert: '',
      intent: 'trim-trailing-blank-lines',
      selection: { anchor: contentEnd, head: contentEnd }
    }
  }
}
