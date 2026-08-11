import { TextSelection, NodeSelection } from '@milkdown/prose/state'
import { commandsCtx, remarkCtx, serializerCtx } from '@milkdown/kit/core'
import { toggleMark } from '@milkdown/prose/commands'
import { replaceAll } from '@milkdown/utils'
import { applyReviewMarkupInView } from './editor-review.js'
import { normalizeReviewMarkupMarkdown } from '../reviewMarkup.js'
import {
  generatedScratchMarkdown,
  preserveGeneratedBulletMarkers,
  preserveRichMarkdownSource
} from '../markdown-source-preservation.js'
import { normalizeDisplayMath } from './editor-math.js'
import { markdownOffsetToPmPos, pmPosToMarkdownOffset } from './editor-source-map.js'
import { createPdfSourceFromEditor } from './editor-pdf-content.js'
import { applyHighlightInView, toggleHighlightCommand } from './editor-highlight.js'
import { codeMirrorSelectionInfo } from './editor-codemirror-selection.js'
import {
  emphasisSchema,
  inlineCodeSchema,
  strongSchema
} from '@milkdown/kit/preset/commonmark'
import { strikethroughSchema } from '@milkdown/kit/preset/gfm'
import { toggleLinkCommand } from '@milkdown/kit/component/link-tooltip'
import { settleEditorMarkdown } from '../lib/editor-flush-settle.js'
import { canonicalSourceFallback } from './editor-source-verification.js'

