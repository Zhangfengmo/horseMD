// KERNEL MODE ABOVE CHUNK_THRESHOLD, in the real app (2026-08-21).
//
// scripts/test-kernel-chunk-attach.mjs proves the repair headless, against the
// real editor parse chain but a stub view. This is the half a stub cannot
// state: a >120 000-char document opened in the BUILT app, streamed in by the
// real `appendChunks`, repaired inside the real loader's read-only window,
// attached, typed into, saved, and reopened cold.
//
// WHY A GENERATED DOCUMENT AND NOT A REPOSITORY ONE. The suite needs a
// document that (a) crosses CHUNK_THRESHOLD, (b) actually STRADDLES a chunk
// boundary with a shape the two parses disagree on, and (c) stays under
// `isHeavyDoc`'s 400 000-char ceiling (past that the tab opens in the plain
// textarea and there is no rich editor to attach to at all). No file in this
// repository satisfies all three, and concatenating docs/ until one did would
// make the fixture rot on the next documentation edit. So the corpus is the
// deterministic, seeded generator in scripts/lib/kernel-corpus.mjs — the same
// one the headless suite and the perf assessment use — with `chunkTraps`,
// which plants a loose bullet list across every 40 KB boundary. That is the
// canonical disagreement measured on this repo's own docs/, reproduced on
// purpose rather than hoped for.
//
// NON-VACUITY. Step 2 asserts a `chunk-repair` diagnostic with a NON-ZERO
// region count before anything else: if the fixture ever stopped disagreeing,
// this suite would fail loudly instead of passing for the wrong reason. At
// 31afc69 (no repair) step 2 fails the other way — `attach-unmappable`, the
// status dot reads `legacy`, and every editing step below is unreachable.
//
// REAL-APP COST. The repair + attach is a one-time cost paid at the end of
// the load, and the brief that commissioned it set a 1.5 s ceiling at 400 KB
// before it would have to be moved off the load path. It is measured here
// with the browser's own long-task observer (the same instrument
// .superpowers/kernel-performance-assessment.md §1.3 uses) and printed; the
// assertion is a generous ceiling, because a CI machine's absolute numbers
// are not the product claim — the printed value is what a human reads.
import assert from 'node:assert/strict'
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'
import { makeCorpus, toCrlf } from './lib/kernel-corpus.mjs'
import { parseKernelMarkdown } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { CHUNK_THRESHOLD } from '../src/renderer/src/components/editor-chunked-parse.js'

const root = `/tmp/horsemd-kernel-chunk-attach-${process.pid}`
const port = Number(process.env.CDP_PORT || 10150)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)
const CRLF = process.env.KERNEL_CHUNK_CRLF === '1'
// The one-time repair+attach ceiling, in ms of main-thread blocking. Generous
// on purpose (see the header): the number that matters is the one printed.
const COST_CEILING_MS = Number(process.env.KERNEL_CHUNK_COST_CEILING || 4000)

const FATAL_DIAGNOSTICS = [
  'attach-unmappable',
  'chunk-repair-failed',
  'projection-repair-failed',
  'projection-parse-failure',
  'map-refresh-failed',
  'replace-reconcile-failed',
  'structural-parse-failure'
]

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`

async function waitFor(fn, message, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const splice = (text, from, to, insert) => text.slice(0, from) + insert + text.slice(to)

// A paragraph whose RAW bytes are exactly its visible text and whose text
// occurs once in the document — so a DOM lookup by textContent is unambiguous
// and the byte expectation is a plain splice. (Same rule as the real-document
// campaign; restated rather than imported because that suite keeps it
// private.)
//
// The character blacklist is not belt-and-braces: `parseKernelMarkdown` is the
// kernel's RAW parse and does not run the app's `==highlight==` transform, so
// a paragraph containing `==x==` looks like one plain text node to the mdast
// check while the editor renders a `<mark>` — the DOM lookup by textContent
// then never matches and the suite fails with a mystery. Rejecting the
// markdown-significant characters outright makes "plain" mean the same thing
// on both sides.
const DECORATED = /[=$<>[\]`*_\\~|!]/
function plainParagraphs(text) {
  const tree = parseKernelMarkdown(text)
  const out = []
  for (const node of tree.children || []) {
    if (node.type !== 'paragraph') continue
    const inline = node.children || []
    if (!inline.length || inline.some((child) => child.type !== 'text')) continue
    const value = inline.map((child) => child.value).join('')
    if (value.includes('\n') || value.length < 14 || value.length > 70) continue
    if (DECORATED.test(value)) continue
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue
    if (text.slice(start, end) !== value) continue
    if (text.split(value).length !== 2) continue
    out.push({ value, start, end })
  }
  return out
}

