// Feature-COMBINATION matrix for the source kernel — the suite that exists
// because every defect of the past week lived at an INTERSECTION of two
// features while each feature's own suite stayed green: Tab x lists, whitespace
// x IME, empty-fence x math, atoms x marks, hardbreak x blockquote,
// typed-marker x load. Single-feature suites systematically miss those.
//
// WHAT IS BEING PROVEN, AND BY WHOM
// ---------------------------------
// The oracle is the kernel's own machinery, exactly as the rest of the headless
// kernel suite uses it:
//   * `buildProjectionMap` (editor-kernel-projection-map.js) pairs the kernel's
//     mdast against the editor's ProseMirror document;
//   * `createMarkdownDocument` / `applySourceTransaction`
//     (lib/source-kernel/markdown-document.js) hold and mutate the source bytes;
//   * `replaceVisibleText` (lib/source-kernel/commands/replace-text.js) is the
//     kernel's own character-level edit primitive, whose boundaries are proven
//     by the charMap rather than searched for.
// The ProseMirror side comes from scripts/lib/kernel-parse-harness.mjs, which
// assembles the REAL editor parse chain (vendored preset specs + the app's own
// overrides + @milkdown/transformer's ParserState) instead of hand-building
// documents. Its fidelity is not assumed: test-mode-switch-combination-ui.mjs
// re-derives the same signatures inside the running app and fails if they
// disagree.
//
// THE FOUR PROPERTIES, per generated document
// -------------------------------------------
//  P1 PAIRING.        `buildProjectionMap` returns a map (not null), and the
//                     set of blocks that pair READ-ONLY (`charMap: null`) is
//                     snapshotted. A read-only block is a legitimate,
//                     fail-closed outcome; an UNINTENDED WIDENING of that set
//                     is a regression, so the snapshot makes it fail loudly.
//                     Documents whose map is null at all are pinned by name in
//                     KNOWN_UNPAIRED with the reason.
//  P2 BYTE STABILITY. Pairing must not mutate the source. The kernel document's
//                     text is still byte-identical after a map build, and a
//                     second independent build yields an identical signature.
//  P3 EDIT ROUND-TRIP.Every EDITABLE block accepts a plain-text edit committed
//                     through the kernel's own primitives, and the committed
//                     bytes reparse to a still-pairing document in which the
//                     edit is observable — the `blockEditIsObservable` posture
//                     (lib/source-kernel/commands/line-start-whitespace.js),
//                     applied per block instead of per command.
//  P4 LINE ENDINGS.   Every shape above is run for LF and for CRLF.
//
// No timing assertions anywhere. The generator is deterministic and seeded, and
// prints its composition count.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildProjectionMap } from '../src/renderer/src/components/editor-kernel-projection-map.js'
import {
  createMarkdownDocument,
  applySourceTransaction,
  replaceVisibleText
} from '../src/renderer/src/lib/source-kernel/index.js'
import { parseEditorMarkdown, prepareEditorMarkdown } from './lib/kernel-parse-harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_PATH = join(here, 'fixtures', 'kernel-combination-readonly-snapshot.json')
const UPDATE = process.env.UPDATE_KERNEL_COMBINATION_SNAPSHOT === '1'

// Deterministic, seeded sampler. Full pairwise over the element set is ~1.1k
// ordered pairs; the brief caps the matrix at a few hundred documents, so the
// pairs are sampled with a fixed-seed LCG (the classic MINSTD constants) rather
// than truncated — truncation would silently confine coverage to whatever the
// element list happens to start with, while a seeded sample spreads across it
// and is byte-identical on every run and every machine.
function seededOrder(count, seed) {
  const indices = Array.from({ length: count }, (_, i) => i)
  let state = seed >>> 0 || 1
  for (let i = count - 1; i > 0; i -= 1) {
    state = (state * 48271) % 2147483647
    const j = state % (i + 1)
    ;[indices[i], indices[j]] = [indices[j], indices[i]]
  }
  return indices
}

const NBSP = '\u00A0'

