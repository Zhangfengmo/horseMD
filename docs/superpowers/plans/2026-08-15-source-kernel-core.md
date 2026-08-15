# 源码权威内核 · 计划一：纯内核 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 spec（`docs/superpowers/specs/2026-08-14-source-authoritative-editor-kernel-design.md`）中与 UI 无关的纯源码内核：MarkdownDocument、LosslessSyntaxIndex、SourceCharacterMap、第一阶段结构命令（Enter/Tab/Shift+Tab/Backspace/Delete/任务勾选）、源码历史，以及种子化状态机测试。

**Architecture:** 全部代码放在 `src/renderer/src/lib/source-kernel/` 下，纯 ESM、零 Electron/React/Milkdown 依赖，`node scripts/test-*.mjs` 直接 import（与 `lib/markdown-preservation/` 同一模式）。解析用 `unified().use(remarkParse).use(remarkGfm)` 且**只 `parse` 不 `runSync`**（保 position 有效，先例：`table-source-parse.js:318-321`）。每个命令是纯函数：输入 `{doc, index, offset}`，输出事务或稳定错误码，绝不猜测提交。计划二（编辑器集成：RichProjection/Reconciler/Gateway/CompositionSession/UI 开关）在本计划全部通过后单独撰写。

**Tech Stack:** unified 11 + remark-parse 11 + remark-gfm 4、decode-named-character-reference、node:assert/strict。

## Global Constraints

（每个任务的要求都隐含包含本节；来自 spec 的不变式）

- `MarkdownDocument.text` 是唯一持久化真相；所有偏移量为 **UTF-16 code unit** 偏移。
- 每个事务携带 `baseRevision`；`baseRevision !== doc.revision` 必须拒绝（`stale-revision`）。
- 未被事务 edits 覆盖的原始字节必须逐字节保持不变。
- 内核不得生成 `&#x20;`、`&nbsp;`、HTML 注释或私有零宽哨兵来表达空白。
- 不使用全文唯一子串、重复文本 ordinal 或启发式修复来决定写入位置。
- 无法证明映射的输入必须返回 `{ ok: false, code }` 并保留原文，不得猜测提交。
- 错误码稳定集合：`stale-revision`、`invalid-range`、`unmapped-selection`、`unsupported-structure`、`not-structural`。
- 行尾风格（LF/CRLF/lone-CR）逐行保真；新插入行沿用所在行的行尾，文档末行无行尾时用文档主导行尾（无则 `\n`）。
- `src/renderer/src/lib/source-kernel/**` 不得 import `electron`、`react`、`@milkdown/*` 或 `../../components/**`。
- 复用而非复制：引用 `lib/markdown-preservation/block-prefix.js`（QUOTE_PREFIX）与 `lib/markdown-preservation/roundtrip.js`（markdownComparisonKey，仅测试用）。
- 新列表 marker 沿用用户/当前项的真实 `-`/`*`/`+`/`1.`/`1)`；有序新兄弟项写当前显式编号 +1，不重排其他兄弟项。
- 提交信息遵循仓库惯例（`feat(source-kernel): …` / `test(source-kernel): …`）。

---

### Task 1: MarkdownDocument（事务提交 + 逆事务）

**Files:**
- Create: `src/renderer/src/lib/source-kernel/markdown-document.js`
- Create: `scripts/test-source-kernel-document.mjs`

**Interfaces:**
- Consumes: 无（叶子模块）。
- Produces:
  - `createMarkdownDocument(text) -> { text: string, revision: 0 }`
  - `applySourceTransaction(doc, txn) -> { ok: true, doc, edits, inverse, selection } | { ok: false, code: 'stale-revision'|'invalid-range' }`
  - 事务形状（后续所有命令都产出这个形状）：`{ baseRevision, edits: [{from, to, insert}], intent, selection? }`；兼容 spec 的单编辑简写 `{ baseRevision, from, to, insert, intent, selection? }`。
  - `inverse` 是可直接用于 undo 的事务（`baseRevision` 为新 revision）。

- [ ] **Step 1: Write the failing test**

`scripts/test-source-kernel-document.mjs`：

```js
import assert from 'node:assert/strict'
import {
  createMarkdownDocument,
  applySourceTransaction
} from '../src/renderer/src/lib/source-kernel/markdown-document.js'

const doc = createMarkdownDocument('# 标题\n\n段落\n')
assert.equal(doc.revision, 0)

// 单编辑简写：在“段落”后插入文本
let r = applySourceTransaction(doc, {
  baseRevision: 0, from: 12, to: 12, insert: '甲', intent: 'insert-text'
})
assert.equal(r.ok, true)
assert.equal(r.doc.text, '# 标题\n\n段落甲\n')
assert.equal(r.doc.revision, 1)
assert.deepEqual(r.selection, { anchor: 13, head: 13 })

// 过期 revision 必须拒绝且不产生新文档
const stale = applySourceTransaction(doc, { baseRevision: 5, from: 0, to: 0, insert: 'x' })
assert.deepEqual(stale, { ok: false, code: 'stale-revision' })

// 非法范围
assert.deepEqual(
  applySourceTransaction(doc, { baseRevision: 0, from: 3, to: 2, insert: '' }),
  { ok: false, code: 'invalid-range' }
)
assert.deepEqual(
  applySourceTransaction(doc, { baseRevision: 0, from: 0, to: 999, insert: '' }),
  { ok: false, code: 'invalid-range' }
)

// 多编辑：升序、不重叠、一次 revision 递增；逆事务可还原到逐字节相同
const multi = applySourceTransaction(doc, {
  baseRevision: 0,
  edits: [
    { from: 0, to: 1, insert: '##' },   // '#' -> '##'
    { from: 7, to: 9, insert: 'AB' }    // '段落' -> 'AB'
  ],
  intent: 'test-multi'
})
assert.equal(multi.ok, true)
assert.equal(multi.doc.text, '## 标题\n\nAB\n')
assert.equal(multi.doc.revision, 1)
const undo = applySourceTransaction(multi.doc, multi.inverse)
assert.equal(undo.ok, true)
assert.equal(undo.doc.text, doc.text)

// 重叠 edits 拒绝
assert.deepEqual(
  applySourceTransaction(doc, {
    baseRevision: 0,
    edits: [{ from: 0, to: 2, insert: '' }, { from: 1, to: 3, insert: '' }]
  }),
  { ok: false, code: 'invalid-range' }
)

console.log('PASS source-kernel document')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-source-kernel-document.mjs`
Expected: FAIL（模块不存在，`ERR_MODULE_NOT_FOUND`）

- [ ] **Step 3: Write minimal implementation**

`src/renderer/src/lib/source-kernel/markdown-document.js`：

```js
// 源码事务内核：MarkdownDocument.text 是唯一持久化真相。
// 本目录（source-kernel）禁止 import electron/react/@milkdown。

export function createMarkdownDocument(text) {
  return { text: String(text ?? ''), revision: 0 }
}

const normalizeEdits = (txn) => {
  if (Array.isArray(txn.edits)) return txn.edits
  return [{ from: txn.from, to: txn.to, insert: txn.insert }]
}

const validEdit = (edit, max) =>
  Number.isInteger(edit.from) && Number.isInteger(edit.to) &&
  edit.from >= 0 && edit.to <= max && edit.from <= edit.to

export function applySourceTransaction(doc, txn) {
  if (txn.baseRevision !== doc.revision) return { ok: false, code: 'stale-revision' }
  const edits = normalizeEdits(txn)
  if (!edits.length) return { ok: false, code: 'invalid-range' }
  let previousEnd = -1
  for (const edit of edits) {
    if (!validEdit(edit, doc.text.length) || edit.from < previousEnd) {
      return { ok: false, code: 'invalid-range' }
    }
    previousEnd = edit.to
  }
  const parts = []
  const inverseEdits = []
  let cursor = 0
  let delta = 0
  for (const edit of edits) {
    const insert = String(edit.insert ?? '')
    const removed = doc.text.slice(edit.from, edit.to)
    parts.push(doc.text.slice(cursor, edit.from), insert)
    inverseEdits.push({
      from: edit.from + delta,
      to: edit.from + delta + insert.length,
      insert: removed
    })
    delta += insert.length - removed.length
    cursor = edit.to
  }
  parts.push(doc.text.slice(cursor))
  const last = edits[edits.length - 1]
  const caret = last.from + String(last.insert ?? '').length +
    (delta - (String(last.insert ?? '').length - (last.to - last.from)))
  const next = { text: parts.join(''), revision: doc.revision + 1 }
  return {
    ok: true,
    doc: next,
    edits,
    inverse: {
      baseRevision: next.revision,
      edits: inverseEdits,
      intent: 'history-invert',
      selection: txn.selection ?? null
    },
    selection: txn.selection ?? { anchor: caret, head: caret }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-source-kernel-document.mjs`
