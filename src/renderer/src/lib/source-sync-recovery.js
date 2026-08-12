export const sourceSyncRecoveryName = (title) => {
  const stem = String(title || 'HorseMD').replace(/\.(?:md|markdown|mdx)$/i, '')
  return `${stem}.horsemd-recovered.md`
}

const comparablePath = (path) => String(path || '')
  .replace(/\\/g, '/')
  .replace(/\/+$/, '')
  .toLocaleLowerCase()

// A persistent source-mapping ambiguity must never overwrite the original
// path. The caller supplies only the native save dialog and writer, making the
// separate-file boundary explicit and independently testable.
export async function saveSourceSyncRecovery({ api, title, originalPath, markdown }) {
  if (!api?.saveAs || !api?.writeFile || typeof markdown !== 'string') {
    return { ok: false, reason: 'unavailable' }
  }
  const path = await api.saveAs(sourceSyncRecoveryName(title), { excludedPath: originalPath })
  if (!path) return { ok: false, reason: 'cancelled' }
  if (originalPath && comparablePath(path) === comparablePath(originalPath)) {
    return { ok: false, reason: 'original-path' }
  }
  await api.writeFile(path, markdown)
  return { ok: true, path }
}
