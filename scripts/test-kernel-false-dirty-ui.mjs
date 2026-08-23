// FALSE-DIRTY ON REFUSED KEYSTROKES (2026-08-24 user report: "21.md 无法保存").
// The document `1. 2.3121312 / 2. 2131 / 3. 4.` pairs its two authored EMPTY
// items read-only; typing into one is REFUSED (zero bytes change) — but the
// DOM `input` event unconditionally set `pendingRichEdit`, so the tab showed
// 已修改 + the save FAB with content identical to disk. Saving cleared it,
// and the very next refused keystroke lit it again — which reads exactly as
// "cannot save". The pending hint exists for LEGACY's 200ms serializer
// debounce; the kernel publishes synchronously on every accepted commit, so
// in kernel mode the hint is suppressed and dirty is precisely
// `content !== savedContent`.
//
// LF only: the family is a DOM-event/React-flag interaction with no
// line-ending surface (the keystroke commits nothing at all).
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const VISIBLE = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`
const root = `/tmp/horsemd-false-dirty-${process.pid}`
const file = join(root, 'doc.md')
const port = Number(process.env.CDP_PORT || 10346)

async function waitFor(fn, message, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })
// The reported document's shape: a same-line nested bare marker leaves two
// authored empty items that pair read-only.
await writeFile(file, ['# 你好啊', '', '扭扭捏捏', '', '- 1313123', '- 1231232', '', '123123213', '', '1. 2.3121312', '2. 2131', '3. 4.', ''].join('\n'))

const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
try {
  const { evaluate, send } = app
  await waitFor(() => evaluate(`(${VISIBLE})?.textContent?.includes('你好啊')`), 'mount')
  await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel attach')
  await sleep(800)
  const fab = () => evaluate(`!!document.querySelector('.hm-save-fab')`)
  assert.equal(await fab(), false, 'clean open: no save fab')

  // Real keyboard channel (keyDown+text) into the READ-ONLY empty item — the
  // insertText channel does not fire the DOM input event this bug rides on.
  const kd = async (key, code, text) => {
    const vk = /[a-z0-9]/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0
    const common = { key, code, modifiers: 0, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, text })
    await sleep(60)
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    await sleep(120)
  }
  const rect = await evaluate(`(() => {
    const items = [...(${VISIBLE}).querySelectorAll('li')]
    const t = items[items.length - 2]
    t.scrollIntoView({ block: 'center' })
    const r = t.getBoundingClientRect()
    return { x: r.left + 24, y: r.top + 10 }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
  await sleep(300)
  // The reported reproduction needs an IME attempt FIRST (the composition's
  // rollback leaves the editor in the state where the next plain keydown's
  // DOM input event fires) — measured: keydowns alone did not light the fab,
  // IME-then-keydown did.
  for (let i = 0; i < 2; i += 1) {
    const ch = 'ni'[i]
    const code = ch.charCodeAt(0)
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
    const text = 'ni'.slice(0, i + 1)
    await send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length, replacementId: 'c1', location: 0 })
    await sleep(80)
  }
  await send('Input.insertText', { text: '你' })
  await sleep(300)
  await fab()
  await evaluate("[...document.querySelectorAll('*')].some((n) => n.childElementCount === 0 && n.textContent === '已修改')")
  await evaluate(`document.querySelector('.hm-toast')?.textContent ?? null`)
  await kd('a', 'KeyA', 'a')
  await kd('b', 'KeyB', 'b')
  // Assert IMMEDIATELY: before the fix the false-dirty self-cleared within
  // ~500ms (the rich-dirty reconcile committed a kernel snapshot and wiped
  // pendingRichEdit), so a late read always saw clean — while a user typing
  //继续 into the read-only block re-lit it on every keystroke, which
  // presents as a permanently modified tab that "cannot be saved".
  const litNow = await evaluate(`!!document.querySelector('.hm-save-fab')`)
  const toast = await evaluate(`document.querySelector('.hm-toast')?.textContent ?? null`)
  assert.ok(toast && toast.includes('只读'), `the keystroke must refuse loudly (got ${JSON.stringify(toast)})`)
  assert.equal(litNow, false,
    'a REFUSED keystroke (zero bytes changed) must NOT light the save fab — not even transiently (the false-dirty family)')
  await sleep(600)

  // Control: a real edit in an editable paragraph must still dirty the tab,
  // and save must clear it.
  const prect = await evaluate(`(() => {
    const t = [...(${VISIBLE}).querySelectorAll('p')].find((n) => (n.textContent||'').startsWith('扭扭捏捏'))
    t.scrollIntoView({ block: 'center' })
    const r = t.getBoundingClientRect()
    return { x: r.right - 2, y: r.top + r.height / 2 }
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...prect })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...prect })
  await sleep(250)
  await pressKey(send, { key: 'End', code: 'End' })
  await kd('z', 'KeyZ', 'z')
  await waitFor(fab, 'a real edit must light the save fab')
  await evaluate(`(window.confirm = () => true, 1)`)
  await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(async () => !(await fab()), 'save must clear the fab')
  const disk = await readFile(file, 'utf8')
  assert.ok(disk.includes('扭扭捏捏z'), `the real edit reached disk (got ${JSON.stringify(disk)})`)
  console.log('PASS kernel false-dirty: refused keystrokes never light the save fab; real edits still dirty and save')
} finally {
  await stopBuiltElectron(app, { removeProfile: true })
  await rm(root, { recursive: true, force: true })
}
