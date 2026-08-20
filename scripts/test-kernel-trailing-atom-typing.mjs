// The trailing placeholder refused typing after an ATOM (wf-gateway,
// 2026-08-20) — regression lock for `extractTrailingAtomTyping` /
// `routeTrailingAtomTyping` (editor-kernel-gateway.js) and the
// 'trailing-atom-typing' case in editor-kernel-mode.js.
//
// THE DEFECT, measured in the built app on '甲一\n\n---' in kernel mode: a
// click on/near the document-ending hr leaves a NodeSelection ON the atom
// (`Selection.near` at the document end has no textblock to land in when the
// last real block is an atom — a list/fence/table always offers one, which is
// the whole list/atom asymmetry the handoff report §1 observed). The
// placeholder plugin-trailing appends on that very click never receives the
// caret, and typing then goes through prosemirror-view's own keypress
// fallback for non-text selections (`view.state.tr.insertText(text)`,
// input.ts editHandlers.keypress): ONE ReplaceStep replacing the atom's
// block-level range with a paragraph wrapping the typed text. That step
// resolves at doc depth, so `extractPlainTextSteps`' textblockProfile guard
// (correctly) answered null and the batch fell to `blocked`/INPUT_TYPE —
// every keystroke refused with a toast, zero bytes.
//
// THE FIX routes exactly that shape to the SAME bytes typing inside the
// placeholder has always committed (the virtual pair's own anchor + separator
// prefix, resolved through the same `virtualBlockAt` channel), vetoes the PM
// transaction (which deleted the atom), and reconciles the view from the
// committed source. This file locks:
//   1. the SYMMETRY: typing with the caret INSIDE the placeholder commits
//      identically for every preceding-block type (list / hr / image-block /
//      fence / table), LF and CRLF;
//   2. the GESTURE: for the two atoms, the NodeSelection-typed transaction
//      classifies `trailing-atom-typing` and routes to byte-identical
//      output; for list/fence/table, `Selection.near` provably lands in a
//      textblock, which is why those types never exhibited the defect;
//   3. the NARROWNESS: a mid-document atom, an atom not followed by the
//      placeholder, a non-plain slice, and a leading-whitespace insert all
//      stay refused exactly as before;
//   4. END TO END through createKernelMode: veto verdict, reconciled view
//      (atom intact + typed paragraph), caret after the text, undo restores
//      the pre-typing bytes exactly.
//
// `gateway` is imported as a NAMESPACE on purpose: on a pre-fix tree
// `routeTrailingAtomTyping` simply doesn't exist, and a named import would
// crash at module resolution — this file must fail on its ASSERTIONS there
// (classification kind, committed bytes), which is what proves it non-vacuous.
import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState, TextSelection, Selection, NodeSelection } from '@milkdown/prose/state'
import { buildProjectionMap } from '../src/renderer/src/components/editor-kernel-projection-map.js'
import * as gateway from '../src/renderer/src/components/editor-kernel-gateway.js'
import { createKernelMode } from '../src/renderer/src/components/editor-kernel-mode.js'
import { applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { KERNEL_CODES } from '../src/renderer/src/lib/source-kernel/index.js'

const { classifyTransactions, commitPlainText } = gateway

// Node shapes mirror the LIVE schema exactly where it matters here: `hr` is a
// content-less leaf (isAtom via isLeaf — preset-commonmark declares no
// `atom`), `image-block` declares `atom: true` (@milkdown/components
// image-block/index.js:110). The table nodes reuse the 4-level shape
// test-kernel-mode-headless.mjs probed from preset-gfm.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    bullet_list: { content: 'list_item+', group: 'block' },
    list_item: { content: 'paragraph block*', attrs: { checked: { default: null } } },
    code_block: { content: 'text*', group: 'block', code: true, attrs: { language: { default: '' } } },
    hr: { group: 'block' },
    'image-block': {
      group: 'block',
      atom: true,
      attrs: { src: { default: '' }, alt: { default: '' }, caption: { default: '' }, ratio: { default: 1 } }
    },
    table: { content: 'table_header_row table_row+', group: 'block', tableRole: 'table' },
    table_header_row: { content: '(table_header)*', tableRole: 'row' },
    table_row: { content: '(table_cell)*', tableRole: 'row' },
    table_header: {
      content: 'paragraph+',
      tableRole: 'header_cell',
      attrs: { alignment: { default: 'left' }, colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } }
    },
    table_cell: {
      content: 'paragraph+',
      tableRole: 'cell',
      attrs: { alignment: { default: 'left' }, colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } }
    }
  }
})
const p = (...c) => schema.node('paragraph', null, c)
const doc = (...c) => schema.node('doc', null, c)
const text = (s) => schema.text(s)
const li = (...c) => schema.node('list_item', { checked: null }, c)
const bl = (...c) => schema.node('bullet_list', null, c)
const cb = (language, s) => schema.node('code_block', { language }, s ? text(s) : [])
const hr = () => schema.node('hr')
const ib = () => schema.node('image-block', { src: 'x.png', alt: 'a', caption: 'a' })
const tbl = (rows) => schema.node('table', null, rows.map((cells, rowIndex) =>
  schema.node(rowIndex === 0 ? 'table_header_row' : 'table_row', null,
    cells.map(([s, alignment]) => schema.node(
      rowIndex === 0 ? 'table_header' : 'table_cell',
      { alignment },
      [s ? p(text(s)) : p()]
    )))))

