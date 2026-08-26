// WHY IS THIS BLOCK READ-ONLY? — attribution for every block
// `measure-kernel-census.mjs` counts, so the remaining refusal surface can be
// ordered by what each fix would actually buy back.
//
// ===========================================================================
// WHAT THIS SCRIPT MEASURES NOW (rewritten 2026-08-26)
// ===========================================================================
// The two causes this file was written to find are FIXED, and the file used to
// describe them in the present tense as if they were not:
//
//   A. SOFT-BREAK CONTINUATION PREFIX, next inline sibling is not text
//      ('a b\n  `c` d'). `character-map.js`'s greedy `consumeSoftBreak` folded
//      the continuation prefix into the break's unit and overshot the text
//      node's own end offset, so the WHOLE block returned null. Fixed by
//      `continuationFoldEnd`, which PROVES the fold against the next sibling's
//      start offset — the same proof the hard break got on 2026-08-18.
//      Measured share when it was open: 187 blocks, 36.1% of all read-only
//      blocks across 197 documents.
//   B. ANY ESCAPE IN A TABLE CELL. `table-map.js` refused a cell holding ANY
//      `escape` unit, on a justification that is only true of `\|` (a GFM cell
//      escape layered on top of the CommonMark one). remark writes
//      `claude\-haiku\-4\.5` inside cells as a matter of routine. Narrowed to
//      `\|` alone. Measured share when it was open: 330 blocks, 63.7%.
//
// This script's job is therefore no longer to find A and B; it is to keep them
// found, and to attribute whatever is left. Run with `--assert` it FAILS if
// either cause reappears, or if any read-only block cannot be attributed at
// all.
//
// ===========================================================================
// HOW A CAUSE IS DERIVED — the real modules answer, this file does not guess
// ===========================================================================
// The previous version re-implemented both guards inline: a 20-line copy of
// `textUnits`' offset arithmetic for cause A, and a `units.some(kind ===
// 'escape')` test for cause B. Both were copies of the PRE-fix rules, so after
// the fixes the instrument mis-attributed. Reproduced on the branch:
//
//   printf '| h |\n| --- |\n| x\\-y<br>z |\n'
//     old -> '100.0%  B: table cell contains an escape (table-map.js:236)'
//     real cause -> `hasCellBreak` (`<br>`); the `\-` is explicitly ALLOWED
//
// A copy of a guard can only ever be as current as the day it was copied, so
// there are no copies here. Attribution has two halves, and both call the
// shipped code:
//
//   1. WHERE the refusal happened, by asking the real mappers about this exact
//      block: `buildCharacterMap` / `buildCodeMap` (are the bytes mappable at
//      all?), then the projection map's own published numbers (`pair.charMap`,
//      `pmNode.content.size` vs `charMap.visibleLength`), then the gateway's
//      own `isTypableTextblock`.
//   2. WHAT byte feature is responsible, by ABLATION: remove one named feature
//      from the block's raw span, re-run the REAL chain end to end
//      (`parseEditorMarkdown` -> `buildProjectionMap` -> `pairIsReadOnlyToUser`
//      — the same three pieces the census uses), and see whether the block at
//      the same start offset became editable. Every ablation edits bytes at or
//      after the block's start only, so the start offset it is looked up by
//      cannot move; two further rules (`applies` + a structural identity check
//      after the re-parse) keep an ablation from proving something about a
//      DIFFERENT block — see the ablation table below for the false
//      attributions that made both necessary. Each candidate is tested
//      INDEPENDENTLY, and all the ones that individually restore editability
//      are reported (normally exactly one), so a block holding both a `\-` and
//      a `<br>` attributes to the `<br>` on evidence rather than on ladder
//      order.
//
// A refusal that no candidate explains is reported as UNATTRIBUTED — a visible
// gap in the instrument, never a silent bucket.
//
// Usage:
//   node scripts/measure-kernel-readonly-causes.mjs [paths...]   (exploratory)
//   node scripts/measure-kernel-readonly-causes.mjs --assert     (in-repo corpus)
//   node scripts/measure-kernel-readonly-causes.mjs --no-ablate  (fast, site only)
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

