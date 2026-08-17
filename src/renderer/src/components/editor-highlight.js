// `==highlight==` syntax (issue #14) — a Typora-style highlight mark that also
// supports a few colors (yellow / red / blue).
//
// Milkdown ships no highlight preset (`==` isn't standard GFM), so we build the
// mark + a two-way remark plugin:
//   - parse:  `==text==` → highlight (yellow);  `<mark class="hm-hl-red">x</mark>`
//             → highlight with that color (inline HTML is coalesced first).
//   - stringify: yellow → `==text==`;  red/blue → `<mark class="hm-hl-…">text</mark>`
// Renders as <mark class="hm-highlight hm-hl-…">, with a toolbar color picker
// (Editor.jsx) and the Mod-Alt-H shortcut (yellow).

import { commandsCtx } from '@milkdown/core'
import { markRule } from '@milkdown/prose'
import { toggleMark } from '@milkdown/prose/commands'
import { $command, $inputRule, $markAttr, $markSchema, $remark, $useKeymap } from '@milkdown/utils'
import { findAndReplace } from 'mdast-util-find-and-replace'
// The `==` rule itself now lives in the source kernel's pure shared module —
// same arrangement as inline-html.js (editor-html.js): the kernel has to
// recognize EXACTLY what this plugin recognizes, and two copies of a regex
// with a lookbehind, a lookahead and a whitespace-flank rule would drift.
// Behavior here is unchanged: the identical literal, passed to the identical
// `findAndReplace` call.
import { HIGHLIGHT_RE } from '../lib/source-kernel/highlight-syntax.js'

export const HIGHLIGHT_COLORS = ['yellow', 'red', 'blue']

export const highlightAttr = $markAttr('highlight')

// Re-exported for existing importers (and for tests that assert the two
// chains share ONE rule).
export { HIGHLIGHT_RE }

export const highlightSchema = $markSchema('highlight', (ctx) => ({
  attrs: {
    color: { default: 'yellow' }
  },
  // Pasted <mark class="hm-hl-…"> becomes a highlight mark of that color.
  parseDOM: [
    {
      tag: 'mark.hm-highlight, mark.hm-hl-yellow, mark.hm-hl-red, mark.hm-hl-blue',
      getAttrs: (dom) => ({ color: colorFromClass(dom.className) })
    }
  ],
  toDOM: (mark) => [
    'mark',
    {
      class: 'hm-highlight hm-hl-' + (mark.attrs.color || 'yellow'),
      ...ctx.get(highlightAttr.key)(mark)
    }
  ],
  // Non-inclusive: typing after `==x==` exits the highlight, like inline code.
  inclusive: false,
  parseMarkdown: {
    match: (node) => node.type === 'highlight',
    runner: (state, node, markType) => {
      state.openMark(markType, { color: node.color || 'yellow' })
      state.next(node.children)
      state.closeMark(markType)
    }
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'highlight',
    runner: (state, mark) => {
      // Carry the color onto the mdast node so the stringify handler can pick
      // `==text==` (yellow) vs `<mark class="hm-hl-…">` (other colors).
      state.withMark(mark, 'highlight', undefined, { color: mark.attrs.color })
    }
  }
}))

function colorFromClass(cls) {
  for (const c of HIGHLIGHT_COLORS) if ((' ' + cls + ' ').includes(' hm-hl-' + c + ' ')) return c
  return 'yellow'
}

// Parse a complete `<mark class="hm-hl-COLOR">…</mark>` fragment into {color,text}.
const MARK_HTML_RE = /^<mark\s+class="hm-hl-(yellow|red|blue)"\s*>([\s\S]*?)<\/mark>$/

// Parse direction (remark): `==text==` in a text node → highlight node, and a
// balanced inline-HTML `<mark class="hm-hl-…">text</mark>` → highlight node.
// findAndReplace only touches `text` nodes, so inline code / code blocks / math
// (separate node types) are naturally left alone.
// The transform itself, exported (Plan 5 Task 3) so the cross-parser
// consistency suite can run the REAL editor-side rule — not a copy of it —
// against the kernel's own recognition. `highlightRemark` below is this
// function wrapped in Milkdown's `$remark`; nothing about its behavior or
// registration changed.
export function highlightRemarkTransform(tree) {
  findAndReplace(tree, [
    [
      HIGHLIGHT_RE,
      (_whole, _eq, content) => ({
        type: 'highlight',
        color: 'yellow',
        data: { hName: 'mark' },
        children: [{ type: 'text', value: content }]
      })
    ]
  ])
  coalesceMarkHtml(tree)
  return tree
}

