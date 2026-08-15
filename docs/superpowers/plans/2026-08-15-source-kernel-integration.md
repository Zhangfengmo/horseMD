# 源码权威内核 · 计划二：编辑器集成 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把计划一交付的纯内核（`src/renderer/src/lib/source-kernel/`，已合并，`npm run test:source-kernel` 绿）接入 Crepe 编辑器：标签页级"源码权威内核（实验）"开关、RichProjection/Reconciler、TransactionGateway、CompositionSession、保存/模式切换接管、未迁移操作的显式阻止，及全套 UI 回归。

**Architecture:** 内核状态（doc/history/projection/composition）住在 Editor.jsx 闭包的 `kernelRef` 里，随 Crepe 挂载创建；开关是 App 级 per-tab Set，切换时 bump `reloadNonce` 重挂 Crepe（静态配置差异——Toolbar 关、CodeMirror 只读——因此无需动态重配）。文本输入走既有 `dispatchTransaction` 覆盖（`createSourceTransactionDispatch`）新增的 veto 能力；结构键走 PREPEND keymap（`listBackspaceKeymap` 先例，prepend 必然先于 preset 与 history keymap）。投影更新分两级：普通输入"复用原事务 + 验证"，结构命令"最小 Fragment diff 替换"。所有偏移映射走结构路径对齐（禁文本搜索/ordinal）。

**Tech Stack:** 计划一内核模块 + Milkdown Crepe 7.21.2（`@milkdown/kit/core` ctx、`@milkdown/prose/*`）+ 既有 CDP 测试基建（`electron-test-app.mjs`、`human-input.mjs`、`Input.imeSetComposition` 先例）。

## Global Constraints

- 实验模式默认关闭；开关是**标签页会话级**（不入 settings、不入文件）；heavy/纯文本标签不适用。
- 内核开启的标签页：保存/源码切换/导出读到的 Markdown 必须是 `kernel.doc.text`，绝不经 Milkdown serializer。
- fail-closed：无法证明映射的事务必须 veto + 提示（错误码沿用内核稳定集合 + `projection-mismatch`、`unsupported-input-type`），绝不猜测提交；被 veto 的 PM 事务不得进入 `view.updateState`。
- 禁止生成 `&#x20;`/`&nbsp;`/HTML 注释/零宽哨兵；禁止全文唯一子串/ordinal/文本搜索定位（新代码；`editor-source-map.js` 旧路径不动）。
- 普通按键后未触及的 CodeMirror/图片/Mermaid/表格 node view 不得重建（DOM identity 保持）。
- IME：合成期间放行 composing 事务、不写源码、不进历史；`compositionend` 收敛为一个源码事务 = 一个 undo 单元；失败恢复合成前投影，不把拼音写入源码。
- 非内核标签的一切现有行为零改变（所有新逻辑 `sourceKernelMode`-gated）；`test:core` 与现有 UI 专项无退化。
- 计划一遗留必修项已在 final fix wave 完成（inverse selection 已修）；错误码需常量化导出（本计划 Task 1 顺带做）。
- Milkdown 7.21.2 事实（探查核实）：`CrepeFeature` 无 `SelectionTooltip`/`SlashCommand` 成员（现配置写入 `"undefined"` 键，无效但无害——本计划不扩大修理，只加注释）；关选区工具栏用 `[Feature.Toolbar]: false`；块拖拽事务带 `getMeta('uiEvent')==='drop'`；paste 带 `'paste'`。
- prosePluginsCtx PREPEND 的 keymap 必然先于 preset/history keymap（`@milkdown/core` 把 keymapCtx 合成的 keymap 追加在数组最末，node_modules/@milkdown/core/lib/index.js:388-405）。
- UI 测试逐字符输入用 `scripts/lib/human-input.mjs`；IME 用 `test-ime-source-fidelity-ui.mjs` 的 rawKeyDown+`Input.imeSetComposition` 交错 + `Input.insertText` 提交模式；测试必须覆盖保存字节、进程退出、冷重开，不能只查 DOM。
- 工作树可能有无关未提交改动：每个任务只 `git add` 自己的文件；提交信息 `feat(kernel-mode)|fix(kernel-mode)|test(kernel-mode): …`。

---

### Task 1: 错误码常量 + ProjectionMap（结构路径 pm↔raw 映射）

**Files:**
- Modify: `src/renderer/src/lib/source-kernel/index.js`（追加错误码常量导出）
- Create: `src/renderer/src/components/editor-kernel-projection-map.js`
- Create: `scripts/test-kernel-projection-map.mjs`

