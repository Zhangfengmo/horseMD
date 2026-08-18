// Kernel-mode BLOCK MATH (`$$..$$`) editing, end to end in the real app.
//
// WHY THIS NEEDS A UI FIXTURE AT ALL. Every byte-level property of this shape
// is already pinned headlessly (scripts/test-kernel-projection-map.mjs cases
// 18/18b/M1/M2, scripts/test-kernel-mode-headless.mjs case T5b) — the
// character map, the CRLF identity, the quoted per-line prefix, the
// fail-closed degradation. What a headless test structurally CANNOT show is
// the thing this whole family turned on: a `$$` block renders a KaTeX PREVIEW
// instead of its source, and the preview/edit state lives only in the DOM.
//
// The claim under test is therefore a DOM claim: the vendored
// @milkdown/components CodeMirrorBlock mounts its CodeMirror UNCONDITIONALLY
// and `previewOnlyMode` only adds a `hidden` class to the host, so the Edit
// toggle reveals a real, ordinary CodeMirror over the block's own TeX — and
// what the user types there commits to the source INSIDE the `$$`
// delimiters. If that were false, the byte proofs would be addressing an
// editing surface no user can reach.
//
// Deliberately covered:
//   * a plain LF `$$` block: reveal, click, type at the caret, byte-exact
//     commit, and the delimiters untouched;
//   * Enter inside the block (the code-block line-break expansion path);
//   * a BLOCKQUOTED `$$` block, whose per-line `> ` prefix an inserted break
//     must be expanded with — the one shape where a naive byte insert
//     silently destroys the quote structure;
//   * save to disk + a full quit and cold reopen, so the bytes are proven on
//     disk and through a fresh parse, not just in the live buffer.
//
// Deliberately NOT covered, because each is refused by its own command and
// is not part of this shape's editing contract (recorded so the next reader
// does not mistake the absence for an oversight):
//   * the language picker on a `$$` block — `changeCodeLanguage` requires
//     `block.type === 'code'`; a `$$` delimiter pair has nowhere to spell an
//     info string, so the switch is vetoed with a toast;
//   * Mod-Enter — `exitCodeBlock` requires the same, since there is no
//     closing fence run to write after.
//
// Typed runs avoid brackets/quotes (@codemirror/autocomplete's closeBrackets
// ships with Crepe's CodeMirror feature) and never contain a `$`, which on
// its own line would legitimately close the block early.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-math-${process.pid}`
const file = join(root, 'kernel-math.md')
const port = Number(process.env.CDP_PORT || 10049)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

const FIXTURE = [
  '# 块级公式测试',
  '',
  '前置段落用于占位。',
  '',
  '$$',
  'E=mc^2',
  '$$',
  '',
  '引用中的公式：',
  '',
  '> $$',
  '> a+b',
  '> $$',
  '',
  '尾段落用于占位。',
  ''
].join('\n')

// ---- Expectations, derived from the kernel primitives, not guessed ----
// NOTE the replacer FUNCTIONS: `String.prototype.replace` reads `$$` in a
// string replacement as an escape for a single literal '$', which silently
// halved every delimiter in these fixtures. A function replacement is taken
// verbatim.
//
// Plain block: 'ALPHA' typed at the end of the 'E=mc^2' content line, then
// Enter, then 'BETA'. `buildCodeMap`'s linePrefix for a top-level `$$` block
// is '' and its lineEnding '\n', so the break is written bare.
const AFTER_PLAIN = FIXTURE.replace(
  '$$\nE=mc^2\n$$\n',
  () => '$$\nE=mc^2ALPHA\nBETA\n$$\n'
)

