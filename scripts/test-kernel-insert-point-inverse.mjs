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
import { readFileSync } from 'node:fs'

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
//     charMap proof fails, so the pair carries `charMap: null`. That block must
//     stay unnameable — this is the half of the `requireMap` guard that protects
//     the user from typing into a paragraph they could not then edit.
//
//     THIS CONTROL MAY NOT SELF-SKIP (correction M5, 2026-08-26). It used to be
//     wrapped in `if (degraded) { … } else { console.log('control skipped') }`,
//     so the day `==www.a.com==` stopped degrading — a stated goal of the
//     read-only campaign — the control would have evaporated in silence and this
//     file would have gone on printing PASS while proving nothing about
//     degraded blocks. It now searches a CORPUS of shapes, requires at least one
//     of them to actually degrade, and scans that block's ENTIRE raw span rather
//     than four spot offsets. If the whole corpus stops degrading the suite
//     FAILS and asks for a new fixture; it never shrugs.
{
  const CANDIDATES = [
    'see ==www.a.com== ok\n',
    '==www.a.com==\n',
    'see ==www.a.com== ok and ==www.b.com==\n'
  ]
  let degradedFixtures = 0
  for (const markdown of CANDIDATES) {
    const map = mapFor(markdown)
    const pairs = map.blockPairs.filter((p) => !p.virtual && p.pmNode?.isTextblock)
    const degradedPairs = pairs.filter((p) => !p.charMap)
    console.log(`  ${JSON.stringify(markdown)} -> ${pairs.length} textblock pair(s), ${degradedPairs.length} degraded`)
    if (!degradedPairs.length) continue
    degradedFixtures += 1
    for (const pair of degradedPairs) {
      const start = pair.mdBlock?.position?.start?.offset ?? 0
      const end = pair.mdBlock?.position?.end?.offset ?? markdown.length
      let named = 0
      // EVERY byte of the block, not a sample: a weakened guard need not
      // misbehave at the four offsets a sample happens to pick.
      for (let raw = start; raw <= end; raw += 1) {
        const got = resolveCommittedRawOffset(map, raw)
        if (!got) continue
        named += 1
        fail(`degraded pair raw ${raw} of ${JSON.stringify(markdown)} resolved to pm ${got.pos}; a block with no charMap must stay unnameable`)
      }
      console.log(`    raw ${start}..${end}: ${named} named (must be 0)`)
    }
  }
  assert.ok(degradedFixtures > 0,
    'NO fixture in this corpus degrades any more, so the degraded-pair control just ' +
    'proved nothing. This is not a licence to skip it: find a shape whose charMap ' +
    'proof still fails and put it in CANDIDATES, or the half of `requireMap` that ' +
    'stops the kernel naming a byte inside an uneditable block is untested.')
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

// ---------------------------------------------------------------------------
// Case 4 — THE MUTUALLY-REDUNDANT GUARDS, and why they need a structural pin.
//
// MEASURED (2026-08-26, correction M5): each of `pmPosForRawInsertPoint`'s four
// refusals was mutated ON ITS OWN and every raw offset of a 46-document corpus
// re-resolved — 550 offsets. Result:
//
//   mutation                                                     differences
//   -----------------------------------------------------------  -----------
//   degraded pair gets a naive identity charMap                      0 / 550
//   uniqueness dropped (`candidates.length !== 1` -> `!length`)      0 / 550
//   writer confirmation deleted (`pmPosToRawInsert(pos) !== raw`)    0 / 550
//   virtual-pair skip deleted                                        0 / 550
//   nearest-neighbour SNAP added                                    73 / 550   (Case 2 catches it)
//   degraded fallback AND confirmation deleted TOGETHER             82 / 550   (Case 2b catches it)
//
// So four of the five are invisible to any fixture, because they defend each
// other, and each is redundant for a reason that is true TODAY and need not
// stay true:
//   * the degraded skip is covered by the writer confirmation, because
//     `pmPosToRawInsert` itself refuses a pair with no charMap;
//   * the confirmation is covered by the candidate table, because
//     `candidateRawInsert` currently mirrors `pmPosToRawInsert` branch for
//     branch — the day that resolver grows a case this file does not mirror,
//     the confirmation is the ONLY thing standing between the kernel and a
//     wrong answer;
//   * uniqueness is covered by the candidate table never offering two answers
//     for one byte (measured below over every offset of the corpus);
//   * the virtual skip is covered by the `mdBlock.position` span filter,
//     because a virtual pair carries `mdBlock: null`.
// None may be deleted on the grounds that "the tests still pass" — that is the
// alibi, not the proof. This case makes the deletion loud, and the invariant
// scan below makes it loud when a redundancy stops holding.
// ---------------------------------------------------------------------------
console.log('Case 4 — mutually-redundant guards are pinned structurally')
{
  const source = readFileSync(new URL(
    '../src/renderer/src/lib/source-kernel/commands/insert-point.js', import.meta.url), 'utf8')
  const from = source.indexOf('export function pmPosForRawInsertPoint')
  const to = source.indexOf('export function resolveCommittedRawOffset')
  assert.ok(from > 0 && to > from, 'pmPosForRawInsertPoint is no longer where this pin looks for it')
  const body = source.slice(from, to)
  for (const [label, needle] of [
    ['the virtual-pair skip', 'pair.virtual'],
    ['the degraded-pair skip', '!pair.deferred && !pair.charMap'],
    ['the charMap requirement', '!charMap || !Number.isInteger(charMap.visibleLength)'],
    ['the uniqueness requirement', 'candidates.length !== 1'],
    ['the writer confirmation', 'map.pmPosToRawInsert(pos) !== raw']
  ]) {
    if (!body.includes(needle)) {
      fail(`${label} is gone from pmPosForRawInsertPoint — no fixture can see that on its own (see the table above); re-derive the redundancy before removing it`)
    } else {
      console.log(`  ${label}: present`)
    }
  }

  // THE PRECONDITION that makes the uniqueness requirement redundant: no raw
  // byte is offered by TWO (pair, visible-offset) candidates. Re-derived here
  // from the map's own public pair data — the same enumeration the module runs
  // — because that is the quantity the guard is about; block SPANS legitimately
  // nest (a list item's pair encloses its paragraph's), so an overlap test
  // would answer a different question. If a byte ever gets two candidates, the
  // uniqueness requirement has become load-bearing and the table above is
  // stale: re-measure it and add the fixture that now exists.
  const SPAN_CORPUS = [...INVERTIBLE, 'one\n\ntwo\n', '# h\n\npara\n\n- one\n- two\n',
    '| a | b |\n| --- | --- |\n| c | d |\n', '> q\n\n- a\n\n1. b\n', 'a\n\n```\n```\n\nb\n']
  const candidateAt = (charMap, vis) => {
    if (typeof charMap.rawNeutralInsert === 'function') return charMap.rawNeutralInsert(vis)
    if (typeof charMap.visibleToRaw === 'function') return charMap.visibleToRaw(vis)
    return null
  }
  let ambiguous = 0
  let scanned = 0
  for (const markdown of SPAN_CORPUS) {
    const map = mapFor(markdown)
    const counts = new Map()
    for (const pair of map.blockPairs) {
      if (!pair || pair.virtual) continue
      if (!Number.isInteger(pair.mdBlock?.position?.start?.offset)) continue
      const { charMap } = pair
      if (!charMap || !Number.isInteger(charMap.visibleLength)) continue
      for (let vis = 0; vis <= charMap.visibleLength; vis += 1) {
        const raw = candidateAt(charMap, vis)
        if (!Number.isFinite(raw)) continue
        counts.set(raw, (counts.get(raw) || 0) + 1)
      }
    }
    scanned += counts.size
    for (const [raw, count] of counts) {
      if (count < 2) continue
      ambiguous += 1
      fail(`${JSON.stringify(markdown)} raw ${raw} has ${count} insert-point candidates — the uniqueness requirement is now load-bearing, re-measure Case 4's table`)
    }
  }
  console.log(`  candidate multiplicity over ${SPAN_CORPUS.length} documents: ${scanned} bytes offered, ${ambiguous} ambiguous`)
}

if (failures) {
  console.log(`\nFAIL: ${failures} assertion(s)`)
  process.exit(1)
}
console.log('\nPASS kernel insert-point inverse')
