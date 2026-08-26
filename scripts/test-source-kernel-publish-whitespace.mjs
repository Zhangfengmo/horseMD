// TDD evidence + regression lock for `resolveWhitespaceForPublish`
// (src/renderer/src/lib/source-kernel/commands/trailing-whitespace.js) — the
// ENDPOINT of the whitespace-placeholder mechanism.
//
// THE GAP THIS FILE PINS (D5). commands/trailing-whitespace.js writes U+00A0
// where CommonMark would strip an ASCII space/tab, records the real key in the
// document's session ledger, and heals the run back to real ASCII the moment
// another keystroke displaces it. Every intermediate state is therefore
// correct — but a run that is STILL OUTSTANDING when the document is published
// (save / export / scratch-draft persistence) never gets that next keystroke.
// Measured on the built app before this function existed:
//
//   paragraph end + Space -> save -> disk '# 标题甲\n\n末段。<U+00A0>\n'
//   paragraph end + Tab   -> save -> disk '末段。<U+00A0><U+00A0>\n'
//   Tab x3                -> save -> disk '末段。\t\t<U+00A0><U+00A0>\n'
//
// The save succeeded; the file simply held characters nobody typed.
//
// THE RESOLUTION, and its two halves:
//   * a BLOCK-TRAILING run is DROPPED — CommonMark deletes the ASCII it stands
//     for, so the bytes that faithfully spell those keystrokes are NO bytes.
//   * a LINE-START run is KEPT — there the U+00A0 is durable, visible
//     indentation (it round-trips and renders), which is what the keystroke
//     asked for; dropping it would silently discard it.
// Nothing is decided by construction: every drop is proven by reparsing THREE
// documents (see the function's own ADR).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  resolveWhitespaceForPublish,
  spellBlockTailInsert,
  NO_BREAK_SPACE
} from '../src/renderer/src/lib/source-kernel/commands/trailing-whitespace.js'
import { spellLineStartWhitespace } from '../src/renderer/src/lib/source-kernel/commands/line-start-whitespace.js'
import { applySourceTransaction, createMarkdownDocument } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { parseKernelMarkdown } from '../src/renderer/src/lib/source-kernel/syntax-index.js'

const NBSP = NO_BREAK_SPACE

const blocksOf = (text) => {
  const out = []
  const walk = (node) => {
    if (node.type !== 'root') out.push(node)
    for (const child of node.children || []) walk(child)
  }
  walk(parseKernelMarkdown(text))
  return out
}
const blockAt = (text, type, startOffset) =>
  blocksOf(text).find((node) =>
    node.type === type && node.position?.start?.offset === startOffset) || null

// Drive the REAL commands so every ledger entry below is one this kernel
// actually wrote — a hand-written `whitespaceMarks` array would prove nothing
// about provenance, which is the whole gate.
const typeTail = (doc, { type, start }, offset, insert, heal = null) => {
  const result = spellBlockTailInsert({ doc, block: blockAt(doc.text, type, start), offset, insert, heal })
  assert.ok(result.ok, `spellBlockTailInsert refused: ${result.code}`)
  const applied = applySourceTransaction(doc, result.transaction)
  assert.ok(applied.ok, `applySourceTransaction refused: ${applied.code}`)
  return applied.doc
}

// ===========================================================================
// 1) THE REPORTED CASE. A Space typed last at a paragraph end.
// ===========================================================================
{
  const opened = createMarkdownDocument('# 标题甲\n\n末段。\n')
  const typed = typeTail(opened, { type: 'paragraph', start: 7 }, 10, ' ')
  assert.equal(typed.text, '# 标题甲\n\n末段。' + NBSP + '\n',
    'the placeholder mechanism itself must be unchanged')
  assert.deepEqual(typed.whitespaceMarks, [{ from: 10, to: 11, ascii: ' ' }],
    'the ledger records the run and the key it stands for')

  const published = resolveWhitespaceForPublish(typed)
  assert.equal(published.text, '# 标题甲\n\n末段。\n',
    'a Space still outstanding at the publish boundary must reach the file as NOTHING')
  assert.deepEqual(published.drops, [{ from: 10, to: 11 }])
  // THE DOCUMENT IS NOT TOUCHED — the caret, the view and the heal all still
  // own the placeholder.
  assert.equal(typed.text, '# 标题甲\n\n末段。' + NBSP + '\n')
  assert.deepEqual(typed.whitespaceMarks, [{ from: 10, to: 11, ascii: ' ' }])

  // IDEMPOTENCE: publishing the published bytes is the identity.
  const again = resolveWhitespaceForPublish(createMarkdownDocument(published.text))
  assert.equal(again.text, published.text)
  assert.deepEqual(again.drops, [])
}

