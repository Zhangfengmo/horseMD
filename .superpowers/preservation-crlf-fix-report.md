# Preservation mapper CRLF insert arithmetic — fix report

Date: 2026-08-17 · Branch: `fix/rich-source-sync-architecture`
Defect: ai-handoff §5.2e "remaining open item" (now §5.2f) — the LEGACY
canonical-diff preservation mapper split CRLF pairs on a line-end insert,
returned a wrong `preserved:true`, and the round-trip acceptance gate's correct
rejection made the fail-closed rebuild respell the WHOLE document's structural
line endings to LF on the first edit of any CRLF file.

## 1. Headless reproduction (unpatched tree)

`preserveRichMarkdownSource(source, previousCanonical, nextCanonical)` with a
CRLF source and Milkdown's always-LF canonical:

```
source   "# 标题\r\n\r\npara one.\r\n\r\npara two.\r\n"
previous "# 标题\n\npara one.\n\npara two.\n"
next     "# 标题\n\npara one.Z\n\npara two.\n"      // one keystroke at the paragraph end

result   { preserved: true, reason: 'localized-change',
           markdown: "# 标题\r\n\r\npara one.\rZ\n\r\npara two.\r\n" }
roundTripPreserved(result.markdown, next) === false
```

Byte-identical to the `__hmPreserveLog` trace in
`.superpowers/codeblock-crlf-fix-report.md` §4.

### Pinned arithmetic — two owning functions, both off by exactly one byte

**(a) `rawInsertionAtCanonicalLineEnd` — `lib/markdown-preservation/core.js`.**
It ended with `return sourceLine.end - trailingWhitespace.length`, where
`sourceLine = lineAt(source, mappedSourceOffset)`. `lineAt` splits on `\n`
ONLY, so on a CRLF source its `end` is the index of the `\n` — the SECOND byte
of the two-byte ending. "End of this line's text" is therefore one byte too
late, and the insertion lands between `\r` and `\n`. (CRLF width 2 vs the
assumed 1; the `\r` is also invisible to the existing
`hiddenTail.match(/[ \t]*$/)` hard-break guard, so an authored hard break
`alpha  \r\n` was mis-measured as well.)

**(b) `sourceVisibleIndex` / `sourceRawFromVisibleIndex` —
`mode-visible-map.js`.** Inside a fenced code block the line ending IS a
visible character (`out.text += '\n'`), and it was mapped to the raw index of
the `\n`:

```
src      "# T\r\n\r\n```js\r\nlet a = 1;\r\nlet b = 2;\r\n```\r\n"
visible  "T\nlet a = 1;\nlet b = 2;\n"
map[12]  25   // the '\n' of the CRLF pair at [24,26)  → mid-pair anchor
```

The map records where a visible character BEGINS, so a two-byte CRLF newline
must be anchored on the `\r`. Symmetrically, backward affinity computed "just
after the previous visible character" as `map[v-1] + 1`, which for a CRLF
newline also lands mid-pair. Consequence: line-end inserts inside code blocks
split the pair, and a mapped deletion of that ending would strand a lone `\r`.

**(c) `roundtrip.js` — the TEST ORACLE was not line-ending-insensitive.**
Found while writing the byte-exact tests. micromark copies raw bytes into node
values, so a soft break, a fenced-code body and an HTML block keep their
`\r\n`:

```
markdownComparisonKey("line oneX\r\nline two\r\n")
  → {"value":"line oneX\r\nline two", ...}
markdownComparisonKey("line oneX\nline two\n")
  → {"value":"line oneX\nline two", ...}      // unequal
```

This contradicts the module's own stated contract ("authored spelling … CRLF …
is exactly what preservation exists to protect").

