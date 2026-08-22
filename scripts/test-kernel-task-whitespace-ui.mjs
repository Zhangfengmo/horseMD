// SESSION-WHITESPACE TASK LABEL + NESTED-SIBLING TAB (2026-08-22 user
// screenshot: a task list where Space-then-gestures on a fresh item bred
// literal `• [ ]` bullets and Tab at a nested tail did nothing).
//
// The replayed gesture, one real keydown at a time (driver iron rule:
// keymap-routed keys need real keyDown+text — `Input.insertText` never
// reaches the kernel's handlers):
//   1. caret at a NESTED task's label end → Enter: the continuation is a
//      SEEDED task (`- [ ] ` + U+00A0, ledgered) — never a bare `- [ ] `
//      that demotes to a literal-bracket bullet.
//   2. Space: spelled U+00A0 by the trailing machinery (a literal trailing
//      ASCII space would demote the checkbox on reload).
//   3. Tab: the nested item INDENTS under its previous sibling — the
//      previousSibling probe used to resolve nested line starts to the
//      ENCLOSING item, so every depth≥2 Tab refused silently.
//   4. Enter: the all-ledgered whitespace label is EFFECTIVELY EMPTY — the
//      item exits (deletes its whole marker line) instead of breeding
//      another seeded sibling forever.
//   5. The saved bytes carry no trailing ASCII space after any checkbox and
//      every `- [ ]` line reloads as a REAL task (checked boolean).
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const NB = '\u00A0'
const root = `/tmp/horsemd-task-whitespace-${process.pid}`
const file = join(root, 'task.md')
const FIXTURE = '- [ ] 32131212\n  - [ ] 甲\n'
const port = Number(process.env.CDP_PORT || 10132)

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
    await waitFor(() => evaluate(`(${VISIBLE_EDITOR})?.textContent?.includes('甲')`), 'mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel mode')
    await sleep(500)

    // Caret at 甲's label end (click the real text — invisible-content
    // clicks fail to focus silently).
    const rect = await evaluate(`(() => {
      const t = [...((${VISIBLE_EDITOR})?.querySelectorAll('li p') || [])].find((n) => n.textContent === '甲')
      if (!t) return null
      const r = t.getBoundingClientRect()
      return { x: r.right - 2, y: r.top + r.height / 2 }
    })()`)
    assert.ok(rect, '甲 paragraph missing')
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
    await sleep(300)
    await pressKey(send, { key: 'End', code: 'End' })
    await sleep(150)

    const keyType = async (ch, code, vk) => {
      const common = { key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, text: ch })
      await sleep(30)
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
      await sleep(450)
    }

    // 1. Enter → seeded continuation.
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(500)
    // 2. Space → second session NBSP.
    await keyType(' ', 'Space', 32)
    // 3. Tab → the nested item must INDENT under 甲 (was: silent refusal).
    await pressKey(send, { key: 'Tab', code: 'Tab' })
    await sleep(500)
    const depths = `JSON.stringify([...((${VISIBLE_EDITOR})?.querySelectorAll('li') || [])].map((li) => { let d = 0, e = li; while (e) { e = e.parentElement?.closest('li'); d += 1 } return d + ':' + (li.querySelector('p')?.textContent || '').replace(/\\u00A0/g, 'N') }))`
    const afterTab = await evaluate(depths)
    assert.ok(afterTab.includes('"3:NN"'),
      `Tab must nest the whitespace item one level under 甲 (depth 3), got ${afterTab}`)
    // 4. Enter → the effectively-empty item EXITS (no new seeded sibling).
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(600)

    // 5. Save; the on-disk bytes must hold ZERO demoting spellings.
    await evaluate(`(window.confirm = () => true, 1)`)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save fab missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not settle')
    const saved = await readFile(file, 'utf8')
    for (const line of saved.split('\n')) {
      if (!line.includes('[ ]')) continue
      assert.ok(!/\[ \] *$/.test(line),
        `a checkbox followed by only ASCII spaces demotes on reload: ${JSON.stringify(line)}`)
    }
    assert.ok(!saved.includes('- [ ] ' + NB + '\n- [ ] '),
      `no bred seeded siblings may remain: ${JSON.stringify(saved)}`)
    const diag = await evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).map((d) => d.type))`)
    assert.ok(!diag.includes('attach-unmappable'), `no degradation: ${diag}`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }

  console.log('PASS kernel task-whitespace: Enter seeds, Space spells U+00A0, nested Tab indents, Enter exits the effectively-empty item, and the saved bytes contain no demoting checkbox spellings')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
