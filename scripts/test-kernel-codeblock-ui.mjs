// Kernel-mode code-block domain end-to-end regression (source-kernel
// integration Plan 3, Task 6): the first REAL, live-app exercise of every
// P3-1..P3-5 code-block behavior chained together in one document — LF
// top-level fence multi-line editing (type/Enter/Backspace, both within a
// line and ACROSS a line boundary), quoted-fence per-line prefix expansion
// on both insert AND delete, the language picker's AttrStep rewrite,
// Mod-Enter exit, CM-focused kernel undo, editing a PREVIEW-BACKED mermaid
// fence through its Edit toggle (2026-08-18: step 7 used to assert the
// per-block gate REFUSED that block; see its own comment), and a save +
// cold reopen.
//
// The delete path matters as its own case (review round 1 finding): a
// live DOM Backspace routes through CodeMirror's own changeset ->
// `forwardUpdate` -> an EMPTY-insert PM ReplaceStep -> the SAME
// `commitPlainText` gateway a typed insert uses, and — for a Backspace at
// a line's START — the deleted PM range crosses the code_block's internal
// bare '\n' (there is no separate hardbreak node inside a code block's
// text* content model), which `buildCodeMap`'s linebreak-unit raw span
// maps to MORE than one raw byte for a quoted fence: the terminator AND
// the next line's '> ' prefix. This script proves both shapes byte-exact,
// not just the insert-only paths.
//
// Every "expected bytes" string below is DERIVED, not guessed: it is the
// literal output of running the real kernel primitives this UI exercises
// (`buildCodeMap`/`applySourceTransaction`/`changeCodeLanguage`/
// `exitCodeBlock`/`createSourceHistory`, imported straight from
// src/renderer/src/lib/source-kernel/) against the exact same fixture and
// edit sequence — see task-6-report.md for the derivation transcript. The
// kernel is the oracle; this script only proves the live UI reaches the
// same bytes.
//
// Two edit sites were deliberately chosen to sidestep CodeMirror behavior
// this module does not own and cannot predict without running the real
// editor:
//  - Every multi-line edit lands at nesting depth 0 (end of the js block's
//    closing `}` line; the py block has no colon-indented context at all) —
//    CM6's language-aware `insertNewlineAndIndent` can add extra leading
//    whitespace for a new line at depth > 0, which no pure derivation can
//    predict; depth 0 keeps the inserted `\n` byte-for-byte bare.
//  - No typed text ever contains a bracket/quote character — @codemirror/
//    autocomplete's `closeBrackets` (part of `basicSetup`, which Crepe's
//    CodeMirror feature ships unconditionally) auto-inserts a matching
//    close on an open bracket; avoiding brackets entirely avoids reasoning
//    about its type-over behavior.
// The language name discovered from the live LanguagePicker DOM
// (`.language-list-item[data-language]`) is substituted into every
// downstream expectation via `withLang()` rather than assumed — this
// script does not hardcode a casing for @codemirror/language-data's
// "Python" entry.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-cb-${process.pid}`
const file = join(root, 'kernel-codeblock.md')
const port = Number(process.env.CDP_PORT || 10023)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

const FIXTURE = [
  '# 内核代码块测试',
  '',
  '前置段落用于占位。',
  '',
  '```js',
  'function greet(name) {',
  '  return name;',
  '}',
  '```',
  '',
  '引用中的代码：',
  '',
  '> ```py',
  '> print(name)',
  '> ```',
  '',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '',
  '尾段落用于占位。',
  ''
].join('\n')

// ---- Kernel-derived expectations (see header + task-6-report.md) ----
const AFTER_JS_EDIT = [
  '# 内核代码块测试',
  '',
  '前置段落用于占位。',
  '',
  '```js',
  'function greet(name) {',
  '  return name;',
  '}TAILMARK',
  'NEXTLINE',
  '```',
  '',
  '引用中的代码：',
  '',
  '> ```py',
  '> print(name)',
  '> ```',
  '',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '',
  '尾段落用于占位。',
  ''
].join('\n')

