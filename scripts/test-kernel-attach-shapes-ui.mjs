// Kernel-mode ATTACH regression for the three formerly whole-tab-degrading
// shapes, in the real app.
//
// Until 2026-08-22 the projection map rejected the WHOLE map — silently
// handing the entire tab back to legacy (`attach-unmappable`) — for three
// documented shapes (docs/ai-handoff.md §5.2d (A)):
//   1. a standalone-line `$$x$$` (normalizeDisplayMath rewrites it before the
//      editor parse, so PM shows a LaTeX code_block while the kernel holds
//      the original one-line paragraph — a type mismatch);
//   2. a code fence / block math nested in a LIST ITEM (ProseMirror's
//      `createAndFill` filler paragraph made the counts differ — cured
//      earlier, 2026-08-20, commit 6374848);
//   3. adjacent ROOT-LEVEL html siblings (`<div>` + blank line + `</div>`,
//      merged into ONE atom by the editor chain, kept as TWO blocks by the
//      kernel — a count mismatch).
// Each now pairs — the offending slot as a READ-ONLY leaf — so a document
// containing all three must attach with a live kernel and stay byte-exact
// editable everywhere else.
//
// The pairing rules themselves are pinned headlessly with negative controls
// (scripts/test-kernel-projection-map.mjs Cases P6 / M6 / H9); this script
// only proves the LIVE APP reaches the same outcome: the kernel attaches with
// no `attach-unmappable` diagnostic, an ordinary paragraph in the same
// document types normally, and the committed source is byte-for-byte the
// fixture plus that one edit — i.e. the three read-only shapes' bytes were
// not touched, re-serialized, or re-spelled by editing around them.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser, pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-attach-shapes-${process.pid}`
const file = join(root, 'kernel-attach-shapes.md')
const port = Number(process.env.CDP_PORT || 11210)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

// All three shapes in ONE document, each with ordinary prose around it.
const FIXTURE = [
  '# 附着形状',
  '',
  '前置段落。',
  '',
  '$$E=mc^2$$',
  '',
  '- ```js',
  '  ab',
  '  ```',
  '',
  '<div>',
  '',
  '</div>',
  '',
  '尾段落。',
  ''
].join('\n')

// One character typed at the end of the ordinary trailing paragraph. Nothing
// else in the file may change — that byte-exactness IS the assertion that the
// three read-only shapes were left alone.
const AFTER_TYPING = FIXTURE.replace('尾段落。\n', '尾段落。X\n')

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

// Real caret placement in an ordinary paragraph: click it, then End — a raw
// DOM selection would not sync ProseMirror state (CLAUDE.md's CDP gotcha).
async function clickTextEnd(evaluate, send, text) {
  const point = await evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p') || [])]
      .find((candidate) => candidate.textContent === ${JSON.stringify(text)})
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const rect = node.getBoundingClientRect()
    return { x: rect.left + 8, y: rect.top + Math.min(12, rect.height / 2) }
  })()`)
  assert.ok(point, `missing editable paragraph: ${text}`)
  await sleep(400)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  // Let the click's focus/selection settle before End — this is the FIRST
  // focus of a freshly kernel-remounted editor, and an immediate End lands
  // before the caret exists (measured: the End became a no-op and the typed
  // character then went to the paragraph START).
  await sleep(250)
  await pressKey(send, { key: 'End', code: 'End', delayMs: delay })
  await sleep(150)
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    const { evaluate, send } = app

    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('前置段落') && text.includes('尾段落') ? text : null
    }, 'initial document did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on plain mount')

    // The three shapes really rendered as the shapes this test is about:
    // a LaTeX/code preview block, a list-embedded fence, one merged html
    // block. (Presence checks only — their behavior is pinned headlessly.)
    await waitFor(() => evaluate(`!!(${VISIBLE_EDITOR})?.querySelector('.cm-editor')`),
      'no code block mounted (the $$ and fence shapes should each mount one)')
    const htmlBlocks = await evaluate(
      `(${VISIBLE_EDITOR})?.querySelectorAll('.hm-html-block').length ?? 0`)
    assert.equal(htmlBlocks, 1,
      `the adjacent <div> siblings must render as ONE merged html block, got ${htmlBlocks}`)

    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('前置段落') && text.includes('尾段落') ? text : null
    }, 'document did not remount after enabling kernel mode')
    await sleep(300)

    // THE HEADLINE: the attach must survive all three shapes — no whole-tab
    // legacy fallback.
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy fallback for the three-shape fixture: ${attachDiagnostics}`)

    // An ordinary paragraph in the SAME document types through the kernel.
    await clickTextEnd(evaluate, send, '尾段落。')
    const focused = await evaluate(`document.activeElement?.className || document.activeElement?.tagName || ''`)
    assert.ok(String(focused).includes('ProseMirror'),
      `the paragraph click did not focus the rich editor (activeElement: ${focused})`)
    await typeTextLikeUser(send, 'X', { delayMs: delay })
    try {
      await waitFor(async () => (await mounted(evaluate) || '').includes('尾段落。X'),
        'the typed character never appeared in the trailing paragraph')
    } catch (error) {
      // Refusals are silent in the DOM — surface the kernel's own diagnostics
      // so a failure here names its cause instead of just "no X".
      const diagnostics = await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)
      const tail = await evaluate(`JSON.stringify(((${VISIBLE_EDITOR})?.textContent || '').slice(-24))`)
      const sel = await evaluate(`JSON.stringify((() => { const s = getSelection(); return s && s.anchorNode ? { text: (s.anchorNode.textContent || '').slice(0, 12), off: s.anchorOffset } : null })())`)
      const toast = await evaluate(`JSON.stringify(document.querySelector('.hm-toast')?.textContent ?? null)`)
      error.message += ` (diagnostics: ${diagnostics}; tail: ${tail}; selection: ${sel}; toast: ${toast})`
      throw error
    }
    await sleep(250)

    // The committed source is the fixture plus exactly that one byte — the
    // three read-only shapes came through byte-for-byte untouched.
    await toggleSourceMode(evaluate)
    const shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after typing')
    assert.equal(shown, AFTER_TYPING,
      'the source must be byte-for-byte the fixture plus the one typed character')
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return')

    // And the same bytes reach disk.
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    assert.equal(await readFile(file, 'utf8'), AFTER_TYPING, 'disk bytes must match exactly')
    assert.equal(app.dialogs.length, 0,
      `no rebuild prompt may appear: ${JSON.stringify(app.dialogs.map((dialog) => dialog.message))}`)

    console.log('PASS kernel attach-shapes UI: a document holding all three formerly whole-tab-degrading shapes (standalone $$x$$, list-item fence, merged root <div> siblings) attaches with a live kernel (no attach-unmappable), an ordinary paragraph types through it, and the committed/saved source is the fixture plus exactly that edit')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
