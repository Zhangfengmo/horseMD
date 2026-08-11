// End-to-end source ownership coverage for fenced languages next to legal
// ragged GFM tables. Each language case edits a real table cell; table-looking
// bytes inside its fence must remain completely untouched.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-rich-source-app-parser-${process.pid}`
const port = Number(process.env.CDP_PORT || 10066)
const tail = '结尾正文'
const inserted = '新增段落'
const languages = ['go', 'js', 'ts', 'python', 'rust', 'java', 'c', 'cpp']
const languageFixtures = languages.map((language) => ({
  language,
  target: `target-${language}`,
  token: `X${language}`,
  raggedRow: `| short-${language} |`,
  fence: [
    `\`\`\`${language}`,
    `| code-${language} | table-looking | bytes |`,
    '| --- | --- | --- |',
    `literal-${language}`,
    '\`\`\`'
  ].join('\n')
}))
const initial = [
  '# App parser source acceptance',
  '',
  ...languageFixtures.flatMap(({ language, target, raggedRow, fence }) => [
    `## ${language}`,
    '',
    fence,
    '',
    '| language | target | guard |',
    '| - | -- | --- |',
    `| ${language} | ${target} | keep-${language} |`,
    raggedRow,
    '',
  ]),
  tail,
  ''
].join('\n')
const expected = languageFixtures.reduce(
  (source, { target, token }) => source.replace(target, `${target}${token}`),
  initial
)

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const toggleSource = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /source|源码/i.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

async function openApp(profile, file, appPort) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file]
  })
  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)?.textContent.includes(${JSON.stringify(tail)})`),
    'rich fixture did not mount'
  )
  await sleep(500)
  await app.evaluate(`(() => {
    window.__hmPreserveLog = []
    window.__hmGateLog = []
  })()`)
  return app
}

async function persistFirstTableColumnWidth(app) {
  const target = await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)
    const block = editor?.querySelector('.milkdown-table-block')
    block?.scrollIntoView({ block: 'center' })
    const cell = block?.querySelector('td')
    const rect = cell?.getBoundingClientRect()
    return rect ? { x: rect.right - 2, y: rect.top + rect.height / 2 } : null
  })()`)
  assert.ok(target, 'table column resize target was unavailable')
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...target })
  await sleep(180)
  await app.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', ...target, button: 'left', buttons: 1, clickCount: 1
  })
  await sleep(280)
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: target.x + 48, y: target.y, button: 'left', buttons: 1
  })
  await sleep(100)
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: target.x + 48, y: target.y, button: 'left', buttons: 0, clickCount: 1
  })
  await sleep(200)
  assert.equal(await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)
    return !!editor?.querySelector('.milkdown-table-block [data-colwidth]')
  })()`), true, 'table resize did not persist live colwidth metadata')
}

const click = async (app, point) => {
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}

async function appendToTableCell(app, target, token) {
  const located = await app.evaluate(`((targetText) => {
    const editor = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)
    const matches = [...(editor?.querySelectorAll('.milkdown-table-block td') || [])]
      .filter((cell) => cell.textContent === targetText)
    if (matches.length !== 1) return { count: matches.length }
    const cell = matches[0]
    const paragraph = cell.querySelector('p') || cell
    paragraph.scrollIntoView({ block: 'center' })
    const rect = paragraph.getBoundingClientRect()
    return {
      count: 1,
      point: {
        x: Math.round(rect.left + Math.min(14, rect.width / 2)),
        y: Math.round((rect.top + rect.bottom) / 2)
      }
    }
  })(${JSON.stringify(target)})`)
  assert.equal(located.count, 1, `table target ${target} was not unique`)
  await click(app, located.point)
  await pressKey(app.send, { key: 'End', code: 'End' })
  await typeTextLikeUser(app.send, token)
  await waitFor(
    () => app.evaluate(`[...document.querySelectorAll('.ProseMirror td')]
      .some((cell) => cell.textContent === ${JSON.stringify(target + token)})`),
    `committed input did not land in table cell ${target}`
  )
}

const assertFencedBytesUntouched = (source, checkpoint) => {
  for (const { language, fence } of languageFixtures) {
    assert.equal(source.includes(fence), true, `${checkpoint}: ${language} fenced table-looking bytes changed`)
  }
}

async function returnToRich(app, checkpoint) {
  assert.equal(await toggleSource(app), true, `${checkpoint}: source toggle missing`)
  await waitFor(
    () => app.evaluate(`Boolean([...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent !== null))`),
    `${checkpoint}: rich editor did not return`
  )
}

async function placeCaretAtParagraphEnd(app, paragraphText) {
  assert.equal(await app.evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)
    const target = [...editor.children]
      .find((node) => node.tagName === 'P' && node.textContent === ${JSON.stringify(paragraphText)})
    const textNode = target?.firstChild
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return false
    target.scrollIntoView({ block: 'center' })
    const range = document.createRange()
    range.setStart(textNode, textNode.nodeValue.length)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    editor.focus()
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`), true, 'could not place the caret at the final paragraph')
}

