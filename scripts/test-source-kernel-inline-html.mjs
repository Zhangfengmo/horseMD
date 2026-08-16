// Cross-chain consistency lock for inline-HTML coalescing
// (source-kernel Plan 5, Task 2).
//
// The projection map zips the kernel's mdast against the live ProseMirror
// doc and requires `pmNode.content.size === charMap.visibleLength` for every
// editable textblock. Inline HTML is the shape where the two chains most
// easily disagree, because the EDITOR chain rewrites its inline children
// before ProseMirror ever sees them:
//   1. `brToBreakRemarkPlugin` (editor-tablebreak.js) turns inline `<br>`
//      html nodes into mdast `break` nodes;
//   2. `remarkMergeInlineHtml` (editor-html.js) then coalesces a balanced
//      open…close run of html/text siblings into ONE `html` node — which
//      preset-commonmark parses into ONE inline `html` ATOM (node/html.ts:
//      `atom:true, group:'inline'`), i.e. content.size 1.
// Both are registered in that order in editor-crepe-setup.js's
// `remarkPluginsCtx` list, so this file replays exactly that order.
//
// The kernel chain runs NEITHER plugin (the merged node has no `position`,
// which violates the kernel's unit contract). It re-derives the same runs on
// its own positioned mdast via the SHARED rule in
// lib/source-kernel/inline-html.js — the same module both editor plugins
// now import, so there is one implementation, not two. This file is the
// evidence that the shared rule actually makes the two chains agree:
//
//   A. the editor chain's inline SIZE (text -> value.length, everything else
//      -> 1, i.e. exactly what PM's `content.size` will be) equals the
//      kernel charMap's `visibleLength`, for every string in the corpus;
//   B. the sequence of MERGED html values the editor chain produces equals
//      the sequence of run values the kernel's `inlineHtmlRunAt` finds over
//      the same (unrewritten) children — same runs, same order, same value.
//
// A failure here means a document shape exists whose projection map would be
// rejected wholesale (kernel mode silently degrading to legacy), or — worse —
// whose block boundaries the two sides count differently.
import assert from 'node:assert/strict'
import { buildSyntaxIndex } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { buildCharacterMap } from '../src/renderer/src/lib/source-kernel/character-map.js'
import { inlineHtmlRunAt } from '../src/renderer/src/lib/source-kernel/inline-html.js'
import { remarkMergeInlineHtml } from '../src/renderer/src/components/editor-html.js'
import { brToBreakRemarkPlugin } from '../src/renderer/src/components/editor-tablebreak.js'

console.log('--- source-kernel inline html (cross-chain) ---')

// The editor chain's phrasing rewrite, in editor-crepe-setup.js's order.
const editorPhrasing = (tree) => {
  const t = structuredClone(tree)
  brToBreakRemarkPlugin()(t)
  remarkMergeInlineHtml()(t)
  return t
}

const PHRASING_BLOCKS = new Set(['paragraph', 'heading'])

// Every phrasing container (paragraph/heading) in document order.
const phrasingBlocks = (tree) => {
  const out = []
  const walk = (n) => {
    if (PHRASING_BLOCKS.has(n.type)) {
      out.push(n)
      return
    }
    for (const c of n.children || []) walk(c)
  }
  for (const c of tree.children || []) walk(c)
  return out
}

// What ProseMirror's `content.size` will be for this phrasing container: a
// text node contributes its length, `inlineCode` likewise (PM models a code
// span as a MARKED TEXT RUN, not an atom — see character-map.js's ATOMS
// comment), a mark wrapper contributes its own children, and every remaining
// inline node (html / break / image / inlineMath) is an atom worth 1.
const pmSize = (node) => {
  let size = 0
  for (const c of node.children || []) {
    if (c.type === 'text' || c.type === 'inlineCode') size += c.value.length
    else if (c.children) size += pmSize(c)
    else size += 1
  }
  return size
}

// The html nodes the editor chain SYNTHESIZED (a merged run carries no
// `position`; an untouched html node keeps its own).
const mergedHtmlValues = (node) => {
  const out = []
  for (const c of node.children || []) {
    if (c.type === 'html' && !c.position) out.push(c.value)
    else if (c.children) out.push(...mergedHtmlValues(c))
  }
  return out
}

