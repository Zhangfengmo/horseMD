# Source-First List Exit Design

## Problem

Pressing Enter on an empty ordered-list item in the middle of a list lets
ProseMirror split one ordered-list node into `ordered_list`, empty `paragraph`,
and a second `ordered_list`. The latter starts again at `1`. The source mapper
then mistakes the structural split for filling an empty list item, produces a
truncated candidate, and the durable-source gate rejects it.

## Decision

Treat a newly created empty paragraph between two `.` ordered lists as an
internal split only when the pre-transaction document contained one ordered
list whose non-empty list items exactly equal the concatenated left and right
lists. Remove that new paragraph and join the two list nodes before source
observers serialize the document.

The proof deliberately excludes existing source structure: a paragraph already
present before the transaction is untouched, and a `)` ordered list is not
merged. This preserves user-authored `<br />` and explicit `1)` delimiters.

## Result

The portable source remains one ordinary ordered list (for example `5. 312`
followed by `6. 牛逼`), with no `<br />`, comments, private markers, or `1)`
fallback. The exact exit-then-Enter flow must switch to source and save without
a durable-source error or loss of following list items.
