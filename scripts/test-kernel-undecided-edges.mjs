// UNDECIDED-STATE x NEXT-KEY EDGE TABLE — the deductive completion of the
// typing-policy matrix (docs/typing-policy-chokepoint-adr.md 第二阶段 item ③:
// 「未决态×下一键」完备表进 typing-policy 矩阵——收编出边从归纳改演绎).
//
// THE STATES. The kernel's typing policy deliberately leaves some typed input
// in an UNDECIDED intermediate state whose final reading is adjudicated by the
// user's NEXT keystroke (the ADR's core ruling — same answer as CM6/Obsidian/
// Typora): a hand-typed ordered number kept literal as `4\.` (U1) / `4\)` (U2),
// and the bare empty item Enter leaves behind (U3). The adoption edges out of
// these states were added ONE USER REPORT AT A TIME (Space = the RENUMBER arm
// of spellMarkerCompletingSpace; Enter = splitListItem's NUMBER-ADOPTING
// branch), i.e. inductively. This suite enumerates EVERY next-key edge for
// EACH state through the kernel's own pure commands and PINS the complete
// table, so no edge is ever unspecified again.
//
// WHAT THIS SUITE ASSERTS — deliberately almost nothing:
//   1. every APPLIED outcome's resulting text must reparse without throwing
//      (buildSyntaxIndex — the only correctness guard here);
//   2. the full (state x ending x edge) -> outcome table must equal the
//      snapshot BYTE FOR BYTE, in EITHER direction. A change means the edge
//      table changed and must be re-baselined deliberately
//      (UPDATE_KERNEL_UNDECIDED_EDGES_SNAPSHOT=1).
// It does NOT assert what SHOULD happen on any edge — its job is to make the
// complete table VISIBLE and pinned, not to redesign it.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createMarkdownDocument,
  applySourceTransaction,
  buildSyntaxIndex,
  spellMarkerCompletingSpace,
  splitListItem,
  escapePolicyForInsert,
  routeStructuralKey
} from '../src/renderer/src/lib/source-kernel/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_PATH = join(here, 'fixtures', 'kernel-undecided-edges-snapshot.json')
const UPDATE = process.env.UPDATE_KERNEL_UNDECIDED_EDGES_SNAPSHOT === '1'

// The undecided base states. `caret` derives the raw offset from the kernel's
// own syntax index (never hardcoded, so LF and CRLF share one definition):
//   U1/U2 — caret at the END of item 2, whose entire content is the escaped
//           typed number (`4\.` / `4\)`) — the manual-number undecided state;
//   U3    — caret at item 2's CONTENT START, the bare empty item Enter leaves.
const STATES = [
  {
    id: 'U1-escaped-dot',
    md: '1. 甲\n2. 4\\.\n',
    empty: false,
    caret: (index, md) => index.listItemAt(md.indexOf('4')).end
  },
  {
    id: 'U2-escaped-paren',
    md: '1. 甲\n2. 4\\)\n',
    empty: false,
    caret: (index, md) => index.listItemAt(md.indexOf('4')).end
  },
  {
    id: 'U3-empty-item',
    md: '1. 甲\n2. \n',
    empty: true,
    caret: (index, md) => {
      const item = index.listItemAt(md.indexOf('2'))
      assert.ok(Number.isInteger(item?.contentStart), 'U3 item must expose contentStart')
      return item.contentStart
    }
  }
]

// One outcome string per (state x edge). Applied outcomes carry the resulting
// document text; refusals carry the named code; escape-policy answers are
// `literal` (null — the byte lands as-is) or the respelled resulting text.
const outcomeOf = (doc, result) => {
  if (!result?.ok) return `refused:${result?.code ?? 'unknown'}`
  const applied = applySourceTransaction(doc, result.transaction)
  if (!applied?.ok) return `apply-failed:${applied?.code ?? 'unknown'}`
  // SANITY GUARD: whatever the edge wrote must still be a parseable document.
  try {
    buildSyntaxIndex(applied.doc.text)
  } catch (error) {
    assert.fail(`applied outcome does not reparse: ${JSON.stringify(applied.doc.text)} (${error?.message})`)
  }
  return JSON.stringify(applied.doc.text)
}