// The runs the KERNEL's shared rule finds over the same, unrewritten children.
const kernelRunValues = (node) => {
  const out = []
  const children = node.children || []
  let i = 0
  while (i < children.length) {
    const run = inlineHtmlRunAt(children, i)
    if (run) {
      out.push(run.value)
      i = run.end
      continue
    }
    if (children[i].children) out.push(...kernelRunValues(children[i]))
    i += 1
  }
  return out
}

// Corpus: every inline-HTML shape the two chains can plausibly meet. Kept
// deliberately wide (attributes, nesting, voids, unbalanced, marks inside,
// adjacency, entities/escapes, CRLF, containers) — this is the file that
// catches a future plugin reordering or rule tweak.
const CORPUS = [
  'a <span>x</span> b\n',
  '<span>x</span>\n',
  'a <b><i>x</i></b> b\n',
  'a <span class="k" data-x="1">x</span> b\n',
  'a<br/>b\n',
  'a<br>b\n',
  'a <span>x<br/>y</span> b\n',
  'a <span>x b\n',
  'a </span> b\n',
  'a <span>*x*</span> b\n',
  'a <span>`code`</span> b\n',
  'a <span>$x$</span> b\n',
  'a <span>x</span><span>y</span> b\n',
  'a <span>x</span> and <em>y</em> z\n',
  'a <span>a\\*b</span> c\n',
  'a <span>&amp;</span> b\n',
  'a <!-- c --> b\n',
  'a <span>x</span> b\r\nnext line\r\n',
  '# h <span>x</span>\n',
  '## <span>只有片段</span>\n',
  '> q <span>x</span> r\n',
  '- item <span>x</span> tail\n',
  '- [ ] task <span>x</span>\n',
  '**bold <span>x</span> end**\n',
  '[link <span>x</span>](http://e.com)\n',
  'a <span>多行\n继续</span> b\n',
  'a <span><span>深</span></span> b\n',
  'a <span>x</span>\n\n第二段 <u>y</u> 尾\n',
  'a <img src="x.png"> b\n',
  'a <span>1</span> <span>2</span> <span>3</span> b\n'
]

let checked = 0
for (const src of CORPUS) {
  const idx = buildSyntaxIndex(src)
  const kernelBlocks = phrasingBlocks(idx.tree)
  const editorBlocks = phrasingBlocks(editorPhrasing(idx.tree))
  assert.equal(
    kernelBlocks.length, editorBlocks.length,
    `block count diverged for ${JSON.stringify(src)}`
  )
  for (let i = 0; i < kernelBlocks.length; i += 1) {
    const map = buildCharacterMap(src, kernelBlocks[i])
    assert.ok(map, `kernel charMap must build for ${JSON.stringify(src)} block ${i}`)
    // (A) the identity buildProjectionMap enforces.
    assert.equal(
      map.visibleLength, pmSize(editorBlocks[i]),
      `visibleLength vs PM content.size diverged for ${JSON.stringify(src)} block ${i}`
    )
    // (B) same runs, same order, same merged value.
    assert.deepEqual(
      kernelRunValues(kernelBlocks[i]), mergedHtmlValues(editorBlocks[i]),
      `coalesced runs diverged for ${JSON.stringify(src)} block ${i}`
    )
    // Every kernel unit stays inside the block and the units tile the raw
    // source contiguously except for recorded marker gaps — a coalesced atom
    // must never overlap its neighbours.
    let prevEnd = -1
    for (const u of map.units) {
      assert.ok(u.rawStart >= prevEnd, `units overlap in ${JSON.stringify(src)}`)
      assert.ok(u.rawEnd <= src.length)
      prevEnd = u.rawEnd
    }
    checked += 1
  }
}
assert.ok(checked >= CORPUS.length, 'corpus must have exercised at least one block per string')

// Negative control: the assertion above is only meaningful if the corpus
// actually contains merged runs. At least one string must produce one, and
// the un-mergeable shapes must produce none.
{
  const merged = (src) => mergedHtmlValues(editorPhrasing(buildSyntaxIndex(src).tree).children[0])
  assert.deepEqual(merged('a <span>x</span> b\n'), ['<span>x</span>'])
  assert.deepEqual(merged('a <span>x b\n'), [])
  assert.deepEqual(merged('a<br/>b\n'), [])
  assert.deepEqual(merged('a <span>*x*</span> b\n'), [])
  assert.deepEqual(merged('a <span>x<br/>y</span> b\n'), [])
}

console.log('PASS source-kernel inline html (cross-chain)')
