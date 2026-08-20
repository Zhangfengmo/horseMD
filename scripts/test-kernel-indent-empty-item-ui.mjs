// Kernel-mode TAB IN AN EMPTY LIST ITEM — a user report with before/after
// screenshots, reproduced on the first attempt through the app's own gestures.
//
// BEFORE: a bullet list of three items — `12312`, then `123213` whose TEXT was
// visibly indented while its bullet stayed aligned (two leading U+00A0, written
// by the whitespace family), then an EMPTY third item holding the caret.
// GESTURE: one Tab.
// AFTER:   `12312`, an EMPTY bullet item, and `123213` rendered LARGE AND BOLD
//          outside the list.
//
// WHAT FIRED: `indentListItem` inserted two spaces at the empty item's line
// start, turning `- ` into `  - `. Those bytes are individually legal, and this
// command had NO reparse behind it — the only structural family in the kernel
// without one — so nothing noticed that CommonMark reads `  - ` on its own line
// as a SETEXT HEADING UNDERLINE rather than a nested item: an EMPTY list item
// cannot interrupt a paragraph. The second item became an empty paragraph plus
// an `<h2>` carrying its words.
//
// The U+00A0 run is NOT implicated — the identical corruption happens on plain
// text, which the headless suite pins as a control
// (scripts/test-source-kernel-indent.mjs). It is reproduced here WITH the run
// anyway, because that is the document the user actually had.
//
// The headless suite proves the BYTES and the refusal codes. Only a real session
// can prove what this script asserts: that a real Tab keydown reaches the proof,
// that the RENDERED list is still a list (no heading, three items), that the
// message the user sees names the remedy, and that the remedy then works.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-indent-empty-${process.pid}`
const file = join(root, 'indent.md')
const port = Number(process.env.CDP_PORT || 10077)
const EOL = process.env.KERNEL_INDENT_CRLF ? '\r\n' : '\n'
const NBSP = ' '

const FIXTURE = ['- 12312', '- 123213'].join(EOL)

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`

async function waitFor(fn, message, tries = 60) {
  for (let index = 0; index < tries; index += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)?.value ?? null
)`)

async function toggleSourceMode(evaluate) {
  const clicked = await evaluate(`(() => {
    const b = [...document.querySelectorAll('.status-btn')]
      .find((n) => n.offsetParent && !n.classList.contains('block-switch-caret-btn') &&
        /源码|Source|富文本|Rich|Ctrl\\+\\/|⌘\\//.test(n.title || n.textContent || ''))
    b?.click()
    return !!b
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
    const b = document.querySelector('.block-switch-caret-btn')
    b?.click()
    return !!b
  })()`)
  assert.ok(opened, 'no kernel-mode caret button — tab not kernel-eligible?')
  await sleep(200)
  const clicked = await evaluate(`(() => {
    const i = [...document.querySelectorAll('.block-switch-menu .block-menu-item')].find((n) => n.offsetParent)
    i?.click()
    return !!i
  })()`)
  assert.ok(clicked, 'kernel-toggle menu item missing')
}