**Correction to an earlier draft of this report: this is NOT a production
gate, and the `normalizeLineEndings` change has ZERO runtime effect.**
`roundTripPreserved` has no caller anywhere in `src/` (verified by grep) —
since commit `247eee0` "fix(editor): centralize verified source commits" the
runtime authority is `components/editor-source-verification.js`
`verifySourceDocument` → `editor-durable-semantics.js` `areDurablyEquivalent`,
reached from `commitCanonicalResult` / `flushMarkdown` via
`selectVerifiedSource`. That gate reparses the candidate bytes with the
editor's own Markdown parser and compares the resulting **ProseMirror
document**; a split pair's stray `\r` parses as a real line break, the PM docs
differ, the candidate is refused, and the fail-closed rebuild respells the
file. That — not roundtrip.js — is what produced the observed LF respell.

roundtrip.js's only production export is `markdownComparisonKey`, used at
`core.js:391` as a per-LINE escape-safety check on strings already split by
`\n` (they never contain a line ending), so the normalization cannot change
its verdict either. The change is therefore scoped to keeping the **headless
test oracle** consistent with the contract it documents; without it the new
byte-exact CRLF cases could not assert semantic equivalence at all.

Invariant introduced by the normalization: *a CR byte is a line ending*. The
known consequence is that a literal CR authored as `&#13;` now compares equal
to a break. That is accepted — a decoded CR in source text is indistinguishable
from a line ending — and a SPLIT pair still changes the document and is still
rejected (locked by `a split CRLF pair is still rejected`).

## 2. Blast radius matrix

Method: headless sweep. 11 fixture documents (heading+paragraphs, bullet list,
ordered list, blockquote, task list, soft-break paragraph, fenced code, nested
list, GFM table, link+image, inline marks). For every offset in the document's
own visible-character map, three edits (insert before / insert after / delete
that character) — i.e. only deltas the rich editor can actually produce. Each
edit is run against the LF source and the CRLF source; the LF result is used as
the oracle (`expected = LF result with \n → \r\n`), and every CRLF result is
classified with `roundTripPreserved`. 558 comparable cases.

| Verdict | before | after |
|---|---|---|
| (a) correct bytes | 536 | **558** |
| (b) wrong bytes, REJECTED by the gate → LF respell only | 22 | 0 |
| (c) wrong bytes, ACCEPTED by the gate → SILENT CORRUPTION | **0** | **0** |
| fail-closed by the mapper | 0 | 0 |

**Verdict: no Critical scope.** There is no shape in which the gate accepted
corrupted CRLF bytes. Every pre-existing error was class (b): the user's
content survived, the user's authored line endings did not.

Per-shape detail (all class (b) before, all correct after):

