// TDD evidence + regression lock for the MARKED-TEXT INSERT classification
// (D6, 2026-08-27).
//
// THE DEFECT THIS FILE EXISTS FOR. Typing inside — or at the trailing edge of —
// a bold/italic/strike/link run was silently swallowed in kernel mode. Measured
// on the real app before any fix (scripts/probe-trailing-mark-append.mjs and
// scripts/probe-mark-run-interior.mjs):
//
//   SWALLOWED  middle of **bold**       unsupported-input-type
//   SWALLOWED  end of **bold** / *em* / ~~del~~ / [link](u)
//   LANDS      start of a run, inline code, ==highlight==, plain text
//
// The reported shape ("append after a bolded word") was the narrow half. The
// real rule is that ProseMirror stamps the typed character with the run's mark
// whenever the mark is INCLUSIVE (strong/emphasis/strike_through/link are;
// this repo sets inlineCode and highlight to inclusive:false, which is the only
// reason those two landed), and gateway `plainSliceText` refuses ANY marked
// insert slice. So "a bolded word cannot be edited" — fail-closed, no wrong
// byte, but a dead keyboard on an everyday gesture.
//
// WHAT THE FIX MAY NOT DO. It may not relax `plainSliceText`: the plain path's
// contract is that an UNMARKED char typed at a run's boundary lands OUTSIDE the
// delimiters ('a **bold**' + X -> 'a **bold**X'), and that contract is what the
// marker-gap-neutral resolver `rawNeutralInsert` exists to keep. The marked
// insert is the MIRROR case and needs the mirror resolver — `visibleToRaw`, the
// gap-BEFORE table, which character-map.js's own ADR describes as landing a
// char INSIDE the closing marker. So this is a second, separately-proven
// classification, not a widened first one.
import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { EditorState } from '@milkdown/prose/state'

import { classifyTransactions, commitMarkedTextInsert, commitPlainText } from '../src/renderer/src/components/editor-kernel-gateway.js'
import { buildProjectionMap } from '../src/renderer/src/components/editor-kernel-projection-map.js'
import { KERNEL_CODES, createMarkdownDocument } from '../src/renderer/src/lib/source-kernel/index.js'

// Same hand-built-schema convention as scripts/test-kernel-gateway.mjs: real
// @milkdown/prose Schema, real EditorState, real transactions.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: { content: 'inline*', group: 'block', attrs: { id: { default: '' }, level: { default: 1 } } },
    text: { group: 'inline' }
  },
  marks: {
    strong: {},
    emphasis: {},
    strike_through: {},
    inlineCode: {},
    highlight: { attrs: { color: { default: 'yellow' } } },
    link: { attrs: { href: { default: '' } } }
  }
})

const doc = (...c) => schema.node('doc', null, c)
const p = (...c) => schema.node('paragraph', null, c)
const text = (s) => schema.text(s)
const marked = (s, markName, attrs = null) => schema.text(s, [schema.mark(markName, attrs)])

console.log('--- kernel marked-text insert ---')

// 'a **bold** b\n' raw indices: a=0 sp=1 *=2 *=3 b=4 o=5 l=6 d=7 *=8 *=9
// sp=10 b=11 \n=12. PM: p@0, contentPos 1, children 'a '(1..3),
// 'bold'[strong](3..7), ' b'(7..9).
const boldFixture = () => {
  const md = 'a **bold** b\n'
  const state = EditorState.create({ schema, doc: doc(p(text('a '), marked('bold', 'strong'), text(' b'))) })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'marked paragraph must map')
  return { md, state, map }
}

// The transaction ProseMirror really produces when a character is typed with an
// inherited mark: a zero-width ReplaceStep whose slice is one MARKED text node.
const typeMarked = (state, pos, char, markName, attrs = null) =>
  state.tr.replaceWith(pos, pos, marked(char, markName, attrs))

// The commit re-derives the shape from the transaction itself, so the test
// hands it the REAL transaction — never a bare position — exactly as the
// mode-side caller does.
const commitOf = (md, map, state, tr) => {
  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitMarkedTextInsert({ kernel, map, transactions: [tr], oldState: state })
  return { kernel, committed }
}

