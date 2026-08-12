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

const root = `/tmp/horsemd-sync-recovery-${process.pid}`
const port = Number(process.env.CDP_PORT || 10016)

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
    app = await launchBuiltElectron({ profileDir: join(root, 'p'), port, appArgs: [file] })
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

    // 1. Decline recovery: the switch is refused but no longer a silent lock —
    //    the dialog is shown, the rich editor stays usable.
    assert.equal(await toggleSource(app), true, 'could not click source toggle')
    await sleep(800)
    if (app.dialogs.length === 0) {
      // The mapping succeeded — this fixture no longer exercises fail-closed.
      // That would silently degrade this regression, so fail loudly.
      throw new Error('fixture no longer triggers fail-closed; recovery flow not exercised')
    }
    assert.equal(await sourceVisible(app), false, 'declining recovery must not open source mode')
    assert.ok(
      await app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`),
      'the rich editor must stay usable after declining'
    )

    // 2. Accept recovery: the source is rebuilt from the live document and
    //    source mode opens.
    app.setDialogResponse(true)
    assert.equal(await toggleSource(app), true, 'could not click source toggle again')
    await waitFor(() => sourceVisible(app), 'source mode did not open after accepting recovery')
    const rebuilt = await app.evaluate(`(
      [...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)?.value ?? null
    )`)
    assert.ok(rebuilt.includes('X'), `the rebuilt source must contain the visible edit (got ${JSON.stringify(rebuilt)})`)
    assert.ok(rebuilt.includes('前置段落') && rebuilt.includes('尾部段落'), 'untouched blocks must survive the rebuild')

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
    const terminalOriginal = '# Terminal recovery\n\nabc\n'
    const recoveryFile = join(root, 'terminal-hardbreak.horsemd-recovered.md')
    await writeFile(terminalFile, terminalOriginal)
    app = await launchBuiltElectron({
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
    app.setDialogResponse(true)
    const dialogCount = app.dialogs.length
    assert.equal(await toggleSource(app), true, 'could not request source after terminal hardbreak')
    await waitFor(async () => {
      try {
        return (await readFile(recoveryFile, 'utf8')).includes('abcX')
      } catch {
        return false
      }
    }, 'rebuild-null branch did not write a separate recovery copy')
    assert.equal(app.dialogs.length, dialogCount + 1, 'strict rebuild confirmation must be exercised')
    assert.equal(await sourceVisible(app), false, 'a rejected strict rebuild must not enter source mode')
    assert.equal(await readFile(terminalFile, 'utf8'), terminalOriginal, 'recovery must leave the original bytes untouched')
    assert.ok(
      await app.evaluate(`Boolean(document.querySelector('.hm-save-fab'))`),
      'recovery export must not clear the original tab dirty state'
    )

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
