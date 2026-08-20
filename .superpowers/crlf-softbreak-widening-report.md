# CRLF soft-break widening (2026-08-21) — the queued item, closed

The `.superpowers/sdd/2026-08-17-source-kernel-default-on/progress.md` ledger's
"CRLF soft-break unit widening (queued, next)" item, executed as its own round.
This file is the durable record (the sdd ledger is untracked and lives only in
the main checkout — append the summary below to it when merging).

Branch `kernel/crlf-softbreak-widening` (worktree off 42ef65a, pushed to fork):
`ceb2ec8` fix + `1e3e5dd` docs + this report. Not merged into
`fix/rich-source-sync-architecture` by the session (bg-session git rules);
fast-forward when ready.

## What changed

- **The widening** (`lib/source-kernel/character-map.js` `textUnits`): ONE
  line ending — any spelling: `\n`, `\r\n`, lone `\r` — is ONE width-1
  `linebreak` unit whose raw span swallows the whole ending plus the
  continuation prefix (`consumeSoftBreak`, unchanged). A new `ending` field
  records the VALUE spelling. ProseMirror holds a single `'\n'` character per
  soft break regardless of source spelling (measured; pinned), so
  `visibleLength` now equals `content.size` and every CRLF soft-wrapped prose
  block maps. The old model counted the pair's `\r` as its own `char` unit —
  one extra visible unit per soft break, size-check mismatch, block read-only
  (the pinned user report: a bullet item wrapping onto a continuation line).
  Lone-CR continuations behind a quote/list prefix map for the FIRST time
  (the old model nulled outright — the prefix belonged to no unit).

- **Three walks moved in step** (each would have re-broken the family alone):
  1. `highlight-syntax.js` `offsetTables` advances its VALUE index by
     `ending.length` (unit width undercounts the pair; without this, CRLF
     highlight injection dies → chain divergence → block still read-only).
  2. `commands/link-toggle.js` `visibleTextOf` normalizes text-value endings
     to `'\n'` (its index-compatibility invariant otherwise refuses every
     CRLF soft-wrapped block).
  3. The two test-side PM-size simulators (`test-source-kernel-inline-html.mjs`
     `pmSize`, `test-source-kernel-highlight-consistency.mjs` `pmContentSize`)
     normalize the same way.

- **Boundary semantics**: the intra-pair offset is no longer ANY visible
  boundary in a prose map (no `boundaries`/`startBoundaries` key), so the old
  bisection refusals in link-toggle / `replaceVisibleText` became unreachable
  by construction — rewritten as positive cases. `splitsCrlfPair` still
  refuses every raw-arithmetic write at the `applySourceTransaction`
  chokepoint. **Code maps deliberately unchanged** (the CM bridge needs
  per-byte addressing; `bisectsLineEnding` still guards them — its ADR
  comment updated to say it now fires only for code maps).

- **Combination matrix**: family D2 removed in full — 154 compositions
  narrowed at once, exactly as its `fix-scheduled` status promised. The
  `table-br` twins keep only their D1 cell. Two `> `-literal CRLF shapes that
  D2's blanket `#crlf` classification used to hide now print as D3 by name.
  Snapshot re-baselined (log line added in the suite).

- **Pins flipped per their own instructions**:
  `test-kernel-projection-map.mjs` KNOWN LIMITATION → positive assertions
  (+ lone-CR case); `test-kernel-line-start-whitespace-ui.mjs` CRLF read-only
  branch deleted — the CRLF run proves the same NBSP re-spelling as LF.

- **New pins**: charmap CRLF-widening section (list/quote/lone-CR/LF control,
  `ending` asserted); headless Case CRLF-SB (typing at two continuation
  positions, soft-break delete eats exactly `\r\n  `); link-toggle CRLF
  section positive.

- **Docs**: ai-handoff §5.2d (B) class-(5) closure note + §5.2g dated entry;
  CLAUDE.md kernel snapshot "Updated 2026-08-21" sentence; the matrix's D2
  doc block records a fixed defect.

## Gates (all on the branch)

build + build:mobile · `test:source-kernel` (41 PASS) · `test:kernel-headless`
(matrix re-baselined) · `test:core` (exit 0) · `test:kernel-ui` (full, exit 0)
· `test:ui-regression` (5 sessions + 52 standalone, exit 0) · guide CONTENT
check PASS (static vitepress build skipped — dep not installed in the
worktree; no guide files changed).

## Verify-path audit

`verifyPlainTextProjection` diffs PM-vs-PM (both sides through the editor's
own parse; endings collapse identically) — no CRLF false-mismatch loop is
possible. `verifyEditObservable` counts in PM characters — consistent with
the widened width.

## Open items unchanged by this round

Gateway classifier hole for appendTransaction riders; kernel-toggle boundary
seam (legacy flush demotes a live seed); /task adjacent-to-list refusal;
history-redo of /task seed re-acceptance unverified; `---`+list frontmatter
ambiguity (still queued); performance (Task 4 items 2–5) and the >120K band.
