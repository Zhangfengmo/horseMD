// Kernel-mode LEAF slash items end-to-end UI regression (/divider, /image
// and /text — the caret-AFTER insert family plus the revert-to-paragraph
// suffix deletion).
//
// The headless suites (scripts/test-source-kernel-blockinsert.mjs section 10 +
// Case I6 in scripts/test-kernel-mode-headless.mjs) prove the COMMAND and the
// CONTROLLER. What they cannot prove — and what bit this project once as "an
// item unblocked without a route is a silently dead menu entry" — is the live
// wiring plus the property that makes a caret-after insert worth shipping at
// all: after the real keystrokes and the real menu activation, the caret is
// somewhere the user can IMMEDIATELY TYPE, the keystroke commits real bytes,
// the bytes survive a real save, and a COLD RELAUNCH parses them back to the
// same blocks. Every expected string below is the literal output of the
// kernel command chain, not a guess.
//
// CRLF variant: `KERNEL_LEAF_CRLF=1`. A textarea's `.value` normalizes line
// breaks to LF, so only the disk bytes at the end can pin a CRLF document.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const crlf = process.env.KERNEL_LEAF_CRLF === '1'
const EOL = crlf ? '\r\n' : '\n'
const root = `/tmp/horsemd-kernel-leaf-insert-${process.pid}`
const file = join(root, 'leafinsert.md')
const port = Number(process.env.CDP_PORT || 10084)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

const LINES = [
  '# 标题',
  '',
  '甲甲段落',
  '',
  '乙乙段落',
  '',
  '- 列表项',
  '',
  '丙丙段落',
  '',
  '丁丁段落',
  '',
  // The list / paragraph / list sandwich `/text`'s merge refusal needs: with
  // the middle paragraph gone the two lists close over the gap into ONE loose
  // list (CommonMark 0.28 dropped the two-blank-lines rule), which is a
  // restructuring of the document the command must refuse.
  '- 列甲',
  '',
  '中间段落',
  '',
  '- 列乙',
  '',
  '己己段落',
  '',
  '戊戊尾段',
  ''
]
const FIXTURE = LINES.join(EOL)
// The source VIEW is always LF (textarea value normalization); the disk check
// at the end owns the real endings.
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

async function selectionNonEmpty(evaluate) {
  return evaluate(`(() => { const s = window.getSelection(); return !!s && s.toString().length > 0 })()`)
}

// A real mouse DRAG across the block's text (never a triple click, which
// ProseMirror turns into a whole-node selection the kernel gateway correctly
// refuses). The typed query then REPLACES the block's text, which is the one
// shape `shouldShow` can fire on.
async function selectBlock(evaluate, send, blockText) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rect = await waitFor(() => charRect(evaluate, blockText, 0, blockText.length),
      `could not locate ${JSON.stringify(blockText)} to select`)
    const y = rect.top + Math.min(12, rect.height / 2)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.left + 1, y, button: 'left', clickCount: 1 })
    for (let step = 1; step <= 4; step += 1) {
      const x = rect.left + ((rect.right - rect.left) * step) / 4
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.max(rect.right - 1, rect.left + 1), y, button: 'left', clickCount: 1 })
    await sleep(250)
    if (await selectionNonEmpty(evaluate)) return
    await sleep(200)
  }
  assert.fail(`drag-select never produced a non-empty selection for ${JSON.stringify(blockText)}`)
}

// Type "/<query>", wait for the menu, assert the item is ENABLED (not
// `.disabled`) AND ranked first, then activate it with Enter.
async function runSlashItem(evaluate, send, query, id) {
  await typeTextLikeUser(send, '/' + query, { delayMs: delay })
  try {
    await waitFor(() => evaluate(`document.querySelectorAll('.milkdown-slash-menu[data-show="true"] .hm-slash-item').length > 0`),
      `slash menu did not open for the /${query} query`, 25)
  } catch (error) {
    const dump = await evaluate(`JSON.stringify({
      blocks: [...((${VISIBLE_EDITOR})?.children || [])].map((n) => n.tagName + ':' + n.textContent),
      menus: [...document.querySelectorAll('.milkdown-slash-menu')].map((n) => n.getAttribute('data-show')),
      diagnostics: (window.__hmKernelDiagnostics || []).slice(-6)
    })`)
    throw new Error(`${error.message} — live state: ${dump}`)
  }
  const state = await waitFor(() => evaluate(`(() => {
    const li = document.querySelector('.milkdown-slash-menu[data-show="true"] .hm-slash-item[data-id=${JSON.stringify(id)}]')
    if (!li) return null
    return { present: true, disabled: li.classList.contains('disabled'), first: document.querySelector('.milkdown-slash-menu[data-show="true"] .hm-slash-item')?.dataset.id }
  })()`), `the '${id}' item never appeared for the /${query} query`)
  assert.equal(state.disabled, false,
    `the '${id}' slash item must be ENABLED in kernel mode, not greyed out`)
  assert.equal(state.first, id,
    `the /${query} query must rank '${id}' first so Enter activates it (got ${state.first})`)
  await pressKey(send, { key: 'Enter', code: 'Enter' })
  await sleep(600)
}

