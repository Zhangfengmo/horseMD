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
// Both because CommonMark eats the whole spacing run between the ATX marker
// and the content: that offset cannot hold a literal whitespace byte.
//
// Every expected byte string below is the LEGACY writer's output for the same
// shape — see scripts/test-heading-leading-tab-source-ui.mjs ('## &#x9;') and
// scripts/test-scratch-heading-leading-whitespace-ui.mjs ('# &#x9;' /
// '# &nbsp;' / '# &#x9;标题' / '# &nbsp;标题'). Byte-exact agreement between
// the two modes is the contract, so those strings are reproduced here rather
// than re-derived.
import assert from 'node:assert/strict'
import { insertHeadingLeadingWhitespace, HEADING_LEADING_WHITESPACE_ENTITY }
  from '../src/renderer/src/lib/source-kernel/commands/heading-whitespace.js'
import { applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { parseKernelMarkdown } from '../src/renderer/src/lib/source-kernel/syntax-index.js'

const NBSP = '\u00A0'

assert.equal(HEADING_LEADING_WHITESPACE_ENTITY[' '], '&nbsp;')
assert.equal(HEADING_LEADING_WHITESPACE_ENTITY['\t'], '&#x9;')

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
// 1) The two legacy fixtures, byte for byte.
// ---------------------------------------------------------------------------
// scripts/test-heading-leading-tab-source-ui.mjs saves '## &#x9;\n'. Kernel
// mode reaches that heading through its EMPTY-ATX-heading pairing, which is
// only offered when the marker carries real spacing ('## ', not '##' — see
// editor-kernel-projection-map.js `emptyAtxHeadingContentStart`), so the
// kernel fixture is the spaced form. The committed bytes are identical.
assert.deepEqual(
  commit('# 一级标题\n\n## \n', 11, '\t'),
  { bytes: '# 一级标题\n\n## &#x9;\n', caret: 16 },
  'Tab in an empty h2 must commit the legacy `&#x9;` spelling'
)
assert.equal(firstHeadingText('# 一级标题\n\n## &#x9;\n'), '一级标题')

// scripts/test-scratch-heading-leading-whitespace-ui.mjs, all four cases.
assert.deepEqual(commit('# \n', 2, '\t'), { bytes: '# &#x9;\n', caret: 7 },
  'Tab in the empty H1 scaffold must commit `# &#x9;`')
assert.deepEqual(commit('# \n', 2, ' '), { bytes: '# &nbsp;\n', caret: 8 },
  'Space in the empty H1 scaffold must commit `# &nbsp;`')
assert.deepEqual(commit('# 标题\n', 2, '\t'), { bytes: '# &#x9;标题\n', caret: 7 },
  'Tab before existing heading text must commit `# &#x9;标题`')
assert.deepEqual(commit('# 标题\n', 2, ' '), { bytes: '# &nbsp;标题\n', caret: 8 },
  'Space before existing heading text must commit `# &nbsp;标题`')

// The entity is CONTENT after the reparse — the whole point.
assert.equal(firstHeadingText('# &#x9;标题\n'), '\t标题')
assert.equal(firstHeadingText('# &nbsp;标题\n'), NBSP + '标题')
assert.equal(firstHeadingText('# &#x9;\n'), '\t')
assert.equal(firstHeadingText('# &nbsp;\n'), NBSP)

// The literal byte the kernel used to commit is provably lost — this is the
// bug, stated as an assertion rather than as prose.
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
    { bytes: `${marker} &nbsp;T\n`, caret: level + 7 },
    `h${level} leading space must commit the entity`
  )
}
assert.deepEqual(commit('> ## T\n', 5, '\t'), { bytes: '> ## &#x9;T\n', caret: 10 },
  'a quoted heading is still an ATX heading')

// ---------------------------------------------------------------------------
// 3) SECOND and THIRD leading whitespace characters — the shape the report's
//    "press it twice" follow-up produces. Each press is again at the content
//    start, so each commits its own entity and they chain.
// ---------------------------------------------------------------------------
assert.deepEqual(commit('# &nbsp;标题\n', 2, ' '), { bytes: '# &nbsp;&nbsp;标题\n', caret: 8 },
  'a second leading space must commit a second entity')
assert.deepEqual(commit('# &nbsp;&nbsp;标题\n', 2, '\t'), { bytes: '# &#x9;&nbsp;&nbsp;标题\n', caret: 7 },
  'a third leading whitespace character must commit its own entity')
assert.equal(firstHeadingText('# &#x9;&nbsp;&nbsp;标题\n'), '\t' + NBSP + NBSP + '标题')

// A whitespace character typed AFTER an existing leading entity is NOT at the
// content start any more, so it is not this command's shape at all — the
// ordinary character path already commits a literal byte correctly there
// (`# &nbsp; 标题` decodes to NBSP + ' ' + '标题').
assert.deepEqual(insertHeadingLeadingWhitespace({ doc: doc('# &nbsp;标题\n'), offset: 8, character: ' ' }),
  { ok: false, code: 'not-structural' },
  'the position after an existing leading entity is not this command\'s shape')
