# WIP consolidation + test-failure fixes — report (2026-08-16)

Branch: `fix/rich-source-sync-architecture`

## Commits

| SHA | Message | Content |
| --- | --- | --- |
| `e51c8cd` | feat(source): source-first leading whitespace, tab and empty-task semantics (WIP consolidation) | 40 files: all dirty `src/` (incl. deleted `src/renderer/src/lib/markdown-leading-space.js`, new `editor-ordered-list-source.js`), dirty `scripts/*.mjs` + `scripts/fixtures/list-conversion.md`, 5 untracked-but-wired test scripts (`test-authored-ordered-delimiter-ui`, `test-empty-task-list-persistence-ui`, `test-heading-edge-tab-source-ui`, `test-leading-tab-source-ui`, `test-tab-indent-source-ui`), dirty `docs/*.md`, `guide/editing/formatting.md` |
| `18f47b5` | docs: source kernel plans and specs (superpowers) | 9 files under `docs/superpowers/{plans,specs}/` |
| `0831228` | chore: ignore .idea | appended `.idea/` to `.gitignore` (was absent) |
| `41cd699` | test(source): empty quoted task row keeps literal [ ] per source-first contract | `scripts/test-quoted-block-source-ui.mjs`: expectation `'> * '` → `'> * [ ]'` + comment updated |
| `f6a0d24` | fix(source): equate leading-space spellings so list conversion can patch markers | `src/renderer/src/lib/markdown-preservation/lists.js` (`comparableListLine`) + stale U+200B expectation in `scripts/test-list-conversion-ui.mjs` migrated to `&nbsp;` |

Notes on inventory vs. the task brief: by the time work started, the branch had advanced (kernel-mode commits `4a3bc2c`…) and several files named in the brief (CHANGELOG.md, package.json/package-lock.json, Editor.jsx, editor-crepe-setup.js, docs/ai-handoff.md, guide/basics/rich-and-source.md, scripts/test-list-conversion-ui.mjs, scripts/test-quoted-block-source-ui.mjs, mode-visible-map.js partially, etc.) were already committed and clean — commit A therefore contains only what was actually dirty/untracked. Intentionally left uncommitted: `hm-exp.mjs`, `scripts/test-heading-leading-tab-source-ui.mjs`, `scripts/test-scratch-heading-leading-whitespace-ui.mjs` (orphaned, not wired into package.json). Nothing else unexpected in `git status`.

## Failure 1 — quoted-block test (test-stale)

