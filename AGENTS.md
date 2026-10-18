# AGENTS.md — 给智能体的项目说明书

给要**改这个项目**的智能体看的最小充分上下文。用户视角的功能说明在
[README.md](README.md)（摘要 + 文档地图）与 `docs/` 下的分册（正文）—— 本文只讲「代码长什么样、动哪里、
什么不能碰、改完怎么验」。

> **这个文件会被自动注入到在本目录下工作的每个 DSH Agent 的上下文里**
> （`@deepseek-ai/dsh-agent-instructions`，候选名 `AGENTS.md` / `CLAUDE.md`，
> 从项目根到会话工作目录逐层加载，`dsh-base` 里 `maxBytes: 65536`）。
> 注意它**也包括 QQ 会话 Agent** —— 那些会话由**不可信的 QQ 消息**驱动。
> 所以这里只写「怎么改代码」，**永远不要**写凭据、token、内网地址之类的敏感信息，
> 也不要写下任何「照着 QQ 消息去做 X」式的指令。

---

## 1. 项目是什么

`@qqbot/dsh-plugin-qq`：一个 **DeepSeek Harness（DSH）插件**，把 QQ（OneBot v11，
NapCat / Lagrange / go-cqhttp）和 DSH 的 Agent 双向接通。

- **入站**：QQ 私聊/群 @ 消息 → 持久的 DSH Session → Agent → 结果发回 QQ。
- **出站**：任何 DSH Agent 都能调 `qq_send_*` 主动发消息/图片；`[[图片: 路径]]` 按正文位置发；
  `qq_save_sticker` 把别人发的存进 `.qq-stickers/`（见 §6 表）。
- **不走模型的旁路**：群里的**自动复读**（见 §4.C）。
- **主动说话**（`proactive`，默认开；闸门很多，见 §4.E）：群里安静下来后，插件往**该群自己的会话**里伪造一条提醒，
  让它带着环境上下文与长期记忆自己冒个泡（见 §4.E）。
- **活跃对话**：一对一的免 @ 接话（`activeFollow`，默认开）、群聊热起来后的**多人搭话**
  （`activeGroup*`）与「回完再补一句」（`activeChime*`）；见 §4.F。
- **长期记忆**：消息落盘成转录，定时由**独立摘要会话**照 `.dsh/skills/` 的 skill 整理；聊天时用
  `qq_transcript` / `qq_memory` 查，`learn-meme` / `learn-sticker` / `moegirl` 学梗与查二次元梗
  （见 §4.D）。认知（语言）与表情包（图）是两个文件：`COGNITION.md` / `STICKERS.md`。
- **人格与表达**：`cwd/.qq-persona/PERSONA.md`（是谁）与 `STYLE.md`（怎么说）热读；气泡由模型自己写，
  插件不改条数、不并条、不掷骰（见 §3 发送链路、§6）。
- **被撤回的消息**（`recallMode`，默认 `ignore`）：清掉指向已撤回消息的引用（不做会让整条回复
  发不出去），再按配置假装没看到 / 改写成调侃 / 已经回过的补一句（见 §4.I）。
- **定时提醒**（`reminder`，默认开）：Agent 用 `qq_remind_create` 存一条到点的任务，插件到点直接发
  `@目标 + 文本`（不经过模型）；`text` 原样、`agent` 让模型换语气、`prompt` 到点做事（默认关）；
  重启不丢、断线有补发窗口（见 §4.J）。
- **感知与运维**：戳一戳 / 卡片 / 视频封面 / 语音占位（`modalities.js` / `links.js` /
  `interactions.js`），以及跨平台 `scripts/ops.mjs doctor --json`（见 §11）。
- **每天轮换模型凭据**（`apiKeyRotate`，默认开）：每天 04:00 从 `cwd/data/api-keys.txt` 挑一个
  **探测通过**的 key 交给 `ctx.credentials.set()`；池子不存在、没有第二个能用的 key、或 key 由
  启动环境提供时什么都不做（见 §4.H）。

技术约束（决定了代码的写法，别无意打破）：

| 约束 | 原因 |
|---|---|
| **零运行时依赖** | 只用 Node 全局 `WebSocket` / `fetch` / `node:*`，`package.json` 没有 `dependencies`（OneBot 客户端手写，没有构建步骤）。三个被 Harness 注入的包声明在 `peerDependencies` 里 —— 那是**解析规则的要求**，见 §2 末尾与 §5.11。 |
| 纯 ESM，Node ≥ 22（本机 v26.11.1），无构建步骤 | `"type": "module"`，改完即用。 |
| 没有 TypeScript，JSDoc 注释代替 | 全部类型信息在注释里。 |
| 注释、日志、面向用户的文案**一律中文** | 与 README 一致，别在中途切成英文。 |

## 2. 文件地图

```
index.js      4963 行  插件本体：运行时状态、事件路由、发送/准入/复读/存表情包/戳一戳/主动说话/活跃对话、连接生命周期
persona.js      273 行  `PERSONA.md` 的解析与渲染：身份 / 背景 / 性格（底色 + 点缀）/ 场景；坏文件回退上一版
style.js        361 行  表达层：聊天型 / 信息型判定、标点清洗、表达契约渲染；`STYLE.md` 的热读（**没有**掷骰 / 随机数）
speech-policy.js 134 行  「这条群消息该不该进 Agent、以什么身份进」：intent（addressed / continued / interject / none）+ C 路四条排除
cognition.js    345 行  认知库与表情包目录的**纯解析**：`COGNITION.md` / `STICKERS.md` 的条目、热梗段、目录行
docfile.js       83 行  cwd 内的热读文档（同步 + `size:mtime` 缓存 + 截断 + 越界拒绝），人设与表达共用
modalities.js   474 行  感知层：消息段 → `Observation` → 占位符（图片/表情/语音/视频/文件/卡片/转发）
links.js        830 行  卡片解析 + URL 预览（SSRF 防护、重定向逐跳校验、大小/超时/内容类型上限）
interactions.js 208 行  戳一戳的纯判据：该不该回、回戳还是走一轮、冷却 / 每日上限
recall.js       270 行  被撤回的消息的纯判据：认事件、要不要补一句（12 条闸门）、两段伪造提醒的文案
reminders.js   1000 行  定时提醒：时间推算 / 校验 / 模式决策（纯函数）+ 任务文件、单定时器、重试与兜底
ops.js          913 行  运维的**纯计划**：平台识别、doctor findings、service/install 步骤、退出码
scripts/ops.mjs 1671 行  运维执行器 + CLI（`doctor` / `status` / `restart` / `logs` / `install` / `napcat` / `migrate` / `cleanup` / `selftest`），`--json` + `--apply`
scripts/migrate-cognition.mjs 364 行  老 `COGNITION.md` 的路径条目一次性迁到 `STICKERS.md`（画面指纹认图、默认 dry-run、写前备份）
chatter.js      171 行  群里「谁在说话」的三本账（插话序号 / 回答指向 / 热度窗口）：只暴露语义动作，不暴露 Map
mention.js      209 行  `[[@昵称]]` → OneBot `at` 段：纯函数解析 + 「昵称 → QQ 号」名单（名单挂在会话记录上）
speaking-rules.js 330 行  「什么时候该主动开口」的纯判据（闸门 / 抽卡 / 补一句 / 私聊补一句）：普通入参 → 布尔
util.js        410 行  **不碰运行时状态**的纯函数：sessionIdFor / 文本压缩 / 本地时间 / 写边界 / key 池解析与打码 / withinActiveHours 等（完整清单见本节末尾）
filestore.js   108 行  「原子写 / 尽力而为读」（读不到返回空而不是抛错），记忆、转录、表情包都走它；`writeTextAtomicUtf16` 专给 Windows 那两个产物
config.js      227 行  配置 schema（**唯一真相来源**）：纯数据，一百多条带中文 .description() 的字段；**根上是 `.volatile()`**（设置页的前提，见 §5.12）
settings.js    331 行  配置的运行时视图：取默认值 / 强制类型 / 夹紧 / 去空白全在这里，`index.js` 只读 settings.*
client.js     2181 行  **浏览器半侧**（手写 bundle）：把 schema 投影成设置页自己的一页（`settings.section`），7 个 `TABS` / 15 个 `SECTIONS`；保存走 Host 的 settings 写路径（见 §5.12）
tools.js       943 行  宿主平面工具的**声明**（qq_send_* / qq_poke / qq_save_sticker / qq_list_conversations / qq_transcript / qq_memory / qq_remind_*），依赖由 index.js 显式传入
memory.js     1414 行  长期记忆子系统：转录落盘、记忆文件读写（两个记忆工具的能力来源）、STICKERS.md 的追加、每日摘要循环；依赖由 index.js 显式传入
onebot.js      637 行  OneBot v11 客户端 + 纯函数（分条/复读/延迟/媒体采集/@ 名单提取）；文本渲染委托 `modalities.js`
media.js       327 行  入站媒体：QQ 的图/表情包 → 按内容哈希落盘 → 给模型 read_image 的本地路径
image.js       149 行  出站图片：本地路径 / URL → 校验（大小、格式、目录越界）→ base64:// 段；收藏目录里的表情额外带 `sub_type: 1`（QQ 的「大表情」）
napcat.js      828 行  NapCat 那一侧：目录探测（强判据 = 有账号配置；弱判据 = 有它自带的启动件）、只读探测与**幂等**写 websocketServers（含备份）、快速登录 / 日志改文件 / WebUI 地址、`startPlan`（提权）、`hiddenStartPlan`（`wscript //B` + VBS 隐藏窗口）、`scheduledTask*Plan`；插件自检与一键脚本共用
desktop.js      约 150 行  装进桌面版 profile 的纯函数：`.env` 段落幂等替换、manifest 改写、`pluginLinkState`（链接指着谁）/ `removePluginLink`（junction 对 `unlink` 是 EPERM，退到 `rmdir`）
perceptual.js 约 1080 行  图片指纹：JPEG(DC)/PNG/GIF → 16×16 灰度 → dHash（复读判同一张画面）
scripts/napcat-setup.mjs + .cmd  Windows 一键配置（网络配置 + 快速登录 + .env + 装进 desktop profile；`--start` / `--autostart` / `--window`），幂等 + 先备份
scripts/dev-node-modules.mjs      Windows 上铺 `node_modules`（按依赖闭包拷贝真实文件），只服务开发与测试
scripts/release.mjs               打发布包（`git archive` 源码树 + 干净的 NapCat → `dist/<名>.zip`），打完体检，命中账号配置/登录态就整体失败
docs/{install,windows,configuration}.md  安装与运行 / Windows 桌面版 / 配置项
docs/{persona-style,speaking,repeat,proactive,media,recall,memory,reminders}.md  行为分册（人格 / 说话 / 复读 / 主动开口 / 媒体 / 撤回 / 记忆 / 定时提醒）
docs/{sessions,tools,security,ops,development}.md  会话 / 工具与能力面 / 安全 / 运维排查 / 开发测试
.dsh/skills/message-digest/SKILL.md    聊天记录 → 长期记忆的流程（定时摘要与「以前说过什么」用它）
.dsh/skills/learn-meme/SKILL.md        文字梗 / 黑话 / 谐音 → COGNITION.md 的流程
.dsh/skills/learn-sticker/SKILL.md     表情包 → 先 qq_save_sticker 收藏、再写 STICKERS.md 的流程
.dsh/skills/update-cognition/SKILL.md  **兼容壳**：只做一句话分诊（旧名字还在用）
.dsh/skills/moegirl/SKILL.md           二次元梗 → 萌娘百科 MediaWiki 接口查意思的流程（只读，不落盘）
test/bridge.test.mjs  集成测试：假 OneBot 服务端 + 假 Harness ctx（含假 timer），跑完整往返
test/{persona,style,speech-policy,modalities,links,interactions,cognition,migrate-cognition,ops}.test.mjs
                      0.2.0 新增的纯函数测试：人设 / 气泡 / intent / 消息段 / SSRF / 戳一戳 / 认知 / 迁移 / 运维