const blockTags = (evaluate) => evaluate(`[...((${VISIBLE_EDITOR})?.children || [])].map((n) => n.tagName.toLowerCase())`)

// The block the DOM caret currently sits in: enclosing structural tag, its
// text, and whether the caret is at the block's own start — the "immediately
// typable, at the right place" assertion for a caret-after insert.
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

const toasts = (evaluate) => evaluate(`JSON.stringify(window.__leafToasts || [])`)
const resetToasts = (evaluate) => evaluate(`(window.__leafToasts = [], 1)`)

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
      return text && text.includes('甲甲段落') && text.includes('戊戊尾段') ? text : null
    }, 'initial document did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on plain mount')

    await evaluate(`(() => {
      window.__leafToasts = []
      window.addEventListener('hm:toast', (e) => window.__leafToasts.push(e.detail?.msg ?? String(e.detail)))
      return 1
    })()`)

    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('甲甲段落') ? text : null
    }, 'document did not remount after enabling kernel mode')
    await sleep(300)
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy fallback for this fixture: ${attachDiagnostics}`)

    // ============================================================
    // 1) `/divider` MID-DOCUMENT, before a paragraph: the bytes are `---`,
    //    the caret lands at the FOLLOWING paragraph's start, and typing
    //    there commits into that paragraph.
    // ============================================================
    await selectBlock(evaluate, send, '甲甲段落')
    await runSlashItem(evaluate, send, 'hr', 'divider')

    const midCaret = await caretBlock(evaluate)
    console.log('  [/hr mid-document] ->', JSON.stringify({ caret: midCaret }))
    assert.ok(midCaret && midCaret.tag === 'p' && midCaret.text === '乙乙段落' && midCaret.caretOffset === 0,
      `the caret must land at the START of the following paragraph, got ${JSON.stringify(midCaret)}`)
    assert.ok((await blockTags(evaluate)).includes('hr'),
      'the committed divider must PROJECT as a real <hr> in the view')

    await typeTextLikeUser(send, 'X', { delayMs: delay })
    await sleep(400)
    const afterMid = FIXTURE_LF.replace('甲甲段落', '---').replace('乙乙段落', 'X乙乙段落')
    await assertSource(evaluate, afterMid,
      `/hr mid-document must commit --- and the follow-up keystroke must land in the next paragraph (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)

    // ============================================================
    // 2) `/image` MID-DOCUMENT, before a paragraph: the bytes are the
    //    literal `![]()`, the view renders the image-block CARD (its own
    //    upload UI is the src entry point), and the caret lands at the
    //    following paragraph's start — same caret rule as the divider.
    // ============================================================
    await selectBlock(evaluate, send, '丙丙段落')
    await runSlashItem(evaluate, send, 'image', 'image')

    const imageCaret = await caretBlock(evaluate)
    const imageCard = await evaluate(`(() => {
      const card = (${VISIBLE_EDITOR})?.querySelector('.milkdown-image-block, milkdown-image-block')
      if (!card) return null
      return { present: true, hasImg: !!card.querySelector('img[src]:not([src=""])') }
    })()`)
    console.log('  [/image mid-document] ->', JSON.stringify({ caret: imageCaret, card: imageCard }))
    assert.ok(imageCard?.present, 'the committed ![]() must PROJECT as the image-block card in the view')
    assert.equal(imageCard.hasImg, false, 'the empty card must show its upload UI, not a broken <img>')
    assert.ok(imageCaret && imageCaret.tag === 'p' && imageCaret.text === '丁丁段落' && imageCaret.caretOffset === 0,
      `the caret must land at the START of the following paragraph, got ${JSON.stringify(imageCaret)}`)

    await typeTextLikeUser(send, 'Y', { delayMs: delay })
    await sleep(400)
    const afterImage = afterMid.replace('丙丙段落', '![]()').replace('丁丁段落', 'Y丁丁段落')
    await assertSource(evaluate, afterImage,
      `/image mid-document must commit ![]() and the follow-up keystroke must land in the next paragraph (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)

    // ============================================================
    // 3) `/text` at the DOCUMENT END, after a PARAGRAPH — the vouched
    //    placeholder home. The query block's bytes (and its surplus line)
    //    are deleted, the caret sits in an empty last paragraph the reparse
    //    cannot show, and typing there commits a NEW paragraph — never a
    //    lazy continuation of the block above.
    // ============================================================
    await selectBlock(evaluate, send, '戊戊尾段')
    await runSlashItem(evaluate, send, 'text', 'text')

    const textCaret = await caretBlock(evaluate)
    console.log('  [/text doc-end] ->', JSON.stringify({ caret: textCaret }))
    assert.ok(textCaret && textCaret.tag === 'p' && textCaret.text === '' && textCaret.isLastChild,
      `the caret must land inside the (empty) materialized placeholder, got ${JSON.stringify(textCaret)}`)

    await typeTextLikeUser(send, '新尾段', { delayMs: delay })
    await sleep(400)
    const afterText = afterImage.replace('戊戊尾段\n', '新尾段')
    await assertSource(evaluate, afterText,
      `/text at the document end must strip the query and typing must commit a fresh paragraph (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)

    // ============================================================
    // 4) `/divider` at the DOCUMENT END: the caret lands in the trailing
    //    placeholder, and typing there commits a new paragraph below the
    //    divider (the virtual-pair bytes typing there has always committed).
    // ============================================================
    await selectBlock(evaluate, send, '新尾段')
    await runSlashItem(evaluate, send, 'hr', 'divider')

    const endCaret = await caretBlock(evaluate)
    console.log('  [/hr doc-end] ->', JSON.stringify({ caret: endCaret }))
    assert.ok(endCaret && endCaret.tag === 'p' && endCaret.text === '' && endCaret.isLastChild,
      `the caret must land inside the (empty) trailing placeholder, got ${JSON.stringify(endCaret)}`)

    await typeTextLikeUser(send, '结尾段', { delayMs: delay })
    await sleep(400)
    // '新尾段' had no trailing ending (it was typed into the placeholder), so
    // '---' replaces it verbatim and the follow-up typing carries the full
    // '\n\n' separator — no NEW trailing ending is ever invented.
    const afterEnd = afterText.replace('新尾段', '---\n\n结尾段')
    await assertSource(evaluate, afterEnd,
      `/hr at the document end must commit --- and typing must land below it (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)

    // ============================================================
    // 5) `/divider` before a LIST: the NAMED refusal. The item stays enabled
    //    (the refusal is positional, decided by the command), zero divider
    //    bytes are written, and the toast names the workaround.
    // ============================================================
    await selectBlock(evaluate, send, 'X乙乙段落')
    await resetToasts(evaluate)
    await runSlashItem(evaluate, send, 'hr', 'divider')
    await sleep(300)
    const refusalToasts = JSON.parse(await toasts(evaluate))
    console.log('  [/hr before list] ->', JSON.stringify({ toasts: refusalToasts }))
    assert.ok(refusalToasts.some((t) => /光标将无处安放|nowhere to land/.test(t)),
      `the before-a-list refusal must raise the named-remedy toast, got ${JSON.stringify(refusalToasts)}`)
    // The query bytes are the paragraph's text now (typed before the refusal);
    // the divider itself must NOT exist there — the list keeps its neighbour.
    const afterRefusal = afterEnd.replace('X乙乙段落', '/hr')
    await assertSource(evaluate, afterRefusal,
      'a refused /hr must leave the query bytes as plain text and write NO divider')

    // ============================================================
    // 6) `/text` MID-DOCUMENT (2026-08-21) — on the document's FIRST block,
    //    a HEADING, with a divider below it. Until this pass the position
    //    itself was the refusal (`text-needs-document-end`); it now takes the
    //    same vouched split-placeholder session the doc-end case does, one
    //    position further in: the heading's bytes go, an empty placeholder
    //    stands where it was, and typing there commits a plain paragraph —
    //    which is exactly what "正文" means.
    // ============================================================
    await selectBlock(evaluate, send, '标题')
    await resetToasts(evaluate)
    await runSlashItem(evaluate, send, 'text', 'text')

    const midTextCaret = await caretBlock(evaluate)
    console.log('  [/text mid-document] ->', JSON.stringify({ caret: midTextCaret }))
    assert.ok(midTextCaret && midTextCaret.tag === 'p' && midTextCaret.text === '',
      `the caret must land inside the (empty) materialized placeholder, got ${JSON.stringify(midTextCaret)}`)
    assert.equal((await blockTags(evaluate))[0], 'p',
      'the placeholder must stand where the heading did — the document\'s FIRST block')
    const midTextToasts = JSON.parse(await toasts(evaluate))
    assert.deepEqual(midTextToasts, [],
      `a landed mid-document /text must not toast at all, got ${JSON.stringify(midTextToasts)}`)

    await typeTextLikeUser(send, '新首段', { delayMs: delay })
    await sleep(400)
    const afterTextMid = afterRefusal.replace('# 标题', '新首段')
    await assertSource(evaluate, afterTextMid,
      `mid-document /text must delete only the query block's own bytes and typing must commit a plain paragraph there (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)

    // ============================================================
    // 7) `/text` between two LISTS: the refusal that replaced the positional
    //    one. Removing the middle paragraph would merge the lists, so nothing
    //    is deleted and the toast names the remedy.
    // ============================================================
    await selectBlock(evaluate, send, '中间段落')
    await resetToasts(evaluate)
    await runSlashItem(evaluate, send, 'text', 'text')
    await sleep(300)
    const textRefusalToasts = JSON.parse(await toasts(evaluate))
    console.log('  [/text between lists] ->', JSON.stringify({ toasts: textRefusalToasts }))
    assert.ok(textRefusalToasts.some((t) => /相邻的块合并|merge the blocks around it/.test(t)),
      `the merging /text refusal must raise the named-remedy toast, got ${JSON.stringify(textRefusalToasts)}`)
    const afterTextRefusal = afterTextMid.replace('中间段落', '/text')
    await assertSource(evaluate, afterTextRefusal,
      'a refused /text must leave the query bytes as plain text and delete nothing')

    // ============================================================
    // 8) Disk bytes (the only place CRLF is provable), then a COLD RELAUNCH:
    //    the saved bytes must parse back to the same blocks.
    // ============================================================
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    const disk = await readFile(file, 'utf8')
    const expectedDisk = afterTextRefusal.split('\n').join(EOL)
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
      return text && text.includes('结尾段') && text.includes('/hr') ? text : null
    }, 'saved document did not remount on cold relaunch')
    const reopenTags = await reopened.evaluate(`[...((${VISIBLE_EDITOR})?.children || [])].map((n) => n.tagName.toLowerCase())`)
    assert.equal(reopenTags.filter((t) => t === 'hr').length, 2,
      `both dividers must survive the cold relaunch as real <hr> blocks, got ${JSON.stringify(reopenTags)}`)
    const reopenCard = await reopened.evaluate(`!!(${VISIBLE_EDITOR})?.querySelector('.milkdown-image-block, milkdown-image-block')`)
    assert.ok(reopenCard, 'the empty image must survive the cold relaunch as the image-block card')
    const reopenText = await reopened.evaluate(`(${VISIBLE_EDITOR})?.textContent`)
    assert.ok(reopenText.includes('结尾段') && reopenText.includes('/hr') && reopenText.includes('/text'),
      'the typed paragraphs and both refused query texts must survive the cold relaunch')
    assert.equal(reopened.dialogs.length, 0, 'no dialog on cold relaunch')

    console.log(`PASS kernel-mode leaf-insert slash items UI regression (${crlf ? 'CRLF' : 'LF'}): /divider, /image and /text commit their bytes, the caret is immediately typable in every doc-end/mid-document home (including mid-document /text), both positional refusals raise their named-remedy toasts, and the bytes survive save + cold relaunch`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
