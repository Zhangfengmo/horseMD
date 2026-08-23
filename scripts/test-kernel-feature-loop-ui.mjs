// FEATURE LOOP (2026-08-23 combination-suite extension round): the sibling of
// test-kernel-gesture-loop-ui.mjs, over the OTHER gesture families that landed
// after the slash round — heading demote, aligned-table cell editing, the
// quote>list+sibling shape, and a footnote-carrying document — chained through
// two edit->save->cold-reopen cycles so each family's bytes must survive the
// next family's gesture and a process boundary:
//   cycle 1: H2 -> H1 demote (Backspace at content start) -> typing into an
//            ALIGNED table's body cell (the table-ops alignment row must not
//            move) -> typing into the quote paragraph that FOLLOWS a list in
//            the same quote (the provenSpanEnd/clampedNodeEnd neighbourhood)
//            -> save -> byte-exact disk assert;
//   cold reopen 1: kernel re-attach on a document that now holds a footnote
//            definition, an aligned table and a quote>list+para -> skeleton
//            assert -> cycle 2: H1 -> paragraph demote (the second Backspace
//            gesture) + typing into the quote's LIST item -> save ->
//            byte-exact assert;
//   cold reopen 2: final skeleton assert (the demoted heading renders as a
//            paragraph; everything else unchanged).
// LF + CRLF. Every expected string is spelled from the fixture plus exactly
// the characters this file types — nothing is read back and rubber-stamped.
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

// Top-level block skeleton: tag names in document order, with the text of
// headings and plain paragraphs. The footnote paragraph's DOM text depends on
// how the ref atom renders, so paragraphs CONTAINING an atom record only their
// leading atom-free text (everything before the first inline widget).
const SKELETON_JS = `(() => {
  const ed = [...document.querySelectorAll('.ProseMirror')].find((n) => n.offsetParent)
  const out = []
  for (const el of ed.children) {
    const tag = el.tagName.toLowerCase()
    if (/^h[1-6]$/.test(tag) || tag === 'p') {
      const own = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('')
      const text = (own || el.textContent.replace(/\\s+$/, '')).slice(0, 12)
      if (tag === 'p' && text === '') continue // the trailing placeholder
      out.push(tag + ':' + text)
    } else if (el.querySelector?.('table') || tag === 'table') {
      out.push('table') // Milkdown wraps the table widget in a div
    } else out.push(tag)
  }
  return out.join('|')
})()`

async function launch(root, file, port) {
  const app = await launchBuiltElectron({ profileDir: join(root, `profile-${port}`), port, appArgs: [file], kernelDefault: true })
  const { evaluate } = app
  await waitFor(() => evaluate(`(${VISIBLE_EDITOR})?.textContent?.length > 0`), 'mount')
  await waitFor(() => evaluate(`[...document.querySelectorAll('.hm-kernel-mode')].some((n) => n.offsetParent)`), 'kernel attach')
  await sleep(700)
  return app
}

