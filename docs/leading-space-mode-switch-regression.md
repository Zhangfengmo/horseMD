# 行首多空格导致源码乱码与模式切换失真（0.13.22；0.13.65 更新）

## 用户现象

在富文本段落中先连续输入多个空格、再输入文字，切换到源码模式时可能出现：

- `&#x20;` 实体直接出现在源码；
- 新段落被拼到上一段末尾；
- 行尾增加一串非用户输入的空格；
- 富文本切到源码后展示旧快照或损坏快照，看起来像“卡住”；
- 保存、重开后继续使用错误源码。

这不是单一实体替换问题，而是“空白中间态、Markdown 语义、安全源码拼写、光标映射”
四条链路共同形成的家族回归。

## 真实 CGEvent 复现

测试从已有文档末尾开始，使用 macOS `.cghidEventTap` 逐键发送：

1. `Enter` 两次；
2. 空格键八次；
3. 逐字输入 `abc`；
4. 切换源码。

修复前真实 `markdownUpdated` 轨迹：

```text
<br /> + 2 spaces -> trailing-empty-block-filled
3 spaces          -> structural-line-change
4+ spaces         -> structural-line-change
first text        -> localized-change on already-corrupted source
```

第三个空格开始，generic structural mapper 把段落分隔符删除，源码从：

```md
# test

anchor
```

逐步损坏成近似：

```text
# test

anchor        abc
```

因此模式切换不是渲染慢，而是同步层已经把损坏结果当成成功事务并清除了 pending 标志。

## 为什么不能直接把 `&#x20;` 换成普通空格

CommonMark 会吞掉 1–3 个行首 ASCII 空格作为缩进，4 个以上则解析为 indented code。
所以 `&#x20;       abc` 直接改成八个普通空格，重新打开后会变成代码块，canonical/source
再次分叉。0.13.21 只解决“实体可见”，没有守住 Markdown 重解析语义，因此不是完整根因修复。

## 0.13.65：标准可移植源码

旧版曾仿照 Typora 写入不可见 `U+200B`，再由 HorseMD parser、visible map 和 caret map
把它当作私有语法吞掉。该做法会让同一份 Markdown 在其他产品里出现不可见字符，违背源码
优先原则。

现在磁盘与源码模式统一写作：

```md
&nbsp;       abc
```

即 `&nbsp;` 表示第一个必须保留的空格，余下 7 个仍是 ASCII 空格。`&nbsp;` 是标准
Markdown/HTML 实体，其他编辑器直接解析，不需要 HorseMD 特殊规则；新写入路径不再产生
`U+200B` 或 `&#x20;`。

## 工程修复

### 1. 纯空格中间态不写源码

`preserveTrailingEmptyBlock()` 将尾部 whitespace-only canonical block 与 `<br />` 一样
视为尚未完成的空段落：仅推进 canonical baseline，源码保持不变。输入首个可见字符后，
再通过 `trailing-empty-block-filled` 一次性追加完整段落。

### 2. Markdown-safe 行首空格拼写

`canonicalTextToSource()` 只在 `&#x20;` 位于该块首个可见字符时写入：

```text
&nbsp;
```

行中、行尾的 `&#x20;` 仍恢复为普通空格，避免给既有分歧删除等路径增加哨兵。

### 3. 没有 HorseMD 私有源码语法

- `&nbsp;` 交给所有标准 Markdown/HTML parser 正常解析；
- visible/caret map 正常解码实体，不再跳过零宽字符；
- canonical 再次出现 `&#x20;` 时，源码保真层统一写成 `&nbsp;`；
- 因此富文本内容、源码显示、保存字节和模式切换光标保持一致，也可被其他产品直接打开。

实现集中在：

- `lib/markdown-preservation/core.js`；
- `lib/markdown-preservation/paragraphs.js`；
- `mode-visible-map.js`；
- `components/editor-crepe-setup.js`。

## 回归保障

`npm run test:leading-space-entity-ui` 现在覆盖：

- 已有文档的新段落；
- 清空后重新输入；
- 真正空文件的 scratch 生命周期；
- 两次 Enter + 八次延迟空格 + 逐字文字的真实中间态；
- 连续两次富文本/源码往返；
- 光标保持在最后输入字符后；
- 保存磁盘与完整新进程重开。

纯函数还覆盖四空格、Tab、列表续行和逐个 whitespace-only canonical delta。最终使用
macOS CGEvent 再验：第一次与第二次源码快照、光标 offset、磁盘文件全部一致。

## 防止再犯

1. 不得把 serializer entity 当成单纯字符串美化问题；先验证重新解析语义。
2. 不得让 whitespace-only rich paragraph 进入 generic structural mapper。
3. 测试必须强制产生多个 `markdownUpdated`，不能只测被 debounce 合并后的最终状态。
4. 新增源码拼写时，解析、序列化、visible map、caret map、保存重开必须一起验证；不得新增应用私有哨兵。
5. 自动化通过后仍需用 `docs/macos-real-input-testing.md` 的 CGEvent 路径复核真实键盘时序。
