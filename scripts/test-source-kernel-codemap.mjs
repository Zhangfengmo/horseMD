// TDD evidence + regression lock for src/renderer/src/lib/source-kernel/code-map.js
// (source-kernel Plan 3, Task 3 — 代码块 line-map).
//
// All hand-derived offsets below were checked by actually running
// buildSyntaxIndex + buildCodeMap against each fixture (see
// docs referenced by the Task 3 brief for the underlying mdast facts); the
// comments show the derivation, not a guess.
import assert from 'node:assert/strict'
import { buildSyntaxIndex } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { buildCodeMap } from '../src/renderer/src/lib/source-kernel/code-map.js'

const codeNodeOf = (text, findText = null) => {
  const idx = buildSyntaxIndex(text)
  const offset = findText ? text.indexOf(findText) : 0
  const block = idx.blockAt(offset)
  return block.node
}

console.log('--- source-kernel code map ---')

// Case 1: top-level fence, two content lines, no prefix.
// text = '```js\nab\ncd\n```\n'
// ` 0 ` 1 ` 2 j 3 s 4 \n 5 | a 6 b 7 \n 8 | c 9 d 10 \n 11 | ` 12 ` 13 ` 14 \n 15
// open fence line: "```js" [0,5) ending '\n'; fence marker offset = 0 (from
// remark) -> prefix = text.slice(0,0) = '' (top-level, no quote/indent).
// value = 'ab\ncd' (mdast strips the fence lines, keeps content verbatim).
// content line 1 "ab" starts at raw 6 (right after '```js\n'); content line 2
// "cd" starts at raw 9 (right after 'ab\n').
{
  const text = '```js\nab\ncd\n```\n'
  const node = codeNodeOf(text)
  assert.equal(node.value, 'ab\ncd')
  const map = buildCodeMap(text, node)
  assert.ok(map, 'top-level fence must map')
  assert.equal(map.visibleLength, 5)
  assert.equal(map.visibleToRaw(0), 6) // before 'a'
  assert.equal(map.visibleToRaw(1), 7) // between 'a' and 'b'
  assert.equal(map.visibleToRaw(2), 8) // after 'ab', before the linebreak
  assert.equal(map.visibleToRaw(3), 9) // after the linebreak, before 'c'
  assert.equal(map.visibleToRaw(5), 11) // after 'cd' (content end)
  assert.deepEqual(map.rawRangeForVisibleRange(2, 3), { from: 8, to: 9 }) // raw '\n', no prefix
  assert.equal(text.slice(8, 9), '\n')
}

// Case 2: blockquote-prefixed fence, two content lines.
// text = '> ```js\n> ab\n> cd\n> ```\n'
// '> ' 0-1 '```js' 2-6 \n 7 | '> ' 8-9 'ab' 10-11 \n 12 | '> ' 13-14 'cd' 15-16
// \n 17 | '> ' 18-19 '```' 20-22 \n 23
// open fence line "> ```js" [0,7) ending '\n'; fence marker offset = 2 ->
// prefix = text.slice(0,2) = '> '. Every content line must reproduce '> '
// byte-for-byte. value = 'ab\ncd'.
{
  const text = '> ```js\n> ab\n> cd\n> ```\n'
  const node = codeNodeOf(text, 'ab')
  assert.equal(node.value, 'ab\ncd')
  const map = buildCodeMap(text, node)
  assert.ok(map, 'quoted fence must map')
  assert.equal(map.visibleLength, 5)
  assert.equal(map.visibleToRaw(0), 10) // before 'a' (raw 8 '>', 9 ' ', 10 'a')
  assert.equal(map.visibleToRaw(2), 12) // after 'ab', before the linebreak
  // the linebreak's raw span covers the line ending PLUS the next content
  // line's quote prefix: '\n' (12) + '> ' (13-14) = raw [12,15).
  assert.equal(map.visibleToRaw(3), 15) // after the linebreak, before 'c'
  assert.deepEqual(map.rawRangeForVisibleRange(2, 3), { from: 12, to: 15 })
  assert.equal(text.slice(12, 15), '\n> ')
  assert.equal(map.visibleToRaw(5), 17) // after 'cd' (content end)

  // Interior-of-linebreak-span: raw 13 and 14 (the '>' and ' ' bytes inside
  // the linebreak's 3-byte raw span [12,15)) are neither a unit's rawStart
  // NOR its rawEnd — a future raw->position walker (the same convention
  // editor-kernel-projection-map.js's rawToPmPos uses for atoms/escapes)
  // must find no boundary there and fail closed, exactly like the interior
  // of a character-map.js escape/entity unit.
  const linebreakUnit = map.units.find((u) => u.kind === 'linebreak')
  assert.ok(linebreakUnit)
  assert.equal(linebreakUnit.rawStart, 12)
  assert.equal(linebreakUnit.rawEnd, 15)
  for (const interior of [13, 14]) {
    assert.equal(
      map.units.some((u) => u.rawStart === interior || u.rawEnd === interior),
      false,
      `raw ${interior} must not be any unit boundary`
    )
  }
}

