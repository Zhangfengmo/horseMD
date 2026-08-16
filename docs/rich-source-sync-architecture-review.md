# 富文本 ↔ 源码同步架构评审报告

> 日期：2026-08-11  
> 版本：HorseMD v0.13.29（`ea4415b6459c`）  
> 范围：定位「列表编辑后源码/富文本不一致、无法保存、无法切源码」；§1–11 保留 v0.13.29 的历史诊断，§12–16 记录修复分支各阶段复核与最终实现结果。

> 复核提示：§13 是 v0.13.48 的中间候选，§14 是 v0.13.49 的 durable table
> 架构结论，§15 是 v0.13.50 二次审查，§16 是 v0.13.51 真实表格录入与全量回归收口。现场表格主因不是代码语言；列表
> Backspace 和 `- 1.` 分歧列表则是独立、可执行的同步回归，不能因表格根因成立而略过。

## 1. 结论

这次反馈由两类问题串联而成，不能合并成一个“Backspace 小 bug”：

1. **列表交互问题（v0.13.29 当时行为）**：当时 Milkdown/ProseMirror 的列表 keymap 中，空列表项按
   Backspace 走 `joinBackward`，不是“退出列表”。它会先产生列表项内的第二个空段落，
   视觉上就是用户看到的“没有变正文，反而缩进了”。v0.13.29 当时要退出列表，应在空列表项
   再按一次 Enter。
2. **同步架构问题**：HorseMD 同时维护作者源码、上一次 canonical Markdown、当前
   ProseMirror 文档和 `tab.content`。富文本事务依靠启发式 diff 映射回作者源码；列表
   lift/join 的中间态既会被错误地判定为“映射成功”，也可能在后续事务中变成
   `visible-stream-mismatch`。一旦 fail-closed，保存和切源码都会调用同一个
   `flushMarkdown()`，所以两者一起失效。

保存暂停本身是必要的数据保护：它避免把旧源码当成当前富文本写回磁盘。但系统缺少
显式冲突状态、恢复快照和可退出路径，所以保护机制最终表现成了“交互死锁”。

准确的版本判断是：

- 本报告复现的 `- 1.` 分歧列表映射路径由 `74b0e07` 引入；该提交包含在 v0.13.29，
  不包含在 v0.12.62。因此具体触发路径属于 0.13.29 回归。
- “多份真值 + canonical diff + fail-closed 后无恢复出口”是既有架构问题；即使修掉
  当前列表形状，其他结构编辑仍可能进入同类状态。
- v0.13.29 的发布提交 `ea4415b` 不是根因；主要代码变化来自此前的 `74b0e07`，
  `211e64c` 又增加了若干保真分支但没有消除该状态机问题。

## 2. 调查拆解与证据等级

调查分为三个并行子任务和一个主线复现：

| 层级 | 子任务 | 执行配置 | 产出 |
|---|---|---|---|
| L1 | 列表按键与 ProseMirror 树变化 | Terra / high | Enter、Backspace、lift/join 调用链及现有测试缺口 |
| L1 | 保存、模式切换、双快照状态机 | Terra / high | `flushMarkdown() === null` 如何同时阻断两个入口 |
| L2 | 跨模块架构、历史与迁移路线交叉审查 | Sol / xhigh | 回归归属、破坏的不变量、非补丁式路线 |
| 主线 | 后台 Electron/CDP 逐键复现 | 当前会话 | 普通列表对照、分歧列表锁定、磁盘保护验证 |

运行环境没有 Claude Sonnet/Opus 可选项，因此没有伪称使用它们；按任务层级使用了当前
可用的 Terra（窄域追踪）和 Sol（架构审查）作为对应配置。

证据分级：

- **已证实**：代码调用链、当前版本归属、普通列表键盘语义、`- 1.` fixture 的完整锁定、
  source 切换失败、保存 toast、磁盘未写。
- **高置信推断**：用户原文件很可能经过了相同的 nested/list-continuation 状态；视觉反馈
  与实测树变化一致。
- **未知**：用户未提供出错文件和同步诊断日志，所以不能断言其原始 Markdown 字节一定
  是 `- 1.`。下面的 fixture 是同类机制的稳定复现，不冒充用户原文件。

## 3. 复现实证

### 3.1 普通有序列表对照

对普通源码：

```markdown
1. alpha
2. beta
3. gamma

after paragraph
```

在 `gamma` 末尾执行 Enter → Backspace → Backspace → Enter：

1. Enter 创建第 4 个空列表项。
2. 第一次 Backspace 把空列表项合入第 3 项，树变成同一 `list_item` 下的
   `paragraph("gamma") + paragraph("")`；它仍在列表内部，所以视觉上缩进。
3. 第二次 Backspace 合并/删除这个空段落，并不等价于“在列表后创建正文”。
4. 再按 Enter 当然重新运行 `splitListItem`，又出现序号。

这个最小路径解释了用户的交互困惑，但单独执行一轮没有触发同步锁定。HorseMD 自己的
DOM handler 不接管普通列表 Enter/Backspace；真实命令来自 Milkdown CommonMark 的
`splitListItem` 与 `liftFirstListItem → joinBackward`。

### 3.2 同类锁定的稳定复现

使用会被 remark 解释为“外层 bullet wrapper + 内层 ordered list”的作者源码：

```markdown
# test

- 1. alpha
- 2. beta

paragraph below
```

在 `beta` 开头按 Backspace × 3、Enter、Backspace，每步约 300ms。这个序列对应用户
“删除序号、继续退格、重新换行、再调整”的结构 churn。逐步日志为：

| 步骤 | preserve 结果 | 作者源码快照 |
|---|---|---|
| Backspace 1 | `diverged-nested-list-change`，成功 | `- 1. alpha` / `- beta` |
| Backspace 2 | 同上，成功 | 不变 |
| Backspace 3 | 同上，成功 | `- 1. alpha` 后出现无 marker 缩进续行 `  beta` |
| Enter | 同上，**仍报成功** | 被投影为两个分离列表：`- 1. alpha` 与 `- beta` |
| Backspace | `visible-stream-mismatch`，失败 | 保留上一步源码，canonical 不推进 |

失败后的端到端结果：

- 点击源码模式：textarea 没有挂载，按钮看起来“无反应”；
- 点击保存：显示“保存已暂停：当前富文本编辑暂时无法安全映射到源码……”；
- 磁盘文件保持原样，没有写入旧快照或错误快照。

这里最关键的证据不是最后一次 `preserved:false`，而是前一次 Enter 被判定为
`preserved:true`，却已经改变了源码中的列表块身份。最终拒绝只是较早“假成功”的后果。

另一个普通列表 churn 对照也观察到一次错误成功：中间态被映射成
`gamma<br />after paragraph`，随后再进入 `unmapped-structural-change`。这说明问题并不只限于
`- 1.` fixture；后者只是目前最稳定、最短的锁定复现。

