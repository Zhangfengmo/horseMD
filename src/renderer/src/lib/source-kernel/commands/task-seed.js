// 任务种子：`/task` 写入的 U+00A0 占位字符，在第一个正文字符落地时于同一笔编辑中溶解。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。
//
// WHY A SEED EXISTS AT ALL. Probed against the kernel's own parser
// (slash-completion-report.md §3): no ASCII spelling produces an empty GFM
// task item — every one of them comes back `checked === null` with literal
// "[ ]" text. `- [ ] ` + U+00A0 is the ONLY representable form: a real
// `checked: false` item whose paragraph holds one width-1 `char` unit, i.e. a
// caret home. commands/block-insert.js writes it; this module is the exit.
//
// WHY DISSOLVE-BY-DELETION, NOT A HEAL. trailing-whitespace.js heals its own
// U+00A0 back to the ASCII key it STOOD FOR the moment another character
// displaces it. The seed stands for NO key — it exists only because GFM has
// no empty-task spelling — so there is nothing to heal it TO, and both
// candidate ASCII outcomes are wrong (probed, not argued):
//   * healed with no content yet, `- [ ]  ` (trailing ASCII space) is not a
//     task at ALL — the whole item demotes to `checked: null` with literal
//     "[ ]" text: a dead byte AND a destroyed block;
//   * healed under the first label character, `- [ ]  x` IS a task — with
//     label ' x': a space the user never typed, forged into their content.
// A byte the user did not author is exactly what this kernel exists to
// refuse, so the seed's only clean exit is DELETION: when the first label
// character lands, the seed is deleted and the character inserted as ONE
// edit, reparse-proven to yield a task whose label is exactly the typed text.
//
// PROVENANCE IS THE GATE, same ledger as the whitespace heals
// (markdown-document.js `whitespaceMarks`): only a U+00A0 THIS kernel wrote as
// a seed — recorded with `ascii: ''`, "stands for no keystroke" — is ever
// dissolved. A U+00A0 the USER authored has no ledger entry (a freshly opened
// file starts with an empty ledger), and one the whitespace commands wrote
// carries the non-empty ASCII it stands for; neither is claimed here, so the
// three provenances partition cleanly and none can claim another's byte.
//
// WHEN THE PROOF FAILS, THE SEED STAYS (the ruled fallback): this command
// answers `not-structural` and the caller falls through to the ordinary
// literal append — bytes and view then agree on seed + typed text, nothing is
// lost, and saving before typing the label leaves one honest U+00A0 in the
// file (a REAL task that survives reload — strictly better than legacy's
// demote-to-plain-text on save). There is deliberately no refusal exit: every
// unprovable shape has a correct literal spelling.
import { parseKernelMarkdown } from '../syntax-index.js'
import { NO_BREAK_SPACE, blockText, blockEditIsObservable } from './trailing-whitespace.js'

const NOT_STRUCTURAL = { ok: false, code: 'not-structural' }

// Is this list item's ENTIRE content the session-ledgered seed — i.e. a task
// the user created this session and never labelled? The Enter router treats
// such an item as EFFECTIVELY EMPTY (2026-08-21 task-Enter matrix): pressing
// Enter on it takes the same lift-out exit an empty PLAIN item takes, because
// the seed "stands for NO keystroke" — the item is conceptually empty even
// though the parser (correctly) sees one content character. Three facts, all
// required:
//   * a real task item (`task` present — boolean checkbox);
//   * its content span is EXACTLY the one U+00A0 (`[contentStart, end)` —
//     `end` is the mdast item end, so a continuation line or any label byte
//     makes the slice longer and the answer false);
//   * the LEDGER vouches for that byte with the seed provenance
//     (`ascii: ''`). A reopened file's U+00A0 (empty ledger) and a
//     heal-written one (non-empty ascii) both answer FALSE — Enter then
//     splits like any labelled item, and the author's byte is never deleted.
export const isLedgeredSeedOnlyItem = (doc, text, item) => {
  if (!item?.task || typeof text !== 'string') return false
  if (!Number.isInteger(item.contentStart) || !Number.isInteger(item.end)) return false
  if (text.slice(item.contentStart, item.end) !== NO_BREAK_SPACE) return false
  return (doc?.whitespaceMarks || []).some((entry) =>
    entry?.ascii === '' && entry.from === item.contentStart && entry.to === item.contentStart + 1)
}

