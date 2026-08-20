# HorseMD AI 接手手册

> 面向全新的 AI / 开发者。先读这篇，再按链接深入。更新时间：2026-08-12。

## 0. 当前状态快照

- 当前架构修复分支：`fix/rich-source-sync-architecture`；源码候选：`0.13.51`。
  `0.13.47` 的真实长会话人工验收曾失败，因此仍不得仅凭专项自动化宣布稳定发布；
  事故现场和 RS-41 完成标准见 `rich-source-divergence-incident-0.13.47.md`。
  0.13.50 已把普通保存、强制 flush、源码切换统一到单一 verified-commit 边界，并落地
  共享 parser、表格源码结构模型、durable semantic projection 与 revision-bound state。
  对短行/参差 GFM 表格的修复不是 `semanticJson` 例外：短行在 editor parse adapter
  中确定性补齐，作者源码仍由 table source model 按 cell range 局部持有。严格重建失败
  时原文件保持不变；恢复副本必须独立、无条件返回当前 live doc 的 best-effort canonical，
  不能再用同一提交验收谓词把恢复出口锁死。`v0.13.29` 仍是最近正式发布版。
- **0.13.x 系列主线（自 0.12.69 之后）**：
  - **原文保真与空段落硬不变式**：空段落 `<br />` 占位绝不允许进入作者源码（`withoutStandaloneEmptyBlockLines` 在 `preserveRichMarkdownSource` 出口强制剥离）；空段落映射不得要求全文可见流相等、不得被无关空段落否决；连续空段落映射不递归。系列提交 `bb5b9f4` → `cfae66a`。
  - **可见流分叉单块回退**：源码与 canonical 可见流分叉（如行中 `* ` 使 remark 拆成列表项）时，局部对齐与行区域映射都会失败并 fail-closed。`preserveDivergedBlockTextChange()`（`lib/markdown-preservation/regions.js`）只处理单 canonical 块：先反转义 canonical 拼写（`\*`→`*`、`&#x20;`→空格），0.13.30 起优先用 source/canonical 等数量非空块的 ordinal 定位；候选数量不等才退回全文唯一子串，仍歧义则拒绝写回。初始提交 `abb6d09`，最新复盘见 `diverged-ordinary-save-regression.md`。
  - **整文档清空不再复活（0.13.14）**：富文本删除全部内容（canonical 为空）时，`preserveRichMarkdownSourceCore` 新增 `document-emptied` 分支直接清空源码，杜绝分歧源码 fail-closed 复活旧内容。详见 `full-doc-delete-caret-settle-regression.md`。
  - **模式切换光标守卫（0.13.14）**：settle 重试只重复自己上次写入的选区，选区漂移即用户接管；`followSourceCaret` 不再依赖合成事件标志（键盘/IME 路径同样聚焦跟随）。详见 `full-doc-delete-caret-settle-regression.md`。
  - **序列化转义反转义（0.13.15–0.13.16）**：remark-stringify 把行首第一个空格序列化为 `&#x20;` 实体、波浪线转义为 `\~`。所有 canonical → 源码翻译点（`adaptCanonicalRegionToSource`、scratch/new-document、列表 direct-join）统一经 `canonicalTextToSource` 还原为作者字面拼写（`&#x20;`→空格、`\~`→`~`）。**全量转义形态清单见 `canonical-escape-audit.md`——新增转义处理前必须先读它**；`\\` 因行尾硬换行语义刻意不动。
  - **缩进上下文的空格实体回归（0.13.21）**：旧版 `canonicalTextToSource` 把任何四空格或 Tab 开头的 canonical 行都当作 indented code，导致普通顶格测试通过、但列表续行/嵌套块中的 `&#x20;` 仍直接进入源码。现在只依靠 fenced code、inline code、HTML 和 source-aware literal region 判定字面区，结构缩进不再短路反转义；纯函数覆盖四空格、Tab、列表续行，UI 覆盖已有文档、清空重写、真正空文件、保存和完整重开。
  - **连续空格与模式切换共同根因（0.13.22，0.13.65 更新）**：真实 CGEvent 证明第 3 个 whitespace-only canonical callback 会误走 `structural-line-change`，删除段落边界并污染后续增量。现在纯空格阶段只推进 baseline，首个可见文字才一次提交；不能直接写四个以上 ASCII 空格（会变代码块），因此新源码统一使用标准 `&nbsp;` 加余下字面空格，不写入或剥离 `U+200B` 私有哨兵。详见 `leading-space-mode-switch-regression.md`。
  - **数字点列表与多列表同步（0.13.17–0.13.18，0.13.50 验收修正）**：`- 1. 甲乙` 被 remark 解析为嵌套有序列表，canonical 与 source 可见流永久分歧，列表内编辑曾 fail-closed 丢失。`preserveDivergedNestedListChange` 现在以 canonical/source 的**顶层列表块**做 ordinal 对齐，再以 `token + text + indent` 项序列执行结构级 diff；覆盖删除数字 marker、Backspace 多级提升、后续含内联加粗列表以及 Enter 拆分。Enter 拆分产生的下一项必须写成缩进的 `  2.`，不能生成另一个外层 `- 2.`。验收投影只忽略没有 attrs 的空 list-item paragraph 占位；带未知 attrs 的空节点仍是 durable，禁止扩成全局忽略规则。延迟 `markdownUpdated` 同时包含多个 `- / + / *` 列表操作时，`preserveBatchedListBlockChanges(requireMultiple: true)` 会先做多块原子对账，避免单列表处理器提前返回、marker 被统一或编辑丢失。完整根因、事故记录和回归矩阵见 `nested-list-sync-bug-handoff.md`。
  - **跨块删除兜底（0.13.18，0.13.50 锚点修正）**：分歧文档里**跨多个 canonical 块的纯删除**（拖选删尾部、一次删多个列表树）此前 fail-closed 回退，删除静默消失、保存后重开复活。`preserveDivergedVisibleDelete`（`regions.js`，diverged 分支最后）从删除边界前至多 24 个字符开始，选择**最长且唯一**的局部后缀；若无关列表表示差异落在固定窗口内，会有界缩短而不是误拒。实际 raw 删除内容仍须逐行去标记后与 canonical 删除逐字相等，否则 fail closed。详见 `canonical-escape-audit.md`。
  - **字面列表标记与反引号强制边界（0.13.25–0.13.26，0.13.50 验收修正）**：稳定列表行用去转义语义视图 + raw boundary map 定位 `1.` / `1)` / `-` / `+` / `*` 字面正文；输出必须保留 canonical 中阻止字面文本被重新解析成嵌套列表所必需的 `\`，不能以“源码零转义”为目标。反引号部分删除改为读取完整 next canonical line，重复行按 ordinal，独立 `<br />` 空段落两侧按同行映射。行内代码事务从 live `view.state.doc` 序列化，失败不推进双快照。详见 `list-item-literal-marker-escape-regression.md` 与 `backtick-source-sync-lock-regression.md`。
  - **列表转换与行内代码闭合交互（0.13.27）**：列表 marker 转换的正文比较先统一 `U+200B + spaces` 与 `&#x20; + spaces` 的 canonical/source 语义，但只输出 marker 变化；行内代码不再在首个中文字符时提前激活，只在最终闭合反引号输入后创建 mark，并支持首尾方向键退出。``` + Space 恢复代码块输入规则，空代码块 Backspace 后立即对账 live doc。真实 IME、逐键 fence 删除、保存和新进程重开均有专项回归。
  - **新文档三反引号原文保真（0.13.28）**：generated scratch 与空文件首次编辑全部属于本次用户输入，改由 `canonicalFreshTextToSource` 还原 Markdown 正文 serializer punctuation；真正的 fenced/inline code 与 HTML literal 仍保持字节不动。新增 `test:literal-triple-backtick-source-ui`，逐键输入 delimiter、真实中文 IME、切源码、保存和完整进程重开。
  - **桌面外部拖入打开（0.13.29）**：Finder / 文件资源管理器拖入一个或多个文件时复用标签打开链路，拖入目录时加入多根工作区；图片落在富文本正文仍由编辑器插图链路处理。Renderer 只通过 preload 的 `webUtils.getPathForFile()` 取得路径，目录判定留在主进程，移动端 capability 明确关闭。详见 `desktop-drop-open.md`。
  - **复杂分叉文档普通保存（0.13.30）**：文档其他位置存在嵌套 `- -`、字面三反引号、空引用和重复短文本时，普通正文追加文字不再因全文子串重复而误报“保存已暂停”。`preserveDivergedBlockTextChange` 先按 source/canonical 等数量块 ordinal 对齐；数量不等仍走旧唯一匹配或 fail closed，绝不整篇覆盖。详见 `diverged-ordinary-save-regression.md`。
  - **复杂分叉列表普通保存（0.13.31）**：0.13.30 的 fixture 虽含 `- -`，但只编辑了独立正文。source 第二个 `- ` / `+ ` / `* ` / ordered marker 会被 canonical 消费为嵌套语法；`preserveDivergedNestedListChange` 现在在比较和 raw offset 中跳过恰好一层该前缀，输出仍保留作者 marker。专项必须同时编辑独立段落、嵌套项和后续兄弟项。
  - **重复引用后的 raw 位置错写（0.13.32）**：前部结构分叉后，`preserveMiddleEmptyBlock` 不得复用 canonical 的全文 visible-line index；重复“测试”引用会让错误位置伪装成有效邻接。完全对齐才可直取索引，分叉改用相邻 pair + block kind + equal-count ordinal，失败继续 fail closed。专项还必须从第三个重复引用按两次 Enter 退出并逐字输入唯一末段，直接保存后比较源码、磁盘和冷重开。禁止引入整篇 parse/stringify 语义循环，它会破坏字面列表 marker 与反引号。
  - **引用后空白直接起笔（0.13.33）**：Crepe 在末尾引用后提供的空 `<p>` 可能只序列化为 canonical terminal padding。直接点击该空白起笔是 `previous.length` 处的纯正文追加，不等同于从引用内按两次 Enter；若先走 locally-aligned 零宽 visible offset，会被前面的重复空引用误导。plain append 现提前写入物理文档末尾，结构语法明确拒绝；UI 必须真实点击空段落、逐字输入、直接保存并冷重开。
  - **保存事务 settle 与恢复副本（0.13.34，0.13.50 恢复出口修正）**：可见 ProseMirror transaction 可能早于 Milkdown 的 `markdownUpdated` / pending input intent 对账。保存和富文本→源码先调用同一 fail-closed flush 并有界让出事件循环重试，不用 canonical 覆盖作者源码；持续歧义时原文件不写。严格 rebuild 仍必须通过 verified-commit，但 `.horsemd-recovered.md` 是独立安全域：直接取得 live doc 的 best-effort canonical，剥离内部 standalone `<br>` 后供用户另存，不写原文件、不推进 verified baseline，因此绝不能再次走导致 strict rebuild 失败的同一验收谓词。专项：`test:editor-flush-settle`、`test:source-sync-recovery`，文档 `source-sync-save-recovery.md`。
  - **斜杠表格原子提交与恢复闭环（0.13.51）**：复杂文档中 `/table` 过去由通用 table-count matcher 处理；当无关区域已有合法 authored/canonical 差异时，表格插入立即 fail-closed，后续逐格输入全部积压并在保存时进入恢复。现在命令前捕获精确 authored 查询行，命令后只序列化新表格、清除新表格 serializer 空 cell，并携带 table durable context 走原子 verified commit，不修改全局等价判据。恢复导出在三域仍齐全时按 table source model 的 cell 坐标清理已证明的空占位，真实 `<br />` 不动；普通路径的坐标身份由每批 ProseMirror transaction mapping 证明并在未提交 revision 间粘滞，行列增删/移动或 canonical 未变但 PM doc 已变化时不得从最终内容反推身份。专项覆盖真实 `test.md` 隔离副本、非 Go 代码块、九格逐字输入，以及可证明坐标的恢复副本冷重开后再次保存。
  - **事务优先源码同步（0.13.35，方案一）**：新增统一 PM transaction observer、原子 plain-text mapper、真实 step trace、LF/CRLF split 和空块 block hint。专项测试可用 `window.__hmTransactionSourcePrimary = true` 证明正文/引用/列表项普通文字不经过 canonical diff；生产默认仍不接管。默认接管试验曾被完整段落测试抓到“结构 Enter 后空块首字写错相邻块”，因此新增 quarantine/checkpoint 合同并撤回放行。详见 `transaction-source-sync-architecture.md`。
  - **事务优先源码同步第二阶段（0.13.36，方案一）**：mapper 改为 BOM/CRLF/lone-CR 归一化双视图（字节证明在 LF 视图，输出保留作者拼写）；hint 槽坐标指向完整段落分隔之后；嵌套空 textblock（列表项/引用）拒绝接管；列表输入意图只在当前源快照上重建自己的块，不再覆盖延迟窗口内的跨块编辑；`preserveChangedLineRegion` 零宽行边界粘行根因修复。回归含 LF/CRLF/BOM+CRLF + undo/redo 逐字节、列表意图跨块专项（primary 构建验证、默认构建 SKIP）、全家族矩阵双构建。`test:list-intent-cross-block-ui` 与 `test:source-transaction-sync-ui`（三行尾变体）为方案一专项。
  - **多轮持久化与列表原子提交（0.13.46 候选）**：列表 input intent 在完整 slot 重建、marker 恢复或严格中间空槽列表写回后立即消费，禁止下一次正文回调复用旧快照；批量列表写回必须完整覆盖同一 callback 的后续正文，CRLF 在 `\r` 前插入，0/1 final-EOL 分别保留正确退出列表边界。新增 `test:family-multicycle-ui`（4 轮编辑保存、5 次冷打开，默认/primary 双路径）；第四轮专门在正文与 fence 之间输入“正文 → 有序列表 → 正文”。真实 `123321.md` override 与 20/20 家族矩阵均通过。
  - **斜杠菜单代码块原子同步（0.13.47，子路径完成、家族未关闭）**：稳定复现 `/code` 已写入源码后，slash 菜单先删 query、再创建空 code_block；旧尾部 mapper 只删除 `/code`，没有写入 fence，后续代码/尾文/前文编辑全部从错误基线继续。现于命令前捕获精确 authored 行，命令后只序列化当前 code_block 并验证成对 fence 后原子替换。`test:tail-fence-ui` 在 40ms 菜单选择后不做 checkpoint，连续编辑三块，再验证源码、保存和冷重开；但安装包真实长会话继续编辑后仍能再次分叉，见 RS-41，不得把该专项绿色结果描述为整体修复。
  - **v0.13.51 耐久表示与退出授权边界**：顶层单图 HTML paste 只允许与默认尺寸 parser `image-block` 做交叉表示投影；同类型 image block、ratio、marks、混合段落与未知 attrs 必须严格。generated scratch 仅可凭 provenance 忽略首位空 H1 scaffold，含作者非空源码的文档不得复用该 context。应用退出时 file-backed tab 只允许 verified flush，确认前严禁 rebuild/recovery/reset baseline；无路径 scratch 的第三出口只写 session。双文件分屏的 `sourceMode` 只隐藏左栏 rich surface，右栏不得跟随全局隐藏。对应门禁：`test:issue-77-ui`、`test:paragraph-source-ui`、`test:source-sync-recovery`、`test:issues-66-67-ui`。
  - **源码/富文本架构探索**：`live-preview-migration-plan.md` 当前以 transaction→source 为主线；CodeMirror Live Preview 仅保留长期备选。
  - **代码块体验**：编辑器代码块行号（不透明背景、贴左、全高、右侧分隔竖线）、**PDF 导出代码块带行号**、表格单元格单击直接编辑。提交 `5094e0b`、`7b2e50b`、`9bc9412`、`a45f958`。
  - **原生 HTML 表格自适应**：带 `width` 属性的 HTML 表格恢复作者语义（`100%` 跟随容器、固定像素收缩），`td/th` 允许列收缩，表格内图片按单元格宽度显示，不再横向溢出。提交 `8a98b5f`。
  - **文档位置记忆（#111）**：重开文档恢复上次光标与滚动位置；按路径存 `{offset, len, scrollTop}`，长度不匹配（外部修改）不恢复。提交 `5fe4af4`。
  - **源码+预览双栏**：左源码唯一编辑、右富文本只读预览，双向滚动/光标同步（0.13.x 早期落地）。
- 最近关键提交：
  - `29fffe5 docs: record code-block fence "swallowing" investigation`
  - `5fe4af4 feat(editor): restore the last caret/viewport when reopening a document`（#111）
  - `8a98b5f fix(editor): raw-HTML tables follow the writing-area width`
  - `a45f958 style(editor): full-height code-block line numbers`
  - `9bc9412 style(editor): code-block line numbers flush against the block edge`
  - `abb6d09 fix(editor): diverged-stream rich deletions must reach authored source`
  - `5094e0b feat(editor): click-to-edit table cells and code block line numbers in PDF`
  - `cfae66a fix(editor): enforce empty-paragraph <br /> invariant at the source boundary`
  - `606bfc6 feat(editor): add source rich split preview`