// hr must be an atom through the LEAF route, exactly like the live schema.
assert.equal(schema.nodes.hr.isAtom, true, 'schema sanity: hr is an atom (leaf)')
assert.equal(schema.nodes['image-block'].isAtom, true, 'schema sanity: image-block is an atom')

// One case per preceding-block type. `markdown` deliberately has NO final
// newline for the two atoms (the exact bytes the report measured, prefix
// '\n\n') and the conventional final newline for the rest (prefix '\n') — the
// separator derivation (`trailingInsertPrefix`) is part of what's locked.
const eol = (s, ending) => s.replace(/\n/g, ending)
const CASES = [
  {
    name: 'list',
    atom: false,
    markdown: (e) => eol('- 甲\n', e),
    pmDoc: () => doc(bl(li(p(text('甲')))), p()),
    prefix: (e) => e
  },
  {
    name: 'hr',
    atom: true,
    markdown: (e) => eol('甲一\n\n---', e),
    pmDoc: () => doc(p(text('甲一')), hr(), p()),
    prefix: (e) => e + e
  },
  {
    name: 'image-block',
    atom: true,
    markdown: (e) => eol('甲\n\n![a](x.png)', e),
    pmDoc: () => doc(p(text('甲')), ib(), p()),
    prefix: (e) => e + e
  },
  {
    name: 'fence',
    atom: false,
    markdown: (e) => eol('```js\nab\n```\n', e),
    pmDoc: (e) => doc(cb('js', eol('ab', e)), p()),
    prefix: (e) => e
  },
  {
    name: 'table',
    atom: false,
    markdown: (e) => eol('| a | b |\n| :-- | --: |\n| c | d |\n', e),
    pmDoc: () => doc(tbl([[['a', 'left'], ['b', 'right']], [['c', 'left'], ['d', 'right']]]), p()),
    prefix: (e) => e
  }
]

const placeholderContentPos = (pmDoc) => pmDoc.content.size - pmDoc.lastChild.nodeSize + 1

console.log('--- kernel trailing-atom typing ---')

