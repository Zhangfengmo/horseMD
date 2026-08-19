// Kernel-mode `/quote` end-to-end UI regression (2026-08-19).
//
// WHY THIS SCRIPT EXISTS. `/quote` was enabled in the slash menu — ranked first,
// the only enabled item for its query — and had NEVER once succeeded: the bytes
// it commits ('>' alone on its line) reparse to a blockquote with ZERO mdast
// children, while ProseMirror's `block+` blockquote always holds the empty
// paragraph the Milkdown transformer's `createAndFill` puts there, so the result
// document's projection map was a count mismatch and `requireMap` refused every
// invocation.
//
// The headless Case 20 (scripts/test-kernel-mode-headless.mjs) proves the
// controller against a STUB parse table. It cannot prove the one fact the fix
// rests on — what the LIVE Milkdown parser really produces for a bare '>' —
// which is exactly the kind of assumption this repo has shipped vacuous tests
// on before. So this drives the real app: real keystrokes, a real slash menu,
// and byte assertions read from the SOURCE view.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-quote-${process.pid}`
const file = join(root, 'quote.md')
const port = Number(process.env.CDP_PORT || 10048)
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
    // 1) `/quote` COMMITS. The item must be enabled (it always was) AND the
    //    invocation must change the bytes (it never did).
    // ============================================================
    await selectBlock(evaluate, send, '甲乙丙丁')
    await runSlashItem(evaluate, send, 'quote', 'quote')
    const EXPECT_QUOTE = FIXTURE.replace('甲乙丙丁', '>')
    const probe = await probeDivergence(evaluate, '/quote via Enter')
    console.log('  [divergence probe] /quote + Enter ->', JSON.stringify({
      sourceChanged: probe.source !== FIXTURE,
      source: probe.source === EXPECT_QUOTE ? '(expected `>`)' : probe.source,
      blockTags: probe.tags
    }))
    assert.equal(probe.source, EXPECT_QUOTE,
      `/quote must commit the \`>\` marker bytes (diagnostics: ${probe.diagnostics})`)
    // …and the projection must have rebuilt: doc order is h1 标题, p 首段落,
    // TARGET, so tags[2] is the converted block.
    assert.equal(probe.tags[2], 'blockquote',
      `the committed \`>\` must PROJECT as a blockquote — got <${probe.tags[2]}> (diagnostics: ${probe.diagnostics})`)

    // ============================================================
    // 2) THE POINT OF THE FIX: the created blockquote is TYPABLE. A block the
    //    kernel creates but cannot map would be read-only — strictly worse
    //    than a refused menu item, and the reason `requireMap` guards it.
    // ============================================================
    await typeTextLikeUser(send, '引用文字', { delayMs: delay })
    await sleep(400)
    await assertSource(evaluate, FIXTURE.replace('甲乙丙丁', '>引用文字'),
      'typing into the new blockquote must land after the marker')
    const afterTyping = await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)
    assert.ok(!afterTyping.includes('attach-unmappable') && !afterTyping.includes('projection-parse-failure'),
      `typing into the new quote must not degrade the kernel: ${afterTyping}`)

    assert.equal(app.dialogs.length, 0, 'no dialog from the quote conversion')
    console.log('PASS kernel-mode /quote UI regression: the slash item commits a real empty blockquote and the created quote is typable')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