test/recall.test.mjs  撤回的纯判据：认事件 / 12 条闸门逐个翻 / 文案里必须有 SKIP、默认不给原文
test/reminders.test.mjs  定时提醒：时间边界（月末/闰年/工作日）、模式决策、存储/重试/补发
test/settings.test.mjs  配置归一化的契约测试（默认值 / 非法值 / 白名单不 trim 这类刻意的不对称）
test/chatter.test.mjs   「谁在说话」三本账的**不变量**测试（合并两本账就会红的那种）
test/speaking-rules.test.mjs 主动说话 / 免 @ 接话 / 搭话抽卡 / 补一句的判据：每个用例从「通过」的基准入参出发只翻一个字段
test/mention.test.mjs  `[[@昵称]]` → at 段的纯函数测试：标记边界、认不出来就丢、名单按会话隔离
test/util.test.mjs      纯函数边界：写边界、memorySlug、本地时间、errorText、key 打码、isVolatileRef/liveConfig
test/client.test.mjs    设置页契约测试（假模块系统 + 迷你渲染器）：字段全覆盖 / tab / 控件 / 草稿 / 搜索 / 只看已改 / 量纲
test/filestore.test.mjs 原子读写与「读不到就返回空/undefined，不抛错」这条失败语义
test/perceptual.test.mjs  图片指纹的单元测试（同图不同编码 / 异图 / 畸形输入 / 解压炸弹）
test/image-fixtures.mjs  上面两个测试共用的图片 fixture（真编码的字节，不是 test 文件）
cordis.patch.yml      插件自带 bundle patch：注册 `qq` Agent 预设（含 skill 平面）+ 插件 config
locale/{zh,en}.json   插件在 Web UI 里的标题/描述
deploy/qqbot.{service,env.example}  systemd user unit 与凭据模板
README.md             用户文档摘要 + 文档地图（细节在 docs/；改行为要同步对应分册；「30 秒开始」一节指路 Releases）
CHANGELOG.md          更新记录（发 Release 的说明从对应那一节里粘）
AGENTS.md             **本文件**：给改代码的智能体的说明书（DSH 会自动注入上下文）
```

**数据目录**（运行时生成在 `cwd` 下）：`data/`（会话缓存 + `/reset` 标记 + `api-keys.txt` 池子 +
`reminders.json` 提醒任务，gitignore）、`.qq-media/`（入站图 LRU，gitignore）、`.qq-stickers/`（表情包，gitignore）、
`.qq-memory/`（转录 + 摘要 + 认知 + `STICKERS.md`，gitignore）、
`.qq-persona/`（**人设与表达规则，是部署者的资产，故意提交进仓库**）。前四个**必须在 `cwd`
内**，否则各自记 warn 并停用；`.qq-persona/` 同样必须在 `cwd` 内，配到外面只记 warn 并回退
到配置 / 内置人设。

### 依赖方向（保持单向，别造环）

```
index.js ──▶ config.js（schema）/ settings.js ──▶ image.js（只借 DEFAULT_IMAGE_MAX_BYTES）
         ──▶ tools.js ──▶ mention.js / onebot.js / image.js
         ──▶ chatter.js（三本账）/ mention.js（`[[@昵称]]` → at 段）/ speaking-rules.js（纯判据）
         ──▶ speech-policy.js ──▶ speaking-rules.js（intent 判定；C 路四条排除也在这里）
         ──▶ persona.js ──▶ docfile.js ──▶ util.js（pathInside）/ style.js ──▶ docfile.js
         ──▶ modalities.js（消息段渲染）/ interactions.js（戳一戳）/ links.js（卡片与 URL 预览）
         ──▶ cognition.js（认知与表情包目录的纯解析；memory.js 也用它）
         ──▶ docfile.js（人设 / 表达规则的热读）
         ──▶ memory.js ──▶ util.js / filestore.js（长期记忆子系统）
         ──▶ reminders.js ──▶ util.js / filestore.js（定时提醒的任务/调度；发送与 Agent 轮留在 index.js）
         ──▶ util.js（纯函数，无 IO）/ filestore.js（原子读写）
         ──▶ onebot.js / media.js / image.js / perceptual.js
         ──▶ napcat.js（配置探测与幂等写入 + 快速登录 / 启动计划）
                      └── index.js 自检与 scripts/napcat-setup.mjs 共用
         ──▶ ops.js（运维纯计划）──▶ napcat.js / desktop.js；scripts/ops.mjs 执行它
         ──▶ desktop.js（.env 段落、manifest 改写）
                      └── scripts/napcat-setup.mjs 用它，test/desktop.test.mjs 钉它
                      └── media.js 用到 onebot.js 的占位符/嗅探约定（image.js 从 util.js 取 pathInside）
