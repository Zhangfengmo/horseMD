# 源码权威内核 · 计划五：阶段 3 语法域 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 spec 迁移阶段 3。**先治降级**（数学/行内 HTML/高亮三类形状目前会让整篇文档在内核模式下拒绝建图），**再扩编辑**（表格单元格、图片属性、链接 URL 流）。

**Architecture:** 降级治理的统一手法是"让 kernel mdast 与 PM 块序对齐"：数学靠给内核链补 `remark-math`（node_modules 已装，需提为直接依赖）产出带 position 的 `math`/`inlineMath` 节点；行内 HTML 靠在 projection-map 的 flatten 阶段合并 mdast 的连续 html/text 段以对上 PM 的单个合并原子（**不**把无 position 的 `remarkMergeInlineHtml` 引入内核链）；高亮靠自写 micromark 扩展 + mdast-util 对产出带 position 的节点（`mdast-util-find-and-replace` 不产 position，违反 unit 契约）。编辑扩展沿用既有范式：命令层纯函数 + gateway 分类 + charMap 单元。

**Tech Stack:** 计划一至四全部模块 + `remark-math`/`mdast-util-math`/`micromark-extension-math`（已装）+ micromark util 家族（已装）。

## Global Constraints

- 前序计划全部全局约束继续有效（fail-closed、字节保真、禁哨兵、错误码集合、非内核路径零改变、UTF-16 偏移、测试断言权威、每任务只 `git add` 自己的文件、干净树开工）。
- **禁止把无 position 的节点引入内核 mdast**：每个 charMap unit 必须有可证明的 `rawStart/rawEnd`。`mdast-util-find-and-replace` 产出的节点无 position（探查已核），不得用于内核链。
- **降级 vs 不可编辑的区别**：本计划的"治降级"目标是让这些形状**配对成功但 charMap 为 null**（非可编辑叶，同 mermaid/表格现状），使文档其余部分可用；"可编辑"是各域后续目标，任务内明确区分。
- 探查已核事实（实现时引用，勿重复推导）：
  - PM 表格 4 层（table / table_header_row·table_row / table_cell·table_header / **paragraph**），mdast 3 层（table / tableRow / tableCell → phrasing，**无 paragraph**）；mdast 无 header/body 分组节点，**分隔行无任何 mdast 节点**；cell 的 position **含左 `|` 与两侧空格**。
  - `table-source-parse.js` 的 `mappingUnits` 已覆盖 escape/entity/inlineCode 反引号/atom 解码语义（唯一可直接对等的部分），但坐标系（`{start,end}` vs `{rawStart,rawEnd,width,kind}`）、CRLF 归一化、少一层 paragraph、"三方对账 patch"范式均与内核 charMap 契约不同。
  - mdast `image` 是 leaf，`alt` 是**字符串属性非 children**；PM 有 `image-block`（atom，本仓覆写加了 `alt` attr，见 `editor-image-markdown.js:20-65`）与 inline `image`（atom，attrs `{src,alt,title}`）两种；inline image 在内核里**已是可用的 atom unit**（projection-map 测试 Case 5 已验证）。
  - kernel 链 inline HTML = **多个独立 html 节点**（`<span>` 与 `</span>` 各一个），editor 链经 `remarkMergeInlineHtml` 合成**一个无 position 的 html 节点** → PM 单原子。节点数不匹配 → `projection-map:525` 整图 null。
  - kernel 链**无 remark-math**：`$x^2$` 与 `$$\nE=mc^2\n$$` 均为纯 text（后者整块是 paragraph 内一个 text 节点）。PM 侧 inline math 节点名 `math_inline`，block math = `code_block` + `language='LaTeX'`；`PM_TO_MD.code_block` 已含 `'math'`。
  - 高亮：PM mark 名 `highlight`（attrs.color，默认 yellow；红/蓝走 `<mark class>` HTML 形态）；kernel 链完全不认 `==` → `content.size !== visibleLength` → 整图 null。gateway 已有 `MARK_TOGGLE_KINDS.highlight` 与非 yellow 拒绝（`:331`）。
  - 链接：`toggleLinkCommand` **无 payload**（靠 selection）；LinkTooltip 的 `#confirmEdit` 在**一个 tr 里** dispatch `removeMark` + `addMark`（空选区时还含 `insertText`）——gateway 现有 `extractMarkToggle` 明确拒绝混合形态（`:326`）。mdast `link` 的 children 是带 position 的 phrasing，`url`/`title` 是字符串属性。
  - 阻止点清单（解封时逐项定位）：gateway `:80-89 textblockProfile`（任何非 text 的 inline 子节点 → 整批 blocked）、`:268-274 MARK_TOGGLE_KINDS`、`:331`；projection-map `:79 NON_EDITABLE_LEAF_TYPES`、`:97 READONLY_CODE_LANGUAGES`、`:107 OPAQUE_TYPES`、`:357`、`:390`、`:506`、`:525`；slash `editor-crepe-setup.js:267-273`；apiOverrides `editor-kernel-mode.js:1449`（link 唯一拒绝点）；cm-bridge `:148`。