### 3.3 时序依赖

同类操作在 20/100/300ms 的按键间隔下会改变 `markdownUpdated` 的批次边界。调查中观察到：

- 分步回调可在最后一笔进入 `visible-stream-mismatch`；
- 更快批次可能走另一 handler 并暂时返回成功；
- 某些批次会让内部 `<br />` 占位符物化进候选作者源码。

正确的同步结果不应取决于 200ms 左右的监听器分批方式。当前实现处理的是“两个全文
canonical 快照之差”，不是用户的逻辑命令或 ProseMirror transaction，因此这种差异是
架构模型的直接产物。

## 4. 当前数据流和失败状态机

```text
磁盘
  ↓ open
tab.content / tabsRef
  ↓ initialContent
lastMarkdownRef ───────────────┐  最后提交的作者源码
                               │
canonicalMarkdownRef ──────────┼─ preserveRichMarkdownSource(...)
                               │
PM view.state.doc → serializer ┘  当前可见富文本 → next canonical
                    │
        ┌───────────┴───────────┐
        │ preserved:true        │ preserved:false
        │ 推进两份 ref           │ 冻结两份 ref
        │ onChange → tab.content│ PM 继续保留可见编辑
        │ 清 pending             │ pending 保留
        └───────────────────────┴───────────────
                                                ↓
                                      flushMarkdown() = null
                                      ├─ 保存：toast + 不写盘
                                      └─ 切源码：静默 return
```

关键实现位置：

- 双快照：`src/renderer/src/components/Editor.jsx:179-183`
- 用户编辑/pending 与跨 block flush：`Editor.jsx:224-271`
- `markdownUpdated` 对账与失败冻结：`Editor.jsx:650-840`
- 强制序列化与 `null` 合同：`components/editor-api.js:169-216`
- 保存读取 live PM：`App.jsx:520-534`
- 保存拒绝及 toast：`hooks/useFileOps.js:384-397`
- 源码切换静默拒绝：`hooks/useSourceModeSwitch.js:95-120`

保存与源码切换并没有共享一个显式 `syncError` 对象；它们只是共享同一个失败谓词
`flushMarkdown() === null`。`reason` 在 API 边界被压扁，UI 无法区分保真拒绝、序列化异常
或编辑器生命周期未就绪。

## 5. 根因分层

### 5.1 表示层：三份事实不可逆

作者 Markdown 必须保留 marker、空行、缩进、CRLF 和局部写法；ProseMirror 只保存语义树；
serializer 又生成规范化 Markdown。三者并非双射。例如 `- 1. text` 的作者意图在 PM 中会
成为两层列表，原始 token 身份已经丢失。当前系统却要求每次富文本编辑后把 canonical 的
局部差异无损投回作者字节。

### 5.2 映射层：启发式 handler 返回值被当作证明

`preserveRichMarkdownSource()` 按 visible stream、表格、列表、行区间等多个 handler
依次尝试；某个 handler 返回结果就视为 `preserved:true`。系统没有通用后置条件来证明：

```text
parse(preservedMarkdown) 的语义结构 == 当前 PM doc
且未编辑 raw span 的字节保持不变
```

所以“映射器没有认输”不等于“结果正确”。本次链条正是先错误成功、后失败锁定。

### 5.3 列表中间态：零宽结构没有稳定身份

`flatListItemRows()` 对 marker 行会剥离尾部 `<br />`，但 tokenless continuation 分支把
缩进的 `<br />` 当普通正文；`normalizeEmptyListItems()` 又只识别带 marker 的空列表项。
更根本的问题是：`  beta` 无法仅凭字符串判断它是 list lift 的新状态、原有列表续行，
还是作者有意的缩进文本。正则只能猜邻接关系，无法恢复 transaction 的语义身份。

### 5.4 事务层：批次边界代替逻辑版本

系统用 DOM 事件、pending flag、TTL 和约 200ms 的 `markdownUpdated` 批处理推断一次用户编辑。
没有单调 revision，也没有“这个结果基于哪一版 PM/source”的 compare-and-swap 提交规则。
因此相同按键序列被不同方式分批时，可走不同 handler 并产生不同源码。

### 5.5 失败层：fail-closed 正确，但没有恢复协议

冻结源码和磁盘是正确的安全边界，不能为了让按钮重新可用而删除。问题在于系统没有一级
同步状态，也没有保存当前 PM canonical recovery snapshot。用户只能继续编辑或 Undo，期待
累计 delta 恰好重新可映射；源码入口本身又被锁住。

### 5.6 投影层：visible map 不符合 Markdown 语法（多语言矩阵补充，2026-08-11）

对 15 种「普通段落中的代码元字符」做简单文档 + test.md 原结构两组对照后确认：
上游根因不是“列表解析”或某种语言，而是 **visible projection 不符合 Markdown grammar**。
不同语言只是提供了不同触发字符；裸 `*` 在简单文档中通常被 fallback 救回，与重复文本、
复杂块结构叠加时才稳定变成 `visible-stream-mismatch`。

三个缺陷类别：

1. **单个 `*`、单独 `_` 被无条件当成 Markdown 语法**（`mode-visible-map.js:226`，未实现
   CommonMark delimiter-flanking 规则）。`char *ptr`、`a * b`、`*args`、
   `import * as React`、`"$*"`、`SELECT *`、`_ = value` 全部产生假分歧。
2. **`<` 和 `&` 的 canonical 转义链不完整**（白名单 `mode-visible-map.js:114` 不含
   `<`/`&`；任意 `<...>` 又可能被近似 HTML 规则整个删除，`:183`）。
   `std::vector<int*>`、`&T`、`#include <stdio.h>` 在唯一文本块中也可直接
   `visible-stream-mismatch`，不需要重复锚点。
3. **inline code 没有真正进入 raw 模式**：只跳过反引号，内部字符仍按 Markdown 解释。
   `` `* _ ~ [ ]` `` 两侧可能“错得一致”而不阻断保存，但污染 caret/raw-offset 映射。
   fenced code 无此问题（走 `mode-visible-map.js:293` raw 分支）。

结论修正：

- `*ptr → \*ptr` 是 serializer 的合法拼写变化，不代表语义或可见文本变化；
- 用于光标近似定位的 `sourceVisibleIndex()` **不应成为数据提交安全性的裁决器**——
  提交裁决必须以 parse 级语义等价为准（见 §12 验收关卡）；
- 解析器 token span、inline-code span、fenced-code span 应成为统一语义边界（阶段 B.4）；
- 普通正文、粗体、列表和表格单元格中出现代码符号是合法内容，要求用户改用代码块
  只能是临时规避。