const diagnostics = async (evaluate) =>
  JSON.parse(await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`))
const toasts = async (evaluate) => JSON.parse(await evaluate(`JSON.stringify(window.__chunkToasts || [])`))
const resetProbes = (evaluate) => evaluate(`(window.__chunkToasts = [], window.__hmKernelDiagnostics = [], 1)`)

// `finishInitial` (Editor.jsx) sets this only after the chunk stream, the
// repair and the attach have all completed — it IS the "load finished" edge.
const loaded = (evaluate) => evaluate(`!!(${VISIBLE_EDITOR})?.dataset.horsemdReady`)

async function toggleSourceMode(evaluate) {
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => node.offsetParent && !node.classList.contains('block-switch-caret-btn') &&
        /源码|Source|富文本|Rich|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
    button?.click()
    return !!button
  })()`)
  assert.ok(clicked, 'no source-toggle trigger button')
}

async function readSource(evaluate, label) {
  await toggleSourceMode(evaluate)
  const shown = await waitFor(() => evaluate(`(
    [...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)?.value ?? null
  )`), `source view did not appear (${label})`)
  await toggleSourceMode(evaluate)
  await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), `rich view did not return (${label})`)
  await sleep(200)
  return shown
}

async function clickKernelToggle(evaluate) {
  const opened = await evaluate(`(() => {
    const button = document.querySelector('.block-switch-caret-btn')
    button?.click()
    return !!button
  })()`)
  assert.ok(opened, 'no kernel-mode caret button — tab not kernel-eligible?')
  await sleep(200)
  const clicked = await evaluate(`(() => {
    const item = [...document.querySelectorAll('.block-switch-menu .block-menu-item')].find((n) => n.offsetParent)
    item?.click()
    return !!item
  })()`)
  assert.ok(clicked, 'kernel-toggle menu item missing')
}

