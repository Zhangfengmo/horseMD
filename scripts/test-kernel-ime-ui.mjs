// Kernel-mode IME UI regression (source-kernel integration Plan 2, Task 10):
// the first REAL composition-lifecycle exercise of the experimental
// source-kernel mode — CompositionSession (editor-kernel-composition.js) had
// only been headless-tested (scripts/test-kernel-composition-headless.mjs)
// against a stub view before this script.
//
// Scenario:
//  (a) type a full pinyin->CJK composition at the end of an existing
//      paragraph, switch to source, assert byte-exact result with no pinyin
//      residue anywhere.
//  (b) start a composition (imeSetComposition, no commit) and click the save
//      FAB mid-composition: flushMarkdownSettled() (App.jsx saveTab ->
//      getSettledMarkdownForTab -> editorApi.flushMarkdownSettled) must await
//      the kernel's composition.settled() rather than hang or ever persist
//      pinyin. Since the kernel writes bytes only at a proven compositionend
//      commit (never mid-composition — handleTransactions' 'composition'
//      branch passes every in-flight PM change through UNTOUCHED, see
//      editor-kernel-mode.js), an incomplete composition has never advanced
//      kernel.doc — so settled()'s only outcome here is the timeout-forced
//      revert (editor-kernel-composition.js settleTimeoutMs, default 3000ms)
//      and the save must persist EXACTLY the pre-composition bytes.
//  (c) a full composition commit, then one Undo: `commitReplace` brackets
//      the commit with `kernel.history.breakGroup()` on both sides (an
//      'ime-commit' intent is not insert-text-coalescable to begin with —
//      see createSourceHistory's asCoalescableEdit — so this is a second,
//      belt-and-suspenders fence), so the WHOLE composed word must vanish as
//      one undo unit, not character by character.
//  (d) after the undo lands, confirm the Save FAB is (correctly) already
//      gone — the undo returned the live doc to bytes (b) already saved, see
//      the AFTER_UNDO/SAVED_AFTER_UNDO derivation below — then make ONE
//      more small plain-text edit (a single ASCII character, non-IME) to
//      re-dirty the tab, click Save for real, assert the disk bytes, THEN
//      full quit + cold reopen against that final state. This is the actual
//      click-coverage the FAB-absent assertion alone does not exercise:
//      clicking Save on a kernel-mode tab whose most recent history entry is
//      an IME-composition commit that was subsequently undone.
//
// Every expected byte string below is DERIVED from the same primitives the
// live UI wiring calls (kernel.doc text after commitPlainText/commitReplace
// via editor-kernel-mode.js), not guessed — see the inline comments at each
// assertion for the derivation. `imeType`/`rawKey` are copied verbatim from
// scripts/test-ime-source-fidelity-ui.mjs:47-69 (the proven real-composition
// driver: per-pinyin-letter rawKeyDown/keyUp INTERLEAVED with
// Input.imeSetComposition, committed via Input.insertText — the interleaving
// is load-bearing, a pure imeSetComposition sequence does not reproduce the
// composition-lifecycle bugs this class of test exists to catch).
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-ime-${process.pid}`
const file = join(root, 'ime.md')
const port = Number(process.env.CDP_PORT || 10021)
const step = Number(process.env.IME_STEP || 60)

const INITIAL = '段落甲\n'
// (a): caret at the end of '段落甲', composing 'ceshi'->'测试' commits at
// that position — no other content in the doc, so the result is simply the
// original paragraph with '测试' appended, byte-exact (kernel.doc.text is
// the ONLY persistence channel in kernel mode; there is no serializer/
// preservation mapper step that could reintroduce or drop bytes).
const AFTER_A = '段落甲测试\n'
// (b): an INCOMPLETE composition never advances kernel.doc (see module
// header) — the only settle path available (settleTimeoutMs forces a
// revert) leaves kernel.doc exactly as it was before the incomplete
// composition started, i.e. identical to AFTER_A.
const AFTER_B = AFTER_A
// (c): a second full composition at the end of '段落甲测试' appends '测试'
// again.
const AFTER_C_COMMIT = '段落甲测试测试\n'
// One Undo reverts the whole ime-commit group (see module header) back to
// the state just before that second composition started, i.e. AFTER_A.
const AFTER_UNDO = AFTER_A
// (d) part 1: the undo landed exactly on the bytes (b)'s mid-composition
// save already wrote to disk — nothing new to persist yet.
const SAVED_AFTER_UNDO = AFTER_UNDO
// (d) part 2: ONE plain-text ASCII character typed at the end of the
// now-undone paragraph ('段落甲测试') is a fresh 'insert-text' kernel commit
// (commitPlainText, not composition — plain Input.insertText/typeTextLikeUser
// never opens a DOM composition), independent of the ime-commit history
// entry it follows. Appended at the very end, byte for byte.
const AFTER_D_EDIT = '段落甲测试!\n'
const SAVED = AFTER_D_EDIT

async function waitFor(check, message, attempts = 80, intervalMs = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(intervalMs)
  }
  throw new Error(message)
}

const mounted = (evaluate) => evaluate(`[
  ...document.querySelectorAll('.ProseMirror')
].find((node) => node.offsetParent)?.textContent`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

// Split-button status-bar toggle (post P2-9 rework): the main `.status-btn`
// (excluding the kernel-mode caret button) toggles source/rich in one click,
// byte-identical to every legacy single-click `toggleMode` helper.
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

async function toggleKernelMode(evaluate) {
  const opened = await evaluate(`(() => {
    const button = document.querySelector('.block-switch-caret-btn')
    button?.click()
    return !!button
  })()`)
  assert.ok(opened, 'no kernel-mode caret button — tab not kernel-eligible?')
  await sleep(150)
  const clicked = await evaluate(`(() => {
    const item = [...document.querySelectorAll('.block-switch-menu .block-menu-item')]
      .find((node) => node.offsetParent)
    item?.click()
    return !!item
  })()`)
  assert.ok(clicked, 'kernel-toggle menu item missing')
}

// Same off-screen-safe click convention as test-kernel-mode-ui.mjs /
// test-quoted-block-source-ui.mjs: a rect measured off-screen makes the
// synthetic click miss and silently turns "position the caret" into a no-op.
async function clickTextEnd(evaluate, send, text) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = [...(editor?.querySelectorAll('p, td, th') || [])]
      .find((candidate) => candidate.textContent === ${JSON.stringify(text)})
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const rect = node.getBoundingClientRect()
    return { x: rect.left + 8, y: rect.top + Math.min(12, rect.height / 2) }
  })()`)
  assert.ok(point, `missing editable block: ${text}`)
  await sleep(400)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await pressKey(send, { key: 'End', code: 'End', delayMs: step })
}

