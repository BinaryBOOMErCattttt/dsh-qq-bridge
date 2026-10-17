# 设置页 UI 重设计：定稿与实施交接

> **状态：已实现（2026-10-17），P1–P4 全部落地。** `client.js` 现在是 6 个下划线 tab + 扁平区块 +
> 官方两种字段行（`Switch` / 原生 `<select>` / `Input` / 多行框 / Pill 预览）+ 搜索 + 「只看已改」；
> 契约测试在 `test/client.test.mjs`（28 条），文案与文档见 README「在 Web UI 的设置页里改」。
> 本文件保留为设计依据与验收清单；P5（人设文件读写，附录 B）与 D6（`accessToken` 密钥化）仍未做。
> 依据：`client.js`（14 组 / 120 个字段）+ 本机 DSH `0.2.0-rc.2` 的官方设置页实现
> （`dsh-client-ui-settings-general` / `-models` / `-plugins` / `dsh-client-ui-primitives`）。

---

## 0. 结论与范围

### 0.1 一句话方案

**一个设置页 + 6 个下划线 tab + 搜索 + 按类型选控件 + 官方字段行，去掉卡片堆叠；**
保存仍然走官方的 `SettingsForm` 底栏，`SettingsFormModel` 与 `specFor` 一行不改。

```
标题 / 简介 / 一行保存提示
[🔍 搜索配置项…]                     [只看已改 3]  [已改 3]
连接   会话   人格   群聊   感知   记忆
────────────────────────────────────────────────────────────
区块标题
────────────────────────────────────────────────────────────
字段行（官方表单行 / 官方开关行）
────────────────────────────────────────────────────────────
……
                                        [保存]   ← SettingsForm
```

### 0.2 已定决策（不再讨论）

| # | 决策 | 定论 |
|---|---|---|
| D1 | 导航位置 | **保留「设置 → QQ Bridge」顶级入口**（不挂到「设置 → 插件」的 tab 下）。120 项配置埋在插件 tab 里会被忽略；这是有意的偏差，写进 README |
| D2 | 分页 | **6 个下划线 tab**：连接 / 会话 / 人格 / 群聊 / 感知 / 记忆；默认「连接与准入」；**不**做 `localStorage` 记忆上次 tab |
| D3 | 脏状态 | 「已改 N 项」计数 + 「只看已改」过滤**都要**；口径 = `overridden === true` 的行数（与现在组头一致） |
| D4 | 数字量纲 | **只加只读 hint**（`= 45 分钟` / `= 35%`），**不做**双向换算，输入框里仍是原始值 |
| D5 | 人设文件编辑 | **本轮不做**（需要 Host 侧 remote）；方案保留在附录 B，将来单独评估 |
| D6 | `accessToken` 改成密钥字段 | **本轮不做**（需要 schema 加 `role('secret')`，是行为变化）；方案见 §4.3，单独 PR |
| D7 | 搜索快捷键 | **不做 `/` 聚焦**；只保留 `Esc` 清空。避免与浏览器快捷键冲突 |
| D8 | 保存成功提示 | **不做 Toast**；`SettingsForm` 的 saving / failed 已经够用，不额外造第二个反馈通道 |
| D9 | 区块折叠 | **不折叠**（除「兼容：旧 persona」这一处 `<details>`）。卡片的折叠状态全部删掉 |
| D10 | 页面文案语言 | tab 与区块标题沿用**中文硬编码**（与现有 14 个组标题一致）；只有界面 chrome（搜索、计数、空状态、tab 的 aria）进 `zh`/`en` 字典 |

### 0.3 范围与不做

| 项 | 本轮的取舍 |
|---|---|
| 改哪些文件 | `client.js`、`test/client.test.mjs`、`README.md`、`CHANGELOG.md`、`AGENTS.md`（§5.12 / §8 一句）、本文件的状态 |
| 不碰 | `config.js` schema、`settings.js`、`index.js`、任何运行时行为、`package.json` |
| 依赖 | 零运行时依赖、零构建；只用 `@deepseek-ai/dsh-client-ui-primitives` 已有导出 |
| 不做 | 人设文件读写（D5）、`accessToken` 密钥化（D6）、多列布局、深色主题单独配色、保存按钮浮动/吸底、Toast、tab 记忆、卡片折叠 |
| 风险 | 低：改坏了重刷页面即回旧版；没有配置/数据迁移 |
| 工期 | P1–P4 约 **5.5–6.5 人日**（一个人做，含测试与文档） |

---

## 1. 现状：为什么需要重设计

| # | 问题 | 证据 |
|---|---|---|
| 1 | 120 个字段、14 张折叠卡，默认只展开第一张 | `client.js` 的 `SECTIONS` + `QQ_BRIDGE` 里只有一个 `openId` |
| 2 | 布尔值是文本框 | `booleanSpec` 只是把值转成 `'true'` / `'false'` 文本，控件仍是 `SettingsValueField`（单行 input） |
| 3 | 枚举是文本框 | `choiceSpec` + `SettingsValueField`，用户要记住 `random` / `quote` 这些字面量 |
| 4 | 数字没有量纲 | `proactiveIdleMs: 2700000`、`mediaMaxBytes: 8388608` 这种值只能心算 |
| 5 | 没有搜索 | 找一个字段要逐张卡片点开 |
| 6 | 卡片是「分组」而不是「实体」 | 官方只有**可重复实体**（一个模型、一个账号）才用卡片，字段分组用标题 + 分隔线 |
| 7 | 组说明只有两张卡有 | `personaNote` / `expressionNote` 是上一轮补的，其余组没有上下文 |
| 8 | 没有「改了几项 / 几项非法」的总览 | `SettingsForm` 只给一个保存按钮，错误要滚到那一行才看见 |
| 9 | 长文本与普通字段混排 | `persona` 是 10 行 textarea，和路径/数字字段挤在同一张卡里 |
| 10 | 标签靠自动截断 | `deriveLabel` 按标点切第一段（上一轮已补一批 override，机制仍在） |

