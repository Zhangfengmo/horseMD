// A brand-new (scratch) document builds its authored bytes on a different
// path from the preservation façade, so it must declare the same verification
// context — otherwise the verified commit refuses every candidate and the
// document can never be saved.
//
// `generatedScratchEmptyHeading` tells the expected-side projection to ignore
// Crepe's empty H1 scaffold. That is only true when the CANDIDATE omits it.
// Hard-coding it to `true` dropped the heading from one side only, so a new
// document whose empty title had become authored content failed 100% of the
// time (reported in the field: "没有填写标题就会 100% 触发").
import { strict as assert } from 'node:assert'
import { scratchCandidateContext } from '../src/renderer/src/components/editor-source-verification.js'

// Candidate WITHOUT the scaffold heading: the expected side must ignore its own.
for (const omits of ['正文\n', '- 项目\n', '', '| a |\n| - |\n']) {
  assert.equal(
    scratchCandidateContext(omits).generatedScratchEmptyHeading,
    true,
    `a candidate without the scaffold must let the expected side drop it: ${JSON.stringify(omits)}`
  )
}

// Candidate WITH an empty heading: it is authored content on both sides now,
// so the expected side must keep its heading or the two can never match.
for (const keeps of ['#\n\n正文\n', '#\n', '#  \n\n正文\n', '#']) {
  assert.equal(
    scratchCandidateContext(keeps).generatedScratchEmptyHeading,
    false,
    `a candidate that kept the empty heading must not ask for it to be dropped: ${JSON.stringify(keeps)}`
  )
}

// A real (non-empty) title is ordinary content; the scaffold rule is unrelated.
assert.equal(scratchCandidateContext('# 标题\n\n正文\n').generatedScratchEmptyHeading, true)

// Table placeholder provenance travels with the flag: a scratch document that
// strips empty-cell placeholders needs the same proof the façade attaches.
const withTable = scratchCandidateContext('#\n\n|  |\n', { placeholderCells: new Set(['0:0:0']) })
assert.equal(withTable.generatedScratchEmptyHeading, false)
assert.ok(withTable.placeholderCells instanceof Set, 'table provenance must be preserved')
assert.equal(withTable.placeholderCells.size, 1)

// A missing table context is not fabricated.
assert.equal(scratchCandidateContext('正文\n', null).placeholderCells, undefined)

console.log('PASS scratch candidate context: the scaffold flag describes the candidate, and table provenance travels with it')
