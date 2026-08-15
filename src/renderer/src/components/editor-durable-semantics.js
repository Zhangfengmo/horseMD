const sortedAttrs = (attrs = {}) => Object.fromEntries(
  Object.entries(attrs).sort(([left], [right]) => left.localeCompare(right))
)

const durableAttrs = (attrs) => sortedAttrs(attrs)

// GFM has no spelling for an EMPTY paragraph: a blank line is a separator
// between blocks, not a block. The rich model can hold one anywhere (press
// Enter and type nothing), so it is a state the format cannot carry — the same
// shape as an empty task item. Declare it non-durable wherever it can occur
// instead of letting each container discover the gap on its own: a paragraph
// with no visible content is dropped from its parent, so a candidate that
// cannot spell it still compares equal.
//
// Whitespace-only text is NOT covered here — a leading space has the portable
// `&nbsp;` spelling and the terminal case is declared separately by the doc
// contract.
const withoutInvisibleParagraphs = (content) => content.map((child) => {
  const invisibleParagraph = child?.type === 'paragraph' && (
    !child.content?.length || child.content.every((inline) => (
      inline?.type === 'text' &&
      !inline.marks?.length &&
      /^[ \t]*$/.test(String(inline.text || ''))
    ))
  )
  if (!invisibleParagraph) return child
  const { content: _invisibleContent, ...paragraph } = child
  return paragraph
}).filter((child) => !(
  child?.type === 'paragraph' &&
  !child.content?.length &&
  !Object.keys(child.attrs || {}).length
))

// CommonMark treats literal ASCII spaces at a text block's end as source
// formatting, rather than durable inline content. Keep those bytes literal for
// source fidelity, while comparing them as non-durable so standards-compliant
// reparsing does not reject the save. This is intentionally narrow: tabs,
// hard breaks, marks, and non-terminal whitespace stay strictly comparable.
const withoutTerminalPlainSpaces = (content) => {
  const terminal = content.at(-1)
  if (terminal?.type !== 'text' || terminal.marks?.length || !/ +$/.test(terminal.text || '')) {
    return content
  }
  const text = terminal.text.replace(/ +$/, '')
  // A whitespace-only paragraph is a different state: in particular it can
  // be the app-owned leading-space transition. Do not generalize the source
  // formatting exception to it, nor to tabs.
  if (!text || text.includes('\t') || !/\S/.test(text)) return content
  return [...content.slice(0, -1), { ...terminal, text }]
}

// Every omission is local to the node type that owns the metadata. Unknown
// attributes deliberately flow through the default contract so a future
// schema addition cannot silently disappear from persistence verification.
const nodeContracts = {
  paragraph: {
    content(content, { location, trailingLeadingSpaceEmptyParagraph }) {
      const declaredTerminalPlaceholder = trailingLeadingSpaceEmptyParagraph &&
        location.directDocChild === true &&
        location.isLastDocChild === true &&
        content.length > 0 &&
        content.every((inline) => (
          inline?.type === 'text' &&
          !inline.marks?.length &&
          /^[ \t]+$/.test(String(inline.text || ''))
        ))
      if (declaredTerminalPlaceholder) return []
      return withoutTerminalPlainSpaces(content)
    }
  },
  heading: {
    attrs(attrs) {
      const { id: _derivedHeadingId, ...durable } = attrs || {}
      return sortedAttrs(durable)
    },
    content: withoutTerminalPlainSpaces
  },
  // `bullet` / `delimiter` carry the AUTHOR'S SPELLING of the marker so the
  // serializer can reproduce it per list. Spelling is exactly what durability
  // must ignore: `- a` and `* a` are the same document, and a candidate that
  // re-parses to a different marker character has lost nothing. Keeping them
  // durable would make every mapped list fail verification.
  bullet_list: {
    attrs(attrs) {
      const { spread: _serializerSpacing, bullet: _authoredMarker, ...durable } = attrs || {}
      return sortedAttrs(durable)
    }
  },
  ordered_list: {
    attrs(attrs) {
      const { spread: _serializerSpacing, delimiter: _authoredMarker, ...durable } = attrs || {}
      return sortedAttrs(durable)
    }
  },
  list_item: {
    attrs(attrs) {
      const { spread: _serializerSpacing, checked, ...durable } = attrs || {}
      // A task item's checked state is durable whenever the item is actually a
      // task.  Empty tasks are demoted to ordinary `[ ]` / `[x]` text before
      // source verification, because GFM has no checkbox spelling for them.
      if (checked === true || checked === false) durable.checked = checked
      return sortedAttrs(durable)
    },
    content: withoutInvisibleParagraphs
  },
  blockquote: {
    content: withoutInvisibleParagraphs
  },
  table_header: {
    attrs(attrs) {
      const { colwidth: _layoutWidth, ...durable } = attrs || {}
      return sortedAttrs(durable)
    },
    content: tableCellContent
  },
  table_cell: {
    attrs(attrs) {
      const { colwidth: _layoutWidth, ...durable } = attrs || {}
      return sortedAttrs(durable)
    },
    content: tableCellContent
  },
  doc: {
    content(content, { generatedScratchEmptyHeading }) {
      const leading = content[0]
      const withoutGeneratedScaffold = generatedScratchEmptyHeading &&
        leading?.type === 'heading' &&
        !leading.content?.length &&
        Object.keys(leading.attrs || {}).length === 1 &&
        leading.attrs?.level === 1
        ? content.slice(1)
        : content
      return withoutGeneratedScaffold.filter((child) => !(
        child?.type === 'paragraph' &&
        !child.content?.length &&
        !Object.keys(child.attrs || {}).length
      ))
    }
  }
}

