import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'
import { parseGfmTableSource } from '../src/renderer/src/lib/markdown-preservation/tables.js'

const externalFixture = process.env.HORSEMD_REPRO_FILE
const builtInDivergedFixture = [
  '# Table insertion regression',
  '',
  '| A | B | C | D |',
  '| --- | --- | --- | --- |',
  '| authored short row |',
  '| <br /> |  | authored break |',
  '| full | row | remains | stable |'
].join('\n') + '\n'

const root = `/tmp/horsemd-table-sequential-entry-${process.pid}`
const fixture = join(root, 'table-sequential-entry.md')
const recovery = join(root, 'table-sequential-entry.horsemd-recovered.md')
const port = Number(process.env.CDP_PORT || 10359)
const packagedLaunch = process.env.HORSEMD_APP_PATH
  ? { executable: process.env.HORSEMD_APP_PATH, entrypoint: null }
  : {}
const additionalLanguageBlocks = [
  '```javascript\nconst matcher = /a|b/g\nconsole.log(matcher.test("a"))\n```',
  '```python\nvalues = {"left": "a|b", "right": "c"}\nprint(values["left"])\n```',
  '```rust\nlet values = vec!["a|b", "c"];\nprintln!("{}", values[0]);\n```'
]

const waitFor = async (check, message, attempts = 120) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const click = async (app, point) => {
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}

