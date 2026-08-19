// CRLF code-block fidelity regression (ai-handoff §5.2e) — the LEGACY
// editor (stages A–E) AND the experimental source kernel (stage K).
//
// The vendored @milkdown/components CodeMirrorBlock node view does its
// CM↔PM position math with CodeMirror 6's INTERNAL coordinates. CM6's Text
// model splits on /\r\n?|\n/ and never stores the '\r' byte, so for a
// fenced code block whose ProseMirror text uses '\r\n' line endings every
// CM position past the first line break is short by N (N = number of
// preceding CRLF breaks) versus the true PM offset:
//
//  - CM→PM (`forwardUpdate`): CM changeset coordinates are applied
//    DIRECTLY as PM offsets (`offset + fromA`), so a character typed on
//    line 2+ lands N chars early in the PM doc (splitting '\r\n' pairs),
//    a Backspace line-join deletes only the '\r' and leaves a stray bare
//    '\n', and inserted breaks arrive as bare '\n' (CM Text.toString()
//    joins with '\n') — mixed endings inside a uniform-CRLF file.
//  - PM→CM (`update(node)`): `computeChange` diffs CM's LF-only string
//    against the CRLF PM string, ALWAYS finds a bogus mid-doc diff, and
//    dispatches insert text that still contains '\r\n' + a trailing lone
//    '\r' — which CM's splitter turns into TWO breaks, so every update()
//    call grows the visible CodeMirror doc by a phantom blank line and the
//    two models never converge.
//
// This script drives the REAL app in the DEFAULT legacy editor (no kernel
// toggle anywhere): a uniformly-CRLF file with a js fence gets (1) text
// typed at the end of a line 2+ deep in the block, (2) an Enter +
// next-line type (the inserted break must come out '\r\n', not bare
// '\n'), (3) a within-line Backspace x2, (4) a caret-at-line-start
// Backspace joining two lines (the deleted break must be the FULL '\r\n'
// pair, not just the '\r'), (5) a second Enter + line whose inserted
// '\r\n' must survive to disk, and (6) a plain PROSE edit at the LEADING
// paragraph's line end — the ai-handoff §5.2f symptom shape, which involves
// no code block at all and exercises the canonical-diff preservation mapper
// instead of this module's CM↔PM subject. After each stage the source view
// must show the exact content (LF projection — see assertSource), then Save
// must write the EXPECTED_DISK bytes (uniform CRLF — structure and code
// value alike; see its note) and a full-quit cold reopen must reproduce
// them. The CodeMirror view is also asserted phantom-blank-line-free after
// the edits (the update() churn shape above).
//
// Edit-site conventions copied from test-kernel-codeblock-ui.mjs: all
// multi-line edits land at nesting depth 0 (end of the '}' line) so CM's
// language-aware auto-indent cannot add unpredictable whitespace, and no
// typed text contains bracket/quote characters (closeBrackets ships in
// Crepe's CodeMirror basicSetup).
//
// STAGE K (CRLF un-narrowing, 2026-08-17) lives here, not in
// test-kernel-codeblock-ui.mjs, because CRLF is THIS script's subject: the
// fixture, the LF-projection source assertion, the uniform-CRLF disk
// expectation and the "no lone '\r' / no bare '\n'" property assertions all
// already exist here, so proving the same document under the kernel costs a
// stage instead of a duplicated second document. It is also where the
// contrast is visible in one file: the legacy stages document what the
// preservation pipeline guarantees, stage K documents the STRICTER,
// byte-exact guarantee the source kernel gives on the same bytes.
// Kernel mode used to force every CRLF code block non-editable (Plan 3 Task 4
// fix-review ADR); with editor-codeblock-crlf.js fixing the CM bridge at its
// source, the projection map no longer gates on `lineEnding` and the gateway
// commits the bridge's already-'\r\n'-spelled breaks verbatim (adding only a
// per-line prefix, never re-spelling — re-spelling would emit a lone '\r').
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'

const root = `/tmp/horsemd-codeblock-crlf-${process.pid}`
const file = join(root, 'crlf-codeblock.md')
const port = Number(process.env.CDP_PORT || 10026)
const delay = Number(process.env.CRLF_KEY_DELAY || 60)

