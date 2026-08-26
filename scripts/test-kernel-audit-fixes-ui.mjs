// Kernel-mode AUDIT FIXES regression (2026-08-19), driven through the real
// built app over CDP. Three defects, all of the same shape — a fail-closed
// proof that existed but was not REACHED on some path:
//
//  1. THE EMPTY `$$` BLOCK. `64f46d5` fixed "typing into an empty fenced code
//     block destroys its closing fence". `356bdc9`, in the same series, made
//     `$$` block math editable through the SAME write path without extending
//     that guard — the prefilter read `mdBlock?.type === 'code'` and a `$$`
//     block's mdast type is `math`. Measured on the kernel's own parser before
//     the fix: '$$\n$$\n\nend\n' + one character committed '$$\nx$$\n\nend\n',
//     which reparses to ONE math node with value 'x$$\n\nend' — the closing
//     delimiter destroyed and every following block swallowed. Reachable with
//     no external file: type '$$' / '$$' in source mode, switch to rich, click
//     into the formula, type.
//
//  2. THE DELETE THAT BLANKS A LINE. Deleting the whole text of one line inside
//     a multi-line block committed bytes CommonMark reads as a blank line or a
//     setext underline: 'alpha  ' / 'b  ' / 'gamma' minus 'b' reparsed as TWO
//     paragraphs with both hard breaks gone. `verifyPlainTextProjection` then
//     repaired the VIEW to match the corrupted bytes, which is what made the
//     damage permanent and invisible. The delete side now runs the same
//     pre-write proof the insert side always had, and REFUSES what it cannot
//     prove.
//
//  3. THE DELETE THAT STRANDS A BLOCK-TRAILING SPACE. 'ab c' + Backspace
//     committed 'ab ' — a literal space at a block end, which CommonMark
//     strips, so the view was repaired to 'ab' and the next character mapped IN
//     FRONT of the dead byte: the user typed `a b Space c Backspace d` and the
//     file held `abd`. The space is now re-spelled U+00A0 in the SAME edit and
//     healed back to an ordinary space by the next character.
//
// Every expected string below is the byte output of the kernel primitives this
// UI drives, pinned independently in scripts/test-source-kernel-empty-code.mjs,
// scripts/test-source-kernel-content-delete.mjs and
// scripts/test-kernel-gateway.mjs. This script only proves the LIVE app reaches
// the same bytes through real keystrokes at real carets, and saves them.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-audit-${process.pid}`
const file = join(root, 'kernel-audit.md')
const port = Number(process.env.CDP_PORT || 10071)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

// U+00A0, written as an escape so no editor can turn it into a normal space.
const NBSP = ' '
// The two spaces that SPELL a hard break, likewise.
const TWO_SPACE = '  '

const LINES = [
  '# 审计回归',
  '',
  '前置段落。',
  '',
  '$$',            // an EMPTY block-math block — defect 1
  '$$',
  '',
  '引用中的空公式：',
  '',
  '> $$',          // the quoted spelling, whose anchor sits before the '> '
  '> $$',
  '',
  '甲一' + TWO_SPACE,   // a hard-break paragraph — defect 2
  '甲二' + TWO_SPACE,
  '甲三',
  '',
  'ab c',          // a block whose tail a Backspace strands — defect 3
  '',
  '尾段落。',
  ''
]
const FIXTURE = LINES.join('\n')

// ---- Expectations, derived from the kernel primitives, not guessed ----
// NOTE the replacer FUNCTIONS: `String.prototype.replace` reads '$$' in a
// string replacement as an escape for one literal '$'.
const AFTER_BARE_MATH = FIXTURE.replace('$$\n$$\n', () => '$$\nX\n$$\n')
const AFTER_MATH = AFTER_BARE_MATH.replace('> $$\n> $$\n', () => '> $$\n> Y\n> $$\n')
// Defect 2: the FIRST Backspace is an ordinary delete (the line keeps content),
// the SECOND would blank the line and is refused — so exactly one character
// disappears and the hard breaks survive.
const AFTER_REFUSED_DELETE = AFTER_MATH.replace('甲二' + TWO_SPACE, () => '甲' + TWO_SPACE)
// Defect 3: Backspace re-spells the stranded space, the next character heals it.
const AFTER_TAIL = AFTER_REFUSED_DELETE.replace('ab c\n', () => 'ab d\n')

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

const diagnostics = (evaluate) => evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)

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
  await sleep(200)
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

