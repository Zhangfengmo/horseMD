import {
  sourceVisibleIndex,
  sourceVisiblePositionAtRaw
} from './mode-visible-map.js'
import {
  adaptCanonicalRegionToSource,
  adoptAdjacentBulletMarker,
  canonicalFreshTextToSource,
  canonicalTextToSource,
  commonChange,
  rawInsertionAtCanonicalLineEnd,
  rawInsertionInCanonicalGap,
  rawInsertionAtCanonicalLineStart,
  rawOffsetAtVisible
} from './lib/markdown-preservation/core.js'
import {
  hasEmptyListItem,
  hasListStructureChange,
  listBlockAt,
  compactGeneratedListSpacing,
  normalizeEmptyListItems,
  preserveBatchedListBlockChanges,
  preserveDivergedNestedListChange,
  preserveDivergedListContinuation,
  preserveEmptyListItemTextChange,
  preserveListBlockChange,
  preserveStableListRowChanges,
  preserveTypedBulletInputRule,
  repairMergedListItems
} from './lib/markdown-preservation/lists.js'
import {
  capOutputTrailingNewlines,
  preserveAppendedParagraph,
  preserveEmptiedEscapedLiteralLine,
  preserveEmptiedParagraph,
  preserveMiddleEmptyBlock,
  preserveRemovedEmptyBlockquote,
  preserveTrailingExactLineChange,
  preserveTrailingEmptyBlock,
  withoutStandaloneEmptyBlockLines
} from './lib/markdown-preservation/paragraphs.js'
import {
  hasStructuralPrefixChange,
  preserveDivergedBlockTextChange,
  preserveDivergedVisibleDelete,
  preserveDivergedTailBlockAppend,
  preserveChangedLineRegion,
  preserveLocallyAlignedTextChange,
  preserveOrdinalLineTextChange,
  preserveUniquelyAnchoredTextChange
} from './lib/markdown-preservation/regions.js'
import {
  mapTableSourceChange,
  normalizeSerializerEmptyTableCells,
  tableDurableContext,
} from './lib/markdown-preservation/tables.js'

export {
  replaceMarkdownFrontmatterBlock
} from './lib/markdown-preservation/frontmatter.js'
export {
  preserveTypedBulletInputRule,
  preserveGeneratedBulletMarkers,
  replaceMarkdownListBlock,
  restoreTypedBulletMarker
} from './lib/markdown-preservation/lists.js'

export const generatedScratchMarkdown = (canonical, parseTables) => {
  // A brand-new document is authored entirely by rich typing; its canonical is
  // the only structural source. Serializer punctuation escapes outside proven
  // code/HTML literals therefore have no author-owned spelling to preserve:
  // restore the physical characters the user typed (for example
  // `\`\`\`你好\`\`\`` -> ```你好```) instead of leaking canonical escapes into
  // source mode. Milkdown may terminate the serialization with an extra blank
  // line (or the skeleton's empty-paragraph `<br />`). Neither is authored
  // content, so the generated source ends with exactly one final newline —
  // never a phantom trailing blank line.
  return canonicalFreshTextToSource(
    compactGeneratedListSpacing(
      withoutStandaloneEmptyBlockLines(
        normalizeEmptyListItems(normalizeSerializerEmptyTableCells(canonical, parseTables))
      )
    )
  ).replace(/\r?\n+$/, '\n')
}

