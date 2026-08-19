// Gateway: pure classification of ProseMirror transactions + commits (plain
// text, task-checkbox toggle, code-block language switch) into the source
// kernel (kernel-mode integration Plan 2 Task 3, extended by Plan 3 Task 4).
//
// This module imports NOTHING from electron/react/@milkdown — only
// `../lib/source-kernel` (KERNEL_CODES, applySourceTransaction, the pure
// command functions) and plain ProseMirror step/model objects passed in by
// the caller. It does not talk to a live EditorView, does not read
// `crepe.*`, and does not dispatch anything itself; the Editor-side wiring
// (Task 5) is the only place that calls into a live view.
//
// classifyTransactions() re-derives the same "is this a plain,
// single-textblock edit" guard that src/renderer/src/lib/source-transaction-sync.js
// (:158-260) used for its legacy raw-text-matching path (relaxed for marked
// textblocks since P4-3.5 and for textblocks carrying inline ATOMS since P6-1
// — see textblockProfile below; the legacy file keeps its own stricter copy),
// but reimplements it
// directly against PM Step/Node objects — it deliberately does NOT reuse
// that file's text-search/blockHints machinery (that belongs to the legacy
// fallback, not the kernel path). Where the two diverge: the legacy path had
// to grep the raw Markdown for a matching slot because it had no proven
// position map; this gateway has one (`buildProjectionMap`'s `pmPosToRaw`,
// Task 1) and defers all raw-coordinate work to `commitPlainText`.
import { KERNEL_CODES, applySourceTransaction, buildSyntaxIndex, parseKernelMarkdown, bisectsLineEnding, toggleTaskMarker, changeCodeLanguage, setImageAttrs, applyLinkEdit, insertHeadingLeadingWhitespace, looksLikeAtxContentStart, spellBlockTailInsert, literalTailIsStripped, healableTrailingSpace, spellEmptyCodeInsert, EMPTY_VERBATIM_BLOCK_TYPES, spellBlockTailDelete, proveContentDelete, deleteClearsBlockLine, proveBatchDelete } from '../lib/source-kernel/index.js'

// A step's slice counts as "plain text" only if it is exactly a run of
// unmarked text nodes with no open ends (no partial node straddling the
// slice boundary) and no line breaks (a hardbreak/newline inside the slice
// is structural content the raw kernel commands own, not a byte-for-byte
// text edit) — UNLESS the slice targets a `code_block` textblock
// (`allowNewline`, Plan 3 Task 4): CodeMirror's own `forwardUpdate` (the
// bridge that mirrors a CM6 edit into the PM `code_block` node) issues plain
// `ReplaceStep`s whose inserted text carries a bare `'\n'` for a multi-line
// CM edit — there is no separate hardbreak node inside a code block's `text*`
// content model, the newline IS the text. `commitPlainText` below is what
// turns each such break into the raw bytes (line ending + the block's own
// per-line prefix) this actually has to become on disk. A '\r' IS accepted
// under `allowNewline` (2026-08-17, CRLF un-narrowing): the CRLF bridge
// patch (`editor-codeblock-crlf.js`) rewrites every break CM inserts into
// the block's own dominant ending BEFORE the ReplaceStep is built, so a
// CRLF/lone-CR block's slice legitimately carries '\r\n'/'\r'. Refusing it
// here made every such block permanently unwritable. `commitPlainText`
// below still proves, per break, that its spelling matches the raw source's
// own `charMap.lineEnding` — a mismatch is refused there, so nothing
// unproven gets through. Mirrors source-transaction-sync.js's
// `plainSliceText` (:22-36) but is redefined here so this module has no
// dependency on that file's raw-matching helpers.
const plainSliceText = (slice, { allowNewline = false } = {}) => {
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
  if (!valid) return null
  if (allowNewline) return text
  if (/[\r\n]/.test(text)) return null
  return text
}

// Inline atoms the plain-text path may type AROUND (P6 Task 1). An ALLOWLIST,
// not a denylist: an inline node type nobody probed must fail closed, and the
// kernel's own `ATOMS` set (lib/source-kernel/character-map.js) is what
// decides which shapes get a width-1 `atom` unit on the raw side — this list
// is its ProseMirror-side counterpart and must never grow past it.
//
// Names are the LIVE schema's, probed 2026-08-17, not guessed:
//   'image'             @milkdown/preset-commonmark $nodeSchema("image")
//   'html'              @milkdown/preset-commonmark $nodeSchema("html")
//   'math_inline'       @milkdown/crepe latex feature (inline TeX in attrs)
//   'footnote_reference' @milkdown/preset-gfm $nodeSchema("footnote_reference")
//   'hardbreak'         @milkdown/preset-commonmark $nodeSchema("hardbreak")
//   'hard_break'        NOT a live node name — the spelling older fixtures in
//                       this repo use. Listed so a schema that registers it
//                       under that name behaves identically; it can never
//                       match the shipped schema.
//
// THE HARD BREAK WAS THE ONE REFUSED ATOM UNTIL 2026-08-18, and the reason it
// is now admitted is a fix in the character map, NOT a relaxation here. The
// original refusal was correct on its own evidence: every other atom's raw
// span sits INSIDE one line and its two visible boundaries resolve to the same
// byte through all three charMap resolvers, while a hard break's span stopped
// at the LINE ENDING —
//
//   'a  \n  b'    text[0,1) break[1,4) text[6,7)
//   '> a  \n> b'  text[2,3) break[3,6) text[8,9)
//
// — leaving the next line's continuation prefix ('  ', '> ') in no unit at
// all. The insert boundary just after the break then resolved to the PRE-gap
// offset, so typing there committed '> a  \nX> b': the quote marker demoted to
// paragraph text. The comment that stood here also named the fix it was not
// taking: a SOFT break has no such hole because `consumeSoftBreak` folds the
// continuation prefix into its `linebreak` unit.
//
// character-map.js's `hardBreakUnitEnd` now does exactly that for the hard
// break, and PROVES the fold rather than consuming greedily — the unit may
// only extend to the NEXT SIBLING's own start offset, and every byte in
// between must be a continuation-prefix character. The units therefore tile
// the block contiguously across a hard break, exactly as they do across a soft
// one, and all three resolvers agree on ONE offset at each of the break's two
// boundaries (pinned in scripts/test-source-kernel-charmap.mjs and, on real
// bytes, in this module's own tests). The two shapes that cannot be proven
// (a break at the very end of a container's children with prefix bytes after
// it; a break whose span does not end at a line terminator) return `null` from
// `buildCharacterMap`, so their block degrades to read-only and every commit
// into it fails closed with UNMAPPED — the same fail-closed exit every other
// unprovable block takes, rather than a special case here.
const TYPABLE_INLINE_ATOMS = new Set([
  'image', 'html', 'math_inline', 'footnote_reference', 'hardbreak', 'hard_break'
])

// Textblock inline profile (P4-3.5, Fix B; atom relaxation P6 Task 1 — both
// replace the old blanket `isPlainTextblock` refusal). A textblock qualifies
// for the plain-text path when every inline child is either TEXT (marked or
// not) or one of the probed inline ATOMS above.
//
// Marks stopped disqualifying the block in P4-3.5: after P4-3 made mark
// toggles real, "bold a word, then type anywhere in that paragraph" refused
// every keystroke with a toast. The relaxation lets the plain parts of a
// marked paragraph type normally while two guards keep the byte contract
// closed:
//  1. the inserted slice itself must still be PLAIN (`plainSliceText` above)
//     — typing INSIDE a mark run inherits the mark, so the storedMarks/
//     mark-inheritance trap stays refused;
//  2. a DELETION/replacement range must not partially overlap any marked
//     run (`stepRespectsMarkedRuns` below) — a range crossing INTO a run
//     would delete content while stranding its delimiters ('a **' — the
//     P4-2 probed corruption shape).
//
// P6-1 is the SAME shape one level out: admission relaxed, proof tightened
// per step. A paragraph carrying an inline image / formula / HTML fragment
// used to be untypable in its ENTIRETY (the largest coverage hole blocking
// kernel mode from becoming the default); now it types everywhere except
// PARTLY across an atom, guarded by:
//  3. no step may PARTIALLY overlap an atom, and any atom a step swallows
//     WHOLE must be unmarked (`stepRespectsAtoms` below), with the raw half
//     of that same contract re-proved on the bytes in `commitPlainText`
//     (`rangeSplitsAtomUnit`).
// The byte contract at the atom's own edges was probed, not assumed: for
// 'a![x](y.png)b' the units are char[0,1) atom[1,12) char[12,13), and BOTH
// atom boundaries resolve to a single byte through all three resolvers
// (`visibleToRaw` / `rawStartForVisible` / `rawNeutralInsert` — vis 1 -> 1,
// vis 2 -> 12), so an insert on either edge is byte-exact. Inline math
// ('a$x^2$b' -> atom[1,6)), a coalesced inline-HTML run ('a<span>q</span>b'
// -> ONE atom[1,15)) and a footnote reference ('a[^1]b' -> atom[1,5)) probe
// identically on the raw side. Note that admission alone is never the proof:
// the block must ALSO have survived `buildProjectionMap`'s `content.size ===
// charMap.visibleLength` check, or its pair carries `charMap: null` and every
// commit into it fails closed with UNMAPPED (pinned by the gateway tests).
const textblockProfile = (node) => {
  if (!node?.isTextblock) return null
  let admissible = true
  let hasMarkedRun = false
  let hasAtom = false
  node.forEach((child) => {
    if (child?.isText) {
      if (child.marks && child.marks.length) hasMarkedRun = true
      return
    }
    if (child?.type?.name && TYPABLE_INLINE_ATOMS.has(child.type.name)) {
      hasAtom = true
      return
    }
    admissible = false
  })
  return admissible ? { hasMarkedRun, hasAtom } : null
}

// Exported for editor-kernel-mode.js's `getKernelStatus` (2026-08-18). The
// status indicator's job is to answer "can the user type here?", and a block
// can be untypable for TWO independent reasons: the projection map refused it
// a character map, or THIS module refuses its inline shape. Counting only the
// first produced a false "全部就绪" for a document whose paragraph the gateway
// blocked at every keystroke — the hard-break shape was exactly that, and the
// indicator must not depend on nobody ever adding another one. Same function
// the dispatch path uses, so the badge cannot disagree with the toast.
export const isTypableTextblock = (node) => !!node?.isTextblock && textblockProfile(node) !== null

// Guard 2 of the relaxation above: for a range step [from, to) inside a
// textblock that carries marked runs, every marked run the range INTERSECTS
// must be either fully contained IN the range with room on BOTH sides
// (`from < runFrom && to > runTo` — the raw range then provably covers the
// run's delimiters too, via the gap-aware from/to resolvers) or fully
// containing the range (`from >= runFrom && to <= runTo` — a pure content
// edit inside one run; deleting a run's EXACT content leaves empty
// delimiters '****', the pinned byte-consistent P4-2 outcome). An exact-edge
// straddle (range starting/ending precisely ON a run boundary while crossing
// the other side) resolves its raw offsets INSIDE the delimiters on one
// side only — orphaning them — and is refused.
const stepRespectsMarkedRuns = (parent, blockContentStart, from, to) => {
  let offset = blockContentStart
  let ok = true
  parent.forEach((child) => {
    const runFrom = offset
    const runTo = offset + child.nodeSize
    offset = runTo
    if (!child.isText || !child.marks || !child.marks.length) return
    if (to <= runFrom || from >= runTo) return // no intersection
    const insideRun = from >= runFrom && to <= runTo
    const containsRun = from < runFrom && to > runTo
    if (!insideRun && !containsRun) ok = false
  })
  return ok
}

