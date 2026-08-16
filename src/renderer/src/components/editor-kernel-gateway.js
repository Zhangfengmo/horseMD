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
// classifyTransactions() re-derives the same "is this a plain, unmarked,
// single-textblock edit" guard that src/renderer/src/lib/source-transaction-sync.js
// (:158-260) used for its legacy raw-text-matching path, but reimplements it
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
// turns each such `'\n'` into the raw bytes (line ending + the block's own
// per-line prefix) this actually has to become on disk; a bare '\r' is
// refused even with `allowNewline` because CM never produces one (its own
// line-break representation is always '\n') and the expansion below only
// knows how to translate '\n'. Mirrors source-transaction-sync.js's
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
  if (allowNewline) {
    if (/\r/.test(text)) return null
    return text
  }
  if (/[\r\n]/.test(text)) return null
  return text
}

// A textblock counts as "plain" only if every one of its current children
// is unmarked text — an edit landing inside a block that already carries
// any formatting (bold/italic/code/link/…) is out of scope for the
// byte-for-byte text path, same guard as source-transaction-sync.js's
// `isPlainTextblock` (:38-45), reimplemented locally for the same reason as
// `plainSliceText` above.
const isPlainTextblock = (node) => {
  if (!node?.isTextblock) return false
  let valid = true
  node.forEach((child) => {
    if (!child?.isText || (child.marks && child.marks.length)) valid = false
  })
  return valid
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
      if (!$from.sameParent($to) || !isPlainTextblock($from.parent)) return null
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

// classifyTransactions: pure triage of a dispatch batch into one of seven
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
//   8. Otherwise, try the plain-text step guard; anything it can't prove is
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

  const steps = extractPlainTextSteps(trs, oldState)
  if (!steps || !steps.length) return { kind: 'blocked', blockedCode: KERNEL_CODES.INPUT_TYPE }

  return { kind: 'plain-text', steps }
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
  if (!kernel?.doc || !map || typeof map.pmPosToRaw !== 'function') {
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
    const rawFrom = virtualBlock ? virtualBlock.raw : map.pmPosToRaw(oldFrom)
    const rawTo = virtualBlock ? virtualBlock.raw : map.pmPosToRaw(oldTo)
    if (!Number.isFinite(rawFrom) || !Number.isFinite(rawTo) || rawFrom > rawTo) {
      return { ok: false, code: KERNEL_CODES.UNMAPPED }
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
    // Code-block newline expansion (Plan 3 Task 4): `step.insertText` can
    // carry a bare `'\n'` only when its target textblock is a `code_block`
    // (`extractPlainTextSteps`' `allowNewline` guard) — a raw byte-for-byte
    // insert of that '\n' would silently break a quoted/indented fence's
    // per-line prefix contract (`buildCodeMap` requires EVERY content line
    // to reproduce the same prefix byte-for-byte). Every such '\n' must
    // instead become `lineEnding + linePrefix` — the exact bytes
    // `buildCodeMap` already proved every OTHER content line in this block
    // uses. `pairAt` (never virtual: `virtualBlockAt` above only ever
    // matches trailing/split placeholders and empty list items, none of
    // which are `code_block`s) resolves the covering pair by the same
    // content-position search `pmPosToRaw` uses internally.
    let insertText = step.insertText
    if (insertText.includes('\n')) {
      const pair = typeof map.pairAt === 'function' ? map.pairAt(oldFrom) : null
      const codeMap = pair?.charMap
      if (!codeMap || typeof codeMap.lineEnding !== 'string' || typeof codeMap.linePrefix !== 'string') {
        return { ok: false, code: KERNEL_CODES.UNMAPPED }
      }
      insertText = insertText.split('\n').join(codeMap.lineEnding + codeMap.linePrefix)
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