assert.equal(firstHeadingText('# &nbsp; 标题\n'), NBSP + ' 标题',
  'a literal space that is not the first content byte survives the reparse')

// ---------------------------------------------------------------------------
// 4) Marker-first headings: the content start sits BEFORE an inline mark's own
//    delimiter, and the entity must land outside it.
// ---------------------------------------------------------------------------
assert.deepEqual(commit('## *a*\n', 3, '\t'), { bytes: '## &#x9;*a*\n', caret: 8 },
  'the entity must land before an opening emphasis delimiter, not inside it')
assert.deepEqual(commit('## `code`\n', 3, ' '), { bytes: '## &nbsp;`code`\n', caret: 9 },
  'the entity must land before an inline-code span')

// ---------------------------------------------------------------------------
// 5) REFUSALS — `not-structural` (caller falls through, nothing changed) vs
//    `unsupported-structure` (caller must refuse loudly).
// ---------------------------------------------------------------------------
const refusal = (text, offset, character) =>
  insertHeadingLeadingWhitespace({ doc: doc(text), offset, character })

// Not a heading at all.
assert.deepEqual(refusal('段落。\n', 0, ' '), { ok: false, code: 'not-structural' })
// A paragraph's start is NOT this command's shape (a leading space there is a
// different, unsolved problem — the kernel refuses/strips it elsewhere).
assert.deepEqual(refusal('# T\n\n段落。\n', 5, ' '), { ok: false, code: 'not-structural' })
// A list item's text start is NOT this command's shape.
assert.deepEqual(refusal('- item\n', 2, ' '), { ok: false, code: 'not-structural' })
assert.deepEqual(refusal('- item\n', 2, '\t'), { ok: false, code: 'not-structural' })
// A heading's END is not the content start.
assert.deepEqual(refusal('## Title\n', 8, ' '), { ok: false, code: 'not-structural' })
assert.deepEqual(refusal('## Title\n', 5, ' '), { ok: false, code: 'not-structural' })
// A bare '##' has no content position: writing anything there makes the line a
// paragraph, so this is deliberately not claimed.
assert.deepEqual(refusal('# T\n\n##\n', 7, '\t'), { ok: false, code: 'not-structural' })
// Setext headings have no ATX opening.
assert.deepEqual(refusal('Title\n=====\n', 0, ' '), { ok: false, code: 'not-structural' })
// Only Space and Tab. Anything else (including NBSP itself, a newline, or a
// printable character) is somebody else's path.
for (const character of ['\u00A0', 'x', '\n', '\r', '', undefined, null]) {
  assert.deepEqual(refusal('# T\n', 2, character), { ok: false, code: 'not-structural' },
    `character ${JSON.stringify(character)} must not be claimed`)
}
// Malformed input.
assert.deepEqual(refusal('# T\n', 2.5, ' '), { ok: false, code: 'not-structural' })
assert.deepEqual(insertHeadingLeadingWhitespace({ doc: { text: '# T\n' }, offset: 2, character: ' ' }),
  { ok: false, code: 'not-structural' })
assert.deepEqual(insertHeadingLeadingWhitespace({ doc: null, offset: 2, character: ' ' }),
  { ok: false, code: 'not-structural' })

// A closing sequence turns the entity into content the parser reads
// differently ('## ##' is an EMPTY heading; '## &nbsp;##' is a heading whose
// text is NBSP + '##'), so the decoded-text proof refuses it LOUDLY — this is
// the branch that proves the verification is real and not decorative.
assert.deepEqual(refusal('## ##\n', 3, ' '), { ok: false, code: 'unsupported-structure' },
  'an ATX closing sequence must be refused, not silently turned into text')

// ---------------------------------------------------------------------------
// 6) CRLF. The chokepoint in markdown-document.js must still see a legal edit,
//    and the entity must not disturb the line ending.
// ---------------------------------------------------------------------------
assert.deepEqual(commit('# 标题\r\n', 2, ' '), { bytes: '# &nbsp;标题\r\n', caret: 8 },
  'a CRLF document must commit the same entity and keep its ending')

// ---------------------------------------------------------------------------
// 7) Idempotence of the PROOF: committing twice in a row must keep producing
//    a document whose reparse still says what the bytes say.
// ---------------------------------------------------------------------------
{
  let text = '## 标题\n\n段落。\n'
  for (const character of [' ', '\t', ' ']) {
    const result = commit(text, 3, character)
    assert.ok(result.bytes, `chained commit refused: ${result.refused}`)
    text = result.bytes
  }
  assert.equal(text, '## &nbsp;&#x9;&nbsp;标题\n\n段落。\n')
  assert.equal(firstHeadingText(text), NBSP + '\t' + NBSP + '标题')
}

console.log('PASS source-kernel heading leading whitespace: Space/Tab at an ATX heading\'s first content position commit the legacy entity bytes')
