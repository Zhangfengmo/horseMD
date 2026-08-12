# Rich/Source Durable Semantics Implementation Plan

> **Implementation status (2026-08-12):** the modules and production wiring
> described below are present on `fix/rich-source-sync-architecture` at and
> after `ca11a73`. The unchecked boxes are the original execution record, not a
> list of architecture that still lives only on another local branch. Current
> verification and second-review conclusions are tracked in
> `docs/rich-source-sync-architecture-review.md` §14–15.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make rich edits, source switching, saving, export, and cold reopen share one durable Markdown-semantic contract, beginning with the reproduced ragged-table failure and covering real table hard breaks, short delimiter cells, and escaped pipes.

**Architecture:** Install a deterministic ragged-table transform in Milkdown's remark pipeline before ProseMirror state exists, and route every explicit parse call through one adapter. Replace table visible-stream guessing with a parser-backed row/cell ownership model, compare candidate and live documents through explicit durable node contracts, and publish a revision only through one typed verified-state coordinator.

**Tech Stack:** Electron, React, Milkdown/Crepe, ProseMirror, unified/remark, `mdast-util-from-markdown`, `micromark-extension-gfm`, Node assertion scripts, background CDP Electron tests.

---

## File map

- Create `src/renderer/src/components/editor-table-normalization.js`: remark AST transform that right-pads short GFM body rows before ProseMirror is built.
- Create `src/renderer/src/components/editor-parse-adapter.js`: the sole application Markdown preparation/parsing interface.
- Create `src/renderer/src/lib/markdown-source-view.js`: shared BOM/CRLF-safe normalized-offset to authored-byte mapping.
- Create `src/renderer/src/lib/markdown-preservation/table-source-model.js`: parser-backed table/row/cell source ownership and cell-local patching.
- Create `src/renderer/src/components/editor-durable-semantics.js`: explicit node contracts for persistence comparison.
- Create `src/renderer/src/components/editor-verified-state.js`: revision-bound, typed, atomic verified publication state.
- Modify `src/renderer/src/components/editor-crepe-setup.js`: register the table normalizer in the configured remark pipeline.
- Modify `src/renderer/src/components/Editor.jsx`: construct/inject the parse adapter and verified state; keep lifecycle orchestration only.
- Modify `src/renderer/src/components/editor-api.js`: use the shared preparation and revision-bound flush paths.
- Modify `src/renderer/src/components/editor-chunked-parse.js`: accept the shared parse function rather than rebuilding preparation locally.
- Modify `src/renderer/src/components/editor-dom-bindings.js` and `src/renderer/src/components/editor-dom-content.js`: inject the shared parse function for Markdown paste.
- Modify `src/renderer/src/components/editor-source-map.js` and `src/renderer/src/components/editor-tablebreak.js`: reuse table token units for caret mapping and preserve raw `<br>` positions through transforms.
- Modify `src/renderer/src/components/editor-source-verification.js`: return typed parse/semantic results and delegate semantics to the durable projection.
- Modify `src/renderer/src/lib/source-transaction-sync.js`: consume the durable comparator instead of owning a JSON deletion list.
- Modify `src/renderer/src/lib/markdown-preservation/tables.js`: delegate table discovery and text patches to the source model; retain block replacement only for proven structural edits.
- Modify `src/renderer/src/markdown-source-preservation.js`: call the parser-backed table path before any global visible-stream fallback.
- Create `scripts/test-editor-table-normalization.mjs`: pure normalization and adapter contract tests.
- Create `scripts/test-table-source-model.mjs`: source-range tests for ragged rows, hard breaks, short delimiters, and escaped pipes.
- Create `scripts/fixtures/table-save-user-repro.md`: sanitized reproduction based on the user's document.
- Create `scripts/test-ragged-table-save-ui.mjs`: parameterized background Electron source/save/cold-reopen regression.
- Create `scripts/test-verified-editor-state.mjs`: revision atomicity and typed failure tests.
- Modify `scripts/test-editor-source-verification.mjs`: durable projection coverage.
- Modify `package.json` and `package-lock.json`: test commands and patch version `0.13.49`.
- Modify `CHANGELOG.md` and `guide/basics/rich-and-source.md`: user-visible behavior and recovery semantics.

### Task 1: Lock the reproduced failures with RED tests

**Files:**
- Create: `scripts/test-editor-table-normalization.mjs`
- Create: `scripts/test-table-source-model.mjs`
- Create: `scripts/fixtures/table-save-user-repro.md`
- Create: `scripts/test-ragged-table-save-ui.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add the pure normalization RED test**

Create `scripts/test-editor-table-normalization.mjs` with direct assertions for the missing module:

```js
import assert from 'node:assert/strict'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { normalizeRaggedGfmTables } from '../src/renderer/src/components/editor-table-normalization.js'

