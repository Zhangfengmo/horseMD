# 核心目标：完善整个项目，修复项目在使用新内核版本后存在渲染源码和富文本效果不一致的情况，包括内容移位，渲染效果丢失，tab键入或者空格组合保存失败，以及多种标识符 组合文本等导致 markdown 保存出现失败，主要就是源码映射富文本或者富文本映射源码效果有问题的情况

## 实现方案
1. 每个完成后就进行一个 checkpoint 打点标记
* [x] 完成基于架构的重新设计，现在已经基于新的源码映射实现了一套富文本和源码对照和转移规则，需要验证这套实现方案是否可行，如果不可行需要及时止血使用论证新方案，并基于新方案实现新的流程校验
      **判决：架构可行，不止血。** 实跑 197 份真实 markdown：`buildProjectionMap` 197/197 全部成功，**0 篇降级回 legacy**——「整篇降级 → legacy fail-closed → 保存暂停」这条最危险的路径在真实语料上一次都没触发。只读文本块 518/15365 = **3.4%**，其中 **95.6% 归于两个具体的字节记账 bug**（见 D2/D3），不是设计缺陷。
      测量脚本（可复跑）：`scripts/measure-kernel-census.mjs`、`measure-kernel-readonly-causes.mjs`、`measure-kernel-typing-lockup.mjs`
* [x] review 新的架构实现方案，提出反驳点，注意整个项目需要基于实际的代码，而不是居高临下脱离实际业务需求
      经对抗性证伪，且 效果 是**实跑**而非推理：
      **证伪掉的假设（2 条）**——(1)「200ms 防抖 verify 挪动光标造成内容移位」：71 次试验 0 次移动，`decorateTransaction` 的 `caretPos` 在所有可复现的延迟修复里都是 `null`，机制存在但打不到用户；(2)「打一个 markdown 字符会让块变只读」：992 次试验 0 次。
      **确认的缺陷（5 条）**——见下方 D1–D5，每条都有字节级实跑证据。
      **抓到的测试盲区**：`test:kernel-mark-inputrule-ui` 长期绿灯，但它的 fixture 是 `*斜*与**粗**与…`，每个标记都被中文夹着；换成 ASCII 立刻 FAIL。这是 fixture 单一化，不是产品曾经好过。
* [x] 迭代项目整个架构设计，实现方案符合我的核心需求后开始执行项目计划，基于 subagent
      7 个 subagent 分四阶段执行（Fix-A 四路并行 → D1 实现 → D5 实现 → 验证），每个修复**先写失败测试**再实现，铁律是「修复必须证明更多，不能假设更多」。
      **实测结果（我独立复跑确认，非 agent 转述）**：
      | 指标 | 修复前 | 修复后 |
      |---|---|---|
      | 只读文本块 | 517 / 15365（3.4%） | **25 / 15365（0.2%）** |
      | 完全干净的文档 | 147 / 197 | **178 / 197** |
      | 根因 B（表格转义） | 330 | **0** |
      | 根因 A（软换行折叠） | 165 | **3** |
      | 整篇降级 | 0 | **0** |
      | 打字锁块 | 0 / 992 | **0 / 992** |
      `CLAUDE.md` 56.5% → 3 块；三份价格清单 111 格 → 1 块。
      **回归**：`test:source-kernel` EXIT=0（28 脚本全绿，含此前被掩盖的 18 个）；`test:kernel-headless` 全绿；`test:kernel-ui` **58 套件 99 PASS / 0 FAIL**（含 44 步真实文档战役、200 KB 分块加载 LF+CRLF）。
      **顺带修掉一个长期红灯**：`test-source-kernel-statemachine` 自 `96518af` 起就红（不是 `1f2c5aa`——用未改动的 harness 跨版本 bisect 定的位），因处在 `&&` 链第 9 位而掩盖了后面 18 个脚本。根因是**两个已提交套件互相矛盾**：`indent.js:429` 把有序 marker 重编号钉为正确，statemachine 却禁止 outdent 改动行首前缀以外的字节。CommonMark 裁决：列表 `start` 取**首项**序号，后续序号是渲染惰性的（实测 `5. 甲\n2. 乙` → `start=5`）。真正缺的证明是「重写的 marker 必须落在非首项」——`provenIgnoredOrdinal` 补上，不可证则回退到纯缩进剥离。
