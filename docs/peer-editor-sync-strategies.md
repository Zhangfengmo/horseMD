# 同品类编辑器的源码保真策略调研 × HorseMD 修复定位

> 2026-08-11。三路并行调研(ProseMirror 生态 / 源码优先阵营 / 声明有损阵营),
> 全部结论有一手来源(官方文档、作者 issue 回复、源码抓取);与
> `docs/rich-source-sync-architecture-review.md`、`docs/live-preview-migration-plan.md`
> 互为参照。结论先行:**业界没有任何项目同时做到「Markdown 作者字节 = 磁盘真值」
> 与「富文本编辑」;HorseMD 走的是一条孤独路线,但本次修复(验收关卡 +
> fail-closed 恢复)恰是全生态普遍缺失的那块安全件。**

---

## 1. 四条路线的全景图

| 路线 | 代表 | 数据真值 | 该 bug 类别 | 代价 |
|---|---|---|---|---|
| **A. 源码即模型** | Obsidian(CM6 + view-only decoration)、HackMD/VS Code(分栏,退化形态) | 磁盘字节本身 | **磁盘层面消失**;显示层漂移 bug 仍在但不落盘 | 富交互全部手搓 widget(Zettlr 表格编辑器重写 18 个月);编辑器内核级迁移成本(Zettlr CM6 迁移 = "rebuilding from the ground up") |
| **B. 规范化即真值** | prosemirror-markdown、remark/mdast、TipTap、Milkdown、**Typora** | 富模型(AST/PM doc) | **存在且公开接受**:重写被定义为正常行为(Typora 包装成「美化」) | 用户源码被静默改写(Typora #1188 强制重排编号、#403 U+200B 泄漏);跨工具兼容性投诉 |
| **C. 私有格式为真值** | Notion、飞书、语雀、Outline、Notesnook、BlockNote、AFFiNE | 私有 JSON/CRDT | **不适用**:Markdown 降级为有损导出(BlockNote 直接把 API 命名为 `blocksToMarkdownLossy`) | 放弃「本地 .md 文件是第一公民」的产品定义 |
| **D. 字节保真 + 富编辑** | **仅 GitLab 认真做过;HorseMD 在做** | 磁盘 Markdown | 正面攻坚 | 生态零先例走通;GitLab 已从「整篇保源」收缩到「属性级偏好」 |

关键事实修正:**Typora 属于路线 B,不是 A**。官方文档承认内部是 AST 且
「不影响最终渲染的细节不会被保留」(参考式链接被拍平为内联);用户 issue
实证它强制重排列表编号(#1188)、泄漏 U+200B 进导出文件破坏 LaTeX 管道
(#403)。它没有 HorseMD 式的锁死灾难,是因为它**从不承诺字节保真**——
把规范化定义成产品行为,且单视图设计避开了双表示对账循环。

## 2. PM 生态的三条共识(全部有权威出处)

1. **PM 文档 ↔ Markdown 是多对一有损投影,不可逆。**
   - marijnh(PM 作者):"There is no guarantee of round-trips through
     parsing/serializing Markdown leaving the Markdown text unchanged."(prosemirror-markdown #92)
   - mdast-util-to-markdown README:"complete roundtripping is impossible"
   - TipTap 维护者(#7147):"We don't plan to deviate from the default CommonMark behavior"
   - 与 HorseMD 完全相同的诉求在上游被事实 won't fix(prosemirror-markdown #80)。
2. **把 Markdown 当磁盘真值的 PM 项目,最终要么换私有格式、要么把 Markdown 降级为有损导出。**
   Outline 是铁证:它曾是「PM + Markdown 存储」旗舰,已迁移到 JSON,旧 Markdown
   现在被官方描述为 "potentially lossy exports"(discussion #7396)。
3. **要做字节保真,必须由权威解析器直供源位置,不能序列化后再 diff 猜。**
   GitLab 的做法:后端渲染器输出 `data-sourcepos`,原文挂载为 DOM 注释,
   按行列切片取作者字节(markdown_source.js)——即便如此,master 上的
   「整篇保源」代码路径也已移除,只剩 bullet 字符/序号分隔符/多行引用等
   **属性级**偏好保留。

**上游风险(迁移设计的前提假设)**:HorseMD 依赖链上有活跃未修的往返缺陷——
mdast-util-to-markdown #73(反斜杠每轮翻倍,指数增长)、Milkdown #2428
(行内 `<br>` 静默删除)、#2349;且 Milkdown 的 mark 序列化(merge-then-fixup)
被分析为结构性地比官方 prosemirror-markdown(lookahead)更脆(#2403)。
**任何「事务直达源码」迁移都必须把「上游序列化器不可信」当作前提——
验收关卡在迁移完成后也不应移除。**

## 3. 源码优先阵营的真实账单

- **消灭的**:双表示对账丢失、「打开即弄脏」——Obsidian 的 decoration 是纯视图,
  "copy/save/round-trip remain byte-for-byte identical"。
- **没消灭的**:显示层不一致 bug(形态转移:从「磁盘被污染」降级为「会话内
  视图漂移」);规范化争议收窄为语法子集的产品决策(Logseq 只认 `-` marker、
  属性名强制小写——用户从「我的文件被静默破坏」变成「我知道但不喜欢」)。
- **同构对照**:MarkText(块富模型,与 HorseMD 同构)有一模一样的
  「打开即弄脏」(#2189,官方承认未修);其第三方 fork 的 "Light Touch"
  (无语义变化原字节写回、有变化只替换编辑区)与 HorseMD 保真层同一思路——
  独立收敛佐证。

## 4. 「声明有损」阵营的 UX 模式与 HorseMD 对标

| 模式 | 代表 | 缺陷 |
|---|---|---|
| 一次性可关闭横幅 + 文档链接 | Joplin | 社区长期投诉「警告太弱 + 无找回原文出口」(#9929 至今开放) |
| 默认关闭转换开关 | Google Docs(粘贴/复制转 MD 需手动开启) | 回避而非解决 |
| 架构性拒绝(wontfix WYSIWYG) | HackMD #375 | 放弃所见即所得 |
| 文档化声明、无交互确认 | Notion/飞书/语雀 | 知情责任在用户 |

HorseMD 当前的「`sync.rebuildConfirm` 事前确认(讲明内容不丢、格式规范化)+
拒绝后另存恢复副本」组合,同时补上了 Joplin 模式的两块公认短板
(每次触发 vs 一次性;有出口 vs 无出口),在该阵营对比中处于最强档。

## 5. HorseMD 本次修复在谱系中的定位

1. **验收关卡 = 生态普遍缺失的 content-preservation check。**
   Milkdown #2403 对此类损坏的定性:"All four were **silent** … only caught by
   manual before/after diffing, not by any content-preservation check"。同一
   issue 里另一团队独立收敛到相同答案:"**reject-on-write rather than
   silently corrupt**"——两个互不知情的团队得出同一设计,是很强的正确性信号。
2. **恢复出口设计强于对标**(见 §4)。
3. **HorseMD 已解决若干上游未解问题**:`editor-tablebreak.js`(表格 `<br>` 往返)
   对应 TipTap #7731 / Milkdown #2428(均未解);`editor-autolink.js` 对应
   同类终止符缺陷。
4. **取源方式落后于 GitLab、方向已对齐**:「序列化→diff→启发式补丁」是生态
   没人走通的路;`source-transaction-sync.js`(事务直达源码 + app-parser 验收)
   与 GitLab sourcepos 精神一致——「别再猜,拿权威位置」。
5. **路线警示**:唯一先行者 GitLab 已收缩;Outline 干脆改道。HorseMD 作为
   本地 .md 文件编辑器,路线 C(私有格式)被产品定义排除,现实终局是
   **路线 A(源码即模型,live-preview-migration-plan 的长期备选)**,
   当前路线 D 是过渡桥——过渡期的安全底线就是本次落地的
   「关卡 + fail-closed + 双出口恢复」。

## 6. 对后续工作的三条具体建议

1. **关卡永久化**:即使事务覆盖率提高、即使未来迁移 CM6,凡存在
   「富模型→Markdown 序列化」的路径,验收关卡不撤(上游序列化器不可信,§2)。
2. **借鉴 GitLab 的属性级收缩作为中间态**:如果整篇字节保真的维护成本继续
   膨胀,可参考 GitLab 的退法——保 marker 字符、序号分隔符、引用风格等
   **属性级偏好**,其余接受规范化 + 明示(飞书式声明文案是范本)。
3. **向上游回馈**:HorseMD 的 tablebreak/autolink/关卡方案对 Milkdown
   #2428/#2349/#2403 是现成解法素材,上游修复可直接缩小本地保真层。

---

*来源索引见三份子报告原文;关键出处:prosemirror-markdown #92/#80/#101,
mdast-util-to-markdown README/#73, Milkdown #2349/#2403/#2428, TipTap #7147/#7731,
GitLab epic #7256 + MR !87157/!159262/!208611, Outline discussion #7396,
BlockNote docs, Typora issues #139/#403/#1188/#1877, MarkText #2189/#2212,
Obsidian forum(多帖), Joplin #9929/#12235, 飞书官方博客。*
