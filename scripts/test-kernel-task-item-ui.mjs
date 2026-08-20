// Kernel-mode `/task` end-to-end UI regression: the U+00A0 seed item.
//
// The headless suites (scripts/test-source-kernel-task-seed.mjs, the TS
// section of scripts/test-kernel-gateway.mjs, Case I5 of
// scripts/test-kernel-mode-headless.mjs) prove the COMMAND, the GATEWAY and
// the CONTROLLER. This script proves the live wiring — the crepe-setup route
// (`KERNEL_INSERT_ITEMS.task`), the slash menu's run swap, and the real
// keystroke sequence — plus the two facts only the real app can prove:
//
//   1. `/task` puts a REAL CHECKBOX on screen immediately (Crepe's
//      list-item-block renders `.label.unchecked` only for a boolean
//      `checked` attr — an ASCII `- [ ]` spelling would render literal text);
//   2. saving at the AWKWARD INSTANT (before the label) writes bytes that are
//      a real `checked: false` task, and typing the label afterwards — after
//      a save and a focus round-trip — still DISSOLVES the seed, so the final
//      file holds exactly the typed label with no U+00A0 anywhere. A cold
//      reopen (full relaunch) renders both checkboxes from the saved bytes.
//
// Every expected string is the literal output of the kernel commands
// (insertBlockFromQuery / spellTaskSeedInsert + applySourceTransaction).
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'
import { parseKernelMarkdown } from '../src/renderer/src/lib/source-kernel/syntax-index.js'

const NBSP = ' '
const SEED_LINE = '- [ ] ' + NBSP
const root = `/tmp/horsemd-kernel-task-item-${process.pid}`
const file = join(root, 'task-item.md')
const port = Number(process.env.CDP_PORT || 10082)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

// `中间说明段。` is LOAD-BEARING: a `/task` in a paragraph directly ABOVE or
// BELOW an existing list would MERGE into it (a blank line makes a CommonMark
// list loose, it does not end it), which the insert command's two-axis proof
// correctly REFUSES (pinned in scripts/test-source-kernel-task-seed.mjs). The
// spacer keeps the two task paragraphs non-adjacent so both inserts are the
// provable shape.
const LINES = ['# 标题', '', '甲乙丙丁', '', '中间说明段。', '', '戊己庚辛', '', '尾段落。', '']
const FIXTURE = LINES.join('\n')

