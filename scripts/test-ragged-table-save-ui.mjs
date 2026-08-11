// A durable rich-save reproduction for legal GFM tables with omitted trailing
// cells. The editor renders each row rectangularly, but rich cell edits must
// preserve authored short-row bytes and must not enter recovery.
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const caseName = process.env.RAGGED_CASE || 'cell'
const supportedCases = new Set(['cell', 'consecutive', 'hardbreak', 'dashes', 'escaped-pipe'])
assert.ok(supportedCases.has(caseName), `RAGGED_CASE must be one of ${[...supportedCases].join(', ')}`)

const root = `/tmp/horsemd-ragged-table-save-${process.pid}`
const port = Number(process.env.CDP_PORT || 10230 + (process.pid % 300))
const builtInFixture = new URL('./fixtures/table-save-user-repro.md', import.meta.url)
const externalFixture = process.env.HORSEMD_REPRO_FILE
const fixture = join(root, externalFixture ? basename(externalFixture) : 'table-save-user-repro.md')

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

const lineCellCount = (line) => {
  let cells = 1
  let escaped = false
  for (const character of line.trim().replace(/^\||\|$/g, '')) {
    if (escaped) {
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (character === '|') {
      cells += 1
    }
  }
  return cells
}

const isDelimiter = (line) => {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|')
  return cells.length > 1 && cells.every((cell) => /^:?-{1,}:?$/.test(cell.trim()))
}

const tableFixtureForCase = (name) => {
  const delimiter = name === 'dashes'
    ? '| - | -- | - | -- | - |'
    : '| - | -- | --- | :---: | ---: |'
  const shortRows = name === 'hardbreak'
    ? ['| hardbreak target |', '| second short |']
    : name === 'escaped-pipe'
      ? ['| a \\| b<br>tail |', '| second short |']
      : ['| authored short |', '| second short |']
  return [
    '# Table save reproduction fixture',
    '',
    'before-table-sentinel',
    '',
    '```c',
    '#include <stdio.h>',
    'int main(void) { return 0; }',
    '```',
    '',
    '| one | two | three | four | five |',
    delimiter,
    ...shortRows,
    '| editable full | b | c | d | e |',
    '| complete | w | x | y | z |',
    '',
    'after-table-sentinel',
    ''
  ].join('\n')
}

const findRaggedTable = (source) => {
  const lines = source.split('\n')
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].includes('|') || !isDelimiter(lines[index + 1])) continue
    const width = lineCellCount(lines[index])
    const body = []
    for (let row = index + 2; row < lines.length && lines[row].includes('|'); row += 1) {
      body.push({ line: lines[row], cells: lineCellCount(lines[row]) })
    }
    const shortRows = body.filter((row) => row.cells < width)
    const editableIndex = body.findIndex((row) => row.cells === width)
    if (width === 5 && shortRows.length && editableIndex >= 0) {
      return { width, body, shortRows: shortRows.map((row) => row.line), editableIndex }
    }
  }
  throw new Error('fixture needs a five-column GFM table with a short body row and a complete body row')
}

const targetForCase = (table) => {
  const targetLine = caseName === 'hardbreak'
    ? '| hardbreak target |'
    : caseName === 'escaped-pipe'
      ? '| a \\| b<br>tail |'
      : null
  const targetIndex = targetLine == null
    ? table.editableIndex
    : table.body.findIndex((row) => row.line === targetLine)
  assert.ok(targetIndex >= 0, 'case target cell is missing from the authored fixture')
  return {
    index: targetIndex,
    token: 'editedX',
    rawEnter: caseName === 'hardbreak'
  }
}

const assertCaseSource = (source, token, checkpoint) => {
  assert.equal(source.includes(token), true, `${checkpoint}: edited input token is missing from source`)
  if (caseName === 'hardbreak') {
    assert.match(source, /hardbreak target<br\s*\/?>editedX/, `${checkpoint}: raw Enter did not round-trip as a table-cell <br>`)
  }
  if (caseName === 'escaped-pipe') {
    assert.equal(source.includes('a \\| b<br>taileditedX'), true, `${checkpoint}: escaped pipe and existing <br> did not retain their authored spelling`)
  }
  if (caseName === 'dashes') {
    assert.equal(source.includes('| - | -- | - | -- | - |'), true, `${checkpoint}: one/two-dash delimiter spelling changed`)
  }
  if (caseName === 'cell') {
    const lines = source.split(/\r?\n/)
    assert.equal(lines.includes('| authored short |'), true, `${checkpoint}: authored short row changed bytes`)
    assert.equal(lines.some((line) => /^\| authored short \|\s*\|\s*\|\s*\|\s*\|$/.test(line)), false, `${checkpoint}: authored short row was padded`)
  }
}

const visibleTableRows = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
  const table = [...(editor?.querySelectorAll('.milkdown-table-block') || [])].find((node) => node.offsetParent !== null)
  return [...(table?.querySelectorAll('tbody tr') || [])].map((row) =>
    [...row.children].map((cell) => cell.textContent || '')
  )
})()`)

const editPoint = (app, bodyIndex) => app.evaluate(`((bodyIndex) => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null)
  const table = [...(editor?.querySelectorAll('.milkdown-table-block') || [])].find((node) => node.offsetParent !== null)
  const cell = table?.querySelectorAll('tbody tr')[bodyIndex]?.querySelector('td:first-child')
  const target = cell?.querySelector('p') || cell
  const rect = target?.getBoundingClientRect()
  return rect ? { x: Math.round(rect.left + Math.min(14, rect.width / 2)), y: Math.round((rect.top + rect.bottom) / 2) } : null
})(${bodyIndex})`)

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null
)`)

