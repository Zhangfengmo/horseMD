// MID-DOCUMENT BLANK-RUN ENTER (2026-08-23 user report: pressing Enter in a
// fresh empty placeholder paragraph mid-document was refused with
// `unsupported-structure` — "直接将上一个作为空行不行吗").
//
// Three layers had to agree, and this script drives all of them through the
// real app:
//   1. splitTextBlock's proof-gated GAP branch: Enter on a blank-line offset
//      extends the run by one ending (quote-prefixed inside a blockquote —
//      a bare ending would split the quote in two, and the reparse proof
//      picks the surviving spelling);
//   2. the projection map's chain floor, restated from "trailing only" to
//      "no voucher inside a LEAF block's span", so extendTrailingPlaceholder
//      can vouch MID-document chains;
//   3. the emptying delete on a root paragraph (spellEmptyListItemDelete's
//      placeholder clause): deleting a paragraph's last character keeps the
//      empty PM paragraph as a vouched placeholder, so the follow-up Enter
//      and typing land exactly where the caret shows.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-gap-enter-${process.pid}`
const file = join(root, 'doc.md')
const FIXTURE = '哈哈哈哈\n\n12312\n\n> 引甲\n>\n> 引乙\n'
const port = Number(process.env.CDP_PORT || 10136)

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`

async function waitFor(fn, message, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)

  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${VISIBLE_EDITOR})?.textContent?.includes('哈哈哈哈')`), 'mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel mode')
    await sleep(500)

    const clickEnd = async (text) => {
      const rect = await waitFor(() => evaluate(`(() => {
        const t = [...((${VISIBLE_EDITOR})?.querySelectorAll('p') || [])].find((n) => n.textContent === ${JSON.stringify(text)})
        if (!t) return null
        t.scrollIntoView({ block: 'center' })
        const r = t.getBoundingClientRect()
        return { x: r.right - 2, y: r.top + r.height / 2 }
      })()`), `paragraph ${text} missing`)
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
    const noToast = async (label) => {
      const toasts = await evaluate(`JSON.stringify([...document.querySelectorAll('.hm-toast, .toast')].filter((t) => t.offsetParent).map((t) => t.textContent))`)
      assert.equal(toasts, '[]', `${label} must not refuse: ${toasts}`)
    }

    // (1) Mid-document: Enter x3 on the growing placeholder chain, then type.
    await clickEnd('哈哈哈哈')
    for (let i = 0; i < 3; i += 1) {
      await pressKey(send, { key: 'Enter', code: 'Enter' })
      await sleep(450)
      await noToast(`mid-doc Enter #${i + 1}`)
    }
    await keyType('x', 'KeyX', 88)

    // (2) Empty the typed paragraph, Enter on the vouched empty, type again.
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(500)
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(500)
    await noToast('post-empty Enter')
    await keyType('z', 'KeyZ', 90)

    // (3) Inside the blockquote: Enter twice through the quote's blank line,
    // then type — the quote must stay ONE quote.
    await clickEnd('引甲')
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(450)
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(450)
    await noToast('quoted Enter x2')
    await keyType('q', 'KeyQ', 81)

    await evaluate(`(window.confirm = () => true, 1)`)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save fab missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not settle')
    const saved = await readFile(file, 'utf8')
    assert.ok(saved.includes('z\n'), `the post-empty typed character reaches disk: ${JSON.stringify(saved)}`)
    assert.ok(/> q\n/.test(saved), 'the quoted typed character reaches disk with its prefix')
    assert.equal((saved.match(/^>/gm) || []).length >= 5 && !/\n\n> 引乙/.test(saved), true,
      'the blockquote stays ONE quote (no bare blank line split it)')
    const diag = await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).map((d) => d.type))`)
    assert.ok(!diag.includes('split-placeholder-unprovable') && !diag.includes('attach-unmappable'),
      `no unprovable placeholders: ${diag}`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }

  console.log('PASS kernel gap-enter: mid-document Enter extends the blank run (chain-vouched), the quoted blank line extends with its prefix, emptying a paragraph leaves a typable vouched placeholder, and every typed character reaches disk where the caret showed it')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
