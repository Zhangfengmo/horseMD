// Kernel-mode TABLE OPERATIONS end-to-end UI regression: the table
// block-handle gestures the app actually offers — the boundary `+` buttons
// (add row / add column), the row/col drag-handles' delete buttons, and the
// column alignment button group — must WRITE SOURCE BYTES in kernel mode
// instead of being vetoed.
//
// The headless suite (scripts/test-source-kernel-tableops.mjs) proves the
// COMMANDS. This script proves the LIVE WIRING that no headless test can see:
// the command-slice re-registration (routeTableCommandsThroughKernel), the
// controller's selectedRect->raw-offset resolution through the projection
// map's tableCell pairs, and the real Vue table-block DOM whose pointermove/
// click choreography drives it all. Assertions per op: the SOURCE bytes (via
// the 源码 view), the projected DOM table (row/column counts + cell text),
// then undo/redo byte fidelity, the named LAST-ROW refusal (toast, bytes
// untouched), disk bytes after save, and a COLD RELAUNCH reparse.
//
// CRLF variant: `KERNEL_TABLEOPS_CRLF=1` (the disk assertion is what pins the
// endings — a textarea normalizes its value to LF).
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const crlf = process.env.KERNEL_TABLEOPS_CRLF === '1'
const EOL = crlf ? '\r\n' : '\n'
const root = `/tmp/horsemd-kernel-tableops-${process.pid}`
const file = join(root, 'tableops.md')
const port = Number(process.env.CDP_PORT || 12210)

