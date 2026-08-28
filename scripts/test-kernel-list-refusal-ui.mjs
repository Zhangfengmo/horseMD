// Kernel-mode REFUSAL MESSAGES around lists — the user's own report, verbatim:
//
//     「Tab 和无序列表的搭配使用等还有问题,会报错「只读」」
//
// 「只读」 is `kernelMode.blockReadOnly`, and it is the kernel's heaviest
// statement: THIS block's source could not be proven, so it is permanently
// uneditable for this revision — the user cannot type in it, cannot Enter out
// of it, cannot delete their way out. Saying that about a block whose source IS
// proven is worse than saying nothing: it tells the user their list is broken
// and offers no way back.
//
// Measured in the BUILT APP in kernel mode before the fix (2026-08-20, real
// mouse carets, real keydowns). Anchor a selection inside a bullet item, extend
// it into the block after the list, press Tab:
//
//   document                       message
//   -----------------------------  -------------------------------------------
//   bullet list -> paragraph       「此段落在内核模式下暂为只读…」   <- WRONG
//   blockquote  -> paragraph       「此段落在内核模式下暂为只读…」   <- WRONG
//   paragraph   -> paragraph       「…暂未支持此操作」               <- correct
//
// while the status line said, at that same instant, 「本文档中所有能落光标的块都
// 已与 Markdown 源码配对，均可正常编辑」. The recorded hits for the reported
// position were `bullet_list` and `list_item`; the paragraph the caret was in
// held a perfectly good charMap. Cause and fix: lib/kernel-status.js's header.
//
// THE CONTRACT this script pins, and why it needs the real app rather than the
// headless suite (scripts/test-kernel-mode-headless.mjs Case 16b, which pins
// the same rule against a hand-built document):
//   * the message a REAL gesture produces — the headless case constructs its
//     refusal from a hand-made transaction, and cannot prove that a real Tab on
//     a real cross-block selection still reaches that code path at all;
//   * the TOAST and the STATUS LINE agreeing, which is a two-surface claim no
//     unit test can make;
//   * that a refusal still refuses: zero bytes written, on disk and in view.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const root = `/tmp/horsemd-kernel-list-refusal-${process.pid}`
const file = join(root, 'list-refusal.md')
const port = Number(process.env.CDP_PORT || 10072)

const LINES = [
  '- 项甲一',
  '- 项甲二',
  '',
  '段乙一',
  '',
  '> 引丙一',
  '',
  '段丁一'
]
const FIXTURE = LINES.join('\n')

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

