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
// its own suite is scripts/test-source-kernel-task-seed.mjs.)
refuses('divider target', '/hr\n', 3, 'divider')
refuses('image target', '/img\n', 4, 'image')
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

// Nested contexts: NOT a root child, so `topLevelNodeAt` never finds one.
refuses('inside a blockquote', '> /table\n', 8, 'table')
refuses('inside a list item', '- /table\n', 8, 'table')

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
  assert.deepEqual(Object.keys(BLOCK_INSERT_TARGETS).sort(), ['code', 'math', 'table', 'task'])
  assert.equal(BLOCK_INSERT_TARGETS.code.language, true)
  assert.equal(BLOCK_INSERT_TARGETS.table.language, false)
  // A `$$` delimiter pair has no info string, so an info string is refused
  // rather than silently dropped.
  assert.equal(BLOCK_INSERT_TARGETS.math.language, false)
  // A task item has no info string either (2026-08-20; its own suite is
  // scripts/test-source-kernel-task-seed.mjs).
  assert.equal(BLOCK_INSERT_TARGETS.task.language, false)
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

  // Non-top-level contexts stay refused, exactly like the other targets: the
  // command only ever walks the ROOT's children.
  for (const [text, label] of [['- /math\n', 'list item'], ['> /math\n', 'blockquote']]) {
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

console.log('ok - source kernel block-insert')
