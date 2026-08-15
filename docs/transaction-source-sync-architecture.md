# 事务优先源码同步架构（方案一）

> 状态：2026-08-11 第二阶段基础设施与默认/primary 回归仍在，但 0.13.47 安装包人工
> 验收出现 RS-41：真实长会话在代码块及后续编辑后仍发生富文本/源码分叉。发布构建
> 默认关闭 transaction-primary；现有 canonical preservation 也没有通过产品验收。
> 方案一仍是主线，但下一步必须先抓到第一次状态分叉的统一 trace，不能继续按最终症状
> 增加 mapper。见 `rich-source-divergence-incident-0.13.47.md`。

## 1. 目标与不变量

HorseMD 保留 Milkdown/ProseMirror 的现有富文本能力，但逐步把写回模型从：

```text
ProseMirror 文档 → 整篇 Markdown serializer → canonical/source 猜测对账
```

迁移为：

```text
用户 ProseMirror transaction → 有边界的 raw source patch → 作者源码
```

必须同时满足：

1. 用户原始 Markdown 是保存、源码模式和导出的事实源；
2. 未触及字节绝不重排、转义、换 marker 或补空行；
3. 一个 transaction batch 全部成功才提交，任一步不确定则整批回滚；
4. 不支持的结构继续走现有 fail-closed 保真层，不能半接管；
5. 迁移期间保存失败仍保留原文件，并允许另存 recovery copy；
6. 富文本、源码、磁盘和冷重开必须逐字符一致。

## 2. 已落地模块

### `components/editor-source-transactions.js`

- 通过 `prosePluginsCtx` 注册只观察、不修改 ProseMirror 的插件；
- 在其他插件完成 `appendTransaction` 后取得完整 transaction batch；
- 测试可显式启用 `window.__hmSourceTransactionTrace = []`，记录真实 step、old/new doc；
- 生产环境不初始化数组，不记录用户文档内容。

### `lib/source-transaction-sync.js`

- 当前接收纯文本 `ReplaceStep` 和受限的尾段 paragraph/heading split；
- 同一 batch 使用局部副本计算，最终 doc 不一致或任一步失败时返回原源码；
- 同块文字修改必须同时证明：
  - PM from/to 位于同一个无 mark、无 atom 的 textblock；
  - raw range 与 PM 被删除文字逐字符相等；
  - 整个 textblock 的 raw span 与 PM 文字逐字符相等；
- 反引号、内联语法、开放 slice、跨块删除、列表结构等均拒绝猜测；
- **字节归一化视图**：入口把 BOM 剥离、全部行尾归一化为单个 `\n`，remark/PM 的坐标只在归一化视图上精确；编辑同步应用到原始副本，出口返回作者原始 BOM/CRLF/lone-CR 拼写。这修复了 remark 剥 BOM 导致全部偏移差 1、以及旧回退把新文字插进 `\r\n` 中间产生 `\r文字\n` 的家族根因；
- **前导空格**不由事务层猜测或维护私有字节；它安全交回 canonical source-first 路径，并写为标准 `&nbsp;` 加余下字面空格，避免回退到 serializer 的 `&#x20;` 拼写；
- Enter 新尾段使用临时 block hint 记录“新 PM 块 → raw 空槽”；槽坐标指向**完整段落分隔（两对换行）之后**，即使源里已存在部分换行（separator 较短）也不漂移；
- 顶层空段只有带 hint 时才可接管；**嵌套空 textblock（列表项/引用内）一律拒绝**，其容器 marker 在槽之前，写字符会落到 marker 前面，必须交给列表/引用 preservation；
- 一个 textblock 被整个删空（`textblock-emptied`）也拒绝接管：常见后继是反引号围栏或 Enter 退出列表这类结构事务，混合两套基线会污染空块；
- LF、CRLF、lone-CR 分别处理（各自保持原行尾）；mixed EOL 的结构拆分拒绝接管，普通纯文本编辑（不引入换行）允许。

### `components/editor-source-transactions.js`（dispatch 边界）

