# Rich/Source Verified Commit Architecture

Date: 2026-08-11

Status: superseded by `2026-08-11-rich-source-durable-semantics-design.md`

> This document records the first verified-commit design. Real table-cell
> transaction evidence later disproved its parser-lifecycle assumption. The
> durable-semantics design is the implementation authority.

## Outcome

HorseMD must never publish, show in source mode, export, or save a rich-editor
source snapshot unless that exact Markdown parses through HorseMD's configured
Milkdown parser to the same ProseMirror document that the rich editor owns.

Source preservation remains responsible for authored spelling. It may propose a
candidate, but it is not allowed to commit one. The configured application
parser and the live ProseMirror document are the semantic authority.

## Confirmed current defects

These are reachable in the default production path and are in implementation
scope:

1. The independent GFM MDAST acceptance gate disagrees with Crepe's parser.
   The user's ragged table is padded by Crepe, so a valid preserved source
   candidate is rejected even though it reconstructs the visible document.
2. Generated scratch Markdown bypasses semantic validation. Removing serializer
   escapes can turn visible literal text such as `# title` into a heading after
   save and reopen.
3. Documents above 120,000 characters advance both source and canonical
   baselines without validation. A forced flush can then return early merely
   because the canonical baseline matches, allowing an unverified source
   snapshot to cross a durability boundary.
4. Slash-created code/math blocks directly mutate both baselines and call
   `onChange`, bypassing the advertised commit point.
5. A successful forced rich snapshot read does not consistently mirror the
   snapshot into the owning tab. Save has a caller-side repair, while other
   consumers such as Pandoc export can leave App state stale.
6. The complete list interaction from the report is not covered: exit the last
   empty item, Backspace to rejoin the preceding list, Enter, type, switch,
   save, and reopen.

## Preventive or experimental findings

These are recorded but do not justify speculative production changes in this
fix:

1. Transaction-primary source sync is disabled by default. Its remaining direct
   baseline writes are an architectural convergence risk, not the cause of the
   reported production failure.
2. The MDAST gate has additional false-positive shapes involving math,
   highlight, authored standalone `<br>`, and unused reference definitions.
   Replacing it as the production authority removes the class of risk; this fix
   will not add one-off normalizers for every hypothetical string pair.
3. Provenance-aware patch spans and a long-term single source of truth remain a
   future architecture stage. They are not required to restore correct current
   behavior.
4. Recovery should eventually clear every experimental transaction-primary
   intent. Current production recovery intent cleanup is handled only where a
   presently enabled path can replay stale state.

## Architecture

### 1. One semantic verifier

A focused editor helper accepts:

- a candidate authored Markdown string;
- the expected ProseMirror document;
- HorseMD's configured `parserCtx` parser.

It parses the candidate and compares the result with the expected document by
`areSourceDocumentsEquivalent`. Parser exceptions fail closed. Diagnostics may
describe the rejection but may not alter state.

The existing generic MDAST comparison remains useful for isolated preservation
library tests and diagnostics. It is no longer a production commit authority.

### 2. One verified commit owner

`Editor.jsx` owns a single commit operation. Every enabled rich-to-source path,
including normal `markdownUpdated`, list conversion, paste, generated scratch,
and slash blocks, submits a candidate to it.

The operation performs these steps atomically:

1. reject a mapper failure;
2. verify the candidate against the expected ProseMirror document;
3. advance authored-source and canonical baselines together;
4. clear the matching pending edit state;
5. publish `onChange`.

On rejection none of steps 3–5 occur.

For a `markdownUpdated` callback, the expected document is obtained by parsing
that callback's canonical Markdown with the same application parser. This keeps
batched callbacks internally consistent. A forced boundary verifies against
the current `view.state.doc`, because save/source/export must represent the
latest dispatched transaction rather than a delayed callback.

### 3. Scratch is a proposal, not an exemption

Generated-scratch cleanup may propose the physically friendly source spelling.
It passes through the same verifier. If cleanup changes semantics, the editor
tries the canonical source spelling with only the already-defined internal
placeholder cleanup. If neither spelling reconstructs the expected document,
the operation fails closed.

### 4. Large-document verification state

The hot path may defer a full semantic parse for documents above the existing
threshold, but an unverified proposal is not a committed App snapshot:

- it may advance only editor-local working baselines needed to accumulate later
  preservation;
- it keeps the rich edit pending and does not call `onChange`;
- it records that the current source/canonical pair is unverified;
- every forced boundary, and every non-forced source read that sees this pending
  state, verifies the exact candidate against the current ProseMirror document;
- the canonical-equality fast path is forbidden while verification is pending.

Successful boundary verification clears the pending state. Failure returns
`null`, preserving the existing recovery flow and preventing source/save/export
from consuming the proposal.

### 5. App snapshot mirroring

Mounted rich-editor reads return a verified string or `null`. The App owns one
small helper that mirrors every successful string into `tabsRef` and React tab
state while leaving `savedContent` untouched. Save, source switching, rebuild,
and export use that helper rather than each implementing partial state repair.

## Error and recovery behavior

- Candidate ambiguity or semantic mismatch remains fail-closed.
- The last trusted authored source stays intact for recovery.
- The current live ProseMirror document remains available as a canonical
  recovery copy.
- Source mode and durability operations cannot consume an unverified snapshot.
- User-visible recovery confirmation is reserved for a real unresolved
  conversion, not parser disagreement caused by using a different grammar.

## Verification

The implementation is accepted only when all of the following hold:

1. A sanitized fixture matching the user's ragged-table structure can be edited,
   switched to source, saved, and reopened without a recovery dialog or content
   loss.
2. The same scenario works with fenced Go, JavaScript, TypeScript, Python, Rust,
   Java, C, and C++ blocks, showing that language labels are not the trigger.
3. Literal scratch text that requires escaping remains literal after save and
   cold reopen.
4. A document above 120,000 characters cannot cross source/save/export with an
   unverified candidate, including the canonical-equality path.
5. The full ordered-list Backspace/rejoin/Enter sequence survives source view,
   save, and cold reopen.
6. Slash-created code/math blocks pass the same verified commit route.
7. Existing preservation, source-map, list, source-transaction, desktop build,
   and mobile build checks remain green.