const parse = (markdown) => fromMarkdown(markdown, {
  extensions: [gfm()],
  mdastExtensions: [gfmFromMarkdown()]
})

const tree = parse([
  '| A | B | C |',
  '| --- | --- | --- |',
  '| first |',
  '| second |',
  '| one | target | three |'
].join('\n'))

normalizeRaggedGfmTables(tree)
const table = tree.children[0]
assert.deepEqual(table.children.map((row) => row.children.length), [3, 3, 3, 3])
assert.equal(table.children[1].children[0].children[0].value, 'first')
assert.equal(table.children[2].children[0].children[0].value, 'second')
assert.deepEqual(table.children[1].children.slice(1).map((cell) => cell.children), [[], []])
assert.doesNotThrow(() => normalizeRaggedGfmTables(tree))
assert.deepEqual(table.children.map((row) => row.children.length), [3, 3, 3, 3])

console.log('PASS editor table normalization')
```

- [ ] **Step 2: Add parser-backed cell ownership RED cases**

Create `scripts/test-table-source-model.mjs` around the public interface below:

```js
import assert from 'node:assert/strict'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import {
  createGfmTableSourceParser,
  mapGfmTableChange
} from '../src/renderer/src/lib/markdown-preservation/table-source-model.js'

const remark = unified().use(remarkParse).use(remarkGfm)
const parseTables = createGfmTableSourceParser(remark)
const preserve = (source, previous, next) => {
  const result = mapGfmTableChange({
    authored: source,
    previousCanonical: previous,
    nextCanonical: next,
    parseTables
  })
  assert.equal(result?.status, 'patched')
  return result.markdown
}

const ragged = '| A | B | C |\n| --- | --- | --- |\n| short |\n| one | target | three |'
assert.equal(
  preserve(
    ragged,
    '| A | B | C |\n| --- | --- | --- |\n| short |  |  |\n| one | target | three |',
    '| A | B | C |\n| --- | --- | --- |\n| short |  |  |\n| one | targetX | three |'
  ),
  ragged.replace('target', 'targetX')
)

const hardBreak = '| A | B |\n| --- | --- |\n| one | abc<br>def |'
assert.equal(
  preserve(
    hardBreak,
    '| A | B |\n| --- | --- |\n| one | abc<br>def |',
    '| A | B |\n| --- | --- |\n| one | abc<br>defX |'
  ),
  hardBreak.replace('def', 'defX')
)

const shortDelimiter = '| A | B | C |\n| - | -- | --- |\n| one | target | three |'
assert.equal(
  preserve(shortDelimiter, shortDelimiter, shortDelimiter.replace('target', 'targetX')),
  shortDelimiter.replace('target', 'targetX')
)

const escaped = '| A | B |\n| --- | --- |\n| a \\| b | target<br>tail |'
assert.equal(
  preserve(escaped, escaped, escaped.replace('target', 'targetX')),
  escaped.replace('target', 'targetX')
)

console.log('PASS parser-backed table source model')
```

- [ ] **Step 3: Add the sanitized real fixture and UI RED flow**

Create `scripts/fixtures/table-save-user-repro.md` with a fenced non-Go code block, prose sentinels, and the reproduced 5-column ragged table. Create `scripts/test-ragged-table-save-ui.mjs` by using `launchBuiltElectron()` in its default background mode and `typeTextLikeUser()` for committed characters. For each `RAGGED_CASE=cell|consecutive|hardbreak|terminal-hardbreak|dashes|escaped-pipe`, assert:

```js
assert.equal(before.gateLog.length, 0)
await typeTextLikeUser(session, 'X')
await saveDocument(session)
assert.equal(await recoveryVisible(session), false)
assert.equal((await readSourceMode(session)).includes(expectedTarget), true)
assert.equal((await fs.readFile(filePath, 'utf8')).includes(expectedTarget), true)
await coldReopenAndAssertSameRichTable(session, filePath)
assert.equal((await fs.readFile(filePath, 'utf8')).includes(outsideSentinel), true)
```

The cell case must additionally assert that the untouched authored row is still exactly `| short |` on disk. The consecutive case must inspect the rich DOM before typing and assert all rows have header width while `first` and `second` remain in column 1.

- [ ] **Step 4: Register and run the RED tests**

Add:

```json
"test:editor-table-normalization": "node scripts/test-editor-table-normalization.mjs",
"test:table-source-model": "node scripts/test-table-source-model.mjs",
"test:ragged-table-save-ui": "RAGGED_CASE=cell node scripts/test-ragged-table-save-ui.mjs && RAGGED_CASE=consecutive CDP_PORT=10221 node scripts/test-ragged-table-save-ui.mjs && RAGGED_CASE=hardbreak CDP_PORT=10222 node scripts/test-ragged-table-save-ui.mjs && RAGGED_CASE=terminal-hardbreak CDP_PORT=10223 node scripts/test-ragged-table-save-ui.mjs && RAGGED_CASE=dashes CDP_PORT=10224 node scripts/test-ragged-table-save-ui.mjs && RAGGED_CASE=escaped-pipe CDP_PORT=10225 node scripts/test-ragged-table-save-ui.mjs"
```

Run:

```bash
npm run test:editor-table-normalization
npm run test:table-source-model
npm run build
RAGGED_CASE=cell node scripts/test-ragged-table-save-ui.mjs
```

Expected: the pure tests fail because the new modules do not exist; after temporary import stubs are avoided, the UI case reproduces the save-recovery failure on the current implementation.

- [ ] **Step 5: Commit only the regression tests**

```bash
git add package.json scripts/test-editor-table-normalization.mjs scripts/test-table-source-model.mjs scripts/test-ragged-table-save-ui.mjs scripts/fixtures/table-save-user-repro.md
git commit -m "test(editor): reproduce durable table sync failures"
```

### Task 2: Normalize ragged tables in the configured parser pipeline

**Files:**
- Create: `src/renderer/src/components/editor-table-normalization.js`
- Create: `src/renderer/src/components/editor-parse-adapter.js`
- Modify: `src/renderer/src/components/editor-crepe-setup.js`
- Modify: `src/renderer/src/components/Editor.jsx`
- Modify: `src/renderer/src/components/editor-api.js`
- Modify: `src/renderer/src/components/editor-chunked-parse.js`
- Modify: `src/renderer/src/components/editor-dom-bindings.js`
- Modify: `src/renderer/src/components/editor-dom-content.js`
- Test: `scripts/test-editor-table-normalization.mjs`

- [ ] **Step 1: Implement the idempotent mdast transform**

Create `editor-table-normalization.js`:

```js
const emptyTableCell = () => ({ type: 'tableCell', children: [] })