Expected: `PASS source-kernel document`

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/source-kernel/markdown-document.js scripts/test-source-kernel-document.mjs
git commit -m "feat(source-kernel): MarkdownDocument source transactions with inverse"
```

---

### Task 2: LosslessSyntaxIndex（物理行 + 块索引 + 列表项记录）

**Files:**
- Create: `src/renderer/src/lib/source-kernel/syntax-index.js`
- Create: `scripts/test-source-kernel-index.mjs`
- Modify: `package.json`（`remark-gfm` 从 devDependencies 移入 dependencies —— 它已被生产代码 `lib/markdown-preservation/tables.js:1` 引用，这是既有隐患的顺手根治）

**Interfaces:**
- Consumes: `QUOTE_PREFIX` from `../markdown-preservation/block-prefix.js`。
- Produces: `buildSyntaxIndex(text)` 返回：
  - `text`、`tree`（带 position 的 mdast）、`lines: [{ start, end, ending, text }]`（`ending ∈ '\n'|'\r\n'|'\r'|''`；末尾换行会产生一条空的尾行记录）
  - `dominantEnding`（文档主导行尾，无则 `'\n'`）
  - `lineIndexAt(offset) -> number`、`lineAt(offset) -> line`
  - `blockAt(offset) -> { type, start, end, node } | null`（最内层块级节点）
  - `listItemAt(offset) -> item | null`，item 形状：
    `{ start, end, markerLineIndex, quotePrefix, indent, marker, ordered: null|{number, delimiter}, spacing, task: null|{from, to, checked}, taskSpacing, contentStart, listStart, listEnd, depth, empty }`
  - `containerRange(offset) -> { start, end }`（最小可安全重解析容器：最外层 list/blockquote/table/code 祖先的整行范围，否则块本身，否则所在行）

- [ ] **Step 1: Write the failing test**

`scripts/test-source-kernel-index.mjs`：

```js
import assert from 'node:assert/strict'
import { buildSyntaxIndex } from '../src/renderer/src/lib/source-kernel/syntax-index.js'

// 行扫描：LF / CRLF / lone-CR / 末尾换行
{
  const idx = buildSyntaxIndex('a\r\nb\rc\nd')
  assert.deepEqual(idx.lines.map((l) => [l.text, l.ending]),
    [['a', '\r\n'], ['b', '\r'], ['c', '\n'], ['d', '']])
  assert.equal(idx.dominantEnding, '\r\n')
  assert.equal(buildSyntaxIndex('x\n').lines.length, 2) // 尾部空行记录
  assert.equal(buildSyntaxIndex('x\n').dominantEnding, '\n')
}

// 块索引
{
  const src = '# 头\n\n段落甲\n'
  const idx = buildSyntaxIndex(src)
  assert.equal(idx.blockAt(1).type, 'heading')
  assert.equal(idx.blockAt(src.indexOf('段落甲')).type, 'paragraph')
  assert.equal(idx.blockAt(src.indexOf('\n\n') + 1), null) // 块间隙
}

// 列表项记录：bullet + 任务 + 有序 + 嵌套 + 引用内
{
  const src = [
    '- 甲',
    '- [x] 乙',
    '  1) 丙',
    '',
    '> * 丁',
    ''
  ].join('\n')
  const idx = buildSyntaxIndex(src)

  const jia = idx.listItemAt(src.indexOf('甲'))
  assert.equal(jia.marker, '-')
  assert.equal(jia.ordered, null)
  assert.equal(jia.task, null)
  assert.equal(jia.spacing, ' ')
  assert.equal(jia.depth, 0)
  assert.equal(jia.quotePrefix, '')
  assert.equal(jia.empty, false)

  const yi = idx.listItemAt(src.indexOf('乙'))
  assert.equal(yi.task.checked, true)
  assert.equal(src.slice(yi.task.from, yi.task.to), '[x]')
  assert.equal(yi.taskSpacing, ' ')
  assert.equal(src.slice(yi.contentStart, yi.contentStart + 1), '乙')

  const bing = idx.listItemAt(src.indexOf('丙'))
  assert.deepEqual(bing.ordered, { number: 1, delimiter: ')' })
  assert.equal(bing.indent, '  ')
  assert.equal(bing.depth, 1)

  const ding = idx.listItemAt(src.indexOf('丁'))
  assert.equal(ding.quotePrefix, '> ')
  assert.equal(ding.marker, '*')

  // 空项
  const empty = buildSyntaxIndex('- 甲\n- \n')
  const item = empty.listItemAt(6)
  assert.equal(item.empty, true)
}

// containerRange：嵌套列表返回最外层列表整行范围
{
  const src = '前段\n\n- 甲\n  - 乙\n\n后段\n'
  const idx = buildSyntaxIndex(src)
  const range = idx.containerRange(src.indexOf('乙'))
  assert.equal(src.slice(range.start, range.end), '- 甲\n  - 乙\n')
}

console.log('PASS source-kernel syntax index')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-source-kernel-index.mjs`
Expected: FAIL（`ERR_MODULE_NOT_FOUND`）

- [ ] **Step 3: Move remark-gfm to dependencies**

```bash
npm install remark-gfm@^4.0.1 --save --save-exact=false
npm uninstall remark-gfm --save-dev 2>/dev/null || true
```

验证：`package.json` 的 `dependencies` 含 `"remark-gfm": "^4.0.1"`，devDependencies 不再含它。

- [ ] **Step 4: Write minimal implementation**

`src/renderer/src/lib/source-kernel/syntax-index.js` 核心（完整写出，实现者照抄后按测试补齐细节）：

```js
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { QUOTE_PREFIX } from '../markdown-preservation/block-prefix.js'

// 只 parse、不 runSync：transform 插件会改写 mdast，position 将不可信
// （先例：table-source-parse.js buildGfmTableSourceModel）。
const processor = unified().use(remarkParse).use(remarkGfm)

export function scanLines(text) {
  const lines = []
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\n') {
      lines.push({ start, end: i, ending: '\n', text: text.slice(start, i) })
      start = i + 1
    } else if (ch === '\r') {
      const crlf = text[i + 1] === '\n'
      lines.push({ start, end: i, ending: crlf ? '\r\n' : '\r', text: text.slice(start, i) })
      if (crlf) i += 1
      start = i + 1
    }
  }
  lines.push({ start, end: text.length, ending: '', text: text.slice(start) })
  return lines
}

const BLOCKS = new Set(['paragraph', 'heading', 'blockquote', 'list', 'listItem',
  'code', 'table', 'thematicBreak', 'html', 'math'])
const CONTAINERS = new Set(['list', 'blockquote', 'table', 'code'])

const MARKER_RE = /^([ \t]*)([*+-]|\d{1,9}[.)])([ \t]+|$)/
const TASK_RE = /^\[( |x|X)\]([ \t]*)/

export function buildSyntaxIndex(text) {
  const lines = scanLines(text)
  const dominantEnding = lines.find((l) => l.ending)?.ending || '\n'
  const tree = processor.parse(text)

  const blocks = []      // { type, start, end, node, ancestors }
  const items = []       // 列表项记录
  const offsetOf = (point) => point?.offset
  const walk = (node, ancestors) => {
    const start = offsetOf(node.position?.start)
    const end = offsetOf(node.position?.end)
    if (BLOCKS.has(node.type) && Number.isInteger(start) && Number.isInteger(end)) {
      blocks.push({ type: node.type, start, end, node, ancestors: [...ancestors] })
      if (node.type === 'listItem') items.push(buildItem(node, ancestors, start, end))
    }
    const nextAncestors = [...ancestors, node]
    for (const child of node.children || []) walk(child, nextAncestors)
  }

  const lineIndexAt = (offset) => {
    let lo = 0, hi = lines.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lines[mid].start <= offset) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  const buildItem = (node, ancestors, start, end) => {
    const list = ancestors[ancestors.length - 1]           // 直接父 list
    const depth = ancestors.filter((a) => a.type === 'listItem').length
    const line = lines[lineIndexAt(start)]
    const quotePrefix = (line.text.match(QUOTE_PREFIX) || [''])[0]
    const rest = line.text.slice(quotePrefix.length)
    const m = rest.match(MARKER_RE)
    if (!m) return null
    const indent = m[1]
    const marker = m[2]
    const spacing = m[3]
    const markerEnd = line.start + quotePrefix.length + indent.length + marker.length + spacing.length
    let task = null
    let taskSpacing = ''
    let contentStart = markerEnd
    if (node.checked === true || node.checked === false) {
      const t = text.slice(markerEnd).match(TASK_RE)
      if (t) {
        task = { from: markerEnd, to: markerEnd + 3, checked: t[1].toLowerCase() === 'x' }
        taskSpacing = t[2]
        contentStart = task.to + taskSpacing.length
      }
    }
    const markerLineTail = text.slice(contentStart, line.start + line.text.length)
    const singleLine = lineIndexAt(end - 1) === lineIndexAt(start)
    return {
      start, end,
      markerLineIndex: lineIndexAt(start),
      quotePrefix, indent, marker,
      ordered: /^\d/.test(marker)
        ? { number: parseInt(marker, 10), delimiter: marker[marker.length - 1] }
        : null,
      spacing, task, taskSpacing, contentStart,
      listStart: offsetOf(list.position?.start), listEnd: offsetOf(list.position?.end),
      depth,
      empty: singleLine && markerLineTail.trim() === ''
    }
  }

  walk(tree, [])
  const validItems = items.filter(Boolean)

  const within = (b, offset) => offset >= b.start && offset < b.end
  const blockAt = (offset) => {
    let best = null
    for (const b of blocks) {
      if (b.type === 'list' || b.type === 'blockquote') continue
      if (within(b, offset) && (!best || b.start >= best.start)) best = b
    }
    return best ? { type: best.type, start: best.start, end: best.end, node: best.node } : null
  }
  const listItemAt = (offset) => {
    let best = null
    for (const item of validItems) {
      if (within(item, offset) && (!best || item.start >= best.start)) best = item
    }
    return best
  }
  const lineRange = (start, end) => {
    const first = lines[lineIndexAt(start)]
    const last = lines[lineIndexAt(Math.max(start, end - 1))]
    return { start: first.start, end: last.end + last.ending.length }
  }
  const containerRange = (offset) => {
    let top = null
    for (const b of blocks) {
      if (!within(b, offset)) continue
      if (CONTAINERS.has(b.type) && (!top || b.start <= top.start)) top = b
    }
    if (top) return lineRange(top.start, top.end)
    const block = blockAt(offset)
    if (block) return lineRange(block.start, block.end)
    const line = lines[lineIndexAt(offset)]
    return { start: line.start, end: line.end + line.ending.length }
  }

  return {
    text, tree, lines, dominantEnding,
    lineIndexAt,
    lineAt: (offset) => lines[lineIndexAt(offset)],
    blockAt, listItemAt, containerRange
  }
}
```

注意（实现时按测试修正的已知细节）：`buildItem` 在 `walk` 中先于定义被引用——把 `buildItem`、`lineIndexAt` 的声明放在 `walk` 之前（如上顺序调整为 const 函数先声明再 walk）；mdast 的 `blockquote` 内段落的 `blockAt` 应返回 paragraph（内层优先）；块间隙（offset 落在任何块外）返回 `null`。

- [ ] **Step 5: Run test to verify it passes**

Run: `node scripts/test-source-kernel-index.mjs`
Expected: `PASS source-kernel syntax index`

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/lib/source-kernel/syntax-index.js scripts/test-source-kernel-index.mjs package.json package-lock.json
git commit -m "feat(source-kernel): lossless syntax index over raw markdown"
```