// Does a ledger-vouched task seed abut the insert offset? Returns
// `{ rawStart, rawEnd }` or null. Parse-free — this runs on the hot typing
// path's prefilter, so it is comparisons only:
//   * a ledger entry with `ascii === ''` (seed provenance, nothing else — the
//     whitespace heals' entries carry the non-empty key they stand for);
//   * whose span still reads as exactly ONE U+00A0 (block-insert writes one);
//   * that the insert ABUTS (typing at the seed's end is the ruled caret
//     position; its start is reachable by Home/click and dissolves to the
//     same bytes);
//   * and that is exactly one width-1 `char` unit of THIS block's character
//     map — the proof the seed is content of the block being typed into, not
//     a coincidentally-adjacent byte of some other block.
export const dissolvableTaskSeed = (text, charMap, marks, offset) => {
  if (typeof text !== 'string' || !Number.isInteger(offset)) return null
  const units = charMap?.units
  if (!Array.isArray(units) || !units.length) return null
  const mark = (marks || []).find((entry) =>
    entry?.ascii === '' &&
    Number.isInteger(entry.from) && Number.isInteger(entry.to) &&
    entry.to === entry.from + 1 &&
    (entry.to === offset || entry.from === offset))
  if (!mark) return null
  if (text.slice(mark.from, mark.to) !== NO_BREAK_SPACE) return null
  const unit = units.find((candidate) => candidate?.rawStart === mark.from && candidate?.rawEnd === mark.to)
  if (!unit || unit.kind !== 'char' || unit.width !== 1) return null
  return { rawStart: mark.from, rawEnd: mark.to }
}

// Dissolve the seed under the first label content: ONE edit replacing the
// seed's span with the typed text, committed only when the candidate is
// REPARSE-PROVEN to be a task whose label is exactly that text.
//
// The proof is `blockEditIsObservable` — the family's ONE observability proof
// (structure signature unchanged, same block at the same offset, span moved
// by exactly the delta, decoded text EXACTLY the typed insert) — plus one
// fact that proof cannot state because it lives on the PARENT: the list item
// is still a task with the SAME `checked` state (a toggle between insert and
// first keystroke must survive — the seed of a `- [x] ` item dissolves to
// `- [x] label`). That costs one extra parse of the candidate, spent only on
// the single keystroke that dissolves a seed, never on ordinary typing.
export function spellTaskSeedInsert({ doc, block, seed, offset, insert }) {
  const text = doc?.text
  if (typeof text !== 'string' || !Number.isInteger(doc?.revision)) return NOT_STRUCTURAL
  if (typeof insert !== 'string' || !insert || /[\r\n]/.test(insert)) return NOT_STRUCTURAL
  if (!seed || !Number.isInteger(seed.rawStart) || seed.rawEnd !== seed.rawStart + 1) return NOT_STRUCTURAL
  if (offset !== seed.rawStart && offset !== seed.rawEnd) return NOT_STRUCTURAL
  if (text.slice(seed.rawStart, seed.rawEnd) !== NO_BREAK_SPACE) return NOT_STRUCTURAL
  // THE LEDGER IS RE-CHECKED HERE, not only in `dissolvableTaskSeed`
  // (2026-08-20 adversarial panel, Minor). This function is the byte-WRITING
  // gate, and until this check it re-proved a caller-supplied descriptor
  // against the bytes alone — so a forged `seed` could spend a U+00A0 the
  // ledger never vouched for (the author's own byte, or a heal-written one
  // standing for a real keystroke) as if it were a seed. Both callers screen
  // through `dissolvableTaskSeed` first, but a provenance decision must not
  // depend on every future caller remembering to: the command demands the
  // `ascii: ''` entry from `doc.whitespaceMarks` itself — the same "a
  // document with no ledger claims NOTHING" posture as
  // `healableTrailingSpace`, enforced where the bytes are written.
  const vouched = (doc.whitespaceMarks || []).some((entry) =>
    entry?.ascii === '' && entry.from === seed.rawStart && entry.to === seed.rawEnd)
  if (!vouched) return NOT_STRUCTURAL
  if (block?.type !== 'paragraph') return NOT_STRUCTURAL
  const blockStart = block.position?.start?.offset
  const blockEnd = block.position?.end?.offset
  if (!Number.isInteger(blockStart) || !Number.isInteger(blockEnd)) return NOT_STRUCTURAL
  if (seed.rawStart < blockStart || seed.rawEnd > blockEnd) return NOT_STRUCTURAL

  let baselineTree
  try {
    baselineTree = parseKernelMarkdown(text)
  } catch {
    return NOT_STRUCTURAL
  }
  // The baseline block AND its list-item parent, re-read from THIS parse (the
  // caller's `block` comes from a map bound to the same bytes, but the proof
  // must not depend on that). `findTaskParagraph` walks with the parent in
  // hand so the two are provably the same node's pair.
  const baseline = findTaskParagraph(baselineTree, block.type, blockStart, blockEnd)
  if (!baseline) return NOT_STRUCTURAL
  if (typeof baseline.item.checked !== 'boolean') return NOT_STRUCTURAL
  // "First content" is literal: the seed must still be the block's ENTIRE
  // decoded content. Any other shape means content already landed without
  // dissolving (unreachable today — every insert into a one-character block
  // abuts it) and is left to the ordinary literal path.
  if (blockText(baseline.paragraph) !== NO_BREAK_SPACE) return NOT_STRUCTURAL

  const candidate = text.slice(0, seed.rawStart) + insert + text.slice(seed.rawEnd)
  const delta = insert.length - 1
  if (!blockEditIsObservable({
    baselineTree,
    block: baseline.paragraph,
    candidate,
    expectedText: insert,
    delta
  })) {
    // The ruled fallback: no refusal — the literal append is correct bytes
    // (seed + typed text, observable on both sides), so fall through.
    return NOT_STRUCTURAL
  }
  let candidateTree
  try {
    candidateTree = parseKernelMarkdown(candidate)
  } catch {
    return NOT_STRUCTURAL
  }
  const dissolved = findTaskParagraph(candidateTree, block.type, blockStart, blockEnd + delta)
  if (!dissolved || dissolved.item.checked !== baseline.item.checked) return NOT_STRUCTURAL
  if (dissolved.item.position?.start?.offset !== baseline.item.position?.start?.offset) {
    return NOT_STRUCTURAL
  }

  const caret = seed.rawStart + insert.length
  return {
    ok: true,
    // Exactly ONE character-map unit (the seed) is consumed by this edit —
    // the caller's observability expectation must subtract it, same contract
    // as the whitespace heals' `healedUnits`.
    dissolvedUnits: 1,
    edit: { from: seed.rawStart, to: seed.rawEnd, insert },
    // Nothing new joins the ledger, and the seed's own entry dies with this
    // edit (markdown-document.js's remap drops any entry the edit overlaps).
    whitespaceMarks: [],
    transaction: {
      baseRevision: doc.revision,
      from: seed.rawStart,
      to: seed.rawEnd,
      insert,
      intent: 'task-seed-dissolve',
      selection: { anchor: caret, head: caret },
      whitespaceMarks: []
    }
  }
}

