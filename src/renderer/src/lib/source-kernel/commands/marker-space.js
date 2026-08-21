// 标记补全空格：`- ` `1. ` `> ` `## ` `- [ ] ` 里的那个空格是 Markdown 语法，
// 不是内容——它把一段已经打出来的标记字符变成真正的块结构。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
//
// WHY THIS COMMAND EXISTS
// -----------------------
// Typing `- ` on a line is THE fundamental Markdown gesture, and in kernel mode
// it did not work — in any of its three positions, and for none of the five
// marker families. Measured in the built app (2026-08-20, one real keydown at a
// time, source view and rendered blocks both read back):
//
//   position                     typed    outcome BEFORE this command
//   ---------------------------  -------  ---------------------------------------
//   empty paragraph              `- `     the `-` byte lands, the reparse makes an
//                                         EMPTY LIST ITEM WITH NO SPACING, and the
//                                         Space is refused (`unsupported-structure`)
//                                         — the user is left in a block they can
//                                         never type into
//   empty paragraph              `1. `    same
//   empty paragraph              `> `     same
//   empty paragraph              `# `     same, and the refusal is 「只读」: an
//                                         empty ATX heading with no spacing has no
//                                         provable content start
//   empty paragraph              `## `    same
//   paragraph start (has text)   `- `     the preset input rule fires, the gateway
//                                         vetoes its NODE transaction
//                                         (`unsupported-input-type`), and the `-`
//                                         is left sitting in the text
//   paragraph start (has text)   `1. `    same
//   paragraph start (has text)   `# `     same
//   paragraph start (has text)   `## `    same
//   list item, text start        `- `     the Space is RE-SPELLED to U+00A0
//                                         (`- -<U+00A0>x`) — no nested list, and no
//                                         message at all
//   list item, text start        `1. `    same
//
// THREE DIFFERENT INTERCEPTIONS, ONE MISSING RULE. They look unrelated and they
// are not:
//   (a) EMPTY BLOCK. The kernel is byte-first, so the FIRST marker character is
//       already syntax: `-` alone is a valid empty list item, `#` alone a valid
//       empty heading. The reconcile therefore converts the block immediately,
//       which destroys the preset input rule's own precondition (a literal `-`
//       sitting in the textblock in front of the caret) before the Space ever
//       arrives. The Space then lands on a block whose content anchor is
//       unprovable precisely BECAUSE the marker has no spacing yet — the one
//       byte that would fix it is the one being refused.
//   (b) NON-EMPTY BLOCK. `-甲` is still a paragraph, so the input rule DOES
//       fire — and produces a node-content transaction, which the gateway
//       vetoes by design (it owns the bytes; a wrapInBlockType carries none).
//   (c) INSIDE A LIST ITEM. No rule fires and no veto happens, so the Space
//       reaches the byte path, where the line-start whitespace re-speller claims
//       it: at an item's text start an ASCII space IS ordinarily stripped, so it
//       is re-spelled U+00A0 — correct for CONTENT, wrong for this byte.
//
// THE RULE, and it is the whole fix: WHITESPACE THAT COMPLETES A MARKER IS
// SYNTAX, NOT CONTENT. The re-speller exists to preserve whitespace that would
// otherwise be stripped AS CONTENT; a Space completing `- ` / `1. ` / `> ` /
// `# ` / `- [ ] ` is consumed as marker padding, so re-spelling it (or vetoing
// it, or refusing it) preempts block creation entirely.
//
// WHAT IS WRITTEN: a LITERAL ASCII space, at exactly the offset the caret sits
// at. That is the byte Markdown means here, in every one of the positions above
// — `-` + ' ' = `- `, `-甲` + ' ' = `- 甲`, `- -乙` + ' ' = `- - 乙`.
//
// NOTHING IS DECIDED FROM THE PROSE ABOVE. The command builds the candidate,
// REPARSES it, and requires the kernel's own syntax index to report the marker
// took effect — the right structure, anchored at the typed marker's own start,
// with its content beginning exactly one byte past the written space. A shape
// that cannot be proven answers `not-structural`, and the caller keeps exactly
// its previous behaviour (the input rule, the re-speller, the refusal), so this
// command can only ever ADD a working gesture, never take one away.
//
// WHY THE PROOF IS NOT `blockEditIsObservable` (the whitespace family's tool):
// that helper is stated about a block that still exists after the edit and asks
// whether its TEXT changed observably. Here the block deliberately changes TYPE
// and the written byte deliberately becomes invisible — the two premises it
// rests on are both false by design. The claim being made is structural, so the
// proof is structural.
import { buildSyntaxIndex } from '../syntax-index.js'
import { looksLikeBlockLineStart } from './line-start-whitespace.js'

