// Kernel-mode UI smoke regression (source-kernel integration Plan 2, Task 9):
// the first REAL end-to-end exercise of the experimental source-kernel mode
// through the actual status-bar toggle, typed keystrokes, a task-checkbox
// click, undo, save and a full quit/relaunch cold reopen.
//
// Every "expected bytes" string below is DERIVED, not guessed: it is the
// literal output of running the same sequence of kernel primitives
// (applySourceTransaction / routeStructuralKey / toggleTaskMarker /
// createSourceHistory) that the UI wiring itself calls — see the node -e
// derivation transcript in docs/... (task-9 report). The kernel is the
// oracle; this script only proves the live UI reaches the same bytes.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-${process.pid}`
const file = join(root, 'kernel.md')
const port = Number(process.env.CDP_PORT || 10020)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)
const source = '# 标\n\n段甲\n\n- 甲\n- [x] 乙\n'

// Derived by running the exact same keystroke sequence through the pure
// kernel (node -e, `applySourceTransaction`/`routeStructuralKey`/
// `toggleTaskMarker`/`createSourceHistory` from
// src/renderer/src/lib/source-kernel/index.js). See task-9-report.md for the
// full transcript.
const AFTER_TYPING = '# 标\n\n段甲新\n\n乙段\n\n- 甲\n  - 丙\n- [x] 乙\n'
const AFTER_CHECKBOX = '# 标\n\n段甲新\n\n乙段\n\n- 甲\n  - 丙\n- [ ] 乙\n'
// Undo #1 reverts the checkbox toggle (its own history group, intent
// `toggle-task` — never coalesces with an `insert-text` group): back to
// AFTER_TYPING exactly.
const AFTER_UNDO_1 = AFTER_TYPING
// Undo #2 reverts the Tab indent (`indentListItem`, also its own group) as
// ONE step — proving indent is a single undo unit, not decomposed into the
// underlying multi-edit source transaction.
const AFTER_UNDO_2 = '# 标\n\n段甲新\n\n乙段\n\n- 甲\n- 丙\n- [x] 乙\n'
const SAVED = AFTER_UNDO_2

async function waitFor(check, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
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

// The status-bar source/rich toggle is a split button (Task 8's popover
// design was reverted after it broke ~80 legacy tests' single-click
// assumption — see StatusBar.jsx SourceSwitch): the main `.status-btn`
// (matched the same way every legacy `toggleMode` helper already does)
// calls `onToggleSource` directly on click, byte-identical to the flat
// pre-Task-8 button. The experimental kernel-mode toggle moved to a
// SEPARATE small caret button (`.block-switch-caret-btn`, only rendered
// when the tab is kernel-eligible) whose popover now holds only the
// kernel-toggle item.
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

// The document can be taller than the window; a rect measured off-screen
// makes the synthetic click miss and silently turns an edit step into a
// no-op (same trap test-quoted-block-source-ui.mjs documents).
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
  await pressKey(send, { key: 'End', code: 'End', delayMs: delay })
}

// Mirror of clickTextEnd for the 段首 Enter (Task 2, plan 3) UI check: click
// near the block's start and press Home to land exactly at its content
// start regardless of where the synthetic click actually lands.
async function clickTextStart(evaluate, send, text) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = [...(editor?.querySelectorAll('p, h1, h2, h3, h4, h5, h6, td, th') || [])]
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
  await pressKey(send, { key: 'Home', code: 'Home', delayMs: delay })
}

// Task checkbox DOM (discovered at runtime, see task-9-report.md): Crepe's
// `@milkdown/components` list-item-block node view wraps EVERY list item
// (task or not) in `<div class="milkdown-list-item-block"><li
// class="list-item"><div class="label-wrapper">...svg...</div><div
// class="children">...content...</div></li></div>` — there is no
// `<input type="checkbox">`; the checkbox is an SVG icon inside
// `.label-wrapper`, and its checked state is read from
// `.label.checked`/`.label.unchecked` classes on the icon. Clicking
// `.label-wrapper` (a `pointerdown` handler) is what a real user click does;
// synthetic `mousePressed`/`mouseReleased` via CDP triggers it the same way
// scripts/test-task-list-persistence-ui.mjs already relies on.
const taskPoint = (evaluate, text) => evaluate(`((text) => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const item = [...(editor?.querySelectorAll('.milkdown-list-item-block') || [])]
    .find((node) => node.querySelector('.children')?.textContent?.trim() === text)
  const label = item?.querySelector('.label-wrapper')
  const rect = label?.getBoundingClientRect()
  return rect
    ? { x: Math.round((rect.left + rect.right) / 2), y: Math.round((rect.top + rect.bottom) / 2) }
    : null
})(${JSON.stringify(text)})`)