// Backspace x2 at the end of "NEXTLINE" deletes its last two chars ("NE"),
// a plain within-line delete through the SAME `commitPlainText` path a
// typed insert uses (an empty-insert `ReplaceStep`, `plainSliceText`
// explicitly allows `slice.size === 0`).
const AFTER_JS_BACKSPACE = [
  '# 内核代码块测试',
  '',
  '前置段落用于占位。',
  '',
  '```js',
  'function greet(name) {',
  '  return name;',
  '}TAILMARK',
  'NEXTLI',
  '```',
  '',
  '引用中的代码：',
  '',
  '> ```py',
  '> print(name)',
  '> ```',
  '',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '',
  '尾段落用于占位。',
  ''
].join('\n')

// Backspace at the START of "NEXTLI" joins it with the previous line: CM's
// flat code_block text model has no separate hardbreak node (a bare '\n' IS
// the content — editor-kernel-gateway.js's `allowNewline` comment), so this
// is a ONE-character PM deletion whose raw span is the codeMap linebreak
// unit's full span. For this UNPREFIXED top-level fence that span is just
// the '\n' itself (linePrefix === '').
const AFTER_JS_JOIN = [
  '# 内核代码块测试',
  '',
  '前置段落用于占位。',
  '',
  '```js',
  'function greet(name) {',
  '  return name;',
  '}TAILMARKNEXTLI',
  '```',
  '',
  '引用中的代码：',
  '',
  '> ```py',
  '> print(name)',
  '> ```',
  '',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '',
  '尾段落用于占位。',
  ''
].join('\n')

const AFTER_PY_EDIT = [
  '# 内核代码块测试',
  '',
  '前置段落用于占位。',
  '',
  '```js',
  'function greet(name) {',
  '  return name;',
  '}TAILMARKNEXTLI',
  '```',
  '',
  '引用中的代码：',
  '',
  '> ```py',
  '> print(name) OKMARK',
  '> DONEMARK',
  '> ```',
  '',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '',
  '尾段落用于占位。',
  ''
].join('\n')

// Backspace x2 at the end of "DONEMARK" deletes its last two chars ("RK"):
// the within-line delete on the QUOTED fence, the fourth combination the
// review round 2 finding called out (js-within-line/js-join/py-join already
// existed; py-within-line was the missing one).
const AFTER_PY_BACKSPACE = [
  '# 内核代码块测试',
  '',
  '前置段落用于占位。',
  '',
  '```js',
  'function greet(name) {',
  '  return name;',
  '}TAILMARKNEXTLI',
  '```',
  '',
  '引用中的代码：',
  '',
  '> ```py',
  '> print(name) OKMARK',
  '> DONEMA',
  '> ```',
  '',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '',
  '尾段落用于占位。',
  ''
].join('\n')

// Backspace at the START of "DONEMA" joins it with the previous quoted
// line: the codeMap linebreak unit's raw span for a QUOTED fence spans the
// terminator AND the next line's '> ' prefix (buildCodeMap's own
// `rawEnd = nextLine.start + prefix.length` for a linebreak unit), so this
// single CM-visible character deletion must swallow '\n> ' (3 raw bytes),
// not just '\n' — the exact case Task 6's first review round called out.
const AFTER_PY_JOIN = [
  '# 内核代码块测试',
  '',
  '前置段落用于占位。',
  '',
  '```js',
  'function greet(name) {',
  '  return name;',
  '}TAILMARKNEXTLI',
  '```',
  '',
  '引用中的代码：',
  '',
  '> ```py',
  '> print(name) OKMARKDONEMA',
  '> ```',
  '',
  '```mermaid',
  'graph TD; A-->B;',
  '```',
  '',
  '尾段落用于占位。',
  ''
].join('\n')

// `__LANG__` stands in for whatever exact casing the live LanguagePicker's
// `data-language` reports for "python" (@codemirror/language-data) —
// substituted at runtime, never assumed.
const withLang = (template, lang) => template.split('__LANG__').join(lang)

const AFTER_LANG_SWITCH_TPL = AFTER_PY_JOIN.replace('```js\n', '```__LANG__\n')