// Case 3: list-item-indented fence (2-space indent), two content lines.
// text = '- x\n  ```js\n  ab\n  cd\n  ```\n'
// '- x' 0-2 \n 3 | '  ' 4-5 '```js' 6-10 \n 11 | '  ' 12-13 'ab' 14-15 \n 16
// | '  ' 17-18 'cd' 19-20 \n 21 | '  ' 22-23 '```' 24-26 \n 27
// open fence line "  ```js" [4,11) ending '\n'; fence marker offset = 6 ->
// prefix = text.slice(4,6) = '  ' (2 spaces). value = 'ab\ncd'.
{
  const text = '- x\n  ```js\n  ab\n  cd\n  ```\n'
  const node = codeNodeOf(text, 'ab')
  assert.equal(node.value, 'ab\ncd')
  const map = buildCodeMap(text, node)
  assert.ok(map, 'list-indented fence must map')
  assert.equal(map.visibleLength, 5)
  assert.equal(map.visibleToRaw(0), 14) // before 'a'
  assert.equal(map.visibleToRaw(2), 16) // after 'ab'
  assert.equal(map.visibleToRaw(3), 19) // after '\n  ' (linebreak + indent)
  assert.deepEqual(map.rawRangeForVisibleRange(2, 3), { from: 16, to: 19 })
  assert.equal(text.slice(16, 19), '\n  ')
  assert.equal(map.visibleToRaw(5), 21) // after 'cd'
}

// Case 4: nested (two-level) blockquote fence — proves the prefix derivation
// generalizes past a single '>' level, not just single-line content (a
// second content line is already covered by Case 2's single-level test).
// text = '> > ```\n> > ab\n> > ```\n'
// '> > ' 0-3 '```' 4-6 \n 7 | '> > ' 8-11 'ab' 12-13 \n 14 | ...
// open fence line "> > ```" [0,7) ending '\n'; fence marker offset = 4 ->
// prefix = '> > '. value = 'ab' (single content line, no lang - "```" bare).
{
  const text = '> > ```\n> > ab\n> > ```\n'
  const node = codeNodeOf(text, 'ab')
  assert.equal(node.value, 'ab')
  const map = buildCodeMap(text, node)
  assert.ok(map, 'nested-quote fence must map')
  assert.equal(map.visibleLength, 2)
  assert.equal(map.visibleToRaw(0), 12) // before 'a'
  assert.equal(map.visibleToRaw(2), 14) // after 'ab'
}

// Case 5: unclosed fence — no closing ``` anywhere; mdast's own position
// extends to the raw end, but buildCodeMap never needs a closing fence: it
// stops the moment `.value` is fully walked.
// text = '```js\nab\ncd\n' (identical first 12 bytes to Case 1, just without
// the trailing '```\n') -> value = 'ab\ncd', same raw offsets as Case 1.
{
  const text = '```js\nab\ncd\n'
  const node = codeNodeOf(text)
  assert.equal(node.value, 'ab\ncd')
  const map = buildCodeMap(text, node)
  assert.ok(map, 'unclosed fence must still map')
  assert.equal(map.visibleLength, 5)
  assert.equal(map.visibleToRaw(0), 6)
  assert.equal(map.visibleToRaw(5), 11)
}

// Case 6: empty block ('```\n```\n') — value '' maps its ONLY boundary
// (visible 0) to the raw offset right after the open fence line's own
// ending: '```\n' is 4 bytes [0,4), so the boundary is raw 4 (where the
// closing '```' begins).
{
  const text = '```\n```\n'
  const node = codeNodeOf(text)
  assert.equal(node.value, '')
  const map = buildCodeMap(text, node)
  assert.ok(map, 'empty fence must map')
  assert.equal(map.visibleLength, 0)
  assert.equal(map.visibleToRaw(0), 4)
  assert.deepEqual(map.rawRangeForVisibleRange(0, 0), { from: 4, to: 4 })
  assert.equal(map.visibleToRaw(1), null)
}