// Guard 3 of the relaxation above (P6 Task 1, widened by P6 Task 1b to admit
// WHOLE-atom deletion): a step's range [from, to) may not PARTIALLY overlap an
// inline atom in the textblock; an atom the range swallows entirely is allowed
// through, provided it carries no marks (see WHOLE-ATOM RULE below). Same walk
// shape as `stepRespectsMarkedRuns` — the parent's children in PM coordinates,
// starting at the block's content position — deliberately, so the two guards
// cannot drift apart in how they enumerate a textblock.
//
// THE BOUNDARY RULE, stated explicitly because it is the one genuinely
// ambiguous case: an insert exactly AT an atom's edge is ALLOWED, on BOTH
// sides. It was decided by probe, not preference — at an atom's left edge all
// three charMap resolvers return the atom's own `rawStart`, and at its right
// edge all three return its `rawEnd`, so the inserted bytes provably land
// OUTSIDE the atom's markdown syntax on the side the caret was on. (This
// matches the charMap's standing "the front unit's end" boundary convention:
// for an atom the front unit's end IS the atom's rawEnd, and the following
// unit's rawStart is the same offset — there is no gap to be ambiguous about.)
// Concretely: 'a![x](y.png)b' + 'X' at the left edge commits
// 'aX![x](y.png)b', and at the right edge 'a![x](y.png)Xb'.
//
// THE WHOLE-ATOM RULE (P6 Task 1b). "Select an image and press Backspace" is
// a high-frequency operation, and it IS byte-provable: for 'a![x](y.png)b' the
// image occupies PM [2,3), whose ends resolve through `pmPosToRawStart(2) = 1`
// and `pmPosToRaw(3) = 12` — exactly the atom unit's own [1,12) span, i.e. the
// `![x](y.png)` bytes and nothing else. The same holds for a range that
// swallows an atom together with neighbouring TEXT (both ends then resolve
// inside text units, and the atom's bytes sit strictly between them). So a
// range that CONTAINS an atom is admitted; only a PARTIAL overlap stays
// refused.
//
// Two conditions keep that admission honest:
//  a) the swallowed atom must carry NO MARKS. `stepRespectsMarkedRuns` walks
//     TEXT children only, so a linked image ('a[![x](y.png)](url)b') is
//     invisible to it — deleting the atom alone would resolve to the image's
//     bytes and strand the link's own '[' and '](url)' delimiters, the exact
//     P4-2 orphaned-delimiter corruption. Refused here rather than widening
//     the marked-run walk, which would change a proof that is currently green.
//  b) the raw range the map actually resolves must be re-checked against the
//     charMap's own atom units before any bytes are written — see
//     `rangeSplitsAtomUnit` in `commitPlainText`. The PM-side containment
//     above is a statement about the PROJECTION; the byte contract is a
//     statement about the SOURCE, and this file proves both rather than
//     inferring one from the other.
//
// So only these are refused:
//  - a ZERO-WIDTH insert strictly INSIDE an atom (`atomFrom < from < atomTo`).
//    Unreachable for today's atoms — every one of them is a PM leaf of
//    nodeSize 1, so no position exists between its two edges — but written
//    for the range rather than for the constant so an inline node with
//    content could never slip through unproven.
//  - a NON-EMPTY range that overlaps an atom only PARTIALLY. Also
//    unrepresentable for a nodeSize-1 leaf (any range meeting it must contain
//    it), and likewise written for the general case so a future inline node
//    with content cannot slip through: half of such a node's raw syntax would
//    survive the delete.
//  - a NON-EMPTY range containing a MARKED atom (condition (a)).
const stepRespectsAtoms = (parent, blockContentStart, from, to) => {
  let offset = blockContentStart
  let ok = true
  parent.forEach((child) => {
    const atomFrom = offset
    const atomTo = offset + child.nodeSize
    offset = atomTo
    if (child.isText) return
    if (from === to) {
      if (from > atomFrom && from < atomTo) ok = false
      return
    }
    if (to <= atomFrom || from >= atomTo) return // disjoint
    if (from > atomFrom || to < atomTo) ok = false // partial overlap
    else if (child.marks && child.marks.length) ok = false // marked atom
  })
  return ok
}

// The RAW half of the whole-atom contract (condition (b) above). Given the
// offsets `commitPlainText` actually resolved for a step, every `atom` unit in
// the block's character map must be either fully OUTSIDE [from, to) or fully
// INSIDE it. An atom whose bytes are only partly covered would leave a
// fragment of its markdown syntax behind ('![x](y.pn'), which reparses as
// something else entirely.
//
// This runs for EVERY non-virtual step, not only atom-bearing ones: it is an
// invariant of the resolved range, and stating it universally means a future
// resolver change cannot quietly reintroduce a split atom in a path nobody
// thought to guard. It is a no-op for the shapes that were already accepted
// (a block with no atom units has nothing to check, and the boundary tables
// resolve a text-only range to offsets that stop at an adjacent atom's edge).
// Maps without a `units` array (`virtualCharMap`, hand-built test maps) carry
// no atom units and answer `false`, matching `bisectsLineEnding`'s posture.
const rangeSplitsAtomUnit = (charMap, from, to) => {
  const units = charMap?.units
  if (!Array.isArray(units)) return false
  for (const unit of units) {
    if (unit?.kind !== 'atom') continue
    if (unit.rawEnd <= from || unit.rawStart >= to) continue // disjoint
    if (unit.rawStart >= from && unit.rawEnd <= to) continue // fully covered
    return true
  }
  return false
}

// Exported for `scripts/test-kernel-gateway.mjs` ONLY. Both guards above are
// written for the general case — an inline node WITH CONTENT, which no node in
// today's schema is (every inline atom is a nodeSize-1 leaf, so a partial
// overlap is unrepresentable through a real transaction). The partial-overlap
// rule is therefore only assertable by calling them directly; leaving it
// untested because "it can't happen yet" is how a guard rots into a comment.
export const __atomGuards = { stepRespectsAtoms, rangeSplitsAtomUnit }

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
      if (!$from.sameParent($to)) return null
      const profile = textblockProfile($from.parent)
      if (!profile) return null
      if (profile.hasMarkedRun && step.from < step.to &&
          !stepRespectsMarkedRuns($from.parent, $from.start(), step.from, step.to)) {
        return null
      }
      // Unlike the marked-run guard, this one runs for ZERO-WIDTH steps too:
      // a bare caret insert is exactly the case whose "is this inside the
      // atom or at its edge?" answer the guard pins.
      if (profile.hasAtom &&
          !stepRespectsAtoms($from.parent, $from.start(), step.from, step.to)) {
        return null
      }
      const allowNewline = $from.parent.type?.name === 'code_block'
      const insertText = plainSliceText(step.slice, { allowNewline })
      if (insertText == null) return null
      steps.push({ from: step.from, to: step.to, insertText })
    }
  }
  return steps
}

// Detects the task-checkbox click shape: `@milkdown/components`'
// `listItemBlockView` (list-item-block/view.ts `setAttr`) toggles a task
// item's checked state with a bare `tr.setNodeAttribute(pos, 'checked', v)`
// — never through a keymap, so `structuralHandler`'s Enter/Tab/Backspace/
// Delete routing never sees it, and it is not a `ReplaceStep` so
// `extractPlainTextSteps` correctly refuses to treat it as plain text. Left
// unclassified, this batch fell through to `blocked`/`INPUT_TYPE` and the
// dispatch-veto channel silently discarded every checkbox click in kernel
// mode (the PM view was reverted, no error, no visible change — see
// docs/... kernel-mode task-toggle root cause). This function proves the
// batch is EXACTLY one `AttrStep` on a `checked` attribute of a `list_item`
// node, nothing else riding along; `commitTaskToggle` (below) re-derives the
// same shape independently rather than trusting a caller-supplied result,
// matching this file's other commit functions.
function extractTaskToggleStep(transactions, oldState) {
  const changed = transactions.filter((tr) => tr && tr.docChanged)
  if (changed.length !== 1) return null
  const tr = changed[0]
  if (!Array.isArray(tr.steps) || tr.steps.length !== 1) return null
  const step = tr.steps[0]
  if (step?.constructor?.name !== 'AttrStep' || step.attr !== 'checked') return null
  if (!Number.isFinite(step.pos)) return null
  const stepDoc = tr.docs?.[0] || oldState?.doc
  if (!stepDoc) return null
  let node
  try {
    node = stepDoc.nodeAt(step.pos)
  } catch {
    return null
  }
  if (!node || node.type?.name !== 'list_item') return null
  return { pos: step.pos }
}

// Detects the code-block language-switch AttrStep shape (Plan 3 Task 4): a
// language picker (the CM toolbar, wired in a later task) dispatches
// `tr.setNodeAttribute(pos, 'language', v)` on a `code_block` node — exactly
// like the checkbox click above, never through a keymap and never a
// `ReplaceStep`, so neither `structuralHandler` nor `extractPlainTextSteps`
// ever sees it. Proves the same shape `extractTaskToggleStep` proves for its
// own attribute (ONE transaction, ONE `AttrStep`, the right `attr` name, a
// PM node of the expected type at `step.pos`).
//
// BIDIRECTIONAL (final-review fix, 2026-08-16): a code_block whose CURRENT
// (pre-switch) language Crepe renders as a preview (mermaid/latex —
// `READONLY_CODE_LANGUAGES`, shared with editor-kernel-projection-map.js so
// the two stay in lockstep) is no longer refused here. The original refusal
// assumed there was "no raw anchor `commitCodeLanguage` could resolve its
// fence-rewrite offset from" for such a block — but `commitCodeLanguage`
// (below) already has a null-charMap fallback anchor (the pair's own
// `mdBlock.position.start.offset`, the fence's own start), which resolves a
// `changeCodeLanguage` offset just as well as a charMap-derived one: the
// command only needs an offset that `index.blockAt` resolves to the SAME
// code block, and the fence start always does. Refusing this direction was
// therefore a one-way door with no correctness reason behind it — a `js`
// block can freely become `mermaid` (this file always allowed that: the
// CURRENT language there is not readonly), but the reverse (`mermaid` ->
// `js`) was blocked. Lifting the guard makes the switch symmetric: once the
// switch commits, `editor-kernel-mode.js`'s `code-language` case
// unconditionally rebinds the projection map (see its own comment), so the
// pair's `charMap` is freshly (re-)evaluated against the NEW language and
// the block becomes genuinely editable immediately — the very next commit
// into it goes through the ordinary plain-text path.
function extractLanguageStep(transactions, oldState) {
  const changed = transactions.filter((tr) => tr && tr.docChanged)
  if (changed.length !== 1) return null
  const tr = changed[0]
  if (!Array.isArray(tr.steps) || tr.steps.length !== 1) return null
  const step = tr.steps[0]
  if (step?.constructor?.name !== 'AttrStep' || step.attr !== 'language') return null
  if (!Number.isFinite(step.pos)) return null
  const stepDoc = tr.docs?.[0] || oldState?.doc
  if (!stepDoc) return null
  let node
  try {
    node = stepDoc.nodeAt(step.pos)
  } catch {
    return null
  }
  if (!node || node.type?.name !== 'code_block') return null
  return { pmPos: step.pos, language: String(step.value ?? '') }
}

// Image attribute edits (Plan 5 Task 5). PM has TWO image nodes and both are
// ATOMS, so an attribute change is never a ReplaceStep — same AttrStep shape
// as the task checkbox and the code-block language picker above:
//   * `image-block` (@milkdown/components image-block/index.js:564-580) —
//     upstream attrs `{src, caption, ratio}`, plus the `alt` attr THIS repo
//     adds (components/editor-image-markdown.js:20-65).
//   * `image` (@milkdown/preset-commonmark) — inline, attrs `{src, alt, title}`.
//
// WHAT THE REAL UI DISPATCHES (probed in @milkdown/components, not guessed —
// the only `setAttr(...)` call sites in either component):
//   image-block/index.js:400,410  setAttr('caption', …)  (caption editing)
//   image-block/index.js:436      setAttr('ratio',  …)   (resize handle)
//   image-block/index.js:545      setAttr('src',    …)   (the empty-image
//                                 ImageInput's "confirm link" button)
//   image-inline/index.js:257     setAttr('src',    …)   (same input, inline)
// There is NO UI in this app that dispatches `alt` or `title`. Those two are
// classified here anyway (the command is byte-provable for them and a future
// UI must not have to re-open the gateway), but see the task report: today
// only the `src` route is user-reachable.
//
// WHICH ATTRS REACH THE SOURCE — and which must not:
//   * `src`/`alt`/`title` map 1:1 onto `![alt](src "title")` and route to
//     `setImageAttrs`.
//   * `caption`/`ratio` are ProseMirror-side DISPLAY state. The one place
//     they touch Markdown is the historical ratio-in-alt convention in
//     components/editor-image-markdown.js (a genuinely resized image
//     serializes its ratio as a numeric `alt` and its caption as the
//     `title`), which this task must not change. They are therefore NOT
//     classified — the batch falls through to `blocked`/INPUT_TYPE exactly as
//     it did before this task (the dispatch veto refuses the edit and toasts,
//     rather than silently accepting a PM-only change that the next reparse
//     from the authoritative source would discard).
//   * An `image-block` currently in the RESIZED state (`isResizedImageBlock`
//     below — the serializer's own predicate, shared verbatim) is refused for
//     EVERY attr: in that state the raw `alt`/`title` slots are owned by the
//     ratio convention, so writing a user alt there would delete the
//     persisted resize. Fail closed instead. The refusal is enforced at BOTH
//     boundaries — here and again inside `commitImageAttrs`.
const IMAGE_SOURCE_ATTRS = new Set(['src', 'alt', 'title'])
const IMAGE_NODE_TYPES = new Set(['image-block', 'image'])

