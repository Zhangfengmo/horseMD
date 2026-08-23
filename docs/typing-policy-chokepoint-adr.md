# ADR: 打字策略收敛到单一字节提交咽喉(typing-policy chokepoint)

日期:2026-08-24 · 状态:**第一阶段已执行**(2026-08-24:策略函数落地、三调用点统一、快照 restructures 归零;剩余=IME commitReplace 的 step 级路由收编)· 起因:用户评审
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

## 不做

- 不引入序列化器往返作为运行时权威(仓库历史已证其保真事故族;
  `roundtrip.js` 保持测试预言机身份)。
- 不用增量映射换性能(既有裁决不变)。
