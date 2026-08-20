// Kernel-mode node-view identity + blocked-matrix UI regression
// (source-kernel integration Plan 2, Task 11).
//
// Two things this script proves against the REAL Electron app in kernel
// mode, neither covered by test-kernel-mode-ui.mjs / test-kernel-ime-ui.mjs:
//
// 1. Node-view identity: editing a FAR paragraph must not tear down and
//    remount the DOM nodes owned by unrelated node views (CodeMirror's
//    `.cm-editor`, an `<img>`, a `<table>`, and — spec criterion 4 names it
//    explicitly — a Mermaid diagram's rendered `<svg>`, which is a code-block
//    PREVIEW substitution rather than a plain element, see
//    editor-mermaid.js) or move the scroll position. This is the whole point
//    of editor-kernel-reconciler.js's minimal-diff `diffReplaceRange` (see
//    its own header comment) — this script is the first thing that actually
//    measures DOM node IDENTITY end-to-end rather than just asserting the
//    resulting markdown bytes.
// 2. Blocked matrix (阻止矩阵, Task 7, amended by Plan 4 Task 3): slash-menu
//    structural items stay visible-but-`.disabled` and refuse to run (both
//    via Enter and via a real pointer click); the right-click context menu
//    offers the FORMAT submenu (mark toggles are kernel-routed now, link
//    item disabled) but never review/turn-into/list-conversion; the
//    floating selection toolbar APPEARS on selection (its mark buttons
//    dispatch toggleMark, which the gateway owns).
//
// Fixture design note (see task-11-report.md "Bugs found" for the full
// diagnosis — THREE real, pre-existing kernel-mode bugs were found while
// building this fixture, none fixed in this task beyond one narrowly-scoped
// plugin-ordering fix; see the report for why):
//  (a) The document ENDS in a plain paragraph. Crepe's always-on
//      `@milkdown/plugin-trailing` appends a synthetic empty trailing
//      paragraph whenever a document's last top-level block is anything
//      OTHER than heading/paragraph, and `buildProjectionMap` does not yet
//      tolerate that synthetic node — a document ending in the list/table/
//      code-block this script also needs would never attach kernel mode at
//      all.
//  (b) The image is INLINE (embedded in a paragraph WITH other text), not a
//      standalone image on its own line. Crepe promotes a stand-alone image
//      to its own `image-block` PM node type, which has no `PM_TO_MD` entry
//      in editor-kernel-projection-map.js either — same class of attach
//      failure as (a). An inline image is a true `image` atom inside an
//      ordinary `paragraph`, already supported by character-map.js's ATOMS
//      set, so it attaches fine and still exercises a real `<img>` node view.
//  (c) A single-character "z" placeholder paragraph is REPLACED with "/"
//      (not appended-then-Enter) to reach the slash menu.
//      `splitTextBlock`'s raw byte-level paragraph split (inserting a
//      second blank line) is invisible after CommonMark reparse when
//      neither side of the split stays visually distinguishable, so Enter
//      cannot currently be used to manufacture a fresh empty paragraph to
//      type "/" into. Replacing a single existing character is a plain-text
//      edit with no such block-boundary ambiguity.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = `/tmp/horsemd-kernel-nv-${process.pid}`
const file = join(root, 'kernel-nodeview.md')
const svgFile = join(root, 'kernel-nodeview.svg')
const port = Number(process.env.CDP_PORT || 10022)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

const FIXTURE = [
  '# 内核节点视图测试',
  '',
  '前置说明段落，用于占位。',
  '',
  '```js',
  'function greet(name) {',
  '  return `你好，${name}！`;',
  '}',
  '```',
  '',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '',
  '示意图见此：![节点视图测试图](./kernel-nodeview.svg) 图片说明结束。',
  '',
  '| 列一 | 列二 |',
  '| --- | --- |',
  '| 甲 | 乙 |',
  '| 丙 | 丁 |',
  '',
  '填充一：占位文字用于撑开滚动高度。',
  '',
  '填充二：占位文字用于撑开滚动高度。',
  '',
  '填充三：占位文字用于撑开滚动高度。',
  '',
  '填充四：占位文字用于撑开滚动高度。',
  '',
  '填充五：占位文字用于撑开滚动高度。',
  '',
  '填充六：占位文字用于撑开滚动高度。',
  '',
  'z',
  '',
  '远段落用于打字测试。',
  ''
].join('\n')

const FAR_PARAGRAPH = '远段落用于打字测试。'
const TYPED = '东南西北中'
// The mermaid fence's single source line, and the text section 5.5 APPENDS to
// it to prove a previewed fence is genuinely editable (both the CodeMirror
// view AND the kernel's source bytes). The appended statement keeps the
// diagram VALID, so the probe never depends on how the renderer reports a
// parse error.
const MERMAID_CODE = 'graph TD; A-->B;'
const MERMAID_TYPED = ' B-->C;'
const FAR_PARAGRAPH_AFTER_TYPING = FAR_PARAGRAPH + TYPED

// Derived directly from FIXTURE by string substitution: both edits below are
// plain-text (append at a paragraph's visible end; single-character replace
// within a one-character paragraph), neither touches any markdown syntax
// requiring escaping, so the raw bytes are exactly the visible text —
// verified structurally via buildSyntaxIndex in the task's own investigation
// (kernel oracle; see task-11-report.md).
const AFTER_TYPING = FIXTURE.replace(`${FAR_PARAGRAPH}\n`, `${FAR_PARAGRAPH_AFTER_TYPING}\n`)
const SAVED = AFTER_TYPING.replace('\nz\n\n', '\n/\n\n')