// Quoted block: 'GAMMA' at the end of the '> a+b' content line, then Enter,
// then 'DELTA'. Here `linePrefix` is '> ', so `commitPlainText` must expand
// the single inserted '\n' into '\n> ' — a bare '\n' would demote the rest
// of the block out of the blockquote.
const AFTER_QUOTED = AFTER_PLAIN.replace(
  '> $$\n> a+b\n> $$\n',
  () => '> $$\n> a+bGAMMA\n> DELTA\n> $$\n'
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

const cmContent = (evaluate, blockRef) => evaluate(`(${blockRef})?.querySelector('.cm-content')?.textContent`)

const cmFocused = (evaluate) => evaluate(`document.activeElement?.className || ''`)

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

// Capture the two math blocks by their CodeMirror content, so every later
// step addresses the SAME DOM node by identity across kernel edits (the
// minimal-diff reconciler's node-view identity guarantee).
async function captureBlocks(evaluate) {
  const found = await evaluate(`(() => {
    const blocks = [...(${VISIBLE_EDITOR})?.querySelectorAll('.milkdown-code-block') || []]
    const byText = (needle) => blocks.find((block) =>
      (block.querySelector('.cm-content')?.textContent || '').includes(needle))
    window.__hmMathPlain = byText('E=mc^2')
    window.__hmMathQuoted = byText('a+b')
    return { plain: !!window.__hmMathPlain, quoted: !!window.__hmMathQuoted, total: blocks.length }
  })()`)
  assert.equal(found.total, 2, `expected exactly two math code blocks, saw ${found.total}`)
  assert.ok(found.plain, 'the plain $$ block was not found')
  assert.ok(found.quoted, 'the quoted $$ block was not found')
}

// THE STEP THIS WHOLE SCRIPT EXISTS FOR: a `$$` block renders a KaTeX
// preview, so its `codemirror-host` carries `hidden` and the toolbar offers
// an Edit toggle. Assert BOTH facts before clicking — if a future Crepe
// version stopped previewing block math, this script would otherwise pass
// while silently no longer testing a preview-backed block at all.
async function revealCm(evaluate, send, blockRef) {
  const hidden = await evaluate(`!!(${blockRef})?.querySelector('.codemirror-host')?.classList.contains('hidden')`)
  assert.equal(hidden, true,
    'a $$ block must start preview-only (its CodeMirror host hidden) — otherwise this script is not testing a preview-backed block')
  const point = await evaluate(`(() => {
    const block = ${blockRef}
    block?.scrollIntoView({ block: 'center' })
    const btn = block?.querySelector('.preview-toggle-button')
    const rect = btn?.getBoundingClientRect()
    return rect && rect.width ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })()`)
  assert.ok(point, 'a preview-backed $$ block must offer an Edit toggle')
  await sleep(200)
  await click(send, point)
  await waitFor(() => evaluate(`!(${blockRef})?.querySelector('.codemirror-host')?.classList.contains('hidden')`),
    "clicking Edit did not reveal the $$ block's CodeMirror editor")
  await sleep(200)
}

// Click into a block's LAST CodeMirror line and land the caret at its end.
async function clickCmLineEnd(evaluate, send, blockRef) {
  const point = await evaluate(`(() => {
    const block = ${blockRef}
    if (!block) return null
    block.scrollIntoView({ block: 'center' })
    const lines = [...block.querySelectorAll('.cm-editor .cm-line')]
    const line = lines[lines.length - 1]
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

    // ---- 1) kernel mode must ATTACH on a math-bearing document ----
    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('前置段落') && text.includes('尾段落') ? text : null
    }, 'document did not remount after enabling kernel mode')
    await sleep(300)
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy for this math fixture: ${attachDiagnostics}`)
    assert.equal(app.dialogs.length, 0, 'no dialog after enabling kernel mode')

    await waitFor(() => evaluate(`!!(${VISIBLE_EDITOR})?.querySelector('.cm-editor')`), 'no math code block mounted')
    await captureBlocks(evaluate)

    // ============================================================
    // 2) plain `$$` block: reveal CM, type at the caret, Enter, type again
    // ============================================================
    await revealCm(evaluate, send, 'window.__hmMathPlain')
    await clickCmLineEnd(evaluate, send, 'window.__hmMathPlain')
    // Positive control: a missed click would make every "unchanged" assertion
    // below pass vacuously.
    const plainFocused = await cmFocused(evaluate)
    assert.ok(plainFocused.includes('cm-content'),
      `click did not focus the plain $$ block's CodeMirror (activeElement: ${plainFocused})`)

    await typeTextLikeUser(send, 'ALPHA', { delayMs: delay })
    await waitFor(async () => (await cmContent(evaluate, 'window.__hmMathPlain') || '').includes('ALPHA'),
      'ALPHA never landed in the $$ block — block math must be editable')
    assert.equal(await cmContent(evaluate, 'window.__hmMathPlain'), 'E=mc^2ALPHA',
      'the typed run must land at the caret (end of the TeX line), not at the block start')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await typeTextLikeUser(send, 'BETA', { delayMs: delay })
    await waitFor(async () => (await cmContent(evaluate, 'window.__hmMathPlain') || '').includes('BETA'),
      'BETA never landed after Enter inside the $$ block')
    await sleep(250)

    await toggleSourceMode(evaluate)
    let shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after the plain math edit')
    assert.equal(shown, AFTER_PLAIN,
      'the plain $$ edit must commit between the delimiters, byte-exact, with both `$$` lines untouched')
    assert.equal(app.dialogs.length, 0, 'no dialog from the plain math edit')
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return after the plain math verification')
    await sleep(200)

    // ============================================================
    // 3) QUOTED `$$` block: the inserted break must carry the '> ' prefix
    // ============================================================
    await revealCm(evaluate, send, 'window.__hmMathQuoted')
    await clickCmLineEnd(evaluate, send, 'window.__hmMathQuoted')
    const quotedFocused = await cmFocused(evaluate)
    assert.ok(quotedFocused.includes('cm-content'),
      `click did not focus the quoted $$ block's CodeMirror (activeElement: ${quotedFocused})`)

    await typeTextLikeUser(send, 'GAMMA', { delayMs: delay })
    await waitFor(async () => (await cmContent(evaluate, 'window.__hmMathQuoted') || '').includes('GAMMA'),
      'GAMMA never landed in the quoted $$ block')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await typeTextLikeUser(send, 'DELTA', { delayMs: delay })
    await waitFor(async () => (await cmContent(evaluate, 'window.__hmMathQuoted') || '').includes('DELTA'),
      'DELTA never landed after Enter inside the quoted $$ block')
    await sleep(250)

    await toggleSourceMode(evaluate)
    shown = await waitFor(() => visibleSource(evaluate), 'source view did not appear after the quoted math edit')
    assert.equal(shown, AFTER_QUOTED,
      "the quoted $$ edit must expand its break into '\\n> ' — a bare break would demote the rest out of the blockquote")
    assert.equal(app.dialogs.length, 0, 'no dialog from the quoted math edit')

    // ============================================================
    // 4) Save -> byte-exact disk write; full quit -> cold reopen
    // ============================================================
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
      return text && text.includes('前置段落') && text.includes('尾段落') ? text : null
    }, 'reopened document did not mount')
    await toggleSourceMode(evaluate)
    const reopened = await waitFor(() => visibleSource(evaluate), 'source view did not appear after cold reopen')
    assert.equal(reopened, AFTER_QUOTED, 'cold reopen must reproduce the saved bytes exactly, byte-for-byte')
    assert.equal(app.dialogs.length, 0, 'no rebuild prompt may appear on cold reopen')

    console.log('PASS kernel-mode block math UI: a preview-backed $$ block reveals a real CodeMirror through its Edit toggle, typing and Enter commit between the delimiters byte-exactly (plain AND quoted, with the > prefix expanded), and the bytes survive save and a cold reopen')
  } finally {
    if (app) await stopBuiltElectron(app)
    await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