// Milkdown serializes the complete document after every rich-text transaction.
// Preserve the user's untouched source spelling by applying only the serializer's
// localized delta. Structural edits are bounded to a list, table, or touched
// lines; an ambiguous mapping keeps the authored source instead of normalizing
// the complete document.
export function preserveRichMarkdownSource(source, previousCanonical, nextCanonical, options = {}) {
  const sourceMarkdown = String(source || '')
  const result = preserveRichMarkdownSourceCore(
    sourceMarkdown,
    previousCanonical,
    nextCanonical,
    options.parseTables,
    options.allowTableCoordinateIdentity === true
  )
  // Hard boundary invariant: an internal empty-paragraph `<br />` placeholder
  // must NEVER reach authored source, no matter which heuristic path produced
  // the result. Enforce it here as a post-condition on every output, so a
  // future path with a too-strict guard cannot leak the serializer's internal
  // representation again (this is what the empty-paragraph/visible-stream
  // bugs kept tripping over). Table-cell and inline `text<br>text` breaks are
  // not standalone lines and stay untouched.
  if (result && result.markdown != null) {
    const withoutPlaceholders = withoutStandaloneEmptyBlockLines(result.markdown)
    // Crepe may append a serializer blank line after the last edited block; the
    // file's terminal line-ending run is authored formatting and must not grow.
    result.markdown = capOutputTrailingNewlines(
      withoutPlaceholders,
      sourceMarkdown,
      result.trailingNewlineGrowth
    )
    if (result.preserved !== false) {
      const durableContext = tableDurableContext({
        authored: sourceMarkdown,
        previousCanonical,
        nextCanonical,
        parseTables: options.parseTables,
        allowCoordinateIdentity: options.allowTableCoordinateIdentity === true
      })
      if (durableContext || result.durableContext) {
        result.durableContext = {
          ...(result.durableContext || {}),
          ...(durableContext || {})
        }
      }
    }
  }
  // Test-only opt-in diagnostics. Production never creates this array; CDP
  // regressions can enable it before typing to capture the first fail-closed
  // transaction without logging document content during normal use.
  if (Array.isArray(globalThis.__hmPreserveLog)) {
    globalThis.__hmPreserveLog.push({
      source: sourceMarkdown,
      previous: String(previousCanonical || ''),
      next: String(nextCanonical || ''),
      markdown: String(result?.markdown || ''),
      preserved: result?.preserved !== false,
      reason: result?.reason || 'unknown'
    })
    if (globalThis.__hmPreserveLog.length > 200) globalThis.__hmPreserveLog.shift()
  }
  return result
}

const preserveAllDivergedListChanges = ({ source, previous, next }) => {
  let currentSource = source
  let currentPrevious = previous
  let applied = false
  const limit = Math.max(2, String(previous || '').split('\n').length)
  for (let attempt = 0; attempt < limit && currentPrevious !== next; attempt += 1) {
    const change = commonChange(currentPrevious, next)
    const result = preserveDivergedNestedListChange({
      source: currentSource,
      previous: currentPrevious,
      next,
      ...change
    })
    if (!result?.nextBaseline || result.nextBaseline === currentPrevious) {
      // A list transaction may be followed only by Crepe changing the number
      // of terminal serializer newlines. The structural delta was already
      // consumed above; terminal canonical padding has no authored-source
      // ownership and must not turn a successful Enter split into a blocked
      // transaction. Keep this exception byte-strict apart from trailing EOLs
      // so heading/list/task changes can never pass on visible-text equality.
      const withoutTrailingBreaks = (value) => String(value || '').replace(/(?:\r?\n)+$/, '')
      if (
        applied &&
        withoutTrailingBreaks(currentPrevious) === withoutTrailingBreaks(next)
      ) {
        currentPrevious = next
        continue
      }
      if (!applied) return null
      return {
        markdown: source,
        preserved: false,
        reason: 'unmapped-diverged-list-batch',
        blocked: true
      }
    }
    currentSource = result.markdown
    currentPrevious = result.nextBaseline
    applied = true
  }
  if (!applied) return null
  if (currentPrevious !== next) {
    return {
      markdown: source,
      preserved: false,
      reason: 'unmapped-diverged-list-batch',
      blocked: true
    }
  }
  return {
    markdown: currentSource,
    preserved: true,
    reason: 'diverged-nested-list-change'
  }
}

