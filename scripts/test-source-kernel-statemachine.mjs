import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createMarkdownDocument, applySourceTransaction, buildSyntaxIndex, scanLines,
  buildCharacterMap, replaceVisibleText, toggleTaskMarker, routeStructuralKey,
  createSourceHistory
} from '../src/renderer/src/lib/source-kernel/index.js'
import { markdownComparisonKey } from '../src/renderer/src/lib/markdown-preservation/roundtrip.js'

// Division of labor (read this before trusting a green run to mean
// "every command is byte-exact correct"):
// - Byte-exact CORRECTNESS of any single command's edit offsets (e.g. "did
//   indentListItem pad exactly after the quote prefix, not mid-word") is
//   owned by the per-command unit suites (Tasks 4-8:
//   test-source-kernel-{commands,indent,history}.mjs). Those suites assert
//   exact expected strings for hand-picked inputs.
// - THIS harness is a crash/regression net over long random sequences. It
//   catches: uncaught exceptions, `invalid-range`/`stale-revision` escapes
//   from applySourceTransaction, forbidden-entity/sentinel introduction,
//   post-edit unparseable source, and undo/redo nondeterminism — things a
//   hand-picked unit test won't stumble into by construction. Its generic
//   "untouched-bytes" walk below re-derives applySourceTransaction's own
//   slice-and-concat over the SAME edits array the command produced, so it
//   is vacuous for validating that a command chose the RIGHT edit range: a
//   confidently-wrong offset (e.g. one that splits a word) passes it just
//   as cleanly as a correct one, because the walk never compares against
//   any independent expectation of where the edit "should" land. The one
//   exception is the indent/outdent line-shape check further down, which
//   compares against an actual independent invariant (line count + content
//   past the stripped prefix) and so CAN catch a torn-marker bug.
const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const SEEDS = process.env.SEED ? [Number(process.env.SEED)]
  : Array.from({ length: 12 }, (_, i) => i + 1)
const STEPS = Number(process.env.STEPS || 120)
const COVERAGE = process.env.COVERAGE === '1'

const STARTERS = [
  '# 头\n\n段落甲\n\n- 甲\n- [x] 乙\n  1. 丙\n',
  '> 引甲\n>\n> * 引乙\n',
  '甲\r\n\r\n1) 乙\r\n2) 丙\r\n',
  '- \n\n尾\n',
  // MIXED line endings (re-review, 2026-08-17). Every starter above is
  // uniform, so the harness could never reach the shape where a forward edit
  // CREATES a '\r\n' adjacency at its own boundary — the shape whose inverse
  // the CRLF chokepoint refused, freezing the whole undo stack. A mixed
  // document is not exotic: `buildCodeMap` maps a mixed-ending fenced block,
  // so it is reachable in the editor.
  '甲\r乙\n\n- \n\n尾\n'
]
const KEYS = ['Enter', 'Tab', 'Shift-Tab', 'Backspace', 'Delete']
const INSERTS = ['x', '中', ' ', '\t', '*', '&']
const FORBIDDEN = /&#x20;|&nbsp;|<!--|​|﻿/

// ---- line-ending invariants (re-review, 2026-08-17) -----------------------
// The harness had NO line-ending invariant at all, which is why the whole
// Critical-3 family (a raw-offset write splitting a '\r\n' into a lone CR and
// a bare LF) walked straight past 12 seeds x 120 steps.
//
// NON-VACUITY, re-verified at the COMMITTED budget (re-review round 2 found
// the first attempt vacuous: 12 seeds x 120 steps with a randomly DRAWN
// starter PASSED against the true pre-Critical-3 kernel, and only STEPS=400
// failed — a suite that passes both before and after the fix is worth
// nothing). The starter draw is gone (see the matrix at the bottom of this
// file), and both invariants were then re-run verbatim against real un-fixed
// kernels in scratch checkouts:
//
//  * uniformity — `git archive 0647df2 src` (the tree as it shipped BEFORE
//    Critical 3: no chokepoint, no router guard) + these scripts:
//      AssertionError: line endings stopped being uniform (seed 4 step 12 Enter):
//      {"crlf":4,"loneCr":1,"bareLf":1} in "甲\r\n\r\n1) 乙\r\n   2) 丙\r\r\n\n"
//  * inverse-appliability — the current tree with only the chokepoint's
//    `history-invert` exemption removed:
//      AssertionError: inverse not appliable (seed 1 step 19 Enter): invalid-range
//  * the published-set check below — deliberately negated (`published.has(text
//    + 'ZZ')`) to prove undos are actually reached:
//      AssertionError: undo produced a document the kernel never held (seed 1 step 18)
//
// The fixed kernel passes all 12 seeds x 5 starters for all three.
const endingProfile = (text) => ({
  crlf: (text.match(/\r\n/g) || []).length,
  loneCr: (text.match(/\r(?!\n)/g) || []).length,
  bareLf: (text.match(/(?<!\r)\n/g) || []).length
})
// "Uniform" = no lone CR anywhere, and not both spellings of a line break in
// the same document.
const isUniform = (profile) =>
  profile.loneCr === 0 && (profile.crlf === 0 || profile.bareLf === 0)

