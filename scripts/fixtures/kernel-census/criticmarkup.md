# CriticMarkup

The review marks HorseMD writes. They are ordinary paragraph text to the
kernel and decorated ranges to the editor, so they are the cleanest available
probe for dual-chain divergence between the two parses.

Review marks in prose: {++inserted text++} and {--deleted text--} and
{~~old text~>new text~~} in one paragraph.

A highlighted span {==flagged phrase==} plus a comment {>>reviewer note<<}
attached to it.

- a list item holding {++an insertion++}
- a list item holding {--a deletion--}

> a quoted paragraph holding {~~before~>after~~}

| cell | mark |
| --- | --- |
| one | {++added++} |
| two | {--removed--} |
