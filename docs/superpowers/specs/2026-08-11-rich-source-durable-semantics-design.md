# Rich/Source Durable Semantics Architecture

Date: 2026-08-11

Status: implemented and independently reviewed on 2026-08-12

Supersedes: `2026-08-11-rich-source-verified-commit-design.md`

## Outcome

HorseMD must preserve authored Markdown spelling while guaranteeing that source
mode, save, export, and cold reopen reconstruct the content the rich editor
shows. Verification must compare durable Markdown semantics, not transient or
layout-only ProseMirror state.

The existing verified-commit coordinator remains the single publication
boundary. Its semantic inputs and table source mapping are replaced; this is
not a collection of comparator exceptions.

## Confirmed regression boundary

The official `v0.13.29` build and old `0.13.47` main-line build save an edit to
the user's ragged table by changing only the target cell. Commit `d58775d`
first connected a whole-document round-trip gate to normal commit and forced
flush. From that commit onward, the same edit is rejected and the disk file is
left unchanged. The regression entered the current branch through `0b7077d`.

The safety objective of `d58775d` is valid. The regression comes from treating
different lifecycle representations as one semantic model:

- authored Markdown may contain legal short GFM rows;
- the initial Milkdown parse retains those short rows;
- `prosemirror-tables` repairs the table only after the first table transaction;
- the source-preservation candidate retains the authored short rows;
- the serializer emits the repaired rectangular table;
- the verifier compares reparsed authored shape with repaired live shape and
  rejects a content-preserving edit.

Once rejected, source and canonical baselines intentionally do not advance.
Every later save, source switch, or export repeats the same deterministic
mismatch, producing the persistent lock-up.

## Confirmed production defects in scope

1. A table containing a short body row enters the editor in a structurally
   invalid shape. The first table edit invokes `fixTables`, which inserts cells
   after baselines have been established. With consecutive short rows the
   generic repair can even move existing non-empty content to another column.
2. Table text preservation is based on a visible-character stream. A real cell
   hard break is removed from that stream, so `abc<br>X` is proposed as `abcX`.
3. HorseMD's table recognizers require at least three delimiter dashes even
   though the configured GFM parser and Milkdown serializer accept one or two.
4. Table regexes do not reliably distinguish cell delimiters from escaped
   pipes, so structural source ownership can be assigned to the wrong range.
5. The verifier compares ad-hoc normalized PM JSON. The growing ignore list for
   heading ids, list spread, `colwidth`, placeholders, and sentinels proves that
   raw PM shape is not a stable persistence contract.
6. Normal callbacks and forced/large-document boundaries do not always use the
   same expected-document authority. Verification semantics must not vary with
   document size or caller.

The original ordered-list Backspace report remains a real mapper/state issue,
but code-language labels, the fenced table-looking text in the user's C block,
scratch documents, and the 120K threshold are not causes of the reproduced
table failure.

## Design principles

1. **Live content authority:** the live ProseMirror document remains the final
   authority for user-visible content. Comparing only candidate and canonical
   parses is insufficient because both may agree after serializer data loss.
2. **One parser contract:** editor initialization, source-to-rich replacement,
   candidate verification, and cold reopen use the same application parser and
   deterministic pre-edit normalization.
3. **Authored bytes have separate ownership:** normalization may change the
   editor-only representation but must not silently rewrite the user's source.
4. **Structure is not visible text:** table cells, breaks, escaped delimiters,
   alignment, and row boundaries are parser tokens, not characters to discard
   before mapping.
5. **Atomic revisions:** authored source, canonical baseline, expected live-doc
   revision, pending state, and publication advance together or not at all.
6. **Typed failures:** an unowned source transaction differs from a harmless
   representation normalization. Only unresolved content mapping enters the
   recovery flow.

## Architecture

### 1. Shared editor parse adapter

Introduce a focused adapter used by all Markdown-to-editor paths. It performs:

```text
authored Markdown
  -> configured GFM/application parse
  -> deterministic editor normalization
  -> valid ProseMirror document
```

For GFM tables, the adapter determines the logical width from the header and
appends missing body cells to the right before the document is editable. It
never relies on the first user transaction to invoke `fixTables`. Excess cells,
spans, and malformed structures follow explicit parser-compatible rules rather
than repair heuristics.

The normalized document is editor-only. The authored source string and its
source ranges remain unchanged. Initialization and source replacement do not
mark the tab dirty.

Candidate verification passes the candidate through this same adapter, so a
legal authored short row and its editor-only trailing empty cells reconstruct
the same stable document.

### 2. GFM table source model

Replace the table-specific visible-stream and delimiter regex path with one
parser-backed table source model. For each table it records:

- table, row, and cell source ranges;
- header width and alignment cells;
- escaped pipe ownership;
- authored hard-break tokens;
- empty versus missing trailing cells;
- original delimiter and whitespace spelling.

