// Kernel-mode block-type slash items end-to-end UI regression.
//
// The headless suites (scripts/test-source-kernel-blocktype.mjs +
// Cases B1-B5 in scripts/test-kernel-mode-headless.mjs) prove the COMMAND and
// the CONTROLLER. They cannot prove the live wiring — the crepe-setup option
// object, the slash menu's own `run` swap, and the real keystroke sequence
// that puts the query bytes in the source before the item runs. That gap is
// exactly where the "slash items do nothing" report landed, so this script
// drives the REAL app: real keystrokes through human-input, real mouse
// clicks, and byte assertions read from the SOURCE view.
//
// Every expected string is the literal output of the kernel command itself
// (setBlockTypeFromQuery + applySourceTransaction), not a guess.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-blocktype-${process.pid}`
const file = join(root, 'blocktype.md')
const port = Number(process.env.CDP_PORT || 10042)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

// Three independent target paragraphs, each converted exactly once, so no
// checkpoint depends on a previous conversion being undone.
const FIXTURE = [
  '# 标题',
  '',
  '首段落用于占位说明。',
  '',
  '甲乙丙丁',
  '',
  '戊己庚辛',
  '',
  '壬癸子丑',
  '',
  '> 引用甲',
  '',
  '尾段落。',
  ''
].join('\n')

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
  assert.equal(await readSource(evaluate, message), expected, message)
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
  await sleep(150)
}

// Select a whole block with a triple click, so the query typed next REPLACES
// its text and the block's entire content becomes "/query" — the one shape
// `shouldShow` can ever fire on (atEndOfBlock + the full block text starting
// with '/'). Deleting first and typing into a genuinely empty top-level
// paragraph is NOT used: such a paragraph has no raw representation at all,
// so it is a different (and separately refused) scenario.
// A real mouse DRAG across the block's text. A triple click is deliberately
// NOT used: ProseMirror turns it into a whole-node selection whose replace
// step resolves `from`/`to` in DIFFERENT parents, which the kernel gateway
// correctly refuses (single-textblock guard) — the typed character then never
// lands and the menu never opens. A drag produces an ordinary TextSelection
// inside the one textblock, which is the shape a user actually produces.
async function selectionNonEmpty(evaluate) {
  return evaluate(`(() => { const s = window.getSelection(); return !!s && s.toString().length > 0 })()`)
}

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
// `.disabled`), then activate it with Enter — the exact sequence the user
// performed ("打出来但是没效果").
async function runSlashItem(evaluate, send, query, id, { activate = 'enter' } = {}) {
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
  if (activate === 'click') {
    // The OTHER entry point the user reported: opening the menu and clicking
    // the item with the mouse. It runs the same `run`, but through
    // onPointerUp rather than the Enter keymap, so both are exercised.
    const point = await waitFor(() => evaluate(`(() => {
      const li = document.querySelector('.milkdown-slash-menu[data-show="true"] .hm-slash-item[data-id=${JSON.stringify(id)}]')
      const r = li?.getBoundingClientRect()
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
    })()`), `the '${id}' slash item is not hit-testable`)
    await click(send, point)
  } else {
    await pressKey(send, { key: 'Enter', code: 'Enter' })
  }
  await sleep(500)
}

// The visible editor's DIRECT children, as tag names — the PM document's own
// top-level block sequence, read from the view. This is the "did the
// PROJECTION rebuild?" half of the bytes-vs-view divergence probe below.
const blockTags = (evaluate) => evaluate(`[...((${VISIBLE_EDITOR})?.children || [])].map((n) => n.tagName.toLowerCase())`)