const sourceToggle = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /source|源码/i.test(node.title || node.textContent || ''))
  button?.click()
  return Boolean(button)
})()`)

const enterSourceWithoutRecovery = async (app, checkpoint) => {
  assert.equal(await sourceToggle(app), true, `${checkpoint}: source toggle is missing`)
  const outcome = await waitFor(async () => {
    if (app.dialogs.length) return { recovery: true }
    const source = await visibleSource(app)
    return source == null ? null : { source }
  }, `${checkpoint}: source mode did not open`)
  assert.equal(outcome.recovery, undefined, `${checkpoint}: valid ragged table entered recovery`)
  assert.equal(app.dialogs.length, 0, `${checkpoint}: no recovery dialog is allowed`)
  return outcome.source
}

const returnToRich = async (app) => {
  assert.equal(await sourceToggle(app), true, 'source toggle is missing while returning to rich mode')
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent !== null))`),
    'rich editor did not return from source mode'
  )
}

const saveWithoutRecovery = async (app, checkpoint) => {
  await waitFor(
    () => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`),
    `${checkpoint}: rich edit did not become dirty`
  )
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  const outcome = await waitFor(async () => {
    if (app.dialogs.length) return { recovery: true }
    return await app.evaluate(`!document.querySelector('.hm-save-fab')`) ? { saved: true } : null
  }, `${checkpoint}: save did not complete`)
  assert.equal(outcome.recovery, undefined, `${checkpoint}: save entered recovery`)
  assert.equal(app.dialogs.length, 0, `${checkpoint}: save must not show recovery`)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  if (externalFixture) {
    // Never open the supplied file in place; this reproduction owns only its
    // temporary copy and deliberately keeps diagnostics content-free.
    await cp(externalFixture, fixture)
  } else if (caseName === 'cell' || caseName === 'consecutive') {
    await cp(builtInFixture, fixture)
  } else {
    await writeFile(fixture, tableFixtureForCase(caseName), 'utf8')
  }

  const original = await readFile(fixture, 'utf8')
  const fixtureTable = findRaggedTable(original)
  const target = targetForCase(fixtureTable)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [fixture] })
    await waitFor(async () => (await visibleTableRows(app)).length, 'ragged GFM table did not render')
    const rows = await visibleTableRows(app)
    assert.equal(rows.length >= fixtureTable.editableIndex + 1, true, 'complete table row is missing from the DOM')

    if (caseName === 'consecutive') {
      const shortDomRows = rows.filter((row) => fixtureTable.shortRows.some((raw) => row[0] === raw.replace(/^\|\s*|\s*\|$/g, '').replace(/\\\|/g, '|').replace(/<br\s*\/?>/gi, '')))
      assert.equal(shortDomRows.length >= 2, true, 'continuous short rows must render as table rows')
      for (const row of shortDomRows) {
        assert.equal(row.length, fixtureTable.width, 'short DOM row must already be rectangular before editing')
        assert.equal(row.slice(1).every((cell) => cell === ''), true, 'short DOM row content must remain only in column one')
      }
    }

    const point = await editPoint(app, target.index)
    assert.ok(point, 'target table cell was not available')
    await click(app, point)
    await click(app, point)
    await pressKey(app.send, { key: 'End', code: 'End' })
    if (target.rawEnter) await pressKey(app.send, { key: 'Enter', code: 'Enter' })
    await typeTextLikeUser(app.send, target.token)
    await sleep(450)

    const sourceAfterEdit = await enterSourceWithoutRecovery(app, 'after real full-row cell edit')
    assertCaseSource(sourceAfterEdit, target.token, 'source after edit')
    for (const shortRow of fixtureTable.shortRows) {
      if (shortRow !== '| hardbreak target |' && shortRow !== '| a \\| b<br>tail |') {
        assert.equal(sourceAfterEdit.includes(shortRow), true, 'source mode rewrote an untouched short row')
      }
    }
    await returnToRich(app)
    await saveWithoutRecovery(app, 'rich save')
    const saved = await readFile(fixture, 'utf8')
    assertCaseSource(saved, target.token, 'saved disk')
    for (const shortRow of fixtureTable.shortRows) {
      if (shortRow !== '| hardbreak target |' && shortRow !== '| a \\| b<br>tail |') {
        assert.equal(saved.includes(shortRow), true, 'save rewrote an untouched short row')
      }
    }
    const sourceAfterSave = await enterSourceWithoutRecovery(app, 'after rich save')
    assertCaseSource(sourceAfterSave, target.token, 'source after save')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await launchBuiltElectron({ profileDir: join(root, 'reopen-profile'), port: port + 1, appArgs: [fixture] })
    await waitFor(async () => (await visibleTableRows(app)).length, 'saved ragged table did not render after cold reopen')
    const coldRichText = await app.evaluate(`(
      [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)?.textContent ?? ''
    )`)
    assert.equal(coldRichText.includes(target.token), true, 'cold reopen rich editor is missing the edited input token')
    const reopened = await enterSourceWithoutRecovery(app, 'cold reopen')
    assertCaseSource(reopened, target.token, 'cold reopen source')
    for (const shortRow of fixtureTable.shortRows) {
      if (shortRow !== '| hardbreak target |' && shortRow !== '| a \\| b<br>tail |') {
        assert.equal(reopened.includes(shortRow), true, 'cold reopen rewrote an untouched short row')
      }
    }
    assert.equal(app.dialogs.length, 0, 'cold reopen must not show recovery')
    console.log(`PASS ragged table rich save: ${caseName}`)
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