// ---- 1. The reported gesture: type at the run's TRAILING edge ----
// PM puts the character inside the strong node, so the bytes must put it
// inside the delimiters. Landing it outside ('a **bold**X b') would show an
// UNBOLDED X where the view shows a bolded one — the projection would lie.
{
  const { md, state, map } = boldFixture()
  const tr = typeMarked(state, 7, 'X', 'strong')
  const result = classifyTransactions([tr], state)
  assert.equal(result.kind, 'marked-text-insert', 'trailing-edge marked insert must classify')
  assert.equal(result.pmFrom, 7)
  assert.equal(result.text, 'X')

  const { committed } = commitOf(md, map, state, tr)
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text, 'a **boldX** b\n')
}

// ---- 2. The larger half: type in the run's INTERIOR ----
{
  const { md, state, map } = boldFixture()
  const tr = typeMarked(state, 5, 'X', 'strong') // between 'o' and 'l'
  const result = classifyTransactions([tr], state)
  assert.equal(result.kind, 'marked-text-insert', 'interior marked insert must classify')
  const { committed } = commitOf(md, map, state, tr)
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text, 'a **boXld** b\n')
}

// ---- 3. The other three swallowed spellings ----
{
  const cases = [
    { md: 'a *em* b\n', markName: 'emphasis', attrs: null, run: 'em', want: 'a *emX* b\n' },
    { md: 'a ~~del~~ b\n', markName: 'strike_through', attrs: null, run: 'del', want: 'a ~~delX~~ b\n' },
    { md: 'a [link](http://x) b\n', markName: 'link', attrs: { href: 'http://x' }, run: 'link', want: 'a [linkX](http://x) b\n' }
  ]
  for (const c of cases) {
    const state = EditorState.create({
      schema,
      doc: doc(p(text('a '), marked(c.run, c.markName, c.attrs), text(' b')))
    })
    const map = buildProjectionMap(c.md, state.doc)
    assert.ok(map, `${c.markName}: fixture must map`)
    const edge = 3 + c.run.length // trailing edge of the run
    const tr = typeMarked(state, edge, 'X', c.markName, c.attrs)
    const result = classifyTransactions([tr], state)
    assert.equal(result.kind, 'marked-text-insert', `${c.markName} must classify`)
    const { committed } = commitOf(c.md, map, state, tr)
    assert.equal(committed.ok, true, `${c.markName}: ${committed.code}`)
    assert.equal(committed.applied.doc.text, c.want, c.markName)
  }
}

// ---- 4. The plain path is UNCHANGED (the contract this fix may not relax) ----
// An unmarked char at the same trailing edge still lands OUTSIDE the markers,
// and still travels the plain-text classification.
{
  const { md, state, map } = boldFixture()
  const tr = state.tr.replaceWith(7, 7, text('X')) // explicit PLAIN slice
  assert.equal(classifyTransactions([tr], state).kind, 'plain-text')
  const kernel = { doc: createMarkdownDocument(md) }
  const committed = commitPlainText({ kernel, map, transactions: [tr], oldState: state })
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text, 'a **bold**X b\n')
}

// ---- 5. Negative: the slice's marks must be the marks of the run it joins ----
// A slice carrying a mark the insertion point does not sit in has no proven
// byte home (its delimiters do not exist there), so it stays refused.
{
  const { md, state, map } = boldFixture()
  const tr = typeMarked(state, 8, 'X', 'strong') // inside the trailing PLAIN ' b'
  const result = classifyTransactions([tr], state)
  assert.notEqual(result.kind, 'marked-text-insert', 'a mark foreign to the position must not classify')
  const { kernel, committed } = commitOf(md, map, state, tr)
  assert.equal(committed.ok, false)
  assert.equal(committed.code, KERNEL_CODES.MARKED_INSERT, 'the re-derivation must refuse, with the named code')
  assert.equal(kernel.doc.text, md, 'refused insert leaves bytes untouched')
}

