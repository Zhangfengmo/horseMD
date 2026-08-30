// 图片属性编辑（Plan 5 Task 5）：把 `![alt](src "title")` 中**被改动的那一段**
// 重写为新值，其余字节（空格、`<url>` 尖括号形态、标题引号种类、空 alt、无标题）
// 一律原样保留。本目录（source-kernel）禁止 import electron/react/@milkdown。
//
// WHY A SCAN **PLUS** A REPARSE PROOF
// -----------------------------------
// mdast's `image` is a LEAF: it reports `alt` / `url` / `title` as decoded
// STRINGS and a `position` covering the whole `![...](...)` — it does NOT
// report where inside that span each field's bytes live. So this command has
// to segment the raw span itself. A hand-rolled segmentation is a guess, and
// this kernel does not commit guesses, so every candidate rewrite is
// PROVEN before it is returned:
//
//   1. `scanImage` splits the raw span into label / destination / title
//      segments using CommonMark's own bracket-balancing + backslash-escape
//      rules, and must land its closing `)` exactly on the mdast node's own
//      `position.end.offset`. A span it cannot consume exactly is refused.
//   2. The candidate document (the original text with only those segments
//      replaced) is REPARSED through the kernel's own chain
//      (`parseKernelMarkdown`) and checked on TWO axes:
//        a. the image at the same start offset comes back with exactly the
//           requested `alt`/`url`/`title`, ending exactly where the rewritten
//           span now ends, and
//        b. the WHOLE document's node tree is structurally identical to the
//           baseline parse — same pre-order type sequence, same spans once
//           every offset after the rewrite is shifted by its delta.
//
// Axis (b) is not belt-and-braces: it is the check that caught a real
// corruption during this task's TDD. Writing a raw `|` into an image inside a
// GFM table cell (`| ![a](p|q) | x |`) leaves the image node itself intact at
// the same offset with exactly the requested url — while collapsing the whole
// TABLE into a paragraph. Axis (a) alone happily accepted that. With axis (b)
// the candidate is rejected and the escaped spelling (`p\|q`, which keeps the
// table AND decodes to `p|q`) is used instead.
//
// Step 2 is what makes escaping decidable instead of theoretical: candidates
// are tried cheapest-first (verbatim bytes), and only if the reparse
// DISAGREES does the next candidate add backslash escapes or switch the
// destination to the `<...>` angle form. Nothing is escaped "just in case"
// (minimal bytes), and nothing unprovable is ever returned (fail-closed:
// `unsupported-structure`).
//
// WHAT AXIS (b) DOES NOT SEE, AND WHY THAT IS SAFE (review finding,
// 2026-08-17). Both sides of the structural comparison are UN-injected parses,
// while the projection map consumes the HIGHLIGHT-INJECTED tree
// (`injectHighlightNodes` splits text nodes around `==…==`). So a rewrite that
// changed a neighbouring text node's VALUE without changing its span would be
// invisible here. It is unreachable by construction: mdast `image` is a LEAF
// whose `alt` is a string, not children, so an image-internal rewrite can only
// SHIFT the surrounding text nodes — and every shift is exactly what axis (b)
// compares. (An independent oracle that ran the injected tree through the same
// comparison found zero drift over 8687 rewrites.)
//
// REVISION BOOKKEEPING: a request whose values already ARE the source bytes
// returns a zero-width no-op transaction rather than an empty edit list. The
// document text is unchanged but the revision still advances, so the caller
// sees a dirty tab and an empty undo step. Reachable only when a node view
// dispatches an AttrStep whose value already matches the source (Crepe's own
// `setAttr` only fires on a real change), so this is documented rather than
// special-cased.
//
// SCOPE. `alt`, `src` (the destination), `title` — and, since
// kernel/image-caption, `caption` for the UNSCALED image-block.
//
// CAPTION ADR (kernel/image-caption). Crepe's `image-block` node carries
// `caption` and `ratio` as ProseMirror attrs. Their legacy byte scheme is
// components/editor-image-markdown.js, verified line-by-line:
//   * serialize (toMarkdown): a RESIZED image (`|ratio-1| > 0.001`) writes
//     `alt: ratio.toFixed(2)` and `title: caption` — the ratio-in-alt
//     convention; an UNSCALED image writes `alt: alt || caption` and
//     `title: caption && caption !== alt ? caption : undefined`.
//   * parse (parseMarkdown): a numeric alt WITH a title is the legacy-scaled
//     reading (`caption: title`, `ratio: Number(alt)`, `alt: ''`); otherwise
//     `caption: title || alt`.
// So for an unscaled image the caption's byte home IS the markdown TITLE
// slot, and this command maps `caption` -> the title segment. Two deliberate
// choices, recorded here:
//   1. caption === alt still writes the title EXPLICITLY (legacy's
//      serializer would drop it and lean on the `title || alt` fallback).
//      Both spellings project the same caption; the explicit byte keeps the
//      round trip literal instead of shadow-dependent.
//   2. an extra proof axis runs for caption only: the candidate's
//      SCHEMA-level interpretation (`projectBlockAttrs` below, a pure mirror
//      of the parse runner) must equal the view's post-AttrStep attrs. The
//      mdast axes are blind to the reinterpretation family — writing a title
//      next to a numeric alt (`![2](x)` + caption) flips the parse into the
//      scaled reading and would snap the image to 2x — and to the shadow
//      family — clearing the caption while an alt exists has NO byte
//      spelling, because the projection would show the alt as the caption.
// `ratio` itself is STILL never written here: persisting a resize means
// rewriting alt to a number and migrating the caption into the title slot, a
// multi-slot rewrite this command does not own. The gateway refuses ratio at
// classification with its own named code (`image-resize-unsupported`), and a
// caption edit on an already-scaled image refuses `image-caption-scaled` at
// EVERY boundary (classification, commit, and here).
import { parseKernelMarkdown } from '../syntax-index.js'