// The ratio-in-alt predicate, character-for-character the one the serializer
// branches on (components/editor-image-markdown.js:51 —
// `Number.isFinite(ratio) && ratio > 0 && Math.abs(ratio - 1) > 0.001`).
// Sharing ONE definition is the point: a guard that is merely "close to" the
// serializer's condition is a guard that disagrees with it somewhere. (The
// first version of this dropped the `ratio > 0` clause, which over-refused a
// ratio of 0 — safe, but not the claim the comment made.)
//
// Applied at BOTH boundaries — classification AND commit. See
// `commitImageAttrs` for why the commit side re-derives instead of trusting
// that classification already ran.
const isResizedImageBlock = (node) => {
  if (node?.type?.name !== 'image-block') return false
  const ratio = Number(node.attrs?.ratio)
  return Number.isFinite(ratio) && ratio > 0 && Math.abs(ratio - 1) > 0.001
}

function extractImageAttrStep(transactions, oldState) {
  const changed = transactions.filter((tr) => tr && tr.docChanged)
  if (changed.length !== 1) return null
  const tr = changed[0]
  if (!Array.isArray(tr.steps) || tr.steps.length !== 1) return null
  const step = tr.steps[0]
  if (step?.constructor?.name !== 'AttrStep') return null
  if (!IMAGE_SOURCE_ATTRS.has(step.attr)) return null
  if (!Number.isFinite(step.pos)) return null
  if (typeof step.value !== 'string') return null
  const stepDoc = tr.docs?.[0] || oldState?.doc
  if (!stepDoc) return null
  let node
  try {
    node = stepDoc.nodeAt(step.pos)
  } catch {
    return null
  }
  const typeName = node?.type?.name
  if (!typeName || !IMAGE_NODE_TYPES.has(typeName)) return null
  if (isResizedImageBlock(node)) return null
  return { pmPos: step.pos, blockImage: typeName === 'image-block', attr: step.attr, value: step.value }
}

// PM mark name -> kernel inline-mark kind (Plan 4 Task 3). Names probed from
// the LIVE schema sources, not guessed:
//  - @milkdown/preset-commonmark: $markSchema("strong") / $markSchema("emphasis")
//    / $markSchema("inlineCode") / $markSchema("link")
//  - @milkdown/preset-gfm: $markSchema("strike_through")
//  - editor-highlight.js: $markSchema('highlight') (attrs.color, default 'yellow')
// `link` is deliberately ABSENT: `[text](url)` needs the URL-input UI flow
// (plan Global Constraints) — a link toggle falls through to `blocked`/
// INPUT_TYPE. A highlight whose color is not 'yellow' is also refused at
// classification (see extractMarkToggle): only the pure `==text==` byte form
// is kernel-ownable — that is the form P5-3 taught the kernel chain to parse
// (lib/source-kernel/highlight-syntax.js), so a yellow toggle now COMMITS
// instead of being refused downstream by `requireMap`. Red/blue keep
// round-tripping as `<mark class="hm-hl-…">` inline HTML, which the kernel
// coalesces into ONE atom while ProseMirror holds an N-character marked run —
// a size disagreement that degrades the block to read-only (pinned in
// scripts/test-kernel-projection-map.mjs Case P3c). Supporting it would mean
// special-casing the SHARED inline-HTML run rule and teaching the toggle
// command to write tag bytes; explicitly out of scope for stage 3.
const MARK_TOGGLE_KINDS = Object.freeze({
  strong: 'strong',
  emphasis: 'emphasis',
  strike_through: 'delete',
  inlineCode: 'inlineCode',
  highlight: 'highlight'
})

// Detects the toolbar/keymap/context-menu mark-toggle shape (Plan 4 Task 3):
// PM's `toggleMark` (Crepe toolbar buttons via toggleStrongCommand & friends,
// HorseMD's own applyTextFormat/applyHighlightInView, the preset Mod-b/Mod-i/
// Mod-e/Mod-Alt-x keymaps) dispatches ONE transaction whose steps are purely
// AddMarkStep(s) OR purely RemoveMarkStep(s) of ONE mark type. Multiple steps
// occur when the range spans text-node boundaries PM could not merge into a
// single step; contiguous same-mark runs are coalesced into one [from, to)
// range. Anything else — a gap between steps (toggleMark skipping an
// already-marked middle segment, or a cross-block selection whose steps jump
// the block boundary), mixed add+remove (applyHighlightInView's color-replace
// shape), mixed mark types — returns null and falls through to `blocked`
// (fail-closed; the kernel command can only prove a single contiguous span).
//
// Mark steps never displace positions (no content is inserted or removed),
// so every step of the transaction shares ONE coordinate space — the
// pre-batch doc's — and the single-textblock guard resolves the coalesced
// range against `tr.docs[0]` (== oldState.doc for a lone transaction)
// without any delta arithmetic. The parent textblock is NOT required to be
// mark-free: toggling a mark in a paragraph that already carries
// other marks is exactly the unwrap/nesting shape `toggleInlineMark` owns
// (it re-proves everything against the raw bytes; a shape it cannot own
// refuses with its own code).
function extractMarkToggle(transactions, oldState) {
  const changed = transactions.filter((tr) => tr && tr.docChanged)
  if (changed.length !== 1) return null
  const tr = changed[0]
  if (!Array.isArray(tr.steps) || !tr.steps.length) return null
  let stepType = null
  let markName = null
  let markAttrs = null
  let from = null
  let to = null
  for (const step of tr.steps) {
    const name = step?.constructor?.name
    if (name !== 'AddMarkStep' && name !== 'RemoveMarkStep') return null
    if (stepType && name !== stepType) return null
    stepType = name
    const mark = step.mark
    const typeName = mark?.type?.name
    if (!typeName) return null
    if (markName && typeName !== markName) return null
    markName = typeName
    markAttrs = mark.attrs || null
    if (!Number.isFinite(step.from) || !Number.isFinite(step.to) || step.to <= step.from) return null
    if (from == null) {
      from = step.from
      to = step.to
    } else if (step.from === to) {
      to = step.to
    } else {
      return null // non-contiguous: a skipped segment or a cross-block jump
    }
  }
  const kind = MARK_TOGGLE_KINDS[markName]
  if (!kind) return null
  if (markName === 'highlight' && markAttrs?.color && markAttrs.color !== 'yellow') return null
  const docNode = tr.docs?.[0] || oldState?.doc
  if (!docNode) return null
  let $from
  let $to
  try {
    $from = docNode.resolve(from)
    $to = docNode.resolve(to)
  } catch {
    return null
  }
  if (!$from.sameParent($to) || !$from.parent.isTextblock) return null
  return { pmFrom: from, pmTo: to, markName, markKind: kind, add: stepType === 'AddMarkStep' }
}

// Link editing (Plan 5 Task 6) — the ONE flow `extractMarkToggle` above must
// NOT be relaxed for. `link` is absent from `MARK_TOGGLE_KINDS` on purpose,
// and the tooltip's commit is a MIXED batch that `extractMarkToggle` refuses
// by design (that refusal is what keeps `applyHighlightInView`'s
// remove-then-add color replace out of the toggle path — Case M7 in
// scripts/test-kernel-gateway.mjs). So links get their own classifier, keyed
// on the `link` mark type, and the highlight shape can never reach it.
//
// WHAT THE REAL TOOLTIP DISPATCHES (probed in @milkdown/components'
// link-tooltip, not guessed — `#confirmEdit` in edit/edit-view.ts:102-129 and
// `removeLink` at :188-196 are the only dispatch sites; `toggleLinkCommand`
// in command.ts carries NO payload, it just routes the selection into one of
// them). All four shapes are ONE transaction:
//
//   wrap    addLink(from<to)   -> AddMarkStep(link{href}, from, to)
//   edit    editLink(mark,f,t) -> RemoveMarkStep(link{oldHref}, f, t)
//                                 + AddMarkStep(link{href}, f, t)
//   unwrap  removeLink(f, t)   -> RemoveMarkStep(link, f, t)
//   insert  addLink(from===to) -> ReplaceStep(text=href at from)
//                                 + AddMarkStep(link{href}, from, from+len)
//
// Step ORDER is part of the proof, not a convenience: `#confirmEdit` always
// removes before it inserts and inserts before it adds, so any other ordering
// is a batch this classifier did not probe and refuses. Mark steps never
// displace positions, so the remove/add ranges share the pre-batch doc's
// coordinate space; the `insert` shape's AddMarkStep is expressed AFTER its
// own ReplaceStep, which is why its range is required to be exactly
// [insertPos, insertPos + text.length) and the reported PM range collapses
// back to the (zero-width) insert point in old-doc coordinates.
//
// A `title` is never reported: the tooltip only ever supplies `href`
// (`type.create({ href })`), so an `edit` leaves the existing title BYTES
// alone rather than deleting a title the user never touched — the source is
// authoritative, so the reparse hands the title straight back to the mark.
function extractLinkEdit(transactions, oldState) {
  const changed = transactions.filter((tr) => tr && tr.docChanged)
  if (changed.length !== 1) return null
  const tr = changed[0]
  if (!Array.isArray(tr.steps) || !tr.steps.length) return null

  const removes = []
  const adds = []
  let insert = null
  let phase = 0 // 0 = removes, 1 = the lone insert, 2 = adds
  for (const step of tr.steps) {
    const name = step?.constructor?.name
    if (name === 'RemoveMarkStep') {
      if (phase !== 0) return null
      removes.push(step)
    } else if (name === 'ReplaceStep') {
      if (phase > 1 || insert) return null
      phase = 1
      if (step.from !== step.to) return null
      const text = plainSliceText(step.slice)
      if (!text) return null
      insert = { from: step.from, text }
    } else if (name === 'AddMarkStep') {
      phase = 2
      adds.push(step)
    } else {
      return null
    }
  }
  if (!removes.length && !adds.length) return null
  if (insert && removes.length) return null // never dispatched together

  // Every mark step must carry the `link` mark type, and each side must
  // coalesce into ONE contiguous range (the same rule extractMarkToggle
  // applies: a gap means a skipped segment or a cross-block jump).
  //
  // The steps must also agree on `href`. The tooltip never emits two adjacent
  // link steps with different destinations (one confirm produces ONE mark), so
  // this is unreachable today — but "last attrs win" would silently commit the
  // second href for a batch this classifier never probed, which contradicts
  // its own fail-closed posture everywhere else. Refuse instead (review
  // finding, 2026-08-17).
  const coalesce = (steps) => {
    if (!steps.length) return null
    let from = null
    let to = null
    let attrs = null
    for (const step of steps) {
      if (step.mark?.type?.name !== 'link') return null
      if (!Number.isFinite(step.from) || !Number.isFinite(step.to) || step.to <= step.from) return null
      if (attrs && step.mark.attrs?.href !== attrs.href) return null
      attrs = step.mark.attrs || null
      if (from == null) {
        from = step.from
        to = step.to
      } else if (step.from === to) {
        to = step.to
      } else {
        return null
      }
    }
    return { from, to, attrs }
  }
  const removed = removes.length ? coalesce(removes) : null
  const added = adds.length ? coalesce(adds) : null
  if (removes.length && !removed) return null
  if (adds.length && !added) return null

  let op
  let pmFrom
  let pmTo
  let href = null
  let insertedText

  if (!added) {
    op = 'unwrap'
    pmFrom = removed.from
    pmTo = removed.to
  } else if (insert) {
    op = 'insert'
    if (added.from !== insert.from || added.to !== insert.from + insert.text.length) return null
    pmFrom = insert.from
    pmTo = insert.from
    insertedText = insert.text
    href = added.attrs?.href
  } else if (removed) {
    op = 'edit'
    if (removed.from !== added.from || removed.to !== added.to) return null
    pmFrom = added.from
    pmTo = added.to
    href = added.attrs?.href
  } else {
    op = 'wrap'
    pmFrom = added.from
    pmTo = added.to
    href = added.attrs?.href
  }
  if (op !== 'unwrap' && typeof href !== 'string') return null

  // Single-textblock guard, resolved against the PRE-batch doc (mark steps
  // never displace positions; for the `insert` shape the reported range is
  // the zero-width insert point, which is a valid pre-batch position too).
  const docNode = tr.docs?.[0] || oldState?.doc
  if (!docNode) return null
  let $from
  let $to
  try {
    $from = docNode.resolve(pmFrom)
    $to = docNode.resolve(pmTo)
  } catch {
    return null
  }
  if (!$from.sameParent($to) || !$from.parent.isTextblock) return null

  const result = { op, pmFrom, pmTo }
  if (op !== 'unwrap') result.href = href
  if (op === 'insert') result.insertedText = insertedText
  return result
}

