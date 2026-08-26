// DYNAMIC census: does typing one character turn an EDITABLE block READ-ONLY?
//
// `measure-kernel-census.mjs` photographs a document at rest. The user's
// symptoms are about EDITING — "I type something and then it won't save". The
// mechanism that produces that experience is a block that is editable now and
// unprovable one keystroke later: the character the user typed introduces an
// inline node (a backtick opening an inlineCode, a `<` opening inline HTML, a
// `|` inside a cell) whose new shape the projection map cannot prove, so the
// block flips to `charMap: null` and every subsequent keystroke in it is
// vetoed and silently swallowed.
//
// This probe measures that flip directly. For a sample of blocks it splices one
// character into the raw source, re-runs the REAL parse + map, and reports every
// (character, position) pair that costs the block its editability.
//
// It deliberately types the character into the RAW BYTES rather than driving the
// editor: the question is whether the resulting DOCUMENT is provable, which is
// what decides the block's fate regardless of which gesture produced it.
//
// TWO MODES (2026-08-26), for the same reason as its two sibling instruments:
// the default scan is `~/Downloads`, which exists on one machine, and the run
// used to exit 0 whatever it found.
//   EXPLORATORY (default)  docs/ + ~/Downloads, or any paths/directories you
//                          pass. Reports, never asserts.
//   ASSERTING (--assert)   the committed corpus
//                          (scripts/fixtures/kernel-census/), every block, and
//                          EXIT 1 on any lock-up at all. Zero is the right
//                          bound here and not an aspiration: a lock-up IS the
//                          user-reported symptom ("I type something and then it
//                          won't take any more keystrokes"), so one is a bug.
//
// Usage:
//   node scripts/measure-kernel-typing-lockup.mjs [--docs N] [--blocks N] [paths...]
//   node scripts/measure-kernel-typing-lockup.mjs --assert
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

import { parseEditorMarkdown } from './lib/kernel-parse-harness.mjs'
import { buildProjectionMap } from '../src/renderer/src/components/editor-kernel-projection-map.js'
import { pairIsReadOnlyToUser } from '../src/renderer/src/lib/kernel-status.js'
import { isTypableTextblock } from '../src/renderer/src/components/editor-kernel-gateway.js'
import { REPO, corpusTargets, walkMarkdown } from './lib/kernel-census-corpus.mjs'

const HOME = homedir()

// The characters a writer actually types that carry Markdown meaning, plus the
// two whitespace keys the user named. Each is typed as a LONE character — the
// intermediate state every multi-character construct passes through.
const PROBE_CHARS = [
  { key: '`', name: 'backtick' },
  { key: '*', name: 'asterisk' },
  { key: '_', name: 'underscore' },
  { key: '~', name: 'tilde' },
  { key: '=', name: 'equals' },
  { key: '<', name: 'lt' },
  { key: '|', name: 'pipe' },
  { key: '$', name: 'dollar' },
  { key: '[', name: 'bracket' },
  { key: '!', name: 'bang' },
  { key: '#', name: 'hash' },
  { key: '-', name: 'dash' },
  { key: '>', name: 'gt' },
  { key: '\\', name: 'backslash' },
  { key: ' ', name: 'space' },
  { key: '\t', name: 'tab' }
]

// An explicit path may be a directory — pointing the instrument at a tree is
// how exploration is done, so expand it rather than silently measuring nothing.
async function expand(paths) {
  const out = []
  for (const path of paths) {
    let info
    try { info = await stat(path) } catch { continue }
    if (info.isDirectory()) out.push(...(await walkMarkdown(path)))
    else out.push(path)
  }
  return out
}

// Is the block covering `mdStart` editable in this document?
function blockEditableAt(raw, mdStart) {
  let pmDoc
  try { pmDoc = parseEditorMarkdown(raw) } catch { return { ok: false, reason: 'parse-threw' } }
  const map = buildProjectionMap(raw, pmDoc)
  if (!map) return { ok: false, reason: 'degraded' }
  const pairs = map.blockPairs || []
  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i]
    const s = pair.mdBlock?.position?.start?.offset
    const e = pair.mdBlock?.position?.end?.offset
    if (!Number.isInteger(s) || !Number.isInteger(e)) continue
    if (mdStart < s || mdStart >= e) continue
    if (!pair.pmNode?.isTextblock) continue
    return { ok: !pairIsReadOnlyToUser(pair, pairs[i + 1], isTypableTextblock), reason: 'measured' }
  }
  return { ok: false, reason: 'block-not-found' }
}

