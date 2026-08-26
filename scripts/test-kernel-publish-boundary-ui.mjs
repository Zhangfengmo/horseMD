// CORRECTION A — WHICH CALLERS ARE PUBLICATION BOUNDARIES.
//
// D5 made whitespace resolution happen at a PUBLICATION BOUNDARY: an
// outstanding U+00A0 placeholder (the kernel's spelling for whitespace
// CommonMark would strip) is resolved only when a flush is asked for with
// `{ force: true }`. Three callers that DO reach durable storage were left on
// the un-forced path, so the placeholder escaped as a real byte:
//
//   B1  useSourceModeSwitch.js `flushRichSource` — save, then toggle to source
//       mode. The un-forced flush writes the U+00A0 text back into `tab.content`,
//       the just-saved tab goes DIRTY again, and a save from source mode (which
//       short-circuits on the textarea before any flush) puts U+00A0 on disk.
//
//   B2  Editor.jsx `scheduleRichDirtyReconcile` — a legacy bridge for Milkdown's
//       200 ms serializer debounce. It fires ~260 ms after an input with an
//       UN-forced flush and pipes the result into `onChange`. Save inside that
//       window and the timer re-dirties the tab AFTER the save, with U+00A0
//       text, without the user touching anything. (Kernel mode has no
//       serializer debounce to bridge — it publishes synchronously on every
//       accepted commit — and never clears `richFlushPending`, so the timer
//       fires after every keystroke forever.)
//
//   B3  useAppLifecycle.js session persistence — an unsaved scratch tab's
//       `tab.content` is the LIVE document text (kernel `onChange`), placeholder
//       included. localStorage therefore stores a raw U+00A0, and the restore
//       rebuilds the document with an EMPTY provenance ledger: the placeholder
//       becomes an AUTHORED character forever and every later save writes it.
//
// The negative control travels with every assertion: an AUTHORED U+00A0 (one
// the kernel never wrote, so the ledger never vouched for it) must survive all
// three boundaries byte-for-byte. Only a ledgered placeholder may be resolved.
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { typeTextLikeUser } from './lib/human-input.mjs'

const NBSP = ' '
const root = `/tmp/horsemd-kernel-publish-boundary-${process.pid}`
const file = join(root, 'boundary.md')
const profileDir = join(root, 'profile')
const port = Number(process.env.CDP_PORT || 10921)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

const AUTHORED = `作者${NBSP}手写`
const FIXTURE = ['# 标题', '', '末段。', '', AUTHORED, ''].join('\n')

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`
const SESSION_KEY = 'minimd.session.v1'

async function waitFor(fn, message, tries = 80) {
  for (let index = 0; index < tries; index += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const blockTexts = (evaluate) => evaluate(`JSON.stringify(
  [...((${VISIBLE_EDITOR})?.children || [])].map((n) => n.tagName + ':' + n.textContent)
)`)

const diagnostics = (evaluate) => evaluate(
  `JSON.stringify((window.__hmKernelDiagnostics || []).map((entry) => entry && entry.type))`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)?.value ?? null
)`)

const isDirty = (evaluate) => evaluate(`!!document.querySelector('.hm-save-fab')`)

const readSessionUntitled = async (evaluate) => {
  const raw = await evaluate(`localStorage.getItem(${JSON.stringify(SESSION_KEY)})`)
  if (!raw) return null
  try {
    return JSON.parse(raw).untitled || []
  } catch {
    return null
  }
}

async function toggleSourceMode(evaluate) {
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => node.offsetParent && !node.classList.contains('block-switch-caret-btn') &&
        /源码|Source|富文本|Rich|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
    button?.click()
    return !!button
  })()`)
  assert.ok(clicked, 'no source-toggle trigger button')
}

async function charRect(evaluate, blockText, offset) {
  return evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p, h1, h2, h3, h4, h5, h6') || [])]
      .find((n) => n.textContent.includes(${JSON.stringify(blockText)}))
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
    range.setStart(target, targetOffset)
    range.setEnd(target, targetOffset)
    const rect = range.getBoundingClientRect()
    return rect ? { left: rect.left, top: rect.top, height: rect.height } : null
  })()`)
}

// A raw DOM selection does NOT sync ProseMirror state — every caret placement
// here is a real mouse click, per this repo's CDP convention.
async function clickAt(evaluate, send, blockText, offset) {
  const rect = await waitFor(() => charRect(evaluate, blockText, offset),
    `could not locate ${JSON.stringify(blockText)}@${offset} — blocks: ${await blockTexts(evaluate)}`)
  const point = { x: rect.left, y: rect.top + Math.min(12, rect.height / 2) }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await sleep(250)
}

// A real SPACE keystroke that actually inserts a character: `pressKey` sends
// `rawKeyDown` (keymap only, no text), so Space must go through keyDown+text.
async function pressSpace(send) {
  const common = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ' ', unmodifiedText: ' ', ...common })
  await sleep(12)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
}

