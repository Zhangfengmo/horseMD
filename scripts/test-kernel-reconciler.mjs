// TDD evidence + regression lock for editor-kernel-reconciler.js
// (source-kernel integration Plan 2, Task 4).
//
// Hand-built @milkdown/prose Schema + real Node/EditorState objects, same
// convention as scripts/test-editor-source-map.mjs / test-kernel-gateway.mjs
// / test-kernel-projection-map.mjs — no mocked PM shapes.
import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'
import {
  diffReplaceRange,
  reconcileProjection,
  widenReplaceForTables
} from '../src/renderer/src/components/editor-kernel-reconciler.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    code_block: { content: 'text*', group: 'block', code: true },
    text: { group: 'inline' }
  }
})
const text = (v) => (v ? schema.text(v) : null)
const paragraph = (v) => schema.node('paragraph', null, text(v))
const codeBlock = (v) => schema.node('code_block', null, text(v))
const doc = (...blocks) => schema.node('doc', null, blocks)

// The master invariant, run against every fixture below: applying the
// computed replace range to `oldDoc` (via a real EditorState transaction,
// not a hand-rolled splice) must reproduce `newDoc` exactly. This is the
// one property that actually matters — the from/to/insertFrom/insertTo
// numbers asserted per-case are a secondary sanity check on top of it.
function assertRoundtrip(oldDoc, newDoc, diff) {
  if (diff == null) {
    assert.ok(oldDoc.eq(newDoc), 'null diff must mean the docs are already content-equal')
    return
  }
  const state = EditorState.create({ schema, doc: oldDoc })
  const tr = state.tr.replace(diff.from, diff.to, newDoc.slice(diff.insertFrom, diff.insertTo))
  const applied = state.apply(tr)
  assert.ok(applied.doc.eq(newDoc), 'replaying the diff range must reproduce newDoc exactly')
}

console.log('--- kernel reconciler ---')

// Case 1: no difference -> null, and the master invariant's own null-branch
// (docs must already be content-equal) is exercised too.
{
  const oldDoc = doc(paragraph('甲'), codeBlock('x'), paragraph('乙'))
  const newDoc = doc(paragraph('甲'), codeBlock('x'), paragraph('乙'))
  const diff = diffReplaceRange(oldDoc, newDoc)
  assert.equal(diff, null)
  assertRoundtrip(oldDoc, newDoc, diff)
}

// Case 2: middle-block text change. doc(p('甲'), code_block('x'), p('乙')):
// p1 spans [0,3) content [1,2); code_block spans [3,6) content [4,5); p3
// spans [6,9) content [7,8). Growing p3's text to '乙丁' must confine the
// diff range to p3's span [6,9] — it must not touch p1 or the code_block.
{
  const oldDoc = doc(paragraph('甲'), codeBlock('x'), paragraph('乙'))
  const newDoc = doc(paragraph('甲'), codeBlock('x'), paragraph('乙丁'))
  const diff = diffReplaceRange(oldDoc, newDoc)
  assert.deepEqual(diff, { from: 8, to: 8, insertFrom: 8, insertTo: 9 })
  assert.ok(diff.from >= 6 && diff.to <= 9, 'diff range must stay confined to the third block [6,9]')
  assertRoundtrip(oldDoc, newDoc, diff)
}

// Case 3: first-block text change. Same base doc; p1's text grows to '甲子'.
// The diff must stay inside p1's span [0,3] and not touch the code_block
// [3,6) or p3 [6,9).
{
  const oldDoc = doc(paragraph('甲'), codeBlock('x'), paragraph('乙'))
  const newDoc = doc(paragraph('甲子'), codeBlock('x'), paragraph('乙'))
  const diff = diffReplaceRange(oldDoc, newDoc)
  assert.deepEqual(diff, { from: 2, to: 2, insertFrom: 2, insertTo: 3 })
  assert.ok(diff.from >= 0 && diff.to <= 3, 'diff range must stay confined to the first block [0,3]')
  assertRoundtrip(oldDoc, newDoc, diff)
}

