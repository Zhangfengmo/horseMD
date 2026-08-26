// The FIRST suite on the Chrome/web channel (scripts/lib/chrome-test-app.mjs):
// real Google Chrome, driving the MINIFIED web bundle (`npm run build:mobile`),
// over a local HTTP server. No Electron, no main process.
//
// WHY THIS SUITE EXISTS — defect D4, fixed in 2ca8ee3.
// -----------------------------------------------------------------------
// The kernel used to identify every ProseMirror step by
// `step.constructor.name === 'ReplaceStep'`. `vite.mobile.config.mjs` uses
// Vite's default `build.minify: 'esbuild'`, which emits `class ki extends xt`,
// so in that build every check failed, `classifyTransactions` answered
// `blocked`/INPUT_TYPE, and the dispatch veto refused EVERY keystroke: a
// silently READ-ONLY editor whose own diagnostic read
//   {"code":"unsupported-input-type","shape":"ki[1,1]@heading:d1:off0 open0/0 <text>"}
// Every Electron suite stayed green throughout, because electron-vite happens
// to emit an UNMINIFIED renderer. The kernel's correctness rested on a build
// flag nobody guarded.
//
// `scripts/test-kernel-step-identity.mjs` locks the fix headlessly (including
// against a real esbuild-minified bundle). THIS suite is the end-to-end half:
// the shipped minified bundle, in a real browser, typed into by a human-rate
// keystroke stream, asserted on the resulting SOURCE BYTES. Case E is the
// runtime regression lock — it reads the step ids out of the kernel's own live
// diagnostics and fails if any of them is a minifier-owned identifier.
//
// ASCII IS THE POINT. Defect D1 (mark input rules swallowing bytes) hid behind
// CJK-only fixtures. The typed line here is deliberately ASCII and
// marker-rich: `*em*`, `` `code` ``, `**bold**`, each completed one character
// at a time through real keydowns.
//
// CHANNEL LIMITS (docs/development.md has the full list): no native menus, so
// Save goes through `.hm-save-fab`; no process-lifecycle cold reopen, only a
// page reload; no file watchers and no PDF/HTML/Pandoc export. This channel is
// a SECOND opinion, never a replacement for the Electron matrix.
//
// Run: npm run test:kernel-web-chrome-ui
import assert from 'node:assert/strict'
import { launchChromeWeb } from './lib/chrome-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const port = Number(process.env.CDP_PORT || 9401)
const delay = Number(process.env.KERNEL_KEY_DELAY || 130)

// The document lives in the Capacitor Filesystem's WEB backend (IndexedDB),
// which is what `src/renderer/src/platform/capacitor-api.js` installs when
// there is no Electron preload. It is a real, reload-surviving store.
const DOC_PATH = 'HorseMD/kernel-web-chrome.md'
const FIXTURE = '# Kernel Web Channel\n\nseed line\n'
const TYPED = ' plus *em* mid `code` end **bold**'
const EXPECTED = '# Kernel Web Channel\n\nseed line plus *em* mid `code` end **bold**\n'

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`

// The app's own app.css `@import`s Google Fonts, which its own CSP meta
// (`style-src 'self' 'unsafe-inline'`) blocks — in Electron too. Benign and
// pre-existing: the font stack falls back. Everything else must be silent.
const BENIGN_CONSOLE = [
  /fonts\.googleapis\.com/,
  /Failed to load resource: the server responded with a status of 404/
]

// prosemirror-transform's registered `Step.jsonID`s (index.js:366-372, v1.12.0)
// plus the classifier's own "nothing registered" spelling. A shape starting
// with anything else means a step was named by a MINIFIER-OWNED identifier —
// D4, back.
const REGISTERED_STEP_IDS = [
  'replace', 'replaceAround', 'attr', 'docAttr',
  'addMark', 'removeMark', 'addNodeMark', 'removeNodeMark',
  'unknown'
]

async function waitFor(fn, message, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

// ---------------------------------------------------------------------------
// Typing. `Input.insertText` is NOT usable here: it bypasses the keymap layer
// entirely, so nothing that hangs off a key handler ever runs (the same driver
// artifact that once masqueraded as a kernel corruption — see ai-handoff
// §5.2d). `Input.dispatchKeyEvent` with `type: 'keyDown'` AND `text` is the one
// form Chromium expands into rawKeyDown + char, i.e. a real keystroke that both
// the keymap and the input rules see. (`lib/human-input.mjs`'s `pressKey` uses
// `rawKeyDown`, which is right for Enter/Backspace but produces no character;
// test-kernel-default-on-ui.mjs sets the precedent of a local `keyType` helper
// for exactly this reason.)
// ---------------------------------------------------------------------------
const PUNCT_KEYS = {
  ' ': ['Space', 32],
  '*': ['Digit8', 56],
  '`': ['Backquote', 192],
  '_': ['Minus', 189],
  '-': ['Minus', 189],
  '.': ['Period', 190],
  '~': ['Backquote', 192],
  '#': ['Digit3', 51]
}

