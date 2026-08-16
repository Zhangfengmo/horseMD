// Root-fix for the legacy-editor CRLF code-block corruption (ai-handoff §5.2e).
//
// CodeMirror 6's Text model structurally strips '\r': EditorState/Text split
// documents on /\r\n?|\n/ (DefaultSplit in @codemirror/state) and re-join
// lines with '\n', so a fenced code block whose ProseMirror text uses '\r\n'
// line endings mounts into CM as an LF-only document. Every CM position past
// the first line break is then short by N (N = number of preceding '\r\n'
// pairs) versus the true PM offset — and the vendored @milkdown/components
// CodeMirrorBlock node view uses the two coordinate spaces interchangeably:
//
//  - CM→PM (`forwardUpdate`, an instance arrow assigned in the constructor):
//    CM changeset coordinates are applied DIRECTLY as PM offsets
//    (`offset + fromA`). Measured in the real app: typing one char at the end
//    of the 3rd block line writes it two chars early, SPLITTING a '\r\n' pair
//    (disk shows `;\rX\n}`); a caret-at-line-start Backspace deletes only the
//    '\r' of the pair, leaving a bare '\n'; inserted breaks arrive as bare
//    '\n' (CM Text.toString() joins with '\n').
//  - PM→CM (`update(node)`): `computeChange(cm.state.doc.toString(),
//    node.textContent)` diffs the LF-only CM string against the CRLF PM
//    string, ALWAYS finds a bogus mid-doc diff, and dispatches insert text
//    still containing '\r\n' + a trailing lone '\r' — which CM's splitter
//    turns into TWO line breaks, so every update() call grows the CM view by
//    a phantom blank line and the two models NEVER converge (verified: the
//    recomputed diff is non-null again right after the dispatch).
//  - PM→CM selection (`setSelection(anchor, head)`): PM node-relative offsets
//    (which count both bytes of every '\r\n') are passed to `cm.dispatch` as
//    CM positions unchanged.
//
// FIX — one bijective position map per call, derived from the node's text:
// only '\r\n' pairs shift coordinates (a pair is 2 PM chars but 1 CM char;
// lone '\r'/'\n' are 1↔1), so with P_i = PM index of pair i, the CM position
// of that break is C_i = P_i - i, and
//    cmToPm(c) = c + |{ i : C_i < c }|      pmToCm(p) = p - |{ i : P_i + 2 <= p }|
// forwardUpdate maps every changeset range through the PRE-edit text's map
// (iterChanges "A" coordinates address exactly that document), converts
// inserted breaks to the block's dominant line ending so endings stay
// uniform, and maps the post-edit CM selection through the POST-edit text's
// map. update() normalizes the PM string to LF before diffing, so the diff
// compares like-for-like, its coordinates are already CM coordinates, and its
// insert text is LF-only (nothing for CM's splitter to double). setSelection
// maps both offsets with pmToCm.
//
// WHY A PROTOTYPE MODIFICATION: same architectural reason as
// editor-codeblock-eager.js (see its header) — `code_block`'s node view is
// registered via `$view` and can be neither overridden through `nodeViewCtx`
// nor through `editorViewOptionsCtx.nodeViews` without clobbering every other
// component view. CodeMirrorBlock IS exported, so the surgical patch lives
// here, in our code, not in node_modules. `forwardUpdate` itself is an
// instance property (constructor arrow), not a prototype method, so it is
// wrapped per-instance from the patched `initializeCodeMirror` — the one
// prototype method every mount path (eager AND lazy re-init after teardown)
// must pass through before the update listener captures `this.forwardUpdate`.
//
// LF documents are untouched: every wrapper delegates to the ORIGINAL
// implementation unless the block's current text actually contains '\r'.
// Kernel mode is also safe: CRLF code blocks are non-editable there (dispatch
// gate + projection-map ADR), but the PM→CM update() path still runs for
// projection resyncs — which this patch makes converge instead of churn.
import { CodeMirrorBlock } from '@milkdown/components/code-block'
import { TextSelection } from '@milkdown/prose/state'
import { EditorState } from '@codemirror/state'

// Guard against Milkdown API drift (mirrors editor-codeblock-eager.js): if a
// future @milkdown/components bump renames these hooks the patch silently
// stops applying — surface that so a version bump doesn't quietly
// re-introduce the CRLF corruption.
if (
  typeof CodeMirrorBlock?.prototype?.initializeCodeMirror !== 'function' ||
  typeof CodeMirrorBlock?.prototype?.update !== 'function' ||
  typeof CodeMirrorBlock?.prototype?.setSelection !== 'function'
) {
  // eslint-disable-next-line no-console
  console.warn('[horsemd] code-block CRLF patch: CodeMirrorBlock API changed — CRLF code-block corruption may return.')
}