const isWs = (ch) => ch === ' ' || ch === '\t'

// Characters that can START inline markup inside an image LABEL (or, for the
// destination/title, terminate the segment). Escaping is only ever applied as
// a SECOND attempt, after the verbatim candidate failed its reparse proof, so
// these sets are allowed to be generous: an over-escape that still decodes to
// the requested value is byte-legal, and one that does not is rejected by the
// same proof as everything else.
//
// KNOWN, ACCEPTED IMPRECISION: escaping is all-or-nothing PER FIELD. A value
// whose verbatim spelling fails for ONE character escalates the WHOLE field
// (`alt:'a|b]c'` is written `a\|b\]c`, where `a|b\]c` would have sufficed).
// The bytes are correct and decode exactly, but they are not the minimal
// spelling, and a user WILL see the extra backslashes in source mode. A
// per-character ladder would need a per-character proof (one reparse per
// character), which is not worth the cost for a rare attribute edit; the
// escalation only ever fires on a value that already contains markup
// characters.
const ALT_ESCAPE = new Set(['\\', '`', '*', '_', '[', ']', '<', '>', '&', '!', '~', '|', '$'])
const BARE_DEST_ESCAPE = new Set(['\\', '(', ')', '<', '>', '&', '|'])
const ANGLE_DEST_ESCAPE = new Set(['\\', '<', '>', '|'])

const escapeWith = (value, chars) => {
  let out = ''
  for (const ch of value) out += chars.has(ch) ? `\\${ch}` : ch
  return out
}

