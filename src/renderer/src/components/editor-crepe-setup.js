import { Crepe, CrepeFeature as Feature } from '@milkdown/crepe'
import {
  editorViewOptionsCtx,
  nodeViewCtx,
  prosePluginsCtx,
  remarkPluginsCtx,
  remarkStringifyOptionsCtx
} from '@milkdown/kit/core'
import { imageBlockConfig } from '@milkdown/kit/component/image-block'
import { inlineImageConfig } from '@milkdown/kit/component/image-inline'
import { codeBlockConfig } from '@milkdown/kit/component/code-block'
import { inlineCodeSchema } from '@milkdown/kit/preset/commonmark'
import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language'
import remarkFrontmatter from 'remark-frontmatter'
import { tabAtCursorKeymap } from './editor-codeblock-tab.js'
import { createKernelCmExtensions } from './editor-kernel-cm-bridge.js'
import { BLOCK_TYPE_MARKERS, BLOCK_INSERT_TARGETS } from '../lib/source-kernel/index.js'
import {
  bulletListStyleSchema,
  listStyleStringifyHandler,
  orderedListStyleSchema,
  remarkCaptureListStyle,
  terminalTabTextHandler
} from './editor-list-style.js'
import { createSourceFirstOrderedListPlugin } from './editor-ordered-list-source.js'
import { renderHtmlNodeView, remarkMergeInlineHtml } from './editor-html.js'
import { remarkUnwrapNonAsciiAutolinks } from './editor-autolink.js'
import { remarkNormalizeCodeOnlyLinkLabels } from './editor-link-labels.js'
import { createMermaidPreviewRenderer, createMermaidSplitPlugin } from './editor-mermaid.js'
import {
  tableBreakKeymap,
  tableCellBreakHandler,
  tableCellBreakMarkdownSchema,
  tableHeaderBreakMarkdownSchema,
  brToBreakRemarkPlugin
} from './editor-tablebreak.js'
import { listBackspaceKeymap } from './editor-list-backspace.js'
import { mathPreviewPlugin } from './editor-math-preview.js'
import { createInlineMathEditingPlugin } from './editor-inline-math.js'
import { createSlashPlugin, disableCrepeSlash, SLASH_LANGUAGE_NAMES } from './editor-slash-menu.js'
import { toolbarAutohidePlugin } from './editor-toolbar-autohide.js'
import { createMathBlockPromotionPlugin } from './editor-math.js'
import {
  createBlockHandleGutterPlugin,
  getBlockHandlePosition
} from './editor-block-handle-guard.js'
import { createKatexDomPrunePlugin } from './editor-katex-dom-prune.js'
import { createInlineCodeEditingPlugin } from './editor-inline-code.js'
import { createTaskListInputPlugin } from './editor-task-list.js'
import { createSourceTransactionDispatch } from './editor-source-transactions.js'
import { frontmatterSchema, renderFrontmatterNodeView } from './editor-frontmatter.js'
import { highlightFeatures, highlightStringifyHandler } from './editor-highlight.js'
import { createReviewDecorationPlugin } from './editor-review.js'
import { normalizeWebPasteHtml } from './editor-web-paste.js'
import { imageBlockMarkdownSchema } from './editor-image-markdown.js'
import { remarkNormalizeRaggedGfmTables } from './editor-table-normalization.js'
import {
  createStrikeGuardPlugin,
  createSubstitutionLiveReconstructPlugin,
  remarkReconstructSubstitution
} from './editor-criticmarkup-plugins.js'