* [x] 完成整个项目重构后 review 代码，并给出迭代实现意见，并基于意见二次 review 和二次订正。
      **一次 review**：四路对抗性 lens（证明完整性 / 编码边界 / 测试质量 / 代码契合度）→ 逐条证伪 → 排序成工单。判决是 **NOT SAFE TO MERGE**，抓到 4 条会让错字节进用户文件的缺陷，其中 3 条是**我这轮自己引入的**。
      **二次订正**（commit `f51f05f`）：
      - **B1/B2/B3 —— D5 修复自己开的三个口子**。D5 把空白结算放在 `publishesDurably({force:true})` 的发布边界，但三个真会落盘的调用方还留在旧路径：模式切换（保存后切源码把 NBSP 塞回 tab.content，干净 tab 变脏，再存就写进磁盘）、260ms 脏状态对账（保存后自己又把 tab 弄脏，无需用户操作）、scratch 会话持久化（重启后 NBSP 变成"作者写的"字符，永久）。三条都是**先复现再修**，且每条都在前一条修完后才浮现。
        B2 顺带查出一个更早的性能问题：**内核模式从不注册 `markdownUpdated`**，所以 `clearRichFlushPending()` 永远不跑，那个 260ms 定时器在每一次击键后都会触发。
      - **S1/S2 —— D3 的证明只接到三个调用点里的一个**。`highlight-syntax.js` 和 `review-markup.js` 从不传 `nextSibling`，ADR 里"两种换行不会再分道扬镳"当时是假话。现在都接上了，并加了一个**调用点普查测试**：以后任何调用方漏传第三个参数就编译不过。
      - **B4 —— 一个前提已经死了两天的证明**。详见下方「序号裁决」。
      - **仪表诚实性**：普查脚本原本自己重实现了它要测量的护栏，修完之后归因就错了（把 `<br>` 导致的只读记成转义）。现在改成**对着线上模块做消融实验**推导成因，并新增 `--assert` 模式 + 仓库内固定语料 + 阈值 + 非零退出——此前 `test:kernel-census` **不可能失败**，且只扫我这台机器的 `~/Downloads`。
      - **测试门禁**：四个新套件并不 gate 它们声称的东西——两个 D5 空白护栏互相打掩护（删掉任意一个套件照样绿）、一个对照组藏在 `if` 里自我跳过、一个 dialog 断言因为先 stub 了 `window.confirm` 而永远为真。
* [x] 完成以上内容后将任务提交到一个新的分支，注意是本地，并给出分支名称，并表明是重构版本
      **分支名：`refactor/kernel-projection-fidelity`**（本地，从 `fix/rich-source-sync-architecture` 切出，未推送）
      4 个提交：`e83f88a` 检查点1+2证据 → `2ca8ee3` D1–D5 修复 → `b6fe258` 检查点3 → `f51f05f` 二次订正

## 序号裁决（2026-08-26）

`96518af`（08-23 22:45）让 outdent 重编号；`68a0b38`（08-24 16:08）让编辑器**显示作者自己写的每项数字**。两者矛盾，**前提只成立了约 17 小时**，`2ca8ee3` 四天后重新审计时还把它写进了代码注释。

实测（真实 app 读 `::before` 渲染内容）：字节 `1. a / 5. b / 9. c` 显示为 **1、5、9**，而 ProseMirror 自己的自动编号是 1、2、3——所以没有兜底，装饰是屏幕上唯一权威，**改字节就是改显示**。

**裁决：保留重编号**（用户 2026-08-26）。理由反过来了——不重编号的话，用户按一下 Shift-Tab 列表当场显示成 `1, 2, 1`。行为零改动，改的是那个错误的理由：同一个 `i > 0` 检查保留，但它证的命题换成真的——**被改写项不是列表首项，所以它的数字永远不会变成列表的 `start`，任何外部渲染器里兄弟项的编号都不会动**，影响面锁死在用户动的那一项。
函数改名 `provenNonFirstOrdinal` 并导出：这个判据原本在仓库里有**三份拷贝**，fuzz oracle 是实现的逐字副本，所以永远抓不到自己错。现在 statemachine 的不变量拆成**两个独立半边**（结构性字节比对 + 共享的影响面证明），各自在自己的变异下被证明会失败，且各自对另一半的变异是盲的。注释里那句无法复核的「实测 8902 次 outdent」已删除——仓库里根本没有生成它的脚本。

