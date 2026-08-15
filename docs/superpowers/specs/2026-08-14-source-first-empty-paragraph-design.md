# Source-First Empty Paragraph Design

## Goal

When rich editing creates an empty paragraph between two existing blocks, save
it as standard physical Markdown blank lines. Do not emit Crepe's `<br />`
placeholder, HTML, comments, or a private sentinel.

## Decision

`preserveMiddleEmptyBlock()` currently treats the new empty paragraph as
non-durable and returns the pre-edit source unchanged. Instead, once the
function has proven the neighbouring authored blocks, it will add two physical
line endings per newly-created empty paragraph immediately before the right
neighbour. The original gap and its line-ending style remain untouched.

The resulting source is portable Markdown. CommonMark parsers intentionally
collapse consecutive blank lines, so a later rich-mode parse need not recreate
the same number of empty ProseMirror paragraphs. The existing durable-semantic
contract already declares those empty paragraphs non-durable; it must not be
widened to ignore visible content or HTML breaks.

## Regression Coverage

Add a pure source-preservation test for one and two new empty paragraphs
between existing blocks. Verify their literal `\n` / CRLF spelling, the absence
of `<br />`, and preservation of a pre-existing larger gap. Keep the existing
UI test focused on never leaking the internal placeholder.