import { parseEditorMarkdown } from './lib/kernel-parse-harness.mjs'
import { buildProjectionMap } from '../src/renderer/src/components/editor-kernel-projection-map.js'
import { pairIsReadOnlyToUser } from '../src/renderer/src/lib/kernel-status.js'
import { isTypableTextblock } from '../src/renderer/src/components/editor-kernel-gateway.js'
import { buildCharacterMap } from '../src/renderer/src/lib/source-kernel/character-map.js'
import { buildCodeMap } from '../src/renderer/src/lib/source-kernel/code-map.js'
import { REPO, corpusTargets, walkMarkdown } from './lib/kernel-census-corpus.mjs'

const HOME = homedir()

// The two fixed causes. Their reappearance is the specific event this
// instrument exists to catch, so `--assert` requires exactly zero of each.
const REGRESSION_CODES = new Set(['softbreak-continuation-prefix', 'table-cell-ordinary-escape'])

// ===========================================================================
// 1. WHERE — the refusal site, read off the shipped modules
// ===========================================================================

// mdast block types the projection map pairs read-only BY CONSTRUCTION: their
// two chains do not agree on line structure at all, so no offset may ever be
// served in either direction. Not a defect and not ablatable.
const BY_CONSTRUCTION = {
  html: 'block HTML (paired read-only by construction)',
  yaml: 'front matter (read-only leaf)',
  toml: 'front matter (read-only leaf)',
  thematicBreak: 'thematic break (no text)'
}

const tryMap = (markdown, pair) => {
  const md = pair.mdBlock
  try {
    if (md?.type === 'code') return { name: 'buildCodeMap', map: buildCodeMap(markdown, md) }
    return { name: 'buildCharacterMap', map: buildCharacterMap(markdown, md) }
  } catch (err) {
    return { name: 'mapper', map: null, threw: err.message }
  }
}

// The PM node's inline children that are neither text nor an atom the gateway
// admits — reported by NAME, so a gateway refusal says which shape it was.
const nonTextInlineChildren = (node) => {
  const seen = []
  try {
    node.forEach((child) => {
      if (child?.isText) return
      const name = child?.type?.name || '?'
      if (!seen.includes(name)) seen.push(name)
    })
  } catch { /* a node that will not walk is reported as unknown below */ }
  return seen
}

function refusalSite(markdown, pair) {
  const md = pair.mdBlock
  const node = pair.pmNode
  if (!node) return { site: 'no-pm-node', detail: 'pair carries no ProseMirror node', ablatable: false }
  if (!md) return { site: 'synthetic', detail: `PM-only ${node.type?.name || '?'} with no source block`, ablatable: false }
  if (!node.isTextblock) return { site: 'container', detail: `non-textblock ${node.type?.name || '?'}`, ablatable: false }

  if (pair.charMap) {
    // The bytes mapped; the GATEWAY refused the inline shape.
    if (!isTypableTextblock(node)) {
      const kids = nonTextInlineChildren(node)
      return {
        site: 'gateway',
        detail: `inline shape refused by isTypableTextblock (children: ${kids.join(', ') || 'none'})`,
        ablatable: true
      }
    }
    return { site: 'editable?', detail: 'charMap present and typable — read-only for a reason this script does not model', ablatable: true }
  }

  const byConstruction = BY_CONSTRUCTION[md.type]
  if (byConstruction) return { site: 'by-construction', detail: byConstruction, ablatable: false }

  const { name, map, threw } = tryMap(markdown, pair)
  if (threw) return { site: 'mapper-threw', detail: `${name} threw: ${threw}`, ablatable: true }
  if (!map) {
    return { site: 'character-map', detail: `${name} refused this block's bytes`, ablatable: true }
  }
  const size = node.content?.size
  if (Number.isInteger(size) && size !== map.visibleLength) {
    // The two numbers are deliberately NOT in the label: they differ per block
    // and would split one cause into as many buckets as there are blocks.
    return {
      site: 'size-divergence',
      detail: 'PM content.size != kernel visibleLength (the two parse chains disagree)',
      ablatable: true
    }
  }
  if (pair.tableCell) {
    return {
      site: 'table-map cell guard',
      detail: `${name} maps the cell's bytes; buildTableCellMaps refused it (\\| escape, <br>, padding or bracketing proof)`,
      ablatable: true
    }
  }
  return {
    site: 'projection-proof',
    detail: `${name} succeeded and sizes agree — refused by the projection map's own endpoint proof`,
    ablatable: true
  }
}