const CRLF = '\r\n'

const FIXTURE = [
  '# CRLF 代码块测试',
  '',
  '前置段落用于占位。',
  '',
  '```js',
  'function greet(name) {',
  '  return name;',
  '}',
  '```',
  '',
  '尾段落用于占位。',
  ''
].join(CRLF)

// Stage A: caret at the end of the '}' line (line 3 of the block — two
// CRLF breaks precede it inside the code text), type TAIL, press Enter,
// type NEXTLINE. Correct behavior: TAIL lands after '}', the new break is
// a '\r\n' pair, endings stay uniform.
const AFTER_TYPE = [
  '# CRLF 代码块测试',
  '',
  '前置段落用于占位。',
  '',
  '```js',
  'function greet(name) {',
  '  return name;',
  '}TAIL',
  'NEXTLINE',
  '```',
  '',
  '尾段落用于占位。',
  ''
].join(CRLF)

// Stage B: Backspace x2 at the end of NEXTLINE — a within-line delete on
// a line preceded by three CRLF breaks.
const AFTER_BACKSPACE = AFTER_TYPE.replace('NEXTLINE', 'NEXTLI')

// Stage C: caret at the START of 'NEXTLI', one Backspace — the line join.
// The deleted CM character is one line break; the PM bytes removed must be
// the FULL '\r\n' pair (the historical corruption deleted only the '\r',
// leaving '}TAIL\nNEXTLI' — a bare LF inside a CRLF file).
const AFTER_JOIN = AFTER_BACKSPACE.replace(`}TAIL${CRLF}NEXTLI`, '}TAILNEXTLI')

// Stage D: Enter at the end of the joined line + LASTLINE — an inserted
// break that SURVIVES to disk, proving the CM '\n' → dominant-'\r\n'
// conversion end to end (stage A's inserted break is consumed by stage C).
const AFTER_LASTLINE = AFTER_JOIN.replace('}TAILNEXTLI', `}TAILNEXTLI${CRLF}LASTLINE`)

// Stage E: the ORIGINAL §5.2f symptom shape — a plain PROSE edit at a
// paragraph's line end, no code block involved. This is the delta that made
// the preservation mapper return `preserved:true` with a split pair
// ('前置段落用于占位。\rPARA\n'); the real commit gate (verifySourceDocument's
// reparsed-ProseMirror comparison) refused it and the fail-closed rebuild
// respelled the WHOLE file's structural endings to LF. Locking it here proves
// the user-visible fix through the production pipeline, not just against the
// headless oracle.
//
// It MUST be the LEADING paragraph, not the trailing one: an edit at the end
// of the document's LAST block is claimed by preserveDivergedTailBlockAppend,
// which was always CRLF-correct, so a trailing-paragraph stage passes even on
// the unfixed mapper and locks nothing. Verified by reverting core.js alone.
const AFTER_PARAGRAPH = AFTER_LASTLINE.replace('前置段落用于占位。', '前置段落用于占位。PARA')

// What the DEFAULT pipeline writes to disk: UNIFORM CRLF, byte-identical to
// the staged source. Two independent layers have to be right for this to hold.
// (1) The CM↔PM fix in this module's subject keeps the code VALUE coherent
// (authored '\r\n' pairs intact, the inserted break spelled '\r\n', every char
// at its true position). (2) The canonical-diff preservation mapper keeps the
// STRUCTURAL line endings (heading/paragraph/fence lines): it used to map an
// LF-canonical line end onto the '\n' of the source's CRLF pair, splitting it
// ('前置段落用于占位。\rPARA\n' with preserved:true). The real commit gate —
// verifySourceDocument's reparsed-ProseMirror comparison in
// editor-source-verification.js, NOT the roundtrip.js test oracle — refused
// that wrong success, so the commit fell back to the canonical serialization
// and respelled the whole file's structure to LF. The mapper arithmetic is
// fixed, so a lone '\r' or a bare '\n' anywhere in this file is a real
// regression, not a known gap.
const EXPECTED_DISK = AFTER_PARAGRAPH