const AFTER_EXIT_TPL = AFTER_LANG_SWITCH_TPL.replace(
  'NEXTLI\n```\n\n引用中的代码',
  'NEXTLI\n```\n\n\n\n引用中的代码'
)

const AFTER_EXIT_TYPE_TPL = AFTER_LANG_SWITCH_TPL.replace(
  'NEXTLI\n```\n\n引用中的代码',
  'NEXTLI\n```\nZ\n\n\n引用中的代码'
)

// `__LANG2__` stands in for the live picker's exact casing for the mermaid
// block's own switch (final-review finding, 2026-08-16: the from-readonly
// language-switch refusal was lifted — mermaid -> a real language must
// commit AND leave the block genuinely editable right after, so this proves
// the switch-then-type sequence end to end in the live app, not just
// headlessly). Built from AFTER_LANG_SWITCH_TPL — the exact document state
// right before the mermaid-blocked probe (step 7) below.
const withLang2 = (template, lang) => template.split('__LANG2__').join(lang)

// Step 7 (REWRITTEN 2026-08-18) types into the mermaid fence itself, which
// used to be refused. See the ADR that replaced `READONLY_CODE_LANGUAGES` in
// editor-kernel-projection-map.js: the diagram preview is a SIBLING of the
// always-mounted CodeMirror host, so the fence's PM text is its source and
// `buildCodeMap` maps it exactly like any other fence. The typed run avoids
// brackets/quotes (closeBrackets) and adds no second diagram header.
const AFTER_MERMAID_TYPE_TPL = AFTER_LANG_SWITCH_TPL.replace(
  '```mermaid\ngraph TD; A-->B;\n```\n',
  '```mermaid\ngraph TD; A-->B;MERMAIDEDIT\n```\n'
)

const AFTER_MERMAID_SWITCH_TYPE_TPL = AFTER_LANG_SWITCH_TPL.replace(
  '```mermaid\ngraph TD; A-->B;\n```\n',
  '```__LANG2__\ngraph TD; A-->B;MERMAIDEDITMERMAIDNOWJS\n```\n'
)

