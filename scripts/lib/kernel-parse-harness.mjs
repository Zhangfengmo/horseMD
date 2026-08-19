// Headless replica of the LIVE editor's Markdown -> ProseMirror parse chain.
//
// WHY THIS EXISTS
// ---------------
// `buildProjectionMap(rawMarkdown, pmDoc)` pairs the KERNEL's own mdast
// (buildSyntaxIndex, parsed from the raw bytes) against the EDITOR's
// ProseMirror document. Every existing headless kernel test therefore has to
// supply a PM doc, and they all do it the same way: a hand-built `Schema` plus
// hand-written `schema.node(...)` trees (scripts/test-kernel-projection-map.mjs,
// test-kernel-reconciler.mjs, test-kernel-mode-headless.mjs). That is exactly
// right for a dozen surgical fixtures and impractical for a COMBINATORIAL
// suite: hand-writing the PM shape of a few hundred generated documents means
// hand-deriving the very thing under test, and any slip presents as a product
// failure.
//
// So this module assembles the real chain instead — nothing here is a
// hand-typed approximation of a vendored spec:
//   * the SCHEMA comes from the actual node/mark spec factories in
//     @milkdown/preset-commonmark, @milkdown/preset-gfm and
//     @milkdown/components, plus the app's own overrides imported straight from
//     src/ (editor-list-style, editor-tablebreak, editor-highlight,
//     editor-frontmatter, editor-image-markdown), registered in the SAME ORDER
//     the editor registers them;
//   * the REMARK chain is the presets' own `$remark` plugins (recovered by
//     running each one against a stub Ctx, see `extractRemarkPlugins`) followed
//     by the app's `remarkPluginsCtx` additions in editor-crepe-setup.js order;
//   * the parse is @milkdown/transformer's real `ParserState`, the same call
//     @milkdown/core makes: `ctx.set(parserCtx, ParserState.create(schema, remark))`;
//   * the markdown goes through the app's own `prepareEditorMarkdown` first,
//     because Editor.jsx hands the kernel `parse: (md) => parseAdapter.parse(md)`
//     and the adapter always prepares before parsing.
//
// HOW THE SPECS ARE EXTRACTED
// ---------------------------
// `$nodeSchema(id, factory)` / `$markSchema(id, factory)` (@milkdown/utils)
// store `factory` as the DEFAULT VALUE of a `$ctx` slice and expose that slice
// as `.key`. So `plugin.key._defaultValue` IS the `(ctx) => NodeSpec` factory
// and `plugin.key.name` IS the node id. Those factories read CONFIG slices
// only, so a stub ctx answering every `get(slice)` with the slice's own default
// reproduces an editor with no explicit `.config()` calls.
//
// `$remark(id, remark)` keeps its inner unified plugin in a closure and exposes
// only a ctx-bound Milkdown plugin that awaits `InitReady` and pushes
// `{plugin, options}` into `remarkPluginsCtx`. `extractRemarkPlugins` below
// runs exactly that against a stub Ctx and keeps what it pushed — so the REAL
// `remarkHtmlTransformer` / `remarkLineBreak` / `remarkMarker` / GFM plugin run
// here, not a re-implementation of them.
//
// REGISTRATION ORDER IS LOAD-BEARING, not cosmetic. `@milkdown/utils` registers
// a node as `ctx.update(nodesCtx, ns => [...ns.filter(n => n[0] !== id), [id, spec]])`,
// so a later `crepe.editor.use(...)` REPLACES an earlier spec for the same id
// (that is how the app's list-style / table-break / image-block-markdown
// overrides work) and the resulting key order decides what ProseMirror's
// `createAndFill` picks when it has to fill a `block+` hole. With the presets'
// own order, `paragraph` is the first block type and an empty blockquote fills
// with a paragraph, matching the live editor; sorted differently, `blockquote`
// or `footnote_definition` can be chosen and `createAndFill` recurses until the
// stack overflows.
//
// WHAT THIS IS *NOT*
// ------------------
// It is not a claim that a headless replica can substitute for the real app.
// It is a fixture generator whose fidelity is itself a testable proposition:
// scripts/test-mode-switch-combination-ui.mjs re-derives the same structural
// signature and the same read-only set inside the REAL running editor for a
// sample of these documents, and fails if the two disagree. Read that
// cross-check as the warrant for every headless result here — without it this
// file would be an assumption wearing a test's clothes.
//
// DOM: nothing here touches the DOM. `toDOM`/`parseDOM` are stored as function
// values and a Markdown parse never invokes them, so no shim is needed.
import { Schema } from '@milkdown/prose/model'
import { ParserState } from '@milkdown/transformer'
import { remark } from 'remark'
import { remarkPluginsCtx } from '@milkdown/core'
import remarkMath from 'remark-math'
import remarkFrontmatter from 'remark-frontmatter'
import { visit } from 'unist-util-visit'