## 6. 为什么已有测试全过仍漏掉

`test:markdown-preservation` 和 `test:diverged-list-structure-ui` 当前均能通过，但它们证明的
只是已枚举 fixture：

1. UI 测试覆盖三次 Backspace 后切源码、保存、重开，没有继续执行 Enter → Backspace。
2. 每次操作间等待约 700ms，没有枚举多个 callback partition。
3. 纯函数测试多为独立输入，没有把每一步的输出作为下一步 authored source/baseline，
   因而看不到“先假成功、再累计失败”。
4. 测试 oracle 主要检查最终字节，没有为每次 `preserved:true` 验证 parse 后的语义等价。
5. 普通列表与 `- 1.` 分歧列表是不同解析树，不能用前者的通过证明后者。

需要把测试对象从“单个 preservation 函数样例”升级为“文档 revision 状态机”。

## 7. 非补丁式修正路线

### 阶段 A：让当前架构可证明、可恢复

1. **显式 per-tab 同步状态**：`healthy | pending | conflicted`，携带
   `sourceRevision`、`pmRevision`、`lastSuccessfulRevision`、失败 reason 和操作 ID。
2. **成功结果验收**：对每次 `preserved:true` 做结构 round-trip 检查，并验证未触及字节。
   验收失败应进入可观察冲突，不能推进 baseline。
3. **双恢复资产**：冲突时同时保留“最后可信作者源码”和“当前 live PM 的 canonical recovery
   snapshot”。提供导出两份、丢弃富文本回退源码、以富文本重建源码（明确会规范化）三种出口。
4. **统一失败协议**：保存、切源码、分屏、导出、session flush 都消费同一种结构化结果；
   源码按钮不得再静默无响应，并应允许只读查看最后可信源码。
5. **内部占位符不变量**：在语义/CST 边界统一分类 PM 空段落；禁止 `<br />` 占位符依赖
   多处分散正则“最后再清理”。表格 cell 和用户 HTML `<br>` 仍须保留。

### 阶段 B：用显式事务替代全文快照猜测

1. 收敛 serialize → map → validate → baseline commit → `tab.content` 更新为唯一
   `DocumentRevisionCoordinator`；回调、强制 flush 和特殊命令不得分别推进 refs。
2. 用单调 revision/CAS 替代墙钟 TTL。异步映射只能提交到它开始时对应的 source/PM revision。
3. 扩展仓库已有的 PM step → source patch 原型：显式处理 `splitListItem`、`liftListItem`、
   `joinBackward`、`ReplaceAroundStep`、多 step transaction 和 undo/redo。
4. 建立 lossless Markdown CST/span/trivia 层。marker、空行、缩进、CRLF、转义是模型字段，
   不能只存在于上一份 raw string。

### 阶段 C：源码单一事实源

执行 `docs/live-preview-migration-plan.md` 已规划的 CodeMirror 6 Live Preview：

- Markdown 文本成为唯一可写数据模型；
- rich/source 是同一 buffer 的 decoration/view mode；
- 保存、光标、viewport、导出读取同一 revision；
- 迁移期 PM/Crepe 可作为投影和兼容层，最终退役双向 heuristic preservation。

这是唯一能从架构上消除“作者源码 ↔ PM canonical 双向无损对账”问题族的路线，但需要渐进
迁移，不能作为 0.13.29 的紧急补丁。

### 列表 UX 应单独决策

产品需要明确“空列表项 Backspace”的合同：

- 保留 ProseMirror 默认行为，则教程和交互提示应说明 Enter × 2 退出列表；
- 若目标是 Typora/飞书式体验，应把空列表项 Backspace 定义为显式 lift/退出命令。

改变 keymap 可降低触发率、改善用户体验，但不能替代同步架构修正。

## 8. 建议的回归模型

新增状态机测试，而不是再加一个孤立 fixture：

1. 语法形态：普通 `1.`、`1)`、`- 1.`、松散列表、嵌套列表、列表后正文。
2. 操作序列：split、Backspace join、lift、Enter、undo/redo、源码切换、立即保存、重开。
3. 批次划分：每步 settle、相邻两步合并、整段合并；结果必须一致。
4. 每一步断言：
   - live PM 与 preserved source 重解析后的语义等价；
   - 未触及作者字节保持；
   - 作者源码不含内部 placeholder；
   - 保存/切换读取同一 revision；
   - 冲突时 recovery snapshot 可导出且磁盘不写。
5. Electron 测试继续用后台 `launchBuiltElectron()` 和 `human-input.mjs` 逐键输入。

## 9. 当前用户的安全操作建议

- 要在列表后增加正文：当前版本在空列表项再按一次 Enter，不要用 Backspace 退出。
- 如果已经出现保存暂停：先 Undo 回到最近一次可保存状态，再切源码或保存；不要继续大量
  结构编辑扩大累计 delta。
- 如果 Undo 不能恢复，在关闭应用前先把屏幕上仍可见的重要内容复制到外部临时文件。
  当前 toast 只保证磁盘没有被旧源码覆盖，不保证未提交的 PM 编辑在关闭后可恢复。

## 10. 验证与工作区说明

- 后台 Electron 普通列表逐键对照已执行。
- 后台 Electron 分歧列表锁定已执行：最后 reason 为 `visible-stream-mismatch`，源码 textarea
  未出现，保存 toast 出现，磁盘内容未变化。
- `npm run test:markdown-preservation`、`npm run test:diverged-list-structure-ui` 和
  `npm run build` 用来验证当前基线及说明测试缺口；它们的通过不代表本 bug 已修复。
- 未修改任何产品源码，也未提交、安装或发布构建。仓库中原有的
  `electron.vite.config.mjs` 修改和 `.idea/` 未跟踪目录不属于本调查。

## 11. 关键代码索引

- `src/renderer/src/components/editor-dom-interactions.js:62-87`
- `src/renderer/src/components/Editor.jsx:179-183, 224-271, 650-840`
- `src/renderer/src/components/editor-api.js:169-216`
- `src/renderer/src/hooks/useSourceModeSwitch.js:95-120`
- `src/renderer/src/hooks/useFileOps.js:384-397`
- `src/renderer/src/App.jsx:520-534`
- `src/renderer/src/markdown-source-preservation.js:310-384, 417-474`
- `src/renderer/src/lib/markdown-preservation/lists.js:120-150, 345-359, 1362-1635`
- `src/renderer/src/lib/markdown-preservation/paragraphs.js:316-326`
- `docs/nested-list-sync-bug-handoff.md`
- `docs/rich-source-fidelity-bug-family.md`

## 12. 修复分支落地情况（fix/rich-source-sync-architecture，2026-08-11）

阶段 A 的以下项已在该分支实现（架构收敛，非补丁）：