const taskChecked = (evaluate, text) => evaluate(`((text) => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const item = [...(editor?.querySelectorAll('.milkdown-list-item-block') || [])]
    .find((node) => node.querySelector('.children')?.textContent?.trim() === text)
  if (!item) return null
  if (item.querySelector('.label.checked')) return true
  if (item.querySelector('.label.unchecked')) return false
  return null
})(${JSON.stringify(text)})`)

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

// `Mod-z` resolves to Meta (Cmd) on darwin — the prosemirror-keymap `mac`
// detection this test's environment (Darwin) hits — same modifier value
// scripts/test-issue-98-copy-undo-ui.mjs uses for its Cmd shortcuts.
async function pressUndo(send) {
  const params = { key: 'z', code: 'KeyZ', modifiers: 4, windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, source)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    let { evaluate, send } = app
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('段甲') && text.includes('乙') ? text : null
    }, 'initial document did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on plain mount')

    // Step 2: enable the experimental source-kernel mode via the status-bar
    // popover, and wait for the remount signal (`.hm-kernel-mode` on the
    // Crepe host — editor-crepe-setup.js only adds this class when
    // `kernelMode` is true).
    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('段甲') && text.includes('乙') ? text : null
    }, 'document did not remount after enabling kernel mode')
    await sleep(300)

    // PROVE the kernel actually attached for this fixture. It ends in a
    // list, the exact shape @milkdown/plugin-trailing appends its synthetic
    // empty paragraph after — pre-Task-11.5, that node silently rejected the
    // whole projection map and this entire script ran in the DEGRADED legacy
    // fallback while still passing (Task 11 Bug 2). This assertion makes any
    // future silent degradation fail LOUDLY here instead.
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(
      !attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy fallback for this fixture: ${attachDiagnostics}`
    )

    // Step 3a: end of 段甲 -> type 新 -> Enter -> type 乙段.
    await clickTextEnd(evaluate, send, '段甲')
    await typeTextLikeUser(send, '新', { delayMs: delay })
    await waitFor(async () => (await mounted(evaluate) || '').includes('段甲新'), 'typed 新 never reached the kernel-mode editor')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await typeTextLikeUser(send, '乙段', { delayMs: delay })
    await waitFor(async () => (await mounted(evaluate) || '').includes('乙段'), 'typed 乙段 never reached the kernel-mode editor')

    // Step 3b: end of list item 甲 -> Enter -> type 丙 -> Tab (indent).
    await clickTextEnd(evaluate, send, '甲')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await typeTextLikeUser(send, '丙', { delayMs: delay })
    await waitFor(async () => (await mounted(evaluate) || '').includes('丙'), 'typed 丙 never reached the kernel-mode editor')
    await pressKey(send, { key: 'Tab', code: 'Tab', delayMs: delay + 30 })
    await sleep(300)

    // Step 4: switch to source mode and assert byte-exact kernel output,
    // then switch back (a pure view toggle — see syncSourceToRich's no-op
    // guard — so this round trip must not disturb kernel history).
    await toggleSourceMode(evaluate)
    let shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after typing/list edits')
    assert.equal(shown, AFTER_TYPING, 'kernel-mode typed edits must match the kernel-derived byte string')
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return')

    // Step 5: click the task checkbox for 乙 ([x] -> [ ]), verify via the
    // DOM state, then via a second source-mode round trip.
    let point = await waitFor(() => taskPoint(evaluate, '乙'), 'task checkbox for 乙 was not hit-testable')
    await click(send, point)
    await waitFor(async () => (await taskChecked(evaluate, '乙')) === false, 'task checkbox for 乙 did not become unchecked')
    await toggleSourceMode(evaluate)
    shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after the checkbox toggle')
    assert.equal(shown, AFTER_CHECKBOX, 'checkbox toggle must flip only the task marker, byte-exact')
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return after checkbox verification')

    // Step 6: Cmd-Z twice. Each undo removes exactly ONE history group
    // (checkbox toggle, then the Tab indent) — not a per-keystroke replay.
    await pressUndo(send)
    await sleep(250)
    await toggleSourceMode(evaluate)
    shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after undo #1')
    assert.equal(shown, AFTER_UNDO_1, 'undo #1 must revert exactly the checkbox-toggle group')
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return after undo #1 verification')

    await pressUndo(send)
    await sleep(250)
    await toggleSourceMode(evaluate)
    shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after undo #2')
    assert.equal(shown, AFTER_UNDO_2, 'undo #2 must revert exactly the Tab-indent group as one unit')

    // Step 7: save from source mode (the textarea is the live buffer) and
    // assert disk bytes, with no rebuild-confirmation dialog.
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    assert.equal(await readFile(file, 'utf8'), SAVED, 'disk bytes must match the post-undo kernel state exactly')
    assert.equal(
      app.dialogs.length,
      0,
      `no rebuild prompt may appear: ${JSON.stringify(app.dialogs.map((dialog) => dialog.message))}`
    )

    // Step 8: full quit, relaunch the same file, and confirm the content
    // mounts intact (cold reopen — this reloads in the default, non-kernel
    // rich editor since kernelModeIds is session-only and never persisted).
    await stopBuiltElectron(app, { removeProfile: false })
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, cleanProfile: false, appArgs: [file] })
    ;({ evaluate, send } = app)
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('段甲新') && text.includes('乙段') && text.includes('丙') ? text : null
    }, 'reopened document did not mount with the saved content')
    await toggleSourceMode(evaluate)
    shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after cold reopen')
    assert.equal(shown, SAVED, 'cold reopen must reproduce the saved kernel-mode bytes exactly, byte-for-byte')
    assert.equal(app.dialogs.length, 0, 'no rebuild prompt may appear on cold reopen')

    console.log('PASS kernel-mode UI smoke: typing, list split/indent, task checkbox, undo groups, save and cold reopen all match the kernel-derived byte strings')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

// Task 2 (plan 3) UI segment: splitTextBlock's 段首 Enter · 连续 Enter
// polish, on a dedicated small fixture (a plain paragraph followed by
// another plain paragraph — nothing else — so the LAST block is a genuine
// paragraph the trailing-Enter chain can land on; the main fixture above
// deliberately ends in a list, which is a different, unrelated code path).
// Bytes below are the pure-kernel oracle's own output (routeStructuralKey
// chained through the exact same keystrokes — see the task's derivation
// transcript in task-2-report.md), applied in this exact order: three
// trailing Enters + typed text FIRST, then two paragraph-start Enters on
// the now-modified document — both segments verified against the SAME
// running kernel-mode tab.
async function runSplitPolishSegment() {
  const segRoot = `/tmp/horsemd-kernel-splitpolish-${process.pid}`
  const file = join(segRoot, 'polish.md')
  const initial = '标题\n\n段落\n'
  const AFTER_TRAILING_CHAIN = '标题\n\n段落\n\n\n\n尾\n'
  const AFTER_PARAGRAPH_START = '\n\n标题\n\n段落\n\n\n\n尾\n'

  await rm(segRoot, { recursive: true, force: true })
  await mkdir(segRoot, { recursive: true })
  await writeFile(file, initial)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(segRoot, 'profile'), port, appArgs: [file] })
    let { evaluate, send } = app
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('标题') && text.includes('段落') ? text : null
    }, 'split-polish document did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on plain mount (split-polish)')

    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`),
      'kernel mode did not remount the split-polish tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('标题') && text.includes('段落') ? text : null
    }, 'split-polish document did not remount after enabling kernel mode')
    await sleep(300)
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(
      !attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy for the split-polish fixture: ${attachDiagnostics}`
    )

    // 块尾连续 Enter: end of the LAST block (段落) -> Enter x3 -> type text.
    // The first Enter is the existing degenerate-split (virtual paragraph);
    // the second and third used to be REFUSED (Task 2's fix) — each must
    // extend the trailing blank-line chain instead, and the typed text must
    // land in the LAST placeholder, becoming a real new paragraph.
    await clickTextEnd(evaluate, send, '段落')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await typeTextLikeUser(send, '尾', { delayMs: delay })
    await waitFor(async () => (await mounted(evaluate) || '').includes('尾'),
      'typed 尾 never reached the kernel-mode editor after the trailing-Enter chain')
    await sleep(200)

    await toggleSourceMode(evaluate)
    let shown = await waitFor(() => visibleSource(evaluate),
      'source view did not appear after the trailing-Enter chain')
    assert.equal(shown, AFTER_TRAILING_CHAIN,
      'three trailing Enters + typed text must match the kernel-derived bytes byte-for-byte')
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`),
      'rich view did not return after the trailing-Enter verification')

    // 段首 Enter x2: caret at 标题's very content start -> Enter twice. Each
    // press must add exactly one MORE blank line above the block (never
    // accumulate inline at the caret), and the caret must stay anchored on
    // 标题's own text both times (provable end-to-end only by the fact that
    // 标题/段落/尾's text below is byte-for-byte unchanged in the final
    // source, with only two new blank lines prepended).
    await clickTextStart(evaluate, send, '标题')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await sleep(200)

    await toggleSourceMode(evaluate)
    shown = await waitFor(() => visibleSource(evaluate),
      'source view did not appear after paragraph-start Enter x2')
    assert.equal(shown, AFTER_PARAGRAPH_START,
      'two paragraph-start Enters must add two blank lines above, with 标题/段落/尾 byte-intact below')

    console.log('PASS kernel-mode UI split-polish segment: paragraph-start Enter x2 and trailing Enter x3 + type both match the kernel-derived byte strings')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