test/*  ──▶ 直接 import 上述模块（不经过 Harness）；bridge.test.mjs 只 import index.js
```

**没有环**，这条要守住：`tools.js` / `settings.js` / `memory.js` / `reminders.js` / `napcat.js` / `desktop.js`
**都不 import `index.js`** —— 它们需要的东西一律由 `index.js` 在装配时显式传进去（见 §3）。
反过来的话就是循环依赖，ESM 下会在加载期炸成 `Cannot access before initialization`。

三个被 Harness 注入的包（`@deepseek-ai/schemastery` / `dsh-tools` / `dsh-llm`）在
`package.json` 里是 **`peerDependencies`**（不是 `dependencies`）：DSH 的解析规则是
「linked root 里只有声明成 peer 的名字才由运行中的安装提供」，否则宿主与插件各持一个实例。
裸跑测试时仓库需要有这三个包 —— Windows 靠 `node scripts/dev-node-modules.mjs --from
<DSH checkout>`（见 §11）。

## 3. `index.js` 的结构（动代码前先认路）

`apply(ctx, config)` 是一个大闭包，**所有运行时状态都是闭包里的 Map**（重启即清空，
只有会话历史落在磁盘上）。按文件内 `// ----` 分节读，行号是当前版本：

| 区域 | 关键符号 | 说明 |
|---|---|---|
| 顶部常量 | `CHANNEL_SECTION_ORDER=8950`、`PRESET_NONE`、`QUOTE_TEXT_CHARS`、`STICKER_PROMPT_MAX` | 调提示词用 |
| 配置 schema | **不在这里**：在 `config.js`（第 136 行只是 `export { Config } from './config.js'`） | 唯一真相来源，`.description()` 就是 Web UI 上给用户看的文档 |
| 配置的取值 | **不在这里**：`settings = createSettings(liveConfig(config), process.cwd())`（第 198 行）之后一律读 `settings.*` | 取默认值/夹紧/去空白都在 `settings.js`；`index.js` 里**没有一处**直接读 `config.xxx`。`liveConfig` 必须调：schema 是根 volatile（§5.12），`apply()` 拿到的是引用 |
| 运行时状态 | 第 243–534 行 | `conversations`(key→会话) / `sessionIndex`(sessionId→key) / `turnOwners` / `submitted` / `transcripts` / `ambient` / **`chatter`**（三本账，见 `chatter.js`；搬出去前叫 `chatterSeq` / `groupChatter` / `quoteSeq`）/ `repeatStates` / `mediaResolutions`（记忆的账已搬去 `memory.js`）/ **`recent`**（「最近看见过什么」，见 §4.I；不落盘）；会话记录里还挂着 `sessionGeneration`（第几轮，`/reset` +1）/ `lastActiveAt` / `lastBotSpeakAt` / `activeInterposeSeq`（插话序号快照）与主动说话、活跃对话的记账（见 `blankConversation`） |
| Agent 装配 | `ensureAgent` `resolveAgentPreset` `mountAgentPreset` `restrictAgentTools` `channelPrompt` `personaLines` `styleLines` `hardRules` | 见 §7。`channelPrompt` 是**槽位化**的：场景 → 人设 → 表达契约 → 记忆/热梗 → 能力 → 额外要求 → **硬性规则（最后）** |
| 发送链路 | `enqueueSend` `sendToConversation` `replyPieces` `sendParts` `sendOne` `quoteHead` `conversationMentions` | 串行队列保证同一会话不乱序；`sendOne` 顺带记 `lastBotSpeakAt`；`replyPieces` 走「拆标记 → 拆条 → **标点清洗**」；**没有掷骰 / 随机数 / 条数上限**（模型写几行发几行）；`quoteHead` 只给第一个**文字**气泡挂指向（图永不挂；被回复的那条只有表情时也不引用；没有「插话必须引用」这条规矩）；正文里的 `[[@昵称]]` 在 `sendParts` 里换成 `at` 段 |
| 会话管理 | `resetConversation` `conversationFor` `sessionIdFor` `resetMarkerDir` `loadConversationResetCounts` `writeConversationResetCount` `refreshSessionGeneration` | `/reset` 开新一轮（**不删旧会话**，代次 +1 并落盘），以及在线会话列表（新一轮时连主动说话的节奏一起清） |
| 准入与复读 | `admit` `noteChatter` `touchActivity` `rememberAmbient` `registerParticipant` `maybeRepeat` `repeatStep` `sketchOf` `sameCandidate` | 白名单、群触发判定、环境上下文（**顺带登记「谁可以被 @」**）、复读状态机；`admit` 里的 A/C 抽卡与插话准入**收在 `speech-policy.js`**，这里只剩凑入参 + 记账 |
| 戳一戳 | `handlePoke` `pokeBack` `pokeTodayUsed` | 通知事件（`notice/notify/poke`）；判据在 `interactions.js`，冷却 / 每日上限在会话记录上；回戳只打给戳它的人 |
| 撤回 | `noteSeen` `findRecent` `handleRecall` `clearQuoteFor` `dropPending` `dropAmbient` `markReplied` | 通知事件（`notice/group_recall` / `friend_recall`）；判据在 `recall.js`；见 §4.I |
| 主动说话 | `proactiveSweep` `proactiveEligible`（适配器）`proactiveSpeak` `proactiveNudge` `busyWithTurn` `proactiveTodayCount` | 见 §4.E；**闸门在 `speaking-rules.js`**（`proactiveEligible` / `proactiveSkip`），这里只是把会话记录凑成入参的适配器；`withinActiveHours`（util.js）是纯函数 |
| 活跃对话 | `noteActiveMessage` `activeFollowAllows` / `activeTurnsLeft` / `activeTalkChance` / `activeTalkAllows` / `chimeAllows` / `chimeDelay` / `batchScale`（适配器）`groupTalkActive` `scheduleChime` `cancelChime` `runChime` `chimeSpeak` `chimeNudge` `chimeTodayUsed` | 见 §4.F；A（一对一免 @）与 C（多人搭话）在 `admit` 里判，够资格后共用一次抽卡（`talkMisses`）；倾听倍数在 `holdForBatch`，B（补一句）挂在 `turn/end` 之后 |
| 攒批 | `enqueue` `holdForBatch` `flushBatch` `submitBatch` `renderBatch`；`batchWindow` / `batchCap` / `batchScale` 是 3 行适配器，算法在 `speaking-rules.js` | 前后脚到的消息合成一条再投给 Agent；多人搭话时窗口与上限同倍放大（见 §4.F） |
| 媒体 | `resolveMessageMedia` `mediaFor` `resolveQuote` `hydrateAmbientMedia` | 环境上下文与复读**共用同一次下载**（`mediaResolutions` 这个 WeakMap 就是干这个的） |
| 事件轮转 | `handleEvent`（约 77 行）+ 持久化事件路由 | 见 §4.A / §4.I；`notice`（戳一戳 / 撤回）先于 `message` 分流（`handlePoke` / `handleRecall`）；`turn/end` 里按 `owner.proactive` / `owner.intent` 分流 |
| 定时提醒 | `reminders` `deliverReminderText` `deliverReminderModel` `runReminderTurn` `settleReminderTurn` `reminderNudge` `pendingReminderTurns` | 见 §4.J；任务生命周期在 `reminders.js`，这里只负责发送、agent 轮与守卫；@ 由 `sendParts` 的 `at` 注入 |
| 长期记忆 | 只剩一行装配（`const memory = createMemory({ … })`）与三个调用点（`handleEvent` / `channelPrompt` / 生命周期） | 整个子系统在 `memory.js`（见 §4.D）；依赖表就在那一行里 |
| 模型凭据轮换 | `rotateApiKey` `probeApiKey` | 见 §4.H；每天到点挑下一个探测通过的 key 交给 `ctx.credentials.set()`（**不用重启**）。时段/超时/探测地址在 `settings` 上 |
| 工具装配 | `registerQqTools(ctx, { … })` | 一张**依赖表**：把上面那些函数递给 `tools.js`（记忆是 `memory.tools`，存表情包是 `saveSticker`，戳一戳是 `poke`）。工具声明在 `tools.js`，不在这里 |
| 生命周期 | `ctx.effect(...)` + `ctx.on('loader/volatile-update', …)` | 托管 socket、API key 轮换与主动说话的定时器；摘要定时器由 `memory.startDigestTimer()` 挂。volatile-update 监听是**设置页保存之后唯一的生效路径**（延后一拍 `ctx.fiber.restart()`，见 §5.12） |

**往外搬模块的两条纪律**（`tools.js` / `config.js` / `settings.js` / `util.js` / `filestore.js` /
`chatter.js` / `memory.js` / `speaking-rules.js` 都是这么搬的）：

1. 被搬出去的模块**不 import `index.js`**（那会成环，ESM 下加载期就炸）。需要的东西分两类：
   - **叶子模块直接 import** —— `util.js` / `filestore.js` / `onebot.js` / `image.js` /
     `perceptual.js` 与 `@deepseek-ai/dsh-*` 不依赖闭包，本来就能在任意上下文里调，当参数传进来
     只是多一层看不出来的间接（`tools.js` 直接 import `chunkText` 就是这个道理）。
   - **闭包里的状态与装配动作走 `deps`** —— 会话表、`settings`、`ctx`、开 Agent 的那几个动作
     只有 `index.js` 有。`tools.js` / `memory.js` 的 `deps` 表是样例，也是「能碰什么」的清单。
   （一开始把 `errorText` / `sessionIdFor` / `createUserMessage` 也当依赖传了进去，与直接 import
   `localDate` 并列时很怪 —— 后来收掉了。新模块别重犯。）
2. `index.js` 里**保留再导出**（`export { Config } from './config.js'`）—— `bridge.test.mjs`
   只 import `index.js`，Loader 也只认插件入口，搬走的东西必须在入口处仍然拿得到。

**模块级纯函数都不在本文件里**：`util.js` 放「同样输入永远同样输出」的那批（`sessionIdFor` /
`memorySlug` / `localDate` / `localStamp` / `msUntilDailyHour` / `hourLabel` /
`withinActiveHours` / `memoryRelativePath` / `stickerFileName` / `parseApiKeyPool` /
`apiKeyFingerprint` / `visibleText` / `errorText` / `memoryOneLine`），
`filestore.js` 放碰磁盘的（`writeJsonAtomic` / `writeTextAtomic` / `writeBytesAtomic` /
`readTextOrUndefined` / `readJsonl` / `readdirOrEmpty`）。

判断一个新函数该放哪：**碰闭包状态留 `index.js`，碰磁盘去 `filestore.js`，其余去 `util.js`。**
`util.js` 里不许引入闭包状态 —— 保持纯粹才可能被单测。
`sessionIdFor` / `parseApiKeyPool` / `withinActiveHours` 的契约由 `bridge.test.mjs` 从
**插件入口**验，所以 `index.js` 里对这三个保留再导出（见上面的两条纪律）。
`msUntilDailyHour` 尤其值得单独测边界（刚过点要排到明天，不能原地反复醒）。

## 4. 十条数据流（改任何一条先读对应的那条）

### A. 入站消息 → Agent → QQ（主链路）

```
QQ ─▶ NapCat ─ws─▶ OneBotClient.onEvent ─▶ handleEvent
                                              │ noteSeen()：记「最近看见过什么」（撤回时唯一的信息源）
                                              │ admit()：白名单 / 渠道开关 / 群触发方式
                                              │ rememberTranscript()：记一行转录（长期记忆的原料）
                                              │ noteChatter + rememberAmbient（群环境上下文）
                                              │ maybeRepeat()：能复读就直接发，到此为止
                                              ▼
                                       conversationFor(type,id,sender)  建/取会话
                                              ▼
                                       enqueue() → holdForBatch()
                                          batchWindowMs 内攒批；batchMaxWaitMs 封顶
                                              ▼
                                       submitBatch() → createUserMessage → agent.inbox.submit
                                              ▼
   ctx.on('agent/inbox/claimed')  记账 turnOwners[`${agentId}:${turn}`]
   ctx.on('session/event')        assistant/message → transcripts 累积
                                  turn/end        → 取**最后一条有文本的** assistant 消息，
                                                     aborted/forked/interrupted 静默丢弃，
                                                    error 回一句固定道歉（主动搭话除外，见 §4.E）
                                              ▼
                       sendToConversation(..., { human:true, quote }) → sendParts()
```

⚠️ `rememberTranscript` 必须在 `handleEvent` 的两个提前 `return`（环境上下文、`/reset`）**之前**
调用，否则那些消息不会进转录。它也要**在 `admit` 之前**判定自己的准入规则（渠道开关 / 白名单），
因为 `admit === undefined` 的闲聊同样要记 —— 长期记忆的原料正是那些没人 @ 机器人的话。它**不建
会话记录**（`conversations` 是「处理过哪些会话」的表），只按 key 往记忆目录追加。

### B. 出站：Agent 主动发

`qq_send_message` / `qq_send_image` 直接调 `client.call('send_*', …)`；`qq_list_conversations`
只查询；`qq_save_sticker` 只写表情包目录（**不发消息**，见 §6 表与 docs/media.md）；`qq_transcript` /
`qq_memory` 只读写记忆目录。注意区别：**工具**（显式动作）只按协议上限 `chunkText` 分段，
**不加**打字延迟；拟人节奏只加在 A 链路的自动回复上。

### C. 自动复读（不经过模型、不建会话）

`maybeRepeat` → `repeatStateFor(groupId)` → 私有串行队列 `repeatStep` → `repeatCandidate`（文字
按归一化正文 / 图片按「字节哈希 + 画面指纹」/ 系统表情按 id）→ `sameCandidate` 判「跟刚才那条
算不算同一个」→ `sendRepeat`。配置项是 `repeat*` 一族，细节见 docs/repeat.md「自动复读」（改前必读）。

不能踩的：

- **图片来源判定必须留两层**：字节相同只是快路；QQ 会把同一张表情包按发送者重新编码（实测同一张
  图三种字节、画面 SSIM ≥ 0.985）。第二层是 `sketchOf` 的画面指纹，阈值 `repeatImageTolerance`
  （0 = 关）。指纹**懒算 + 按路径缓存**：只在真要比较两条字节不同的图时读盘，别挪到
  `repeatCandidate` 里让每条表情包都白解一遍。
- **指纹是对不可信字节的二进制解析**：`perceptual.js` 的尺寸/块数/解压长度都有硬上限，畸形输入
  只允许返回 undefined（不抛异常、不大块分配）。加格式（如 WebP）先补这几条上限。
- **`sketchOf` 只读 `.qq-media` 里刚落盘的那一张**，别让它读工作目录里的任意文件（那等于把群
  消息变成读文件的入口）。

### D. 长期记忆（转录 → 定时摘要 → 认知）

实现全在 `memory.js`（`createMemory(deps)`，index.js 只装配并在三个点调用）；下面这张图是
**行为规格**，改任何一处先对着它读。

```
handleEvent ─▶ rememberTranscript ─▶ .qq-memory/conversations/<slug>/log/YYYY-MM-DD.jsonl
                                     （后台串行追加，不等落盘；路径按会话 key 派生）
              └─▶ maybeCatchUpDigest（错过了今天的摘要点就立刻补一轮，每次启动至多一轮）

ctx.interval（排到下一个 digestAtHour，默认 04:00）─▶ runDigestSweep
       判据：今天这条会话还没摘要过（localDate(lastDigestAt) ≠ 今天）且 memoryDirty ≥ digestMinLines
             └─▶ enqueueDigest（串行链 digestChain，一次只跑一个会话）
                     │ 先 await 该会话未完成的转录写入（写入是后台的，不等会读到空目录）
                     │ 读转录窗口 → renderTranscriptWindow（最近优先截断）
                     ▼
                 runDigest ─▶ ensureDigestAgent（sessionIdFor('bridge:digest')，独立会话）
                     │          followup(转录正文) → await whenIdle()（有 digestTimeoutMs 守卫）
                     ▼
                 模型自己用 qq_transcript / qq_memory 读转录、写 MEMORY.md / COGNITION.md
                     └─▶ 成功后才写 digest.json 的 lastDigestAt + lastDigestDate（失败/超时不推进）
```

几条不能踩的：

- **摘要 Agent 不是记忆的载体**：它只读磁盘上的转录、只写磁盘上的记忆文件，被压缩/销毁/重启都
  不影响记忆 —— 别把「记住」实现成会话上下文里的东西。
- **一天至多一次靠日期判据**（`localDate(lastDigestAt)` vs 今天），不是「距上次 ≥ N 小时」。
- **`digest.json` 只在成功之后才推进**；排队中的消息靠内存 `memoryDirty` 计数（重启归零、靠
  `lastDigestAt` 重新数），所以摘要没跑成不会把消息算丢。
- **别在启动时扫一遍**（`conversations` 那刻还是空的）：补课挂在「重启后第一条消息到达」上。
- **读转录前先等写入**（`writesFor` + `Promise.all`），否则会读到还没写出来的目录然后静默跳过。
- **认知与表情包是两个文件**：`COGNITION.md` 只有语言（键是文字写法），`STICKERS.md` 是表情包
  （键是收藏后的文件名）。解析在 `cognition.js`；`qq_save_sticker` 存完图顺手补一行。
- **摘要 Agent 不在 `sessionIndex` 里**，它的 turn/end 因此不会往 QQ 发东西 —— 这是「后台会话」
  与「QQ 会话」唯一的区别机制，别把 digest session 注册进去。
- **写边界只有一处**：`memoryRelativePath`（模块级纯函数）。`qq_memory` 的写路径必须过它，
  `../` 与绝对路径都要被拒。要放开范围之前先想清楚 QQ 消息是不可信输入。
- **`memoryDir` 校验与 `mediaDir` / `stickerDir` 同一套路**：配到 `cwd` 外记 warn 并整个停用。

**结构化文件只走字段级写入**（0.2.0 之后的修订，对应三次真实事故）：

| 事 | 落点 | 为什么 |
|---|---|---|
| `qq_memory` 的 `upsert` / `remove` | `cognition.js` 的 `upsertCognitionRow` / `upsertStickerRow` / `remove*`；`memory.js` 的 `upsertMemoryEntry` / `removeMemoryEntry` | 模型只给字段，格式与分节由纯函数生成：它写不坏格式、不会重复标题、不会因为整份重写丢行 |
| 写入归一化 | `normalizeCognitionDoc` / `normalizeStickerDoc`，在 `writeMemoryFile` 里对这两个文件强制跑 | `append` 一段带 `## 黑话与缩写` 的 markdown 是最常见的写法，落盘时就合并掉，别指望模型自觉 |
| 整份重写的护栏 | `writeMemoryFile` 里「条目数掉到 90% 以下就拒绝」（`force: true` 放行） | 模型漏抄几行时文件照样「写成功」，护栏是唯一能拦住它的地方 |
| `.history/` 备份 | `backupMemoryFile`，每次写入前留一份，每个文件最近 20 份 | 写坏了至少能人工翻回去 |

- **`type` → 二级标题的路由在 `sectionForType`**：`缩写`/`谐音`/`专名`/`其它`。认知条目
  **按首见日期**注入（`hotCognitionLines`），不按文件里的位置 —— 否则整理一次文件就等于
  换掉它每轮记得什么。
- **认不出来的行不删**：`parseCognition` / `parseStickerCatalog` 只记 warn；`qq_memory read`
  会把它们点出来（`readWarningNote`），`ops doctor` 也会（`COGNITION_UNPARSED` 等五条）。

### E. 主动说话（`proactive`，默认开）

```
ctx.interval（每 proactiveCheckMs）─▶ proactiveSweep
   ① 没连上（selfId 为空）/ 不在 proactiveFromHour~ToHour / 概率没掷中 → 直接返回
   ② 每个群过一遍 proactiveEligible（全是「不做」的条件）：
        只群聊 · 没有待投的批次/在飞的 turn · 有人说话晚于我的最后一句话（**不做独白**）
        · 安静 ≥ proactiveIdleMs · 活跃于 proactiveFreshMs 之内 · 距上次 ≥ proactiveGapMs
        · 当天次数 < proactiveDailyMax
   ③ 洗牌后逐个掷 proactiveChance，**一次醒来最多一个群**开口
        └─▶ proactiveSpeak：先记 lastProactiveAt / 当天次数（**掷中即消耗**，SKIP 也算），
            再 enqueue(该群会话) → ensureAgent → followup(proactiveNudge(...))
                                  └─ submitted.set(msg.id, { …, proactive: true })
   turn/end ─┬─ 正文判成 SKIP（`proactiveSkip`）→ 什么都不发（**不分是不是主动那一轮**）
             ├─ proactive 且 reason === 'error' → 静默（没人问过它，不道歉）
             └─ 否则照常 sendToConversation(..., { human: true })（拆句 + 打字延迟）
```

不能踩的：

- **伪造的 user message 必须说清「这不是谁发来的」并给出 `SKIP` 出口**：不给出路时模型会硬编
  一句，比不说话更像机器人（文案见 `proactiveNudge`）。
- **`SKIP` 判定对 `所有` 轮次生效**：提醒落在同一会话的上下文里，模型在**回别人**的那一轮也会
  学着写 `SKIP`（真实事故：它引用了别人的表情包，正文写着「SKIP」）。判据在 `proactiveSkip`。
- **掷中即消耗**：`SKIP` / 失败也算用掉当天额度与 `proactiveGapMs`（先记账再 followup）。
- **走的是这个群自己的会话**（与摘要 Agent 相反），所以它在 `sessionIndex` 里、回复照常回 QQ。
- **`lastBotSpeakAt` 由 `sendOne` 记账**（不做独白的判据），别绕过它直接 `client.call`。
- **`lastActiveAt` 由 `touchActivity` 更新**，含**没被 @** 的群消息；只更新**已有**的会话
  （「只对已经聊过的群生效」就落在这里）。
- **状态全在内存**：重启归零，别把 `proactiveIdleMs` 配成 0 又反复重启。
- **只群聊**：第一行就 `type !== 'group'` 返回 false（刻意不给私聊开关）。
- **`withinActiveHours` 是纯函数**（左闭右开 / 相等 = 全天 / `from > to` 跨零点），改语义就改它。
- **闸门本身是纯函数**（`proactiveEligible` / `proactiveSkip`）：五道闸门 + 两个节奏闸收在
  `(普通入参) → boolean` 里；`index.js` 里只是凑入参的适配器（含带跨天归零副作用的计数读数）。

### F. 活跃对话（`activeWindowMs` / `activeFollow` / `activeGroup*` / `activeChime*`）

E 管的是**冷场**；这一块管「正聊着」。三条路共用一个「活跃对话」窗口（默认
`activeWindowMs: 60000`，即 @ 一次只买 1 分钟）：

```
admit（群聊）
  ├─ 被叫到（@ / 前缀 / groupTrigger=all）→ 不抽卡直接回；talkMisses 清零
  │      → noteActiveMessage(..., continued=false)：activeTurns 归零、清 chime、滑窗口
  ├─ A 没被叫到 → activeFollowAllows？（七条，逐条见 speaking-rules.js）
  └─ C 没被叫到 → groupTalkActive(群号)？（热度窗口够条数、够人数，纯查询）
        └─ A 或 C 够资格 → **抽卡**（activeTalkAllows，A/C 共用）：
             概率 = min(activeTalkChanceMax, activeTalkChance + activeTalkChanceStep × talkMisses)
               ├─ 抽中 → talkMisses = 0，continued = true（C 路不消耗 activeMaxTurns）
               │    └─ admit 返回 { continued: true }：正文**不能**再走 dropPrefix（见 submitBatch）
               └─ 没抽中 → talkMisses +1，这条不进 Agent（转录/环境上下文/热度照记）；
                    A 路还要 noteActiveMessage(..., continued=true)（窗口照滑、轮数照扣）
             两个资格都不成立 → talkMisses 清零（这段对话凉了，保底不跨对话）

holdForBatch → batchScale()：C 生效时 batchWindowMs / batchMaxWaitMs 一起 ×
   activeGroupBatchScale（「倾听时间变长，多听几句再合成一轮回复」）

turn/end（正常回复发完之后）
  └─ scheduleChime：proactive 开着 + activeWindowMs/chimeIdleMs/chimeMax 都 > 0
       → 排一个裸 setTimeout（chimeIdleMs 按 delayJitter 抖动），编号记在 chimeSeq
            └─ runChime：编号还对得上 · 窗口还热 · 没有在飞的 turn/批次
                 · chimeCount < activeChimeMax · 当天 < activeChimeDailyMax
                 · lastBotSpeakAt > lastActiveAt（我回过、对方没接）
                 · 群里 chatter.others() == activeInterposeSeq（中间没人插话）
                 · 掷中 proactiveChance
                    └─ chimeSpeak：先记账再 enqueue → followup(chimeNudge())
                         submitted.set(msg.id, { …, proactive: true })  ← 与 E 共用分流
```

不能踩的：

- **窗口只靠别人发来的消息往后滑**（机器人自己的话不滑），否则它自己就能给窗口续命。
- **三本账别合并**：都在 `chatter.js`，只暴露语义动作 —— `noteOther`（别人：序号 +1、记热度）/
  `noteSelf`（我自己：只推回答指向）/ `others`（比大小，判有没有人插话）/ `anchor`（含我自己，
  判我回的那条被挤远没有）/ `isHot`（比时间，判最近够不够热）/ `forgetHeat`（`/reset`）。
  `test/chatter.test.mjs` 把这些不变量钉成断言 ——**合并两本账会直接红**。
- **多人搭话是纯查询**（`groupTalkActive`），不存「搭话状态」；也**不消耗 `activeMaxTurns`**
  （那是防一个人刷屏的，这里的闸门是「够条数、够人数」）。
- **够资格 ≠ 就接：A 与 C 共用一次抽卡**（计数在 `talkMisses` 上）：抽中、被 @ 到、或两个资格
  都不成立时归零；**A 路没抽中也必须 `noteActiveMessage(..., continued=true)`**，否则窗口会在
  概率攒够之前过期。空消息在抽卡之前就被丢掉。
- **只放大攒批（`batchScale`），不放大打字延迟**：窗口与上限两处必须同倍，否则
  `batchMaxWaitMs` 会把「多听几句」又卡回去。
- **`continued` 一路要传到 `submitBatch`**：前缀模式下按前缀长度硬切会切掉正文首字
  （`dropPrefix` 只对**显式带前缀**的那条调用）。
- **窗口接上的那句不是指令**：`handleEvent` 里 `commanded`（= 被叫到且不是 continued）
  挡在 `/reset` 这种旁路前面 —— 否则窗口里一句「reset」就绕开模型把会话重置了。
- **`admit` 里先看 `conversations` 里有没有这个群**：窗口回话（A 与 C 都是）不能凭空创建会话
  记录（那会让没被 @ 的闲聊把群变成「处理过」的会话，破坏长期记忆那条旧不变量）。
- **补一句只在正常回复之后挂**（`turn/end` 的非 proactive 分支），主动搭话自己那一轮不再挂 ——
  否则它会补一句再补一句、对着空气自言自语。
- **补一句的九条闸门是纯函数**（`speaking-rules.js` 的 `chimeAllows`）：编号、总开关、窗口、队列、
  两个上限、**对方有没有接**、群里插话、概率全在一个判据里，同样有逐条翻动的用例。`runChime`
  只剩「凑入参 → 掷骰子 → 叫 chimeSpeak」。
- **`chimeSeq` 是防漏的保险**：新消息（`noteActiveMessage`）与 `/reset`、插件卸载都会
  `cancelChime`，但正确性只依赖「编号对不对得上」，不依赖取消点记得 `clearTimeout`。
- **`activeFollow` 默认开**（放松「群里只在被 @ 时才说话」，属于安全面 §5.6）：`false` 时
  一对一的免 @ 接话与多人搭话一起关掉。改这个默认值要同步 docs/configuration.md 的配置表与 docs/security.md。
- **`/reset` 要清热度窗口**（`chatter.forgetHeat`），两个序号刻意不清（理由写在 `forgetHeat`）。
- **群聊的 B 需要 `proactive: true`**；**私聊的补一句不需要**（那是刻意的语义例外，见
  `privateAfterthoughtAllows` 的注释与 docs/proactive.md「私聊补一句」）。

### G. 会话轮次（`/reset` 开新一轮）

`/reset` 不删旧会话，而是**换一个 Session id 从头开始**。代次（第几轮）是这套东西的全部状态：

```
conversationFor ──▶ refreshSessionGeneration：新建会话记录时从内存代次表里带上
                     （内存代次表由启动时的 loadConversationResetCounts 从磁盘扫进来）
ensureAgent     ──▶ sessionIdFor(key, conversation.sessionGeneration ?? 0)
                     → 该 id 的 Session 不在就 resume（第 0 轮的老会话），失败则 create

QQ 里发 /reset ─▶ handleEvent 的旁路（先 flushBatch）─▶ resetConversation
   ① 销毁活着的 Agent（句柄没了就退 scope.dispose）；销毁失败 → 整件事放弃、回一句失败
   ② 代次 +1，写进内存表 + 标记文件（`<会话根>/reset/<slug>.json`，**await 落盘成功**）
   ③ 清记账：sessionIndex / turnOwners / submitted / transcripts / ambient / repeatStates /
      主动说话计数 / 活跃对话窗口与 chime
   ④ 下一句消息算出**新的** id → resume 不到 → create 一个空会话（第 N 轮）
```

不能踩的：

- **代次必须落盘**（§5.4）：只在内存里的话，重启会把第 0 轮的会话 resume 回来。
- **`/reset` 之后旧会话仍在磁盘上**（存档，刻意不删）：别清理它，也别重新注册进 `sessionIndex`
  （旧 Agent 迟到的 turn/end 会被当成这个会话的回复发出去）。
- **长期记忆与轮次无关**：转录 / `MEMORY.md` 按会话 key（`memorySlug`）落，`/reset` 不动它们。
- **第 0 轮的 id 是历史契约**（§5.3）：`sessionIdFor(key, 0)` 必须与改动前逐位相同。
- **重置要过权限**（`canReset` / `Config.resetUsers`）：全项目唯一一个「白名单为空 = 谁都不能」
  的配置项（与 `allowUsers` 相反），别顺手统一。判断点在 `handleEvent` 的 `/reset` 分支里、
  `flushBatch` **之前**（否则没权限的人也能让攒着的消息提前投出去），没权限时静默 return。

### H. 每天轮换模型凭据（`apiKeyRotate`，默认开）

```
ctx.interval（排到下一个 apiKeyRotateHour，默认 04:00）─▶ rotateApiKey()
   ① 读 cwd 里的 apiKeyFile（默认 data/api-keys.txt）→ parseApiKeyPool
        文件不存在 / 一行 key 都没有 → 记 info 说「该建在哪」，到此为止
   ② ctx.get('credentials')：拿不到 set/resolve → 记 warn，到此为止
   ③ credentials.describe(apiKeyRef) 说 writable === false（key 来自启动环境）→ 记 warn，到此为止
   ④ credentials.resolve(apiKeyRef) 拿当前 key → 决定候选顺序
        从「当前 key 在池子里的下一个」开始绕圈；当前 key 不在池子里就从池首开始
   ⑤ 逐个候选 probeApiKey(apiKeyProbeUrl)：GET，2xx 才算能用（429 = 有效但没额度）
        第一个通过的 → credentials.set(apiKeyRef, key) → 回读确认 → 记 info
        全都不通过 → 记 warn，**保留原来的 key**
```

不能踩的：

- **必须走 `ctx.credentials`，别手改 `$DSH_HOME/.credentials.yaml`**（那里还有浏览器会话等
  records；凭据层自带文件锁与写后通知，`set()` 之后不用重启）。
- **`ctx.get('credentials')` 而不是写进 `inject`**：写进 inject 会让没有凭据服务的组合整个插件
  不激活（§10 第一条），而轮换只是顺带的事。
- **探测必须便宜**：`GET /models`，不是发一次真对话；两个鉴权头一起带（OpenAI 面 + Anthropic 面）。
- **日志绝不出现完整 key**：一律走 `apiKeyFingerprint`。
- **「当前是哪个 key」现算、不落盘**：靠 `credentials.resolve` + 池子里的位置，别加「上次换到
  第几个」的状态（重启、手改 key、调顺序都会让它跑偏）。
- **探测不通过就不写**（宁可不换，也不能把 bot 换成不可用的状态）；**key 来自环境变量时提前
  退场**（`describe()` 的 `writable: false`）；**池子文件必须在 `cwd` 内**。

### I. 被撤回的消息（`recallMode`，默认 `ignore`）

形态照抄戳一戳：**判据全在 `recall.js`，`index.js` 只凑入参、记账、投递**。三层 —— 安全层
（清引用）与数据层（内存里的「最近看见过什么」账）**永远生效**，行为层才是配置项。
完整规格（用户视角 + 实现要点 + 坑清单）见 `docs/recall.md`。

```
message 分支最前面 ─▶ noteSeen（recent[key] 压一条：id / userId / name / text / at /
                        addressed / submitted / replied / recalled / action）
notice 分支 ─▶ handleRecall
   ① recallInScope ─▶ ② clearQuoteFor（安全层，所有模式都做）
   ─▶ ③ 私聊且 !recallPrivate → 停 ─▶ ④ findRecent（对不上只记 info，不是错误）
   ─▶ ⑤ memory.noteRecall（转录追加 kind:"recall"）
   ─▶ ⑥ 还没投递：!addressed 或 recallAddressed==='drop' → action='drop' +
        dropPending + dropAmbient；addressed 且 tease → action='rewrite'
   ─▶ ⑦ 只有 tease 继续：recallAction 的 12 条闸门 → 掷中先记账、再 enqueue 一条 nudge
```

不能踩的：

- **清引用是正确性**：`quote` 在 `pending` / `submitted` / `turnOwners` 里是**同一个对象**
  （`batchQuote` 取的就是 `admit` 快照那个，所以**别在别处复制新对象**）。不清的话，引用一条
  已撤回消息的回复会在 `sendOne` 失败，而 `sendParts` 见到失败就 `return` —— 整条回复剩下的
  气泡一起不发。只清 `messageId`、留 `userId`（`replyStyle: 'at'` 仍要用它，`auto` / `quote` 没
  有 `messageId` 时自然退回裸文本）。
- **`noteSeen` 在 `admit` 与所有提前 `return` 之前**；**`action` 记在 `recent` 账上而不是只改
  `pending` 数组**（那一批可能已被 splice 出去、正在 `submitBatch` 里异步下媒体）。
- **`recalled` / `action` / `submitted` / `replied` 是四种东西，别合一个布尔**；`replied` 只在
  `turn/end` 真要发回复时由 `markReplied` 置（`owner.batchIds` 只含真正投进这一轮的那些）。
- **改写不另开一轮**（否则是两连发）；**在飞不补刀**；**管理员代撤 / 自己的消息被撤不调侃**。
- **补一句要过闸门，改写不吃闸门**（它不多发消息）；nudge 用 `proactive: true`。
- **`/reset` 清 `recent[key]` 与 `recallAt` / `recallToday`**；转录只追加 tombstone、不删行。

### J. 定时提醒（`reminder`，默认开）

完整规格见 `docs/reminders.md`；实现分两层：**任务与调度在 `reminders.js`**，**发送与
agent 轮在 `index.js`**。

```
到点 ─▶ reminders.fireDue
          ├─ text   → deliverReminderText（原样 + at 段，不分气泡、不加延迟）
          └─ agent/prompt
               ├─ 先落盘 status=firing（at-most-once）
               ├─ 会话正忙 / Agent 日额度用完 → 固定文案
               └─ runReminderTurn：enqueue → ensureAgent → followup(reminderNudge)
                    ├─ turn/end 的 reminder 分支（必须排在 error/SKIP/aborted 之前）
                    │    ├─ 正常有文字 → deliverReminderModel（拟人发送 + at）
                    │    └─ SKIP/空/error/aborted → 按 reminderOutcome 兜底或丢弃
                    ├─ 守卫超时 → 固定文案；迟到的 turn/end 丢弃
                    └─ 重启时仍是 firing → grace 内补固定文案，超过标 missed
```

不能踩的：

- **reminder 分支必须在 `turn/end` 的最前面**：普通轮次里 error / SKIP / aborted 都是静默
  `return`，提醒照抄就会静默消失。`settleReminderTurn` 返回 false = 守卫已结算，丢弃迟到的回复。
- **不要给提醒轮标 `proactive: true`**：`proactive` 的 error 分支会静默吞掉，提醒必须能走到兜底。
- **@ 由任务注入，不让模型写**：`sendParts(..., at)` 把 at 段挂到第一个文字气泡；模型只写正文。
  文本原样发送，**不解析** `[[图片]]` / `[[@]]` 标记（群聊文本是不可信输入）。
- **守卫按任务 id 存**（`pendingReminderTurns`），不按会话：`/reset` 会清 `turnOwners`，
  `turn/end` 不会再来，守卫是唯一兜底。
- **一个会话同时只跑一条 Agent 提醒**（`busyWithTurn`）；同一分钟的第二条直接发固定文案。
- **提醒轮不挂 `scheduleChime`**：提醒分支提前 `return`，否则它会补一句再补一句。
- **每会话 Agent 日额度**（`reminderAgentDailyMax`）在派发前扣；`text` 不计入。
- **任务文件 `reminderFile` 必须在 cwd 内**；读回时逐条校验，坏条目跳过，不拖垮插件。
- **设置页的「已记录的定时任务」是运行状态的只读投影**：它在独立的「提醒」tab 最上面
  （提醒也服务私聊，别塞回「群聊」页）；`reminderOverview`（纯函数）挑展示字段，
  `reminders.overview()` 先等首次读盘；`index.js` 在 Connection 的认证栅栏内挂一条
  exact Fetch route（`REMINDER_ROUTE_PATH = /api/qq-bridge/reminders`），`client.js` 的
  `ReminderTasks` 同源 `fetch` 它。**别把 `snapshot()` 直接序列化出去**，也不要把这块数据
  塞进配置 schema（任务不是配置）；路由必须用 `ctx.inject(['connection'], …)` 等那个服务
  出现 —— 本插件的 `apply()` 跑在 `dsh-client-connection` 之前，`ctx.get('connection')`
  那一刻是 `undefined`，路由会永远挂不上（设置页只有 404；真实事故）。没有 Connection
  服务的组合里 `inject` 的回调不跑，等于静默不挂。

## 5. 必须知道的硬约束

1. **改源码必须重启 Harness，停用/启用插件没用。**
   Loader 在进程内**按 URL 缓存模块**；`set_plugin`、`remove_bundle` + `install_bundle`
   都拿不回新代码（已验证）。只有 `cordis.patch.yml` 的**配置**能热生效。
   ```bash
   systemctl --user restart qqbot     # 常驻方式
   # 或 tmux 里 Ctrl-C 后：dsh --profile qqbot --port 3081 --no-open
   ```
2. **不要用 agent 的后台任务跑常驻进程。** DSH 的 bash 工具跑在
   `bwrap --die-with-parent` 沙箱里，沙箱一销毁子进程就死。常驻走 systemd user unit
   （`deploy/qqbot.service`，`Restart=always`）或 tmux。
3. **Session id 是确定性的，不许改算法。** `sessionIdFor(key, generation)` = SHA-256 裁成
   UUID 形状（固定版本位/变体位过格式校验），key 形如 `group:100000001` / `private:<QQ号>`。
   `generation` 是「第几轮会话」：**`generation === 0` 的输入串必须保持原样**
   （`dsh-qq-bridge:<key>`），改了它 = 所有人的聊天记忆全部丢失；≥1 时在 key 后面缀
   `:reset:<n>`，同样确定性。`/reset` 就是把这个数 +1（见 §4.G）。
4. **会话代次要落盘**（`<会话根>/reset/<slug>.json`，拿不到会话根时 `cwd/data/reset/`）：
   它只在内存里的话，重启会算出第 0 轮的 id、把 reset 之前的会话 resume 回来 —— 等于
   `/reset` 白按。标记按会话独立，一个坏了只影响那一个（别「一个都读不出来就全清空」）。
5. **`cwd` 既是 Agent 工作目录也是沙箱根。** `mediaDir` / `stickerDir` /
   `memoryDir` 必须在 `cwd` 内，配到外面代码会**记 warn 并自动停用**该功能
   （`insideDirectory` 校验），这是有意设计，别改成抛错。
6. **QQ 消息是不可信输入。** 默认 `approvalPolicy: 'never'`（需要审批的操作直接拒绝）、
   群消息默认只在被 @ 时触发（`activeFollow` 默认开会把这一点放宽到「窗口内接着说」与
   「群里聊热了」，属于**刻意放松**的一条，见 docs/security.md）、
   `/reset` 默认**谁都不能用**（`resetUsers` 空 = 全关，见 §4.G）。
   任何扩大 QQ 侧能力的改动都要重新想一遍这一点。唯一能让 QQ 会话**按自己给的字节**写盘的
   是 `qq_save_sticker`（只写 `stickerDir` 内、文件名洗成单层、张数受 `stickerMaxFiles` 限制，
   见 docs/media.md 的同名小节）；`qq_remind_create` 也会让插件写提醒任务文件，但写的是
   `reminderFile` 里字段级校验过的任务（见 §4.J）。
7. **`Config` schema 是配置的唯一真相（在 `config.js`）。** 加配置项 = 在 schema 里加字段
   （带**中文** `.description()`）+ 需要再加工的话在 `settings.js` 里加一行 + docs/configuration.md 的表格里
   同步一行 +（界面上要分组正确的话）`client.js` 的 `SECTIONS` 里给它一段。已有 100+ 字段，
   §3 的表格只是导览，别照抄。**`index.js` 里不允许出现 `config.xxx`** —— 一律读
   `settings.xxx`，否则取值口径又会散开（那是这次重构要消掉的东西）。另外**根上的
   `.volatile()` 不能删**：它是 Web UI 设置页的前提（见 §5.12）。
8. **日志要同时写 logger 和 stderr。** 这个部署没把 cordis logger 接到 stdout，
   `ctx.logger.warn()` 在 journal 里一个字都看不到。用 `report(level, msg)`，
   它靠 `logger.exporter` 是否存在来避免污染测试输出。
9. **同一会话的消息必须串行**（`enqueueSend` / `enqueue`）。QQ 消息到达顺序和异步
   IO 完成顺序不一致，绕过队列会串话/乱序。
10. **手写 profile 的 `cordis.patch.yml` 时不许给 `qq-bridge` 只写一段残缺的 `config`：DSH 的
    patch 是整块替换、不是深合并**。只写一个 `resetUsers` 就会把仓库 patch 里那整套配置（连同
    `agentPreset: qq` 与 `allowTools`）一起顶掉 —— QQ 会话会挂上带 shell 的默认预设，而这是
    不可信输入面。真发生过一次。改配置走仓库 patch 或 Web UI 设置页；每台部署不同的是环境变量。
11. **Windows 桌面版不是容器部署**：Host 的 cwd 是 `~/.dsh/profiles/desktop`，插件以
    `link:<仓库>` 装进 profile 的 `dependencies` **和** `dsh.profile.bundles`（缺一个就是「装了
    不加载」）；每台机器不同的值走 profile 的 `.env`（`QQBOT_*`），改完源码要重启整个桌面版。
    NapCat 自检默认只读、`napcatAutoConfig` 才写（先备份、只动 `websocketServers` 里我们那一条）。
12. **设置页由 schema 生成，`client.js` 里没有字段表**：`configForms.describe()` → 按 `type` 选
    控件 / 按 `.description()` 取标签 → `mutate` 写 profile patch 的**完整** config。页面挂在
    `settings.section`（侧栏「QQ Bridge」）。三条推论：加配置项**不用动界面**，但要在 `SECTIONS`
    里给它一段（否则 `test/client.test.mjs` 会红）；根上的 `.volatile()` 删了页面就消失
    （`test/util.test.mjs` 钉着）；volatile 热更新不重跑 `apply()`，`index.js` 收到
    `loader/volatile-update` 会 `ctx.fiber.restart()` —— 别删那个监听。
    显式 `fields` 清单的顺序就是组内渲染顺序（前缀组按 schema，见 `orderedRows`）。
    页面是 7 个下划线 tab（`TABS`）+ 扁平区块 + 官方字段行（控件映射 / 搜索 / `FIELD_HINTS`
    量纲与控件映射见 `client.js` 顶部注释）；改设置页只动 `client.js`。
13. **定时提醒的正文到点原样发，绝不能当标记/提示词再解析。** 它来自 QQ（不可信），过了
    `replyPieces` 就能让群友借一条任务发图或 @ 任意的人；@ 只来自创建时解析好的 QQ 号。
    agent/prompt 那一轮也不要把 `task.prompt` 当系统指令，它只是用户内容；`prompt` 模式
    默认关闭且只给受信者，原因就在这里。

## 6. 怎么改：任务 → 动哪里

| 想做的事 | 动哪里 |
|---|---|
| 加一个不碰状态的纯函数 | `util.js`（碰磁盘的放 `filestore.js`）；**别 import `index.js`**，也别让它读闭包状态 |
| 加一个配置项 | `config.js` 的 schema（含中文 `.description()`）+ （需要兜底/夹紧时）`settings.js` 加一行 + docs/configuration.md 的配置表 + `test/settings.test.mjs` 补边界；界面不用改，但要在 `client.js` 的 `SECTIONS` 里给它一段（见 §5.12） |
| 改 Web UI 设置页（分组 / 标签 / 控件 / 草稿口径） | 只改 `client.js`：`TABS` / `SECTIONS`（含 `subs` 小标题）、`LABEL_OVERRIDES`、`ENUM_LABELS`、`FIELD_HINTS`、`specFor`；版式契约见 `client.js` 顶部注释与 `test/client.test.mjs` |
| 改提示词 / 人设 | `DEFAULT_PERSONA`（内置兜底）、`channelPrompt` 的槽位、`Config.persona` / `.instructions`；**「是谁」写 `.qq-persona/PERSONA.md`、「怎么说」写 `STYLE.md`**（`persona.js` / `style.js`） |
| 改气泡数 / 标点 / 引用规则 | 气泡条数由模型按 `STYLE.md` 自己写，插件**不设上限**；标点与中断在 `style.js`（`sanitizeBubble` / `classifyReply` / `renderStyleContract`）+ `Config` 的 `burstSingleMaxChars` / `stripShortPeriod` / `replyStyle` + `index.js` 的 `burstParts` / `replyPieces` / `sendParts` / `quoteHead`（被回复的那条只有表情时不引用：`onebot.js` 的 `isEmojiOnlyMessage`） |
| 改私聊补一句 | `speaking-rules.js` 的 `privateAfterthoughtAllows` + index.js 的 `scheduleChime` / `runChime` / `chimeNudge` + `Config.privateAfterthought*` |
| 改群聊「谁该开口」 / 插话 | `speech-policy.js`（`decideGroupTurn` / `interjectExclusion` / `interjectLine`）+ `speaking-rules.js` + index.js 的 `admit` / `submitBatch` / `speakerLine` |
| 改认知 / 表情包目录 | `cognition.js`（纯解析）+ `memory.js` 的 `catalogState` / `appendSticker` + `tools.js` 的 `qq_save_sticker` + 三个 skill + `scripts/migrate-cognition.mjs` |
| 改消息段的渲染 / 新加一种段 | `modalities.js`（`observationOf` / `renderObservation`）；卡片解析在 `links.js` |
| 加运维动作 / 改 doctor | `ops.js`（纯计划）+ `scripts/ops.mjs`（执行器）+ `test/ops.test.mjs`；写 cwd 外的步骤必须带 `requires: human|root` |
| 加一个 Agent 工具 | 在 `tools.js` 里照 `qqSendMessage` 抄结构（`defineTool` + `output.schema` + `render` + 中文报错），再在 `registerQqTools` 里注册、在 `index.js` 的 `deps` 里补上它需要的能力；**别 import `index.js`** |
| 改分条/打字节奏 | `onebot.js` 的 `splitBurst` / `splitStickerLines` / `typingDelayMs`（**纯函数，优先在这里改**） |
| 改图片落盘/去重/淘汰 | `media.js` |
| 改出站图片校验或传输（含表情的 `sub_type` 大表情标记） | `image.js` 的 `imageSegment` + index.js 的 `isStickerFile`（收藏目录来源算表情）+ `onebot.js` 的 `isStickerSegment`（复读时原消息算不算表情）+ `replyPieces` / `sendRepeat` 两处调用 |
| 改「存表情包」（写边界 / 名字清洗 / 张数上限 / 什么时候能存） | `util.js` 的 `stickerFileName`（纯函数写边界）+ index.js 的 `saveSticker` / `stickerSaveAllowed` + `tools.js` 的 `qq_save_sticker` + `Config.stickerMaxFiles` + `filestore.js` 的 `writeBytesAtomic` + `allowTools` |
| 改群触发/白名单/复读 | index.js 的 `admit` / `maybeRepeat` 区块 |
| 改回复的指向（引用 / @） | index.js 的 `quoteHead` + `admit` 里快照的 `chatter.anchor()` + `Config.replyStyle`；这个读数**含机器人自己发的话**（`noteSelf`），别换成只算别人的 `others()`，也别把 `noteOwnMessage` 那几处删了（NapCat 的 `reportSelfMessage: false`，自己发的话等不到回灌） |
| 改「@ 人」的行为（标记语法 / 名单来源 / 认不出来怎么办） | `mention.js`（纯函数解析与名单查询）+ `Config` 里**没有**配置项 + index.js 的 `registerParticipant` / `conversationMentions` / `sendParts` 与 `admit` 里登记的 `sender.mentions` + `tools.js` 的 `qq_send_message` + 提示词里那两条 `[[@昵称]]` 硬要求；名字的显示口径（群名片优先）在 `onebot.js` 的 `userDisplayName`，**正文与名单必须来自同一个值** |
| 改「被撤回的消息」 | `recall.js`（4 个纯函数）+ index.js 的 `handleRecall` 一族与 `submitBatch` 里的 `action` 分支 + `Config.recall*` + `memory.noteRecall` + docs/recall.md（见 §4.I） |
| 改「定时提醒」 | `reminders.js`（时间推算 / 校验 / 模式决策 / 调度）+ index.js 的 `deliverReminderText` / `deliverReminderModel` / `runReminderTurn` / `turn/end` 的 reminder 分支 + `tools.js` 的三个工具 + `Config.reminder*` + docs/reminders.md（见 §4.J） |
| 改「两张图算不算同一张」 | `perceptual.js`（指纹方案与阈值校准都写在文件头和 docs/repeat.md「表情包那半边的账要算清」里）+ `Config.repeatImageTolerance` |
| 改主动说话的闸门 | `speaking-rules.js` 的 `proactiveEligible`（五道闸门 + 两个节奏闸）+ 它的用例；index.js 那边只是适配器 |
| 改主动说话的文案 / 流程 | index.js 的 `proactiveNudge` / `proactiveSweep` / `proactiveSpeak` + `Config` 的 `proactive*` + docs/proactive.md「偶尔主动说话」（见 §4.E） |
| 改主动说话的时段语义 | `withinActiveHours`（**模块级纯函数**，导出给测试用）+ 它的边界用例 |
| 改「聊起来之后保持搭话」/ 抽卡 | `speaking-rules.js`（`activeFollowAllows` / `activeTurnsLeft` / `activeTalkChance` / `activeTalkAllows` / `chimeAllows` / `chimeDelay` / `batchScale`）+ index.js 的编排（`noteActiveMessage` / `groupTalkActive` / `scheduleChime` / `runChime` / `chimeNudge`）+ `chatter.js`（三本账）+ `admit` 里那两条免 @ 分支与抽卡 + `holdForBatch` + `settings` 的 `active*` + docs/proactive.md「聊起来之后保持搭话」（见 §4.F） |
| 改「谁算在跟它聊」 | `speaking-rules.js`（`activeFollowAllows` 的七条）与 `chatter.js`。一对一：`others()` 与 `activeInterposeSeq` 比大小（`noteActiveMessage` / `activeFollowAllows` / `runChime`）—— 别改成时间戳，它判的是「有没有人插话」；多人搭话：`isHot()` 的时间窗口（`groupTalkActive`）—— 别改成序号，它判的是「最近够不够热」。**两条判据的语义差别写在模块注释里，还有 `test/chatter.test.mjs` 守着** |
| 改 `/reset` 的行为（轮次的算法 / 标记落盘 / 清哪些记账） | `sessionIdFor` + `resetConversation` + `resetMarkerDir` / `loadConversationResetCounts`（见 §4.G、§5.3、§5.4） |
| 改「谁能重置会话」 | `Config.resetUsers` + `canReset` + `handleEvent` 里的 `/reset` 分支（**空白名单 = 谁都不能**，别改成 `allowUsers` 那种语义）+ docs/sessions.md「新开一轮会话」 |
| 改 QQ 会话能用哪些工具 | `cordis.patch.yml` 的 `preset-qq` + `Config.allowTools`（见 §7） |
| 改长期记忆的行为 | `Config` 的 `memory*` / `digest*` + `memory.js`（整个子系统）+ docs/memory.md「长期记忆」（见 §4.D） |
| 改记忆文件的写入方式（逐条 / 归一化 / 护栏 / 历史） | `cognition.js` 的 `upsert*` / `remove*` / `normalize*` / `sectionForType` + `memory.js` 的 `writeMemoryFile` / `backupMemoryFile` + `tools.js` 的 `qq_memory` 参数 + `test/cognition.test.mjs` 与 bridge 里搜索 `upsert` 的那组 |
| 改「发表情只能从收藏目录发」 | `index.js` 的 `stickerSendSource` + `channelPrompt` 里的标记文案与 `stickerFailure` 回灌 + bridge 里「只认收藏目录」那组；`qq_send_image` 是显式动作，**没有**这条限制 |
| 改摘要的触发时刻 | `digestAtHour` + `msUntilDailyHour`（模块级纯函数）+ `memory.js` 里 `runDigestSweep` 的日期判据 |
| 改 API key 轮换（池子格式 / 探测 / 什么时候换） | `Config` 的 `apiKeyRotate*` + index.js 的凭据轮换区块（`rotateApiKey` / `probeApiKey`）+ 模块级 `parseApiKeyPool` / `apiKeyFingerprint` + docs/ops.md「每天轮换 API key」（见 §4.H） |
| 改 Windows 一键配置 / 启动 NapCat（提权、窗口、隐藏、自启、快速登录） | `scripts/napcat-setup.mjs`（编排；开关 `--start` / `--window normal\|min\|hidden` / `--autostart install\|remove\|status` / `--no-log-to-file` / `--force`）+ `napcat.js` 的 `findNapcatDir` / `withAutoLoginAccount` / `withNapcatLogging` / `webuiTarget` / `startPlan` / `hiddenWrapperVbs` / `hiddenStartPlan` / `scheduledTaskXml` / `scheduledTask*Plan`（纯函数判据）+ `test/napcat.test.mjs` + docs/windows.md「Windows 桌面版」。四条实测禁令：**别改回 `launcher-user.bat`**（不提权时 QQ 注入后崩在 `QQNT.dll`）、**`wscript` 必须带 `//B`**（否则出错弹模态框卡死）、**隐藏启动走 `cmd.exe /s /c`，别把 `.bat` 直接交给 `WshShell.Run`**（文件关联 + MotW 会弹看不见的警告框）、**包装脚本与任务 XML 按 UTF-16LE + BOM 落盘** |
| 改摘要/学梗的流程（提示词） | `.dsh/skills/` 里的 SKILL.md（改完**不用重启**，watcher 会重载） |
| 加一个 skill | 新建 `.dsh/skills/<kebab-name>/SKILL.md`（frontmatter 必填 `name` + `description`），并把 `skill` 留在 allowTools 里 |

**风格**：注释解释**为什么**而不是**是什么**（现有代码大量在解释取舍，如「为什么是 base64
而不是把路径丢给 NapCat」）。新代码请延续：先写清为什么这样选，再写实现。别新增英文注释。

## 7. QQ 会话的工具从哪来（容易踩）

Web 表面把 agent 平面的工具搬进了 **Agent 预设**：QQ 会话只有 join 一个预设才继承得到
文件/检索/联网工具（`Config.agentPreset`，空 = 部署默认，`none` = 不挂预设）。

`cordis.patch.yml` 里自带的 `preset-qq`（id `qq`）是**刻意最小**的：`fs` 只读 + `fs-search` +
`web` + `skill-filesystem`/`tool-skill`（发现 `.dsh/skills`）+ 压缩，**没有 shell / 子代理 /
workflow**。理由写在 patch 的注释里，其中一个是硬 bug 规避：`standard` 预设的
`modelSelectionSettings` 会让 subagent 工具在 Agent 自己的作用域里再注册一份，而
`tools.restrict()` **按设计只收窄「继承来的」工具**，于是 subagent 会绕过 `allowTools`
出现在 QQ 会话里。改预设前先读那段注释。

**skill 归预设管**：`dsh-web-app` 把宿主的 `skill-filesystem` / `tool-skill` 停掉了
（「presets own local discovery」），所以预设里必须自己挂一份，QQ 会话才看得见
`.dsh/skills`。`allowTools` 里也要留着 `skill`，否则模型拿到目录却打不开。

`allowTools` 白名单在 `restrictAgentTools` 里生效。**默认值不是空的**：17 个名字（只读文件 +
检索 + 联网 + 十个 `qq_*`），所以 `qq` 预设里带的 `write` / `edit` 默认拿不到；显式写空数组才是
「不限制」。名字写错会被丢掉并记 warn（白名单只能收窄）。

## 8. 测试与验证

```bash
node --test test/                      # 全部用例（普通终端里跑这一条）
node --test test/settings.test.mjs     # 只跑配置取值口径（最快）
node --test test/speaking-rules.test.mjs  # 只跑「什么时候该主动开口」的判据
```

测试用**真实插件模块 + 真实 OneBot 客户端 + 真实 `createUserMessage`**，只有 Harness Host 是桩
（含**假 timer 服务**：摘要循环由 `host.list.timers.fireInterval()` 唤醒）。docs/development.md「跑测试」那条
很长的覆盖清单**就是行为规格**：改行为前先读，改完按它核对要不要补用例。

**Windows 上要先把依赖铺好**（`node_modules` 不是软链，见 §2 末尾）：
`node scripts/dev-node-modules.mjs --from <DSH checkout>`；DSH 沙箱里 `node --test` 会
`spawn EPERM`，改用同进程模式 `node --test --experimental-test-isolation=none "test/*.test.mjs"`。

- 测试是唯一能自动验证的东西：**改完必须跑，且必须全绿**（基线：`test/` 下 **580** 个用例，
  普通终端约 45 秒全过）。0.2.0 删掉 JM 之后**不再有「跳过」**：原先 13 条探针需要真 spawn
  外部进程，沙箱里只能跳过，随 JM 一起删掉了。
- 已知偶发：**全量同进程连跑**时偶尔红一条、且每次红的那条都不同（见过 `proactive` 节奏、
  `allowTools`、群聊图片、`qq_transcript` 四组的用例），单独跑永远绿 —— 是 `until` 轮询与真实
  计时的竞态，重跑确认即可，**别为了「让它稳」去放宽断言**。
- 加行为就加用例，用例名/注释用中文写清意图。**改哪个模块就跑哪个文件**：
  `config.js`/`settings.js`→`settings.test.mjs`；`chatter.js` 与活跃对话判定→`chatter.test.mjs`；
  `speaking-rules.js` 或 `admit` 里凑入参那几行→`speaking-rules.test.mjs`；
  `mention.js`/`registerParticipant`/`sendParts`→`mention.test.mjs` + bridge 里那组端到端；
  `perceptual.js` 或复读的图片判定→`perceptual.test.mjs`；`stickerFileName`/`saveSticker`→
  `util.test.mjs` + bridge 里搜 `qq_save_sticker`；记忆相关→bridge 末尾那组；
  主动说话→bridge 末尾 `bootProactive` 那组（靠 `digestMinLines: 9999` 隔离摘要循环，
  假 `fireInterval()` 会唤醒**所有**周期定时器）；`sessionIdFor`/`resetConversation`/`canReset`
  →bridge 里搜 `reset`；`rotateApiKey`/`probeApiKey`/`parseApiKeyPool`→bridge 最后的
  `bootKeyRotation` 那组；`napcat.js`/`desktop.js`→`napcat.test.mjs` / `desktop.test.mjs`；
  `util.js`/`filestore.js`→各自的用例；`client.js`（设置页）→`client.test.mjs`（它同时钉住
  「每个配置项都有分组」这条）；`persona.js`/`style.js`/`speech-policy.js`/`modalities.js`/
  `links.js`/`interactions.js`/`recall.js`/`cognition.js`/`ops.js`→同名 `test/<模块>.test.mjs`；
  撤回的端到端（三种位置 × 三种模式）→bridge 末尾 `bootRecall` 那组；迁移脚本→
  `migrate-cognition.test.mjs`。
- **读 `agent.inbox` 的用例要等 `untilInbox(host, n)`，别只等 `host.list.created[0]`**：假 Host 的
  `create()` 是如实照搬真宿主的 —— Agent 先记进 `created`，消息由插件**之后**才
  `agent.followup(...)` 投进去，而 `until` 是 20ms 轮询，于是会偶发地抢在投递之前断言
  （症状：`inbox[0]` 是 undefined，或 `completeTurn` 拿着 `message: undefined` 去开 turn；
  同一个文件里这类写法曾有 23 处，跑全量时随机翻车）。只关心「创建了几个 Agent」的用例
  仍然直接用 `until(() => host.list.created[0], …)`。
- 纯函数（`onebot.js` 的拆分/延迟/采集/`mentionsOthers`、`image.js`、`media.js`、`perceptual.js`、
  导出的 `withinActiveHours` / `parseApiKeyPool` / `pathInside`）尽量单独测边界。
- **插件进程本身不归测试管**，改完记得重启（§5.1；Windows 桌面版是重启整个应用）。

## 9. 改完的检查清单

- [ ] `node --test test/` 全绿
- [ ] 新增/修改的注释是中文，且解释了「为什么」
- [ ] `Config` 字段（若新增）在 docs/configuration.md 的配置表里同步
- [ ] 行为变了 → docs/ 对应分册 + `Config.description` 同步
- [ ] 没有引入任何 `dependencies`，没有删 `node_modules` 软链
- [ ] 改的是运行时代码 → 提醒用户重启 `qqbot` profile（systemd 或 tmux）
- [ ] 动过 `sessionIdFor` / 会话代次 → 确认「第 0 轮的 id 逐位没变」，且代次仍然落盘
- [ ] 动过权限判断（`resetUsers` 之类）→ 确认「不配 = 全关」，而不是「不配 = 人人可用」
- [ ] 涉及安全面（审批策略、白名单、`cwd` 越界校验）的改动单独复核过
- [ ] 动过记忆写入（`qq_memory` / `cognition.js` 的 upsert / normalize）→ 跑
      `test/cognition.test.mjs` + `test/bridge.test.mjs` 里搜索 `upsert` 的那组，并确认
      「整份重写丢行会被拒」「重复标题会被合并」两条仍然成立
- [ ] 加/改了配置项 → 跑 `test/client.test.mjs`（分组别漏、标签别退化成字段名）
- [ ] 动过引用链（`quote` / `clearQuoteFor` / `batchQuote`）→ 确认「清一处三处生效」，且
      bridge 的 `bootRecall` 那组仍然绿（它们钉住「不许给已撤回的消息挂 reply 段」）

## 10. 常见坑速查

| 症状 | 真因 |
|---|---|
| 改了代码没生效 | Loader 按 URL 缓存模块 → 必须重启进程（§5.1） |
| **bot 完全不回复**，但 `systemctl --user is-active qqbot` 显示 active | `inject` 漏声明了代码里用到的服务：`ctx.interval` / `ctx.timeout` 属于 `timer`，cordis 不允许访问未声明的服务，`apply()` 当场抛错 → 插件整体不激活（journal 里是 `cannot get property "timer" without inject` + `dsh: warning: 1 entry did not activate`）。代码里用到的每个服务都要进 `inject` |
| 测试全绿但真宿主上插件不激活 | 假 Host 桩比真宿主宽松（例如无条件提供 `ctx.interval`）；改桩时要连 cordis 的 inject 检查一起复现（见 `test/bridge.test.mjs` 的 `requireTimerService`） |
| `failed to import @deepseek-ai/*` | `node_modules` 软链被删了 |
| journal 里没有任何插件日志 | 用了 `ctx.logger` 而不是 `report()`（§5.8） |
| 群里回复乱序 / 串话 | 绕过了 `enqueueSend` / `enqueue` 串行队列 |
| 表情包/图片功能静默失效 | `mediaDir`/`stickerDir` 被配到 `cwd` 外，代码只记 warn 并停用 |
| 群里收到「（那张表情我这儿没有，发不出去）」 | 模型把 `.qq-media/<哈希>` 或别的路径写进了 `[[图片: …]]`：发表情**只认 `.qq-stickers/`**（`stickerSendSource`）。下一轮提示词里会带上这次失败的原因 |
| 记忆文件里的条目「写了却不生效」 | 那一行字段不全（少于两段），`parseCognition` 只 warn 跳过；`qq_memory read` 的 note 与 `ops doctor` 的 `COGNITION_UNPARSED` 会点出来。用 `upsert` 重写那一行，别手写 markdown |
| bot 回「存好了」但 `.qq-stickers/` 里没有那张图 | 工具没注册：旧进程没重启（§5.1）/ 目录停用 / `imageSend: false` / `allowTools` 里没有它。它会退回往 `COGNITION.md` 记一个会过期的 `.qq-media/<哈希>` 路径 |
| subagent 出现在 QQ 会话里 | 预设用了 `standard`，`tools.restrict()` 收不到作用域内注册的工具（§7） |
| agent 会话突然没能力了 | `agentPreset` 没 join 到预设，或 `allowTools` 挡掉了 |
| **群里不 @ 它就不说话 / 人设没了 / QQ 会话冒出 subagent** | profile 的 `~/.dsh/profiles/qqbot/cordis.patch.yml` 里给 `qq-bridge` 写了 `config`：patch 是整块替换，仓库 patch 的整套配置被顶掉（§5.10）。删掉那一行，配置改回仓库 patch |
| `/reset` 突然没人能用 | `resetUsers` 由 `<启动 cwd>/.env` 的 `QQBOT_RESET_USERS` 决定（§11）；`.env` 只在启动时读，改了要重启 |
| **Web UI 里改完配置没反应 / 页面上找不到配置** | 那个 `loader/volatile-update` → `ctx.fiber.restart()` 的监听没了；或根上的 `.volatile()` 被删（`describe()` 直接跳过这个条目，页面都不会注册，见 §5.12） |

## 11. 运行环境（本机）

```
profile   ~/.dsh/profiles/qqbot/   （bundles: dsh-base + dsh-web-app + 本插件，link 安装）
运维      node scripts/ops.mjs doctor --json   （三套部署共用；`--apply` 默认关，见 docs/ops.md「一键运维」）
UI/启动   http://127.0.0.1:3081/   或 dsh --profile qqbot --port 3081 --no-open
重启/日志 systemctl --user restart qqbot ｜ journalctl --user -u qqbot -f
OneBot    容器 napcat（mlikiowa/napcat-docker），端口 3001 = WebSocket **服务器**
凭据      DEEPSEEK_API_KEY：推荐在 3081 的 Web UI Models 页填一次（写入
          $DSH_HOME/.credentials.yaml，任何启动方式生效）
私有配置  profile 的 cordis.patch.yml **只放 locale / ui-settings 这类覆盖**；插件配置走 3081 的
          **设置 → QQ Bridge**（保存会写 profile patch 并重启插件，见 §5.12），或直接改仓库的
          cordis.patch.yml —— 但**别手写只有几个字段的 profile config**（见 §5.10）。
          /reset 白名单在仓库根的 .env（gitignore，**别把真号提交进仓库**）：QQBOT_RESET_USERS=<你的QQ号>；
          .env 只在启动时读一次，改完必须重启（§5.11）。
```

调试实时行为可以直接开 3081 的 Web UI 看 QQ 会话（每个 QQ 会话就是一个 Session）。
