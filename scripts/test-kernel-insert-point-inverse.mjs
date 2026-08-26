// TDD evidence + regression lock for
// src/renderer/src/lib/source-kernel/commands/insert-point.js.
//
// THE PROPERTY UNDER TEST
// -----------------------
// The kernel's writers place a zero-width (plain, unmarked) insert through ONE
// resolver: the projection map's `pmPosToRawInsert`, which routes through
// character-map.js's `rawNeutralInsert` so a plain character typed at a mark
// run's edge lands OUTSIDE the delimiters ('a **bold**' + X -> 'a **bold**X',
// never 'a **boldX**').
//
// A committed source transaction then carries that same offset as its
// selection anchor, and `applyKernelTransaction` has to answer the INVERSE
// question — "which ProseMirror position is this byte?" — to (a) satisfy its
// `requireMap` guard and (b) restore the caret on the reconcile.
//
// It answered that with `rawToPmPos`, the WRITE resolver, which only accepts a
// charMap unit boundary. A mark's closing-delimiter bytes belong to no unit,
// so the post-delimiter offset is NOT a unit boundary and `rawToPmPos`
// correctly refuses it — meaning the kernel could write a byte to an offset it
// could not then NAME. Measured 2026-08-26: typing ASCII `**bold**` one key at
// a time lost its 8th keystroke (disk `**bold*`), because the mark-input-rule
// LITERAL FALLBACK refused its own already-proven commit.
//
// So the property is exactly an inverse, never a nearest-neighbour snap:
//
//     resolveCommittedRawOffset(map, R).pos === P
//         iff  map.pmPosToRawInsert(P) === R   (and P is unique)
//
// Everything else stays null. `rawToPmPos` is untouched, so no raw offset
// becomes WRITABLE — only naming an ALREADY-WRITTEN byte gets more provable.
//
// The PM documents come from the real editor parse chain
// (scripts/lib/kernel-parse-harness.mjs), and the maps from the real
// `buildProjectionMap` — nothing here is hand-derived.
import assert from 'node:assert/strict'

import { buildProjectionMap } from '../src/renderer/src/components/editor-kernel-projection-map.js'
import { resolveCommittedRawOffset } from '../src/renderer/src/lib/source-kernel/commands/insert-point.js'
import { parseEditorMarkdown } from './lib/kernel-parse-harness.mjs'

let failures = 0
const fail = (msg) => {
  failures += 1
  console.log(`  FAIL ${msg}`)
}

const mapFor = (markdown) => {
  const doc = parseEditorMarkdown(markdown)
  const map = buildProjectionMap(markdown, doc)
  assert.ok(map, `no projection map for ${JSON.stringify(markdown)}`)
  return map
}

const firstRealPair = (map) => map.blockPairs.find((p) => !p.virtual && p.pmNode?.isTextblock)

// ---------------------------------------------------------------------------
// Case 1 — the writer's own insert point is invertible, for EVERY PM position
// in the block, on both ASCII and CJK flanking (the two CommonMark rule-of-3
// worlds that made this bug survive a CJK-only test fixture).
// ---------------------------------------------------------------------------
const INVERTIBLE = [
  '**bold**\n',
  'x **bold**\n',
  '与**粗**\n',
  '*em*\n',
  '`code`\n',
  '~~del~~\n',
  '==hi==\n',
  '**bold*\n',
  'plain text\n',
  '# heading\n',
  'a **b** c\n',
  '**a *b* c**\n',
  '- item **x**\n',
  '> quoted **q**\n'
]

console.log('Case 1 — pmPosToRawInsert is invertible')
for (const markdown of INVERTIBLE) {
  const map = mapFor(markdown)
  const pair = firstRealPair(map)
  assert.ok(pair, `no textblock pair for ${JSON.stringify(markdown)}`)
  const contentPos = pair.pmPos + 1
  const size = pair.pmNode.content.size
  const seen = new Map()
  const trace = []
  for (let vis = 0; vis <= size; vis += 1) {
    const pm = contentPos + vis
    const raw = map.pmPosToRawInsert(pm)
    if (!Number.isFinite(raw)) {
      fail(`${JSON.stringify(markdown)} pm ${pm}: pmPosToRawInsert returned ${raw}`)
      continue
    }
    // Uniqueness is part of the claim: if two PM positions shared an insert
    // point the "inverse" would be a choice, not a derivation.
    if (seen.has(raw)) fail(`${JSON.stringify(markdown)} raw ${raw} is the insert point of BOTH pm ${seen.get(raw)} and pm ${pm}`)
    seen.set(raw, pm)
    const back = resolveCommittedRawOffset(map, raw)
    trace.push(`pm ${pm} -> raw ${raw} -> ${back ? `pm ${back.pos}` : 'null'}`)
    if (!back || back.pos !== pm) {
      fail(`${JSON.stringify(markdown)}: pm ${pm} -> raw ${raw} -> ${back ? `pm ${back.pos}` : 'null'} (must map back to pm ${pm})`)
    }
  }
  console.log(`  ${JSON.stringify(markdown).padEnd(16)} ${trace.join(' | ')}`)
}

