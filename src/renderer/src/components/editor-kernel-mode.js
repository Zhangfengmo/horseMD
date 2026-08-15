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
import { classifyTransactions, commitPlainText } from './editor-kernel-gateway.js'
import { diffReplaceRange, reconcileProjection } from './editor-kernel-reconciler.js'

// Bounded diagnostics ring buffer (<=100 entries). Shared by this module and
// Editor.jsx's kernel-mode markdownUpdated gate. Entries carry structural
// metadata only — never document content.
export function pushKernelDiagnostic(entry) {
  const buffer = (globalThis.__hmKernelDiagnostics ||= [])
  buffer.push({ at: Date.now(), ...entry })
  if (buffer.length > 100) buffer.shift()
}

const STRUCTURAL_KEYS = ['Enter', 'Tab', 'Shift-Tab', 'Backspace', 'Delete']

export function createKernelMode({ initialContent, getView, parse, notify, getT, onChange }) {
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

  const inactive = () => disposed || degraded || !attached

  const tOr = (key, fallback) => {
    const value = getT?.(key)
    return !value || value === key ? fallback : value
  }
  const notifyBlocked = (code) => {
    notify?.(`${tOr('kernelMode.unsupported', 'Kernel mode blocked this edit')} (${code})`)
  }
  const notifyUnmappable = () => {
    notify?.(tOr(
      'kernelMode.unmappable',
      'Kernel mode could not map this document; legacy editing stays active'
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
        // Pass through; CompositionSession bookkeeping arrives with Task 6.
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
        kernel.history.record(committed.applied, committed.transaction)
        bindMap(newState?.doc || null)
        if (newState?.doc) verifyPlainTextProjection(newState.doc)
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
    if (record) kernel.history.record(result, txn)
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

  const historyHandler = (direction) => (state, dispatch, viewArg) => {
    if (inactive()) return false
    const view = viewArg || getView?.()
    if (!view) return false
    const txn = kernel.history[direction](kernel.doc)
    // Nothing to undo/redo: STILL swallow the key. PM's own history plugin
    // must never replay a structural step in kernel mode.
    if (!txn) return true
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

  const apiOverrides = {
    // kernel.doc.text IS the durable source; no serializer round-trip, no
    // preservation mapper, no fail-closed null path.
    flushMarkdown: () => kernel.doc.text,
    // Task 6 supplies the real composition settle; until then the kernel text
    // is immediately settled by construction.
    flushMarkdownSettled: async () => kernel.doc.text,
    replaceMarkdown: (markdown) => {
      if (disposed) return false
      const view = getView?.()
      if (!view) return false
      const source = String(markdown ?? '')
      const parsed = safeParse(source)
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
      bindMap(view.state.doc)
      return true
    },
    getVerifiedSyncStatus: () => ({ status: 'kernel-authoritative' }),
    getRecoveryMarkdown: () => kernel.doc.text,
    markdownOffsetFromSelection: () => {
      const view = getView?.()
      if (!view || !kernel.map) return null
      const raw = kernel.map.pmPosToRaw(view.state.selection.head)
      return Number.isFinite(raw) ? raw : null
    },
    restoreMarkdownOffset: (rawOffset, follow = false) => {
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
    applyTextFormat: () => notifyUnsupportedApi('applyTextFormat'),
    toggleHighlight: () => notifyUnsupportedApi('toggleHighlight'),
    applyReviewMarkup: () => notifyUnsupportedApi('applyReviewMarkup')
  }

  const dispose = () => {
    disposed = true
    kernel.map = null
  }

  return {
    kernel,
    handleTransactions,
    structuralKeymap,
    historyKeymap,
    structuralHandlers,
    historyHandlers,
    apiOverrides,
    refreshProjectionMap,
    attachAfterCreate,
    isDegraded: () => degraded,
    dispose
  }
}
