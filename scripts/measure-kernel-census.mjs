// KERNEL EDITABILITY CENSUS — how much of a real document can a user edit?
//
// The source-authoritative kernel refuses anything it cannot prove. Every
// individual refusal is defensible; the AGGREGATE — what fraction of a REAL
// document a user cannot edit — is what this measures, using the same three
// pieces the running app uses:
//
//   * `parseEditorMarkdown` (scripts/lib/kernel-parse-harness.mjs) — the real
//     editor parse chain (Milkdown schema + the app's own remark plugins +
//     `prepareEditorMarkdown`), whose fidelity is itself cross-checked inside
//     the running app by `test-mode-switch-combination-ui.mjs`.
//   * `buildProjectionMap` — the actual map builder. `null` here means the tab
//     DEGRADES to legacy in the app (editor-kernel-mode.js), which is the one
//     path that can still produce the sticky 「保存已暂停」 dialog.
//   * `pairIsReadOnlyToUser` — the same predicate the status bar counts with.
//
// IMPORTANT asymmetry, faithfully reproduced: the editor parses
// `prepareEditorMarkdown(source)` while the kernel is handed the RAW bytes
// (Editor.jsx: `parse` adapter vs `initialContent`). Passing prepared bytes to
// `buildProjectionMap` here would hide exactly the dual-chain divergence this
// probe is looking for.
//
// ===========================================================================
// TWO MODES, AND WHY (2026-08-26)
// ===========================================================================
// This script produced the branch's headline number ("0/197 documents
// degrade") while defaulting to a scan of `~/Downloads` and exiting 0 no
// matter what it found. Wired into `npm run test:kernel-census`, that is a test
// that cannot fail, measured on a corpus that exists on one machine. Both
// halves are now explicit:
//
//   EXPLORATORY (default)  scans docs/, guide/, README/AGENTS/CLAUDE and
//                          ~/Downloads, or any paths you pass. Reports, never
//                          asserts, and says so in its output. This is the
//                          mode that FOUND the two causes; keep it.
//   ASSERTING (--assert)   measures the committed in-repo corpus
//                          (scripts/fixtures/kernel-census/, see
//                          scripts/lib/kernel-census-corpus.mjs for what each
//                          fixture is for) and EXITS NON-ZERO when a threshold
//                          is breached. Reproducible by anyone with the repo.
//
// Usage:
//   node scripts/measure-kernel-census.mjs [--json] [paths...]
//   node scripts/measure-kernel-census.mjs --assert [paths...]
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { parseEditorMarkdown } from './lib/kernel-parse-harness.mjs'
import { buildProjectionMap } from '../src/renderer/src/components/editor-kernel-projection-map.js'
import { pairIsReadOnlyToUser } from '../src/renderer/src/lib/kernel-status.js'
import { isTypableTextblock } from '../src/renderer/src/components/editor-kernel-gateway.js'
import {
  REPO,
  corpusTargets,
  walkMarkdown,
  MAX_DEGRADED,
  MAX_PARSE_ERRORS,
  MAX_READONLY_TEXTBLOCK_RATIO,
  REQUIRE_CRLF_DOCUMENT
} from './lib/kernel-census-corpus.mjs'

const HOME = homedir()

// The shape a read-only pair actually has, for grouping. Deliberately coarse:
// the question is "which KIND of markdown is uneditable", not which byte —
// measure-kernel-readonly-causes.mjs answers that one, per block, by asking the
// shipped modules.
function shapeOf(pair) {
  const node = pair.pmNode
  const type = node?.type?.name || 'unknown'
  if (type === 'code_block') return `code_block(${node.attrs?.language || 'plain'})`
  if (type === 'paragraph' || type === 'heading') {
    const text = (() => {
      try {
        return node.textContent || ''
      } catch {
        return ''
      }
    })()
    if (pair.tableCell) return 'table cell'
    if (/\{[~=+->]/.test(text)) return `${type}:criticmarkup`
    if (/^\s*\$\$/.test(text)) return `${type}:display-math`
    if (/<[a-zA-Z]/.test(text)) return `${type}:inline-html`
    return `${type}:unproven`
  }
  return type
}

async function censusOne(path) {
  const raw = await readFile(path, 'utf8')
  const bytes = Buffer.byteLength(raw)
  const crlf = /\r\n/.test(raw)
  const row = { path, bytes, crlf, ok: false, degraded: false, error: null, blocks: 0, readOnly: 0, textblocks: 0, readOnlyTextblocks: 0, shapes: {} }

  let pmDoc
  try {
    pmDoc = parseEditorMarkdown(raw)
  } catch (err) {
    row.error = `parse: ${err.message}`
    return row
  }

  let map
  try {
    map = buildProjectionMap(raw, pmDoc)
  } catch (err) {
    row.error = `map: ${err.message}`
    row.degraded = true
    return row
  }
  if (!map) {
    row.degraded = true // -> editor-kernel-mode.js degraded = true -> legacy
    return row
  }

  const pairs = map.blockPairs || []
  row.blocks = pairs.length
  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i]
    const isTb = !!pair?.pmNode?.isTextblock && !pair.virtual
    if (isTb) row.textblocks += 1
    if (pairIsReadOnlyToUser(pair, pairs[i + 1], isTypableTextblock)) {
      row.readOnly += 1
      if (isTb) row.readOnlyTextblocks += 1
      const shape = shapeOf(pair)
      row.shapes[shape] = (row.shapes[shape] || 0) + 1
    }
  }
  row.ok = true
  return row
}

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const asserting = args.includes('--assert')
const explicit = args.filter((a) => !a.startsWith('--')).map((p) => resolve(p))

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

