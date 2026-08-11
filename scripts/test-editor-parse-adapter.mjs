import assert from 'node:assert/strict'
import { normalizeReviewMarkupMarkdown } from '../src/renderer/src/reviewMarkup.js'
import { normalizeDisplayMath } from '../src/renderer/src/components/editor-math.js'
import {
  createEditorParseAdapter,
  prepareEditorMarkdown
} from '../src/renderer/src/components/editor-parse-adapter.js'

const authored = [
  '$$x^2$$',
  '',
  '{\\~\\~old\\~>new\\~\\~}'
].join('\n')
const prepared = normalizeReviewMarkupMarkdown(normalizeDisplayMath(authored))
assert.equal(
  prepareEditorMarkdown(authored),
  prepared,
  'prepare keeps the established display-math then review-markup normalization order'
)

let getterCalls = 0
let parsedMarkdown = null
const parsedDocument = { type: 'doc' }
const adapter = createEditorParseAdapter(() => {
  getterCalls += 1
  return (markdown) => {
    parsedMarkdown = markdown
    return parsedDocument
  }
})

assert.equal(getterCalls, 0, 'creating the adapter does not resolve parserCtx eagerly')
assert.equal(adapter.prepare(authored), prepared, 'adapter exposes the shared preparation contract')
assert.equal(getterCalls, 0, 'preparing Markdown does not require the parser')
assert.equal(adapter.parse(authored), parsedDocument, 'parse returns the configured parser result')
assert.equal(getterCalls, 1, 'parse resolves the parser lazily')
assert.equal(parsedMarkdown, prepared, 'parse always prepares Markdown before parsing')

const unavailable = createEditorParseAdapter(() => null)
assert.throws(
  () => unavailable.parse('# not ready'),
  /editor Markdown parser is not ready/i,
  'parse reports a clear parser-not-ready error'
)

console.log('PASS editor parse adapter: ordered preparation, lazy parser lookup, and readiness error')