export function normalizeRaggedGfmTables(tree) {
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'table' && Array.isArray(node.children) && node.children.length) {
      const width = node.children[0]?.children?.length || 0
      for (const row of node.children.slice(1)) {
        if (!Array.isArray(row.children)) row.children = []
        while (row.children.length < width) row.children.push(emptyTableCell())
      }
    }
    for (const child of node.children || []) visit(child)
  }
  visit(tree)
  return tree
}

export function remarkNormalizeRaggedGfmTables() {
  return (tree) => normalizeRaggedGfmTables(tree)
}
```

Do not truncate wide rows, move existing content, mutate the Markdown string, or dispatch a ProseMirror repair transaction.

- [ ] **Step 2: Register the transform before editor state creation**

In `editor-crepe-setup.js`, import `remarkNormalizeRaggedGfmTables` and append it to `remarkPluginsCtx` after the configured GFM parser plugins and before application reconstruction transforms:

```js
ctx.update(remarkPluginsCtx, (plugins) => [
  ...plugins,
  { plugin: remarkNormalizeRaggedGfmTables, options: undefined },
  { plugin: remarkStripLeadingSpaceSentinel, options: undefined },
  { plugin: remarkNormalizeCodeOnlyLinkLabels, options: undefined },
  { plugin: remarkUnwrapNonAsciiAutolinks, options: undefined },
  { plugin: remarkFrontmatter, options: undefined },
  { plugin: brToBreakRemarkPlugin, options: undefined },
  { plugin: remarkMergeInlineHtml, options: undefined },
  { plugin: remarkReconstructSubstitution, options: undefined }
])
```

- [ ] **Step 3: Add the shared parse adapter**

Create `editor-parse-adapter.js`:

```js
import { normalizeReviewMarkupMarkdown } from '../reviewMarkup.js'
import { normalizeDisplayMath } from './editor-math.js'

export const prepareEditorMarkdown = (markdown) =>
  normalizeReviewMarkupMarkdown(normalizeDisplayMath(String(markdown ?? '')))

