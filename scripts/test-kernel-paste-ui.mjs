// Kernel-mode PASTE (2026-08-28). Measured before this route existed, with the
// kernel default-on: everything except a single-line plain-text paste was
// refused outright — multi-paragraph text, Markdown, rich HTML and tables all
// raised 「无效操作…未写入 (unsupported-input-type)」 and wrote nothing. The
// gateway's step extractors cannot express a cross-block slice, and nothing
// else claimed it.
//
// What this pins is the whole contract of `commitPaste`
// (editor-kernel-mode.js): the pasted content lands as BYTES (only the blocks
// the paste touched are re-spelled; everything else keeps its authored
// spelling), the spelling is the one legacy's own save path produces (the
// scratch cleanup strips serializer `<br />` placeholders and compacts list
// spacing), and it survives save + a cold reopen.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const port = Number(process.env.CDP_PORT || 10251)
const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`

async function waitFor(fn, message, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

// The clipboard event ProseMirror's own paste path consumes. A DataTransfer
// built here carries exactly what a real clipboard would.
async function paste(evaluate, { html = '', plain = '' }) {
  const result = await evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    if (!editor) return 'no editor'
    editor.focus()
    const data = new DataTransfer()
    if (${JSON.stringify(html)}) data.setData('text/html', ${JSON.stringify(html)})
    if (${JSON.stringify(plain)}) data.setData('text/plain', ${JSON.stringify(plain)})
    editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
    return true
  })()`)
  assert.equal(result, true, `paste dispatch failed: ${result}`)
  await sleep(1000)
}

async function run() {
  const root = `/tmp/horsemd-kernel-paste-${process.pid}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '开头段。\n')

  let app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${VISIBLE_EDITOR})?.textContent?.includes('开头段')`), 'editor mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel mode')
    await sleep(700)
    await evaluate(`(() => {
      window.__pasteToasts = []
      window.addEventListener('hm:toast', (e) => window.__pasteToasts.push(e.detail?.msg ?? String(e.detail)))
      globalThis.__hmKernelDiagnostics = []
      return true
    })()`)

    // caret at the end of the paragraph, then a fresh block to paste into
    const spot = await evaluate(`(() => {
      const node = [...(${VISIBLE_EDITOR}).querySelectorAll('p')].find((x) => x.textContent === '开头段。')
      const box = node.getBoundingClientRect()
      return { x: box.right - 2, y: box.top + box.height / 2 }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
    await sleep(300)
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(600)

    // 1) MULTI-PARAGRAPH PLAIN TEXT — the shape whose slice is
    //    `<paragraph+paragraph>`, refused before this route existed.
    await paste(evaluate, { plain: '第一段\n\n第二段' })

    // 2) MARKDOWN — heading + list, the `<paragraph+heading+bullet_list>`
    //    cross-parent slice. The list must keep COMPACT spacing: the scratch
    //    cleanup is what makes the pasted bytes look authored.
    await paste(evaluate, { plain: '# 标题\n\n- 甲\n- 乙' })

    // 3) RICH INLINE HTML — marks become their Markdown spelling, in place.
    await paste(evaluate, { html: '<p><strong>粗体</strong>与<em>斜体</em></p>', plain: '粗体与斜体' })

    // 4) AN HTML TABLE WITH NO HEADER ROW. GFM requires one, so the empty
    //    header cells are the serializer's `<br />` placeholders — stripped to
    //    `|  |`, the exact spelling legacy's save path writes (measured).
    await paste(evaluate, { html: '<table><tbody><tr><td>表格 A</td><td>表格 B</td></tr></tbody></table>', plain: '表格 A\t表格 B' })

    const toasts = await evaluate(`JSON.stringify(window.__pasteToasts)`)
    assert.ok(!/无效操作|Invalid operation|未写入/.test(toasts), `no paste may be refused — toasts: ${toasts}`)

    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(900)
    const bytes = await readFile(file, 'utf8')
    for (const expected of ['第一段', '第二段', '# 标题', '- 甲\n- 乙', '**粗体**', '*斜体*', '| 表格 A', '|  |  |']) {
      assert.ok(bytes.includes(expected), `pasted content missing from the saved bytes: ${expected}\n--- bytes ---\n${bytes}`)
    }
    // The authored first paragraph never moved.
    assert.ok(bytes.startsWith('开头段。'), `the authored paragraph must keep its own bytes: ${bytes}`)

    await stopBuiltElectron(app)
    app = null
    // 5) COLD REOPEN — the bytes are the document, so the reopened editor
    //    shows the pasted content without any of it having been in a slice.
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
    await waitFor(() => app.evaluate(`(${VISIBLE_EDITOR})?.textContent?.includes('标题')`), 'cold reopen mount')
    await sleep(600)
    const reopened = await app.evaluate(`(${VISIBLE_EDITOR}).textContent`)
    for (const expected of ['第一段', '第二段', '标题', '粗体', '斜体', '表格 A']) {
      assert.ok(reopened.includes(expected), `cold reopen lost ${expected}: ${reopened}`)
    }
    assert.equal(await readFile(file, 'utf8'), bytes, 'a cold reopen must not rewrite the file')
  } finally {
    if (app) await stopBuiltElectron(app)
  }
  console.log('PASS kernel paste: multi-paragraph text, Markdown, rich inline HTML and a header-less table all commit source bytes, in legacy\'s own spelling, and survive save + cold reopen')
}

await run()