---

### Task 3: SourceCharacterMap（字符级边界映射）

**Files:**
- Create: `src/renderer/src/lib/source-kernel/character-map.js`
- Create: `scripts/test-source-kernel-charmap.mjs`

**Interfaces:**
- Consumes: Task 2 的 `buildSyntaxIndex`（测试里用它取块节点）；`decode-named-character-reference`。
- Produces:
  - `buildCharacterMap(text, blockNode) -> map | null`（null = 该块无法证明映射，调用方 fail-closed）
  - map：`{ units: [{ rawStart, rawEnd, width, kind }], visibleLength, visibleToRaw(visOffset) -> number|null, rawRangeForVisibleRange(visFrom, visTo) -> {from,to}|null }`
  - `kind ∈ 'char'|'escape'|'entity'|'atom'|'linebreak'`；`width` 是该单元贡献的可见 UTF-16 code unit 数（surrogate pair 的 width 为 2）。
  - 边界规则：`visibleToRaw` 只接受落在单元边界上的可见偏移；单元内部（如实体第 2 个可见字符中间——仅 width>1 的实体可能出现）返回 `null`。

- [ ] **Step 1: Write the failing test**

`scripts/test-source-kernel-charmap.mjs`：

```js
import assert from 'node:assert/strict'
import { buildSyntaxIndex } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { buildCharacterMap } from '../src/renderer/src/lib/source-kernel/character-map.js'

const mapOf = (src, findText = null) => {
  const idx = buildSyntaxIndex(src)
  const offset = findText ? src.indexOf(findText) : 0
  const block = idx.blockAt(offset)
  return { map: buildCharacterMap(src, block.node), idx, block }
}

// 普通文本：一一对应
{
  const { map } = mapOf('abc\n')
  assert.equal(map.visibleLength, 3)
  assert.equal(map.visibleToRaw(0), 0)
  assert.equal(map.visibleToRaw(3), 3)
  assert.deepEqual(map.rawRangeForVisibleRange(1, 2), { from: 1, to: 2 })
}

// 反斜杠转义：可见 1 字符 ↔ raw 2 字符；光标不得落进 raw 内部
{
  const src = 'a\\*b\n'          // 可见 a*b
  const { map } = mapOf(src)
  assert.equal(map.visibleLength, 3)
  assert.equal(map.visibleToRaw(1), 1)   // '*' 左边界
  assert.equal(map.visibleToRaw(2), 3)   // '*' 右边界（跳过整个 \*）
  assert.deepEqual(map.rawRangeForVisibleRange(1, 2), { from: 1, to: 3 })
}

// 实体：&amp; 可见 1 字符 ↔ raw 5 字符
{
  const src = 'x&amp;y\n'        // 可见 x&y
  const { map } = mapOf(src)
  assert.equal(map.visibleLength, 3)
  assert.deepEqual(map.rawRangeForVisibleRange(1, 2), { from: 1, to: 6 })
}

// 数字/十六进制实体 + surrogate pair
{
  const src = 'a&#x1F600;b\n'    // 😀 是 2 个 code unit
  const { map } = mapOf(src)
  assert.equal(map.visibleLength, 4)
  assert.equal(map.visibleToRaw(1), 1)
  assert.equal(map.visibleToRaw(3), 10)  // 实体右边界
  assert.equal(map.visibleToRaw(2), null) // surrogate pair 内部：拒绝
}
{
  const src = 'a😀b\n'           // 字面 surrogate pair：一个单元 width 2
  const { map } = mapOf(src)
  assert.equal(map.visibleToRaw(1), 1)
  assert.equal(map.visibleToRaw(3), 3)
  assert.equal(map.visibleToRaw(2), null)
}

// 引用内段落的软换行：可见 '\n' 1 字符 ↔ raw '换行+引用前缀'
{
  const src = '> 甲\n> 乙\n'
  const { map } = mapOf(src, '甲')
  assert.equal(map.visibleLength, 3)     // 甲 \n 乙
  assert.deepEqual(map.rawRangeForVisibleRange(1, 2), { from: 3, to: 6 }) // '\n> '
  assert.equal(map.visibleToRaw(2), 6)
}

// 行内 atom（inlineCode/image）：整体一个不可拆单元
{
  const src = '前 `code` 后\n'
  const { map } = mapOf(src)
  const atom = map.units.find((u) => u.kind === 'atom')
  assert.ok(atom)
  assert.equal(src.slice(atom.rawStart, atom.rawEnd), '`code`')
}

// raw 与 value 无法对齐 → 整块 null（fail-closed）
{
  const idx = buildSyntaxIndex('plain\n')
  const fake = { ...idx.blockAt(0).node }
  fake.children = [{ type: 'text', value: 'DIFFERENT',
    position: fake.children[0].position }]
  assert.equal(buildCharacterMap('plain\n', fake), null)
}

console.log('PASS source-kernel character map')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-source-kernel-charmap.mjs`
Expected: FAIL（`ERR_MODULE_NOT_FOUND`）

- [ ] **Step 3: Write minimal implementation**

`src/renderer/src/lib/source-kernel/character-map.js`：

```js
import { decodeNamedCharacterReference } from 'decode-named-character-reference'

// 行内 atom：整体占位、不可拆分。phase 1 只需要 inlineCode/image/break/
// footnote 之类“文本输入不落入其内部”的节点整体化。
const ATOMS = new Set(['inlineCode', 'image', 'imageReference', 'break',
  'footnoteReference', 'html'])

const ENTITY_RE = /^&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{0,31});/

const decodeEntity = (raw) => {
  const m = raw.match(ENTITY_RE)
  if (!m) return null
  const body = m[1]
  let decoded = null
  if (body[0] === '#') {
    const code = body[1] === 'x' || body[1] === 'X'
      ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    if (Number.isFinite(code)) { try { decoded = String.fromCodePoint(code) } catch { decoded = null } }
  } else {
    decoded = decodeNamedCharacterReference(body) || null
  }
  return decoded ? { rawLength: m[0].length, decoded } : null
}

// 软换行：value 中的 '\n' 对应 raw 的 行尾 + 下一行的引用前缀/缩进。
// 贪婪吃 [ \t>]，但必须停在“下一 value 字符能对齐”的位置；对不上则失败。
const consumeSoftBreak = (text, r, nextChar) => {
  let i = r
  if (text[i] === '\r') i += text[i + 1] === '\n' ? 2 : 1
  else if (text[i] === '\n') i += 1
  else return null
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '>')) {
    if (nextChar !== undefined && text[i] === nextChar && text[i] !== '>') break
    i += 1
  }
  return i
}

function textUnits(text, node) {
  const value = String(node.value ?? '')
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null
  const units = []
  let r = start
  let v = 0
  while (v < value.length) {
    const cp = value.codePointAt(v)
    const ch = String.fromCodePoint(cp)
    if (ch === '\n') {
      const next = consumeSoftBreak(text, r, value[v + 1])
      if (next === null || next > end) return null
      units.push({ rawStart: r, rawEnd: next, width: 1, kind: 'linebreak' })
      r = next; v += 1
      continue
    }
    if (text[r] === '\\' && text[r + 1] === ch && ch.length === 1) {
      units.push({ rawStart: r, rawEnd: r + 2, width: 1, kind: 'escape' })
      r += 2; v += 1
      continue
    }
    if (text[r] === '&') {
      const entity = decodeEntity(text.slice(r, end))
      if (entity && value.startsWith(entity.decoded, v)) {
        units.push({ rawStart: r, rawEnd: r + entity.rawLength,
          width: entity.decoded.length, kind: 'entity' })
        r += entity.rawLength; v += entity.decoded.length
        continue
      }
    }
    if (text.startsWith(ch, r)) {
      units.push({ rawStart: r, rawEnd: r + ch.length, width: ch.length, kind: 'char' })
      r += ch.length; v += ch.length
      continue
    }
    return null
  }
  return r <= end ? units : null
}

export function buildCharacterMap(text, blockNode) {
  const units = []
  for (const child of blockNode.children || []) {
    if (ATOMS.has(child.type)) {
      const s = child.position?.start?.offset
      const e = child.position?.end?.offset
      if (!Number.isInteger(s) || !Number.isInteger(e)) return null
      units.push({ rawStart: s, rawEnd: e, width: 1, kind: 'atom' })
    } else if (child.type === 'text') {
      const t = textUnits(text, child)
      if (!t) return null
      units.push(...t)
    } else if (child.children) {
      const inner = buildCharacterMap(text, child)
      if (!inner) return null
      units.push(...inner.units)
    } else {
      return null
    }
  }
  let visibleLength = 0
  const boundaries = new Map([[0, units[0] ? units[0].rawStart
    : blockNode.position?.start?.offset ?? 0]])
  for (const unit of units) {
    visibleLength += unit.width
    boundaries.set(visibleLength, unit.rawEnd)
  }
  const visibleToRaw = (vis) => boundaries.has(vis) ? boundaries.get(vis) : null
  return {
    units,
    visibleLength,
    visibleToRaw,
    rawRangeForVisibleRange: (visFrom, visTo) => {
      const from = visibleToRaw(visFrom)
      const to = visibleToRaw(visTo)
      return from === null || to === null || from > to ? null : { from, to }
    }
  }
}
```

