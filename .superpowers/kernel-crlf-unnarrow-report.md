# Kernel-mode CRLF code-block un-narrowing — report

**Status: SHIPPED.** CRLF and lone-`\r` fenced code blocks are editable in the
experimental source-kernel mode. One residual shape stays fail-closed and is
characterized byte-level below.

---

## 1. What the ADR said, and why it no longer applies

`src/renderer/src/components/editor-kernel-projection-map.js` (the
`pmType === 'code_block'` branch) carried, until this change:

```js
if (charMap && charMap.lineEnding !== '\n') charMap = null
```

with a ~65-line ADR comment. The reason was never this module's own math — it
was the vendored `@milkdown/components` `CodeMirrorBlock` node view, whose
`forwardUpdate` applied CM6 coordinates directly as PM offsets while CM6's
`Text` model structurally discards `\r`. Every CM position past a block's first
line break undercounted the dropped bytes.

That defect is fixed at its source by
`src/renderer/src/components/editor-codeblock-crlf.js` (commit `1e8315f`):
bijective CM↔PM position map per call (`cmToPm`/`pmToCm`, :96-119), inserted
breaks converted to the block's dominant ending (:172), `update()` diffing on
LF-normalized text (:257-258), `setSelection` mapped both ways (:273-278).
Locked by `scripts/test-codeblock-crlf-ui.mjs`.

---

## 2. Identity proof (investigation step 1)

Ran `buildProjectionMap` against hand-built PM docs mirroring the live Crepe
parse, with the `lineEnding` gate temporarily bypassed. The mdast side came
from the real kernel parse (`buildSyntaxIndex`), not a stub.

| fixture | mdast `code.value` | `charMap.visibleLength` | `pm.node.content.size` | `lineEnding` / `linePrefix` |
|---|---|---|---|---|
| ` ```js\r\nlet a = 1\r\nlet b = 2\r\n```\r\n ` | `"let a = 1\r\nlet b = 2"` | 20 | 20 | `"\r\n"` / `""` |
| ` ```js\rlet a = 1\rlet b = 2\r```\r ` | `"let a = 1\rlet b = 2"` | 19 | 19 | `"\r"` / `""` |
| `> ```js\r\n> a\r\n> b\r\n> ```\r\n` | `"a\r\nb"` | 4 | 4 | `"\r\n"` / `"> "` |

**`pm.node.content.size === charMap.visibleLength` holds in all three cases.**
Reason: remark keeps a `code` node's line endings verbatim (confirmed against
the real parser, column 2 above), and `buildCodeMap` emits exactly one width-1
unit per `value` char. For CRLF the `\r` is its own `char` unit and the `\n` is
the `linebreak` unit — and that `linebreak` unit's raw span also covers the
next line's prefix, which is what makes prefixed fences work:

```
'> ```js\r\n> a\r\n> b\r\n> ```\r\n'
units: char[11,12)='a'  char[12,13)='\r'  linebreak[13,16)='\n> '  char[16,17)='b'
```

No mismatch anywhere, so the gate was never protecting an identity failure.

---

## 3. Round-trip trace and the double-conversion analysis (investigation step 2)

CM edit (Enter inside a CRLF fence)
→ **patched `forwardUpdate`** maps the changeset through the pre-edit CRLF
  position map and replaces the inserted `\n` with `dominantLineEnding(preText)`
  (`editor-codeblock-crlf.js:172`)
→ PM `ReplaceStep` whose **slice text already contains `\r\n`**
→ gateway `extractPlainTextSteps` → `plainSliceText(..., {allowNewline:true})`
→ `commitPlainText` raw range + break expansion
→ `applySourceTransaction` → `kernel.doc.text`
→ `verifyPlainTextProjection`: `diffReplaceRange(newDoc, parse(kernel.doc.text))`

**The crux was real, and it was a double conversion.** Two bugs sat on the same
inserted slice, in opposite directions:

