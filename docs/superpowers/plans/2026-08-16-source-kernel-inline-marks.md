# 源码权威内核 · 计划四：行内 marks + 引用域 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 spec 迁移阶段 2 的剩余语法域：内核模式下选区加粗/斜体/删除线/行内代码/高亮的施加与撤销（工具栏/右键/快捷键全通路解封）、`/quote` 与右键的引用包裹/解除，全部走源码事务；相应放宽阻止矩阵并交付 UI 回归。

**Architecture:** mark 的 marker 原文范围从 mdast 行内节点推导（strong/emphasis/delete/inlineCode 的 position 含 marker；marker 区 = 节点 position 减去子节点 span；highlight 是本仓库自定义 `==`/`<mark class>` 两态——阶段先支持 `==` 纯文本形态，`<mark>` 形态 fail-closed）。施加 = 在映射的 raw 选区两端插 marker（双编辑事务）；撤销 = 删除 mdast 定位的 marker 区。工具栏/右键/快捷键都最终 dispatch AddMarkStep/RemoveMarkStep——gateway 新增 `mark-toggle` 分类拦截并路由内核命令，veto 原 PM 事务后由 reconcile 投影（marker 字节进入源码 → 重解析出真 mark）。引用域：`toggleBlockquote` 是 indent 同款的逐行前缀多编辑命令。

**Tech Stack:** 计划一至三全部模块 + 既有 CDP 基建。

## Global Constraints

- 前序计划全部全局约束有效（fail-closed / 字节保真 / 禁哨兵 / 错误码 / 非内核零改变 / 测试断言权威 / 每任务只 add 自己的文件 / 干净树开工）。
- 已核事实：Crepe 工具栏按钮 dispatch `toggleStrongCommand/toggleEmphasisCommand/toggleStrikethroughCommand/toggleInlineCodeCommand/toggleLinkCommand`（node_modules/@milkdown/crepe getGroups$1 :3515-3612），本质是 PM `toggleMark` → AddMarkStep/RemoveMarkStep；HorseMD 自有 `applyTextFormat`（editor-api.js:104）同样走 toggleMark；kernel 模式当前 `[Feature.Toolbar]: false`（P2-5）+ apiOverrides 把 applyTextFormat/toggleHighlight/applyReviewMarkup 换成拒绝 no-op（P2-5/P2-7）+ 右键格式子菜单隐藏（P2-7）。
- mdast 行内节点 position 含定界符；children 有独立 position——marker 前区 = [node.start, firstChild.start)，后区 = [lastChild.end, node.end)。inlineCode 无 children（value 节点）：marker 宽度 = 节点文本减 value 长度对称推导（反引号 run 长度可变——以 raw 切片实测）。以探针核实后写入实现。
- 高亮 `==text==`：remark 侧是本仓库自定义 find-and-replace（editor-highlight.js）——mdast 树上呈现什么形态（自定义节点? 文本?）必须先探针确认；不可证明 → 该 mark fail-closed（阻止 + 提示），不得猜。
- link 本计划**不做**（`[text](url)` 涉及 URL 输入 UI 流,复杂度独立）——工具栏 link 按钮在内核模式保持拒绝提示；写进阻止矩阵文档。
- 施加 mark 的字节语义：marker 逐字插入（`**`/`*`/`~~`/`` ` ``/`==`），无智能空白调整；选区含已有 marker/跨块/部分重叠既有 mark → `unsupported-structure` 拒绝（阶段语义，测试权威）。撤销：选区完全被单一 mark 节点覆盖时删其 marker 区；其余拒绝。
- CommonMark 陷阱须测试钉住：`**` 紧贴空白的无效强调（选区首尾是空格 → 拒绝或收缩?——**收缩到非空白边界**，Typora 同款，测试权威）；行内代码选区含反引号 → 反引号 run 升级或拒绝（简单做:拒绝，fail-closed）。
- 引用包裹：当前块（段落/标题/列表整体）逐行加 `> `；解除：逐行去一层 `QUOTE_MARKER`；嵌套引用加/减一层。多编辑原子事务（indent 先例）。

---

### Task 1: mark-map（mdast 行内 mark 的 marker 范围推导）

**Files:** Create `src/renderer/src/lib/source-kernel/mark-map.js` + `scripts/test-source-kernel-markmap.mjs`；Modify kernel `index.js`（导出）。
**Interfaces:** `inlineMarkAt(index, rawFrom, rawTo) -> { type: 'strong'|'emphasis'|'delete'|'inlineCode'|'highlight', openRange: {from,to}, closeRange: {from,to}, contentRange: {from,to} } | null`（选区 [rawFrom,rawTo] 恰被该 mark 的 content 覆盖时返回；否则 null）；`markerFor(kind) -> string`。先探针确认：strong/emphasis/delete 的 position 语义、inlineCode 反引号 run、highlight 在本仓库 remark 链（内核自己的 unified 链无 editor-highlight 插件！——highlight 在内核 mdast 里是普通文本 `==x==` → 推导方式改为文本扫描? **禁文本搜索**——改为:highlight 施加允许（纯插入字节），撤销仅当选区两端紧邻 `==` 字节（由 charmap 单元与 raw 切片证明,非搜索）；实现细节以探针+测试定,报告记录 ADR）。
- [ ] TDD：探针 → 失败测试（各 mark 类型的 open/close/content 字节断言;嵌套 mark（strong 内 emphasis）取最内层;部分覆盖 → null;CRLF 文档）→ 实现 → PASS（全内核套件无退化）→ commit `feat(source-kernel): inline mark marker-range derivation`

### Task 2: toggle 命令（施加/撤销/收缩）

**Files:** Create `src/renderer/src/lib/source-kernel/commands/mark-toggle.js` + 扩展 commands 测试；kernel index 导出。
**Interfaces:** `toggleInlineMark({doc, index, map, visFrom, visTo, kind}) -> result`：
1. 空白收缩（首尾空白字符收缩到非空白;全空白选区 → 拒绝）；
2. 经 map 证明 raw 范围；跨块/含 atom/不可证明 → `UNMAPPED`；
3. 若 `inlineMarkAt` 命中同 kind → 撤销（双编辑删 open/close）；命中异 kind 或部分重叠 → `unsupported-structure`；
4. 否则施加（双编辑插 marker）；inlineCode 选区含 `` ` `` → 拒绝；
5. selection 结果 = 施加后 content 两端（含 marker 内侧）。
- [ ] TDD：字节用例（加粗/斜体/删除线/行内代码/高亮 各 施加+撤销；空白收缩；含反引号拒绝；跨块拒绝；引用内段落选区；CRLF）→ 实现 → PASS → commit `feat(source-kernel): inline mark toggle command`

