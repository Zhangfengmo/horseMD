// Kernel-mode EMPTY FENCE regression, in the real app.
//
// THE DEFECT THIS LOCKS (2026-08-18). An empty fenced code block —
// '```js' immediately followed by '```' — maps through `code-map.js`'s
// `emptyCodeMap`, whose only addressable offset is
// `openLine.end + openLine.ending.length`: the start of the NEXT PHYSICAL
// LINE, which for that spelling is the CLOSING FENCE itself. Before the fix,
// `commitPlainText` wrote the typed character there verbatim, so the first
// keystroke committed '```js\nx```' — the terminator destroyed, the block
// unterminated, and (measured against the kernel's own parser) EVERYTHING
// after it swallowed into the code block's value:
//
//   '```js\nx```\n\n尾段落。\n'  ->  ONE code node, value 'x```\n\n尾段落。'
//
// A user opening their own file and typing one character into an existing
// empty code block lost the rest of the document. That is why this case is a
// live-app regression and not only a headless one: the byte path it exercises
// is reached through a real CodeMirror keystroke -> `forwardUpdate` ->
// ReplaceStep -> the gateway, and nothing in that chain is simulated here.
//
// TWO SHAPES, deliberately: the bare top-level fence and the BLOCKQUOTE-
// prefixed one. The quoted fence is the worse of the two, because the empty
// map's anchor sits BEFORE the closing line's own '> ' prefix — writing the
// character verbatim there produced '> ```js\nx> ```\n', which reparses as an
// empty quoted fence followed by a paragraph literally reading 'x> ```'.
// Both must now commit a properly TERMINATED, properly PREFIXED content line.
//
// Every expected string below is the byte output of the kernel primitives
// this UI drives (`buildCodeMap` + `spellEmptyCodeInsert` +
// `applySourceTransaction`), pinned independently in
// scripts/test-source-kernel-empty-code.mjs and
// scripts/test-kernel-gateway.mjs; this script only proves the live app
// reaches the same bytes, saves them, and reopens them.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-emptyfence-${process.pid}`
const file = join(root, 'kernel-empty-fence.md')
const port = Number(process.env.CDP_PORT || 10061)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

const FIXTURE = [
  '# 空围栏',
  '',
  '前置段落。',
  '',
  '```js',
  '```',
  '',
  '引用中的空围栏：',
  '',
  '> ```py',
  '> ```',
  '',
  '尾段落。',
  ''
].join('\n')

// One character typed into the bare empty fence: a properly terminated
// content line, the closing fence untouched, nothing after it absorbed.
const AFTER_PLAIN = FIXTURE.replace('```js\n```\n', '```js\nX\n```\n')

// The same into the QUOTED empty fence: the content line carries the block's
// own '> ' prefix, and the character lands AFTER it, never before.
const AFTER_QUOTED = AFTER_PLAIN.replace('> ```py\n> ```\n', '> ```py\n> Y\n> ```\n')

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

// Capture the fixture's two code blocks by their language-button label, the
// convention scripts/test-kernel-codeblock-ui.mjs uses, into window-scoped
// references so later steps address the SAME DOM node by identity.
async function captureBlocks(evaluate) {
  const found = await evaluate(`(() => {
    const blocks = [...(${VISIBLE_EDITOR})?.querySelectorAll('.milkdown-code-block') || []]
    const byLang = (name) => blocks.find((block) =>
      block.querySelector('.language-button')?.textContent?.trim().toLowerCase() === name)
    window.__hmJsBlock = byLang('js')
    window.__hmPyBlock = byLang('py')
    return { js: !!window.__hmJsBlock, py: !!window.__hmPyBlock }
  })()`)
  assert.ok(found.js, 'empty js code block not found')
  assert.ok(found.py, 'empty quoted py code block not found')
}