| Edit shape (CRLF source) | before | after |
|---|---|---|
| mid-line insert / delete | correct | correct |
| **insert at paragraph line end** | (b) `para one.\rZ\n` | correct |
| **insert at heading line end** | (b) | correct |
| **insert at list / nested-list / task row end** | (b) | correct |
| **insert at blockquote line end** | (b) | correct |
| **insert at soft-break line end** | (b) | correct |
| **insert after an inline closer (`**`, `` ` ``) at line end** | (b) | correct |
| **insert at a fenced-code line end** | (b) | correct |
| **insert at a hard-break (`  `) line end** | (b) | correct |
| **multi-character paste at a line end** | (b) `para one.\r And more words.\n` | correct |
| **line-end insert batched with a new block** | (b) | correct |
| delete at a line end | correct | correct |
| **delete a fenced-code line ending (join two code lines)** | (b) `` ```\r\na\rb\r\n``` `` — stranded lone `\r`, `preserved:true` | correct `` ```\r\nab\r\n``` `` |
| appended new paragraph / new mid-document block | correct | correct |
| table cell edit | correct | correct |
| last-paragraph tail append (`preserveDivergedTailBlockAppend`) | correct | correct |
| lone-CR (classic Mac): paragraph / heading / list / soft-break line end | correct (4 shapes, byte-exact) | unchanged, correct |
| lone-CR inside a fenced code block | explicit fail-closed (`preserved:false`, `visible-stream-mismatch`) | unchanged, still fail-closed |

Two corrections to an earlier draft of this table. (1) The code-block
line-ending DELETE was omitted; measured on `a0e6f6c^` it produced a stranded
lone `\r` with `preserved:true` — the worst byte shape in the family — and is
fixed by the `rawWidthAt` half. (2) The lone-CR row previously said "already
declined / correct", which conflated two different outcomes; the measured
truth is 4 byte-correct shapes plus one explicit `preserved:false`, none of
which this fix changes.

### Residual class (b) — NAMED OPEN ITEM, not "harmless"

Realistic CRLF deltas that STILL return `preserved:true` with candidate bytes
that LOSE CONTENT. They are pre-existing, they are refused by the runtime gate
(so nothing is silently corrupted), and the user-visible cost is the same
whole-document LF respell on that edit:

| Shape | `(source, previous, next)` | Wrong output | LF control |
|---|---|---|---|
| blockquote line add (1-line quote) | `('> q\r\n', '> q\n', '> q\n> r\n')` | `"> r\r\n"` — drops `> q` | `exact-canonical-baseline`, correct |
| blockquote line add (2-line quote) | `('> q\r\n> r\r\n', '> q\n> r\n', '> q\n> r\n> s\n')` | `"> q\r\n> s\r\n"` — drops `> r` | `exact-canonical-baseline`, correct |

Same root, different path from the one fixed here: a CRLF source can never be
byte-equal to the LF canonical, so it never reaches the
`sourceMarkdown === previous` → `exact-canonical-baseline` shortcut and falls
through to the generic visible-position mapping, which mislocates the region.
Fixing that shortcut's CRLF equivalent is a separate task.

One more shape, recorded for completeness but NOT CRLF-specific: a list-item
soft break, `('- alpha\r\n- beta\r\n', '* alpha\n* beta\n', '* alpha\\\n  cont\n* beta\n')`,
drops the hard-break backslash — but the LF source produces the identical shape
and is equally refused, so it is an independent pre-existing defect.

The remaining class (b) cases in the broad sweep are a deliberately unrealistic
probe that inserts characters INTO block syntax itself (`#`, `>`, fence
backticks, `**`) — canonicals Milkdown cannot emit. Same shortcut-loss cause;
all remain fail-closed, none were touched.

## 3. Fix

Minimal, in the owning functions. LF behaviour is byte-identical by
construction (every new branch is guarded on an actual `\r`).

1. `lib/markdown-preservation/core.js` · `rawInsertionAtCanonicalLineEnd`:
   derive `sourceContentEnd` = `sourceLine.end - 1` when the line ends with a
   `\r`, and use it for the hidden-tail slice, the visible-map guard and the
   return value. Added a fail-closed guard: if the backward mapping landed
   AFTER the line's text end, decline instead of guessing (this is what makes
   the fenced-code case decline rather than mis-insert while (b) is unfixed).
2. `mode-visible-map.js` · `sourceVisibleIndex`: a fenced-code newline is
   anchored on the `\r` when the ending is CRLF (`out.map.push(md[rawPos-1] ===
   '\r' ? rawPos - 1 : rawPos)`).
3. `mode-visible-map.js` · `sourceRawFromVisibleIndex`: new `rawWidthAt(md, i)`
   (2 for a `\r\n`, else 1) so backward affinity and the past-the-end fallback
   clear the whole pair instead of stopping inside it.
4. `lib/markdown-preservation/roundtrip.js` · `normalizeNode`: normalize
   `\r\n|\r` → `\n` in any string node `value` when building the comparison
   key. **Test-oracle-only — zero runtime effect** (see §1(c)); it makes the
   headless suites able to assert semantic equivalence for CRLF documents.
   Line-ending spelling is not content; a SPLIT pair still changes the
   document structure and is still rejected (locked by a test).

Deliberately NOT changed: `lineAt`'s general semantics (48 call sites across
lists/regions/paragraphs; the sweep shows they are correct today, and changing
`.end` would alter every region slice), and `rawOffsetInCanonicalGap`'s
boundary-crossing loop (already CRLF-aware).