> 上一轮只是让新字段「能改」；这一轮要让 120 个字段**可扫、可找、可理解**。

---

## 2. 官方风格基线（从安装包里量出来的）

实现时照抄这些值，不要另起一套。

### 2.1 页面几何

设置是**一个居中模态**（不是独立路由）：

| 项 | 官方值 | 来源 |
|---|---|---|
| 面板 | `800px × min(800px, 100vh - 2×24px)`，`radius-panel`，`bg-layer-2` | `ui-settings-general/SettingsRoot.module.css` |
| 左侧导航 | 宽 `188px`，标题 16/500/24，项高 40、圆角 md、14/22 | 同上 |
| 内容区 | `padding: 0 24px 24px`，纵向滚动 | 同上 |
| **实际可用宽度** | **≈ 564px**（800 − 188 − 48） | 计算值 |

⚠️ **不要设计双列/宽表格**。`max-width: 720px` 只是上限，真正能用到的是 ~564px。

### 2.2 版式与层级

| 元素 | 官方值 | 来源 |
|---|---|---|
| 页面标题 | 16/500/24（Models）或 18/600（Plugins） | ModelsSection / PluginsSettingsSection |
| 页面简介 | 13–14px，`label-tertiary`，1–2 行 | 同上 |
| 区块标题 | 12/500/18 `label-secondary`（小标题）或 15/600/22 | `modelCatalogTitle` / `presetSettingsTitle` |
| 区块间距 | `gap: 12px`，区块之间 `margin-top: 12px` | ModelsSection |
| 说明文字 | 12/18 `label-secondary` 或 `label-tertiary` | 多处 |
| 分隔线 | `0.5px solid var(--dsw-alias-border-l2)` | fields.module.css / DeveloperToolsRow |

### 2.3 官方字段行的两种形态（都可用，按控件宽度选）

**A. 表单行（`SettingsValueField`，官方插件配置表单用的就是它）**

```
label（13/500）  [ⓘ]                         [已覆盖] 恢复默认
[ 控件（高 34，圆角 md，bg-layer-3，border-l4） ]
hint / 错误（12/1.5，tertiary / error）
────────────────────────────────────────────  ← 0.5px border-l2
padding: 12px 0
```

**B. 开关行（General 页）**

```
label（14/20）────────────────────────────────────────  [ Switch 36×20 ]
description（12/18 secondary）
────────────────────────────────────────────
padding: 16px 0；justify-content: space-between；gap: 24px
```

**规则**：布尔 → B；枚举 → A（官方 Models 页的写法：原生 `<select>` + Input 外观 + 下拉箭头）；
数字 / 文本 / 列表 / 密钥 / 长文本 → A。这样同一张页面里只有官方的两种行，不是自创第三种。

### 2.4 可用控件（`@deepseek-ai/dsh-client-ui-primitives`）

| 控件 | 用途 | 关键 props |
|---|---|---|
| `Switch` | 布尔 | `checked` / `onChange` / `label` / `disabled`；36×20，`aria-checked` |
| 原生 `<select>`（Input 外观） | 枚举取值 | 官方 Models 页就是这么做的：`select` + `border-l4` / `bg-layer-1` + 右侧 12px 箭头 |
| `Input` | 文本 / 数字 | 原生 input 属性 + 前置 `icon` |
| `SettingsSecretField` | 密钥（D6，本轮不用） | `configured` / `stateLabel` |
| `Tag` / `Pill` | 「已改」「已覆盖」、过滤开关 | `Tag` 有 tone；`Pill` 是按钮 |
| `Menu` / `MenuSurface` / `MenuItemButton` | 枚举多到需要分组/搜索时 | 支持 `portal` |
| `Modal` | 长文本编辑（本轮不用） | `title` / `children` / `footer` |
| `Toast` | 保存提示（D8，本轮不用） | `text` / `tone` / `onDone` |
| `SettingsForm` / `SettingsFormModel` | 官方暂存 + 保存底栏 | **继续用，不自己写保存** |

> `SegmentedControl` 是 **tablist 语义**，用于视图切换；**不要**拿它选值（会误导屏幕阅读器）。

### 2.5 三条官方「气质」

1. **单列、少层级**：官方设置页是「标题 → 一段话 → 一串行」，不在设置里套卡片墙。
2. **控件用官方件、颜色用 token**：不写死颜色，不引外部样式表。
3. **一处保存**：所有编辑暂存，底栏一次写；不搞「改一个字段立刻提交」。

---

## 3. 信息架构

### 3.1 6 个 tab（映射写死在 `TABS` 里）

