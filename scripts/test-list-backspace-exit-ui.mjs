// The v0.13.29 user repro (docs/rich-source-sync-architecture-review.md §3):
// Enter at the end of an ordered list creates an empty item; Backspace on it
// must EXIT the list into a paragraph (editor-list-backspace.js), not merge
// into the previous item as a marker-less continuation. The follow-up
// paragraph must survive source mode and save, with no recovery dialog.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-list-backspace-exit-${process.pid}`
const port = Number(process.env.CDP_PORT || 10014)

async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleep(100)
  }
  throw new Error(message)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const file = join(root, 'doc.md')
  const authored = '# 标题\n\n1. alpha\n2. beta\n3. gamma\n\n结尾段落\n'
  await writeFile(file, authored)

  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'p'), port, appArgs: [file] })
    await waitFor(
      () => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`),
      'editor did not open'
    )
    await sleep(1100)

    // Caret at the end of `gamma`, Enter (new empty item), Backspace (exit).
    assert.equal(await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        const at = node.nodeValue.indexOf('gamma')
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(node, at + 'gamma'.length)
        range.collapse(true)
        const selection = getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        editor.focus()
        document.dispatchEvent(new Event('selectionchange'))
        return true
      }
      return false
    })()`), true, 'could not place caret at list end')
    await pressKey(app.send, { key: 'Enter', code: 'Enter', delayMs: 80 })
    await sleep(400)
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 80 })
    await sleep(600)

    // The document must now have a paragraph caret AFTER the list: typing
    // must not re-enter the list or merge into `gamma`.
    await typeTextLikeUser(app.send, '列表后的正文')
    await sleep(1100)
    const listState = await app.evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
      // Crepe renders the ordered number as a DOM label inside the li; read
      // the item's paragraph so the assertion compares content only.
      const items = [...editor.querySelectorAll('li')].map((li) => li.querySelector('p')?.textContent.trim() ?? '')
      const paragraphs = [...editor.querySelectorAll(':scope > p')].map((p) => p.textContent.trim())
      return { items, paragraphs }
    })()`)
    assert.deepEqual(
      listState.items,
      ['alpha', 'beta', 'gamma'],
      `backspace on the empty item must not change existing items (got ${JSON.stringify(listState.items)})`
    )
    assert.ok(
      listState.paragraphs.includes('列表后的正文'),
      `the typed text must be a top-level paragraph (got ${JSON.stringify(listState.paragraphs)})`
    )

    // Source mode must open (no fail-closed) and show the authored rows plus
    // the new paragraph between list and tail.
    assert.equal(await app.evaluate(`(() => {
      const button = [...document.querySelectorAll('.status-btn')]
        .find((node) => node.offsetParent && /源码|Source/.test(node.title || node.textContent || ''))
      button?.click()
      return !!button
    })()`), true, 'could not click source toggle')
    await waitFor(
      () => app.evaluate(`!![...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)`),
      'source textarea did not appear'
    )
    assert.equal(app.dialogs.length, 0, 'no recovery dialog may appear in this flow')
    const source = await app.evaluate(`(
      [...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)?.value ?? null
    )`)
    assert.ok(
      source.includes('3. gamma\n\n列表后的正文'),
      `the paragraph must follow the intact list in source (got ${JSON.stringify(source)})`
    )
    assert.ok(source.includes('1. alpha\n2. beta\n3. gamma'), 'authored list rows must stay byte-identical')

    // Back to rich, save, verify disk.
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
    assert.ok(saved.includes('3. gamma\n\n列表后的正文'), 'the paragraph must persist on disk after the list')
    assert.equal(app.dialogs.length, 0, 'saving this flow must not require recovery')

    console.log('PASS list backspace exit: empty-item Backspace exits the list into a paragraph; source and disk stay faithful')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
