// GESTURE LOOP (2026-08-23 user directive「构建整个回环测试和新的功能性测试」):
// the same document goes through TWO edit->save->cold-reopen cycles, chaining
// the gesture families of the day's reports end to end:
//   cycle 1: paragraph Enter -> ordered marker completion -> the '2.'-mid-item
//            typing burst (the same-line bare-marker transient must demote) ->
//            item Enter chain -> a deliberately-left bare '4.' (the same-line
//            NESTED shape) -> Tab at the NEXT item's head (the reported
//            gesture: it must nest under item 1, never splice into '4.') ->
//            save -> byte-exact disk assert;
//   cold reopen 1: kernel re-attach + view skeleton assert (render equals the
//            CommonMark reading of the saved bytes);
//   cycle 2: typing into the nested item + Backspace-join of the paragraph
//            into the heading -> save -> byte-exact assert;
//   cold reopen 2: final skeleton assert.
// LF + CRLF.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)`

async function waitFor(fn, message, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const SKELETON_JS = `(() => {
  const ed = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
  const itemOf = (li) => {
    const p = li.querySelector('p')
    const nested = [...li.querySelectorAll('ul, ol')].filter((c) => c.closest('li') === li)
    return 'li:' + (p ? p.textContent : '') + nested.map((l) => ' ' + listOf(l)).join('')
  }
  const listOf = (list) => list.tagName.toLowerCase() + '[' + [...list.children].map((w) => w.tagName === 'LI' ? w : w.querySelector('li')).filter(Boolean).map(itemOf).join(' ') + ']'
  const out = []
  for (const el of ed.querySelectorAll(':scope h1, :scope p, :scope ol, :scope ul')) {
    if (el.closest('li') || el.closest('blockquote')) continue
    const tag = el.tagName.toLowerCase()
    if (tag === 'h1') out.push('h1:' + el.textContent)
    else if (tag === 'p') { if (el.textContent !== '') out.push('p:' + el.textContent) }
    else out.push(listOf(el))
  }
  return out.join('\\n')
})()`

async function launch(root, file, port) {
  const app = await launchBuiltElectron({ profileDir: join(root, `profile-${port}`), port, appArgs: [file], kernelDefault: true })
  const { evaluate } = app
  await waitFor(() => evaluate(`(${VISIBLE_EDITOR})?.textContent?.length > 0`), 'mount')
  await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel attach')
  await sleep(700)
  return app
}

const clickBlock = async (app, text, edge) => {
  const { evaluate, send } = app
  const rect = await waitFor(() => evaluate(`(() => {
    const t = [...((${VISIBLE_EDITOR})?.querySelectorAll('p, h1') || [])].find((n) => n.textContent === ${JSON.stringify(text)})
    if (!t) return null
    t.scrollIntoView({ block: 'center' })
    const r = t.getBoundingClientRect()
    return { x: ${edge === 'start' ? 'r.left + 2' : 'r.right - 2'}, y: r.top + r.height / 2 }
  })()`), `block ${text} missing`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
  await sleep(250)
  await pressKey(send, { key: edge === 'start' ? 'Home' : 'End', code: edge === 'start' ? 'Home' : 'End' })
  await sleep(150)
}

const save = async (app) => {
  const { evaluate } = app
  await evaluate(`(window.confirm = () => true, 1)`)
  await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save fab')
  await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
  await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save settle')
}

const noBadDiag = async (app, label) => {
  const diag = await app.evaluate(`JSON.stringify((window.__hmKernelDiagnostics || []).map((d) => d.type))`)
  for (const bad of ['unclassified-transaction', 'attach-unmappable', 'split-placeholder-unprovable']) {
    assert.ok(!diag.includes(bad), `${label}: ${bad} must never appear: ${diag}`)
  }
}

async function runScenario({ ending, port }) {
  const label = ending === '\n' ? 'LF' : 'CRLF'
  const root = `/tmp/horsemd-gesture-loop-${label}-${process.pid}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, ['# 头', '', '甲段', ''].join(ending))

  // ---- cycle 1 ----
  let app = await launch(root, file, port)
  try {
    const { send } = app
    await clickBlock(app, '甲段', 'end')
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(400)
    await typeTextLikeUser(send, '1.', { delayMs: 50 })
    await pressKey(send, { key: ' ', code: 'Space', text: ' ' })
    await sleep(400)
    // the '2.'-mid-item burst: the bare-marker transient demotes under '3'.
    await typeTextLikeUser(send, '2.312', { delayMs: 40 })
    await sleep(400)
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(400)
    await typeTextLikeUser(send, '2131', { delayMs: 40 })
    await sleep(300)
    await pressKey(send, { key: 'Enter', code: 'Enter' })
    await sleep(400)
    // leave a SAME-LINE NESTED bare '4.' (the reported document's shape).
    await typeTextLikeUser(send, '4.', { delayMs: 60 })
    await sleep(500)
    // the reported gesture: Tab at the '2131' item's HEAD nests it under
    // item 1 — never splices it into the '4.' line.
    await clickBlock(app, '2131', 'start')
    await pressKey(send, { key: 'Tab', code: 'Tab' })
    await sleep(600)
    await save(app)
    const saved1 = await readFile(file, 'utf8')
    const expected1 = ['# 头', '', '甲段', '', '1. 2.312', '   1. 2131', '3. 4.', ''].join(ending)
    if (saved1 !== expected1) {
      console.error('  actual  :', JSON.stringify(saved1))
      console.error('  expected:', JSON.stringify(expected1))
    }
    assert.equal(saved1, expected1, `${label} cycle1: bytes land exactly`)
    await noBadDiag(app, `${label} cycle1`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: false })
  }

  // ---- cold reopen 1: render equals the CommonMark reading ----
  app = await launch(root, file, port + 1)
  try {
    const skeleton = await app.evaluate(SKELETON_JS)
    const expectedSkeleton = ['h1:头', 'p:甲段', 'ol[li:2.312 ol[li:2131] li: ol[li:]]'].join('\n')
    if (skeleton !== expectedSkeleton) {
      console.error('  actual  :\n' + skeleton)
      console.error('  expected:\n' + expectedSkeleton)
    }
    assert.equal(skeleton, expectedSkeleton, `${label} reopen1: the view renders the saved bytes' CommonMark reading`)

    // ---- cycle 2, in the reopened process ----
    const { send } = app
    await clickBlock(app, '2131', 'end')
    await typeTextLikeUser(send, '9', { delayMs: 40 })
    await sleep(400)
    await clickBlock(app, '甲段', 'start')
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(500)
    await save(app)
    const saved2 = await readFile(file, 'utf8')
    const expected2 = ['# 头甲段', '', '1. 2.312', '   1. 21319', '3. 4.', ''].join(ending)
    if (saved2 !== expected2) {
      console.error('  actual  :', JSON.stringify(saved2))
      console.error('  expected:', JSON.stringify(expected2))
    }
    assert.equal(saved2, expected2, `${label} cycle2: the join + nested typing land exactly`)
    await noBadDiag(app, `${label} cycle2`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: false })
  }

  // ---- cold reopen 2: final render ----
  app = await launch(root, file, port + 2)
  try {
    const skeleton = await app.evaluate(SKELETON_JS)
    const expectedSkeleton = ['h1:头甲段', 'ol[li:2.312 ol[li:21319] li: ol[li:]]'].join('\n')
    assert.equal(skeleton, expectedSkeleton, `${label} reopen2: final render matches (got ${JSON.stringify(skeleton)})`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
  console.log(`PASS kernel gesture-loop ${label}`)
}

await runScenario({ ending: '\n', port: Number(process.env.CDP_PORT || 10286) })
await runScenario({ ending: '\r\n', port: Number(process.env.CDP_PORT || 10286) + 4 })
console.log('PASS kernel gesture-loop: two full edit->save->cold-reopen cycles chain the marker burst, the same-line nested bare marker, Tab-at-item-head nesting, nested-item typing and the heading join — bytes exact at every save, render exact at every reopen (LF + CRLF)')
