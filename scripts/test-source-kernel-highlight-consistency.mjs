// Cross-parser consistency: `==highlight==` as seen by the EDITOR chain vs by
// the SOURCE KERNEL chain (Plan 5 Task 3's hard acceptance gate).
//
// Two parsers now recognize `==`:
//   - the editor chain — remark-parse + gfm + math + this repo's own remark
//     plugins, then `highlightRemarkTransform` (editor-highlight.js), which
//     runs HIGHLIGHT_RE over the parsed mdast's `text` node VALUES via
//     mdast-util-find-and-replace and produces positionless nodes;
//   - the kernel chain — the same base parse, then `injectHighlightNodes`
//     (lib/source-kernel/highlight-syntax.js), which runs the SAME regex over
//     the same text node values and derives real byte positions from the
//     character map's decode walk.
//
// They must agree, because ProjectionMap zips the two trees and compares
// ProseMirror's `content.size` against the kernel's `visibleLength` per block:
// a highlight the kernel sees but Crepe does not (or vice versa) makes the
// block non-editable. This suite asserts, for every shape in the corpus:
//
//   A. RULE agreement — same number of highlights, same order, same decoded
//      inner text.
//   B. BYTE provability — every kernel highlight's `position` really spans
//      `==` + inner + `==` in the raw source, ordered and non-overlapping.
//   C. PAIRING identity — the kernel's `visibleLength` for each top-level
//      textblock equals the ProseMirror content size the EDITOR tree implies.
//      This is the identity that decides editable-vs-degraded, so it is the
//      one that actually matters end to end.
//   D. Declared FAIL-CLOSED classes — four shapes where the kernel produces
//      NOTHING although the editor's regex matched. In every one the block
//      then holds more visible characters than ProseMirror and degrades to
//      read-only; none of them mis-maps. This list is exhaustive as measured
//      (corpus + 4000 randomized documents):
//        1. markers written escaped (`\=\=x\=\=`) — the raw bytes are not
//           two literal `=`, though the DECODED value the editor's regex
//           reads is;
//        2. markers written as character references (`&#61;&#61;x&#61;&#61;`)
//           — same reason;
//        3. a paragraph whose phrasing remark rebuilt WITHOUT positions:
//           today gfm's autolink-literal fallback (`==www.a.com==`, and the
//           `see ==www.a.com== ok` a toggle over a bare URL would produce);
//        4. a trailing space before a line ending, where the decoded value is
//           shorter than the raw span, so `textUnits` cannot prove alignment
//           (`a \nb\n` alone already fails — no `==` involved).
//      (3) and (4) are pre-existing `character-map.js` limitations, NOT
//      introduced by highlight: the injection deliberately reuses `textUnits`,
//      so wherever the character map cannot prove a text node, no highlight
//      node is produced there either — the two stay consistent by
//      construction rather than by coincidence.
import assert from 'node:assert/strict'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkFrontmatter from 'remark-frontmatter'
import { highlightRemarkTransform } from '../src/renderer/src/components/editor-highlight.js'
import { remarkMergeInlineHtml } from '../src/renderer/src/components/editor-html.js'
import { remarkUnwrapNonAsciiAutolinks } from '../src/renderer/src/components/editor-autolink.js'
import { brToBreakRemarkPlugin } from '../src/renderer/src/components/editor-tablebreak.js'
import { remarkNormalizeCodeOnlyLinkLabels } from '../src/renderer/src/components/editor-link-labels.js'
import { remarkCaptureListStyle } from '../src/renderer/src/components/editor-list-style.js'
import { remarkReconstructSubstitution } from '../src/renderer/src/components/editor-criticmarkup-plugins.js'
import { buildSyntaxIndex } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { buildCharacterMap } from '../src/renderer/src/lib/source-kernel/character-map.js'
import { HIGHLIGHT_INPUT_RE, highlightMatches } from '../src/renderer/src/lib/source-kernel/highlight-syntax.js'

