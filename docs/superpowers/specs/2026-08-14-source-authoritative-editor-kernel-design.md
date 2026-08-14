# 源码权威编辑器内核设计

日期：2026-08-14

## 目标

在保留 HorseMD 现有 Milkdown/ProseMirror 富文本界面的前提下，引入一个实验性的源码权威编辑内核。Markdown 原文成为每个标签页唯一可写、可保存和可撤销的状态；ProseMirror 只负责呈现该 revision 的富文本投影。

第一阶段验证段落、标题、无序列表、有序列表和 GFM 任务列表，重点覆盖 Tab、Shift+Tab、Enter、Backspace、Delete、空行、连续空行、行首/行尾空格与 Tab、保存、源码切换和冷重开。

## 问题总结

当前正式链路以 ProseMirror 文档为编辑状态，经 Milkdown serializer 生成 canonical Markdown，再由原文保真、事务映射、耐久语义验证和恢复规则尝试写回作者源码。它同时维护：

- ProseMirror 当前文档；
- Milkdown 延迟发布的 canonical Markdown；
- 上一次 canonical 基线；
- 作者原始 Markdown；
- 待处理的输入意图和源码范围；
- 各类局部保真与故障恢复上下文。

列表、空段落和空白问题不是随机故障。同一操作序列只要落入特定的文档结构、光标位置、事务批次和快照 revision 组合，就会稳定产生分叉。继续增加保存后修复规则会扩大组合状态空间，无法从架构上关闭这一类问题。

## 方案选择

### 方案 A：继续扩充富文本优先保真规则

改动最小，也能快速修复单个复现路径，但 serializer 已经丢失的 marker、空白和空行只能通过上下文猜测恢复。该方案不满足本设计目标。

### 方案 B：Fork Milkdown transformer 并给节点附加原文元数据

解析时可保留 marker、缩进、原始片段和范围，能降低 serializer 的信息损失。但只要 ProseMirror 和 Markdown 仍可分别产生持久化状态，就仍需解决 revision、事务时序和双向同步问题。Fork 还会增加依赖升级成本。

### 方案 C：源码事务内核 + ProseMirror 投影

这是采用的方案。源码内核独立于 Milkdown，Milkdown 继续负责 schema、node view 和富文本呈现。只有在 Milkdown 缺少不可替代的 dispatch/parse 钩子时，才维护范围受限的小型补丁或 fork；fork 不是状态模型本身。

## 核心不变式

1. `MarkdownDocument.text` 是唯一持久化真相。
2. 用户编辑、命令、任务勾选、撤销和重做只能提交源码事务。
3. 每个事务携带 `baseRevision`；过期事务不得覆盖新状态。
4. ProseMirror 文档必须标记其来源 revision，禁止反向全量覆盖源码。
5. 保存、源码模式、会话恢复和文件监听读取同一个 `MarkdownDocument.text`。
6. 未被事务覆盖的原始字节必须逐字节保持不变。
7. 内核不得生成 `&#x20;`、`&nbsp;`、HTML 注释或私有零宽哨兵来表达空白。
8. 不使用全文唯一子串、重复文本 ordinal 或保存阶段启发式修复来决定写入位置。
9. 无法证明映射的事务必须明确拒绝并保留原文，不得猜测提交。

## 架构组件

### MarkdownDocument

保存原始文本、当前 revision、源码选区和源码事务历史。第一阶段使用不可变字符串接口，保留未来替换为 piece table/rope 的边界。

源码事务结构：

```js
{
  baseRevision: 12,
  from: 48,
  to: 48,
  insert: '\n* ',
  intent: 'split-list-item',
  selection: { anchor: 51, head: 51 }
}
```

事务只有在 `baseRevision === document.revision`、范围有效且命令前置条件仍成立时提交。提交结果包含新文本、新 revision、受影响范围和新的源码选区。

### LosslessSyntaxIndex

从原始 Markdown 建立带 raw offset 的块级索引。第一阶段复用项目现有 remark/GFM 解析能力取得语义节点及 position，再从原文切片读取真实 marker、缩进、分隔符、行尾和空白，不把 stringify 结果当作 token 来源。

索引至少提供：

