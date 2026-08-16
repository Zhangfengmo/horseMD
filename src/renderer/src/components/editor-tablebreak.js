// In-cell line breaks for tables (issue #7), with a clean <br> round-trip.
//
// GFM table cells must be a single line; the only valid in-cell break is <br>.
// Four focused pieces, including a table-cell-only Markdown schema extension:
//   1. keymap     — Enter / Shift+Enter inside a cell inserts a hardbreak node
//                   (renders as <br> in the editor).
//   2. serialize  — a custom remark `break` handler emits <br> *only* inside a
//                   tableCell; everywhere else it defers to the default (so normal
//                   paragraph line breaks are unchanged).
//   3. serialize  — the GFM body/header cell schemas retain terminal hardbreaks
//                   that Milkdown's generic paragraph serializer would drop.
//   4. parse      — a remark transform turns inline `<br>` html nodes into break
//                   nodes, so <br> in a cell renders as a line break (and the
//                   previously-dropped <br> now shows up).
import { keymap } from '@milkdown/prose/keymap'
import { tableCellSchema, tableHeaderSchema } from '@milkdown/kit/preset/gfm'
import { defaultHandlers } from 'mdast-util-to-markdown'
// Shared with the source kernel: the kernel's inline-HTML coalescer must know
// which html nodes this plugin will have already turned into `break` nodes, or
// the two chains disagree on where a merged fragment ends (see
// lib/source-kernel/inline-html.js).
import { isInlineBreakHtml, BREAK_REWRITE_PARENTS } from '../lib/source-kernel/inline-html.js'
// Node types whose children are phrasing content — the only places an inline
// <br> legitimately appears, so we only rewrite there (never at block level,
// which would produce an invalid mdast break). The set itself now lives in
// lib/source-kernel/inline-html.js as BREAK_REWRITE_PARENTS: the inline-HTML
// coalescer (both chains) has to answer the very same question — "has this
// container's `<br>` already become a `break` node?" — and two copies of the
// list could drift apart silently.
const PHRASING_PARENTS = BREAK_REWRITE_PARENTS

// --- 2. serialize: break → <br> inside a table cell ---
export function tableCellBreakHandler(node, parent, state, info) {
  if (state.stack && state.stack.includes('tableCell')) return '<br>'
  return defaultHandlers.break(node, parent, state, info)
}

// --- 3. parse: inline <br> html → break ---
export function brToBreakRemarkPlugin() {
  return (tree) => {
    const walk = (node) => {
      if (!node || !Array.isArray(node.children)) return
      if (PHRASING_PARENTS.has(node.type)) {
        node.children = node.children.map((c) =>
          c && c.type === 'html' && isInlineBreakHtml(c.value)
            ? {
                type: 'break',
                ...(c.position ? { position: { ...c.position } } : {})
              }
            : c
        )
      }
      node.children.forEach(walk)
    }
    walk(tree)
  }
}

// Milkdown's commonmark paragraph serializer intentionally removes a trailing
// hardbreak before walking inline content. That is appropriate for ordinary
// Markdown paragraphs, where a break with no following line has no durable
// rendering, but it is lossy inside a GFM table cell: `<br>` is the cell's
// only line-break representation and a sole/trailing break is authored data.
//
// Extend only the GFM body/header cell serializers. All other paragraphs,
// empty-cell placeholders, multi-block cells, and inline-only breaks keep the
// upstream behavior. The existing mdast break handler below remains the sole
// place that chooses the table-cell `<br>` spelling.
const preserveTerminalTableHardbreak = (feature) => feature.extendSchema((prev) => (ctx) => {
  const schema = prev(ctx)
  const baseRunner = schema.toMarkdown.runner
  return {
    ...schema,
    toMarkdown: {
      ...schema.toMarkdown,
      runner: (state, node) => {
        const paragraph = node.childCount === 1 && node.firstChild?.type.name === 'paragraph'
          ? node.firstChild
          : null
        const terminal = paragraph?.lastChild
        const hasDurableTerminalHardbreak = (
          terminal?.type.name === 'hardbreak' &&
          terminal.attrs?.isInline === false
        )
        if (!paragraph || !hasDurableTerminalHardbreak) {
          baseRunner(state, node)
          return
        }
        state.openNode('tableCell')
        state.openNode('paragraph')
        state.next(paragraph.content)
        state.closeNode()
        state.closeNode()
      }
    }
  }
})

export const tableCellBreakMarkdownSchema = preserveTerminalTableHardbreak(tableCellSchema)
export const tableHeaderBreakMarkdownSchema = preserveTerminalTableHardbreak(tableHeaderSchema)

// --- 1. keymap: insert a break inside a table cell ---
function inTableCell($from) {
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name
    if (name === 'table_cell' || name === 'table_header') return true
  }
  return false
}

export function tableBreakKeymap() {
  const insertBreak = (state, dispatch) => {
    const { $from, empty } = state.selection
    if (!empty || !inTableCell($from)) return false
    const br = state.schema.nodes.hardbreak
    if (!br) return false
    if (dispatch) {
      dispatch(state.tr.replaceSelectionWith(br.create({ isInline: false }), true).scrollIntoView())
    }
    return true
  }
  // Enter and Shift+Enter both break the line in a cell (plain Enter otherwise
  // just jumps out of the table — issue #7's complaint).
  return keymap({ Enter: insertBreak, 'Shift-Enter': insertBreak, 'Mod-Enter': insertBreak })
}