- 从 `appendTransaction` 观察改为包装 `dispatchTransaction`：一次 `state.applyTransaction()` 返回**完整 root + 递归 append 链**，整批一次交给 mapper；
- batch 前缀不可能在 append 事务之后先提交，违反整批原子性的结构问题被消除；
- 测试 trace 保留完整事务链。

### 列表输入意图与跨块编辑

- 列表输入规则（`- `、`1. `）的意图捕获 mapper 建立的空槽（`sourceSlotRawStart`）；
- 意图回调延迟期间，其他块的编辑可能已被 mapper 接管；意图重建**只在当前源快照（`insertionSource`）上插入/替换自己的列表块**，绝不用捕获时的旧快照整体覆盖——否则会静默丢掉其他块的编辑；
- 槽字节验证：插入前比较捕获时与当前的槽周边字节，漂移则拒绝；
- 槽后已存在 canonical 列表（旧保真层先写入了 `* item`）时，把槽、该列表块与多余空行整体替换为作者 marker 的紧凑块；
- 列表意图未落定时，`canonical === canonicalMarkdownRef` 的快确认分支与 pending-publish 分支都让路，确保意图先完成 marker/空行修复。
- 完整 slot 重建或 marker 恢复任一成功后，意图立即从单值和队列同时消费。旧实现只在完整重建时消费，导致列表正文下一回调再次使用旧 slot，把正确空行边界覆盖掉。
- EOF slot 只属于 `depth === 1` 的顶层末尾 paragraph placeholder。最终顶层列表内部的嵌套/中间 item 即使后面没有其他顶层块，也不能把文档 EOF 当作自己的 raw slot；缺少精确 block hint 时继续 fail closed。

### `Editor.jsx` 迁移控制器

- `markdownUpdated`、强制 flush、保存和源码切换仍保留原有安全网；
- 新 mapper 目前只在开发环境或显式测试开关下运行，发布构建默认关闭，避免给用户输入增加未验收的逐键映射成本；
- `window.__hmTransactionSourcePrimary = true` 只供专项测试显式打开主路径；
- 完整家族试跑可用 `VITE_HM_TRANSACTION_PRIMARY=1 npm run build` 生成临时实验构建；验收后必须重新普通构建，不能把实验开关误带进发布包；
- 主路径成功时，源码来自 transaction patch，serializer 只临时生成 canonical baseline 指纹，不能反向覆盖源码；
- 主路径失败会 quarantine 当前结构阶段，直到旧保真层成功建立新 checkpoint；后续字符不能在一个尚未同步的空块上继续猜 raw offset。

### 斜杠菜单结构命令的原子边界

- `/code` 的用户意图由“删除临时 query”和“paragraph → code_block”两条命令共同表达，不能作为两个互不相关的 canonical diff 提交；
- `editor-slash-source.js` 在命令前捕获精确 authored 行，命令后只序列化当前 code block，验证完整 fence 后一次替换并推进双基线；
- 该处理器只覆盖已验收的代码类 slash 命令，不代表 transaction-primary 已放行任意代码块编辑；代码内容后续仍走现有保真链；
- 重复 query 无精确 PM 映射、目标不是完整 fence 或行槽无法证明时继续 fail closed。完整事故记录见 `slash-code-source-sync-regression.md`。
- **验收边界更正**：上述处理器只证明 `/code` 创建瞬间的 authored slot。0.13.47
  正式安装包在同一真实文档继续编辑代码、后文和其他结构后仍会再次分叉。接手者必须
  同时跟踪 live doc、authored、canonical、tab mirror、textarea live value 和 disk，
  找出首次失去共同所有权的 transaction；不得将 RS-40 的专项绿色结果扩张为架构完成。

## 3. 为什么没有立即全量打开

第一次尝试默认接管后，完整 `test:paragraph-source-ui` 捕获到一个真实回归：

1. 用户在已有块之前连续创建多个空段落；
2. 结构性 Enter 不属于首批 plain-text 范围；
3. 下一字符到来时，空 PM 块没有可见锚点，旧 offset mapper 把字符映射到前一段或相邻块；
4. 最终多个段落被合并。