// Coverage instrumentation (attempted vs actually-applied per action label).
// Kept permanently (COVERAGE=1 env gate) rather than deleted after use, per
// review instruction — cheap, and useful the next time offset-selection bias
// needs re-checking.
// Final-review pin (plan-4 regression): the fuzz loop below (line ~156-160)
// tolerates ANY `!result.ok` refusal by design — most random offsets land
// somewhere legitimately unmappable (mid-escape, mid-entity, inside a
// mark's own delimiter run), so a bare "refusal happened" is not itself a
// signal. That same blanket tolerance previously hid a real bug: a
// zero-width insert exactly at a PLAIN paragraph's own block end
// (visFrom === visTo === map.visibleLength) used to refuse outright
// (`startBoundaries` has no entry past the last unit — see
// character-map.js's `rawRangeForVisibleRange`), which is exactly the shape
// kernel-mode Tab hits at the end of a line. Pin that this one shape must
// always SUCCEED, so a regression that reintroduces the block-end refusal
// fails loudly here instead of blending into "refusal is normal, fuzz
// continues".
{
  const src = '甲乙\n'
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  const block = index.blockAt(0)
  const map = buildCharacterMap(src, block.node)
  const r = replaceVisibleText({
    doc, map, visFrom: map.visibleLength, visTo: map.visibleLength, insert: 'x'
  })
  assert.equal(r.ok, true, 'zero-width insert at a plain paragraph block end must succeed')
  assert.equal(applySourceTransaction(doc, r.transaction).doc.text, '甲乙x\n')
}

const stats = { attempted: {}, applied: {} }
const bump = (bucket, action) => {
  if (!action) return
  bucket[action] = (bucket[action] || 0) + 1
}

// Structural boundary offsets rebuilt from the index each step: every
// block's start/end, every list item's contentStart, and every item's end.
// Pure random offsets rarely land exactly on these, which starves
// Backspace/Delete/Tab/Shift-Tab (they only fire at specific boundaries) —
// see routeStructuralKey. Blended 50/50 with uniform-random offsets below so
// we keep exercising "offset lands nowhere interesting -> not-structural"
// too, not just the boundary cases.
const collectInterestingOffsets = (index) => {
  const offsets = new Set([0, index.text.length])
  for (let at = 0; at <= index.text.length; at += 1) {
    const block = index.blockAt(at)
    if (block) {
      offsets.add(block.start)
      offsets.add(block.end)
    }
    const item = index.listItemAt(at)
    if (item) {
      offsets.add(item.contentStart)
      offsets.add(item.end)
    }
  }
  return Array.from(offsets)
}