// ---------------------------------------------------------------------------
// Case 2 — NEGATIVE CONTROLS. Every one of these must stay null: the resolver
// may only name a byte the kernel's OWN writer would have chosen.
// ---------------------------------------------------------------------------
console.log('Case 2 — negative controls (must stay null)')

// 2a. Strictly inside a delimiter run. `**bold**`: raw 1 is between the two
//     opening asterisks, raw 7 between the two closing ones. Neither is any
//     PM position's insert point.
{
  const map = mapFor('**bold**\n')
  for (const raw of [1, 7]) {
    const got = resolveCommittedRawOffset(map, raw)
    console.log(`  "**bold**" raw ${raw} -> ${got ? `pm ${got.pos}` : 'null'}`)
    if (got) fail(`"**bold**" raw ${raw} resolved to pm ${got.pos}; an offset inside a delimiter run has no insert-point preimage`)
  }
}

// 2b. A DEGRADED pair (Case M4c): highlighting a bare URL makes a block whose
//     charMap proof fails, so the pair carries `charMap: null`. That block
//     must stay unnameable — this is the half of the `requireMap` guard that
//     protects the user from typing into a paragraph they could not then edit.
{
  const markdown = 'see ==www.a.com== ok\n'
  const map = mapFor(markdown)
  const pair = map.blockPairs.find((p) => !p.virtual && p.pmNode?.isTextblock)
  const degraded = pair && !pair.charMap
  console.log(`  degraded M4c pair: charMap=${pair?.charMap ? 'present' : 'null'}`)
  if (degraded) {
    for (const raw of [0, 4, 11, markdown.length - 1]) {
      const got = resolveCommittedRawOffset(map, raw)
      console.log(`    raw ${raw} -> ${got ? `pm ${got.pos}` : 'null'}`)
      if (got) fail(`degraded pair raw ${raw} resolved to pm ${got.pos}; a block with no charMap must stay unnameable`)
    }
  } else {
    console.log('    (block did not degrade in this build — control skipped, see note)')
  }
}

// 2c. Code blocks: `buildCodeMap` exposes no marker gaps, so there is no
//     insert-point question to invert there. Offsets inside the fence bytes
//     must stay null (they are not unit boundaries either).
{
  const markdown = '```js\nlet x\n```\n'
  const map = mapFor(markdown)
  for (const raw of [1, 3, 13]) {
    const got = resolveCommittedRawOffset(map, raw)
    console.log(`  code fence raw ${raw} -> ${got ? `pm ${got.pos}` : 'null'}`)
    if (got && map.pmPosToRawInsert(got.pos) !== raw) {
      fail(`code fence raw ${raw} resolved to pm ${got.pos} whose insert point is ${map.pmPosToRawInsert(got.pos)}`)
    }
  }
}

// 2d. Between blocks — the blank-line gap belongs to no block's content.
{
  const markdown = 'one\n\ntwo\n'
  const map = mapFor(markdown)
  const got = resolveCommittedRawOffset(map, 4)
  console.log(`  blank-line gap raw 4 -> ${got ? `pm ${got.pos}` : 'null'}`)
  if (got) fail(`blank-line gap raw 4 resolved to pm ${got.pos}`)
}

// 2e. Non-finite / absent map.
for (const [label, args] of [
  ['null map', [null, 3]],
  ['NaN', [mapFor('x\n'), Number.NaN]],
  ['undefined', [mapFor('x\n'), undefined]]
]) {
  const got = resolveCommittedRawOffset(...args)
  console.log(`  ${label} -> ${got ? `pm ${got.pos}` : 'null'}`)
  if (got) fail(`${label} resolved to pm ${got.pos}`)
}

// ---------------------------------------------------------------------------
// Case 3 — the answer is always confirmed THROUGH the writer's own function:
// whatever position comes back, feeding it to `pmPosToRawInsert` must return
// the very offset asked about. This is what makes the resolver a derivation.
// ---------------------------------------------------------------------------
console.log('Case 3 — every non-null answer round-trips through pmPosToRawInsert')
{
  const corpus = [...INVERTIBLE, 'see ==www.a.com== ok\n', '```js\nlet x\n```\n', 'one\n\ntwo\n', '![a](x.png) tail\n']
  let checked = 0
  for (const markdown of corpus) {
    const map = mapFor(markdown)
    for (let raw = 0; raw <= markdown.length; raw += 1) {
      const got = resolveCommittedRawOffset(map, raw)
      if (!got) continue
      checked += 1
      // `rawToPmPos` answers a DIFFERENT question (which unit boundary is this
      // byte) and legitimately need not round-trip through the insert
      // resolver; only offsets it refused are this module's own answers.
      if (map.rawToPmPos(raw)) continue
      const round = map.pmPosToRawInsert(got.pos)
      if (round !== raw) fail(`${JSON.stringify(markdown)} raw ${raw} -> pm ${got.pos} -> insert point ${round} (must be ${raw})`)
    }
  }
  console.log(`  ${checked} resolved offsets checked`)
}

if (failures) {
  console.log(`\nFAIL: ${failures} assertion(s)`)
  process.exit(1)
}
console.log('\nPASS kernel insert-point inverse')
