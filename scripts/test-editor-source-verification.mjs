import assert from 'node:assert/strict'
import {
  canonicalSourceFallback,
  rebuildSourceCandidates,
  selectVerifiedSource,
  verifySourceDocument
} from '../src/renderer/src/components/editor-source-verification.js'
import { generatedScratchMarkdown } from '../src/renderer/src/markdown-source-preservation.js'
import { tableDurableContext } from '../src/renderer/src/lib/markdown-preservation/tables.js'
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

  const listWithEmptyParagraph = (paragraphAttrs, text = null) => nodeDoc([{
    type: 'bullet_list',
    content: [{
      type: 'list_item',
      content: [{
        type: 'paragraph',
        attrs: paragraphAttrs,
        ...(text == null ? {} : { content: [{ type: 'text', text }] })
      }]
    }]
  }])
  assert.equal(areDurablyEquivalent(
    listWithEmptyParagraph({ future: 'same' }, '   '),
    listWithEmptyParagraph({ future: 'same' })
  ), true, 'only invisible paragraph content is normalized')
  assert.equal(areDurablyEquivalent(
    listWithEmptyParagraph({ future: 'left' }, '   '),
    listWithEmptyParagraph({ future: 'right' })
  ), false, 'empty-list normalization retains unknown paragraph attrs')
  for (const whitespace of ['\u00A0', '\u3000']) {
    assert.equal(areDurablyEquivalent(
      listWithEmptyParagraph({}, whitespace),
      listWithEmptyParagraph({})
    ), false, 'Unicode whitespace in a list item is authored content, not an internal ASCII placeholder')
  }

  const liftedNestedItem = (withPlaceholder) => nodeDoc([{
    type: 'bullet_list',
    content: [{
      type: 'list_item',
      content: [
        ...(withPlaceholder ? [{ type: 'paragraph' }] : []),
        { type: 'paragraph', content: [{ type: 'text', text: 'lifted text' }] }
      ]
    }]
  }])
  assert.equal(areDurablyEquivalent(
    liftedNestedItem(true),
    liftedNestedItem(false)
  ), true, 'an attrs-free Crepe list placeholder is not durable document content')

  const topLevelWhitespace = (text, attrs = {}) => nodeDoc([{
    type: 'paragraph',
    attrs,
    ...(text == null ? {} : { content: [{ type: 'text', text }] })
  }])
  for (const whitespace of [' ', '\t', '\u00A0', '\u3000']) {
    assert.equal(areDurablyEquivalent(
      topLevelWhitespace(whitespace),
      topLevelWhitespace(null)
    ), false, 'top-level whitespace is authored paragraph content, not a global empty-node exception')
  }
  assert.equal(areDurablyEquivalent(
    topLevelWhitespace(' ', { future: 'left' }),
    topLevelWhitespace(null, { future: 'right' })
  ), false, 'whitespace normalization must retain unknown top-level paragraph attrs')
  assert.equal(areDurablyEquivalent(
    topLevelWhitespace(null),
    topLevelWhitespace(' '),
    { trailingLeadingSpaceEmptyParagraph: true }
  ), true, 'the exact trailing leading-space mapper may declare its terminal ASCII placeholder')
  assert.equal(areDurablyEquivalent(
    topLevelWhitespace(null),
    topLevelWhitespace('\u00A0'),
    { trailingLeadingSpaceEmptyParagraph: true }
  ), false, 'mapper provenance never authorizes dropping Unicode whitespace')
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

run('standalone default-size image representations share one durable Markdown contract', () => {
  const inlineImage = (attrs = {}, siblings = []) => nodeDoc([{
    type: 'paragraph',
    content: [
      {
        type: 'image',
        attrs: {
          src: 'data:image/gif;base64,AA==',
          alt: '微信图片',
          title: '微信图片',
          ...attrs
        }
      },
      ...siblings
    ]
  }])
  const blockImage = (attrs = {}) => nodeDoc([{
    type: 'image-block',
    attrs: {
      src: 'data:image/gif;base64,AA==',
      alt: '微信图片',
      caption: '微信图片',
      ratio: 1,
      ...attrs
    }
  }])

  assert.equal(
    areDurablyEquivalent(blockImage(), inlineImage()),
    true,
    'a standalone HTML image and the parser image-block reconstruct the same Markdown asset'
  )
  const mixedCandidate = nodeDoc([
    blockImage({ alt: 'A', caption: 'A', src: 'a.png' }).toJSON().content[0],
    blockImage({ alt: 'B', caption: 'B', src: 'b.png' }).toJSON().content[0]
  ])
  const mixedExpected = nodeDoc([
    blockImage({ alt: 'A', caption: 'A', src: 'a.png' }).toJSON().content[0],
    inlineImage({ alt: 'B', title: 'B', src: 'b.png' }).toJSON().content[0]
  ])
  assert.equal(
    areDurablyEquivalent(mixedCandidate, mixedExpected),
    true,
    'existing block images may coexist with one newly pasted inline image'
  )
  assert.equal(
    areDurablyEquivalent(
      blockImage({ alt: 'A', caption: '' }),
      blockImage({ alt: 'A', caption: 'A' })
    ),
    false,
    'same-type image blocks retain independent alt and caption semantics'
  )
  assert.equal(
    areDurablyEquivalent(
      blockImage(),
      nodeDoc([{
        type: 'image-block',
        marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
        attrs: {
          src: 'data:image/gif;base64,AA==',
          alt: '微信图片',
          caption: '微信图片',
          ratio: 1
        }
      }])
    ),
    false,
    'same-type image-block marks remain durable'
  )
  assert.equal(
    areDurablyEquivalent(blockImage({ future: 'block' }), inlineImage({ future: 'inline' })),
    false,
    'unknown image attributes remain durable instead of entering the representation contract'
  )
  assert.equal(
    areDurablyEquivalent(blockImage({ ratio: 2 }), inlineImage()),
    false,
    'a resized block image is not equivalent to the default inline representation'
  )
  assert.equal(
    areDurablyEquivalent(blockImage(), inlineImage({}, [{ type: 'text', text: 'caption tail' }])),
    false,
    'an image embedded beside paragraph content remains structurally distinct'
  )
})

