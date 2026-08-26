# Inline and block HTML

A paragraph carrying an <span>inline span</span>, a
<mark class="hm-hl-red">red highlight</mark> and an <em>emphasis tag</em> —
each coalesced into ONE inline atom by `remarkMergeInlineHtml`, which the
gateway admits as a typable atom.

<div class="wrapper">

Content inside a root-level HTML wrapper. The two `<div>` blocks and this
paragraph are three root children on the kernel side and ONE merged html node
on the editor side; the projection map proves the merge byte-for-byte rather
than tolerating the count mismatch.

</div>

Highlight round-trip spelling: ==yellow== and
<mark class="hm-hl-blue">blue</mark> in the same paragraph.

A paragraph ending with an inline break<br>and continuing after it.
