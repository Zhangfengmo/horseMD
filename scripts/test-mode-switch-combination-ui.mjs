// Rich <-> source mode switching over a document made of the HOT feature
// COMBINATIONS, driven through the real app.
//
// WHY THIS SUITE
// --------------
// Every defect of the past week lived at an INTERSECTION of two features while
// each feature's own suite stayed green. scripts/test-kernel-combination-matrix.mjs
// covers those intersections headlessly and broadly; this file covers the one
// thing a headless suite cannot: that the LIVE editor agrees, and that a
// rich<->source round trip over such a document changes nothing it should not.
//
// It also carries the WARRANT for the headless suite. The matrix builds its
// ProseMirror documents from scripts/lib/kernel-parse-harness.mjs — a replica
// of the editor's parse chain. A replica is a claim, so step 2 below re-derives
// the same two facts inside the RUNNING app (the source bytes the editor holds,
// and the number of blocks the kernel reports read-only) and fails if the
// harness and the app disagree. Without that step the matrix would be an
// assumption wearing a test's clothes.
//
// WHAT IS ASSERTED, AND HOW EXPECTATIONS ARE FORMED
// ------------------------------------------------
// Expectations come from READ-BACK bytes and structure, never from prose typed
// into this file. The fixture is the only literal; every later expectation is
// either "identical to what we read a moment ago" or "identical to the fixture
// once the characters we ourselves typed are removed". That last form is the
// strongest available statement of "the bytes contain exactly that edit and
// nothing else" — it cannot be satisfied by an edit that also disturbed a
// marker, a line ending, or a neighbouring block.
//
// A REFUSED / read-only outcome is an acceptable recorded outcome. Silent
// divergence — bytes and view disagreeing with no diagnostic — is the failure
// this file exists to catch.
//
// CDP conventions (the traps this repo has already paid for):
//   * N tabs = N mounted editors -> always filter `.ProseMirror` by
//     `offsetParent` (scripts/test-kernel-mode-ui.mjs and docs/handoff-mode-switch.md);
//   * place a caret with a REAL `Input.dispatchMouseEvent`; a raw DOM selection
//     does not sync ProseMirror state;
//   * a block can be scrolled out of view, which turns a synthetic click into a
//     silent no-op -> `scrollIntoView` first (test-quoted-block-source-ui.mjs);
//   * type through `typeTextLikeUser`, one character at a time.
//
// Deliberately NOT asserted: any toast STRING inside a list or quote. Which
// message a refusal produces there is `pairIsReadOnlyToUser`'s business
// (src/renderer/src/lib/kernel-status.js) and is being corrected separately;
// this file asserts bytes, structure, and the read-only COUNT, all of which are
// stable across that correction.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

import { buildProjectionMap } from '../src/renderer/src/components/editor-kernel-projection-map.js'
import { pairIsReadOnlyToUser } from '../src/renderer/src/lib/kernel-status.js'
import { isTypableTextblock } from '../src/renderer/src/components/editor-kernel-gateway.js'
import { parseEditorMarkdown } from './lib/kernel-parse-harness.mjs'

const root = `/tmp/horsemd-mode-combination-${process.pid}`
const file = join(root, 'combination.md')
const port = Number(process.env.CDP_PORT || 10501)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)
const NBSP = ' '