注意：`visibleToRaw(0)` 当块以实体/转义开头时应取第一个单元的 `rawStart`（上面 boundaries 初始化已处理）；空块（无 units）时 `visibleLength 0` 映射到块 start。

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-source-kernel-charmap.mjs`
Expected: `PASS source-kernel character map`

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/source-kernel/character-map.js scripts/test-source-kernel-charmap.mjs
git commit -m "feat(source-kernel): character-level boundary map for authored units"
```

---

### Task 4: 通用文本替换 + 任务勾选命令

**Files:**
- Create: `src/renderer/src/lib/source-kernel/commands/replace-text.js`
- Create: `src/renderer/src/lib/source-kernel/commands/task-toggle.js`
- Create: `scripts/test-source-kernel-commands.mjs`（本任务 + Task 5 共用，本任务先写前半）

**Interfaces:**
- Consumes: Task 1 事务形状；Task 2 `index.listItemAt`；Task 3 map。
- Produces:
  - `replaceVisibleText({ doc, map, visFrom, visTo, insert, intent = 'insert-text' }) -> { ok: true, transaction } | { ok: false, code: 'unmapped-selection' }`
    - 插入文本**逐字进源码，不做任何转义**（源码优先：用户敲 `*` 就存 `*`，语义由投影重解析决定）。
  - `toggleTaskMarker({ doc, index, offset }) -> { ok: true, transaction } | { ok: false, code: 'unsupported-structure' }`
    - 只替换 `[ ]`/`[x]`/`[X]` 三个字符，勾选写 `[x]`，取消写 `[ ]`。

- [ ] **Step 1: Write the failing test**

`scripts/test-source-kernel-commands.mjs`（第一部分）：

```js
import assert from 'node:assert/strict'
import { createMarkdownDocument, applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { buildSyntaxIndex } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { buildCharacterMap } from '../src/renderer/src/lib/source-kernel/character-map.js'
import { replaceVisibleText } from '../src/renderer/src/lib/source-kernel/commands/replace-text.js'
import { toggleTaskMarker } from '../src/renderer/src/lib/source-kernel/commands/task-toggle.js'

const setup = (text, at) => {
  const doc = createMarkdownDocument(text)
  const index = buildSyntaxIndex(text)
  const block = index.blockAt(at)
  return { doc, index, map: buildCharacterMap(text, block.node) }
}

// 文本替换走转义感知边界；输入逐字进源码（不转义）
{
  const src = 'a\\*b\n'
  const { doc, map } = setup(src, 0)
  const r = replaceVisibleText({ doc, map, visFrom: 1, visTo: 2, insert: '*X*' })
  assert.equal(r.ok, true)
  const applied = applySourceTransaction(doc, r.transaction)
  assert.equal(applied.doc.text, 'a*X*b\n')   // \* 整体被覆盖，插入原样
}

// 未映射边界 fail-closed
{
  const src = 'a&#x1F600;b\n'
  const { doc, map } = setup(src, 0)
  assert.deepEqual(
    replaceVisibleText({ doc, map, visFrom: 2, visTo: 3, insert: 'x' }),
    { ok: false, code: 'unmapped-selection' }
  )
}

// 任务勾选：只动 3 个字符，[X] 大写也接受
{
  const src = '* [ ] 甲\n* [X] 乙\n尾\n'
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  const on = toggleTaskMarker({ doc, index, offset: src.indexOf('甲') })
  assert.equal(on.ok, true)
  assert.equal(applySourceTransaction(doc, on.transaction).doc.text,
    '* [x] 甲\n* [X] 乙\n尾\n')
  const off = toggleTaskMarker({ doc, index, offset: src.indexOf('乙') })
  assert.equal(applySourceTransaction(doc, off.transaction).doc.text,
    '* [ ] 甲\n* [ ] 乙\n尾\n')
  // 非任务项拒绝
  assert.equal(toggleTaskMarker({ doc, index, offset: src.indexOf('尾') }).code,
    'unsupported-structure')
}

console.log('PASS source-kernel commands (text + task)')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-source-kernel-commands.mjs`
Expected: FAIL（`ERR_MODULE_NOT_FOUND`）

- [ ] **Step 3: Write minimal implementation**

`commands/replace-text.js`：

```js
export function replaceVisibleText({ doc, map, visFrom, visTo, insert, intent = 'insert-text' }) {
  const range = map?.rawRangeForVisibleRange(visFrom, visTo)
  if (!range) return { ok: false, code: 'unmapped-selection' }
  const text = String(insert ?? '')
  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      from: range.from,
      to: range.to,
      insert: text,
      intent,
      selection: { anchor: range.from + text.length, head: range.from + text.length }
    }
  }
}
```

`commands/task-toggle.js`：

```js
export function toggleTaskMarker({ doc, index, offset }) {
  const item = index.listItemAt(offset)
  if (!item?.task) return { ok: false, code: 'unsupported-structure' }
  const insert = item.task.checked ? '[ ]' : '[x]'
  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      from: item.task.from,
      to: item.task.to,
      insert,
      intent: 'toggle-task',
      selection: { anchor: item.contentStart, head: item.contentStart }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-source-kernel-commands.mjs`
Expected: `PASS source-kernel commands (text + task)`

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/source-kernel/commands scripts/test-source-kernel-commands.mjs
git commit -m "feat(source-kernel): text replacement and task toggle commands"
```

---

### Task 5: Enter 命令（段落/标题分裂 · 列表续项 · 空项退出）

**Files:**
- Create: `src/renderer/src/lib/source-kernel/commands/enter.js`
- Modify: `scripts/test-source-kernel-commands.mjs`（追加）

**Interfaces:**
- Consumes: Task 1/2。
- Produces:
  - `splitTextBlock({ doc, index, offset }) -> result`：段落/标题内 Enter。插入 `ending + [引用空行] + 引用前缀`，caret 后文本自然成为新块；标题分裂时新块无 marker（成为段落）。
  - `splitListItem({ doc, index, offset }) -> result`：非空项 Enter，插入 `ending + quotePrefix + indent + nextMarker + spacing (+ '[ ]' + taskSpacing)`；有序 marker 为当前显式编号 +1 沿用分隔符；任务项新项为未勾选。
  - `exitEmptyListItem({ doc, index, offset }) -> result`：空项 Enter，删除该行的 `indent+marker+spacing+task+taskSpacing`（保留引用前缀），caret 停在删除点。
  - 所有 result 均为 `{ ok: true, transaction } | { ok: false, code: 'unsupported-structure' }`。

- [ ] **Step 1: Write the failing test（追加到 test-source-kernel-commands.mjs）**

```js
import { splitTextBlock, splitListItem, exitEmptyListItem }
  from '../src/renderer/src/lib/source-kernel/commands/enter.js'

const apply = (doc, r) => {
  assert.equal(r.ok, true, r.code)
  return applySourceTransaction(doc, r.transaction).doc.text
}
const ctx = (text) => ({ doc: createMarkdownDocument(text), index: buildSyntaxIndex(text) })

