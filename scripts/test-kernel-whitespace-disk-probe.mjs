// EXPERIMENT C — does typing Tab or Space in kernel mode leave U+00A0 in the
// SAVED FILE?
//
// Hypothesis under test (from code reading of
// src/renderer/src/lib/source-kernel/commands/trailing-whitespace.js):
// whitespace CommonMark would strip is written as literal U+00A0 (Space -> 1,
// Tab -> 2), recorded in a SESSION-ONLY ledger, and healed back to ASCII only
// when a LATER keystroke resolves the run. If nothing heals at save time, a
// trailing Space/Tab typed as the LAST action reaches disk as U+00A0.
//
// This is a PROBE, not a regression suite: it reports, it does not assert a
// desired outcome. Every case runs in its OWN app + OWN file.
//
// Case 4 is the CONTROL (Space then 'x' -> the healed path). If case 4 also
// shows U+00A0 on disk, the probe measures something other than intended.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-ws-disk-probe-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 10731)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`

async function waitFor(fn, message, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

async function charRect(evaluate, blockText, from, to) {
  return evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p, h1, h2, h3, h4, h5, h6') || [])]
      .find((n) => n.textContent === ${JSON.stringify(blockText)})
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    let count = 0
    let startNode = null, startOffset = 0, endNode = null, endOffset = 0
    let n
    while ((n = walker.nextNode())) {
      const len = n.textContent.length
      if (startNode === null && count + len >= ${from}) { startNode = n; startOffset = ${from} - count }
      if (endNode === null && count + len >= ${to}) { endNode = n; endOffset = ${to} - count }
      count += len
      if (startNode && endNode) break
    }
    if (!startNode || !endNode) return null
    const range = document.createRange()
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset)
    const rect = range.getBoundingClientRect()
    return rect ? { left: rect.left, right: rect.right, top: rect.top, height: rect.height } : null
  })()`)
}

// A raw DOM selection does NOT sync ProseMirror state — every caret placement
// here is a real mouse click, per this repo's CDP convention.
async function clickAt(evaluate, send, blockText, offset) {
  const rect = await waitFor(() => charRect(evaluate, blockText, offset, offset),
    `could not locate caret offset ${offset} in ${JSON.stringify(blockText)}`)
  await click(send, { x: rect.left, y: rect.top + Math.min(12, rect.height / 2) })
  await sleep(250)
}

// A real SPACE keystroke that actually inserts a character: `pressKey` sends
// `rawKeyDown` (keymap only, no text), so Space must go through keyDown+text.
async function pressSpace(send) {
  const common = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ' ', unmodifiedText: ' ', ...common })
  await sleep(12)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(12)
}

const caretInfo = (evaluate) => evaluate(`(() => {
  const sel = window.getSelection()
  const node = sel?.anchorNode
  if (!node) return null
  const el = node.nodeType === 1 ? node : node.parentElement
  const block = el?.closest('p, h1, h2, h3, h4, h5, h6, li, th, td, pre')
  if (!block) return null
  const range = document.createRange()
  range.selectNodeContents(block)
  range.setEnd(sel.anchorNode, sel.anchorOffset)
  return JSON.stringify({
    tag: block.tagName.toLowerCase(),
    text: block.textContent,
    caretOffset: range.toString().length
  })
})()`)

const blockTexts = (evaluate) => evaluate(`JSON.stringify(
  [...((${VISIBLE_EDITOR})?.children || [])].map((n) => n.tagName + ':' + n.textContent)
)`)

const diagnostics = (evaluate) => evaluate(
  `JSON.stringify((window.__hmKernelDiagnostics || []).slice(-12))`)

const toasts = (evaluate) => evaluate(`JSON.stringify(window.__wsToasts || [])`)

async function installToastSpy(evaluate) {
  await evaluate(`(() => {
    window.__wsToasts = []
    window.addEventListener('hm:toast', (e) => window.__wsToasts.push(e.detail?.msg ?? String(e.detail)))
    return 1
  })()`)
}

async function saveAndSettle(evaluate) {
  const dirty = await evaluate(`!!document.querySelector('.hm-save-fab')`)
  if (!dirty) return { dirty: false, settled: true }
  await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  for (let i = 0; i < 40; i += 1) {
    await sleep(150)
    if (!await evaluate(`!!document.querySelector('.hm-save-fab')`)) return { dirty: true, settled: true }
  }
  return { dirty: true, settled: false }
}

const NBSP_RE = / /

async function runCase({ id, title, fixture, port, act }) {
  const dir = join(root, `case-${id}`)
  const file = join(dir, `case${id}.md`)
  await mkdir(dir, { recursive: true })
  await writeFile(file, fixture)
  const record = { id, title, fixture: JSON.stringify(fixture) }
  let app
  try {
    app = await launchBuiltElectron({
      profileDir: join(dir, 'profile'),
      port,
      appArgs: [file],
      kernelDefault: true
    })
    const { evaluate, send } = app
    await waitFor(() => evaluate(`!!(${VISIBLE_EDITOR})`), 'editor did not mount')
    await sleep(600)

    // MANDATORY: prove the KERNEL attached; otherwise the measurement is about
    // legacy and says nothing about the hypothesis.
    const kernelAttached = await evaluate(`!!document.querySelector('.hm-kernel-mode')`)
    record.kernelAttached = kernelAttached
    record.attachDiagnostics = await diagnostics(evaluate)
    if (!kernelAttached) {
      record.note = 'KERNEL DID NOT ATTACH — this case measured LEGACY'
      return record
    }
    await installToastSpy(evaluate)
    await evaluate('window.__hmKernelDiagnostics = []')

    await act({ evaluate, send })

    record.caretAfter = await caretInfo(evaluate)
    record.blocksAfter = await blockTexts(evaluate)
    record.diagnostics = await diagnostics(evaluate)
    record.toastsBeforeSave = await toasts(evaluate)

    const save = await saveAndSettle(evaluate)
    record.save = save
    await sleep(400)
    const disk = await readFile(file, 'utf8')
    record.disk = JSON.stringify(disk)
    record.diskHasNbsp = NBSP_RE.test(disk)
    record.diskNbspCount = (disk.match(/ /g) || []).length
    record.diskHasTab = /\t/.test(disk)
    record.toasts = await toasts(evaluate)
    record.dialogs = app.dialogs.map((d) => d.message)
    record.diagnosticsAfterSave = await diagnostics(evaluate)
  } catch (error) {
    record.error = String(error && error.stack || error)
    try {
      if (app) {
        await app.evaluate(`window.confirm = () => true`)
      }
    } catch {}
  } finally {
    try { if (app) await app.evaluate(`window.confirm = () => true`) } catch {}
    await stopBuiltElectron(app, { removeProfile: true })
  }
  return record
}

// Cold reopen of an already-saved file: what does the kernel show, and does the
// document still round-trip (source view == disk bytes)?
async function coldReopen({ file, port, label }) {
  const dir = join(root, `reopen-${label}`)
  await mkdir(dir, { recursive: true })
  const out = { label, file }
  let app
  try {
    app = await launchBuiltElectron({
      profileDir: join(dir, 'profile'),
      port,
      appArgs: [file],
      kernelDefault: true
    })
    const { evaluate } = app
    await waitFor(() => evaluate(`!!(${VISIBLE_EDITOR})`), 'editor did not mount on reopen')
    await sleep(700)
    out.kernelAttached = await evaluate(`!!document.querySelector('.hm-kernel-mode')`)
    out.blocks = await blockTexts(evaluate)
    out.viewHasNbsp = NBSP_RE.test(JSON.parse(out.blocks).join(''))
    out.diagnostics = await diagnostics(evaluate)
    // Source view: the exact bytes the kernel holds.
    const clicked = await evaluate(`(() => {
      const button = [...document.querySelectorAll('.status-btn')]
        .find((node) => node.offsetParent && !node.classList.contains('block-switch-caret-btn') &&
          /源码|Source|富文本|Rich|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
      button?.click()
      return !!button
    })()`)
    out.sourceToggleFound = clicked
    if (clicked) {
      const shown = await waitFor(() => evaluate(`(
        [...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)?.value ?? null
      )`), 'source view did not appear on reopen')
      out.source = JSON.stringify(shown)
      out.sourceHasNbsp = NBSP_RE.test(shown)
      const onDisk = await readFile(file, 'utf8')
      out.roundTrips = shown === onDisk
      out.diskAtReopen = JSON.stringify(onDisk)
    }
    out.dirtyOnOpen = await evaluate(`!!document.querySelector('.hm-save-fab')`)
    out.dialogs = app.dialogs.map((d) => d.message)
  } catch (error) {
    out.error = String(error && error.stack || error)
  } finally {
    try { if (app) await app.evaluate(`window.confirm = () => true`) } catch {}
    await stopBuiltElectron(app, { removeProfile: true })
  }
  return out
}

const PARA_FIXTURE = ['# 标题甲', '', '末段。', ''].join('\n')

async function main() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const results = []

  // 1) paragraph end + Space -> save immediately.
  results.push(await runCase({
    id: 1, title: 'paragraph end + Space -> save immediately',
    fixture: PARA_FIXTURE, port: basePort,
    act: async ({ evaluate, send }) => {
      await clickAt(evaluate, send, '末段。', 3)
      await pressSpace(send)
      await sleep(600)
    }
  }))

  // 2) paragraph end + Tab -> save immediately.
  results.push(await runCase({
    id: 2, title: 'paragraph end + Tab -> save immediately',
    fixture: PARA_FIXTURE, port: basePort,
    act: async ({ evaluate, send }) => {
      await clickAt(evaluate, send, '末段。', 3)
      await pressKey(send, { key: 'Tab', code: 'Tab' })
      await sleep(600)
    }
  }))

  // 3) paragraph end + Space -> Enter -> save.
  results.push(await runCase({
    id: 3, title: 'paragraph end + Space -> Enter -> save',
    fixture: PARA_FIXTURE, port: basePort,
    act: async ({ evaluate, send }) => {
      await clickAt(evaluate, send, '末段。', 3)
      await pressSpace(send)
      await sleep(500)
      await pressKey(send, { key: 'Enter', code: 'Enter' })
      await sleep(700)
    }
  }))

  // 4) CONTROL: paragraph end + Space -> 'x' -> save (the HEALED path).
  results.push(await runCase({
    id: 4, title: 'CONTROL paragraph end + Space -> x -> save',
    fixture: PARA_FIXTURE, port: basePort,
    act: async ({ evaluate, send }) => {
      await clickAt(evaluate, send, '末段。', 3)
      await pressSpace(send)
      await sleep(500)
      await typeTextLikeUser(send, 'x', { delayMs: delay })
      await sleep(700)
    }
  }))

  // 5) paragraph line START + Tab (caret at parentOffset 0).
  results.push(await runCase({
    id: 5, title: 'paragraph content start + Tab -> save',
    fixture: PARA_FIXTURE, port: basePort,
    act: async ({ evaluate, send }) => {
      await clickAt(evaluate, send, '末段。', 0)
      await sleep(200)
      // Belt and braces: Home puts the caret at the block's content start.
      await pressKey(send, { key: 'Home', code: 'Home' })
      await sleep(200)
      await pressKey(send, { key: 'Tab', code: 'Tab' })
      await sleep(700)
    }
  }))

  // 6) heading content start + Space.
  results.push(await runCase({
    id: 6, title: 'heading content start + Space -> save',
    fixture: PARA_FIXTURE, port: basePort,
    act: async ({ evaluate, send }) => {
      await clickAt(evaluate, send, '标题甲', 0)
      await sleep(200)
      await pressKey(send, { key: 'Home', code: 'Home' })
      await sleep(200)
      await pressSpace(send)
      await sleep(700)
    }
  }))

  // 7) Tab + Tab + Tab at a paragraph end (the unbounded-accumulation claim).
  results.push(await runCase({
    id: 7, title: 'paragraph end + Tab x3 -> save',
    fixture: PARA_FIXTURE, port: basePort,
    act: async ({ evaluate, send }) => {
      await clickAt(evaluate, send, '末段。', 3)
      await pressKey(send, { key: 'Tab', code: 'Tab' })
      await sleep(500)
      await pressKey(send, { key: 'Tab', code: 'Tab' })
      await sleep(500)
      await pressKey(send, { key: 'Tab', code: 'Tab' })
      await sleep(700)
    }
  }))

  // Cold reopen of case 1's and case 2's saved files (fresh app, fresh profile).
  const reopens = []
  for (const id of [1, 2, 7]) {
    const saved = results.find((r) => r.id === id)
    if (!saved || saved.error) continue
    reopens.push(await coldReopen({
      file: join(root, `case-${id}`, `case${id}.md`),
      port: basePort,
      label: String(id)
    }))
  }

  console.log('=====RESULTS-JSON=====')
  console.log(JSON.stringify({ results, reopens }, null, 2))
  console.log('=====END=====')
}

main().then(async () => {
  await rm(root, { recursive: true, force: true })
}).catch(async (error) => {
  console.error(error)
  await rm(root, { recursive: true, force: true })
  process.exit(1)
})
