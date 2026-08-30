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

// Isolated fixture for the legacy multi-paragraph unquote regression
// (reviewer Important #2) — a standalone app session/file, not the main
// FIXTURE above, so the unwrap doesn't have to be reverted to keep the rest
// of this script's byte checkpoints valid.
const multiQuoteFile = join(root, 'multi-quote.md')
const MULTI_QUOTE_FIXTURE = '> 引一\n>\n> 引二\n>\n> 引三\n'
const MULTI_QUOTE_UNWRAPPED = '引一\n\n引二\n\n引三\n'

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
  '```js',
  'const 代码 = 1;',
  '```',
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
// P5-3: the highlight toolbar button now COMMITS (it used to be refused).
// Wrap then unwrap nets to zero change, so every later checkpoint is
// unaffected — same shape as the Bold wrap/unwrap in step 2.
const AFTER_HIGHLIGHT = FIXTURE.replace('壹贰叁肆', '==壹贰叁肆==')
// P5-6: the link toolbar button now COMMITS (it used to be refused). Wrap ->
// change URL -> remove nets to zero change, so every later checkpoint is
// unaffected — same shape as the Bold and highlight wrap/unwrap pairs.
const LINK_URL = 'https://x.example'
const LINK_URL_2 = 'https://y.example'
const AFTER_LINK = FIXTURE.replace('伍陆柒捌', `[伍陆柒捌](${LINK_URL})`)
const AFTER_LINK_EDIT = FIXTURE.replace('伍陆柒捌', `[伍陆柒捌](${LINK_URL_2})`)
// `/quote` COMMITS since 2026-08-19 (before that it refused every time — the
// empty-blockquote projection guard). Two byte states matter here: what the
// TYPED query leaves in the source, and what the item's own kernel transaction
// replaces it with (a real, empty blockquote).
const AFTER_QUOTE_QUERY = AFTER_TYPING.replace('\n\nz\n\n', '\n\n/quote\n\n')
const AFTER_QUOTE_WRAP = AFTER_TYPING.replace('\n\nz\n\n', '\n\n>\n\n')
const SAVED = AFTER_QUOTE_WRAP

// ---- Plan 4 Task 5.5: right-click ctxmenu quote/unquote byte checkpoints ----
// LEGACY (before kernel mode is ever enabled): a plain PM wrapIn/lift
// dispatch through the normal markdownUpdated/preservation pipeline. Single
// standalone paragraph, no other block on its line — the generic
// preserveSource diff has nothing else to touch, so the byte delta is
// exactly a "> " prefix on that one line (captured against the live app;
// see task-5.5-report.md's derivation transcript).
const LEGACY_AFTER_QUOTE = FIXTURE.replace('首段落用于占位说明。', '> 首段落用于占位说明。')
// KERNEL (after step 9's redo chain, i.e. against AFTER_QUOTE_WRAP): a single
// trailing paragraph wraps the same as test-source-kernel-quote.mjs's basic
// case ("text\n" -> "> text\n"). The loose list (blank line between items)
// wraps like that same file's loose-list case: the blank separator line
// becomes a BARE '>' so the reparse stays one blockquote, not two.
const KERNEL_PARA_QUOTED = AFTER_QUOTE_WRAP.replace('尾段落。', '> 尾段落。')
const KERNEL_LIST_QUOTED = AFTER_QUOTE_WRAP.replace('- 列项一\n\n- 列项二', '> - 列项一\n>\n> - 列项二')
// Heading (minor ride-along): same shape as test-source-kernel-quote.mjs's
// heading case ('# 头\n' -> '> # 头\n').
const KERNEL_HEADING_QUOTED = AFTER_QUOTE_WRAP.replace('# 标题', '> # 标题')

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

