const normalizedRangeOffsets = (rangeOrStart, maybeEnd) => {
  if (typeof rangeOrStart === 'number') {
    return { start: rangeOrStart, end: maybeEnd }
  }
  if (!rangeOrStart || typeof rangeOrStart !== 'object') return null
  const start = typeof rangeOrStart.start === 'number'
    ? rangeOrStart.start
    : rangeOrStart.start?.offset
  const end = typeof rangeOrStart.end === 'number'
    ? rangeOrStart.end
    : rangeOrStart.end?.offset
  return { start, end }
}

const mappedRawOffset = (toRaw, offset) => {
  if (!Number.isInteger(offset) || offset < 0 || offset >= toRaw.length) return null
  const raw = toRaw[offset]
  return Number.isInteger(raw) ? raw : null
}

export const normalizedOffsetFromRaw = (viewOrMap, rawOffset) => {
  const toRaw = Array.isArray(viewOrMap) ? viewOrMap : viewOrMap?.toRaw
  if (!Array.isArray(toRaw) || !toRaw.length || !Number.isFinite(rawOffset) || rawOffset < 0) {
    return null
  }
  const max = toRaw[toRaw.length - 1]
  if (!Number.isFinite(max) || rawOffset > max) return null
  let low = 0
  let high = toRaw.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (toRaw[middle] <= rawOffset) low = middle
    else high = middle - 1
  }
  return low
}

export function createMarkdownSourceView(source) {
  const raw = String(source ?? '')
  let text = ''
  const toRaw = []
  let rawIndex = raw.charCodeAt(0) === 0xFEFF ? 1 : 0

  while (rawIndex < raw.length) {
    const code = raw.charCodeAt(rawIndex)
    toRaw.push(rawIndex)
    if (code === 13) {
      text += '\n'
      rawIndex += raw.charCodeAt(rawIndex + 1) === 10 ? 2 : 1
      continue
    }
    text += raw[rawIndex]
    rawIndex += 1
  }
  toRaw.push(raw.length)

  const view = { raw, text, toRaw }
  view.rawOffset = (offset) => mappedRawOffset(view.toRaw, offset)
  view.rawRange = (rangeOrStart, maybeEnd) => {
    const offsets = normalizedRangeOffsets(rangeOrStart, maybeEnd)
    if (!offsets || !Number.isInteger(offsets.start) || !Number.isInteger(offsets.end)) return null
    if (offsets.start > offsets.end) return null
    const start = view.rawOffset(offsets.start)
    const end = view.rawOffset(offsets.end)
    return start == null || end == null ? null : { start, end }
  }
  return view
}