// 段落中 Enter：拆成两段
{
  const src = '甲乙\n'
  const c = ctx(src)
  assert.equal(apply(c.doc, splitTextBlock({ ...c, offset: 1 })), '甲\n\n乙\n')
}
// 引用内段落 Enter：`> 锚\n>\n> 段`（对齐 test-quoted-block-source-ui 的期望）
{
  const src = '> 锚段\n'
  const c = ctx(src)
  assert.equal(apply(c.doc, splitTextBlock({ ...c, offset: src.indexOf('段') })),
    '> 锚\n>\n> 段\n')
}
// 标题中 Enter：后半成为段落（source-first，无新 marker）
{
  const src = '# 头尾\n'
  const c = ctx(src)
  assert.equal(apply(c.doc, splitTextBlock({ ...c, offset: src.indexOf('尾') })),
    '# 头\n\n尾\n')
}
// CRLF 文档沿用 CRLF
{
  const src = '甲乙\r\n'
  const c = ctx(src)
  assert.equal(apply(c.doc, splitTextBlock({ ...c, offset: 1 })), '甲\r\n\r\n乙\r\n')
}

// 列表非空项 Enter：沿用 marker 风格；有序 +1 不重排既有兄弟
{
  const src = '* 甲乙\n'
  const c = ctx(src)
  assert.equal(apply(c.doc, splitListItem({ ...c, offset: 4 })), '* 甲\n* 乙\n')
}
{
  const src = '3) 甲乙\n7) 丙\n'
  const c = ctx(src)
  assert.equal(apply(c.doc, splitListItem({ ...c, offset: 4 })),
    '3) 甲\n4) 乙\n7) 丙\n')     // 只写 4)，7) 原样
}
// 任务项 Enter：新项未勾选，spacing 逐字沿用
{
  const src = '- [x] 甲乙\n'
  const c = ctx(src)
  assert.equal(apply(c.doc, splitListItem({ ...c, offset: 7 })),
    '- [x] 甲\n- [ ] 乙\n')
}
// 嵌套缩进沿用
{
  const src = '- 甲\n  - 乙丙\n'
  const c = ctx(src)
  assert.equal(apply(c.doc, splitListItem({ ...c, offset: src.indexOf('丙') })),
    '- 甲\n  - 乙\n  - 丙\n')
}

// 空项 Enter：删 marker 退出列表，留空行；引用前缀保留
{
  const src = '- 甲\n- \n'
  const c = ctx(src)
  assert.equal(apply(c.doc, exitEmptyListItem({ ...c, offset: 7 })), '- 甲\n\n')
}
{
  const src = '> * 甲\n> * \n'
  const c = ctx(src)
  assert.equal(apply(c.doc, exitEmptyListItem({ ...c, offset: 11 })), '> * 甲\n> \n')
}

console.log('PASS source-kernel commands (enter)')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-source-kernel-commands.mjs`
Expected: FAIL（enter.js 不存在）

- [ ] **Step 3: Write minimal implementation**

`commands/enter.js`：

```js
import { QUOTE_PREFIX } from '../../markdown-preservation/block-prefix.js'

const endingAt = (index, offset) => {
  const line = index.lineAt(offset)
  return line.ending || index.dominantEnding
}
const quotePrefixAt = (index, offset) =>
  (index.lineAt(offset).text.match(QUOTE_PREFIX) || [''])[0]
const bareQuote = (prefix) => prefix.replace(/[ \t]+$/, '')
const txn = (doc, from, to, insert, intent, caret) => ({
  ok: true,
  transaction: {
    baseRevision: doc.revision, from, to, insert, intent,
    selection: { anchor: caret, head: caret }
  }
})

export function splitTextBlock({ doc, index, offset }) {
  const block = index.blockAt(offset)
  if (!block || (block.type !== 'paragraph' && block.type !== 'heading')) {
    return { ok: false, code: 'unsupported-structure' }
  }
  const ending = endingAt(index, offset)
  const prefix = quotePrefixAt(index, offset)
  const insert = prefix
    ? ending + bareQuote(prefix) + ending + prefix
    : ending + ending
  return txn(doc, offset, offset, insert, 'split-block', offset + insert.length)
}

export function splitListItem({ doc, index, offset }) {
  const item = index.listItemAt(offset)
  if (!item || item.empty) return { ok: false, code: 'unsupported-structure' }
  const ending = endingAt(index, offset)
  const marker = item.ordered
    ? String(item.ordered.number + 1) + item.ordered.delimiter
    : item.marker
  const insert = ending + item.quotePrefix + item.indent + marker + item.spacing +
    (item.task ? '[ ]' + item.taskSpacing : '')
  return txn(doc, offset, offset, insert, 'split-list-item', offset + insert.length)
}