// Detects `@milkdown/plugin-trailing`'s own append: ONE transaction whose
// single ReplaceStep inserts exactly one EMPTY paragraph at the very end of
// the document (from === to === the step-doc's content size). Crepe ships
// that plugin unconditionally; its appendTransaction can ride any dispatch
// batch (even a selection-only click) the moment the doc's last child is a
// non-paragraph block. Left unclassified this fell through to
// `blocked`/`INPUT_TYPE` and the dispatch-veto channel would refuse the
// plugin's own convenience paragraph — vetoing a batch the user never
// authored. The shape is view-only (an empty paragraph has no markdown
// bytes), so the kernel lets it through without any byte commit; the
// projection map's trailing-placeholder tolerance pairs it.
function extractTrailingAppend(transactions) {
  const changed = transactions.filter((tr) => tr && tr.docChanged)
  if (changed.length !== 1) return null
  const tr = changed[0]
  if (!Array.isArray(tr.steps) || tr.steps.length !== 1) return null
  const step = tr.steps[0]
  if (step?.constructor?.name !== 'ReplaceStep') return null
  const stepDoc = tr.docs?.[0]
  if (!stepDoc) return null
  if (step.from !== step.to || step.from !== stepDoc.content.size) return null
  const slice = step.slice
  if (!slice || slice.openStart || slice.openEnd) return null
  if (slice.content?.childCount !== 1) return null
  const node = slice.content.firstChild
  if (!node || node.type?.name !== 'paragraph' || node.content?.size !== 0) return null
  return { at: step.from }
}

// --- syncHeadingIdPlugin (heading `id` refresh) ------------------------------
//
// `@milkdown/preset-commonmark`'s `syncHeadingIdPlugin` is a VIEW plugin: on
// every document change it recomputes `heading.attrs.id` from the rendered
// text and `view.dispatch`es one `setNodeMarkup` per stale heading
// (preset-commonmark/lib/index.js, `src/plugin/sync-heading-id-plugin.ts`).
// `setNodeMarkup` is a `ReplaceAroundStep`, never a `ReplaceStep`, so
// `extractPlainTextSteps` correctly refused it and the batch fell through to
// `blocked`/`INPUT_TYPE`: the dispatch-veto channel refused it, the plugin
// retried on the next document change, and every kernel-mode document that
// contained ONE non-empty heading raised the "not supported yet" toast on
// every keystroke while the user's own (separately dispatched, accepted) edit
// landed normally. That is the 2026-08-17 veto-divergence report's finding.
//
// WHY PASSING THIS THROUGH CANNOT WEAKEN FAIL-CLOSED: a heading's `id`
// attribute is not Markdown. It exists only so the rendered DOM/outline/export
// has an anchor; no serializer writes it and `kernel.doc.text` has no
// representation of it, so a batch that changes ONLY this attribute cannot
// change a single authored byte. The classification below therefore commits
// nothing and advances no revision — it is the same posture as
// `trailing-append` right above, for the same reason.
//
// NARROWNESS (this must never become "any setNodeMarkup batch is fine"):
// BOTH gates must hold.
//   (1) provenance — the transaction carries the plugin's own
//       `MILKDOWN_HEADING_ID` PluginKey meta; and
//   (2) structure — EVERY step is proven, against the doc that step applies
//       to, to be an attrs-only rewrite of a `heading` node that changes
//       nothing but `id`: same node type, same marks, same node size, the gap
//       covering exactly the original content (so the children are carried
//       over untouched, not replaced), and every other attribute equal.
// A batch that carries the meta but touches anything else fails (2) and stays
// `blocked`; a batch that is shaped like a heading-id rewrite but comes from
// somewhere else fails (1) and stays `blocked`.
const HEADING_ID_META_PREFIX = 'MILKDOWN_HEADING_ID$'
// PluginKey ids are `${name}$` for the first key of a name and `${name}$N`
// afterwards (prosemirror-state `createKey`), and `Transaction#setMeta` stores
// them under that string id — so a prefix match over the transaction's own
// meta bag is how a module that cannot import Milkdown's private PluginKey
// object reads the provenance. Wrapped in a try/catch: a missing/exotic meta
// bag must degrade to "no provenance" (refuse), never throw into the dispatch
// path. The live-editor UI regression (scripts/test-kernel-heading-id-ui.mjs)
// is what pins this string to Milkdown's actual key name.
const carriesHeadingIdMeta = (tr) => {
  try {
    const meta = tr?.meta
    if (!meta) return false
    for (const key of Object.keys(meta)) {
      if (key.startsWith(HEADING_ID_META_PREFIX) && meta[key] === true) return true
    }
  } catch {
    return false
  }
  return false
}

const sameMarks = (a, b) => {
  const left = a || []
  const right = b || []
  if (left.length !== right.length) return false
  return left.every((mark, index) => mark?.eq?.(right[index]))
}

// Is `step` an attrs-only heading rewrite that changes nothing but `id`,
// measured against `doc` (the document that step applies to)?
const isHeadingIdOnlyStep = (step, doc) => {
  if (step?.constructor?.name !== 'ReplaceAroundStep') return false
  if (step.structure !== true || step.insert !== 1) return false
  if (!Number.isFinite(step.from) || !Number.isFinite(step.to)) return false
  // The gap must be exactly the original node's content: `from`/`to` wrap the
  // whole node and `gapFrom`/`gapTo` its content boundaries, so the children
  // are re-parented verbatim rather than replaced by slice content.
  if (step.gapFrom !== step.from + 1 || step.gapTo !== step.to - 1) return false
  const slice = step.slice
  if (!slice || slice.openStart !== 0 || slice.openEnd !== 0) return false
  if (slice.content?.childCount !== 1) return false
  const after = slice.content.firstChild
  if (!after || after.type?.name !== 'heading') return false
  // The wrapper the step inserts must be EMPTY (content comes from the gap).
  if (after.content?.size) return false
  let before
  try {
    before = doc?.nodeAt(step.from)
  } catch {
    return false
  }
  if (!before || before.type !== after.type) return false
  if (before.nodeSize !== step.to - step.from) return false
  if (!sameMarks(before.marks, after.marks)) return false
  const beforeAttrs = before.attrs || {}
  const afterAttrs = after.attrs || {}
  for (const key of new Set([...Object.keys(beforeAttrs), ...Object.keys(afterAttrs)])) {
    if (key === 'id') continue
    if (beforeAttrs[key] !== afterAttrs[key]) return false
  }
  if (typeof afterAttrs.id !== 'string') return false
  return true
}

function extractHeadingIdSync(transactions, oldState) {
  const changed = transactions.filter((tr) => tr && tr.docChanged)
  if (changed.length !== 1) return null
  const tr = changed[0]
  if (!carriesHeadingIdMeta(tr)) return null
  if (!Array.isArray(tr.steps) || !tr.steps.length) return null
  for (let index = 0; index < tr.steps.length; index += 1) {
    const stepDoc = tr.docs?.[index] || (index === 0 ? oldState?.doc : null)
    if (!stepDoc) return null
    if (!isHeadingIdOnlyStep(tr.steps[index], stepDoc)) return null
  }
  return { headings: tr.steps.length }
}

// classifyTransactions: pure triage of a dispatch batch into one of eight
// kinds. Order matters — it is priority, not just an enum listing:
//   1. `sourceProjection` meta marks a transaction the caller itself built
//      FROM a kernel/raw commit (e.g. a projection reconciler replaying the
//      kernel's text into the PM doc) — that provenance is authoritative
//      regardless of whether the batch also happens to look like plain text,
//      is mid-composition, or carries no doc change at all. Reconciler-
//      generated transactions are self-authored and can never carry drop
//      meta, so this stays first without conflicting with rule 2.
//   2. `uiEvent === 'drop'` is an explicit, unconditional block — checked
//      BEFORE the composition label. A drop is never a legitimate part of
//      an IME composition; if it ran after the composition check, a stale
//      `isComposing: true` flag (e.g. a composition that never received its
//      compositionend before a drop landed) could let a drop through as a
//      no-op pass-through instead of being refused, mutating the view
//      without any kernel bookkeeping. Drag-drop content is never treated
//      as plain text either, even if its slice would otherwise qualify —
//      spec'd explicitly in the Task 3 brief.
//   3. `isComposing` is a caller-supplied label (IME mid-composition); the
//      gateway does not try to infer composition state itself, so once the
//      caller says so (and it isn't a drop), that's final, ahead of the
//      docChanged gate below (a composition update can legitimately have
//      `docChanged: false` for a no-op composition tick).
//   4. No transaction changed the doc → selection-only (caret/selection
//      moves, no kernel involvement at all).
//   5. A lone `AttrStep` flipping a `list_item`'s `checked` attribute is the
//      task-checkbox click shape (see `extractTaskToggleStep` above) — tried
//      before the plain-text guard since it is never a `ReplaceStep` batch
//      and would otherwise fall through to `blocked`/`INPUT_TYPE`.
//   6. A lone `AttrStep` setting a `code_block`'s `language` attribute is the
//      language-switch shape (see `extractLanguageStep` above) — same reason
//      as rule 5, checked right alongside it (both are AttrStep shapes the
//      plain-text ReplaceStep guard can never match).
//   6b. A lone `AttrStep` setting an image node's `src`/`alt`/`title` (see
//      `extractImageAttrStep` above) — the third AttrStep shape, same
//      reasoning. `caption`/`ratio` are deliberately NOT matched and keep
//      falling through to `blocked`.
//   7. The trailing plugin's own empty-paragraph append (see
//      `extractTrailingAppend` above) — view-only, no kernel bytes, must not
//      be vetoed.
//   7b. `syncHeadingIdPlugin`'s heading-`id` refresh (see
//      `extractHeadingIdSync` above) — the second view-only shape, and for
//      the same reason: `heading.attrs.id` has no Markdown representation, so
//      the batch cannot change an authored byte. Gated on BOTH the plugin's
//      own meta and a per-step structural proof.
//   8. A pure AddMarkStep/RemoveMarkStep batch over one textblock range is
//      the toolbar/keymap mark-toggle shape (see `extractMarkToggle` above)
//      — tried BEFORE the plain-text guard (a mark step is never a
//      ReplaceStep, so it would otherwise fall through to `blocked`), AFTER
//      the projection/drop/composition rules and the docChanged gate (a
//      stored-marks-only toggle on an empty selection has `docChanged:
//      false` and stays `selection-only`; the dispatch channel never even
//      consults the gateway for it — see editor-kernel-mode.js's
//      `marksKeymap` guard for how empty-selection shortcuts are handled).
//   8b. The link tooltip's own four shapes (see `extractLinkEdit` above) —
//      checked right after the mark toggle and, critically, as a SEPARATE
//      classifier: `extractMarkToggle`'s refusal of mixed Add+Remove batches
//      is what keeps `applyHighlightInView`'s color-replace out of the toggle
//      path, so it is not loosened; links get their own `link` -mark-keyed
//      rule instead.
//   9. Otherwise, try the plain-text step guard; anything it can't prove is
//      `blocked` with `INPUT_TYPE` (the single "docChanged but unsupported"
//      code per the brief — this gateway does not attempt finer-grained
//      block reasons for the plain-text path; ProjectionReconciler/dispatch
//      veto own retry/fallback semantics upstream of this function).
export function classifyTransactions(transactions, oldState, { isComposing = false } = {}) {
  const trs = Array.isArray(transactions) ? transactions : [transactions]

  if (trs.some((tr) => tr && typeof tr.getMeta === 'function' && tr.getMeta('sourceProjection'))) {
    return { kind: 'projection' }
  }
  if (trs.some((tr) => tr && typeof tr.getMeta === 'function' && tr.getMeta('uiEvent') === 'drop')) {
    return { kind: 'blocked', blockedCode: KERNEL_CODES.INPUT_TYPE }
  }
  if (isComposing) return { kind: 'composition' }

  const changed = trs.some((tr) => tr && tr.docChanged)
  if (!changed) return { kind: 'selection-only' }

  const taskToggle = extractTaskToggleStep(trs, oldState)
  if (taskToggle) return { kind: 'task-toggle', pos: taskToggle.pos }

  const languageStep = extractLanguageStep(trs, oldState)
  if (languageStep) return { kind: 'code-language', pmPos: languageStep.pmPos, language: languageStep.language }

  const imageAttr = extractImageAttrStep(trs, oldState)
  if (imageAttr) return { kind: 'image-attrs', ...imageAttr }

  const trailingAppend = extractTrailingAppend(trs)
  if (trailingAppend) return { kind: 'trailing-append', at: trailingAppend.at }

  const headingIdSync = extractHeadingIdSync(trs, oldState)
  if (headingIdSync) return { kind: 'heading-id', headings: headingIdSync.headings }

  const markToggle = extractMarkToggle(trs, oldState)
  if (markToggle) return { kind: 'mark-toggle', ...markToggle }

  const linkEdit = extractLinkEdit(trs, oldState)
  if (linkEdit) return { kind: 'link-edit', ...linkEdit }

  const steps = extractPlainTextSteps(trs, oldState)
  if (!steps || !steps.length) return { kind: 'blocked', blockedCode: KERNEL_CODES.INPUT_TYPE }

  return { kind: 'plain-text', steps }
}

