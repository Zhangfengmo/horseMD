import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createMarkdownDocument, applySourceTransaction, buildSyntaxIndex,
  buildCharacterMap, replaceVisibleText, toggleTaskMarker, routeStructuralKey,
  createSourceHistory
} from '../src/renderer/src/lib/source-kernel/index.js'
import { markdownComparisonKey } from '../src/renderer/src/lib/markdown-preservation/roundtrip.js'

// 确定性 PRNG（仓库无属性测试先例，自带 mulberry32）
const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const SEEDS = process.env.SEED ? [Number(process.env.SEED)]
  : Array.from({ length: 12 }, (_, i) => i + 1)
const STEPS = Number(process.env.STEPS || 120)

const STARTERS = [
  '# 头\n\n段落甲\n\n- 甲\n- [x] 乙\n  1. 丙\n',
  '> 引甲\n>\n> * 引乙\n',
  '甲\r\n\r\n1) 乙\r\n2) 丙\r\n',
  '- \n\n尾\n'
]
const KEYS = ['Enter', 'Tab', 'Shift-Tab', 'Backspace', 'Delete']
const INSERTS = ['x', '中', ' ', '\t', '*', '&']
const FORBIDDEN = /&#x20;|&nbsp;|<!--|​|﻿/

const runSeed = (seed) => {
  const random = mulberry32(seed)
  const pick = (list) => list[Math.floor(random() * list.length)]
  let doc = createMarkdownDocument(pick(STARTERS))
  const history = createSourceHistory()
  const journal = []

  for (let step = 0; step < STEPS; step += 1) {
    const index = buildSyntaxIndex(doc.text)
    const offset = Math.floor(random() * (doc.text.length + 1))
    const kind = random()
    let result = null
    let action = null

    if (kind < 0.5) {
      action = pick(KEYS)
      result = routeStructuralKey(action, { doc, index, offset })
      if (result.code === 'not-structural') { result = null }
    } else if (kind < 0.8) {
      const block = index.blockAt(offset)
      if (block && (block.type === 'paragraph' || block.type === 'heading')) {
        const map = buildCharacterMap(doc.text, block.node)
        if (map && map.visibleLength >= 0) {
          const at = Math.floor(random() * (map.visibleLength + 1))
          action = 'insert'
          result = replaceVisibleText({ doc, map, visFrom: at, visTo: at, insert: pick(INSERTS) })
        }
      }
    } else if (kind < 0.9) {
      action = 'toggle-task'
      result = toggleTaskMarker({ doc, index, offset })
    } else {
      action = random() < 0.5 ? 'undo' : 'redo'
      const txn = action === 'undo' ? history.undo(doc) : history.redo(doc)
      if (txn) {
        const applied = applySourceTransaction(doc, txn)
        assert.equal(applied.ok, true, `${action} must apply (seed ${seed} step ${step})`)
        doc = applied.doc
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
    // 不变式:未触及字节逐字保持
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
    // 不变式:不产生禁止实体/哨兵(除非编辑前已存在)
    if (!FORBIDDEN.test(before)) {
      assert.ok(!FORBIDDEN.test(applied.doc.text),
        `forbidden entity introduced (seed ${seed} step ${step} ${action})`)
    }
    // 不变式:新源码可解析(parse 不抛)且语义 key 可计算
    markdownComparisonKey(applied.doc.text)
    history.record(applied, result.transaction)
    doc = applied.doc
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

console.log(`PASS source-kernel state machine (${SEEDS.length} seeds x ${STEPS} steps)`)