// ==========================================================================
// FEATURE ELEMENTS
// ==========================================================================
// Every entry is one self-contained block whose markdown ends in a single '\n',
// so composing two of them with a '\n' join always yields a blank-line
// separation (the unambiguous adjacency). `leadingOnly` marks a construct that
// is only itself at the very start of a document.
const ELEMENTS = [
  // --- paragraph x each inline kind ---
  { id: 'para-plain', md: '普通段落文本\n' },
  { id: 'para-bold', md: '段落 **粗体** 尾\n' },
  { id: 'para-italic', md: '段落 *斜体* 尾\n' },
  { id: 'para-strike', md: '段落 ~~删除~~ 尾\n' },
  { id: 'para-inline-code', md: '段落 `inline code` 尾\n' },
  { id: 'para-highlight', md: '段落 ==高亮== 尾\n' },
  { id: 'para-link', md: '段落 [链接](https://example.com) 尾\n' },
  { id: 'para-inline-image', md: '段落 ![替代](img.png) 尾\n' },
  { id: 'para-inline-math', md: '段落 $x^2$ 尾\n' },
  { id: 'para-inline-html', md: '段落 <span>内联</span> 尾\n' },
  // Both hard-break spellings. The two-space form is the one the SDD ledger
  // records as byte-refused for typing AT the break boundary; the backslash
  // form is its documented twin.
  { id: 'para-hardbreak-spaces', md: '第一行  \n第二行\n' },
  { id: 'para-hardbreak-backslash', md: '第一行\\\n第二行\n' },
  // A SOFT line break — no trailing spaces, no backslash. Distinct from both
  // hard-break spellings and the single-line paragraph, and the shape that
  // carries the CRLF read-only family recorded in KNOWN_DEGRADED below.
  { id: 'para-softbreak', md: '第一行\n第二行\n' },
  // --- headings ---
  { id: 'heading-plain', md: '## 普通标题\n' },
  { id: 'heading-marks', md: '## 标题 **粗** `码`\n' },
  // A U+00A0 immediately after the ATX marker: the stranded-nbsp family.
  { id: 'heading-nbsp', md: `## ${NBSP}前置空格标题\n` },
  { id: 'heading-setext', md: '设定标题\n===\n' },
  // --- lists ---
  { id: 'list-bullet', md: '- 甲\n- 乙\n' },
  { id: 'list-ordered', md: '1. 甲\n2. 乙\n' },
  { id: 'list-task', md: '- [ ] 未完成\n- [x] 已完成\n' },
  { id: 'list-nested', md: '- 甲\n  - 乙\n    - 丙\n' },
  { id: 'list-mixed', md: '1. 甲\n   - 乙\n2. 丙\n' },
  // --- blockquotes ---
  { id: 'quote-plain', md: '> 引用一行\n' },
  // A quote whose paragraph spans two lines — the blockquote x soft-break
  // intersection, and a different charMap problem from the single-line quote
  // (the second line carries the '> ' continuation prefix).
  { id: 'quote-multiline', md: '> 第一行\n> 第二行\n' },
  { id: 'quote-nested', md: '> 外层\n>\n> > 内层\n' },
  // The bare '>' line — the shape that used to degrade a whole document and
  // that `/quote` could never produce (SDD ledger, stabilization round 2).
  { id: 'quote-bare', md: '>\n' },
  // --- code fences ---
  { id: 'fence-js', md: '```js\nlet a = 1\n```\n' },
  { id: 'fence-mermaid', md: '```mermaid\ngraph TD\nA-->B\n```\n' },
  { id: 'fence-latex', md: '```latex\n\\alpha + \\beta\n```\n' },
  { id: 'fence-empty', md: '```\n```\n' },
  // --- block math ---
  { id: 'math-block', md: '$$\nE=mc^2\n$$\n' },
  // --- tables ---
  { id: 'table-marks', md: '| 甲 | 乙 |\n| --- | --- |\n| **粗** | `码` |\n' },
  { id: 'table-br', md: '| 甲 | 乙 |\n| --- | --- |\n| 一<br>二 | 三 |\n' },
  // --- leaves ---
  // Two thematic-break spellings, deliberately. `---` at the very START of a
  // document is genuinely ambiguous with a YAML front-matter opening fence, and
  // `remark-frontmatter` (mounted identically on BOTH chains — the kernel's
  // syntax-index.js and the editor's crepe setup) resolves that ambiguity by
  // reading the rest of the document as one lazy PARAGRAPH. Both sides agree,
  // so the pairing is sound and no byte is at risk, but every `---`-led
  // composition would otherwise silently stop exercising the construct that
  // follows it. `***` keeps the thematic-break x everything intersection real.
  { id: 'thematic-break', md: '---\n' },
  { id: 'thematic-break-stars', md: '***\n' },
  { id: 'image-block', md: '![独立图片](standalone.png)\n' },
  // --- front matter (document head only) ---
  { id: 'frontmatter', md: '---\ntitle: 示例\ntags: [a, b]\n---\n', leadingOnly: true }
]

