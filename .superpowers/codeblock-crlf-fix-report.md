# Legacy CRLF code-block corruption — fix report

Date: 2026-08-17 · Branch: `fix/rich-source-sync-architecture`
Defect: ai-handoff §5.2e — the vendored `@milkdown/components` CodeMirrorBlock
node view silently corrupts CRLF fenced code blocks in the DEFAULT (legacy)
editor.

## 1. Repro evidence (real app, unpatched build, legacy mode, no kernel)

Fixture: uniformly-CRLF file, js fence (`function greet(name) {` / `  return
name;` / `}`), plain js blocks show CodeMirror directly in legacy (no Edit
toggle needed — preview only renders for mermaid; confirmed live).

**Single keystroke corrupts disk bytes.** Typing one `X` at the end of the
`}` line (CM position preceded by 2 CRLF breaks → off by 2), then Save:

```
disk: "...  return name;\rX\n}\r\n```..."
```

The `X` SPLIT a `\r\n` pair — lone `\r` + stray bare `\n` on disk, no dialog,
no user-visible warning. This is CM changeset coordinate `fromA` applied
directly as a PM offset in `forwardUpdate`
(node_modules/@milkdown/components/lib/code-block/index.js:595-617).

**Sustained typing scrambles the block.** The RED run of the new UI test:
typing `TAIL` at the same position produced CM lines
`["function greet(name) {", "  return name;", "T", "AIL", "NEXTLINE}"]` —
each keystroke's PM landing point drifts further, and the PM→CM churn (below)
interleaves phantom breaks between them.

## 2. PM→CM `update(node)` characterization (asked: churn or masked?)

**Neither masked nor mere churn — it actively corrupts the CM view and never
converges.** Headless proof with the real `@codemirror/state` + the vendored
`computeChange` (index.js:812-847, 874-887):

- CM mounts a CRLF PM text LF-only (`EditorState.create` splits on
  `/\r\n?|\n/`): PM 19 chars → CM 17 chars.
- `computeChange(cm.state.doc.toString(), node.textContent)` diffs the
  LF-only string against the CRLF string → ALWAYS finds a bogus mid-doc diff:
  for `line1\r\nline2\r\nline3` it returns
  `{from: 5, to: 11, text: "\r\nline2\r"}`.
- Dispatching that insert: CM's splitter turns `\r\n` into one break and the
  trailing lone `\r` into ANOTHER → CM becomes `line1\nline2\n\nline3` — a
  phantom blank line per `update()` call.
- Recomputing the diff right after: STILL non-null (`{from:5,to:12,...}`) —
  the two models never converge; every subsequent `update()` grows the CM doc
  again. `this.updating` only stops the loop from echoing back into PM in the
  same tick; it does not mask the divergence.
- Selection collateral: a CM selection at 8 was remapped to 5 by the spurious
  change.

`update()` is invoked on every PM redraw of the node (including the redraw
caused by the block's own `forwardUpdate` dispatch), so in a CRLF block the
churn runs on every keystroke — this is what interleaved the scrambled lines
in the RED repro.

## 3. Correction contract (ADR)

One bijective position map per call, derived from the node's current text.
Only `\r\n` pairs shift coordinates (2 PM chars ↔ 1 CM char; lone `\r`/`\n`
are 1↔1 — CM treats a lone `\r` as a break too, same length). With `P_i` =
PM index of pair `i`, the pair's CM break position is `C_i = P_i - i`:

- `cmToPm(c) = c + |{ i : C_i < c }|`
- `pmToCm(p) = p - |{ i : P_i + 2 <= p }|`
  (a PM offset BETWEEN `\r` and `\n` — no CM equivalent — rounds to just
  after the break, consistent with `cmToPm`; round-trip verified for every
  position of the fixture text)

**CM→PM (`forwardUpdate`)**: map every `iterChanges` A-range through the
PRE-edit text's map (A coordinates address exactly that document), so a
1-char CM line-join deletion maps to the FULL `\r\n` PM pair (verified:
CM `[37,38)` → PM `[38,40)` = `"\r\n"`). Inserted text (`Text.toString()`,
LF-joined) has its `\n`s converted to the block's DOMINANT line ending
(most frequent of `\r\n` / lone `\r` / lone `\n`; `\r\n` wins any tie it is
part of, but a lone-`\r` vs lone-`\n` tie with zero pairs returns `\n`) so
endings stay uniform. Later ranges are shifted by the accumulated PM length
delta (the original's `offset +=` accumulator, in PM space). The POST-edit
CM selection (`update.state.selection.main`) is mapped through the POST-edit
text's map (post text reconstructed from the pre text + the mapped changes).
Same guards and tr shape as the original (`updating`/`hasFocus`,
`docChanged || selection moved`, `replaceWith`/`delete` + `setSelection`).

**PM→CM (`update`)**: normalize `node.textContent` with `/\r\n?/g → '\n'`
BEFORE `computeChange`, so the diff compares like-for-like; its coordinates
are then already valid CM (LF) positions on both sides and its insert text
carries no `\r` for CM's splitter to double. After normalization the diff is
null whenever CM already matches — the churn is gone and resyncs converge in
one dispatch. Everything else in `update()` replicated verbatim (readOnly
reconfigure, `updateLanguage`, placeholder branch, `text`/`language` refs
keep the RAW node text as before).

**PM→CM selection (`setSelection`)**: PM node-relative offsets translated
with `pmToCm` before delegating to the original.

**LF documents**: every wrapper delegates to the ORIGINAL implementation
when the block's text contains no `\r` — zero behavior change.

**Patch mechanism**: prototype surgery on the exported `CodeMirrorBlock`,
same as `editor-codeblock-eager.js` (nodeViewCtx cannot override
`$view`-registered component views; `editorViewOptionsCtx.nodeViews` would
clobber them all). `forwardUpdate` is an instance arrow (constructor), not a
prototype method, so it is wrapped per-instance from the patched
`initializeCodeMirror` — the single mount entry both the eager path and the
stock lazy/re-init-after-teardown path must pass through before
`EditorView.updateListener.of(this.forwardUpdate)` captures the reference.
`update` and `setSelection` are patched directly on the prototype. Module:
`src/renderer/src/components/editor-codeblock-crlf.js`, registered as a side
effect import in `Editor.jsx` next to the eager patch.

**Kernel mode**: unchanged narrowing. CRLF code blocks stay non-editable in
kernel mode (projection-map ADR + dispatch gate), but the PM→CM `update()`
path that runs for projection resyncs now converges instead of churning.
With this patch proven, the kernel CRLF ADR is NOW UNBLOCKED for a separate
follow-up (deliberately NOT un-narrowed in this task).

## 4. Discovered adjacent defect (pre-existing, out of scope, documented)

While deriving the disk expectations, the DEFAULT canonical-diff
preservation pipeline was caught with its OWN, independent CRLF position
bug: `__hmPreserveLog` shows a paragraph-end insert on a CRLF doc mapped to
`"para one.\rZ\n"` — the mapper splits the pair too — with
`preserved:true, reason:"localized-change"` (a wrong success). The split
CRLF pair then fails the reparsed-PM comparison in `verifySourceDocument`
(`components/editor-source-verification.js` → `editor-durable-semantics.js`
`areDurablyEquivalent`, reached from `commitCanonicalResult`/`flushMarkdown`
via `selectVerifiedSource`) — the real runtime gate, NOT the `roundtrip.js`
test oracle — which correctly rejects it, and the commit falls back
to the full canonical serialization: the whole file's STRUCTURAL line
endings respell to LF (code values keep their PM bytes verbatim). Proven
pre-existing: an UNPATCHED build + a pure paragraph edit (no code-block
involvement) writes byte-identical LF-respelled output. It also explains why
the unpatched code-edit repro "kept" CRLF structure: the mapper's
wrong-position patch landed INSIDE the fence, where any byte garbage still
reparses to the same PM document, so `verifySourceDocument` ACCEPTED the
corrupted spelling — corruption passing as preservation.

Consequence for the new test's disk contract: `EXPECTED_DISK` = LF
structural endings + byte-coherent CRLF code value (authored pairs intact,
inserted break spelled `\r\n`, no lone `\r` anywhere — also asserted as a
property). When the preservation mapper's CRLF bug is fixed (follow-up),
the expectation should tighten to uniform CRLF (`AFTER_LASTLINE`). Note the
byte-exact CRLF disk guarantee currently exists only under the experimental
`__hmTransactionSourcePrimary` path (scripts/test-transaction-source-sync-ui.mjs).

Also noted while testing: the source `<textarea>` can never DISPLAY `\r`
(HTML value-getter API normalization; why `source-text-fidelity.js` exists),
so the test's visible-source assertions compare the LF projection and leave
byte-exactness to the disk assertions.

## 5. RED → GREEN

- RED (unpatched build): `npm run test:codeblock-crlf-ui` fails at the first
  post-typing assertion with CM lines
  `["function greet(name) {","  return name;","T","AIL","NEXTLINE}"]`
  (expected `..."}TAIL","NEXTLINE"`); the single-keystroke diag additionally
  pinned the `\rX\n` split-pair disk corruption.
- GREEN (patched build): PASS twice consecutively. Stages: line-2+ typing,
  Enter break spelled `\r\n`, within-line Backspace ×2, line-start Backspace
  join deleting the full pair, second Enter+line surviving to disk,
  phantom-line-free CM view, exact-byte save, no-lone-`\r` property, cold
  reopen byte-stable.

## 6. Gates

| Gate | Result |
|---|---|
| `npm run build` | PASS |
| `npm run test:codeblock-crlf-ui` ×2 consecutive | PASS, PASS |
| `npm run test:kernel-codeblock-ui` | PASS |
| `npm run test:kernel-ui` (5 sessions) | PASS |
| `npm run test:core` (incl. test:source-kernel + kernel-headless) | PASS |
| `npm run test:quoted-block-source-ui` (legacy rep) | PASS |
| `npm run test:issue-98-ui` (legacy rep) | PASS |

## 7. Files

- `src/renderer/src/components/editor-codeblock-crlf.js` (new patch module)
- `src/renderer/src/components/Editor.jsx` (side-effect import)
- `scripts/test-codeblock-crlf-ui.mjs` (new UI regression)
- `package.json` (`test:codeblock-crlf-ui` script)

## 8. Follow-ups (not in this task)

1. Un-narrow the kernel-mode CRLF code-block ADR (now unblocked by this patch).
2. Fix the canonical-diff preservation mapper's own CRLF insert-position bug
   (`localized-change` wrong success, §4) so CRLF docs keep uniform CRLF on
   disk; then tighten `EXPECTED_DISK` → `AFTER_LASTLINE`.