function tableCellContent(content, { location, placeholderCells }) {
  const key = `${location.table}:${location.row}:${location.column}`
  if (!placeholderCells.has(key)) return content
  return content.map((child) => {
    const only = child?.type === 'paragraph' && child.content?.length === 1
      ? child.content[0]
      : null
    return only?.type === 'hardbreak' && only.attrs?.isInline === false
      ? { type: 'paragraph' }
      : child
  })
}

const childLocation = (parent, index, location) => {
  const nestedLocation = parent.type === 'doc'
    ? {
        ...location,
        directDocChild: true,
        isLastDocChild: index === (parent.content?.length || 0) - 1
      }
    : { ...location, directDocChild: false, isLastDocChild: false }
  if (parent.type === 'table') return { ...nestedLocation, row: index }
  if (parent.type === 'table_row' || parent.type === 'table_header_row') {
    return { ...nestedLocation, column: index }
  }
  return nestedLocation
}

const hasOnlyDeclaredAttrs = (attrs, declared) => Object.keys(attrs || {})
  .every((key) => declared.has(key))

// Crepe deliberately parses a top-level Markdown image as `image-block`, while
// ProseMirror's HTML paste path produces a paragraph whose only child is an
// inline `image`. Markdown cannot encode that internal node-shape distinction:
// both serialize to the same top-level image asset and reopen as image-block.
// Normalize only the default-size, top-level forms whose complete attribute
// sets are known. Resized images, mixed paragraphs, marks, and future attrs stay
// under the strict default contract so this representation rule cannot widen
// into silent semantic loss.
const standaloneImageProjection = (value, location, representation) => {
  if (location.directDocChild !== true) return null

  const projectsBlock = representation === 'block' || representation === 'both'
  const projectsInline = representation === 'inline' || representation === 'both'

  if (projectsBlock && value.type === 'image-block') {
    const attrs = value.attrs || {}
    if (
      !hasOnlyDeclaredAttrs(attrs, new Set(['src', 'alt', 'caption', 'ratio'])) ||
      value.marks?.length ||
      value.content?.length ||
      Number(attrs.ratio ?? 1) !== 1
    ) return null
    return {
      type: 'standalone_image',
      attrs: sortedAttrs({
        src: String(attrs.src || ''),
        alt: String(attrs.alt || ''),
        caption: String(attrs.caption || '')
      })
    }
  }

  if (
    !projectsInline ||
    value.type !== 'paragraph' ||
    Object.keys(value.attrs || {}).length > 0 ||
    value.content?.length !== 1
  ) return null
  const image = value.content[0]
  const attrs = image?.attrs || {}
  if (
    image?.type !== 'image' ||
    image.marks?.length ||
    !hasOnlyDeclaredAttrs(attrs, new Set(['src', 'alt', 'title']))
  ) return null
  return {
    type: 'standalone_image',
    attrs: sortedAttrs({
      src: String(attrs.src || ''),
      alt: String(attrs.alt || ''),
      caption: String(attrs.title || attrs.alt || '')
    })
  }
}