## 最终验证

| | |
|---|---|
| `test:source-kernel` | EXIT=0（28 脚本） |
| `test:kernel-headless` | EXIT=0（30 PASS） |
| `test:kernel-ui` | **59 套件 / 100 PASS / 0 FAIL** |
| 普查（197 份真实文档） | 0 降级，只读文本块 **25 / 15415 = 0.2%**，178/197 完全干净 |
| `test:kernel-census --assert` | PASS（仓库内语料 + 阈值 + 非零退出） |
| ASCII 粗体探针 | **5/5** 逐字节落盘 |
| 块尾空格/Tab 落盘 | **0 个 NBSP** |

## 明确未修的遗留（不列进"已完成"）

1. **D6：段落末尾接着打字被吞**。`**bold**` / `*em*` / `~~del~~` / `[link]()` 结尾的段落，点到末尾再打字 → 击键被静默吞掉（`unsupported-input-type`）；`` `code` `` 和 `==high==` 正常。实测 **4/7 被吞**（`scripts/probe-trailing-mark-append.mjs`）。这是**先前就存在**的行为（CLAUDE.md 里"续加粗手势"一直列在 veto 清单），fail-closed 不丢字节，但"点到加粗词后面打字没反应"是个很常见的手势。**至少该给它一个具名拒绝码 + i18n 文案**，现在它连提示都没有。
2. **行首空格/Tab 仍写 U+00A0**。D5 只解决了块尾。行首是另一类账本，本轮未动。
3. **剩余 25 个只读块**：主要是**行内代码跨换行且在容器内**（`- a \`co\n  de\` b`）——和 D3 同一族，只是在 `inlineCodeUnits` 而非 `textUnits`。
4. **PDF/HTML 导出不带源码序号**（`editor-pdf-content.js:13` 剥掉 `.label-wrapper`），源码忠实序号是编辑器专属，此前无处记载，已补记进文档。

## 论证方案
1. [x] 基于 实际markdown 去测试实际渲染效果能否实现使用，达到交付级别，注意测试用例不能仅是单文本实现，而是需要测试到大文本且内含丰富标记符内容组合。
       语料 197 份，取自 `docs/`、`guide/`、`~/Downloads`（含 121 KB 超 `CHUNK_THRESHOLD` 文档、CRLF 文档、含 856 个前导 Tab 的 33 KB 文档、244 行 GFM 表格文档）。
2. [ ] 基于浏览器 Chrome 去构建测试，使用 web 端，并使用 Chrome service mcp 模拟浏览器点击和输入进行自主测试，而非简单交由人工测试
       可行性已实跑确认：`npm run build:mobile` 产出纯静态 web 包，真实 Chrome 里可挂载、可逐键输入、可存盘、可重开。**但发现 D4**：压缩构建下内核全哑。修完 D4 再建通道。
3. [x] 每次实现功能修改后的测试，如果有必要的话需要注意释放缓存防止内存大量占用。
       每个 CDP 会话独立 `profileDir` + `removeProfile: true`，跑前 `pkill -9 -f "node_modules/electron/dist"`。
4. [x] 注意如果需要测试用例，请从 download 文件夹下自取。

---

# 确认的缺陷（全部字节级实跑证据）

## D1 · 数据丢失 —— 英文 `**bold**` 吞掉收尾的 `*`
`scripts/probe-ascii-bold.mjs`（独立复现，非 subagent 转述）：
```
key 7 "*" -> "**bold*"
key 8 "*" -> "**bold*"        ← 第 8 键被拒，字节没落盘
disk : "**bold*"   DOM: <em>bold</em>    ← 应为 <strong>bold</strong>
诊断 : mark-input-rule-literal-fallback → projection-unmappable-refused (insert-text)
对照 : 与**粗**  5/5 键全落，0 拒绝   ✅
      *em*      4/4 全落  ✅        `code`  6/6 全落  ✅
```
英文写作者每次打粗体都中招。**影响：字节错 + 渲染错。**

## D2 · 只读面 63.7%（330 块）—— `lib/source-kernel/table-map.js:236`
```js
if (charMap.units.some((unit) => unit.kind === 'escape')) return null
```
拒绝单元格里**任何**转义。其自身注释写明作用域只是 `\|`，且「`textUnits` 今天就能正确映射这个形状（实测）」。`claude\-haiku\-4\.5` 这种 remark-stringify 日常输出把整格打成只读。实测 `灵影网关模型价格清单.md` 110/111。