const NOT_STRUCTURAL = { ok: false, code: 'not-structural' }

// The marker token a Space completes, matched at the END of the bytes before
// the caret. One alternative per CommonMark/GFM marker family:
//   [-+*]        bullet
//   \d{1,9}[.)]  ordered (CommonMark caps the digits at 9)
//   >            block quote
//   #{1,6}       ATX heading
//   \[[ xX]\]    GFM task checkbox (completes `- [ ] `; the `- ` in front of it
//                is ordinary prefix, checked by the prefilter below)
// Anchored with `$` so it describes the bytes IMMEDIATELY before the caret —
// this is a prefilter, and the reparse is what decides.
const MARKER_TOKEN = /(?:[-+*]|\d{1,9}[.)]|>|#{1,6}|\[[ xX]\])$/

// Verbatim blocks: their leading whitespace is real content, already
// byte-preserved, and no marker means anything inside them. The reparse proof
// would refuse these anyway (a `- ` inside a fence is still fence content, so
// no list item appears); the check is here so the common case never spends a
// parse.
const VERBATIM = new Set(['code', 'math'])

// The mdast node the typed marker claims to have created, taken from the
// candidate's own tree: the DEEPEST node of `type` that begins exactly at
// `markerStart`. Deepest matters for a same-line nesting (`- - x`), where the
// inner `list` and its `listItem` share a start offset and it is the ITEM that
// speaks for the marker. `parent` comes back with it because a list item's
// bullet/ordered nature is a property of the list around it.
const nodeStartingAt = (tree, type, markerStart) => {
  let found = null
  const walk = (node, parent) => {
    if (node.type === type && node.position?.start?.offset === markerStart) found = { node, parent }
    for (const child of node.children || []) walk(child, node)
  }
  walk(tree, null)
  return found
}

// Where this structure's CONTENT begins, or null when it has none. A node's own
// position INCLUDES its marker syntax (an mdast `heading` spans `# ` too), so
// the marker/content boundary is only visible from the first CHILD — which is
// exactly the boundary this proof is about.
const contentStartOf = (node) => {
  const first = (node?.children || [])[0]
  const start = first?.position?.start?.offset
  return Number.isInteger(start) ? start : null
}

// THE PROOF, stated once for every family: after writing the space, the bytes
// really do carry the structure the typed marker names, anchored at that
// marker's own start — AND the space we wrote is NOT part of that structure's
// content, i.e. it was consumed as marker padding. That second half is the
// whole claim ("this whitespace is syntax"), and it is checked against the
// reparse rather than argued from the grammar.
//
// A structure with NO content at all (`- `, `# `, `> ` on their own line) passes
// the second half trivially and correctly: there is no content for the space to
// have landed in. Those are the shapes the empty-paragraph gesture produces, and
// they are exactly the ones that were unreachable before.
const provenMarker = (candidate, markerStart, offset, token) => {
  const index = buildSyntaxIndex(candidate)
  const contentIsPastTheSpace = (node) => {
    const start = contentStartOf(node)
    return start === null || start > offset
  }
  if (token === '>') {
    const hit = nodeStartingAt(index.tree, 'blockquote', markerStart)
    return !!hit && contentIsPastTheSpace(hit.node)
  }
  if (token[0] === '#') {
    const hit = nodeStartingAt(index.tree, 'heading', markerStart)
    return !!hit && hit.node.depth === token.length && contentIsPastTheSpace(hit.node)
  }
  if (token[0] === '[') {
    // A GFM checkbox belongs to an item whose own marker starts EARLIER, so the
    // item is resolved by containment rather than by start offset. `checked`
    // being a boolean is the parser's own statement that `[ ]` became a task
    // marker — which it only does when a space follows it.
    const item = index.listItemAt(markerStart)
    if (!item) return false
    const hit = nodeStartingAt(index.tree, 'listItem', item.start)
    return !!hit && typeof hit.node.checked === 'boolean' && contentIsPastTheSpace(hit.node)
  }
  const hit = nodeStartingAt(index.tree, 'listItem', markerStart)
  if (!hit || !contentIsPastTheSpace(hit.node)) return false
  // A bullet token must produce a bullet item and an ordered token an ordered
  // one — without this, a proof for `1.` would accept a bullet list and vice
  // versa, which is not the structure the user asked for.
  return /^\d/.test(token) ? !!hit.parent?.ordered : !hit.parent?.ordered
}

