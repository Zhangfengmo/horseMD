// Kernel-mode marks + quote domain end-to-end UI regression (source-kernel
// integration Plan 4, Task 5).
//
// P4-1..P4-4 landed the mark-map/toggle-command/gateway-routing/quote-domain
// pieces and locked them with headless + nodeview-ui tests, but NONE of those
// exercised the real toolbar/ctxmenu/keyboard/slash surfaces end-to-end with
// REAL mouse drags and REAL keystrokes the way this script does — see
// task-5-report.md for the two real bugs this uncovered while doing so (both
// in the kernel-mode `/quote` slash wiring, both fixed, both locked below).
//
// Every "expected bytes" string is DERIVED, not guessed: it is the literal
// output of running the exact same sequence of kernel primitives
// (toggleInlineMark / applySourceTransaction, imported straight from
// src/renderer/src/lib/source-kernel) against this fixture — see the task
// report's derivation transcript. The kernel is the oracle; this script only
// proves the live UI reaches the same bytes.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-marks-${process.pid}`
const file = join(root, 'marks.md')
const port = Number(process.env.CDP_PORT || 10024)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

const FIXTURE = [
  '# 标题',
  '',
  '首段落用于占位说明。',
  '',
  '甲乙丙丁',
  '',
  '戊己庚辛',
  '',
  '壬癸子丑',
  '',
  '寅卯辰巳',
  '',
  '**已加粗**',
  '',
  '前午未申酉后段尾',
  '',
  '壹贰叁肆',
  '',
  '伍陆柒捌',
  '',
  'z',
  '',
  '- 列项一',
  '',
  '- 列项二',
  '',
  '尾段落。',
  ''
].join('\n')

// ---- kernel-oracle-derived byte checkpoints (see task-5-report.md) ----
const AFTER_A = FIXTURE.replace('甲乙丙丁', '**甲乙丙丁**')
const AFTER_B = FIXTURE // wrap+unwrap nets to zero change, byte-identical
const AFTER_C = FIXTURE.replace('戊己庚辛', '*戊己庚辛*')
const AFTER_D = AFTER_C.replace('壬癸子丑', '**壬癸子丑**')
const AFTER_E = AFTER_D.replace('寅卯辰巳', '`寅卯辰巳`')
const AFTER_F = AFTER_E.replace('前午未申酉后段尾', '前**午未申酉**后段尾')
const AFTER_TYPING = AFTER_F.replace('前**午未申酉**后段尾', '前X**午未申酉**后Y段尾Z')
// Highlight refusal (M4 pin), link refusal (no kernel kind), and the /quote
// placeholder refusal (empty-blockquote projection guard, this task's fix)
// are all byte-neutral EXCEPT the "/quote" text itself, which the TYPING of
// the query commits as ordinary plain text (only the WRAP click is refused).
const AFTER_QUOTE_QUERY = AFTER_TYPING.replace('\n\nz\n\n', '\n\n/quote\n\n')
const SAVED = AFTER_QUOTE_QUERY

async function waitFor(check, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`
const VISIBLE_TOOLBAR = `[...document.querySelectorAll('.milkdown-toolbar')].find((tb) => {
  const r = tb.getBoundingClientRect()
  const s = getComputedStyle(tb)
  return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'
})`

const mounted = (evaluate) => evaluate(`(${VISIBLE_EDITOR})?.textContent`)
const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)
const paragraphTexts = (evaluate) => evaluate(`[...(${VISIBLE_EDITOR})?.querySelectorAll('p') || []].map((n) => n.textContent)`)

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

async function assertSource(evaluate, expected, message) {
  await toggleSourceMode(evaluate)
  const shown = await waitFor(() => visibleSource(evaluate), `source view did not appear (${message})`)
  assert.equal(shown, expected, message)
  await toggleSourceMode(evaluate)
  await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), `rich view did not return (${message})`)
  await sleep(150)
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

// Character-offset Range lookup within a paragraph located by its CURRENT
// full rendered (visible, marker-free) text — walks all of the paragraph's
// text nodes (a marked run splits it into several), so this works whether
// the paragraph is plain or already contains marks.
async function charRect(evaluate, paragraphText, from, to) {
  return evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p') || [])].find((n) => n.textContent === ${JSON.stringify(paragraphText)})
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
    if (!rect) return null
    return { left: rect.left, right: rect.right, top: rect.top, height: rect.height }
  })()`)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

