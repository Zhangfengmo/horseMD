# 源码权威内核 · 计划六：默认启用前置条件 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 关闭"内核模式从实验开关转为默认"的全部已知前置条件——覆盖面（含行内原子的段落、frontmatter 文档）、可观测性（降级必须可见）、性能安全集（不削弱任何证明）、以及超过 `CHUNK_THRESHOLD` 的诚实收口。本计划**不**改变默认值本身：默认翻转是计划七的独立决定，需要真实文档试用数据。

**Architecture:** 三条互不耦合的线。(A) 覆盖面：`textblockProfile` 的原子放宽复用 P4-3.5 Fix B 已验证的"两道守卫"范式（准入放宽 + 逐步证明收紧），frontmatter 是内核 unified 链的插件补齐。(B) 可观测性：降级目前是静默的——块级降级只表现为"这一块打不了字"，文档级降级表现为"整个标签页退回 legacy"，用户无从分辨故障与设计。(C) 性能：只做 `.superpowers/kernel-performance-assessment.md` 判定为 **Safe** 的 1–5 号，**明确不做 6 号增量映射**（它用"编辑是局部的"这一断言替换"提交后映射来自对已提交字节的重新解析"这一证明，是本程序全部字节保真事故的同一形状）。

**Tech Stack:** 计划一至五全部模块 + 既有 CDP 基建 + `.superpowers/kernel-performance-assessment.md`（测量基线，实现者据其复现法自测）。

## Global Constraints

- 前序计划全部全局约束继续有效：fail-closed / 字节保真 / 禁哨兵 / 稳定错误码 / 非内核模式零行为改变 / 测试断言即权威 / 每任务只 add 自己的文件 / 干净树开工。
- **禁止为性能削弱任何证明。** 允许"少算一次得到相同结果的运算"（缓存纯函数、惰性化后仍在写入前跑完同样的证明），禁止"用断言替换证明"。任何一处改动若使某个 `charMap`/尺寸/端点校验在写入路径上**不再执行**，即为 Critical，无论测试是否通过。
- **缓存必须对纯度负责。** 任何 memo 都要证明：(a) 键唯一决定值；(b) 返回值的消费者不会就地修改它（内核链会注入 highlight 节点——若消费者 mutate 共享 mdast 树，即为 Critical）。每个新缓存都要有一个"消费者 mutate 后第二次取用仍正确"的测试。
- **降级不是错误，静默才是。** 块级降级（`charMap: null`）是计划五确立的正确姿态，本计划不改变其判定，只让它可见。
- 行内原子的 raw 语法跨度由既有 `charMap` 的 `kind: 'atom'` 宽度 1 单元表达（`editor-kernel-gateway.js:1150` 已核实：行内 image 的锚点是 `![alt](src)` 的 `!`）。放宽只允许"不与任何原子相交"的步骤，不新增任何原子内部编辑能力。
- 每个任务的事实以任务内探针为准，brief 给推导路径而非硬编码结论；与本文件描述冲突时，**探针胜**，并在报告中记录。

---

### Task 1: `textblockProfile` 原子放宽（覆盖面最大阻塞）

**Files:** Modify `src/renderer/src/components/editor-kernel-gateway.js`；扩展 `scripts/test-kernel-gateway.mjs`。

**Why:** 当前 `textblockProfile`（gateway:82）在任一行内子节点非 text 时返回 `null`，于是**含行内图片 / 硬换行 / 行内公式 / 行内 HTML 片段的整个段落完全不可输入**。真实散文里这类段落占比不低，是默认启用的最大覆盖面阻塞。

**Precedent（必须复用，不要另起炉灶）:** 同文件 P4-3.5 Fix B 已经为 mark 做过同构放宽——准入从"无 mark"放宽到"允许 mark"，同时加两道逐步守卫（`plainSliceText` 保证插入片本身是纯的；`stepRespectsMarkedRuns` 保证删除范围不与 marked run 部分重叠）。原子放宽是同一形状。

