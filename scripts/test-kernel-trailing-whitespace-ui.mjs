// Kernel-mode block-TRAILING whitespace regression, driven through the real
// built app over CDP.
//
// THE DEFECT. Measured on the built app in kernel mode (probe, 2026-08-18,
// after the heading-LEADING whitespace fix, so it neither caused nor cured it):
// typing `a`, ` `, `b` at the end of the paragraph `末段。` produced
//
//     source  末段。ab        view  末段。ab
//
// The space is stripped by CommonMark at a block's end, so the byte was dead the
// moment it was written; the kernel's projection check then repaired the view
// back to the character-less bytes, and the `b` mapped to the block's content
// end — i.e. IN FRONT of the stranded space. The file did not contain what the
// user typed and the screen showed something different again.
//
// Because prose is composed left to right, the caret is at a block end for
// essentially every inter-word space. This is ordinary typing.
//
// WHAT IS WRITTEN. A real U+00A0 (the one whitespace character CommonMark does
// not strip at a block end), raw in the source — never `&nbsp;`: the user
// rejected markup in source mode («源码模式里，不接受这个写法»). It heals back to
// an ordinary space in the same edit as the character that displaces it.
//
// The headless suites prove the command
// (scripts/test-source-kernel-trailing-whitespace.mjs) and the gateway wiring
// (scripts/test-kernel-gateway.mjs §T). Neither can prove what this script
// proves: that a REAL keystroke produces the bytes, that the character is
// PAINTED (存下来并且能被看到), that it is caret-addressable and deletable, and
// that the bytes reach the FILE through a real save.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-trailing-ws-${process.pid}`
const file = join(root, 'trailing.md')
const port = Number(process.env.CDP_PORT || 10049)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)
const NBSP = '\u00A0'

// One paragraph to type into, one heading (the same shape at a different block
// type), and one fenced code block whose trailing space is CONTENT and must
// survive byte-for-byte.
const FIXTURE = [
  '# 标题',
  '',
  '末段。',
  '',
  '## 乙',
  '',
  '```js',
  'let a = 1',
  '```',
  ''
].join('\n')

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

