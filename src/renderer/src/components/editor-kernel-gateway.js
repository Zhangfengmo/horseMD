// Gateway: pure classification of ProseMirror transactions + commits (plain
// text, task-checkbox toggle, code-block language switch) into the source
// kernel (kernel-mode integration Plan 2 Task 3, extended by Plan 3 Task 4).
//
// This module imports NOTHING from electron/react/@milkdown — only
// `../lib/source-kernel` (KERNEL_CODES, applySourceTransaction, the pure
// command functions) and plain ProseMirror step/model objects passed in by
// the caller. It does not talk to a live EditorView, does not read
// `crepe.*`, and does not dispatch anything itself; the Editor-side wiring
// (Task 5) is the only place that calls into a live view.
//
// classifyTransactions() re-derives the same "is this a plain,
// single-textblock edit" guard that src/renderer/src/lib/source-transaction-sync.js
// (:158-260) used for its legacy raw-text-matching path (relaxed for marked
// textblocks since P4-3.5 — see textblockProfile below; the legacy file keeps
// its own stricter copy), but reimplements it
// directly against PM Step/Node objects — it deliberately does NOT reuse
// that file's text-search/blockHints machinery (that belongs to the legacy
// fallback, not the kernel path). Where the two diverge: the legacy path had
// to grep the raw Markdown for a matching slot because it had no proven
// position map; this gateway has one (`buildProjectionMap`'s `pmPosToRaw`,
// Task 1) and defers all raw-coordinate work to `commitPlainText`.
import { KERNEL_CODES, applySourceTransaction, buildSyntaxIndex, toggleTaskMarker, changeCodeLanguage } from '../lib/source-kernel/index.js'

// A step's slice counts as "plain text" only if it is exactly a run of
// unmarked text nodes with no open ends (no partial node straddling the
// slice boundary) and no line breaks (a hardbreak/newline inside the slice
// is structural content the raw kernel commands own, not a byte-for-byte
// text edit) — UNLESS the slice targets a `code_block` textblock
// (`allowNewline`, Plan 3 Task 4): CodeMirror's own `forwardUpdate` (the
// bridge that mirrors a CM6 edit into the PM `code_block` node) issues plain
// `ReplaceStep`s whose inserted text carries a bare `'\n'` for a multi-line
// CM edit — there is no separate hardbreak node inside a code block's `text*`
// content model, the newline IS the text. `commitPlainText` below is what
// turns each such break into the raw bytes (line ending + the block's own
// per-line prefix) this actually has to become on disk. A '\r' IS accepted
// under `allowNewline` (2026-08-17, CRLF un-narrowing): the CRLF bridge
// patch (`editor-codeblock-crlf.js`) rewrites every break CM inserts into
// the block's own dominant ending BEFORE the ReplaceStep is built, so a
// CRLF/lone-CR block's slice legitimately carries '\r\n'/'\r'. Refusing it
// here made every such block permanently unwritable. `commitPlainText`
// below still proves, per break, that its spelling matches the raw source's
// own `charMap.lineEnding` — a mismatch is refused there, so nothing
// unproven gets through. Mirrors source-transaction-sync.js's
// `plainSliceText` (:22-36) but is redefined here so this module has no
// dependency on that file's raw-matching helpers.
const plainSliceText = (slice, { allowNewline = false } = {}) => {
  if (!slice || slice.size === 0 || slice.content?.size === 0) return ''
  if (slice.openStart || slice.openEnd) return null
  let text = ''
  let valid = true
  slice.content.forEach((node) => {
    if (!node?.isText || (node.marks && node.marks.length)) {
      valid = false
      return
    }
    text += node.text || ''
  })
  if (!valid) return null
  if (allowNewline) return text
  if (/[\r\n]/.test(text)) return null
  return text
}

// Textblock inline profile (P4-3.5, Fix B — replaces the old blanket
// `isPlainTextblock` refusal): a textblock qualifies for the plain-text path
// when every inline child is TEXT (marked or not). Non-text inline content
// (inline images, hard breaks, …) stays out of scope exactly as before —
// those atoms' raw syntax spans make byte-for-byte step translation
// unprovable here. Marks alone no longer disqualify the block: after P4-3
// made mark toggles real, "bold a word, then type anywhere in that
// paragraph" refused every keystroke with a toast — the relaxation lets the
// plain parts of a marked paragraph type normally while two guards keep the
// byte contract closed:
//  1. the inserted slice itself must still be PLAIN (`plainSliceText` above)
//     — typing INSIDE a mark run inherits the mark, so the storedMarks/
//     mark-inheritance trap stays refused;
//  2. a DELETION/replacement range must not partially overlap any marked
//     run (`stepRespectsMarkedRuns` below) — a range crossing INTO a run
//     would delete content while stranding its delimiters ('a **' — the
//     P4-2 probed corruption shape).
const textblockProfile = (node) => {
  if (!node?.isTextblock) return null
  let allText = true
  let hasMarkedRun = false
  node.forEach((child) => {
    if (!child?.isText) allText = false
    else if (child.marks && child.marks.length) hasMarkedRun = true
  })
  return allText ? { hasMarkedRun } : null
}