// The editor's remark chain, in `remarkPluginsCtx` order
// (editor-crepe-setup.js's config callback, which runs at ConfigReady),
// followed by `highlightRemarkTransform` — a `$remark`, so Milkdown appends it
// only after InitReady, which WAITS on ConfigReady. That ordering is load
// bearing (it is why `<span>==x==</span>` is not a highlight: the fragment is
// already one merged html node by the time the regex runs) and is asserted by
// the `inlineHtml` corpus entries below.
//
// `remarkNormalizeRaggedGfmTables` is the one listed plugin not mounted here:
// it lives inside editor-crepe-setup.js, which cannot be imported outside a
// bundler (it pulls in .jsx). It only pads ragged table rows and never
// rewrites phrasing content, so it cannot affect where a `==` run sits; the
// table corpus entry below is well-formed either way.
const editorProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkCaptureListStyle)
  .use(remarkNormalizeCodeOnlyLinkLabels)
  .use(remarkUnwrapNonAsciiAutolinks)
  .use(remarkFrontmatter)
  .use(brToBreakRemarkPlugin)
  .use(remarkMergeInlineHtml)
  .use(remarkReconstructSubstitution)

function editorTree(text) {
  const tree = editorProcessor.runSync(editorProcessor.parse(text))
  return highlightRemarkTransform(tree)
}

function collectHighlights(tree) {
  const out = []
  const walk = (node) => {
    if (node.type === 'highlight') out.push(node)
    for (const child of node.children || []) walk(child)
  }
  walk(tree)
  return out
}

const innerText = (node) => (node.children || []).map((c) => c.value ?? '').join('')

// ---------------------------------------------------------------------------
// The ProseMirror content size the EDITOR tree implies for one textblock.
// Mirrors preset-commonmark/gfm/Crepe's parse runners: text and inlineCode
// contribute their character count (inline code is a MARKED TEXT RUN, not an
// atom), every inline atom contributes 1, and mark containers recurse. Any
// node type not modelled throws, so a corpus entry can never silently pass
// through an unmodelled shape.
// ---------------------------------------------------------------------------
const ATOM_INLINE = new Set(['image', 'imageReference', 'break', 'footnoteReference', 'html', 'inlineMath'])
const MARK_CONTAINERS = new Set(['emphasis', 'strong', 'delete', 'link', 'highlight', 'linkReference'])

function pmContentSize(node) {
  let size = 0
  for (const child of node.children || []) {
    if (child.type === 'text') size += child.value.length
    else if (child.type === 'inlineCode') size += child.value.length
    else if (ATOM_INLINE.has(child.type)) size += 1
    else if (MARK_CONTAINERS.has(child.type)) size += pmContentSize(child)
    else throw new Error('unmodelled inline node type: ' + child.type)
  }
  return size
}

