// QUOTE x DOC-END GESTURE MATRIX (2026-08-31). The placeholder/exit family
// around "quote at an unterminated document end" leaked one shape at a time
// (the 500.md reports); this suite enumerates the gesture sequences instead
// of pinning single reports. Per sequence, the invariants are:
//   * the saved bytes carry NO leftover blank quote line (the session either
//     filled, exited-with-reclaim, or was reclaimed on abandonment);
//   * the user's bad shape — a bare quote line stranded after a PLAIN blank
//     line (`\n\n>` …) — never appears;
//   * the typed marker text lands exactly once, on the expected side of the
//     quote;
//   * undo sequences restore the fixture byte-for-byte.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const port = Number(process.env.CDP_PORT || 12560)
const V = `[...document.querySelectorAll('.milkdown .ProseMirror')].find((el) => el.offsetParent)`

const FIXTURE_A = '>你好啊\n>\n>你是十二' // unterminated doc end — the reported family
const FIXTURE_B = '> 引用\n\n尾段。\n'      // terminated, content below

// sequence steps: e=Enter, t=type 乙, b=click below quote, q=click first quote line, u=undo
const CASES = [
  { fixture: 'A', steps: 'e b t', expect: { side: 'out' } },
  { fixture: 'A', steps: 'e e t', expect: { side: 'out' } },
  { fixture: 'A', steps: 'e e e t', expect: { side: 'out' } },
  { fixture: 'A', steps: 'e t', expect: { side: 'in' } },
  { fixture: 'A', steps: 'e q t', expect: { side: 'in' } },
  { fixture: 'A', steps: 'e u', expect: { restored: true } },
  { fixture: 'A', steps: 'e e u u', expect: { restored: true } },
  { fixture: 'B', steps: 'e b t', expect: { side: 'out' } },
  { fixture: 'B', steps: 'e e t', expect: { side: 'out' } },
  { fixture: 'B', steps: 'e t', expect: { side: 'in' } },
  { fixture: 'B', steps: 'e u', expect: { restored: true } }
]

let seq = 0
async function runCase(spec) {
  seq += 1
  const fixture = spec.fixture === 'A' ? FIXTURE_A : FIXTURE_B
  const marker = spec.fixture === 'A' ? '你是十二' : '引用'
  const root = `/tmp/horsemd-quote-eof-${process.pid}-${seq}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, fixture)
  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: true })
  try {
    const { evaluate, send } = app
    const wait = async (fn, msg, tries = 60) => {
      for (let i = 0; i < tries; i += 1) { const v = await fn(); if (v) return v; await sleep(250) }
      throw new Error(`${msg} [${spec.fixture} ${spec.steps}]`)
    }
    await wait(() => evaluate(`(${V})?.textContent?.includes('${marker}')`), 'mount')
    await wait(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel')
    await sleep(600)

    const click = async (point) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
      await sleep(400)
    }
    // start at the END of the quote's last content paragraph
    await click(await evaluate(`(() => {
      const paras = [...(${V}).querySelectorAll('blockquote p')].filter((p) => p.textContent.trim())
      const r = paras[paras.length - 1].getBoundingClientRect()
      return { x: r.right - 3, y: r.top + r.height / 2 }
    })()`))

    for (const step of spec.steps.split(' ')) {
      if (step === 'e') { await pressKey(send, { key: 'Enter', code: 'Enter' }); await sleep(650) }
      else if (step === 't') { await send('Input.insertText', { text: '乙' }); await sleep(650) }
      else if (step === 'u') {
        await pressKey(send, { key: 'z', code: 'KeyZ', modifiers: 4 }); await sleep(650)
      } else if (step === 'b') {
        await click(await evaluate(`(() => {
          const ed = ${V}
          const last = ed.children[ed.children.length - 1]
          const r = last.getBoundingClientRect()
          return { x: r.left + 10, y: r.top + r.height / 2 }
        })()`))
      } else if (step === 'q') {
        await click(await evaluate(`(() => {
          const p = [...(${V}).querySelectorAll('blockquote p')].find((n) => n.textContent.trim())
          const r = p.getBoundingClientRect()
          return { x: r.right - 3, y: r.top + r.height / 2 }
        })()`))
      }
    }

    // save via the FAB when dirty; a fully-restored doc has no FAB
    const hadFab = await evaluate(`!!document.querySelector('.hm-save-fab')`)
    if (hadFab) {
      await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
      await sleep(900)
    }
    const disk = await readFile(file, 'utf8')
    const label = `[${spec.fixture} | ${spec.steps}]`
    console.log(` ${label} ->`, JSON.stringify(disk))

    if (spec.expect.restored) {
      assert.equal(disk, fixture, `${label} undo must restore the fixture byte-for-byte`)
      return
    }
    // Invariant 1: a blank quote line is legal ONLY as a separator BETWEEN
    // two content quote lines (authored bytes); any other position is a
    // session leftover.
    const lines = disk.split('\n')
    const isBlankQuote = (line) => /^[ \t]*(?:>[ \t]*)*>[ \t]*$/.test(line)
    const isContentQuote = (line) => /^[ \t]*>/.test(line) && line.replace(/[>\t ]+/g, '') !== ''
    for (let i = 0; i < lines.length; i += 1) {
      if (!isBlankQuote(lines[i])) continue
      let up = i - 1
      while (up >= 0 && isBlankQuote(lines[up])) up -= 1
      let down = i + 1
      while (down < lines.length && isBlankQuote(lines[down])) down += 1
      const okAbove = up >= 0 && isContentQuote(lines[up])
      const okBelow = down < lines.length && isContentQuote(lines[down])
      assert.ok(okAbove && okBelow,
        `${label} leftover blank quote line at ${i} in ${JSON.stringify(disk)}`)
    }
    // Invariant 2: the user's bad shape never appears.
    assert.ok(!/\n[ \t]*\n[ \t]*>/.test(disk),
      `${label} a quote stranded after a plain blank line: ${JSON.stringify(disk)}`)
    // Invariant 3: 乙 lands exactly once, on the expected side.
    assert.equal((disk.match(/乙/g) || []).length, 1, `${label} typed text must land exactly once`)
    const zeLine = lines.find((line) => line.includes('乙'))
    if (spec.expect.side === 'in') {
      assert.ok(/^[ \t]*>/.test(zeLine), `${label} 乙 must be INSIDE the quote: ${JSON.stringify(zeLine)}`)
    } else {
      assert.ok(!/^[ \t]*>/.test(zeLine), `${label} 乙 must be OUTSIDE the quote: ${JSON.stringify(zeLine)}`)
    }
    // Invariant 4: the fixture's own content survives.
    assert.ok(disk.includes('你好啊') || disk.includes('引用'), `${label} original content lost`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
}

for (const spec of CASES) await runCase(spec)
console.log('PASS kernel quote x doc-end gesture matrix: every Enter/click/type/undo interleaving saves clean bytes — no leftover blank quote lines, no quote stranded behind a plain blank line, typed text on the expected side, undo byte-exact')
