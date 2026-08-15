// Kernel-mode CodeMirror bridge (source-kernel integration Plan 3, Task 1).
//
// Two LIVE defects on the kernel-mode branch, both reachable today (a
// bare `js` fenced code block shows its CodeMirror editor immediately —
// only a block with a `renderPreview` substitution, i.e. Mermaid, starts in
// preview mode via `previewOnlyByDefault`):
//
//  1. Fake read-only. `editor-crepe-setup.js` used to append a bare
//     `CmEditorState.readOnly.of(true)` to the CodeMirror feature's
//     `extensions` array. Milkdown's CodeMirrorBlock nodeview
//     (@milkdown/components code-block/index.js `initializeCodeMirror()`)
//     ALSO registers its own `readOnlyConf.of(EditorState.readOnly.of(!this.view.editable))`
//     — FIRST in ITS OWN extensions array, at the same (default) precedence
//     as ours. CM6's `EditorState.readOnly` facet is defined with
//     `combine: values => values.length ? values[0] : false`
//     (@codemirror/state dist/index.js) — it keeps only the
//     HIGHEST-precedence value, and ties break by source order, so the
//     nodeview's own facet (index 0, `!view.editable` — false while the PM
//     view stays editable, which it does in kernel mode outside code
//     blocks) always won. `Prec.highest(...)` makes ours outrank the
//     nodeview's regardless of source order — the documented CM6 way to
//     override a default-precedence extension.
//  2. No undo bridge. The nodeview's own `codeMirrorKeymap()` binds
//     Mod-z/Shift-Mod-z/Mod-y directly to `@milkdown/prose/history`'s
//     `undo`/`redo` (prosemirror-history) at default precedence, and the
//     nodeview's `stopEvent()` returns true for CM-originated events, so a
//     PM-level keymap (including the kernel's own `historyKeymap()` in
//     editor-kernel-mode.js) never sees a CM-focused Mod-z. In kernel mode
//     the source kernel is the SOLE undo authority; letting
//     prosemirror-history run from a CM-focused keystroke could replay (or
//     revert) a step the kernel never recorded, desyncing kernel.doc.text
//     from whatever the PM view ends up showing. A `Prec.highest` CM keymap
//     routes Mod-z/Mod-y/Shift-Mod-z into the SAME kernel history entry
//     point PM-focused Mod-z uses, and returns true (swallowed) whenever
//     kernel mode is active — even when the kernel has nothing to undo/redo
//     for the current revision — so prosemirror-history's binding never
//     runs while the kernel owns the document.
//
// Why there is NO `EditorState.changeFilter` here (a first version of this
// module added one as a "belt and suspenders" programmatic-dispatch gate —
// reviewed and reverted): the CodeMirrorBlock nodeview's OWN sync path,
// `update(node)` (@milkdown/components code-block/index.js), re-projects a
// kernel-driven PM change into CM by calling `this.cm.dispatch({ changes:
// ... })` with NO `filter: false` on that dispatch. `EditorState.changeFilter`
// has no `combine` option (`Facet.define()` with no config), so its default
// combine keeps EVERY registered filter as a separate array entry, and
// `filterTransaction` (@codemirror/state dist/index.js) ANDs all of them —
// there is no way for one changeFilter extension to exempt "changes that
// came from PM" from another's blanket `() => false`. A blanket changeFilter
// here silently ate that dispatch too: after an out-of-band kernel edit
// (e.g. editing the same code block's text via the source-mode textarea,
// then switching back to rich), the nodeview's `update()` would be called,
// compute a real diff, dispatch it — and CM6 would silently drop it,
// leaving `.cm-content` showing stale text forever (kernel.doc.text was
// correct; only the DOM projection was wrong, and the eager-mount
// convention in editor-codeblock-eager.js means the nodeview never remounts
// to pick it up). `Prec.highest(readOnly.of(true))` alone is sufficient
// blocking coverage: CM6's own `@codemirror/commands` bindings early-exit on
// `state.readOnly` (drawSelection/history/indent/etc., 13 call sites) and
// every DOM input path (typing, paste, drop, cut, IME) is gated by the same
// facet (@codemirror/view dist/index.js control-input handlers) — the only
// PROGRAMMATIC writer left is our OWN `tabAtCursorKeymap`
// (editor-codeblock-tab.js), which now correctly checks
// `view.state.readOnly` itself. `EditorState.readOnly` does not touch
// `contenteditable` (a separate `editable` facet controls that DOM
// attribute; see @codemirror/view dist/index.js `updateAttrs()`), but that
// only affects focus/selection, never whether a change is accepted.
import { keymap as cmKeymap } from '@codemirror/view'
import { EditorState as CmEditorState, Prec } from '@codemirror/state'

// `isActive()` is the CM-bridge's degraded-fallback gate — the SAME
// `!inactive()` the controller's own PM-focused handlers gate on
// (editor-kernel-mode.js `isActive`). Before the kernel attaches, while
// degraded (an unmappable document reverted to complete legacy editing), or
// after dispose, the kernel owns nothing: a CM-focused Mod-z must fall
// through to the nodeview's own `codeMirrorKeymap()` (prosemirror-history)
// instead of calling into a controller that has no document to undo —
// the same legacy-delegation convention `legacy()`/`attachLegacyApi` use
// for the rest of the API surface. Defaults to always-active so a caller
// that omits it (e.g. a future direct unit test) gets today's behavior.
//
// NOTE (deferred, already adjudicated in Plan 2's final review): the
// `Prec.highest(readOnly.of(true))` extension below is STATIC — it does not
// itself turn off in degraded mode, so a degraded tab's code blocks stay
// visually read-only even though `isActive()` correctly lets Mod-z fall
// through to legacy undo. That mismatch (read-only stays; undo doesn't) is
// a known, accepted limitation of the current degrade path, not something
// this task re-opens.
export function createKernelCmExtensions({ runUndo, runRedo, isActive } = {}) {
  const active = typeof isActive === 'function' ? isActive : () => true
  // Returns true (swallowed, kernel handles it) while active; false
  // (fall through to the nodeview's own prosemirror-history binding) once
  // degraded/disposed/not-yet-attached.
  const bridge = (run) => () => {
    if (!active()) return false
    if (typeof run === 'function') run()
    return true
  }
  return [
    Prec.highest(cmKeymap.of([
      { key: 'Mod-z', run: bridge(runUndo) },
      { key: 'Mod-y', run: bridge(runRedo) },
      { key: 'Shift-Mod-z', run: bridge(runRedo) }
    ])),
    // Prec.highest: see defect 1 above — without it, the nodeview's own
    // same-precedence, earlier-in-source-order readOnly extension wins and
    // this one is silently ignored.
    Prec.highest(CmEditorState.readOnly.of(true))
  ]
}