// Real mouse drag across [from,to) of `paragraphText` — the positive control
// (toolbar appears on selection) plus the actual selection every toggle
// below acts on.
async function selectRange(evaluate, send, paragraphText, from, to) {
  let point = null
  // A drag right after a rich<->source mode-switch round trip can race the
  // view's own focus/selection restore (the mousedown lands before the view
  // has re-taken focus) and silently produce an EMPTY selection — retry the
  // whole drag rather than trusting one attempt.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rect = await waitFor(() => charRect(evaluate, paragraphText, from, to),
      `could not locate range [${from},${to}) in ${JSON.stringify(paragraphText)}`)
    const y = rect.top + Math.min(12, rect.height / 2)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.left + 1, y, button: 'left', clickCount: 1 })
    for (let step = 1; step <= 4; step += 1) {
      const x = rect.left + ((rect.right - rect.left) * step) / 4
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.max(rect.right - 1, rect.left + 1), y, button: 'left', clickCount: 1 })
    await sleep(250)
    point = { x: rect.left, y }
    if (await selectionNonEmpty(evaluate)) return point
    await sleep(200)
  }
  assert.fail(`drag-select never produced a non-empty selection for [${from},${to}) in ${JSON.stringify(paragraphText)}`)
  return point
}

// Collapsed-range caret placement at a specific character offset.
async function clickAt(evaluate, send, paragraphText, offset) {
  const rect = await waitFor(() => charRect(evaluate, paragraphText, offset, offset),
    `could not locate caret offset ${offset} in ${JSON.stringify(paragraphText)}`)
  const point = { x: rect.left, y: rect.top + Math.min(12, rect.height / 2) }
  await click(send, point)
  await sleep(150)
}

async function selectionNonEmpty(evaluate) {
  return evaluate(`(() => { const s = window.getSelection(); return !!s && s.toString().length > 0 })()`)
}

function toolbarButtonExpr(index) {
  return `(${VISIBLE_TOOLBAR})?.querySelectorAll(".toolbar-item:not(.hm-heading-item):not(.hm-highlight-item):not(.hm-review-item)")[${index}]`
}

async function clickToolbarButton(evaluate, send, index) {
  const rect = await waitFor(() => evaluate(`(() => {
    const b = ${toolbarButtonExpr(index)}
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`), `toolbar button ${index} not found/visible`)
  await click(send, rect)
  await sleep(300)
}

async function clickHighlightYellow(evaluate, send) {
  const itemRect = await waitFor(() => evaluate(`(() => {
    const it = (${VISIBLE_TOOLBAR})?.querySelector('.hm-highlight-item')
    const r = it?.getBoundingClientRect()
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  })()`), 'highlight toolbar item not found')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...itemRect })
  await sleep(200)
  const swatchRect = await waitFor(() => evaluate(`(() => {
    const sw = (${VISIBLE_TOOLBAR})?.querySelector('.hm-highlight-item .hm-hl-swatch.hm-hl-yellow')
    const r = sw?.getBoundingClientRect()
    return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  })()`), 'highlight yellow swatch not hit-testable (hover state?)')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...swatchRect })
  await click(send, swatchRect)
  await sleep(300)
}

async function openCtxMenuAt(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'right', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'right', clickCount: 1 })
}