import * as commonmark from '@milkdown/preset-commonmark'
import * as gfm from '@milkdown/preset-gfm'
import { imageBlockSchema, remarkImageBlockPlugin as imageBlockRemarkPlugin } from '@milkdown/components/image-block'

import { bulletListStyleSchema, orderedListStyleSchema, remarkCaptureListStyle } from '../../src/renderer/src/components/editor-list-style.js'
import { tableCellBreakMarkdownSchema, tableHeaderBreakMarkdownSchema, brToBreakRemarkPlugin } from '../../src/renderer/src/components/editor-tablebreak.js'
import { highlightSchema, highlightRemarkTransform } from '../../src/renderer/src/components/editor-highlight.js'
import { frontmatterSchema } from '../../src/renderer/src/components/editor-frontmatter.js'
import { imageBlockMarkdownSchema } from '../../src/renderer/src/components/editor-image-markdown.js'
import { remarkMergeInlineHtml } from '../../src/renderer/src/components/editor-html.js'
import { remarkUnwrapNonAsciiAutolinks } from '../../src/renderer/src/components/editor-autolink.js'
import { remarkNormalizeCodeOnlyLinkLabels } from '../../src/renderer/src/components/editor-link-labels.js'
import { remarkNormalizeRaggedGfmTables } from '../../src/renderer/src/components/editor-table-normalization.js'
import { remarkReconstructSubstitution } from '../../src/renderer/src/components/editor-criticmarkup-plugins.js'
import { prepareEditorMarkdown } from '../../src/renderer/src/components/editor-parse-adapter.js'

// A `$ctx` slice's default value is the unconfigured editor's value for it.
const stubCtx = { get: (slice) => slice?._defaultValue }

// Verbatim from @milkdown/preset-commonmark/src/node/{doc,text}.ts. These two
// are plain `$node`s (no config slice), so there is no `.key._defaultValue` to
// read; both specs are content-free and stable, and only their parse halves
// matter here.
const DOC_SPEC = {
  content: 'block+',
  parseMarkdown: {
    match: ({ type }) => type === 'root',
    runner: (state, node, type) => { state.injectRoot(node, type) }
  }
}
const TEXT_SPEC = {
  group: 'inline',
  parseMarkdown: {
    match: ({ type }) => type === 'text',
    runner: (state, node) => { state.addText(node.value) }
  }
}

// Crepe's latex feature keeps `mathInlineSchema` module-private (only the
// `latex` feature function is exported, and the package's `exports` map does
// not expose the file anyway). Transcribed from
// node_modules/@milkdown/crepe/lib/esm/feature/latex/index.js:98-140; only the
// `toDOM` half is dropped, because it calls `katex.render` into a real
// `document` and a Markdown parse never invokes it.
const MATH_INLINE_SPEC = {
  group: 'inline',
  inline: true,
  draggable: true,
  atom: true,
  attrs: { value: { default: '' } },
  parseMarkdown: {
    match: (node) => node.type === 'inlineMath',
    runner: (state, node, type) => { state.addNode(type, { value: node.value }) }
  }
}

// Same file :369-387: the mdast `math` BLOCK is rewritten to a `code` node
// tagged `LaTeX` before ProseMirror sees it, which is why the live PM side
// holds a `code_block` for `$$..$$` while the kernel's own parse keeps mdast
// `math` — buildProjectionMap pairs the two explicitly (`code_block:
// ['code','math']`).
const remarkMathBlock = () => (ast) => visit(ast, 'math', (node, index, parent) => {
  parent.children.splice(index, 1, { type: 'code', lang: 'LaTeX', value: node.value })
})

// Adapts a Milkdown `$nodeSchema`/`$markSchema` (or a hand-made stand-in) into
// `{ id, kind, spec }`.
function describeSchemaPlugin(plugin) {
  const key = plugin?.key
  const id = key?.name
  const factory = key?._defaultValue
  if (!id || typeof factory !== 'function') return null
  if (!plugin.node && !plugin.mark) return null
  return { id, kind: plugin.node ? 'node' : 'mark', factory }
}

