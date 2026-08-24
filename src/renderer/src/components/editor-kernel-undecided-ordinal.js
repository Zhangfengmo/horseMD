// Undecided-ordinal graying (docs/typing-policy-chokepoint-adr.md, 第二阶段
// item ②). When the user hand-types their own number (`4.`) into an ordered
// item, the typing policy keeps it as literal escaped bytes (`3. 4\.`) — the
// view honestly shows the AUTO ordinal ("3.") next to the typed number ("4.")
// until the next keystroke adjudicates it (Space/Enter's RENUMBER arm in
// lib/source-kernel/commands/marker-space.js adopts the number as the item's
// own marker). This plugin is the adjudicated appearance treatment for that
// undecided state: a PURE VIEW DECORATION that grays the AUTO ordinal — never
// the typed number, because the user's input is not the wrong part. Zero byte
// impact; read-only presentation only (no state, no filterTransaction, no
// handle* props), so typing, undo, IME and the adoption gestures are
// untouched.
//
// Predicate — the PM-state mirror of RENUMBER's raw-offset predicate
// (`escStart === item.contentStart && offset === item.end`, i.e. the escaped
// marker is the item's ENTIRE content; the escape backslash is invisible in
// the view, the text node holds `4.`):
//   * the node is a `list_item` whose PARENT is an `ordered_list`
//     (bullet items never show an auto ordinal — nothing to gray),
//   * it is not a task item (`attrs.checked == null`; RENUMBER refuses tasks),
//   * its ENTIRE content is one paragraph whose sole child is one unmarked
//     text node exactly matching /^\d{1,9}[.)]$/ — digits + delimiter,
//     nothing else. Any other content means the state is already decided.
// Caret position is deliberately NOT consulted: the state itself is the
// signal (the decoration appears/disappears with the bytes, not the focus).
//
// The decoration lands on the list_item's node-view OUTER dom — Crepe's
// `div.milkdown-list-item-block` (the Vue node view in
// @milkdown/components/list-item-block renders `li.list-item` INSIDE that
// div, and ProseMirror applies node-decoration attrs to the node view's
// `dom`), so the CSS hook in app.css targets
// `.milkdown-list-item-block.hm-undecided-ordinal … .label.ordered`.
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'

const UNDECIDED_ORDINAL_KEY = new PluginKey('hm-undecided-ordinal')

const UNDECIDED_TEXT_RE = /^\d{1,9}[.)]$/

const isUndecidedOrderedItem = (node, parent) => {
  if (node.type.name !== 'list_item') return false
  if (parent?.type?.name !== 'ordered_list') return false
  if (node.attrs?.checked != null) return false
  if (node.childCount !== 1) return false
  const para = node.firstChild
  if (!para || para.type.name !== 'paragraph') return false
  if (para.childCount !== 1) return false
  const text = para.firstChild
  if (!text?.isText || text.marks.length !== 0) return false
  return UNDECIDED_TEXT_RE.test(text.text)
}

const buildDecorations = (doc) => {
  const decorations = []
  doc.descendants((node, pos, parent) => {
    if (!node.isTextblock && isUndecidedOrderedItem(node, parent)) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, { class: 'hm-undecided-ordinal' })
      )
    }
    // Never descend into leaf-ish textblocks; lists themselves must be walked.
    return !node.isTextblock
  })
  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty
}

export function createUndecidedOrdinalPlugin() {
  return new Plugin({
    key: UNDECIDED_ORDINAL_KEY,
    state: {
      init: (_, state) => buildDecorations(state.doc),
      // Recompute only when the document changed — selection-only
      // transactions map the existing set (cheap and allocation-free).
      apply: (tr, set) => (tr.docChanged ? buildDecorations(tr.doc) : set.map(tr.mapping, tr.doc))
    },
    props: {
      decorations: (state) => UNDECIDED_ORDINAL_KEY.getState(state)
    }
  })
}
