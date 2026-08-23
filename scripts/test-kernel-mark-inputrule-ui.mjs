// MARK INPUT RULES in kernel mode (2026-08-23): typing the closing delimiter
// of `*斜*` / `**粗**` / `` `码` `` / `~~删~~` / `==高==` used to be swallowed
// whole (the gateway vetoed the rule's transaction — the exploratory
// session's 9-veto cascade, where one dangling opening delimiter turned
// every later delimiter keystroke into a swallowed rule match). Now the
// typed delimiter commits as a LITERAL byte gated by a reparse proof, with
// the literal fallback landing the byte even when the rule's own result is
// unprovable (the eager single-`~` strike rule). This suite types the full
// five-mark line through the real keyboard pipeline (keyDown+text — the
// CGEvent-equivalent channel) and asserts:
//   1. the source bytes equal the typed string EXACTLY;
//   2. the rendered DOM carries all five mark elements;
//   3. save is byte-exact and a cold reopen renders the same marks.
// LF + CRLF.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const VISIBLE = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`

async function waitFor(fn, message, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

// Full keyboard pipeline per character: keyDown WITH text (so Chromium
// produces the keypress/beforeinput chain a real key does), then keyUp.
// `rawKeyDown` would suppress the character; punctuation must not derive a
// virtualKeyCode from charCodeAt ('.' would become VK_DELETE) — both are
// recorded channel laws (ai-handoff, 2026-08-23).
const keyDown = async (send, key, code, text, modifiers = 0) => {
  const vk = { Enter: 13, Tab: 9, ' ': 32 }[key] ?? (key.length === 1 && /[a-z0-9]/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0)
  const common = { key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, ...(text == null ? {} : { text }) })
  await sleep(40)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
  await sleep(80)
}
const typeReal = async (send, s) => {
  for (const ch of s) {
    const code = ch === ' ' ? 'Space' : /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : /[0-9]/.test(ch) ? 'Digit' + ch : 'Key'
    await keyDown(send, ch, code, ch)
  }
}

const MARK_LINE = '*斜*与**粗**与`码`与~~删~~与==高==完'

async function runScenario({ ending, port }) {
  const label = ending === '\n' ? 'LF' : 'CRLF'
  const root = `/tmp/horsemd-mark-ir-${label}-${process.pid}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, ['# 标记输入', '', '甲段。', ''].join(ending))

  let app = await launchBuiltElectron({ profileDir: join(root, `profile-${port}`), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    await waitFor(() => evaluate(`(${VISIBLE})?.textContent?.includes('甲段')`), 'mount')
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel attach')
    await sleep(600)

    const rect = await evaluate(`(() => {
      const t = [...(${VISIBLE}).querySelectorAll('p')].find((n) => n.textContent.startsWith('甲段'))
      t.scrollIntoView({ block: 'center' })
      const r = t.getBoundingClientRect()
      return { x: r.right - 2, y: r.top + r.height / 2 }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
    await sleep(300)
    await keyDown(send, 'Enter', 'Enter')
    await sleep(400)
    await typeReal(send, MARK_LINE)
    await sleep(800)

    // 1. the rendered DOM carries every mark, on exactly the right glyphs
    const domMarks = JSON.parse(await evaluate(`(() => {
      const ed = ${VISIBLE}
      const pick = (sel) => [...ed.querySelectorAll(sel)].map((n) => n.textContent).join(',')
      return JSON.stringify({
        em: pick('p em'), strong: pick('p strong'), code: pick('p code'),
        del: pick('p del, p s'), mark: pick('p mark')
      })
    })()`))
    assert.equal(domMarks.em, '斜', `${label}: em renders — got ${JSON.stringify(domMarks)}`)
    assert.equal(domMarks.strong, '粗', `${label}: strong renders`)
    assert.ok(domMarks.code.includes('码'), `${label}: inline code renders — got ${JSON.stringify(domMarks.code)}`)
    assert.equal(domMarks.del, '删', `${label}: strike renders`)
    assert.equal(domMarks.mark, '高', `${label}: highlight renders`)

    // 2. the source bytes are EXACTLY the typed string
    await evaluate(`(() => { const b = [...document.querySelectorAll('.status-btn')].find((n) => n.offsetParent && !n.classList.contains('block-switch-caret-btn') && /源码|Source/.test((n.title||'')+(n.textContent||''))); b?.click(); return !!b })()`)
    const source = await waitFor(() => evaluate(`[...document.querySelectorAll('textarea.source-editor')].find((n) => n.offsetParent)?.value ?? null`), 'source view')
    const expected = ['# 标记输入', '', '甲段。', '', MARK_LINE, ''].join('\n')
    if (source !== expected) {
      console.error('  actual  :', JSON.stringify(source))
      console.error('  expected:', JSON.stringify(expected))
    }
    assert.equal(source, expected, `${label}: the typed delimiters land byte-for-byte`)
    await evaluate(`(() => { const b = [...document.querySelectorAll('.status-btn')].find((n) => n.offsetParent && !n.classList.contains('block-switch-caret-btn') && /源码|Source|富文本|Rich/.test((n.title||'')+(n.textContent||''))); b?.click(); return !!b })()`)
    await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'rich back')

    // 3. save: disk bytes keep the document's own line endings
    await evaluate(`(window.confirm = () => true, 1)`)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save fab')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save settle')
    const disk = await readFile(file, 'utf8')
    const expectedDisk = ['# 标记输入', '', '甲段。', '', MARK_LINE, ''].join(ending)
    if (disk !== expectedDisk) {
      console.error('  actual  :', JSON.stringify(disk))
      console.error('  expected:', JSON.stringify(expectedDisk))
    }
    assert.equal(disk, expectedDisk, `${label}: disk bytes exact`)
    if (ending === '\r\n') {
      assert.equal(/(?<!\r)\n/.test(disk), false, 'a CRLF document must not gain a lone LF')
    }
    assert.equal(app.dialogs.length, 0, 'no dialog may appear')
  } finally {
    await stopBuiltElectron(app, { removeProfile: false })
  }

  // 4. cold reopen renders the same five marks
  app = await launchBuiltElectron({ profileDir: join(root, `profile-${port + 1}`), port: port + 1, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate } = app
    await waitFor(() => evaluate(`(${VISIBLE})?.textContent?.includes('完')`), 'reopen mount')
    await sleep(500)
    const marks = JSON.parse(await evaluate(`(() => {
      const ed = ${VISIBLE}
      const pick = (sel) => [...ed.querySelectorAll(sel)].map((n) => n.textContent).join(',')
      return JSON.stringify({ em: pick('p em'), strong: pick('p strong'), del: pick('p del, p s'), mark: pick('p mark') })
    })()`))
    assert.equal(marks.em, '斜', `${label} reopen: em`)
    assert.equal(marks.strong, '粗', `${label} reopen: strong`)
    assert.equal(marks.del, '删', `${label} reopen: strike`)
    assert.equal(marks.mark, '高', `${label} reopen: highlight`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
  console.log(`PASS kernel mark input rules ${label}`)
}

await runScenario({ ending: '\n', port: Number(process.env.CDP_PORT || 10336) })
await runScenario({ ending: '\r\n', port: Number(process.env.CDP_PORT || 10336) + 4 })
console.log('PASS kernel mark input rules: typing *斜* / **粗** / `码` / ~~删~~ / ==高== lands byte-for-byte with every mark rendered, byte-exact save, mark-exact cold reopen (LF + CRLF)')