// ===========================================================================
// 2. WHAT — ablation against the real chain
// ===========================================================================

// Each ablation removes ONE named byte feature from a block's raw span. Two
// rules keep an ablation from proving the wrong thing, and both were added
// after the first run of this instrument produced false attributions against
// docs/ (a list-indented FENCE was reported as the soft-break continuation
// bug, because un-indenting a fence is a restructuring, not a feature removal):
//
//   * `applies` — a candidate is only offered to blocks whose shape it can be
//     ABOUT. A `code` block has no inline siblings, so the soft-break candidate
//     is never offered to it; a table-cell candidate is never offered to prose.
//     Without this, the two REGRESSION codes could be raised by shapes that
//     have nothing to do with either fixed cause.
//   * the structural check in `editableAt` — after ablation the block at the
//     same start offset must still be the SAME block: same mdast type, same PM
//     type, same start, and an end shifted by exactly the number of bytes the
//     ablation removed. An ablation that restructures the document is not
//     evidence about the original block, so it is discarded rather than
//     counted.
const ESCAPE_RE = /\\([^|])/g
// `<br>` is deliberately EXCLUDED: it has its own candidate above, and letting
// the generic tag ablation remove it too would attribute one refusal to two
// features and hide which one is real.
const HTML_TAG_RE = /<\/?(?!br\b)[A-Za-z][^>]*>/gi
const CRITIC_RE = /\{(\+\+|--|~~|==|>>)([\s\S]*?)(\+\+|--|~~|==|<<)\}/g
const BR_RE = /<br\s*\/?>/gi
const INLINE_MATH_RE = /\$[^$\n]+\$/g
const LINE_START_INDENT_RE = /(\r\n|\r|\n)[ \t]+/g

const isCell = (pair) => !!pair.tableCell
const isProse = (pair) => !pair.tableCell && pair.mdBlock?.type !== 'code'
const isFence = (pair) => pair.mdBlock?.type === 'code'
const hasInline = (pair) => pair.mdBlock?.type !== 'code'

// The raw spans of every `inlineCode` descendant, relative to the block's own
// start. A line ending INSIDE a code span is a different shape from a soft
// break between two inline siblings (CommonMark's code-span line handling is
// its own rule), so the two get their own candidates instead of one blurred
// one. This reads positions off the parse; it decides nothing.
function codeSpanRanges(mdBlock, base) {
  const out = []
  const walk = (node) => {
    if (node?.type === 'inlineCode') {
      const s = node.position?.start?.offset
      const e = node.position?.end?.offset
      if (Number.isInteger(s) && Number.isInteger(e)) out.push([s - base, e - base])
    }
    for (const child of node?.children || []) walk(child)
  }
  walk(mdBlock)
  return out
}

const stripIndent = (slice, ranges, wantInside) => {
  const inside = (index) => ranges.some(([s, e]) => index >= s && index < e)
  let out = ''
  let last = 0
  let changed = false
  LINE_START_INDENT_RE.lastIndex = 0
  let match
  while ((match = LINE_START_INDENT_RE.exec(slice)) !== null) {
    if (inside(match.index) !== wantInside) continue
    out += slice.slice(last, match.index) + match[1]
    last = match.index + match[0].length
    changed = true
  }
  return changed ? out + slice.slice(last) : null
}

