// Typing inside a bolded/italic/struck/linked word must land — in the view AND
// in the bytes — in kernel mode.
//
// It did nothing, silently. ProseMirror stamps a typed character with the run's
// mark whenever that mark is INCLUSIVE (strong/emphasis/strike_through/link all
// are), the gateway's plain-text path refuses any marked insert slice, and the
// refusal carried no code, no toast and no diagnostic the user could see.
// Measured before the fix (scripts/probe-trailing-mark-append.mjs,
// scripts/probe-mark-run-interior.mjs): 4 of 7 trailing-mark spellings swallowed
// the keystroke, and typing in the MIDDLE of a bold word was swallowed too.
// Inline code and ==highlight== were unaffected only because this repo declares
// those two marks `inclusive: false` — which is why both appear below as
// controls: they must keep landing OUTSIDE the delimiters.
//
// This is the round-trip lock: real keystrokes, real source bytes, a real save,
// and — for one case — a real cold reopen, because the whole point is that the
// character survives to the file.
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

const keyDown = async (send, key, code, text) => {
  const common = { key, code, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, ...(text == null ? {} : { text }) })
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

// `where`: 'edge' clicks just past the run's visual right edge (the reported
// gesture — keep typing after a formatted word); 'interior' clicks at its
// horizontal middle (the larger half of the same defect).
// `run` is the run's VISIBLE text; the interior assertion is expressed against
// it rather than against one hand-picked index, because the click lands by
// geometry and a 4-character run's midpoint can round either side of a glyph.
// Pinning an exact index would be pinning the rounding, not the behaviour.
const CASES = [
  { name: 'strong', tag: 'strong', run: 'bold', line: '甲 **bold** 乙', edge: '甲 **boldZ** 乙' },
  { name: 'emphasis', tag: 'em', run: 'emph', line: '甲 *emph* 乙', edge: '甲 *emphZ* 乙' },
  { name: 'strike', tag: 'del', run: 'dele', line: '甲 ~~dele~~ 乙', edge: '甲 ~~deleZ~~ 乙' },
  { name: 'link', tag: 'a', run: 'link', line: '甲 [link](http://x) 乙', edge: '甲 [linkZ](http://x) 乙' },
  // Inline code belongs with the four above, NOT with the controls — measured,
  // not assumed. `inclusive: false` exempts it only where ProseMirror really
  // drops the mark; at THIS caret (the element's own right edge) it does not,
  // and the pre-fix build swallowed this keystroke exactly like bold's
  // (scripts/probe-code-edge.mjs, A/B against a stashed build:
  // SWALLOWED `unsupported-input-type` before, '甲 `codeZ` 乙' after). The
  // earlier probe that showed inline code landing clicked past the PARAGRAPH's
  // edge, a different position — which is why the two disagreed.
  { name: 'inlineCode', tag: 'code', run: 'code', line: '甲 `code` 乙', edge: '甲 `codeZ` 乙' },
  // Highlight IS the control: at the same caret PM drops the mark, the slice
  // stays plain, and the character lands OUTSIDE the delimiters through the
  // untouched plain path — identical before and after the fix. If the marked
  // path ever widened far enough to swallow this case, this line fails.
  { name: 'highlight (control)', tag: 'mark', run: 'high', line: '甲 ==high== 乙', edge: '甲 ==high==Z 乙' }
]

// The interior invariant, stated positionally instead of literally: exactly one
// 'Z' was added, nothing else in the line changed, and the 'Z' sits strictly
// inside the run's own visible text — never in its delimiters, never outside.
const assertInteriorLanded = (label, sourceLine, testCase) => {
  assert.notEqual(sourceLine, testCase.line, `${label}: the keystroke was swallowed`)
  const zIndex = sourceLine.indexOf('Z')
  assert.ok(zIndex >= 0, `${label}: no character landed, got ${JSON.stringify(sourceLine)}`)
  assert.equal(sourceLine.slice(0, zIndex) + sourceLine.slice(zIndex + 1), testCase.line,
    `${label}: exactly one character may be added and nothing else may change, got ${JSON.stringify(sourceLine)}`)
  const runStart = testCase.line.indexOf(testCase.run)
  assert.ok(zIndex > runStart && zIndex < runStart + testCase.run.length,
    `${label}: the character must land strictly inside the run's text, got ${JSON.stringify(sourceLine)}`)
}