- **A.2 成功结果验收**：每次 `preserved:true` 必须通过「结果 re-parse ≡ 当前
  canonical」的语义等价关卡（拼写不敏感：`-`/`*`、转义、松紧列表、`<br>` 拼写、
  块级 `<br />` 占位符均等价）。验收失败降级为 fail-closed，不推进 baseline。
  §3.2 的“Enter 假成功”与真实用户文件的 `\*\*}\*\*X` 损坏形态均被该关卡拒绝。
  **注（2026-08-17 更正）**：本条最初落地在
  `lib/markdown-preservation/roundtrip.js` 的 `roundTripPreserved`，但自 247eee0
  （fix(editor): centralize verified source commits）起它在 `src/` 下已无任何生产
  调用方——**运行时闸门**是 `components/editor-source-verification.js` 的
  `verifySourceDocument` → `editor-durable-semantics.js` 的 `areDurablyEquivalent`
  （用编辑器自己的解析器把候选字节重新解析成 **ProseMirror 文档**再比对），由
  `commitCanonicalResult`/`flushMarkdown` 经 `selectVerifiedSource` 调用，
  `npm run test:editor-source-verification` 锁定。`roundtrip.js` 现在的角色是
  **headless 测试预言机**（`npm run test:roundtrip-acceptance`），其
  `markdownComparisonKey` 另被 `core.js` 用作**单行**转义安全检查。
  不要再把 roundtrip.js 当作运行时权威。
- **提交点收敛**（A.4 的前半）：Editor.jsx `commitCanonicalResult` 成为
  markdownUpdated / frontmatter / inline code / 两个列表转换的唯一发布路径，
  `flushMarkdown` 是 API 侧对应物；frontmatter 路径缺失的 fail-closed 检查
  （基线投毒根因之一）随收敛消失，且改用 `serializerCtx` 序列化。
- **A.3 恢复出口（部分）** → `editor-api.rebuildMarkdownFromRich()`：fail-closed 时
  经用户确认（`sync.rebuildConfirm`）以 live 文档重建作者源码，接入源码切换、
  `getMarkdownForTab`（保存/导出）；Pandoc 导出补上 null 检查。切源码不再静默无响应。
- **列表 UX 决策已定**：空列表项 Backspace = lift 退出列表
  （`editor-list-backspace.js`，prepend 到 `prosePluginsCtx`），从行为层消灭
  “项内多段落 + 无 marker 续行”歧义中间态。非空项保持 preset 行为。

两轮代码审查（2026-08-11）后的补充落地：

- **验收关卡的语义等价关系扩展**：表格 `<br />` 单元格 ≡ 空单元格、单行/多行
  `$$…$$` 拼写、参考式链接 vs 内联链接、U+200B 前导空格哨兵 ≡ `&#x20;`；
  行级去转义只在「reparse 语义不变」时还原物理字符（`2\.`、`\~`、反引号等
  不再被盲目去转义——这是 211e64c 埋下的真实保真洞）。
- **关卡抓出并根修的三个既有 lossy 映射**（旧测试期望值随之修正，均经 parser
  实证）：lift 续行缺块边界空行；marker 变宽不平移子行缩进（`1. Parent` 下
  2 空格子项 reparse 成并列列表）；bullet 偏好 `-` 与相邻 `-` 列表 reparse
  合并（改为序列化器同款交替 marker）。另修全文粘贴时 delta 边界劈开行首
  marker token 导致的 `# # 标题` 损坏（canonical 入口 token 外扩 + raw 锚点
  行首吸附,issue-77 回归恢复通过）。
- **恢复出口原子化**：rebuild 同时清空全部 pending intent（paste 快照/列表
  转换/输入规则标记），Pandoc 导出路径同步 `tab.content`/`tabsRef`；关窗前
  草稿 flush 以 rebuild 兜底（草稿可规范化、不可丢失）。
- **性能**：比较键按串记忆化；>120K 字符文档的热路径跳过关卡（保存/切源码/
  导出等持久化边界仍无条件把关）。
- **范围收敛**：空列表项 Backspace 仅在「列表末项」接管（中间项 lift 会产生
  Markdown 无法表达的结构）；「源码+预览」分屏入口走同一 flush 守卫；
  测试脚手架自动应答原生对话框（默认拒绝，见 docs/development.md）。

未落地（后续工作，即阶段 B 的边界）：A.1 显式同步状态对象 / revision
coordinator、§5.6 的 visible-map 语法化重写（fail-closed 的**发生率**根因，
本分支只治「失败后果」）、关卡与应用统一 remark 管线（现用独立 GFM parser +
归一化层近似,`\$x$` vs `$x$` 类 app 特有语义无法区分——已核验现有映射器不会
产生这类翻转）、阶段 B/C 全部。
- `docs/live-preview-migration-plan.md`

> 上述“独立 GFM gate”和“>120K 热路径跳过关卡”记录的是合并前阶段性实现；
> 它们已被下面 §13 的现场复现推翻并替代，不再代表 v0.13.48 候选架构。

## 13. 合并后重新定位与 verified commit 修复（v0.13.48 候选）

### 13.1 现场复现修正了原报告的触发归因

对用户现场文件的只读副本验证表明，文件在编辑前就含有非满列 GFM 表格行：表头为
5 列，部分正文行只有 1 个 cell。进一步做事务级追踪后，原报告中的“应用 parser
在 mount 时补齐”并不准确：初始 Milkdown parse 仍保留短行，第一次表格事务才由
`prosemirror-tables/fixTables` 把 live ProseMirror 表格修成矩形，而 source/canonical
基线早已按短行建立。原文保真 mapper 保留作者短行，serializer 面对修复后的 live
doc 则输出矩形行；独立 gate 因而把一次内容安全的编辑误判为不等价，使源码切换和
保存共同进入 recovery，且同一 revision 上会稳定重现。

同一 fixture 同时包含 Go、JavaScript、TypeScript、Python、Rust、Java、C 和 C++
围栏；修复后 8 种语言全部通过。因此“Go 或某种代码高亮语言触发”
是已排除假设，结构分歧来自表格 parser 行为。

### 13.2 已证实并修复的当前功能问题

