// Kernel-mode REAL-DOCUMENT campaign (2026-08-21).
//
// Every other kernel UI suite drives a fixture written FOR it: a dozen lines,
// one shape per section, every neighbour chosen so the step under test is the
// only variable. That is what makes them good regression pins and exactly what
// makes them blind to the thing users actually do — open a mature document
// they have been writing for weeks and edit it in a dozen places.
//
// This suite is the other half. It COPIES three real repository documents to
// /tmp (never editing the originals), turns kernel mode on, and runs the same
// scripted campaign over each: type into an existing paragraph at its start,
// middle and end; `/text` mid-document then type in the placeholder; `/h2`;
// `/task` + label + Enter continuation + second label; `/table` + cell typing;
// an edit inside an existing fenced code block; a rich<->source round trip with
// NO edit; save; cold reopen. Documents that cannot host a step (no fence, no
// provable target) skip it and say so in the log.
//
// THREE PROPERTIES ARE ASSERTED AFTER EVERY STEP, and each is here because it
// fails differently:
//   1. BYTES. The source view must equal an expectation DERIVED from the
//      previous bytes plus this step's edit — plain string surgery written out
//      per step (never a hardcoded whole document, which would rot the first
//      time anyone edits the source document). The kernel's own command layer
//      is used only to CHOOSE targets (see pickTarget), never to compute the
//      expectation, so a command that writes the wrong bytes still fails here.
//   2. NO SILENT DIVERGENCE. `projection-mismatch` is the kernel's own
//      view-vs-reparse diff (verifyPlainTextProjection runs after every
//      commit), so "no unexpected projection-mismatch" IS the divergence
//      assertion; the FATAL list on top of it is the set that means the kernel
//      lost the document rather than refused an operation.
//   3. NO UNEXPECTED REFUSAL. Every step records the toasts it produced; a
//      landed step must produce none at all.
//
// KNOWN-BENIGN DIAGNOSTICS, listed explicitly per step (`allow`), never as a
// blanket tolerance:
//   * `projection-mismatch` — a document containing a TABLE emits exactly one
//     on its first kernel commit (the live table subtree and a fresh parse
//     differ in an attribute; proven independent of table cell mapping by a
//     control build — docs/ai-handoff.md §5.2d), and a freshly inserted table
//     does the same on the first commit into it.
//   * `caret-unmappable` — `/text` commits a caret anchor that sits in a
//     blank-line gap ON PURPOSE: no PM position can represent it, which is
//     precisely why the controller then materializes the vouched placeholder.
//     The diagnostic is the honest record of that hand-off, not a failure.
//   * `projection-mismatch`, exactly one per `/task` SEED DISSOLVE — and this
//     one was measured by this campaign, then explained, not assumed. The
//     dissolve is asymmetric by construction: the PM transaction inserts the
//     label character while the raw edit ALSO deletes the U+00A0 seed
//     (commands/task-seed.js `spellTaskSeedInsert` — one edit, two effects),
//     so for one beat the view holds `<seed><label>` and the reparse holds
//     `<label>`. The repair reconcile IS how the seed leaves the screen; the
//     step therefore asserts the repaired view (no U+00A0 survives) right
//     next to the budget, so a mismatch that did NOT repair still fails.
//   * `split-placeholder-*` are NOT tolerated: they mean the hand-off failed.
//
// Measured and deliberately NOT budgeted: the historical "a document
// containing a table emits one projection-mismatch on its first kernel
// commit" allowance (docs/ai-handoff.md §5.2d). The four-table fixture here
// produced ZERO across fifteen steps, so the budget stays 0 rather than
// carrying a tolerance nothing needs.
import assert from 'node:assert/strict'
import { mkdir, rm, readFile, copyFile } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchBuiltElectron, stopBuiltElectron } from './lib/electron-test-app.mjs'
import { sleep } from './lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from './lib/human-input.mjs'
import { createMarkdownDocument } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { buildSyntaxIndex, parseKernelMarkdown } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { insertBlockFromQuery } from '../src/renderer/src/lib/source-kernel/commands/block-insert.js'
import { setBlockTypeFromQuery } from '../src/renderer/src/lib/source-kernel/commands/block-type.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = `/tmp/horsemd-kernel-real-doc-${process.pid}`
const basePort = Number(process.env.CDP_PORT || 10090)
const delay = Number(process.env.KERNEL_KEY_DELAY || 60)

