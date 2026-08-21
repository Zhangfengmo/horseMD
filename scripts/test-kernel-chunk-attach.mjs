// THE ABOVE-CHUNK_THRESHOLD ATTACH (2026-08-21).
//
// Until this suite, a document longer than `CHUNK_THRESHOLD` (120 000 chars)
// could not run the source kernel AT ALL. `appendChunks`
// (editor-chunked-parse.js) parses each ~40 KB chunk SEPARATELY and appends
// it, and a chunked parse structurally disagrees with a whole-document parse
// on real shapes — canonically, two item runs separated by a blank line are
// ONE loose list to a whole parse and TWO lists to a chunked one. The
// projection map's block zip then refuses and the whole 120 KB-and-up band
// fell back to legacy, which is the mode the byte-fidelity bug family lives
// in.
//
// The fix is one whole-document parse-first reconcile at the END of the load:
// `repairChunkedProjection` (editor-kernel-mode.js) reparses the source with
// the editor's own parser, `diffReplaceRegions` (editor-kernel-reconciler.js)
// finds the regions that genuinely disagree, and only those are replaced.
// The attach that follows is the ORDINARY full pairing — no chunk boundary is
// ever consulted by the kernel, so the rejected-mirroring ADR still stands.
//
// WHAT THIS FILE PROVES, and why each one is here:
//   1. NON-VACUITY. The chunked document really is unpairable and the
//      whole-document parse really is pairable — asserted per fixture, so a
//      corpus that stopped straddling a boundary would fail loudly instead of
//      making the repair look unnecessary.
//   2. The repair CONVERGES: after it, the live document `.eq` the
//      whole-document parse. The controller asserts this itself (fail-closed
//      'diverged'); this suite pins that the assertion passes on real shapes.
//   3. MINIMAL DIFF. Node-view identity is what a 400 KB document cannot
//      afford to lose — every CodeMirror would remount. The repair is
//      measured in top-level nodes that keep `===` identity, with a budget.
//   4. ATTACH + EDIT. The repaired document attaches, reports 'normal', and
//      accepts a keystroke at its start, middle and end with exact bytes.
//   5. THE HONEST FALLBACK. A chunked document that is STILL unpairable after
//      a successful repair, and one whose reparse fails outright, each keep
//      their own named message.
//   6. The CHUNK_THRESHOLD boundary itself, and CRLF throughout.
//
// The parse is the real editor chain (scripts/lib/kernel-parse-harness.mjs),
// not a hand-built fixture: this suite is ABOUT two parses of the same bytes
// disagreeing, so a stub parse could not state the proposition at all.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { EditorState, TextSelection } from '@milkdown/prose/state'
import { parseEditorMarkdown, editorSchema } from './lib/kernel-parse-harness.mjs'
import { makeCorpus, toCrlf } from './lib/kernel-corpus.mjs'
import {
  splitMarkdown,
  appendChunks,
  CHUNK_SIZE,
  CHUNK_THRESHOLD
} from '../src/renderer/src/components/editor-chunked-parse.js'
import { buildProjectionMap } from '../src/renderer/src/components/editor-kernel-projection-map.js'
import {
  diffReplaceRange,
  diffReplaceRegions,
  reconcileProjectionRegions
} from '../src/renderer/src/components/editor-kernel-reconciler.js'
import { createKernelMode } from '../src/renderer/src/components/editor-kernel-mode.js'
import { describeKernelStatus } from '../src/renderer/src/lib/kernel-status.js'

const BUDGET = process.env.KERNEL_CHUNK_TIMINGS === '1'
const timings = []

// A view stub with the surface the loader + the controller touch: a real
// EditorState (so `.tr` / `.apply` are real), `setProps({editable})` and a
// `dom` whose contentEditable the loader writes — recorded, because "the
// editor is read-only while the repair runs" is one of the claims.
function makeView(doc) {
  let state = EditorState.create({ schema: editorSchema, doc })
  const editableLog = []
  const dom = {
    _ce: 'true',
    get contentEditable() { return this._ce },
    set contentEditable(value) { this._ce = value; editableLog.push(`dom:${value}`) }
  }
  return {
    get state() { return state },
    dispatch(tr) { state = state.apply(tr) },
    updateState(next) { state = next },
    setProps(props) {
      if (typeof props?.editable === 'function') editableLog.push(`props:${props.editable()}`)
    },
    dom,
    editableLog,
    composing: false,
    focus() {}
  }
}

