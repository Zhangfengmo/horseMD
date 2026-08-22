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
import { Plugin, TextSelection } from '@milkdown/prose/state'
// Table-cell navigation (Plan 5 Task 4 review fix): the SAME two commands
// @milkdown/preset-gfm's own `tableKeymap` binds Tab / Shift-Tab to
// (preset-gfm/lib/index.js:415-420 + :652-667 — `goToNextTableCellCommand` IS
// `goToNextCell(1)`), so kernel mode reproduces the editor's expected
// behaviour rather than shadowing it. Both are SELECTION-only commands (they
// dispatch nothing but `tr.setSelection(...).scrollIntoView()`), so they write
// no bytes and the gateway classifies their transaction as `selection-only`.
import { goToNextCell, isInTable } from '@milkdown/prose/tables'
import {
  KERNEL_CODES,
  applySourceTransaction,
  buildSyntaxIndex,
  createMarkdownDocument,
  createSourceHistory,
  dissolvableTaskSeed,
  exitCodeBlock,
  insertHeadingLeadingWhitespace,
  spellBlockTailInsert,
  spellTaskSeedInsert,
  literalTailIsStripped,
  healableTrailingSpace,
  spellLineStartWhitespace,
  spellMarkerCompletingSpace,
  spellMarkerRunGrowth,
  spellMarkerFollowingText,
  trimTrailingBlankLines,
  looksLikeBlockLineStart,
  healableLineStartRun,
  replaceVisibleText,
  routeStructuralKey,
  toggleBlockquote,
  setBlockTypeFromQuery,
  demoteHeadingAtCaret,
  looksLikeAtxContentStart,
  insertBlockFromQuery,
  toggleInlineMark,
  wrapReviewMarkup,
  resolveReviewMarker
} from '../lib/source-kernel/index.js'
import { buildProjectionMap } from './editor-kernel-projection-map.js'
import { classifyTransactions, commitPlainText, commitTaskToggle, commitCodeLanguage, commitImageAttrs, routeLinkEdit, routeTrailingAtomTyping, isTypableTextblock } from './editor-kernel-gateway.js'
import { pairIsReadOnlyToUser, readOnlyPairAt } from '../lib/kernel-status.js'
import { diffReplaceRange, diffReplaceRegions, reconcileProjection, reconcileProjectionRegions } from './editor-kernel-reconciler.js'
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
  chunkedLoad = false,
  getView,
  parse,
  prepareMarkdown,
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
    const specific = tOr(`kernelMode.blocked.${code}`, '')
    notify?.(specific || `${tOr('kernelMode.unsupported', 'Kernel mode blocked this edit')} (${code})`)
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
          const found = nextMap?.rawToPmCaret?.(caretRaw)
          if (found && Number.isFinite(found.pos)) caretPos = found.pos
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
  const requestVerify = (newDoc, caretRaw = null) => {
    if (!kernel.map) {
      // Rebind failed: verify is the repair path and must run NOW, against
      // the doc the caller is installing (the live view may not carry it yet
      // — handleTransactions runs before updateState).
      if (newDoc) verifyPlainTextProjection(newDoc, caretRaw)
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
        bindMap(newState?.doc || null)
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
          requestVerify(newState?.doc, caretRide)
        }
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
        // Refusal is loud and total: `caption`/`ratio` never reach here
        // (the gateway does not classify them), and anything `setImageAttrs`
        // cannot prove byte-for-byte vetoes the PM transaction too, so the
        // view never shows an attribute the source does not carry.
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
    if (requireMap && Number.isFinite(anchor) && !nextMap?.rawToPmPos?.(anchor)) {
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
      const found = nextMap.rawToPmPos?.(anchor)
      if (found && Number.isFinite(found.pos)) {
        target = { pos: found.pos, headPos: null }
        if (Number.isFinite(head) && head !== anchor) {
          const foundHead = nextMap.rawToPmPos?.(head)
          if (foundHead && Number.isFinite(foundHead.pos)) target.headPos = foundHead.pos
        }
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
    // THE BLOCK-TRAILING SPACE HEAL, ON THIS PATH TOO (2026-08-19, audit
    // finding). A space typed at a block end is committed as U+00A0
    // (commands/trailing-whitespace.js: CommonMark strips a literal one there),
    // and it is meant to be rewritten back to an ordinary space the moment a
    // character displaces it. That heal used to fire from ONE place — the
    // gateway's single-code-point plain-text branch — so an IME COMMIT, which
    // is a whole composition committed here as one multi-character replace,
    // never reached it. For a user who writes Chinese that is the normal input
    // path, and the measured result was a U+00A0 stranded before EVERY CJK word
    // typed after a space ('HorseMD<U+00A0>是一个编辑器'), permanently, on disk.
    //
    // Same command, same reparse proof, same fall-through contract: a heal that
    // cannot be proven answers `not-structural` and the composition commits its
    // literal bytes exactly as before.
    // The RE-SPELLING half rides along on the same call (2026-08-19, audit item
    // 2): a commit that ENDS in whitespace at a block end wrote that trailing
    // byte literally, and CommonMark strips it — the original dead byte,
    // reached from the IME route instead of the keyboard one. `literalTailIsStripped`
    // is the same parse-free predicate the gateway's own prefilter uses.
    let healFrom = rawFrom
    let healTo = rawTo
    let healInsert = insert
    let healMarks = null
    if (!virtualBlock && rawFrom === rawTo && typeof kernel.map?.pairAt === 'function' &&
        Number.isFinite(pmFrom)) {
      const pair = kernel.map.pairAt(pmFrom)
      if (pair && !pair.virtual && pair.charMap && pair.mdBlock) {
        // THE TASK-SEED DISSOLVE, ON THIS PATH TOO (2026-08-20 adversarial
        // panel, Important — the same route-blindness as the 2026-08-19 heal
        // finding this comment block sits inside). The dissolve used to be
        // consulted only in the gateway's plain-text branch, so an
        // IME-committed first label character — the NORMAL way a Chinese
        // user types the label — landed AFTER the seed and permanently
        // embedded the kernel-authored U+00A0 at the label's start
        // (`- [ ] <U+00A0>买菜` on disk where ASCII typing yields
        // `- [ ] 买菜`), with the surviving `ascii:''` ledger entry vouching
        // a byte that no longer had any exit.
        //
        // SAME commands, not a fork: `dissolvableTaskSeed` (the parse-free,
        // ledger-gated prefilter) + `spellTaskSeedInsert` (delete seed +
        // insert label as ONE edit, reparse-proven checked-state and exact
        // label) — the identical consultation the gateway's plain-text
        // branch performs. Its only non-ok answer is `not-structural` (the
        // ruled fallback is the literal commit — seed + composed text is
        // honest, observable bytes), so there is no refusal arm.
        //
        // ORDER: ahead of the trailing-whitespace heal, mirroring the
        // gateway's branch order — the seed's block-end position can satisfy
        // the heal's prefilter too, though its heal already refuses the
        // empty-`ascii` entry, so the provenance partition is enforced twice.
        let taskSeedDissolved = false
        if (insert !== '' && !/[\r\n]/.test(insert)) {
          const seed = dissolvableTaskSeed(
            kernel.doc.text, pair.charMap, kernel.doc.whitespaceMarks, rawFrom
          )
          if (seed) {
            const routed = spellTaskSeedInsert({
              doc: kernel.doc,
              block: pair.mdBlock,
              seed,
              offset: rawFrom,
              insert
            })
            if (routed.ok) {
              healFrom = routed.edit.from
              healTo = routed.edit.to
              healInsert = routed.edit.insert
              healMarks = routed.whitespaceMarks
              taskSeedDissolved = true
            }
          }
        }
        if (!taskSeedDissolved) {
          const heal = healableTrailingSpace(kernel.doc.text, pair.charMap, kernel.doc.whitespaceMarks)
          const stripped = literalTailIsStripped(kernel.doc.text, pair.mdBlock, rawFrom)
          if ((heal && heal.rawEnd === rawFrom) || stripped) {
            const routed = spellBlockTailInsert({
              doc: kernel.doc,
              block: pair.mdBlock,
              offset: rawFrom,
              insert,
              heal
            })
            if (routed.ok) {
              healFrom = routed.edit.from
              healTo = routed.edit.to
              healInsert = routed.edit.insert
              healMarks = routed.whitespaceMarks
            } else if (routed.code !== KERNEL_CODES.NOT_STRUCTURAL) {
              // The trailing byte IS one CommonMark discards and no surviving
              // spelling could be proven: refuse rather than commit it. The
              // composition session reverts the view, so nothing diverges.
              notifyBlocked(routed.code)
              return false
            }
          }
        }
      }
    }
    kernel.history.breakGroup()
    const applied = applyKernelTransaction({
      baseRevision: kernel.doc.revision,
      from: healFrom,
      to: healTo,
      insert: healInsert,
      intent: 'ime-commit',
      ...(healMarks?.length ? { whitespaceMarks: healMarks } : {})
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

  const structuralHandler = (key) => (state, dispatch, viewArg) => {
    if (inactive()) return false
    const view = viewArg || getView?.()
    if (!view) return false
    if (!kernel.map) {
      notifyBlocked(KERNEL_CODES.UNMAPPED)
      return true
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
    if (commitTrailingPlaceholderEdge(key, state, view) === 'handled') return true
    const offset = kernel.map.pmPosToRaw(state.selection.head)
    if (!Number.isFinite(offset)) {
      // Fail-closed: an unprovable caret must not reach PM's structural
      // commands (their output would be an unowned structural transaction).
      // A caret sitting in a DEGRADED block gets the block-scoped message —
      // "this paragraph is read-only" is the true and actionable statement
      // there, not "this operation isn't supported yet".
      notifyRefusal(KERNEL_CODES.UNMAPPED, state.selection.head)
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
  const structuralKeymap = () => keymap({ ...structuralHandlers, Space: spaceHandler })
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
      flushPendingVerify()
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
      flushPendingVerify()
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
    // Slash `/quote` entry point (Plan 4 Task 4): consumed by
    // editor-crepe-setup.js's `quoteToggle` slash-plugin option, which wires
    // it into editor-slash-menu.js's per-item `run` override.
    runQuoteToggle,
    runQuoteToggleFromQuery,
    runBlockTypeFromQuery,
    runInsertBlockFromQuery,
    // CriticMarkup review (review domain): the wrap is reached through
    // apiOverrides.applyReviewMarkup; the resolve is handed to the review
    // decoration plugin's card actions via editor-crepe-setup.js's
    // `kernelReview` option.
    runReviewWrap,
    runReviewResolve,
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