export function createEditorParseAdapter(getParser) {
  const parse = (markdown) => {
    const parser = getParser?.()
    if (typeof parser !== 'function') throw new Error('Editor parser is not ready')
    return parser(prepareEditorMarkdown(markdown))
  }
  return { prepare: prepareEditorMarkdown, parse }
}
```

The parser getter must remain lazy because `parserCtx` is unavailable until Milkdown reaches parser-ready state.

- [ ] **Step 4: Route every Markdown-to-editor path through the adapter**

In `Editor.jsx`, create one adapter around `crepe.editor.ctx.get(parserCtx)` and inject:

```js
const parseAdapter = createEditorParseAdapter(() => crepe.editor.ctx.get(parserCtx))
```

Use `parseAdapter.prepare(firstContent)` for Crepe `defaultValue`; use `parseAdapter.parse` for verified candidate parsing, transaction shadow validation, development paste, and `appendChunks({ parseMarkdown })`. Pass `prepareMarkdown: parseAdapter.prepare` into `createEditorApi`, and pass `parseMarkdown: parseAdapter.parse` through DOM bindings to `attachMdPasteHandler`.

Change `appendChunks` to accept `parseMarkdown` and call `parseMarkdown(chunkText)` directly. Remove its imports of review/math normalization. Change `editor-dom-content.js` to remove its `parserCtx` import and call the injected `parseMarkdown(markdown)`.

- [ ] **Step 5: Verify normalization is GREEN and existing parser paths stay green**

Run:

```bash
npm run test:editor-table-normalization
npm run test:rich-source-app-parser-ui
npm run test:issue-86-ui
npm run test:table-empty-cells
```

Expected: normalization passes; existing parser/table tests pass; the new cell UI may still fail until Task 3 because the current mapper drops table token structure.

- [ ] **Step 6: Commit the parser contract**

```bash
git add src/renderer/src/components/editor-table-normalization.js src/renderer/src/components/editor-parse-adapter.js src/renderer/src/components/editor-crepe-setup.js src/renderer/src/components/Editor.jsx src/renderer/src/components/editor-api.js src/renderer/src/components/editor-chunked-parse.js src/renderer/src/components/editor-dom-bindings.js src/renderer/src/components/editor-dom-content.js scripts/test-editor-table-normalization.mjs
git commit -m "fix(editor): normalize tables through one parse contract"
```

### Task 3: Replace table visible-stream mapping with source ownership

**Files:**
- Create: `src/renderer/src/lib/markdown-source-view.js`
- Create: `src/renderer/src/lib/markdown-preservation/table-source-model.js`
- Modify: `src/renderer/src/lib/markdown-preservation/tables.js`
- Modify: `src/renderer/src/markdown-source-preservation.js`
- Modify: `src/renderer/src/lib/source-transaction-sync.js`
- Modify: `src/renderer/src/components/editor-source-map.js`
- Modify: `src/renderer/src/components/editor-tablebreak.js`
- Test: `scripts/test-table-source-model.mjs`
- Test: `scripts/test-markdown-source-preservation.mjs`

- [ ] **Step 1: Extract the shared authored-byte source view**

Move the existing BOM/line-ending normalization logic from `source-transaction-sync.js` into `markdown-source-view.js` without changing behavior:

```js
export function createMarkdownSourceView(rawValue) {
  const raw = String(rawValue ?? '')
  let text = ''
  const toRaw = []
  let index = raw.charCodeAt(0) === 0xFEFF ? 1 : 0
  while (index < raw.length) {
    if (raw.charCodeAt(index) === 13) {
      toRaw.push(index)
      text += '\n'
      index += raw.charCodeAt(index + 1) === 10 ? 2 : 1
    } else {
      toRaw.push(index)
      text += raw[index]
      index += 1
    }
  }
  toRaw.push(raw.length)
  return {
    raw,
    text,
    toRaw,
    rawOffset(offset) {
      return Number.isInteger(offset) && offset >= 0 && offset < toRaw.length
        ? toRaw[offset]
        : null
    },
    rawRange(from, to) {
      const rawFrom = this.rawOffset(from)
      const rawTo = this.rawOffset(to)
      return Number.isFinite(rawFrom) && Number.isFinite(rawTo)
        ? { start: rawFrom, end: rawTo }
        : null
    }
  }
}
```

Import it back into `source-transaction-sync.js` and keep all LF, CRLF, BOM, and mixed-line-ending transaction tests green before proceeding.

- [ ] **Step 2: Parse table ranges with the configured GFM grammar**

In `table-source-model.js`, inject Milkdown's configured `remarkCtx` and call `remark.parse(view.text)`, not `remark.runSync()`: the raw parse preserves positions for escaped pipes and HTML `<br>`, while application transforms may replace those nodes. Export this shape:

```js
export function createGfmTableSourceParser(remark) {
  return (markdown) => buildGfmTableSourceModel(markdown, remark)
}

