# 源码权威内核 · 计划三：抛光 + 代码块语法域 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复两个已合并分支上的活缺陷（内核模式 CM 只读失效、CM 内 Mod-z 绕过内核历史），完成 splitTextBlock 字节语义抛光（段首 Enter/连续 Enter），并交付 spec 迁移阶段 2 的代码块语法域：内核模式下可编辑普通代码块（含引用/缩进 fence）、切换语言、退出代码块，全部走源码事务。

**Architecture:** 代码块的 raw↔value 映射走**逐行前缀感知**的专用 line-map（引用/缩进 fence 的 raw 与 value 非连续子串——探查实测已确认），复用计划二 charmap 的 unit 模型（每行内容字符 1:1 verbatim，行断单元消费 ending+前缀）。CM→PM 的 forwardUpdate 产出 code_block 内 ReplaceStep（探查确认 @milkdown/components code-block/index.js:595-617），gateway 放宽为"code_block 内允许含 `\n` 的纯文本 slice"后走既有 plain-text 提交路径。CM 焦点域 PM keymap 不生效（nodeview stopEvent 恒 true），故内核 undo/语言等 CM 侧行为经 `Prec.highest` 的 CM extension 注入（`tabAtCursorKeymap` 先例通道）。Mermaid/LaTeX（阶段 3 语法域）保持只读，靠本计划修好的真只读机制。

**Tech Stack:** 计划一/二模块 + `@codemirror/state` `Prec`/`EditorState.readOnly`/`changeFilter` + 既有 CDP 测试基建。

## Global Constraints

- 所有计划一/二的全局约束继续有效（fail-closed、字节保真、禁哨兵、错误码集合、非内核路径零改变、UTF-16 偏移、测试断言权威、每任务只 add 自己的文件）。
- 探查事实为准（file:line 已核）：nodeview `readOnlyConf` 在扩展数组第 1 位、`config.extensions` 第 6 位，`EditorState.readOnly` combine 取最高优先级值 ⇒ 压制必须 `Prec.highest`；`EditorState.readOnly` 不拦程序化 dispatch，只拦 DOM 输入/paste/drop/cut/IME + @codemirror/commands 的 13 处早退；`changeFilter` 是唯一程序化闸门。
- codeMirrorKeymap（nodeview :630-670）把 Mod-z/Shift-Mod-z/Mod-y 绑到 prosemirror-history 的 undo/redo，排在 basicSetup 之前 ⇒ 内核接管须再往前一层（Prec.highest）。
- mdast `code` 节点：position 含开闭栅行；`.value` 不含前缀/缩进；引用内 fence 的 `start.offset` 指向反引号非行首。逐行映射的前缀 = fence 开栅行从行首到第一个反引号/波浪号的字节串（引用前缀+缩进），内容行必须逐行以同一前缀开头（CommonMark 允许内容行少缩进——遇到即 fail-closed 整块拒绝）。
- 语言切换是 `setNodeAttribute(pos,'language',v)`（AttrStep）；语言 picker 只受 `view.editable` 闸（内核模式下可打开）。
- `previewOnlyByDefault: true`（editor-crepe-setup.js:225）掩盖了只读失效——测试必须先点 Edit 切出预览再验证。
- 提交信息 `fix(kernel-mode)|feat(kernel-mode)|test(kernel-mode)|fix(source-kernel): …`。

---

### Task 1: 修真只读 + CM 内核 undo 桥（两个活缺陷）

**Files:**
- Modify: `src/renderer/src/components/editor-crepe-setup.js`（CM featureConfig extensions）
- Modify: `src/renderer/src/components/editor-codeblock-tab.js`（`view.readOnly` 恒 falsy 的守卫既有 bug：改 `view.state.readOnly`）
- Modify: `src/renderer/src/components/editor-kernel-mode.js`（导出可供 CM 桥调用的 `historyHandler` 入口）
- Create: `src/renderer/src/components/editor-kernel-cm-bridge.js`
- Test: extend `scripts/test-kernel-nodeview-ui.mjs`（Edit 模式下真只读断言）；new headless assertions where cheap