| 问题 | 证据 | 修复 |
|---|---|---|
| 表格合法短行在首个事务后才被 `fixTables` 改成矩形，基线与 live doc 生命周期错位 | 非满列表格 fixture 在旧 build 稳定弹 recovery；初始 parse 为短行，首个表格事务后 live PM 才补 cell | 在统一 remark parse 管线中、进入 ProseMirror 前确定性补齐 editor-only 尾部 cell；open、source replace、candidate verify 和 cold reopen 共用同一入口，作者源码字节不被改写 |
| 新建 scratch 无条件去转义可改变语义 | 字面三反引号、`#` 等 candidate 在旧路径跳过 gate，保存重开可能变 code/heading | generated candidate 与安全 canonical fallback 依序验证，冷重开比较 rich 节点类型 |
| `>120000` 热路径推进未验证双 baseline | 可构造 `preserved:true` 但语义不等价的长文档 candidate；forced flush 因 canonical 相等提前返回 | 删除大小豁免；所有提交和 canonical-equality durability 路径均验证 live PM |
| 成功 forced rich read 后 App mirror 可停在旧内容 | `flushMarkdown` 只返回字符串，Pandoc 等调用者不一定同步 `tab.content` | App 使用统一 `commitRichSnapshotToTab` 同步 `tabsRef`/React state，不改 `savedContent` |
| parser 重建的非语义 attrs 造成误拒绝 | 列表 `spread` 的 boolean/string 差异、表格 resize 的 `colwidth` 无 Markdown 表达 | 使用按 node type 声明的 durable semantic contract，仅局部忽略明确的 serializer/layout 元数据；未知 attrs 默认耐久，列表文字、marker、alignment、span 仍严格比较 |
| 空表格 cell 的内部占位与作者 `<br>` 无法靠节点形状区分 | 两者在特定 parser 路径都可能表现为唯一 `isInline:false` hardbreak | parser-backed source model 为 candidate 绑定精确 table/row/column provenance；只在 expected/live 投影中消除已证明的内部占位，candidate 从不继承该豁免，作者 `<br>` 仍严格保留 |
| 合并后的空列表项 sentinel 误拒绝 | 删除 `- ​    正文` 的可见文字后，live PM 保留纯空格 paragraph，作者源码重解析为仅含 U+200B 的 paragraph；完整 family matrix 的 `list-spaces` cell 被锁住 | 等价投影移除应用内部 leading-space sentinel，并且只在 `list_item` 内把纯未标记空白 paragraph 视为空；可见列表文字仍严格比较 |

### 13.3 当前生产架构风险（已收口，但不是本次用户触发的独立实证）

- slash code/math 的 after 路径过去直接写双 baseline；它处于默认生产功能中，属于真实
  旁路，但没有证据证明它就是本次非满列表格事故的首次分叉点。现已路由到同一
  verified commit coordinator。
- rebuild 的 canonical fallback 过去可能未重新验证，现仍必须通过应用 parser 后才可
  重置 baseline；recovery copy 是另一类操作，只写用户另选路径，§15 已将它从 source
  commit 谓词中解耦，避免严格 rebuild 失败后恢复副本必然重复失败。
- 通用独立 GFM gate 可构造 math/highlight/standalone `<br>` 等 false positive。未证明
  现有 mapper 会生成每一种字符串翻转，因此不逐项增加 normalizer；该 gate 已退出
  生产提交权限，只保留为纯 preservation 测试和诊断工具。

### 13.4 预防性问题与后续边界

- transaction-primary 默认关闭，它不是现场表格事故的触发路径；但其发布已收口到
  同一个 revision-bound verified state，避免未来启用时再形成第二套 baseline。
- 持久化 CST/operation log 仍属于更长期的编辑器演进，不是本次修复的必要条件。
  当前 parser-backed table source model 已提供表格局部所有权与 provenance，但没有
  把整篇 Markdown 改造成 CST 编辑器。
- 全量应用 parser 验证可能影响超大文档输入延迟。当前调度可因文档大小调整，但
  durable semantics 和 expected live-doc authority 不再有大小豁免；后续性能优化不得
  允许未验证源码越过 source/save/export 边界。

### 13.5 列表反馈的最终解释

当前分支中，最后一个空列表项按第一次 Backspace 会退出成顶层空段落。若用户此时
尚未输入正文又按第二次 Backspace，该空段落按 ProseMirror 正常 join 语义重新并回
上一列表项；所以下一次 Enter 再出现有序列表序号是预期行为，不是新的同步故障。
正确操作是第一次退出后直接输入正文；若已重新并回，则 Enter 后在新空列表项再按
Backspace 退出。完整序列已经覆盖 source、save 和冷重开。

验证命令包括：

- `npm run test:editor-source-verification`
- `npm run test:rich-source-app-parser-ui`
- `npm run test:list-backspace-exit-ui`
- `npm run test:literal-triple-backtick-source-ui`
- `npm run test:large-source-fidelity-ui`
- `npm run test:tail-fence-ui`
- `npm run test:new-source-fidelity-ui`
- `npm run test:list-conversion-ui`
- `npm run build`
- `npm run build:mobile`

## 14. 最终根因复核与 v0.13.49 架构结论

### 14.1 与原报告一致的判断

- 保存、切源码、导出共同报错不是三个 UI bug，而是同一个 rich→source durability
  边界拒绝 candidate 后的表现。
- live ProseMirror document 必须是用户可见内容 authority；只比较两份 Markdown
  字符串或两次 serializer 结果不能证明没有丢内容。
- 所有写出路径必须共用一个 fail-closed commit boundary，失败时不能推进作者源码
  或 canonical baseline，也不能用整篇 canonical 静默覆盖原文写法。
- 有序列表 Backspace/rejoin 是独立的编辑事务与 mapper 问题，应保留专项回归，但
  不能拿它解释现场表格文件的稳定失败。

### 14.2 原报告中被实证修正的判断

- **补 cell 的时间点**：不是 initial parser mount，而是旧实现第一次表格事务后的
  `fixTables`；修复必须前移到统一 parse contract，不能继续在 roundtrip comparator
  中为短行加例外。
- **独立 GFM gate**：让 gate 改用“更接近应用”的另一套 parser 仍会维护两种语义
  authority。最终实现直接复用 HorseMD 配置后的 `parserCtx`，并在相同 remark 管线
  中做 editor-only normalization。
- **空 cell `<br>`**：它不是所有表格里都可忽略的全局等价规则。只有 source model
  能证明坐标来自 serializer 内部占位时，expected/live 侧才可投影为空；真实作者
  `<br>`、移动或丢失 hardbreak 都是耐久差异。
- **大文档与 scratch**：它们暴露过旁路风险，但不是用户现场文件的触发根因；最终
  架构删除语义验收的大小豁免，并仅让 scratch canonical 作为已验证候选，而不是
  第二 authority。
- **代码语言**：Go、JavaScript、TypeScript、Python、Rust、Java、C、C++ 的 fence
  label 和 fence 内“像表格”的字符均不是根因；代码块仍纳入不变字节回归。

### 14.3 原报告缺失、现已补齐的核心机制

1. **统一 parse adapter**：initial content、source replace、paste/append、candidate
   verify、rebuild 共用配置后的应用 parser；ragged table 在进入 PM 前确定性矩形化。