| tab（短标签） | 全称（aria / title） | 含哪些现有分组 | 字段数 |
|---|---|---|---|
| 连接 | 连接与准入 | `connection` + `admission` | 12 |
| 会话 | 会话与节奏 | `agent` + `batch` + `style` | 23 |
| 人格 | 人格与表达 | `persona` + `expression` | 19 |
| 群聊 | 群聊互动 | `repeat` + `proactive` + `active` | 29 |
| 感知 | 感知与媒体 | `media` + `perception` | 22 |
| 记忆 | 记忆与运维 | `memory` + `apikey` | 15 |
| | | **合计 14 组** | **120** |

默认打开「连接」。`tabOf(sectionId)` 是纯函数：每个分组**必须**恰属一个 tab（测试钉住）。

### 3.2 页面骨架

```
┌──────────────────────────────────────────────────────────────┐
│ QQ Bridge                                                    │
│ QQ 桥接的全部配置，按用途分成六页；改完在底部一次保存。      │
│ 保存会写进当前 profile 的 cordis.patch.yml，随后插件重启一次；│
│ 环境变量（QQBOT_*）的取值会以表达式保留。                    │
│                                                              │
│ [🔍 搜索配置项…                        ] [只看已改 3] [已改 3]│
│                                                              │
│ 连接   会话   人格   群聊   感知   记忆                       │
│ ─────                                                        │
│                                                              │
│ 连接与运行环境                                               │
│ ──────────────────────────────────────────────────────────── │
│ OneBot WebSocket 地址                            [已覆盖] 恢复 │
│ [ ws://127.0.0.1:3001                                    ]   │
│ 留空 = 用默认值                                              │
│ ──────────────────────────────────────────────────────────── │
│ …                                                            │
│                                                              │
│ 准入与触发                                                   │
│ ──────────────────────────────────────────────────────────── │
│ 是否响应 QQ 私聊消息                          [ Switch ● ]   │
│ 群消息触发方式                         [ 按 @ 提及      ▾ ]   │
│ …                                                            │
│                                                              │
│                                        [保存] ← SettingsForm  │
└──────────────────────────────────────────────────────────────┘
```

页面文案**定稿**（写进 `zh` / `en` 字典）：

| key | zh | en |
|---|---|---|
| `title` | `QQ Bridge` | `QQ Bridge` |
| `intro` | `QQ 桥接的全部配置，按用途分成六页；改完在底部一次保存。` | `Every QQ bridge setting, grouped into six pages; save once at the bottom.` |
| `notice` | `保存会写进当前 profile 的 cordis.patch.yml，随后插件重启一次；环境变量（QQBOT_*）的取值会以表达式保留。` | `Saving writes this profile’s cordis.patch.yml and restarts the plugin once; values that come from QQBOT_* stay as expressions.` |
| `searchPlaceholder` | `搜索配置项…` | `Search settings…` |
| `searchEmpty` | `没有匹配的配置项。可以搜字段名（如 proactiveChance）或描述里的词。` | `No matching settings. Try a field name (e.g. proactiveChance) or a word from its description.` |
| `changedCount` | `已改 {count} 项` | `{count} changed` |
| `onlyChanged` | `只看已改` | `Changed only` |
| `invalidCount` | `{count} 项待修正` | `{count} to fix` |
| `tabsLabel` | `配置分类` | `Setting groups` |
| `sectionOf` | `属于「{tab}」` | `In “{tab}”` |

> 上一版的 `envNotice` 合并进 `notice`，删掉这个 key；`groupsHint` 由 tab + 搜索替代，删掉。

### 3.3 搜索

- 位置：简介下方；`Input` + `IconSearchOutlineRegular`，宽 `min(320px, 100%)`。
- 匹配（大小写不敏感，先去掉空白/`_`/`-`）：字段短标签、字段名、`.description()`、所属区块标题。
- 搜索非空时**只渲染扁平的匹配结果列表**，tab 仍在但作为上下文；点任一 tab = 清空搜索并切过去。
- **结果行本身可编辑**（所有控件只是 `SettingsFormModel` 的视图，跨 tab 渲染没有状态问题）。
- 每行右侧 `Tag` 标出来源 tab；`Esc` 清空并把焦点还给搜索框。
- 排序：tab 顺序 → 区块顺序 → 字段顺序（schema 顺序），结果稳定。
- 空结果：`searchEmpty` 文案，不要在页面里塞插画。

### 3.4 脏状态、非法项与保存

- 工具条右侧：`Tag`「已改 N 项」（`overridden` 行数）+ `Pill`「只看已改」开关。
  - 无覆盖行时：隐藏计数；`只看已改` 置灰不可点。
  - 「只看已改」与搜索可叠加：先按覆盖过滤，再按查询过滤。
- 非法项：`invalid` 行数 > 0 时工具条显示 `invalidCount`（`--dsw-alias-state-error-primary`）；
  `SettingsForm` 自己会禁用保存，不重复造按钮。
- 底栏：继续用 `SettingsForm`（官方保存、只读、失败提示都在里面）。
  **不放第二个保存按钮、不做吸底浮动条。**
- 行级：`已覆盖` 标记 + `恢复默认`；自定义控件必须复制这套 chrome（`FieldShell`）。

### 3.5 区块与「兼容」

- 每个现有分组 = 一个**区块（不是卡片）**：标题（15/600/22）+ 可选 `note`（12/18 tertiary）+ 字段行。
- 相邻行之间 0.5px 分隔线；区块最后一行不画线；区块之间 12px。
- 只有一处 `<details>`：人格页的「兼容：旧 persona（文件存在时不生效）」。
  官方样式：12/500 的 summary、5px 小箭头、`border-top` 0.5px、展开后 `padding-top: 12px`。
