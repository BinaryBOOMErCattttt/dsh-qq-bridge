# AGENTS.md — 给智能体的项目说明书

给要**改这个项目**的智能体看的最小充分上下文。用户视角的功能说明在
[README.md](README.md)（中文，写得很好）—— 本文只讲「代码长什么样、动哪里、
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

- **入站**：QQ 私聊/群 @ 消息 → 一个持久的 DSH Session → Agent 处理 → 结果发回 QQ。
- **出站**：任何 DSH Agent（含 Web UI 主会话）都能调 `qq_send_*` 工具主动发消息/图片；
  `[[图片: 路径]]` 标记能把表情按正文位置发出去（整条只有这一行 = 只发一张表情、一个字不说），
  `qq_save_sticker` 把别人发的那张**存进** `.qq-stickers/`（见 §6 表与 README 的同名小节）。
- **不走模型的两条旁路**：群里的**自动复读**，和 `/jm` **禁漫下载**。
- **主动说话**（默认关）：群里安静下来之后，插件往**该群自己的会话**里伪造一条提醒，
  让它带着环境上下文与长期记忆自己想一句冒个泡（见 §4.F）。
- **活跃对话**：聊起来之后不再是「每句都得 @ 一次」—— 一对一的免 @ 接话
  （`activeFollow`，默认关，`activeWindowMs` 默认只买 1 分钟）、群里几个人聊热之后的
  **多人搭话**（`activeGroup*`，谁接话都算、倾听时间变长），以及「回完对方安静一会儿再
  补一句」；见 §4.G。
- **长期记忆**：每条消息落盘成转录，定时由一个**独立摘要会话**照 `.dsh/skills/` 里的
  `message-digest` skill 整理成「这个群记得什么」，聊天时用 `qq_transcript` / `qq_memory`
  查；顺带用 `update-cognition` skill 学会群里的梗和表情包，看不懂的二次元梗先走
  `moegirl` skill 查萌娘百科（见 §4.E）。
- **每天轮换模型凭据**（`apiKeyRotate`，默认开）：每天 04:00 从 `cwd/data/api-keys.txt`
  里挑下一个**探测通过**的 key，交给 `ctx.credentials.set()` 写进
  `$DSH_HOME/.credentials.yaml`（凭据层监听文件，当场生效、不用重启）；池子不存在、
  没有第二个能用的 key、或者 key 本来就由启动环境提供时，什么都不做（见 §4.I）。

技术约束（决定了代码的写法，别无意打破）：

| 约束 | 原因 |
|---|---|
| **零运行时依赖** | 只用 Node 全局 `WebSocket` / `fetch` / `node:*`。`package.json` 没有 `dependencies`，OneBot 客户端是手写的（`onebot.js` 707 行）。 |
| 纯 ESM，Node ≥ 22（本机 v26.11.1），无构建步骤 | `"type": "module"`，改完即用。 |
| 没有 TypeScript，JSDoc 注释代替 | 全部类型信息在注释里。 |
| 注释、日志、面向用户的文案**一律中文** | 与 README 一致，别在中途切成英文。 |

## 2. 文件地图

```
index.js      3524 行  插件本体：全部运行时状态、事件路由、发送/准入/复读/存表情包/主动说话/活跃对话、连接生命周期
chatter.js      171 行  群里「谁在说话」的三本账（插话序号 / 回答指向 / 热度窗口）：只暴露语义动作，不暴露 Map
mention.js      209 行  `[[@昵称]]` → OneBot `at` 段：纯函数解析 + 「昵称 → QQ 号」名单（名单挂在会话记录上）
speaking-rules.js 292 行  「什么时候该主动开口」的纯判据（五道闸门 + 两个节奏闸、免 @ 接话与搭话抽卡、补一句的九条闸门）：给普通入参、返回布尔
util.js        269 行  **不碰运行时状态**的纯函数：sessionIdFor / 文本压缩 / 本地时间 / 记忆路径与表情包文件名的写边界 / key 池解析与打码 / withinActiveHours
filestore.js    92 行  几个「原子写 / 尽力而为读」的小工具（读不到返回空而不是抛错），记忆、转录与存下来的表情包都走它
config.js      142 行  配置 schema（**配置的唯一真相来源**）：纯数据，一百多条带中文 .description() 的字段
settings.js    252 行  配置的运行时视图：取默认值 / 强制类型 / 夹紧 / 去空白全在这里，`index.js` 只读 settings.*
tools.js       640 行  7 个宿主平面工具的**声明**（qq_send_message / qq_send_image / qq_save_sticker / qq_list_conversations / qq_jm_pdf / qq_transcript / qq_memory），依赖由 index.js 显式传入
memory.js     1143 行  长期记忆子系统：转录落盘、记忆文件读写（那两个记忆工具的能力来源）、每日摘要循环；依赖由 index.js 显式传入
onebot.js      707 行  OneBot v11 客户端 + 纯函数（分条/复读/延迟/媒体采集/文本化/@ 名单提取）
media.js       327 行  入站媒体：QQ 的图/表情包 → 按内容哈希落盘 → 给模型 read_image 的本地路径
image.js       135 行  出站图片：本地路径 / URL → 校验（大小、格式、目录越界）→ base64:// 段
jm.js          490 行  禁漫下载服务：spawn python、一次性 URL、给 NapCat 的小 HTTP 文件服务
perceptual.js 约 1080 行  图片指纹：JPEG(DC)/PNG/GIF → 16×16 灰度 → dHash，复读判「同一张画面」用
scripts/jm_download.py  禁漫下载的 python 实现（jmcomic + img2pdf），唯一非 JS 的逻辑
.dsh/skills/message-digest/SKILL.md    聊天记录 → 长期记忆的流程（定时摘要与「以前说过什么」用它）
.dsh/skills/update-cognition/SKILL.md  学梗 / 表情包含义 → COGNITION.md 的流程
.dsh/skills/moegirl/SKILL.md           二次元梗 → 萌娘百科 MediaWiki 接口查意思的流程（只读，不落盘）
test/bridge.test.mjs  集成测试：假 OneBot 服务端 + 假 Harness ctx（含假 timer），跑完整往返
test/settings.test.mjs  配置归一化的契约测试（默认值 / 非法值 / 白名单不 trim 这类刻意的不对称）
test/chatter.test.mjs   「谁在说话」三本账的**不变量**测试（合并两本账就会红的那种）
test/speaking-rules.test.mjs 主动说话 / 免 @ 接话 / 搭话抽卡 / 补一句的判据：每个用例从「通过」的基准入参出发，只翻一个字段
test/mention.test.mjs  `[[@昵称]]` → at 段的纯函数测试：标记边界、认不出来就丢、名单按会话隔离
test/util.test.mjs      纯函数边界：写边界 memoryRelativePath 与 stickerFileName、memorySlug、本地时间、errorText、key 打码
test/filestore.test.mjs 原子读写与「读不到就返回空/undefined，不抛错」这条失败语义
test/jm.test.mjs      下载链路的单元/协议测试（假 python shell 脚本）
test/perceptual.test.mjs  图片指纹的单元测试（同图不同编码 / 异图 / 畸形输入 / 解压炸弹）
test/image-fixtures.mjs  上面两个测试共用的图片 fixture（真编码的字节，不是 test 文件）
cordis.patch.yml      插件自带 bundle patch：注册 `qq` Agent 预设（含 skill 平面）+ 插件 config
locale/{zh,en}.json   插件在 Web UI 里的标题/描述
deploy/qqbot.{service,env.example}  systemd user unit 与凭据模板
README.md             用户文档 + 设计取舍（改行为要同步它）
AGENTS.md             **本文件**：给改代码的智能体的说明书（DSH 会自动注入上下文）
```