// Splits `text[start, end)` — an mdast `image` node's own raw span — into its
// byte segments. Returns null (fail-closed) for anything it cannot consume
// exactly, including reference images (`![a][ref]`, a different mdast type
// that never reaches here) and multi-line spans (refused by the caller).
//
// The label scan mirrors CommonMark's link-label rule: backslash escapes are
// skipped as a pair, `[`/`]` nest, and the FIRST unescaped `]` at depth 0
// closes the label. The destination scan mirrors the link-destination rule:
// either an angle form `<...>` (no unescaped `<`/`>`), or a bare run that
// stops at the first whitespace or at a `)` with no unmatched `(` before it.
function scanImage(text, start, end) {
  if (text[start] !== '!' || text[start + 1] !== '[') return null

  let i = start + 2
  const labelStart = i
  let labelEnd = -1
  let depth = 0
  while (i < end) {
    const ch = text[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '[') { depth += 1; i += 1; continue }
    if (ch === ']') {
      if (depth === 0) { labelEnd = i; break }
      depth -= 1
      i += 1
      continue
    }
    i += 1
  }
  if (labelEnd < 0) return null

  i = labelEnd + 1
  if (text[i] !== '(') return null
  i += 1
  while (i < end && isWs(text[i])) i += 1

  const destStart = i
  let angle = false
  if (text[i] === '<') {
    angle = true
    i += 1
    let closed = false
    while (i < end) {
      const ch = text[i]
      if (ch === '\\') { i += 2; continue }
      if (ch === '<') return null
      if (ch === '>') { i += 1; closed = true; break }
      i += 1
    }
    if (!closed) return null
  } else {
    let parens = 0
    while (i < end) {
      const ch = text[i]
      if (ch === '\\') { i += 2; continue }
      if (isWs(ch)) break
      if (ch === '(') { parens += 1; i += 1; continue }
      if (ch === ')') {
        if (parens === 0) break
        parens -= 1
        i += 1
        continue
      }
      i += 1
    }
  }
  const destEnd = Math.min(i, end)

  i = destEnd
  while (i < end && isWs(text[i])) i += 1
  let titleStart = -1
  let titleEnd = -1
  let titleOpen = ''
  const opener = text[i]
  if (i < end && (opener === '"' || opener === "'" || opener === '(')) {
    const closer = opener === '(' ? ')' : opener
    titleStart = i
    titleOpen = opener
    i += 1
    let closed = false
    while (i < end) {
      const ch = text[i]
      if (ch === '\\') { i += 2; continue }
      if (ch === closer) { i += 1; closed = true; break }
      i += 1
    }
    if (!closed) return null
    titleEnd = i
    while (i < end && isWs(text[i])) i += 1
  }

  // The scan must land the closing paren on the parser's OWN end offset — the
  // one piece of external evidence that this segmentation is the same one
  // remark made.
  if (text[i] !== ')' || i + 1 !== end) return null

  return { labelStart, labelEnd, destStart, destEnd, angle, titleStart, titleEnd, titleOpen }
}

// Candidate byte spellings for each field, cheapest (fewest bytes / closest to
// the existing form) first. `null` fields are "not requested" and contribute
// exactly one candidate: the ORIGINAL bytes, untouched.
const altCandidates = (value) => [value, escapeWith(value, ALT_ESCAPE)]

const destCandidates = (value, wasAngle) => {
  const bare = [value, escapeWith(value, BARE_DEST_ESCAPE)]
  const wrapped = [`<${value}>`, `<${escapeWith(value, ANGLE_DEST_ESCAPE)}>`]
  // An empty destination has no bare spelling at all (`![a]()` parses, but
  // `![a](  )` with a title after it would not), so the angle form `<>` leads.
  if (value === '' || wasAngle) return [...wrapped, ...bare]
  return [...bare, ...wrapped]
}

// `&` and `|` belong here for the same reasons they belong in ALT_ESCAPE /
// BARE_DEST_ESCAPE, and their absence was a measured hole (91 fuzz refusals,
// all of them titles): CommonMark decodes character references inside a title,
// so a verbatim `a&amp;b` comes back as `a&b` and no candidate could express
// the literal; and inside a GFM cell a raw `|` splits the column, so
// `title:'a|b'` was unexpressible in a table. Both are byte-verified:
// `![a](u "a\&amp;b")` -> title `a&amp;b`; `| ![a](u "a\|b") | x |` -> title
// `a|b` with the table intact.
const quoteTitle = (value, open) => {
  const close = open === '(' ? ')' : open
  const escapes = open === '('
    ? new Set(['\\', '(', ')', '&', '|'])
    : new Set(['\\', close, '&', '|'])
  return [`${open}${value}${close}`, `${open}${escapeWith(value, escapes)}${close}`]
}

const titleCandidates = (value, existingOpen) => {
  const first = existingOpen || '"'
  const rest = ['"', "'", '('].filter((q) => q !== first)
  return [...quoteTitle(value, first), ...rest.flatMap((q) => quoteTitle(value, q))]
}

// ---- caption -> title mapping (see the CAPTION ADR in the header) ----

// Character-for-character the pattern editor-image-markdown.js:3 parses
// legacy numeric alts with (`ratioPattern` + `parseLegacyRatio`). Kept as a
// LOCAL mirror because this directory must not import @milkdown (the schema
// module imports `@milkdown/kit`); any drift between the two is caught by
// the schema-projection cases in scripts/test-source-kernel-commands.mjs.
const LEGACY_RATIO_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/
const legacyRatioOf = (value) => {
  if (typeof value !== 'string' || !LEGACY_RATIO_PATTERN.test(value)) return null
  const ratio = Number(value)
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null
}