async function waitFor(fn, message, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`
const mounted = (evaluate) => evaluate(`(${VISIBLE_EDITOR})?.textContent`)
const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
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

async function readSource(evaluate, message) {
  await toggleSourceMode(evaluate)
  const shown = await waitFor(() => visibleSource(evaluate), `source view did not appear (${message})`)
  await toggleSourceMode(evaluate)
  await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), `rich view did not return (${message})`)
  await sleep(150)
  return shown
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

async function charRect(evaluate, blockText, from, to) {
  return evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p, h1, h2, h3, h4, h5, h6') || [])].find((n) => n.textContent === ${JSON.stringify(blockText)})
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

async function selectionNonEmpty(evaluate) {
  return evaluate(`(() => { const s = window.getSelection(); return !!s && s.toString().length > 0 })()`)
}

// A real mouse DRAG across the block's text (never a triple click — see
// test-kernel-blockinsert-ui.mjs, the pattern this script follows).
async function selectBlock(evaluate, send, blockText) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rect = await waitFor(() => charRect(evaluate, blockText, 0, blockText.length),
      `could not locate ${JSON.stringify(blockText)} to select`)
    const y = rect.top + Math.min(12, rect.height / 2)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.left + 1, y, button: 'left', clickCount: 1 })
    for (let step = 1; step <= 4; step += 1) {
      const x = rect.left + ((rect.right - rect.left) * step) / 4
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.max(rect.right - 1, rect.left + 1), y, button: 'left', clickCount: 1 })
    await sleep(250)
    if (await selectionNonEmpty(evaluate)) return
    await sleep(200)
  }
  assert.fail(`drag-select never produced a non-empty selection for ${JSON.stringify(blockText)}`)
}

// Type "/task", assert the item is ENABLED (not `.disabled` — it was refused
// with the phase-1 message before 2026-08-20) and ranked first, then activate.
async function runTaskItem(evaluate, send, { activate = 'enter' } = {}) {
  await typeTextLikeUser(send, '/task', { delayMs: delay })
  await waitFor(() => evaluate(`document.querySelectorAll('.milkdown-slash-menu[data-show="true"] .hm-slash-item').length > 0`),
    'slash menu did not open for the /task query', 25)
  const state = await waitFor(() => evaluate(`(() => {
    const li = document.querySelector('.milkdown-slash-menu[data-show="true"] .hm-slash-item[data-id="task"]')
    if (!li) return null
    return { disabled: li.classList.contains('disabled'), first: document.querySelector('.milkdown-slash-menu[data-show="true"] .hm-slash-item')?.dataset.id }
  })()`), 'the task item never appeared for the /task query')
  assert.equal(state.disabled, false,
    'the task slash item must be ENABLED in kernel mode, not greyed out')
  assert.equal(state.first, 'task',
    `the /task query must rank 'task' first so Enter activates it (got ${state.first})`)
  if (activate === 'click') {
    const point = await waitFor(() => evaluate(`(() => {
      const li = document.querySelector('.milkdown-slash-menu[data-show="true"] .hm-slash-item[data-id="task"]')
      const r = li?.getBoundingClientRect()
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
    })()`), 'the task slash item is not hit-testable')
    await click(send, point)
  } else {
    await pressKey(send, { key: 'Enter', code: 'Enter' })
  }
  await sleep(600)
}

// The task items the view renders, read off Crepe's list-item-block DOM: the
// checkbox is `.label.checked`/`.label.unchecked` in `.label-wrapper` (an
// ASCII "- [ ]" would render as literal TEXT with no label element at all —
// which is exactly the distinction this feature exists for).
const taskItems = (evaluate) => evaluate(`(() => {
  const editor = ${VISIBLE_EDITOR}
  return [...(editor?.querySelectorAll('.milkdown-list-item-block') || [])].map((item) => ({
    checked: item.querySelector('.label.checked') ? true
      : item.querySelector('.label.unchecked') ? false : null,
    label: item.querySelector('.children')?.textContent ?? null
  }))
})()`)

// Is the DOM caret inside a task item's paragraph? The insert is only a
// success if the user can type the label without any further gesture.
const caretInTask = (evaluate) => evaluate(`(() => {
  const sel = window.getSelection()
  const node = sel?.anchorNode
  const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null
  return !!el?.closest?.('.milkdown-list-item-block')
})()`)

async function save(evaluate) {
  await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
  await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)
  let app
  let reopened
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    const { evaluate, send } = app
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('甲乙丙丁') && text.includes('尾段落。') ? text : null
    }, 'initial document did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on plain mount')

    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await sleep(300)
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy fallback for this fixture: ${attachDiagnostics}`)

    // ============================================================
    // 1) `/task` -> a real checkbox, caret in the item, label typed
    //    IMMEDIATELY (the main flow) -> the seed dissolves.
    // ============================================================
    await selectBlock(evaluate, send, '甲乙丙丁')
    await runTaskItem(evaluate, send)

    const itemsAfterInsert = await taskItems(evaluate)
    console.log('  [/task #1] ->', JSON.stringify(itemsAfterInsert))
    assert.deepEqual(itemsAfterInsert, [{ checked: false, label: NBSP }],
      'the checkbox must appear immediately, holding exactly the seed')
    assert.equal(await caretInTask(evaluate), true,
      'the caret must land inside the new task item — a task you cannot label is worse than a blocked item')

    // ============================================================
    // 1b) THE AUDIT'S KEYSTROKE (2026-08-20, Critical): Backspace on the
    //     fresh seed must REFUSE LOUDLY. Pre-fix, syntax-index classified the
    //     seeded item EMPTY (String.trim() strips U+00A0), the structural
    //     route ran exit-empty-list-item, and this exact keystroke silently
    //     deleted the checkbox — zero toasts, a caret-unmappable diagnostic,
    //     and item-less bytes on the next save — while the guide documented
    //     it as refused.
    // ============================================================
    await evaluate(`(() => {
      window.__ieToasts = []
      if (!window.__ieToastHook) {
        window.__ieToastHook = true
        window.addEventListener('hm:toast', (e) => window.__ieToasts.push(e.detail?.msg ?? String(e.detail)))
      }
      return 1
    })()`)
    const diagnosticsBefore = await evaluate(`(window.__hmKernelDiagnostics || []).length`)
    {
      const bs = { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }
      // A REAL keyDown (not rawKeyDown): the fixed path lets the keymap pass
      // the key through, so the deletion must come from Chromium's own
      // editing command for the gateway wall to be the thing that stops it.
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...bs })
      await sleep(20)
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...bs })
    }
    await sleep(600)
    const itemsAfterBackspace = await taskItems(evaluate)
    console.log('  [backspace on seed] ->', JSON.stringify(itemsAfterBackspace))
    assert.deepEqual(itemsAfterBackspace, [{ checked: false, label: NBSP }],
      'the checkbox must survive the refused Backspace — pre-fix it vanished on this keystroke')
    const backspaceToasts = JSON.parse(await evaluate(`JSON.stringify(window.__ieToasts || [])`))
    assert.ok(backspaceToasts.length >= 1,
      `the refusal must be LOUD — pre-fix this keystroke was silent (got ${JSON.stringify(backspaceToasts)})`)
    assert.ok(backspaceToasts.some((message) => /任务项|task item/i.test(message)),
      `the toast must name the empty-task wall and its exits — got ${JSON.stringify(backspaceToasts)}`)
    const backspaceDiagnostics = await evaluate(
      `JSON.stringify((window.__hmKernelDiagnostics || []).slice(${diagnosticsBefore}))`)
    assert.ok(!backspaceDiagnostics.includes('caret-unmappable'),
      `no silent caret failure may be recorded — got ${backspaceDiagnostics}`)

    // The documented exit stays real: typing the label still dissolves the
    // seed (the flow below is the pre-existing main-path assertion).
    await typeTextLikeUser(send, '待办事项', { delayMs: delay })
    await sleep(500)
    const afterFirst = FIXTURE.replace('甲乙丙丁', '- [ ] 待办事项')
    const sourceAfterFirst = await readSource(evaluate, 'first label')
    assert.equal(sourceAfterFirst, afterFirst,
      `typing the label must DISSOLVE the seed (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)
    assert.ok(!sourceAfterFirst.includes(NBSP), 'no U+00A0 survives the dissolve')

    // ============================================================
    // 2) The AWKWARD INSTANT: `/task` (click activation this time), then SAVE
    //    before any label. The file must hold a REAL checked:false task —
    //    this is the improvement over legacy, which demotes the transient to
    //    plain "- [ ]" text on save.
    // ============================================================
    await selectBlock(evaluate, send, '戊己庚辛')
    await runTaskItem(evaluate, send, { activate: 'click' })
    await save(evaluate)

    const awkwardDisk = await readFile(file, 'utf8')
    assert.equal(awkwardDisk, FIXTURE
      .replace('甲乙丙丁', '- [ ] 待办事项')
      .replace('戊己庚辛', SEED_LINE),
      'the awkward-instant save must write the seed spelling, byte for byte')
    const awkwardItems = parseKernelMarkdown(awkwardDisk).children
      .filter((node) => node.type === 'list')
      .map((list) => list.children[0].checked)
    assert.deepEqual(awkwardItems, [false, false],
      'BOTH items on disk are REAL tasks (checked:false) — the seed survives as a task, never as literal "[ ]" text')

    // ============================================================
    // 3) The label typed AFTER the save + focus round-trip: the session
    //    ledger still vouches for the seed, so it still dissolves. Click back
    //    into the seed item first (the save fab took focus).
    // ============================================================
    const seedRect = await waitFor(() => charRect(evaluate, NBSP, 0, 1),
      'could not locate the seed paragraph to click back into')
    await click(send, { x: seedRect.right + 1, y: seedRect.top + seedRect.height / 2 })
    await sleep(300)
    await typeTextLikeUser(send, '补充', { delayMs: delay })
    await sleep(500)

    const finalExpected = FIXTURE
      .replace('甲乙丙丁', '- [ ] 待办事项')
      .replace('戊己庚辛', '- [ ] 补充')
    const finalSource = await readSource(evaluate, 'second label')
    assert.equal(finalSource, finalExpected,
      `the seed must dissolve even after a save + focus round-trip (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)
    assert.ok(!finalSource.includes(NBSP), 'no U+00A0 anywhere in the final source')

    await save(evaluate)
    const finalDisk = await readFile(file, 'utf8')
    assert.equal(finalDisk, finalExpected, 'final disk bytes match the kernel-derived expectation exactly')
    assert.equal(app.dialogs.length, 0,
      `no dialog may appear: ${JSON.stringify(app.dialogs.map((d) => d.message))}`)

    // ============================================================
    // 4) COLD REOPEN: a full relaunch renders both checkboxes from the saved
    //    bytes — the file is the only truth that survives, and it is enough.
    // ============================================================
    await stopBuiltElectron(app, { removeProfile: true })
    app = null
    reopened = await launchBuiltElectron({ profileDir: join(root, 'profile-reopen'), port: port + 1, appArgs: [file] })
    await waitFor(async () => {
      const text = await mounted(reopened.evaluate)
      return text && text.includes('待办事项') && text.includes('补充') ? text : null
    }, 'reopened document did not mount')
    const reopenedItems = await taskItems(reopened.evaluate)
    console.log('  [cold reopen] ->', JSON.stringify(reopenedItems))
    assert.deepEqual(reopenedItems, [
      { checked: false, label: '待办事项' },
      { checked: false, label: '补充' }
    ], 'both tasks survive a cold reopen as REAL checkboxes with exact labels')
    assert.equal(await readFile(file, 'utf8'), finalExpected, 'reopen must not rewrite the file')
    assert.equal(reopened.dialogs.length, 0, 'no dialog on reopen')

    console.log('PASS kernel-mode /task UI regression: the slash item creates a real checkbox with a typable caret, the seed dissolves under the label (immediately AND after an awkward-instant save), and both tasks survive a cold reopen')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await stopBuiltElectron(reopened, { removeProfile: true })
  }
}