// Exactly Editor.jsx's wiring: create with chunks[0], stream the rest, repair
// inside the loader's read-only window, then attach.
async function loadChunked(markdown, { parse = parseEditorMarkdown, extra = {}, repair = true } = {}) {
  const chunks = splitMarkdown(markdown, CHUNK_SIZE)
  const view = makeView(parse(chunks[0]))
  const notifications = []
  const statuses = []
  const controller = createKernelMode({
    initialContent: markdown,
    chunkedLoad: true,
    getView: () => view,
    parse,
    notify: (message) => notifications.push(message),
    getT: (key) => `t:${key}`,
    onChange: () => {},
    onStatusChange: (status) => statuses.push(status),
    ...extra
  })
  // The chunked document, captured BEFORE the repair — case 1 needs it.
  let chunkedDoc = null
  let editableDuringRepair = null
  let repairMs = 0
  await appendChunks({
    rest: chunks.slice(1),
    view,
    parseMarkdown: parse,
    isDestroyed: () => false,
    getEditable: () => true,
    onChunksApplied: async () => {
      chunkedDoc = view.state.doc
      editableDuringRepair = view.dom.contentEditable
      if (!repair) return
      const started = performance.now()
      await controller.repairChunkedProjection({
        yieldTurn: () => new Promise((resolve) => setTimeout(resolve, 0))
      })
      repairMs = performance.now() - started
    }
  })
  const attachStarted = performance.now()
  const attached = controller.attachAfterCreate()
  const attachMs = performance.now() - attachStarted
  return {
    chunks,
    view,
    controller,
    notifications,
    statuses,
    chunkedDoc,
    editableDuringRepair,
    attached,
    repairMs,
    attachMs
  }
}

// Emulate createSourceTransactionDispatch (same helper as
// scripts/test-kernel-mode-headless.mjs): classify first, install only when
// the controller did not veto.
function dispatchThrough(view, controller, tr) {
  const oldState = view.state
  const applied = oldState.apply(tr)
  const verdict = controller.handleTransactions([tr], oldState, {
    ...applied,
    doc: applied.doc,
    tr: applied.tr
  })
  if (!verdict?.veto) view.updateState(applied)
  return verdict
}

console.log('--- kernel chunk attach ---')

// ===========================================================================
// Case 0: THE CONTROL — the same load WITHOUT the repair still refuses.
// ===========================================================================
// This is the non-vacuity proof for everything below. It runs the identical
// fixture through the identical loader with `repair: false`, i.e. the
// behaviour at 31afc69, and asserts the outcome the whole 120 KB-and-up band
// used to get: attach refused, tab handed back to legacy, named message.
// Without it, "the repaired document attaches" would be consistent with the
// fixture simply never having been unpairable.
{
  const markdown = makeCorpus(200000, 42, { chunkTraps: true })
  const fallbacks = []
  const session = await loadChunked(markdown, {
    repair: false,
    extra: { onLegacyFallback: (info) => fallbacks.push(info) }
  })
  assert.equal(session.controller.getChunkRepair(), null, 'the control runs no repair')
  assert.equal(session.attached, false,
    'WITHOUT the repair, a chunk-loaded document is unpairable and attach refuses (pre-fix behaviour)')
  assert.deepEqual(session.notifications, ['t:kernelMode.unmappableChunked'])
  assert.deepEqual(fallbacks, [{ chunked: true, reason: 'chunked' }],
    'and the tab is handed back to the legacy pipeline')
  session.controller.dispose()
}

// ===========================================================================
// Case 1-4: the four real fixtures, end to end.
// ===========================================================================
// Each is a chunk-trap corpus (scripts/lib/kernel-corpus.mjs): a loose bullet
// list straddles EVERY chunk boundary, which is the shape measured on this
// repo's own docs/. LF and CRLF, at 200 KB and 400 KB — the two sizes the
// perf assessment uses, so the numbers here are comparable to §2/§3 of
// .superpowers/kernel-performance-assessment.md.
const FIXTURES = [
  { name: '130 KB LF (just over the threshold)', markdown: makeCorpus(130000, 42, { chunkTraps: true }) },
  { name: '200 KB LF', markdown: makeCorpus(200000, 42, { chunkTraps: true }) },
  { name: '200 KB CRLF', markdown: toCrlf(makeCorpus(200000, 42, { chunkTraps: true })) },
  { name: '400 KB CRLF', markdown: toCrlf(makeCorpus(400000, 42, { chunkTraps: true })) }
]

