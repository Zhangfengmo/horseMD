// A just-typed checkbox must survive a thinking pause.
//
// Ruling 2026-08-20 (docs/empty-paragraph-contract.md §3.1): the empty-task
// demotion belongs to a deletion and to genuine source/save boundaries — never
// to the unforced background dirty-reconcile, which publishes nothing. Before
// the fix, typing `- [ ] ` and pausing ~0.3 s turned the new checkbox back into
// the literal characters `[ ]` in the rich view (reloading the file rendered a
// checkbox again, so only the live rich state was wrong).
//
// This test therefore locks BOTH halves of the ruling:
//   1. the checkbox survives an idle second, and typing continues normally;
//   2. every forced boundary still produces the exact bytes it produced before
//      the fix — an empty task saves and shows as ordinary GFM list text, and
//      deleting a label back to empty still demotes immediately.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser, pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-empty-task-pause-${process.pid}`
const visiblePm = `[...document.querySelectorAll('.ProseMirror')].find((pm) => pm.offsetParent !== null)`

// The measured demotion window: the reconcile timer fires 260 ms after the last
// edit, and the pre-fix repro was pinned at 0 ms pass / 200 ms pass / 300 ms
// fail. A full second is both the user-visible acceptance ("wait a second doing
// nothing") and a wide margin over that timer.
const THINKING_PAUSE_MS = 1000

const waitFor = async (check, message, attempts = 60) => {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(200)
  }
  throw new Error(message)
}

const taskState = (app) => app.evaluate(`(() => {
  const pm = ${visiblePm}
  if (!pm) return JSON.stringify(null)
  const item = pm.querySelector('.milkdown-list-item-block')
  return JSON.stringify(item ? {
    checkboxes: pm.querySelectorAll('.milkdown-list-item-block .label.unchecked, .milkdown-list-item-block .label.checked').length,
    text: item.querySelector('.children')?.textContent ?? ''
  } : null)
})()`).then((raw) => JSON.parse(raw))

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
  })()`), 'typing a task did not make the document dirty')
  await click(app, point)
  await waitFor(
    () => app.evaluate(`!document.querySelector('.hm-save-fab')`),
    'saving the task document did not settle'
  )
}

async function activateTab(app, name) {
  await app.evaluate(`([...document.querySelectorAll('.tab')].find((tab) => tab.textContent.includes(${JSON.stringify(name)}))?.click(), true)`)
  await sleep(300)
}

async function withApp(name, port, run) {
  const file = join(root, `${name}.md`)
  await writeFile(file, '')
  const app = await launchBuiltElectron({
    profileDir: join(root, `profile-${name}`),
    port,
    appArgs: [file]
  })
  try {
    await sleep(1200)
    await activateTab(app, '欢迎')
    await activateTab(app, name)
    await waitFor(() => app.evaluate(`!!(${visiblePm})`), 'the task fixture editor never mounted')
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
    await run(app, file)
    assert.deepEqual(app.dialogs.map((dialog) => dialog.message), [],
      'an empty task must never require recovery')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

// Case 1 — the ruling's user-visible acceptance test.
async function checkboxSurvivesAThinkingPause() {
  await withApp('pause-survives', Number(process.env.CDP_PORT || 9530), async (app, file) => {
    await typeTextLikeUser(app.send, '- [ ] ')

    // Sample the whole pause: the pre-fix demotion landed ~450 ms after the
    // last keystroke, so a single check at the end would be a weaker lock.
    const samples = []
    for (let index = 0; index * 150 < THINKING_PAUSE_MS; index += 1) {
      samples.push(await taskState(app))
      await sleep(150)
    }
    for (const [index, state] of samples.entries()) {
      assert.equal(state?.checkboxes, 1,
        `the just-typed checkbox must survive an idle pause (sample ${index}: ${JSON.stringify(state)})`)
      assert.equal(state?.text, '',
        `the empty task must not revert to literal marker text while idle (sample ${index}: ${JSON.stringify(state)})`)
    }

    // …and typing the label afterwards behaves like an ordinary task item.
    await typeTextLikeUser(app.send, '牛逼')
    await sleep(600)
    const labelled = await taskState(app)
    assert.equal(labelled?.checkboxes, 1, `the label must be typed into the task, not into ordinary text: ${JSON.stringify(labelled)}`)
    assert.ok(labelled?.text.includes('牛逼'), `the task label was lost: ${JSON.stringify(labelled)}`)

    assert.equal(await toggleMode(app), true, 'could not open source mode after the pause')
    assert.equal(
      await waitFor(() => visibleSource(app), 'source mode did not settle after the pause'),
      '* [ ] 牛逼\n',
      'a labelled task must reach source mode as ordinary GFM task syntax'
    )
    assert.equal(await toggleMode(app), true, 'could not return to rich mode after the pause')
    await sleep(400)

    // Deleting the label back to empty keeps the documented demotion: this is
    // the boundary the contract does own, and the fix must not touch it.
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 120 })
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace', delayMs: 120 })
    const demoted = await waitFor(async () => {
      const state = await taskState(app)
      return state?.checkboxes === 0 && state?.text === '[ ]' ? state : null
    }, 'deleting the last label character must still demote the task to ordinary list text')
    assert.equal(demoted.text, '[ ]')

    await save(app)
    assert.equal(await readFile(file, 'utf8'), '* [ ]\n',
      'the demoted task must save as portable ordinary GFM list text')
  })
}

// Case 2 — the forced boundaries, pinned byte for byte. Both values are the
// bytes the pre-fix build produced for this exact sequence (verified against a
// pre-fix scratch build); the fix narrows WHEN the demotion runs, never what it
// produces. `- ` is typed and `* ` is written because a brand-new document is
// serialized through the generated-scratch path, which is unrelated to this fix.
async function forcedBoundariesStillDemote() {
  await withApp('pause-boundaries', Number(process.env.CDP_PORT_BOUNDARY || 9532), async (app, file) => {
    await typeTextLikeUser(app.send, '- [ ] ')
    await sleep(THINKING_PAUSE_MS)
    const idle = await taskState(app)
    assert.equal(idle?.checkboxes, 1, `the checkbox must still be live at the boundary: ${JSON.stringify(idle)}`)

    assert.equal(await toggleMode(app), true, 'could not open source mode on the empty task')
    assert.equal(
      await waitFor(() => visibleSource(app), 'source mode did not settle on the empty task'),
      '* [ ]\n',
      'the source boundary must still demote the empty task to ordinary list text'
    )
    assert.equal(await toggleMode(app), true, 'could not return to rich mode from the empty task')
    await sleep(400)

    await save(app)
    assert.equal(await readFile(file, 'utf8'), '* [ ]\n',
      'the save boundary must still write the empty task as ordinary list text')
  })
}

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  try {
    await checkboxSurvivesAThinkingPause()
    await forcedBoundariesStillDemote()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  console.log('PASS empty task typing pause: the checkbox survives an idle second and every forced boundary still demotes it.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
