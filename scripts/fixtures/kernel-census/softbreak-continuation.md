# Soft-break continuation prefix

The shape that used to make 187 blocks read-only (cause A, fixed 2026-08-26):
remark ends a `text` node AT the line terminator whenever the wrapped line's
first inline sibling is not text, so the continuation prefix belonged to no
character-map unit and the WHOLE block refused.

A paragraph line that wraps and
`inline code` opens the continuation line.

A paragraph line that wraps and
**bold** opens the continuation line.

A paragraph line that wraps and
[a link](https://example.com) opens the continuation line.

A paragraph line that wraps and
![an image](img/a.png) opens the continuation line.

A paragraph line that wraps and
~~struck text~~ opens the continuation line.

- a list item that wraps and
  `inline code` opens the continuation line
- a list item that wraps and
  **bold** opens the continuation line
- a list item that wraps and
  plain text opens the continuation line

> a quoted paragraph that wraps and
> `inline code` opens the continuation line

> a quoted paragraph that wraps and
> [a link](https://example.com) opens the continuation line

1. an ordered item that wraps and
   `inline code` opens the continuation line

Hard-break twin (two trailing spaces), fixed 2026-08-18 by the same proof:  
`inline code` opens the continuation line.

> a quoted hard break  
> `inline code` after it