// The three REAL documents, chosen for distinct shapes (verified by parsing
// them, not by reputation): a mixed-content architecture note with tables,
// fences, a blockquote and both list kinds; a published guide page with YAML
// frontmatter, standalone images, inline HTML and inline math; and the
// mode-switch handoff, the ~10 K "user design doc" shape with the deepest
// heading hierarchy and four fences. Copies only — the originals are read
// once and never written.
const DOCUMENTS = [
  { name: 'mixed-content architecture note', path: 'docs/custom-shortcuts-architecture.md' },
  { name: 'guide page with frontmatter', path: 'guide/basics/rich-and-source.md' },
  { name: 'mode-switch handoff', path: 'docs/handoff-mode-switch.md' }
]

// Types that mean the kernel LOST the document (stage3's own list). Never
// tolerated, on any step, in any document.
const FATAL_DIAGNOSTICS = [
  'attach-unmappable',
  'projection-repair-failed',
  'projection-parse-failure',
  'map-refresh-failed',
  'replace-reconcile-failed',
  'structural-parse-failure',
  'history-frozen',
  'cm-veto-resync-failed',
  'cm-veto-resync-parse-failure',
  'composition-revert-failed',
  'split-placeholder-failed',
  'split-placeholder-unprovable'
]

// The bytes each slash target writes, spelled out here so every expectation
// below is a splice of the PREVIOUS bytes rather than a restated document.
const TABLE_SKELETON = '|  |  |  |\n| --- | --- | --- |\n|  |  |  |'
const TASK_MARKER = '- [ ] '
// U+00A0 — the `/task` seed. The ONE representable spelling of a label-less
// GFM task item (every ASCII spelling reparses `checked: null`); it dissolves
// under the first label character. See commands/block-insert.js's task ADR.
const SEED = '\u00A0'
// A splice, spelled once: `text` with [from, to) replaced by `insert`.
const splice = (text, from, to, insert) => text.slice(0, from) + insert + text.slice(to)

// ---------------------------------------------------------------------------
// Target selection. A "plain paragraph" is one whose raw bytes ARE its visible
// text (no inline markup, no escapes, no soft break) and whose text occurs
// exactly once in the document — the two properties that let a DOM lookup by
// textContent be unambiguous AND let the byte expectation be a string replace.
// ---------------------------------------------------------------------------
function plainParagraphs(text) {
  let tree
  try {
    tree = parseKernelMarkdown(text)
  } catch {
    return []
  }
  const out = []
  for (const node of tree.children || []) {
    if (node.type !== 'paragraph') continue
    const inline = node.children || []
    if (!inline.length || inline.some((child) => child.type !== 'text')) continue
    const value = inline.map((child) => child.value).join('')
    if (value.includes('\n') || value.length < 6 || value.length > 70) continue
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue
    if (text.slice(start, end) !== value) continue
    if (text.split(value).length !== 2) continue
    out.push({ value, start, end })
  }
  return out
}

// Would this slash command LAND on this paragraph, in this document, right
// now? Answered by running the real (pure) command against the document the
// query text would produce. Used ONLY to choose which paragraph a step takes —
// documents differ, and a campaign that hardcoded "the third paragraph" would
// be testing the fixture rather than the editor. The byte expectation is
// always computed independently, by string surgery, at the call site.
function commandLands(text, target, query, kind, commandTarget) {
  const probe = text.slice(0, target.start) + '/' + query + text.slice(target.end)
  const offset = target.start + query.length + 1
  let doc
  let index
  try {
    doc = createMarkdownDocument(probe)
    index = buildSyntaxIndex(probe)
  } catch {
    return false
  }
  const result = kind === 'block-type'
    ? setBlockTypeFromQuery({ doc, index, offset, target: commandTarget })
    : insertBlockFromQuery({ doc, index, offset, target: commandTarget })
  return result.ok === true
}