// Guard 2 of the relaxation above: for a range step [from, to) inside a
// textblock that carries marked runs, every marked run the range INTERSECTS
// must be either fully contained IN the range with room on BOTH sides
// (`from < runFrom && to > runTo` — the raw range then provably covers the
// run's delimiters too, via the gap-aware from/to resolvers) or fully
// containing the range (`from >= runFrom && to <= runTo` — a pure content
// edit inside one run; deleting a run's EXACT content leaves empty
// delimiters '****', the pinned byte-consistent P4-2 outcome). An exact-edge
// straddle (range starting/ending precisely ON a run boundary while crossing
// the other side) resolves its raw offsets INSIDE the delimiters on one
// side only — orphaning them — and is refused.
const stepRespectsMarkedRuns = (parent, blockContentStart, from, to) => {
  let offset = blockContentStart
  let ok = true
  parent.forEach((child) => {
    const runFrom = offset
    const runTo = offset + child.nodeSize
    offset = runTo
    if (!child.isText || !child.marks || !child.marks.length) return
    if (to <= runFrom || from >= runTo) return // no intersection
    const insideRun = from >= runFrom && to <= runTo
    const containsRun = from < runFrom && to > runTo
    if (!insideRun && !containsRun) ok = false
  })
  return ok
}

// Flattens every ReplaceStep across every changed transaction, in order,
// validating each one against the plain/single-textblock guard. Returns
// `null` the instant any step fails to qualify (fail-closed — one
// unsupported step blocks the whole batch, it never silently drops it).
// Each step is checked against `tr.docs[index]`, the actual PM `Node` that
// step was applied against (the doc BEFORE that specific step) — for a
// multi-step transaction this is NOT `oldState.doc` for every step after
// the first, since step N's positions are already expressed in the
// doc-after-step-(N-1) coordinate space. That per-step doc is exactly what
// prosemirror-transform records for this purpose (`Transform.docs`, see
// node_modules/prosemirror-transform/dist/index.d.ts:295).
function extractPlainTextSteps(transactions, oldState) {
  const steps = []
  let expectedBefore = oldState?.doc || null
  for (const tr of transactions) {
    if (!tr || !tr.docChanged) continue
    // Each transaction in the batch must chain from the doc the previous
    // one produced (or, for the first one, from `oldState.doc`) — otherwise
    // the steps' per-index `tr.docs[i]` coordinates aren't provably rooted
    // in the doc the caller says this batch started from.
    if (expectedBefore && tr.before && typeof tr.before.eq === 'function' && !tr.before.eq(expectedBefore)) {
      return null
    }
    expectedBefore = tr.doc || expectedBefore
    if (!Array.isArray(tr.steps) || !tr.steps.length) return null
    for (let index = 0; index < tr.steps.length; index += 1) {
      const step = tr.steps[index]
      if (step?.constructor?.name !== 'ReplaceStep') return null
      if (!Number.isFinite(step.from) || !Number.isFinite(step.to)) return null
      const stepDoc = tr.docs?.[index]
      if (!stepDoc) return null
      let $from
      let $to
      try {
        $from = stepDoc.resolve(step.from)
        $to = stepDoc.resolve(step.to)
      } catch {
        return null
      }
      if (!$from.sameParent($to)) return null
      const profile = textblockProfile($from.parent)
      if (!profile) return null
      if (profile.hasMarkedRun && step.from < step.to &&
          !stepRespectsMarkedRuns($from.parent, $from.start(), step.from, step.to)) {
        return null
      }
      const allowNewline = $from.parent.type?.name === 'code_block'
      const insertText = plainSliceText(step.slice, { allowNewline })
      if (insertText == null) return null
      steps.push({ from: step.from, to: step.to, insertText })
    }
  }
  return steps
}

// Detects the task-checkbox click shape: `@milkdown/components`'
// `listItemBlockView` (list-item-block/view.ts `setAttr`) toggles a task
// item's checked state with a bare `tr.setNodeAttribute(pos, 'checked', v)`
// — never through a keymap, so `structuralHandler`'s Enter/Tab/Backspace/
// Delete routing never sees it, and it is not a `ReplaceStep` so
// `extractPlainTextSteps` correctly refuses to treat it as plain text. Left
// unclassified, this batch fell through to `blocked`/`INPUT_TYPE` and the
// dispatch-veto channel silently discarded every checkbox click in kernel
// mode (the PM view was reverted, no error, no visible change — see
// docs/... kernel-mode task-toggle root cause). This function proves the
// batch is EXACTLY one `AttrStep` on a `checked` attribute of a `list_item`
// node, nothing else riding along; `commitTaskToggle` (below) re-derives the
// same shape independently rather than trusting a caller-supplied result,
// matching this file's other commit functions.
function extractTaskToggleStep(transactions, oldState) {
  const changed = transactions.filter((tr) => tr && tr.docChanged)
  if (changed.length !== 1) return null
  const tr = changed[0]
  if (!Array.isArray(tr.steps) || tr.steps.length !== 1) return null
  const step = tr.steps[0]
  if (step?.constructor?.name !== 'AttrStep' || step.attr !== 'checked') return null
  if (!Number.isFinite(step.pos)) return null
  const stepDoc = tr.docs?.[0] || oldState?.doc
  if (!stepDoc) return null
  let node
  try {
    node = stepDoc.nodeAt(step.pos)
  } catch {
    return null
  }
  if (!node || node.type?.name !== 'list_item') return null
  return { pos: step.pos }
}

