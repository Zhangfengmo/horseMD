import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-empty-paragraph-source-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 9852)

const sleepMs = (ms) => sleep(ms)

async function waitFor(check, message, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check()
    if (result) return result
    await sleepMs(100)
  }
  throw new Error(message)
}

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const toggleSource = (evaluate) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

async function clickRichBlock(evaluate, send, selector) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const node = editor?.querySelector(${JSON.stringify(selector)})
    if (!node) return null
    const rect = node.getBoundingClientRect()
    return { x: rect.left + 12, y: rect.top + Math.min(18, rect.height / 2) }
  })()`)
  assert.ok(point, `block not found: ${selector}`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}

const rawKey = async (send, key, code, keyCode) => {
  const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await send('Input.dispatchKeyEvent', { type: 'char', ...common, text: key, unmodifiedText: key })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleepMs(90)
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '# 测试\n\n你好\n\n再见\n')
  let app
  try {
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile'),
      port,
      appArgs: [file]
    })
    let { evaluate, send } = app
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
      'rich editor did not open'
    )

    // Scenario A: empty out the middle paragraph (delete all its text), then
    // type '.', delete, type '/', delete — exactly the user's repro.
    await clickRichBlock(evaluate, send, 'p')
    await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraph = [...editor.querySelectorAll('p')].find((node) => node.textContent === '你好')
      const text = paragraph.firstChild
      const range = document.createRange()
      range.setStart(text, text.nodeValue.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`)
    for (const _ of '你好') await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await rawKey(send, '.', 'Period', 190)
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await rawKey(send, '/', 'Slash', 191)
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await sleepMs(700)

    await toggleSource(evaluate)
    const sourceValue = await waitFor(() => visibleSource(evaluate), 'source did not open')
    assert.equal(sourceValue, '# 测试\n\n\n\n再见\n', 'emptying a middle paragraph must not leak <br /> into source')

    await toggleSource(evaluate)
    await sleepMs(400)

    // Scenario B: press Enter to create an empty paragraph, then the same
    // '.' '/' dance on that fresh empty line.
    await clickRichBlock(evaluate, send, 'p')
    await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraph = [...editor.querySelectorAll('p')].find((node) => node.textContent === '再见')
      const text = paragraph.firstChild
      const range = document.createRange()
      range.setStart(text, text.nodeValue.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 60 })
    await sleepMs(400)
    await rawKey(send, '.', 'Period', 190)
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await rawKey(send, '/', 'Slash', 191)
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await sleepMs(700)

    await toggleSource(evaluate)
    const sourceValueB = await waitFor(() => visibleSource(evaluate), 'source B did not open')
    assert.ok(
      !/<br\s*\/?>/.test(sourceValueB || ''),
      'typing and deleting inside an empty paragraph must never leak <br /> into source'
    )
    assert.ok(sourceValueB.includes('再见'), 'the untouched paragraph must survive the empty-line dance')

    // Scenario C: empty the trailing paragraph and switch — the last block
    // must not serialize its internal <br /> either.
    await toggleSource(evaluate)
    await sleepMs(400)
    await clickRichBlock(evaluate, send, 'p')
    await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraph = [...editor.querySelectorAll('p')].find((node) => node.textContent === '再见')
      const text = paragraph.firstChild
      const range = document.createRange()
      range.setStart(text, text.nodeValue.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`)
    for (const _ of '再见') await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await sleepMs(700)
    await toggleSource(evaluate)
    const sourceValueC = await waitFor(() => visibleSource(evaluate), 'source C did not open')
    assert.ok(
      !/<br\s*\/?>/.test(sourceValueC || ''),
      'emptying the trailing paragraph must not leak <br /> into source'
    )

    // Scenario D: the exact user repro on a heading-based document. Press
    // Enter inside a heading (empty paragraph after it), create ANOTHER empty
    // paragraph elsewhere, then run the '.' '/' dance in the heading's empty
    // paragraph. The unrelated empty paragraph used to veto the mapping and
    // let <br /> leak through the localized replacement.
    await toggleSource(evaluate)
    await sleepMs(400)
    await writeFile(file, '# 标题\n\n## 第一节\n\n正文甲\n\n## 第二节\n\n正文乙\n')
    await stopBuiltElectron(app, { removeProfile: true })
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile-d'),
      port: port + 1,
      appArgs: [file]
    })
    evaluate = app.evaluate
    send = app.send
    await waitFor(
      () => evaluate(`(() => {
        const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
        return !!editor?.textContent.includes('正文乙')
      })()`),
      'heading fixture did not reload'
    )
    await clickRichBlock(evaluate, send, 'h2')
    await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const heading = [...editor.querySelectorAll('h2')].find((node) => node.textContent === '第一节')
      const text = heading.firstChild
      const range = document.createRange()
      range.setStart(text, text.nodeValue.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 60 })
    await sleepMs(400)
    // unrelated empty paragraph at the end
    await clickRichBlock(evaluate, send, 'p')
    await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraph = [...editor.querySelectorAll('p')].find((node) => node.textContent === '正文乙')
      const text = paragraph.firstChild
      const range = document.createRange()
      range.setStart(text, text.nodeValue.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 60 })
    await sleepMs(400)
    // dance in the heading's empty paragraph
    await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraphs = [...editor.querySelectorAll('p')]
      const empty = paragraphs.find((node) => !node.textContent.trim())
      if (!empty) return false
      const range = document.createRange()
      range.setStart(empty, 0)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`)
    await rawKey(send, '.', 'Period', 190)
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await rawKey(send, '/', 'Slash', 191)
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 60 })
    await sleepMs(700)
    await toggleSource(evaluate)
    const sourceValueD = await waitFor(() => visibleSource(evaluate), 'source D did not open')
    assert.ok(
      !/<br\s*\/?>/.test(sourceValueD || ''),
      'a heading-created empty paragraph plus another unrelated empty paragraph must not leak <br /> into source'
    )
    assert.ok(sourceValueD.includes('正文乙'), 'the unrelated paragraph must survive the heading empty-line dance')

    // Scenario E: a writer presses Enter at the end of a paragraph while a
    // later paragraph already exists. The resulting empty rich block must
    // become physical Markdown blank lines, survive save, and remain visible
    // in source mode after a cold reopen.
    await stopBuiltElectron(app, { removeProfile: true })
    await writeFile(file, '# 空行\n\n段落甲\n\n段落乙\n')
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile-e'),
      port: port + 2,
      appArgs: [file]
    })
    evaluate = app.evaluate
    send = app.send
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent)?.textContent.includes('段落乙')`),
      'middle-empty fixture did not reload'
    )
    await clickRichBlock(evaluate, send, 'p')
    await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraph = [...editor.querySelectorAll('p')].find((node) => node.textContent === '段落甲')
      const text = paragraph?.firstChild
      if (!text) return false
      const range = document.createRange()
      range.setStart(text, text.nodeValue.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 60 })
    await sleepMs(700)
    await toggleSource(evaluate)
    const expectedMiddleBlankLines = '# 空行\n\n段落甲\n\n\n\n段落乙\n'
    assert.equal(
      await waitFor(() => visibleSource(evaluate), 'middle-empty source did not open'),
      expectedMiddleBlankLines,
      'a newly created middle empty paragraph must save as physical blank lines'
    )
    await toggleSource(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'middle-empty save button did not appear')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'middle-empty save did not finish')
    assert.equal(await readFile(file, 'utf8'), expectedMiddleBlankLines,
      'middle empty paragraph was not written as portable Markdown blank lines')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile-e-reopen'),
      port: port + 3,
      appArgs: [file]
    })
    evaluate = app.evaluate
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`),
      'middle-empty document did not cold reopen'
    )
    await toggleSource(evaluate)
    assert.equal(
      await waitFor(() => visibleSource(evaluate), 'middle-empty source did not open after cold reopen'),
      expectedMiddleBlankLines,
      'cold reopen rewrote the physical blank-line source'
    )

    // Scenario F: Enter on a middle empty ordered-list item exits into an
    // empty paragraph and splits the rich list. A second Enter used to leave
    // that transient split in the document; the empty-item source mapper then
    // dropped every later list row and the durable gate made source/save fail.
    // Source-first behavior must collapse only this newly split `.` list back
    // into a portable ordered list before the mapper publishes it.
    await stopBuiltElectron(app, { removeProfile: true })
    await writeFile(file, '1. 第一项\n\n2. \n\n3. 第三项\n\n4. 第四项\n\n# 后续\n')
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile-f'),
      port: port + 4,
      appArgs: [file]
    })
    evaluate = app.evaluate
    send = app.send
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent)?.textContent.includes('第四项')`),
      'middle-list-exit fixture did not reload'
    )
    assert.equal(await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraph = [...editor.querySelectorAll('li p')].find((node) => !node.textContent.trim())
      if (!paragraph) return false
      const range = document.createRange()
      range.setStart(paragraph, 0)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`), true, 'could not place the caret in the middle empty list item')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 70 })
    await sleepMs(500)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 70 })
    await sleepMs(700)
    assert.equal(await toggleSource(evaluate), true, 'list-exit source toggle did not run')
    const listExitSource = await waitFor(
      () => visibleSource(evaluate),
      'list-exit source was rejected by the durable gate'
    )
    assert.ok(!/<br\s*\/?>/.test(listExitSource), 'list exit leaked an internal <br /> into source')
    assert.ok(!/^\s*\d+\)/m.test(listExitSource), 'list exit used a synthetic 1) delimiter')
    assert.ok(listExitSource.includes('第一项'), 'list exit lost the first list item')
    assert.ok(listExitSource.includes('第三项'), 'list exit lost the following list item')
    assert.ok(listExitSource.includes('第四项'), 'list exit lost the final list item')
    assert.ok(listExitSource.includes('# 后续'), 'list exit lost the following heading')
    await toggleSource(evaluate)
    assert.equal(await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const heading = editor?.querySelector('h1')
      const text = heading?.firstChild
      if (!text) return false
      const range = document.createRange()
      range.setStart(text, text.nodeValue.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`), true, 'could not edit the heading after the list exit')
    await rawKey(send, 'X', 'KeyX', 88)
    await sleepMs(500)
    assert.equal(await toggleSource(evaluate), true, 'list-exit source did not reopen after a later edit')
    const savedListExitSource = await waitFor(
      () => visibleSource(evaluate),
      'list-exit source was rejected after a later edit'
    )
    assert.ok(savedListExitSource.includes('# 后续X'), 'later heading edit did not reach source')
    assert.ok(savedListExitSource.includes('第三项'), 'later source flush lost the following list item')
    assert.ok(!/<br\s*\/?>/.test(savedListExitSource), 'later source flush leaked an internal <br />')
    await toggleSource(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'list-exit save button did not appear')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'list-exit save did not finish')
    assert.equal(await readFile(file, 'utf8'), savedListExitSource,
      'list-exit source did not save byte-for-byte')

    // Scenario G: the same exit can start inside a nested ordered list. It
    // must either remain nested or lift through standard list semantics, but
    // it may never leave a source-only `<br />` placeholder or lock source
    // mode just because a rich list subtree changed shape.
    await stopBuiltElectron(app, { removeProfile: true })
    await writeFile(file, '- 外层\n  1. 嵌套一\n  2. \n  3. 嵌套三\n- 尾项\n\n# 后续\n')
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile-g'),
      port: port + 5,
      appArgs: [file]
    })
    evaluate = app.evaluate
    send = app.send
    await evaluate(`(() => {
      window.__hmGateLog = []
      window.__hmPreserveLog = []
    })()`)
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent)?.textContent.includes('嵌套三')`),
      'nested-list-exit fixture did not reload'
    )
    assert.equal(await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraph = [...editor.querySelectorAll('li p')].find((node) => !node.textContent.trim())
      if (!paragraph) return false
      const range = document.createRange()
      range.setStart(paragraph, 0)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`), true, 'could not place the caret in the nested empty list item')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 70 })
    await sleepMs(500)
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 70 })
    await sleepMs(700)
    assert.equal(await toggleSource(evaluate), true, 'nested-list-exit source toggle did not run')
    let nestedListExitSource = null
    for (let attempt = 0; attempt < 60; attempt += 1) {
      nestedListExitSource = await visibleSource(evaluate)
      if (nestedListExitSource != null || app.dialogs.length) break
      await sleepMs(100)
    }
    const nestedExitDiagnostics = await evaluate(`(() => ({
      gate: window.__hmGateLog || [],
      preserve: window.__hmPreserveLog || []
    }))()`)
    assert.equal(
      typeof nestedListExitSource,
      'string',
      `nested-list-exit source was rejected: ${JSON.stringify({ dialogs: app.dialogs, ...nestedExitDiagnostics })}`
    )
    assert.ok(!/<br\s*\/?>/.test(nestedListExitSource), 'nested list exit leaked an internal <br />')
    assert.ok(nestedListExitSource.includes('嵌套一'), 'nested list exit lost the first nested item')
    assert.ok(nestedListExitSource.includes('嵌套三'), 'nested list exit lost the following nested item')
    assert.ok(nestedListExitSource.includes('尾项'), 'nested list exit lost the outer sibling')
    assert.ok(nestedListExitSource.includes('# 后续'), 'nested list exit lost the following heading')

    // Scenario H: deleting the text from the item immediately before an
    // already-empty parent list item creates two consecutive empty list
    // parents. The second parent owns nested ordered children, just as in the
    // reported document. Source mode, save and cold reopen must retain every
    // sibling and child rather than rejecting the rich document as unowned.
    await stopBuiltElectron(app, { removeProfile: true })
    await writeFile(file, [
      '1. 21313',
      '2. 测试',
      '3. 1312312',
      '   23123',
      '4. 牛逼',
      '5. ',
      '6. 213123',
      '7. 临时',
      '8. ',
      '   1. 测试',
      '   2. 啊但是大大',
      '',
      '2313122312',
      '',
      '我觉得还可以',
      ''
    ].join('\n'))
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile-h'),
      port: port + 6,
      appArgs: [file]
    })
    evaluate = app.evaluate
    send = app.send
    await evaluate(`(() => {
      window.__hmGateLog = []
      window.__hmPreserveLog = []
    })()`)
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent)?.textContent.includes('啊但是大大')`),
      'consecutive-empty-list fixture did not reload'
    )
    assert.equal(await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraph = [...editor.querySelectorAll('li p')].find((node) => node.textContent === '临时')
      const text = paragraph?.firstChild
      if (!text) return false
      const range = document.createRange()
      range.setStart(text, text.nodeValue.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`), true, 'could not place the caret in the item before consecutive empty list parents')
    for (const _ of '临时') {
      await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 70 })
    }
    await sleepMs(800)
    assert.equal(await toggleSource(evaluate), true, 'consecutive-empty-list source toggle did not run')
    let consecutiveEmptySource = null
    for (let attempt = 0; attempt < 60; attempt += 1) {
      consecutiveEmptySource = await visibleSource(evaluate)
      if (consecutiveEmptySource != null || app.dialogs.length) break
      await sleepMs(100)
    }
    const consecutiveEmptyDiagnostics = await evaluate(`(() => ({
      gate: window.__hmGateLog || [],
      preserve: window.__hmPreserveLog || []
    }))()`)
    assert.equal(
      typeof consecutiveEmptySource,
      'string',
      `consecutive empty list parents rejected source: ${JSON.stringify({ dialogs: app.dialogs, ...consecutiveEmptyDiagnostics })}`
    )
    assert.ok(!/<br\s*\/?>/.test(consecutiveEmptySource), 'consecutive empty list parents leaked an internal <br />')
    assert.ok(!consecutiveEmptySource.includes('临时'), 'clearing the list item did not reach source')
    assert.ok(consecutiveEmptySource.includes('213123'), 'consecutive empty list parents lost the preceding sibling')
    assert.ok(consecutiveEmptySource.includes('啊但是大大'), 'consecutive empty list parents lost the nested child')
    assert.ok(consecutiveEmptySource.includes('2313122312'), 'consecutive empty list parents lost following prose')
    await toggleSource(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'consecutive-empty-list save button did not appear')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'consecutive-empty-list save did not finish')
    assert.equal(await readFile(file, 'utf8'), consecutiveEmptySource,
      'consecutive empty list parents did not save byte-for-byte')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile-h-reopen'),
      port: port + 7,
      appArgs: [file]
    })
    evaluate = app.evaluate
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent)?.textContent.includes('啊但是大大')`),
      'consecutive empty list parents did not cold reopen'
    )
    assert.equal(await toggleSource(evaluate), true, 'consecutive-empty-list source did not open after cold reopen')
    assert.equal(
      await waitFor(() => visibleSource(evaluate), 'consecutive-empty-list source did not appear after cold reopen'),
      consecutiveEmptySource,
      'cold reopen rewrote the consecutive empty list parent source'
    )

    // Scenario I: create the first empty parent through Enter immediately
    // before a parent that already has nested children, then clear that
    // parent's text. This preserves the transaction history from the report:
    // a fresh empty item and an emptied parent-with-children become adjacent.
    await stopBuiltElectron(app, { removeProfile: true })
    await writeFile(file, [
      '1. 21313',
      '2. 测试',
      '3. 1312312',
      '   23123',
      '4. 牛逼',
      '5. ',
      '6. 213123',
      '7. 临时',
      '   1. 测试',
      '   2. 啊但是大大',
      '',
      '2313122312',
      '',
      '我觉得还可以',
      ''
    ].join('\n'))
    app = await launchBuiltElectron({
      profileDir: join(root, 'profile-i'),
      port: port + 8,
      appArgs: [file]
    })
    evaluate = app.evaluate
    send = app.send
    await evaluate(`(() => {
      window.__hmGateLog = []
      window.__hmPreserveLog = []
    })()`)
    await waitFor(
      () => evaluate(`!![...document.querySelectorAll('.ProseMirror')]
        .find((node) => node.offsetParent)?.textContent.includes('啊但是大大')`),
      'consecutive-empty-history fixture did not reload'
    )
    assert.equal(await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraph = [...editor.querySelectorAll('li p')].find((node) => node.textContent === '213123')
      const text = paragraph?.firstChild
      if (!text) return false
      const range = document.createRange()
      range.setStart(text, text.nodeValue.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`), true, 'could not place the caret before the first consecutive empty parent')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: 70 })
    await sleepMs(500)
    assert.equal(await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const paragraph = [...editor.querySelectorAll('li p')].find((node) => node.textContent === '临时')
      const text = paragraph?.firstChild
      if (!text) return false
      const range = document.createRange()
      range.setStart(text, text.nodeValue.length)
      range.collapse(true)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      editor.focus()
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })()`), true, 'could not place the caret in the parent with nested children')
    for (const _ of '临时') {
      await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: 70 })
    }
    await sleepMs(800)
    assert.equal(await toggleSource(evaluate), true, 'consecutive-empty-history source toggle did not run')
    let consecutiveHistorySource = null
    for (let attempt = 0; attempt < 60; attempt += 1) {
      consecutiveHistorySource = await visibleSource(evaluate)
      if (consecutiveHistorySource != null || app.dialogs.length) break
      await sleepMs(100)
    }
    const consecutiveHistoryDiagnostics = await evaluate(`(() => ({
      gate: window.__hmGateLog || [],
      preserve: window.__hmPreserveLog || []
    }))()`)
    assert.equal(
      typeof consecutiveHistorySource,
      'string',
      `consecutive empty list history rejected source: ${JSON.stringify({ dialogs: app.dialogs, ...consecutiveHistoryDiagnostics })}`
    )
    assert.ok(!/<br\s*\/?>/.test(consecutiveHistorySource), 'consecutive empty list history leaked an internal <br />')
    assert.ok(!consecutiveHistorySource.includes('临时'), 'clearing the nested parent did not reach source')
    assert.ok(consecutiveHistorySource.includes('213123'), 'consecutive empty list history lost the preceding sibling')
    assert.ok(consecutiveHistorySource.includes('啊但是大大'), 'consecutive empty list history lost the nested child')
    assert.ok(consecutiveHistorySource.includes('2313122312'), 'consecutive empty list history lost following prose')
    await toggleSource(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'consecutive-empty-history save button did not appear')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'consecutive-empty-history save did not finish')
    assert.equal(await readFile(file, 'utf8'), consecutiveHistorySource,
      'consecutive empty list history did not save byte-for-byte')

    console.log('PASS empty-paragraph source fidelity: placeholders never leak, created middle blanks save as source lines, and nested or top-level list exits stay portable')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