async function waitFor(check, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
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

// Same split-button convention every kernel-mode UI script documents: the
// plain `.status-btn` (not the kernel caret button) toggles rich/source.
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

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

// `Mod-z` resolves to Meta (Cmd) on darwin — same convention every other
// kernel-mode UI script in this repo uses.
async function pressUndo(send) {
  const params = { key: 'z', code: 'KeyZ', modifiers: 4, windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}

async function pressModEnter(send) {
  const params = { key: 'Enter', code: 'Enter', modifiers: 4, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}

// Discover + capture the fixture's three code blocks by their INITIAL
// language-button label (same convention test-kernel-nodeview-ui.mjs's
// JS_BLOCK/MERMAID_BLOCK helpers use) into window-scoped references so
// every later step (after a language switch renames the js block's own
// button label) can keep addressing the SAME DOM node by identity —
// node-view identity across kernel edits is exactly what Plan 3's
// minimal-diff reconciler guarantees (see test-kernel-nodeview-ui.mjs
// section 1).
async function captureBlocks(evaluate) {
  const found = await evaluate(`(() => {
    const blocks = [...(${VISIBLE_EDITOR})?.querySelectorAll('.milkdown-code-block') || []]
    const byLang = (name) => blocks.find((block) =>
      block.querySelector('.language-button')?.textContent?.trim().toLowerCase() === name)
    window.__hmJsBlock = byLang('js')
    window.__hmPyBlock = byLang('py')
    window.__hmMermaidBlock = byLang('mermaid')
    return {
      js: !!window.__hmJsBlock,
      py: !!window.__hmPyBlock,
      mermaid: !!window.__hmMermaidBlock
    }
  })()`)
  assert.ok(found.js, 'js code block not found')
  assert.ok(found.py, 'quoted py code block not found')
  assert.ok(found.mermaid, 'mermaid code block not found')
}

// Reveal a block's CodeMirror editor via the toolbar's Hide/Edit toggle,
// ONLY if this block actually renders a preview (js/py have none — see
// CodeBlock.tsx: `codemirror-host` is hidden only when `preview.value &&
// previewOnlyMode.value`, and `preview` stays null unless renderPreview
// produces something, which only happens for mermaid in this app — see
// editor-crepe-setup.js). Discovered at runtime rather than assumed, per
// the task brief.
async function ensureCmVisible(evaluate, send, blockRef) {
  const hasToggle = await evaluate(`!!(${blockRef})?.querySelector('.preview-toggle-button')`)
  if (!hasToggle) return
  const point = await evaluate(`(() => {
    const btn = (${blockRef})?.querySelector('.preview-toggle-button')
    const rect = btn?.getBoundingClientRect()
    return rect && rect.width ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`)
  assert.ok(point, 'preview-toggle-button is not hit-testable')
  await click(send, point)
  await waitFor(() => evaluate(`!(${blockRef})?.querySelector('.codemirror-host')?.classList.contains('hidden')`),
    "clicking Edit did not reveal this block's CodeMirror editor")
  await sleep(150)
}

// Click into a block's CodeMirror line (first or last visual line) and land
// the caret at its end via 'End' — same off-screen-click trap every other
// kernel-mode UI script guards against (a tall/scrolled document can put
// the target rect off-screen for the synthetic click).
async function clickCmLineEnd(evaluate, send, blockRef, { last = false } = {}) {
  const point = await evaluate(`(() => {
    const block = ${blockRef}
    if (!block) return null
    block.scrollIntoView({ block: 'center' })
    const lines = [...block.querySelectorAll('.cm-editor .cm-line')]
    const line = ${last} ? lines[lines.length - 1] : lines[0]
    const rect = line?.getBoundingClientRect()
    return rect && rect.width ? { x: rect.right - 2, y: rect.top + rect.height / 2 } : null
  })()`)
  assert.ok(point, 'CodeMirror line is not hit-testable')
  await sleep(400)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(200)
  await pressKey(send, { key: 'End', code: 'End', delayMs: delay })
}

// Mirror of clickCmLineEnd for the cross-line-join Backspace tests: land the
// caret at a CM line's START via 'Home' instead of 'End', so the very next
// Backspace deletes the PRECEDING line's terminator (joining the two lines)
// instead of a content character.
async function clickCmLineStart(evaluate, send, blockRef, { last = false } = {}) {
  const point = await evaluate(`(() => {
    const block = ${blockRef}
    if (!block) return null
    block.scrollIntoView({ block: 'center' })
    const lines = [...block.querySelectorAll('.cm-editor .cm-line')]
    const line = ${last} ? lines[lines.length - 1] : lines[0]
    const rect = line?.getBoundingClientRect()
    return rect && rect.width ? { x: rect.left + 2, y: rect.top + rect.height / 2 } : null
  })()`)
  assert.ok(point, 'CodeMirror line is not hit-testable')
  await sleep(400)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(200)
  await pressKey(send, { key: 'Home', code: 'Home', delayMs: delay })
}

const cmContent = (evaluate, blockRef) => evaluate(`(${blockRef})?.querySelector('.cm-content')?.textContent`)

const cmFocused = (evaluate) => evaluate(`document.activeElement?.className || ''`)

// Open a block's language picker, filter to `query`, read back the EXACT
// `data-language` string the live picker offers, and click it. `blockRef` is
// a window-scoped JS expression string (e.g. 'window.__hmJsBlock') so this
// helper can drive ANY captured code block's own picker instance, not just
// the js block.
async function switchBlockLanguage(evaluate, send, blockRef, query) {
  // The vendored LanguagePicker always PREPENDS the block's CURRENTLY
  // selected language to the filtered list, regardless of the search query
  // (`languages` computed: `return [selected, ...filtered]` — verified by
  // reading @milkdown/components' source) — but ONLY when that current
  // language happens to be a registered canonical language NAME (e.g.
  // "Mermaid", which HorseMD registers so `/mermaid` and this picker can
  // both address it — see editor-crepe-setup.js's `mermaidLanguage`); a
  // non-canonical alias like "js" isn't found by that lookup, so nothing
  // gets prepended there. Captured up front so the picked item can skip it
  // when it IS prepended, instead of always grabbing the (possibly
  // unchanged) first list entry.
  const currentLang = (await evaluate(`(${blockRef})?.querySelector('.language-button')?.textContent?.trim()`)) || ''
  const opened = await evaluate(`(() => {
    const btn = (${blockRef})?.querySelector('.language-button')
    btn?.click()
    return !!btn
  })()`)
  assert.ok(opened, `language-button not found on the block (${blockRef})`)
  await waitFor(() => evaluate(`!!(${blockRef})?.querySelector('.language-picker .search-input')`),
    'language picker did not open')
  await sleep(150)
  const typed = await evaluate(`(() => {
    const input = (${blockRef}).querySelector('.language-picker .search-input')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(query)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  assert.ok(typed, 'could not type into the language search box')
  const language = await waitFor(() => evaluate(`(() => {
    const item = [...(${blockRef}).querySelectorAll('.language-picker .language-list-item')]
      .find((node) => node.dataset.language && node.dataset.language.toLowerCase() !== ${JSON.stringify(currentLang.toLowerCase())})
    return item ? item.dataset.language : null
  })()`), `no language list item matched the ${JSON.stringify(query)} filter (other than the current "${currentLang}")`)
  const clicked = await evaluate(`(() => {
    const item = [...(${blockRef}).querySelectorAll('.language-picker .language-list-item')]
      .find((node) => node.dataset.language === ${JSON.stringify(language)})
    item?.click()
    return !!item
  })()`)
  assert.ok(clicked, `could not click the "${language}" language item`)
  await waitFor(() => evaluate(`(${blockRef}).querySelector('.language-button')?.textContent?.trim() === ${JSON.stringify(language)}`),
    "the block's language-button label did not update after the picker click")
  return language
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
      return text && text.includes('前置段落') && text.includes('尾段落') ? text : null
    }, 'initial document did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on plain mount')

    // ---- 1) enable kernel mode, assert live-attach ----
    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('前置段落') && text.includes('尾段落') ? text : null
    }, 'document did not remount after enabling kernel mode')
    await sleep(300)
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(
      !attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy fallback for this fixture: ${attachDiagnostics}`
    )
    assert.equal(app.dialogs.length, 0, 'no dialog after enabling kernel mode')

    await waitFor(() => evaluate(`!!(${VISIBLE_EDITOR})?.querySelector('.cm-editor')`), 'no code block mounted')
    await captureBlocks(evaluate)

    // ============================================================
    // 2) js top-level fence: multi-line CM edit (type + Enter + type)
    // ============================================================
    await clickCmLineEnd(evaluate, send, 'window.__hmJsBlock', { last: true })
    await typeTextLikeUser(send, 'TAILMARK', { delayMs: delay })
    await waitFor(async () => (await cmContent(evaluate, 'window.__hmJsBlock') || '').includes('TAILMARK'),
      'TAILMARK never landed in the js CodeMirror editor')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await typeTextLikeUser(send, 'NEXTLINE', { delayMs: delay })
    await waitFor(async () => (await cmContent(evaluate, 'window.__hmJsBlock') || '').includes('NEXTLINE'),
      'NEXTLINE never landed in the js CodeMirror editor')
    await sleep(200)

    await toggleSourceMode(evaluate)
    let shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after the js multi-line edit')
    assert.equal(shown, AFTER_JS_EDIT, 'js block multi-line edit must match the kernel-derived bytes exactly')
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return after the js edit verification')
    await sleep(200)

    // ---- 2a) Backspace x2: within-line delete through the live DOM ->
    // CM changeset -> gateway path (the empty-insert ReplaceStep shape
    // `commitPlainText` explicitly allows) ----
    await clickCmLineEnd(evaluate, send, 'window.__hmJsBlock', { last: true })
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: delay + 30 })
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: delay + 30 })
    await waitFor(async () => (await cmContent(evaluate, 'window.__hmJsBlock') || '').includes('NEXTLI') &&
      !(await cmContent(evaluate, 'window.__hmJsBlock') || '').includes('NEXTLIN'),
      'Backspace x2 did not remove the last two typed characters in the js CodeMirror editor')
    await sleep(200)

    await toggleSourceMode(evaluate)
    shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after the js Backspace x2')
    assert.equal(shown, AFTER_JS_BACKSPACE, 'js block within-line Backspace x2 must match the kernel-derived bytes exactly')
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return after the js Backspace x2 verification')
    await sleep(200)

    // ---- 2b) cross-line-join Backspace: caret at a line START joins it
    // with the previous line, which must remove the codeMap linebreak
    // unit's WHOLE raw span (just '\n' for this unprefixed top-level fence)
    // ----
    await clickCmLineStart(evaluate, send, 'window.__hmJsBlock', { last: true })
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: delay + 30 })
    await waitFor(async () => (await cmContent(evaluate, 'window.__hmJsBlock') || '').includes('TAILMARKNEXTLI'),
      'cross-line-join Backspace did not merge the two js CodeMirror lines')
    await sleep(200)

    await toggleSourceMode(evaluate)
    shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after the js cross-line-join Backspace')
    assert.equal(shown, AFTER_JS_JOIN, 'js block cross-line-join Backspace must remove exactly the linebreak, byte-exact')
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return after the js join verification')
    await sleep(200)

    // ============================================================
    // 3) quoted py fence: multi-line CM edit, per-line '> ' prefix expansion
    // ============================================================
    await clickCmLineEnd(evaluate, send, 'window.__hmPyBlock', { last: true })
    await typeTextLikeUser(send, ' OKMARK', { delayMs: delay })
    await waitFor(async () => (await cmContent(evaluate, 'window.__hmPyBlock') || '').includes('OKMARK'),
      'OKMARK never landed in the py CodeMirror editor')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await typeTextLikeUser(send, 'DONEMARK', { delayMs: delay })
    await waitFor(async () => (await cmContent(evaluate, 'window.__hmPyBlock') || '').includes('DONEMARK'),
      'DONEMARK never landed in the py CodeMirror editor')
    await sleep(200)

    await toggleSourceMode(evaluate)
    shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after the py multi-line edit')
    assert.equal(shown, AFTER_PY_EDIT,
      "quoted py block multi-line edit must match the kernel-derived bytes exactly (every new line carries '> ')")
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return after the py edit verification')
    await sleep(200)

    // ---- 3a) Backspace x2: within-line delete on the QUOTED fence (the
    // fourth combination — js-within-line/js-join/py-join already existed,
    // this was the missing one) ----
    await clickCmLineEnd(evaluate, send, 'window.__hmPyBlock', { last: true })
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: delay + 30 })
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: delay + 30 })
    await waitFor(async () => (await cmContent(evaluate, 'window.__hmPyBlock') || '').includes('DONEMA') &&
      !(await cmContent(evaluate, 'window.__hmPyBlock') || '').includes('DONEMAR'),
      'Backspace x2 did not remove the last two typed characters in the py CodeMirror editor')
    await sleep(200)

    await toggleSourceMode(evaluate)
    shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after the py Backspace x2')
    assert.equal(shown, AFTER_PY_BACKSPACE, 'quoted py block within-line Backspace x2 must match the kernel-derived bytes exactly')
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return after the py Backspace x2 verification')
    await sleep(200)

    // ---- 3b) cross-line-join Backspace on the QUOTED fence: must swallow
    // the '> ' prefix too, not just the terminator (the linebreak unit's
    // raw span spans BOTH per buildCodeMap) ----
    await clickCmLineStart(evaluate, send, 'window.__hmPyBlock', { last: true })
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: delay + 30 })
    await waitFor(async () => (await cmContent(evaluate, 'window.__hmPyBlock') || '').includes('OKMARKDONEMA'),
      'cross-line-join Backspace did not merge the two py CodeMirror lines')
    await sleep(200)

    await toggleSourceMode(evaluate)
    shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after the py cross-line-join Backspace')
    assert.equal(shown, AFTER_PY_JOIN,
      "quoted py block cross-line-join Backspace must swallow the '> ' prefix along with the linebreak, byte-exact")
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return after the py join verification')
    await sleep(200)

    // ============================================================
    // 4) language picker: js -> python, assert the open fence line rewrite
    // ============================================================
    const language = await switchBlockLanguage(evaluate, send, 'window.__hmJsBlock', 'python')
    await sleep(200)
    await toggleSourceMode(evaluate)
    shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after the language switch')
    assert.equal(shown, withLang(AFTER_LANG_SWITCH_TPL, language),
      "the open fence line must be rewritten to the picked language, byte-exact")
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return after the language-switch verification')
    await sleep(200)

    // ============================================================
    // 5) Mod-Enter exit from inside the (renamed) js block, then type a char
    // ============================================================
    await clickCmLineEnd(evaluate, send, 'window.__hmJsBlock', { last: true })
    await pressModEnter(send)
    await sleep(300)
    await typeTextLikeUser(send, 'Z', { delayMs: delay })
    await sleep(300)

    await toggleSourceMode(evaluate)
    shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after the Mod-Enter exit + typed char')
    assert.equal(shown, withLang(AFTER_EXIT_TYPE_TPL, language),
      'Mod-Enter exit must open a new paragraph after the fence, and the typed char must land inside it')
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return after the exit verification')
    await sleep(200)

    // ============================================================
    // 6) CM-focused Mod-z x2: undo #1 removes the typed char (its own
    //    group — exit-code-block is never insert-text-coalescable), undo #2
    //    removes the whole exit as one unit.
    // ============================================================
    await pressUndo(send)
    await sleep(250)
    await toggleSourceMode(evaluate)
    shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after undo #1')
    assert.equal(shown, withLang(AFTER_EXIT_TPL, language), 'undo #1 must revert exactly the typed-char group')
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return after undo #1 verification')
    await sleep(200)

    await pressUndo(send)
    await sleep(250)
    await toggleSourceMode(evaluate)
    shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after undo #2')
    assert.equal(shown, withLang(AFTER_LANG_SWITCH_TPL, language), 'undo #2 must revert the whole Mod-Enter exit as one group')
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return after undo #2 verification')
    await sleep(200)

    // ============================================================
    // 7) mermaid block: the preview-backed fence is EDITABLE (2026-08-18).
    //
    //    This step used to assert the opposite — that the per-block gate
    //    refused every keystroke here. The refusal came from
    //    `READONLY_CODE_LANGUAGES`, which was a POLICY gate justified by "a
    //    previewed block's visible text is not its source". That is true of
    //    the diagram PANEL and false of the EDITING SURFACE: the vendored
    //    CodeMirrorBlock mounts its CodeMirror UNCONDITIONALLY and
    //    `previewOnlyMode` only toggles a `hidden` class on the host, so the
    //    fence's PM text is its source, byte for byte, in both display
    //    states. See the ADR that replaced that set in
    //    editor-kernel-projection-map.js.
    //
    //    This is the one thing a headless test cannot show, and therefore
    //    why this step exists in a UI fixture: the preview/edit state lives
    //    in the DOM. Proven here: the Edit toggle reveals CM, the caret
    //    lands where clicked, the typed run appears at THAT caret (not at
    //    the block start, not past the closing fence), and the kernel's
    //    source bytes carry it inside the fence body.
    // ============================================================
    await ensureCmVisible(evaluate, send, 'window.__hmMermaidBlock')
    await clickCmLineEnd(evaluate, send, 'window.__hmMermaidBlock', { last: true })
    // Positive control (mirrors test-kernel-nodeview-ui.mjs's read-only/
    // undo-bridge probe): prove the click actually focused the mermaid
    // CodeMirror editor, so a missed click can never pass this step
    // vacuously.
    const mermaidCmFocused = await cmFocused(evaluate)
    assert.ok(mermaidCmFocused.includes('cm-content'),
      `click did not focus the mermaid CodeMirror editor (activeElement: ${mermaidCmFocused})`)
    await typeTextLikeUser(send, 'MERMAIDEDIT', { delayMs: delay })
    await waitFor(async () => (await cmContent(evaluate, 'window.__hmMermaidBlock') || '').includes('MERMAIDEDIT'),
      'MERMAIDEDIT never landed in the mermaid CodeMirror editor — a preview-backed fence must be editable')
    // The typed run must sit at the CARET (end of the diagram line), not at
    // the block's start: a mapping that resolved to the wrong end would still
    // "contain" the text above.
    assert.equal(await cmContent(evaluate, 'window.__hmMermaidBlock'), 'graph TD; A-->B;MERMAIDEDIT',
      'the typed run must land at the caret, at the end of the diagram line')
    await sleep(300)

    await toggleSourceMode(evaluate)
    shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after the mermaid edit')
    assert.equal(shown, withLang(AFTER_MERMAID_TYPE_TPL, language),
      'the mermaid edit must commit inside the fence body, byte-exact — fences and every other block untouched')
    assert.equal(app.dialogs.length, 0, 'no dialog appeared from the mermaid edit')
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return after the mermaid edit verification')
    await sleep(200)

    // ============================================================
    // 7b) mermaid -> js language switch (final-review finding, 2026-08-16:
    //    the from-readonly refusal is LIFTED — bidirectional switch), then
    //    type into the now-editable block right after: switch-then-type,
    //    end to end in the live app.
    // ============================================================
    const mermaidLang = await switchBlockLanguage(evaluate, send, 'window.__hmMermaidBlock', 'javascript')
    await sleep(200)
    // No `ensureCmVisible` call here: step 7 (just above) already clicked the
    // Edit toggle to reveal this block's CodeMirror editor, and that reveal
    // persists across the language switch — clicking the toggle AGAIN here
    // would just hide it back.
    await clickCmLineEnd(evaluate, send, 'window.__hmMermaidBlock', { last: true })
    await typeTextLikeUser(send, 'MERMAIDNOWJS', { delayMs: delay })
    await waitFor(async () => (await cmContent(evaluate, 'window.__hmMermaidBlock') || '').includes('MERMAIDNOWJS'),
      'MERMAIDNOWJS never landed in the (renamed) mermaid CodeMirror editor — the block must be editable right after the switch')
    await sleep(200)

    await toggleSourceMode(evaluate)
    const SAVED = withLang2(withLang(AFTER_MERMAID_SWITCH_TYPE_TPL, language), mermaidLang)
    shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after the mermaid switch-then-type')
    assert.equal(shown, SAVED,
      'mermaid -> js switch must rewrite the fence line, and the immediate follow-up type must commit, byte-exact')
    // Stays in source mode into the Save step below (same convention the
    // original step 7 verification used) — Save must work from either view.

    // ============================================================
    // 8) Save FAB -> byte-exact disk write; full quit -> cold reopen
    // ============================================================
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    assert.equal(await readFile(file, 'utf8'), SAVED, 'disk bytes must match the kernel-derived expectation exactly')
    assert.equal(app.dialogs.length, 0, `no rebuild prompt may appear: ${JSON.stringify(app.dialogs.map((dialog) => dialog.message))}`)

    await stopBuiltElectron(app, { removeProfile: false })
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, cleanProfile: false, appArgs: [file] })
    ;({ evaluate, send } = app)
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('TAILMARK') && text.includes('OKMARKDONEMA') && text.includes('MERMAIDNOWJS') ? text : null
    }, 'reopened document did not mount with the saved content')
    await toggleSourceMode(evaluate)
    const reopened = await waitFor(() => visibleSource(evaluate), 'source view did not appear after cold reopen')
    assert.equal(reopened, SAVED, 'cold reopen must reproduce the saved kernel-mode bytes exactly, byte-for-byte')
    assert.equal(app.dialogs.length, 0, 'no rebuild prompt may appear on cold reopen')

    console.log('PASS kernel-mode code-block domain UI: js multi-line edit + Backspace (within-line and cross-line-join), quoted py per-line prefix expansion on insert AND delete, language picker rewrite (both directions, including mermaid -> js switch-then-type), Mod-Enter exit, CM-focused undo groups, mermaid preview-backed fence editing (with a focus positive-control), save and cold reopen all match the kernel-derived byte strings')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
