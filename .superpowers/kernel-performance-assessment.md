# Source-kernel performance assessment (measurement only)

Date: 2026-08-17 · Branch: `fix/rich-source-sync-architecture` · Machine: Apple M4 Pro (arm64), Node v24.12.0, Electron build in `out/`.

**Scope.** Measurement only — no product code was changed. Probes lived in `/tmp/hmperf/` and were deleted afterwards; every number below comes from calling the real modules (`lib/source-kernel/*`, `editor-kernel-projection-map.js`, `editor-kernel-gateway.js`, `editor-kernel-reconciler.js`, `markdown-source-preservation.js`) or from the real built app over CDP.

**Headline.** The kernel route is *not* slower than legacy — it is ~0.5× headless and ~0.85–1.0× in the real app. But both are far outside the one-frame goal: in the real app a single keystroke blocks the main thread for **~140 ms at 30 KB** and **~450–530 ms at 100 KB**, and the frame budget (16 ms) is crossed at roughly **3–5 KB of document**. The cost is ~95 % full-document re-parse + full-document character-map rebuild, paid 2× per keystroke and 4–6× per structural/mark/link/image operation. Separately, **kernel mode cannot attach at all above 120 000 chars** (`CHUNK_THRESHOLD`), so today's kernel window is 0–120 KB and every larger document silently falls back to legacy.

---

## 1. Methodology

### 1.1 Corpus

Deterministic (seeded LCG) synthetic Markdown at ~10 KB / 50 KB / 200 KB / 1 MB. Block mix per document: ~60 % prose paragraphs, 10 % lists (bullet + ordered), 10 % fenced `js` code, 8 % GFM tables, 8 % headings, 4 % blockquotes, 3 % block math, 2 % standalone images. Paragraphs carry realistic inline decoration: `**strong**`, `*em*`, `` `code` ``, `[link](url)`, `$E=mc^2$`, `==highlight==`, `<span>…</span>`. Text is ~50 % CJK / 50 % ASCII (CJK is the app's primary audience and is the more expensive parse).

```js
// /tmp/hmperf/corpus.mjs (essential shape; seeded LCG omitted)
export function makeCorpus(targetChars, seed = 42, opts = {}) {
  // blocks pushed until size >= targetChars, joined with '\n\n', final block a
  // plain paragraph (so @milkdown/plugin-trailing adds no synthetic node).
  //   n % 12 === 1        -> '## 小节标题 n'
  //   r < 0.60            -> paragraph() (prose + inline decoration, see above)
  //   r < 0.70            -> 3-6 item bullet/ordered list
  //   r < 0.80            -> ```js fence, 4-11 lines
  //   r < 0.88            -> GFM table, 3-5 rows + alignment delimiter row
  //   r < 0.92            -> '> ' blockquote
  //   r < 0.95            -> '$$\n\\sum…\n$$'
  //   r < 0.97            -> '![示意图 n](./images/fig-n.png)'
}
```

Resulting documents: 10 087 / 50 164 / 200 060 / 1 000 114 chars.

### 1.2 Headless harness

The kernel needs a ProseMirror doc that pairs with the raw source. The probe built one with the hand-written schema from `scripts/test-kernel-projection-map.mjs` (plus the marks Crepe really has: strong / emphasis / strike_through / inlineCode / link / highlight) and an mdast→PM converter that reproduces the live editor shapes: standalone image → `image-block` atom, `$$…$$` → `code_block(language:'LaTeX')`, `$x$` → `math_inline` atom, coalesced inline HTML → one `html` atom (via the shared `inlineHtmlRunAt`), `==x==` → a highlight **mark** over the inner text, GFM table → the 4-level PM shape. Every measured document was asserted to produce a non-null `buildProjectionMap` (10 KB: 256 pairs / 214 with charMaps; 200 KB: 5 467 / 4 333; 1 MB: 26 443 / 21 044), i.e. the numbers describe the *healthy* kernel path, not a degraded one.

Timing: `performance.now()` around each call, 3 warm-up runs, then either ≥400 ms of samples or a fixed 3–5 iterations for the very large cases; **median** reported (means and n are within a few percent unless noted).

**The one proxy.** The editor's own `parse` (Milkdown `parserCtx`) cannot be constructed outside Electron, so the headless probe substituted `parseKernelMarkdown` + the highlight pass + the mdast→PM walk. That is a **lower bound**: the real Crepe parse additionally runs the preset transformers, frontmatter, image-block/math rewrites and node-view attrs. §4 calibrates the gap with real-app measurements (real ≈ 3–4× the proxy).

### 1.3 Real-app harness

Built app launched via `scripts/lib/electron-test-app.mjs` with a synthetic file as an argument; kernel mode enabled through the status-bar caret button (`.block-switch-caret-btn` → `.block-menu-item`), exactly as `scripts/test-kernel-mode-ui.mjs` does. Per-keystroke cost measured with the browser's own long-task observer:

```js
window.__perfObs = new PerformanceObserver((l) => { for (const e of l.getEntries())
  window.__perf.push({ t: Math.round(e.startTime), d: Math.round(e.duration) }) })
