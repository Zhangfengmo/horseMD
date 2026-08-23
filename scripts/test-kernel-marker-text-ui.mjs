// Kernel-mode BARE-MARKER TEXT — typing `*` (or `-`, `1.`, `#`) on a blank
// line and then CONTINUING WITH ORDINARY TEXT. The second exit of the
// bare-marker intermediate state; the completing Space is the first (see
// scripts/test-kernel-marker-space-ui.mjs and marker-space.js's ADR).
//
// Measured in the BUILT APP before the fix (2026-08-21, real keydowns, the
// user-reported gesture): typing `*` on a blank line at the document end
//   * committed the byte and the reparse made an EMPTY bullet item,
//   * the repair reconcile THREW THE CARET into the trailing placeholder,
//   * the continuation text landed as a SEPARATE paragraph — `*a` typed,
//     `甲一\n\n*\n\na` on disk, a dead empty list rendered, no toast, only a
//     map-refresh-failed + projection-mismatch diagnostic pair;
//   * and the SPACE exit was broken too in this byte shape (fixture with a
//     trailing newline): `*` then Space refused `unsupported-structure`,
//     because the stranded caret routed the Space from the placeholder. The
//     existing marker-space UI suite passed only because its fixture had no
//     trailing newline — the placeholder's raw offset happened to coincide
//     with the marker line's end.
//
// What only a real session can prove (the headless suites prove the bytes):
//   * the caret survives the `*` -> empty-item reconcile (rides the SAME
//     transaction — a follow-up dispatch cannot reach Crepe's Vue list-item
//     DOM before it mounts);
//   * a real keydown reaches the marker-following route ahead of the preset
//     input rules, and the RENDERED block demotes to a paragraph;
//   * the Space exit still creates a REAL list in this same byte shape;
//   * everything reaches disk through a real save.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-marker-text-${process.pid}`
const file = join(root, 'marker-text.md')
const port = Number(process.env.CDP_PORT || 10087)
const EOL = process.env.KERNEL_MARKER_TEXT_CRLF ? '\r\n' : '\n'

// The trailing terminator is load-bearing: it is the byte shape whose
// placeholder-offset coincidence masked the caret loss (see header).
const FIXTURE = '甲一' + EOL

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

// An HTML `<textarea>`'s `.value` normalizes every line ending to LF, so on a
// CRLF document the view and the file legitimately differ in exactly that way.
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

