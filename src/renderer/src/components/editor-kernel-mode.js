// KernelMode controller: wires the pure source kernel into a live editor
// (source-kernel integration Plan 2, Task 5).
//
// This module collects EVERY kernel-mode behavior in one place so Editor.jsx
// only assembles: transaction triage (pass-through / commit / veto),
// structural + history keymaps, the API overrides that make kernel.doc.text
// the single flush/save/offset authority, and the projection-map lifecycle.
// It imports no react/electron and touches the view only through `getView`
// (plus the state/dispatch/view arguments PM keymap handlers receive), so
// scripts/test-kernel-mode-headless.mjs can drive it with a stub view and a
// stub parse.
//
// Authority model (binding semantics from the task brief):
//  - kernel.doc.text is the ONLY persistent source of truth. markdownUpdated
//    is diagnostics-only in kernel mode (gated in Editor.jsx), and no
//    lastMarkdownRef/canonicalMarkdownRef baseline is ever advanced.
//  - Everything is fail-closed with an explicit signal: a doc-changing batch
//    the kernel cannot own is VETOED (the PM view never changes, so there is
//    nothing to repair), and a structural key the kernel cannot prove is
//    swallowed with a notification — never silently half-applied.
//  - The ONLY sanctioned degradation is attachAfterCreate() failing to build
//    the initial projection map: the tab announces it and reverts to complete
//    legacy behavior (pass everything through, intercept no keys).
import { keymap } from '@milkdown/prose/keymap'
import { TextSelection } from '@milkdown/prose/state'
import {
  KERNEL_CODES,
  applySourceTransaction,
  buildSyntaxIndex,
  createMarkdownDocument,
  createSourceHistory,
  exitCodeBlock,
  replaceVisibleText,
  routeStructuralKey
} from '../lib/source-kernel/index.js'
import { buildProjectionMap } from './editor-kernel-projection-map.js'
import { classifyTransactions, commitPlainText, commitTaskToggle, commitCodeLanguage } from './editor-kernel-gateway.js'
import { diffReplaceRange, reconcileProjection } from './editor-kernel-reconciler.js'
import { createCompositionSession } from './editor-kernel-composition.js'

// Bounded diagnostics ring buffer (<=100 entries). Shared by this module and
// Editor.jsx's kernel-mode markdownUpdated gate. Entries carry structural
// metadata only — never document content.
export function pushKernelDiagnostic(entry) {
  const buffer = (globalThis.__hmKernelDiagnostics ||= [])
  buffer.push({ at: Date.now(), ...entry })
  if (buffer.length > 100) buffer.shift()
}

const STRUCTURAL_KEYS = ['Enter', 'Tab', 'Shift-Tab', 'Backspace', 'Delete']