async function saveWithoutRecovery(app, checkpoint) {
  await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  const outcome = await waitFor(async () => {
    if (app.dialogs.length) return { recovery: true }
    return await app.evaluate(`!document.querySelector('.hm-save-fab')`)
      ? { saved: true }
      : null
  }, `${checkpoint}: save did not complete`)
  if (outcome.recovery) {
    const diagnostics = await app.evaluate(`({
      gate: window.__hmGateLog || [],
      preserve: (window.__hmPreserveLog || []).slice(-10)
    })`)
    throw new Error(`${checkpoint}: save entered recovery: ${JSON.stringify(diagnostics)}`)
  }
  assert.equal(app.dialogs.length, 0, `${checkpoint}: save must not enter recovery`)
}

async function assertGateClean(app, checkpoint) {
  assert.deepEqual(
    await app.evaluate(`(window.__hmGateLog || []).map((entry) => ({
      origin: entry.origin,
      reason: entry.reason
    }))`),
    [],
    `${checkpoint}: verified source gate recorded a rejection`
  )
  assert.equal(app.dialogs.length, 0, `${checkpoint}: recovery dialog appeared`)
}

async function inspectSourceWithoutRecovery(
  app,
  checkpoint,
  expectedSource,
  { requireAuthoredRaggedRow = true } = {}
) {
  assert.equal(await toggleSource(app), true, `${checkpoint}: source toggle missing`)
  const outcome = await waitFor(async () => {
    if (app.dialogs.length) return { recovery: true }
    const source = await visibleSource(app)
    return source == null ? null : { source }
  }, `${checkpoint}: neither source mode nor a recovery dialog appeared`)

  assert.equal(
    app.dialogs.length,
    0,
    `${checkpoint}: app-parser-equivalent ragged table was rejected by the source gate: ${JSON.stringify(
      app.dialogs.map((dialog) => dialog.message)
    )}`
  )
  assert.equal(outcome.recovery, undefined, `${checkpoint}: source switch entered recovery`)
  assert.equal(outcome.source, expectedSource, `${checkpoint}: source did not match the verified disk form`)
  if (requireAuthoredRaggedRow) {
    for (const { language, raggedRow } of languageFixtures) {
      assert.ok(outcome.source.includes(raggedRow), `${checkpoint}: ${language} short table row was padded or removed`)
    }
  }
  assertFencedBytesUntouched(outcome.source, checkpoint)
  return outcome.source
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const file = join(root, 'ragged-table-code-matrix.md')
  await writeFile(file, initial)

  let app
  try {
    app = await openApp('edit', file, port)
    // Every language performs committed per-character input in its own table
    // target. The nearby fenced block deliberately contains table-looking
    // lines so code bytes and table source ownership cannot be conflated.
    for (const { target, token } of languageFixtures) {
      await appendToTableCell(app, target, token)
    }
    await waitFor(
      () => app.evaluate(`!!document.querySelector('.hm-save-fab')`),
      'rich edit did not become dirty'
    )
    await sleep(500)

    await inspectSourceWithoutRecovery(app, 'after rich edit', expected)
    await assertGateClean(app, 'after 8 table-cell source checks')
    await returnToRich(app, 'after source inspection')
    await saveWithoutRecovery(app, 'authored-ragged rich save')
    await assertGateClean(app, 'after 8 table-cell rich save')
    assert.equal(await readFile(file, 'utf8'), expected, 'save changed untouched authored bytes')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', file, port + 1)
    await inspectSourceWithoutRecovery(app, 'cold reopen', expected)
    await assertGateClean(app, 'after 8 table-cell cold reopen')
    assert.equal(await readFile(file, 'utf8'), expected, 'cold reopen changed disk bytes')

    // A column resize is an explicit table operation and may canonicalize that
    // table block. Its non-Markdown colwidth metadata and internal empty-cell
    // `<br />` placeholders must still pass the live forced-save boundary.
    await stopBuiltElectron(app, { removeProfile: true })
    const resizedFile = join(root, 'resized-ragged-table-code-matrix.md')
    await writeFile(resizedFile, initial)
    app = await openApp('resize-edit', resizedFile, port + 2)
    await persistFirstTableColumnWidth(app)
    await placeCaretAtParagraphEnd(app, tail)
    await typeTextLikeUser(app.send, inserted)
    await waitFor(
      () => app.evaluate(`!!document.querySelector('.hm-save-fab')`),
      'resized table edit did not become dirty'
    )
    await saveWithoutRecovery(app, 'resized-table rich save')
    const resizedSource = await readFile(resizedFile, 'utf8')
    assert.ok(resizedSource.includes(`${tail}${inserted}`), 'resized-table edit was not saved')
    assert.ok(resizedSource.includes('short-go'), 'resized table lost its ragged-row content')
    for (const { language, fence } of languageFixtures) {
      assert.ok(resizedSource.includes(fence), `resized save changed ${language} fenced bytes`)
    }
    await inspectSourceWithoutRecovery(app, 'after resized-table save', resizedSource, {
      requireAuthoredRaggedRow: false
    })
    await assertGateClean(app, 'after resized-table save')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('resize-reopen', resizedFile, port + 3)
    await inspectSourceWithoutRecovery(app, 'resized-table cold reopen', resizedSource, {
      requireAuthoredRaggedRow: false
    })
    await assertGateClean(app, 'after resized-table cold reopen')
    assert.equal(await readFile(resizedFile, 'utf8'), resizedSource, 'resized-table reopen changed disk bytes')

    console.log('PASS app-parser source acceptance: 8 real table-cell edits preserve adjacent fenced bytes through source, rich save, resize, and cold reopen')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