const args = process.argv.slice(2)
const num = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? Number(args[i + 1]) : dflt }
const asserting = args.includes('--assert')
const maxDocs = num('--docs', 10)
// In asserting mode EVERY editable paragraph/heading of the corpus is probed:
// the corpus is small, and a sampled assertion would pass or fail depending on
// where the sampling stride happened to land.
const maxBlocks = num('--blocks', asserting ? Number.MAX_SAFE_INTEGER : 10)
const explicit = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--docs' && args[i - 1] !== '--blocks')

let targets
if (explicit.length) {
  targets = await expand(explicit.map((p) => resolve(p)))
} else if (asserting) {
  targets = await corpusTargets()
} else {
  targets = [...(await walkMarkdown(join(REPO, 'docs'))), ...(await walkMarkdown(join(HOME, 'Downloads'), 8))]
  // Prefer mid-sized documents: big enough to be real, small enough that N*M
  // full reparses finish in minutes.
  const sized = []
  for (const p of targets) {
    try { const s = await stat(p); if (s.size > 1500 && s.size < 40000) sized.push({ p, size: s.size }) } catch { /* skip */ }
  }
  targets = sized.sort((a, b) => b.size - a.size).slice(0, maxDocs).map((x) => x.p)
}

const lockups = {}
let trials = 0
let flips = 0
const examples = []

for (const path of targets) {
  const raw = await readFile(path, 'utf8')
  let map
  try { map = buildProjectionMap(raw, parseEditorMarkdown(raw)) } catch { continue }
  if (!map) continue

  // Sample editable paragraph/heading blocks, spread through the document.
  const pairs = (map.blockPairs || []).filter((p, i, all) =>
    p.pmNode?.isTextblock && p.mdBlock && !p.virtual &&
    (p.mdBlock.type === 'paragraph' || p.mdBlock.type === 'heading') &&
    !pairIsReadOnlyToUser(p, all[i + 1], isTypableTextblock))
  const step = Math.max(1, Math.floor(pairs.length / maxBlocks))
  const sample = pairs.filter((_, i) => i % step === 0).slice(0, maxBlocks)

  for (const pair of sample) {
    const s = pair.mdBlock.position.start.offset
    const e = pair.mdBlock.position.end.offset
    // Type at the block's END — where a writer continues a sentence.
    for (const probe of PROBE_CHARS) {
      const edited = raw.slice(0, e) + probe.key + raw.slice(e)
      const after = blockEditableAt(edited, s)
      trials += 1
      if (after.ok) continue
      flips += 1
      const label = `${probe.name} '${probe.key === '\t' ? '\\t' : probe.key}' at block END -> ${after.reason === 'measured' ? 'block read-only' : after.reason}`
      lockups[label] = (lockups[label] || 0) + 1
      if (examples.length < 14) {
        examples.push({ label, path: path.replace(HOME, '~'), text: raw.slice(s, Math.min(e, s + 90)) })
      }
    }
  }
  process.stderr.write(`  scanned ${path.replace(HOME, '~')}\n`)
}

console.log(`\n=== TYPING LOCK-UP CENSUS — ${trials} trials across ${targets.length} documents ${asserting ? '(committed corpus)' : '(exploratory)'} ===\n`)
console.log(`  keystrokes that turn an EDITABLE block READ-ONLY: ${flips} / ${trials} = ${trials ? ((flips / trials) * 100).toFixed(1) : '0.0'}%\n`)
if (!flips) {
  console.log('  No lock-ups found. Typing a lone Markdown character never costs a block its editability.')
} else {
  console.log('--- RANKED ---')
  for (const [label, n] of Object.entries(lockups).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${label}`)
  }
  console.log('\n--- EXAMPLES ---')
  for (const ex of examples) {
    console.log(`\n  ${ex.label}\n    ${ex.path}\n    ${JSON.stringify(ex.text)}`)
  }
}

if (!asserting) {
  console.log(`\n  (exploratory run — no assertions, and the default target set includes ~/Downloads,`)
  console.log(`   which exists on one machine. \`--assert\` measures the committed corpus and fails on breach.)\n`)
  process.exit(0)
}

// ---------------------------------------------------------------- assertions
const failures = []
if (!trials) failures.push('no trials run — the corpus is missing or holds no editable block')
if (flips) failures.push(`${flips} keystroke(s) turn an editable block read-only (allowed 0)`)

console.log(`\n=== ASSERTIONS (committed corpus) ===`)
console.log(`  lock-ups: ${flips} / ${trials} trials, allowed 0`)
if (failures.length) {
  console.log(`\n  FAIL`)
  for (const f of failures) console.log(`    - ${f}`)
  console.log()
  process.exit(1)
}
console.log(`\n  PASS\n`)
