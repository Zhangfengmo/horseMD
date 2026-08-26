// CHANNEL EQUIVALENCE for the marker-completing Space.
//
// A typed restructuring `N.` is escaped to `N\.` by the typing policy
// (commands/text-escape.js) so it cannot silently split the block. That escape
// is a TRANSIENT: the Space that follows resolves it into a real marker
// (`commands/marker-space.js` spellMarkerCompletingSpace).
//
// The escape was wired into every channel on 2026-08-24 (f70938c, "the marker
// escape rides the IME commit path too"), and since the stage-2 ADR every
// plain-text channel routes through one gateway core. The RESOLVER was not:
// it had a single call site, inside `spaceHandler`, reachable only from the
// Space KEYMAP. So a space delivered without a keydown — an IME committing a
// composition that contains one, a paste, an autocorrect substitution — left
// the backslash in the document PERMANENTLY, and no later keystroke healed it.
//
// Measured before the fix (user report 「1. 2\.」, reproduced):
//   real keydown        -> "1. 甲\n2. "        resolved
//   Input.insertText    -> "1. 甲\n2. 2\."     STUCK, and typing on gave "2\. 乙"
//   IME commit          -> "1. 甲\n2. 2\."     STUCK
//
// docs/ai-handoff.md §5.2d had recorded this as an accepted edge
// (「不经 keydown 注入空格的输入路径（某些 IME 上屏含空格的组合），接受为已知边界」).
// For a user writing Chinese it is not an edge — it is the normal input path.
//
// This suite pins all four delivery channels to the SAME bytes.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const VISIBLE = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`

async function waitFor(fn, msg, tries = 90) {
  for (let i = 0; i < tries; i += 1) {
    const v = await fn()
    if (v) return v
    await sleep(100)
  }
  throw new Error(`timeout: ${msg}`)
}

// Deriving a virtual key code from `charCodeAt` is a trap: '.' is 46, which is
// VK_DELETE, so the app receives a Delete keypress and the period never lands.
const VK = { '.': 190, ')': 48 }
const vkFor = (key) => {
  if (key === 'Enter') return 13
  if (key === ' ') return 32
  if (key.length !== 1) return 0
  if (VK[key] !== undefined) return VK[key]
  const code = key.toUpperCase().charCodeAt(0)
  return code >= 0x30 && code <= 0x5a ? code : 0
}
const codeFor = (ch) =>
  ch === ' ' ? 'Space' : ch === '.' ? 'Period' : /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : /[0-9]/.test(ch) ? `Digit${ch}` : 'Key'

const keyDown = async (send, key, text) => {
  const common = { key, code: codeFor(key), windowsVirtualKeyCode: vkFor(key) }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, ...(text == null ? {} : { text }) })
  await sleep(40)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(160)
}

const readSource = async (evaluate) => {
  await evaluate(`(() => { const b = [...document.querySelectorAll('.status-btn')].find((n) => n.offsetParent && !n.classList.contains('block-switch-caret-btn') && /源码|Source/.test((n.title||'')+(n.textContent||''))); b?.click(); return !!b })()`)
  const v = await waitFor(() => evaluate(`[...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)?.value ?? null`), 'source view')
  await evaluate(`(() => { const b = [...document.querySelectorAll('.status-btn')].find((n) => n.offsetParent && !n.classList.contains('block-switch-caret-btn') && /源码|Source|富文本|Rich/.test((n.title||'')+(n.textContent||''))); b?.click(); return !!b })()`)
  await waitFor(() => evaluate(`(${VISIBLE}) != null`), 'rich back')
  return v
}

