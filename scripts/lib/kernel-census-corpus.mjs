// THE COMMITTED CORPUS the kernel census asserts against, and the one place
// its thresholds live.
//
// WHY THIS FILE EXISTS. `measure-kernel-census.mjs` and
// `measure-kernel-readonly-causes.mjs` produced this branch's headline numbers
// ("0/197 documents degrade", "95.6% of the read-only surface is two bugs")
// while defaulting to `~/Downloads` and exiting 0 unconditionally. Neither
// property is acceptable in a script wired into an npm `test:` target: the
// corpus existed on exactly one machine, and no result could ever fail. The
// exploratory mode is still there and still useful — it is how the two causes
// were found — but the ASSERTING mode runs against the fixtures below, which
// are in the repository, and it exits non-zero on breach.
//
// WHAT THE CORPUS IS. Six small documents, each one a shape that mattered:
//
//   prose-baseline.md         the control: frontmatter, headings, marked prose,
//                             inline atoms, bullets/ordered/tasks, a quote, a
//                             fence, block math, a table, CJK. Everything the
//                             kernel claims to edit, in one file.
//   softbreak-continuation.md cause A — a wrapped line whose continuation opens
//                             with a NON-TEXT inline sibling (`code`, **bold**,
//                             a link, an image), at root / in a list / in a
//                             quote, plus the hard-break twin.
//   table-escapes.md          cause B — remark's routine `\-` `\.` `\*` `\_`
//                             inside cells, PLUS the two shapes that stay
//                             read-only on purpose (`\|`, `<br>`).
//   crlf-soft-wrap.md         CRLF everywhere (family D2): one line ending, any
//                             spelling, is ONE width-1 unit.
//   inline-html.md            inline `<span>`/`<mark>` atoms and a root-level
//                             `<div>` wrapper whose blocks the editor merges.
//   criticmarkup.md           the review marks, i.e. the cleanest probe for
//                             dual-chain divergence between the two parses.
//
// WHY THE THRESHOLDS ARE WHAT THEY ARE. They are MEASURED, not aspirational.
// On this corpus, 2026-08-26, 104 textblocks:
//
//   read-only today                                 11  ratio 0.106
//   + what would flip if cause A regressed          +6  ratio 0.163
//   + what would flip if cause B regressed         +11  ratio 0.212
//   + both                                                ratio 0.269
//
// (The two counterfactuals were measured, not estimated: cause A by asking the
// real `textUnits` for its answer WITHOUT the `nextSibling` argument — which is
// exactly the pre-fix answer, as that parameter's own doc comment states — and
// cause B by counting editable cells whose real character map holds an escape
// unit that does not spell `|`.)
//
// The bound therefore sits between today's measurement and the cheapest
// regression: 0.13 leaves ~2 blocks of slack for ordinary fixture edits and
// still trips well before either cause could come back. It is a coarse NET.
// The SHARP detectors are the cause-level assertions in
// measure-kernel-readonly-causes.mjs, which are exact (zero) and do not depend
// on this ratio at all.
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const REPO = resolve(import.meta.dirname, '..', '..')
export const CORPUS_DIR = join(REPO, 'scripts', 'fixtures', 'kernel-census')

// Documents that must attach. A projection map that returns null degrades the
// whole tab to LEGACY, whose save boundary is the byte-fidelity bug family's
// home — so this one is zero, with no margin.
export const MAX_DEGRADED = 0
export const MAX_PARSE_ERRORS = 0

// Read-only TEXTBLOCKS as a share of all textblocks — "what a writer feels".
// Measured 0.106 (11 of 104); cause A back = 0.163, cause B back = 0.212.
export const MAX_READONLY_TEXTBLOCK_RATIO = 0.13

// The corpus must keep containing a CRLF document: a `git config core.autocrlf`
// / .gitattributes change that normalised `crlf-soft-wrap.md` to LF would
// silently delete a whole axis of the measurement without failing anything.
export const REQUIRE_CRLF_DOCUMENT = true

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.cache', 'coverage'])

// Recursive markdown walk, shared by both instruments (each used to carry its
// own copy).
export async function walkMarkdown(dir, depth = 6, acc = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth <= 0 || IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      await walkMarkdown(full, depth - 1, acc)
    } else if (/\.(md|markdown)$/i.test(entry.name)) {
      acc.push(full)
    }
  }
  return acc
}

export const corpusTargets = () => walkMarkdown(CORPUS_DIR, 2)
