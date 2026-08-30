// Kernel-mode BACKSPACE / DELETE at the document's trailing empty paragraph —
// the user's report, with a screenshot: the caret sits in the empty paragraph at
// the very END of the document (the one showing the
// 「输入 / 唤起命令，或开始写…」 placeholder), immediately after an ordered list, and
// Backspace raises 「源码权威内核实验阶段暂未支持此操作 (unsupported-input-type)」.
//
// WHICH BLOCK IS THAT? Measured in the built app, and it is never a real one:
// a trailing blank line produces NO BLOCK in CommonMark, so the only two things
// that can put an empty paragraph there are `@milkdown/plugin-trailing`'s
// synthetic node (the document's last child is a list, so it appends one) and a
// controller-vouched split placeholder. Verified: a document ending
// '...213123\n\n' renders exactly the same three blocks as one ending
// '...213123'.
//
// So neither key has anything to delete, and both used to reach ProseMirror's
// own join/lift commands, whose node-bearing transaction the gateway refuses —
// a toast for a gesture whose correct answer writes no bytes at all. Measured
// before the fix, on the fixture below:
//
//   gesture                                        before
//   ---------------------------------------------  ------------------------------
//   Backspace in the trailing empty paragraph      unsupported-input-type, caret stuck
//   Delete at the end of the last list item        unsupported-input-type
//   Enter at a document-ending paragraph, then     unsupported-input-type — the user
//     Backspace (the create-then-remove round trip)  could not undo their own Enter
//
// The headless suites prove the BYTES
// (scripts/test-source-kernel-trailing-placeholder.mjs) and the controller
// decision (scripts/test-kernel-mode-headless.mjs). Only a real session can
// prove what this script asserts: that a real Backspace keydown reaches the new
// route ahead of ProseMirror's own commands, that the caret actually lands in
// the previous block so the next character goes where the user is looking, and
// that the document is not dirtied by a keystroke that moved a caret.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-trailing-backspace-${process.pid}`
const file = join(root, 'trailing.md')
const port = Number(process.env.CDP_PORT || 10075)
const EOL = process.env.KERNEL_TRAILING_CRLF ? '\r\n' : '\n'
// KERNEL_TRAILING_ATOM=1: the hr-ending document (wf-gateway, 2026-08-20).
// After an ATOM the click that spawns the placeholder leaves a NodeSelection
// ON the atom (no textblock for Selection.near to land in — the list fixture
// above always offers one), so typing used to dispatch prosemirror-view's
// insertText-over-NodeSelection fallback, which the gateway refused with
// unsupported-input-type: every keystroke swallowed, zero bytes. The fixed
// route commits the placeholder's own bytes instead (atom intact, text below).
const ATOM = !!process.env.KERNEL_TRAILING_ATOM

// The reported shape: prose, then an ordered list as the document's LAST block,
// which is exactly what makes plugin-trailing append its paragraph.
const LINES = ['前言一', '', '1. 牛逼', '2. 213123']
const FIXTURE = ATOM ? '甲一\n\n---' : LINES.join(EOL)

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

// A textarea's `.value` normalizes every line ending to LF, so on a CRLF
// document the view and the file legitimately differ in exactly that way.
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

async function clickPoint(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await sleep(250)
}

