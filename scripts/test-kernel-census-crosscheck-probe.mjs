// EXPERIMENT D — cross-check the HEADLESS read-only census against the REAL app.
//
// `scripts/measure-kernel-census.mjs` is a REPLICA of the editor's parse chain.
// It reports, e.g., 52/92 read-only textblocks in CLAUDE.md. This probe asks two
// questions the replica cannot answer about itself:
//
//   1) does the RUNNING app's own status bar report the same count?
//   2) BEHAVIOURALLY — does typing actually get swallowed in the blocks the
//      census calls read-only, and does it actually land in the ones it calls
//      editable?
//
// Usage: node scripts/test-kernel-census-crosscheck-probe.mjs
import { mkdir, rm, copyFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { parseEditorMarkdown } from './lib/kernel-parse-harness.mjs'
import { buildProjectionMap } from '../src/renderer/src/components/editor-kernel-projection-map.js'
import { pairIsReadOnlyToUser } from '../src/renderer/src/lib/kernel-status.js'
import { isTypableTextblock } from '../src/renderer/src/components/editor-kernel-gateway.js'

const PORT = Number(process.env.CDP_PORT || 10761)
const ROOT = `/tmp/horsemd-census-crosscheck-${process.pid}`

const SOURCES = [
  ['CLAUDE.md', '/Users/fengmo/Developer/opensource/horseMD/CLAUDE.md'],
  ['pricelist.md', '/Users/fengmo/Downloads/灵影网关模型价格清单.md'],
  ['adr.md', '/Users/fengmo/Developer/opensource/horseMD/docs/typing-policy-chokepoint-adr.md'],
  ['design.md', '/Users/fengmo/Downloads/2026-08-14-source-authoritative-editor-kernel-design.md']
]

const MARKER_POOL = ['Ж', 'Щ', 'Ю', 'Я', 'Ф', 'Ц', 'Ч', 'Ш', 'Э', 'Ъ', 'Ы', 'Ь', 'Ђ', 'Љ', 'Њ', 'Ћ']

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`
// Markup characters are stripped on BOTH sides: focusing a block makes the
// source-caret feature reveal its `` ` ``/`**` syntax, which changes the DOM's
// textContent and would otherwise break the locator between two trials in the
// same block.
const norm = (s) => String(s).replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim()

async function waitFor(fn, message, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

// ---------------------------------------------------------------------------
// HEADLESS census (the claim under test)
// ---------------------------------------------------------------------------
function headlessCensus(raw) {
  const pmDoc = parseEditorMarkdown(raw)
  const map = buildProjectionMap(raw, pmDoc)
  if (!map) return { degraded: true }
  const pairs = map.blockPairs || []
  let readOnlyPairs = 0
  let textblocks = 0
  let readOnlyTextblocks = 0
  const entries = []
  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i]
    const node = pair?.pmNode
    const ro = pairIsReadOnlyToUser(pair, pairs[i + 1], isTypableTextblock)
    if (ro) readOnlyPairs += 1
    const isTb = !!node?.isTextblock && !pair.virtual
    if (!isTb) continue
    textblocks += 1
    if (ro) readOnlyTextblocks += 1
    const type = node.type.name
    if (type !== 'paragraph' && type !== 'heading') continue
    let text = ''
    try { text = node.textContent || '' } catch { text = '' }
    entries.push({
      index: entries.length,
      type,
      mdType: pair.mdBlock?.type || null,
      charMap: !!pair.charMap,
      readOnly: ro,
      text,
      normText: norm(text)
    })
  }
  return { degraded: false, readOnlyPairs, blocks: pairs.length, textblocks, readOnlyTextblocks, entries }
}