const ABLATIONS = [
  {
    code: 'in-cell-line-break',
    label: '<br> inside a table cell (table-map hasCellBreak)',
    applies: isCell,
    apply: (slice) => (BR_RE.test(slice) ? slice.replace(BR_RE, 'q') : null)
  },
  {
    code: 'table-cell-pipe-escape',
    label: '\\| — the GFM cell escape layered on the CommonMark one',
    applies: isCell,
    apply: (slice) => (slice.includes('\\|') ? slice.split('\\|').join('q') : null)
  },
  {
    // CAUSE B. Must never explain a refusal again.
    code: 'table-cell-ordinary-escape',
    label: "REGRESSION: an ordinary CommonMark escape (`\\-`, `\\.`, `\\*`) in a cell",
    applies: isCell,
    apply: (slice) => (ESCAPE_RE.test(slice) ? slice.replace(ESCAPE_RE, '$1') : null)
  },
  {
    // CAUSE A. The continuation prefix is the leading whitespace of a wrapped
    // line; removing it is exactly the 'a b\n  `c` d' -> 'a b\n`c` d' step that
    // used to flip the block from refused to provable. Only line endings
    // OUTSIDE a code span count — see `codeSpanRanges`.
    code: 'softbreak-continuation-prefix',
    label: 'REGRESSION: a wrapped line whose continuation is indented',
    applies: hasInline,
    apply: (slice, ctx) => stripIndent(slice, ctx.codeSpans, false)
  },
  {
    code: 'code-span-line-continuation',
    label: 'an indented line continuation INSIDE an inline code span',
    applies: hasInline,
    apply: (slice, ctx) => (ctx.codeSpans.length ? stripIndent(slice, ctx.codeSpans, true) : null)
  },
  {
    code: 'container-indented-fence',
    label: 'a fenced code block indented inside a list item (buildCodeMap)',
    applies: isFence,
    apply: (slice) => {
      const out = slice.replace(LINE_START_INDENT_RE, '$1')
      return out === slice ? null : out
    }
  },
  {
    code: 'escape-in-prose',
    label: 'a CommonMark escape outside a table cell',
    applies: isProse,
    apply: (slice) => (ESCAPE_RE.test(slice) ? slice.replace(ESCAPE_RE, '$1') : null)
  },
  {
    code: 'inline-html',
    label: 'inline HTML tags (coalesced into one atom by the editor chain only)',
    applies: isProse,
    apply: (slice) => (HTML_TAG_RE.test(slice) ? slice.replace(HTML_TAG_RE, '') : null)
  },
  {
    code: 'criticmarkup',
    label: 'CriticMarkup marks (dual-chain divergence)',
    applies: isProse,
    apply: (slice) => (CRITIC_RE.test(slice) ? slice.replace(CRITIC_RE, '$2') : null)
  },
  {
    code: 'highlight-equals',
    label: '==highlight== (a custom mark the kernel does not decode)',
    applies: isProse,
    apply: (slice) => (slice.includes('==') ? slice.split('==').join('') : null)
  },
  {
    code: 'inline-math',
    label: 'inline $math$',
    applies: isProse,
    apply: (slice) => (INLINE_MATH_RE.test(slice) ? slice.replace(INLINE_MATH_RE, 'q') : null)
  },
  {
    code: 'hard-break',
    label: 'a hard break (two trailing spaces before a line ending)',
    applies: hasInline,
    apply: (slice) => {
      const out = slice.replace(/ {2,}(\r\n|\r|\n)/g, '$1')
      return out === slice ? null : out
    }
  }
]

