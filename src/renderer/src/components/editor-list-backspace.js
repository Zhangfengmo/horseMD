import { keymap } from '@milkdown/prose/keymap'
import { liftListItem } from '@milkdown/prose/schema-list'

// Backspace on an EMPTY list item exits the list (Typora/Feishu behavior).
//
// Milkdown's preset binds Backspace to `liftFirstListItem`, which runs
// ProseMirror's generic `joinBackward`: because `list_item` accepts
// `paragraph block*`, the empty item is merged INTO the previous item as a
// second paragraph. Visually that reads as "indent instead of exiting the
// list", and structurally it creates the marker-less continuation line that
// the source-preservation layer cannot own unambiguously (the lock-up family
// documented in docs/rich-source-sync-architecture-review.md). Lifting the
// empty item resolves the user intent — "I am done with this list, give me a
// paragraph" — and removes that ambiguous intermediate state at its origin.
//
// Non-empty items, mid-item carets, and every other Backspace keep the
// preset behavior: this keymap only claims the empty-item case.
const backspaceExitsEmptyListItem = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parentOffset !== 0) return false
  const paragraph = $from.parent
  if (!paragraph.isTextblock || paragraph.content.size !== 0) return false
  const itemDepth = $from.depth - 1
  if (itemDepth < 1) return false
  const item = $from.node(itemDepth)
  if (item.type.name !== 'list_item' || item.childCount !== 1) return false
  // Only the LAST item of its list may exit: lifting a middle item splits the
  // list around an empty paragraph — a structure Markdown cannot express
  // (serialized as two lists plus a `<br />` placeholder), so the commit
  // would fail closed. Mid-list empty items keep the preset join behavior.
  const listDepth = itemDepth - 1
  if (listDepth < 0 || $from.index(listDepth) !== $from.node(listDepth).childCount - 1) return false
  return liftListItem(item.type)(state, dispatch)
}

export const listBackspaceKeymap = () =>
  keymap({ Backspace: backspaceExitsEmptyListItem })