export function exitEmptyListItem({ doc, index, offset }) {
  const item = index.listItemAt(offset)
  if (!item?.empty) return { ok: false, code: 'unsupported-structure' }
  const line = index.lines[item.markerLineIndex]
  const from = line.start + item.quotePrefix.length
  const to = line.end   // 行内容尾（不含行尾），marker 行为空项时即删到行尾
  return txn(doc, from, to, '', 'exit-empty-list-item', from)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-source-kernel-commands.mjs`
Expected: 两条 PASS 行都出现

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/source-kernel/commands/enter.js scripts/test-source-kernel-commands.mjs
git commit -m "feat(source-kernel): enter commands for blocks and list items"
```

---

### Task 6: Tab / Shift+Tab（列表项缩进/反缩进）

**Files:**
- Create: `src/renderer/src/lib/source-kernel/commands/indent.js`
- Create: `scripts/test-source-kernel-indent.mjs`

**Interfaces:**
- Consumes: Task 1/2。
- Produces:
  - `indentListItem({ doc, index, offset })`：无同级前兄弟 → `unsupported-structure`；否则对项的每个**非空行**（`item.start`..`item.end` 的行）在引用前缀之后插入 `' '.repeat(prev.indent.length + prev.marker.length + prev.spacing.length - item.indent.length)`；多行用**一个多编辑事务**（一次 revision、一个 undo 单元）。
  - `outdentListItem({ doc, index, offset })`：depth 0 → `unsupported-structure`；否则从每个非空行删除 `item.indent.length - parentItem.indent.length` 个前导空白（引用前缀后必须恰是这些空白，否则 `unsupported-structure`）。

- [ ] **Step 1: Write the failing test**

`scripts/test-source-kernel-indent.mjs`：

```js
import assert from 'node:assert/strict'
import { createMarkdownDocument, applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { buildSyntaxIndex } from '../src/renderer/src/lib/source-kernel/syntax-index.js'
import { indentListItem, outdentListItem } from '../src/renderer/src/lib/source-kernel/commands/indent.js'

const run = (src, offset, fn) => {
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  const r = fn({ doc, index, offset })
  if (!r.ok) return r
  return applySourceTransaction(doc, r.transaction).doc.text
}

// bullet 缩进：`- ` 宽 2 → 2 空格
assert.equal(run('- 甲\n- 乙\n', 6, indentListItem), '- 甲\n  - 乙\n')
// 有序 marker `10. ` 宽 4 → 4 空格
assert.equal(run('10. 甲\n11. 乙\n', 8, indentListItem), '10. 甲\n    11. 乙\n')
// 首项无前兄弟 → 拒绝
assert.equal(run('- 甲\n', 2, indentListItem).code, 'unsupported-structure')
// 子树整体随动（子行同加前缀），一个事务
{
  const src = '- 甲\n- 乙\n  - 丙\n'
  assert.equal(run(src, 6, indentListItem), '- 甲\n  - 乙\n    - 丙\n')
}
// 引用内缩进：前缀之后加
assert.equal(run('> - 甲\n> - 乙\n', 10, indentListItem), '> - 甲\n>   - 乙\n')

// 反缩进
assert.equal(run('- 甲\n  - 乙\n', 8, outdentListItem), '- 甲\n- 乙\n')
// 顶层反缩进 → 拒绝
assert.equal(run('- 甲\n', 2, outdentListItem).code, 'unsupported-structure')
// 子树随动
{
  const src = '- 甲\n  - 乙\n    - 丙\n'
  assert.equal(run(src, src.indexOf('乙'), outdentListItem),
    '- 甲\n- 乙\n  - 丙\n')
}

console.log('PASS source-kernel indent')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-source-kernel-indent.mjs`
Expected: FAIL（`ERR_MODULE_NOT_FOUND`）

- [ ] **Step 3: Write minimal implementation**

`commands/indent.js`：

```js
// Tab/Shift+Tab 只改当前项及其明确归属子树的行前缀，绝不重写整个列表。
const ownedLineIndexes = (index, item) => {
  const first = item.markerLineIndex
  const last = index.lineIndexAt(Math.max(item.start, item.end - 1))
  const rows = []
  for (let i = first; i <= last; i += 1) {
    if (index.lines[i].text.slice(item.quotePrefix.length).trim() !== '') rows.push(i)
  }
  return rows
}

const multiTxn = (doc, edits, intent, caretDelta, offset) => ({
  ok: true,
  transaction: {
    baseRevision: doc.revision, edits, intent,
    selection: { anchor: offset + caretDelta, head: offset + caretDelta }
  }
})

const previousSibling = (index, item) => {
  // 同一 list 内、同 depth、位于 item 之前、最近的一项
  let best = null
  for (let off = item.listStart; off < item.start; off += 1) {
    const candidate = index.listItemAt(off)
    if (candidate && candidate.depth === item.depth &&
        candidate.start < item.start && candidate.listStart === item.listStart) {
      if (!best || candidate.start > best.start) best = candidate
      off = candidate.end - 1
    }
  }
  return best
}

export function indentListItem({ doc, index, offset }) {
  const item = index.listItemAt(offset)
  if (!item) return { ok: false, code: 'unsupported-structure' }
  const prev = previousSibling(index, item)
  if (!prev) return { ok: false, code: 'unsupported-structure' }
  const width = prev.indent.length + prev.marker.length + prev.spacing.length -
    item.indent.length
  if (width <= 0) return { ok: false, code: 'unsupported-structure' }
  const pad = ' '.repeat(width)
  const edits = ownedLineIndexes(index, item).map((i) => {
    const at = index.lines[i].start + item.quotePrefix.length
    return { from: at, to: at, insert: pad }
  })
  return multiTxn(doc, edits, 'indent-list-item', pad.length, offset)
}

export function outdentListItem({ doc, index, offset }) {
  const item = index.listItemAt(offset)
  if (!item || item.depth === 0) return { ok: false, code: 'unsupported-structure' }
  const parent = index.listItemAt(item.listStart)   // 外层项包含内层 list
  const width = item.indent.length - (parent ? parent.indent.length : 0)
  if (width <= 0) return { ok: false, code: 'unsupported-structure' }
  const edits = []
  for (const i of ownedLineIndexes(index, item)) {
    const at = index.lines[i].start + item.quotePrefix.length
    if (!/^[ \t]+$/.test(index.text.slice(at, at + width))) {
      return { ok: false, code: 'unsupported-structure' }
    }
    edits.push({ from: at, to: at + width, insert: '' })
  }
  return multiTxn(doc, edits, 'outdent-list-item', -width, offset)
}
```

注意：`previousSibling` 的线性扫描按 `candidate.end - 1` 跳步，复杂度可接受（phase 1 immutable 字符串路线）；`parent` 取法（`listItemAt(item.listStart)`）依赖“内层 list 的 start 落在外层 listItem 范围内”，测试若暴露偏差按 `depth - 1` 过滤修正。

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-source-kernel-indent.mjs`
Expected: `PASS source-kernel indent`

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/source-kernel/commands/indent.js scripts/test-source-kernel-indent.mjs
git commit -m "feat(source-kernel): list indent/outdent as prefix-only multi-edits"
```

---

### Task 7: Backspace / Delete + 结构路由

**Files:**
- Create: `src/renderer/src/lib/source-kernel/commands/delete.js`
- Create: `src/renderer/src/lib/source-kernel/router.js`
- Create: `src/renderer/src/lib/source-kernel/index.js`（聚合导出）
- Modify: `scripts/test-source-kernel-indent.mjs`（追加 router/delete 段）

**Interfaces:**
- Consumes: Tasks 1-6 全部命令。
- Produces:
  - `liftEmptyListItem({ doc, index, offset })`：空项 Backspace。depth>0 → 委托 `outdentListItem`；depth 0 → 委托 `exitEmptyListItem`（Typora 语义）。
  - `joinParagraphBackward({ doc, index, offset })`：caret 在段落首字符（`offset === block.start`）且前一块也是**段落**且引用深度相同 → 把块间空隙替换为 `ending + 当前行引用前缀`（并成一个惰性延续段落）；其他情况 `unsupported-structure`。
  - `routeStructuralKey(key, { doc, index, offset, empty }) -> result | { ok:false, code:'not-structural' }`
    - `key ∈ 'Enter'|'Tab'|'Shift-Tab'|'Backspace'|'Delete'`
    - Enter：列表项 → 空项 `exitEmptyListItem` / 非空 `splitListItem`；否则 `splitTextBlock`。
    - Tab/Shift-Tab：列表项 → indent/outdent；否则 `not-structural`（普通 Tab 是文本输入，走 replace-text）。
    - Backspace：空项 → `liftEmptyListItem`；段落首 → `joinParagraphBackward`；否则 `not-structural`（字符删除走 replace-text）。
    - Delete：段落尾（`offset === block.end`）且下一块是段落 → 对下一块调用 join 逻辑；否则 `not-structural`。
  - `index.js` 重导出：document/index/charmap/全部命令/router。

- [ ] **Step 1: Write the failing test（追加）**

```js
import { liftEmptyListItem, joinParagraphBackward }
  from '../src/renderer/src/lib/source-kernel/commands/delete.js'
import { routeStructuralKey } from '../src/renderer/src/lib/source-kernel/router.js'

// 空项 Backspace：嵌套先反缩进，顶层退出列表
assert.equal(run('- 甲\n  - \n', 8, liftEmptyListItem), '- 甲\n- \n')
assert.equal(run('- 甲\n- \n', 7, liftEmptyListItem), '- 甲\n\n')

// 段落回删合并：普通 + 引用；标题边界拒绝
assert.equal(run('甲\n\n乙\n', 3, joinParagraphBackward), '甲\n乙\n')
assert.equal(run('> 甲\n>\n> 乙\n', 10, joinParagraphBackward), '> 甲\n> 乙\n')
assert.equal(run('# 头\n\n乙\n', 5, joinParagraphBackward).code, 'unsupported-structure')

// 路由决策表
{
  const src = '- 甲乙\n'
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  assert.equal(routeStructuralKey('Enter', { doc, index, offset: 4 }).ok, true)
  assert.equal(routeStructuralKey('Tab', { doc, index, offset: 4 }).code,
    'unsupported-structure')  // 无前兄弟
  assert.equal(
    routeStructuralKey('Backspace', { doc, index, offset: 4 }).code,
    'not-structural')          // 项中字符删除走文本路径
}
{
  const src = '段甲\n'
  const doc = createMarkdownDocument(src)
  const index = buildSyntaxIndex(src)
  assert.equal(routeStructuralKey('Tab', { doc, index, offset: 1 }).code, 'not-structural')
}

console.log('PASS source-kernel delete + router')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-source-kernel-indent.mjs`
Expected: FAIL（delete.js/router.js 不存在）

- [ ] **Step 3: Write minimal implementation**

`commands/delete.js`：

```js
import { QUOTE_PREFIX } from '../../markdown-preservation/block-prefix.js'
import { exitEmptyListItem } from './enter.js'
import { outdentListItem } from './indent.js'

export function liftEmptyListItem({ doc, index, offset }) {
  const item = index.listItemAt(offset)
  if (!item?.empty) return { ok: false, code: 'unsupported-structure' }
  return item.depth > 0
    ? outdentListItem({ doc, index, offset })
    : exitEmptyListItem({ doc, index, offset })
}

export function joinParagraphBackward({ doc, index, offset }) {
  const block = index.blockAt(offset)
  if (!block || block.type !== 'paragraph' || offset !== block.start) {
    return { ok: false, code: 'unsupported-structure' }
  }
  let previous = null
  // 上一个段落块：向前找最近的、end <= block.start 的段落
  for (let at = block.start - 1; at >= 0; at -= 1) {
    const candidate = index.blockAt(at)
    if (candidate) { previous = candidate; break }
  }
  if (!previous || previous.type !== 'paragraph') {
    return { ok: false, code: 'unsupported-structure' }
  }
  const line = index.lineAt(offset)
  const prefix = (line.text.match(QUOTE_PREFIX) || [''])[0]
  const prevLine = index.lineAt(previous.end - 1)
  const prevPrefix = (prevLine.text.match(QUOTE_PREFIX) || [''])[0]
  if (prefix !== prevPrefix) return { ok: false, code: 'unsupported-structure' }
  const ending = prevLine.ending || index.dominantEnding
  return {
    ok: true,
    transaction: {
      baseRevision: doc.revision,
      from: previous.end,
      to: block.start,
      insert: ending + prefix,
      intent: 'join-block-backward',
      selection: { anchor: previous.end, head: previous.end }
    }
  }
}
```

`router.js`：

```js
import { splitTextBlock, splitListItem, exitEmptyListItem } from './commands/enter.js'
import { indentListItem, outdentListItem } from './commands/indent.js'
import { liftEmptyListItem, joinParagraphBackward } from './commands/delete.js'

const NOT_STRUCTURAL = { ok: false, code: 'not-structural' }

export function routeStructuralKey(key, ctx) {
  const { index, offset } = ctx
  const item = index.listItemAt(offset)
  switch (key) {
    case 'Enter':
      if (item) return item.empty ? exitEmptyListItem(ctx) : splitListItem(ctx)
      return splitTextBlock(ctx)
    case 'Tab':
      return item ? indentListItem(ctx) : NOT_STRUCTURAL
    case 'Shift-Tab':
      return item ? outdentListItem(ctx) : NOT_STRUCTURAL
    case 'Backspace': {
      if (item?.empty) return liftEmptyListItem(ctx)
      const block = index.blockAt(offset)
      if (block && offset === block.start && !item) return joinParagraphBackward(ctx)
      return NOT_STRUCTURAL
    }
    case 'Delete': {
      const block = index.blockAt(offset)
      if (block && offset === block.end) {
        const next = index.blockAt(block.end + 1) ||
          index.blockAt(Math.min(index.text.length, block.end + 2))
        if (next && next.type === 'paragraph') {
          return joinParagraphBackward({ ...ctx, offset: next.start })
        }
      }
      return NOT_STRUCTURAL
    }
    default:
      return NOT_STRUCTURAL
  }
}
```

`index.js`：

```js
export { createMarkdownDocument, applySourceTransaction } from './markdown-document.js'
export { buildSyntaxIndex, scanLines } from './syntax-index.js'
export { buildCharacterMap } from './character-map.js'
export { replaceVisibleText } from './commands/replace-text.js'
export { toggleTaskMarker } from './commands/task-toggle.js'
export { splitTextBlock, splitListItem, exitEmptyListItem } from './commands/enter.js'
export { indentListItem, outdentListItem } from './commands/indent.js'
export { liftEmptyListItem, joinParagraphBackward } from './commands/delete.js'
export { routeStructuralKey } from './router.js'
export { createSourceHistory } from './history.js'
```

（`history.js` 在 Task 8 创建；本任务提交时 `index.js` 先不导出它，Task 8 再补该行。）

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-source-kernel-indent.mjs`
Expected: 两条 PASS 行

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/source-kernel scripts/test-source-kernel-indent.mjs
git commit -m "feat(source-kernel): backspace/delete commands and structural router"
```

---

### Task 8: 源码历史（Undo/Redo + 输入合并）

**Files:**
- Create: `src/renderer/src/lib/source-kernel/history.js`
- Create: `scripts/test-source-kernel-history.mjs`
- Modify: `src/renderer/src/lib/source-kernel/index.js`（补 history 导出行）

**Interfaces:**
- Consumes: Task 1 的 apply 结果（`inverse`）。
- Produces:
  - `createSourceHistory() -> { record(applyResult, transaction), undo(doc) -> transaction|null, redo(doc) -> transaction|null, breakGroup(), depth() }`
  - 合并规则：连续 `intent: 'insert-text'` 的单编辑事务、且本次 `from === 上次插入终点`、且中间未调用 `breakGroup()` → 并入同一 undo 组（undo 一次全撤）。其他 intent 永不合并。
  - `undo(doc)` 返回的事务 `baseRevision` 必须等于 `doc.revision`（历史与文档线性同步，不同步时返回 null）。
  - 新 `record` 清空 redo 栈。

- [ ] **Step 1: Write the failing test**

`scripts/test-source-kernel-history.mjs`：

```js
import assert from 'node:assert/strict'
import { createMarkdownDocument, applySourceTransaction } from '../src/renderer/src/lib/source-kernel/markdown-document.js'
import { createSourceHistory } from '../src/renderer/src/lib/source-kernel/history.js'

let doc = createMarkdownDocument('ab\n')
const history = createSourceHistory()
const commit = (txn) => {
  const r = applySourceTransaction(doc, txn)
  assert.equal(r.ok, true)
  history.record(r, txn)
  doc = r.doc
  return r
}

// 连续打字合并为一个 undo 组
commit({ baseRevision: 0, from: 1, to: 1, insert: 'X', intent: 'insert-text' })
commit({ baseRevision: 1, from: 2, to: 2, insert: 'Y', intent: 'insert-text' })
assert.equal(doc.text, 'aXYb\n')
assert.equal(history.depth(), 1)

// 结构命令不合并
commit({ baseRevision: 2, from: 4, to: 4, insert: '\n\n', intent: 'split-block' })
assert.equal(history.depth(), 2)

// undo 逐组回退，逐字节还原
let u = history.undo(doc)
doc = applySourceTransaction(doc, u).doc
assert.equal(doc.text, 'aXYb\n')
u = history.undo(doc)
doc = applySourceTransaction(doc, u).doc
assert.equal(doc.text, 'ab\n')
assert.equal(history.undo(doc), null)

// redo 前滚；新录入清空 redo
let r = history.redo(doc)
doc = applySourceTransaction(doc, r).doc
assert.equal(doc.text, 'aXYb\n')
commit({ baseRevision: doc.revision, from: 0, to: 0, insert: 'Z', intent: 'insert-text' })
assert.equal(history.redo(doc), null)

// breakGroup 阻断合并（IME 提交单元边界）
{
  let d = createMarkdownDocument('')
  const h = createSourceHistory()
  const c = (txn) => { const res = applySourceTransaction(d, txn); h.record(res, txn); d = res.doc }
  c({ baseRevision: 0, from: 0, to: 0, insert: 'a', intent: 'insert-text' })
  h.breakGroup()
  c({ baseRevision: 1, from: 1, to: 1, insert: 'b', intent: 'insert-text' })
  assert.equal(h.depth(), 2)
}

console.log('PASS source-kernel history')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-source-kernel-history.mjs`
Expected: FAIL（`ERR_MODULE_NOT_FOUND`）

- [ ] **Step 3: Write minimal implementation**

`history.js`：

```js
// Undo/Redo 记录源码事务及其逆事务；ProseMirror 历史不再是持久化来源。
export function createSourceHistory() {
  const undoStack = []   // 组：{ steps: [{ forward, inverse }], tailOffset }
  const redoStack = []
  let coalescing = true

  const singleInsert = (txn) => {
    if (txn.intent !== 'insert-text') return null
    const edits = Array.isArray(txn.edits) ? txn.edits : [txn]
    if (edits.length !== 1) return null
    return edits[0]
  }

  const record = (applyResult, txn) => {
    redoStack.length = 0
    const step = { forward: txn, inverse: applyResult.inverse }
    const edit = singleInsert(txn)
    const last = undoStack[undoStack.length - 1]
    if (edit && coalescing && last && last.tailOffset === edit.from) {
      last.steps.push(step)
      last.tailOffset = edit.from + String(edit.insert ?? '').length
    } else {
      undoStack.push({
        steps: [step],
        tailOffset: edit ? edit.from + String(edit.insert ?? '').length : null
      })
    }
    coalescing = !!edit
  }

  const merge = (transactions, revision) => {
    // 组内步骤逆序应用：直接串联为顺次事务数组会破坏原子性，
    // 这里把组合并为一个“依次 apply”的复合事务由调用方逐个执行——
    // 简化：仅支持把组内 inverse 逐个回放，phase 1 组内步骤本就相邻，
    // 直接返回首尾拼接的单事务。
    let txns = transactions
    if (txns.length === 1) return { ...txns[0], baseRevision: revision }
    // 相邻单字符插入的逆 = 一次范围删除；tail 组保证了相邻性
    const first = txns[0]
    const lastTxn = txns[txns.length - 1]
    const firstEdit = Array.isArray(first.edits) ? first.edits[0] : first
    const lastEdit = Array.isArray(lastTxn.edits) ? lastTxn.edits[0] : lastTxn
    return {
      baseRevision: revision,
      from: Math.min(firstEdit.from, lastEdit.from),
      to: Math.max(firstEdit.to, lastEdit.to),
      insert: txns.map((t) => (Array.isArray(t.edits) ? t.edits[0] : t).insert).join(''),
      intent: 'history-invert',
      selection: first.selection ?? null
    }
  }

  const pop = (fromStack, toStack, doc, pick) => {
    const group = fromStack[fromStack.length - 1]
    if (!group) return null
    fromStack.pop()
    toStack.push(group)
    const txns = pick(group)
    return merge(txns, doc.revision)
  }

  return {
    record,
    undo: (doc) => pop(undoStack, redoStack, doc,
      (g) => [...g.steps].reverse().map((s) => s.inverse)),
    redo: (doc) => pop(redoStack, undoStack, doc,
      (g) => g.steps.map((s) => s.forward)),
    breakGroup: () => { coalescing = false },
    depth: () => undoStack.length
  }
}
```

实现提示：合并逆事务的正确通式是“组内相邻单字符插入的逆 = 删除 [组首插入点, 组尾插入终点)”；上面 merge 对 undo 分支（inverse 列表）的 from/to 组合按测试断言校准——undo 一组 `X`+`Y` 的期望是删除 `[1,3)` 插入 `''`。若测试暴露 merge 边界错误，以“undo 后逐字节等于组前文本”为准修正。

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-source-kernel-history.mjs`
Expected: `PASS source-kernel history`

- [ ] **Step 5: Update index.js and commit**

`index.js` 追加：`export { createSourceHistory } from './history.js'`

```bash
git add src/renderer/src/lib/source-kernel/history.js src/renderer/src/lib/source-kernel/index.js scripts/test-source-kernel-history.mjs
git commit -m "feat(source-kernel): source history with typing coalescing"
```

---

### Task 9: 种子化状态机测试

**Files:**
- Create: `scripts/test-source-kernel-statemachine.mjs`
- Create: `scripts/fixtures/source-kernel/`（空目录 + `.gitkeep`；失败序列最小化后存这里）

**Interfaces:**
- Consumes: `source-kernel/index.js` 全部导出；`markdownComparisonKey` from `lib/markdown-preservation/roundtrip.js`。
- Produces: 可重复的确定性随机序列测试；`SEED`/`STEPS` env 可覆盖。

- [ ] **Step 1: Write the test（本任务测试即交付物）**

`scripts/test-source-kernel-statemachine.mjs`：

```js
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createMarkdownDocument, applySourceTransaction, buildSyntaxIndex,
  buildCharacterMap, replaceVisibleText, toggleTaskMarker, routeStructuralKey,
  createSourceHistory
} from '../src/renderer/src/lib/source-kernel/index.js'
import { markdownComparisonKey } from '../src/renderer/src/lib/markdown-preservation/roundtrip.js'