// Stage K: the SAME document, now under the experimental source kernel.
// Caret at the end of the block's last line ('LASTLINE'), type KTAIL, Enter,
// type KNEXT. Under the kernel every one of those keystrokes is a raw-byte
// commit through commitPlainText — so the inserted break must reach disk as
// '\r\n' with no repair reconcile in between (`projection-mismatch` was the
// P3-4 churn symptom and must stay at zero).
const AFTER_KERNEL = AFTER_PARAGRAPH.replace('LASTLINE', `LASTLINEKTAIL${CRLF}KNEXT`)

async function waitFor(check, message, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(message)
}

const VISIBLE_EDITOR = `[...document.querySelectorAll('.ProseMirror')].find((node) => node.offsetParent)`

const mounted = (evaluate) => evaluate(`(${VISIBLE_EDITOR})?.textContent`)

const visibleSource = (evaluate) => evaluate(`(
  [...document.querySelectorAll('textarea.source-editor')]
    .find((node) => node.offsetParent)?.value ?? null
)`)

// Same split-button convention every source-mode UI script documents: the
// plain `.status-btn` (never the kernel caret button) toggles rich/source.
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

const BLOCK = `(${VISIBLE_EDITOR})?.querySelector('.milkdown-code-block')`

const cmContent = (evaluate) => evaluate(`(${BLOCK})?.querySelector('.cm-content')?.textContent`)

const cmLineTexts = (evaluate) => evaluate(
  `JSON.stringify([...((${BLOCK})?.querySelectorAll('.cm-editor .cm-line') || [])].map((line) => line.textContent))`
)