const runSeed = (seed, starter) => {
  const random = mulberry32(seed)
  const pick = (list) => list[Math.floor(random() * list.length)]
  let doc = createMarkdownDocument(starter)
  // Every text this run has ever PUBLISHED (the starter plus every applied
  // result). An undo/redo may only ever land on a member of this set — that
  // is the whole claim behind the `history-invert` exemption to the CRLF
  // chokepoint ("an inverse can only restore a document the kernel already
  // held"), and until now nothing in this repo asserted it: the undo/redo
  // branch below checked `applied.ok` and `assertInverseAppliable` checked
  // the inverse of a FORWARD edit while discarding its result. The claim had
  // to be proven outside the repo, which is exactly where a claim goes stale.
  const published = new Set([starter])
  // A document that STARTED uniform must STAY uniform: no command may invent
  // a second line-ending spelling. (A mixed starter is exempt — there is no
  // uniformity to preserve; its job is the inverse-appliability check below.)
  const startedUniform = isUniform(endingProfile(starter))
  const assertEndings = (text, where) => {
    if (!startedUniform) return
    const profile = endingProfile(text)
    assert.ok(isUniform(profile),
      `line endings stopped being uniform (${where}): ${JSON.stringify(profile)} in ${JSON.stringify(text)}`)
  }
  // Every recorded inverse must be APPLIABLE against the document its forward
  // edit produced, and must restore that forward edit's input byte-for-byte.
  // A history whose inverse cannot be applied is a frozen undo stack — which
  // is exactly what the CRLF chokepoint caused for edits that created a
  // '\r\n' adjacency at their own boundary. Checked without consuming it (the
  // result is discarded; `doc` keeps moving forward).
  const assertInverseAppliable = (applied, before, where) => {
    const back = applySourceTransaction(applied.doc, applied.inverse)
    assert.equal(back.ok, true, `inverse not appliable (${where}): ${back.code}`)
    assert.equal(back.doc.text, before, `inverse did not restore the exact bytes (${where})`)
  }
  const history = createSourceHistory()
  const journal = []

  for (let step = 0; step < STEPS; step += 1) {
    const index = buildSyntaxIndex(doc.text)
    const useInteresting = random() < 0.5
    let offset
    if (useInteresting) {
      const pool = collectInterestingOffsets(index)
      offset = pool.length
        ? pool[Math.floor(random() * pool.length)]
        : Math.floor(random() * (doc.text.length + 1))
    } else {
      offset = Math.floor(random() * (doc.text.length + 1))
    }
    const kind = random()
    let result = null
    let action = null

    if (kind < 0.5) {
      action = pick(KEYS)
      bump(stats.attempted, action)
      result = routeStructuralKey(action, { doc, index, offset })
      if (result.code === 'not-structural') { result = null }
    } else if (kind < 0.8) {
      const block = index.blockAt(offset)
      if (block && (block.type === 'paragraph' || block.type === 'heading')) {
        const map = buildCharacterMap(doc.text, block.node)
        if (map && map.visibleLength >= 0) {
          const at = Math.floor(random() * (map.visibleLength + 1))
          action = 'insert'
          bump(stats.attempted, action)
          result = replaceVisibleText({ doc, map, visFrom: at, visTo: at, insert: pick(INSERTS) })
        }
      }
    } else if (kind < 0.9) {
      action = 'toggle-task'
      bump(stats.attempted, action)
      result = toggleTaskMarker({ doc, index, offset })
    } else {
      action = random() < 0.5 ? 'undo' : 'redo'
      bump(stats.attempted, action)
      const txn = action === 'undo' ? history.undo(doc) : history.redo(doc)
      if (txn) {
        const before = doc.text
        const applied = applySourceTransaction(doc, txn)
        assert.equal(applied.ok, true, `${action} must apply (seed ${seed} step ${step})`)
        // Same crash/forbidden-entity/parseability net as the main path below
        // (the untouched-bytes walk is skipped here — see the header comment,
        // it is vacuous for command correctness and undo/redo's edits are
        // history-derived, not from a command under test in this branch).
        if (!FORBIDDEN.test(before)) {
          assert.ok(!FORBIDDEN.test(applied.doc.text),
            `forbidden entity introduced by ${action} (seed ${seed} step ${step})`)
        }
        assertEndings(applied.doc.text, `seed ${seed} step ${step} ${action}`)
        // An undo/redo may only ever produce a document this run already
        // published (see `published` above).
        assert.ok(published.has(applied.doc.text),
          `${action} produced a document the kernel never held (seed ${seed} step ${step}): ${JSON.stringify(applied.doc.text)}`)
        markdownComparisonKey(applied.doc.text)
        doc = applied.doc
        bump(stats.applied, action)
        journal.push({ step, action })
      }
      continue
    }

    if (!result) continue
    if (!result.ok) {
      // 拒绝必须保留原文(引用同一字符串即未变)
      assert.ok(typeof result.code === 'string' && result.code.length > 0)
      continue
    }
    const before = doc.text
    const applied = applySourceTransaction(doc, result.transaction)
    assert.equal(applied.ok, true)
    // 不变式(document-layer only, see header comment):未触及字节逐字保持
    const edits = applied.edits
    let cursorBefore = 0, cursorAfter = 0
    for (const edit of edits) {
      const insert = String(edit.insert ?? '')
      assert.equal(applied.doc.text.slice(cursorAfter, cursorAfter + (edit.from - cursorBefore)),
        before.slice(cursorBefore, edit.from),
        `untouched prefix bytes changed (seed ${seed} step ${step} ${action})`)
      cursorAfter += (edit.from - cursorBefore) + insert.length
      cursorBefore = edit.to
    }
    assert.equal(applied.doc.text.slice(cursorAfter), before.slice(cursorBefore))
    // 独立结构不变式(与上面的字节 walk 不同源):indent/outdent 只允许改动
    // 每一行"引用/缩进前缀"字符类(`[ \t>]*`)之内的字符——行数不变，且每行
    // 剥离前导前缀后的剩余内容逐字相同。一个撕裂 marker 或落在词中间的
    // 错误偏移会在这里被发现（前缀之外多/少出的字符会让剥离后的内容不等）。
    if (result.transaction.intent === 'indent-list-item' || result.transaction.intent === 'outdent-list-item') {
      const beforeLines = scanLines(before)
      const afterLines = scanLines(applied.doc.text)
      assert.equal(afterLines.length, beforeLines.length,
        `${action} changed line count (seed ${seed} step ${step})`)
      const stripPrefix = (s) => s.replace(/^[ \t>]*/, '')
      for (let i = 0; i < beforeLines.length; i += 1) {
        assert.equal(stripPrefix(afterLines[i].text), stripPrefix(beforeLines[i].text),
          `${action} changed line ${i} content beyond its leading prefix (seed ${seed} step ${step})`)
      }
    }
    // 不变式:不产生禁止实体/哨兵(除非编辑前已存在)
    if (!FORBIDDEN.test(before)) {
      assert.ok(!FORBIDDEN.test(applied.doc.text),
        `forbidden entity introduced (seed ${seed} step ${step} ${action})`)
    }
    // 不变式:行终止符拼写不被凭空引入(见 endingProfile / isUniform)
    assertEndings(applied.doc.text, `seed ${seed} step ${step} ${action}`)
    // 不变式:每一条被记录的 inverse 都必须可应用，且逐字节还原编辑前的文本
    assertInverseAppliable(applied, before, `seed ${seed} step ${step} ${action}`)
    // 不变式:新源码可解析(parse 不抛)且语义 key 可计算
    markdownComparisonKey(applied.doc.text)
    history.record(applied, result.transaction)
    doc = applied.doc
    published.add(doc.text)
    bump(stats.applied, action)
    journal.push({ step, action })
  }
  return doc.text
}