async function closeCtxMenu(evaluate) {
  await evaluate(`document.querySelector('.menu-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await sleep(150)
}

// `Mod-<letter>` — Meta on darwin, same convention every other kernel-mode
// UI script's pressUndo() uses.
async function pressMod(send, key, code, keyCode) {
  const params = { key, code, modifiers: 4, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  await sleep(delay)
}

async function pressUndo(send) {
  await pressMod(send, 'z', 'KeyZ', 90)
}

async function pressRedo(send) {
  const params = { key: 'z', code: 'KeyZ', modifiers: 12, windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 } // Shift+Meta
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  await sleep(delay)
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    let { evaluate, send } = app
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('甲乙丙丁') && text.includes('列项二') ? text : null
    }, 'initial document did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on plain mount')

    // ---- 1) enable kernel mode + live-attach assert ----
    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('甲乙丙丁') && text.includes('列项二') ? text : null
    }, 'document did not remount after enabling kernel mode')
    await sleep(300)
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy fallback for this fixture: ${attachDiagnostics}`)

    // ============================================================
    // 2) plain word -> toolbar Bold wrap -> Bold again to unwrap
    // ============================================================
    await selectRange(evaluate, send, '甲乙丙丁', 0, 4)
    const selNonEmpty = await selectionNonEmpty(evaluate)
    assert.ok(selNonEmpty, 'drag selection did not select any text')
    const toolbarShown = await waitFor(() => evaluate(`!!(${VISIBLE_TOOLBAR})`), 'selection toolbar did not appear (positive control)')
    assert.ok(toolbarShown, 'toolbar must appear on a real selection before any toggle')

    await clickToolbarButton(evaluate, send, 0) // bold
    await assertSource(evaluate, AFTER_A, 'toolbar Bold must wrap the selected word with **')

    // Re-select (content selection is not guaranteed to have survived the
    // rich<->source round trip the byte-assert above performed).
    await selectRange(evaluate, send, '甲乙丙丁', 0, 4)
    await clickToolbarButton(evaluate, send, 0) // bold again -> unwrap
    await assertSource(evaluate, AFTER_B, 'clicking Bold again must unwrap back to the original bytes')

    // ============================================================
    // 6) HIGHLIGHT REFUSAL PIN (M4): select -> toolbar highlight -> bytes
    //    unchanged, doc still mapped (proven immediately below by a real
    //    successful byte round trip riding the SAME kernel.map). Done here,
    //    right after step 2, while the selection toolbar is still on — step
    //    3a below turns the toolbar SETTING off for the ctxmenu test and
    //    never turns it back on.
    // ============================================================
    await selectRange(evaluate, send, '壹贰叁肆', 0, 4)
    const beforeHighlight = await paragraphTexts(evaluate)
    await clickHighlightYellow(evaluate, send)
    const afterHighlight = await paragraphTexts(evaluate)
    assert.deepEqual(afterHighlight, beforeHighlight, 'highlight toggle must be refused (bytes unchanged) — projection map has no == pairing yet')

    // ============================================================
    // 7) Link toolbar button -> blocked, bytes unchanged
    // ============================================================
    await selectRange(evaluate, send, '伍陆柒捌', 0, 4)
    const beforeLink = await paragraphTexts(evaluate)
    await clickToolbarButton(evaluate, send, 4) // link
    const afterLink = await paragraphTexts(evaluate)
    assert.deepEqual(afterLink, beforeLink, 'link toggle must be blocked (bytes unchanged)')

    // Prove the kernel map is STILL live after both refusals: a real,
    // successful byte-assert round trip.
    await assertSource(evaluate, AFTER_B, 'kernel.map must still be intact after the highlight/link refusals (no byte drift)')

    // ============================================================
    // 3a) ctxmenu Italic on a second word (needs the selection-toolbar
    //     SETTING off — the ctxmenu's FORMAT submenu is its fallback)
    // ============================================================
    const settingsOpened = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((node) => {
        const rect = node.getBoundingClientRect()
        return rect.width && rect.height && /设置|Settings/.test(node.title || node.textContent || '')
      })
      button?.click()
      return Boolean(button)
    })()`)
    assert.ok(settingsOpened, 'Settings button is missing')
    await waitFor(() => evaluate(`[...document.querySelectorAll('button')].some((node) => /编辑器|Editor/.test(node.textContent || '') && node.offsetParent)`),
      'Editor settings tab is missing')
    await evaluate(`[...document.querySelectorAll('button')].find((node) => /编辑器|Editor/.test(node.textContent || '') && node.offsetParent)?.click()`)
    await waitFor(() => evaluate(`[...document.querySelectorAll('.settings-row')].some((row) => /选中文字时显示浮动工具栏|Selection toolbar/.test(row.textContent || ''))`),
      'Selection toolbar setting is missing')
    const toggledOff = await evaluate(`(() => {
      const row = [...document.querySelectorAll('.settings-row')].find((node) => /选中文字时显示浮动工具栏|Selection toolbar/.test(node.textContent || ''))
      const toggle = row?.querySelector('.hm-toggle')
      toggle?.click()
      return Boolean(toggle)
    })()`)
    assert.ok(toggledOff, 'selection toolbar toggle is missing')
    await sleep(150)
    const fixtureTabExists = await evaluate(`!![...document.querySelectorAll('.tab')].find((node) => (node.textContent || '').includes('marks.md'))`)
    assert.ok(fixtureTabExists, "this fixture's own tab is missing after opening settings")
    await evaluate(`[...document.querySelectorAll('.tab')].find((node) => (node.textContent || '').includes('marks.md'))?.click()`)
    await waitFor(async () => (await mounted(evaluate) || '').includes('列项二'), 'document did not return after settings')
    await sleep(200)

    const italicPoint = await selectRange(evaluate, send, '戊己庚辛', 0, 4)
    await openCtxMenuAt(send, { x: italicPoint.x + 4, y: italicPoint.y })
    await waitFor(() => evaluate(`!!document.querySelector('.block-ctxmenu')`), 'right-click context menu did not open')
    const triggerRect = await waitFor(() => evaluate(`(() => {
      const t = document.querySelector('[data-context-submenu-trigger="format"]')
      const r = t?.getBoundingClientRect()
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
    })()`), 'format submenu trigger missing')
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...triggerRect })
    await sleep(200)
    const italicItemRect = await waitFor(() => evaluate(`(() => {
      const items = [...document.querySelectorAll('[data-context-submenu="format"] .block-text-format')]
      const it = items[1]
      const r = it?.getBoundingClientRect()
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
    })()`), 'italic ctxmenu item missing')
    await click(send, italicItemRect)
    await sleep(300)
    assert.equal(app.dialogs.length, 0, 'no dialog from the ctxmenu italic interaction')
    await assertSource(evaluate, AFTER_C, 'ctxmenu Italic must wrap the selected word with *')

    // ============================================================
    // 3b) Mod-B keyboard on a third word
    // ============================================================
    await selectRange(evaluate, send, '壬癸子丑', 0, 4)
    await pressMod(send, 'b', 'KeyB', 66)
    await sleep(250)
    await assertSource(evaluate, AFTER_D, 'Mod-B must wrap the selected word with **')

    // ============================================================
    // 4) inline code toggle (Mod-e) on a multi-char word — pins P4-3.5's fix
    // ============================================================
    await selectRange(evaluate, send, '寅卯辰巳', 0, 4)
    await pressMod(send, 'e', 'KeyE', 69)
    await sleep(250)
    await assertSource(evaluate, AFTER_E, 'Mod-e must wrap the multi-char word with backticks')

    // ============================================================
    // 5) TYPING-AFTER-BOLD matrix (pins P4-3.5 Fix B)
    // ============================================================
    await selectRange(evaluate, send, '前午未申酉后段尾', 1, 5) // 午未申酉
    await pressMod(send, 'b', 'KeyB', 66)
    await sleep(250)
    await assertSource(evaluate, AFTER_F, 'bolding 午未申酉 must wrap it with **')

    // (a) before the bold run.
    await clickAt(evaluate, send, '前午未申酉后段尾', 1)
    await typeTextLikeUser(send, 'X', { delayMs: delay })
    await waitFor(async () => (await mounted(evaluate) || '').includes('前X午未申酉后段尾'), 'typed X before the bold run never landed')

    // (b) shortly after the bold run (trailing plain run, one char in from
    // the boundary — the exact razor-edge boundary is a documented,
    // deferred residual gap, see task-3.5-report.md's "Residual gaps": the
    // everyday "keep typing right after a bold word" gesture inherits the
    // mark by ProseMirror's own inclusive:true default and still refuses).
    await clickAt(evaluate, send, '前X午未申酉后段尾', 7)
    await typeTextLikeUser(send, 'Y', { delayMs: delay })
    await waitFor(async () => (await mounted(evaluate) || '').includes('前X午未申酉后Y段尾'), 'typed Y after the bold run never landed')

    // (c) far plain text — end of the paragraph.
    await clickAt(evaluate, send, '前X午未申酉后Y段尾', 10)
    await typeTextLikeUser(send, 'Z', { delayMs: delay })
    await waitFor(async () => (await mounted(evaluate) || '').includes('前X午未申酉后Y段尾Z'), 'typed Z at paragraph end never landed')
    await sleep(200)

    await assertSource(evaluate, AFTER_TYPING, 'the before/after/far-plain typing matrix must commit at the exact derived raw offsets')

    // (d) INSIDE the bold word -> refused. Assert via byte stability only
    // (content unchanged), never the toast DOM.
    await clickAt(evaluate, send, '前X午未申酉后Y段尾Z', 4) // between 未 and 申
    const beforeInside = await paragraphTexts(evaluate)
    await typeTextLikeUser(send, 'W', { delayMs: delay })
    await sleep(300)
    const afterInside = await paragraphTexts(evaluate)
    assert.deepEqual(afterInside, beforeInside, 'typing inside the bold word content must be refused (bytes unchanged)')

    // ============================================================
    // 8) `/quote` slash item — the ONLY reachable invocation is on a block
    //    whose ENTIRE raw text is the typed query (shouldShow requires
    //    atEndOfBlock + text.startsWith('/') on the FULL block text — an
    //    existing populated paragraph, and any block inside a list
    //    (isInList), can never reach this menu at all). On that one
    //    reachable shape the wrap is a genuine architectural dead end (a
    //    bare '>' marker with nothing else reparses to a ZERO-child mdast
    //    blockquote, which ProseMirror's `content: "block+"` schema can
    //    never represent) — this task's fix makes it refuse SAFELY
    //    (fail-closed, requireMap) instead of the two real bugs found while
    //    building this: embedding the literal query text, or silently
    //    vanishing the paragraph. See task-5-report.md for the full probe
    //    transcript.
    // ============================================================
    await selectRange(evaluate, send, 'z', 0, 1)
    await typeTextLikeUser(send, '/quote', { delayMs: delay })
    await waitFor(() => evaluate(`document.querySelectorAll('.milkdown-slash-menu[data-show="true"] .hm-slash-item').length > 0`),
      'slash menu did not open for the /quote query')
    const items = await evaluate(`[...document.querySelectorAll('.milkdown-slash-menu[data-show="true"] .hm-slash-item')].map((n) => n.dataset.id)`)
    assert.deepEqual(items, ['quote'], `only 'quote' should match the /quote query: ${JSON.stringify(items)}`)
    const quotePoint = await waitFor(() => evaluate(`(() => {
      const li = document.querySelector('.milkdown-slash-menu[data-show="true"] .hm-slash-item[data-id="quote"]')
      const r = li?.getBoundingClientRect()
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
    })()`), 'quote slash item is not hit-testable')
    await click(send, quotePoint)
    await sleep(400)
    assert.equal(app.dialogs.length, 0, 'no dialog from the /quote refusal')
    await assertSource(evaluate, AFTER_QUOTE_QUERY,
      'the /quote wrap must be refused fail-closed: the typed query text commits as plain text, but no blockquote marker is added')

    // ============================================================
    // 8b) `/quote` inside the loose list never even opens the menu
    //     (isInList guard) — the list itself stays byte-untouched.
    // ============================================================
    await clickAt(evaluate, send, '列项一', 3)
    await typeTextLikeUser(send, '/', { delayMs: delay })
    await sleep(300)
    const menuShownInList = await evaluate(`document.querySelector('.milkdown-slash-menu')?.getAttribute('data-show')`)
    assert.equal(menuShownInList, 'false', 'the slash menu must never open inside a list item')
    // Undo the stray '/' so the list stays byte-identical to the fixture.
    await pressUndo(send)
    await waitFor(async () => !(await paragraphTexts(evaluate)).some((t) => t.includes('/列项一')), 'stray / inside the list was not undone')
    await sleep(200)

    // ============================================================
    // 9) undo chain sanity — spot-check 2 discrete groups. The most recent
    //    two kernel-history groups at this point are: the /quote query text
    //    commit (step 8), and the far-plain 'Z' typed insert (step 5c) —
    //    each undo must revert exactly ONE of them.
    // ============================================================
    await pressUndo(send) // reverts the /quote query text commit
    await sleep(250)
    await assertSource(evaluate, AFTER_TYPING, 'undo #1 must revert exactly the /quote query text group')

    await pressUndo(send) // reverts the far-plain 'Z' insert
    await sleep(250)
    const AFTER_TYPING_MINUS_Z = AFTER_F.replace('前**午未申酉**后段尾', '前X**午未申酉**后Y段尾')
    await assertSource(evaluate, AFTER_TYPING_MINUS_Z, 'undo #2 must revert exactly the far-plain Z insert group')

    await pressRedo(send)
    await sleep(250)
    await pressRedo(send)
    await sleep(250)
    await assertSource(evaluate, AFTER_QUOTE_QUERY, 'redo x2 must restore the pre-undo state exactly')

    // ============================================================
    // 10) Save FAB -> disk bytes exact; dialogs empty; full quit; cold
    //     reopen -> bytes intact.
    // ============================================================
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    assert.equal(await readFile(file, 'utf8'), SAVED, 'disk bytes must match the derived expectation exactly')
    assert.equal(app.dialogs.length, 0, `no rebuild prompt may appear: ${JSON.stringify(app.dialogs.map((d) => d.message))}`)

    await stopBuiltElectron(app, { removeProfile: false })
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, cleanProfile: false, appArgs: [file] })
    ;({ evaluate, send } = app)
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('quote') && text.includes('列项二') ? text : null
    }, 'reopened document did not mount with the saved content')
    await toggleSourceMode(evaluate)
    const reopened = await waitFor(() => visibleSource(evaluate), 'source view did not appear after cold reopen')
    assert.equal(reopened, SAVED, 'cold reopen must reproduce the saved kernel-mode bytes exactly, byte-for-byte')
    assert.equal(app.dialogs.length, 0, 'no rebuild prompt may appear on cold reopen')

    console.log('PASS kernel-mode marks + quote domain UI regression: toolbar/ctxmenu/keyboard mark toggles, inline code, the typing-after-bold matrix, highlight/link refusals, the /quote fail-closed fix, undo/redo groups, save and cold reopen all match the kernel-derived byte strings')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