**数据目录**（全部 gitignore，运行时生成在 `cwd` 下）：`data/`（会话缓存 + `/reset` 标记 +
`api-keys.txt` 这个可选的 key 池）、`.qq-media/`
（入站图片 LRU 缓存）、`.qq-stickers/`（表情包：**你自己丢进来的 + 模型用 `qq_save_sticker` 存下来的**）、`.qq-jm/`（下载的 PDF）、
`.qq-memory/`（长期记忆：转录 + 摘要 + 认知 + 摘要进度）。**`memoryDir` 与其它三个一样
必须在 `cwd` 内**，否则记忆功能记一条 warn 并停用。

### 依赖方向（保持单向，别造环）

```
index.js ──▶ config.js（schema，纯数据）
         ──▶ settings.js ──▶ image.js（只借 DEFAULT_IMAGE_MAX_BYTES）
         ──▶ tools.js ──▶ mention.js / onebot.js / image.js / jm.js（工具只用这几个的纯函数）
         ──▶ chatter.js（谁在说话的三本账，纯内存结构）
         ──▶ mention.js（`[[@昵称]]` → at 段，纯函数；名单由 index.js 挂在会话记录上）
         ──▶ speaking-rules.js（主动开口的纯判据，无状态无 IO）
         ──▶ memory.js ──▶ util.js / filestore.js（长期记忆子系统，纯文件 IO）
         ──▶ util.js（纯函数，无 IO）/ filestore.js（原子读写）
         ──▶ onebot.js / media.js / image.js / jm.js / perceptual.js
                      └── media.js 用到 onebot.js 的占位符/嗅探约定
test/*  ──▶ 直接 import 上述模块（不经过 Harness）；bridge.test.mjs 只 import index.js
```

**没有环**，这条要守住：`tools.js` / `settings.js` / `memory.js` **都不 import `index.js`** ——
它们需要的东西一律由 `index.js` 在装配时显式传进去（见 §3）。反过来的话就是循环依赖，
ESM 下会在加载期炸成 `Cannot access before initialization`。

被 Harness 注入的只有三样：`@deepseek-ai/schemastery`（配置校验）、
`@deepseek-ai/dsh-tools`（`defineTool`）、`@deepseek-ai/dsh-llm`（`createUserMessage`）。
它们通过 `node_modules` 软链解析：

```
node_modules -> ~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules
```

> ⚠️ **不要删这个软链**。`link:` 安装按真实路径解析依赖，删了插件会 `failed to import`。

## 3. `index.js` 的结构（动代码前先认路）

`apply(ctx, config)` 是一个大闭包，**所有运行时状态都是闭包里的 Map**（重启即清空，
只有会话历史落在磁盘上）。按文件内 `// ----` 分节读，行号是当前版本：

| 区域 | 关键符号 | 说明 |
|---|---|---|
| 顶部常量 | `CHANNEL_SECTION_ORDER=8950`、`PRESET_NONE`、`QUOTE_TEXT_CHARS`、`STICKER_PROMPT_MAX` | 调提示词用 |
| 配置 schema | **不在这里**：在 `config.js`（第 136 行只是 `export { Config } from './config.js'`） | 唯一真相来源，`.description()` 就是 Web UI 上给用户看的文档 |
| 配置的取值 | **不在这里**：`settings = createSettings(config, process.cwd())`（第 172 行）之后一律读 `settings.*` | 取默认值/夹紧/去空白都在 `settings.js`；`index.js` 里**没有一处**直接读 `config.xxx` |
| 运行时状态 | 第 243–534 行 | `conversations`(key→会话) / `sessionIndex`(sessionId→key) / `turnOwners` / `submitted` / `transcripts` / `ambient` / **`chatter`**（谁在说话的三本账，见 `chatter.js`；`chatterSeq` / `groupChatter` / `quoteSeq` 是它搬出去之前的名字）/ `repeatStates` / `mediaResolutions`（记忆的五张账已经跟着子系统搬去 `memory.js`）；每条会话记录里还挂着 `sessionGeneration`（第几轮会话，`/reset` +1）/ `lastActiveAt` / `lastBotSpeakAt` / `activeInterposeSeq`（那条消息那一刻的插话序号快照）与主动说话、活跃对话的那几组记账（见 `blankConversation`） |
| Agent 装配 | `ensureAgent` `resolveAgentPreset` `mountAgentPreset` `restrictAgentTools` `channelPrompt` | 见 §7 |
| 发送链路 | `enqueueSend` `sendToConversation` `replyPieces` `sendParts` `sendOne` `quoteHead` `conversationMentions` | 串行队列保证同一会话的消息不乱序；`sendOne` 顺便记 `lastBotSpeakAt`（主动说话靠它避免独白）；正文里的 `[[@昵称]]` 在 `sendParts` 里换成 `at` 段（解析在 `mention.js`），没有标记的段仍然发纯字符串 |
| JM 旁路 | `readJmCommand` `runJmCommand` `sendJmFile` `downloadJm` | `/jm 422866` 不进 Agent、不建会话 |
| 会话管理 | `resetConversation` `conversationFor` `sessionIdFor` `resetMarkerDir` `loadConversationResetCounts` `writeConversationResetCount` `refreshSessionGeneration` | `/reset` 开新一轮（**不删旧会话**，代次 +1 并落盘），以及在线会话列表（新一轮时连主动说话的节奏一起清） |
| 准入与复读 | `admit` `noteChatter` `touchActivity` `rememberAmbient` `registerParticipant` `maybeRepeat` `repeatStep` `sketchOf` `sameCandidate` | 白名单、群触发判定、环境上下文（**顺带登记「谁可以被 @」**，名单挂在会话记录的 `participants` 上）、复读状态机（图片来源判定 = 字节相同 **或** 画面指纹相近，见 `perceptual.js`）；`admit` 里还有「活跃对话」那条免 @ 的旁路 |
| 主动说话 | `proactiveSweep` `proactiveEligible`（适配器）`proactiveSpeak` `proactiveNudge` `busyWithTurn` `proactiveTodayCount` | 见 §4.F；**闸门本身在 `speaking-rules.js`**（`proactiveEligible` / `proactiveSkip`），这里只负责把会话记录凑成入参；定时器在生命周期那一节，`withinActiveHours`（util.js）是纯函数 |
| 活跃对话 | `noteActiveMessage` `activeFollowAllows` / `activeTurnsLeft` / `activeTalkChance` / `activeTalkAllows` / `chimeAllows` / `chimeDelay` / `batchScale`（适配器）`groupTalkActive` `scheduleChime` `cancelChime` `runChime` `chimeSpeak` `chimeNudge` `chimeTodayUsed` | 见 §4.G；A（一对一免 @）与 C（多人搭话）都在 `admit` 里判，够资格后共用一次抽卡（`talkMisses`），倾听倍数在 `holdForBatch` 里用，B（补一句）挂在 `turn/end` 之后 |
| 攒批 | `enqueue` `holdForBatch` `flushBatch` `submitBatch` `renderBatch`；`batchWindow` / `batchCap` / `batchScale` 是 3 行适配器，算法在 `speaking-rules.js` | 前后脚到的消息合成一条再投给 Agent；多人搭话时窗口与上限同倍放大（见 §4.G） |
| 媒体 | `resolveMessageMedia` `mediaFor` `resolveQuote` `hydrateAmbientMedia` | 环境上下文与复读**共用同一次下载**（`mediaResolutions` 这个 WeakMap 就是干这个的） |
| 事件轮转 | `handleEvent`（约 77 行）+ 持久化事件路由 | 见 §4.A；`turn/end` 里按 `owner.proactive` 分流 |
| 长期记忆 | 只剩一行装配（`const memory = createMemory({ … })`）与三个调用点（`handleEvent` / `channelPrompt` / 生命周期） | 整个子系统在 `memory.js`（见 §4.E）；依赖表就在那一行里 |
| 模型凭据轮换 | `rotateApiKey` `probeApiKey` | 见 §4.I；每天到点从 `apiKeyFile` 里挑下一个探测通过的 key，交给 `ctx.credentials.set()` 写进 `$DSH_HOME/.credentials.yaml`（**不用重启**，凭据层监听该文件）。时段/超时/探测地址这些取值在 `settings` 上 |
| 工具装配 | `registerQqTools(ctx, { … })`（第 3260 行起，24 行） | 只剩一张**依赖表**：把上面那些函数递给 `tools.js`（记忆那一格是 `memory.tools`，存表情包那一格是 `saveSticker`）。工具声明本身在 `tools.js`，不在这里 |
| 生命周期 | `ctx.effect(...)` | 托管 socket、JM 的 HTTP 服务、API key 轮换定时器、主动说话的定时器；摘要定时器由 `memory.startDigestTimer()` 挂 |