该失败证明“单个简单 demo 通过”不能作为生产放行证据。当前实现因此恢复为**发布构建默认关闭、开发可影子、测试显式接管**：保留事务基础设施和可重放证据，但不会让未完成的 mapper 写用户文件或增加发布版逐键开销。

## 4. 当前已证明范围

`npm run test:source-transaction-sync`：

- 普通段落插入；
- 顶层尾段 Enter / 中间 split；
- split 后首字通过 block hint 定位；
- CRLF Enter 不混入 LF；
- BOM+CRLF 文档普通插入与 Enter 拆分后 BOM/CRLF 逐字节保留；
- lone-CR 文档 Enter 保持 `\r` 行尾；mixed EOL 结构拆分原子拒绝、普通编辑允许；
- hint 在“前段补字后空槽输入”双坐标同步不漂移；
- 前导空格哨兵的写入与移除；
- 列表项文字删光只留下作者 `- `，不产生 `*` 或 `<br />`；整个 textblock 删空拒绝接管；
- 跨块、反引号等结构/语法敏感事务原子拒绝。

`npm run test:source-transaction-sync-ui`：

- 后台真实 Electron；
- 每个字通过 `human-input.mjs` 逐字输入；
- 正文、引用、`-` 列表项的增加/删除；
- LF、CRLF、BOM+CRLF 三种磁盘拼写 + undo/redo 立即切源码、保存、冷重开逐字节断言；
- 测试显式打开 transaction primary；
- 断言新路径被使用且 canonical preservation 调用次数为 0；
- 立即切源码、保存、退出、全新 profile 冷重开逐字符一致。

`npm run test:list-intent-cross-block-ui`（primary 专项，非 primary 构建自动 SKIP）：

- 段落 Enter → 快速 `- item` → 列表回调未落定时立即编辑另一个块；
- 延迟列表意图不得覆盖跨块编辑（丢字回归），marker 保持 `-`，空行不重复，保存与冷重开逐字节一致。

`npm run test:family-multicycle-ui`：

- 默认使用脚本内生成的 BOM + mixed-EOL + 重复文本 + 分叉列表 fixture，不依赖个人文件；
- 连续 4 轮编辑/保存和 5 次全新 profile 打开，覆盖已有列表文字修改/删除、续项、退出、手打 sibling list、fence、再次续写和后续正文；第四轮在正文与后续 fence 之间从空段创建有序列表并再次退出，专门验证 middle-slot 原子映射；
- 默认发布路径与显式 transaction-primary 各跑一遍；每轮严格比较源码、磁盘字节和富文本列表/代码块结构；
- 可用 `FILE=/absolute/file.md node scripts/test-family-multicycle-ui.mjs` 对真实文件做同序列验证，原文件只读，操作发生在 `/tmp` 副本。

## 5. 放行顺序

1. 普通已有 textblock：插入、删除、选区替换、undo/redo；
2. Enter、Backspace/Delete 合段、连续空段和新文档 bootstrap；
3. 列表/引用结构：输入规则、续项、退出、缩进、类型转换、任务项；
4. 行内 mark/atom：粗斜体、链接、行内代码、公式、图片；
5. 代码块、表格、Mermaid、LaTeX、HTML、frontmatter、Review；
6. 大文档性能与移动端 IME。

每一类必须同时通过：纯事务测试、真实逐字 UI、立即源码切换、立即保存、磁盘字节、冷重开、家族完整回归。未完成分类继续走旧路径，不能因相邻分类通过而顺带放行。

## 6. 回归命令

