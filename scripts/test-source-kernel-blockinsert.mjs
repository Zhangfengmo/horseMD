// insertBlockFromQuery command tests (block-insert domain: /table, /code, /js).
// Byte-authoritative: every expected string below is the ACTUAL result of
// running the command + applySourceTransaction, and every accepted result is
// additionally REPARSED so the committed bytes are proven to mean the block the
// command claims to have written (a byte assertion alone cannot tell a table
// from three paragraphs of pipes).
import assert from 'node:assert/strict'
import { createMarkdownDocument, applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { buildSyntaxIndex, parseKernelMarkdown } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { insertBlockFromQuery, BLOCK_INSERT_TARGETS } from '../src/renderer/src/lib/source-kernel/commands/block-insert.js'
import { buildCodeMap } from '../src/renderer/src/lib/source-kernel/code-map.js'
import { buildCharacterMap } from '../src/renderer/src/lib/source-kernel/character-map.js'
import { provePredictedListMerge } from '../src/renderer/src/lib/source-kernel/commands/list-merge.js'

console.log('--- source kernel block-insert ---')

const ctx = (text) => ({ doc: createMarkdownDocument(text), index: buildSyntaxIndex(text) })
const run = (text, offset, target, language) => {
  const c = ctx(text)
  return { c, r: insertBlockFromQuery({ ...c, offset, target, language }) }
}
const apply = (doc, r) => {
  assert.equal(r.ok, true, r.code)
  return applySourceTransaction(doc, r.transaction).doc.text
}
// Structural signature of the reparsed result — the proof that the bytes MEAN
// the requested block.
const shapeOf = (text) =>
  parseKernelMarkdown(text).children.map((node) => {
    if (node.type === 'table') return `table[${node.align.length}]x${node.children.length}`
    if (node.type === 'code') return `code(${node.lang ?? ''})=${JSON.stringify(node.value)}`
    return node.type
  })

// The table skeleton this command writes, spelled once here so every
// expectation below is derived from the same literal the command is asserted
// against — not restated by hand per case.
const TABLE_LF = '|  |  |  |\n| --- | --- | --- |\n|  |  |  |'
const TABLE_CRLF = TABLE_LF.replace(/\n/g, '\r\n')

// ---------------------------------------------------------------------------
// 1. `/table` in a paragraph: the query's WHOLE raw span becomes the skeleton,
//    in ONE edit, with the caret in the first header cell.
// ---------------------------------------------------------------------------
{
  const { c, r } = run('/table\n', 6, 'table')
  const out = apply(c.doc, r)
  assert.equal(out, TABLE_LF + '\n')
  assert.deepEqual(shapeOf(out), ['table[3]x2'], 'header row + delimiter + ONE body row')
  assert.equal(r.transaction.edits.length, 1, 'exactly ONE edit (atomic)')
  assert.deepEqual(r.transaction.edits[0], { from: 0, to: 6, insert: TABLE_LF })
  assert.deepEqual(r.transaction.selection, { anchor: 2, head: 2 },
    'caret sits in the first header cell (`|` + one padding space)')
  assert.equal(r.transaction.intent, 'insert-block')

  // The anchor is the position `table-map.js`'s empty-cell rule derives: the
  // byte after the opening `|` and its first padding space. Asserted on the
  // committed bytes rather than trusted.
  assert.equal(out.slice(0, 3), '|  ')
  const cell = parseKernelMarkdown(out).children[0].children[0].children[0]
  assert.equal(cell.position.start.offset, 0)
  assert.deepEqual(cell.children, [], 'the first cell is empty, so it is anchorable')
}

// Typing into that first cell yields the canonical single-space cell.
{
  const typed = '| x |  |  |\n| --- | --- | --- |\n|  |  |  |\n'
  assert.deepEqual(shapeOf(typed), ['table[3]x2'], 'a filled first cell is still the same table')
}

// ---------------------------------------------------------------------------
// 2. `/code` and `/<language>`: a fenced block whose caret sits on the first
//    content line (`code-map.js`'s own empty-block anchor).
// ---------------------------------------------------------------------------
{
  const cases = [
    [undefined, '```\n\n```\n', 'code()=""', 4],
    ['javascript', '```javascript\n\n```\n', 'code(javascript)=""', 14],
    ['python', '```python\n\n```\n', 'code(python)=""', 10],
    ['cpp', '```cpp\n\n```\n', 'code(cpp)=""', 7]
  ]
  for (const [language, bytes, shape, anchor] of cases) {
    const { c, r } = run('/code\n', 5, 'code', language)
    assert.equal(apply(c.doc, r), bytes, `${language}: bytes`)
    assert.deepEqual(shapeOf(bytes), [shape], `${language}: reparsed shape`)
    assert.deepEqual(r.transaction.selection, { anchor, head: anchor }, `${language}: caret`)
    // The anchor IS what buildCodeMap serves as the block's only addressable
    // position — the proof that the created block is typable, taken from the
    // mapper itself rather than restated.
    const code = parseKernelMarkdown(bytes).children[0]
    const map = buildCodeMap(bytes, code)
    assert.ok(map, `${language}: the created block must be character-mappable`)
    assert.equal(map.visibleLength, 0)
    assert.equal(map.visibleToRaw(0), anchor, `${language}: the caret is the code map's own anchor`)
    // THE EMPTY CONTENT LINE. Typing the first character at that anchor must
    // produce the SAME block with that character in it — not a destroyed
    // closing fence. Asserted on the live parser, because this is the exact
    // shape a fence written without the blank content line gets wrong.
    const typed = bytes.slice(0, anchor) + 'x' + bytes.slice(anchor)
    const reparsed = parseKernelMarkdown(typed).children
    assert.equal(reparsed.length, 1, `${language}: the first keystroke must keep ONE block`)
    assert.equal(reparsed[0].type, 'code')
    assert.equal(reparsed[0].value, 'x', `${language}: the first keystroke lands as the block's content`)
    assert.equal(reparsed[0].lang ?? '', language ?? '')
  }
}
{
  // The negative half of the same proof: the "obvious" fence WITHOUT a content
  // line puts the anchor on the closing fence, and the first keystroke there
  // destroys it. Pinned so the blank line can never be tidied away.
  const naive = '```js\n```\n'
  const map = buildCodeMap(naive, parseKernelMarkdown(naive).children[0])
  const anchor = map.visibleToRaw(0)
  const typed = naive.slice(0, anchor) + 'x' + naive.slice(anchor)
  assert.equal(typed, '```js\nx```\n')
  assert.equal(parseKernelMarkdown(typed).children[0].value, 'x```',
    'a fence with no content line swallows its own terminator on the first keystroke')
}

// ---------------------------------------------------------------------------
// 3. Content AROUND the block is preserved verbatim, and the surrounding
//    document keeps its structure (axis (b) of the command's own proof).
// ---------------------------------------------------------------------------
{
  const src = '前面\n\n/table\n\n后面\n'
  const { c, r } = run(src, src.indexOf('/table') + 6, 'table')
  const out = apply(c.doc, r)
  assert.equal(out, '前面\n\n' + TABLE_LF + '\n\n后面\n')
  assert.deepEqual(shapeOf(out), ['paragraph', 'table[3]x2', 'paragraph'])
}
{
  // Last block, NO trailing line ending at all.
  const { c, r } = run('甲\n\n/table', 9, 'table')
  const out = apply(c.doc, r)
  assert.equal(out, '甲\n\n' + TABLE_LF)
  assert.deepEqual(shapeOf(out), ['paragraph', 'table[3]x2'])
}
{
  // The block right after the query is a HEADING (a construct that interrupts
  // a paragraph, so this shape is reachable): the table must not swallow it.
  const src = '/table\n# 后面\n'
  const { c, r } = run(src, 6, 'table')
  const out = apply(c.doc, r)
  assert.equal(out, TABLE_LF + '\n# 后面\n')
  assert.deepEqual(shapeOf(out), ['table[3]x2', 'heading'])
}
{
  // Heading -> table: `shouldShow` accepts a heading, so the whole heading
  // (marker included) is replaced.
  const { c, r } = run('## /table\n', 9, 'table')
  assert.equal(apply(c.doc, r), TABLE_LF + '\n')
}

// ---------------------------------------------------------------------------
// 4. CRLF. Every line the command writes uses the document's own ending, and
//    no existing ending is touched.
// ---------------------------------------------------------------------------
{
  const src = '前面\r\n\r\n/table\r\n\r\n后面\r\n'
  const { c, r } = run(src, src.indexOf('/table') + 6, 'table')
  const out = apply(c.doc, r)
  assert.equal(out, '前面\r\n\r\n' + TABLE_CRLF + '\r\n\r\n后面\r\n')
  assert.equal(/(?<!\r)\n/.test(out), false, 'no lone LF was introduced')
  assert.deepEqual(shapeOf(out), ['paragraph', 'table[3]x2', 'paragraph'])
  // The caret still lands in the first cell — the anchor is inside line 1, so
  // it is ending-independent.
  assert.deepEqual(r.transaction.selection, { anchor: 8, head: 8 })
  assert.equal(out.slice(8, 9), ' ')
}
{
  const src = '前面\r\n\r\n/js\r\n'
  const { c, r } = run(src, src.indexOf('/js') + 3, 'code', 'javascript')
  const out = apply(c.doc, r)
  assert.equal(out, '前面\r\n\r\n```javascript\r\n\r\n```\r\n')
  assert.equal(/(?<!\r)\n/.test(out), false, 'no lone LF was introduced')
  assert.deepEqual(shapeOf(out), ['paragraph', 'code(javascript)=""'])
  const code = parseKernelMarkdown(out).children[1]
  const map = buildCodeMap(out, code)
  assert.equal(map.visibleToRaw(0), r.transaction.selection.anchor,
    'the CRLF block\'s caret is the code map\'s own anchor')
  const anchor = r.transaction.selection.anchor
  const typed = out.slice(0, anchor) + 'x' + out.slice(anchor)
  assert.equal(typed, '前面\r\n\r\n```javascript\r\nx\r\n```\r\n')
  assert.equal(parseKernelMarkdown(typed).children[1].value, 'x',
    'the CRLF fence keeps its terminator on the first keystroke')
}

// ---------------------------------------------------------------------------
// 5. REFUSALS. Every one returns `unsupported-structure` and NO transaction.
// ---------------------------------------------------------------------------
const refuses = (label, text, offset, target, language) => {
  const { r } = run(text, offset, target, language)
  assert.equal(r.ok, false, label + ' must refuse')
  assert.equal(r.code, 'unsupported-structure', label + ' code')
  assert.equal(r.transaction, undefined, label + ' must not carry a transaction')
}

// Targets this command deliberately does not own (see its own ADR).
// (`math` moved OUT of this list on 2026-08-18, once block math became an
// editable pair — see section 9 below for its own proof. `task` moved out on
// 2026-08-20: the U+00A0 seed spelling made an "empty" task representable —
// its own suite is scripts/test-source-kernel-task-seed.mjs. `divider` and
// `image` moved out the same day as the caret-AFTER targets — sections 10
// and 11 below.)
refuses('paragraph target', '/text\n', 5, 'paragraph')
refuses('nonsense target', '/x\n', 2, 'nope')
refuses('missing target', '/x\n', 2, undefined)

// A language on a target that has no info string, and info strings the fence
// grammar cannot carry.
refuses('language on a table', '/table\n', 6, 'table', 'javascript')
refuses('backtick language', '/x\n', 2, 'code', 'j`s')
refuses('language with a newline', '/x\n', 2, 'code', 'js\nx')
refuses('language with a space', '/x\n', 2, 'code', 'js x')
refuses('empty-ish language', '/x\n', 2, 'code', '-js')

// Nested contexts: a LIST on the ancestor chain stops the quote-chain walk —
// only pure blockquote chains are accepted (section 13 below owns those).
refuses('inside a list item', '- /table\n', 8, 'table')
refuses('inside a quoted list item', '> - /table\n', 10, 'table')

// Block types whose span is not "one line of content".
refuses('code block', '```\n/table\n```\n', 11, 'table')
refuses('thematic break', '---\n', 3, 'table')
refuses('setext heading', '/table\n===\n', 6, 'table')

// Caret not at the block's own end.
refuses('caret mid-block', '/table tail\n', 6, 'table')
refuses('caret at block start', '/table\n', 0, 'table')
refuses('caret on a blank line', '甲\n\n\n', 3, 'table')

// ---------------------------------------------------------------------------
// 6. THE ABSORPTION PROOF. A multi-line block can change the meaning of lines
//    it never wrote — this is the class the reparse axes exist for, and both
//    directions are pinned with the LIVE parser rather than argued.
// ---------------------------------------------------------------------------
{
  // Forward: a table whose next line is ordinary paragraph text swallows it as
  // a ragged extra row. (Unreachable from `shouldShow` — those two lines would
  // be ONE paragraph, so the caret could not be at the block's end — but the
  // command must not depend on that for correctness.)
  const swallowed = parseKernelMarkdown(TABLE_LF + '\n后面\n')
  assert.equal(swallowed.children.length, 1)
  assert.equal(swallowed.children[0].children.length, 3,
    'the live parser really does absorb the following line — axis (a) is not theoretical')
  // Fed to the command directly (offset at the end of a hand-made one-line
  // paragraph followed by a lazy continuation), the shape simply never
  // resolves as a top-level single-line block, so it is refused anyway.
  refuses('query with a continuation line', '/table\n后面\n', 6, 'table')
}
{
  // Backward: `甲\n---\n` is a SETEXT heading, not a paragraph plus a rule —
  // the same class in the other direction, which is why axis (b) compares the
  // whole document and not just the inserted block.
  assert.deepEqual(shapeOf('甲\n---\n'), ['heading'])
}

// ---------------------------------------------------------------------------
// 7. The command NEVER mutates its inputs, and its transaction is single-use.
// ---------------------------------------------------------------------------
{
  const c = ctx('/table\n')
  const before = c.doc.text
  const revision = c.doc.revision
  const first = insertBlockFromQuery({ ...c, offset: 6, target: 'table' })
  assert.equal(c.doc.text, before)
  assert.equal(c.doc.revision, revision)
  assert.equal(first.transaction.baseRevision, revision)
  const applied = applySourceTransaction(c.doc, first.transaction).doc
  const replay = applySourceTransaction(applied, first.transaction)
  assert.equal(replay.ok, false, 'replaying a spent transaction must be refused')
  assert.equal(replay.code, 'stale-revision')
}

// ---------------------------------------------------------------------------
// 8. The exported target table is the routing contract the menu filters
//    through (editor-crepe-setup.js) — pin its shape so an item can never be
//    unblocked for a target this command does not own.
// ---------------------------------------------------------------------------
{
  assert.deepEqual(Object.keys(BLOCK_INSERT_TARGETS).sort(),
    ['code', 'divider', 'image', 'math', 'table', 'task', 'text'])
  assert.equal(BLOCK_INSERT_TARGETS.code.language, true)
  assert.equal(BLOCK_INSERT_TARGETS.table.language, false)
  // A `$$` delimiter pair has no info string, so an info string is refused
  // rather than silently dropped.
  assert.equal(BLOCK_INSERT_TARGETS.math.language, false)
  // A task item has no info string either (2026-08-20; its own suite is
  // scripts/test-source-kernel-task-seed.mjs).
  assert.equal(BLOCK_INSERT_TARGETS.task.language, false)
  // A thematic break has no info string (2026-08-20, section 10 below), and
  // neither has an empty image (section 11) nor the revert-to-text edit
  // (section 12).
  assert.equal(BLOCK_INSERT_TARGETS.divider.language, false)
  assert.equal(BLOCK_INSERT_TARGETS.image.language, false)
  assert.equal(BLOCK_INSERT_TARGETS.text.language, false)
  assert.ok(Object.isFrozen(BLOCK_INSERT_TARGETS))
}

// ---------------------------------------------------------------------------
// 9. `$$` block math (2026-08-18). Same two-axis proof as every other target;
//    what is asserted here is the part that is SPECIFIC to this shape — that
//    the caret anchor the command returns is exactly the anchor the empty
//    block's OWN charMap serves, so the first typed character lands on the
//    empty content line and not on the closing delimiter.
// ---------------------------------------------------------------------------
{
  const mathAnchorAgrees = (text, label) => {
    const doc = createMarkdownDocument(text)
    const offset = text.indexOf('/math') + '/math'.length
    const routed = insertBlockFromQuery({
      doc, index: buildSyntaxIndex(text), offset, target: 'math'
    })
    assert.equal(routed.ok, true, `${label}: ${routed.code}`)
    const applied = applySourceTransaction(doc, routed.transaction)
    assert.equal(applied.ok, true, label)
    const out = applied.doc.text

    // The written block reparses as an EMPTY math block…
    const index = buildSyntaxIndex(out)
    const mathNode = (function find(node) {
      if (node.type === 'math') return node
      for (const child of node.children || []) {
        const hit = find(child)
        if (hit) return hit
      }
      return null
    })(index.tree)
    assert.ok(mathNode, `${label}: the written bytes must reparse as a math block`)
    assert.equal(mathNode.value, '', `${label}: the new block must be empty`)

    // …and the command's anchor IS `emptyCodeMap`'s own anchor for it.
    const charMap = buildCodeMap(out, mathNode)
    assert.ok(charMap, `${label}: the empty math block must be mappable`)
    assert.equal(routed.transaction.selection.anchor, charMap.visibleToRaw(0),
      `${label}: the caret anchor must be the block's own content anchor`)

    // Typing there produces exactly the block on screen — the load-bearing
    // property the empty content line exists for (a missing one would put the
    // anchor on the closing `$$` and commit an unterminated block).
    const anchor = routed.transaction.selection.anchor
    const typed = out.slice(0, anchor) + 'x' + out.slice(anchor)
    const typedMath = (function find(node) {
      if (node.type === 'math') return node
      for (const child of node.children || []) {
        const hit = find(child)
        if (hit) return hit
      }
      return null
    })(buildSyntaxIndex(typed).tree)
    assert.equal(typedMath?.value, 'x', `${label}: the first typed character must become the block's content`)
    return out
  }

  assert.equal(mathAnchorAgrees('/math', 'bare document'), '$$\n\n$$')
  assert.equal(mathAnchorAgrees('前置\n\n/math\n\n后置\n', 'mid-document'),
    '前置\n\n$$\n\n$$\n\n后置\n')
  // CRLF: the delimiters and the empty content line all use the document's
  // dominant ending, never a mixed-ending file.
  assert.equal(mathAnchorAgrees('前置\r\n\r\n/math\r\n\r\n后置\r\n', 'CRLF mid-document'),
    '前置\r\n\r\n$$\r\n\r\n$$\r\n\r\n后置\r\n')

  // An info string is refused — there is nowhere to spell one.
  assert.equal(insertBlockFromQuery({
    doc: createMarkdownDocument('/math'),
    index: buildSyntaxIndex('/math'),
    offset: 5,
    target: 'math',
    language: 'tex'
  }).code, 'unsupported-structure')

  // A LIST on the ancestor chain stays refused (a pure blockquote chain is
  // accepted since 2026-08-22 — section 13 owns those cases).
  for (const [text, label] of [['- /math\n', 'list item'], ['> - /math\n', 'quoted list item']]) {
    const routed = insertBlockFromQuery({
      doc: createMarkdownDocument(text),
      index: buildSyntaxIndex(text),
      offset: text.indexOf('/math') + '/math'.length,
      target: 'math'
    })
    assert.equal(routed.ok, false, `${label}: a non-top-level insert must refuse`)
    assert.equal(routed.code, 'unsupported-structure')
  }
}

// ---------------------------------------------------------------------------
// 10. `/divider` (2026-08-20) — the first caret-AFTER target. The written
//     block has no text position, so what is SPECIFIC here is the caret
//     derivation: document end -> `candidate.length` (the trailing virtual
//     pair's raw anchor, byte-for-byte), following paragraph/heading -> that
//     block's own `buildCharacterMap` content anchor, anything else -> a
//     NAMED refusal (`no-caret-home-after-insert`), zero bytes written.
// ---------------------------------------------------------------------------
{
  // (a) Document end, query is the whole document: the human spelling `---`,
  // caret anchored at the new document end.
  {
    const { c, r } = run('/hr\n', 3, 'divider')
    const out = apply(c.doc, r)
    assert.equal(out, '---\n')
    assert.deepEqual(shapeOf(out), ['thematicBreak'])
    assert.deepEqual(r.transaction.selection, { anchor: 4, head: 4 },
      'doc-end caret anchors at candidate.length — the trailing virtual pair\'s own raw anchor')
  }
  // (b) Document end after real content, no trailing ending at all.
  {
    const { c, r } = run('甲\n\n/hr', 6, 'divider')
    const out = apply(c.doc, r)
    assert.equal(out, '甲\n\n---')
    assert.deepEqual(shapeOf(out), ['paragraph', 'thematicBreak'])
    assert.equal(r.transaction.selection.anchor, out.length)
  }
  // (c) Mid-document before a PARAGRAPH: the caret anchor IS the following
  // paragraph's own content anchor — asserted against buildCharacterMap run
  // on the result, not restated by hand.
  {
    const { c, r } = run('甲\n\n/hr\n\n乙\n', 6, 'divider')
    const out = apply(c.doc, r)
    assert.equal(out, '甲\n\n---\n\n乙\n')
    assert.deepEqual(shapeOf(out), ['paragraph', 'thematicBreak', 'paragraph'])
    const next = parseKernelMarkdown(out).children[2]
    assert.equal(r.transaction.selection.anchor, buildCharacterMap(out, next).visibleToRaw(0),
      'the mid-document caret is the following paragraph\'s content anchor')
  }
  // (d) Mid-document before a HEADING: same rule, and the anchor sits AFTER
  // the ATX marker (a heading's content anchor, not its `#`).
  {
    const { c, r } = run('/hr\n# 后\n', 3, 'divider')
    const out = apply(c.doc, r)
    assert.equal(out, '---\n# 后\n')
    assert.deepEqual(shapeOf(out), ['thematicBreak', 'heading'])
    const next = parseKernelMarkdown(out).children[1]
    const anchor = buildCharacterMap(out, next).visibleToRaw(0)
    assert.equal(r.transaction.selection.anchor, anchor)
    assert.equal(out.slice(anchor, anchor + 1), '后', 'the anchor is the heading\'s first content character')
  }
  // (e) THE FRONTMATTER HAZARD, and the fallback spelling. A `---` written as
  // the document's FIRST block with a later `---` line is ONE yaml node to
  // remark-frontmatter (probed: '---\n\nabc\n\n---' -> yaml[0,13)) — axis (a)
  // rejects that spelling and the command falls back to `***`, the same
  // thematicBreak to every CommonMark parser and never a frontmatter fence.
  {
    const { c, r } = run('/hr\n\n甲\n\n---\n', 3, 'divider')
    const out = apply(c.doc, r)
    assert.equal(out, '***\n\n甲\n\n---\n')
    assert.deepEqual(shapeOf(out), ['thematicBreak', 'paragraph', 'thematicBreak'])
    const next = parseKernelMarkdown(out).children[1]
    assert.equal(r.transaction.selection.anchor, buildCharacterMap(out, next).visibleToRaw(0))
  }
  // (f) CRLF, both caret homes. The written bytes are one line (no interior
  // endings), so the document's endings are simply never touched.
  {
    const { c, r } = run('甲\r\n\r\n/hr\r\n', 8, 'divider')
    const out = apply(c.doc, r)
    assert.equal(out, '甲\r\n\r\n---\r\n')
    assert.equal(/(?<!\r)\n/.test(out), false, 'no lone LF was introduced')
    assert.equal(r.transaction.selection.anchor, out.length)
  }
  {
    const { c, r } = run('甲\r\n\r\n/hr\r\n\r\n乙\r\n', 8, 'divider')
    const out = apply(c.doc, r)
    assert.equal(out, '甲\r\n\r\n---\r\n\r\n乙\r\n')
    assert.equal(/(?<!\r)\n/.test(out), false, 'no lone LF was introduced')
    const next = parseKernelMarkdown(out).children[2]
    assert.equal(r.transaction.selection.anchor, buildCharacterMap(out, next).visibleToRaw(0))
  }
  // (g) NAMED refusals: the following block cannot host the caret — its own
  // code (the message names the workaround), zero bytes, no transaction.
  const refusesCaretHome = (label, text, offset) => {
    const { c, r } = run(text, offset, 'divider')
    assert.equal(r.ok, false, label + ' must refuse')
    assert.equal(r.code, 'no-caret-home-after-insert', label + ' must carry the named code')
    assert.equal(r.transaction, undefined, label + ' must not carry a transaction')
    assert.equal(c.doc.text, text, label + ' must write nothing')
  }
  refusesCaretHome('before a list', '/hr\n\n- 甲\n', 3)
  refusesCaretHome('before a fence', '/hr\n\n```\nx\n```\n', 3)
  refusesCaretHome('before a table', '/hr\n\n| a |\n| - |\n', 3)
  refusesCaretHome('before a blockquote', '/hr\n\n> 甲\n', 3)
  // Before another divider: the `---` spelling reads as frontmatter (axis (a)
  // rejects it), `***` passes the axes — and then the caret rule still
  // refuses, because a thematicBreak cannot host a caret either.
  refusesCaretHome('before another divider', '/hr\n\n---\n', 3)
  // Before a standalone image: that "paragraph" is exactly the shape Crepe
  // renders as a block-level image-block ATOM (charMap: null), so it is
  // excluded from the paragraph rule rather than trusted to resolve.
  refusesCaretHome('before a standalone image', '/hr\n\n![a](x.png)\n', 3)
  // (h) The generic guards hold for this target too.
  refuses('divider inside a list item', '- /hr\n', 5, 'divider')
  // FLIPPED 2026-08-30 (user: 「引用无法插入分割符」). A quoted /divider now
  // INSERTS when a quoted line follows (its caret home — the next quoted
  // textblock's content anchor, the same rule as top level).
  // FLIPPED AGAIN 2026-08-31 (user: 「引用为啥无法使用分隔符」, the empty-quote
  // screenshot): the quote-END shape now INSERTS too — the caret home is
  // WRITTEN as a trailing blank quoted line and the transaction carries
  // `quotePlaceholder` so the controller vouches the in-quote placeholder.
  {
    const { c, r } = run('> /hr\n', 5, 'divider')
    assert.equal(r.ok, true, 'divider at a quote END inserts: ' + (r.code || ''))
    assert.equal(r.quotePlaceholder, true, 'the caret rides the vouched in-quote placeholder')
    const out = apply(c.doc, r)
    assert.equal(out, '> ---\n> \n', 'the divider gains its blank quoted caret-home line')
    assert.equal(r.transaction.selection.anchor, out.length - 1, 'anchor sits after the trailing prefix, before its line ending')
  }
  {
    const src = '> 首行\n>\n> /hr\n>\n> 尾行\n'
    const { r } = run(src, src.indexOf('/hr') + 3, 'divider')
    assert.equal(r.ok, true, 'divider MID-quote inserts: ' + (r.code || ''))
    const editsApplied = src.slice(0, r.transaction.edits[0].from) + r.transaction.edits[0].insert + src.slice(r.transaction.edits[0].to)
    assert.equal(editsApplied, '> 首行\n>\n> ---\n>\n> 尾行\n', 'the quoted divider spells `> ---`')
  }
  refuses('divider with an info string', '/hr\n', 3, 'divider', 'x')
  refuses('divider mid-block caret', '/hr tail\n', 3, 'divider')
}

// ---------------------------------------------------------------------------
// 11. `/image` (2026-08-20) — the second caret-AFTER target. `![]()` is the
//     one byte answer every reference agrees on; what is SPECIFIC here is the
//     shape proof (a paragraph whose single child is an EMPTY image — exactly
//     what Crepe renders as the image-block card) and the caret rule shared
//     with /divider.
// ---------------------------------------------------------------------------
{
  const imageShape = (out, index) => {
    const node = parseKernelMarkdown(out).children[index]
    assert.equal(node.type, 'paragraph')
    assert.equal(node.children.length, 1)
    assert.equal(node.children[0].type, 'image')
    assert.equal(node.children[0].url, '')
    assert.equal(node.children[0].alt ?? '', '')
    return node
  }
  // (a) Document end, query is the whole document.
  {
    const { c, r } = run('/image\n', 6, 'image')
    const out = apply(c.doc, r)
    assert.equal(out, '![]()\n')
    imageShape(out, 0)
    assert.deepEqual(r.transaction.selection, { anchor: 6, head: 6 },
      'doc-end caret anchors at candidate.length — the trailing virtual pair\'s own raw anchor')
  }
  // (b) Document end after real content, no trailing ending.
  {
    const { c, r } = run('甲\n\n/image', 9, 'image')
    const out = apply(c.doc, r)
    assert.equal(out, '甲\n\n![]()')
    imageShape(out, 1)
    assert.equal(r.transaction.selection.anchor, out.length)
  }
  // (c) Mid-document before a PARAGRAPH: the following block's own content
  // anchor, asserted against buildCharacterMap on the result.
  {
    const { c, r } = run('甲\n\n/image\n\n乙\n', 9, 'image')
    const out = apply(c.doc, r)
    assert.equal(out, '甲\n\n![]()\n\n乙\n')
    imageShape(out, 1)
    const next = parseKernelMarkdown(out).children[2]
    assert.equal(r.transaction.selection.anchor, buildCharacterMap(out, next).visibleToRaw(0))
  }
  // (d) CRLF, both caret homes; the written bytes are one line.
  {
    const { c, r } = run('甲\r\n\r\n/image\r\n', 11, 'image')
    const out = apply(c.doc, r)
    assert.equal(out, '甲\r\n\r\n![]()\r\n')
    assert.equal(/(?<!\r)\n/.test(out), false, 'no lone LF was introduced')
    assert.equal(r.transaction.selection.anchor, out.length)
  }
  // (e) The shared caret-home refusals hold for this target too.
  const refusesCaretHome = (label, text, offset) => {
    const { c, r } = run(text, offset, 'image')
    assert.equal(r.ok, false, label + ' must refuse')
    assert.equal(r.code, 'no-caret-home-after-insert', label + ' must carry the named code')
    assert.equal(c.doc.text, text, label + ' must write nothing')
  }
  refusesCaretHome('before a list', '/image\n\n- 甲\n', 6)
  refusesCaretHome('before a fence', '/image\n\n```\nx\n```\n', 6)
  refusesCaretHome('before a standalone image', '/image\n\n![a](x.png)\n', 6)
  refusesCaretHome('before a divider', '/image\n\n---\n', 6)
  // (f) The generic guards hold too.
  refuses('image inside a list item', '- /image\n', 8, 'image')
  // FLIPPED 2026-08-31 (quote-context audit): /image in a quote INSERTS —
  // quoted spelling, and at quote END the written blank quoted line is the
  // caret home (quotePlaceholder), same machinery as /divider.
  {
    const { c, r } = run('> /image\n', 8, 'image')
    assert.equal(r.ok, true, 'quoted /image inserts: ' + (r.code || ''))
    assert.equal(r.quotePlaceholder, true)
    assert.equal(apply(c.doc, r), '> ![]()\n> \n')
  }
  {
    const src = '> 首行\n>\n> /image\n>\n> 尾行\n'
    const { c, r } = run(src, src.indexOf('/image') + 6, 'image')
    assert.equal(r.ok, true, 'mid-quote /image inserts: ' + (r.code || ''))
    assert.equal(apply(c.doc, r), '> 首行\n>\n> ![]()\n>\n> 尾行\n')
  }
  refuses('image with an info string', '/image\n', 6, 'image', 'x')
  refuses('image mid-block caret', '/image tail\n', 6, 'image')
}

// ---------------------------------------------------------------------------
// 12. `/text` (2026-08-20) — revert-to-paragraph, the one target that writes
//     NO block. The edit is a proven deletion and the caret rides the
//     split-placeholder machinery; WHICH home serves it depends on where the
//     query block stands:
//     * document end, remaining doc ends in a list/table/fence/atom (or is
//       empty) -> the trailing virtual pair (requireMap proves it pre-commit),
//       `docEndPlaceholder: false`;
//     * document end, remaining doc ends in a paragraph/heading -> a vouched
//       placeholder at the document end (the kept bytes provably end in a
//       blank line, so the voucher's prefix-less commit is byte-correct),
//       `docEndPlaceholder: true`;
//     * MID-DOCUMENT (2026-08-21) -> a vouched placeholder in the blank-line
//       gap the deletion leaves, `midPlaceholder: true`. See section 12b.
// ---------------------------------------------------------------------------
{
  const revert = (text, offset, expected, expectPlaceholder, label) => {
    const { c, r } = run(text, offset, 'text')
    assert.equal(r.ok, true, `${label}: ${r.code}`)
    assert.equal(r.docEndPlaceholder, expectPlaceholder, `${label}: placeholder flag`)
    assert.equal(r.midPlaceholder, undefined, `${label}: doc-end is not the mid-document route`)
    const out = apply(c.doc, r)
    assert.equal(out, expected, label)
    assert.deepEqual(r.transaction.selection, { anchor: expected.length, head: expected.length },
      `${label}: the caret anchors at the new document end`)
    return out
  }
  // (a) After a paragraph: the kept bytes end in the blank line that stood
  // before the query — the voucher's home (docEndPlaceholder: true).
  assert.deepEqual(shapeOf(revert('甲\n\n/text\n', 8, '甲\n\n', true, 'after a paragraph')), ['paragraph'])
  // (b) After a heading: same voucher home.
  revert('# 题\n\n/text', 10, '# 题\n\n', true, 'after a heading')
  // (c) After a LIST: the trailing virtual pair serves the caret
  // (docEndPlaceholder: false) — the same home /divider takes at doc end.
  assert.deepEqual(shapeOf(revert('- 甲\n\n/text\n', 10, '- 甲\n\n', false, 'after a list')), ['list'])
  // (d) The query is the WHOLE document: an empty document, whose single
  // empty PM paragraph IS the trailing virtual pair.
  revert('/text\n', 5, '', false, 'whole document')
  // (e) A heading query strips its marker too — "/text" on `## /text` means
  // "this block becomes plain text", and empty text is no block at all.
  revert('## /text\n', 8, '', false, 'heading query')
  // (f) Leading blank bytes stay (they precede the query, not follow it).
  revert('\n\n/text', 7, '\n\n', false, 'leading blanks')
  // (g) Surplus blank lines AFTER the query are deleted with it.
  revert('甲\n\n/text\n\n\n', 8, '甲\n\n', true, 'surplus trailing blanks')
  // (h) CRLF, both homes; no lone LF anywhere.
  {
    const out = revert('甲\r\n\r\n/text\r\n', 10, '甲\r\n\r\n', true, 'CRLF after a paragraph')
    assert.equal(/(?<!\r)\n/.test(out), false, 'no lone LF was introduced')
  }
  revert('- 甲\r\n\r\n/text\r\n', 12, '- 甲\r\n\r\n', false, 'CRLF after a list')

  // (i) The generic guards hold for this target too.
  refuses('text inside a list item', '- /text\n', 7, 'text')
  // FLIPPED 2026-08-31 (quote-context audit): quoted /text reverts the
  // query line to the blank quote line `> ` — see the quoted section below.
  assert.equal(run('> /text\n', 7, 'text').r.ok, true)
  refuses('text with an info string', '/text\n', 5, 'text', 'x')
  refuses('text mid-block caret', '/text tail\n', 5, 'text')
  refuses('text on a setext heading', '/text\n===\n', 5, 'text')
}

// ---------------------------------------------------------------------------
// 12b. `/text` MID-DOCUMENT (2026-08-21) — the shape that used to refuse with
//      `text-needs-document-end`. The edit is the MINIMAL deletion of the
//      query block's own bytes, leaving byte-for-byte the same blank-line gap
//      structural Enter already produces mid-document, and the caret anchors
//      at the deleted block's own start.
//
//      Two proofs, tested for load-bearingness in BOTH directions below:
//      the deletion proof (nothing around it may change meaning — the list
//      merge is its case) and the convergence proof (a character typed at the
//      anchor must become its own paragraph there — the paragraph-then-heading
//      lazy-continuation shape is its case, and that one passes the deletion
//      proof, so neither check subsumes the other).
// ---------------------------------------------------------------------------
{
  // Every expectation is DERIVED: the bytes are the input minus the query
  // block's own span, and the convergence property is re-measured on the
  // committed bytes rather than restated.
  const revertMid = (text, offset, expected, label) => {
    const { c, r } = run(text, offset, 'text')
    assert.equal(r.ok, true, `${label}: ${r.code}`)
    assert.equal(r.midPlaceholder, true, `${label}: takes the mid-document route`)
    assert.equal(r.docEndPlaceholder, undefined, `${label}: not the doc-end route`)
    assert.equal(r.transaction.edits.length, 1, `${label}: exactly ONE edit (atomic)`)
    const { from, to, insert } = r.transaction.edits[0]
    assert.equal(insert, '', `${label}: /text writes no bytes`)
    assert.equal(text.slice(0, from) + text.slice(to), expected,
      `${label}: the expectation IS the input minus the query block's span`)
    const out = apply(c.doc, r)
    assert.equal(out, expected, label)
    assert.deepEqual(r.transaction.selection, { anchor: from, head: from },
      `${label}: the caret anchors at the deleted block's own start`)

    // The convergence property, restated on the COMMITTED bytes: a character
    // typed at the anchor becomes its own root-level paragraph exactly there,
    // and the rest of the document is untouched.
    const typed = out.slice(0, from) + 'Z' + out.slice(from)
    const tree = parseKernelMarkdown(typed)
    const landed = tree.children.find((child) => child.position.start.offset === from)
    assert.ok(landed, `${label}: a typed character must start a block at the anchor`)
    assert.equal(landed.type, 'paragraph', `${label}: and that block is a paragraph`)
    assert.equal(landed.position.end.offset, from + 1,
      `${label}: spanning exactly the typed character (nothing absorbed)`)
    const withoutTyped = shapeOf(typed)
    withoutTyped.splice(tree.children.indexOf(landed), 1)
    assert.deepEqual(withoutTyped, shapeOf(out),
      `${label}: typing adds a paragraph and changes nothing else`)
    return out
  }

  // (a) Between two paragraphs — the generic case the user reported.
  assert.deepEqual(
    shapeOf(revertMid('甲\n\n/text\n\n乙\n', 8, '甲\n\n\n\n乙\n', 'between two paragraphs')),
    ['paragraph', 'paragraph'])
  // The bytes are EXACTLY what Enter at the end of `甲` writes in `甲\n\n乙\n`
  // — the same gap, the same session, stated as an equality rather than a
  // claim in a comment.
  assert.equal('甲' + '\n\n' + '\n\n乙\n', '甲\n\n\n\n乙\n')

  // (b) After a heading.
  revertMid('# 题\n\n/text\n\n乙\n', 10, '# 题\n\n\n\n乙\n', 'after a heading')
  // (c) The query block IS a heading — "/text" means "this block becomes
  // plain text", and empty text is no block at all, so its marker goes too.
  revertMid('甲\n\n## /text\n\n乙\n', 11, '甲\n\n\n\n乙\n', 'a heading query block')
  // (d) Between a list and a paragraph.
  assert.deepEqual(
    shapeOf(revertMid('- 甲\n\n/text\n\n乙\n', 10, '- 甲\n\n\n\n乙\n', 'after a list')),
    ['list', 'paragraph'])
  // (e) The FIRST block of the document.
  revertMid('/text\n\n乙\n', 5, '\n\n乙\n', 'first block')
  // (f) Around a fence.
  revertMid('甲\n\n/text\n\n```js\nx\n```\n', 8, '甲\n\n\n\n```js\nx\n```\n', 'before a fence')
  revertMid('```js\nx\n```\n\n/text\n\n乙\n', 18, '```js\nx\n```\n\n\n\n乙\n', 'after a fence')
  // (g) Around a table.
  revertMid('甲\n\n/text\n\n| a | b |\n| - | - |\n', 8, '甲\n\n\n\n| a | b |\n| - | - |\n',
    'before a table')
  revertMid('| a | b |\n| - | - |\n\n/text\n\n乙\n', 26, '| a | b |\n| - | - |\n\n\n\n乙\n',
    'after a table')
  // (h) Around a thematic break.
  revertMid('甲\n\n/text\n\n---\n\n乙\n', 8, '甲\n\n\n\n---\n\n乙\n', 'before a divider')
  revertMid('---\n\n/text\n\n乙\n', 10, '---\n\n\n\n乙\n', 'after a divider')
  // (i) Around block math.
  revertMid('甲\n\n/text\n\n$$\nx\n$$\n', 8, '甲\n\n\n\n$$\nx\n$$\n', 'before block math')
  revertMid('$$\nx\n$$\n\n/text\n\n乙\n', 14, '$$\nx\n$$\n\n\n\n乙\n', 'after block math')
  // (j) CRLF: the deletion never touches a line ending, so no lone LF can
  // appear — and the anchor still lands in the gap.
  {
    const out = revertMid('甲\r\n\r\n/text\r\n\r\n乙\r\n', 10, '甲\r\n\r\n\r\n\r\n乙\r\n', 'CRLF mid-document')
    assert.equal(/(?<!\r)\n/.test(out), false, 'no lone LF was introduced')
  }

  // (k) THE DELETION PROOF IS LOAD-BEARING: two lists with the query block
  // between them close over the gap into ONE loose list (CommonMark 0.28
  // dropped the two-blank-lines rule), which is a restructuring of the user's
  // document — refused, nothing written. Note the CONVERGENCE proof would
  // pass here (`- a\n\nx\n\n- b\n` is list/paragraph/list), so this case is
  // exactly what the deletion proof exists for.
  {
    const merged = parseKernelMarkdown('- a\n\n\n\n- b\n')
    assert.deepEqual(merged.children.map((node) => node.type), ['list'],
      'the premise: the two lists really do merge when the gap block goes')
    const { c, r } = run('- a\n\n/text\n\n- b\n', 10, 'text')
    assert.equal(r.ok, false, 'a merging deletion must refuse')
    assert.equal(r.code, 'text-neighbors-would-merge', 'and carry the named code')
    assert.equal(r.transaction, undefined)
    assert.equal(c.doc.text, '- a\n\n/text\n\n- b\n', 'nothing written')
  }
  {
    const { r } = run('1. a\n\n/text\n\n2. b\n', 11, 'text')
    assert.equal(r.ok, false, 'ordered lists merge the same way')
    assert.equal(r.code, 'text-neighbors-would-merge')
  }
  // (k2) …but ONLY the same marker merges (probed 2026-08-21, and the reason
  // the refusal must not be stated as "between two lists"). CommonMark starts
  // a NEW list when the marker character changes, so `-` beside `*`, `-`
  // beside `1.` and `1.` beside `1)` leave two lists standing — the deletion
  // is structure-identical and `/text` has always LANDED there. Pinned so a
  // future widening of the refusal cannot quietly swallow these.
  {
    const twoLists = (text, offset, expected, label) => {
      const shape = parseKernelMarkdown(expected).children.map((node) => node.type)
      assert.deepEqual(shape, ['list', 'list'],
        `${label}: the premise — different markers do NOT merge`)
      revertMid(text, offset, expected, label)
    }
    twoLists('- a\n\n/text\n\n* b\n', 10, '- a\n\n\n\n* b\n', 'bullet then a different bullet')
    twoLists('- a\n\n/text\n\n1. b\n', 10, '- a\n\n\n\n1. b\n', 'bullet then ordered')
    twoLists('1. a\n\n/text\n\n1) b\n', 11, '1. a\n\n\n\n1) b\n', 'two ordered delimiters')
  }
  // (k3) And the merge cases refuse for a reason that is NOT "the bytes are
  // unprovable" — the deletion is perfectly predictable (commands/list-merge.js
  // proves exactly this shape for `/task`). What `/text` lacks is a caret
  // HOME: the gap it would leave sits between two items of ONE list, which is
  // not a root-level position and cannot hold a paragraph in ProseMirror's
  // list schema, so the placeholder session has nowhere to put the empty
  // paragraph the user asked for. Stated as an assertion so the reason is
  // pinned, not just written in a comment.
  {
    const merged = parseKernelMarkdown('- a\n\n\n\n- b\n')
    assert.deepEqual(merged.children.map((node) => node.type), ['list'])
    const items = merged.children[0].children
    assert.equal(items.length, 2, 'the gap is INSIDE one list, between its two items')
    assert.ok(items[0].position.end.offset < 5 && items[1].position.start.offset > 5,
      'and the anchor offset falls strictly between them — no block owns it')
  }

  // (l) THE CONVERGENCE PROOF IS LOAD-BEARING: an ATX heading may interrupt a
  // paragraph, so `甲\n# /text` deletes cleanly (the deletion proof passes —
  // asserted here, not assumed) yet leaves the anchor one line ending below
  // `甲`, where a typed character becomes a LAZY CONTINUATION of it instead
  // of a new paragraph. Refused.
  {
    const text = '甲\n# /text\n\n乙\n'
    assert.deepEqual(parseKernelMarkdown(text).children.map((node) => node.type),
      ['paragraph', 'heading', 'paragraph'], 'the premise: the heading interrupts the paragraph')
    assert.deepEqual(parseKernelMarkdown('甲\n\n\n乙\n').children.map((node) => node.type),
      ['paragraph', 'paragraph'], 'the premise: the DELETION alone is structurally clean')
    assert.deepEqual(parseKernelMarkdown('甲\nZ\n\n乙\n').children.map((node) => node.type),
      ['paragraph', 'paragraph'], 'the premise: but a typed character joins the paragraph above')
    const { c, r } = run(text, 9, 'text')
    assert.equal(r.ok, false, 'an anchor that cannot host a paragraph must refuse')
    assert.equal(r.code, 'text-neighbors-would-merge')
    assert.equal(c.doc.text, text, 'nothing written')
  }

  // (m) The generic container guards hold mid-document too: a block nested in
  // a blockquote or a list item is never a ROOT child, so the command refuses
  // before either proof runs — the same guard every other slash-insert target
  // takes (`unsupported-structure`).
  {
    // FLIPPED 2026-08-31: mid-document quoted /text reverts to the blank
    // quote line, neighbours untouched.
    const { c, r } = run('甲\n\n> /text\n\n乙\n', 10, 'text')
    assert.equal(r.ok, true, 'mid-document quoted /text reverts: ' + (r.code || ''))
    assert.equal(apply(c.doc, r), '甲\n\n> \n\n乙\n')
  }
  refuses('text mid-document inside a list item', '甲\n\n- /text\n\n乙\n', 10, 'text')
}

// ---------------------------------------------------------------------------
// 13. `provePredictedListMerge` (commands/list-merge.js) — the proof itself,
//     asked directly. The `/task` command can only ever hand it HONEST
//     candidates (it builds them by splicing its own bytes), so the guards
//     that catch a DISHONEST one are unreachable through the command and
//     would rot into comments if they were only exercised end to end. Here
//     the candidate is supplied independently of the baseline, which is what
//     makes each guard assertable.
// ---------------------------------------------------------------------------
{
  const SEED = '- [ ] ' + ' '
  // baseline / candidate are parsed from the strings given; `start`/`end` are
  // the region the caller CLAIMS to have replaced with `insertedLength` bytes.
  const prove = (baseline, candidate, start, end, insertedLength, ordered = false) =>
    provePredictedListMerge({
      baselineText: baseline,
      baselineTree: parseKernelMarkdown(baseline),
      candidateText: candidate,
      candidateTree: parseKernelMarkdown(candidate),
      start,
      end,
      insertedLength,
      ordered
    })
  // The HONEST candidate for a claimed edit — used wherever a case is about
  // what the PARSER does rather than about a caller telling the truth.
  const splice = (baseline, start, end, bytes) =>
    baseline.slice(0, start) + bytes + baseline.slice(end)

  // The honest shape it exists for, as a control: without this passing, every
  // negative below would be vacuous.
  {
    const proven = prove('- a\n\n/task\n', '- a\n\n' + SEED + '\n', 5, 10, SEED.length)
    assert.ok(proven, 'the control: a real upward merge is proven')
    assert.equal(proven.mergedUp, true)
    assert.equal(proven.mergedDown, false)
    assert.equal(proven.item.checked, false, 'and it hands back OUR item')
    assert.deepEqual(
      [proven.item.position.start.offset, proven.item.position.end.offset],
      [5, 5 + SEED.length], 'spanning exactly the written bytes')
  }

  // NOT A MERGE AT ALL. A candidate whose written block stands alone must
  // answer null even though it is perfectly valid — accepting it here would
  // make this proof a second, weaker path to the structure-identical case.
  assert.equal(prove('甲\n\n/task\n', '甲\n\n' + SEED + '\n', 3, 8, SEED.length), null,
    'a standalone insert is not this proof’s business')

  // ORDEREDNESS MISMATCH: the caller claims to have written an item of an
  // ORDERED list, but the merged list is a bullet list.
  assert.equal(prove('- a\n\n/task\n', '- a\n\n' + SEED + '\n', 5, 10, SEED.length, true), null,
    'a bullet merge cannot answer an ordered claim')

  // THE BYTE RELATION. A candidate that is NOT the baseline with the claimed
  // region replaced is refused before any structural question is asked —
  // these three all have the right item count, the right merged span and
  // structurally indistinguishable neighbours, and differ only in bytes the
  // caller had no business changing.
  assert.equal(prove('- a\n\n/task\n', '- A\n\n' + SEED + '\n', 5, 10, SEED.length), null,
    'a neighbour whose TEXT changed without moving is not a merge')
  assert.equal(prove('- a\n\n/task\n甲\n', '- a\n\n' + SEED + '\n乙\n', 5, 10, SEED.length), null,
    'a byte changed AFTER the region is not a merge')
  assert.equal(prove('- a\n\n/task\n', '- a\n\n' + SEED + '\n\n', 5, 10, SEED.length), null,
    'a candidate of the wrong LENGTH is not a merge')

  // A RESTRUCTURING THE PARSER REALLY PRODUCES (found by sweeping neighbour
  // shapes, not invented): an INDENTED list below the query becomes a NESTED
  // list inside the item we just wrote instead of a sibling of it. The bytes
  // are an honest splice and the merged span is exactly the union, so this is
  // the shape that proves the proof looks INSIDE the merge at all.
  //
  // Honest note on which guard fires: measured by mutation, the item account
  // is not the only one here — our item having grown a child list also fails
  // `taskItemAgrees`. The account's own justification is in list-merge.js's
  // ADR (it is the only statement made about the NEIGHBOURS, which
  // `outsideSignature` skips entirely); the premise below asserts its content
  // — the count really is wrong — directly on real bytes.
  {
    const baseline = '- a\n\n/task\n\n  - b\n'
    const start = baseline.indexOf('/task')
    const candidate = splice(baseline, start, start + 5, SEED)
    const nested = parseKernelMarkdown(candidate).children[0]
    assert.equal(nested.children.length, 2,
      'the premise: the indented list nested itself into our item, so there are TWO items, not three')
    assert.equal(nested.children[1].children.length, 2,
      'and our item grew a child list it never asked for')
    assert.equal(prove(baseline, candidate, start, start + 5, SEED.length), null,
      'a merge that nests the neighbour is not the predicted merge')
    // …and end to end, the command refuses it rather than writing the bytes.
    refuses('task above an INDENTED list', baseline, start + 5, 'task')
  }
  // The same shape with a multi-item up-neighbour: the count is off by one in
  // a document where a naive "did anything merge?" test would say yes.
  {
    const baseline = '- a\n- b\n\n/task\n\n  - c\n'
    const start = baseline.indexOf('/task')
    assert.equal(prove(baseline, splice(baseline, start, start + 5, SEED),
      start, start + 5, SEED.length), null, 'and with two items above')
    refuses('task between a list and an indented list', baseline, start + 5, 'task')
  }

  // A CLAIMED REGION THAT IS NOT A ROOT CHILD's span: the query block the
  // caller names does not exist in the baseline at those offsets.
  assert.equal(prove('- a\n\n/task\n', '- a\n\n' + SEED + '\n', 6, 10, SEED.length), null,
    'the claimed region must BE a root child')
  assert.equal(prove('- a\n\n/task\n', '- a\n\n' + SEED + '\n', 5, 9, SEED.length), null,
    'including its end')

  // BOTH neighbours, proven, with the item in the middle — the three-way
  // shape, and the one where a mis-indexed item comparison would still find
  // the right COUNT.
  {
    const proven = prove('- a\n\n/task\n\n- b\n', '- a\n\n' + SEED + '\n\n- b\n',
      5, 10, SEED.length)
    assert.ok(proven, 'a two-sided merge is proven')
    assert.equal(proven.mergedUp, true)
    assert.equal(proven.mergedDown, true)
    assert.equal(proven.merged.children.length, 3)
    assert.equal(proven.merged.children.indexOf(proven.item), 1,
      'our item is the MIDDLE one — the neighbours kept their order')
  }
}

// ---------------------------------------------------------------------------
// 13. QUOTED inserts (2026-08-22, the「引用内嵌套」report's block-INSERT half):
//     a query paragraph whose ancestor chain is PURE blockquotes takes the
//     caret-INSIDE targets — /table, /code(+language), /math, /task. The
//     spelling is the top-level one with every CONTINUATION line carrying the
//     query line's own quote prefix byte-for-byte (code-map.js refuses
//     anything less than the full derived prefix per content line), the
//     anchor is remapped through the same transform, and both proof axes run
//     against the quote chain. Caret-AFTER targets (/divider, /image) and
//     /text keep refusing inside quotes — their caret homes (following-block
//     anchor / vouched placeholders) are unproven under a quote prefix.
// ---------------------------------------------------------------------------
{
  const QUOTED_TABLE = TABLE_LF.split('\n').join('\n> ')
  const insertQuoted = (text, offset, target, language, expected, anchor, label) => {
    const { c, r } = run(text, offset, target, language)
    assert.equal(r.ok, true, `${label}: ${r.code}`)
    assert.equal(r.transaction.edits.length, 1, `${label}: exactly ONE edit (atomic)`)
    assert.deepEqual(r.transaction.selection, { anchor, head: anchor }, `${label}: caret`)
    const out = apply(c.doc, r)
    assert.equal(out, expected, label)
    return { r, out }
  }
  // (a) /table in a quote: every row carries the prefix, caret in the first
  //     header cell (first line — the anchor needs no shift there).
  {
    const { out } = insertQuoted('> /table\n', 8, 'table', undefined,
      '> ' + QUOTED_TABLE + '\n', 4, 'quoted /table')
    const tree = parseKernelMarkdown(out)
    assert.equal(tree.children[0].type, 'blockquote')
    assert.equal(tree.children[0].children[0].type, 'table')
    assert.equal(tree.children[0].children[0].children.length, 2)
  }
  // (b) /js in a quote: the empty content line is `> ` (the FULL prefix —
  //     code-map's per-line prefix check is byte-for-byte), and the caret
  //     sits after that prefix.
  {
    const { out } = insertQuoted('> /js\n', 5, 'code', 'javascript',
      '> ```javascript\n> \n> ```\n', 16, 'quoted /js')
    const tree = parseKernelMarkdown(out)
    const code = tree.children[0].children[0]
    assert.equal(code.type, 'code')
    assert.equal(code.lang, 'javascript')
    assert.equal(code.value, '', 'quoted fence starts empty')
  }
  // (c) /math in a quote.
  {
    const { out } = insertQuoted('> /math\n', 7, 'math', undefined,
      '> $$\n> \n> $$\n', 5, 'quoted /math')
    assert.equal(parseKernelMarkdown(out).children[0].children[0].type, 'math')
  }
  // (d) /task in a quote: single line, so bytes and seed are the top-level
  //     ones; the ledger entry still points at the U+00A0.
  {
    const { r, out } = insertQuoted('> /task\n', 7, 'task', undefined,
      '> - [ ]  \n', 9, 'quoted /task')
    assert.deepEqual(r.transaction.whitespaceMarks, [{ from: 8, to: 9, ascii: '' }],
      'quoted /task: the seed is ledgered at its quoted offset')
    const item = parseKernelMarkdown(out).children[0].children[0].children[0]
    assert.equal(item.checked, false, 'quoted /task: a real GFM task item')
  }
  // (d2) /task in a quote with FOLLOWING quote lines (2026-08-23 user report:
  //      待办列表 refused inside the big blockquote whose tail carried blank
  //      `>` / `> ` lines). remark extends a QUOTED list's mdast end across
  //      the following blank quote lines (measured: '> - [ ] x\n>\n' spans
  //      the bare '>' line; at root the list ends at its item), so the old
  //      end === insertedEnd reading refused a document that is exactly what
  //      the bytes mean. The restated proof: the node's positioned
  //      descendants all end at OUR bytes' end, and every byte of the span
  //      tail beyond them is quote-prefix/whitespace — no content absorbed.
  {
    const { out } = insertQuoted('> 甲\n>\n> /task\n>\n> 乙\n', 13, 'task', undefined,
      '> 甲\n>\n> - [ ] \u00A0\n>\n> 乙\n', 15, 'quoted /task with a following sibling')
    const q = parseKernelMarkdown(out).children[0]
    assert.equal(q.children.length, 3, 'paragraph + task list + paragraph — nothing merged')
    assert.equal(q.children[1].children[0].checked, false)
  }
  insertQuoted('> 甲\n>\n> /task\n>\n', 13, 'task', undefined,
    '> 甲\n>\n> - [ ] \u00A0\n>\n', 15, 'quoted /task with a bare > line after')
  insertQuoted('> 甲\n>\n> /task\n> \n> \n', 13, 'task', undefined,
    '> 甲\n>\n> - [ ] \u00A0\n> \n> \n', 15, 'quoted /task with "> " blank lines after')
  {
    const { out } = insertQuoted('> 甲\r\n>\r\n> /task\r\n>\r\n> 乙\r\n', 15, 'task', undefined,
      '> 甲\r\n>\r\n> - [ ] \u00A0\r\n>\r\n> 乙\r\n', 17, 'CRLF quoted /task with a following sibling')
    assert.equal(/(?<!\r)\n/.test(out), false, 'no lone LF was introduced')
  }
  // Negative control: a LAZY continuation line would become the item's own
  // content (real absorption) — still refused.
  refuses('quoted /task with a lazy continuation after', '> 甲\n>\n> /task\n> 哈\n', 13, 'task')
  // Negative control: a same-marker list on the NEXT quote line would merge
  // into the written item's list (two items) — shapeAgrees' single-item
  // check refuses; the span-tail relaxation must not have opened this.
  refuses('quoted /task merging a following quoted list', '> 甲\n>\n> /task\n> - 乙\n', 13, 'task')
  // (d3) NESTED quote chain with following lines: the same span-tail proof
  //      holds at depth 2.
  {
    const { out } = insertQuoted('> > 甲\n> >\n> > /task\n> >\n> > 乙\n', 19, 'task', undefined,
      '> > 甲\n> >\n> > - [ ]  \n> >\n> > 乙\n', 21, 'nested-quoted /task with a following sibling')
    const inner = parseKernelMarkdown(out).children[0].children[0]
    assert.equal(inner.type, 'blockquote')
    assert.equal(inner.children.length, 3, 'nested quote keeps paragraph + list + paragraph')
  }
  // (d3b) /task right AFTER a quoted list (2026-08-23 combo sweep): the
  //       PRECEDING list's mdast end is re-recorded when its next sibling
  //       becomes a list (span bookkeeping over the blank `>` line, zero
  //       bytes changed) — the clamped outside signature must not read that
  //       as a meaning change.
  {
    const { out } = insertQuoted('> 1. 甲1\n>\n> /task\n>\n> 乙\n', 17, 'task', undefined,
      '> 1. 甲1\n>\n> - [ ]  \n>\n> 乙\n', 19, 'quoted /task right after a quoted ordered list')
    const q = parseKernelMarkdown(out).children[0]
    assert.deepEqual(q.children.map((n) => n.type), ['list', 'list', 'paragraph'],
      'ordered list + new task list + paragraph — never merged')
    assert.equal(q.children[1].children[0].checked, false)
  }
  // (d4) quote-mid /table, /js and /math with following quote lines — these
  //      targets never had the list-span swallow (their nodes end at their
  //      own bytes); pinned so the whole quoted insert family stays usable
  //      MID-quote, not only on the quote's last line.
  insertQuoted('> 甲\n>\n> /table\n>\n> 乙\n', 14, 'table', undefined,
    '> 甲\n>\n> ' + QUOTED_TABLE + '\n>\n> 乙\n', 10, 'quote-mid /table with following sibling')
  insertQuoted('> 甲\n>\n> /js\n>\n> 乙\n', 11, 'code', 'javascript',
    '> 甲\n>\n> ```javascript\n> \n> ```\n>\n> 乙\n', 22, 'quote-mid /js with following sibling')
  insertQuoted('> 甲\n>\n> /math\n>\n> 乙\n', 13, 'math', undefined,
    '> 甲\n>\n> $$\n> \n> $$\n>\n> 乙\n', 11, 'quote-mid /math with following sibling')

  // (e) a NESTED quote chain: the prefix is the whole `> > `.
  insertQuoted('> > /table\n', 10, 'table', undefined,
    '> > ' + TABLE_LF.split('\n').join('\n> > ') + '\n', 6, 'nested-quoted /table')
  // (f) CRLF: the ending inside the written bytes is the document's own.
  {
    const { out } = insertQuoted('> /js\r\n', 5, 'code', 'javascript',
      '> ```javascript\r\n> \r\n> ```\r\n', 17, 'CRLF quoted /js')
    assert.equal(/(?<!\r)\n/.test(out), false, 'no lone LF was introduced')
  }
  // (g) sibling protection: a quoted paragraph above the query survives
  //     byte-identical.
  insertQuoted('> 甲\n>\n> /math\n', 13, 'math', undefined,
    '> 甲\n>\n> $$\n> \n> $$\n', 11, 'quoted /math below a sibling')
  // (h) refusals: /image and /text stay refused in quotes, and a list on the
  //     chain still refuses everything. /divider moved OUT of this list
  //     2026-08-30 — its quoted insert is proven (see the flipped case in
  //     the divider section above); the quote-END shape keeps a NAMED
  //     no-caret-home refusal.
  {
    // FLIPPED 2026-08-31: quote-END /divider inserts with its written
    // caret-home line (see the divider section above for the full pin).
    const { r } = run('> /hr\n', 5, 'divider')
    assert.equal(r.ok, true)
    assert.equal(r.quotePlaceholder, true)
  }
  // FLIPPED 2026-08-31 (quote-context audit): /image and /text now work in
  // quotes — see their own sections; a quoted LIST chain still refuses.
  {
    const { r } = run('> /image\n', 8, 'image')
    assert.equal(r.ok, true)
  }
  {
    const { c, r } = run('> /text\n', 7, 'text')
    assert.equal(r.ok, true, 'quoted /text reverts: ' + (r.code || ''))
    assert.equal(r.quotePlaceholder, true)
    assert.equal(apply(c.doc, r), '> \n', 'the query line becomes the blank quote line')
  }
  refuses('text inside a quoted list item', '> - /text\n', 9, 'text')
  refuses('table inside a quoted list item', '> - /table\n', 10, 'table')
}

console.log('ok - source kernel block-insert')