// Detects the code-block language-switch AttrStep shape (Plan 3 Task 4): a
// language picker (the CM toolbar, wired in a later task) dispatches
// `tr.setNodeAttribute(pos, 'language', v)` on a `code_block` node — exactly
// like the checkbox click above, never through a keymap and never a
// `ReplaceStep`, so neither `structuralHandler` nor `extractPlainTextSteps`
// ever sees it. Proves the same shape `extractTaskToggleStep` proves for its
// own attribute (ONE transaction, ONE `AttrStep`, the right `attr` name, a
// PM node of the expected type at `step.pos`).
//
// BIDIRECTIONAL (final-review fix, 2026-08-16): a code_block whose CURRENT
// (pre-switch) language Crepe renders as a preview (mermaid/latex —
// `READONLY_CODE_LANGUAGES`, shared with editor-kernel-projection-map.js so
// the two stay in lockstep) is no longer refused here. The original refusal
// assumed there was "no raw anchor `commitCodeLanguage` could resolve its
// fence-rewrite offset from" for such a block — but `commitCodeLanguage`
// (below) already has a null-charMap fallback anchor (the pair's own
// `mdBlock.position.start.offset`, the fence's own start), which resolves a
// `changeCodeLanguage` offset just as well as a charMap-derived one: the
// command only needs an offset that `index.blockAt` resolves to the SAME
// code block, and the fence start always does. Refusing this direction was
// therefore a one-way door with no correctness reason behind it — a `js`
// block can freely become `mermaid` (this file always allowed that: the
// CURRENT language there is not readonly), but the reverse (`mermaid` ->
// `js`) was blocked. Lifting the guard makes the switch symmetric: once the
// switch commits, `editor-kernel-mode.js`'s `code-language` case
// unconditionally rebinds the projection map (see its own comment), so the
// pair's `charMap` is freshly (re-)evaluated against the NEW language and
// the block becomes genuinely editable immediately — the very next commit
// into it goes through the ordinary plain-text path.
function extractLanguageStep(transactions, oldState) {
  const changed = transactions.filter((tr) => tr && tr.docChanged)
  if (changed.length !== 1) return null
  const tr = changed[0]
  if (!Array.isArray(tr.steps) || tr.steps.length !== 1) return null
  const step = tr.steps[0]
  if (step?.constructor?.name !== 'AttrStep' || step.attr !== 'language') return null
  if (!Number.isFinite(step.pos)) return null
  const stepDoc = tr.docs?.[0] || oldState?.doc
  if (!stepDoc) return null
  let node
  try {
    node = stepDoc.nodeAt(step.pos)
  } catch {
    return null
  }
  if (!node || node.type?.name !== 'code_block') return null
  return { pmPos: step.pos, language: String(step.value ?? '') }
}

// PM mark name -> kernel inline-mark kind (Plan 4 Task 3). Names probed from
// the LIVE schema sources, not guessed:
//  - @milkdown/preset-commonmark: $markSchema("strong") / $markSchema("emphasis")
//    / $markSchema("inlineCode") / $markSchema("link")
//  - @milkdown/preset-gfm: $markSchema("strike_through")
//  - editor-highlight.js: $markSchema('highlight') (attrs.color, default 'yellow')
// `link` is deliberately ABSENT: `[text](url)` needs the URL-input UI flow
// (plan Global Constraints) — a link toggle falls through to `blocked`/
// INPUT_TYPE. A highlight whose color is not 'yellow' is also refused at
// classification (see extractMarkToggle): only the pure `==text==` byte form
// is kernel-ownable — that is the form P5-3 taught the kernel chain to parse
// (lib/source-kernel/highlight-syntax.js), so a yellow toggle now COMMITS
// instead of being refused downstream by `requireMap`. Red/blue keep
// round-tripping as `<mark class="hm-hl-…">` inline HTML, which the kernel
// coalesces into ONE atom while ProseMirror holds an N-character marked run —
// a size disagreement that degrades the block to read-only (pinned in
// scripts/test-kernel-projection-map.mjs Case P3c). Supporting it would mean
// special-casing the SHARED inline-HTML run rule and teaching the toggle
// command to write tag bytes; explicitly out of scope for stage 3.
const MARK_TOGGLE_KINDS = Object.freeze({
  strong: 'strong',
  emphasis: 'emphasis',
  strike_through: 'delete',
  inlineCode: 'inlineCode',
  highlight: 'highlight'
})

