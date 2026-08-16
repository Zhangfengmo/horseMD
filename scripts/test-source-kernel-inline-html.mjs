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
  // Multi-line fragments inside a container: the coalesced atom's raw span
  // legitimately SWALLOWS the continuation-line prefix ('> ' / '  '), because
  // those bytes sit strictly between the first and last node of the run. PM
  // still counts the whole thing as one atom, so 5 === 5 either way.
  '> a <span>多行\n> 继续</span> b\n',
  '- a <span>多行\n  继续</span> b\n',
  'a <span><span>深</span></span> b\n',
  'a <span>x</span>\n\n第二段 <u>y</u> 尾\n',
  'a <img src="x.png"> b\n',
  'a <span>1</span> <span>2</span> <span>3</span> b\n'
]

for (const src of CORPUS) {
  const idx = buildSyntaxIndex(src)
  const kernelBlocks = phrasingBlocks(idx.tree)
  const editorBlocks = phrasingBlocks(editorPhrasing(idx.tree))
  assert.equal(
    kernelBlocks.length, editorBlocks.length,
    `block count diverged for ${JSON.stringify(src)}`
  )
  // Vacuity guard, PER STRING (review fix): a corpus entry that yields ZERO
  // phrasing blocks asserts nothing, and a global `checked >= CORPUS.length`
  // total would let another entry's two blocks mask it.
  assert.ok(
    kernelBlocks.length > 0,
    `corpus entry asserts nothing (no phrasing block): ${JSON.stringify(src)}`
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
  }
}

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

// ---- extraction fidelity: BASE vs HEAD ----
//
// `remarkMergeInlineHtml` used to carry its own copy of the scan; Task 2 moved
// it into lib/source-kernel/inline-html.js so the kernel could reuse it. That
// move is only safe if the EDITOR chain's output is byte-identical — a
// non-kernel path must not change. The base implementation below is a verbatim
// copy of editor-html.js@e1f7de4 (the commit before the extraction); the
// differential asserts the two produce the same tree for every corpus string
// plus the shapes that specifically exercise the `breakHtmlCuts` argument.
//
// Why the argument exists at all: applying the `<br>` exclusion
// unconditionally DID change base behavior, in the two containers
// `brToBreakRemarkPlugin` does not cover (so their `<br>` is still a real html
// node when the coalescer runs) — the mdast ROOT and `linkReference`. Both are
// pinned below.
const BASE_VOID_TAGS = new Set([
  'br', 'img', 'hr', 'input', 'wbr', 'meta', 'link', 'area', 'base',
  'col', 'embed', 'source', 'track', 'param'
])
const baseIsBalanced = (str) => {
  const re = /<\/?([a-zA-Z][\w-]*)([^>]*)>/g
  const stack = []
  let m
  while ((m = re.exec(str)) !== null) {
    const tag = m[1].toLowerCase()
    const closing = m[0].charAt(1) === '/'
    const selfClosing = /\/\s*$/.test(m[2])
    if (closing) {
      if (stack[stack.length - 1] !== tag) return false
      stack.pop()
    } else if (selfClosing || BASE_VOID_TAGS.has(tag)) { /* void */ } else stack.push(tag)
  }
  return stack.length === 0
}
const baseIsOpening = (str) => typeof str === 'string' &&
  /^<[a-zA-Z][\w-]*\b[^>]*>$/.test(str) && !/^<\//.test(str) && !/^<!--/.test(str)
const baseCoalesce = (node) => {
  if (!Array.isArray(node.children)) return
  for (const c of node.children) baseCoalesce(c)
  const kids = node.children
  const next = []
  let i = 0
  while (i < kids.length) {
    const c = kids[i]
    if (c.type === 'html' && baseIsOpening(c.value)) {
      let raw = ''
      let j = i
      let balanced = false
      while (j < kids.length) {
        const k = kids[j]
        if (k.type !== 'html' && k.type !== 'text') break
        raw += k.value
        j += 1
        if (baseIsBalanced(raw)) { balanced = true; break }
      }
      if (balanced && j > i + 1) {
        next.push({ type: 'html', value: raw })
        i = j
        continue
      }
    }
    next.push(c)
    i += 1
  }
  node.children = next
}

// Structure + values only (the merged node has no position by construction).
const shape = (node) => (node.children
  ? [node.type, node.children.map(shape)]
  : [node.type, node.value ?? null])

const BREAK_SENSITIVE = [
  // mdast root: blank-line-separated block HTML siblings with a bare <br/>.
  '<div>\n\n<br/>\n\n</div>\n',
  // linkReference: brToBreakRemarkPlugin does not descend into it.
  '[ref <span>a<br/>b</span>][id]\n\n[id]: http://e.com\n'
]

for (const src of [...CORPUS, ...BREAK_SENSITIVE]) {
  const tree = buildSyntaxIndex(src).tree
  const base = structuredClone(tree)
  brToBreakRemarkPlugin()(base)
  baseCoalesce(base)
  assert.deepEqual(
    shape(editorPhrasing(tree)), shape(base),
    `extracted coalescer diverged from editor-html.js@e1f7de4 for ${JSON.stringify(src)}`
  )
}

// Positive control for the differential: `breakHtmlCuts` must actually MATTER
// for the two BREAK_SENSITIVE shapes, or asserting base===head on them proves
// nothing. For each, the uncut scan (what base did, and what these containers
// still get) merges; the cut scan refuses.
{
  const rootKids = buildSyntaxIndex(BREAK_SENSITIVE[0]).tree.children
  assert.equal(inlineHtmlRunAt(rootKids, 0, false)?.value, '<div><br/></div>')
  assert.equal(inlineHtmlRunAt(rootKids, 0, true), null)

  const refKids = buildSyntaxIndex(BREAK_SENSITIVE[1]).tree
    .children[0].children[0].children // paragraph > linkReference > phrasing
  assert.equal(refKids[1].type, 'html')
  assert.equal(inlineHtmlRunAt(refKids, 1, false)?.value, '<span>a<br/>b</span>')
  assert.equal(inlineHtmlRunAt(refKids, 1, true), null)

  // And the containers brToBreak DOES cover must be unaffected by the flag,
  // because there is no `<br>` html node left in them by then.
  const paraKids = editorPhrasing(buildSyntaxIndex('a <span>x<br/>y</span> b\n').tree)
    .children[0].children
  assert.ok(paraKids.some((c) => c.type === 'break'), '<br> became a break node')
}

console.log('PASS source-kernel inline html (cross-chain)')