2. **parser-backed table source model**：按 token/source range 记录 table/row/cell
   所有权、escaped pipe、hardbreak、missing trailing cell、BOM/CRLF 和原始空白；
   普通 cell edit 只改归属 range，结构操作只替换归属 table block。
3. **node-local durable semantics**：每类 PM node 明确区分耐久内容、布局元数据和有
   provenance 的内部占位；未知 attrs 默认参与比较，避免 schema 扩展被静默忽略。
4. **revision-bound atomic state**：`source`、`canonical`、immutable `expectedDoc`、
   `pending` 和 `status` 在同一对象中按 revision 一起推进。旧 callback 不能提交或
   污染新 revision；同一 revision 的确定性失败不会靠重复 save 重试掩盖。
5. **typed failure**：只有 `pending` 可有界等待；`unowned-source-change`、
   `semantic-loss`、`parser-error` 都是最终失败并进入恢复出口。诊断只暴露 revision
   与 failure type，不记录用户正文。

### 14.4 现有功能问题与预防性问题的最终边界

现场已证实并纳入修复的现有问题包括：非满列表格事务后补 cell、连续短行、表格
hardbreak 被 visible stream 吞掉、Milkdown 在 table body/header 的 paragraph serializer
中提前删除 sole/terminal hardbreak、1/2 dash delimiter 识别不一致、escaped pipe
所有权错误、旧 callback/强制 flush 使用不同 expected authority，以及列表完整
Backspace/rejoin 序列。

未被现场证据支持、因此没有当作根因“顺手改行为”的项目包括：特定代码语言导致
失败、代码 fence 内表格样文本参与表格解析、120K 阈值直接触发本例、scratch 文档
直接触发本例，以及默认关闭的 transaction-primary 首次制造本例。它们只保留边界
回归或被动收口，不扩大产品行为。

### 14.5 真实文件最终门禁发现：terminal table hardbreak

在前述五类合成表格与八语言矩阵全部通过后，严格的用户文件临时副本仍返回
`authored-previous-table-mismatch`。脱敏结构比较排除了多表 ordinal、row shape、
alignment、代码语言和 short-row 坐标：唯一差异是同一张表的 3 个 cell，作者源码
均为单独 `<br />`，而 previous canonical 对应 cell 为空。

进一步直接检查 live ProseMirror document 证明这 3 个 cell 并不为空，均保留
`hardbreak { isInline: false }`。真正的数据丢失发生在 Milkdown commonmark 的
`serializeText`：它会在进入 hardbreak schema 和 HorseMD `tableCellBreakHandler`
之前删除 textblock 的最后一个 hardbreak。中间的 `text<br>text` 因 lastChild 是 text
而不受影响，这也解释了旧回归为何漏过现场文件。

最终修复没有在 comparator 或 source model 中放行 `break ≡ empty`，而是只扩展 GFM
`table_cell` 与 `table_header` 的 Markdown serializer。当 cell 只有一个 paragraph，
且其最后节点为 `hardbreak { isInline: false }` 时，serializer 遍历完整 paragraph
content，再由既有 table break handler 输出 `<br>`；空 cell、`isInline:true`、多 block
cell、普通 paragraph 与 heading 全部委托 Milkdown 原实现。现场副本随后通过逐字符
编辑、源码切换、保存和冷重开，且原文件哈希与大小前后完全不变。

仍有一个未由现场触发的预防性残余：strong/emphasis/link 包裹的 terminal `<br />`
目前在 table source model 中属于 opaque inline node，若 serializer 同时把拼写规范为
`<br>`，邻 cell 编辑仍可能安全 fail-closed。它不是本次无 mark 的 3 个现场 cell 根因，
当前修复也没有使其退化；若后续有真实反馈，应把 formatted inline token 纳入 source
grammar，而不是为 comparator 增加例外。

### 14.6 合并前独立审查发现的大文档实证问题

最终只读审查没有再发现现场 `test.md` 路径的语义缺口，但对本次新 source model 找到
两个可执行复现，因此它们属于必须在发布前修复的现有实现问题，而不是产品现场根因：

- 单个合法 table cell 达到约 12.5 万字符时，`units.push(...decoded)` 会越过 JavaScript
  的 variadic argument 上限并抛 `RangeError`，随后被映射层转换成确定性的
  `unowned-source-change`。现在所有 unit 以线性迭代追加，并用 15 万字符 cell 回归覆盖。
- table mapper 把 authored、previous canonical、next canonical 当作三个独立 LRU 项；
  三份约 50 万字符源码刚好超过旧 150 万字符预算时会循环互相驱逐，同一个 revision
  每次检查都重新全量解析。现在 parser 明确拥有一个当前 revision working set，三份
  immutable model 原子替换并跨保存、源码定位和耐久上下文复用；通用 LRU 仍保持原有
  条目/字符上限，下一 revision 只保留其自身三元组。instrumented 回归证明重复检查的
  parser 调用由 6 次降为 3 次，且没有放宽任何语义验收规则。

这两项说明“超大文档性能”不能一概归为预设问题：它们不是用户 2 KB 现场文件的触发
原因，但已能由当前支持的合法 Markdown 确定触发。相对地，formatted terminal break
仍只有理论残余、没有现场或现有回归证据，继续列为预防性边界。

## 15. v0.13.50 二次审查与列表/恢复出口修正

### 15.1 外部审查结论逐项复核

| 审查项 | 当前判定 | 证据与处理 |
|---|---|---|
| “结构实现只在另一分支，fix 分支只有正则补丁” | 已过时 | `fix/rich-source-sync-architecture` 与 `codex/rich-source-durable` 已共同指向 `ca11a73`；parse adapter、table source model/parse/patch、durable semantics 与 revision state 均在当前调用链中。 |
| rebuild 与 recovery 使用同一候选和同一验收谓词 | 来审时 P0，现已修复 | 逻辑复核成立：同一 live revision 上 rebuild 失败后，recovery 必然再次失败。严格 rebuild 保持不变；恢复副本改为无条件导出 best-effort canonical，只能写用户另选路径，不推进 baseline、不清 dirty、不覆盖原文件。 |
| 参差表格缺矩形化、普通编辑无 fallback | 已由 §14 结构实现覆盖 | 当前 parser 在进入 PM 前做 editor-only 矩形化，普通 cell edit 由 parser-backed source ownership 产出候选；六类表格 UI、terminal hardbreak、issue-86 与应用 parser 回归均通过。没有向 `semanticJson` 增加表格例外。 |
| `- 1.` 家族被 verified acceptance 误拒 | 当前回归，已修 | 一次 Backspace 后 live PM 含 `list_item[内部空段落, 正文]`，candidate 重解析为 `list_item[正文]`。durable node contract 现在只删除无 attrs 的内部空段落；带未知 attrs 的空段落仍严格比较。 |
| `- 1.` Enter 后保存为新的 `- 2.` 行 | 旧 mapper 产出错误，gate 拒绝正确 | `- 2.` 会在冷重开时变成另一个外层 bullet item。mapper 现在输出缩进的 `  2.`，保留原外层列表；测试新增完整冷重开，不再只断言磁盘字符串。 |
| 测试被重塑后削弱外部行为 | 部分成立 | 旧的字面 marker 与尾随空格断言只检查源码外观，却允许冷重开改变结构。现以应用 parser/live PM 为合同：尾随可见空格保留 `&#x20;`；列表项开头的字面 marker 保留防止意外嵌套所必需的标准转义。 |