// Case 4: last-block text change (shrink, not grow, for variety). p3's text
// shrinks from '乙丙' to '乙' (deleting the trailing char). p3 spans [6,10)
// in the OLD doc; the diff must stay inside it and not touch p1/code_block.
{
  const oldDoc = doc(paragraph('甲'), codeBlock('x'), paragraph('乙丙'))
  const newDoc = doc(paragraph('甲'), codeBlock('x'), paragraph('乙'))
  const diff = diffReplaceRange(oldDoc, newDoc)
  assert.deepEqual(diff, { from: 8, to: 9, insertFrom: 8, insertTo: 8 })
  assert.ok(diff.from >= 6 && diff.to <= 10, 'diff range must stay confined to the third (last) block')
  assertRoundtrip(oldDoc, newDoc, diff)
}

// Case 5: block insertion in the middle — a whole new paragraph('乙')
// inserted between p1('甲') and p2('丙').
{
  const oldDoc = doc(paragraph('甲'), paragraph('丙'))
  const newDoc = doc(paragraph('甲'), paragraph('乙'), paragraph('丙'))
  const diff = diffReplaceRange(oldDoc, newDoc)
  assert.deepEqual(diff, { from: 4, to: 4, insertFrom: 4, insertTo: 7 })
  assertRoundtrip(oldDoc, newDoc, diff)
}

// Case 6: block deletion in the middle — paragraph('乙') removed from
// between p1('甲') and p3('丙').
{
  const oldDoc = doc(paragraph('甲'), paragraph('乙'), paragraph('丙'))
  const newDoc = doc(paragraph('甲'), paragraph('丙'))
  const diff = diffReplaceRange(oldDoc, newDoc)
  assert.deepEqual(diff, { from: 4, to: 7, insertFrom: 4, insertTo: 4 })
  assertRoundtrip(oldDoc, newDoc, diff)
}

// Case 7: the overlap clamp, GROWTH direction — '甲甲甲' -> '甲甲甲甲'
// (classic repeated-content case: every character is simultaneously a
// candidate match for the front scan AND the back scan). Unclamped,
// findDiffStart/findDiffEnd on this fixture report start=4, endA=1, endB=2
// — start > endA, an inverted/overlapping region. Growth branch of the
// clamp: endB = start + (endB - endA) = 4 + (2-1) = 5; endA = start = 4.
{
  const oldDoc = doc(paragraph('甲甲甲'))
  const newDoc = doc(paragraph('甲甲甲甲'))
  const diff = diffReplaceRange(oldDoc, newDoc)
  assert.deepEqual(diff, { from: 4, to: 4, insertFrom: 4, insertTo: 5 })
  assert.ok(diff.to >= diff.from, 'clamp must never invert the old-doc replace range')
  assert.ok(diff.insertTo >= diff.insertFrom, 'clamp must never invert the new-doc insert range')
  assertRoundtrip(oldDoc, newDoc, diff)
}

// Case 8: the overlap clamp, SHRINK direction — '甲甲甲甲' -> '甲甲甲'.
// Unclamped: start=4, endA=2, endB=1 — here BOTH start>endA and
// start>endB hold, but oldDoc.content.size (6) is NOT smaller than
// newDoc.content.size (5), so the growth branch must NOT fire (it would
// produce an inverted insertFrom>insertTo range: endB would clamp to
// 1+(4-2)=3 < insertFrom=4). The shrink branch fires instead:
// endA = start + (endA - endB) = 4 + (2-1) = 5; endB = start = 4.
{
  const oldDoc = doc(paragraph('甲甲甲甲'))
  const newDoc = doc(paragraph('甲甲甲'))
  const diff = diffReplaceRange(oldDoc, newDoc)
  assert.deepEqual(diff, { from: 4, to: 5, insertFrom: 4, insertTo: 4 })
  assert.ok(diff.to >= diff.from, 'clamp must never invert the old-doc replace range')
  assert.ok(diff.insertTo >= diff.insertFrom, 'clamp must never invert the new-doc insert range')
  assertRoundtrip(oldDoc, newDoc, diff)
}

console.log('PASS diffReplaceRange (8 cases + master invariant)')

// --- reconcileProjection: dispatch wiring on a stub view -------------------

function makeStubView(initialDoc) {
  const view = {
    state: EditorState.create({ schema, doc: initialDoc }),
    dispatchCount: 0,
    lastTr: null,
    dispatch(tr) {
      view.dispatchCount += 1
      view.lastTr = tr
      view.state = view.state.apply(tr)
    }
  }
  return view
}

