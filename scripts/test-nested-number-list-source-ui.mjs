import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-nested-number-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 10010)
const sleepMs = (ms) => sleep(ms)

async function waitFor(check, message, attempts = 120) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleepMs(100)
  }
  throw new Error(message)
}

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const caretAfter = (evaluate, needle, offset = 0) => evaluate(`(() => {
  const editors = [...document.querySelectorAll('.ProseMirror')].filter((n) => n.offsetParent)
  const editor = editors.find((ed) => ed.textContent.includes(${JSON.stringify(needle)}))
  if (!editor) return false
  editor.focus()
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode())) {
    const i = node.nodeValue.indexOf(${JSON.stringify(needle)})
    if (i >= 0) {
      const range = document.createRange()
      range.setStart(node, i + ${JSON.stringify(needle)}.length + ${offset})
      range.collapse(true)
      const sel = getSelection()
      sel.removeAllRanges(); sel.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return true
    }
  }
  return false
})()`)

async function openApp(profile, appPort, content) {
  const app = await launchBuiltElectron({
    profileDir: join(root, profile),
    port: appPort,
    appArgs: [file]
  })
  await waitFor(
    () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`),
    'editor did not open'
  )
  await sleepMs(900)
  return app
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  // `- 1. 甲乙` is parsed by remark as a NESTED ordered list (`1. 甲`, `2. 乙`),
  // so the canonical visible stream drops the `1. ` item text. Any list edit
  // used to fall back to the OLD source and the user's typing vanished.
  const authored = '- 1. 甲乙\n- 丙丁\n'
  await writeFile(file, authored)
  let app
  try {
    app = await openApp('edit', port)
    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmGateLog = []
    })()`)

    // Split the first item mid-text with Enter, then type.
    assert.equal(await caretAfter(app.evaluate, '甲', 0), true, 'could not place the caret after 甲')
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 60 })
    await sleepMs(400)
    await typeTextLikeUser(app.send, '新')
    await sleepMs(900)

    // The typed text must reach source with the authored spelling intact.
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch to source mode')
    await waitFor(async () => (
      app.dialogs.length > 0 ||
      await app.evaluate(`!![...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)`)
    ), 'source mode produced neither a textarea nor a recovery dialog')
    const sourceState = await app.evaluate(`(() => {
      const source = [...document.querySelectorAll('textarea.source-editor')]
        .find((node) => node.offsetParent)
      return {
        source: source?.value,
        gate: (window.__hmGateLog || []).slice(-4).map((entry) => ({
          origin: entry.origin,
          reason: entry.reason,
          candidate: entry.candidate,
          canonical: entry.canonical
        })),
        preserve: (window.__hmPreserveLog || []).slice(-4)
      }
    })()`)
    if (app.dialogs.length) sourceState.dialog = app.dialogs.at(-1)?.message
    assert.ok(
      typeof sourceState.source === 'string',
      `source switch was rejected: ${JSON.stringify(sourceState)}`
    )
    const raw = await visibleSource(app.evaluate)
    assert.ok(
      raw.includes('新'),
      `the typed text must survive the mode switch (got ${JSON.stringify(raw)})`
    )
    assert.ok(
      raw.startsWith('- 1. 甲\n  2. 新乙'),
      `the Entered split must stay inside the original outer bullet (got ${JSON.stringify(raw)})`
    )

    // Back to rich, save, reopen: the edit must be durable.
    assert.equal(await toggleSource(app.evaluate), true, 'could not switch back to rich mode')
    await sleepMs(600)
    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
    const saved = await readFile(file, 'utf8')
    const expected = '- 1. 甲\n  2. 新乙\n- 丙丁\n'
    assert.equal(saved, expected, 'the typed text and list nesting must persist on disk')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', port + 1)
    const reopenedStructure = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      return {
        nestedItems: editor?.querySelectorAll('li li').length || 0,
        text: editor?.textContent || ''
      }
    })()`)
    assert.equal(reopenedStructure.nestedItems, 2, 'cold reopen must render both ordered items inside the outer bullet')
    assert.ok(reopenedStructure.text.includes('甲') && reopenedStructure.text.includes('新乙'), 'cold reopen lost nested list text')
    assert.equal(await toggleSource(app.evaluate), true, 'cold-reopened document could not switch to source mode')
    await waitFor(
      () => app.evaluate(`!![...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)`),
      'cold-reopened source textarea did not appear'
    )
    assert.equal(await visibleSource(app.evaluate), expected, 'cold reopen must retain the verified nested structure')

    console.log('PASS nested-number list source sync: edits inside `- 1. …` rows survive switch, save, and cold reopen')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