- 每个降级治理任务必须附**挂载回归测试**：含该形状的文档 → 建图成功（非 null）、其余块可编辑、该形状本身按声明可编辑或 charMap null。

---

### Task 1: 数学域配对（治降级 + block math 可编辑）

**Files:** Modify `package.json`（`remark-math` 提为直接依赖，版本以 node_modules 实装为准）、`src/renderer/src/lib/source-kernel/syntax-index.js`（内核链加 `.use(remarkMath)`）、`editor-kernel-projection-map.js`（`math_inline` 作为 inline atom 参与 charMap；block math 的 code_block↔mdast math 配对已有白名单，验证 `:390` 的 `md.type === 'math'` 强制只读是否解除）、`src/renderer/src/lib/source-kernel/character-map.js`（`inlineMath` 加入 ATOMS 或按 inlineCode 先例做单元）；Tests: `test-source-kernel-charmap.mjs`、`test-kernel-projection-map.mjs`、`test-source-kernel-index.mjs`（内核链变更影响全部既有解析——**全套回归是硬门**）。

**语义：**
- 加 `remark-math` 后 `$x$` → `inlineMath`（有 position），`$$..$$` → `math`（有 position）。**验证这不改变既有任何形状的解析**（`$5` 之类非数学文本；`test:source-kernel` 全绿是门）。
- inline math 作为 atom unit（width 1，raw 覆盖 `$...$`），使 `content.size === visibleLength` 成立 → 治降级。
- block math：PM `code_block` + `language='LaTeX'` ↔ mdast `math`。**先只治降级**（保持 `READONLY_CODE_LANGUAGES` 含 latex → charMap null）；若 code-map 能证明 `math.value` 与 `$$` 围栏的逐行映射（同 code fence 手法），**可选**在本任务内解除 latex 只读使 block math 可编辑——以字节测试为准，证明不了就保持只读并记录。
- [ ] TDD：内核链解析探针（`$x$`/`$$..$$`/`$5`/转义 `\$`）→ 失败测试（含数学的文档建图成功；inline math atom 边界；block math 配对）→ 实现 → 全套内核测试绿 → commit `feat(source-kernel): math domain pairing heals map degradation`

### Task 2: 行内 HTML 配对（治降级）

**Files:** Modify `editor-kernel-projection-map.js`（flatten 阶段合并 mdast 连续 inline html/text 段以对上 PM 的单个 html 原子）+ `character-map.js`（合并段作为 atom unit，raw 覆盖完整平衡片段）；Tests 同上三件套。

