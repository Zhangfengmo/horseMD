// Kernel-mode RESTART persistence — the 2026-08-22 corruption chain.
//
// Root cause it locks: the per-tab kernel flag was session-only, so an app
// restart silently dropped every kernel tab back to LEGACY mode — whose save
// boundary demotes a kernel-written seeded task item (`* [ ] ` + U+00A0) to
// the bare `* [ ]` spelling, which parses as a BULLET with literal "[ ]"
// text. Measured end-to-end in the built app before the fix (kernel save →
// restart → one legacy keystroke elsewhere → save → checkbox gone).
//
// The fix persists the flag in the session (keyed by path; untitled scratch
// tabs carry it on their session entries), and the restore re-attaches the
// kernel before the first edit can reach the legacy pipeline.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-restart-${process.pid}`
const file = join(root, 'restart.md')
const FIXTURE = '* [ ] 你好啊\n* [ ] 非常棒\n'
const port = Number(process.env.CDP_PORT || 10099)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`

async function waitFor(fn, message, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function toggleKernelMode(evaluate) {
  const opened = await evaluate(`(() => {
    const button = document.querySelector('.block-switch-caret-btn')
    button?.click()
    return !!button
  })()`)
  assert.ok(opened, 'no kernel-mode caret button')
  await sleep(150)
  const clicked = await evaluate(`(() => {
    const item = [...document.querySelectorAll('.block-switch-menu .block-menu-item')]
      .find((node) => node.offsetParent)
    item?.click()
    return !!item
  })()`)
  assert.ok(clicked, 'kernel-toggle menu item missing')
}

async function clickAt(evaluate, send, blockText, offset) {
  const rect = await waitFor(() => evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p, li p') || [])].find((n) => n.textContent.includes(${JSON.stringify(blockText)}))
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    let count = 0, target = null, targetOffset = 0, n
    while ((n = walker.nextNode())) {
      const len = n.textContent.length
      if (count + len >= ${offset}) { target = n; targetOffset = ${offset} - count; break }
      count += len
    }
    if (!target) return null
    const range = document.createRange()
    range.setStart(target, targetOffset); range.setEnd(target, targetOffset)
    const r = range.getBoundingClientRect()
    return { left: r.left, top: r.top, height: r.height }
  })()`), `locate ${blockText}@${offset}`)
  const point = { x: rect.left, y: rect.top + Math.min(12, rect.height / 2) }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await sleep(250)
}

async function saveNow(evaluate) {
  await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save fab missing')
  await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not settle')
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)
  const profileDir = join(root, 'profile')
  let app
  try {
    // ---- Session 1: enable the kernel, create the seeded continuation, save.
    app = await launchBuiltElectron({ profileDir, port, appArgs: [file] })
    {
      const { evaluate, send } = app
      await waitFor(() => evaluate(`(${VISIBLE_EDITOR})?.textContent?.includes('非常棒')`), 'mount')
      await toggleKernelMode(evaluate)
      await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode on')
      await sleep(400)

      await clickAt(evaluate, send, '非常棒', 3)
      await pressKey(send, { key: 'Enter', code: 'Enter' })
      await sleep(300)
      await pressKey(send, { key: 'Tab', code: 'Tab' })
      await sleep(300)
      await saveNow(evaluate)
      const saved = await readFile(file, 'utf8')
      assert.equal(saved, '* [ ] 你好啊\n* [ ] 非常棒\n  * [ ]  \n',
        'the kernel save must write the seeded nested task item')
      // The session write is debounced (400ms) and the harness stops the app
      // with SIGTERM — wait the debounce out so the snapshot lands.
      await sleep(1200)
    }
    await stopBuiltElectron(app, { removeProfile: false })
    app = null

    // ---- Session 2: SAME profile, no argv — the session restores the tab.
    // The kernel flag must restore WITH it, and the legacy demotion must
    // never see these bytes.
    app = await launchBuiltElectron({ profileDir, port, appArgs: [], cleanProfile: false })
    {
      const { evaluate, send } = app
      await waitFor(() => evaluate(`(${VISIBLE_EDITOR})?.textContent?.includes('非常棒')`), 'session tab did not restore')
      await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`),
        'the restored tab must come back IN KERNEL MODE (the flag survives the restart)')
      await sleep(400)

      // One ordinary keystroke elsewhere, then save — the exact chain that
      // used to demote the seeded item under legacy.
      await clickAt(evaluate, send, '你好啊', 3)
      await typeTextLikeUser(send, 'x', { delayMs: delay })
      await sleep(400)
      await saveNow(evaluate)
      const disk = await readFile(file, 'utf8')
      assert.equal(disk, '* [ ] 你好啊x\n* [ ] 非常棒\n  * [ ]  \n',
        `the seeded task item must survive the restart-edit-save chain byte for byte, got ${JSON.stringify(disk)}`)
      assert.equal(app.dialogs.length, 0,
        `no dialog may appear: ${JSON.stringify(app.dialogs.map((d) => d.message))}`)
    }

    console.log('PASS kernel-mode restart persistence: the per-tab kernel flag survives an app restart via the session, and the kernel-written seeded task item is never demoted by a post-restart edit+save')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
