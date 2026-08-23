// CHANNEL EQUIVALENCE — the pin for the route-blindness family (2026-08-24
// user review). Three times over, a byte policy was added to ONE input
// channel and silently missed the others: the block-tail space heal
// (2026-08-19, keyboard-only until the IME audit), the task-seed dissolve
// (2026-08-20, same), and the marker-escaping delimiter (2026-08-24, same
// again). Mature editor stacks (ProseMirror/CodeMirror) pin this class with
// composition-vs-keyboard equivalence tests; this suite is that pin for the
// kernel: THE SAME semantic edits, performed through each input channel on
// identical documents, must produce BYTE-IDENTICAL saved files.
//
// Channels:
//   keydown — full keyDown-with-text per character (the CGEvent-equivalent
//             real-keyboard pipeline);
//   insert  — Input.insertText per character (the paste/automation shape);
//   ime     — one composition (imeSetComposition updates) committed via
//             insertText (the Chinese-IME shape).
// Edits (chosen to cross every policy that has ever been route-blind):
//   1. `4` then `.` at a new ordered item's content start (marker escape);
//   2. a trailing space at a block end, then a CJK character (the U+00A0
//      heal + displacement);
//   3. a plain CJK insert mid-paragraph (control).
// A future policy added to one channel and not the others fails this suite
// by byte diff, with the channel named.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const VISIBLE = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`
const FIXTURE = ['# 等价', '', '甲乙丙', '', '1. 2131', ''].join('\n')

async function waitFor(fn, message, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

// One character through the chosen channel.
const send1 = async (send, channel, ch, compId) => {
  if (channel === 'keydown') {
    const vk = /[a-z0-9]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : ch === ' ' ? 32 : 0
    const code = ch === ' ' ? 'Space' : ch === '.' ? 'Period' : /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : /[0-9]/.test(ch) ? 'Digit' + ch : 'Key'
    const common = { key: ch, code, modifiers: 0, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, text: ch })
    await sleep(50)
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    await sleep(120)
    return
  }
  if (channel === 'insert') {
    await send('Input.insertText', { text: ch })
    await sleep(150)
    return
  }
  // ime: a one-character composition committed immediately.
  await send('Input.imeSetComposition', { text: ch, selectionStart: 1, selectionEnd: 1, replacementId: compId, location: 0 })
  await sleep(100)
  await send('Input.insertText', { text: ch })
  await sleep(200)
}

async function runChannel(channel, port) {
  const root = `/tmp/horsemd-chaneq-${channel}-${process.pid}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)
  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${VISIBLE})?.textContent?.includes('2131')`), 'mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel attach')
    await sleep(800)
    const click = async (text) => {
      const rect = await waitFor(() => evaluate(`(() => {
        const t = [...(${VISIBLE}).querySelectorAll('p, h1')].find((n) => (n.textContent || '').startsWith(${JSON.stringify(text)}))
        if (!t) return null
        t.scrollIntoView({ block: 'center' })
        const r = t.getBoundingClientRect()
        return { x: r.right - 2, y: r.top + r.height / 2 }
      })()`), `${text} missing`)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
      await sleep(250)
      await pressKey(send, { key: 'End', code: 'End' })
      await sleep(150)
    }

    // Edit 1: new ordered item, then `4` `.` — the marker-escape policy.
    await click('2131')
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(500)
    let comp = 1
    for (const ch of ['4', '.']) await send1(send, channel, ch, `c${comp++}`)
    await sleep(400)

    // Edit 2: block-end trailing space then CJK — the heal + displacement.
    await click('甲乙丙')
    for (const ch of [' ', '丁']) await send1(send, channel, ch, `c${comp++}`)
    await sleep(400)

    // Edit 3: control CJK insert at the heading end.
    await click('# 等价') // heading textContent is '等价'
      .catch(() => {})
    await click('等价').catch(() => {})
    await send1(send, channel, '戊', `c${comp++}`)
    await sleep(400)

    await evaluate(`(window.confirm = () => true, 1)`)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save fab')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save settle')
    const disk = await readFile(file, 'utf8')
    assert.equal(app.dialogs.length, 0, `${channel}: no dialog may appear`)
    return disk
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

const base = Number(process.env.CDP_PORT || 10376)
const results = {}
for (const [i, channel] of ['keydown', 'insert', 'ime'].entries()) {
  results[channel] = await runChannel(channel, base + i * 2)
  console.log(`${channel}: ${JSON.stringify(results[channel])}`)
}
assert.equal(results.insert, results.keydown,
  'CHANNEL DIVERGENCE: insertText produced different bytes than the keyboard pipeline')
assert.equal(results.ime, results.keydown,
  'CHANNEL DIVERGENCE: the IME composition path produced different bytes than the keyboard pipeline')
console.log('PASS kernel channel equivalence: keyboard, insertText and IME composition commit byte-identical documents across the marker-escape, trailing-space-heal and plain-CJK edits')