// Runs a `$remark`'s ctx-bound plugin against a stub Ctx and returns whatever
// it pushed into `remarkPluginsCtx` — i.e. the REAL inner unified plugin the
// package never exports.
async function extractRemarkPlugins(remarkPlugin) {
  let collected = []
  const fakeCtx = {
    wait: async () => {},
    get: (slice) => slice?._defaultValue,
    update: (slice, updater) => {
      if (slice === remarkPluginsCtx) collected = updater(collected)
    }
  }
  const bound = remarkPlugin?.plugin
  if (typeof bound !== 'function') return []
  const run = bound(fakeCtx)
  if (typeof run !== 'function') return []
  await run()
  return collected
}

// The editor's schema registration order, flattened from the presets' own
// `schema` arrays and then the app's `crepe.editor.use(...)` calls
// (editor-crepe-setup.js:544-553). Later entries REPLACE earlier ones for the
// same node id, exactly as `nodesCtx` does.
const SCHEMA_PLUGINS = [
  // @milkdown/preset-commonmark `var schema = [...]`
  commonmark.paragraphSchema,
  commonmark.headingSchema,
  commonmark.hardbreakSchema,
  commonmark.blockquoteSchema,
  commonmark.codeBlockSchema,
  commonmark.hrSchema,
  commonmark.imageSchema,
  commonmark.bulletListSchema,
  commonmark.orderedListSchema,
  commonmark.listItemSchema,
  commonmark.emphasisSchema,
  commonmark.strongSchema,
  commonmark.inlineCodeSchema,
  commonmark.linkSchema,
  commonmark.htmlSchema,
  // @milkdown/preset-gfm `var schema = [...]`
  gfm.extendListItemSchemaForTask,
  gfm.tableSchema,
  gfm.tableHeaderRowSchema,
  gfm.tableRowSchema,
  gfm.tableHeaderSchema,
  gfm.tableCellSchema,
  gfm.footnoteDefinitionSchema,
  gfm.footnoteReferenceSchema,
  gfm.strikethroughSchema,
  // Crepe components / features
  imageBlockSchema,
  { key: { name: 'math_inline', _defaultValue: () => MATH_INLINE_SPEC }, node: true },
  // The app's own overrides + additions, editor-crepe-setup.js:544-553.
  commonmark.inlineCodeSchema.extendSchema((prev) => (ctx) => ({ ...prev(ctx), inclusive: false })),
  bulletListStyleSchema,
  orderedListStyleSchema,
  tableCellBreakMarkdownSchema,
  tableHeaderBreakMarkdownSchema,
  imageBlockMarkdownSchema,
  highlightSchema,
  frontmatterSchema
]

function buildSchema() {
  const nodes = { doc: DOC_SPEC, text: TEXT_SPEC }
  const marks = {}
  const failures = []
  for (const plugin of SCHEMA_PLUGINS) {
    const described = describeSchemaPlugin(plugin)
    if (!described) { failures.push('an entry in SCHEMA_PLUGINS is not a $nodeSchema/$markSchema'); continue }
    let spec
    try {
      spec = described.factory(stubCtx)
    } catch (error) {
      failures.push(`${described.id}: ${error.message}`)
      continue
    }
    if (!spec) { failures.push(`${described.id}: factory returned nothing`); continue }
    if (described.kind === 'node') nodes[described.id] = spec
    else marks[described.id] = spec
  }
  // Fail LOUD. A silently missing spec would make every document holding that
  // construct parse to some other shape, and the matrix would then be measuring
  // the harness rather than the product.
  if (failures.length) {
    throw new Error(`kernel-parse-harness: could not extract schema specs:\n  ${failures.join('\n  ')}`)
  }
  return new Schema({ nodes, marks })
}

export const editorSchema = buildSchema()