```bash
npm run test:source-transaction-sync
npm run test:source-transaction-sync-ui
npm run test:list-intent-cross-block-ui
npm run test:family-multicycle-ui
npm run test:paragraph-source-ui
npm run test:empty-paragraph-source-ui
npm run test:leading-space-entity-ui
npm run test:list-item-literal-marker-source-ui
npm run test:literal-triple-backtick-source-ui
npm run test:code-fence-delete-source-ui
npm run test:mixed-rich-source-transaction-ui
npm run test:diverged-ordinary-save-ui
npm run test:mode-switch-raw-offset-ui
npm run test:mode-switch-caret-settle-ui
npm run test:list-conversion-ui
npm run test:task-list-persistence-ui
npm run test:rich-source-continuous-fidelity-ui
npm run test:rich-source-chaos-ui
npm run test:new-document-list-source-ui
npm run test:nested-number-list-source-ui
npm run test:diverged-list-structure-ui
npm run test:diverged-delete-source-ui
npm run test:diverged-partial-delete-ui
npm run test:full-doc-delete-source-ui
npm run test:empty-blockquote-removal-ui
npm run test:ime-source-fidelity-ui
npm run test:source-fidelity-probes
```

以上矩阵在 `VITE_HM_TRANSACTION_PRIMARY=1 npm run build` 的实验构建上全绿；同一组回归在默认发布构建上也全绿（primary 专项测试自动 SKIP），证明 regions/list preservation 的修复不破坏旧路径。

## 8. 本轮同时修复的旧路径家族 bug

1. **源末尾空行 + 新块粘行**（`preserveChangedLineRegion`）：零宽变化落在 previous 末尾空行/行边界时，可见字符映射把源区域拉进上一行，新列表/引用/标题行被粘到上一行尾（`正文* `）。修复：零宽且位于行边界的变化，源区域就是该空行本身。`已有正文\n\n` + 列表创建现在输出 `已有正文\n\n* \n\n` 而不是 `已有正文* \n\n`。该修复不依赖 primary，默认构建同样生效。
2. **BOM/CRLF 文档普通编辑损坏**：旧回退在 CRLF 上把新文字插进 `\r\n` 中间（`正文\r追加\n`），后续进入“保存已暂停”。primary 归一化视图接管后此类文档不再落到该回退。

## 9. 仍未放行的分类（默认关闭）

- 行内 mark/atom（粗斜体、链接、行内代码、公式、图片）；
- 代码块、表格、Mermaid、LaTeX、HTML、frontmatter、Review；
- 列表/引用结构的输入规则与退出、缩进、类型转换（仍走专门 preservation，仅空槽协调已打通）；
- 大文档逐键性能：当前成功事务仍同步执行两次全文 parse 与一次全文 serializer，未做增量索引；默认开启前必须补 100K–400K 文档的逐键延迟门禁。

## 7. 禁止回退的修法

- 不得让 serializer 结果直接覆盖作者源码；
- 不得把空 PM paragraph 序列化为独立 `<br />`；
- 不得用全文字符串查找解决重复文本或空块定位；
- 不得在 transaction batch 失败后保留前半段 source patch；
- 不得为追求“测试绿”而关闭 fail-closed 或 recovery；
- 不得在缺少全家族回归时默认打开新的接管分类。

## 源码权威内核（2026-08）

`src/renderer/src/lib/source-kernel/` 是 spec（docs/superpowers/specs/2026-08-14-source-authoritative-editor-kernel-design.md）方案 C 的第一阶段纯内核（MarkdownDocument 事务、语法索引、字符映射、结构命令、源码历史、种子化状态机测试，`npm run test:source-kernel`）；UI 集成（投影/Gateway/IME）见后续计划二；现有 `mapPlainTextTransactionsToSource` 通道保持不变。

### kernel-mode（计划二，实验标签页开关）

深入实现见 `docs/superpowers/sdd/2026-08-15-source-kernel-integration/`（计划 + 各任务报告），本节只留接线指针。

