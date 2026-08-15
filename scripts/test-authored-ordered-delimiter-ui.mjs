import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-authored-ordered-delimiter-${process.pid}`
const file = join(root, 'authored-delimiter.md')
const port = Number(process.env.CDP_PORT || 9813)
const source = '# 标题\n\n1. 第一项\n\n1) 第二项\n'
const expected = '# 标题X\n\n1. 第一项\n\n1) 第二项\n'

async function waitFor(check, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
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

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, source)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    const { evaluate, send } = app
    await waitFor(() => evaluate(`!![...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)?.querySelector('h1')`), 'document did not mount')

    const point = await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
      const heading = editor?.querySelector('h1')
      if (!heading) return null
      const rect = heading.getBoundingClientRect()
      return { x: rect.left + 10, y: rect.top + Math.min(12, rect.height / 2) }
    })()`)
    assert.ok(point, 'title block is missing')
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    await pressKey(send, { key: 'End', code: 'End' })
    await typeTextLikeUser(send, 'X')

    assert.equal(await toggleSource(evaluate), true, 'could not open source mode')
    assert.equal(
      await waitFor(() => visibleSource(evaluate), 'source textarea did not open'),
      expected,
      'an unrelated edit rewrote the authored ordered-list delimiter'
    )
    assert.equal(await toggleSource(evaluate), true, 'could not return to rich mode')
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button did not appear')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    assert.equal(await readFile(file, 'utf8'), expected, 'save rewrote authored `1)` source')

    await stopBuiltElectron(app, { removeProfile: true })
    app = await launchBuiltElectron({ profileDir: join(root, 'profile-reopen'), port: port + 1, appArgs: [file] })
    await waitFor(() => app.evaluate(`!![...document.querySelectorAll('.ProseMirror')]
      .find((node) => node.offsetParent)`), 'saved document did not reopen')
    assert.equal(await toggleSource(app.evaluate), true, 'could not open source after reopen')
    assert.equal(
      await waitFor(() => visibleSource(app.evaluate), 'source textarea did not open after reopen'),
      expected,
      'full reopen rewrote authored `1)` source'
    )

    console.log('PASS authored ordered delimiter: unrelated edits preserve `1)` source through save and reopen')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    try { await rm(root, { recursive: true, force: true }) } catch { /* Chromium may release files shortly after shutdown */ }
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