**语义：** 不改内核链（不引入无 position 的合并插件）。在 `flattenMd`/`collectUnits` 侧识别"开标签 html 节点 → 直到平衡闭合的连续兄弟"，产出**一个** atom unit，raw 范围 = 首节点 start 到末节点 end（全部有 position，可证明）。不平衡/含 mark 的片段 → fail-closed（该块 charMap null，非整图）。block html 维持现状（`NON_EDITABLE_LEAF_TYPES`）。
- [ ] TDD：`<span>x</span>`、嵌套 `<b><i>x</i></b>`、自闭合 `<br/>`、不平衡 `<span>x`、含 emphasis 的片段（editor 链会放弃合并 → PM 侧是多节点，内核侧须一致）→ 实现 → commit `feat(source-kernel): inline html coalescing heals map degradation`

### Task 3: 高亮配对（治降级 + 解封高亮按钮）

**Files:** Create `src/renderer/src/lib/source-kernel/micromark-highlight.js`（micromark 扩展 + mdast-util 对，产出带 position 的 `highlight` 节点；语法与 `editor-highlight.js:29` 的 `HIGHLIGHT_RE` 语义对齐——**两解析器一致性是本任务的核心风险**）、Modify `syntax-index.js`（挂载扩展）、`character-map.js`（highlight 的 `==` 作为 gap 字节，内容逐字符——同 strong/emphasis 的 marker-gap 手法）、`mark-map.js`（`highlightAt` 的 flank ADR 可改为真节点推导，保留 flank 作回退或删除——以测试为准）、`editor-kernel-mode.js`（解除 `requireMap` 对 highlight 的拒绝）；Tests 三件套 + `test-source-kernel-markmap.mjs` + `test-kernel-mode-headless.mjs`（M4 高亮拒绝钉住 → 翻转为提交成功）+ `test-kernel-marks-ui.mjs`（高亮按钮场景由"拒绝钉住"翻为"生效"）。

**一致性验收（硬性）：** 构造对照测试——同一批字符串分别经 editor 链（`highlightFeatures` 的 remark）与内核链解析，断言高亮跨度**逐字节一致**；不一致的形状（如 `a == b`、`{==x==}`、转义）必须两侧都不识别或内核侧 fail-closed。红/蓝 `<mark class>` 形态**不在本任务**（保持整图拒绝或按 Task 2 的 html 合并落为 atom——二选一，报告论证）。
- [ ] TDD → 实现 → 全套绿 + 翻转的钉住测试 → commit `feat(source-kernel): highlight micromark extension unblocks the mark`

### Task 4: 表格域（单元格编辑）

**Files:** Create `src/renderer/src/lib/source-kernel/table-map.js`（PM 4 层 ↔ mdast 3 层的配对与单元格 charMap；分隔行按 `table-source-parse.js:260-272` 的手法从 header.end 后首行推出）、Modify `editor-kernel-projection-map.js`（`OPAQUE_TYPES` 移除 table，改为下钻配对：PM `table_cell > paragraph` 的 paragraph 与 mdast `tableCell` 配对，cell 的 charMap 覆盖 `contentRange`，`|` 与两侧空格为 gap 字节）、`editor-kernel-gateway.js`（cell 内 plain text 提交；跨 cell 选区拒绝）；Tests 三件套 + gateway + 新 `test-source-kernel-tablemap.mjs`。

**范围（阶段限定，测试权威）：** 仅**单元格文本编辑**；行列增删、对齐切换、表格创建**不在本任务**（保持拒绝）。含 `<br>` 的 cell、缺列（ragged）行、转义 `\|`、CRLF 表格必须有测试；不可证明 → 该表 charMap null（非整图）。
- [ ] TDD → 实现 → commit `feat(source-kernel): table cell text editing`

### Task 5: 图片属性编辑