// Case 7: tilde fence with a meta string ('~~~js title="x"\nab\n~~~\n').
// '~~~js title="x"' 0-15 \n 15 | 'ab' 16-17 \n 18 | '~~~' 19-21 \n 22
// open fence line [0,16) (16 chars incl. the meta) ending '\n'; fence marker
// offset = 0 (top-level) -> prefix = ''. value = 'ab' (meta isn't content).
{
  const text = '~~~js title="x"\nab\n~~~\n'
  const node = codeNodeOf(text)
  assert.equal(node.value, 'ab')
  assert.equal(node.lang, 'js')
  assert.equal(node.meta, 'title="x"')
  const map = buildCodeMap(text, node)
  assert.ok(map, 'tilde fence with meta must map')
  assert.equal(map.visibleLength, 2)
  assert.equal(map.visibleToRaw(0), 16)
  assert.equal(map.visibleToRaw(2), 18)
}

// Case 8: CRLF document — remark does NOT normalize a code node's line
// endings (unlike prose text nodes), so `.value` literally embeds '\r\n' as
// two separate JS string units. text = '```js\r\nab\r\ncd\r\n```\r\n'
// '```js' 0-4 \r\n 5-6 | 'ab' 7-8 \r\n 9-10 | 'cd' 11-12 \r\n 13-14 | '```'
// 15-17 \r\n 18-19. open fence line [0,5) ending '\r\n'; prefix = ''.
// value = 'ab\r\ncd' (6 JS chars: a,b,\r,\n,c,d) -> visibleLength 5 (the
// \r\n pair collapses to ONE linebreak unit, width 1, raw span [9,11) — 2
// raw bytes for 1 visible position, same "front unit's end" convention.)
{
  const text = '```js\r\nab\r\ncd\r\n```\r\n'
  const node = codeNodeOf(text)
  assert.equal(node.value, 'ab\r\ncd')
  assert.equal(node.value.length, 6)
  const map = buildCodeMap(text, node)
  assert.ok(map, 'CRLF fence must map')
  assert.equal(map.visibleLength, 5)
  assert.equal(map.visibleToRaw(0), 7) // before 'a'
  assert.equal(map.visibleToRaw(2), 9) // after 'ab', before the CRLF linebreak
  assert.equal(map.visibleToRaw(3), 11) // after the CRLF linebreak, before 'c'
  assert.deepEqual(map.rawRangeForVisibleRange(2, 3), { from: 9, to: 11 })
  assert.equal(text.slice(9, 11), '\r\n')
  assert.equal(map.visibleToRaw(5), 13) // after 'cd' (content end)

  // Interior-of-multi-byte-linebreak-span (the CRLF pair itself): raw 10 (the
  // '\n' half of the '\r\n' pair) sits strictly inside [9,11) and must not be
  // any unit's rawStart/rawEnd.
  const linebreakUnit = map.units.find((u) => u.kind === 'linebreak')
  assert.equal(linebreakUnit.rawStart, 9)
  assert.equal(linebreakUnit.rawEnd, 11)
  assert.equal(map.units.some((u) => u.rawStart === 10 || u.rawEnd === 10), false)
}

// Case 9: less-indented content line -> null (fail-closed). A blockquote's
// post-'>' space is OPTIONAL per CommonMark (QUOTE_PREFIX's `[ \t]?`), so
// remark happily parses '>cd' (no space) as a continuation of the SAME fence
// as '> ab' (missing only the trailing space) — but that line does NOT
// reproduce the derived prefix '> ' byte-for-byte, so buildCodeMap must
// refuse to claim a mapping for it rather than silently modeling remark's
// leniency.
// text = '> ```\n> ab\n>cd\n> ```\n'
// '> ' 0-1 '```' 2-4 \n 5 | '> ' 6-7 'ab' 8-9 \n 10 | '>' 11 'cd' 12-13 \n 14
// | '> ' 15-16 '```' 17-19 \n 20
// (remark still parses ONE code node spanning all four lines, value 'ab\ncd'
// — proving this is genuinely the leniency case, not an unclosed fence.)
{
  const text = '> ```\n> ab\n>cd\n> ```\n'
  const node = codeNodeOf(text, 'ab')
  assert.equal(node.value, 'ab\ncd', 'remark itself tolerates the missing space')
  const map = buildCodeMap(text, node)
  assert.equal(map, null, 'buildCodeMap must fail closed on the under-prefixed content line')
}

console.log('PASS source-kernel code map')
