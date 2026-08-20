// Kernel-mode MARKER CREATION — typing `- `, `1. `, `> `, `## `, `- [ ] ` and
// having a list / quote / heading actually appear. THE fundamental Markdown
// gesture, and in kernel mode it did not work in ANY position for ANY family.
//
// Measured in the BUILT APP before the fix (2026-08-20, real mouse carets, one
// real keydown at a time, source view and rendered blocks both read back):
//
//   position                    typed   outcome BEFORE
//   --------------------------  ------  --------------------------------------
//   empty paragraph             `- `    `-` on disk, the reparse makes an EMPTY
//                                       ITEM WITH NO SPACING, the Space is
//                                       refused — a block the user can never
//                                       type into
//   empty paragraph             `# `    same, refused with 「只读」
//   empty paragraph             `## `   same, and the SECOND `#` was refused too
//   paragraph start (has text)  `- `    the preset input rule fires, its node
//                                       transaction is vetoed
//                                       (`unsupported-input-type`), `-` is left
//                                       sitting in the text
//   list item, text start       `- `    the Space is RE-SPELLED U+00A0
//                                       (`- -<U+00A0>x`) — no nested list, no
//                                       message at all
//
// Three different interceptions of one missing rule — see
// lib/source-kernel/commands/marker-space.js for the full account. The headless
// suite (scripts/test-source-kernel-marker-space.mjs) proves the BYTES; only a
// real session can prove what this script asserts:
//   * that a real Space keydown reaches the new route AHEAD of the preset input
//     rules (the whole point — the rule cannot succeed in kernel mode, so it
//     must not get there first);
//   * that a real `#` keydown reaches the run-growth path, which rides
//     `handleTextInput` rather than a keymap;
//   * that the RENDERED block really becomes a list / quote / heading, not just
//     that the bytes did;
//   * that the caret survives, so the next character lands as the item's text;
//   * and that the bytes reach disk through a real save.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-marker-space-${process.pid}`
const file = join(root, 'marker.md')
const port = Number(process.env.CDP_PORT || 10073)
// The CRLF run proves the same gestures on a document whose every line ending
// is '\r\n' — the ending axis the headless suite covers byte by byte, driven
// through the real UI once so no path can quietly narrow to LF.
const EOL = process.env.KERNEL_MARKER_CRLF ? '\r\n' : '\n'

const LINES = ['甲一', '', '- 乙一', '', '丙一']
const FIXTURE = LINES.join(EOL)

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

// A real keydown that ALSO delivers the character. CDP's `rawKeyDown` suppresses
// the char event, so a Space sent that way would only ever reach a KEYMAP and a
// `#` would never reach `handleTextInput` at all — which would make this script
// prove nothing about either route. Virtual key codes are given only for keys a
// keymap can plausibly bind; a naive charCodeAt maps '.' to VK_DELETE.
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

// EXACT tag + text of every top-level block: the only way to state "a LIST
// appeared", as opposed to "the bytes now spell one".
const blockTexts = async (evaluate) => JSON.parse(await evaluate(`JSON.stringify(
  [...((${VISIBLE_EDITOR})?.children || [])].map((n) => n.tagName + ':' + n.textContent)
)`))

const toasts = (evaluate) => evaluate(`JSON.stringify(window.__markerToasts || [])`)
const resetToasts = (evaluate) => evaluate(`(window.__markerToasts = [], 1)`)

