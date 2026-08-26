// D5 — WHAT REACHES THE FILE when a Space or Tab is the LAST thing typed.
//
// THE DEFECT (measured by scripts/test-kernel-whitespace-disk-probe.mjs on the
// built app, real keydowns, kernel mode):
//
//   paragraph end + Space -> save -> disk "# 标题甲\n\n末段。<U+00A0>\n"
//   paragraph end + Tab   -> save -> disk "末段。<U+00A0><U+00A0>\n"
//   Tab x3                -> save -> disk "末段。\t\t<U+00A0><U+00A0>\n"
//
// The save SUCCEEDS — no dialog, no toast, `roundTrips:true`. The file simply
// contains characters the user never typed, and nothing ever tells them.
//
// WHY THE KERNEL WRITES U+00A0 (commands/trailing-whitespace.js): whitespace
// CommonMark would STRIP has no byte spelling that survives a reparse, so the
// kernel writes U+00A0 and records the real key in a session-scoped provenance
// ledger; the NEXT whitespace/character keystroke resolves the run back to real
// ASCII. That mechanism is correct and bounded. The gap is the ENDPOINT: a run
// that is still outstanding when the document is PUBLISHED (save / export /
// scratch-draft persistence) never resolves, and reaches disk as U+00A0.
//
// WHAT THIS LOCKS. The publish boundary resolves an outstanding BLOCK-TRAILING
// run by DROPPING it (`resolveWhitespaceForPublish`, proven per run — see that
// function's ADR), so:
//   * the file holds exactly the bytes the keystrokes mean (nothing);
//   * the DOCUMENT is untouched — the space stays visible, the caret does not
//     move, and typing on after a save still produces `a b`;
//   * an authored U+00A0 (one the kernel never wrote) is never touched;
//   * a LINE-START run is KEPT — there the character is durable, visible
//     indentation and dropping it would discard what the user asked for.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const NBSP = ' '
const root = `/tmp/horsemd-kernel-publish-ws-${process.pid}`
const file = join(root, 'publish.md')
const port = Number(process.env.CDP_PORT || 10881)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

// `作者<NBSP>手写<NBSP>` is the NEGATIVE CONTROL: two U+00A0 that came from the
// FILE. The ledger never vouched for them, so no publish may rewrite them —
// including the trailing one, which is byte-identical to what the kernel itself
// writes and is distinguishable ONLY by provenance.
const AUTHORED = `作者${NBSP}手写${NBSP}`
const FIXTURE = [
  '# 标题甲',
  '',
  '末段。',
  '',
  AUTHORED,
  '',
  '制表段。',
  '',
  '行首段。',
  '',
  '空首段。',
  ''
].join('\n')

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`

async function waitFor(fn, message, tries = 80) {
  for (let index = 0; index < tries; index += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const blockTexts = (evaluate) => evaluate(`JSON.stringify(
  [...((${VISIBLE_EDITOR})?.children || [])].map((n) => n.tagName + ':' + n.textContent)
)`)

const diagnostics = (evaluate) => evaluate(
  `JSON.stringify((window.__hmKernelDiagnostics || []).map((entry) => entry && entry.type))`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null
)`)

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

// SOURCE MODE IS A PUBLICATION (2026-08-26, correction A/B1 — this replaces
// the original D5 reading "source mode is a reading toggle"). Everything
// downstream of the toggle is durable: the snapshot becomes `tab.content` (the
// dirty comparison AND the session mirror) and the source textarea's buffer,
// which a save in source mode writes to disk VERBATIM — App.jsx
// `getMarkdownForTab` short-circuits on the textarea before any flush runs. An
// un-forced read here therefore put U+00A0 in the user's FILE:
//   save (clean bytes) -> toggle to source -> the just-saved tab went DIRTY
//   again with placeholder-bearing text -> the next save wrote U+00A0.
// So this returns what a save WOULD write. An outstanding BLOCK-TRAILING run
// (bytes CommonMark deletes, i.e. bytes with no spelling at all) is not shown;
// a LINE-START run still is — `resolveWhitespaceForPublish` keeps those, and
// that is where source mode still shows and can delete the whitespace.
// Locked end-to-end by scripts/test-kernel-publish-boundary-ui.mjs.
async function readSource(evaluate, label) {
  await toggleSourceMode(evaluate)
  const shown = await waitFor(() => visibleSource(evaluate), `source view did not appear (${label})`)
  await toggleSourceMode(evaluate)
  await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), `rich view did not return (${label})`)
  await sleep(150)
  return shown
}

