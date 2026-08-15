// 源码事务内核：MarkdownDocument.text 是唯一持久化真相。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。

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
  let previousEnd = -1
  for (const edit of edits) {
    if (!validEdit(edit, doc.text.length) || edit.from < previousEnd) {
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
