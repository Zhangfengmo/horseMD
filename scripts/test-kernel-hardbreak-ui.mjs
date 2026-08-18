// Kernel-mode HARD BREAK regression, driven through the real built app over CDP.
//
// THE DEFECT. Until 2026-08-18 a paragraph containing ANY hard break was
// untypable in its entirety in kernel mode: every plain-text step in it was
// refused with a toast. The cause was in the character map — an mdast `break`'s
// raw span stops at the LINE ENDING, so the continuation prefix that opens the
// next line (a blockquote's '> ', a list item's indentation) belonged to no
// unit, and the visible boundary right after the break resolved to the PRE-gap
// offset. Typing there would have committed
//
//     '> a  \nX> b'      (the quote marker demoted to paragraph text)
//
// so the gateway refused the whole block instead. `hardBreakUnitEnd`
// (lib/source-kernel/character-map.js) now folds the prefix into the break's
// own unit — the same thing `consumeSoftBreak` has always done for a SOFT
// break — and the gateway admits `hardbreak` as an ordinary inline atom.
//
// WHY THIS SCRIPT EXISTS. The byte matrix is proven headlessly
// (scripts/test-source-kernel-charmap.mjs for the units,
// scripts/test-kernel-gateway.mjs §HARD BREAKS for the commits). Neither can
// prove that a REAL keystroke at a REAL caret on the second visual line of a
// quoted paragraph lands where the map says — and "green headlessly, dead in
// the app" is a shape that has shipped from this subsystem twice.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-hardbreak-${process.pid}`
const file = join(root, 'hardbreak.md')
const crlfFile = join(root, 'hardbreak-crlf.md')
const port = Number(process.env.CDP_PORT || 10053)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

// The two authored spellings of a hard break. Written as constants so no editor
// or formatter can silently eat the trailing spaces in this file.
const TWO_SPACE = '  '
const BACKSLASH = '\\'

// One paragraph per continuation-prefix container, plus the backslash spelling.
const LINES = [
  '# 硬换行',
  '',
  '甲一' + TWO_SPACE,            // bare paragraph, two-space spelling
  '甲二',
  '',
  '> 乙一' + TWO_SPACE,          // blockquote — the shape the refusal existed for
  '> 乙二',
  '',
  '- 丙一' + TWO_SPACE,          // list indentation
  '  丙二',
  '',
  '丁一' + BACKSLASH,            // backslash spelling
  '丁二',
  ''
]
const FIXTURE = LINES.join('\n')
const CRLF_FIXTURE = ['# CRLF', '', '> 戊一' + TWO_SPACE, '> 戊二', ''].join('\r\n')

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`

async function waitFor(fn, message, tries = 60) {
  for (let index = 0; index < tries; index += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null
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

async function readSource(evaluate, label) {
  await toggleSourceMode(evaluate)
  const shown = await waitFor(() => visibleSource(evaluate), `source view did not appear (${label})`)
  await toggleSourceMode(evaluate)
  await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), `rich view did not return (${label})`)
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
  await sleep(200)
  const clicked = await evaluate(`(() => {
    const item = [...document.querySelectorAll('.block-switch-menu .block-menu-item')].find((node) => node.offsetParent)
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

// A hard break renders as a <br>, which splits the block's rendered text into
// one TEXT NODE PER VISUAL LINE and contributes no characters of its own. So
// "the start of the continuation line" is offset 0 of text node N — and it is a
// DIFFERENT ProseMirror position from "the end of the previous line" (offset
// len of text node N-1), which is exactly the distinction this regression is
// about. A raw DOM selection does not sync PM state, so every caret placement
// here is a real mouse click (this repo's CDP convention).
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
  assert.ok(rect.lines >= 2,
    `${JSON.stringify(blockText)} must render as at least two text nodes (a <br> between them) — got ${rect.lines}`)
  const x = edge === 'start' ? rect.left + 1 : rect.right - 1
  await click(send, { x, y: rect.top + Math.min(12, rect.height / 2) })
  await sleep(200)
}

// Positive control for a caret placement: which rendered line is it in, and at
// what offset? A mis-click can only make an assertion FAIL below (the bytes
// would land elsewhere), but this turns "wrong line" into a legible message.
const caretProbe = (evaluate) => evaluate(`(() => {
  const sel = document.getSelection()
  if (!sel || !sel.anchorNode) return 'no-selection'
  return JSON.stringify({ text: sel.anchorNode.textContent, offset: sel.anchorOffset })
})()`)

const blockTexts = (evaluate) => evaluate(`JSON.stringify(
  [...((${VISIBLE_EDITOR})?.querySelectorAll('p') || [])].filter((n) => n.offsetParent).map((n) => n.textContent)
)`)

const diagnostics = (evaluate) => evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)

