# CRLF soft-wrapped prose

This file is stored with CRLF line endings on purpose: one line ending, any
spelling, must be ONE width-1 `linebreak` unit, or every soft-wrapped block in
a Windows-authored document reads back as read-only (combination-matrix family
D2, fixed 2026-08-21).

A wrapped paragraph whose continuation line opens with
`inline code` after a CRLF pair.

A wrapped paragraph whose continuation line opens with
**bold** after a CRLF pair.

- a CRLF list item that wraps and
  continues in plain text
- a CRLF list item that wraps and
  `code` opens the continuation

> a CRLF quoted paragraph that wraps and
> continues on the next line

```js
const crlf = true
console.log(crlf)
```

| a | b |
| --- | --- |
| 1 | 2 |

末尾中文段落，带 CRLF 行尾。