**Interfaces:** `textblockProfile(node) -> { hasMarkedRun, atomRanges } | null`——不再因原子返回 null，改为收集原子的 PM 区间；新增 `stepAvoidsAtoms(parent, blockContentStart, from, to)`：步骤范围与任一原子区间**相交即拒**（含 `from === to` 的插入落在原子内部；插入恰在原子边界的处理以 charmap 边界约定"前一单元的末端"为准，探针确认后钉住）。
- [ ] 探针先行：构造含行内 image / hardbreak / inline math / inline HTML 的段落，确认 PM 侧各自的节点形状（`isText === false` 的具体类型名）与 mdast/charMap 侧对应的 `atom` 单元；**hardbreak 单独判定**——它的 raw 跨度是行尾（`\` 或双空格 + 换行），与其余原子不同形，若不可证明则本任务保持拒绝并写入阻止矩阵。
- [ ] TDD：失败测试（原子前/后/两原子之间打字→接受且字节正确；跨原子的删除→拒绝；落在原子内部的插入→拒绝；原子紧邻边界的插入→按探针钉住的语义；与既有 mark 守卫叠加的段落；CRLF 文档）→ 实现 → PASS（`test:kernel-headless` + `test:source-kernel` 全绿）→ commit `feat(kernel-mode): type around inline atoms in mapped paragraphs`

### Task 2: frontmatter 文档不再整篇降级

**Files:** Modify `src/renderer/src/lib/source-kernel/syntax-index.js`；扩展 `scripts/test-source-kernel-index.mjs`。

**Why:** 内核 unified 链没有 `remark-frontmatter`，于是 YAML frontmatter 的 `---` 被解析成 thematic break / setext heading，与编辑器链的 frontmatter 节点结构不一致 → 块数/类型错配 → **整篇文档级降级**。frontmatter 在本应用是常用形态（用户指南自身就有）。
- [ ] 探针先行：确认编辑器链（`editor-crepe-setup.js`）挂载的 frontmatter 形态与节点名，以及 `Editor.jsx` 既有的 `handleFrontmatterValueChange` / `replaceMarkdownFrontmatterBlock` 通路在内核模式下的归属（frontmatter 值编辑走 legacy 专用通路还是应进 gateway——**本任务只保证不降级，不承诺 frontmatter 内容可编辑**；若探针显示其为 opaque leaf，则按 `OPAQUE_TYPES` 姿态配对并在阻止矩阵声明只读）。
- [ ] 两链一致性：`syntax-index.js` 顶部注释已声明"只 parse、不 runSync"——frontmatter 插件的挂载必须遵守同一约束（parse 侧扩展，不引入 transform）。
- [ ] TDD：失败测试（带 YAML frontmatter 的文档 → `buildProjectionMap` 返回非 null；正文块可编辑并字节正确；frontmatter 块按探针结论只读或可编；`---` 分隔线的真 thematic break 不被误判；CRLF）→ 实现 → PASS → commit `feat(source-kernel): pair frontmatter documents instead of degrading them`

### Task 3: 降级可观测（块级 + 文档级）

**Files:** Modify `editor-kernel-mode.js` / `StatusBar.jsx` / `i18n.jsx` / `styles/app.css`；Create `scripts/test-kernel-degradation-ui.mjs`（端口择空闲，注册进 `test:kernel-ui`）。

**Why:** 今天两种降级都静默：块级降级只表现为"这一块打不了字"（无提示，用户判为 bug）；文档级降级表现为整页退回 legacy（用户完全无感，却正是字节保真缺陷家族所在的模式）。默认启用前这必须可见——否则任何回归报告都无法归因。
- [ ] 设计约束：**不得**为可观测性引入新的 UI 面或打断写作流。首选状态栏既有内核指示区的状态细分（正常 / 部分块只读 / 已退回 legacy）+ hover 说明；块级只读的即时反馈复用既有 toast 通路（已存在，勿新建）。文案入 i18n（zh + en），不硬编码。
- [ ] TDD：UI 回归（含数学块的文档 → 状态栏示"部分只读"；在只读块输入 → toast 且源码字节零变化；超阈值文档 → 示"legacy"；正常文档 → 示正常且**无**误报——反空转正控必须断言正常态不出现降级提示）→ 实现 → 2 连稳 → commit `feat(kernel-mode): make source-kernel degradation observable`

### Task 4: 性能安全集（评估 1–5 号，零证明削弱）

**Files:** Modify `editor-kernel-mode.js` / `editor-kernel-projection-map.js` / `editor-kernel-gateway.js` / `Editor.jsx`；Create `scripts/test-kernel-perf-guard.mjs`（确定性上界断言，非计时基准——见下）。

**依据：** `.superpowers/kernel-performance-assessment.md` §9 表格。按其 Safe 判定实施 1–5 号，**6 号（增量投影映射）明确不做**（它把"提交后映射来自对已提交字节的重新解析"这一证明降级为"编辑被判定为局部"这一断言——与本程序全部字节事故同形；评估自身也要求它排在 1–5 之后并需钉死局部性谓词）。
- [ ] 1 号：内核模式下跳过 `markdownUpdated` 注册（评估测得约 40%——内核模式下该回调的产物无人消费，但**必须先证明无消费者**：审计 legacy 降级回退路径是否依赖它，若依赖则改为按需注册而非删除）。
- [ ] 2 号：`bindMap` 复用刚构建好的映射，消除同一事务内的重复构建。
- [ ] 3 号：`parseKernelMarkdown` 的 memo（注意：表格单元格的 before 侧 memo 已于 `ae6e759` 落地——本项是其推广；**按条目数与输入长度双重设限**，1 MB 文档的单棵 mdast 很大）。
- [ ] 4 号：惰性 / 按块字符映射——首次访问时构建，而非附着时为每块预建。**红线**：`degradedPairAt` / `editablePairForRange` / `virtualBlockAt` 等全图消费者不得因此强制物化全部；尺寸证明与端点证明必须仍在**任何字节写入之前**对被触及的块跑完。
- [ ] 5 号：`verifyPlainTextProjection` 去抖（它是事后修复而非闸门，无 fail-closed 否决依赖它）。**红线**：强制运行清单必须穷尽——保存 / flush / 模式切换 / 失焦 / 任何结构操作之前都要强制跑一次，否则投影错配可能到达磁盘。清单以测试逐项钉死。
- [ ] 测试形态：**不写计时断言**（CI 抖动会让它变成随机失败的噪音）。改为可确定性观测的**调用计数上界**——例如"一次普通键入至多触发 N 次 `parseKernelMarkdown`"、"附着 K 块的文档至多构建 M 次 charMap"。这类断言既锁住收益又不受机器性能影响。
- [ ] 每个子项独立 commit；每项落地后全跑 `test:source-kernel` + `test:kernel-headless` + `test:kernel-ui`，任一子项引发退化则单独回退该子项。收尾 commit `perf(kernel-mode): land the proof-preserving optimization set`

### Task 5: `CHUNK_THRESHOLD` 之上的诚实收口

**Files:** Modify `editor-kernel-mode.js` / `Editor.jsx`（以探针定位实际附着点）；扩展 Task 3 的 UI 回归。

**Why:** 超过 `CHUNK_THRESHOLD`（120 000，`editor-chunked-parse.js:15`）时内核**根本无法附着**，今天表现为静默退回 legacy。于是 120–400 KB 这一整段真实文档区间全部运行在有缺陷家族的模式里，且无人知晓。

**根因（已探明，勿重复探查）：** `appendChunks` 对**每个分块独立调用 `parseMarkdown`** 再 `insert` 到文档末尾（`editor-chunked-parse.js:70-79`），而内核对**整篇**源码解析一次。两者在 Markdown 语义上本就可能不同——最典型的是被空行分隔的列表：整篇解析得到一个 loose list，分块解析得到两个独立 list。块数不同 → 投影映射整体拒绝。这不是 bug，是两种解析策略的固有差异。

> **编者按（2026-08-18，事后更正，不改动本计划的历史记录）**：下面的“首选方案 (d)”**在实现阶段被否决**，改用本节自己列出的兜底方案 (c)——诚实拒绝并说明原因，而不是让内核镜像分块解析。否决理由记在 `editor-kernel-mode.js` 的 `CHUNK_THRESHOLD` 相关 ADR 注释里：偏移算术本身没问题，但 `safeParse`/`verifyPlainTextProjection`/`reconcileProjection` 全部按整篇解析并据此修复视图，只镜像内核自己的解析会导致第一次键入后视图被修复成整篇形态、下一次绑定立刻失配、地图变 null、文档彻底不可写；而且分块边界按当前文本实时重算，一次编辑就可能移动边界，使映射在可用/不可用之间随打字翻转——这是“编辑是局部的”这一假设，不是证明。当前真实状态：见 `docs/ai-handoff.md` §5.2g。
>
> **首选方案 (d)（历史记录，未采纳）：让内核镜像同一套分块。** 内核用**同样的 `splitMarkdown` 边界**逐块解析，再把每块 mdast 的 position 按该块的原文起始偏移平移后拼接。这样两侧的块序列**在构造上就一致**，正是本架构"两链一致"原则的直接应用。可行性已用探针在真实多分块文档（7 块 LF / 8 块 CRLF）上验证：

- `chunks.join('\n') === 原文`（逐字节，`splitMarkdown` 的行是 `md.split('\n')` 的切分，join 回去无损；CRLF 同样成立）；
- 每块起始偏移 = 前序各块 `length + 1` 的累加，实测 `doc.slice(off, off+chunk.length) === chunk` 对每一块成立。

即偏移平移是**精确算术**，不需要任何搜索或猜测。
- [ ] 实现 (d)；若探针推翻上述任一性质（以探针为准），则退到：(b) 追加结束后整篇重解析一次——注意慢的是 Milkdown 的 mdast→PM，内核自身的 remark 解析 400 KB 仅约 220 ms，故 (b) 的真实成本要实测而非假设；再退到 (c) 明确拒绝并给诚实说明。**(c) 是可接受的兜底**——诚实的拒绝优于静默的退回。所选方案与理由记入 ADR。
- [ ] 红线：分块镜像**不得**成为新的证明缺口——拼接后的块序列仍要走完全部既有配对与逐块证明，只是解析入口变了。若某块的边界处出现"整篇解析与分块解析不一致"的形状，按既有 per-block 降级处理，不得特判放行。
- [ ] TDD：阈值上下各一份文档（含空行分隔列表这一已知分歧形状、CRLF、分块边界恰在栅栏代码块附近）→ 附着成功且逐块字节可编辑；不可配对的块按降级只读且**用户可见**（接 Task 3 的状态指示）→ commit `fix(kernel-mode): stop silently falling back above the chunk threshold`

### Task 6: 卫生债（统一守卫族 / charMap 接口契约 / 去分叉）

**Files:** Modify `lib/source-kernel/*`（character-map.js / mark-map.js / code-map.js / table-map.js 等）；Create `scripts/test-source-kernel-charmap-conformance.mjs`。

**依据：** 计划五终审 ledger 的 OK-TO-DEFER 项。这些都不是当前缺陷，而是**下一个缺陷的温床**——本程序已经有过两次"同一语义两处实现，只修了一处"的事故。
- [ ] 统一 bisect 守卫族（`bisectsLineEnding` / `splitsCrlfPair` 及其同族）为单一实现 + 单一调用点，消除"谁包含谁"的推理负担（`ae6e759` 的复审已验证 `splitsCrlfPair ⊃ bisectsLineEnding`，据此合并是安全的）。
- [ ] 声明 charMap 的显式接口契约（`units` / `boundaries` / `visibleLength` / `lineEnding` 的不变量）+ 一致性测试，让 code-map / table-map / character-map 三个生产者对同一契约受检。
- [ ] 去分叉 `scanImage` / `scanLink`（`mark-map.js` 与 `link-toggle.js` 各持一份重叠节点集合——正是计划五终审发现跨任务不一致的那处）。
- [ ] 纯重构，行为零改变：以既有全套测试为回归网，**不得**在本任务顺手改行为；若重构暴露真 bug，单独 commit 修并在报告中显著标注。→ commit `refactor(source-kernel): unify the guard family and pin the charMap contract`

### Task 7: 收尾（阻止矩阵 / 文档 / 全门禁）

**Files:** `docs/` 阻止矩阵与内核文档、`CLAUDE.md`、`CHANGELOG.md`、`guide/`、`docs/ai-handoff.md`。
- [ ] 阻止矩阵更新：含行内原子的段落已可输入（Task 1 的精确边界，含 hardbreak 的实际结论）、frontmatter 文档不再整篇降级（含 frontmatter 内容本身是否可编）、超阈值文档的新行为。
- [ ] **诚实性复核**：本程序已发生过一次"文档宣称 `roundTripPreserved` 是运行时闸门，实则自 247eee0 起无生产调用者"的叙事失真。收尾必须逐条核对新写下的每个断言在代码里确有其事，尤其"已支持"类措辞。
- [ ] 默认启用**不在本计划**——收尾需明确写出：还缺什么才能翻默认（真实文档试用数据、性能是否可接受、降级率观测），交给计划七。
- [ ] 全门禁：`npm run build && npm run build:mobile && npm run test:core && npm run test:source-kernel && npm run test:kernel-headless && npm run test:kernel-ui && npm run guide:check` + legacy 代表项 → commit `docs: record the default-on preconditions and their status`

---

## Self-Review 记录

- **顺序理由**：覆盖面（1、2）先于性能（4）——性能优化会改动映射构建路径，若覆盖面随后再改会与之冲突；可观测性（3）排在性能之前，因为它是后续任何回归的归因手段，也是 Task 5 的用户可见出口。卫生债（6）排在功能之后，避免重构与行为改动交织。
- **明确不做**：增量投影映射（评估 6 号）。它是唯一能把键入压进 16 ms 帧预算的改动，也是唯一削弱证明的改动。真要做，应是独立计划 + 钉死的局部性谓词 + 保留 verify 作为安全网，且必须在 1–5 落地之后。本计划不夹带。
- **最大风险**：Task 4 的 4 号（惰性 charMap）与 5 号（verify 去抖）都在"少做工作"的方向上，正是证明最容易被悄悄绕过的形状。两项的红线已写进 brief，且要求以调用计数上界而非计时来锁——但审查时应把这两项当作 Critical 风险面重点验证：**写入路径上被触及块的证明是否仍然逐块跑完**。
- **未决**：Task 1 的 hardbreak、Task 2 的 frontmatter 内容可编性、Task 5 的三选一，均由任务内探针定夺——brief 给的是判定标准与兜底姿态，不是预设结论。