export function createKernelMode({
  initialContent,
  getView,
  parse,
  prepareMarkdown,
  notify,
  getT,
  onChange,
  onStructureChange
}) {
  const kernel = {
    doc: createMarkdownDocument(initialContent ?? ''),
    history: createSourceHistory(),
    map: null
  }
  // `attached` flips only after the initial map is proven. Before that (Crepe
  // still creating, chunk append streaming, the new-document H1 init tr) the
  // controller must pass EVERYTHING through and intercept NO key — otherwise
  // it would veto the editor's own initialization transactions.
  let attached = false
  let degraded = false
  let disposed = false
  // Legacy API implementations captured by attachLegacyApi() BEFORE Editor.jsx
  // installs the overrides. In degraded mode every override delegates to these
  // (kernel.doc.text is frozen at the initial content there — serving it from
  // flush/save/recovery would silently discard every edit the legacy pipeline
  // owns).
  let legacyApi = null
  // Current trailing split-placeholder CHAIN (Task 2, plan 3 — generalizes
  // the single-placeholder session note below to N): oldest-first list of
  // `{ pmPos, rawOffset }` vouched to the CURRENT map via bindMap's `pending`
  // argument. Always kept in sync BY bindMap itself (see below) — any bindMap
  // call that doesn't explicitly continue the chain ends the session, exactly
  // like the old single-placeholder's implicit orphaning.
  let splitPlaceholders = []

  const inactive = () => disposed || degraded || !attached

  const tOr = (key, fallback) => {
    const value = getT?.(key)
    return !value || value === key ? fallback : value
  }
  // A held key at a blocked position produces vetoes at key-repeat rate
  // (~30Hz). One toast per code per cooldown window keeps the signal without
  // a permanently flashing toast. Diagnostics/veto behavior are unaffected.
  const NOTIFY_COOLDOWN_MS = 1500
  const lastNotifyAt = new Map()
  const notifyBlocked = (code) => {
    const now = Date.now()
    if (now - (lastNotifyAt.get(code) || 0) < NOTIFY_COOLDOWN_MS) return
    lastNotifyAt.set(code, now)
    notify?.(`${tOr('kernelMode.unsupported', 'Kernel mode blocked this edit')} (${code})`)
  }
  const notifyUnmappable = () => {
    notify?.(tOr(
      'kernelMode.unmappable',
      'Kernel mode could not map this document; legacy editing stays active (some toolbar features remain off)'
    ))
  }

  // Mirror `@milkdown/plugin-trailing`'s default shouldAppend (Crepe ships it
  // unconditionally, with the default config): the live view always carries
  // one EMPTY trailing paragraph whenever the doc's last top-level child is
  // not a paragraph/heading. A raw parse never produces that node (it has no
  // markdown bytes), so every doc-to-doc comparison against the live view —
  // reconcileProjection targets, verifyPlainTextProjection diffs — must
  // append the same placeholder to the parse output. Without this, every
  // plain-text keystroke in a list/table/code-ending document reports a
  // projection mismatch whose "repair" deletes the trailing paragraph only
  // for the plugin to immediately re-append it — a churn loop.
  const withTrailingParagraph = (docNode) => {
    try {
      const last = docNode?.lastChild
      if (!last) return docNode
      const name = last.type?.name
      if (name === 'paragraph' || name === 'heading') return docNode
      const paragraph = docNode.type?.schema?.nodes?.paragraph?.createAndFill?.()
      if (!paragraph) return docNode
      return docNode.copy(docNode.content.addToEnd(paragraph))
    } catch {
      return docNode
    }
  }

  const safeParse = (markdownText) => {
    try {
      const parsed = parse(markdownText) || null
      return parsed ? withTrailingParagraph(parsed) : null
    } catch {
      return null
    }
  }

  // Split placeholder session (Task 11.5, splitTextBlock's degenerate case):
  // an Enter at the end/degenerate position of a paragraph/heading writes
  // real bytes ('\n\n') whose reparse shows NO new block — CommonMark
  // collapses blank-line runs — so the transaction's caret raw offset lands
  // in an inter-block gap no PM position can represent. The controller then
  // materializes ONE empty PM paragraph (the visual "caret on a blank line")
  // right after the split block and vouches for it to buildProjectionMap
  // (see ensureSplitPlaceholder); the next plain-text/IME commit into it
  // lands at exactly that raw offset — making the placeholder real on both
  // sides at once. The session's ENTIRE state is the map's virtual pair
  // plus the placeholder node itself — no separate bookkeeping: any OTHER
  // kernel commit's reconcile (or the verify repair) removes the orphaned
  // placeholder because the parse never contains it, and the next rebind
  // (built WITHOUT the voucher) realigns.

  // Rebuild the projection map against the CURRENT kernel revision + a given
  // PM doc. Maps are revision-bound: every kernel.doc advancement must come
  // back through here; an old map is never reused across revisions.
  // `pending` is passed ONLY by ensureSplitPlaceholder/extendTrailingPlaceholder
  // for the map built immediately after a placeholder dispatch — a stale
  // voucher must never leak into later rebuilds (a real block could have
  // shifted onto its pos). `pending` may be a single `{pmPos,rawOffset}`
  // object (the common one-placeholder case) or an array (the N-placeholder
  // trailing chain); either way `splitPlaceholders` — this module's own
  // record of the CURRENT chain — is resynced to exactly what got vouched
  // here, so any caller that omits `pending` correctly ends the session.
  const bindMap = (pmDoc, pending = null) => {
    const isChain = Array.isArray(pending)
    const list = isChain ? pending : (pending ? [pending] : [])
    splitPlaceholders = list
    // Preserve the CALLER's shape when forwarding to buildProjectionMap — do
    // NOT normalize a single object into a one-element `pendingPlaceholders`
    // array here. buildProjectionMap's chain-only trailing-floor self-check
    // (review finding, Task 2 plan 3) keys off which OPTION NAME was used
    // (`pendingPlaceholders` vs `pendingPlaceholder`) to tell
    // extendTrailingPlaceholder's genuine trailing chain apart from
    // ensureSplitPlaceholder's long-standing single-placeholder MID-document
    // case (Enter at the end of a paragraph that still has more real content
    // after it elsewhere in the doc — see Case 13 / Case 15b in
    // scripts/test-kernel-projection-map.mjs). Funneling both shapes through
    // the plural key here would silently apply the trailing floor to
    // ensureSplitPlaceholder's mid-document placeholders too and reject
    // perfectly ordinary "Enter at paragraph end, more content follows"
    // splits — this exact regression was caught by the live UI suite, not
    // by the unit tests (which call buildProjectionMap directly with the
    // literal option name and never exercised bindMap's own forwarding).
    const options = isChain
      ? (list.length ? { pendingPlaceholders: list } : {})
      : (pending ? { pendingPlaceholder: pending } : {})
    kernel.map = pmDoc ? buildProjectionMap(kernel.doc.text, pmDoc, options) : null
    if (!kernel.map) {
      pushKernelDiagnostic({ type: 'map-refresh-failed', revision: kernel.doc.revision })
      splitPlaceholders = []
    }
    return kernel.map
  }

  const refreshProjectionMap = () => {
    const view = getView?.()
    if (!view || disposed) return null
    return bindMap(view.state.doc)
  }

  const attachAfterCreate = () => {
    if (disposed) return false
    const view = getView?.()
    const map = view ? buildProjectionMap(kernel.doc.text, view.state.doc) : null
    if (!map) {
      degraded = true
      pushKernelDiagnostic({ type: 'attach-unmappable' })
      notifyUnmappable()
      return false
    }
    kernel.map = map
    attached = true
    return true
  }

  // Cheap-path verification (plain-text commits): the accepted PM transaction
  // itself IS the projection update, so no reconcile is normally needed — but
  // that shortcut must be proven, not assumed. Reparse the kernel bytes and
  // require a null diff against the doc PM is about to install. A mismatch is
  // repaired by reconciling the view to the parse output in a microtask
  // (dispatching synchronously here would race the pending updateState that
  // installs `newDoc` — the dispatch-veto protocol calls this while the view
  // still holds the OLD state).
  const verifyPlainTextProjection = (newDoc) => {
    const parsed = safeParse(kernel.doc.text)
    if (!parsed) {
      pushKernelDiagnostic({ type: 'projection-parse-failure', revision: kernel.doc.revision })
      return
    }
    let diff
    try {
      diff = diffReplaceRange(newDoc, parsed)
    } catch {
      diff = { unknown: true }
    }
    if (!diff) return
    pushKernelDiagnostic({ type: 'projection-mismatch', code: KERNEL_CODES.PROJECTION })
    queueMicrotask(() => {
      const view = getView?.()
      if (!view || disposed) return
      try {
        reconcileProjection({ view, newDoc: parsed })
      } catch {
        pushKernelDiagnostic({ type: 'projection-repair-failed' })
      }
      bindMap(view.state.doc)
    })
  }

  // Best-effort scan: does any ReplaceStep in this batch target a
  // `code_block` textblock? Used only to decide whether the veto-after-
  // CM-applied defensive resync below is worth scheduling — a false
  // negative just skips that extra (harmless) resync, so this does not need
  // `extractPlainTextSteps`' full validation (batch chaining, slice shape,
  // …), only the parent-node-type check, walked with the same per-step
  // `tr.docs[index]` convention that file's own doc-comment explains (a
  // multi-step transaction's step N is expressed in the doc-after-step-
  // (N-1) coordinate space, not `oldState.doc` for every step).
  const batchTargetsCodeBlock = (transactions, oldState) => {
    const trs = Array.isArray(transactions) ? transactions : [transactions]
    let fallbackDoc = oldState?.doc || null
    for (const tr of trs) {
      if (!tr || !tr.docChanged || !Array.isArray(tr.steps)) continue
      for (let index = 0; index < tr.steps.length; index += 1) {
        const step = tr.steps[index]
        if (!Number.isFinite(step?.from)) continue
        const stepDoc = tr.docs?.[index] || fallbackDoc
        if (!stepDoc) continue
        try {
          if (stepDoc.resolve(step.from).parent?.type?.name === 'code_block') return true
        } catch {
          /* unresolvable position: not provably a code_block, keep scanning */
        }
      }
      fallbackDoc = tr.doc || fallbackDoc
    }
    return false
  }

  // Defense-in-depth for the P3-4 corruption vector (final-review finding,
  // 2026-08-16): CodeMirror's own `forwardUpdate` fires from CM's update
  // listener, which runs AFTER CM has already applied a change to its OWN
  // internal `EditorState` — by the time the resulting PM transaction
  // reaches the kernel gateway, CM's DOM/state may already show the edit
  // regardless of what the gateway decides. A normal veto leaves
  // `view.state` (and therefore the code_block's PM node) untouched — see
  // `editor-source-transactions.js`'s `if (verdict?.veto) return` — so
  // nothing ever calls the nodeview's own `update()` to pull CM back in
  // sync with the kernel's truth; left alone, that is a PERMANENT
  // divergence (CM shows bytes the kernel never owned). Scheduled as a
  // microtask (never synchronously — the dispatch-veto protocol runs this
  // while the view still holds the pre-batch state) and built on the exact
  // same reconcile `verifyPlainTextProjection` above uses: reconciling
  // against `parse(kernel.doc.text)` is a genuine no-op when the view
  // already agrees with the kernel (no diff -> no dispatch, so this costs
  // nothing on the overwhelmingly common "CM did NOT diverge" path), and a
  // real repair dispatch whenever it doesn't — which is exactly the signal
  // that forces the affected code_block's nodeview `update()` to run and
  // resync CM's own buffer to the kernel-owned bytes. The diagnostic is
  // pushed unconditionally so a regression test can prove this path ran
  // without depending on whether a repair dispatch actually fired.
  const scheduleVetoResync = () => {
    queueMicrotask(() => {
      const view = getView?.()
      if (!view || disposed) return
      pushKernelDiagnostic({ type: 'cm-veto-resync', revision: kernel.doc.revision })
      const parsed = safeParse(kernel.doc.text)
      if (!parsed) {
        pushKernelDiagnostic({ type: 'cm-veto-resync-parse-failure' })
        return
      }
      try {
        reconcileProjection({ view, newDoc: parsed })
      } catch {
        pushKernelDiagnostic({ type: 'cm-veto-resync-failed' })
      }
      bindMap(view.state.doc)
    })
  }

  const handleTransactions = (transactions, oldState, newState) => {
    if (inactive()) return undefined
    const view = getView?.()
    const classified = classifyTransactions(transactions, oldState, {
      isComposing: !!view?.composing
    })
    switch (classified.kind) {
      case 'projection':
      case 'selection-only':
        return undefined
      case 'composition':
        // Pass through unconditionally: the kernel never writes bytes or
        // records history mid-composition. `composition` (below) owns the
        // start/end/cancel bookkeeping and turns the whole composition into
        // ONE kernel commit (or a clean revert) once it settles.
        return undefined
      case 'blocked':
        notifyBlocked(classified.blockedCode)
        return { veto: true }
      case 'trailing-append':
        // @milkdown/plugin-trailing's own convenience paragraph (see
        // editor-kernel-gateway.js extractTrailingAppend): view-only, no
        // markdown bytes, no history entry — just rebind the map so the
        // trailing-placeholder tolerance pairs the new node.
        bindMap(newState?.doc || null)
        return undefined
      case 'plain-text': {
        const committed = commitPlainText({ kernel, map: kernel.map, transactions, oldState })
        if (!committed.ok) {
          // Veto: the PM view never changes and kernel.doc was not advanced,
          // so both sides stay consistent with no repair needed — EXCEPT
          // that CM may already have applied this edit to its own internal
          // state before the (now-vetoed) PM transaction ever reached here
          // (see scheduleVetoResync's own comment). Schedule the defensive
          // resync whenever this batch's steps targeted a code_block, so a
          // genuine CM-side divergence gets pulled back in sync instead of
          // persisting forever.
          notifyBlocked(committed.code)
          if (batchTargetsCodeBlock(transactions, oldState)) scheduleVetoResync()
          return { veto: true }
        }
        kernel.doc = committed.applied.doc
        recordHistory(committed.applied, committed.transaction)
        // Any successful commit ends a split-placeholder session: either the
        // commit filled the placeholder (parse now REALLY contains it — the
        // rebind below aligns without any tolerance) or it edited elsewhere,
        // in which case the rebind fails against the orphaned empty
        // paragraph and verifyPlainTextProjection's repair reconcile removes
        // it (the parse never contains it) and rebinds.
        bindMap(newState?.doc || null)
        if (newState?.doc) verifyPlainTextProjection(newState.doc)
        onChange?.(kernel.doc.text, false)
        return undefined
      }
      case 'code-language': {
        // The language AttrStep (Plan 3 Task 4) has ALREADY flipped
        // `attrs.language` on the live PM doc by the time this runs
        // (classification happens post-hoc, inside `updateState` — same
        // timing as `task-toggle` above); there is nothing further to project
        // into the view. Once `commitCodeLanguage` proves the same rewrite
        // against the raw fence bytes, the original transaction is allowed
        // through unchanged (`return undefined`) instead of vetoing and
        // separately reconciling — identical shape to the task-toggle case
        // right below. The rebind is unconditional (not just on failure, like
        // task-toggle): a language switch can flip a pair between
        // editable/preview-only (`READONLY_CODE_LANGUAGES`), so the NEXT
        // commit into this block must see a freshly evaluated `charMap`, not
        // a stale one from before the switch.
        const committed = commitCodeLanguage({
          kernel,
          index: buildSyntaxIndex(kernel.doc.text),
          map: kernel.map,
          pmPos: classified.pmPos,
          language: classified.language
        })
        if (!committed.ok) {
          notifyBlocked(committed.code)
          return { veto: true }
        }
        kernel.doc = committed.applied.doc
        recordHistory(committed.applied, committed.transaction)
        bindMap(newState?.doc || null)
        if (newState?.doc) verifyPlainTextProjection(newState.doc)
        onChange?.(kernel.doc.text, false)
        return undefined
      }
      case 'task-toggle': {
        // The task checkbox click (`list-item-block`'s `setAttr('checked', …)`,
        // a bare `tr.setNodeAttribute`) is never a ReplaceStep batch, so it
        // cannot go through commitPlainText's step guard, and it never runs
        // through a keymap, so structuralHandler never sees it either. The
        // original AttrStep transaction already reflects the same flip
        // `toggleTaskMarker` computes for the raw bytes (both start from the
        // same current `checked` state), so — exactly like the plain-text
        // case — the original transaction is allowed through to the view
        // (`return undefined`) once the kernel commit is proven, instead of
        // vetoing and separately reconciling.
        const committed = commitTaskToggle({ kernel, map: kernel.map, pos: classified.pos })
        if (!committed.ok) {
          notifyBlocked(committed.code)
          return { veto: true }
        }
        kernel.doc = committed.applied.doc
        recordHistory(committed.applied, committed.transaction)
        bindMap(newState?.doc || null)
        // A toggle while a split placeholder was pending leaves the orphaned
        // empty paragraph in the view (the parse never contains it), so the
        // rebind above fails — run the same parse-diff repair the plain-text
        // path uses so the map recovers instead of staying null.
        if (!kernel.map && newState?.doc) verifyPlainTextProjection(newState.doc)
        onChange?.(kernel.doc.text, false)
        return undefined
      }
      default:
        return undefined
    }
  }

  // Restore the caret from a raw-source offset of the CURRENT revision's map.
  // TextSelection.near is the sanctioned fallback for offsets that resolve
  // next to (or inside) an atom; an unprovable offset leaves the PM-mapped
  // selection reconcileProjection already produced.
  const setCaretFromRaw = (view, rawOffset) => {
    if (!Number.isFinite(rawOffset)) return
    const target = kernel.map?.rawToPmPos?.(rawOffset)
    if (!target || !Number.isFinite(target.pos)) return
    try {
      const docNode = view.state.doc
      const clamped = Math.max(0, Math.min(target.pos, docNode.content.size))
      const selection = TextSelection.near(docNode.resolve(clamped), 1)
      const tr = view.state.tr.setSelection(selection)
      tr.setMeta('addToHistory', false)
      if (typeof tr.scrollIntoView === 'function') tr.scrollIntoView()
      view.dispatch(tr)
    } catch {
      pushKernelDiagnostic({ type: 'caret-restore-failed', rawOffset })
    }
  }

  // Materialize ONE vouched empty PM paragraph at `insertPos` representing a
  // caret parked on a blank line the reparse cannot show (CommonMark
  // collapses blank-line runs), caret inside it, tagged
  // sourceProjection/addToHistory:false so the gateway passes it through and
  // undo never replays it. The map is rebuilt WITH the placeholder vouched;
  // if that map cannot be proven, the placeholder is removed again
  // (fail-closed, never a half-tracked node). Shared by
  // `ensureSplitPlaceholder` (Enter's degenerate split, insert after the
  // ORIGIN textblock) and `runExitCode` (Mod-Enter code-block exit, insert
  // after the CODE BLOCK node).
  const materializePlaceholder = (view, insertPos, rawOffset) => {
    try {
      const paragraph = view.state.schema?.nodes?.paragraph?.createAndFill?.()
      if (!paragraph) return false
      const tr = view.state.tr.insert(insertPos, paragraph)
      tr.setSelection(TextSelection.create(tr.doc, insertPos + 1))
      tr.setMeta('sourceProjection', true)
      tr.setMeta('addToHistory', false)
      if (typeof tr.scrollIntoView === 'function') tr.scrollIntoView()
      view.dispatch(tr)
      if (bindMap(view.state.doc, { pmPos: insertPos, rawOffset })) return true
      // Could not prove the vouched pairing: remove the placeholder again
      // and rebind plain.
      pushKernelDiagnostic({ type: 'split-placeholder-unprovable', rawOffset })
      const undoTr = view.state.tr.delete(insertPos, insertPos + paragraph.nodeSize)
      undoTr.setMeta('sourceProjection', true)
      undoTr.setMeta('addToHistory', false)
      view.dispatch(undoTr)
      bindMap(view.state.doc)
      return false
    } catch {
      pushKernelDiagnostic({ type: 'split-placeholder-failed', rawOffset })
      return false
    }
  }

  // The degenerate-splitTextBlock caller (see the session note above): the
  // placeholder goes right after the textblock the split originated in
  // (resolved from the transaction's own `from` on the CURRENT map).
  const ensureSplitPlaceholder = (view, txn, rawOffset) => {
    const origin = kernel.map?.rawToPmPos?.(txn.from)
    if (!origin || !Number.isFinite(origin.pos)) return
    try {
      const docNode = view.state.doc
      const $pos = docNode.resolve(Math.max(0, Math.min(origin.pos, docNode.content.size)))
      let depth = $pos.depth
      while (depth > 0 && !$pos.node(depth).isTextblock) depth -= 1
      if (depth === 0 || !$pos.node(depth).isTextblock) return
      materializePlaceholder(view, $pos.after(depth), rawOffset)
    } catch {
      pushKernelDiagnostic({ type: 'split-placeholder-failed', rawOffset })
    }
  }

  // Enter pressed AGAIN while the caret sits in the LAST vouched trailing
  // placeholder (Task 2, plan 3 — "块尾连续 Enter"): routeStructuralKey at
  // that exact raw offset produces the SAME pure kernel transaction
  // splitTextBlock's own trailing-gap fallback derives (enter.js
  // `isTrailingGap`) — one more `ending` extending the blank-line run.
  // Unlike the generic applyKernelTransaction path, this must NOT reconcile
  // the view against a fresh parse first: that reconcile would immediately
  // delete the EXISTING placeholder(s) (mdast still shows nothing there —
  // blank-line runs collapse regardless of count, so the parse is identical
  // before and after), losing the chain before a new node could even be
  // added. Instead this inserts the new empty paragraph directly after the
  // CURRENT last placeholder and vouches for the WHOLE extended chain in one
  // bindMap call. `kernel.doc`/history are only committed once that chain is
  // PROVEN (bindMap succeeds) — a failure rolls both the view insert AND the
  // kernel doc back together, so the two never drift out of sync (unlike a
  // partial rollback, which would leave kernel.doc one byte ahead of what
  // the view — now showing the OLD, still-valid-looking chain — displays).
  // Scoped to the LAST placeholder only — the natural "keep pressing Enter"
  // flow. A caret that navigated INTO an earlier placeholder in the chain is
  // not something this session ever vouches an extension for; it falls
  // through to routeStructuralKey's normal (refusing) path instead of
  // guessing at a mid-chain insert.
  const extendTrailingPlaceholder = (view, rawOffset) => {
    const last = splitPlaceholders[splitPlaceholders.length - 1]
    if (!last || last.rawOffset !== rawOffset) return false
    const routed = routeStructuralKey('Enter', {
      doc: kernel.doc,
      index: buildSyntaxIndex(kernel.doc.text),
      offset: rawOffset,
      empty: true
    })
    if (!routed.ok) {
      notifyBlocked(routed.code)
      return false
    }
    const result = applySourceTransaction(kernel.doc, routed.transaction)
    if (!result.ok) {
      notifyBlocked(result.code)
      return false
    }
    // Set BEFORE the try so the catch below can always roll it back — a
    // thrown exception at ANY point after `kernel.doc` advances (the view
    // insert, bindMap, even the rollback path itself) must never leave
    // `kernel.doc` ahead of what the view displays.
    const previousDoc = kernel.doc
    let advanced = false
    try {
      const docNode = view.state.doc
      const lastNode = docNode.nodeAt(last.pmPos)
      if (!lastNode) {
        notifyBlocked(KERNEL_CODES.UNSUPPORTED)
        return false
      }
      const insertPos = last.pmPos + lastNode.nodeSize
      const paragraph = view.state.schema?.nodes?.paragraph?.createAndFill?.()
      if (!paragraph) {
        notifyBlocked(KERNEL_CODES.UNSUPPORTED)
        return false
      }
      kernel.doc = result.doc
      advanced = true
      const tr = view.state.tr.insert(insertPos, paragraph)
      tr.setSelection(TextSelection.create(tr.doc, insertPos + 1))
      tr.setMeta('sourceProjection', true)
      tr.setMeta('addToHistory', false)
      if (typeof tr.scrollIntoView === 'function') tr.scrollIntoView()
      view.dispatch(tr)
      const newRawOffset = routed.transaction.selection.anchor
      const nextChain = [...splitPlaceholders, { pmPos: insertPos, rawOffset: newRawOffset }]
      if (bindMap(view.state.doc, nextChain)) {
        recordHistory(result, routed.transaction)
        onChange?.(kernel.doc.text, false)
        return true
      }
      // Could not prove the extended chain: roll BOTH the view insert and
      // the kernel doc back together (never just one side).
      pushKernelDiagnostic({ type: 'split-placeholder-unprovable', rawOffset: newRawOffset })
      kernel.doc = previousDoc
      advanced = false
      const undoTr = view.state.tr.delete(insertPos, insertPos + paragraph.nodeSize)
      undoTr.setMeta('sourceProjection', true)
      undoTr.setMeta('addToHistory', false)
      view.dispatch(undoTr)
      bindMap(view.state.doc)
      notifyBlocked(KERNEL_CODES.PROJECTION)
      return false
    } catch {
      if (advanced) kernel.doc = previousDoc
      pushKernelDiagnostic({ type: 'split-placeholder-failed', rawOffset })
      notifyBlocked(KERNEL_CODES.PROJECTION)
      return false
    }
  }

  // Apply one kernel transaction to the doc AND project it into the view:
  // parse-first so a projection failure refuses the whole key with every
  // state (kernel doc, history, PM view) untouched.
  const applyKernelTransaction = (txn, view, { record = true } = {}) => {
    const result = applySourceTransaction(kernel.doc, txn)
    if (!result.ok) {
      notifyBlocked(result.code)
      return false
    }
    const parsed = safeParse(result.doc.text)
    if (!parsed) {
      notifyBlocked(KERNEL_CODES.PROJECTION)
      pushKernelDiagnostic({ type: 'structural-parse-failure', intent: txn.intent })
      return false
    }
    // Any kernel transaction ends a split-placeholder session. If this
    // transaction is the one that fills the placeholder (an insert exactly
    // at its raw anchor), the reconcile below is a no-op there and the
    // rebind aligns naturally; otherwise the reconcile removes the orphaned
    // empty paragraph, because `parsed` never contains it.
    kernel.doc = result.doc
    if (record) recordHistory(result, txn)
    // Pre-compute the caret target against the PARSED doc: its content is
    // exactly what the view will hold after the reconcile, so its positions
    // transfer 1:1 — and the selection MUST ride on the same transaction
    // that inserts the new nodes. A separate follow-up selection dispatch
    // cannot reach content whose node-view DOM (Crepe's Vue list items)
    // hasn't mounted yet: the DOM caret stays behind and PM's DOM observer
    // then drags the state selection back to it, which is exactly how a
    // continuation keystroke after Enter ended up typing into the PREVIOUS
    // block (Task 11 Bug 3's caret misplacement).
    const anchor = result.selection?.anchor ?? result.selection?.head
    let target = null
    if (Number.isFinite(anchor)) {
      const nextMap = buildProjectionMap(kernel.doc.text, parsed)
      const found = nextMap?.rawToPmPos?.(anchor)
      if (found && Number.isFinite(found.pos)) target = found
    }
    let reconciled = false
    try {
      reconciled = reconcileProjection({
        view,
        newDoc: parsed,
        decorateTransaction: target
          ? (tr) => {
              try {
                const clamped = Math.max(0, Math.min(target.pos, tr.doc.content.size))
                tr.setSelection(TextSelection.near(tr.doc.resolve(clamped), 1))
                if (typeof tr.scrollIntoView === 'function') tr.scrollIntoView()
              } catch {
                pushKernelDiagnostic({ type: 'caret-restore-failed', rawOffset: anchor })
              }
            }
          : null
      })
    } catch {
      pushKernelDiagnostic({ type: 'projection-repair-failed', intent: txn.intent })
    }
    // The map must be rebound to the reconciled doc BEFORE any further
    // caret work: rawToPmPos is only meaningful on a map built for this
    // revision.
    bindMap(view.state.doc)
    if (target) {
      // No content diff (e.g. an undo landing on byte-identical parse
      // output): the reconcile dispatched nothing, so restore the caret
      // with a plain selection transaction — the targeted content already
      // has mounted DOM in this case.
      if (!reconciled) setCaretFromRaw(view, anchor)
    } else if (txn.intent === 'split-block' && Number.isFinite(anchor) && kernel.map) {
      // splitTextBlock's degenerate case: the caret raw offset sits on a
      // blank line the reparse cannot represent — give it a real, editable
      // PM home (see ensureSplitPlaceholder above).
      ensureSplitPlaceholder(view, txn, anchor)
    } else if (Number.isFinite(anchor)) {
      // The caret stays wherever the reconcile left it — record why, so a
      // misplaced continuation keystroke is diagnosable instead of silent.
      pushKernelDiagnostic({ type: 'caret-unmappable', intent: txn.intent, rawOffset: anchor })
    }
    onChange?.(kernel.doc.text, false)
    return true
  }

  // CompositionSession's sole write path (Task 6): a whole IME composition
  // becomes ONE kernel transaction here, never a byte-by-byte stream while
  // composing (handleTransactions' 'composition' branch passes every
  // in-flight PM change through untouched — see above). `history.breakGroup()`
  // brackets the commit on BOTH sides: 'ime-commit' is not
  // insert-text-coalescable on its own (createSourceHistory's
  // asCoalescableEdit only merges 'insert-text' intents), so this is a
  // second, explicit fence — it keeps the commit isolated as its own undo
  // unit even if a future intent rename ever made it coalescable, and it
  // stops whatever plain-text edit comes right after the composition from
  // merging backward into it.
  const commitReplace = ({ rawFrom, rawTo, text, pmFrom }) => {
    const view = getView?.()
    if (!view || disposed) return false
    // A composition that ran inside a VIRTUAL block (the trailing
    // placeholder below a list/table/code ending, a split placeholder, or an
    // empty list item) must carry the same separator prefix a plain-text
    // commit there carries — otherwise the committed bytes land as a lazy
    // continuation of the final block instead of a new paragraph. The
    // decision is made by PM position (`pmFrom`, the diff start the
    // composition session proved), never by raw offset, which can be
    // ambiguous at the document end.
    const virtualBlock = Number.isFinite(pmFrom) && rawFrom === rawTo
      ? kernel.map?.virtualBlockAt?.(pmFrom)
      : null
    const insert = virtualBlock && virtualBlock.raw === rawFrom
      ? virtualBlock.prefix + text
      : text
    kernel.history.breakGroup()
    const applied = applyKernelTransaction({
      baseRevision: kernel.doc.revision,
      from: rawFrom,
      to: rawTo,
      insert,
      intent: 'ime-commit'
    }, view)
    kernel.history.breakGroup()
    return applied
  }

  // CompositionSession's sole revert path: reconcile the view back to
  // parse(kernel.doc.text) with NO kernel change — the kernel bytes were
  // never touched mid-composition, so there is nothing to undo on that side,
  // only the PM view needs to be pulled back off the in-flight composition
  // candidate. `code` (when present) is diagnostic-only, describing WHY the
  // composition was refused; the user-facing toast is CompositionSession's
  // own `notify` call, not this function.
  const revertProjection = (code) => {
    const view = getView?.()
    if (!view || disposed) return
    // A revert reconciles the view straight back to parse(kernel.doc.text),
    // which removes any orphaned split placeholder along the way.
    const parsed = safeParse(kernel.doc.text)
    if (!parsed) {
      pushKernelDiagnostic({ type: 'composition-revert-parse-failure' })
      return
    }
    try {
      reconcileProjection({ view, newDoc: parsed })
    } catch {
      pushKernelDiagnostic({ type: 'composition-revert-failed' })
    }
    bindMap(view.state.doc)
    if (code) pushKernelDiagnostic({ type: 'composition-reverted', code })
  }

  const compositionSession = createCompositionSession({
    getView,
    kernel,
    commitReplace,
    revertProjection,
    notify,
    getT
  })
  // Wrappers gate on `inactive()` exactly like every other kernel-mode entry
  // point: before attach (Crepe still creating / chunks still appending),
  // while degraded (legacy owns IME natively via Editor.jsx's existing
  // markdownUpdated/view.composing path), or after dispose, composition
  // tracking must be a no-op — it must never open a session it could not
  // later settle.
  const composition = {
    onStart: () => { if (!inactive()) compositionSession.onStart() },
    onEnd: () => { if (!inactive()) compositionSession.onEnd() },
    onCancel: () => { if (!inactive()) compositionSession.onCancel() },
    isActive: () => compositionSession.isActive(),
    settled: () => compositionSession.settled(),
    queueExternal: (fn) => compositionSession.queueExternal(fn)
  }

  // Tab (and future plain inserts) on the not-structural path: source-first
  // character insertion through replaceVisibleText, scoped to the single
  // editable block pair that contains the selection.
  const insertPlainTextAtSelection = (insert, state, view) => {
    const { from, to } = state.selection
    // Virtual pairs are excluded: a raw '\t' at a virtual block's anchor
    // (line start after a list, or a blank line) would parse as an indented
    // code block / continuation — not the tab the user meant. Refusing is
    // the fail-closed choice.
    const pair = (kernel.map?.blockPairs || []).find((candidate) => {
      if (!candidate.charMap || candidate.virtual) return false
      const contentPos = candidate.pmPos + 1
      const end = contentPos + candidate.charMap.visibleLength
      return from >= contentPos && to <= end
    })
    if (!pair) {
      notifyBlocked(KERNEL_CODES.UNMAPPED)
      return false
    }
    const contentPos = pair.pmPos + 1
    const routed = replaceVisibleText({
      doc: kernel.doc,
      map: pair.charMap,
      visFrom: from - contentPos,
      visTo: to - contentPos,
      insert
    })
    if (!routed.ok) {
      notifyBlocked(routed.code)
      return false
    }
    return applyKernelTransaction(routed.transaction, view)
  }

  const structuralHandler = (key) => (state, dispatch, viewArg) => {
    if (inactive()) return false
    const view = viewArg || getView?.()
    if (!view) return false
    if (!kernel.map) {
      notifyBlocked(KERNEL_CODES.UNMAPPED)
      return true
    }
    const offset = kernel.map.pmPosToRaw(state.selection.head)
    if (!Number.isFinite(offset)) {
      // Fail-closed: an unprovable caret must not reach PM's structural
      // commands (their output would be an unowned structural transaction).
      notifyBlocked(KERNEL_CODES.UNMAPPED)
      return true
    }
    // 块尾连续 Enter (Task 2, plan 3): the caret sits exactly at the LAST
    // vouched trailing placeholder's raw anchor — extend the chain instead
    // of routing through the generic split path (whose reconcile-against-
    // fresh-parse step would delete the existing placeholder(s); see
    // extendTrailingPlaceholder's own comment for why).
    if (key === 'Enter' && splitPlaceholders.length) {
      const last = splitPlaceholders[splitPlaceholders.length - 1]
      if (offset === last.rawOffset) {
        // extendTrailingPlaceholder notifies on every one of its own failure
        // paths (specific KERNEL_CODES per cause) — the key is always
        // swallowed here either way, never falling through to
        // routeStructuralKey's generic (and, for this exact raw offset,
        // wrong) split path.
        extendTrailingPlaceholder(view, offset)
        return true
      }
    }
    const routed = routeStructuralKey(key, {
      doc: kernel.doc,
      index: buildSyntaxIndex(kernel.doc.text),
      offset,
      empty: state.selection.empty
    })
    if (routed.ok) {
      applyKernelTransaction(routed.transaction, view)
      return true
    }
    if (routed.code === KERNEL_CODES.NOT_STRUCTURAL) {
      // Backspace/Delete: let PM produce the plain text-deletion transaction;
      // handleTransactions' plain-text classification owns it (a cross-block
      // deletion classifies as blocked -> veto, still fail-closed).
      if (key === 'Backspace' || key === 'Delete') return false
      // Tab: literal tab through the kernel (source-first).
      if (key === 'Tab') {
        insertPlainTextAtSelection('\t', state, view)
        return true
      }
      // Shift-Tab outside a list has no source meaning: swallow silently.
      if (key === 'Shift-Tab') return true
      // Enter: PM's splitBlock must never run in kernel mode; anything
      // splitTextBlock/list commands did not cover is refused loudly.
      notifyBlocked(KERNEL_CODES.UNSUPPORTED)
      return true
    }
    notifyBlocked(routed.code)
    return true
  }

  // Redo-stack mirror so a null undo/redo can be told apart: null with a
  // non-empty stack means the history's internal revision pointer no longer
  // matches kernel.doc (an external action broke the linear chain) — the
  // stacks are effectively frozen and that deserves a diagnostic, not
  // silence. record() clears redo; a successful undo/redo moves one group.
  let redoDepth = 0
  const recordHistory = (applyResult, txn) => {
    kernel.history.record(applyResult, txn)
    redoDepth = 0
  }
  // Shared undo/redo body: both the PM keymap handler below AND the
  // CM-bridge entry point (editor-kernel-cm-bridge.js, Task 1 — a
  // CM-focused Mod-z must reach this SAME kernel history, never
  // prosemirror-history) execute exactly this, so a CM-originated undo can
  // never diverge from a PM-originated one. `viewArg` lets the PM keymap
  // pass the view it was invoked with; the CM bridge has no such view and
  // falls back to `getView()`.
  const runHistoryCore = (direction, viewArg) => {
    if (inactive()) return false
    const view = viewArg || getView?.()
    if (!view) return false
    const txn = kernel.history[direction](kernel.doc)
    // Nothing to undo/redo: STILL swallow the key. PM's own history plugin
    // (and, via the CM bridge, prosemirror-history's CM-local binding) must
    // never replay a structural step in kernel mode.
    if (!txn) {
      const stackHadEntries = direction === 'undo'
        ? kernel.history.depth() > 0
        : redoDepth > 0
      if (stackHadEntries) {
        pushKernelDiagnostic({
          type: 'history-frozen',
          direction,
          revision: kernel.doc.revision
        })
      }
      return true
    }
    redoDepth += direction === 'undo' ? 1 : -1
    applyKernelTransaction(txn, view, { record: false })
    return true
  }
  const historyHandler = (direction) => (state, dispatch, viewArg) =>
    runHistoryCore(direction, viewArg)
  // CM-bridge entry point (Task 1): same signature Editor.jsx wires into
  // `kernelPlugins.runHistory` for editor-crepe-setup.js's CodeMirror
  // featureConfig extensions.
  const runHistory = (direction) => runHistoryCore(direction)

  // CM instance -> its code_block pair in the CURRENT projection map (Plan 3
  // Task 5). The CM extensions are one shared static array, so the only
  // per-instance identity available at event time is the CM editor's own
  // DOM: `posAtDOM` resolves any node inside a nodeview's dom to a PM
  // position strictly inside that node (prosemirror-view
  // `localPosFromDOM`'s non-contentDOM branch returns posAtStart/posAtEnd,
  // both interior), which the strict range check below matches to exactly
  // one pair — a boundary-ambiguous position between two adjacent code
  // blocks matches neither and fails closed. Any failure (detached DOM, no
  // map, unmapped revision) returns null => treated as non-editable.
  const codePairFromCm = (cmView) => {
    const view = getView?.()
    const dom = cmView?.dom
    if (!view || !kernel.map || !dom) return null
    let pos = null
    try {
      pos = view.posAtDOM(dom, 0)
    } catch {
      return null
    }
    if (!Number.isFinite(pos)) return null
    for (const pair of kernel.map.blockPairs) {
      const node = pair.pmNode
      if (node?.type?.name !== 'code_block') continue
      if (pos > pair.pmPos && pos < pair.pmPos + node.nodeSize) return pair
    }
    return null
  }

  // Per-block dynamic editability gate consumed by
  // editor-kernel-cm-bridge.js at EVERY CM input event: a code block is
  // editable exactly when its pair carries a charMap (LF-only, non-mermaid/
  // latex/math — editor-kernel-projection-map.js's own criteria), evaluated
  // against the CURRENT map so a language switch or degrade flips it with
  // zero staleness. Inactive (pre-attach/degraded/disposed) reports
  // editable: the bridge's own `isActive()` gate is off then and legacy
  // behavior owns the block.
  const isCmBlockEditable = (cmView) => {
    if (inactive()) return true
    return !!codePairFromCm(cmView)?.charMap
  }

  // CM-focused Mod-Enter (Plan 3 Task 5): exit the code block by writing the
  // exit bytes source-first (commands/code-exit.js) — never PM's exitCode
  // (a structural transaction the gateway would veto). Returns true when the
  // key was handled kernel-side (including refusals, which notify); the
  // bridge swallows it either way while active.
  const runExitCode = (cmView) => {
    if (inactive()) return false
    const view = getView?.()
    if (!view) return false
    const pair = codePairFromCm(cmView)
    const start = pair?.mdBlock?.position?.start?.offset
    if (!Number.isFinite(start)) {
      notifyBlocked(KERNEL_CODES.UNMAPPED)
      return true
    }
    const routed = exitCodeBlock({
      doc: kernel.doc,
      index: buildSyntaxIndex(kernel.doc.text),
      offset: start
    })
    if (!routed.ok) {
      notifyBlocked(routed.code)
      return true
    }
    if (!applyKernelTransaction(routed.transaction, view)) return true
    // Mid-document exit: the caret anchor sits on a blank line the reparse
    // cannot represent — give it a real PM home right AFTER the code block
    // (the doc-end case never gets here: its anchor is the new document
    // end, which the trailing-virtual pair in the freshly bound map already
    // resolves). The pair is re-located in the REBOUND map by its mdast
    // start offset, which the exit edit (an insert strictly after the
    // block) never moves.
    const anchor = routed.transaction.selection?.anchor
    if (Number.isFinite(anchor) && kernel.map && !kernel.map.rawToPmPos(anchor)) {
      const exited = kernel.map.blockPairs.find((candidate) =>
        candidate.pmNode?.type?.name === 'code_block' &&
        candidate.mdBlock?.position?.start?.offset === start)
      if (exited) {
        materializePlaceholder(view, exited.pmPos + exited.pmNode.nodeSize, anchor)
      } else {
        pushKernelDiagnostic({ type: 'caret-unmappable', intent: 'exit-code-block', rawOffset: anchor })
      }
    }
    // Mirror the nodeview's own Mod-Enter: move focus from the CM editor
    // back onto the PM view so the restored caret is the live one.
    try {
      view.focus?.()
    } catch {
      /* focus is best-effort */
    }
    return true
  }

  const structuralHandlers = Object.fromEntries(
    STRUCTURAL_KEYS.map((key) => [key, structuralHandler(key)])
  )
  const historyHandlers = {
    undo: historyHandler('undo'),
    redo: historyHandler('redo')
  }

  const structuralKeymap = () => keymap({ ...structuralHandlers })
  const historyKeymap = () => keymap({
    'Mod-z': historyHandlers.undo,
    'Mod-y': historyHandlers.redo,
    'Shift-Mod-z': historyHandlers.redo
  })

  const notifyUnsupportedApi = (api) => {
    notifyBlocked(KERNEL_CODES.INPUT_TYPE)
    pushKernelDiagnostic({ type: 'unsupported-api', api })
    return false
  }

  // Editor.jsx calls this with the legacy createEditorApi() result BEFORE
  // installing the overrides, so the pre-override implementations remain
  // callable. Degradation is decided later (attachAfterCreate) — that is why
  // the overrides below delegate AT CALL TIME instead of being conditionally
  // assigned: a degraded tab's flush/save/offset/recovery calls must reach
  // the legacy pipeline (which is the only publisher there), never the frozen
  // kernel.doc.text.
  const attachLegacyApi = (api) => {
    if (!api) return
    legacyApi = {
      flushMarkdown: api.flushMarkdown,
      flushMarkdownSettled: api.flushMarkdownSettled,
      replaceMarkdown: api.replaceMarkdown,
      getVerifiedSyncStatus: api.getVerifiedSyncStatus,
      getRecoveryMarkdown: api.getRecoveryMarkdown,
      markdownOffsetFromSelection: api.markdownOffsetFromSelection,
      restoreMarkdownOffset: api.restoreMarkdownOffset,
      applyTextFormat: api.applyTextFormat,
      toggleHighlight: api.toggleHighlight,
      applyReviewMarkup: api.applyReviewMarkup
    }
  }
  const legacy = (name) => (degraded && typeof legacyApi?.[name] === 'function'
    ? legacyApi[name]
    : null)

  const apiOverrides = {
    // kernel.doc.text IS the durable source; no serializer round-trip, no
    // preservation mapper, no fail-closed null path. NOTE every delegate
    // branch below is an explicit `if`, never `??`: a legacy result of
    // null/undefined (fail-closed flush, void toggleHighlight) is a REAL
    // result that must propagate, not fall through to the kernel value.
    flushMarkdown: (...args) => {
      const delegate = legacy('flushMarkdown')
      if (delegate) return delegate(...args)
      return kernel.doc.text
    },
    // Await any in-flight IME composition before serving the flush: a save
    // (or any other flush caller) that ran mid-composition must see the
    // SETTLED result — either the composition's single committed edit or a
    // clean revert — never the transient in-flight candidate text.
    // `composition.settled()` never rejects and never hangs forever (a stuck
    // composition times out into a forced revert), so this can never block a
    // save indefinitely.
    flushMarkdownSettled: async (...args) => {
      const delegate = legacy('flushMarkdownSettled')
      if (delegate) return delegate(...args)
      await composition.settled()
      return kernel.doc.text
    },
    replaceMarkdown: (markdown) => {
      const delegate = legacy('replaceMarkdown')
      if (delegate) return delegate(markdown)
      if (disposed) return false
      const view = getView?.()
      if (!view) return false
      const source = String(markdown ?? '')
      // Same normalization the legacy replace path applies before parsing
      // (review-markup + display-math spelling); the kernel keeps the RAW
      // authored bytes as its text, exactly like the legacy baseline reset.
      const prepared = typeof prepareMarkdown === 'function'
        ? String(prepareMarkdown(source))
        : source
      const parsed = safeParse(prepared)
      if (!parsed) return false
      try {
        // Minimal-diff projection replace (sourceProjection meta keeps the
        // gateway from misreading our own replay as a user edit) instead of
        // crepe replaceAll: node identity outside the diff is preserved and
        // this module needs no crepe handle.
        reconcileProjection({ view, newDoc: parsed })
      } catch {
        pushKernelDiagnostic({ type: 'replace-reconcile-failed' })
        return false
      }
      kernel.doc = createMarkdownDocument(source)
      kernel.history = createSourceHistory()
      redoDepth = 0
      bindMap(view.state.doc)
      onStructureChange?.()
      return true
    },
    getVerifiedSyncStatus: (...args) => {
      const delegate = legacy('getVerifiedSyncStatus')
      if (delegate) return delegate(...args)
      return { status: 'kernel-authoritative' }
    },
    getRecoveryMarkdown: (...args) => {
      const delegate = legacy('getRecoveryMarkdown')
      if (delegate) return delegate(...args)
      return kernel.doc.text
    },
    markdownOffsetFromSelection: (...args) => {
      const delegate = legacy('markdownOffsetFromSelection')
      if (delegate) return delegate(...args)
      const view = getView?.()
      if (!view || !kernel.map) return null
      const raw = kernel.map.pmPosToRaw(view.state.selection.head)
      return Number.isFinite(raw) ? raw : null
    },
    restoreMarkdownOffset: (rawOffset, follow = false) => {
      const delegate = legacy('restoreMarkdownOffset')
      if (delegate) return delegate(rawOffset, follow)
      const view = getView?.()
      if (!view || !kernel.map) return false
      const target = kernel.map.rawToPmPos(rawOffset)
      if (!target || !Number.isFinite(target.pos)) return false
      try {
        const docNode = view.state.doc
        const clamped = Math.max(0, Math.min(target.pos, docNode.content.size))
        const tr = view.state.tr.setSelection(TextSelection.near(docNode.resolve(clamped), 1))
        if (follow && typeof tr.scrollIntoView === 'function') tr.scrollIntoView()
        view.dispatch(tr)
        if (follow) view.focus?.()
        return true
      } catch {
        return false
      }
    },
    // Rich formatting surfaces are not yet kernel-owned: refuse with a
    // notification instead of producing an unowned structural transaction.
    // (In degraded mode the legacy implementations own them again.)
    applyTextFormat: (...args) => {
      const delegate = legacy('applyTextFormat')
      if (delegate) return delegate(...args)
      return notifyUnsupportedApi('applyTextFormat')
    },
    toggleHighlight: (...args) => {
      const delegate = legacy('toggleHighlight')
      if (delegate) return delegate(...args)
      return notifyUnsupportedApi('toggleHighlight')
    },
    applyReviewMarkup: (...args) => {
      const delegate = legacy('applyReviewMarkup')
      if (delegate) return delegate(...args)
      return notifyUnsupportedApi('applyReviewMarkup')
    }
  }

  const dispose = () => {
    disposed = true
    kernel.map = null
    compositionSession.dispose()
  }

  return {
    kernel,
    handleTransactions,
    structuralKeymap,
    historyKeymap,
    structuralHandlers,
    historyHandlers,
    runHistory,
    // CM-bridge per-block gate + Mod-Enter exit (Plan 3 Task 5): consumed by
    // editor-crepe-setup.js's CodeMirror featureConfig via
    // createKernelCmExtensions' `isEditable`/`runExitCode` callbacks.
    isCmBlockEditable,
    runExitCode,
    // CM bridge degraded-fallback gate (editor-kernel-cm-bridge.js): before
    // attach / while degraded / after dispose, the kernel is not the source
    // of truth, so a CM-focused Mod-z must fall through to the nodeview's
    // own prosemirror-history binding instead of calling into a controller
    // that has nothing to undo — same delegation convention as
    // `legacy()`/`attachLegacyApi` above.
    isActive: () => !inactive(),
    apiOverrides,
    attachLegacyApi,
    refreshProjectionMap,
    attachAfterCreate,
    isDegraded: () => degraded,
    composition,
    dispose
  }
}
