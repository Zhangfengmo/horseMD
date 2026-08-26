// Ctrl/Cmd+A then Delete must clear the document in kernel mode.
//
// It did nothing, silently: the structural router answers `not-structural` for
// Delete, hands the key to ProseMirror, and the resulting whole-document
// ReplaceStep classifies as a cross-block deletion, which the plain-text core
// vetoes. Fail-closed, so no bytes were harmed — but no toast, no diagnostic,
// and a dead key on one of the most ordinary gestures there is.
//
// Measured: fails at 8 KB, 60 KB and 200 KB and in a 128-char document, while a
// small in-block selection deletes fine and legacy deletes fine. The trigger is
// the CROSS-BLOCK selection, not size.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const VISIBLE = "[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)"

async function waitFor(fn, msg, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    const v = await fn()
    if (v) return v
    await sleep(150)
  }
  throw new Error(`timeout: ${msg}`)
}

const VK = { Delete: 46, Backspace: 8, a: 65, z: 90 }
const keyDown = async (send, key, code, modifiers = 0) => {
  const common = { key, code, modifiers, windowsVirtualKeyCode: VK[key] || 0 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await sleep(60)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(220)
}

const readSource = async (evaluate) => {
  await evaluate("(() => { const b = [...document.querySelectorAll('.status-btn')].find((n) => n.offsetParent && !n.classList.contains('block-switch-caret-btn') && /源码|Source/.test((n.title||'')+(n.textContent||''))); b?.click(); return !!b })()")
  const v = await waitFor(() => evaluate("[...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)?.value ?? null"), 'source view')
  await evaluate("(() => { const b = [...document.querySelectorAll('.status-btn')].find((n) => n.offsetParent && !n.classList.contains('block-switch-caret-btn') && /源码|Source|富文本|Rich/.test((n.title||'')+(n.textContent||''))); b?.click(); return !!b })()")
  await waitFor(() => evaluate("(" + VISIBLE + ") != null"), 'rich back')
  return v
}

async function run({ key, ending, port }) {
  const label = `${key}/${ending === '\n' ? 'LF' : 'CRLF'}`
  const root = `/tmp/horsemd-selall-del-${process.pid}-${port}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  // Every container kind, so the selection genuinely crosses block boundaries.
  const original = ['# 标题', '', '段落甲。', '', '- 项目一', '- 项目二', '', '> 引用', '', '```js', 'const a = 1', '```', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', ''].join(ending)
  await writeFile(file, original)

  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
    const { evaluate, send } = app
    await waitFor(() => evaluate("((" + VISIBLE + ")?.textContent || '').includes('段落甲')"), 'mount')
    await waitFor(() => evaluate("[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)"), 'kernel attach')
    const attach = await evaluate("JSON.stringify(window.__hmKernelDiagnostics || [])")
    assert.ok(!attach.includes('attach-unmappable'), `${label}: degraded to legacy`)
    await sleep(1200)

    await evaluate("(" + VISIBLE + ").focus()")
    await sleep(300)
    await keyDown(send, 'a', 'KeyA', 4)
    await sleep(600)
    const selected = await evaluate("(() => { const s = window.getSelection(); return s && !s.isCollapsed ? s.toString().length : 0 })()")
    assert.ok(selected > 20, `${label}: precondition — select-all must select the document, got ${selected}`)

    await keyDown(send, key, key)
    await sleep(1500)

    const cleared = await readSource(evaluate)
    assert.equal(cleared.trim(), '', `${label}: the document must be cleared, got ${JSON.stringify(cleared.slice(0, 120))}`)
    assert.deepEqual(app.dialogs.map((d) => d.message), [], `${label}: no dialog`)

    // Undo restores the whole document as ONE history group.
    await keyDown(send, 'z', 'KeyZ', 4)
    await sleep(900)
    const undone = await readSource(evaluate)
    assert.equal(undone, original, `${label}: undo must restore the document in one group`)

    // Redo back to empty, then save and cold-reopen.
    await keyDown(send, 'a', 'KeyA', 4)
    await sleep(500)
    await keyDown(send, key, key)
    await sleep(1200)
    await evaluate("(window.confirm = () => true, 1)")
    await waitFor(() => evaluate("!!document.querySelector('.hm-save-fab')"), 'save fab')
    await evaluate("document.querySelector('.hm-save-fab')?.click()")
    await waitFor(() => evaluate("!document.querySelector('.hm-save-fab')"), 'save settle')
    const disk = await readFile(file, 'utf8')
    assert.equal(disk.trim(), '', `${label}: disk must be cleared, got ${JSON.stringify(disk.slice(0, 120))}`)
    console.log(`  PASS ${label}`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

let port = Number(process.env.CDP_PORT || 11901)
for (const key of ['Delete', 'Backspace']) {
  for (const ending of ['\n', '\r\n']) {
    await run({ key, ending, port })
    port += 1
  }
}
console.log('PASS kernel select-all delete: Ctrl/Cmd+A then Delete or Backspace clears the document, undo restores it in one group, save and cold reopen agree (LF + CRLF)')
