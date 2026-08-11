import assert from 'node:assert/strict'
import {
  createVerifiedSourceCommitter,
  selectVerifiedSource,
  verifySourceDocument
} from '../src/renderer/src/components/editor-source-verification.js'
import {
  areDurablyEquivalent,
  projectDurableSemantics
} from '../src/renderer/src/components/editor-durable-semantics.js'

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

const verified = (options) => verifySourceDocument(options).type

const nodeDoc = (content) => ({
  toJSON: () => ({ type: 'doc', content })
})

run('durable node contracts ignore only declared derived attrs', () => {
  const heading = (attrs) => nodeDoc([{
    type: 'heading',
    attrs,
    content: [{ type: 'text', text: 'Title' }]
  }])
  assert.equal(areDurablyEquivalent(
    heading({ level: 1, id: 'live-id' }),
    heading({ level: 1, id: 'parsed-id' })
  ), true, 'heading ids are derived')
  assert.equal(areDurablyEquivalent(
    heading({ level: 1, id: 'live-id', future: 'left' }),
    heading({ level: 1, id: 'parsed-id', future: 'right' })
  ), false, 'unknown heading attrs remain durable by default')

  const list = (spread, attrs = {}) => nodeDoc([{
    type: 'bullet_list',
    attrs: { spread, ...attrs },
    content: [{
      type: 'list_item',
      attrs: { spread, checked: null },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }]
    }]
  }])
  assert.equal(areDurablyEquivalent(list(true), list('false')), true)
  assert.equal(areDurablyEquivalent(list(true, { future: 1 }), list(false, { future: 2 })), false)
})

run('table contracts ignore colwidth but retain alignment spans and unknown attrs', () => {
  const table = (attrs) => nodeDoc([{
    type: 'table',
    content: [{
      type: 'table_row',
      content: [{
        type: 'table_cell',
        attrs,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'value' }] }]
      }]
    }]
  }])
  const base = { alignment: 'left', colspan: 1, rowspan: 1, colwidth: [120], future: 'same' }
  assert.equal(areDurablyEquivalent(table(base), table({ ...base, colwidth: null })), true)
  for (const changed of [
    { alignment: 'right' },
    { colspan: 2 },
    { rowspan: 2 },
    { future: 'changed' }
  ]) {
    assert.equal(
      areDurablyEquivalent(table(base), table({ ...base, ...changed, colwidth: [240] })),
      false,
      `${Object.keys(changed)[0]} remains durable`
    )
  }
})

run('table cell content order loss and movement remain durable', () => {
  const row = (cells) => nodeDoc([{
    type: 'table',
    content: [{
      type: 'table_row',
      content: cells.map((value) => ({
        type: 'table_cell',
        attrs: { alignment: null, colspan: 1, rowspan: 1, colwidth: null },
        content: [{
          type: 'paragraph',
          ...(value ? { content: [{ type: 'text', text: value }] } : {})
        }]
      }))
    }]
  }])
  assert.equal(areDurablyEquivalent(row(['left', 'right']), row(['right', 'left'])), false)
  assert.equal(areDurablyEquivalent(row(['left', 'right']), row(['left', ''])), false)
  assert.equal(areDurablyEquivalent(row(['left', 'right']), row(['left', 'right', 'extra'])), false)
})