// Click into a PROSE paragraph (not CodeMirror) whose text contains `needle`,
// then End to land the caret at that line's end. A raw DOM selection does not
// sync ProseMirror state, so this must be a real dispatched mouse event.
async function clickProseParagraph(evaluate, send, needle) {
  const point = await evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const target = [...(editor?.querySelectorAll('p') || [])]
      .find((node) => node.textContent.includes(${JSON.stringify(needle)}))
    if (!target) return null
    target.scrollIntoView({ block: 'center' })
    const rect = target.getBoundingClientRect()
    if (!rect || !rect.width) return null
    return { x: rect.right - 4, y: rect.top + rect.height / 2 }
  })()`)
  assert.ok(point, `prose paragraph containing ${needle} is not hit-testable`)
  await sleep(400)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(200)
  await pressKey(send, { key: 'End', code: 'End', delayMs: delay })
}

// Click into the js block's CodeMirror at a line edge, then land the caret
// exactly via Home/End — same off-screen-click guard as the kernel script.
async function clickCmLine(evaluate, send, { line, edge }) {
  const point = await evaluate(`(() => {
    const block = ${BLOCK}
    if (!block) return null
    block.scrollIntoView({ block: 'center' })
    const lines = [...block.querySelectorAll('.cm-editor .cm-line')]
    const target = lines[${line}]
    const rect = target?.getBoundingClientRect()
    if (!rect || !rect.width) return null
    return ${edge === 'start'
      ? '{ x: rect.left + 2, y: rect.top + rect.height / 2 }'
      : '{ x: rect.right - 2, y: rect.top + rect.height / 2 }'}
  })()`)
  assert.ok(point, `CodeMirror line ${line} is not hit-testable`)
  await sleep(400)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(200)
  await pressKey(send, {
    key: edge === 'start' ? 'Home' : 'End',
    code: edge === 'start' ? 'Home' : 'End',
    delayMs: delay
  })
}

// The source textarea can never DISPLAY '\r': the HTML textarea value getter
// API-normalizes CRLF to LF (which is why source-text-fidelity.js re-applies
// the author's line-ending spelling on write — ai-handoff §source rules). So
// the visible-source assertion compares the LF-normalized projection; the
// byte-exact CRLF proof lives in the disk assertions below. A stray lone
// '\r' WOULD still surface here (normalization maps it to '\n', which would
// show up as an unexpected extra line), and a stray bare '\n' shifts every
// following line — so this projection still pins the corruption shapes.
// Stage K only: the kernel toggle lives behind the StatusBar's split-button
// caret (same convention every kernel-mode UI script uses).
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

async function assertSource(evaluate, expected, label) {
  await toggleSourceMode(evaluate)
  const shown = await waitFor(() => visibleSource(evaluate), `source view did not appear (${label})`)
  assert.equal(shown, expected.replace(/\r\n/g, '\n'),
    `${label}: visible source (LF projection) must match exactly`)
  await toggleSourceMode(evaluate)
  await waitFor(async () => {
    const text = await mounted(evaluate)
    return text && text.includes('前置段落') ? text : null
  }, `rich view did not return (${label})`)
  await sleep(200)
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  await writeFile(file, FIXTURE)
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, appArgs: [file] })
    let { evaluate, send } = app

    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('前置段落') && text.includes('尾段落') ? text : null
    }, 'initial document did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on plain mount')
    await waitFor(() => evaluate(`!!(${BLOCK})?.querySelector('.cm-editor')`), 'code block CodeMirror did not mount')

    // ---- Stage A: type at the end of block line 3, Enter, next line ----
    await clickCmLine(evaluate, send, { line: 2, edge: 'end' })
    await typeTextLikeUser(send, 'TAIL', { delayMs: delay })
    await waitFor(async () => ((await cmContent(evaluate)) || '').includes('TAIL'),
      'TAIL never landed in the CodeMirror editor')
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await typeTextLikeUser(send, 'NEXTLINE', { delayMs: delay })
    await waitFor(async () => ((await cmContent(evaluate)) || '').includes('NEXTLINE'),
      'NEXTLINE never landed in the CodeMirror editor')
    await sleep(300)

    // The PM→CM update() churn shape: every node update used to add a
    // phantom blank line to the CM view. After this edit burst the block
    // must show EXACTLY the four expected lines.
    assert.deepEqual(JSON.parse(await cmLineTexts(evaluate)), [
      'function greet(name) {',
      '  return name;',
      '}TAIL',
      'NEXTLINE'
    ], 'CodeMirror view must not accumulate phantom blank lines on a CRLF block')

    await assertSource(evaluate, AFTER_TYPE, 'stage A (type + Enter + type)')

    // ---- Stage B: within-line Backspace x2 ----
    await clickCmLine(evaluate, send, { line: 3, edge: 'end' })
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: delay + 30 })
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: delay + 30 })
    await waitFor(async () => {
      const text = (await cmContent(evaluate)) || ''
      return text.includes('NEXTLI') && !text.includes('NEXTLIN')
    }, 'Backspace x2 did not remove the last two typed characters')
    await sleep(300)
    await assertSource(evaluate, AFTER_BACKSPACE, 'stage B (within-line Backspace x2)')

    // ---- Stage C: caret at line start, Backspace joins the two lines ----
    await clickCmLine(evaluate, send, { line: 3, edge: 'start' })
    await pressKey(send, { key: 'Backspace', code: 'Backspace', delayMs: delay + 30 })
    await waitFor(async () => ((await cmContent(evaluate)) || '').includes('TAILNEXTLI'),
      'line-join Backspace did not merge the two CodeMirror lines')
    await sleep(300)
    await assertSource(evaluate, AFTER_JOIN, 'stage C (line-join Backspace)')

    // ---- Stage D: Enter + LASTLINE — an inserted break that reaches disk ----
    await clickCmLine(evaluate, send, { line: 2, edge: 'end' })
    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await typeTextLikeUser(send, 'LASTLINE', { delayMs: delay })
    await waitFor(async () => ((await cmContent(evaluate)) || '').includes('LASTLINE'),
      'LASTLINE never landed in the CodeMirror editor')
    await sleep(300)
    await assertSource(evaluate, AFTER_LASTLINE, 'stage D (Enter + LASTLINE)')

    // ---- Stage E: plain PROSE line-end edit (the §5.2e symptom shape) ----
    await clickProseParagraph(evaluate, send, '前置段落用于占位。')
    await typeTextLikeUser(send, 'PARA', { delayMs: delay })
    await waitFor(async () => ((await mounted(evaluate)) || '').includes('前置段落用于占位。PARA'),
      'PARA never landed in the leading paragraph')
    await sleep(300)
    await assertSource(evaluate, AFTER_PARAGRAPH, 'stage E (mid-document prose paragraph line end)')

    // ---- Save FAB → byte-exact disk write ----
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    const disk = await readFile(file, 'utf8')
    assert.equal(disk, EXPECTED_DISK, 'disk bytes must match exactly (uniform CRLF, see EXPECTED_DISK note)')
    // Property assertions the corruption family violated, independent of the
    // exact-shape assertion above: no split '\r\n' pair may leave a lone '\r',
    // and no authored line ending may be respelled to a bare '\n'.
    assert.ok(!/\r(?!\n)/.test(disk), 'disk must contain no lone \\r (split-pair corruption shape)')
    assert.ok(!/(?<!\r)\n/.test(disk), 'disk must contain no bare \\n (LF respell of an authored CRLF file)')
    assert.equal(app.dialogs.length, 0,
      `no rebuild/fail-closed dialog may appear: ${JSON.stringify(app.dialogs.map((dialog) => dialog.message))}`)

    // ---- Full quit → cold reopen → byte-exact ----
    await stopBuiltElectron(app, { removeProfile: false })
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, cleanProfile: false, appArgs: [file] })
    ;({ evaluate, send } = app)
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('TAILNEXTLI') && text.includes('LASTLINE') ? text : null
    }, 'reopened document did not mount with the saved content')
    await toggleSourceMode(evaluate)
    const reopened = await waitFor(() => visibleSource(evaluate), 'source view did not appear after cold reopen')
    assert.equal(reopened, AFTER_PARAGRAPH.replace(/\r\n/g, '\n'),
      'cold reopen source view must reproduce the saved content (LF projection)')
    assert.equal(app.dialogs.length, 0, 'no dialog may appear on cold reopen')
    assert.equal(await readFile(file, 'utf8'), EXPECTED_DISK,
      'a reopen without edits must not rewrite the disk bytes')

    // ---- Stage K: the same CRLF fence, now under the source kernel ----
    // Back to rich, then enable kernel mode on this tab.
    await toggleSourceMode(evaluate)
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('前置段落') ? text : null
    }, 'rich view did not return before enabling kernel mode')
    await sleep(200)

    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('LASTLINE') ? text : null
    }, 'document did not remount after enabling kernel mode')
    await sleep(300)
    const attachDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!attachDiagnostics.includes('attach-unmappable'),
      `kernel mode degraded to legacy fallback for this CRLF fixture: ${attachDiagnostics}`)
    assert.equal(app.dialogs.length, 0, 'no dialog after enabling kernel mode')
    await waitFor(() => evaluate(`!!(${BLOCK})?.querySelector('.cm-editor')`),
      'code block CodeMirror did not mount under kernel mode')

    // The gate this task removed: the CRLF block must be EDITABLE now, so
    // every keystroke below reaches commitPlainText instead of the blocked-CM
    // keydown allowlist.
    await clickCmLine(evaluate, send, { line: 3, edge: 'end' })
    await typeTextLikeUser(send, 'KTAIL', { delayMs: delay })
    await waitFor(async () => ((await cmContent(evaluate)) || '').includes('KTAIL'),
      'KTAIL never landed in the CodeMirror editor — is the CRLF block still gated non-editable?')
    await sleep(400)

    // Reset the diagnostics buffer AFTER the first commit of the session, on
    // purpose: the very first kernel commit in ANY heading-bearing document
    // reports one `projection-mismatch` whose diff is exactly the heading
    // node — Crepe's heading plugin stamps a slug `attrs.id` onto the live
    // node that `parse(kernel.doc.text)` does not reproduce (measured:
    // live `id:"crlf-代码块测试"` vs parsed `id:""`). It is a one-shot,
    // pre-existing, CRLF-independent quirk (the repair reconcile clears the
    // id and the plugin's restore AttrStep is then vetoed as
    // `unsupported-input-type`, so it never recurs), unrelated to this
    // stage's subject. What must be zero is a mismatch caused by a CRLF LINE
    // BREAK commit — that is the P3-4 churn symptom — so the window starts
    // here.
    //
    // The reset is NOT blind: ZERO mismatches may accumulate over the five
    // characters of 'KTAIL'. Any at all would mean a plain single-char commit
    // inside the CRLF block is itself churning, which is a real regression
    // this stage must catch.
    //
    // This asserted exactly ONE until 4e43852: the heading-slug plugin
    // re-dispatched a `setNodeMarkup` batch on every doc change, which the
    // gateway could not classify, so a repair reconcile fired once and the
    // plugin's restore step was then vetoed forever. Heading ids are not
    // Markdown bytes, so that batch is now a proven pass-through and the
    // quirk is gone — making this the stronger assertion, not a relaxed one.
    const preResetMismatches = JSON.parse(await evaluate(
      `JSON.stringify((window.__hmKernelDiagnostics || []).filter((entry) => entry.type === 'projection-mismatch'))`
    ))
    assert.equal(preResetMismatches.length, 0,
      `no projection repair may precede the break commits, got ${JSON.stringify(preResetMismatches)}`)
    await evaluate(`(window.__hmKernelDiagnostics = []).length`)

    await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay + 30 })
    await typeTextLikeUser(send, 'KNEXT', { delayMs: delay })
    await waitFor(async () => ((await cmContent(evaluate)) || '').includes('KNEXT'),
      'KNEXT never landed in the CodeMirror editor')
    await sleep(400)

    // Zero repair churn: a CRLF code commit must pass the cheap-path verify
    // (`verifyPlainTextProjection`) outright. A `projection-mismatch` here is
    // exactly the P3-4 symptom the old ADR fenced off, and a `blocked`/veto
    // notification would mean the un-narrowing did not actually reach the
    // gateway.
    const stageDiagnostics = await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`)
    assert.ok(!stageDiagnostics.includes('projection-mismatch'),
      `a CRLF code-block commit must not need a projection repair: ${stageDiagnostics}`)
    assert.ok(!stageDiagnostics.includes('cm-veto-resync'),
      `no keystroke in the CRLF block may have been vetoed: ${stageDiagnostics}`)
    assert.deepEqual(JSON.parse(await cmLineTexts(evaluate)), [
      'function greet(name) {',
      '  return name;',
      '}TAILNEXTLI',
      'LASTLINEKTAIL',
      'KNEXT'
    ], 'CodeMirror view must not accumulate phantom blank lines under the kernel either')

    await assertSource(evaluate, AFTER_KERNEL, 'stage K (kernel-mode CRLF fence edit)')

    // ---- Save under the kernel → byte-exact uniform CRLF ----
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing after the kernel edit')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'kernel-mode save did not finish')
    const kernelDisk = await readFile(file, 'utf8')
    assert.equal(kernelDisk, AFTER_KERNEL, 'kernel-mode disk bytes must match exactly (uniform CRLF)')
    assert.ok(!/\r(?!\n)/.test(kernelDisk), 'kernel-mode disk must contain no lone \\r')
    assert.ok(!/(?<!\r)\n/.test(kernelDisk), 'kernel-mode disk must contain no bare \\n')
    assert.equal(app.dialogs.length, 0,
      `no dialog may appear during the kernel stage: ${JSON.stringify(app.dialogs.map((dialog) => dialog.message))}`)

    // ---- Full quit → cold reopen → byte-exact ----
    await stopBuiltElectron(app, { removeProfile: false })
    app = await launchBuiltElectron({ profileDir: join(root, 'profile'), port, cleanProfile: false, appArgs: [file] })
    ;({ evaluate, send } = app)
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes('LASTLINEKTAIL') && text.includes('KNEXT') ? text : null
    }, 'reopened document did not mount with the kernel-saved content')
    await toggleSourceMode(evaluate)
    const kernelReopened = await waitFor(() => visibleSource(evaluate),
      'source view did not appear after the kernel-stage cold reopen')
    assert.equal(kernelReopened, AFTER_KERNEL.replace(/\r\n/g, '\n'),
      'cold reopen source view must reproduce the kernel-saved content (LF projection)')
    assert.equal(app.dialogs.length, 0, 'no dialog may appear on the kernel-stage cold reopen')
    assert.equal(await readFile(file, 'utf8'), AFTER_KERNEL,
      'a reopen without edits must not rewrite the kernel-saved bytes')

    console.log('PASS CRLF code-block UI: legacy line-2+ typing, CRLF Enter break, within-line Backspace, full-pair line-join delete, phantom-line-free CodeMirror view, byte-exact save and cold reopen — plus kernel-mode CRLF fence editing with zero projection repairs')
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
