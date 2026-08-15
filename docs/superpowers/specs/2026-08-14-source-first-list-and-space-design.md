# Source-first ordered lists and whitespace design

## Goal

Make Markdown source the durable, cross-editor authority: generated ordered
lists use the `.` delimiter, and rich-text synchronization never writes the
serializer's `&#x20;` spelling into authored Markdown.

## Decision

### Adjacent ordered lists

Markdown cannot encode two directly adjacent ordered-list trees with the same
`.` delimiter. Blank lines are list spacing, not a tree boundary. HorseMD will
therefore prefer source semantics over an unrepresentable rich-only boundary:

- an internally generated, adjacent ordered list that would otherwise require
  `1)` is merged into the preceding ordered list in ProseMirror;
- its items continue the preceding list's source sequence and serialize with
  `.`;
- source-authored `)` markers remain untouched. They already carry an explicit
  portable Markdown distinction and are not rewritten merely by opening a
  file.

The merge must occur in the ProseMirror transaction layer, before Markdown is
published. Replacing only the source string would cause the verifier to reject
the candidate or produce a structural jump on cold reopen.

### Whitespace

`49b45a4` deliberately reintroduced `&#x20;` for a terminal ASCII space so
that it would survive the strict rich-document verifier. That behavior conflicts
with source-first output and is reverted.

- Generated source uses literal U+0020 for terminal spaces, never `&#x20;`.
- Terminal plain spaces are source-only formatting: CommonMark drops one and
  interprets two as a hard break, so they cannot be guaranteed as identical
  rich-text nodes across another editor or a cold reopen.
- The durable comparison ignores terminal plain-space text on both sides. It
  does not ignore hardbreak nodes, marks, non-space whitespace, or mid-line
  spaces.
- Existing leading-space handling remains unchanged: its U+200B sentinel is a
  separate, documented representation needed to stop one-to-four leading ASCII
  spaces from changing the Markdown block type. This task removes HTML numeric
  entities, not the leading-space parser safeguard.

## Regression coverage

1. The delete-and-recreate ordered-list UI path writes one dot-delimited list,
   remains one top-level ordered list in rich mode, saves, and cold reopens.
2. An authored `1)` list remains unchanged when no structural edit targets it.
3. A terminal space in paragraph, quote, and list item writes a literal space,
   never `&#x20;`, and saves without recovery. Cold opening follows standard
   Markdown semantics rather than an application-only spelling.
4. Existing leading-space entity regression tests continue to prove that a
   leading indentation run does not leak `&#x20;` or turn into a code block.

