// Milkdown publishes some structural input-rule updates after the visible
// ProseMirror transaction. A durability boundary (save/source switch) can run
// in that short window and see an intentionally fail-closed source mapping.
// Retry only after yielding to the pending callbacks; never replace the
// authored source with canonical Markdown just to make a retry succeed.
export async function settleEditorMarkdown(flush, {
  force = false,
  delays = [0, 40, 120, 260],
  shouldRetry = () => true
} = {}) {
  if (typeof flush !== 'function') return null

  let markdown = flush({ force })
  if (typeof markdown === 'string') return markdown
  if (!shouldRetry()) return null

  for (const delay of delays) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, delay)))
    markdown = flush({ force })
    if (typeof markdown === 'string') return markdown
    if (!shouldRetry()) return null
  }

  return null
}
