// Inline-HTML coalescing rule — the SINGLE definition shared by the editor
// chain and the source kernel.
//
// This module is pure: no Electron/React/@milkdown imports (source-kernel
// convention, see syntax-index.js).
//
// Why it exists (Plan 5 Task 2):
// CommonMark parses `a <span>x</span> b` into FIVE phrasing children —
// text("a "), html("<span>"), text("x"), html("</span>"), text(" b") — each
// with a real `position`. The EDITOR chain runs `remarkMergeInlineHtml`
// (editor-html.js), which coalesces the balanced open…close run into ONE
// `html` node so the node view can render the whole fragment; ProseMirror
// therefore holds a SINGLE inline `html` atom (preset-commonmark's
// htmlSchema: `atom:true, group:'inline'`) whose `content.size` contribution
// is 1.
//
// The KERNEL chain deliberately does NOT run that plugin: the node it
// synthesizes has NO `position` (`{type:'html', value: raw}`), which
// violates the kernel's unit contract (every charMap unit must carry a
// provable rawStart/rawEnd). Instead the kernel recognizes the SAME run on
// its own, positioned mdast (character-map.js emits one width-1 atom unit
// spanning [firstNode.position.start, lastNode.position.end]) — so both
// sides count the fragment as exactly one visible unit and the projection
// map's `content.size === visibleLength` identity holds.
//
// Both sides call `inlineHtmlRunAt` below, so "agreement" is structural, not
// merely tested: there is one implementation of the rule, not two.

// HTML void elements (no closing tag) — don't push them on the balance stack.
const VOID_TAGS = new Set([
  'br', 'img', 'hr', 'input', 'wbr', 'meta', 'link', 'area', 'base',
  'col', 'embed', 'source', 'track', 'param'
])

// Does a raw HTML fragment have all its tags closed? Used to decide when a run
// of inline-HTML nodes forms one complete, renderable fragment (so
// `<span>红字</span>` becomes a single node instead of open / text / close).
export function isBalancedFragment(s) {
  const re = /<\/?([a-zA-Z][\w-]*)([^>]*)>/g
  const stack = []
  let m
  while ((m = re.exec(s)) !== null) {
    const tag = m[1].toLowerCase()
    const closing = m[0].charAt(1) === '/'
    const selfClosing = /\/\s*$/.test(m[2])
    if (closing) {
      if (stack[stack.length - 1] !== tag) return false
      stack.pop()
    } else if (selfClosing || VOID_TAGS.has(tag)) {
      /* void / self-closed: nothing to close */
    } else {
      stack.push(tag)
    }
  }
  return stack.length === 0
}

// An inline `html` node that opens a tag (not a closer, comment, or void tag),
// i.e. the likely start of a `<tag>…</tag>` fragment worth merging.
export function isOpeningInlineTag(s) {
  return typeof s === 'string' && /^<[a-zA-Z][\w-]*\b[^>]*>$/.test(s) && !/^<\//.test(s) && !/^<!--/.test(s)
}

// An inline `<br>` / `<br/>` html node. `brToBreakRemarkPlugin`
// (editor-tablebreak.js) rewrites exactly these into mdast `break` nodes, and
// is registered BEFORE remarkMergeInlineHtml in editor-crepe-setup.js's
// remarkPluginsCtx list — so by the time the editor's coalescer runs they are
// no longer html nodes at all: they are neither a run's start nor a run's
// continuation, they TERMINATE it. The kernel chain has no such rewrite, so it
// must apply the same predicate itself or the two sides disagree: for
// `a <span>x<br/>y</span> b` the editor produces 7 inline nodes (the run is
// cut at the break) while a naive kernel scan would balance right across the
// void `<br/>` and emit ONE atom — a 9-vs-5 `content.size`/`visibleLength`
// mismatch that rejects the whole document's map.
export function isInlineBreakHtml(value) {
  return /^<br\s*\/?>$/i.test(String(value ?? '').trim())
}

// The node types `brToBreakRemarkPlugin` rewrites `<br>` inside — i.e. the
// containers whose children are phrasing content, the only place an inline
// `<br>` legitimately appears (rewriting at block level would produce an
// invalid mdast break). Owned here rather than in editor-tablebreak.js because
// it is also the exact predicate `inlineHtmlRunAt`'s `breakHtmlCuts` argument
// answers: a container NOT in this set still holds real `html` `<br>` nodes
// when the coalescer runs, and must keep balancing across them.
//
// Two such containers exist in practice, and BOTH would change behavior if the
// `<br>` exclusion were applied unconditionally (measured base-vs-head, see
// scripts/test-source-kernel-inline-html.mjs):
//  - the mdast ROOT (`<div>`/`<br/>`/`</div>` as blank-line-separated block
//    HTML siblings) — the editor merges those into one renderable fragment;
//  - `linkReference` (`[ref <span>a<br/>b</span>][id]`).
export const BREAK_REWRITE_PARENTS = new Set([
  'paragraph',
  'heading',
  'tableCell',
  'emphasis',
  'strong',
  'delete',
  'link'
])

// Can this child be swallowed into a merged inline-HTML fragment? Mirrors
// `coalesceChildren`'s `if (k.type !== 'html' && k.type !== 'text') break`,
// minus (when `breakHtmlCuts`) the `<br>` nodes that are already `break` nodes
// by then.
const mergeable = (node, breakHtmlCuts) => {
  if (!node) return false
  if (node.type === 'text') return true
  if (node.type !== 'html') return false
  return !breakHtmlCuts || !isInlineBreakHtml(node.value)
}

// Given a `children` array and a start index, decide whether the children at
// [start, end) form ONE balanced inline-HTML fragment that must collapse into
// a single node/unit. Returns `{ end, value }` (end exclusive, `value` the
// concatenated node values — exactly what the editor's merged `html` node
// carries) or `null` when no merge applies at `start`.
//
// `breakHtmlCuts` says whether `brToBreakRemarkPlugin` has already turned this
// container's `<br>` html nodes into `break` nodes (pass
// `BREAK_REWRITE_PARENTS.has(parent.type)`). When it has, a `<br>` cannot be
// balanced across — the editor's own scan would have hit a `break` node and
// stopped. When it has NOT (mdast root, `linkReference`), `<br>` is still a
// plain html node and the run grows over it, exactly as before.
//
// With that argument supplied, the scan is byte-identical to
// editor-html.js's original inline loop (locked by the base-vs-head
// differential in scripts/test-source-kernel-inline-html.mjs):
//  - the run must START at an `html` node that opens a tag;
//  - it grows over html/text siblings, stopping at the FIRST prefix that
//    balances (greedy-but-shortest, so `<span>x</span><span>y</span>` yields
//    two runs, not one);
//  - a run of exactly ONE node (`<br/>`, a self-closed `<span/>`) is NOT a
//    merge — it already is a single node on both sides, so returning `null`
//    keeps the caller on its ordinary single-node path;
//  - a run that never balances (`<span>x b`) is NOT a merge either — the
//    editor leaves those nodes alone, so the kernel must too.
export function inlineHtmlRunAt(children, start, breakHtmlCuts = true) {
  const first = children?.[start]
  if (!first || first.type !== 'html') return null
  if (!isOpeningInlineTag(first.value)) return null
  if (breakHtmlCuts && isInlineBreakHtml(first.value)) return null
  let raw = ''
  let j = start
  while (j < children.length) {
    const k = children[j]
    if (!mergeable(k, breakHtmlCuts)) break
    raw += k.value
    j += 1
    if (isBalancedFragment(raw)) {
      return j > start + 1 ? { end: j, value: raw } : null
    }
  }
  return null
}