const hasCarriageReturn = (text) => typeof text === 'string' && text.indexOf('\r') !== -1

// PM indices of every '\r\n' pair (ascending). Lone '\r'/'\n' don't shift
// positions (1 PM char ↔ 1 CM break) so they are not collected.
function crlfPairIndices(text) {
  const pairs = []
  let index = text.indexOf('\r')
  while (index !== -1) {
    if (text.charCodeAt(index + 1) === 10) {
      pairs.push(index)
      index = text.indexOf('\r', index + 2)
    } else {
      index = text.indexOf('\r', index + 1)
    }
  }
  return pairs
}

// CM position → PM offset: add one for every pair whose CM break position
// (P_i - i) lies strictly before cmPos.
function cmToPm(pairs, cmPos) {
  let low = 0
  let high = pairs.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (pairs[mid] - mid < cmPos) low = mid + 1
    else high = mid
  }
  return cmPos + low
}

// PM offset → CM position: subtract one for every pair that lies fully
// before pmPos. A PM offset BETWEEN the '\r' and '\n' of a pair (no CM
// equivalent) maps just after the break — consistent with cmToPm's rounding.
function pmToCm(pairs, pmPos) {
  let low = 0
  let high = pairs.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (pairs[mid] + 2 <= pmPos) low = mid + 1
    else high = mid
  }
  return pmPos - low
}

// The block's dominant line ending — what an inserted CM '\n' becomes so the
// block's endings stay uniform. Only consulted when the text contains '\r'.
// Tie behavior, precisely: '\r\n' wins any tie IT is part of (crlf >= both
// lone counts), but a lone-'\r' vs lone-'\n' tie WITHOUT any pairs returns
// '\n' (loneCr > loneLf is strict) — a mixed-lone-endings block with no
// '\r\n' has no CRLF preference to honor.
function dominantLineEnding(text) {
  const crlf = (text.match(/\r\n/g) || []).length
  const loneCr = (text.match(/\r(?!\n)/g) || []).length
  const loneLf = (text.match(/(?<!\r)\n/g) || []).length
  if (crlf >= loneCr && crlf >= loneLf) return '\r\n'
  return loneCr > loneLf ? '\r' : '\n'
}

// Local copy of the vendored (un-exported) computeChange — a plain
// minimal-diff over two strings; coordinates are valid in both when the
// strings live in the same coordinate space (which the LF-normalization in
// the patched update() guarantees).
function computeChange(oldVal, newVal) {
  if (oldVal === newVal) return null
  let start = 0
  let oldEnd = oldVal.length
  let newEnd = newVal.length
  while (start < oldEnd && oldVal.charCodeAt(start) === newVal.charCodeAt(start)) ++start
  while (oldEnd > start && newEnd > start && oldVal.charCodeAt(oldEnd - 1) === newVal.charCodeAt(newEnd - 1)) {
    oldEnd--
    newEnd--
  }
  return { from: start, to: oldEnd, text: newVal.slice(start, newEnd) }
}

// CRLF-aware replacement for the constructor-assigned forwardUpdate arrow.
// Mirrors the original's structure exactly (same guards, same tr shape, same
// selection sync) with every coordinate translated between the two spaces.
function crlfForwardUpdate(block, update) {
  const preText = block.node.textContent
  const base = (block.getPos() ?? 0) + 1
  const prePairs = crlfPairIndices(preText)
  const ending = dominantLineEnding(preText)

  // Collect the changeset in PM coordinates + rebuild the post-edit PM text
  // (needed to translate the POST-edit CM selection). iterChanges yields
  // non-overlapping ranges in ascending "A" (pre-edit) order.
  const changes = []
  const parts = []
  let consumed = 0
  update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    const pmFrom = cmToPm(prePairs, fromA)
    const pmTo = cmToPm(prePairs, toA)
    // CM Text content lines never contain '\n'; toString() joins with '\n',
    // so a global replace converts exactly the inserted line breaks.
    const insertText = inserted.toString().replace(/\n/g, ending)
    changes.push({ pmFrom, pmTo, insertText })
    parts.push(preText.slice(consumed, pmFrom), insertText)
    consumed = pmTo
  })
  parts.push(preText.slice(consumed))
  const postText = parts.join('')
  const postPairs = crlfPairIndices(postText)

  const { main } = update.state.selection
  const selFrom = base + cmToPm(postPairs, main.from)
  const selTo = base + cmToPm(postPairs, main.to)
  const pmSel = block.view.state.selection
  if (!update.docChanged && pmSel.from === selFrom && pmSel.to === selTo) return

  const tr = block.view.state.tr
  let shift = 0
  for (const { pmFrom, pmTo, insertText } of changes) {
    if (insertText.length) {
      tr.replaceWith(
        base + pmFrom + shift,
        base + pmTo + shift,
        block.view.state.schema.text(insertText)
      )
    } else {
      tr.delete(base + pmFrom + shift, base + pmTo + shift)
    }
    shift += insertText.length - (pmTo - pmFrom)
  }
  tr.setSelection(TextSelection.create(tr.doc, selFrom, selTo))
  block.view.dispatch(tr)
}