**Interfaces:**
- Consumes: `buildSyntaxIndex`、`buildCharacterMap`（计划一）；测试侧手搭 PM `Schema`（照抄 `scripts/test-editor-source-map.mjs:12-31` 的模式）+ `unified/remark-parse/remark-gfm`。
- Produces:
  - `index.js` 新增：`export const KERNEL_CODES = Object.freeze({ STALE: 'stale-revision', INVALID: 'invalid-range', UNMAPPED: 'unmapped-selection', UNSUPPORTED: 'unsupported-structure', NOT_STRUCTURAL: 'not-structural', PROJECTION: 'projection-mismatch', INPUT_TYPE: 'unsupported-input-type' })`
  - `buildProjectionMap(markdown, pmDoc) -> map | null`（fail-closed）：
    - `map.pmPosToRaw(pmPos) -> number | null`（原始 raw offset）
    - `map.rawToPmPos(rawOffset) -> { pos, atom } | null`
    - `map.blockPairs`：`[{ mdBlock, pmNode, pmPos, charMap|null }]`
  - 对齐算法（**结构路径，零文本匹配**）：同一份 markdown 分别产出 mdast（内核 `buildSyntaxIndex(markdown).tree`）和 pmDoc；同步深度优先走两棵树的**块级节点序列**（paragraph/heading/blockquote/list/listItem/code/table/… ↔ PM 的同类 node type），按序配对——两棵树来自同一源，块序必然一致；任何一步类型/数量对不上 → 整体 `null`。块内字符级：`buildCharacterMap(markdown, mdBlock.node)` 的 units 顺序对齐 PM textblock 的 content（PM atom 宽 1 ↔ charMap atom unit；PM text 字符 ↔ char/escape/entity/linebreak units 的 width 累计）。

- [ ] **Step 1: Write the failing test**

`scripts/test-kernel-projection-map.mjs`（断言要点，完整用例执行者按此扩展）：

```js
import assert from 'node:assert/strict'
import { Schema } from '@milkdown/prose/model'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { buildProjectionMap } from '../src/renderer/src/components/editor-kernel-projection-map.js'
import { KERNEL_CODES } from '../src/renderer/src/lib/source-kernel/index.js'

assert.equal(KERNEL_CODES.PROJECTION, 'projection-mismatch')

// 手搭 schema（照抄 test-editor-source-map.mjs 的 doc/paragraph/heading/bullet_list/list_item/image/text）
const schema = new Schema({ nodes: { /* 同 test-editor-source-map.mjs:12-31 */ }, marks: {} })
const p = (...c) => schema.node('paragraph', null, c)
const doc = (...c) => schema.node('doc', null, c)
const text = (s) => schema.text(s)

// 纯段落：pm pos ↔ raw 双向一致
{
  const md = '甲乙\n\n丙\n'
  const d = doc(p(text('甲乙')), p(text('丙')))
  const map = buildProjectionMap(md, d)
  assert.ok(map)
  assert.equal(map.pmPosToRaw(1), 0)        // 甲 前
  assert.equal(map.pmPosToRaw(3), 2)        // 乙 后
  assert.equal(map.rawToPmPos(4).pos, 5)    // 丙 前（第二段 contentPos）
}
// 转义：raw 'a\*b' ↔ PM 'a*b'，PM pos 2（* 后）→ raw 4
{
  const md = 'a\\*b\n'
  const d = doc(p(text('a*b')))
  const map = buildProjectionMap(md, d)
  assert.equal(map.pmPosToRaw(3), 4)
}
// 列表 + 任务：块序配对；块内偏移正确
{
  const md = '- 甲\n- [x] 乙\n'
  const d = doc(schema.node('bullet_list', null, [
    schema.node('list_item', null, [p(text('甲'))]),
    schema.node('list_item', null, [p(text('乙'))])
  ]))
  const map = buildProjectionMap(md, d)
  assert.ok(map)
  const rawYi = map.pmPosToRaw(/* 乙 的 textblock content 起点，执行者用 d.resolve 求 */ 8)
  assert.equal(md.slice(rawYi, rawYi + 1), '乙')
}
// 结构不一致 → null（fail-closed）
{
  const md = '# 头\n'
  const d = doc(p(text('头')))          // heading vs paragraph
  assert.equal(buildProjectionMap(md, d), null)
}
// atom（image）：宽 1 对齐
{
  const md = '前![a](x.png)后\n'
  const d = doc(p(text('前'), schema.node('image'), text('后')))
  const map = buildProjectionMap(md, d)
  assert.ok(map)
  assert.equal(md.slice(map.pmPosToRaw(2), map.pmPosToRaw(3)), '![a](x.png)')
}
console.log('PASS kernel projection map')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-kernel-projection-map.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Implement**

`editor-kernel-projection-map.js` 核心骨架（执行者按测试补齐）：

```js
import { buildSyntaxIndex, buildCharacterMap } from '../lib/source-kernel/index.js'

// PM 块级 node 名 → mdast 块类型的配对表；两侧都按文档序线性展开后逐一配对。
const PM_TO_MD = {
  paragraph: ['paragraph'], heading: ['heading'], blockquote: ['blockquote'],
  bullet_list: ['list'], ordered_list: ['list'], list_item: ['listItem'],
  code_block: ['code', 'math'], table: ['table'], hr: ['thematicBreak'], html: ['html']
}
const flattenPm = (doc) => { /* doc.descendants 收集块级 {node, pos}，容器也入列以保序 */ }
const flattenMd = (tree) => { /* 同序收集 mdast 块节点 */ }