- 最近完整验证：
  - **0.13.47 代码块连续编辑候选**：在真实 `123321.md` 的临时副本上分别验证 `/code` 40ms 快速选择、350ms 等待选择、三反引号 input-rule 与字面 fence。创建代码块后不做中间 checkpoint，继续修改代码、代码块后的正文和前面的列表项；源码、保存文件、冷重开均保持完整且唯一 fence，三类块结构与内容一致。`test:tail-fence-ui` 还在 `/Applications/HorseMD-0.13.47-test.app` 安装包上通过。纯函数、两时序 slash 门禁、family multicycle、transaction LF/CRLF/BOM、列表、代码围栏删除、字面反引号、空段落/空引用、raw-offset/source-map、桌面与移动构建均通过；独立 code-reviewer 复审放行。
  - **0.13.46 已安装工作区**：默认生成 fixture 和真实 `123321.md` 临时副本均完成 4 轮继续编辑/保存、5 次冷打开；release-default 与 transaction-primary 两条路径逐字一致。第四轮曾真实抓到 middle empty slot 创建有序列表时连续 `visible-stream-mismatch`，修复后加入 LF/CRLF（禁止 lone `\r`）纯函数门禁。4 个真实文件 × 5 操作的追加/保存/删除/重开矩阵 20/20；列表新建/转换、continuous、四档 chaos、反引号删除、空段落/空引用、全文删除、前导空格、source probes、LF/CRLF/BOM+CRLF transaction、raw-offset/caret/source-map 全过。桌面、移动与 `dist:dir` 构建通过；`/Applications/HorseMD.app` 已核验为 0.13.46，app.asar 含 `middle-empty-block-list-filled`，运行进程来自该路径。旧 0.13.45 备份：`/Applications/HorseMD-0.13.45-backup-1786416290.app`。
  - **0.13.33 当前工作区（未提交）**：用户真实文件稳定复现“引用后直接点击空正文 → 富文本有字 → 保存后前面出现 `>新增文字`、末尾丢字”。新增第六个复杂分叉直接保存场景后，0.13.32 先红、修复后绿；纯函数增加 diverged quote + trailing plain append 合同，并在用户当前已编辑文件副本上用真实鼠标点击、逐字输入、直接保存、切源码再次通过。源码保真、段落、空段落/空引用、全文/局部删除、所有列表输入/转换/任务、反引号/代码围栏、前导空格、真实 IME、raw-offset、continuous、mixed transaction、长文档与四组 chaos 均通过；桌面/移动/guide/dist 通过。覆盖安装 0.13.33 后，安装包再通过引用后空白直接起笔、字面 marker、反引号、前导空格、mixed transaction 与全文删除。`test:source-rich-split-ui` 的首字符自定义光标像素断言独立失败（三次一致），本轮未改 CSS/双栏逻辑，须作为单独视觉回归排查，不能为追求全绿混入本次保存修复。
  - **0.13.32 当前工作区（未提交）**：保存了 0.13.31 长会话的 live ProseMirror 与损坏磁盘证据，确认唯一末段 `ceeavvß/` 被写进较早的重复引用。修复 `preserveMiddleEmptyBlock` 在 visible stream 分叉时复用全文 ordinal 的错误；专项扩为五个独立场景，尤其包含同引用三段批量编辑和从第三个重复引用按两次 Enter 退出后逐字输入唯一末段。纯函数、source map/text、source fidelity、空段落/空引用、全文/局部删除、全部列表输入与转换、任务列表、反引号/代码围栏、前导空格、真实 IME、raw-offset、长文档、continuous、mixed transaction 和四组 chaos 均通过；桌面、移动、guide 与 dist 通过。覆盖安装 0.13.32 后，安装包可执行文件再次通过复杂分叉直接保存、字面列表 marker、反引号删除、前导空格和 raw-offset 五组高风险回归；运行进程来自 `/Applications/HorseMD.app`，app.asar 含本轮 `sourcePairs` 修复标记。
  - **0.13.31 当前工作区（未提交）**：0.13.30 的自动化 fixture 含 `- -`，但只实际编辑独立段落，用户手测继续触发保存暂停。现已稳定证明 source 第二个 `- ` 被 canonical 消费为嵌套 marker，而旧项序列只剥离数字 marker。`lists.js` 统一识别一层 ordered/bullet 嵌套前缀；纯函数覆盖嵌套项和后续兄弟项，UI 专项对独立段落/嵌套项/兄弟项分别执行直接保存、源码、磁盘和冷重开。27 组家族矩阵（含真实 IME composition）、桌面/移动/guide、dist 通过；覆盖安装 0.13.31 后，三目标复杂保存、IME、字面 marker、代码围栏四组安装包回归通过。首次 `open` 复用了安装前旧 PID，已强制结束并确认新进程路径、启动时间及 app.asar 版本/修复标记；以后仍不得只看 Info.plist。
  - **0.13.29 已发布基线**：完整富文本 ↔ 源码家族矩阵全部通过，包括纯函数映射、逐字段落/列表/反引号、空段落/空引用、模式切换光标、保存与完整重开、混合事务、长文档、源码 + 预览、连续/嵌套写作和四组 chaos；桌面拖入专项、主进程文件系统、图片拖放边界、侧栏创建、桌面/移动构建、guide 检查和三平台打包均通过。GitHub Release `v0.13.29` 已发布；后续发现的 RS-30、RS-31 分别属于 0.13.30、0.13.31 修复，不得回写 0.13.29 标签。
  - **0.13.28 当前工作区（未提交）**：新增 generated scratch / empty-file 字面三反引号回归。纯函数、真实 IME 行内代码、逐键三反引号源码/保存/完整重开、fence 删除、new source/new document list、source fidelity、raw-offset、source-map、35/35 probes、leading-space、IME、列表转换/字面 marker、continuous 与四组 chaos 全部通过；桌面、移动和 guide 构建通过。`dist/mac-arm64/HorseMD.app` 与 `/Applications/HorseMD.app` plist 均核验为 0.13.28，安装后的 app 再跑字面三反引号和行内代码 UI 回归通过，运行进程来自 `/Applications/HorseMD.app`。旧 0.13.27 备份位于 `/tmp/HorseMD-0.13.27-backup-20260809-072510.app`。
  - **0.13.27 已安装基线**：`test:markdown-preservation`、列表转换（含 `U+200B + 5 spaces`）、真实中文 IME 行内代码闭合、方向键退出、单/三反引号删除、``` + Space→Backspace→快速正文、source fidelity、raw-offset、source-map、35/35 probes、leading-space、IME、continuous 与四组 chaos 全部通过；桌面、移动和 guide 构建通过。旧 0.13.26 备份位于 `/tmp/HorseMD-0.13.26-backup-20260809-070148.app`。
  - 0.12.46–0.12.69 的历史验证（`test:mermaid-paste-ui`、`test:issue-98-ui`、`test:list-conversion-ui`、`test:source-rich-split`、`test:settings-ui`、云同步专项等）仍有效，命令见下文第 7 节。
- 真实大文档回归依赖本机文件：
  - `/Users/yangtingyi/vibe_everything/置身钉内/MinerU_markdown_置身钉内_14.34.50_2064164636132720640.md`
  - `/Users/yangtingyi/vibe_everything/电脑档案.md`

## 1. 先了解用户的工作方式

用户非常重视“真的改好”和“真实环境验证”。给他测试之前必须做到：

- 不要让用户测旧版本。每次请用户手测前，先从当前源码重新构建、安装、启动，并确认运行路径。
- 每次交付给用户测试的普通改动都必须升级 patch 版本，包括小功能、bug 修复、交互和视觉调整（例如 `0.12.0` → `0.12.1`），不能让不同源码继续使用同一个版本号。只有用户明确认定为独立“大功能/模块”时才升 minor（例如 `0.12.x` → `0.13.0`）；代理不能自行把一般功能算作 minor。
- 教程站的 `guide/package.json` 表示已发布教程与截图基准，不随本地测试包自动升级；页面可单独标注较新的测试功能版本。`npm run guide:check` 只禁止应用版本低于教程基准，避免把尚未发布的下载文件和截图伪装成新版本。
- 一个可手测的大功能完成并通过专项验证后，如用户没有要求暂停或改方向，默认立即构建、安装、启动当前源码版本交给用户验收；不要等待用户再次要求“打最新包”。
- 不要只说“理论上可以”。涉及 UI、PDF、编辑器、模式切换、表格、图片、移动端时，要用自动化或真实 app 复现。
- 自动化测试不能抢用户的 macOS 键鼠和前台窗口。通过
  `scripts/lib/electron-test-app.mjs` 启动时保持默认 `background: true`；
  只有人工观察或教程截图才显式使用可见窗口。
- 输入规则、Enter/退格、模式切换后立即输入和源码保真必须逐字符派发，优先
  使用 `scripts/lib/human-input.mjs`。批量 `Input.insertText` 只能用于粘贴、
  数据准备或与逐键行为无关的测试；中文逐字提交不能代替真实 IME composition。
- 不要把大文件、小文件、富文本、源码模式混为一谈。HorseMD 很多 bug 只在真实大文档、表格、代码块、LaTeX、远程图片、源码/富文本双向切换里出现。
- 不要轻易重写敏感状态机。源码/富文本切换、dirty 状态、保存、PDF 预览、编辑器生命周期都已经踩过坑。
- UI 需要“高级、优雅、和谐”。如果改视觉，至少检查浅色、深色、莫兰迪主题和窄屏，不要只看一个默认主题。
- 用户会直接指出不满意的点。接受反馈，回到代码和真实测试，不要争辩。
- 提交要聚焦。用户要求提交时再提交；不要擅自推送、发布、关闭 issue，除非他明确说。
- 发给用户验收的 macOS app 必须杀旧进程、覆盖 `/Applications/HorseMD.app`、清 quarantine、启动并验证 `app.asar` 包含本轮标记。

常用安装验证命令：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:dir

APP_SRC="/Users/yangtingyi/vibe_everything/horseMD/dist/mac-arm64/HorseMD.app"
APP_DST="/Applications/HorseMD.app"
BACKUP="/tmp/HorseMD.app.before-$(date +%Y%m%d-%H%M%S)"
pkill -f "$APP_DST/Contents/MacOS/HorseMD" 2>/dev/null || true
if [ -e "$APP_DST" ]; then mv "$APP_DST" "$BACKUP"; fi
cp -R "$APP_SRC" "$APP_DST"
xattr -dr com.apple.quarantine "$APP_DST" 2>/dev/null || true
open -a "$APP_DST" --args --user-data-dir=/tmp/horsemd-latest --remote-debugging-port=9222
plutil -extract CFBundleShortVersionString raw "$APP_DST/Contents/Info.plist"
ps -ax | rg "HorseMD.app/Contents/MacOS/HorseMD"
```

## 2. 项目是什么

HorseMD 是一个 Typora 风格的 Markdown 编辑器：

- 桌面：Electron + Vite + React
- 编辑器：Milkdown Crepe / ProseMirror / CodeMirror
- 移动端：Capacitor，复用 renderer
- 用户教程站：`guide/`，VitePress
- 官网/下载页：`website/`

核心产品原则：

- 一个窗口内多标签，而不是每个文件一个进程。
- 富文本与源码模式都必须可用，且切换时光标/视口稳定。
- Markdown 源码要尽量可读，Review 标记、链接、图片、表格等都要能 round-trip。
- 大文档优先稳定和不卡，再谈花哨能力。
- 桌面和移动共用 renderer，平台能力通过 `window.api.capabilities` 和 `window.api.platform` 隔离。

## 3. 入口文档

建议阅读顺序：

1. [AGENTS.md](../AGENTS.md)：短规范，必须遵守。
2. [CLAUDE.md](../CLAUDE.md)：历史更长、更细的 AI/开发者指南。
3. [architecture.md](./architecture.md)：模块、进程、状态流。
4. [features.md](./features.md)：功能到具体文件的映射。
5. [manual-test-checklist.md](./manual-test-checklist.md)：人工验收基线。
6. [development.md](./development.md)：构建、CDP、发布验证。
7. [handoff-mode-switch.md](./handoff-mode-switch.md)：源码/富文本切换根因和修复历史。
8. [markdown-source-preservation.md](./markdown-source-preservation.md)：原始 Markdown 保真合同、粘贴边界与 Live Preview 远期决策。
9. [rich-dirty-indicator-regression.md](./rich-dirty-indicator-regression.md)：富文本未保存提示的 200ms 防抖根因、即时反馈合同和回归命令。
10. [source-sync-save-recovery.md](./source-sync-save-recovery.md)：保存暂停的事务稳定竞态、fail-closed 保护、恢复副本与架构根治边界。
10. [local-markdown-links-regression.md](./local-markdown-links-regression.md)：富文本本地绝对/相对链接跳转、安全 IPC 边界与回归命令。
11. [source-rich-split-view-prd.md](./source-rich-split-view-prd.md)：已实现的“左源码、右富文本”双栏实时预览用户范围、状态和验收标准。
12. [source-rich-split-view-architecture.md](./source-rich-split-view-architecture.md)：双栏同步、滚动联动、保真与性能边界；后续扩展必须遵守。
11. [editor-source-switch-regression-0.12.34.md](./editor-source-switch-regression-0.12.34.md)：段落合并、切换后即时输入、硬换行光标偏移和行内代码边界的联合根因报告。
12. [editor-refactor-strategy.md](./editor-refactor-strategy.md)：编辑器重构边界。
13. [performance-large-doc.md](./performance-large-doc.md)：大文档性能设计。
14. [user-guide-maintenance.md](./user-guide-maintenance.md)：教程站和截图规范。
15. [issue-101-pdf-images-table-density-report.md](./issue-101-pdf-images-table-density-report.md)：PDF 图片二次加载、路径双重编码与表格固定行高的根因。
16. [soft-line-break-display-report.md](./soft-line-break-display-report.md)：普通源码单换行在富文本中显示为空格的根因、显示合同和防回归测试。
17. [pdf-table-layout-fidelity-report.md](./pdf-table-layout-fidelity-report.md)：PDF 表格列宽与行距两次修复的完整事故复盘。
18. [pdf-visual-fidelity-runbook.md](./pdf-visual-fidelity-runbook.md)：所有“编辑器正常、PDF 不一致”问题的工程化排查和验收流程。
19. [long-code-copy-virtualization-regression.md](./long-code-copy-virtualization-regression.md)：长代码块复制截断的虚拟化根因、正确数据源和防回归停止条件。
20. [empty-paragraph-contract.md](./empty-paragraph-contract.md)：空段落 `<br />` 占位与可见流分叉的完整合同；0.13.x 空段落硬不变式的依据。
21. [issues-105-106-save-fidelity-regression.md](./issues-105-106-save-fidelity-regression.md)：0.12.63 保存/原文保真回归（与近期删除回退同族）。
22. [codeblock-fence-investigation.md](./codeblock-fence-investigation.md)：**当前进行中**——用户反馈「插两次代码块保存重开，最后一个代码块吞后面正文」的排查留底：解析机制已确认（` ```正文` 同行走正文会吞后续），但正常插入路径全部复现正常；需要用户提供精确步骤/文件才能定位。改代码前先读它。
23. [issue-104-long-document-mode-switch.md](./issue-104-long-document-mode-switch.md)：长文档模式切换光标偏移（行内公式 atom）根因。
24. [macos-real-input-testing.md](./macos-real-input-testing.md)：用 macOS 底层 CGEvent 在前台逐键输入的真实测试方法（疑难编辑问题的补充手段）。
25. [full-doc-delete-caret-settle-regression.md](./full-doc-delete-caret-settle-regression.md)：富文本「删除全部内容」复活 + 模式切换光标被 settle 重试覆盖 的联合根因报告（0.13.14 修复集）。
26. [canonical-escape-audit.md](./canonical-escape-audit.md)：remark 序列化转义全清单（`&#x20;`、`\~`、`\*`、`\\`、实体、`<br />`）在各保真路径的处理状态与安全边界；新增转义处理前必须先读。
27. [leading-space-mode-switch-regression.md](./leading-space-mode-switch-regression.md)：连续空格中间态如何破坏段落边界、为何 0.13.21 的普通空格方案语义不成立、Typora `U+200B` 对照、解析/映射/保存的完整修复与 CGEvent 证据。
28. [nested-list-sync-bug-handoff.md](./nested-list-sync-bug-handoff.md)：数字点列表（`- 1. xxx`）、Backspace 列表提升、后续列表 ordinal 偏移和延迟多列表批次丢失的完整根因、实现边界与回归矩阵。继续修改源码保真管道前必须先读。
29. [rich-source-fidelity-bug-family.md](./rich-source-fidelity-bug-family.md)：富文本 ↔ 源码保真 Bug 家族总账；集中记录产品合同、31 类问题、代码归属、自动化/人工回归、已知边界和后续追加模板。接手任何源码保真问题时先读这篇总索引。
30. [empty-blockquote-removal-regression.md](./empty-blockquote-removal-regression.md)：空引用块被删除后 syntax-only `>` 源码残留、保存重开复活的精确复现、零可见字符根因、局部 raw-gap 修复和验收矩阵。
31. [mixed-rich-source-transaction-regression.md](./mixed-rich-source-transaction-regression.md)：跨顶层块快速编辑时延迟 `markdownUpdated` 合并多处变化、源码保留已删内容或漏掉新增内容的事务边界根因与回归。
32. [list-item-literal-marker-escape-regression.md](./list-item-literal-marker-escape-regression.md)：列表项正文输入 `1.` / `1)` / `-` / `+` / `*` 字面文本后源码多出反斜杠，并连带格式化未编辑列表 marker/空行的根因、修复边界与验收合同。
33. [backtick-source-sync-lock-regression.md](./backtick-source-sync-lock-regression.md)：逐字输入/部分删除/全部删除反引号后，双快照分叉、保存暂停和源码切换锁死的完整事务证据、四个根因与回归合同。
34. [desktop-drop-open.md](./desktop-drop-open.md)：桌面文件/文件夹拖入打开的产品边界、preload/IPC 安全边界、图片插入冲突处理与专项测试。
35. [diverged-ordinary-save-regression.md](./diverged-ordinary-save-regression.md)：复杂既有文档中普通重复短文本编辑被误判为 `visible-stream-mismatch`、保存暂停的根因、等数量块 ordinal 修复与直接保存回归。
36. [transaction-source-sync-architecture.md](./transaction-source-sync-architecture.md)：方案一的 transaction observer、原子 mapper、影子/primary 状态机、空块事故、放行门槛和完整回归顺序。继续架构迁移前必须先读。
35. [release-v0.13.29.md](./release-v0.13.29.md)：从上一正式版 `v0.12.62` 到当前发布候选的用户更新说明、安装文件、关联 Issue 和验证证据。