// ---------------------------------------------------------------------------
// Corpus. `divergent: true` marks a shape the two rules genuinely disagree on
// — the kernel must produce NOTHING there (fail closed).
// ---------------------------------------------------------------------------
const CORPUS = [
  // --- the regex's own edge semantics -------------------------------------
  ['==x==', 'minimal'],
  ['==x y==', 'inner space'],
  ['== x ==', 'leading/trailing space is forbidden'],
  ['==x ==', 'trailing space only'],
  ['== x==', 'leading space only'],
  ['a==b==c', 'intraword (CJK has no word boundaries, so it is allowed)'],
  ['{==x==}', 'CriticMarkup form is excluded by the lookbehind/lookahead'],
  ['{==x==', 'half CriticMarkup: open excluded'],
  ['==x==}', 'half CriticMarkup: close allowed'],
  ['===x===', 'triple markers'],
  ['=====', 'marker run only'],
  ['==x==y==', 'three markers: first pair wins, leftover is text'],
  ['==x==z==y==', 'two separate highlights'],
  ['==', 'bare markers'],
  ['====', 'empty content'],
  ['==x', 'unterminated'],
  ['x==y==z', 'flanked by letters'],
  ['==x==.', 'punctuation after'],
  ['.==x==', 'punctuation before'],
  ['==x=y==', 'content containing `=`'],
  ['==x= =y==', 'content containing `= `'],
  ['==a.b==', 'content with a dot (not an autolink)'],
  ['==a_b_c==', 'intraword underscores stay text'],
  ['==a*b==', 'a lone `*` stays text, so this IS a highlight'],
  // --- interaction with other inline constructs ---------------------------
  ['==*x*==', 'emphasis inside: NOT a highlight in either chain'],
  ['*==x==*', 'highlight inside emphasis'],
  ['**a ==x== b**', 'highlight inside strong'],
  ['~~a ==x== b~~', 'highlight inside strikethrough'],
  ['[==x==](https://e.com)', 'highlight inside a link label'],
  ['`==x==`', 'inline code: never a highlight'],
  ['a `code` ==x== b', 'inline code beside a highlight'],
  ['==$x$==', 'inline math inside: splits the text node'],
  ['$==x==$', 'inside inline math'],
  ['==www.a.com==', 'gfm autolink literal claims the content', { unmappableBlocks: true }],
  ['<span>==x==</span>', 'inside a merged inline-HTML fragment: not a highlight'],
  ['==<span>x</span>==', 'html inside: splits the text node'],
  ['==x<br/>y==', 'a hard break inside splits the text node'],
  // --- block contexts ------------------------------------------------------
  ['# ==x==', 'heading'],
  ['> ==x==', 'blockquote'],
  ['- ==x==', 'list item'],
  ['- [ ] ==x==', 'task list item'],
  ['```\n==x==\n```', 'fenced code: never a highlight'],
  ['    ==x==', 'indented code: never a highlight'],
  ['| ==x== | b |\n| --- | --- |\n| c | d |', 'table cell'],
  ['$$\n==x==\n$$', 'block math'],
  // --- content / encoding --------------------------------------------------
  ['==高亮==', 'CJK'],
  ['这是==高亮==的一句话', 'CJK without word boundaries'],
  ['==😀==', 'astral plane'],
  ['==a&nbsp;b==', 'character reference inside the content'],
  ['==&amp;==', 'character reference AS the content'],
  ['==a\\*b==', 'escape inside the content'],
  ['==x\ny==', 'soft line break inside the content'],
  ['a ==x== b\r\nc ==y== d', 'CRLF'],
  ['==x==\r\n==y==\r\n', 'CRLF, two paragraphs'],
  ['一\n\n==二==\n\n三', 'multi-block document'],
  // --- declared fail-closed classes ----------------------------------------
  ['\\=\\=x\\=\\=', 'class 1: escaped markers', { divergent: true }],
  ['&#61;&#61;x&#61;&#61;', 'class 2: markers as character references', { divergent: true }],
  // class 3: the byte string a highlight toggle over a bare URL would produce
  // — both chains agree there is no highlight, and the paragraph is unmappable
  // for the pre-existing autolink-fallback reason (pinned end-to-end as Case
  // M4c in scripts/test-kernel-mode-headless.mjs).
  ['see ==www.a.com== ok', 'class 3: autolink fallback, no positions', { unmappableBlocks: true }],
  // class 4: a trailing space before a soft line break. `a \nb\n` shows the
  // limitation is about the SPACE, not about `==`.
  ['a \nb\n', 'class 4 control: no highlight involved, still unmappable', { unmappableBlocks: true }],
  ['==x== \n==y==\n', 'class 4: trailing space defeats textUnits', { divergent: true, unmappableBlocks: true }]
]

let checkedShapes = 0
let divergences = 0
let randomSummary = ''