export function buildProjectionMap(markdown, pmDoc) {
  const index = buildSyntaxIndex(markdown)
  const pmBlocks = flattenPm(pmDoc)
  const mdBlocks = flattenMd(index.tree)
  if (pmBlocks.length !== mdBlocks.length) return null
  const blockPairs = []
  for (let i = 0; i < pmBlocks.length; i += 1) {
    const pm = pmBlocks[i], md = mdBlocks[i]
    if (!(PM_TO_MD[pm.node.type.name] || []).includes(md.type)) return null
    const leaf = pm.node.isTextblock
    const charMap = leaf ? buildCharacterMap(markdown, md.node) : null
    if (leaf && !charMap) return null      // 可编辑块必须有字符映射，否则整体拒绝
    blockPairs.push({ mdBlock: md, pmNode: pm.node, pmPos: pm.pos, charMap })
  }
  const pmPosToRaw = (pmPos) => { /* 定位所属 textblock pair → 块内 offset → charMap.visibleToRaw */ }
  const rawToPmPos = (raw) => { /* 定位所属 mdBlock → charMap units 反查 → pmPos；atom → {pos, atom:true} */ }
  return { blockPairs, pmPosToRaw, rawToPmPos }
}
```

实现要点：atom 的 PM 宽度=1 对齐 charMap 的 atom unit（宽 1）；`linebreak` unit 对齐 PM hardbreak/softbreak 表示（Crepe 段内软换行是文本 '\n' 还是 hardbreak node，执行者以真实 parse 观察为准并在注释记录）；边界取"前单元末"约定（计划一 Task 3 已定）。**禁止任何 `indexOf`/文本搜索。**

- [ ] **Step 4: Run until PASS + 计划一套件无退化**

Run: `node scripts/test-kernel-projection-map.mjs && npm run test:source-kernel`

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/source-kernel/index.js src/renderer/src/components/editor-kernel-projection-map.js scripts/test-kernel-projection-map.mjs
git commit -m "feat(kernel-mode): structural-path projection map and kernel error codes"
```

---

### Task 2: dispatchTransaction veto 能力

**Files:**
- Modify: `src/renderer/src/components/editor-source-transactions.js`
- Create: `scripts/test-kernel-dispatch-veto.mjs`

**Interfaces:**
- Produces: `createSourceTransactionDispatch(onTransactions)` 行为扩展——`onTransactions(transactions, oldState, newState)` 返回 `{ veto: true }` 时**不调用** `view.updateState`（视图停在旧 state）；返回 undefined/其他 → 现行为不变（Editor.jsx:773 的 `handleSourceTransactions` 现返回 undefined，零影响）。
- 选择-only 事务（`!docChanged`）不经 veto 判定，照常应用（块手柄 mousedown 的 NodeSelection 依赖此路径）。

- [ ] **Step 1: Write the failing test**

`scripts/test-kernel-dispatch-veto.mjs`：用 stub view（`{ state: fakeEditorState, updateState: 记录调用 }`，fakeState 用 `EditorState.create({schema})` + 真实 transaction）断言：(a) onTransactions 返回 `{veto:true}` → `updateState` 未被调；(b) 返回 undefined → 被调一次且 state 为 applied；(c) `!docChanged` 的 setSelection 事务 → 不调 onTransactions 的 veto 分支、照常 updateState。断言库 node:assert/strict，schema 手搭。

- [ ] **Step 2: Run to fail** → **Step 3: Implement**（`editor-source-transactions.js` 在 `if (changed) …` 处捕获返回值：`const verdict = changed ? onTransactions?.(…) : undefined; if (verdict?.veto) return; view.updateState(applied.state)`）→ **Step 4: PASS + `npm run test:source-transaction-sync` 无退化** → **Step 5: Commit**

```bash
git add src/renderer/src/components/editor-source-transactions.js scripts/test-kernel-dispatch-veto.mjs
git commit -m "feat(kernel-mode): dispatch veto channel for fail-closed transactions"
```

---

### Task 3: Gateway 核心（事务分类 + 文本提交，纯函数）

**Files:**
- Create: `src/renderer/src/components/editor-kernel-gateway.js`
- Create: `scripts/test-kernel-gateway.mjs`

**Interfaces:**
- Consumes: Task 1 map、内核全套命令、`KERNEL_CODES`。
- Produces:
  - `classifyTransactions(transactions, oldState) -> { kind: 'selection-only' | 'composition' | 'projection' | 'plain-text' | 'blocked', steps?, blockedCode? }`
    - `projection`：任一 tr 带 `sourceProjection` meta；
    - `composition`：调用方标注（gateway 不自判，接收 `isComposing` 参数）；
    - `plain-text`：全部 step 为 ReplaceStep、slice 无结构节点、局限单一 textblock（判定逻辑可参考 `source-transaction-sync.js:158-260` 的守卫思路，但**不引入其 raw 匹配**——那属于旧路径）；
    - `blocked`：`getMeta('uiEvent') === 'drop'` → `INPUT_TYPE`；其余不可分类 docChanged → `INPUT_TYPE`。
  - `commitPlainText({ kernel, map, transactions, oldState }) -> { ok: true, applied, transaction } | { ok: false, code }`：把 steps 的 PM 范围经 `map.pmPosToRaw` 映射为 raw 范围（两端都必须可证明，否则 `UNMAPPED`），插入文本取 slice 的纯文本，构造 `replaceVisibleText` 同形的直接事务（`{ baseRevision, from, to, insert, intent:'insert-text' }`）并 `applySourceTransaction`。多 step 事务按序映射（每步映射基于 oldState 坐标 + 已应用步的 delta）。