// Caret placement is a REAL mouse click per this repo's CDP convention (a raw
// DOM selection does not sync ProseMirror state), resolved per TEXT NODE.
async function caretRect(evaluate, needle, within) {
  return waitFor(() => evaluate(`(() => {
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
}

async function clickAt(send, rect, modifiers = 0) {
  const point = { x: rect.left + 0.5, y: rect.top + Math.min(12, rect.height / 2), modifiers }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await sleep(250)
}

// The gesture: click to place the caret, shift-click to extend the selection
// across the block boundary, then a real Tab keydown.
async function selectAcrossAndTab(evaluate, send, from, to) {
  // `notifyBlocked` rate-limits per CODE (NOTIFY_COOLDOWN_MS = 1500) so a held
  // key cannot strobe the toast. Every gesture here refuses with the SAME code,
  // so without clearing the window the second and third cases would assert on a
  // suppressed message and pass for the wrong reason.
  await sleep(1700)
  await clickAt(send, await caretRect(evaluate, from.needle, from.within))
  await clickAt(send, await caretRect(evaluate, to.needle, to.within), 8)
  const key = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
  await sleep(15)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  await sleep(450)
}

const toasts = (evaluate) => evaluate(`JSON.stringify(window.__listRefusalToasts || [])`)
const resetToasts = (evaluate) => evaluate(`(window.__listRefusalToasts = [], window.__hmKernelDiagnostics = [], 1)`)
const diagnostics = async (evaluate) =>
  JSON.parse(await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`))
// The persistent half of the same claim: the kernel status button's title. A
// healthy document says every block is paired; a document with N unprovable
// blocks says so and counts them.
const statusTitle = (evaluate) => evaluate(`(document.querySelector('.block-switch-caret-btn')?.title ?? '')`)

const READ_ONLY = /只读|read-only/
// The generic refusal, whose whole point is that it is a statement about the
// OPERATION (it was blocked), not about the block. `notifyBlocked` appends the
// kernel code in parentheses, which is what makes it recognizable here.
// 2026-08-28: the string moved from `kernelMode.unsupported` ("not supported
// yet in the EXPERIMENTAL kernel" — stale since the kernel became the default,
// and it read as a missing feature) to `kernelMode.blockedGeneric`.
const GENERIC = /无效操作|Invalid operation|blocked this edit/

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
      window.__listRefusalToasts = []
      window.addEventListener('hm:toast', (e) => window.__listRefusalToasts.push(e.detail?.msg ?? String(e.detail)))
      window.__hmKernelDiagnostics = []
    `)

    // =====================================================================
    // 0) THE PREMISE. Every block of this document is provable, and the
    //    status line says so. Without this the whole script would be
    //    asserting the absence of a message that was never due.
    // =====================================================================
    const baseline = await statusTitle(evaluate)
    assert.ok(!READ_ONLY.test(baseline),
      `the fixture must be fully provable before any gesture — status said: ${baseline}`)

    // =====================================================================
    // 1) THE REPORTED GESTURE. A selection anchored inside a bullet item,
    //    extended past the list, then Tab. The operation is genuinely
    //    unsupported and MUST refuse — the defect was never the refusal, it
    //    was the refusal describing itself as a permanently unprovable block.
    // =====================================================================
    await resetToasts(evaluate)
    await selectAcrossAndTab(evaluate, send,
      { needle: '项甲一', within: 0 }, { needle: '段乙一', within: 1 })
    {
      const fired = JSON.parse(await toasts(evaluate))
      assert.equal(fired.length, 1, `the refusal must be surfaced exactly once — got ${JSON.stringify(fired)}`)
      assert.ok(!READ_ONLY.test(fired[0]),
        `a refusal inside a PROVEN bullet list must not claim the block is read-only — got ${JSON.stringify(fired[0])}`)
      assert.ok(GENERIC.test(fired[0]),
        `it must be the generic operation-scoped message — got ${JSON.stringify(fired[0])}`)
      const diag = await diagnostics(evaluate)
      assert.equal(diag.filter((entry) => entry.type === 'block-read-only').length, 0,
        `and must record no block-read-only diagnostic — got ${JSON.stringify(diag)}`)
    }
    // 1a) THE TWO SURFACES AGREE. The status line still reports a healthy
    //     document — before the fix it said exactly this while the toast said
    //     the opposite.
    assert.ok(!READ_ONLY.test(await statusTitle(evaluate)),
      'the status line must still report a fully paired document')
    // 1b) A REFUSAL REFUSES. No bytes, in the view or on disk.
    assert.equal(await readSource(evaluate, 'after the list refusal'), FIXTURE,
      'the refused Tab must write no bytes at all')

    // =====================================================================
    // 2) THE SAME SHAPE ONE CONTAINER OVER. The defect is about CONTAINERS,
    //    not about lists: a blockquote reproduced it identically, and a
    //    list-only regression would let the next container reintroduce it.
    // =====================================================================
    await resetToasts(evaluate)
    await selectAcrossAndTab(evaluate, send,
      { needle: '引丙一', within: 0 }, { needle: '段丁一', within: 1 })
    {
      const fired = JSON.parse(await toasts(evaluate))
      assert.equal(fired.length, 1, `the blockquote refusal must be surfaced once — got ${JSON.stringify(fired)}`)
      assert.ok(!READ_ONLY.test(fired[0]),
        `a refusal inside a PROVEN blockquote must not claim it is read-only — got ${JSON.stringify(fired[0])}`)
      assert.ok(GENERIC.test(fired[0]),
        `it must be the generic operation-scoped message — got ${JSON.stringify(fired[0])}`)
    }

    // =====================================================================
    // 3) THE CONTROL THAT ALREADY PASSED. The identical gesture between two
    //    plain paragraphs — no container to blame — always produced the
    //    generic message, which is why the defect survived every existing
    //    suite. Pinned so the fix is not mistaken for "never say read-only".
    // =====================================================================
    await resetToasts(evaluate)
    await selectAcrossAndTab(evaluate, send,
      { needle: '段乙一', within: 0 }, { needle: '段丁一', within: 1 })
    {
      const fired = JSON.parse(await toasts(evaluate))
      assert.equal(fired.length, 1, `the paragraph refusal must be surfaced once — got ${JSON.stringify(fired)}`)
      assert.ok(GENERIC.test(fired[0]) && !READ_ONLY.test(fired[0]),
        `the paragraph control must keep its generic message — got ${JSON.stringify(fired[0])}`)
    }

    // =====================================================================
    // 4) THE LIST IS STILL FULLY WRITABLE AFTER ALL THOSE REFUSALS — Tab on
    //    the second item still INDENTS, byte-exactly. A "fix" that made the
    //    kernel quieter by making the list read-only for real would pass
    //    every assertion above and fail this one.
    // =====================================================================
    await sleep(1700)
    await resetToasts(evaluate)
    // Two clicks: the first collapses the multi-block selection step 3 left
    // behind, the second places the caret with that selection already gone. One
    // click was measured to leave ProseMirror mid-transition, so the Tab landed
    // on a selection that was still cross-block.
    await clickAt(send, await caretRect(evaluate, '项甲二', 0))
    await clickAt(send, await caretRect(evaluate, '项甲二', 0))
    await sleep(300)
    await resetToasts(evaluate)
    {
      const key = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
      await sleep(15)
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
      await sleep(450)
    }
    assert.equal(await toasts(evaluate), '[]', 'indenting the second item must not refuse at all')
    const indented = FIXTURE.replace('- 项甲二', '  - 项甲二')
    assert.equal(await readSource(evaluate, 'after the indent'), indented,
      'Tab on the second bullet item must indent it, byte-exactly')

    // 4a) ...and it survives a real save + a cold read of the file.
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((n) => /保存|Save/.test(n.title || n.textContent || ''))
      button?.click()
    })()`)
    await waitFor(async () => (await readFile(file, 'utf8')) === indented,
      'the indented list must reach disk unchanged')

    console.log('PASS kernel list refusal: a refusal inside a proven list/blockquote keeps the generic message, the status line agrees, and the list still indents')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
