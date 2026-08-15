export function replaceVisibleText({ doc, map, visFrom, visTo, insert, intent = 'insert-text' }) {
  const range = map?.rawRangeForVisibleRange(visFrom, visTo)
  if (!range) return { ok: false, code: 'unmapped-selection' }
  const text = String(insert ?? '')
  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      from: range.from,
      to: range.to,
      insert: text,
      intent,
      selection: { anchor: range.from + text.length, head: range.from + text.length }
    }
  }
}