// Inputs (all from state the caller already holds):
//   doc     the kernel document (`text` + `revision`)
//   offset  the raw offset the caret sits at, i.e. where the Space would go
export function spellMarkerCompletingSpace({ doc, offset }) {
  const text = doc?.text
  if (typeof text !== 'string' || !Number.isInteger(doc?.revision)) return NOT_STRUCTURAL
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return NOT_STRUCTURAL

  // The byte AFTER the caret decides whether this is a COMPLETION at all. If a
  // space or tab already follows, the marker is already complete and the typed
  // character is ordinary padding — which belongs to the line-start
  // re-speller, not here. Leaving that case alone is what keeps every existing
  // whitespace guarantee intact.
  const next = text[offset]
  if (next === ' ' || next === '\t') return NOT_STRUCTURAL

  const index = buildSyntaxIndex(text)
  const line = index.lineAt(offset)
  if (!line || offset < line.start) return NOT_STRUCTURAL
  const baseline = index.blockAt(offset) || index.blockAt(Math.max(0, offset - 1))
  if (baseline && VERBATIM.has(baseline.type)) return NOT_STRUCTURAL

  const match = MARKER_TOKEN.exec(text.slice(line.start, offset))
  if (!match) return NOT_STRUCTURAL
  const token = match[0]
  const markerStart = offset - token.length
  // Everything between the typed marker and the start of the physical line must
  // be bytes a line's own structural prefix can be made of (indentation, quote
  // markers, an enclosing list marker). Same backwards walk the line-start
  // whitespace prefilter uses, and like it, only a NECESSARY condition.
  if (!looksLikeBlockLineStart(text, markerStart)) return NOT_STRUCTURAL

  const candidate = text.slice(0, offset) + ' ' + text.slice(offset)
  if (!provenMarker(candidate, markerStart, offset, token)) return NOT_STRUCTURAL

  const caret = offset + 1
  return {
    ok: true,
    marker: token,
    edit: { from: offset, to: offset, insert: ' ' },
    transaction: {
      baseRevision: doc.revision,
      from: offset,
      to: offset,
      insert: ' ',
      intent: 'marker-completing-space',
      selection: { anchor: caret, head: caret }
    }
  }
}

// MARKER-FOLLOWING TEXT — the second half of the bare-marker rule, and the
// exit `spellMarkerCompletingSpace` deliberately does not own.
//
// A bare marker (`*`, `-`, `+`, `1.`, `#`…) is an AMBIGUOUS intermediate
// state: the kernel is byte-first, so the single character is already valid
// syntax (an empty list item, an empty heading) and the reconcile converts
// the block immediately. The NEXT keystroke resolves the ambiguity:
//   * whitespace  -> the marker was SYNTAX; the space completes it
//                    (`spellMarkerCompletingSpace` above);
//   * ordinary text -> the marker was CONTENT all along; `*` + `a` = the
//                    literal paragraph `*a`, which is exactly what the bytes
//                    `*a` already reparse to.
// Before this command the second exit did not exist: the empty structure has
// no provable content anchor (its charMap is null by design), so the typed
// character either refused or — worse, measured 2026-08-21 in the built app —
// landed in whatever block the reconcile had thrown the caret into, severing
// the text from its marker (`*` then `a` produced `*\n\na`: a dead empty
// list plus a separate paragraph, with no toast).
//
// NOTHING IS DECIDED FROM THE GRAMMAR. Same posture as the Space half: the
// command builds the candidate bytes, REPARSES them, and requires the
// DEMOTION to be visible in the kernel's own parse — a literal text node
// spelling exactly `marker + typed` starting at the marker's own offset. A
// shape that cannot be proven answers `not-structural` and the caller keeps
// exactly its previous behavior, so this command can only ever ADD a working
// gesture.
//
// `>` IS DELIBERATELY NOT CLAIMED: a bare `>` already pairs editable through
// the projection map's empty-quote virtual anchor (`emptyQuoteContentStart`),
// so typing after it commits through the ordinary plain-text path — claiming
// it here would give one byte two owners. Whitespace of any kind (including
// U+00A0, which the whitespace-provenance ledger owns) is refused for the
// same one-owner reason.
const nodeTypeForToken = (token) =>
  (token[0] === '#' ? 'heading' : 'listItem')