// Pure mirror of imageBlockMarkdownSchema's parse runner
// (editor-image-markdown.js:31-43): what the editor would project a
// standalone `![alt](src "title")` into. `src` is untouched by a caption
// edit, so only the three attrs a title write can move are modeled.
const projectBlockAttrs = (alt, title) => {
  const a = typeof alt === 'string' ? alt : ''
  const t = typeof title === 'string' ? title : ''
  const legacy = legacyRatioOf(a)
  const isLegacy = legacy !== null && Boolean(t)
  return {
    alt: isLegacy ? '' : a,
    caption: isLegacy ? t : t || a,
    ratio: isLegacy ? legacy : 1
  }
}

const sameProjection = (left, right) =>
  left.alt === right.alt && left.caption === right.caption && left.ratio === right.ratio

// Decides what title write realizes a caption edit — or which NAMED code
// refuses it. `alt`/`title` are the node's CURRENT (decoded, mdast) values;
// `caption` is the requested one ('' clears).
function resolveCaptionWrite({ alt, title, caption }) {
  const current = projectBlockAttrs(alt, title)
  // The serializer's own resized predicate (|ratio-1| > 0.001,
  // editor-image-markdown.js:51), evaluated on the BYTE form: both source
  // slots belong to the ratio scheme, refuse before trying anything.
  if (Math.abs(current.ratio - 1) > 0.001) {
    return { ok: false, code: 'image-caption-scaled' }
  }
  if (caption === '') {
    const removed = projectBlockAttrs(alt, null)
    if (!sameProjection(removed, { alt: current.alt, caption: '', ratio: current.ratio })) {
      // `caption: title || alt` — with a non-empty alt the projection can
      // never show an empty caption, so the state is unrepresentable.
      return { ok: false, code: 'empty-image-caption-unrepresentable' }
    }
    return { ok: true, title: null }
  }
  const predicted = { alt: current.alt, caption, ratio: current.ratio }
  if (!sameProjection(projectBlockAttrs(alt, caption), predicted)) {
    // The numeric-alt trap: the new title would flip the parse into the
    // legacy-scaled reading (alt swallowed as a ratio). Same family, same
    // named code — the slots are claimed by the ratio scheme.
    return { ok: false, code: 'image-caption-scaled' }
  }
  return { ok: true, title: caption }
}

const applyEdits = (text, edits) => {
  let out = ''
  let cursor = 0
  for (const edit of edits) {
    out += text.slice(cursor, edit.from) + edit.insert
    cursor = edit.to
  }
  return out + text.slice(cursor)
}

// Enumerates candidate index tuples in escalation order: all-verbatim first,
// then by total escalation (sum of indices), ties broken left-to-right. With
// the real UI this is a one-element product (an AttrStep carries exactly ONE
// attribute), so the common path is a single reparse.
function* candidateTuples(lengths) {
  const total = lengths.reduce((sum, n) => sum + n - 1, 0)
  for (let budget = 0; budget <= total; budget += 1) {
    const walk = function* (position, remaining, prefix) {
      if (position === lengths.length) {
        if (remaining === 0) yield prefix
        return
      }
      for (let pick = 0; pick < lengths[position] && pick <= remaining; pick += 1) {
        yield* walk(position + 1, remaining - pick, [...prefix, pick])
      }
    }
    yield* walk(0, budget, [])
  }
}

// Hard cap on reparse attempts. The ladders above are 2 (alt) x 4 (dest) x 8
// (title) wide in the worst case; a document that needs more than this many
// escalations to express one attribute is refused rather than searched.
const MAX_ATTEMPTS = 24

