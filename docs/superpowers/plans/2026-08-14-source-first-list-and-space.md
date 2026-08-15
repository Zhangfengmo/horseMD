# Source-first ordered lists and whitespace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep generated Markdown portable by using dot-delimited ordered lists and literal spaces rather than HorseMD-specific serialization fallbacks.

**Architecture:** A focused ProseMirror plugin merges only internally generated adjacent ordered-list nodes that lack an authored `)` delimiter, so the live document and dot-delimited Markdown describe the same list. The durable semantic projector treats a terminal literal U+0020 run as source formatting, allowing the serializer and source mapper to emit ordinary spaces without reintroducing the `&#x20;` fallback.

**Tech Stack:** React, Milkdown/Crepe, ProseMirror plugins, mdast serializer, Node assertion scripts, Electron CDP regression harness.

---

### Task 1: Lock source-first ordered-list behavior

**Files:**
- Create: `src/renderer/src/components/editor-ordered-list-source.js`
- Modify: `src/renderer/src/components/editor-crepe-setup.js`
- Modify: `scripts/test-new-document-list-source-preservation-ui.mjs`

- [ ] **Step 1: Change the delete-and-recreate UI expectation before production code**

Require this source after re-creating a list directly after a nested ordered list:

```js
['1. 第一项', '2. 第二项', '   1. 嵌套项', '3. 重新有序项', '   1. 继续嵌套项']
```

Also assert that there is one direct-child ordered-list DOM tree. Run:

```bash
NEW_DOCUMENT_LIST_WITH_BULLET=1 NEW_DOCUMENT_LIST_DELETE_RECREATE=1 NEW_DOCUMENT_LIST_RAPID=1 NEW_DOCUMENT_LIST_FROM_TITLE=1 NEW_DOCUMENT_LIST_IMMEDIATE=1 CDP_PORT=9811 node scripts/test-new-document-list-source-preservation-ui.mjs
```

Expected: failure because current source contains `1)` and the rich document retains two list trees.

- [ ] **Step 2: Add the narrow append-transaction plugin**

Create `createSourceFirstOrderedListPlugin()` using `Plugin` from
`@milkdown/prose/state`. On a changed document, replace a direct adjacent pair
of `ordered_list` nodes only when neither node has `attrs.delimiter === ')'`.
Build one node with the first node's attrs and the concatenated item content;
do not touch nested lists, lists separated by a non-list block, or explicitly
authored `)` lists.

- [ ] **Step 3: Register the plugin before downstream source observers**

Add the plugin to `prosePluginsCtx` in `editor-crepe-setup.js`, beside the
existing list Backspace keymap. The normalized transaction must be visible to
the single verified source-commit path.

- [ ] **Step 4: Verify green**

Re-run the command in Step 1. Expected: PASS with dot-delimited source, one
rich list, successful save, and cold reopen.

### Task 2: Restore literal terminal spaces

**Files:**
- Modify: `src/renderer/src/components/editor-list-style.js`
- Modify: `src/renderer/src/components/editor-crepe-setup.js`
- Modify: `src/renderer/src/lib/markdown-preservation/core.js`
- Modify: `src/renderer/src/components/editor-durable-semantics.js`
- Modify: `scripts/test-trailing-space-source-ui.mjs`
- Test: `scripts/test-editor-source-verification.mjs`

- [ ] **Step 1: Change terminal-space expectations before production code**

Replace each expected entity with a literal U+0020 before the newline and add
an assertion that the saved source does not contain `&#x20;`. Run:

```bash
npm run test:trailing-space-source-ui
```

Expected: failure because `49b45a4` emits numeric entities.

- [ ] **Step 2: Remove the serializer entity fallback**

Remove `trailingSpaceTextHandler` and its `remarkStringifyOptionsCtx` `text`
registration so Milkdown's original literal text behavior is restored. Remove
the terminal-entity exception from `canonicalTextToSource`; leading entities
continue to use the existing sentinel path and all other entities become
ordinary spaces.

- [ ] **Step 3: Make the verifier source-first for terminal plain spaces**

In `editor-durable-semantics.js`, project away only a final text node made
solely of U+0020 at the end of a paragraph/heading/list paragraph. Preserve
tabs, hardbreaks, marks, and all non-terminal text. This permits raw source to
remain portable even though CommonMark does not retain a single trailing space
as an inline node.

- [ ] **Step 4: Verify green and guard the old fix's scope**

Run:

```bash
npm run test:trailing-space-source-ui
npm run test:leading-space-entity-ui
npm run test:editor-source-verification
```

Expected: all pass; output has literal terminal spaces, no entity, and leading
space behavior remains unchanged.

### Task 3: Regression matrix and documentation

**Files:**
- Modify: `docs/canonical-escape-audit.md`
- Modify: `docs/markdown-source-preservation.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Record the source-first contract**

Document that internally generated adjacent ordered lists merge rather than
inventing `1)`, and that literal terminal spaces are source formatting rather
than entity-encoded durable rich nodes. Retain the leading-space sentinel
boundary.

- [ ] **Step 2: Run focused regression commands**

```bash
npm run test:markdown-preservation
npm run test:new-document-list-source-ui
npm run test:trailing-space-source-ui
npm run test:leading-space-entity-ui
npm run build
```

Expected: every command succeeds with no generated `&#x20;` in terminal-space
fixtures and no `1)` in the generated adjacent ordered-list fixture.