run('a sole table hardbreak fails closed without explicit placeholder provenance', () => {
  const cell = (inline) => nodeDoc([{
    type: 'table',
    content: [{
      type: 'table_row',
      content: [{
        type: 'table_cell',
        attrs: { alignment: null, colspan: 1, rowspan: 1, colwidth: null },
        content: [{ type: 'paragraph', ...(inline ? { content: inline } : {}) }]
      }]
    }]
  }])
  const soleBlockBreak = [{ type: 'hardbreak', attrs: { isInline: false } }]
  const soleInlineBreak = [{ type: 'hardbreak', attrs: { isInline: true } }]
  assert.equal(areDurablyEquivalent(cell(null), cell(null)), true)
  assert.equal(areDurablyEquivalent(cell(soleBlockBreak), cell(null)), false)
  assert.equal(areDurablyEquivalent(cell(soleInlineBreak), cell(null)), false)
  const projectedBreak = projectDurableSemantics(cell(soleBlockBreak))
    .content[0].content[0].content[0].content[0].content[0]
  assert.deepEqual(projectedBreak, soleBlockBreak[0],
    'isInline:false alone cannot prove serializer-placeholder provenance')

  const provenEmptyCell = {
    emptyTableCells: [{ table: 0, row: 0, column: 0 }]
  }
  assert.equal(areDurablyEquivalent(
    cell(soleBlockBreak),
    cell(null),
    provenEmptyCell
  ), true, 'parser-owned coordinates can prove an internal empty-cell placeholder')
  assert.equal(areDurablyEquivalent(
    cell(soleBlockBreak),
    cell(null),
    { emptyTableCells: [{ table: 0, row: 0, column: 1 }] }
  ), false, 'placeholder provenance is bound to one exact cell')
})

run('accepts the configured parser document when semantics match', () => {
  const expected = headingDoc('Title', 'live-heading-id')
  const parseMarkdown = (markdown) => {
    assert.equal(markdown, '# Title\n')
    return headingDoc('Title')
  }
  assert.equal(verified({
    markdown: '# Title\n',
    expectedDoc: expected,
    parseMarkdown
  }), 'committed')
})

run('rejects a configured parser semantic mismatch', () => {
  assert.equal(verified({
    markdown: '# Title\n',
    expectedDoc: paragraphDoc('# Title'),
    parseMarkdown: () => headingDoc('Title')
  }), 'semantic-loss')
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
  assert.equal(verified({
    markdown: '- item\n',
    expectedDoc: listDoc(false, true),
    parseMarkdown: () => listDoc('false', 'false')
  }), 'committed')
})

run('normalizes the internal leading-space sentinel without hiding list content', () => {
  assert.equal(verified({
    markdown: '\u200B  indented\n',
    expectedDoc: paragraphDoc('  indented'),
    parseMarkdown: () => paragraphDoc('\u200B  indented')
  }), 'committed', 'the app-owned leading-space sentinel is not document content')

  const listDoc = (text) => ({
    toJSON: () => ({
      type: 'doc',
      content: [{
        type: 'bullet_list',
        attrs: { spread: 'false' },
        content: [{
          type: 'list_item',
          attrs: { label: '•', listType: 'bullet', spread: 'false', checked: null },
          content: [{
            type: 'paragraph',
            ...(text == null ? {} : { content: [{ type: 'text', text }] })
          }]
        }]
      }]
    })
  })
  assert.equal(verified({
    markdown: '- \u200B  \n',
    expectedDoc: listDoc('  '),
    parseMarkdown: () => listDoc('\u200B')
  }), 'committed', 'an empty list item must not fail because its internal whitespace spelling changed')
  assert.equal(verified({
    markdown: '- \u200Bwrong\n',
    expectedDoc: listDoc('expected'),
    parseMarkdown: () => listDoc('\u200Bwrong')
  }), 'semantic-loss', 'visible list-item text must still be compared')
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
  assert.equal(verified({
    markdown: '| head |\n| --- |\n',
    expectedDoc: tableDoc([180]),
    parseMarkdown: () => tableDoc(null)
  }), 'committed')
})

run('never infers empty table-cell provenance from hardbreak shape alone', () => {
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
  assert.equal(verified({
    markdown: '| <br /> |\n| --- |\n',
    expectedDoc: tableDoc(null),
    parseMarkdown: () => tableDoc(internalPlaceholder)
  }), 'semantic-loss')
  assert.equal(verified({
    markdown: '| text<br>more |\n| --- |\n',
    expectedDoc: tableDoc(null),
    parseMarkdown: () => tableDoc([
      { type: 'text', text: 'text' },
      { type: 'hardbreak', attrs: { isInline: true } },
      { type: 'text', text: 'more' }
    ])
  }), 'semantic-loss', 'user-authored table-cell breaks must remain semantic')
})