// 确定性 PRNG（仓库无属性测试先例，自带 mulberry32）
const mulberry32 = (seed) => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const SEEDS = process.env.SEED ? [Number(process.env.SEED)]
  : Array.from({ length: 12 }, (_, i) => i + 1)
const STEPS = Number(process.env.STEPS || 120)

const STARTERS = [
  '# 头\n\n段落甲\n\n- 甲\n- [x] 乙\n  1. 丙\n',
  '> 引甲\n>\n> * 引乙\n',
  '甲\r\n\r\n1) 乙\r\n2) 丙\r\n',
  '- \n\n尾\n'
]
const KEYS = ['Enter', 'Tab', 'Shift-Tab', 'Backspace', 'Delete']
const INSERTS = ['x', '中', ' ', '\t', '*', '&']
const FORBIDDEN = /&#x20;|&nbsp;|<!--|​|﻿/

const runSeed = (seed) => {
  const random = mulberry32(seed)
  const pick = (list) => list[Math.floor(random() * list.length)]
  let doc = createMarkdownDocument(pick(STARTERS))
  const history = createSourceHistory()
  const journal = []

  for (let step = 0; step < STEPS; step += 1) {
    const index = buildSyntaxIndex(doc.text)
    const offset = Math.floor(random() * (doc.text.length + 1))
    const kind = random()
    let result = null
    let action = null

    if (kind < 0.5) {
      action = pick(KEYS)
      result = routeStructuralKey(action, { doc, index, offset })
      if (result.code === 'not-structural') { result = null }
    } else if (kind < 0.8) {
      const block = index.blockAt(offset)
      if (block && (block.type === 'paragraph' || block.type === 'heading')) {
        const map = buildCharacterMap(doc.text, block.node)
        if (map && map.visibleLength >= 0) {
          const at = Math.floor(random() * (map.visibleLength + 1))
          action = 'insert'
          result = replaceVisibleText({ doc, map, visFrom: at, visTo: at, insert: pick(INSERTS) })
        }
      }
    } else if (kind < 0.9) {
      action = 'toggle-task'
      result = toggleTaskMarker({ doc, index, offset })
    } else {
      action = random() < 0.5 ? 'undo' : 'redo'
      const txn = action === 'undo' ? history.undo(doc) : history.redo(doc)
      if (txn) {
        const applied = applySourceTransaction(doc, txn)
        assert.equal(applied.ok, true, `${action} must apply (seed ${seed} step ${step})`)
        doc = applied.doc
        journal.push({ step, action })
      }
      continue
    }

    if (!result) continue
    if (!result.ok) {
      // 拒绝必须保留原文（引用同一字符串即未变）
      assert.ok(typeof result.code === 'string' && result.code.length > 0)
      continue
    }
    const before = doc.text
    const applied = applySourceTransaction(doc, result.transaction)
    assert.equal(applied.ok, true)
    // 不变式：未触及字节逐字保持
    const edits = applied.edits
    let cursorBefore = 0, cursorAfter = 0
    for (const edit of edits) {
      const insert = String(edit.insert ?? '')
      assert.equal(applied.doc.text.slice(cursorAfter, cursorAfter + (edit.from - cursorBefore)),
        before.slice(cursorBefore, edit.from),
        `untouched prefix bytes changed (seed ${seed} step ${step} ${action})`)
      cursorAfter += (edit.from - cursorBefore) + insert.length
      cursorBefore = edit.to
    }
    assert.equal(applied.doc.text.slice(cursorAfter), before.slice(cursorBefore))
    // 不变式：不产生禁止实体/哨兵（除非编辑前已存在）
    if (!FORBIDDEN.test(before)) {
      assert.ok(!FORBIDDEN.test(applied.doc.text),
        `forbidden entity introduced (seed ${seed} step ${step} ${action})`)
    }
    // 不变式：新源码可解析（parse 不抛）且语义 key 可计算
    markdownComparisonKey(applied.doc.text)
    history.record(applied, result.transaction)
    doc = applied.doc
    journal.push({ step, action })
  }
  return doc.text
}