run('generated scratch provenance owns only the initial empty heading scaffold', () => {
  const paragraph = { type: 'paragraph', content: [{ type: 'text', text: '正文第一段' }] }
  const expected = (attrs = { id: '', level: 1 }, prefix = true) => nodeDoc(prefix
    ? [{ type: 'heading', attrs }, paragraph]
    : [paragraph, { type: 'heading', attrs }])
  const parsed = nodeDoc([paragraph])
  const context = { generatedScratchEmptyHeading: true }

  assert.equal(
    areDurablyEquivalent(parsed, expected(), null),
    false,
    'ordinary authored documents never drop an empty heading'
  )
  assert.equal(
    areDurablyEquivalent(parsed, expected(), context),
    true,
    'generated scratch may omit its untouched leading empty H1 scaffold'
  )
  assert.equal(
    areDurablyEquivalent(parsed, expected({ id: '', level: 2 }), context),
    false,
    'the provenance does not apply to another heading level'
  )
  assert.equal(
    areDurablyEquivalent(parsed, expected({ id: '', level: 1, future: true }), context),
    false,
    'unknown scaffold attrs remain durable'
  )
  assert.equal(
    areDurablyEquivalent(parsed, expected({ id: '', level: 1 }, false), context),
    false,
    'only the initial leading scaffold position is owned'
  )
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
  ), false, 'expected-side provenance never authorizes a candidate hardbreak')
  assert.equal(areDurablyEquivalent(
    cell(null),
    cell(soleBlockBreak),
    provenEmptyCell
  ), true, 'parser-owned coordinates can prove an expected live placeholder')
  assert.equal(areDurablyEquivalent(
    cell(soleBlockBreak),
    cell(soleBlockBreak),
    provenEmptyCell
  ), false, 'a candidate hardbreak remains durable even when expected has placeholder provenance')
  assert.equal(areDurablyEquivalent(
    cell(null),
    cell(soleBlockBreak),
    { emptyTableCells: [{ table: 0, row: 0, column: 1 }] }
  ), false, 'placeholder provenance is bound to one exact cell')
})

run('durable provenance composes table placeholders with a trailing leading-space paragraph', () => {
  const combined = ({ hardbreak = false, trailingSpace = false }) => nodeDoc([
    {
      type: 'table',
      content: [{
        type: 'table_row',
        content: [{
          type: 'table_cell',
          attrs: { alignment: null, colspan: 1, rowspan: 1, colwidth: null },
          content: [{
            type: 'paragraph',
            ...(hardbreak ? { content: [{ type: 'hardbreak', attrs: { isInline: false } }] } : {})
          }]
        }]
      }]
    },
    ...(trailingSpace
      ? [{ type: 'paragraph', content: [{ type: 'text', text: ' ' }] }]
      : [])
  ])
  assert.equal(areDurablyEquivalent(
    combined({}),
    combined({ hardbreak: true, trailingSpace: true }),
    {
      emptyTableCells: [{ table: 0, row: 0, column: 0 }],
      trailingLeadingSpaceEmptyParagraph: true
    }
  ), true, 'independent source owners must combine their expected-document provenance')
})

run('strict rebuild distinguishes an empty table placeholder from an authored table break', () => {
  const canonical = '| <br /> |\n| --- |\n'
  const emptySource = '|  |\n| --- |\n'
  const tableDoc = (hardbreak) => nodeDoc([{
    type: 'table',
    content: [{
      type: 'table_row',
      content: [{
        type: 'table_header',
        attrs: { alignment: null, colspan: 1, rowspan: 1, colwidth: null },
        content: [{
          type: 'paragraph',
          ...(hardbreak ? { content: [{ type: 'hardbreak', attrs: { isInline: false } }] } : {})
        }]
      }]
    }]
  }])
  const parseMarkdown = (markdown) => tableDoc(markdown.includes('<br'))

  const placeholderSelection = selectVerifiedSource({
    candidates: rebuildSourceCandidates({
      canonical,
      rebuilt: generatedScratchMarkdown(canonical),
      durableContext: tableDurableContext({
        authored: emptySource,
        previousCanonical: canonical,
        nextCanonical: canonical
      })
    }),
    expectedDoc: tableDoc(true),
    parseMarkdown
  })
  assert.equal(placeholderSelection.ok, true)
  assert.equal(placeholderSelection.markdown, emptySource, 'an editor-owned empty-cell break must not leak into rebuilt source')

  const authoredBreakSelection = selectVerifiedSource({
    candidates: rebuildSourceCandidates({
      canonical,
      rebuilt: generatedScratchMarkdown(canonical),
      durableContext: tableDurableContext({
        authored: canonical,
        previousCanonical: canonical,
        nextCanonical: canonical,
        allowCoordinateIdentity: true
      })
    }),
    expectedDoc: tableDoc(true),
    parseMarkdown
  })
  assert.equal(authoredBreakSelection.ok, true)
  assert.equal(
    authoredBreakSelection.markdown,
    canonicalSourceFallback(canonical),
    'a user-authored sole table break must survive strict rebuild'
  )
  assert.deepEqual(rebuildSourceCandidates({
    canonical,
    rebuilt: emptySource,
    durableContext: null
  }), [], 'ambiguous table ownership must keep strict rebuild fail-closed')
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

console.log('\neditor source verification: all cases passed')
