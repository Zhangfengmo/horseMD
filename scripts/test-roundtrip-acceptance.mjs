// Round-trip acceptance gate (lib/markdown-preservation/roundtrip.js).
//
// The preservation heuristics prove "a mapper accepted the delta"; the gate
// proves "the mapped bytes parse to the document the editor shows". These
// cases lock the two directions:
//   1. A wrong `preserved:true` (the ordered-list Backspace corruption family
//      from docs/rich-source-sync-architecture-review.md) must be REJECTED.
//   2. Authored-spelling differences the preservation layer exists to protect
//      (`-` vs `*`, escapes, loose/tight spacing, `<br>` spellings, CRLF)
//      must PASS — the gate is semantic, not byte-level.
import { strict as assert } from 'node:assert'
import {
  preserveRichMarkdownSource
} from '../src/renderer/src/markdown-source-preservation.js'
import {
  markdownComparisonKey,
  roundTripPreserved
} from '../src/renderer/src/lib/markdown-preservation/roundtrip.js'

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}`)
    console.error(`     ${error.message}`)
  }
}

// --- 1. The documented fake-success corruption is rejected by the gate ---
check('ordered-list backspace corruption is rejected', () => {
  const source = '# T\n\n1. alpha\n2. beta\n3. gamma\n4. 下面的文字\n\nafter\n'
  const c2 = '# T\n\n1. alpha\n2. beta\n3. gamma\n4. 下面的文字\n\nafter\n'
  const c3 = '# T\n\n1. alpha\n2. beta\n3. gamma\n\n   下面的文字\n\nafter\n'
  const c4 = '# T\n\n1. alpha\n2. beta\n3. gamma下面的文字\n\nafter\n'
  const first = preserveRichMarkdownSource(source, c2, c3)
  assert.notEqual(first.preserved, false, `step1 unexpectedly fail-closed: ${first.reason}`)
  if (!roundTripPreserved(first.markdown, c3)) return // already caught at step 1
  const second = preserveRichMarkdownSource(first.markdown, c3, c4)
  if (second.preserved === false) return // fail-closed is an acceptable outcome
  assert.equal(
    roundTripPreserved(second.markdown, c4),
    second.markdown.includes('gamma下面的文字') && !/\n {3}下面的文字/.test(second.markdown),
    `gate verdict must match semantic correctness for: ${JSON.stringify(second.markdown)}`
  )
})

// --- 2. Authored spelling must pass the gate ---
check('authored dash markers vs canonical asterisks pass', () => {
  assert.ok(roundTripPreserved('- alpha\n- betaX\n', '* alpha\n* betaX\n'))
})

check('serializer escapes vs authored literals pass', () => {
  assert.ok(roundTripPreserved('www\\.example.cn 文本\n', 'www\\.example.cn 文本\n'))
  assert.ok(roundTripPreserved('1\\. 字面序号\n', '1\\. 字面序号\n'))
})

check('loose vs tight list spacing passes', () => {
  assert.ok(roundTripPreserved('- a\n- b\n', '* a\n\n* b\n'))
})

check('<br> spellings in table cells pass', () => {
  assert.ok(roundTripPreserved(
    '| a | b |\n| - | - |\n| x<br>y | z |\n',
    '| a | b |\n| - | - |\n| x<br />y | z |\n'
  ))
})

check('trailing newline drift passes', () => {
  assert.ok(roundTripPreserved('# T\n\ntext\n', '# T\n\ntext\n\n'))
})

check('standard leading-space spellings pass', () => {
  // `&nbsp;` keeps a leading visible space without a HorseMD-private byte;
  // the canonical `&#x20;` represents the same rich document.
  assert.ok(roundTripPreserved('&nbsp; 缩进文本\n', '&#x20;&#x20;缩进文本\n'))
  assert.ok(roundTripPreserved('- &nbsp;项目\n', '* &#x20;项目\n'))
})

check('display math spellings pass', () => {
  // The editor normalizes single-line `$$x^2$$` into the multi-line spelling
  // (editor-math.js normalizeDisplayMath); preservation keeps the authored
  // single-line bytes. Both are one math block.
  assert.ok(roundTripPreserved('$$x^2$$\n', '$$\nx^2\n$$\n'))
})

check('generic round-trip comparison never drops or moves table cells', () => {
  // Legal short rows are normalized by the configured editor parse adapter,
  // not by weakening this generic MDAST comparator. In particular, excess
  // non-empty cells must never be truncated to manufacture equivalence.
  assert.equal(
    roundTripPreserved('| a | b |\n| - | - |\n| c |\n', '| a | b |\n| - | - |\n| c |  |\n'),
    false
  )
  assert.equal(
    roundTripPreserved('| a | b |\n| - | - |\n| c | d | e |\n', '| a | b |\n| - | - |\n| c | d |\n'),
    false
  )
  assert.equal(
    roundTripPreserved('| a | b |\n| - | - |\n| left | right |\n', '| a | b |\n| - | - |\n| right | left |\n'),
    false
  )
})