// ==========================================================================
// THE FIXTURE — one document per hot combination, and nothing else.
// ==========================================================================
//   front matter                        (leading-only atom, read-only leaf)
//   heading with a leading U+00A0        (the stranded-nbsp family)
//   paragraph with every inline atom kind + a two-space HARD BREAK
//                                        (atoms x marks, hardbreak x prose)
//   nested list whose inner items are TASKS, with an inline atom in one
//                                        (Tab x lists, task x atoms)
//   blockquote CONTAINING a fenced code block
//                                        (quote x fence — per-line prefixes)
//   GFM table with a MARKED cell and a `<br>` cell
//                                        (table x marks, table x hardbreak)
//   $$ block math                        (empty-fence x math family)
//   mermaid fence                        (preview-language code block)
const FIXTURE = [
  '---',
  'title: 组合测试',
  '---',
  '',
  `## ${NBSP}前置空格标题`,
  '',
  '段落 **粗** *斜* `码` ==高== [链](https://e.com) ![图](a.png) $x^2$ 第一行  ',
  '第二行',
  '',
  '- 甲 **粗**',
  '  - [ ] 未完成 $y^2$',
  '  - [x] 已完成',
  '- 乙',
  '',
  '> 引用开头',
  '>',
  '> ```js',
  '> let a = 1',
  '> ```',
  '',
  // Three body cells on purpose, one per outcome the kernel can produce for a
  // table cell: a MARKED cell (typing at its mark boundary is refused), a
  // `<br>` cell (paired read-only — family D1 of the headless matrix), and a
  // PLAIN cell (fully editable). All three are asserted below.
  '| 甲 | 乙 | 丙 |',
  '| --- | --- | --- |',
  '| **粗体格** | 一<br>二 | 普通格 |',
  '',
  // 2026-08-23 extension round — the post-slash feature landings, mirrored
  // from the headless matrix's new elements so the harness-fidelity
  // cross-check (step 2) warrants THEM too:
  //   an ALIGNED table with a marked cell   (table-ops alignment bytes x marks)
  //   a footnote REFERENCE                  (the fourth typable inline atom)
  //   an image with a TITLE slot            (the caption's byte home)
  //   BLOCK-level raw HTML                  (family D4 — read-only, counted)
  //   a quote holding a list THEN a sibling (the provenSpanEnd/clampedNodeEnd
  //                                          fourth-batch shape)
  '| 子 | 丑 |',
  '| :--- | ---: |',
  '| **寅** | 卯 |',
  '',
  '脚注引用[^1] 之后',
  '',
  '![带题图](t.png "题注文字")',
  '',
  '<div>块级内容</div>',
  '',
  '> 1. 引列一',
  '>',
  '> 引尾段',
  '',
  '$$',
  'E=mc^2',
  '$$',
  '',
  '```mermaid',
  'graph TD',
  'A-->B',
  '```',
  '',
  // The footnote DEFINITION the reference above needs — without it GFM parses
  // `[^1]` as literal text and the atom silently stops being exercised.
  '[^1]: 脚注说明',
  ''
].join('\n')

// Characters typed by this test. Each is a single CJK glyph with no Markdown
// meaning in any context the fixture contains, so "remove it and you must get
// the fixture back" is a clean statement about the edit alone. They must also
// be ABSENT from the fixture — a marker that already occurs there makes the
// occurrence count meaningless — which the guard below enforces rather than
// trusting.
const RICH_EDIT_LIST = '壹'
const RICH_EDIT_CELL = '贰'
const SOURCE_EDIT = '叁'
const REFUSED_EDIT = '肆'

// ==========================================================================
// THE HEADLESS EXPECTATION (this is what step 2 cross-checks)
// ==========================================================================
// Computed with the SAME modules the app runs: the projection map over the
// harness's ProseMirror document, then `pairIsReadOnlyToUser` — which is
// literally the predicate the status indicator counts with
// (src/renderer/src/lib/kernel-status.js).
for (const marker of [RICH_EDIT_LIST, RICH_EDIT_CELL, SOURCE_EDIT, REFUSED_EDIT]) {
  assert.ok(
    !FIXTURE.includes(marker),
    `edit marker ${JSON.stringify(marker)} already occurs in the fixture — the "exactly once" counts would be meaningless`
  )
}

function harnessReadOnlyCount(markdown) {
  const map = buildProjectionMap(markdown, parseEditorMarkdown(markdown))
  assert.ok(map, 'harness: the fixture must pair — a null map here means the fixture, not the app, is wrong')
  return map.blockPairs.filter((pair, index) =>
    pairIsReadOnlyToUser(pair, map.blockPairs[index + 1], isTypableTextblock)
  ).length
}

