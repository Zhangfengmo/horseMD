// EMPTYING DELETE ON A SINGLE-LINE LIST ITEM (2026-08-23 user screenshots:
// Backspace inside a quoted nested item TELEPORTED the caret into the NEXT
// blockquote, blocks away).
//
// Root cause chain, reproduced in this exact scenario before the fix:
//   1. deleting the last label character committed the BARE bytes (`>   - `),
//      which CommonMark reads as a SETEXT UNDERLINE — the sibling above
//      became an H2 (`- [ ] ` similarly demotes a task's checkbox);
//   2. the map refresh failed against the restructured parse
//      (`map-refresh-failed`), the region repair rewrote the view, and the
//      caret-unmappable fallback left the caret wherever the reconcile
//      dropped it — the next blockquote.
//
// The fix (`spellEmptyListItemDelete`): the emptying delete is rewritten to
// delete + the ledgered U+00A0 SEED (the indent rescue's own representable
// empty-item spelling), so the item stays a real empty item, the map holds,
// and the caret stays home. This script drives the user's exact gesture:
//   quoted nested item — Backspace the label away, assert the caret is still
//   in the item (NOT in the next quote), type a character, assert it lands
//   IN PLACE; task item — same, and the checkbox survives; save and assert
//   the bytes.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const root = `/tmp/horsemd-empty-delete-${process.pid}`
const file = join(root, 'doc.md')
const FIXTURE = '> 哈哈哈哈\n>\n> - 你是谁\n>   - 2\n\n1232132\n\n测试\n\n># 你觉得对吧\n>\n>我觉得还可以\n\n- [ ] 丁\n\n后文乙\n'
const port = Number(process.env.CDP_PORT || 10134)

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`

async function waitFor(fn, message, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function clickListText(evaluate, send, text) {
  const rect = await waitFor(() => evaluate(`(() => {
    const t = [...((${VISIBLE_EDITOR})?.querySelectorAll('li p') || [])].find((n) => n.textContent === ${JSON.stringify(text)})
    if (!t) return null
    t.scrollIntoView({ block: 'center' })
    const r = t.getBoundingClientRect()
    return { x: r.right - 2, y: r.top + r.height / 2 }
  })()`), `list text ${text} missing`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
  await sleep(300)
}

const CARET_BLOCK = `(() => {
  const sel = window.getSelection()
  if (!sel.anchorNode) return 'none'
  const el = sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode
  const block = el.closest('p, h1, h2, li')
  return (block?.tagName || '?') + ':' + (block?.textContent || '').replace(/\\u00A0/g, 'N').slice(0, 12)
})()`

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)

  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${VISIBLE_EDITOR})?.textContent?.includes('你是谁')`), 'mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel mode')
    await sleep(500)

    const keyType = async (ch, code, vk) => {
      const common = { key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, text: ch })
      await sleep(30)
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
      await sleep(450)
    }

    // --- (1) The screenshot: quoted nested item, Backspace the label away.
    await clickListText(evaluate, send, '2')
    await pressKey(send, { key: 'End', code: 'End' })
    await sleep(150)
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(700)
    const caretQuoted = await evaluate(CARET_BLOCK)
    assert.ok(!caretQuoted.includes('你觉得对吧') && !caretQuoted.includes('我觉得还可以'),
      `the caret must NOT teleport into the next blockquote, got ${caretQuoted}`)
    assert.ok(caretQuoted.startsWith('P:N'),
      `the caret stays in the seeded empty item, got ${caretQuoted}`)
    // Typing lands in place and dissolves the seed.
    await keyType('x', 'KeyX', 88)
    const afterType = await evaluate(CARET_BLOCK)
    assert.equal(afterType, 'P:x', `the typed character replaces the seed in place, got ${afterType}`)

    // --- (2) The task half: Backspace the only label char; checkbox survives.
    await clickListText(evaluate, send, '丁')
    await pressKey(send, { key: 'End', code: 'End' })
    await sleep(150)
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(700)
    const caretTask = await evaluate(CARET_BLOCK)
    assert.ok(caretTask.startsWith('P:N'), `task label empties onto the seed, got ${caretTask}`)
    await keyType('y', 'KeyY', 89)

    // --- (3) No corruption diagnostics, and the saved bytes are the proven
    // spellings.
    const diag = await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).map((d) => d.type))`)
    assert.ok(!diag.includes('map-refresh-failed') && !diag.includes('caret-unmappable') && !diag.includes('attach-unmappable'),
      `no map/caret failures allowed: ${diag}`)
    await evaluate(`(window.confirm = () => true, 1)`)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save fab missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not settle')
    const saved = await readFile(file, 'utf8')
    assert.ok(saved.includes('>   - x\n'), `the quoted item keeps its typed label: ${JSON.stringify(saved.slice(0, 60))}`)
    assert.ok(saved.includes('- [ ] y\n'), 'the task keeps its checkbox and typed label')
    assert.ok(!/\[ \] *\n/.test(saved), 'no bare demoting task spelling may reach disk')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }

  console.log('PASS kernel empty-delete: emptying a quoted nested item / a task label seeds the item in place — the caret never teleports to the next blockquote, typing dissolves the seed, and the saved bytes hold the proven spellings')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