历史文档说明：

- [triage-issues.md](./triage-issues.md) 是早期 issue 批处理记录，不是当前待办列表。
- `docs/release-v0.5.5.md`、`docs/release-v0.6.0.md`、`docs/release-v0.6.5.md` 是历史发布说明草稿/归档。

## 4. 目录地图

```text
src/main/
  index.js               Electron 主入口、窗口、菜单、单实例、启动参数
  documents.js           文档/对话框/PDF IPC 注册
  filesystem.js          文件读写、目录、复制、删除、图片保存
  watchers.js            chokidar watcher，必须防止系统根目录/受限目录
  security.js            外部协议、本地字体权限等安全口
  pdf-export.js          PDF 预览/保存、隐藏窗口、printToPDF、任务取消
  pdf-images.js          PDF 图片暂存、单图/总量限制、资源地址替换
  pdf-document.js        PDF HTML/目录/页眉页脚纯函数
  pdf-print-styles.js    PDF 打印 CSS
  html-export.js         HTML 预览 token、图片内嵌、保存与资源清理
  html-document.js       独立 HTML 模板、主题、目录和 CSP 纯函数
  pandoc-export.js       Pandoc 检测、选择、转换与错误映射
  pandoc-core.js         Pandoc 格式白名单、版本与参数纯函数
  subprocess.js          无 shell 子进程、超时与输出上限
  ai/                    AI 上下文快照与变更提案纯逻辑

src/preload/index.js     安全的 window.api bridge

src/renderer/src/
  App.jsx                顶层 shell，tabs/session/split/settings/pdf/source-mode 接线
  components/Editor.jsx  Crepe 生命周期拥有者，避免继续膨胀
  components/editor-*.js 编辑器专项能力
  components/settings/   设置中心模块
  hooks/                 workspace/source-mode/pdf/html/pandoc/find/sidebar 等 hooks
  lib/                   命令、菜单、纯工具
  platform/              Capacitor shim 和跨平台 API 合同
  styles/app.css         主样式和主题变量

scripts/                 CDP、纯函数和回归测试
docs/                    开发文档
guide/                   VitePress 用户教程站
website/                 官网/下载页
android/, ios/           Capacitor 原生壳
```

## 5. 最敏感的不变量

### 5.1 编辑器生命周期

- `Editor.jsx` 是 Crepe/ProseMirror 生命周期拥有者。
- 获取 ProseMirror view 必须用 `crepe.editor.ctx.get(editorViewCtx)`。
- `crepe.on(markdownUpdated)` 必须在 `crepe.create()` 前注册。
- 只有真实用户编辑可以让 tab dirty。
- 富文本 UI 的未保存提示不得等待 Milkdown 的 200ms `markdownUpdated`；使用 `pendingRichEdit` 即时提示、使用后续源码保真结果结算。所有消费方通过 `isTabDirty(tab)` 判断，不要直接比较 `content` 与 `savedContent`。
- ProseMirror DOM 可见不等于可安全编辑：初始 canonical baseline、公开 API 与 `ready` 都完成前必须保持不可编辑；完成后才标记 `data-horsemd-ready="true"`。否则极早输入可能被吞入初始化基线而无法保存或切到源码。
- Markdown 链接 Ctrl/Cmd+点击：网页链接只走 `openExternal`；本地 `file://`、POSIX 绝对路径、Windows 盘符/UNC 和相对路径都必须先规范为 file URL，再仅通过 `openFileUrl` IPC 打开。主进程必须校验发送者，不能让任意 renderer 调用系统 shell。
- 程序化初始化、源码/富文本同步、恢复内容、PDF source 生成不能标脏。
- ProseMirror 插件和 keymap 走 `prosePluginsCtx`。
- Milkdown node view 追加到 `nodeViewCtx`，不要设置 `editorViewOptionsCtx.nodeViews` 覆盖内置组件。

### 5.2 源码/富文本切换

- Crepe 在源码模式中必须保持挂载，只隐藏，不卸载。
- 源码 textarea 是非受控的，保留 `liveContentRef` / `commitLive` 流程。
- 普通源码单换行由 Milkdown 保留为 `data-is-inline="true"` 的 hardbreak 节点。默认多行显示只能通过 `hm-preserve-soft-breaks` 做视觉处理；禁止把它序列化为 `<br>`、尾随空格或空段落。Enter 与 Shift+Enter 的编辑语义不得随该偏好变化，修改后必须运行 `npm run test:soft-break-ui`、`test:paragraph-source-ui` 和 `test:mode-switch-raw-offset-ui`。
- textarea DOM 会把 CRLF 变成 LF；任何源码输入或源码命令写回 `liveContentRef` 前必须经过 `source-text-fidelity.js`，禁止直接保存 `textarea.value`。
- 只有源码真的改过，切回富文本才同步到 Crepe。
- Crepe 的 serializer 不保证原始 Markdown 写法；`lastMarkdownRef` 是用户源码，`canonicalMarkdownRef` 只用于识别局部富文本变更。普通文字只允许字符级回写；结构操作最多替换受影响列表、表格或行；映射失败必须保留原文并报告失败。唯一例外是从空白起步、全程仅富文本写作的新文档：它没有既有源码格式，嵌套列表退出的中间空项不能进入增量基线，应以完整实时 canonical 建立结构并恢复已记录 marker；一旦用户实际编辑源码，立刻关闭该例外。
- 分块大文档追加完成后必须记录完整 `canonicalMarkdownRef`，但绝不能用 canonical 重建 `lastMarkdownRef`。富文本插入类命令必须以 `tab.content` / `lastMarkdownRef` 为全文基底，不得以 `getMarkdown()` 为基底。
- 源码调用 `replaceAll` 同步到 Crepe 时可能连续发出多个 `markdownUpdated`。`programmaticReplaceRef` 必须保持到下一次明确的 `markUserEdit`，不能只跳过第一条回调，否则前一次用户编辑的 TTL 会把后续同步事务误判为用户编辑。
- Crepe canonical 始终带结尾换行，文档末尾新建的空 paragraph 又没有 visible index。不能把其后续输入映射到“最后一个可见字符”；`preserveAppendedParagraph` 必须按用户源码原有结尾换行数追加标准段落边界。修改后运行 `npm run test:paragraph-source-ui`，并确认测试包含保存、退出和全新进程重开。
- 源码 textarea 是非受控组件，`defaultValue` 只在挂载时读取。富文本→源码切换前必须调用 `editorApis[id].flushMarkdown()`，同步更新 `tabsRef` 和 tab state 后再挂载 textarea；不能只依赖异步 `markdownUpdated`，否则立即切换会显示旧内容且后续 state 更新无法回填。专项测试必须在最后一次 `Input.insertText` 后零等待切换。
- 空文档的默认“空 H1 + 空正文”只属于富文本起笔 UI，磁盘源码仍是空字符串。`canonicalForSource()` 必须在标题保持为空时剥离该骨架；用户在标题输入后才将其纳入 canonical。移除这层会使首次输入因 `#\n\n` 与空源码基线不一致而被原文保护器拒绝。`test:paragraph-source-ui` 必须同时覆盖从 H1 起笔和跳过 H1 从正文起笔。
- Enter 创建的末尾空 paragraph 会被 Crepe canonical 暂时写成独立 `<br />` 块。`preserveTrailingEmptyBlock()` 必须在创建时只推进 canonical、不改 raw source，填入文字时再调用文档末尾块追加逻辑；否则真人慢速输入会把正文并入标题并残留 `<br />`。CDP 测试必须逐字输入且每行停顿到上一条 `markdownUpdated` 已提交，高速整句输入会掩盖该问题。
- 在已有块之间按 Enter 还有两条独立路径：快速输入可能直接产生一个新 paragraph，停顿输入会先产生 `<br />` 占位。`preserveMiddleEmptyBlock()` 只可用前后未变化可见行的序号映射替换中间 raw 间隙，不能用零可见字符 affinity；并且必须把列表、表格、标题、引用和 fenced code 排除，让专用结构处理器保留原有语法风格。
- ProseMirror 的 `bullet_list` 节点不保存用户触发输入规则时键入的 `-`、`*` 或 `+`。必须在空段落输入空格前记录 marker intent，再把它恢复到刚创建的列表层级；不能全局替换 serializer 的 `*`。松散列表可跨项目间空行，但顶层有序/无序类型变化必须截断；转换后 canonical 若把相邻同类型列表合并，`replaceMarkdownListBlock()` 必须按转换前项目内容缩小到原列表子区间。详见 [0.12.45 新输入源码保真报告](./new-input-source-fidelity-report.md)。
- 正文转列表必须与“已有列表类型转换”分开：前者需要在 dispatch 前记录该普通段落的 raw offset，dispatch 后用 `serializerCtx(view.state.doc)` 取得实时 canonical，并且只向对应 authored 行写入 `- `、`1. ` 或 `- [ ] `。禁止读取 `crepe.getMarkdown()` 缓存或用全篇 canonical 覆盖；实现见 `editor-block-list-source.js`，回归为 `npm run test:block-list-source` 和 `npm run test:list-conversion-ui`。
- 新建空列表项的 Crepe `<br />` 是内部占位，不是用户 Markdown：源码只能短暂表示为用户输入的 `- ` / `* ` / `+ ` / `1. ` / `1) `，首个列表文字必须按列表树顺序填回该项，绝不能落到上一段。物理键盘必须在 Space 的 `keydown` 记录 marker；连续 Enter、marker、Space 时若原始源码尚未发布空段落，禁止使用失真的 raw offset，改以 canonical 前/后快照在前后可见内容边界插入仅该列表（末尾与中间均覆盖）。若新文档的首次 `markdownUpdated` 已合并标题、正文和嵌套列表，source/canonical 都为空时必须保留完整 canonical，不能让当前内层 selection 的输入规则补丁覆盖外层；生成的全新列表采用紧凑间距。嵌套项退出后紧接无序项时，`markdownUpdated` 和立即源码切换的 `flushMarkdown()` 必须共用完整 canonical 生成路径并恢复未发布的 `-` marker，避免中间空 `3.` 或默认 `*` 固化；用户实际编辑源码后关闭该路径。输入规则意图在首次成功重建该列表后必须立即清除；不得在后续 Enter/Tab 的嵌套列表操作中重放旧 source snapshot。初始化与 `flushMarkdown()` 必须同用 `serializerCtx(view.state.doc)`；缓存 serializer 与实时 serializer 的尾换行差异也必须视为非用户编辑。修改此边界后运行 `npm run test:rich-list-source-ui`、`npm run test:new-document-list-source-ui`、`npm run test:new-source-fidelity-ui` 和 `npm run test:list-conversion-ui`。
- 同时带 Markdown 和 HTML 的粘贴：Markdown 覆盖 HTML 语义时直接以 Markdown 插入并保留原文；网页 HTML 的纯文本回退不完整时必须保留 HTML。详见 [markdown-source-preservation.md](./markdown-source-preservation.md)。
- 光标映射不能用关键词匹配。主路径是 Markdown raw offset ↔ ProseMirror block-aware mapping。
- `npm run test:mode-switch-raw-offset-ui` 是当前的精确 UI 回归：它按 Markdown raw offset 覆盖正文、表格、列表、代码块，并执行两条连续切换链。不能只用相邻文本或关键词断言。
- 该模式切换回归还必须覆盖硬换行后的 raw offset，以及源码→富文本后零等待 Enter、跨 `90/220ms` 分段输入。首次恢复在 layout 阶段同步执行；富文本一旦收到真实键盘、输入法或鼠标交互，延迟 settle 重试必须终止，不能覆盖用户的新选区。
- `npm run test:issue-86-ui` 用真实表格手柄连续新增两行和两列，填写最后一行全部单元格、从富文本真实保存、彻底退出并以全新用户目录重开文件，保护单元格归属、表格维度、空单元格 `| |` 序列化，以及原有 `<br>` 单元格换行。表格结构变化只替换对应 canonical 表格块，禁止扩大到整篇源码；不要在序列化中途删除空单元格占位。详见 `docs/issue-86-table-save-report.md`。
- `npm run test:table-ui` 保护另一条独立的表格 UI 合同：短表自然宽度、宽表内部横向滚动和不撑开页面；列边缘的短暂悬停仍用于加行/加列，只有按住约 220ms 才实时调整列宽；宽表最右端连续 10 次悬浮/调整均不得把 `scrollLeft` 重置为 0。不要重新注册 `columnResizingPlugin`，它会与 Crepe 自定义 `TableNodeView` 竞争 hover transaction，重新引入跳回和非确定性预览。
- `npm run test:task-list-persistence-ui` 保护任务复选框的完整写盘链路：勾选、保存、退出重开、取消、保存、再次重开。Crepe 的任务标签在 `pointerdown` 阶段更新节点并阻止兼容 `mousedown`，因此根节点必须在 capture 阶段标记用户编辑；不要用全篇重新序列化或单独改文件绕过现有 `markdownUpdated` 与原文保真链路。
- `editor-block-handle-guard.js` 只负责块操作条的触发过滤和滚动隐藏；横向位置由 `Feature.BlockEdit.blockHandle.getPosition` 交给 Milkdown BlockProvider 一次性计算，禁止再用 `translate`、MutationObserver 或 ResizeObserver 二次改坐标。标题、正文和各级列表必须共用正文左边界这一条轨道。修改 BlockEdit、插件顺序或 editor gutter 时，必须同时运行 `npm run test:block-handle-gutter-ui` 与 `npm run test:inline-html-block-handle-ui`。
- 编辑状态：可见光标要跟随光标。阅读状态：光标不在可视区时保持视口。
- 回归必须覆盖：
  - 富文本 → 源码 → 富文本 → 源码
  - 源码 → 富文本 → 源码 → 富文本
  - 表格、代码块、行内代码、图片附近、大文档、重复文本

### 5.2b CodeMirror 与剪贴板

- CodeMirror 长代码块使用虚拟化 DOM，`.cm-line` 只代表当前渲染窗口，不能作为“完整代码”的数据源。
- 代码块右上角复制按钮必须解析完整 ProseMirror `code_block`；解析失败时应停止且不能显示成功反馈，禁止回退拼接 `.cm-line`。
- CodeMirror 内部的全选和部分选区复制由其文档状态负责。修复“复制整块”时不能拦截或扩大原生选区，否则选择 65 行会错误复制全文。
- 复制测试必须读取真实系统剪贴板，并在每次操作前写入 sentinel；只检查 toast、按钮颜色或未清空的旧剪贴板会产生假通过。
- 修改代码块 node view、复制事件、DOM 映射或 clipboard IPC 后，先运行 `npm run build`，再运行 `npm run test:issue-98-ui` 和 `npm run test:clipboard-ipc-ui`。构建与 UI 测试不能并行，否则测试可能加载旧 `out/`。
- 完整根因和验收数据见 [长代码块复制截断事故复盘](./long-code-copy-virtualization-regression.md)。

### 5.2c 可见流分叉、空段落硬不变式与文档位置记忆（0.13.x）

**空段落 `<br />` 硬不变式**：Crepe 的空段落序列化为独立 `<br />` 行，它只是编辑器内部占位、**永远不能进入作者源码**。`preserveRichMarkdownSource` 在所有启发式路径之后强制执行后置条件：统一剥离独立 `<br />` 占位行（保留块引用前缀 `>`），再按源文件尾部换行风格钳制（`capOutputTrailingNewlines`）。行内 `text<br>text` 与表格单元格 `<br>` 是作者内容，不受影响。任何新处理路径都不例外——不要在守卫上打补丁，边界兜底已经在 `markdown-source-preservation.js` 出口。空段落映射只要求变更区间局部对齐（`.some` 至少一个空段落行），**不得要求全文可见流相等**，也不得被无关空段落否决。

**整文档清空（document-emptied）硬不变式**：富文本删除全部内容后 canonical 为空串，这是无歧义事实，**必须清空源码**。此前所有启发式在分歧源码上 fail-closed 返回旧源码（reason `visible-stream-mismatch` / 残留 `"# "`），导致「富文本删了全部 → 切源码内容还在 → 保存写入旧内容 → 重开内容复活」。`preserveRichMarkdownSourceCore` 顶部 `if (!next) return { markdown: '', reason: 'document-emptied' }` 分支锁定该行为；任何新路径不得对空 canonical 返回旧源码。回归：`npm run test:full-doc-delete-source-ui`（Cmd+A 清空 → 切源码为空 → 保存磁盘为空 → 重开为空）+ 纯函数用例。

**模式切换 settle 重试光标守卫**：`useSourceModeSwitch` 的布局效应在切换后最长 ~3s 内重复 `apply()` 直到布局稳定，源码分支每次都会重放 `restoreSourceCaret`。重试**只能重复自己上次写入的状态**：首次恢复后若 textarea 实时选区 ≠ `__horsemdSourceSelectionBaseline`，立即停手（不依赖 React 合成事件标志——键盘/IME/辅助输入可能漏置位）。同时 `followSourceCaret = hasSourceCaretIntent && !sourceViewportMoved`（选区相对基线移动且视口未滚 = 编辑意图，回程聚焦跟随；不再要求 `sourceSelectionUser`）。回归：`npm run test:mode-switch-caret-settle-ui`（无事件程序化移动光标 → 等 2.6s 不被覆盖 → 往返映射正确）。

