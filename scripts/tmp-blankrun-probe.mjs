// Does an AUTHORED blank run in the file show up as an empty line in the view?
// (The second half of the user's invariant: 「源码的空格也应该是有对应参照的」.)
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey } from './lib/human-input.mjs'

const port = Number(process.env.CDP_PORT || 10681)
const V = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`
async function waitFor(f, m, t = 80) { for (let i = 0; i < t; i++) { const v = await f(); if (v) return v; await sleep(100) } throw new Error(m) }

// 甲 / one blank / 乙 (ordinary), then 丙 / TWO blanks / 丁 (an authored empty
// line), then 戊 / THREE blanks / 己.
const FIXTURE = '甲\n\n乙\n\n\n丙\n\n\n\n丁\n'
const root = `/tmp/horsemd-blankrun-${process.pid}`
const file = join(root, 'doc.md')
await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })
await writeFile(file, FIXTURE)
const app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file], kernelDefault: process.env.LEGACY !== '1' })
const { evaluate, send } = app
try {
  await waitFor(() => evaluate(`(${V})?.textContent?.includes('丁')`), 'mount')
  await sleep(900)
  const blocks = await evaluate(`JSON.stringify([...(${V}).children].map((n) => n.tagName + ':' + JSON.stringify(n.textContent)))`)
  console.log(`[${process.env.LEGACY === '1' ? 'legacy' : 'kernel'}] view blocks:`, blocks)
  console.log('  bytes on disk:', JSON.stringify(FIXTURE))
  // Round trip: save without touching anything.
  await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await sleep(700)
  console.log('  bytes after a no-op save:', JSON.stringify(await readFile(file, 'utf8')))
} finally { await stopBuiltElectron(app) }
