// Kernel-mode heading demote (Backspace/Delete at a heading's content start)
// end-to-end UI regression — the 2026-08-22 user report: an EMPTY H1 at the
// document end could not be deleted at all (the gesture only raised the named
// refusal toast).
//
// The headless suite (scripts/test-source-kernel-blocktype.mjs section 9)
// proves the COMMAND. What it cannot prove is the live wiring: the structural
// keymap's not-structural fall-through into commitHeadingDemote, the
// placeholder session the empty-H1 delegation rides, kernel history, and the
// real keystrokes. Every expected string below is the literal output of the
// kernel command chain, not a guess.
//
// CRLF variant: `KERNEL_DEMOTE_CRLF=1`. A textarea's `.value` normalizes line
// breaks to LF, so only the disk bytes at the end can pin a CRLF document.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const crlf = process.env.KERNEL_DEMOTE_CRLF === '1'
const EOL = crlf ? '\r\n' : '\n'
const root = `/tmp/horsemd-kernel-heading-demote-${process.pid}`
const file = join(root, 'demote.md')
const port = Number(process.env.CDP_PORT || 10094)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

const LINES = [
  '## 二级标题',
  '',
  '# 大标题甲',
  '',
  // The named refusal: without its `# ` this line would become an ORDERED
  // LIST, which the command must refuse rather than silently restructure.
  '# 1. 假列表',
  '',
  '正文乙',
  '',
  // The reported case: an EMPTY H1 (marker + spacing, no content) as the
  // document's LAST block.
  '# ',
  ''
]
const FIXTURE = LINES.join(EOL)
const FIXTURE_LF = LINES.join('\n')

async function waitFor(fn, message, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
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

async function readSource(evaluate, message) {
  await toggleSourceMode(evaluate)
  const shown = await waitFor(() => visibleSource(evaluate), `source view did not appear (${message})`)
  await toggleSourceMode(evaluate)
  await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), `rich view did not return (${message})`)
  await sleep(150)
  return shown
}

async function assertSource(evaluate, expected, message) {
  const actual = await readSource(evaluate, message)
  if (actual !== expected) {
    console.error('  actual  :', JSON.stringify(actual))
    console.error('  expected:', JSON.stringify(expected))
  }
  assert.equal(actual, expected, message)
}

async function toggleKernelMode(evaluate) {
  const opened = await evaluate(`(() => {
    const button = document.querySelector('.block-switch-caret-btn')
    button?.click()
    return !!button
  })()`)
  assert.ok(opened, 'no kernel-mode caret button — tab not kernel-eligible?')
  await sleep(150)
  const clicked = await evaluate(`(() => {
    const item = [...document.querySelectorAll('.block-switch-menu .block-menu-item')]
      .find((node) => node.offsetParent)
    item?.click()
    return !!item
  })()`)
  assert.ok(clicked, 'kernel-toggle menu item missing')
}

