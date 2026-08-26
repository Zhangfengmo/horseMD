// Reproduction probe: "在大文档里 Ctrl+A 然后删除会失败".
// Measures the gesture across sizes, because the two plausible mechanisms have
// different size signatures: a structural refusal (fails at every size) vs. the
// chunked-load / batch-size path (fails only above a threshold).
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { makeCorpus } from './lib/kernel-corpus.mjs'

const VISIBLE = "[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)"

async function waitFor(fn, msg, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    const v = await fn()
    if (v) return v
    await sleep(150)
  }
  throw new Error(`timeout: ${msg}`)
}

const keyDown = async (send, key, code, modifiers = 0) => {
  const common = { key, code, modifiers, windowsVirtualKeyCode: key === 'Delete' ? 46 : key === 'Backspace' ? 8 : key === 'a' ? 65 : 0 }
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common })
  await sleep(60)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(200)
}

const readSource = async (evaluate) => {
  await evaluate("(() => { const b = [...document.querySelectorAll('.status-btn')].find((n) => n.offsetParent && !n.classList.contains('block-switch-caret-btn') && /源码|Source/.test((n.title||'')+(n.textContent||''))); b?.click(); return !!b })()")
  const v = await waitFor(() => evaluate("[...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)?.value ?? null"), 'source view')
  await evaluate("(() => { const b = [...document.querySelectorAll('.status-btn')].find((n) => n.offsetParent && !n.classList.contains('block-switch-caret-btn') && /源码|Source|富文本|Rich/.test((n.title||'')+(n.textContent||''))); b?.click(); return !!b })()")
  await waitFor(() => evaluate("(" + VISIBLE + ") != null"), 'rich back')
  return v
}

// 8 KB / 60 KB / 200 KB — below, well below, and above CHUNK_THRESHOLD (120 000).
const SIZES = [8000, 60000, 200000]
const basePort = Number(process.env.CDP_PORT || 11701)

for (const [index, target] of SIZES.entries()) {
  const root = `/tmp/horsemd-selall-${process.pid}-${index}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const corpus = makeCorpus(target, 42, { chunkTraps: true })
  await writeFile(file, corpus)

  console.log(`\n### ${corpus.length} chars${corpus.length > 120000 ? '  (above CHUNK_THRESHOLD)' : ''}`)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port: basePort + index, appArgs: [file], kernelDefault: true })
    const { evaluate, send } = app
    await waitFor(() => evaluate("((" + VISIBLE + ")?.textContent || '').length > 200"), 'mount')
    await waitFor(() => evaluate("[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)"), 'kernel attach')
    await sleep(2500)
    const attach = await evaluate("JSON.stringify((window.__hmKernelDiagnostics||[]).map(d=>d.type||d.code))")
    console.log(`  attach diags : ${attach.slice(0, 160)}`)

    await evaluate("(" + VISIBLE + ").focus()")
    await sleep(300)
    await evaluate("window.__hmKernelDiagnostics = []")

    // Ctrl/Cmd+A then Delete, as real key events.
    await keyDown(send, 'a', 'KeyA', 4)   // 4 = Meta on macOS
    await sleep(600)
    const selChars = await evaluate("(() => { const s = window.getSelection(); return s && !s.isCollapsed ? String(s.toString().length) : '0' })()")
    console.log(`  selected     : ${selChars} chars`)

    const t0 = Date.now()
    await keyDown(send, 'Delete', 'Delete')
    await sleep(3000)
    const elapsed = Date.now() - t0

    const domLen = await evaluate("((" + VISIBLE + ")?.textContent || '').length")
    const source = await readSource(evaluate)
    const diags = JSON.parse(await evaluate("JSON.stringify((window.__hmKernelDiagnostics||[]).map(d=>d.type||d.code))"))
    const counts = {}
    for (const d of diags) counts[d] = (counts[d] || 0) + 1

    console.log(`  after Delete : DOM ${domLen} chars, source ${source.length} chars, ${elapsed} ms`)
    console.log(`  diagnostics  : ${JSON.stringify(counts)}`)
    console.log(`  dialogs      : ${JSON.stringify(app.dialogs.map((d) => d.message))}`)
    console.log(`  RESULT       : ${source.trim() === '' && domLen <= 1 ? 'DELETED' : 'FAILED — content survived'}`)

    if (source.trim() !== '') {
      // Does a second attempt work? Distinguishes a one-shot refusal from a
      // permanently stuck state.
      await keyDown(send, 'a', 'KeyA', 4)
      await sleep(400)
      await keyDown(send, 'Backspace', 'Backspace')
      await sleep(2000)
      const retry = await readSource(evaluate)
      console.log(`  retry w/ BS  : source ${retry.length} chars -> ${retry.trim() === '' ? 'DELETED' : 'still FAILED'}`)
    }
  } catch (err) {
    console.log(`  ERROR: ${err.message}`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}
console.log()