**Interfaces:**
- `createKernelCmExtensions({ runUndo, runRedo, blocked }) -> Extension[]`：返回 `[Prec.highest(cmKeymap.of([{key:'Mod-z',run:()=>runUndo()},{key:'Mod-y',...},{key:'Shift-Mod-z',...}])), Prec.highest(CmEditorState.readOnly.of(true)), CmEditorState.changeFilter.of(() => !blocked())]`——本任务 `blocked()` 恒 true（代码块仍全只读；Task 5 放开为按语言判定）。`cmKeymap` 从 `@codemirror/view` import（`keymap`）。
- `runUndo/runRedo` 由 editor-crepe-setup 从 `kernelPlugins` 取（editor-kernel-mode 新导出 `runHistory(direction) -> boolean`，内部即 historyHandler 的执行体；CM 焦点下调用后需 `view.focus()` 回 PM？不——undo 重投影后 CM nodeview 会经 PM→CM update 同步，焦点留在 CM 即可，验证为准）。

- [ ] **Step 1: 失败测试**：给 `scripts/test-kernel-nodeview-ui.mjs` 增加段落：点代码块的 Edit 切出预览（工具栏 Hide/Edit 按钮——运行时探明选择器）→ 点入 CM 打字 → 断言 `.cm-content` 文本不变（当前会失败——只读失效）→ 在 CM 内按 Mod-z → 断言文档字节不变（当前 prosemirror-history 可能撤掉更早的内核提交——失败或脏字节）。先跑到红。
- [ ] **Step 2: 实现**：`Prec.highest(CmEditorState.readOnly.of(true))` 替换现有写法 + changeFilter + undo 桥按上述接口；editor-codeblock-tab.js 守卫改 `view.state.readOnly`（一行，附注释：EditorView 无 readOnly getter）。
- [ ] **Step 3: 绿 + 门禁**：`npm run build` && `npm run test:kernel-nodeview-ui`（2 连稳）&& `npm run test:kernel-mode-ui` && headless 套件。非内核路径验证：`npm run test:issue-98-ui`（若存在）或任一代码块相关旧测试。
- [ ] **Step 4: Commit** `fix(kernel-mode): enforce real CodeMirror read-only and bridge undo to kernel history`

---

### Task 2: splitTextBlock 抛光（段首 Enter · 连续 Enter）

**Files:**
- Modify: `src/renderer/src/lib/source-kernel/commands/enter.js`
- Modify: `scripts/test-source-kernel-commands.mjs`（追加）
- Modify: `scripts/test-source-kernel-statemachine.mjs`（把新语义纳入不变式豁免/期望）
- Modify: `src/renderer/src/components/editor-kernel-mode.js`（若 caret/占位符逻辑需配合——尽量不动）

**语义（Typora 对齐，字节契约）：**
- 段首 Enter（offset === 块可见内容起点）：在块**前**插入 `ending`（引用内为 `ending + bareQuote + ...` 与现分裂同构），caret 保持在原块内容起点（新空段在上方）。不再产生"前导空行累积"——重复按产生多个上方空行是**合法**（每按一次一个空段），但 caret 始终留在原文本上。字节示例：`'甲乙\n'` offset 0 Enter → `'\n甲乙\n'`，caret 在 `甲` 前（raw 1）。
- 块尾连续 Enter：第一个 Enter 现有虚拟段落语义不变；虚拟段落内再 Enter（当前被拒）→ 追加一个空行（`'甲\n\n'` 状态下 Enter → `'甲\n\n\n'`，投影两个空段，caret 在第二个）。依赖计划二的 trailing 虚拟对与 withTrailingParagraph 镜像——若两个空段的 PM/mdast 对齐让映射失败，允许把该场景实现为"虚拟段落内 Enter = 先物化当前空段（写入 `\n`）再进入新的虚拟段落"，以测试字节为准。
- [ ] **Step 1: 失败测试**（字节断言先行，含引用内、CRLF 变体）→ **Step 2: 实现** → **Step 3**: 全部内核纯函数套件 + statemachine（若行为变化触发既有断言，更新断言并在注释记录语义变更依据）+ `npm run test:kernel-mode-ui` → **Step 4: Commit** `fix(source-kernel): paragraph-start and repeated enter byte semantics`

---