// Detects the toolbar/keymap/context-menu mark-toggle shape (Plan 4 Task 3):
// PM's `toggleMark` (Crepe toolbar buttons via toggleStrongCommand & friends,
// HorseMD's own applyTextFormat/applyHighlightInView, the preset Mod-b/Mod-i/
// Mod-e/Mod-Alt-x keymaps) dispatches ONE transaction whose steps are purely
// AddMarkStep(s) OR purely RemoveMarkStep(s) of ONE mark type. Multiple steps
// occur when the range spans text-node boundaries PM could not merge into a
// single step; contiguous same-mark runs are coalesced into one [from, to)
// range. Anything else — a gap between steps (toggleMark skipping an
// already-marked middle segment, or a cross-block selection whose steps jump
// the block boundary), mixed add+remove (applyHighlightInView's color-replace
// shape), mixed mark types — returns null and falls through to `blocked`
// (fail-closed; the kernel command can only prove a single contiguous span).
//
// Mark steps never displace positions (no content is inserted or removed),
// so every step of the transaction shares ONE coordinate space — the
// pre-batch doc's — and the single-textblock guard resolves the coalesced
// range against `tr.docs[0]` (== oldState.doc for a lone transaction)
// without any delta arithmetic. The parent textblock is NOT required to be
// mark-free: toggling a mark in a paragraph that already carries
// other marks is exactly the unwrap/nesting shape `toggleInlineMark` owns
// (it re-proves everything against the raw bytes; a shape it cannot own
// refuses with its own code).
function extractMarkToggle(transactions, oldState) {
  const changed = transactions.filter((tr) => tr && tr.docChanged)
  if (changed.length !== 1) return null
  const tr = changed[0]
  if (!Array.isArray(tr.steps) || !tr.steps.length) return null
  let stepType = null
  let markName = null
  let markAttrs = null
  let from = null
  let to = null
  for (const step of tr.steps) {
    const name = step?.constructor?.name
    if (name !== 'AddMarkStep' && name !== 'RemoveMarkStep') return null
    if (stepType && name !== stepType) return null
    stepType = name
    const mark = step.mark
    const typeName = mark?.type?.name
    if (!typeName) return null
    if (markName && typeName !== markName) return null
    markName = typeName
    markAttrs = mark.attrs || null
    if (!Number.isFinite(step.from) || !Number.isFinite(step.to) || step.to <= step.from) return null
    if (from == null) {
      from = step.from
      to = step.to
    } else if (step.from === to) {
      to = step.to
    } else {
      return null // non-contiguous: a skipped segment or a cross-block jump
    }
  }
  const kind = MARK_TOGGLE_KINDS[markName]
  if (!kind) return null
  if (markName === 'highlight' && markAttrs?.color && markAttrs.color !== 'yellow') return null
  const docNode = tr.docs?.[0] || oldState?.doc
  if (!docNode) return null
  let $from
  let $to
  try {
    $from = docNode.resolve(from)
    $to = docNode.resolve(to)
  } catch {
    return null
  }
  if (!$from.sameParent($to) || !$from.parent.isTextblock) return null
  return { pmFrom: from, pmTo: to, markName, markKind: kind, add: stepType === 'AddMarkStep' }
}

// Detects `@milkdown/plugin-trailing`'s own append: ONE transaction whose
// single ReplaceStep inserts exactly one EMPTY paragraph at the very end of
// the document (from === to === the step-doc's content size). Crepe ships
// that plugin unconditionally; its appendTransaction can ride any dispatch
// batch (even a selection-only click) the moment the doc's last child is a
// non-paragraph block. Left unclassified this fell through to
// `blocked`/`INPUT_TYPE` and the dispatch-veto channel would refuse the
// plugin's own convenience paragraph — vetoing a batch the user never
// authored. The shape is view-only (an empty paragraph has no markdown
// bytes), so the kernel lets it through without any byte commit; the
// projection map's trailing-placeholder tolerance pairs it.
function extractTrailingAppend(transactions) {
  const changed = transactions.filter((tr) => tr && tr.docChanged)
  if (changed.length !== 1) return null
  const tr = changed[0]
  if (!Array.isArray(tr.steps) || tr.steps.length !== 1) return null
  const step = tr.steps[0]
  if (step?.constructor?.name !== 'ReplaceStep') return null
  const stepDoc = tr.docs?.[0]
  if (!stepDoc) return null
  if (step.from !== step.to || step.from !== stepDoc.content.size) return null
  const slice = step.slice
  if (!slice || slice.openStart || slice.openEnd) return null
  if (slice.content?.childCount !== 1) return null
  const node = slice.content.firstChild
  if (!node || node.type?.name !== 'paragraph' || node.content?.size !== 0) return null
  return { at: step.from }
}

