import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const externalFixture = process.env.HORSEMD_REPRO_FILE
assert.ok(externalFixture, 'HORSEMD_REPRO_FILE must point to a recovery Markdown file')

const root = `/tmp/horsemd-table-recovery-copy-${process.pid}`
const fixture = join(root, 'recovery-copy.md')
const secondRecovery = join(root, 'recovery-copy.horsemd-recovered.md')
const port = Number(process.env.CDP_PORT || 10358)

const waitFor = async (check, message, attempts = 100) => {
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

const emptyCellTargets = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
  const tables = [...(editor?.querySelectorAll('.milkdown-table-block') || [])]
    .filter((node) => node.offsetParent !== null)
  const table = tables.at(-1)
  if (!table) return []
  table.scrollIntoView({ block: 'center' })
  return [...table.querySelectorAll('tbody tr')].flatMap((rowNode, row) =>
    [...rowNode.children].flatMap((cell, column) => {
      if (row === 0) return []
      if ((cell.textContent || '').trim()) return []
      const target = cell.querySelector('p') || cell
      const rect = target.getBoundingClientRect()
      if (!rect.width || !rect.height) return []
      return [{
        row,
        column,
        html: cell.innerHTML,
        point: {
          x: Math.round(rect.left + Math.min(14, rect.width / 2)),
          y: Math.round((rect.top + rect.bottom) / 2)
        }
      }]
    })
  )
})()`)

const placeCaretInCell = async (app, target) => {
  await click(app, target.point)
  await click(app, target.point)
  return app.evaluate(`(() => {
    const selection = getSelection()
    const anchor = selection?.anchorNode
    const element = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement
    const cell = element?.closest?.('td, th')
    const row = cell?.closest('tr')
    const table = row?.closest('.milkdown-table-block')
    const rows = [...(table?.querySelectorAll('tbody tr') || [])]
    return {
      row: rows.indexOf(row),
      column: row ? [...row.children].indexOf(cell) : -1
    }
  })()`)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const externalOriginal = await readFile(externalFixture)
  await writeFile(fixture, externalOriginal, { flag: 'wx' })
  assert.equal((await lstat(fixture)).isSymbolicLink(), false, 'temporary recovery fixture must be a regular file')
  const original = externalOriginal.toString('utf8')
  let app
  try {
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile'),
      port,
      appArgs: [fixture],
      env: { ...process.env, HORSEMD_TEST_SAVE_AS_PATH: secondRecovery }
    })
    await waitFor(
      () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null))`),
      'rich editor did not open the recovery copy'
    )
    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmGateLog = []
    })()`)
    await sleep(900)

    await emptyCellTargets(app)
    await sleep(300)
    const targets = await emptyCellTargets(app)
    assert.ok(targets.length >= 2, `recovery copy needs at least two visually empty cells: ${JSON.stringify(targets)}`)
    for (const [index, target] of targets.slice(0, 4).entries()) {
      const active = await placeCaretInCell(app, target)
      assert.deepEqual(active, { row: target.row, column: target.column }, `caret missed recovery table cell ${index}`)
      await typeTextLikeUser(app.send, `r${target.row}c${target.column}`)
      await sleep(250)
    }
    await waitFor(
      () => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`),
      'table edits did not mark the recovery copy dirty'
    )

    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    const outcome = await waitFor(async () => {
      try {
        const recovery = await readFile(secondRecovery, 'utf8')
        return { recovery }
      } catch {}
      return await app.evaluate(`!document.querySelector('.hm-save-fab')`) ? { saved: true } : null
    }, 'save neither completed nor wrote a second recovery copy')
    const diagnostics = await app.evaluate(`({
      preserve: (window.__hmPreserveLog || []).slice(-12),
      gate: (window.__hmGateLog || []).slice(-12)
    })`)
    assert.equal(
      outcome.recovery,
      undefined,
      `opening and editing a recovery file must not recurse into another recovery: ${JSON.stringify(diagnostics)}`
    )
    const saved = await readFile(fixture, 'utf8')
    assert.notEqual(saved, original, 'the recovery table edits were not written')
    assert.deepEqual(
      await readFile(externalFixture),
      externalOriginal,
      'external recovery bytes changed while the isolated-copy test was running'
    )
    assert.equal(app.dialogs.length, 0, 'saving the recovery copy must not require a sync dialog')
    console.log(`PASS recovery table copy: filled=${Math.min(4, targets.length)}`)
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    assert.deepEqual(
      await readFile(externalFixture),
      externalOriginal,
      'external recovery bytes changed during the isolated-copy test'
    )
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
