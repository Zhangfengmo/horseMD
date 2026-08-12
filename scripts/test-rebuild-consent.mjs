// Cancelling the source-rebuild prompt must END the attempt. Both fail-closed
// boundaries (save, source toggle) ask on their own path but offer the
// follow-up recovery copy from another place, so a refusal has to travel
// between them — otherwise cancelling one dialog immediately opened a second
// file picker the user never asked for.
import { strict as assert } from 'node:assert'
import {
  askRebuildConsent,
  consumeRebuildDeclined
} from '../src/renderer/src/lib/rebuild-consent.js'

// Accepting leaves nothing for the follow-up exit to consume.
assert.equal(askRebuildConsent('rebuild?', () => true), true)
assert.equal(consumeRebuildDeclined(), false, 'accepting must not look like a refusal')

// Declining is recorded exactly once, for the boundary that asked.
assert.equal(askRebuildConsent('rebuild?', () => false), false)
assert.equal(consumeRebuildDeclined(), true, 'the refusal must reach the follow-up exit')
assert.equal(
  consumeRebuildDeclined(),
  false,
  'a consumed refusal must not block a later, independent attempt'
)

// A non-boolean answer is not consent.
assert.equal(askRebuildConsent('rebuild?', () => undefined), false)
assert.equal(consumeRebuildDeclined(), true)

// Asking again after a refusal clears the previous answer, so a user who
// declines once and accepts on the next save is not treated as refusing.
assert.equal(askRebuildConsent('rebuild?', () => false), false)
assert.equal(askRebuildConsent('rebuild?', () => true), true)
assert.equal(consumeRebuildDeclined(), false, 'the latest answer wins')

console.log('PASS rebuild consent: a cancelled rebuild ends the attempt instead of opening the recovery picker')