for (const fixture of FIXTURES) {
  const { markdown } = fixture
  assert.ok(markdown.length > CHUNK_THRESHOLD,
    `${fixture.name}: the fixture must actually cross CHUNK_THRESHOLD (positive control)`)

  const session = await loadChunked(markdown)
  const { chunks, view, controller, chunkedDoc } = session
  assert.ok(chunks.length > 1, `${fixture.name}: must split into several chunks`)

  // --- 1. NON-VACUITY -------------------------------------------------------
  // The chunked document is genuinely unpairable: this is the refusal that
  // shipped before the repair, reproduced here rather than assumed. If a
  // future corpus change made this pass, every other assertion below would
  // still pass while proving nothing.
  const wholeParse = parseEditorMarkdown(markdown)
  assert.equal(buildProjectionMap(markdown, chunkedDoc), null,
    `${fixture.name}: the CHUNKED document must be unpairable (this is what the repair exists for)`)
  assert.ok(buildProjectionMap(markdown, wholeParse),
    `${fixture.name}: the WHOLE-document parse must be pairable`)

  // --- 2. CONVERGENCE -------------------------------------------------------
  const repair = controller.getChunkRepair()
  assert.deepEqual(
    { ok: repair?.ok, failure: repair?.failure },
    { ok: true, failure: null },
    `${fixture.name}: the repair must succeed`
  )
  assert.ok(repair.regions > 0, `${fixture.name}: the repair must have had something to repair`)
  // `repairChunkedProjection` refuses unless the live doc `.eq` the parse, so
  // ok:true already implies this — asserted anyway, because it is the whole
  // proposition and it must not depend on reading the controller correctly.
  assert.ok(view.state.doc.eq(wholeParse),
    `${fixture.name}: after the repair the live document IS the whole-document parse`)

  // --- 3. MINIMAL DIFF / NODE IDENTITY --------------------------------------
  // The claim is not "few bytes changed" but "few NODE VIEWS remount". PM
  // rebuilds exactly the nodes inside a replaced range, so top-level `===`
  // identity against the pre-repair document is the direct measurement.
  const before = []
  chunkedDoc.forEach((node) => before.push(node))
  const after = []
  view.state.doc.forEach((node) => after.push(node))
  const kept = after.filter((node) => before.includes(node)).length
  const keptRatio = kept / before.length
  assert.ok(keptRatio > 0.98,
    `${fixture.name}: the repair must keep >98% of top-level nodes identical (kept ${kept}/${before.length})`)

  const regions = diffReplaceRegions(chunkedDoc, wholeParse)
  assert.equal(regions.length, repair.regions,
    `${fixture.name}: the controller's region count is diffReplaceRegions' answer`)
  // Disjoint and ascending, in BOTH coordinate spaces — the back-to-front
  // application in reconcileProjectionRegions is only valid if they are.
  for (let i = 1; i < regions.length; i += 1) {
    assert.ok(regions[i].from >= regions[i - 1].to,
      `${fixture.name}: regions must be disjoint and ascending in old coordinates`)
    assert.ok(regions[i].insertFrom >= regions[i - 1].insertTo,
      `${fixture.name}: regions must be disjoint and ascending in new coordinates`)
  }
  const touched = regions.reduce((total, region) => total + (region.to - region.from), 0)
  const touchedRatio = touched / chunkedDoc.content.size

  // THE PROPOSITION THE MULTI-REGION DIFF EXISTS FOR, stated as a comparison
  // rather than an absolute: the single-range `diffReplaceRange` answer
  // brackets the FIRST and the LAST disagreement and swallows everything
  // between them, so on a document cut at N boundaries it approaches the
  // whole document. The multi-region answer must be a small fraction of it.
  const single = diffReplaceRange(chunkedDoc, wholeParse)
  const singleTouched = single ? single.to - single.from : 0
  assert.ok(singleTouched > 0, `${fixture.name}: the single-range diff is non-empty (control)`)
  assert.ok(touched * 4 < singleTouched,
    `${fixture.name}: the region diff must be far smaller than the single-range one ` +
    `(${touched} vs ${singleTouched} positions)`)
  // Absolute ceiling too, so a regression that shrinks the single-range
  // baseline as well cannot hide behind the ratio. 12 % is the measured
  // worst case: the chunk-trap corpus puts a 2.5 KB loose list across EVERY
  // boundary, which is deliberately harsher than the 7.8 % measured on a
  // 646 KB concatenation of this repo's own docs/.
  assert.ok(touchedRatio < 0.12,
    `${fixture.name}: the repair must touch <12% of the document (touched ${(touchedRatio * 100).toFixed(2)}%)`)

  // …and the identity that actually costs: a `code_block` remount rebuilds a
  // CodeMirror instance (mounted EAGERLY here — see editor-codeblock-eager.js),
  // which at 400 KB is the freeze this whole design avoids. Not one of them
  // may lose its PM identity.
  const codeBlocksBefore = new Set()
  chunkedDoc.descendants((node) => {
    if (node.type.name === 'code_block') codeBlocksBefore.add(node)
    return true
  })
  let codeBlocksAfter = 0
  let codeBlocksKept = 0
  view.state.doc.descendants((node) => {
    if (node.type.name !== 'code_block') return true
    codeBlocksAfter += 1
    if (codeBlocksBefore.has(node)) codeBlocksKept += 1
    return true
  })
  assert.ok(codeBlocksAfter > 0, `${fixture.name}: fixture must contain fenced code (control)`)
  assert.equal(codeBlocksKept, codeBlocksAfter,
    `${fixture.name}: every code block must keep its node identity through the repair ` +
    `(kept ${codeBlocksKept}/${codeBlocksAfter})`)

  // --- 4. ATTACH + STATUS ---------------------------------------------------
  assert.equal(session.attached, true, `${fixture.name}: the repaired document must attach`)
  assert.deepEqual(session.notifications, [], `${fixture.name}: a successful attach says nothing`)
  const status = controller.getKernelStatus()
  assert.equal(status.state, 'normal',
    `${fixture.name}: status must be 'normal' (${status.readOnlyBlocks}/${status.blocks} read-only)`)
  assert.equal(status.reason, null)
  assert.equal(describeKernelStatus(status).level, 'normal')

  // --- 4b. THE READ-ONLY WINDOW --------------------------------------------
  // The repair relies on there being no user edit to lose. That is not an
  // assumption about user behaviour — the loader holds the editor read-only,
  // and the hook runs inside that span.
  assert.equal(session.editableDuringRepair, 'false',
    `${fixture.name}: the repair must run while the editor is still read-only`)
  assert.equal(view.dom.contentEditable, 'true',
    `${fixture.name}: and editability must be restored afterwards`)

  // --- 4c. AN EDIT AT START / MIDDLE / END ---------------------------------
  // The point of attaching is being able to type. Three positions, because
  // the repair's regions are scattered through the document and an offset
  // that survives at the start can still be wrong after the last one.
  // Targets: top-level paragraphs whose FIRST inline child is unmarked text,
  // so "insert after the first character" is a plain byte insertion with no
  // mark or atom boundary to reason about — this case is about the ATTACH
  // being usable, not about the mark/atom domains other suites own.
  const paragraphs = []
  view.state.doc.forEach((node, offset) => {
    const first = node.firstChild
    if (node.type.name !== 'paragraph') return
    if (!first?.isText || first.marks.length || (first.text || '').length < 3) return
    paragraphs.push({ node, offset })
  })
  assert.ok(paragraphs.length >= 3, `${fixture.name}: fixture must offer three plain paragraphs`)
  // END FIRST, then middle, then start: every offset was resolved against the
  // pre-edit document, and editing back to front is what keeps the later
  // ones valid without re-deriving (a re-derivation would be a second,
  // unproven answer to "which paragraph is the middle one").
  const targets = [
    ['end', paragraphs[paragraphs.length - 1]],
    ['middle', paragraphs[Math.floor(paragraphs.length / 2)]],
    ['start', paragraphs[0]]
  ]
  for (const [where, target] of targets) {
    const textBefore = controller.kernel.doc.text
    const pos = target.offset + 1 + 1 // inside the paragraph, after its first char
    const tr = view.state.tr.insertText('丙', pos)
    tr.setSelection(TextSelection.create(tr.doc, pos + 1))
    const verdict = dispatchThrough(view, controller, tr)
    assert.ok(!verdict?.veto, `${fixture.name}: an ordinary keystroke at the ${where} must not be vetoed`)
    const textAfter = controller.kernel.doc.text
    assert.equal(textAfter.length, textBefore.length + 1,
      `${fixture.name}: the ${where} keystroke writes exactly one character`)
    // Exact bytes: everything except the inserted character is unchanged, and
    // the inserted character is the one that was typed.
    let diverge = 0
    while (textBefore[diverge] === textAfter[diverge]) diverge += 1
    assert.equal(textAfter[diverge], '丙',
      `${fixture.name}: the ${where} keystroke writes the typed character`)
    assert.equal(textBefore.slice(diverge), textAfter.slice(diverge + 1),
      `${fixture.name}: the ${where} keystroke changes nothing else`)
  }

  timings.push({
    fixture: fixture.name,
    chars: markdown.length,
    chunks: chunks.length,
    regions: repair.regions,
    touchedPct: Number((touchedRatio * 100).toFixed(3)),
    keptPct: Number((keptRatio * 100).toFixed(2)),
    repairMs: Math.round(session.repairMs),
    attachMs: Math.round(session.attachMs)
  })
  controller.dispose()
}