- **veto 通道**：`editor-source-transactions.js` 的 `createSourceTransactionDispatch` 在拿到 kernel 分类结果后，若判定为 `blocked`/无法归属，直接返回 `{ veto: true }` 并 `return`——**不调用 `view.updateState()`**，PM 视图完全不变，交互像被吞掉，同时走 `notifyBlocked()` 限速 toast。这是 fail-closed 的唯一实现方式：没有变化就没有需要修复的东西。
- **模块图**：`editor-kernel-mode.js`（控制器，事务分类→提交/veto、结构键 keymap、API 覆盖、`attached`/`degraded` 生命周期）→ `editor-kernel-gateway.js`（`classifyTransactions`：纯文本 `ReplaceStep` 批 vs 单 `AttrStep` 任务勾选 vs 其它一律 `blocked`；`commitPlainText`/`commitTaskToggle` 落回源码）→ `editor-kernel-reconciler.js`（`diffReplaceRange`/`reconcileProjection`：提交后校验实时视图与内核重新 parse 的投影是否一致，不一致则修复或拒绝）→ `editor-kernel-composition.js`（IME `compositionstart`/`compositionend` 期间挂起分类，避免半个候选字被当结构变更）→ `editor-kernel-projection-map.js`（`buildProjectionMap`：markdown raw offset ↔ PM 位置的块级投影，attach 时构建一次，结构提交后重建）。
- **降级委托契约**：`attachAfterCreate()` 建立初始投影图失败是唯一被批准的降级路径——`degraded = true` 后，`inactive()` 恒真，所有 API 覆盖（flush/save/offset 等）委托回 `attachLegacyApi()` 在覆盖前捕获的**原始**实现，`kernel.doc.text` 冻结在初始内容，绝不会顶替 legacy 流程的输出。降级会通过 `notify()` 一次性提示用户（含"部分工具栏功能关闭"字样）。
- **诊断 ring buffer**：`pushKernelDiagnostic(entry)`（`editor-kernel-mode.js`）写入 `globalThis.__hmKernelDiagnostics`，上限 100 条，`{at, ...entry}` 形状，条目只含结构化元数据（分类结果、错误码等），**绝不含文档正文**。Editor.jsx 的 kernel-mode `markdownUpdated` 网关与本模块共用同一 buffer；诊断时直接在 devtools 里读 `globalThis.__hmKernelDiagnostics`。
- **尾部虚拟段落配对**：Crepe 无条件挂载 `@milkdown/plugin-trailing`（默认 `shouldAppend`），只要文档最后一个顶层子节点不是 `paragraph`/`heading`，实时视图就恒定多一个空尾段落；内核对源码的纯 parse 不会产生这个节点（源码里没有对应字节）。`withTrailingParagraph()` 在每次拿真实视图 doc 与 parse 结果做比较前（reconciler 目标、`verifyPlainTextProjection` diff）都给 parse 结果补挂同一个空尾段落，否则任何以列表/表格/代码块收尾的文档，每次纯文本按键都会报"投影不一致"，修复删除尾段落后插件又立刻补回——一个稳定的抖动死循环。

### kernel-mode 代码块域（计划三，2026-08-16）

深入实现见 `.superpowers/sdd/2026-08-16-source-kernel-codeblock-domain/`（计划 + 各任务报告 + 逐提交 review diff），本节只留接线指针。