// `query` is what the user TYPES (the slash item's id); `commandTarget` is
// what the kernel command calls it (`/h2` -> `heading2`). They differ for the
// block-type family only, and the mapping is editor-crepe-setup.js's.
function pickTarget(text, used, query, kind, commandTarget = query) {
  const free = plainParagraphs(text).filter((candidate) => !used.has(candidate.value))
  for (const candidate of free) {
    if (commandLands(text, candidate, query, kind, commandTarget)) return candidate
  }
  return { skipped: free.length
    ? `no position where the command lands (${free.length} candidate paragraph(s) tried)`
    : 'the document has no unused plain paragraph left' }
}

// The first fenced block whose language is ordinary code (a mermaid/LaTeX
// fence renders preview-only and needs its own Edit toggle — a different
// gesture, covered by test-kernel-codeblock-ui.mjs) and which owns a short,
// document-unique line the campaign can click the end of.
function pickFence(text) {
  let tree
  try {
    tree = parseKernelMarkdown(text)
  } catch {
    return null
  }
  for (const node of tree.children || []) {
    if (node.type !== 'code' || !node.value) continue
    const lang = (node.lang || '').toLowerCase()
    if (lang === 'mermaid' || lang === 'latex') continue
    const line = node.value.split('\n').find((candidate) => {
      const trimmed = candidate.trim()
      return trimmed.length > 4 && candidate.length < 56 && text.split(candidate).length === 2
    })
    if (line) return { line, value: node.value }
  }
  return null
}

// ---------------------------------------------------------------------------
// CDP helpers (the canonical kernel-UI set)
// ---------------------------------------------------------------------------
async function waitFor(fn, message, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn()
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

async function readSource(evaluate, message) {
  await toggleSourceMode(evaluate)
  const shown = await waitFor(() => visibleSource(evaluate), `source view did not appear (${message})`)
  await toggleSourceMode(evaluate)
  await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), `rich view did not return (${message})`)
  await sleep(150)
  return shown
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

async function charRect(evaluate, blockText, from, to) {
  return evaluate(`(() => {
    const editor = ${VISIBLE_EDITOR}
    const node = [...(editor?.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li') || [])]
      .find((n) => n.textContent === ${JSON.stringify(blockText)})
    if (!node) return null
    node.scrollIntoView({ block: 'center' })
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    let count = 0
    let startNode = null, startOffset = 0, endNode = null, endOffset = 0
    let n
    while ((n = walker.nextNode())) {
      const len = n.textContent.length
      if (startNode === null && count + len >= ${from}) { startNode = n; startOffset = ${from} - count }
      if (endNode === null && count + len >= ${to}) { endNode = n; endOffset = ${to} - count }
      count += len
      if (startNode && endNode) break
    }
    if (!startNode || !endNode) return null
    const range = document.createRange()
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset)
    const rect = range.getBoundingClientRect()
    return rect ? { left: rect.left, right: rect.right, top: rect.top, height: rect.height } : null
  })()`)
}

async function click(send, point) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

// A real mouse click AT a character offset inside a block (never a raw DOM
// selection — that does not sync ProseMirror state).
async function clickCharOffset(evaluate, send, blockText, offset) {
  const rect = await waitFor(() => charRect(evaluate, blockText, offset, offset),
    `could not locate offset ${offset} in ${JSON.stringify(blockText)}`)
  await sleep(250)
  await click(send, { x: rect.left, y: rect.top + Math.min(10, rect.height / 2) })
  await sleep(200)
}

const selectedText = (evaluate) => evaluate(`(window.getSelection()?.toString() ?? '')`)

// Select a whole block with real mouse events: click at its first character,
// SHIFT-click at its last. Never a triple click (ProseMirror turns that into a
// whole-node selection whose replace step resolves from/to in different
// parents, which the gateway correctly refuses), and never a single-line drag
// either — that is what a fixture-sized paragraph lets you get away with and
// what a REAL document's wrapped paragraph silently breaks: the drag runs
// along the first visual line, so the query replaces only part of the text,
// the block no longer starts with '/', and the slash menu simply never opens.
// (Measured here on guide/basics/rich-and-source.md before this shape was
// used — the campaign's first real-document find.) The success condition is
// therefore EXACT: the selection's text must be the block's whole text.
async function selectBlock(evaluate, send, blockText) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const head = await waitFor(() => charRect(evaluate, blockText, 0, 0),
      `could not locate the start of ${JSON.stringify(blockText)}`)
    await click(send, { x: head.left + 1, y: head.top + Math.min(10, head.height / 2) })
    await sleep(150)
    const tail = await charRect(evaluate, blockText, blockText.length, blockText.length)
    if (tail) {
      const point = { x: tail.left, y: tail.top + Math.min(10, tail.height / 2), modifiers: 8 }
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
      await sleep(300)
    }
    if (await selectedText(evaluate) === blockText) return
    await sleep(200)
  }
  assert.fail(`shift-click never selected the whole block ${JSON.stringify(blockText)} ` +
    `(selection was ${JSON.stringify(await selectedText(evaluate))})`)
}