export function spellMarkerFollowingText({ doc, offset, text: typed }) {
  const text = doc?.text
  if (typeof text !== 'string' || !Number.isInteger(doc?.revision)) return NOT_STRUCTURAL
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return NOT_STRUCTURAL
  if (typeof typed !== 'string' || typed.length === 0) return NOT_STRUCTURAL
  // Any whitespace (ASCII or Unicode — /\s/ includes U+00A0) belongs to the
  // completion / re-speller family; a line ending could never be one edit.
  if (/\s/.test(typed)) return NOT_STRUCTURAL

  // CHEAP PREFILTER FIRST — before any parse (review condition, 2026-08-21).
  // This command sits on `handleTextInput`, so it is asked about EVERY
  // non-whitespace character typed in kernel mode; as first landed it paid
  // `buildSyntaxIndex` (a full-document reparse, ~50 ms at 100 KB) before the
  // token check could answer "the byte before the caret is an ordinary
  // letter". The physical line start is findable by string scan alone, and a
  // marker token can never span a line ending (none of its bytes are \r or
  // \n), so this gate refuses exactly the shapes the parse-side re-derivation
  // below refuses at its own MARKER_TOKEN / owner / line-start checks — it
  // only decides whether the parse is worth paying, never differently.
  const guessLineStart = text.lastIndexOf('\n', offset - 1) + 1
  const guess = MARKER_TOKEN.exec(text.slice(guessLineStart, offset))
  if (!guess) return NOT_STRUCTURAL
  if (guess[0] === '>' || guess[0][0] === '[') return NOT_STRUCTURAL
  if (!looksLikeBlockLineStart(text, offset - guess[0].length)) return NOT_STRUCTURAL

  const index = buildSyntaxIndex(text)
  const line = index.lineAt(offset)
  if (!line || offset < line.start) return NOT_STRUCTURAL
  const baseline = index.blockAt(offset) || index.blockAt(Math.max(0, offset - 1))
  if (baseline && VERBATIM.has(baseline.type)) return NOT_STRUCTURAL

  const match = MARKER_TOKEN.exec(text.slice(line.start, offset))
  if (!match) return NOT_STRUCTURAL
  const token = match[0]
  if (token === '>' || token[0] === '[') return NOT_STRUCTURAL
  const markerStart = offset - token.length
  if (!looksLikeBlockLineStart(text, markerStart)) return NOT_STRUCTURAL

  // The marker must CURRENTLY be a bare (empty, spacing-less) structure — that
  // is what makes this a demotion of a committed intermediate state rather
  // than a guess about text that merely ends in a marker character. An empty
  // structure's own node ends exactly at the caret; content or spacing after
  // the marker means some other path (the ordinary character path, the
  // virtual-anchor path) already owns this position.
  const type = nodeTypeForToken(token)
  const bare = nodeStartingAt(index.tree, type, markerStart)
  if (!bare || contentStartOf(bare.node) !== null) return NOT_STRUCTURAL
  if (type === 'heading' && bare.node.depth !== token.length) return NOT_STRUCTURAL
  if (bare.node.position?.end?.offset !== offset) return NOT_STRUCTURAL

  // THE PROOF: after inserting the typed text, the structure at the marker's
  // offset is gone and a literal TEXT node spelling exactly `token + typed`
  // starts there instead — the parser's own statement that the marker
  // demoted to content and the typed character is visible right after it.
  const candidate = text.slice(0, offset) + typed + text.slice(offset)
  const grown = buildSyntaxIndex(candidate)
  if (nodeStartingAt(grown.tree, type, markerStart)) return NOT_STRUCTURAL
  let demoted = null
  const walk = (node) => {
    if (demoted) return
    if (node.type === 'text' && node.position?.start?.offset === markerStart) demoted = node
    for (const child of node.children || []) walk(child)
  }
  walk(grown.tree)
  if (!demoted || !String(demoted.value).startsWith(token + typed)) return NOT_STRUCTURAL

  const caret = offset + typed.length
  return {
    ok: true,
    marker: token,
    edit: { from: offset, to: offset, insert: typed },
    transaction: {
      baseRevision: doc.revision,
      from: offset,
      to: offset,
      insert: typed,
      intent: 'marker-following-text',
      selection: { anchor: caret, head: caret }
    }
  }
}

