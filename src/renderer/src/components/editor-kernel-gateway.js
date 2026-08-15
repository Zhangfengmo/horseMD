// Gateway: pure classification of ProseMirror transactions + plain-text
// commit into the source kernel (kernel-mode integration Plan 2, Task 3).
//
// This module owns exactly two pure functions and imports NOTHING from
// electron/react/@milkdown — only `../lib/source-kernel` (KERNEL_CODES +
// applySourceTransaction) and plain ProseMirror step/model objects passed in
// by the caller. It does not talk to a live EditorView, does not read
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
import { KERNEL_CODES, applySourceTransaction, buildSyntaxIndex, toggleTaskMarker } from '../lib/source-kernel/index.js'

// A step's slice counts as "plain text" only if it is exactly a run of
// unmarked text nodes with no open ends (no partial node straddling the
// slice boundary) and no line breaks (a hardbreak/newline inside the slice
// is structural content the raw kernel commands own, not a byte-for-byte
// text edit). Mirrors source-transaction-sync.js's `plainSliceText`
// (:22-36) but is redefined here so this module has no dependency on that
// file's raw-matching helpers.
const plainSliceText = (slice) => {
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
  if (!valid || /[\r\n]/.test(text)) return null
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
      const insertText = plainSliceText(step.slice)
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

// classifyTransactions: pure triage of a dispatch batch into one of six
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
//   6. Otherwise, try the plain-text step guard; anything it can't prove is
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
  for (const step of steps) {
    const oldFrom = step.from - cumulativeDelta
    const oldTo = step.to - cumulativeDelta
    const rawFrom = map.pmPosToRaw(oldFrom)
    const rawTo = map.pmPosToRaw(oldTo)
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
    edits.push({ from: rawFrom, to: rawTo, insert: step.insertText })
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