async function clickAtTextNode(evaluate, send, needle, within = 0) {
  const rect = await waitFor(() => evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    if (!editor) return null
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let n
    while ((n = walker.nextNode())) {
      const at = n.textContent.indexOf(${JSON.stringify(needle)})
      if (at < 0) continue
      n.parentElement?.scrollIntoView({ block: 'center' })
      const range = document.createRange()
      range.setStart(n, at + ${within}); range.setEnd(n, at + ${within})
      const box = range.getBoundingClientRect()
      return { left: box.left, top: box.top, height: box.height }
    }
    return null
  })()`), `could not locate text node containing ${JSON.stringify(needle)}`)
  const point = { x: rect.left + 0.5, y: rect.top + Math.min(12, rect.height / 2) }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await sleep(250)
}

// A real keydown that ALSO delivers the character (rawKeyDown suppresses the
// char event and would bypass handleTextInput entirely — the route under test).
async function typeText(send, text) {
  for (const ch of text) {
    const code = ch === ' ' ? 'Space'
      : /^[a-zA-Z]$/.test(ch) ? 'Key' + ch.toUpperCase()
        : /^[0-9]$/.test(ch) ? 'Digit' + ch : 'Unidentified'
    const vk = ch === ' ' ? 32 : /^[A-Za-z0-9]$/.test(ch) ? ch.toUpperCase().charCodeAt(0) : 0
    const common = { key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, text: ch })
    await sleep(15)
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    await sleep(420)
  }
}

const blockTexts = async (evaluate) => JSON.parse(await evaluate(`JSON.stringify(
  [...((${VISIBLE_EDITOR})?.children || [])].map((n) => n.tagName + ':' + n.textContent)
)`))

const toasts = (evaluate) => evaluate(`JSON.stringify(window.__markerTextToasts || [])`)
const resetToasts = (evaluate) => evaluate(`(window.__markerTextToasts = [], 1)`)

async function openBlankLineAfter(evaluate, send, needle) {
  await clickAtTextNode(evaluate, send, needle, needle.length)
  await pressKey(send, { key: 'Enter', code: 'Enter' })
  await sleep(450)
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    const { evaluate, send } = app
    await waitFor(() => evaluate(`!!(${VISIBLE_EDITOR})`), 'editor did not mount')
    await sleep(400)
    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await sleep(500)
    await evaluate(`
      window.__markerTextToasts = []
      window.addEventListener('hm:toast', (e) => window.__markerTextToasts.push(e.detail?.msg ?? String(e.detail)))
    `)

    // =====================================================================
    // 1) THE REPORTED GESTURE: `*` on a blank line, then letters. The marker
    //    demotes to literal text and the continuation stays ATTACHED to it.
    // =====================================================================
    await resetToasts(evaluate)
    await openBlankLineAfter(evaluate, send, '甲一')
    await typeText(send, '*ab')
    {
      assert.equal(await toasts(evaluate), '[]', 'the demotion must not refuse')
      const source = await readSource(evaluate, 'star demotion')
      assert.ok(source.includes('*ab'),
        `the typed text must stay attached to its marker — got ${JSON.stringify(source)}`)
      assert.ok(!/\*\n/.test(source.replace(/\r/g, '')),
        `no severed bare marker may remain — got ${JSON.stringify(source)}`)
      const blocks = await blockTexts(evaluate)
      assert.ok(blocks.includes('P:*ab'),
        `the block must RENDER as the literal paragraph, not a list — got ${JSON.stringify(blocks)}`)
      assert.ok(!blocks.some((entry) => entry.startsWith('UL:')),
        `no dead empty list may remain — got ${JSON.stringify(blocks)}`)
    }

    // =====================================================================
    // 2) ORDERED MARKER, same exit: `1.` then a letter is literal text.
    // =====================================================================
    await resetToasts(evaluate)
    await openBlankLineAfter(evaluate, send, '*ab')
    await typeText(send, '1')
    await typeText(send, '.')
    await typeText(send, 'x')
    {
      assert.equal(await toasts(evaluate), '[]', 'the ordered demotion must not refuse')
      const source = await readSource(evaluate, 'ordered demotion')
      // 2026-08-24 (marker-escaping delimiter): the restructuring '.' now
      // commits as `1\.` — the paragraph never transits through a bare
      // ordered item at all; the render below is unchanged ("1.x").
      assert.ok(source.includes('1\\.x'), `got ${JSON.stringify(source)}`)
      const blocks = await blockTexts(evaluate)
      assert.ok(blocks.includes('P:1.x'),
        `the ordered marker must demote to a paragraph — got ${JSON.stringify(blocks)}`)
    }

    // =====================================================================
    // 3) HEADING MARKER: `#` then a letter — `#x` is a paragraph (CommonMark
    //    requires the space), same demotion through the same route.
    // =====================================================================
    await resetToasts(evaluate)
    await openBlankLineAfter(evaluate, send, '1.x')
    await typeText(send, '#x')
    {
      assert.equal(await toasts(evaluate), '[]', 'the heading demotion must not refuse')
      const source = await readSource(evaluate, 'heading demotion')
      assert.ok(source.includes('#x'), `got ${JSON.stringify(source)}`)
      const blocks = await blockTexts(evaluate)
      assert.ok(blocks.includes('P:#x'),
        `#x must stay a paragraph, not become an H1 — got ${JSON.stringify(blocks)}`)
    }

    // =====================================================================
    // 4) THE FIRST EXIT STILL WORKS IN THIS BYTE SHAPE: `*` Space letter
    //    creates a REAL list. Before the caret restore this refused
    //    `unsupported-structure` here (trailing-newline fixture), because the
    //    stranded caret routed the Space from the placeholder.
    // =====================================================================
    await resetToasts(evaluate)
    await openBlankLineAfter(evaluate, send, '#x')
    await typeText(send, '* ')
    await typeText(send, 'x')
    {
      assert.equal(await toasts(evaluate), '[]',
        `the completing Space must not refuse in the trailing-newline shape — got ${await toasts(evaluate)}`)
      const source = await readSource(evaluate, 'space completion')
      assert.ok(source.includes('* x'), `got ${JSON.stringify(source)}`)
      const blocks = await blockTexts(evaluate)
      assert.ok(blocks.some((entry) => entry.startsWith('UL:')),
        `a real list must be RENDERED — got ${JSON.stringify(blocks)}`)
    }

    // =====================================================================
    // 5) NEGATIVE CONTROL: `*` typed MID-TEXT is an ordinary character — the
    //    new route must not claim it (no demotion machinery, no toast).
    // =====================================================================
    await resetToasts(evaluate)
    await clickAtTextNode(evaluate, send, '甲一', 0)
    await typeText(send, '*')
    {
      assert.equal(await toasts(evaluate), '[]', 'an ordinary * must not refuse')
      const source = await readSource(evaluate, 'mid-text control')
      assert.ok(source.includes('*甲一'),
        `the * lands as plain text before 甲一 — got ${JSON.stringify(source)}`)
    }

    // =====================================================================
    // 6) EVERYTHING REACHES DISK through a real save.
    // =====================================================================
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((n) => /保存|Save/.test(n.title || n.textContent || ''))
      button?.click()
    })()`)
    const onDisk = await waitFor(async () => {
      const text = await readFile(file, 'utf8')
      return text.includes('*ab') ? text : null
    }, 'the edits must reach disk')
    assert.ok(onDisk.includes('*ab'), 'the demoted star paragraph survives the save')
    assert.ok(onDisk.includes('1\\.x'), 'the demoted ordered paragraph survives the save (escaped spelling since 2026-08-24)')
    assert.ok(onDisk.includes('#x'), 'the demoted heading paragraph survives the save')
    assert.ok(onDisk.includes('* x'), 'the completed list survives the save')
    assert.ok(onDisk.includes('*甲一'), 'the mid-text * survives the save')
    if (EOL === '\r\n') {
      assert.ok(onDisk.includes('\r\n'), 'a CRLF document must stay CRLF')
      assert.ok(!/[^\r]\n/.test(onDisk), 'no bare LF may be introduced into a CRLF document')
    }

    console.log('PASS kernel marker text: bare `*`/`1.`/`#` demote to literal paragraphs under ordinary typing, the caret survives the empty-structure reconcile, `* ` still creates a real list, and everything reaches disk')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