for (const ending of ['\n', '\r\n']) {
  const label = ending === '\n' ? 'LF' : 'CRLF'
  for (const c of CASES) {
    const markdown = c.markdown(ending)
    const pmDoc = c.pmDoc(ending)
    const expectedBytes = markdown + c.prefix(ending) + 'X'

    // ------------------------------------------------------------------
    // 1) SYMMETRY: caret INSIDE the placeholder -> plain-text -> the pair's
    //    anchor + prefix, identical machinery for every preceding type.
    // ------------------------------------------------------------------
    const map = buildProjectionMap(markdown, pmDoc)
    assert.ok(map, `[${label} ${c.name}] map must build`)
    const pos = placeholderContentPos(pmDoc)
    assert.ok(map.virtualBlockAt(pos), `[${label} ${c.name}] trailing pair must be virtual+mapped`)
    {
      const base = EditorState.create({ schema, doc: pmDoc })
      const state = base.apply(base.tr.setSelection(TextSelection.create(pmDoc, pos)))
      const tr = state.tr.insertText('X')
      const cls = classifyTransactions([tr], state)
      assert.equal(cls.kind, 'plain-text', `[${label} ${c.name}] placeholder typing is plain-text`)
      const kernel = { doc: { text: markdown, revision: 0 } }
      const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
      assert.equal(committed.ok, true, `[${label} ${c.name}] placeholder typing commits`)
      assert.equal(committed.applied.doc.text, expectedBytes,
        `[${label} ${c.name}] placeholder bytes`)
    }

    // ------------------------------------------------------------------
    // 2) THE GESTURE: what a click at/below the document end leaves, typed.
    // ------------------------------------------------------------------
    const bare = doc(...pmDoc.content.content.slice(0, pmDoc.childCount - 1))
    const clickSel = Selection.near(bare.resolve(bare.content.size), -1)
    if (c.atom) {
      // The click's selection is a NodeSelection ON the atom — the state the
      // handoff report measured. (This is WHY only atom-ending documents
      // exhibited the refusal.)
      assert.ok(clickSel instanceof NodeSelection,
        `[${label} ${c.name}] click at doc end node-selects the atom`)
      let state = EditorState.create({ schema, doc: bare })
      state = state.apply(state.tr.setSelection(clickSel))
      // plugin-trailing's own append rides the click batch.
      state = state.apply(state.tr.insert(state.doc.content.size, schema.nodes.paragraph.create()))
      assert.ok(state.selection instanceof NodeSelection,
        `[${label} ${c.name}] the append does not move the selection off the atom`)
      const gestureMap = buildProjectionMap(markdown, state.doc)
      assert.ok(gestureMap, `[${label} ${c.name}] gesture map must build`)
      // prosemirror-view's keypress fallback for a non-text selection.
      const tr = state.tr.insertText('X')
      const cls = classifyTransactions([tr], state)
      assert.equal(cls.kind, 'trailing-atom-typing',
        `[${label} ${c.name}] typing over the node-selected trailing atom must classify trailing-atom-typing (got ${cls.kind}${cls.blockedCode ? ' ' + cls.blockedCode : ''})`)
      const routed = gateway.routeTrailingAtomTyping({
        kernel: { doc: { text: markdown, revision: 0 } },
        map: gestureMap,
        transactions: [tr],
        oldState: state
      })
      assert.equal(routed?.ok, true, `[${label} ${c.name}] route must accept the gesture`)
      const applied = applySourceTransaction({ text: markdown, revision: 0 }, routed.transaction)
      assert.equal(applied.ok, true)
      assert.equal(applied.doc.text, expectedBytes,
        `[${label} ${c.name}] the gesture commits BYTE-IDENTICAL output to placeholder typing`)
      // Caret raw offset = end of the typed text (the document's new end).
      assert.equal(applied.selection.anchor, expectedBytes.length,
        `[${label} ${c.name}] caret lands after the typed text`)

      // Leading whitespace keeps the placeholder path's own refusal (a dead
      // byte on the brand-new line) — same code, same posture.
      const wsTr = state.tr.insertText(' ')
      const wsRouted = gateway.routeTrailingAtomTyping({
        kernel: { doc: { text: markdown, revision: 0 } },
        map: gestureMap,
        transactions: [wsTr],
        oldState: state
      })
      assert.equal(wsRouted?.ok, false)
      assert.equal(wsRouted?.code, KERNEL_CODES.UNSUPPORTED,
        `[${label} ${c.name}] leading whitespace into the placeholder stays refused`)
    } else {
      // The non-atom types never reach the refused state at all: the click
      // finds a real textblock to land in.
      assert.ok(clickSel instanceof TextSelection,
        `[${label} ${c.name}] click at doc end lands in a textblock (${clickSel.constructor.name})`)
    }
  }
}

// ---------------------------------------------------------------------------
// 3) NARROWNESS — every neighbouring shape stays refused exactly as before.
// ---------------------------------------------------------------------------
{
  // A node-selected atom in the MIDDLE of a document: no placeholder owns
  // that position's bytes — still blocked.
  const mid = doc(p(text('甲')), hr(), p(text('尾')))
  let state = EditorState.create({ schema, doc: mid })
  state = state.apply(state.tr.setSelection(NodeSelection.create(mid, 3)))
  const cls = classifyTransactions([state.tr.insertText('X')], state)
  assert.equal(cls.kind, 'blocked', 'mid-document atom typing stays blocked')
  assert.equal(cls.blockedCode, KERNEL_CODES.INPUT_TYPE)
}
{
  // The trailing atom WITHOUT the placeholder after it (the doc's own last
  // child): there is no virtual pair to own the bytes — still blocked.
  const bare = doc(p(text('甲一')), hr())
  let state = EditorState.create({ schema, doc: bare })
  state = state.apply(state.tr.setSelection(NodeSelection.create(bare, 4)))
  const cls = classifyTransactions([state.tr.insertText('X')], state)
  assert.equal(cls.kind, 'blocked', 'atom typing without the trailing placeholder stays blocked')
}
{
  // Atom followed by a NON-empty final paragraph: that paragraph is real
  // content, not the placeholder — still blocked.
  const filled = doc(p(text('甲')), hr(), p(text('x')))
  let state = EditorState.create({ schema, doc: filled })
  state = state.apply(state.tr.setSelection(NodeSelection.create(filled, 3)))
  const cls = classifyTransactions([state.tr.insertText('X')], state)
  assert.equal(cls.kind, 'blocked', 'atom before a non-empty last paragraph stays blocked')
}
{
  // A node-selected TABLE (selectable, but not an atom) typed over: replacing
  // a table by typing is not this route's claim — still blocked.
  const tdoc = doc(p(text('甲')), tbl([[['a', 'left']], [['b', 'left']]]), p())
  let state = EditorState.create({ schema, doc: tdoc })
  state = state.apply(state.tr.setSelection(NodeSelection.create(tdoc, 3)))
  const cls = classifyTransactions([state.tr.insertText('X')], state)
  assert.equal(cls.kind, 'blocked', 'a node-selected non-atom block stays blocked')
}
{
  // Route re-derivation refuses a map whose pair after the atom is NOT the
  // vouched trailing placeholder (virtualBlockAt null) — fail-closed UNMAPPED.
  const markdown = '甲一\n\n---'
  const pmDoc = doc(p(text('甲一')), hr(), p())
  let state = EditorState.create({ schema, doc: pmDoc })
  state = state.apply(state.tr.setSelection(NodeSelection.create(pmDoc, 4)))
  const tr = state.tr.insertText('X')
  const noVirtual = { virtualBlockAt: () => null }
  const routed = gateway.routeTrailingAtomTyping({
    kernel: { doc: { text: markdown, revision: 0 } },
    map: noVirtual,
    transactions: [tr],
    oldState: state
  })
  assert.equal(routed?.ok, false)
  assert.equal(routed?.code, KERNEL_CODES.UNMAPPED, 'a map without the virtual pair refuses UNMAPPED')
}