// Copied verbatim from scripts/test-ime-source-fidelity-ui.mjs:47-69.
let compId = 1
async function imeType(send, pinyin, cjk) {
  const replacementId = `comp-${compId++}`
  for (let i = 0; i < pinyin.length; i += 1) {
    const ch = pinyin[i]
    const code = ch.charCodeAt(0)
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
    const text = pinyin.slice(0, i + 1)
    await send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length, replacementId, location: 0 })
    await sleep(step)
  }
  await sleep(step)
  await send('Input.insertText', { text: cjk }) // commit → compositionend
  await sleep(step)
}

// Scenario (b)'s deliberately-incomplete composition: the same
// rawKeyDown/keyUp + Input.imeSetComposition interleave as imeType above,
// stopped BEFORE the commit (no Input.insertText, no compositionend) — a
// human mid-word, caught by a save click. Shares imeType's `compId` counter
// (module-level, per the task brief) since it drives the exact same
// composition machinery, just left open.
async function imeStartOnly(send, pinyin) {
  const replacementId = `comp-${compId++}`
  for (let i = 0; i < pinyin.length; i += 1) {
    const ch = pinyin[i]
    const code = ch.charCodeAt(0)
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
    const text = pinyin.slice(0, i + 1)
    await send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length, replacementId, location: 0 })
    await sleep(step)
  }
}