// A "Mermaid" entry for the code-block language picker. Mermaid has no real
// CodeMirror language; the picker only needs a language descriptor so users can
// choose "mermaid" directly, and the parser below is a deliberate no-op that
// highlights nothing.
//
// IT MUST STILL BE A *VALID* STREAM PARSER (bug fixed 2026-08-18). This was
// `StreamLanguage.define(() => ({ token: () => null }))`, which is wrong twice,
// and the consequence was far worse than "no syntax colours":
//   1. `StreamLanguage.define(spec)` takes the StreamParser OBJECT, not a
//      factory (@codemirror/language: `static define(spec) { return new
//      StreamLanguage(spec) }`). Given an arrow function, `streamParser.token`
//      was `undefined`, so every parse threw `TypeError: token is not a
//      function` inside `readToken`.
//   2. Even as an object, `token: () => null` never ADVANCES the stream, and
//      `readToken` throws `Stream parser failed to advance stream.` after ten
//      attempts. So `stream.skipToEnd()` is load-bearing, not decoration: it
//      emits the whole line as one untyped token. (An EMPTY line never reaches
//      `readToken` — `parseLine` routes it to `blankLine` — so skipping to the
//      end always advances.)
//
// WHY IT MATTERED. The throw escapes through `cm.dispatch()`. The vendored
// CodeMirrorBlock's `setSelection()` is
// `cm.focus(); this.updating = true; cm.dispatch(...); this.updating = false`,
// so a throw inside that dispatch leaves `updating` STUCK TRUE — and
// `forwardUpdate` begins with `if (this.updating || !this.cm.hasFocus) return`.
// The node view then accepts every keystroke into CodeMirror LOCALLY and never
// mirrors one into ProseMirror: the user sees their diagram source on screen
// while the document (and the file on disk) never receives it. Reproduced
// exactly that way by `/mermaid` in scripts/test-kernel-blockinsert-ui.mjs —
// the kernel's own source stayed an empty fence while CodeMirror showed
// `graph TD`, with no veto, no toast and no diagnostic, because no transaction
// was ever dispatched to have one.
const mermaidLanguage = LanguageDescription.of({
  name: 'Mermaid',
  alias: ['mermaid', 'mmd'],
  extensions: ['mmd', 'mermaid'],
  async load() {
    return new LanguageSupport(StreamLanguage.define({
      token(stream) {
        stream.skipToEnd()
        return null
      }
    }))
  }
})

// Slash-item id -> source-kernel block-type target (block-type conversion
// domain). ONE table drives BOTH the unblocking and the routing below, so an
// item can never be enabled without a kernel route behind it — an item
// unblocked without one would fall through to its legacy PM `run`
// (`setBlockType`/`wrapInBlockType`), which the gateway then vetoes: a menu
// entry that looks enabled and silently does nothing.
//
// The table is FILTERED through `BLOCK_TYPE_MARKERS`, the kernel's own target
// list, rather than merely matching it by hand: a target the kernel stops
// supporting drops out of the menu automatically instead of becoming a dead
// entry. `task` and `divider` are absent because the kernel refuses them (see
// lib/source-kernel/commands/block-type.js for each probed reason); they keep
// the phase-1 "not supported yet" message.
const KERNEL_BLOCK_TYPE_ITEMS = Object.freeze(Object.fromEntries(
  Object.entries({
    h1: 'heading1',
    h2: 'heading2',
    h3: 'heading3',
    h4: 'heading4',
    h5: 'heading5',
    h6: 'heading6',
    bullet: 'bullet',
    ordered: 'ordered'
  }).filter(([, target]) => Object.hasOwn(BLOCK_TYPE_MARKERS, target))
))

