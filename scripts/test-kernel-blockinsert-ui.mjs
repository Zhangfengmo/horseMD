// Kernel-mode block-INSERT slash items end-to-end UI regression (/table, /js,
// /mermaid, /math).
//
// The headless suites (scripts/test-source-kernel-blockinsert.mjs + Cases I1-I4
// in scripts/test-kernel-mode-headless.mjs) prove the COMMAND and the
// CONTROLLER. They cannot prove the live wiring — the crepe-setup option
// object, `kernelSlashInsertRoute`, the slash menu's own `run` swap, and the
// real keystroke sequence that puts the query bytes in the source before the
// item runs. That gap is exactly where "the slash items do nothing" landed once
// already (an item unblocked without a route is invisible to every headless
// test), so this script drives the REAL app: real keystrokes, real clicks, and
// three independent assertions per item — the SOURCE bytes, the projected PM
// structure, and where the caret ended up.
//
// CRLF variant: `KERNEL_INSERT_CRLF=1`. A textarea's `.value` normalizes line
// breaks to LF, so the source view can never prove a CRLF document — the disk
// bytes at the end of the run are what pins it.
//
// Every expected string is the literal output of the kernel command itself
// (insertBlockFromQuery + applySourceTransaction), not a guess.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const crlf = process.env.KERNEL_INSERT_CRLF === '1'
const EOL = crlf ? '\r\n' : '\n'
const root = `/tmp/horsemd-kernel-blockinsert-${process.pid}`
const file = join(root, 'blockinsert.md')
const port = Number(process.env.CDP_PORT || 10046)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

const LINES = [
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
  '寅卯辰巳',
  '',
  '> 引用甲',
  '',
  '尾段落。',
  ''
]
const FIXTURE = LINES.join(EOL)
// The source VIEW is always LF (textarea value normalization), so every
// source-mode expectation is built from the LF spelling and the disk check at
// the end owns the real endings.
const FIXTURE_LF = LINES.join('\n')

// The exact bytes lib/source-kernel/commands/block-insert.js writes.
const TABLE = ['|  |  |  |', '| --- | --- | --- |', '|  |  |  |'].join('\n')
const TABLE_TYPED = ['| 表头 |  |  |', '| --- | --- | --- |', '|  |  |  |'].join('\n')
const CODE = ['```javascript', '', '```'].join('\n')
const QUOTED_CODE = ['> ```javascript', '> ab', '> ```'].join('\n')
// Preview-backed blocks (2026-08-18). Both used to keep the phase-1 refusal:
// `/mermaid` because a preview-rendered fence was paired `charMap: null`, and
// `/math` because block math was. Both pairings are gone (see the ADR that
// replaced `READONLY_CODE_LANGUAGES` in editor-kernel-projection-map.js), so
// the items route like every other insert — and this fixture is what proves
// the created block is actually TYPABLE in the real app rather than a
// good-looking dead end.
const MERMAID = ['```mermaid', '', '```'].join('\n')
const MATH = ['$$', '', '$$'].join('\n')

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
  // Node truncates long strings in assertion diffs, which makes a byte-level
  // failure in a multi-block document unreadable. Print both in full first.
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
// `.disabled`) AND ranked first, then activate it.
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
    const point = await waitFor(() => evaluate(`(() => {
      const li = document.querySelector('.milkdown-slash-menu[data-show="true"] .hm-slash-item[data-id=${JSON.stringify(id)}]')
      const r = li?.getBoundingClientRect()
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
    })()`), `the '${id}' slash item is not hit-testable`)
    await click(send, point)
  } else {
    await pressKey(send, { key: 'Enter', code: 'Enter' })
  }
  await sleep(600)
}

const blockTags = (evaluate) => evaluate(`[...((${VISIBLE_EDITOR})?.children || [])].map((n) => n.tagName.toLowerCase())`)

// The PROJECTION half of the assertion: what the view actually renders for the
// block that was just written. Read WITHOUT a mode switch (toggling to source
// and back would re-project and mask a bytes/view divergence).
// (Crepe's table node view renders more than one <table> element — a sizing
// shell plus the content table — so the one carrying the cells is selected by
// CONTENT, not by document order.)
const tableShape = (evaluate) => evaluate(`(() => {
  const tables = [...((${VISIBLE_EDITOR})?.querySelectorAll('table') || [])]
  const table = tables.find((t) => t.querySelector('th, td'))
  if (!table) return null
  return {
    tables: tables.length,
    rows: [...table.querySelectorAll('tr')].map((r) => [...r.querySelectorAll('th, td')].map((c) => c.textContent)),
    headerCells: table.querySelectorAll('th').length
  }
})()`)