// ===========================================================================
// 2) A Tab (two U+00A0), and the Tab-x3 shape where the HEAL has already left
//    real tabs in front of the outstanding run. Publishing must leave neither
//    — CommonMark deletes the whole trailing run, so a literal tab left there
//    is exactly the dead byte this kernel refuses to write.
// ===========================================================================
{
  const opened = createMarkdownDocument('末段。\n')
  const one = typeTail(opened, { type: 'paragraph', start: 0 }, 3, '\t')
  assert.equal(one.text, '末段。' + NBSP + NBSP + '\n')
  assert.equal(resolveWhitespaceForPublish(one).text, '末段。\n',
    'a Tab typed last must reach the file as NOTHING')

  // Tab, Tab, Tab — each new keystroke heals the previous run to a real tab.
  const two = typeTail(one, { type: 'paragraph', start: 0 }, 5, '\t',
    { rawStart: 3, rawEnd: 5, ascii: '\t' })
  assert.equal(two.text, '末段。\t' + NBSP + NBSP + '\n')
  const three = typeTail(two, { type: 'paragraph', start: 0 }, 6, '\t',
    { rawStart: 4, rawEnd: 6, ascii: '\t' })
  assert.equal(three.text, '末段。\t\t' + NBSP + NBSP + '\n',
    'the accumulation stays bounded: two real tabs plus ONE outstanding run')

  const published = resolveWhitespaceForPublish(three)
  assert.equal(published.text, '末段。\n',
    'three Tabs at a block end must reach the file as NOTHING — no U+00A0, no dead tabs')
  assert.deepEqual(published.drops, [{ from: 3, to: 7 }])
}

// ===========================================================================
// 3) THE NEGATIVE CONTROL. A U+00A0 the DOCUMENT already had — byte-identical
//    to what the kernel writes, distinguishable only by provenance — is never
//    touched, at either position.
// ===========================================================================
{
  const authored = createMarkdownDocument(`作者${NBSP}手写${NBSP}\n\n${NBSP}行首。\n`)
  const published = resolveWhitespaceForPublish(authored)
  assert.equal(published.text, authored.text,
    'an unledgered U+00A0 must survive a publish byte-for-byte')
  assert.deepEqual(published.drops, [])

  // …even when the kernel has written its OWN run right next to an authored
  // one, in the same block: only the ledgered byte goes.
  const typed = typeTail(authored, { type: 'paragraph', start: 0 }, 6, ' ')
  assert.equal(typed.text, `作者${NBSP}手写${NBSP}${NBSP}\n\n${NBSP}行首。\n`)
  const mixed = resolveWhitespaceForPublish(typed)
  assert.equal(mixed.text, `作者${NBSP}手写${NBSP}\n\n${NBSP}行首。\n`,
    'exactly one U+00A0 — the ledgered one — is dropped')
}