// Same round trip as assertSource, but for the LEGACY (non-kernel) tab —
// there is no `.hm-kernel-mode` marker to wait for on the way back, just the
// ordinary editor DOM.
async function assertSourceLegacy(evaluate, expected, message) {
  await toggleSourceMode(evaluate)
  const shown = await waitFor(() => visibleSource(evaluate), `source view did not appear (${message})`)
  assert.equal(shown, expected, message)
  await toggleSourceMode(evaluate)
  await waitFor(async () => ((await mounted(evaluate)) || '').length > 0, `rich view did not return (${message})`)
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

// Character-offset Range lookup within a paragraph OR heading located by its
// CURRENT full rendered (visible, marker-free) text — walks all of the
// block's text nodes (a marked run splits it into several), so this works
// whether the block is plain or already contains marks.
async function charRect(evaluate, paragraphText, from, to) {
  return evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p, h1, h2, h3, h4, h5, h6') || [])].find((n) => n.textContent === ${JSON.stringify(paragraphText)})
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

// A screen point at a specific character offset, without clicking —
// used to right-click-open the ctxmenu at a precise spot (the real click
// happens via openCtxMenuAt/click below).
async function pointAt(evaluate, paragraphText, offset) {
  const rect = await waitFor(() => charRect(evaluate, paragraphText, offset, offset),
    `could not locate offset ${offset} in ${JSON.stringify(paragraphText)}`)
  return { x: rect.left, y: rect.top + Math.min(12, rect.height / 2) }
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

// Crepe's toolbar buttons carry no identifier, only the title HorseMD's own
// scanner injects (editor-toolbar.js `addToolbarTitles`). The LINK button is
// addressed by that title rather than by index on purpose: the index depends
// on whether `CrepeFeature.Latex` contributes a formula button (it does), and
// getting that wrong is exactly the bug that made this script's previous
// "link is refused" pin click the FORMULA button instead.
async function clickToolbarButtonTitled(evaluate, send, pattern) {
  const rect = await waitFor(() => evaluate(`(() => {
    const b = [...((${VISIBLE_TOOLBAR})?.querySelectorAll('.toolbar-item') || [])]
      .find((n) => ${pattern}.test(n.title || ''))
    if (!b) return null
    const r = b.getBoundingClientRect()
    return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  })()`), `toolbar button matching ${pattern} not found/visible`)
  await click(send, rect)
  await sleep(300)
}

// Milkdown's LinkTooltip mounts its edit popover on `document.body` as
// `.milkdown-link-edit[data-show]` (the same handle its own upstream test
// uses — @milkdown/crepe/src/feature/link-tooltip/link-tooltip.spec.ts).
// Returns null while it is hidden, so `waitFor` can poll it.
async function linkEditTooltipState(evaluate) {
  return evaluate(`(() => {
    const t = [...document.querySelectorAll('.milkdown-link-edit')].find((n) => n.getAttribute('data-show') === 'true')
    const input = t?.querySelector('input.input-area')
    if (!input) return null
    return { value: input.value, focused: document.activeElement === input }
  })()`)
}

// The preview tooltip opens from a real mousemove over a rendered link
// (preview-configure.ts debounces 50ms and requires `view.hasFocus()`), so
// this moves the pointer onto the `<a>` and holds it there.
async function hoverLink(evaluate, send, href) {
  const rect = await waitFor(() => evaluate(`(() => {
    const a = (${VISIBLE_EDITOR})?.querySelector('a[href=${JSON.stringify(href)}]')
    if (!a) return null
    a.scrollIntoView({ block: 'center' })
    const r = a.getBoundingClientRect()
    return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  })()`), `link ${href} is not rendered in the view`)
  for (let step = 0; step < 4; step += 1) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + step, y: rect.y })
    await sleep(80)
  }
  return rect
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

// Right-click at `point`, then click the ctxmenu's quote/unquote item —
// `expectedKind` ('quote'|'unquote') is asserted via the item's own
// `data-quote-toggle` attribute (Editor.jsx), which doubles as a check that
// the label actually flipped to the state the caller expects (a stale
// 'quote' button after the block is already quoted would fail to match).
async function clickQuoteMenuItem(evaluate, send, point, expectedKind) {
  await openCtxMenuAt(send, point)
  await waitFor(() => evaluate(`!!document.querySelector('.block-ctxmenu')`), 'right-click context menu did not open')
  const rect = await waitFor(() => evaluate(`(() => {
    const b = document.querySelector('[data-quote-toggle="${expectedKind}"]')
    const r = b?.getBoundingClientRect()
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  })()`), `ctxmenu "${expectedKind}" item missing`)
  await click(send, rect)
  await sleep(300)
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

    // ============================================================
    // 0) LEGACY-mode ctxmenu quote/unquote (Plan 4 Task 5.5) — one minimal
    //    check in the SAME app session, BEFORE kernel mode is ever turned
    //    on. Uses the fixture's own lead paragraph, untouched by every
    //    other scenario in this file. A plain PM wrapIn/lift dispatch goes
    //    through the ordinary markdownUpdated/preservation pipeline, same
    //    as any other rich edit — no kernel involved at all yet.
    //
    //    Ownership-proof convention (same idiom as
    //    test-diverged-delete-source-ui.mjs / test-empty-paragraph-source-ui.mjs):
    //    reset __hmGateLog/__hmPreserveLog right before each action, then
    //    assert the gate log stayed EMPTY (the round-trip-acceptance gate
    //    never rejected a candidate — no silent retry/rebuild happened) and
    //    the preserve log's last entry is a genuine `preserved: true` with a
    //    real reason (not the 'unknown' placeholder pushed when
    //    `result.reason` is missing — see markdown-source-preservation.js).
    // ============================================================
    {
      await evaluate(`(() => { window.__hmGateLog = []; window.__hmPreserveLog = [] })()`)
      const point = await pointAt(evaluate, '首段落用于占位说明。', 0)
      await clickQuoteMenuItem(evaluate, send, point, 'quote')
      assert.equal(app.dialogs.length, 0, 'no dialog from the legacy ctxmenu quote')
      const quoteDiagnostics = await evaluate(`({
        gate: window.__hmGateLog || [],
        preserve: (window.__hmPreserveLog || []).slice(-1)
      })`)
      assert.deepEqual(quoteDiagnostics.gate, [],
        `legacy ctxmenu quote must never hit the round-trip-acceptance gate: ${JSON.stringify(quoteDiagnostics)}`)
      const quotePreserved = quoteDiagnostics.preserve.at(-1)
      assert.ok(quotePreserved, `no preserve-log entry was captured for the legacy ctxmenu quote: ${JSON.stringify(quoteDiagnostics)}`)
      assert.equal(quotePreserved.preserved, true,
        `legacy ctxmenu quote must be a genuine preserve, not a fallback: ${JSON.stringify(quotePreserved)}`)
      assert.notEqual(quotePreserved.reason, 'unknown',
        `legacy ctxmenu quote must record a real preservation reason, not the missing-reason placeholder: ${JSON.stringify(quotePreserved)}`)
      await assertSourceLegacy(evaluate, LEGACY_AFTER_QUOTE, 'legacy ctxmenu Quote must wrap the paragraph with "> "')

      await evaluate(`(() => { window.__hmGateLog = []; window.__hmPreserveLog = [] })()`)
      const point2 = await pointAt(evaluate, '首段落用于占位说明。', 0)
      await clickQuoteMenuItem(evaluate, send, point2, 'unquote')
      assert.equal(app.dialogs.length, 0, 'no dialog from the legacy ctxmenu unquote')
      const unquoteDiagnostics = await evaluate(`({
        gate: window.__hmGateLog || [],
        preserve: (window.__hmPreserveLog || []).slice(-1)
      })`)
      assert.deepEqual(unquoteDiagnostics.gate, [],
        `legacy ctxmenu unquote must never hit the round-trip-acceptance gate: ${JSON.stringify(unquoteDiagnostics)}`)
      const unquotePreserved = unquoteDiagnostics.preserve.at(-1)
      assert.ok(unquotePreserved, `no preserve-log entry was captured for the legacy ctxmenu unquote: ${JSON.stringify(unquoteDiagnostics)}`)
      assert.equal(unquotePreserved.preserved, true,
        `legacy ctxmenu unquote must be a genuine preserve, not a fallback: ${JSON.stringify(unquotePreserved)}`)
      assert.notEqual(unquotePreserved.reason, 'unknown',
        `legacy ctxmenu unquote must record a real preservation reason, not the missing-reason placeholder: ${JSON.stringify(unquotePreserved)}`)
      await assertSourceLegacy(evaluate, FIXTURE, 'legacy ctxmenu Unquote must revert to the exact original bytes')
    }

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
    // 6) HIGHLIGHT (P5-3 flipped pin — this used to assert a REFUSAL):
    //    select -> toolbar highlight -> the `==` bytes are committed, then
    //    highlight again -> unwrapped back to the original bytes. Done here,
    //    right after step 2, while the selection toolbar is still on — step
    //    3a below turns the toolbar SETTING off for the ctxmenu test and
    //    never turns it back on.
    // ============================================================
    await selectRange(evaluate, send, '壹贰叁肆', 0, 4)
    await clickHighlightYellow(evaluate, send)
    await assertSource(evaluate, AFTER_HIGHLIGHT, 'toolbar highlight must wrap the selection with ==')
    // The mark really is live in the view (not just bytes on disk): the
    // reconciled document renders a <mark> for it.
    const highlightRendered = await waitFor(() => evaluate(`(() => {
      const el = (${VISIBLE_EDITOR})?.querySelector('mark.hm-highlight')
      return el ? el.textContent : null
    })()`), 'the committed highlight did not render as a <mark> in the view')
    assert.equal(highlightRendered, '壹贰叁肆', 'the rendered highlight covers exactly the selected word')

    await selectRange(evaluate, send, '壹贰叁肆', 0, 4)
    await clickHighlightYellow(evaluate, send)
    await assertSource(evaluate, AFTER_B, 'clicking highlight again must unwrap back to the original bytes')

    // ============================================================
    // 7) LINK (P5-6 flipped pin — this used to assert a REFUSAL):
    //    select -> toolbar link -> Milkdown's LinkTooltip opens -> type the
    //    URL -> Enter -> the `[text](url)` bytes are committed. Then the
    //    preview tooltip's edit button changes the URL, and the toolbar link
    //    button (whose command sees an existing link mark) removes it.
    //    Positive controls throughout: the tooltip must really be shown with
    //    a FOCUSED input, and (for the edit step) prefilled with the current
    //    URL — so none of these steps can pass vacuously.
    // ============================================================
    await selectRange(evaluate, send, '伍陆柒捌', 0, 4)
    // Positive control on the tooltip-title fix itself: the link button must
    // be findable BY ITS TITLE (before this task it had none — the formula
    // button carried it).
    await clickToolbarButtonTitled(evaluate, send, '/^(链接|Link)$/') // -> opens the edit tooltip
    const editOpened = await waitFor(() => linkEditTooltipState(evaluate),
      'the link edit tooltip did not open')
    assert.equal(editOpened.focused, true, 'the link tooltip input must be focused (positive control)')
    assert.equal(editOpened.value, '', 'a NEW link starts with an empty URL field')

    await typeTextLikeUser(send, LINK_URL, { delayMs: delay })
    const typed = await linkEditTooltipState(evaluate)
    assert.equal(typed.value, LINK_URL, 'the typed URL really reached the tooltip input')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await sleep(400)
    assert.equal(app.dialogs.length, 0, 'no dialog from the link confirm')

    // The link really is live in the view (not just bytes on disk).
    const linkRendered = await waitFor(() => evaluate(`(() => {
      const el = (${VISIBLE_EDITOR})?.querySelector('a[href=${JSON.stringify(LINK_URL)}]')
      return el ? el.textContent : null
    })()`), 'the committed link did not render as an <a> in the view')
    assert.equal(linkRendered, '伍陆柒捌', 'the rendered link covers exactly the selected word')
    await assertSource(evaluate, AFTER_LINK, 'the toolbar link flow must commit [伍陆柒捌](url) byte-exactly')

    // ---- change the URL through the preview tooltip's edit button ----
    // The preview only opens while the EditorView has focus, and the byte
    // assert above round-tripped through source mode — so re-focus the view
    // with a click in a neighbouring paragraph before hovering.
    await clickAt(evaluate, send, '壹贰叁肆', 0)
    await hoverLink(evaluate, send, LINK_URL)
    const previewShown = await waitFor(() => evaluate(`(() => {
      const t = [...document.querySelectorAll('.milkdown-link-preview')].find((n) => n.getAttribute('data-show') === 'true')
      const a = t?.querySelector('a.link-display')
      return a ? a.getAttribute('href') : null
    })()`), 'hovering the link did not open the preview tooltip')
    assert.equal(previewShown, LINK_URL, 'the preview tooltip shows the current URL (positive control)')
    const editBtn = await waitFor(() => evaluate(`(() => {
      const t = [...document.querySelectorAll('.milkdown-link-preview')].find((n) => n.getAttribute('data-show') === 'true')
      const r = t?.querySelector('.link-edit-button')?.getBoundingClientRect()
      return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
    })()`), 'the preview tooltip has no edit button')
    await click(send, editBtn)
    await sleep(400)
    const prefilled = await waitFor(() => linkEditTooltipState(evaluate),
      'the edit tooltip did not reopen from the preview')
    assert.equal(prefilled.value, LINK_URL, 'editing prefills the CURRENT url (positive control)')
    assert.equal(prefilled.focused, true, 'the reopened tooltip input must be focused')
    for (let index = 0; index < LINK_URL.length; index += 1) {
      await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 6 })
    }
    assert.equal((await linkEditTooltipState(evaluate)).value, '', 'the URL field was really cleared')
    await typeTextLikeUser(send, LINK_URL_2, { delayMs: delay })
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await sleep(400)
    await assertSource(evaluate, AFTER_LINK_EDIT, 'the tooltip edit must rewrite ONLY the destination segment')

    // ---- remove it: the toolbar link button on an existing link routes
    //      through toggleLinkCommand -> removeLink (a lone RemoveMarkStep).
    await selectRange(evaluate, send, '伍陆柒捌', 0, 4)
    await clickToolbarButtonTitled(evaluate, send, '/^(链接|Link)$/')
    await sleep(400)
    const stillLinked = await evaluate(`!!(${VISIBLE_EDITOR})?.querySelector('a[href=${JSON.stringify(LINK_URL_2)}]')`)
    assert.equal(stillLinked, false, 'the link mark is gone from the view')
    await assertSource(evaluate, AFTER_B, 'removing the link must restore the original bytes exactly')

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
    // P5-6: NO format item is kernel-disabled any more — the link item was
    // the last one carrying `.disabled` in kernel mode.
    const disabledFormats = await evaluate(`[...document.querySelectorAll('[data-context-submenu="format"] .block-text-format')]
      .filter((n) => n.classList.contains('disabled')).length`)
    assert.equal(disabledFormats, 0, 'no ctxmenu format item may be disabled in kernel mode')
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

    // (d) INSIDE the bold word — FLIPPED 2026-08-30 (the 「续加粗」 batch):
    // the inherited-mark char joins the run inside its delimiters, legacy's
    // own answer (this used to refuse, which meant a bold word could not be
    // typed into at all).
    await clickAt(evaluate, send, '前X午未申酉后Y段尾Z', 4) // between 未 and 申
    await typeTextLikeUser(send, 'W', { delayMs: delay })
    await waitFor(async () => (await mounted(evaluate) || '').includes('前X午未W申酉后Y段尾Z'), 'typed W inside the bold run never landed')
    await sleep(200)
    await assertSource(evaluate, AFTER_TYPING.replace('**午未申酉**', '**午未W申酉**'),
      'the char typed inside the bold word joins the run between its delimiters')
    // put the fixture back so the following sections keep their expectations
    await pressMod(send, 'z', 'KeyZ', 90)
    await sleep(300)
    await assertSource(evaluate, AFTER_TYPING, 'undo restores the pre-(d) bytes')

    // ============================================================
    // 8) `/quote` slash item — the ONLY reachable invocation is on a block
    //    whose ENTIRE raw text is the typed query (shouldShow requires
    //    atEndOfBlock + text.startsWith('/') on the FULL block text — an
    //    existing populated paragraph, and any block inside a list
    //    (isInList), can never reach this menu at all).
    //
    //    THIS USED TO PIN A REFUSAL (2026-08-19). On that one reachable shape
    //    the wrap was an architectural dead end: a bare '>' with nothing else
    //    reparses to a ZERO-child mdast blockquote, while ProseMirror's
    //    `content: "block+"` schema always holds the empty paragraph
    //    `createAndFill` puts there, so the result document's map was a count
    //    mismatch and `requireMap` refused — every time, on an item the menu
    //    presented as enabled and ranked first. The mismatch is now synthesized
    //    (editor-kernel-projection-map.js `syntheticEmptyQuoteParagraph`), so
    //    the item commits a real, typable empty blockquote in ONE transaction.
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
    await assertSource(evaluate, AFTER_QUOTE_WRAP,
      'the /quote item must replace the typed query bytes with a real empty blockquote, in one commit')

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
    // 9) undo chain sanity — spot-check 3 discrete groups. The most recent
    //    kernel-history groups at this point are: the /quote WRAP (step 8's
    //    own single transaction), the /quote query text commit, and the
    //    far-plain 'Z' typed insert (step 5c) — each undo must revert exactly
    //    ONE of them.
    // ============================================================
    await pressUndo(send) // reverts the /quote wrap
    await sleep(250)
    await assertSource(evaluate, AFTER_QUOTE_QUERY,
      'undo #1 must revert exactly the /quote wrap, leaving the typed query bytes')

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
    await pressRedo(send)
    await sleep(250)
    await assertSource(evaluate, AFTER_QUOTE_WRAP, 'redo x3 must restore the pre-undo state exactly')

    // ============================================================
    // 9a) KERNEL ctxmenu quote/unquote — a real, general UI entry point for
    //     the quote domain (Plan 4 Task 5.5). Runs AFTER the undo/redo
    //     assertions above (so it never disturbs that history-group
    //     scrutiny) and nets to zero bytes (wrap, assert, then unwrap,
    //     assert back to AFTER_QUOTE_WRAP) so the save/reopen checks below
    //     stay unaffected. Right-clicking the SAME (now-quoted) paragraph a
    //     second time is exactly "right-click inside the quote -> 取消引用
    //     -> unwrapped".
    // ============================================================
    {
      const point = await pointAt(evaluate, '尾段落。', 0)
      await clickQuoteMenuItem(evaluate, send, point, 'quote')
      assert.equal(app.dialogs.length, 0, 'no dialog from the kernel ctxmenu quote')
      await assertSource(evaluate, KERNEL_PARA_QUOTED, 'kernel ctxmenu Quote must wrap the paragraph with "> "')

      const point2 = await pointAt(evaluate, '尾段落。', 0)
      await clickQuoteMenuItem(evaluate, send, point2, 'unquote')
      assert.equal(app.dialogs.length, 0, 'no dialog from the kernel ctxmenu unquote')
      await assertSource(evaluate, AFTER_QUOTE_WRAP, 'kernel ctxmenu Unquote must revert to the exact original bytes')
    }

    // ============================================================
    // 9b) KERNEL ctxmenu quote on a LOOSE LIST — the exact scenario Task 5's
    //     report (Finding 3) proved UI-unreachable via `/quote` (its
    //     shouldShow gate refuses inside any list item, before even
    //     checking the query text). The ctxmenu path has no such gate: a
    //     click anywhere inside the list resolves to the list's own
    //     top-level node, and the whole list wraps as one blockquote, its
    //     internal blank (looseness) line becoming a bare '>' — the same
    //     shape test-source-kernel-quote.mjs's loose-list case proves.
    // ============================================================
    {
      const point = await pointAt(evaluate, '列项一', 0)
      await clickQuoteMenuItem(evaluate, send, point, 'quote')
      assert.equal(app.dialogs.length, 0, 'no dialog from the kernel ctxmenu list quote')
      await assertSource(evaluate, KERNEL_LIST_QUOTED,
        'kernel ctxmenu Quote on a loose list must wrap the WHOLE list, with a bare ">" for the internal blank line')

      const point2 = await pointAt(evaluate, '列项一', 0)
      await clickQuoteMenuItem(evaluate, send, point2, 'unquote')
      assert.equal(app.dialogs.length, 0, 'no dialog from the kernel ctxmenu list unquote')
      await assertSource(evaluate, AFTER_QUOTE_WRAP, 'kernel ctxmenu Unquote on the list must revert to the exact original bytes')
    }

    // ============================================================
    // 9c) KERNEL ctxmenu quote/unquote on a HEADING (minor ride-along) —
    //     same shape as test-source-kernel-quote.mjs's heading case.
    // ============================================================
    {
      const point = await pointAt(evaluate, '标题', 0)
      await clickQuoteMenuItem(evaluate, send, point, 'quote')
      assert.equal(app.dialogs.length, 0, 'no dialog from the kernel ctxmenu heading quote')
      await assertSource(evaluate, KERNEL_HEADING_QUOTED, 'kernel ctxmenu Quote on a heading must wrap the whole "# " line with "> "')

      const point2 = await pointAt(evaluate, '标题', 0)
      await clickQuoteMenuItem(evaluate, send, point2, 'unquote')
      assert.equal(app.dialogs.length, 0, 'no dialog from the kernel ctxmenu heading unquote')
      await assertSource(evaluate, AFTER_QUOTE_WRAP, 'kernel ctxmenu Unquote on the heading must revert to the exact original bytes')
    }

    // ============================================================
    // 9d) CODE-BLOCK interior ctxmenu gating (reviewer Critical #1): a
    //     right-click INSIDE a fenced code block's CodeMirror content must
    //     hide the quote item entirely. CodeMirror's node view renders its
    //     content in a SEPARATE EditorView, opaque to ProseMirror's own
    //     `posAtCoords` — a click physically inside the code content
    //     resolves to a NEIGHBORING block instead of anything inside the
    //     code_block node, so this can only be caught by DOM ancestry (see
    //     resolveQuoteMenuState's comment in editor-dom-interactions.js),
    //     never by walking the (wrongly resolved) position's PM ancestry.
    // ============================================================
    {
      const beforeCode = await paragraphTexts(evaluate)
      const point = await evaluate(`(() => {
        const block = (${VISIBLE_EDITOR})?.querySelector('.milkdown-code-block')
        if (!block) return null
        block.scrollIntoView({ block: 'center' })
        const line = block.querySelector('.cm-editor .cm-line')
        const rect = line?.getBoundingClientRect()
        return rect && rect.width ? { x: rect.left + 2, y: rect.top + rect.height / 2 } : null
      })()`)
      assert.ok(point, 'code block CM line is not hit-testable')
      await openCtxMenuAt(send, point)
      await waitFor(() => evaluate(`!!document.querySelector('.block-ctxmenu')`), 'ctxmenu did not open over the code block')
      const quoteItemPresent = await evaluate(`!!document.querySelector('[data-quote-toggle]')`)
      assert.equal(quoteItemPresent, false,
        'quote ctxmenu item must be hidden inside a code block (posAtCoords resolves to a neighboring block, not the code block itself)')
      await closeCtxMenu(evaluate)
      const afterCode = await paragraphTexts(evaluate)
      assert.deepEqual(afterCode, beforeCode,
        'right-clicking inside a code block must never mutate the document, even when the menu is dismissed without a click')
      await assertSource(evaluate, AFTER_QUOTE_WRAP, 'the code-block ctxmenu gating check must leave source bytes byte-identical')
    }

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
      // The saved document's quote block is EMPTY (the '/quote' query bytes
      // were replaced by a real blockquote), so there is no 'quote' text left
      // to wait for — these two are the surviving landmarks.
      return text && text.includes('尾段落。') && text.includes('列项二') ? text : null
    }, 'reopened document did not mount with the saved content')
    await toggleSourceMode(evaluate)
    const reopened = await waitFor(() => visibleSource(evaluate), 'source view did not appear after cold reopen')
    assert.equal(reopened, SAVED, 'cold reopen must reproduce the saved kernel-mode bytes exactly, byte-for-byte')
    assert.equal(app.dialogs.length, 0, 'no rebuild prompt may appear on cold reopen')

    // ============================================================
    // 11) ISOLATED regression (reviewer Important #2): legacy multi-
    //     paragraph unquote must lift the ENTIRE blockquote in one step, not
    //     just the single paragraph the caret sits in — a right-click inside
    //     the MIDDLE paragraph of a 3-paragraph blockquote, then Unquote,
    //     must free all three (byte-identical to the whole quote peeled),
    //     never split into two quotes around a freed middle paragraph. Its
    //     own isolated app session/file (same "stop, write, relaunch"
    //     pattern test-empty-paragraph-source-ui.mjs's Scenario G/H use) so
    //     this fixture never has to be reconciled back into the main
    //     FIXTURE's byte-checkpoint chain above.
    // ============================================================
    await stopBuiltElectron(app, { removeProfile: true })
    await writeFile(multiQuoteFile, MULTI_QUOTE_FIXTURE)
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile-multiquote'),
      port: port + 1,
      appArgs: [multiQuoteFile]
    })
    ;({ evaluate, send } = app)
    await waitFor(async () => (await mounted(evaluate) || '').includes('引二'), 'multi-paragraph quote fixture did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on the multi-quote fixture mount')

    const middlePoint = await pointAt(evaluate, '引二', 0)
    await clickQuoteMenuItem(evaluate, send, middlePoint, 'unquote')
    assert.equal(app.dialogs.length, 0, 'no dialog from the multi-paragraph legacy unquote')
    await assertSourceLegacy(evaluate, MULTI_QUOTE_UNWRAPPED,
      'unquoting the MIDDLE paragraph must lift the WHOLE blockquote (all three paragraphs freed), never split it into two quotes around a freed middle paragraph')

    console.log('PASS kernel-mode marks + quote domain UI regression: toolbar/ctxmenu/keyboard mark toggles, inline code, the typing-after-bold matrix, highlight wrap/unwrap, the link tooltip wrap/edit/remove flow, the /quote fail-closed fix, code-block ctxmenu gating, whole-blockquote legacy unwrap, undo/redo groups, save and cold reopen all match the kernel-derived byte strings')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