const escapeOutcome = (md, offset, insert) => {
  const policy = escapePolicyForInsert({ text: md, offset, insert })
  if (policy === null) return 'literal'
  const candidate = md.slice(0, offset) + policy.insert + md.slice(offset)
  try {
    buildSyntaxIndex(candidate)
  } catch (error) {
    assert.fail(`respelled outcome does not reparse: ${JSON.stringify(candidate)} (${error?.message})`)
  }
  return `respell:${JSON.stringify(candidate)}`
}

const table = {}

for (const state of STATES) {
  for (const ending of ['\n', '\r\n']) {
    const md = ending === '\n' ? state.md : state.md.replace(/\n/g, '\r\n')
    const stateKey = `${state.id}${ending === '\n' ? '' : '#crlf'}`
    const index = buildSyntaxIndex(md)
    const offset = state.caret(index, md)
    const ctx = () => ({
      doc: createMarkdownDocument(md),
      index: buildSyntaxIndex(md),
      offset,
      empty: state.empty
    })

    // E-space: the marker-completing space (the RENUMBER / nested-completion arms).
    {
      const doc = createMarkdownDocument(md)
      table[`${stateKey}|E-space`] = outcomeOf(doc, spellMarkerCompletingSpace({ doc, offset }))
    }
    // E-enter (direct command): splitListItem — the NUMBER-ADOPTING branch's home.
    {
      const c = ctx()
      table[`${stateKey}|E-enter`] = outcomeOf(c.doc, splitListItem(c))
    }
    // E-enter (routed): what the structural router actually dispatches — for
    // U3 this is exitEmptyListItem, for U1/U2 the same splitListItem.
    {
      const c = ctx()
      table[`${stateKey}|E-enter-routed`] = outcomeOf(c.doc, routeStructuralKey('Enter', c))
    }
    // E-tab / E-backspace: through the router, exactly as keydown routes them.
    {
      const c = ctx()
      table[`${stateKey}|E-tab`] = outcomeOf(c.doc, routeStructuralKey('Tab', c))
    }
    {
      const c = ctx()
      table[`${stateKey}|E-backspace`] = outcomeOf(c.doc, routeStructuralKey('Backspace', c))
    }
    // E-char / E-digit: the typing policy's answer for an ordinary character
    // and for a digit continuing the literal number.
    table[`${stateKey}|E-char`] = escapeOutcome(md, offset, 'x')
    table[`${stateKey}|E-digit`] = escapeOutcome(md, offset, '5')
  }
}

const keys = Object.keys(table)
console.log('--- kernel undecided-state x next-key edge table ---')
for (const key of keys) console.log(`  ${key} -> ${table[key]}`)
console.log(`rows: ${keys.length} (${STATES.length} states x LF/CRLF x 7 edges)`)

const snapshot = {
  note: 'Undecided-state x next-key edge table (typing-policy ADR 第二阶段 ③). Outcomes are the CURRENT adjudications, pinned — a change in EITHER direction means an adoption/refusal edge changed and must be re-baselined deliberately with UPDATE_KERNEL_UNDECIDED_EDGES_SNAPSHOT=1.',
  edges: table
}
if (UPDATE) {
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n')
  console.log(`snapshot UPDATED (${keys.length} edges)`)
} else {
  let recorded
  try {
    recorded = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))
  } catch {
    assert.fail('no snapshot — run once with UPDATE_KERNEL_UNDECIDED_EDGES_SNAPSHOT=1')
  }
  const recordedEdges = recorded.edges || {}
  const diffs = []
  for (const key of new Set([...keys, ...Object.keys(recordedEdges)])) {
    const now = table[key]
    const was = recordedEdges[key]
    if (now !== was) diffs.push(`${key}: recorded ${JSON.stringify(was)} -> now ${JSON.stringify(now)}`)
  }
  assert.deepEqual(diffs, [],
    `the undecided-state edge table CHANGED — a next-key adjudication moved and must be re-baselined deliberately (UPDATE_KERNEL_UNDECIDED_EDGES_SNAPSHOT=1):\n${diffs.join('\n')}`)
}
console.log('kernel undecided-edges table OK')