export function buildGfmTableSourceModel(markdown, remark) {
  return {
    view: createMarkdownSourceView(markdown),
    tables: [{
      index,
      range,
      delimiterRange,
      width,
      align,
      rows: [{
        index,
        kind: 'header',
        range,
        missingColumns,
        cells: [{
          row,
          column,
          presence: 'present',
          range,
          contentRange,
          units: [{ kind: 'char', value: 'A', range }],
          patchable: true
        }]
      }]
    }]
  }
}
```

Walk mdast recursively and accept only actual `table` nodes. The delimiter row is not an mdast child; record its exact range between the header end and first body row start (or table end). Derive cell boundaries from mdast positions, then decode raw only inside parser-proven text-node ranges. Emit `\\|` as one `char` unit whose range owns both raw characters, emit `<br>`, `<br/>`, and `<br />` as one `break` unit with its exact spelling range, and emit unsupported inline nodes as `opaque`. If decoded units cannot reproduce the mdast node value exactly, set `patchable: false`; never guess.

- [ ] **Step 3: Implement coordinate matching and a single-cell patch**

Export:

```js
export function mapGfmTableChange({
  authored,
  previousCanonical,
  nextCanonical,
  change = null,
  parseTables
})
```

The function must:

1. parse all three strings through the same `parseTables` instance;
2. pair tables and rows by mdast order and stable semantic context;
3. require identical table count, alignment, row count, and logical coordinates for a text-only edit;
4. find exactly one changed cell by comparing previous/next semantic tokens;
5. map that coordinate to the authored source table even when the authored row omits trailing cells;
6. apply the semantic delta only inside `contentStart..contentEnd`, using positioned tokens so `\\|` and `<br>` remain owned raw tokens;
7. return `{ status: 'unowned', reason }` when ownership is ambiguous instead of guessing.

Return:

```js
{ status: 'patched', markdown, kind: 'cell-text', sourceRange }
```

- [ ] **Step 4: Integrate before global visible-stream divergence**

At the start of the table-specific portion of `preserveRichMarkdownSourceCore`, call:

```js
const tableChange = mapGfmTableChange({
  authored: sourceMarkdown,
  previousCanonical: previous,
  nextCanonical: next,
  change: { start, previousEnd, nextEnd },
  parseTables
})
if (tableChange.status === 'patched') {
  return {
    markdown: tableChange.markdown,
    preserved: true,
    reason: `table-${tableChange.kind}`
  }
}
if (tableChange.status === 'unowned') {
  return { markdown: sourceMarkdown, preserved: false, blocked: true, reason: tableChange.reason }
}
```

Remove the old `preserveTableTextChange` visible-index implementation. Keep structural table replacement in `tables.js`, but make its table discovery use `parseGfmTableSource`; structural replacements may canonicalize only the owning table block and still pass the global semantic gate.

Change `preserveRichMarkdownSource(source, previous, next, options = {})` to accept `options.parseTables` while preserving the three-argument test API. The production editor injects `createGfmTableSourceParser(crepe.editor.ctx.get(remarkCtx))`. Rewrite `normalizeEmptyTableCells` to operate on parsed table/cell ranges from right to left. Clear only a cell whose complete semantic content has explicit serializer-placeholder provenance; an authored sole `<br>` or inline `text<br>text` remains durable. Never run a table-block regex over escaped pipes.

- [ ] **Step 5: Reuse token units for table caret/source mapping**

In `editor-source-map.js`, route table-cell raw-offset mapping through the same cell units instead of assuming `text.value.length === raw.length`. In `editor-tablebreak.js`, retain the original HTML node position when transforming it:

```js
return {
  type: 'break',
  position: node.position ? { ...node.position } : undefined
}
```

Add escaped-pipe-plus-break cases to `scripts/test-editor-source-map.mjs`; assert raw caret offsets before and after both tokens.

- [ ] **Step 6: Run the focused and legacy preservation matrix**

Run:

```bash
npm run test:table-source-model
npm run test:markdown-preservation
npm run test:table-empty-cells
npm run test:source-transaction-sync
npm run test:source-map
```

Expected: all pass; the authored short row and all untouched table spelling stay byte-identical.

- [ ] **Step 7: Commit the source model**

```bash
git add src/renderer/src/lib/markdown-source-view.js src/renderer/src/lib/markdown-preservation/table-source-model.js src/renderer/src/lib/markdown-preservation/tables.js src/renderer/src/lib/source-transaction-sync.js src/renderer/src/markdown-source-preservation.js src/renderer/src/components/editor-source-map.js src/renderer/src/components/editor-tablebreak.js scripts/test-table-source-model.mjs scripts/test-markdown-source-preservation.mjs scripts/test-table-empty-cell-normalization.mjs scripts/test-editor-source-map.mjs
git commit -m "fix(editor): map table edits by parsed source ownership"
```

### Task 4: Define durable semantics with node contracts

**Files:**
- Create: `src/renderer/src/components/editor-durable-semantics.js`
- Modify: `src/renderer/src/components/editor-source-verification.js`
- Modify: `src/renderer/src/lib/source-transaction-sync.js`
- Test: `scripts/test-editor-source-verification.mjs`

- [ ] **Step 1: Add RED tests for durable and non-durable differences**

Extend `scripts/test-editor-source-verification.mjs` with real parser documents and assert:

```js
assert.equal(areDurablyEquivalent(withDifferentHeadingIds, sameHeading), true)
assert.equal(areDurablyEquivalent(withDifferentTableColwidth, sameTable), true)
assert.equal(areDurablyEquivalent(emptyCellPlaceholder, emptyCellParagraph), true)
assert.equal(areDurablyEquivalent(cellWithInlineHardbreak, cellWithoutBreak), false)
assert.equal(areDurablyEquivalent(cellMovedToAnotherColumn, originalCellPosition), false)
assert.equal(areDurablyEquivalent(differentAlignment, originalAlignment), false)
```

Run `npm run test:editor-source-verification`; expected failure is the missing durable-semantics export.

- [ ] **Step 2: Implement explicit node contracts**

Create `editor-durable-semantics.js` with:

```js
const leadingSpaceSentinel = '\u200B'
const except = (attrs, omitted) => Object.fromEntries(
  Object.entries(attrs || {}).filter(([key]) => !omitted.includes(key))
)
const nodeContracts = {
  heading: (attrs) => except(attrs, ['id']),
  bullet_list: (attrs) => except(attrs, ['spread']),
  ordered_list: (attrs) => except(attrs, ['spread']),
  list_item: (attrs) => except(attrs, ['spread']),
  table_header: (attrs) => except(attrs, ['colwidth']),
  table_cell: (attrs) => except(attrs, ['colwidth'])
}

