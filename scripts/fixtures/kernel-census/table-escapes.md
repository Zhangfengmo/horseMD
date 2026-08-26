# Table cells holding escapes

remark-stringify writes these escapes as a matter of routine, so any table a
remark-based tool has ever saved is full of them. They used to cost 330
read-only blocks = 63.7% of the whole read-only surface (cause B, narrowed
2026-08-26 to the ONE escape that is genuinely ambiguous, `\|`).

| model | price | note |
| --- | --- | --- |
| claude\-haiku\-4\.5 | $0\.80 | fast |
| gpt\-4\.1 | $2\.00 | a \* b |
| gemini\-2\.5 | $1\.25 | c \_ d |
| o3\-mini | $1\.10 | 中文 \+ 符号 |

## The two shapes that stay read-only on purpose

`\|` is a GFM cell escape layered ON TOP of the CommonMark one (it fires even
inside a code span), and `<br>` is the cell's only multi-line semantics. Both
degrade just their own cell.

| pipe escape | in-cell break | ordinary |
| --- | --- | --- |
| a \| b | x<br>y | plain |
| still \| here | one<br />two | 普通 |

## Cells with inline marks and links

| cell | content |
| --- | --- |
| bold | **strong** text |
| code | `a \| b` |
| link | [docs](https://example.com) |