// ---------------------------------------------------------------------------
// Browser-side helpers (installed once per session)
// ---------------------------------------------------------------------------
const INSTALL_PROBE = `(() => {
  window.__probeToasts = []
  if (!window.__probeToastBound) {
    window.__probeToastBound = true
    window.addEventListener('hm:toast', (e) => {
      window.__probeToasts.push(typeof e.detail === 'string' ? e.detail : (e.detail?.msg ?? JSON.stringify(e.detail)))
    })
  }
  window.__probeNorm = (s) => String(s).replace(/[\`*_~]/g, '').replace(/\\s+/g, ' ').trim()
  window.__probeBlocks = () => {
    const editor = ${VISIBLE_EDITOR}
    if (!editor) return []
    return [...editor.querySelectorAll('p, h1, h2, h3, h4, h5, h6')]
      .filter((n) => !n.closest('.cm-editor') && !n.closest('.milkdown-slash-menu'))
  }
  window.__probeBlockTexts = () => window.__probeBlocks().map((n) => ({
    tag: n.tagName.toLowerCase(),
    text: n.textContent,
    normText: window.__probeNorm(n.textContent)
  }))
  return 1
})()`

// A raw DOM Range does NOT sync ProseMirror state; every caret placement is a
// real synthetic mouse click at a measured rect (repo CDP convention).
//
// The element is STAMPED here: focusing a block can change its textContent
// (the source-caret feature reveals `\`` / `**` markup at the caret), so the
// before/after read must hold the ELEMENT, not re-resolve it by text.
const rectForBlock = (normText, offsetRatio, emptyHeadingOrdinal = null) => `(() => {
  window.__probeTarget = null
  const want = ${JSON.stringify(normText)}
  const ordinal = ${emptyHeadingOrdinal === null ? 'null' : emptyHeadingOrdinal}
  let node = null
  if (ordinal !== null) {
    const empties = window.__probeBlocks()
      .filter((n) => /^h[1-6]$/.test(n.tagName.toLowerCase()) && window.__probeNorm(n.textContent) === '')
    if (!empties[ordinal]) return { error: 'empty-headings=' + empties.length }
    node = empties[ordinal]
  } else {
    const hits = window.__probeBlocks().filter((n) => window.__probeNorm(n.textContent) === want)
    if (hits.length !== 1) return { error: 'dom-matches=' + hits.length }
    node = hits[0]
  }
  // ProseMirror strips unknown attributes it did not render, so the handle is
  // kept as a live element REFERENCE, not a DOM attribute.
  window.__probeTarget = node
  node.scrollIntoView({ block: 'center' })
  const full = node.textContent
  if (!full.length) {
    const r = node.getBoundingClientRect()
    return { left: r.left + 2, top: r.top, height: r.height, empty: true }
  }
  // < 1 is a RATIO of the block's length; >= 1 is an ABSOLUTE character offset.
  const at = ${offsetRatio} >= 1
    ? Math.max(0, Math.min(full.length, Math.round(${offsetRatio})))
    : Math.max(1, Math.min(full.length - 1, Math.round(full.length * ${offsetRatio})))
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  let count = 0, target = null, targetOffset = 0, n
  while ((n = walker.nextNode())) {
    const len = n.textContent.length
    if (count + len >= at) { target = n; targetOffset = at - count; break }
    count += len
  }
  if (!target) return { error: 'no-text-node' }
  const range = document.createRange()
  range.setStart(target, targetOffset)
  range.setEnd(target, targetOffset)
  const rect = range.getBoundingClientRect()
  if (!rect || (!rect.height && !rect.width)) return { error: 'zero-rect' }
  return { left: rect.left, top: rect.top, height: rect.height || 16, at }
})()`

const TARGET_STATE = `(() => {
  const n = window.__probeTarget
  if (!n) return null
  return { tag: n.tagName.toLowerCase(), text: n.textContent, connected: n.isConnected }
})()`

const markerLanded = (marker) => `(() => {
  const hits = window.__probeBlocks().filter((n) => n.textContent.includes(${JSON.stringify(marker)}))
  return hits.map((n) => ({ tag: n.tagName.toLowerCase(), text: n.textContent.slice(0, 60) }))
})()`