const tableCells = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
  const tables = [...(editor?.querySelectorAll('.milkdown-table-block') || [])]
    .filter((node) => node.offsetParent !== null)
  const table = tables.at(-1)
  if (!table) return []
  table.scrollIntoView({ block: 'center' })
  return [...table.querySelectorAll('tbody tr')].flatMap((rowNode, row) =>
    [...rowNode.children].map((cell, column) => {
      const target = cell.querySelector('p') || cell
      const rect = target.getBoundingClientRect()
      return {
        row,
        column,
        point: {
          x: Math.round(rect.left + Math.min(14, rect.width / 2)),
          y: Math.round((rect.top + rect.bottom) / 2)
        }
      }
    })
  )
})()`)

const activeCell = (app) => app.evaluate(`(() => {
  const selection = getSelection()
  const anchor = selection?.anchorNode
  const element = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement
  const cell = element?.closest?.('td, th')
  const row = cell?.closest('tr')
  const table = row?.closest('.milkdown-table-block')
  const rows = [...(table?.querySelectorAll('tbody tr') || [])]
  return { row: rows.indexOf(row), column: row ? [...row.children].indexOf(cell) : -1 }
})()`)

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null
)`)

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const authored = externalFixture
    ? await readFile(externalFixture, 'utf8')
    : builtInDivergedFixture
  await writeFile(fixture, [
    authored.replace(/\n*$/, ''),
    ...additionalLanguageBlocks,
    'hm-table-insert-anchor',
    ''
  ].join('\n\n'))

  let app
  try {
    app = await launchBuiltElectron({
      ...packagedLaunch,
      profileDir: join(root, 'profile'),
      port,
      appArgs: [fixture],
      env: { ...process.env, HORSEMD_TEST_SAVE_AS_PATH: recovery }
    })
    await waitFor(
      () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null))`),
      'rich editor did not open'
    )
    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmGateLog = []
      window.__hmSlashIntentLog = []
      window.__hmSourceTransactionTrace = []
    })()`)
    await sleep(900)

    const anchor = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
      const paragraph = [...(editor?.querySelectorAll('p') || [])]
        .find((node) => node.textContent === 'hm-table-insert-anchor')
      paragraph?.scrollIntoView({ block: 'center' })
      const rect = paragraph?.getBoundingClientRect()
      return rect ? {
        x: Math.round(rect.right - 4),
        y: Math.round((rect.top + rect.bottom) / 2)
      } : null
    })()`)
    assert.ok(anchor, 'table insertion anchor is missing')
    await click(app, anchor)
    await pressKey(app.send, { key: 'End', code: 'End' })
    await pressKey(app.send, { key: 'Enter', code: 'Enter' })
    await typeTextLikeUser(app.send, '/table')
    const tableCommandIndex = await waitFor(
      () => app.evaluate(`(() => {
        const items = [...document.querySelectorAll('.milkdown-slash-menu[data-show="true"] .hm-slash-item')]
        const index = items.findIndex((node) => /表格|Table/i.test(node.textContent || ''))
        return index >= 0 ? index + 1 : null
      })()`),
      'table slash command did not appear'
    ) - 1
    for (let index = 0; index < tableCommandIndex; index += 1) {
      await pressKey(app.send, { key: 'ArrowDown', code: 'ArrowDown' })
    }
    await pressKey(app.send, { key: 'Enter', code: 'Enter' })
    try {
      await waitFor(async () => {
        const coordinates = await tableCells(app)
        return coordinates.length === 9 &&
          new Set(coordinates.map(({ row }) => row)).size === 3 &&
          [0, 1, 2].every((row) => coordinates.filter((cell) => cell.row === row).length === 3)
      }, 'slash command did not insert a 3x3 table')
    } catch (error) {
      const diagnostic = await app.evaluate(`({
        slash: (window.__hmSlashIntentLog || []).slice(-8),
        gate: (window.__hmGateLog || []).slice(-8),
        transactions: (window.__hmSourceTransactionTrace || []).slice(-4)
      })`)
      throw new Error(`${error.message}: ${JSON.stringify(diagnostic)}`)
    }
    await sleep(350)

    const cells = await tableCells(app)
    for (const cell of cells) {
      await click(app, cell.point)
      await click(app, cell.point)
      assert.deepEqual(await activeCell(app), { row: cell.row, column: cell.column }, `caret missed ${cell.row}:${cell.column}`)
      await typeTextLikeUser(app.send, `r${cell.row}c${cell.column}`)
      await sleep(180)
    }

    await waitFor(
      () => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`),
      'sequential table input did not mark the document dirty'
    )
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    const outcome = await waitFor(async () => {
      const dirty = await app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`)
      if (!dirty) return { saved: true, dirty: false }
      try {
        await readFile(recovery, 'utf8')
        return {
          recovery: true,
          dirty
        }
      } catch {}
      return null
    }, 'save neither completed nor wrote recovery')
    const diagnostics = await app.evaluate(`({
      preserve: (window.__hmPreserveLog || []).slice(-20).map((entry) => ({
        reason: entry.reason,
        preserved: entry.preserved
      })),
      gate: (window.__hmGateLog || []).slice(-20).map((entry) => ({
        origin: entry.origin,
        reason: entry.reason,
        type: entry.type,
        status: entry.status
      })),
      slash: (window.__hmSlashIntentLog || []).slice(-20)
    })`)
    assert.equal(
      Boolean(outcome.recovery && outcome.dirty),
      false,
      `sequential table input entered recovery: ${JSON.stringify({ outcome, diagnostics, dialogs: app.dialogs })}`
    )
    const saved = await readFile(fixture, 'utf8')
    assert.ok(
      saved.includes(authored.replace(/\n*$/, '')),
      'table insertion rewrote or dropped bytes from the complete pre-existing document'
    )
    for (const cell of cells) {
      assert.ok(saved.includes(`r${cell.row}c${cell.column}`), `saved source lost ${cell.row}:${cell.column}`)
    }
    for (const block of additionalLanguageBlocks) {
      assert.ok(saved.includes(block), `table save rewrote or lost a non-Go code block: ${block.split('\n', 1)[0]}`)
    }
    const model = parseGfmTableSource(saved)
    const insertedTable = model.tables.find((table) => (
      model.view.raw.slice(table.range.start, table.range.end).includes('r0c0')
    ))
    assert.ok(insertedTable, 'saved source has no independent table containing the entered cells')
    assert.equal(insertedTable.rows.length, 3, 'saved slash table is not three rows')
    assert.deepEqual(insertedTable.rows.map((row) => row.cells.length), [3, 3, 3], 'saved slash table is not 3×3')
    const insertedTableSource = model.view.raw.slice(insertedTable.range.start, insertedTable.range.end)
    assert.doesNotMatch(insertedTableSource, /<br\s*\/?>/i, 'saved slash table leaked serializer placeholders')

    assert.equal(await toggleSource(app), true, 'source mode toggle is unavailable after saving the table')
    await waitFor(async () => (await visibleSource(app)) != null, 'source mode did not open after saving the table')
    assert.equal(await visibleSource(app), saved, 'source mode differs from the verified saved bytes')
    assert.equal(app.dialogs.length, 0, 'sequential table input must not show recovery')

    await stopBuiltElectron(app, { removeProfile: true })
    app = null
    app = await launchBuiltElectron({
      ...packagedLaunch,
      profileDir: join(root, 'reopen-profile'),
      port: port + 1,
      appArgs: [fixture]
    })
    await waitFor(async () => (await tableCells(app)).length === 9, 'cold reopen lost the saved 3×3 table')
    const reopenedCells = await tableCells(app)
    assert.deepEqual(
      reopenedCells.map(({ row, column }) => [row, column]),
      cells.map(({ row, column }) => [row, column]),
      'cold reopen changed the table coordinate matrix'
    )
    assert.equal(await toggleSource(app), true, 'source mode toggle is unavailable after cold reopen')
    await waitFor(async () => (await visibleSource(app)) != null, 'cold reopen source mode did not open')
    assert.equal(await visibleSource(app), saved, 'cold reopen changed the verified source bytes')
    assert.equal(app.dialogs.length, 0, 'cold reopen must not show recovery')
    console.log('PASS sequential table entry: slash insert, every cell, save')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
