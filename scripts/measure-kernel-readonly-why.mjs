// Drill-down for measure-kernel-census.mjs: WHY is a block read-only?
//
// The census says 95% of the read-only surface is `paragraph:unproven` — a
// textblock that was paired with its mdast block but whose charMap the
// projection map refused to build. This probe prints the raw Markdown span and
// the PM node's text for each one so the actual shape is visible instead of
// inferred, and re-runs the map's own unit accounting to report the mismatch.
//
// Usage: node scripts/measure-kernel-readonly-why.mjs <file> [<file>...] [--limit N]
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { parseEditorMarkdown } from './lib/kernel-parse-harness.mjs'
import { buildProjectionMap } from '../src/renderer/src/components/editor-kernel-projection-map.js'
import { pairIsReadOnlyToUser } from '../src/renderer/src/lib/kernel-status.js'
import { isTypableTextblock } from '../src/renderer/src/components/editor-kernel-gateway.js'

const args = process.argv.slice(2)
const limitIdx = args.indexOf('--limit')
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 8
const files = args.filter((a, i) => !a.startsWith('--') && i !== limitIdx + 1)

const clip = (s, n = 220) => {
  const flat = String(s).replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/ /g, '⍽')
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}

for (const rel of files) {
  const path = resolve(rel)
  const raw = await readFile(path, 'utf8')
  const pmDoc = parseEditorMarkdown(raw)
  const map = buildProjectionMap(raw, pmDoc)
  console.log(`\n########## ${path}`)
  if (!map) {
    console.log('  MAP IS NULL -> whole tab degrades to legacy')
    continue
  }
  const pairs = map.blockPairs || []
  let shown = 0
  for (let i = 0; i < pairs.length && shown < limit; i += 1) {
    const pair = pairs[i]
    if (!pairIsReadOnlyToUser(pair, pairs[i + 1], isTypableTextblock)) continue
    shown += 1
    const node = pair.pmNode
    const type = node?.type?.name
    const md = pair.mdBlock
    const start = md?.position?.start?.offset
    const end = md?.position?.end?.offset
    const rawSpan = Number.isFinite(start) && Number.isFinite(end) ? raw.slice(start, end) : '(no mdast position)'
    let pmText = ''
    try {
      pmText = node?.textContent || ''
    } catch {
      pmText = '(unreadable)'
    }
    const typable = node?.isTextblock ? isTypableTextblock(node) : null
    console.log(`\n  [${shown}] ${type}  charMap=${pair.charMap ? 'yes' : 'NULL'}  isTypableTextblock=${typable}  mdType=${md?.type || 'none'}`)
    console.log(`      RAW : ${clip(rawSpan)}`)
    console.log(`      PM  : ${clip(pmText)}`)
    if (node?.isTextblock) {
      console.log(`      sizes: pm.content.size=${node.content.size}  rawSpan=${rawSpan.length}`)
      const marks = new Set()
      node.descendants?.((child) => {
        if (child.isText) child.marks.forEach((m) => marks.add(m.type.name))
        else marks.add(`<${child.type.name}>`)
      })
      console.log(`      inline: ${[...marks].join(', ') || '(plain text only)'}`)
    }
  }
  if (!shown) console.log('  (no read-only blocks)')
}
console.log()
