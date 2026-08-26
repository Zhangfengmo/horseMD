// THE SESSION IS DURABLE STORAGE (2026-08-26, correction A/B3).
//
// An unsaved scratch tab (no path, dirty) is persisted into localStorage by
// `useAppLifecycle`'s `flushSession`, and its stored bytes are what a later
// restore hands to `createMarkdownDocument()` — with an EMPTY provenance
// ledger. Anything the kernel was still holding as a PROVISIONAL byte
// therefore becomes an AUTHORED character at that moment, permanently, and
// every save of the restored draft writes it to the user's file. Measured:
// a scratch draft whose last keystroke was a Space stored
// "# 草稿标题\n\n甲<U+00A0>乙<U+00A0>" — the second U+00A0 is a placeholder the
// user never typed.
//
// The tab's `content` cannot simply BE the published text: it is the live
// mirror of the document (kernel `onChange`), and the dirty indicator, the
// source-mode buffer and the outline all read it. So the publication happens
// at the boundary itself — `flushSession` drains this registry first, each
// editor force-flushes (the same `{ force: true }` contract as save/export)
// and hands the result back through its own `onChange`, which updates
// `tabsRef` SYNCHRONOUSLY. `flushSession` then reads the published bytes.
//
// Why a registry instead of a prop: the boundary (useAppLifecycle) and the
// only component that can publish (Editor, which owns the editor API and knows
// which tab its `onChange` belongs to) have no direct wiring between them.
// Registration is per mounted editor and self-selecting — an editor that does
// not back a session-persisted scratch draft returns without doing anything.
const publishers = new Set()

export function registerScratchDraftPublisher(publish) {
  if (typeof publish !== 'function') return () => {}
  publishers.add(publish)
  return () => {
    publishers.delete(publish)
  }
}

export function publishScratchDrafts() {
  // Snapshot: a publisher may unregister (editor teardown) while draining.
  for (const publish of [...publishers]) {
    try {
      publish()
    } catch {
      // Fail-closed: a draft that cannot publish keeps its live text, which is
      // exactly today's behaviour. Never let one editor block the session write.
    }
  }
}

// Test seam only — the registry is module-global on purpose (one renderer, one
// session), so a headless test must be able to start from a known state.
export function resetScratchDraftPublishers() {
  publishers.clear()
}