### Task 3: 代码块 line-map（引用/缩进 fence 感知）

**Files:**
- Create: `src/renderer/src/lib/source-kernel/code-map.js`
- Create: `scripts/test-source-kernel-codemap.mjs`
- Modify: `src/renderer/src/components/editor-kernel-projection-map.js`（code_block 从 NON_EDITABLE 变为用 code-map 建 charMap；mermaid/latex/math 语言仍 non-editable——由 pairing 时读 PM 节点 `attrs.language` 判定，大小写不敏感集合 `{'mermaid','latex'}` + mdast `math` 类型）
- Modify: `package.json`（`test:source-kernel` 链尾加 codemap 测试）

**Interfaces:**
- `buildCodeMap(text, codeNode) -> charMap 兼容对象 | null`：units 覆盖 `.value` 每个字符（verbatim, kind 'char'）+ 行断单元（kind 'linebreak'，raw 覆盖 `ending + 内容行前缀`）；`visibleToRaw`/`rawRangeForVisibleRange` 同 charmap 契约；边界=前单元末。前缀推导：开栅行 `line.text` 中 fence 起始列前的字节串；每个内容行必须以该前缀开头（CommonMark 容许的少缩进行 → 返回 null fail-closed）；闭栅行存在性不要求（未闭合 fence 实测 position 到 raw 末尾——value 映射到最后内容行即可）；空 value → visibleLength 0 映射到开栅行 `\n` 之后。
- projection-map：code_block pair 的 `charMap = buildCodeMap(...)`（语言在只读集合则强制 null）；`content.size === charMap.visibleLength` 交叉核（PM code_block 的 textContent === mdast value——验证 Milkdown 是否含尾换行差异，以实测为准并测试钉住）。
- [ ] **Step 1: 失败测试**：顶层/引用内/列表缩进/未闭合/空块/tilde+meta/CRLF 各一例，逐字节断言 visibleToRaw 与 rawRange；少缩进内容行 → null。→ **Step 2: 实现** → **Step 3**: codemap + projection-map + 全 headless 套件绿 → **Step 4: Commit** `feat(source-kernel): prefix-aware code block line map`

---

### Task 4: gateway 放宽 + 语言切换命令

**Files:**
- Modify: `src/renderer/src/components/editor-kernel-gateway.js`（`plainSliceText` 的 `\n` 拒绝仅对非 code_block 生效：`extractPlainTextSteps` 已知 `$from.parent`——code_block 内允许 `\r?\n`；新增 `extractLanguageStep` + `commitCodeLanguage`）
- Create: `src/renderer/src/lib/source-kernel/commands/code-language.js`（纯命令：`changeCodeLanguage({doc, index, offset, language}) -> result`——替换开栅行 info string token：fence 标记后到行尾（或 meta 前？GFM info=第一个空白前 token+其余为 meta——替换整个 info 段为新 language，保留无 meta 的简单契约；tilde fence 同理；测试字节权威）
- Modify: `src/renderer/src/components/editor-kernel-mode.js`（language AttrStep 路由到 commitCodeLanguage；mermaid/latex 目标语言→拒绝提示）
- Tests: gateway/commands 套件追加

- [ ] **Step 1: 失败测试**（CM 单行/多行编辑分类为 plain-text 且字节正确落在引用内 fence；language AttrStep → `'```js'`→`'```python'` 字节；空语言/加语言；朝 mermaid 切 → 拒绝）→ **Step 2: 实现** → **Step 3**: 全 headless + `npm run test:source-kernel` → **Step 4: Commit** `feat(kernel-mode): code block text commits and language change`

---

### Task 5: CM 编辑端到端接线（changeFilter 按语言放行 + 退出命令）

