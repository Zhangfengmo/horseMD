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
import { Plugin, TextSelection, NodeSelection } from '@milkdown/prose/state'
import { Fragment } from '@milkdown/prose/model'
import { Decoration, DecorationSet } from '@milkdown/prose/view'
// Table-cell navigation (Plan 5 Task 4 review fix): the SAME two commands
// @milkdown/preset-gfm's own `tableKeymap` binds Tab / Shift-Tab to
// (preset-gfm/lib/index.js:415-420 + :652-667 — `goToNextTableCellCommand` IS
// `goToNextCell(1)`), so kernel mode reproduces the editor's expected
// behaviour rather than shadowing it. Both are SELECTION-only commands (they
// dispatch nothing but `tr.setSelection(...).scrollIntoView()`), so they write
// no bytes and the gateway classifies their transaction as `selection-only`.
// `selectedRect` / `CellSelection` (table-ops, 2026-08-22): the routed table
// buttons (add/delete row & column, alignment) resolve WHICH table and WHICH
// row/column from the live CellSelection the table block-handle UI has just
// set — the same facts prosemirror-tables' own commands would have consumed —
// and then rewrite the table's SOURCE bytes instead of dispatching the
// structural PM transaction the gateway vetoes.
import { CellSelection, goToNextCell, isInTable, selectedRect } from '@milkdown/prose/tables'
import {
  KERNEL_CODES,
  applySourceTransaction,
  buildSyntaxIndex,
  createMarkdownDocument,
  createSourceHistory,
  exitCodeBlock,
  deleteEmptyCodeBlock,
  insertHeadingLeadingWhitespace,
  spellBlockTailInsert,
  literalTailIsStripped,
  healableTrailingSpace,
  spellLineStartWhitespace,
  spellMarkerCompletingSpace,
  spellMarkerRunGrowth,
  spellMarkerFollowingText,
  escapePolicyForInsert,
  trimTrailingBlankLines,
  shrinkBlankRun,
  looksLikeBlockLineStart,
  healableLineStartRun,
  replaceVisibleText,
  routeStructuralKey,
  toggleBlockquote,
  setBlockTypeFromQuery,
  convertBlockTypeAtCaret,
  demoteHeadingAtCaret,
  looksLikeAtxContentStart,
  insertBlockFromQuery,
  insertTableRow,
  insertTableColumn,
  deleteTableRow,
  deleteTableColumn,
  moveTableRow,
  moveTableColumn,
  setTableColumnAlignment,
  TABLE_OP_CODES,
  toggleInlineMark,
  wrapReviewMarkup,
  resolveReviewMarker,
  parseKernelMarkdown,
  outsideSignature
} from '../lib/source-kernel/index.js'
import { buildProjectionMap } from './editor-kernel-projection-map.js'
import { resolveCommittedRawOffset } from '../lib/source-kernel/commands/insert-point.js'
import { resolveWhitespaceForPublish } from '../lib/source-kernel/commands/trailing-whitespace.js'
import { classifyTransactions, commitPlainText, commitMarkInputRule, commitResolvedTextSteps, commitTaskToggle, commitCodeLanguage, commitImageAttrs, routeLinkEdit, routeTrailingAtomTyping, isTypableTextblock } from './editor-kernel-gateway.js'
import { pairIsReadOnlyToUser, readOnlyPairAt } from '../lib/kernel-status.js'
import { diffReplaceRange, diffReplaceRegions, reconcileProjection, reconcileProjectionRegions } from './editor-kernel-reconciler.js'
import { createCompositionSession } from './editor-kernel-composition.js'
import { createUndecidedOrdinalPlugin } from './editor-kernel-undecided-ordinal.js'
import { areDurablyEquivalent } from './editor-durable-semantics.js'

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
  chunkedLoad = false,
  getView,
  parse,
  prepareMarkdown,
  // Markdown for a PM doc node, from the editor's OWN serializer. Only the
  // paste route uses it, and only for content that has no bytes yet (see
  // `commitPaste`) — never to re-derive bytes the document already owns.
  serializeDoc,
  notify,
  getT,
  onChange,
  onStructureChange,
  onStatusChange,
  onLegacyFallback
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
    // A code with its OWN message says what actually happened; the generic one
    // plus a machine code is the fallback for everything else. `tOr` answers the
    // fallback when a key is missing, so adding a message is opt-in per code and
    // an unknown code degrades to exactly the previous string.
    //
    // The fallback is `blockedGeneric`, NOT `kernelMode.unsupported`: that key
    // now serves only the "this command is unavailable in kernel mode" callers
    // (the slash menu's blocked items, Editor.jsx's list conversions), where
    // nothing was attempted. Here an edit WAS attempted and refused, and the
    // old shared string called it "not supported yet in the experimental
    // kernel" — stale on both counts since the kernel became the default
    // (2026-08-22), and it read as a missing feature rather than as a refusal.
    const specific = tOr(`kernelMode.blocked.${code}`, '')
    notify?.(specific || `${tOr('kernelMode.blockedGeneric', 'Kernel mode blocked this edit')} (${code})`)
  }
  // Why this tab fell back to legacy, or null while the kernel is live. Read
  // by `getKernelStatus` (P6 Task 3) so the fallback is reportable instead of
  // being a state only a toast that already vanished ever mentioned.
  let degradeReason = null
  // P6 Task 5 — the ABOVE-THRESHOLD fallback, stated instead of implied.
  //
  // A document longer than `CHUNK_THRESHOLD` (editor-chunked-parse.js) is not
  // parsed once: `appendChunks` parses each ~40 KB chunk SEPARATELY and
  // appends it, while the kernel parses the whole text in one go. The two
  // genuinely disagree on real content — measured on a 262 KB concatenation of
  // this repo's own docs/ (6 chunks): 1585 blocks whole-document vs 1572
  // chunked, first divergence at block 647. A blank-line-separated list is one
  // loose list to a whole parse and two lists to a chunked one; a chunk
  // boundary near a fence shifts a code block the same way. So the projection
  // map's block zip refuses, `attachAfterCreate` degrades, and the ENTIRE
  // 120-400 KB band silently ran in legacy — the mode the fidelity bug family
  // lives in — with the user told nothing.
  //
  // WHY THE MIRRORING FIX WAS NOT TAKEN (plan Task 5 option (d): have the
  // kernel parse the same chunks and shift each chunk's mdast positions by its
  // raw start offset). The arithmetic itself is exact — re-verified here:
  // `chunks.join('\n') === text` byte-for-byte and `text.slice(off,
  // off+chunk.length) === chunk` for every chunk, LF and CRLF alike. It is the
  // REST of the kernel that does not mirror:
  //  * `safeParse` (below) parses the WHOLE text with the editor chain, and it
  //    is what `verifyPlainTextProjection` diffs the view against after every
  //    plain-text commit and what `reconcileProjection` repairs the view TO.
  //    With only the kernel's own parse mirrored, the first keystroke would
  //    reconcile the view to the whole-document shape and the very next
  //    `bindMap` would find the chunked kernel tree disagreeing with it —
  //    map null, document permanently unwritable. Mirroring that path too
  //    means a second chunk-aware parse entry point on the byte-repair path.
  //  * chunk boundaries are recomputed from the CURRENT text on every rebind
  //    (`splitMarkdown` cuts at the first blank line at/after 40 000
  //    accumulated chars), so an edit that moves one boundary changes the
  //    block sequence while the PM doc keeps the old one. The map would flip
  //    between mappable and unmappable as the user types. That is an
  //    assumption about edit locality wearing a proof's clothes.
  // THAT ADR STANDS — the kernel still never learns what a chunk is.
  //
  // WHAT CHANGED (2026-08-21, option (b)): the chunked PM document is
  // REPAIRED to its whole-document parse ONCE, at the end of the load, before
  // attach is attempted. `repairChunkedProjection` below reparses
  // `kernel.doc.text` with the editor's own parser — the same `safeParse` the
  // hot path uses, so there is no second parse entry point — diffs the live
  // document against it with `diffReplaceRegions`
  // (editor-kernel-reconciler.js) and replaces only the regions that
  // genuinely disagree. The split lists rejoin, the view becomes the
  // whole-document parse, and the attach that follows runs the ORDINARY full
  // pairing against it. Nothing about the ongoing edit path is weakened: the
  // repair consults no chunk boundary, makes no locality assumption, and is
  // over before the first keystroke.
  //
  // Attach is still ATTEMPTED and still decided by the map, never by the
  // flag; what the repair changes is which document the map is asked about.
  // Both remaining chunk-load refusals keep their own named message: a
  // document whose whole-document reparse itself fails
  // (`kernelMode.chunkRepairFailed`), and one that is still unmappable after
  // a successful repair (`kernelMode.unmappableChunked`).
  //
  // `chunkRepair` records what the repair actually did, so the refusal below
  // describes the measured situation rather than the document's length:
  //   null                       — never attempted (not a chunked load)
  //   { ok: true,  regions, … }  — the view IS the whole-document parse
  //   { ok: false, failure, … }  — 'reparse' | 'diverged' | 'reconcile'
  let chunkRepair = null
  const notifyUnmappable = () => {
    if (chunkRepair && chunkRepair.ok === false) {
      degradeReason = 'chunk-repair'
      notify?.(tOr(
        'kernelMode.chunkRepairFailed',
        'This document had to be loaded in pieces and could not be reassembled for the source kernel; legacy editing stays active'
      ))
      return
    }
    degradeReason = chunkedLoad ? 'chunked' : 'unmappable'
    notify?.(chunkedLoad
      ? tOr(
        'kernelMode.unmappableChunked',
        'This document was loaded in pieces and reassembled, but the source kernel still could not pair it with the editor; legacy editing stays active'
      )
      : tOr(
        'kernelMode.unmappable',
        'Kernel mode could not map this document; legacy editing stays active (some toolbar features remain off)'
      ))
  }
  // BLOCK-scoped refusal (P5-2.5 review finding). Since per-block degradation,
  // `UNMAPPED` covers two very different situations: a transient/unsupported
  // position (the generic "not supported yet" case) and a block the kernel
  // could not prove, which is PERMANENTLY read-only for this revision — the
  // user cannot type in it, cannot Enter out of it, cannot even delete their
  // way out. Telling them "this operation isn't supported yet" for the second
  // one is misleading, so every call site that can TELL the difference (i.e.
  // has a PM position to test) raises this message instead. Same cooldown
  // bookkeeping as `notifyBlocked`, keyed on its own pseudo-code so a
  // block-read-only toast never suppresses (or is suppressed by) a generic
  // one.
  const BLOCK_READ_ONLY = 'block-read-only'
  const notifyBlockReadOnly = (pair) => {
    // The diagnostic is pushed on EVERY refusal (no cooldown): it is the
    // machine-readable record a test/bug report needs, and suppressing it
    // would make a second refusal in the same window invisible. Only the
    // user-facing toast is rate-limited.
    //
    // `block` names the PM node type the message is ABOUT (structural metadata,
    // never content). Without it the diagnostic could not distinguish "the
    // paragraph the caret is in is unprovable" from "the enclosing bullet_list
    // was blamed" — which is exactly how the 2026-08-20 mis-attribution stayed
    // invisible while its own diagnostic was being recorded.
    pushKernelDiagnostic({
      type: BLOCK_READ_ONLY,
      revision: kernel.doc.revision,
      block: pair?.pmNode?.type?.name ?? null
    })
    const now = Date.now()
    if (now - (lastNotifyAt.get(BLOCK_READ_ONLY) || 0) < NOTIFY_COOLDOWN_MS) return
    lastNotifyAt.set(BLOCK_READ_ONLY, now)
    notify?.(tOr(
      'kernelMode.blockReadOnly',
      'This paragraph is read-only in the source kernel (its source could not be proven); the rest of the document still edits normally'
    ))
  }
  // Is `pmPos` inside a block that is READ-ONLY TO THE USER? Resolved by the
  // pair's own NODE span (a degraded pair has no charMap, so it has no content
  // range to search with — `pairAt` skips it by design), through the SAME
  // predicate `getKernelStatus` counts with (lib/kernel-status.js
  // `readOnlyPairAt`/`pairIsReadOnlyToUser`). It used to carry a private copy
  // of the pre-2026-08-18 rule (`!charMap && !virtual`, first match wins),
  // which answered YES for every list / list item / blockquote in the document
  // and made a perfectly ordinary structural refusal inside a bullet list claim
  // the paragraph was permanently unprovable — see that module's header for the
  // measurement. Non-editable-by-construction leaves (table, image-block, block
  // HTML, math) are still reported this way on purpose: from the user's seat
  // they are the same situation.
  const degradedPairAt = (pmPos) =>
    readOnlyPairAt(kernel.map?.blockPairs, pmPos, isTypableTextblock)
  // Refusal reporter for the paths that hold a PM position: a degraded block
  // gets the block-scoped message, everything else keeps the generic one.
  const notifyRefusal = (code, pmPos) => {
    const pair = degradedPairAt(pmPos)
    if (pair) notifyBlockReadOnly(pair)
    else notifyBlocked(code)
  }
  // Where a refused BATCH was trying to write, in `oldState` coordinates. The
  // first step of the first doc-changing transaction is always expressed in
  // that space (later steps are rebased — see extractPlainTextSteps' doc
  // comment), which is exactly the position `degradedPairAt` needs. The live
  // selection is NOT a substitute: a batch can target a block the caret is not
  // in (programmatic inserts, IME replays, find/replace), and reporting the
  // caret's block would then describe the wrong paragraph. Falls back to the
  // selection only when no step position is available.
  const batchTargetPos = (transactions, oldState) => {
    const trs = Array.isArray(transactions) ? transactions : [transactions]
    for (const tr of trs) {
      if (!tr?.docChanged || !Array.isArray(tr.steps)) continue
      for (const step of tr.steps) {
        if (Number.isFinite(step?.from)) return step.from
      }
    }
    return oldState?.selection?.from
  }

  // A paste is mid-flight (its DOM event is still dispatching). Recorded at the
  // DOM level because the DISPATCHERS disagree: ProseMirror's own `doPaste`
  // sets `paste`/`uiEvent` metas, editor-md-paste.js now sets them too, but
  // @milkdown/plugin-clipboard dispatches its slice with no metas at all
  // (node_modules/@milkdown/plugin-clipboard/lib/index.js) — and that is the
  // dispatcher a plain multi-paragraph paste goes through. One capture-phase
  // listener sees every one of them, before any of them runs.
  let pasteDepth = 0
  const pasteInFlight = () => pasteDepth > 0
  const pasteFlagPlugin = () =>
    new Plugin({
      view: (view) => {
        const onPaste = () => {
          pasteDepth += 1
          // Paste handling is synchronous inside the event dispatch; the flag
          // must not outlive that task, or an unrelated later transaction
          // would be judged a paste.
          setTimeout(() => { pasteDepth = Math.max(0, pasteDepth - 1) }, 0)
        }
        view.dom.addEventListener('paste', onPaste, true)
        return { destroy: () => view.dom.removeEventListener('paste', onPaste, true) }
      }
    })

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

  // Mirror `@milkdown/preset-commonmark`'s `syncHeadingIdPlugin` the same way
  // `withTrailingParagraph` above mirrors `@milkdown/plugin-trailing`, and for
  // exactly the same class of reason: it is a VIEW plugin that writes a value
  // into the live document which a raw parse can never produce. Every live
  // heading carries a generated `attrs.id` slug; `parse(kernel.doc.text)`
  // always comes back with `id: ''` because heading ids have no Markdown
  // representation at all. Left uncorrected, EVERY doc-to-doc comparison
  // (verifyPlainTextProjection's diff, reconcileProjection's target) reported
  // a difference at the FIRST heading and another at the LAST — so the
  // "minimal" diff spanned the whole document and every keystroke in a
  // heading-bearing document replaced the entire doc, remounting every node
  // view (CodeMirror, Mermaid, images) and wiping every heading id, which the
  // plugin then tried to restore in a batch the gateway refused. That is the
  // churn half of the 2026-08-17 veto-divergence report.
  //
  // The ids are COPIED FROM THE LIVE DOCUMENT rather than regenerated here:
  // the plugin owns that value (slug algorithm + duplicate `-#N` suffixes),
  // and re-deriving it in a second place would make the two disagree the day
  // Milkdown changes it — reintroducing the permanent mismatch this fixes.
  // Copying is self-consistent by construction: whatever the live document
  // says today is what the parse is compared against today, and when the
  // plugin updates an id (heading text edited) the gateway's `heading-id`
  // pass-through lets that update land, so the next parse copies the new one.
  //
  // Positional pairing, gated on an EQUAL heading count. A keystroke never
  // changes the number of headings, which is the case that matters; when a
  // structural edit does change it, this bails out and leaves the parse's
  // empty ids alone — one reconcile with wiped ids, which the plugin then
  // refills through the (now classified) heading-id batch. Fail-open is safe
  // here precisely because ids are not bytes: the worst outcome is the old
  // behaviour for one transaction, never a wrong byte.
  const withHeadingIds = (docNode) => {
    try {
      const live = getView?.()?.state?.doc
      if (!live || !docNode) return docNode
      const liveIds = []
      live.descendants((node) => {
        if (node.type?.name === 'heading') liveIds.push(node.attrs?.id ?? '')
        return true
      })
      if (!liveIds.length) return docNode
      let parsedHeadings = 0
      docNode.descendants((node) => {
        if (node.type?.name === 'heading') parsedHeadings += 1
        return true
      })
      if (parsedHeadings !== liveIds.length) return docNode
      let cursor = 0
      const rewrite = (node) => {
        let result = node
        node.forEach((child, _offset, index) => {
          const mapped = rewrite(child)
          if (mapped !== child) result = result.copy(result.content.replaceChild(index, mapped))
        })
        if (result.type?.name === 'heading') {
          const id = liveIds[cursor]
          cursor += 1
          if (typeof id === 'string' && id !== (result.attrs?.id ?? '')) {
            result = result.type.create({ ...result.attrs, id }, result.content, result.marks)
          }
        }
        return result
      }
      return rewrite(docNode)
    } catch {
      return docNode
    }
  }

  const safeParse = (markdownText) => {
    try {
      const parsed = parse(markdownText) || null
      return parsed ? withHeadingIds(withTrailingParagraph(parsed)) : null
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
  // Perf counters (perf assessment §9, 2026-08-21). Real work counts, not
  // instrumentation guesses: `projectionMapBuilds` increments only when
  // `buildProjectionMap` actually runs, `projectionMapReuses` only when a
  // transaction-validated map is adopted without a rebuild. Exposed through
  // `getPerfStats` so the headless suites can pin the duplicate-work fixes
  // behaviorally (and so the next assessment can measure without probes).
  const perfStats = {
    projectionMapBuilds: 0,
    projectionMapReuses: 0,
    verifyRuns: 0,
    verifyScheduled: 0
  }

  const bindMap = (pmDoc, pending = null, reuse = null) => {
    const isChain = Array.isArray(pending)
    const list = isChain ? pending : (pending ? [pending] : [])
    splitPlaceholders = list
    // Reuse the map the caller ALREADY built and validated for exactly this
    // text/doc pair (perf assessment §9 #2): `applyKernelTransaction` builds
    // `nextMap` from (result.doc.text, parsed) for its requireMap/anchor
    // proofs, reconciles the view to `parsed`, then lands here — where the
    // rebuild would construct the identical map a second time (~190 ms at
    // 200 KB). Adoption is guarded by `pmDoc.eq(reuse.doc)`: the map is only
    // served for a view doc VALUE-EQUAL to the parse it was proven against
    // (kernel.doc.text is already `result.doc.text` by the time the caller
    // gets here). A reconcile that failed or diverged makes `eq` false and
    // falls through to the honest rebuild. Never combined with a placeholder
    // voucher — `pending` implies a pairing `nextMap` was not built with.
    if (!list.length && pmDoc && reuse?.map && reuse.doc && pmDoc.eq(reuse.doc)) {
      kernel.map = reuse.map
      perfStats.projectionMapReuses += 1
      publishStatus()
      return kernel.map
    }
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
    if (pmDoc) perfStats.projectionMapBuilds += 1
    if (!kernel.map) {
      pushKernelDiagnostic({ type: 'map-refresh-failed', revision: kernel.doc.revision })
      splitPlaceholders = []
    }
    // The read-only-block count can change on any rebind (a block newly
    // proven, or newly unprovable), so the status is published here rather
    // than only at attach. `publishStatus` de-duplicates, so an unchanged
    // status costs nothing.
    publishStatus()
    return kernel.map
  }

  // Observable degradation (P6 Task 3). Both kinds were silent: a block
  // degraded to `charMap: null` only manifests as "this paragraph won't take
  // typing", and a whole-document fallback to legacy manifests as nothing at
  // all — yet legacy is the mode the byte-fidelity bug family lives in. This
  // is the machine-readable state the StatusBar renders (through the pure
  // `describeKernelStatus`, lib/kernel-status.js).
  //
  //   'off'     disposed — the kernel is gone
  //   'legacy'  attach refused; every edit runs the legacy pipeline
  //   'pending' created but not attached yet (Crepe still building the doc)
  //   'partial' attached, but N blocks are read-only to the USER
  //   'normal'  attached, every block the user can reach is writable
  //
  // ===========================================================================
  // WHAT COUNTS AS A READ-ONLY BLOCK (rewritten 2026-08-18)
  // ===========================================================================
  // The count used to be `!pair.charMap && !pair.virtual` — "a pair the
  // projection map refused". That is a statement about the MAP, and it was
  // wrong in BOTH directions:
  //
  // FALSE POSITIVE (the serious one, because this file's own rule is that a
  // false warning is worse than the silence it replaced). `blockPairs` carries
  // one entry per structural node on BOTH sides, containers included — and a
  // container is never a textblock, so it can never claim a charMap. Measured
  // against a real `buildProjectionMap`: a two-item bullet list reports THREE
  // read-only blocks (the list plus both items), a blockquote one, a `---`
  // divider one, a frontmatter block one. In other words nearly every real
  // document displayed 「部分块只读」 permanently. None of those is a place the
  // user can put a caret and type: a list/blockquote/list_item's editability
  // is entirely its children's (which have their own pairs, and are counted on
  // their own evidence), and an `hr`/`frontmatter`/`image-block` is a
  // structurally opaque LEAF with no text surface at all — read-only by
  // construction, not by degradation.
  //
  // FALSE NEGATIVE. A block can also be untypable while holding a perfectly
  // good charMap, because the refusal lives one layer up in
  // editor-kernel-gateway.js's inline-shape guard (`isTypableTextblock`). The
  // hard-break paragraph was exactly that until 2026-08-18 — a document could
  // read 「源码内核已生效」 while one of its paragraphs refused every keystroke.
  // Hard breaks are typable now, and the gateway's allowlist covers every
  // inline node the live schema declares (text/image/html/hardbreak/
  // math_inline/footnote_reference), so no shape is known to reach this today
  // — which is precisely why the check is wired rather than argued: the next
  // inline node type someone adds must show up in the badge, not in a bug
  // report.
  //
  // So the predicate is "a block the user can see and cannot edit":
  //   * a TEXTBLOCK with no charMap (paragraph/heading/code_block/block-HTML
  //     wrapper the map could not prove) — a caret goes there and typing is
  //     refused. Counted, empty or not.
  //   * a textblock WITH a charMap whose inline shape the gateway refuses.
  //     Counted.
  //   * anything else (containers, opaque leaves) is counted ONLY when it is a
  //     leaf of the pairing (no nested pair speaks for its interior) AND it
  //     actually holds visible text. That keeps a `table` whose cells could not
  //     be zipped — genuinely readable, genuinely uneditable — in the count,
  //     while excluding every container and every content-less atom.
  // The rule itself lives in lib/kernel-status.js — the SAME function the
  // per-block toast resolves through (`degradedPairAt` above), so the badge and
  // the message cannot disagree. It was a private copy here until 2026-08-20,
  // and the copy that stayed behind in `degradedPairAt` is precisely what
  // drifted.
  const getKernelStatus = () => {
    if (disposed) return { state: 'off', readOnlyBlocks: 0, blocks: 0, reason: null }
    if (degraded) return { state: 'legacy', readOnlyBlocks: 0, blocks: 0, reason: degradeReason }
    if (!attached) return { state: 'pending', readOnlyBlocks: 0, blocks: 0, reason: null }
    const pairs = kernel.map?.blockPairs || []
    let readOnlyBlocks = 0
    for (let i = 0; i < pairs.length; i += 1) {
      if (pairIsReadOnlyToUser(pairs[i], pairs[i + 1], isTypableTextblock)) readOnlyBlocks += 1
    }
    return {
      state: readOnlyBlocks > 0 ? 'partial' : 'normal',
      readOnlyBlocks,
      blocks: pairs.length,
      reason: null
    }
  }
  // Emit only on a real CHANGE. `bindMap` runs on every accepted commit, and
  // pushing an identical status into React on each keystroke would be pure
  // re-render churn for a value that changes a handful of times per session.
  //
  // DEFERRED since lazy charMaps (§9 #4): the read-only COUNT is the one
  // consumer that reads every pair's charMap, i.e. it would force the whole
  // document's materialization on every rebind and single-handedly defeat
  // the laziness. The publish therefore runs on a short trailing debounce —
  // during a typing burst the timer keeps re-arming and the scan never runs;
  // at rest it runs once, against the final map. `getKernelStatus` itself
  // stays synchronous for direct callers (StatusBar menu open), and DISPOSE
  // publishes immediately — a torn-down editor must not leave a stale badge
  // behind while a timer spins.
  let lastStatusKey = null
  let statusTimer = null
  const STATUS_DEBOUNCE_MS = 150
  const publishStatusNow = () => {
    if (statusTimer) {
      clearTimeout(statusTimer)
      statusTimer = null
    }
    if (typeof onStatusChange !== 'function') return
    const status = getKernelStatus()
    const key = `${status.state}:${status.readOnlyBlocks}:${status.blocks}:${status.reason || ''}`
    if (key === lastStatusKey) return
    lastStatusKey = key
    onStatusChange(status)
  }
  const publishStatus = () => {
    if (typeof onStatusChange !== 'function') return
    if (disposed) {
      publishStatusNow()
      return
    }
    if (statusTimer) clearTimeout(statusTimer)
    statusTimer = setTimeout(publishStatusNow, STATUS_DEBOUNCE_MS)
    // Never keep a headless process alive for a pending badge update.
    if (typeof statusTimer?.unref === 'function') statusTimer.unref()
  }

  const refreshProjectionMap = () => {
    const view = getView?.()
    if (!view || disposed) return null
    return bindMap(view.state.doc)
  }

  // THE CHUNK-LOAD REPAIR (2026-08-21). Called by Editor.jsx once
  // `appendChunks` has appended the LAST chunk and BEFORE it restores
  // editability — i.e. inside the window the loader already holds the editor
  // read-only, so there is no user edit for the repair to lose and no race to
  // arbitrate. Attach then follows in `finishInitial`, in the same turn order
  // as an unchunked document.
  //
  // Two yields (`yieldTurn`) break the work into three tasks — reparse,
  // diff+dispatch, done — so a 400 KB document blocks the main thread for one
  // parse at a time instead of one parse plus one map build back to back. The
  // loader already yields between chunks for the same reason.
  //
  // FAIL-CLOSED, like everything else here: any step that cannot be completed
  // records its reason in `chunkRepair` and leaves the view untouched (or, for
  // a reconcile that threw, exactly as PM left it). The attach that follows
  // then refuses with the matching named message. A repair is never
  // half-believed: the post-reconcile `eq` check below is the proof that the
  // live document IS the whole-document parse, and without it the attach
  // would be pairing against a document nobody verified.
  const repairChunkedProjection = async ({ yieldTurn } = {}) => {
    if (disposed || attached || degraded) return false
    if (!getView?.()) return false
    const pause = typeof yieldTurn === 'function' ? yieldTurn : () => Promise.resolve()
    const fail = (failure) => {
      chunkRepair = { ok: false, failure, regions: 0 }
      pushKernelDiagnostic({ type: 'chunk-repair-failed', reason: failure })
      return false
    }

    // Wall-clock cost of the repair, excluding the yields — the one-time
    // price this whole design is judged on, recorded where it actually
    // happens instead of being inferred from a long-task trace that also
    // contains the chunk parses. Structural metadata; no content.
    let spent = 0
    const clock = () => (globalThis.performance?.now?.() ?? Date.now())
    let mark = clock()

    const parsed = safeParse(kernel.doc.text)
    if (!parsed) return fail('reparse')
    spent += clock() - mark
    await pause()
    if (disposed) return false
    const view = getView?.()
    if (!view) return false

    mark = clock()
    let regions = []
    try {
      regions = diffReplaceRegions(view.state.doc, parsed)
    } catch {
      return fail('reconcile')
    }
    if (regions.length) {
      try {
        reconcileProjectionRegions({ view, newDoc: parsed, regions, mapMeta: { chunkRepair: true } })
      } catch {
        return fail('reconcile')
      }
    }
    spent += clock() - mark
    await pause()
    if (disposed) return false
    const repaired = getView?.()?.state?.doc
    if (!repaired || !repaired.eq(parsed)) return fail('diverged')

    chunkRepair = { ok: true, failure: null, regions: regions.length, ms: Math.round(spent) }
    pushKernelDiagnostic({
      type: 'chunk-repair',
      regions: regions.length,
      // Structural metadata only — how much of the document the repair had to
      // rewrite, never any of its content. This is the number the node-view
      // identity budget is expressed in.
      touched: regions.reduce((total, region) => total + (region.to - region.from), 0),
      size: repaired.content.size,
      ms: Math.round(spent)
    })
    return true
  }

  const attachAfterCreate = () => {
    if (disposed) return false
    const view = getView?.()
    const startedAt = globalThis.performance?.now?.() ?? Date.now()
    const map = view ? buildProjectionMap(kernel.doc.text, view.state.doc) : null
    if (!map) {
      degraded = true
      // `chunked` rides on the diagnostic so a bug report can tell the two
      // fallbacks apart without guessing from the document's length.
      pushKernelDiagnostic({ type: 'attach-unmappable', chunked: chunkedLoad })
      notifyUnmappable()
      publishStatus()
      // THE degradation edge, announced exactly once (this is the only place
      // `degraded` is ever set). The host uses it to hand the tab back to the
      // legacy pipeline wholesale — most importantly to register Milkdown's
      // `markdownUpdated` listener, which a live kernel tab deliberately does
      // NOT register (Editor.jsx) because the serializer run behind it is pure
      // waste there, but which is the ONLY publisher a degraded tab has.
      try {
        onLegacyFallback?.({ chunked: chunkedLoad, reason: degradeReason })
      } catch {
        pushKernelDiagnostic({ type: 'legacy-fallback-notify-failed' })
      }
      return false
    }
    kernel.map = map
    attached = true
    // The successful attach of a CHUNK-LOADED document is the only success
    // this function reports, and it reports it for one reason: the one-time
    // cost of the above-threshold path is a product claim, and a claim needs
    // a measurement taken where the work happens. Emitted only for chunked
    // loads, so no ordinary document gains a diagnostic it never had.
    if (chunkedLoad) {
      pushKernelDiagnostic({
        type: 'chunk-attach',
        ms: Math.round((globalThis.performance?.now?.() ?? Date.now()) - startedAt),
        blocks: map.blockPairs?.length ?? 0
      })
    }
    publishStatus()
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
  // THE OBSERVABILITY INVARIANT (2026-08-18). `verifyPlainTextProjection` below
  // proves the VIEW and the BYTES agree — necessary, but it is exactly the check
  // that BOTH whitespace defects in this family walked past, because a character
  // dropped on both sides leaves the two in perfect agreement. This is the
  // missing half: the edit the user asked for must be OBSERVABLE in what the
  // bytes reparse to.
  //
  // It reads the map `bindMap` has just rebuilt, so it costs no extra parse and
  // no extra map build. It runs AFTER the bytes are published, so it raises a
  // diagnostic rather than refusing — the per-shape commands
  // (commands/heading-whitespace.js, commands/trailing-whitespace.js) are the
  // fail-closed gates, and this is the net underneath them that makes the whole
  // class detectable and assertable instead of invisible. The one known benign
  // firing is recorded in editor-kernel-gateway.js, in the ADR headed
  // `THE OBSERVABILITY EXPECTATION (result.observability, 2026-08-18)` —
  // directly above `commitPlainText`.
  const verifyEditObservable = (expectation) => {
    if (!expectation || !kernel.map) return
    const pair = (kernel.map.blockPairs || []).find((candidate) => candidate.pmPos === expectation.pmPos)
    const actual = pair?.charMap?.visibleLength
    // An unmapped/degraded block is a different failure with its own signal.
    if (!Number.isFinite(actual)) return
    if (actual === expectation.expectedVisibleLength) return
    pushKernelDiagnostic({
      type: 'edit-unobservable',
      expected: expectation.expectedVisibleLength,
      actual,
      revision: kernel.doc.revision
    })
  }

  const verifyPlainTextProjection = (newDoc, caretRaw = null) => {
    perfStats.verifyRuns += 1
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
      // SELECTION IS SOURCE-AUTHORITATIVE TOO (2026-08-21). This repair fires
      // exactly when a plain-text commit's reparse changed STRUCTURE — the
      // bare-marker family (`*` on a blank line becomes an empty bullet item)
      // is its everyday case, not an anomaly. `tr.replace` then maps the old
      // selection through the diff, which threw the caret into the trailing
      // placeholder: the user's next keystroke landed in the WRONG block,
      // severing their text from the marker they just typed (measured: `*`
      // then `a` produced `*\n\na`). The committed transaction's own
      // selection anchor is the byte the caret must follow, so resolve it
      // against the map of the PARSED doc — `rawToPmCaret`, whose empty-
      // textblock fallback is exactly the bare-marker shape — and ride the
      // selection on the SAME reconcile transaction (a follow-up dispatch
      // cannot target content whose node-view DOM hasn't mounted; see
      // applyKernelTransaction's identical protocol).
      let caretPos = null
      if (Number.isFinite(caretRaw)) {
        try {
          const nextMap = buildProjectionMap(kernel.doc.text, parsed)
          // Same three-step ladder as `applyKernelTransaction`, in the same
          // order of decreasing strength: the WRITE resolver (`rawToPmPos`,
          // inside `resolveCommittedRawOffset`), then the inverse of the
          // writer's own zero-width insert point, then `rawToPmCaret`'s
          // empty-textblock derivation. The middle rung is this file's own
          // committed anchor coming home: a plain char committed at a mark
          // run's edge sits just outside the delimiters, which is no unit
          // boundary, so this repair used to drop the caret with
          // `caret-unmappable` (measured while typing ASCII `**bold**`).
          const found = resolveCommittedRawOffset(nextMap, caretRaw) || nextMap?.rawToPmCaret?.(caretRaw)
          if (found && Number.isFinite(found.pos)) caretPos = found.pos
          // FOURTH RUNG — THE BARE MARKER (2026-08-29, measured: Enter, then
          // `##`, with any content BELOW). `##` alone is an empty ATX heading:
          // it owns no character-map unit, so the three rungs above cannot
          // name a position inside it, and the repair used to leave the caret
          // wherever the reconcile put it — the NEXT paragraph. The following
          // Space then completed nothing and the title was typed into the
          // wrong block (`开头段。\n\n##\n\n 标题尾段。`). At the document end
          // the same keystrokes work, because the trailing placeholder gives
          // the caret a home there — which is exactly what this rung supplies
          // when there is no trailing placeholder to borrow.
          //
          // The block is found by BYTES, not by guessing: the pair whose
          // mdBlock span contains (or ends at) the committed offset, whose PM
          // node is an empty textblock. The caret goes inside it, which is
          // where the marker machinery's next keystroke expects to land.
          if (caretPos === null && nextMap) {
            for (const pair of nextMap.blockPairs || []) {
              const start = pair?.mdBlock?.position?.start?.offset
              const end = pair?.mdBlock?.position?.end?.offset
              if (!Number.isInteger(start) || !Number.isInteger(end)) continue
              if (caretRaw < start || caretRaw > end) continue
              const node = pair.pmNode
              if (!node?.isTextblock || node.content.size !== 0) continue
              if (!Number.isFinite(pair.pmPos)) continue
              caretPos = pair.pmPos + 1
              break
            }
          }
        } catch {
          caretPos = null
        }
        if (caretPos === null) {
          pushKernelDiagnostic({ type: 'caret-unmappable', intent: 'projection-repair', rawOffset: caretRaw })
        }
      }
      try {
        reconcileProjection({
          view,
          newDoc: parsed,
          decorateTransaction: caretPos !== null
            ? (tr) => {
                try {
                  const clamped = Math.max(0, Math.min(caretPos, tr.doc.content.size))
                  tr.setSelection(TextSelection.near(tr.doc.resolve(clamped), 1))
                  if (typeof tr.scrollIntoView === 'function') tr.scrollIntoView()
                } catch {
                  pushKernelDiagnostic({ type: 'caret-restore-failed', rawOffset: caretRaw })
                }
              }
            : null
        })
      } catch {
        pushKernelDiagnostic({ type: 'projection-repair-failed' })
      }
      bindMap(view.state.doc)
    })
  }

  // NATIVE SELF-HEAL AT THE REFUSAL EDGE (2026-08-22). The architecture's own
  // invariant — bytes are the sole authority, every view/map artifact is
  // DERIVABLE from them — means a refusal caused by live-state divergence (a
  // projection producer misbehaving, a session that crossed builds) must not
  // become permanent: the native repair chain (the same safeParse →
  // diffReplaceRange → reconcileProjection → bindMap the verify's repair
  // uses, proven by its own suites) can always re-derive the projection.
  // This runs it SYNCHRONOUSLY (the structural keymap is not mid-dispatch,
  // unlike the verify's microtask context) and reports whether a divergence
  // was actually repaired — the caller retries its route exactly ONCE on
  // `true`. A coherent state returns `false` untouched, so a legitimate
  // fail-closed refusal is never overridden; the only rebuild it performs on
  // an AGREEING view is a missing map (bindMap is idempotent there).
  const repairProjectionNow = (view) => {
    if (!view || disposed) return false
    const parsed = safeParse(kernel.doc.text)
    if (!parsed) return false
    let diff
    try {
      diff = diffReplaceRange(view.state.doc, parsed)
    } catch {
      diff = { unknown: true }
    }
    if (!diff) {
      if (!kernel.map) return !!bindMap(view.state.doc)
      return false
    }
    pushKernelDiagnostic({ type: 'refusal-self-heal', revision: kernel.doc.revision })
    try {
      reconcileProjection({ view, newDoc: parsed })
    } catch {
      pushKernelDiagnostic({ type: 'projection-repair-failed' })
      return false
    }
    return !!bindMap(view.state.doc)
  }

  // ===========================================================================
  // Debounced verify (perf assessment §9 #5, 2026-08-21)
  // ===========================================================================
  // `verifyPlainTextProjection` is POST-HOC repair, not a gate: the PM
  // transaction is already applied when it runs, no fail-closed veto consults
  // it, and its remedy is an async reconcile. Running its full-document parse
  // synchronously on EVERY keystroke was ~1/3 of the whole keystroke route
  // (~113 ms headless / ~350 ms real at 200 KB), so a typing burst now pays
  // for ONE coalesced run after it settles.
  //
  // What must NOT be debounced, and is not:
  //   * the REPAIR path — when the rebind failed (kernel.map null, e.g. the
  //     orphaned split placeholder), verify IS the recovery mechanism and the
  //     next keystroke depends on the map it restores. `requestVerify` runs it
  //     immediately there, exactly as before.
  //   * a FLUSH reader — flushMarkdown / flushMarkdownSettled /
  //     getRecoveryMarkdown force the pending run first (`flushPendingVerify`),
  //     so a save or mode switch never reads past a silently-dropped check.
  // What this deliberately trades (assessment §9 #5's stated cost): a
  // projection mismatch is now undetected for up to one debounce interval
  // instead of one microtask. Every BYTE write in that window is still gated
  // by the gateway/command proofs against the freshly rebuilt map — a
  // diverged view degrades pairs fail-closed — so the window delays a VIEW
  // repair, never a byte decision.
  //
  // The debounced run re-reads the LIVE view doc at fire time (by then
  // updateState has installed the transaction's doc — the `newDoc` argument
  // the synchronous call sites used is stale by design here) and re-arms
  // itself while an IME composition is in flight: reconciling mid-composition
  // would fight the composition session, whose own settle path already
  // reconciles through applyKernelTransaction.
  const VERIFY_DEBOUNCE_MS = 200
  let verifyTimer = null
  const runScheduledVerify = () => {
    verifyTimer = null
    if (inactive()) return
    const view = getView?.()
    if (!view) return
    if (view.composing || compositionSession.isActive()) {
      scheduleVerify()
      return
    }
    // NEVER inside an active split-placeholder session (regression caught
    // live by test-kernel-mode-ui, pinned as Case PERF-3): the placeholder is
    // a view-only paragraph the reparse cannot contain, so a verify landing
    // mid-session reads it as a mismatch and its repair DELETES the block
    // under the parked caret — the next keystroke then types into whatever
    // neighbour the caret collapses into. DROPPED, not deferred: the session
    // opened from a structural op that reconciled the view against a fresh
    // parse (verified-equivalent at session start), and the session-ending
    // commit verifies synchronously (`hadPlaceholders`), so nothing is left
    // unchecked.
    if (splitPlaceholders.length) return
    const caretRaw = pendingVerifyCaret
    pendingVerifyCaret = null
    verifyPlainTextProjection(view.state.doc, caretRaw)
  }
  // The caret anchor of the LATEST commit that scheduled the pending verify.
  // A deferred repair that changes structure must restore the caret to the
  // byte it belongs to (the bare-marker family); consecutive keystrokes
  // overwrite it, which is correct — the newest bytes own the caret.
  let pendingVerifyCaret = null
  const scheduleVerify = (caretRaw = null) => {
    pendingVerifyCaret = caretRaw
    if (verifyTimer) clearTimeout(verifyTimer)
    verifyTimer = setTimeout(runScheduledVerify, VERIFY_DEBOUNCE_MS)
    // Never keep a headless process alive for a pending verify (Node timers
    // hold the event loop; browser timers have no unref and skip this).
    if (typeof verifyTimer?.unref === 'function') verifyTimer.unref()
    perfStats.verifyScheduled += 1
  }
  const flushPendingVerify = () => {
    if (!verifyTimer) return
    clearTimeout(verifyTimer)
    runScheduledVerify()
  }
  const requestVerify = (newDoc, caretRaw = null, caretPmPos = null) => {
    if (!kernel.map) {
      // Rebind failed: verify is the repair path and must run NOW, against
      // the doc the caller is installing (the live view may not carry it yet
      // — handleTransactions runs before updateState).
      if (newDoc) verifyPlainTextProjection(newDoc, caretRaw)
      return
    }
    // SECOND IMMEDIATE CASE (2026-08-26): the map built, but the block the
    // caret is in came back DEGRADED. That is not a perf judgement call — it
    // is the projection saying, from the map it just rebuilt, that it cannot
    // describe the very block this commit wrote into, so `degradedPairAt`
    // (the predicate the refusal itself uses) will refuse the NEXT keystroke
    // with `block-read-only`. Debouncing the repair for 200 ms therefore
    // swallows whatever the user types inside that window.
    //
    // Measured: typing ASCII `**bold**` at ~120 ms/key. Key 7 commits the
    // byte `**bold*`, whose reparse is `*` + <em>bold</em> (5 visible chars)
    // while the view still holds the literal 7 characters — the pair's size
    // proof fails, so the block is degraded — and key 8 arrives before the
    // debounced repair, losing the keystroke. (CJK `与**粗*` never diverges,
    // because CommonMark's rule of 3 keeps it literal; that asymmetry is why
    // the CJK-only fixture never saw this.) `> 200 ms/key` typing passes
    // today purely by outrunning the timer.
    //
    // This is the same class as the `!kernel.map` case above — "verify IS the
    // repair, and the next keystroke depends on it" — narrowed to one block,
    // and it costs a parse ONLY when a divergence is already proven, so the
    // perf assessment §9 #5 healthy path is untouched. It is a repair-TIMING
    // change; verify is post-hoc and gates no byte decision, so it cannot
    // make any commit more permissive.
    //
    // Mid-session it must not run: `runScheduledVerify` DROPS a verify while
    // split placeholders are live (Case PERF-3 — the placeholder is a
    // view-only paragraph the reparse cannot contain, and its repair would
    // delete the block under the parked caret), and running it here instead
    // would be that same regression by another door.
    if (
      Number.isFinite(caretPmPos)
      && !splitPlaceholders.length
      && newDoc
      && degradedPairAt(caretPmPos)
    ) {
      pushKernelDiagnostic({ type: 'verify-immediate-degraded-block', revision: kernel.doc.revision })
      verifyPlainTextProjection(newDoc, caretRaw)
      return
    }
    scheduleVerify(caretRaw)
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
      isComposing: !!view?.composing,
      isPaste: pasteInFlight()
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
        // The batch's own starting caret decides which message the user gets:
        // a refusal INSIDE a degraded block is "this paragraph is read-only"
        // (permanent for this revision, and the primary way a user meets a
        // degraded block — by typing in it); anywhere else it stays the
        // generic "not supported yet". See `notifyRefusal`.
        // `INPUT_TYPE` refusals additionally record the transaction SHAPE the
        // gateway could not classify (editor-kernel-gateway.js
        // `describeUnclassified`). The toast is for the user; this line is for
        // whoever has to find out which PM step Chromium produced — a question
        // that cost the 2026-08-19 write-path pass an entire deferred item.
        if (classified.blockedShape) {
          pushKernelDiagnostic({
            type: 'unclassified-transaction',
            code: classified.blockedCode,
            shape: classified.blockedShape
          })
        }
        notifyRefusal(classified.blockedCode, batchTargetPos(transactions, oldState))
        return { veto: true }
      case 'trailing-append':
        // @milkdown/plugin-trailing's own convenience paragraph (see
        // editor-kernel-gateway.js extractTrailingAppend): view-only, no
        // markdown bytes, no history entry — just rebind the map so the
        // trailing-placeholder tolerance pairs the new node.
        bindMap(newState?.doc || null)
        return undefined
      case 'heading-id':
        // @milkdown/preset-commonmark's syncHeadingIdPlugin refreshing
        // `heading.attrs.id` (see editor-kernel-gateway.js
        // extractHeadingIdSync for the two gates and the byte argument).
        // Same posture as `trailing-append`: pass the transaction through,
        // commit NO bytes, record NO history, advance NO revision — and
        // rebind the map, because every pair holds a `pmNode` reference and
        // the rewritten heading nodes are new objects.
        bindMap(newState?.doc || null)
        return undefined
      case 'clear-document': {
        // Select-all then Delete, or typing over it. Nothing needs pairing: the
        // whole document is replaced, so the candidate bytes ARE the result.
        // PM's own transaction already shows it, so it rides through and only
        // the source is committed here.
        const text = kernel.doc.text
        const next = typeof classified.text === 'string' ? classified.text : ''
        if (typeof text !== 'string' || text === next) return undefined
        // Empty needs no proof. Anything else must reparse to exactly the
        // document ProseMirror is about to show, or the typed characters carry
        // syntax this path cannot spell (a lone `#` would become a heading).
        if (next !== '' && newState?.doc) {
          const parsed = safeParse(next)
          if (!parsed || !parsed.eq(newState.doc)) {
            notifyRefusal(KERNEL_CODES.UNSUPPORTED, batchTargetPos(transactions, oldState))
            return { veto: true }
          }
        }
        const txn = {
          baseRevision: kernel.doc.revision,
          edits: [{ from: 0, to: text.length, insert: next }],
          intent: 'clear-document'
        }
        const cleared = applySourceTransaction(kernel.doc, txn)
        if (!cleared.ok) {
          notifyRefusal(cleared.code, batchTargetPos(transactions, oldState))
          return { veto: true }
        }
        kernel.doc = cleared.doc
        // Its own undo group: one keystroke removed the whole document, and a
        // single Mod-Z must bring all of it back.
        kernel.history.breakGroup()
        recordHistory(cleared, txn)
        kernel.history.breakGroup()
        bindMap(newState?.doc || null)
        onChange?.(kernel.doc.text, false)
        return undefined
      }
      case 'delete-blocks': {
        // See commitBlockDeletion. Same publish shapes as `paste`: tier 1
        // passes ProseMirror's own transaction through, tier 2 vetoes it and
        // republishes from the bytes.
        const committed = commitBlockDeletion({ pmFrom: classified.pmFrom, pmTo: classified.pmTo, expectedDoc: newState?.doc || null })
        if (!committed.ok) {
          pushKernelDiagnostic({ type: 'block-delete-unprovable', code: committed.code, stage: committed.stage })
          notifyRefusal(committed.code, batchTargetPos(transactions, oldState))
          return { veto: true }
        }
        if (!committed.exact) {
          if (!view) return { veto: true }
          applyKernelTransaction(committed.transaction, view)
          return { veto: true }
        }
        kernel.doc = committed.applied.doc
        recordHistory(committed.applied, committed.transaction)
        bindMap(newState?.doc || null)
        requestVerify(newState?.doc, committed.applied?.selection?.anchor, newState?.selection?.head)
        onChange?.(kernel.doc.text, false)
        return undefined
      }
      case 'paste': {
        // See `commitPaste`. Shape (b) like `mark-input-rule`: the bytes are
        // committed and the ORIGINAL transaction is allowed through, because
        // the proof already established that reparsing those bytes yields the
        // document the transaction produced. A refusal vetoes, so a paste the
        // kernel cannot prove leaves both the bytes and the view untouched —
        // the same answer as before this case existed, only now it is the
        // exception rather than every rich paste.
        const committed = commitPaste(oldState, newState)
        if (!committed.ok) {
          pushKernelDiagnostic({ type: 'paste-unprovable', code: committed.code, stage: committed.stage, shape: classified.shape })
          notifyRefusal(committed.code, batchTargetPos(transactions, oldState))
          return { veto: true }
        }
        // TIER 2 (see commitPaste): the bytes hold the content but not the
        // exact slice shape, so the BYTES define the view. Veto the PM
        // transaction and publish through the shared reconcile path instead —
        // the same posture mark-toggle takes, and the reason the user sees the
        // table with the header row Markdown actually gives it.
        if (!committed.exact) {
          if (!view) return { veto: true }
          kernel.history.breakGroup()
          applyKernelTransaction(committed.transaction, view)
          kernel.history.breakGroup()
          return { veto: true }
        }
        kernel.doc = committed.applied.doc
        // Its own undo group: one gesture brought in a whole block of content,
        // and a single Mod-Z must take all of it back out.
        kernel.history.breakGroup()
        recordHistory(committed.applied, committed.transaction)
        kernel.history.breakGroup()
        bindMap(newState?.doc || null)
        // NO raw caret ride for an exact paste (2026-08-30 canary repro): PM
        // already left the caret at the pasted slice's end, and the verify's
        // repair here only removes a placeholder that sits AFTER it — PM's own
        // step mapping preserves the caret exactly. Re-deriving it from the
        // raw anchor through the repair's ladder is what threw it into the
        // NEXT block (the starred item), where the following paste then
        // landed.
        requestVerify(newState?.doc, null, newState?.selection?.head)
        onChange?.(kernel.doc.text, false)
        return undefined
      }
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
          // Block-scoped signal when the refusal is a degraded block (the
          // batch's own starting caret is the position to test) — see
          // `notifyRefusal`.
          notifyRefusal(committed.code, batchTargetPos(transactions, oldState))
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
        //
        // Two commits keep the SYNCHRONOUS verify under the debounce (§9 #5),
        // because for both the view is KNOWN to differ from the bytes and the
        // verify's reconcile is what settles it — neither ever occurs inside
        // an ordinary typing burst:
        //   * `hadPlaceholders` — the session-ending commit: an orphan at the
        //     document end is byte-legally TOLERATED by the rebind as a
        //     trailing placeholder (kernel.map non-null), so the
        //     immediate-repair branch of `requestVerify` alone would not
        //     catch it, yet the cleanup is a pinned session contract
        //     (Case 14). At most once per Enter.
        //   * `committed.rewrote` — the gateway re-spelled the step (a
        //     whitespace heal, the task-seed dissolve, a virtual-block
        //     prefix, the code-fence newline expansion): the view shows the
        //     PM slice while the bytes hold the rewrite, and until the
        //     reconcile runs the block cannot be proven against the view —
        //     debouncing would leave it refusing keystrokes for the whole
        //     interval (Case I5's dissolve pin).
        const hadPlaceholders = splitPlaceholders.length > 0
        // An emptying delete on a root/quote paragraph opens a placeholder
        // session for the surviving empty PM paragraph (the gateway's
        // `emptiedBlock` voucher) — the same session Enter opens, so typing
        // fills it, Enter extends it, and any other commit retires it.
        bindMap(newState?.doc || null, committed.emptiedBlock || null)
        verifyEditObservable(committed.observability)
        // The committed selection anchor rides along so a structure-changing
        // repair reconcile can restore the caret to the byte it belongs to
        // (the bare-marker family) instead of letting the diff throw it into
        // a neighboring block. It must survive the DEBOUNCE too: a healthy
        // identity insert after a bare marker (e.g. a paste the marker input
        // plugin did not claim) restructures on reparse, so the repair that
        // needs this anchor can fire from the timer rather than
        // synchronously — requestVerify threads it through, latest commit
        // wins, exactly the caret the repaired structure belongs to.
        const caretRide = committed.applied?.selection?.anchor
        if ((hadPlaceholders || committed.rewrote) && newState?.doc) {
          verifyPlainTextProjection(newState.doc, caretRide)
        } else {
          requestVerify(newState?.doc, caretRide, newState?.selection?.head)
        }
        onChange?.(kernel.doc.text, false)
        return undefined
      }
      case 'mark-input-rule': {
        // A typed mark-completing delimiter (gateway `extractMarkInputRule`):
        // the PM transaction holds the RULE's result (opening delimiter
        // deleted, mark applied, typed char never inserted), and the byte
        // edit is the literal typed character at the caret's raw offset —
        // the delimiters are the mark's own markdown spelling. Shape (b)
        // like `code-language`: commit the bytes, then allow the original
        // transaction through unchanged — but with a PRE-proof unique to
        // this case: the candidate bytes must REPARSE (editor chain, via
        // safeParse) to a document value-equal to the transaction's own
        // result. That single equality subsumes the per-shape byte proofs —
        // if remark would read the spelling differently (escapes, flanking
        // rules, an adjacent construct), the parse diverges and the
        // keystroke is refused with bytes AND view untouched: a swallowed
        // keystroke, never a wrong byte, exactly as before this case
        // existed — only now named instead of `unclassified-transaction`.
        const committed = commitMarkInputRule({
          kernel,
          map: kernel.map,
          pmFrom: classified.pmFrom,
          text: classified.text
        })
        if (!committed.ok) {
          notifyRefusal(committed.code, classified.pmFrom)
          return { veto: true }
        }
        const parsed = safeParse(committed.applied.doc.text)
        if (!parsed || !newState?.doc || !parsed.eq(newState.doc)) {
          // LITERAL FALLBACK — source-authoritative to the end. The typed
          // byte STILL lands (its insert was already proven by the plain-text
          // pipeline); only the RULE's marked result is vetoed, and the view
          // is reconciled from the parse of the committed bytes — the shared
          // `applyKernelTransaction` publish path, same as mark-toggle. The
          // user keeps their character with whatever the parse says it means,
          // never the unprovable mark. This is what makes `~~删~~` typable:
          // milkdown's eager `~{1,2}` strike rule fires on the FIRST closing
          // `~` with a spelling GFM reads differently (`~~删~` — mismatched
          // runs, literal); the fallback lands that `~` as text, and the
          // SECOND `~` completes the real strike through the parse itself.
          pushKernelDiagnostic({
            type: 'mark-input-rule-literal-fallback',
            text: classified.text
          })
          if (!view) return { veto: true }
          applyKernelTransaction(committed.transaction, view, { requireMap: true })
          return { veto: true }
        }
        kernel.doc = committed.applied.doc
        recordHistory(committed.applied, committed.transaction)
        // The parse WAS just proven value-equal to the view doc the allowed
        // transaction produces, so the ordinary rebind + debounced verify
        // suffice (nothing is known to differ — the §9 #5 healthy path).
        bindMap(newState.doc)
        requestVerify(newState.doc, committed.applied?.selection?.anchor, newState.selection?.head)
        onChange?.(kernel.doc.text, false)
        return undefined
      }
      case 'mark-toggle': {
        // Toolbar/keymap/context-menu mark toggle (Plan 4 Task 3): the
        // original PM AddMarkStep/RemoveMarkStep transaction is ALWAYS
        // vetoed — on success because the kernel's own reconcile (below,
        // via applyKernelTransaction) reparses the committed marker bytes
        // into the REAL mark, and on failure because nothing may change.
        // Routing through the reparse (instead of letting the PM mark
        // transaction through like task-toggle does) is what makes the
        // projection authoritative: whatever CommonMark actually does with
        // the inserted markers — including Task 2's deferred
        // highlight-overlap shapes — is exactly what the view shows.
        if (!view) return { veto: true }
        const pair = editablePairForRange(classified.pmFrom, classified.pmTo)
        if (!pair) {
          notifyRefusal(KERNEL_CODES.UNMAPPED, classified.pmFrom)
          return { veto: true }
        }
        const contentPos = pair.pmPos + 1
        const routed = toggleInlineMark({
          doc: kernel.doc,
          index: buildSyntaxIndex(kernel.doc.text),
          map: pair.charMap,
          visFrom: classified.pmFrom - contentPos,
          visTo: classified.pmTo - contentPos,
          kind: classified.markKind
        })
        if (!routed.ok) {
          notifyBlocked(routed.code)
          return { veto: true }
        }
        // `requireMap` refuses (pre-commit, everything untouched) any toggle
        // whose RESULT document cannot rebuild a projection map, or whose own
        // anchor no longer resolves through it. No mark KIND is categorically
        // refused any more (inlineCode was healed by P4-3.5's per-char units,
        // highlight by P5-3's positioned `==` nodes), but the guard is very
        // much live per CONTENT: highlighting a bare URL still hits it,
        // because the result `see ==www.a.com== ok` cannot be
        // character-mapped at all (remark's autolink-literal fallback leaves
        // the paragraph's phrasing positionless). Pinned as Case M4c in
        // scripts/test-kernel-mode-headless.mjs.
        // applyKernelTransaction notifies on every failure path itself.
        applyKernelTransaction(routed.transaction, view, { requireMap: true })
        return { veto: true }
      }
      case 'link-edit': {
        // The LinkTooltip's own commit (Plan 5 Task 6). Same posture as
        // `mark-toggle` right above and for the same reason: the PM
        // transaction is ALWAYS vetoed, because what the view must end up
        // showing is whatever CommonMark makes of the committed
        // `[text](url)` BYTES — an escaped label, a destination that had to
        // take the `<...>` form, a title the rewrite deliberately left in
        // place. Letting the tooltip's own mark transaction through would
        // paint a link the source may not spell that way.
        //
        // `requireMap: true` is what refuses (pre-commit, everything
        // untouched) any link edit whose RESULT document cannot rebuild a
        // projection map or whose own anchor no longer resolves through it.
        // `applyLinkEdit` has already proven the bytes reparse to the
        // intended document; this is the projection-side half.
        if (!view) return { veto: true }
        const pair = editablePairForRange(classified.pmFrom, classified.pmTo)
        if (!pair) {
          notifyRefusal(KERNEL_CODES.UNMAPPED, classified.pmFrom)
          return { veto: true }
        }
        const routed = routeLinkEdit({
          kernel,
          index: buildSyntaxIndex(kernel.doc.text),
          pair,
          op: classified.op,
          pmFrom: classified.pmFrom,
          pmTo: classified.pmTo,
          href: classified.href,
          insertedText: classified.insertedText
        })
        if (!routed.ok) {
          notifyBlocked(routed.code)
          return { veto: true }
        }
        applyKernelTransaction(routed.transaction, view, { requireMap: true })
        return { veto: true }
      }
      case 'trailing-atom-typing': {
        // Typing while the document's trailing leaf atom (hr / image-block)
        // is node-selected — the state a click on/near an atom-ending
        // document's tail leaves behind: `Selection.near` has no textblock to
        // land in, so the placeholder plugin-trailing just appended never
        // received the caret, and prosemirror-view's own keypress fallback
        // then dispatches insertText over the NodeSelection, which REPLACES
        // the atom (see extractTrailingAtomTyping in
        // editor-kernel-gateway.js for the measured trace). Same posture as
        // `mark-toggle`/`link-edit` above: the PM transaction is ALWAYS
        // vetoed — it deleted the atom, bytes the user never asked for — and
        // the kernel instead commits exactly what typing INSIDE the
        // placeholder commits (the virtual pair's own anchor + separator
        // prefix, resolved through the same `virtualBlockAt` channel), then
        // reconciles the view from the committed source: atom intact, the
        // typed text a new paragraph below it, caret after the text.
        if (!view) return { veto: true }
        const routed = routeTrailingAtomTyping({ kernel, map: kernel.map, transactions, oldState })
        if (!routed.ok) {
          notifyRefusal(routed.code, batchTargetPos(transactions, oldState))
          return { veto: true }
        }
        // `requireMap: true` refuses (pre-commit, everything untouched) a
        // commit whose RESULT document cannot rebuild a projection map or
        // whose caret raw offset no longer resolves through it.
        applyKernelTransaction(routed.transaction, view, { requireMap: true })
        return { veto: true }
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
        requestVerify(newState?.doc)
        onChange?.(kernel.doc.text, false)
        return undefined
      }
      case 'image-attrs': {
        // Image attribute edit (Plan 5 Task 5), the third AttrStep route
        // after `code-language` and `task-toggle` and shaped identically to
        // the first: the attribute has ALREADY flipped on the live PM doc by
        // the time classification runs, so once `commitImageAttrs` proves the
        // matching byte rewrite of `![alt](src "title")` the original
        // transaction is allowed through unchanged (`return undefined`)
        // rather than vetoed-and-reconciled.
        //
        // The rebind is unconditional, like `code-language`: the rewrite
        // changes the byte length of a block that sits BEFORE every later
        // block, so every raw offset the map serves past this image is stale
        // until it is rebuilt.
        //
        // Refusal is loud and total: a SCALED image's `caption` never
        // reaches here (the gateway leaves it `blocked` with its named code
        // — see extractImageDisplayRefusal), and anything
        // `setImageAttrs` cannot prove byte-for-byte vetoes the PM
        // transaction too — including the caption's own named refusals
        // (`image-caption-scaled` re-derived at commit,
        // `empty-image-caption-unrepresentable` for the shadowed clear) — so
        // the view never shows an attribute the source does not carry.
        // An UNSCALED image-block's `caption` classifies since
        // kernel/image-caption and commits into the markdown TITLE slot (the
        // legacy byte home; commands/image-attrs.js CAPTION ADR): after the
        // commit the view's caption and the projection's `title || alt`
        // agree, so the pass-through costs no projection mismatch.
        // `ratio` routes here too since 2026-08-30 (`setImageRatio`, the
        // legacy multi-slot rewrite: numeric alt + caption-in-title). The
        // pass-through view may briefly hold the raw drag ratio (1.437)
        // against the persisted 2-decimal bytes (1.44); the debounced verify
        // snaps the view to the byte truth. A CAPTIONLESS resize refuses
        // named `image-resize-unsupported` — `![1.50](url)` without a title
        // reparses as an unscaled image captioned "1.50", so the legacy
        // format itself cannot hold it (legacy loses such a resize silently;
        // the kernel refuses instead).
        const committed = commitImageAttrs({
          kernel,
          index: buildSyntaxIndex(kernel.doc.text),
          map: kernel.map,
          pmPos: classified.pmPos,
          blockImage: classified.blockImage,
          attr: classified.attr,
          value: classified.value
        })
        if (!committed.ok) {
          notifyBlocked(committed.code)
          return { veto: true }
        }
        kernel.doc = committed.applied.doc
        recordHistory(committed.applied, committed.transaction)
        bindMap(newState?.doc || null)
        requestVerify(newState?.doc)
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
  // `written` (optional {from,to}): the RAW span the placeholder-opening
  // command itself inserted. Recording it lets Backspace in the placeholder
  // invert that command byte-for-byte (shrinkSplitPlaceholder); vouchers
  // without a span (an emptied paragraph, an exit anchor on a pre-existing
  // line) take shrinkBlankRun's one-line fallback instead.
  const materializePlaceholder = (view, insertPos, rawOffset, insertPrefix = '', written = null) => {
    try {
      const paragraph = view.state.schema?.nodes?.paragraph?.createAndFill?.()
      if (!paragraph) return false
      const tr = view.state.tr.insert(insertPos, paragraph)
      tr.setSelection(TextSelection.create(tr.doc, insertPos + 1))
      tr.setMeta('sourceProjection', true)
      tr.setMeta('addToHistory', false)
      if (typeof tr.scrollIntoView === 'function') tr.scrollIntoView()
      view.dispatch(tr)
      const voucher = written
        ? { pmPos: insertPos, rawOffset, insertPrefix, writtenFrom: written.from, writtenTo: written.to }
        : { pmPos: insertPos, rawOffset, insertPrefix }
      if (bindMap(view.state.doc, voucher)) return true
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

  // Which TOP-LEVEL child of the document holds `pos`? Used by the
  // mid-document `/text` route to name the placeholder's home by index
  // (see runInsertBlockFromQuery). A position that is not inside any child
  // (depth 0 — between two top-level nodes) answers null rather than the
  // index PM would round it to: the caller needs "the block this caret is
  // IN", and a rounded answer would silently place the placeholder next door.
  const topLevelIndexAt = (docNode, pos) => {
    try {
      const $pos = docNode.resolve(Math.max(0, Math.min(pos, docNode.content.size)))
      return $pos.depth === 0 ? null : $pos.index(0)
    } catch {
      return null
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
      // The split txn is insert-only; when the caret anchor rides the END of
      // that insert (the degenerate "Enter at block end" shape), record the
      // span so Backspace can take exactly these bytes back.
      const insertEnd = Number.isFinite(txn.from) && typeof txn.insert === 'string'
        ? txn.from + txn.insert.length
        : NaN
      const written = txn.from === txn.to && insertEnd === rawOffset
        ? { from: txn.from, to: insertEnd }
        : null
      materializePlaceholder(view, $pos.after(depth), rawOffset, '', written)
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
      // The whole-empty quote's silent no-op: consume the key, no toast.
      if (routed.code === KERNEL_CODES.SILENT_NO_OP) return true
      notifyBlocked(routed.code)
      return false
    }
    // The router now answers an EMPTY QUOTE LINE with the quote exit
    // (commands/enter.js `exitEmptyQuoteLine`), and that is the right answer
    // here too: a vouched placeholder sitting on `> ` is the second Enter of
    // 「引用里连按两次回车」. Extending would add ANOTHER empty quoted line;
    // what the user is doing is leaving. The exit is an ordinary commit and
    // ends the session through the ordinary publish path — this branch must
    // not ALSO run its own view insert (measured: doing both produced
    // `projection-mismatch` + `unmapped-selection` and swallowed the typing).
    if (routed.transaction?.intent === 'exit-empty-quote-line') {
      if (applyKernelTransaction(routed.transaction, view)) {
        placeholderForUnmappableAnchor(view, routed.transaction.selection?.anchor, { outsideQuote: true })
      }
      return true
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
      const nextChain = [...splitPlaceholders, {
        pmPos: insertPos,
        rawOffset: newRawOffset,
        writtenFrom: routed.transaction.from,
        writtenTo: routed.transaction.from + routed.transaction.insert.length
      }]
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

  // Backspace/Delete INSIDE the last vouched split placeholder (2026-08-23
  // user report: the key fell through to PM's joinBackward, whose
  // cross-parent ReplaceStep the gateway can only refuse —
  // `unsupported-input-type` on a gesture whose meaning is obvious). The
  // inverse of extendTrailingPlaceholder, same session discipline: pop the
  // LAST chain entry, delete the bytes its Enter wrote (`writtenFrom/To`,
  // recorded at voucher time — a byte-exact restore), or one line off the
  // blank run for span-less vouchers (emptied paragraph / exit anchors);
  // shrinkBlankRun's reparse proof arbitrates either way. The placeholder
  // node leaves the view in the same breath and the caret lands where the
  // chain says it belongs: the previous placeholder, or — chain empty,
  // session over — the end of the previous real block (Delete: the start of
  // the next). Every failure path is a NAMED refusal with all state rolled
  // back together; the key never falls through to PM.
  const shrinkSplitPlaceholder = (view, key) => {
    const last = splitPlaceholders[splitPlaceholders.length - 1]
    if (!last) return false
    const span = Number.isFinite(last.writtenFrom) && Number.isFinite(last.writtenTo)
      ? { from: last.writtenFrom, to: last.writtenTo }
      : null
    const routed = shrinkBlankRun({
      doc: kernel.doc,
      index: buildSyntaxIndex(kernel.doc.text),
      offset: last.rawOffset,
      span
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
    const previousDoc = kernel.doc
    const previousChain = splitPlaceholders
    let advanced = false
    try {
      const docNode = view.state.doc
      const lastNode = docNode.nodeAt(last.pmPos)
      if (!lastNode || !lastNode.isTextblock || lastNode.content.size !== 0) {
        notifyBlocked(KERNEL_CODES.UNSUPPORTED)
        return false
      }
      kernel.doc = result.doc
      advanced = true
      const remaining = previousChain.slice(0, -1)
      const tr = view.state.tr.delete(last.pmPos, last.pmPos + lastNode.nodeSize)
      const landing = remaining.length
        ? TextSelection.create(tr.doc, remaining[remaining.length - 1].pmPos + 1)
        : TextSelection.near(tr.doc.resolve(Math.min(last.pmPos, tr.doc.content.size)), key === 'Delete' ? 1 : -1)
      tr.setSelection(landing)
      tr.setMeta('sourceProjection', true)
      tr.setMeta('addToHistory', false)
      if (typeof tr.scrollIntoView === 'function') tr.scrollIntoView()
      view.dispatch(tr)
      if (bindMap(view.state.doc, remaining.length ? remaining : null)) {
        recordHistory(result, routed.transaction)
        onChange?.(kernel.doc.text, false)
        return true
      }
      // Could not prove the shortened chain: roll the kernel doc AND the view
      // back together, restore the full chain's vouched map.
      pushKernelDiagnostic({ type: 'split-placeholder-unprovable', rawOffset: last.rawOffset })
      kernel.doc = previousDoc
      advanced = false
      const undoTr = view.state.tr.insert(last.pmPos, lastNode)
      undoTr.setMeta('sourceProjection', true)
      undoTr.setMeta('addToHistory', false)
      view.dispatch(undoTr)
      if (!bindMap(view.state.doc, previousChain)) bindMap(view.state.doc)
      notifyBlocked(KERNEL_CODES.PROJECTION)
      return false
    } catch {
      if (advanced) kernel.doc = previousDoc
      pushKernelDiagnostic({ type: 'split-placeholder-failed', rawOffset: last.rawOffset })
      notifyBlocked(KERNEL_CODES.PROJECTION)
      return false
    }
  }

  // Apply one kernel transaction to the doc AND project it into the view:
  // parse-first so a projection failure refuses the whole key with every
  // state (kernel doc, history, PM view) untouched.
  //
  // `requireMap` (Plan 4 Task 3): refuse the WHOLE transaction — before any
  // kernel/history/view mutation — unless the post-transaction document
  // provably rebuilds a projection map AND that map can still resolve the
  // position this transaction acts on. The mark-toggle route demands this
  // because a byte-successful toggle can produce a document the projection
  // layer cannot pair; without the guard such a toggle would COMMIT,
  // reconcile, then leave a byte-correct but unmappable target where every
  // subsequent edit vetoes with UNMAPPED (a lock-up trap). Refusing up front
  // keeps the toggle fail-closed: bytes, history and view all stay exactly as
  // they were.
  //
  // The two MARK KINDS that used to trip it unconditionally are both healed —
  // inline code by P4-3.5's per-char units, and highlight by P5-3, which
  // taught the kernel chain the `==` rule the editor uses
  // (lib/source-kernel/highlight-syntax.js) — but the guard is not vestigial:
  // it still refuses per CONTENT. The live example is highlighting a bare URL
  // (`see www.a.com ok`): the wrap is byte-legal, yet the result paragraph
  // cannot be character-mapped (remark's gfm autolink-literal fallback
  // rebuilds the phrasing WITHOUT positions), so the anchor half below
  // refuses and nothing is written. Case M4c in
  // scripts/test-kernel-mode-headless.mjs is that pin; without the guard the
  // toggle would commit into a paragraph the user could no longer type in.
  //
  // ==========================================================================
  // PASTE (2026-08-28)
  // ==========================================================================
  // A paste is the one gesture whose content arrives with NO bytes of its own:
  // the clipboard holds HTML or text, ProseMirror turns it into a slice, and
  // there is nothing in `kernel.doc` for the kernel to map it back to. Every
  // other domain refuses when it cannot find existing bytes; refusing here
  // meant refusing PASTE ITSELF — measured 2026-08-28, kernel default-on: a
  // multi-paragraph, Markdown or rich-HTML paste wrote nothing at all.
  //
  // The shape of the answer, and why it does not break byte authority:
  //   * ProseMirror keeps its own transaction. The view it produces IS what
  //     the user asked for, and it is the EXPECTATION the bytes must match —
  //     the same posture `mark-input-rule` takes (commit, reparse, `.eq`).
  //   * only the TOP-LEVEL BLOCKS the paste touched are re-spelled, from the
  //     editor's own serializer. Untouched blocks keep their authored bytes
  //     byte for byte; the pasted content has no earlier spelling to keep.
  //   * the proof is the whole document: the committed bytes are reparsed and
  //     must be durably equivalent to the transaction's own document. Anything
  //     the serializer spells in a way remark reads differently — and anything
  //     this range arithmetic gets wrong — fails that equality and the paste
  //     is refused with bytes AND view untouched.
  // The blocks the touched PM range covers, widened to whole top-level
  // children (a paste that lands mid-paragraph edits that paragraph's bytes,
  // so its whole block is the unit that gets re-spelled).
  const topLevelSpanCovering = (docNode, from, to) => {
    if (!docNode) return null
    let pos = 0
    let firstIndex = -1
    let lastIndex = -1
    let pmFrom = 0
    let pmTo = 0
    for (let i = 0; i < docNode.childCount; i += 1) {
      const size = docNode.child(i).nodeSize
      const start = pos
      const end = pos + size
      // STRICT interior overlap (2026-08-30 branch review + the canary the
      // strengthened paste suite caught the same day): "touching counts" was
      // NOT the safe direction. A paste whose diff merely TOUCHED the next
      // block's boundary pulled that untouched neighbour into the re-spell —
      // measured: an authored \`* 星号项\` list adjacent to the paste point
      // lost its blank-line separation on one paste, then received the
      // following pastes' content, ending as a marker-less \`  星号项\`
      // continuation line. Only a block the diff actually enters is touched;
      // the pure between-blocks insertion falls back to the touching rule
      // below, where there is no neighbour content to damage.
      if (end > from && start < to) {
        if (firstIndex < 0) {
          firstIndex = i
          pmFrom = start
        }
        lastIndex = i
        pmTo = end
      }
      pos = end
    }
    // No interior overlap = a COLLAPSED diff exactly on a block seam: the
    // paste is a pure INSERTION between blocks, and the caller must treat the
    // old side as an insertion POINT (emptyTargetSpan), never widen it onto
    // the neighbours — widening is exactly what ate `第二段` and the starred
    // list in the canary repro (2026-08-30).
    return firstIndex < 0 ? null : { firstIndex, lastIndex, pmFrom, pmTo }
  }

  // The raw byte span those blocks occupy, read from the projection map's own
  // pairs. Derived, never guessed: a top-level list is not itself a pair, so
  // the span is the union over every pair whose PM position falls inside.
  const rawSpanForPmRange = (pmFrom, pmTo) => {
    const pairs = Array.isArray(kernel.map?.blockPairs) ? kernel.map.blockPairs : []
    let from = null
    let to = null
    for (const pair of pairs) {
      if (!Number.isFinite(pair?.pmPos) || pair.pmPos < pmFrom || pair.pmPos >= pmTo) continue
      const start = pair.mdBlock?.position?.start?.offset
      const end = pair.mdBlock?.position?.end?.offset
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        // A VIRTUAL pair is a node the view owns and the source does not (the
        // empty paragraph a paste lands in, the trailing placeholder): it has
        // no bytes to contribute, and it is the ordinary companion of the
        // block the paste really targets. Any OTHER pair without positions is
        // a real block whose bytes we cannot name — that one still refuses.
        if (pair.virtual || !pair.mdBlock) continue
        return null
      }
      from = from === null ? start : Math.min(from, start)
      to = to === null ? end : Math.max(to, end)
    }
    return from === null ? null : { from, to }
  }

  // ==========================================================================
  // WHOLE-BLOCK DELETION (2026-08-28)
  // ==========================================================================
  // "Select the divider / image / table and press Backspace." The gateway
  // proved the STEP removes complete top-level children (extractBlockDeletion);
  // what is left is naming their bytes and proving the removal reads the same.
  //
  // Their bytes are nameable even though none of them is a textblock: the
  // projection map pairs `hr` with `thematicBreak` and Crepe's `image-block`
  // with its own mdast node, so `mdBlock.position` is right there — the pairs
  // simply carry no charMap, which is a statement about TYPING inside them,
  // not about their span. A block whose bytes cannot be named still refuses.
  const commitBlockDeletion = ({ pmFrom, pmTo, expectedDoc = null }) => {
    if (!kernel.map) return { ok: false, code: KERNEL_CODES.UNMAPPED }
    const raw = rawSpanForPmRange(pmFrom, pmTo)
    if (!raw) return { ok: false, code: KERNEL_CODES.UNSUPPORTED, stage: 'no-raw' }
    const text = kernel.doc.text
    // Take the block separator with the block: a deletion that leaves the
    // blank line behind turns one gesture into two (delete, then delete the
    // gap). The run after the span is taken first; at the document end there
    // is none, so the run BEFORE it is taken instead — otherwise the file
    // keeps a trailing blank run nobody asked for.
    let from = raw.from
    let to = raw.to
    const afterRun = text.slice(to).match(/^(?:\r\n|\r|\n){1,2}/)
    const beforeRun = text.slice(0, from).match(/(?:\r\n|\r|\n){1,2}$/)
    // Absorb the after-run only when real content FOLLOWS it: for the file's
    // LAST block the after-run is the file's own final newline, and taking it
    // left a trailing blank run behind (2026-08-30 review: deleting the hr in
    // `甲\n\n---\n` produced `甲\n\n`). At the end, take the run BEFORE the
    // block instead, so the file closes with its ordinary single newline.
    if (afterRun && to + afterRun[0].length < text.length) {
      to += afterRun[0].length
    } else if (beforeRun) {
      from -= beforeRun[0].length
    } else if (afterRun) {
      to += afterRun[0].length
    }
    const transaction = {
      baseRevision: kernel.doc.revision,
      from,
      to,
      insert: '',
      intent: 'delete-blocks',
      selection: { anchor: from, head: from }
    }
    const applied = applySourceTransaction(kernel.doc, transaction)
    if (!applied.ok) return { ok: false, code: applied.code, stage: 'apply-failed' }
    const parsed = safeParse(applied.doc.text)
    if (!parsed) return { ok: false, code: KERNEL_CODES.PROJECTION, stage: 'parse-failed' }
    // The same two-tier judgment the paste route uses, for the same reason:
    // tier 1 lets ProseMirror keep its own transaction, tier 2 rebuilds the
    // view from the bytes when the reparse legitimately differs (deleting a
    // block can leave the trailing placeholder in a different place than PM
    // put it). Tier 2's gate is the neighbour proof: nothing OUTSIDE the
    // deleted span may change meaning.
    if (expectedDoc && (parsed.eq(expectedDoc) || areDurablyEquivalent(parsed, expectedDoc))) {
      return { ok: true, applied, transaction, exact: true }
    }
    // The seam signature, not `outsideSignature`: a pure deletion leaves the
    // candidate's region DEGENERATE ([from, from)), and the shared helper's
    // `start <= regionStart` boundary then declines to shift a node that
    // starts exactly at the cut — the block right after a deleted table reads
    // as "moved" and every deletion refuses (measured on an empty table).
    // Stated directly instead: every node is entirely before the cut or
    // entirely after it (a straddling node means the deletion reached into a
    // block), and the after-side offsets are compared with the cut removed.
    const seamSignature = (tree, cutFrom, cutTo) => {
      const rows = []
      let ok = true
      const shift = cutTo - cutFrom
      const walk = (node) => {
        if (!ok) return
        const nodeStart = node.position?.start?.offset
        const nodeEnd = node.position?.end?.offset
        if (!Number.isInteger(nodeStart) || !Number.isInteger(nodeEnd)) { ok = false; return }
        if (nodeEnd <= cutFrom) rows.push(`${node.type}:${nodeStart}:${nodeEnd}`)
        else if (nodeStart >= cutTo) rows.push(`${node.type}:${nodeStart - shift}:${nodeEnd - shift}`)
        // Entirely INSIDE the cut: this is the block being deleted (and its
        // children). It contributes nothing to either side.
        else if (nodeStart >= cutFrom && nodeEnd <= cutTo) return
        // Anything else genuinely straddles the cut, which means the deletion
        // reached into a block it was not supposed to touch.
        else { ok = false; return }
        for (const child of node.children || []) walk(child)
      }
      for (const child of tree.children || []) walk(child)
      return ok ? rows.join('\n') : null
    }
    let before = null
    let afterSig = null
    try {
      before = seamSignature(parseKernelMarkdown(text), from, to)
      afterSig = seamSignature(parseKernelMarkdown(applied.doc.text), from, from)
    } catch {
      return { ok: false, code: KERNEL_CODES.UNSUPPORTED, stage: 'outside-parse-failed' }
    }
    if (before === null || before !== afterSig) {
      return { ok: false, code: KERNEL_CODES.UNSUPPORTED, stage: 'outside-mismatch' }
    }
    return { ok: true, applied, transaction, exact: false }
  }

  // Where a paste goes when its target block owns no bytes. Two shapes, both
  // measured: an EMPTY DOCUMENT (whose whole text is whitespace — replace it,
  // so the paste does not inherit a stray blank line) and a placeholder AFTER
  // real content (append past the last block that does have bytes, separated
  // by one blank line). `separator` is prepended to the serialized markdown.
  const emptyTargetSpan = (oldSpan) => {
    const text = kernel.doc.text
    if (!text.trim()) return { from: 0, to: text.length, separator: '' }
    const pairs = Array.isArray(kernel.map?.blockPairs) ? kernel.map.blockPairs : []
    let end = null
    for (const pair of pairs) {
      if (!Number.isFinite(pair?.pmPos) || pair.pmPos >= oldSpan.pmFrom) continue
      const candidate = pair.mdBlock?.position?.end?.offset
      if (!Number.isInteger(candidate)) continue
      end = end === null ? candidate : Math.max(end, candidate)
    }
    if (end === null) return null
    return { from: end, to: end, separator: 'blank-line' }
  }

  const commitPaste = (oldState, newState) => {
    if (!kernel.map) return { ok: false, code: KERNEL_CODES.UNMAPPED, stage: 'unmapped' }
    if (typeof serializeDoc !== 'function') return { ok: false, code: KERNEL_CODES.UNSUPPORTED, stage: 'no-serializer' }
    const oldDoc = oldState?.doc
    const newDoc = newState?.doc
    if (!oldDoc || !newDoc) return { ok: false, code: KERNEL_CODES.INPUT_TYPE, stage: 'no-docs' }
    const diff = diffReplaceRange(oldDoc, newDoc)
    if (!diff) return { ok: false, code: KERNEL_CODES.INPUT_TYPE, stage: 'no-diff' }
    const oldSpan = topLevelSpanCovering(oldDoc, diff.from, diff.to)
    const newSpan = topLevelSpanCovering(newDoc, diff.insertFrom, diff.insertTo)
    // A pure between-blocks insertion has NO old span (the diff is collapsed
    // on a seam): the old side is an insertion point, served by the same
    // derivation the empty-document/trailing cases use. Anything else without
    // both spans stays a refusal.
    const pureInsertion = !oldSpan && diff.from === diff.to && newSpan
    // A pure DELETION mirrors it on the other side: the new diff is collapsed,
    // so the merged remainder is the block whose INTERIOR holds the collapse
    // point (a mid-to-mid selection merges the halves into one block). A
    // collapse point sitting ON a boundary means whole blocks were removed
    // cleanly and nothing merged — the span serializes to nothing, which the
    // deletion-empty allowance below accepts.
    let effectiveNewSpan = newSpan
    if (oldSpan && !newSpan && diff.insertFrom === diff.insertTo) {
      let pos = 0
      for (let i = 0; i < newDoc.childCount; i += 1) {
        const size = newDoc.child(i).nodeSize
        if (pos < diff.insertFrom && diff.insertFrom < pos + size) {
          effectiveNewSpan = { firstIndex: i, lastIndex: i, pmFrom: pos, pmTo: pos + size }
          break
        }
        pos += size
      }
      if (!effectiveNewSpan) effectiveNewSpan = { firstIndex: 0, lastIndex: -1, pmFrom: diff.insertFrom, pmTo: diff.insertFrom }
    }
    if ((!oldSpan && !pureInsertion) || !effectiveNewSpan) return { ok: false, code: KERNEL_CODES.UNSUPPORTED, stage: 'no-span' }
    // No pairs in range means the paste landed where the document has no bytes
    // at all: an empty document, or the view's trailing placeholder. Both are
    // ordinary places to paste into — an empty document is the FIRST one —
    // so they get a derived insertion point rather than a refusal. The
    // derivation is allowed to be a guess precisely because the reparse
    // equality below judges it: a wrong offset cannot produce the document
    // the transaction produced.
    const raw = pureInsertion
      ? emptyTargetSpan({ pmFrom: diff.from })
      : (rawSpanForPmRange(oldSpan.pmFrom, oldSpan.pmTo) || emptyTargetSpan(oldSpan))
    if (!raw) return { ok: false, code: KERNEL_CODES.UNSUPPORTED, stage: 'no-raw' }
    let markdown
    // An EMPTY effective span (clean whole-block deletion, nothing merged)
    // serializes to nothing — creating a doc node from an empty fragment
    // throws, and refusing here was the select-to-the-end gesture's failure.
    if (effectiveNewSpan.lastIndex < effectiveNewSpan.firstIndex) {
      markdown = ''
    } else try {
      const children = []
      // The view's trailing placeholder (withTrailingParagraph / Crepe's
      // plugin-trailing) has no markdown bytes and must not gain any: it
      // serializes to `<br />`, which the durable oracle correctly treats as
      // a non-content placeholder — so the equality proof would PASS while
      // the artifact sat in the file (measured before this trim).
      let last = effectiveNewSpan.lastIndex
      while (last > effectiveNewSpan.firstIndex && last === newDoc.childCount - 1 &&
             newDoc.child(last).type?.name === 'paragraph' && newDoc.child(last).content.size === 0) {
        last -= 1
      }
      for (let i = effectiveNewSpan.firstIndex; i <= last; i += 1) children.push(newDoc.child(i))
      markdown = serializeDoc(newDoc.type.create(null, Fragment.fromArray(children)))
    } catch {
      return { ok: false, code: KERNEL_CODES.UNSUPPORTED, stage: 'serialize-failed' }
    }
    if (typeof markdown !== 'string') return { ok: false, code: KERNEL_CODES.UNSUPPORTED, stage: 'empty-markdown' }
    // An EMPTY serialization is an error for an insertion but the CORRECT
    // spelling for a deletion whose selection covered the span's whole
    // content (2026-08-30, the select-across-the-table gesture): the touched
    // blocks merge to one empty paragraph, whose bytes are nothing. The
    // two-tier proof below still judges the result.
    if (!markdown.trim() && diff.to <= diff.from) {
      return { ok: false, code: KERNEL_CODES.UNSUPPORTED, stage: 'empty-markdown' }
    }
    // A deletion that serializes to NOTHING takes one block separator with it
    // (the same absorption commitBlockDeletion does), so removed blocks do
    // not leave a stranded blank run behind.
    if (!markdown && raw.to > raw.from) {
      const text0 = kernel.doc.text
      const afterRun = text0.slice(raw.to).match(/^(?:\r\n|\r|\n){1,2}/)
      const beforeRun = text0.slice(0, raw.from).match(/(?:\r\n|\r|\n){1,2}$/)
      if (afterRun && raw.to + afterRun[0].length < text0.length) raw.to += afterRun[0].length
      else if (beforeRun) raw.from -= beforeRun[0].length
      else if (afterRun) raw.to += afterRun[0].length
    }
    // The serializer always answers LF and a trailing newline; the span it
    // replaces is the block's own bytes, which carry neither.
    const ending = kernel.doc.text.includes('\r\n') ? '\r\n' : '\n'
    const body = markdown.replace(/\r\n?/g, '\n').replace(/\n+$/, '').replace(/\n/g, ending)
    const insert = (raw.separator === 'blank-line' ? ending + ending : '') + body
    const transaction = {
      baseRevision: kernel.doc.revision,
      from: raw.from,
      to: raw.to,
      insert,
      intent: 'paste',
      selection: { anchor: raw.from + insert.length, head: raw.from + insert.length }
    }
    const applied = applySourceTransaction(kernel.doc, transaction)
    if (!applied.ok) return { ok: false, code: applied.code, stage: 'apply-failed' }
    const parsed = safeParse(applied.doc.text)
    if (!parsed) return { ok: false, code: KERNEL_CODES.PROJECTION, stage: 'parse-failed' }
    // TIER 1 — the bytes reproduce the view ProseMirror just built. `.eq`
    // first (the mark-input-rule bar), then the durable oracle the
    // source-verification gate uses (a pasted heading's `id` attribute and
    // the serializer's own spelling choices are not content). The PM
    // transaction is then allowed through untouched: no reconcile, no churn.
    if (parsed.eq(newDoc) || areDurablyEquivalent(parsed, newDoc)) {
      return { ok: true, applied, transaction, exact: true }
    }
    // TIER 2 — Markdown can hold the content, but not in the exact shape the
    // clipboard had. Measured: an HTML table with no header row (GFM requires
    // one, so the reparse promotes the first row) and a list whose spacing the
    // serializer normalises. Tier 1 alone refused those pastes outright, which
    // is the wrong trade: the file CAN hold this content, and in a
    // source-authoritative editor what the bytes say is what the user must
    // see. So commit the bytes and let the view be rebuilt from them (the
    // caller reconciles) — the user sees the pasted content in the shape the
    // file will really have, immediately, instead of losing the paste.
    //
    // What still has to be proven is that the paste stayed in its own span:
    // pasted bytes can FUSE with a neighbour (a list item landing under an
    // existing list) and change a block nobody touched. Same neighbour proof
    // the list-merge and block-type domains use.
    const delta = insert.length - (raw.to - raw.from)
    let before = null
    let after = null
    try {
      before = outsideSignature(parseKernelMarkdown(kernel.doc.text), raw.from, raw.to, 0)
      after = outsideSignature(parseKernelMarkdown(applied.doc.text), raw.from, raw.from + insert.length, delta)
    } catch {
      return { ok: false, code: KERNEL_CODES.UNSUPPORTED, stage: 'outside-parse-failed' }
    }
    if (before === null || before !== after) return { ok: false, code: KERNEL_CODES.UNSUPPORTED, stage: 'outside-mismatch' }
    return { ok: true, applied, transaction, exact: false }
  }

  // The ANCHOR half of the guard is what P5-2.5 added, and it is what keeps
  // the refusal meaningful now that the projection map degrades an unprovable
  // block instead of the whole document: a toggle whose block degrades still
  // rebuilds a map (every OTHER block pairs fine), but the toggled block comes
  // back with `charMap: null`, so the transaction's own selection anchor no
  // longer resolves through `rawToPmPos` — refuse, nothing happens, toast,
  // rather than committing bytes into a paragraph the user could then no
  // longer type in. A transaction with no selection at all is judged on the
  // map alone.
  // Structural intents keep `requireMap: false` — their existing
  // placeholder flows legitimately pass through transient states this
  // strict guard would wrongly refuse.
  // See the call site in applyKernelTransaction: the caret home for a block
  // that is nothing but its own marker. Returns true when it placed the caret.
  const caretIntoBareMarkerBlock = (view, anchor) => {
    if (!view || !kernel.map) return false
    for (const pair of kernel.map.blockPairs || []) {
      const start = pair?.mdBlock?.position?.start?.offset
      const end = pair?.mdBlock?.position?.end?.offset
      if (!Number.isInteger(start) || !Number.isInteger(end)) continue
      if (anchor < start || anchor > end) continue
      const node = pair.pmNode
      if (!node?.isTextblock || node.content.size !== 0) continue
      if (!Number.isFinite(pair.pmPos)) continue
      try {
        const pos = Math.min(pair.pmPos + 1, view.state.doc.content.size)
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos), 1)))
        return true
      } catch {
        return false
      }
    }
    return false
  }

  const applyKernelTransaction = (txn, view, { record = true, requireMap = false, repairOnUnmapped = false } = {}) => {
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
    // Pre-compute the caret target against the PARSED doc: its content is
    // exactly what the view will hold after the reconcile, so its positions
    // transfer 1:1 — and the selection MUST ride on the same transaction
    // that inserts the new nodes. A separate follow-up selection dispatch
    // cannot reach content whose node-view DOM (Crepe's Vue list items)
    // hasn't mounted yet: the DOM caret stays behind and PM's DOM observer
    // then drags the state selection back to it, which is exactly how a
    // continuation keystroke after Enter ended up typing into the PREVIOUS
    // block (Task 11 Bug 3's caret misplacement).
    //
    // A transaction whose selection carries a genuine RANGE (anchor != head
    // — the mark-toggle commands' "keep the content selected" contract, so
    // the selection toolbar stays up for an immediate second toggle) maps
    // BOTH ends; a caret (or an unprovable head) keeps the single-position
    // behavior.
    const anchor = result.selection?.anchor ?? result.selection?.head
    const head = Number.isFinite(result.selection?.head) ? result.selection.head : anchor
    let nextMap = null
    if (requireMap || Number.isFinite(anchor)) {
      nextMap = buildProjectionMap(result.doc.text, parsed)
    }
    if (requireMap && !nextMap) {
      notifyBlocked(KERNEL_CODES.PROJECTION)
      pushKernelDiagnostic({ type: 'projection-unmappable-refused', intent: txn.intent })
      return false
    }
    // A COMMITTED offset is resolved through `resolveCommittedRawOffset`
    // (commands/insert-point.js), never through `rawToPmPos` alone: the write
    // resolver first, and only when it refuses, the INVERSE of the writer's
    // own zero-width insert point. That second resolver is what makes an
    // anchor sitting just outside a mark's delimiter run nameable — the very
    // byte this transaction wrote, because `pmPosToRawInsert` chased the mark
    // gaps to put it there. Without it the kernel refused its own proven
    // commit and swallowed the keystroke (ASCII `**bold**` lost its 8th key,
    // measured 2026-08-26; see insert-point.js's own ADR).
    //
    // It cannot invent a position: a DEGRADED pair has no charMap and both
    // resolvers answer null, so the degradation half of this guard — Case M4c
    // (`see ==www.a.com== ok`) included — keeps its full meaning.
    if (requireMap && Number.isFinite(anchor) && !resolveCommittedRawOffset(nextMap, anchor)) {
      // The map built, but the block this transaction acted on degraded to a
      // non-editable pair (see the P5-2.5 note above) — same refusal, same
      // untouched state.
      notifyBlocked(KERNEL_CODES.PROJECTION)
      pushKernelDiagnostic({ type: 'projection-unmappable-refused', intent: txn.intent })
      return false
    }
    // Any kernel transaction ends a split-placeholder session. If this
    // transaction is the one that fills the placeholder (an insert exactly
    // at its raw anchor), the reconcile below is a no-op there and the
    // rebind aligns naturally; otherwise the reconcile removes the orphaned
    // empty paragraph, because `parsed` never contains it.
    kernel.doc = result.doc
    if (record) recordHistory(result, txn)
    let target = null
    if (Number.isFinite(anchor) && nextMap) {
      const found = resolveCommittedRawOffset(nextMap, anchor)
      if (found && Number.isFinite(found.pos)) {
        target = { pos: found.pos, headPos: null }
        if (Number.isFinite(head) && head !== anchor) {
          const foundHead = resolveCommittedRawOffset(nextMap, head)
          if (foundHead && Number.isFinite(foundHead.pos)) target.headPos = foundHead.pos
        }
      }
    }
    // A quoted split whose continuation lands at the DOCUMENT END of a file
    // without a terminator: the anchor (after the trailing `> ` prefix)
    // EQUALS text.length, which is also the trailing virtual pair's raw
    // anchor — so the resolver answers the paragraph OUTSIDE the quote and
    // the caret is thrown out of the quote the user is typing in (measured
    // 2026-08-31, the 500.md report: view caret below the quote, bytes
    // still `>\n>`; the next keystroke then committed OUTSIDE with the
    // blank quote lines left as junk). The blank quote line has no pair of
    // its own here (the quote has content, so no bare-quote synthesis), so
    // the honest home is the vouched split placeholder INSIDE the quote —
    // suppress the trailing target and let ensureSplitPlaceholder below
    // materialize it after the origin block.
    if (target && txn.intent === 'split-block' && anchor === result.doc.text.length) {
      const text = result.doc.text
      const lastLineStart = text.lastIndexOf('\n', Math.max(0, anchor - 1)) + 1
      if (/^[ \t]*(?:>[ \t]*)*>[ \t]*$/.test(text.slice(lastLineStart, anchor))) {
        target = null
      }
    }
    let reconciled = false
    try {
      reconciled = reconcileProjection({
        view,
        newDoc: parsed,
        decorateTransaction: target
          ? (tr) => {
              try {
                const size = tr.doc.content.size
                const clamped = Math.max(0, Math.min(target.pos, size))
                if (Number.isFinite(target.headPos)) {
                  const clampedHead = Math.max(0, Math.min(target.headPos, size))
                  try {
                    tr.setSelection(TextSelection.create(tr.doc, clamped, clampedHead))
                  } catch {
                    tr.setSelection(TextSelection.near(tr.doc.resolve(clamped), 1))
                  }
                } else {
                  tr.setSelection(TextSelection.near(tr.doc.resolve(clamped), 1))
                }
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
    // revision. When the reconcile landed the view exactly on `parsed`,
    // the map validated above IS this revision's map — adopt it (see
    // bindMap's reuse guard) instead of rebuilding it.
    bindMap(view.state.doc, null, nextMap ? { map: nextMap, doc: parsed } : null)
    // MINIMAL-DIFF FALLBACK for a STRUCTURE-CHANGING edit (2026-08-20).
    // `reconcileProjection` replaces only the smallest differing range, which is
    // what preserves node-view identity everywhere else — but `tr.replace`
    // re-fits the slice to the schema, so when the edit changes NESTING the
    // resulting view can differ from `parsed` in a way the projection map cannot
    // pair. Measured: typing `- ` at a bullet item's text start commits the
    // correct bytes `- - x`, the minimal diff produced a view whose map came
    // back null, and the tab then refused every keystroke until it was reloaded
    // — even though OPENING those same bytes maps and edits fine.
    //
    // So: only when the rebind actually failed, and only for the callers that
    // ask, replace the whole content with the parse the kernel already trusts.
    // That is by construction the attach-time shape (`buildProjectionMap(text,
    // parse(text))`), it costs node-view identity for this one edit, and it
    // cannot fire on any path whose minimal diff worked.
    if (repairOnUnmapped && !kernel.map) {
      try {
        const repair = view.state.tr
        repair.replaceWith(0, view.state.doc.content.size, parsed.content)
        repair.setMeta('sourceProjection', true)
        repair.setMeta('addToHistory', false)
        view.dispatch(repair)
        bindMap(view.state.doc)
        pushKernelDiagnostic({ type: 'projection-full-repair', intent: txn.intent })
        if (Number.isFinite(anchor) && kernel.map) setCaretFromRaw(view, anchor)
      } catch {
        pushKernelDiagnostic({ type: 'projection-full-repair-failed', intent: txn.intent })
      }
    }
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
    } else if (Number.isFinite(anchor) && caretIntoBareMarkerBlock(view, anchor)) {
      // THE BARE MARKER'S OWN HOME (2026-08-29). Measured: Enter, `#`, `#`,
      // with any content BELOW the new line. `##` alone is an empty ATX
      // heading — it owns no character-map unit, so no resolver above can name
      // a position inside it, and the caret stayed where the reconcile left
      // it: the NEXT paragraph. The completing Space then completed nothing
      // and the title landed in the wrong block
      // (`开头段。\n\n##\n\n 标题尾段。`). At the document END the same keys
      // work, because the trailing placeholder happens to give the caret a
      // home — this rung is that home, derived rather than borrowed.
      //
      // Found by BYTES: the pair whose mdBlock span contains the committed
      // offset, whose PM node is an EMPTY textblock. That is the block the
      // marker just became, and the caret belongs inside it.
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
    // STEP-LEVEL ROUTING THROUGH THE GATEWAY CORE (ADR stage-2 item ①,
    // 2026-08-24): the composition's single committed replace is synthesized
    // as a resolved text step and handed to the SAME core every other
    // plain-text channel flows through (`commitResolvedTextSteps`) — the
    // virtual-block separator prefix, the task-seed dissolve, the
    // block-trailing space heal and the typing-spelling escape all apply
    // THERE, from one implementation. The per-route consult copies this
    // replaces were the route-blindness family's last side doors (the third
    // 「同命令、此路径也要」 comment used to live right here; the
    // channel-equivalence suite pins that this routing can never drift from
    // the keyboard path again).
    //
    // Coordinates: `pmFrom` is the diff start the composition session proved
    // against the PRE-composition PM doc — the same doc the map is bound to
    // (kernel bytes never move mid-composition). A REVISING commit's end is
    // derived from `rawTo` through the same map; a shape the map cannot
    // resolve refuses here, and the session reverts the view — the exact
    // contract the old heal-refusal branch had.
    if (!Number.isFinite(pmFrom)) {
      notifyBlocked(KERNEL_CODES.UNMAPPED)
      return false
    }
    let pmTo = pmFrom
    if (rawTo !== rawFrom) {
      const target = kernel.map?.rawToPmPos?.(rawTo)
      if (!target || !Number.isFinite(target.pos)) {
        notifyBlocked(KERNEL_CODES.UNMAPPED)
        return false
      }
      pmTo = target.pos
    }
    const committed = commitResolvedTextSteps({
      kernel,
      map: kernel.map,
      steps: [{ from: pmFrom, to: pmTo, insertText: text }]
    })
    if (!committed.ok) {
      notifyBlocked(committed.code)
      return false
    }
    // `ime-commit` is the transaction's HISTORY identity: not
    // insert-text-coalescable, bracketed as its own undo group (pinned by
    // the ime suites) — preserved across the routing.
    //
    // EXCEPT when the core answered with a MARKER COMPLETION (2026-08-26): that
    // is a different command's transaction, carrying its own intent and its own
    // selection, and stamping this one over it would file a structural marker
    // rewrite under the plain-typing identity. The undo bracketing below still
    // applies — a composed marker completion is its own group either way.
    if (!committed.markerCompletion) committed.transaction.intent = 'ime-commit'
    kernel.history.breakGroup()
    const applied = applyKernelTransaction(committed.transaction, view)
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
    getT,
    // Lazy on purpose: `markerRawOffsetAt` is declared further down this same
    // closure, so passing the identifier here would hit its TDZ.
    resolveRawOffset: (pos) => markerRawOffsetAt(pos)
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

  // Locate the single REAL (non-virtual) editable block pair whose CONTENT
  // range [contentPos, contentPos + visibleLength] contains the whole PM
  // range [from, to]. Shared by the Tab insert below and the mark-toggle
  // route: both need the pair's charMap plus its contentPos to convert PM
  // positions into the pair's visible offsets (`visible = pmPos -
  // contentPos`, the same identity `buildProjectionMap`'s own
  // `pmPosToRaw` relies on). Virtual pairs are excluded — a placeholder
  // has no real bytes to mark or tab into; refusing is the fail-closed
  // choice.
  // Resolved through the map's own `pairAt` (rather than a hand-rolled scan
  // over blockPairs reading every candidate's charMap) since lazy charMaps
  // (§9 #4): pairAt range-checks deferred pairs without materializing them,
  // so this builds only the block the range lands in. Equivalent by
  // construction — content ranges of distinct pairs are disjoint, so the
  // pair containing `from` is the only one that could contain [from, to].
  const editablePairForRange = (from, to) => {
    const pair = kernel.map?.pairAt?.(from)
    if (!pair || pair.virtual || !pair.charMap) return null
    const contentPos = pair.pmPos + 1
    if (from < contentPos || to > contentPos + pair.charMap.visibleLength) return null
    return pair
  }

  // Whitespace at a block's END — the other position CommonMark strips (see
  // lib/source-kernel/commands/trailing-whitespace.js). Measured before this
  // existed: Tab at a plain paragraph's end committed a literal '\t' that the
  // reparse threw away, so the byte sat on disk forever and the view never
  // changed; a space did the same and additionally forced a repair reconcile.
  //
  // This is the KEYMAP half (Tab, via `insertPlainTextAtSelection` below). Space
  // is deliberately NOT routed here: the Space keydown is what the preset input
  // rules ('# ', '- ', '> ', '1. ') fire on, and those all trigger at a block's
  // visible end — swallowing the key would break every one of them. A space
  // therefore reaches ProseMirror first and is re-spelled afterwards, on the
  // bytes, by `commitPlainText`.
  //
  // Refusal contract matches `commitHeadingLeadingWhitespace`: 'skip' means the
  // caller keeps exactly its previous behaviour.
  const commitBlockTrailingWhitespace = (character, state, view) => {
    if (!state?.selection?.empty) return 'skip'
    if (!kernel.map) return 'skip'
    const head = state.selection.head
    const pair = editablePairForRange(head, head)
    if (!pair?.charMap || !pair.mdBlock) return 'skip'
    const units = pair.charMap.units
    const last = Array.isArray(units) && units.length ? units[units.length - 1] : null
    if (!last) return 'skip'
    const insertAt = typeof kernel.map.pmPosToRawInsert === 'function'
      ? kernel.map.pmPosToRawInsert(head)
      : kernel.map.pmPosToRaw(head)
    // Only an APPEND at the block's visible end can be the stripped position.
    if (!Number.isFinite(insertAt) || insertAt < last.rawEnd) return 'skip'
    const text = kernel.doc.text
    const heal = healableTrailingSpace(text, pair.charMap, kernel.doc.whitespaceMarks)
    if (!literalTailIsStripped(text, pair.mdBlock, insertAt) &&
        !(heal && heal.rawEnd === insertAt)) return 'skip'
    const routed = spellBlockTailInsert({
      doc: kernel.doc,
      block: pair.mdBlock,
      offset: insertAt,
      insert: character,
      heal
    })
    if (routed.ok) {
      applyKernelTransaction(routed.transaction, view, { requireMap: true })
      return 'handled'
    }
    if (routed.code === KERNEL_CODES.NOT_STRUCTURAL) return 'skip'
    notifyBlocked(routed.code)
    return 'refused'
  }

  // Whitespace at a LINE's START — the third position CommonMark treats as
  // structure rather than content (see
  // lib/source-kernel/commands/line-start-whitespace.js). This is the KEYMAP
  // half, i.e. Tab, and it is the user's own report:
  // 「tab 在行开头输入容易触发内核不支持此操作」. Measured before this existed: Tab at
  // a top-level paragraph's first content position committed a literal '\t' and
  // the paragraph REPARSED AS AN INDENTED CODE BLOCK, silently; at a
  // continuation line (soft or hard break) and at a blockquote paragraph's text
  // start it committed a byte the reparse simply discarded.
  //
  // Space is deliberately NOT routed here, for the same reason it is not routed
  // to `commitBlockTrailingWhitespace`: the Space keydown is what the preset
  // input rules fire on. A space reaches ProseMirror first and is re-spelled
  // afterwards, on the bytes, by `commitPlainText`.
  //
  // LIST INDENTATION IS UNTOUCHED. `routeStructuralKey` resolves a list item
  // FIRST and returns the indent command for it, so this function is only ever
  // reached from the `not-structural` branch — a caret in a list item never gets
  // here, and Tab on an item that cannot be indented still refuses structurally.
  //
  // Refusal contract matches its two siblings: 'skip' means the caller keeps
  // exactly its previous behaviour.
  const commitLineStartWhitespace = (character, state, view) => {
    if (!state?.selection?.empty) return 'skip'
    if (!kernel.map) return 'skip'
    const head = state.selection.head
    const pair = editablePairForRange(head, head)
    if (!pair?.charMap || !pair.mdBlock) return 'skip'
    const insertAt = typeof kernel.map.pmPosToRawInsert === 'function'
      ? kernel.map.pmPosToRawInsert(head)
      : kernel.map.pmPosToRaw(head)
    if (!Number.isFinite(insertAt)) return 'skip'
    const text = kernel.doc.text
    if (!looksLikeBlockLineStart(text, insertAt)) return 'skip'
    const routed = spellLineStartWhitespace({
      doc: kernel.doc,
      block: pair.mdBlock,
      offset: insertAt,
      insert: character,
      heal: healableLineStartRun(text, pair.charMap, kernel.doc.whitespaceMarks, insertAt)
    })
    if (routed.ok) {
      applyKernelTransaction(routed.transaction, view, { requireMap: true })
      return 'handled'
    }
    if (routed.code === KERNEL_CODES.NOT_STRUCTURAL) return 'skip'
    notifyBlocked(routed.code)
    return 'refused'
  }

  // Tab (and future plain inserts) on the not-structural path: source-first
  // character insertion through replaceVisibleText, scoped to the single
  // editable block pair that contains the selection.
  const insertPlainTextAtSelection = (insert, state, view) => {
    const { from, to } = state.selection
    // A whitespace character appended at a block's END, or written at a line's
    // START, is not addressable as a literal byte — re-spell it (proven by
    // reparse) before the ordinary replaceVisibleText path can write the dead
    // one. The block-END check runs first because it is the narrower shape (an
    // APPEND past the block's last unit); a caret at a line start of a non-empty
    // block never satisfies it, so the two never compete.
    if (insert === ' ' || insert === '\t') {
      const routed = commitBlockTrailingWhitespace(insert, state, view)
      if (routed === 'handled') return true
      if (routed === 'refused') return false
      const lead = commitLineStartWhitespace(insert, state, view)
      if (lead === 'handled') return true
      if (lead === 'refused') return false
    }
    const pair = editablePairForRange(from, to)
    if (!pair) {
      notifyRefusal(KERNEL_CODES.UNMAPPED, from)
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

  // Space / Tab at an ATX heading's FIRST content position — the one offset in
  // a heading where a LITERAL whitespace byte is not addressable, because
  // CommonMark eats the whole spacing run between the `#` marker and the
  // content. Before this branch existed, both keys reached the ordinary
  // character path and committed that literal byte: measured on the built app,
  // Tab turned '## 标题乙' into '## \t标题乙' on disk with NO visible change and
  // no diagnostic, and Space turned '# 标题甲' into '#  标题甲' plus a
  // `projection-mismatch` repair that pulled the view straight back. Both are
  // the user report "为啥标题前面无法使用 tab 或者空格".
  //
  // `insertHeadingLeadingWhitespace` (lib/source-kernel/commands/
  // heading-whitespace.js) commits the character-entity spelling instead —
  // byte-identical to what the LEGACY writer produces for the same shape — and
  // proves it by reparsing the candidate before returning. Its two refusal
  // codes are answered differently on purpose:
  //   * `not-structural` -> 'skip': this is not that offset, so the caller
  //     keeps EXACTLY its previous behaviour (Tab falls through to the literal
  //     insert, Space falls through to ProseMirror).
  //   * anything else -> 'refused': it IS that offset and the entity could not
  //     be proven, so the key is swallowed with a toast. Falling through there
  //     would commit the byte we just proved is dead.
  //
  // `pmPosToRawInsert` — not `pmPosToRaw` — resolves the caret, so a heading
  // whose content opens with a mark ('## **b**') reports the offset BEFORE the
  // opening delimiter, which is where the content actually starts.
  const commitHeadingLeadingWhitespace = (character, state, view) => {
    if (!state?.selection?.empty) return 'skip'
    if (!kernel.map) return 'skip'
    const head = state.selection.head
    const insertAt = typeof kernel.map.pmPosToRawInsert === 'function'
      ? kernel.map.pmPosToRawInsert(head)
      : kernel.map.pmPosToRaw(head)
    if (!Number.isFinite(insertAt)) return 'skip'
    const routed = insertHeadingLeadingWhitespace({
      doc: kernel.doc,
      offset: insertAt,
      character
    })
    if (routed.ok) {
      applyKernelTransaction(routed.transaction, view, { requireMap: true })
      return 'handled'
    }
    if (routed.code === KERNEL_CODES.NOT_STRUCTURAL) return 'skip'
    notifyBlocked(routed.code)
    return 'refused'
  }

  // The pair whose PM node span STRICTLY contains `pmPos`, innermost first.
  // Unlike `editablePairForRange` this does not require a charMap, because the
  // one caller below needs to reach a pair the map REFUSED — see its own
  // comment for why that is safe (and why it is the only way out of the shape
  // it rescues).
  const innermostPairAt = (pmPos) => {
    if (!Number.isFinite(pmPos)) return null
    let best = null
    for (const pair of kernel.map?.blockPairs || []) {
      const size = pair?.pmNode?.nodeSize
      if (!Number.isFinite(size) || !Number.isFinite(pair.pmPos)) continue
      if (pmPos <= pair.pmPos || pmPos >= pair.pmPos + size) continue
      if (!best || pair.pmPos >= best.pmPos) best = pair
    }
    return best
  }

  // A Space that COMPLETES A MARKER — `- `, `1. `, `> `, `# `, `- [ ] ` — is
  // Markdown SYNTAX, not content, and it is the one Space the kernel has to
  // claim before ProseMirror does. Full measurement matrix and the three
  // separate ways it used to be intercepted:
  // lib/source-kernel/commands/marker-space.js.
  //
  // WHY IT MUST RUN IN THE KEYMAP, ahead of everything else. Its two siblings
  // (`commitBlockTrailingWhitespace`, `commitLineStartWhitespace`) deliberately
  // let a Space reach ProseMirror first and re-spell it afterwards ON THE BYTES,
  // because the preset input rules fire on Space and swallowing the key would
  // break them. That reasoning is correct for a CONTENT space and exactly
  // backwards for this one: at a NON-EMPTY block the input rule does fire, and
  // its wrapInBlockType carries node content, which the gateway then vetoes —
  // so the rule can never succeed in kernel mode anyway, and letting it run only
  // costs the user a refusal toast. Claiming the key here replaces a rule that
  // cannot work with bytes that can.
  //
  // RESOLVING THE OFFSET, including for a block the map REFUSED. The empty-block
  // shape is the reason: after typing `#` on a blank line the bytes are a valid
  // EMPTY ATX HEADING with no spacing, whose content start is genuinely
  // unprovable (`emptyAtxHeadingContentStart`), so the pair carries no charMap
  // and `pmPosToRaw` answers null — the block is read-only, and the single byte
  // that would make it provable is the one being refused. An EMPTY textblock has
  // exactly ONE caret position, and its mdast block's own end offset is where
  // content would begin, so that offset is a derivation rather than a guess. It
  // is only ever handed to `spellMarkerCompletingSpace`, which reparses before
  // returning, so a wrong derivation cannot write a byte.
  const markerRawOffsetAt = (pmPos) => {
    if (!kernel.map) return null
    const direct = typeof kernel.map.pmPosToRawInsert === 'function'
      ? kernel.map.pmPosToRawInsert(pmPos)
      : kernel.map.pmPosToRaw(pmPos)
    if (Number.isFinite(direct)) return direct
    const pair = innermostPairAt(pmPos)
    const node = pair?.pmNode
    if (!pair || pair.virtual || pair.charMap || !node?.isTextblock) return null
    if (node.content.size !== 0) return null
    // A bare LIST marker's empty item pairs with mdBlock: null (the
    // syntheticEmptyItemParagraph shape) — its byte identity rides the
    // `mdItem` record instead, whose contentStart is the marker's own end
    // (spacing is '' for a bare marker). Without this arm the derivation
    // covered only the heading family, so `- `/`* `/`1. ` at an empty
    // paragraph never routed at all.
    const end = pair.mdBlock?.position?.end?.offset ?? pair.mdItem?.contentStart
    return Number.isInteger(end) ? end : null
  }

  // `requireMap` is deliberately NOT set for either marker route: these edits
  // CHANGE THE BLOCK'S TYPE, so the projection map cannot rebind against the
  // pre-edit ProseMirror document — the reconcile is what brings the view to the
  // new structure, and it is the same path a typed `-` (which already
  // restructures the block on its own) has always taken.
  // `requireMap` is the fail-closed half, and it belongs to the COMPLETING SPACE
  // only. That edit changes the block's TYPE, and a type change is exactly where
  // the projection reconciler's minimal diff can leave a view the map cannot
  // pair — writing bytes that strand the whole tab unmapped is fail-OPEN and
  // worse than refusing. With `requireMap` the map is built from the candidate
  // bytes BEFORE `kernel.doc` moves, and the caret's own raw offset must resolve
  // in it. `repairOnUnmapped` then covers the narrower case where the map proved
  // fine but the minimal diff still produced a view that disagrees.
  //
  // RUN GROWTH MUST NOT REQUIRE IT, and that is not a relaxation: the whole
  // point of `#` -> `##` is that the INTERMEDIATE state is a marker-only heading
  // with no spacing, whose content anchor is genuinely unprovable — so
  // `rawToPmPos` cannot resolve there BY CONSTRUCTION and `requireMap` could
  // never pass. Measured: with it set, every `## ` refused mid-gesture. That
  // read-only intermediate is the state a bare typed `#` already produces
  // through the ordinary character path, it writes exactly one proven byte, and
  // the Space that follows completes it into a provable block.
  const applyMarkerTransaction = (routed, view, { requireMap = false } = {}) =>
    (applyKernelTransaction(routed.transaction, view, { requireMap, repairOnUnmapped: true })
      ? 'handled'
      : 'skip')

  const commitMarkerCompletingSpace = (state, view) => {
    if (!state?.selection?.empty) return 'skip'
    const offset = markerRawOffsetAt(state.selection.head)
    if (!Number.isFinite(offset)) return 'skip'
    const routed = spellMarkerCompletingSpace({ doc: kernel.doc, offset })
    if (!routed.ok) return 'skip'
    // Once the marker is PROVEN, this Space is the kernel's — whether the commit
    // then succeeds is its own business. Falling through on a refusal would hand
    // the key to the line-start re-speller, which writes a DIFFERENT byte
    // (U+00A0) for a position we have just proven is syntax: the user would get
    // both a refusal toast and a stray invisible character.
    applyMarkerTransaction(routed, view, { requireMap: true })
    return 'handled'
  }

  // The `##` half (see marker-space.js `spellMarkerRunGrowth`). `#` is the only
  // marker character that is already a complete block on its own, so on a blank
  // line the FIRST `#` converts the paragraph into an empty ATX heading whose
  // content anchor is (correctly) unprovable — and the second `#`, being an
  // ordinary character to every other layer, was refused with the block-scoped
  // 「只读」 message. `# ` worked and `## ` did not, and that asymmetry is what
  // pointed at the intermediate state.
  //
  // It rides `handleTextInput` rather than a keymap because `#` is a CHARACTER,
  // not a key: a keymap entry would be layout-dependent, while this prop is the
  // same channel ProseMirror's own input rules use — and, mounted in the kernel
  // plugin slot (editor-crepe-setup.js), it runs ahead of them.
  const handleMarkerRunGrowth = (view, from, to, character) => {
    // A THROW HERE EATS THE KEYSTROKE SILENTLY. ProseMirror calls this prop from
    // inside its DOM input handler and does not guard it, so an exception both
    // suppresses the character and produces no toast, no diagnostic and no
    // insertion — measured during this task, when a missing import made every
    // typed `#` vanish without a trace. Nothing in here is allowed to be the
    // reason a user loses a character, so the whole body fails closed to "not
    // mine", which is the same answer a refusal gives.
    try {
      if (inactive() || character !== '#') return false
      if (from !== to || view.composing) return false
      if (!kernel.map) return false
      const offset = markerRawOffsetAt(from)
      if (!Number.isFinite(offset)) return false
      const routed = spellMarkerRunGrowth({ doc: kernel.doc, offset, character })
      if (!routed.ok) return false
      return applyMarkerTransaction(routed, view) === 'handled'
    } catch {
      return false
    }
  }

  // MARKER-FOLLOWING TEXT — the bare-marker rule's second exit (see
  // marker-space.js `spellMarkerFollowingText`). A bare `*`/`-`/`1.`/`#` is an
  // ambiguous intermediate state; a completing Space says "it was syntax"
  // (route above), an ordinary character says "it was content" — `*` then `a`
  // is the literal paragraph `*a`, which is what the bytes already reparse
  // to. Without this route the empty structure has no provable content
  // anchor, so the character either refused (「只读」) or — after the caret
  // restore landed it in the empty item — could still not be committed.
  //
  // Same channel, same fail-closed posture as run growth directly above: a
  // throw here would eat the keystroke silently (ProseMirror calls this prop
  // unguarded), so the body answers "not mine" on every doubt. `requireMap`
  // is set because the demoted result is an ORDINARY paragraph — the map must
  // rebuild and the caret's own offset must resolve in it, or nothing is
  // written.
  const handleMarkerFollowingText = (view, from, to, character) => {
    try {
      if (inactive()) return false
      if (typeof character !== 'string' || character.length === 0 || /\s/.test(character)) return false
      if (from !== to || view.composing) return false
      if (!kernel.map) return false
      const offset = markerRawOffsetAt(from)
      if (!Number.isFinite(offset)) return false
      const routed = spellMarkerFollowingText({ doc: kernel.doc, offset, text: character })
      if (!routed.ok) return false
      return applyMarkerTransaction(routed, view, { requireMap: true }) === 'handled'
    } catch {
      return false
    }
  }
  // Space is NOT a structural key and must stay out of `structuralHandler`
  // (whose unmapped-offset branch refuses loudly — that would make ordinary
  // spaces untypable anywhere the map is incomplete). This handler answers
  // `false` for every position except the proven heading content start, so on
  // every other keystroke ProseMirror's own space handling, the preset input
  // rules and the IME path are reached exactly as before.
  const spaceHandler = (state, dispatch, viewArg) => {
    if (inactive()) return false
    const view = viewArg || getView?.()
    if (!view) return false
    // Mid-composition the keydown belongs to the IME, not to us.
    if (view.composing) return false
    // MARKER COMPLETION FIRST, and it is the one Space route that must run
    // BEFORE ProseMirror sees the key — see `commitMarkerCompletingSpace`.
    if (commitMarkerCompletingSpace(state, view) === 'handled') return true
    return commitHeadingLeadingWhitespace(' ', state, view) !== 'skip'
  }

  // THE DOCUMENT'S TRAILING EMPTY PARAGRAPH — the block a user sees as "an empty
  // line I can't remove", and the one that raised
  // 「暂未支持此操作 (unsupported-input-type)」 on Backspace (2026-08-20 user report,
  // reproduced on the first attempt).
  //
  // It is NEVER a real block. Only two things can put it there — plugin-trailing's
  // synthetic node, or a controller-vouched split placeholder — and a trailing
  // blank line cannot make a third, because CommonMark discards trailing blank
  // lines entirely (verified in the app: '...x\n\n' renders the same blocks as
  // '...x'). See lib/source-kernel/commands/trailing-placeholder.js.
  //
  // So neither key has anything to delete there, and both used to reach PM's own
  // commands, whose join/lift transaction carries node content and is refused by
  // the gateway — a toast for a gesture whose correct answer writes no bytes at
  // all:
  //   * BACKSPACE in the placeholder -> move the caret to the end of the previous
  //     block's content. The placeholder itself must NOT be removed: plugin-trailing
  //     re-adds it on the next dispatch, so "deleting" it is not a thing the
  //     document can express.
  //   * DELETE at the end of the last real block -> a no-op. There is nothing
  //     after the caret but the placeholder, and it is not content.
  //
  // The ONE case with real bytes is the round trip: Enter at the document end
  // writes a blank line, and the Backspace that takes it back should take the
  // bytes back too. `trimTrailingBlankLines` owns that, removes only the SURPLUS
  // endings (a file ending in one newline is left alone), and proves by reparse
  // that every block's type and span is unchanged first.
  const trailingPlaceholderPair = () => {
    const pairs = kernel.map?.blockPairs || []
    const last = pairs[pairs.length - 1]
    if (!last?.virtual || !last.pmNode) return null
    // `virtual` alone is NOT the discriminator: an EMPTY ATX heading's pair is
    // virtual too (an anchor-only pair over REAL `# ` bytes — see the
    // projection map's empty-heading derivation), and Backspace inside one
    // must reach the demote route, not this caret hop. Both true placeholders
    // (plugin-trailing's synthetic node, the controller-vouched split
    // placeholder) carry `mdBlock: null` — no bytes is exactly what makes
    // "nothing to delete here" true.
    if (last.mdBlock) return null
    if (!last.pmNode.isTextblock || last.pmNode.content.size !== 0) return null
    return last
  }

  // Where the caret belongs when it leaves the placeholder: the end of the
  // previous block's content, resolved by ProseMirror itself rather than by raw
  // offsets, so a previous block whose content lives in a node view (a code
  // fence, a table cell) is handled by the same rule as a paragraph.
  const beforePlaceholderSelection = (docNode, pair) => {
    try {
      return TextSelection.near(docNode.resolve(pair.pmPos), -1)
    } catch {
      return null
    }
  }

  const commitTrailingPlaceholderEdge = (key, state, view) => {
    if (key !== 'Backspace' && key !== 'Delete') return 'skip'
    if (!state?.selection?.empty || !kernel.map) return 'skip'
    const pair = trailingPlaceholderPair()
    if (!pair) return 'skip'
    const docNode = state.doc
    // The placeholder must really be the document's last node — otherwise this
    // is some other virtual block and none of the reasoning above applies.
    if (pair.pmPos + pair.pmNode.nodeSize !== docNode.content.size) return 'skip'
    const back = beforePlaceholderSelection(docNode, pair)
    const head = state.selection.head
    const insidePlaceholder = head === pair.pmPos + 1
    const atPreviousEnd = !!back && back.head === head
    if (key === 'Backspace' ? !insidePlaceholder : !atPreviousEnd) return 'skip'
    // Forward Delete at the end of the last real block: nothing follows but the
    // placeholder, so the key is simply consumed. No bytes, no caret move, no
    // toast — the document already ends here.
    if (key === 'Delete') return 'handled'
    if (!back) return 'skip'

    // Backspace: reclaim the surplus blank line the user's own Enter wrote, if
    // there is one, then land the caret. The trim is best-effort — a document
    // whose tail cannot be proven simply keeps its bytes and still gets the
    // caret move, which is the part the user asked for.
    const lastPaired = [...(kernel.map.blockPairs || [])].reverse()
      .find((entry) => Number.isInteger(entry?.mdBlock?.position?.end?.offset))
    const contentEnd = lastPaired?.mdBlock?.position?.end?.offset
    if (Number.isInteger(contentEnd)) {
      const routed = trimTrailingBlankLines({ doc: kernel.doc, contentEnd })
      if (routed.ok && applyKernelTransaction(routed.transaction, view)) return 'handled'
    }
    try {
      const tr = view.state.tr.setSelection(
        TextSelection.near(view.state.doc.resolve(Math.min(back.head, view.state.doc.content.size)), -1)
      )
      tr.setMeta('addToHistory', false)
      if (typeof tr.scrollIntoView === 'function') tr.scrollIntoView()
      view.dispatch(tr)
    } catch {
      pushKernelDiagnostic({ type: 'trailing-placeholder-caret-failed' })
      return 'skip'
    }
    return 'handled'
  }

  // Shared by the empty-list-item exit and the empty-code-block delete: the
  // structural edit's anchor sits on a prefix-only line the reparse cannot
  // show, so — when it is genuinely unmappable — a vouched placeholder is
  // materialized at the enclosing blockquote's content end (or after the
  // enclosing top-level node), with the `\n> `-style insertPrefix that keeps
  // the committed body line SEPARATED from the block above (a bare `> text`
  // line right after `> - item` is a lazy continuation CommonMark absorbs —
  // measured 2026-08-22). Outside quotes the line prefix is empty and the
  // voucher stays prefix-less. materializePlaceholder remains fail-closed.
  // `outsideQuote`: the caller's intent LEFT the quote (exit-empty-quote-line
  // deleted the trailing `> ` line), so the caret home is AFTER the quote's
  // top-level node — the backward probe below otherwise lands on the quote's
  // last content line and would materialize the placeholder back INSIDE the
  // quote the user just exited (measured 2026-08-30: Enter x4 of the staged
  // exit put the caret in a quoted placeholder; typing would have written
  // `> 正文`, re-entering the quote).
  const placeholderForUnmappableAnchor = (view, anchor, { outsideQuote = false } = {}) => {
    if (!Number.isFinite(anchor) || !kernel.map || kernel.map.rawToPmPos(anchor)) return
    let probe = anchor
    let mapped = null
    while (probe > 0 && !mapped) {
      probe -= 1
      mapped = kernel.map.rawToPmPos(probe)
    }
    if (!mapped || !Number.isFinite(mapped.pos)) {
      // ATOM-ONLY NEIGHBOURHOOD (quote-end /divider, 2026-08-31): every
      // byte before the anchor belongs to charMap-less pairs (the hr atom,
      // quote prefixes), so the byte probe finds nothing. The nearest
      // preceding BLOCK PAIR still names the position — its pmPos sits
      // inside the same blockquote the anchor's line continues.
      let best = null
      for (const pair of kernel.map.blockPairs || []) {
        const s = pair.mdBlock?.position?.start?.offset
        if (Number.isFinite(s) && s < anchor && Number.isFinite(pair.pmPos)) {
          if (!best || s > best.s) best = { s, pos: pair.pmPos }
        }
      }
      if (best) mapped = { pos: best.pos }
    }
    if (!mapped || !Number.isFinite(mapped.pos)) return
    try {
      const docNode = view.state.doc
      const $p = docNode.resolve(Math.max(0, Math.min(mapped.pos, docNode.content.size)))
      let quoteDepth = 0
      for (let d = $p.depth; d > 0; d -= 1) {
        if ($p.node(d).type.name === 'blockquote') { quoteDepth = d; break }
      }
      const insertPos = quoteDepth && !outsideQuote ? $p.end(quoteDepth) : $p.after(1)
      const text = kernel.doc.text
      const lineStart = text.lastIndexOf('\n', anchor - 1) + 1
      const linePrefix = text.slice(lineStart, anchor)
      const ending = lineStart >= 2 && text[lineStart - 2] === '\r' ? '\r\n' : '\n'
      // The commit at this anchor must never be LINE-ADJACENT to a content
      // line above it — '- item\n' + '2313' is a lazy continuation CommonMark
      // absorbs into the item (2026-08-23 user report, the root-level twin of
      // the quoted `\n> ` prefix below). When the line right above the
      // anchor's line carries content, the prefix opens a separating blank
      // line first; a blank line above needs nothing.
      const prevLineStart = lineStart > 0 ? text.lastIndexOf('\n', lineStart - 2) + 1 : 0
      const prevLineText = lineStart > 0
        ? text.slice(prevLineStart, lineStart - (text[lineStart - 2] === '\r' ? 2 : 1))
        : ''
      const prevLineHasContent = prevLineText.replace(/[>\t ]+/g, '') !== ''
      const insertPrefix = !outsideQuote && /^[>\t ]+$/.test(linePrefix) && linePrefix.includes('>')
        ? ending + linePrefix
        : prevLineHasContent ? ending : ''
      materializePlaceholder(view, insertPos, anchor, insertPrefix)
    } catch {
      pushKernelDiagnostic({ type: 'exit-placeholder-failed', rawOffset: anchor })
    }
  }

  // Character CLASSES around a raw offset, for refusal diagnostics — shape
  // without content (`nl` newline, `cr`, `sp` space, `tab`, `nb` U+00A0,
  // `#`/`-`/`*`/`>`/`|`/`.`/`[`/`]`/`(`/`)` markers verbatim, `d` digit,
  // `a` ascii letter, `u` anything else). `·` marks the caret.
  const byteClassContext = (text, offset, span = 12) => {
    if (typeof text !== 'string' || !Number.isFinite(offset)) return null
    const cls = (ch) => ch === '\n' ? 'nl' : ch === '\r' ? 'cr' : ch === ' ' ? 'sp'
      : ch === '\t' ? 'tab' : ch === '\u00A0' ? 'nb'
      : '#-*>|.[]()'.includes(ch) ? ch
      : /[0-9]/.test(ch) ? 'd' : /[A-Za-z]/.test(ch) ? 'a' : 'u'
    const before = [...text.slice(Math.max(0, offset - span), offset)].map(cls)
    const after = [...text.slice(offset, offset + span)].map(cls)
    return [...before, '·', ...after].join(',')
  }

  // Backspace at a textblock's start when the block ABOVE is a divider, an
  // image or a table (2026-08-28). Every editor answers this by SELECTING that
  // block rather than deleting anything, and the kernel wants that answer for
  // its own reason too: the selection writes no bytes, and the second press is
  // then the ordinary node deletion the gateway's `delete-blocks` route owns.
  // Before this, the press reached `joinParagraphBackward`, which refuses to
  // merge a paragraph into a node that holds no text — a named refusal on a
  // gesture the user reads as "delete the thing above me".
  //
  // Containers (list, blockquote) are deliberately absent: Backspace/Delete
  // there has its own established answers (lift the item, unwrap the quote,
  // merge the paragraph), and those are TEXT merges, not node removals.
  // `code_block` covers fenced code AND block math — the projection map pairs
  // both under that one PM type (PM_TO_MD `code_block: ['code', 'math']`) —
  // and `frontmatter` is deliberately absent: it is the document's own header,
  // not a block a stray keystroke should be able to select and drop.
  // The table the caret sits in, when the caret is at the first cell's content
  // start AND no cell in the table holds anything. Returns its top-level span,
  // or null. The walk short-circuits on the first non-empty cell.
  const emptyTableAtCaret = (state) => {
    const $head = state.selection.$head
    if (!$head || $head.parentOffset !== 0) return null
    let tableDepth = -1
    for (let depth = $head.depth; depth > 0; depth -= 1) {
      if ($head.node(depth).type?.name === 'table') { tableDepth = depth; break }
    }
    if (tableDepth < 1) return null
    // Top-level tables only: a table nested in a quote/list is a container
    // shape this deletion has not proven.
    if (tableDepth !== 1) return null
    const table = $head.node(tableDepth)
    // The caret must be in the FIRST cell, so the gesture reads as "delete
    // backwards past the start of this table" rather than "clear this cell".
    for (let depth = tableDepth + 1; depth <= $head.depth; depth += 1) {
      if ($head.index(depth - 1) !== 0) return null
    }
    let empty = true
    table.descendants((node) => {
      if (!empty) return false
      if (node.isText) {
        if (node.text?.length) { empty = false; return false }
        return true
      }
      // Any OTHER inline node — an image, inline math, an inline-HTML atom, a
      // hardbreak — is content too (2026-08-30 branch review: an image-only
      // table read as empty and one Backspace deleted it whole).
      if (node.isInline) { empty = false; return false }
      return true
    })
    if (!empty) return null
    const from = $head.before(tableDepth)
    return { from, to: from + table.nodeSize }
  }

  const ATOM_BLOCK_TYPES = new Set(['hr', 'image-block', 'image', 'table', 'code_block', 'html'])
  // Backspace at a textblock start selects the block ABOVE; Delete at a
  // textblock end selects the block BELOW. Same rule, both directions — the
  // sweep found Delete refusing on exactly the blocks Backspace refused on.
  const selectNeighbourAtomBlock = (state, view, direction) => {
    const selection = state.selection
    if (!selection.empty) return false
    const $head = selection.$head
    if (!$head || $head.depth !== 1) return false
    const parent = $head.parent
    if (!parent?.isTextblock) return false
    const atEdge = direction < 0 ? $head.parentOffset === 0 : $head.parentOffset === parent.content.size
    if (!atEdge) return false
    const index = $head.index(0)
    const neighbourIndex = direction < 0 ? index - 1 : index + 1
    if (neighbourIndex < 0 || neighbourIndex >= state.doc.childCount) return false
    const neighbour = state.doc.child(neighbourIndex)
    if (!ATOM_BLOCK_TYPES.has(neighbour?.type?.name)) return false
    const pos = direction < 0
      ? $head.before(1) - neighbour.nodeSize
      : $head.after(1)
    try {
      view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)).scrollIntoView())
      return true
    } catch {
      return false
    }
  }

  const structuralHandler = (key) => (state, dispatch, viewArg) => {
    if (inactive()) return false
    const view = viewArg || getView?.()
    if (!view) return false
    if (!kernel.map) {
      notifyBlocked(KERNEL_CODES.UNMAPPED)
      return true
    }
    // A CELL SELECTION (prosemirror-tables' cross-cell drag / Shift+click)
    // deletes by CLEARING every selected cell — legacy's answer, measured:
    // `| 甲甲甲 | 乙乙乙 |` becomes `|  |  |`. PM's own deleteCellSelection
    // replaces each cell's content with an empty paragraph slice, which no
    // gateway extractor can classify (2026-08-30 sweep: the gesture was
    // refused outright), so the kernel performs the byte edit itself: one
    // multi-edit transaction, each selected cell's visible content span
    // deleted. Duck-typed via `$anchorCell` — instanceof is unreliable across
    // bundled prosemirror-state copies.
    if ((key === 'Backspace' || key === 'Delete') && state.selection.$anchorCell) {
      const edits = []
      let unmappable = false
      state.selection.forEachCell((cell, pos) => {
        if (unmappable) return
        const para = cell.child(0)
        if (!para?.isTextblock) { unmappable = true; return }
        if (para.content.size === 0) return
        const fromRaw = kernel.map.pmPosToRaw(pos + 2)
        const toRaw = kernel.map.pmPosToRaw(pos + 2 + para.content.size)
        if (!Number.isFinite(fromRaw) || !Number.isFinite(toRaw) || toRaw < fromRaw) { unmappable = true; return }
        if (toRaw > fromRaw) edits.push({ from: fromRaw, to: toRaw, insert: '' })
      })
      if (unmappable) {
        notifyBlocked(KERNEL_CODES.UNSUPPORTED)
        return true
      }
      if (!edits.length) return true
      // applySourceTransaction's contract: edits ASCENDING, non-overlapping.
      edits.sort((a, b) => a.from - b.from)
      const clearTxn = {
        baseRevision: kernel.doc.revision,
        edits,
        intent: 'clear-cell-selection',
        selection: { anchor: edits[edits.length - 1].from, head: edits[edits.length - 1].from }
      }
      const cleared = applySourceTransaction(kernel.doc, clearTxn)
      if (!cleared.ok) {
        notifyBlocked(cleared.code)
        return true
      }
      // Same publish path as every structural command: bytes first, view
      // rebuilt from the reparse, caret restored from the anchor. The FULL
      // transaction goes into history — redo replays it.
      kernel.doc = cleared.doc
      recordHistory(cleared, clearTxn)
      const parsed = safeParse(kernel.doc.text)
      if (parsed) {
        reconcileProjection({ view, newDoc: withTrailingParagraph(parsed) })
        bindMap(view.state.doc)
        setCaretFromRaw(view, edits[edits.length - 1].from)
      } else {
        bindMap(view.state.doc)
      }
      onChange?.(kernel.doc.text, false)
      return true
    }
    // A RANGE selection is not a caret gesture (2026-08-30 branch review,
    // confirmed): every Backspace/Delete/Enter branch below routes from the
    // caret HEAD's offset alone, so Shift+Home then Backspace inside a list
    // item used to run the content-start outdent/lift on the item — the
    // selected text survived while a structural rewrite the user never asked
    // for was committed. Backspace/Delete over a selection mean "delete the
    // selection" and Enter means "replace it": hand the key to ProseMirror,
    // whose resulting transaction the gateway classifies and proves like any
    // other selection edit (the select-all suites pin exactly that path). A
    // NodeSelection is exempt — it IS a caret-less gesture, and the selected-
    // atom deletion branch below owns it.
    if ((key === 'Backspace' || key === 'Delete' || key === 'Enter') &&
        !state.selection.empty && !state.selection.node) {
      return false
    }
    // Tab / Shift-Tab inside a GFM table cell NAVIGATE between cells (Plan 5
    // Task 4 review fix). Two things made this necessary the moment table
    // cells became mappable:
    //  1. Before Task 4 a caret in a cell had no raw offset at all, so the
    //     `Number.isFinite(offset)` guard below refused the key. With cells
    //     mapped, `routeStructuralKey('Tab')` answers `not-structural` and the
    //     fallback below inserted a LITERAL TAB into the cell's source. GFM
    //     treats that byte as cell padding, so the reparse still mapped and
    //     ProseMirror still showed the same text — the tab was INVISIBLE in
    //     the view but persisted to the file, dirtied the document, took a
    //     history slot, and accumulated on every press. A byte no user can
    //     see is exactly the fidelity-bug family this kernel exists to end.
    //  2. This keymap is registered AHEAD of Crepe's own plugins, so it also
    //     preempted preset-gfm's `tableKeymap` NextCell/PrevCell — Tab stopped
    //     moving between cells and Shift-Tab was swallowed silently.
    // Routing to preset-gfm's own commands fixes both at once and writes no
    // bytes. Checked from the LIVE PM state (`isInTable`), not from the
    // projection map, so navigation also works inside a table whose cells
    // degraded to read-only — moving the caret is always safe.
    if (key === 'Tab' || key === 'Shift-Tab') {
      let inTable = false
      try {
        inTable = isInTable(state)
      } catch {
        inTable = false
      }
      if (inTable) {
        try {
          goToNextCell(key === 'Tab' ? 1 : -1)(state, dispatch || view.dispatch.bind(view), view)
        } catch {
          /* no next/previous cell, or a table shape prosemirror-tables can't
             resolve — swallow the key rather than let another keymap run a
             structural command the kernel does not own. */
        }
        return true
      }
    }
    // The atom-neighbour selection is asked BEFORE the trailing-placeholder
    // edge (2026-08-30, user: 「整个表格无法删除」): Backspace on the trailing
    // line below a table used to be claimed by the placeholder machinery,
    // which moved the caret INTO the table's last cell — so the two-press
    // select-and-delete could never begin when the table was the document's
    // last block. The branch fires only when the neighbour is an opaque atom
    // (hr / image / table / fence / block html), so the list and paragraph
    // placeholder behaviours are untouched.
    if ((key === 'Backspace' || key === 'Delete') && state.selection.empty &&
        selectNeighbourAtomBlock(state, view, key === 'Backspace' ? -1 : 1)) {
      return true
    }
    if (commitTrailingPlaceholderEdge(key, state, view) === 'handled') return true
    let offset = kernel.map.pmPosToRaw(state.selection.head)
    // An unmappable caret is FIRST given the native self-heal: if the view
    // had drifted from the bytes, the repair re-derives the projection and
    // the caret's position resolves against the healed map (read from
    // view.state — the repair may have moved both).
    if (!Number.isFinite(offset) && repairProjectionNow(view)) {
      offset = kernel.map?.pmPosToRaw?.(view.state.selection.head)
    }
    // Backspace/Delete at an EMPTY unprovable item (the `3. 4.` mdBlock-null
    // family, 2026-08-24): the caret's only home is `contentStart === end`,
    // which no charMap position covers — but the MARKER derivation the typing
    // channel already uses (`markerRawOffsetAt` -> the mdItem record's own
    // contentStart) answers it. The router's whole-item commands re-verify
    // emptiness before any byte moves, so this widens ROUTING, not writing.
    if (!Number.isFinite(offset) && (key === 'Backspace' || key === 'Delete')) {
      const markerAt = markerRawOffsetAt(view.state.selection.head)
      if (Number.isFinite(markerAt)) offset = markerAt
    }
    if (!Number.isFinite(offset)) {
      // A RANGE deletion is not a caret command, so an unresolvable caret is
      // not a reason to refuse it. Select-all's head sits at the document end,
      // which no charMap covers, and swallowing here meant Ctrl/Cmd+A then
      // Delete produced no transaction at all — silently, since this refusal
      // leaves no diagnostic. Hand it to ProseMirror instead; the resulting
      // ReplaceStep goes through the plain-text classifier like every other
      // selection deletion, which either proves it or refuses it loudly.
      if ((key === 'Backspace' || key === 'Delete') && !state.selection.empty) return false
      // Fail-closed: an unprovable caret must not reach PM's structural
      // commands (their output would be an unowned structural transaction).
      // A caret sitting in a DEGRADED block gets the block-scoped message —
      // "this paragraph is read-only" is the true and actionable statement
      // there, not "this operation isn't supported yet".
      notifyRefusal(KERNEL_CODES.UNMAPPED, view.state.selection.head)
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
    // Backspace/Delete in the LAST vouched placeholder: the inverse of the
    // Enter above — shrink the blank run / restore the pre-Enter bytes and
    // retire the placeholder (see shrinkSplitPlaceholder). Same session
    // scope as Enter (last entry only), same swallow discipline: refusals
    // are named inside, and the key never reaches PM's joinBackward (whose
    // cross-parent step the gateway could only refuse generically).
    if ((key === 'Backspace' || key === 'Delete') && splitPlaceholders.length && state.selection.empty) {
      const last = splitPlaceholders[splitPlaceholders.length - 1]
      if (offset === last.rawOffset && state.selection.head === last.pmPos + 1) {
        shrinkSplitPlaceholder(view, key)
        return true
      }
    }
    // AN EMPTY TABLE, from inside it (2026-08-29, user: 「如果表头第一个及全部
    // 内容为空就应该是删除，但是如果表格很大这样是否判断也很麻烦」). The
    // emptiness scan is not the expensive thing it sounds like: it only runs
    // when the caret is at the very START of the FIRST cell and that cell is
    // already empty, and it stops at the first cell that has content — a big
    // table with data pays for one cell. A big table with data also does not
    // need this gesture at all: selecting it from the block below and pressing
    // Backspace again deletes it whatever its size (test:kernel-block-delete).
    if (key === 'Backspace' && state.selection.empty) {
      const emptyTable = emptyTableAtCaret(state)
      if (emptyTable) {
        const committed = commitBlockDeletion({ pmFrom: emptyTable.from, pmTo: emptyTable.to })
        if (!committed.ok) {
          pushKernelDiagnostic({ type: 'block-delete-unprovable', code: committed.code, stage: committed.stage })
          notifyBlocked(committed.code)
          return true
        }
        applyKernelTransaction(committed.transaction, view)
        return true
      }
    }
    // A SELECTED atom block + Backspace/Delete is a deletion, and the kernel
    // performs it itself rather than letting the node view answer: measured,
    // Crepe's code-block view turns the press into "become a paragraph holding
    // my code" (`replace[6,19] <paragraph:11>`), which is a block-type
    // conversion, not a delete — and the user pressing Delete on a selected
    // fence means the fence should go. Divider/image/table reach the same
    // bytes through the gateway route; doing it here makes every atom answer
    // the key the same way.
    // `instanceof NodeSelection` is NOT the test: a bundle can hold more than
    // one prosemirror-state instance and the check then silently fails. A
    // NodeSelection is the only selection carrying `.node`.
    if ((key === 'Backspace' || key === 'Delete') && state.selection?.node &&
        ATOM_BLOCK_TYPES.has(state.selection.node?.type?.name)) {
      const committed = commitBlockDeletion({ pmFrom: state.selection.from, pmTo: state.selection.to })
      if (!committed.ok) {
        pushKernelDiagnostic({ type: 'block-delete-unprovable', code: committed.code, stage: committed.stage })
        notifyBlocked(committed.code)
        return true
      }
      applyKernelTransaction(committed.transaction, view)
      return true
    }
    let routed = routeStructuralKey(key, {
      doc: kernel.doc,
      index: buildSyntaxIndex(kernel.doc.text),
      offset,
      empty: state.selection.empty
    })
    // A NAMED refusal gets the same native self-heal, once: if the view/map
    // had drifted, the route just judged the WRONG document. Repair, resolve
    // the caret against the healed state, and re-route. A coherent state
    // repairs nothing and the refusal stands unchanged.
    if (!routed.ok && routed.code !== KERNEL_CODES.NOT_STRUCTURAL && repairProjectionNow(view)) {
      const healed = kernel.map?.pmPosToRaw?.(view.state.selection.head)
      if (Number.isFinite(healed)) {
        offset = healed
        routed = routeStructuralKey(key, {
          doc: kernel.doc,
          index: buildSyntaxIndex(kernel.doc.text),
          offset,
          empty: view.state.selection.empty
        })
      }
    }
    if (routed.ok) {
      const exitIntent = routed.transaction.intent === 'exit-empty-list-item'
      const exitAnchor = routed.transaction.selection?.anchor
      if (!applyKernelTransaction(routed.transaction, view)) return true
      // QUOTED EXIT LANDS A TYPABLE CARET (2026-08-22). Exiting an empty item
      // inside a blockquote leaves `> ` — a line the reparse DROPS, so the
      // anchor has no projection home and the caret was tossed to wherever
      // the reconcile put it ("跳到下一行"). The native answer is the vouched
      // split-placeholder session (the same one Enter's gap and /text ride):
      // when the exit's anchor is unmappable, materialize the placeholder at
      // the enclosing quote's content end (or after the enclosing top-level
      // node outside quotes — the doc-end case already maps through the
      // trailing machinery and skips this by the rawToPmPos guard). Typing
      // there commits prefix-less at the anchor: `> 正文`, the quote-body
      // line. materializePlaceholder is itself fail-closed — an unprovable
      // voucher removes the node again and rebinds plain.
      // The empty-blockquote delete (2026-08-28) leaves the same shape for the
      // same reason: its edit keeps one prefix-only line whose blank the
      // reparse drops, so its anchor is unmappable and the caret would be
      // tossed to a neighbour. Same vouched placeholder, same fail-closed
      // machinery — this is the half `runDeleteEmptyCodeBlock` does explicitly
      // for the code twin.
      if (exitIntent || routed.transaction.intent === 'delete-empty-blockquote' ||
          routed.transaction.intent === 'exit-empty-quote-line') {
        placeholderForUnmappableAnchor(view, exitAnchor, {
          outsideQuote: routed.transaction.intent === 'exit-empty-quote-line'
        })
      }
      return true
    }
    // Every refused structural key leaves a CONTENT-FREE breadcrumb: the key,
    // the raw offset, the named code, and the byte-CLASS context around the
    // caret (never the bytes themselves — the diagnostics doctrine). The
    // HEADING_DEMOTE lesson, applied to the whole family: a generic toast on
    // a refused Enter is undiagnosable from a screenshot without this.
    // A no-op the router named as such: swallow the key, say nothing. Asked
    // before the breadcrumb so it leaves no diagnostic either — nothing
    // happened, and nothing was supposed to (router.js SILENT_NO_OP).
    if (routed.code === KERNEL_CODES.SILENT_NO_OP) return true
    if (routed.code !== KERNEL_CODES.NOT_STRUCTURAL) {
      pushKernelDiagnostic({
        type: 'structural-refusal',
        key,
        offset,
        code: routed.code,
        context: byteClassContext(kernel.doc.text, offset)
      })
    }
    if (routed.code === KERNEL_CODES.NOT_STRUCTURAL) {
      // Backspace/Delete: FIRST the heading-demote gesture (top-level ATX
      // content start — see commitHeadingDemote; a heading's content start is
      // never `block.start`, so the router always answers not-structural
      // there), THEN let PM produce the plain text-deletion transaction;
      // handleTransactions' plain-text classification owns it (a cross-block
      // deletion classifies as blocked -> veto, still fail-closed).
      if (key === 'Backspace' || key === 'Delete') {
        if (commitHeadingDemote(offset, state, view) !== 'skip') return true
        return false
      }
      // Tab: literal tab through the kernel (source-first) — UNLESS the caret
      // sits at an ATX heading's first content position, where a literal tab
      // is a dead byte (see `commitHeadingLeadingWhitespace`).
      //
      // Tab's structural routing is deliberately untouched: `routeStructuralKey`
      // only ever returns the indent command when `index.listItemAt(offset)`
      // finds a list item, and an ATX heading is not one — that is precisely
      // why this code is reached from the `not-structural` branch. A heading
      // NESTED in a list item ('- # T') still resolves the item and still
      // indents, exactly as before, because this branch never runs for it.
      if (key === 'Tab') {
        if (commitHeadingLeadingWhitespace('\t', state, view) !== 'skip') return true
        insertPlainTextAtSelection('\t', state, view)
        return true
      }
      // Shift-Tab outside a list has no source meaning: swallow silently.
      if (key === 'Shift-Tab') return true
      // Enter: PM's splitBlock must never run in kernel mode; anything
      // splitTextBlock/list commands did not cover is refused loudly — with
      // the same content-free breadcrumb the named refusals above leave.
      pushKernelDiagnostic({
        type: 'structural-refusal',
        key,
        offset,
        code: KERNEL_CODES.UNSUPPORTED,
        context: byteClassContext(kernel.doc.text, offset)
      })
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
    if (!applyKernelTransaction(txn, view, { record: false })) {
      // The replay was refused (applyKernelTransaction has already notified).
      // `kernel.history[direction]` has ALREADY moved the group between the
      // stacks and advanced its internal `lastKnownRevision`, so leaving it
      // there desyncs the pointer from `kernel.doc` and every LATER undo AND
      // redo returns null — one refusal freezing the whole stack instead of
      // one operation (re-review finding, 2026-08-17). Put it back, and undo
      // this function's own redo-depth mirror with it, so a refused replay is
      // a true no-op.
      redoDepth -= direction === 'undo' ? 1 : -1
      // `kernel.doc` is untouched on this path (applyKernelTransaction only
      // advances it after every check passes), so its revision still equals
      // the one the replay was built against — which is exactly the proof
      // `rollbackReplay` requires before it will restore anything.
      const restored = kernel.history.rollbackReplay?.(kernel.doc)
      pushKernelDiagnostic({
        type: 'history-replay-refused',
        direction,
        restored: !!restored,
        revision: kernel.doc.revision
      })
    }
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

  // Backspace inside an EMPTY code block (bridge-gated: the CM doc has zero
  // characters) deletes the whole fence — the unremovable-island exit. Same
  // resolution as runExitCode; the caret rides the shared placeholder helper.
  const runDeleteEmptyCodeBlock = (cmView) => {
    if (inactive()) return false
    const view = getView?.()
    if (!view) return false
    const pair = codePairFromCm(cmView)
    const start = pair?.mdBlock?.position?.start?.offset
    if (!Number.isFinite(start)) {
      notifyBlocked(KERNEL_CODES.UNMAPPED)
      return true
    }
    const routed = deleteEmptyCodeBlock({
      doc: kernel.doc,
      index: buildSyntaxIndex(kernel.doc.text),
      offset: start
    })
    if (!routed.ok) {
      notifyBlocked(routed.code)
      return true
    }
    if (!applyKernelTransaction(routed.transaction, view)) return true
    placeholderForUnmappableAnchor(view, routed.transaction.selection?.anchor)
    try {
      view.focus?.()
    } catch {
      /* focus is best-effort */
    }
    return true
  }

    // Slash `/quote` entry point (Plan 4 Task 4): unlike every other slash item
  // (still refused, `isBlocked: () => 'kernelMode.unsupported'`), the quote
  // item is enabled in kernel mode and its `run` is swapped (see
  // editor-slash-menu.js's `quoteRun` / editor-crepe-setup.js's `quoteToggle`
  // option) to call straight into this function instead of dispatching PM's
  // `wrapInBlockTypeCommand`. No PM blockquote-wrap transaction is ever
  // produced for this path — the gateway never needs to classify/veto it.
  // Caret-based (not selection-based), same contract as `structuralHandler`:
  // the live caret resolves to a raw offset, `toggleBlockquote` proves the
  // wrap/unwrap transaction against `kernel.doc`, and `applyKernelTransaction`
  // commits + reconciles + restores the caret exactly like any other
  // structural kernel command (Enter/Tab/…). `requireMap` stays the default
  // `false`: a blockquote-wrapped/unwrapped paragraph/heading/list is an
  // ordinary PM node shape (unlike highlight's invisible-to-Crepe `==`
  // bytes), so the result always rebuilds a projection map.
  const runQuoteToggle = (viewArg) => {
    if (inactive()) return false
    const view = viewArg || getView?.()
    if (!view) return false
    if (!kernel.map) {
      notifyBlocked(KERNEL_CODES.UNMAPPED)
      return true
    }
    const offset = kernel.map.pmPosToRaw(view.state.selection.head)
    if (!Number.isFinite(offset)) {
      notifyRefusal(KERNEL_CODES.UNMAPPED, view.state.selection.head)
      return true
    }
    const routed = toggleBlockquote({
      doc: kernel.doc,
      index: buildSyntaxIndex(kernel.doc.text),
      offset
    })
    if (!routed.ok) {
      notifyBlocked(routed.code)
      return true
    }
    applyKernelTransaction(routed.transaction, view)
    return true
  }

  // CriticMarkup review commands (review domain). CriticMarkup is PLAIN TEXT
  // syntax, so in kernel mode each review command is a raw-byte edit at a
  // proven offset (lib/source-kernel/commands/review-markup.js owns the byte
  // spellings — shared with legacy via reviewMarkup.js — and the reparse
  // proof). Two entry points reach these:
  //  * `runReviewWrap` — apiOverrides.applyReviewMarkup below (the selection
  //    toolbar's review picker + the app menu, both of which call the editor
  //    API surface).
  //  * `runReviewResolve` — the review CARD's Done/Delete/Edit actions
  //    (editor-review-card.js), which in legacy dispatch a PM insertText the
  //    gateway could only refuse; in kernel mode the card branches here via
  //    the decoration plugin's `kernelReview` option (editor-crepe-setup.js)
  //    BEFORE any PM dispatch, so the gateway's fail-closed net for unrouted
  //    review transactions stays exactly as it was.
  // Accept/reject-ALL needs no kernel entry point at all: it is a
  // whole-document string rewrite of tab.content (kept current by onChange on
  // every kernel commit) plus a reloadNonce remount, which re-attaches the
  // kernel on the resolved bytes — no PM transaction is ever dispatched.
  const REVIEW_INLINE_ONLY = 'review-inline-only'
  const notifyReviewInlineOnly = () => {
    // Same message the legacy paths raise for a multiline selection
    // (review.inlineOnly), with notifyBlocked's own cooldown bookkeeping.
    const now = Date.now()
    if (now - (lastNotifyAt.get(REVIEW_INLINE_ONLY) || 0) < NOTIFY_COOLDOWN_MS) return
    lastNotifyAt.set(REVIEW_INLINE_ONLY, now)
    notify?.(tOr('review.inlineOnly', 'Review markup works on a single-line selection'))
  }
  const runReviewWrap = (kind, selectionRange = null) => {
    if (inactive()) return null
    const view = getView?.()
    if (!view || !kernel.map) {
      notifyBlocked(KERNEL_CODES.UNMAPPED)
      return false
    }
    let from = view.state.selection.from
    let to = view.state.selection.to
    if (Number.isFinite(selectionRange?.anchor) && Number.isFinite(selectionRange?.head)) {
      from = Math.min(selectionRange.anchor, selectionRange.head)
      to = Math.max(selectionRange.anchor, selectionRange.head)
    }
    // A selection spanning blocks is the legacy 'multiline' refusal — say so
    // with the same message instead of a generic unmapped toast.
    try {
      if (view.state.doc.textBetween(from, to, '\n').includes('\n')) {
        notifyReviewInlineOnly()
        return false
      }
    } catch {
      notifyBlocked(KERNEL_CODES.UNMAPPED)
      return false
    }
    const pair = editablePairForRange(from, to)
    if (!pair) {
      notifyRefusal(KERNEL_CODES.UNMAPPED, from)
      return false
    }
    const contentPos = pair.pmPos + 1
    const routed = wrapReviewMarkup({
      doc: kernel.doc,
      index: buildSyntaxIndex(kernel.doc.text),
      map: pair.charMap,
      visFrom: from - contentPos,
      visTo: to - contentPos,
      kind
    })
    if (!routed.ok) {
      if (routed.code === 'review-multiline') notifyReviewInlineOnly()
      else notifyBlocked(routed.code)
      return false
    }
    const applied = applyKernelTransaction(routed.transaction, view, { requireMap: true })
    if (applied) view.focus?.()
    return applied
  }
  const runReviewResolve = ({ annotation, action, replacement } = {}) => {
    // `null` = "kernel not the owner": the card falls back to its legacy PM
    // dispatch (degraded/legacy tabs). Any boolean means the kernel owned the
    // action (true = committed, false = refused with its own toast).
    if (inactive()) return null
    const view = getView?.()
    if (!view || !kernel.map) {
      notifyBlocked(KERNEL_CODES.UNMAPPED)
      return false
    }
    if (!annotation ||
        !Number.isFinite(annotation.from) || !Number.isFinite(annotation.to)) {
      notifyBlocked(KERNEL_CODES.UNSUPPORTED)
      return false
    }
    const pair = editablePairForRange(annotation.from, annotation.to)
    if (!pair) {
      notifyRefusal(KERNEL_CODES.UNMAPPED, annotation.from)
      return false
    }
    const contentPos = pair.pmPos + 1
    const routed = resolveReviewMarker({
      doc: kernel.doc,
      index: buildSyntaxIndex(kernel.doc.text),
      map: pair.charMap,
      visFrom: annotation.from - contentPos,
      visTo: annotation.to - contentPos,
      expected: { text: annotation.text, comment: annotation.comment },
      action,
      replacement
    })
    if (!routed.ok) {
      notifyBlocked(routed.code)
      return false
    }
    return applyKernelTransaction(routed.transaction, view, { requireMap: true })
  }

  // Slash-only entry point (Plan 4 Task 5, real-bug fix — found while
  // building this item's first genuine end-to-end UI regression; probe
  // transcript in the task report). `shouldShow` (editor-slash-menu.js) only
  // ever fires when the ENTIRE current paragraph/heading's raw text IS the
  // typed "/query" (`atEndOfBlock` + `text.startsWith('/')` together force
  // this — there is no reachable invocation where "/quote" is typed after
  // real content), so routing straight into `runQuoteToggle` would wrap the
  // LITERAL query bytes ('> /quote' instead of an empty '> ' the user can
  // type into).
  //
  // A separate PM `clearTextInCurrentBlockCommand` dispatch BEFORE the wrap
  // does not fix this either (probed): a fully-emptied top-level paragraph
  // has NO raw representation (CommonMark: a blank line is a block
  // separator, not a node) — `bindMap`'s synchronous rebuild fails for the
  // same reason a fresh empty doc-region always does, and the async
  // `verifyPlainTextProjection` repair that would normally reconcile a
  // legitimate split-placeholder is scheduled via `queueMicrotask`, so an
  // immediate same-tick `runQuoteToggle` call sees `kernel.map` already null
  // and refuses. The net effect of "clear, then toggle" is neither a clean
  // wrap nor the old '> /quote' fallback — the paragraph just silently
  // vanishes once the microtask's reconcile catches up.
  //
  // Fix: never let that unrepresentable intermediate state exist. A first
  // attempt tried "strip the query bytes from a throwaway copy, then
  // delegate to `toggleBlockquote` against that copy" — but `toggleBlockquote`
  // ALSO resolves its target through `topLevelNodeAt`, an mdast NODE lookup,
  // and a genuinely blank stretch produces no node either (same root cause,
  // one level up: probed, `toggleBlockquote` itself then refuses with
  // 'unsupported-structure'). There is no node to find here BY CONSTRUCTION —
  // the target is always exactly one blank line — so this command does not
  // try to find one. It builds the ONE edit directly: replace
  // `[queryStart, queryEnd)` (the query bytes, proven above to be the
  // block's entire raw content) with a bare `'>'`, the same "blank owned
  // line" marker convention `quote-toggle.js`'s own `wrapEdits` already uses
  // for a loose list's internal blank line — a single atomic commit straight
  // from "/quote" text to a real (empty, ready-to-type-into) blockquote
  // line, with no separate PM dispatch and no intermediate empty-paragraph
  // state ever reaching the view.
  const runQuoteToggleFromQuery = (viewArg) => {
    if (inactive()) return false
    const view = viewArg || getView?.()
    if (!view) return false
    if (!kernel.map) {
      notifyBlocked(KERNEL_CODES.UNMAPPED)
      return true
    }
    const headRaw = kernel.map.pmPosToRaw(view.state.selection.head)
    if (!Number.isFinite(headRaw) || headRaw < 1) {
      notifyRefusal(KERNEL_CODES.UNMAPPED, view.state.selection.head)
      return true
    }
    const index = buildSyntaxIndex(kernel.doc.text)
    // blockAt is exclusive-end and the caret sits AT the block's own end
    // (shouldShow's atEndOfBlock) — probe one raw byte back, same recovery
    // idiom quote-toggle.js's own topLevelNodeAt uses.
    const block = index.blockAt(headRaw - 1)
    if (!block || !['paragraph', 'heading'].includes(block.type) || block.end !== headRaw) {
      notifyBlocked(KERNEL_CODES.UNSUPPORTED)
      return true
    }
    const queryStart = block.start
    const queryEnd = headRaw
    const combined = {
      baseRevision: kernel.doc.revision,
      edits: [{ from: queryStart, to: queryEnd, insert: '>' }],
      intent: 'wrap-blockquote',
      selection: { anchor: queryStart + 1, head: queryStart + 1 }
    }
    // WHY THIS COMMAND USED TO BE UNREACHABLE, AND WHAT CHANGED (2026-08-19).
    // A bare '>' marker with nothing else on its line reparses to a blockquote
    // mdast node with ZERO children, while ProseMirror's blockquote schema is
    // `content: "block+"` and the Milkdown transformer's `createAndFill` always
    // gives it an empty paragraph. That was a COUNT mismatch (2 PM blocks vs 1
    // mdast block), so the result document's map was null and `requireMap`
    // refused — every single time. The item was enabled in the slash menu and
    // had never once succeeded.
    //
    // The mismatch is now synthesized in editor-kernel-projection-map.js
    // (`syntheticEmptyQuoteParagraph`), exactly as the identical shape one
    // container over — an empty list item's auto-filled paragraph — has always
    // been: the empty blockquote pairs as a VIRTUAL editable block anchored at
    // the raw offset right after its marker, so the caret has a provable home
    // and the next keystroke commits '>x'. (It also un-degrades every document
    // that merely CONTAINS a bare '>' line: before, that one node rejected the
    // whole map and dropped the file to legacy.)
    //
    // `requireMap: true` stays, and is now a real gate rather than a permanent
    // refusal: it proves, pre-commit, that the RESULT document maps AND that
    // this command's own caret anchor resolves through it, leaving bytes,
    // history and view untouched if it does not.
    applyKernelTransaction(combined, view, { requireMap: true })
    return true
  }

  // Slash block-type entry point (block-type conversion domain). Same shape
  // and same reasoning as `runQuoteToggleFromQuery` right above — and for the
  // same reason it exists at all: the slash query's bytes are ALREADY in the
  // source when the item runs, so the strip and the marker write must be ONE
  // kernel transaction. A separate PM `clearTextInCurrentBlockCommand`
  // dispatch first would leave a fully-empty top-level paragraph, which
  // CommonMark cannot represent and the kernel's own self-heal then prunes
  // before the conversion ever runs (that ADR's full probe transcript is
  // directly above).
  //
  // Unlike the quote route, this one does NOT need to hand-build its edit:
  // `setBlockTypeFromQuery` writes a real marker, so the resulting block is
  // an ordinary heading/list — a shape the projection map can pair. The quote
  // route's hand-built edit exists because a bare '>' reparses to a
  // blockquote with ZERO mdast children, which ProseMirror's `block+`
  // blockquote can never hold; a `## ` heading (PM `inline*`) and a `- ` list
  // item (PM auto-fills an empty paragraph, and the map pairs it via
  // `syntheticEmptyItemParagraph`) both round-trip.
  //
  // `requireMap: true` is kept regardless: it is the pre-commit proof that
  // the RESULT document maps AND that this command's own caret anchor
  // resolves through it, with everything untouched if it does not. That guard
  // is precisely what refuses the shapes this command's target table already
  // excludes, should one ever slip through — the empty task item (whose
  // paragraph carries the checkbox bytes and cannot be character-mapped) is
  // the live example.
  const runBlockTypeFromQuery = (target, viewArg) => {
    if (inactive()) return false
    const view = viewArg || getView?.()
    if (!view) return false
    if (!kernel.map) {
      notifyBlocked(KERNEL_CODES.UNMAPPED)
      return true
    }
    const headRaw = kernel.map.pmPosToRaw(view.state.selection.head)
    if (!Number.isFinite(headRaw)) {
      notifyRefusal(KERNEL_CODES.UNMAPPED, view.state.selection.head)
      return true
    }
    const routed = setBlockTypeFromQuery({
      doc: kernel.doc,
      index: buildSyntaxIndex(kernel.doc.text),
      offset: headRaw,
      target
    })
    if (!routed.ok) {
      notifyBlocked(routed.code)
      return true
    }
    applyKernelTransaction(routed.transaction, view, { requireMap: true })
    return true
  }

  // Slash block-INSERT entry point (`/table`, `/code`, `/js` …). Same contract,
  // same reachability and the same one-transaction rule as
  // `runBlockTypeFromQuery` directly above: the query bytes are ALREADY in the
  // source when the item runs, so stripping them and writing the new block
  // must be ONE kernel transaction — a separate PM
  // `clearTextInCurrentBlockCommand` dispatch first would leave the fully-empty
  // top-level paragraph CommonMark cannot represent and the kernel's self-heal
  // prunes (that ADR's probe transcript is above `runQuoteToggleFromQuery`).
  //
  // `route` is `{ target, language }`, resolved by the SAME function
  // editor-crepe-setup.js derives `isBlocked` from, so an unblocked item always
  // has a route and vice versa.
  //
  // `requireMap: true` is what makes an insert safe to offer at all. The
  // command proves the BYTES (that they reparse to exactly the block it wrote,
  // and that nothing around them changed meaning); this proves the PROJECTION —
  // that the result document still maps AND that the caret anchor the command
  // derived resolves through the rebuilt map. Both halves are pre-commit: a
  // failure leaves bytes, history and view exactly as they were. A block the
  // kernel creates but cannot map would be read-only, which is strictly worse
  // than a refused menu item.
  // BLOCK TYPE AT THE CARET — the shortcut/toolbar/menu entry point
  // (`Mod+1`…`Mod+6`, `Mod+0`, the H button, the right-click list, the status
  // bar). Measured before this existed: kernel mode refused all of them while
  // legacy converted the block, so switching a tab to kernel mode silently
  // removed a documented shortcut. Returns false when the kernel does not
  // claim the gesture, so the caller can fall back to its legacy path.
  const runSetBlockType = (target, viewArg) => {
    if (inactive()) return false
    const view = viewArg || getView?.()
    if (!view || !kernel.map) return false
    const offset = kernel.map.pmPosToRaw(view.state.selection.head)
    if (!Number.isFinite(offset)) return false
    const routed = convertBlockTypeAtCaret({
      doc: kernel.doc,
      index: buildSyntaxIndex(kernel.doc.text),
      offset,
      target
    })
    if (!routed.ok) {
      // A no-op is silent; anything else is a named refusal.
      if (routed.code !== KERNEL_CODES.SILENT_NO_OP) notifyBlocked(routed.code)
      return true
    }
    applyKernelTransaction(routed.transaction, view, { requireMap: true })
    return true
  }

  const runInsertBlockFromQuery = (route, viewArg) => {
    if (inactive()) return false
    const view = viewArg || getView?.()
    if (!view) return false
    if (!kernel.map) {
      notifyBlocked(KERNEL_CODES.UNMAPPED)
      return true
    }
    const headRaw = kernel.map.pmPosToRaw(view.state.selection.head)
    if (!Number.isFinite(headRaw)) {
      notifyRefusal(KERNEL_CODES.UNMAPPED, view.state.selection.head)
      return true
    }
    const routed = insertBlockFromQuery({
      doc: kernel.doc,
      index: buildSyntaxIndex(kernel.doc.text),
      offset: headRaw,
      target: route?.target,
      language: route?.language
    })
    if (!routed.ok) {
      notifyBlocked(routed.code)
      return true
    }
    return applyRoutedBlockResult(routed, view)
  }

  // The tail of runInsertBlockFromQuery, shared verbatim with
  // commitHeadingDemote below: a routed block command's result is either a
  // plain transaction (requireMap posture — the block-type-conversion family's
  // standard) or a /text-machinery result whose docEnd/mid placeholder flags
  // need the vouched split-placeholder session. The demote of an EMPTY H1
  // delegates to that same machinery (block-type.js), so both entry points
  // must apply its flags identically.
  const applyRoutedBlockResult = (routed, view) => {
    // QUOTE-END /divider (2026-08-31): the command wrote a trailing blank
    // quoted line as the caret's byte home; the reparse drops that line, so
    // the anchor is unmappable by design — the same in-quote vouched
    // placeholder the staged exit's stage 3 rides serves typing there
    // (`\n> `-prefixed commits, fail-closed voucher).
    if (routed.quotePlaceholder) {
      if (applyKernelTransaction(routed.transaction, view)) {
        const anchor = routed.transaction.selection?.anchor
        // The written `> ` line can pair as the bare-quote VIRTUAL pair (the
        // /quote machinery), in which case the anchor RESOLVES — the caret
        // just was not placed (the commit resolver refused it, measured:
        // typing then landed outside the quote). Place it directly; only an
        // unresolvable anchor needs the materialized placeholder.
        if (Number.isFinite(anchor) && kernel.map?.rawToPmPos?.(anchor)) {
          setCaretFromRaw(view, anchor)
        } else {
          placeholderForUnmappableAnchor(view, anchor)
        }
      }
      return true
    }
    // `/text` onto a paragraph/heading-ending document (2026-08-20): the
    // command proved the bytes (a pure suffix deletion) but its caret anchor
    // — the document end — is a position the reparse CANNOT represent (no
    // trailing pair exists when the last block is a paragraph/heading), so
    // `requireMap`'s anchor half would refuse a byte-correct edit. This is
    // exactly the transient the structural intents' `requireMap: false`
    // posture exists for (see applyKernelTransaction's own note): commit,
    // reconcile, then give the caret its home through the SAME vouched
    // split-placeholder session `runExitCode` uses — `materializePlaceholder`
    // is itself fail-closed (an unprovable voucher removes the placeholder
    // again and rebinds plain). The voucher's prefix-less commit is
    // byte-correct because the command proved the kept bytes end in a blank
    // line (revertToTextFromQuery's own separator assertion).
    if (routed.docEndPlaceholder) {
      if (!applyKernelTransaction(routed.transaction, view)) return true
      const anchor = routed.transaction.selection?.anchor
      if (Number.isFinite(anchor) && kernel.map && !kernel.map.rawToPmPos(anchor)) {
        materializePlaceholder(view, view.state.doc.content.size, anchor)
      }
      return true
    }
    // `/text` MID-DOCUMENT (2026-08-21): the same vouched session, one
    // position further in. The command proved the bytes (the deletion changes
    // nothing around it) AND that a character typed at the anchor becomes a
    // real paragraph there; what is left is the placeholder's PM home, and
    // the only honest way to name it is the query block's own TOP-LEVEL INDEX,
    // read from the live view BEFORE the commit. Deriving it afterwards would
    // mean pairing mdast root children with PM top-level children by hand;
    // taking it from the PM side up front assumes nothing at all — children
    // [0, index) are byte-identical across the edit, so summing their
    // nodeSizes lands exactly where the deleted block stood.
    //
    // Both post-commit facts are re-checked rather than trusted: the reconcile
    // must have removed EXACTLY one top-level child, and the anchor must still
    // be unmappable (a resolvable anchor means the reconcile already gave the
    // caret a real home and a placeholder would be a second, competing one).
    // `materializePlaceholder` is itself fail-closed — an unprovable voucher
    // removes the node again and rebinds plain — so the worst case is the
    // proven byte edit with the caret wherever the reconcile left it, never a
    // half-tracked node.
    if (routed.midPlaceholder) {
      const childIndex = topLevelIndexAt(view.state.doc, view.state.selection.head)
      const childrenBefore = view.state.doc.childCount
      if (!applyKernelTransaction(routed.transaction, view)) return true
      const anchor = routed.transaction.selection?.anchor
      const docNode = view.state.doc
      if (Number.isInteger(childIndex) && Number.isFinite(anchor) &&
          docNode.childCount === childrenBefore - 1 && childIndex <= docNode.childCount &&
          kernel.map && !kernel.map.rawToPmPos(anchor)) {
        let insertPos = 0
        for (let i = 0; i < childIndex; i += 1) insertPos += docNode.child(i).nodeSize
        materializePlaceholder(view, insertPos, anchor)
      }
      return true
    }
    applyKernelTransaction(routed.transaction, view, { requireMap: true })
    return true
  }

  // -------------------------------------------------------------------------
  // Table structural operations (2026-08-22): the entry points the table
  // block-handle UI actually offers — add row (above/below), add column
  // (left/right), delete row, delete column, column alignment — routed to the
  // pure byte commands in lib/source-kernel/commands/table-ops.js.
  //
  // WIRING. The gestures live in @milkdown/components' table-block Vue
  // component, which dispatches through Milkdown COMMANDS
  // (addRowBeforeCommand & friends). editor-crepe-setup.js re-registers those
  // six commands with kernel-aware wrappers (routeTableCommandsThroughKernel)
  // that call this entry point while the kernel is active and fall through to
  // the original implementation otherwise — the same "swap the run, keep the
  // UI" pattern the slash menu uses. The gateway's veto for UNROUTED table
  // structural transactions stays untouched as the fail-closed net (row/col
  // DRAG-reorder still dispatches moveRow/moveCol and is vetoed).
  //
  // WHICH table and WHICH row/column come from the live state exactly as the
  // legacy commands would read them: `selectedRect` over the CellSelection the
  // handle click just set (rect.top/bottom/left/right are PM row/column
  // indexes, header row = 0). The kernel side then needs the table's RAW
  // location, found through the current projection map's own tableCell pairs
  // — which doubles as the gate that the table ZIPPED (mdast rows === PM
  // rows, so the PM indexes mean the same thing in the source). A degraded
  // table (ragged, header-only, unrecoverable delimiter) has no cell pairs
  // and refuses here with the named code, bytes untouched.
  //
  // The command proves the BYTES (reparse: predicted shape, untouched cells
  // identical, outside signature); `requireMap: true` proves the PROJECTION
  // (the result document still maps AND the caret anchor — the target cell's
  // own content anchor — resolves through the rebuilt map). Both halves are
  // pre-commit; a failure leaves bytes, history and view exactly as they
  // were, plus a toast.
  const tableRawOffsetForRect = (rect) => {
    const tablePos = rect.tableStart - 1
    const tableEnd = tablePos + rect.table.nodeSize
    for (const pair of kernel.map?.blockPairs || []) {
      if (!pair.tableCell) continue
      if (pair.pmPos <= tablePos || pair.pmPos >= tableEnd) continue
      const start = pair.mdBlock?.position?.start?.offset
      if (Number.isInteger(start)) return start
    }
    return null
  }

  const runTableOperation = (request, viewArg) => {
    if (inactive()) return false
    const view = viewArg || getView?.()
    if (!view) return false
    if (!kernel.map) {
      notifyBlocked(KERNEL_CODES.UNMAPPED)
      return true
    }
    let rect = null
    try {
      rect = isInTable(view.state) ? selectedRect(view.state) : null
    } catch {
      rect = null
    }
    if (!rect) {
      notifyBlocked(TABLE_OP_CODES.UNSUPPORTED)
      return true
    }
    const rawOffset = tableRawOffsetForRect(rect)
    if (rawOffset === null) {
      notifyBlocked(TABLE_OP_CODES.UNSUPPORTED)
      return true
    }
    const doc = kernel.doc
    const kind = request?.kind
    let routed = null
    if (kind === 'add-row-before' || kind === 'add-row-after') {
      routed = insertTableRow({
        doc,
        offset: rawOffset,
        rowIndex: kind === 'add-row-before' ? rect.top : rect.bottom
      })
    } else if (kind === 'add-col-before' || kind === 'add-col-after') {
      routed = insertTableColumn({
        doc,
        offset: rawOffset,
        columnIndex: kind === 'add-col-before' ? rect.left : rect.right
      })
    } else if (kind === 'align') {
      // The UI aligns ONE column (the col handle's button group); a wider
      // CellSelection is not that gesture.
      if (rect.right - rect.left !== 1) {
        notifyBlocked(TABLE_OP_CODES.UNSUPPORTED)
        return true
      }
      routed = setTableColumnAlignment({
        doc,
        offset: rawOffset,
        columnIndex: rect.left,
        alignment: request?.payload
      })
    } else if (kind === 'delete-selected') {
      const sel = view.state.selection
      if (!(sel instanceof CellSelection)) {
        notifyBlocked(TABLE_OP_CODES.UNSUPPORTED)
        return true
      }
      const isRow = sel.isRowSelection()
      const isCol = sel.isColSelection()
      if (isRow && isCol) {
        // The WHOLE table is selected. From this UI that is the col handle's
        // delete on a single-column table — name the real reason; anything
        // else (a hand-made whole-table selection) is out of scope.
        notifyBlocked(rect.map.width === 1 ? TABLE_OP_CODES.LAST_COLUMN : TABLE_OP_CODES.UNSUPPORTED)
        return true
      }
      if (isCol) {
        if (rect.right - rect.left !== 1) {
          notifyBlocked(TABLE_OP_CODES.UNSUPPORTED)
          return true
        }
        routed = deleteTableColumn({ doc, offset: rawOffset, columnIndex: rect.left })
      } else if (isRow) {
        if (rect.bottom - rect.top !== 1) {
          notifyBlocked(TABLE_OP_CODES.UNSUPPORTED)
          return true
        }
        routed = deleteTableRow({ doc, offset: rawOffset, rowIndex: rect.top })
      } else {
        notifyBlocked(TABLE_OP_CODES.UNSUPPORTED)
        return true
      }
    } else if (kind === 'move-row' || kind === 'move-col') {
      // The drag handle's payload carries the absolute indices (row 0 = the
      // header); the preceding selectRowCommand/selectColCommand dispatch
      // already put the selection in the table, so rect/rawOffset above are
      // the dragged table's.
      const payload = request?.payload || {}
      routed = kind === 'move-row'
        ? moveTableRow({ doc, offset: rawOffset, from: payload.from, to: payload.to })
        : moveTableColumn({ doc, offset: rawOffset, from: payload.from, to: payload.to })
    } else {
      notifyBlocked(TABLE_OP_CODES.UNSUPPORTED)
      return true
    }
    if (!routed.ok) {
      notifyBlocked(routed.code)
      return true
    }
    // Setting the alignment a column already has: nothing to write, nothing
    // to toast — the view already shows it.
    if (routed.noop) return true
    applyKernelTransaction(routed.transaction, view, { requireMap: true })
    return true
  }

  // Backspace/Delete at a TOP-LEVEL ATX heading's content start is the
  // demote gesture (Milkdown's DowngradeHeading binds BOTH keys there; the
  // gateway's extractHeadingDemotion documents the transaction it would
  // produce). Routed to the kernel's own byte command instead of being let
  // through to PM: H_n loses one `#`, a content-bearing H1 loses its whole
  // opening, an EMPTY H1 rides the /text placeholder machinery — and every
  // unprovable shape keeps a named refusal. 'skip' = not that position at
  // all; the caller falls through exactly as before (plain deletion via PM,
  // or — for the still-unrouted nested-heading shapes — PM's demote
  // transaction and the gateway's named refusal, unchanged).
  // `looksLikeAtxContentStart` is the same cheap byte prefilter the
  // plain-text gateway uses — this sits on the hot Backspace path, and the
  // full command (two parses) must not run on ordinary mid-text deletions.
  const commitHeadingDemote = (offset, state, view) => {
    if (!state.selection.empty) return 'skip'
    const text = kernel.doc?.text
    if (typeof text !== 'string' || !looksLikeAtxContentStart(text, offset)) return 'skip'
    const routed = demoteHeadingAtCaret({
      doc: kernel.doc,
      index: buildSyntaxIndex(kernel.doc.text),
      offset
    })
    if (!routed.ok) {
      if (routed.code === KERNEL_CODES.NOT_STRUCTURAL) return 'skip'
      notifyBlocked(routed.code)
      return 'handled'
    }
    applyRoutedBlockResult(routed, view)
    return 'handled'
  }


  // SOURCE-FAITHFUL ORDERED NUMBERS (2026-08-24 user report「这个源码都不对
  // 照」: the view showed CommonMark's sequential ordinals 1,2,3 while the
  // authored bytes said 1,3,4). For a byte-authoritative kernel the EDITOR
  // shows the AUTHOR's numbers — the Obsidian/VSCode reading — while export
  // targets (GitHub etc.) keep their own sequential convention. Pure view
  // decoration: each ordered list_item pair's SOURCE number is read from the
  // syntax index at the pair's own mdast offset (mdast discards per-item
  // numbers; the kernel index keeps them) and painted over the auto ordinal
  // via a CSS variable + ::before swap (app.css `.hm-source-ordinal`). The
  // stale-map guard re-resolves each pair's node from the CURRENT doc and
  // skips on any disagreement — a decoration may be momentarily absent,
  // never wrong.
  const sourceOrdinalPlugin = () => new Plugin({
    props: {
      decorations: (state) => {
        try {
          if (inactive() || !kernel.map) return null
          const index = buildSyntaxIndex(kernel.doc.text)
          const decos = []
          for (const pair of kernel.map.blockPairs) {
            if (pair.pmNode?.type?.name !== 'list_item') continue
            const start = pair.mdBlock?.position?.start?.offset
            if (!Number.isInteger(start)) continue
            const item = index.listItemAt(start)
            if (!item?.ordered || !Number.isFinite(item.ordered.number)) continue
            const node = state.doc.nodeAt(pair.pmPos)
            if (!node || node.type.name !== 'list_item') continue
            decos.push(Decoration.node(pair.pmPos, pair.pmPos + node.nodeSize, {
              class: 'hm-source-ordinal',
              style: `--hm-source-ordinal: "${item.ordered.number}${item.ordered.delimiter}"`
            }))
          }
          return decos.length ? DecorationSet.create(state.doc, decos) : null
        } catch {
          return null
        }
      }
    }
  })

  const structuralHandlers = Object.fromEntries(
    STRUCTURAL_KEYS.map((key) => [key, structuralHandler(key)])
  )
  const historyHandlers = {
    undo: historyHandler('undo'),
    redo: historyHandler('redo')
  }

  // `Space` rides in the SAME keymap slot (ahead of the preset keymaps) rather
  // than in its own plugin, so its precedence relative to Tab/Enter is fixed by
  // construction. prosemirror-keymap normalizes the name 'Space' to ' '.
  // IN-CELL LINE BREAK, on the SAME three keys legacy binds (2026-08-29, user:
  // 「表格内部需要支持换行不可能都是单行噻」 + 「对应的交互逻辑和快捷键操作也要
  // 适配，不能提升用户使用成本」). editor-tablebreak.js binds Enter,
  // Shift+Enter AND Mod+Enter inside a cell; kernel mode only ever routed
  // Enter, so the other two reached Crepe's own keymap, produced a PM
  // hardbreak the gateway could not classify, and refused — a user switching a
  // tab to kernel mode silently lost two thirds of the shortcut.
  //
  // Both extra keys go through the SAME command as Enter (the router's
  // `insertTableCellBreak`), so there is one spelling of an in-cell break, and
  // OUTSIDE a table they answer `false` and fall through to whatever owns them
  // there — this adds a table route, it does not take Shift+Enter away from
  // the paragraph domain.
  const cellBreakHandler = (state, dispatch, viewArg) => {
    const view = viewArg || getView?.()
    if (inactive() || !view || !kernel.map) return false
    if (!state.selection.empty) return false
    let inCell = false
    try {
      inCell = isInTable(state)
    } catch {
      inCell = false
    }
    if (!inCell) return false
    return structuralHandler('Enter')(state, dispatch, view)
  }
  const structuralKeymap = () => keymap({
    ...structuralHandlers,
    Space: spaceHandler,
    'Shift-Enter': cellBreakHandler,
    'Mod-Enter': cellBreakHandler
  })
  const historyKeymap = () => keymap({
    'Mod-z': historyHandlers.undo,
    'Mod-y': historyHandlers.redo,
    'Shift-Mod-z': historyHandlers.redo
  })
  // ATX heading marker growth (`#` -> `##`). A CHARACTER, not a key, so it
  // rides `handleTextInput` — the same channel ProseMirror's own input rules
  // use — and is mounted in the kernel plugin slot so it runs ahead of them.
  // Run growth first (it claims only '#'), then the demoting character — the
  // two exits of the same bare-marker state, in the order that keeps `##`
  // growth ahead of "a seventh # is literal text".
  const markerInputPlugin = () => new Plugin({
    props: {
      handleTextInput: (view, from, to, character) =>
        handleMarkerRunGrowth(view, from, to, character) ||
        handleMarkerFollowingText(view, from, to, character)
    }
  })

  // Empty-selection mark-shortcut guard (Plan 4 Task 3 ADR): PM's
  // `toggleMark` on an EMPTY selection dispatches a stored-marks-only
  // transaction — `docChanged: false`, so the dispatch channel
  // (editor-source-transactions.js) never consults the gateway at all and
  // the mark silently ARMS. The very next typed character then carries the
  // mark in its insert slice, which `plainSliceText` refuses → every
  // keystroke vetoes with a toast until the caret moves (storedMarks reset
  // on selection change) — a typing trap with no visible cause. This keymap
  // sits ahead of the preset keymaps (same registration slot as the
  // structural/history keymaps in editor-crepe-setup.js) and swallows the
  // five mark shortcuts ONLY when the selection is empty, with a "select
  // text first" toast; a real selection falls through (`false`) to the
  // preset's own toggleMark, whose transaction the gateway then owns as
  // `mark-toggle`. Shortcut list per the live presets: Mod-b (strong),
  // Mod-i (emphasis), Mod-e (inlineCode), Mod-Alt-x (strike_through, gfm),
  // Mod-Alt-h (highlight, editor-highlight.js).
  const markShortcutGuard = (state) => {
    if (inactive()) return false
    if (!state?.selection?.empty) return false
    notify?.(tOr('kernelMode.selectTextFirst', 'Select some text first to format it'))
    return true
  }
  const MARK_SHORTCUTS = ['Mod-b', 'Mod-i', 'Mod-e', 'Mod-Alt-x', 'Mod-Alt-h']
  const marksKeymap = () => keymap(Object.fromEntries(
    MARK_SHORTCUTS.map((key) => [key, markShortcutGuard])
  ))

  const notifyUnsupportedApi = (api) => {
    notifyBlocked(KERNEL_CODES.INPUT_TYPE)
    pushKernelDiagnostic({ type: 'unsupported-api', api })
    return false
  }

  // Would this formatting request run on an EMPTY selection? An explicit
  // selectionRange ({anchor, head} — the context menu's saved selection,
  // restored by the legacy implementation before dispatching) is judged by
  // its own ends; otherwise the live view's current selection decides.
  // Unknowable (no view) counts as empty — fail-closed.
  const selectionEmptyFor = (selectionRange) => {
    if (Number.isFinite(selectionRange?.anchor) && Number.isFinite(selectionRange?.head)) {
      return selectionRange.anchor === selectionRange.head
    }
    const view = getView?.()
    return !view || !!view.state.selection.empty
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

  // ===========================================================================
  // THE PUBLICATION BOUNDARY (2026-08-26, D5)
  // ===========================================================================
  // `kernel.doc.text` is the DOCUMENT. What a save / export / scratch-draft
  // persistence writes is the document's PUBLICATION — the same bytes with
  // every outstanding whitespace placeholder resolved
  // (`resolveWhitespaceForPublish`, whose ADR states what is dropped, what is
  // kept, and how each drop is proven). Without it, a Space or Tab typed as the
  // LAST action reached the file as U+00A0 and stayed there forever: the heal
  // that owns the placeholder needs a NEXT keystroke, and at that boundary
  // there is none.
  //
  // PURE, AND THE DOCUMENT IS NOT REWRITTEN. Nothing is dispatched, no
  // projection is reconciled, the ledger is untouched and the caret does not
  // move — so the character the user typed is still in the editor after the
  // save, and typing on still heals it into an ordinary space ('hello', Space,
  // Cmd+S, 'world' -> 'hello world', not 'helloworld').
  //
  // THE BOUNDARY SET, ENUMERATED (revised 2026-08-26, correction A/M3 — the
  // original reading of this paragraph, "a SOURCE-MODE toggle is a reading
  // toggle and therefore does not publish", was FALSE: it left three callers
  // that DO reach durable storage on the un-forced path, and each of them put
  // U+00A0 in the user's file). A boundary is any caller whose result can be
  // WRITTEN — to disk, to an exported document, or to the session. There are
  // exactly five, and all of them force:
  //
  //   1. save / export      — App.jsx `getMarkdownForTab` / `getSettledMarkdownForTab`
  //   2. pending-rich-draft — lib/pending-rich-draft.js `resolvePendingRichDraft`
  //   3. SOURCE-MODE ENTRY  — hooks/useSourceModeSwitch.js `flushRichSource`.
  //      Its snapshot becomes `tab.content` AND the source textarea's buffer,
  //      and a save in source mode writes that buffer VERBATIM (the save path
  //      short-circuits on the textarea before any flush). So source mode shows
  //      what a save would write.
  //   4. SESSION PERSISTENCE — hooks/useAppLifecycle.js `flushSession`, via the
  //      lib/scratch-draft-publication.js registry. The restore rebuilds an
  //      unsaved scratch draft with an EMPTY ledger, so a placeholder stored
  //      there becomes an authored character forever.
  //   5. getRecoveryMarkdown — takes no options and is always a boundary.
  //
  // AND ONE STATED EXEMPTION: `Editor.jsx`'s ~260 ms rich-dirty reconcile
  // (`scheduleRichDirtyReconcile`) also published un-forced text into
  // `tab.content` — it is a bridge for LEGACY's serializer debounce and is now
  // switched OFF in kernel mode entirely, so it is not a boundary because it no
  // longer runs. Any OTHER un-forced reader is by definition a view-only reader
  // and gets the document's own bytes; a caller that forgets `force` gets the
  // fail-safe direction (the placeholder is kept, never silently written).
  //
  // What the user sees is unchanged where it can be represented: a LINE-START
  // run is durable, visible indentation and `resolveWhitespaceForPublish` KEEPS
  // it, so source mode still shows and can delete that whitespace («就是空白，
  // 类似于在源码中也是空格»). Only a BLOCK-TRAILING run — bytes CommonMark
  // deletes, which therefore have no spelling at all — is dropped.
  //
  // Memoised on the document OBJECT (not its revision: `replaceMarkdown`
  // installs a fresh document at revision 0), so repeated flush readers on one
  // unchanged document pay for the proof's parses once. With an empty ledger —
  // every keystroke that is not an outstanding placeholder — it is O(1).
  let publishCache = null
  const publishedDocumentText = () => {
    if (publishCache?.doc === kernel.doc) return publishCache.text
    const resolved = resolveWhitespaceForPublish(kernel.doc)
    publishCache = { doc: kernel.doc, text: resolved.text }
    if (resolved.drops.length) {
      pushKernelDiagnostic({
        type: 'publish-whitespace-resolved',
        drops: resolved.drops.length,
        revision: kernel.doc.revision
      })
    }
    return resolved.text
  }
  const publishesDurably = (args) => args?.[0]?.force === true

  const apiOverrides = {
    // kernel.doc.text IS the durable source; no serializer round-trip, no
    // preservation mapper, no fail-closed null path. NOTE every delegate
    // branch below is an explicit `if`, never `??`: a legacy result of
    // null/undefined (fail-closed flush, void toggleHighlight) is a REAL
    // result that must propagate, not fall through to the kernel value.
    flushMarkdown: (...args) => {
      const delegate = legacy('flushMarkdown')
      if (delegate) return delegate(...args)
      // A flush reader (save, mode switch, export) must not read past a
      // pending debounced verify — run it now (see the debounce ADR above).
      flushPendingVerify()
      return publishesDurably(args) ? publishedDocumentText() : kernel.doc.text
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
      flushPendingVerify()
      return publishesDurably(args) ? publishedDocumentText() : kernel.doc.text
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
      flushPendingVerify()
      // A recovery copy is written to a FILE — a durability boundary with no
      // options bag of its own.
      return publishedDocumentText()
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
    // Inline formatting (Plan 4 Task 3): route bold/italic/strike/code/
    // highlight through the CAPTURED legacy implementation — it dispatches a
    // plain PM `toggleMark` on the live view (after restoring the context
    // menu's saved selection and focus), and that dispatch is exactly what
    // the gateway now classifies as `mark-toggle` and the kernel routes
    // (veto + source commit + reconcile). No parallel formatting
    // implementation exists: legacy stays the single command path in BOTH
    // modes; the only difference is who owns the resulting transaction.
    // `link` joined them in Plan 5 Task 6: the legacy path calls Milkdown's
    // `toggleLinkCommand`, which opens the LinkTooltip, and the tooltip's own
    // confirm/remove dispatch is what the gateway now classifies as
    // `link-edit` (see the `link-edit` case in handleTransactions). An EMPTY
    // selection is refused up front with a "select text first" toast — the
    // legacy path would silently return false, and letting a stored-marks
    // toggle arm would set up the typing trap the marksKeymap guard above
    // closes for the keyboard shortcuts.
    applyTextFormat: (format, selectionRange = null) => {
      const delegate = legacy('applyTextFormat')
      if (delegate) return delegate(format, selectionRange)
      const impl = legacyApi?.applyTextFormat
      if (typeof impl !== 'function') return notifyUnsupportedApi('applyTextFormat')
      if (selectionEmptyFor(selectionRange)) {
        notify?.(tOr('kernelMode.selectTextFirst', 'Select some text first to format it'))
        return false
      }
      return impl(format, selectionRange)
    },
    toggleHighlight: (...args) => {
      const delegate = legacy('toggleHighlight')
      if (delegate) return delegate(...args)
      const impl = legacyApi?.toggleHighlight
      if (typeof impl !== 'function') return notifyUnsupportedApi('toggleHighlight')
      if (selectionEmptyFor(null)) {
        notify?.(tOr('kernelMode.selectTextFirst', 'Select some text first to format it'))
        return false
      }
      return impl(...args)
    },
    // Review markup (review domain): the wrap routes through the kernel as a
    // raw-byte edit (runReviewWrap above). Substitution and non-literal
    // selections keep their own named refusals inside the command; a degraded
    // tab still delegates to the captured legacy implementation.
    applyReviewMarkup: (kind, selectionRange = null) => {
      const delegate = legacy('applyReviewMarkup')
      if (delegate) return delegate(kind, selectionRange)
      const handled = runReviewWrap(kind, selectionRange)
      // `null` means the kernel is not attached yet (and not degraded —
      // otherwise the delegate above would have run): refuse loudly rather
      // than silently dropping the command.
      if (handled === null) return notifyUnsupportedApi('applyReviewMarkup')
      return handled
    }
  }

  const dispose = () => {
    disposed = true
    kernel.map = null
    if (verifyTimer) {
      clearTimeout(verifyTimer)
      verifyTimer = null
    }
    compositionSession.dispose()
    // Clear the host's indicator: a torn-down editor must not leave a stale
    // "some blocks are read-only" badge behind.
    publishStatus()
  }

  return {
    kernel,
    handleTransactions,
    structuralKeymap,
    historyKeymap,
    markerInputPlugin,
    // Undecided-ordinal graying (typing-policy ADR 第二阶段 item ②): a pure
    // view decoration — grays the AUTO ordinal while an ordered item's entire
    // content is the escaped `N\.`/`N\)`. Registered by editor-crepe-setup.js
    // alongside the other kernel plugins (kernel mode only; zero byte impact).
    undecidedOrdinalPlugin: createUndecidedOrdinalPlugin,
    // Paste provenance (see pasteFlagPlugin): registered by
    // editor-crepe-setup.js alongside the other kernel plugins.
    pasteFlagPlugin,
    sourceOrdinalPlugin,
    handleMarkerRunGrowth,
    // Empty-selection mark-shortcut guard (Plan 4 Task 3): registered by
    // editor-crepe-setup.js alongside the structural/history keymaps;
    // `markShortcutGuard` is exposed for the headless suite.
    marksKeymap,
    markShortcutGuard,
    structuralHandlers,
    historyHandlers,
    runHistory,
    // CM-bridge per-block gate + Mod-Enter exit (Plan 3 Task 5): consumed by
    // editor-crepe-setup.js's CodeMirror featureConfig via
    // createKernelCmExtensions' `isEditable`/`runExitCode` callbacks.
    isCmBlockEditable,
    runExitCode,
    runDeleteEmptyCodeBlock,
    // Slash `/quote` entry point (Plan 4 Task 4): consumed by
    // editor-crepe-setup.js's `quoteToggle` slash-plugin option, which wires
    // it into editor-slash-menu.js's per-item `run` override.
    runQuoteToggle,
    runQuoteToggleFromQuery,
    runBlockTypeFromQuery,
    // Shortcut/toolbar/menu block-type conversion (2026-08-29): consumed by
    // Editor.jsx's `setBlock`, which falls back to its legacy path on false.
    runSetBlockType,
    runInsertBlockFromQuery,
    // CriticMarkup review (review domain): the wrap is reached through
    // apiOverrides.applyReviewMarkup; the resolve is handed to the review
    // decoration plugin's card actions via editor-crepe-setup.js's
    // `kernelReview` option.
    runReviewWrap,
    runReviewResolve,
    // Table structural ops (2026-08-22): consumed by editor-crepe-setup.js's
    // routeTableCommandsThroughKernel, which swaps the six table commands the
    // block-handle UI dispatches for kernel-aware wrappers.
    runTableOperation,
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
    // The chunked-load repair (see repairChunkedProjection): Editor.jsx awaits
    // it at the end of `appendChunks`, before attach.
    repairChunkedProjection,
    getChunkRepair: () => (chunkRepair ? { ...chunkRepair } : null),
    isDegraded: () => degraded,
    // P6 Task 3: the observable-degradation state (see getKernelStatus).
    getKernelStatus,
    // Perf counters (see perfStats above): a snapshot copy, never the live
    // object — callers must not be able to write the counts.
    getPerfStats: () => ({ ...perfStats }),
    composition,
    dispose
  }
}