const byId = new Map(ELEMENTS.map((element) => [element.id, element]))
const el = (id) => {
  const found = byId.get(id)
  if (!found) throw new Error(`unknown element: ${id}`)
  return found
}

// ==========================================================================
// CONTAINMENT — element A holding element B, where the grammar allows it.
// ==========================================================================
// Each builder indents/prefixes B's own markdown rather than re-spelling it, so
// the contained construct stays the SAME construct the adjacency cases use.
const indentBlock = (md, pad) => md.replace(/\n$/, '').split('\n').map((line) => (line === '' ? '' : pad + line)).join('\n') + '\n'
const quotePrefix = (md) => md.replace(/\n$/, '').split('\n').map((line) => (line === '' ? '>' : `> ${line}`)).join('\n') + '\n'

const CONTAINMENT = []
// list > quote, list > fence, list > table, list > math  (3-space continuation
// under an ordered marker and 2-space under a bullet, the canonical shapes)
for (const inner of ['quote-plain', 'fence-js', 'fence-empty', 'math-block', 'table-marks', 'para-bold', 'para-hardbreak-spaces']) {
  CONTAINMENT.push({
    id: `contain:list-bullet>${inner}`,
    md: `- 甲\n\n${indentBlock(el(inner).md, '  ')}`
  })
  CONTAINMENT.push({
    id: `contain:list-ordered>${inner}`,
    md: `1. 甲\n\n${indentBlock(el(inner).md, '   ')}`
  })
}
// quote > everything it can hold
for (const inner of ['list-bullet', 'list-task', 'fence-js', 'fence-empty', 'math-block', 'table-marks', 'heading-plain', 'para-highlight', 'para-hardbreak-spaces', 'thematic-break']) {
  CONTAINMENT.push({ id: `contain:quote>${inner}`, md: quotePrefix(el(inner).md) })
}
// nested list holding a fence / a quote
CONTAINMENT.push({ id: 'contain:list-nested>fence', md: `- 甲\n  - 乙\n\n${indentBlock(el('fence-js').md, '    ')}` })
CONTAINMENT.push({ id: 'contain:list-nested>quote', md: `- 甲\n  - 乙\n\n${indentBlock(el('quote-plain').md, '    ')}` })
// table cell > marks / atoms — the cell interior is its own zip
// (lib/source-kernel/table-map.js), so marks and atoms inside a cell are a
// genuinely different intersection from marks in a paragraph.
CONTAINMENT.push({ id: 'contain:table-cell>marks', md: '| 甲 | 乙 |\n| --- | --- |\n| **粗** *斜* | ~~删~~ `码` |\n' })
CONTAINMENT.push({ id: 'contain:table-cell>atoms', md: '| 甲 | 乙 |\n| --- | --- |\n| ![i](a.png) | $x^2$ |\n' })
CONTAINMENT.push({ id: 'contain:table-cell>link-highlight', md: '| 甲 | 乙 |\n| --- | --- |\n| [l](https://e.com) | ==高== |\n' })
CONTAINMENT.push({ id: 'contain:table-cell>html', md: '| 甲 | 乙 |\n| --- | --- |\n| <span>x</span> | 普通 |\n' })