function preserveRichMarkdownSourceCore(
  sourceMarkdown,
  previousCanonical,
  nextCanonical,
  parseTables,
  allowTableCoordinateIdentity
) {
  // Empty list items have a Crepe-only `<br />` placeholder. Normalize it on
  // both sides of the delta before source mapping so a normal rich-text flow
  // (paragraph → Enter → `- ` → text) never persists that implementation
  // detail or loses the new list item's structural boundary on its next edit.
  const previous = normalizeEmptyListItems(String(previousCanonical || ''))
  const next = normalizeEmptyListItems(String(nextCanonical || ''))
  if (previous === next) return { markdown: sourceMarkdown, preserved: true, reason: 'unchanged' }
  if (!previous) {
    if (!sourceMarkdown) {
      return {
        // An empty source has no pre-existing escape spelling to protect. This
        // is the same all-new authoring boundary as generatedScratchMarkdown.
        markdown: canonicalFreshTextToSource(
          normalizeSerializerEmptyTableCells(
            compactGeneratedListSpacing(withoutStandaloneEmptyBlockLines(next)),
            parseTables
          )
        ),
        preserved: true,
        reason: 'new-document'
      }
    }
    return { markdown: sourceMarkdown, preserved: false, reason: 'missing-baseline' }
  }
  // Full-document deletion in the rich editor: the canonical became empty.
  // This is unambiguous — everything the user saw was removed — so no
  // localized mapping is needed. Without this branch a diverged source
  // (authored `-` vs canonical `*`, mid-line `* `, HTML entities, ...) fails
  // every mapping closed and resurrects the old content in source mode, in
  // saves, and after a reopen. An emptied document must serialize as empty.
  if (!next) {
    return { markdown: '', preserved: true, reason: 'document-emptied' }
  }

  const sourceVisible = sourceVisibleIndex(sourceMarkdown)
  const previousVisible = sourceVisibleIndex(previous)
  // Canonical serialization adds or drops TERMINAL newlines without a user
  // edit (a document ending with a table reliably gains one). That run is
  // serializer padding, never content — but it breaks the common SUFFIX, so
  // the delta grows from "one character in a paragraph" to "everything from
  // that character to end of file", spanning every block in between. The
  // table router then claimed a delta it does not own and failed closed on
  // the text outside the table, which made any edit before a terminal table
  // unsavable. Derive the delta from a terminal-equalized pair so it stays
  // anchored on the real edit; the pair itself stays intact for the handlers,
  // and the authored source's own trailing run remains owned by
  // `capOutputTrailingNewlines` at the façade boundary.
  const withoutTrailingLineEndings = (value) => value.replace(/(?:\r\n|\r|\n)+$/, '')
  const withEqualizedTerminal = (value) => `${withoutTrailingLineEndings(value)}\n`
  const equalizedPrevious = withEqualizedTerminal(previous)
  const equalizedNext = withEqualizedTerminal(next)
  const rawChange = commonChange(previous, next)
  const equalizedChange = commonChange(equalizedPrevious, equalizedNext)
  const changeSpan = (change) =>
    (change.previousEnd - change.start) + (change.nextEnd - change.start)
  // The delta must be the most localized description of the difference. When
  // the terminal run itself grew, equalizing recovers the real common suffix;
  // when content was genuinely appended at the tail, the raw pair already
  // describes it more tightly and the terminal run carries the authored block
  // separator. Take whichever is smaller instead of always equalizing.
  const useEqualized = changeSpan(equalizedChange) < changeSpan(rawChange)
  const canonicalChange = useEqualized ? equalizedChange : rawChange
  let { start, previousEnd, nextEnd } = canonicalChange
  // Two canonicals can share a PARTIAL leading marker (`# 旧标题` vs
  // `## 新标题` share `# `), leaving the delta boundary inside a marker
  // token. Mapping that split token as text glues the remainder onto the
  // source's own marker (`# # 新标题` — a real whole-document-paste
  // corruption). A block-marker token is atomic: whenever the boundary falls
  // inside one, widen the delta to the start of its line on both canonicals
  // (the bytes before `start` are identical, so the line start coincides).
  // This widening MUST run before any position-derived value below, and it
  // must fire ONLY when the boundary character itself is a structural marker
  // character (`#`, `>`, a list digit/punctuation): plain padding spaces after
  // a complete marker are not part of the token, and widening across them
  // parks the anchor inside an invisible-byte gap where affinity resolution
  // can leak a neighbouring block into the mapped range.
  const changeLineStart = previous.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  if (start > changeLineStart) {
    const markerRun = /^(?:(?:#{1,6}|>+|[-+*]|\d{1,9}[.)])[ \t]+)*(?:#{1,6}|>+|[-+*]|\d{1,9}[.)])?$/
    const prefixIsMarkerRun = markerRun.test(previous.slice(changeLineStart, start))
    const boundaryContinuesToken = /[#>\d.)]/.test(previous[start] || '') || /[#>\d.)]/.test(next[start] || '')
    if (prefixIsMarkerRun && boundaryContinuesToken) {
      start = changeLineStart
    }
  }
  const startVisible = sourceVisiblePositionAtRaw(previous, start)
  const endVisible = sourceVisiblePositionAtRaw(previous, previousEnd)
  const replacement = next.slice(start, nextEnd)
  const replacementVisible = sourceVisibleIndex(replacement).text
  const removedEmptyBlockquote = preserveRemovedEmptyBlockquote({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (removedEmptyBlockquote) return removedEmptyBlockquote
  const emptiedEscapedLiteralLine = preserveEmptiedEscapedLiteralLine({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (emptiedEscapedLiteralLine) return emptiedEscapedLiteralLine
  const emptiedParagraphPreserved = preserveEmptiedParagraph({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (emptiedParagraphPreserved) return emptiedParagraphPreserved
  // Crepe's cached Markdown and direct ProseMirror serialization can disagree
  // about *only* the number of terminal newlines. That is not a user edit.
  // In particular, treating it as a structural deletion on a list rewrites a
  // no-op rich→source switch and drops the author's final blank line.
  if (withoutTrailingLineEndings(previous) === withoutTrailingLineEndings(next)) {
    return { markdown: sourceMarkdown, preserved: true, reason: 'canonical-trailing-newline-drift' }
  }
  // When the canonical differs only in blank-line placement between list items
  // (loose vs compact), no visible content changed: Crepe re-serialized the
  // same authored document. The source's authored spacing must win, not the
  // serializer's latest formatting choice.
  if (compactGeneratedListSpacing(previous) === compactGeneratedListSpacing(next)) {
    return { markdown: sourceMarkdown, preserved: true, reason: 'formatting-only-drift' }
  }
  const tableChange = mapTableSourceChange({
    authored: sourceMarkdown,
    // The router recomputes the common change from this pair and refuses a
    // mismatch, so it must see the same pair `canonicalChange` came from.
    previousCanonical: useEqualized ? equalizedPrevious : previous,
    nextCanonical: useEqualized ? equalizedNext : next,
    // The generic mapper may widen its local delta to keep Markdown marker
    // tokens atomic. Table ownership validates against the canonical common
    // change itself, not that downstream widened working range.
    change: canonicalChange,
    parseTables,
    allowCoordinateIdentity: allowTableCoordinateIdentity
  })
  if (tableChange.status === 'patched') {
    return {
      markdown: tableChange.markdown,
      preserved: true,
      reason: tableChange.kind === 'table-structure'
        ? 'table-structure'
        : `table-${tableChange.kind}`,
      ...(tableChange.durableContext
        ? { durableContext: tableChange.durableContext }
        : {})
    }
  }
  if (tableChange.status === 'unowned') {
    return {
      markdown: sourceMarkdown,
      preserved: false,
      blocked: true,
      reason: tableChange.reason
    }
  }
  const trailingEmptyPreserved = preserveTrailingEmptyBlock({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (trailingEmptyPreserved) return trailingEmptyPreserved
  const middleEmptyPreserved = preserveMiddleEmptyBlock({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (middleEmptyPreserved) return middleEmptyPreserved
  // A trailing empty ProseMirror paragraph can serialize as canonical terminal
  // padding rather than `<br />`. Typing into it is therefore a pure append at
  // `previous.length`, even when an earlier `- - text` or escaped literal has
  // already made source/canonical visible streams diverge. Prove and append it
  // before ordinal visible-offset fallbacks can mistake a repeated empty quote
  // row for the insertion point.
  const appendedParagraph = preserveAppendedParagraph({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd,
    replacementVisible
  })
  if (appendedParagraph) return appendedParagraph
  // Filling an existing empty list item is more specific than a generic tail
  // append. It owns both the authored marker and the canonical row context,
  // so it can preserve structurally required literal-marker escapes that a
  // fragment-only tail mapper would otherwise strip.
  const emptyListItemTextPreserved = preserveEmptyListItemTextChange({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (emptyListItemTextPreserved) return emptyListItemTextPreserved
  // A real block appended at the document tail must keep its raw paragraph
  // boundary before generic list reconciliation. This is equally true when
  // source/canonical visible streams still match: a trailing empty paragraph
  // (`<br />`) can otherwise make the list batch mapper collapse
  // `ordered-list + blank line + bullet-list` into adjacent rows.
  const tailBlockAppend = preserveDivergedTailBlockAppend({
    source: sourceMarkdown,
    previous,
    next,
    start,
    nextEnd
  })
  if (tailBlockAppend) return tailBlockAppend
  // Exact same-count row/gap skeletons are the strongest list proof: apply
  // their item-text delta before broad multi-list reconciliation. This keeps
  // serializer-only escapes (`1\.`) and untouched marker/spacing differences
  // local instead of replacing canonical list blocks wholesale.
  const stableListRowsPreserved = preserveStableListRowChanges({
    source: sourceMarkdown,
    previous,
    next
  })
  if (stableListRowsPreserved) return stableListRowsPreserved
  // A deferred callback can structurally change more than one independently-
  // authored list. Reconcile those proven multi-list batches before any
  // one-list shortcut is allowed to return.
  const earlyMultiListPreserved = preserveBatchedListBlockChanges({
    source: sourceMarkdown,
    previous,
    next,
    requireMultiple: true
  })
  if (earlyMultiListPreserved) return earlyMultiListPreserved
  if (sourceVisible.text !== previousVisible.text) {
    // remark parses `- 1. 甲乙` as a nested ordered list, so the canonical
    // visible stream drops the `1. ` item text while the authored source
    // keeps it — the whole document's visible stream diverges and any
    // list-internal text edit fails every localized mapper below, falling
    // back to the OLD source (the user's typing silently vanishes). Anchor
    // the canonical list tree's visible text in the source and map the
    // tree-local diff back to the authored raw range. This must run BEFORE
    // the generic locally-aligned/line-region mappers: on a diverged document
    // those can map a zero-width insertion onto the wrong visible position and
    // persist corrupted rows (`- 1.  3. 戊\n 甲乙`) into the authored list.
    // The strict preconditions here (list tree + unique visible anchor) make
    // this a no-op for every non-list divergence (e.g. mid-line `* `).
    // One deferred callback may contain both a list edit and a second edit in
    // the adjacent paragraph (continue a persisted list, exit it, then type
    // prose). Map the proven list tree first, then recursively map the
    // remaining canonical delta against that updated baseline. Publication is
    // atomic: if the remainder is not independently proven, discard the
    // partial result and keep the original authored source.
    const divergedContinuation = preserveDivergedListContinuation({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd
    })
    if (divergedContinuation) return divergedContinuation
    const firstListChange = preserveDivergedNestedListChange({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd
    }) || preserveBatchedListBlockChanges({
      source: sourceMarkdown,
      previous,
      next,
      allowPartial: true
    })
    if (firstListChange?.nextBaseline === next) return firstListChange
    if (
      firstListChange?.nextBaseline &&
      firstListChange.nextBaseline !== previous &&
      firstListChange.nextBaseline !== next
    ) {
      const remainderChange = commonChange(firstListChange.nextBaseline, next)
      const remainderReplacement = next.slice(remainderChange.start, remainderChange.nextEnd)
      const remainderArgs = {
        source: firstListChange.markdown,
        previous: firstListChange.nextBaseline,
        next,
        ...remainderChange
      }
      // Deliberately compose only an adjacent empty-paragraph fill/append.
      // Broader recursion would also accept an unrelated heading/list
      // structure change after mapping only the first list, violating the
      // atomic fail-closed contract.
      const remainder = preserveMiddleEmptyBlock(remainderArgs) ||
        preserveTrailingEmptyBlock(remainderArgs) ||
        preserveAppendedParagraph({
          ...remainderArgs,
          replacementVisible: sourceVisibleIndex(remainderReplacement).text
        })
      if (remainder && remainder.preserved !== false) {
        return {
          ...remainder,
          reason: `composite-${firstListChange.reason}+${remainder.reason}`
        }
      }
    }
    const divergedList = preserveAllDivergedListChanges({
      source: sourceMarkdown,
      previous,
      next
    })
    if (divergedList) return divergedList
    const locallyAligned = preserveLocallyAlignedTextChange({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd
    })
    if (locallyAligned) return locallyAligned
    const uniquelyAnchored = preserveUniquelyAnchoredTextChange({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd
    })
    if (uniquelyAnchored) return uniquelyAnchored
    const linesPreserved = preserveChangedLineRegion({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd,
      reason: 'visible-mismatch-line-change'
    })
    if (linesPreserved) return linesPreserved
    // A diverged visible stream defeats both mappings above. If the edit is a
    // single-canonical-block text change whose block occurs exactly once in
    // the authored source, apply the block delta so deletions are not
    // silently rolled back. Anything ambiguous keeps the fail-closed source.
    const divergedBlock = preserveDivergedBlockTextChange({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd
    })
    if (divergedBlock) return divergedBlock
    // A deletion spanning several canonical blocks (whole tail, rows from
    // several list trees) still fails every mapper above. Anchor the
    // canonical's pre-deletion visible context in the authored source and
    // delete the mapped raw range; the deleted raw text is verified to match
    // the canonical deletion after marker stripping.
    const visibleDelete = preserveDivergedVisibleDelete({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd
    })
    if (visibleDelete) return visibleDelete
    return { markdown: sourceMarkdown, preserved: false, reason: 'visible-stream-mismatch' }
  }
  const listStructureChanged = hasListStructureChange({
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (listStructureChanged) {
    // A deferred markdownUpdated can batch edits across several independently
    // authored lists (fill the previous empty item, create an empty item in the
    // next list, delete from a third). A single-list mapper can validly update
    // only one of those blocks and return early, silently dropping the others.
    // Reconcile all changed top-level list blocks first only when at least two
    // replacements are proven; ordinary one-list edits keep their specialized
    // path below.
    const multiListPreserved = preserveBatchedListBlockChanges({
      source: sourceMarkdown,
      previous,
      next,
      requireMultiple: true
    })
    if (multiListPreserved) return multiListPreserved
    const listPreserved = preserveListBlockChange({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd
    })
    if (listPreserved) {
      const repaired = repairMergedListItems(listPreserved.markdown, next)
      return repaired !== listPreserved.markdown
        ? { ...listPreserved, markdown: repaired, reason: 'list-merge-repaired' }
        : listPreserved
    }
    const batchedListPreserved = preserveBatchedListBlockChanges({
      source: sourceMarkdown,
      previous,
      next
    })
    if (batchedListPreserved) return batchedListPreserved
    const linesPreserved = preserveChangedLineRegion({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd,
      reason: 'list-line-change'
    })
    if (linesPreserved) {
      const repaired = repairMergedListItems(linesPreserved.markdown, next)
      return repaired !== linesPreserved.markdown
        ? { ...linesPreserved, markdown: repaired, reason: 'list-merge-repaired' }
        : linesPreserved
    }
    return { markdown: sourceMarkdown, preserved: false, reason: 'unmapped-list-change' }
  }

  if (hasStructuralPrefixChange({ previous, next, start, previousEnd, nextEnd })) {
    return preserveChangedLineRegion({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd,
      reason: 'structural-line-change'
    }) || { markdown: sourceMarkdown, preserved: false, reason: 'unmapped-structural-change' }
  }
  const trailingExactLine = preserveTrailingExactLineChange({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (trailingExactLine) return trailingExactLine
  if (sourceMarkdown === previous) {
    const translatedReplacement = canonicalFreshTextToSource(next.slice(start, nextEnd))
    return {
      markdown: withoutStandaloneEmptyBlockLines(
        sourceMarkdown.slice(0, start) +
          translatedReplacement +
          sourceMarkdown.slice(previousEnd)
      ),
      preserved: true,
      reason: 'exact-canonical-baseline'
    }
  }

  const ordinalLinePreserved = preserveOrdinalLineTextChange({
    source: sourceMarkdown,
    previous,
    next,
    start,
    previousEnd,
    nextEnd
  })
  if (ordinalLinePreserved) return ordinalLinePreserved

  // Enter in a list is emitted as an empty-item transaction followed by text.
  // Reapply the bounded list tree instead of mapping that zero-width span past
  // the list into the following paragraph.
  const previousListAtChange = listBlockAt(previous, start)
  const nextListAtChange = listBlockAt(next, start)
  if (startVisible.visibleIndex === endVisible.visibleIndex &&
      hasEmptyListItem(previous, previousListAtChange) &&
      nextListAtChange) {
    const listPreserved = preserveListBlockChange({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd
    })
    if (listPreserved) return { ...listPreserved, reason: 'list-empty-item-change' }
  }

  if (startVisible.visibleIndex === endVisible.visibleIndex && !replacementVisible) {
    return preserveChangedLineRegion({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd,
      reason: 'structural-line-change',
      transformReplacement: withoutStandaloneEmptyBlockLines
    }) || { markdown: sourceMarkdown, preserved: false, reason: 'unmapped-structural-change' }
  }

  let rawStart = rawOffsetAtVisible(sourceMarkdown, startVisible)
  let rawEnd = rawOffsetAtVisible(sourceMarkdown, endVisible)
  // When the canonical delta starts at a line start and its replacement
  // carries that line's leading block markers, the visible-position anchor is
  // wrong by construction: visible offsets skip marker characters, so the
  // mapped position lands AFTER the source line's own markers and the
  // replacement's markers are glued behind them (`# ## 新标题` — the
  // whole-document-paste corruption). Snap the raw anchor back to the start
  // of its source line so the replacement owns the complete line prefix.
  if (
    (start === 0 || previous[start - 1] === '\n') &&
    /^(?:(?:#{1,6}|>+|[-+*]|\d{1,9}[.)])[ \t]+)/.test(next.slice(start)) &&
    Number.isFinite(rawStart)
  ) {
    rawStart = sourceMarkdown.lastIndexOf('\n', Math.max(0, rawStart - 1)) + 1
  }
  if (
    start === previousEnd &&
    startVisible.visibleIndex === endVisible.visibleIndex &&
    replacementVisible
  ) {
    // The gap rule owns every insertion that crosses a block boundary; the two
    // helpers below stay for the in-line cases it deliberately declines.
    const gapInsertion = rawInsertionInCanonicalGap({
      source: sourceMarkdown,
      previous,
      canonicalOffset: start,
      previousVisibleMap: previousVisible.map,
      mappedSourceOffset: rawStart,
      sourceVisibleMap: sourceVisible.map
    })
    const lineEndInsertion = Number.isFinite(gapInsertion)
      ? gapInsertion
      : rawInsertionAtCanonicalLineEnd({
      source: sourceMarkdown,
      previous,
      canonicalOffset: start,
      mappedSourceOffset: rawStart,
      sourceVisibleMap: sourceVisible.map
    })
    if (Number.isFinite(lineEndInsertion)) {
      rawStart = lineEndInsertion
      rawEnd = lineEndInsertion
    } else {
      // A whole block inserted at a canonical LINE START needs the mirror
      // adjustment, or it lands before the previous line's newline and is
      // glued onto it (`> - item>\n> new paragraph`).
      const lineStartInsertion = rawInsertionAtCanonicalLineStart({
        source: sourceMarkdown,
        previous,
        canonicalOffset: start,
        mappedSourceOffset: rawStart,
        sourceVisibleMap: sourceVisible.map
      })
      if (Number.isFinite(lineStartInsertion)) {
        rawStart = lineStartInsertion
        rawEnd = lineStartInsertion
      }
    }
  }
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd) || rawStart > rawEnd) {
    return preserveChangedLineRegion({
      source: sourceMarkdown,
      previous,
      next,
      start,
      previousEnd,
      nextEnd,
      reason: 'mapped-line-change'
    }) || { markdown: sourceMarkdown, preserved: false, reason: 'unmapped-change' }
  }

  // A bullet character is not cosmetic: CommonMark starts a NEW list when the
  // marker changes, so inserting the serializer's `*` next to an authored `-`
  // turns one list into two and the verified commit refuses it. Adopt the
  // neighbouring authored marker for a row inserted into an existing list.
  // This belongs here, not in the shared region adapter: the specialized list
  // mappers restore their own typed markers and must not be overridden.
  const localizedReplacement = adoptAdjacentBulletMarker(
    adaptCanonicalRegionToSource(replacement, sourceMarkdown, { start: rawStart, end: rawEnd }),
    sourceMarkdown,
    { start: rawStart, end: rawEnd }
  )
  return {
    markdown: withoutStandaloneEmptyBlockLines(
      sourceMarkdown.slice(0, rawStart) + localizedReplacement + sourceMarkdown.slice(rawEnd)
    ),
    preserved: true,
    reason: 'localized-change'
  }
}
