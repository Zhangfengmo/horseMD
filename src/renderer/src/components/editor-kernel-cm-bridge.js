// Kernel-mode CodeMirror bridge (source-kernel integration Plan 3: Task 1
// created it as a blanket read-only + undo bridge; Task 5 replaced the
// blanket `Prec.highest(readOnly.of(true))` with a PER-BLOCK dynamic gate so
// LF fenced code blocks with a proven charMap become genuinely editable
// while mermaid/latex/math and non-LF blocks stay blocked).
//
// WHY the gate is event-time callbacks and not a readOnly facet: CM
// extensions from a Crepe featureConfig are ONE static array shared by every
// code-block nodeview instance — `EditorState.readOnly` (a per-state facet)
// cannot express "this instance yes, that instance no" without per-instance
// reconfiguration machinery (Compartment effects dispatched per view), and
// any state-held editability flag is STALE in exactly the window that
// matters most: a `js -> mermaid` language switch flips the projection
// map's charMap to null synchronously at commit time, but the CM instance
// only sees a transaction later (the async language load reconfigure) — a
// keystroke in that window would be accepted by a state-held flag, then
// vetoed PM-side, leaving CM's DOM/state showing text the kernel never
// owned. The injected `isEditable(cmView)` callback consults the CURRENT
// projection map at each event (editor-kernel-mode.js `isCmBlockEditable`:
// pmView.posAtDOM(cmView.dom) -> blockPairs -> charMap !== null), so there
// is no staleness window at all, and a missing/failed lookup blocks
// (fail-closed).
//
// Input-path coverage for a BLOCKED (non-editable) block — each entry names
// the @codemirror/view funnel it closes (all verified in the vendored
// dist/index.js):
//  1. Typing / IME / autocorrect / EditContext — every DOM-mutation path
//     funnels through `applyDOMChangeInner`, which consults
//     `EditorView.inputHandler` BEFORE dispatching (dist/index.js:4322);
//     a handler returning true drops the change, and the observer flush
//     then self-heals the mutated DOM ("The view wasn't updated but
//     DOM/selection changes were seen. Reset the view." — :7412-7414).
//  2. paste / drop / cut — these DISPATCH DIRECTLY without consulting
//     inputHandler (doPaste :4889, dropText :5050, cut :5157; their only
//     built-in guard is `state.readOnly`, which this module no longer
//     sets), so each gets a `Prec.highest` domEventHandler that swallows
//     the event (returning true => preventDefault + built-in handler
//     skipped, :4536-4542). `copy` stays untouched.
//  3. Editing keys — Crepe's code-mirror feature ships the FULL
//     `defaultKeymap.concat(indentWithTab)` (@milkdown/crepe
//     feature/code-mirror), whose doc-changing bindings go far beyond
//     Backspace/Delete/Enter/Tab (moveLine, copyLine, deleteLine,
//     transposeChars, toggleComment, indentMore/Less, …). Enumerating them
//     is a version-coupled blocklist, so the keydown gate is an ALLOWLIST
//     instead: ALL keymaps run inside one shared keydown handler registered
//     at `Prec.default` (dist/index.js:9013 `handleKeyEvents`), so this
//     module's `Prec.highest` domEventHandlers keydown runs strictly
//     before every keymap binding and can refuse anything not provably
//     non-mutating (navigation/selection/copy/escape + the combos the
//     kernel keymap below owns). Blocking a keydown preventDefaults it,
//     which also stops the browser's default text insertion; IME keydowns
//     (keyCode 229 / isComposing) pass through because preventDefault
//     cannot reliably stop a composition — funnel 1 is their backstop.
//  4. `beforeinput` — belt-and-suspenders preventDefault where the browser
//     honors it (composition insertions are non-cancelable; funnel 1 again).
// Programmatic dispatches (the nodeview's own `update(node)` PM->CM resync,
// `setSelection`, language reconfigure) touch NONE of these surfaces —
// exactly the property whose violation got the Plan-2 changeFilter reverted
// (a blanket `EditorState.changeFilter` also ate the nodeview's resync
// dispatch and froze `.cm-content`; see that ADR in the git history of this
// file). This design needs no changeFilter and no transactionFilter.
//
// Undo bridge (Task 1, unchanged): the nodeview's own `codeMirrorKeymap()`
// binds Mod-z/Shift-Mod-z/Mod-y to prosemirror-history and `stopEvent()`
// swallows CM-originated events before PM keymaps see them; in kernel mode
// the source kernel is the SOLE undo authority, so a `Prec.highest` CM
// keymap routes them into the SAME `runHistory` entry point PM-focused
// Mod-z uses and returns true (swallowed) whenever kernel mode is active.
// Mod-Enter (Task 5) follows the same shape: the nodeview binds it to PM's
// `exitCode` (a structural transaction the kernel would veto), so while
// active it is ALWAYS swallowed and routed to the kernel's own
// `runExitCode` (editor-kernel-mode.js -> commands/code-exit.js), which
// writes the exit bytes source-first; when degraded/detached it falls
// through to the nodeview's own binding (legacy behavior), same convention
// as the undo bridge.
import { keymap as cmKeymap, EditorView as CmEditorView } from '@codemirror/view'
import { Prec } from '@codemirror/state'