// Final-review regression segment: Tab at a PLAIN paragraph's end (not a
// list item — routeStructuralKey's `item ? indentListItem(ctx) : NOT_STRUCTURAL`
// branch, so this falls to editor-kernel-mode.js's `insertPlainTextAtSelection`
// not-structural path). Commit 2e3036b's `startBoundaries` table has no entry
// at `visibleLength` (nothing "starts" past the last unit), so
// `rawRangeForVisibleRange(N, N)` at block end used to return null and the
// live UI toasted KERNEL_CODES.UNMAPPED instead of inserting anything at all.
// (2026-08-18: what it inserts is no longer a literal tab — see AFTER_TAB.)
// Own isolated app session (same pattern as runSplitPolishSegment) so this
// one extra keystroke never disturbs the main run()'s carefully-chained undo/
// checkbox/save byte assertions.
async function runTabAtBlockEndSegment() {
  const segRoot = `/tmp/horsemd-kernel-tabend-${process.pid}`
  const file = join(segRoot, 'tabend.md')
  const initial = '段落甲\n'
  // 2026-08-18: a literal tab at a block's END is stripped by CommonMark, so it
  // was a dead byte — written to disk, invisible in the view, forever. Tab now
  // writes TWO no-break spaces (see lib/source-kernel/commands/trailing-whitespace.js).
  const AFTER_TAB = '段落甲' + '\u00A0\u00A0' + '\n'
  // 2026-08-26 (correction A/B1): entering SOURCE MODE is a PUBLICATION
  // boundary — its buffer is exactly what a save in source mode writes to disk
  // (the save path short-circuits on the textarea before any flush). An
  // outstanding block-trailing run has no byte spelling at all — D5 already
  // proved the FILE holds nothing there — so source mode shows the PUBLISHED
  // text. The DOCUMENT still holds the placeholder, asserted from the rich view.
  const AFTER_TAB_PUBLISHED = '段落甲' + '\n'

  await rm(segRoot, { recursive: true, force: true })
  await mkdir(segRoot, { recursive: true })
  await writeFile(file, initial)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(segRoot, 'profile'), port, appArgs: [file] })
    const { evaluate, send } = app
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('段落甲') ? text : null
    }, 'tab-at-block-end document did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on plain mount (tab-at-block-end)')

    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`),
      'kernel mode did not remount the tab-at-block-end tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('段落甲') ? text : null
    }, 'tab-at-block-end document did not remount after enabling kernel mode')
    await sleep(300)
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(
      !attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy for the tab-at-block-end fixture: ${attachDiagnostics}`
    )

    await clickTextEnd(evaluate, send, '段落甲')
    await pressKey(send, { key: 'Tab', code: 'Tab', delayMs: delay + 30 })
    await sleep(250)
    assert.equal(app.dialogs.length, 0, 'Tab at a plain paragraph end must not toast unmapped')

    // The DOCUMENT holds the placeholder run: that is the mechanism, and it is
    // what the next keystroke heals.
    assert.equal(await mounted(evaluate), AFTER_TAB.replace('\n', ''),
      'Tab at a plain paragraph end must write two real no-break spaces into the DOCUMENT, byte-exact')

    await toggleSourceMode(evaluate)
    const shown = await waitFor(() => visibleSource(evaluate),
      'source view did not appear after Tab at the paragraph end')
    assert.equal(shown, AFTER_TAB_PUBLISHED,
      'source mode is a PUBLICATION boundary (correction A/B1): its buffer is what a save writes, ' +
      'and an outstanding block-trailing run has no byte spelling at all')

    console.log('PASS kernel-mode UI tab-at-block-end segment: Tab at a plain paragraph end writes real whitespace into the document, and the publication boundary shows what a save would write')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

async function main() {
  await run()
  await runSplitPolishSegment()
  await runTabAtBlockEndSegment()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