- [ ] **Step 1: failing test** — 手搭 schema + `EditorState`，真实构造 tr（`tr.insertText('x', pos)`、`tr.delete`、带 `setMeta('uiEvent','drop')` 的 tr、跨块 ReplaceStep），断言分类结果与 `commitPlainText` 的字节输出（含转义块内输入：`'a\\*b\n'` 文档在 `*` 后插 'x' → raw `'a\\*xb\n'`）。
- [ ] **Step 2: fail 确认** → **Step 3: implement** → **Step 4: PASS + 计划一套件无退化** → **Step 5: Commit**

```bash
git add src/renderer/src/components/editor-kernel-gateway.js scripts/test-kernel-gateway.mjs
git commit -m "feat(kernel-mode): transaction classifier and plain-text source commit"
```

---

### Task 4: ProjectionReconciler（最小 diff 更新投影）

**Files:**
- Create: `src/renderer/src/components/editor-kernel-reconciler.js`
- Create: `scripts/test-kernel-reconciler.mjs`

**Interfaces:**
- Produces:
  - 纯函数 `diffReplaceRange(oldDoc, newDoc) -> { from, to, insertFrom, insertTo } | null`（null = 无差异）：用 `oldDoc.content.findDiffStart(newDoc.content)` / `findDiffEnd`，重叠时按 PM 惯例收缩（参考 prosemirror-view 内部 diff clamp：`if (start > endA) endA = start` 一侧对齐）。
  - `reconcileProjection({ view, newDoc, mapMeta })`：构造 `tr.replace(from, to, newDoc.slice(insertFrom, insertTo))`，`tr.setMeta('sourceProjection', mapMeta).setMeta('addToHistory', false)`，dispatch。无差异 → no-op。
  - 保证：替换范围外的 node（CodeMirror/图片等）不被触碰 → node view 不重建（PM 对 replace 范围外节点保 identity）。
- [ ] **Step 1: failing test** — 手搭 schema：旧 doc `[p('甲'), code_block('x'), p('乙')]` → 新 doc 仅 `p('乙')` 变 `p('乙丁')`：断言 diff 范围只覆盖第三块；首/尾/中间块增删各一例；无差异 → null；`replace` 应用后 doc `.eq(newDoc)`。
- [ ] **Step 2-5**: fail → implement → PASS（+ 套件无退化）→ commit `feat(kernel-mode): minimal-diff projection reconciler`

---

### Task 5: Editor.jsx 内核模式接线

**Files:**
- Modify: `src/renderer/src/components/Editor.jsx`（props 加 `sourceKernelMode = false`；kernelRef 初始化；handleSourceTransactions 内核分支；API 覆盖；keymaps 注册）
- Modify: `src/renderer/src/components/editor-crepe-setup.js`（接收 `kernelMode` 选项：`[Feature.Toolbar]: !kernelMode`；CodeMirror featureConfig `extensions` 在 kernelMode 时追加 `EditorState.readOnly.of(true)`（from `@milkdown/kit` 的 CM 依赖，与 `tabAtCursorKeymap` 同通道）；prosePluginsCtx PREPEND `kernelStructuralKeymap` 与 `kernelHistoryKeymap`（仅 kernelMode 时））
- Create: `src/renderer/src/components/editor-kernel-mode.js`（把接线逻辑收拢成一个模块，Editor.jsx 只做组装——Editor.jsx 已 2200 行，禁止再膨胀）

**Interfaces（editor-kernel-mode.js 导出）：**
```js
export function createKernelMode({ initialContent, getView, parse /* parseAdapter.parse */, notify, getT, onChange })
// -> {
//   kernel,                          // { doc, history, map, composing:… }
//   handleTransactions(transactions, oldState, newState) -> { veto:true } | undefined,
//   structuralKeymap(),              // ProseMirror keymap plugin：Enter/Tab/Shift-Tab/Backspace/Delete
//   historyKeymap(),                 // Mod-z / Mod-y / Shift-Mod-z
//   apiOverrides,                    // { flushMarkdown, flushMarkdownSettled, replaceMarkdown,
//                                    //   getVerifiedSyncStatus, getRecoveryMarkdown,
//                                    //   markdownOffsetFromSelection, restoreMarkdownOffset }
//   refreshProjectionMap(),          // revision 变更后重建 map（绑定 revision，禁复用旧映射）
//   dispose()
// }
```