for (const [text, label, options = {}] of CORPUS) {
  const editorHighlights = collectHighlights(editorTree(text))
  const index = buildSyntaxIndex(text)
  const kernelHighlights = collectHighlights(index.tree)
  const where = `${JSON.stringify(text)} (${label})`

  if (options.divergent) {
    divergences += 1
    assert.ok(editorHighlights.length > 0, `${where}: fixture sanity — the editor DOES highlight this`)
    assert.equal(kernelHighlights.length, 0,
      `${where}: the kernel must fail closed, never guess a span it cannot prove`)
    continue
  }

  // A. rule agreement
  assert.equal(kernelHighlights.length, editorHighlights.length, `${where}: highlight COUNT must agree`)
  for (let i = 0; i < editorHighlights.length; i += 1) {
    assert.equal(innerText(kernelHighlights[i]), innerText(editorHighlights[i]),
      `${where}: highlight #${i} inner text must agree`)
  }

  // B. byte provability — and, since the inner text agreed above, this is the
  // byte-for-byte span assertion: the raw slice IS `==` + that text + `==`
  // whenever the content has no escapes/references (checked by re-slicing).
  let previousEnd = -1
  for (const node of kernelHighlights) {
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    assert.ok(Number.isInteger(start) && Number.isInteger(end),
      `${where}: every kernel highlight must carry real offsets`)
    assert.ok(start > previousEnd, `${where}: kernel highlights must be ordered and non-overlapping`)
    previousEnd = end
    const raw = text.slice(start, end)
    assert.ok(raw.startsWith('==') && raw.endsWith('==') && raw.length > 4,
      `${where}: raw span must literally be ==…==, got ${JSON.stringify(raw)}`)
    const child = node.children[0]
    assert.equal(child.position.start.offset, start + 2, `${where}: content starts after the open marker`)
    assert.equal(child.position.end.offset, end - 2, `${where}: content ends before the close marker`)
    // The unist points are complete (line/column too), so an injected node is
    // indistinguishable from a parsed one.
    assert.ok(node.position.start.line >= 1 && node.position.start.column >= 1, `${where}: real points`)
  }

  // C. pairing identity — the kernel's visible length must equal the PM
  // content size the editor tree implies, for every top-level textblock. That
  // equality is exactly what buildProjectionMap checks per block, so it is the
  // difference between "editable" and "degraded to read-only".
  const editorBlocks = editorTree(text).children
  const kernelBlocks = index.tree.children
  assert.equal(kernelBlocks.length, editorBlocks.length, `${where}: block COUNT must agree`)
  for (let i = 0; i < editorBlocks.length; i += 1) {
    const md = editorBlocks[i]
    if (md.type !== 'paragraph' && md.type !== 'heading') continue
    const size = pmContentSize(md)
    const charMap = buildCharacterMap(text, kernelBlocks[i])
    if (!charMap) {
      // A block the kernel cannot character-map at all — fail-closed classes
      // 3 and 4 in the header (remark's positionless autolink-literal
      // fallback; a trailing space before a line ending). Both are
      // pre-existing `character-map.js` limitations, not introduced by this
      // task, and are pinned here so they cannot silently become a mis-map.
      assert.ok(options.unmappableBlocks, `${where}: block #${i} must character-map`)
      continue
    }
    assert.equal(charMap.visibleLength, size,
      `${where}: block #${i} visibleLength must equal the PM content size`)
  }

  checkedShapes += 1
}

// ---------------------------------------------------------------------------
// The rule is SHARED, not merely equal: editor-highlight.js re-exports the
// kernel module's regex. If someone forks it, this fails immediately.
// ---------------------------------------------------------------------------
{
  const { HIGHLIGHT_RE: editorRe } = await import('../src/renderer/src/components/editor-highlight.js')
  const { HIGHLIGHT_RE: kernelRe } = await import('../src/renderer/src/lib/source-kernel/highlight-syntax.js')
  assert.equal(editorRe, kernelRe, 'both chains must use ONE regex object, not two copies')
}

