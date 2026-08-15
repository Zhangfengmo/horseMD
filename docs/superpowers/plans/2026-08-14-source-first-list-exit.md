# Source-First List Exit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a mid-list exit portable by joining the newly split generated ordered lists before source serialization.

**Architecture:** The ordered-list ProseMirror plugin already joins directly adjacent generated `.` lists. Extend it only for a paragraph that is proven new: compare its two neighbouring lists with the single pre-transaction list after omitting only old empty list items. The source mapper then receives one normal list tree and keeps all following rows.

**Tech Stack:** JavaScript ES modules, Milkdown/ProseMirror transactions, Electron CDP UI regression scripts.

---

### Task 1: Capture the list-exit regression

**Files:**
- Modify: `scripts/test-empty-paragraph-source-ui.mjs`
- Test: `scripts/test-empty-paragraph-source-ui.mjs`

- [x] **Step 1: Add the failing keyboard scenario**

Use a fixture containing an ordered list with an empty middle item and later
non-empty rows. Place the caret in that empty list item, send `Enter` to exit,
then send another `Enter`. Assert that source switching and save retain every
later row and contain neither a standalone `<br />` nor `1)`.

- [x] **Step 2: Run the scenario against the current build and verify RED**

Run: `npm run test:empty-paragraph-source-ui`

Expected: the durable-source candidate is rejected after the list split, so the
source assertion cannot obtain a valid source snapshot with the later rows.

### Task 2: Normalize only a proven newly split ordered list

**Files:**
- Modify: `src/renderer/src/components/editor-ordered-list-source.js`
- Test: `scripts/test-empty-paragraph-source-ui.mjs`

- [x] **Step 1: Add a split-origin proof**

Find `ordered_list`, empty `paragraph`, `ordered_list` triples. Accept them
only when their combined non-empty list items equal one source-first ordered
list in `oldState.doc`; this distinguishes a new list exit from existing raw
HTML or an authored `1)` boundary.

- [x] **Step 2: Delete the proven empty paragraph and join the list nodes**

Delete the intervening paragraph in the appended transaction, give the right
list the left list's attributes, and join at the resulting boundary. Retain
the existing direct-adjacency merge behavior.

- [x] **Step 3: Run the focused UI test and verify GREEN**

Run: `npm run build && npm run test:empty-paragraph-source-ui`

Expected: the source contains the continuing ordered rows and save completes.

### Task 3: Document and package the repair

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `guide/basics/rich-and-source.md`
- Modify: `package.json`
- Modify: `package-lock.json`

- [x] **Step 1: Describe source-first list exits**

Document that an empty rich paragraph created by exiting a list in the middle
of a continuing `.` list is normalized back to that list because portable
Markdown has no empty-paragraph boundary there. State that authored `1)` and
`<br />` remain source-owned.

- [x] **Step 2: Increment the patch version**

Change the version from `0.13.61` to `0.13.62` in both package manifests.

- [x] **Step 3: Run the release verification set**

Run: `npm run build`, `npm run test:empty-paragraph-source-ui`,
`npm run test:new-document-list-source-preservation-ui`,
`npm run test:authored-ordered-delimiter-ui`, `npm run test:source-map`, and
`npm run guide:check`.

Expected: all commands exit successfully. Do not commit unless the user asks.