// classifyTransactions: pure triage of a dispatch batch into one of eight
// kinds. Order matters — it is priority, not just an enum listing:
//   1. `sourceProjection` meta marks a transaction the caller itself built
//      FROM a kernel/raw commit (e.g. a projection reconciler replaying the
//      kernel's text into the PM doc) — that provenance is authoritative
//      regardless of whether the batch also happens to look like plain text,
//      is mid-composition, or carries no doc change at all. Reconciler-
//      generated transactions are self-authored and can never carry drop
//      meta, so this stays first without conflicting with rule 2.
//   2. `uiEvent === 'drop'` is an explicit, unconditional block — checked
//      BEFORE the composition label. A drop is never a legitimate part of
//      an IME composition; if it ran after the composition check, a stale
//      `isComposing: true` flag (e.g. a composition that never received its
//      compositionend before a drop landed) could let a drop through as a
//      no-op pass-through instead of being refused, mutating the view
//      without any kernel bookkeeping. Drag-drop content is never treated
//      as plain text either, even if its slice would otherwise qualify —
//      spec'd explicitly in the Task 3 brief.
//   3. `isComposing` is a caller-supplied label (IME mid-composition); the
//      gateway does not try to infer composition state itself, so once the
//      caller says so (and it isn't a drop), that's final, ahead of the
//      docChanged gate below (a composition update can legitimately have
//      `docChanged: false` for a no-op composition tick).
//   4. No transaction changed the doc → selection-only (caret/selection
//      moves, no kernel involvement at all).
//   5. A lone `AttrStep` flipping a `list_item`'s `checked` attribute is the
//      task-checkbox click shape (see `extractTaskToggleStep` above) — tried
//      before the plain-text guard since it is never a `ReplaceStep` batch
//      and would otherwise fall through to `blocked`/`INPUT_TYPE`.
//   6. A lone `AttrStep` setting a `code_block`'s `language` attribute is the
//      language-switch shape (see `extractLanguageStep` above) — same reason
//      as rule 5, checked right alongside it (both are AttrStep shapes the
//      plain-text ReplaceStep guard can never match).
//   7. The trailing plugin's own empty-paragraph append (see
//      `extractTrailingAppend` above) — view-only, no kernel bytes, must not
//      be vetoed.
//   8. A pure AddMarkStep/RemoveMarkStep batch over one textblock range is
//      the toolbar/keymap mark-toggle shape (see `extractMarkToggle` above)
//      — tried BEFORE the plain-text guard (a mark step is never a
//      ReplaceStep, so it would otherwise fall through to `blocked`), AFTER
//      the projection/drop/composition rules and the docChanged gate (a
//      stored-marks-only toggle on an empty selection has `docChanged:
//      false` and stays `selection-only`; the dispatch channel never even
//      consults the gateway for it — see editor-kernel-mode.js's
//      `marksKeymap` guard for how empty-selection shortcuts are handled).
//   9. Otherwise, try the plain-text step guard; anything it can't prove is
//      `blocked` with `INPUT_TYPE` (the single "docChanged but unsupported"
//      code per the brief — this gateway does not attempt finer-grained
//      block reasons for the plain-text path; ProjectionReconciler/dispatch
//      veto own retry/fallback semantics upstream of this function).
export function classifyTransactions(transactions, oldState, { isComposing = false } = {}) {
  const trs = Array.isArray(transactions) ? transactions : [transactions]

  if (trs.some((tr) => tr && typeof tr.getMeta === 'function' && tr.getMeta('sourceProjection'))) {
    return { kind: 'projection' }
  }
  if (trs.some((tr) => tr && typeof tr.getMeta === 'function' && tr.getMeta('uiEvent') === 'drop')) {
    return { kind: 'blocked', blockedCode: KERNEL_CODES.INPUT_TYPE }
  }
  if (isComposing) return { kind: 'composition' }

  const changed = trs.some((tr) => tr && tr.docChanged)
  if (!changed) return { kind: 'selection-only' }

  const taskToggle = extractTaskToggleStep(trs, oldState)
  if (taskToggle) return { kind: 'task-toggle', pos: taskToggle.pos }

  const languageStep = extractLanguageStep(trs, oldState)
  if (languageStep) return { kind: 'code-language', pmPos: languageStep.pmPos, language: languageStep.language }

  const trailingAppend = extractTrailingAppend(trs)
  if (trailingAppend) return { kind: 'trailing-append', at: trailingAppend.at }

  const markToggle = extractMarkToggle(trs, oldState)
  if (markToggle) return { kind: 'mark-toggle', ...markToggle }

  const steps = extractPlainTextSteps(trs, oldState)
  if (!steps || !steps.length) return { kind: 'blocked', blockedCode: KERNEL_CODES.INPUT_TYPE }

  return { kind: 'plain-text', steps }
}

// True when `rawOffset` sits strictly INSIDE a '\r\n' line ending, i.e. on the
// boundary between a `char` unit holding the '\r' and the `linebreak` unit
// holding the '\n'. Used by `commitPlainText`'s bisection guard (see its call
// site for the corruption shapes this refuses).
//
// The cheap text test is the fast path AND a necessary condition; the unit
// walk is what actually PROVES the offset is that boundary in THIS block's
// map (rather than, say, a '\r\n' that happens to sit in surrounding source).
// charMap shapes without a `units` array (virtualCharMap, hand-built maps in
// older tests) can carry no such boundary and answer `false`.
function bisectsLineEnding(charMap, text, rawOffset) {
  if (!charMap || typeof text !== 'string' || !Number.isFinite(rawOffset)) return false
  if (text.charCodeAt(rawOffset - 1) !== 13 || text.charCodeAt(rawOffset) !== 10) return false
  const units = charMap.units
  if (!Array.isArray(units)) return false
  for (let index = 0; index < units.length - 1; index += 1) {
    const unit = units[index]
    const next = units[index + 1]
    if (unit?.kind !== 'char' || next?.kind !== 'linebreak') continue
    if (unit.rawEnd === rawOffset && next.rawStart === rawOffset) return true
  }
  return false
}

