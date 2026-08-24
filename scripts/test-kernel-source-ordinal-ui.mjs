// SOURCE-FAITHFUL ORDERED NUMBERS (2026-08-24 user report「这个源码都不对照」:
// the view showed CommonMark's sequential ordinals 1,2,3 while the authored
// bytes said 1,3,4). Kernel tabs now display the AUTHOR's own numbers — the
// byte-authoritative reading (Obsidian/VSCode style) — via the
// hm-source-ordinal decoration (editor-kernel-mode.js) painting each item's
// source number over the auto ordinal with a CSS var + ::before swap.
// Pure view: bytes untouched, legacy tabs untouched.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'

const VISIBLE = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`
const FIXTURE = ['1. 2.3121312', '3. 甲', '4. 乙', ''].join('\n')

async function waitFor(fn, message, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

async function run({ kernelDefault, port }) {
  const root = `/tmp/horsemd-src-ordinal-${kernelDefault ? 'k' : 'l'}-${process.pid}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)
  const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault })
  try {
    const { evaluate } = app
    await waitFor(() => evaluate(`(${VISIBLE})?.textContent?.includes('2.3121312')`), 'mount')
    if (kernelDefault) {
      await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel attach')
    }
    await sleep(1000)
    const items = JSON.parse(await evaluate(`(() => {
      const blocks = [...document.querySelectorAll('.milkdown-list-item-block')].filter((n) => n.offsetParent)
      return JSON.stringify(blocks.map((b) => ({
        decorated: b.classList.contains('hm-source-ordinal'),
        shown: (() => { const l = b.querySelector('.label.ordered'); return l ? getComputedStyle(l, '::before').content : null })()
      })))
    })()`))
    if (kernelDefault) {
      assert.equal(items.length, 3)
      assert.deepEqual(items.map((i) => i.decorated), [true, true, true],
        `kernel: every ordered item carries the source-ordinal decoration (${JSON.stringify(items)})`)
      assert.deepEqual(items.map((i) => i.shown), ['"1."', '"3."', '"4."'],
        `kernel: the DISPLAYED numbers are the AUTHOR's source numbers (${JSON.stringify(items)})`)
    } else {
      assert.ok(items.every((i) => !i.decorated),
        `legacy: no source-ordinal decoration may appear (${JSON.stringify(items)})`)
    }
    // Pure view: the bytes never moved.
    assert.equal(await readFile(file, 'utf8'), FIXTURE, 'bytes untouched')
    assert.equal(app.dialogs.length, 0, 'no dialog')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
  console.log(`PASS kernel source-ordinal ${kernelDefault ? 'kernel' : 'legacy-control'}`)
}

await run({ kernelDefault: true, port: Number(process.env.CDP_PORT || 10406) })
await run({ kernelDefault: false, port: Number(process.env.CDP_PORT || 10406) + 2 })
console.log('PASS kernel source-ordinal: kernel tabs display the author\'s own list numbers (1,3,4 for bytes 1,3,4), legacy untouched, bytes untouched')