One-line contract drift: emptying a quoted task item demotes the checkbox to ordinary
list text KEEPING the literal `[ ]` (docs/empty-paragraph-contract.md /
`editor-durable-semantics.js` list_item contract: "Empty tasks are demoted to ordinary
`[ ]` / `[x]` text"). The app produces `> * [ ]`; the test expected `> * `.
Changed the `expected.replace` target to `'> * [ ]'`. No further byte diffs surfaced —
`npm run test:quoted-block-source-ui` PASS on the first run after the fix.

## Failure 2 — list conversion (code-incomplete)

### safe() findings (node_modules/mdast-util-to-markdown/lib/util/safe.js)

- `safe()` scans `config.before + value + config.after` against `state.unsafe`
  patterns. For each in-scope match: ASCII punctuation not listed in
  `config.encode` gets a backslash escape; **everything else gets a character
  reference** (`encodeCharacterReference`). So `encode: []` (what Milkdown and
  the app's `milkdownText` pass) only affects the punctuation/backslash choice —
  it does NOT suppress character references for whitespace. It is effectively
  identical to omitting `encode` here.
- Whitespace protection comes from two unsafe patterns:
  `{character: ' ', before: '[\r\n]', inConstruct: 'phrasing'}` and the `after`
  twin (lib/unsafe.js:52-53). A leading U+0020 in list-item text IS therefore
  protected: `containerFlow` passes `before: '\n'`, so a fresh-typed leading
  space serializes as `&#x20;` (verified empirically with the project's own
  remark-stringify). The task hypothesis "canonical never emits &#x20;" is
  false for real spaces.
- The actual unprotected character is **U+00A0**: a reopened document parses the
  authored `&nbsp;` entity to NBSP in the ProseMirror doc, and mdast-util-to-markdown
  has **no unsafe pattern for U+00A0** — it serializes as a raw NBSP byte. And
  because the following ASCII spaces are then preceded by NBSP (not `\n`), they
  get no protection either. Canonical row: `-      Leading spaced item`.

### Root cause of the gate failure

`comparableListLine` (lists.js) strips the marker with
`/^\s*(?:[-+*]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/`. JS `\s` includes U+00A0, so
the canonical row's whole leading run is swallowed → comparable `Leading spaced item`.
The authored row keeps the literal entity → comparable `&nbsp;    Leading spaced item`.
`replaceMarkdownListBlock`'s comparability gate (`sourceText !== previousText`)
then correctly fails closed → conversion silently rejected → `test:list-conversion-ui`
asserts OL, gets null. Reproduced headlessly with the real gate function; the gate
already passed today for the `&#x20;` (fresh-typed) spelling — only the reopened-NBSP
spelling failed.

### Fix chosen: comparison-side (with rationale)

The task's preferred serializer-side option (force `&#x20;` protection) doesn't
close the loop for this case: the doc character is NBSP, not a space. Spelling it
`&#x20;` would assert space-ness at serialization time for every document,
rippling through canonical diffs/offset mapping app-wide and silently respelling
a genuinely authored raw-NBSP byte (which the durable contract explicitly keeps
as user content — the `portableLeadingSpace` normalization is candidate-side and
conditional). Spelling it `&#xA0;` still wouldn't match `&nbsp;` in the gate.

The comparison-side fix is both minimal and byte-safe: `comparableListLine`
already treats leading whitespace as comparison-invisible (marker `\s+` +
`.trim()`); the change makes its *entity spellings* equally invisible by
stripping `^(?:&nbsp;|&#xa0;|&#160;|[ \t ])+` before trim. Crucially, **no
canonical bytes are written to source on this path**: after the gate passes,
`patchConvertedListMarkers` patches only marker prefixes and returns the
authored bytes — the `&nbsp;` entity stays byte-exact in the file, so the
CommonMark indentation-reinterpretation hazard (1–3 spaces = indent, 4+ = code
block) that the docs warn about cannot arise. If marker patching cannot align,
the path still returns null (fail-closed) exactly as before.

Also migrated the test's stale pre-WIP expectation
(`2. ​     Leading spaced item`, the old U+200B sentinel contract) to the
documented portable spelling `2. &nbsp;    Leading spaced item` — consistent with
the WIP's own fixture change (`- ​     …` → `- &nbsp;    …` in commit
`e51c8cd`) and docs/canonical-escape-audit.md ("行首用标准 `&nbsp;`", 0.13.65).

Headless verification: with the fix, all four canonical spellings (raw NBSP+spaces,
`&#xA0;`, `&#x20;`, raw spaces) produce the identical marker-only patch preserving
`&nbsp;` in source.

## Gate results (all green)

| Gate | Result |
| --- | --- |
| `npm run build` | PASS (run after each change; final tree builds clean) |
| `npm run test:core` | PASS (incl. kernel headless + source-kernel suites) |
| `npm run test:kernel-ui` | PASS (smoke, IME, node-view identity + blocked matrix) |
| `npm run test:quoted-block-source-ui` | PASS |
| `npm run test:list-conversion-ui` | PASS (all 3 sub-suites: conversion UI, source fidelity, rich-list end+middle) |
| `npm run test:trailing-space-source-ui` | PASS |
| `npm run test:ime-source-fidelity-ui` | PASS |
| Extra locks for the lists.js change: `test:leading-space-entity-ui`, `test-list-leading-space-ui`, `test:leading-tab-source-ui`, `test:tab-indent-source-ui`, `test:heading-edge-whitespace-source-ui` (all 4 variants) | PASS |

No flaky retries were needed.

## Concerns / follow-ups for the user

- `scripts/test-heading-leading-tab-source-ui.mjs` and
  `scripts/test-scratch-heading-leading-whitespace-ui.mjs` remain untracked and
  unwired — decide whether to wire or delete. `hm-exp.mjs` left as scratch.
- The commit-f6a0d24 message says "equate leading-space spellings" rather than the
  suggested "protect … in canonical" because the implemented fix is comparison-side,
  not serializer-side (see rationale above).
- The canonical serializer still emits a raw NBSP byte for reopened `&nbsp;` docs.
  That is round-trip stable and now comparison-equated for lists, but if other
  gates ever compare authored `&nbsp;` against canonical NBSP outside lists.js,
  the same spelling mismatch could resurface; the audit doc's escape table has no
  row for U+00A0 — worth adding when the doc is next touched.
