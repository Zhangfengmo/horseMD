// Attributes every read-only block found by measure-kernel-census.mjs to a
// ROOT CAUSE, so the fix list can be ordered by how much of the read-only
// surface each one actually buys back.
//
// The two candidate causes were found by bisecting real documents down to a
// minimal repro:
//
//  A. SOFT-BREAK CONTINUATION PREFIX, next inline sibling is not text.
//     `character-map.js` `textUnits` folds a soft break's continuation prefix
//     into the break's own unit with `consumeSoftBreak` — greedily — and then
//     guards `next > end`, where `end` is the TEXT NODE'S OWN end offset. When
//     the wrapped line's continuation is indented AND the next line begins with
//     a non-text inline node (inlineCode / strong / em / link / image / math /
//     html), remark ends the text node AT the line terminator and the prefix
//     bytes lie in the gap between that text node and its next sibling. The
//     greedy consume overshoots `end`, `textUnits` returns null, and the WHOLE
//     BLOCK becomes read-only.
//       'a b\n  `c` d'  -> null      'a b\n`c` d'  -> ok (no prefix)
//       'a b\n  c d'    -> ok        'a  \n  `c` d'-> ok (HARD break; proven fold)
//     The hard-break twin of exactly this bug was fixed 2026-08-18 (`6560df5`,
//     `hardBreakUnitEnd` proves the fold against the next sibling's start
//     offset instead of consuming greedily). The soft-break side never got it.
//
//  B. ANY ESCAPE IN A TABLE CELL. `table-map.js:236` —
//     `if (charMap.units.some((unit) => unit.kind === 'escape')) return null`.
//     The comment justifies it for `\|` (a GFM cell escape that is NOT the
//     ordinary CommonMark escape the unit model encodes), but the guard is
//     written over ALL escapes, so a cell holding remark's own routine output
//     — `claude\-haiku\-4\.5`, `4\.5`, `\*` — is refused too. Documents saved
//     by a remark-based tool (including HorseMD's own legacy path) are full of
//     these.
//
// Usage: node scripts/measure-kernel-readonly-causes.mjs [paths...]
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

import { parseEditorMarkdown } from './lib/kernel-parse-harness.mjs'
import { buildProjectionMap } from '../src/renderer/src/components/editor-kernel-projection-map.js'
import { pairIsReadOnlyToUser } from '../src/renderer/src/lib/kernel-status.js'
import { isTypableTextblock } from '../src/renderer/src/components/editor-kernel-gateway.js'
import { buildCharacterMap } from '../src/renderer/src/lib/source-kernel/character-map.js'

const REPO = resolve(import.meta.dirname, '..')
const HOME = homedir()
const IGNORED = new Set(['node_modules', '.git', 'dist', 'out', '.cache', 'coverage'])

async function walk(dir, depth = 6, acc = []) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (depth <= 0 || IGNORED.has(e.name) || e.name.startsWith('.')) continue
      await walk(full, depth - 1, acc)
    } else if (/\.(md|markdown)$/i.test(e.name)) acc.push(full)
  }
  return acc
}

const isPrefixChar = (ch) => ch === ' ' || ch === '\t' || ch === '>'

// Cause A detector: mirrors textUnits' own arithmetic without modifying it.
// Returns the count of soft breaks in this block whose greedy prefix consume
// would overshoot the text node's own end offset.
function countCauseA(text, node, acc = { hits: 0 }) {
  if (node.type === 'text') {
    const value = String(node.value ?? '')
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (Number.isInteger(start) && Number.isInteger(end)) {
      // Walk the raw span looking for line endings and measure the prefix run.
      for (let r = start; r < end; r += 1) {
        const ch = text[r]
        if (ch !== '\n' && ch !== '\r') continue
        let i = r + (ch === '\r' && text[r + 1] === '\n' ? 2 : 1)
        while (i < text.length && isPrefixChar(text[i])) i += 1
        if (i > end) acc.hits += 1 // consumeSoftBreak would overshoot -> null
      }
    }
    void value
  }
  if (node.children) for (const child of node.children) countCauseA(text, child, acc)
  return acc.hits
}