**体量实况**（别被文件行数吓到）：闭包里 90 个函数，中位数 10 行；超过 60 行的只有 8 个
（最长的是 `channelPrompt`，大半是提示词模板）。文件大是因为「一个大闭包 + 大段取舍注释」，
**不是因为函数失控** —— 别把「拆函数」当成这里的重构方向，这里的边界问题是**模块级**的。

**往外搬的两条纪律**（`tools.js` / `config.js` / `settings.js` / `util.js` / `filestore.js` /
`chatter.js` / `memory.js` / `speaking-rules.js` 都是这么搬的）：

1. 被搬出去的模块**不 import `index.js`**（那会成环，ESM 下加载期就炸）。需要的东西
   分两类，别混：
   - **叶子模块直接 import** —— `util.js` / `filestore.js` / `onebot.js` / `image.js` /
     `jm.js` / `perceptual.js` 与 `@deepseek-ai/dsh-*` 都不依赖闭包，本来就能在任意上下文
     里调，当参数传进来只是多一层看不出来的间接（`tools.js` 直接 import `chunkText` 就是
     这个道理）。
   - **闭包里的状态与装配动作走 `deps`** —— 会话表、`settings`、`ctx`、开 Agent 的那几个
     动作，只有 `index.js` 有。`tools.js` / `memory.js` 的 `deps` 表就是样例，它同时是一份
     「这个模块能碰什么」的清单。
   （这一步一开始把 `errorText` / `sessionIdFor` / `createUserMessage` 也当依赖传了进去，
   与「`localDate` 直接 import」并列时显得很怪 —— 后来收掉了。新模块别重犯。）
2. `index.js` 里**保留再导出**（`export { Config } from './config.js'`）—— `bridge.test.mjs`
   只 import `index.js`，Loader 也只认插件入口，搬走的东西必须在入口处仍然拿得到。

**模块级纯函数都不在本文件里**：`util.js` 放「同样的输入永远同样的输出」的那批
（`sessionIdFor` 会话 id 派生 / `memorySlug` / `localDate` / `localStamp` /
`msUntilDailyHour` / `hourLabel` / `withinActiveHours` / `memoryRelativePath` 写边界 /
`stickerFileName` 表情包文件名的写边界 / `parseApiKeyPool` / `apiKeyFingerprint` /
`visibleText` / `errorText` / `memoryOneLine`），
`filestore.js` 放碰磁盘的那几个（`writeJsonAtomic` / `writeTextAtomic` / `writeBytesAtomic` /
`readTextOrUndefined` / `readJsonl` / `readdirOrEmpty`）。

判断一个新函数该放哪：**碰闭包状态就留 `index.js`，碰磁盘去 `filestore.js`，其余去 `util.js`。**
`util.js` 里不许引入闭包状态 —— 它保持纯粹才可能被单测，也才敢在任意上下文里调。
`sessionIdFor` / `parseApiKeyPool` / `withinActiveHours` 的契约由 `bridge.test.mjs` 从
**插件入口**验，所以 `index.js` 里对这三个保留再导出（见上面的两条纪律）。
`msUntilDailyHour` 尤其值得单独测边界（刚过点要排到明天，不能原地反复醒）。

## 4. 十条数据流（改任何一条先读对应的那条）

### A. 入站消息 → Agent → QQ（主链路）

```
QQ ─▶ NapCat ─ws─▶ OneBotClient.onEvent ─▶ handleEvent
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
                                                    error 回一句固定道歉（主动搭话除外，见 §4.F）
                                              ▼
                       sendToConversation(..., { human:true, quote }) → sendParts()
```

⚠️ `rememberTranscript` 必须在 `handleEvent` 的三个提前 `return`（环境上下文、`/jm`、
`/reset`）**之前**调用，否则那些消息不会进转录。它同时也要**在 `admit` 之前**判定自己的
准入规则（渠道开关 / 白名单），因为 `admit === undefined` 的闲聊同样要记 —— 长期记忆的
原料正是那些没人 @ 机器人的话。它**不建会话记录**（`conversations` 是「处理过哪些会话」
的表，闲聊不该把某个群变成「处理过」），只按 key 往记忆目录追加。

### B. 出站：Agent 主动发

`qq_send_message` / `qq_send_image` / `qq_jm_pdf` 直接调 `client.call('send_*' | 'upload_*', …)`；
`qq_list_conversations` 只查询；`qq_save_sticker` 只写表情包目录（**不发消息**，写边界与
「什么时候会注册」见 §6 表与 README「`qq_save_sticker` 工具」）；
`qq_transcript` / `qq_memory` 只读写记忆目录。注意区别：
**工具**（显式动作）只按协议上限 `chunkText` 分段，**不加**打字延迟；拟人节奏只加在
A 链路的自动回复上。

### C. 自动复读（不经过模型、不建会话）

`maybeRepeat` → `repeatStateFor(groupId)` → 私有串行队列 `repeatStep` →
`repeatCandidate`（文字按归一化正文 / 图片按「字节哈希 + 画面指纹」/ 系统表情按 id）→
`sameCandidate` 判「跟刚才那条算不算同一个」→ `sendRepeat`。
配置项是 `repeat*` 一族，行为细节 README「自动复读」一节写得很全，改之前务必读。

不能踩的：

- **图片来源判定必须留两层**：字节完全相同只是快路；QQ 会把同一张表情包按发送者重新编码
  （实测同一张「寿来」有 94657B/131307B/79284B 三种形态，画面 SSIM ≥ 0.985），只比字节的话
  这一整块在真实群里永远不触发。第二层是 `sketchOf` 算的画面指纹（`perceptual.js`），
  阈值 `repeatImageTolerance`（0 = 关掉那一层）。指纹是**懒算 + 按路径缓存**的：只有真要
  比两条字节不同的图时才读盘解一次 —— 别改成在 `repeatCandidate` 里就算，那会让每条表情包
  消息都白解一遍。
- **指纹是对不可信字节做二进制的解析**：`perceptual.js` 里所有尺寸/块数/扫描数/解压长度
  都有硬上限，任何畸形输入只允许返回 undefined，绝不允许抛异常或大块分配。加格式（比如
  WebP）之前先把这几条上限补上。
- **`sketchOf` 只读 `.qq-media` 里刚落盘的那一张**（`outcome.path` 是内容哈希命名的相对
  路径），别让它去读工作目录里的任意文件 —— 那等于把群消息变成读文件的入口。

### D. 禁漫下载

