// EXPERIMENT A — does the 200 ms debounced verify move the user's caret/viewport?
//
// Mechanism under test (editor-kernel-mode.js):
//   scheduleVerify(caretRaw)  -> setTimeout(runScheduledVerify, VERIFY_DEBOUNCE_MS = 200)
//   runScheduledVerify()      -> verifyPlainTextProjection(view.state.doc, pendingVerifyCaret)
//   verifyPlainTextProjection -> if the reparse of kernel.doc.text DIFFERS from the live
//                                PM doc: pushKernelDiagnostic('projection-mismatch') and, in a
//                                microtask, reconcileProjection({ decorateTransaction: tr => {
//                                  tr.setSelection(TextSelection.near(resolve(caretPos), 1))
//                                  tr.scrollIntoView()
//                                }})
// So: the caret/viewport can only be yanked when a projection MISMATCH is detected inside
// the debounce window. This probe measures whether that happens in practice.
//
// NOT a regression suite — a measurement probe. It prints counts and never asserts on them.
import { mkdir, rm, copyFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const SOURCE = '/Users/fengmo/Downloads/2026-08-14-source-authoritative-editor-kernel-design.md'
const root = `/tmp/horsemd-caret-stability-${process.pid}`
const file = join(root, 'probe.md')
const port = Number(process.env.CDP_PORT || 10741)
const TRIALS = Number(process.env.PROBE_TRIALS || 20)

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`
const SCROLLER = `(${VISIBLE_EDITOR})?.closest('.editor-scroll')`

async function waitFor(fn, message, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const STATE = `(() => {
  const editor = ${VISIBLE_EDITOR}
  const scroller = ${SCROLLER}
  const sel = window.getSelection()
  const node = sel && sel.anchorNode
  const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null
  const block = el && el.closest ? el.closest('p,h1,h2,h3,h4,h5,h6,li,th,td,pre,blockquote') : null
  let topIndex = -1
  if (block && editor) {
    const kids = [...editor.children]
    const top = kids.find((c) => c === block || c.contains(block))
    topIndex = top ? kids.indexOf(top) : -1
  }
  let caretOffset = -1
  if (block && node) {
    try {
      const r = document.createRange()
      r.selectNodeContents(block)
      r.setEnd(node, sel.anchorOffset)
      caretOffset = r.toString().length
    } catch (e) { caretOffset = -2 }
  }
  return {
    scrollTop: scroller ? Math.round(scroller.scrollTop) : -1,
    topIndex,
    blockText: (block ? block.textContent : '').slice(0, 24),
    caretOffset,
    diagCount: (window.__hmKernelDiagnostics || []).length
  }
})()`

const state = (evaluate) => evaluate(STATE)

async function diagSince(evaluate, from) {
  const raw = await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(${from}))`)
  try { return JSON.parse(raw) } catch { return [] }
}

async function click(send, x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x, y })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x, y })
}

// Scroll so child #index is centred, then hand back a click point inside it.
// ONE round trip, so the post-keystroke latency stays as small as possible.
const scrollAndRect = (evaluate, index) => evaluate(`(() => {
  const editor = ${VISIBLE_EDITOR}
  const scroller = ${SCROLLER}
  const el = editor && editor.children[${index}]
  if (!el || !scroller) return null
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left + 24), y: Math.round(r.top + Math.min(10, r.height / 2)),
           scrollTop: Math.round(scroller.scrollTop), text: el.textContent.slice(0, 24) }
})()`)