async function runSlashItem(evaluate, send, query, id) {
  await typeTextLikeUser(send, '/' + query, { delayMs: delay })
  await waitFor(() => evaluate(`document.querySelectorAll('.milkdown-slash-menu[data-show="true"] .hm-slash-item').length > 0`),
    `slash menu did not open for the /${query} query`, 25)
  const state = await waitFor(() => evaluate(`(() => {
    const li = document.querySelector('.milkdown-slash-menu[data-show="true"] .hm-slash-item[data-id=${JSON.stringify(id)}]')
    if (!li) return null
    return { disabled: li.classList.contains('disabled'), first: document.querySelector('.milkdown-slash-menu[data-show="true"] .hm-slash-item')?.dataset.id }
  })()`), `the '${id}' item never appeared for the /${query} query`)
  assert.equal(state.disabled, false, `the '${id}' slash item must be ENABLED in kernel mode`)
  assert.equal(state.first, id, `the /${query} query must rank '${id}' first (got ${state.first})`)
  await pressKey(send, { key: 'Enter', code: 'Enter' })
  await sleep(600)
}

const caretBlock = (evaluate) => evaluate(`(() => {
  const sel = window.getSelection()
  const node = sel?.anchorNode
  if (!node) return null
  const el = node.nodeType === 1 ? node : node.parentElement
  const block = el?.closest('p, h1, h2, h3, h4, h5, h6, li, th, td, pre')
  if (!block) return null
  const range = document.createRange()
  range.selectNodeContents(block)
  range.setEnd(sel.anchorNode, sel.anchorOffset)
  return { tag: block.tagName.toLowerCase(), text: block.textContent, caretOffset: range.toString().length }
})()`)

const toasts = (evaluate) => evaluate(`JSON.stringify(window.__campaignToasts || [])`)
const resetProbes = (evaluate) => evaluate(`(window.__campaignToasts = [], window.__hmKernelDiagnostics = [], 1)`)
const diagnostics = async (evaluate) =>
  JSON.parse(await evaluate(`JSON.stringify(window.__hmKernelDiagnostics || [])`))

// The verdict every step gets: diagnostics + toasts, then the probe buffers
// are cleared so the next step's budget is its own. NO mode switch — see
// checkBytes for why that matters.
async function probeStep(evaluate, state, label, allow = {}) {
  const entries = await diagnostics(evaluate)
  const seen = {}
  for (const entry of entries) seen[entry.type] = (seen[entry.type] || 0) + 1
  const fatal = entries.filter((entry) => FATAL_DIAGNOSTICS.includes(entry.type))
  assert.deepEqual(fatal, [], `${label}: fatal kernel diagnostics: ${JSON.stringify(fatal)}`)
  assert.ok(entries.length < 100,
    `${label}: the diagnostics ring reached ${entries.length} entries — at 100 it evicts and every count below rots`)
  if (Object.keys(seen).length) console.log(`    [diag] ${label}: ${JSON.stringify(seen)}`)
  // CAMPAIGN_DIAG_LOG=1 keeps the FATAL wall but drops the per-type budgets,
  // so one run can report the whole distribution when a budget needs deriving
  // for a newly added document or step (it is never how the suite runs).
  if (!process.env.CAMPAIGN_DIAG_LOG) {
    for (const [type, count] of Object.entries(seen)) {
      const budget = allow[type] || 0
      assert.ok(count <= budget,
        `${label}: ${count} '${type}' diagnostic(s), budget ${budget} — ${JSON.stringify(entries.filter((e) => e.type === type))}`)
    }
  }
  const raised = JSON.parse(await toasts(evaluate))
  assert.deepEqual(raised, [], `${label}: a landed step must raise NO toast, got ${JSON.stringify(raised)}`)
  state.steps.push(label)
  await resetProbes(evaluate)
  return entries
}