## 4. Tests

- `scripts/test-markdown-source-preservation.mjs`: 13-case CRLF line-end
  matrix (paragraph, heading, list row, nested row, task row, quote line,
  soft break, after an inline closer, fenced code, hard break, multi-char
  paste, line-end + new block, deletion). Each case asserts (i) byte-exact
  output, (ii) uniform CRLF as a property (`!/\r(?!\n)|(?<!\r)\n/`),
  (iii) the semantic oracle, (iv) the LF spelling of the same edit maps AND is
  byte-identical apart from the line ending — this last one is the LF
  no-regression lock.
- `scripts/test-roundtrip-acceptance.mjs`: `authored CRLF line endings pass
  against an LF canonical` (paragraph, soft break, fenced code, list, quote,
  lone-CR) and `a split CRLF pair is still rejected`.
- `scripts/test-codeblock-crlf-ui.mjs` — the only END-TO-END lock, through the
  real app and the real gate: `EXPECTED_DISK` tightened from the LF-respelled
  hybrid to uniform CRLF; a new "no bare `\n`" property assertion beside the
  existing "no lone `\r`"; and a new **stage E** that types into the LEADING
  paragraph — a plain prose line-end edit, no code block — which is the actual
  §5.2e/f symptom shape. Stage E must NOT use the trailing paragraph: an edit
  at the last block's line end is claimed by `preserveDivergedTailBlockAppend`,
  which was always CRLF-correct. Proven by isolation: reverting `core.js` alone
  (keeping the `mode-visible-map.js` half) is GREEN with a trailing-paragraph
  stage and RED with the leading-paragraph stage (whole file respelled to LF,
  `# CRLF 代码块测试\n`).
- `docs/ai-handoff.md` §5.2f + `CLAUDE.md`: the "round-trip acceptance gate"
  attribution is corrected to the real runtime gate, and the residual
  content-losing blockquote shapes are recorded as a named open item.

## 5. Gates

| Gate | Result |
|---|---|
| `npm run test:markdown-preservation` | PASS |
| `npm run test:roundtrip-acceptance` | PASS |
| `npm run build` | PASS |
| `npm run test:codeblock-crlf-ui` ×2 consecutive | PASS, PASS |
| `npm run test:quoted-block-source-ui` | PASS |
| `npm run test:trailing-space-source-ui` | PASS |
| `npm run test:list-conversion-ui` (3 scripts) | PASS |
| `npm run test:core` | PASS (exit 0) |
| `npm run test:mode-switch-raw-offset-ui` (extra — visible map) | PASS |
| `npm run test:source-transaction-sync-ui` (extra — LF/CRLF/BOM+CRLF) | PASS |
| `npm run test:ui-regression` (extra) | PASS — 6 sessions + 48 standalone, exit 0 |

## 6. Notes / residual risk

- The test ORACLE is now spelling-insensitive about line endings by design; its
  invariant is "a CR byte is a line ending", so an `&#13;`-authored literal CR
  compares equal to a break. An oracle-passing candidate with MIXED endings
  (correct semantics, inconsistent bytes) would therefore not be flagged by the
  oracle alone — which is why both the headless matrix and the UI test assert
  uniform CRLF as an explicit byte property.
- The runtime gate (`verifySourceDocument`) was NOT relaxed by this task at
  all; only the mapper arithmetic changed on the production path.
- Residual class (b) is a NAMED OPEN ITEM, not harmless: the two blockquote
  line-add shapes above lose content in the candidate bytes. They stay
  fail-closed (no corruption reaches disk), but they cost the author's line
  endings on that edit. Root cause is loss of the
  `sourceMarkdown === previous` → `exact-canonical-baseline` shortcut for any
  CRLF source; fixing it is a separate task.
- The 5.2e follow-up "un-narrow the kernel-mode CRLF code-block ADR" is still
  open and untouched.
