// P6 Task 3 — the source kernel's degradation must be OBSERVABLE.
//
// Two things are pinned here, both headless:
//  1. `describeKernelStatus` (src/renderer/src/lib/kernel-status.js), the pure
//     rule the StatusBar renders. Its most important assertion is the NEGATIVE
//     one: a healthy document must produce NO indicator. A false-positive
//     warning badge would be worse than the silence it replaces.
//  2. every string it names exists in BOTH languages in i18n.jsx — the task's
//     "all strings via i18n, zh + en, no hardcoding" requirement, checked
//     rather than trusted.
//
// The controller side (`getKernelStatus`, and the fact that a chunk-loaded
// fallback names its own cause) is asserted in
// scripts/test-kernel-mode-headless.mjs, next to the harness that can build a
// real projection map.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describeKernelStatus } from '../src/renderer/src/lib/kernel-status.js'

console.log('--- kernel status indicator ---')

// Nothing to show: the kernel is off, still attaching, or gone. `null` is the
// "render nothing at all" answer, distinct from "render a healthy label".
for (const status of [null, undefined, {}, { state: 'off' }, { state: 'pending' }, { state: 'nonsense' }]) {
  assert.equal(describeKernelStatus(status), null,
    `${JSON.stringify(status)} must produce no descriptor`)
}

// NEGATIVE CONTROL (the point of the task): a normal document gets a label for
// the menu but NEVER an indicator mark.
{
  const d = describeKernelStatus({ state: 'normal', readOnlyBlocks: 0, blocks: 42, reason: null })
  assert.equal(d.level, 'normal')
  assert.equal(d.indicator, false, 'a healthy document must not paint a warning mark')
  assert.equal(d.count, 0)
  assert.equal(d.labelKey, 'kernelStatus.normal')
  assert.equal(d.detailKey, 'kernelStatus.normalDetail')
}

// ...and the same holds if a caller ever hands over a 'partial' STATE with a
// zero count: the descriptor is decided by the count, not by the label, so a
// bookkeeping slip cannot manufacture a warning out of nothing.
{
  const d = describeKernelStatus({ state: 'partial', readOnlyBlocks: 0, blocks: 3 })
  assert.equal(d.level, 'normal')
  assert.equal(d.indicator, false)
}

// Some blocks read-only.
{
  const d = describeKernelStatus({ state: 'partial', readOnlyBlocks: 2, blocks: 9 })
  assert.equal(d.level, 'partial')
  assert.equal(d.indicator, true)
  assert.equal(d.count, 2)
  assert.equal(d.labelKey, 'kernelStatus.partial')
  assert.equal(d.detailKey, 'kernelStatus.partialDetail')
}

// Fell back to legacy — and the hover detail is the SAME message the fallback
// toast raised, so the two cannot drift apart.
{
  const generic = describeKernelStatus({ state: 'legacy', reason: 'unmappable' })
  assert.equal(generic.level, 'legacy')
  assert.equal(generic.indicator, true)
  assert.equal(generic.detailKey, 'kernelMode.unmappable')

  const chunked = describeKernelStatus({ state: 'legacy', reason: 'chunked' })
  assert.equal(chunked.detailKey, 'kernelMode.unmappableChunked',
    'an above-threshold fallback keeps its own explanation in the hover detail')

  const unknown = describeKernelStatus({ state: 'legacy' })
  assert.equal(unknown.detailKey, 'kernelMode.unmappable',
    'a fallback with no recorded reason degrades to the generic explanation')
}

// Every key the rule can name must exist once per language.
{
  const i18n = readFileSync(new URL('../src/renderer/src/i18n.jsx', import.meta.url), 'utf8')
  const keys = new Set()
  for (const status of [
    { state: 'normal', readOnlyBlocks: 0 },
    { state: 'partial', readOnlyBlocks: 1 },
    { state: 'legacy', reason: 'unmappable' },
    { state: 'legacy', reason: 'chunked' }
  ]) {
    const d = describeKernelStatus(status)
    keys.add(d.labelKey)
    keys.add(d.detailKey)
  }
  assert.equal(keys.size, 7, 'sanity: the rule names seven distinct strings')
  for (const key of keys) {
    assert.equal((i18n.match(new RegExp(`'${key.replace('.', '\\.')}':`, 'g')) || []).length, 2,
      `${key} must be declared exactly once per language (en + zh)`)
  }
  // The counted-blocks string must carry the placeholder the renderer
  // substitutes — a translation that dropped it would silently show no number.
  for (const line of i18n.split('\n')) {
    if (line.includes("'kernelStatus.partialDetail':")) {
      assert.ok(line.includes('{count}'), `partialDetail must keep the {count} placeholder: ${line.trim()}`)
    }
  }
}

console.log('PASS kernel status indicator')