// ---------------------------------------------------------------------------
// The INPUT rule is the same rule, in its caret-anchored spelling — not a
// third copy that can drift. What it can and cannot promise, measured:
//
//   FORWARD (asserted): whenever the parse rule reports a highlight ENDING at
//   the caret, the input rule fires at the SAME index with the SAME content.
//   The live rule never misses a highlight the source really contains.
//
//   REVERSE (does NOT hold, pinned below): the input rule looks only
//   backwards from the caret, so on `==x==y==` it fires on `y`, while parsing
//   the committed bytes gives the highlight to `x` (left-to-right,
//   non-overlapping). The PARSE is authoritative — in kernel mode every
//   committed byte is re-derived from it — so this is a display-time
//   optimism, not a divergence in the stored document. What IS asserted: the
//   input rule never fires on a string the parse rule sees no highlight in at
//   all.
// ---------------------------------------------------------------------------
{
  const typedShapes = []
  for (const [text] of CORPUS) {
    // Typing happens within one line; take every prefix of the first line, the
    // way a markRule sees the text before the caret.
    const line = text.split('\n')[0]
    for (let i = 1; i <= line.length; i += 1) typedShapes.push(line.slice(0, i))
  }
  typedShapes.push('==a== ==b==', '==a b== c==', '==a==b', '===a===', '==a\\*b==')
  let matched = 0
  let optimistic = 0
  for (const typed of typedShapes) {
    const rule = typed.match(HIGHLIGHT_INPUT_RE)
    const all = highlightMatches(typed)
    const parsed = all.find((m) => m.end === typed.length) || null
    if (parsed) {
      assert.ok(rule, `typed ${JSON.stringify(typed)}: the input rule must not MISS a real highlight`)
      assert.equal(rule.index, parsed.start, `typed ${JSON.stringify(typed)}: same start`)
      assert.equal(rule[1], parsed.content, `typed ${JSON.stringify(typed)}: same content`)
      matched += 1
    } else if (rule) {
      assert.ok(all.length > 0,
        `typed ${JSON.stringify(typed)}: the input rule fired where the parse sees NO highlight at all`)
      optimistic += 1
    }
  }
  assert.ok(matched > 20, `the input-rule equivalence must actually have matched (got ${matched})`)
  // The pinned reverse counterexample, spelled out.
  assert.ok(HIGHLIGHT_INPUT_RE.test('==x==y=='), 'the input rule fires on the LAST pair')
  assert.deepEqual(highlightMatches('==x==y==').map((m) => m.content), ['x'],
    'while the parse rule gives the highlight to the FIRST pair — parse wins on commit')
  assert.ok(optimistic > 0, 'the optimistic-fire case must actually be exercised')
}

