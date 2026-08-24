// UNDECIDED-ORDINAL GRAYING (typing-policy ADR 第二阶段 item ②). When the
// user hand-types their own number (`4.`) into an ordered item, the typing
// policy keeps it as escaped bytes (`3. 4\.`) — the view shows the AUTO
// ordinal plus the typed number until Space/Enter adjudicates it. The
// adjudicated appearance treatment is a PURE VIEW DECORATION
// (editor-kernel-undecided-ordinal.js) that adds `hm-undecided-ordinal` to
// the list_item while its ENTIRE content is exactly `N.`/`N)`, so CSS can
// gray the AUTO ordinal (never the typed number). This suite locks the class
// lifecycle: present in the undecided state, gone after the Space adoption,
// never present on decided items.
//
// LF only: the decoration is a pure view concern computed from the
// ProseMirror document (the projection), which is line-ending agnostic —
// CRLF byte spelling never reaches the predicate, so a CRLF run would
// exercise nothing new (byte-level CRLF adoption is already locked by
// test-kernel-manual-number-ui.mjs).
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const VISIBLE = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`
// The decoration class lands on the list_item's node-view OUTER dom —
// Crepe's `div.milkdown-list-item-block` (ProseMirror applies Decoration.node
// attrs to a custom node view's `dom`; the `li.list-item` is rendered INSIDE
// that div by the Vue component) — so the decorated-item probe selects the
// wrapper and reads the li within it.
const DECORATED = `document.querySelector('.milkdown-list-item-block.hm-undecided-ordinal')`

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
  const root = `/tmp/horsemd-undecided-ordinal-${label}-${process.pid}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, ['1. 甲', '2. 乙', ''].join(ending))

  const app = await launchBuiltElectron({ profileDir: join(root, `profile-${port}`), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${VISIBLE})?.textContent?.includes('乙')`), 'mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel attach')
    await sleep(800)
    const rect = await evaluate(`(() => {
      const t = [...(${VISIBLE}).querySelectorAll('li p')].find((n) => n.textContent === '乙')
      t.scrollIntoView({ block: 'center' })
      const r = t.getBoundingClientRect()
      return { x: r.right - 2, y: r.top + r.height / 2 }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
    await sleep(250)
    await pressKey(send, { key: 'End', code: 'End' })
    const kd = async (key, code, text) => {
      const vk = /[a-z0-9]/i.test(key) ? key.toUpperCase().charCodeAt(0) : key === '.' ? 190 : 0
      const common = { key, code, modifiers: 0, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, text })
      await sleep(50)
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
      await sleep(150)
    }
    const step = async (k) => {
      if (k === 'Enter') { await pressKey(send, { key: 'Enter', code: 'Enter' }); await sleep(400); return }
      if (k === ' ') { await pressKey(send, { key: ' ', code: 'Space', text: ' ' }); await sleep(400); return }
      await kd(k, k === '.' ? 'Period' : /[a-z]/.test(k) ? 'Key' + k.toUpperCase() : 'Digit' + k, k)
    }

    // No decoration before the gesture — the seeded decided items never match.
    assert.equal(await evaluate(`!!(${DECORATED})`), false,
      `${label}: seeded decided items must not be decorated`)

    // Enter makes item 3 (auto ordinal); typing `4` alone is NOT the
    // undecided state (no delimiter yet)…
    await step('Enter')
    await step('4')
    assert.equal(await evaluate(`!!(${DECORATED})`), false,
      `${label}: a bare digit without its delimiter must not be decorated`)

    // …the `.` completes `4.` — the escaped-marker undecided state: the li
    // showing both the AUTO ordinal and the typed number carries the class.
    await step('.')
    const decorated = await waitFor(
      () => evaluate(`(() => {
        const d = ${DECORATED}
        if (!d) return ''
        const li = d.querySelector('li')
        return li ? (li.textContent || '').trim() : ''
      })()`),
      `${label}: the undecided item must carry hm-undecided-ordinal`
    )
    assert.ok(decorated.includes('4.'),
      `${label}: the decorated li must contain the typed number (got ${JSON.stringify(decorated)})`)

    // (b) Space adopts the typed number as the item's own marker — the
    // undecided state ends and the class must vanish everywhere.
    await step(' ')
    await waitFor(() => evaluate(`!(${DECORATED})`),
      `${label}: after Space adoption no item may stay decorated`)
    assert.equal(await evaluate(`!!document.querySelector('.hm-undecided-ordinal')`), false,
      `${label}: no element may keep the class after adoption`)

    // (c) Decided content typing + Enter never re-triggers the decoration.
    await step('x')
    await step('Enter')
    await sleep(300)
    assert.equal(await evaluate(`!!document.querySelector('.hm-undecided-ordinal')`), false,
      `${label}: decided items (content typed, new empty item) must not be decorated`)

    // (d) The decoration is presentation only — no dialog may have appeared.
    assert.equal(app.dialogs.length, 0, 'no dialog may appear')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
  console.log(`PASS kernel undecided-ordinal graying ${label}`)
}

await runScenario({ ending: '\n', port: Number(process.env.CDP_PORT || 10396) })
console.log('PASS kernel undecided-ordinal graying: hm-undecided-ordinal marks exactly the escaped `N.` state (on at the typed delimiter, off after Space adoption, never on decided items) — LF')
