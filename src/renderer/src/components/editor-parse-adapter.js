import { normalizeReviewMarkupMarkdown } from '../reviewMarkup.js'
import { normalizeDisplayMath } from './editor-math.js'

export function prepareEditorMarkdown(markdown) {
  const source = String(markdown ?? '')
  return normalizeReviewMarkupMarkdown(normalizeDisplayMath(source))
}

export function createEditorParseAdapter(getParser) {
  return {
    prepare: prepareEditorMarkdown,
    parse(markdown) {
      const parser = getParser?.()
      if (typeof parser !== 'function') {
        throw new Error('HorseMD editor Markdown parser is not ready')
      }
      return parser(prepareEditorMarkdown(markdown))
    }
  }
}