// ATX HEADING RUN GROWTH — the `##` half of the same rule, and the one shape a
// completing Space alone cannot reach.
//
// `#` is the only marker character that is ALREADY a complete block on its own:
// a bare `#` at a line start is a valid EMPTY ATX heading. So on a blank line
// the first keystroke of `## ` converts the block, and the projection map then
// (correctly) refuses that block a character map, because typing ORDINARY text
// at its content anchor would commit `#x` — a paragraph. The second `#` is
// ordinary text as far as every other layer can tell, so it was refused, with
// the block-scoped 「只读」 message, and `## ` was unreachable while `# ` worked.
// That asymmetry is the diagnostic: `-`, `*`, `+`, `1.`, `>` are single-token
// markers a Space completes in one step, and only the heading family has an
// intermediate state.
//
// The second `#` is not ordinary text: it is the marker run growing. Written
// literally, proven by the same reparse, and refused the moment the result
// stops being a heading of the expected depth — so `#######` (seven) refuses,
// and a `#` typed anywhere a heading does not result refuses too, falling back
// to the ordinary character path unchanged.
const BARE_HASH_RUN = /#{1,5}$/

export function spellMarkerRunGrowth({ doc, offset, character }) {
  const text = doc?.text
  if (character !== '#') return NOT_STRUCTURAL
  if (typeof text !== 'string' || !Number.isInteger(doc?.revision)) return NOT_STRUCTURAL
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return NOT_STRUCTURAL
  const next = text[offset]
  if (next === ' ' || next === '\t') return NOT_STRUCTURAL

  const index = buildSyntaxIndex(text)
  const line = index.lineAt(offset)
  if (!line || offset < line.start) return NOT_STRUCTURAL
  const match = BARE_HASH_RUN.exec(text.slice(line.start, offset))
  if (!match) return NOT_STRUCTURAL
  const run = match[0]
  const markerStart = offset - run.length
  if (!looksLikeBlockLineStart(text, markerStart)) return NOT_STRUCTURAL
  // The run must ALREADY be a heading — that is what makes this "growth" rather
  // than a guess about text that merely looks like hashes.
  const before = index.blockAt(markerStart)
  if (!before || before.type !== 'heading' || before.start !== markerStart) return NOT_STRUCTURAL

  const candidate = text.slice(0, offset) + '#' + text.slice(offset)
  const grown = buildSyntaxIndex(candidate)
  const hit = nodeStartingAt(grown.tree, 'heading', markerStart)
  if (!hit || hit.node.depth !== run.length + 1) return NOT_STRUCTURAL
  const contentStart = contentStartOf(hit.node)
  if (contentStart !== null && contentStart <= offset) return NOT_STRUCTURAL

  const caret = offset + 1
  return {
    ok: true,
    marker: run + '#',
    edit: { from: offset, to: offset, insert: '#' },
    transaction: {
      baseRevision: doc.revision,
      from: offset,
      to: offset,
      insert: '#',
      intent: 'marker-run-growth',
      selection: { anchor: caret, head: caret }
    }
  }
}