// Case 9: a real diff dispatches exactly once, ends with view.state.doc
// equal to newDoc, and the transaction carries the required meta.
{
  const oldDoc = doc(paragraph('甲'), codeBlock('x'), paragraph('乙'))
  const newDoc = doc(paragraph('甲'), codeBlock('x'), paragraph('乙丁'))
  const view = makeStubView(oldDoc)
  const result = reconcileProjection({ view, newDoc })
  assert.equal(result, true)
  assert.equal(view.dispatchCount, 1)
  assert.ok(view.state.doc.eq(newDoc))
  assert.equal(view.lastTr.getMeta('sourceProjection'), true)
  assert.equal(view.lastTr.getMeta('addToHistory'), false)
}

// Case 10: no diff -> reconcileProjection returns false and never calls
// dispatch (the stub's dispatchCount must stay at its initial 0).
{
  const oldDoc = doc(paragraph('甲'), codeBlock('x'), paragraph('乙'))
  const newDoc = doc(paragraph('甲'), codeBlock('x'), paragraph('乙'))
  const view = makeStubView(oldDoc)
  const result = reconcileProjection({ view, newDoc })
  assert.equal(result, false)
  assert.equal(view.dispatchCount, 0)
  assert.ok(view.state.doc.eq(oldDoc), 'view state must be untouched on a no-op')
}

// Case 11: a caller-supplied mapMeta rides along under the same
// 'sourceProjection' key instead of a bare `true`.
{
  const oldDoc = doc(paragraph('甲'), codeBlock('x'), paragraph('乙'))
  const newDoc = doc(paragraph('甲'), codeBlock('x'), paragraph('乙丁'))
  const view = makeStubView(oldDoc)
  const mapMeta = { revision: 3 }
  const result = reconcileProjection({ view, newDoc, mapMeta })
  assert.equal(result, true)
  assert.equal(view.lastTr.getMeta('sourceProjection'), mapMeta)
}

console.log('PASS reconcileProjection (3 cases)')

// --- widenReplaceForTables: table-interior diffs replace whole tables ------
//
// A row PERMUTATION (the drag-reorder) puts both minimal-diff ends INSIDE
// cell text; the deep-open slice then crosses row boundaries and
// ProseMirror's replace fitting can close rows with the wrong cell count
// (measured in the built app: bytes right, fixTables padded a third
// column). The widening makes the replace node-level. The master invariant
// here is structural: after reconcile the view equals newDoc — including
// per-row cell counts.
const tSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    table: { content: 'table_row+', group: 'block', tableRole: 'table' },
    table_row: { content: 'table_cell+', tableRole: 'row' },
    table_cell: { content: 'paragraph+', tableRole: 'cell' },
    text: { group: 'inline' }
  }
})
const tText = (v) => (v ? tSchema.text(v) : null)
const tPara = (v) => tSchema.node('paragraph', null, tText(v))
const tCell = (v) => tSchema.node('table_cell', null, tPara(v))
const tRow = (...cells) => tSchema.node('table_row', null, cells.map(tCell))
const tTable = (...rows) => tSchema.node('table', null, rows)
const tDoc = (...blocks) => tSchema.node('doc', null, blocks)
const tStubView = (initialDoc) => {
  const view = {
    state: EditorState.create({ schema: tSchema, doc: initialDoc }),
    dispatchCount: 0,
    lastTr: null,
    dispatch(tr) {
      view.dispatchCount += 1
      view.lastTr = tr
      view.state = view.state.apply(tr)
    }
  }
  return view
}
const rowCellCounts = (docNode) => {
  const counts = []
  docNode.descendants((node) => {
    if (node.type.name === 'table_row') counts.push(node.childCount)
    return true
  })
  return counts
}

