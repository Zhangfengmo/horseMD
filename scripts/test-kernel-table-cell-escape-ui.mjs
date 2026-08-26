// Kernel-mode TABLE CELL ESCAPE end-to-end UI regression (D2).
//
// `table-map.js` used to refuse a cell holding ANY `escape` unit. Measured
// across 197 real documents (scripts/measure-kernel-readonly-causes.mjs) that
// single guard owned 330 read-only blocks — 63.7% of the whole read-only
// surface — because remark-stringify writes `claude\-haiku\-4\.5` and `4\.00`
// inside cells as a matter of routine. Those are ORDINARY CommonMark escapes;
// only `\|` carries the GFM-table-specific decode (a cell unescapes it into a
// literal `|` BEFORE inline parsing, even inside a code span). The guard is
// now `\|`-shaped.
//
// The headless suite (scripts/test-source-kernel-tablemap.mjs, Case 11) proves
// the MAP. This script proves what no headless test can see: that a real
// keystroke in the shipped kernel actually lands in such a cell, byte-exactly,
// without disturbing the escape — and that the `\|` cell in the SAME table is
// still refused (per-cell degrade), with its sibling still typable.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-cell-escape-${process.pid}`
const file = join(root, 'prices.md')
const port = Number(process.env.CDP_PORT || 10841)

// Row 1 is the shape measured in ~/Downloads/灵影网关模型价格清单.md (which lost
// 110 of its 111 cells to the blanket guard). Row 2's first cell is the
// NEGATIVE CONTROL: `\|` must stay read-only while its sibling stays typable.
const HEAD = ['# 价格清单', '']
const TAIL = ['', '尾段。', '']
const docOf = (rows) => [...HEAD,
  '| 模型 | 单价 |',
  '| --- | --- |',
  ...rows,
  ...TAIL].join('\n')

const ROWS0 = ['| claude\\-haiku\\-4\\.5 | 4\\.00 |', '| a\\|b | 1\\.50 |']
const FIXTURE = docOf(ROWS0)

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
  await sleep(200)
  return shown
}