- 其他低频字段**不折叠**：藏起来只会让人找不到。

---

## 4. 控件映射

### 4.1 总表

| 字段类型 | 控件 | 行形态 | 写法（仍然走同一份 spec） |
|---|---|---|---|
| 布尔（26 项） | `Switch` | B | `checked = state.text === 'true'`；`onChange → edit(key, next ? 'true' : 'false')` |
| 枚举（4 项：3/2/4/4 个值） | 原生 `<select>`（Input 外观 + 箭头） | A | `value = state.text`；`onChange → edit(key, value)`；空草稿显示「用默认值」 |
| 数字 | `Input`（`inputMode="numeric"`） | A | `P.settingsNumberField` 的 `format/parse` |
| 文本 | `Input` | A | `P.settingsTextField`（「空 = 恢复默认」语义不变） |
| 字符串数组 | `Input` + 下方 `Pill` 预览 | A | 输入仍是逗号分隔文本；`Pill` 的 × 调 `edit` 重写文本（删一个值） |
| 长文本（`persona` / `instructions`） | 现有 `LongTextField` | A | 保留，`instructions` 在正文，`persona` 在 `<details>` 里 |

**不变量**：控件只负责把值转成**草稿文本**；校验、覆盖、保存全在 `SettingsFormModel` 里。
`specFor` 的 `format/parse` 是唯一口径 —— 新控件不碰保存链路，才好单测。

> 实现备注：字段行的文本 / 数字用的是**原生 `<input>` + `.qq-input`**（也就是官方
> `fields.module.css` 的 34px 几何），只有这样才和同一行的 `<select>` / 多行框一样高、一样底色；
> primitives 的 `Input`（32px 胶囊、可带前置图标）只用在工具条的搜索框上。`specFor` 与保存
> 链路完全不受影响。

### 4.2 枚举的显示文案（`ENUM_LABELS`）

schema 只给字面量，页面要给人话。`client.js` 里加一张**界面层**映射（不改正 schema）：

```js
const ENUM_LABELS = {
  groupTrigger: { mention: '按 @ 提及', prefix: '按前缀', all: '全部消息' },
  approvalPolicy: { never: '一律拒绝（无人值守）', inherit: '跟随宿主' },
  pokeMode: { random: '随机（回戳或走一轮）', poke: '总是回戳', text: '走一轮模型', ignore: '不回' },
  replyStyle: { auto: '自动（默认）', plain: '直接发', quote: '引用', at: '@ 对方' },
};
```

- `<select>` 的第一项是「用默认值」（value 为空串 → `clear`），其余按 `choicesOf(node)` 生成；
  标签取 `ENUM_LABELS[key]?.[value] ?? value`。
- 测试钉住：**每一个枚举字段的每一个取值都有文案**（漏一个就红），且映射里没有多余字段。

### 4.3 `accessToken`（D6，本轮不做）

现状：`accessToken` 没有声明 `.role('secret')`，值会随设置表单下发到浏览器。要做的话是两步：

1. `config.js` 给它加 `.role('secret')`（一行，行为变化）；
2. 页面改用 `SettingsSecretField`，按 scope 的 `secrets` 渲染「已配置 / 未配置」。

这属于安全面改善，单独 PR，不和本次视觉重设计绑在一起。**本轮保持原样。**

### 4.4 数字的量纲提示（只显示，不做换算）

在 hint 里追加一段只读的人类可读值：

| 字段族 | 例子 | hint 追加 |
|---|---|---|
| 毫秒 | `proactiveIdleMs: 2700000` | `= 45 分钟` |
| 小时 | `digestAtHour: 4` | `= 04:00` |
| 字节 | `mediaMaxBytes: 8388608` | `= 8 MB` |
| 字符 | `personaMaxChars: 4000` | `= 4000 字` |
| 概率（0~1） | `proactiveChance: 0.35` | `= 35%` |
| 倍率 | `activeGroupBatchScale: 2` | `= ×2` |

实现约定：

- `FIELD_HINTS` 是**显式白名单**（字段名 → `(value) => string`），**不按后缀猜**。
- 但为了让白名单不漏，测试反向钉住：**凡是名字以 `Ms` / `Bytes` / `Chars` / `Hour` / `Chance`
  结尾的 schema 字段，必须在 `FIELD_HINTS` 或 `NO_HINT`（显式豁免集合）里**。
  豁免目前只有：无（先留空集合，将来有歧义字段再放进去）。
- 每个 `FIELD_HINTS` 的 key 都必须存在于 schema（配置改名后测试会红）。
- 格式化：毫秒四舍五入到一位小数（`1200 → 1.2 秒`；`≥1 小时` 用「小时」，`≥1 分钟` 用「分钟」）；
  字节按 1024 进制（`8963968 → 8.5 MB`）；概率 `×100` 后最多保留一位小数。
- 只加在 hint 末尾（`hint = 原 hint + ' · ' + 量纲`），**不替换**原文。

---

## 5. 人格与表达页（重构的主角）