// The EMPTY math blocks still in the document, captured by document order so
// later steps address the same DOM node by identity. Re-run after every source
// toggle: that rebuilds the view, and a stale node reference would turn a real
// byte defect into an unreadable "not hit-testable".
async function captureEmptyMathBlocks(evaluate, expected) {
  const found = await evaluate(`(() => {
    const blocks = [...(${VISIBLE_EDITOR})?.querySelectorAll('.milkdown-code-block') || []]
      .filter((block) => (block.querySelector('.cm-content')?.textContent || '') === '')
    window.__hmEmptyMath = blocks[0]
    return blocks.length
  })()`)
  assert.equal(found, expected,
    `expected exactly ${expected} EMPTY math block(s), saw ${found}`)
}

// A `$$` block renders a KaTeX preview, so its CodeMirror host may start
// hidden behind an Edit toggle. An EMPTY formula previews as nothing, so
// tolerate either state — but if it IS hidden, the toggle is the only way in.
async function revealCm(evaluate, send, blockRef) {
  const hidden = await evaluate(`!!(${blockRef})?.querySelector('.codemirror-host')?.classList.contains('hidden')`)
  if (!hidden) return
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

// An EMPTY CodeMirror line has (near) zero text width, so click just inside its
// LEFT edge; the line element still spans the content width.
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
  await click(send, point)
  await sleep(200)
  const active = await evaluate(`document.activeElement?.className || ''`)
  assert.ok(active.includes('cm-content'),
    `click did not focus the empty CodeMirror editor (activeElement: ${active})`)
}

const cmContent = (evaluate, blockRef) => evaluate(`(${blockRef})?.querySelector('.cm-content')?.textContent`)

// A hard break renders as <br>, so a paragraph's rendered text splits into one
// TEXT NODE per visual line. Caret placement is always a real mouse click — a
// raw DOM selection does not sync ProseMirror state.
async function lineEdgeRect(evaluate, blockText, lineIndex, edge) {
  return evaluate(`(() => {
    const node = [...((${VISIBLE_EDITOR})?.querySelectorAll('p') || [])]
      .find((n) => n.offsetParent && n.textContent === ${JSON.stringify(blockText)})
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    const texts = []
    let n
    while ((n = walker.nextNode())) texts.push(n)
    const target = texts[${lineIndex}]
    if (!target) return null
    const at = ${JSON.stringify(edge)} === 'start' ? 0 : target.textContent.length
    const range = document.createRange()
    range.setStart(target, at)
    range.setEnd(target, at)
    const rect = range.getBoundingClientRect()
    if (!rect || (!rect.height && !rect.width)) return null
    return { left: rect.left, right: rect.right, top: rect.top, height: rect.height, lines: texts.length }
  })()`)
}

async function clickLine(evaluate, send, blockText, lineIndex, edge) {
  const rect = await waitFor(() => lineEdgeRect(evaluate, blockText, lineIndex, edge),
    `could not locate the ${edge} of visual line ${lineIndex} in ${JSON.stringify(blockText)}`)
  const x = edge === 'start' ? rect.left + 1 : rect.right - 1
  await click(send, { x, y: rect.top + Math.min(12, rect.height / 2) })
  await sleep(250)
}

const caretProbe = (evaluate) => evaluate(`(() => {
  const sel = document.getSelection()
  if (!sel || !sel.anchorNode) return 'no-selection'
  return JSON.stringify({ text: sel.anchorNode.textContent, offset: sel.anchorOffset })
})()`)

