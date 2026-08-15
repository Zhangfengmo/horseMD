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
import { KERNEL_CODES, applySourceTransaction } from '../lib/source-kernel/index.js'

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

// classifyTransactions: pure triage of a dispatch batch into one of five
// kinds. Order matters — it is priority, not just an enum listing:
//   1. `sourceProjection` meta marks a transaction the caller itself built
//      FROM a kernel/raw commit (e.g. a projection reconciler replaying the
//      kernel's text into the PM doc) — that provenance is authoritative
//      regardless of whether the batch also happens to look like plain text
//      or carries no doc change at all.
//   2. `isComposing` is a caller-supplied label (IME mid-composition); the
//      gateway does not try to infer composition state itself, so once the
//      caller says so, that's final too, ahead of the docChanged gate below
//      (a composition update can legitimately have `docChanged: false` for
//      a no-op composition tick).
//   3. No transaction changed the doc → selection-only (caret/selection
//      moves, no kernel involvement at all).
//   4. `uiEvent === 'drop'` is an explicit, unconditional block (drag-drop
//      content is never treated as plain text, even if its slice happens to
//      qualify) — spec'd explicitly in the Task 3 brief.
//   5. Otherwise, try the plain-text step guard; anything it can't prove is
//      `blocked` with `INPUT_TYPE` (the single "docChanged but unsupported"
//      code per the brief — this gateway does not attempt finer-grained
//      block reasons for the plain-text path; ProjectionReconciler/dispatch
//      veto own retry/fallback semantics upstream of this function).
export function classifyTransactions(transactions, oldState, { isComposing = false } = {}) {
  const trs = Array.isArray(transactions) ? transactions : [transactions]

  if (trs.some((tr) => tr && typeof tr.getMeta === 'function' && tr.getMeta('sourceProjection'))) {
    return { kind: 'projection' }
  }
  if (isComposing) return { kind: 'composition' }

  const changed = trs.some((tr) => tr && tr.docChanged)
  if (!changed) return { kind: 'selection-only' }

  if (trs.some((tr) => tr && typeof tr.getMeta === 'function' && tr.getMeta('uiEvent') === 'drop')) {
    return { kind: 'blocked', blockedCode: KERNEL_CODES.INPUT_TYPE }
  }

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
