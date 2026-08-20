import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state'

const taskListInputKey = new PluginKey('hm-task-list-input')
const createdEmptyTaskMeta = 'created-empty-task'

function findParagraphDepth($from) {
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth)?.type.name === 'paragraph') return depth
  }
  return -1
}

function createTaskListFromParagraph(state, paragraphDepth, checked) {
  const { schema } = state
  const bulletList = schema.nodes.bullet_list
  const listItem = schema.nodes.list_item
  const paragraph = schema.nodes.paragraph
  if (!bulletList || !listItem || !paragraph) return null

  const emptyParagraph = paragraph.create()
  const taskItem = listItem.create({ checked }, emptyParagraph)
  return bulletList.create(null, taskItem)
}

function createTaskListTransaction(state, paragraphDepth, checked) {
  const { $from } = state.selection
  const taskList = createTaskListFromParagraph(state, paragraphDepth, checked)
  if (!taskList) return null

  const from = $from.before(paragraphDepth)
  const to = $from.after(paragraphDepth)
  let tr = state.tr.replaceWith(from, to, taskList)
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(from + 3, tr.doc.content.size))))
  // Do not immediately demote the task we just created: the next character is
  // normally its label.  A later deletion (or a source/save boundary) owns the
  // source-first demotion if that label remains empty.
  return tr.setMeta(taskListInputKey, createdEmptyTaskMeta).scrollIntoView()
}

function convertParagraphToTaskList(view, paragraphDepth, checked) {
  const tr = createTaskListTransaction(view.state, paragraphDepth, checked)
  if (!tr) return false
  view.dispatch(tr)
  return true
}

function taskMarkerMatch(text) {
  return text.match(/^\s*[-*+]\s+\[( |x|X)\]\s*$/)
}

function listTaskMarkerMatch(text) {
  return text.match(/^\[([ xX])\]\s*$/)
}

function listItemAtSelection(state) {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const item = $from.node(depth)
    if (item?.type?.name === 'list_item') return { item, depth, pos: $from.before(depth) }
  }
  return null
}

function createTaskListItemTransaction(state, item, itemPos, checked) {
  if (item.attrs?.checked !== null && item.attrs?.checked !== undefined) return null
  const paragraph = state.schema.nodes.paragraph
  if (!paragraph || item.firstChild?.type?.name !== 'paragraph') return null

  // Milkdown has already consumed `* ` / `- ` as an ordinary bullet-list
  // input rule by the time the user finishes `[ ] `. Replace only this item's
  // marker paragraph, leaving the surrounding list and any nested children
  // untouched.
  const taskItem = item.type.create(
    { ...item.attrs, checked },
    item.content.replaceChild(0, paragraph.create()),
    item.marks
  )
  let tr = state.tr.replaceWith(itemPos, itemPos + item.nodeSize, taskItem)
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(itemPos + 2, tr.doc.content.size))))
  return tr.setMeta(taskListInputKey, createdEmptyTaskMeta).scrollIntoView()
}

function taskListItemFromMarker(state, text) {
  const match = listTaskMarkerMatch(text)
  if (!match) return null
  const target = listItemAtSelection(state)
  if (!target) return null
  return createTaskListItemTransaction(state, target.item, target.pos, match[1].toLowerCase() === 'x')
}

function convertListItemToTaskList(view, text) {
  const tr = taskListItemFromMarker(view.state, text)
  if (!tr) return false
  view.dispatch(tr)
  return true
}

const emptyTaskMarker = (node) => {
  if (node?.type?.name !== 'list_item') return null
  if (node.attrs?.checked !== true && node.attrs?.checked !== false) return null
  if (node.childCount !== 1) return null

  const paragraph = node.firstChild
  if (paragraph?.type?.name !== 'paragraph' || Object.keys(paragraph.attrs || {}).length) return null

  // An actual ASCII space or Tab is authored task-label content.  Only a
  // structurally empty paragraph is empty.  The lone NBSP is included solely
  // to migrate files written by the previous HorseMD release; it is no longer
  // emitted by this path.
  if (paragraph.childCount === 0) return node.attrs.checked ? '[x]' : '[ ]'
  if (
    paragraph.childCount === 1 &&
    paragraph.firstChild?.type?.name === 'text' &&
    !paragraph.firstChild.marks?.length &&
    paragraph.firstChild.text === '\u00A0'
  ) {
    return node.attrs.checked ? '[x]' : '[ ]'
  }
  return null
}

const normalListItem = (state, item, marker) => {
  const paragraph = state.schema.nodes.paragraph
  if (!paragraph) return null
  return item.type.create(
    { ...item.attrs, checked: null },
    paragraph.create(null, state.schema.text(marker))
  )
}

const emptyTaskAtSelection = (state) => {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const item = $from.node(depth)
    const marker = emptyTaskMarker(item)
    if (!marker) continue
    return { item, marker, pos: $from.before(depth) }
  }
  return null
}

const demoteEmptyTaskAtSelection = (state) => {
  const target = emptyTaskAtSelection(state)
  if (!target) return null
  const replacement = normalListItem(state, target.item, target.marker)
  if (!replacement) return null

  let tr = state.tr.replaceWith(target.pos, target.pos + target.item.nodeSize, replacement)
  // The text begins directly inside the replacement paragraph.  Put the
  // caret after the visible `[ ]` / `[x]` text so continued typing has the
  // same ordinary-list behavior as the durable source spelling.
  const caret = Math.min(target.pos + 2 + target.marker.length, tr.doc.content.size)
  tr = tr.setSelection(TextSelection.create(tr.doc, caret))
  return tr.scrollIntoView()
}