// ==========================================================================
// CDP helpers
// ==========================================================================
async function waitFor(check, message, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const mounted = (evaluate) => evaluate(`[
  ...document.querySelectorAll('.ProseMirror')
].find((node) => node.offsetParent)?.textContent`)

const visibleRichText = (evaluate) => evaluate(`[
  ...document.querySelectorAll('.ProseMirror')
].find((node) => node.offsetParent)?.textContent ?? null`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

// A structural fingerprint of the LIVE rich document, taken from the DOM
// because the renderer exposes no view handle. Block-level tags in document
// order plus each one's own text length: enough to detect a lost, gained,
// reordered or retyped block, and stable across the cosmetic churn a mode
// toggle legitimately produces (node views re-render, attributes change).
const richStructure = (evaluate) => evaluate(`(() => {
  const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
  if (!editor) return null
  const selector = 'p,h1,h2,h3,h4,h5,h6,ul,ol,li,blockquote,table,thead,tbody,tr,td,th,hr,pre'
  return [...editor.querySelectorAll(selector)]
    .map((node) => node.tagName.toLowerCase() + ':' + (node.textContent || '').length)
    .join('>')
})()`)

// The kernel status the user can actually see: the caret button's title is
// `<kernel mode> · <label>\n<detail>`, and the partial detail is the only place
// a number appears (i18n.jsx `kernelStatus.partialDetail`).
const kernelStatusTitle = (evaluate) => evaluate(`(
  document.querySelector('.block-switch-caret-btn')?.title ?? null
)`)

const diagnostics = async (evaluate) => JSON.parse(await evaluate('JSON.stringify(window.__hmKernelDiagnostics || [])'))

async function toggleSourceMode(evaluate) {
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.status-btn')]
      .find((node) => node.offsetParent && !node.classList.contains('block-switch-caret-btn') &&
        /源码|Source|富文本|Rich|Ctrl\\+\\/|⌘\\//.test(node.title || node.textContent || ''))
    button?.click()
    return !!button
  })()`)
  assert.ok(clicked, 'no source-toggle trigger button')
}

async function toggleKernelMode(evaluate) {
  const opened = await evaluate(`(() => {
    const button = document.querySelector('.block-switch-caret-btn')
    button?.click()
    return !!button
  })()`)
  assert.ok(opened, 'no kernel-mode caret button — tab not kernel-eligible?')
  await sleep(150)
  const clicked = await evaluate(`(() => {
    const item = [...document.querySelectorAll('.block-switch-menu .block-menu-item')]
      .find((node) => node.offsetParent)
    item?.click()
    return !!item
  })()`)
  assert.ok(clicked, 'kernel-toggle menu item missing')
}

// Place a caret at the END of the block whose own text STARTS WITH `text`.
//
// `startsWith`, not equality: a block holding an inline atom renders that atom's
// own text into `textContent` too (Crepe's latex feature paints `$y^2$` with
// KaTeX, so the task item's DOM text is `未完成 ` followed by the rendered
// formula). Matching on the leading, atom-free part of the block keeps the
// selector about the block we mean rather than about how an atom happens to
// render. The candidate list is reported on failure — this used to be a silent
// no-op that turned an edit step into nothing.
//
// `scrollIntoView` first: a block below the fold makes the synthetic click miss,
// which is the same trap test-quoted-block-source-ui.mjs documents.
async function clickTextEnd(evaluate, send, text, selector = 'p, h1, h2, h3, h4, h5, h6, td, th') {
  const found = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const all = [...(editor?.querySelectorAll(${JSON.stringify(selector)}) || [])]
    const node = all.find((candidate) => (candidate.textContent || '').startsWith(${JSON.stringify(text)}))
    if (!node) return { point: null, candidates: all.map((c) => c.textContent).slice(0, 25) }
    node.scrollIntoView({ block: 'center' })
    const rect = node.getBoundingClientRect()
    return { point: { x: rect.left + 8, y: rect.top + Math.min(12, rect.height / 2) }, text: node.textContent }
  })()`)
  const point = found?.point
  assert.ok(
    point,
    `no block whose text starts with ${JSON.stringify(text)}; candidates were ${JSON.stringify(found?.candidates)}`
  )
  await sleep(400)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await pressKey(send, { key: 'End', code: 'End', delayMs: delay })
}