async function clickAtTextNode(evaluate, send, needle, within = 0) {
  const rect = await waitFor(() => evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    if (!editor) return null
    const w = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let n
    while ((n = w.nextNode())) {
      const at = n.textContent.indexOf(${JSON.stringify(needle)})
      if (at < 0) continue
      n.parentElement?.scrollIntoView({ block: 'center' })
      const r = document.createRange()
      r.setStart(n, at + ${within}); r.setEnd(n, at + ${within})
      const b = r.getBoundingClientRect()
      return { left: b.left, top: b.top, height: b.height }
    }
    return null
  })()`), `could not locate text node containing ${JSON.stringify(needle)}`)
  const pt = { x: rect.left + 0.5, y: rect.top + Math.min(12, rect.height / 2) }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pt })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...pt })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...pt })
  await sleep(250)
}

// A real keydown that also delivers the character — a Space sent as `rawKeyDown`
// would only ever reach a keymap, and the line-start whitespace route is on the
// byte path.
async function typeText(send, text) {
  for (const ch of text) {
    const code = ch === ' ' ? 'Space' : /^[a-zA-Z]$/.test(ch) ? 'Key' + ch.toUpperCase()
      : /^[0-9]$/.test(ch) ? 'Digit' + ch : 'Unidentified'
    const vk = ch === ' ' ? 32 : /^[A-Za-z0-9]$/.test(ch) ? ch.toUpperCase().charCodeAt(0) : 0
    const common = { key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, text: ch })
    await sleep(15)
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    await sleep(430)
  }
}

async function pressTab(send, shift = false) {
  const c = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, ...(shift ? { modifiers: 8 } : {}) }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...c })
  await sleep(15)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...c })
  await sleep(500)
}

// Every rendered block tag inside the editor, list interiors included — the only
// way to state "no heading appeared", which is what the screenshot showed.
const renderedTags = async (evaluate) => JSON.parse(await evaluate(`JSON.stringify((() => {
  const editor = ${VISIBLE_EDITOR}
  if (!editor) return []
  return [...editor.querySelectorAll('h1,h2,h3,h4,h5,h6,li,p')].map((n) => n.tagName)
})())`))

const toasts = (evaluate) => evaluate(`JSON.stringify(window.__ieToasts || [])`)
const resetToasts = (evaluate) => evaluate(`(window.__ieToasts = [], 1)`)

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
      window.__ieToasts = []
      window.addEventListener('hm:toast', (e) => window.__ieToasts.push(e.detail?.msg ?? String(e.detail)))
    `)

    // =====================================================================
    // 1) BUILD THE USER'S DOCUMENT THROUGH THE APP'S OWN GESTURES — the two
    //    leading U+00A0 come from two real Space presses at the item's text
    //    start (the current spelling rule), never from authored bytes.
    // =====================================================================
    await clickAtTextNode(evaluate, send, '123213', 0)
    await typeText(send, ' ')
    await typeText(send, ' ')
    {
      const source = await readSource(evaluate, 'nbsp run')
      assert.ok(source.includes('- ' + NBSP),
        `the item must carry a real U+00A0 run — got ${JSON.stringify(source)}`)
    }
    await clickAtTextNode(evaluate, send, '123213', 6)
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(450)
    const beforeTab = await readSource(evaluate, 'before tab')
    assert.ok(beforeTab.endsWith('- '), `the third item must be empty — got ${JSON.stringify(beforeTab)}`)

    // =====================================================================
    // 2) THE REPORTED GESTURE: one Tab in the empty third item.
    //    It must REFUSE — the bytes it would write reparse to a heading — and
    //    say so in a way the user can act on.
    // =====================================================================
    await resetToasts(evaluate)
    await pressTab(send)
    {
      const fired = JSON.parse(await toasts(evaluate))
      assert.equal(fired.length, 1, `the Tab must be refused exactly once — got ${JSON.stringify(fired)}`)
      assert.ok(/标题|heading/.test(fired[0]),
        `the message must name what would have happened — got ${JSON.stringify(fired[0])}`)
      assert.ok(!/unsupported-input-type|unsupported-structure/.test(fired[0]),
        `and must not be the generic machine-code toast — got ${JSON.stringify(fired[0])}`)
    }
    // 2a) NOT ONE BYTE MOVED.
    assert.equal(await readSource(evaluate, 'after tab'), beforeTab,
      'a refused indent must write nothing at all')
    // 2b) THE LIST IS STILL A LIST — this is the screenshot's actual complaint:
    //     no heading anywhere, and all three items still items.
    {
      const tags = await renderedTags(evaluate)
      assert.ok(!tags.some((t) => /^H[1-6]$/.test(t)),
        `no heading may appear — got ${JSON.stringify(tags)}`)
      assert.equal(tags.filter((t) => t === 'LI').length, 3,
        `the list must still have three items — got ${JSON.stringify(tags)}`)
    }

    // =====================================================================
    // 3) THE REMEDY THE MESSAGE NAMES ACTUALLY WORKS: type something in the
    //    item, and the same Tab nests it. A refusal that left the user with
    //    no way forward would be a worse bug than the one being fixed.
    // =====================================================================
    await resetToasts(evaluate)
    await typeText(send, 'x')
    await pressTab(send)
    assert.equal(await toasts(evaluate), '[]',
      `indenting a NON-empty item must not refuse — got ${await toasts(evaluate)}`)
    {
      const source = await readSource(evaluate, 'after remedy')
      assert.ok(source.includes('\n  - x'),
        `the item must now be nested — got ${JSON.stringify(source)}`)
      const tags = await renderedTags(evaluate)
      assert.ok(!tags.some((t) => /^H[1-6]$/.test(t)), 'and still no heading')
    }

    // =====================================================================
    // 4) THE MIRROR GESTURE: Shift-Tab back out, with the U+00A0-bearing
    //    sibling right above it. The report suspected that run of defeating
    //    the marker arithmetic; it does not, and this pins that it keeps
    //    working rather than being refused by the new proof.
    // =====================================================================
    await resetToasts(evaluate)
    await pressTab(send, true)
    assert.equal(await toasts(evaluate), '[]',
      `outdent beside a U+00A0 sibling must not refuse — got ${await toasts(evaluate)}`)
    assert.ok((await readSource(evaluate, 'after outdent')).includes('\n- x'),
      'the item must be back at the top level')

    // =====================================================================
    // 5) IT ALL REACHES DISK, and a CRLF document stays CRLF.
    // =====================================================================
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((n) => /保存|Save/.test(n.title || n.textContent || ''))
      b?.click()
    })()`)
    const onDisk = await waitFor(async () => {
      const text = await readFile(file, 'utf8')
      return text.includes('- x') ? text : null
    }, 'the edits must reach disk')
    assert.ok(onDisk.includes(NBSP), 'the U+00A0 run survives the save')
    assert.ok(!/^#/m.test(onDisk), 'and no heading was ever written')
    if (EOL === '\r\n') {
      assert.ok(onDisk.includes('\r\n'), 'a CRLF document must stay CRLF')
      assert.ok(!/[^\r]\n/.test(onDisk), 'no bare LF may be introduced into a CRLF document')
    }

    console.log('PASS kernel indent empty item: Tab in an empty list item refuses with an actionable message and writes nothing; the list keeps its three items and grows no heading; typing text then indenting works, and outdent beside a U+00A0 sibling is untouched')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