export function createEditorApi({
  viewRef,
  crepe,
  crepeRef,
  lastMarkdownRef,
  canonicalMarkdownRef,
  programmaticReplaceRef,
  hasPendingRichFlush,
  clearPendingRichFlush,
  generatedScratchRef,
  getGeneratedScratchMarkdown,
  sourceCommitter,
  canonicalForSource,
  setBlock,
  markUserEdit,
  onStructureChange,
  isDestroyed,
  resetTransactionIntents,
  getT,
  notify
}) {
  const getPdfSource = async () => {
    const v = viewRef.current
    if (!v) return null
    return createPdfSourceFromEditor(v.dom)
  }

  const serializeCurrentDocument = () => {
    try {
      const view = viewRef.current
      if (view) return crepe.editor.ctx.get(serializerCtx)(view.state.doc)
    } catch {
      // Fall through to Crepe's cached serializer snapshot during teardown.
    }
    try {
      return crepe.getMarkdown()
    } catch {
      return ''
    }
  }

  const getMarkdown = () => serializeCurrentDocument()

  const toggleHighlight = () => {
    try {
      crepe.editor.ctx.get(commandsCtx).call(toggleHighlightCommand.key)
    } catch {
      /* editor tearing down */
    }
  }

  const restoreTextSelection = (selectionRange = null) => {
    const view = viewRef.current
    if (!view) return false
    try {
      if (Number.isFinite(selectionRange?.anchor) && Number.isFinite(selectionRange?.head)) {
        const { content } = view.state.doc
        const anchor = Math.max(0, Math.min(selectionRange.anchor, content.size))
        const head = Math.max(0, Math.min(selectionRange.head, content.size))
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)))
      }
      return !view.state.selection.empty
    } catch {
      return false
    }
  }

  // This is the shared command path for the selection toolbar and the
  // right-click fallback. The latter is enabled only when the user hides the
  // floating toolbar, so no parallel formatting implementation can drift.
  const applyTextFormat = (format, selectionRange = null) => {
    const view = viewRef.current
    if (!view || !restoreTextSelection(selectionRange)) return false
    try {
      // The fallback is opened from a native-like contextmenu event, which does
      // not reliably retain ProseMirror focus on every platform. Restore it
      // before dispatching a Milkdown command so the command sees the selected
      // range instead of a stale DOM selection.
      view.focus()
      markUserEdit?.()
      if (format === 'highlight') {
        applyHighlightInView(view, 'yellow')
        return true
      }
      const mark = {
        bold: strongSchema,
        italic: emphasisSchema,
        strike: strikethroughSchema,
        code: inlineCodeSchema
      }[format]
      if (mark) {
        // Execute mark changes against the active ProseMirror view directly.
        // The same commands back Crepe's toolbar, but its command registry can
        // see a stale focus owner immediately after a context-menu event.
        return toggleMark(mark.type(crepe.editor.ctx))(view.state, (tr) => view.dispatch(tr), view)
      }
      if (format !== 'link') return false
      crepe.editor.ctx.get(commandsCtx).call(toggleLinkCommand.key)
      return true
    } catch {
      return false
    }
  }

  const applyReviewMarkup = (kind, selectionRange = null) => {
    const view = viewRef.current
    if (!view || !restoreTextSelection(selectionRange)) return false
    view.focus()
    const result = applyReviewMarkupInView(view, kind)
    if (!result.ok && result.reason === 'multiline') {
      notify?.(getT('review.inlineOnly'))
    }
    if (result.ok) markUserEdit?.()
    return result.ok
  }

  const replaceMarkdown = (md) => {
    if (isDestroyed?.() || !crepeRef.current) return false
    const programmaticReplace = {}
    try {
      const source = md || ''
      // Once source mode has supplied Markdown, that source is authored. A
      // formerly blank scratch document must therefore leave the generated
      // canonical path; later rich edits must preserve the user's spacing and
      // marker choices exactly like any document opened from disk.
      if (generatedScratchRef && source !== lastMarkdownRef.current) {
        generatedScratchRef.current = false
      }
      const next = normalizeReviewMarkupMarkdown(normalizeDisplayMath(source))
      lastMarkdownRef.current = source
      clearPendingRichFlush?.()
      if (programmaticReplaceRef) programmaticReplaceRef.current = programmaticReplace
      crepe.editor.action(replaceAll(next))
      const canonical = canonicalForSource(serializeCurrentDocument())
      canonicalMarkdownRef.current = canonical
      onStructureChange?.()
      return true
    } catch (err) {
      if (programmaticReplaceRef?.current === programmaticReplace) {
        programmaticReplaceRef.current = null
      }
      console.error('Replace markdown failed', err)
      return false
    }
  }

  const flushMarkdown = ({ force = false } = {}) => {
    if (isDestroyed?.() || !crepeRef.current) return null
    try {
      // A reading-only source toggle must not serialize an entire large
      // ProseMirror document. The flag is raised synchronously for every user
      // edit and cleared only after markdownUpdated (or this flush) commits the
      // matching source snapshot, so immediate save/switch correctness remains
      // intact without making ordinary reading toggles needlessly slow.
      // Reading-only mode switches may reuse the committed snapshot for speed.
      // Saves and exports pass `force` because data durability outranks that
      // optimization: a node view can have a visible transaction even if an
      // edit-intent event was missed or an asynchronous callback is delayed.
      if (!force && !hasPendingRichFlush?.()) return lastMarkdownRef.current
      // Saves and source-mode switches can occur before Milkdown publishes its
      // delayed markdownUpdated callback. Serialize the current ProseMirror
      // document instead of reading Crepe's potentially stale cached snapshot.
      const canonical = canonicalForSource(serializeCurrentDocument())
      const scratch = generatedScratchRef?.current
      // Fresh documents keep an empty title/body scaffold in the live PM doc,
      // while canonicalForSource deliberately excludes it from persisted
      // Markdown. Compare scratch candidates with the document reconstructed
      // from that canonical source, not with internal editor-only nodes.
      const expectedDoc = scratch
        ? sourceCommitter.parse(canonical)
        : viewRef.current?.state.doc
      if (canonical === canonicalMarkdownRef.current) {
        const committed = sourceCommitter.commit({
          candidates: [lastMarkdownRef.current],
          expectedDoc,
          canonical,
          shouldPublish: false
        })
        if (!committed.ok) {
          if (Array.isArray(globalThis.__hmGateLog)) {
            globalThis.__hmGateLog.push({
              origin: 'flush-canonical-equality',
              candidate: lastMarkdownRef.current,
              canonical
            })
          }
          return null
        }
        return committed.markdown
      }
      const preserved = scratch
        ? {
            markdown: getGeneratedScratchMarkdown?.(canonical) || preserveGeneratedBulletMarkers(
              lastMarkdownRef.current,
              generatedScratchMarkdown(canonical)
            ),
            preserved: true,
            reason: 'generated-scratch-flush'
          }
        : preserveRichMarkdownSource(
            lastMarkdownRef.current,
            canonicalMarkdownRef.current,
            canonical
          )
      // Ambiguous mapping is an explicit failed transaction, not a committed
      // snapshot. Keep both the authored source and canonical baseline intact,
      // and leave the pending flag raised so a later callback/flush can retry
      // the cumulative delta. Returning null prevents source mode or save from
      // presenting the stale authored bytes as if the visible edit had synced.
      if (preserved.preserved === false) return null
      const committed = sourceCommitter.commit({
        candidates: scratch
          ? [preserved.markdown, canonicalSourceFallback(canonical)]
          : [preserved.markdown],
        expectedDoc,
        canonical,
        shouldPublish: false
      })
      // A mapper accepting the delta is not proof that its bytes reconstruct
      // the live editor. Parser failures and semantic mismatches fail closed.
      if (!committed.ok) {
        // Test-only opt-in diagnostics (same pattern as __hmPreserveLog).
        if (Array.isArray(globalThis.__hmGateLog)) {
          globalThis.__hmGateLog.push({
            origin: 'flush',
            reason: preserved.reason || 'unknown',
            candidate: preserved.markdown,
            canonical
          })
        }
        return null
      }
      return committed.markdown
    } catch (error) {
      // A silent null here is indistinguishable from a fail-closed mapping to
      // every caller; keep the error visible for diagnosis.
      console.error('flushMarkdown failed', error)
      if (Array.isArray(globalThis.__hmGateLog)) {
        globalThis.__hmGateLog.push({ origin: 'flush-exception', reason: String(error?.message || error) })
      }
      return null
    }
  }

  // Explicit exit from a fail-closed sync: rebuild the authored source from
  // the live document's canonical serialization. Authored spelling (markers,
  // escapes, spacing) is normalized, content is not — the rebuilt source is
  // the document the user currently sees, so both baselines realign and the
  // conflict state ends. Callers own the user consent for the normalization.
  const rebuildMarkdownFromRich = () => {
    if (isDestroyed?.() || !crepeRef.current) return null
    try {
      const canonical = canonicalForSource(serializeCurrentDocument())
      const rebuilt = generatedScratchMarkdown(canonical)
      // The rebuilt source must satisfy the same acceptance invariant as any
      // commit. The fallback keeps canonical escapes (un-escaping is what can
      // change semantics) but must still strip Crepe's internal empty-block
      // `<br />` placeholders — raw canonical bytes would write them into the
      // user's file, violating the source boundary invariant.
      const committed = sourceCommitter.commit({
        candidates: [rebuilt, canonicalSourceFallback(canonical)],
        expectedDoc: generatedScratchRef?.current
          ? sourceCommitter.parse(canonical)
          : viewRef.current?.state.doc,
        canonical,
        shouldPublish: false
      })
      if (!committed.ok) return null
      // A rebuild is a full baseline reset: every pending transaction intent
      // (paste snapshot, list conversion, input-rule markers) was captured
      // against the PREVIOUS baselines. Replaying one after the reset would
      // re-poison the fresh baselines, so the reset must be atomic.
      resetTransactionIntents?.()
      return committed.markdown
    } catch {
      return null
    }
  }

  const flushMarkdownSettled = (options = {}) => settleEditorMarkdown(flushMarkdown, options)

  const getRecoveryMarkdown = () => {
    if (isDestroyed?.() || !crepeRef.current) return null
    try {
      // This is deliberately NOT written over the authored file. It is a
      // normalized emergency copy of the live ProseMirror document, used only
      // after bounded retries still cannot prove a byte-preserving mapping.
      // Keeping it separate preserves both sides of the conflict: the original
      // source remains untouched and the user's visible edits are not trapped
      // solely in renderer memory.
      const canonical = canonicalForSource(serializeCurrentDocument())
      return sourceCommitter.select({
        candidates: [generatedScratchMarkdown(canonical), canonicalSourceFallback(canonical)],
        expectedDoc: generatedScratchRef?.current
          ? sourceCommitter.parse(canonical)
          : viewRef.current?.state.doc
      })
    } catch {
      return null
    }
  }

  const restoreMarkdownOffset = (rawOffset, follow = false) => {
    const v = viewRef.current
    if (!v || !crepeRef.current) return false
    try {
      const remark = crepe.editor.ctx.get(remarkCtx)
      const target = markdownOffsetToPmPos(lastMarkdownRef.current || '', rawOffset, v.state.doc, remark)
      const pos = typeof target === 'number' ? target : target?.pos
      if (!Number.isFinite(pos)) return false
      const size = v.state.doc.content.size
      const safePos = Math.max(1, Math.min(pos, size))
      const $pos = v.state.doc.resolve(safePos)
      const inCodeBlock = /code/i.test($pos.parent.type.name)
      let selection
      if (target?.atom) {
        try {
          selection = NodeSelection.create(v.state.doc, Math.max(0, Math.min(pos, size - 1)))
        } catch {
          selection = TextSelection.near($pos, 1)
        }
      } else {
        selection = TextSelection.near($pos)
      }
      const tr = v.state.tr.setSelection(selection)
      if (follow) tr.scrollIntoView()
      // A CodeMirror node view only forwards ProseMirror's selection while the
      // outer editor owns focus. Focusing after dispatch would steal focus back
      // and leave the inner caret outside the visible scroller.
      if (follow && inCodeBlock) v.focus()
      v.dispatch(tr)
      if (follow && inCodeBlock) {
        try {
          const scroller = v.dom.closest('.editor-scroll')
          const sr = scroller?.getBoundingClientRect()
          const domSelection = v.dom.ownerDocument.getSelection()
          const domRange = domSelection?.rangeCount ? domSelection.getRangeAt(0) : null
          const coords = domRange?.getBoundingClientRect()
          if (scroller && sr && coords && (coords.top < sr.top + 12 || coords.bottom > sr.bottom - 12)) {
            scroller.scrollTop += (coords.top + coords.bottom) / 2 - (sr.top + sr.bottom) / 2
          }
        } catch {
          // The repeated layout restore in App retries after CodeMirror paints.
        }
      } else if (follow) {
        v.focus()
      }
      return true
    } catch {
      return false
    }
  }

  const markdownOffsetFromSelection = () => {
    const v = viewRef.current
    if (!v || !crepeRef.current) return null
    try {
      let head = v.state.selection.head
      const sel = v.dom.ownerDocument.getSelection()
      if (sel && sel.rangeCount && sel.isCollapsed && v.dom.contains(sel.anchorNode)) {
        head = codeMirrorSelectionInfo(v, sel)?.pmPos ?? v.posAtDOM(sel.anchorNode, sel.anchorOffset)
      }
      const remark = crepe.editor.ctx.get(remarkCtx)
      return pmPosToMarkdownOffset(lastMarkdownRef.current || '', head, v.state.doc, remark)
    } catch {
      return null
    }
  }

  const markdownOffsetFromViewportTop = () => {
    const v = viewRef.current
    if (!v || !crepeRef.current) return null
    try {
      const scroller = v.dom.closest('.editor-scroll')
      if (!scroller) return null
      const rect = scroller.getBoundingClientRect()
      const doc = v.dom.ownerDocument
      const point = doc.caretPositionFromPoint?.(rect.left + rect.width / 2, rect.top + 8)
      if (!point || !v.dom.contains(point.offsetNode)) return null
      const pos = v.posAtDOM(point.offsetNode, point.offset)
      const remark = crepe.editor.ctx.get(remarkCtx)
      return pmPosToMarkdownOffset(lastMarkdownRef.current || '', pos, v.state.doc, remark)
    } catch {
      return null
    }
  }

  return {
    setBlock,
    getExportSource: getPdfSource,
    getPdfSource,
    getMarkdown,
    toggleHighlight,
    applyTextFormat,
    applyReviewMarkup,
    replaceMarkdown,
    flushMarkdown,
    flushMarkdownSettled,
    rebuildMarkdownFromRich,
    getRecoveryMarkdown,
    restoreMarkdownOffset,
    markdownOffsetFromSelection,
    markdownOffsetFromViewportTop
  }
}