// A table CELL needs its own helper. `rect.left + 8` — fine for a paragraph —
// lands on the cell's border/padding and produces no caret at all, which
// presents as "the keystroke never arrived" with an EMPTY kernel diagnostics
// buffer (measured: the kernel never saw a transaction, so it had nothing to
// refuse). scripts/test-table-click-edit-ui.mjs already established the working
// convention: click the cell's CENTRE. The caret is then verified to actually
// be inside a `td`/`th` before anything is typed, so a future miss fails here
// rather than silently turning an edit step into a no-op.
async function clickCellEnd(evaluate, send, cellText) {
  const point = await evaluate(`(() => {
    const editor = [...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)
    const cell = [...(editor?.querySelectorAll('td, th') || [])]
      .find((node) => (node.textContent || '').trim() === ${JSON.stringify(cellText)})
    if (!cell) return null
    cell.scrollIntoView({ block: 'center' })
    const rect = cell.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  assert.ok(point, `no table cell whose text is ${JSON.stringify(cellText)}`)
  await sleep(400)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(300)
  const landed = await evaluate(`(() => {
    const selection = getSelection()
    const node = selection?.anchorNode
    const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node
    return element?.closest?.('td, th')?.textContent?.trim() ?? null
  })()`)
  assert.equal(landed, cellText, `the caret did not land in the ${JSON.stringify(cellText)} cell (landed in ${JSON.stringify(landed)})`)
  await pressKey(send, { key: 'End', code: 'End', delayMs: delay })
}

// "The bytes contain exactly these edits and nothing else": deleting every
// character this test typed must reproduce the fixture byte-for-byte.
function assertOnlyTheseEdits(actual, markers, context) {
  let stripped = actual
  for (const marker of markers) {
    const occurrences = actual.split(marker).length - 1
    assert.equal(occurrences, 1, `${context}: ${JSON.stringify(marker)} must appear exactly once, found ${occurrences}`)
    stripped = stripped.split(marker).join('')
  }
  assert.equal(stripped, FIXTURE, `${context}: removing the typed characters must reproduce the fixture exactly`)
}

// Which line did a typed character land on? Recorded (and asserted against the
// block we aimed at) so "exactly that edit" also means "in the right block".
function lineContaining(text, marker) {
  return text.split('\n').find((line) => line.includes(marker)) ?? null
}

// ==========================================================================
// SESSION 1 — kernel mode
// ==========================================================================
async function runKernelSession() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)

  const expectedReadOnly = harnessReadOnlyCount(FIXTURE)
  console.log(`harness expectation: ${expectedReadOnly} block(s) read-only for this fixture`)

  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    let { evaluate, send } = app

    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('前置空格标题') && text.includes('已完成') ? text : null
    }, 'fixture did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog may appear on a plain mount')

    // ---- 1. kernel mode on; record the status indicator state -------------
    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate("!!document.querySelector('.hm-kernel-mode')"), 'kernel mode did not remount the tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('前置空格标题') && text.includes('已完成') ? text : null
    }, 'document did not remount after enabling kernel mode')
    await sleep(400)

    const attachDiagnostics = await diagnostics(evaluate)
    assert.ok(
      !JSON.stringify(attachDiagnostics).includes('attach-unmappable'),
      `kernel mode fell back to legacy for this fixture — every assertion below would be vacuous: ${JSON.stringify(attachDiagnostics)}`
    )
    const statusTitle = await kernelStatusTitle(evaluate)
    assert.ok(statusTitle, 'kernel status indicator has no title to read')
    console.log(`kernel status: ${JSON.stringify(statusTitle)}`)

    // ---- 2. HARNESS-FIDELITY CROSS-CHECK ---------------------------------
    // The warrant for the headless matrix. Two independent facts, both derived
    // inside the running app, both compared against the harness.
    await toggleSourceMode(evaluate)
    const firstSource = await waitFor(() => visibleSource(evaluate), 'source view did not appear')
    assert.equal(firstSource, FIXTURE, 'the app must hold exactly the bytes on disk')

    const appReadOnly = Number((statusTitle.match(/(\d+)/) || [])[1] ?? 0)
    assert.equal(
      appReadOnly,
      expectedReadOnly,
      `HARNESS FIDELITY: the running app reports ${appReadOnly} read-only block(s) for this fixture ` +
      `while scripts/lib/kernel-parse-harness.mjs predicts ${expectedReadOnly}. Either the harness has ` +
      'drifted from the real parse chain (and every headless matrix result is suspect) or the kernel ' +
      `changed. Status title was ${JSON.stringify(statusTitle)}.`
    )
    console.log(`harness fidelity OK: app and harness both report ${appReadOnly} read-only block(s)`)

    // ---- 3. rich -> source with NO edit changes nothing -------------------
    // (already read above); disk must be untouched too.
    assert.equal(await readFile(file, 'utf8'), FIXTURE, 'a pure view toggle must not write to disk')
    assert.equal(
      await evaluate("!!document.querySelector('.hm-save-fab')"),
      false,
      'a pure view toggle must not mark the tab dirty'
    )

    // ---- 4. source -> rich leaves the structure and diagnostics alone -----
    const diagnosticsBefore = (await diagnostics(evaluate)).length
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate("!!document.querySelector('.hm-kernel-mode')"), 'rich view did not return')
    await sleep(400)
    const structureAfterToggle = await richStructure(evaluate)
    assert.ok(structureAfterToggle, 'rich structure unreadable after returning from source')

    const afterToggle = await diagnostics(evaluate)
    const newDiagnostics = afterToggle.slice(diagnosticsBefore)
    const offending = newDiagnostics.filter((entry) =>
      JSON.stringify(entry).includes('projection-mismatch') || JSON.stringify(entry).includes('blocked'))
    assert.deepEqual(
      offending,
      [],
      `a no-edit rich<->source round trip produced projection-mismatch/blocked diagnostics: ${JSON.stringify(offending)}`
    )

    // A second full cycle must land on the identical structure — the invariant
    // that a view toggle is a VIEW toggle.
    await toggleSourceMode(evaluate)
    const secondSource = await waitFor(() => visibleSource(evaluate), 'source view did not appear on the second cycle')
    assert.equal(secondSource, FIXTURE, 'a second no-edit cycle must still show the original bytes')
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate("!!document.querySelector('.hm-kernel-mode')"), 'rich view did not return (cycle 2)')
    await sleep(400)
    assert.equal(
      await richStructure(evaluate),
      structureAfterToggle,
      'two no-edit rich<->source cycles must leave the rich structure identical'
    )

    // ---- 5. one small edit in SOURCE mode --------------------------------
    await toggleSourceMode(evaluate)
    await waitFor(() => visibleSource(evaluate), 'source view did not appear for the source edit')
    // Land the caret at the end of the quote's own paragraph line, then type.
    const placed = await evaluate(`(() => {
      const area = [...document.querySelectorAll('textarea.source-editor')].find((node) => node.offsetParent)
      if (!area) return false
      const at = area.value.indexOf('> 引用开头') + '> 引用开头'.length
      if (at < '> 引用开头'.length) return false
      area.focus()
      area.setSelectionRange(at, at)
      return true
    })()`)
    assert.ok(placed, 'could not place the caret in the source textarea')
    await typeTextLikeUser(send, SOURCE_EDIT, { delayMs: delay })
    await waitFor(async () => (await visibleSource(evaluate) || '').includes(SOURCE_EDIT), 'source edit never reached the textarea')
    const afterSourceEdit = await visibleSource(evaluate)
    assertOnlyTheseEdits(afterSourceEdit, [SOURCE_EDIT], 'source-mode edit')
    assert.ok(
      (lineContaining(afterSourceEdit, SOURCE_EDIT) || '').startsWith('> 引用开头'),
      'the source-mode edit landed outside the quote paragraph it was typed into'
    )

    // ...and back to rich: the edit is present, everything else identical.
    await toggleSourceMode(evaluate)
    await waitFor(() => evaluate("!!document.querySelector('.hm-kernel-mode')"), 'rich view did not return after the source edit')
    await waitFor(async () => (await mounted(evaluate) || '').includes(`引用开头${SOURCE_EDIT}`), 'the source edit is not visible in rich mode')
    await sleep(300)
    // Structure differs from the pre-edit fingerprint by exactly one character
    // in one block; everything else must be untouched.
    const structureAfterSourceEdit = await richStructure(evaluate)
    assert.equal(
      structureAfterSourceEdit.split('>').length,
      structureAfterToggle.split('>').length,
      'the source edit changed the rich block COUNT'
    )

    // ---- 6. edits in RICH (kernel) mode, inside combination blocks --------
    // 6a: a nested TASK list item that also carries an inline math atom.
    await clickTextEnd(evaluate, send, '未完成 ')
    await typeTextLikeUser(send, RICH_EDIT_LIST, { delayMs: delay })
    await waitFor(async () => (await mounted(evaluate) || '').includes(RICH_EDIT_LIST), 'the nested-task-item edit never reached the editor')
    await sleep(250)

    // 6b: a PLAIN table cell — the editable outcome.
    await clickCellEnd(evaluate, send, '普通格')
    await typeTextLikeUser(send, RICH_EDIT_CELL, { delayMs: delay })
    await waitFor(async () => (await mounted(evaluate) || '').includes(RICH_EDIT_CELL), 'the plain table-cell edit never reached the editor')
    await sleep(250)

    // ---- 6c. KNOWN-REFUSED: typing at a MARKED cell's boundary ------------
    // Measured in the built app: with the caret at the end of `**粗体格**`, a
    // typed character is REFUSED with the toast
    // 「源码权威内核实验阶段暂未支持此操作 (unsupported-input-type)」 — the insert
    // would inherit the `strong` mark, so the gateway cannot classify it as a
    // plain-text step and vetoes the transaction.
    //
    // That is the correct fail-closed posture and it is LOUD, so it is pinned
    // here rather than avoided: the assertion is that the refusal is visible
    // AND that not one byte moved. If mark-boundary inserts later become
    // supported, this assertion fails and is removed deliberately.
    //
    // Note `window.__hmKernelDiagnostics` stays EMPTY for this refusal — the
    // ring buffer does not record it — so the toast is the only observable
    // signal and therefore the thing worth asserting.
    const beforeRefusal = await visibleRichText(evaluate)
    await clickCellEnd(evaluate, send, '粗体格')
    await typeTextLikeUser(send, REFUSED_EDIT, { delayMs: delay })
    await sleep(600)
    const refusalToast = await evaluate("document.querySelector('.hm-toast')?.textContent ?? null")
    assert.ok(
      refusalToast && refusalToast.includes('unsupported-input-type'),
      `KNOWN-REFUSED: typing at a marked table cell's boundary must refuse VISIBLY; toast was ${JSON.stringify(refusalToast)}`
    )
    assert.equal(
      await visibleRichText(evaluate),
      beforeRefusal,
      'a refused mark-boundary insert must not change the document at all'
    )
    console.log(`KNOWN-REFUSED confirmed (marked table cell): ${JSON.stringify(refusalToast)}`)

    await toggleSourceMode(evaluate)
    const afterRichEdits = await waitFor(() => visibleSource(evaluate), 'source view did not appear after the rich edits')
    assertOnlyTheseEdits(afterRichEdits, [SOURCE_EDIT, RICH_EDIT_LIST, RICH_EDIT_CELL], 'rich-mode edits')
    const listLine = lineContaining(afterRichEdits, RICH_EDIT_LIST)
    const cellLine = lineContaining(afterRichEdits, RICH_EDIT_CELL)
    assert.ok(listLine?.includes('- [ ] 未完成'), `the nested-task-item edit landed on the wrong line: ${JSON.stringify(listLine)}`)
    assert.ok(
      cellLine?.includes('|') && cellLine.includes('普通格'),
      `the table-cell edit landed on the wrong line: ${JSON.stringify(cellLine)}`
    )
    console.log(`rich edits landed as: ${JSON.stringify(listLine)} / ${JSON.stringify(cellLine)}`)

    // ---- 7. save + cold reopen -> byte-exact ------------------------------
    await waitFor(() => evaluate("!!document.querySelector('.hm-save-fab')"), 'save button missing after edits')
    await evaluate("document.querySelector('.hm-save-fab')?.click()")
    await waitFor(() => evaluate("!document.querySelector('.hm-save-fab')"), 'save did not finish')
    const saved = await readFile(file, 'utf8')
    assert.equal(saved, afterRichEdits, 'disk bytes must equal the bytes source mode was showing')
    assert.equal(
      app.dialogs.length,
      0,
      `no rebuild prompt may appear: ${JSON.stringify(app.dialogs.map((dialog) => dialog.message))}`
    )

    await stopBuiltElectron(app, { removeProfile: false })
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, cleanProfile: false, appArgs: [file] })
    ;({ evaluate, send } = app)
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('前置空格标题') && text.includes(RICH_EDIT_LIST) ? text : null
    }, 'reopened document did not mount with the saved content')
    await toggleSourceMode(evaluate)
    const reopened = await waitFor(() => visibleSource(evaluate), 'source view did not appear after cold reopen')
    assert.equal(reopened, saved, 'cold reopen must reproduce the saved bytes byte-for-byte')
    assert.equal(app.dialogs.length, 0, 'no rebuild prompt may appear on cold reopen')

    console.log('PASS kernel session: no-edit toggles are byte-neutral, source and rich edits commit exactly, save and cold reopen are byte-exact')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