1. `plainSliceText`'s `allowNewline` branch had an explicit `if (/\r/.test(text))
   return null` (old `editor-kernel-gateway.js:56`). Post-patch the bridge
   *always* hands `\r\n` for a CRLF block, so **every** CRLF code slice would
   have been rejected — the un-narrowing alone would have produced a
   permanently unwritable block (fail-closed, not corruption, but useless).
2. Had that guard been lifted naively, `commitPlainText`'s expansion was
   `insertText.split('\n').join(lineEnding + linePrefix)`. Applied to the
   bridge's `"X\r\nY"` with `lineEnding === '\r\n'` this yields
   `"X\r" + "\r\n" + "Y"` — **a lone `\r` injected into the source**, exactly
   the corruption family this whole line of work is about.

### ADR — who owns the spelling

The bridge normalizes; the gateway **proves and prefixes, never re-spells**:

- every break in the slice (`/\r\n|\r|\n/`) must **equal** `charMap.lineEnding`,
  otherwise refuse (`KERNEL_CODES.UNMAPPED`);
- the only rewrite the gateway performs is inserting `charMap.linePrefix` after
  each break (needed for quoted/indented fences; `buildCodeMap` requires every
  content line to reproduce the prefix byte-for-byte).

For LF blocks this is byte-identical to the previous behavior
(`split('\n').join('\n' + prefix)`), so LF documents are untouched.

### Residual fail-closed shapes (deliberate)

| shape | reachable? | why refused |
|---|---|---|
| bare `\n` break in a CRLF / lone-`\r` block | yes — only when the block's **current** text holds no `\r` (single-line or empty fence in a CRLF file): the bridge's `hasCarriageReturn` fast path then delegates to the vendored `forwardUpdate`, which can only emit `\n` (`Text.toString()` joins with `\n`) | committing `\r\n` to raw while PM holds `\n` passes the kernel but fails `verifyPlainTextProjection` on **every** such commit → repair-reconcile churn, the P3-4 symptom. Refusing keeps bytes and view in lockstep. Plain typing/deleting in such a block is unaffected. |
| `\r`-bearing break in an LF block | no (bridge only converts for `\r`-containing blocks) | unknown provenance; fail closed |
| mixed-ending fence interior | no | `buildCodeMap` already fails closed → `charMap === null` → block non-editable |
| mermaid / latex / mdast `math` | n/a | unchanged: `READONLY_CODE_LANGUAGES` + `md.type === 'math'` still gate these |

Closing the first residual would require teaching the bridge the block's *raw*
line ending (which lives in the kernel, not in the PM node) — a new cross-module
seam. Out of scope here; recorded as a follow-up candidate.

---

## 4. Changes

**Production (2 files):**
- `src/renderer/src/components/editor-kernel-projection-map.js` — removed the
  `lineEnding !== '\n'` gate; replaced the 65-line ADR with a ~35-line one
  recording the identity measurements and pointing at the new gateway guard.
- `src/renderer/src/components/editor-kernel-gateway.js` — `plainSliceText`'s
  `allowNewline` branch no longer rejects `\r`; `commitPlainText`'s expansion
  now matches breaks with `/\r\n|\r|\n/`, requires each to equal
  `charMap.lineEnding`, and only appends `linePrefix`.

**Tests (4 files):**
- `scripts/test-kernel-projection-map.mjs` — Case 16b rewritten (CRLF editable +
  the explicit `content.size === visibleLength` identity + raw offsets across
  the break); new Case 16c (lone `\r`) and 16d (quoted CRLF fence, prefix-span).
- `scripts/test-kernel-gateway.mjs` — Case 28 rewritten into 4 sub-cases
  (single-char edit, `\r\n` multi-line insert, cross-line-join delete, bare-`\n`
  refusal) + 28b (quoted CRLF prefix expansion), 28c (lone `\r`, both refusals),
  28d (LF mirror guard + unchanged LF behavior). Every success asserts
  `!/\r(?!\n)/` on the committed bytes.
- `scripts/test-kernel-mode-headless.mjs` — Case 13 rewritten end-to-end:
  commit is byte-exact CRLF, **zero `projection-mismatch`**, bare-`\n` still
  vetoed with the `cm-veto-resync` defense, no global lockout. Case T5b:
  `isCmBlockEditable` now `true` for CRLF, with a `mermaid` negative control.
- `scripts/test-codeblock-crlf-ui.mjs` — new **stage K**.

**Docs:** `docs/transaction-source-sync-architecture.md` (ADR rewritten),
`docs/ai-handoff.md` (§5.2d coverage/blocked lists, §5.2e follow-up closed),
`guide/basics/rich-and-source.md` (supported/blocked lists).

### Why stage K went into `test-codeblock-crlf-ui.mjs`

CRLF is already that script's subject: the fixture, the LF-projection source
assertion (a textarea can never *display* `\r`), the uniform-CRLF disk
expectation and the "no lone `\r` / no bare `\n`" property assertions all exist
there. Adding a CRLF document to `test-kernel-codeblock-ui.mjs` would have
duplicated all of it. It also puts the contrast in one file: the legacy stages
document what the preservation pipeline guarantees, stage K the stricter
byte-exact guarantee the kernel gives on the same bytes.

Stage K: rich → enable kernel → assert no `attach-unmappable` → click the CRLF
fence's last line → type `KTAIL` → **reset the diagnostics buffer** → `Enter` →
type `KNEXT` → assert zero `projection-mismatch` / zero `cm-veto-resync` →
assert the CM view has exactly 5 lines (no phantom blanks) → source assert →
save → disk is byte-exact uniform CRLF (+ no lone `\r`, no bare `\n`) → full
quit → cold reopen → byte-exact.

### One measured find worth recording (pre-existing, NOT CRLF)

The diagnostics-buffer reset above is deliberate. The **first kernel commit in
any heading-bearing document** reports one `projection-mismatch` whose diff is
exactly the heading node: Crepe's heading plugin stamps a slug `attrs.id` onto
the live node that `parse(kernel.doc.text)` does not reproduce. Measured via a
temporary debug hook:

```
live  : {"type":"heading","attrs":{"id":"crlf-代码块测试","level":1}, …}
parsed: {"type":"heading","attrs":{"id":"","level":1}, …}
diff  : {"from":0,"to":12,"insertFrom":0,"insertTo":12}
```

It is one-shot (the repair reconcile clears the id) and CRLF-independent — the
same LF fixture in `test-kernel-codeblock-ui.mjs` has a heading too. It is
**not** a regression from this change and is out of scope; flagged here because
it makes "assert zero projection-mismatch from session start" impossible in any
heading-bearing UI fixture, and because it is a real (if harmless) source of one
repair reconcile per session. Worth a follow-up.

---

## 5. Gates

| gate | result |
|---|---|
| `npm run test:source-kernel` | PASS |
| `npm run test:kernel-headless` | PASS |
| `npm run build` | PASS |
| `npm run test:kernel-codeblock-ui` ×2 consecutive | PASS, PASS |
| `npm run test:codeblock-crlf-ui` | PASS (incl. new stage K) |
| `npm run test:kernel-ui` (mode/ime/nodeview/codeblock/marks) | PASS |
| `npm run test:kernel-mode-ui` | PASS |
| `npm run guide:check` | PASS |