## D3 · 只读面 31.9%（165 块）—— `lib/source-kernel/character-map.js` `textUnits`
```
'a b\n  `c` d' → NULL     'a b\n`c` d' → OK     'a b\n  c d' → OK
```
软换行续行前缀被 `consumeSoftBreak` **贪婪**吞掉，然后卡在 `next > end`（`end` 是 text 节点自己的结束偏移）。当续行有缩进/`> ` 前缀、且下一行以非 text 行内节点（inlineCode/strong/em/link/image/math/html）开头时，remark 把 text 节点断在行尾，前缀落进节点间隙 → 整块只读。
**硬换行孪生 bug 2026-08-18 已修**（`6560df5`，`hardBreakUnitEnd` 用「证明折叠」取代贪婪吞）；软换行侧从未跟上。`CLAUDE.md` 自身 52/92 因此只读。
模拟修复：**100/100 恢复可编辑，0 个仍需 fail-closed**——不放松任何证明标准。

## D4 · 生产地雷 —— 内核正确性依赖「renderer 永不压缩」
`editor-kernel-gateway.js:348` 用 `step?.constructor?.name !== 'ReplaceStep'` 判定步类型（该文件 5 处 + 一处 `'RemoveMarkStep'`）。esbuild 压缩后 `ReplaceStep` → `ki`，实测 web 构建里**每一次击键都被 veto，编辑器整个只读**，诊断 `{"code":"unsupported-input-type","shape":"ki[1,1]@heading..."}`。
桌面版今天安全，仅因 `electron-vite` 恰好不压缩 renderer。

## D5 · 空格/Tab 落盘为 U+00A0
`scripts/test-kernel-whitespace-disk-probe.mjs` 实跑：
```
段落末按 Space 后立即保存  -> disk "末段。<U+00A0>\n"
段落末按 Tab   后立即保存  -> disk "末段。<U+00A0><U+00A0>\n"
Tab×3                      -> disk "末段。\t\t<U+00A0><U+00A0>\n"   （账本有界，但最后一段仍是 NBSP）
```
`roundTrips: true`、无 dialog、无 toast——**保存是成功的**，用户看到的「保存失败」另有其因（refused 击键点亮 dirty，已于 `4e4d353` 修）。真正的问题是文件里多了用户没打的非 ASCII 字符，且全局 grep 确认**保存链路上不存在任何 heal**（账本仅当次会话有效）。

## 已证伪，不修
- 防抖 verify 挪动光标：0/71
- 打单个标记字符锁块：0/992
- `text-escape.js` 写入用户没打的反斜杠：17/17 用例 0 个多余反斜杠（含 `x = 1`、`4.5`、`a - b` 三个已知陷阱）

---

# 任务：全选删除（Ctrl/Cmd+A → Delete）在内核模式下无效

## 现状（已实跑复现）

`scripts/probe-select-all-delete.mjs`（8 KB / 60 KB / 200 KB 三档）+ 隔离对照：

| 场景 | 选中 | 结果 |
|---|---|---|
| 内核 · 小选区（对照） | 3 字 | **删除成功** |
| 内核 · 全选 | 31 字 | **失败** |
| legacy · 全选 | 31 字 | **删除成功** |
| 内核 · 全选（8 KB / 60 KB / 200 KB） | 全部 | **三档全失败** |

**结论修正**：这不是大文档问题。**128 字的文档同样失败**——触发条件是「跨块选区」，不是体积。用户在大文档上遇到只是因为大文档更容易全选。

**且完全静默**：0 条 diagnostic、0 个 dialog、0 个 toast。按 Delete 什么都不发生，也不告诉用户为什么。

## 根因（代码自述）

`editor-kernel-mode.js` 结构键路由的 `not-structural` 分支，注释原文：

> Backspace/Delete: ... THEN let PM produce the plain text-deletion transaction;
> handleTransactions' plain-text classification owns it
> (**a cross-block deletion classifies as blocked -> veto, still fail-closed**)

所以跨块删除是**设计上就 veto** 的 fail-closed 行为。它保证了不写坏字节，但把一个最日常的手势（全选重写）变成了死键，而且没有任何反馈。

## 方案

**不放松批量守卫**，而是给"整篇/跨块删除"补一个它缺的证明——这是本分支一贯的做法（证明更多，而不是假设更多）：