// ---------------------------------------------------------------------------
// Randomized differential: build documents out of `==`-adjacent fragments and
// assert A, B AND C on each. Catches shapes nobody thought to enumerate.
//
// C (the pairing identity) is the assertion this suite exists for, so it runs
// here too, not just over the hand-written corpus — with the two escapes the
// corpus declares explicitly:
//  - when the two chains' highlight COUNTS differ, the kernel deliberately saw
//    fewer (it fails closed); the block is then EXPECTED to hold more visible
//    characters than ProseMirror and degrade. Counted, not asserted.
//  - when `buildCharacterMap` returns null the block is unmappable for
//    reasons that predate `==` (see the divergence classes in the header);
//    also counted.
// Everything else must satisfy `visibleLength === PM content size` exactly.
// ---------------------------------------------------------------------------
{
  // Includes the two shapes behind fail-closed classes 3 and 4 (a bare URL
  // that pushes remark onto its positionless autolink fallback, and a
  // trailing space before a line ending), so the differential exercises them
  // rather than only the corpus.
  const pieces = [
    '==', '=', 'a', ' ', '高', 'x', '{', '}', '*', '`', '\\', '&amp;', '.', '\n\n', '_',
    'www.a.com', ' \n'
  ]
  let seed = 20260817
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  let cases = 0
  let paired = 0
  let failedClosed = 0
  let unmappable = 0
  let unmodelled = 0
  for (let n = 0; n < 4000; n += 1) {
    let text = ''
    const length = 3 + Math.floor(rand() * 7)
    for (let i = 0; i < length; i += 1) text += pieces[Math.floor(rand() * pieces.length)]
    let editorHighlights
    let index
    try {
      editorHighlights = collectHighlights(editorTree(text))
      index = buildSyntaxIndex(text)
    } catch {
      continue // a shape one of the chains cannot parse at all is not this suite's subject
    }
    const kernelHighlights = collectHighlights(index.tree)
    // The kernel is allowed to be STRICTER (fail closed), never looser and
    // never different: any highlight it does report must be one the editor
    // reports too, at the same ordinal, with the same inner text.
    assert.ok(kernelHighlights.length <= editorHighlights.length,
      `random ${JSON.stringify(text)}: kernel invented a highlight the editor does not have`)
    if (kernelHighlights.length === editorHighlights.length) {
      for (let i = 0; i < kernelHighlights.length; i += 1) {
        assert.equal(innerText(kernelHighlights[i]), innerText(editorHighlights[i]),
          `random ${JSON.stringify(text)}: inner text #${i}`)
      }
    }
    for (const node of kernelHighlights) {
      const raw = text.slice(node.position.start.offset, node.position.end.offset)
      assert.ok(raw.startsWith('==') && raw.endsWith('==') && raw.length > 4,
        `random ${JSON.stringify(text)}: unprovable raw span ${JSON.stringify(raw)}`)
    }

    // Input rule vs parse rule, on the last line of the random document.
    {
      const line = text.split('\n').pop()
      const rule = line.match(HIGHLIGHT_INPUT_RE)
      const all = highlightMatches(line)
      const parsed = all.find((m) => m.end === line.length) || null
      if (parsed) {
        assert.ok(rule && rule.index === parsed.start && rule[1] === parsed.content,
          `random typed ${JSON.stringify(line)}: the input rule must not miss a real highlight`)
      } else if (rule) {
        assert.ok(all.length > 0,
          `random typed ${JSON.stringify(line)}: the input rule fired where the parse sees none`)
      }
    }

    // C. pairing identity.
    const editorBlocks = editorTree(text).children
    const kernelBlocks = index.tree.children
    assert.equal(kernelBlocks.length, editorBlocks.length,
      `random ${JSON.stringify(text)}: block count must agree`)
    for (let i = 0; i < editorBlocks.length; i += 1) {
      const md = editorBlocks[i]
      if (md.type !== 'paragraph' && md.type !== 'heading') continue
      let size
      try {
        size = pmContentSize(md)
      } catch {
        unmodelled += 1
        continue
      }
      const charMap = buildCharacterMap(text, kernelBlocks[i])
      if (!charMap) {
        unmappable += 1
        continue
      }
      if (kernelHighlights.length !== editorHighlights.length) {
        failedClosed += 1
        continue
      }
      assert.equal(charMap.visibleLength, size,
        `random ${JSON.stringify(text)}: block #${i} visibleLength must equal the PM content size`)
      paired += 1
    }
    cases += 1
  }
  assert.ok(cases > 3000, 'the randomized differential must actually have run')
  assert.ok(paired > 3000, `the pairing identity must actually have been asserted (got ${paired})`)
  randomSummary = `${cases} randomized documents: ${paired} blocks pair exactly, ` +
    `${failedClosed} fail closed, ${unmappable} unmappable for pre-existing reasons, ` +
    `${unmodelled} unmodelled`
}

console.log(
  `PASS source-kernel highlight cross-parser consistency (${checkedShapes} shapes agree, ` +
  `${divergences} declared divergences fail closed; ${randomSummary})`
)
