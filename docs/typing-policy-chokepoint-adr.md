# ADR: 打字策略收敛到单一字节提交咽喉(typing-policy chokepoint)

日期:2026-08-24(2026-08-26 补记「源码忠实序号与 outdent 改号」,见文末)·
状态:**两阶段均已执行**(2026-08-24:策略函数落地、三调用点统一、快照 restructures 归零;同日晚 IME commitReplace 完成 step 级路由收编——commitResolvedTextSteps 出口,虚拟前缀/种子溶解/heal/转义只剩 gateway 核一份实现,intent `ime-commit` 保留撤销分组语义,IME 全套+通道等价+无头门禁复跑绿)· 起因:用户评审
「填鸭式修复——结合成熟案例思考实现与测试,而非臆想和频繁试错」。

## 问题(结构性,不是某个 bug)

一周内三次同形缺陷,`editor-kernel-mode.js` `commitReplace` 的注释自己就是
证据——「同命令、此路径也要」出现三次:

| 日期 | 策略 | 首次挂载点 | 漏掉的通道 |
| --- | --- | --- | --- |
| 2026-08-19 | 块尾空格 U+00A0 heal | gateway 单字符分支 | IME commitReplace |
| 2026-08-20 | 任务种子溶解 | gateway plain-text 分支 | IME commitReplace |
| 2026-08-24 | marker 转义(`4.`→`4\.`) | markerInputPlugin handleTextInput | IME commitReplace |

根因:**字节拼写策略实现在输入通道上**(keymap / handleTextInput / IME
commitReplace / 粘贴…各一份),而不是在所有通道共用的提交层。每个新策略都
要 N 份实现,漏一份就是一个用户可见洞,且只能靠用户撞出来。

## 成熟案例(事实核验过,非臆想)

- **ProseMirror-markdown / remark 系(Typora、Obsidian 同架构)**:模型优先,
  转义在**序列化器一个地方**统一决定;输入通道零策略。remark 的决策数据是
  `mdast-util-to-markdown/lib/unsafe.js`(本仓库已 vendored)——十三条带
  `atBreak/before/after` 正则的权威表,其中第 98 行
  `{atBreak, before:'\\d+', character:'.', after:'(?:[ \t\r\n]|$)'}`
  就是 `4.` 规则。我们手写的数字预筛只覆盖了这张表的两条。
- **测试**:这些项目用**普适往返性质**(parse(serialize(doc))==doc)在生成
  语料上扫,加 **composition/键盘等价测试**(CodeMirror/ProseMirror 的
  浏览器仿真 IME 用例),而不是逐手势复现钉。

本内核是源码优先(字节权威、字节最小编辑),不能照抄序列化器方案,但两条
教训逐字成立:**一个策略点;一条性质扫全域**。

## 裁决

1. **咽喉统一**:`commitPlainTextSteps`(editor-kernel-gateway.js)成为一切
   「插入纯文本」意图的唯一提交核。IME 的 `commitReplace` 改为合成 step 后
   路由进它(它已有多字符能力);heal / 种子溶解 / marker 转义三项咨询从各
   通道**迁入该核**,通道层删除自己的副本。迁移次序:先钉后迁——两台仪器
   (见下)先行,迁移期间任何行为漂移由它们当场报字节 diff。
2. **拼写决策换数据源**:废弃 bespoke 数字预筛,转义判定消费
   `mdast-util-to-markdown` 的 `unsafe` 表(character + before/after 正则,
   atBreak 语义 = 块内行首),命中才做候选重解析双证明(未转义必重构、转义
   后骨架全同)。表是 remark 序列化器自身的正确性来源,与解析器同源演化。
3. **策略目标态**(typing-policy 快照的收敛方向):unsafe 命中且证明通过 →
   转义拼写;证明不过 → 具名拒绝;其余 → 字面。快照清零 = 完成。
   例外拼写保持既有裁决:空格补全(标记是语法)、`#` run growth、列表
   marker 的 completing-space 家族——它们是「用户要结构」的显式手势,表
   之外单列。

## 仪器(已落地,先于重构)

- **`test:kernel-typing-policy-matrix`**(无头,入 `test:kernel-headless`):
  底座文档 × LF/CRLF × 块首/块尾 × unsafe 表全字母 + 对照组,经内核原语
  逐例提交并分类(text-preserved / restructures / refused);restructures
  集合快照化,**加宽即失败,收窄需显式重基线**。当前洞图 24 条、两族:
  `>` 在任意块首(18,下一个会咬人的洞,已提前捕获)与数字后 `.`/`)`
  (4,现行转义在控制器层,原语层如实暴露——咽喉统一后归零)。已知边界:
  底座暂无空块(unsafe 表的 after 空白正则使 `-`/`#` 等在非空块首不重构),
  空块底座是第一扩展点。