```
人格与提示词（PERSONA.md 优先）
  人设文件（优先）            [ .qq-persona/PERSONA.md ]
  人设文件最多读多少字符      [ 4000 ]  = 4000 字
  按场景叠加人设四段          [ Switch ● ]
  ▸ 兼容：旧 persona（文件存在时不生效）      ← <details>
       [ 多行 textarea ]
  ─────────────────────────────────────────────
  额外要求（追加）            [ 多行 textarea ]
  ─────────────────────────────────────────────
表达（STYLE.md 优先）
  表达规则文件                [ .qq-persona/STYLE.md ]
  表达规则文件最多读多少字符  [ 2000 ]  = 2000 字
  ── 气泡 ──
  聊天型回复是否按气泡计划掷骰  [ Switch ● ]
  第二个气泡的概率            [ 0.55 ]  = 55%
  …
  ── 标点 ──
  短气泡剥句末句号            [ Switch ● ]
  ── 群聊 / 私聊 ──
  插话强制引用锚点            [ Switch ● ]
  私聊补一句                  [ Switch ● ]
  …
```

要点：

- **文件优先在视觉上成立**：路径/预算在上，旧 `persona` 折进「兼容」。
- **散文与机器参数分开**：`STYLE.md` 是部署者手改的散文（本轮只显示路径）；`bubble*` /
  `stripShortPeriod` / `interjectQuote` 是引擎参数，用小标题 `气泡 / 标点 / 群聊 / 私聊` 分段。
- **保留上一轮的 `personaNote` / `expressionNote` 文案**，作为区块说明放在标题下。
- `instructions` 不进 `<details>`：它是常用项，和「额外要求」的语义一致。

---

## 6. 交互与可访问性

| 项 | 约定 |
|---|---|
| Tab 键 | `role=tablist/tab/tabpanel`，roving tabindex（只让当前 tab `tabIndex=0`），←/→/Home/End 切换，`aria-selected`、`aria-controls` |
| 搜索 | `Esc` 清空并归还焦点；结果区 `role=list`；不做 `/` 快捷键（D7） |
| 开关 | `Switch` 自带 `aria-checked`；行标题 `aria-labelledby` 指向可见 label；**只有开关本身可点**，整行不做按钮 |
| 错误 | `aria-invalid` + `aria-describedby` 指向 hint/错误；工具条显示 `invalidCount` |
| 只读 | `shell.writable === false` 时所有控件 `disabled`（`SettingsForm` 已有只读提示） |
| 空结果 | 一句 `searchEmpty`，不放插画 |
| 窄屏 | 单列；输入框 `width: 100%`；不做横向滚动 |
| 动效 | 只有 `<details>` 箭头旋转 120ms；尊重 `prefers-reduced-motion` |
| 焦点 | `:focus-visible` 用 `--dsw-focus-ring-*`，不自定义 outline 颜色 |

---

## 7. 实现细节

### 7.1 `client.js` 目标结构

```js
SECTIONS        // 保持：字段 → 分组（14 组；显式 fields 的顺序决定渲染顺序）
TABS            // 新增：6 个 tab 的定义（id / label / title / sections）
FIELD_HINTS     // 新增：量纲格式化（显式白名单）
NO_HINT         // 新增：后缀命中的豁免集合（先留空）
ENUM_LABELS     // 新增：枚举取值的人话
LABEL_OVERRIDES // 保持/扩充

// 纯函数（导出给测试）
tabOf(sectionId)
filterRows(rows, query)
hintFor(key, value)
labelForEnum(key, value)

// 控件（props 口径与 SettingsValueField 一致）
FieldShell      // label/help/已覆盖/恢复默认/hint/invalid 的统一外壳；layout: 'stack' | 'inline'
SwitchRow       // 官方开关行（B）
SelectField     // 原生 <select>（Input 外观 + 箭头）
NumberField     // Input + 量纲 hint
TextField
ListField       // Input + Pill 预览
LongTextField   // 已有

// 页面
Toolbar         // 搜索 + 只看已改 + 已改/非法计数
Tabs            // 下划线 tab（抄 Plugins 页的 roving tabindex）
SearchResults   // 扁平、可编辑
Section         // 标题 + note + 行
Disclosure      // <details> 兼容区
QQ_BRIDGE       // 组合，仍包在 SettingsForm 里
```

**删掉**：`groupHeader`、`CARD_STYLE`、`CARD_HEAD_STYLE`、`CARD_BODY_STYLE`、`DOT_STYLE`、
`EMPTY_MARK_STYLE`、`CHEVRON_STYLE`、`openId` 状态、`countOverrides` 的组头用法（计数改到工具条）。

**保留**：`createPage`、`build`、`inject`、`specFor`、`describeFields`、`orderedRows`、
`deriveLabel` / `labelOf`、`helpContent`、`LongTextField`、`SettingsForm` 包装。

### 7.2 `project()` 的输出

```js
// 现在：{ shell, sections }
// 改成：
{
  shell,
  tabs: [
    { id: 'connect', label: '连接', title: '连接与准入', sections: [
      { id: 'connection', title: '连接与运行环境', note: undefined,
        rows: [{ ...row, state: model.field(key) }] },
      ...
    ]},
    ...
  ],
}
```

- 模型仍在 `createPage` 里建一次；**切 tab 不重建模型**（草稿不丢）。
- 渲染时只挂当前 tab 的 `Section`；搜索结果直接从 `tabs.flatMap(...)` 过滤。

### 7.3 `renderField` 分派