async function charRect(evaluate, blockText, from, to) {
  return evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p, h1, h2, h3, h4, h5, h6') || [])]
      .find((n) => n.textContent === ${JSON.stringify(blockText)})
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    let count = 0
    let startNode = null, startOffset = 0, endNode = null, endOffset = 0
    let n
    while ((n = walker.nextNode())) {
      const len = n.textContent.length
      if (startNode === null && count + len >= ${from}) { startNode = n; startOffset = ${from} - count }
      if (endNode === null && count + len >= ${to}) { endNode = n; endOffset = ${to} - count }
      count += len
      if (startNode && endNode) break
    }
    if (!startNode || !endNode) return null
    const range = document.createRange()
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset)
    const rect = range.getBoundingClientRect()
    return rect ? { left: rect.left, right: rect.right, top: rect.top, height: rect.height } : null
  })()`)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

// A raw DOM selection does NOT sync ProseMirror state — every caret placement
// here is a real mouse click, per this repo's CDP convention.
async function clickAt(evaluate, send, blockText, offset) {
  const rect = await waitFor(() => charRect(evaluate, blockText, offset, offset),
    `could not locate caret offset ${offset} in ${JSON.stringify(blockText)}`)
  await click(send, { x: rect.left, y: rect.top + Math.min(12, rect.height / 2) })
  await sleep(200)
}

// The "被看到" half: how wide does the block's TRAILING whitespace run actually
// paint? ProseMirror ships `white-space: break-spaces` on `.ProseMirror`, which
// preserves a trailing space and gives it real width — measured here rather than
// trusted, because the whole defect was a character nobody could see.
async function trailingRunGeometry(evaluate, blockText) {
  return evaluate(`(() => {
    const node = [...((${VISIBLE_EDITOR})?.querySelectorAll('p, h1, h2, h3, h4, h5, h6') || [])]
      .find((n) => n.offsetParent && n.textContent === ${JSON.stringify(blockText)})
    if (!node) return null
    const style = getComputedStyle(node)
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    let last = null
    let n
    while ((n = walker.nextNode())) last = n
    if (!last) return null
    const value = last.textContent
    let run = 0
    while (run < value.length && /\\s/.test(value[value.length - 1 - run])) run += 1
    if (!run) return { whiteSpace: style.whiteSpace, runLength: 0, runWidth: 0 }
    const range = document.createRange()
    range.setStart(last, value.length - run)
    range.setEnd(last, value.length)
    return {
      whiteSpace: style.whiteSpace,
      runLength: run,
      runWidth: range.getBoundingClientRect().width
    }
  })()`)
}

// A real SPACE keystroke. `pressKey` sends `rawKeyDown`, which delivers the key
// to the keymaps but never produces a character — fine for Tab/Backspace and for
// the heading fixture (where the kernel's Space keymap SWALLOWS the key), but
// here the character must actually be inserted, so this uses `keyDown` + `text`,
// which is what Chromium turns into a real text insertion.
async function pressSpace(send) {
  const common = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ' ', unmodifiedText: ' ', ...common })
  await sleep(12)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(12)
}

const blockTexts = (evaluate) => evaluate(`JSON.stringify(
  [...((${VISIBLE_EDITOR})?.children || [])].map((n) => n.tagName + ':' + n.textContent)
)`)

const diagnostics = (evaluate) => evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)

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
    await evaluate('window.__hmKernelDiagnostics = []')

    // =====================================================================
    // 1) THE REPORTED SEQUENCE, one real keystroke at a time, at the very end
    //    of a paragraph. `a`, then a real Space KEYDOWN, then `b`.
    // =====================================================================
    await clickAt(evaluate, send, '末段。', 3)
    await typeTextLikeUser(send, 'a', { delayMs: delay })
    await sleep(300)
    await pressSpace(send)
    await sleep(400)

    // 1a) The intermediate state: the space is on disk in a form that survives,
    //     and it is VISIBLE.
    assert.equal(
      await readSource(evaluate, 'space at a paragraph end'),
      FIXTURE.replace('末段。', '末段。a' + NBSP),
      'a space typed at a block end must be committed in a form the reparse keeps'
    )
    assert.ok(
      JSON.parse(await blockTexts(evaluate)).includes('P:末段。a' + NBSP),
      `the space must be present in the projected paragraph — got ${await blockTexts(evaluate)}`
    )
    {
      const geometry = await trailingRunGeometry(evaluate, '末段。a' + NBSP)
      assert.ok(geometry, 'could not measure the paragraph geometry')
      assert.equal(geometry.runLength, 1, 'the paragraph must end with exactly one whitespace character')
      assert.ok(geometry.runWidth > 1,
        `the trailing space must PAINT, not collapse — measured ${JSON.stringify(geometry)}`)
    }

    // 1b) The next character resolves it: the file must hold ORDINARY bytes.
    await typeTextLikeUser(send, 'b', { delayMs: delay })
    await sleep(400)
    assert.equal(
      await readSource(evaluate, 'character after the trailing space'),
      FIXTURE.replace('末段。', '末段。a b'),
      'typing `a b` must produce `a b` — not `ab `, and not a no-break space left behind'
    )
    assert.ok(
      JSON.parse(await blockTexts(evaluate)).includes('P:末段。a b'),
      `the view must show exactly what was typed — got ${await blockTexts(evaluate)}`
    )

    // =====================================================================
    // 2) A whole sentence typed at speed, spaces and all, through the
    //    no-keydown route (`Input.insertText` — autocorrect / accessibility /
    //    IME commit). The bytes must be route-independent and ordinary.
    // =====================================================================
    await typeTextLikeUser(send, ' hello world here', { delayMs: delay })
    await sleep(500)
    assert.equal(
      await readSource(evaluate, 'a whole sentence'),
      FIXTURE.replace('末段。', '末段。a b hello world here'),
      'an ordinary sentence must end up as ordinary bytes — no no-break space may remain mid-sentence'
    )

    // 2b) NOTHING RESEMBLING MARKUP may appear in the source view — the whole
    //     reason this spelling was chosen over a character reference.
    assert.ok(!/&[#a-zA-Z0-9]+;/.test(await readSource(evaluate, 'markup check')),
      'the source must hold whitespace characters, never a character reference')

    // =====================================================================
    // 3) ADDRESSABLE AND DELETABLE. Type one more space (leaving the entity
    //    spelling in place), then Backspace: the whole entity must go and the
    //    bytes must return exactly to the previous state.
    // =====================================================================
    const settled = FIXTURE.replace('末段。', '末段。a b hello world here')
    await pressSpace(send)
    await sleep(400)
    assert.equal(
      await readSource(evaluate, 'trailing space before backspace'),
      settled.replace('here', 'here' + NBSP),
      'the trailing space must again take the surviving spelling'
    )
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(400)
    assert.equal(
      await readSource(evaluate, 'backspace over the trailing entity'),
      settled,
      'one Backspace must delete the character, restoring the previous bytes'
    )

    // =====================================================================
    // 3b) TAB at a paragraph's END. This one arrives through the KEYMAP
    //     (`insertPlainTextAtSelection`), not through `commitPlainText`, and it
    //     used to write a literal '\t' — a byte CommonMark strips, so it sat on
    //     disk forever and the view never changed. Two no-break spaces now, the
    //     user's own proportion, and each one deletable on its own.
    // =====================================================================
    await pressKey(send, { key: 'Tab', code: 'Tab' })
    await sleep(400)
    assert.equal(
      await readSource(evaluate, 'tab at a paragraph end'),
      settled.replace('here', 'here' + NBSP + NBSP),
      'Tab at a paragraph end must write two real no-break spaces, never a literal tab'
    )
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(300)
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(400)
    assert.equal(
      await readSource(evaluate, 'backspace over the tab run'),
      settled,
      'each no-break space must delete on its own, restoring the previous bytes'
    )

    // =====================================================================
    // 4) A HEADING's end is the same shape (`## 乙` + ' ' + '丙').
    // =====================================================================
    await clickAt(evaluate, send, '乙', 1)
    await pressSpace(send)
    await sleep(400)
    assert.equal(
      await readSource(evaluate, 'space at a heading end'),
      settled.replace('## 乙', '## 乙' + NBSP),
      'a space at a heading end must survive too'
    )
    await typeTextLikeUser(send, '丙', { delayMs: delay })
    await sleep(400)
    const afterHeading = settled.replace('## 乙', '## 乙 丙')
    assert.equal(
      await readSource(evaluate, 'character after the heading space'),
      afterHeading,
      'the heading must end with the ordinary text the user typed'
    )

    // =====================================================================
    // 5) MUST NOT BREAK: a trailing space inside a FENCED CODE BLOCK is
    //    CONTENT. It stays a literal byte and is byte-preserved.
    // =====================================================================
    {
      const rect = await waitFor(() => evaluate(`(() => {
        const line = [...((${VISIBLE_EDITOR})?.querySelectorAll('.cm-line') || [])]
          .find((n) => n.offsetParent && n.textContent === 'let a = 1')
        if (!line) return null
        line.scrollIntoView({ block: 'center' })
        const rect = line.getBoundingClientRect()
        return { left: rect.right - 2, top: rect.top, height: rect.height }
      })()`), 'could not locate the code line')
      await click(send, { x: rect.left, y: rect.top + Math.min(8, rect.height / 2) })
      await sleep(300)
      await pressKey(send, { key: 'End', code: 'End' })
      await sleep(200)
      await pressSpace(send)
      await sleep(500)
      assert.equal(
        await readSource(evaluate, 'space inside a fence'),
        afterHeading.replace('let a = 1', 'let a = 1 '),
        'a trailing space inside a fenced block must stay a LITERAL byte, byte-preserved'
      )
    }

    // =====================================================================
    // 6) Save, and prove the bytes reached the FILE unchanged.
    // =====================================================================
    const expected = afterHeading.replace('let a = 1', 'let a = 1 ')
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'document never became dirty')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(1200)
    assert.equal(await evaluate(`!!document.querySelector('.hm-save-fab')`), false,
      `save did not settle (diagnostics: ${await diagnostics(evaluate)})`)
    assert.deepEqual(app.dialogs.map((dialog) => dialog.message), [],
      'trailing whitespace must never prompt for recovery')
    assert.equal(await readFile(file, 'utf8'), expected,
      'the saved file must be byte-identical to the kernel source view')
    assert.ok((await readFile(file, 'utf8')).includes('末段。a b hello world here'),
      'the sentence must reach disk as ordinary bytes')

    // =====================================================================
    // 7) THE OBSERVABILITY INVARIANT must have stayed silent for every one of
    //    the shapes above. `edit-unobservable` is the diagnostic that fires when
    //    a committed edit did NOT change what the bytes reparse to — the check
    //    whose absence let this whole defect family ship.
    // =====================================================================
    const seen = await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || [])
      .filter((entry) => entry && entry.type === 'edit-unobservable'))`)
    assert.equal(seen, '[]', `an edit was not observable in the reparse: ${seen}`)

    console.log('PASS kernel-mode block-trailing whitespace UI regression: a space typed at a block end is preserved AND visible, heals to ordinary bytes on the next character, and never touches a fenced block')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
