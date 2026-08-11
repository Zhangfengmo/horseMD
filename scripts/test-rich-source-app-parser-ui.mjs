// A source-acceptance regression for documents whose authored Markdown and
// Crepe's canonical serializer differ structurally. GFM permits short table
// rows, while the app parser pads them to the table width in ProseMirror. That
// normalization must not make an ordinary rich edit fail closed: acceptance
// must compare through the app parser, not an independent Markdown parser.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-rich-source-app-parser-${process.pid}`
const port = Number(process.env.CDP_PORT || 10066)
const tail = '结尾正文'
const inserted = '新增段落'
const raggedRow = '| only-one-cell |'
const initial = [
  '# App parser source acceptance',
  '',
  'The code languages are deliberately unrelated to the table normalization.',
  '',
  '```go',
  'package main',
  'func main() { println("go") }',
  '```',
  '',
  '```javascript',
  'const language = "javascript"',
  'console.log(language)',
  '```',
  '',
  '```typescript',
  'const language: string = "typescript"',
  'console.log(language)',
  '```',
  '',
  '```python',
  'language = "python"',
  'print(language)',
  '```',
  '',
  '```rust',
  'fn main() { println!("rust"); }',
  '```',
  '',
  '```java',
  'class Main { public static void main(String[] args) { System.out.println("java"); } }',
  '```',
  '',
  '```c',
  '#include <stdio.h>',
  'int main(void) { puts("c"); return 0; }',
  '```',
  '',
  '```cpp',
  '#include <iostream>',
  'int main() { std::cout << "cpp"; }',
  '```',
  '',
  '| one | two | three | four | five |',
  '| --- | --- | --- | --- | --- |',
  '| a | b | c | d | e |',
  raggedRow,
  '| v | w | x | y | z |',
  '',
  tail,
  ''
].join('\n')
const expected = initial.replace(`${tail}\n`, `${tail}${inserted}\n`)

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
    assert.ok(outcome.source.includes(raggedRow), `${checkpoint}: short table row was padded or removed`)
  }
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const file = join(root, 'ragged-table-code-matrix.md')
  await writeFile(file, initial)

  let app
  try {
    app = await openApp('edit', file, port)
    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmGateLog = []
    })()`)
    await placeCaretAtParagraphEnd(app, tail)

    // Committed input is sent one character at a time. This is not an IME
    // composition test; it exercises the real incremental editor path.
    await typeTextLikeUser(app.send, inserted)
    await waitFor(
      () => app.evaluate(`!!document.querySelector('.hm-save-fab')`),
      'rich edit did not become dirty'
    )
    await sleep(500)

    await inspectSourceWithoutRecovery(app, 'after rich edit', expected)
    await saveWithoutRecovery(app, 'authored-ragged source save')
    assert.equal(await readFile(file, 'utf8'), expected, 'save changed untouched authored bytes')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('reopen', file, port + 1)
    await inspectSourceWithoutRecovery(app, 'cold reopen', expected)
    assert.equal(await readFile(file, 'utf8'), expected, 'cold reopen changed disk bytes')

    // A column resize is an explicit table operation and may canonicalize that
    // table block. Its non-Markdown colwidth metadata and internal empty-cell
    // `<br />` placeholders must still pass the live forced-save boundary.
    await stopBuiltElectron(app, { removeProfile: true })
    const resizedFile = join(root, 'resized-ragged-table-code-matrix.md')
    await writeFile(resizedFile, initial)
    app = await openApp('resize-edit', resizedFile, port + 2)
    await app.evaluate(`(() => {
      window.__hmPreserveLog = []
      window.__hmGateLog = []
    })()`)
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
    assert.ok(resizedSource.includes('only-one-cell'), 'resized table lost its ragged-row content')
    for (const language of ['go', 'javascript', 'typescript', 'python', 'rust', 'java', 'c', 'cpp']) {
      assert.ok(resizedSource.includes(`\`\`\`${language}\n`), `resized save lost ${language} code`)
    }
    await inspectSourceWithoutRecovery(app, 'after resized-table save', resizedSource, {
      requireAuthoredRaggedRow: false
    })

    await stopBuiltElectron(app, { removeProfile: true })
    app = await openApp('resize-reopen', resizedFile, port + 3)
    await inspectSourceWithoutRecovery(app, 'resized-table cold reopen', resizedSource, {
      requireAuthoredRaggedRow: false
    })
    assert.equal(await readFile(resizedFile, 'utf8'), resizedSource, 'resized-table reopen changed disk bytes')

    console.log('PASS app-parser source acceptance: exact ragged source and resized-table semantics survive 8 languages, save, source, and reopen')
  } finally {
    if (app) await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