check('generic round-trip comparison retains a sole authored table break', () => {
  // Without explicit serializer provenance, `<br />` is authored content.
  // Empty-cell placeholder cleanup happens earlier at serializer-owned call
  // sites and must not be inferred here from spelling alone.
  assert.equal(roundTripPreserved(
    '| a | <br /> |\n| - | - |\n| b | <br /> |\n',
    '| a |  |\n| - | - |\n| b |  |\n'
  ), false)
  assert.equal(roundTripPreserved(
    '| a | <br> |\n| - | - |\n| b | value |\n',
    '| a |  |\n| - | - |\n| b | value |\n'
  ), false)
  assert.equal(roundTripPreserved(
    '| a | text<br>tail |\n| - | - |\n| b | value |\n',
    '| a | texttail |\n| - | - |\n| b | value |\n'
  ), false)
})

check('whole-document paste keeps heading level (B2)', () => {
  const next = '## 微信二级标题\n\n**保留加粗正文**\n'
  const r = preserveRichMarkdownSource('# 旧标题\n\n正文\n', '# 旧标题\n\n正文\n', next)
  assert.notEqual(r.preserved, false, `unexpected fail-closed: ${r.reason}`)
  assert.ok(!r.markdown.includes('# #'), `marker token was split: ${JSON.stringify(r.markdown)}`)
  assert.ok(roundTripPreserved(r.markdown, next))
})

check('reference-style links pass', () => {
  assert.ok(roundTripPreserved(
    '看 [文档][ref] 吧\n\n[ref]: https://example.com "T"\n',
    '看 [文档](https://example.com "T") 吧\n'
  ))
  assert.ok(roundTripPreserved(
    '![图][img]\n\n[img]: ./a.png\n',
    '![图](./a.png)\n'
  ))
})

check('crepe empty-block <br /> placeholders pass', () => {
  // Milkdown serializes `- 1. x` nested rows as `* <br />` items; the
  // placeholder paragraph is not content on either side of the comparison.
  assert.ok(roundTripPreserved(
    '- 1. 管理层\n- 综合行政部\n- 3. 人力资源部\n',
    '* <br />\n\n  1. 管理层\n\n* <br />\n\n  综合行政部\n\n* <br />\n\n  3. 人力资源部\n\n'
  ))
})

check('code metacharacters in prose pass (multi-language matrix)', () => {
  // The visible map miscounts these as Markdown syntax (§5.6 of the review);
  // the gate must not: `*ptr → \*ptr` etc. are legal serializer spellings.
  assert.ok(roundTripPreserved('char *ptr 与 a * b\n', 'char \\*ptr 与 a \\* b\n'))
  assert.ok(roundTripPreserved('import * as React\n', 'import \\* as React\n'))
  assert.ok(roundTripPreserved('std::vector<int*> 容器\n', 'std::vector<int\\*> 容器\n'))
  assert.ok(roundTripPreserved('借用 &T 引用\n', '借用 \\&T 引用\n'))
  assert.ok(roundTripPreserved('_ = value\n', '\\_ = value\n'))
})

// --- 3. Real divergence is rejected ---
check('duplicated content is rejected', () => {
  assert.equal(
    roundTripPreserved(
      '1. alpha\n2. beta\n3. gamma下面的文字\n\n   下面的文字\n',
      '1. alpha\n2. beta\n3. gamma下面的文字\n'
    ),
    false
  )
})

check('dropped content is rejected', () => {
  assert.equal(roundTripPreserved('- a\n', '* a\n* b\n'), false)
})

check('strong flattened to escaped literals is rejected', () => {
  // The corruption observed on the real user file: `**}**X` written as
  // `\*\*}\*\*X` parses to literal text instead of strong — must not commit.
  assert.equal(roundTripPreserved('\\*\\*}\\*\\*X\n', '**}**&#x58;\n'), false)
})

// --- 4. Comparison key sanity ---
check('comparison key is stable across spellings', () => {
  assert.equal(
    markdownComparisonKey('- **a**\n- b\n'),
    markdownComparisonKey('* __a__\n\n* b\n')
  )
})

if (failures) {
  console.error(`\n${failures} failing case(s)`)
  process.exit(1)
}
console.log('\nround-trip acceptance: all cases passed')
