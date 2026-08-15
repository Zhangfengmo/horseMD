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
  '- \n\n尾\n'
]
const KEYS = ['Enter', 'Tab', 'Shift-Tab', 'Backspace', 'Delete']
const INSERTS = ['x', '中', ' ', '\t', '*', '&']
const FORBIDDEN = /&#x20;|&nbsp;|<!--|​|﻿/

// Coverage instrumentation (attempted vs actually-applied per action label).
// Kept permanently (COVERAGE=1 env gate) rather than deleted after use, per
// review instruction — cheap, and useful the next time offset-selection bias
// needs re-checking.
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

const runSeed = (seed) => {
  const random = mulberry32(seed)
  const pick = (list) => list[Math.floor(random() * list.length)]
  let doc = createMarkdownDocument(pick(STARTERS))
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
    // 不变式:新源码可解析(parse 不抛)且语义 key 可计算
    markdownComparisonKey(applied.doc.text)
    history.record(applied, result.transaction)
    doc = applied.doc
    bump(stats.applied, action)
    journal.push({ step, action })
  }
  return doc.text
}

for (const seed of SEEDS) {
  const first = runSeed(seed)
  const second = runSeed(seed)
  assert.equal(first, second, `seed ${seed} must be deterministic`)
}

// 已归档的最小化失败序列全部回放
const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(here, 'fixtures', 'source-kernel')
for (const file of readdirSync(fixtureDir).filter((f) => f.endsWith('.json'))) {
  const spec = JSON.parse(readFileSync(join(fixtureDir, file), 'utf8'))
  process.env.SEED = String(spec.seed)
  process.env.STEPS = String(spec.steps)
  runSeed(spec.seed)
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

console.log(`PASS source-kernel state machine (${SEEDS.length} seeds x ${STEPS} steps)`)