// ==========================================================================
// TARGETED TRIPLES — only for shapes the record says are hot.
// ==========================================================================
const TRIPLES = [
  // quote > list > fence: three container levels, each with its own per-line
  // prefix, which is precisely what `buildCodeMap`'s prefix proof can fail on.
  { id: 'triple:quote>list>fence', md: '> - 甲\n>\n>   ```js\n>   let a = 1\n>   ```\n' },
  { id: 'triple:quote>list>fence-empty', md: '> - 甲\n>\n>   ```\n>   ```\n' },
  // a list item carrying a hard break AND marks
  { id: 'triple:list-item>hardbreak+marks', md: '- **粗**第一行  \n  *斜*第二行\n- 乙\n' },
  { id: 'triple:task-item>hardbreak+marks', md: '- [x] **粗**第一行  \n  `码`第二行\n' },
  // quote > list > task with inline atoms
  { id: 'triple:quote>list>task-atoms', md: '> - [ ] 甲 $x^2$\n> - [x] 乙 ![i](a.png)\n' },
  // nested list whose deepest item holds block math
  { id: 'triple:list>list>math', md: '- 甲\n  - 乙\n\n    $$\n    E=mc^2\n    $$\n' },
  // heading with a leading NBSP directly inside a quote
  { id: 'triple:quote>heading-nbsp', md: `> ## ${NBSP}前置空格标题\n` },
  // frontmatter followed immediately by a table containing a <br>
  { id: 'triple:frontmatter>table-br', md: '---\ntitle: 示例\n---\n\n| 甲 | 乙 |\n| --- | --- |\n| 一<br>二 | 三 |\n' }
]

// ==========================================================================
// COMPOSITION
// ==========================================================================
// Full pairwise is the DEFAULT: the whole ordered product runs in a couple of
// seconds, so there is no reason to trade coverage away. The seeded sampler
// stays wired up behind these two env vars for a fast local subset — the seed
// makes any such subset byte-identical between runs and machines, so a sampled
// run is still reproducible rather than merely quick.
const PAIR_SAMPLE_CAP = Number(process.env.KERNEL_MATRIX_PAIR_CAP || Infinity)
const CRLF_SAMPLE_CAP = Number(process.env.KERNEL_MATRIX_CRLF_CAP || Infinity)
const SEED = Number(process.env.KERNEL_MATRIX_SEED || 20260817)

function buildCompositions() {
  const adjacency = []
  const leading = ELEMENTS.filter((element) => element.leadingOnly)
  const free = ELEMENTS.filter((element) => !element.leadingOnly)
  // Every ORDERED pair of non-leading elements, including each element with
  // itself (two of the same construct in a row is its own intersection — the
  // authored-marker family lives there).
  for (const a of free) {
    for (const b of free) {
      adjacency.push({ id: `adj:${a.id}+${b.id}`, md: `${a.md}\n${b.md}` })
    }
  }
  // Leading-only constructs pair as the FIRST element only.
  for (const a of leading) {
    for (const b of free) {
      adjacency.push({ id: `adj:${a.id}+${b.id}`, md: `${a.md}\n${b.md}` })
    }
  }

  const order = seededOrder(adjacency.length, SEED)
  const sampledAdjacency = order.slice(0, Math.min(PAIR_SAMPLE_CAP, adjacency.length))
    .map((index) => adjacency[index])
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const structural = [...CONTAINMENT, ...TRIPLES]
  const lfDocuments = [...sampledAdjacency, ...structural]

  // CRLF variants: every containment/triple (they are the prefix-sensitive
  // shapes, where a line ending is most likely to matter) plus a seeded sample
  // of the adjacency pairs.
  const crlfOrder = seededOrder(sampledAdjacency.length, SEED ^ 0x5f5f)
  const crlfAdjacency = crlfOrder.slice(0, Math.min(CRLF_SAMPLE_CAP, sampledAdjacency.length))
    .map((index) => sampledAdjacency[index])
  const crlfDocuments = [...crlfAdjacency, ...structural].map((doc) => ({
    id: `${doc.id}#crlf`,
    md: doc.md.replace(/\n/g, '\r\n')
  }))

  return {
    documents: [...lfDocuments, ...crlfDocuments],
    totalAdjacency: adjacency.length,
    sampledAdjacency: sampledAdjacency.length,
    structural: structural.length,
    crlf: crlfDocuments.length
  }
}

// ==========================================================================
// ORACLE HELPERS
// ==========================================================================

