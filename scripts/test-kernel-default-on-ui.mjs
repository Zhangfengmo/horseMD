// The source kernel is the PRODUCT DEFAULT (2026-08-22) — this script pins
// both polarities of the migration bridge:
//   (1) CONTROL: a harness launch (which passes --horsemd-legacy-default)
//       still mounts doc tabs in LEGACY mode — the legacy-pinned suites keep
//       their meaning.
//   (2) PRODUCT: `kernelDefault: true` (no bridge flag — exactly what a real
//       launch is) mounts the tab IN KERNEL MODE with no toggle, typing
//       commits through the kernel, and toggling OFF persists as an
//       EXCEPTION across a restart.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-kernel-default-${process.pid}`
const file = join(root, 'default.md')
const FIXTURE = '默认段落甲\n\n默认段落乙\n'
const port = Number(process.env.CDP_PORT || 10102)
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

async function clickAt(evaluate, send, blockText, offset) {
  const rect = await waitFor(() => evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p') || [])].find((n) => n.textContent.includes(${JSON.stringify(blockText)}))
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

async function toggleKernelMode(evaluate) {
  await evaluate(`(() => { const b = document.querySelector('.block-switch-caret-btn'); b?.click(); return 1 })()`)
  await sleep(150)
  const clicked = await evaluate(`(() => {
    const item = [...document.querySelectorAll('.block-switch-menu .block-menu-item')]
      .find((node) => node.offsetParent)
    item?.click()
    return !!item
  })()`)
  assert.ok(clicked, 'kernel-toggle menu item missing')
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

  // ---- (1) CONTROL: the harness bridge keeps legacy the default.
  let app = await launchBuiltElectron({ profileDir: join(root, 'profile-control'), port, appArgs: [file] })
  try {
    await waitFor(() => app.evaluate(`(${VISIBLE_EDITOR})?.textContent?.includes('默认段落甲')`), 'control mount')
    await sleep(600)
    assert.equal(await app.evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), false,
      'under the --horsemd-legacy-default bridge a doc tab must still mount in LEGACY mode')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    app = null
  }

  // ---- (2) PRODUCT: no bridge flag — the kernel is the default.
  const profileDir = join(root, 'profile-product')
  app = await launchBuiltElectron({ profileDir, port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${VISIBLE_EDITOR})?.textContent?.includes('默认段落甲')`), 'product mount')
    // The quit path runs the close guard; with a dirty scratch tab open its
    // window.confirm would BLOCK the graceful quit, the harness would SIGKILL,
    // and Chromium's un-flushed localStorage writes (the session!) would be
    // lost wholesale. Auto-confirm — a clean quit is what flushes leveldb.
    await evaluate(`(window.confirm = () => true, 1)`)
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`),
      'a real (flagless) launch must mount the doc tab IN KERNEL MODE with no toggle')
    await sleep(400)
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!attachDiagnostics.includes('attach-unmappable'),
      `the default-on attach must not degrade: ${attachDiagnostics}`)

    // Typing commits through the kernel.
    await clickAt(evaluate, send, '默认段落甲', 5)
    await typeTextLikeUser(send, 'x', { delayMs: delay })
    await sleep(400)
    await saveNow(evaluate)
    assert.equal(await readFile(file, 'utf8'), '默认段落甲x\n\n默认段落乙\n',
      'a keystroke under the default-on kernel must commit bytes')

    // ---- (2b) A brand-NEW untitled tab (the + button): the Typora-style
    // synthetic-title init (empty H1 + empty paragraph) must NOT break the
    // kernel attach — the kernel doc is seeded with the matching '# ' bytes.
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.offsetParent && (b.title || '').match(/新建|New/i))
      btn?.click(); return !!btn
    })()`)
    await sleep(900)
    const freshDiag = await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).map((d) => d.type))`)
    assert.ok(!freshDiag.includes('attach-unmappable'),
      `a fresh untitled tab must attach the kernel (the synthetic-title init must be byte-backed): ${freshDiag}`)
    assert.ok(await evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`),
      'the fresh untitled tab must be in kernel mode')
    // Title line is the caret home; type a title, then ENTER opens the body
    // line (the kernel's universal next-line gesture — heading-final docs have
    // no hand-faked body paragraph in kernel mode; legacy keeps its two-block
    // init).
    await evaluate(`(() => { (${VISIBLE_EDITOR})?.focus(); return 1 })()`)
    await typeTextLikeUser(send, '新文档标题', { delayMs: delay })
    await sleep(300)
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(300)
    await typeTextLikeUser(send, '正文乙', { delayMs: delay })
    await sleep(500)
    const freshBlocks = await evaluate(`JSON.stringify([...((${VISIBLE_EDITOR})?.children || [])].map((n) => n.tagName.toLowerCase() + ':' + n.textContent))`)
    assert.ok(freshBlocks.includes('h1:新文档标题') && freshBlocks.includes('p:正文乙'),
      `typing title, Enter, body must commit through the kernel, got ${freshBlocks}`)
    const freshDiag2 = await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).map((d) => d.type))`)
    assert.ok(!freshDiag2.includes('attach-unmappable'),
      `still no degradation after typing: ${freshDiag2}`)
    // Back to the file tab for the toggle-off leg below.
    await evaluate(`(() => {
      const tab = [...document.querySelectorAll('.tab')].find((t) => (t.textContent || '').includes('default'))
      tab?.click(); return !!tab
    })()`)
    await sleep(600)
    await waitFor(() => evaluate(`(${VISIBLE_EDITOR})?.textContent?.includes('默认段落甲')`), 'file tab did not reactivate')

    // Toggling OFF is the exception — it must survive a restart.
    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`![...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'toggle OFF did not leave kernel mode')
    await sleep(1200)
  } finally {
    await stopBuiltElectron(app, { removeProfile: false })
    app = null
  }

  app = await launchBuiltElectron({ profileDir, port, appArgs: [], cleanProfile: false, kernelDefault: true })
  try {
    await waitFor(() => app.evaluate(`(${VISIBLE_EDITOR})?.textContent?.includes('默认段落甲')`), 'session tab did not restore')
    await sleep(600)
    assert.equal(await app.evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), false,
      'the toggled-OFF exception must survive the restart (the tab restores in legacy)')
    assert.equal(app.dialogs.length, 0,
      `no dialog may appear: ${JSON.stringify(app.dialogs.map((d) => d.message))}`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }

  console.log('PASS kernel default-on: a flagless launch mounts doc tabs in kernel mode (typing commits, no degradation), the harness bridge still mounts legacy for the migrating suites, and a toggled-off exception survives a restart')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