// ===========================================================================
// 4) THE LINE-START DECISION. A run at a content line's start is durable,
//    visible indentation; it is KEPT even though it is ledgered.
//
//    TWO SPELLINGS, DELIBERATELY (2026-08-26, correction M4). `dropRunForPublish`
//    refuses a line-start run through TWO independent proofs, and a TAB fixture
//    alone lets each one alibi the other:
//      * the BLOCK-END guard (`text.slice(mark.to, blockEnd)` must be ASCII
//        whitespace) — a run with content after it is not a trailing run;
//      * `treesIdentical(candidateTree, literalTree)` — dropping the run must
//        mean what the ASCII the user typed means.
//    A line-start TAB is caught by BOTH (its literal `\t行首段。` reparses as an
//    INDENTED CODE BLOCK, so the trees differ), so deleting either one on its
//    own left this suite green. A line-start SPACE is caught by the block-end
//    guard ALONE: ` 行首段。` and `行首段。` are the same paragraph to CommonMark,
//    so the tree proof passes and only the block-end guard stands between the
//    user's indentation and a silent deletion. Measured, both mutations run
//    against this file:
//      delete the block-end guard  -> 4a FAILS (` 行首段。` published as `行首段。`)
//      delete `treesIdentical`     -> nothing fails; see 4c.
// ===========================================================================
// 4a) SPACE — the shape that gates the BLOCK-END guard, and nothing else does.
{
  const opened = createMarkdownDocument('行首段。\n')
  const result = spellLineStartWhitespace({
    doc: opened, block: blockAt(opened.text, 'paragraph', 0), offset: 0, insert: ' '
  })
  assert.ok(result.ok, `spellLineStartWhitespace refused: ${result.code}`)
  const indented = applySourceTransaction(opened, result.transaction).doc
  assert.equal(indented.text, NBSP + '行首段。\n')
  assert.deepEqual(indented.whitespaceMarks, [{ from: 0, to: 1, ascii: ' ' }])

  const published = resolveWhitespaceForPublish(indented)
  assert.equal(published.text, NBSP + '行首段。\n',
    'a line-start SPACE is durable indentation and must be KEPT — the tree proof ' +
    'cannot see this one (` 行首段。` parses exactly like `行首段。`), so the ' +
    'block-end guard is the only thing holding it')
  assert.deepEqual(published.drops, [])
}

// 4b) TAB — the same decision, reached through the tree proof as well.
{
  const opened = createMarkdownDocument('行首段。\n')
  const result = spellLineStartWhitespace({
    doc: opened, block: blockAt(opened.text, 'paragraph', 0), offset: 0, insert: '\t'
  })
  assert.ok(result.ok, `spellLineStartWhitespace refused: ${result.code}`)
  const indented = applySourceTransaction(opened, result.transaction).doc
  assert.equal(indented.text, NBSP + NBSP + '行首段。\n')
  assert.deepEqual(indented.whitespaceMarks, [{ from: 0, to: 2, ascii: '\t' }])

  const published = resolveWhitespaceForPublish(indented)
  assert.equal(published.text, indented.text,
    'a LINE-START run is durable indentation and must be KEPT')
  assert.deepEqual(published.drops, [])
}

// ===========================================================================
// 5) FAIL-CLOSED SHAPES. A run that cannot be dropped provably stays.
// ===========================================================================
{
  // 5a) A paragraph whose ENTIRE content is the run: dropping it would delete
  //     a block (the file's only spelling of a deliberately blank paragraph).
  const spacer = { text: NBSP + '\n', revision: 1, whitespaceMarks: [{ from: 0, to: 1, ascii: ' ' }] }
  assert.equal(resolveWhitespaceForPublish(spacer).text, spacer.text,
    'dropping the run would remove the block — refused')

  // 5b) A task item whose whole label is the run: `- [ ] ` demotes to a
  //     literal-bracket bullet on reload, so the U+00A0 is doing real work.
  const task = {
    text: '- [ ] ' + NBSP + '\n',
    revision: 1,
    whitespaceMarks: [{ from: 6, to: 7, ascii: ' ' }]
  }
  assert.equal(resolveWhitespaceForPublish(task).text, task.text,
    'the run keeps the checkbox alive — dropping it would demote the task item')

  // 5c) The task SEED (`ascii: ''`, commands/task-seed.js) stands for NO
  //     keystroke and may only ever be dissolved by the first label character.
  const seeded = {
    text: '- [ ] ' + NBSP + '\n',
    revision: 1,
    whitespaceMarks: [{ from: 6, to: 7, ascii: '' }]
  }
  assert.equal(resolveWhitespaceForPublish(seeded).text, seeded.text,
    'a task seed is not a whitespace keystroke and is never published away')

  // 5d) A stale/forged descriptor over bytes that are NOT a U+00A0 run.
  const forged = { text: '末段。\n', revision: 1, whitespaceMarks: [{ from: 0, to: 3, ascii: ' ' }] }
  assert.equal(resolveWhitespaceForPublish(forged).text, forged.text,
    'a ledger entry that does not describe a U+00A0 run claims nothing')

  // 5e) Inside a fenced code block the trailing whitespace is CONTENT.
  const fenced = {
    text: '```js\nlet a = 1' + NBSP + '\n```\n',
    revision: 1,
    whitespaceMarks: [{ from: 15, to: 16, ascii: ' ' }]
  }
  assert.equal(resolveWhitespaceForPublish(fenced).text, fenced.text,
    'a verbatim block is never republished')
}