// commitPlainText: turns a `plain-text`-classified batch into ONE kernel
// transaction and applies it. Independently re-derives the step list (it
// does not trust a caller-supplied `classification.steps` — this function's
// own contract is "given transactions/oldState, either produce a proven
// kernel commit or a code", so it re-runs the same extraction rather than
// assume the caller already classified correctly).
//
// PM step coordinates are per-step (see extractPlainTextSteps' doc comment)
// but `map.pmPosToRaw` was built against the SINGLE old doc the caller holds
// (`oldState.doc`, the doc before ALL of this batch's steps). For a
// multi-step transaction, step N (N>0) reports its `from`/`to` in the
// doc-after-step-(N-1) coordinate space, so each step's positions are
// shifted back to old-doc coordinates by subtracting the cumulative PM delta
// (inserted length − removed length) of every step already folded in. This
// is manual delta arithmetic rather than `tr.mapping.invert()` because the
// steps here are proven non-overlapping and strictly ascending (each step's
// `from` sits at or after the previous step's `to` in its own coordinate
// space) — the same running-delta shape `markdown-document.js`'s
// `applySourceTransaction`/`trailingCaret` already use for its own
// sequential-edits bookkeeping, kept consistent across the kernel boundary.
export function commitPlainText({ kernel, map, transactions, oldState }) {
  if (!kernel?.doc || !map || typeof map.pmPosToRaw !== 'function' ||
      typeof map.pmPosToRawStart !== 'function') {
    return { ok: false, code: KERNEL_CODES.UNMAPPED }
  }
  const trs = Array.isArray(transactions) ? transactions : [transactions]
  const steps = extractPlainTextSteps(trs, oldState)
  if (!steps || !steps.length) return { ok: false, code: KERNEL_CODES.INPUT_TYPE }

  const edits = []
  let cumulativeDelta = 0
  const prefixedVirtualBlocks = new Set()
  for (const step of steps) {
    const oldFrom = step.from - cumulativeDelta
    const oldTo = step.to - cumulativeDelta
    // Virtual block (trailing placeholder / split placeholder / empty list
    // item — see editor-kernel-projection-map.js): the decision is made by
    // PM position (unique), never by raw offset (a virtual pair's raw anchor
    // can coincide with a real block's end in a doc without a final
    // newline). The insert lands at the pair's raw anchor, prefixed with the
    // separator bytes the pair demands (e.g. a blank line after a trailing
    // list so the typed text parses as a new paragraph, not a lazy
    // continuation of the last item).
    const virtualBlock = typeof map.virtualBlockAt === 'function' && oldFrom === oldTo
      ? map.virtualBlockAt(oldFrom)
      : null
    // The separator prefix is latched to the FIRST qualifying insert per
    // virtual pair within this batch: a multi-step transaction typing 'ab'
    // into the trailing paragraph rebases BOTH steps to the pair's content
    // position (the unwind subtracts each step's own delta), so an
    // unlatched prefix would emit '\na' + '\nb' — two source paragraphs
    // for what PM shows as one — and force a verify repair that
    // restructures the user's typing. Latched, the batch commits
    // '\na' + 'b': one paragraph, cheap-path verify passes.
    const virtualPrefix = virtualBlock && !prefixedVirtualBlocks.has(oldFrom)
      ? virtualBlock.prefix
      : ''
    if (virtualBlock) prefixedVirtualBlocks.add(oldFrom)
    // A genuine (non-empty) selection's LEFT edge is resolved through the
    // gap-aware `pmPosToRawStart`, never plain `pmPosToRaw` — see
    // character-map.js's ADR comment on `buildCharacterMap` for the byte
    // corruption this specifically fixes (typing over a selected, already-
    // marked word used to silently eat its opening marker). A zero-width
    // step (`oldFrom === oldTo`, a bare caret insert) resolves BOTH ends
    // through ONE resolver — `pmPosToRawInsert` (P4-3.5, Fix B), the
    // marker-gap-NEUTRAL point: the slice was proven PLAIN above, so a char
    // typed at a mark run's boundary must land OUTSIDE the run's delimiters
    // ('a **bold**' + plain X at the run's end -> 'a **bold**X', never
    // 'a **boldX**'), and between two adjacent runs it lands between their
    // marker bytes. At every gap-free boundary (all previously-typeable
    // content) the neutral resolver returns exactly the old `pmPosToRaw`
    // value. Using one resolver for both ends keeps `rawFrom === rawTo`
    // structurally (never a spurious non-zero-width edit); the legacy
    // `pmPosToRaw` fallback covers hand-built maps in older tests.
    const insertPoint = typeof map.pmPosToRawInsert === 'function'
      ? map.pmPosToRawInsert
      : map.pmPosToRaw
    const rawFrom = virtualBlock
      ? virtualBlock.raw
      : oldFrom < oldTo ? map.pmPosToRawStart(oldFrom) : insertPoint(oldFrom)
    const rawTo = virtualBlock
      ? virtualBlock.raw
      : oldFrom < oldTo ? map.pmPosToRaw(oldTo) : insertPoint(oldFrom)
    if (!Number.isFinite(rawFrom) || !Number.isFinite(rawTo) || rawFrom > rawTo) {
      return { ok: false, code: KERNEL_CODES.UNMAPPED }
    }
    // CRLF bisection guard (review finding, 2026-08-17) — the DELETE-side
    // half of the same contract the break-spelling check above enforces for
    // inserts. A code `charMap` deliberately models a '\r\n' ending as TWO
    // units (a `char` unit for the '\r', then the `linebreak` unit for the
    // '\n', which also spans the next line's prefix — see code-map.js), so
    // it legitimately exposes a boundary BETWEEN them. Any raw offset landing
    // there bisects the pair. Reviewer-probed shapes on
    // '```js\r\nab\r\ncd\r\n```\r\n' (content 'ab\r\ncd' from PM 1):
    //  - delete PM[4,5) (the '\n' alone) -> raw [10,11): leaves a lone '\r';
    //  - delete PM[3,4) (the '\r' alone) -> raw [9,10): leaves a bare '\n',
    //    i.e. mixed endings inside a uniform-CRLF file;
    //  - the quoted-fence version is the worst: the `linebreak` unit's raw
    //    span carries the next line's '> ' prefix, so deleting the '\n' half
    //    eats the prefix while the lone '\r' survives as a line terminator —
    //    line 2 silently loses its quote marker.
    // None of these is reachable through today's UI (the patched bridge's
    // `cmToPm` never returns an interior offset, and find/replace cannot
    // produce a code_block-parented step) — but that defence lives in a
    // prototype patch in ANOTHER module. This file owns the byte contract, so
    // it proves it here rather than inheriting it. A correctly shaped
    // full-pair delete (PM[3,5) -> raw [9,11)) is untouched: neither end sits
    // between the two units.
    if (!virtualBlock) {
      const pair = typeof map.pairAt === 'function' ? map.pairAt(oldFrom) : null
      const text = kernel.doc.text
      if (bisectsLineEnding(pair?.charMap, text, rawFrom) ||
          bisectsLineEnding(pair?.charMap, text, rawTo)) {
        return { ok: false, code: KERNEL_CODES.UNMAPPED }
      }
      // Table cell (Plan 5 Task 4): inside a GFM cell the `|` byte is the
      // COLUMN DELIMITER, so writing a literal one would split the cell — the
      // raw source would grow a column the ProseMirror doc does not have, and
      // the next reparse would show a differently-shaped table than the one
      // the user was typing into. Adding/removing columns is explicitly out of
      // this phase's scope, so fail closed rather than commit bytes whose
      // reparse changes the structure. (A line break can't reach here: the
      // `allowNewline` relaxation in `plainSliceText` is granted only to
      // `code_block` textblocks. The DELETE side needs no guard — a cell
      // pair's charMap covers only that cell's content units, so every
      // resolved raw range is already confined between its delimiters.)
      if (pair?.tableCell && step.insertText.includes('|')) {
        return { ok: false, code: KERNEL_CODES.UNSUPPORTED }
      }
    }
    if (edits.length && rawFrom < edits[edits.length - 1].to) {
      // A later step's mapped raw range starts before the previous step's
      // raw range ended — the proven mapping disagrees with the steps'
      // PM-side ordering. Refuse rather than build an out-of-order/
      // overlapping kernel edit list (applySourceTransaction itself also
      // rejects this, but failing here keeps the reported code UNMAPPED
      // instead of the kernel's generic invalid-range).
      return { ok: false, code: KERNEL_CODES.UNMAPPED }
    }
    // Code-block line-break expansion (Plan 3 Task 4; CRLF un-narrowing
    // 2026-08-17). `step.insertText` can carry a line break only when its
    // target textblock is a `code_block` (`extractPlainTextSteps`'
    // `allowNewline` guard). A raw byte-for-byte insert of the break alone
    // would silently break a quoted/indented fence's per-line prefix
    // contract (`buildCodeMap` requires EVERY content line to reproduce the
    // same prefix byte-for-byte), so each break must become
    // `lineEnding + linePrefix` — the exact bytes `buildCodeMap` already
    // proved every OTHER content line in this block uses. `pairAt` (never
    // virtual: `virtualBlockAt` above only ever matches trailing/split
    // placeholders and empty list items, none of which are `code_block`s)
    // resolves the covering pair by the same content-position search
    // `pmPosToRaw` uses internally.
    //
    // SPELLING IS PROVEN, NEVER RE-SPELLED. The CRLF bridge
    // (`editor-codeblock-crlf.js` `crlfForwardUpdate`) already converts every
    // break CM inserts into the block's dominant ending, so by the time a
    // step arrives here the PM side ALREADY holds '\r\n' for a CRLF block.
    // Re-spelling (the old `split('\n').join(ending + prefix)`) would then
    // double-convert: '\r\n' -> '\r' + '\r\n' + '' — a lone '\r' injected
    // into the source, i.e. exactly the corruption shape this whole family
    // is about. Instead every break is required to EQUAL the block's raw
    // `lineEnding` and only the prefix is added. Two shapes are refused by
    // that rule, both deliberately:
    //  - a bare '\n' in a CRLF/lone-CR block. Reachable only when the
    //    block's CURRENT text holds no '\r' (single-line or empty fence in a
    //    CRLF document): the bridge's `hasCarriageReturn` fast path then
    //    delegates to the vendored `forwardUpdate`, which always emits '\n'
    //    (CM's `Text.toString()` joins with '\n' and can never emit '\r').
    //    Committing '\r\n' to raw while PM holds '\n' would pass the kernel
    //    but fail `verifyPlainTextProjection`'s cheap-path diff on EVERY
    //    such commit — repair-reconcile churn, the P3-4 symptom. Refused
    //    (veto + toast), so the bytes and the view never diverge.
    //  - a '\r'-bearing break in an LF block. The bridge cannot produce one,
    //    so this is an unknown-provenance slice; fail closed.
    let insertText = step.insertText
    if (/[\r\n]/.test(insertText)) {
      const pair = typeof map.pairAt === 'function' ? map.pairAt(oldFrom) : null
      const codeMap = pair?.charMap
      if (!codeMap || typeof codeMap.lineEnding !== 'string' || typeof codeMap.linePrefix !== 'string') {
        return { ok: false, code: KERNEL_CODES.UNMAPPED }
      }
      const breaks = insertText.match(/\r\n|\r|\n/g) || []
      if (breaks.some((brk) => brk !== codeMap.lineEnding)) {
        return { ok: false, code: KERNEL_CODES.UNMAPPED }
      }
      insertText = codeMap.linePrefix
        ? insertText.split(codeMap.lineEnding).join(codeMap.lineEnding + codeMap.linePrefix)
        : insertText
    }
    edits.push({
      from: rawFrom,
      to: rawTo,
      insert: virtualPrefix + insertText
    })
    // PM-side delta (never the raw insert with its separator prefix, and
    // never the EXPANDED raw insert either): this rebases later steps' PM
    // coordinates, which are counted in PM's own un-normalized text units (a
    // '\n' is exactly ONE PM character, same as any other) and know nothing
    // about raw separator/expansion bytes.
    cumulativeDelta += step.insertText.length - (step.to - step.from)
  }

  const transaction = { baseRevision: kernel.doc.revision, edits, intent: 'insert-text' }
  const result = applySourceTransaction(kernel.doc, transaction)
  if (!result.ok) return { ok: false, code: result.code }
  return { ok: true, applied: result, transaction }
}