async function pressPlainKey(send, key, code = key) {
  const codes = { Enter: 13, End: 35 }
  const common = { key, code, windowsVirtualKeyCode: codes[key] || 0, nativeVirtualKeyCode: codes[key] || 0 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await sleep(12)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(120)
}

async function saveAndSettle(evaluate, label) {
  await waitFor(() => isDirty(evaluate), `document never became dirty (${label})`)
  await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(async () => !(await isDirty(evaluate)), `save did not settle (${label})`)
  await sleep(300)
  return readFile(file, 'utf8')
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)
  let app
  try {
    app = await launchBuiltElectron({ profileDir, port, appArgs: [file], kernelDefault: true })
    const { evaluate, send } = app
    await waitFor(() => evaluate(`!!(${VISIBLE_EDITOR})`), 'editor did not mount')
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not attach')
    await sleep(500)
    assert.ok(!(await diagnostics(evaluate)).includes('attach-unmappable'),
      `the kernel must be attached before anything is measured: ${await diagnostics(evaluate)}`)
    await evaluate('window.__hmKernelDiagnostics = []')

    // =====================================================================
    // B1) SAVE, then enter SOURCE MODE. The tab was clean on disk; the mode
    //     toggle must not resurrect the placeholder into the durable mirror.
    // =====================================================================
    await clickAt(evaluate, send, '末段。', 3)
    await typeTextLikeUser(send, 'a', { delayMs: delay })
    await sleep(300)
    await pressSpace(send)
    await sleep(600)
    assert.ok(JSON.parse(await blockTexts(evaluate)).includes('P:末段。a' + NBSP),
      `the typed space must be visible in the editor — got ${await blockTexts(evaluate)}`)

    const savedB1 = await saveAndSettle(evaluate, 'B1 space typed last')
    assert.equal(savedB1, FIXTURE.replace('末段。', '末段。a'),
      'the save itself must already write clean bytes (D5)')
    assert.ok(savedB1.includes(AUTHORED), 'an AUTHORED U+00A0 must survive the save')
    assert.equal(await isDirty(evaluate), false, 'the tab must be clean right after the save')

    await toggleSourceMode(evaluate)
    const sourceText = await waitFor(() => visibleSource(evaluate), 'source view did not appear (B1)')
    await sleep(300)

    assert.equal(await isDirty(evaluate), false,
      'B1: entering SOURCE MODE after a save must not re-dirty the tab — an un-forced flush ' +
      'republished the U+00A0 placeholder into tab.content')
    assert.equal(sourceText, savedB1,
      'B1: the source buffer must be the bytes on disk — a save from source mode writes ' +
      'exactly these, so a U+00A0 here IS a corrupted file')

    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'rich view did not return (B1)')
    await sleep(300)

    // =====================================================================
    // B2) SAVE INSIDE THE 260 ms RECONCILE WINDOW. Nothing the user does
    //     afterwards may re-dirty the tab with placeholder-bearing text.
    // =====================================================================
    await clickAt(evaluate, send, '末段。a', 4)
    await pressPlainKey(send, 'End')
    await typeTextLikeUser(send, 'b', { delayMs: delay })
    await sleep(300)
    await waitFor(() => isDirty(evaluate), 'the tab must be dirty before the B2 save')
    await pressSpace(send)
    // NO settling sleep: this is the whole point — the save lands inside the
    // ~260 ms window `scheduleRichDirtyReconcile` is counting down.
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(1600)

    const savedB2 = await readFile(file, 'utf8')
    assert.ok(!savedB2.replace(AUTHORED, '').includes(NBSP),
      `B2: the save must not have written a placeholder: ${JSON.stringify(savedB2)}`)
    assert.equal(savedB2, FIXTURE.replace('末段。', '末段。a b'),
      'B2: a heal + a trailing space, saved inside the reconcile window, must publish `a b`')
    assert.equal(await isDirty(evaluate), false,
      'B2: the ~260 ms rich-dirty reconcile fired AFTER the save and re-dirtied a saved tab ' +
      'with un-published (U+00A0-bearing) text — no user action involved')

    // =====================================================================
    // B3) AN UNSAVED SCRATCH TAB ACROSS A RESTART. The session is durable
    //     storage; the restore rebuilds the document with an EMPTY ledger, so
    //     whatever U+00A0 is written here becomes AUTHORED forever.
    // =====================================================================
    await evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')]
        .find((b) => b.offsetParent && (b.title || '').match(/新建|New/i))
      btn?.click(); return !!btn
    })()`)
    await sleep(900)
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`),
      'the fresh untitled tab must be in kernel mode')
    await evaluate(`(() => { (${VISIBLE_EDITOR})?.focus(); return 1 })()`)
    await typeTextLikeUser(send, '草稿标题', { delayMs: delay })
    await sleep(300)
    await pressPlainKey(send, 'Enter')
    await sleep(300)
    // `甲<NBSP>乙` is typed as TEXT (Input.insertText), never as a Space key —
    // the ledger cannot vouch for it, so it is AUTHORED and must be immortal.
    await typeTextLikeUser(send, `甲${NBSP}乙`, { delayMs: delay })
    await sleep(300)
    await pressSpace(send)
    await sleep(1600) // session persistence debounce is 400 ms

    const untitled = await readSessionUntitled(evaluate)
    assert.ok(Array.isArray(untitled) && untitled.length === 1,
      `the scratch tab must be persisted: ${JSON.stringify(untitled)}`)
    const draft = untitled[0].content || ''
    assert.ok(draft.includes(`甲${NBSP}乙`),
      `B3: the AUTHORED U+00A0 must be stored byte-for-byte: ${JSON.stringify(draft)}`)
    assert.equal(draft.replace(`甲${NBSP}乙`, '').includes(NBSP), false,
      `B3: the session stored an outstanding placeholder as a raw U+00A0 — the restore ` +
      `rebuilds with an empty ledger, so this byte becomes authored forever: ${JSON.stringify(draft)}`)

    // B3.2) NO IDLE LOOP. The publisher hands text back through `onChange`, and
    //       `updateContent` maps the tab array unconditionally — so an
    //       unconditional re-publish would give React a new array on every
    //       session flush, re-run the persistence effect and schedule the next
    //       flush, forever, on an untouched document. The publisher compares
    //       against the last text it handed the host; this measures that.
    await evaluate(`(() => {
      window.__hmSessionWrites = 0
      const raw = localStorage.setItem.bind(localStorage)
      localStorage.setItem = (key, value) => {
        if (key === ${JSON.stringify(SESSION_KEY)}) window.__hmSessionWrites += 1
        return raw(key, value)
      }
      return 1
    })()`)
    await sleep(3000)
    const idleWrites = await evaluate(`window.__hmSessionWrites`)
    assert.ok(idleWrites <= 1,
      `B3: the scratch-draft publisher must be a no-op once nothing is outstanding — ` +
      `${idleWrites} session writes in 3 s of idleness is a self-sustaining 400 ms loop`)

    // Chromium commits localStorage to its LevelDB asynchronously, and a
    // SIGTERM drops whatever has not committed — measured: the scratch draft
    // never reached disk at all, so a killed app restores a stale snapshot that
    // predates the tab and proves nothing. Quit GRACEFULLY (CDP Browser.close,
    // with the app's dirty-tab guard answered) so the storage service flushes.
    await evaluate(`window.confirm = () => true`)
    await sleep(600)
    try { await send('Browser.close') } catch { /* falls back to SIGTERM below */ }
    await Promise.race([
      new Promise((resolve) => app.child.once('exit', resolve)),
      sleep(8000)
    ])
    await stopBuiltElectron(app, { removeProfile: false })
    app = null
    // The draft must be on DISK, not merely in the dead renderer's memory.
    // (localStorage values are UTF-16 in Chromium's LevelDB.)
    const leveldb = join(profileDir, 'Local Storage', 'leveldb')
    const files = await readdir(leveldb)
    const onDisk = await Promise.all(files.map((name) => readFile(join(leveldb, name))))
    assert.ok(onDisk.some((bytes) => bytes.includes(Buffer.from('草稿标题', 'utf16le'))),
      'the scratch draft never committed to disk — the restart below would restore a stale ' +
      'snapshot and prove nothing')

    // ---- Restart on the SAME profile, no argv: the session restores.
    app = await launchBuiltElectron({
      profileDir, port, appArgs: [], kernelDefault: true, cleanProfile: false
    })
    const restored = app.evaluate
    await waitFor(() => restored(`!!(${VISIBLE_EDITOR})`), 'editor did not mount after restart')
    await sleep(800)
    // Rich editors are lazily mounted (one per ACTIVATED tab), so the restored
    // scratch tab has no `.ProseMirror` until it is activated.
    const activated = await restored(`(() => {
      const tab = [...document.querySelectorAll('.tab')]
        .find((node) => !(node.querySelector('.tab-title')?.textContent || '').includes('boundary'))
      tab?.click()
      return tab?.querySelector('.tab-title')?.textContent || null
    })()`)
    assert.ok(activated, 'the restored scratch tab is missing from the tab strip: ' +
      await restored(`JSON.stringify([...document.querySelectorAll('.tab-title')].map((n) => n.textContent))`))
    const scratch = await waitFor(async () => {
      const text = await restored(`(${VISIBLE_EDITOR})?.textContent ?? null`)
      return text && text.includes('草稿标题') ? text : null
    }, `the scratch draft must be restored (activated tab ${JSON.stringify(activated)})`)
    assert.ok(scratch.includes(`甲${NBSP}乙`),
      `B3: the AUTHORED U+00A0 must survive the restart: ${JSON.stringify(scratch)}`)
    assert.equal(scratch.replace(`甲${NBSP}乙`, '').includes(NBSP), false,
      `B3: a placeholder survived the restart as an AUTHORED character: ${JSON.stringify(scratch)}`)

    console.log('PASS kernel publication boundary: source-mode entry, the rich-dirty reconcile and session persistence all publish; an authored U+00A0 is untouched')
  } finally {
    try { if (app) await app.evaluate(`window.confirm = () => true`) } catch {}
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