function keyDescriptor(character) {
  if (PUNCT_KEYS[character]) {
    return { code: PUNCT_KEYS[character][0], vk: PUNCT_KEYS[character][1] }
  }
  if (/[a-zA-Z]/.test(character)) {
    return { code: `Key${character.toUpperCase()}`, vk: character.toUpperCase().charCodeAt(0) }
  }
  if (/[0-9]/.test(character)) return { code: `Digit${character}`, vk: character.charCodeAt(0) }
  return { code: '', vk: 0 }
}

async function typeAsciiLikeUser(send, text, { delayMs = delay } = {}) {
  for (const character of String(text)) {
    const { code, vk } = keyDescriptor(character)
    const common = {
      key: character,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk
    }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, text: character })
    await sleep(20)
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    await sleep(delayMs)
  }
}

// A real mouse click is the only thing that puts BOTH the DOM selection and the
// ProseMirror state on the same caret (a raw DOM selection does not sync PM).
async function clickAtEndOf(evaluate, send, blockPrefix) {
  const point = await waitFor(() => evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p') || [])]
      .find((n) => (n.textContent || '').startsWith(${JSON.stringify(blockPrefix)}))
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const rect = node.getBoundingClientRect()
    return { x: rect.right - 3, y: rect.top + rect.height / 2 }
  })()`), `could not locate the paragraph starting with ${blockPrefix}`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await sleep(350)
}

// The source view is the app's own read of the kernel's authored bytes.
const SOURCE_TOGGLE = `(() => {
  const button = [...document.querySelectorAll('.status-btn')].find((node) =>
    node.offsetParent && !node.classList.contains('block-switch-caret-btn') &&
    /source mode|源码/i.test(node.title || ''))
  button?.click()
  return !!button
})()`

async function readSourceBytes(evaluate, message) {
  assert.ok(await evaluate(SOURCE_TOGGLE), `no source-mode toggle (${message})`)
  const bytes = await waitFor(() => evaluate(
    `[...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)?.value ?? null`
  ), `source view did not appear (${message})`)
  assert.ok(await evaluate(SOURCE_TOGGLE), `no source-mode toggle back (${message})`)
  await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), `rich view did not return (${message})`)
  await sleep(200)
  return bytes
}

const kernelDiagnostics = (evaluate) => evaluate(`JSON.stringify(globalThis.__hmKernelDiagnostics || [])`)
  .then((raw) => JSON.parse(raw || '[]'))

async function run() {
  const app = await launchChromeWeb({ port, build: 'auto' })
  const { evaluate, send } = app
  const results = []
  const record = (name, detail) => { results.push(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`) }

  try {
    console.log(`chrome  : ${app.chromePath}`)
    console.log(`bundle  : ${app.outDir}${app.built ? ' (rebuilt)' : ' (reused)'}`)
    console.log(`serving : ${app.origin}`)

    // ---- Seed the document, then boot the app onto it.
    await waitFor(() => evaluate(`typeof window.api?.writeFile === 'function'`), 'platform shim never installed')
    // `makeCapacitorApi()` kicks off `ensureLib()` (mkdir of the library folder)
    // without awaiting it. Writing into that folder while the mkdir is still in
    // flight makes the web Filesystem backend throw "Current directory does
    // already exist" from its own recursive mkdir. Wait for the folder to be
    // readable — that is the shim's own signal that the library is ready.
    await waitFor(() => evaluate(
      `(async () => { try { await window.api.readDir('HorseMD'); return true } catch { return false } })()`
    ), 'the Capacitor web library folder never became readable')
    await evaluate(`(async () => {
      await window.api.writeFile(${JSON.stringify(DOC_PATH)}, ${JSON.stringify(FIXTURE)})
      return true
    })()`)

    // The session MUST be seeded at document-start. Writing it from an
    // already-booted page loses a race: the app's own persistence effect
    // re-serializes its live (empty) tab list over the value before the reload
    // lands, and the restore then finds nothing. The same init script installs
    // the writeFile interceptor before the platform shim exists.
    //
    // WHY THE INTERCEPTED ARGUMENT IS THE DISK BYTES. On desktop,
    // `window.api.writeFile(path, content)` is `ipcRenderer.invoke('fs:writeFile', …)`
    // and main's handler (src/main/filesystem.js:111) is a pure passthrough:
    //   await fs.writeFile(path, content, 'utf8')
    // Nothing between the renderer and the disk transforms the string. So the
    // `content` argument captured here IS, byte for byte, what the real app
    // writes to disk — the same fact the Electron suites prove by reading the
    // file back.
    await app.addInitScript(`
      localStorage.setItem('horsemd.onboarded.v1', '1')
      localStorage.setItem('minimd.session.v1', ${JSON.stringify(JSON.stringify({
        openPaths: [DOC_PATH],
        activePath: DOC_PATH,
        lang: 'en',
        theme: 'light'
      }))})
      globalThis.__hmWrites = []
      let installed
      Object.defineProperty(window, 'api', {
        configurable: true,
        get() { return installed },
        set(value) {
          installed = value
          const original = value.writeFile
          value.writeFile = async (path, content) => {
            globalThis.__hmWrites.push({ path, content })
            return original(path, content)
          }
        }
      })
    `)
    await app.reload()

    // ---- Case A: the kernel attaches to the MINIFIED bundle.
    await waitFor(() => evaluate(`(${VISIBLE_EDITOR})?.textContent?.includes('seed line')`),
      'the seeded document never mounted in the web build')
    assert.equal(await evaluate(`String(window.api.platform)`), 'web',
      'this suite must run against the web platform shim, not a preload')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`),
      'the web build must mount the doc tab IN KERNEL MODE (no legacyDefault bridge exists here)')
    const attachDiagnostics = await kernelDiagnostics(evaluate)
    assert.ok(!attachDiagnostics.some((d) => d.type === 'attach-unmappable'),
      `the kernel attach must not degrade: ${JSON.stringify(attachDiagnostics)}`)
    record('A attach', `.hm-kernel-mode present, ${attachDiagnostics.length} diagnostics`)

    // ---- Case B (THE D4 ACCEPTANCE TEST): typing works under minification.
    // Before 2ca8ee3 every one of these keystrokes was vetoed and the source
    // bytes never moved.
    await clickAtEndOf(evaluate, send, 'seed line')
    await typeAsciiLikeUser(send, TYPED)
    await sleep(900)

    const renderedHtml = await evaluate(`(${VISIBLE_EDITOR})?.innerHTML`)
    assert.ok(renderedHtml.includes('<strong>bold</strong>'),
      `ASCII **bold** must become a real strong mark, got: ${renderedHtml}`)
    assert.ok(renderedHtml.includes('<em>em</em>') && renderedHtml.includes('<code>code</code>'),
      `the marker-rich line must render all three marks, got: ${renderedHtml}`)

    const typedSource = await readSourceBytes(evaluate, 'after typing')
    assert.equal(typedSource, EXPECTED,
      'the minified web build must commit the typed line to the SOURCE BYTES verbatim')
    record('B typed bytes', JSON.stringify(typedSource))

    const typingDiagnostics = await kernelDiagnostics(evaluate)
    const refusals = typingDiagnostics.filter((d) => (
      d.type === 'unclassified-transaction' ||
      d.type === 'structural-refusal' ||
      d.type === 'attach-unmappable' ||
      d.type === 'projection-unmappable-refused' ||
      /-(failed|failure|refused)$/.test(d.type || '')
    ))
    assert.deepEqual(refusals, [],
      `no keystroke in the typed line may be refused: ${JSON.stringify(refusals)}`)
    record('B no refusals', `${typingDiagnostics.length} diagnostics, 0 refusals`)

    // ---- Case C: the published bytes.
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`),
      'the document must be dirty after typing (no save FAB appeared)')
    await evaluate(`document.querySelector('.hm-save-fab').click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'the save never settled')
    const writes = JSON.parse(await evaluate(`JSON.stringify(globalThis.__hmWrites || [])`))
    const docWrites = writes.filter((w) => w.path === DOC_PATH)
    assert.equal(docWrites.length, 1, `exactly one write of the document was expected: ${JSON.stringify(writes)}`)
    assert.equal(docWrites[0].content, EXPECTED,
      'the string handed to window.api.writeFile IS the disk byte string (fs:writeFile is a passthrough)')
    record('C published bytes', `writeFile(${DOC_PATH}, <${EXPECTED.length} chars>) byte-exact`)

    // ---- Case D: reload round-trip. The nearest this channel gets to the
    // Electron matrix's cold reopen — a full document teardown, a fresh parse,
    // and a fresh kernel attach onto the persisted bytes. (It is NOT a process
    // restart: see the channel limits above.)
    await app.reload()
    await waitFor(() => evaluate(`(${VISIBLE_EDITOR})?.textContent?.includes('seed line')`),
      'the document did not come back after a reload')
    const persisted = await evaluate(
      `(async () => (await window.api.readFile(${JSON.stringify(DOC_PATH)})).content)()`
    )
    assert.equal(persisted, EXPECTED, 'the persisted bytes must survive the reload unchanged')
    const reloadedSource = await readSourceBytes(evaluate, 'after reload')
    assert.equal(reloadedSource, EXPECTED, 'the reloaded document must round-trip byte-identically')
    assert.equal(await evaluate(`!!document.querySelector('.hm-save-fab')`), false,
      'a reloaded, untouched document must not be dirty')
    record('D reload round-trip', 'bytes identical, tab clean')

    // ---- Case E (THE RUNTIME D4 LOCK): every step the kernel names in its own
    // diagnostics must be named by a REGISTERED prosemirror `jsonID`, never by
    // a class name. This runs against the minified bundle, so a regression to
    // `constructor.name` shows up here as a shape like `ki[...]` — literally
    // the observed D4 signature. Case F below deliberately provokes a refusal
    // so this check has live shapes to inspect.
    //
    // A paragraph ending in an emphasis-family mark refuses an appended
    // character (see Case F) — that gives us a real, minified-bundle refusal.
    await clickAtEndOf(evaluate, send, 'seed line')
    const beforeProbe = (await kernelDiagnostics(evaluate)).length
    await typeAsciiLikeUser(send, 'Z')
    await sleep(700)
    const probeDiagnostics = (await kernelDiagnostics(evaluate)).slice(beforeProbe)
    const shapes = probeDiagnostics.map((d) => d.shape).filter(Boolean)
    for (const shape of shapes) {
      const id = String(shape).split('[')[0]
      assert.ok(REGISTERED_STEP_IDS.includes(id),
        `a kernel diagnostic named a step "${id}" (shape ${shape
        }) that is not a registered prosemirror jsonID — the minifier is naming steps again (defect D4)`)
    }
    record('E step identity', shapes.length
      ? `${shapes.length} live refusal shape(s), all registered ids: ${[...new Set(shapes.map((s) => String(s).split('[')[0]))].join(', ')}`
      : 'no refusal shapes produced (nothing to disprove)')

    // ---- Case F: whatever that probe keystroke did, it must be FAIL-CLOSED.
    // Accepted cleanly, or refused with the bytes untouched — never anything
    // in between. (Today it is refused: appending at the end of a paragraph
    // whose last inline node carries an em/strong/del mark is classified
    // `unsupported-input-type`. That is a PRE-EXISTING kernel read-only
    // surface, identical on the Electron channel, not a web/minification
    // issue. This assertion is written to stay true either way, so fixing it
    // does not break the suite.)
    const probeSource = await readSourceBytes(evaluate, 'after the probe keystroke')
    const accepted = EXPECTED.replace(/\n$/, 'Z\n')
    assert.ok(probeSource === EXPECTED || probeSource === accepted,
      `a refused keystroke must leave the bytes untouched and an accepted one must append exactly one char; got ${
        JSON.stringify(probeSource)}`)
    record('F fail-closed', probeSource === EXPECTED
      ? 'keystroke REFUSED (pre-existing trailing-mark read-only surface), bytes untouched'
      : 'keystroke accepted, bytes exact')

    // ---- Case G: page hygiene.
    assert.deepEqual(app.pageExceptions, [],
      `the web build must throw no uncaught exceptions: ${JSON.stringify(app.pageExceptions)}`)
    const noisy = app.consoleErrors.filter((e) => !BENIGN_CONSOLE.some((rx) => rx.test(e.text || '')))
    assert.deepEqual(noisy, [],
      `unexpected console errors: ${JSON.stringify(noisy)}`)
    assert.deepEqual(app.dialogs, [],
      `no native dialog may appear: ${JSON.stringify(app.dialogs.map((d) => d.message))}`)
    record('G hygiene', `0 exceptions, ${app.consoleErrors.length} benign console error(s), 0 dialogs`)

    console.log(results.join('\n'))
    console.log('PASS kernel web/chrome: the MINIFIED web bundle (npm run build:mobile) attaches the source kernel, ' +
      'accepts a marker-rich ASCII line typed one character at a time (**bold** included), commits it to the source ' +
      'bytes verbatim, publishes those exact bytes through window.api.writeFile, round-trips them across a reload, ' +
      'and names every ProseMirror step by its registered jsonID — defect D4 does not reproduce.')
  } finally {
    await app.stop()
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