// THE LIVE ORDER — and it is NOT "presets first". Derived from Milkdown's own
// timing, then confirmed by behaviour (see the `<br>` note below):
//
//   * `@milkdown/core` init: `initTimerCtx = [ConfigReady]`, i.e. `InitReady`
//     resolves only AFTER `ConfigReady`.
//   * `$remark`'s handler (@milkdown/utils) does `await ctx.wait(InitReady)`
//     BEFORE `ctx.update(remarkPluginsCtx, rp => [...rp, {plugin, options}])`.
//   * the app's `crepe.editor.config(cb)` callback — which is where
//     editor-crepe-setup.js:532-542 does its own `ctx.update(remarkPluginsCtx,
//     ...)` — runs during `ConfigReady`.
//
// So when the app appends its 8 plugins, `remarkPluginsCtx` is still EMPTY:
// the app's additions are indices 0-7 and every `$remark`-registered plugin
// (commonmark, gfm, image-block, latex, highlight) lands after them.
//
// This is load-bearing, not bookkeeping. `remark-preserve-empty-line`
// (commonmark, index 13) DELETES any `html` node whose trimmed value is one of
// `<br>` / `<br/>` / `<br />` / `<br >`. With the order inverted — presets
// first — that plugin eats every inline `<br>` before
// `brToBreakRemarkPlugin` (index 5) can rewrite it, so `y<br>z` in a table
// cell parses to the single text node `"yz"`: PM content.size 2 against the
// kernel's decoded length 3, and the cell silently degrades to read-only. With
// the real order the `<br>` is already a `break` by index 5 and
// preserve-empty-line only bites at root / `linkReference` level, exactly as
// intended. Getting this backwards manufactures a read-only block that the
// live editor does not have.
const REMARK_CHAIN = [
  // --- indices 0-7: the app's own additions, editor-crepe-setup.js:532-542 ---
  { unified: remarkCaptureListStyle },
  { unified: remarkNormalizeRaggedGfmTables },
  { unified: remarkNormalizeCodeOnlyLinkLabels },
  { unified: remarkUnwrapNonAsciiAutolinks },
  { unified: remarkFrontmatter },
  { unified: brToBreakRemarkPlugin },
  { unified: remarkMergeInlineHtml },
  { unified: remarkReconstructSubstitution },
  // --- 8-13: @milkdown/preset-commonmark `var plugins = [...]` ---
  { milkdown: commonmark.remarkAddOrderInListPlugin },
  { milkdown: commonmark.remarkInlineLinkPlugin },
  { milkdown: commonmark.remarkLineBreak },
  { milkdown: commonmark.remarkHtmlTransformer },
  { milkdown: commonmark.remarkMarker },
  { milkdown: commonmark.remarkPreserveEmptyLinePlugin },
  // --- 14: @milkdown/preset-gfm ---
  { milkdown: gfm.remarkGFMPlugin },
  // --- 15: @milkdown/components image-block (enabled by DEFAULT in Crepe,
  //         which is why a standalone image is an `image-block` atom) ---
  { milkdown: imageBlockRemarkPlugin },
  // --- 16-17: Crepe's latex feature ---
  { unified: remarkMath },
  { unified: remarkMathBlock },
  // --- 18: the app's highlight parse transform (registered via `$remark`
  //         inside `highlightFeatures`, so it lands last) ---
  { unified: () => highlightRemarkTransform }
]

async function buildProcessor() {
  let processor = remark()
  for (const entry of REMARK_CHAIN) {
    if (entry.unified) {
      processor = processor.use(entry.unified)
      continue
    }
    const extracted = await extractRemarkPlugins(entry.milkdown)
    if (!extracted.length) {
      throw new Error('kernel-parse-harness: a $remark plugin yielded no unified plugin')
    }
    for (const { plugin: inner, options } of extracted) {
      processor = options === undefined ? processor.use(inner) : processor.use(inner, options)
    }
  }
  return processor
}

export const editorProcessor = await buildProcessor()
const parser = ParserState.create(editorSchema, editorProcessor)

// The editor's own entry point: Editor.jsx gives the kernel
// `parse: (md) => parseAdapter.parse(md)`, and `createEditorParseAdapter`
// always runs `prepareEditorMarkdown` first (display-math normalization, then
// review-markup normalization). The projection map is then built against the
// RAW bytes, so a preparation step that rewrites bytes is itself part of what
// the map has to survive — replicate it rather than skip it.
export function parseEditorMarkdown(markdown) {
  return parser(prepareEditorMarkdown(markdown))
}

// Structural signature of a PM document: the pre-order sequence of block-level
// node types with each one's own content size. Used as the matrix suite's
// stability oracle AND — verbatim, so the two are directly comparable — as the
// UI suite's harness-fidelity cross-check.
export function pmStructureSignature(pmDoc) {
  const out = []
  pmDoc.descendants((node) => {
    if (node.isInline) return false
    out.push(`${node.type.name}:${node.content.size}`)
    return true
  })
  return out
}

export { prepareEditorMarkdown }