// THE SEED-DELETE WALL (2026-08-20 adversarial audit, Critical). Backspace on
// a fresh `/task` seed is DOCUMENTED as refused ("empty task unrepresentable"
// — guide 被拒绝的操作, ai-handoff §5.2g), and until this command the wall did
// not exist on any path: the structural route misclassified the seed item as
// empty (syntax-index.js `empty`, fixed alongside this) and silently deleted
// the whole line, and the plain-text delete path would otherwise commit the
// literal removal — `- [ ] ` — which remark-gfm reads as `checked: null` with
// LITERAL "[ ]" text: the checkbox disappears and three characters nobody
// typed appear. Both outcomes are the guard-not-reached corruption shape.
//
// WHAT IS CLAIMED, and only this: a delete (or whitespace-only replace) that
// removes the LEDGER-VOUCHED seed and leaves the task paragraph with no
// parser-visible content must refuse, because no byte spelling of an empty
// task exists (probed: `- [ ] `, `- [ ]  `, `- [ ]\t` all demote). The
// refusal's exits are real and named by its message: undo (the insert is its
// own history step, and history transactions do not pass through this wall),
// or typing the label (an insert with content is not this shape).
//
// WHAT IS NOT CLAIMED: a user-authored U+00A0 (no ledger entry) or a
// heal-written one (non-empty `ascii`) — deleting those is ordinary editing;
// and a delete that leaves other content standing (`- [ ] ` + seed + 'x'
// minus the seed is still a task). Emptying a REAL task's label (no seed
// involved) keeps its pre-existing behaviour — this wall states exactly the
// documented seed contract, nothing broader.
//
// Answers, same three-way contract as proveBatchDelete:
//   NOT_STRUCTURAL       — not the shape; the caller keeps its behaviour.
//   { ok: false, code }  — the shape, and the candidate reparse PROVES the
//                          item stops being a task: the caller MUST refuse.
//   { ok: true }         — the shape, but the candidate provably keeps a task
//                          with the same checked state (unreachable with
//                          today's grammar; stated so the wall dissolves by
//                          itself if GFM ever gains an empty-task spelling).
export const EMPTY_TASK_CODE = 'empty-task-unrepresentable'