// `bisectsLineEnding` (used by `commitPlainText`'s guard below — see its call
// site for the corruption shapes it refuses) used to be a private copy here.
// It now comes from `lib/source-kernel/character-map.js`, the module that owns
// the unit model the predicate reads, so this file and the pure commands under
// `lib/source-kernel/commands/` enforce ONE definition instead of two copies
// that can drift apart. Behavior is unchanged (the copy was byte-identical).

// ===========================================================================
// TABLE-CELL REPARSE PROOF (2026-08-17 whole-branch review, Critical 1)
// ===========================================================================
// A GFM table's structure is decided by CONTEXT-SENSITIVE bytes, so guarding
// the INSERTED characters can never be sufficient. The probe that ended the
// byte-only guard:
//
//   '|a|b|\n|-|-|\n|c|d|\n'  + one '\' typed at the end of cell (0,0)
//   committed '|a\|b|\n|-|-|\n|c|d|\n'
//   which reparses to ONE paragraph — the table is gone, and saved that way.
//
// The inserted byte is a backslash: it contains no '|', so
// `insertText.includes('|')` (the pre-existing guard, kept below as the cheap
// early refusal) says nothing about it. What it does is turn the NEIGHBOURING
// delimiter into '\|', which GFM unescapes before splitting the row — the
// header then has one column while the delimiter row has two, and the whole
// block stops being a table. HorseMD-native PADDED tables ('| a | b |') hide
// this: there the '\' lands before a space, not before the '|'. Compact
// tables from other tools do not.
//
// Nothing downstream catches it either: `verifyPlainTextProjection`
// (editor-kernel-mode.js) runs AFTER `kernel.doc` has been advanced, so it
// "repairs" the VIEW to match the corrupted bytes — the table visibly
// collapses into a paragraph and the file keeps the collapsed bytes.
//
// So the cell path gets the posture the other two byte-rewriting write paths
// already have (commands/image-attrs.js `verifyCandidate`,
// commands/link-toggle.js): REPARSE the candidate document and prove the
// structure is unchanged BEFORE the caller advances `kernel.doc`.
//
// The signature is a pre-order type walk that STOPS at `tableCell`: every
// block boundary, every table, every row and every cell in the document is
// compared, while the edited cell's own inline content — which is precisely
// what the user just changed — is not. That is exactly the brief's scope
// ("still parses as a table with the same row/column counts"), stated
// structurally rather than as two counters, and it costs no offset
// arithmetic (an insert at a cell's own start byte makes "did this node's
// start shift?" genuinely ambiguous, so offsets are deliberately not part of
// the comparison — the type walk already fails the moment a row, a cell or a
// block appears/disappears/changes kind).
//
// SCOPE OF THE PROOF, stated exactly (re-review finding, 2026-08-17). Because
// the walk stops at `tableCell`, an edit that keeps the table's SHAPE but
// changes what a cell displays passes: '|ab|cd|' + a '\' before the row's
// TRAILING pipe commits '|ab|cd\|', whose second cell then reads 'cd|'. That
// is not corruption — the bytes and the view agree (the repair reconcile
// shows 'cd|', which is what the source now says), and the table is intact —
// but it IS the boundary of what this proof claims: table STRUCTURE, not
// per-cell decoded content. Widening it to pin the decoded cell text would
// need the expected post-edit visible string, which this function is not
// given; out of scope, recorded rather than left implicit.
//
// COST. One mdast parse per table-cell keystroke — measured
// `parseKernelMarkdown` on table-heavy content at 30 ms @12 KB, 81 ms @40 KB,
// 750 ms @184 KB, so the naive "parse both sides" version was up to ~4.5x the
// per-keystroke parse work in a large document (the accepted path already pays
// one parse via `bindMap` -> `buildProjectionMap` -> `buildSyntaxIndex`). The
// BEFORE side is trivially cacheable: keystroke N's candidate text IS
// keystroke N+1's baseline text, byte-identical, and `kernel.doc.text` does
// not change between commits. `signatureFor` below is a one-slot-PER-DOCUMENT
// memo keyed on the EXACT string (equality on the immutable text — never a
// hash, never a revision number, so a cache hit is proof the bytes are the
// same), which makes the steady state exactly ONE parse per table-cell
// keystroke. The single slot per document is deliberate: computing the
// candidate evicts that document's baseline, which is precisely the entry its
// next keystroke needs.
//
// PER DOCUMENT, not module-global (re-review round 2, finding C2). HorseMD
// keeps every tab's editor mounted, so a module-level slot means two tabs
// typed alternately thrash it to a 0% hit rate — 40 parses for 20 keystrokes,
// worse than no cache at all — and it pins one full document string alive for
// the process lifetime. Keying a WeakMap on the caller's `kernel` state object
// (one per editor instance, see editor-kernel-mode.js) gives each document its
// own slot and lets the entry die with the editor. A caller without an object
// to key on (hand-built `kernel` literals in older tests) simply parses, which
// is the pre-memo behavior.
const tableSignatureMemo = new WeakMap()

const signatureFor = (memoKey, text) => {
  const slot = memoKey && typeof memoKey === 'object' ? tableSignatureMemo.get(memoKey) : null
  if (slot && slot.text === text) return slot.signature
  const signature = tableStructureSignature(parseKernelMarkdown(text))
  if (memoKey && typeof memoKey === 'object') tableSignatureMemo.set(memoKey, { text, signature })
  return signature
}

const tableStructureSignature = (tree) => {
  const out = []
  const visit = (node) => {
    out.push(node?.type)
    if (node?.type === 'tableCell') return
    for (const child of node?.children || []) visit(child)
  }
  visit(tree)
  return out.join('\x00')
}

// Fail-closed on a parse failure of EITHER side (an unparseable candidate is
// exactly the case that must not be committed, and an unparseable baseline
// means there is nothing to prove the candidate against).
function tableStructurePreserved(memoKey, beforeText, afterText) {
  try {
    // Baseline FIRST (the common cache hit), candidate second (the miss that
    // becomes the next keystroke's hit) — see `signatureFor`'s comment for
    // why the order is what makes the one-slot memo work.
    const baseline = signatureFor(memoKey, beforeText)
    return baseline === signatureFor(memoKey, afterText)
  } catch {
    return false
  }
}