const emptyTasksInDocument = (state) => {
  const tasks = []
  state.doc.descendants((node, pos) => {
    const marker = emptyTaskMarker(node)
    if (marker) tasks.push({ item: node, marker, pos })
  })
  return tasks
}

// Source mode and save are durability boundaries.  A just-created task can be
// visually empty while the user is about to type its label, but GFM has no
// checkbox syntax for that state.  At the boundary replace it in the live
// document with the exact ordinary Markdown text which GFM and other editors
// will parse identically.  This writes neither entities nor private sentinels.
export function demoteEmptyTaskItemsInView(view) {
  const state = view?.state
  if (!state) return false
  const tasks = emptyTasksInDocument(state)
  if (!tasks.length) return false

  let tr = state.tr
  for (const task of [...tasks].reverse()) {
    const replacement = normalListItem(state, task.item, task.marker)
    if (!replacement) continue
    tr = tr.replaceWith(task.pos, task.pos + task.item.nodeSize, replacement)
  }
  if (!tr.docChanged) return false
  view.dispatch(tr)
  return true
}

// An empty task item is a rich-only transient with no GFM spelling, so every
// durability boundary demotes it.  A caller that is NOT such a boundary (the
// unforced background dirty-reconcile, which publishes nothing to the user and
// is superseded by the forced flush every real boundary performs) uses this to
// recognize the state and step aside instead of rewriting the live document.
export function viewHasEmptyTaskItems(view) {
  const state = view?.state
  if (!state) return false
  return emptyTasksInDocument(state).length > 0
}

export function createTaskListInputPlugin({ kernelMode = false } = {}) {
  return new Plugin({
    key: taskListInputKey,
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged) || !newState.selection.empty) return null

      const { $from } = newState.selection
      const paragraphDepth = findParagraphDepth($from)
      if (paragraphDepth < 0) return null

      const paragraphNode = $from.node(paragraphDepth)
      if ($from.parentOffset < paragraphNode.content.size) return null

      const match = taskMarkerMatch(paragraphNode.textContent || '')
      if (match) {
        return createTaskListTransaction(newState, paragraphDepth, match[1].toLowerCase() === 'x')
      }

      // SOURCE-KERNEL MODE NEVER DEMOTES (2026-08-20). This demotion is a
      // LEGACY-only contract: there, an empty task really is a rich-only
      // transient with no GFM spelling, so boundaries rewrite it to literal
      // "[ ]" text. In kernel mode that premise is false — the kernel's
      // `/task` writes `- [ ] ` + U+00A0, a REAL `checked: false` item whose
      // seed U+00A0 is exactly the shape `emptyTaskMarker`'s migration clause
      // matches — and this appendTransaction rode a projection-classified
      // reconcile batch straight past the gateway, rewriting the just-created
      // checkbox into literal "[ ]" while the SOURCE still held a real task
      // (measured in the built app: bytes `- [ ] ` + U+00A0 on disk, view
      // showing "[ ]"). Bytes are the kernel's only truth; a view-side
      // "demotion" of a representable item is corruption, not migration.
      if (kernelMode) return null

      // The transaction that creates a task carries an explicit meta marker;
      // leave it editable until the user types, deletes, or crosses a source
      // boundary.  Every later empty-task deletion is demoted immediately.
      if (transactions.some((tr) => tr.getMeta(taskListInputKey) === createdEmptyTaskMeta)) return null
      return demoteEmptyTaskAtSelection(newState)
    },
    props: {
      handleTextInput(view, _from, _to, text) {
        if (view.composing || !text.endsWith(' ')) return false
        const { state } = view
        const { selection } = state
        if (!selection.empty) return false

        const { $from } = selection
        const paragraphDepth = findParagraphDepth($from)
        if (paragraphDepth < 0) return false

        const paragraphNode = $from.node(paragraphDepth)
        if ($from.parentOffset < paragraphNode.content.size) return false

        const beforeCursor = paragraphNode.textBetween(0, $from.parentOffset, '\n', '\n')
        const match = taskMarkerMatch(beforeCursor + text)
        if (match) {
          return convertParagraphToTaskList(view, paragraphDepth, match[1].toLowerCase() === 'x')
        }
        if (convertListItemToTaskList(view, beforeCursor + text)) return true
        return false
      },
      handleKeyDown(view, event) {
        if (event.key !== 'Enter' || event.isComposing) return false
        const { state } = view
        const { selection } = state
        if (!selection.empty) return false

        const { $from } = selection
        const paragraphDepth = findParagraphDepth($from)
        if (paragraphDepth < 0) return false

        const paragraphNode = $from.node(paragraphDepth)
        const text = paragraphNode.textContent || ''
        const match = taskMarkerMatch(text)
        if ($from.parentOffset < paragraphNode.content.size) return false
        if (match) return convertParagraphToTaskList(view, paragraphDepth, match[1].toLowerCase() === 'x')
        return convertListItemToTaskList(view, text)
      }
    }
  })
}