// Where did the caret end up? Answered from the live DOM selection, resolved to
// the enclosing structural element — the assertion that the created block is
// one the user can immediately type into.
const caretHome = (evaluate) => evaluate(`(() => {
  const sel = window.getSelection()
  const node = sel?.anchorNode
  if (!node) return null
  const el = node.nodeType === 1 ? node : node.parentElement
  if (!el) return null
  const cell = el.closest('th, td')
  if (cell) {
    const row = cell.parentElement
    return { kind: cell.tagName.toLowerCase(), cellIndex: cell.cellIndex, rowIndex: row?.rowIndex ?? -1 }
  }
  if (el.closest('.cm-editor')) return { kind: 'codemirror' }
  if (el.closest('.milkdown-code-block, pre')) return { kind: 'code-block' }
  return { kind: el.tagName.toLowerCase() }
})()`)

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
    // 1) `/table` — bytes, projection and caret.
    // ============================================================
    await selectBlock(evaluate, send, '甲乙丙丁')
    await runSlashItem(evaluate, send, 'table', 'table')

    // (a) the caret, read BEFORE any mode switch (switching would move it).
    const tableCaret = await caretHome(evaluate)
    // (b) the projection.
    const shape = await tableShape(evaluate)
    // (c) the bytes.
    const afterTable = FIXTURE_LF.replace('甲乙丙丁', TABLE)
    const source = await readSource(evaluate, '/table')
    console.log('  [/table] ->', JSON.stringify({ caret: tableCaret, shape, sourceChanged: source !== FIXTURE_LF }))
    assert.equal(source, afterTable,
      `/table must commit the skeleton bytes (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)
    assert.ok(shape, 'the committed table must PROJECT as a real <table> in the view (bytes/view divergence)')
    assert.deepEqual(shape.rows, [['', '', ''], ['', '', '']],
      'the projected table is 3 columns x (header + one body row), all cells empty')
    assert.equal(shape.headerCells, 3, 'the first row projects as the header row')
    assert.deepEqual(tableCaret, { kind: 'th', cellIndex: 0, rowIndex: 0 },
      'the caret must land in the FIRST header cell — a table you cannot type into is worse than a blocked item')

    // The cell is genuinely typable (the caret returned there after the mode
    // round-trip is not assumed — the click re-establishes it).
    const cellPoint = await waitFor(() => evaluate(`(() => {
      const cell = (${VISIBLE_EDITOR})?.querySelector('th')
      const r = cell?.getBoundingClientRect()
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
    })()`), 'the new table has no hit-testable header cell')
    await click(send, cellPoint)
    await sleep(200)
    await typeTextLikeUser(send, '表头', { delayMs: delay })
    await sleep(400)
    await assertSource(evaluate, FIXTURE_LF.replace('甲乙丙丁', TABLE_TYPED),
      'typing in the new table cell must land between its delimiters')

    // ============================================================
    // 2) `/js` — the language variant, activated by CLICKING the item (the
    //    other entry point), so both activation paths are exercised.
    // ============================================================
    await selectBlock(evaluate, send, '戊己庚辛')
    await runSlashItem(evaluate, send, 'js', 'code:javascript', { activate: 'click' })

    const codeCaret = await caretHome(evaluate)
    const codeMounted = await evaluate(`!!(${VISIBLE_EDITOR})?.querySelector('.cm-editor, .milkdown-code-block')`)
    const afterCode = FIXTURE_LF.replace('甲乙丙丁', TABLE_TYPED).replace('戊己庚辛', CODE)
    const codeSource = await readSource(evaluate, '/js')
    console.log('  [/js] ->', JSON.stringify({ caret: codeCaret, codeMounted }))
    assert.equal(codeSource, afterCode,
      `/js must commit a javascript fence with an empty content line (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)
    assert.ok(codeMounted, 'the committed fence must PROJECT as a code block in the view')
    assert.ok(codeCaret && (codeCaret.kind === 'codemirror' || codeCaret.kind === 'code-block'),
      `the caret must land inside the new code block, got ${JSON.stringify(codeCaret)}`)

    // ============================================================
    // 2b) `/mermaid` — a PREVIEW-backed fence. Same route as `/js` (it is a
    //     language item, id `code:mermaid`), but the block it creates renders
    //     a diagram instead of its text once it has content, which is exactly
    //     why this item was refused until block previews stopped implying
    //     read-only. The created block is EMPTY, so `renderPreview` returns
    //     nothing and CodeMirror is visible immediately — asserted, not
    //     assumed, because an item that drops the caret into a hidden editor
    //     would be the "fake feature" this whole check exists to prevent.
    // ============================================================
    await selectBlock(evaluate, send, '壬癸子丑')
    await runSlashItem(evaluate, send, 'mermaid', 'code:mermaid')

    const mermaidCaret = await caretHome(evaluate)
    console.log('  [/mermaid] ->', JSON.stringify({ caret: mermaidCaret }))
    assert.ok(mermaidCaret && (mermaidCaret.kind === 'codemirror' || mermaidCaret.kind === 'code-block'),
      `the caret must land inside the new mermaid block, got ${JSON.stringify(mermaidCaret)}`)
    // The caret's OWN block must be the new (empty) one, and its CodeMirror
    // host must be VISIBLE — an empty block renders no preview, so nothing may
    // be hiding the editor the caret just landed in. Both facts are read off
    // the same block so a caret parked in a DIFFERENT code block (the
    // javascript one from step 2) cannot satisfy this vacuously.
    assert.deepEqual(await evaluate(`(() => {
      const block = document.activeElement?.closest?.('.milkdown-code-block')
      if (!block) return null
      return {
        empty: (block.querySelector('.cm-content')?.textContent || '') === '',
        language: block.querySelector('.language-button')?.textContent?.trim()?.toLowerCase() || null,
        visible: !block.querySelector('.codemirror-host')?.classList.contains('hidden')
      }
    })()`), { empty: true, language: 'mermaid', visible: true },
      'the caret must sit in the NEW, empty mermaid block, with a VISIBLE CodeMirror rather than a preview it is trapped behind')

    // Type WITHOUT toggling the view first: this is the real user flow (insert
    // then type), and it is the whole point of the item — a source-mode round
    // trip in between would drop CM focus and prove nothing about the caret
    // the insert itself left behind.
    await typeTextLikeUser(send, 'graph TD', { delayMs: delay })
    await sleep(500)

    const afterMermaid = FIXTURE_LF
      .replace('甲乙丙丁', () => TABLE_TYPED).replace('戊己庚辛', () => CODE)
      .replace('壬癸子丑', () => ['```mermaid', 'graph TD', '```'].join('\n'))
    await assertSource(evaluate, afterMermaid,
      `/mermaid must commit a mermaid fence whose empty content line is immediately typable (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)

    // ============================================================
    // 2c) `/math` — a `$$` block, the other preview-backed shape. Its
    //     delimiters are not a GFM fence, so it is its own insert target
    //     (BLOCK_INSERT_TARGETS.math) with its own reparse proof.
    // ============================================================
    await selectBlock(evaluate, send, '寅卯辰巳')
    await runSlashItem(evaluate, send, 'math', 'math', { activate: 'click' })

    const mathCaret = await caretHome(evaluate)
    console.log('  [/math] ->', JSON.stringify({ caret: mathCaret }))
    assert.ok(mathCaret && (mathCaret.kind === 'codemirror' || mathCaret.kind === 'code-block'),
      `the caret must land inside the new $$ block, got ${JSON.stringify(mathCaret)}`)
    assert.deepEqual(await evaluate(`(() => {
      const block = document.activeElement?.closest?.('.milkdown-code-block')
      if (!block) return null
      return {
        empty: (block.querySelector('.cm-content')?.textContent || '') === '',
        visible: !block.querySelector('.codemirror-host')?.classList.contains('hidden')
      }
    })()`), { empty: true, visible: true },
      'the caret must sit in the NEW, empty $$ block, with a VISIBLE CodeMirror')

    await typeTextLikeUser(send, 'E=mc^2', { delayMs: delay })
    await sleep(500)
    const afterMath = afterMermaid.replace('寅卯辰巳', () => ['$$', 'E=mc^2', '$$'].join('\n'))
    await assertSource(evaluate, afterMath,
      `/math must commit a $$ block whose empty content line is immediately typable (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)

    // ============================================================
    // 2d) `/js` INSIDE A BLOCKQUOTE (2026-08-22, the「引用内嵌套」report's
    //     insert half): every fence line carries the `> ` prefix, the quote
    //     survives in the projection, and the first keystroke fills AFTER
    //     the empty content line's own prefix (empty-code-insert's
    //     'fill-after-prefix' spelling) — never in front of it.
    // ============================================================
    await selectBlock(evaluate, send, '引用甲')
    await runSlashItem(evaluate, send, 'js', 'code:javascript')

    const quotedCaret = await caretHome(evaluate)
    console.log('  [/js in quote] ->', JSON.stringify({ caret: quotedCaret }))
    assert.ok(quotedCaret && (quotedCaret.kind === 'codemirror' || quotedCaret.kind === 'code-block'),
      `the caret must land inside the new quoted code block, got ${JSON.stringify(quotedCaret)}`)
    const quotedShape = await evaluate(`(() => {
      const quotes = [...((${VISIBLE_EDITOR})?.querySelectorAll('blockquote') || [])]
      return quotes.map((q) => !!q.querySelector('.cm-editor, .milkdown-code-block'))
    })()`)
    assert.deepEqual(quotedShape, [true],
      `the fence must PROJECT inside the surviving blockquote, got ${JSON.stringify(quotedShape)}`)

    await typeTextLikeUser(send, 'ab', { delayMs: delay })
    await sleep(500)
    const afterQuoted = afterMath.replace('> 引用甲', () => QUOTED_CODE)
    await assertSource(evaluate, afterQuoted,
      `/js inside a blockquote must commit a fully prefixed fence and the first keystroke must fill after the line's own prefix (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)

    // ============================================================
    // 3) `/image` (2026-08-20, caret-after family): the query becomes the
    //    literal `![]()`, the view renders Crepe's real image-block CARD
    //    (whose own upload/paste-link UI is the src entry point — it routes
    //    through the kernel-proven image-attrs.js), and the caret lands in
    //    the trailing placeholder so the very next keystroke commits a
    //    paragraph below the card. (Until this date the item was pinned
    //    DISABLED here — the atom had no proven caret home.)
    // ============================================================
    await selectBlock(evaluate, send, '尾段落。')
    await runSlashItem(evaluate, send, 'image', 'image')

    const imageCard = await evaluate(`(() => {
      const card = (${VISIBLE_EDITOR})?.querySelector('.milkdown-image-block, milkdown-image-block')
      if (!card) return null
      return { present: true, hasImg: !!card.querySelector('img[src]:not([src=""])') }
    })()`)
    console.log('  [/image] ->', JSON.stringify({ card: imageCard }))
    assert.ok(imageCard?.present, 'the committed ![]() must PROJECT as the image-block card in the view')
    assert.equal(imageCard.hasImg, false, 'the empty card must show its upload UI, not a broken <img>')
    await typeTextLikeUser(send, '图后段', { delayMs: delay })
    await sleep(400)
    // The replaced tail block keeps its own line ending ('![]()\n'); typing
    // in the trailing placeholder appends the separator plus the text and
    // never invents a NEW trailing ending.
    const afterImage = afterQuoted.replace('尾段落。\n', '![]()\n\n图后段')
    await assertSource(evaluate, afterImage,
      `/image must commit the literal ![]() and the follow-up keystroke must land below the card (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)

    // ============================================================
    // 4) Disk bytes. The source view normalizes line endings, so this is the
    //    only place a CRLF document is actually proven.
    // ============================================================
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    const disk = await readFile(file, 'utf8')
    const eol = (block) => block.split('\n').join(EOL)
    const expectedDisk = LINES.join(EOL)
      .replace('甲乙丙丁', () => eol(TABLE_TYPED))
      .replace('戊己庚辛', () => eol(CODE))
      .replace('壬癸子丑', () => eol(['```mermaid', 'graph TD', '```'].join('\n')))
      .replace('寅卯辰巳', () => eol(['$$', 'E=mc^2', '$$'].join('\n')))
      .replace('> 引用甲', () => eol(QUOTED_CODE))
      .replace('尾段落。' + EOL, () => eol('![]()\n\n图后段'))
    assert.equal(disk, expectedDisk, 'disk bytes must match the kernel-derived expectation exactly')
    if (crlf) {
      assert.equal(/(?<!\r)\n/.test(disk), false, 'a CRLF document must not gain a lone LF anywhere')
    }
    assert.equal(app.dialogs.length, 0,
      `no dialog may appear: ${JSON.stringify(app.dialogs.map((d) => d.message))}`)
    console.log(`PASS kernel-mode block-insert slash items UI regression (${crlf ? 'CRLF' : 'LF'}): /table, /js (top-level AND quoted), /mermaid, /math and /image commit their block bytes, project, and land a typable caret`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
