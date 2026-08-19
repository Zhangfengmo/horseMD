// Real Electron regression for #70 outline fold state and #72 task-list input.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const dir = join(tmpdir(), 'horsemd-issues-70-72')
const visiblePm = `[...document.querySelectorAll('.ProseMirror')].find((pm) => pm.offsetParent !== null)`

async function waitFor(evaluate, expr, label, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    if (await evaluate(expr)) return true
    await sleep(250)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function activateTab(evaluate, name) {
  await evaluate(`([...document.querySelectorAll('.tab')].find((tab) => tab.textContent.includes(${JSON.stringify(name)}))?.click(), true)`)
  await sleep(300)
}

const visibleSource = (app) => app.evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

const toggleSourceMode = (app) => app.evaluate(`(() => {
  const button = [...document.querySelectorAll('.status-btn')]
    .find((node) => node.offsetParent && /源码|Source|富文本|Rich|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
  button?.click()
  return !!button
})()`)

async function testOutlineFoldState() {
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'outline-issue70.md')
  await writeFile(file, '# Top\n\n## Parent title\n\n### Child should stay visible\n\nbody\n')

  const app = await launchBuiltElectron({
    profileDir: join(dir, 'profile-outline'),
    port: Number(process.env.CDP_PORT || 9470),
    appArgs: [file]
  })
  try {
    await sleep(1200)
    await activateTab(app.evaluate, '欢迎')
    await activateTab(app.evaluate, 'outline-issue70')
    await waitFor(app.evaluate, `!!(${visiblePm})?.querySelector('h2')?.textContent.includes('Parent title')`, 'outline fixture editor')
    await waitFor(app.evaluate, `document.querySelectorAll('.outline-item .outline-item-text').length >= 2`, 'outline rows')

    const before = await app.evaluate(`(() => [...document.querySelectorAll('.outline-item .outline-item-text')].map((node) => node.textContent.trim()).join('|'))()`)
    if (!before.includes('Parent title') || before.includes('Child should stay visible')) {
      throw new Error(`Unexpected default outline state: ${before}`)
    }

    await app.evaluate(`(() => {
      const parent = [...document.querySelectorAll('.outline-item')]
        .find((row) => row.textContent.includes('Parent title'))
      parent?.querySelector('.outline-twisty')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return true
    })()`)
    await sleep(400)

    const expanded = await app.evaluate(`(() => [...document.querySelectorAll('.outline-item .outline-item-text')].map((node) => node.textContent.trim()).join('|'))()`)
    if (!expanded.includes('Child should stay visible')) throw new Error(`Outline expand failed: ${expanded}`)

    const globalControl = await app.evaluate(`(() => {
      const button = document.querySelector('.outline-head-btn')
      return { disabled: !!button?.disabled, title: button?.title || '' }
    })()`)
    if (globalControl.disabled || !/全部折叠|Collapse all/i.test(globalControl.title)) {
      throw new Error(`Outline global collapse control is unavailable: ${JSON.stringify(globalControl)}`)
    }
    await app.evaluate(`document.querySelector('.outline-head-btn')?.click()`)
    await sleep(250)
    const globallyCollapsed = await app.evaluate(`(() => [...document.querySelectorAll('.outline-item .outline-item-text')].map((node) => node.textContent.trim()).join('|'))()`)
    if (globallyCollapsed !== 'Top') throw new Error(`Outline global collapse failed: ${globallyCollapsed}`)
    await app.evaluate(`document.querySelector('.outline-head-btn')?.click()`)
    await sleep(250)
    const globallyExpanded = await app.evaluate(`(() => [...document.querySelectorAll('.outline-item .outline-item-text')].map((node) => node.textContent.trim()).join('|'))()`)
    if (!globallyExpanded.includes('Parent title') || !globallyExpanded.includes('Child should stay visible')) {
      throw new Error(`Outline global expand failed: ${globallyExpanded}`)
    }

    await app.evaluate(`(() => {
      const pm = ${visiblePm}
      const h2 = [...pm.querySelectorAll('h2')].find((node) => node.textContent.includes('Parent title'))
      const text = h2?.firstChild
      if (!text) throw new Error('Missing editable H2 text')
      const range = document.createRange()
      range.setStart(text, 0)
      range.setEnd(text, text.textContent.length)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      pm.focus()
      return true
    })()`)
    await app.send('Input.insertText', { text: 'Renamed parent title' })
    await sleep(900)

    const after = await app.evaluate(`(() => [...document.querySelectorAll('.outline-item .outline-item-text')].map((node) => node.textContent.trim()).join('|'))()`)
    if (!after.includes('Renamed parent title') || !after.includes('Child should stay visible')) {
      throw new Error(`Issue #70 still reproduces: ${after}`)
    }
    return after
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

async function testTaskListInput() {
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'task-issue72.md')
  await writeFile(file, '')

  const app = await launchBuiltElectron({
    profileDir: join(dir, 'profile-task'),
    port: Number(process.env.CDP_PORT_TASK || 9471),
    appArgs: [file]
  })
  try {
    await sleep(1200)
    await activateTab(app.evaluate, '欢迎')
    await activateTab(app.evaluate, 'task-issue72')
    await waitFor(app.evaluate, `!!(${visiblePm})`, 'task fixture editor')

    await app.evaluate(`(() => {
      const pm = ${visiblePm}
      pm.focus()
      const range = document.createRange()
      range.selectNodeContents(pm)
      range.collapse(false)
      const selection = getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      return true
    })()`)
    // Task-list input rules are triggered while the user types: do not model
    // this as one paste transaction, or a regression in the intermediate
    // ordinary-list state stays invisible.
    //
    // The marker and its label are ONE typing stream, deliberately not two
    // awaited calls. A label-less task is a documented rich-only transient: the
    // app demotes it back to literal `[ ]` text at any durability boundary, and
    // Editor.jsx's rich-dirty reconcile makes one of those fire 260 ms after the
    // last edit (`demoteEmptyTaskItemsInView` via `flushMarkdown`). Every extra
    // await between the closing `] ` and the first label character is another
    // place a stalled test process can spend that budget and report an
    // input-rule regression that never happened — measured: a 300 ms gap here
    // fails 2/2, a 200 ms gap passes 2/2.
    await typeTextLikeUser(app.send, '* [ ] 牛逼')
    await sleep(600)

    const snapshot = JSON.parse(await app.evaluate(`(() => {
      const pm = ${visiblePm}
      return JSON.stringify({
        taskControls: pm.querySelectorAll('.milkdown-list-item-block .label.unchecked, .milkdown-list-item-block .label.checked, .task-list-item, li[data-item-type="task"], input[type="checkbox"]').length,
        taskText: [...pm.querySelectorAll('.milkdown-list-item-block .children')]
          .map((node) => node.textContent || '').join(' | '),
        html: pm.innerHTML.slice(0, 500)
      })
    })()`))
    if (snapshot.taskControls < 1) throw new Error(`Issue #72 still reproduces: ${JSON.stringify(snapshot)}`)
    if (!snapshot.taskText.includes('牛逼')) throw new Error(`Issue #72 lost text typed after the task marker: ${JSON.stringify(snapshot)}`)

    if (!await toggleSourceMode(app)) throw new Error('Could not open source mode after task-list input')
    await waitFor(() => visibleSource(app), 'task-list source mode')
    const source = await visibleSource(app)
    if (!/^\* \[ \][ \t]+牛逼$/m.test(source) || source.includes('\\[ ]')) {
      throw new Error(`Issue #72 task source was not preserved as task syntax: ${JSON.stringify(source)}`)
    }
    if (!await toggleSourceMode(app)) throw new Error('Could not return to rich mode after task-list input')

    return snapshot.taskControls
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

const outline = await testOutlineFoldState()
const taskControls = await testTaskListInput()
console.log(`PASS issues 70-72 UI: ${JSON.stringify({ outline, taskControls })}`)
