// A Chinese IME's own `/` panel (微信/搜狗) opens on the SAME `/` that opens
// HorseMD's slash menu, and it receives the SAME navigation keys. Confirming an
// item with Enter therefore confirms BOTH: HorseMD converts the block, and
// ~150ms later the IME commits ITS selected entry as a trusted
// `beforeinput/insertText` — no keydown, no composition. Measured in the user's
// own session (2026-08-28): picking 有序列表 produced bytes `1. 2\.`, the `2.`
// being the IME panel's commit escaped as list-item content.
//
// `Input.insertText` is that exact channel: CDP's IME-commit primitive, which
// dispatches trusted text with no key event. Case 1 replays it and the bytes
// must stay `1. `. Case 2 types a REAL character in the same window — a real
// keystroke always carries a keydown, so it must still land.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const port = Number(process.env.CDP_PORT || 10261)
const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`

// A PHYSICAL key press that carries text: one keydown, one insertion. The
// shared typeTextLikeUser cannot serve here — it is `Input.insertText` per
// character (no keydown), the very shape this guard refuses. `rawKeyDown`
// carries the keydown but inserts nothing, and adding a `char` event on top of
// a text-bearing `keyDown` inserts twice (both measured).
async function pressCharKey(send, character, code) {
  const common = { key: character, code, windowsVirtualKeyCode: character.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: character.toUpperCase().charCodeAt(0) }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, text: character })
  await sleep(12)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
}

async function waitFor(fn, message, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function openOrderedViaSlash(app) {
  const { evaluate, send } = app
  const spot = await evaluate(`(() => {
    const e = ${VISIBLE_EDITOR}
    const b = e.getBoundingClientRect()
    return { x: b.left + 40, y: b.top + 20 }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y, button: 'left', clickCount: 1 })
  await sleep(300)
  await typeTextLikeUser(send, '/ol', { delayMs: 55 })
  await waitFor(
    () => evaluate(`document.querySelector('.milkdown-slash-menu[data-show="true"] .hm-slash-item[data-id="ordered"]') !== null`),
    'the ordered item never appeared for the /ol query'
  )
  await pressKey(send, { key: 'Enter', code: 'Enter' })
}

async function run(caseName, after) {
  const root = `/tmp/horsemd-slash-ime-${caseName}-${process.pid}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, '')

  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`!!(${VISIBLE_EDITOR})`), 'editor mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel mode')
    await sleep(700)
    await openOrderedViaSlash(app)
    await after({ evaluate, send })
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await sleep(800)
    return { bytes: await readFile(file, 'utf8'), evaluate }
  } finally {
    await stopBuiltElectron(app)
  }
}

// Case 1 — the IME panel's commit, replayed byte-for-byte as the user's session
// recorded it: 150ms after the confirming Enter, trusted text, no keydown.
const imeCase = await run('ime', async ({ send }) => {
  await sleep(150)
  await send('Input.insertText', { text: '2.' })
  await sleep(900)
})
assert.equal(imeCase.bytes, '1. ', 'an IME panel commit right after a slash-menu run must not become list-item content')

// Case 2 — a REAL keystroke in the same window still lands. This is the half
// that keeps the guard from being a keystroke eater.
//
// It must NOT use typeTextLikeUser: that primitive is `Input.insertText` per
// character, which carries no keydown and is therefore indistinguishable from
// the IME panel's commit — the harness's blind spot, not the product's.
const typedCase = await run('typed', async ({ send }) => {
  await sleep(150)
  await pressCharKey(send, 'a', 'KeyA')
  await sleep(900)
})
assert.equal(typedCase.bytes, '1. a', 'a real keystroke right after a slash-menu run must still commit')

console.log('slash IME-panel guard: OK')