export const highlightRemark = $remark('highlightParse', () => () => highlightRemarkTransform)

// Convert inline-HTML <mark class="hm-hl-…">…</mark> into highlight mdast nodes.
// Commonmark splits `<mark>x</mark>` into open/text/close html nodes; we coalesce
// a balanced run of consecutive html+text siblings (self-contained — doesn't
// depend on the general inline-HTML merge plugin running first) and, when the
// whole run is one `<mark class=…>…</mark>`, swap it for a highlight node.
function coalesceMarkHtml(node) {
  if (!Array.isArray(node.children)) return
  for (const c of node.children) coalesceMarkHtml(c)
  const kids = node.children
  const next = []
  let i = 0
  while (i < kids.length) {
    const c = kids[i]
    if (c.type === 'html' && /^<mark\b/i.test(c.value) && !/^<\//.test(c.value)) {
      let raw = ''
      let j = i
      let matched = null
      while (j < kids.length) {
        const k = kids[j]
        if (k.type !== 'html' && k.type !== 'text') break
        raw += k.value
        j += 1
        const m = raw.match(MARK_HTML_RE)
        if (m) {
          matched = m
          break
        }
      }
      if (matched) {
        next.push({
          type: 'highlight',
          color: matched[1],
          data: { hName: 'mark' },
          children: [{ type: 'text', value: matched[2] }]
        })
        i = j
        continue
      }
    }
    next.push(c)
    i += 1
  }
  node.children = next
}

// Stringify direction (remark handler, registered on remarkStringifyOptionsCtx).
// yellow → ==text== ; red/blue → <mark class="hm-hl-…">text</mark> (round-trips
// back into a colored mark via coalesceMarkHtml on reload).
export function highlightStringifyHandler(node, _parent, state, info) {
  const inner = state.containerPhrasing(node, info)
  if (!inner) return ''
  const color = node.color || 'yellow'
  if (color === 'yellow') return `==${inner}==`
  return `<mark class="hm-hl-${color}">${inner}</mark>`
}

export const toggleHighlightCommand = $command('ToggleHighlight', (ctx) => () =>
  toggleMark(highlightSchema.type(ctx))
)

export const highlightInputRule = $inputRule((ctx) =>
  // Fires as you type the closing `==` (yellow highlight).
  markRule(/(?<![={])==(?!\})([^=\s][^=]*[^=\s]|[^=\s])==$/, highlightSchema.type(ctx))
)

export const highlightKeymap = $useKeymap('highlightKeymap', {
  ToggleHighlight: {
    shortcuts: 'Mod-Alt-h',
    command: (ctx) => {
      const commands = ctx.get(commandsCtx)
      return () => commands.call(toggleHighlightCommand.key)
    }
  }
})

// Everything Editor.jsx passes to crepe.editor.use(...) in one array. The attr
// slice and the command MUST be here — the schema reads the attr context and the
// keymap/toolbar call the command; an uninjected one aborts Crepe init.
export const highlightFeatures = [
  highlightAttr,
  highlightSchema,
  highlightRemark,
  highlightInputRule,
  highlightKeymap,
  toggleHighlightCommand
]

// Apply (or toggle off) a highlight color on the current selection. Used by the
// toolbar color picker. Replaces any existing highlight color in the selection.
export function applyHighlightInView(view, color) {
  if (!view) return
  const type = view.state.schema.marks.highlight
  if (!type) return
  const { from, to, empty } = view.state.selection
  const mark = type.create({ color })
  let tr = view.state.tr
  if (empty) {
    // Toggle stored mark at the caret.
    const stored = view.state.storedMarks || []
    const has = stored.some((m) => m.type === type && m.attrs.color === color)
    tr = tr.setStoredMarks(has ? stored.filter((m) => m !== mark && !(m.type === type && m.attrs.color === color)) : [...stored, mark])
  } else {
    // If the whole range is already this color, remove it (toggle off); else replace.
    const allThis = view.state.doc.rangeHasMark(from, to, mark)
    tr = tr.removeMark(from, to, type)
    if (!allThis) tr = tr.addMark(from, to, mark)
  }
  view.dispatch(tr)
  view.focus()
}