function hasEscapeUnits(text, node) {
  const map = buildCharacterMap(text, node)
  if (!map) return false
  return map.units.some((u) => u.kind === 'escape')
}

function classify(text, pair) {
  const md = pair.mdBlock
  const node = pair.pmNode
  if (!md) return 'no-mdast-block (structural leaf)'
  if (!node?.isTextblock) return `non-textblock:${node?.type?.name || '?'}`
  if (md.type === 'tableCell') {
    return hasEscapeUnits(text, md)
      ? 'B: table cell contains an escape (table-map.js:236)'
      : 'B?: table cell, no escape units — other cause'
  }
  if (countCauseA(text, md) > 0) return 'A: soft-break continuation prefix + non-text next sibling'
  const t = (() => { try { return node.textContent || '' } catch { return '' } })()
  if (/\{[~=+->]/.test(t)) return 'C: CriticMarkup (dual-chain divergence)'
  if (/<[a-zA-Z]/.test(t)) return 'C: inline HTML / <mark> highlight'
  if (/^\s*\$\$/.test(t)) return 'C: standalone display math'
  return 'Z: UNEXPLAINED — needs investigation'
}

const explicit = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const targets = explicit.length
  ? explicit.map((p) => resolve(p))
  : [
      ...(await walk(join(REPO, 'docs'))),
      ...(await walk(join(REPO, 'guide'), 3)),
      join(REPO, 'README.md'), join(REPO, 'CLAUDE.md'), join(REPO, 'AGENTS.md'),
      ...(await walk(join(HOME, 'Downloads'), 8))
    ]

const causes = {}
const perDoc = []
let docs = 0
let readOnlyTotal = 0
let textblockTotal = 0

for (const path of targets) {
  try { await stat(path) } catch { continue }
  let raw, map
  try {
    raw = await readFile(path, 'utf8')
    map = buildProjectionMap(raw, parseEditorMarkdown(raw))
  } catch { continue }
  if (!map) continue
  docs += 1
  const pairs = map.blockPairs || []
  const local = {}
  let ro = 0
  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i]
    if (pair?.pmNode?.isTextblock && !pair.virtual) textblockTotal += 1
    if (!pairIsReadOnlyToUser(pair, pairs[i + 1], isTypableTextblock)) continue
    ro += 1
    readOnlyTotal += 1
    const cause = classify(raw, pair)
    causes[cause] = (causes[cause] || 0) + 1
    local[cause] = (local[cause] || 0) + 1
  }
  if (ro > 0) perDoc.push({ path, ro, local })
}

console.log(`\n=== READ-ONLY ROOT-CAUSE ATTRIBUTION — ${docs} documents, ${readOnlyTotal} read-only blocks ===\n`)
const ranked = Object.entries(causes).sort((a, b) => b[1] - a[1])
for (const [cause, n] of ranked) {
  const share = ((n / readOnlyTotal) * 100).toFixed(1).padStart(5)
  console.log(`  ${String(n).padStart(5)}  ${share}%  ${cause}`)
}
const fixable = (causes['A: soft-break continuation prefix + non-text next sibling'] || 0) +
  (causes['B: table cell contains an escape (table-map.js:236)'] || 0)
console.log(`\n  A+B together: ${fixable}/${readOnlyTotal} = ${((fixable / readOnlyTotal) * 100).toFixed(1)}% of the entire read-only surface`)
console.log(`  read-only textblocks as a share of all textblocks: ${readOnlyTotal}/${textblockTotal}`)

console.log(`\n--- TOP 12 AFFECTED DOCUMENTS ---`)
for (const d of perDoc.sort((a, b) => b.ro - a.ro).slice(0, 12)) {
  console.log(`  ${String(d.ro).padStart(4)}  ${d.path.replace(HOME, '~')}`)
  for (const [c, n] of Object.entries(d.local).sort((a, b) => b[1] - a[1])) {
    console.log(`         ${String(n).padStart(4)}  ${c}`)
  }
}
console.log()
