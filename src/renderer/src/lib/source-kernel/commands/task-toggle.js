export function toggleTaskMarker({ doc, index, offset }) {
  const item = index.listItemAt(offset)
  if (!item?.task) return { ok: false, code: 'unsupported-structure' }
  const insert = item.task.checked ? '[ ]' : '[x]'
  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      from: item.task.from,
      to: item.task.to,
      insert,
      intent: 'toggle-task',
      selection: { anchor: item.contentStart, head: item.contentStart }
    }
  }
}