// Case 12: body-row swap — both diff ends inside cell text. The widened
// replace must land the exact permuted table: every row keeps 2 cells.
{
  const oldDoc = tDoc(
    tPara('前'),
    tTable(tRow('甲', '乙'), tRow('丙', '丁'), tRow('戊', '己')),
    tPara('后')
  )
  const newDoc = tDoc(
    tPara('前'),
    tTable(tRow('甲', '乙'), tRow('戊', '己'), tRow('丙', '丁')),
    tPara('后')
  )
  const widened = widenReplaceForTables(oldDoc, newDoc, diffReplaceRange(oldDoc, newDoc))
  assert.equal(oldDoc.resolve(widened.from).depth, 0, 'widened start must sit at the table node boundary')
  assert.equal(oldDoc.resolve(widened.to).depth, 0, 'widened end must sit at the table node boundary')
  const view = tStubView(oldDoc)
  assert.equal(reconcileProjection({ view, newDoc }), true)
  assert.ok(view.state.doc.eq(newDoc), 'reconcile must land the permuted table exactly')
  assert.deepEqual(rowCellCounts(view.state.doc), [2, 2, 2], 'no row may gain or lose cells')
}

// Case 13: column swap (every row changes, first/last rows included).
{
  const oldDoc = tDoc(tTable(tRow('甲', '乙'), tRow('丙', '丁')), tPara('后'))
  const newDoc = tDoc(tTable(tRow('乙', '甲'), tRow('丁', '丙')), tPara('后'))
  const view = tStubView(oldDoc)
  assert.equal(reconcileProjection({ view, newDoc }), true)
  assert.ok(view.state.doc.eq(newDoc))
  assert.deepEqual(rowCellCounts(view.state.doc), [2, 2])
}

// Case 14: a diff OUTSIDE any table is returned untouched (the hot text
// path pays two resolves and nothing else).
{
  const oldDoc = tDoc(tPara('甲'), tTable(tRow('丙', '丁')), tPara('乙'))
  const newDoc = tDoc(tPara('甲'), tTable(tRow('丙', '丁')), tPara('乙丁'))
  const minimal = diffReplaceRange(oldDoc, newDoc)
  assert.deepEqual(widenReplaceForTables(oldDoc, newDoc, minimal), minimal)
}

// Case 14b: SAFE table shapes stay minimal — a whole-table replace remounts
// the table-block component, so widening must fire only on the pathological
// cross-row-inside-cell shape. (b1) a text edit inside one cell; (b2) a
// whole-row delete (boundary-aligned); (b3) a whole-row append.
{
  const b1old = tDoc(tTable(tRow('甲', '乙'), tRow('丙', '丁')))
  const b1new = tDoc(tTable(tRow('甲', '乙'), tRow('丙丙', '丁')))
  const m1 = diffReplaceRange(b1old, b1new)
  assert.deepEqual(widenReplaceForTables(b1old, b1new, m1), m1, 'in-cell edit must stay minimal')

  const b2old = tDoc(tTable(tRow('甲', '乙'), tRow('丙', '丁'), tRow('戊', '己')))
  const b2new = tDoc(tTable(tRow('甲', '乙'), tRow('丙', '丁')))
  const m2 = diffReplaceRange(b2old, b2new)
  assert.deepEqual(widenReplaceForTables(b2old, b2new, m2), m2, 'row delete must stay minimal')
  const v2 = tStubView(b2old)
  assert.equal(reconcileProjection({ view: v2, newDoc: b2new }), true)
  assert.ok(v2.state.doc.eq(b2new))

  const b3old = tDoc(tTable(tRow('甲', '乙'), tRow('丙', '丁')))
  const b3new = tDoc(tTable(tRow('甲', '乙'), tRow('丙', '丁'), tRow('x', 'y')))
  const m3 = diffReplaceRange(b3old, b3new)
  assert.deepEqual(widenReplaceForTables(b3old, b3new, m3), m3, 'row append must stay minimal')
}

// Case 15: table -> non-table structural change (the whole table deleted):
// asymmetric ends must not desynchronize — the widened diff still
// reproduces newDoc via the master invariant.
{
  const oldDoc = tDoc(tPara('甲'), tTable(tRow('丙', '丁')), tPara('乙'))
  const newDoc = tDoc(tPara('甲'), tPara('乙'))
  const view = tStubView(oldDoc)
  assert.equal(reconcileProjection({ view, newDoc }), true)
  assert.ok(view.state.doc.eq(newDoc), 'table deletion must still reconcile exactly')
}

console.log('PASS widenReplaceForTables (4 cases)')
console.log('PASS kernel reconciler')