window.__perfObs.observe({ entryTypes: ['longtask'] })
```

then one `Input.dispatchKeyEvent` char per 2.5 s, correlating each long task with the recorded keydown timestamp. This measures *main-thread blocking*, which is the frame-budget question. `window.__hmKernelDiagnostics` was read to prove the tab was really attached (no `attach-unmappable`).

---

## 2. Per-keystroke cost (ordinary character insert, kernel mode)

Median ms, headless, caret in the middle editable paragraph. Route = `classifyTransactions` → `commitPlainText` → `bindMap`(`buildProjectionMap`) → `verifyPlainTextProjection`(`parse` + `diffReplaceRange`), i.e. exactly `editor-kernel-mode.js`'s `plain-text` case.

| phase | 10 KB | 50 KB | 200 KB | 1 MB |
|---|---:|---:|---:|---:|
| 1 `classifyTransactions` | 0.000 | 0.000 | 0.000 | 0.000 |
| 2 `commitPlainText` (map lookup + splice) | 0.002 | 0.008 | 0.054 | 0.28 |
| 2a  └ `applySourceTransaction` alone | 0.001 | 0.001 | 0.024 | 0.17 |
| 3 `bindMap` → `buildProjectionMap` | **5.5** | **33.3** | **188** | **2 446–2 678** |
| 3a  ├ `buildSyntaxIndex` (parse+lines+blocks+highlight) | 4.9 | 27.7 | 111 | 786 |
| 3b  │  └ remark `parse` alone | 3.9 | 25.1 | 113 | 791 |
| 3c  └ zip + `buildCharacterMap` for every block | ~0.6 | ~5 | **103** | **~1 660** |
| 4 `verifyPlainTextProjection` → `parse` (proxy) | **4.1** | **26.1** | **113–129** | **779–807** |
| 4a  └ `diffReplaceRange` | 0.034 | 0.168 | 0.70 | 6.6 |
| **TOTAL (headless)** | **9.6** | **59.6** | **~318** | **~3 230** |

Dominant term at every size: **full-document re-parse, twice** (once inside `bindMap`'s `buildSyntaxIndex`, once in `verify`), plus the **full-document character-map rebuild** (3c), which becomes co-dominant from 200 KB and superlinear at 1 MB (5× the bytes → 16× the time: `units[]` arrays plus two `Map`s per block, 844 k units at 1 MB).

Everything the kernel itself computes per keystroke — classification, position mapping, the byte splice — is **< 0.3 ms even at 1 MB**, i.e. ~0.01 % of the route.

---

## 3. Per-operation cost (200 KB document, headless medians)

Costs derived by measuring each real function in the real call order. "Parses" counts full-document parses of the same revision's text.

| operation | full-doc parses | measured pieces | total |
|---|---:|---|---:|
| plain keystroke / **table cell edit** | 2 | `bindMap` 188 + verify 113 + rest 0.8 | **~318 ms** |
| **attach** (`buildProjectionMap` at tab open) | 1 | 191 (parse 111 + zip/charMaps 103) | **~190–214 ms** |
| **undo / redo** | 3 | verify-parse 113 + 2 × projection map 374 | **~510 ms** |
| **structural Enter** | 4 | `buildSyntaxIndex` 110 + `routeStructuralKey` ~0 + chain 483 | **~593 ms** |
| **mark toggle** (bold) | 4 | `buildSyntaxIndex` 110 (`toggleInlineMark` itself 0.012) + chain 483 | **~593 ms** |
| **image attr** (`alt`) | 5 | `buildSyntaxIndex` 110 + `setImageAttrs` 229 + `bindMap` 188 + verify 113 | **~640 ms** |
| **link edit** (wrap) | 6 | `buildSyntaxIndex` 110 + `applyLinkEdit` 228 + chain 483 | **~820 ms** |

Notes:

* The *commands* are free; their callers are not. `toggleInlineMark` = **0.012 ms**, `routeStructuralKey` ≈ 0 ms — the whole cost is the `buildSyntaxIndex(kernel.doc.text)` its caller builds for it plus the `applyKernelTransaction` chain.
* `setImageAttrs` (229 ms) and `applyLinkEdit` (228 ms) are each **two** full parses: one for the candidate bytes (a genuine proof) and one for a **baseline signature of `doc.text` — text the caller already has a parsed index for**.
* The `applyKernelTransaction` chain (`parse` 113 + `buildProjectionMap` 184 + `diffReplaceRange` 0.7 + `bindMap` `buildProjectionMap` 187 = **483 ms**) builds **the same projection map twice** for the same text/doc pair (once as `nextMap` for the `requireMap`/anchor check, once as `bindMap` after the reconcile).
* Scaling: the same chain is 12.4 ms at 10 KB and 89.6 ms at 50 KB.

---

## 4. Real-app measurements (calibration + ground truth)

Built app, kernel mode enabled through the UI, main-thread blocking per keystroke (long tasks, 3 keystrokes, first keystroke excluded as warm-up):

| document | legacy | kernel | kernel split |
|---|---:|---:|---|
| 30 KB (30 199 chars) | **~130–140 ms** | **~135–142 ms** | ~83 ms synchronous commit + ~55 ms `markdownUpdated` serialize |
| 100 KB (100 092 chars) | **~530 ms** (55 ms input task + 475 ms deferred `markdownUpdated`) | **~430–465 ms** | ~250 ms synchronous commit + ~185 ms `markdownUpdated` serialize |

Three facts fall out:

1. **Real ≈ 3.5–4.5× the headless proxy.** Headless predicts ~150 ms for a 100 KB kernel keystroke; the real synchronous task is ~250 ms and the total ~450 ms. The gap is the real Milkdown parse (≈3× the proxy), plus DOM/React work.
2. **Kernel mode still pays Milkdown's serializer.** `crepe.on(markdownUpdated)` is registered unconditionally (`Editor.jsx:1347`); in kernel mode the callback returns early *after* Milkdown has already serialized the whole document. That is the second long task above — ~40 % of the kernel keystroke cost at 100 KB — and it is pure waste for an attached tab (a *degraded* tab genuinely needs it).
3. **Kernel ≈ legacy, not worse.** Kernel/legacy = 1.0 at 30 KB, 0.85 at 100 KB (headless: 0.52 at 50 KB, 0.51 at 200 KB — the headless ratio flatters the kernel because it omits the serializer that kernel mode also pays).

**Legacy baseline, headless** (`markdownUpdated` route: serialize → `preserveRichMarkdownSource` → parse candidate → `areDurablyEquivalent`), median ms:

| phase | 10 KB | 50 KB | 200 KB |
|---|---:|---:|---:|
| L0 serialize whole doc (proxy: `mdast-util-to-markdown`) | 1.1 | 5.9 | 23.7 |
| L1 `preserveRichMarkdownSource` (preserved=true) | 12.5 | 88.6 | **466** |
| L2 `parse(candidate)` (same proxy as kernel verify) | 4.1 | 32.0 | 112 |
| L3 `areDurablyEquivalent(parsed, expectedDoc)` | 0.8 | 4.7 | 21.5 |
| **LEGACY TOTAL** | **18.5** | **131** | **623** |

(The keystroke was placed inside a middle top-level paragraph, the ordinary typing case; at an arbitrary byte offset L1 varies by ±30 %.)

---

## 5. The linear scans over `blockPairs` — measured, and *not* the problem

`pairForContentPos` / `rawToPmPos` walk `blockPairs` linearly (flagged since plan 2). Measured worst case (target = the **last** editable pair, i.e. a full scan):

| | 10 KB (256 pairs) | 50 KB (1 387) | 200 KB (5 467) | 1 MB (26 443) |
|---|---:|---:|---:|---:|
| `pmPosToRaw` @ first pair | 0.000 | 0.000 | 0.000 | 0.000 |
| `pmPosToRaw` @ middle pair | 0.000 | 0.002 | 0.008 | 0.038 |
| `pmPosToRaw` @ **last** pair | 0.000 | 0.004 | **0.016** | **0.081** |
| `rawToPmPos` @ last pair (scan + in-block unit walk) | 0.008 | 0.045 | **0.194** | **3.49** |

Split of `rawToPmPos`: the in-block unit walk is `O(units in one block)` ≈ the cost of `buildCharacterMap` for one paragraph (**0.003 ms** at 200 KB); the rest — **≈ 98–99 %** — is the pair scan (each skipped pair costs two `visibleToRaw` `Map` lookups). So the scan *is* the cost of `rawToPmPos`, but `rawToPmPos` is 0.06 % of a 200 KB keystroke route and 0.1 % at 1 MB, and it runs at most twice per operation (caret restore). **Indexing `blockPairs` is a correct but low-value optimization** until the parse/charMap costs are addressed.

---

## 6. Frame budget

Target (spec): "用户输入到投影更新的目标延迟小于一帧" = 16 ms.

* **Headless**, crossed between 10 KB (9.6 ms) and 50 KB (59.6 ms) → ≈ **16 KB**.
* **Real app**, the number that matters: 30 KB already costs ~140 ms → linear back-extrapolation puts the crossover at ≈ **3–5 KB**. In practice **no real document meets the goal today**; the smallest documents (a few KB) are the only ones under a frame.
* The phase that pushes it over is, in order: (1) the `verify` parse and (2) `bindMap`'s parse — one full remark/Milkdown parse each — then (3) the document-wide `buildCharacterMap` pass. Kernel bookkeeping proper never contributes more than 0.3 ms.

---

## 7. Blocker found while measuring: kernel mode cannot attach above `CHUNK_THRESHOLD`

Real app, same corpus, attach only (`window.__hmKernelDiagnostics` after enabling kernel mode):

| document | result |
|---|---|
| 30 199 chars | attaches (no diagnostics) |
| 60 221 chars | attaches |
| 100 092 chars | attaches |
| 115 347 chars | attaches |
| **130 163 chars** | **`attach-unmappable`** → whole tab degrades to legacy |
| 200 060 chars (also with math/images/HTML/tables removed) | **`attach-unmappable`** |

The boundary is `CHUNK_THRESHOLD = 120000` (`editor-chunked-parse.js:15`). Above it, `Editor.jsx` creates Crepe with chunk 0 and appends the remaining chunks (`appendChunks`), and `attachAfterCreate()` — although correctly deferred until after the append — then finds a PM doc that does not pair with a whole-document kernel parse. Removing constructs does not help, so it is the chunked append itself, not any single syntax domain.

Consequences for "全量默认启用": with heavy docs (> 400 K chars, > 50 K lines, or > 150 consecutive non-blank lines) already forced to the plain textarea, **the kernel's real operating window today is 0–120 KB**, and the 120 KB–400 KB band degrades *silently* to legacy (a toast, then legacy fidelity semantics). This must be either fixed or made explicit before default-on, independently of performance.

---

## 8. Dominant costs, ranked

1. **Full-document parse, paid 2× per keystroke and 4–6× per structural/mark/link/image operation.** 113 ms per parse at 200 KB headless, ~3× that in the real app. Everything else is rounding error by comparison.
2. **Document-wide `buildCharacterMap`** inside every `buildProjectionMap` (103 ms at 200 KB, ~1.7 s at 1 MB, superlinear). One block costs 0.003 ms — the pass is ~35 000× larger than what a single edit needs.
3. **Duplicate work at the same revision**: `buildProjectionMap` called twice per structural op on the same text/doc; `buildSyntaxIndex(kernel.doc.text)` built by the caller and then again inside `buildProjectionMap`; `setImageAttrs`/`applyLinkEdit` re-parsing `doc.text` for a baseline the caller already has.
4. **Milkdown's `markdownUpdated` serialization still running in kernel mode** (~40 % of a real 100 KB keystroke) for a callback that only pushes a diagnostic.
5. **`preserveRichMarkdownSource`** — legacy only, but it is 466 ms at 200 KB and is the reason legacy is ~2× kernel headless.
6. **Linear `blockPairs` scans** — real but ≤ 0.1 % of any route (see §5).

---

## 9. Prioritized optimizations

Ordered by (value ÷ risk). "Safe" = does not change what is proven before bytes are committed or before the view is trusted.

| # | optimization | est. saving | effort | risk | proof impact |
|---|---|---|---|---|---|
| 1 | **Don't serialize in kernel mode**: register `markdownUpdated` only for tabs that are (or become) degraded, instead of registering unconditionally and returning early inside the callback. | ~40 % of the real per-keystroke cost (~185 ms @ 100 KB) | S–M | M | **Safe.** Kernel mode already treats the callback as diagnostics-only. The only care point is the degraded path, which publishes through this handler — decide at `attachAfterCreate()` and keep the legacy registration for degraded tabs. |
| 2 | **Reuse the map you just built.** `applyKernelTransaction` builds `nextMap` from (`result.doc.text`, `parsed`), reconciles, then `bindMap(view.state.doc)` rebuilds the identical map. Reuse `nextMap` when `view.state.doc.eq(parsed)` (a cheap structural compare vs a 190 ms rebuild). | ~190 ms per structural / mark / link / undo op @ 200 KB (≈ ⅓ of Enter) | S | L | **Safe** if guarded by the `eq` check — the map is still the one proven against the committed bytes. |
| 3 | **Memoize the kernel parse by exact string** (small LRU, cap 2–4), precedent already in the repo: `lib/markdown-preservation/roundtrip.js`'s `KEY_CACHE`. Collapses caller-built `buildSyntaxIndex(kernel.doc.text)` + `buildProjectionMap`'s internal parse of the same text, and the baseline parses inside `setImageAttrs` / `applyLinkEdit`. | ~110 ms on Enter/mark/undo, ~110 ms on image, ~220 ms on link (@200 KB) | S | L | **Safe.** `parseKernelMarkdown` is pure; keying on the exact string cannot serve a stale tree. Candidate-bytes parses (the actual proofs) are untouched. Watch memory: one mdast for a 1 MB doc is large — cap by entries *and* by input length. |
| 4 | **Lazy / per-block character maps.** Build a pair's `charMap` (and its two content proofs) on first access rather than eagerly for every block. | ~50 % of `buildProjectionMap` (103 ms @ 200 KB, ~1.7 s @ 1 MB) — halves both attach and every `bindMap` | M | M | **Safe.** Every writer already resolves through `pairAt`/`rawToPmPos`/`blockPairs`, so the size + endpoint proofs still run before any byte is written — they just run for the blocks actually touched. Requires auditing the few whole-map consumers (`degradedPairAt`, `editablePairForRange`, `virtualBlockAt`) so they don't force materialization of everything. |
| 5 | **Debounce the verify parse.** `verifyPlainTextProjection` is *post-hoc repair*, not a gate — the PM transaction has already been applied when it runs, and its remedy is an async `queueMicrotask` reconcile. Coalesce it (e.g. one run ~150–300 ms after the last keystroke, plus forced runs before save / flush / mode switch / blur / any structural op). | one full parse per keystroke removed from a typing burst (~113 ms headless, ~350 ms real @ 200 KB) | M | M | **Safe for fail-closed vetoes** (none of them consult it), but it *does* lengthen the window in which a projection mismatch is undetected, from one microtask to one debounce interval. Must keep the forced-run list exhaustive or a mismatch could reach disk. |
| 6 | **Incremental projection map for provably local plain-text commits**: instead of re-parsing, shift the raw offsets of pairs after the edit by the byte delta and rebuild only the edited pair's `charMap`; fall back to a full rebuild on any structural commit and on the (debounced) verify. | keystroke route → ~0.2 ms at any size; this is the only change that reaches the 16 ms goal | L | **H** | **Weakens a proof.** Today the post-commit map is derived from a fresh parse of the committed bytes; this replaces that with "the edit was proven local". Needs a conservative predicate (no markdown-active bytes inserted/removed, strictly inside one paragraph / table cell / code-block interior, not at a block edge, no CRLF boundary) *and* the verify pass as the safety net. Do it only after 1–5 land and only with the locality predicate pinned by tests. |
| 7 | **Index `blockPairs` by position** (sorted array + binary search, or an interval index) for `pairForContentPos` / `rawToPmPos`. | 0.02–3.5 ms per lookup (only visible at 1 MB) | S | L | **Safe** — pure lookup restructuring. Low value until 1–6 land; then it becomes visible. |
| 8 | **Fix (or explicitly gate) attach above `CHUNK_THRESHOLD`** (§7). Either make the chunked append produce a doc the whole-document kernel parse pairs with, or re-parse once at the end of the append, or refuse kernel mode above the threshold with an honest message. | correctness, not ms — but it is a hard precondition for default-on | M–L | M | Not a perf change. Today the failure is silent-by-toast and the whole 120–400 KB band runs legacy. |

**What the safe set alone buys** (1 + 2 + 3 + 4 + 5, no proof weakened), estimated at 200 KB headless: keystroke ~318 ms → ~95 ms synchronous (one parse for `bindMap` with lazy charMaps) with the verify parse moved off the burst; structural Enter ~593 ms → ~230 ms; link edit ~820 ms → ~340 ms; attach ~200 ms → ~115 ms. In real-app terms that is roughly 450 ms → ~150 ms per keystroke at 100 KB. Still ~10× the frame budget: **only #6 (incremental map) closes that gap**, and it is the one that trades away a proof.

## 9b. Addendum (2026-08-21): the safe set landed

Optimizations **#1–#5 are all in** (branch `perf/kernel-large-doc`): #1 in
`5d35a87`; #2 map reuse (`bindMap`'s `pmDoc.eq(parsed)` adoption guard,
pinned by headless Case PERF-1); #3 exact-string parse memo (LRU 8 in
`syntax-index.js`, index/raw caches deliberately separate because
`injectHighlightNodes` mutates its tree); #4 lazy per-block charMaps (proofs
run at first access; `pairForContentPos`/`rawToPmPos` pre-filter via
content.size / mdast span; the read-only status count moved to a 150 ms
trailing debounce); #5 debounced verify (200 ms; synchronous for gateway-
rewritten commits (`rewrote`), placeholder-session ends, and the
map-repair path; NEVER fired mid-session — Case PERF-3 pins the regression
test-kernel-mode-ui caught live). #6 (incremental map) remains deliberately
not done; #7 unnecessary after #4's pre-filters; #8 unchanged (honest
refusal above `CHUNK_THRESHOLD`).

**A/B, same machine / method / 100 KB corpus (§1.3), built app, kernel
mode:** isolated keystroke synchronous block ~257–264 ms → **~130 ms**
(−49 %), with ~106 ms of deferred verify+status work landing 200 ms later,
off the input path; 12-key burst (70 ms cadence): total long-task time
2 562 ms → 1 197 ms (−53 %), peak single task 261 → 139 ms. The §9
estimate ("450 → ~150 ms real at 100 KB") held. The 16 ms frame goal still
requires #6, which trades away a proof.

## 10. Caveats

* The headless `parse` is a proxy (§1.2) and underestimates the real Milkdown parse by ≈3× (measured in §4). All *ratios between kernel phases* are unaffected; absolute headless totals should be multiplied by ~3.5–4.5 for real-app expectations.
* The corpus is CJK-heavy and construct-dense; remark throughput measured on it is ~1.8 MB/s. A pure-ASCII prose document parses faster, so the numbers here are the pessimistic end of "realistic".
* All numbers are Apple M4 Pro. A 2019-era laptop should be assumed 2–3× slower.
* `preserveRichMarkdownSource`'s 466 ms at 200 KB is sensitive to where the keystroke lands (±30 %); the kernel numbers are not (they are size-driven, not position-driven).
* The 1 MB column is scaling data only: such documents cannot enter kernel mode today (§7).