// The BYTE checkpoint: probeStep plus a source round trip, with the
// diagnostics read FIRST (toggling to source and back re-projects, which
// could mask a divergence that has already happened).
//
// A round trip is only taken where the NEXT gesture re-establishes its own
// caret (a click or a drag-select). Inside a chain that depends on the caret
// the previous sub-step left — typing into a fresh `/h2` heading, the `/task`
// seed dissolve, the Enter continuation, the `/text` placeholder — the
// checkpoint waits until the chain ends: the mode switch restores the caret
// by markdown offset, which is a different (and for a gap anchor, undefined)
// position from the one the command parked it at. Deferring costs nothing:
// the end-of-chain expectation is the splice of every sub-step, so a single
// wrong sub-step still fails, and the reported first-difference offset says
// which one.
async function checkBytes(evaluate, state, expected, label, allow = {}) {
  const entries = await probeStep(evaluate, state, label, allow)
  const source = await readSource(evaluate, label)
  if (source !== expected) {
    const at = [...expected].findIndex((ch, i) => source[i] !== ch)
    console.error(`  ${label}: first difference at ${at}`)
    console.error('    actual  :', JSON.stringify(source.slice(Math.max(0, at - 60), at + 60)))
    console.error('    expected:', JSON.stringify(expected.slice(Math.max(0, at - 60), at + 60)))
    console.error('    diagnostics:', JSON.stringify(entries.slice(-8)))
  }
  assert.equal(source, expected, `${label}: the bytes must match the derived expectation`)
  return source
}

