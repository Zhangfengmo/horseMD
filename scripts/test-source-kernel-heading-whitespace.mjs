// TDD evidence + regression lock for
// src/renderer/src/lib/source-kernel/commands/heading-whitespace.js.
//
// THE BUG THIS FILE PINS. In kernel mode, Tab and Space at the start of a
// heading did nothing visible ("为啥标题前面无法使用 tab 或者空格"). Measured on
// the built app before the fix (scripts/probe, 2026-08-18):
//   * Tab  -> committed a LITERAL '\t' at the heading's content start, i.e.
//             '## 标题乙' became '## \t标题乙' on disk while the view never
//             changed. No toast, no diagnostic — a silently dead byte.
//   * Space -> committed a LITERAL ' ', '# 标题甲' -> '#  标题甲', then the
//             kernel's own projection check fired `projection-mismatch` and
//             repaired the VIEW back. Same dead byte, plus repair churn.
// Both because CommonMark eats the whole ASCII spacing run between the ATX
// marker and the content: that offset cannot hold a literal space or tab.
//
// WHAT IS WRITTEN INSTEAD (2026-08-18, second iteration). The first fix wrote a
// character REFERENCE (`&nbsp;` / `&#x9;`), matching legacy's bytes. The user
// rejected it on sight in source mode — 「源码模式里，不接受这个写法」,
// 「就是空白，类似于在源码中也是空格，tab 可能是两个」 — so the source now holds
// REAL whitespace characters: U+00A0 (the one whitespace character CommonMark
// does not strip here), ONE for a Space and TWO for a Tab.
//
// Legacy keeps writing the entity spelling and its own regressions
// (scripts/test-heading-leading-tab-source-ui.mjs,
// scripts/test-scratch-heading-leading-whitespace-ui.mjs) still assert it —
// correctly, for legacy. Both spellings decode to the SAME character; the modes
// now differ only in how they spell it, which is accepted because legacy is
// scheduled for removal.
import assert from 'node:assert/strict'
import { insertHeadingLeadingWhitespace, HEADING_LEADING_WHITESPACE_TEXT }
  from '../src/renderer/src/lib/source-kernel/commands/heading-whitespace.js'
import { applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { parseKernelMarkdown } from '../src/renderer/src/lib/source-kernel/syntax-index.js'

const NBSP = '\u00A0'

assert.equal(HEADING_LEADING_WHITESPACE_TEXT[' '], NBSP, 'a Space is ONE no-break space')
assert.equal(HEADING_LEADING_WHITESPACE_TEXT['\t'], NBSP + NBSP, 'a Tab is TWO')

const doc = (text) => ({ text, revision: 7 })

// Apply the command and return the committed bytes, so every expectation below
// is stated as a FILE, not as a transaction shape.
function commit(text, offset, character) {
  const routed = insertHeadingLeadingWhitespace({ doc: doc(text), offset, character })
  if (!routed.ok) return { refused: routed.code }
  assert.equal(routed.transaction.baseRevision, 7, 'transaction must carry the doc revision')
  const applied = applySourceTransaction(doc(text), routed.transaction)
  assert.ok(applied.ok, `applySourceTransaction refused: ${applied.code}`)
  return { bytes: applied.doc.text, caret: applied.selection.anchor }
}

// Decoded heading text of the FIRST heading in a document — the evidence that
// the entity really is content and not syntax.
function firstHeadingText(text) {
  const tree = parseKernelMarkdown(text)
  let found = null
  const walk = (node) => {
    if (found) return
    if (node?.type === 'heading') {
      const out = []
      const inner = (n) => {
        if (typeof n?.value === 'string') out.push(n.value)
        for (const child of n?.children || []) inner(child)
      }
      for (const child of node.children || []) inner(child)
      found = out.join('')
      return
    }
    for (const child of node?.children || []) walk(child)
  }
  walk(tree)
  return found
}

// ---------------------------------------------------------------------------
// 1) The committed bytes: real whitespace, never markup.
// ---------------------------------------------------------------------------
// Kernel mode reaches an EMPTY heading through its ATX pairing, which is only
// offered when the marker carries real spacing ('## ', not '##' — see
// editor-kernel-projection-map.js `emptyAtxHeadingContentStart`).
assert.deepEqual(
  commit('# 一级标题\n\n## \n', 11, '\t'),
  { bytes: '# 一级标题\n\n## ' + NBSP + NBSP + '\n', caret: 13 },
  'Tab in an empty h2 must commit two no-break spaces'
)
assert.deepEqual(commit('# \n', 2, '\t'), { bytes: '# ' + NBSP + NBSP + '\n', caret: 4 },
  'Tab in the empty H1 scaffold')
assert.deepEqual(commit('# \n', 2, ' '), { bytes: '# ' + NBSP + '\n', caret: 3 },
  'Space in the empty H1 scaffold')
assert.deepEqual(commit('# 标题\n', 2, '\t'), { bytes: '# ' + NBSP + NBSP + '标题\n', caret: 4 },
  'Tab before existing heading text')
assert.deepEqual(commit('# 标题\n', 2, ' '), { bytes: '# ' + NBSP + '标题\n', caret: 3 },
  'Space before existing heading text')

// NOT AN ENTITY. The whole reason for this iteration: nothing resembling markup
// may appear in the source.
for (const bytes of [
  commit('# 标题\n', 2, ' ').bytes,
  commit('# 标题\n', 2, '\t').bytes
]) {
  assert.ok(!/&[#a-zA-Z0-9]+;/.test(bytes),
    `the source must contain whitespace, not a character reference — got ${JSON.stringify(bytes)}`)
}

// The character is CONTENT after the reparse — the other half of the point.
assert.equal(firstHeadingText('# ' + NBSP + NBSP + '标题\n'), NBSP + NBSP + '标题')
assert.equal(firstHeadingText('# ' + NBSP + '标题\n'), NBSP + '标题')
assert.equal(firstHeadingText('# ' + NBSP + NBSP + '\n'), NBSP + NBSP)
assert.equal(firstHeadingText('# ' + NBSP + '\n'), NBSP)

// The literal ASCII byte the kernel used to commit is provably lost — this is
// the bug, stated as an assertion rather than as prose.
assert.equal(firstHeadingText('#  标题\n'), '标题',
  'a literal space after the ATX marker is stripped by the parser')
assert.equal(firstHeadingText('# \t标题\n'), '标题',
  'a literal tab after the ATX marker is stripped by the parser')

// ---------------------------------------------------------------------------
// 2) Every heading level, and a heading nested in a blockquote.
// ---------------------------------------------------------------------------
for (let level = 1; level <= 6; level += 1) {
  const marker = '#'.repeat(level)
  assert.deepEqual(
    commit(`${marker} T\n`, level + 1, ' '),
    { bytes: `${marker} ${NBSP}T\n`, caret: level + 2 },
    `h${level} leading space must commit one no-break space`
  )
}
assert.deepEqual(commit('> ## T\n', 5, '\t'), { bytes: '> ## ' + NBSP + NBSP + 'T\n', caret: 7 },
  'a quoted heading is still an ATX heading')

// ---------------------------------------------------------------------------
// 3) SECOND and THIRD leading whitespace characters — the shape the report's
//    "press it twice" follow-up produces. Each press is again at the content
//    start, so they chain.
// ---------------------------------------------------------------------------
assert.deepEqual(commit('# ' + NBSP + '标题\n', 2, ' '),
  { bytes: '# ' + NBSP + NBSP + '标题\n', caret: 3 },
  'a second leading space must commit a second no-break space')
assert.deepEqual(commit('# ' + NBSP + NBSP + '标题\n', 2, '\t'),
  { bytes: '# ' + NBSP + NBSP + NBSP + NBSP + '标题\n', caret: 4 },
  'a third press must commit its own characters')
assert.equal(firstHeadingText('# ' + NBSP.repeat(4) + '标题\n'), NBSP.repeat(4) + '标题')

// A whitespace character typed AFTER an existing leading no-break space is not
// at the content start any more, so it is not this command's shape at all — the
// ordinary character path already commits a literal byte correctly there.
assert.deepEqual(insertHeadingLeadingWhitespace({ doc: doc('# ' + NBSP + '标题\n'), offset: 3, character: ' ' }),
  { ok: false, code: 'not-structural' },
  'the position after an existing leading no-break space is not this command\'s shape')
assert.equal(firstHeadingText('# ' + NBSP + ' 标题\n'), NBSP + ' 标题',
  'a literal space that is not the first content byte survives the reparse')

// ---------------------------------------------------------------------------
// 4) Marker-first headings: the content start sits BEFORE an inline mark's own
//    delimiter, and the characters must land outside it.
// ---------------------------------------------------------------------------
assert.deepEqual(commit('## *a*\n', 3, '\t'), { bytes: '## ' + NBSP + NBSP + '*a*\n', caret: 5 },
  'the run must land before an opening emphasis delimiter, not inside it')
assert.deepEqual(commit('## `code`\n', 3, ' '), { bytes: '## ' + NBSP + '`code`\n', caret: 4 },
  'the run must land before an inline-code span')

// ---------------------------------------------------------------------------
// 5) REFUSALS — `not-structural` (caller falls through, nothing changed) vs
//    `unsupported-structure` (caller must refuse loudly).
// ---------------------------------------------------------------------------
const refusal = (text, offset, character) =>
  insertHeadingLeadingWhitespace({ doc: doc(text), offset, character })

// Not a heading at all.
assert.deepEqual(refusal('段落。\n', 0, ' '), { ok: false, code: 'not-structural' })
// A paragraph's start is NOT this command's shape.
assert.deepEqual(refusal('# T\n\n段落。\n', 5, ' '), { ok: false, code: 'not-structural' })
// A list item's text start is NOT this command's shape.
assert.deepEqual(refusal('- item\n', 2, ' '), { ok: false, code: 'not-structural' })
assert.deepEqual(refusal('- item\n', 2, '\t'), { ok: false, code: 'not-structural' })
// A heading's END is not the content start (it is commands/trailing-whitespace.js).
assert.deepEqual(refusal('## Title\n', 8, ' '), { ok: false, code: 'not-structural' })
assert.deepEqual(refusal('## Title\n', 5, ' '), { ok: false, code: 'not-structural' })
// A bare '##' has no content position: writing anything there makes the line a
// paragraph, so this is deliberately not claimed.
assert.deepEqual(refusal('# T\n\n##\n', 7, '\t'), { ok: false, code: 'not-structural' })
// Setext headings have no ATX opening.
assert.deepEqual(refusal('Title\n=====\n', 0, ' '), { ok: false, code: 'not-structural' })
// Only Space and Tab.
for (const character of [NBSP, 'x', '\n', '\r', '', undefined, null]) {
  assert.deepEqual(refusal('# T\n', 2, character), { ok: false, code: 'not-structural' },
    `character ${JSON.stringify(character)} must not be claimed`)
}
// Malformed input.
assert.deepEqual(refusal('# T\n', 2.5, ' '), { ok: false, code: 'not-structural' })
assert.deepEqual(insertHeadingLeadingWhitespace({ doc: { text: '# T\n' }, offset: 2, character: ' ' }),
  { ok: false, code: 'not-structural' })
assert.deepEqual(insertHeadingLeadingWhitespace({ doc: null, offset: 2, character: ' ' }),
  { ok: false, code: 'not-structural' })

// A closing sequence turns the run into content the parser reads differently
// ('## ##' is an EMPTY heading; '## \u00A0##' is a heading whose text is
// NBSP + '##'), so the decoded-text proof refuses it LOUDLY — the branch that
// proves the verification is real and not decorative.
assert.deepEqual(refusal('## ##\n', 3, ' '), { ok: false, code: 'unsupported-structure' },
  'an ATX closing sequence must be refused, not silently turned into text')

// ---------------------------------------------------------------------------
// 6) CRLF. The chokepoint in markdown-document.js must still see a legal edit.
// ---------------------------------------------------------------------------
assert.deepEqual(commit('# 标题\r\n', 2, ' '), { bytes: '# ' + NBSP + '标题\r\n', caret: 3 },
  'a CRLF document must commit the same characters and keep its ending')

// ---------------------------------------------------------------------------
// 7) Idempotence of the PROOF: committing repeatedly must keep producing a
//    document whose reparse still says what the bytes say.
// ---------------------------------------------------------------------------
{
  let text = '## 标题\n\n段落。\n'
  for (const character of [' ', '\t', ' ']) {
    const result = commit(text, 3, character)
    assert.ok(result.bytes, `chained commit refused: ${result.refused}`)
    text = result.bytes
  }
  assert.equal(text, '## ' + NBSP.repeat(4) + '标题\n\n段落。\n')
  assert.equal(firstHeadingText(text), NBSP.repeat(4) + '标题')
}

console.log('PASS source-kernel heading leading whitespace: Space/Tab at an ATX heading\'s first content position commit real no-break spaces, never markup')