**Files:** Create `src/renderer/src/lib/source-kernel/commands/image-attrs.js`（`setImageAttrs({doc, index, offset, src?, alt?, title?}` → 重写 `![alt](src "title")` 的对应片段，字节最小改动）、Modify gateway（image-block 的 AttrStep 分类，同 code-language 先例）、`editor-kernel-mode.js`（路由）；Tests: commands + gateway + mode-headless。
**范围：** image-block（block 形态）的 alt/src/title；inline image 已是 atom（编辑其属性同样走本命令，若 UI 有入口）；caption/ratio 属于 PM 侧展示态，**不写入源码**（除既有 ratio-alt 约定，见 `editor-image-markdown.js:45-62` — 保持既有序列化语义，不得改变）。
- [ ] TDD → 实现 → commit `feat(kernel-mode): image attribute edits via source transactions`

### Task 6: 链接域（URL 流）

**Files:** Modify `editor-kernel-gateway.js`（新分类 `link-edit`：识别 LinkTooltip 的混合 tr——`removeMark(link)` + `addMark(link, {href})`(+可选 `insertText`)——提取 `{from, to, href, insertedText?}`）、Create `commands/link-toggle.js`（wrap：`[text](url)`；unwrap：删 `[`/`](url)`；改 URL：只替换 url 段；空选区插入：`[url](url)` 或按 tooltip 的 insertText 语义——以字节测试为准）、Modify `editor-kernel-mode.js`（路由 + 解除 `:1449` 的 link 拒绝）、`Editor.jsx`（右键 link 项去 `.disabled`）；Tests: commands + gateway + mode-headless + UI（marks-ui 追加链接场景：选中文字 → 工具栏 link → tooltip 输 URL → 确认 → 源码字节；改 URL；移除）。
- [ ] TDD → 实现 → commit `feat(kernel-mode): link editing through the tooltip flow`

### Task 7: UI 回归（阶段 3 端到端）

**Files:** Create `scripts/test-kernel-stage3-ui.mjs`（port 10025）+ package.json 注册并入 `test:kernel-ui`。
场景：fixture 含数学（行内+块）、行内 HTML、高亮、表格、图片、链接。开内核 → **live-attach 断言（这是治降级的总验收：以前这份文档会整篇降级）** → 表格单元格编辑字节 → 图片 alt 改写 → 链接 URL 改写 → 高亮按钮生效 → 数学块按声明（可编辑或拒绝）→ 保存 readFile 字节 → 冷重开。全部 kernel oracle 推导；反空转正控；dialogs 空。
- [ ] 写→2 连稳（真 bug 修 owning module 单独 commit）→ commit `test(kernel-mode): stage 3 domains end-to-end regression`

### Task 8: 收尾（阻止矩阵/文档/门禁）

**Files:** guide/docs/CHANGELOG/ai-handoff 更新（阶段 3 已支持项与剩余阻止项：行列增删、表格创建、红蓝高亮、block HTML 编辑、review markup）；门禁全跑（build/build:mobile/test:core/test:kernel-ui/test:source-kernel/guide:check + legacy 代表 4 项 + `test:ui-regression`）。
- [ ] 全跑 → commit `test(kernel-mode): register stage 3 domains and update docs`

---

## Self-Review 记录

- **优先级重排依据**：探查实测证明数学/行内 HTML/高亮三类形状导致**整图拒绝**（非"该域不可编辑"），与计划四 inlineCode 同类。故 Task 1-3 为治降级、优先于扩编辑（Task 4-6）。
- 阶段 3 完成后 spec 迁移只剩「全量默认启用」与「删除旧 preservation mapper/双快照链」两步。
- 已知风险：Task 1 改内核解析链（全套回归是硬门）；Task 3 引入第二个 `==` 解析器（两解析器一致性是核心风险，对照测试为硬性验收）；Task 4 的 4 层↔3 层配对是本计划最大结构改动；Task 6 的混合 tr 分类需与既有 `extractMarkToggle` 的"拒绝混合"规则明确分流。
- 不在本计划：行列增删/表格创建、红蓝高亮 `<mark class>`、block HTML 编辑、CriticMarkup review markup、全量默认启用。
