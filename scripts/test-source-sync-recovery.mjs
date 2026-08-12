import assert from 'node:assert/strict'
import { link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  saveSourceSyncRecovery,
  sourceSyncRecoveryName
} from '../src/renderer/src/lib/source-sync-recovery.js'
import { bestEffortRecoveryMarkdown } from '../src/renderer/src/components/editor-source-verification.js'
import { isSameRecoveryFile } from '../src/main/recovery-path.js'

assert.equal(sourceSyncRecoveryName('report.md'), 'report.horsemd-recovered.md')
assert.equal(sourceSyncRecoveryName('notes.markdown'), 'notes.horsemd-recovered.md')

const writes = []
const saved = await saveSourceSyncRecovery({
  title: 'report.md',
  markdown: '# live rich edit\n',
  api: {
    saveAs: async (name) => `/tmp/${name}`,
    writeFile: async (path, content) => writes.push({ path, content })
  }
})
assert.deepEqual(saved, { ok: true, path: '/tmp/report.horsemd-recovered.md' })
assert.deepEqual(writes, [{
  path: '/tmp/report.horsemd-recovered.md',
  content: '# live rich edit\n'
}])

let wroteAfterCancel = false
const cancelled = await saveSourceSyncRecovery({
  title: 'report.md',
  markdown: 'unsaved',
  api: {
    saveAs: async () => null,
    writeFile: async () => { wroteAfterCancel = true }
  }
})
assert.deepEqual(cancelled, { ok: false, reason: 'cancelled' })
assert.equal(wroteAfterCancel, false)

let wroteOverOriginal = false
const originalPath = '/tmp/report.md'
const rejectedOriginal = await saveSourceSyncRecovery({
  title: 'report.md',
  originalPath,
  markdown: 'unverified recovery',
  api: {
    saveAs: async () => originalPath,
    writeFile: async () => { wroteOverOriginal = true }
  }
})
assert.deepEqual(rejectedOriginal, { ok: false, reason: 'original-path' })
assert.equal(wroteOverOriginal, false, 'recovery output must never overwrite the original file')

const pathRoot = await mkdtemp(join(tmpdir(), 'horsemd-recovery-path-'))
try {
  const original = join(pathRoot, 'original.md')
  const alias = join(pathRoot, 'alias.md')
  const hardlink = join(pathRoot, 'hardlink.md')
  const separate = join(pathRoot, 'separate.md')
  await writeFile(original, '# original\n')
  await symlink(original, alias)
  await link(original, hardlink)
  assert.equal(await isSameRecoveryFile(original, original), true)
  assert.equal(await isSameRecoveryFile(alias, original), true, 'a symlink alias must not bypass the original-file guard')
  assert.equal(await isSameRecoveryFile(hardlink, original), true, 'a hardlink must not bypass the original-file guard')
  assert.equal(await isSameRecoveryFile(separate, original), false)
} finally {
  await rm(pathRoot, { recursive: true, force: true })
}

// Rebuild is a source commit and stays behind semantic verification. Recovery
// is a best-effort export to a separately chosen file, so its canonical asset
// must be available without reusing that source-commit predicate.
const canonical = '# live edit\n\n<br />\n'
const recoveryMarkdown = bestEffortRecoveryMarkdown(canonical)
assert.ok(recoveryMarkdown.includes('# live edit'), 'a recovery copy must retain the live content')
assert.doesNotMatch(
  recoveryMarkdown,
  /<br\s*\/?>/i,
  'a recovery copy must not persist the editor-owned standalone empty-block placeholder'
)

console.log('PASS source-sync recovery: persistent ambiguity writes only a user-chosen recovery copy')