async function assertSource(evaluate, expected, message) {
  const actual = await readSource(evaluate, message)
  if (actual !== expected) {
    console.error('  actual  :', JSON.stringify(actual))
    console.error('  expected:', JSON.stringify(expected))
    console.error('  diagnostics:', await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`))
  }
  assert.equal(actual, expected, message)
}

const tableShape = (evaluate) => evaluate(`(() => {
  const tables = [...((${VISIBLE_EDITOR})?.querySelectorAll('table') || [])]
  const table = tables.find((t) => t.querySelector('th, td'))
  if (!table) return null
  return [...table.querySelectorAll('tr')]
    .map((r) => [...r.querySelectorAll('th, td')].map((c) => c.textContent))
})()`)

const cellRect = (evaluate, row, col) => evaluate(`(() => {
  const tables = [...((${VISIBLE_EDITOR})?.querySelectorAll('table') || [])]
  const table = tables.find((t) => t.querySelector('th, td'))
  const tr = table?.querySelectorAll('tr')[${row}]
  const cell = tr?.children[${col}]
  if (!cell) return null
  cell.scrollIntoView({ block: 'center' })
  const r = cell.getBoundingClientRect()
  return r.width ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null
})()`)

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await sleep(80)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

// Place the caret at the END of a cell's text. Two clicks: the table node view
// turns the first click on a cell into a cell NodeSelection, the second places
// the text caret. `End` is a REAL keydown (Input.insertText produces none).
async function caretAtCellEnd(evaluate, send, row, col) {
  for (let i = 0; i < 2; i += 1) {
    const rect = await waitFor(() => cellRect(evaluate, row, col), `cell (${row},${col}) not found`)
    await click(send, {
      x: rect.left + (rect.right - rect.left) / 2,
      y: rect.top + (rect.bottom - rect.top) / 2
    })
    await sleep(250)
  }
  await pressKey(send, { key: 'End', code: 'End' })
  await sleep(150)
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)
  let app
  try {
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true
    })
    const { evaluate, send } = app
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('尾段。') && text.includes('claude-haiku-4.5') ? text : null
    }, 'initial document did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on plain mount')

    // ============================================================
    // A) The kernel must be ATTACHED (kernelDefault: true, no toggle).
    // ============================================================
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`),
      'kernel mode is not the default for this tab')
    await sleep(300)
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy for this fixture: ${attachDiagnostics}`)

    // The escapes are DECODED in the projection — the map's business is that
    // the two raw bytes count as one visible character.
    assert.deepEqual(await tableShape(evaluate),
      [['模型', '单价'], ['claude-haiku-4.5', '4.00'], ['a|b', '1.50']],
      'the fixture must project its decoded cell text')

    // ============================================================
    // B) TYPE into the `\-`/`\.`-bearing cell. Before D2 this keystroke was
    //    swallowed (read-only cell); it must now land as a byte edit that
    //    leaves every escape byte untouched.
    // ============================================================
    await caretAtCellEnd(evaluate, send, 1, 0)
    await send('Input.insertText', { text: 'X' })
    await sleep(500)
    const afterB = ['| claude\\-haiku\\-4\\.5X | 4\\.00 |', '| a\\|b | 1\\.50 |']
    await assertSource(evaluate, docOf(afterB),
      'typing at the end of an escaped cell must append one byte and preserve every escape')

    // ============================================================
    // C) TYPE into the `4\.00` cell (the escape is INTERIOR here).
    // ============================================================
    await caretAtCellEnd(evaluate, send, 1, 1)
    await send('Input.insertText', { text: '9' })
    await sleep(500)
    const afterC = ['| claude\\-haiku\\-4\\.5X | 4\\.009 |', '| a\\|b | 1\\.50 |']
    await assertSource(evaluate, docOf(afterC),
      'typing after an interior escape must not disturb it')

    // ============================================================
    // D) NEGATIVE CONTROL — the `\|` cell is STILL read-only. The keystroke
    //    is swallowed (fail-closed veto): neither the view nor the bytes move.
    // ============================================================
    await caretAtCellEnd(evaluate, send, 2, 0)
    await send('Input.insertText', { text: 'Z' })
    await sleep(500)
    assert.deepEqual(await tableShape(evaluate),
      [['模型', '单价'], ['claude-haiku-4.5X', '4.009'], ['a|b', '1.50']],
      'the refused keystroke must not reach the view either')
    await assertSource(evaluate, docOf(afterC),
      'a `\\|` cell must stay read-only — the narrowing is not a removal')

    // ============================================================
    // E) PER-CELL degrade: the `\|` cell's SIBLING in the same row is typable.
    // ============================================================
    await caretAtCellEnd(evaluate, send, 2, 1)
    await send('Input.insertText', { text: '7' })
    await sleep(500)
    const afterE = ['| claude\\-haiku\\-4\\.5X | 4\\.009 |', '| a\\|b | 1\\.507 |']
    await assertSource(evaluate, docOf(afterE),
      'a read-only cell must degrade ALONE — its row sibling stays editable')

    // ============================================================
    // F) SAVE -> disk bytes.
    // ============================================================
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    assert.equal(await readFile(file, 'utf8'), docOf(afterE),
      'disk bytes must match the kernel-derived expectation exactly')
    assert.equal(app.dialogs.length, 0,
      `no dialog may appear: ${JSON.stringify(app.dialogs.map((d) => d.message))}`)

    // ============================================================
    // G) COLD RELAUNCH: the saved escapes reparse to the same table.
    // ============================================================
    await stopBuiltElectron(app, { removeProfile: false })
    app = null
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile'), port: port + 1, appArgs: [file], kernelDefault: true
    })
    const relaunched = app
    await waitFor(async () => {
      const text = await relaunched.evaluate(`(${VISIBLE_EDITOR})?.textContent`)
      return text && text.includes('尾段。') && text.includes('claude-haiku-4.5X') ? text : null
    }, 'document did not remount after cold relaunch')
    await sleep(400)
    assert.deepEqual(await tableShape(relaunched.evaluate),
      [['模型', '单价'], ['claude-haiku-4.5X', '4.009'], ['a|b', '1.507']],
      'the relaunched app must reparse the same table')
    assert.equal(await readFile(file, 'utf8'), docOf(afterE),
      'a cold reopen must not rewrite a single byte')

    console.log('PASS kernel table-cell escape UI: ordinary CommonMark escapes in a GFM cell are typable byte-exactly; `\\|` stays read-only per cell')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: false })
    await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