// THE OBSERVABILITY EXPECTATION (`result.observability`, 2026-08-18)
// ===========================================================================
// Both whitespace defects in this family (the heading's leading Tab and the
// block-trailing space) shipped past every existing check for the SAME reason:
// nothing proved that a committed edit is observable in the reparse.
// `verifyPlainTextProjection` compares the VIEW against the reparse, which is
// necessary but not sufficient — when a character is lost on BOTH sides the two
// agree perfectly on a document that silently dropped it. A mapper's
// `preserved: true` cannot establish it either.
//
// So a successful commit now also reports what the edited block's VISIBLE
// length must be once the map is rebound. The caller
// (editor-kernel-mode.js's `plain-text` case) checks it against the map it
// rebuilds anyway, so this costs NO extra parse and no extra map build.
//
// WHAT IT IS NOT. It is a DETECTOR, not a gate: it runs after the bytes are
// published, so it raises an `edit-unobservable` diagnostic rather than
// refusing. That is deliberate for now — the per-shape commands
// (commands/heading-whitespace.js, commands/trailing-whitespace.js) do the
// fail-closed proving BEFORE they write, and this is the net underneath them
// that makes the whole class machine-detectable (and assertable from a test)
// instead of invisible.
//
// KNOWN BENIGN FIRING, recorded rather than special-cased: typing the final ';'
// of a character reference ('&nbsp' + ';') legitimately collapses five visible
// characters into one, so the length moves by -4 where +1 was expected. The
// document is correct; the expectation is simply too crude for that shape.
// Anything else this reports is worth investigating.
//
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
  if (!kernel?.doc || !map || typeof map.pmPosToRaw !== 'function' ||
      typeof map.pmPosToRawStart !== 'function') {
    return { ok: false, code: KERNEL_CODES.UNMAPPED }
  }
  const trs = Array.isArray(transactions) ? transactions : [transactions]
  const steps = extractPlainTextSteps(trs, oldState)
  if (!steps || !steps.length) return { ok: false, code: KERNEL_CODES.INPUT_TYPE }

  const edits = []
  // Per-step bookkeeping for the MULTI-STEP delete gate below: each entry pairs
  // the raw edit this step resolved to with the block pair it targeted, all in
  // the SAME baseline coordinate space (`kernel.doc.text`), which is what lets
  // the batch be judged as one composed change rather than step by step.
  const records = []
  let cumulativeDelta = 0
  let touchedTableCell = false
  // THE OBSERVABILITY EXPECTATION (2026-08-18). See the ADR above
  // `commitPlainText`'s return for what this is and what it deliberately is
  // not.
  let observability = null
  const prefixedVirtualBlocks = new Set()
  for (const step of steps) {
    const oldFrom = step.from - cumulativeDelta
    const oldTo = step.to - cumulativeDelta
    // Virtual block (trailing placeholder / split placeholder / empty list
    // item — see editor-kernel-projection-map.js): the decision is made by
    // PM position (unique), never by raw offset (a virtual pair's raw anchor
    // can coincide with a real block's end in a doc without a final
    // newline). The insert lands at the pair's raw anchor, prefixed with the
    // separator bytes the pair demands (e.g. a blank line after a trailing
    // list so the typed text parses as a new paragraph, not a lazy
    // continuation of the last item).
    const virtualBlock = typeof map.virtualBlockAt === 'function' && oldFrom === oldTo
      ? map.virtualBlockAt(oldFrom)
      : null
    // The separator prefix is latched to the FIRST qualifying insert per
    // virtual pair within this batch: a multi-step transaction typing 'ab'
    // into the trailing paragraph rebases BOTH steps to the pair's content
    // position (the unwind subtracts each step's own delta), so an
    // unlatched prefix would emit '\na' + '\nb' — two source paragraphs
    // for what PM shows as one — and force a verify repair that
    // restructures the user's typing. Latched, the batch commits
    // '\na' + 'b': one paragraph, cheap-path verify passes.
    const virtualPrefix = virtualBlock && !prefixedVirtualBlocks.has(oldFrom)
      ? virtualBlock.prefix
      : ''
    if (virtualBlock) prefixedVirtualBlocks.add(oldFrom)
    // A genuine (non-empty) selection's LEFT edge is resolved through the
    // gap-aware `pmPosToRawStart`, never plain `pmPosToRaw` — see
    // character-map.js's ADR comment on `buildCharacterMap` for the byte
    // corruption this specifically fixes (typing over a selected, already-
    // marked word used to silently eat its opening marker). A zero-width
    // step (`oldFrom === oldTo`, a bare caret insert) resolves BOTH ends
    // through ONE resolver — `pmPosToRawInsert` (P4-3.5, Fix B), the
    // marker-gap-NEUTRAL point: the slice was proven PLAIN above, so a char
    // typed at a mark run's boundary must land OUTSIDE the run's delimiters
    // ('a **bold**' + plain X at the run's end -> 'a **bold**X', never
    // 'a **boldX**'), and between two adjacent runs it lands between their
    // marker bytes. At every gap-free boundary (all previously-typeable
    // content) the neutral resolver returns exactly the old `pmPosToRaw`
    // value. Using one resolver for both ends keeps `rawFrom === rawTo`
    // structurally (never a spurious non-zero-width edit); the legacy
    // `pmPosToRaw` fallback covers hand-built maps in older tests.
    const insertPoint = typeof map.pmPosToRawInsert === 'function'
      ? map.pmPosToRawInsert
      : map.pmPosToRaw
    const rawFrom = virtualBlock
      ? virtualBlock.raw
      : oldFrom < oldTo ? map.pmPosToRawStart(oldFrom) : insertPoint(oldFrom)
    const rawTo = virtualBlock
      ? virtualBlock.raw
      : oldFrom < oldTo ? map.pmPosToRaw(oldTo) : insertPoint(oldFrom)
    if (!Number.isFinite(rawFrom) || !Number.isFinite(rawTo) || rawFrom > rawTo) {
      return { ok: false, code: KERNEL_CODES.UNMAPPED }
    }
    // CRLF bisection guard (review finding, 2026-08-17) — the DELETE-side
    // half of the same contract the break-spelling check above enforces for
    // inserts. A code `charMap` deliberately models a '\r\n' ending as TWO
    // units (a `char` unit for the '\r', then the `linebreak` unit for the
    // '\n', which also spans the next line's prefix — see code-map.js), so
    // it legitimately exposes a boundary BETWEEN them. Any raw offset landing
    // there bisects the pair. Reviewer-probed shapes on
    // '```js\r\nab\r\ncd\r\n```\r\n' (content 'ab\r\ncd' from PM 1):
    //  - delete PM[4,5) (the '\n' alone) -> raw [10,11): leaves a lone '\r';
    //  - delete PM[3,4) (the '\r' alone) -> raw [9,10): leaves a bare '\n',
    //    i.e. mixed endings inside a uniform-CRLF file;
    //  - the quoted-fence version is the worst: the `linebreak` unit's raw
    //    span carries the next line's '> ' prefix, so deleting the '\n' half
    //    eats the prefix while the lone '\r' survives as a line terminator —
    //    line 2 silently loses its quote marker.
    // None of these is reachable through today's UI (the patched bridge's
    // `cmToPm` never returns an interior offset, and find/replace cannot
    // produce a code_block-parented step) — but that defence lives in a
    // prototype patch in ANOTHER module. This file owns the byte contract, so
    // it proves it here rather than inheriting it. A correctly shaped
    // full-pair delete (PM[3,5) -> raw [9,11)) is untouched: neither end sits
    // between the two units.
    let stepPair = null
    if (!virtualBlock) {
      const pair = typeof map.pairAt === 'function' ? map.pairAt(oldFrom) : null
      stepPair = pair
      const text = kernel.doc.text
      if (bisectsLineEnding(pair?.charMap, text, rawFrom) ||
          bisectsLineEnding(pair?.charMap, text, rawTo)) {
        return { ok: false, code: KERNEL_CODES.UNMAPPED }
      }
      // Whole-atom contract, raw half (P6 Task 1b — see `rangeSplitsAtomUnit`).
      // The classification guard proved the PM range never cuts an atom in
      // two; this proves the RESOLVED BYTES don't either, before a single one
      // is written.
      if (rangeSplitsAtomUnit(pair?.charMap, rawFrom, rawTo)) {
        return { ok: false, code: KERNEL_CODES.UNMAPPED }
      }
      // Table cell (Plan 5 Task 4): inside a GFM cell the `|` byte is the
      // COLUMN DELIMITER, so writing a literal one would split the cell — the
      // raw source would grow a column the ProseMirror doc does not have, and
      // the next reparse would show a differently-shaped table than the one
      // the user was typing into. Adding/removing columns is explicitly out of
      // this phase's scope, so fail closed rather than commit bytes whose
      // reparse changes the structure. (A line break can't reach here: the
      // `allowNewline` relaxation in `plainSliceText` is granted only to
      // `code_block` textblocks. The DELETE side needs no guard — a cell
      // pair's charMap covers only that cell's content units, so every
      // resolved raw range is already confined between its delimiters.)
      if (pair?.tableCell) {
        // Cheap early refusal for the one byte that is unconditionally
        // structural. The REAL proof is the reparse below (see the
        // `tableStructurePreserved` ADR): a byte-level guard cannot decide a
        // context-sensitive escape like '\' turning the neighbouring '|' into
        // '\|'. This one stays because it is free and gives the precise
        // "column count would change" refusal at the step that caused it.
        if (step.insertText.includes('|')) {
          return { ok: false, code: KERNEL_CODES.UNSUPPORTED }
        }
        touchedTableCell = true
      }
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
    // Code-block line-break expansion (Plan 3 Task 4; CRLF un-narrowing
    // 2026-08-17). `step.insertText` can carry a line break only when its
    // target textblock is a `code_block` (`extractPlainTextSteps`'
    // `allowNewline` guard). A raw byte-for-byte insert of the break alone
    // would silently break a quoted/indented fence's per-line prefix
    // contract (`buildCodeMap` requires EVERY content line to reproduce the
    // same prefix byte-for-byte), so each break must become
    // `lineEnding + linePrefix` — the exact bytes `buildCodeMap` already
    // proved every OTHER content line in this block uses. `pairAt` (never
    // virtual: `virtualBlockAt` above only ever matches trailing/split
    // placeholders and empty list items, none of which are `code_block`s)
    // resolves the covering pair by the same content-position search
    // `pmPosToRaw` uses internally.
    //
    // SPELLING IS PROVEN, NEVER RE-SPELLED. The CRLF bridge
    // (`editor-codeblock-crlf.js` `crlfForwardUpdate`) already converts every
    // break CM inserts into the block's dominant ending, so by the time a
    // step arrives here the PM side ALREADY holds '\r\n' for a CRLF block.
    // Re-spelling (the old `split('\n').join(ending + prefix)`) would then
    // double-convert: '\r\n' -> '\r' + '\r\n' + '' — a lone '\r' injected
    // into the source, i.e. exactly the corruption shape this whole family
    // is about. Instead every break is required to EQUAL the block's raw
    // `lineEnding` and only the prefix is added. Two shapes are refused by
    // that rule, both deliberately:
    //  - a bare '\n' in a CRLF/lone-CR block. Reachable only when the
    //    block's CURRENT text holds no '\r' (single-line or empty fence in a
    //    CRLF document): the bridge's `hasCarriageReturn` fast path then
    //    delegates to the vendored `forwardUpdate`, which always emits '\n'
    //    (CM's `Text.toString()` joins with '\n' and can never emit '\r').
    //    Committing '\r\n' to raw while PM holds '\n' would pass the kernel
    //    but fail `verifyPlainTextProjection`'s cheap-path diff on EVERY
    //    such commit — repair-reconcile churn, the P3-4 symptom. Refused
    //    (veto + toast), so the bytes and the view never diverge.
    //  - a '\r'-bearing break in an LF block. The bridge cannot produce one,
    //    so this is an unknown-provenance slice; fail closed.
    let insertText = step.insertText
    let editFrom = rawFrom
    let editTo = rawTo
    // Set only when a command re-spells the step: the bytes written then differ
    // from what ProseMirror inserted, so the projection's expected length has to
    // come from the command rather than from the PM step.
    let respelledVisibleDelta = null
    // THE EMPTY FENCE (2026-08-18) — a pre-existing corruption path on the
    // everyday write path, not a slash-menu artefact. `code-map.js`'s
    // `emptyCodeMap` gives a zero-content fence ONE raw offset, "where a first
    // content line would begin", which for a normally closed fence is the
    // CLOSING FENCE's own line start. Writing the character there verbatim (what
    // this function did before) committed '```js\nx```': the terminator
    // destroyed, and — measured on the kernel's own parser — every block after
    // it swallowed into the code block's value. The blockquote-prefixed shape
    // failed twice over, the character landing in front of the closing line's
    // own '> '.
    //
    // A first insert into an empty fence therefore has to OPEN A CONTENT LINE
    // (prefix + text + this block's line ending), and `spellEmptyCodeInsert`
    // proves that spelling by reparsing the candidate before any byte moves —
    // including for the shape whose `linePrefix` the empty map cannot derive
    // correctly at all (a list-marker-opened fence, where the open line's '- '
    // is not the continuation prefix and the write would create a second list
    // item). It owns the WHOLE spelling for this shape, breaks included, so the
    // generic break expansion below is skipped when it fires.
    //
    // BLOCK MATH IS THE SAME SHAPE (2026-08-19, audit finding). This prefilter
    // used to read `mdBlock?.type === 'code'`, so when `$$` block math became
    // editable through this very function on 2026-08-18
    // (editor-kernel-projection-map.js's `code_block: ['code','math']` ADR) the
    // guard above simply did not apply to it and the corruption stayed fully
    // live for math: '$$\n$$\n\nend\n' + 'x' committed '$$\nx$$\n\nend\n', which
    // reparses to ONE math node with value 'x$$\n\nend'. The quoted spelling put
    // the byte in front of the '> ' exactly as the fence's did. Reachable with
    // no external file: type '$$' / '$$' in source mode, switch to rich, click
    // into the formula, type. `EMPTY_VERBATIM_BLOCK_TYPES` is the command's own
    // allowlist, imported rather than re-spelled here so the two can never
    // diverge again.
    //
    // The prefilter is parse-free: a real (non-virtual) pair whose mdast block
    // is `code`/`math`, whose character map is the EMPTY one, and a non-empty
    // zero-width insert. One parse is spent on the first character typed into an
    // empty verbatim block and never again — the block is no longer empty.
    let emptyFence = false
    if (!virtualBlock && stepPair && !stepPair.virtual && stepPair.charMap &&
        EMPTY_VERBATIM_BLOCK_TYPES.has(stepPair.mdBlock?.type) &&
        stepPair.charMap.visibleLength === 0 &&
        oldFrom === oldTo && insertText !== '') {
      const routed = spellEmptyCodeInsert({
        doc: kernel.doc,
        block: stepPair.mdBlock,
        charMap: stepPair.charMap,
        offset: rawFrom,
        insert: insertText
      })
      // No `not-structural` fall-through here, unlike the whitespace commands
      // below: for THIS shape the pre-existing literal write is known to destroy
      // the fence, so "could not prove a spelling" must refuse, never degrade to
      // the byte that corrupts.
      if (!routed.ok) return { ok: false, code: routed.code }
      editFrom = routed.edit.from
      editTo = routed.edit.to
      insertText = routed.edit.insert
      emptyFence = true
    }
    if (!emptyFence && /[\r\n]/.test(insertText)) {
      const pair = typeof map.pairAt === 'function' ? map.pairAt(oldFrom) : null
      const codeMap = pair?.charMap
      if (!codeMap || typeof codeMap.lineEnding !== 'string' || typeof codeMap.linePrefix !== 'string') {
        return { ok: false, code: KERNEL_CODES.UNMAPPED }
      }
      const breaks = insertText.match(/\r\n|\r|\n/g) || []
      if (breaks.some((brk) => brk !== codeMap.lineEnding)) {
        return { ok: false, code: KERNEL_CODES.UNMAPPED }
      }
      insertText = codeMap.linePrefix
        ? insertText.split(codeMap.lineEnding).join(codeMap.lineEnding + codeMap.linePrefix)
        : insertText
    }
    // Heading leading whitespace, DEFENCE IN DEPTH (2026-08-18). The primary
    // fix for "标题前面无法使用 tab 或者空格" is a keymap in
    // editor-kernel-mode.js, which owns the real Space/Tab KEYDOWN and commits
    // the entity before ProseMirror inserts anything. But a lone space can also
    // reach this function without a keydown (Chromium's `Input.insertText`
    // path, autocorrect/accessibility insertions), and there the old behaviour
    // was to commit a LITERAL byte at the one offset CommonMark strips — a dead
    // byte on disk, invisible in the view. This makes the bytes route-
    // independent: the same command proves the same entity, or the batch is
    // refused. It never guesses.
    //
    // Kept deliberately narrow so the hot typing path pays two comparisons:
    // ONE step, zero-width, exactly one space or tab, no virtual separator
    // bytes, and a cheap byte-level prefilter (`looksLikeAtxContentStart`)
    // before the command's own reparse is allowed to run.
    let headingWhitespace = false
    if (!emptyFence && steps.length === 1 && oldFrom === oldTo && virtualPrefix === '' &&
        (insertText === ' ' || insertText === '\t') &&
        looksLikeAtxContentStart(kernel.doc.text, rawFrom)) {
      const routed = insertHeadingLeadingWhitespace({
        doc: kernel.doc,
        offset: rawFrom,
        character: insertText
      })
      if (routed.ok) {
        insertText = routed.transaction.insert
        headingWhitespace = true
        respelledVisibleDelta = [...insertText].length
      // `not-structural` = the prefilter was a false positive (a '#' run inside
      // ordinary text, a code block, …) — leave the literal byte alone, nothing
      // about that shape changed. Anything else IS the heading content start
      // with no provable spelling, so refuse rather than write the dead byte.
      } else if (routed.code !== KERNEL_CODES.NOT_STRUCTURAL) {
        return { ok: false, code: routed.code }
      }
    }
    // Block-TRAILING whitespace (2026-08-18) — the other end of the same block,
    // and the far more common one: while composing prose the caret is at a
    // block end for essentially every inter-word space. A literal space
    // committed there is stripped by CommonMark, so it never comes back; the
    // projection repair then pulls the view back to the (character-less) bytes
    // and the NEXT character maps IN FRONT of the stranded byte. Typing `a b`
    // produced source `ab ` and view `ab`. See
    // lib/source-kernel/commands/trailing-whitespace.js for the full mechanism.
    //
    // `spellBlockTailInsert` commits a numeric character reference instead
    // (proven by reparsing the candidate) and, on the NEXT character, rewrites
    // that reference back to the literal byte in the SAME edit — so an ordinary
    // sentence ends up as ordinary bytes and the entity exists only while the
    // space is genuinely the last thing in the block.
    //
    // THE PREFILTER IS THE COST CONTRACT. Everything before the command call is
    // parse-free and O(1)-ish, so the hot typing path pays only comparisons:
    //   * ONE step, zero-width, exactly one code point, no virtual separator;
    //   * a real (non-virtual) pair whose mdast block is a paragraph / heading /
    //     table cell (`code` and `math` are excluded by the command's own
    //     allowlist — their trailing spaces ARE content);
    //   * the caret sits at or past the block's LAST character-map unit, i.e.
    //     the insert is an APPEND (an interior insert is already byte-exact);
    //   * and either the byte would be stripped (`literalTailIsStripped`, a
    //     forward walk over the whitespace run — this is what excludes the
    //     two-space hard break, whose run stops at a line ending) or the block
    //     already ends in one of THIS module's own entities (the self-heal).
    // Only then is a parse spent, i.e. on spaces at a block end and on the one
    // character that follows them — never on ordinary interior typing.
    // MULTI-CHARACTER INSERTS REACH THE HEAL SINCE 2026-08-19 (audit finding).
    // The `[...insertText].length === 1` gate here meant a PASTE (or any other
    // multi-character insert) landing right after a block-trailing U+00A0 left
    // it stranded forever. The command itself still claims the RE-SPELLING half
    // for a single space/tab only (`BLOCK_TRAILING_TEXT` has no longer keys), so
    // the only behaviour this opens is the heal, under the same reparse proof.
    if (!emptyFence && !headingWhitespace && steps.length === 1 && oldFrom === oldTo &&
        virtualPrefix === '' && !virtualBlock && stepPair && !stepPair.virtual &&
        stepPair.charMap && insertText !== '' && !/[\r\n]/.test(insertText)) {
      const text = kernel.doc.text
      const units = stepPair.charMap.units
      const lastUnit = Array.isArray(units) && units.length ? units[units.length - 1] : null
      if (lastUnit && rawFrom >= lastUnit.rawEnd) {
        const heal = healableTrailingSpace(text, stepPair.charMap)
        const stripped = literalTailIsStripped(text, stepPair.mdBlock, rawFrom)
        if (stripped || (heal && heal.rawEnd === rawFrom)) {
          const routed = spellBlockTailInsert({
            doc: kernel.doc,
            block: stepPair.mdBlock,
            offset: rawFrom,
            insert: insertText,
            heal
          })
          if (routed.ok) {
            editFrom = routed.edit.from
            editTo = routed.edit.to
            insertText = routed.edit.insert
            // The rewritten range covers exactly the healed unit (one visible
            // character) when a heal happened, and nothing otherwise.
            respelledVisibleDelta = [...insertText].length - (routed.healed ? 1 : 0)
          } else if (routed.code !== KERNEL_CODES.NOT_STRUCTURAL) {
            // The offset IS one CommonMark strips and no spelling could be
            // proven: writing the literal byte would be writing a byte we have
            // just proven dead. Refuse loudly instead.
            return { ok: false, code: routed.code }
          }
        }
      }
    }
    // THE DELETE SIDE (2026-08-19, audit findings). Everything above is an
    // INSERT-path design: `blockEditIsObservable` is a genuine fail-closed
    // pre-write proof, and until now NO delete path consulted it. The
    // `observability` expectation recorded below DOES cover deletes, but it
    // fires after publication and only logs — by which time
    // `verifyPlainTextProjection` has repaired the VIEW to match the corrupted
    // bytes, which is what makes this family permanent and invisible.
    //
    // Two distinct shapes, both proven BEFORE a byte moves:
    //
    //  (1) A delete that empties a physical line inside a MULTI-LINE block
    //      leaves bytes CommonMark reads as a blank line or a setext underline:
    //      'alpha  ' LF 'b  ' LF 'gamma' -> Backspace after 'b' -> two
    //      paragraphs with both hard breaks gone; the nested-list spelling turns
    //      the outer item into a HEADING and destroys a list level. The
    //      soft-break spelling ('a' LF 'b' LF 'c') has the same shape and is
    //      pre-existing. `proveContentDelete` reparses the candidate and
    //      REFUSES what it cannot prove — a delete has no second spelling that
    //      is obviously the user's intent, and inventing one (swallowing a
    //      neighbouring line ending) is the guess this whole family began as.
    //
    //  (2) A delete that strands a literal ASCII space at a block END recreates
    //      the original dead-byte defect and then misplaces the NEXT character
    //      in front of it: 'ab c' + Backspace committed 'ab ' (view 'ab'), and
    //      typing 'd' then produced 'abd ' — the user typed `ab d`.
    //      `spellBlockTailDelete` re-spells that one space U+00A0 in the SAME
    //      edit, exactly as the insert path does, so the existing heal turns it
    //      back into an ordinary space the moment a character displaces it.
    //
    // Both prefilters are parse-free and the commands spend a parse only once
    // their O(1) checks already establish the shape, so ordinary deleting pays
    // comparisons.
    if (steps.length === 1 && oldFrom < oldTo && virtualPrefix === '' && !virtualBlock &&
        stepPair && !stepPair.virtual && stepPair.charMap && stepPair.mdBlock) {
      if (deleteClearsBlockLine({
        text: kernel.doc.text,
        charMap: stepPair.charMap,
        block: stepPair.mdBlock,
        from: editFrom,
        to: editTo,
        insert: insertText
      })) {
        const routed = proveContentDelete({
          doc: kernel.doc,
          block: stepPair.mdBlock,
          from: editFrom,
          to: editTo,
          insert: insertText
        })
        // No `not-structural` fall-through: the prefilter has already
        // established that this delete blanks a line inside a multi-line block,
        // so "could not prove it" must refuse, never degrade to the literal
        // bytes that restructure the document.
        if (!routed.ok) return { ok: false, code: routed.code }
      }
      const stranded = spellBlockTailDelete({
        doc: kernel.doc,
        block: stepPair.mdBlock,
        charMap: stepPair.charMap,
        from: editFrom,
        to: editTo,
        insert: insertText
      })
      if (stranded.ok) {
        editFrom = stranded.edit.from
        editTo = stranded.edit.to
        insertText = stranded.edit.insert
        // `respelledVisibleDelta` stays null ON PURPOSE: the re-spelling swaps
        // one ASCII space for one U+00A0, both a width-1 `char` unit, so the
        // block's visible length moves by exactly the PM step's own delta and
        // the default expectation below is already the right one.
      } else if (stranded.code !== KERNEL_CODES.NOT_STRUCTURAL) {
        // The byte IS one CommonMark discards and no spelling could be proven
        // (an ambiguous run, a tab): refuse rather than strand it.
        return { ok: false, code: stranded.code }
      }
    }
    edits.push({
      from: editFrom,
      to: editTo,
      insert: virtualPrefix + insertText
    })
    records.push({
      pair: virtualBlock ? null : stepPair,
      from: editFrom,
      to: editTo,
      insert: virtualPrefix + insertText
    })
    // Record what the edited block's VISIBLE length must become, for the
    // post-commit observability check (see the ADR on this function's return).
    // Only the simple, overwhelmingly common shape is claimed: ONE step, into a
    // real (non-virtual, non-code) mapped block, with no line breaks. Anything
    // else reports nothing rather than a number it cannot justify.
    if (steps.length === 1 && stepPair && !stepPair.virtual && stepPair.charMap &&
        Number.isFinite(stepPair.pmPos) && Number.isFinite(stepPair.charMap.visibleLength) &&
        stepPair.mdBlock?.type !== 'code' && !/[\r\n]/.test(step.insertText)) {
      observability = {
        pmPos: stepPair.pmPos,
        // `respelledVisibleDelta` is set by the whitespace commands, which know
        // that what they WROTE is not what ProseMirror inserted (a Tab becomes
        // two no-break spaces; a heal replaces a whole unit). Everywhere else
        // the projection and the source agree character for character.
        expectedVisibleLength: stepPair.charMap.visibleLength +
          (respelledVisibleDelta ?? step.insertText.length - (step.to - step.from))
      }
    }
    // PM-side delta (never the raw insert with its separator prefix, and
    // never the EXPANDED raw insert either): this rebases later steps' PM
    // coordinates, which are counted in PM's own un-normalized text units (a
    // '\n' is exactly ONE PM character, same as any other) and know nothing
    // about raw separator/expansion bytes.
    cumulativeDelta += step.insertText.length - (step.to - step.from)
  }

  // THE MULTI-STEP DELETE GATE (2026-08-19, audit hole 6). Both delete guards
  // above are gated on `steps.length === 1`, so a BATCH of ReplaceSteps that
  // deletes reached neither of them — the same corruption class the audit rated
  // Critical, one coordinate space over, and the reason it was left open is
  // simply that no reproduction produced a multi-step delete. "Not observed" is
  // not a proof.
  //
  // The PREFILTER is asked of the whole batch at once (two steps that each
  // remove half of a line's content each see the other half surviving, so a
  // per-step prefilter would answer "nothing was blanked" for a batch that
  // blanks the line); the PROOF is then run step by step against intermediate
  // candidates that are never published, because a composition of proven steps
  // is proven and the single-step proof's own sentence — one contiguous
  // replacement — is not true of a composition. Both live in
  // `proveBatchDelete` (commands/content-delete.js), sharing this file's
  // single-step prefilter implementation so the two answers cannot drift.
  //
  // A removing step whose pair is missing, virtual, or whose raw range escapes
  // its own block is refused outright: it is a delete no prefilter can even be
  // evaluated for, which is exactly the shape that must not pass unproven.
  if (steps.length > 1 && records.some((record) => record.to > record.from)) {
    // Grouped by TARGET BLOCK, and every step into a block that this batch
    // deletes from belongs to its group — inserts included: a character typed
    // onto the same line is part of the same composed result and is exactly what
    // decides whether that line still holds content.
    const groups = new Map()
    for (const record of records) {
      if (!record.pair) continue
      if (!groups.has(record.pair)) groups.set(record.pair, [])
      groups.get(record.pair).push(record)
    }
    for (const record of records) {
      if (record.to === record.from) continue
      const pair = record.pair
      if (!pair || pair.virtual || !pair.charMap || !pair.mdBlock) {
        return { ok: false, code: KERNEL_CODES.UNSUPPORTED }
      }
      const group = groups.get(pair)
      const blockStart = pair.mdBlock.position?.start?.offset
      const blockEnd = pair.mdBlock.position?.end?.offset
      // Every step in this block's group must be inside the block's own span, or
      // the composed change is one no prefilter can even be evaluated for —
      // which is precisely the shape that must not pass unproven.
      if (!Number.isInteger(blockStart) || !Number.isInteger(blockEnd) ||
          group.some((entry) => entry.from < blockStart || entry.to > blockEnd)) {
        return { ok: false, code: KERNEL_CODES.UNSUPPORTED }
      }
      const proven = proveBatchDelete({
        doc: kernel.doc,
        charMap: pair.charMap,
        block: pair.mdBlock,
        edits: group
      })
      // `not-structural` is this command's "nothing here applies" answer — the
      // batch is not the at-risk shape and keeps its pre-existing bytes.
      if (!proven.ok && proven.code !== KERNEL_CODES.NOT_STRUCTURAL) {
        return { ok: false, code: proven.code }
      }
    }
  }

  const transaction = { baseRevision: kernel.doc.revision, edits, intent: 'insert-text' }
  const result = applySourceTransaction(kernel.doc, transaction)
  if (!result.ok) return { ok: false, code: result.code }
  // The reparse proof runs BEFORE this function reports success — the caller
  // (editor-kernel-mode.js's `plain-text` case) advances `kernel.doc` from
  // `committed.applied`, so a refusal here means the bytes were never
  // published and the PM transaction is vetoed with the view untouched.
  if (touchedTableCell && !tableStructurePreserved(kernel, kernel.doc.text, result.doc.text)) {
    return { ok: false, code: KERNEL_CODES.UNSUPPORTED }
  }
  return { ok: true, applied: result, transaction, observability }
}