export function projectDurableSemantics(node) {
  const project = (value) => {
    if (!value || typeof value !== 'object') return value
    const projected = { type: value.type }
    if (typeof value.text === 'string') {
      projected.text = value.text.replaceAll(leadingSpaceSentinel, '')
      if (!projected.text) return null
    }
    const attrs = nodeContracts[value.type]
      ? nodeContracts[value.type](value.attrs || {})
      : { ...(value.attrs || {}) }
    if (Object.keys(attrs).length) projected.attrs = attrs
    if (Array.isArray(value.marks) && value.marks.length) {
      projected.marks = value.marks.map(project).filter(Boolean)
    }
    let content = (value.content || []).map(project).filter(Boolean)
    if (value.type === 'list_item') {
      content = content.map((child) => {
        const invisible = child.type === 'paragraph' && (!child.content || child.content.every(
          (inline) => inline.type === 'text' && !inline.marks && !String(inline.text || '').trim()
        ))
        return invisible ? { type: 'paragraph' } : child
      })
    }
    if (value.type === 'table_cell' || value.type === 'table_header') {
      content = content.map((child) => {
        const only = child.type === 'paragraph' && child.content?.length === 1
          ? child.content[0]
          : null
        return only?.type === 'hardbreak' && only.attrs?.isInline === false
          ? { type: 'paragraph' }
          : child
      })
    }
    if (value.type === 'doc') {
      content = content.filter((child) => child.type !== 'paragraph' || child.content?.length)
    }
    if (content.length) projected.content = content
    return projected
  }
  return project(node?.toJSON ? node.toJSON() : node)
}

export const areDurablyEquivalent = (left, right) =>
  JSON.stringify(projectDurableSemantics(left)) ===
  JSON.stringify(projectDurableSemantics(right))
