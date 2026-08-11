# Rich/Source Verified Commit Implementation Plan

> Implement only confirmed production defects. Keep experimental
> transaction-primary convergence and future provenance work documented but out
> of the production change set.

**Goal:** Make HorseMD's configured Milkdown parser and ProseMirror document the
single semantic authority for every enabled rich-to-source commit and durability
boundary.

**Architecture:** Preservation helpers produce authored-source candidates. A
focused verifier parses each candidate with `parserCtx` and compares it with the
expected ProseMirror document. `Editor.jsx` owns publication; `editor-api.js`
uses the same injected verifier at forced boundaries; App mirrors each verified
snapshot through one helper.

**Tech stack:** React, Milkdown/Crepe, ProseMirror, Electron CDP test harness,
Node assertion scripts.

---

## Task 1: Lock the reported parser mismatch with a UI regression

**Files:**

- Add: `scripts/test-rich-source-app-parser-ui.mjs`
- Modify: `package.json`

**Steps:**

1. Create a temporary Markdown fixture with a ragged GFM table matching the
   user's file shape and a fenced-code placeholder.
2. Open it through `launchBuiltElectron()` in background mode.
3. Type one committed character at a time in rich mode, switch to source, save,
   close, and reopen.
4. Assert no recovery confirmation, no recovery copy, and preserved ragged row
   bytes. Run against the current build and record the expected failure.
5. Parameterize the fenced language over Go, JavaScript, TypeScript, Python,
   Rust, Java, C, and C++ without changing the structural fixture.

## Task 2: Add unit contracts for the application verifier and scratch fallback

**Files:**

- Add: `src/renderer/src/components/editor-source-verification.js`
- Add: `scripts/test-editor-source-verification.mjs`
- Modify: `package.json`

**Steps:**

1. Add failing tests for parser exception, semantic mismatch, accepted semantic
   equivalence, and ordered fallback candidates.
2. Add a test proving an unsafe generated scratch candidate falls back to the
   escaped canonical candidate.
3. Implement a small injected-parser verifier and candidate chooser with no
   editor state mutation.
4. Run the focused test until green.

## Task 3: Route enabled editor commits through the application verifier

**Files:**

- Modify: `src/renderer/src/components/Editor.jsx`
- Modify: `src/renderer/src/components/editor-api.js`
- Modify: `src/renderer/src/components/editor-source-verification.js`

**Steps:**

1. Replace `roundTripPreserved` in the production commit path with the focused
   application verifier using `parserCtx` and `areSourceDocumentsEquivalent`.
2. Remove the scratch exemption. Offer generated scratch first and a
   placeholder-cleaned canonical spelling second; commit only a verified one.
3. Remove the `>120000` unverified baseline advance. Validate every commit with
   one application parse and measure the existing large-document regression.
4. Replace slash code/math direct baseline writes with `commitCanonicalResult`.
5. Inject the same verifier into `createEditorApi`; apply it to flush and rebuild
   candidates. The canonical-equality return is valid only for a pair that was
   previously verified.
6. Ensure recovery resets the enabled slash intent together with paste/list
   intents.

## Task 4: Centralize verified App snapshot mirroring

**Files:**

- Modify: `src/renderer/src/App.jsx`
- Modify: `src/renderer/src/hooks/useSourceModeSwitch.js`
- Modify: `src/renderer/src/hooks/useFileOps.js`
- Add or modify the smallest existing focused state test under `scripts/`

**Steps:**

1. Add one App helper that updates `tabsRef` and React tab `content` plus
   `pendingRichEdit`, without touching `savedContent`.
2. Use it after successful forced and settled rich reads and after rebuild.
3. Pass it to source-mode switching so source mounting uses the same state
   commit rather than duplicating the mutation.
4. Keep save's disk/saved-content transition separate.

## Task 5: Complete the ordered-list interaction regression

**Files:**

- Modify: `scripts/test-list-backspace-exit-ui.mjs`

**Steps:**

1. Extend the existing real-key test from the first list exit through the
   second Backspace rejoin, Enter, and per-character paragraph typing.
2. Assert the visible ProseMirror structure at each boundary.
3. Switch to source, save, close, and cold reopen; assert exact expected
   semantics and absence of a sync-recovery dialog.

## Task 6: Verify architecture and classify residual findings

**Files:**

- Modify: `docs/rich-source-sync-architecture-review.md`

**Steps:**

1. Run focused unit tests: preservation, app verifier, source transaction,
   source map, flush settlement, and recovery.
2. Build desktop, then run the ragged-table/language, list, scratch, slash, and
   large-document UI regressions.
3. Run `npm run build:mobile` because the renderer is shared.
4. Ask separate sub-agents to perform spec compliance and code-quality reviews;
   address only evidence-backed findings.
5. Update the architecture report with a table separating fixed current
   defects, verified non-causes, and preventive follow-up work.