// ===========================================================================
// IME first-label segment (2026-08-20 adversarial panel, Important): the main
// run above types the label in ASCII, which reaches the dissolve through the
// gateway's plain-text branch. A COMPOSED label — the NORMAL way a Chinese
// user types it — reaches the kernel through the composition session's ONE
// write path instead (editor-kernel-mode.js `commitReplace`), which used to
// carry only the trailing-whitespace heal. Pre-fix, the committed word landed
// AFTER the seed and permanently embedded the kernel-authored U+00A0 at the
// label's start: disk bytes `- [ ] <U+00A0>买菜` where ASCII typing yields
// `- [ ] 买菜`, unfixable afterwards (the seed can only dissolve while it is
// the block's ENTIRE content). This segment fails pre-fix at the first
// source assertion, showing that embedded U+00A0.
//
// `imeType` is copied verbatim from scripts/test-kernel-ime-ui.mjs:159-173
// (itself from test-ime-source-fidelity-ui.mjs:47-69, the proven
// real-composition driver): per-pinyin-letter rawKeyDown/keyUp INTERLEAVED
// with Input.imeSetComposition, committed via Input.insertText — the
// interleaving is load-bearing for composition-lifecycle coverage.
// ===========================================================================
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
    await sleep(delay)
  }
  await sleep(delay)
  await send('Input.insertText', { text: cjk }) // commit → compositionend
  await sleep(delay)
}

