import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'

// Acceptance invariant for every committed source snapshot: the bytes written
// to authored source must parse to the same document the editor is showing.
// The preservation heuristics prove "a mapper accepted the delta"; only this
// check proves "the mapped bytes mean what the user sees". A candidate that
// fails here must be treated as fail-closed, never committed.
//
// Equivalence is semantic, not byte-level: authored spelling (`-` vs `*`,
// escapes vs entities, CRLF, list spacing) is exactly what preservation
// exists to protect, so both sides run through the same parser and are
// compared as normalized syntax trees.

const BR_RE = /^<br\s*\/?>$/i

const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// Reference-style links keep their authored spelling in source (`[a][r]` plus
// a `[r]: url` definition) while the canonical serializes the same document as
// inline links. Resolve references against the collected definitions so the
// two spellings compare as the same link.
const collectDefinitions = (node, map) => {
  if (!node || !Array.isArray(node.children)) return map
  for (const child of node.children) {
    if (child?.type === 'definition') {
      map.set(child.identifier, { url: child.url || '', title: child.title ?? null })
    }
    collectDefinitions(child, map)
  }
  return map
}

const normalizeNode = (node, definitions) => {
  if (!node || typeof node !== 'object') return node
  const out = { type: node.type }
  for (const key of Object.keys(node)) {
    if (key === 'position' || key === 'children' || key === 'type') continue
    out[key] = node[key]
  }
  // The serializer flip-flops loose/tight list spacing without a user edit
  // (the façade already declares that non-semantic via formatting-only-drift);
  // spacing must not fail an otherwise correct mapping.
  if (node.type === 'list' || node.type === 'listItem') delete out.spread
  // `<br>` / `<br />` spellings are one line break in the editor.
  if (node.type === 'html' && BR_RE.test(String(node.value || '').trim())) out.value = '<br>'
  if (Array.isArray(node.children)) {
    // Flow containers are the only places Crepe's empty-block `<br />`
    // placeholder appears as its own block; inline `text<br>text` breaks
    // (paragraphs, table cells) are real content and must be kept.
    const flowParent =
      node.type === 'root' || node.type === 'listItem' || node.type === 'blockquote'
    const children = []
    for (const child of node.children) {
      // A block that is only `<br />` is Crepe's internal empty-block
      // placeholder (empty list items serialize as `* <br />`; the parser
      // yields it as a bare html flow node or a wrapping paragraph). The
      // boundary invariant already bans it from authored source, so it is not
      // content on either side of the comparison.
      const brOnly = flowParent && (
        (child?.type === 'html' && BR_RE.test(String(child.value || '').trim())) ||
        (child?.type === 'paragraph' &&
          child.children?.length === 1 &&
          child.children[0]?.type === 'html' &&
          BR_RE.test(String(child.children[0].value || '').trim()))
      )
      if (brOnly) continue
      let resolved = child
      if (resolved?.type === 'definition') continue
      if (resolved?.type === 'linkReference' || resolved?.type === 'imageReference') {
        const definition = definitions?.get(resolved.identifier) || { url: '', title: null }
        resolved = resolved.type === 'linkReference'
          ? { type: 'link', url: definition.url, title: definition.title, children: resolved.children || [] }
          : { type: 'image', url: definition.url, title: definition.title, alt: resolved.alt ?? '' }
      }
      const normalized = normalizeNode(resolved, definitions)
      // U+200B is the app's leading-space sentinel (lib/markdown-leading-space.js):
      // authored source spells protected leading spaces as `U+200B + spaces`
      // while the canonical spells the same text as `&#x20;`. The sentinel is
      // never content, so it does not participate in equivalence.
      if (normalized.type === 'text' && normalized.value) {
        normalized.value = normalized.value.replace(/\u200B/g, '')
      }
      if (normalized.type === 'text' && !normalized.value) continue
      const last = children[children.length - 1]
      if (normalized.type === 'text' && last?.type === 'text') {
        last.value += normalized.value
        continue
      }
      children.push(normalized)
    }
    // An authored table cell holding only `<br />` is HorseMD's spelling for
    // an EMPTY cell (normalizeEmptyTableCells); the canonical serializes it as
    // truly empty. The two must compare equal.
    if (
      node.type === 'tableCell' &&
      children.length === 1 &&
      children[0].type === 'html' &&
      BR_RE.test(String(children[0].value || '').trim())
    ) {
      children.length = 0
    }
    // The editor normalizes single-line `$$x^2$$` display math into the
    // multi-line spelling on parse (editor-math.js normalizeDisplayMath);
    // preservation keeps the author's single-line bytes. Both spellings are
    // one math block, so collapse internal whitespace for comparison.
    for (const child of children) {
      if (child.type === 'text' && child.value && child.value.includes('$$')) {
        child.value = child.value.replace(/\$\$\s*([\s\S]*?)\s*\$\$/g, (match, body) => '$$' + body.trim() + '$$')
      }
    }
    out.children = children
  }
  return out
}

// The same canonical string is keyed more than once per transaction (commit
// gate + forced flush); parsing a large document twice per keystroke batch is
// the dominant cost, so memoize by exact input string with a small cap.
const KEY_CACHE = new Map()
const KEY_CACHE_LIMIT = 8

export const markdownComparisonKey = (markdown) => {
  const input = String(markdown || '')
  const cached = KEY_CACHE.get(input)
  if (cached) return cached
  const tree = fromMarkdown(input, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()]
  })
  const key = stableStringify(normalizeNode(tree, collectDefinitions(tree, new Map())))
  KEY_CACHE.set(input, key)
  if (KEY_CACHE.size > KEY_CACHE_LIMIT) KEY_CACHE.delete(KEY_CACHE.keys().next().value)
  return key
}

// True when `candidateSource` parses to the same document as `canonical`.
// A parser failure cannot prove equivalence, so it fails closed.
export const roundTripPreserved = (candidateSource, canonical) => {
  try {
    return markdownComparisonKey(candidateSource) === markdownComparisonKey(canonical)
  } catch {
    return false
  }
}