- **`test:kernel-channel-equivalence-ui`**(入 `test:kernel-ui`):同一组
  语义编辑(marker 转义、块尾空格 heal、对照 CJK)分别经 键盘 keyDown /
  insertText / IME composition 三通道执行,**存盘字节必须逐字相同**。任何
  未来只挂到一条通道的策略在此当场现形并点名通道。

## 执行记录(2026-08-24 第一阶段)

- `commands/text-escape.js` `escapePolicyForInsert`:unsafe 表 gate(含
  before/after/atBreak 语境匹配)+ 对照候选双重解析证明(参照系=同 offset
  插入惰性 'x' 的骨架——空块合法获得宿主段落;块级白名单签名——行内
  emphasis 形成不算重构,否则 `*斜*` 闭合星被误转义,mode-headless IR1 抓获)。
- **TRANSIENT_SINGLE 例外**(`- + * > # \` ~ _` 单字符):裁决内裸 marker
  中间态(completing-space/run-growth/demote 机器领地 + 行内开启符),永不
  转义——缺此例外时实测 `\*斜*` 级联毁掉整条 mark 线、`\-` 杀死打字建列表。
  sweep 单列 `transients` 钉(20 条),与 restructures 分开,双向变化都需
  显式重基线。
- 三调用点:`replaceVisibleText`(原语)、`commitPlainTextSteps`(gateway
  单步纯插入)、IME `commitReplace`(healInsert 整串)——同一个函数,零
  bespoke 副本;`spellMarkerEscapingDelimiter` 与 markerInputPlugin 的
  escape handler 删除。
- 快照:restructures **24 → 0**;transients 20(pinned)。
- 教训存档:kernel-mode 的多行 import 使单行字符串替换静默不匹配
  (escapePolicyForInsert 未导入 → commitReplace 吞 ReferenceError →
  composition 提交全灭,Case 10 抓获)——大文件接线后必跑无头门禁再进 UI。

## 第二阶段裁决(2026-08-24,三方评审综合)

三份独立评审(模型优先系逐行考据、源码优先系〔CM6/Obsidian/Vditor/Typora〕
架构考据、本仓库架构评审)一致结论:**架构成立,不换**。要点存档:

- 缺陷族有**两个发生器**:①策略住在通道上(真架构错误,已由咽喉统一关闭、
  双仪器钉死);②字节权威+即时投影的固有缝(CommonMark 给未完成输入赋予
  完整含义)。②不是字节权威的错——CM6/Obsidian 同为字节权威,它们的答案
  与我们收敛到的相同:**终局读法由用户下一击键裁决**(Typora 的空格建列表、
  `4\.` 转义与我们逐字一致;Milkdown 的 wrapInOrderedListInputRule
  `/^\s*(\d+)\.\s$/` 同样以空格为提交手势并把数字收进 order 属性——
  preset-commonmark lib/index.js:1282)。
- **模型优先迁移否决**(序列化器派生字节违背字节权威,v0.13.29 事故族先例;
  局部混合=同文档双权威);**光标字面区否决**(数周级手术、caret 块身份在
  瞬态重构时恰不稳定、settle 时仍须回答同一问题——只换来瞬态不闪)。
- **显式条款(不对称的裁决理由)**:TRANSIENT_SINGLE(`- + * > # \` ~ _`
  单字符)默认**投影为结构**、由下一键降级——因它们兼任行内开启符,转义
  开启 `*` 实测级联毁 mark 线、转义 `-` 杀死建列表;数字 marker(`N.`)默认
  **转义为文本**、由 Space/Enter 收编。两个相反的静止态都是实测裁决,
  统一它们之前必须重付这两笔实测代价。
- 残余「自动号+手打号双显直到下一键」= 诚实显示,按外观处理(自动序号
  灰显装饰,零字节),不动正确性层。

第二阶段任务(全部完成):① IME commitReplace 的 step 级路由收编 ✓
(commitResolvedTextSteps;consult 副本删除,kernel-mode 不再 import
seed/dissolve 机器);②未决态自动序号灰显装饰 ✓;③「未决态×下一键」42 行
演绎完备表 ✓(当场抓出并修复定界符裂列表)。

## 补记:源码忠实序号与 outdent 改号(2026-08-26 裁决 + 勘误)

上节最后一条「自动序号灰显装饰,零字节」是本 ADR 当时**唯一**的显示裁决,
而它只管未决态。此后同一族又落了两笔改动,彼此不知道对方存在;本节补记之
——`app.css` 的 `.hm-source-ordinal` / `.hm-undecided-ordinal` 两处注释引用
的就是这里(在此之前它们指向的章节并不存在)。

**两笔改动,相隔约 17 小时,无人发现它们相干**:

| 时间 | 提交 | 内容 |
| --- | --- | --- |
| 2026-08-23 22:45 | `96518af` | outdent ORDERED-MARKER RENUMBER:`Shift+Tab` 落到有序父项下时,把该项自己的 marker 改写为 `parent.number + 1` |
| 2026-08-24 16:08 | `68a0b38` | `sourceOrdinalPlugin`(editor-kernel-mode.js):编辑器改为显示**作者字节里的号**(Obsidian/VSCode 读法),用 CSS 变量 + `::before` 盖住 ProseMirror 的自动序号 |

`96518af` 的证明与注释都建立在一条 CommonMark 规则上:有序列表的 `start`
取自**首项**,其后各项的号被忽略——所以改号「不产生渲染后果」,是纯拼写
手势。`68a0b38` 恰恰**推翻了这个前提**:实测字节 `1. a / 5. b / 9. c` 在
编辑器里显示为 **1、5、9**(ProseMirror 的自动号说 1、2、3)。改号从此
**用户可见**。两者共存约 17 小时无人察觉,原因是那条「不可见」的理由被逐字
抄进了三个文件(命令 + 两份测试),复制品互相印证,没有任何一份能证伪它
——与本 ADR 开篇的发生器①同构:一份策略散在 N 处,漏一处即洞;这里是一份
**理由**散在 N 处,错一处即三处同错。

**裁决(2026-08-26,用户)**:**改号保留**。`1. 甲 / 2. 乙 / ␣␣␣1. 丙` 上
`Shift+Tab` 后必须读作 **1、2、3**——这既是 Typora 手势,也正是源码忠实显示
应当呈现的结果。行为不变、零字节预期变化;要改的只是**理由**。

**改号真正需要证明的是爆炸半径**,而不是不可见性:改号若落在列表**首项**上,
这串数字就成了列表的 `start`,所有兄弟项一起改号——在本编辑器、Pandoc 导出、
GitHub 与下游工具里皆然。`commands/indent.js` 的 `provenNonFirstOrdinal`
(原名 `provenIgnoredOrdinal`——那个名字断言的正是已死的前提)证明的是:
改写后的 marker 重解析成有序列表的**非首项**,故爆炸半径恰为用户所动的那一项。
`provenNestingOnly` 给不了这一条(它的 `leafSignature` 只记叶块类型 + 解码
文本,从不读列表的 `ordered`/`start`)。判定不过时命令退回纯剥缩进,改号
永不使 outdent 失败——该契约不变。

**去重与门禁**:该谓词此前在三处独立存在(命令 + `test-source-kernel-indent.mjs`
+ `test-source-kernel-statemachine.mjs` 的 `ordinalIsIgnored`)。两份测试副本
已改为 import 命令的导出;但**共享一份不等于有门禁**——那只是把重复换成
同义反复。所以 statemachine 的不变式同时拆成互不包含的两半:
- **结构半边**(本文件自推,只看 before/after 字节,不重解析、不复用命令的
  任何推理):至多一行超出前导 `[ \t>]*` 前缀发生变化;该行前后都以有序
  marker 开头且 marker 之后逐字节相同;其余行剥离前缀后逐字相同;行数不变。
- **爆炸半径半边**:import 的 `provenNonFirstOrdinal` 重解析证明。

两半的牙齿都用变异实测过(2026-08-26):①令命令在 marker 后多插一个空格
→ 结构半边 `S2b` 当场失败(而爆炸半径谓词对同一份被污染文档仍返回 `true`
——实测,故两半不冗余);②令命令去掉自己的非首项闸门、并保留整段缩进使改号
落在子列表**首项** → 爆炸半径半边失败(而结构半边全过,因为它剥掉了前导
缩进)。变异后 indent.js 已按校验和逐字节还原。

**相邻限制(记录,本轮不修)**:
- `editor-pdf-content.js` 的 `stripEditorOnlyForExport` 会剥掉 `.label-wrapper`,
  所以 **PDF / HTML 导出不带源码序号**,渲染的是顺序号。源码忠实序号是
  **编辑器内**的读法,与导出目标的约定(GitHub 式顺序号)有意分叉——但在此
  之前没有任何文件写下这条分叉。
- `.hm-undecided-ordinal`(未决态灰显,第二阶段任务②)与 `.hm-source-ordinal`
  (源码号替换)**作用在同一个 DOM 节点**(`li > .label-wrapper > .label.ordered`):
  前者调 `opacity`,后者把它 `visibility: hidden` 再用 `::before` 画。两者
  叠加时的观感无人讨论过,也无钉。

## 不做

- 不引入序列化器往返作为运行时权威(仓库历史已证其保真事故族;
  `roundtrip.js` 保持测试预言机身份)。
- 不用增量映射换性能(既有裁决不变)。