// ===========================================================================
// Case 5: CHUNK_THRESHOLD itself.
// ===========================================================================
// Editor.jsx's rule is `(initialContent?.length || 0) > CHUNK_THRESHOLD`.
// Pinned here because the whole feature keys off which side of it a document
// falls on, and an off-by-one would silently move a whole band of documents
// onto (or off) the repair path.
{
  const below = 'x'.repeat(CHUNK_THRESHOLD - 1)
  const at = 'x'.repeat(CHUNK_THRESHOLD)
  const above = 'x'.repeat(CHUNK_THRESHOLD + 1)
  assert.equal(below.length > CHUNK_THRESHOLD, false, '119 999 chars is NOT chunked')
  assert.equal(at.length > CHUNK_THRESHOLD, false, 'exactly 120 000 chars is NOT chunked')
  assert.equal(above.length > CHUNK_THRESHOLD, true, '120 001 chars IS chunked')

  // And a real document one character past the threshold runs the whole path.
  let markdown = makeCorpus(118000, 19, { chunkTraps: true })
  markdown += `\n${'甲'.repeat(Math.max(1, CHUNK_THRESHOLD + 1 - markdown.length - 1))}\n`
  assert.ok(markdown.length > CHUNK_THRESHOLD && markdown.length < CHUNK_THRESHOLD + 4000,
    `boundary fixture must sit just past the threshold (got ${markdown.length})`)
  const session = await loadChunked(markdown)
  assert.ok(session.chunks.length > 1, 'the boundary fixture must really be chunked')
  assert.equal(session.controller.getChunkRepair()?.ok, true)
  assert.equal(session.attached, true, 'a document one character past the threshold attaches')
  assert.equal(session.controller.getKernelStatus().state, 'normal')
  session.controller.dispose()
}