// `offset` is any raw offset the caller believes sits inside the image's own
// raw span — re-derived through `index.tree` here, exactly like every other
// command in this directory re-derives structure from `index`/`offset` rather
// than trusting a caller-supplied node.
//
// `src` / `alt` / `title`: omit (or pass `undefined`) to leave a field's bytes
// untouched. `title: ''` or `title: null` REMOVES the title (together with the
// whitespace that separated it from the destination) — ProseMirror's image
// schema defaults `title` to `''`, so an empty string is "no title", never
// `""` written literally into the source.
//
// `caption`: the image-block caption edit (see the CAPTION ADR in the
// header). Must be the WHOLE request — it owns the title slot, so mixing it
// with the raw fields is contradictory and refused. `caption: ''` clears
// (removes the title) when the projection can represent the cleared state.
export function setImageAttrs({ doc, index, offset, src, alt, title, caption }) {
  const rawOffset = Number(offset)
  if (!doc || !index?.tree || !Number.isFinite(rawOffset)) {
    return { ok: false, code: 'unsupported-structure' }
  }

  const wantsAlt = alt !== undefined
  const wantsSrc = src !== undefined
  const wantsTitle = title !== undefined
  const wantsCaption = caption !== undefined
  if (!wantsAlt && !wantsSrc && !wantsTitle && !wantsCaption) {
    return { ok: false, code: 'unsupported-structure' }
  }
  if (wantsCaption && (wantsAlt || wantsSrc || wantsTitle)) {
    return { ok: false, code: 'unsupported-structure' }
  }

  const nextAlt = wantsAlt ? String(alt ?? '') : null
  const nextSrc = wantsSrc ? String(src ?? '') : null
  const nextCaption = wantsCaption ? String(caption ?? '') : null
  let nextTitle = wantsTitle ? (title == null || title === '' ? null : String(title)) : undefined
  let wantsTitleWrite = wantsTitle
  // A line ending inside any written value would end the block (or the table
  // row) the image lives in — a structural change this command does not own.
  for (const value of [nextAlt, nextSrc, nextTitle, nextCaption]) {
    if (typeof value === 'string' && /[\r\n]/.test(value)) {
      return { ok: false, code: 'unsupported-structure' }
    }
  }

  // Innermost mdast `image` whose span contains `offset`. `imageReference`
  // (`![a][ref]`) is a DIFFERENT node type and is never matched here, so
  // reference images fall through to the refusal below.
  let node = null
  const visit = (candidate) => {
    const start = candidate?.position?.start?.offset
    const end = candidate?.position?.end?.offset
    if (candidate?.type === 'image' && Number.isInteger(start) && Number.isInteger(end) &&
        rawOffset >= start && rawOffset <= end) {
      if (!node || start >= node.position.start.offset) node = candidate
    }
    for (const child of candidate?.children || []) visit(child)
  }
  visit(index.tree)
  if (!node) return { ok: false, code: 'unsupported-structure' }

  const start = node.position.start.offset
  const end = node.position.end.offset
  const raw = doc.text.slice(start, end)
  // A span carrying a line ending (CommonMark permits one inside the
  // destination's surrounding whitespace) is refused wholesale: every segment
  // offset below would then straddle a line, and the reparse proof could not
  // distinguish a legal rewrite from one that re-flowed the block.
  if (/[\r\n]/.test(raw)) return { ok: false, code: 'unsupported-structure' }

  const seg = scanImage(doc.text, start, end)
  if (!seg) return { ok: false, code: 'unsupported-structure' }

  const currentAlt = node.alt ?? ''
  const currentUrl = node.url ?? ''
  const currentTitle = node.title ?? null

  // Caption resolves into a title write (or a named refusal) HERE, against
  // the node's own decoded values — after this point it is byte-for-byte the
  // ordinary title path, so every existing proof covers it unchanged.
  if (wantsCaption) {
    const resolved = resolveCaptionWrite({ alt: currentAlt, title: currentTitle, caption: nextCaption })
    if (!resolved.ok) return { ok: false, code: resolved.code }
    wantsTitleWrite = true
    nextTitle = resolved.title
  }

  const expected = {
    alt: wantsAlt ? nextAlt : currentAlt,
    url: wantsSrc ? nextSrc : currentUrl,
    title: wantsTitleWrite ? nextTitle : currentTitle
  }

  const altList = wantsAlt ? altCandidates(nextAlt) : [doc.text.slice(seg.labelStart, seg.labelEnd)]
  const destList = wantsSrc
    ? destCandidates(nextSrc, seg.angle)
    : [doc.text.slice(seg.destStart, seg.destEnd)]
  const hasTitle = seg.titleStart >= 0
  let titleList
  if (!wantsTitleWrite) titleList = [hasTitle ? doc.text.slice(seg.titleStart, seg.titleEnd) : null]
  else if (nextTitle === null) titleList = [null]
  else titleList = titleCandidates(nextTitle, hasTitle ? seg.titleOpen : '')

  let attempts = 0
  // Lazily built once (never per candidate): the pre-edit structural
  // signature every candidate must reproduce. Deliberately a FRESH parse
  // rather than `index.tree`, whose text nodes have been split by
  // `injectHighlightNodes` — the candidate parses are un-injected, so the two
  // sides must come from the same chain to be comparable.
  let baseline = null
  for (const [altPick, destPick, titlePick] of candidateTuples([altList.length, destList.length, titleList.length])) {
    if (attempts >= MAX_ATTEMPTS) break
    attempts += 1

    const edits = []
    const push = (from, to, insert) => {
      if (from === to && insert === '') return
      if (doc.text.slice(from, to) === insert) return
      edits.push({ from, to, insert })
    }
    push(seg.labelStart, seg.labelEnd, altList[altPick])
    push(seg.destStart, seg.destEnd, destList[destPick])
    const titleBytes = titleList[titlePick]
    if (titleBytes === null) {
      // Remove: the title segment AND the whitespace that introduced it (the
      // bytes from the destination's end), leaving any trailing whitespace
      // before `)` untouched.
      if (hasTitle) push(seg.destEnd, seg.titleEnd, '')
    } else if (hasTitle) {
      push(seg.titleStart, seg.titleEnd, titleBytes)
    } else {
      push(seg.destEnd, seg.destEnd, ` ${titleBytes}`)
    }

    // Nothing to write (the requested values already ARE the source bytes):
    // emit a zero-width no-op so the caller still gets a well-formed
    // transaction instead of an `invalid-range` from an empty edit list.
    if (!edits.length) {
      return {
        ok: true,
        transaction: {
          baseRevision: doc.revision,
          edits: [{ from: start, to: start, insert: '' }],
          intent: 'image-attrs',
          selection: { anchor: rawOffset, head: rawOffset }
        }
      }
    }

    const candidateText = applyEdits(doc.text, edits)
    const delta = edits.reduce((sum, edit) => sum + edit.insert.length - (edit.to - edit.from), 0)
    if (!baseline) baseline = treeSignature(parseKernelMarkdown(doc.text))
    if (!verifyCandidate(candidateText, { start, end: end + delta, expected, baseline, edits })) continue

    // Caret bookkeeping: an offset before the first rewritten byte is
    // untouched; one after the last is shifted by the total delta; one INSIDE
    // a rewritten segment has no surviving counterpart, so it clamps to the
    // image's (new) start — the atom's own left edge, which is where a
    // ProseMirror selection on an image node sits anyway.
    const firstFrom = edits[0].from
    const lastTo = edits[edits.length - 1].to
    let selection = rawOffset
    if (rawOffset >= lastTo) selection = rawOffset + delta
    else if (rawOffset > firstFrom) selection = start

    return {
      ok: true,
      transaction: {
        baseRevision: doc.revision,
        edits,
        intent: 'image-attrs',
        selection: { anchor: selection, head: selection }
      }
    }
  }

  return { ok: false, code: 'unsupported-structure' }
}