### Task 3: gateway 分类 + kernel-mode 路由 + UI 解封

**Files:** Modify `editor-kernel-gateway.js`（`extractMarkToggle(transactions, oldState)`：单块选区上的纯 AddMarkStep/RemoveMarkStep 批次 → `{kind:'mark-toggle', markName, from, to, add}`；PM mark 名 → 内核 kind 映射表：strong/em/strikethrough(名字以 schema 实测为准)/inline-code(实测)/hm-highlight(实测)；link/其他 → blocked）；Modify `editor-kernel-mode.js`（路由：veto 原事务 → toggleInlineMark → 提交 → reconcile 投影 → caret；失败 veto+toast）；Modify `editor-crepe-setup.js`（kernel 模式 `[Feature.Toolbar]: true` 恢复——工具栏回归可用）；Modify `Editor.jsx`（apiOverrides 的 applyTextFormat 改为路由内核（bold/italic/strike/code/highlight），link 仍拒绝；右键格式子菜单解封（去掉 `!sourceKernelMode` gate，link 项单独禁用样式））；Modify `editor-kernel-cm-bridge.js` 若有涉及（无预期）。
- [ ] TDD：gateway 测试（真实 toggleMark 事务 → 分类/字节;link → blocked）；mode-headless 端到端（工具栏形状事务 → 源码得 `**`，PM 重投影出 strong;撤销）→ 实现 → 全 headless + build + `test:kernel-nodeview-ui`（工具栏重现后原"工具栏不出现"断言需更新为"出现且可用"——同步改）→ commit `feat(kernel-mode): route inline mark toggles through the kernel`

### Task 4: 引用域命令 + UI 解封

**Files:** Create `src/renderer/src/lib/source-kernel/commands/quote-toggle.js`（`toggleBlockquote({doc, index, offset}) -> result`：定位当前顶层块（段落/标题/列表整块——列表取 outer list 范围）；wrap：每非空行行首（现有引用前缀之后）插 `> `；unwrap：当前块每行去一层 `QUOTE_MARKER`（无引用层 → 拒绝）；多编辑原子;caret 跟随偏移）；Modify slash（`/quote` 项在内核模式解封 → 路由内核命令;其余结构项仍禁）+ ctxmenu 引用转换项解封（若存在;不存在则仅 slash + 快捷键 Mod-Shift-B? 以现有 UI 实测为准,不新增 UI 面）；kernel-mode 路由。
- [ ] TDD：命令字节用例（段落 wrap/unwrap;标题;列表整块;嵌套引用加减层;CRLF;空行跳过）→ gateway/mode 路由测试 → 实现 → PASS → commit `feat(kernel-mode): blockquote wrap and unwrap via source transactions`

### Task 5: UI 回归（marks + quote 端到端）

**Files:** Create `scripts/test-kernel-marks-ui.mjs`（port 10024）+ package.json 注册并入 `test:kernel-ui`。
场景：开内核 → 选中段落文字 → 工具栏加粗 → 源码断言 `**`；再点撤销粗;右键斜体;快捷键 Mod-B;高亮按钮 `==`；行内代码;含空白选区收缩断言；`/quote` 包裹段落 → 源码 `> `;再 unwrap;列表整块 wrap;undo 组语义;保存 readFile 字节;冷重开;live-attach 断言;dialogs 空。全部字节 kernel oracle 推导;反空转正控（选中后确认 toolbar 出现、activeElement 等）。
- [ ] 写→跑到 2 连稳（真 bug 修 owning module 单独 commit）→ `npm run test:kernel-ui` 全链 → commit `test(kernel-mode): inline marks and quote domain end-to-end regression`

### Task 6: 收尾（阻止矩阵/文档/门禁）

**Files:** guide/docs/CHANGELOG 更新（marks+quote 已支持;link/表格/图片/HTML/数学/mermaid 仍阻止）；ai-handoff 更新。
门禁：`npm run build && npm run build:mobile && npm run test:core && npm run test:kernel-ui && npm run test:source-kernel && npm run guide:check` + legacy 代表 4 项。
- [ ] 全跑 → commit `test(kernel-mode): register inline marks domain and update docs`

---

## Self-Review 记录
- 完成 spec 迁移阶段 2（引用/代码块/行内 marks）全部——link 除外（独立 UI 流,已声明阻止并入文档）；阶段 3（表格/图片/HTML/数学/Mermaid）留计划五。
- 高亮的 mdast 形态、PM mark 名、schema 细节均以任务内探针为准（brief 提供推导路径而非硬编码）。
- 风险点：Toolbar 重新启用后 P2-11/P3 的"工具栏不出现"断言需同步翻转（Task 3 内完成,不得遗漏）。