// ===========================================================================
// Case 6: THE HONEST FALLBACK — still unpairable after a successful repair.
// ===========================================================================
// The repair makes the view equal the whole-document parse. It cannot make
// that parse PAIRABLE — a document whose whole-document shape the projection
// map genuinely refuses must still fall back, and must say which of the two
// chunk-load refusals it is. Built by handing the controller a parse that
// appends a block the source does not contain (the same construction the
// pre-repair case in test-kernel-mode-headless.mjs uses), so the refusal is
// deterministic instead of depending on some document staying unpairable.
{
  const markdown = makeCorpus(130000, 5, { chunkTraps: true })
  const surplusParse = (text) => {
    const parsed = parseEditorMarkdown(text)
    // Only the WHOLE-document parse gets the surplus block; the chunk parses
    // stay honest, so the load itself behaves exactly as it does in the app.
    if (text !== markdown) return parsed
    return parsed.type.create(
      parsed.attrs,
      parsed.content.addToEnd(editorSchema.node('paragraph', null, editorSchema.text('surplus'))),
      parsed.marks
    )
  }
  const session = await loadChunked(markdown, { parse: surplusParse })
  const repair = session.controller.getChunkRepair()
  assert.equal(repair?.ok, true, 'the repair itself succeeds — the view becomes that parse')
  assert.equal(session.attached, false, 'and the attach still refuses')
  assert.deepEqual(session.notifications, ['t:kernelMode.unmappableChunked'],
    'a repaired-but-unpairable chunked document keeps its own named message')
  assert.equal(session.controller.getKernelStatus().reason, 'chunked')
  assert.equal(describeKernelStatus(session.controller.getKernelStatus()).detailKey,
    'kernelMode.unmappableChunked')
  session.controller.dispose()
}