// Is the block at `offset` editable in this document? The answer comes from the
// same three pieces the census uses; nothing here re-derives a rule.
//
// `expect` (optional) is the structural identity the block must still have —
// see the ablation rules above. Without it, this is a plain lookup of the
// innermost textblock covering `offset`.
function editableAt(raw, offset, expect = null) {
  let pmDoc
  try {
    pmDoc = parseEditorMarkdown(raw)
  } catch {
    return { ok: false, why: 'parse-threw' }
  }
  let map
  try {
    map = buildProjectionMap(raw, pmDoc)
  } catch {
    return { ok: false, why: 'map-threw' }
  }
  if (!map) return { ok: false, why: 'degraded' }
  const pairs = map.blockPairs || []
  let best = null
  let bestSpan = Infinity
  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i]
    const start = pair.mdBlock?.position?.start?.offset
    const end = pair.mdBlock?.position?.end?.offset
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue
    if (offset < start || offset >= end) continue
    if (!pair.pmNode?.isTextblock) continue
    if (end - start < bestSpan) {
      best = { pair, next: pairs[i + 1], start, end }
      bestSpan = end - start
    }
  }
  if (!best) return { ok: false, why: 'no-textblock-at-offset' }
  if (expect) {
    if (best.start !== offset) return { ok: false, why: 'block-start-moved' }
    if (best.end !== expect.end) return { ok: false, why: 'block-end-moved (restructured)' }
    if (best.pair.mdBlock?.type !== expect.mdType) return { ok: false, why: 'mdast type changed' }
    if (best.pair.pmNode?.type?.name !== expect.pmType) return { ok: false, why: 'PM type changed' }
  }
  return { ok: !pairIsReadOnlyToUser(best.pair, best.next, isTypableTextblock), why: 'measured' }
}

// Every ablation that INDEPENDENTLY restores the block's editability.
function attribute(raw, pair) {
  const start = pair.mdBlock?.position?.start?.offset
  const end = pair.mdBlock?.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end)) return { codes: [], note: 'no source span' }
  // Self-check: the lookup this function ablates against must agree with the
  // caller's own verdict, or the attribution below is about a different block.
  const before = editableAt(raw, start)
  if (before.ok) return { codes: [], note: `self-check failed (lookup says editable: ${before.why})` }
  const ctx = { codeSpans: codeSpanRanges(pair.mdBlock, start) }
  const original = raw.slice(start, end)
  const codes = []
  for (const ablation of ABLATIONS) {
    if (!ablation.applies(pair)) continue
    const slice = ablation.apply(original, ctx)
    if (slice === null || slice === undefined || slice === original) continue
    const edited = raw.slice(0, start) + slice + raw.slice(end)
    const expect = {
      end: end - (original.length - slice.length),
      mdType: pair.mdBlock.type,
      pmType: pair.pmNode?.type?.name
    }
    if (editableAt(edited, start, expect).ok) codes.push(ablation.code)
  }
  return { codes, note: null }
}

// ===========================================================================
// CLI
// ===========================================================================
const args = process.argv.slice(2)
const asserting = args.includes('--assert')
const ablate = !args.includes('--no-ablate')
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
    join(REPO, 'README.md'), join(REPO, 'CLAUDE.md'), join(REPO, 'AGENTS.md'),
    ...(await walkMarkdown(join(HOME, 'Downloads'), 8))
  ]
}

const causes = new Map()
const codeTotals = new Map()
const perDoc = []
let docs = 0
let readOnlyTotal = 0
let textblockTotal = 0
let unattributed = 0

