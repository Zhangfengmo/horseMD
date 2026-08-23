# Computer Use 输入真实性验证记录（2026-08-23）

## 运行条件

- 应用：`/Applications/HorseMD.app`（`0.14.3`）
- 驱动：macOS Computer Use，已授予 HorseMD 控制与屏幕录制权限。
- 目标：验证真实前台键盘下的列表输入、`Tab` / `Shift+Tab`、源码切换与保存边界。

## 观察到的异常（未确认缺陷）

第一轮在新的未命名草稿中以无额外等待的逐字符操作输入标题、正文、`1. ` 列表、嵌套和反缩进。富文本可访问树显示的列表项为：

```text
1. one
2. 3.two
3. 4.nested
4. 5.out
```

这与预期的“`one`、`two`、嵌套 `nested`、反缩进 `out`”不一致。

## 证据边界

此结果**不能作为产品 bug 结论**：输入序列没有在每个结构键后等待编辑器结算；此外，列表渲染后可访问树的元素索引发生变化，第一轮用旧索引点击“源码切换”未被验证成功。因此尚未获得可靠 Markdown 源码或落盘保存证据。

## 后续验证

1. 用另一个独立未命名草稿复现，每个字符与 `Enter` / `Tab` / `Shift+Tab` 后等待 250ms。
2. 通过当次实时可访问树定位源码切换按钮，而不是复用旧索引。
3. 读取源码、执行真实保存、读取保存后的内容与冷重开状态。
4. 若慢速复验仍异常，将该异常升级为已复现输入 bug；本记录只归档验证证据，不包含修复。

## 已确认：慢速真实键盘多级列表异常

**状态：已复现，不修复。**

在第二个独立未命名草稿中，所有字符均由 Computer Use 单独提交，字符后等待 300ms，`Enter` / `Tab` / `Shift+Tab` 后等待 500ms。每个关键结构键后均读取了 HorseMD 的实时可访问树；源码模式按钮也从该次树中动态定位，不复用旧索引。

测试动作：

```text
标题 Slow list → 正文 body → 1. one → Enter → two → Enter → Tab
→ nested → Enter → Shift+Tab → out → Enter → Enter → after
```

预期的列表结构：

```md
1. one
2. two
   1. nested
3. out
```

实际源码：

```md
# Slow list

body

1. one
2. 3.two
3. 4.nested
4. 5.out

after
```

结论：输出不含 HorseMD 私有标记，按标准 Markdown 语法可解析；但它把自动编号和用户文字错误拼接，并丢失了预期的嵌套/反缩进语义。该问题在第一轮无等待输入和第二轮 300ms 节奏输入中均出现。尚未执行任何产品修复。

### 独立标准解析器交叉检查

同一份实际源码分别经 `remark-parse + remark-gfm` 与 `marked` 解析。两者一致识别为一个顶层有序列表，项目正文依次为：

```text
one
3.two
4.nested
5.out
```

因此这不是 HorseMD 私有语法造成的兼容性问题：该文件对通用 Markdown 工具可读，却已经把用户想要的多级列表语义丢失。此项验证满足“标准 Markdown”检查，但判定编辑行为失败。

## 斜杠命令真实性验证

在第三个独立未命名草稿中，`/h2`、`/quote` 与 `/task` 均以逐字符 Computer Use 输入后按 `Enter` 选择首项。实时富文本树确认：

- `/h2` 把段落转为二级标题；
- `/quote` 创建引用容器；
- `/task` 先创建空任务项，再在输入 `todo` 时保留复选框。

动态进入源码模式后得到：

```md
# Slash lab

## Section

>quoted
>
>

- [ ] todo
```

结论：三个命令均落为可移植的标准 Markdown/GFM。`>quoted` 没有 marker 后空格、引用末尾有两个空引用行，但二者都是合法 Markdown 拼写；本轮未见 HorseMD 私有语法。

### `/table` 与 `/code`

`/table → Enter` 创建了 3×2 GFM 表格，源码为：

```md
|  |  |  |
| --- | --- | --- |
|  |  |  |
```

`/code → Enter` 后逐字符键入 `const x = 1`，源码为：

````md
```
const x = 1
```
````

两者均为通用 GFM/CommonMark 语法，未发现私有占位符、编辑器 DOM 或 HTML 回退内容写入作者源码。

## 复杂 fixture 基线与局部编辑驱动失败

复杂 fixture 在源码 → 富文本 → 源码的**无编辑**往返中逐字节相同（654 bytes），确认所有未编辑内容保留作者拼写。

首次局部编辑尝试不计入 HorseMD 结果：Computer Use `select_text` 接口只接受 `text`、`cursor_before`、`cursor_after`，测试错误传入 `after` 并收到明确的 `Invalid text selection mode: after`。后续三个字符保留在旧焦点，写成了 `- bullet alph!!;a`；表格、代码和末段均未被目标编辑。该草稿保留作为驱动失败证据，不保存、不用于兼容性结论。后续 fixture 使用正确的 `cursor_after` 模式重新执行。

### 正确选区后的局部富文本编辑

重置 fixture 后，使用 `cursor_after` 重新操作：

- JS 代码块 `const answer = 42` → `const answer = 42;`：成功；
- 普通段尾 `Final paragraph.` → `Final paragraph.!`：成功；
- 两项编辑外的源码字节保持不变，围栏、YAML、HTML、引用、任务、列表、表格和数学内容均未被重写。