**Files:**
- Modify: `src/renderer/src/components/editor-kernel-cm-bridge.js`（`blocked()` 变为按 nodeview 语言判定：普通语言放行 DOM 输入（changeFilter true+readOnly 撤除——readOnly 改为按语言的 Compartment？CM extension 静态注入无法读 per-node 语言——**方案**：extensions 是每个 nodeview 实例化时展开的数组？探查：config.extensions 对所有实例相同。改via `EditorState.readOnly.of(...)` 换成 `readOnly.computed`? 简单可靠方案：readOnly 撤除、changeFilter 读闭包 `isBlockedNode()`——bridge 工厂接收 `getNodeLanguage(cmView)`？changeFilter 回调无 nodeview 上下文……**最终定案**：给 bridge 传一个 WeakMap 注册表：nodeview 创建时（无法挂钩）——不可行则回退方案 B：保留全局 readOnly=false + changeFilter 恒放行，mermaid/latex 的只读改由 previewOnlyByDefault + 阻止其 Edit 切换（Vue 层 getReadOnly 已有 `!view.editable` 语义不可用——改 codeBlockConfig 的 renderPreview 包装层拦截？）。执行者按实际可行性选择并在报告论证；测试断言权威：普通块可编辑落盘、mermaid 块 Edit 后打字不落盘。）
- Modify: `src/renderer/src/components/editor-kernel-mode.js`（Mod-Enter 退出：CM 桥加 `Prec.highest` Mod-Enter → 内核结构命令 `exit-code-block`（在闭栅行后插 `ending + ending`，caret 到新空段；未闭合 fence → 先补闭栅？拒绝并提示，测试权威））
- Create: `src/renderer/src/lib/source-kernel/commands/code-exit.js`
- Tests: headless + gateway 追加

- [ ] **Step 1: 失败测试** → **Step 2: 实现** → **Step 3**: 全 headless + build → **Step 4: Commit** `feat(kernel-mode): live code block editing with language-scoped blocking`

---

### Task 6: UI 回归（代码块域端到端）

**Files:**
- Create: `scripts/test-kernel-codeblock-ui.mjs`（port 10023）
- Modify: `package.json`（注册 + 并入 `test:kernel-ui`）

场景：文档含顶层 js fence、引用内 fence、mermaid 块。开内核 → Edit 切出预览 → CM 内打字/换行/删除 → 切源码断言字节（含引用前缀逐行保真）→ 语言 picker js→python 断言开栅行 → CM 内 Mod-z 断言撤内核事务 → mermaid 块尝试编辑不落盘 → 保存 readFile 字节 → 冷重开。dialogs 恒空。内核 oracle 推导期望。
- [ ] **Step 1: 写测试跑到绿（暴露 bug 修在 owning module，单独 commit）** → **Step 2**: 2 连稳 + `test:kernel-ui` 全绿 + `test:kernel-mode-ui`/`ime` 无退化 → **Step 3: Commit** `test(kernel-mode): code block domain end-to-end regression`

---

### Task 7: 收尾（阻止矩阵更新 + 文档 + 门禁）

**Files:**
- Modify: `src/renderer/src/components/editor-crepe-setup.js` 等（slash 的 `code`/`code:<lang>` 项在内核模式解封？——**否**，创建仍属结构插入，保持 blocked；仅更新 guide/docs 的"已支持/仍阻止"清单：代码块**编辑/语言/退出**已支持、创建仍阻止、mermaid/latex 编辑仍阻止）
- Modify: `guide/basics/rich-and-source.md`、`docs/transaction-source-sync-architecture.md`、`docs/ai-handoff.md`、`CHANGELOG.md`
- 门禁：`npm run build` && `npm run build:mobile` && `npm run test:core` && `npm run test:kernel-ui` && `npm run test:source-kernel` && `npm run guide:check` && 旧专项代表（quoted-block/list-conversion/trailing-space/ime-source-fidelity）
- [ ] **Step 1: 文档 + 注册** → **Step 2: 门禁全跑** → **Step 3: Commit** `test(kernel-mode): register code block domain and update docs`

---

## Self-Review 记录

- 覆盖 spec 迁移阶段 2 的代码块半边 + 最终审查抛光清单第 1 条；行内 marks 与引用转换命令留计划四（阶段 2 另一半）。
- 已知悬而未决点（执行时以测试为准，报告论证）：Task 5 的按语言只读机制（三个候选方案已列）；PM code_block textContent 与 mdast value 的尾换行一致性；Mod-Enter 在 codeMirrorKeymap 中既有绑定的优先级压制。
- Task 1 修的两个缺陷属计划二遗留（已合并分支上的活 bug），优先级最高、独立可交付。