1. **可证明的跨块删除命令**。删除后的候选字节 = 选区前缀 + 选区后缀；用编辑器自己的 parser 重解析该候选，要求它与删除后的 PM 文档一致。一致即提交，不一致即具名拒绝。整篇清空是它的特例（候选为空字符串），legacy 早有 `document-emptied` 先例（0.13.14）。
2. **拒绝必须有名有声**。保留 fail-closed，但补一个具名 code + i18n（中英）+ toast，杜绝"按了没反应且没解释"。
3. **回环测试**：`test:kernel-select-all-delete-ui` —— Delete 与 Backspace 两条手势 × LF/CRLF × 三档体积（含 >CHUNK_THRESHOLD）× 全选清空与部分跨块删除，断言字节、存盘、冷重开，并断言 0 dialog。
4. **撤销**：清空后 Mod-Z 必须完整还原（整篇删除是单一历史组）。

## 执行中的第三次修正（实测推翻了前两次的框定）

前面两版都把它当成「删除」问题。实测证明**根本不是删除**：

| 场景 | 手势 | 结果 |
|---|---|---|
| 内核 | Cmd+A → 打字 `X` | DOM 10 → 10 **无变化** |
| 内核 | Cmd+A → Delete | DOM 10 → 10 **无变化** |
| legacy | Cmd+A → 打字 `X` | DOM 10 → **1**（替换成功） |
| 内核 | 小选区 → Delete | **删除成功** |

**准确表述：内核模式下，任何跨越全文选区的编辑都被静默拒绝——打字和删除一样。**
所以这不是删除命令缺证明，而是「全文选区的替换」这一整类事务过不去分类。

且**完全无痕**：0 diagnostic、0 toast、0 dialog。连 `describeUnclassified` 的
`unclassified-transaction` 都没有，说明它不是走到分类器才被拒的——更早就没了。

**尝试过并已回退的**：在 `commitPlainText` 里加 `clearWholeDocument`（纯删除、
整篇清空、走 `applySourceTransaction`）。没有生效，且我未能证明它被调用到。按
「三次失败就停下来质疑模型」的规矩已回退，不留投机性死代码。

**下一步该做的**（不是继续试第四次修法）：先定位这笔事务到底死在哪一层——
是结构键 handler 提前 `return true` 吞掉、是 `extractPlainTextSteps` 拒绝了
AllSelection 形状、还是 `classifyTransactions` 之前就没了。需要在 handler 入口和
`classifyTransactions` 入口各打一个探针；本轮的 view 句柄挂钩失败
（`ed.pmViewDesc.view` 取不到，生产构建下 `window.__horsemd` 被剥离），得换别的
拿 view 的办法。

## 二次 review 的两条修正

**修正一 —— 首个增量收窄到「整篇清空」，不做通用跨块删除。**
`proveBatchDelete({ doc, block, charMap, edits })` 只接受**单个** block 和它的
charMap，所以今天根本不存在跨块删除命令。通用跨块删除的面比想象大得多（部分选区
跨列表/表格/代码块边界，每种的前缀语义都不同），一次做完等于一大片欠证明的改动。
先只做**全选清空**（用户报的手势），通用跨块删除留作后续、带自己的证明。

**修正二 —— 清空的证明不能用朴素的 `.eq()`。**
`reparse("")` 是空文档，而全选删除后的 PM 至少有一个空段落，两者永远不相等。
仓库里已有专门机制——**vouched placeholder**（`spellEmptyListItemDelete` 的
`placeholder` 分支 + `emptiedBlock` 透传给 `bindMap`）。必须复用它，而不是新造一条
容差；新造容差正是这个仓库事故史的起点。

## 检查点

* [x] 复现（非体积相关：10 字文档同样失败；kernel 专属，legacy 正常；**非删除专属**，打字同样被拒）
* [ ] 定位根因到具体层（本轮三次尝试均未命中，已回退；需在 handler / classify 两处打探针）
* [x] 方案设计 + 二次 review（产出上述两条修正，首个增量已收窄）
* [ ] 实现可证明的跨块删除 + 具名拒绝
* [ ] 回环测试通过（Delete/Backspace × LF/CRLF × 三档 × 保存冷重开 × 撤销）
* [ ] 全量回归绿（source-kernel / kernel-headless / kernel-ui / 普查）
