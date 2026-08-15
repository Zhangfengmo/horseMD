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
  const last = edits[edits.length - 1]
  // Caret positioned after the last inserted text in new coordinates, accounting for preceding edits' deltas
  const caret = last.from + String(last.insert ?? '').length +
    (delta - (String(last.insert ?? '').length - (last.to - last.from)))
  const next = { text: parts.join(''), revision: doc.revision + 1 }
  return {
    ok: true,
    doc: next,
    edits,
    inverse: {
      baseRevision: next.revision,
      edits: inverseEdits,
      intent: 'history-invert',
      selection: txn.selection ?? null
    },
    selection: txn.selection ?? { anchor: caret, head: caret }
  }
}