// The signature that gets snapshotted: which pairs are read-only, described
// structurally (index + PM node type) rather than by content, so a snapshot
// entry stays readable and a widening is legible in the diff.
//
// Containers (`bullet_list`, `list_item`, `blockquote`, `table`) and ATOMS
// (`hr`, `frontmatter`, `image-block`) are read-only BY CONSTRUCTION — they are
// not textblocks, so they can never carry a charMap. Recording them would bury
// the interesting signal in noise, so the snapshot keeps only pairs whose PM
// node IS a textblock: those are the blocks a user can put a cursor in, and a
// read-only one is exactly the "some blocks read-only" status the app reports.
function readOnlySignature(map) {
  const out = []
  map.blockPairs.forEach((pair, index) => {
    if (pair.charMap) return
    if (!pair.pmNode?.isTextblock) return
    out.push(`${index}:${pair.pmNode.type.name}${pair.tableCell ? '(cell)' : ''}`)
  })
  return out
}

function editablePairs(map) {
  return map.blockPairs.filter((pair) => pair.charMap && pair.pmNode?.isTextblock)
}

// A marker chosen to be inert in every grammar in the element set: not a
// Markdown control character, not whitespace, not a fence/table/quote/list
// delimiter, and not something `prepareEditorMarkdown` rewrites.
const EDIT_MARKER = 'Ω'

// ==========================================================================
// KNOWN, DELIBERATELY PINNED OUTCOMES
// ==========================================================================
// A refusal is an ACCEPTABLE outcome; silence is not. Anything listed here is
// current reality, recorded so the suite fails when reality shifts — in EITHER
// direction (an entry that starts passing is reported too, so the list cannot
// rot into a permanent excuse).
//
// KNOWN_UNPAIRED: composition ids whose projection map is null outright. Each
// needs a reason that is a statement about the shape, not about the test.
const KNOWN_UNPAIRED = new Map([])

// KNOWN_UNEDITABLE_BLOCK: shapes where an editable block's committed edit does
// NOT reparse observably. Keyed by composition id -> note.
const KNOWN_UNEDITABLE = new Map([])

// KNOWN-DEGRADED — the read-only families the snapshot currently holds. These
// are NOT assertions (the snapshot is the assertion); they are the reasons,
// written down so the snapshot is readable and so a future reader can tell an
// intended entry from a regression that got rubber-stamped.
//
// D1. GFM TABLE CELL CONTAINING `<br>`  ->  that CELL is read-only.
//     Shape:      `| 一<br>二 | 三 |`
//     Mechanism:  the `<br>` is rewritten to an mdast `break` by
//                 `brToBreakRemarkPlugin`, so PM holds text/hardbreak/text
//                 (content.size 3), while `buildTableCellMaps`
//                 (lib/source-kernel/table-map.js) returns `charMap: null` for
//                 the cell outright.
//     Posture:    fail-closed and LOUD — the cell simply cannot be typed into,
//                 its siblings stay editable, and the status bar reports
//                 "some blocks read-only". No byte is at risk.
//
// D2. CRLF + SOFT LINE BREAK IN PROSE  ->  that PARAGRAPH is read-only.
//     Shape:      `甲\r\n乙` (a multi-line paragraph, or a multi-line
//                 blockquote paragraph, in a CRLF document). The LF spelling of
//                 the very same paragraph is fully editable.
//     Mechanism:  measured, not inferred — for `'甲\r\n乙\r\n'`
//                 `buildCharacterMap` emits units
//                 [char 0-1, char 1-2, linebreak 2-3, char 3-4], i.e. it counts
//                 the `\r` as its OWN width-1 visible unit, giving
//                 visibleLength 4; ProseMirror's paragraph holds `甲\n乙`,
//                 content.size 3. The projection map's size check
//                 (`pm.node.content.size !== charMap.visibleLength`) then nulls
//                 the charMap for that block. For LF the units are
//                 [char, linebreak, char] and both counts are 3.
//     Scope:      this makes EVERY multi-line paragraph and multi-line
//                 blockquote paragraph read-only in a CRLF-authored document.
//                 A code block is unaffected (`buildCodeMap` keeps `\r` as
//                 content on both sides, so the two counts agree), and so is a
//                 CRLF paragraph with no interior line break, and so is a CRLF
//                 HARD break.
//     Posture:    fail-closed and LOUD, exactly like D1 — read-only, not wrong
//                 bytes. Recorded here rather than "fixed" in a test, because a
//                 fix belongs in the kernel's line-ending handling, not in the
//                 suite that found it.
// D3. PARAGRAPH WHOSE SOFT-BREAK CONTINUATION LINE STARTS WITH `> `
//     ->  that PARAGRAPH is read-only.
//     Shape:      a paragraph whose second line begins with a blockquote
//                 marker while the marker is LITERAL CONTENT, not a container
//                 prefix. In this matrix it is reached through the `---`
//                 front-matter ambiguity described on the `thematic-break`
//                 element: `---\n\n> 第一行\n> 第二行\n` parses as
//                 thematicBreak + one paragraph whose text is `"> 第一行\n> 第二行"`.
//     Mechanism:  `buildCharacterMap` returns null outright (not a length
//                 disagreement) — a soft break's raw span has to reach through
//                 the next line's continuation prefix, and the kernel refuses
//                 rather than guess whether `> ` is a prefix it should absorb
//                 or content it must keep. Exactly the fail-closed posture the
//                 hard-break-into-blockquote family is documented under.
//     Posture:    fail-closed and LOUD.
//
// Each family carries a STATUS, and the snapshot stores the family alongside
// every entry, because these are not all the same kind of fact:
//   `known-degraded`      — current, fail-closed behaviour with no scheduled
//                           change; a diff here is a regression to investigate.
//   `fix-scheduled`       — a confirmed defect with an owner and a planned fix.
//                           When that fix lands, EVERY entry in the family
//                           disappears at once. The snapshot check below names
//                           the family in that case and says the narrowing is
//                           expected, so re-baselining is a conscious one-line
//                           decision instead of a mystery diff.
const KNOWN_DEGRADED_FAMILIES = {
  D1: {
    status: 'known-degraded',
    summary: 'table cell containing <br> -> cell read-only'
  },
  D2: {
    status: 'fix-scheduled',
    summary: 'CRLF + soft line break in prose -> paragraph read-only (the `\\r` unit-model widening; scheduled as its own task)'
  },
  D3: {
    status: 'known-degraded',
    summary: 'paragraph whose soft-break continuation line starts with "> " -> paragraph read-only'
  }
}