// EVERY starter for EVERY seed (re-review round 2, finding A). The starter
// used to be drawn from the same RNG stream as the actions, so which document
// a seed exercised was a lottery — and the lottery is what made the line-ending
// invariant VACUOUS at the committed budget: run verbatim against the true
// pre-Critical-3 kernel (`git archive 0647df2 src` + these scripts), 12 seeds
// x 120 steps PASSED, because no seed drew the uniform-CRLF starter into a
// region where a structural command could bisect a '\r\n'. A suite that passes
// both before and after the fix is worth nothing, so the draw is gone: the
// matrix below runs all 5 starters under all 12 seeds, which makes the CRLF
// starter reachable under every seed instead of ~1 in 5. Verified against that
// same pre-C3 scratch copy — see the failure quoted in the invariant's own
// comment above.
for (const seed of SEEDS) {
  for (const starter of STARTERS) {
    const label = `seed ${seed} starter ${JSON.stringify(starter)}`
    const first = runSeed(seed, starter)
    const second = runSeed(seed, starter)
    assert.equal(first, second, `${label} must be deterministic`)
  }
}

// 已归档的最小化失败序列全部回放
const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(here, 'fixtures', 'source-kernel')
for (const file of readdirSync(fixtureDir).filter((f) => f.endsWith('.json'))) {
  const spec = JSON.parse(readFileSync(join(fixtureDir, file), 'utf8'))
  process.env.SEED = String(spec.seed)
  process.env.STEPS = String(spec.steps)
  // `starter` became an explicit parameter when the draw was removed (see the
  // matrix above). An archived spec may name one; older ones replay against
  // every starter, which is a superset of what they used to cover.
  if (spec.starter) runSeed(spec.seed, spec.starter)
  else for (const starter of STARTERS) runSeed(spec.seed, starter)
}

if (COVERAGE) {
  const actions = Array.from(new Set([...Object.keys(stats.attempted), ...Object.keys(stats.applied)])).sort()
  console.log('\naction        attempted   applied  applied%')
  for (const a of actions) {
    const att = stats.attempted[a] || 0
    const app = stats.applied[a] || 0
    const pct = att ? ((app / att) * 100).toFixed(1) : '0.0'
    console.log(`${a.padEnd(12)} ${String(att).padStart(9)} ${String(app).padStart(9)} ${pct.padStart(8)}%`)
  }
}

console.log(`PASS source-kernel state machine (${SEEDS.length} seeds x ${STARTERS.length} starters x ${STEPS} steps)`)
