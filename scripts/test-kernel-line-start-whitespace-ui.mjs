// Kernel-mode LINE-START whitespace — the user's own report, verbatim:
//
//     「tab 在行开头输入容易触发内核不支持此操作」
//
// A line's own leading whitespace is block STRUCTURE in CommonMark (paragraph
// indentation, a list marker's padding, a blockquote's `>` padding), so the byte
// written there is not content. Measured on the BUILT APP in kernel mode before
// the fix, one real keystroke at a time, reading back both the source view and
// the rendered block (full matrix:
// .superpowers/sdd/2026-08-17-source-kernel-default-on/linestart-whitespace-report.md):
//
//   position                             Tab                      Space
//   -----------------------------------  -----------------------  ---------------
//   paragraph, first content position    literal '\t'; the         literal ' ';
//                                        paragraph REPARSED AS     the view was
//                                        AN INDENTED CODE BLOCK,   repaired back,
//                                        silently (no toast, only  the byte stayed
//                                        `caret-unmappable`)       on disk
//   continuation line, SOFT break        literal '\t', stripped,   same
//                                        no diagnostic at all
//   continuation line, HARD break        same, both the `\` and the two-space
//                                        spellings
//   bullet item, text start              (INDENT — structural)     literal ' ',
//                                                                  stripped
//   blockquote paragraph, text start     literal '\t', stripped    same
//
// The headless suites prove the COMMAND
// (scripts/test-source-kernel-line-start-whitespace.mjs) and the WIRING
// (scripts/test-kernel-gateway.mjs section W). Neither can prove what this
// script drives: that a real Tab KEYDOWN reaches the new path before the literal
// fallback, that a real Space keydown reaches it at all (Space is deliberately
// NOT a kernel keymap key — the preset input rules fire on it), that the written
// run is VISIBLE and caret-addressable in the rendered block, and that the bytes
// survive a real save and a COLD REOPEN.
//
// THE CONTRACT, which is the user's standing acceptance ruling for this family
// («存下来并且能被看到»): preserved AND visible. Raw U+00A0, never an entity;
// Space -> one, Tab -> two; the character paints, takes the caret, and one
// Backspace deletes exactly one of them.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-line-start-${process.pid}`
const file = join(root, 'linestart.md')
const port = Number(process.env.CDP_PORT || 10062)
// The CRLF run proves the same shapes on a document whose every line ending is
// '\r\n' — the ending axis the headless suite covers byte-by-byte, driven here
// through the real UI once so no path can quietly narrow to LF.
const EOL = process.env.KERNEL_LINE_START_CRLF ? '\r\n' : '\n'

const NBSP = ' '
const NB2 = NBSP + NBSP

const LINES = [
  '段落甲行首。',
  '',
  'soft一',
  'soft二',
  '',
  'hardA\\',
  'hardB',
  '',
  '- 列表甲',
  '- 列表乙',
  '',
  '> 引用段落。',
  ''
]
const FIXTURE = LINES.join(EOL)

// Every byte expectation is derived from FIXTURE by substituting the leading run
// of one line, never hand-spelled, so a fixture change cannot leave a stale
// literal behind.
const doc = ({ para = '', soft = '', hard = '', item = '', quote = '' } = {}) => LINES
  .map((line) => {
    if (line === '段落甲行首。') return para + line
    if (line === 'soft二') return soft + line
    if (line === 'hardB') return hard + line
    if (line === '- 列表甲') return '- ' + item + '列表甲'
    if (line === '> 引用段落。') return '> ' + quote + '引用段落。'
    return line
  })
  .join(EOL)

// What the SOURCE VIEW shows. An HTML `<textarea>`'s `.value` normalizes every
// line ending to LF (the HTML spec's api value), so on a CRLF document the view
// and the file legitimately differ in exactly that one way. The disk assertions
// below use `doc()` — the real bytes; every source-view assertion uses this.
const seen = (opts) => doc(opts).replace(/\r\n/g, '\n')

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

