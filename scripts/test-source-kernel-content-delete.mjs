// TDD evidence + regression lock for the DELETE side of the kernel's
// observability invariant:
//   * lib/source-kernel/commands/content-delete.js  — a delete that blanks a
//     physical line inside a multi-line block;
//   * lib/source-kernel/commands/trailing-whitespace.js `spellBlockTailDelete`
//     — a delete that strands a literal ASCII space at a block end.
//
// THE DEFECT (2026-08-19 audit, every case reproduced against the real parser
// through the real gateway before the fix). `blockEditIsObservable` is a
// genuine pre-write, fail-closed proof, and NO delete path consulted it. The
// gateway did compute an `observability` expectation for deletes, but it fires
// AFTER publication and only logs — by which time `verifyPlainTextProjection`
// has repaired the VIEW to match the corrupted bytes, which is exactly what
// makes this family permanent and invisible.
//
// Every fixture below is derived from the real parser, never hand-written
// offsets.
import assert from 'node:assert/strict'
import {
  createMarkdownDocument,
  parseKernelMarkdown,
  buildCharacterMap,
  deleteClearsBlockLine,
  proveContentDelete,
  spellBlockTailDelete,
  isOneContiguousReplacement,
  NO_BREAK_SPACE
} from '../src/renderer/src/lib/source-kernel/index.js'

console.log('--- source kernel: the delete side ---')

// The first block of `type` in a document, with the character map the
// projection map would pair with it.
const fixture = (md, type = 'paragraph') => {
  let node = null
  const walk = (candidate) => {
    if (node) return
    if (candidate?.type === type) { node = candidate; return }
    for (const child of candidate?.children || []) walk(child)
  }
  walk(parseKernelMarkdown(md))
  assert.ok(node, `fixture has no ${type}: ${JSON.stringify(md)}`)
  return { doc: createMarkdownDocument(md), block: node, charMap: buildCharacterMap(md, node) }
}

// The raw offset of the FIRST occurrence of `needle`, so no case below hard-codes
// an index that a fixture edit could silently invalidate.
const at = (md, needle) => {
  const index = md.indexOf(needle)
  assert.ok(index >= 0, `fixture must contain ${JSON.stringify(needle)}`)
  return index
}