// commitTaskToggle: turns a `task-toggle`-classified batch (see
// `extractTaskToggleStep` above) into ONE `toggleTaskMarker` kernel
// transaction and applies it. Re-derives the target position's raw offset
// independently rather than trusting a caller-supplied result, same
// contract as `commitPlainText`.
//
// `pos` is the `list_item` node's own PM position (right before it, the
// `AttrStep`/`nodeAt` convention). Its raw counterpart is reached by
// stepping into the first child's content: `pos + 1` is the first child's
// own position (a task item's content is always wrapped in one `paragraph`,
// same schema shape `buildProjectionMap` pairs against), and `pos + 2` is
// that paragraph's content start, which is exactly the `contentPos` a
// `blockPairs` entry for it exposes. If the first child is anything other
// than the expected mapped textblock (a shape `buildProjectionMap` did not
// pair), `pmPosToRaw` finds no covering block and fails closed with
// `UNMAPPED` — this function never assumes the schema shape, only checks it
// through the proven map.
export function commitTaskToggle({ kernel, map, pos }) {
  if (!kernel?.doc || !map || typeof map.pmPosToRaw !== 'function') {
    return { ok: false, code: KERNEL_CODES.UNMAPPED }
  }
  if (!Number.isFinite(pos)) return { ok: false, code: KERNEL_CODES.UNMAPPED }
  const raw = map.pmPosToRaw(pos + 2)
  if (!Number.isFinite(raw)) return { ok: false, code: KERNEL_CODES.UNMAPPED }

  const index = buildSyntaxIndex(kernel.doc.text)
  const routed = toggleTaskMarker({ doc: kernel.doc, index, offset: raw })
  if (!routed.ok) return { ok: false, code: routed.code }

  const result = applySourceTransaction(kernel.doc, routed.transaction)
  if (!result.ok) return { ok: false, code: result.code }
  return { ok: true, applied: result, transaction: routed.transaction }
}