// ---------------------------------------------------------------------------
// setImageRatio — the drag-resize, as the legacy scheme's own multi-slot
// rewrite (2026-08-30, recorded-refusals batch item 3). The byte convention
// is editor-image-markdown.js's serializer, mirrored exactly:
//   * RESIZED (|ratio-1| > 0.001): alt slot := ratio.toFixed(2), title slot
//     := the caption. Requires a NON-EMPTY caption — `![1.50](url)` without
//     a title reparses as an UNSCALED image whose caption is "1.50" (the
//     legacy format itself cannot express a captionless resize; legacy
//     silently loses it on the round trip, the kernel refuses by name
//     instead of copying that corruption).
//   * BACK TO 1x from the scaled state: alt slot := '' and title := the
//     caption — `![](url "caption")` projects exactly {alt:'', caption,
//     ratio:1}, the attrs the view holds after the AttrStep.
// Both delegate to setImageAttrs' raw alt+title path, so every scan/reparse/
// escape proof covers them unchanged; the scaled-reading flip is additionally
// pre-checked through `projectBlockAttrs` (the parse runner's pure mirror).
// ---------------------------------------------------------------------------
export function setImageRatio({ doc, index, offset, ratio }) {
  const rawOffset = Number(offset)
  const nextRatio = Number(ratio)
  if (!doc || !index?.tree || !Number.isFinite(rawOffset)) {
    return { ok: false, code: 'unsupported-structure' }
  }
  if (!Number.isFinite(nextRatio) || nextRatio <= 0) {
    return { ok: false, code: 'unsupported-structure' }
  }

  let node = null
  const visit = (candidate) => {
    const start = candidate?.position?.start?.offset
    const end = candidate?.position?.end?.offset
    if (candidate?.type === 'image' && Number.isInteger(start) && Number.isInteger(end) &&
        rawOffset >= start && rawOffset <= end) {
      if (!node || start >= node.position.start.offset) node = candidate
    }
    for (const child of candidate?.children || []) visit(child)
  }
  visit(index.tree)
  if (!node) return { ok: false, code: 'unsupported-structure' }

  const current = projectBlockAttrs(node.alt ?? '', node.title ?? null)
  const resized = Math.abs(nextRatio - 1) > 0.001

  if (!resized) {
    if (Math.abs(current.ratio - 1) <= 0.001) {
      // Already unscaled: a well-formed no-op (revision bookkeeping, same
      // convention as setImageAttrs' zero-width branch).
      const start = node.position.start.offset
      return {
        ok: true,
        transaction: {
          baseRevision: doc.revision,
          edits: [{ from: start, to: start, insert: '' }],
          intent: 'image-attrs',
          selection: { anchor: rawOffset, head: rawOffset }
        }
      }
    }
    return setImageAttrs({ doc, index, offset: rawOffset, alt: '', title: current.caption })
  }

  if (!current.caption) {
    return { ok: false, code: 'image-resize-unsupported' }
  }
  const ratioBytes = nextRatio.toFixed(2)
  const predicted = projectBlockAttrs(ratioBytes, current.caption)
  if (!sameProjection(predicted, { alt: '', caption: current.caption, ratio: Number(ratioBytes) })) {
    return { ok: false, code: 'image-resize-unsupported' }
  }
  return setImageAttrs({ doc, index, offset: rawOffset, alt: ratioBytes, title: current.caption })
}

