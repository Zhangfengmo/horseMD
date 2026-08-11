import { areDurablyEquivalent } from './editor-durable-semantics.js'
import { withoutStandaloneEmptyBlockLines } from '../lib/markdown-preservation/paragraphs.js'
import { normalizeEmptyListItems } from '../lib/markdown-preservation/lists.js'

export const canonicalSourceFallback = (canonical) =>
  withoutStandaloneEmptyBlockLines(normalizeEmptyListItems(String(canonical ?? '')))

export const verifySourceDocument = ({ markdown, expectedDoc, parseMarkdown, expectedContext = null }) => {
  if (typeof parseMarkdown !== 'function') {
    return {
      ok: false,
      type: 'parser-error',
      error: new TypeError('A configured Markdown parser is required')
    }
  }
  if (!expectedDoc) {
    return { ok: false, type: 'semantic-loss', parsed: null }
  }
  try {
    const parsed = parseMarkdown(String(markdown ?? ''))
    if (areDurablyEquivalent(parsed, expectedDoc, expectedContext)) {
      return { ok: true, type: 'committed', parsed, durableContext: expectedContext }
    }
    return { ok: false, type: 'semantic-loss', parsed }
  } catch (error) {
    return { ok: false, type: 'parser-error', error }
  }
}

export const selectVerifiedSource = ({ candidates, expectedDoc, parseMarkdown }) => {
  let failure = null
  for (const candidate of candidates || []) {
    const proposal = typeof candidate === 'string'
      ? { markdown: candidate, durableContext: null }
      : candidate
    if (typeof proposal?.markdown !== 'string') continue
    const result = verifySourceDocument({
      markdown: proposal.markdown,
      expectedDoc,
      parseMarkdown,
      expectedContext: proposal.durableContext || null
    })
    if (result.ok) {
      return { ...result, markdown: proposal.markdown }
    }
    if (!failure || result.type === 'semantic-loss') failure = result
  }
  return {
    ...(failure || { type: 'semantic-loss', parsed: null }),
    ok: false,
    markdown: null
  }
}