// commitTaskToggle: turns a `task-toggle`-classified batch (see
// `extractTaskToggleStep` above) into ONE `toggleTaskMarker` kernel
// transaction and applies it. Re-derives the target position's raw offset
// independently rather than trusting a caller-supplied result, same
// contract as `commitPlainText`.
//
// `pos` is the `list_item` node's own PM position (right before it, the
// `AttrStep`/`nodeAt` convention). Its raw counterpart is reached by
// stepping into the first child's content: `pos + 1` is the first child's
// own position (a task item's content is always wrapped in one `paragraph`,
// same schema shape `buildProjectionMap` pairs against), and `pos + 2` is
// that paragraph's content start, which is exactly the `contentPos` a
// `blockPairs` entry for it exposes. If the first child is anything other
// than the expected mapped textblock (a shape `buildProjectionMap` did not
// pair), `pmPosToRaw` finds no covering block and fails closed with
// `UNMAPPED` — this function never assumes the schema shape, only checks it
// through the proven map.
export function commitTaskToggle({ kernel, map, pos }) {
  if (!kernel?.doc || !map || typeof map.pmPosToRaw !== 'function') {
    return { ok: false, code: KERNEL_CODES.UNMAPPED }
  }
  if (!Number.isFinite(pos)) return { ok: false, code: KERNEL_CODES.UNMAPPED }
  const raw = map.pmPosToRaw(pos + 2)
  if (!Number.isFinite(raw)) return { ok: false, code: KERNEL_CODES.UNMAPPED }

  const index = buildSyntaxIndex(kernel.doc.text)
  const routed = toggleTaskMarker({ doc: kernel.doc, index, offset: raw })
  if (!routed.ok) return { ok: false, code: routed.code }

  const result = applySourceTransaction(kernel.doc, routed.transaction)
  if (!result.ok) return { ok: false, code: result.code }
  return { ok: true, applied: result, transaction: routed.transaction }
}