表格单元格 `ready` 在 Computer Use 的可访问树中可见，但 `select_text` 与父单元格 `click` 均返回“元素 ID 无效”。一次点击失败后继续发送的字符落在旧的段落焦点，形成额外 `!`；该污染只存在于本测试草稿，且已停止继续操作。表格富文本点击编辑因此标为 **Computer Use 驱动阻塞**，不是 HorseMD 缺陷结论。

## 复杂文档保存与标准解析器验证

最终保存的独立文件为：`/tmp/horsemd-computer-use-validation.md`（657 bytes）。它通过真实 HorseMD Save 面板写入；保存后应用显示“已保存”。读取磁盘文件与保存前的源码快照**逐字节相同**。

完整 fixture 包含 YAML front matter、ATX 标题、强调/粗体/删除线/行内代码/链接/内联 HTML、引用与嵌套列表、三层无序/有序/任务列表、GFM 表格、JS 与 Mermaid 围栏、行内与展示数学、分隔线及尾段。

- **无编辑源码 → 富文本 → 源码**：654 bytes 完全相同。
- **局部富文本编辑**：代码块追加 `;` 与普通尾段追加 `!` 均精确写入预期标准 Markdown，其他 fixture 字节未重写。
- **双解析器**：去除 YAML front matter 后，`remark-parse + remark-gfm` 与 `marked` 对标题、段落、引用、无序/有序列表、GFM 表格、`js` 与 `mermaid` 围栏、分隔线给出一致的块级结构。YAML 与数学明确归为可选扩展；Mermaid 保留为通用 fenced code block，未产生 HorseMD 私有格式。

### 冷重开状态

通过 Computer Use 的原生“打开”面板进入 `/tmp` 并选中该文件后，双击打开导致窗口状态捕获两次超时，无法取得冷重开后的源码视图。未观察到新的 HorseMD 进程，因此不能以进程状态代替冷重开成功证据。该检查标记为 **Computer Use / 原生打开面板阻塞**，不把它归因于 HorseMD，亦不宣称冷重开通过。

## CDP 忠实通道复核(2026-08-23 晚,修复轮)

对「慢速真实键盘多级列表异常」在构建版 app 上用两条独立键盘通道逐键复刻同一序列(`Slow list → body → 1. one → Enter → two → Enter → Tab → nested → Enter → Shift+Tab → out → Enter → Enter → after`,字符间 300ms、结构键后 500ms,新未命名草稿):

1. **CDP `Input.insertText` 逐字符 + 结构键真实 keydown**(仓库套件通道);
2. **CDP `Input.dispatchKeyEvent type:keyDown` 带字符逐键**(与 CGEvent/Computer Use 等价的完整键盘管线,含 keydown→keypress→text input)。

两条通道、内核与 legacy 两种架构共四组,**均未复现** `2. 3.two / 3. 4.nested / 4. 5.out` 的编号拼接;结构与文字全部正确。结合本记录自己归档的驱动侧故障(`select_text` 模式错误后字符落入旧焦点写出 `!!;a`、表格元素 ID 失效、第一轮过期索引),该「已确认异常」**降级为疑似驱动伪影**——与 2026-08-22 验尸(`typeTextLikeUser` 无 keydown 使空格补全失效,损坏来自测试驱动器)同构。恢复 Computer Use 驱动后应以修正过的通道重测一次作最终裁决。

复核过程中发现并修复了一个**真实的内核源码拼写缺陷**:`Shift+Tab` 反缩进后,有序项把自己的嵌套编号原样带回根级(实测 `2. out`,应为 `3. out`;CommonMark 语义不受影响,渲染仍为第 3 项)。根因:`commands/indent.js` 的 `outdentListItem` 只剥缩进、无 indent 侧 ORDERED-MARKER RESCUE 的对称改号。修复:outdent 侧新增 ORDERED-MARKER RENUMBER(有序项落到有序父项下时续父项计数、用父列表定界符;bullet 父项与编号已正确时字节不动;同一重解析证明把关,改号被拒时退回纯剥缩进)。修后同一真实键盘序列产出与本计划预期**逐字节一致**的 `1. one / 2. two / (嵌套)1. nested / 3. out`。钉:`test-source-kernel-indent.mjs` OUTDENT ORDERED-MARKER RENUMBER 节(LF+CRLF+定界符族+子树随动+多位数+光标)。

另:本记录原标记的两项 Computer Use 阻塞检查已由 CDP 真实输入会话覆盖——表格单元格真实点击编辑(对齐表 `卯`→`卯真`、普通格逐字节落盘)与冷重开(保存字节逐字节重现、任务勾选状态保留),均通过。

## 当前结论

1. 已确认一项真实输入缺陷：从空草稿逐键创建并嵌套有序列表时，源码保留为通用 Markdown，但列表层级与文本语义错误。
2. 已确认 `/h2`、`/quote`、`/task`、`/table`、`/code` 生成的源码均为标准 Markdown/GFM；复杂文档的未编辑往返与代码/普通段落局部编辑没有私有化作者源码。
3. 表格富文本单元格编辑与冷重开尚无最终应用结论，因为 Computer Use 的可访问性/打开面板通道阻塞；这两项需要在该驱动恢复后重验。
4. 本文件只记录验证与证据；未改动任何 HorseMD 生产代码。
