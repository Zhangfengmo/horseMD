// Chunked async parsing for huge documents (Typora-style progressive render).
//
// Extracted verbatim in behavior from Editor.jsx. Milkdown/ProseMirror parse the
// WHOLE markdown string synchronously in crepe.create(), which is O(n²)-ish — a
// 1M-char doc freezes the main thread for minutes ("Not Responding").
// content-visibility can't help: the freeze is the PARSE, not paint. So for docs
// above CHUNK_THRESHOLD we create the editor with only the FIRST chunk (fast
// first paint), then parse + append the remaining chunks in the background
// (yielding between chunks so the UI never freezes, and breaking the quadratic
// blowup into linear per-chunk parses). The editor is read-only during load.
//
// `appending` (the onChange-suppression flag) is NOT managed here — the caller
// owns it, so it can be read by the editor's markdownUpdated handler.

export const CHUNK_THRESHOLD = 120000 // above this, parse incrementally
export const CHUNK_SIZE = 40000 // chars per chunk (first chunk renders in ~one frame)

// Split markdown into parse-safe chunks at blank-line boundaries, never inside a
// fenced code block. Each chunk is valid standalone markdown, so parsing it
// separately reconstructs its blocks correctly (lists/tables/headings stay whole
// because they're blank-line-delimited).
export function splitMarkdown(md, target) {
  if (!md) return []
  const lines = md.split('\n')
  const chunks = []
  let cur = []
  let len = 0
  let inFence = false
  let fence = null
  for (const line of lines) {
    const m = line.match(/^\s*(```|~~~)/)
    if (m) {
      if (!inFence) { inFence = true; fence = m[1] }
      else if (fence && line.includes(fence)) { inFence = false; fence = null }
    }
    cur.push(line)
    len += line.length + 1
    if (!inFence && len >= target && /^\s*$/.test(line)) {
      chunks.push(cur.join('\n'))
      cur = []
      len = 0
    }
  }
  if (cur.length) chunks.push(cur.join('\n'))
  return chunks
}

// Stream the remaining chunks (chunks[0] is already rendered) into the live
// editor in the background. Behavior-preserving extraction from Editor.jsx:
// normalizes review markup + display math per chunk, yields between chunks,
// toggles the editor non-editable during load, and signals the host via
// onLoadingChange / onStructureChange at the same points.
//
//   rest              — the chunks after the first (already-rendered) one
//   view              — the ProseMirror EditorView to dispatch into
//   parseMarkdown     — configured Markdown-to-ProseMirror parse contract
//   isDestroyed       — () => boolean; aborts the loop when the editor unmounts
//   getEditable       — () => bool; keeps an external reading lock after loading
//   onLoadingChange   — (bool) optional; outline shows a skeleton while streaming
//   onStructureChange — () optional; host refreshes outline/scrollspy after load
//   onChunksApplied   — optional async hook run after the LAST chunk lands and
//                       BEFORE editability is restored. That window is the
//                       only place a whole-document repair can run without
//                       racing a user edit — the source kernel's chunk repair
//                       (editor-kernel-mode.js `repairChunkedProjection`) is
//                       its one caller. It is awaited inside the same
//                       read-only span and its failure is contained here: a
//                       throwing hook must not leave the editor read-only or
//                       reject this promise (the caller's `.then` is what
//                       finishes the load).
export async function appendChunks({ rest, view, parseMarkdown, isDestroyed, getEditable, onLoadingChange, onStructureChange, onChunksApplied }) {
  if (!rest || !rest.length) {
    // Zero remaining chunks still means a chunked document (chunks[0] was the
    // whole first chunk) — the hook owns the "the document is complete" edge,
    // so it must fire here too or a document that happened to split into one
    // chunk would silently skip the repair.
    if (onChunksApplied && !isDestroyed?.()) {
      try { await onChunksApplied() } catch { /* hook failures are the hook's to report */ }
    }
    return
  }
  onLoadingChange?.(true) // outline shows a skeleton while the doc streams in
  const setEditable = (on) => {
    try { view.setProps({ editable: () => on }) } catch { /* view tearing down */ }
    try { view.dom.contentEditable = on ? 'true' : 'false' } catch { /* */ }
  }
  setEditable(false)
  try {
    for (const chunkText of rest) {
      if (isDestroyed()) break
      let parsed = null
      // Chunking splits only at blank lines, so a prepared $$…$$ block never
      // spans two chunks. The caller-owned adapter applies every configured
      // preparation and remark transform before returning a ProseMirror doc.
      try { parsed = parseMarkdown(chunkText) } catch { /* skip unparseable chunk */ }
      if (parsed && parsed.content && parsed.content.size > 0 && !isDestroyed()) {
        // `addToHistory: false`: appending a chunk is the LOAD, not an edit.
        // Without it the first Ctrl-Z on a freshly opened huge document undid
        // a 40 KB append — deleting most of the file from the view and, with
        // it, any chance of the source kernel's chunk repair surviving undo.
        const tr = view.state.tr.insert(view.state.doc.content.size, parsed.content)
        tr.setMeta('addToHistory', false)
        view.dispatch(tr)
      }
      // Yield to the event loop so paint/input happen between chunks (setTimeout
      // fires even when occluded; rAF/idle don't).
      await new Promise((r) => setTimeout(r, 0))
    }
    // The document is complete and the editor is still read-only — the one
    // window a whole-document repair can own (see the parameter docs).
    if (onChunksApplied && !isDestroyed()) {
      try { await onChunksApplied() } catch { /* hook failures are the hook's to report */ }
    }
  } finally {
    setEditable(getEditable ? getEditable() : true)
    onLoadingChange?.(false)
    // The full doc is now in the DOM — tell the host to refresh the outline
    // heading list + scrollspy (they couldn't track it during load because
    // onChange was suppressed).
    if (!isDestroyed()) onStructureChange?.()
  }
}