```js
function renderField(row, props, writable, t) {
  if (row.long) return <LongTextField ... />;
  if (row.kind === 'boolean') return <SwitchRow ... />;
  if (row.kind === 'choice') return <SelectField ... />;
  if (row.kind === 'list') return <ListField ... />;
  if (row.kind === 'number') return <NumberField ... />;
  return <TextField ... />;
}
```

所有控件都接收：

```js
{
  id, label, hint, help, text, overridden, invalid,
  overriddenLabel, resetLabel, invalidLabel, disabled,
  placeholder, numeric, choices, enumLabels,
  onEdit(text), onReset(),
}
```

`FieldShell` 负责统一的 label 行（含 ⓘ / 已覆盖 / 恢复默认）、控件槽、错误/hint 行；
`SwitchRow` 用 `layout="inline"`，其余用 `layout="stack"`。这样**不会**出现两套 chrome。

### 7.4 搜索（纯函数 + 渲染）

```js
function normalize(text) {
  return String(text).toLowerCase().replace(/[\s_-]+/g, '');
}

function filterRows(rows, query) {
  const q = normalize(query);
  if (q === '') return [];
  return rows.filter((row) =>
    normalize(row.label).includes(q) ||
    normalize(row.key).includes(q) ||
    normalize(row.description).includes(q) ||
    normalize(row.section.title).includes(q),
  );
}
```

- `rows` 是已经带 `section` / `tab` 信息的扁平数组；排序稳定（tab → section → schema）。
- 结果行附带 `tabLabel` / `sectionTitle`，用于右侧 `Tag` 和 `aria`。

### 7.5 测试桩要补的 primitives

`test/client.test.mjs` 的假 `require` 需要新增：

| 导出 | 桩的最少行为 |
|---|---|
| `Switch` | 渲染一个带 `aria-checked` 的按钮；`onClick` 调 `onChange(!checked)` |
| `Input` | 渲染 `<input>`，透传 `value` / `onChange` / 其它属性 |
| `Pill` | 渲染 `<button>`，点击调 `onClick` |
| `Tag` | 渲染 `<span>` |
| `IconSearchOutlineRegular` | 渲染一个占位节点即可 |

> 桩要和真组件保持同一套 props（见 §7.3），否则测试全绿、浏览器里炸。

### 7.6 导出面（测试用）

```js
exports.TABS = TABS;
exports.tabOf = tabOf;
exports.filterRows = filterRows;
exports.hintFor = hintFor;
exports.FIELD_HINTS = FIELD_HINTS;
exports.NO_HINT = NO_HINT;
exports.ENUM_LABELS = ENUM_LABELS;
exports.SECTIONS = SECTIONS;        // 已有
exports.describeFields = describeFields; // 已有
exports.QQ_BRIDGE = QQ_BRIDGE;      // 已有
```

---

## 8. 分期、PR 与提交顺序

### 8.1 分期

| 期 | 内容 | 估算 |
|---|---|---|
| **P1 骨架** | `TABS` + `tabOf` + 下划线 tab 组件 + 扁平 `Section` + 官方字段行；字段先用现有控件；删卡片 chrome | 1.5 天 |
| **P2 控件** | `Switch` / 原生 `<select>` + `ENUM_LABELS` / `Input` / 列表 Pill / `FIELD_HINTS` | 2 天 |
| **P3 检索与状态** | 搜索 + 结果行 + `只看已改` + 已改/非法计数 + 空状态 | 1 天 |
| **P4 文案与收尾** | 删除旧 key、补 zh/en、README / CHANGELOG / AGENTS、测试补齐、全量绿 | 1 天 |
| **P5（未来）** | 人设文件读写（附录 B） | 2–3 天 |

### 8.2 PR 建议

**一个 PR、四个提交**（P1…P4 各一个），因为 P1 的中间态（结构变了、控件还是文本框）
单独发布没有意义。提交信息用中文，形如：

```
feat(settings): 设置页改成 6 个 tab + 官方字段行（P1 骨架）
feat(settings): 布尔/枚举/数字换成官方控件 + 量纲提示（P2）
feat(settings): 搜索、只看已改与计数（P3）
docs(settings): 文案、README、CHANGELOG 与测试收尾（P4）
```

---

## 9. 测试计划（`test/client.test.mjs`）

现有 13 条契约保留，并新增/改写：

1. **字段覆盖**：120 个字段在「所有 tab 的合集」里恰好出现一次，且不落「其它」。
2. **tab 映射**：每个分组恰属一个 tab；每个 tab 至少一个区块；6 个 tab 的标签非空；
   `tabOf` 对未知分组返回 undefined（不要静默丢字段）。
3. **控件映射**：每个布尔 → `Switch`；每个枚举 → `<select>`；数字 → `Input`；
   `persona`/`instructions` → textarea。
4. **草稿口径**：点开关写入 `'true'`/`'false'`；选 select 写入枚举字面量；全部仍走 `props.edit`。
5. **切 tab 不丢草稿**：编辑 → 切 tab → 切回，`state.text` 还是新值。
6. **搜索**：按 label / key / description / 区块标题命中；跨 tab；`Esc` 清空；
   结果行可编辑；空结果文案出现；点 tab 清空搜索。
7. **脏状态**：有 `overridden` 行时出现「已改 N 项」；`只看已改` 只留下这些行；
   与搜索叠加时先过滤覆盖、再过滤查询。