// A real keydown that ALSO delivers the character. CDP's `rawKeyDown` suppresses
// the char event, so a Space sent that way only ever reaches a KEYMAP — and
// Space is deliberately not a kernel keymap key here, which would make this
// script silently prove nothing about the Space route.
async function pressChar(send, { key, code, text }) {
  const vk = key === ' ' ? 32 : key === 'Tab' ? 9 : key.toUpperCase().charCodeAt(0)
  const common = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, ...(text == null ? {} : { text }) })
  await sleep(15)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(400)
}

// Backspace has no character event; `pressKey`'s own table carries its virtual
// key code (a naive `charCodeAt(0)` would send 'B').
async function backspace(send) {
  await pressKey(send, { key: 'Backspace', code: 'Backspace' })
  await sleep(400)
}

// A raw DOM selection does NOT sync ProseMirror state — every caret placement
// here is a real mouse click, per this repo's CDP convention. Resolved per TEXT
// NODE so a soft/hard break (two text nodes in one paragraph) can be targeted.
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
      const off = at + ${within}
      range.setStart(n, off); range.setEnd(n, off)
      const box = range.getBoundingClientRect()
      return { left: box.left, top: box.top, height: box.height }
    }
    return null
  })()`), `could not locate text node containing ${JSON.stringify(needle)}`)
  await click(send, { x: rect.left + 0.5, y: rect.top + Math.min(12, rect.height / 2) })
  await sleep(250)
}

// EXACT rendered text of every top-level block. Not whitespace-collapsed: a
// stripped run and a surviving one both read as "one blank" once collapsed,
// which is exactly the distinction this script exists to make.
const blockTexts = async (evaluate) => JSON.parse(await evaluate(`JSON.stringify(
  [...((${VISIBLE_EDITOR})?.children || [])].map((n) => n.tagName + ':' + n.textContent)
)`))

// Rendered geometry of a block's leading whitespace run: how wide it actually
// PAINTS and where the first non-whitespace glyph sits. Bytes on disk and a
// `text` node in the projection are not enough — the reported defect was a
// character nobody could see.
async function leadingRunGeometry(evaluate, needle) {
  return evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    if (!editor) return null
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let node = null, n
    while ((n = walker.nextNode())) {
      if (n.textContent.includes(${JSON.stringify(needle)})) { node = n; break }
    }
    if (!node) return null
    const at = node.textContent.indexOf(${JSON.stringify(needle)})
    let run = 0
    while (run < at && /\\s/.test(node.textContent[run])) run += 1
    if (run !== at) return null
    const lead = document.createRange()
    lead.setStart(node, 0); lead.setEnd(node, run)
    const rest = document.createRange()
    rest.setStart(node, run); rest.setEnd(node, run + 1)
    const parent = node.parentElement
    const style = getComputedStyle(parent)
    const box = parent.getBoundingClientRect()
    return {
      runLength: run,
      runWidth: lead.getBoundingClientRect().width,
      firstGlyphLeft: rest.getBoundingClientRect().left,
      contentLeft: box.left + parseFloat(style.paddingLeft || '0') + parseFloat(style.borderLeftWidth || '0')
    }
  })()`)
}

// Where ProseMirror's own selection sits, as (block text, offset-in-block) — the
// caret assertion the user's gesture demands ("the caret lands after it").
const caretAt = (evaluate) => evaluate(`(() => {
  const sel = document.getSelection()
  if (!sel || !sel.anchorNode) return null
  const block = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode
  return JSON.stringify({ text: block?.textContent ?? null, offset: sel.anchorOffset })
})()`)