async function charRect(evaluate, blockText, from, to) {
  return evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p, h1, h2, h3, h4, h5, h6') || [])]
      .find((n) => n.textContent === ${JSON.stringify(blockText)})
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    let count = 0
    let startNode = null, startOffset = 0, endNode = null, endOffset = 0
    let n
    while ((n = walker.nextNode())) {
      const len = n.textContent.length
      if (startNode === null && count + len >= ${from}) { startNode = n; startOffset = ${from} - count }
      if (endNode === null && count + len >= ${to}) { endNode = n; endOffset = ${to} - count }
      count += len
      if (startNode && endNode) break
    }
    if (!startNode || !endNode) return null
    const range = document.createRange()
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset)
    const rect = range.getBoundingClientRect()
    return rect ? { left: rect.left, right: rect.right, top: rect.top, height: rect.height } : null
  })()`)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

// A raw DOM selection does NOT sync ProseMirror state — every caret placement
// here is a real mouse click, per this repo's CDP convention.
async function clickAt(evaluate, send, blockText, offset) {
  const rect = await waitFor(() => charRect(evaluate, blockText, offset, offset),
    `could not locate caret offset ${offset} in ${JSON.stringify(blockText)} — blocks: ${await blockTexts(evaluate)}`)
  await click(send, { x: rect.left, y: rect.top + Math.min(12, rect.height / 2) })
  await sleep(220)
}

// A real SPACE keystroke that actually inserts a character: `pressKey` sends
// `rawKeyDown` (keymap only, no text), so Space must go through keyDown+text.
async function pressSpace(send) {
  const common = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ' ', unmodifiedText: ' ', ...common })
  await sleep(12)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(12)
}

// Where is the caret, as a (block text, offset-in-block) pair? Used to prove the
// publish did not move it.
const caretInfo = (evaluate) => evaluate(`(() => {
  const sel = window.getSelection()
  const node = sel?.anchorNode
  if (!node) return null
  const el = node.nodeType === 1 ? node : node.parentElement
  const block = el?.closest('p, h1, h2, h3, h4, h5, h6, li, th, td, pre')
  if (!block) return null
  const range = document.createRange()
  range.selectNodeContents(block)
  range.setEnd(sel.anchorNode, sel.anchorOffset)
  return JSON.stringify({ text: block.textContent, caretOffset: range.toString().length })
})()`)

async function save(evaluate, label) {
  await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), `document never became dirty (${label})`)
  await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(async () => !(await evaluate(`!!document.querySelector('.hm-save-fab')`)),
    `save did not settle (${label})`)
  await sleep(350)
  return readFile(file, 'utf8')
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)
  let app
  try {
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile'),
      port,
      appArgs: [file],
      kernelDefault: true
    })
    const { evaluate, send } = app
    await waitFor(() => evaluate(`!!(${VISIBLE_EDITOR})`), 'editor did not mount')
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not attach')
    await sleep(500)
    assert.ok(!(await diagnostics(evaluate)).includes('attach-unmappable'),
      `the kernel must be attached before anything is measured: ${await diagnostics(evaluate)}`)
    await evaluate('window.__hmKernelDiagnostics = []')

    // =====================================================================
    // A) A Space typed LAST at a paragraph end. The document keeps its
    //    placeholder (the mechanism is intact and visible); the FILE must not.
    // =====================================================================
    await clickAt(evaluate, send, '末段。', 3)
    await typeTextLikeUser(send, 'a', { delayMs: delay })
    await sleep(300)
    await pressSpace(send)
    await sleep(450)

    assert.ok(JSON.parse(await blockTexts(evaluate)).includes('P:末段。a' + NBSP),
      `the typed space must be present and visible in the editor — got ${await blockTexts(evaluate)}`)
    assert.equal(await readSource(evaluate, 'placeholder in the document'),
      FIXTURE.replace('末段。', '末段。a'),
      'SOURCE MODE SHOWS WHAT A SAVE WOULD WRITE (correction A/B1): its buffer IS the bytes ' +
      'a save in source mode puts on disk, so an outstanding block-trailing run — which has no ' +
      'byte spelling at all — must not appear there. The DOCUMENT still keeps it (asserted below).')

    const caretBefore = await caretInfo(evaluate)
    const savedA = await save(evaluate, 'space typed last')
    assert.deepEqual(app.dialogs.map((dialog) => dialog.message), [],
      'publishing whitespace must never prompt')
    assert.equal(savedA, FIXTURE.replace('末段。', '末段。a'),
      'a Space typed LAST must reach the file as NOTHING — never as U+00A0')

    // The negative control travels with every disk read below.
    assert.ok(savedA.includes(AUTHORED),
      'an AUTHORED U+00A0 (from the file, never ledgered) must survive a publish byte-for-byte')

    // A.2) The publish must not have moved the caret or taken the character.
    assert.equal(await caretInfo(evaluate), caretBefore,
      'publishing must not move the caret')
    assert.ok(JSON.parse(await blockTexts(evaluate)).includes('P:末段。a' + NBSP),
      `the space must still be in the editor after the save — got ${await blockTexts(evaluate)}`)

    // A.3) TYPING ON AFTER A SAVE. The heal still owns the run, so the next
    //      character produces the ordinary sentence the user typed.
    await typeTextLikeUser(send, 'b', { delayMs: delay })
    await sleep(450)
    const savedAB = await save(evaluate, 'character after the published space')
    assert.equal(savedAB, FIXTURE.replace('末段。', '末段。a b'),
      'typing on after a save must still produce `a b` — the publish may not eat the space')

    // =====================================================================
    // B) Tab x3 at a paragraph end. The heal leaves REAL tabs behind the
    //    outstanding run; publishing must leave neither them nor the run,
    //    because CommonMark deletes the whole trailing run.
    // =====================================================================
    await clickAt(evaluate, send, '制表段。', 4)
    for (let index = 0; index < 3; index += 1) {
      await pressKey(send, { key: 'Tab', code: 'Tab' })
      await sleep(400)
    }
    // Read the DOCUMENT here, not source mode: entering source mode publishes
    // (correction A/B1), and the whole unsaved delta of this block IS the
    // outstanding run — publishing it would make the tab clean and there would
    // be no save left to measure. The paragraph's own text carries exactly the
    // same fact.
    assert.equal(JSON.parse(await caretInfo(evaluate)).text, '制表段。\t\t' + NBSP + NBSP,
      'the document must hold the bounded two-real-tabs + one outstanding run state')

    const savedTabs = await save(evaluate, 'three tabs typed last')
    assert.equal(savedTabs, savedAB,
      'three Tabs at a paragraph end must reach the file as NOTHING — no U+00A0, no dead tabs')
    assert.ok(savedTabs.includes(AUTHORED), 'the authored U+00A0 must still be untouched')

    // =====================================================================
    // C) IDEMPOTENCE / CONVERGENCE. The publish left the caret in the
    //    placeholder run it did not write away; type another unrepresentable
    //    Space there and save again — the bytes must not move.
    // =====================================================================
    assert.equal(JSON.parse(await caretInfo(evaluate)).text, '制表段。\t\t' + NBSP + NBSP,
      'the caret must still sit in the paragraph whose run was published away')
    await pressSpace(send)
    await sleep(450)
    const savedAgain = await save(evaluate, 'second publish')
    assert.equal(savedAgain, savedTabs,
      'publishing again must produce byte-identical output')

    // =====================================================================
    // D) THE LINE-START DECISION, pinned. A Tab at a paragraph's content start
    //    is durable, visible indentation — it renders as indentation in every
    //    reader and round-trips. It is KEPT.
    // =====================================================================
    await clickAt(evaluate, send, '行首段。', 0)
    await sleep(150)
    await pressKey(send, { key: 'Home', code: 'Home' })
    await sleep(150)
    await pressKey(send, { key: 'Tab', code: 'Tab' })
    await sleep(500)
    const savedLead = await save(evaluate, 'line-start tab')
    assert.ok(savedLead.includes(NBSP + NBSP + '行首段。'),
      `a LINE-START run is durable indentation and must be KEPT: ${JSON.stringify(savedLead)}`)
    assert.ok(savedLead.includes(AUTHORED), 'the authored U+00A0 must still be untouched')

    // =====================================================================
    // D2) THE SAME DECISION FOR A SPACE — and the only shape in this file that
    //     gates the BLOCK-END guard (correction M4, 2026-08-26).
    //
    //     `dropRunForPublish` refuses a line-start run through TWO independent
    //     proofs: the block-end guard (only ASCII whitespace may sit between
    //     the run and the block's end) and `treesIdentical` (the drop must mean
    //     what the typed ASCII means). The TAB above trips BOTH — its literal
    //     `\t行首段。` reparses as an INDENTED CODE BLOCK — so with only a TAB
    //     fixture either guard could be deleted and this suite stayed green.
    //     A SPACE trips only the first: ` 空首段。` and `空首段。` are the same
    //     paragraph to CommonMark, so the tree proof passes and the block-end
    //     guard alone stands between the user's indentation and its silent
    //     deletion at the save boundary. Mutation-measured end-to-end against
    //     an isolated build (scripts/test-source-kernel-publish-whitespace.mjs
    //     §4a carries the same pin at the unit level).
    // =====================================================================
    await clickAt(evaluate, send, '空首段。', 0)
    await sleep(150)
    await pressKey(send, { key: 'Home', code: 'Home' })
    await sleep(150)
    await pressSpace(send)
    await sleep(500)
    assert.ok(JSON.parse(await blockTexts(evaluate)).includes('P:' + NBSP + '空首段。'),
      `the line-start space must be visible in the editor — got ${await blockTexts(evaluate)}`)
    const savedSpaceLead = await save(evaluate, 'line-start space')
    assert.ok(savedSpaceLead.includes(NBSP + '空首段。'),
      'a line-start SPACE is durable indentation and must reach the file — the tree ' +
      'proof cannot see this one, so the block-end guard is the only thing holding it: ' +
      JSON.stringify(savedSpaceLead))
    assert.ok(savedSpaceLead.includes(NBSP + NBSP + '行首段。'),
      'the earlier line-start TAB run must still be on disk')
    assert.ok(savedSpaceLead.includes(AUTHORED), 'the authored U+00A0 must still be untouched')

    // =====================================================================
    // E) No refusal, no degradation, no unobservable edit anywhere above.
    // =====================================================================
    const seen = await diagnostics(evaluate)
    for (const fatal of ['attach-unmappable', 'edit-unobservable', 'projection-repair-failed']) {
      assert.ok(!seen.includes(fatal), `${fatal} fired during the publish sequence: ${seen}`)
    }

    console.log('PASS kernel publish-whitespace: a Space/Tab typed LAST reaches the file as nothing, the editor keeps it, the caret does not move, an authored U+00A0 is untouched, and a line-start run is kept')
  } finally {
    try { if (app) await app.evaluate(`window.confirm = () => true`) } catch {}
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