- source offset 所属段落、标题、引用或列表项；
- 列表容器、父子层级、marker 和任务 marker 的精确范围；
- 物理行起止、LF/CRLF/lone-CR 和最终换行；
- 当前块可安全重新解析的最小语法容器。

首次实现可以按受影响容器重建索引；当 fence、引用或列表边界无法局部确定时扩大到全文重新解析。扩大解析范围不会改写源码，因此是安全回退。

### SourceCommandRouter

把富文本交互转换成源码事务。它分为两类：

- 通用文本替换：输入、IME commit、粘贴、选区删除，根据 versioned source map 替换对应 raw range；
- 结构命令：Enter、Tab、Shift+Tab、Backspace、Delete、任务勾选和列表类型转换，根据 LosslessSyntaxIndex 生成明确的源码 patch。

每个结构命令是纯函数：输入原文、语法索引和源码选区，输出一个事务或带稳定错误码的拒绝结果。

### RichProjection

把指定 revision 的 Markdown 解析成 ProseMirror 文档，并维护 PM position 与 raw source offset 的双向映射。投影更新带 `sourceProjection` transaction meta，所有输入观察器必须忽略该类事务，避免回环。

第一阶段允许重新投影完整文档以验证正确性；性能门禁达标后，再根据受影响语法容器替换 ProseMirror 子树。重投影前后通过源码选区恢复光标，不能依赖可见文本搜索。

### TransactionGateway

接管 EditorView 的用户事务入口。ProseMirror transaction 只表示用户意图候选，不直接成为耐久状态：

1. 识别 transaction 类型及其源 revision；
2. 由 SourceCommandRouter 生成源码事务；
3. 先原子提交 MarkdownDocument；
4. 从新 revision 生成 RichProjection；
5. 更新 EditorView 和选择；
6. 向 React/App 发布已经提交的 MarkdownDocument 文本。

Milkdown `markdownUpdated` 在实验模式下仅作为语义诊断通道，不能推进源码或保存基线。

## 第一阶段交互语义

### 普通文本、标题和空白

- 输入和删除直接修改对应 raw source range。
- 行首、行尾空格和真实 Tab 原样保存；富文本展示由 Markdown parser 的标准语义决定。
- 连续空白行是原文中的真实换行序列，投影可以用空段落呈现，但不得写入 `<br />` 占位。
- 标题 marker 与正文之间的原始空白只有在用户操作覆盖对应范围时才改变。

### 无序和有序列表

- 新列表 marker 使用用户实际输入的 `-`、`*`、`+`、`1.` 或 `1)`。
- Enter 在非空项中按当前层级和 marker 风格插入下一项。
- Enter 在空项中删除当前 marker 并退出列表，保留用户随后产生的真实空行。
- Tab/Shift+Tab 只修改当前列表项及其明确归属子树的前缀，不重写整个列表。
- 有序列表 Enter 新建兄弟项时沿用当前项的 `.` 或 `)` 分隔符，并写入当前显式编号加一；未操作兄弟项的原始数字和分隔符不变。

### 任务列表

- 逐字输入 `* [ ] `、`- [x] ` 等文本时，源码始终先存在；满足 GFM 任务语法后投影显示复选框。
- 点击复选框只替换精确的任务 marker 字符 `[ ]`/`[x]`。
- 删除任务正文后只剩裸 `* [ ]` 或 `* [x]` 时，按项目已经确认的跨产品语义保留为普通列表文本；投影不得在冷重开时自动提升为任务节点。
- 不通过 `&nbsp;`、`&#x20;`、注释或私有字符维持空任务节点。

## 实验模式与迁移边界

第一阶段在现有状态栏“富文本/源码”入口的展开菜单中增加标签页级“源码权威内核（实验性）”开关，默认关闭，不修改旧文件行为。开关状态只属于当前标签页会话，不写入 Markdown 文件；关闭或重新打开时必须先完成当前源码事务，不能通过 serializer 重建。启用后，整份标签页只能有一个权威状态，禁止按块混合源码优先和富文本优先。