const HEAD = ['# 表格测试', '']
const TAIL = ['', '尾段。', '']
const TABLE0 = ['| 甲 | 乙 |', '| --- | --- |', '| 丙 | 丁 |', '| 戊 | 己 |']
const docOf = (tableLines, eol) => [...HEAD, ...tableLines, ...TAIL].join(eol)
const FIXTURE = docOf(TABLE0, EOL)

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
    console.error('  diagnostics:', await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).slice(-8))`))
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

// The CONTENT table (Crepe's table node view renders a sizing shell too).
const tableShape = (evaluate) => evaluate(`(() => {
  const tables = [...((${VISIBLE_EDITOR})?.querySelectorAll('table') || [])]
  const table = tables.find((t) => t.querySelector('th, td'))
  if (!table) return null
  return {
    rows: [...table.querySelectorAll('tr')].map((r) => [...r.querySelectorAll('th, td')].map((c) => c.textContent))
  }
})()`)

// Viewport rect of cell (rowIndex, colIndex), scrolled into view first.
const cellRect = (evaluate, row, col) => evaluate(`(() => {
  const editor = ${VISIBLE_EDITOR}
  const tables = [...(editor?.querySelectorAll('table') || [])]
  const table = tables.find((t) => t.querySelector('th, td'))
  const tr = table?.querySelectorAll('tr')[${row}]
  const cell = tr?.children[${col}]
  if (!cell) return null
  cell.scrollIntoView({ block: 'center' })
  const r = cell.getBoundingClientRect()
  return r.width ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null
})()`)

// Human-paced: the handle elements are re-rendered by Vue around pointer
// activity, and a zero-delay moved/pressed/released burst can straddle such a
// re-render — Chromium then never synthesizes the `click` the handle's
// onClick needs (measured: down/up fire on the svg, click never does).
async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await sleep(80)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

// Handle queries MUST be scoped to the VISIBLE editor: every mounted tab
// (the welcome document included) renders its own table block with its own
// handle elements, so an unscoped document.querySelector finds a hidden
// tab's handle first and waits on it forever.
const HANDLE = (role) => `(${VISIBLE_EDITOR})?.querySelector('.milkdown-table-block [data-role="${role}"]')`

// Hover a point until the given handle is shown AND its position is STABLE
// across two consecutive polls, then return the target rect center. The
// table-block component throttles pointermove (20ms) and positions handles
// through floating-ui's async computePosition — `data-show` flips BEFORE the
// position style lands, so a click taken on the first sighting can hit the
// handle's stale (or zero) position and land in the document instead.
async function hoverForStableHandle(evaluate, send, point, role, buttonSelector, message) {
  let previous = null
  return waitFor(async () => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await sleep(80)
    const current = await evaluate(`(() => {
      const handle = ${HANDLE(role)}
      if (!handle || handle.dataset.show !== 'true') return null
      const target = ${JSON.stringify(buttonSelector)} ? handle.querySelector(${JSON.stringify(buttonSelector)}) : handle
      if (!target) return null
      const r = target.getBoundingClientRect()
      return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
    })()`)
    if (current && previous && current.x === previous.x && current.y === previous.y) return current
    previous = current
    return null
  }, message, 40)
}

// The `+` button on a ROW boundary: hover just above the top edge (or just
// below the bottom edge) of a cell, inside the 8px boundary band.
async function addRowAt(evaluate, send, row, edge) {
  const rect = await waitFor(() => cellRect(evaluate, row, 0), `cell (${row},0) not found`)
  const x = rect.left + (rect.right - rect.left) / 2
  const y = edge === 'top' ? rect.top + 3 : rect.bottom - 3
  const button = await hoverForStableHandle(evaluate, send, { x, y }, 'x-line-drag-handle', 'button.add-button',
    `add-row handle did not appear at row ${row} ${edge}`)
  await click(send, button)
  await sleep(700)
}

// The `+` button on a COLUMN boundary.
async function addColAt(evaluate, send, col, edge) {
  const rect = await waitFor(() => cellRect(evaluate, 0, col), `cell (0,${col}) not found`)
  const y = rect.top + (rect.bottom - rect.top) / 2
  const x = edge === 'left' ? rect.left + 3 : rect.right - 3
  const button = await hoverForStableHandle(evaluate, send, { x, y }, 'y-line-drag-handle', 'button.add-button',
    `add-col handle did not appear at col ${col} ${edge}`)
  await click(send, button)
  await sleep(700)
}

// Open a drag handle's button group: hover the cell CENTER (away from every
// boundary band) until the handle shows at a stable position, click the
// handle, wait for its button group.
//
// RETRIED: the table-block component arms an UNCANCELLED 200ms hide-all
// timer on every wrapper pointer-leave (createPointerLeaveHandler) and
// repositions handles through late-resolving computePosition promises, so a
// handle can legitimately vanish between "measured stable" and "pressed"
// (measured: the pressed event then lands in the cell underneath). A real
// user shrugs and clicks again — so does this driver: an attempt whose
// button group never opens is retried from the hover.
async function openHandleButtons(evaluate, send, row, col, role, message) {
  let lastError = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rect = await waitFor(() => cellRect(evaluate, row, col), `cell (${row},${col}) not found`)
    const center = {
      x: rect.left + (rect.right - rect.left) / 2,
      y: rect.top + (rect.bottom - rect.top) / 2
    }
    const handle = await hoverForStableHandle(evaluate, send, center, role, null,
      `${message}: handle did not appear`)
    await click(send, handle)
    try {
      return await waitFor(() => evaluate(`(() => {
        const handle = ${HANDLE(role)}
        const group = handle?.querySelector('.button-group')
        if (!group || group.dataset.show !== 'true') return null
        const buttons = [...group.querySelectorAll('button')].map((b) => {
          const r = b.getBoundingClientRect()
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }
        })
        return buttons.length && buttons.every((b) => b.w) ? buttons : null
      })()`), `${message}: button group did not open`, 12)
    } catch (error) {
      lastError = error
      // Park the pointer outside the table so the next hover is a fresh
      // enter, then let the component's own 200ms hide timer lapse.
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
      await sleep(400)
    }
  }
  console.error('  state:', await evaluate(`JSON.stringify({
    show: (${HANDLE(role)})?.dataset.show,
    group: (${HANDLE(role)})?.querySelector('.button-group')?.dataset.show,
    selectedCells: (${VISIBLE_EDITOR})?.querySelectorAll('.selectedCell').length,
    diagnostics: (window.__hmKernelDiagnostics || []).slice(-6)
  })`))
  throw lastError
}

// Row handle -> the single delete button.
async function deleteRowAt(evaluate, send, row) {
  const buttons = await openHandleButtons(evaluate, send, row, 0, 'row-drag-handle', `delete row ${row}`)
  assert.equal(buttons.length, 1, 'the row button group holds exactly the delete button')
  await click(send, buttons[0])
  await sleep(700)
}

// Col handle -> [align-left, align-center, align-right, delete].
async function colButtons(evaluate, send, col) {
  const buttons = await openHandleButtons(evaluate, send, 1, col, 'col-drag-handle', `col ${col} buttons`)
  assert.equal(buttons.length, 4, 'the col button group holds align x3 + delete')
  return buttons
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
      return text && text.includes('尾段。') && text.includes('戊') ? text : null
    }, 'initial document did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on plain mount')

    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('戊') ? text : null
    }, 'document did not remount after enabling kernel mode')
    await sleep(300)
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy for this fixture: ${attachDiagnostics}`)

    // ============================================================
    // A) ADD ROW below the last body row (the boundary `+` button), then
    //    TYPE into the new row's first cell — the caret proof that the row
    //    this op wrote is immediately editable (the same `|  |` padding
    //    convention the /table skeleton relies on).
    // ============================================================
    await addRowAt(evaluate, send, 2, 'bottom')
    const afterA = ['| 甲 | 乙 |', '| --- | --- |', '| 丙 | 丁 |', '| 戊 | 己 |', '|  |  |']
    assert.deepEqual((await tableShape(evaluate))?.rows,
      [['甲', '乙'], ['丙', '丁'], ['戊', '己'], ['', '']],
      'add-row must project a 4-row table')
    await assertSource(evaluate, docOf(afterA, '\n'), 'add-row bytes')

    // Two clicks: the table nodeview turns the first click on a cell into a
    // cell NodeSelection; the second places the text caret.
    for (let i = 0; i < 2; i += 1) {
      const rect = await waitFor(() => cellRect(evaluate, 3, 0), 'new row cell not found')
      await click(send, {
        x: rect.left + (rect.right - rect.left) / 2,
        y: rect.top + (rect.bottom - rect.top) / 2
      })
      await sleep(250)
    }
    await send('Input.insertText', { text: '新' })
    await sleep(120)
    await send('Input.insertText', { text: '增' })
    await sleep(400)
    const afterA2 = ['| 甲 | 乙 |', '| --- | --- |', '| 丙 | 丁 |', '| 戊 | 己 |', '| 新增 |  |']
    await assertSource(evaluate, docOf(afterA2, '\n'), 'typing in the added row must land between its pipes')

    // ============================================================
    // B) ADD COLUMN to the right of the last column.
    // ============================================================
    await addColAt(evaluate, send, 1, 'right')
    const afterB = ['| 甲 | 乙 |  |', '| --- | --- | --- |', '| 丙 | 丁 |  |', '| 戊 | 己 |  |', '| 新增 |  |  |']
    assert.deepEqual((await tableShape(evaluate))?.rows,
      [['甲', '乙', ''], ['丙', '丁', ''], ['戊', '己', ''], ['新增', '', '']],
      'add-col must project a 3-column table')
    await assertSource(evaluate, docOf(afterB, '\n'), 'add-col bytes')

    // ============================================================
    // C) ALIGN column 0 -> center (the col handle's button group).
    // ============================================================
    {
      const buttons = await colButtons(evaluate, send, 0)
      await click(send, buttons[1])
      await sleep(700)
    }
    const afterC = ['| 甲 | 乙 |  |', '| :---: | --- | --- |', '| 丙 | 丁 |  |', '| 戊 | 己 |  |', '| 新增 |  |  |']
    await assertSource(evaluate, docOf(afterC, '\n'), 'align bytes (delimiter cell only)')
    const alignedCell = await evaluate(`(() => {
      const tables = [...((${VISIBLE_EDITOR})?.querySelectorAll('table') || [])]
      const table = tables.find((t) => t.querySelector('th, td'))
      const th = table?.querySelector('th')
      return th ? (th.getAttribute('align') || th.style.textAlign || th.getAttribute('data-align') || '') : null
    })()`)
    assert.ok(String(alignedCell).includes('center'),
      `the projected header cell must carry the center alignment, got ${JSON.stringify(alignedCell)}`)

    // ============================================================
    // D) DELETE the row added (and filled) in A (row drag handle -> delete).
    // ============================================================
    await deleteRowAt(evaluate, send, 3)
    const afterD = ['| 甲 | 乙 |  |', '| :---: | --- | --- |', '| 丙 | 丁 |  |', '| 戊 | 己 |  |']
    assert.deepEqual((await tableShape(evaluate))?.rows,
      [['甲', '乙', ''], ['丙', '丁', ''], ['戊', '己', '']], 'delete-row must project 3 rows')
    await assertSource(evaluate, docOf(afterD, '\n'), 'delete-row bytes')

    // ============================================================
    // E) DELETE the column added in B (col handle -> delete button).
    // ============================================================
    {
      const buttons = await colButtons(evaluate, send, 2)
      await click(send, buttons[3])
      await sleep(700)
    }
    const afterE = ['| 甲 | 乙 |', '| :---: | --- |', '| 丙 | 丁 |', '| 戊 | 己 |']
    assert.deepEqual((await tableShape(evaluate))?.rows,
      [['甲', '乙'], ['丙', '丁'], ['戊', '己']], 'delete-col must project 2 columns')
    await assertSource(evaluate, docOf(afterE, '\n'), 'delete-col bytes')

    // ============================================================
    // F) UNDO restores the deleted column's bytes; REDO removes them again.
    //    (Kernel history, not prosemirror-history.)
    // ============================================================
    await evaluate(`(${VISIBLE_EDITOR})?.focus()`)
    await pressKey(send, { key: 'z', code: 'KeyZ', modifiers: 4 })
    await sleep(500)
    await assertSource(evaluate, docOf(afterD, '\n'), 'undo must restore the deleted column byte-for-byte')
    await pressKey(send, { key: 'z', code: 'KeyZ', modifiers: 12 })
    await sleep(500)
    await assertSource(evaluate, docOf(afterE, '\n'), 'redo must re-apply the column delete')

    // ============================================================
    // G) DELETE row 戊己, then attempt to delete the ONLY remaining body row:
    //    the named LAST-ROW refusal — toast up, bytes untouched.
    // ============================================================
    await deleteRowAt(evaluate, send, 2)
    const afterG = ['| 甲 | 乙 |', '| :---: | --- |', '| 丙 | 丁 |']
    await assertSource(evaluate, docOf(afterG, '\n'), 'second delete-row bytes')
    await deleteRowAt(evaluate, send, 1)
    const toast = await waitFor(() => evaluate(`document.querySelector('.hm-toast .hm-toast-msg')?.textContent || null`),
      'deleting the only body row must raise the named refusal toast')
    assert.ok(/内容行|body row/.test(toast), `the toast must be the table-last-row message, got ${JSON.stringify(toast)}`)
    assert.deepEqual((await tableShape(evaluate))?.rows,
      [['甲', '乙'], ['丙', '丁']], 'the refused delete must not change the view')
    await assertSource(evaluate, docOf(afterG, '\n'), 'the refused delete must not change the bytes')

    // ============================================================
    // H) SAVE -> disk bytes (the only place CRLF is really proven).
    // ============================================================
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    const disk = await readFile(file, 'utf8')
    const expectedDisk = docOf(afterG, EOL)
    assert.equal(disk, expectedDisk, 'disk bytes must match the kernel-derived expectation exactly')
    if (crlf) {
      assert.equal(/(?<!\r)\n/.test(disk), false, 'a CRLF document must not gain a lone LF anywhere')
    }
    assert.equal(app.dialogs.length, 0,
      `no dialog may appear: ${JSON.stringify(app.dialogs.map((d) => d.message))}`)

    // ============================================================
    // I) COLD RELAUNCH: the saved table reparses to the same structure.
    // ============================================================
    await stopBuiltElectron(app, { removeProfile: false })
    app = null
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port: port + 1, appArgs: [file] })
    const relaunched = app
    await waitFor(async () => {
      const text = await relaunched.evaluate(`(${VISIBLE_EDITOR})?.textContent`)
      return text && text.includes('丙') && text.includes('尾段。') ? text : null
    }, 'document did not remount after cold relaunch')
    await sleep(400)
    assert.deepEqual((await tableShape(relaunched.evaluate))?.rows,
      [['甲', '乙'], ['丙', '丁']], 'the relaunched app must reparse the same table')
    const relaunchAlign = await relaunched.evaluate(`(() => {
      const tables = [...((${VISIBLE_EDITOR})?.querySelectorAll('table') || [])]
      const table = tables.find((t) => t.querySelector('th, td'))
      const th = table?.querySelector('th')
      return th ? (th.getAttribute('align') || th.style.textAlign || th.getAttribute('data-align') || '') : null
    })()`)
    assert.ok(String(relaunchAlign).includes('center'), 'the saved alignment must survive the relaunch')
    assert.equal(relaunched.dialogs.length, 0, 'no dialog on relaunch')

    console.log(`PASS kernel-mode table operations UI regression (${crlf ? 'CRLF' : 'LF'}): the block-handle add-row/add-col buttons, the row/col delete buttons and the alignment group write source bytes; undo/redo, the last-row refusal, save and cold relaunch hold byte-for-byte`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