**数字点列表嵌套解析分歧（0.13.17–0.13.18）**：`- 1. 甲乙` 会被 remark 解析为**嵌套有序列表**，canonical 的 `1. ` 是结构 marker，源码里的 `1. ` 却是作者正文，两条可见流从该行起永久分歧。当前 `preserveDivergedNestedListChange` 不再依赖全文可见偏移，而是：只用 `indent === 0` 的顶层列表块做 document ordinal 对齐；把 canonical 列表树投影成 `token + text + indent` 项序列；把源码投影成带 raw offset 的 marker/续行序列；最后执行项级 diff。该路径覆盖数字 marker 删除、无 marker 续行、外层 bullet 提升、Enter 拆项、空项填字、后续含 `**加粗**` 的普通列表。一个延迟 `markdownUpdated` 同时含多个列表操作时，先用 `preserveBatchedListBlockChanges(requireMultiple: true)` 原子对账至少两个顶层块，禁止单列表处理器只提交批次的一部分。完整清单与安全边界见 `nested-list-sync-bug-handoff.md` 和 `canonical-escape-audit.md`；回归至少运行 `test:nested-number-list-source-ui`、`test:diverged-list-structure-ui` 与 `test:rich-source-chaos-ui`。

**跨块纯删除兜底（0.13.18）**：分歧文档里**跨多个 canonical 块的纯删除**（拖选删除文档尾部、一次删除多个列表树）会越过单块映射（nested-list、diverged-block）直接 fail-closed——删除静默消失、tab 不脏、保存写旧内容、重开复活。`preserveDivergedVisibleDelete`（`regions.js`，diverged 分支**最后**、fail-closed 之前）：canonical 删除区间**前 24 个可见字符**在 source 可见流中唯一锚定（删除起点 = 锚点后；终点 = 区间后锚点或可见流末尾），并要求**被删 raw 文本逐行去列表标记后的可见文本 == canonical 删除区间可见文本**（不一致 fail-closed）。仅纯删除（replacement 无可见文本）；替换/插入不适用。回归：纯函数 1 例（真实 canonical）+ `npm run test:diverged-partial-delete-ui`（反馈.md 形态整段删除 → 切源码 → 保存 → 重开不复活）。

**可见流分叉（visible-stream divergence）**：源码与 canonical 对同一批字节的块解析不同（典型：行中 `* ` 被 remark 拆成列表项，而作者把 `* ` 当普通文字，canonical 序列化时转义为 `\*`）时，两条可见流从分叉点永久不同。此时 `preserveLocallyAlignedTextChange`（上下文可见字符不一致）与 `preserveChangedLineRegion`（全文可见行不一致）都会失败。**fail-closed 返回原源码 = 富文本删除被静默撤销、保存后复活**——这是用户反复遇到「富文本删了内容切源码还在」的根因族。兜底 `preserveDivergedBlockTextChange()`（`lib/markdown-preservation/regions.js`）满足以下全部条件才替换：
1. 变更限定在**单个 canonical 块**内（空行分界，跨块/整块删除放弃）；
2. canonical 块文本**反转义**（`\*`→`*`、`&#x20;`→空格、命名实体）后在源码中**恰好出现一次**（重复文本绝不猜测）；
3. 替换文本不得含独立 `<br />` 占位。
任何约束不满足仍返回原源码。回归：`npm run test:diverged-delete-source-ui` + 纯函数 `test:markdown-preservation`。

**文档位置记忆（#111）**：每个文档路径独立持久化 `{offset, len, scrollTop}`（`localStorage["horsemd.docpos.v1"]`，上限 300 条）。`hooks/useDocPositions.js` 在切换标签、窗口关闭/刷新时批量捕获所有已挂载文档位置（富文本 `markdownOffsetFromSelection` 优先、视口顶部兜底；textarea 用 `selectionStart`）。打开文件时（`useFileOps`）**必须校验 `len === content.length` 才挂载恢复参数**——外部改过文件（长度变化）绝不套用旧偏移。富文本恢复用 `restoreMarkdownOffset(offset, false)`（不抢焦点）+ 同步设 `scrollTop`（**不要用 `requestAnimationFrame`**，后台窗口会被节流）；textarea 用 `setSelectionRange` + `scrollTop`。回归：`npm run test:doc-position-restore-ui`。

**原生 HTML 表格自适应**：`.hm-html-block` 必须重置 `white-space: normal`（ProseMirror 根的 `break-spaces` 会继承进来并阻止 CJK 按字断行）；表格 `max-width: 100%`；带 `width` 属性的表格 `width: unset` 恢复作者语义（`100%` 跟随容器、固定像素收缩）；`td/th` 的 `min-width: 0` 允许列收缩；**表格内图片必须 `width: 100%`**（否则 `<img width="900">` 的固有宽度参与列 min-content 计算，表格拒绝收缩，`max-width: 100%` 只约束渲染宽度救不了布局）。GFM（Markdown）表格保持独立横向滚动不受影响。回归：`npm run test:table-ui`（断言已更新为 HTML 表格贴合正文宽度）。

### 5.2d 源码权威内核（kernel-mode，实验，默认关闭）

标签页级实验开关（状态栏源码按钮旁 ▾ 菜单，不持久化，仅当次会话）。让 Markdown 源码本身成为编辑权威，而不是富文本回写源码。模块：`editor-kernel-mode.js`（控制器）+ `editor-kernel-gateway.js`（事务分类/提交）+ `editor-kernel-reconciler.js`（提交后投影校验）+ `editor-kernel-composition.js`（IME 挂起）+ `editor-kernel-projection-map.js`（raw offset ↔ PM 位置）+ `editor-kernel-cm-bridge.js`（CodeMirror 内每块动态读写门 + 撤销桥 + `Mod-Enter` 退出）+ `src/renderer/src/lib/source-kernel/`（纯内核，含 `code-map.js`/`mark-map.js`/**`table-map.js`**/**`highlight-syntax.js`**/**`inline-html.js`** 与 `commands/`：`code-language.js`/`code-exit.js`/`mark-toggle.js`/`quote-toggle.js`/**`image-attrs.js`**/**`link-toggle.js`**）。两条 fail-closed 出口：(1) 无法归属的事务批经 `editor-source-transactions.js` 返回 `{veto:true}`，PM 视图完全不变（不调用 `updateState()`）；(2) 初始投影图构建失败则整个标签页降级为完整 legacy 行为（`attachLegacyApi()` 捕获的原始 API 实现接管，`kernel.doc.text` 冻结）。**第三条更细的出口（计划五 Task 2.5 起）**：单个块证明不了时只把**该块**的 `charMap` 置 null（只读叶），提示 `kernelMode.blockReadOnly`，文档其余部分照常编辑——不再整篇拖垮；其安全性由 `blockEndpointsAgree()` 的逐配对首/末字符交叉校验兜底（残留形态由 `test-kernel-projection-map.mjs` Case P7b 诚实钉住）。诊断走 `globalThis.__hmKernelDiagnostics`（≤100 条结构化元数据，无正文）。

当前覆盖：段落/标题文字编辑（含计划三修正的段首 `Enter` 上方插空行、块尾连续 `Enter` 每次新增一行空白语义）、列表族/任务勾选/IME/撤销，以及（计划三，代码块域）**围栏代码块**的正文编辑（文字/换行/删除，含引用与列表嵌套前缀；**CRLF 与单独 `\r` 行尾同样可编辑**，2026-08-17 解除收窄）、代码块语言切换、`Mod-Enter` 退出代码块（对 mermaid/LaTeX 等只读块同样有效，退出命令本身不碰块内容）、CM 焦点下的撤销/重做（路由到内核历史，不让 CM 自带栈或 prosemirror-history 生效），以及（**计划四，2026-08-16，行内 marks + 引用域**）加粗/斜体/删除线/行内代码的施加与撤销（工具栏、右键菜单、快捷键三条路径一致——新模块 `lib/source-kernel/mark-map.js` + `commands/mark-toggle.js` + gateway 的 `extractMarkToggle` 分类 + `requireMap` 守卫；含多字符行内代码/高亮的文档挂载不再降级）、加粗等标记文字之后段落内其余位置的普通打字（gateway `textblockProfile` 的 gap-aware 放宽）、引用/取消引用（新模块 `commands/quote-toggle.js` 的 `toggleBlockquote`，入口是右键块菜单，段落/标题/列表整块/松散列表均可用，非内核模式同一菜单项行为一致）。

**（计划五，2026-08-17，阶段 3 语法域）新增**——组织原则是**先治降级、再扩编辑**（数学/行内 HTML/高亮三类形状此前让**整篇**文档拒绝建图，属于"整个标签页降级回 legacy"而非"该域不可编辑"）：含行内 `$x$` 与多行 `$$…$$` 的文档正常挂载（内核链加 `remark-math`，inline math 是 width-1 atom；block math 当时仍只读，2026-08-18 起可编辑，见下方 5.2g）；含 `<span>…</span>` 等行内 HTML 片段的文档正常挂载（`lib/source-kernel/inline-html.js` 是编辑器链与内核链**共享的同一份**合并规则——编辑器侧 `remarkMergeInlineHtml` 合成的节点无 position，不得进内核链；片段本身是原子，片段外的位置可编辑、Enter/Backspace 可用）；`==黄色高亮==` 段落可映射可编辑且工具栏黄色按钮解封（`lib/source-kernel/highlight-syntax.js`，**ADR：不是 micromark 扩展**——实测编辑器根本不在 parse 期识别 `==`，而是在 parse 完成后对 mdast text 节点的**解码值**跑正则，一致性由 `test-source-kernel-highlight-consistency.mjs` 的 55 形状 + 4000 份随机对抗文档逐字节锁死）；**表格单元格文字可编辑**（`lib/source-kernel/table-map.js`：PM 4 层 ↔ mdast 3 层在表内单独 zip，主 zip 里整表仍占一槽；分隔行在 mdast 里无节点、只作证据推出、绝不写入；`Tab`/`Shift-Tab` 明确路由到 `goToNextCell`，零字节写入）；图片 `alt`/`src`/`title` 的源码改写命令就绪（`commands/image-attrs.js`，**但目前没有 UI 派发 alt/title**，用户可达的只有"源码里已有 `![]()` 时填入 src"这一条）；链接的 wrap/改 URL/移除全部走源码事务（`commands/link-toggle.js` + gateway 新分类 `link-edit`，识别 LinkTooltip 在**一个 tr** 里派发的 `removeMark`+`addMark`(+`insertText`) 混合形态——正是 `extractMarkToggle` 明确拒绝的形状，故单独分流）。

**残留限制分两种机制，不得混为一谈**（影响范围完全不同）：

**(A) 整图 null → 整个标签页降级回 legacy**（`attach-unmappable`，`attachLegacyApi()` 的原始 API 全面接管）。成因永远是**块序配对失败**（块数/类型不匹配），这仍是全局 fail-closed，Task 2.5 的单块降级没有也不应放宽它。**三种形状**：(1) 独占一行的 `$$x$$`（编辑器链 parse 前跑 `normalizeDisplayMath` 改写成三行，内核**刻意**持有原始字节 → `code_block` vs `paragraph`，类型失配）；(2) 列表项内的块级数学或**任意**代码围栏（PM 的 `list_item` content model 经 `createAndFill` 插入填充 paragraph → 4 个 PM 节点 vs 3 个 mdast，块数失配，**与数学无关**）；(3) 相邻的根级 `<div>` 兄弟（编辑器链跨空行合并、内核不合并 → 1 vs 2）。钉子：`test-source-kernel-index.mjs` 独立小节、`test-kernel-projection-map.mjs` Case M6、Case H9（H10 是对照的成功形状）。**曾经的第四种形状 YAML frontmatter 已在计划六 Task 2 消除**：内核 unified 链补挂 `remark-frontmatter`（与编辑器链同一默认 `yaml` 预设，纯 micromark/mdast-util 扩展，不引入 transform，仍满足"只 parse 不 runSync"），`PM_TO_MD` 新增 `frontmatter: ['yaml']`。**只是不再降级，不承诺可编辑**：`frontmatter` 是 PM atom，`isTextblock` 为假 → `charMap: null`，与表格/块级数学/块级 HTML 同为只读叶；frontmatter 内部偏移在 `blockAt` 里也解析不到块（`yaml` 不在 `BLOCKS`），结构命令一律 fail-closed。文档中段真正的 `---` 分隔线不受影响（预设只在文首匹配，有负控钉住）。钉子：`test-source-kernel-index.mjs` frontmatter 小节 + `test-kernel-projection-map.mjs` F1–F5。

**超过 `CHUNK_THRESHOLD`（120 000 字符）的文档（计划六 Task 5）**：仍然照常尝试附着（两边解析恰好一致的大文档继续可用，且逐块证明一个不少），但一旦配对失败，提示改为专用文案 `kernelMode.unmappableChunked` 并在诊断里带 `chunked: true`——不再和普通"无法配对"混为一谈。根因：`appendChunks` 对每个 ~40 KB 分块**独立解析**后追加，内核整篇解析一次，两者在真实内容上确实不同（实测本仓库 docs/ 拼成的 262 KB 文档：整篇 1585 块 vs 分块 1572 块，首个分歧在第 647 块）。**计划的镜像方案 (d) 被明确拒绝**，理由不是偏移算术（`chunks.join('\n') === 原文` 与 `slice` 性质 LF/CRLF 都已复验并写进 headless 测试），而是：(1) `safeParse` / `verifyPlainTextProjection` / `reconcileProjection` 全部按**整篇**解析并据此修复视图，只镜像内核自己的解析会让第一次键入把视图对齐成整篇形态、下一次 `bindMap` 立刻失配 → 地图为 null、文档彻底不可写；(2) 分块边界是按**当前文本**重算的（"累计 40 000 字符后的第一个空行"），一次编辑挪动边界就会改变块序列而 PM 保持旧形态，映射会随打字在可用/不可用之间翻转——那是"编辑是局部的"这一断言，不是证明。

**降级现在可见（计划六 Task 3）**：控制器新增 `getKernelStatus()`（`off` / `pending` / `legacy` / `partial` / `normal`），`partial` 的计数用的**正是 `degradedPairAt` 的同一判据**（真实非虚拟 pair 且 `charMap` 为 null），所以状态栏与逐块 toast 不可能互相矛盾。纯展示规则在 `lib/kernel-status.js` 的 `describeKernelStatus`（无 JSX，可 headless 断言）：内核关闭/未附着返回 `null`（什么都不显示），**正常文档返回 `indicator: false`**——误报比沉默更糟，这条是负控，由 `scripts/test-kernel-status.mjs` 钉死。UI 复用既有状态栏内核下拉（caret 按钮上的小圆点 + 菜单里的一行说明 + hover 详情），不新增 UI 面、不打断写作；块级只读的即时反馈仍走既有 toast 通路。文案全部走 i18n（zh+en），测试逐条校验键在两种语言里各出现一次。

**(B) 配对成功、该块 charMap 置 null → 只读叶，文档其余部分照常编辑**（提示 `kernelMode.blockReadOnly`）。成因是**块内单元数与 PM 内容尺寸不符**，即 Task 2.5 通解覆盖的那一类：(1) 红/蓝高亮 `<mark class="hm-hl-…">`（它是行内 HTML：内核 1 个 atom vs PM 的 N 字符标记 run，N>1 → **该块**只读——钉在 projection-map Case P3c，并兼任 `test-kernel-mode-headless` Case 17 的"一个不可证块不拖垮整篇文档"钉子）；(2) 含 `<br>` 或转义 `\|` 的表格单元格 → **格级**降级，同表其余格照常可写；(3) 参差/无法证明的表格 → **表级**降级，表格以外的块照常可写。（曾有第 (4) 类——含**硬换行**的段落被 gateway `textblockProfile` 整段拒绝——已于 2026-08-18 由 `6560df5` 修复，见本段末尾。）**计划六 Task 1（2026-08-17）已放宽行内图片 / 行内公式 / 行内 HTML / 脚注引用**：这些段落现在可正常打字；Task 1b 进一步允许**整体删除/替换原子**（选中图片按 Backspace，或连同前后文字一起删），因为解析出的 raw 区间恰好是该原子自己的字节——PM 侧由 `stepRespectsAtoms` 证明范围不会只覆盖原子的一半，raw 侧由 `commitPlainText` 的 `rangeSplitsAtomUnit` 在写入前再证一次。仍被拒绝的是：部分覆盖原子的步骤（今天的原子都是 nodeSize 1，构造不出来，但守卫按通用区间写），以及**带 mark 的原子**（链接图片 `[![x](y)](url)`：`[` 与 `](url)` 不属于任何单元，`stepRespectsMarkedRuns` 只走 text 子节点看不见它，单删图片会留下孤立定界符）。**硬换行的整段拒绝已于 2026-08-18 解除**（`6560df5`）：历史原因是它的 raw 跨度止于行尾、下一行的续行前缀（缩进或 `> `）不属于任何 charMap 单元，紧随其后的插入点会落在空隙之前（`> a  \n> b` 处打字会把 `> ` 降级成正文）；现在 `character-map.js` 的 `hardBreakUnitEnd` 把续行前缀折进 break 自己的单元并逐字节证明（只允许折到下一兄弟节点的起始 offset，且跨过的每个字节都必须是续行前缀字符），单元因此在硬换行两侧连续铺满，含硬换行的段落可正常打字——钉在 `scripts/test-kernel-hardbreak-ui.mjs`、扩展后的 `test-kernel-gateway.mjs` 与 `test-source-kernel-charmap.mjs`。