### 15.2 恢复出口与 source commit 是两个安全域

`rebuildMarkdownFromRich()` 仍是 source commit：候选必须重解析成当前 live 文档，成功后
才原子重置 source/canonical/expectedDoc 与 pending intents。`getRecoveryMarkdown()`
则是灾备导出：它返回 live serializer 的保守 canonical，并只移除 HorseMD 内部的
standalone `<br />` 占位。调用者只能经 `saveSourceSyncRecovery()` 打开另存对话框，
不能接收原文件路径，也不能把未验证恢复 Markdown 冒充成 committed source。

因此“未验证”在这里表示恢复文件可能规范化作者写法，不表示允许覆盖原件。两侧资产
被同时保留：原 Markdown 字节不动，用户眼前的富文本至少有独立 Markdown 副本可导出。
另存保护不是依赖默认文件名：renderer 会拒绝规范化后等于原路径的返回值，主进程还会
比较现存文件的 `dev + ino` 与 realpath，因此大小写别名、符号链接和硬链接也不能绕过
原文件边界。UI 回归用普通段落末尾 hardbreak 构造可重复的 strict rebuild `null`，验证
恢复副本仍写出、原件逐字节不变且标签保持 dirty。

### 15.3 实际问题与预防性问题边界

本轮有执行证据并已修复的现有问题：恢复双谓词死锁、列表内部空占位误拒、分歧嵌套
列表新增项写成错误外层结构、分歧段落删除后的尾随空格丢失、列表正文歧义 marker 被
去转义后冷重开成嵌套列表、前导空格部分删除被误判为整段删除，以及固定 24 字符锚点
跨过无关 `- -` 表示分歧后把合法跨段尾删拒绝为 `visible-stream-mismatch`。最后一项由
完整 family matrix 的 `plain@literal-shapes.md` 首次抓到：修正后 4 个 fixture × 5 种
逐字操作的追加、源码切换、保存、删除和冷重开全部直接通过，未进入 recovery warning。

二次独立复审还否决了两个会重新污染验收器的实现：其一，全局把任意 paragraph 的
whitespace-only text 视为空会吞掉 NBSP 与全角空格；现已撤销，只允许精确的前导空格
尾删 mapper 以 provenance 声明“最后一个顶层 ASCII 空白 paragraph”是同一个空占位，
`list_item` 内也只识别 ASCII editor placeholder，Unicode 空白保持耐久。其二，可见尾删
raw span 可能夹着 PM 看不见的 unused reference definition；visible fallback 现在遇到
非空、零可见的 source-only 行必须拒绝，由有 source ownership 的处理器接管，不能靠
最终 PM 验收（它同样看不见该资产）放行。

严格 rebuild 同样不能绕过 table ownership：空 cell canonical 与作者真实单独 `<br>`
形状相同，重建候选必须携带 Editor 当前 `remarkCtx` 派生的 table durable context。已知
空 cell 选择去占位候选，作者 `<br>` 选择保留候选；若 source model 无法证明 provenance，
strict rebuild 返回失败并转入独立 recovery，而不是换用默认 GFM parser 或猜测 fallback。
重建规范化本身也复用同一 parser，避免把 display math 内形似表格的 `| <br /> |` 当成
GFM 空 cell；纯函数已锁定“表格形公式 + 配置 parser”不改字节。

仍存在但不属于本次“保存暂停”根因的现有 P2：全新文档通过输入规则键入 `1. ` 时，
保存后可能规范化为 `1)`。该行为在 `ca11a73` 基线即可复现，语义仍是有序列表但没有
保留作者 marker 拼写；应进入独立的 input-intent 保真修复，不能通过放宽 durable
semantics 或往表格比较器加例外处理。

未作为现场根因扩大的预防性项目：带复杂行内格式的 terminal table break opaque token、
默认关闭的 transaction-primary、任意未来 schema attrs、以及为 durable remark 管线
增加“切回旧 verifier”的运行时开关。最后一项会重新启用已证实不安全的第二 authority，
不能作为安全回滚。发布回滚必须以提交/版本为单位；若未来必须紧急隔离 durable rich
路径，应降级到现有 source textarea，而不是恢复旧的独立 GFM gate。灾备 canonical
当前会剥离 standalone `<br>`；“用户恰好在别处失败，同时该行是有意独立 HTML `<br>`”
尚无现场复现，属于恢复文件保真风险而非原文件安全问题，后续应以节点 provenance
区分，不能为这个预防性场景重新接回严格提交谓词。

### 15.4 门禁

- `npm run test:rich-source-verified-core` 已加入 `npm run test:core`；
- `test:nested-number-list-source-ui`、`test:diverged-delete-source-ui` 与六种
  `test-ragged-table-save-ui` 场景已加入 UI regression；
- `test:diverged-list-structure-ui` 覆盖一次 marker 删除、继续输入、三次 lift、保存；
- `test:list-item-literal-marker-source-ui` 覆盖必要转义、保存与冷重开；
- `test:sync-recovery-ui` 覆盖 strict rebuild 成功和 `null` 后独立恢复副本两条出口；
- 若本机存在 `/Users/fengmo/Documents/test.md`，UI runner 只读取原件并在临时普通文件
  副本上执行 `external-copy`，最后再验证原件字节未变；
- 多语言代码围栏由 round-trip multi-language matrix 与真实表格 fixture 继续覆盖，
  Go、JavaScript、TypeScript、Python、Rust、Java、C、C++ 均不是触发条件。

## 16. v0.13.51 真实表格录入复现与恢复闭环

### 16.1 为什么 0.13.50 的全绿复审仍漏掉现场

0.13.50 已修复“编辑现有参差表格”的 source ownership，但用户现场还有更早的一次状态
转换：在本来就存在合法 authored/canonical 分歧的长文档里执行 `/table`。该命令增加了一个
table node，却没有像 `/code`、`/math` 一样声明局部 source intent，而是落入通用
`exactBaselineTableCountChange`。后者要求表格之外的整篇 normalized source 相等；现场
文件中的旧参差表、转义与排版差异使这个前提从一开始就不成立，因此插入表格的第一次
回调即以 `ambiguous-table-count-change` 拒绝。之后九个 cell 的编辑不是新的九个独立
故障，而是在已经冻结的 verified baseline 上继续积压；保存 toast 只是最晚出现的结果。

