import assert from 'node:assert/strict'
import { applyVerifiedRichSnapshot } from '../src/renderer/src/lib/rich-source-tab-state.js'

const original = [
  { id: 'a', content: 'old', savedContent: 'disk', pendingRichEdit: true },
  { id: 'b', content: 'other', savedContent: 'other', pendingRichEdit: false }
]

const next = applyVerifiedRichSnapshot(original, 'a', 'verified')
assert.notEqual(next, original)
assert.deepEqual(next[0], {
  id: 'a',
  content: 'verified',
  savedContent: 'disk',
  pendingRichEdit: false
})
assert.equal(next[1], original[1])

const unchanged = applyVerifiedRichSnapshot(next, 'a', 'verified')
assert.equal(unchanged, next)

const missing = applyVerifiedRichSnapshot(next, 'missing', 'ignored')
assert.equal(missing, next)

const invalid = applyVerifiedRichSnapshot(next, 'a', null)
assert.equal(invalid, next)

console.log('PASS verified rich snapshot updates only App content/pending state')
