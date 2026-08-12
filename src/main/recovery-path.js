import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const comparablePath = (path) => {
  if (typeof path !== 'string' || !path.trim()) return null
  const normalized = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLocaleLowerCase()
    : normalized
}

// Recovery Markdown has deliberately not passed the strict source-commit
// predicate. Resolve existing paths so aliases/symlinks cannot select the
// original document through a different spelling.
export async function isSameRecoveryFile(candidatePath, originalPath) {
  const candidate = comparablePath(candidatePath)
  const original = comparablePath(originalPath)
  if (!candidate || !original) return false
  if (candidate === original) return true
  try {
    const [candidateStat, originalStat, candidateReal, originalReal] = await Promise.all([
      stat(candidatePath),
      stat(originalPath),
      realpath(candidatePath),
      realpath(originalPath)
    ])
    if (candidateStat.dev === originalStat.dev && candidateStat.ino === originalStat.ino) return true
    return comparablePath(candidateReal) === comparablePath(originalReal)
  } catch {
    return false
  }
}