async function runImeFirstLabelSegment() {
  const segRoot = `/tmp/horsemd-kernel-task-ime-${process.pid}`
  const segFile = join(segRoot, 'task-ime.md')
  const SEG_LINES = ['# 标题', '', '甲乙丙丁', '', '尾段落。', '']
  const SEG_FIXTURE = SEG_LINES.join('\n')

  await rm(segRoot, { recursive: true, force: true })
  await mkdir(segRoot, { recursive: true })
  await writeFile(segFile, SEG_FIXTURE)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(segRoot, 'profile'), port: port + 2, appArgs: [segFile] })
    const { evaluate, send } = app
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('甲乙丙丁') && text.includes('尾段落。') ? text : null
    }, 'IME segment: initial document did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on plain mount (IME segment)')

    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`),
      'IME segment: kernel mode did not remount the tab')
    await sleep(300)
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!attachDiagnostics.includes('attach-unmappable'),
      `IME segment: kernel mode degraded to legacy fallback: ${attachDiagnostics}`)

    // 1) `/task`, then the FIRST label via a real composition: the seed must
    //    dissolve under the committed word exactly as it does under an ASCII
    //    keystroke — same bytes, no U+00A0.
    await selectBlock(evaluate, send, '甲乙丙丁')
    await runTaskItem(evaluate, send)
    const itemsAfterInsert = await taskItems(evaluate)
    console.log('  [/task IME segment] ->', JSON.stringify(itemsAfterInsert))
    assert.deepEqual(itemsAfterInsert, [{ checked: false, label: NBSP }],
      'the checkbox must appear immediately, holding exactly the seed')
    assert.equal(await caretInTask(evaluate), true, 'the caret must land inside the new task item')

    await imeType(send, 'maicai', '买菜')
    await waitFor(async () => (await mounted(evaluate) || '').includes('买菜'),
      'composed 买菜 never reached the kernel-mode editor')
    const itemsAfterIme = await taskItems(evaluate)
    console.log('  [IME first label] ->', JSON.stringify(itemsAfterIme))
    assert.deepEqual(itemsAfterIme, [{ checked: false, label: '买菜' }],
      'the composed label must REPLACE the seed on screen — no leading placeholder character')

    const afterIme = SEG_FIXTURE.replace('甲乙丙丁', '- [ ] 买菜')
    const sourceAfterIme = await readSource(evaluate, 'IME first label')
    assert.equal(sourceAfterIme, afterIme,
      `the IME-committed first label must DISSOLVE the seed (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)
    assert.ok(!sourceAfterIme.includes(NBSP), 'no U+00A0 survives the IME dissolve')

    // 2) Control: a SECOND composition after the label has no seed to claim —
    //    it appends, deletes nothing (the ledger entry died with the dissolve).
    const labelRect = await waitFor(() => charRect(evaluate, '买菜', 0, 2),
      'could not locate the dissolved task paragraph to click back into')
    await click(send, { x: labelRect.right + 1, y: labelRect.top + labelRect.height / 2 })
    await sleep(300)
    await imeType(send, 'jixu', '继续')
    await waitFor(async () => (await mounted(evaluate) || '').includes('买菜继续'),
      'the second composed word never reached the editor')
    const finalExpected = SEG_FIXTURE.replace('甲乙丙丁', '- [ ] 买菜继续')
    const finalSource = await readSource(evaluate, 'IME after label')
    assert.equal(finalSource, finalExpected,
      'a composition after the label is a literal append — nothing dissolves twice')

    // 3) Save + reparse: the file holds a REAL checked:false task whose label
    //    is exactly the two composed words, and no U+00A0 anywhere.
    await save(evaluate)
    const disk = await readFile(segFile, 'utf8')
    assert.equal(disk, finalExpected, 'disk bytes match the kernel-derived expectation exactly')
    assert.ok(!disk.includes(NBSP), 'no U+00A0 on disk')
    const diskItems = parseKernelMarkdown(disk).children
      .filter((node) => node.type === 'list')
      .map((list) => [list.children[0].checked, list.children[0].children[0].children.map((n) => n.value ?? '').join('')])
    assert.deepEqual(diskItems, [[false, '买菜继续']],
      'the saved bytes reparse to a real task with exactly the composed label')
    assert.equal(app.dialogs.length, 0,
      `no dialog may appear in the IME segment: ${JSON.stringify(app.dialogs.map((d) => d.message))}`)

    console.log('PASS kernel-mode /task IME segment: a composed first label dissolves the seed byte-identically to ASCII typing, a second composition appends without claiming anything, and the saved file reparses to the exact label')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

async function main() {
  await run()
  await runImeFirstLabelSegment()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