// Structure of a document, as the shape a reader would describe.
const structure = (md) => {
  const out = []
  const walk = (node, depth) => {
    out.push(`${'  '.repeat(depth)}${node.type}${node.type === 'heading' ? `/${node.depth}` : ''}`)
    for (const child of node.children || []) walk(child, depth + 1)
  }
  walk(parseKernelMarkdown(md), 0)
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// PART 1 — the contiguous-replacement helper (the delete side's decode clause).
// ---------------------------------------------------------------------------
{
  assert.equal(isOneContiguousReplacement('abc', 'ac', ''), true, 'one run removed')
  assert.equal(isOneContiguousReplacement('abc', 'abc', ''), true, 'nothing removed')
  assert.equal(isOneContiguousReplacement('abc', '', ''), true, 'everything removed')
  assert.equal(isOneContiguousReplacement('foo', ' ', ' '), true, 'a run replaced by the insert')
  // The defect shape: a dead escape promoted to visible content. 'a\' is NOT
  // reachable from 'ab' by removing a contiguous run.
  assert.equal(isOneContiguousReplacement('ab', 'a\\', ''), false)
  // Two separate removals are not one contiguous run.
  assert.equal(isOneContiguousReplacement('abcde', 'ace', ''), false)
  // Content appearing from nowhere.
  assert.equal(isOneContiguousReplacement('ab', 'axb', ''), false)
}

// ---------------------------------------------------------------------------
// PART 2 — THE PREFILTER. It must fire on exactly the corrupting shapes and on
// nothing else; a false positive costs a parse, a false negative costs the
// document.
// ---------------------------------------------------------------------------
{
  const clears = (md, needle, type = 'paragraph') => {
    const { block, charMap } = fixture(md, type)
    assert.ok(charMap, `fixture must map: ${JSON.stringify(md)}`)
    const from = at(md, needle)
    return deleteClearsBlockLine({
      text: md, charMap, block, from, to: from + needle.length, insert: ''
    })
  }

  // FIRES: the line loses its last content.
  assert.equal(clears('alpha  \nb  \ngamma\n', 'b'), true, 'hard-break paragraph')
  assert.equal(clears('> alpha  \n> b  \n> gamma\n', 'b'), true,
    "quoted: the '> ' inside the break unit's raw span is syntax, not content")
  assert.equal(clears('a\nb\nc\n', 'b'), true, 'soft break')
  assert.equal(clears('a\\\nb\n', 'b'), true, 'backslash-spelled hard break')
  assert.equal(clears('a  \nb\n', 'b'), true, 'orphan hard-break marker')
  assert.equal(clears('a  \nb\n', 'a'), true, 'the mirror case at the document start')

  // DOES NOT FIRE.
  assert.equal(clears('alpha  \nbb  \ngamma\n', 'b'), false, 'content survives on the line')
  assert.equal(clears('hello\n', 'hello'), false,
    'a SINGLE-line block emptied is the ordinary operation, deliberately untouched')
  assert.equal(clears('hello world\n', 'hello'), false, 'single-line block, partial delete')
  // An inline atom that really IS content keeps the line alive.
  assert.equal(clears('a  \nb ![x](y.png)  \nc\n', 'b'), false,
    'an image on the line is content, so the line is not blanked')

  // A replacement that types real text onto the line cannot blank it.
  {
    const { block, charMap } = fixture('a\nb\nc\n')
    const from = at('a\nb\nc\n', 'b')
    assert.equal(deleteClearsBlockLine({
      text: 'a\nb\nc\n', charMap, block, from, to: from + 1, insert: 'x'
    }), false)
    assert.equal(deleteClearsBlockLine({
      text: 'a\nb\nc\n', charMap, block, from, to: from + 1, insert: ' '
    }), true, 'a whitespace-only replacement still blanks it')
  }
}

// ---------------------------------------------------------------------------
// PART 3 — THE PROOF. The literal bytes are committed only when the reparse
// says so; everything else refuses with the source untouched.
// ---------------------------------------------------------------------------
{
  const prove = (md, needle, type = 'paragraph') => {
    const { doc, block } = fixture(md, type)
    const from = at(md, needle)
    return proveContentDelete({ doc, block, from, to: from + needle.length, insert: '' })
  }

  // D1: the hard-break paragraph. The pre-fix bytes reparse to TWO paragraphs
  // with both hard breaks gone — asserted here so the refusal below is not a
  // statement about nothing.
  assert.equal(structure('alpha  \n  \ngamma\n'),
    'root\n  paragraph\n    text\n  paragraph\n    text')
  assert.equal(prove('alpha  \nb  \ngamma\n', 'b').code, 'unsupported-structure')

  // D2: the NESTED LIST. The pre-fix bytes turn 'outer' into a setext H2 and
  // destroy a whole list level.
  assert.equal(structure('- outer\n  -   \n    tail\n'),
    'root\n  list\n    listItem\n      heading/2\n        text\n      paragraph\n        text')
  assert.equal(prove('- outer\n  - b  \n    tail\n', 'b').code, 'unsupported-structure')

  // D3: the SOFT-break spelling — same shape, PRE-EXISTING (not opened by the
  // 2026-08-18 hard-break relaxation).
  assert.equal(structure('a\n\nc\n'), 'root\n  paragraph\n    text\n  paragraph\n    text')
  assert.equal(prove('a\nb\nc\n', 'b').code, 'unsupported-structure')

  // D4 (Important 3): the backslash-spelled hard break invents visible content.
  {
    const decoded = []
    const walk = (n) => {
      if (typeof n?.value === 'string') decoded.push(n.value)
      for (const c of n?.children || []) walk(c)
    }
    walk(parseKernelMarkdown('a\\\n\n'))
    assert.equal(decoded.join(''), 'a\\',
      'the pre-fix bytes really do promote the dead escape to text the user never typed')
    assert.equal(prove('a\\\nb\n', 'b').code, 'unsupported-structure')
  }

  // D5 (Minor 4): the dead-byte leftovers, both directions.
  assert.equal(prove('a  \nb\n', 'b').code, 'unsupported-structure')
  assert.equal(prove('a  \nb\n', 'a').code, 'unsupported-structure')

  // D6: blockquotes 1 and 2 deep, and CRLF, all the same answer.
  assert.equal(prove('> alpha  \n> b  \n> gamma\n', 'b').code, 'unsupported-structure')
  assert.equal(prove('> > alpha  \n> > b  \n> > gamma\n', 'b').code, 'unsupported-structure')
  assert.equal(prove('alpha  \r\nb  \r\ngamma\r\n', 'b').code, 'unsupported-structure')

  // D7: WHAT THE PROOF LETS THROUGH — a fenced code block's emptied line is
  // legitimate content and stays exactly as it was.
  {
    const { doc, block } = fixture('```\nfoo\nbar\n```\n', 'code')
    const from = at('```\nfoo\nbar\n```\n', 'foo')
    const routed = proveContentDelete({ doc, block, from, to: from + 3, insert: '' })
    assert.equal(routed.ok, true, routed.code)
    assert.deepEqual(routed.edit, { from, to: from + 3, insert: '' })
  }
  // …including the quoted fence, whose blanked line keeps its '> '.
  {
    const md = '> ```\n> foo\n> ```\n'
    const { doc, block } = fixture(md, 'code')
    const from = at(md, 'foo')
    assert.equal(proveContentDelete({ doc, block, from, to: from + 3, insert: '' }).ok, true)
  }
  // A cross-block range is refused outright — no character-level proof can
  // speak for it.
  {
    const md = 'a\n\nb\n'
    const { doc, block } = fixture(md)
    assert.equal(proveContentDelete({ doc, block, from: 0, to: 4, insert: '' }).code,
      'unsupported-structure')
  }
}

// ---------------------------------------------------------------------------
// PART 4 — the delete that STRANDS a block-trailing space (audit Critical B).
//
//   type 'ab', Space   source 'ab<NBSP>'   view 'ab '
//   type 'c'           source 'ab c'       view 'ab c'   (the heal)
//   ONE Backspace      source 'ab '        view 'ab'     <- bytes != view
//   type 'd'           source 'abd '       view 'abd'
//
// The user typed `a b Space c Backspace d`, expected `ab d`, and got `abd` plus
// a space nobody could ever see again.
// ---------------------------------------------------------------------------
{
  const tail = (md, needle, type = 'paragraph') => {
    const { doc, block, charMap } = fixture(md, type)
    assert.ok(charMap, `fixture must map: ${JSON.stringify(md)}`)
    const from = at(md, needle)
    return spellBlockTailDelete({
      doc, block, charMap, from, to: from + needle.length, insert: ''
    })
  }
  const applyEdit = (md, edit) => md.slice(0, edit.from) + edit.insert + md.slice(edit.to)

  // The repro: the stranded space is re-spelled in the SAME edit.
  {
    const routed = tail('ab c\n', 'c')
    assert.equal(routed.ok, true, routed.code)
    assert.equal(applyEdit('ab c\n', routed.edit), 'ab' + NO_BREAK_SPACE + '\n')
    // And it really survives the reparse — which the literal 'ab ' does not.
    const decoded = parseKernelMarkdown('ab' + NO_BREAK_SPACE + '\n').children[0].children[0].value
    assert.equal(decoded, 'ab' + NO_BREAK_SPACE)
    assert.equal(parseKernelMarkdown('ab \n').children[0].children[0].value, 'ab',
      'the literal ASCII space really is stripped — that is the whole defect')
  }
  // A heading and a quoted paragraph behave identically.
  {
    const routed = tail('# ab c\n', 'c', 'heading')
    assert.equal(routed.ok, true, routed.code)
    assert.equal(applyEdit('# ab c\n', routed.edit), '# ab' + NO_BREAK_SPACE + '\n')
  }
  {
    const routed = tail('> ab c\n', 'c')
    assert.equal(routed.ok, true, routed.code)
    assert.equal(applyEdit('> ab c\n', routed.edit), '> ab' + NO_BREAK_SPACE + '\n')
  }
  // The caret lands after the re-spelled space, where the user's Backspace left
  // it — not in front of it (the second half of the defect).
  {
    const routed = tail('ab c\n', 'c')
    assert.equal(routed.transaction.selection.anchor, 3)
  }

  // FAIL-CLOSED where no spelling is unambiguous.
  for (const [md, needle] of [['ab  c\n', 'c'], ['ab\tc\n', 'c']]) {
    const routed = tail(md, needle)
    assert.equal(routed.ok, false, `must refuse: ${JSON.stringify(md)}`)
    assert.equal(routed.code, 'unsupported-structure')
  }

  // NOT CLAIMED, on purpose — nothing is stranded, so nothing changes.
  assert.equal(tail('abc\n', 'c').code, 'not-structural', 'no whitespace at the new end')
  assert.equal(tail('a b c\n', 'b').code, 'not-structural', 'the delete is interior')
  // A GFM TABLE CELL's padding is syntax, present before and after: emptying a
  // cell is the ordinary operation and must not be claimed.
  {
    const md = '| a | b |\n| - | - |\n| c | d |\n'
    const { doc, block, charMap } = fixture(md, 'tableCell')
    const from = at(md, 'a')
    const routed = spellBlockTailDelete({ doc, block, charMap, from, to: from + 1, insert: '' })
    assert.equal(routed.ok, false)
    assert.equal(routed.code, 'not-structural',
      "a cell's own padding was never content, so no byte was stranded")
  }
  // A REPLACEMENT is a different shape and is left to its pre-existing
  // behaviour rather than half-claimed.
  {
    const { doc, block, charMap } = fixture('ab c\n')
    const from = at('ab c\n', 'c')
    assert.equal(spellBlockTailDelete({
      doc, block, charMap, from, to: from + 1, insert: 'z'
    }).code, 'not-structural')
  }
}

console.log('PASS source kernel delete side: a delete that blanks a line inside a multi-line block fails closed (hard/soft/backslash breaks, quotes, lists, CRLF); a delete that strands a block-trailing space re-spells it U+00A0; code-block lines, table cells and ordinary deletes are untouched')