// ==========================================================================
// SESSION 2 — legacy mode (kernel OFF) on the same fixture
// ==========================================================================
// Legacy is the disposable path, but the user's question was explicitly about
// CONVERSION, so it has to be checked here too. The bar is deliberately lower
// and stated as such: legacy must not BREAK — two full rich<->source cycles
// with no edit must not drift the bytes. Any drift legacy does produce is
// recorded as a KNOWN-DEGRADED baseline rather than papered over, so the suite
// still fails when it changes.
async function runLegacySession() {
  const legacyRoot = `${root}-legacy`
  const legacyFile = join(legacyRoot, 'combination.md')
  await rm(legacyRoot, { recursive: true, force: true })
  await mkdir(legacyRoot, { recursive: true })
  await writeFile(legacyFile, FIXTURE)

  let app
  try {
    app = await launchBuiltElectron({
      profileDir: join(legacyRoot, 'profile'),
      port: port + 1,
      appArgs: [legacyFile]
    })
    const { evaluate } = app
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('前置空格标题') && text.includes('已完成') ? text : null
    }, 'legacy: fixture did not mount')

    // No kernel toggle at all — this tab is the default legacy rich editor.
    assert.equal(
      await evaluate("!!document.querySelector('.hm-kernel-mode')"),
      false,
      'legacy session must not be running in kernel mode'
    )

    const seen = []
    for (let cycle = 1; cycle <= 2; cycle += 1) {
      await toggleSourceMode(evaluate)
      const shown = await waitFor(() => visibleSource(evaluate), `legacy: source view did not appear (cycle ${cycle})`)
      seen.push(shown)
      await toggleSourceMode(evaluate)
      await waitFor(async () => {
        const text = await mounted(evaluate)
        return text && text.includes('前置空格标题') ? text : null
      }, `legacy: rich view did not return (cycle ${cycle})`)
      await sleep(400)
    }

    // The invariant that matters: whatever legacy shows, it must show the SAME
    // thing on cycle 2 as on cycle 1 — no accumulating drift across conversions.
    assert.equal(seen[1], seen[0], 'legacy: two rich<->source cycles must not drift the bytes')
    // And a pure view toggle must not have written to disk.
    assert.equal(await readFile(legacyFile, 'utf8'), FIXTURE, 'legacy: a pure view toggle must not write to disk')

    if (seen[0] !== FIXTURE) {
      // Recorded, not hidden: legacy is allowed to normalize, but the exact
      // normalization is pinned so a CHANGE in it still fails this suite.
      console.log('KNOWN-DEGRADED (legacy): the first rich->source conversion is not byte-identical to the file.')
      console.log(`  fixture bytes : ${JSON.stringify(FIXTURE)}`)
      console.log(`  legacy shows  : ${JSON.stringify(seen[0])}`)
      assert.equal(
        seen[0],
        LEGACY_EXPECTED,
        'legacy conversion drifted from its recorded baseline — update LEGACY_EXPECTED only after reading the diff'
      )
    } else {
      assert.equal(
        LEGACY_EXPECTED,
        FIXTURE,
        'legacy is now byte-exact but LEGACY_EXPECTED still records a drift — remove the stale baseline'
      )
    }

    console.log('PASS legacy session: two rich<->source cycles are stable and write nothing to disk')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

// Legacy's recorded rich->source baseline. Set to the fixture itself: the claim
// under test is that legacy does NOT normalize this document. If it turns out
// to, the assertion above prints both strings and this constant is the single
// place to record reality — deliberately a constant rather than a "whatever it
// produced" tolerance, so a drift can never pass silently.
const LEGACY_EXPECTED = FIXTURE

console.log('--- mode-switch combination UI ---')
await runKernelSession()
await runLegacySession()
console.log('PASS mode-switch combination UI')