An ordinary edit inside one cell patches only that cell's owned source range.
An authored short row stays short when untouched. Structural table operations
replace only the owning table block using the serializer, after verification.

The adapter follows the configured grammar, including one- and two-dash GFM
delimiters. It does not maintain a second approximate table grammar.

### 3. Durable semantic projection

Verification compares two projections:

```text
projectDurableSemantics(normalizedParse(candidate))
projectDurableSemantics(liveDocSnapshot)
```

The projection is defined by node contracts, not a global list of JSON keys to
delete. Each supported node declares which properties are:

- durable content;
- authored spelling handled by the source model;
- editor/layout metadata;
- internal placeholders with explicit provenance.

For tables, deterministic trailing empty cells and `colwidth` are not authored
content. Text, alignment, spans, cell order, and authored `<br>` remain durable.
The projection must never ignore a non-empty cell merely because a table repair
changed its position.

### 4. Revision-bound verified state

Replace independently advanced source/canonical refs with one editor-owned
state object:

```js
{
  revision,
  source,
  canonical,
  expectedDoc,
  pending,
  status
}
```

Every document-changing transaction captures an immutable live-doc revision.
The candidate produced for that revision is verified against that snapshot.
On success, source, canonical, expected document, pending flags, and App
publication advance atomically. On failure, none advance.

Forced save/source/export uses the latest dispatched revision. Document size
may change scheduling, but never the semantic authority or acceptance rule.

### 5. Typed failure and recovery

The coordinator returns a typed result:

- `committed`: verified source for the requested revision;
- `pending`: a newer callback/transaction is still settling;
- `unowned-source-change`: no source range safely owns the edit;
- `semantic-loss`: the candidate cannot reconstruct live durable content;
- `parser-error`: the configured grammar cannot parse the proposal.

Representation-only normalization is resolved by the shared adapter and does
not become a failure type. Bounded retry applies only to `pending`; retrying a
deterministic mismatch is prohibited. Recovery confirmation is shown only for
the final three real failures.

## Data flow

```text
open/source replace
  -> shared parse adapter
  -> normalized live doc + authored source model
  -> establish revision 0

user transaction
  -> capture revision N live doc
  -> source model patches owned range, or serializer replaces owned block
  -> parse candidate through shared adapter
  -> compare durable semantic projections
  -> atomically commit revision N
  -> App may save/show/export that exact revision
```

## Implementation boundaries

Focused modules should own the new behavior; `Editor.jsx` and `App.jsx` remain
lifecycle/orchestration owners only:

- shared editor parse/normalization adapter;
- GFM table source model and patcher;
- durable semantic projection registry;
- revision-bound verified state coordinator.

Existing `scrollAnchor.js` and source-mode mapping facades remain stable.
Transaction-primary stays disabled unless separately proven. The implementation
must not reparent or remount Crepe, convert source textareas to controlled
inputs, or change unrelated editor features.

## Test-first acceptance

Before production changes, add failing tests that prove the current defects:

1. A four-line three-column table with a one-cell row: edit a different cell
   one character at a time, switch to source, save, and cold reopen. Only the
   target cell bytes change; the authored short row stays short; no recovery.
2. Two consecutive short rows: editor initialization is already rectangular,
   and both non-empty values remain in their original first column before and
   after the first edit.
3. In a legal table cell, press Enter and type `X`; source/save/reopen retain
   the authored `<br>` and gate diagnostics remain empty.
4. Edit a table using one- and two-dash delimiter cells accepted by the app
   parser; save and reopen without recovery.
5. Edit a cell containing an escaped pipe and a hard break; only the intended
   cell range changes.
6. Repeat the user's original `test.md` table edit on an isolated copy and
   verify a byte-local disk diff.
7. Preserve the ordered-list Backspace/rejoin/Enter regression, code fences in
   multiple languages, scratch literals, large documents, source switching,
   forced save, export, and cold reopen.
8. Run desktop and mobile builds because the renderer and parser contract are
   shared.

All interactive tests use the repository's background Electron harness and
per-character committed input rules from `AGENTS.md`.

## Rollout and diagnostics

During development, diagnostics record revision, failure type, node family,
candidate source range, and first durable projection difference without
logging unrelated document content. Release behavior keeps the original file
safe and offers a recovery copy only for a proven unresolved conversion.

The global gate must not be disabled as the final fix. A temporary rollback is
acceptable only as an explicitly requested emergency release because it would
restore silent mapper-loss risks.

## Non-goals

- Replacing Milkdown/Crepe or migrating to a source-first editor.
- Rewriting all Markdown preservation families in one change.
- Enabling the experimental transaction-primary path.
- Treating every theoretical Markdown spelling difference as current scope.
- Adding table/list exceptions directly to `areSourceDocumentsEquivalent`.