// `Mod-z` resolves to Meta (Cmd) on darwin — same modifier value
// scripts/test-kernel-mode-ui.mjs / test-issue-98-copy-undo-ui.mjs use.
async function pressUndo(send) {
  const params = { key: 'z', code: 'KeyZ', modifiers: 4, windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}

async function pressEscape(send) {
  const params = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, INITIAL)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    let { evaluate, send } = app

    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('段落甲') ? text : null
    }, 'initial document did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on plain mount')

    // Enable kernel mode and wait for the remount signal.
    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('段落甲') ? text : null
    }, 'document did not remount after enabling kernel mode')
    await sleep(300)

    // PROVE the kernel actually attached (same guard as
    // test-kernel-nodeview-ui.mjs / test-kernel-mode-ui.mjs): a silent
    // degradation to the legacy fallback must fail LOUDLY here, not let the
    // rest of this script quietly exercise the legacy pipeline.
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(
      !attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy fallback for this fixture: ${attachDiagnostics}`
    )

    // --- (a) a full real composition, byte-exact, no pinyin residue -------
    await clickTextEnd(evaluate, send, '段落甲')
    await imeType(send, 'ceshi', '测试')
    await waitFor(async () => (await mounted(evaluate) || '').includes('段落甲测试'), 'composed 测试 never reached the kernel-mode editor')

    await toggleSourceMode(evaluate)
    let shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after composition (a)')
    assert.equal(shown, AFTER_A, 'composed IME text must be byte-exact, no pinyin residue')
    assert.doesNotMatch(shown, /ceshi|c​e​s​h​i/i, 'no pinyin fragment leaked into the source bytes')
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return after (a)')

    // --- (b) mid-composition save must not hang and must not persist ------
    // --- pinyin: assert the rollback path (pre-composition bytes) --------
    assert.ok(await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save FAB missing before (b) — tab must be dirty from (a)'), 'save FAB present')
    await clickTextEnd(evaluate, send, '段落甲测试')
    await imeStartOnly(send, 'ce') // deliberately never committed
    await sleep(150)
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    // ~4s covers the 3s composition settleTimeoutMs safety net.
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'mid-composition save never completed (FAB still visible)', 45, 100)
    const diskAfterB = await readFile(file, 'utf8')
    assert.equal(diskAfterB, AFTER_B, 'mid-composition save must persist exactly the pre-composition bytes (rollback path), never pinyin')
    assert.doesNotMatch(diskAfterB, /ce(?!shi)/i, 'no partial pinyin byte on disk after the mid-composition save')
    assert.equal(app.dialogs.length, 0, 'no dialog during the mid-composition save')

    // Clean up the (browser-level) composition state before continuing.
    await pressEscape(send)
    await sleep(300)
    await waitFor(async () => (await mounted(evaluate) || '').includes('段落甲测试') && !(await mounted(evaluate) || '').includes('ce'), 'view did not settle back to 段落甲测试 after the mid-composition save + Escape')

    // --- (c) composition commit -> one Undo removes the WHOLE word --------
    await clickTextEnd(evaluate, send, '段落甲测试')
    await imeType(send, 'ceshi', '测试')
    await waitFor(async () => (await mounted(evaluate) || '').includes('段落甲测试测试'), 'second composed 测试 never reached the kernel-mode editor')
    await toggleSourceMode(evaluate)
    shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after composition (c) commit')
    assert.equal(shown, AFTER_C_COMMIT, 'second composition commit must be byte-exact')
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return after (c) commit verification')

    await pressUndo(send)
    await sleep(300)
    await toggleSourceMode(evaluate)
    shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after undo')
    assert.equal(shown, AFTER_UNDO, 'one Undo must remove the ENTIRE composed word as a single undo unit')
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return after undo verification')

    // --- (d) part 1: the undo landed on already-saved bytes -----------------
    // The undo in (c) returned the document to EXACTLY the bytes (b)'s
    // mid-composition save already wrote to disk (AFTER_UNDO === AFTER_B ===
    // SAVED_AFTER_UNDO) — kernel mode's onChange keeps tab.content live, and
    // dirty tracking (`isTabDirty`, lib/tab-state.js) is a pure content ===
    // savedContent comparison, so the save FAB has ALREADY gone here (no new
    // save is needed for THIS byte string, matching what a real user would
    // see: undo landed back on the last-saved text). This assertion is a
    // real, valid regression lock on kernel-mode dirty tracking recognizing
    // "undo returned to the saved state" — but by itself it is not a
    // substitute for an actual Save click: nothing in this script (or in
    // test-kernel-mode-ui.mjs, whose save clicks only ever follow plain-text
    // edits) exercises clicking Save on a kernel-mode tab whose most recent
    // history entry is an IME-composition commit that was then undone. Part
    // 2 below closes that gap with a real click.
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save FAB still visible — undo did not return to the already-saved bytes')
    assert.equal(await readFile(file, 'utf8'), SAVED_AFTER_UNDO, 'disk bytes must already match the post-undo kernel state from (b)\'s save')
    assert.equal(app.dialogs.length, 0, 'no rebuild prompt may appear')

    // --- (d) part 2: a real Save click on top of the post-undo state --------
    // One plain ASCII character (non-IME, Input.insertText — never opens a
    // DOM composition) re-dirties the tab on top of a history whose latest
    // entry is the now-undone ime-commit group, then Save is actually
    // clicked and its result verified on disk — the click coverage the
    // FAB-absent assertion above cannot provide by itself.
    await clickTextEnd(evaluate, send, '段落甲测试')
    await typeTextLikeUser(send, '!', { delayMs: step })
    await waitFor(async () => (await mounted(evaluate) || '').includes('段落甲测试!'), 'plain-text edit after the undo never reached the kernel-mode editor')
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save FAB did not appear for the post-undo plain-text edit')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save after the post-undo edit never completed (FAB still visible)')
    assert.equal(await readFile(file, 'utf8'), SAVED, 'disk bytes must match the post-undo-plus-new-edit kernel state exactly')
    assert.equal(app.dialogs.length, 0, 'no rebuild prompt may appear on the post-undo save')

    // --- full quit, cold reopen, byte-exact ---------------------------------
    await stopBuiltElectron(app, { removeProfile: false })
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, cleanProfile: false, appArgs: [file] })
    ;({ evaluate, send } = app)
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('段落甲测试!') ? text : null
    }, 'reopened document did not mount with the saved content')
    await toggleSourceMode(evaluate)
    shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after cold reopen')
    assert.equal(shown, SAVED, 'cold reopen must reproduce the saved bytes exactly')
    assert.equal(app.dialogs.length, 0, 'no rebuild prompt may appear on cold reopen')

    console.log('PASS kernel-mode IME UI: full composition, mid-composition save rollback, undo-as-one-unit, a real save click on the post-undo state, and cold reopen all match the kernel-derived byte strings')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