const scrollTo = (evaluate, top) => evaluate(`(() => {
  const s = ${SCROLLER}
  if (!s) return -1
  s.scrollTop = ${top}
  return Math.round(s.scrollTop)
})()`)

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await copyFile(SOURCE, file)
  const original = await readFile(file, 'utf8')

  let app
  const report = { fast: [], control: [], wheel: [], diagnostics: [] }
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
    const { evaluate, send } = app

    await waitFor(async () => {
      const t = await evaluate(`(${VISIBLE_EDITOR})?.textContent`)
      return t && t.includes('源码权威编辑器内核设计') ? t : null
    }, 'document did not mount')

    await evaluate(`(window.confirm = () => true, 1)`)

    // ---- kernel attach assertion (MANDATORY) -------------------------------
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel did not attach')
    await sleep(600)
    const attachDiag = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    console.log('ATTACH DIAGNOSTICS:', attachDiag)
    const degraded = attachDiag.includes('attach-unmappable')
    console.log('DEGRADED TO LEGACY:', degraded)
    const hasCv = await evaluate(`!!document.querySelector('.editor-scroll.hm-cv')`)
    const childCount = await evaluate(`(${VISIBLE_EDITOR})?.children.length`)
    const scrollHeight = await evaluate(`(() => { const s = ${SCROLLER}; return s ? Math.round(s.scrollHeight) : -1 })()`)
    console.log('BLOCKS:', childCount, ' scrollHeight:', scrollHeight, ' hm-cv:', hasCv)

    // Pick a plain paragraph near the TOP and one 30+ blocks BELOW.
    const picks = await evaluate(`(() => {
      const editor = ${VISIBLE_EDITOR}
      const kids = [...editor.children]
      const plain = kids.map((el, i) => ({ i, tag: el.tagName.toLowerCase(), len: el.textContent.length, text: el.textContent.slice(0, 20) }))
        .filter((b) => b.tag === 'p' && b.len > 6)
      const near = plain.find((b) => b.i < 12) || plain[0]
      const far = plain.filter((b) => near && b.i >= near.i + 30).slice(-1)[0] || plain[plain.length - 1]
      return { near, far, total: kids.length }
    })()`)
    console.log('PICKS:', JSON.stringify(picks))
    const NEAR = picks.near.i
    const FAR = picks.far.i

    // =======================================================================
    // 1) FAST: keystroke, then click 30+ blocks below INSIDE the 200 ms window
    // 2) CONTROL: same, but 500 ms after the keystroke (verify already fired)
    // =======================================================================
    async function trial(kind, gapMs) {
      // reset viewport + caret at the top paragraph
      await scrollTo(evaluate, 0)
      await sleep(120)
      const nearRect = await scrollAndRect(evaluate, NEAR)
      await click(send, nearRect.x, nearRect.y)
      await sleep(250)
      const before = await state(evaluate)
      const diagFrom = before.diagCount

      await typeTextLikeUser(send, 'x', { delayMs: 0 })
      const t0 = Date.now()
      if (gapMs) await sleep(gapMs)
      const farRect = await scrollAndRect(evaluate, FAR)
      const t1 = Date.now()
      await click(send, farRect.x, farRect.y)
      const t2 = Date.now()
      const afterClick = await state(evaluate)
      await sleep(900)
      const settled = await state(evaluate)
      const diags = await diagSince(evaluate, diagFrom)

      const moved = settled.topIndex !== afterClick.topIndex ||
        Math.abs(settled.scrollTop - afterClick.scrollTop) > 20
      const row = {
        kind,
        elapsedToScrollMs: t1 - t0,
        elapsedToClickMs: t2 - t0,
        before: { topIndex: before.topIndex, scrollTop: before.scrollTop },
        afterClick: { topIndex: afterClick.topIndex, scrollTop: afterClick.scrollTop, block: afterClick.blockText },
        settled: { topIndex: settled.topIndex, scrollTop: settled.scrollTop, block: settled.blockText },
        moved,
        diags: diags.map((d) => d && d.type).filter(Boolean)
      }
      if (diags.length) report.diagnostics.push({ kind, diags })
      return row
    }

    for (let i = 0; i < TRIALS; i += 1) {
      const row = await trial('fast', 0)
      report.fast.push(row)
      console.log(`  [fast ${i + 1}/${TRIALS}]`, JSON.stringify(row))
    }
    for (let i = 0; i < TRIALS; i += 1) {
      const row = await trial('control', 500)
      report.control.push(row)
      console.log(`  [control ${i + 1}/${TRIALS}]`, JSON.stringify(row))
    }

    // =======================================================================
    // 3) WHEEL: keystroke then an immediate real wheel scroll — reset within 1s?
    // =======================================================================
    for (let i = 0; i < 6; i += 1) {
      await scrollTo(evaluate, 0)
      await sleep(120)
      const nearRect = await scrollAndRect(evaluate, NEAR)
      await click(send, nearRect.x, nearRect.y)
      await sleep(250)
      const before = await state(evaluate)
      const diagFrom = before.diagCount
      await typeTextLikeUser(send, 'y', { delayMs: 0 })
      const t0 = Date.now()
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: nearRect.x, y: nearRect.y + 40, deltaX: 0, deltaY: 900
      })
      const t1 = Date.now()
      await sleep(60)
      const afterWheel = await state(evaluate)
      await sleep(1100)
      const settled = await state(evaluate)
      const diags = await diagSince(evaluate, diagFrom)
      const row = {
        elapsedToWheelMs: t1 - t0,
        afterWheel: { scrollTop: afterWheel.scrollTop, topIndex: afterWheel.topIndex },
        settled: { scrollTop: settled.scrollTop, topIndex: settled.topIndex },
        reset: Math.abs(settled.scrollTop - afterWheel.scrollTop) > 20,
        diags: diags.map((d) => d && d.type).filter(Boolean)
      }
      report.wheel.push(row)
      console.log(`  [wheel ${i + 1}/6]`, JSON.stringify(row))
      if (diags.length) report.diagnostics.push({ kind: 'wheel', diags })
    }

    // =======================================================================
    // 4) FORCED MISMATCH: the recorded bare-marker family. A lone `*` on an
    //    empty line reparses to an EMPTY BULLET ITEM, so the verify's diff is
    //    non-null and the caret-restoring reconcile (setSelection +
    //    scrollIntoView) is guaranteed to run. This is the mechanism's own
    //    worst case — if the viewport does not jump here, it never does.
    // =======================================================================
    const forced = []
    for (let i = 0; i < 5; i += 1) {
      // Put the caret at the END of the near paragraph and press Enter (real
      // keydown) to open a fresh EMPTY paragraph, then type the bare marker.
      await scrollTo(evaluate, 0)
      await sleep(120)
      const nearRect = await scrollAndRect(evaluate, NEAR)
      await click(send, nearRect.x, nearRect.y)
      await sleep(200)
      await pressKey(send, { key: 'End', code: 'End' })
      await pressKey(send, { key: 'Enter', code: 'Enter' })
      await sleep(350)
      const before = await state(evaluate)
      const diagFrom = before.diagCount
      await typeTextLikeUser(send, '*', { delayMs: 0 })
      const t0 = Date.now()
      const farRect = await scrollAndRect(evaluate, FAR)
      const t1 = Date.now()
      await click(send, farRect.x, farRect.y)
      const afterClick = await state(evaluate)
      await sleep(900)
      const settled = await state(evaluate)
      const diags = await diagSince(evaluate, diagFrom)
      const row = {
        elapsedToScrollMs: t1 - t0,
        afterClick: { topIndex: afterClick.topIndex, scrollTop: afterClick.scrollTop, block: afterClick.blockText },
        settled: { topIndex: settled.topIndex, scrollTop: settled.scrollTop, block: settled.blockText },
        moved: settled.topIndex !== afterClick.topIndex || Math.abs(settled.scrollTop - afterClick.scrollTop) > 20,
        diags: diags.map((d) => d && d.type).filter(Boolean)
      }
      forced.push(row)
      console.log(`  [forced-mismatch ${i + 1}/5]`, JSON.stringify(row))
      if (diags.length) report.diagnostics.push({ kind: 'forced', diags })
    }
    report.forced = forced

    // ---- summary -----------------------------------------------------------
    const count = (rows) => rows.filter((r) => r.moved).length
    const summary = {
      degraded,
      blocks: childCount,
      nearBlock: NEAR,
      farBlock: FAR,
      fastMoved: `${count(report.fast)}/${report.fast.length}`,
      controlMoved: `${count(report.control)}/${report.control.length}`,
      wheelReset: `${report.wheel.filter((r) => r.reset).length}/${report.wheel.length}`,
      forcedMoved: `${count(forced)}/${forced.length}`,
      fastLatencyMs: report.fast.map((r) => r.elapsedToScrollMs),
      allDiagnosticTypes: [...new Set(report.diagnostics.flatMap((d) => d.diags.map((x) => x.type)))],
      dialogs: app.dialogs.map((d) => d.message)
    }
    console.log('SUMMARY', JSON.stringify(summary, null, 2))
    const finalDiag = await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-40))`)
    console.log('LAST 40 DIAGNOSTICS:', finalDiag)
    console.log('DIALOGS:', JSON.stringify(app.dialogs.map((d) => d.message)))
    console.log('FILE UNCHANGED ON DISK:', (await readFile(file, 'utf8')) === original)
  } finally {
    if (app) {
      try { await app.evaluate(`(window.confirm = () => true, 1)`) } catch {}
    }
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error('PROBE ERROR:', error)
  process.exit(1)
})
