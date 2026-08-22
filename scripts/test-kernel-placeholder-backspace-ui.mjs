// PLACEHOLDER BACKSPACE (2026-08-23 user report, screenshot: caret on a fresh
// empty placeholder paragraph inside a big blockquote, Backspace refused with
// 「暂未支持此操作 (unsupported-input-type)」 — PM's joinBackward produced a
// cross-parent ReplaceStep the gateway could only refuse).
//
// The fix is the exact INVERSE of the gap Enter: the session records the raw
// span each Enter wrote (`writtenFrom/To` on the voucher) and
// shrinkSplitPlaceholder deletes it verbatim — a byte-exact restore, proven
// structure-neutral by reparse (shrinkBlankRun). This script drives the real
// app through the reported gesture in LF and CRLF:
//   1. mid-document root paragraph: Enter -> Backspace (bytes restored),
//      then Enter x2 -> Backspace x2 (the chain unwinds symmetrically);
//   2. the QUOTED paragraph (the screenshot shape): Enter -> Backspace ->
//      type — the typed char lands at the end of the quoted paragraph,
//      proving the caret came back editable;
//   3. save: the file is byte-identical to the fixture except the typed char.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`

async function waitFor(fn, message, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function runScenario({ ending, port }) {
  const label = ending === '\n' ? 'LF' : 'CRLF'
  const root = `/tmp/horsemd-placeholder-backspace-${label}-${process.pid}`
  const file = join(root, 'doc.md')
  const E = ending
  const FIXTURE = `前文${E}${E}> 引甲${E}>${E}> 引乙${E}${E}尾块${E}`
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)

  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${VISIBLE_EDITOR})?.textContent?.includes('引乙')`), `${label} mount`)
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), `${label} kernel mode`)
    await sleep(500)

    const clickEnd = async (text) => {
      const rect = await waitFor(() => evaluate(`(() => {
        const t = [...((${VISIBLE_EDITOR})?.querySelectorAll('p') || [])].find((n) => n.textContent === ${JSON.stringify(text)})
        if (!t) return null
        t.scrollIntoView({ block: 'center' })
        const r = t.getBoundingClientRect()
        return { x: r.right - 2, y: r.top + r.height / 2 }
      })()`), `${label}: paragraph ${text} missing`)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
      await sleep(250)
      await pressKey(send, { key: 'End', code: 'End' })
      await sleep(150)
    }
    const keyType = async (ch, code, vk) => {
      const common = { key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, text: ch })
      await sleep(30)
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
      await sleep(450)
    }
    const noToast = async (step) => {
      const toasts = await evaluate(`JSON.stringify([...document.querySelectorAll('.hm-toast, .toast')].filter((t) => t.offsetParent).map((t) => t.textContent))`)
      assert.equal(toasts, '[]', `${label} ${step} must not refuse: ${toasts}`)
    }
    const press = async (key, step) => {
      await pressKey(send, { key, code: key })
      await sleep(450)
      await noToast(step)
    }

    // (1) Root paragraph: Enter opens the placeholder, Backspace takes it back.
    await clickEnd('前文')
    await press('Enter', 'root Enter')
    await press('Backspace', 'root Backspace')
    // The chain unwinds one press at a time.
    await press('Enter', 'root Enter #1')
    await press('Enter', 'root Enter #2')
    await press('Backspace', 'root chain Backspace #1')
    await press('Backspace', 'root chain Backspace #2')

    // (2) The screenshot shape: quoted paragraph, Enter then Backspace, then
    // type — the caret must land back at the end of 引甲, editable.
    await clickEnd('引甲')
    await press('Enter', 'quoted Enter')
    await press('Backspace', 'quoted Backspace')
    await keyType('w', 'KeyW', 87)

    // (3) Save and compare bytes: everything except the typed char restored.
    await evaluate(`(window.confirm = () => true, 1)`)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), `${label} save fab missing`)
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), `${label} save did not settle`)
    const saved = await readFile(file, 'utf8')
    assert.equal(saved, FIXTURE.replace('引甲', '引甲w'),
      `${label}: the file is byte-identical to the fixture except the typed char — every Enter's bytes were taken back`)

    const diag = await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).map((d) => d.type))`)
    assert.ok(!diag.includes('unclassified-transaction'),
      `${label}: Backspace never reaches PM joinBackward: ${diag}`)
    assert.ok(!diag.includes('split-placeholder-unprovable') && !diag.includes('attach-unmappable'),
      `${label}: no unprovable placeholders: ${diag}`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
  console.log(`PASS kernel placeholder-backspace ${label}`)
}

await runScenario({ ending: '\n', port: Number(process.env.CDP_PORT || 10176) })
await runScenario({ ending: '\r\n', port: Number(process.env.CDP_PORT || 10176) + 1 })
console.log('PASS kernel placeholder-backspace: Backspace inside a vouched placeholder shrinks the blank run byte-exactly (root + quoted, chain unwind, LF + CRLF), the caret lands back editable, and the refused-joinBackward toast is gone')