async function charRect(evaluate, blockText, from, to) {
  return evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p, h1, h2, h3, h4, h5, h6') || [])].find((n) => n.textContent === ${JSON.stringify(blockText)})
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

// The EMPTY heading has no text node for charRect to range over — click the
// element's own left content edge instead.
async function clickEmptyHeading(evaluate, send) {
  const rect = await waitFor(() => evaluate(`(() => {
    const node = [...((${VISIBLE_EDITOR})?.querySelectorAll('h1, h2, h3, h4, h5, h6') || [])]
      .find((n) => n.textContent === '')
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const r = node.getBoundingClientRect()
    return { left: r.left, top: r.top, height: r.height }
  })()`), 'could not locate the empty heading')
  await click(send, { x: rect.left + 2, y: rect.top + Math.max(8, rect.height / 2) })
  await sleep(200)
}

const blockTags = (evaluate) => evaluate(`[...((${VISIBLE_EDITOR})?.children || [])].map((n) => n.tagName.toLowerCase())`)

const caretBlock = (evaluate) => evaluate(`(() => {
  const sel = window.getSelection()
  const node = sel?.anchorNode
  if (!node) return null
  const el = node.nodeType === 1 ? node : node.parentElement
  const block = el?.closest('p, h1, h2, h3, h4, h5, h6, li, th, td, pre')
  if (!block) return null
  const range = document.createRange()
  range.selectNodeContents(block)
  range.setEnd(sel.anchorNode, sel.anchorOffset)
  return {
    tag: block.tagName.toLowerCase(),
    text: block.textContent,
    caretOffset: range.toString().length,
    isLastChild: !block.nextElementSibling
  }
})()`)

const toasts = (evaluate) => evaluate(`JSON.stringify(window.__demoteToasts || [])`)
const resetToasts = (evaluate) => evaluate(`(window.__demoteToasts = [], 1)`)

// `Mod-z`/`Mod-y` resolve to Meta (Cmd) on darwin — same convention every
// other kernel UI suite uses (CDP modifiers: Meta = 4).
const undoKey = (send) => pressKey(send, { key: 'z', code: 'KeyZ', modifiers: 4, windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 })
const redoKey = (send) => pressKey(send, { key: 'y', code: 'KeyY', modifiers: 4, windowsVirtualKeyCode: 89, nativeVirtualKeyCode: 89 })

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
      return text && text.includes('二级标题') && text.includes('正文乙') ? text : null
    }, 'initial document did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on plain mount')

    await evaluate(`(() => {
      window.__demoteToasts = []
      window.addEventListener('hm:toast', (e) => window.__demoteToasts.push(e.detail?.msg ?? String(e.detail)))
      return 1
    })()`)

    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('二级标题') ? text : null
    }, 'document did not remount after enabling kernel mode')
    await sleep(300)
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy fallback for this fixture: ${attachDiagnostics}`)

    // ============================================================
    // 1) H2 -> H1: Backspace at the content start deletes ONE `#`.
    //    Undo restores the H2, redo re-demotes — the intent must hold a
    //    kernel history slot like every other structural edit.
    // ============================================================
    await clickAt(evaluate, send, '二级标题', 0)
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await waitFor(async () => (await blockTags(evaluate))[0] === 'h1', 'H2 did not demote to H1')

    await undoKey(send)
    await waitFor(async () => (await blockTags(evaluate))[0] === 'h2', 'undo did not restore the H2')
    await redoKey(send)
    await waitFor(async () => (await blockTags(evaluate))[0] === 'h1', 'redo did not re-demote to H1')

    const afterH2 = FIXTURE_LF.replace('## 二级标题', '# 二级标题')
    await assertSource(evaluate, afterH2,
      `H2 demote must delete exactly one # (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)

    // ============================================================
    // 2) H1 with content -> paragraph: the whole `# ` opening goes, the
    //    caret sits at the paragraph's start, and typing there commits.
    // ============================================================
    await clickAt(evaluate, send, '大标题甲', 0)
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await waitFor(async () => {
      const caret = await caretBlock(evaluate)
      return caret && caret.tag === 'p' && caret.text === '大标题甲' ? caret : null
    }, 'H1 did not demote to a paragraph')
    const h1Caret = await caretBlock(evaluate)
    assert.equal(h1Caret.caretOffset, 0,
      `the caret must sit at the demoted paragraph's start, got ${JSON.stringify(h1Caret)}`)

    await typeTextLikeUser(send, '前', { delayMs: delay })
    await sleep(400)
    const afterH1 = afterH2.replace('# 大标题甲', '前大标题甲')
    await assertSource(evaluate, afterH1,
      `H1 demote must delete the ATX opening and typing must commit at the paragraph start (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)

    // ============================================================
    // 3) The NAMED refusal: demoting `# 1. 假列表` would turn the line into
    //    an ordered list — zero bytes may change, and the toast names why.
    // ============================================================
    await clickAt(evaluate, send, '1. 假列表', 0)
    await resetToasts(evaluate)
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(400)
    const refusalToasts = JSON.parse(await toasts(evaluate))
    console.log('  [refusal] ->', JSON.stringify({ toasts: refusalToasts }))
    assert.ok(refusalToasts.some((t) => /没法安全降级|cannot be demoted safely/.test(t)),
      `the unprovable demote must raise the named toast, got ${JSON.stringify(refusalToasts)}`)
    assert.ok((await blockTags(evaluate)).includes('h1'), 'the refused heading must stay an H1')
    await assertSource(evaluate, afterH1, 'a refused demote must write NOTHING')

    // ============================================================
    // 4) The REPORTED case: an EMPTY H1 as the document's last block.
    //    Backspace deletes the heading's bytes; the caret rides the doc-end
    //    placeholder session and typing there commits a fresh paragraph.
    // ============================================================
    const tagsBefore = await blockTags(evaluate)
    await clickEmptyHeading(evaluate, send)
    await resetToasts(evaluate)
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(400)
    const emptyCaret = await caretBlock(evaluate)
    console.log('  [empty H1] ->', JSON.stringify({ caret: emptyCaret }))
    assert.ok(emptyCaret && emptyCaret.tag === 'p' && emptyCaret.text === '' && emptyCaret.isLastChild,
      `the caret must land inside the (empty) placeholder where the heading stood, got ${JSON.stringify(emptyCaret)}`)
    const tagsAfter = await blockTags(evaluate)
    assert.equal(
      tagsAfter.filter((t) => t === 'h1').length,
      tagsBefore.filter((t) => t === 'h1').length - 1,
      `the empty H1 must be GONE from the view, got ${JSON.stringify(tagsAfter)}`)
    assert.deepEqual(JSON.parse(await toasts(evaluate)), [],
      'a landed empty-H1 demote must not toast at all')

    await typeTextLikeUser(send, '结尾丙', { delayMs: delay })
    await sleep(400)
    const afterEmpty = afterH1.replace('正文乙\n\n# \n', '正文乙\n\n结尾丙')
    await assertSource(evaluate, afterEmpty,
      `the empty-H1 demote must delete the heading's bytes and typing must commit a fresh paragraph (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)

    // ============================================================
    // 5) The Delete key takes the SAME gesture (Milkdown binds both):
    //    forward-Delete at the H1's content start demotes it to a paragraph.
    // ============================================================
    await clickAt(evaluate, send, '二级标题', 0)
    await pressKey(send, { key: 'Delete', code: 'Delete' })
    await waitFor(async () => {
      const caret = await caretBlock(evaluate)
      return caret && caret.tag === 'p' && caret.text === '二级标题' ? caret : null
    }, 'Delete at the H1 content start did not demote it')
    const afterDelete = afterEmpty.replace('# 二级标题', '二级标题')
    await assertSource(evaluate, afterDelete, 'Delete must take the same demote gesture as Backspace')

    // ============================================================
    // 6) Disk bytes (the only place CRLF is provable), then a COLD RELAUNCH:
    //    the saved bytes must parse back to the same blocks.
    // ============================================================
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    const disk = await readFile(file, 'utf8')
    const expectedDisk = afterDelete.split('\n').join(EOL)
    if (disk !== expectedDisk) {
      console.error('  disk    :', JSON.stringify(disk))
      console.error('  expected:', JSON.stringify(expectedDisk))
    }
    assert.equal(disk, expectedDisk, 'disk bytes must match the kernel-derived expectation exactly')
    if (crlf) {
      assert.equal(/(?<!\r)\n/.test(disk), false, 'a CRLF document must not gain a lone LF anywhere')
    }
    assert.equal(app.dialogs.length, 0,
      `no dialog may appear: ${JSON.stringify(app.dialogs.map((d) => d.message))}`)

    await stopBuiltElectron(app, { removeProfile: false })
    app = null
    app = await launchBuiltElectron({ profileDir: join(root, 'profile-reopen'), port, appArgs: [file] })
    const reopened = app
    await waitFor(async () => {
      const text = await reopened.evaluate(`(${VISIBLE_EDITOR})?.textContent`)
      return text && text.includes('结尾丙') && text.includes('前大标题甲') ? text : null
    }, 'saved document did not remount on cold relaunch')
    const reopenTags = await reopened.evaluate(`[...((${VISIBLE_EDITOR})?.children || [])].map((n) => n.tagName.toLowerCase())`)
    assert.equal(reopenTags.filter((t) => t === 'h1').length, 1,
      `only the refused heading may survive as an H1, got ${JSON.stringify(reopenTags)}`)
    assert.equal(reopened.dialogs.length, 0, 'no dialog on cold relaunch')

    console.log(`PASS kernel-mode heading demote UI regression (${crlf ? 'CRLF' : 'LF'}): H2->H1, H1->paragraph (typable, undo/redo), the unprovable shape keeps its named toast with zero bytes written, the reported EMPTY-H1-at-doc-end case deletes cleanly through the placeholder session, Delete takes the same gesture, and the bytes survive save + cold relaunch`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
