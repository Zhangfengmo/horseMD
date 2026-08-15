import { areDurablyEquivalent } from './editor-durable-semantics.js'
import { withoutStandaloneEmptyBlockLines } from '../lib/markdown-preservation/paragraphs.js'
import { normalizeEmptyListItems } from '../lib/markdown-preservation/lists.js'

export const canonicalSourceFallback = (canonical) =>
  withoutStandaloneEmptyBlockLines(normalizeEmptyListItems(String(canonical ?? '')))

// `generatedScratchEmptyHeading` tells the expected-side projection to ignore
// Crepe's empty H1 scaffold. That is only true when the CANDIDATE omits it:
// once the empty title is treated as authored content it stays in the
// candidate bytes, and declaring it ignorable then drops the heading from one
// side only, so a brand-new document could never be saved. Derive the flag
// from the candidate itself instead of from "is this a scratch document".
const startsWithEmptyHeadingScaffold = (markdown) =>
  /^#[ \t]*(?:\r?\n|$)/.test(String(markdown ?? ''))

export const scratchCandidateContext = (markdown, tableContext = null) => ({
  ...(tableContext || {}),
  generatedScratchEmptyHeading: !startsWithEmptyHeadingScaffold(markdown),
  // Scratch bytes are generated from the current rich document, so a leading
  // `&nbsp;` is HorseMD's standard leading-space spelling rather than an
  // opaque author-owned NBSP from an existing source file. Empty task items
  // are now demoted to ordinary `[ ]` / `[x]` text before this boundary, so
  // they do not receive any entity-backed exception here.
  ...(String(markdown ?? '').includes('&nbsp;') ? { portableLeadingSpace: true } : {})
})

// A recovery copy is deliberately not a source commit. It is written only to
// a user-chosen, separate path after verified mapping/rebuild has failed, so
// repeating the commit predicate would make both exits fail deterministically.
// Keep the serializer's conservative spelling and remove only editor-owned
// placeholders that must never cross the raw-source boundary.
export const bestEffortRecoveryMarkdown = (canonical, {
  getTableContext,
  normalizeTablePlaceholders
} = {}) => {
  const source = String(canonical ?? '')
  let tableSafeSource = source
  try {
    const context = getTableContext?.()
    if (context && typeof normalizeTablePlaceholders === 'function') {
      const normalized = normalizeTablePlaceholders(source, context)
      if (typeof normalized === 'string') tableSafeSource = normalized
    }
  } catch {
    // Recovery must remain available when optional provenance analysis fails.
    // The unmodified canonical snapshot is less source-clean, but it still
    // preserves the complete live document in a separate user-chosen file.
  }
  return canonicalSourceFallback(tableSafeSource)
}

export const rebuildSourceCandidates = ({
  canonical,
  rebuilt,
  durableContext,
  decorate = null
}) => {
  // Rebuild is allowed to normalize a serializer-only table `<br />` only
  // when the editor's configured table parser proved its source ownership.
  // A null context means that ownership itself was ambiguous; fail closed and
  // leave best-effort export to the separate recovery path.
  if (!durableContext) return []
  return [rebuilt, canonicalSourceFallback(canonical)].map((markdown) => ({
    markdown,
    durableContext: decorate ? decorate(markdown, durableContext) : durableContext
  }))
}

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