8. **只读**：`writable=false` 时开关 / 输入 / select 全部 `disabled`。
9. **量纲**：`FIELD_HINTS` / `NO_HINT` 的 key 都存在；每个 `Ms/Bytes/Chars/Hour/Chance`
   字段都被覆盖；`proactiveIdleMs=2700000` 的 hint 含「45 分钟」。
10. **枚举文案**：每个枚举字段的每个值都有 `ENUM_LABELS` 文案；映射里没有 schema 之外的字段。
11. **标签质量**：不以 `…` / `「` 结尾（沿用上一轮那条）。
12. **不出现重复控件**：同一个字段在页面上只渲染一次（tab 切换不叠加）。

> 仍然不引浏览器：假 `__ModuleLoader__` + 假 primitives（按 §7.5 补桩），在 node 里渲染整页断言。

---

## 10. 已拍板与不做（速查）

| 决策 | 定论 |
|---|---|
| 导航 | 保留顶级「设置 → QQ Bridge」 |
| tab | 6 个；连接 / 会话 / 人格 / 群聊 / 感知 / 记忆；默认连接 |
| 卡片 | 全部删掉，改扁平区块 |
| 折叠 | 只保留「兼容：旧 persona」 |
| 布尔 / 枚举 | `Switch` / 原生 `<select>` |
| 数字 | 只加量纲 hint |
| 搜索 | 有；`Esc` 清空；不做 `/` 快捷键 |
| 脏状态 | 计数 + 只看已改 |
| 保存 | 只用 `SettingsForm` 底栏；不做吸底、不做 Toast |
| tab 记忆 | 不做 |
| 人设文件编辑 | 本轮不做（附录 B） |
| `accessToken` 密钥化 | 本轮不做（§4.3） |
| 依赖 / 构建 | 不变：零依赖、零构建、纯手写 bundle |
| 配置 schema | 不动 |
| 运行时 | 不动 |

---

## 11. 新会话开工清单

### 11.1 先读什么

1. `AGENTS.md`：§2 文件地图、§5.12 设置页、§6「改 Web UI 设置页」、§8 测试、§9 检查清单。
2. 本文件：§0 决策 → §2 官方基线 → §3 IA → §4 控件 → §7 实现 → §9 测试。
3. `client.js`：`SECTIONS` / `LABEL_OVERRIDES` / `describeFields` / `orderedRows` / `specFor` /
   `createPage` / `project` / `renderGroup` / `QQ_BRIDGE`。
4. `test/client.test.mjs`：假 `__ModuleLoader__`、假 primitives、`mountPage` / `rerender` 的用法。

### 11.2 每期的完成定义（DoD）

**P1**

- [x] `TABS` / `tabOf` 就位，14 个分组全部有归属。
- [x] 卡片 chrome 删干净（`client.js` 里搜不到 `CARD_STYLE` / `groupHeader` / `openId`）。
- [x] 下划线 tab 可键盘操作（←/→/Home/End），`aria` 正确。
- [x] 页面 = 标题 + 简介 + notice + 搜索框占位（先不接逻辑）+ tab + 区块。
- [ ] `node --test test/client.test.mjs` 绿（旧断言按新结构改写）。

**P2**

- [x] 26 个布尔渲染成 `Switch`，点一下写入 `'true'` / `'false'`。
- [x] 4 个枚举渲染成 `<select>`，文案来自 `ENUM_LABELS`，空选项 = 用默认值。
- [x] 数字 / 文本 / 列表 / 长文本的控件与 chrome 对齐官方；`已覆盖` + `恢复默认` 都在。
- [x] `FIELD_HINTS` 覆盖所有 `Ms/Bytes/Chars/Hour/Chance` 字段；hint 出现在控件下方。
- [ ] `node --test test/client.test.mjs` 绿。

**P3**

- [x] 搜索按 4 个来源命中，结果行可编辑，空结果有文案。
- [x] `只看已改` 与搜索可叠加；计数随编辑实时变化。
- [x] 有非法项时工具条显示 `invalidCount`。
- [ ] `node --test test/client.test.mjs` 绿。

**P4**

- [x] `envNotice` / `groupsHint` 等旧 key 删干净；zh/en 字典齐全（没有 key 泄露到页面）。
- [x] README「在 Web UI 的设置页里改」改写：6 个 tab、控件、搜索、量纲、唯一下次保存。
- [x] CHANGELOG 在 0.2.0 的「设置页」小节补这轮内容。
- [x] `AGENTS.md` §5.12 补「tab / 搜索 / 控件映射 / FIELD_HINTS」一句。
- [x] 本文件状态改成「已实现（日期）」。
- [x] `node --test test/` 全绿；用例总数写进 AGENTS / README 的基线。

### 11.3 验证命令

```bash
node --test test/client.test.mjs     # 快速反馈
node --test test/                    # 全量（约 35s；基线见 AGENTS §8）
```

真机：

```bash
systemctl --user restart qqbot       # 或 tmux 里 Ctrl-C 后重开
# 打开 http://127.0.0.1:3081/ → 设置 → QQ Bridge
```

手工验收顺序：