// Which family does one read-only block belong to? Deliberately mechanical, so
// a shape that matches NO family cannot be quietly absorbed into one: it falls
// through to D3, and D3 entries are printed by name on every run.
function classifyReadOnly(compositionId, entry) {
  if (entry.endsWith('(cell)')) return 'D1'
  if (compositionId.endsWith('#crlf')) return 'D2'
  return 'D3'
}

// ==========================================================================
// RUN
// ==========================================================================
console.log('--- kernel combination matrix ---')

const composed = buildCompositions()
const sampledNote = composed.sampledAdjacency === composed.totalAdjacency
  ? `adjacency ${composed.totalAdjacency} (full pairwise)`
  : `adjacency ${composed.sampledAdjacency}/${composed.totalAdjacency} seeded-sampled`
console.log(
  `compositions: ${composed.documents.length} documents ` +
  `(${sampledNote}, containment+triples ${composed.structural}, ` +
  `CRLF variants ${composed.crlf}; ${ELEMENTS.length} elements; seed ${SEED})`
)

const snapshot = {}
const failures = []
const stats = {
  pairedDocuments: 0,
  unpairedDocuments: 0,
  editableBlocks: 0,
  readOnlyTextblocks: 0,
  documentsWithReadOnlyTextblocks: 0,
  editsCommitted: 0,
  preparationRewrites: 0,
  byFamily: {}
}

const record = (id, message) => failures.push(`${id}: ${message}`)