// Slash-item id -> source-kernel block-INSERT route (block-insert domain: the
// menu items that create a NEW block instead of converting this one). Same
// single-source-of-truth property as the block-type table above — `isBlocked`
// and the `run` swap both go through THIS function, so an item can never be
// enabled without a route — but expressed as a function rather than a table,
// because the language items' ids are generated per keystroke
// (`'code:javascript'`, see editor-slash-menu.js's `languageItemsFor`).
//
// Three filters, each closing a way the menu and the kernel could drift:
//  1. `BLOCK_INSERT_TARGETS` — the kernel's own target list. A target it stops
//     supporting drops out of the menu automatically.
//  2. `SLASH_LANGUAGE_NAMES` — the menu's own language table. An id shaped
//     like `code:<x>` that this menu never generates is not routed (no string
//     pattern-matching a language name into existence).
//  3. `PREVIEW_SLASH_LANGUAGES` — a MENU-side hold, not a kernel one. As of
//     2026-08-18 editor-kernel-projection-map.js pairs a ```mermaid /
//     ```latex fence EDITABLY (see the ADR that replaced its
//     `READONLY_CODE_LANGUAGES`), so these no longer create a block the user
//     cannot type into. They are held back one more step purely so the
//     "created block is typable in the real app" claim is proven by a UI
//     fixture before the items ship — this set is the single place to empty
//     when it is. It is declared HERE, not imported from the projection map:
//     which languages render a preview is a display fact about the slash
//     menu, and the byte-mapping module must not carry a display opinion.
//
// Absent on purpose, each for a probed reason recorded in
// lib/source-kernel/commands/block-insert.js: `math` (block math pairs
// read-only), `task` (bare `- [ ] ` is not a task item to remark-gfm at all),
// `image` (an image-block is an atom — no caret home), `divider` (a thematic
// break is a PM leaf with no text position), `text` (a fully-empty top-level
// paragraph has no raw representation).
const KERNEL_INSERT_ITEMS = Object.freeze({ table: 'table', code: 'code' })
const PREVIEW_SLASH_LANGUAGES = new Set(['mermaid', 'latex'])
const KERNEL_LANGUAGE_IDS = new Set(SLASH_LANGUAGE_NAMES
  .filter((name) => !PREVIEW_SLASH_LANGUAGES.has(name))
  .map((name) => 'code:' + name))

function kernelSlashInsertRoute(id) {
  const direct = KERNEL_INSERT_ITEMS[id]
  if (direct) return Object.hasOwn(BLOCK_INSERT_TARGETS, direct) ? { target: direct } : null
  if (!KERNEL_LANGUAGE_IDS.has(id)) return null
  if (!Object.hasOwn(BLOCK_INSERT_TARGETS, 'code')) return null
  return { target: 'code', language: id.slice('code:'.length) }
}

export function applyImageText(ctx, tt) {
  try {
    ctx.update(imageBlockConfig.key, (v) => ({
      ...v,
      captionPlaceholderText: tt('image.caption'),
      uploadPlaceholderText: tt('image.pasteLink'),
      uploadButton: tt('image.uploadFile'),
      confirmButton: tt('image.confirm')
    }))
    ctx.update(inlineImageConfig.key, (v) => ({
      ...v,
      uploadPlaceholderText: tt('image.pasteLink'),
      uploadButton: tt('image.upload'),
      confirmButton: tt('image.confirm')
    }))
  } catch {
    /* config not ready yet */
  }
}