const NBSP = ' '

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
      window.__markerToasts = []
      window.addEventListener('hm:toast', (e) => window.__markerToasts.push(e.detail?.msg ?? String(e.detail)))
    `)

    // =====================================================================
    // 1) THE REPORTED POSITION: a bullet item's text start. Before the fix
    //    the Space became U+00A0 and no nested list appeared, silently.
    // =====================================================================
    await resetToasts(evaluate)
    await clickAtTextNode(evaluate, send, '乙一', 0)
    await typeText(send, '- ')
    {
      const source = await readSource(evaluate, 'nested bullet')
      assert.ok(source.includes('- - 乙一'),
        `a nested bullet must be written with a REAL space — got ${JSON.stringify(source)}`)
      assert.ok(!source.includes(NBSP),
        `the marker-completing space must never be re-spelled U+00A0 — got ${JSON.stringify(source)}`)
      assert.equal(await toasts(evaluate), '[]', 'creating a nested list must not refuse')
    }
    // 1a) ...and the caret is on the CONTENT side of the new marker, so the
    //     next character becomes the item's text rather than more marker.
    await typeText(send, 'x')
    assert.ok((await readSource(evaluate, 'nested bullet typing')).includes('- - x乙一'),
      'the caret must land after the completed marker')

    // =====================================================================
    // 2) A NON-EMPTY PARAGRAPH's start — the position where the preset input
    //    rule fires and the gateway vetoes its node transaction.
    // =====================================================================
    await resetToasts(evaluate)
    await clickAtTextNode(evaluate, send, '甲一', 0)
    await typeText(send, '- ')
    {
      assert.equal(await toasts(evaluate), '[]', 'making a list from a paragraph must not refuse')
      const source = await readSource(evaluate, 'paragraph to list')
      assert.ok(source.startsWith('- 甲一'), `the paragraph must become a list item — got ${JSON.stringify(source)}`)
      const blocks = await blockTexts(evaluate)
      assert.ok(blocks.some((entry) => entry.startsWith('UL:')),
        `a real list must be RENDERED, not just spelled — got ${JSON.stringify(blocks)}`)
    }

    // =====================================================================
    // 3) AN EMPTY PARAGRAPH — the canonical gesture, and the position where
    //    the first marker character has ALREADY converted the block, so the
    //    preset input rule can never fire at all. Driven with `## `, the
    //    family that also needs marker-run growth: `#` alone is a complete
    //    (empty) heading, which is why `# ` worked and `## ` did not.
    //
    //    Every blank line here is opened at the DOCUMENT END — the
    //    split-placeholder shape the kernel proves. A placeholder opened
    //    BETWEEN two existing blocks is a separate, still-open gap (reported,
    //    not fixed here), so this script deliberately does not stand on it.
    // =====================================================================
    await resetToasts(evaluate)
    await clickAtTextNode(evaluate, send, '丙一', 2)
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(450)
    await typeText(send, '## 标题')
    {
      assert.equal(await toasts(evaluate), '[]',
        `a second-level heading must not refuse — got ${await toasts(evaluate)}`)
      const source = await readSource(evaluate, 'h2')
      assert.ok(source.includes('## 标题'), `got ${JSON.stringify(source)}`)
      const blocks = await blockTexts(evaluate)
      assert.ok(blocks.includes('H2:标题'),
        `an H2 must be RENDERED, not an H1 and not a paragraph — got ${JSON.stringify(blocks)}`)
    }

    // =====================================================================
    // 4) AN ORDERED marker at the next blank line — a second family through
    //    the same route, so the fix cannot be bullet-and-heading shaped.
    // =====================================================================
    await resetToasts(evaluate)
    await clickAtTextNode(evaluate, send, '标题', 2)
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(450)
    await typeText(send, '1. 序号')
    {
      assert.equal(await toasts(evaluate), '[]', 'an ordered list on a blank line must not refuse')
      const source = await readSource(evaluate, 'ordered')
      assert.ok(source.includes('1. 序号'), `got ${JSON.stringify(source)}`)
      const blocks = await blockTexts(evaluate)
      assert.ok(blocks.some((entry) => entry.startsWith('OL:')),
        `an ordered list must be RENDERED — got ${JSON.stringify(blocks)}`)
    }

    // =====================================================================
    // 5) THE NEGATIVE CONTROL, and the promise this change did not take
    //    anything away: ordinary padding after an ALREADY-complete marker is
    //    still the line-start re-speller's business, so a Space at a bullet
    //    item's text start (no marker in front of it) still commits U+00A0.
    //    If this ever becomes a literal space, the yield became a takeover.
    // =====================================================================
    await resetToasts(evaluate)
    await clickAtTextNode(evaluate, send, 'x乙一', 0)
    await typeText(send, ' ')
    {
      const source = await readSource(evaluate, 'padding control')
      assert.ok(source.includes('- - ' + NBSP + 'x乙一'),
        `a CONTENT space at an item's text start must still be re-spelled U+00A0 — got ${JSON.stringify(source)}`)
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
      return text.includes('## 标题') ? text : null
    }, 'the edits must reach disk')
    assert.ok(onDisk.includes('- - ' + NBSP + 'x乙一'), 'the nested item survives the save')
    assert.ok(onDisk.includes('1. 序号'), 'the ordered item survives the save')
    assert.ok(onDisk.startsWith('- 甲一'), 'the converted paragraph survives the save')
    if (EOL === '\r\n') {
      assert.ok(onDisk.includes('\r\n'), 'a CRLF document must stay CRLF')
      assert.ok(!/[^\r]\n/.test(onDisk), 'no bare LF may be introduced into a CRLF document')
    }

    console.log('PASS kernel marker space: `- `, `1. `, `## ` create real blocks at an empty paragraph, at a paragraph start and inside a list item; content padding still re-spells U+00A0')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
