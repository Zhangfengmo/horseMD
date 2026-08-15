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

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
