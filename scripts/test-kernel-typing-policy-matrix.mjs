// TYPING-POLICY MATRIX — the systematic instrument the `4.` week showed was
// missing (2026-08-24 user review: "stop whack-a-mole; derive the fix and the
// tests from mature practice, not trial-and-error").
//
// THE MATURE CASE THIS MIRRORS. Model-first editors (ProseMirror-markdown,
// remark's own serializer, and by extension Typora/Obsidian) enforce
// "typed text stays text" at ONE place — serialization — driven by ONE
// authoritative table: mdast-util-to-markdown's `unsafe` list (vendored in
// this repo), whose entries (`{atBreak, before, character, after}`) encode
// exactly which characters restructure at which positions. Their correctness
// is checked by a UNIVERSAL round-trip property over generated corpora, not
// by per-gesture reproductions. This kernel is source-first, so the policy
// home is the byte-commit chokepoint instead of a serializer — but the same
// two lessons hold verbatim: one policy site, one property swept over a
// corpus.
//
// WHAT THIS SUITE IS TODAY: the INVENTORY. For every (base document x
// insertion position x character of the unsafe alphabet — read from
// mdast-util-to-markdown's own table at runtime, plus controls), the literal
// byte is committed through the kernel's own plain-text primitive and the
// outcome CLASSIFIED:
//   text-preserved  — the character appears as visible text in its block and
//                     the block skeleton is unchanged (the invariant);
//   restructures    — the literal byte changes the block skeleton (a policy
//                     hole: the app-layer escape must cover it, or the
//                     chokepoint must respell it);
//   refused         — the primitive refused (fail-closed; acceptable, loud).
// The `restructures` set is SNAPSHOTTED with family labels. A WIDENING fails
// the suite; a fix narrows it deliberately (regenerate with
// UPDATE_KERNEL_TYPING_POLICY_SNAPSHOT=1). When the chokepoint unification
// lands (docs/typing-policy-chokepoint-adr.md), this suite's target state is
// an EMPTY snapshot — every unsafe character either respelled or loudly
// refused, never silently restructured.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createMarkdownDocument,
  applySourceTransaction,
  buildSyntaxIndex,
  replaceVisibleText
} from '../src/renderer/src/lib/source-kernel/index.js'
import { buildProjectionMap } from '../src/renderer/src/components/editor-kernel-projection-map.js'
import { parseEditorMarkdown } from './lib/kernel-parse-harness.mjs'
// THE AUTHORITATIVE ALPHABET — remark's own escaping table, imported from the
// vendored package so the sweep can never drift from what the parser
// actually restructures on. (`unsafe` is the exact data
// mdast-util-to-markdown's serializer consults to escape text nodes.)
import { unsafe } from '../node_modules/mdast-util-to-markdown/lib/unsafe.js'

const here = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_PATH = join(here, 'fixtures', 'kernel-typing-policy-snapshot.json')
const UPDATE = process.env.UPDATE_KERNEL_TYPING_POLICY_SNAPSHOT === '1'

// Every distinct single character the unsafe table names at a break or in
// phrasing, deduplicated — plus controls that must NEVER restructure.
const UNSAFE_CHARS = [...new Set(
  unsafe
    .map((entry) => entry.character)
    .filter((ch) => typeof ch === 'string' && ch.length === 1 && ch !== '\n' && ch !== '\r' && ch !== ' ' && ch !== '\t')
)]
const CONTROL_CHARS = ['x', '甲', '7']
const ALPHABET = [...UNSAFE_CHARS, ...CONTROL_CHARS]

// Base documents: the block families a typed character can land in. Small on
// purpose — the alphabet x position product supplies the breadth.
const BASES = [
  { id: 'paragraph', md: '甲乙\n' },
  { id: 'bullet-item', md: '- 甲\n- 乙\n' },
  { id: 'ordered-item', md: '1. 甲\n2. 乙\n' },
  { id: 'ordered-after-digit', md: '1. 甲\n2. 4\n' },
  { id: 'nested-item', md: '- 甲\n  - 乙\n' },
  { id: 'quote-paragraph', md: '> 甲乙\n' },
  { id: 'heading', md: '## 甲乙\n' },
  { id: 'task-item', md: '- [ ] 甲\n' }
]

const blockSignature = (tree) => {
  const out = []
  const walk = (node) => {
    if (node?.type && node.type !== 'text' && !node.value) out.push(node.type)
    for (const child of node?.children || []) walk(child)
  }
  walk(tree)
  return out.join('|')
}

// Every editable textblock pair of a document, with its content span —
// the same resolution the combination matrix's P3 uses.
const editablePairs = (map) => map.blockPairs.filter((pair) => pair.charMap && pair.pmNode?.isTextblock)