**核心语义（实现规范）：**
1. 初始化：`kernel.doc = createMarkdownDocument(initialContent)`；`crepe.create()` 完成后 `kernel.map = buildProjectionMap(doc.text, view.state.doc)`；map 为 null → 立即降级：toast `kernelMode.unmappable` 并把该 tab 视为不可用内核（`handleTransactions` 一律放行 = 旧行为），**绝不静默假装接管**。
2. `handleTransactions`（在 Editor.jsx:829 现有守卫**之前**插入内核分支，`sourceKernelMode` 时旧 shadow 路径不再执行）：
   - `classifyTransactions` → `selection-only`/`projection` → 放行（undefined）；
   - composition（`view.composing` 或 session 活跃）→ 放行 + 交给 Task 6 session 记账；
   - `plain-text` → `commitPlainText`；成功 → `kernel.doc` 前进、`history.record`、`refreshProjectionMap()`（**廉价路径**：本事务即投影更新，无需 reconcile；但必须验证 `parse(kernel.doc.text)` 与 `newState.doc` 的 diff 为空——`diffReplaceRange` 为 null；不为空 → 用 reconcile 修投影并计一次 `PROJECTION` 诊断）、`onChange(doc.text, false)` 发布；失败 → `{veto:true}` + toast（含错误码文案）；
   - `blocked` → `{veto:true}` + toast `kernelMode.unsupported`。
3. `structuralKeymap`：五键 handler——`map.pmPosToRaw(state.selection.head)` 不可证明 → 提示 + `return true`（吞掉，fail-closed）；`routeStructuralKey(key, {doc, index: buildSyntaxIndex(doc.text), offset})`：
   - ok → `applySourceTransaction` → `history.record` → `newDoc = parse(applied.doc.text)` → `reconcileProjection` → 光标 `map.rawToPmPos(applied.selection.anchor)` 设回（`TextSelection.near` 兜底）→ `refreshProjectionMap()` → `onChange` → `return true`；
   - `not-structural`：Enter → 仍然阻止 PM 默认（`return true` + 走 `splitTextBlock` 已覆盖的场景之外一律提示）；Tab → 以 `'\t'` 走 `commitPlainText` 同路径插入（源码优先）→ `return true`；Backspace/Delete → `return false`（放行 PM 产生文本删除事务，由 handleTransactions 的 plain-text 分类接住；跨块删除会被分类为 blocked → veto，符合 fail-closed）；
   - `unsupported-structure` → toast + `return true`。
4. `historyKeymap`：Mod-z → `history.undo(kernel.doc)`；null → `return true`（吞掉，防 PM history 接管）；有事务 → apply + reconcile + caret + `onChange`。Mod-y/Shift-Mod-z 同理 redo。
5. `apiOverrides`（Editor.jsx 在 `createEditorApi(...)` 结果上 `Object.assign`，仅 kernelMode）：`flushMarkdown = () => kernel.doc.text`；`flushMarkdownSettled = async () => { await compositionSettled(); return kernel.doc.text }`（Task 6 提供 settle；本任务先返回 resolved）；`replaceMarkdown(md)` → `crepe.editor.action(replaceAll(prepared))` 后重置 `kernel.doc = createMarkdownDocument(md)` + 重建 map + 清历史；`getVerifiedSyncStatus = () => ({ status: 'kernel-authoritative' })`；`markdownOffsetFromSelection`/`restoreMarkdownOffset` 用 `kernel.map`（**不再走 editor-source-map 的 ordinal 路径**）。
6. `markdownUpdated` 回调在 kernelMode 时仅记诊断（`globalThis.__hmKernelDiagnostics` ring buffer ≤100），不得推进任何 ref（Editor.jsx:1211 回调头部加 `if (sourceKernelMode) { …记诊断; return }`）。
7. Editor.jsx 组装差异（精确挂点，来自探查）：props 解构（:91-107）加 `sourceKernelMode`；`createConfiguredCrepe({...})`（:921-935）传 `kernelMode: sourceKernelMode`；`handleSourceTransactions`（:773）头部 `if (kernelModeRef.current) return kernelHandle(transactions, oldState, newState)`；API 组装（:1711-1758）后 `if (sourceKernelMode) Object.assign(apiRef.current, kernelApi.apiOverrides)`。

- [ ] **Step 1**: 先写 `scripts/test-kernel-mode-headless.mjs`：直接 import `editor-kernel-mode.js`，用手搭 schema + stub parse（`(md) => 手工构造的 newDoc`）驱动 `handleTransactions` 与 keymap handler 的决策路径（ok/veto/not-structural/undo），断言 kernel.doc.text 字节与 veto 判定。（接线本身由 Task 9 UI 测试覆盖。）
- [ ] **Step 2**: fail 确认 → **Step 3**: 实现 editor-kernel-mode.js + 三处接线 → **Step 4**: headless PASS + `npm run build` 成功 + `npm run test:source-kernel` 与 `node scripts/test-source-transaction-sync.mjs`（旧路径）无退化 → **Step 5**: Commit

```bash
git add src/renderer/src/components/editor-kernel-mode.js src/renderer/src/components/Editor.jsx src/renderer/src/components/editor-crepe-setup.js scripts/test-kernel-mode-headless.mjs
git commit -m "feat(kernel-mode): wire source kernel into editor transactions, keymaps and api"
```

---

### Task 6: CompositionSession

**Files:**
- Create: `src/renderer/src/components/editor-kernel-composition.js`
- Modify: `src/renderer/src/components/editor-kernel-mode.js`（组装 session；`flushMarkdownSettled` 真正等待）
- Create: `scripts/test-kernel-composition-headless.mjs`