**仍一律 veto（与降级无关的显式拒绝）**：mermaid/LaTeX 预览块与块级公式 `$$..$$` 的 `Mod-Enter` 退出与语言切换（块内容本身自 2026-08-18 起可正常打字编辑，见下方 5.2g——只有这两个操作各自被 `exitCodeBlock`/`changeCodeLanguage` 单独拒绝，因为 `$$` 定界符没有信息字符串可写、也没有围栏可续）、块级 HTML 编辑、表格的行列增删/对齐切换（建表不再拒绝——`/table` 自 5ffae3a 起经内核提交，见下方 5.2g）、图片 caption/ratio（PM 展示态；**已缩放的 image-block 在分类层与 commit 层双重拒绝**——该状态下 raw `alt` 槽装的是数字比例、`title` 槽装的是 caption）、CriticMarkup review markup、mark 内部续打字（"续加粗"手势）、斜杠菜单四项的**位置性**具名拒绝（`/image`、`/divider`、`/task`、`/text` **已于 2026-08-20 接通内核路由**，仅在插入位置给不了光标一个可证明的家时拒绝——见下方 5.2g「2026-08-20 斜杠菜单收官」段。`/quote` **已不在本清单**：本节旧版把它记为「永远不可用」——空引用块 `>` 重解析为零子节点的 blockquote、与 PM `block+` schema 块数失配、`requireMap` 必拒——该判断自 `123100f`（2026-08-19，fix(kernel): /quote had never once succeeded）起不再成立：投影图现在像空列表项一样为裸 `>` 合成 createAndFill 填充的空段落（虚拟可编辑 pair，锚在标记后的 raw offset），`/quote` 正常提交 `>` 字节、投影为 blockquote、光标落块内可直接打字（下一击键提交 `>正文`）；`scripts/test-kernel-quote-ui.mjs`（`test:kernel-quote-ui`，自 `b106f95` 起）钉的是**成功**场景。fail-closed 残留：`>  `（标记后两个空格，只有第一个属于标记）配对为只读，不把文字锚到会被段落剥掉的字节后面。右键菜单的「引用/取消引用」依旧两种模式可用，与斜杠入口互不依赖）、右键列表/块类型转换、给**裸 URL** 加高亮（`requireMap` 的 anchor 半边拒绝：autolink-literal 的无 position 回退使结果段落不可映射——写对字节再让用户面对一个打不了字的段落严格更糟）、在两类围栏里按 `Enter` 换行——(a) **当前文本不含 `\r`** 的 CRLF/单 `\r` 围栏（CRLF 文档里的单行或空代码块），(b) 行尾风格**混合**且首个内容行以 LF 结尾的围栏（`buildCodeMap` 的 `lineEnding` 只描述首行，桥却按块主导行尾拼写，二者不等即拒绝）；两类块的普通文字输入/删除均照常，且任何会**劈开 `\r\n` 对**的删除/插入范围一律拒绝（ADR 见下方链接）。（硬换行段落已不在此列：2026-08-18 起可正常打字，见上方 (B) 段末尾的修复说明。）

**已知诊断（字节正确的自愈，不是错误）**：含**表格**的文档首次内核提交必然产生一次 `projection-mismatch` + 修复（活文档的表格子树与新鲜解析在某属性上本就不等，用"把 `buildTableCellMaps` 恒返回 null"做过对照，改动前后同样出现）；图片 **alt** 提交必然再产生一次（`editor-image-markdown.js:40` 在 parse 时派生 `caption: title || alt`，活节点还带旧 caption）。`test-kernel-stage3-ui.mjs` 把预算精确钉成"首次 ≤1、alt 提交 **+1**、其余步骤 0"并断言修复真的发生——若日后让 alt 路径同时写 caption，这条线会失败并强制重新推导预算，而不是静默沿用。

