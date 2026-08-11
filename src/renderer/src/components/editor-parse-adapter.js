import { normalizeReviewMarkupMarkdown } from '../reviewMarkup.js'
import { normalizeDisplayMath } from './editor-math.js'

export function prepareEditorMarkdown(markdown) {
  return normalizeReviewMarkupMarkdown(normalizeDisplayMath(markdown))
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