**Interfaces:**
```js
export function createCompositionSession({ getView, kernel, commitReplace /* rawRange+text → 提交+投影收敛 */, notify, getT })
// -> { onStart(), onEnd(), onCancel(), isActive(), settled() -> Promise<void>, queueExternal(fn), dispose() }
```

**状态机（spec 逐条落地）：**
- `onStart`（compositionstart，capture，view.dom）：`map.pmPosToRaw` 证明当前选区两端 → session `{ baseRevision: doc.revision, rawRange, pmBaseDoc: view.state.doc, state:'composing' }`；证明失败 → session `{state:'invalid'}`（合成仍会发生，结束时回滚）。
- 合成期间：gateway 放行 composing 事务（Task 5 已留口）；不写源码、不进历史；PM 变化超出 session textblock → `state:'invalid'`。
- `onEnd`：`state==='composing'` → diff `pmBaseDoc` vs `view.state.doc`（`diffReplaceRange`）：局限 session textblock → 提取最终文本，`commitReplace(session.rawRange, finalText)`（内部 `history.breakGroup()` 前后包夹 = 一个 undo 单元）；否则回滚：`reconcileProjection` 回 `parse(kernel.doc.text)` + toast `kernelMode.compositionReverted`（错误码 `composition-range-invalidated` 记诊断）。收尾 flush `queueExternal` 队列、resolve `settled()`。
- `onCancel`（compositioncancel）：直接回滚路径。
- `settled()`：无活跃 session → resolved；有 → pending promise，`onEnd/onCancel` 收尾时 resolve（保存路径等待用；沿用 `editor-api-registry.js:15-31` 的 waiters-Set + 超时 resolve 模式，超时 3s 强制回滚并 resolve——**绝不 reject、绝不永久挂起保存**）。
- 监听注册在 view.dom（capture），与现有 `editor-dom-interactions.js:276` 的 compositionend capture 监听共存（那个只 `markUserEdit`，无冲突）；kernelMode 才挂。

- [ ] **Step 1**: headless 测试——stub view（可变 `state.doc` + composing 标志）驱动 start→(PM doc 变化)→end 的提交路径、invalid 回滚路径、cancel、settled() 的 resolve 时序、queueExternal 排队后 flush。断言 commitReplace 收到的 rawRange/text 与回滚时 kernel.doc.text 不变。
- [ ] **Step 2-5**: fail → implement + 组装 → headless PASS + build 通过 + 套件无退化 → commit `feat(kernel-mode): IME composition session with bounded overlay`

---

### Task 7: 未迁移操作显式阻止

**Files:**
- Modify: `src/renderer/src/components/editor-slash-menu.js`（`createSlashPlugin(ctx, getT, onCommand, options)` 加 `options.isBlocked(id) -> string|null`；`render()` 对 blocked 项加 `.disabled` class；`runSelected` 对 blocked 项只 toast 不执行）
- Modify: `src/renderer/src/components/Editor.jsx`（ctxMenu JSX：kernelMode 时隐藏格式子菜单/块转换/列表转换区块——:2028-2145 三处加 `!sourceKernelMode &&` gate；`convertList`/`convertBlockToList` 头部 kernelMode → toast + return）
- Modify: `src/renderer/src/components/editor-crepe-setup.js`（kernelMode 传 `options.isBlocked` 给 slash；块手柄：kernelMode 时不注册 `createBlockHandleGutterPlugin` 且根节点加 `hm-kernel-mode` class）
- Modify: `src/renderer/src/styles/app.css`（`.hm-kernel-mode .milkdown-block-handle { display: none; }`）
- Modify: `src/renderer/src/i18n.jsx`（新 key，en :9 块与 zh :733 块平行位置各一份：`kernelMode.unsupported`＝"源码权威内核实验阶段暂未支持此操作" / "Not supported yet in the experimental source kernel"；`kernelMode.unmappable`、`kernelMode.compositionReverted`、`status.kernelMode`＝"源码内核（实验）"、`kernelMode.toggleOn/Off` 等）

**阻止矩阵（phase 1）：** slash 全部结构项 blocked（含 `code:<lang>`）；右键格式/转换隐藏；选区工具栏整体关（Task 5 的 `[Feature.Toolbar]: false`）；块手柄隐藏 + drop veto（Task 3 已含）；CodeMirror 只读（Task 5）。`applyTextFormat`/`toggleHighlight`/`applyReviewMarkup` 在 kernelMode 的 apiOverrides 里替换为 toast no-op（补入 Task 5 的 overrides 清单）。

- [ ] **Step 1**: 无独立 headless 测试（UI 行为），验证归 Task 11 的 UI 测试。本任务以 `npm run build` + 手动 grep 检查所有 gate 为步骤门槛。
- [ ] **Step 2**: 实现全部 gate → **Step 3**: `npm run build` + `npm run test:source-kernel` + slash 旧行为测试（若 package.json 有 slash 专项则跑）无退化 → **Step 4**: Commit `feat(kernel-mode): explicit blocking for unmigrated operations`

---

### Task 8: 标签页开关 + App/保存/模式切换集成