// Read the authored source WITHOUT leaving rich mode, so a step can be checked
// without the mode switch's own commit protocol getting involved.
async function readSourceViaToggle(evaluate, label) {
  await toggleSourceMode(evaluate)
  const shown = await waitFor(() => visibleSource(evaluate), `source view did not appear (${label})`)
  await toggleSourceMode(evaluate)
  await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), `rich view did not return (${label})`)
  await sleep(200)
  return shown
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

    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('尾段落') ? text : null
    }, 'document did not remount after enabling kernel mode')
    await sleep(300)
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy for this fixture: ${attachDiagnostics}`)

    // =====================================================================
    // 1) THE EMPTY `$$` BLOCK — bare, then blockquote-prefixed.
    // =====================================================================
    await waitFor(() => evaluate(`!!(${VISIBLE_EDITOR})?.querySelector('.cm-editor')`), 'no math block mounted')

    // 1a) the BARE empty $$ block. Asserted on its own, before the quoted one is
    // touched: pre-fix this single keystroke committed '$$\nX$$\n', which
    // swallows the whole rest of the document into the formula — so a combined
    // assertion would have failed later, for an unreadable reason.
    await captureEmptyMathBlocks(evaluate, 2)
    await revealCm(evaluate, send, 'window.__hmEmptyMath')
    await clickEmptyCmLine(evaluate, send, 'window.__hmEmptyMath')
    await typeTextLikeUser(send, 'X', { delayMs: delay })
    await waitFor(async () => (await cmContent(evaluate, 'window.__hmEmptyMath') || '').includes('X'),
      'X never landed in the empty $$ block')
    await sleep(300)
    assert.equal(await readSourceViaToggle(evaluate, 'bare empty math'), AFTER_BARE_MATH,
      'typing into an EMPTY $$ block must open a terminated content line — never overwrite the closing delimiter')

    // 1b) the BLOCKQUOTE-prefixed one, whose raw anchor sits in FRONT of the
    // closing line's own '> '.
    await captureEmptyMathBlocks(evaluate, 1)
    await revealCm(evaluate, send, 'window.__hmEmptyMath')
    await clickEmptyCmLine(evaluate, send, 'window.__hmEmptyMath')
    await typeTextLikeUser(send, 'Y', { delayMs: delay })
    await waitFor(async () => (await cmContent(evaluate, 'window.__hmEmptyMath') || '').includes('Y'),
      'Y never landed in the empty quoted $$ block')
    await sleep(300)
    assert.equal(await readSourceViaToggle(evaluate, 'quoted empty math'), AFTER_MATH,
      "a quoted EMPTY $$ block's first character must land AFTER the line's own '> ' prefix, on a terminated line")

    // =====================================================================
    // 2) A DELETE THAT WOULD BLANK A LINE — refused, bytes untouched.
    //    Pre-fix this committed '甲一  \n  \n甲三\n', which reparses as TWO
    //    paragraphs with both hard breaks gone.
    // =====================================================================
    await clickLine(evaluate, send, '甲一甲二甲三', 1, 'end')
    assert.equal(await caretProbe(evaluate), JSON.stringify({ text: '甲二', offset: 2 }),
      'the caret must sit at the end of the middle line (positive control)')
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(250)
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(500)
    assert.equal(await readSourceViaToggle(evaluate, 'blanking delete'), AFTER_REFUSED_DELETE,
      'a delete that would blank a line inside a multi-line block must fail closed with the bytes untouched')

    // =====================================================================
    // 3) A DELETE THAT STRANDS A BLOCK-TRAILING SPACE. Backspace over the 'c'
    //    of 'ab c', then type 'd': the user's `ab d` must be what lands.
    //    Pre-fix the file held 'abd' plus an invisible dead space.
    // =====================================================================
    await clickLine(evaluate, send, 'ab c', 0, 'end')
    assert.equal(await caretProbe(evaluate), JSON.stringify({ text: 'ab c', offset: 4 }),
      "the caret must sit at the end of 'ab c' (positive control)")
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(500)
    // Read the DOCUMENT, not source mode: entering source mode is a PUBLICATION
    // boundary (2026-08-26, correction A/B1) and an outstanding block-trailing
    // run has no byte spelling there. What must be proven here is that the
    // stranded space was re-spelled U+00A0 rather than left as a dead ASCII
    // byte, and that is a fact about the document — the click below then
    // addresses that very character.
    const stranded = await mounted(evaluate)
    assert.ok(stranded.includes('ab' + NBSP),
      `the stranded space must be re-spelled U+00A0, not left as a dead ASCII byte: ${JSON.stringify(String(stranded).slice(0, 200))}`)
    assert.ok(!(await readSourceViaToggle(evaluate, 'stranded space')).includes('ab' + NBSP),
      'and it must NOT be publishable — a run CommonMark strips has no byte spelling at all')

    await clickLine(evaluate, send, 'ab' + NBSP, 0, 'end')
    await typeTextLikeUser(send, 'd', { delayMs: delay })
    await sleep(500)
    assert.equal(await readSourceViaToggle(evaluate, 'healed space'), AFTER_TAIL,
      'the next character must heal the U+00A0 back to an ordinary space, landing `ab d`')

    // =====================================================================
    // 4) Save, and prove the bytes reached the FILE.
    // =====================================================================
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'document never became dirty')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`),
      `save did not settle (diagnostics: ${await diagnostics(evaluate)})`)
    assert.equal(await readFile(file, 'utf8'), AFTER_TAIL,
      'the saved file must be byte-identical to the kernel source view')
    assert.deepEqual(app.dialogs.map((dialog) => dialog.message), [],
      'none of these edits may prompt for a rebuild')

    console.log('PASS kernel-mode audit fixes UI: an empty $$ block (bare AND quoted) opens a terminated, prefixed content line; a delete that would blank a line inside a multi-line block fails closed with the bytes untouched; a delete that strands a block-trailing space re-spells it U+00A0 and the next character heals it back — all surviving save')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