首版允许编辑段落、标题和列表族。引用、代码块、表格、图片、HTML、数学、Mermaid 和复杂行内格式可以正常渲染；尚未迁移的结构性修改必须被阻止并给出明确提示，不得静默回落到 serializer 覆盖源码。普通文字输入只有在 source map 能证明范围时才能提交。

迁移按语法域推进：

1. 段落、标题、列表和任务；
2. 引用、代码块和行内 marks；
3. 表格、图片、HTML、数学和 Mermaid；
4. 全量默认启用；
5. 删除旧 preservation mapper、双快照和 canonical 修复链。

每个阶段只有在状态机矩阵通过且现有对应专项回归无退化后，才扩大默认范围。

## 错误处理与诊断

源码事务拒绝使用稳定错误码，例如：

- `stale-revision`：事务基于旧 revision；
- `unmapped-selection`：PM 选区无法证明映射到 raw range；
- `unsupported-structure`：当前语法域尚未迁移；
- `projection-mismatch`：源码解析结果与拟更新投影不一致。

拒绝时保留原文和上一个有效投影，不推进 dirty/save baseline。开发构建记录事务类型、revision、源码范围和错误码；不得记录完整私人文档内容。生产实验模式显示简短可操作提示。

## 撤销、保存、模式切换与外部修改

- Undo/Redo 记录源码事务及其逆事务，随后重新投影，不使用独立的 ProseMirror 历史作为持久化来源。
- 保存直接写当前 `MarkdownDocument.text`，不调用 serializer 决定文件内容。
- 切换源码模式直接展示同一个文本；源码模式输入也提交相同事务类型。
- 外部文件修改形成新的 document revision，重新解析并投影；本地存在未保存事务时沿用现有冲突提示策略，不能把外部文本与 canonical 结果自动合并。

## 测试策略

### 纯函数测试

为每个 SourceCommand 建立精确输入/输出测试，逐字节断言 LF、CRLF、Tab、首尾空格、marker、空行和未触及区域。

### 状态机与属性测试

生成以下维度的确定性命令序列：

```text
列表类型 × 嵌套深度 × 空/非空 × 引用上下文
× Insert/IME/Enter/Tab/ShiftTab/Backspace/Delete
× Undo/Redo/源码切换/保存/冷重开
× LF/CRLF × 空格/Tab
```

每一步都验证：

- 内存源码符合预期；
- 未触及字节保持不变；
- parse(source) 的语义与富文本投影相等；
- 保存文件逐字节等于内存源码；
- 冷重开得到相同源码和语义；
- 不生成项目禁止的实体、注释或哨兵；
- 同一随机种子始终产生相同结果。

失败的最小化命令序列保存为固定 fixture，进入日常回归矩阵。

### UI 测试

输入规则、光标、Tab、Enter 和模式切换继续使用后台 CDP，并通过 `human-input.mjs` 逐字符提交文本。测试必须覆盖立即保存、延迟后保存、源码切换、完整退出和新进程冷重开，不能只检查屏幕 DOM。

### 发布门禁

除新增源码内核测试外，至少运行：

- `npm run build`
- `npm run build:mobile`
- `npm run test:source-map`
- 现有列表、任务、空段落、首尾空白、模式切换与保存专项
- `npm run guide:check`

## 性能约束

- 用户输入到投影更新的目标延迟小于一帧；首版全量重投影若超过预算，必须在扩大支持范围前实现块级重投影。
- 不在滚动时解析全文或读取全篇布局。
- heavy document 继续沿用 textarea 快速打开策略。
- source map 和 syntax index 必须绑定 revision，禁止复用旧映射。

## 完成标准

第一阶段只有同时满足以下条件才可交给用户试用：

1. 实验模式启用后，段落、标题和列表族的所有已声明操作均从源码事务提交；
2. 保存路径不依赖 Milkdown serializer；
3. 用户已报告的任务、空列表项、连续空行、列表退出、Tab 和首尾空白流程全部进入自动化；
4. 状态机随机序列可重复运行且不存在静默源码回退；
5. 版本号、CHANGELOG、匹配 guide 页面、桌面和移动构建均更新；
6. 本地 macOS 测试包在最新源码构建后覆盖安装、清除 quarantine、启动并验证运行路径与版本。