const caretInfo = `(() => {
  const sel = window.getSelection()
  const node = sel?.anchorNode
  if (!node) return null
  const el = node.nodeType === 1 ? node : node.parentElement
  const block = el?.closest('p, h1, h2, h3, h4, h5, h6, li, th, td, pre')
  if (!block) return null
  const range = document.createRange()
  range.selectNodeContents(block)
  range.setEnd(sel.anchorNode, sel.anchorOffset)
  return { tag: block.tagName.toLowerCase(), text: block.textContent, caretOffset: range.toString().length }
})()`

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

// A REAL keydown (type: 'keyDown' + text), not Input.insertText — the house
// rule. The editable trials double as the calibration for this input path.
async function typeCharWithKeydown(send, ch) {
  const upper = ch.toUpperCase()
  const vk = /^[a-zA-Z]$/.test(ch) ? upper.charCodeAt(0) : 229
  const common = {
    key: ch,
    code: /^[a-zA-Z]$/.test(ch) ? `Key${upper}` : 'KeyQ',
    modifiers: 0,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk
  }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, ...common })
  await sleep(40)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(320)
}

// ---------------------------------------------------------------------------
// One document
// ---------------------------------------------------------------------------
async function runDocument(label, file, raw, census, report) {
  const profileDir = join(ROOT, `profile-${label.replace(/\W/g, '_')}`)
  let app = null
  try {
    app = await launchBuiltElectron({ profileDir, port: PORT, appArgs: [file], kernelDefault: true })
    const { evaluate, send } = app

    await waitFor(() => evaluate(`!!(${VISIBLE_EDITOR})`), `${label}: no rich editor mounted`)
    const kernelAttached = await evaluate(`!!document.querySelector('.hm-kernel-mode')`)
    report.kernelAttached = kernelAttached
    const diagnostics = JSON.parse(await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`))
    report.diagnostics = diagnostics.map((d) => d.event || d.reason || JSON.stringify(d)).slice(-20)
    report.attachUnmappable = JSON.stringify(diagnostics).includes('attach-unmappable')
    if (!kernelAttached) {
      report.error = 'kernel did NOT attach (.hm-kernel-mode absent) — this document ran LEGACY'
      return
    }
    await sleep(600)
    await evaluate(INSTALL_PROBE)

    // ---- 2) the app's OWN count, read out of the status bar ----------------
    const caretTitle = await waitFor(
      () => evaluate(`document.querySelector('.block-switch-caret-btn')?.title || null`),
      `${label}: kernel caret button never appeared`)
    report.statusTitle = caretTitle
    const m = /有\s*(\d+)\s*个块因源码无法被证明/.exec(caretTitle) ||
      /(\d+)\s*block\(s\) cannot be edited/.exec(caretTitle)
    report.appCount = m ? Number(m[1]) : (/所有能落光标的块|Every block you can put a cursor in/.test(caretTitle) ? 0 : null)
    report.statusDot = await evaluate(
      `document.querySelector('.kernel-status-dot')?.getAttribute('data-kernel-state') || null`)

    // ---- DOM/census alignment ---------------------------------------------
    const domBlocks = await evaluate(`JSON.stringify(window.__probeBlockTexts())`)
    const dom = JSON.parse(domBlocks)
    report.censusParaHeadingBlocks = census.entries.length
    report.domParaHeadingBlocks = dom.length

    const domCount = new Map()
    for (const b of dom) domCount.set(b.normText, (domCount.get(b.normText) || 0) + 1)
    const censusCount = new Map()
    for (const e of census.entries) censusCount.set(e.normText, (censusCount.get(e.normText) || 0) + 1)
    const usable = (e) => e.normText.length >= 3 && censusCount.get(e.normText) === 1 && domCount.get(e.normText) === 1

    // Empty read-only headings (design.md's two `#`-only lines) have no text to
    // match on, so they are addressed by their ordinal among empty headings.
    let emptyOrdinal = 0
    for (const e of census.entries) {
      if (e.type === 'heading' && e.normText === '') e.emptyHeadingOrdinal = emptyOrdinal++
    }
    const readOnlyTargets = census.entries
      .filter((e) => e.readOnly && (usable(e) || Number.isInteger(e.emptyHeadingOrdinal)))
      .slice(0, 5)
    const editableTargets = census.entries.filter((e) => !e.readOnly && usable(e))
    // Spread the editable picks across the document so they are not all in one
    // region (a local artefact would otherwise look like a global result).
    const spread = []
    if (editableTargets.length) {
      for (let i = 0; i < 5; i += 1) {
        const pick = editableTargets[Math.floor((i * editableTargets.length) / 5)]
        if (pick && !spread.includes(pick)) spread.push(pick)
      }
    }
    report.readOnlyTargetsFound = readOnlyTargets.length
    report.editableTargetsFound = spread.length

    // ---- 3) BEHAVIOURAL trials --------------------------------------------
    let markerIndex = 0
    const nextMarker = () => {
      while (markerIndex < MARKER_POOL.length && raw.includes(MARKER_POOL[markerIndex])) markerIndex += 1
      return MARKER_POOL[markerIndex++] || 'Ж'
    }

    const trials = []
    const doTrial = async (entry, expectation, offsetRatio = 0.5) => {
      const marker = nextMarker()
      const trial = {
        expectation,
        censusSays: entry.readOnly ? 'read-only' : 'editable',
        mdType: entry.mdType,
        charMap: entry.charMap,
        marker,
        offsetRatio,
        text: entry.text.length > 60 ? `${entry.text.slice(0, 60)}…` : entry.text
      }
      await evaluate(`(window.__probeToasts = [], 1)`)
      // Empty headings are consumed one per trial (typing makes one non-empty),
      // so the remaining ones are always addressed at ordinal 0.
      const rect = await evaluate(rectForBlock(
        entry.normText, offsetRatio, Number.isInteger(entry.emptyHeadingOrdinal) ? 0 : null))
      if (!rect || rect.error) {
        trial.outcome = `SKIPPED (${rect ? rect.error : 'no rect'})`
        trials.push(trial)
        return trial
      }
      await click(send, { x: rect.left, y: rect.top + Math.min(10, (rect.height || 16) / 2) })
      await sleep(250)
      trial.caret = await evaluate(caretInfo)
      const before = await evaluate(TARGET_STATE)
      trial.before = before && { tag: before.tag, text: before.text.slice(0, 70) }
      await typeCharWithKeydown(send, marker)
      const after = await evaluate(TARGET_STATE)
      trial.after = after && { tag: after.tag, text: after.text.slice(0, 70), connected: after.connected }
      trial.markerBlocks = await evaluate(markerLanded(marker))
      // THE discriminator. A vetoed keystroke still mutates the contenteditable
      // for an instant before ProseMirror redraws from state, and the redraw
      // REPLACES the element — so the captured handle can be a DETACHED node
      // still holding the transient character. Only a LIVE block in the visible
      // editor counts as "the character appeared".
      trial.appeared = (trial.markerBlocks || []).length > 0
      trial.domTransient = !trial.appeared && !!(after && after.text.includes(marker))
      trial.toasts = JSON.parse(await evaluate(`JSON.stringify(window.__probeToasts)`))
      trial.outcome = trial.appeared
        ? 'CHARACTER APPEARED (live in view)'
        : `SWALLOWED${trial.domTransient ? ' (transient DOM insert reverted by PM)' : ''}`
      trials.push(trial)
      return trial
    }

    // POSITIONAL mode: the census predicate is per BLOCK. These two CLAUDE.md
    // paragraphs are both census-EDITABLE, and the main run happened to refuse
    // in both of them — at a caret inside an `inlineCode` run and at offset 0 of
    // a `strong` run. This mode pins whether the refusal is positional (the
    // census then UNDER-counts the surface a writer cannot type in).
    if (process.env.PROBE_POSITIONS === '1') {
      const byPrefix = (p) => census.entries.find((e) => e.text.startsWith(p))
      const cases = [
        [byPrefix('Builds are unsigned'), 'inside inlineCode "xattr -dr …"', 130],
        [byPrefix('Builds are unsigned'), 'plain prose, offset 5', 5],
        [byPrefix('Cross-platform'), 'offset 0 = start of a strong run', 0],
        [byPrefix('Cross-platform'), 'plain prose after the strong run, offset 130', 130]
      ]
      const positional = []
      for (const [entry, why, at] of cases) {
        if (!entry) { positional.push({ why, outcome: 'SKIPPED (block not in census)' }); continue }
        const trial = await doTrial(entry, `positional: ${why}`, at)
        if (trial) { trial.positionalWhy = why; positional.push(trial) }
      }
      report.positional = positional
    } else {
      for (const entry of readOnlyTargets) await doTrial(entry, 'census: READ-ONLY -> expect swallowed')
      for (const entry of spread) {
        const first = await doTrial(entry, 'census: EDITABLE -> expect appears')
        // A census-editable block that refused may have refused because of WHERE
        // in the block the caret landed (an inline-code boundary, an atom) rather
        // than because the block is uneditable. One retry near the block start
        // separates those two explanations.
        if (first && first.appeared === false) {
          const retry = await doTrial(entry, 'census: EDITABLE -> RETRY near block start', 0.12)
          if (retry) retry.isRetry = true
        }
      }
    }
    report.trials = trials

    // ---- disk evidence -----------------------------------------------------
    await evaluate(`(window.confirm = () => true, 1)`)
    const hasFab = await evaluate(`!!document.querySelector('.hm-save-fab')`)
    report.saveFabPresent = hasFab
    if (hasFab) {
      await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
      try {
        await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not settle', 60)
        report.saved = true
      } catch (err) {
        report.saved = false
        report.saveError = err.message
      }
      const disk = await readFile(file, 'utf8')
      report.markersOnDisk = trials
        .filter((t) => disk.includes(t.marker))
        .map((t) => `${t.marker}(${t.censusSays})`)
      report.diskGrew = disk.length - raw.length
    }
    report.dialogs = app.dialogs.map((d) => d.message)
    report.finalDiagnostics = JSON.parse(await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-12))`))
      .map((d) => d.event || d.reason || JSON.stringify(d))
  } finally {
    if (app) {
      try { await app.evaluate(`(window.confirm = () => true, window.onbeforeunload = null, 1)`) } catch {}
      await stopBuiltElectron(app, { removeProfile: true })
    }
  }
}

async function run() {
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(ROOT, { recursive: true })
  const reports = []
  for (const [label, origin] of SOURCES) {
    const file = join(ROOT, label)
    await copyFile(origin, file)
    const raw = await readFile(file, 'utf8')
    const census = headlessCensus(raw)
    const report = {
      label,
      origin,
      bytes: Buffer.byteLength(raw),
      headless: census.degraded
        ? { degraded: true }
        : {
            readOnlyPairs: census.readOnlyPairs,
            blocks: census.blocks,
            readOnlyTextblocks: census.readOnlyTextblocks,
            textblocks: census.textblocks
          }
    }
    try {
      await runDocument(label, file, raw, census, report)
    } catch (err) {
      report.error = err.message
    }
    reports.push(report)
    console.log(`\n##### ${label}`)
    console.log(JSON.stringify(report, null, 2))
  }
  console.log('\n===== SUMMARY =====')
  console.log(JSON.stringify(reports.map((r) => ({
    label: r.label,
    headlessReadOnly: r.headless?.readOnlyPairs,
    appCount: r.appCount,
    kernelAttached: r.kernelAttached,
    readOnlyTrials: (r.trials || []).filter((t) => t.censusSays === 'read-only').map((t) => t.outcome),
    editableTrials: (r.trials || []).filter((t) => t.censusSays === 'editable').map((t) => t.outcome),
    dialogs: r.dialogs,
    error: r.error
  })), null, 2))
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