async function waitFor(check, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

// A lazy-mounted, kept-mounted onboarding/welcome tab (or any other
// previously-opened tab) can leave ITS OWN `.cm-editor`/img/table in the DOM
// alongside this fixture's — every query below must be scoped to the
// currently VISIBLE `.ProseMirror` (offsetParent-truthy), never a bare
// `document.querySelector`, or an assertion could silently read/target the
// wrong tab's node view.
const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`
// Crepe's table node view renders a SECOND, empty `<table>` inside
// `.drag-preview` (a column-drag ghost) alongside the real, populated one —
// a bare `querySelector('table')` can silently grab that empty ghost
// instead of the actual table. `realTable(editor)` filters it out.
const REAL_TABLE = (editorExpr) =>
  `[...(${editorExpr})?.querySelectorAll('table') || []].find((node) => !node.closest('.drag-preview'))`
// Mermaid renders via Crepe's code-block "preview" mechanism
// (editor-mermaid.js `createMermaidPreviewRenderer`), not a custom widget: a
// ```mermaid block's `.milkdown-code-block` gets a `.preview` div holding the
// rendered `<svg>` once the (lazily imported) Mermaid render lands. Locate it
// by the block's language-button text, the same convention
// test-mermaid-long-document-ui.mjs uses for the same node type.
const MERMAID_PREVIEW_SVG = (editorExpr) =>
  `[...(${editorExpr})?.querySelectorAll('.milkdown-code-block') || []]
    .find((block) => block.querySelector('.language-button')?.textContent?.trim().toLowerCase() === 'mermaid')
    ?.querySelector('.preview svg')`

// Same block, without descending into the preview svg — used by the
// editable-fence/undo-bridge section below to reach the toolbar's
// `.preview-toggle-button` (only rendered when `renderPreview` produces
// something, i.e. only for this mermaid block, not the always-editor-visible
// `js` block section 5 already probes).
const MERMAID_BLOCK = (editorExpr) =>
  `[...(${editorExpr})?.querySelectorAll('.milkdown-code-block') || []]
    .find((block) => block.querySelector('.language-button')?.textContent?.trim().toLowerCase() === 'mermaid')`

// Used by the PM->CM projection-sync regression below: the fixture's ONLY
// other code block, whose content carries the marker text that gets edited
// out-of-band through the source-mode textarea.
const JS_BLOCK = (editorExpr) =>
  `[...(${editorExpr})?.querySelectorAll('.milkdown-code-block') || []]
    .find((block) => block.querySelector('.language-button')?.textContent?.trim().toLowerCase() === 'js')`

const mounted = (evaluate) => evaluate(`(${VISIBLE_EDITOR})?.textContent`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

// Same split-button convention test-kernel-mode-ui.mjs documents: the plain
// `.status-btn` (not the kernel caret button) toggles rich/source.
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

// Same off-screen-click trap test-kernel-mode-ui.mjs / test-quoted-block-
// source-ui.mjs document: a document taller than the window needs a real
// scroll before the synthetic click can land on the right node.
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
  await sleep(150)
  // 'End' can race the click's own selection settling (observed flake: the
  // caret stayed at the click position instead of moving to the block's
  // end) — verify the DOM selection actually reached the end and retry
  // 'End' a few times rather than trusting a single keypress blindly.
  const atEnd = () => evaluate(`(() => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return false
    const node = sel.focusNode
    const text = node?.nodeType === Node.TEXT_NODE ? node.textContent : node?.textContent
    return sel.focusOffset === (text?.length ?? -1)
  })()`)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await pressKey(send, { key: 'End', code: 'End', delayMs: delay })
    if (await atEnd()) return
  }
  assert.fail(`caret never reached the end of block: ${text}`)
}

const scrollTop = (evaluate) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  return editor?.closest('.editor-scroll')?.scrollTop ?? null
})()`)

const paragraphTexts = (evaluate) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  return [...(editor?.querySelectorAll('p') || [])].map((node) => node.textContent)
})()`)

const slashItems = (evaluate) => evaluate(`[
  ...document.querySelectorAll('.milkdown-slash-menu[data-show="true"] .hm-slash-item')
].map((node) => ({ disabled: node.classList.contains('disabled'), index: node.dataset.index, id: node.dataset.id }))`)

// The slash items the KERNEL owns, and which must therefore be enabled;
// everything else structural stays refused. This predicate is the "disabled
// matrix" every item must match.
//
// Plan 4 Task 4 added 'quote' (routed through runQuoteToggle, never PM's
// wrapInBlockTypeCommand) and this list read `item.id !== 'quote'` for a
// while. `e8b68bf` (feat(kernel-mode): route the block-type slash items
// through the kernel) then added the block-type items — `KERNEL_BLOCK_TYPE_ITEMS`
// in editor-crepe-setup.js, h1–h6 + bullet + ordered, filtered through the
// kernel's own `BLOCK_TYPE_MARKERS` — without updating this predicate, so
// this assertion has been failing since that commit against the behaviour it
// deliberately shipped.
//
// It then went stale a SECOND time, the same way: `e007a68` corrected it for
// the block-type items, and five commits later `5ffae3a` + `484ea99` routed
// `table`, `code` (plus every `code:<language>` variant) and `math` without
// touching this list again. Twice is a pattern, not an accident — a hardcoded
// mirror of a production table drifts every time that table grows, and
// because `test:kernel-ui` is an `&&` chain with this script 4th, a stale
// entry here ABORTS the suite before empty-fence, math-block, blocktype,
// blockinsert, hardbreak and the whitespace tests ever run. A stale
// expectation in this file therefore hides every later regression.
//
// The durable fix is to derive this from the production tables
// (`KERNEL_BLOCK_TYPE_ITEMS` in editor-crepe-setup.js, `BLOCK_INSERT_TARGETS`
// in lib/source-kernel/commands/block-insert.js) so the two cannot drift —
// that refactor needs a pure shared module both sides can import, and is
// tracked separately. Until then this list is a MIRROR: extend it in the same
// commit that routes a new slash item.
//
// It went stale a THIRD time exactly as predicted two paragraphs up:
// `2c1fda5` routed `task` (the U+00A0 seed spelling) without touching this
// list, so the matrix assertion had been failing against deliberately-shipped
// behaviour again. Extend this set in the SAME commit that routes an item.
//
// Anything absent is refused by the kernel on purpose: `text` yields an
// unrepresentable empty paragraph. (`divider` and `image` routed on
// 2026-08-20 — the caret-after machinery.)
const KERNEL_ROUTED_SLASH_ITEMS = new Set([
  'quote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'bullet', 'ordered',
  'table', 'code', 'math', 'task', 'divider', 'image'
])
// `/js`, `/python`, … render as a dynamic `code:<language>` item that routes
// through the same code-block insert as bare `/code`.
const isStructurallyBlocked = (item) => !(
  KERNEL_ROUTED_SLASH_ITEMS.has(item.id) || item.id.startsWith('code:')
)

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

