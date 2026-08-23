# Computer Use Markdown Compatibility Validation Plan

> **For agentic workers:** Execute this validation task-by-task. Do not modify HorseMD production code. Archive every anomalous result before any further investigation.

**Goal:** Verify through macOS Computer Use that HorseMD creates, edits, saves, and reopens portable standard Markdown across complex feature combinations.

**Architecture:** Build two independent proof lanes. The first uses only slow, committed, one-character Computer Use input in a scratch document. The second starts from a portable Markdown fixture written in source mode, edits it in rich mode through Computer Use, then compares its saved bytes and cold-reopened structure with standard Markdown parser output. No HorseMD-private markers, HTML fallbacks, or test-only source rewrites may be used to make an assertion pass.

**Tech Stack:** `/Applications/HorseMD.app`, macOS Computer Use, HorseMD source-mode view, real save dialog and cold reopen, standard CommonMark/GFM parsers already present in the repository dependencies.

---

### Task 1: Archive the initial fast-input observation

**Files:**
- Modify: `docs/computer-use-input-verification-2026-08-23.md`

- [ ] Record the fast-input result as preliminary only, including its stale accessibility-index limitation.
- [ ] Keep the original scratch tab open and do not save it over a user file.

### Task 2: Controlled slash-command and nested-list input

**Files:**
- Modify: `docs/computer-use-input-verification-2026-08-23.md`

- [ ] Create a new unnamed scratch tab through the visible New File button.
- [ ] Type each committed character separately, waiting 250 ms after each character and structural key.
- [ ] Exercise `/h2`, `/quote`, `/task`, `/table`, and `/code`, checking that the actual slash command is selected before text is entered.
- [ ] Exercise ordered and unordered lists to three levels with `Tab` and `Shift+Tab`; test Enter exits and re-enters normal paragraphs.
- [ ] Dynamically locate the current source-mode control from the live accessibility tree, read its Markdown value, and archive exact bytes.

### Task 3: Portable complex Markdown fixture round trip

**Files:**
- Modify: `docs/computer-use-input-verification-2026-08-23.md`

- [ ] Create a fixture containing ATX headings, paragraphs, emphasis/strong/strike/inline code, links, blockquotes, ordered/bullet/task lists, GFM table, fenced JavaScript and Mermaid code, inline/display math, thematic break, and a YAML frontmatter header.
- [ ] Write the fixture in source mode only, with ordinary CommonMark/GFM syntax and no HorseMD-specific attributes or opaque markup.
- [ ] Switch to rich mode, apply real Computer Use edits across list, table, code, quote, task, and ordinary paragraph blocks.
- [ ] Return to source mode and assert that untouched fixture sections remain byte-identical while changed sections use portable Markdown syntax.

### Task 4: Durable save and parser interoperability

**Files:**
- Modify: `docs/computer-use-input-verification-2026-08-23.md`
- Create: `/tmp/horsemd-computer-use-validation.md`

- [ ] Save only the scratch validation file at the exact temporary path above; never overwrite a user document.
- [ ] Cold reopen that file in HorseMD and compare the source bytes with the bytes immediately before saving.
- [ ] Parse the saved file with two independent standard Markdown/GFM parsing paths available locally; compare block structure and flag any unsupported private syntax, semantic loss, or parser disagreement.
- [ ] Archive each check as pass, fail, or blocked with the exact evidence. A fail is a report only: do not implement a fix.
