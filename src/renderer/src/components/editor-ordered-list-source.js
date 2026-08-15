import { Plugin, PluginKey } from '@milkdown/prose/state'
import { canJoin } from '@milkdown/prose/transform'

const sourceFirstOrderedListKey = new PluginKey('hm-source-first-ordered-list')

const isSourceFirstOrderedList = (node) =>
  node?.type?.name === 'ordered_list' && node.attrs?.delimiter !== ')'

const isEmptyListItem = (node) =>
  node?.type?.name === 'list_item' &&
  node.childCount === 1 &&
  node.firstChild?.type?.name === 'paragraph' &&
  node.firstChild.content.size === 0

const nonEmptyListItems = (list) => {
  const items = []
  list?.forEach((item) => {
    if (item.type?.name === 'list_item' && !isEmptyListItem(item)) items.push(item)
  })
  return items
}

const sameListItemContent = (left, right) =>
  left?.type === right?.type && left.content.eq(right.content)

// A paragraph already present in the document can be authored raw HTML and is
// source-owned. Only collapse a newly split list when the old document proves
// the two current list fragments used to be one list, with the exited empty
// list item as the sole removable structure.
const splitFromSingleOldList = (oldDoc, left, right) => {
  const expectedItems = [...nonEmptyListItems(left), ...nonEmptyListItems(right)]
  if (!expectedItems.length) return false

  let matches = 0
  oldDoc.forEach((node) => {
    if (!isSourceFirstOrderedList(node)) return
    const oldItems = nonEmptyListItems(node)
    if (
      oldItems.length === expectedItems.length &&
      oldItems.every((item, index) => sameListItemContent(item, expectedItems[index]))
    ) matches += 1
  })
  return matches === 1
}

const nextMerge = (doc, oldDoc) => {
  let left = null
  let emptyParagraphs = []
  let merge = null
  doc.forEach((node, offset) => {
    if (merge) return
    if (isSourceFirstOrderedList(node)) {
      const right = { node, offset }
      if (left && !emptyParagraphs.length) {
        merge = { left, right, emptyParagraphs }
        return
      }
      if (
        left &&
        emptyParagraphs.length &&
        splitFromSingleOldList(oldDoc, left.node, right.node)
      ) {
        merge = { left, right, emptyParagraphs }
        return
      }
      left = right
      emptyParagraphs = []
      return
    }
    if (left && node.type?.name === 'paragraph' && node.content.size === 0) {
      emptyParagraphs.push({ node, offset })
      return
    }
    left = null
    emptyParagraphs = []
  })
  return merge
}

// CommonMark has no structural boundary between two directly adjacent ordered
// lists that both use `.`. Source is HorseMD's durable interchange format, so
// a rich-only second tree must become a continuation before serialization
// rather than leaking a synthetic `1)` delimiter into the Markdown file.
export const createSourceFirstOrderedListPlugin = () => new Plugin({
  key: sourceFirstOrderedListKey,
  appendTransaction(transactions, oldState, newState) {
    if (!transactions.some((transaction) => transaction.docChanged)) return null

    const transaction = newState.tr
    for (;;) {
      const merge = nextMerge(transaction.doc, oldState.doc)
      if (!merge) break

      const boundary = merge.left.offset + merge.left.node.nodeSize
      if (merge.emptyParagraphs.length) transaction.delete(boundary, merge.right.offset)
      // Newly typed lists have no authored delimiter attribute. Give them the
      // preceding list's `.` spelling before joining; existing `)` source is
      // excluded above and remains an explicit, portable separator.
      transaction.setNodeMarkup(boundary, merge.left.node.type, merge.left.node.attrs)
      if (!canJoin(transaction.doc, boundary)) return null
      transaction.join(boundary)
    }

    return transaction.docChanged ? transaction : null
  }
})