// ---------------------------------------------------------------------------
// 4) END TO END through createKernelMode: veto + reconcile + caret + undo.
//    Same stub-parse harness protocol as scripts/test-kernel-mode-headless.mjs.
// ---------------------------------------------------------------------------
{
  const FIXTURES = {
    '甲一\n\n---': () => doc(p(text('甲一')), hr()),
    '甲一\n\n---\n\nX': () => doc(p(text('甲一')), hr(), p(text('X')))
  }
  const stubParse = (markdown) => {
    const build = FIXTURES[markdown]
    if (!build) throw new Error('no fixture for ' + JSON.stringify(markdown))
    return build()
  }
  let viewState = EditorState.create({ schema, doc: doc(p(text('甲一')), hr(), p()) })
  const view = {
    get state() { return viewState },
    dispatch(tr) { viewState = viewState.apply(tr) },
    updateState(next) { viewState = next },
    composing: false,
    focus() {}
  }
  const notifications = []
  const changes = []
  const controller = createKernelMode({
    initialContent: '甲一\n\n---',
    getView: () => view,
    parse: stubParse,
    notify: (message) => notifications.push(message),
    getT: (key) => key,
    onChange: (markdown, flag) => changes.push([markdown, flag])
  })
  assert.equal(controller.attachAfterCreate(), true, 'hr-ending doc attaches live')

  // The gesture: node-select the hr, then type (prosemirror-view's own
  // fallback transaction), through the real dispatch-veto protocol.
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 4)))
  const oldState = view.state
  const tr = oldState.tr.insertText('X')
  const applied = oldState.apply(tr)
  const verdict = controller.handleTransactions([tr], oldState, applied)
  assert.deepEqual(verdict, { veto: true },
    'the PM transaction (which deleted the atom) is always vetoed')
  // Veto protocol: updateState is NOT called with the atom-deleting state;
  // the controller reconciled the view from the committed bytes instead.
  assert.equal(controller.kernel.doc.text, '甲一\n\n---\n\nX', 'kernel bytes: placeholder typing bytes')
  assert.ok(view.state.doc.eq(doc(p(text('甲一')), hr(), p(text('X')))),
    'view reconciled: atom INTACT + typed paragraph below')
  assert.equal(view.state.selection.head, 7, 'caret sits right after the typed character')
  assert.deepEqual(changes.at(-1), ['甲一\n\n---\n\nX', false], 'the commit publishes')
  assert.equal(notifications.length, 0, 'no refusal toast for the successful commit')

  // Undo restores the pre-typing bytes exactly.
  const undone = controller.historyHandlers.undo(view.state, view.dispatch, view)
  assert.equal(undone, true)
  assert.equal(controller.kernel.doc.text, '甲一\n\n---', 'undo restores the bytes exactly')
}

console.log('PASS kernel trailing-atom typing: the click-on-atom gesture commits the placeholder\'s own bytes for hr and image-block (LF+CRLF), placeholder typing stays symmetric across list/hr/image-block/fence/table, and every neighbouring shape keeps its refusal')