// ===========================================================================
// 6) A TABLE CELL's trailing run: GFM strips the padding, so the same drop
//    applies — and the table must still be a table afterwards.
// ===========================================================================
{
  const opened = createMarkdownDocument('| 甲 | 乙 |\n| --- | --- |\n| 丙 | 丁 |\n')
  const cell = blocksOf(opened.text).find((node) => node.type === 'tableCell')
  const typed = typeTail(opened, { type: 'tableCell', start: cell.position.start.offset },
    cell.position.start.offset + 3, ' ')
  assert.ok(typed.text.includes('甲' + NBSP), `expected a spelled cell tail: ${JSON.stringify(typed.text)}`)
  const published = resolveWhitespaceForPublish(typed)
  assert.equal(published.text, opened.text,
    "a cell's trailing run publishes away, leaving the original table bytes")
}

// ===========================================================================
// 7) SEVERAL outstanding runs in one document, resolved together.
// ===========================================================================
{
  const opened = createMarkdownDocument('甲段。\n\n乙段。\n')
  const first = typeTail(opened, { type: 'paragraph', start: 0 }, 3, ' ')
  const second = typeTail(first, { type: 'paragraph', start: 6 }, 9, '\t')
  assert.equal(second.text, '甲段。' + NBSP + '\n\n乙段。' + NBSP + NBSP + '\n')
  assert.equal(second.whitespaceMarks.length, 2)
  assert.equal(resolveWhitespaceForPublish(second).text, '甲段。\n\n乙段。\n',
    'every outstanding run resolves, right to left')
}

// ===========================================================================
// 8) THE REDUNDANT PROOF, PINNED STRUCTURALLY — and why it can only be pinned
//    that way. `treesIdentical` cannot be gated by any fixture: deleting it
//    alone changes NO published output, measured over 146 shapes produced by
//    driving the real commands over 20 documents AND 2 862 forged ledger
//    shapes over 44 CommonMark-sensitive bodies (0 differences in both). That
//    is not luck — given the block-end guard, the run's literal ASCII sits at
//    a `paragraph`/`heading`/`tableCell` trailing edge, where CommonMark
//    strips it, so the literal tree and the candidate tree are equal by
//    construction. It is DEFENCE IN DEPTH, and it stops being redundant the
//    moment either sibling weakens: with the block-end guard deleted it alone
//    saves 712 of those shapes, with `differsByOneWhitespaceRemoval` deleted,
//    9. So a behavioural fixture cannot notice its deletion and this check is
//    the only thing that can. If a refactor renames it, re-derive the
//    redundancy above before touching this assertion.
{
  const source = readFileSync(new URL(
    '../src/renderer/src/lib/source-kernel/commands/trailing-whitespace.js', import.meta.url), 'utf8')
  const from = source.indexOf('const dropRunForPublish')
  const to = source.indexOf('export function resolveWhitespaceForPublish')
  assert.ok(from > 0 && to > from, 'dropRunForPublish is no longer where this pin looks for it')
  const body = source.slice(from, to)
  for (const proof of [
    ['the block-end guard', 'text.slice(mark.to, blockEnd)'],
    ['the literal-equivalence proof', 'treesIdentical(candidateTree, literalTree)'],
    ['the one-whitespace-removal proof', 'differsByOneWhitespaceRemoval(tree, candidateTree)']
  ]) {
    assert.ok(body.includes(proof[1]),
      `${proof[0]} is gone from dropRunForPublish — a publish may drop bytes it has not proven dead`)
  }
}

console.log('PASS source-kernel publish whitespace: an outstanding block-trailing run reaches the file as nothing, a line-start run is kept, an authored U+00A0 is never touched, and the document itself is left alone')