**Files:**
- Modify: `src/renderer/src/App.jsx`（`kernelModeIds` state（Set，session 不持久化——会话级实验）；`toggleKernelMode(id)`：`await getSettledMarkdownForTab(id)` 成功才切（失败 toast 停止）→ set 翻转 + `reloadNonce+1`（tab.content 已是刚 flush 的文本，重挂即以它初始化内核）；透传 StatusBar/EditorArea）
- Modify: `src/renderer/src/components/shell/EditorArea.jsx`（`sourceKernelMode={kernelModeIds.has(tab.id) && !plainText && !heavyAsSource}` 传给 `<Editor>`（:262-300 挂载点））
- Modify: `src/renderer/src/components/StatusBar.jsx`（:436-442 的源码按钮改为 `block-switch` 弹层，照抄 ThemePicker :59-151 结构：项 1「富文本/源码」（现 onToggleSource 行为），`theme-menu-sep`，项 2「源码权威内核（实验）」checkbox 风格 `block-menu-item${kernelMode ? ' active' : ''}`，onClick → `onToggleKernelMode()`；非 doc/heavy/plain 标签隐藏项 2；移动端 `MobileMore` :231-242 同步加项）
- Modify: `src/renderer/src/hooks/useSourceModeSwitch.js`（kernel 标签进源码模式：`flushRichSource` 对 kernel tab 走 `api.flushMarkdownSettled()`（apiOverrides 已保证返回 kernel 文本，**天然不经 serializer**，无需改动逻辑——确认并加注释即可）；源码编辑回富文本：`syncSourceToRich` 的 `replaceMarkdown` 已被 apiOverrides 接管（重置内核 doc），确认即可）

**保存链路确认清单（这些应当零改动即正确，任务内逐条验证并在报告记录）：** `saveTab` → `getSettledMarkdownForTab` → `api.flushMarkdownSettled()` = 等 composition settle 后的 `kernel.doc.text` ✓；dirty 判定 `content !== savedContent` 基于 onChange 发布的内核文本 ✓；外部文件修改：clean tab reload → `reloadNonce+1` 重挂 → 内核以磁盘文本重建 ✓；dirty tab → 现有 alert 策略不变 ✓；Pandoc 导出 `getMarkdownForTab` 同源 ✓。

- [ ] **Step 1**: 实现 → **Step 2**: `npm run build` + `npm run test:source-kernel` + `npm run test:rich-source-tab-state`（存在则跑）无退化 → **Step 3**: Commit `feat(kernel-mode): per-tab experimental toggle and app integration`

---

### Task 9: UI 冒烟回归（打字/列表/保存/冷重开）

**Files:**
- Create: `scripts/test-kernel-mode-ui.mjs`
- Modify: `package.json`（`"test:kernel-mode-ui": "node scripts/test-kernel-mode-ui.mjs"`）

**脚本骨架**（沿用 `test-quoted-block-source-ui.mjs` 的结构：`/tmp/horsemd-kernel-${pid}` + `launchBuiltElectron` + `waitFor`；CDP_PORT 取未占用值如 10020）：
1. 初始文档 `'# 标\n\n段甲\n\n- 甲\n- [x] 乙\n'` 打开；
2. 打开状态栏弹层（`.block-switch` 内含"源码"字样的按钮 → 点出菜单 → 点「源码权威内核」项——选择器按 Task 8 的 class 写），等待重挂完成；
3. 点击段甲末尾（照抄 clickTextEnd 模式）→ 打字 `'新'` → Enter → 打字 `'乙段'`；点击列表"甲"末尾 → Enter → 打字 `'丙'` → Tab；
4. 切源码模式 → 断言 textarea 字节 === 手工推导的期望（执行者先用内核纯函数推导期望串写死在测试里）；切回富文本；
5. 点击任务复选框（`li input[type=checkbox]` 或 Crepe 的 checkbox DOM）→ 断言 `[x]`→`[ ]`；
6. Cmd/Ctrl+Z 两次 → 断言源码回退符合 undo 组语义；
7. 保存（`.hm-save-fab`）→ `readFile` 逐字节断言；`app.dialogs` 为空（无 rebuild 提示）；
8. `stopBuiltElectron` 完整退出 → 重新 launch 同文件 → 断言重开内容一致（冷重开）。

- [ ] **Step 1**: 写脚本（对第 4 步期望串先用 `node -e` + 内核模块推导）→ **Step 2**: `npm run build && npm run test:kernel-mode-ui` 直到 PASS（失败即真 bug：修在对应模块，单独 fix commit）→ **Step 3**: Commit `test(kernel-mode): typing, list, save and cold-reopen UI regression`

---

### Task 10: IME UI 回归（内核模式合成生命周期）

**Files:**
- Create: `scripts/test-kernel-ime-ui.mjs`
- Modify: `package.json`（`"test:kernel-ime-ui": …`）