run('fails closed when the configured parser throws', () => {
  assert.equal(verified({
    markdown: 'anything',
    expectedDoc: paragraphDoc('anything'),
    parseMarkdown: () => { throw new Error('parser unavailable') }
  }), 'parser-error')
})

run('tries scratch candidates in order and returns the first verified spelling', () => {
  const expected = paragraphDoc('# title')
  const parseMarkdown = (markdown) => (
    markdown === '# title\n' ? headingDoc('title') : paragraphDoc('# title')
  )
  const selected = selectVerifiedSource({
    candidates: ['# title\n', '\\# title\n'],
    expectedDoc: expected,
    parseMarkdown
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.type, 'committed')
  assert.equal(selected.markdown, '\\# title\n')
  assert.deepEqual(selected.parsed.toJSON(), paragraphDoc('# title').toJSON())
})

run('typed candidates bind durable provenance to their own markdown', () => {
  const expected = nodeDoc([{
    type: 'table',
    content: [{
      type: 'table_row',
      content: [{
        type: 'table_cell',
        content: [{
          type: 'paragraph',
          content: [{ type: 'hardbreak', attrs: { isInline: false } }]
        }]
      }]
    }]
  }])
  const parsed = nodeDoc([{
    type: 'table',
    content: [{
      type: 'table_row',
      content: [{ type: 'table_cell', content: [{ type: 'paragraph' }] }]
    }]
  }])
  const durableContext = { emptyTableCells: [{ table: 0, row: 0, column: 0 }] }
  const withoutProvenance = selectVerifiedSource({
    candidates: ['|  |'],
    expectedDoc: expected,
    parseMarkdown: () => parsed
  })
  assert.equal(withoutProvenance.type, 'semantic-loss')
  const selected = selectVerifiedSource({
    candidates: [{ markdown: '|  |', durableContext }],
    expectedDoc: expected,
    parseMarkdown: () => parsed
  })
  assert.equal(selected.type, 'committed')
  assert.equal(selected.markdown, '|  |')
  assert.deepEqual(selected.durableContext, durableContext)
})

run('preserves an intentionally empty verified source', () => {
  const expected = { toJSON: () => ({ type: 'doc', content: [] }) }
  const selected = selectVerifiedSource({
    candidates: ['', 'fallback'],
    expectedDoc: expected,
    parseMarkdown: (markdown) => markdown === ''
      ? { toJSON: () => ({ type: 'doc', content: [] }) }
      : paragraphDoc('fallback')
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.type, 'committed')
  assert.equal(selected.markdown, '')
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
  assert.equal(result.ok, true)
  assert.equal(result.type, 'committed')
  assert.equal(result.markdown, 'new source\n')
  assert.deepEqual(result.parsed.toJSON(), paragraphDoc('new source').toJSON())
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
  const result = committer.commit({
    candidates: ['wrong'],
    canonical: 'new canonical',
    expectedDoc: paragraphDoc('expected')
  })
  assert.equal(result.ok, false)
  assert.equal(result.type, 'semantic-loss')
  assert.equal(result.markdown, null)
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
  const result = committer.commit({
    candidates: [largeCandidate],
    canonical: 'same canonical',
    expectedDoc: paragraphDoc('expected'),
    shouldPublish: false
  })
  assert.equal(result.ok, false)
  assert.equal(result.type, 'semantic-loss')
  assert.equal(result.markdown, null)
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
  assert.equal(result.ok, true)
  assert.equal(result.type, 'committed')
  assert.equal(result.markdown, 'current')
  assert.deepEqual(events, ['clear'])
})

console.log('\neditor source verification: all cases passed')