const proto = CodeMirrorBlock.prototype

// (1) CM→PM: wrap the instance forwardUpdate the moment the mount path is
//     about to hand it to CM's updateListener. Wrapped once per instance;
//     initializeCodeMirror is idempotent (`initialized` guard) and is the
//     single entry for BOTH the eager mount (editor-codeblock-eager.js) and
//     the stock lazy/re-init path.
const originalInitialize = proto.initializeCodeMirror
proto.initializeCodeMirror = function crlfAwareInitialize() {
  if (!this.__hmCrlfForwardWrapped && typeof this.forwardUpdate === 'function') {
    this.__hmCrlfForwardWrapped = true
    const originalForwardUpdate = this.forwardUpdate
    this.forwardUpdate = (update) => {
      // Same fast-path guards as the original (kept OUTSIDE the CRLF branch
      // so the LF delegate keeps its exact semantics too).
      if (this.updating || !this.cm.hasFocus) return
      // Bare call is deliberate and only safe because the vendor assigns
      // forwardUpdate as a constructor ARROW — its `this` is lexical, so a
      // call-site receiver is ignored. Do not "fix" this into
      // `.call(this, update)`: it changes nothing today, but if a vendor
      // bump ever turns forwardUpdate into a prototype method this wrapper
      // must be revisited as a whole, not patched at the call site.
      if (!hasCarriageReturn(this.node.textContent)) return originalForwardUpdate(update)
      crlfForwardUpdate(this, update)
    }
  }
  return originalInitialize.call(this)
}

// (2) PM→CM content sync: diff in ONE coordinate space (LF), so the change
//     coordinates are valid CM positions and the insert text carries no '\r'
//     for CM's splitter to double. Only the diff line differs from the
//     vendored update(); everything before it is replicated verbatim.
const originalUpdate = proto.update
proto.update = function crlfAwareUpdate(node) {
  if (node.type !== this.node.type) return false
  if (!hasCarriageReturn(node.textContent)) return originalUpdate.call(this, node)
  if (this.updating) return true
  this.node = node
  this.text.value = node.textContent
  this.language.value = node.attrs.language ?? ''
  if (!this.initialized) {
    const code = this.dom.querySelector('.milkdown-code-block-placeholder code')
    if (code) code.textContent = node.textContent
    return true
  }
  this.updateLanguage()
  if (this.view.editable === this.cm.state.readOnly) {
    this.cm.dispatch({
      effects: this.readOnlyConf.reconfigure(EditorState.readOnly.of(!this.view.editable))
    })
  }
  const normalized = node.textContent.replace(/\r\n?/g, '\n')
  const change = computeChange(this.cm.state.doc.toString(), normalized)
  if (change) {
    this.updating = true
    this.cm.dispatch({
      changes: { from: change.from, to: change.to, insert: change.text },
      scrollIntoView: true
    })
    this.updating = false
  }
  return true
}

// (3) PM→CM selection sync: PM node-relative offsets count both bytes of a
//     '\r\n' pair; CM positions don't. Translate before delegating.
const originalSetSelection = proto.setSelection
proto.setSelection = function crlfAwareSetSelection(anchor, head) {
  const text = this.node.textContent
  if (!hasCarriageReturn(text)) return originalSetSelection.call(this, anchor, head)
  const pairs = crlfPairIndices(text)
  return originalSetSelection.call(this, pmToCm(pairs, anchor), pmToCm(pairs, head))
}