// The trailing placeholder holds no text, so it cannot be found by text search —
// it is addressed as the editor's LAST child, which is also how the user reaches
// it (a click on the empty line below the content).
async function clickTrailingPlaceholder(evaluate, send) {
  const rect = await waitFor(() => evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    if (!editor) return null
    const last = editor.children[editor.children.length - 1]
    if (!last || last.tagName !== 'P' || last.textContent !== '') return null
    last.scrollIntoView({ block: 'center' })
    const b = last.getBoundingClientRect()
    return { left: b.left, top: b.top, height: b.height }
  })()`), 'the document did not grow a trailing empty paragraph')
  await clickPoint(send, { x: rect.left + 6, y: rect.top + Math.min(10, rect.height / 2) })
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
  await clickPoint(send, { x: rect.left + 0.5, y: rect.top + Math.min(12, rect.height / 2) })
}

async function typeText(send, text) {
  for (const ch of text) {
    const code = /^[a-zA-Z]$/.test(ch) ? 'Key' + ch.toUpperCase() : 'Unidentified'
    const vk = /^[A-Za-z0-9]$/.test(ch) ? ch.toUpperCase().charCodeAt(0) : 0
    const common = { key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, text: ch })
    await sleep(15)
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    await sleep(420)
  }
}

// Where ProseMirror's caret sits, as (nearest block text, offset) — the
// assertion the gesture is actually about.
const caretAt = (evaluate) => evaluate(`(() => {
  const s = document.getSelection()
  if (!s || !s.anchorNode) return 'none'
  const b = s.anchorNode.nodeType === 3 ? s.anchorNode.parentElement : s.anchorNode
  return JSON.stringify({ text: b?.textContent ?? null, offset: s.anchorOffset })
})()`)

const toasts = (evaluate) => evaluate(`JSON.stringify(window.__tbToasts || [])`)
const resetToasts = (evaluate) => evaluate(`(window.__tbToasts = [], 1)`)
const isDirty = (evaluate) => evaluate(`!!document.querySelector('.tab.active .tab-dot, .tab.active .dirty, .status-dirty')`)

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
      window.__tbToasts = []
      window.addEventListener('hm:toast', (e) => window.__tbToasts.push(e.detail?.msg ?? String(e.detail)))
    `)

    if (ATOM) {
      // ===================================================================
      // THE ATOM VARIANT (hr-ending document). The gesture the handoff
      // report §1 measured as refused: click the document-ending hr — the
      // placeholder appears on that very batch, but the SELECTION stays a
      // NodeSelection on the hr — then type. Pre-fix: a toast per keystroke,
      // zero bytes. Post-fix: the hr stays, the text lands below it as a new
      // paragraph, byte-identical to typing inside the placeholder.
      // ===================================================================
      {
        const blocks = JSON.parse(await evaluate(`JSON.stringify(
          [...((${VISIBLE_EDITOR})?.children || [])].map((n) => n.tagName)
        )`))
        // FLIPPED 2026-08-30: a document ending in a non-textblock now mounts
        // WITH the trailing convenience paragraph (Editor.jsx appends it at
        // create — before, a trailing table/hr had no line below until the
        // first edit and could not be reached or selected from underneath:
        // 「整个表格无法删除」). The gesture under test — click ON the hr,
        // type — is unchanged.
        assert.deepEqual(blocks, ['P', 'HR', 'P'],
          `the fixture must render prose + hr + the initial trailing line — got ${JSON.stringify(blocks)}`)
      }
      await resetToasts(evaluate)
      // Click ON the hr (its own element box — the blank area BELOW the last
      // block takes the app's own caret-at-end path and is not this gesture).
      {
        const pt = JSON.parse(await evaluate(`(() => {
          const hr = (${VISIBLE_EDITOR})?.querySelector('hr')
          if (!hr) return null
          hr.scrollIntoView({ block: 'center' })
          const b = hr.getBoundingClientRect()
          return JSON.stringify({ x: b.left + b.width / 2, y: b.top + b.height / 2 })
        })()`))
        assert.ok(pt, 'the hr element must exist')
        await clickPoint(send, pt)
      }
      // The click spawned the placeholder AND left the hr node-selected —
      // the exact pre-typing state of the report.
      {
        const state = JSON.parse(await evaluate(`JSON.stringify({
          blocks: [...((${VISIBLE_EDITOR})?.children || [])].map((n) => n.tagName),
          selectedNode: document.querySelector('.ProseMirror-selectednode')?.tagName || null
        })`))
        assert.deepEqual(state.blocks, ['P', 'HR', 'P'],
          `the click must spawn the trailing placeholder — got ${JSON.stringify(state.blocks)}`)
        assert.equal(state.selectedNode, 'HR',
          'the click must leave the hr node-selected (the refused state)')
      }
      // THE KEYSTROKE. Must not refuse, must not delete the hr, must land
      // the character in a new paragraph below it with the caret after it.
      await typeText(send, 'X')
      assert.equal(await toasts(evaluate), '[]',
        `typing over the node-selected trailing hr must not refuse — got ${await toasts(evaluate)}`)
      {
        const state = JSON.parse(await evaluate(`JSON.stringify(
          [...((${VISIBLE_EDITOR})?.children || [])].map((n) => n.tagName + ':' + n.textContent)
        )`))
        assert.deepEqual(state, ['P:甲一', 'HR:', 'P:X'],
          `the hr must stay and the text must land below it — got ${JSON.stringify(state)}`)
      }
      {
        const caret = JSON.parse(await caretAt(evaluate))
        assert.equal(caret.text, 'X', `the caret must sit in the new paragraph — got ${JSON.stringify(caret)}`)
        assert.equal(caret.offset, 1, 'and right after the typed character')
      }
      // Continuation typing flows through the ordinary plain-text path.
      await typeText(send, 'Y')
      assert.equal(await toasts(evaluate), '[]', 'the next character must not refuse either')
      assert.equal(await readSource(evaluate, 'atom source'), '甲一\n\n---\n\nXY',
        'the committed source: the placeholder\'s own bytes — hr intact, blank-line separator, then the text')
      // And it all survives a real save.
      await evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find((n) => /保存|Save/.test(n.title || n.textContent || ''))
        b?.click()
      })()`)
      const onDisk = await waitFor(async () => {
        const text = await readFile(file, 'utf8')
        return text.includes('XY') ? text : null
      }, 'the atom-variant edits must reach disk')
      assert.ok(onDisk.includes('---'), 'the divider must survive the save')
      console.log('PASS kernel trailing atom typing (UI): clicking the document-ending hr and typing keeps the divider and commits the text below it — no refusal, bytes on disk')
      return
    }

    // =====================================================================
    // 0) THE PREMISE. The document really does grow a trailing empty
    //    paragraph that no byte accounts for — three rendered blocks over a
    //    source that has two.
    // =====================================================================
    {
      const blocks = JSON.parse(await evaluate(`JSON.stringify(
        [...((${VISIBLE_EDITOR})?.children || [])].map((n) => n.tagName)
      )`))
      assert.deepEqual(blocks, ['P', 'OL', 'P'],
        `the fixture must render prose + list + the trailing placeholder — got ${JSON.stringify(blocks)}`)
      assert.equal(await readSource(evaluate, 'premise'), FIXTURE.replace(/\r\n/g, '\n'),
        'and the source must hold no trailing blank line at all')
    }

    // =====================================================================
    // 1) THE REPORTED GESTURE: Backspace in that paragraph.
    // =====================================================================
    await resetToasts(evaluate)
    await clickTrailingPlaceholder(evaluate, send)
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(450)
    assert.equal(await toasts(evaluate), '[]',
      `Backspace on an empty trailing line must not refuse — got ${await toasts(evaluate)}`)
    // 1a) THE CARET MOVED to the end of the previous block's content — the last
    //     list item — which is the whole point of the gesture.
    {
      const caret = JSON.parse(await caretAt(evaluate))
      assert.equal(caret.text, '213123', `the caret must land in the last list item — got ${JSON.stringify(caret)}`)
      assert.equal(caret.offset, 6, 'and at its END, not its start')
    }
    // 1b) ZERO BYTES. The placeholder owns none, so a keystroke that only moved
    //     a caret must not have written any.
    assert.equal(await readSource(evaluate, 'after backspace'), FIXTURE.replace(/\r\n/g, '\n'),
      'a caret move must write no bytes')
    // 1c) ...and the next character lands where the user is looking.
    await typeText(send, 'X')
    assert.ok((await readSource(evaluate, 'after typing')).includes('2. 213123X'),
      'the character after the Backspace must land at the end of the last item')

    // =====================================================================
    // 2) THE MIRROR GESTURE: forward Delete at the end of the last block,
    //    with only the placeholder after it. There is nothing to delete, so
    //    the key is consumed silently — a toast here is noise at the very end
    //    of a document.
    // =====================================================================
    await resetToasts(evaluate)
    const beforeDelete = await readSource(evaluate, 'before delete')
    await clickAtTextNode(evaluate, send, '213123X', 7)
    await pressKey(send, { key: 'Delete', code: 'Delete' })
    await sleep(450)
    assert.equal(await toasts(evaluate), '[]',
      `Delete at the end of the document must not refuse — got ${await toasts(evaluate)}`)
    assert.equal(await readSource(evaluate, 'after delete'), beforeDelete,
      'and must write no bytes')

    // =====================================================================
    // 3) THE CREATE-THEN-REMOVE ROUND TRIP, driven where the report lives:
    //    inside the trailing placeholder itself. Enter there splits the last
    //    list item (the caret's raw anchor is the list's end), the first
    //    Backspace exits that empty item, and the second is the gesture from
    //    step 1 again — so the whole trip must complete without one refusal.
    //
    //    The BYTE half of the round trip (an Enter at a document-ending
    //    PARAGRAPH writes a blank line, and Backspace reclaims it) is proven
    //    byte-for-byte in scripts/test-source-kernel-trailing-placeholder.mjs;
    //    it is not driven here because reaching it from this fixture would go
    //    through a MID-document placeholder, which is a separate, still-open
    //    gap this script deliberately does not stand on.
    // =====================================================================
    await resetToasts(evaluate)
    const beforeTrip = await readSource(evaluate, 'before round trip')
    await clickTrailingPlaceholder(evaluate, send)
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(450)
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(450)
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(450)
    assert.equal(await toasts(evaluate), '[]',
      `the create-then-remove round trip must not refuse once — got ${await toasts(evaluate)}`)
    {
      const caret = JSON.parse(await caretAt(evaluate))
      assert.equal(caret.text, '213123X',
        `the caret must end up back in the last list item — got ${JSON.stringify(caret)}`)
    }
    // The list item the Enter created is gone again; only a conventional
    // single trailing newline may remain (this family never trims that).
    {
      const after = await readSource(evaluate, 'after round trip')
      assert.equal(after.replace(/\n+$/, ''), beforeTrip.replace(/\n+$/, ''),
        `the round trip must leave the content exactly as it was — got ${JSON.stringify(after)}`)
      assert.ok(!/3\. /.test(after), 'the transient third list item must be gone')
    }

    // =====================================================================
    // 4) EVERYTHING SURVIVES A REAL SAVE, and a CRLF document stays CRLF.
    // =====================================================================
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((n) => /保存|Save/.test(n.title || n.textContent || ''))
      b?.click()
    })()`)
    const onDisk = await waitFor(async () => {
      const text = await readFile(file, 'utf8')
      return text.includes('213123X') ? text : null
    }, 'the edits must reach disk')
    if (EOL === '\r\n') {
      assert.ok(onDisk.includes('\r\n'), 'a CRLF document must stay CRLF')
      assert.ok(!/[^\r]\n/.test(onDisk), 'no bare LF may be introduced into a CRLF document')
    }

    console.log('PASS kernel trailing backspace: Backspace in the trailing placeholder moves the caret and writes nothing, Delete at the document end is a silent no-op, and an Enter round trip reclaims its own bytes')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