let targets
if (explicit.length) {
  targets = await expand(explicit)
} else if (asserting) {
  targets = await corpusTargets()
} else {
  targets = [
    ...(await walkMarkdown(join(REPO, 'docs'))),
    ...(await walkMarkdown(join(REPO, 'guide'), 3)),
    join(REPO, 'README.md'),
    join(REPO, 'CLAUDE.md'),
    join(REPO, 'AGENTS.md'),
    ...(await walkMarkdown(join(HOME, 'Downloads'), 8))
  ]
}

const rows = []
for (const path of targets) {
  try {
    await stat(path)
  } catch {
    continue
  }
  rows.push(await censusOne(path))
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2))
  process.exit(0)
}

const usable = rows.filter((r) => r.ok)
const degraded = rows.filter((r) => r.degraded)
const errored = rows.filter((r) => r.error && !r.degraded)

const pct = (n, d) => (d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(1).padStart(5)}%`)

console.log(`\n=== KERNEL EDITABILITY CENSUS — ${rows.length} markdown documents ${asserting ? '(committed corpus)' : '(exploratory)'} ===\n`)
console.log(`  attached (map built) : ${usable.length}`)
console.log(`  DEGRADED to legacy   : ${degraded.length}   <- these lose byte authority entirely`)
console.log(`  parse errors         : ${errored.length}`)

const totalTb = usable.reduce((s, r) => s + r.textblocks, 0)
const totalRoTb = usable.reduce((s, r) => s + r.readOnlyTextblocks, 0)
const totalBlocks = usable.reduce((s, r) => s + r.blocks, 0)
const totalRo = usable.reduce((s, r) => s + r.readOnly, 0)
const roRatio = totalTb === 0 ? 0 : totalRoTb / totalTb
console.log(`\n  read-only TEXTBLOCKS : ${totalRoTb} / ${totalTb}  = ${pct(totalRoTb, totalTb)}   <- what a writer feels`)
console.log(`  read-only pairs (all): ${totalRo} / ${totalBlocks}  = ${pct(totalRo, totalBlocks)}`)
console.log(`  documents 100% clean : ${usable.filter((r) => r.readOnly === 0).length} / ${usable.length}`)

if (degraded.length) {
  console.log(`\n--- DEGRADED (no projection map -> legacy -> fail-closed save is reachable) ---`)
  for (const r of degraded.sort((a, b) => b.bytes - a.bytes)) {
    console.log(`  ${String(r.bytes).padStart(8)}B ${r.crlf ? 'CRLF' : ' LF '} ${r.error ? `[${r.error}] ` : ''}${r.path}`)
  }
}
if (errored.length) {
  console.log(`\n--- PARSE ERRORS ---`)
  for (const r of errored) console.log(`  [${r.error}] ${r.path}`)
}

const worst = usable.filter((r) => r.readOnly > 0).sort((a, b) => b.readOnlyTextblocks / (b.textblocks || 1) - a.readOnlyTextblocks / (a.textblocks || 1))
if (worst.length) {
  console.log(`\n--- WORST 20 BY READ-ONLY TEXTBLOCK RATIO ---`)
  for (const r of worst.slice(0, 20)) {
    console.log(`  ${pct(r.readOnlyTextblocks, r.textblocks)}  ${String(r.readOnlyTextblocks).padStart(4)}/${String(r.textblocks).padEnd(5)} ${r.path.replace(HOME, '~')}`)
  }
}

const shapeTotals = {}
for (const r of usable) for (const [k, v] of Object.entries(r.shapes)) shapeTotals[k] = (shapeTotals[k] || 0) + v
const ranked = Object.entries(shapeTotals).sort((a, b) => b[1] - a[1])
if (ranked.length) {
  console.log(`\n--- READ-ONLY SHAPES, RANKED ---`)
  for (const [shape, count] of ranked) console.log(`  ${String(count).padStart(5)}  ${shape}`)
}

if (!asserting) {
  console.log(`\n  (exploratory run — no assertions, and the default target set includes ~/Downloads,`)
  console.log(`   which exists on one machine. \`--assert\` measures the committed corpus and fails on breach.)\n`)
  process.exit(0)
}

// ---------------------------------------------------------------- assertions
const failures = []
if (!rows.length) failures.push('no documents measured — the corpus is missing')
if (degraded.length > MAX_DEGRADED) {
  failures.push(`${degraded.length} document(s) DEGRADED to legacy (allowed ${MAX_DEGRADED}) — a degraded tab loses byte authority entirely`)
}
if (errored.length > MAX_PARSE_ERRORS) {
  failures.push(`${errored.length} parse error(s) (allowed ${MAX_PARSE_ERRORS})`)
}
if (roRatio > MAX_READONLY_TEXTBLOCK_RATIO) {
  failures.push(`read-only textblock ratio ${roRatio.toFixed(3)} exceeds the committed bound ${MAX_READONLY_TEXTBLOCK_RATIO}`)
}
if (REQUIRE_CRLF_DOCUMENT && !explicit.length && !rows.some((r) => r.crlf)) {
  failures.push('no CRLF document in the corpus — a line-ending normalisation has silently deleted an axis of this measurement')
}

console.log(`\n=== ASSERTIONS (committed corpus) ===`)
console.log(`  degraded                 : ${degraded.length} <= ${MAX_DEGRADED}`)
console.log(`  parse errors             : ${errored.length} <= ${MAX_PARSE_ERRORS}`)
console.log(`  read-only textblock ratio: ${roRatio.toFixed(3)} <= ${MAX_READONLY_TEXTBLOCK_RATIO}`)
console.log(`  CRLF document present    : ${rows.some((r) => r.crlf)}`)
if (failures.length) {
  console.log(`\n  FAIL`)
  for (const f of failures) console.log(`    - ${f}`)
  console.log()
  process.exit(1)
}
console.log(`\n  PASS\n`)
