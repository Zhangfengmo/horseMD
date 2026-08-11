import assert from 'node:assert/strict'
import {
  selectVerifiedSource,
  verifySourceDocument
} from '../src/renderer/src/components/editor-source-verification.js'

const paragraphDoc = (text) => ({
  toJSON: () => ({
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: text ? [{ type: 'text', text }] : undefined
    }]
  })
})

const headingDoc = (text, id = null) => ({
  toJSON: () => ({
    type: 'doc',
    content: [{
      type: 'heading',
      attrs: { level: 1, ...(id ? { id } : {}) },
      content: [{ type: 'text', text }]
    }]
  })
})

const run = (name, fn) => {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    throw error
  }
}

run('accepts the configured parser document when semantics match', () => {
  const expected = headingDoc('Title', 'live-heading-id')
  const parseMarkdown = (markdown) => {
    assert.equal(markdown, '# Title\n')
    return headingDoc('Title')
  }
  assert.equal(verifySourceDocument({
    markdown: '# Title\n',
    expectedDoc: expected,
    parseMarkdown
  }), true)
})

run('rejects a configured parser semantic mismatch', () => {
  assert.equal(verifySourceDocument({
    markdown: '# Title\n',
    expectedDoc: paragraphDoc('# Title'),
    parseMarkdown: () => headingDoc('Title')
  }), false)
})

run('fails closed when the configured parser throws', () => {
  assert.equal(verifySourceDocument({
    markdown: 'anything',
    expectedDoc: paragraphDoc('anything'),
    parseMarkdown: () => { throw new Error('parser unavailable') }
  }), false)
})

run('tries scratch candidates in order and returns the first verified spelling', () => {
  const expected = paragraphDoc('# title')
  const parseMarkdown = (markdown) => (
    markdown === '# title\n' ? headingDoc('title') : paragraphDoc('# title')
  )
  assert.equal(selectVerifiedSource({
    candidates: ['# title\n', '\\# title\n'],
    expectedDoc: expected,
    parseMarkdown
  }), '\\# title\n')
})

run('preserves an intentionally empty verified source', () => {
  const expected = { toJSON: () => ({ type: 'doc', content: [] }) }
  assert.equal(selectVerifiedSource({
    candidates: ['', 'fallback'],
    expectedDoc: expected,
    parseMarkdown: (markdown) => markdown === ''
      ? { toJSON: () => ({ type: 'doc', content: [] }) }
      : paragraphDoc('fallback')
  }), '')
})

console.log('\neditor source verification: all cases passed')