- **code-map（前缀感知逐行映射）**：`lib/source-kernel/code-map.js` 的 `buildCodeMap(text, codeNode)`——围栏代码块内容的逐行、逐字符映射，语义与 `character-map.js` 的 char/linebreak 单位约定一致（每个单位固定宽度 1、恰好消费一个 `value` 字符，`\r\n` 拆成 `\r`（char）+`\n`（linebreak）两个单位，而不是把整个 `\r\n` 折成一个宽度 1 的单位——后者会低估 `visibleLength`，把整份文档的投影图错误地判定为不一致）。感知引用/列表缩进产生的逐行前缀（如 `> `），前缀或行尾不能精确复原时整块 `null`（fail-closed，不猜测 CommonMark 的宽松缩进规则）。锁定在 `npm run test:source-kernel` 链（`test-source-kernel-codemap.mjs`，紧跟在 charmap 之后）。
- **动态按块 CM 门（事件时刻 `isCmBlockEditable`，无 `changeFilter`）**：`editor-kernel-mode.js` 的 `isCmBlockEditable(cmView)` 在**每次输入事件发生时**才用 `pmView.posAtDOM(cmView.dom, 0)` 反查当前 `kernel.map.blockPairs`，判定该块的 `charMap` 是否非空——不是挂在 CM `EditorState` 上的静态 `readOnly`/`Compartment` 标志，也不是 `transactionFilter`。原因：语言切换（`js`→`mermaid`）在 commit 时**同步**把投影图的 `charMap` 翻成 `null`，但 CM 自己的 `languageConf.reconfigure` 是**异步**的（等语言模块加载完）——任何状态持有型只读标志在这个窗口里都是过期的，会放行一次 CM 端已接受、随后被 gateway 以 `UNMAPPED` 否决的按键，留下 CM DOM 与内核数据的持久分歧。`changeFilter` 同样不可用：它的 facet 没有 `combine` 覆盖，CM6 会把所有已注册的 filter 各自 AND 起来，无法豁免 CodeMirrorBlock 节点视图自己的 PM→CM 重同步 dispatch（计划二 Task 1 round 2 已经因为这个原因把 `changeFilter` 整体移除）。门本身通过 CM6 的每一条独立输入通道实现（`inputHandler`＋`Prec.highest` 的 `keydown` allowlist／`paste`／`drop`／`cut`／`beforeinput`），覆盖矩阵见 `editor-kernel-cm-bridge.js` 头部注释与 P3-5 任务报告的表格。
- **`exitCodeBlock`**：`lib/source-kernel/commands/code-exit.js`，`Mod-Enter` 以 `Prec.highest` 绑定在 CM 桥的 keymap 上，只要求闭合围栏可证明（末行复现开围栏的容器前缀 + 同字符栏栅 ≥ 开栏长度），**不需要块内容可编辑**——因此在 mermaid/LaTeX/CRLF 等只读块上也能正常退出。文档末尾直接插入两个 `ending`；文档中部插入两个 `ending` 并把光标落在新空行（引用块额外补 `prefix+E+bareQuote+E`）；纯缩进（列表内嵌）围栏拒绝退出，因为插入空行会中断列表续行上下文。
- **CM 撤销桥**：`editor-kernel-cm-bridge.js` 的 `Mod-z`/`Mod-y`/`Shift-Mod-z` 在 CM 获得焦点时同样路由到内核的 `runHistory`，绝不让 CM 自带撤销栈或 `prosemirror-history` 生效——一次 `Mod-Enter` 退出连同后续输入是**一个**内核历史分组（占位段落的辅助 transaction 标 `addToHistory:false`，不会被单独撤销出来）。
- **CRLF 代码块 ADR（fail-closed 收窄）**：vendored `@milkdown/components` 的 `CodeMirrorBlock` 节点视图自己的 CM→PM 位置换算（`forwardUpdate`）没有为 CRLF 做任何修正——CM6 的 `Text.of` 用 `/\r\n?|\n/` 切分文档，`\r` 字节从未进入 CM 内部模型，导致 CM 的内部位置从节点挂载起就比真实 PM 内容偏移少 N（N = 之前经过的 CRLF 换行数），且这个偏移在到达 gateway 分类之前无法被外部检测。修补 vendored 依赖自身的位置数学不在这次计划范围内；`editor-kernel-projection-map.js` 的 `code_block` 分支因此把 `lineEnding !== '\n'` 的围栏（CRLF 或单独 `\r`）排除出 `charMap` 资格——配对关系保留（周围文本仍可正常映射），但整块永久不可编辑，与 mermaid/LaTeX 采用同一 fail-closed 姿态。完整调查记录见 `.superpowers/sdd/2026-08-16-source-kernel-codeblock-domain/task-4-report.md`「Fix-review round」；**该 CM↔PM 位置换算缺陷本身独立于 kernel-mode，也会静默损坏 legacy 富文本编辑器里 CRLF 围栏代码块的普通编辑**——见 `docs/ai-handoff.md` 5.2e。
