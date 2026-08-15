# Empty task source-first text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a task item's label is empty, save it as ordinary portable Markdown text (`* [ ]` or `* [x]`) rather than an HTML entity-backed task item.

**Architecture:** Milkdown's GFM model can hold an empty `list_item.checked` node although standard GFM cannot serialize it as an empty task. A focused task-list plugin will demote that internal node to a normal list item whose paragraph contains `[ ]` or `[x]` before any source boundary. The normalizer and durable verifier then remain strict standard-GFM consumers; no private parser rule or source entity is introduced.

**Tech Stack:** Milkdown/Crepe, ProseMirror plugin transactions, GFM serializer/parser, Electron CDP regression scripts.

---

### Task 1: Lock source-first empty-task behavior

**Files:**
- Modify: `scripts/test-markdown-source-preservation.mjs`
- Modify: `scripts/test-editor-source-verification.mjs`
- Modify: `scripts/test-empty-task-list-persistence-ui.mjs`

- [ ] **Step 1: Change task placeholder expectations before production code**

Require the canonical task placeholders to become plain Markdown list text:

```js
assert.equal(normalizeEmptyListItems('* [ ] <br />\n'), '* [ ]\n')
assert.equal(normalizeEmptyListItems('* [x] <br />\n'), '* [x]\n')
```

Require the real UI chain to render a plain bullet containing `[ ]` / `[x]` after deleting the final label, save exactly those bytes, and remain a plain bullet after cold reopen.

- [ ] **Step 2: Run the regression before implementation**

Run:

```bash
npm run test:markdown-preservation
npm run test:empty-task-list-persistence-ui
```

Expected: FAIL because the current implementation writes `&nbsp;` and retains task-checkbox DOM state.

### Task 2: Demote unrepresentable rich task nodes

**Files:**
- Modify: `src/renderer/src/components/editor-task-list.js`
- Modify: `src/renderer/src/components/editor-api.js`
- Modify: `src/renderer/src/lib/markdown-preservation/lists.js`
- Modify: `src/renderer/src/components/editor-durable-semantics.js`

- [ ] **Step 1: Add a focused demotion transaction**

In `editor-task-list.js`, identify only `list_item` nodes with boolean `checked` and a sole unmarked whitespace-only paragraph. Replace each with the same list-item type/other attrs, `checked: null`, and one ordinary paragraph containing `[ ]` or `[x]`. Preserve the enclosing list and its authored marker. Tag the initial task input transaction so a newly typed `* [ ] ` remains interactive until the next user action.

- [ ] **Step 2: Run demotion on deletion and forced source boundaries**

Have `createTaskListInputPlugin()` append the demotion transaction after an existing task becomes empty, but not immediately after the task-marker input rule creates it. Export a helper and call it in `flushMarkdown()` before serializing, so a freshly-created but unsaved empty task also becomes ordinary source text before save, source-mode switching, export, or close-time flush.

- [ ] **Step 3: Make normalizer and verifier strict again**

Make `normalizeEmptyListItems()` reduce `* [ ] <br />` to `* [ ]` and `* [x] <br />` to `* [x]`. Remove the NBSP task placeholder exception from `editor-durable-semantics.js`; a live empty task must be demoted before it reaches durability verification.

- [ ] **Step 4: Verify green**

Run:

```bash
npm run test:markdown-preservation
npm run test:editor-source-verification
npm run test:empty-task-list-persistence-ui
```

Expected: both checked states become ordinary text, save without recovery, and cold reopen without a task checkbox.

### Task 3: Record the source contract and build

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/empty-paragraph-contract.md`
- Modify: `docs/markdown-source-preservation.md`
- Modify: `docs/manual-test-checklist.md`
- Modify: `guide/basics/rich-and-source.md`

- [ ] **Step 1: Replace the entity-backed documentation contract**

Document that an emptied task is intentionally demoted to ordinary `[ ]`/`[x]` list text because plain GFM has no empty-task grammar. State that this preserves a single portable source interpretation rather than adding an entity, comment, or HorseMD-only parser rule.

- [ ] **Step 2: Run final verification**

```bash
npm run test:task-list-persistence-ui
npm run test:quoted-block-source-ui
npm run test:leading-space-entity-ui
npm run test:heading-edge-whitespace-source-ui
npm run build
npm run build:mobile
npm run guide:check
```

Expected: task behavior and existing whitespace contracts pass together; desktop and shared mobile renderer build successfully.
