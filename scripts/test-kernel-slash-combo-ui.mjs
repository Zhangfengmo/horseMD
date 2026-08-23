// Kernel-mode slash-item COMBINATION UI regression (2026-08-23, the
// 「接续列表」report's follow-up sweep): every slash item that is USABLE on a
// MID-QUOTE query line (following quote lines exist — the exact shape the
// provenSpanEnd fix opened for /task) is driven through the real app with the
// full combination a writer actually performs afterwards:
//   insert -> type a label with CJK + digits + an INNER SPACE -> (code) a
//   literal Tab -> (table) Tab cell navigation -> Backspace deletions -> save
//   -> disk byte comparison -> cold reopen (fresh process) -> re-attach.
// Invariants on top of the byte assertions: the diagnostics may not contain a
// single unclassified-transaction / attach-unmappable /
// split-placeholder-unprovable across the whole session.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const crlf = process.env.KERNEL_COMBO_CRLF === '1'
const EOL = crlf ? '\r\n' : '\n'
const delay = 40
const port = Number(process.env.CDP_PORT || 10196)

const LINES = [
  '开头段。',
  '',
  '> 查甲',
  '>',
  '> 查乙',
  '>',
  '> 查丙',
  '>',
  '> 查丁',
  '>',
  '> 查戊',
  '>',
  '> 查己',
  '>',
  '> 查庚',
  '>',
  '> 尾巴',
  '',
  '末段。',
  ''
]
const FIXTURE = LINES.join(EOL)
const FIXTURE_LF = LINES.join('\n')

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`

async function waitFor(fn, message, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

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

const selectionNonEmpty = (evaluate) =>
  evaluate(`(() => { const s = window.getSelection(); return !!s && s.toString().length > 0 })()`)

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

async function runSlashItem(evaluate, send, query, id) {
  await typeTextLikeUser(send, '/' + query, { delayMs: delay })
  await waitFor(() => evaluate(`document.querySelectorAll('.milkdown-slash-menu[data-show="true"] .hm-slash-item').length > 0`),
    `slash menu did not open for the /${query} query`, 25)
  const state = await waitFor(() => evaluate(`(() => {
    const li = document.querySelector('.milkdown-slash-menu[data-show="true"] .hm-slash-item[data-id=${JSON.stringify(id)}]')
    if (!li) return null
    return { disabled: li.classList.contains('disabled'), first: document.querySelector('.milkdown-slash-menu[data-show="true"] .hm-slash-item')?.dataset.id }
  })()`), `the '${id}' item never appeared for the /${query} query`)
  assert.equal(state.disabled, false, `the '${id}' slash item must be ENABLED`)
  assert.equal(state.first, id, `the /${query} query must rank '${id}' first (got ${state.first})`)
  await pressKey(send, { key: 'Enter', code: 'Enter' })
  await sleep(600)
}

const backspace = async (send, n) => {
  for (let i = 0; i < n; i += 1) {
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(250)
  }
}

async function run() {
  const root = `/tmp/horsemd-slash-combo-${crlf ? 'crlf' : 'lf'}-${process.pid}`
  const file = join(root, 'combo.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)

  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${VISIBLE_EDITOR})?.textContent?.includes('尾巴')`), 'mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel mode')
    await sleep(600)

    // 1) /ol on 查甲 (mid-quote), label with digit + inner space, then two
    //    Backspaces (the second removes the space — never a trailing space
    //    left at the block end).
    await selectBlock(evaluate, send, '查甲')
    await runSlashItem(evaluate, send, 'ol', 'ordered')
    await typeTextLikeUser(send, '甲1 乙', { delayMs: delay })
    await backspace(send, 2)

    // 2) /ul on 查乙.
    await selectBlock(evaluate, send, '查乙')
    await runSlashItem(evaluate, send, 'ul', 'bullet')
    await typeTextLikeUser(send, '乙1 丙', { delayMs: delay })
    await backspace(send, 2)

    // 3) /h2 on 查丙.
    await selectBlock(evaluate, send, '查丙')
    await runSlashItem(evaluate, send, 'h2', 'h2')
    await typeTextLikeUser(send, '题1 乙', { delayMs: delay })
    await backspace(send, 2)

    // 4) /task on 查丁 — the fixed shape itself: the label's first character
    //    dissolves the seed, the following quote lines survive.
    await selectBlock(evaluate, send, '查丁')
    await runSlashItem(evaluate, send, 'task', 'task')
    await typeTextLikeUser(send, '任1 乙', { delayMs: delay })
    await backspace(send, 2)

    // 5) /js on 查戊: type, literal Tab INSIDE CodeMirror, more text, then
    //    Backspace both back out (the tab byte must delete like any char).
    await selectBlock(evaluate, send, '查戊')
    await runSlashItem(evaluate, send, 'js', 'code:javascript')
    await typeTextLikeUser(send, 'c1', { delayMs: delay })
    await pressKey(send, { key: 'Tab', code: 'Tab' })
    await sleep(300)
    await typeTextLikeUser(send, '乙', { delayMs: delay })
    await backspace(send, 2)

    // 6) /math on 查己.
    await selectBlock(evaluate, send, '查己')
    await runSlashItem(evaluate, send, 'math', 'math')
    await typeTextLikeUser(send, 'E1 乙', { delayMs: delay })
    await backspace(send, 2)

    // 7) /table on 查庚: first header cell, Tab NAVIGATES (zero bytes), type
    //    in the second cell, Backspace trims it.
    await selectBlock(evaluate, send, '查庚')
    await runSlashItem(evaluate, send, 'table', 'table')
    await typeTextLikeUser(send, '表1', { delayMs: delay })
    await pressKey(send, { key: 'Tab', code: 'Tab' })
    await sleep(300)
    await typeTextLikeUser(send, '格2', { delayMs: delay })
    await backspace(send, 1)

    const TABLE = ['| 表1 | 格 |  |', '| --- | --- | --- |', '|  |  |  |'].join('\n')
    const expected = FIXTURE_LF
      .replace('> 查甲', '> 1. 甲1')
      .replace('> 查乙', '> - 乙1')
      .replace('> 查丙', '> ## 题1')
      .replace('> 查丁', '> - [ ] 任1')
      .replace('> 查戊', () => ['> ```javascript', '> c1', '> ```'].join('\n'))
      .replace('> 查己', () => ['> $$', '> E1', '> $$'].join('\n'))
      .replace('> 查庚', () => '> ' + TABLE.split('\n').join('\n> '))
    await assertSource(evaluate, expected,
      `the combined mid-quote inserts + typing + deletions must land exactly (diagnostics: ${await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`)})`)

    // Invariants: nothing in the whole session fell through to an
    // unclassified transaction or an unprovable projection.
    const diag = await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).map((d) => d.type))`)
    for (const bad of ['unclassified-transaction', 'attach-unmappable', 'split-placeholder-unprovable']) {
      assert.ok(!diag.includes(bad), `${bad} must never appear: ${diag}`)
    }

    // 8) Save; the disk carries the document's own endings.
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    const disk = await readFile(file, 'utf8')
    const expectedDisk = crlf ? expected.replace(/\n/g, '\r\n') : expected
    assert.equal(disk, expectedDisk, 'disk bytes must match the source view expectation in the document ending')
    if (crlf) assert.equal(/(?<!\r)\n/.test(disk), false, 'no lone LF on a CRLF disk')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }

  // 9) COLD REOPEN: a fresh process must re-attach the kernel on the saved
  //    bytes and re-render every block (checkbox included) from disk.
  const app2 = await launchBuiltElectron({ profileDir: join(`/tmp/horsemd-slash-combo-${crlf ? 'crlf' : 'lf'}-${process.pid}`, 'profile2'), port: port + 2, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate } = app2
    await waitFor(() => evaluate(`(${VISIBLE_EDITOR})?.textContent?.includes('题1')`), 'reopen mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'reopen kernel attach')
    const shape = await evaluate(`(() => {
      const q = [...((${VISIBLE_EDITOR})?.querySelectorAll('blockquote') || [])][0]
      if (!q) return null
      return {
        h2: !!q.querySelector('h2'),
        checkbox: !!q.querySelector('.milkdown-list-item-block .label.unchecked'),
        code: !!q.querySelector('.cm-editor, .milkdown-code-block'),
        table: !!q.querySelector('table'),
        tail: q.textContent.includes('尾巴')
      }
    })()`)
    assert.deepEqual(shape, { h2: true, checkbox: true, code: true, table: true, tail: true },
      `cold reopen must re-render every inserted block inside the quote: ${JSON.stringify(shape)}`)
  } finally {
    await stopBuiltElectron(app2, { removeProfile: true })
    await rm(`/tmp/horsemd-slash-combo-${crlf ? 'crlf' : 'lf'}-${process.pid}`, { recursive: true, force: true })
  }

  console.log(`PASS kernel slash-combo (${crlf ? 'CRLF' : 'LF'}): every usable slash item works MID-QUOTE with following lines, survives typing (CJK+digit+space), literal Tab / cell navigation and Backspace deletions, saves byte-exactly and cold-reopens intact`)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