测试：`npm run test:source-kernel`（纯内核，含 `code-map`/`markmap`/`quote`/**`inline-html`**/**`highlight-consistency`**/**`tablemap`** 用例）、`npm run test:kernel-headless`（gateway/reconciler/projection-map/composition 接线测试）、`npm run test:kernel-ui`（模式切换/IME/nodeview/代码块域/行内 marks+引用域/**阶段 3 综合**，**六个** CDP 回归）。深度记录见 `docs/superpowers/sdd/2026-08-15-source-kernel-integration/`（计划二）、`.superpowers/sdd/2026-08-16-source-kernel-codeblock-domain/`（计划三）、`.superpowers/sdd/2026-08-16-source-kernel-inline-marks/`（计划四）与 `.superpowers/sdd/2026-08-17-source-kernel-stage3/`（计划五）各任务报告，以及 `docs/transaction-source-sync-architecture.md` 对应小节。

### 5.2e ✅ 已修复（2026-08-17）：vendored CodeMirror↔ProseMirror 位置换算曾静默损坏 LEGACY 编辑器的 CRLF 代码块

计划三 Task 4 调查中发现，**与 kernel-mode 无关、独立存在、影响当前默认启用的 legacy 富文本编辑器**：vendored `@milkdown/components` 的 `CodeMirrorBlock` 节点视图直接用 CodeMirror 6 自己的内部位置计算 PM step 偏移，没有为 CRLF 做任何修正。CM6 按 `/\r\n?|\n/` 切分文档、`\r` 字节从不进入 CM 内部模型，所以 CM 内部位置比真实 PM 偏移少 N（N = 之前经过的 CRLF 换行数）：`forwardUpdate`（CM→PM）把字符写早 N 位、拆开 `\r\n` 对（实测单键入盘写出 `;\rX\n}`）、行合并 Backspace 只删 `\r` 留下裸 `\n`；`update(node)`（PM→CM）用 LF 串 diff CRLF 串，永远命中假 diff，插入文本里的 `\r\n` + 尾部孤立 `\r` 被 CM 切分成两个换行——每次 update 给 CM 视图长出一行幻影空行且永不收敛；`setSelection` 也未换算。

**修复（commit `1e8315f` fix(editor): correct CM position math for CRLF code blocks）**：新模块 `src/renderer/src/components/editor-codeblock-crlf.js`，沿用 `editor-codeblock-eager.js` 的 prototype 手术模式——按 `\r\n` 对索引建立双射位置映射（`cmToPm`/`pmToCm`），`forwardUpdate` 用编辑前文本映射 changeset A 区间（行合并因此删除完整 `\r\n` 对）、插入换行转成块主导行尾、编辑后选区用编辑后文本映射；`update()` 先把 PM 文本按 `/\r\n?/→'\n'` 归一化再 diff（坐标即 CM 坐标、幻影行消失、一次收敛）；`setSelection` 做 pmToCm 换算。文本不含 `\r` 时全部委托原实现（LF 文档零影响）。回归锁：`npm run test:codeblock-crlf-ui`（默认 legacy、RED 曾复现拆对+乱序损坏；已接入 `run-ui-regression` standalone）。**kernel-mode 的 CRLF fail-closed 收窄已于 2026-08-17 取消**：投影图的 `lineEnding` 门删除、gateway 改为「换行必须已按 `charMap.lineEnding` 拼写、只补 `linePrefix`、绝不重新拼写」（旧的 `split('\n')` 展开会把桥已写好的 `\r\n` 二次转换成孤立 `\r`）。同轮 review 另补 delete 侧证明：任何落在 `\r`（char 单位）与其后 `\n`（linebreak 单位）之间的 raw 边界一律拒绝（否则会留下孤立 `\r`、裸 `\n`，引用围栏还会吃掉下一行的 `> ` 前缀）。另记一个**与 CRLF 无关的既有缺陷（已于 2026-08-17 修复，见下方 5.2g）**：任何含标题的文档在内核模式下曾经**每次**提交都触发一次全文 `projection-mismatch` 修复并弹出"暂不支持"提示——Crepe 的标题插件给活动节点盖了 slug `attrs.id`，而内核对源码的纯 parse 产出 `id:""`，二者的 `AttrStep` 被网关当作不支持的结构操作 veto。现已把这类批次识别为纯视图态的 `heading-id` 分类直接放行，并让重新 parse 结果带着活文档现有的 id，故障已消失。见 `docs/transaction-source-sync-architecture.md` 的「CRLF 代码块 ADR」与 `.superpowers/kernel-crlf-unnarrow-report.md`。

**（原「遗留独立缺陷」已于 2026-08-17 修复，见 5.2f。注意该段原文把「round-trip 验收门」当作运行时闸门，这是错的——运行时闸门是 `editor-source-verification.js` 的 `verifySourceDocument`；`roundtrip.js` 自 247eee0 起已无生产调用方。详见 5.2f。）**完整证据链见 `.superpowers/codeblock-crlf-fix-report.md`；原调查见 `.superpowers/sdd/2026-08-16-source-kernel-codeblock-domain/task-4-report.md`「Fix-review round」。

### 5.2f ✅ 已修复（2026-08-17）：canonical-diff 保真管线的 CRLF 插入算术与测试预言机的行尾盲区

5.2e 调查中记录的「遗留独立缺陷」。Milkdown 的 canonical 永远是 LF，而作者源码可以是 CRLF；把 LF canonical 的偏移映射到 CRLF 源码时，**必须指向换行对开始的那个字节**。旧实现指向 `\n`（对的第二个字节），于是「插在这一行文本末尾」落进了 `\r` 和 `\n` 之间：

- `rawInsertionAtCanonicalLineEnd`（`lib/markdown-preservation/core.js`）用 `lineAt().end`（只按 `\n` 切分）当作行文本末尾，CRLF 下它就是 `\n` 的下标 → 产物 `para one.\rZ\n`，`preserved:true` 的**错误成功**。段落、标题、列表行、任务行、引用行、软换行行尾全部命中。
- `sourceVisibleIndex`（`mode-visible-map.js`）把围栏代码块内的换行当作**可见字符**并锚定在 `\n` 上；`sourceRawFromVisibleIndex` 的 backward 亲和又按「上一个可见字符 +1」算「其后位置」。CRLF 的换行是一个可见字符、两个字节，所以代码块内的行尾插入同样拆对、行尾删除会留下孤立 `\r`。现在换行锚定在 `\r`（字符开始处），`rawWidthAt()` 让「其后位置」跨过整对。
**闸门归属（务必读，前一版本记述有误）**：拦下这些错误产物的**运行时**闸门是 `components/editor-source-verification.js` 的 `verifySourceDocument` → `editor-durable-semantics.js` 的 `areDurablyEquivalent`——它用编辑器自己的解析器把候选字节重新解析成 **ProseMirror 文档**再比对，由 `commitCanonicalResult`/`flushMarkdown` 经 `selectVerifiedSource` 调用。拆对产生的 `\r` 会被解析成真实换行，PM 文档因此不等价 → 拒绝 → fail-closed 重建 → 全文行尾改写为 LF。

`lib/markdown-preservation/roundtrip.js` 的 `roundTripPreserved` **不是**这个闸门：自 247eee0（fix(editor): centralize verified source commits）起它在 `src/` 下已无任何生产调用方，现在的角色是**headless 测试预言机**；`roundtrip.js` 唯一的生产出口是 `markdownComparisonKey`，被 `core.js:391` 用作**单行**转义安全检查（那里的 `line` 已按 `\n` 切分，永远不含换行符）。因此本次对 `roundtrip.js` 增加的 `normalizeLineEndings`（比较键里把 `\r\n|\r` 归一为 `\n`）**对运行时行为零影响**——它的作用是让测试预言机与模块自己声明的契约（「CRLF 属于要保护的拼写」）一致，否则任何含软换行或代码块的 CRLF 文档在测试里都会被误判为语义不等（micromark 把原始字节抄进节点 `value`）。该归一化的不变量是「CR 字节即行尾」，副作用是作者用 `&#13;` 写出的字面 CR 也会被当成换行——这是可接受的：源码里的字面 CR 无法与行尾区分。拆对留下的孤立 `\r` 仍然改变文档结构，预言机依旧拒绝（已加锁）。

**影响面结论**：修复前的错误产物**全部**被运行时闸门拦下（headless 扫描 11 份文档 × 全部可见字符位置的增/删共 558 例，0 例「错误但被放行」），因此从未发生静默字节损坏；代价是 CRLF 文档**首次普通编辑**就会 fail-closed 回退全文 canonical，把结构性行尾整体改写成 LF。修复后同一扫描 558/558 字节正确，且与 LF 源码的结果仅差行尾拼写。

**回归锁**：`npm run test:markdown-preservation`（13 种 CRLF 行尾编辑形态，逐字节期望 + 预言机 + 「全文统一 CRLF」属性 + 「与 LF 结果仅差行尾」对照）、`npm run test:roundtrip-acceptance`（预言机层：CRLF 必须通过 / 拆对必须被拒）、`npm run test:codeblock-crlf-ui`（**端到端真实管线**：磁盘期望收紧为全文统一 CRLF，新增 stage E —— 对**首段**段落行尾的纯散文编辑，即 5.2e 记录的原始症状形态，并新增「不得出现裸 `\n`」属性断言）。stage E 必须落在**非末块**段落：文末最后一个块的行尾编辑由 `preserveDivergedTailBlockAppend` 接管，该路径一直是 CRLF 正确的，用尾段落做 stage E 在未修复的 mapper 上也会通过、锁不住任何东西（已实测验证：单独回退 `core.js` 时首段版本 RED、尾段版本 GREEN）。完整证据链见 `.superpowers/preservation-crlf-fix-report.md`。

**遗留未修形态（CRLF 专属、命名开放项）**：以下真实可达的 CRLF 增量仍返回 `preserved:true` 但候选字节**丢内容**，运行时闸门拒绝后照例整篇改写为 LF（内容不丢、行尾丢）。修复它们需要另立任务，不要当成「今天无害」：

| 形态 | `(source, previous, next)` | 错误产物 | LF 对照 |
|---|---|---|---|
| 引用块加一行（单行引用） | `('> q\r\n', '> q\n', '> q\n> r\n')` | `"> r\r\n"`（丢 `> q`） | LF 走 `exact-canonical-baseline`，正确 |
| 引用块加一行（两行引用） | `('> q\r\n> r\r\n', '> q\n> r\n', '> q\n> r\n> s\n')` | `"> q\r\n> s\r\n"`（丢 `> r`） | LF 走 `exact-canonical-baseline`，正确 |

根因同源但不同路径：CRLF 源码与 LF canonical 永远不字节相等，所以拿不到 `sourceMarkdown === previous` 的 `exact-canonical-baseline` 快捷路径，落到按可见位置映射的通用路径上被错误定位。另有一个**非 CRLF 专属**形态一并记录：列表项软换行 `('- alpha\r\n- beta\r\n', '* alpha\n* beta\n', '* alpha\\\n  cont\n* beta\n')` 会丢掉硬换行反斜杠，但 LF 源码产出同样形状、同样被拒，因此与行尾无关，属于独立的既有缺陷。

### 5.2g 源码权威内核：默认启用前置条件第一批 + 2026-08-18 收尾修复

**背景**：计划六（`docs/superpowers/plans/2026-08-17-source-kernel-default-on.md`）列出了"内核模式从实验开关转为默认"的已知前置条件——覆盖面、可观测性、性能、超阈值文档的诚实收口——并明确**不改变默认值本身**（本节记录的一切仍然是默认关闭的实验开关）。

**覆盖面（计划六 Task 1/1b）**：`editor-kernel-gateway.js` 的 `textblockProfile` 曾经只要文本块含任何非纯文本行内子节点（行内图片/公式/HTML 片段/脚注引用）就整段拒绝输入。现在改为 ALLOWLIST：`image`/`html`/`math_inline`/`footnote_reference` 四类被探针证实的原子节点两侧边界都能被 charMap 的三个解析器一致解出同一字节，因此可以**绕开原子打字**（`stepAvoidsAtoms` 守卫：任何与原子相交的非空区间仍拒绝，恰好落在原子内部的零宽插入也拒绝）；进一步允许**整体删除/替换一个原子**（选中图片按 `Backspace`，或连同前后文字一起删），因为解析出的 raw 区间恰好是原子自己的字节——但**部分覆盖原子**（今天的原子都是 nodeSize 1，理论构造不出来，守卫仍按通用区间写）与**带 mark 的原子**（链接图片 `[![x](y)](url)`：方括号定界符不属于任何 charMap 单元，单删图片会留下孤立定界符）仍拒绝。**硬换行当时是唯一刻意排除在这次放宽之外的原子**（raw 跨度止于行尾，下一行的续行前缀不属于任何单元，硬换行后打字会把 `> ` 降级成正文）——**该排除已于 2026-08-18 解除**：`6560df5` 的 `hardBreakUnitEnd`（`lib/source-kernel/character-map.js`）把续行前缀折进 break 自己的单元并加以证明，硬换行段落现在可正常打字（见 5.2d (B) 段末尾）。同一批（Task 2）内核 unified 链补挂 `remark-frontmatter`（与编辑器链同一默认 `yaml` 预设），带 YAML frontmatter 的文档不再因为块数/类型失配整篇降级；frontmatter 块本身作为 `isTextblock` 为假的 PM atom，`charMap` 仍是 null——**不降级不等于可编辑**，frontmatter 内容仍是只读叶。

**可观测性（计划六 Task 3）**：两种降级此前都是静默的——块级降级只表现为"这一块打不了字"，文档级降级表现为整页悄悄退回 legacy。控制器新增 `getKernelStatus()`（`off`/`pending`/`legacy`/`partial`/`normal`），状态栏内核指示区据此细分显示，`partial` 的计数复用 `degradedPairAt` 的同一判据，因此状态栏与逐块 toast 不会互相矛盾；`lib/kernel-status.js` 的 `describeKernelStatus` 对正常文档明确返回 `indicator: false`（误报比沉默更糟，是负控，测试钉死）。

**超阈值诚实收口（计划六 Task 5）**：超过 `CHUNK_THRESHOLD`（120 000 字符，`editor-chunked-parse.js:15`）的文档，`appendChunks` 对每个 ~40 KB 分块**独立解析**后追加，内核对整篇解析一次，两者在真实内容上确实可能不同（实测本仓库 docs/ 拼成的 262 KB 文档：整篇 1585 块 vs 分块 1572 块）——这不是 bug，是两种解析策略的固有差异。计划原本把"内核镜像同一套分块解析"（方案 (d)）列为首选，**该方案在实现阶段被明确拒绝**：偏移算术本身是精确的，但 `safeParse`/`verifyPlainTextProjection`/`reconcileProjection` 全部按整篇解析并据此修复视图，只镜像内核自己的解析会让第一次键入把视图对齐成整篇形态、下一次 `bindMap` 立刻失配、地图变 null、文档彻底不可写；而且分块边界按当前文本实时重算，一次编辑就可能移动边界，使映射在可用/不可用之间随打字翻转——"编辑是局部的"是一个假设，不是证明。最终采用的是方案 (c)：**依旧照常尝试附着**（两边解析恰好一致的大文档继续可用，逐块证明一个不少），一旦失败，提示改为专用文案 `kernelMode.unmappableChunked` 并在诊断里带 `chunked: true`——不再和普通"无法配对"混为一谈，但**120–400 KB 这个区间依然无法进入内核模式编辑**，只是现在会诚实地说明原因（ADR 见 `editor-kernel-mode.js` 中 `CHUNK_THRESHOLD` 相关注释）。

**性能（计划六 Task 4，5 项安全优化已全部落地，2026-08-21）**：`.superpowers/kernel-performance-assessment.md` 是 2026-08-17 的纯测量基线：真实 app 里单次按键在 100 KB 文档上阻塞主线程约 **450–530 ms**，成本主要是每次提交 2 次（结构操作 4–6 次）全文重新 parse + 全文字符映射重建。评估给出 5 项"不削弱任何证明"的安全优化与 1 项会用"编辑是局部的"假设替换证明的增量映射方案（**后者依然明确不做**——与本程序历史上多次字节保真事故同形）。**5 项安全优化现已全部落地**（分支 `perf/kernel-large-doc`，各自带 headless 行为钉 + 全量内核门禁）：① 内核模式跳过 `markdownUpdated` 序列化（`5d35a87`）；② `applyKernelTransaction` 复用刚证明过的投影图（`bindMap` 的 `pmDoc.eq(parsed)` 收养守卫，PERF-1 钉）；③ 内核 parse 按精确字符串做 LRU memo（`syntax-index.js`，index 与 raw 两个缓存**绝不共享**——`injectHighlightNodes` 变异树）；④ charMap 惰性按块构建（非空文本块的三重证明推迟到首次访问；`pairForContentPos`/`rawToPmPos` 用 content.size / mdast span 预过滤不强制物化；只读计数徽章的全图扫描挪到 150 ms 尾随防抖）；⑤ 健康路径 verify 解析 200 ms 防抖（**同步保留三处**：gateway `rewrote` 的改写型提交（治愈/种子消解/前缀）、占位符会话结束（且会话中**绝不**触发——Case PERF-3 的回归教训，UI 套件抓到）、rebind 失败时的修复路径；flush 读者强制先跑）。**A/B 实测**（同机同 100 KB 语料同方法）：单键同步阻塞 ~257 → **~130 ms**（−49%），12 键连发总阻塞 2.56 → 1.20 s，单任务峰值 261 → 139 ms；防抖任务（verify+状态扫描，~106 ms）在连发结束 200 ms 后空闲执行。**默认启用仍不够格**：130 ms 仍远超 16 ms 帧预算——只有增量映射方案能达标，而它以证明换速度；`CHUNK_THRESHOLD`（120 000 字符）以上仍无法 attach。

**2026-08-18 收尾修复（均已锁在对应 UI/headless 回归里）**：
- **空白自愈拼写**：段落/引用/列表项末尾、以及 ATX 标题内容开头，CommonMark 会剥离的空格/Tab 现在写成真实的 **U+00A0** 字符（而不是 `&nbsp;`/`&#x9;` 等 HTML 实体）——ASCII-only 的剥离规则不动它，因此它作为 charMap 里宽度 1 的 `char` 单元存活，可以逐列寻址和删除；空格写一个 U+00A0，Tab 写两个。块尾的这个字符会**自愈**：一旦它不再是块的最后一个字符（后面被打字续上），同一次编辑就把它改写回普通空格，因此已完成的句子里不会残留 U+00A0。**这是与 legacy 的一次刻意拼写分叉**：legacy 仍然写实体拼写，两者解码为同一字符，只是拼写不同——因为 legacy 计划被移除，不追认对齐。
- **标题 `id` 透传**：Milkdown 的 `syncHeadingIdPlugin` 会在每次文档变化后重新给标题生成锚点 slug 并派发 `setNodeMarkup`；这些是 `ReplaceAroundStep`，此前被内核网关当作不支持的结构操作整体拒绝——含任何非空标题的文档因此在内核模式下**每次按键都弹一次"暂不支持"提示**，即使用户的编辑本身已经正常落地和保存。现在网关把这类批次识别为纯视图态的 `heading-id` 分类直接放行（标题 id 不是 Markdown 字节，无字节可写），并让重新 parse 时带着活文档现有的 id 值（而不是永远得到空字符串），修复了每次提交都触发一次全文 `projection-mismatch` 修复的问题。
- **空围栏代码块吞字**：在恰好没有内容行的围栏代码块（如 ` ```js\n``` `）中输入的第一个字符此前会被写在**闭合围栏所在行的行首**，重新解析后把该字符之后的整个文档都吞进代码块的 `value`——打开自己的文件、敲一个字符、文档其余部分从视图里消失。现在这个首次输入被识别为"另起一个内容行"或"补全 `/code` 已经写好的那一空行"，写入前重新解析候选字节并证明结构不变。列表 marker 开出的围栏（前缀补全会误判成第二个列表项）和没有闭合围栏的块仍 fail-closed。
- **Mermaid/LaTeX 预览围栏与块级公式变为可编辑**：`READONLY_CODE_LANGUAGES`（曾经的 `{mermaid, latex}` 语言名单，命中即强制 `charMap: null`）已被**删除**而非收窄——它是一个策略性门槛，依据"预览态不是可编辑内容"这句半真话：真话的是预览面板，假话的是编辑面（vendored `CodeMirrorBlock` 无条件挂载 CodeMirror，`previewOnlyMode` 只是给宿主元素加一个 `hidden` CSS class，两侧的 PM 内容与 CM 内容和普通代码块结构完全相同）。同一批修复顺带让**块级公式 `$$..$$` 本身也变为可编辑文本**（此前的只读同样是过度依赖同一个已删除的语言门槛 + `changeCodeLanguage`/`exitCodeBlock` 都要求 `block.type === 'code'` 这一条件——但这两个操作各自已经在自己的命令层被拒绝，不需要把整个块的文字也搭上）；仍被拒绝的只有 `$$` 块内的 `Mod-Enter`（没有围栏可续写退出）与语言切换（没有信息字符串位置可写）。
- **斜杠菜单块类型/块插入域**（计划四之后新扩展的域，不属于计划六）：`/h1`–`/h6`、`/ul`（bullet）、`/ol`（ordered）现在把查询文字原子替换成对应的标记前缀，作为一次内核事务提交；`/table`、`/code`（含 `/js`/`/python`/`/mermaid` 等语言变体）、`/math` 现在把查询文字原子替换成新建的空块并把光标放在可以立刻打字的位置。`/mermaid` 是随 `READONLY_CODE_LANGUAGES` 删除自动解锁的（不需要单独接线）；`/math` 需要块级公式本身先变为可编辑才有意义（否则新建的块里没有可插入光标的位置）。`/image`、`/divider`、`/task`、`/text` 在该批次仍不路由（当时的理由：图片块和分隔线是没有文字位置的 PM 叶子，裸 `- [ ] ` 对 remark-gfm 不构成任务项，完全空的顶层段落没有 Markdown 字节可写）——**四项已于 2026-08-20 全部接通**，见下方「2026-08-20 斜杠菜单收官」段。`/quote` 不属于该批次，因为它**更早**（2026-08-19，`123100f`）就已修复并正常提交——本文旧版在此处写的「永远不会被解锁」与事实相反，勘误见上方 5.2d 该项的说明（UI 回归 `test:kernel-quote-ui` 自 `b106f95` 起钉成功场景）。
- **Mermaid 语言解析器损坏（与内核模式无关，legacy 同样受影响）**：`editor-crepe-setup.js` 里给 CodeMirror 用的 Mermaid 语法高亮定义写成了 `StreamLanguage.define(() => ({ token: () => null }))`——`define()` 期望的是语言定义对象本身而不是返回它的工厂函数，且一个从不推进流的 `token` 在 CodeMirror 里会在 10 次尝试后抛异常。这个异常从 vendored `CodeMirrorBlock` 的 `setSelection()` 内部逃逸，卡死了它的 `updating` 标志为 `true`，而 `forwardUpdate`（CM→PM 同步）一开始就检查这个标志并直接返回——从此该代码块的每一次按键都只停留在 CodeMirror 本地视图里，从未同步进 ProseMirror 文档，也就从未保存到磁盘，且没有任何提示。修复后是一个正常返回空 token 流的 stream parser。**此缺陷在内核模式接入之前就存在，legacy（默认）编辑器同样受影响**，不是内核相关的回归；已随上面的 mermaid/latex 可编辑修复一起验证。

**2026-08-20 斜杠菜单收官（`/task`、`/divider`、`/image`、`/text` + 尾部原子打字）**：斜杠菜单渲染的**每一项**现在都有内核路由。单一事实来源不变：`editor-crepe-setup.js` 的 `KERNEL_INSERT_ITEMS` 既是解锁表也是路由表，经内核自己的 `BLOCK_INSERT_TARGETS`（`lib/source-kernel/commands/block-insert.js`）过滤——没有命令的项自动保持禁用。逐项：

- **`/task`**：一次内核事务写入 `- [ ] ` + **U+00A0 种子**。这是"还没有正文的任务项"唯一可表示的拼写——实测每种纯 ASCII 拼写（`- [ ] `、双空格、Tab、`- [x] `、`* [ ] `）对 remark-gfm 都是 `checked: null` 的普通列表文字；`shapeAgrees` 要求重解析结果恰为一个 `checked === false` 的 bullet 项、唯一内容恰为该种子字节。光标落在种子之后。种子在会话台账里记为**第三种空白 provenance**（`ascii: ''`，"不代表任何按键"，`markdown-document.js` `acceptWhitespaceMarks`；空白自愈要求非空 `ascii`、消解要求恰为 `''`、无台账的 U+00A0 谁也不认领——三种 provenance 干净分片）。第一个正文字符落下时由 `commands/task-seed.js` 在**同一笔编辑**里删种子+插正文（`spellTaskSeedInsert`：`blockEditIsObservable` 复用 + 父级 `checked` 不变的额外证明，插入与首键之间的勾选也能存活）；作者自带（重开文件后台账为空）或空白自愈写下的 U+00A0 **永不被消解**。**与 legacy 的行为差（改进，教程已写明）**：插入后立即保存，磁盘上是真实 `checked:false` 任务、冷重开复选框仍在；legacy 在保存等耐久边界把空任务降级为 `- [ ]` 字面文字（`editor-api.js` `flushMarkdown` → `demoteEmptyTaskItemsInView`）。为此 legacy 的空任务**降级分支在内核模式被关闭**（`createTaskListInputPlugin({ kernelMode })`，`editor-task-list.js`——它的 lone-NBSP 迁移条款曾以 `appendTransaction` 骑在 projection 批上**绕过 gateway**，把字节完好的新复选框改写成 `[ ]` 字面文字；marker 转换不动，legacy 默认行为逐字节不变。分类器本身的这个洞——projection 批上的 appendTransaction 旁路——仍开放，见 §7 待办）。保存-未打正文-重开后种子成为作者字节，继续输入接在其后而非消解（fail-closed 方向，headless 钉住）。**位置性拒绝**：紧邻既有列表上/下方的段落里 `/task` 拒绝（空行只让 CommonMark 列表变松散、不结束它，插入的项会与既有列表合并，轴 (a)/(b) 拒绝自己没写的合并；补救=列表项尾 `Enter` 续项；双向 headless 钉住。**勘误（2026-08-21）：这条「补救」在写下时实际是坏的**——`splitListItem` 给任务项续项写的是裸 `- [ ] `，重解析降级为 `checked:null` + 字面 "[ ]" 文字、光标锚点无字符映射单元（`caret-unmappable:split-list-item`）、下一键落进**错误的项**（实测勾选/引用/嵌套/CRLF 各形态一致，仅"标签中间分裂"一格幸存）。2026-08-21 用户报告后修复：任务项分裂后**没有内容的那一侧**（项尾 Enter → 新项；标签起点 Enter → 原项，原项保留自己的勾选态）经候选重解析证明后写入**同一枚会话台账种子**（`ascii:''`，同一消解命令族，键盘/粘贴/IME 首字符同样消解；证明失败回退到旧字节，绝不新增拒绝）；勾选项的续项恒为 `[ ]` 未勾选；**会话内新建、从未输入正文的种子项上按 Enter 走 lift-out 退出列表**（与普通空项同一条 `exitEmptyListItem` 出口、同一 caret 平价缺陷；ledger-gated——重开文件后的 U+00A0 是作者字节，Enter 照常分裂、绝不删除，2026-08-20 审计钉仍成立）。钉：task-seed 套件 §6、headless Case I5g/I5h、`test:kernel-task-item-ui` Enter 段）；新种子上按 `Backspace` 拒绝（空任务不可表示）——**这堵墙在 2026-08-20 对抗审计前并不存在，是审计后补建的**：此前 `syntax-index.js` 用 `String.trim()` 计算列表项 `empty`（trim 会剥掉 U+00A0），种子项被误判为空项，Backspace/Enter 走 `exitEmptyListItem` **无声删掉整行**（零 toast + `caret-unmappable` 诊断 + 保存后落盘无该项）；即便绕过结构路由，字符级删除也会提交 `- [ ] `（重解析为 `checked:null` + 字面 "[ ]" 文字）。修复=（1）`empty` 改为 ASCII-only 判空（与解析器一致：U+00A0 是内容）；（2）新命令 `taskSeedDeleteRefusal`（`commands/task-seed.js`）：吃掉台账种子且段落归空的删除，经候选重解析证明项会降级后，以专用码 `empty-task-unrepresentable` 拒绝（有自己的 toast 文案，注明出口=撤销/输入正文/回车退出列表——第三个出口是 2026-08-21 任务项 Enter 修复新增的）；单步与多步删除批都过这堵墙；无台账/自愈 provenance 的 U+00A0、以及留有其它正文的删除一概不认领。四层钉死（task-seed 套件 §5、gateway TS6、headless Case I5b、UI 1b 步），每一层都在修复前 scratch 上以**行为断言**证明非空洞（UI 步失败形状=复选框在这一键上消失）。
- **`/divider`**：写 `---`（人类惯例拼写），唯一探明的例外是"文档首块 + 后文已有 `---` 行"的 frontmatter 形状（`'---\n\nabc\n\n---'` 被 remark-frontmatter 读成一个 `yaml[0,13)` 节点，轴 (a) 拒绝该拼写），此时回退 `***`（对每个 CommonMark parser 都是 thematicBreak、永远开不出 frontmatter）；两种拼写都跑完整两轴证明（image-attrs.js 的候选列表纪律，不是捷径）。
- **`/image`**：写 `![]()`——所有参照系一致同意的唯一拼写（muya 写同一字面量；CommonMark 无语法歧义；image-attrs.js 的分段器自己的文法）。重解析要求 paragraph 的唯一 inline 子节点是 url/alt 全空、无 title 的 `image` 且字节即整段——恰是 Crepe `remarkImageBlock` 转成 image-block 卡片的形状，卡片自带的上传/贴链接 UI 经既有内核路由 `image-attrs.js` 填 src。
- **`/divider` 与 `/image` 的光标**（`caretAfterInsert`，两者共享）：文档末尾 → 尾部虚拟对（提交前 `requireMap` 证明可解析）；下一根级块是段落/标题 → 其 `buildCharacterMap` 内容锚点（唯一子节点是 image 的"段落"除外——那正是 image-block 原子的形状，无内容位置）；其余形状 → 具名拒绝 **`no-caret-home-after-insert`**，i18n 文案给出补救（在文档末尾插入，或先在下方添加一行文字）。注意与 muya 的刻意分歧：`/image` 的光标**不**落进括号之间（Crepe 的卡片是原子，括号在富文本侧没有位置）。
- **`/text`**：**不写任何字节**——完全空的顶层段落没有 raw 表示，命令删除查询块及其后全部空白尾字节（纯后缀删除，签名相等证明：候选的完整解析 = 基线解析去掉查询块、偏移不动）。光标：剩余文档以列表/表格/围栏/原子结尾（或已空）→ 尾部虚拟对（`requireMap`）；以段落/标题结尾 → 控制器经既有 fail-closed split-placeholder 会话物化一个 VOUCHED 占位（无分隔前缀提交是字节正确的，因为命令**证明**保留字节以空行结尾）。文档中段 → 具名拒绝 **`text-needs-document-end`**，文案给出两条补救（删掉 /命令文字保留原块，或在文档末尾使用 /text）。
- **尾部原子打字（gateway，`f8dedc2`——上面两项的点击手势能成立的前提）**：文档以块级原子（hr / image-block）结尾时，点击原子使 `Selection.near(docEnd, -1)` 落成 NodeSelection（没有可退的文本块），随后打字是 prosemirror-view 的"替换原子"回退事务，此前被分类为 `blocked/unsupported-input-type`。新分类 `extractTrailingAtomTyping` + `routeTrailingAtomTyping`（`editor-kernel-gateway.js`）：PM 事务一律 veto（它删了用户没让删的原子字节），改为经尾部虚拟对提交 `prefix + text`——与光标在占位段落里打字**逐字节相同**（回归里断言），原子字节永不被碰，邻近形状（文档中段原子、原子后非空末段、node-selected 表格、多块 slice、带 mark 文本、前导空白）全部保持拒绝。**行为语义（有意的解释，非 PM 默认）**：内核模式下对文档**尾部**被 node-select 的原子打字＝"在其下方输入"；"替换"仍可用先删后打达成；文档**中段**的 node-selected 原子打字仍一律拒绝。
- 钉子：`test-source-kernel-blockinsert.mjs` 命令小节 10–12 + `test-source-kernel-task-seed.mjs`（`test:source-kernel`）、`test-kernel-mode-headless.mjs` Cases I5–I8 + `test-kernel-trailing-atom-typing.mjs`（`test:kernel-headless`）、UI 的 `test:kernel-task-item-ui`（含"尴尬时刻保存 + 冷重开仍是复选框"闭环）与 `test:kernel-leaf-insert-ui`（LF+CRLF，两条具名拒绝文案逐字断言 + 冷重开），均已入 `test:kernel-ui`；每个新测试都在修复前 scratch 构建上确认会失败。深度记录：`.superpowers/sdd/2026-08-17-source-kernel-default-on/` 的 `slash-completion-report.md`（机制核验与勘误）、`wf-task-item-report.md`、`wf-gateway-report.md`、`wf-leaf-items-report.md`、`peer-editor-research.md`（采纳与偏离已记录：`***` 回退是证明驱动而非同行惯例；gapcursor 按其自身"仅视图伴侣"结论保持未挂载）。

### 5.3 PDF 导出

- PDF 导出读取 `getPdfSource()` 生成的结构化 `{ html, headings, title }`，不是直接打印 live editor DOM。
- `getPdfSource()` 是异步快照 API；调用方必须 `await`。DOM 在异步 Mermaid 渲染前立即克隆，不能在等待期间重新读取 live editor。
- `getPdfSource()` 会把非 data URL 图片替换为唯一占位符，并附带图片清单。主进程 `pdf-images.js` 必须先把本地和网络图片暂存到 PDF 临时目录，再生成打印 HTML；不要让隔离的 `file://` 隐藏窗口按原 URL 二次加载。暂存失败才回退原地址并由真实加载结果决定是否警告。
- Markdown 图片相对路径只能解码并编码各一次。尤其要保护空格、中文、Windows 盘符和已写成 `%20` 的路径，禁止产生 `%2520`。
- 普通 CodeMirror 代码块导出为 `<pre><code>`。
- LaTeX 段落公式不能导出源码；要先把预览块物化为可打印 MathML。
- Mermaid 不能依赖 `.preview-panel` 当前是否挂载或可见；`editor-pdf-content.js` 必须主动通过 `renderMermaidForExport()` 生成并清理 SVG，再删除预览 DOM。语法错误或总截止时间耗尽时保留源码。
- 超宽行外 MathML 不得用比例缩小处理；PDF 临时文档中按顶层运算符拆成多行，编辑器内公式不变。
- PDF 预览是 latest-request-only；设置快速变化时旧任务必须取消。
- PDF 表格不能统一强制 `table-layout: fixed; width: 100%`。`editor-pdf-content.js` 在清理 DOM 前用可见表格实测总宽度和每列比例，紧凑表保留自然宽度，宽表才收敛至打印区域。`npm run test:pdf-table-layout-ui` 会同时检查 source `<colgroup>` 和最终 PDF 文字 X 坐标；只断言 HTML 存在表格不足以保护视觉一致性。
- PDF 表格单元格通常包含内层 `<p>`。必须保留 `.doc th > p, .doc td > p { margin: 0; padding: 0; line-height: inherit; }`，否则全局正文段落间距会把每一行撑高。表格回归同时检查最终 PDF 的纵向文字基线距离。
- 打印目录页和 PDF 书签大纲是两个独立功能。
- 隐藏窗口临时 HTML 禁止脚本执行，保留 Electron 默认 web security。

### 5.3b HTML、Pandoc 与 AI 基础

- HTML 与 PDF 共用异步结构化导出快照，但页面模板和设置独立。不要 clone live DOM，也不要把 PDF 打印 CSS 当网页 CSS。
- HTML 预览由主进程生成最终字节并返回 token；保存必须写 token 对应的同一份 HTML，不能在保存时重新生成。
- HTML 输出和预览必须保持无脚本：结构快照移除危险节点/属性，模板带严格 CSP，renderer iframe 使用无权限 sandbox。
- Pandoc 只接收当前聚焦标签的最新 Markdown。源码读取 live textarea，富文本先 `flushMarkdown()`；导出不得改变 dirty、光标或磁盘源文件。
- Pandoc 可执行路径必须通过绝对路径、文件名和 `--version` 验证；目标格式是白名单，参数由主进程构造，Markdown 走 stdin，`shell: false`，两分钟超时。
- `src/shared/ai-contracts.js` 与 `src/main/ai/` 是 Phase 0 基础，不代表 AI 已对用户开放。后续 Provider、密钥、网络和 UI 不能绕过 revision 校验与 ChangeProposal 直接写文档。
- 详细边界见 [document-export-architecture.md](./document-export-architecture.md)、[document-export-prd.md](./document-export-prd.md) 和 [ai-vmark-phase-plan.md](./ai-vmark-phase-plan.md)。

### 5.4 工作区和文件系统

- 工作区是单一、多根，不是多 workspace 切换系统。
- `useWorkspace.js` 管 roots 和 watcher，`useSidebarTree.js` 管树加载和展开。
- watcher 必须拒绝相对路径、系统根、受限目录。
- 已打开文件被外部程序保存时：干净标签可自动刷新；脏标签必须保留本地内容并只提示一次外部冲突，不能静默覆盖或连续弹窗。保存会覆盖外部版本，用户可另存为保留两份。
- 主进程网络调用用 Electron `net.fetch`，不要用 Node global `fetch`。
- 外部链接协议必须通过 allowlist。

### 5.5 设置、快捷键和平台

- 设置 tab 是 transient，不进 session restore。
- 偏好在 `localStorage["horsemd.settings.v1"]`。
- 快捷键配置在 `localStorage["horsemd.keybindings.v1"]`。
- Ctrl/Cmd 一般都要支持。
- 编辑器内的粗体、斜体、表格结构键、CodeMirror 结构键、输入法相关键不能随意开放改绑。
- 移动端没有桌面文件系统/PDF 能力时必须 gate UI，不要让按钮假可用。

### 5.6 云同步

- 详细产品和数据模型见 [cloud-sync-prd.md](./cloud-sync-prd.md)。当前仅桌面端开放手动同步；Capacitor shim 必须保持 `cloudSync: false`，直到 [移动端同步架构](./mobile-cloud-sync-architecture.md) 所需的原生安全凭据、文件 adapter 与网络桥接都完成真机验证。
- 普通多根工作区和云同步工作区不是一件事。`useWorkspace` 继续管理可见文件树与 watcher；`useSyncWorkspaces` 只管理用户明确开启同步的根目录，不能扫描磁盘寻找 `.horsemd`。
- 阅读 `docs/cloud-sync-v2-prd.md` 和 `docs/cloud-sync-v2-architecture.md` 后再改同步逻辑。`merge`、`push`、`pull` 是不同策略：远端 manifest 缺失或异常清空时，`merge` 必须返回 `remote-reset`，绝不能据此生成 `deleteLocal`。
- `push`/`pull` 是用户明确发起的恢复操作。方向化覆盖或删除前需归档目标端旧文件；普通双向冲突保留双方。不要把对象存储的目录扫描结果当成可信删除日志。
- 每个同步根目录只有 `.horsemd/workspace.json` 一个标记，应用数据目录另有私有 registry。标记和 registry 不得包含密码、Secret 或用户内容；`.horsemd` 永远不能作为普通内容上传或被 watcher 展示。
- 渲染层只使用窄 `window.api.sync*` 接口，不能直接调用网络；主进程网络一律使用 Electron `net.fetch`，凭据使用 `safeStorage`。
- `SyncEngine` 的 manifest 必须最后条件提交；上传、下载、删除必须校验预览时的 revision/hash。不要把冲突改成最后写入者胜出。
- WebDAV PUT 可能不带 ETag，Provider 会 `PROPFIND` 补取；S3 要使用维护中的 SigV4 实现，且必须保持工作区 prefix 隔离。更改 provider 后同时跑 mock、真实服务和双 profile Electron 测试。

## 6. 近期功能与坑位

### 0.13.x：代码块行号、HTML 表格自适应与文档位置记忆

- **编辑器代码块行号**：CodeMirror gutter 背景不透明（`--code-block-bg`）、行号列贴住代码块左边缘（`.cm-scroller` 左右 padding 移到 `.cm-content`）、行号字号 `1em` + `line-height: 1.6` 使行号元素与代码行等高、行号右侧 1px 分隔竖线。改 gutter 样式后跑 `npm run test:issue-80-ui`、`test:codeblock-scroll-stability-ui`、`test:issue-91-pdf-ui`。注意 `.cm-gutterElement` 高度异常问题：CodeMirror 默认 `height: 100%` 在 flex 下可能解析为 0，行号内容靠 `overflow: visible` 显示——测量行号用 `getBoundingClientRect` 前先确认元素本身。
- **PDF 导出代码块带行号**：`pdf-print-styles.js` 的 `.hm-code-line-num`；PDF 表格单元格单击直接编辑（`test:table-click-edit-ui`）。
- **原生 HTML 表格自适应**：见第 5.2c 节。`代码测试` 类 gov.cn 嵌套 `<table width="950">` 不再横向溢出；`html表格无法自适应.md` 是复现文件。
- **文档位置记忆（#111）**：见第 5.2c 节。已回复 issue #111 引导下载最新版。
- **已知遗留（已留底、待用户提供步骤）**：代码块围栏「吞正文」——见 `codeblock-fence-investigation.md`。排查结论：正常插入路径（斜杠菜单/真粘贴/输入规则/相同内容/多行/空块/Mermaid/中间插入/编辑内容）保存重开全部正常；用户现场文件 `代码测试.md` 显示两段代码无围栏且 `register()/import bpy` 粘连。在拿到精确复现前**不要盲改**。
- **相关边界（与 0.13.26–0.13.27 已修复路径分开）**：单/三反引号输入、部分/全部删除后保存暂停和源码锁死已修复；0.13.27 已验证 ``` + Space 可创建 fenced code block，空块一次 Backspace 后快速输入也安全。「已有结束围栏损坏后吞后文」仍按 `codeblock-fence-investigation.md` 独立跟踪，不能与正常输入规则混为一个问题。粘贴无围栏纯文本代码的行首缩进语义也属于独立路径。

### 自定义快捷键

已落地第一版：

- 统一命令注册表
- 设置页录制
- 冲突和保留键校验
- 菜单 accelerator 同步
- 命令面板 hint 同步
- 设置页阻断后台快捷键

重点文档：

- [custom-shortcuts-architecture.md](./custom-shortcuts-architecture.md)
- [custom-shortcuts-implementation-checklist.md](./custom-shortcuts-implementation-checklist.md)
- [custom-shortcuts-verification-report.md](./custom-shortcuts-verification-report.md)

### LaTeX

最近修过：

- `$$` / `/math` 块公式输入焦点不中断。
- 行内公式纯数字和中间补写能实时预览。
- 行内公式编辑框支持“清空”。
- 行内公式默认保护删除：第一次删除先选中，第二次删除才移除。
- PDF 导出中段落公式打印为渲染公式，不再打印源码。
- Crepe 的块公式位于 `.milkdown-code-block .preview` flex 容器。带 `\tag{...}` 的 KaTeX 公式必须保持 `flex-basis: 100%`，并给 `.katex-html` 的编号预留右侧空间；否则短公式会 shrink-to-fit，绝对定位编号会压到公式本体。用 `npm run test:tagged-display-math-ui` 保护这条布局合同。
- 块公式预览不能常驻 `overflow: auto`：Windows 会为即使未溢出的容器显示滚动箭头。`editor-katex-dom-prune.js` 根据实际 `scrollWidth` 标记 `data-hm-math-overflow`；仅标记为 `true` 的公式横向滚动，外层 `.preview` 不再形成第二个滚动面。用 `npm run test:display-math-scroll-ui` 同时保护短公式和长公式。
- 已渲染的块公式必须覆盖 Crepe 通用代码块的 `8px/20px` 内边距；只在 `.preview > .katex-display` 出现时压紧外层留白，不能影响普通代码块、公式源码编辑态、编号布局、横向溢出或 PDF。

### 选中文字工具栏

- 桌面端设置 `selectionToolbar` 默认开启；关闭时只以 CSS 隐藏现有 Crepe 工具栏，绝不因偏好变更重建已挂载的编辑器。
- 关闭后，富文本选区右键菜单必须以“文字格式”“审阅标记”“转换为”的悬停/焦点子菜单保持紧凑，提供粗体、斜体、删除线、行内代码、链接、高亮，以及完整审阅标记（新增、删除、替换、高亮 + 评论）；列表转换或块类型转换也必须继续保留。根菜单不能用 `overflow` 裁掉横向子菜单，靠近窗口右边时子菜单要向左展开。菜单打开时保存精确的 ProseMirror `anchor/head`，所有选区命令执行前恢复它，不能依赖浏览器在右键/菜单焦点切换后仍保留内部选区。
- 移动端仍只显示系统原生选中文字菜单。

相关文件：

- `src/renderer/src/components/editor-inline-math.js`
- `src/renderer/src/components/editor-math-preview.js`
- `src/renderer/src/components/editor-api.js`
- `src/main/pdf-print-styles.js`
- `scripts/test-pdf-latex-ui.mjs`

### PDF 导出

第一版已经具备浏览器式预览中心：

- A4/A3/Letter/自定义尺寸
- 横向/纵向
- 边距、8–24pt 正文字号、整体缩放
- 标题分页、目录页、PDF 书签
- 页眉页脚、日期、页码、页码范围
- 预览 buffer 与最终保存 buffer 一致

用户很在意 PDF 的真实预览和可配置项，不要退回简单保存对话框。
PDF 设置采用 latest-request-only，但进入 `printToPDF()` 后不能通过销毁隐藏窗口
来取消；必须等待当前打印自然结束并丢弃 stale 结果。详见
[pdf-preview-printing-race-report.md](./pdf-preview-printing-race-report.md)。

### 大纲

大纲支持折叠/展开，并默认保留前两层实际层级。近期修过：

- 父标题折叠时即使当前激活的是子标题，也要有反馈。
- 标题文字编辑后折叠状态不丢。
- 源码/富文本切换后目录层级不能跳。
- 桌面端拖动标题左侧抓手可重排**同一父级**下的章节，移动范围包含标题、后代标题和正文。必须调用 `outline-reorder.js` 的原始 Markdown 区段操作，不能取富文本 serializer 结果；不同父级或不同层级不允许落下，避免隐式重设层级。
- `FloatingOutline.jsx` 是纯渲染组件：默认只显示少量圆点，hover/focus 扩展标题列表，长标题以省略和原生 tooltip 处理。它必须复用 `useOutline.js` 的缓存 scrollspy，不能为了悬浮导航再注册 scroll listener 或逐帧读取全篇布局；移动端、无标题文档与侧栏“大纲”状态不显示。分屏时只跟随最后聚焦窗格。
- “折叠正文”不是当前大纲折叠的延伸。源码 textarea 无法隐藏局部行；富文本折叠须作为独立的、每 Tab 非持久 UI 状态设计，并先覆盖选区、查找、审阅、图片/代码块、模式切换和滚动锚点。

### 任务列表输入

近期改为 Typora 风格：

- 输入 `- [ ] ` 或 `- [x] ` 后直接转换任务列表。
- Enter 仍作兜底。

## 7. 测试策略

没有单一 `npm test`。按风险选择：

### 每次代码变更最低线

```bash
npm run build
git diff --check
```

### 共享 renderer / 设置 / 编辑器变更

```bash
npm run build:mobile
npm run test:core
```

### UI/编辑器/PDF/模式切换变更

```bash
npm run test:ui-regression
```

### 教程或用户文档变更

```bash
npm run guide:check
```

### 源码权威内核（kernel-mode）变更

```bash
npm run test:source-kernel      # 纯内核（13 个脚本，含 highlight-consistency / tablemap / inline-html）
npm run test:kernel-headless    # gateway / reconciler / projection-map / composition / mode / IME
npm run test:kernel-ui          # 六个 CDP 会话：mode · ime · nodeview · codeblock · marks · stage3
```

### 重点专项

```bash
npm run test:shortcuts
npm run test:settings-ui
npm run test:settings-layout-ui
npm run test:pdf-ui
npm run test:pdf-latex-ui
npm run test:math-ui        # 需要先以 scripts/fixtures/inline-math.md 启动 CDP app
npm run test:web-paste-ui
npm run test:table-ui
npm run test:lightbox-ui
npm run test:review-ui
npm run test:source-map
npm run test:markdown-preservation
npm run test:issue-77-ui
npm run test:paragraph-source-ui
npm run test:issue-79-ui
npm run test:outline-reorder
npm run test:issue-82-ui
npm run test:floating-outline-ui
npm run test:issue-98-ui
npm run test:clipboard-ipc-ui
npm run test:diverged-delete-source-ui   # 可见流分叉删除回退（0.13.9）
npm run test:doc-position-restore-ui     # 文档位置记忆 #111（0.13.13）
npm run test:step-source-mapper          # 逐键/Enter/退格重建源码（0.13.x 原型）
npm run test:full-doc-delete-source-ui   # 整文档清空不再复活（0.13.14，新增）
npm run test:mode-switch-caret-settle-ui # 模式切换光标不被重试覆盖（0.13.14，新增）
npm run test:leading-space-entity-ui     # 行首空格不再变 &#x20; 实体（0.13.14，新增）
npm run test:nested-number-list-source-ui # `- 1. …` 行内编辑不丢失（0.13.17，新增）
npm run test:diverged-partial-delete-ui   # 分歧文档整段删除不复活（0.13.18，新增）
```

`test:math-ui`、`test:pdf-ui` 等部分脚本连接已有 CDP session。单独跑时先按 fixture 启动，或参考 `scripts/run-ui-regression.mjs`。

**0.13.x 新增/变更的回归语义**：
- `test:table-ui` 已从「HTML 表格默认独立横向滚动」改为「原生 HTML 表格贴合正文宽度不溢出」（GFM 宽表仍可滚动）。
- 新增 `test:diverged-delete-source-ui`、`test:doc-position-restore-ui`；`test:markdown-preservation` 增加分叉删除/插入、重复文本拒绝、`\*`/`&#x20;` 反转义、`<br />` 拒绝等用例。
- `test:mode-switch-raw-offset-ui`、`test:empty-paragraph-caret-ui`、`test:source-fidelity-ui` 是模式切换/空段落/保真的高频回归，改动 `markdown-source-preservation.js` 或 `mode-*.js` 后必跑。

## 8. CDP 实战注意

- 启动 Electron 时要加 `--remote-debugging-port=9222` 或脚本指定的端口。
- 自动化优先使用 `launchBuiltElectron()`；它默认追加
  `--horsemd-test-background`，隐藏主窗口并避免获取 macOS 原生焦点。
- 多 tab / 分屏会有多个 `.ProseMirror`，必须用 `offsetParent` 找可见实例。
- 用真实 `Input.dispatchMouseEvent`；输入敏感路径通过
  `typeTextLikeUser()` 逐字符提交或使用 `Input.dispatchKeyEvent`，不要只改
  DOM selection，也不要一次注入整句来替代真人输入。
- `Runtime.evaluate` 取值在 `msg.result.result.value`。
- macOS 可能复用旧 app 进程；安装前必须 kill。
- 如果脚本连接了错误窗口，结果没有意义。用隔离 `--user-data-dir=/tmp/...`。

## 9. 网站与教程

### `guide/`

VitePress 用户教程站，当前有：

- 入门安装
- 界面、文件、工作区、分屏
- 格式、表格、图片、链接、公式、Mermaid、斜杠菜单
- 查找、大纲、审阅、快捷键
- 主题、字体、设置
- PDF 导出、富文本复制、移动端
- FAQ 和故障排查

用户可见功能变更必须更新对应 guide 页面。截图必须来自“重新构建并安装后的当前 app”，用隔离 profile，不能包含私人路径或旧 UI。

命令：

```bash
npm run guide:dev
npm run guide:check
npm run guide:capture
```

### `website/`

静态产品/下载官网。包含 `index.html`、`styles.css`、`app.js`、SEO 文件和截图资源。它和 `guide/` 是两套站点：

- 官网用于介绍和下载。
- 教程站用于详细图文使用说明。

官网部署时注意 `website/.env.local`、`.vercel/` 等本地配置不要误提交敏感信息。

## 10. 发布与包

- 版本号必须单调递增。不要在发过内部 `0.5.29` 后发布 `0.5.5`，自动更新会认为旧。
- 开始新功能前先升级测试包版本；不要等到功能完成才升级，确保用户每次手测的包都能从版本号辨识来源。
- GitHub release tag 用 `vX.X.X`，标题用 `HorseMD vX.X.X`。
- Release note 用中文，结构建议：
  - 新功能
  - 改进
  - 修复
  - 安装
  - 关联 issue / full changelog
- macOS 包在 macOS 构建，Windows 包在 Windows 构建，Linux `.deb` 在 Ubuntu runner 构建并 `dpkg-deb --info` 验证。
- Linux release 工作流可能需要手动 `gh release upload --clobber` 上传 `.deb`。
- `.omc` 和 `.playwright-mcp` 是本机/工具目录，不要提交。

## 11. 当前 Roadmap 判断

近期优先级：

1. 稳定核心编辑链路：保存、dirty、源码/富文本切换、查找、大纲、表格、PDF。
2. 继续补自动化测试，特别是用户真实反馈路径。
3. 完善 Windows/Linux 实机包验证。
4. AI Phase 0 的合同、上下文快照和变更提案纯逻辑已落地；下一步仍先做只读 Provider，不急着开放自动写入或 Agent 权限。
5. 插件市场难度高，先不急；优先可控的自定义快捷键、同步、AI provider 合同。
6. 源码优先 Live Preview 是远期独立架构项目，不能作为当前 Crepe 模式切换的小修；先维护已落地的原文保真层。
7. **代码块围栏「吞正文」**：已留底待用户提供复现（`codeblock-fence-investigation.md`）；拿到精确步骤后定位保存路径的围栏/换行丢失点。
8. **损坏围栏吞后文**：0.13.26 修复反引号删除导致的保存/源码锁死，0.13.27 验证 ``` + Space 创建代码块和空块 Backspace 快速退出；但既有文件的结束围栏已损坏后吞正文仍按 `codeblock-fence-investigation.md` 独立排查，不要退回到整篇 canonical 覆盖。

已在 Roadmap 中记录：

- 自定义快捷键第一版已落地，后续谨慎开放编辑器内部命令。
- AI 能力倾向原生体验 + provider 可插拔 + Review-first 修改；VMark 参考结论和具体分期见 [vmark-reference-review.md](./vmark-reference-review.md) 与 [ai-vmark-phase-plan.md](./ai-vmark-phase-plan.md)。
- 云同步桌面端手动闭环已完成当前阶段；自动同步、移动端同步、历史恢复、E2EE、插件市场属于后续阶段。
- 当前公开 Issue 的分流、前置条件和验收边界见 [ROADMAP.md](../ROADMAP.md#当前-issue-分流2026-07-21)。#62 已加 Windows 专属 compositor 降级，但仍必须 Windows 实机复现；#65 必须先定信息架构，#76/#23 都是原生平台项目；不要把它们当成可直接在 renderer 内完成的小修。
- 近期已回复的 issue：#111（文档位置记忆，已实现）、#107（源码+预览分屏，已实现）、#109（PDF 代码块行号/分隔竖线已实现，代码块背景可配置性待确认）、#91/#92 等历史 issue 已在发布时引导下载。回复后保持 open 等用户验收关闭。

## 12. 新 AI 开始任务前的检查清单

1. `git status --short`，确认是否有用户未提交改动。
2. 读当前用户最新一句话，不要执行旧上下文遗留目标。
3. 如果是 bug，先复现或定位现有测试是否覆盖。
4. 找相关模块和历史文档，不要猜。
5. 设计最小改动，避开敏感状态机。
6. 写或更新专项测试。
7. 跑合适验证矩阵。
8. 用户要手测时，安装当前最新 app，并明确验证运行路径。
9. 用户确认后再提交/推送/发 release/回 issue。

## 13. 常见高风险文件

- `src/renderer/src/App.jsx`：shell 状态、source/rich、PDF、session 接线。不要随意塞逻辑。
- `src/renderer/src/components/Editor.jsx`：Crepe 生命周期拥有者。新功能尽量拆到 `editor-*.js`。
- `src/renderer/src/hooks/useSourceModeSwitch.js`：源码/富文本状态机，非常敏感。
- `src/renderer/src/scrollAnchor.js` 和 `mode-*.js`：光标/视口锚点 facade 和实现。
- `src/renderer/src/markdown-source-preservation.js`：原文保真 façade（双快照 diff + 出口硬性 `<br />` 剥离 + 尾换行钳制）。`lib/markdown-preservation/` 下的 `core.js`（commonChange/lineAt/adapt）、`regions.js`（局部对齐/行区域/**分叉块回退**）、`lists.js`、`tables.js`、`paragraphs.js`、`frontmatter.js` 是它的纯函数分解。改这里必须跑 `test:markdown-preservation` + `test:source-fidelity-ui` + `test:mode-switch-raw-offset-ui`。
- `src/renderer/src/components/editor-source-map.js`：raw offset ↔ PM 映射，不能退化成关键词匹配。
- `src/renderer/src/components/editor-kernel-projection-map.js`：内核模式的块序配对 + 每块 charMap。文件头的 INVARIANT 注释枚举了**全部** 6 条允许的"PM 与 mdast 块数不等"来源；任何新的 remark/ProseMirror 插件若会在同一趟里**既删一个块又加一个块**（当前无人如此），就会打破"块数相同即对应相同"的前提，必须显式配对或不得进入解析链。计划五起单块证明失败只降级该块，`blockEndpointsAgree()` 是逐配对的第二道防线（Case P7b 钉住其残留）。改这里必须跑 `test:kernel-headless` + `test:kernel-ui`。
- `src/renderer/src/lib/source-kernel/`：纯内核（无 Electron/React/@milkdown import 是硬约定）。`character-map.js`/`code-map.js`/`table-map.js` 的**单元宽度契约**（每单元宽度 1、恰好消费一个字符）是整张投影图 `content.size === visibleLength` 恒等式的基础，改动会静默改变全局降级判定。`inline-html.js` 与 `highlight-syntax.js` 是**编辑器链与内核链共享**的规则定义——改任一侧都必须同时跑 `test-source-kernel-highlight-consistency.mjs`（两条链逐字节对照）。
- `src/renderer/src/components/editor-kernel-gateway.js`：事务分类是内核模式的唯一写入闸门。新分类必须 fail-closed（不认识就 `blocked`），且**不得只在分类层校验安全不变式**——`commitImageAttrs` 的"已缩放 image-block"判据初版就只在分类层，直接调用 commit 即 fail-open（计划五 Task 5 复审抓到）。
- `src/renderer/src/components/editor-api.js`：PDF source、对外 editor API、source/rich restore。
- `src/renderer/src/hooks/useDocPositions.js` + `lib/doc-positions.js`：文档位置记忆（#111），长度校验与防抖写盘边界。
- `src/main/pdf-export.js` / `pdf-document.js` / `pdf-print-styles.js`：PDF 预览、生成、打印样式。
- `src/main/filesystem.js` / `watchers.js` / `security.js`：本地文件和安全边界。
- `src/renderer/src/styles/app.css`：全局样式。改 UI 时查多个主题和移动端。
- 设置页排版预览是实际编辑器的缩尺模型。页宽不能直接套用低于真实预设的固定 `max-width`；测试必须测量可见宽度，不能只检查设置值和 CSS 变量。
- `.hm-html-block`（HTML 表格）与 `.cm-lineNumbers`（代码块行号）的 CSS 都在 `app.css`；改动后分别跑 `test:table-ui` 与 `test:issue-80-ui`/`test:issue-91-pdf-ui`。

## 14. 当前候选与最近一次人工否决

`0.13.51` 是当前架构候选：自动化已覆盖单一 verified commit、应用 parser、表格 source
ownership、独立 recovery、列表/表格/前导空格与 20/20 family matrix。`0.13.47` 则是
最近一次安装包人工否决：真实长会话曾复现 RS-41，富文本、源码和磁盘不一致。
**人工结果覆盖自动化结论；0.13.51 新安装包长会话经用户明确验收前，禁止发版、关闭
issue 或声称家族问题已解决。**接手者先读
`rich-source-divergence-incident-0.13.47.md`，抓取第一次分叉的统一 transaction trace，
不要继续从最终 toast 反推字符串补丁。

当前安装与验证仍须注意：`/Applications/HorseMD.app`
是否已替换必须在每次手测前重新核验，不能只看 `dist/` 产物。除 generated-scratch
首个 `-` 列表项 marker、连续空格中间态、`&#x20;`、空引用结构删除外，本轮新增
跨块“编辑 → 删除 → 再编辑 → 立即切源码”的事务边界回归，防止源码保留已删内容或
遗漏新增内容；列表项正文中新输入的 `1.` / `1)` / `-` / `+` / `*` 字面文本必须保留
阻止冷重开误解析为嵌套列表所必需的标准反斜杠，同时不能格式化未编辑列表；反引号
部分/全部删除后不得保存暂停或锁住源码模式。全新文档删除列表后重新输入 `1. ` 当前仍
可能规范化为 `1)`（现有 P2，非保存锁死根因），需要独立 input-intent 保真修复。
generated scratch 与空文件首次编辑中，同一行三反引号正文不得泄漏 serializer `\``；
完整现状见 `rich-source-fidelity-bug-family.md`、`list-item-literal-marker-escape-regression.md`、
`backtick-source-sync-lock-regression.md` 与 `leading-space-mode-switch-regression.md`。
0.13.29 新增桌面端外部文件/文件夹拖入：文件复用标签打开链路，目录加入多根工作区，
富文本正文图片仍由编辑器插入；实现与测试边界见 `desktop-drop-open.md`，专项命令为
`npm run test:drop-open-ui`。
0.13.46 候选继续修复了只在第二、第三、第四轮持久化后出现的根因：列表 input intent
在 marker 已恢复后仍残留，下一次正文回调会用旧槽重建列表；批量列表 mapper 还可能
只提交列表而丢掉同一 callback 的后续正文。现在意图只消费一次、结构事务必须完整提交，
CRLF/无末尾换行的块边界按字节处理。再次冷重开后，在已有正文与 fence 之间从空段
创建有序列表时，严格中间槽 mapper 会原子写回列表与退出后的正文，并立即消费 intent。
`test:family-multicycle-ui` 使用仓库内生成 fixture，在默认与 primary 两条路径连续执行
4 轮编辑/保存、5 次冷打开；真实 `123321.md` override 与 4×5 家族矩阵也已通过。
0.13.47 继续修复 `/code` 两阶段结构命令只删除临时 query、却没有原子写入 fence 的
RS-40。专项现在要求 40ms/350ms 两种菜单时序、完整且唯一 fence、冷重开后仍是
`.milkdown-code-block`，并在代码块创建后连续修改代码、后文和前文列表；真实
`123321.md` 临时副本与隔离安装包均通过。详见 `family-root-cause-matrix.md` 的根因 9–14
和 `slash-code-source-sync-regression.md`。

同日已重新执行 `rich-source-fidelity-bug-family.md` 与
`nested-list-sync-bug-handoff.md` 所列完整家族矩阵：纯函数映射、逐键段落/列表/反引号、
空段落/空引用、源码光标、保存重开、混合事务、长文档、源码+预览与四档 chaos
全部通过。期间发现 `test:paragraph-source-ui` 仍按旧“首字符自动激活行内代码”合同编写，
已改为真实闭合反引号触发；这是测试合同过时，不是产品数据流失败。
0.13.x 在 0.12.50 基线之上新增/更新的必测项：

```bash
npm run build
npm run build:mobile
npm run guide:check
npm run test:document-export
npm run test:document-export-ui
npm run test:ai-core
npm run test:ui-regression
node scripts/test-pdf-document.mjs
npm run test:pdf-latex-ui
npm run test:markdown-preservation
npm run test:family-multicycle-ui
npm run test:new-document-list-source-ui
npm run test:issue-77-ui
npm run test:paragraph-source-ui
npm run test:issue-79-ui
npm run test:outline-reorder
npm run test:issue-82-ui
npm run test:floating-outline-ui
npm run test:diverged-delete-source-ui
npm run test:mixed-rich-source-transaction-ui
npm run test:list-item-literal-marker-source-ui
npm run test:code-fence-delete-source-ui
npm run test:doc-position-restore-ui
npm run test:step-source-mapper
npm run test:source-fidelity-ui
npm run test:empty-paragraph-source-ui
npm run test:mode-switch-raw-offset-ui
npm run test:table-ui
npm run test:issue-91-pdf-ui
npm run test:drop-open-ui
```

`test:ui-regression` 全绿基线（7 sessions + 25 standalone）在 0.12.48 验证，0.12.5x–0.13.x 持续增量扩展。已知例外：`test:rich-source-chaos-ui` 第一子测试**基线即偶发**（点击坐标时序），单独跑可过，不代表回归。

如果后续出现“之前明明是好的”，先回到这个基线和最近提交 diff 对照。

### 真实 macOS 输入补充

疑难编辑问题除后台 CDP 回归外，可用 `CGEvent` 在前台 HorseMD 中逐键输入，并以截图、保存重开和按需 `pbpaste` 交叉核验；方法见 [macOS 真实输入测试方法](macos-real-input-testing.md)。英文原始键码与中文拼音组合输入需分别覆盖。