// The four ways the completing space can arrive. Only the first is a keydown.
const CHANNELS = [
  {
    name: 'Space via real keydown (control)',
    deliver: async (send) => keyDown(send, ' ', ' ')
  },
  {
    name: 'Space via Input.insertText (paste-shaped)',
    deliver: async (send) => {
      await send('Input.insertText', { text: ' ' })
      await sleep(220)
    }
  },
  {
    name: 'Space inside an IME commit',
    deliver: async (send) => {
      await send('Input.imeSetComposition', { text: ' ', selectionStart: 1, selectionEnd: 1 })
      await sleep(140)
      await send('Input.insertText', { text: ' ' })
      await sleep(220)
    }
  }
]

async function runChannel(channel, index, { ending, port }) {
  const label = ending === '\n' ? 'LF' : 'CRLF'
  const root = `/tmp/horsemd-marker-space-ch-${process.pid}-${index}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, ['# T', '', '1. 甲', ''].join(ending))

  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${VISIBLE})?.textContent?.includes('甲')`), 'mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel attach')
    const attach = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!attach.includes('attach-unmappable'), `${label}/${channel.name}: degraded to legacy`)
    await sleep(500)

    // Caret to the end of item 1, Enter to open item 2 (auto marker `2. `),
    // then hand-type `2.` — the manual-numberer's gesture, which is what
    // produces the escape the completing Space has to resolve.
    const rect = await evaluate(`(() => {
      const li = [...(${VISIBLE}).querySelectorAll('li')][0]
      li.scrollIntoView({ block: 'center' })
      const r = li.getBoundingClientRect()
      return { x: r.right - 4, y: r.top + r.height / 2 }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
    await sleep(300)
    await keyDown(send, 'Enter')
    await sleep(400)
    await keyDown(send, '2', '2')
    await keyDown(send, '.', '.')
    await sleep(300)

    // The escape must exist right now — otherwise this test is not standing on
    // the shape it claims to test.
    const beforeSpace = await readSource(evaluate)
    assert.ok(/2\\\./.test(beforeSpace),
      `${label}/${channel.name}: precondition — the typed 2. must be escaped first, got ${JSON.stringify(beforeSpace)}`)

    await channel.deliver(send)
    await sleep(600)
    const afterSpace = await readSource(evaluate)
    assert.ok(!/\\\./.test(afterSpace),
      `${label}/${channel.name}: the completing space must resolve the escape, got ${JSON.stringify(afterSpace)}`)

    // And it must resolve to the SAME bytes on every channel: the typed number
    // is adopted as the item's own marker.
    const expectedSource = ['# T', '', '1. 甲', '2. ', ''].join('\n')
    assert.equal(afterSpace, expectedSource, `${label}/${channel.name}: resolved bytes`)

    // Typing on must continue the item, not decorate a literal.
    await keyDown(send, '乙', '乙')
    await sleep(500)
    const afterMore = await readSource(evaluate)
    assert.equal(afterMore, ['# T', '', '1. 甲', '2. 乙', ''].join('\n'),
      `${label}/${channel.name}: typing continues the adopted item`)

    // Disk bytes keep the document's own line endings.
    await evaluate(`(window.confirm = () => true, 1)`)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save fab')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save settle')
    const disk = await readFile(file, 'utf8')
    assert.equal(disk, ['# T', '', '1. 甲', '2. 乙', ''].join(ending), `${label}/${channel.name}: disk bytes`)
    if (ending === '\r\n') {
      assert.equal(/(?<!\r)\n/.test(disk), false, `${label}/${channel.name}: CRLF document gained a lone LF`)
    }
    assert.deepEqual(app.dialogs.map((d) => d.message), [], `${label}/${channel.name}: no dialog`)
    console.log(`  PASS ${label} — ${channel.name}`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

const basePort = Number(process.env.CDP_PORT || 11001)
let index = 0
for (const ending of ['\n', '\r\n']) {
  for (const channel of CHANNELS) {
    await runChannel(channel, index, { ending, port: basePort + index })
    index += 1
  }
}
console.log('PASS kernel marker-completing space: every delivery channel (keydown, insertText, IME commit) resolves the escape to the same bytes (LF + CRLF)')