照抄 `test-ime-source-fidelity-ui.mjs:47-69` 的 `imeType`（rawKeyDown 与 `Input.imeSetComposition` 交错 + `Input.insertText` 提交）与 `rawKey`。场景：开启内核模式后 (a) 段落中 imeType `'ceshi'`→`'测试'`，切源码断言字节只含"测试"无拼音；(b) 合成中途（imeSetComposition 后不 insertText）直接点保存 FAB → 断言保存等待收敛（3s 超时回滚路径也可接受——断言磁盘无拼音字节）；(c) 合成提交后 Cmd/Ctrl+Z 一次 → 整个"测试"消失（一个 undo 单元）；(d) 冷重开一致。

- [ ] **Step 1-3**: 写→跑到 PASS（暴露 bug 修在 composition/gateway，单独 fix commit）→ commit `test(kernel-mode): IME composition lifecycle regression`

---

### Task 11: node view identity + 阻止矩阵 UI 回归

**Files:**
- Create: `scripts/test-kernel-nodeview-ui.mjs`
- Modify: `package.json`（`"test:kernel-nodeview-ui": …`）

场景：文档含 ` ```js ` 代码块、图片、表格、远处段落。开内核模式后：
1. 在远处段落打 5 个字符 → 断言代码块的 `.cm-editor` DOM 节点 identity 不变（`evaluate` 先把节点存 `window.__hmProbe = document.querySelector('.cm-editor')`，打字后 `window.__hmProbe === document.querySelector('.cm-editor')`）、图片 `img` identity 不变、滚动位置不变；
2. 阻止矩阵：`/` 呼出斜杠菜单 → 断言结构项带 `.disabled` 且点击后文档字节不变；右键 → 断言格式/转换区块不存在；代码块内点击打字 → 内容不变（只读）；选区工具栏不出现（`.milkdown-toolbar` 不存在或不可见）；
3. 全程 `app.dialogs` 为空、保存字节与预期一致。

- [ ] **Step 1-3**: 写→PASS（修 bug 单独 commit）→ commit `test(kernel-mode): node-view identity and blocked-ops regression`

---

### Task 12: 注册 + 文档 + 发布门禁

**Files:**
- Modify: `package.json`（`"test:kernel-ui": "npm run test:kernel-mode-ui && npm run test:kernel-ime-ui && npm run test:kernel-nodeview-ui"`；把 Task 1/2/3/4/5/6 的 headless 测试聚合进 `test:source-kernel` 链尾或新建 `test:kernel-headless` 并入 `test:core`）
- Modify: `CHANGELOG.md`（未发布段：`- 实验：源码权威内核标签页开关（状态栏 · 富文本/源码菜单内），覆盖段落/标题/列表族编辑、IME、保存与冷重开`）
- Modify: `docs/transaction-source-sync-architecture.md`（计划一末节扩写：kernel-mode 接线图、veto 通道、诊断 ring buffer 的读法）
- Modify: `guide/basics/rich-and-source.md`（加"实验性源码权威内核"小节：开关位置、当前支持范围、已知限制——阻止矩阵）
- Modify: `docs/ai-handoff.md`（风险图加 kernel-mode 条目）

- [ ] **Step 1**: 注册脚本 + 文档 → **Step 2**: 发布门禁全跑：`npm run build && npm run build:mobile && npm run test:source-kernel && npm run test:source-map && npm run test:kernel-ui && npm run test:roundtrip-acceptance && npm run guide:check`，另跑现有列表/任务/空段落/首尾空白/模式切换专项中的代表集（`test:list-conversion-ui`、`test:trailing-space-source-ui`、`test:quoted-block-source-ui`、`test:ime-source-fidelity-ui`）确认非内核路径零退化 → **Step 3**: Commit `test(kernel-mode): register kernel-mode suites and docs`

---

## Self-Review 记录

- **Spec 覆盖**：本计划完成 spec 实验模式的第一阶段全部完成标准 1-4、6（版本号/guide/移动构建在 Task 12；标准 5 的"用户已报告流程全部自动化"由计划一测试 + Task 9-11 合并覆盖；标准 7-8 的发版/装机验证属发布流程，超出本计划）。
- **偏差声明**：(1) 实验开关不写入 settings/session（会话级、不持久化）——spec 说"开关状态只属于当前标签页会话"，一致；(2) 切换开关经由 `reloadNonce` 重挂而非动态重配——Crepe featureConfigs 静态，spec 未规定机制，重挂让 Toolbar/CodeMirror 只读等静态差异天然生效，代价是一次重新解析（用户显式操作时可接受）；(3) Backspace/Delete 的"文本路径"回落经 PM 默认删除事务 + gateway 分类接住，而非 keymap 内直接构造删除——减少重复实现，fail-closed 由 blocked 分类兜底。
- **类型一致性**：`KERNEL_CODES` 为唯一错误码来源；`buildProjectionMap` 返回形状在 Task 1/3/5/6 引用一致；`diffReplaceRange` 在 Task 4/5/6 复用；apiOverrides 键名与 editor-api.js 现有 API 名一一对应（探查核实）。
- **已知实现风险**（执行时以测试为准）：mdast↔PM 块序对齐在 frontmatter/html 混排文档上的配对（Task 1 fail-closed 兜底）；Crepe 段内软换行的 PM 表示（Task 1 注明观察后记录）；`EditorState.readOnly` 在 Milkdown CodeMirror feature 的精确 import 路径（Task 5 执行时以 node_modules 实况为准）。