for (const document of composed.documents) {
  const { id, md } = document

  // --- P2a: the editor's own preparation step. When it rewrites bytes, the
  // projection map is built against the RAW bytes while PM comes from the
  // PREPARED ones, so this is worth counting rather than hiding.
  if (prepareEditorMarkdown(md) !== md) stats.preparationRewrites += 1

  let pmDoc
  try {
    pmDoc = parseEditorMarkdown(md)
  } catch (error) {
    record(id, `harness parse threw: ${error.message}`)
    continue
  }

  const kernelDoc = createMarkdownDocument(md)
  // --- P2b: the kernel holds the bytes verbatim.
  if (kernelDoc.text !== md) {
    record(id, 'createMarkdownDocument did not hold the source bytes verbatim')
    continue
  }

  const map = buildProjectionMap(kernelDoc.text, pmDoc)

  // --- P1: pairing.
  if (!map) {
    stats.unpairedDocuments += 1
    if (!KNOWN_UNPAIRED.has(id)) {
      record(id, 'buildProjectionMap returned null (unpinned). If this is intended, add it to KNOWN_UNPAIRED with a reason.')
    }
    continue
  }
  if (KNOWN_UNPAIRED.has(id)) {
    record(id, 'listed in KNOWN_UNPAIRED but the map now builds — remove the entry (reality improved).')
  }
  stats.pairedDocuments += 1

  // --- P2c: pairing did not mutate the source, and is deterministic.
  if (kernelDoc.text !== md) {
    record(id, 'building the projection map mutated the kernel document text')
    continue
  }
  const signature = readOnlySignature(map)
  const second = buildProjectionMap(md, parseEditorMarkdown(md))
  if (!second || readOnlySignature(second).join('|') !== signature.join('|')) {
    record(id, 'a second, independent map build produced a different read-only signature')
    continue
  }

  if (signature.length) {
    const families = [...new Set(signature.map((entry) => classifyReadOnly(id, entry)))].sort()
    snapshot[id] = { families, readOnly: signature }
    stats.documentsWithReadOnlyTextblocks += 1
    stats.readOnlyTextblocks += signature.length
    for (const family of families) stats.byFamily[family] = (stats.byFamily[family] || 0) + 1
  }

  // --- P3: every editable block round-trips a committed plain-text edit.
  const editable = editablePairs(map)
  stats.editableBlocks += editable.length
  let editFailure = null
  for (const pair of editable) {
    const { charMap } = pair
    // Insert strictly INSIDE the block's visible content when it has room, so
    // the case never turns into a question about block-boundary ownership
    // (which the whitespace/boundary suites own); otherwise at its only point.
    const at = charMap.visibleLength >= 2 ? 1 : charMap.visibleLength
    const insert = `${pair.insertPrefix || ''}${EDIT_MARKER}`
    const attempt = replaceVisibleText({
      doc: kernelDoc,
      map: charMap,
      visFrom: at,
      visTo: at,
      insert
    })
    if (!attempt.ok) {
      editFailure = `editable pair at pmPos ${pair.pmPos} refused its own charMap-proven edit (${attempt.code})`
      break
    }
    const applied = applySourceTransaction(kernelDoc, attempt.transaction)
    if (!applied?.ok) {
      editFailure = `applySourceTransaction refused a replaceVisibleText transaction (${applied?.code})`
      break
    }
    const editedText = applied.doc.text
    // The edit must be in the bytes exactly once — no duplication, no loss.
    const occurrences = editedText.split(EDIT_MARKER).length - 1
    if (occurrences !== 1) {
      editFailure = `committed edit appears ${occurrences} times in the bytes (expected exactly 1)`
      break
    }
    // ...and it must survive the round trip: reparse the committed bytes and
    // require both a still-pairing document and an OBSERVABLE edit.
    let editedPm
    try {
      editedPm = parseEditorMarkdown(editedText)
    } catch (error) {
      editFailure = `reparsing committed bytes threw: ${error.message}`
      break
    }
    const editedMap = buildProjectionMap(editedText, editedPm)
    if (!editedMap) {
      editFailure = `committed bytes no longer pair (edit at pmPos ${pair.pmPos})`
      break
    }
    if (!editedPm.textContent.includes(EDIT_MARKER)) {
      editFailure = `committed edit at pmPos ${pair.pmPos} is not observable in the reparsed document`
      break
    }
    stats.editsCommitted += 1
  }

  if (editFailure) {
    if (!KNOWN_UNEDITABLE.has(id)) {
      record(id, `${editFailure}. If this is intended, pin it in KNOWN_UNEDITABLE with a reason.`)
    }
  } else if (KNOWN_UNEDITABLE.has(id)) {
    record(id, 'listed in KNOWN_UNEDITABLE but every editable block now round-trips — remove the entry.')
  }
}

// ==========================================================================
// READ-ONLY SNAPSHOT
// ==========================================================================
const snapshotFile = {
  // A comment inside the artifact itself: the file is read by people during a
  // re-baseline, and the families are the whole point of it.
  note: 'Read-only blocks the source kernel currently refuses to pair, by composition. Regenerate deliberately with UPDATE_KERNEL_COMBINATION_SNAPSHOT=1. See KNOWN_DEGRADED_FAMILIES in scripts/test-kernel-combination-matrix.mjs.',
  families: KNOWN_DEGRADED_FAMILIES,
  documents: snapshot
}