// ---------------------------------------------------------------------------
// One document's campaign
// ---------------------------------------------------------------------------
async function campaign(document, port) {
  const source = join(repoRoot, document.path)
  const dir = join(root, basename(document.path, '.md'))
  const file = join(dir, basename(document.path))
  await mkdir(dir, { recursive: true })
  await copyFile(source, file)
  const original = await readFile(file, 'utf8')
  assert.equal(/\r/.test(original), false, `${document.path}: this campaign assumes an LF source document`)

  const state = { steps: [], skipped: [] }
  let expected = original
  let app
  try {
    app = await launchBuiltElectron({ profileDir: join(dir, 'profile'), port, appArgs: [file] })
    const { evaluate, send } = app
    const head = original.split('\n').find((line) => line.startsWith('# '))?.slice(2).trim()
    assert.ok(head, `${document.path}: no H1 to anchor the mount check on`)
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes(head) ? text : null
    }, 'document did not mount')
    assert.equal(app.dialogs.length, 0, 'no dialog on plain mount')

    await evaluate(`(() => {
      window.__campaignToasts = []
      window.addEventListener('hm:toast', (e) => window.__campaignToasts.push(e.detail?.msg ?? String(e.detail)))
      return 1
    })()`)

    // ---- 1) ATTACH STATE -------------------------------------------------
    await toggleKernelMode(evaluate)
    await waitFor(() => evaluate(`!!document.querySelector('.hm-kernel-mode')`), 'kernel mode did not remount the tab')
    await waitFor(async () => {
      const text = await mounted(evaluate)
      return text && text.includes(head) ? text : null
    }, 'document did not remount after enabling kernel mode')
    await sleep(400)
    const attach = await diagnostics(evaluate)
    assert.ok(!attach.some((entry) => entry.type === 'attach-unmappable'),
      `kernel mode degraded to legacy for this REAL document: ${JSON.stringify(attach)}`)
    // The persistent status indicator, not just the absence of a diagnostic:
    // `legacy` is the failure, `partial` is honest for a document holding a
    // read-only leaf (table, image block, frontmatter), and its count is
    // printed so a change in the read-only surface is visible in the log.
    const status = await evaluate(`(() => {
      const dot = document.querySelector('.kernel-status-dot')
      return JSON.stringify({
        level: dot?.dataset.kernelState ?? 'normal',
        title: document.querySelector('.block-switch-caret-btn')?.title ?? ''
      })
    })()`)
    const parsedStatus = JSON.parse(status)
    console.log(`  [attach] ${document.name}: ${parsedStatus.level} — ${parsedStatus.title.split('\n')[0]}`)
    assert.notEqual(parsedStatus.level, 'legacy',
      `the status indicator reports a legacy fallback: ${parsedStatus.title}`)
    await resetProbes(evaluate)

    const used = new Set()

    // ---- 2) TYPE INTO AN EXISTING PARAGRAPH: start, middle, end ----------
    {
      const targets = plainParagraphs(expected).filter((t) => t.value.length >= 12)
      assert.ok(targets.length, 'no plain paragraph to type into')
      const target = targets[Math.floor(targets.length / 2)]
      used.add(target.value)
      let text = target.value
      const positions = [
        ['start', 0, '甲'],
        ['middle', Math.floor(text.length / 2), '乙'],
        ['end', null, '丙']
      ]
      for (const [where, offset, typed] of positions) {
        const at = offset === null ? text.length : offset
        await clickCharOffset(evaluate, send, text, at)
        const before = await caretBlock(evaluate)
        assert.ok(before && before.text === text,
          `caret did not land in the target paragraph (${where}): ${JSON.stringify(before)}`)
        assert.equal(before.caretOffset, at, `caret landed at ${before.caretOffset}, wanted ${at} (${where})`)
        await typeTextLikeUser(send, typed, { delayMs: delay })
        await sleep(350)
        expected = splice(expected, target.start + at, target.start + at, typed)
        await checkBytes(evaluate, state, expected, `type at paragraph ${where}`)
        text = text.slice(0, at) + typed + text.slice(at)
      }
      // The paragraph's text changed, so its ORIGINAL value no longer guards
      // it from being picked again by a later, CONSUMING step.
      used.add(text)
    }

    // ---- 3) `/text` MID-DOCUMENT, then type in the placeholder -----------
    {
      const target = pickTarget(expected, used, 'text', 'text')
      if (target.skipped) {
        state.skipped.push(`/text mid-document — ${target.skipped}`)
      } else {
        used.add(target.value)
        await selectBlock(evaluate, send, target.value)
        await runSlashItem(evaluate, send, 'text', 'text')
        const caret = await caretBlock(evaluate)
        assert.ok(caret && caret.text === '',
          `/text must park the caret in an EMPTY placeholder, got ${JSON.stringify(caret)}`)
        // The bytes: the block's own span is gone, both separators stay.
        expected = splice(expected, target.start, target.end, '')
        await probeStep(evaluate, state, '/text mid-document', { 'caret-unmappable': 1 })
        const typed = '内核校验新增段落'
        await typeTextLikeUser(send, typed, { delayMs: delay })
        await sleep(400)
        // The placeholder's raw anchor IS the deleted block's own start.
        expected = splice(expected, target.start, target.start, typed)
        await checkBytes(evaluate, state, expected, '/text placeholder typing')
        // Deliberately NOT marked used: the paragraph the placeholder just
        // became is an ordinary paragraph now, and letting a later step
        // consume it is more coverage, not less (its own assertions already
        // ran). On a document with few plain paragraphs it is what keeps the
        // /table step reachable at all.
      }
    }

    // ---- 4) `/h2` conversion --------------------------------------------
    {
      const target = pickTarget(expected, used, 'h2', 'block-type', 'heading2')
      if (target.skipped) {
        state.skipped.push(`/h2 — ${target.skipped}`)
      } else {
        used.add(target.value)
        await selectBlock(evaluate, send, target.value)
        await runSlashItem(evaluate, send, 'h2', 'h2')
        const marker = '## '
        expected = splice(expected, target.start, target.end, marker)
        await probeStep(evaluate, state, '/h2 conversion')
        const typed = '内核校验小节'
        await typeTextLikeUser(send, typed, { delayMs: delay })
        await sleep(350)
        // The caret sits right after the marker the conversion wrote.
        expected = splice(expected, target.start + marker.length, target.start + marker.length, typed)
        await checkBytes(evaluate, state, expected, '/h2 conversion + typing')
        used.add(typed)
      }
    }

    // ---- 5) `/task` + label + Enter continuation + second label ----------
    {
      const target = pickTarget(expected, used, 'task', 'task')
      if (target.skipped) {
        state.skipped.push(`/task — ${target.skipped}`)
      } else {
        used.add(target.value)
        await selectBlock(evaluate, send, target.value)
        await runSlashItem(evaluate, send, 'task', 'task')
        expected = splice(expected, target.start, target.end, TASK_MARKER + SEED)
        await probeStep(evaluate, state, '/task insert (seeded)')
        // The seed's own span — where the first label character lands, and
        // what it replaces, in ONE edit (commands/task-seed.js).
        const seedAt = target.start + TASK_MARKER.length
        const label = '第一项'
        await typeTextLikeUser(send, label, { delayMs: delay })
        await sleep(400)
        expected = splice(expected, seedAt, seedAt + SEED.length, label)
        // The dissolve's own repair, asserted where its diagnostic is
        // budgeted: the seed must be GONE from the view, not merely from the
        // bytes (see the header note on the asymmetric commit).
        const item = await caretBlock(evaluate)
        assert.ok(item && item.text === label,
          `the seed must have left the view with the label in its place, got ${JSON.stringify(item)}`)
        await probeStep(evaluate, state, '/task label (seed dissolved)',
          { 'projection-mismatch': 1 })
        // Enter at the label's end writes the continuation item, seeded the
        // same way (`\n` + marker + seed inserted right after the label).
        await pressKey(send, { key: 'Enter', code: 'Enter', delayMs: delay })
        await sleep(500)
        const nextAt = seedAt + label.length
        expected = splice(expected, nextAt, nextAt, '\n' + TASK_MARKER + SEED)
        await probeStep(evaluate, state, '/task Enter continuation (seeded)')
        const secondSeedAt = nextAt + 1 + TASK_MARKER.length
        const second = '第二项'
        await typeTextLikeUser(send, second, { delayMs: delay })
        await sleep(400)
        expected = splice(expected, secondSeedAt, secondSeedAt + SEED.length, second)
        await checkBytes(evaluate, state, expected, '/task insert + label + Enter + second label',
          { 'projection-mismatch': 1 })
      }
    }

    // ---- 6) `/table` insert + cell typing --------------------------------
    {
      const target = pickTarget(expected, used, 'table', 'table')
      if (target.skipped) {
        state.skipped.push(`/table — ${target.skipped}`)
      } else {
        used.add(target.value)
        await selectBlock(evaluate, send, target.value)
        await runSlashItem(evaluate, send, 'table', 'table')
        expected = splice(expected, target.start, target.end, TABLE_SKELETON)
        await probeStep(evaluate, state, '/table insert')
        // The caret home the command derives: `|` + one padding space of the
        // first header cell (table-map.js's `emptyCellCharMap` anchor).
        const cellAt = target.start + 2
        const cell = '格甲'
        await typeTextLikeUser(send, cell, { delayMs: delay })
        await sleep(400)
        expected = splice(expected, cellAt, cellAt, cell)
        await checkBytes(evaluate, state, expected, '/table insert + first-cell typing')
      }
    }

    // ---- 7) EDIT INSIDE AN EXISTING FENCE --------------------------------
    {
      const fence = pickFence(expected)
      if (!fence) {
        state.skipped.push('fence edit (document has no ordinary fenced block)')
      } else {
        const point = await evaluate(`(() => {
          const editor = ${VISIBLE_EDITOR}
          const block = [...(editor?.querySelectorAll('.milkdown-code-block') || [])]
            .find((node) => node.querySelector('.cm-content')?.textContent?.includes(${JSON.stringify(fence.line)}))
          if (!block) return null
          block.scrollIntoView({ block: 'center' })
          const line = [...block.querySelectorAll('.cm-editor .cm-line')]
            .find((node) => node.textContent === ${JSON.stringify(fence.line)})
          const rect = line?.getBoundingClientRect()
          return rect && rect.width ? { x: rect.right - 2, y: rect.top + rect.height / 2 } : null
        })()`)
        assert.ok(point, `could not hit-test the fence line ${JSON.stringify(fence.line)}`)
        await sleep(300)
        await click(send, point)
        await sleep(250)
        await pressKey(send, { key: 'End', code: 'End', delayMs: delay })
        const typed = ' // 内核校验'
        await typeTextLikeUser(send, typed, { delayMs: delay })
        await sleep(450)
        const lineAt = expected.indexOf(fence.line) + fence.line.length
        expected = splice(expected, lineAt, lineAt, typed)
        await checkBytes(evaluate, state, expected, 'edit inside an existing fence')
      }
    }

    // ---- 8) RICH <-> SOURCE ROUND TRIP WITH NO EDIT ----------------------
    {
      const before = await mounted(evaluate)
      const first = await readSource(evaluate, 'no-edit round trip')
      const second = await readSource(evaluate, 'no-edit round trip (again)')
      assert.equal(first, expected, 'a no-edit round trip must not change the bytes')
      assert.equal(second, first, 'a second no-edit round trip must not change them either')
      assert.equal(await mounted(evaluate), before, 'the rich view must come back identical')
      const entries = await diagnostics(evaluate)
      const fatal = entries.filter((entry) => FATAL_DIAGNOSTICS.includes(entry.type))
      assert.deepEqual(fatal, [], `no-edit round trip: fatal diagnostics ${JSON.stringify(fatal)}`)
      assert.deepEqual(entries.filter((entry) => entry.type === 'projection-mismatch'), [],
        'a no-edit round trip must not diverge')
      state.steps.push('no-edit rich<->source round trip')
      await resetProbes(evaluate)
    }

    // ---- 9) SAVE + COLD REOPEN ------------------------------------------
    await waitFor(() => evaluate(`!!document.querySelector('.hm-save-fab')`), 'save button missing')
    await evaluate(`document.querySelector('.hm-save-fab')?.click()`)
    await waitFor(() => evaluate(`!document.querySelector('.hm-save-fab')`), 'save did not finish')
    const disk = await readFile(file, 'utf8')
    assert.equal(disk, expected, 'the saved bytes must be exactly the campaign expectation')
    assert.equal(app.dialogs.length, 0,
      `no dialog may appear: ${JSON.stringify(app.dialogs.map((d) => d.message))}`)

    await stopBuiltElectron(app, { removeProfile: false })
    app = null
    app = await launchBuiltElectron({ profileDir: join(dir, 'profile-reopen'), port, appArgs: [file] })
    const reopened = app
    await waitFor(async () => {
      const text = await reopened.evaluate(`(${VISIBLE_EDITOR})?.textContent`)
      return text && text.includes('内核校验') ? text : null
    }, 'the saved document did not remount on cold relaunch')
    assert.equal(await readFile(file, 'utf8'), expected, 'a cold reopen must not rewrite the file')
    assert.equal(reopened.dialogs.length, 0, 'no dialog on cold relaunch')

    // The campaign must actually have driven the document, not silently
    // skipped its way to a pass.
    assert.ok(state.steps.length >= 6,
      `only ${state.steps.length} steps ran for ${document.path}: ${JSON.stringify(state.steps)}`)
    console.log(`  [ok] ${document.name} (${original.length} chars): ${state.steps.length} steps` +
      (state.skipped.length ? ` — skipped: ${state.skipped.join('; ')}` : ''))
    return state
  } finally {
    await stopBuiltElectron(app, { removeProfile: true })
  }
}

async function run() {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  const only = process.env.CAMPAIGN_DOC
  const documents = only ? DOCUMENTS.filter((d) => d.path.includes(only)) : DOCUMENTS
  assert.ok(documents.length, `CAMPAIGN_DOC=${only} matched no document`)
  const ran = []
  for (const [index, document] of documents.entries()) {
    console.log(`--- campaign: ${document.path}`)
    ran.push(await campaign(document, basePort + index))
  }
  await rm(root, { recursive: true, force: true })
  const total = ran.reduce((sum, state) => sum + state.steps.length, 0)
  console.log(`PASS kernel real-document campaign: ${documents.length} real repository documents, ` +
    `${total} scripted edit steps, every step's bytes derived from the previous bytes, ` +
    'zero unexpected refusals, zero silent divergence, save + cold reopen byte-identical')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
