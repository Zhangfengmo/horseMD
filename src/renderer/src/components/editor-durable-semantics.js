const leadingSpaceSentinel = '\u200B'

const sortedAttrs = (attrs = {}) => Object.fromEntries(
  Object.entries(attrs).sort(([left], [right]) => left.localeCompare(right))
)

const durableAttrs = (attrs) => sortedAttrs(attrs)

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
      return declaredTerminalPlaceholder ? [] : content
    }
  },
  heading: {
    attrs(attrs) {
      const { id: _derivedHeadingId, ...durable } = attrs || {}
      return sortedAttrs(durable)
    }
  },
  bullet_list: {
    attrs(attrs) {
      const { spread: _serializerSpacing, ...durable } = attrs || {}
      return sortedAttrs(durable)
    }
  },
  ordered_list: {
    attrs(attrs) {
      const { spread: _serializerSpacing, ...durable } = attrs || {}
      return sortedAttrs(durable)
    }
  },
  list_item: {
    attrs(attrs) {
      const { spread: _serializerSpacing, ...durable } = attrs || {}
      return sortedAttrs(durable)
    },
    content(content) {
      return content.map((child) => {
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
    }
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
    content(content) {
      return content.filter((child) => !(
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

const projectValue = (value, state, location = {}) => {
  if (!value || typeof value !== 'object') return value

  let currentLocation = location
  if (value.type === 'table') {
    currentLocation = { table: state.nextTable }
    state.nextTable += 1
  }

  const projected = { type: value.type }
  if (typeof value.text === 'string') {
    projected.text = value.text.replaceAll(leadingSpaceSentinel, '')
    if (!projected.text) return null
  }

  const contract = nodeContracts[value.type]
  const attrs = (contract?.attrs || durableAttrs)(value.attrs || {})
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
      location: currentLocation,
      placeholderCells: state.placeholderCells,
      trailingLeadingSpaceEmptyParagraph: state.trailingLeadingSpaceEmptyParagraph
    })
    if (content.length) projected.content = content
  }

  return projected
}

const projectWithPlaceholderContext = (node, placeholderContext = null) => {
  const value = typeof node?.toJSON === 'function' ? node.toJSON() : node
  const placeholderCells = new Set((placeholderContext?.emptyTableCells || []).map(
    ({ table, row, column }) => `${table}:${row}:${column}`
  ))
  return projectValue(value, {
    nextTable: 0,
    placeholderCells,
    trailingLeadingSpaceEmptyParagraph: placeholderContext?.trailingLeadingSpaceEmptyParagraph === true
  })
}

export function projectDurableSemantics(node) {
  return projectWithPlaceholderContext(node)
}

export const areDurablyEquivalent = (candidate, expected, expectedContext = null) => {
  // Source-model provenance can prove that a live/expected hardbreak is an
  // internal empty-cell placeholder. It never authorizes candidate Markdown:
  // the mapper must already have removed serializer-only bytes there.
  const projectedCandidate = projectDurableSemantics(candidate)
  const projectedExpected = projectWithPlaceholderContext(expected, expectedContext)
  if (!projectedCandidate || !projectedExpected) return false
  return JSON.stringify(projectedCandidate) === JSON.stringify(projectedExpected)
}