// Keys that are provably non-mutating for a blocked block (pure caret/
// selection movement, copy, escape) or that the kernel keymap above this
// gate explicitly owns (undo/redo/exit). Everything else is refused while
// the block is non-editable. The nodeview's arrow-escape keymap
// (`maybeEscape`) needs the arrows; Mod-c/Mod-a keep copy flows alive;
// modifier keydowns themselves must never be eaten or held-modifier
// shortcuts break.
const NAV_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'ContextMenu'
])
const MODIFIER_KEYS = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock',
  'AltGraph', 'Fn', 'FnLock', 'Dead'
])
const MOD_COMBO_ALLOW = new Set(['c', 'a', 'z', 'y'])

// Pure decision for a keydown reaching a BLOCKED (non-editable) code block:
// 'pass' lets the event continue to CM's keymaps/default handling, 'block'
// swallows it (preventDefault). Exported for headless tests — the caller
// only consults it when the kernel is active AND the block is not editable.
export function classifyBlockedCmKeydown(event) {
  if (!event) return 'block'
  if (event.isComposing || event.keyCode === 229) return 'pass' // IME: inputHandler backstops
  const key = String(event.key ?? '')
  if (MODIFIER_KEYS.has(key)) return 'pass'
  if (NAV_KEYS.has(key)) return 'pass'
  if (/^F\d{1,2}$/.test(key)) return 'pass' // function keys: never text-mutating here
  if (event.ctrlKey || event.metaKey) {
    if (key === 'Enter') return 'pass' // kernel exit-code keymap owns it
    if (MOD_COMBO_ALLOW.has(key.toLowerCase())) return 'pass' // copy/select-all/kernel undo-redo
    return 'block' // paste/cut/comment/indent/moveLine/… — refuse
  }
  return 'block' // printable chars, Enter, Backspace, Delete, Tab, …
}

// `isActive()` is the CM-bridge's degraded-fallback gate — the SAME
// `!inactive()` the controller's own PM-focused handlers gate on
// (editor-kernel-mode.js `isActive`). Before the kernel attaches, while
// degraded (an unmappable document reverted to complete legacy editing), or
// after dispose, the kernel owns nothing: every gate here turns OFF (events
// pass, keys fall through to the nodeview's own bindings) — the same
// legacy-delegation convention `legacy()`/`attachLegacyApi` use for the
// rest of the API surface. This also retires the Plan-2 "degraded tabs keep
// read-only code blocks" limitation: the old STATIC readOnly extension
// could not turn itself off in degraded mode; the dynamic gate simply
// deactivates with `isActive()`.
//
// `isEditable(cmView)` decides per-block editability at event time; when it
// is omitted (a legacy caller/unit test) the gate treats every block as
// editable, which combined with the default always-active `isActive` yields
// "no blocking, kernel undo bridge only".
export function createKernelCmExtensions({ runUndo, runRedo, runExitCode, isActive, isEditable } = {}) {
  const active = typeof isActive === 'function' ? isActive : () => true
  const editable = typeof isEditable === 'function' ? isEditable : () => true
  // True when the kernel owns the document AND this specific CM instance's
  // block has no proven charMap: every mutating input surface below must
  // refuse. Evaluated fresh at EVERY event — see the header for why.
  const blocked = (view) => active() && !editable(view)
  // Returns true (swallowed, kernel handles it) while active; false
  // (fall through to the nodeview's own binding) once degraded/disposed/
  // not-yet-attached.
  const bridge = (run) => (view) => {
    if (!active()) return false
    if (typeof run === 'function') run(view)
    return true
  }
  return [
    Prec.highest(cmKeymap.of([
      { key: 'Mod-z', run: bridge(runUndo) },
      { key: 'Mod-y', run: bridge(runRedo) },
      { key: 'Shift-Mod-z', run: bridge(runRedo) },
      // Swallowed while active even on failure: PM's exitCode (the
      // nodeview's own Mod-Enter binding) must never produce a structural
      // transaction in kernel mode — the kernel command either writes the
      // exit bytes or notifies why it refused.
      { key: 'Mod-Enter', run: bridge(runExitCode) }
    ])),
    // Prec.highest: must run BEFORE the shared Prec.default keymap keydown
    // handler (funnel 3) and before the built-in paste/drop/cut handlers
    // (funnel 2).
    Prec.highest(CmEditorView.domEventHandlers({
      keydown: (event, view) =>
        blocked(view) && classifyBlockedCmKeydown(event) === 'block',
      paste: (event, view) => blocked(view),
      drop: (event, view) => blocked(view),
      cut: (event, view) => blocked(view),
      beforeinput: (event, view) => blocked(view)
    })),
    // Funnel 1: the single choke point for every DOM-mutation input path.
    CmEditorView.inputHandler.of((view) => blocked(view))
  ]
}
