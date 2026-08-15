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
//     point PM-focused Mod-z uses, and ALWAYS returns true (swallowed) —
//     even when the kernel has nothing to undo/redo for the current
//     revision — so prosemirror-history's binding never runs.
//
// `EditorState.readOnly` only affects CM's OWN input paths (typing,
// keymap-bound commands) — CM6 still sets `contenteditable="true"` on
// `.cm-content` regardless of `readOnly` (only the separate `editable`
// facet controls that attribute; see @codemirror/view dist/index.js
// `updateAttrs()`), so a raw `view.dispatch(tr)` from an external caller is
// NOT rejected by `readOnly` alone. CM6's actual programmatic gate is
// `EditorState.changeFilter`, whose facet is defined with NO `combine`
// option (`Facet.define()` with no config), so its default combine keeps
// EVERY registered filter as a separate array entry — `filterTransaction`
// (@codemirror/state dist/index.js) iterates ALL of them and blocks the
// change the moment ANY filter returns false. No `Prec.highest` is needed
// there: this extension's `changeFilter` runs unconditionally alongside the
// nodeview's own `EditorState.changeFilter.of(() => this.view.editable)`.
import { keymap as cmKeymap } from '@codemirror/view'
import { EditorState as CmEditorState, Prec } from '@codemirror/state'

// `blocked()` gates the programmatic changeFilter. This task's fenced code
// blocks remain non-editable pairs end to end (no character-level decode
// contract in the projection map yet), so it defaults to "always blocked".
// A later task (per-language plain-text ownership) narrows this to a
// language-scoped decision without changing this module's contract.
export function createKernelCmExtensions({ runUndo, runRedo, blocked = () => true } = {}) {
  // Every handler returns true UNCONDITIONALLY — even when `runUndo`/
  // `runRedo` is missing, or the kernel call it makes is a no-op
  // (history-empty swallow) — a CM-focused Mod-z/Mod-y/Shift-Mod-z must
  // never fall through to the nodeview's own `codeMirrorKeymap()` entry
  // (prosemirror-history's undo/redo), which sits at the same default
  // precedence right after this one.
  const swallow = (run) => () => {
    if (typeof run === 'function') run()
    return true
  }
  return [
    Prec.highest(cmKeymap.of([
      { key: 'Mod-z', run: swallow(runUndo) },
      { key: 'Mod-y', run: swallow(runRedo) },
      { key: 'Shift-Mod-z', run: swallow(runRedo) }
    ])),
    // Prec.highest: see defect 1 above — without it, the nodeview's own
    // same-precedence, earlier-in-source-order readOnly extension wins and
    // this one is silently ignored.
    Prec.highest(CmEditorState.readOnly.of(true)),
    CmEditorState.changeFilter.of(() => !blocked())
  ]
}