// Kernel mode is a per-tab remount, and this repo's convention for a second
// document is a second LAUNCH (its own profile + CDP port), not an in-app open
// — see scripts/test-kernel-stage3-ui.mjs's own CRLF session.
async function attachKernelMode(app) {
  const { evaluate } = app
  await waitFor(() => evaluate(`!!(${VISIBLE_EDITOR})`), 'editor did not mount')
  await sleep(400)
  await toggleKernelMode(evaluate)
  await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`),
    'kernel mode did not remount the tab')
  await sleep(500)
  await evaluate('window.__hmKernelDiagnostics = []')
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)
  await writeFile(crlfFile, CRLF_FIXTURE)
  let app
  let expected = FIXTURE
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    const { evaluate, send } = app
    await attachKernelMode(app)

    // Every hard-break paragraph must render as two visual lines — the fixture
    // really did parse as hard breaks, not as four separate paragraphs.
    assert.deepEqual(JSON.parse(await blockTexts(evaluate)).filter((t) => /一/.test(t)),
      ['甲一甲二', '乙一乙二', '丙一丙二', '丁一丁二'],
      'the fixture must load as four hard-break blocks')

    // =====================================================================
    // 1) THE BUG SHAPE: type at the START of a BLOCKQUOTED continuation line.
    //    The committed bytes must be '> 乙一  \n> Y乙二' — the '> ' marker
    //    intact. The pre-fix behaviour would have been '> 乙一  \nY> 乙二',
    //    which reparses as a quote followed by loose prose.
    // =====================================================================
    await clickLine(evaluate, send, '乙一乙二', 1, 'start')
    assert.equal(await caretProbe(evaluate), JSON.stringify({ text: '乙二', offset: 0 }),
      'the caret must sit at the start of the quoted continuation line (positive control)')
    await typeTextLikeUser(send, 'Y', { delayMs: delay })
    await sleep(400)
    expected = expected.replace('> 乙二', '> Y乙二')
    assert.equal(await readSource(evaluate, 'quoted continuation line'), expected,
      "typing at a quoted continuation line's start must keep the '> ' marker")
    assert.ok(JSON.parse(await blockTexts(evaluate)).includes('乙一Y乙二'),
      `the view must show the typed character on the second line — got ${await blockTexts(evaluate)}`)

    // =====================================================================
    // 2) The same position in a LIST-INDENTED paragraph: the continuation
    //    line's own indentation must survive, or the second line stops being
    //    part of the item.
    // =====================================================================
    await clickLine(evaluate, send, '丙一丙二', 1, 'start')
    await typeTextLikeUser(send, 'Z', { delayMs: delay })
    await sleep(400)
    expected = expected.replace('  丙二', '  Z丙二')
    assert.equal(await readSource(evaluate, 'list continuation line'), expected,
      "typing at a list continuation line's start must keep the indentation")

    // =====================================================================
    // 3) BEFORE the break — the other boundary. The two spaces that SPELL the
    //    break must stay behind the typed character, or the break is gone.
    // =====================================================================
    await clickLine(evaluate, send, '甲一甲二', 0, 'end')
    assert.equal(await caretProbe(evaluate), JSON.stringify({ text: '甲一', offset: 2 }),
      'the caret must sit at the end of the first line (positive control)')
    await typeTextLikeUser(send, 'W', { delayMs: delay })
    await sleep(400)
    expected = expected.replace('甲一' + TWO_SPACE, '甲一W' + TWO_SPACE)
    assert.equal(await readSource(evaluate, 'before the break'), expected,
      'typing before a hard break must leave its two spaces in place')
    assert.ok(JSON.parse(await blockTexts(evaluate)).includes('甲一W甲二'),
      'the break must still be a break after typing in front of it')

    // =====================================================================
    // 4) The BACKSLASH spelling is the same shape through a different byte.
    // =====================================================================
    await clickLine(evaluate, send, '丁一丁二', 1, 'start')
    await typeTextLikeUser(send, 'V', { delayMs: delay })
    await sleep(400)
    expected = expected.replace('丁二', 'V丁二')
    assert.equal(await readSource(evaluate, 'backslash spelling'), expected,
      'a backslash-spelled hard break types identically')

    // =====================================================================
    // 5) BACKSPACE at the start of a continuation line deletes the WHOLE break
    //    (line ending + continuation prefix) and joins the two lines. Deleting
    //    only the pre-prefix bytes would have left '甲一W甲二' spelled across a
    //    still-broken line.
    // =====================================================================
    await clickLine(evaluate, send, '甲一W甲二', 1, 'start')
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(400)
    expected = expected.replace('甲一W' + TWO_SPACE + '\n甲二', '甲一W甲二')
    assert.equal(await readSource(evaluate, 'backspace over the break'), expected,
      'Backspace at a continuation line start must remove the whole break and join the lines')

    // =====================================================================
    // 6) Save, and prove the bytes reached the FILE unchanged. Trailing spaces
    //    included — this is the shape a "helpful" trailing-whitespace trim
    //    would silently destroy.
    // =====================================================================
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'document never became dirty')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(1200)
    assert.equal(await evaluate(`!!document.querySelector('.hm-save-fab')`), false,
      `save did not settle (diagnostics: ${await diagnostics(evaluate)})`)
    assert.deepEqual(app.dialogs.map((dialog) => dialog.message), [],
      'hard-break editing must never prompt for recovery')
    assert.equal(await readFile(file, 'utf8'), expected,
      'the saved file must be byte-identical to the kernel source view')

    // =====================================================================
    // 7) THE OBSERVABILITY INVARIANT: every commit above must have changed
    //    what the bytes reparse to. This is the net that would catch a
    //    character committed into a position CommonMark strips.
    // =====================================================================
    const seen = await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || [])
      .filter((entry) => entry && entry.type === 'edit-unobservable'))`)
    assert.equal(seen, '[]', `an edit was not observable in the reparse: ${seen}`)

    console.log('  LF session OK')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }

  // =====================================================================
  // 8) CRLF, as its own SESSION (this repo's convention for a second
  //    document). Uniformly CRLF: the break's unit spans '\r\n' plus the
  //    '> ' prefix as ONE indivisible unit, so no commit can land between the
  //    CR and the LF, and the file must stay uniformly CRLF through a save.
  // =====================================================================
  let crlfApp
  try {
    crlfApp = await launchBuiltElectron({
      profileDir: join(root, 'profile-crlf'), port: port + 2, appArgs: [crlfFile]
    })
    const { evaluate, send } = crlfApp
    await attachKernelMode(crlfApp)
    assert.ok(JSON.parse(await blockTexts(evaluate)).includes('戊一戊二'),
      `the CRLF fixture must load as one hard-break block — got ${await blockTexts(evaluate)}`)
    await clickLine(evaluate, send, '戊一戊二', 1, 'start')
    await typeTextLikeUser(send, 'U', { delayMs: delay })
    await sleep(400)
    const crlfExpected = CRLF_FIXTURE.replace('> 戊二', '> U戊二')
    // A <textarea>'s `value` is LF-normalized by the HTML spec, so the source
    // VIEW can only prove the characters; the file below proves the endings.
    assert.equal(await readSource(evaluate, 'CRLF continuation line'), crlfExpected.replace(/\r\n/g, '\n'),
      'a CRLF quoted hard break types byte-exact and keeps its marker (LF projection in the source view)')
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'CRLF document never became dirty')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(1500)
    assert.deepEqual(crlfApp.dialogs.map((dialog) => dialog.message), [],
      'the CRLF session must never prompt for recovery')
    const savedCrlf = await readFile(crlfFile, 'utf8')
    assert.equal(savedCrlf, crlfExpected, 'the saved CRLF file must be byte-identical')
    assert.ok(!/\r(?!\n)/.test(savedCrlf), 'the CRLF document must contain no lone \\r')
    assert.ok(!/(?<!\r)\n/.test(savedCrlf), 'the CRLF document must contain no bare \\n')
    const unobservable = await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || [])
      .filter((entry) => entry && entry.type === 'edit-unobservable'))`)
    assert.equal(unobservable, '[]', `a CRLF edit was not observable in the reparse: ${unobservable}`)

    console.log('PASS kernel-mode hard-break UI regression: typing at the start of a quoted / list-indented / backslash-spelled continuation line commits byte-exact with its prefix intact, typing before a break keeps its spelling, Backspace joins the lines, and the CRLF document stays uniformly CRLF through a real save')
  } finally {
    await stopBuiltElectron(crlfApp, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
