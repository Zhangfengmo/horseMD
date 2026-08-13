// A Markdown block line can be nested inside blockquotes, and that prefix is
// SYNTAX: it carries no visible text and belongs to no block's content. Every
// block-level rule in this subsystem must see through it — a quoted list row is
// still a list row, a quoted fence is still a fence, a quoted table is still a
// table. Most of this subsystem's bug history is one rule that did not.
//
// The definition is one `>` per level with at most ONE space after it, because
// CommonMark strips exactly one: `>   text` is a quote whose content is indented
// by two, not a quote with a three-space prefix. Three different spellings of
// this idea had accumulated, and two were wrong in ways that only showed up in
// unusual documents — `[ \t]*>[ \t]*` swallowed the content indentation, and
// `(?:>\s?)*` could cross a line ending. Keeping one definition is what stops
// the rules from disagreeing about what "the same block" means.
// ONE quote level. The full prefix is a repetition of it, and rules that walk
// the prefix a level at a time (the gap anchor) need the single marker.
export const QUOTE_MARKER_SOURCE = '[ \\t]*>[ \\t]?'
export const QUOTE_PREFIX_SOURCE = `[ \\t]*(?:${QUOTE_MARKER_SOURCE})*`
export const QUOTE_PREFIX = new RegExp(`^${QUOTE_PREFIX_SOURCE}`)

export const withoutQuotePrefix = (line) => String(line ?? '').replace(QUOTE_PREFIX, '')

// How many quote levels a line sits inside. Two rows share a list only when
// this — and their indentation — agree.
export const quoteDepthOf = (line) =>
  (String(line ?? '').match(QUOTE_PREFIX)?.[0].match(/>/g) || []).length