此前矩阵从“已有表格后的 cell edit”起步，或者用 canonical fixture 新建表格，因而没有
覆盖“全局已分歧文档中的 slash table creation”这一真实入口。Go、JavaScript、Python、
Rust 等代码围栏只扩大了文档形状，并不参与失败判据；在隔离的真实 `test.md` 副本中保留
相邻围栏逐字节不变后，仍可由 `/table` 单独稳定触发旧失败。

### 16.2 核心修复边界

`/table` 现在复用 slash block 的原子 source intent：命令执行前捕获精确 authored 查询行
和 PM block 位置，执行后只序列化刚创建的 table node，用 table parser 清除这个新表格中
已知由 serializer 产生的空 cell 占位，再原子替换查询行。候选仍进入同一个
`mirrorVerifiedState` / durable acceptance；没有增加第二写入点、第二 parser authority，
也没有放宽整篇语义等价。九格后续逐字符输入继续走现有单 cell table ownership。

恢复文件的旧问题是另一条链：best-effort canonical 会把 serializer 的空 cell 写成
`<br />`；冷重开后 provenance 已丢失，这些字节会被解释成用户 authored hardbreak，造成
恢复副本再次保存失败。现在 recovery 在 authored、previous canonical、live canonical
三域仍同时存在时取得 `(table,row,column)` ownership，只清理所有坐标都仍精确指向
serializer placeholder 的集合。分析器异常、重复坐标、坐标漂移或任何 cell 不匹配都
返回原 canonical；recovery 出口本身仍无条件可用，不会重新调用 strict commit 谓词。

### 16.3 禁止推断行列身份

同形表格最终改变一个或多个 cell，都不能单靠内容签名证明它是批量改字、拖动行列，还是
重复行之间的重排；即使字符串唯一，也可能由“先移动、后输入”构造出来。当前实现因此在
dispatch 边界遍历每批 ProseMirror transaction 的 mapping：旧 document 的每个既有 cell
起点必须未被删除、且精确映射到新 document 的同一 `(table,row,column)`，坐标身份才保持
为真。该证明跨尚未提交的 revision 粘滞；任何行列增删/移动一旦使其为假，在下一次真正
verified commit/reset 前都不能被后续单 cell 输入洗白。previous canonical 与 next
canonical 字符串相同但 PM doc 已变化，也走同一规则，不能用 equality 快捷路径复用旧
provenance。`/table` 的实际命令先清 query、再插表，是两个 doc-changing dispatch；局部
intent 因此跨 batch 累积 `{valid, insertedTables}`，允许安全的零插入 clear batch，要求
所有旧 cell 全程坐标稳定且最终恰好新增一张表。任何中间 batch 失败后不可被后续插表洗白。

同一 200ms 发布窗口也可能包含多个被证明坐标稳定的 cell 编辑，例如从第一格删除真实
`<br />` 后立即在相邻空格 Enter。此时 mapper 按每个 cell 的 parser-owned range 生成
互不重叠的补丁并原子应用；serializer 仅在 table AST 边界旁增加或删除换行，不算第二个
表外编辑，作者表外字节仍原样保留。文字、空格或段落 hardbreak 等非边界差异仍 fail-closed。

这是有意的 fail-closed，不是等待继续追加等价特例。若产品要支持富文本表格拖动行列后
仍逐字节保留空 cell / authored `<br />` 区别，正确方向是由 move-row / move-column
transaction 在发生时携带显式结构 intent，而不是从最终内容反推身份。

### 16.4 新增门禁

- `test:table-sequential-entry-ui`：分歧 fixture 与可选真实文件隔离副本中执行
  `/table` → 3×3 → 九格逐字符输入 → 保存，并检查相邻多语言围栏逐字节不变；
- `test:sync-recovery-ui`：strict rebuild 失败后另存含参差表与真实 authored `<br />`
  的恢复副本，冷重开、继续改单元格并直接保存，不出现第二次 recovery；
- `test:table-empty-cells`：覆盖重复/漂移坐标的全有或全无清理、多 cell 重排拒绝、
  canonical 不变但文档已变化时拒绝坐标 identity，并以真实 PM transaction 覆盖
  `/table` 的 clear → insert 双 dispatch 累积证明；
- `test:table-hardbreak-move-ui`：同一发布批次跨两个 cell 移动 authored hardbreak，
  验证源码、保存、磁盘与冷重开，不进入 recovery；
- `test:table-recovery-external-copy`：只在显式传入 `HORSEMD_REPRO_FILE` 时读取外部恢复
  文件并在临时副本测试，绝不写用户原件。

### 16.5 最终全量回归补出的非表格耐久表示差异

完整 UI runner 在表格矩阵之后继续抓到两类确定性现有问题。第一类是网页 HTML 粘贴的
顶层独立图片：ProseMirror DOM paste 产生 `paragraph[image]`，而 HorseMD 自身 parser
会把同一 Markdown 图片重开为 `image-block`。两者源码、可见 alt/caption 与默认尺寸
相同，但旧 durable projection 比较内部 node type，因而拒绝 serializer 自己产出的候选。
修复只把“顶层、唯一 image、默认 ratio、无 marks、无未知 attrs”的两种表示投影为同一
standalone image 资产；resize、混合段落、链接/marks 和未来 attrs 继续 fail-closed。

第二类是空文件直接从正文起笔。Crepe 初始 PM scaffold 含首个空 H1 与空 paragraph；用户
从 paragraph 写正文后，serializer 不输出未使用的空 H1，但严格比较会把这个 UI scaffold
误当作者内容。现在只有 generated-scratch 候选携带
`generatedScratchEmptyHeading` provenance，且只允许 expected 文档首位、level=1、无内容、
无未知属性的 heading 被省略。含作者非空源码的非 generated-scratch 文档没有该 context，
作者显式 Markdown 空标题仍严格比较；零字节、纯空白与 BOM-only 输入按现有初始化规则属于
新草稿路径，不承诺保留其空白/BOM 字节。
标题起笔与正文起笔都覆盖逐字符输入、即时源码切换、保存和冷重开。

同轮审查还发现 file-backed tab 在应用关闭确认前虽然禁用了 recovery，却仍可能调用 strict
rebuild 并推进 baseline。关闭阶段现在对文件标签只允许 verified flush；rebuild/recovery
仅用于无路径 scratch session。双文件分屏中全局 `sourceMode` 误隐藏右栏富文本也由 #66
回归确认并修复为只隐藏左栏 rich surface。这四项都有执行证据；file-close 当前由 helper
契约与静态调用链证明，其余三项都有真实 UI 闭环，均不是为未来 schema 预设的防御性特例。