// commitCodeLanguage: turns a `code-language`-classified batch (see
// `extractLanguageStep` above) into ONE `changeCodeLanguage` kernel
// transaction and applies it. Re-derives the target block independently
// rather than trusting a caller-supplied result, same contract as
// `commitPlainText`/`commitTaskToggle`.
//
// `pmPos` is the `code_block` node's own PM position — the `AttrStep`/
// `nodeAt` convention (matching `extractLanguageStep`'s `step.pos`), NOT a
// content position, so it is looked up directly against `map.blockPairs`
// (a plain array search — the brief's "or reuse blockPairs lookup" option)
// rather than through `pairAt`, which resolves CONTENT positions. The pair
// carries its `mdBlock` (the mdast `code` node) even when `charMap` is null
// (`buildProjectionMap` always records `mdBlock`, editable or not — see its
// `pmType === 'code_block'` branch) — which is exactly what makes a switch
// FROM a currently-readonly target (mermaid/latex -> a real language) work
// now that `extractLanguageStep` no longer refuses it at classification
// time (final-review fix, 2026-08-16): a null-charMap pair falls back to
// `start` (the fence's own start offset, always present) as the anchor
// `changeCodeLanguage` resolves the block from — `index.blockAt(start)`
// finds the same code block a charMap-derived offset would, so there is no
// correctness gap. When the pair DOES carry a charMap (the common, already-
// editable case), its own content-start raw offset (`charMap.visibleToRaw(0)`)
// is passed instead, as the caret-preservation anchor — a reasonable
// stand-in for "the block's content start" since the gateway has no access
// to the live view's actual selection here (the original AttrStep
// transaction, selection untouched, is what the caller lets through to the
// view on success — see editor-kernel-mode.js's `code-language` case).
export function commitCodeLanguage({ kernel, index, map, pmPos, language }) {
  if (!kernel?.doc || !map || !Array.isArray(map.blockPairs)) {
    return { ok: false, code: KERNEL_CODES.UNMAPPED }
  }
  if (!Number.isFinite(pmPos)) return { ok: false, code: KERNEL_CODES.UNMAPPED }
  const pair = map.blockPairs.find((candidate) => candidate.pmPos === pmPos)
  const start = pair?.mdBlock?.position?.start?.offset
  if (!pair || !Number.isFinite(start)) return { ok: false, code: KERNEL_CODES.UNMAPPED }
  const anchor = pair.charMap ? pair.charMap.visibleToRaw(0) : start
  const offset = Number.isFinite(anchor) ? anchor : start

  const syntaxIndex = index || buildSyntaxIndex(kernel.doc.text)
  const routed = changeCodeLanguage({ doc: kernel.doc, index: syntaxIndex, offset, language })
  if (!routed.ok) return { ok: false, code: routed.code }

  const result = applySourceTransaction(kernel.doc, routed.transaction)
  if (!result.ok) return { ok: false, code: result.code }
  return { ok: true, applied: result, transaction: routed.transaction }
}

// commitImageAttrs: turns an `image-attrs`-classified batch (see
// `extractImageAttrStep` above) into ONE `setImageAttrs` kernel transaction
// and applies it. Same contract as `commitCodeLanguage`: the raw anchor AND
// the ratio-in-alt safety predicate are both re-derived through the proven
// projection map, never taken from the caller.
//
// The two image shapes reach their raw anchor by different, equally proven
// routes — and neither needs the pair to be EDITABLE:
//   * `image-block` is a block-level ATOM, so `buildProjectionMap` pairs it
//     with the mdast `paragraph` that wraps the image and (correctly) gives it
//     `charMap: null` — an atom has no character content to map. Its anchor is
//     the mdast `image` child's OWN start offset, which the projection map has
//     already shape-guarded (`children.length === 1 && children[0].type ===
//     'image'`). This is exactly the `commitCodeLanguage` posture: an
//     attribute route does not require a character map, only a proven block
//     pair — which is why image-block pairs stay non-editable (see the task
//     report's editable-vs-attr-route decision).
//   * an INLINE `image` is a width-1 atom UNIT inside its paragraph's charMap,
//     so its PM position resolves through the ordinary `pmPosToRaw` — the
//     atom's own `rawStart`, i.e. the `!` of `![alt](src)`.
// `setImageAttrs` then re-derives the image node from that offset itself and
// refuses anything it cannot prove byte-for-byte.
export function commitImageAttrs({ kernel, index, map, pmPos, blockImage, attr, value }) {
  if (!kernel?.doc || !map) return { ok: false, code: KERNEL_CODES.UNMAPPED }
  if (!Number.isFinite(pmPos)) return { ok: false, code: KERNEL_CODES.UNMAPPED }
  if (!IMAGE_SOURCE_ATTRS.has(attr) || typeof value !== 'string') {
    return { ok: false, code: KERNEL_CODES.INPUT_TYPE }
  }

  let offset = null
  if (blockImage) {
    const pair = Array.isArray(map.blockPairs)
      ? map.blockPairs.find((candidate) => candidate.pmPos === pmPos)
      : null
    // RE-DERIVED, NOT TRUSTED (review finding, 2026-08-17). The ratio-in-alt
    // refusal used to live ONLY in `extractImageAttrStep`, so this function —
    // which every other guard at this boundary re-proves from the map — took
    // the single datum deciding whether writing `alt` is SAFE on trust from
    // its caller. Probed: calling this directly with `attr:'alt'` on
    // `'![1.50](x.png "说明")'` wrote `'![user alt](x.png "说明")'` and
    // destroyed the persisted resize. The pair already carries the live PM
    // node, so the same predicate is re-applied here against proven state.
    if (isResizedImageBlock(pair?.pmNode)) return { ok: false, code: KERNEL_CODES.UNSUPPORTED }
    const children = pair?.mdBlock?.children
    const image = Array.isArray(children) && children.length === 1 && children[0]?.type === 'image'
      ? children[0]
      : null
    offset = image?.position?.start?.offset ?? null
  } else if (typeof map.pmPosToRaw === 'function') {
    offset = map.pmPosToRaw(pmPos)
  }
  if (!Number.isFinite(offset)) return { ok: false, code: KERNEL_CODES.UNMAPPED }

  const syntaxIndex = index || buildSyntaxIndex(kernel.doc.text)
  const routed = setImageAttrs({ doc: kernel.doc, index: syntaxIndex, offset, [attr]: value })
  if (!routed.ok) return { ok: false, code: routed.code }

  const result = applySourceTransaction(kernel.doc, routed.transaction)
  if (!result.ok) return { ok: false, code: result.code }
  return { ok: true, applied: result, transaction: routed.transaction }
}

// routeLinkEdit: turns a `link-edit`-classified batch (see `extractLinkEdit`
// above) into ONE `applyLinkEdit` kernel transaction — and, unlike every
// other commit function in this file, deliberately does NOT apply it.
//
// The PM transaction the tooltip dispatched is ALWAYS vetoed for links (the
// mark-toggle posture, not the AttrStep posture): the committed `[text](url)`
// bytes have to be REPARSED for the view to show what CommonMark actually
// makes of them — an escaped label, a title the user never touched, a
// destination that had to take the `<...>` form. So the caller
// (editor-kernel-mode.js's `link-edit` case) needs the transaction itself, to
// push through `applyKernelTransaction(..., { requireMap: true })`, which is
// what proves the RESULT document still maps before anything is committed.
//
// The PM->visible conversion is the same identity the mark-toggle route uses:
// a block pair's content starts at `pmPos + 1`, so `visible = pmPos -
// contentPos`. Virtual pairs (trailing/split placeholders, empty list items)
// have no real bytes and are excluded by the caller's `editablePairForRange`.
export function routeLinkEdit({ kernel, index, pair, op, pmFrom, pmTo, href, insertedText }) {
  // `pair.virtual` is re-checked here, not just inherited from the caller's
  // `editablePairForRange`: a placeholder pair (trailing/split placeholder,
  // empty list item) has no real source bytes, and taking "is this a real
  // block?" on trust from the caller is exactly the fail-open shape the image
  // route's ratio guard was corrected for (61f8b9c). One line, closed here.
  if (!kernel?.doc || !pair?.charMap || pair.virtual) return { ok: false, code: KERNEL_CODES.UNMAPPED }
  if (!Number.isFinite(pmFrom) || !Number.isFinite(pmTo)) return { ok: false, code: KERNEL_CODES.UNMAPPED }
  const contentPos = pair.pmPos + 1
  const syntaxIndex = index || buildSyntaxIndex(kernel.doc.text)
  const routed = applyLinkEdit({
    doc: kernel.doc,
    index: syntaxIndex,
    map: pair.charMap,
    visFrom: pmFrom - contentPos,
    visTo: pmTo - contentPos,
    op,
    href,
    insertedText
  })
  if (!routed.ok) return { ok: false, code: routed.code }
  return { ok: true, transaction: routed.transaction }
}