if (UPDATE) {
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshotFile, null, 2)}\n`)
  console.log(`snapshot UPDATED (${Object.keys(snapshot).length} documents with read-only textblocks)`)
} else {
  let expectedFile
  try {
    expectedFile = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))
  } catch {
    throw new Error(
      `missing read-only snapshot at ${SNAPSHOT_PATH}. ` +
      'Create it deliberately with UPDATE_KERNEL_COMBINATION_SNAPSHOT=1.'
    )
  }
  const expected = expectedFile.documents || {}
  const entriesOf = (value) => (value?.readOnly || []).join(', ')
  const expectedKeys = Object.keys(expected).sort()
  const actualKeys = Object.keys(snapshot).sort()
  const widened = actualKeys.filter((key) => !expected[key])
  const narrowed = expectedKeys.filter((key) => !snapshot[key])
  const changed = actualKeys.filter((key) => expected[key] && entriesOf(expected[key]) !== entriesOf(snapshot[key]))

  for (const key of widened) {
    failures.push(
      `READ-ONLY WIDENED: ${key} now has read-only textblocks [${entriesOf(snapshot[key])}] ` +
      `(family ${snapshot[key].families.join('+')}) and did not before`
    )
  }
  // A narrowing is good news, and for a `fix-scheduled` family it is the
  // EXPECTED news — say so, and name the family, so the re-baseline is one
  // conscious decision rather than N mystery diffs.
  const narrowedByFamily = new Map()
  for (const key of narrowed) {
    const families = expected[key].families || ['?']
    const label = families.join('+')
    if (!narrowedByFamily.has(label)) narrowedByFamily.set(label, [])
    narrowedByFamily.get(label).push(key)
  }
  for (const [label, keys] of narrowedByFamily) {
    const scheduled = label.split('+').every((family) => KNOWN_DEGRADED_FAMILIES[family]?.status === 'fix-scheduled')
    failures.push(
      `READ-ONLY NARROWED: ${keys.length} composition(s) in family ${label} no longer degrade` +
      (scheduled
        ? ` — this family is marked fix-scheduled, so this is the EXPECTED landing of that fix. Re-baseline with UPDATE_KERNEL_COMBINATION_SNAPSHOT=1 and drop family ${label} from KNOWN_DEGRADED_FAMILIES.`
        : ' — an improvement, but update the snapshot consciously.') +
      ` First: ${keys.slice(0, 3).join(', ')}`
    )
  }
  for (const key of changed) {
    failures.push(`READ-ONLY CHANGED: ${key} was [${entriesOf(expected[key])}], now [${entriesOf(snapshot[key])}]`)
  }
}

console.log(
  `paired ${stats.pairedDocuments} / unpaired ${stats.unpairedDocuments}; ` +
  `editable textblocks ${stats.editableBlocks} (edits committed ${stats.editsCommitted}); ` +
  `read-only textblocks ${stats.readOnlyTextblocks} across ${stats.documentsWithReadOnlyTextblocks} documents; ` +
  `preparation rewrote bytes in ${stats.preparationRewrites} documents`
)
// Attribute every read-only entry to a named family, so the number above is
// readable and an entry belonging to NO known family stands out immediately —
// that is the one a reader must look at.
{
  const counts = Object.entries(stats.byFamily).sort().map(([family, count]) => `${family} ${count}`).join(', ')
  console.log(`read-only attribution by family (documents): ${counts || 'none'}`)
  for (const [family, meta] of Object.entries(KNOWN_DEGRADED_FAMILIES)) {
    console.log(`  ${family} [${meta.status}] ${meta.summary}`)
  }
  // D3 is the catch-all, so never let one of its entries stay anonymous: print
  // every D3 composition by name. A genuinely new family lands here first.
  for (const [id, value] of Object.entries(snapshot)) {
    if (value.families.includes('D3')) console.log(`  D3 detail: ${id} -> [${value.readOnly.join(', ')}]`)
  }
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  assert.fail(`kernel combination matrix: ${failures.length} failure(s)`)
}

console.log('kernel combination matrix OK')
