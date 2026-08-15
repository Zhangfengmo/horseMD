import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-empty-task-list-${process.pid}`
const file = join(root, 'empty-task.md')
const port = 10300 + (process.pid % 200)

const waitFor = async (check, message, attempts = 100) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const taskState = (app) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')]
    .find((node) => node.offsetParent !== null)
  const item = editor?.querySelector('.milkdown-list-item-block')
  return item ? {
    text: item.querySelector('.children')?.textContent?.trim() || '',
    checked: Boolean(item.querySelector('.label.checked')),
    unchecked: Boolean(item.querySelector('.label.unchecked'))
  } : null
})()`)

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const toggleMode = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|富文本|Rich|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

const caretAfterTaskText = (app, text) => app.evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')]
    .find((node) => node.offsetParent !== null)
  if (!editor) return false
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode())) {
    const offset = node.nodeValue.indexOf(${JSON.stringify(text)})
    if (offset < 0) continue
    editor.focus()
    const range = document.createRange()
    range.setStart(node, offset + ${JSON.stringify(text)}.length)
    range.collapse(true)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return true
  }
  return false
})()`)

const click = async (app, point) => {
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

const save = async (app) => {
  const point = await waitFor(() => app.evaluate(`(() => {
    const button = document.querySelector('.hm-save-fab')
    const rect = button?.getBoundingClientRect()
    return rect ? {
      x: Math.round((rect.left + rect.right) / 2),
      y: Math.round((rect.top + rect.bottom) / 2)
    } : null
  })()`), 'emptying the task did not make the document dirty')
  await click(app, point)
  await waitFor(
    () => app.evaluate(`!document.querySelector('.hm-save-fab')`),
    'saving the empty task did not settle'
  )
}

const openApp = async ({ cleanProfile, appPort, profile, text }) => {
  const executable = process.env.HORSEMD_EXECUTABLE || undefined
  const app = await launchBuiltElectron({
    profileDir: profile,
    port: appPort,
    cleanProfile,
    appArgs: [file],
    executable,
    entrypoint: executable ? null : undefined
  })
  await waitFor(
    async () => (await taskState(app))?.text === text,
    'task-list fixture did not mount'
  )
  return app
}

const runScenario = async ({ checked, expected, original, text }, index) => {
  const scenario = checked ? 'checked' : 'unchecked'
  const profile = join(root, `profile-${scenario}`)
  const appPort = port + index * 1000
  await writeFile(file, original, 'utf8')

  let app = await openApp({ cleanProfile: true, appPort, profile, text })
  try {
    assert.deepEqual(await taskState(app), {
      text, checked, unchecked: !checked
    }, `the initial ${scenario} task did not render`)
    assert.equal(await caretAfterTaskText(app, text), true, 'could not place the caret after the task text')
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 80 })
    await waitFor(async () => {
      const state = await taskState(app)
      return state?.text === (checked ? '[x]' : '[ ]') && !state.checked && !state.unchecked
    }, `deleting the last task character did not demote it to ordinary ${scenario} list text`)
    assert.equal(await toggleMode(app), true, 'could not switch the demoted task to source mode')
    assert.equal(
      await waitFor(() => visibleSource(app), 'source mode did not settle after task demotion'),
      expected,
      `source mode must expose the portable ordinary ${scenario} list spelling`
    )
    assert.equal(await toggleMode(app), true, 'could not return from source mode after task demotion')
    await save(app)
    assert.equal(await readFile(file, 'utf8'), expected,
      `an empty ${scenario} task must save as portable ordinary GFM list text`)
    assert.deepEqual(app.dialogs.map((dialog) => dialog.message), [],
      'an empty task must not require recovery')
  } finally {
    await stopBuiltElectron(app)
  }

  app = await openApp({
    cleanProfile: false,
    appPort: appPort + 100,
    profile,
    text: checked ? '[x]' : '[ ]'
  })
  try {
    assert.deepEqual(await taskState(app), {
      text: checked ? '[x]' : '[ ]', checked: false, unchecked: false
    }, `the demoted ${scenario} task did not survive a cold reopen as ordinary text`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  try {
    await runScenario({
      checked: false,
      original: '* [ ] 甲\n',
      expected: '* [ ]\n',
      text: '甲'
    }, 0)
    await runScenario({
      checked: true,
      original: '* [x] 乙\n',
      expected: '* [x]\n',
      text: '乙'
    }, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  console.log('Empty task-list source-first UI regression passed: both empty task states demote to portable ordinary text.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