// Click a block (p/h1..h6, including inside a blockquote) whose own text
// equals `text`, then Home/End.
const clickBlock = async (app, text, edge) => {
  const { evaluate, send } = app
  const rect = await waitFor(() => evaluate(`(() => {
    const t = [...((${VISIBLE_EDITOR})?.querySelectorAll('p, h1, h2, h3') || [])].find((n) => n.textContent === ${JSON.stringify(text)})
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

// Click a table cell's CENTRE (the working convention from
// test-table-click-edit-ui.mjs — an edge click lands on padding and produces
// no caret at all), verify the caret landed, then End.
const clickCell = async (app, cellText) => {
  const { evaluate, send } = app
  const rect = await waitFor(() => evaluate(`(() => {
    const cell = [...((${VISIBLE_EDITOR})?.querySelectorAll('td, th') || [])].find((n) => (n.textContent || '').trim() === ${JSON.stringify(cellText)})
    if (!cell) return null
    cell.scrollIntoView({ block: 'center' })
    const r = cell.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`), `cell ${cellText} missing`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect })
  await sleep(300)
  const landed = await evaluate(`(() => {
    const sel = getSelection()
    const node = sel?.anchorNode
    const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node
    return el?.closest?.('td, th')?.textContent?.trim() ?? null
  })()`)
  assert.equal(landed, cellText, `caret did not land in cell ${JSON.stringify(cellText)} (landed in ${JSON.stringify(landed)})`)
  await pressKey(send, { key: 'End', code: 'End' })
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
  const root = `/tmp/horsemd-feature-loop-${label}-${process.pid}`
  const file = join(root, 'doc.md')
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const FIXTURE = [
    '## 副题',
    '',
    '脚注引[^1] 尾',
    '',
    '| 子 | 丑 |',
    '| :--- | ---: |',
    '| 寅 | 卯 |',
    '',
    '> 1. 引列',
    '>',
    '> 引尾',
    '',
    '[^1]: 说明',
    ''
  ]
  await writeFile(file, FIXTURE.join(ending))

  // ---- cycle 1 ----
  let app = await launch(root, file, port)
  try {
    const { send } = app
    // heading demote: Backspace at the H2's content start deletes ONE '#'.
    await clickBlock(app, '副题', 'start')
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(500)
    // aligned-table body cell: typing must land inside the cell's own byte
    // span; the ':---'/'---:' delimiter row must not move by a byte.
    await clickCell(app, '卯')
    await typeTextLikeUser(send, '文', { delayMs: 50 })
    await sleep(400)
    // the quote paragraph AFTER the quote's list — the shape whose list-span
    // bookkeeping the provenSpanEnd/clampedNodeEnd round was about.
    await clickBlock(app, '引尾', 'end')
    await typeTextLikeUser(send, '巴', { delayMs: 50 })
    await sleep(400)
    await save(app)
    const saved1 = await readFile(file, 'utf8')
    const expected1 = [
      '# 副题', '', '脚注引[^1] 尾', '',
      '| 子 | 丑 |', '| :--- | ---: |', '| 寅 | 卯文 |', '',
      '> 1. 引列', '>', '> 引尾巴', '',
      '[^1]: 说明', ''
    ].join(ending)
    if (saved1 !== expected1) {
      console.error('  actual  :', JSON.stringify(saved1))
      console.error('  expected:', JSON.stringify(expected1))
    }
    assert.equal(saved1, expected1, `${label} cycle1: demote + aligned-cell + quote-tail land exactly`)
    await noBadDiag(app, `${label} cycle1`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: false })
  }

  // ---- cold reopen 1 + cycle 2 ----
  app = await launch(root, file, port + 1)
  try {
    const skeleton = await app.evaluate(SKELETON_JS)
    const expectedSkeleton = 'h1:副题|p:脚注引 尾|table|blockquote|dl'
    if (skeleton !== expectedSkeleton) {
      console.error('  actual  :', skeleton)
      console.error('  expected:', expectedSkeleton)
    }
    assert.equal(skeleton, expectedSkeleton, `${label} reopen1: the saved bytes render as h1/para/table/quote`)

    const { send } = app
    // second demote gesture: a content-bearing H1 loses its OPENING and
    // becomes a paragraph (the reparse-proved spelling).
    await clickBlock(app, '副题', 'start')
    await pressKey(send, { key: 'Backspace', code: 'Backspace' })
    await sleep(500)
    // typing into the quote's LIST item — the other side of the same
    // list-span bookkeeping shape.
    await clickBlock(app, '引列', 'end')
    await typeTextLikeUser(send, '顺', { delayMs: 50 })
    await sleep(400)
    await save(app)
    const saved2 = await readFile(file, 'utf8')
    const expected2 = [
      '副题', '', '脚注引[^1] 尾', '',
      '| 子 | 丑 |', '| :--- | ---: |', '| 寅 | 卯文 |', '',
      '> 1. 引列顺', '>', '> 引尾巴', '',
      '[^1]: 说明', ''
    ].join(ending)
    if (saved2 !== expected2) {
      console.error('  actual  :', JSON.stringify(saved2))
      console.error('  expected:', JSON.stringify(expected2))
    }
    assert.equal(saved2, expected2, `${label} cycle2: the H1->paragraph demote + quote-list typing land exactly`)
    await noBadDiag(app, `${label} cycle2`)
    if (ending === '\r\n') {
      assert.equal(/(?<!\r)\n/.test(saved2), false, 'a CRLF document must not gain a lone LF anywhere')
    }
  } finally {
    await stopBuiltElectron(app, { removeProfile: false })
  }

  // ---- cold reopen 2: final render ----
  app = await launch(root, file, port + 2)
  try {
    const skeleton = await app.evaluate(SKELETON_JS)
    const expectedSkeleton = 'p:副题|p:脚注引 尾|table|blockquote|dl'
    assert.equal(skeleton, expectedSkeleton, `${label} reopen2: the demoted heading renders as a paragraph (got ${JSON.stringify(skeleton)})`)
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
    await rm(root, { recursive: true, force: true })
  }
  console.log(`PASS kernel feature-loop ${label}`)
}

await runScenario({ ending: '\n', port: Number(process.env.CDP_PORT || 10306) })
await runScenario({ ending: '\r\n', port: Number(process.env.CDP_PORT || 10306) + 4 })
console.log('PASS kernel feature-loop: heading demote (H2->H1->paragraph), aligned-table cell typing, quote>list+sibling editing and a footnote document chained through two edit->save->cold-reopen cycles — bytes exact at every save, render exact at every reopen (LF + CRLF)')
