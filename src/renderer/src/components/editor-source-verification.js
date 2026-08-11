import { areDurablyEquivalent } from './editor-durable-semantics.js'
import { withoutStandaloneEmptyBlockLines } from '../lib/markdown-preservation/paragraphs.js'
import { normalizeEmptyListItems } from '../lib/markdown-preservation/lists.js'

export const canonicalSourceFallback = (canonical) =>
  withoutStandaloneEmptyBlockLines(normalizeEmptyListItems(String(canonical ?? '')))

export const verifySourceDocument = ({ markdown, expectedDoc, parseMarkdown, durableContext = null }) => {
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
    if (areDurablyEquivalent(parsed, expectedDoc, durableContext)) {
      return { ok: true, type: 'committed', parsed, durableContext }
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
      durableContext: proposal.durableContext || null
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

export const createVerifiedSourceCommitter = ({
  sourceRef,
  canonicalRef,
  parseMarkdown,
  clearPending,
  publish
}) => {
  const parse = (markdown) => parseMarkdown(String(markdown ?? ''))
  const select = ({ candidates, expectedDoc }) => selectVerifiedSource({
    candidates,
    expectedDoc,
    parseMarkdown
  })

  const commit = ({
    candidates,
    canonical,
    expectedDoc,
    shouldPublish = true
  }) => {
    const selected = select({ candidates, expectedDoc })
    if (!selected.ok) return selected
    sourceRef.current = selected.markdown
    canonicalRef.current = canonical
    clearPending?.()
    if (shouldPublish) publish?.(selected.markdown)
    return selected
  }

  return { commit, parse, select }
}
