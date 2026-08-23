// Kernel-mode TAB IN AN ORDERED LIST — a user report with both refusal toasts
// on screen (2026-08-22).
//
// BEFORE: an ordered list `1. 23123 / 2. 委屈委屈 / 3. ewqeqw`, caret at the end
// of item 3; Enter creates an empty `4. `.
// GESTURE 1: Tab in the empty item → refused, with the message that names the
//            remedy (type first). That refusal is CommonMark-forced: even a
//            `1.` marker cannot interrupt a paragraph while the item is empty.
// GESTURE 2 (the actual bug): type text, Tab again. This used to refuse too
//            ("would restructure the document"), contradicting the first
//            toast's advice — `   4. x` is swallowed as a lazy continuation of
//            item 3's paragraph because only a list starting at 1 can
//            interrupt a paragraph. The fix renumbers the demoted item's own
//            marker to `1.` (the Typora gesture), so the same Tab now nests.
//
// The headless suite (scripts/test-source-kernel-indent.mjs) proves the bytes
// and the refusal codes. Only a real session proves the plumbing: a real Tab
// keydown, the toast the user reads, the rendered nesting, and the save.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-indent-ordered-${process.pid}`
const file = join(root, 'ordered.md')
const port = Number(process.env.CDP_PORT || 10079)
const NBSP = '\u00A0'
const EOL = process.env.KERNEL_INDENT_CRLF ? '\r\n' : '\n'

const FIXTURE = ['1. 23123', '2. 委屈委屈', '3. ewqeqw'].join(EOL)

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
    // 1) Enter at the end of item 3 → an empty `4. ` holding the caret.
    // =====================================================================
    await clickAtTextNode(evaluate, send, 'ewqeqw', 6)
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(450)
    const beforeTab = await readSource(evaluate, 'before tab')
    assert.ok(beforeTab.endsWith('4. '), `the fourth item must be empty — got ${JSON.stringify(beforeTab)}`)

    // =====================================================================
    // 2) SCREENSHOT 1 — SEED-RESCUED since 2026-08-22 (this section used to
    //    pin the refusal): Tab in the empty `4. ` renumbers it to `1.`, nests
    //    it, and writes the ledgered U+00A0 seed — no toast at all.
    // =====================================================================
    await resetToasts(evaluate)
    await pressTab(send)
    assert.equal(await toasts(evaluate), '[]',
      `the seed-rescued empty ordered Tab must not refuse — got ${await toasts(evaluate)}`)
    assert.ok((await readSource(evaluate, 'after empty tab')).endsWith('   1. ' + NBSP),
      'the empty item must be nested, renumbered to 1., and seeded')

    // =====================================================================
    // 3) The seed DISSOLVES under the typed label — already nested, no
    //    second Tab needed (the same pipeline the /task seed uses).
    // =====================================================================
    await resetToasts(evaluate)
    await typeText(send, '2313')
    assert.equal(await toasts(evaluate), '[]',
      `typing into the seeded item must not refuse — got ${await toasts(evaluate)}`)
    {
      // NB: the source textarea displays LF regardless of the document's
      // authored EOL — the CRLF fact is asserted against DISK bytes in step 5.
      const source = await readSource(evaluate, 'after remedy')
      assert.ok(source.includes('\n   1. 2313'),
        `the item must be nested AND renumbered to 1. — got ${JSON.stringify(source)}`)
      assert.ok(!source.includes('   4. 2313'),
        `the un-renumbered marker must not be written — got ${JSON.stringify(source)}`)
      const tags = await renderedTags(evaluate)
      assert.ok(!tags.some((t) => /^H[1-6]$/.test(t)),
        `no heading may appear — got ${JSON.stringify(tags)}`)
      assert.equal(tags.filter((t) => t === 'LI').length, 4,
        `all four items must still render as list items — got ${JSON.stringify(tags)}`)
    }

    // =====================================================================
    // 4) Shift-Tab back out must not refuse either; the item rejoins the
    //    outer list. Since the outdent-side ORDERED-MARKER RENUMBER
    //    (2026-08-23, commands/indent.js) it continues the destination
    //    list's count — parent `3.` + 1 = `4.`, which here is exactly the
    //    author's original marker. (This pin used to accept the stale `1.`;
    //    flipped deliberately with the renumber landing.)
    // =====================================================================
    await resetToasts(evaluate)
    await pressTab(send, true)
    assert.equal(await toasts(evaluate), '[]',
      `outdent must not refuse — got ${await toasts(evaluate)}`)
    assert.ok((await readSource(evaluate, 'after outdent')).includes('\n4. 2313'),
      'the item must be back at the top level, renumbered to continue the outer list')

    // =====================================================================
    // 5) Re-nest and SAVE — the renumbered bytes reach disk, CRLF stays CRLF.
    // =====================================================================
    await pressTab(send)
    await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((n) => /保存|Save/.test(n.title || n.textContent || ''))
      b?.click()
    })()`)
    const onDisk = await waitFor(async () => {
      const text = await readFile(file, 'utf8')
      return text.includes('   1. 2313') ? text : null
    }, 'the nested, renumbered item must reach disk')
    assert.ok(!/^#/m.test(onDisk), 'no heading was ever written')
    if (EOL === '\r\n') {
      assert.ok(onDisk.includes('\r\n'), 'a CRLF document must stay CRLF')
      assert.ok(!/[^\r]\n/.test(onDisk), 'no bare LF may be introduced into a CRLF document')
    }

    console.log('PASS kernel indent ordered: the empty-item Tab nests it renumbered to 1. with the ledgered U+00A0 seed, the typed label dissolves the seed in place, Shift-Tab returns it, and the renumbered bytes reach disk')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