const diagnostics = (evaluate) => evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-6))`)
const toasts = (evaluate) => evaluate(`JSON.stringify(window.__lineStartToasts || [])`)

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    let { evaluate, send } = app
    await waitFor(() => evaluate(`!!(${VISIBLE_EDITOR})`), 'editor did not mount')
    await sleep(400)
    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await sleep(500)
    await evaluate(`
      window.__lineStartToasts = []
      window.addEventListener('hm:toast', (e) => window.__lineStartToasts.push(e.detail?.msg ?? String(e.detail)))
      window.__hmKernelDiagnostics = []
    `)

    // =====================================================================
    // 1) THE REPORTED GESTURE. Tab at a paragraph's first line.
    //    Before: a literal '\t' whose reparse turned the paragraph into an
    //    INDENTED CODE BLOCK, with no toast at all.
    // =====================================================================
    await clickAtTextNode(evaluate, send, '段落甲行首。', 0)
    await pressChar(send, { key: 'Tab', code: 'Tab', text: '\t' })
    assert.equal(
      await readSource(evaluate, 'tab at a paragraph line start'),
      seen({ para: NB2 }),
      'Tab at a paragraph line start must commit two real no-break spaces'
    )
    assert.equal(await toasts(evaluate), '[]',
      `the reported refusal must be gone — got ${await toasts(evaluate)}`)
    assert.ok(!/&[#a-zA-Z0-9]+;/.test(await readSource(evaluate, 'markup check')),
      'the source must hold whitespace characters, never a character reference')

    // 1a) THE PARAGRAPH MUST STILL BE A PARAGRAPH. This is the specific
    //     corruption the literal byte caused: `\t` at a line start is
    //     CommonMark's indented-code trigger.
    {
      const blocks = await blockTexts(evaluate)
      assert.ok(blocks.includes('P:' + NB2 + '段落甲行首。'),
        `the block must stay a paragraph and SHOW the indent — got ${JSON.stringify(blocks)}`)
      assert.ok(!blocks.some((entry) => entry.startsWith('DIV:')),
        `no block may have become a code block — got ${JSON.stringify(blocks)}`)
    }

    // 1b) IT MUST BE VISIBLE — the painted width of the run, and the first real
    //     glyph pushed right by it.
    {
      const geometry = await leadingRunGeometry(evaluate, '段落甲行首。')
      assert.ok(geometry, 'could not measure the paragraph geometry')
      assert.equal(geometry.runLength, 2, 'the paragraph must start with exactly two whitespace characters')
      assert.ok(geometry.runWidth > 1,
        `the leading run must PAINT, not collapse — measured ${JSON.stringify(geometry)}`)
      assert.ok(geometry.firstGlyphLeft > geometry.contentLeft + 1,
        `the first real glyph must be pushed right by the indent — ${JSON.stringify(geometry)}`)
    }

    // 1c) THE CARET LANDS AFTER IT.
    {
      const caret = JSON.parse(await caretAt(evaluate))
      assert.ok(caret, 'no selection after the Tab')
      assert.equal(caret.text, NB2 + '段落甲行首。', 'the caret must stay in the same paragraph')
      assert.equal(caret.offset, 2, 'the caret must land after the two written characters')
    }

    // 1d) BACKSPACE REMOVES IT, one character at a time — which is what a real
    //     whitespace character buys over an entity.
    await backspace(send)
    assert.equal(
      await readSource(evaluate, 'first backspace'),
      seen({ para: NBSP }),
      'one Backspace must delete exactly one no-break space'
    )
    await backspace(send)
    assert.equal(
      await readSource(evaluate, 'second backspace'),
      seen(),
      'the second Backspace must restore the original bytes exactly'
    )

    // 1e) Re-apply so the rest of the script starts from a known state.
    await clickAtTextNode(evaluate, send, '段落甲行首。', 0)
    await pressChar(send, { key: 'Tab', code: 'Tab', text: '\t' })
    assert.equal(await readSource(evaluate, 're-applied tab'), seen({ para: NB2 }),
      'the Tab must be re-appliable after a delete')

    // =====================================================================
    // 2) SPACE at the same kind of position, delivered as a REAL KEYDOWN with
    //    its character event. Space is NOT a kernel keymap key (the preset
    //    input rules fire on it), so this exercises the GATEWAY's own
    //    re-spelling on the bytes — a different route to the same contract.
    //    Driven on the SOFT-BREAK continuation line, which had no diagnostic at
    //    all before the fix.
    // =====================================================================
    await evaluate('window.__lineStartToasts = []')
    await clickAtTextNode(evaluate, send, 'soft二', 0)
    await pressChar(send, { key: ' ', code: 'Space', text: ' ' })
    // A SOFT break maps under BOTH line endings since the CRLF widening
    // (2026-08-21, character-map.js): the whole '\r\n' pair is one
    // `linebreak` unit, so the paragraph's visible count matches
    // ProseMirror's and the block pairs. The former CRLF branch asserted a
    // loud read-only refusal here — that limitation is fixed, so the CRLF
    // run now proves the same NBSP re-spelling the LF run always did.
    const SOFT = NBSP
    {
      assert.equal(
        await readSource(evaluate, 'space at a soft-break continuation line'),
        seen({ para: NB2, soft: NBSP }),
        'a Space at a continuation line start must commit ONE real no-break space'
      )
      const blocks = await blockTexts(evaluate)
      assert.ok(blocks.some((entry) => entry.includes(NBSP + 'soft二')),
        `the space must be VISIBLE on the continuation line — got ${JSON.stringify(blocks)}`)
    }
    await evaluate('window.__lineStartToasts = []')

    // =====================================================================
    // 3) A HARD-break continuation line — the shape whose two-space / backslash
    //    syntax must NOT be disturbed by the run written after it.
    // =====================================================================
    await clickAtTextNode(evaluate, send, 'hardB', 0)
    await pressChar(send, { key: 'Tab', code: 'Tab', text: '\t' })
    assert.equal(
      await readSource(evaluate, 'tab after a hard break'),
      seen({ para: NB2, soft: SOFT, hard: NB2 }),
      "a run after a hard break must not touch the break's own bytes"
    )

    // =====================================================================
    // 4) A BLOCKQUOTE paragraph's text start — the run lands AFTER the '> '
    //    marker, never in front of it.
    // =====================================================================
    await clickAtTextNode(evaluate, send, '引用段落。', 0)
    await pressChar(send, { key: 'Tab', code: 'Tab', text: '\t' })
    assert.equal(
      await readSource(evaluate, 'tab in a blockquote'),
      seen({ para: NB2, soft: SOFT, hard: NB2, quote: NB2 }),
      "a blockquote paragraph's run must land after the '> ' marker"
    )
    {
      const blocks = await blockTexts(evaluate)
      assert.ok(blocks.some((entry) => entry.startsWith('BLOCKQUOTE:' + NB2)),
        `the blockquote indent must be VISIBLE — got ${JSON.stringify(blocks)}`)
    }

    // =====================================================================
    // 5) A LIST ITEM. Space re-spells (its text start is a line start); Tab
    //    stays the INDENT gesture and is NOT turned into whitespace insertion.
    //    This is the boundary the fix deliberately did not move.
    // =====================================================================
    await clickAtTextNode(evaluate, send, '列表甲', 0)
    await pressChar(send, { key: ' ', code: 'Space', text: ' ' })
    assert.equal(
      await readSource(evaluate, 'space at a list item text start'),
      seen({ para: NB2, soft: SOFT, hard: NB2, quote: NB2, item: NBSP }),
      "a Space at a list item's text start must commit a real no-break space"
    )
    {
      // Tab on the SECOND item still INDENTS — structural, byte-different, and
      // nothing to do with whitespace insertion.
      const before = await readSource(evaluate, 'before the indent')
      await clickAtTextNode(evaluate, send, '列表乙', 0)
      await pressChar(send, { key: 'Tab', code: 'Tab', text: '\t' })
      const after = await readSource(evaluate, 'after the indent')
      assert.equal(after, before.replace('\n- 列表乙', '\n  - 列表乙'),
        'Tab in a list item must still indent the item, not insert whitespace')
      // …and undo it, so the saved bytes below stay the whitespace story.
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'z', code: 'KeyZ', modifiers: 4, windowsVirtualKeyCode: 90 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 4, windowsVirtualKeyCode: 90 })
      await sleep(400)
      assert.equal(await readSource(evaluate, 'after undoing the indent'), before,
        'the indent must undo cleanly')
    }

    // =====================================================================
    // 6) THE CONTROL: an ordinary interior space is still a LITERAL byte. The
    //    command tries the literal FIRST on every call, so nothing that already
    //    worked may change.
    // =====================================================================
    // Driven inside the BLOCKQUOTE (a multi-shape block that maps under both
    // line endings — as does the soft-break paragraph, since the widening).
    await clickAtTextNode(evaluate, send, '引用段落。', 2)
    await pressChar(send, { key: ' ', code: 'Space', text: ' ' })
    {
      const source = await readSource(evaluate, 'interior space')
      assert.ok(source.includes('引用 段落。'),
        `an interior space must stay an ordinary literal space — got ${JSON.stringify(source)}`)
      assert.ok(!source.includes('引用' + NBSP + '段落。'),
        'an interior space must NOT be re-spelled')
    }
    // Put it back so the saved bytes are exactly the whitespace story.
    await backspace(send)

    const expected = doc({ para: NB2, soft: SOFT, hard: NB2, quote: NB2, item: NBSP })
    assert.equal(await readSource(evaluate, 'final state'),
      seen({ para: NB2, soft: SOFT, hard: NB2, quote: NB2, item: NBSP }),
      'the document must be exactly the five written runs and nothing else')
    assert.equal(await toasts(evaluate), '[]',
      `no refusal may have fired anywhere in this script — got ${await toasts(evaluate)}`)

    // =====================================================================
    // 7) SAVE, then a COLD REOPEN. The bytes must reach the file and come back
    //    byte-identical — a re-spelled character that only lives in the session
    //    would pass every check above and still be lost.
    // =====================================================================
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'document never became dirty')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(1000)
    assert.equal(await evaluate(`!!document.querySelector('.hm-save-fab')`), false,
      `save did not settle (diagnostics: ${await diagnostics(evaluate)})`)
    assert.deepEqual(app.dialogs.map((dialog) => dialog.message), [],
      'line-start whitespace must never prompt for recovery')
    assert.equal(await readFile(file, 'utf8'), expected,
      "the saved file must hold exactly the five written runs, in the document's own line endings")

    await stopBuiltElectron(app, { removeProfile: false })
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile'), port, cleanProfile: false, appArgs: [file]
    })
    ;({ evaluate, send } = app)
    await waitFor(() => evaluate(`!!(${VISIBLE_EDITOR})`), 'editor did not mount after the cold reopen')
    await sleep(600)
    assert.equal(await readFile(file, 'utf8'), expected,
      'the cold reopen must not rewrite a single byte')
    {
      const blocks = await blockTexts(evaluate)
      assert.ok(blocks.includes('P:' + NB2 + '段落甲行首。'),
        `the indent must still be visible after a cold reopen — got ${JSON.stringify(blocks)}`)
      assert.ok(blocks.some((entry) => entry.startsWith('BLOCKQUOTE:' + NB2)),
        `the blockquote indent must survive the cold reopen — got ${JSON.stringify(blocks)}`)
    }

    console.log(`PASS kernel-mode line-start whitespace UI regression (${EOL === '\r\n' ? 'CRLF' : 'LF'}): Tab and Space at a paragraph / continuation / hard-break / blockquote / list-item line start commit real no-break spaces, stay visible and caret-addressable, delete one at a time, keep list indentation structural, and survive a save + cold reopen`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