// ===========================================================================
// Case 7: THE OTHER FALLBACK — the whole-document reparse itself fails.
// ===========================================================================
// A parse that throws (or answers null) on the full text cannot be repaired
// at all, and that is a DIFFERENT situation from "repaired and still
// unpairable": the view is left exactly as the loader built it and nothing
// was proven about it. It gets its own reason and its own message.
{
  const markdown = makeCorpus(130000, 11, { chunkTraps: true })
  const brokenParse = (text) => {
    if (text === markdown) throw new Error('whole-document parse failed')
    return parseEditorMarkdown(text)
  }
  const session = await loadChunked(markdown, { parse: brokenParse })
  const chunkedBefore = session.chunkedDoc
  assert.deepEqual(session.controller.getChunkRepair(),
    { ok: false, failure: 'reparse', regions: 0 })
  assert.ok(session.view.state.doc.eq(chunkedBefore),
    'a failed reparse leaves the view exactly as the loader built it')
  assert.equal(session.attached, false)
  assert.deepEqual(session.notifications, ['t:kernelMode.chunkRepairFailed'])
  assert.equal(session.controller.getKernelStatus().reason, 'chunk-repair')
  assert.equal(describeKernelStatus(session.controller.getKernelStatus()).detailKey,
    'kernelMode.chunkRepairFailed')
  session.controller.dispose()

  // Both new strings must exist in BOTH languages — no hardcoded user text.
  const i18n = readFileSync(new URL('../src/renderer/src/i18n.jsx', import.meta.url), 'utf8')
  for (const key of ['kernelMode.chunkRepairFailed', 'kernelMode.unmappableChunked', 'kernelMode.toggleDuringLoad']) {
    assert.equal((i18n.match(new RegExp(`'${key}':`, 'g')) || []).length, 2,
      `${key} must be declared once per language (en + zh)`)
  }
}

// ===========================================================================
// Case 8: the loader contract the repair depends on.
// ===========================================================================
{
  // 8a. Chunk appends must not enter the undo history. Without this, the
  // first Ctrl-Z on a freshly opened huge document undid a 40 KB append —
  // and after the repair it would step the view back to a shape the kernel
  // never paired with.
  const metas = []
  const doc = parseEditorMarkdown('甲\n')
  const view = makeView(doc)
  const realDispatch = view.dispatch.bind(view)
  view.dispatch = (tr) => {
    metas.push({
      addToHistory: tr.getMeta('addToHistory'),
      sourceProjection: tr.getMeta('sourceProjection')
    })
    realDispatch(tr)
  }
  let hookRan = false
  await appendChunks({
    rest: ['乙\n', '丙\n'],
    view,
    parseMarkdown: parseEditorMarkdown,
    isDestroyed: () => false,
    getEditable: () => true,
    onChunksApplied: () => { hookRan = true }
  })
  assert.equal(metas.length, 2, 'both chunks dispatch')
  for (const meta of metas) {
    assert.equal(meta.addToHistory, false, 'a chunk append is the LOAD, never an undoable edit')
  }
  assert.equal(hookRan, true, 'the completion hook runs')

  // 8b. …and it runs even when there are ZERO remaining chunks (a document
  // over the threshold whose split produced a single chunk). Skipping it
  // there would leave exactly those documents unrepaired and unexplained.
  let soloHook = 0
  await appendChunks({
    rest: [],
    view,
    parseMarkdown: parseEditorMarkdown,
    isDestroyed: () => false,
    getEditable: () => true,
    onChunksApplied: () => { soloHook += 1 }
  })
  assert.equal(soloHook, 1, 'the completion hook runs for a single-chunk document too')

  // 8c. A throwing hook must not break the load: the editor still becomes
  // editable and the promise still resolves (Editor.jsx's `.then` is what
  // finishes the load and calls attach).
  let resolved = false
  await appendChunks({
    rest: ['丁\n'],
    view,
    parseMarkdown: parseEditorMarkdown,
    isDestroyed: () => false,
    getEditable: () => true,
    onChunksApplied: () => { throw new Error('hook exploded') }
  }).then(() => { resolved = true })
  assert.equal(resolved, true, 'a throwing completion hook still resolves the load')
  assert.equal(view.dom.contentEditable, 'true', 'and still restores editability')
}