// `Mod-z` resolves to Meta (Cmd) on darwin — the prosemirror-keymap `mac`
// detection this test's environment (Darwin) hits — same convention
// test-kernel-mode-ui.mjs's pressUndo() and modifiers:4 use.
async function pressUndo(send) {
  const params = { key: 'z', code: 'KeyZ', modifiers: 4, windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)
  await writeFile(svgFile, await readFile(join(__dirname, 'fixtures', 'kernel-nodeview.svg')))
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    let { evaluate, send } = app

    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('远段落') && text.includes('填充六') ? text : null
    }, 'initial document did not mount')
    await waitFor(() => evaluate(`!!(${VISIBLE_EDITOR})?.querySelector('.cm-editor')`), 'code block never mounted')
    await waitFor(() => evaluate(`!!(${VISIBLE_EDITOR})?.querySelector('img')`), 'image never mounted')
    await waitFor(() => evaluate(`!!(${REAL_TABLE(VISIBLE_EDITOR)})`), 'table never mounted')
    // Mermaid lazy-loads its renderer on first use — give the async render
    // (dynamic import + mermaid.render()) time to land before relying on the
    // svg existing for anything below.
    await waitFor(() => evaluate(`!!(${MERMAID_PREVIEW_SVG(VISIBLE_EDITOR)})`), 'mermaid preview never rendered', 150)
    assert.equal(app.dialogs.length, 0, 'no dialog on plain mount')

    // ---- enable kernel mode ----
    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('远段落') && text.includes('填充六') ? text : null
    }, 'document did not remount after enabling kernel mode')
    // Enabling kernel mode itself remounts the tab (a fresh Crepe instance),
    // so the mermaid preview must re-render here before it can be used as an
    // identity baseline below — this wait is expected to fire once, not a
    // symptom of the far-edit regression this section actually probes for.
    await waitFor(() => evaluate(`!!(${MERMAID_PREVIEW_SVG(VISIBLE_EDITOR)})`), 'mermaid preview never re-rendered after enabling kernel mode', 150)
    await sleep(300)

    // Sanity: this fixture ends in a plain paragraph specifically so kernel
    // mode genuinely attaches (see the header comment) — assert it did, not
    // just that the UI toggled, so a future regression that silently
    // degrades kernel mode again fails LOUDLY here instead of the rest of
    // this script quietly exercising the legacy fallback.
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(
      !attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy fallback for this fixture: ${attachDiagnostics}`
    )
    assert.equal(app.dialogs.length, 0, 'no dialog after enabling kernel mode')

    // ============================================================
    // 1) Node-view identity across an edit in a FAR paragraph
    // ============================================================
    await clickTextEnd(evaluate, send, FAR_PARAGRAPH)
    await sleep(150)
    await evaluate(`(() => {
      const editor = ${VISIBLE_EDITOR}
      window.__hmProbeCm = editor.querySelector('.cm-editor')
      window.__hmProbeImg = editor.querySelector('img')
      window.__hmProbeTable = (${REAL_TABLE('editor')})
      window.__hmProbeMermaid = (${MERMAID_PREVIEW_SVG('editor')})
      window.__hmProbeMermaidChildCount = window.__hmProbeMermaid?.children?.length ?? 0
      true
    })()`)
    const scrollBefore = await scrollTop(evaluate)
    assert.ok(Number.isFinite(scrollBefore), 'scroll container not found before typing')

    await typeTextLikeUser(send, TYPED, { delayMs: delay })
    await waitFor(async () => (await mounted(evaluate) || '').includes(FAR_PARAGRAPH_AFTER_TYPING),
      'typed characters never reached the kernel-mode editor')
    await sleep(200)

    const cmIdentityKept = await evaluate(`window.__hmProbeCm === (${VISIBLE_EDITOR})?.querySelector('.cm-editor')`)
    const imgIdentityKept = await evaluate(`window.__hmProbeImg === (${VISIBLE_EDITOR})?.querySelector('img')`)
    const tableIdentityKept = await evaluate(`window.__hmProbeTable === (${REAL_TABLE(VISIBLE_EDITOR)})`)
    // Spec criterion 4 names Mermaid explicitly (rendered via the code-block
    // preview mechanism, not a plain DOM element like img/table) — its
    // rendered `<svg>` must survive a far-paragraph edit exactly like the
    // other node views, not just "some Mermaid preview exists somewhere".
    const mermaidIdentityKept = await evaluate(`window.__hmProbeMermaid === (${MERMAID_PREVIEW_SVG(VISIBLE_EDITOR)})`)
    assert.equal(cmIdentityKept, true, 'CodeMirror .cm-editor DOM node was torn down/remounted by an edit in a far paragraph')
    assert.equal(imgIdentityKept, true, 'img DOM node was torn down/remounted by an edit in a far paragraph')
    assert.equal(tableIdentityKept, true, 'table DOM node was torn down/remounted by an edit in a far paragraph')
    assert.equal(mermaidIdentityKept, true, 'Mermaid preview svg DOM node was torn down/remounted by an edit in a far paragraph')
    const scrollAfter = await scrollTop(evaluate)
    assert.equal(scrollAfter, scrollBefore, 'scroll position moved from an edit in a far paragraph')

    // Verify the CodeMirror/image/table/Mermaid CONTENT is also unchanged
    // (identity alone would not catch a node view that kept its DOM node but
    // silently re-rendered wrong content into it).
    const cmContentUnchanged = await evaluate(`(${VISIBLE_EDITOR})?.querySelector('.cm-content')?.textContent.includes('function greet')`)
    const tableTextUnchanged = await evaluate(`(() => {
      const table = (${REAL_TABLE(VISIBLE_EDITOR)})
      return !!table && table.textContent.includes('甲') && table.textContent.includes('丁')
    })()`)
    // Compare structural child count rather than assuming a specific inner
    // tag (Mermaid's SVG internals — <text> vs foreignObject <span> labels —
    // vary by diagram type/version); a node view that kept the SAME svg
    // element but silently re-rendered emptied/different content would still
    // show a count mismatch or a drop to zero.
    const mermaidContentUnchanged = await evaluate(`(() => {
      const svg = (${MERMAID_PREVIEW_SVG(VISIBLE_EDITOR)})
      return !!svg && svg.children.length > 0 && svg.children.length === window.__hmProbeMermaidChildCount
    })()`)
    assert.equal(cmContentUnchanged, true, 'code block content changed unexpectedly')
    assert.equal(tableTextUnchanged, true, 'table content changed unexpectedly')
    assert.equal(mermaidContentUnchanged, true, 'Mermaid preview svg content went missing/empty unexpectedly')

    // ============================================================
    // 2) Blocked matrix — slash menu (阻止矩阵)
    // ============================================================
    // Reach the slash menu via a plain-text REPLACE (not Enter-based split —
    // see header comment): select the whole one-character 'z' placeholder
    // and retype it as '/'.
    await clickTextEnd(evaluate, send, 'z')
    await pressKey(send, { key: 'Home', code: 'Home', modifiers: 8, delayMs: delay }) // Shift+Home
    await sleep(150)
    await typeTextLikeUser(send, '/', { delayMs: delay })
    await waitFor(async () => (await paragraphTexts(evaluate)).includes('/'), 'placeholder paragraph never became "/"')

    await waitFor(() => evaluate(`document.querySelectorAll('.milkdown-slash-menu[data-show="true"] .hm-slash-item').length > 0`),
      'slash menu never opened')
    let items = await slashItems(evaluate)
    assert.ok(items.length > 5, `slash menu opened with too few items: ${JSON.stringify(items)}`)
    assert.ok(
      items.every((item) => item.disabled === isStructurallyBlocked(item)),
      `every structural slash item must be .disabled except 'quote' (kernel-routed) in kernel mode: ${JSON.stringify(items)}`
    )

    // (a) Enter on the highlighted (first) disabled item: menu closes,
    // document bytes unchanged, no command ran.
    let beforeEnter = await paragraphTexts(evaluate)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await sleep(300)
    let afterEnter = await paragraphTexts(evaluate)
    assert.deepEqual(afterEnter, beforeEnter, 'a blocked slash item ran (or otherwise changed the document) on Enter')
    const menuShownAfterEnter = await evaluate(`document.querySelector('.milkdown-slash-menu')?.getAttribute('data-show')`)
    assert.equal(menuShownAfterEnter, 'false', 'slash menu did not close after refusing a blocked item via Enter')

    // (b) reopen (click away, click back — no text change, shouldShow just
    // re-evaluates the same still-'/'-starting block) and click a blocked
    // item with the pointer instead of the keyboard.
    await clickTextEnd(evaluate, send, FAR_PARAGRAPH_AFTER_TYPING)
    await sleep(150)
    await clickTextEnd(evaluate, send, '/')
    await waitFor(() => evaluate(`document.querySelectorAll('.milkdown-slash-menu[data-show="true"] .hm-slash-item').length > 0`),
      'slash menu never reopened for the click-based check')
    items = await slashItems(evaluate)
    assert.ok(
      items.every((item) => item.disabled === isStructurallyBlocked(item)),
      `reopened slash menu items must still match the disabled matrix (quote excepted): ${JSON.stringify(items)}`
    )

    const firstItemPoint = await evaluate(`(() => {
      const li = document.querySelector('.milkdown-slash-menu[data-show="true"] .hm-slash-item[data-index="0"]')
      const rect = li?.getBoundingClientRect()
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    })()`)
    assert.ok(firstItemPoint, 'first slash item is not hit-testable')
    const beforeClick = await paragraphTexts(evaluate)
    await click(send, firstItemPoint)
    await sleep(300)
    const afterClick = await paragraphTexts(evaluate)
    assert.deepEqual(afterClick, beforeClick, 'a blocked slash item ran (or otherwise changed the document) on click')
    const menuShownAfterClick = await evaluate(`document.querySelector('.milkdown-slash-menu')?.getAttribute('data-show')`)
    assert.equal(menuShownAfterClick, 'false', 'slash menu did not close after refusing a blocked item via click')
    assert.equal(app.dialogs.length, 0, 'no dialog appeared from the blocked slash-menu interactions')

    // ============================================================
    // 3) Selection toolbar APPEARS in kernel mode (Plan 4 Task 3 flip)
    // ============================================================
    // Crepe's Toolbar feature is back on for kernel tabs: its mark buttons
    // dispatch toggleMark, which the gateway classifies as `mark-toggle`
    // and routes through the kernel. With DEFAULT settings (selection
    // toolbar enabled), dragging a selection must therefore show the
    // floating toolbar — the pre-Plan-4 assertion ("never appears") is
    // deliberately inverted here.
    const dragSelection = async (text) => {
      // The visible-editor lookup has been observed to flip to a different
      // (kept-mounted, offscreen) tab for a single query in between two
      // otherwise-adjacent evaluate() calls with no app interaction between
      // them — a transient DOM/layout settle, not a real navigation (the
      // very next query always finds this tab's own content again). Poll
      // instead of trusting one query.
      const geometry = await waitFor(() => evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        const node = [...(editor?.querySelectorAll('p') || [])].find((candidate) => candidate.textContent === ${JSON.stringify(text)})
        if (!node) return null
        node.scrollIntoView({ block: 'center' })
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
        const textNode = walker.nextNode()
        if (!textNode) return null
        const range = document.createRange()
        range.setStart(textNode, 0)
        range.setEnd(textNode, Math.min(6, textNode.textContent.length))
        const rect = range.getBoundingClientRect()
        if (!rect.width) return null
        return { startX: rect.left + 2, endX: rect.right - 2, y: rect.top + rect.height / 2 }
      })()`), `could not locate a text range to select in: ${text}`, 20)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geometry.startX, y: geometry.y, button: 'left', clickCount: 1 })
      for (let step = 1; step <= 4; step += 1) {
        const x = geometry.startX + ((geometry.endX - geometry.startX) * step) / 4
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: geometry.y, button: 'left', buttons: 1 })
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geometry.endX, y: geometry.y, button: 'left', clickCount: 1 })
      await sleep(200)
      return { startX: geometry.startX, y: geometry.y }
    }

    await dragSelection(FAR_PARAGRAPH_AFTER_TYPING)
    const selectedText = await evaluate(`window.getSelection()?.toString() || ''`)
    assert.ok(selectedText.length > 0, 'mouse drag did not create a text selection')
    await sleep(300)
    // NOTE: multiple kept-mounted editors (the pre-kernel instance survives
    // the kernel remount, plus any welcome tab) each own a `.milkdown-toolbar`
    // — a bare `document.querySelector` grabs the FIRST one, which is the
    // hidden non-kernel instance's. Scan ALL of them for a visible one.
    const toolbarVisible = await evaluate(`[...document.querySelectorAll('.milkdown-toolbar')].some((toolbar) => {
      const style = getComputedStyle(toolbar)
      const rect = toolbar.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    })`)
    assert.equal(toolbarVisible, true,
      'floating selection toolbar must appear on selection in kernel mode (Plan 4 Task 3: mark toggles are kernel-routed)')
    // Clear the selection so the toolbar goes away before the settings
    // navigation below (a lingering floating toolbar could sit over the
    // buttons the next section clicks).
    await evaluate(`window.getSelection()?.removeAllRanges()`)
    await sleep(200)

    // ============================================================
    // 4) Right-click context menu (Plan 4 Task 3 flip): the FORMAT submenu
    //    now EXISTS (mark toggles are kernel-routed; its link item alone is
    //    `.disabled`), while review/turn-into/list-conversion stay away.
    // ============================================================
    // Disable the selection-toolbar SETTING (same setup
    // test-selection-toolbar-ui.mjs uses) so the fallback ctxMenu's
    // `showTextFormatting` is TRUE for a non-empty selection — the format
    // submenu only renders as the toolbar's fallback.
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

    // A default onboarding/welcome tab can be open alongside this fixture's
    // tab (kept-mounted, per the app's lazy-mount convention) — a generic
    // "not Settings" match can click that instead of this fixture's own
    // tab. Target the fixture's tab by its filename specifically.
    const fixtureTabExists = await evaluate(`!![...document.querySelectorAll('.tab')].find((node) => (node.textContent || '').includes('kernel-nodeview.md'))`)
    assert.ok(fixtureTabExists, "this fixture's own tab is missing after opening settings")
    await evaluate(`[...document.querySelectorAll('.tab')].find((node) => (node.textContent || '').includes('kernel-nodeview.md'))?.click()`)
    await waitFor(() => evaluate(`(${VISIBLE_EDITOR})?.textContent.includes('填充六')`), 'document did not return after settings')
    await sleep(200)

    const point = await dragSelection(FAR_PARAGRAPH_AFTER_TYPING)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.startX + 8, y: point.y, button: 'right', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.startX + 8, y: point.y, button: 'right', clickCount: 1 })
    await waitFor(() => evaluate(`!!document.querySelector('.block-ctxmenu')`), 'right-click context menu did not open')

    const ctxMenuAudit = await evaluate(`({
      hasFormatTrigger: !!document.querySelector('[data-context-submenu-trigger="format"]'),
      hasReviewTrigger: !!document.querySelector('[data-context-submenu-trigger="review"]'),
      hasBlockTrigger: !!document.querySelector('[data-context-submenu-trigger="block"]'),
      hasListTrigger: !!document.querySelector('[data-context-submenu-trigger="list"]'),
      hasFormatSubmenu: !!document.querySelector('[data-context-submenu="format"]'),
      hasBlockTextFormat: document.querySelectorAll('.block-text-format').length,
      disabledFormatItems: [...document.querySelectorAll('.block-text-format.disabled')].map((node) => node.textContent.trim()),
      hasListConversion: document.querySelectorAll('.block-list-conversion').length,
      menuVisible: !!document.querySelector('.block-ctxmenu')
    })`)
    assert.deepEqual({ ...ctxMenuAudit, disabledFormatItems: ctxMenuAudit.disabledFormatItems.length }, {
      hasFormatTrigger: true,
      hasReviewTrigger: false,
      hasBlockTrigger: false,
      hasListTrigger: false,
      hasFormatSubmenu: true,
      hasBlockTextFormat: 6,
      // P5-6 flipped this from 1 to 0: `link` was the last format item that
      // kernel mode disabled. The LinkTooltip flow now routes through the
      // gateway's `link-edit` classification, so every format item is live.
      disabledFormatItems: 0,
      hasListConversion: 0,
      menuVisible: true
    }, `kernel mode's right-click menu must offer the FORMAT submenu (6 live items) and nothing structural: ${JSON.stringify(ctxMenuAudit)}`)

    await evaluate(`document.querySelector('.menu-backdrop')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await sleep(200)
    assert.equal(app.dialogs.length, 0, 'no dialog appeared from the right-click blocked-matrix check')

    // ============================================================
    // 5) Kernel-owned code editing — the LF `js` block is EDITABLE
    //    (source-kernel Plan 3 Task 5: the blanket read-only became a
    //    per-block dynamic gate; a proven-charMap LF block edits natively,
    //    CM -> forwardUpdate -> gateway commit), and a CM-focused Mod-z
    //    undoes the typed character through KERNEL history, restoring the
    //    pre-edit bytes exactly (which keeps the derived SAVED expectation
    //    below valid).
    // ============================================================
    // scrollIntoView FIRST (Task 1 fix report finding): without it, on this
    // tall fixture the `js` block's `.cm-line` rect can land off-screen
    // (observed y:-480 during this task's own investigation), the click
    // lands nowhere, no keystrokes ever reach CM, and the assertions below
    // pass vacuously.
    await evaluate(`(${VISIBLE_EDITOR})?.querySelector('.cm-editor')?.scrollIntoView({ block: 'center' })`)
    await sleep(400)
    const codePoint = await evaluate(`(() => {
      const line = (${VISIBLE_EDITOR})?.querySelector('.cm-editor .cm-line')
      const rect = line?.getBoundingClientRect()
      return rect && rect.width ? { x: rect.left + 4, y: rect.top + rect.height / 2 } : null
    })()`)
    assert.ok(codePoint, 'code block line is not hit-testable')
    const cmTextBefore = await evaluate(`(${VISIBLE_EDITOR})?.querySelector('.cm-content')?.textContent`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...codePoint, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...codePoint, button: 'left', clickCount: 1 })
    await sleep(200)
    await typeTextLikeUser(send, 'K', { delayMs: delay })
    await sleep(300)
    const cmTextTyped = await evaluate(`(${VISIBLE_EDITOR})?.querySelector('.cm-content')?.textContent`)
    assert.ok(
      cmTextTyped !== cmTextBefore && cmTextTyped.includes('K'),
      `typing into the LF js code block did not land (kernel-owned CM editing broken): ${JSON.stringify(cmTextTyped)}`
    )
    // The typed character must have reached the KERNEL bytes, not just the
    // CM DOM: a CM-focused Mod-z routes through kernel history and must
    // restore the exact pre-edit content (a CM-local undo, or a swallowed
    // no-op, would leave the char behind).
    await pressUndo(send)
    await waitFor(async () => (await evaluate(`(${VISIBLE_EDITOR})?.querySelector('.cm-content')?.textContent`)) === cmTextBefore,
      'CM-focused Mod-z did not undo the typed code-block character through kernel history')

    // Edit the visible source textarea in place (used by 5.5's byte proof and
    // by 5.8's projection-sync regression). Defined here so both sections can
    // reach it; `evaluate` is a `let` binding in this scope, so the closure
    // still resolves to the live CDP session after the cold-reopen relaunch.
    const editSourceMarker = async (from, to) => evaluate(`(() => {
      const ta = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)
      if (!ta) return false
      const idx = ta.value.indexOf(${JSON.stringify(from)})
      if (idx < 0) return false
      ta.setRangeText(${JSON.stringify(to)}, idx, idx + ${JSON.stringify(from)}.length, 'end')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)

    // ============================================================
    // 5.5) A previewed fence is EDITABLE, and a CM-focused Mod-z is the
    //      KERNEL's undo — the two halves of the code-block bridge, probed
    //      on the mermaid block (the fixture's only PREVIEWED fence).
    // ============================================================
    // Reached via the toolbar's Hide/Edit toggle rather than the always-
    // editor-visible `js` block: `.preview-toggle-button` only renders when
    // `renderPreview` produces content (see @milkdown/components code-block
    // `setup()`, `preview.value ? h('button', {class:'preview-toggle-button'}...) : null`),
    // which is true only for this fixture's mermaid block
    // (editor-mermaid.js's renderer). previewOnlyByDefault starts it in
    // preview mode (`.codemirror-host` carries a `hidden` class); clicking
    // the toggle flips `previewOnlyMode` and reveals the real `.cm-editor`
    // underneath — the exact path the task brief calls out.
    const mermaidToggle = await evaluate(`(() => {
      const block = (${MERMAID_BLOCK(VISIBLE_EDITOR)})
      block?.scrollIntoView({ block: 'center' })
      return !!block
    })()`)
    assert.ok(mermaidToggle, 'mermaid code block not found for the editable/undo-bridge probe')
    await sleep(400)
    const togglePoint = await evaluate(`(() => {
      const block = (${MERMAID_BLOCK(VISIBLE_EDITOR)})
      const button = block?.querySelector('.preview-toggle-button')
      const rect = button?.getBoundingClientRect()
      return rect && rect.width ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
    })()`)
    assert.ok(togglePoint, 'mermaid code block preview-toggle button is not hit-testable')
    await click(send, togglePoint)
    await waitFor(() => evaluate(`!(${MERMAID_BLOCK(VISIBLE_EDITOR)})?.querySelector('.codemirror-host')?.classList.contains('hidden')`),
      "clicking Edit did not reveal the mermaid code block's CodeMirror editor")
    await sleep(150)

    const mermaidLinePoint = await evaluate(`(() => {
      const block = (${MERMAID_BLOCK(VISIBLE_EDITOR)})
      block?.scrollIntoView({ block: 'center' })
      const line = block?.querySelector('.cm-editor .cm-line')
      const rect = line?.getBoundingClientRect()
      return rect && rect.width ? { x: rect.left + 4, y: rect.top + rect.height / 2 } : null
    })()`)
    assert.ok(mermaidLinePoint, 'mermaid code block CM line is not hit-testable after the Edit toggle')
    await sleep(400)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mermaidLinePoint, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mermaidLinePoint, button: 'left', clickCount: 1 })
    await sleep(200)
    const mermaidCmFocused = await evaluate(`document.activeElement?.className || ''`)
    assert.ok(mermaidCmFocused.includes('cm-content'), `click did not focus the mermaid CodeMirror editor (activeElement: ${mermaidCmFocused})`)

    // The pre-probe content of this block, and the baseline every assertion
    // below measures against. Held FIXED across the undo/redo bridge probe
    // (which must not touch this block at all) and restored exactly by the
    // editable-fence probe that follows it.
    const mermaidCmBaseline = await evaluate(`(${MERMAID_BLOCK(VISIBLE_EDITOR)})?.querySelector('.cm-content')?.textContent`)
    assert.equal(mermaidCmBaseline, MERMAID_CODE,
      `the mermaid block did not start from the fixture's own source: ${JSON.stringify(mermaidCmBaseline)}`)

    // Part A: the nodeview's own `codeMirrorKeymap()` binds Mod-z/Mod-y/
    // Shift-Mod-z directly to `@milkdown/prose/history`'s undo/redo at
    // default precedence, and `stopEvent()` on a CM-originated event
    // returns true, so a PM-level keymap (the kernel's own historyKeymap)
    // never sees a CM-focused Mod-z. In kernel mode the source kernel is
    // the SOLE undo authority: a CM-focused Mod-z must reach the SAME
    // `runHistory('undo')` entry point PM-focused Mod-z uses, never
    // prosemirror-history.
    //
    // By this point in the script kernel history is NOT empty — sections 1
    // and 2 already recorded two real kernel commits (the far-paragraph
    // typing, then the 'z' -> '/' slash replace) — so a correctly wired
    // bridge's Mod-z must perform a REAL kernel-level undo of the most
    // recent one (the slash replace, reverting '/' back to 'z'), not a
    // silent no-op: a handler that merely swallows the key WITHOUT calling
    // into the kernel would leave the document unchanged and this
    // assertion would pass vacuously, proving nothing. Checking the
    // paragraph text (not just this code block's own content) also rules
    // out prosemirror-history quietly acting on some other tracked step.
    const beforeUndo = await paragraphTexts(evaluate)
    assert.ok(beforeUndo.includes('/'), `expected the slash-replaced paragraph before undo: ${JSON.stringify(beforeUndo)}`)
    await pressUndo(send)
    await waitFor(async () => (await paragraphTexts(evaluate)).includes('z'),
      'Mod-z inside the mermaid code block did not reach kernel history (slash replace was not undone)')
    const mermaidCmAfterUndo = await evaluate(`(${MERMAID_BLOCK(VISIBLE_EDITOR)})?.querySelector('.cm-content')?.textContent`)
    assert.equal(mermaidCmAfterUndo, mermaidCmBaseline,
      "Mod-z inside the mermaid code block changed its OWN CodeMirror content (must route through the kernel, not CodeMirror's/prosemirror-history's own undo)")

    // Redo (Shift-Mod-z) must symmetrically reach `runHistory('redo')` and
    // restore the slash replace — completing the round trip through the
    // SAME kernel history the PM-focused undo/redo keymap uses, entirely
    // from a CM-focused keystroke.
    const redoParams = { key: 'z', code: 'KeyZ', modifiers: 12, windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 } // Shift+Meta
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...redoParams })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...redoParams })
    await waitFor(async () => (await paragraphTexts(evaluate)).includes('/'),
      'Shift-Mod-z inside the mermaid code block did not redo through kernel history (slash replace was not restored)')
    const mermaidCmAfterRedo = await evaluate(`(${MERMAID_BLOCK(VISIBLE_EDITOR)})?.querySelector('.cm-content')?.textContent`)
    assert.equal(mermaidCmAfterRedo, mermaidCmBaseline,
      "Shift-Mod-z inside the mermaid code block changed its OWN CodeMirror content (must route through the kernel)")

    // Part B: a PREVIEWED fence is an EDITABLE fence.
    //
    // This segment used to assert the opposite — that CodeMirror inside a
    // ```mermaid block was genuinely read-only in kernel mode (a
    // `READONLY_CODE_LANGUAGES` policy gate that forced `charMap: null` for
    // every previewed fence). `c173ca0` deleted that gate on purpose: the
    // rendered preview is a SIBLING of an always-mounted CodeMirror, none of
    // the kernel's three code-block proofs reads the DOM, and every shape of
    // this fence maps byte-exactly — so the refusal was protecting nothing
    // while costing the user the ability to edit their own diagram.
    //
    // The replacement is strictly stronger than the refusal it replaces: it
    // is not enough for the keystroke to appear in CodeMirror (that is
    // exactly the symptom `ed60fe2`'s wedged `updating` flag produced while
    // the document never received a byte). The typed text must also be
    // PRESENT IN THE KERNEL'S SOURCE BYTES, asserted byte-for-byte against
    // the same derived expectation the save/reopen section uses.
    //
    // 'End' first so the insertion column is deterministic regardless of
    // where the click's own hit-test landed within the line.
    await pressKey(send, { key: 'End', code: 'End', delayMs: delay })
    await typeTextLikeUser(send, MERMAID_TYPED, { delayMs: delay })
    await waitFor(async () =>
      (await evaluate(`(${MERMAID_BLOCK(VISIBLE_EDITOR)})?.querySelector('.cm-content')?.textContent`)) === MERMAID_CODE + MERMAID_TYPED,
    'typing into the previewed mermaid fence did not reach its CodeMirror (a previewed fence must be editable — c173ca0)')

    await toggleSourceMode(evaluate)
    const sourceWithMermaidEdit = await waitFor(() => visibleSource(evaluate), 'source view did not appear after the mermaid typing probe')
    assert.equal(sourceWithMermaidEdit, SAVED.replace(MERMAID_CODE, MERMAID_CODE + MERMAID_TYPED),
      'text typed into the previewed mermaid fence never reached the kernel source bytes (CodeMirror showed it, the document never received it)')

    // Revert through the source textarea (a kernel-owned replaceMarkdown, not
    // a CM-local edit) so the derived SAVED/AFTER_TYPING expectations the
    // sections below assert stay valid.
    assert.ok(await editSourceMarker(MERMAID_CODE + MERMAID_TYPED, MERMAID_CODE), 'could not revert the mermaid typing probe')
    const sourceAfterCmProbe = await waitFor(async () => {
      const value = await visibleSource(evaluate)
      return value === SAVED ? value : null
    }, 'reverting the mermaid typing probe did not restore the exact pre-probe source bytes')
    assert.equal(sourceAfterCmProbe, SAVED,
      'kernel document bytes do not match the derived expectation after the CM editable/undo-bridge probe (undo/redo must round-trip; the mermaid edit must revert exactly)')
    await toggleSourceMode(evaluate)
    await waitFor(async () => (await mounted(evaluate) || '').includes('填充六'), 'did not return to rich mode after the editable/undo-bridge probe')
    await waitFor(async () =>
      (await evaluate(`(${MERMAID_BLOCK(VISIBLE_EDITOR)})?.querySelector('.cm-content')?.textContent`)) === mermaidCmBaseline,
    'the mermaid CodeMirror did not follow the kernel back to its pre-probe content')
    await sleep(200)

    // ============================================================
    // 5.8) PM -> CM projection sync survives a kernel-owned out-of-band
    //      edit reaching a code block (review fix: a blanket
    //      `EditorState.changeFilter.of(() => false)` — an earlier version
    //      of the bridge — silently ate the CodeMirrorBlock nodeview's OWN
    //      `update(node)` re-sync dispatch too, not just user keystrokes).
    // ============================================================
    // Editing the code block's TEXT through the source-mode textarea and
    // switching back is a kernel-owned `replaceMarkdown` projection-diff
    // commit (editor-kernel-mode.js apiOverrides.replaceMarkdown ->
    // reconcileProjection), never a CM-local edit — exactly the path a
    // blanket changeFilter broke: kernel.doc.text would be correct but
    // `.cm-content` would stay stale forever (editor-codeblock-eager.js's
    // eager-mount convention means the nodeview never tears down/remounts
    // to pick up a fresh value on its own).
    const JS_MARKER = 'function greet(name) {'
    const JS_MARKER_EDITED = 'function greet(name) { // hm-projection-sync-probe'

    await toggleSourceMode(evaluate)
    const sourceBeforeProjectionEdit = await waitFor(() => visibleSource(evaluate), 'source view did not appear for the projection-sync regression')
    assert.ok(sourceBeforeProjectionEdit.includes(JS_MARKER), 'js code block marker text missing from source before the projection-sync edit')
    assert.ok(await editSourceMarker(JS_MARKER, JS_MARKER_EDITED), 'could not apply the projection-sync source edit')
    const sourceAfterProjectionEdit = await waitFor(() => visibleSource(evaluate), 'source textarea did not update after the projection-sync edit')
    assert.ok(sourceAfterProjectionEdit.includes(JS_MARKER_EDITED), 'source-mode edit to the code block did not take effect in the textarea')

    await toggleSourceMode(evaluate)
    await waitFor(async () => (await mounted(evaluate) || '').includes('填充六'), 'did not return to rich mode after the projection-sync edit')
    await waitFor(
      () => evaluate(`(${JS_BLOCK(VISIBLE_EDITOR)})?.querySelector('.cm-content')?.textContent?.includes(${JSON.stringify('// hm-projection-sync-probe')})`),
      'CodeMirror did not pick up the kernel-owned source-mode edit after switching back to rich (PM -> CM projection sync regression)'
    )

    // Revert, so the fixture's derived SAVED/AFTER_TYPING expectations
    // (computed from the untouched FIXTURE string) stay valid for section 6
    // below — and prove the sync also works in the other direction.
    await toggleSourceMode(evaluate)
    await waitFor(() => visibleSource(evaluate), 'source view did not reappear for the projection-sync revert')
    assert.ok(await editSourceMarker(JS_MARKER_EDITED, JS_MARKER), 'could not revert the projection-sync source edit')
    const sourceAfterRevert = await waitFor(() => visibleSource(evaluate), 'source textarea did not update after the projection-sync revert')
    assert.equal(sourceAfterRevert, SAVED, 'reverting the projection-sync probe did not restore the exact pre-probe source bytes')

    await toggleSourceMode(evaluate)
    await waitFor(async () => (await mounted(evaluate) || '').includes('填充六'), 'did not return to rich mode after the projection-sync revert')
    await waitFor(
      () => evaluate(`!(${JS_BLOCK(VISIBLE_EDITOR)})?.querySelector('.cm-content')?.textContent?.includes(${JSON.stringify('// hm-projection-sync-probe')})`),
      'CodeMirror still showed the projection-sync probe text after the revert reached rich mode'
    )
    await sleep(200)

    // ============================================================
    // 6) Save and assert byte-exact kernel output; cold reopen
    // ============================================================
    await toggleSourceMode(evaluate)
    const shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear')
    assert.equal(shown, SAVED, 'kernel-mode source bytes must match the derived expectation exactly (identity + blocked-matrix edits only)')

    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    assert.equal(await readFile(file, 'utf8'), SAVED, 'disk bytes must match the derived expectation exactly')
    assert.equal(app.dialogs.length, 0, `no rebuild prompt may appear: ${JSON.stringify(app.dialogs.map((dialog) => dialog.message))}`)

    await stopBuiltElectron(app, { removeProfile: false })
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, cleanProfile: false, appArgs: [file] })
    ;({ evaluate, send } = app)
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes(FAR_PARAGRAPH_AFTER_TYPING) && text.includes('填充六') ? text : null
    }, 'reopened document did not mount with the saved content')
    await toggleSourceMode(evaluate)
    const reopened = await waitFor(() => visibleSource(evaluate), 'source view did not appear after cold reopen')
    assert.equal(reopened, SAVED, 'cold reopen must reproduce the saved kernel-mode bytes exactly, byte-for-byte')
    assert.equal(app.dialogs.length, 0, 'no rebuild prompt may appear on cold reopen')

    console.log('PASS kernel-mode node-view identity + blocked-matrix UI: CodeMirror/image/table identity and scroll position survive a far edit; slash/right-click refuse structural operations while the selection toolbar and format submenu are live (no item disabled); a previewed mermaid fence is editable down to the source bytes and a CM-focused Mod-z/Shift-Mod-z is the kernel’s own history; save and cold reopen match the kernel-derived byte string')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
