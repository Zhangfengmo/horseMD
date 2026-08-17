// 源码事务内核：MarkdownDocument.text 是唯一持久化真相。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
import { splitsCrlfPair } from './character-map.js'

export function createMarkdownDocument(text) {
  return { text: String(text ?? ''), revision: 0 }
}

const normalizeEdits = (txn) => {
  if (Array.isArray(txn.edits)) return txn.edits
  return [{ from: txn.from, to: txn.to, insert: txn.insert }]
}

const validEdit = (edit, max) =>
  Number.isInteger(edit.from) && Number.isInteger(edit.to) &&
  edit.from >= 0 && edit.to <= max && edit.from <= edit.to

// Trailing caret after sequentially applying `edits` to whatever text they
// target: the last edit's old-coordinate end (`to`), shifted by the total
// delta (insert.length - removed length) accumulated across ALL edits —
// every earlier edit sits entirely before `last.to` (edits are validated
// non-overlapping and ascending), so its delta always applies.
const trailingCaret = (edits) => {
  let delta = 0
  let last = null
  for (const edit of edits) {
    delta += String(edit.insert ?? '').length - (edit.to - edit.from)
    last = edit
  }
  return last.to + delta
}

export function applySourceTransaction(doc, txn) {
  if (txn.baseRevision !== doc.revision) return { ok: false, code: 'stale-revision' }
  const edits = normalizeEdits(txn)
  if (!edits.length) return { ok: false, code: 'invalid-range' }
  // HISTORY EXEMPTION for the CRLF chokepoint below (re-review finding,
  // 2026-08-17). An inverse RESTORES bytes; it never authors new ones, so
  // it cannot introduce a line ending spelling the document did not already
  // have — and refusing one is strictly worse than allowing it, because a
  // refused undo leaves the user stuck with bytes they explicitly asked to
  // take back.
  //
  // Why this is airtight, not a convenient hole:
  //  * `inverseEdits` below is constructed HERE, from this same function's
  //    own forward edits: each entry replaces exactly the span this call
  //    inserted with exactly the bytes it removed, expressed in the
  //    post-forward coordinate space. Applying it therefore reconstructs the
  //    PRE-forward text byte-for-byte — the concatenation is the same
  //    slice-and-join, run backwards. `history.js`'s grouped inverse
  //    (`buildInverseTransaction`) does the same for a coalesced chain: it
  //    restores the pre-GROUP text over the post-group span.
  //  * So the reachable result of a `history-invert` is always a document
  //    this kernel already held and already published. The chokepoint exists
  //    to stop a write from CREATING a lone CR / bare LF that was not there;
  //    restoring one that WAS there is not creating it.
  //  * `intent` is not attacker-controlled: 'history-invert' is stamped by
  //    this function (and by history.js on the transactions it derives from
  //    these), never by a command, and the replay is gated twice over — by
  //    history.js's `lastKnownRevision` linear-chain pointer and by the
  //    `baseRevision` check above.
  //
  // What went wrong without it: any forward edit that CREATES a '\r\n'
  // adjacency at its own boundary has an inverse whose insert point sits
  // between that '\r' and that '\n'. `'a\rb\ncQ\n'` delete 'b' -> `'a\r\ncQ\n'`
  // is the minimal case; the re-review enumerated 122 such inverses among
  // 4239 accepted forward edits across 6 mixed-ending documents. Uniform-LF
  // and uniform-CRLF documents can never produce one (the adjacency already
  // existed), but a MIXED-ending document can — and a mixed-ending fenced
  // code block is kernel-mappable, so this was reachable.
  const restoring = txn.intent === 'history-invert'
  let previousEnd = -1
  for (const edit of edits) {
    if (!validEdit(edit, doc.text.length) || edit.from < previousEnd) {
      return { ok: false, code: 'invalid-range' }
    }
    // THE CRLF CHOKEPOINT (2026-08-17 whole-branch review, Critical 3).
    // Every raw-offset write in this kernel — the gateway's plain-text
    // commit, every command under commands/, the history's own inverse
    // replay — is applied HERE and nowhere else, so this is the one place
    // the rule can be enforced BY CONSTRUCTION rather than by five call
    // sites remembering to ask.
    //
    // An edit boundary strictly INSIDE a '\r\n' pair is byte-addressable but
    // structurally indivisible: writing there splits ONE line ending into a
    // lone CR plus a separate LF, so a uniform-CRLF document silently gains
    // a mixed-ending line. `bisectsLineEnding` (character-map.js) proved the
    // same thing map-locally for three of the write paths; the two that
    // never consulted it were reachable from ordinary UI — a structural
    // Enter at visible offset 4 of 'one\r\ntwo three\r\n' committed
    // 'one\r\r\n\r\n\ntwo three\r\n'.
    //
    // `splitsCrlfPair` is the map-free SUPERSET of that predicate (see its
    // own comment), so this refuses everything the local guards refuse and
    // never depends on a map being available.
    //
    // `restoring` (see the ADR above) is the ONE exemption: an inverse can
    // only put back bytes this document already had.
    if (!restoring &&
        (splitsCrlfPair(doc.text, edit.from) || splitsCrlfPair(doc.text, edit.to))) {
      return { ok: false, code: 'invalid-range' }
    }
    previousEnd = edit.to
  }
  const parts = []
  const inverseEdits = []
  let cursor = 0
  let delta = 0
  for (const edit of edits) {
    const insert = String(edit.insert ?? '')
    const removed = doc.text.slice(edit.from, edit.to)
    parts.push(doc.text.slice(cursor, edit.from), insert)
    inverseEdits.push({
      from: edit.from + delta,
      to: edit.from + delta + insert.length,
      insert: removed
    })
    delta += insert.length - removed.length
    cursor = edit.to
  }
  parts.push(doc.text.slice(cursor))
  // Caret positioned after the last inserted text in new coordinates, accounting for preceding edits' deltas
  const caret = trailingCaret(edits)
  const next = { text: parts.join(''), revision: doc.revision + 1 }
  // The inverse's selection is the inverse's OWN caret, computed against the
  // restored (post-inverse) document — NOT the forward transaction's
  // selection, which is a coordinate for the post-forward document and is
  // out of bounds once the inverse is applied (e.g. inserting 'XYZ' at 1 in
  // 'ab\n' puts the forward caret at 4, valid in the 6-char post-insert text;
  // reusing that for the inverse would carry anchor:4 into the restored
  // 3-char 'ab\n').
  const inverseCaret = trailingCaret(inverseEdits)
  return {
    ok: true,
    doc: next,
    edits,
    inverse: {
      baseRevision: next.revision,
      edits: inverseEdits,
      intent: 'history-invert',
      selection: { anchor: inverseCaret, head: inverseCaret }
    },
    selection: txn.selection ?? { anchor: caret, head: caret }
  }
}
