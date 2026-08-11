import { areSourceDocumentsEquivalent } from '../lib/source-transaction-sync.js'

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