QQ 里 `/jm 422866`（`readJmCommand` 旁路）或 Agent 调 `qq_jm_pdf` → `downloadJm` →
spawn `.venv/bin/python scripts/jm_download.py`（JSON Lines 协议，先 `meta` 后 `result`）
→ 合并成一个 PDF → **不能把本地路径给 NapCat**（容器里读不到，实测回 `识别URL失败`）
→ `jm.js` 在本机开一个小 HTTP 服务 + 一次性 token，让 NapCat 自己来拉
（`jmFileHost` 默认 docker 网桥 `172.17.0.1`）。

### E. 长期记忆（转录 → 定时摘要 → 认知）

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

- **摘要 Agent 不是记忆的载体**：它只读磁盘上的转录、只写磁盘上的记忆文件。所以它被
  压缩、被销毁、被重启都不影响记忆 —— 别把「记住」实现成会话上下文里的东西。
- **一天至多一次靠日期判据**（`localDate(lastDigestAt)` vs 今天），不是「距上次 ≥ N 小时」：
  定时器是「每天一个整点」，重启后同一天不能摘要第二遍。改这个判据时要一起改
  `lastDigestDate` 的写入。
- **`digest.json` 只在成功之后才推进**；正在排队的消息靠内存里的 `memoryDirty` 计数
  （重启归零，靠 `lastDigestAt` 重新数），所以「摘要没跑成」不会把消息算丢。
- **别在启动时直接扫一遍**：`conversations` 是运行时状态，`apply()` 那一刻还是空的，
  扫不到任何东西。补课挂在「重启后第一条消息到达」这个时刻上（`maybeCatchUpDigest`）。
- **读转录之前要先等写入**（`writesFor` + `Promise.all`）：转录是后台追加的，而摘要
  可能紧跟一条消息触发 —— 不等就会读到一个还没写出来的目录，然后静默跳过。
- **摘要 Agent 不在 `sessionIndex` 里**，它的 turn/end 因此不会往 QQ 发东西 —— 这是
  「后台会话」与「QQ 会话」唯一的区别机制，别把 digest session 注册进去。
- **写边界只有一处**：`memoryRelativePath`（模块级纯函数）。`qq_memory` 的写路径必须
  过它，`../` 与绝对路径都要被拒。要放开写入范围之前先想清楚 QQ 消息是不可信输入。
- **`memoryDir` 校验与 `mediaDir` / `stickerDir` / `jmDir` 同一套路**：配到 `cwd` 外
  记 warn 并整个停用（工具都不注册、定时器都不挂）。

### F. 主动说话（`proactive`，默认关）

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

- **伪造的 user message 必须说清「这不是谁发来的」并给出 `SKIP` 出口**：不给出路时，
  模型面对「没话找话」会硬编一句，比不说话更像机器人（文案见 `proactiveNudge`）。
- **`SKIP` 判定对 `所有` 轮次生效，不只主动那一轮**：提醒落在同一个会话的上下文里，
  模型会在**回别人**的那一轮（尤其那一轮还引用了消息）也照样写 `SKIP`。只在
  `owner.proactive` 分支里判的话，群里收到的就是一句字面的 `SKIP` —— 一个真实事故：
  它引用了别人的表情包，正文写着「SKIP」。会「引用」的本来就只有回别人那一轮
  （主动搭话的 `quote` 永远是空的）。判据在 `speaking-rules.js` 的 `proactiveSkip`。
- **掷中即消耗**：`SKIP` / 失败也算用掉当天额度与 `proactiveGapMs`。否则每次检查都重新
  掷骰子，频率失控 —— 这条由 `proactiveSpeak` 里「先记账再 followup」的顺序保证。
- **走的是这个群自己的会话**（与摘要 Agent 相反）：主动搭话必须看得见这段聊天的历史与
  环境上下文，否则接不上话。所以它**在 `sessionIndex` 里**，回复照常回 QQ。
- **`lastBotSpeakAt` 由 `sendOne` 记账**：这是「不做独白」的判据，别绕过 `sendOne` 直接
  `client.call('send_group_msg')`（那样机器人会以为自己一直没说话）。
- **`lastActiveAt` 由 `touchActivity` 在 `handleEvent` 里更新**，含**没被 @** 的群消息：
  群里正聊得热闹时最不该插嘴，那条闲聊必须算活跃。它只更新 `conversations` 里**已有**的
  会话 —— 「只对已经聊过的群生效」就落在这里。
- **状态全在内存**（`lastProactiveAt` / 当天计数）：重启归零。所以别把 `proactiveIdleMs`
  配成 0 又反复重启（那时每次重启都可能补一句）。
- **只群聊**：`proactiveEligible` 第一行就 `type !== 'group'` 返回 false，私聊不打扰；
  这是刻意不给开关的。
- **`withinActiveHours` 是模块级纯函数**（左闭右开 / 两边相等 = 全天 / `from > to` 跨零点）。
  改时段语义就改它，并跑它的边界用例。
- **闸门本身是纯函数**（`speaking-rules.js` 的 `proactiveEligible` / `proactiveSkip`）：五道闸门
  加两个节奏闸都收在一个 `(普通入参) → boolean` 里，`test/speaking-rules.test.mjs` 从一份
  「能通过」的基准入参出发、逐条翻动单个字段来证明「缺一条都不行」。`index.js` 里留下的
  同名函数只是**把会话记录凑成入参的适配器**（含两个带跨天归零副作用的计数读数）。

### G. 活跃对话（`activeWindowMs` / `activeFollow` / `activeGroup*` / `activeChime*`）

F 管的是**冷场**；这一块管「正聊着」。三条路共用一个「活跃对话」窗口（默认
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
                         submitted.set(msg.id, { …, proactive: true })  ← 与 F 共用分流
