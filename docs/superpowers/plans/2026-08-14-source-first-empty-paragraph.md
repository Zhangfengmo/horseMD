# Source-First Empty Paragraph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist newly created rich-text empty paragraphs as standard Markdown blank lines.

**Architecture:** The source-preservation mapper already proves the surrounding visible blocks before handling a middle empty placeholder. Reuse that proof to insert line endings into the authored gap, rather than serializing the internal `<br />` or changing the parser/durable model.

**Tech Stack:** JavaScript ES modules, Milkdown canonical Markdown, Node `assert` regression script.

---

### Task 1: Specify the source-level regression

**Files:**
- Modify: `scripts/test-markdown-source-preservation.mjs` near `middleEmptyParagraphCreated`
- Test: `scripts/test-markdown-source-preservation.mjs`

- [x] **Step 1: Add failing assertions for standard blank-line output**

```js
assert.equal(
  middleEmptyParagraphCreated.markdown,
  '# 标题\n\n前段内容\n\n\n\n## 后续标题\n\n后段内容\n',
  'a created middle empty paragraph must become physical Markdown blank lines'
)
```

Add a second case where two standalone `<br />` lines produce two additional
blank-line slots and a CRLF case preserves `\r\n`.

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm run test:markdown-preservation`

Expected: the middle-empty assertion fails because the mapper returns the old
source unchanged.

### Task 2: Map the proven empty slot to source line endings

**Files:**
- Modify: `src/renderer/src/lib/markdown-preservation/paragraphs.js:476-610`
- Test: `scripts/test-markdown-source-preservation.mjs`

- [x] **Step 1: Move the created-empty branch after neighbour mapping**

Keep the existing visible-neighbour and divergence checks. After `sourceBefore`
and `sourceAfter` are established, insert `lineEndingNear(source,
sourceAfter.start).repeat(2 * emptyDelta)` immediately before `sourceAfter`.
Do not touch the preceding authored gap and do not write `<br />`.

- [x] **Step 2: Run the focused test and verify GREEN**

Run: `npm run test:markdown-preservation`

Expected: all Markdown source-preservation cases pass.

### Task 3: Verify real editor behavior

**Files:**
- Test: `scripts/test-empty-paragraph-source-ui.mjs`

- [x] **Step 1: Extend the UI test with save and exact source assertion**

Open a two-paragraph fixture, create a middle empty paragraph with `Enter`,
save, and assert the file contains only standard blank lines (no standalone
`<br />`).

- [x] **Step 2: Run validation**

Run: `npm run build`, `npm run test:empty-paragraph-source-ui`,
`npm run test:editor-source-verification`, and `npm run test:markdown-preservation`.

Expected: build and all regressions pass. Do not commit unless the user asks.