// Pre-order `{type, start, end}` list — the whole document's structure reduced
// to something two parses can be compared on.
function treeSignature(tree) {
  const out = []
  const visit = (node) => {
    out.push({
      type: node?.type,
      start: node?.position?.start?.offset ?? null,
      end: node?.position?.end?.offset ?? null
    })
    for (const child of node?.children || []) visit(child)
  }
  visit(tree)
  return out
}

// The proof (both axes — see this file's header). Every mdast node other than
// the rewritten `image` itself lies entirely before or entirely after each
// edit (an image is a LEAF: its `alt` is a string, not children), so shifting
// a baseline offset by the delta of every edit that ENDS at or before it is
// exact, never approximate.
function verifyCandidate(text, { start, end, expected, baseline, edits }) {
  let tree
  try {
    tree = parseKernelMarkdown(text)
  } catch {
    return false
  }

  let found = null
  const visit = (node) => {
    if (found) return
    if (node?.type === 'image' && node.position?.start?.offset === start) {
      found = node
      return
    }
    for (const child of node?.children || []) visit(child)
  }
  visit(tree)
  if (!found) return false
  if (found.position?.end?.offset !== end) return false
  if ((found.alt ?? '') !== expected.alt) return false
  if ((found.url ?? '') !== expected.url) return false
  if ((found.title ?? null) !== expected.title) return false

  const shift = (offset) => {
    if (offset === null) return null
    let moved = offset
    for (const edit of edits) {
      if (edit.to <= offset) moved += edit.insert.length - (edit.to - edit.from)
    }
    return moved
  }
  const candidate = treeSignature(tree)
  if (candidate.length !== baseline.length) return false
  for (let i = 0; i < candidate.length; i += 1) {
    if (candidate[i].type !== baseline[i].type) return false
    if (candidate[i].start !== shift(baseline[i].start)) return false
    if (candidate[i].end !== shift(baseline[i].end)) return false
  }
  return true
}