// THE DIVERGENCE PROBE. In a source-authoritative kernel the view is a
// projection of the bytes, so a failure has exactly two shapes and they need
// completely different fixes:
//   (1) the bytes never changed  -> the route never reached the kernel
//   (2) the bytes changed but the view still shows the old block -> the
//       commit succeeded and the projection failed to rebuild, i.e. the
//       document on disk and the document on screen disagree.
// Reading BOTH, in that order, is what tells them apart. The PM side is read
// FIRST and without any mode switch, because toggling to source mode and back
// would itself re-project and mask shape (2).
async function probeDivergence(evaluate, label) {
  const tags = await blockTags(evaluate)
  const diagnostics = await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)
  const source = await readSource(evaluate, label)
  return { tags, source, diagnostics }
}

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
      return text && text.includes('甲乙丙丁') && text.includes('尾段落。') ? text : null
    }, 'initial document did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on plain mount')

    // ---- enable kernel mode ----
    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('甲乙丙丁') ? text : null
    }, 'document did not remount after enabling kernel mode')
    await sleep(300)
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy fallback for this fixture: ${attachDiagnostics}`)

    // ============================================================
    // 1) `/h1` in an EMPTY paragraph — the EXACT reported scenario, typed
    //    and activated with Enter. Both halves of the divergence probe are
    //    asserted, and the pair is printed before either assertion fires so
    //    a failure run still reports WHICH shape it is.
    // ============================================================
    await selectBlock(evaluate, send, '甲乙丙丁')
    await runSlashItem(evaluate, send, 'h1', 'h1')
    const EXPECT_H1 = FIXTURE.replace('甲乙丙丁', '# ')
    const probe = await probeDivergence(evaluate, '/h1 via Enter')
    console.log('  [divergence probe] /h1 + Enter ->', JSON.stringify({
      sourceChanged: probe.source !== FIXTURE,
      source: probe.source === EXPECT_H1 ? '(expected `# `)' : probe.source,
      blockTags: probe.tags
    }))
    assert.equal(probe.source, EXPECT_H1,
      `/h1 must commit the \`# \` marker bytes (diagnostics: ${probe.diagnostics})`)
    // The SECOND half: the projection must have rebuilt. `tags[2]` is the
    // converted block (doc order: h1 标题, p 首段落, TARGET, ...). A `p` here
    // with the bytes already committed is a bytes/view divergence, which is a
    // different and more serious defect than a dead menu item.
    assert.equal(probe.tags[2], 'h1',
      `the committed \`# \` must PROJECT as a heading in the view — got <${probe.tags[2]}> while the bytes are already \`# \` (bytes/view divergence; diagnostics: ${probe.diagnostics})`)

    // The created heading is TYPABLE (one the kernel creates but cannot map
    // would be a read-only block — worse than a blocked menu item).
    await typeTextLikeUser(send, '标题一', { delayMs: delay })
    await sleep(300)
    await assertSource(evaluate, FIXTURE.replace('甲乙丙丁', '# 标题一'),
      'typing into the newly created heading must land after the marker')

    // ============================================================
    // 2) heading level change: `/h4` typed inside the H1 just created, and
    //    activated by CLICKING the menu item (the user's other entry point).
    //    `shouldShow` accepts a heading, so the existing marker must be
    //    REWRITTEN, never appended to.
    // ============================================================
    await selectBlock(evaluate, send, '标题一')
    await runSlashItem(evaluate, send, 'h4', 'h4', { activate: 'click' })
    await assertSource(evaluate, FIXTURE.replace('甲乙丙丁', '#### '),
      '/h4 inside an H1 must replace the marker, never append to it')
    assert.equal((await blockTags(evaluate))[2], 'h4',
      'the level change must project as an h4 in the view')

    // ============================================================
    // 3) `/ul` -> a bullet list whose empty item is typable.
    // ============================================================
    await selectBlock(evaluate, send, '戊己庚辛')
    await runSlashItem(evaluate, send, 'ul', 'bullet')
    await assertSource(evaluate, FIXTURE.replace('甲乙丙丁', '#### ').replace('戊己庚辛', '- '),
      '/ul in an empty paragraph must commit the `- ` marker bytes')
    await typeTextLikeUser(send, '条目', { delayMs: delay })
    await sleep(300)
    await assertSource(evaluate, FIXTURE.replace('甲乙丙丁', '#### ').replace('戊己庚辛', '- 条目'),
      'typing into the new list item must land after the marker')

    // ============================================================
    // 4) `/ol` -> an ordered list.
    // ============================================================
    await selectBlock(evaluate, send, '壬癸子丑')
    await runSlashItem(evaluate, send, 'ol', 'ordered')
    await assertSource(evaluate,
      FIXTURE.replace('甲乙丙丁', '#### ').replace('戊己庚辛', '- 条目').replace('壬癸子丑', '1. '),
      '/ol in an empty paragraph must commit the `1. ` marker bytes')

    // ============================================================
    // 4.5) `/h2` INSIDE A BLOCKQUOTE (2026-08-22, the "引用内嵌套" report):
    //      the quoted paragraph converts in place — the quote survives, the
    //      heading lives inside it, and the created quoted heading is
    //      immediately typable.
    // ============================================================
    await selectBlock(evaluate, send, '引用甲')
    await runSlashItem(evaluate, send, 'h2', 'h2')
    const quoteExpect = FIXTURE.replace('甲乙丙丁', '#### ').replace('戊己庚辛', '- 条目')
      .replace('壬癸子丑', '1. ').replace('> 引用甲', '> ## ')
    const quoteProbe = await probeDivergence(evaluate, '/h2 inside a quote')
    console.log('  [divergence probe] /h2 inside a QUOTE ->', JSON.stringify({
      source: quoteProbe.source === quoteExpect ? '(expected `> ## `)' : quoteProbe.source,
      blockTags: quoteProbe.tags
    }))
    assert.equal(quoteProbe.source, quoteExpect,
      `/h2 inside a blockquote must commit \`> ## \` (diagnostics: ${quoteProbe.diagnostics})`)
    const quoteShape = await evaluate(`(() => {
      const quotes = [...((${VISIBLE_EDITOR})?.querySelectorAll('blockquote') || [])]
      return quotes.map((q) => [...q.children].map((n) => n.tagName.toLowerCase()))
    })()`)
    assert.deepEqual(quoteShape, [['h2']],
      `the quote must survive with an H2 inside it, got ${JSON.stringify(quoteShape)}`)
    await typeTextLikeUser(send, '引用标题', { delayMs: delay })
    await sleep(300)
    await assertSource(evaluate, quoteExpect.replace('> ## ', '> ## 引用标题'),
      'typing into the quoted heading must land after its marker')

    // ============================================================
    // 5) THE REPORTED SHAPE: a genuinely EMPTY paragraph, created the way a
    //    user creates one — Enter at the end of the last paragraph — then
    //    "/h1" + Enter. This block has no raw representation of its own
    //    until the query bytes are committed, which is the one thing steps
    //    1-4 (whose block always had real content to replace) never exercise.
    // ============================================================
    await clickAt(evaluate, send, '尾段落。', 4)
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(400)
    const beforeEmpty = await readSource(evaluate, 'empty-paragraph setup')
    await runSlashItem(evaluate, send, 'h1', 'h1')
    const emptyProbe = await probeDivergence(evaluate, '/h1 in an empty paragraph')
    console.log('  [divergence probe] /h1 in an EMPTY paragraph ->', JSON.stringify({
      before: beforeEmpty,
      after: emptyProbe.source,
      blockTags: emptyProbe.tags
    }))
    // The Enter left a trailing blank line (the placeholder's own bytes); the
    // conversion turns that blank line into the heading marker.
    assert.equal(emptyProbe.source, beforeEmpty.replace(/\n+$/, '\n\n') + '# \n',
      '/h1 in an empty paragraph must commit the `# ` marker bytes')
    assert.equal(emptyProbe.tags.at(-1), 'h1',
      `the committed \`# \` must PROJECT as a heading — got <${emptyProbe.tags.at(-1)}> (diagnostics: ${emptyProbe.diagnostics})`)

    assert.equal(app.dialogs.length, 0, 'no dialog from any block-type conversion')
    console.log('PASS kernel-mode block-type slash items UI regression: /h2, heading level change, /ul and /ol all commit their marker bytes and the created blocks are typable')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