async function run({ testCase, where, ending, port, coldReopen = false }) {
  const label = `${testCase.name}/${where}/${ending === '\n' ? 'LF' : 'CRLF'}`
  const root = `/tmp/horsemd-marked-insert-${process.pid}-${port}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const original = ['# 标记', '', testCase.line, ''].join(ending)
  await writeFile(file, original)
  const want = where === 'edge' ? ['# 标记', '', testCase.edge, ''].join(ending) : null

  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
    const { evaluate, send } = app
    await waitFor(() => evaluate("((" + VISIBLE + ")?.textContent || '').includes('甲')"), 'mount')
    await waitFor(() => evaluate("[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)"), 'kernel attach')
    const attach = await evaluate("JSON.stringify(window.__hmKernelDiagnostics || [])")
    assert.ok(!attach.includes('attach-unmappable'), `${label}: degraded to legacy`)
    await sleep(900)
    await evaluate('window.__hmKernelDiagnostics = []')

    // Click by GEOMETRY, never by setting a DOM selection: a raw DOM selection
    // does not sync ProseMirror state (see CLAUDE.md's CDP gotcha).
    const rect = await evaluate(`(() => {
      const t = (${VISIBLE}).querySelector('${testCase.tag}')
      t.scrollIntoView({ block: 'center' })
      const r = t.getBoundingClientRect()
      return ${where === 'edge'} ? { x: r.right - 1, y: r.top + r.height / 2 } : { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
    await sleep(350)
    await keyDown(send, 'Z', 'KeyZ', 'Z')
    await sleep(700)

    const source = await readSource(evaluate)
    if (want) {
      assert.equal(source.replace(/\r\n/g, '\n'), want.replace(/\r\n/g, '\n'),
        `${label}: source bytes after typing`)
    } else {
      assertInteriorLanded(label, source.replace(/\r\n/g, '\n').split('\n')[2] ?? '', testCase)
    }
    assert.deepEqual(app.dialogs.map((d) => d.message), [], `${label}: no dialog`)

    await evaluate('(window.confirm = () => true, 1)')
    await waitFor(() => evaluate("!!document.querySelector('.hm-save-fab')"), 'save fab')
    await evaluate("document.querySelector('.hm-save-fab')?.click()")
    await waitFor(() => evaluate("!document.querySelector('.hm-save-fab')"), 'save settle')
    const disk = await readFile(file, 'utf8')
    assert.equal(disk.replace(/\r\n/g, '\n'), source.replace(/\r\n/g, '\n'),
      `${label}: the saved file must be the bytes the editor reported`)
    if (want) assert.equal(disk, want, `${label}: disk bytes`)
    console.log(`  PASS ${label}`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }

  if (!coldReopen) {
    await rm(root, { recursive: true, force: true })
    return
  }

  // A separate process, reading the file the first one wrote: the character has
  // to still be there, still inside the run, and the block has to still attach.
  let reopened
  try {
    reopened = await launchBuiltElectron({ profileDir: join(root, 'profile2'), port: port + 500, appArgs: [file], kernelDefault: true })
    const { evaluate } = reopened
    await waitFor(() => evaluate("((" + VISIBLE + ")?.textContent || '').includes('甲')"), 'reopen mount')
    await waitFor(() => evaluate("[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)"), 'reopen kernel attach')
    await sleep(700)
    const shown = await evaluate(`((${VISIBLE}).querySelector('${testCase.tag}')?.textContent) || ''`)
    assert.ok(shown.includes('Z'), `${label}: after cold reopen the character must still be inside the run, got ${JSON.stringify(shown)}`)
    const again = await readSource(evaluate)
    assert.equal(again.replace(/\r\n/g, '\n'), want.replace(/\r\n/g, '\n'), `${label}: bytes after cold reopen`)
    console.log(`  PASS ${label} (cold reopen)`)
  } finally {
    await stopBuiltElectron(reopened, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

let port = Number(process.env.CDP_PORT || 11951)
for (const testCase of CASES) {
  for (const where of ['edge', 'interior']) {
    await run({ testCase, where, ending: '\n', port, coldReopen: testCase.name === 'strong' && where === 'edge' })
    port += 1
  }
}
// CRLF on the two shapes whose byte home the fix actually moved.
for (const where of ['edge', 'interior']) {
  await run({ testCase: CASES[0], where, ending: '\r\n', port })
  port += 1
}
console.log('PASS kernel marked-text insert: typing at the edge of and inside strong/emphasis/strike/link/inline-code runs lands inside the delimiters, the one caret where PM drops the mark still lands outside them, and the bytes survive save and cold reopen (LF + CRLF)')