// ===========================================================================
// Case 9: diffReplaceRegions, directly.
// ===========================================================================
// Small hand-checkable documents for the properties the big fixtures can only
// sample: the no-op, a pure insertion, a pure deletion, the interior
// narrowing, and the resync that must NOT be fooled by a repeated paragraph.
{
  const p = (t) => editorSchema.node('paragraph', null, t ? editorSchema.text(t) : null)
  const doc = (...children) => editorSchema.node('doc', null, children)

  assert.deepEqual(diffReplaceRegions(doc(p('a'), p('b')), doc(p('a'), p('b'))), [],
    'equal documents produce no regions')

  const inserted = diffReplaceRegions(doc(p('a'), p('c')), doc(p('a'), p('b'), p('c')))
  assert.equal(inserted.length, 1)
  assert.deepEqual(
    { nodesFrom: inserted[0].nodesFrom, nodesTo: inserted[0].nodesTo },
    { nodesFrom: 0, nodesTo: 1 },
    'a pure insertion replaces zero old nodes with one new one'
  )

  const deleted = diffReplaceRegions(doc(p('a'), p('b'), p('c')), doc(p('a'), p('c')))
  assert.equal(deleted.length, 1)
  assert.deepEqual({ nodesFrom: deleted[0].nodesFrom, nodesTo: deleted[0].nodesTo }, { nodesFrom: 1, nodesTo: 0 })

  // Interior narrowing: one paragraph against one paragraph of the same
  // markup narrows to the differing characters, not the whole node.
  const narrowed = diffReplaceRegions(doc(p('甲乙丙')), doc(p('甲丁丙')))
  assert.equal(narrowed.length, 1)
  assert.equal(narrowed[0].to - narrowed[0].from, 1,
    'a one-character interior difference costs one position, not the whole paragraph')

  // The resync must confirm with the NEXT pair: a document full of identical
  // paragraphs would otherwise resync onto the wrong one.
  const repeated = diffReplaceRegions(
    doc(p('x'), p('x'), p('x'), p('tail')),
    doc(p('x'), p('x'), p('x'), p('x'), p('tail'))
  )
  assert.equal(repeated.length, 1, 'a repeated run resyncs once, not per paragraph')

  // Round-trip: applying the regions to a live view yields the target doc.
  for (const [from, to] of [
    [doc(p('a'), p('c')), doc(p('a'), p('b'), p('c'))],
    [doc(p('a'), p('b'), p('c')), doc(p('a'), p('c'))],
    [doc(p('甲乙丙')), doc(p('甲丁丙'))],
    [doc(p('x'), p('x'), p('x'), p('tail')), doc(p('x'), p('x'), p('x'), p('x'), p('tail'))],
    [doc(p('a')), doc(p('a'), p('b'), p('c'), p('d'))],
    [doc(p('a'), p('b'), p('c'), p('d')), doc(p('a'))]
  ]) {
    const view = makeView(from)
    const dispatched = []
    const inner = view.dispatch.bind(view)
    view.dispatch = (tr) => { dispatched.push(tr); inner(tr) }
    reconcileProjectionRegions({ view, newDoc: to, regions: diffReplaceRegions(from, to) })
    assert.ok(view.state.doc.eq(to), 'the region replay must reach the target document')
    assert.equal(dispatched.length, 1, 'the whole repair is ONE transaction')
    assert.equal(dispatched[0].getMeta('addToHistory'), false)
    assert.ok(dispatched[0].getMeta('sourceProjection'))
  }
}

if (BUDGET) {
  console.log('\n  one-time cost (headless, real editor parse chain):')
  for (const row of timings) {
    console.log(`    ${row.fixture.padEnd(34)} chunks=${String(row.chunks).padStart(2)} regions=${String(row.regions).padStart(2)} ` +
      `touched=${row.touchedPct}% kept=${row.keptPct}% repair=${row.repairMs}ms attach=${row.attachMs}ms total=${row.repairMs + row.attachMs}ms`)
  }
}

console.log('kernel chunk attach: OK')
