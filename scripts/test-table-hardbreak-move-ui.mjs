import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-table-hardbreak-move-${process.pid}`
const file = join(root, 'table-hardbreak-move.md')
const port = Number(process.env.CDP_PORT || 10361)
const packagedLaunch = process.env.HORSEMD_APP_PATH
  ? { executable: process.env.HORSEMD_APP_PATH, entrypoint: null }
  : {}
const original = [
  '# Hardbreak move',
  '',
  '| A | B |',
  '| --- | --- |',
  '| <br /> |  |',
  '',
  'Tail',
  ''
].join('\n')
const expected = original.replace('| <br /> |  |', '|  | <br> |')

const waitFor = async (check, message, attempts = 120) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null
)`)

const placeInDataCell = (app, column, afterHardbreak) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  const table = [...(editor?.querySelectorAll('.milkdown-table-block') || [])]
    .find((node) => node.offsetParent)
  const row = table?.querySelectorAll('tbody tr')?.[1]
  const cell = row?.children?.[${column}]
  const paragraph = cell?.querySelector('p') || cell
  if (!paragraph) return false
  const range = document.createRange()
  if (${afterHardbreak ? 'true' : 'false'}) {
    const hardbreak = [...paragraph.querySelectorAll('br')]
      .find((node) => !node.classList.contains('ProseMirror-trailingBreak'))
    if (!hardbreak) return false
    range.setStartAfter(hardbreak)
  } else {
    range.setStart(paragraph, 0)
  }
  range.collapse(true)
  const selection = getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  editor.focus()
  document.dispatchEvent(new Event('selectionchange'))
  return true
})()`)

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, original)

  let app
  try {
    app = await launchBuiltElectron({
      ...packagedLaunch,
      profileDir: join(root, 'profile'),
      port,
      appArgs: [file]
    })
    await waitFor(
      () => app.evaluate(`Boolean([...document.querySelectorAll('.milkdown-table-block')].find((node) => node.offsetParent))`),
      'hardbreak table did not open'
    )
    await sleep(700)

    assert.equal(await placeInDataCell(app, 0, true), true, 'could not select the authored hardbreak')
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace' })
    assert.equal(await placeInDataCell(app, 1, false), true, 'could not select the adjacent empty cell')
    await pressKey(app.send, { key: 'Enter', code: 'Enter' })
    await sleep(500)

    assert.equal(await toggleSource(app), true, 'source mode toggle is unavailable after the two-cell edit')
    const source = await waitFor(() => visibleSource(app), 'source mode was blocked after the two-cell edit')
    assert.equal(source, expected, 'the hardbreak did not move between the two authored cells')
    assert.equal(app.dialogs.length, 0, 'the two-cell table edit must not enter recovery')

    assert.equal(await toggleSource(app), true, 'could not return to rich mode before save')
    await waitFor(() => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`), 'save button did not appear')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'hardbreak move did not save')
    assert.equal(await readFile(file, 'utf8'), expected, 'disk bytes differ from the verified moved-hardbreak source')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await launchBuiltElectron({
      ...packagedLaunch,
      profileDir: join(root, 'reopen-profile'),
      port: port + 1,
      appArgs: [file]
    })
    await waitFor(
      () => app.evaluate(`Boolean([...document.querySelectorAll('.milkdown-table-block')].find((node) => node.offsetParent))`),
      'saved hardbreak table did not cold-open'
    )
    assert.equal(await toggleSource(app), true, 'source mode is unavailable after cold reopen')
    assert.equal(await waitFor(() => visibleSource(app), 'cold reopen source did not open'), expected)
    assert.equal(app.dialogs.length, 0, 'cold reopen must not enter recovery')
    console.log('PASS table hardbreak move: two-cell batch saves and cold-reopens without recovery')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
