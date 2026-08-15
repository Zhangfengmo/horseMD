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
  replaceVisibleText,
  routeStructuralKey
} from '../lib/source-kernel/index.js'
import { buildProjectionMap } from './editor-kernel-projection-map.js'
import { classifyTransactions, commitPlainText, commitTaskToggle } from './editor-kernel-gateway.js'
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

  const safeParse = (markdownText) => {
    try {
      return parse(markdownText) || null
    } catch {
      return null
    }
  }

  // Rebuild the projection map against the CURRENT kernel revision + a given
  // PM doc. Maps are revision-bound: every kernel.doc advancement must come
  // back through here; an old map is never reused across revisions.
  const bindMap = (pmDoc) => {
    kernel.map = pmDoc ? buildProjectionMap(kernel.doc.text, pmDoc) : null
    if (!kernel.map) {
      pushKernelDiagnostic({ type: 'map-refresh-failed', revision: kernel.doc.revision })
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
      case 'plain-text': {
        const committed = commitPlainText({ kernel, map: kernel.map, transactions, oldState })
        if (!committed.ok) {
          // Veto: the PM view never changes and kernel.doc was not advanced,
          // so both sides stay consistent with no repair needed.
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
    kernel.doc = result.doc
    if (record) recordHistory(result, txn)
    try {
      reconcileProjection({ view, newDoc: parsed })
    } catch {
      pushKernelDiagnostic({ type: 'projection-repair-failed', intent: txn.intent })
    }
    // The map must be rebound to the reconciled doc BEFORE the caret restore:
    // rawToPmPos is only meaningful on a map built for this revision.
    bindMap(view.state.doc)
    const anchor = result.selection?.anchor ?? result.selection?.head
    setCaretFromRaw(view, anchor)
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
  const commitReplace = ({ rawFrom, rawTo, text }) => {
    const view = getView?.()
    if (!view || disposed) return false
    kernel.history.breakGroup()
    const applied = applyKernelTransaction({
      baseRevision: kernel.doc.revision,
      from: rawFrom,
      to: rawTo,
      insert: text,
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
    const pair = (kernel.map?.blockPairs || []).find((candidate) => {
      if (!candidate.charMap) return false
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
  const historyHandler = (direction) => (state, dispatch, viewArg) => {
    if (inactive()) return false
    const view = viewArg || getView?.()
    if (!view) return false
    const txn = kernel.history[direction](kernel.doc)
    // Nothing to undo/redo: STILL swallow the key. PM's own history plugin
    // must never replay a structural step in kernel mode.
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
    apiOverrides,
    attachLegacyApi,
    refreshProjectionMap,
    attachAfterCreate,
    isDegraded: () => degraded,
    composition,
    dispose
  }
}