// commitCodeLanguage: turns a `code-language`-classified batch (see
// `extractLanguageStep` above) into ONE `changeCodeLanguage` kernel
// transaction and applies it. Re-derives the target block independently
// rather than trusting a caller-supplied result, same contract as
// `commitPlainText`/`commitTaskToggle`.
//
// `pmPos` is the `code_block` node's own PM position — the `AttrStep`/
// `nodeAt` convention (matching `extractLanguageStep`'s `step.pos`), NOT a
// content position, so it is looked up directly against `map.blockPairs`
// (a plain array search — the brief's "or reuse blockPairs lookup" option)
// rather than through `pairAt`, which resolves CONTENT positions. The pair
// carries its `mdBlock` (the mdast `code` node) even when `charMap` is null
// (`buildProjectionMap` always records `mdBlock`, editable or not — see its
// `pmType === 'code_block'` branch) — which is exactly what makes a switch
// FROM a currently-readonly target (mermaid/latex -> a real language) work
// now that `extractLanguageStep` no longer refuses it at classification
// time (final-review fix, 2026-08-16): a null-charMap pair falls back to
// `start` (the fence's own start offset, always present) as the anchor
// `changeCodeLanguage` resolves the block from — `index.blockAt(start)`
// finds the same code block a charMap-derived offset would, so there is no
// correctness gap. When the pair DOES carry a charMap (the common, already-
// editable case), its own content-start raw offset (`charMap.visibleToRaw(0)`)
// is passed instead, as the caret-preservation anchor — a reasonable
// stand-in for "the block's content start" since the gateway has no access
// to the live view's actual selection here (the original AttrStep
// transaction, selection untouched, is what the caller lets through to the
// view on success — see editor-kernel-mode.js's `code-language` case).
export function commitCodeLanguage({ kernel, index, map, pmPos, language }) {
  if (!kernel?.doc || !map || !Array.isArray(map.blockPairs)) {
    return { ok: false, code: KERNEL_CODES.UNMAPPED }
  }
  if (!Number.isFinite(pmPos)) return { ok: false, code: KERNEL_CODES.UNMAPPED }
  const pair = map.blockPairs.find((candidate) => candidate.pmPos === pmPos)
  const start = pair?.mdBlock?.position?.start?.offset
  if (!pair || !Number.isFinite(start)) return { ok: false, code: KERNEL_CODES.UNMAPPED }
  const anchor = pair.charMap ? pair.charMap.visibleToRaw(0) : start
  const offset = Number.isFinite(anchor) ? anchor : start

  const syntaxIndex = index || buildSyntaxIndex(kernel.doc.text)
  const routed = changeCodeLanguage({ doc: kernel.doc, index: syntaxIndex, offset, language })
  if (!routed.ok) return { ok: false, code: routed.code }

  const result = applySourceTransaction(kernel.doc, routed.transaction)
  if (!result.ok) return { ok: false, code: result.code }
  return { ok: true, applied: result, transaction: routed.transaction }
}
