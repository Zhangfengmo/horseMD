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
import { createSlashPlugin, disableCrepeSlash } from './editor-slash-menu.js'
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
// choose "mermaid" directly.
const mermaidLanguage = LanguageDescription.of({
  name: 'Mermaid',
  alias: ['mermaid', 'mmd'],
  extensions: ['mmd', 'mermaid'],
  async load() {
    return new LanguageSupport(StreamLanguage.define(() => ({ token: () => null })))
  }
})

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
      // Kernel mode: the selection toolbar's formatting commands produce
      // structural transactions the kernel cannot own yet — they would all be
      // vetoed, so the toolbar is disabled at the feature level instead.
      [Feature.Toolbar]: !kernelMode,
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
        // Kernel mode: code blocks are non-editable pairs in the projection
        // map (no character-level decode contract), so their CodeMirror
        // editors are read-only until the kernel owns fenced-code edits —
        // and a CM-focused undo/redo must reach the SAME kernel history
        // `runHistory` entry point PM-focused Mod-z uses, never
        // prosemirror-history (see editor-kernel-cm-bridge.js header for
        // both defects and why a bare `CmEditorState.readOnly.of(true)`
        // here was silently overridden by the nodeview's own extension).
        extensions: kernelMode
          ? [
              tabAtCursorKeymap,
              ...createKernelCmExtensions({
                runUndo: () => kernelPlugins?.runHistory?.('undo'),
                runRedo: () => kernelPlugins?.runHistory?.('redo')
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
      kernelMode ? { isBlocked: () => 'kernelMode.unsupported', notify } : undefined
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
      ...(kernelMode && kernelPlugins
        ? [kernelPlugins.structuralKeymap(), kernelPlugins.historyKeymap()]
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
      createMermaidSplitPlugin(),
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