export function createConfiguredCrepe({
  host,
  defaultValue,
  getT,
  persistImage,
  notify,
  copyText,
  getInlineMathDeleteMode,
  markUserEdit,
  isReadOnly,
  onFrontmatterValueChange,
  onInlineCodeValueChange,
  onSlashCommand,
  onSourceTransactions,
  // Source-kernel mode (Plan 2 Task 5). `kernelPlugins` is the KernelMode
  // controller (editor-kernel-mode.js) whose structural/history keymaps must
  // outrank every other keymap. Both default off; non-kernel callers get a
  // byte-identical configuration.
  kernelMode = false,
  kernelPlugins = null
}) {
  const t = getT
  // Source-kernel mode (Task 7 blocking matrix): mark the Crepe root so the
  // block drag/add handle can be hidden purely in CSS
  // (`.hm-kernel-mode .milkdown-block-handle` in app.css) — belt-and-suspenders
  // on top of not registering createBlockHandleGutterPlugin() below and the
  // drop-veto already wired in Task 3. Non-kernel callers never get the class.
  if (kernelMode) host.classList.add('hm-kernel-mode')
  const platform = window.api?.platform
  const isMobile = platform === 'ios' || platform === 'android'
  const crepe = new Crepe({
    root: host,
    defaultValue,
    features: {
      // Mobile already presents the native text-selection menu. Showing Crepe's
      // toolbar at the same time creates two overlapping action surfaces and can
      // cover the selected text, so mobile keeps the native menu only.
      [Feature.SelectionTooltip]: !isMobile,
      // Kernel mode included (Plan 4 Task 3): the toolbar's mark commands
      // (toggleStrongCommand & friends → PM toggleMark) dispatch transactions
      // the gateway now classifies as `mark-toggle` and routes through the
      // kernel (veto + source commit + reconcile), so the toolbar is back on
      // in kernel mode. Buttons whose command the kernel does not own (link,
      // inline latex) still dispatch and get a veto + toast — the fail-closed
      // refusal path, not a silent no-op.
      [Feature.Toolbar]: true,
      [Feature.SlashCommand]: true,
      [Feature.BlockEdit]: true,
      [Feature.CodeMirror]: true,
      [Feature.Table]: true,
      [Feature.InlineCode]: true,
      [Feature.LinkTooltip]: true,
      [Feature.Latex]: true,
      // Disable Crepe's virtual cursor; the native caret avoids content jumps
      // and remains visible inside table cells.
      [Feature.Cursor]: false
    },
    featureConfigs: {
      [Feature.Placeholder]: { text: t('editor.placeholder'), mode: 'block' },
      [Feature.BlockEdit]: {
        blockHandle: {
          getPosition: getBlockHandlePosition,
          getOffset: () => 0
        }
      },
      [Feature.CodeMirror]: {
        copyText: t('code.copy'),
        previewToggleText: (previewOnly) =>
          previewOnly ? t('mermaid.editCode') : t('mermaid.hideCode'),
        // Kernel mode (Plan 3 Task 5): code blocks are editable per-block —
        // the bridge consults `isCmBlockEditable(cmView)` at EVERY input
        // event (typing/IME/paste/drop/cut/keydown), so LF blocks with a
        // proven charMap edit natively (CM -> forwardUpdate -> gateway
        // commit) while mermaid/latex/math and non-LF blocks stay blocked
        // with zero staleness. A CM-focused undo/redo must reach the SAME
        // kernel history `runHistory` entry point PM-focused Mod-z uses,
        // never prosemirror-history, and Mod-Enter routes to the kernel's
        // own exit-code command instead of PM's exitCode (see
        // editor-kernel-cm-bridge.js header for the full input-path
        // coverage matrix).
        extensions: kernelMode
          ? [
              tabAtCursorKeymap,
              ...createKernelCmExtensions({
                runUndo: () => kernelPlugins?.runHistory?.('undo'),
                runRedo: () => kernelPlugins?.runHistory?.('redo'),
                runExitCode: (cmView) => kernelPlugins?.runExitCode?.(cmView),
                isActive: () => !!kernelPlugins?.isActive?.(),
                isEditable: (cmView) => !!kernelPlugins?.isCmBlockEditable?.(cmView)
              })
            ]
          : [tabAtCursorKeymap]
      },
      [Feature.Latex]: {
        katexOptions: {
          output: window.api?.platform === 'win32' ? 'html' : 'htmlAndMathml'
        }
      }
    }
  })

  crepe.editor.config((ctx) => {
    // Neutralize Crepe's built-in slash menu (its label-only filter can't match
    // keywords, so typing past "/" made the menu vanish). Our Feishu-style menu
    // in editor-slash-menu.js replaces it. Feature.BlockEdit stays enabled so
    // the block drag/add handle (.milkdown-block-handle) is preserved.
    disableCrepeSlash(ctx)
    ctx.update(editorViewOptionsCtx, (options) => ({
      ...options,
      dispatchTransaction: createSourceTransactionDispatch(onSourceTransactions),
      transformPastedHTML: (html, view) => {
        const transformed = options.transformPastedHTML
          ? options.transformPastedHTML(html, view)
          : html
        return normalizeWebPasteHtml(transformed)
      }
    }))
    ctx.update(nodeViewCtx, (views) => [
      ...views,
      ['html', (node) => renderHtmlNodeView(node)],
      ['frontmatter', (node, view, getPos) => renderFrontmatterNodeView(node, view, getPos, {
        labels: {
          edit: t('frontmatter.edit'),
          done: t('frontmatter.done'),
          input: t('frontmatter.input')
        },
        onEdit: markUserEdit,
        onValueChange: onFrontmatterValueChange,
        canEdit: () => !isReadOnly?.()
      })]
    ])

    applyImageText(ctx, getT)
    ctx.update(imageBlockConfig.key, (v) => ({ ...v, onUpload: persistImage }))
    ctx.update(inlineImageConfig.key, (v) => ({ ...v, onUpload: persistImage }))

    const mermaidRender = createMermaidPreviewRenderer(getT)
    ctx.update(codeBlockConfig.key, (v) => {
      const prevRender = v.renderPreview
      return {
        ...v,
        languages: [mermaidLanguage, ...(v.languages || [])],
        renderPreview: (language, text, setPreview) => {
          if ((language || '').toLowerCase() === 'mermaid') {
            return mermaidRender(language, text, setPreview)
          }
          return prevRender ? prevRender(language, text, setPreview) : null
        },
        previewOnlyByDefault: true,
        previewLabel: t('mermaid.diagram'),
        previewLoading: t('mermaid.rendering')
      }
    })

    // Built once so kernel mode can reposition the SAME instance ahead of the
    // kernel keymaps (see below) without changing anything about the plugin
    // itself or its non-kernel position/behavior.
    const slashPlugin = createSlashPlugin(
      ctx,
      getT,
      onSlashCommand,
      // Source-kernel mode: every slash item is a structural insert the
      // kernel can't own yet (phase 1 of the blocking matrix) — block all
      // ids, keep them visible-but-disabled (handled in editor-slash-menu.js).
      // 'quote' is the one exception (Plan 4 Task 4): it stays enabled and
      // its `run` is swapped (via `quoteToggle`) to route through the
      // kernel instead of PM's `wrapInBlockTypeCommand`. `runQuoteToggleFromQuery`
      // (not the plain `runQuoteToggle`, Plan 4 Task 5 fix) — the slash item's
      // `shouldShow` guarantees the current block's ENTIRE raw text is the
      // typed "/quote" query, so this entry point strips those query bytes
      // and wraps atomically in one kernel transaction (see its own ADR
      // comment in editor-kernel-mode.js for why a separate clear-then-wrap
      // doesn't work).
      //
      // The block-type items (h1-h6, bullet, ordered) are unblocked the SAME
      // way (block-type conversion domain): their `run` is swapped for
      // `runBlockTypeFromQuery`, which replaces the query bytes with the
      // target's marker prefix in ONE kernel transaction. `KERNEL_BLOCK_TYPE_ITEMS`
      // is the single source of truth for which ids are routed AND which are
      // unblocked, so the two can never drift apart (an item unblocked
      // without a route would dispatch legacy PM structural steps the gateway
      // then vetoes — a silently dead menu entry).
      //
      // The block-INSERT items (`/table`, `/code`, `/js` …) are unblocked the
      // same way again, through `kernelSlashInsertRoute` + `blockInsert` ->
      // `runInsertBlockFromQuery`, which writes the new block's BYTES and
      // strips the query in ONE kernel transaction. That resolver is the single
      // source of truth for both halves here too.
      //
      // Everything still absent (task, divider, text, image, math, and the
      // preview-only languages `/mermaid` and `/latex`) keeps the phase-1
      // refusal message. Each is refused for a probed reason recorded in
      // lib/source-kernel/commands/block-type.js and
      // lib/source-kernel/commands/block-insert.js.
      //
      // THE DEGRADED-TAB HOLE (2026-08-17, "the slash items do nothing"):
      // `kernelMode` is the tab's SETTING, not the kernel's live authority.
      // When `attachAfterCreate` cannot build a projection map (an unmappable
      // document, or a chunked/heavy load) the controller sets `degraded` and
      // hands the tab back to the legacy pipeline wholesale — but this option
      // object was already built, so every item stayed either blocked or
      // routed to a kernel entry point that now bails out at its own
      // `inactive()` guard and returns false WITHOUT a toast. The menu closed
      // and nothing happened, on every item, with no message: exactly the
      // reported symptom, and it applied to `quote` just as much as to the
      // block types. Both halves are fixed here and in editor-slash-menu.js:
      //  * `isBlocked` returns null for EVERY item once the kernel is not
      //    active — a degraded tab is a legacy tab, and legacy owns them all;
      //  * the `run` swap falls back to the item's own legacy command when
      //    the kernel route reports "not handled" (see the menu's own note).
      // `isActive()` is read at CLICK time, not captured, so a tab that
      // degrades after mount is covered.
      kernelMode
        ? {
            isBlocked: (id) => {
              if (!kernelPlugins?.isActive?.()) return null
              const routed = id === 'quote' || KERNEL_BLOCK_TYPE_ITEMS[id] || kernelSlashInsertRoute(id)
              return routed ? null : 'kernelMode.unsupported'
            },
            notify,
            quoteToggle: (view) => kernelPlugins?.runQuoteToggleFromQuery?.(view),
            blockTypeItems: KERNEL_BLOCK_TYPE_ITEMS,
            blockType: (target, view) => kernelPlugins?.runBlockTypeFromQuery?.(target, view),
            insertRoute: kernelSlashInsertRoute,
            blockInsert: (route, view) => kernelPlugins?.runInsertBlockFromQuery?.(route, view)
          }
        : undefined
    )

    ctx.update(prosePluginsCtx, (plugins) => [
      // Kernel mode ONLY (阻止矩阵, Task 11 finding): the slash menu's own
      // key handling (Enter/Arrow/Tab/Escape) must win over the kernel's
      // structural Enter/Tab handlers WHILE THE MENU IS OPEN — otherwise a
      // blocked slash item's Enter "selection" is preempted by an
      // uncontrolled kernel structural edit (e.g. a real paragraph split)
      // instead of the intended "hide the menu + toast, no doc change"
      // refusal. `SlashMenu.onKey` is a true no-op
      // (`if (!this.shown()) return false`) whenever the menu isn't open, so
      // placing it first here has ZERO effect on any other key handling —
      // this is purely about who wins the race while the menu IS open.
      ...(kernelMode ? [slashPlugin] : []),
      // Kernel mode: structural (Enter/Tab/Shift-Tab/Backspace/Delete) and
      // history (Mod-z/Mod-y/Shift-Mod-z) keys are routed through the source
      // kernel next — these keymaps must sit at the head of the REMAINING
      // plugin order, before listBackspaceKeymap and every preset keymap, or
      // PM's own structural commands would fire and be vetoed after the fact.
      // marksKeymap (Plan 4 Task 3) sits in the same slot: it swallows the
      // five mark shortcuts (Mod-b/i/e, Mod-Alt-x/h) ONLY on an empty
      // selection ("select text first" toast — a stored-marks toggle would
      // otherwise arm a marked-slice typing trap the gateway then vetoes
      // keystroke by keystroke); with a real selection it falls through to
      // the preset's own toggleMark, whose transaction the gateway owns.
      ...(kernelMode && kernelPlugins
        ? [
            kernelPlugins.structuralKeymap(),
            kernelPlugins.historyKeymap(),
            ...(typeof kernelPlugins.marksKeymap === 'function' ? [kernelPlugins.marksKeymap()] : [])
          ]
        : []),
      // Markdown, not a rich-only list boundary, is the durable authority.
      // Merge an internally-created adjacent ordered list before downstream
      // source observers see a serializer-forced `1)` delimiter.
      createSourceFirstOrderedListPlugin(),
      // Must run BEFORE the preset keymaps in `plugins`: the CommonMark preset
      // binds Backspace to a generic joinBackward that merges an empty list
      // item into the previous item instead of exiting the list.
      listBackspaceKeymap(),
      createStrikeGuardPlugin(),
      // Source-kernel mode: the block handle only offers structural
      // operations (drag-reorder, add-block, turn-into) the kernel doesn't
      // own yet, so it isn't registered at all — not merely hidden by CSS.
      ...(kernelMode ? [] : [createBlockHandleGutterPlugin()]),
      ...plugins,
      tableBreakKeymap(),
      createInlineCodeEditingPlugin({
        onEdit: markUserEdit,
        onValueChange: onInlineCodeValueChange
      }),
      createTaskListInputPlugin(),
      createInlineMathEditingPlugin({ getDeleteMode: getInlineMathDeleteMode }),
      createKatexDomPrunePlugin(),
      mathPreviewPlugin(getT),
      // Non-kernel mode: unchanged position (after the preset keymaps),
      // byte-identical to before this reordering — same `slashPlugin`
      // instance built once above, just placed earlier for kernel mode only.
      ...(kernelMode ? [] : [slashPlugin]),
      toolbarAutohidePlugin(),
      createReviewDecorationPlugin({
        getT: (key, fallback) => {
          const value = getT(key)
          return !value || value === key ? fallback : value
        },
        notify: (key, fallback) => notify(getT(key) || fallback),
        copyText: (text, doneKey, doneFallback) =>
          copyText(text, getT(doneKey) || doneFallback)
      }),
      // Source-kernel mode (2026-08-18): NOT registered. This plugin's
      // appendTransaction replaces one mermaid `code_block` with N, i.e. its
      // slice carries NODE content — a shape the gateway can only classify
      // `blocked`, which vetoes the WHOLE batch including the user's own
      // keystroke. And it rescans the ENTIRE document on every change, so a
      // single already-mashed 2-diagram block turned every keystroke anywhere
      // in the document into a refusal toast. Since mermaid fences became
      // editable in kernel mode that path is reachable by ordinary typing, so
      // the plugin is removed rather than left to lose every race it enters.
      // Legacy mode keeps it exactly as before.
      ...(kernelMode ? [] : [createMermaidSplitPlugin()]),
      createSubstitutionLiveReconstructPlugin(),
      createMathBlockPromotionPlugin()
    ])

    ctx.update(remarkStringifyOptionsCtx, (opts) => ({
      ...opts,
      handlers: {
        ...(opts?.handlers || {}),
        break: tableCellBreakHandler,
        highlight: highlightStringifyHandler,
        list: listStyleStringifyHandler,
        text: terminalTabTextHandler
      }
    }))

    ctx.update(remarkPluginsCtx, (plugins) => [
      ...plugins,
      { plugin: remarkCaptureListStyle, options: undefined },
      { plugin: remarkNormalizeRaggedGfmTables, options: undefined },
      { plugin: remarkNormalizeCodeOnlyLinkLabels, options: undefined },
      { plugin: remarkUnwrapNonAsciiAutolinks, options: undefined },
      { plugin: remarkFrontmatter, options: undefined },
      { plugin: brToBreakRemarkPlugin, options: undefined },
      { plugin: remarkMergeInlineHtml, options: undefined },
      { plugin: remarkReconstructSubstitution, options: undefined }
    ])
  })

  crepe.editor.use(
    inlineCodeSchema.extendSchema((prev) => (ctx) => ({ ...prev(ctx), inclusive: false }))
  )
  crepe.editor.use(bulletListStyleSchema)
  crepe.editor.use(orderedListStyleSchema)
  crepe.editor.use(tableCellBreakMarkdownSchema)
  crepe.editor.use(tableHeaderBreakMarkdownSchema)
  crepe.editor.use(imageBlockMarkdownSchema)
  crepe.editor.use(highlightFeatures)
  crepe.editor.use(frontmatterSchema)

  return crepe
}
