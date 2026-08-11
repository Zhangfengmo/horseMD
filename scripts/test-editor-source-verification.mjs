import assert from 'node:assert/strict'
import {
  createVerifiedSourceCommitter,
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

run('ignores live list spread metadata that source reparsing normalizes', () => {
  const listDoc = (listSpread, itemSpread) => ({
    toJSON: () => ({
      type: 'doc',
      content: [{
        type: 'bullet_list',
        attrs: { spread: listSpread },
        content: [{
          type: 'list_item',
          attrs: { label: '•', listType: 'bullet', spread: itemSpread, checked: null },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }]
        }]
      }]
    })
  })
  assert.equal(verifySourceDocument({
    markdown: '- item\n',
    expectedDoc: listDoc(false, true),
    parseMarkdown: () => listDoc('false', 'false')
  }), true)
})

run('ignores table column-width layout metadata that Markdown cannot encode', () => {
  const tableDoc = (colwidth) => ({
    toJSON: () => ({
      type: 'doc',
      content: [{
        type: 'table',
        content: [{
          type: 'table_row',
          content: [{
            type: 'table_header',
            attrs: { alignment: null, colspan: 1, rowspan: 1, colwidth },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'head' }] }]
          }]
        }]
      }]
    })
  })
  assert.equal(verifySourceDocument({
    markdown: '| head |\n| --- |\n',
    expectedDoc: tableDoc([180]),
    parseMarkdown: () => tableDoc(null)
  }), true)
})

run('treats only the internal empty table-cell hardbreak as an empty paragraph', () => {
  const tableDoc = (cellContent) => ({
    toJSON: () => ({
      type: 'doc',
      content: [{
        type: 'table',
        content: [{
          type: 'table_row',
          content: [{
            type: 'table_cell',
            attrs: { alignment: null, colspan: 1, rowspan: 1, colwidth: null },
            content: [{ type: 'paragraph', ...(cellContent ? { content: cellContent } : {}) }]
          }]
        }]
      }]
    })
  })
  const internalPlaceholder = [{ type: 'hardbreak', attrs: { isInline: false } }]
  assert.equal(verifySourceDocument({
    markdown: '| <br /> |\n| --- |\n',
    expectedDoc: tableDoc(null),
    parseMarkdown: () => tableDoc(internalPlaceholder)
  }), true)
  assert.equal(verifySourceDocument({
    markdown: '| text<br>more |\n| --- |\n',
    expectedDoc: tableDoc(null),
    parseMarkdown: () => tableDoc([
      { type: 'text', text: 'text' },
      { type: 'hardbreak', attrs: { isInline: true } },
      { type: 'text', text: 'more' }
    ])
  }), false, 'user-authored table-cell breaks must remain semantic')
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

run('verified commit advances both baselines and publication atomically', () => {
  const sourceRef = { current: 'old source' }
  const canonicalRef = { current: 'old canonical' }
  const events = []
  const committer = createVerifiedSourceCommitter({
    sourceRef,
    canonicalRef,
    parseMarkdown: (markdown) => paragraphDoc(markdown.trim()),
    clearPending: () => events.push('clear'),
    publish: (markdown) => events.push(`publish:${markdown}`)
  })
  const result = committer.commit({
    candidates: ['new source\n'],
    canonical: 'canonical serializer bytes\n',
    expectedDoc: paragraphDoc('new source')
  })
  assert.deepEqual(result, { ok: true, markdown: 'new source\n' })
  assert.equal(sourceRef.current, 'new source\n')
  assert.equal(canonicalRef.current, 'canonical serializer bytes\n')
  assert.deepEqual(events, ['clear', 'publish:new source\n'])
})

run('failed commit leaves baselines pending state and publication untouched', () => {
  const sourceRef = { current: 'trusted source' }
  const canonicalRef = { current: 'trusted canonical' }
  const events = []
  const committer = createVerifiedSourceCommitter({
    sourceRef,
    canonicalRef,
    parseMarkdown: () => headingDoc('wrong'),
    clearPending: () => events.push('clear'),
    publish: () => events.push('publish')
  })
  assert.deepEqual(committer.commit({
    candidates: ['wrong'],
    canonical: 'new canonical',
    expectedDoc: paragraphDoc('expected')
  }), { ok: false, markdown: null })
  assert.equal(sourceRef.current, 'trusted source')
  assert.equal(canonicalRef.current, 'trusted canonical')
  assert.deepEqual(events, [])
})

run('large canonical-equality commits still reject an unverified source', () => {
  const largeCandidate = 'x'.repeat(120001)
  const sourceRef = { current: 'trusted source' }
  const canonicalRef = { current: 'same canonical' }
  let cleared = false
  const committer = createVerifiedSourceCommitter({
    sourceRef,
    canonicalRef,
    parseMarkdown: () => headingDoc('wrong'),
    clearPending: () => { cleared = true }
  })
  assert.deepEqual(committer.commit({
    candidates: [largeCandidate],
    canonical: 'same canonical',
    expectedDoc: paragraphDoc('expected'),
    shouldPublish: false
  }), { ok: false, markdown: null })
  assert.equal(sourceRef.current, 'trusted source')
  assert.equal(canonicalRef.current, 'same canonical')
  assert.equal(cleared, false)
})

run('durability commit can advance verified baselines without publishing twice', () => {
  const sourceRef = { current: 'old' }
  const canonicalRef = { current: 'old' }
  const events = []
  const committer = createVerifiedSourceCommitter({
    sourceRef,
    canonicalRef,
    parseMarkdown: (markdown) => paragraphDoc(markdown),
    clearPending: () => events.push('clear'),
    publish: () => events.push('publish')
  })
  const result = committer.commit({
    candidates: ['current'],
    canonical: 'current canonical',
    expectedDoc: paragraphDoc('current'),
    shouldPublish: false
  })
  assert.deepEqual(result, { ok: true, markdown: 'current' })
  assert.deepEqual(events, ['clear'])
})

console.log('\neditor source verification: all cases passed')