// The adjudicated bare-marker transients (text-escape.js TRANSIENT_SINGLE):
// single marker characters owned by the completing-space / run-growth /
// following-text machinery and the inline-mark openers. Their literal
// restructure at a line start is the DESIGNED intermediate state, classified
// and pinned separately from genuine holes.
const TRANSIENT_SINGLE = new Set(['-', '+', '*', '>', '#', '`', '~', '_'])

const results = { preserved: 0, refused: 0, restructures: {}, transients: {} }
let cases = 0

for (const base of BASES) {
  for (const ending of ['\n', '\r\n']) {
    const md = ending === '\n' ? base.md : base.md.replace(/\n/g, '\r\n')
    const map = buildProjectionMap(md, parseEditorMarkdown(md))
    if (!map) continue
    const pairs = editablePairs(map)
    for (let pairIndex = 0; pairIndex < pairs.length; pairIndex += 1) {
      const pair = pairs[pairIndex]
      const length = pair.charMap.visibleLength
      // Block start and block end — the two positions the unsafe table's
      // `atBreak`/phrasing split is about.
      for (const at of [...new Set([0, length])]) {
        for (const ch of ALPHABET) {
          cases += 1
          const doc = createMarkdownDocument(md)
          const routed = replaceVisibleText({
            doc,
            map: pair.charMap,
            visFrom: at, visTo: at,
            insert: ch
          })
          if (!routed?.ok) { results.refused += 1; continue }
          const applied = applySourceTransaction(doc, routed.transaction)
          if (!applied?.ok) { results.refused += 1; continue }
          const before = blockSignature(buildSyntaxIndex(md).tree)
          const after = blockSignature(buildSyntaxIndex(applied.doc.text).tree)
          if (before === after) {
            results.preserved += 1
            continue
          }
          // CONTROLS must never land here — that would be a parser/primitive
          // bug, not a policy hole, and it fails immediately.
          assert.ok(!CONTROL_CHARS.includes(ch),
            `control character ${JSON.stringify(ch)} restructured ${base.id}@${at} (${ending === '\n' ? 'LF' : 'CRLF'}): ${JSON.stringify(applied.doc.text)}`)
          const key = `${base.id}${ending === '\n' ? '' : '#crlf'}@block${pairIndex}:${at === 0 ? 'start' : 'end'}+${JSON.stringify(ch)}`
          if (TRANSIENT_SINGLE.has(ch)) {
            results.transients[key] = true
            continue
          }
          results.restructures[key] = { after: applied.doc.text }
        }
      }
    }
  }
}

const restructureKeys = Object.keys(results.restructures).sort()
const transientKeys = Object.keys(results.transients).sort()
console.log('--- kernel typing-policy matrix ---')
console.log(`cases: ${cases} (${BASES.length} bases x LF/CRLF x block starts+ends x ${ALPHABET.length} chars [${UNSAFE_CHARS.length} unsafe from mdast-util-to-markdown + ${CONTROL_CHARS.length} controls])`)
console.log(`text-preserved ${results.preserved}; refused ${results.refused}; marker-transients ${transientKeys.length} (adjudicated); RESTRUCTURES ${restructureKeys.length}`)

const snapshot = { note: 'Typing-policy map. `restructures` are genuine HOLES (target: empty — respelled or refused at the chokepoint). `transients` are the ADJUDICATED bare-marker intermediates (single marker chars owned by completing-space/run-growth/following-text and the inline-mark openers) — pinned so a change in either direction is a conscious decision. Regenerate with UPDATE_KERNEL_TYPING_POLICY_SNAPSHOT=1.', restructures: restructureKeys, transients: transientKeys }
if (UPDATE) {
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n')
  console.log(`snapshot UPDATED (${restructureKeys.length} holes)`)
} else {
  let recorded
  try {
    recorded = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))
  } catch {
    assert.fail('no snapshot — run once with UPDATE_KERNEL_TYPING_POLICY_SNAPSHOT=1')
  }
  const known = new Set(recorded.restructures)
  const widened = restructureKeys.filter((key) => !known.has(key))
  const narrowed = recorded.restructures.filter((key) => !restructureKeys.includes(key))
  assert.deepEqual(widened, [],
    `typing-policy WIDENED — new silent restructurings: ${JSON.stringify(widened.slice(0, 10))}`)
  if (narrowed.length) {
    assert.fail(`typing-policy narrowed by ${narrowed.length} (reality improved) — regenerate the snapshot deliberately: ${JSON.stringify(narrowed.slice(0, 10))}`)
  }
  assert.deepEqual(transientKeys, recorded.transients || [],
    'the adjudicated marker-transient set changed — a machinery change (completing-space/run-growth/demote) must regenerate this deliberately')
}
console.log('kernel typing-policy matrix OK')
