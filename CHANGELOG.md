# 更新记录

版本号按[语义化版本](https://semver.org/lang/zh-CN/)走。0.x 阶段配置项与行为都可能变，
每次改动以 `Config` 的 schema 与 `docs/` 下的分册为准。

## 未发布

一次「记忆与表情包的写入面」修整，起因是三起真实事故：模型编造 `.qq-media/<哈希>` 发图、
`COGNITION.md` 里 3 条格式不全的条目从来没进过提示词、迁移时按行号回填差点吃掉记忆。

### 默认值变化（可能影响已有部署）

**`config.js` 的 schema 默认值改成了「本仓库这套配置」**，新装即按这套跑。老部署如果在
profile 的 `cordis.patch.yml` 里写过这些字段，自己的值仍然优先；没写的会跟着变：

| 字段 | 旧默认 | 新默认 | 影响 |
|---|---|---|---|
| `agentPreset` | `''`（部署默认预设） | `qq` | 新装默认挂本 bundle 的最小预设，而不是可能带 shell 的 `standard` |
| `allowTools` | `[]`（不限制） | 17 个工具名 | 默认收窄到「只读文件 + 检索 + 联网 + 十个 `qq_*`」；`qq` 预设里的 `write` / `edit` 默认拿不到 |
| `activeFollow` | `false` | `true` | 被叫到之后，窗口内同一个人接着说话也算数（还要过抽卡）；群里聊热了会进入多人搭话 |
| `proactive` | `false` | `true` | 冷场后会自己开口（仍有 7 道闸，安静阈值 45 分钟） |
| `burstSingleMaxChars` | `0`（用 80） | `100` | ≤100 字按聊天型走气泡计划，超过的按信息型完整发送 |
| `recallAddressed` | `answer` | `drop` | 被 @ 的消息撤回后**真的不回**（原本是「照常答、只是不引用」） |
| `recallPrivate` | `false` | `true` | 私聊撤回也处理（还没投给模型的那条不回） |

想回到「最保守」的那一套，在部署的 patch 里显式写回去即可：
`agentPreset: ''`（或 `none`）、`allowTools: []`、`activeFollow: false`、`proactive: false`、
`recallAddressed: answer`、`recallPrivate: false`。

### 新增：定时提醒

- **`qq_remind_create` / `qq_remind_list` / `qq_remind_cancel`**：让 Agent 把「明早 8 点提醒我
  交作业」变成一条持久化任务；到点由插件直接发 `@目标 + 文本`，**不经过模型**，重启不丢。
- **三种模式**：`text` 原样发固定文案（最可靠、不花 token）；`agent` 让模型用自己的语气说，
  失败 / 超时 / SKIP 都退回固定文案；`prompt` 到点按指令做事（可调工具，默认关闭，只给受信者）。
  `reminderModes` 是上限，默认 `agent`。
- **时间**：一次性或每天 / 工作日 / 每周 / 每月；`at` 用本地 `YYYY-MM-DDTHH:MM`，也接受
  `in_minutes`；周期任务的第一次已过去时自动滚到下一个未来时刻，`monthly` 在小月夹到月末。
- **安全默认值**：只能提醒创建者自己；`@` 别人与 `@全体` 默认关（`reminderMentionOthers` /
  `reminderAllowAll`）；每人每天 5 条、每会话 20 条待发；`reminderUsers` 是受信名单。
  提醒正文原样发送、**不解析** `[[图片]]` / `[[@]]` 标记，@ 只来自创建时解析好的 QQ 号。
- **重启 / 断线**：任务文件 `data/reminders.json`；错过时刻在 `reminderGraceMs`（默认 10 分钟）
  内补发，超过标 `missed`；周期任务不补历史；agent 轮跑到一半进程被杀时补一条固定文案。
- **发送是 at-most-once**：先记账再发，宁可重启后补一条文本，也不重复 @ 全体。
- **`/reset` 不影响提醒**：任务属于会话而不是某一轮 Session。
- **设置页能看见记着的任务**：新增独立的「提醒」tab（提醒同样服务私聊，不再塞在「群聊」
  里），列表放在这一页最上面，按状态列出待发与最近历史（时间 / 模式 / 目标 / @ 名单 /
  创建者 / 已发次数 / 上次错误），每 15 秒自动重读，也可以手动刷新；数据走 Connection
  认证栅栏内的一条只读路由。
- 详见[定时提醒](docs/reminders.md)；设置页在「提醒」tab。

### 行为变化

- **攒批窗口默认从 1.2 秒放到 2 秒**（`batchWindowMs: 1200 → 2000`）：1.2 秒常常只够接住
  「同一口气连发的两句」，群里几个人前后脚 @ 时第三句还是会掉到下一轮。要更快就自己调小，
  `0` 仍然是「来一条回一条」。`batchMaxWaitMs` 的上限逻辑不变（小于窗口时按窗口算）。
- **表情按 QQ 的「大表情」发**：从 `.qq-stickers/` 发出去的表情，`image` 段带上
  `sub_type: 1`（QQ 的 `picSubType`，真人从表情面板发出来的那些就是非 0）。不带这个标记时
  QQ 只当它是一张普通图片 —— 照片样式、按原图像素铺开，群里一眼就不像人发的表情。
  其它来源（`.qq-media/<哈希>` 的截图、URL、工作目录里的照片）照旧是普通图片。
- **发表情只认收藏目录**：回复正文里的 `[[图片: …]]` 只接受 `.qq-stickers/` 里的文件；
  `.qq-media/<哈希>`（LRU 缓存）与工作目录里的其它文件一律拒绝，并回一句
  「（那张表情我这儿没有，发不出去）」。别人刚发的图想发回去，先 `qq_save_sticker` 存一次。
  `qq_send_image` 工具没有这条限制（显式动作）。
- **发图失败会回灌提示词**：失败原因（路径不存在 / 不在收藏目录）会写进下一轮「QQ 渠道」提示，
  模型不会再照着编下一个哈希。
- **`qq_memory` 新增 `upsert` / `remove`**：按名字新增或替换一条认知 / 表情包条目，只给字段，
  格式与分节由代码生成（`COGNITION.md` 按 `type` 归到 `缩写` / `谐音` / `专名` / `其它`）。
- **整份 `write` 有护栏**：`COGNITION.md` / `STICKERS.md` 的条目数掉到 90% 以下直接拒绝
  （`force: true` 放行）；写入前把旧版本存进 `<memory>/.history/`（每个文件最近 20 份）。
- **写入时归一化**：重复的二级标题只留一个、完全相同的行去重（`STICKERS.md` 按名字去重）。
- **热梗段按首见日期注入**：不再取「文件末尾 15 条」—— 整理文件（合并标题、分节）不再改变
  它每轮记得什么。
- **`ops doctor` 新增五条长期记忆检查**：`COGNITION_UNPARSED`、`COGNITION_DUPLICATE_SECTION`、
  `COGNITION_PATH`、`STICKER_PATH_MISSING`、`STICKER_MEDIA_PATH`。
- **`qq_memory read` 会点出解析不了的行**（它们永远不会进提示词）。
- **标点契约改讲频率，不再讲配额**：以前的「一句里逗号最多一个」被模型当成额度，结果
  「几乎每句话都有一个逗号」（真实观感投诉）。内置契约与 `.qq-persona/STYLE.md` 改成「多数
  句子不带逗号；想说两件事就分成两条发」，并补了三句反例 → 正例的 few-shot。逗号仍然
  不做字符串替换（会改动断句与语义）。
- **`lintStyleDoc` 新增第七类 `COMMA_QUOTA`**：`STYLE.md` 里再出现「逗号、顿号也正常」
  「一句里逗号最多一个」这类许可式写法，启动日志会点出来（含改法），不阻断。

### 修复

- **表情目录带完整路径注入**：`STICKERS.md` 的「已收藏」条目以前只给「名字（含义）」，
  模型得自己猜扩展名（`.jpg` / `.gif` 混放），猜错时发送侧找不到文件，群里收到一句
  「那张表情我这儿没有」（真实事故：`敲盆.gif` 被写成 `敲盆.jpg`）。现在注入
  「名字（含义）→ 完整路径」，并给写错扩展名的来源加了一层同名纠正。
- 迁移脚本认不出被反引号包着的路径（`` `.qq-media/x.gif` ``），导致报告「搬走 0」、
  `STICKERS.md` 一直没生成。
- **复读的表情按表情发回去**：复读别人刚发的一张图时，以前一律按普通图片发 —— 群里看到的是
  照片样式的图，一眼就不是表情（真实反馈）。现在照**原消息**的类型发：原消息是表情（`sub_type`
  非 0 的收藏表情、带 `emoji_id` 的商城表情）就带 QQ 的大表情标记，原来是截图/照片就仍是普通
  图片（标成长图会被 QQ 按表情裁小）。判据是新加的纯函数 `isStickerSegment`。
- 迁移脚本按「第几个 `- ` 行」回填保留条目，遇到解析器跳过的碎条目会整体错位，
  把后面的条目挤丢（实测会吃掉「森美奈美」「洛天依」）。
- 迁移生成待办名字时取前 12 个字，得到「Q 版蓝毛女仆脸：蓝发盘」这种半句；现在截到第一个标点。

### 被撤回的消息（新功能，见 `docs/recall.md`）

三层：**安全层与数据层永远生效，行为层才是配置项**。

- **不再引用一条已经不在的消息**（安全层，所有人受益）：回复本来是带着 `reply` 段指向被回复的
  那条发出去的，而 `sendOne` 失败时 `sendParts` 会整条停下 —— 撤回一到，那条回复剩下的气泡
  一起发不出去，群里看到的只是「它没理人」。现在撤回事件到达时先清掉这个会话里所有指向它的
  引用（`messageId` 清空、`userId` 留着，于是 `replyStyle` 四档都自动退化成正确的降级）。
- **记一份「最近看见过什么」**（数据层）：QQ 不提供回查已撤回消息的接口，所以每个会话在内存
  里留最近 30 条（id / 发送者 / 显示名 / 占位符正文 / 有没有 @ 过它 / 投递与回复进度）。不落盘，
  重启即清；对不上的撤回只记一条 info（「没看见」是有效状态，不是错误）。
- **`recallMode`**：`off`（只做上面两层）/ `ignore`（默认，还没投递的那条不再投给模型；被 @ 的
  再按 `recallAddressed` 决定）/ `tease`（被 @ 的那条**就地改写成撤回提示**，这一轮直接调侃；
  已经回过的按闸门补一句）。
- **`recallAddressed`**（默认 `drop`）：被 @ 的那条还没投出去就撤回时，`drop` 是**真的不回**
  （「撤回 = 当没收到」），`answer` 才照常答、只是不引用（@ 是明确点名，认为点名了就该有回应
  的话选它）。
- **`recallScope`**（默认 `to-me`）：`all` 才会为群里别人的撤回开口（那等于承认它每条都看，
  语义接近 `proactive`，所以默认关）。
- 补一句要过一串闸门：`recallChance` / `recallCooldownMs` / `recallDailyMax` / `recallMaxAgeMs`
  / `recallScope`，外加几条硬性的 —— 自己的消息被撤不处理、管理员代撤（`operator_id ≠ user_id`）
  不调侃、这一轮还在飞时不补刀。掷中即消耗（`SKIP` 也算）。
- **默认不给原文**（`recallTeaseQuote: false`）：复述别人撤掉的话是最常见的社交事故。
- **`recallPrivate`**（默认开）：私聊撤回也处理（还没投给模型的那条同样不回）；`tease` 时建议
  关掉 —— 私聊里调侃「你撤什么」很容易变成冒犯。清引用照做。
- **长期记忆留一行 tombstone**（`recallMemoryMark`，默认开）：转录是只追加的原料，所以追加一行
  `kind: "recall"` 而不是删行 —— 摘要 Agent 一眼看得出「这条撤了、别当事实」，原文仍然在。
- 本仓库的 `cordis.patch.yml` 把这三项显式写出来钉住：`recallMode: ignore` +
  `recallAddressed: drop` + `recallPrivate: true`（现在也是 schema 的默认值；写出来是为了将来
  改默认时本部署不跟着漂）。
- 新模块 `recall.js`（4 个纯函数，12 条闸门可单测）+ `test/recall.test.mjs`（15 条）+ bridge
  里 `bootRecall` 那组（11 条：三种位置 × 三种模式、环境上下文摘除、转录标记）。

## 0.2.0 — 2026-10-17

按当时的重构设计做的四层拆分：**人格 / 表达 / 感知 / 运维**。
一句话概括：把「你是谁」「怎么说」「看到了什么」「出事了怎么查」从 `index.js` 那一坨提示词与
if 里拆成可单独测试、可单独回滚的模块。**升级前请读「BREAKING」那一段。**

### BREAKING

- **移除 JM（禁漫）下载旁路**。`jm.js`、`scripts/jm_download.py`、`qq_jm_pdf` 工具、`/jm` 指令、
  15 个 `jm*` 配置项与 `test/jm.test.mjs` 全部删除；`package.json` 的 `exports["./jm.js"]` 与
  `files` 里的 `jm.js`、`.gitignore` 里的 `.qq-jm/` 一并去掉。
  - `cordis.patch.yml` 里残留的 `jm*` 会变成**惰性字段**（schemastery 对未知键透传），不会启动失败；
    `allowTools` 里残留 `qq_jm_pdf` 时插件只记一条 warn（白名单里有不存在的工具名）。
  - `/jm 422866` 不再是特殊指令，作为普通消息进模型（群里仍然要 @ 或满足触发条件）。
  - **数据不删**：`.qq-jm/` 里的旧 PDF、`.venv/` 里的 jmcomic 依赖都原样留着。要清就显式跑
    `node scripts/ops.mjs cleanup jm --apply`（只删 `.qq-jm/`，先列文件再生效，绝不碰 `.venv`）。
- **`burstSingleMaxChars` 语义变了**：从「短回复强制并成一条」变成「聊天型 / 信息型的门槛」。
  想要旧行为（闲聊永远一条）请用 `bubbleChatMax: 1` + `bubbleGamble: false`。
- **短气泡句末的「。」会在发送前被剥掉**（`stripShortPeriod`，默认开）。只动句末唯一的一个
  「。」；问号、感叹号、省略号、句中句号都不碰。
- **图片不再挂引用**：整轮只有图时引用直接丢弃，有文字时引用只挂第一个**文字**气泡。

### 人格与表达（新的两层）

- **`persona.js` + `cwd/.qq-persona/PERSONA.md`**：人设只写「是谁」——身份 / 背景 / 性格 / 场景。
  性格按 `名字｜底色/点缀｜强度｜触发条件｜表现｜禁忌` 一行一条，**底色最多一条**（始终在场，
  是语气的地板不是台词），点缀按触发条件上场、一次最多演一个。旧配置 `persona` 在没有
  `PERSONA.md` 时仍然生效；文件存在时它被忽略并记一条 info（避免两套人设叠加）。
  文件写坏（半截、只剩标题）时退回上一版，再退回配置 / 内置人设 —— **人设写坏绝不让机器人不说话**。
- **`style.js` + `cwd/.qq-persona/STYLE.md`**：表达只写「怎么说」——气泡、标点、表情、私聊 / 群聊。
  机器参数（`bubble*` / `stripShortPeriod` / `interjectQuote`）在配置里，散文与参数互不解析。
- **气泡计划**：一轮回复在**发送前**掷一次骰，决定发到第几个气泡（第一个永远发；
  第二个 55%，之后每个 ×0.5；以问号结尾的追问钩子 ×1.3 封顶 0.9）。含图段不掷、信息型不掷
  （超过门槛就完整发送），所以「要讲清楚的事」不会被骰子吞掉。发送途中对方又说话了，
  聊天型剩下的气泡就不再发（信息型该讲完还得讲完）。
- **私聊补一句（L2，默认开）**：回完对方、对方安静 15 秒后，最多再开一轮看看有没有想补充的
  （可 SKIP）。它**不搭 `proactive` 那趟车**（那是群里主动开口的总开关），有自己的
  `privateAfterthought*` 开关 / 概率 / 日上限；空消息、命令、出错、SKIP 之后的轮次不补，
  对方在这期间接了话也不补。
- **提示词槽位化**：场景 → 人设 → 表达契约 → 记忆索引 + 热梗 → 能力清单 → 额外要求 →
  **硬性规则（最后，最高优先级）**。每条规则只出现一次；「绝不两拍」拆成两句（信息型的
  「短 + 长」仍然禁止，聊天型的「短 + 短」允许）。
- 本部署那份混着风格规则的 `persona` 已从 `cordis.patch.yml` 搬进 `.qq-persona/PERSONA.md`
  与 `.qq-persona/STYLE.md`（蓝毛女仆人设拆成「身份 / 背景 / 温柔底色 / 傲娇点缀 / 场景」+
  「总体 / 标点 / 表情包 / 私聊 / 群聊」）。

### 群聊搭话（治「莫名其妙」）

- **`speech-policy.js`**：把准入、A/C 抽卡、插话准入收成一个纯判据，返回 `intent`
  （`addressed` / `continued` / `interject` / `none`）。`admit` 只剩「凑入参 + 记账」。
- **插话的投递文案换了**：不再是 `kaguya: 晚上吃啥`（kaguya 并没有问它），而是
  「（群里在聊天，这句不是叫你的。kaguya 说：晚上吃啥）」+「你要接就接这一句……不想接就只写
  SKIP」。`speakerLine` 也按 intent 换措辞，不再一律说「刚跟你说话的人」。
- **插话强制引用锚点**（`interjectQuote`，默认开）：引用的是 `admit` 时快照的具体
  `message_id`，不再看 `replyStyle: auto` 的漂移判断（那个判断在「紧接着回」时恰好不引用，
  于是插话裸奔）。引用发不出去 → 退化成 @ 说话人 → 再不行才裸文本，都记 warn。
- **C 路准入收紧四条**：@ 了别人、命令、纯媒体（没有文字）、机器人自己 —— 一条都不接。

### 认知与表情包分离

- **`cognition.js`** + 两个文件：`COGNITION.md` 只装**语言**（梗 / 黑话 / 缩写 / 谐音，键是
  文字写法含变体），`STICKERS.md` 装**表情包**（键是收藏后的文件名）。认知库里**不许出现
  文件路径**，表情包目录里**不许出现 `.qq-media`**（那是会过期的缓存）。
- `qq_save_sticker` 新增可选 `meaning` / `scene`：存完图顺手往 `STICKERS.md` 补一行；没给
  `meaning` 时进「未收藏」待办区（不进提示词）。目录写失败**不回滚图片**。
- 提示词里的表情包目录改成「名字（含义）」而不是裸文件名；新增「最近学的梗」段（最近 15 条
  「置信：确认」，≤1200 字），谐音梗不用先 search 再答。
- skill 拆分：新增 `learn-meme`（文字梗 → `COGNITION.md`）与 `learn-sticker`（表情包 →
  先收藏再写 `STICKERS.md`）；`update-cognition` 保留为**一句话分诊**的兼容壳；
  `message-digest` 的认知段落改成分诊写法。
- 新增 `scripts/migrate-cognition.mjs`：把老 `COGNITION.md` 里「以路径为键」的条目一次性迁到
  `STICKERS.md`（用画面指纹认同一张重新编码过的图；认不出就标「原图已过期」放进未收藏区）。
  **默认 dry-run**，`--apply` 才写，写前备份，`--json` 给报告。

### 感知层

- **`modalities.js`**：消息段 → `Observation` → 占位符渲染。系统表情带名字、语音给时长、
  视频给时长 + 封面路径、文件给大小、合并转发给条数、`json`/`xml` 卡片解析出标题 / 域名 / 链接。
  `onebot.js` 的 `messageToText` 改为委托它（既有输出逐字节不变）。
- **`links.js`**：卡片解析 + 可选的 URL 预览（`linkPreview` **默认关**）。SSRF 防护覆盖
  scheme / userinfo / localhost / `*.local` / `*.internal` / 私有与保留网段 / 各种数值变形的
  IPv4 / IPv6 回环与内网，每一跳重定向都重新校验；超时、字节上限、只收 `text/html`/`text/plain`。
- **`interactions.js` + 戳一戳**：以前 `handleEvent` 第一行就把 `notice` 全丢了，现在被戳会回应。
  `pokeMode` = `random`（默认，按 `pokeReplyChance` 回戳或走一轮）/ `poke` / `text` / `ignore`；
  每个会话 `pokeCooldownMs` 冷却 + `pokeDailyMax` 每日上限（防两个机器人互戳）。
  只回应**戳机器人自己**的，戳别人一律不记。新增 `qq_poke` 工具（群里必须显式指定戳谁）。
- 视频只下封面（`videoCover` 默认开，`videoMaxBytes: 0` 不下载整段）；语音只做时长占位，
  **不下载、不转写、不起任何外部进程**。

### 运维

- **`ops.js`（纯计划）+ `scripts/ops.mjs`（执行器）**：一套命令跨平台。
  `doctor` / `status` / `restart` / `logs` / `install` / `uninstall` / `napcat` /
  `migrate cognition` / `cleanup jm` / `selftest`，都支持 `--json`（stdout 只有一个对象，
  版本号 `schema: 1`；人话走 stderr）。
- 退出码：`0` 全部通过 / `1` 有 error 级 findings / `2` 需要人工或提权 / `3` 脚本自身出错。
- `--apply` **默认关**：写 cwd 外的步骤（systemd unit、计划任务、NapCat 配置、profile）都带
  `requires: human|root`，agent 默认只拿计划、把命令原样贴给人。幂等（写前备份，重复执行不重复写）。
- 新增 `docs/ops.md`（给 agent 的排查配方）。

### 配置

新增 28 项，全部有中文 `.description()` 并在设置页分了组（「表达（STYLE.md / 气泡 / 标点 / 补一句）」
与「感知与互动（链接 / 视频 / 戳一戳）」两张新卡片）：

- 人格与表达：`personaFile` / `personaMaxChars` / `personaSceneOverlays` / `styleFile` /
  `styleMaxChars` / `bubbleGamble` / `bubbleContinueChance` / `bubbleContinueDecay` /
  `bubbleGambleMaxChars` / `bubbleChatMax` / `stripShortPeriod` / `shortPeriodMaxChars` /
  `interjectQuote` / `privateAfterthought` / `privateAfterthoughtChance` /
  `privateAfterthoughtIdleMs` / `privateAfterthoughtDailyMax`
- 感知与互动：`linkPreview` / `linkPreviewTimeoutMs` / `linkPreviewMaxBytes` /
  `linkAllowPrivateHosts` / `videoCover` / `videoMaxBytes` / `pokeReply` / `pokeMode` /
  `pokeReplyChance` / `pokeCooldownMs` / `pokeDailyMax`

### 设置页（跟着这次重构一起改）

之前的设置页只是把新字段「塞」进了已有分组：页面结构没动、标签靠描述自动截、人设卡还把
**已经失效的旧 `persona` 排在第一行**。这次补齐：

- **人设卡改成「文件优先」的顺序**：`personaFile` / `personaMaxChars` / `personaSceneOverlays`
  在前，旧 `persona` 与 `instructions` 在后。实现上顺手修了一个静默的坑：分组字段的顺序原来
  由 schema 决定，`SECTIONS[].fields` 那份声明顺序只用来判归属 —— 现在显式清单说了算（前缀组
  仍按 schema 顺序），于是「声明成文件优先」这件事才真的落到界面上。
- **两张卡的标题与说明**：「人格与提示词（PERSONA.md 优先）」「表达（STYLE.md / 气泡 / 标点 /
  补一句）」，展开时顶上多一行组说明（`personaNote` / `expressionNote`）：文件存在时哪一项不生效、
  机器参数照常叠加。光看字段名看不出这层关系，而这正是重构后最容易踩的坑。
- **修掉自动标签截出来的半句**：`stripShortPeriod` 原来是「短气泡句末的「」、`pokeReplyChance`
  是「pokeMode」、`bubbleContinueDecay` / `personaSceneOverlays` / `apiKeyRotate` 等被截成半句。
  补了 `LABEL_OVERRIDES`，并加了一条用例钉住「标签不以 `…` 或 `「` 结尾」。
- **私聊 / 群聊的「补一句」不再撞名**：`activeChime*` 与 `privateAfterthought*` 原来都叫
  「补一句前的安静时间 / 每天最多补几句」，现在分别标明「群里」「私聊」。
- 插件在 Web UI 里的标题/描述（`locale/zh.json` / `en.json`）同步成重构后的四层说法。

### 设置页重设计（6 个 tab / 搜索 / 官方控件）

按当时的设置页重设计（v2 定稿）把 120 个字段从「14 张折叠卡片、默认只展开第一组、
布尔与枚举都是文本框、数字没有量纲」改成可扫、可找、可理解的页面：

- **6 个下划线 tab**：连接 / 会话 / 人格 / 群聊 / 感知 / 记忆（默认「连接」），14 个分组各归一个
  tab（`TABS` / `tabOf`，测试钉住「每个分组恰属一个 tab、120 项合计分布 12/23/19/29/22/15」）。
  卡片 chrome（`CARD_STYLE` / `groupHeader` / `openId`）全部删掉，改成**扁平区块**：标题 + 0.5px
  分隔线 + 一行一个字段；只剩「人格」页的旧 `persona` 折进「兼容：旧 persona（文件存在时不生效）」。
- **官方两种字段行**：布尔 → `Switch`（标题 + 说明在左、开关在右），枚举 → 原生 `<select>`
  （Input 外观 + 箭头，人话在 `ENUM_LABELS`：`mention` → 「按 @ 提及」、`never` → 「一律拒绝
  （无人值守）」……），数字 / 文本 → `Input`，`persona` / `instructions` → 多行框，白名单在输入框
  下面给可点的 `Pill` 预览（点 × 删一个值）。「已覆盖 + 恢复默认」统一由 `FieldShell` 画，不再
  每个控件一套 chrome。
- **数字量纲**：`FIELD_HINTS` 白名单给毫秒 / 字节 / 字符 / 小时 / 概率 / 倍率补一句只读换算
  （`proactiveIdleMs: 2700000` → 「= 45 分钟」、`digestAtHour: 4` → 「= 04:00」、
  `mediaMaxBytes: 8388608` → 「= 8 MB」），输入框里仍是原始值、不做双向换算；测试反向钉住
  「凡是名字以 `Ms`/`Bytes`/`Chars`/`Hour`/`Chance` 结尾的字段都必须命中 `FIELD_HINTS` 或 `NO_HINT`」。
- **搜索**：按短标签 / 字段名 / `.description()` / 区块标题跨 tab 命中（`proactive`、
  `proactive_idle_ms`、`攒批窗口` 都行），结果行本身可编辑、右侧 Tag 标出来源 tab，`Esc` 清空；
  不做 `/` 快捷键。
- **脏状态**：工具条显示「已改 N 项」（`overridden` 行数）与「只看已改」开关，两者可与搜索叠加；
  有非法项时多一个「N 项待修正」。保存仍然只有 `SettingsForm` 底部那一个按钮（不吸底、不 Toast），
  切 tab / 搜索 / 过滤都不丢草稿（模型只建一次）。
- **无障碍与样式**：`role=tablist/tab/tabpanel` + roving tabindex + ←/→/Home/End；开关 / 输入 /
  下拉在只读部署里全部 `disabled`；颜色一律走 `--dsw-*` token，样式是 factory 里注入的一段
  `<style>`（官方插件同款做法，仍然零外部样式表 / 零构建），`prefers-reduced-motion` 下关掉
  `<details>` 箭头的过渡。
- **人设与表达页**：文件路径与预算在前、旧 `persona` 折进「兼容」、`instructions` 在正文；机器参数
  按「气泡 / 标点 / 群聊 / 私聊」分了小标题，散文（`STYLE.md`）与参数互不解析。
- `test/client.test.mjs` 从 13 条扩到 **28** 条（假模块系统 + 迷你渲染器把整页展开成节点树），
  覆盖字段 / tab / 控件映射 / 草稿口径 / 搜索 / 只看已改 / 量纲 / 只读；全量基线 **476 → 491**。
- `accessToken` 密钥化（D6）与人设文件编辑（P5）**本轮不做**，以后要动时按 `client.js` 的现有契约扩展。

### 测试

- 基线从 **321** 变成 **476**：删掉 JM 的 19 条，新增 `persona` / `style` / `speech-policy` /
  `modalities` / `links` / `interactions` / `cognition` / `migrate-cognition` / `ops` 九个纯函数
  测试文件，以及桥接层的插话锚点 / 准入收紧 / 气泡计划 / 私聊补一句 / 戳一戳 / 链接预览 /
  视频封面 / 语音占位等端到端用例。
- **沙箱里不再有「13 条跳过」**：那 13 条全是为 JM 的真 spawn 准备的探针，随 JM 一起删掉了。

## 0.1.1 — 2026-10-15

修 Windows 桌面版**安装流程**里实测出来的一批毛病。全部在「NapCat 那一侧 / 安装 / 文档 / 测试」
这一层，**QQ 会话链路一行没动**。

> 这一版**没有真的发出去**（原计划作为首个补丁版），所以后面「发布包验收」查出来的问题直接并进了
> 同一节 —— 拿到这个 tag 的人看到的就是修完的版本。最要紧的两条：装进 profile 时**校验链接指着谁**
> （原来会静默加载旧代码），以及 `.cmd` **去找桌面版自带的那份 Node**（原来不装 Node 就装不上）。

**发布包验收（拿 0.1.1 的 zip 在新机器上照 `docs/install.md` / `docs/windows.md` 走一遍）查出来的问题**

- **装进 profile：链接已存在时校验它指着谁（原来会静默装错代码）**。原来只判断
  `node_modules\@qqbot\dsh-plugin-qq` **存在与否**：存在就打印「链接已存在」跳过，可
  `package.json` 里的 `link:` 已经被改成了新仓库路径。而解析**完全由链接决定**（DSH 的
  `resolveBundleDir` 走 `createRequire(profile/package.json).resolve.paths()`，那行声明只给
  pnpm / 插件管理界面看），于是出现「manifest 说加载 A、实际加载 B」而**一句报错都没有**。
  实测现场：链接还指着 dev 仓库、manifest 已经改成发布包目录。现在读链接的实际指向再比
  （`pluginLinkState`，纯函数、有单测）：指别处就删掉重建，并把原来指着哪打出来；指着本仓库就
  什么都不做；那里如果是**一个真目录/文件**（手工拷进去的插件），不删它，只提醒「加载的是它、
  不是本仓库」。三个读法是一串实测出来的回退：Windows 上 junction 只有 `realpathSync.native`
  跟得动（`readlinkSync` 对 reparse point 一律 `EINVAL`，普通 `realpathSync` 有时把链接自己当
  结果返回），目标已被删掉时只剩 `readlinkSync` 答得出来。**删链接也不能用 `unlink`**：junction
  对它一律 `EPERM`，要退到 `rmdir`（实测：删完链接消失、目标目录里的文件一个不少）。这两条都有
  真建 junction 的用例钉着。
- **`napcat-setup.cmd`：桌面版自带的那份 Node 现在找得到（原来挡住新用户）**。机器 PATH 上没有
  `node` 时脚本直接失败，而桌面版自带一份完整的 Node（`<DSH>\resources\runtime\<版本>\dependencies\node\bin\node.exe`，
  实测 v24.x）。现在按「PATH → `DSH_DESKTOP_NODE_EXECUTABLE` → 桌面版安装目录」的顺序找，常见
  位置都探；一个都没找到才报错，并把确切路径的写法打出来。新增 `--where` 只回答「用的是哪份
  node」。刻意**不**退到 `resources\runtime\bin\node.cmd`：那份包装自己是
  `"%DSH_DESKTOP_NODE_EXECUTABLE%" --expose-internals %*`，而桌面版双击启动时那个变量不存在 ——
  调它只会得到一句 `'" "' is not recognized`（实测）。这个文件里另外记了三个 cmd 的坑：
  `if defined` 认「一个空格」的值、引号套引号会报没有行号的语法错、以及这个文件必须是 CRLF。
- **`package.json` 的 `files` 补上漏掉的两个模块**：`mention.js`（`index.js` / `tools.js` 都 import
  它）与 `desktop.js`（`scripts/napcat-setup.mjs` import 它）。zip 走 `git archive`，发布包不受
  影响；但任何 `npm pack` / `pnpm add <tarball>` 装出来的包都会缺文件 → `ERR_MODULE_NOT_FOUND`
  起不来。现在是 `private: true` 只发 zip，所以是个潜在的雷，先拆掉。
- **文档**：「Windows 桌面版」开头加了一个七步流程，把**「第二次运行脚本」的必要性**摆到明处
  （`config/onebot11_<QQ号>.json` 与 `config/webui.json` 都是 NapCat **第一次启动时**才生成的）；
  「下载与开始」的前置条件改对了（**Node ≥ 22 只有源码路线与那个配置脚本需要，桌面版自带**）；
  目录表后面补了「装完了，但它一句话都不说」的排查顺序，第一条就是上面那个链接问题 ——
  DSH 启动日志里的 `skipping profile bundle "@qqbot/dsh-plugin-qq": cannot resolve …` 意味着插件被
  **静默跳过**（DSH 照常启动，群里当然没反应）。另外写明了**发布包里跑不了测试**：zip 里没有
  `node_modules/`（`git archive` 只带被跟踪的文件），而五个测试文件 import `index.js` 时会连带
  import 那三个 peer 包 —— 验收报告里「跑包内测试」那一步只有开发机（跑过
  `dev-node-modules.mjs`）才成立，不是发布包坏了。

**一键配置现在认得出刚解压的 NapCat**

- 之前只认「`config/onebot11_<QQ号>.json` 已经存在」的目录 —— 而那个文件是 **NapCat 登录之后**
  才生成的。发布版安装流程恰恰是「解压 → 立刻跑脚本」，于是脚本回一句「没找到 NapCat 安装
  目录」，`--qq` 那条「先把骨架配置写好、登录后即可用」的路永远走不到（实测踩过：仓库根下
  明明躺着一份 `NapCat.Shell`）。
- 现在多一条弱判据：目录里有 NapCat 自带的启动件（`launcher*.bat` / `launcher-elevate.ps1` /
  `napcat.mjs` / `loadNapCat.js` / `NapCatWinBootMain.exe`）也算（`looksLikeNapcatShell`）；
  强判据（有账号配置）仍然优先。插件启动自检与脚本共用这条判据，所以两边的结论不会打架。

**快速登录：不用每次掏手机扫码**

- `--qq <号>` 现在顺便把 `<NapCat>\config\webui.json` 的 `autoLoginAccount` 设成这个号，
  NapCat 以后启动就自己快速登录。只动那一个字段、改前备份、幂等（已经对了连备份都不产生）；
  `webui.json` 还不存在（NapCat 没启动过）时**不凭空造**它 —— 那会把它 WebUI 的 host / port /
  token 一起抹掉，而是提示你登录完再跑一次。不想要这条加 `--no-auto-login`。
- 前提是本机已经为这个号留下过登录记录；没有记录时 NapCat 会退回二维码，那不是失败 ——
  扫一次码，之后才会走快速登录。

**启动 NapCat 必须提权（原来会崩）**

- `--start` 原来用 `cmd /c start` 拉起 `launcher-user.bat` —— 那是包里**刻意不提权**的变体。
  实测（QQ 9.9.35-52892 + NapCat 4.18.38）：不提权时注入其实**成功**（崩溃转储的模块列表里
  能看到 `NapCatWinBootHook.dll` 已加载、QQ 的 Node 运行时 `major.node` 也在），但 QQ 随后在
  `QQNT.dll` 里撞 `0x80000003`（STATUS_BREAKPOINT）当场死掉，控制台只剩一句 `Process exited.`；
  提权启动一切正常。而 NapCat 自己的兼容表与 `qqnt.json` 都覆盖这个 QQ build、QQ 安装目录也
  干净，所以这不是「版本不支持」。
- 现在改走官方文档让用户双击的 `launcher.bat`（会自己提权），并把 `--qq` 当 `-q <号>` 传给
  NapCat 做快速登录；提权方式是我们自己 `Start-Process -Verb RunAs`（命令走 Base64，
  路径里有空格/中文也不会被引号转义拆坏）。
- 新增 `--window normal|min|hidden`（默认 `min`）。那个控制台窗口就是 NapCat 本体，**关掉它
  等于停掉机器人**；`hidden` 适合已经能自动快速登录、不想看见窗口的机器。首次登录要扫码，
  得用 `normal` / `min`。

**不要那个黑框框：`--autostart install`（计划任务 + 无窗口 + 免 UAC）**

- 原来 `--window hidden` 只是把窗口样式交给 `Start-Process`，而 `launcher.bat` 在非管理员时
  会用 `launcher-elevate.ps1` 把 **`wt.exe`（Windows Terminal）** 提权起来重跑自己 ——
  Windows Terminal 没有「隐藏启动」这回事，那个窗口一定会出现。现在 `hidden` 换了一条路：
  提权跑 `wscript.exe`（GUI 宿主，自己不带控制台），由它用 `WshShell.Run` 的窗口样式 `0`
  起 `cmd.exe /s /c "launcher.bat" -q <号>`，控制台从创建那一刻就是隐藏的。
- 新增 `--autostart install|remove|status`：注册一个计划任务（`dsh-qq-bridge-napcat`），
  **登录时以最高权限、无窗口**启动 NapCat。装的时候点一次 UAC，以后启动不再问、也没有窗口
  （`RunLevel: HighestAvailable` + `LogonType: InteractiveToken` + `IgnoreNew` + `PT0S`；
  为什么是这几个值写在 `scheduledTaskXml` 上）。任务 XML 与包装脚本放在 NapCat 目录里，
  跟着它一起删；`--autostart status` 能看上次跑成没成。
- 装计划任务时顺手把 NapCat 日志改成写文件（`consoleLog=false` / `fileLog=true`，先备份、
  幂等、`--no-log-to-file` 可关）：窗口看不见了，日志是唯一的现场。脚本还会把 WebUI 的地址与
  token（从 `config/webui.json` 读，原本是打在控制台里的）打出来 —— 看日志、扫码登录、改配置
  都在那儿，所以隐藏启动也不影响第一次登录。
- 三个都是实测踩出来的细节，注释里写了理由：`wscript.exe` 必须带 **`//B`**（不加时 WSH 一出错
  就弹一个看不见的模态错误框卡住：本地实测同一份脚本加 `//B` 跑通、不加就卡住等点）；命令行走
  `cmd.exe /s /c` 而不是把 `.bat` 直接交给 `WshShell.Run`（后者走文件关联，zip 解压出来的
  `.bat` 带 Mark-of-the-Web，会弹「打开文件 - 安全警告」）；包装脚本按 **UTF-16LE + BOM**
  落盘（WSH 读无 BOM 脚本按 ANSI 解码，中文注释与中文路径会乱码）。另外
  `Start-Process -ArgumentList` 收数组时**不会**替参数加引号，带空格的路径要自己带引号
  （`hiddenStartPlan` 的用例钉住了这条）。
- `--autostart install` 在 `config/webui.json` 还不存在时（这份 NapCat 从没启动过）会拦住：
  那时既没有二维码可看、WebUI 也没生成，隐藏启动等于把自己关在门外；`--force` 可跳过。

- 插件启动自检现在分得清「目录配错了」（warn）与「这份 NapCat 还没登录过」（info）：后者是
  发布版安装流程里的正常中间态，日志会直接给出下一步（`inspectNapcat` / `repairNapcat` 新增
  结构化的 `noAccount` 标记，不靠文案匹配 —— 以前那种情况会记一句「自检没跑成」，吓人且没用）。

**测试**

- `test/napcat.test.mjs` 从 11 条加到 14 条：新增 `looksLikeNapcatShell`（弱判据的边界）、
  `withAutoLoginAccount`（只动一个字段 / 幂等 / 不凭空清空）、`startPlan`（必须 `-Verb RunAs`、
  三种窗口样式、认不出的取值按默认、换平台或缺启动器时给一句人话）三组用例，
  以及 `noAccount` 这条结构化信号的正反两面。
- 顺手修掉 `test/bridge.test.mjs` 里 **23 处「只等 Agent 就断言收件箱」的竞态**：假 Host 的
  `create()` 是**如实照搬真宿主**的 —— Agent 先造出来并记进 `created`，消息由插件在**之后**
  才 `agent.followup(...)` 投进去，20ms 的轮询会偶尔抢在投递之前（本机跑全量时抓到三处不同的
  用例翻车，其中「群 @ 那条」单独跑都能稳定复现，症状是 `inbox[0]` 为 undefined、
  `completeTurn` 拿着 `message: undefined` 去开 turn）。这 23 处现在统一走新的
  `untilInbox(host, n)`；只关心「创建了几个 Agent」的用例仍然直接用
  `until(() => host.list.created[0], …)`。
- 用例总数 304 → 307；**全量连跑三遍全绿**。
- 发布包验收之后又补了几条：`test/desktop.test.mjs` 新增 7 条（`pluginLinkState` 的五种状态、
  以及**真建一条 junction** 验「谁跟得动它」和「删它不会动目标目录里的文件」）。
- 沙箱里那 13 条不再「红」，而是**带原因跳过**：`jm.test.mjs` 的 6 条与 `bridge.test.mjs` 里
  `/jm` 的 7 条必须真的 `spawn` 一次假 python 才验得到，而 DSH 的沙箱禁止带管道的子进程
  （`spawn EPERM`）—— 原来它们会红（其中 5 条还要先各自挂满 5 秒超时），被误读成「发布包坏了」。
  现在按 `jm.js` 导出的 `spawnAvailable` 跳过并打印原因；探测的正是这条链路要用的那种 spawn
  （带管道），所以「插件能不能用」与「测试跳不跳」用的是同一个事实。**探测脚本要往 stdout 写一个
  字符**才试得出来：`node --version` 走控制台、不碰管道，在被拦的环境里照样返回 0。
  基线因此写成：**普通终端 321 条全过；DSH 沙箱里 308 过 + 13 跳过**（原来文档里记的 304 已过时）。
- 另记一处已知偶发：`proactive forgets its own pacing when the conversation is reset` 等个别用例
  在**全量同进程连跑**时偶尔红，单独跑永远绿（`until` 轮询与真实计时的竞态），遇到了重跑确认。

## 0.1.0 — 2026-10-15

首个公开版本：把 QQ（OneBot v11，NapCat / Lagrange / go-cqhttp）接到 DeepSeek Harness 上。

**双向链路**

- QQ 私聊、群里被 @ 的消息 → 一个持久化的 DSH Session。Session id 由会话 key 经 SHA-256
  **确定性**派生，Harness 重启后同一个人再发消息会 `resume` 原有会话，聊天记忆不丢。
- 回复取该轮里**最后一条有文本的** assistant 消息，中间步骤的工具调用不发 QQ；
  `aborted` / `forked` / `interrupted` 静默丢弃，出错回一句固定道歉。
- 任何 DSH Agent（包括 Web UI 里的主会话）都能用 `qq_send_message` / `qq_send_image`
  主动发消息、发图。
- 前后脚到的消息先攒一个窗口（`batchWindowMs`，默认 1.2 秒）再投给 Agent：几个人同时 @
  它，一轮里一起接住。回复换行即分条、按打字节奏发出、引用被回复的那条；
  写 `[[@昵称]]` 发出去是真正的 @ 而不是一串 QQ 号。

**表情包**

- 会挑表情包发；**整条回复只写一行标记时，只发一张表情、一个字都不说**。
- `qq_save_sticker` 把别人刚发的那张存进 `.qq-stickers/`：只允许写该目录内、
  文件名洗成单层、张数受上限约束（QQ 侧唯一能写盘的能力，边界见 docs/media.md）。

**自动复读（不经过模型、不建会话）**

- 群里连着出现同一条消息时跟一句；连着两张一样的表情包时把那张原样发回去。
- 图片判「同一张」留了两层：字节完全相同只是快路；QQ 会把同一张表情包按发送者重新编码
  （实测同一张有 94657B / 131307B / 79284B 三种形态），所以第二层是 16×16 灰度的画面
  指纹（dHash），只比字节的话这一整块在真实群里永远不触发。指纹懒算并按路径缓存。

**像真人一样说话**

- 拆句、打字延迟、抖动、频率上限、活跃时段（`withinActiveHours`，支持跨零点）。
- **主动说话**（`proactive`，默认关）：群里冷下来之后，插件往该群自己的会话里伪造一条
  带 `SKIP` 出口的提醒，让它带着环境上下文与长期记忆自己想一句 —— 一次醒来最多一个群，
  掷中即消耗当天额度。冷场管「主动」，这一块管「不做独白」。
- **活跃对话**（`activeFollow` 默认关）：聊起来之后不必每句都 @。一对一的免 @ 接话、
  群里够条数够人数之后的**多人搭话**（累计概率抽卡，抽不中就继续听，倾听时间与攒批
  窗口同倍放大）、以及「回完对方安静一会儿再补一句」。活跃窗口只靠别人发来的消息往后滑 ——
  否则机器人自己就能给窗口续命。

**长期记忆**

- 每条消息落盘成转录；每天定时由一个**独立摘要会话**把它整理成「这个群记得什么」
  （`MEMORY.md`），顺带用 `update-cognition` skill 学会群里的梗，看不懂的二次元梗先走
  `moegirl` skill 查萌娘百科。
- 聊天时用 `qq_transcript` / `qq_memory` 查。摘要**成功之后才推进日期**，所以摘要是后台
  会话、被压缩或重启都不影响记忆，没跑成也不会把消息算丢。

**运维**

- `/reset` 开新一轮会话：换一个确定性的 Session id 从头开始，旧会话留在磁盘上存档，
  代次**落盘**（只在内存里的话重启会把上一轮 resume 回来）。默认谁都不能用
  （`resetUsers` 空 = 全关，与 `allowUsers` 的语义相反）。
- 每天 04:00 从 `data/api-keys.txt` 里挑下一个**探测通过**的 key，经 `ctx.credentials`
  写进凭据文件，当场生效不用重启；池子不存在、没有第二个能用的、或 key 来自启动环境时
  什么都不做（宁可不动也不能把 bot 换成不可用的状态）。
- 两种部署都有一手：Linux 容器 + systemd（`deploy/qqbot.service`，`Restart=always`）；
  Windows 桌面版（`scripts/napcat-setup.mjs` 把 NapCat 的 WebSocket 配置、profile 的
  `.env`、desktop profile 的依赖与 bundles 一次配好，幂等 + 先备份，可 `--dry-run`）。

**在 Web UI 里改配置**

- 侧栏 **设置 → QQ Bridge**：一百多个配置项做成**单独一页**，按十几张折叠卡片分组
  （默认只展开第一组，组名右边的记号是「这一组改过几项」）。字段来自 `config.js` 的
  schema、标签与说明来自 `.description()`，所以**加了新配置项页面自动多一行**；
  `persona` / `instructions` 是整段提示词，单独一张卡片、用多行输入框改。
  `accessToken` 这类秘密不下发（只告诉你「配了 / 没配」）。原先只能手写
  `cordis.patch.yml`，而「只写几个字段」的那种写法会把整套配置整块顶掉。
- 保存写的是**当前 profile 的完整 config**，`!!js` 表达式原样保留 —— 从环境变量读的
  `endpoint` / `resetUsers` 不会因为点了一次保存就变成写死的字面量。保存之后插件会
  自动重启一次（配置走 volatile 热更新，而连接、定时器、工具注册都是 `apply()` 里装配的）：
  断一次 OneBot 连接，**聊天记忆不受影响**（会话 id 是确定性的，下一条消息照样 resume）。
- 浏览器半侧是手写的 `client.js`（`window.__ModuleLoader__.load({...})` bundle，本仓库
  没有构建步骤），契约由 `test/client.test.mjs` 钉住：字段全覆盖、分组不漏、折叠默认只
  展开第一组、布尔 / 逗号列表 / 枚举三种草稿的读写口径。

**工程**

- 零运行时依赖：只用 Node 全局 `WebSocket` / `fetch` / `node:*`，OneBot v11 客户端是手写的。
- 纯 ESM，Node ≥ 22，无构建步骤，改完即用；类型信息全写在 JSDoc 注释里。
- 304 条测试用例：真实插件模块 + 真实 OneBot 客户端 + 假 OneBot 服务端 + 假 Harness ctx
  （含假 timer），跑完整的入站 → Agent → 出站往返；设置页那半侧用假的 `window.__ModuleLoader__`
  与假 `useState` 跑，不需要浏览器。

**已知限制**

- 面向个人自用，不保证开箱即用：需要自己装好 DSH，模型凭据在 Web UI 的 Models 页填一次。
- QQ 消息按**不可信输入**处理：默认 `approvalPolicy: 'never'`、群消息默认只在被 @ 时触发、
  `/reset` 默认谁都不能用。`allowTools` 再收一层 QQ 会话能用的工具。
- `jm.js` 那条旁路（`/jm` 下载漫画转 PDF 发回会话）需要 Python 与它自己的依赖，
  与上面的 QQ 链路彼此独立。
