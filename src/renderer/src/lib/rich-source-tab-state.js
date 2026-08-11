export const applyVerifiedRichSnapshot = (tabs, id, content) => {
  if (!Array.isArray(tabs) || typeof content !== 'string') return tabs
  let changed = false
  const next = tabs.map((tab) => {
    if (tab.id !== id || (tab.content === content && !tab.pendingRichEdit)) return tab
    changed = true
    return { ...tab, content, pendingRichEdit: false }
  })
  return changed ? next : tabs
}