```

不能踩的：

- **窗口只靠别人发来的消息往后滑**（机器人自己说的话不滑）：否则它自己就能给窗口续命，
  「活跃」会变成一个永远不结束的状态。
- **三本账别合并，而且这件事已经不由注释维持了**：都搬进了 `chatter.js`，只暴露语义动作 ——
  `noteOther`（别人的话：插话序号 +1，并记进热度窗口）/ `noteSelf`（我自己的话：只推回答指向）
  / `others`（比**大小**，判「中间有没有人插过话」）/ `anchor`（**含我自己**，判「我回的那条
  被挤远了没有」）/ `isHot`（比**时间**，判「最近够不够热」，纯查询）/ `forgetHeat`（`/reset`）。
  `chatter.js` 的模块注释里写着为什么不能并成一张表，`test/chatter.test.mjs` 把那几条不变量
  钉成了断言（「我自己说一句不该推进别人的账」「一个人刷屏不算热」「窗口一过就退出」）——
  **合并了两本账，那些用例会直接红**，不用再靠人记得读这段文字。
  想知道「算不算我自己说的话」，看调的是 `noteOther` 还是 `noteSelf` 就够了。
  我自己那一票是在**发出去**那一刻由 `noteOwnMessage` 记的（NapCat 配的是
  `reportSelfMessage: false`，自己发的消息不会回灌，别指望事件）：`sendOne` + 两个发送工具
  + JM 上传四处。
- **多人搭话是纯查询（`groupTalkActive`），不存「搭话状态」**：大家一停，窗口自己就空了，
  它自动退出；存一个 `activeGroupUntil` 反而要处理「谁负责过期」。它也因此天然支持
  「有人插话就升级」——插话本身就是往门槛上走。**不消耗 `activeMaxTurns`**：那个上限是防
  一个人揪着它刷屏的，而这里的闸门是「够条数、够人数」，再叠一层只会让它在最热闹的时候哑掉。
- **够资格 ≠ 就接：A 与 C 共用一次抽卡**（`activeTalkChance` / `activeTalkAllows`，计数在
  会话记录的 `talkMisses` 上）：抽中、被 @ 到、或两个资格都不成立时归零。**A 路没抽中也必须走
  `noteActiveMessage(..., continued=true)`**（窗口照滑、轮数照扣），否则窗口会在概率攒够之前
  过期。空消息在抽卡之前就被丢掉。
- **搭话状态里只放大攒批（`batchScale`），不放大打字延迟**：`holdForBatch` 拿它乘窗口与上限，
  两处必须同倍——只放大窗口不放大上限时，`batchMaxWaitMs` 会把「多听几句」又卡回去。
- **`continued` 一路要传到 `submitBatch`**：前缀模式下按前缀长度硬切会切掉正文首字
  （`dropPrefix` 只对**显式带前缀**的那条调用）。
- **窗口接上的那句不是指令**：`handleEvent` 里 `commanded`（= 被叫到且不是 continued）
  挡在 `/jm` 与 `/reset` 两个旁路前面 —— 否则窗口里一句「jm 123」就绕开模型去下本子。
- **`admit` 里先看 `conversations` 里有没有这个群**：窗口回话（A 与 C 都是）不能凭空创建会话
  记录（那会让没被 @ 的闲聊把群变成「处理过」的会话，破坏长期记忆那条旧不变量）。
- **补一句只在正常回复之后挂**（`turn/end` 的非 proactive 分支），而且主动搭话自己那一轮
  不再挂 —— 否则它会补一句再补一句，变成对着空气自言自语。
- **补一句的九条闸门是纯函数**（`speaking-rules.js` 的 `chimeAllows`）：定时器醒来时那九条
  （编号、总开关、窗口、队列、两个上限、**对方有没有接**、群里插话、概率）全在一个判据里，
  同样有逐条翻动的用例。`runChime` 现在只剩「凑入参 → 掷骰子 → 叫 chimeSpeak」。
- **`chimeSeq` 是防漏的保险**：任何新消息（`noteActiveMessage`）与 `/reset`、插件卸载都会
  `cancelChime`，但正确性只依赖「编号对不对得上」，不依赖每个取消点都记得 `clearTimeout`。
- **`activeFollow` 默认关**：它放松的是「群里只在被 @ 时才说话」这条默认约定（A 与 C 一起），
  属于安全面（§5.5）。默认值、README 的配置表与「安全提醒」三处要一起改。
- **`/reset` 要清热度窗口**（`chatter.forgetHeat`）：不然新一轮的第一句就可能被上一轮的热度判成多人搭话。两个序号刻意不清（理由写在 `forgetHeat` 上）。
- **B 需要 `proactive: true`**：`scheduleChime` 的第一行就是总开关 —— 「允许它主动发消息」
  只有一个开关，别让补一句绕过它；A 与 C 不需要 `proactive`（启动自述因此挪到了
  `if (proactiveEnabled)` 块外面）。

### H. 会话轮次（`/reset` 开新一轮）

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

- **代次必须落盘**（见 §5.4）：只在内存里的话，重启会把第 0 轮的会话 resume 回来。
- **`/reset` 之后旧会话仍在磁盘上**，这是刻意的：它是那段聊天的存档。别顺手「清理」它，
  也别把它重新注册进 `sessionIndex`（那会让旧 Agent 迟到的 turn/end 当成这个会话的回复发出去）。
- **长期记忆与轮次无关**：转录 / `MEMORY.md` 都按会话 key（`memorySlug`）落，`/reset` 不动它们 ——
  「上一轮聊过什么」仍然查得到，只是不再占着上下文。
- **第 0 轮的 id 是历史契约**（见 §5.3）：`sessionIdFor(key, 0)` 必须与改动前逐位相同。
- **重置要过权限**（`canReset` / `Config.resetUsers`）：这是全项目唯一一个「白名单为空 =
  谁都不能」的配置项，与 `allowUsers` / `allowGroups` 的「空 = 不限制」**相反**，别顺手
  「统一」成一样的语义。判断点在 `handleEvent` 的 `/reset` 分支里、`flushBatch` **之前**：
  挪到后面会让没权限的人也拿到「攒着的消息立刻投出去」这个副作用。没权限时静默 return
  （不回「你没有权限」），那条消息已经由 `rememberTranscript` 记进转录了，保持这个顺序。

### I. 每天轮换模型凭据（`apiKeyRotate`，默认开）

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

- **必须走 `ctx.credentials`，别自己去改 `$DSH_HOME/.credentials.yaml`**：那个文档里还有
  浏览器会话等 records，手写一份很容易弄丢；凭据层自己带文件锁与写后通知。它监听该文件，
  所以 `set()` 之后**不用重启**，下一个模型请求就用新 key（llm-deepseek 每次请求都 resolve）。
- **`ctx.get('credentials')` 而不是把它写进 `inject`**：cordis 的 `ctx.get()` 明确允许
  「读一个没声明依赖的服务」，拿不到就返回 undefined。写进 `inject` 会让**没有凭据服务的
  组合整个插件不激活**（§10 第一条那种事故），而轮换只是顺带的事。
- **探测必须便宜且不消耗 token**：所以是 `GET /models`，不是发一次真对话。两个鉴权头
  （`Authorization: Bearer` + `x-api-key`）一起带，是为了同时兼容同一家的 OpenAI 面与
  Anthropic 面；别只留一个。
- **日志里绝不能出现完整 key**：用模块级 `apiKeyFingerprint`（前 6 字符 + sha256 前 8 位）。
  新增任何打日志的地方都走它。
- **「当前是哪个 key」是现算的，不落盘**：靠 `credentials.resolve` + 池子里的位置决定下一个。
  别加一个「上次换到第几个」的内存/磁盘状态 —— 重启、手工改 key、调整池子顺序都会让它跑偏。
- **不通过探测就不写**：池子里混进坏 key 时，宁可什么都不做也不能把 bot 换成不可用的状态；
  这也是「尝试轮换」里「尝试」二字的全部含义。
- **key 来自环境变量时提前退场**：环境变量优先级高于凭据文件，写进去也不生效；
  `describe()` 返回 `writable: false` 就是这个信号。
- **池子文件必须在 `cwd` 内**（`insideDirectory` 校验，与 `mediaDir` / `memoryDir` 同套路），
  配到外面记 warn 并整个停用；默认路径 `data/api-keys.txt` 已被 `.gitignore` 盖住。

## 5. 必须知道的硬约束

1. **改源码必须重启 Harness，停用/启用插件没用。**
   Loader 在进程内**按 URL 缓存模块**；`set_plugin`、`remove_bundle` + `install_bundle`
   都拿不回新代码（已验证）。只有 `cordis.patch.yml` 的**配置**能热生效。
   ```bash
   systemctl --user restart qqbot     # 常驻方式
   # 或 tmux 里 Ctrl-C 后：dsh --profile qqbot --port 3081 --no-open
   ```
   **唯一例外**：`scripts/jm_download.py` 每次下载都重新 spawn，改它不用重启。
2. **不要用 agent 的后台任务跑常驻进程。** DSH 的 bash 工具跑在
   `bwrap --die-with-parent` 沙箱里，沙箱一销毁子进程就死。常驻走 systemd user unit
   （`deploy/qqbot.service`，`Restart=always`）或 tmux。
3. **Session id 是确定性的，不许改算法。** `sessionIdFor(key, generation)` = SHA-256 裁成
   UUID 形状（固定版本位/变体位过格式校验），key 形如 `group:100000001` / `private:<QQ号>`。
   `generation` 是「第几轮会话」：**`generation === 0` 的输入串必须保持原样**
   （`dsh-qq-bridge:<key>`），改了它 = 所有人的聊天记忆全部丢失；≥1 时在 key 后面缀
   `:reset:<n>`，同样确定性。`/reset` 就是把这个数 +1（见 §4.H）。
4. **会话代次要落盘**（`<会话根>/reset/<slug>.json`，拿不到会话根时 `cwd/data/reset/`）：
   它只在内存里的话，重启会算出第 0 轮的 id、把 reset 之前的会话 resume 回来 —— 等于
   `/reset` 白按。标记按会话独立，一个坏了只影响那一个（别「一个都读不出来就全清空」）。
5. **`cwd` 既是 Agent 工作目录也是沙箱根。** `mediaDir` / `stickerDir` / `jmDir` /
   `memoryDir` 必须在 `cwd` 内，配到外面代码会**记 warn 并自动停用**该功能
   （`insideDirectory` 校验），这是有意设计，别改成抛错。
6. **QQ 消息是不可信输入。** 默认 `approvalPolicy: 'never'`（需要审批的操作直接拒绝）、
   群消息默认只在被 @ 时触发（`activeFollow` 会在有窗口时放开这一点，所以它默认关）、
   `/reset` 默认**谁都不能用**（`resetUsers` 空 = 全关，见 §4.H）。
   任何扩大 QQ 侧能力的改动都要重新想一遍这一点。唯一能让 QQ 会话写盘的是
   `qq_save_sticker`（只写 `stickerDir` 内、文件名洗成单层、张数受 `stickerMaxFiles` 限制，
   见 README 的同名小节）。
7. **`Config` schema 是配置的唯一真相（在 `config.js`）。** 加配置项 = 在 schema 里加字段
   （带**中文** `.description()`）+ 需要再加工的话在 `settings.js` 里加一行 + README 表格里
   同步一行。已有 100+ 字段，§3 的表格只是导览，别照抄。**`index.js` 里不允许出现
   `config.xxx`** —— 一律读 `settings.xxx`，否则取值口径又会散开（那是这次重构要消掉的东西）。
8. **日志要同时写 logger 和 stderr。** 这个部署没把 cordis logger 接到 stdout，
   `ctx.logger.warn()` 在 journal 里一个字都看不到。用 `report(level, msg)`，
   它靠 `logger.exporter` 是否存在来避免污染测试输出。
9. **同一会话的消息必须串行**（`enqueueSend` / `enqueue`）。QQ 消息到达顺序和异步
   IO 完成顺序不一致，绕过队列会串话/乱序。
10. **profile 的 `cordis.patch.yml` 里不许给 `qq-bridge` 写 `config`：DSH 的 patch 是整块
    替换，不是深合并。** `dsh-app-boot` 的 `applyEntryPatches` 对命中的行做
    `target[key] = value`，所以 profile 层写一个 `resetUsers` 就会把仓库 patch 里那整套
    配置（`activeFollow` / `proactive` / `batchWindowMs` / `burstSingleMaxChars` / `persona`）
    **连同 `agentPreset: qq` 与 `allowTools` 白名单一起顶掉**，插件静默退回 schema 默认值 ——
    表现是「群里不 @ 就不说话」，实际更严重：QQ 会话会挂上部署默认的 `standard` 预设
    （有 shell / 子代理 / write），而这是不可信输入面。真发生过一次。
    所以：配置一律改仓库的 `cordis.patch.yml`；**每台部署各不相同的值走环境变量**
    （DSH 启动时读 `<启动 cwd>/.env` 与 `$DSH_HOME/.env`，代码里 `!!js` 求值即可，
    `resetUsers` 就是这么接的，见 §11）；非要在 profile 层覆盖，就把整份 `config` 抄全
    （Web UI 的插件设置写的就是完整 config）。

## 6. 怎么改：任务 → 动哪里

| 想做的事 | 动哪里 |
|---|---|
| 加一个不碰状态的纯函数 | `util.js`（碰磁盘的放 `filestore.js`）；**别 import `index.js`**，也别让它读闭包状态 |
| 加一个配置项 | `config.js` 的 schema + （需要兜底/夹紧时）`settings.js` 加一行 + README 配置表 + `test/settings.test.mjs` 补边界 |
| 改提示词 / 人设 | `DEFAULT_PERSONA`、`channelPrompt`、`Config.persona` / `.instructions` |
| 加一个 Agent 工具 | 在 `tools.js` 里照 `qqSendMessage` 抄结构（`defineTool` + `output.schema` + `render` + 中文报错），再在 `registerQqTools` 里注册、在 `index.js` 的 `deps` 里补上它需要的能力；**别 import `index.js`** |
| 改分条/打字节奏 | `onebot.js` 的 `splitBurst` / `splitStickerLines` / `typingDelayMs`（**纯函数，优先在这里改**） |
| 改图片落盘/去重/淘汰 | `media.js` |
| 改出站图片校验或传输 | `image.js` |
| 改「存表情包」（写边界 / 名字清洗 / 张数上限 / 什么时候能存） | `util.js` 的 `stickerFileName`（纯函数写边界）+ index.js 的 `saveSticker` / `stickerSaveAllowed` + `tools.js` 的 `qq_save_sticker` + `Config.stickerMaxFiles` + `filestore.js` 的 `writeBytesAtomic` + `allowTools` |
| 改下载/PDF/上传 | `jm.js` + `scripts/jm_download.py` |
| 改群触发/白名单/复读 | index.js 的 `admit` / `maybeRepeat` 区块 |
| 改回复的指向（引用 / @） | index.js 的 `quoteHead` + `admit` 里快照的 `chatter.anchor()` + `Config.replyStyle`；这个读数**含机器人自己发的话**（`noteSelf`），别换成只算别人的 `others()`，也别把 `noteOwnMessage` 那四处删了（NapCat 的 `reportSelfMessage: false`，自己发的话等不到回灌） |
| 改「@ 人」的行为（标记语法 / 名单来源 / 认不出来怎么办） | `mention.js`（纯函数解析与名单查询）+ `Config` 里**没有**配置项 + index.js 的 `registerParticipant` / `conversationMentions` / `sendParts` 与 `admit` 里登记的 `sender.mentions` + `tools.js` 的 `qq_send_message` + 提示词里那两条 `[[@昵称]]` 硬要求；名字的显示口径（群名片优先）在 `onebot.js` 的 `userDisplayName`，**正文与名单必须来自同一个值** |
| 改「两张图算不算同一张」 | `perceptual.js`（指纹方案与阈值校准都写在文件头和 README「表情包那半边的账要算清」里）+ `Config.repeatImageTolerance` |
| 改主动说话的闸门 | `speaking-rules.js` 的 `proactiveEligible`（五道闸门 + 两个节奏闸）+ 它的用例；index.js 那边只是适配器 |
| 改主动说话的文案 / 流程 | index.js 的 `proactiveNudge` / `proactiveSweep` / `proactiveSpeak` + `Config` 的 `proactive*` + README「偶尔主动说话」（见 §4.F） |
| 改主动说话的时段语义 | `withinActiveHours`（**模块级纯函数**，导出给测试用）+ 它的边界用例 |
| 改「聊起来之后保持搭话」/ 抽卡 | `speaking-rules.js`（`activeFollowAllows` / `activeTurnsLeft` / `activeTalkChance` / `activeTalkAllows` / `chimeAllows` / `chimeDelay` / `batchScale`）+ index.js 的编排（`noteActiveMessage` / `groupTalkActive` / `scheduleChime` / `runChime` / `chimeNudge`）+ `chatter.js`（三本账）+ `admit` 里那两条免 @ 分支与抽卡 + `holdForBatch` + `settings` 的 `active*` + README「聊起来之后保持搭话」（见 §4.G） |
| 改「谁算在跟它聊」 | `speaking-rules.js`（`activeFollowAllows` 的七条）与 `chatter.js`。一对一：`others()` 与 `activeInterposeSeq` 比大小（`noteActiveMessage` / `activeFollowAllows` / `runChime`）—— 别改成时间戳，它判的是「有没有人插话」；多人搭话：`isHot()` 的时间窗口（`groupTalkActive`）—— 别改成序号，它判的是「最近够不够热」。**两条判据的语义差别写在模块注释里，还有 `test/chatter.test.mjs` 守着** |
| 改 `/reset` 的行为（轮次的算法 / 标记落盘 / 清哪些记账） | `sessionIdFor` + `resetConversation` + `resetMarkerDir` / `loadConversationResetCounts`（见 §4.H、§5.3、§5.4） |
| 改「谁能重置会话」 | `Config.resetUsers` + `canReset` + `handleEvent` 里的 `/reset` 分支（**空白名单 = 谁都不能**，别改成 `allowUsers` 那种语义）+ README「新开一轮会话」 |
| 改 QQ 会话能用哪些工具 | `cordis.patch.yml` 的 `preset-qq` + `Config.allowTools`（见 §7） |
| 改长期记忆的行为 | `Config` 的 `memory*` / `digest*` + `memory.js`（整个子系统）+ README「长期记忆」（见 §4.E） |
| 改摘要的触发时刻 | `digestAtHour` + `msUntilDailyHour`（模块级纯函数）+ `memory.js` 里 `runDigestSweep` 的日期判据 |
| 改 API key 轮换（池子格式 / 探测 / 什么时候换） | `Config` 的 `apiKeyRotate*` + index.js 的凭据轮换区块（`rotateApiKey` / `probeApiKey`）+ 模块级 `parseApiKeyPool` / `apiKeyFingerprint` + README「每天轮换 API key」（见 §4.I） |
| 改摘要/学梗的流程（提示词） | `.dsh/skills/` 里的 SKILL.md（改完**不用重启**，watcher 会重载） |
| 加一个 skill | 新建 `.dsh/skills/<kebab-name>/SKILL.md`（frontmatter 必填 `name` + `description`），并把 `skill` 留在 allowTools 里 |

**风格**：注释解释**为什么**而不是**是什么**（现有代码大量在解释取舍，比如「为什么是
base64 而不是把路径丢给 NapCat」「为什么引用消息要 5 秒就放弃」）。新代码请延续：
先写清楚为什么这样选，再写实现。别新增英文注释。

## 7. QQ 会话的工具从哪来（容易踩）

Web 表面把 agent 平面的工具搬进了 **Agent 预设**：QQ 会话只有 join 一个预设才继承得到
文件/检索/联网工具（`Config.agentPreset`，空 = 用部署默认，`none` = 不挂预设）。

`cordis.patch.yml` 里自带的 `preset-qq`（id `qq`）是**刻意最小**的：
`fs` 只读 + `fs-search` + `web` + `skill-filesystem`/`tool-skill`（发现 `.dsh/skills`）
+ 压缩，**没有 shell / 子代理 / workflow**。两个理由写在 patch 的注释里，其中一个是硬
bug 规避：`standard` 预设的 `modelSelectionSettings` 会让 subagent 工具在 Agent 自己的
作用域里再注册一份，而 `tools.restrict()` **按设计只收窄「继承来的」工具**，于是
subagent 会绕过 `allowTools` 出现在 QQ 会话里。改预设前先读那段注释。

**skill 归预设管**：`dsh-web-app` 把宿主的 `skill-filesystem` / `tool-skill` 停掉了
（「presets own local discovery」），所以预设里必须自己挂一份，QQ 会话才看得见
`.dsh/skills`。`allowTools` 里也要留着 `skill`，否则模型拿到目录却打不开。

`allowTools` 白名单在 `restrictAgentTools` 里生效，空数组 = 不限制。

## 8. 测试与验证

```bash
node --test test/                      # 全部（bridge + jm + perceptual + settings + chatter + util/filestore）
node --test test/settings.test.mjs     # 只跑配置取值口径（最快，0.2 秒）
node --test test/chatter.test.mjs      # 只跑「谁在说话」的三本账
node --test test/speaking-rules.test.mjs  # 只跑「什么时候该主动开口」的判据
node --test test/mention.test.mjs      # 只跑 `[[@昵称]]` → at 段的解析（最快，纯函数）
node --test test/jm.test.mjs           # 只跑下载链路
node --test --test-name-pattern 复读 test/   # 按名字过滤
```

测试用**真实插件模块 + 真实 OneBot 客户端 + 真实 `createUserMessage`**，只有 Harness
Host 是桩（含一个**假 timer 服务**：摘要循环不真等半小时，由用例
`host.list.timers.fireInterval()` 唤醒）；`jm.test.mjs` 把 python 换成一个假 shell 脚本
按 JSON Lines 协议回话。
README「跑测试」一节有一条很长的覆盖清单 —— **那就是行为规格**，改行为前先读它，
改完按它核对要不要补用例。

- 测试是唯一能自动验证的东西：**改完必须跑，且必须全绿**
  （当前基线：`test/` 下 266 个用例全过，约 33 秒；其中 `settings.test.mjs` / `chatter.test.mjs` /
  `mention.test.mjs` / `util.test.mjs` / `filestore.test.mjs` 是不用假 Host 的纯函数用例，
  几百毫秒就跑完）。
- 加行为就加用例，并在用例名/注释里用中文写清意图。
- 纯函数（`onebot.js` 里的拆分/延迟/采集/`mentionsOthers`、`image.js`、`media.js`、
  `perceptual.js`、`index.js` 里导出的 `withinActiveHours` / `parseApiKeyPool`）尽量单独测边界。
- **配置的取值口径**在 `test/settings.test.mjs`：默认值、非法值退到哪、以及几处**刻意的不对称**
  （`allowUsers` / `allowGroups` 逐字比较不 trim；`proactiveFromHour` 不夹紧、交给 `withinActiveHours`；
  攒批的 0 = 关闭，而毫秒项非法时退回默认）。**改 `settings.js` 必跑它** —— 这些分支在真宿主上
  几乎触发不到，只有它守着。
- **「谁在说话」的三本账**（插话序号 / 回答指向 / 热度窗口）在 `test/chatter.test.mjs`：那里
  钉的是**不变量**而不是实现 —— 「我自己说一句不该推进别人的账」（合并两本账就会红）、
  「一个人刷屏不算热」、「窗口一过就退出」、「纯查询不改状态」、
  「门槛配得比缓冲上限还大时缓冲要跟着留够」。**改 `chatter.js` 或活跃对话的判定必跑它。**
- **主动开口的判据**在 `test/speaking-rules.test.mjs`：主动说话的五道闸门 + 两个节奏闸、
  免 @ 接话的七条、补一句的九条，以及搭话抽卡的曲线（起始 + 每步累加、封顶、NaN 不接）。
  写法是「一份能通过的基准入参 + 只翻一个字段」，所以**删掉任何一条 `return false`，
  对应那个用例就会红**。**改 `speaking-rules.js` 或 `admit` 里凑入参的那几行必跑它。**
- **「@ 人」这一层**分两块：解析与名单的纯函数用例在 `test/mention.test.mjs`（标记边界、
  畸形标记不能吃掉后面的正文、认不出来就整个丢掉、`@全体成员` 只在群里解析得出来、名单按会话隔离）；
  端到端在 `test/bridge.test.mjs`（`[[@昵称]]` 真的变成 `at` 段、只写标记时只发一个 at 段、
  引用指向与标记同时存在时的顺序、`qq_send_message` 用同一套解析，以及**提示词里不再出现 QQ 号**）。
  **改 `mention.js` / `registerParticipant` / `sendParts` 里那几行必跑它们。**
- 图片指纹的用例在 `test/perceptual.test.mjs`（fixture 是 `test/image-fixtures.mjs` 里的真
  编码字节）。**改 `perceptual.js` 或复读的图片判定必跑它**：那里钉住了「同一张画面的十种
  编码指纹逐位一致」「同一套画风换掉文字必须判成两张」（真实世界最容易误判的一类）以及
  「畸形/超大输入只返回 undefined」。
- 存表情包的用例在 `test/bridge.test.mjs`（搜 `qq_save_sticker`：存的是原字节、存完提示词里
  就列得出来、非图片 / 越界 / 名字洗空 / 同名 / 超限一律拒绝、目录停用或白名单没放开时**工具
  不注册**）与 `test/util.test.mjs` 的 `stickerFileName`。**改 `stickerFileName` / `saveSticker` /
  `stickerMaxFiles` 必跑它们。**
- 长期记忆这套东西的用例在 `test/bridge.test.mjs` 末尾（转录落盘、两个工具、
  每日摘要调度与「一天至多一次」、错过摘要点的补课、索引注入、`memoryDir` 越界停用、
  摘要超时自愈）。**改记忆相关行为必跑它们。**
- 主动说话的用例在 `test/bridge.test.mjs` 末尾（一堆 `bootProactive` +
  `timers.fireInterval()`）；它们靠把 `digestMinLines` 抬到 9999 来隔离摘要循环 ——
  假 timer 的 `fireInterval()` 会唤醒**所有**周期定时器。**改主动说话必跑它们。**
- 活跃对话的用例在 `test/bridge.test.mjs` **最末尾**（`bootActive()` 把 `activeTalkChance` 钉成 1）。
  **搭话抽卡**另有五条（搜「搭话抽卡」）：概率 0 时不接、连丢一条才接、抽中与被 @ 到都归零、
  对话凉了累计不跨对话。**改抽卡、`admit` 的触发判定或 `batchScale` 必跑它们。**
- `/reset` 的用例（「攒批先投出去」「换成新一轮的 id 而旧会话留在磁盘上」「重开进程后
  仍停在同一轮」「轮到代次相关的记账都清干净」「只有 resetUsers 里的人能用，别人连会话
  都开不出来」）在 `test/bridge.test.mjs` 里散着几处，搜 `reset` 就能找到。
  **改 `sessionIdFor` / `resetConversation` / `canReset` 必跑它们。**
- API key 轮换的用例在 `test/bridge.test.mjs` **最后**（`bootKeyRotation` + 假凭据服务
  `fakeCredentials` + 假探测端点 `startProbeServer`）：跳过探测失败的候选、全失败就保留原值、
  环境变量提供的凭据提前退场、没有凭据服务只记 warn、池子越界停用、默认开 / 显式关、
  以及「日志里不出现完整 key」。**改 `rotateApiKey` / `probeApiKey` / `parseApiKeyPool` 必跑它们。**
- **插件进程本身不归测试管**，改完记得重启（§5.1）再看真实效果。

## 9. 改完的检查清单

- [ ] `node --test test/` 全绿
- [ ] 新增/修改的注释是中文，且解释了「为什么」
- [ ] `Config` 字段（若新增）在 README 配置表里同步
- [ ] 行为变了 → README 对应小节 + `Config.description` 同步
- [ ] 没有引入任何 `dependencies`，没有删 `node_modules` 软链
- [ ] 改的是运行时代码 → 提醒用户重启 `qqbot` profile（systemd 或 tmux）
- [ ] 动过 `sessionIdFor` / 会话代次 → 确认「第 0 轮的 id 逐位没变」，且代次仍然落盘
- [ ] 动过权限判断（`resetUsers` 之类）→ 确认「不配 = 全关」，而不是「不配 = 人人可用」
- [ ] 涉及安全面（审批策略、白名单、`cwd` 越界校验）的改动单独复核过

## 10. 常见坑速查

| 症状 | 真因 |
|---|---|
| 改了代码没生效 | Loader 按 URL 缓存模块 → 必须重启进程（§5.1） |
| **bot 完全不回复**，但 `systemctl --user is-active qqbot` 显示 active | `inject` 漏声明了代码里用到的服务：`ctx.interval` / `ctx.timeout` 属于 `timer`，cordis 不允许访问未声明的服务，`apply()` 当场抛错 → 插件整体不激活（journal 里是 `cannot get property "timer" without inject` + `dsh: warning: 1 entry did not activate`）。代码里用到的每个服务都要进 `inject` |
| 测试全绿但真宿主上插件不激活 | 假 Host 桩比真宿主宽松（例如无条件提供 `ctx.interval`）；改桩时要连 cordis 的 inject 检查一起复现（见 `test/bridge.test.mjs` 的 `requireTimerService`） |
| `failed to import @deepseek-ai/*` | `node_modules` 软链被删了 |
| journal 里没有任何插件日志 | 用了 `ctx.logger` 而不是 `report()`（§5.8） |
| 群里回复乱序 / 串话 | 绕过了 `enqueueSend` / `enqueue` 串行队列 |
| NapCat 报 `识别URL失败` | 给 `upload_*_file` 传了本地路径；必须走一次性 URL |
| 表情包/图片功能静默失效 | `mediaDir`/`stickerDir`/`jmDir` 被配到 `cwd` 外，代码只记 warn 并停用 |
| bot 回「存好了」但 `.qq-stickers/` 里没有那张图 | 工具没注册：旧进程没重启（§5.1）/ 目录停用 / `imageSend: false` / `allowTools` 里没有它。它会退回往 `COGNITION.md` 记一个会过期的 `.qq-media/<哈希>` 路径 |
| subagent 出现在 QQ 会话里 | 预设用了 `standard`，`tools.restrict()` 收不到作用域内注册的工具（§7） |
| agent 会话突然没能力了 | `agentPreset` 没 join 到预设，或 `allowTools` 挡掉了 |
| `/jm` 回「没启用」 | `.venv` 里缺 `jmcomic` / `img2pdf`，或路径不是 `jmPython` 指的那个 |
| **群里不 @ 它就不说话 / 人设没了 / QQ 会话冒出 subagent** | profile 的 `~/.dsh/profiles/qqbot/cordis.patch.yml` 里给 `qq-bridge` 写了 `config`：patch 是整块替换，仓库 patch 的整套配置被顶掉（§5.10）。删掉那一行，配置改回仓库 patch |
| `/reset` 突然没人能用 | `resetUsers` 由 `<启动 cwd>/.env` 的 `QQBOT_RESET_USERS` 决定（§11）；`.env` 只在启动时读，改了要重启 |

## 11. 运行环境（本机）

```
profile   ~/.dsh/profiles/qqbot/      bundles: dsh-base + dsh-web-app + @qqbot/dsh-plugin-qq
安装方式  @qqbot/dsh-plugin-qq -> link:<本仓库的绝对路径>
UI        http://127.0.0.1:3081/
启动      systemctl --user restart qqbot   或   dsh --profile qqbot --port 3081 --no-open
日志      journalctl --user -u qqbot -f
OneBot    容器 napcat（mlikiowa/napcat-docker），端口 3001 = WebSocket **服务器**
凭据      DEEPSEEK_API_KEY：推荐在 3081 的 Web UI Models 页填一次（写入
          $DSH_HOME/.credentials.yaml，任何启动方式都生效）
私有配置  profile 的 cordis.patch.yml **只放 locale / ui-settings 这类覆盖**；
          插件的配置一律改仓库的 cordis.patch.yml（见 §5.10）。
          本机私有的 /reset 白名单在仓库根的 .env（gitignore，**别把真号提交进仓库**）：
            QQBOT_RESET_USERS=<你的QQ号>      → cordis.patch.yml 的 resetUsers 从这里读
          .env 只在启动时读一次：改完必须重启才生效。
```

调试实时行为可以直接开 3081 的 Web UI 看 QQ 会话（每个 QQ 会话就是一个 Session）。