const projectValue = (value, state, location = {}) => {
  if (!value || typeof value !== 'object') return value

  const standaloneImage = standaloneImageProjection(
    value,
    location,
    state.standaloneImageRepresentation
  )
  if (standaloneImage) return standaloneImage

  let currentLocation = location
  if (value.type === 'table') {
    currentLocation = { table: state.nextTable }
    state.nextTable += 1
  }

  const projected = { type: value.type }
  if (typeof value.text === 'string') {
    // The parser decodes source `&nbsp;` to NBSP. Normalize that one
    // source-provenance spelling only on the candidate side; a user's NBSP
    // stays durable content everywhere else.
    projected.text = state.portableLeadingSpace === true
      ? value.text.replace(/^\u00A0/, ' ')
      : value.text
    if (!projected.text) return null
  }

  const contract = nodeContracts[value.type]
  const attrs = (contract?.attrs || durableAttrs)(value.attrs || {}, value)
  if (Object.keys(attrs).length) projected.attrs = attrs

  if (Array.isArray(value.marks) && value.marks.length) {
    const marks = value.marks.map((mark) => projectValue(mark, state, currentLocation)).filter(Boolean)
    if (marks.length) projected.marks = marks
  }

  if (Array.isArray(value.content)) {
    let content = value.content.map((child, index) => projectValue(
      child,
      state,
      childLocation(value, index, currentLocation)
    )).filter(Boolean)
    if (contract?.content) content = contract.content(content, {
      node: value,
      location: currentLocation,
      placeholderCells: state.placeholderCells,
      trailingLeadingSpaceEmptyParagraph: state.trailingLeadingSpaceEmptyParagraph,
      generatedScratchEmptyHeading: state.generatedScratchEmptyHeading
    })
    if (content.length) projected.content = content
  }

  return projected
}

const projectWithPlaceholderContext = (
  node,
  placeholderContext = null,
  standaloneImageRepresentation = null,
  portableLeadingSpace = false
) => {
  const value = typeof node?.toJSON === 'function' ? node.toJSON() : node
  const placeholderCells = new Set((placeholderContext?.emptyTableCells || []).map(
    ({ table, row, column }) => `${table}:${row}:${column}`
  ))
  return projectValue(value, {
    nextTable: 0,
    placeholderCells,
    trailingLeadingSpaceEmptyParagraph: placeholderContext?.trailingLeadingSpaceEmptyParagraph === true,
    generatedScratchEmptyHeading: placeholderContext?.generatedScratchEmptyHeading === true,
    standaloneImageRepresentation,
    portableLeadingSpace
  })
}

export function projectDurableSemantics(node, context = null) {
  return projectWithPlaceholderContext(node, null, null, context?.portableLeadingSpace === true)
}

export const areDurablyEquivalent = (candidate, expected, expectedContext = null) => {
  // Source-model provenance can prove that a live/expected hardbreak is an
  // internal empty-cell placeholder. It never authorizes candidate Markdown:
  // the mapper must already have removed serializer-only bytes there.
  const projectedCandidate = projectDurableSemantics(candidate)
  const projectedExpected = projectWithPlaceholderContext(expected, expectedContext)
  if (!projectedCandidate || !projectedExpected) return false
  if (JSON.stringify(projectedCandidate) === JSON.stringify(projectedExpected)) return true

  // The exact source mapper can prove one candidate came from canonical
  // `&#x20;` and deliberately emitted portable `&nbsp;`. Try that candidate
  // projection only after strict equality: an externally authored NBSP still
  // remains its own durable character when both sides already agree on it.
  if (expectedContext?.portableLeadingSpace === true) {
    const portableCandidate = projectDurableSemantics(candidate, expectedContext)
    if (JSON.stringify(portableCandidate) === JSON.stringify(projectedExpected)) return true
  }

  // Normalize each eligible standalone image independently. A document may
  // contain parser-native image blocks beside a newly pasted inline image, so
  // selecting one representation for the whole document is insufficient.
  // Exact attributes remain in the projection; same-type semantic changes and
  // unknown fields therefore still fail the comparison after the strict pass.
  const normalizedCandidate = projectWithPlaceholderContext(
    candidate,
    null,
    'both',
    expectedContext?.portableLeadingSpace === true
  )
  const normalizedExpected = projectWithPlaceholderContext(expected, expectedContext, 'both')
  return JSON.stringify(normalizedCandidate) === JSON.stringify(normalizedExpected)
}