for (const path of targets) {
  try { await stat(path) } catch { continue }
  let raw
  let map
  try {
    raw = await readFile(path, 'utf8')
    map = buildProjectionMap(raw, parseEditorMarkdown(raw))
  } catch { continue }
  if (!map) continue
  docs += 1
  const pairs = map.blockPairs || []
  const local = new Map()
  let ro = 0
  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i]
    if (pair?.pmNode?.isTextblock && !pair.virtual) textblockTotal += 1
    if (!pairIsReadOnlyToUser(pair, pairs[i + 1], isTypableTextblock)) continue
    ro += 1
    readOnlyTotal += 1

    const site = refusalSite(raw, pair)
    let what = site.ablatable ? '(ablation skipped)' : 'n/a'
    if (site.ablatable && ablate) {
      const { codes, note } = attribute(raw, pair)
      for (const code of codes) codeTotals.set(code, (codeTotals.get(code) || 0) + 1)
      if (note) what = note
      else if (!codes.length) { what = 'UNATTRIBUTED'; unattributed += 1 }
      else what = codes.join(' + ')
    }
    const label = `${site.site}: ${site.detail}${site.ablatable && ablate ? `  [${what}]` : ''}`
    causes.set(label, (causes.get(label) || 0) + 1)
    local.set(label, (local.get(label) || 0) + 1)
  }
  if (ro > 0) perDoc.push({ path, ro, local })
}

const pct = (n, d) => (d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(1).padStart(5)}%`)

console.log(`\n=== READ-ONLY ROOT-CAUSE ATTRIBUTION — ${docs} documents, ${readOnlyTotal} read-only blocks ===`)
console.log(`    (site = which shipped module refused; [what] = which byte feature an ablation proved responsible)\n`)
for (const [cause, n] of [...causes].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${pct(n, readOnlyTotal)}  ${cause}`)
}
console.log(`\n  read-only textblocks as a share of all textblocks: ${readOnlyTotal}/${textblockTotal} = ${pct(readOnlyTotal, textblockTotal)}`)

if (ablate) {
  console.log(`\n--- BYTE FEATURES, RANKED (each proved by removing it and re-running the real chain) ---`)
  if (!codeTotals.size) console.log('  (none — every read-only block is refused by construction)')
  for (const [code, n] of [...codeTotals].sort((a, b) => b[1] - a[1])) {
    const meta = ABLATIONS.find((a) => a.code === code)
    console.log(`  ${String(n).padStart(5)}  ${code.padEnd(28)} ${meta ? meta.label : ''}`)
  }
  if (unattributed) console.log(`  ${String(unattributed).padStart(5)}  UNATTRIBUTED                 no candidate feature explains these`)
}

if (perDoc.length) {
  console.log(`\n--- TOP 12 AFFECTED DOCUMENTS ---`)
  for (const d of perDoc.sort((a, b) => b.ro - a.ro).slice(0, 12)) {
    console.log(`  ${String(d.ro).padStart(4)}  ${d.path.replace(HOME, '~')}`)
    for (const [c, n] of [...d.local].sort((a, b) => b[1] - a[1])) {
      console.log(`         ${String(n).padStart(4)}  ${c}`)
    }
  }
}

if (!asserting) {
  console.log(`\n  (exploratory run — no assertions. \`--assert\` measures the committed corpus and fails on breach.)\n`)
  process.exit(0)
}

// ---------------------------------------------------------------- assertions
const failures = []
for (const code of REGRESSION_CODES) {
  const n = codeTotals.get(code) || 0
  if (n > 0) failures.push(`${n} read-only block(s) attributed to ${code} — a FIXED cause has regressed`)
}
if (!ablate) failures.push('--assert requires ablation; do not combine it with --no-ablate')
if (unattributed > 0) {
  failures.push(`${unattributed} read-only block(s) UNATTRIBUTED — a refusal this instrument cannot explain`)
}
if (!docs) failures.push('no documents measured')

console.log(`\n=== ASSERTIONS (committed corpus) ===`)
console.log(`  fixed causes must not reappear : ${[...REGRESSION_CODES].map((c) => `${c}=${codeTotals.get(c) || 0}`).join(', ')}`)
console.log(`  every read-only block attributed: unattributed=${unattributed}`)
if (failures.length) {
  console.log(`\n  FAIL`)
  for (const f of failures) console.log(`    - ${f}`)
  console.log()
  process.exit(1)
}
console.log(`\n  PASS — ${readOnlyTotal} read-only block(s), all attributed, neither fixed cause present\n`)