1. 6 个 tab 都能切；键盘 ←/→ 能切。
2. 任取一个布尔 → 开关；保存 → 插件重启 → 值仍在。
3. 任取一个枚举 → 下拉；保存 → 值仍在。
4. 任取一个毫秒字段 → hint 显示「= N 分钟」。
5. 搜索 `proactive` → 结果跨 tab；点结果行直接改；`Esc` 回分组视图。
6. 改 2 项 → 顶部「已改 2 项」；点「只看已改」只剩这两行；恢复默认 → 计数减 1。
7. 人格页：路径在上、旧 persona 在「兼容」里；`instructions` 在正文。
8. 断开 OneBot？不需要；只验配置页，不验聊天链路。

### 11.4 交接注意

- **不要改 schema**：`config.js` / `settings.js` / `index.js` 一行都不动。
- **不要改保存语义**：所有编辑仍走 `props.edit` → `SettingsFormModel.save()`。
- **不要加依赖或构建步骤**；`client.js` 仍是手写 `window.__ModuleLoader__.load` bundle。
- **不要用 `SegmentedControl` 选值**（tablist 语义）。
- **不要复制第二套字段 chrome**：统一走 `FieldShell`。
- **不要为了「让测试稳」放宽断言**；偶发红见 AGENTS §8，重跑确认。
- 改完 `client.js` 后，**插件进程要重启**（Loader 按 URL 缓存模块）；浏览器刷新页面。

---

## 12. 验收标准

- [ ] 120 个字段全部可达：进入页面后 ≤2 次点击；搜索能按标签/字段名/描述/区块名找到任意一项。
- [ ] 没有「该用控件却仍是文本框」的字段：26 个布尔全 `Switch`，4 个枚举全 `<select>`。
- [ ] 所有颜色来自 `--dsw-*`；不新增外部 CSS；控件优先用 primitives。
- [ ] 页面在 ~564px 内容宽度下单列不溢出；长标签换行不截断。
- [ ] 切 tab、搜索、只看已改都不丢草稿；保存仍然只有底栏一处。
- [ ] `node --test test/` 全绿；`client.test.mjs` 覆盖 §9 的 12 条。
- [ ] 纯键盘可完成：切 tab、搜字段、改开关、恢复默认、保存。
- [ ] README / CHANGELOG / AGENTS / locale 同步；本文件状态更新。

---

## 附录 A：官方实现索引（本机 `0.2.0-rc.2`）

| 参考 | 路径 | 用途 |
|---|---|---|
| 设置面板几何 | `@deepseek-ai/dsh-client-ui-settings-general/lib/client.js`（`SettingsRoot.module.css` 串） | 800/188/24、导航 16/500、项高 40 |
| 官方开关行 | 同上（`DeveloperToolsRow.module.css` 串） | 14/20 + 12/18、space-between、16px 内边距、分隔线 |
| 官方表单字段 | `@deepseek-ai/dsh-client-ui-primitives/lib/settings-form/fields.module.css` | 13/500 label、34px 控件、12px hint、`.field + .field` 分隔线 |
| 官方卡片 | `.../dsh-client-ui-settings-models/lib/client.js`（`ModelsSection.module.css` 串） | `settings-card-*`、radius-xl、12/14 内边距（本方案不用卡片，只留 token 参考） |
| 官方下划线 tab | `.../dsh-client-ui-settings-plugins/lib/client.js` | 13px、gap 22、active 2px 下划线、roving tabindex |
| 官方 `<details>` | `.../dsh-client-ui-settings-models/lib/client.js`（`customizedSummary`） | 12/500 + 小箭头 + 上下留白 |
| 官方枚举取值 | 同上（`select.zGbnIq_input` + 12px 箭头背景） | 原生 `<select>` + Input 外观，max-width 240 |
| 官方控件 API | `.../dsh-client-ui-primitives/lib/types/*.d.ts` | `Switch` / `Input` / `SegmentedControl`（视图切换用）/ `Modal` / `Toast` |
| 现有页面 | `client.js` | `SECTIONS` / `specFor` / `describeFields` / `orderedRows` / `LongTextField` / `QQ_BRIDGE` |

---

## 附录 B：未来工作 —— 在设置页里编辑 `PERSONA.md` / `STYLE.md`（P5，本轮不做）

**为什么要 Host 侧**：浏览器读不到 `cwd/.qq-persona/PERSONA.md`。DSH 的官方通道是
`ctx.remote` + typert：

- Host：`index.js` 提供一个服务（如 `qqDocuments`），方法 `read()` / `write(kind, text)` /
  `validate(kind, text)`；写用 `filestore.writeTextAtomic`，写前备份 `.bak`，路径仍走
  `docfile.js` 的 `cwd` 边界。
- 包：`package.json` 增加 `exports["./typert"]`（手写 `TYPERT` 清单，typert-loader 支持手工清单）
  与 `exports["./remote"]`；`dsh.client.inject` 加 `@deepseek-ai/dsh-api-remotes`。
- Client：`ctx.remote.qqDocuments.read()`；文件来源卡片 + `Modal` 编辑 + 字符计数 + 解析警告
  （复用 `persona.js` 的解析器做**保存前校验**：有警告照实提示，但仍允许保存 —— 运行时本来就会
  回退上一版 / 内置人设，写坏不会让机器人不说话）。
- 安全：只允许 `personaFile` / `styleFile` 解析出的两个路径；拒绝 `../`、绝对路径、`cwd` 外；
  单次写入上限（如 256 KB）；不接受浏览器传来的任意路径。
- 测试：假 `ctx.remote`；越界拒绝；写失败保留旧文件；解析警告透传。

如果将来不做：保持现状（只显示路径），在 README 指路手改流程即可。