for (const seed of SEEDS) {
  const first = runSeed(seed)
  const second = runSeed(seed)
  assert.equal(first, second, `seed ${seed} must be deterministic`)
}

// 已归档的最小化失败序列全部回放
const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(here, 'fixtures', 'source-kernel')
for (const file of readdirSync(fixtureDir).filter((f) => f.endsWith('.json'))) {
  const spec = JSON.parse(readFileSync(join(fixtureDir, file), 'utf8'))
  process.env.SEED = String(spec.seed)
  process.env.STEPS = String(spec.steps)
  runSeed(spec.seed)
}

console.log(`PASS source-kernel state machine (${SEEDS.length} seeds x ${STEPS} steps)`)
```

- [ ] **Step 2: Run and stabilize**

Run: `node scripts/test-source-kernel-statemachine.mjs`
Expected: 首轮很可能暴露命令边界 bug（这正是本任务的目的）。对每个失败：
1. 用 `SEED=<n> STEPS=<m> node scripts/test-source-kernel-statemachine.mjs` 复现；
2. 二分缩小 STEPS 找最小复现；
3. 修复对应命令（修复提交单独 `fix(source-kernel): …`）；
4. 将最小序列存为 `scripts/fixtures/source-kernel/seed-<n>-<描述>.json`（`{ "seed": n, "steps": m, "note": "…" }`）。
全部 12 seeds 通过后进入 Step 3。

- [ ] **Step 3: Commit**

```bash
git add scripts/test-source-kernel-statemachine.mjs scripts/fixtures/source-kernel
git commit -m "test(source-kernel): seeded state-machine invariant suite"
```

---

### Task 10: 脚本注册 + 文档收尾

**Files:**
- Modify: `package.json`（scripts）
- Modify: `CHANGELOG.md`
- Modify: `docs/transaction-source-sync-architecture.md`（末尾追加一节，指向 spec 与本计划）

**Interfaces:**
- Produces: `npm run test:source-kernel`（聚合六个内核测试）；并入 `test:core`。

- [ ] **Step 1: Add npm scripts**

`package.json` scripts 增加（kebab-case、纯函数无 `-ui` 后缀，与仓库惯例一致）：

```json
"test:source-kernel": "node scripts/test-source-kernel-document.mjs && node scripts/test-source-kernel-index.mjs && node scripts/test-source-kernel-charmap.mjs && node scripts/test-source-kernel-commands.mjs && node scripts/test-source-kernel-indent.mjs && node scripts/test-source-kernel-history.mjs && node scripts/test-source-kernel-statemachine.mjs"
```

并把 `test:core` 的值追加 ` && npm run test:source-kernel`。

- [ ] **Step 2: Run the full aggregate**

Run: `npm run test:source-kernel && npm run test:core`
Expected: 全部 PASS，`test:core` 原有部分无退化。

- [ ] **Step 3: Update docs**

- `CHANGELOG.md` 未发布段落加一行：`- 内部：源码权威内核（纯内核，实验尚未接入 UI）`。
- `docs/transaction-source-sync-architecture.md` 末尾追加小节「源码权威内核（2026-08）」：说明 `lib/source-kernel/` 是 spec 方案 C 的第一阶段纯内核，UI 集成见后续计划二；现有 `mapPlainTextTransactionsToSource` 通道保持不变。

- [ ] **Step 4: Run build to confirm no bundling regression**

Run: `npm run build`
Expected: 构建成功（新目录未被生产 bundle 引用也应无警告失败）。

- [ ] **Step 5: Commit**

```bash
git add package.json CHANGELOG.md docs/transaction-source-sync-architecture.md
git commit -m "test(source-kernel): register kernel suite in test:core"
```

---

## Self-Review 记录

- **Spec 覆盖**：本计划覆盖 spec 的 MarkdownDocument、LosslessSyntaxIndex、SourceCharacterMap、SourceCommandRouter（结构半边 + 通用替换）、源码历史、纯函数/状态机测试策略。**不在本计划**（属计划二）：RichProjection、ProjectionReconciler、CompositionSession、TransactionGateway、实验开关 UI、CodeMirror read-only、保存/外部修改集成、UI 测试、发布门禁全集。
- **偏差声明**：事务结构在 spec 单编辑形状上扩展了 `edits[]` 多编辑（Tab/Shift+Tab 需要"只改前缀"的多行原子编辑；单个跨行 replace 会覆盖未触及字节，违反不变式 6 的最小性精神）。单编辑简写完全兼容 spec 形状。
- **类型一致性**：`applySourceTransaction` 返回的 `inverse` 直接是事务；`routeStructuralKey` 的 `not-structural` 是路由信号不是错误；所有命令 ctx 均为 `{ doc, index, offset }`（replace-text 例外：`{ doc, map, visFrom, visTo, insert }`）。
- **已知实现风险**（执行时按测试为准修正，不改接口）：Task 2 `previousSibling`/`parent` 的取法、Task 3 软换行前缀贪婪消费、Task 8 merge 边界。这些点的测试断言是权威。
