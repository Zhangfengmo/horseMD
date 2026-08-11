import { areSourceDocumentsEquivalent } from '../lib/source-transaction-sync.js'
import { withoutStandaloneEmptyBlockLines } from '../lib/markdown-preservation/paragraphs.js'
import { normalizeEmptyListItems } from '../lib/markdown-preservation/lists.js'

export const canonicalSourceFallback = (canonical) =>
  withoutStandaloneEmptyBlockLines(normalizeEmptyListItems(String(canonical ?? '')))

export const verifySourceDocument = ({ markdown, expectedDoc, parseMarkdown }) => {
  if (typeof parseMarkdown !== 'function' || !expectedDoc) return false
  try {
    return areSourceDocumentsEquivalent(parseMarkdown(String(markdown ?? '')), expectedDoc)
  } catch {
    return false
  }
}

export const selectVerifiedSource = ({ candidates, expectedDoc, parseMarkdown }) => {
  for (const candidate of candidates || []) {
    if (typeof candidate !== 'string') continue
    if (verifySourceDocument({ markdown: candidate, expectedDoc, parseMarkdown })) {
      return candidate
    }
  }
  return null
}

export const createVerifiedSourceCommitter = ({
  sourceRef,
  canonicalRef,
  parseMarkdown,
  clearPending,
  publish
}) => {
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
    const markdown = select({ candidates, expectedDoc })
    if (markdown === null) return { ok: false, markdown: null }
    sourceRef.current = markdown
    canonicalRef.current = canonical
    clearPending?.()
    if (shouldPublish) publish?.(markdown)
    return { ok: true, markdown }
  }

  return { commit, select }
}