export function taskSeedDeleteRefusal({ doc, block, marks, edits }) {
  const text = doc?.text
  if (typeof text !== 'string' || !Array.isArray(edits) || !edits.length) return NOT_STRUCTURAL
  if (block?.type !== 'paragraph') return NOT_STRUCTURAL
  const blockStart = block.position?.start?.offset
  const blockEnd = block.position?.end?.offset
  if (!Number.isInteger(blockStart) || !Number.isInteger(blockEnd)) return NOT_STRUCTURAL
  let removes = false
  for (const edit of edits) {
    if (!Number.isInteger(edit?.from) || !Number.isInteger(edit?.to) || edit.from > edit.to) {
      return NOT_STRUCTURAL
    }
    // Anything escaping the block's own span belongs to the cross-block
    // guards, not to this wall.
    if (edit.from < blockStart || edit.to > blockEnd) return NOT_STRUCTURAL
    const insert = edit.insert ?? ''
    if (typeof insert !== 'string') return NOT_STRUCTURAL
    // An insert carrying any parser-visible content (anything but ASCII
    // space/tab — U+00A0 IS content to remark) keeps the item a task.
    if (/[^ \t]/.test(insert)) return NOT_STRUCTURAL
    if (edit.to > edit.from) removes = true
  }
  if (!removes) return NOT_STRUCTURAL
  const removed = (index) => edits.some((edit) => index >= edit.from && index < edit.to)
  // The seed: a ledger entry with the stands-for-no-keystroke provenance
  // (`ascii: ''`), still reading as exactly one U+00A0 inside THIS block, and
  // fully consumed by the removal — the same three facts dissolvableTaskSeed
  // checks, asked of a delete instead of an insert.
  const seed = (marks || []).find((entry) =>
    entry?.ascii === '' &&
    Number.isInteger(entry.from) && Number.isInteger(entry.to) &&
    entry.to === entry.from + 1 &&
    entry.from >= blockStart && entry.to <= blockEnd &&
    text.slice(entry.from, entry.to) === NO_BREAK_SPACE &&
    removed(entry.from))
  if (!seed) return NOT_STRUCTURAL
  // Surviving content: any block byte outside the removed ranges that is not
  // ASCII space/tab keeps the item a task, and the literal delete is honest.
  for (let index = blockStart; index < blockEnd; index += 1) {
    if (removed(index)) continue
    const ch = text[index]
    if (ch !== ' ' && ch !== '\t') return NOT_STRUCTURAL
  }
  // THE PROOF — the parse decides, never the prose above. Baseline: this
  // paragraph really is a task item's own paragraph (boolean `checked`).
  let baselineTree
  try {
    baselineTree = parseKernelMarkdown(text)
  } catch {
    return { ok: false, code: EMPTY_TASK_CODE }
  }
  const baseline = findTaskParagraph(baselineTree, 'paragraph', blockStart, blockEnd)
  if (!baseline || typeof baseline.item.checked !== 'boolean') return NOT_STRUCTURAL
  const itemStart = baseline.item.position?.start?.offset
  // Candidate: compose the edits (ascending, non-overlapping — the caller's
  // coordinate space) and require the item to still be a task with the SAME
  // checked state. Today it never is — `- [ ] ` demotes — so this refuses.
  let candidate = ''
  let cursor = 0
  for (const edit of [...edits].sort((a, b) => a.from - b.from)) {
    candidate += text.slice(cursor, edit.from) + (edit.insert ?? '')
    cursor = edit.to
  }
  candidate += text.slice(cursor)
  let candidateTree
  try {
    candidateTree = parseKernelMarkdown(candidate)
  } catch {
    return { ok: false, code: EMPTY_TASK_CODE }
  }
  let survives = false
  const walk = (node) => {
    if (survives) return
    if (node?.type === 'listItem' &&
        node.position?.start?.offset === itemStart &&
        node.checked === baseline.item.checked) {
      survives = true
      return
    }
    for (const child of node?.children || []) walk(child)
  }
  walk(candidateTree)
  return survives ? { ok: true } : { ok: false, code: EMPTY_TASK_CODE }
}

// The paragraph at [start, end) whose PARENT is a list item, found in one
// walk so the pair is proven rather than looked up twice.
function findTaskParagraph(tree, type, start, end) {
  let found = null
  const walk = (node, parent) => {
    if (found) return
    if (node?.type === type &&
        node.position?.start?.offset === start &&
        node.position?.end?.offset === end &&
        parent?.type === 'listItem') {
      found = { paragraph: node, item: parent }
      return
    }
    for (const child of node?.children || []) walk(child, node)
  }
  walk(tree, null)
  return found
}
