// Fail-closed recovery flow (docs/rich-source-sync-architecture-review.md §12).
//
// Fixture: a prose paragraph containing `#include <stdio.h>` — the visible-map
// projection mishandles `<...>` (review §5.6), so editing that paragraph
// deterministically fail-closes with `visible-stream-mismatch` even in a
// simple document. The flow must then be: source toggle DECLINED → stays in
// rich (no silent dead end, dialog shown); toggle ACCEPTED → authored source
// is rebuilt from the live document, source mode opens, and save persists
// exactly what the editor shows.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'
import { parseGfmTableSource } from '../src/renderer/src/lib/markdown-preservation/tables.js'

const root = `/tmp/horsemd-sync-recovery-${process.pid}`
const port = Number(process.env.CDP_PORT || 10016)
const packagedLaunch = process.env.HORSEMD_APP_PATH
  ? { executable: process.env.HORSEMD_APP_PATH, entrypoint: null }
  : {}

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
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

const sourceVisible = (app) => app.evaluate(
  `!![...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)`
)

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const file = join(root, 'doc.md')
  const authored = [
    '# 测试',
    '',
    '前置段落',
    '',
    '#include <stdio.h> 的说明',
    '',
    '尾部段落'
  ].join('\n') + '\n'
  await writeFile(file, authored)

  let app
  try {
    app = await launchBuiltElectron({ ...packagedLaunch, profileDir: join(root, 'p'), port, appArgs: [file] })
    await waitFor(
      () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`),
      'editor did not open'
    )
    await sleep(1100)

    // Type inside the affected paragraph (caret right after `说明`).
    assert.equal(await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        const at = node.nodeValue.indexOf('说明')
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(node, at + '说明'.length)
        range.collapse(true)
        const selection = getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        editor.focus()
        document.dispatchEvent(new Event('selectionchange'))
        return true
      }
      return false
    })()`), true, 'could not place caret in the affected paragraph')
    await typeTextLikeUser(app.send, 'X')
    await sleep(1100)

    // 1. A mapping failure costs SPELLING, not content, so it no longer stops
    //    to ask: the source is rebuilt on its own and the switch goes through.
    //    A modal here would be a formatting question interrupting the writing.
    assert.equal(await toggleSource(app), true, 'could not click source toggle')
    await waitFor(() => sourceVisible(app), 'source mode did not open after the automatic rebuild')
    assert.deepEqual(
      app.dialogs.map((dialog) => dialog.message),
      [],
      'a spelling-only rebuild must not open a modal'
    )
    const rebuilt = await app.evaluate(`(
      [...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)?.value ?? null
    )`)
    assert.ok(rebuilt.includes('X'), `the rebuilt source must contain the visible edit (got ${JSON.stringify(rebuilt)})`)
    assert.ok(rebuilt.includes('前置段落') && rebuilt.includes('尾部段落'), 'untouched blocks must survive the rebuild')

    // 2. The normalization is reported, just not asked about.
    assert.ok(
      await app.evaluate(`[...document.querySelectorAll('*')].some((node) => (
        node.children.length === 0 && /规范化|normalized/.test(node.textContent || '')
      ))`),
      'the automatic rebuild must report itself without blocking'
    )

    // 3. Save persists the rebuilt source.
    await app.evaluate(`(() => {
      const button = [...document.querySelectorAll('.status-btn')]
        .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
      button?.click()
    })()`)
    await sleep(500)
    await waitFor(() => app.evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => app.evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not complete')
    const saved = await readFile(file, 'utf8')
    assert.equal(saved, rebuilt, 'disk must contain exactly the rebuilt source shown in source mode')

    // 4. Exercise the branch the original P0 lacked: strict rebuild itself is
    // rejected, yet a separate best-effort recovery copy remains writable.
    // A terminal hardbreak in an ordinary paragraph has no durable Markdown
    // representation in the current schema, so canonical reparse cannot equal
    // the live document and rebuildMarkdownFromRich returns null.
    await stopBuiltElectron(app, { removeProfile: true })
    app = null
    const terminalFile = join(root, 'terminal-hardbreak.md')
    const terminalOriginal = [
      '# Terminal recovery',
      '',
      '| A | B | C |',
      '| --- | --- | --- |',
      '| <br /> | stable |',
      '',
      'abc',
      ''
    ].join('\n')
    const recoveryFile = join(root, 'terminal-hardbreak.horsemd-recovered.md')
    await writeFile(terminalFile, terminalOriginal)
    app = await launchBuiltElectron({
      ...packagedLaunch,
      profileDir: join(root, 'terminal-profile'),
      port: port + 1,
      appArgs: [terminalFile],
      env: { ...process.env, HORSEMD_TEST_SAVE_AS_PATH: recoveryFile }
    })
    await waitFor(
      () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`),
      'terminal-break editor did not open'
    )
    await sleep(900)
    assert.equal(await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        if (node.nodeValue !== 'abc') continue
        const range = document.createRange()
        range.setStart(node, node.nodeValue.length)
        range.collapse(true)
        const selection = getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        editor.focus()
        document.dispatchEvent(new Event('selectionchange'))
        return true
      }
      return false
    })()`), true, 'could not place caret for terminal hardbreak')
    await typeTextLikeUser(app.send, 'X')
    await pressKey(app.send, { key: 'Enter', code: 'Enter', modifiers: 8 })
    await sleep(700)
    assert.ok(
      await app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`),
      'the live text edit must be dirty before recovery'
    )
    // Declining must do nothing at all: no picker, no file, original intact.
    // Both entry points ask — the save button and the source switch.
    app.setDialogResponse(false)
    const beforeSave = app.dialogs.length
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(1200)
    assert.equal(app.dialogs.length, beforeSave + 1, 'saving must ask before writing a NEW file')
    assert.equal(
      await readFile(recoveryFile, 'utf8').then(() => true, () => false),
      false,
      'declining on the save path must not write a recovery copy'
    )
    assert.equal(await readFile(terminalFile, 'utf8'), terminalOriginal, 'the original file stays untouched')
    assert.ok(
      await app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`),
      'the tab stays dirty after declining'
    )

    const dialogCount = app.dialogs.length
    assert.equal(await toggleSource(app), true, 'could not request source after terminal hardbreak')
    await sleep(1200)
    assert.equal(app.dialogs.length, dialogCount + 1, 'writing a NEW file must be asked about first')
    assert.equal(
      await readFile(recoveryFile, 'utf8').then(() => true, () => false),
      false,
      'declining the recovery copy must not write one'
    )
    assert.equal(await readFile(terminalFile, 'utf8'), terminalOriginal, 'the original file stays untouched')

    app.setDialogResponse(true)
    assert.equal(await toggleSource(app), true, 'could not request source again')
    await waitFor(async () => {
      try {
        return (await readFile(recoveryFile, 'utf8')).includes('abcX')
      } catch {
        return false
      }
    }, 'rebuild-null branch did not write a separate recovery copy')
    assert.equal(app.dialogs.length, dialogCount + 2, 'both the declined and the accepted ask are recorded')
    assert.equal(await sourceVisible(app), false, 'a rejected strict rebuild must not enter source mode')
    assert.equal(await readFile(terminalFile, 'utf8'), terminalOriginal, 'recovery must leave the original bytes untouched')
    assert.ok(
      await app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`),
      'recovery export must not clear the original tab dirty state'
    )

    const recovered = await readFile(recoveryFile, 'utf8')
    assert.equal(
      (recovered.match(/<br\s*\/?>/gi) || []).length,
      1,
      'recovery keeps the authored table hardbreak but must not materialize the missing cell as another hardbreak'
    )

    // A recovery copy is a durable exit, not a one-shot dump. Cold-open it,
    // edit an ordinary table cell, and save without recursively producing a
    // second recovery file.
    await stopBuiltElectron(app, { removeProfile: true })
    app = null
    const recursiveRecoveryFile = join(root, 'terminal-hardbreak.horsemd-recovered.horsemd-recovered.md')
    app = await launchBuiltElectron({
      ...packagedLaunch,
      profileDir: join(root, 'reopened-recovery-profile'),
      port: port + 2,
      appArgs: [recoveryFile],
      env: { ...process.env, HORSEMD_TEST_SAVE_AS_PATH: recursiveRecoveryFile }
    })
    await waitFor(
      () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`),
      'recovery copy did not cold-open'
    )
    await sleep(900)
    assert.equal(await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        if (node.nodeValue !== 'stable') continue
        const range = document.createRange()
        range.setStart(node, node.nodeValue.length)
        range.collapse(true)
        const selection = getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        editor.focus()
        document.dispatchEvent(new Event('selectionchange'))
        return true
      }
      return false
    })()`), true, 'could not place caret in the reopened recovery table')
    await typeTextLikeUser(app.send, 'Y')
    await waitFor(
      () => app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`),
      'reopened recovery table edit did not become dirty'
    )
    await app.evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(
      () => app.evaluate(`!document.querySelector('.hm-save-fab')`),
      'reopened recovery table did not save normally'
    )
    const stableRecovery = await readFile(recoveryFile, 'utf8')
    assert.ok(stableRecovery.includes('stableY'), 'reopened recovery lost its table edit')
    assert.equal(
      (stableRecovery.match(/<br\s*\/?>/gi) || []).length,
      1,
      'a normal save after recovery must keep the authored break without rematerializing an empty-cell placeholder'
    )
    const stableModel = parseGfmTableSource(stableRecovery)
    assert.equal(stableModel.tables.length, 1, 'reopened recovery save changed the table count')
    assert.deepEqual(
      stableModel.tables[0].rows.map((row) => row.cells.length),
      [3, 3],
      'reopened recovery save changed the table rectangle'
    )
    assert.equal(await toggleSource(app), true, 'source mode is unavailable after saving the recovery table')
    await waitFor(() => sourceVisible(app), 'source mode did not open after saving the recovery table')
    const stableSource = await app.evaluate(`(
      [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null
    )`)
    assert.equal(stableSource, stableRecovery, 'source mode differs from the saved recovery bytes')
    await assert.rejects(
      readFile(recursiveRecoveryFile, 'utf8'),
      /ENOENT/,
      'reopened recovery must not recursively generate another recovery copy'
    )

    await stopBuiltElectron(app, { removeProfile: true })
    app = null
    app = await launchBuiltElectron({
      ...packagedLaunch,
      profileDir: join(root, 'second-reopen-profile'),
      port: port + 3,
      appArgs: [recoveryFile]
    })
    await waitFor(
      () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`),
      'saved recovery did not survive a second cold reopen'
    )
    assert.equal(await toggleSource(app), true, 'second cold reopen cannot enter source mode')
    await waitFor(() => sourceVisible(app), 'second cold reopen source mode did not open')
    const secondReopenSource = await app.evaluate(`(
      [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null
    )`)
    assert.equal(secondReopenSource, stableRecovery, 'second cold reopen changed recovery source bytes')
    assert.equal(app.dialogs.length, 0, 'second cold reopen must not show recovery')

    console.log('PASS sync recovery: strict rebuild success and rebuild-null separate-copy exits both remain available')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