async function charRect(evaluate, blockText, offset) {
  return evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p') || [])]
      .find((n) => n.textContent === ${JSON.stringify(blockText)})
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    let count = 0
    let target = null, targetOffset = 0
    let n
    while ((n = walker.nextNode())) {
      const len = n.textContent.length
      if (count + len >= ${offset}) { target = n; targetOffset = ${offset} - count; break }
      count += len
    }
    if (!target) return null
    const range = document.createRange()
    range.setStart(target, targetOffset)
    range.setEnd(target, targetOffset)
    const rect = range.getBoundingClientRect()
    return rect ? { left: rect.left, top: rect.top, height: rect.height } : null
  })()`)
}

// Click AT a character offset inside a block, with a real mouse event (a raw
// DOM selection does not sync ProseMirror state).
//
// RETRIED, and that is not flake-papering: a 200 KB document scrolls under
// `content-visibility`, so `scrollIntoView` inside the measurement can be
// followed by a reflow that moves the block before the click lands. The
// success condition is exact — the caret must be in THAT block at THAT offset
// — so a retry can only ever turn a mis-landed click into a correct one, and
// exhausting the retries still fails.
async function clickCharOffset(evaluate, send, blockText, offset) {
  let last = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rect = await waitFor(() => charRect(evaluate, blockText, offset),
      `could not locate offset ${offset} in ${JSON.stringify(blockText.slice(0, 30))}…`, 60)
    await sleep(250)
    const point = { x: rect.left, y: rect.top + Math.min(10, rect.height / 2) }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    await sleep(250)
    last = await caretBlock(evaluate)
    if (last && last.text === blockText && last.caretOffset === offset) return
  }
  assert.fail(`the caret never landed at offset ${offset} of the target paragraph ` +
    `(last: ${JSON.stringify(last)})`)
}

const caretBlock = (evaluate) => evaluate(`(() => {
  const sel = window.getSelection()
  const node = sel?.anchorNode
  if (!node) return null
  const el = node.nodeType === 1 ? node : node.parentElement
  const block = el?.closest('p, h1, h2, h3, h4, h5, h6, li, th, td, pre')
  if (!block) return null
  const range = document.createRange()
  range.selectNodeContents(block)
  range.setEnd(sel.anchorNode, sel.anchorOffset)
  return { text: block.textContent, caretOffset: range.toString().length }
})()`)

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const file = join(root, 'chunked.md')
  const base = makeCorpus(200000, 42, { chunkTraps: true })
  const original = CRLF ? toCrlf(base) : base
  assert.ok(original.length > CHUNK_THRESHOLD,
    `fixture must cross CHUNK_THRESHOLD (${original.length})`)
  assert.ok(original.length < 400000,
    'fixture must stay under isHeavyDoc\'s 400 000-char ceiling, or the tab opens as plain text')
  await writeFile(file, original, 'utf8')

  let expected = original
  let app = null
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    const { evaluate, send } = app
    await evaluate(`(() => {
      window.__chunkToasts = []
      window.addEventListener('hm:toast', (e) => window.__chunkToasts.push(e.detail?.msg ?? String(e.detail)))
      return 1
    })()`)

    // ---- 1) THE TOGGLE MUST WAIT FOR THE LOAD ---------------------------
    // Before this change, toggling the kernel mid-load serialized whatever
    // part of the document had streamed in and committed THAT as the tab's
    // content — the remount then landed on a truncated file. The toggle now
    // refuses while the tab is still loading, and the refusal is named.
    //
    // The window is real but short, so the probe is conditional: it asserts
    // only when it genuinely caught the tab mid-load, and says so either way.
    // A machine fast enough to finish a 200 KB chunk load before the first
    // CDP round trip is not a machine this assertion can speak about.
    {
      const midLoad = !(await loaded(evaluate))
      if (midLoad) {
        await clickKernelToggle(evaluate)
        await sleep(200)
        const raised = await toasts(evaluate)
        assert.ok(raised.some((message) => /载入|loading/i.test(message)),
          `a mid-load kernel toggle must refuse with a named message, got ${JSON.stringify(raised)}`)
        console.log('  [toggle] mid-load toggle refused, as it must')
      } else {
        console.log('  [toggle] the load had already finished — mid-load probe skipped')
      }
    }

    await waitFor(() => loaded(evaluate), 'the chunked document never finished loading', 400)
    const mountedText = await evaluate(`(${VISIBLE_EDITOR})?.textContent?.length ?? 0`)
    assert.ok(mountedText > 100000,
      `the whole document must be in the editor after the load (${mountedText} chars rendered)`)
    await resetProbes(evaluate)

    // ---- 2) ENABLE THE KERNEL: repair, then attach -----------------------
    // The toggle remounts the tab, so the load (and this time the repair)
    // runs again with kernel mode on — which is exactly the path a user
    // takes. A long-task observer is installed first so the one-time cost is
    // measured rather than asserted about.
    await evaluate(`(() => {
      window.__chunkTasks = []
      window.__chunkObs?.disconnect()
      window.__chunkObs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__chunkTasks.push(Math.round(entry.duration))
      })
      window.__chunkObs.observe({ entryTypes: ['longtask'] })
      return 1
    })()`)
    // Tag the CURRENT editor before toggling. The remount leaves the old
    // ProseMirror in the DOM for a while — and it already carries
    // `data-horsemd-ready` — so waiting on the readiness flag alone returns
    // instantly against the OLD editor and every assertion below then reads
    // the pre-toggle tab. (Measured: the `chunk-repair` diagnostic lands
    // ~600 ms after the click, long after the naive wait resolves.)
    await evaluate(`(() => {
      for (const node of document.querySelectorAll('.ProseMirror')) node.dataset.chunkOld = '1'
      return 1
    })()`)
    await clickKernelToggle(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await waitFor(() => evaluate(`!!(
      [...document.querySelectorAll('.ProseMirror:not([data-chunk-old])')]
        .find((node) => node.offsetParent)?.dataset.horsemdReady
    )`), 'the kernel-mode reload never finished', 400)
    // Wait for the attach OUTCOME, not for a clock. `data-horsemd-ready` is
    // set by `finishInitial`, and on this machine the repair diagnostic still
    // lands a few hundred ms later; a fixed sleep is a race. The wait accepts
    // EITHER outcome — success, a failed repair, or a refused attach — so a
    // regression that degrades the tab still terminates it promptly and is
    // then reported by the assertions below, rather than being waited out.
    const OUTCOMES = ['chunk-repair', 'chunk-repair-failed', 'attach-unmappable']
    await waitFor(async () => (await diagnostics(evaluate)).some((entry) => OUTCOMES.includes(entry.type)),
      'the kernel never reported an attach outcome for the chunk-loaded document', 200)
    await sleep(300)

    const attachDiagnostics = await diagnostics(evaluate)
    const fatal = attachDiagnostics.filter((entry) => FATAL_DIAGNOSTICS.includes(entry.type))
    assert.deepEqual(fatal, [],
      `kernel mode refused a chunk-loaded document: ${JSON.stringify(fatal)}`)

    // NON-VACUITY: the repair really had something to repair.
    const repair = attachDiagnostics.find((entry) => entry.type === 'chunk-repair')
    assert.ok(repair, 'no chunk-repair diagnostic — was the document chunked at all? ' +
      `diagnostics=${JSON.stringify(attachDiagnostics.slice(0, 6))} toasts=${JSON.stringify(await toasts(evaluate))}`)
    assert.ok(repair.regions > 0,
      'the fixture must genuinely disagree between its chunked and whole-document parses ' +
      '(regions === 0 would make every assertion below vacuous)')
    console.log(`  [repair] ${repair.regions} region(s), ${repair.touched} of ${repair.size} positions ` +
      `(${((repair.touched / repair.size) * 100).toFixed(2)}%)`)

    // The persistent indicator, read POSITIVELY rather than from an absence:
    // the dot renders only for `legacy` and `partial` (describeKernelStatus's
    // `indicator` flag), so "no dot" alone would also be what a StatusBar
    // that stopped reporting anything looks like. The caret button's title
    // carries the label in every state.
    const reported = JSON.parse(await evaluate(`(() => {
      const dot = document.querySelector('.kernel-status-dot')
      return JSON.stringify({
        dot: dot ? (dot.dataset.kernelState ?? '') : null,
        title: document.querySelector('.block-switch-caret-btn')?.title ?? ''
      })
    })()`))
    console.log(`  [status] dot=${reported.dot ?? 'none'} — ${reported.title.split('\n')[0]}`)
    assert.notEqual(reported.dot, 'legacy', 'the status indicator must not report a legacy fallback')
    assert.equal(reported.dot, null,
      'every block the user can reach must be writable in this fixture (a `partial` dot here is a real regression)')
    assert.ok(/源码内核已生效|Source kernel active/.test(reported.title),
      `the status must positively report an active kernel, got ${JSON.stringify(reported.title)}`)

    // THE ONE-TIME COST, measured where it is paid. The long-task trace below
    // covers the WHOLE reload (Crepe create + every chunk parse + DOM), so it
    // cannot be the claim; the two diagnostics carry the repair's and the
    // attach's own wall clock, recorded inside the controller.
    const attach = attachDiagnostics.find((entry) => entry.type === 'chunk-attach')
    assert.ok(attach, 'a successful chunked attach must report its cost')
    const tasks = JSON.parse(await evaluate(`JSON.stringify(window.__chunkTasks || [])`))
    const worst = tasks.length ? Math.max(...tasks) : 0
    const total = tasks.reduce((sum, value) => sum + value, 0)
    console.log(`  [cost] ${original.length} chars: repair ${repair.ms} ms + attach ${attach.ms} ms ` +
      `= ${repair.ms + attach.ms} ms one-time; whole reload blocked ${total} ms across ` +
      `${tasks.length} long tasks (longest ${worst} ms)`)
    assert.ok(repair.ms + attach.ms < COST_CEILING_MS,
      `the one-time repair+attach cost must stay under ${COST_CEILING_MS} ms ` +
      `(measured repair ${repair.ms} + attach ${attach.ms})`)
    await resetProbes(evaluate)

    // ---- 3) EDIT AT START / MIDDLE / END --------------------------------
    // Three paragraphs spread across the document — deliberately including
    // one AFTER the last chunk boundary, because a repair that mis-sized a
    // region would leave every later raw offset shifted, and only an edit
    // past it can show that.
    const candidates = plainParagraphs(expected)
    assert.ok(candidates.length >= 3, `fixture must offer three unique plain paragraphs (${candidates.length})`)
    // END FIRST, then middle, then start. Every raw offset was resolved
    // against the ORIGINAL bytes, and editing back to front keeps the ones
    // still to come valid — re-deriving them after each edit would be a
    // second answer to "which paragraph" and could silently drift.
    const picks = [
      ['end', candidates[candidates.length - 2]],
      ['middle', candidates[Math.floor(candidates.length / 2)]],
      ['start', candidates[1]]
    ]
    for (const [where, target] of picks) {
      const at = where === 'start' ? 0 : (where === 'middle' ? Math.floor(target.value.length / 2) : target.value.length)
      await clickCharOffset(evaluate, send, target.value, at)
      const typed = where === 'start' ? '甲' : (where === 'middle' ? '乙' : '丙')
      await typeTextLikeUser(send, typed, { delayMs: delay })
      await sleep(500)

      const entries = await diagnostics(evaluate)
      const bad = entries.filter((entry) => FATAL_DIAGNOSTICS.includes(entry.type))
      assert.deepEqual(bad, [], `${where}: fatal diagnostics ${JSON.stringify(bad)}`)
      assert.deepEqual(entries.filter((entry) => entry.type === 'projection-mismatch'), [],
        `${where}: the view and the bytes must not diverge`)
      assert.deepEqual(await toasts(evaluate), [], `${where}: a landed keystroke must raise no toast`)

      expected = splice(expected, target.start + at, target.start + at, typed)
      // A textarea's `.value` normalizes line breaks to LF, so the source view
      // can never prove a CRLF document (the established convention in every
      // CRLF kernel suite — see test-kernel-blockinsert-ui.mjs). Here it
      // proves the CONTENT; the disk bytes at the end prove the endings.
      const shown = expected.replace(/\r\n/g, '\n')
      const source = await readSource(evaluate, `type at ${where}`)
      if (source !== shown) {
        const diverge = [...shown].findIndex((ch, i) => source[i] !== ch)
        console.error(`  ${where}: first difference at ${diverge}`)
        console.error('    actual  :', JSON.stringify(source.slice(Math.max(0, diverge - 60), diverge + 60)))
        console.error('    expected:', JSON.stringify(shown.slice(Math.max(0, diverge - 60), diverge + 60)))
      }
      assert.equal(source.length, shown.length, `${where}: the document length must change by exactly one character`)
      assert.equal(source, shown, `${where}: the bytes must be exact`)
      await resetProbes(evaluate)
    }

    // ---- 4) SAVE + COLD REOPEN ------------------------------------------
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    const disk = await readFile(file, 'utf8')
    assert.equal(disk, expected, 'the saved bytes must be exactly the expectation')
    if (CRLF) {
      assert.equal(/(?<!\r)\n/.test(disk), false, 'a CRLF document must not gain a lone LF anywhere')
    }
    assert.equal(app.dialogs.length, 0,
      `no dialog may appear: ${JSON.stringify(app.dialogs.map((d) => d.message))}`)

    await stopBuiltElectron(app, { removeProfile: false })
    app = null
    app = await launchBuiltElectron({ profileDir: join(root, 'profile-reopen'), port, appArgs: [file] })
    await waitFor(() => loaded(app.evaluate), 'the saved document did not finish loading on cold relaunch', 400)
    assert.equal(await readFile(file, 'utf8'), expected, 'a cold reopen must not rewrite the file')
    assert.equal(app.dialogs.length, 0, 'no dialog on cold relaunch')

    console.log(`PASS kernel chunk attach UI (${CRLF ? 'CRLF' : 'LF'}): a ${original.length}-char document ` +
      'streamed in by the chunked loader, repaired to its whole-document parse, attached with a normal ' +
      'status, edited at start/middle/end with exact bytes, saved and reopened cold')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