```

Do not use a generic “delete these JSON keys” walk. Node contracts must retain all unknown attributes by default; a node is allowed to omit an attribute only when its contract explicitly classifies it as layout/internal metadata.

- [ ] **Step 3: Make verification return typed results**

Change `verifySourceDocument` to return:

```js
{ ok: true, type: 'committed', parsed }
{ ok: false, type: 'parser-error', error }
{ ok: false, type: 'semantic-loss', parsed }
```

Keep a boolean compatibility wrapper only where an existing transaction API requires it. Update `selectVerifiedSource` to return `{ ok, type, markdown, parsed }`, and update callers deliberately rather than relying on truthiness.

Move `areSourceDocumentsEquivalent` to re-export `areDurablyEquivalent`; remove `semanticJson` from `source-transaction-sync.js` so there is one semantic contract.

- [ ] **Step 4: Run semantic and transaction tests**

```bash
npm run test:editor-source-verification
npm run test:source-transaction-sync
npm run test:roundtrip-acceptance
```

Expected: all pass, and non-empty cell movement or loss remains fail-closed.

- [ ] **Step 5: Commit durable semantics**

```bash
git add src/renderer/src/components/editor-durable-semantics.js src/renderer/src/components/editor-source-verification.js src/renderer/src/lib/source-transaction-sync.js scripts/test-editor-source-verification.mjs
git commit -m "refactor(editor): verify explicit durable semantics"
```

### Task 5: Make verified publication revision-bound and atomic

**Files:**
- Create: `src/renderer/src/components/editor-verified-state.js`
- Create: `scripts/test-verified-editor-state.mjs`
- Modify: `src/renderer/src/components/Editor.jsx`
- Modify: `src/renderer/src/components/editor-api.js`
- Modify: `src/renderer/src/components/editor-source-verification.js`
- Modify: `package.json`

- [ ] **Step 1: Add coordinator RED tests**

Create `scripts/test-verified-editor-state.mjs` using fake immutable docs and injected verification. Cover:

```js
const state = createVerifiedEditorState({ source: 'old', canonical: 'old-c', expectedDoc: doc0 })
const revision1 = state.capture(doc1)
assert.equal(revision1.revision, 1)
assert.deepEqual(state.commit(revision1, semanticLoss), { ok: false, type: 'semantic-loss' })
assert.equal(state.snapshot().source, 'old')
assert.equal(state.snapshot().canonical, 'old-c')
assert.equal(state.snapshot().revision, 0)
assert.equal(state.commit(revision1, committedCandidate).ok, true)
assert.equal(state.snapshot().revision, 1)
const revision2 = state.capture(doc2)
const revision3 = state.capture(doc3)
assert.deepEqual(state.commit(revision2, committedCandidate), { ok: false, type: 'pending' })
assert.equal(state.commit(revision3, committedCandidate).ok, true)
```

Also assert parser errors and unowned source changes do not advance any field, and a stale callback cannot publish over a newer captured revision.

- [ ] **Step 2: Implement the state object**

Create `editor-verified-state.js` around this immutable snapshot:

```js
{
  revision: 0,
  source,
  canonical,
  expectedDoc,
  pending: null,
  status: 'committed'
}
```

Export `createVerifiedEditorState({ source, canonical, expectedDoc, verify, publish })` with `capture(expectedDoc)`, `propose(capture, { candidates, canonical })`, `commit(capture, result, { shouldPublish })`, `reset(...)`, and `snapshot()`. `capture` assigns a monotonically increasing revision and immutable doc snapshot. A commit succeeds only if its revision is the latest captured revision; on success all fields advance together before publication. Failures keep the prior committed fields and expose one of `pending`, `unowned-source-change`, `semantic-loss`, or `parser-error`.

Use this state transition core:

```js
export function createVerifiedEditorState({ source, canonical, expectedDoc, verify, publish }) {
  let nextRevision = 0
  let latestCapture = 0
  let state = {
    revision: 0,
    source: String(source ?? ''),
    canonical: String(canonical ?? ''),
    expectedDoc,
    pending: null,
    status: 'committed',
    failureType: null
  }
  const snapshot = () => ({ ...state })
  const capture = (doc) => {
    const captured = Object.freeze({ revision: ++nextRevision, expectedDoc: doc })
    latestCapture = captured.revision
    state = { ...state, pending: captured, status: 'pending', failureType: null }
    return captured
  }
  const propose = (captured, proposal) => {
    if (captured.revision !== latestCapture) return { ok: false, type: 'pending' }
    return verify({
      candidates: proposal.candidates,
      expectedDoc: captured.expectedDoc,
      canonical: proposal.canonical
    })
  }
  const commit = (captured, result, { shouldPublish = true } = {}) => {
    if (captured.revision !== latestCapture) return { ok: false, type: 'pending' }
    if (!result?.ok) {
      const type = result?.type || 'unowned-source-change'
      state = { ...state, status: type, failureType: type }
      return { ok: false, type }
    }
    state = {
      revision: captured.revision,
      source: result.markdown,
      canonical: result.canonical,
      expectedDoc: captured.expectedDoc,
      pending: null,
      status: 'committed',
      failureType: null
    }
    if (shouldPublish) publish?.(state.source)
    return { ok: true, type: 'committed', markdown: state.source }
  }
  const reset = (next) => {
    latestCapture = ++nextRevision
    state = {
      revision: latestCapture,
      source: String(next.source ?? ''),
      canonical: String(next.canonical ?? ''),
      expectedDoc: next.expectedDoc,
      pending: null,
      status: 'committed',
      failureType: null
    }
    return snapshot()
  }
  return { capture, propose, commit, reset, snapshot }
}
```

- [ ] **Step 3: Replace independent ref mutation at the publication boundary**

In `Editor.jsx`, retain `lastMarkdownRef` and `canonicalMarkdownRef` only as compatibility views backed by the coordinator during migration. Replace `createVerifiedSourceCommitter` with one editor-owned `verifiedState`; `commitCanonicalResult` must capture `view.state.doc`, propose candidates, and atomically mirror successful state to the compatibility refs. Never update either ref before a successful typed commit.

In `editor-api.js`, `flushMarkdown({ force: true })`, source switching, save, export, rebuild, and recovery must use the latest captured live revision. Delete the document-size/scratch branch that changes authority; scratch normalization can change the candidate source but the expected live document remains the capture associated with the revision. A pending result may be retried by `flushMarkdownSettled`; deterministic typed failures must be returned immediately.

- [ ] **Step 4: Preserve the public API while exposing diagnostics**

Keep `flushMarkdown()` returning `string | null` for App compatibility. Add `getVerifiedSyncStatus()` to the editor API for tests/UI diagnostics:

```js
{
  revision,
  committedRevision,
  status,
  failureType
}
```

Do not include document content in production diagnostics.

- [ ] **Step 5: Run state, source-mode, list, and large-document regressions**

```bash
npm run test:verified-editor-state
npm run test:rich-source-tab-state
npm run test:list-backspace-exit-ui
npm run test:list-conversion-ui
npm run test:literal-triple-backtick-source-ui
npm run test:large-source-fidelity-ui
```

Expected: all pass; source/save authority does not change at 120K and the original ordered-list Backspace flow remains operational.

- [ ] **Step 6: Commit atomic revision state**

```bash
git add src/renderer/src/components/editor-verified-state.js src/renderer/src/components/Editor.jsx src/renderer/src/components/editor-api.js src/renderer/src/components/editor-source-verification.js scripts/test-verified-editor-state.mjs package.json
git commit -m "refactor(editor): publish verified source by revision"
```

### Task 6: Prove the real table cases end to end

**Files:**
- Modify: `scripts/test-ragged-table-save-ui.mjs`
- Modify: `scripts/test-rich-source-app-parser-ui.mjs`
- Modify: `package.json`

- [ ] **Step 1: Run every new background UI case**

```bash
npm run build
npm run test:ragged-table-save-ui
```

Expected for all six built-in cases: no recovery banner; source toggle succeeds; save succeeds; disk and cold reopen reconstruct the live rich document; only the target cell bytes change for non-structural edits.

- [ ] **Step 2: Strengthen the existing multi-language matrix**

Update `test-rich-source-app-parser-ui.mjs` so the actual edit occurs inside the table for each fenced language fixture (`go`, `js`, `ts`, `python`, `rust`, `java`, `c`, `cpp`) and assert fenced table-looking code is untouched. Preserve the separate column-resize scenario because it is a structural/layout path, not the reproduced text-edit case.

- [ ] **Step 3: Repeat the user's exact file through an isolated copy**

Allow `scripts/test-ragged-table-save-ui.mjs` to accept `HORSEMD_REPRO_FILE`. The script must read that path, immediately copy its bytes into its temporary test directory, and perform all edits/saves only on the copy. Run:

```bash
HORSEMD_REPRO_FILE=/Users/fengmo/Documents/test.md RAGGED_CASE=external-copy CDP_PORT=10225 node scripts/test-ragged-table-save-ui.mjs
```

Expected: source switch/save/cold reopen succeed; a byte diff between the original input buffer and saved temporary copy contains only the typed target-cell character. Never write the original file and never store its absolute path in a committed fixture or log.

- [ ] **Step 4: Add the table verified-source aggregate**

Add:

```json
"test:table-verified-source": "npm run test:editor-table-normalization && npm run test:table-source-model && npm run test:ragged-table-save-ui && npm run test:issue-86-ui && npm run test:table-empty-cells && npm run test:rich-source-app-parser-ui"
```

Run `npm run test:table-verified-source`; expected: PASS.

- [ ] **Step 5: Commit the end-to-end matrix**

```bash
git add scripts/test-ragged-table-save-ui.mjs scripts/test-rich-source-app-parser-ui.mjs package.json
git commit -m "test(editor): cover verified table saves end to end"
```

### Task 7: Document, version, and perform release-grade verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Modify: `guide/basics/rich-and-source.md`

- [ ] **Step 1: Update user-facing documentation and patch version**

Run:

```bash
npm version 0.13.49 --no-git-tag-version
```

Add a `0.13.49` changelog entry explaining that legal ragged tables, cell line breaks, escaped pipes, and short GFM delimiter spelling can now be edited/saved without false source mismatch. Update the rich/source guide to state that untouched table spelling is preserved and that recovery appears only for a real unowned or lossy mapping.

- [ ] **Step 2: Run the focused regression matrix**

```bash
npm run test:table-verified-source
npm run test:editor-source-verification
npm run test:source-transaction-sync
npm run test:roundtrip-acceptance
npm run test:list-backspace-exit-ui
npm run test:list-conversion-ui
npm run test:literal-triple-backtick-source-ui
npm run test:large-source-fidelity-ui
```

Expected: every command exits 0.

- [ ] **Step 3: Build every shared-renderer target and validate the guide**

```bash
npm run build
npm run build:mobile
npm run guide:check
```

Expected: desktop renderer, mobile renderer, and guide checks all exit 0.

- [ ] **Step 4: Inspect the final diff and run automated code review**

```bash
git diff --check
git status --short
git diff --stat 4822e5a...HEAD
```

Confirm `electron.vite.config.mjs` and `.idea/` remain untouched user changes. Run the repository's Codex review workflow against the implementation range, fix only verified in-scope findings, then repeat the smallest affected tests plus both builds.

- [ ] **Step 5: Commit release metadata**

```bash
git add package.json package-lock.json CHANGELOG.md guide/basics/rich-and-source.md
git commit -m "chore: release rich source durability fix"
```

- [ ] **Step 6: Final verification evidence**

Record exact pass/fail output, commit IDs, remaining unrelated working-tree changes, and any still-disabled pre-existing transaction-primary experiments. Do not claim the implementation complete until the verification-before-completion checklist has been applied to fresh command output.
