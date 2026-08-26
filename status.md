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
* [ ] 迭代项目整个架构设计，实现方案符合我的核心需求后开始执行项目计划，基于 subagent
* [ ] 完成整个项目重构后 review 代码，并给出迭代实现意见，并基于意见二次 review 和二次订正。
* [ ] 完成以上内容后将任务提交到一个新的分支，注意是本地，并给出分支名称，并表明是重构版本
      分支已建：`refactor/kernel-projection-fidelity`（本地，从 `fix/rich-source-sync-architecture` 切出）

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