// An EMPTY CodeMirror line has (near) zero text width, so the `rect.right - 2`
// idiom the non-empty code-block script uses is not hit-testable here — click
// just inside the line's LEFT edge instead. The line element itself still
// spans the editor's content width, so this is a real click on a real line.
async function clickEmptyCmLine(evaluate, send, blockRef) {
  const point = await evaluate(`(() => {
    const block = ${blockRef}
    if (!block) return null
    block.scrollIntoView({ block: 'center' })
    const line = block.querySelector('.cm-editor .cm-line')
    const rect = line?.getBoundingClientRect()
    return rect && rect.height ? { x: rect.left + 4, y: rect.top + rect.height / 2 } : null
  })()`)
  assert.ok(point, 'the empty CodeMirror line is not hit-testable')
  await sleep(400)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(200)
  // Positive control: without a focused `.cm-content` the "typing changed
  // nothing" outcome below would pass vacuously.
  const active = await evaluate(`document.activeElement?.className || ''`)
  assert.ok(active.includes('cm-content'),
    `click did not focus the empty CodeMirror editor (activeElement: ${active})`)
}

const cmContent = (evaluate, blockRef) => evaluate(`(${blockRef})?.querySelector('.cm-content')?.textContent`)

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

    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('前置段落') && text.includes('尾段落') ? text : null
    }, 'document did not remount after enabling kernel mode')
    await sleep(300)
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy fallback for this fixture: ${attachDiagnostics}`)

    await waitFor(() => evaluate(`!!(${VISIBLE_EDITOR})?.querySelector('.cm-editor')`), 'no code block mounted')
    await captureBlocks(evaluate)

    // ---- 1) one character into the BARE empty fence ----
    await clickEmptyCmLine(evaluate, send, 'window.__hmJsBlock')
    await typeTextLikeUser(send, 'X', { delayMs: delay })
    await waitFor(async () => (await cmContent(evaluate, 'window.__hmJsBlock') || '').includes('X'),
      'X never landed in the empty js CodeMirror editor')
    await sleep(250)

    await toggleSourceMode(evaluate)
    let shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after the bare empty-fence keystroke')
    assert.equal(shown, AFTER_PLAIN,
      'typing into an EMPTY fence must open a terminated content line, never overwrite the closing fence')
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return')
    await sleep(200)

    // ---- 2) one character into the QUOTED empty fence ----
    await clickEmptyCmLine(evaluate, send, 'window.__hmPyBlock')
    await typeTextLikeUser(send, 'Y', { delayMs: delay })
    await waitFor(async () => (await cmContent(evaluate, 'window.__hmPyBlock') || '').includes('Y'),
      'Y never landed in the empty quoted py CodeMirror editor')
    await sleep(250)

    await toggleSourceMode(evaluate)
    shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after the quoted empty-fence keystroke')
    assert.equal(shown, AFTER_QUOTED,
      "a quoted EMPTY fence's first character must land AFTER the line's own '> ' prefix, on a terminated line")

    // ---- 3) save + cold reopen ----
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    assert.equal(await readFile(file, 'utf8'), AFTER_QUOTED, 'disk bytes must match the kernel-derived expectation exactly')
    assert.equal(app.dialogs.length, 0,
      `no rebuild prompt may appear: ${JSON.stringify(app.dialogs.map((dialog) => dialog.message))}`)

    await stopBuiltElectron(app, { removeProfile: false })
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, cleanProfile: false, appArgs: [file] })
    ;({ evaluate, send } = app)
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('尾段落') ? text : null
    }, 'reopened document did not mount with the saved content')
    await toggleSourceMode(evaluate)
    const reopened = await waitFor(() => visibleSource(evaluate), 'source view did not appear after cold reopen')
    assert.equal(reopened, AFTER_QUOTED, 'cold reopen must reproduce the saved bytes exactly')
    assert.equal(app.dialogs.length, 0, 'no rebuild prompt may appear on cold reopen')

    console.log('PASS kernel-mode empty-fence UI: the first character typed into a bare AND a blockquote-prefixed empty code block opens a terminated, correctly prefixed content line; the closing fence survives, nothing after it is absorbed, and the bytes survive save + cold reopen')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
