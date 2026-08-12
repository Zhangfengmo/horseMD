# 列表项正文字面标记被自动转义回归报告

> 状态：0.13.26 的“源码不得出现必要转义”结论已由 0.13.50 verified parser 合同纠正；本文 §1–6 保留历史记录，当前结论见 §7
>
> 家族编号：RS-25
>
> 日期：2026-08-09

> 2026-08-12 更正：`1. 2. 测试`、`- 1. 测试`、`- - 测试` 等源码会被
> HorseMD 的实际 Markdown parser 解释为嵌套列表，而富文本事务中的这些字符可能只是
> 列表项正文。旧测试只比较源码字符串和可见文字，没有比较冷重开后的 PM 结构，因此
> 把语义变化误标为“保真”。0.13.50 只保留防止意外嵌套所必需的标准转义。

## 1. 用户症状

在有序列表或无序列表的项目正文中继续输入类似列表标记的字面文本后，富文本显示正常，但源码出现用户没有输入的反斜杠：

```markdown
3. 2\. 测试
- \- 测试
- \+ 测试
- \* 测试
- 1\) 测试
```

用户没有输入 `\`。严重时，同一次编辑还会把后续未编辑无序列表的 `-` 改成 `*`，并在紧凑项目之间插入空行。

## 2. 稳定复现

初始源码：

```markdown
1. 第一项
2. 有序占位

- 普通项
- 无序占位
```

后台 Electron 使用 `scripts/lib/human-input.mjs` 逐字符执行：

1. 删除“有序占位”，分别输入 `2.`、`2)`、`-`、`+`、`*` 与正文；
2. 删除“无序占位”，重复同一组字面标记；
3. 最后一个字符后不等待回调，立即切源码；
4. 再往返一次，保存，完全退出并用新 profile 重开。

修复前第一次源码稳定变为：

```markdown
1. 第一项
2. 2\. 测试

* 普通项

* \- 测试
```

## 3. 根因

### 3.1 serializer escape 不是用户输入

remark-stringify 为保证 canonical Markdown 再解析时不会把列表项正文中的 `2. `、`2) ` 或 `- ` 等字面内容误判为新的嵌套列表，会输出 `2\. `、`2\) `、`\- ` 等形式。ProseMirror 中保存的可见文字没有反斜杠；反斜杠只是 serializer 拼写。

旧实现把该 canonical 行当作普通文本 replacement，导致 `\.` 直接写入作者源码。

### 3.2 局部修改错误扩散到其他列表

作者源码使用紧凑 `-` 列表，canonical 使用松散 `*` 列表。旧的通用 localized/multi-list 路径没有优先识别“行数、marker 结构和行间 gap 完全没变，只有某一行正文变了”，因此可能用 canonical 区域覆盖后续未编辑列表。

第一次修复后，作者源码是 `2. 测试` 或 `- 测试`，canonical 基线仍可能是 `2\. 测试` 或 `\- 测试`。若列表行比较把它们当成不同内容，第二次编辑又会退出稳定行路径，反斜杠会重新出现。因此比较层必须把这些 serializer 等价拼写视为同一可见文本。

## 4. 修复原则

1. 稳定列表行处理从“只填充空项”扩展到所有**纯行文字变化**。
2. 必须同时证明 source / previous / next 的顶层列表行数量一致，previous / next marker 类型和所有行间 gap 一致；结构变化仍交给专用列表处理器。
3. 稳定行路径优先于更宽泛的 multi-list block 路径，防止局部文字编辑规范化其他列表。
4. 对 previous/next 当前行构造“去 serializer 转义的语义视图”，同时保留语义位置到 canonical raw offset 的边界表；只把本次文字 delta 映射回作者源码。
5. 支持的歧义标记为数字点、数字右括号、`-`、`+`、`*`；不做全文反转义，也不触碰代码、HTML 或其他 Markdown 上下文。
6. previous canonical 已经存在的转义不属于本次 delta，因此作者原来手写的 `2\.`、`\-` 等内容在后续编辑时仍逐字符保留。
7. 列表行身份比较使用同一语义视图；该规则只用于行身份和 raw delta 映射，不全局改写源码。

## 5. 修改文件

- `src/renderer/src/lib/markdown-preservation/lists.js`
  - 扩展稳定列表行文字映射；新增标点语义视图与 raw 边界表；补充比较等价规则。
- `src/renderer/src/markdown-source-preservation.js`
  - 将严格稳定行映射放在宽泛 multi-list block 映射之前。
- `scripts/test-markdown-source-preservation.mjs`
  - 覆盖有序项、无序项、混合列表及作者已有 `\.` 保留。
- `scripts/test-list-item-literal-marker-source-ui.mjs`
  - 对 `1.`、`1)`、`-`、`+`、`*` 真实逐字符输入，验证立即切源码、二次往返、保存与完整重开。

## 6. 验收合同

```bash
npm run test:markdown-preservation
npm run test:list-item-literal-marker-source-ui
npm run test:rich-list-source-ui
npm run test:new-document-list-source-ui
npm run test:list-conversion-ui
npm run test:rich-source-chaos-ui
npm run test:source-fidelity-ui
npm run build
```

必须满足：

- 有序/无序列表项正文的 `1. 文本`、`1) 文本`、`- 文本`、`+ 文本`、`* 文本` 不增加 `\`；
- 未编辑的 `-`、`+`、`*` marker 和紧凑/松散空行不变；
- 作者源码原来已有的 `1\.`、`\-` 等转义不被擅自删除；
- 第一次源码、第二次模式往返、磁盘和完整重开完全一致。

## 7. 0.13.50 verified parser 更正

当前首要合同不是“源码里绝不出现用户没输入的反斜杠”，而是“待保存源码经 HorseMD
应用 parser 重建后，必须与用户眼前的 live ProseMirror 结构一致”。因此：

```markdown
1. 2\. 测试
- 1\. 测试
- \- 测试
```

这里的反斜杠不是正文字符，也不会显示在富文本里；它阻止 `2. `、`1. `、`- ` 被
Markdown block parser 当成下一层列表。若去掉反斜杠，冷重开后的结构已经不是保存前
的列表项正文。

新的 mapper 仍保留本报告正确的另一半约束：只修改当前行正文，外层 `-` / `+` / `*`
marker、紧凑/松散 gap 和未编辑列表不被 serializer 规范化；作者原本已有的转义也不
重复添加。回归以第一次源码、保存、完整退出和冷重开后的结构共同为准，不再仅凭
“源码看起来没有反斜杠”判定成功。
