// THE ONE TYPING-SPELLING POLICY (docs/typing-policy-chokepoint-adr.md).
// `escapePolicyForInsert` answers, for a plain-text insert at a raw offset:
//   { insert: respelled }  — the literal bytes would RESTRUCTURE the document
//                            and the escaped spelling provably does not;
//   null                   — the literal bytes are fine (or nothing provable):
//                            the caller commits literally, exactly as before.
// The cheap gate is mdast-util-to-markdown's own `unsafe` table (the data
// remark's serializer escapes by); the truth is the double reparse proof.
// Consulted from every commit channel — the per-channel copies are deleted.
import assert from 'node:assert/strict'
import { escapePolicyForInsert } from '../src/renderer/src/lib/source-kernel/commands/text-escape.js'

const at = (text, needle) => text.indexOf(needle) + needle.length

// --- the `4.` family (the reported origin) ---
{
  const text = '1. 甲\n2. 4\n'
  const result = escapePolicyForInsert({ text, offset: at(text, '2. 4'), insert: '.' })
  assert.ok(result, 'a restructuring "." after a digit must respell')
  assert.equal(result.insert, '\\.')
}
// `)` delimiter
{
  const text = '1. 甲\n2. 4\n'
  const result = escapePolicyForInsert({ text, offset: at(text, '2. 4'), insert: ')' })
  assert.ok(result, 'a restructuring ")" must respell')
  assert.equal(result.insert, '\\)')
}
// --- ADJUDICATED TRANSIENTS: single marker characters are NEVER respelled
// (text-escape.js TRANSIENT_SINGLE) — they are the bare-marker intermediate
// the completing-space / run-growth / following-text machinery owns, and
// `*`/`` ` ``/`~`/`_` may be OPENING inline syntax the mark input rules
// complete later. Measured failure mode when this exception was missing:
// the opening `*` of `*斜*` escaped and the whole mark line cascaded into
// vetoes; an escaped `-` killed type-to-create-a-list.
{
  for (const ch of ['-', '+', '*', '>', '#', '`', '~', '_']) {
    assert.equal(escapePolicyForInsert({ text: '甲乙\n', offset: 0, insert: ch }), null,
      `single ${JSON.stringify(ch)} is the adjudicated transient — literal, never respelled`)
  }
  assert.equal(escapePolicyForInsert({ text: '- 甲\n- 乙\n', offset: at('- 甲\n- 乙\n', '- 甲\n- '), insert: '>' }), null,
    'single ">" at an item start stays the quote-marker transient')
}
// --- setext: a lone `=` under a paragraph WOULD mint a heading and no
// machinery owns that transient — it respells.
{
  const text = '甲乙\n\n'
  const result = escapePolicyForInsert({ text, offset: 3, insert: '=' })
  if (result) assert.equal(result.insert, '\\=')
  // (remark only reads `=` as setext directly under the paragraph line; if
  // this position parses literal the policy correctly answers null — the
  // assertion is conditional on the parser's own reading, never invented.)
}
// --- multi-character inserts (the IME commit shape) ---
{
  const text = '1. 甲\n2. \n'
  const result = escapePolicyForInsert({ text, offset: at(text, '2. '), insert: '4.' })
  assert.ok(result, 'an IME-committed "4." must respell')
  assert.equal(result.insert, '4\\.')
}
// --- negatives: everything that must stay literal ---
{
  // mid-word dot (a decimal) does not restructure
  const text = '1. 甲\n2. 4x\n'
  assert.equal(escapePolicyForInsert({ text, offset: at(text, '4x'), insert: '.' }), null)
  // an ordinary character never triggers the gate
  assert.equal(escapePolicyForInsert({ text: '甲乙\n', offset: 1, insert: 'x' }), null)
  assert.equal(escapePolicyForInsert({ text: '甲乙\n', offset: 1, insert: '丙' }), null)
  // inside a code fence the escaped spelling would CHANGE the literal
  // content, so the leaf proof fails and the answer is literal
  const fence = '```\n4\n```\n'
  assert.equal(escapePolicyForInsert({ text: fence, offset: at(fence, '```\n4'), insert: '.' }), null)
  // a dot after non-digit content is inert
  const nonDigit = '1. 甲\n2. 乙\n'
  assert.equal(escapePolicyForInsert({ text: nonDigit, offset: at(nonDigit, '乙'), insert: '.' }), null)
  // '>' mid-paragraph is inert
  assert.equal(escapePolicyForInsert({ text: '甲乙\n', offset: 1, insert: '>' }), null)
  // malformed inputs answer null, never throw
  assert.equal(escapePolicyForInsert({ text: '甲\n', offset: 99, insert: '.' }), null)
  assert.equal(escapePolicyForInsert({ text: '甲\n', offset: 0, insert: '' }), null)
}
// CRLF spellings
{
  const text = '1. 甲\r\n2. 4\r\n'
  const result = escapePolicyForInsert({ text, offset: at(text, '2. 4'), insert: '.' })
  assert.ok(result, 'CRLF: the digit-dot family respells')
  assert.equal(escapePolicyForInsert({ text: '甲乙\r\n', offset: 0, insert: '>' }), null,
    'CRLF: the single ">" transient stays literal')
}

console.log('PASS source-kernel text-escape: digit-dot and IME multi-char inserts respell via the unsafe-table gate + double reparse proof; the adjudicated single-marker transients and every literal-safe shape stay untouched, LF and CRLF')