// ---- 6. Negative: a marked RANGE replacement is not this classification ----
// Only a zero-width insert is proven here; a replacement also removes bytes
// whose delimiter accounting is the marked-run guard's job, not this one's.
{
  const { state } = boldFixture()
  const tr = state.tr.replaceWith(4, 6, marked('X', 'strong'))
  assert.notEqual(classifyTransactions([tr], state).kind, 'marked-text-insert')
}

// ---- 7. Negative: a multi-mark slice at a single-mark run ----
{
  const { state } = boldFixture()
  const both = schema.text('X', [schema.mark('strong'), schema.mark('emphasis')])
  const tr = state.tr.replaceWith(7, 7, both)
  assert.notEqual(classifyTransactions([tr], state).kind, 'marked-text-insert')
}

// ---- 8. Negative: a newline in the slice ----
{
  const { state } = boldFixture()
  const tr = state.tr.replaceWith(7, 7, marked('X\nY', 'strong'))
  assert.notEqual(classifyTransactions([tr], state).kind, 'marked-text-insert')
}

// ---- 9. A run that spans the WHOLE paragraph, at both of its edges ----
// '**bold**\n': PM children 'bold'[strong](1..5). The leading edge inherits no
// mark in a real editor (PM takes marks from the node BEFORE), so only the
// trailing edge is this classification's business; the leading edge is pinned
// as NOT classifying so the two boundaries can never be confused.
{
  const md = '**bold**\n'
  const state = EditorState.create({ schema, doc: doc(p(marked('bold', 'strong'))) })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map)

  const trailing = typeMarked(state, 5, 'X', 'strong')
  assert.equal(classifyTransactions([trailing], state).kind, 'marked-text-insert')
  const { committed } = commitOf(md, map, state, trailing)
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text, '**boldX**\n')

  const leading = typeMarked(state, 1, 'X', 'strong')
  const result = classifyTransactions([leading], state)
  assert.equal(result.kind, 'marked-text-insert', 'PM can produce this shape; it must be classified, not anonymous')
  const lead = commitOf(md, map, state, leading)
  assert.equal(lead.committed.ok, true, lead.committed.code)
  assert.equal(lead.committed.applied.doc.text, '**Xbold**\n')
}

// ---- 10. A marked run inside a HEADING ----
{
  const md = '# a **b** c\n'
  const state = EditorState.create({
    schema,
    doc: doc(schema.node('heading', { level: 1 }, [text('a '), marked('b', 'strong'), text(' c')]))
  })
  const map = buildProjectionMap(md, state.doc)
  assert.ok(map, 'heading fixture must map')
  const tr = typeMarked(state, 4, 'X', 'strong')
  assert.equal(classifyTransactions([tr], state).kind, 'marked-text-insert')
  const { committed } = commitOf(md, map, state, tr)
  assert.equal(committed.ok, true, committed.code)
  assert.equal(committed.applied.doc.text, '# a **bX** c\n')
}

// ---- 11. Refusal is NAMED, never anonymous ----
// The whole point of the leftover note: a swallowed keystroke with no code and
// no message is indistinguishable from a broken keyboard.
{
  const { md, state } = boldFixture()
  const tr = typeMarked(state, 7, 'X', 'strong')

  // A map that cannot resolve anything (the degraded-block shape) refuses with
  // the mapping code, not by throwing and not by writing.
  const kernel = { doc: createMarkdownDocument(md) }
  const unmapped = commitMarkedTextInsert({ kernel, map: {}, transactions: [tr], oldState: state })
  assert.equal(unmapped.ok, false)
  assert.equal(unmapped.code, KERNEL_CODES.UNMAPPED)
  assert.equal(kernel.doc.text, md)
}

console.log('PASS kernel marked-text insert: typing inside and at the trailing edge of a strong/emphasis/strike/link run commits INSIDE the delimiters, the plain path keeps landing outside them, and every non-proven shape refuses with a named code and untouched bytes')
