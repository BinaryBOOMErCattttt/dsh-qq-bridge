---
name: update-cognition
description: 兼容壳：只做一句话分诊。学**文字**梗 / 黑话 / 谐音 → learn-meme；学**表情包** → learn-sticker。旧提示词或旧习惯里还在用这个名字时加载它。
whenToUse: 只有在你还记得 `update-cognition` 这个旧名字、或者旧提示词让你加载它时。新代码一律直接用 learn-meme / learn-sticker。
---

# update-cognition 已拆分

这里不再写任何条目 —— 只告诉你该去哪个 skill。**不要**在本文件里记录梗或表情包。

## 分诊（一句话）

1. **有图**（表情包、梗图、截图里的梗）→ 加载 `learn-sticker`：
   先 `qq_save_sticker` 收藏进表情包目录，再写 `<memory>/STICKERS.md`。
2. **只有文字**（梗、黑话、缩写、谐音写法）→ 加载 `learn-meme`：
   写 `<memory>/COGNITION.md`。
3. **图文都有**：图进 `STICKERS.md`，那个词的用法进 `COGNITION.md`，两边互相写名字，
   **不要在一个文件里写两遍**。
4. 拿不准、或不确定意思 → 不写。要写也只能标「置信：存疑」，那是给已经记下的条目用的，
   不是「先写一条再猜」的借口。

## 文件与边界

| 文件 | 装什么 | 键 |
|---|---|---|
| `<memory>/COGNITION.md` | 语言：梗、黑话、缩写、谐音 | **文字写法**（含变体） |
| `<memory>/STICKERS.md` | 表情包目录 | **收藏后的文件名**（`.qq-stickers/…`） |

两条硬规则：`COGNITION.md` 里**不许出现文件路径**；`STICKERS.md` 里**不许出现 `.qq-media`**
（那说明没收藏，先收藏再记）。写盘只用 `qq_memory`，边界是记忆目录。
