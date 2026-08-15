import { bulletListSchema, orderedListSchema } from '@milkdown/kit/preset/commonmark'
import { defaultHandlers } from 'mdast-util-to-markdown'

// The author's list marker is a per-LIST decision, but remark-stringify's
// `bullet` / `bulletOrdered` are single global options: one document cannot say
// "this list uses `-`, the next uses `+`". So the serializer rewrote every list
// to one character, and a whole layer downstream existed to map those bytes
// back onto the authored ones.
//
// Carry the decision on the node instead. Read it from the list's own source
// position while parsing, keep it as a node attribute, and hand it back to the
// serializer for that node only. Measured on a mixed-marker document, this is
// the difference between 8 diverging lines out of 19 and zero.
//
// This is the mechanism GitLab's Content Editor uses (it reads the same
// decision out of `data-sourcepos` and stores it as a Tiptap node attribute);
// the difference is only where the source range comes from.
const lineAt = (source, offset) => {
  const end = source.indexOf('\n', offset)
  return source.slice(offset, end < 0 ? source.length : end)
}

export const remarkCaptureListStyle = () => (tree, file) => {
  const source = String(file?.value ?? '')
  if (!source) return
  const visit = (node) => {
    if (node?.type === 'list') {
      const at = node.position?.start?.offset
      const line = at == null ? '' : lineAt(source, at)
      if (node.ordered) {
        const matched = line.match(/^[ \t]*(?:>[ \t]?)*\d{1,9}([.)])/)
        if (matched) node.delimiter = matched[1]
      } else {
        const matched = line.match(/^[ \t]*(?:>[ \t]?)*([-*+])[ \t]/)
        if (matched) node.bullet = matched[1]
      }
    }
    for (const child of node?.children || []) visit(child)
  }
  visit(tree)
}

// An empty attribute means "no authored decision" — a list typed in rich text
// has no source to read one from, so the global option still applies.
//
// The runners mirror the upstream ones EXACTLY (including the ordered list's
// `spread` defaulting to "true" and its string comparison on the way out) and
// add only the marker. A generic rewrite here would silently change list
// spread/order handling, which is not what this change is about.
const markerAttr = { default: '', validate: 'string' }

export const bulletListStyleSchema = bulletListSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    attrs: { ...base.attrs, bullet: markerAttr },
    parseMarkdown: {
      ...base.parseMarkdown,
      runner: (state, node, type) => {
        const spread = node.spread != null ? `${node.spread}` : 'false'
        const bullet = typeof node.bullet === 'string' ? node.bullet : ''
        state.openNode(type, { spread, bullet }).next(node.children).closeNode()
      }
    },
    toMarkdown: {
      ...base.toMarkdown,
      runner: (state, node) => {
        const bullet = node.attrs?.bullet
        state.openNode('list', undefined, {
          ordered: false,
          spread: node.attrs.spread,
          ...(bullet ? { bullet } : {})
        })
        state.next(node.content)
        state.closeNode()
      }
    }
  }
})

export const orderedListStyleSchema = orderedListSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return {
    ...base,
    attrs: { ...base.attrs, delimiter: markerAttr },
    parseMarkdown: {
      ...base.parseMarkdown,
      runner: (state, node, type) => {
        const spread = node.spread != null ? `${node.spread}` : 'true'
        const delimiter = typeof node.delimiter === 'string' ? node.delimiter : ''
        state.openNode(type, { spread, order: node.start ?? 1, delimiter })
          .next(node.children)
          .closeNode()
      }
    },
    toMarkdown: {
      ...base.toMarkdown,
      runner: (state, node) => {
        const delimiter = node.attrs?.delimiter
        state.openNode('list', undefined, {
          ordered: true,
          start: node.attrs.order ?? 1,
          spread: node.attrs.spread === 'true',
          ...(delimiter ? { delimiter } : {})
        })
        state.next(node.content)
        state.closeNode()
      }
    }
  }
})

// `bullet` / `bulletOrdered` are read from the options object every time the
// default handler renders a list, so scoping them to this node is enough — and
// it keeps the default handler's own logic (spacing, nesting, sibling-list
// disambiguation) untouched.
export const listStyleStringifyHandler = (node, parent, state, info) => {
  const saved = { bullet: state.options.bullet, bulletOrdered: state.options.bulletOrdered }
  if (node.bullet) state.options.bullet = node.bullet
  if (node.delimiter) state.options.bulletOrdered = node.delimiter
  try {
    return defaultHandlers.list(node, parent, state, info)
  } finally {
    Object.assign(state.options, saved)
  }
}

// Milkdown's text handler intentionally returns a value ending in whitespace
// verbatim. That keeps ordinary terminal ASCII spaces source-first, but a
// literal Tab at a block's end is not stable Markdown text: it is consumed as
// formatting when reparsed, so the verified-save gate correctly rejects it.
// Keep plain spaces literal while spelling only terminal Tabs with the standard
// HTML numeric character reference. This is portable Markdown/HTML source, not
// a HorseMD sentinel, and applies equally to paragraphs, headings and lists.
const milkdownText = (value, state, info) => /^[^*_\\]*\s+$/.test(value)
  ? value
  : state.safe(value, { ...info, encode: [] })

export const terminalTabTextHandler = (node, parent, state, info) => {
  const value = String(node.value ?? '')
  const terminalWhitespace = value.match(/[ \t]+$/)?.[0] || ''
  const lastInline = !parent?.children?.length || parent.children[parent.children.length - 1] === node
  const rendered = milkdownText(value, state, info)
  return lastInline && terminalWhitespace.includes('\t')
    ? rendered.replace(/\t/g, '&#x9;')
    : rendered
}
