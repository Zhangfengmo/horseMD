const callForMarkdown = (callback, ...args) => {
  try {
    const markdown = callback?.(...args)
    return typeof markdown === 'string' ? markdown : null
  } catch {
    return null
  }
}

// Closing an unsaved scratch document is a durability boundary even though it
// does not write an authored file. Keep the verified flush and strict rebuild
// as the first two exits, then retain the live best-effort recovery snapshot in
// the session only. The third exit never advances source baselines or touches
// a disk path; it prevents the last visible edit from existing only in a
// renderer that is about to be destroyed.
export const resolvePendingRichDraft = (
  editorApi,
  { allowRebuild = true, allowRecovery = true } = {}
) => {
  const flushed = callForMarkdown(editorApi?.flushMarkdown, { force: true })
  if (flushed != null) return flushed

  if (allowRebuild) {
    const rebuilt = callForMarkdown(editorApi?.rebuildMarkdownFromRich)
    if (rebuilt != null) return rebuilt
  }

  return allowRecovery
    ? callForMarkdown(editorApi?.getRecoveryMarkdown)
    : null
}
