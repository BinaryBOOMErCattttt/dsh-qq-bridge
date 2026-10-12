# AGENTS.md — 给智能体的项目说明书

给要**改这个项目**的智能体看的最小充分上下文。用户视角的功能说明在
[README.md](README.md)（902 行，中文，写得很好）—— 本文只讲「代码长什么样、动哪里、
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
- **出站**：任何 DSH Agent（含 Web UI 主会话）都能调 `qq_send_*` 工具主动发消息/图片。
- **不走模型的两条旁路**：群里的**自动复读**，和 `/jm` **禁漫下载**。
- **长期记忆**：每条消息落盘成转录，定时由一个**独立摘要会话**照 `.dsh/skills/` 里的
  `message-digest` skill 整理成「这个群记得什么」，聊天时用 `qq_transcript` / `qq_memory`
  查；顺带用 `update-cognition` skill 学会群里的梗和表情包（见 §4.E）。

技术约束（决定了代码的写法，别无意打破）：

| 约束 | 原因 |
|---|---|
| **零运行时依赖** | 只用 Node 全局 `WebSocket` / `fetch` / `node:*`。`package.json` 没有 `dependencies`，OneBot 客户端是手写的（`onebot.js` 590 行）。 |
| 纯 ESM，Node ≥ 22（本机 v26.11.1），无构建步骤 | `"type": "module"`，改完即用。 |
| 没有 TypeScript，JSDoc 注释代替 | 全部类型信息在注释里。 |
| 注释、日志、面向用户的文案**一律中文** | 与 README 一致，别在中途切成英文。 |

## 2. 文件地图

```
index.js      3600+ 行  插件本体：配置 schema、全部运行时状态、事件路由、6 个工具、长期记忆、连接生命周期
onebot.js      594 行  OneBot v11 客户端 + 纯函数（分条/复读/延迟/媒体采集/文本化）
media.js       327 行  入站媒体：QQ 的图/表情包 → 按内容哈希落盘 → 给模型 read_image 的本地路径
image.js       135 行  出站图片：本地路径 / URL → 校验（大小、格式、目录越界）→ base64:// 段
jm.js          490 行  禁漫下载服务：spawn python、一次性 URL、给 NapCat 的小 HTTP 文件服务
scripts/jm_download.py  禁漫下载的 python 实现（jmcomic + img2pdf），唯一非 JS 的逻辑
.dsh/skills/message-digest/SKILL.md    聊天记录 → 长期记忆的流程（定时摘要与「以前说过什么」用它）
.dsh/skills/update-cognition/SKILL.md  学梗 / 表情包含义 → COGNITION.md 的流程
test/bridge.test.mjs  140 KB  集成测试：假 OneBot 服务端 + 假 Harness ctx（含假 timer），跑完整往返
test/jm.test.mjs      下载链路的单元/协议测试（假 python shell 脚本）
cordis.patch.yml      插件自带 bundle patch：注册 `qq` Agent 预设（含 skill 平面）+ 插件 config
locale/{zh,en}.json   插件在 Web UI 里的标题/描述
deploy/qqbot.{service,env.example}  systemd user unit 与凭据模板
README.md             用户文档 + 设计取舍（改行为要同步它）
AGENTS.md             **本文件**：给改代码的智能体的说明书（DSH 会自动注入上下文）
```

**数据目录**（全部 gitignore，运行时生成在 `cwd` 下）：`data/`（会话缓存）、`.qq-media/`
（入站图片 LRU 缓存）、`.qq-stickers/`（**用户自己丢表情包进来**）、`.qq-jm/`（下载的 PDF）、
`.qq-memory/`（长期记忆：转录 + 摘要 + 认知 + 摘要进度）。**`memoryDir` 与其它三个一样
必须在 `cwd` 内**，否则记忆功能记一条 warn 并停用。

### 依赖方向（保持单向，别造环）

```
index.js ──▶ onebot.js / media.js / image.js / jm.js
                      └── media.js 用到 onebot.js 的占位符/嗅探约定
test/*  ──▶ 直接 import 上述模块（不经过 Harness）
```

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
| `Config` schema | 第 106–177 行 | **配置的唯一真相来源**，`.description()` 就是 Web UI 上给用户看的文档 |
| 运行时状态 | 第 302–340 行 | `conversations`(key→会话) / `sessionIndex`(sessionId→key) / `turnOwners` / `submitted` / `transcripts` / `ambient` / `chatterSeq` / `repeatStates` / `mediaResolutions`，以及记忆的 `memorySlugs` / `memoryDirty` / `memoryLastDigest` / `memoryWrites` / `memoryIndexCache` |
| Agent 装配 | `ensureAgent` `resolveAgentPreset` `mountAgentPreset` `restrictAgentTools` `channelPrompt` | 见 §7 |
| 发送链路 | `enqueueSend` `sendToConversation` `replyPieces` `sendParts` `quoteHead` | 串行队列保证同一会话的消息不乱序 |
| JM 旁路 | `readJmCommand` `runJmCommand` `sendJmFile` `downloadJm` | `/jm 422866` 不进 Agent、不建会话 |
| 会话管理 | `resetConversation` `deleteStoredSession` `conversationFor` | `/reset`，以及在线会话列表 |
| 准入与复读 | `admit` `noteChatter` `rememberAmbient` `maybeRepeat` `repeatStep` | 白名单、群触发判定、环境上下文、复读状态机 |
| 媒体 | `resolveMessageMedia` `mediaFor` `resolveQuote` `hydrateAmbientMedia` | 环境上下文与复读**共用同一次下载**（`mediaResolutions` 这个 WeakMap 就是干这个的） |
| 攒批 | `enqueue` `holdForBatch` `flushBatch` `submitBatch` `renderBatch` | 前后脚到的消息合成一条再投给 Agent |
| 事件轮转 | `handleEvent`（约 55 行）+ 持久化事件路由 | 见 §4.A |
| 长期记忆 | `rememberTranscript` `appendTranscript`（+`writesFor`）`maybeCatchUpDigest` `readDigestState` `ensureDigestAgent` `runDigestSweep` `enqueueDigest` `memoryIndexText` `resolveMemoryConversation` | 见 §4.E |
| 工具注册 | `qq_send_message` / `qq_send_image` / `qq_list_conversations` / `qq_jm_pdf` / `qq_transcript` / `qq_memory` | 全局宿主平面。**这是文件里最大的一块**（6 个 `defineTool` 声明），不是函数 |
| 生命周期 | `ctx.effect(...)` | 托管 socket、JM 的 HTTP 服务、摘要定时器 |

**体量实况**（别被文件行数吓到）：调用链上的函数基本都在 60 行以内，纯逻辑已经拆到
`onebot.js` / `media.js` / `image.js` / `jm.js`。注释密度 25%–45%。文件大是因为
「一个大闭包 + 6 个大工具声明 + 大段取舍注释」，不是因为函数失控。

**模块级纯函数**（在 `apply()` 外面，只有记忆这一块有）：`memorySlug` / `localDate` /
`localStamp` / `msUntilDailyHour`（下一个整点还有多久）/ `memoryRelativePath`（写边界）/
`readJsonl` / `writeJsonTextAtomic`。它们不碰闭包状态，改它们不影响运行时不变量 ——
`msUntilDailyHour` 尤其值得单独测边界（刚过点要排到明天，不能原地反复醒）。

## 4. 五条数据流（改任何一条先读对应的那条）

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
                                                    error 回一句固定道歉
                                              ▼
                       sendToConversation(..., { human:true, quote }) → sendParts()
```

⚠️ `rememberTranscript` 必须在 `handleEvent` 的三个提前 `return`（环境上下文、`/jm`、
`/reset`）**之前**调用，否则那些消息不会进转录。它同时也要**在 `admit` 之前**判定自己的
准入规则（渠道开关 / 白名单），因为 `admit === undefined` 的闲聊同样要记 —— 长期记忆的
原料正是那些没人 @ 机器人的话。它**不建会话记录**（`conversations` 是「处理过哪些会话」
的表，闲聊不该把某个群变成「处理过」），只按 key 往记忆目录追加。

### B. 出站：Agent 主动发

六个工具直接调 `client.call('send_private_msg' | 'send_group_msg', …)`（`qq_transcript` /
`qq_memory` 不发消息，只读写记忆目录）。注意区别：
**工具**（显式动作）只按协议上限 `chunkText` 分段，**不加**打字延迟；拟人节奏只加在
A 链路的自动回复上。

### C. 自动复读（不经过模型、不建会话）

`maybeRepeat` → `repeatStateFor(groupId)` → 私有串行队列 `repeatStep` →
`repeatCandidate`（文字 / 图片按内容哈希 / 系统表情 id 三种 kind）→ `sendRepeat`。
配置项是 `repeat*` 一族，行为细节 README「自动复读」一节写得很全，改之前务必读。

### D. 禁漫下载

QQ 里 `/jm 422866`（`readJmCommand` 旁路）或 Agent 调 `qq_jm_pdf` → `downloadJm` →
spawn `.venv/bin/python scripts/jm_download.py`（JSON Lines 协议，先 `meta` 后 `result`）
→ 合并成一个 PDF → **不能把本地路径给 NapCat**（容器里读不到，实测回 `识别URL失败`）
→ `jm.js` 在本机开一个小 HTTP 服务 + 一次性 token，让 NapCat 自己来拉
（`jmFileHost` 默认 docker 网桥 `172.17.0.1`）。

### E. 长期记忆（转录 → 定时摘要 → 认知）

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
3. **Session id 是确定性的，不许改算法。** `sessionIdFor(key)` = SHA-256 裁成 UUID 形状
   （固定版本位/变体位过格式校验），key 形如 `group:100000001` / `private:<QQ号>`。
   改了它 = 所有人的聊天记忆全部丢失。
4. **`cwd` 既是 Agent 工作目录也是沙箱根。** `mediaDir` / `stickerDir` / `jmDir` /
   `memoryDir` 必须在 `cwd` 内，配到外面代码会**记 warn 并自动停用**该功能
   （`insideDirectory` 校验），这是有意设计，别改成抛错。
5. **QQ 消息是不可信输入。** 默认 `approvalPolicy: 'never'`（需要审批的操作直接拒绝）、
   群消息默认只在被 @ 时触发。任何扩大 QQ 侧能力的改动都要重新想一遍这一点。
6. **`Config` schema 是配置的唯一真相。** 加配置项 = 在 schema 里加字段（带**中文**
   `.description()`），index.js 里读数，README 表格里同步一行。已有 60+ 字段，
   §3 的表格只是导览，别照抄。
7. **日志要同时写 logger 和 stderr。** 这个部署没把 cordis logger 接到 stdout，
   `ctx.logger.warn()` 在 journal 里一个字都看不到。用 `report(level, msg)`，
   它靠 `logger.exporter` 是否存在来避免污染测试输出。
8. **同一会话的消息必须串行**（`enqueueSend` / `enqueue`）。QQ 消息到达顺序和异步
   IO 完成顺序不一致，绕过队列会串话/乱序。

## 6. 怎么改：任务 → 动哪里

| 想做的事 | 动哪里 |
|---|---|
| 加一个配置项 | `Config` schema + index.js 读取 + README 配置表 + （新行为）测试 |
| 改提示词 / 人设 | `DEFAULT_PERSONA`、`channelPrompt`、`Config.persona` / `.instructions` |
| 加一个 Agent 工具 | `ctx.tools.register(defineTool({...}))`，照 `qq_send_message` 抄结构（`output.schema` + `render` + 中文报错） |
| 改分条/打字节奏 | `onebot.js` 的 `splitBurst` / `splitStickerLines` / `typingDelayMs`（**纯函数，优先在这里改**） |
| 改图片落盘/去重/淘汰 | `media.js` |
| 改出站图片校验或传输 | `image.js` |
| 改下载/PDF/上传 | `jm.js` + `scripts/jm_download.py` |
| 改群触发/白名单/复读 | index.js 的 `admit` / `maybeRepeat` 区块 |
| 改 QQ 会话能用哪些工具 | `cordis.patch.yml` 的 `preset-qq` + `Config.allowTools`（见 §7） |
| 改长期记忆的行为 | `Config` 的 `memory*` / `digest*` + index.js 的记忆区块 + README「长期记忆」 |
| 改摘要的触发时刻 | `digestAtHour` + `msUntilDailyHour`（模块级纯函数）+ `runDigestSweep` 的日期判据 |
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
node --test test/                      # 全部（bridge.test.mjs + jm.test.mjs）
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
  （当前基线：`test/` 下 107 个用例全过，约 17 秒）。
- 加行为就加用例，并在用例名/注释里用中文写清意图。
- 纯函数（`onebot.js` 里的拆分/延迟/采集、`image.js`、`media.js`）尽量单独测边界。
- 长期记忆这套东西的用例在 `test/bridge.test.mjs` 末尾（转录落盘、两个工具、
  每日摘要调度与「一天至多一次」、错过摘要点的补课、索引注入、`memoryDir` 越界停用、
  摘要超时自愈）。**改记忆相关行为必跑它们。**
- **插件进程本身不归测试管**，改完记得重启（§5.1）再看真实效果。

## 9. 改完的检查清单

- [ ] `node --test test/` 全绿
- [ ] 新增/修改的注释是中文，且解释了「为什么」
- [ ] `Config` 字段（若新增）在 README 配置表里同步
- [ ] 行为变了 → README 对应小节 + `Config.description` 同步
- [ ] 没有引入任何 `dependencies`，没有删 `node_modules` 软链
- [ ] 改的是运行时代码 → 提醒用户重启 `qqbot` profile（systemd 或 tmux）
- [ ] 涉及安全面（审批策略、白名单、`cwd` 越界校验）的改动单独复核过

## 10. 常见坑速查

| 症状 | 真因 |
|---|---|
| 改了代码没生效 | Loader 按 URL 缓存模块 → 必须重启进程（§5.1） |
| `failed to import @deepseek-ai/*` | `node_modules` 软链被删了 |
| journal 里没有任何插件日志 | 用了 `ctx.logger` 而不是 `report()`（§5.7） |
| 群里回复乱序 / 串话 | 绕过了 `enqueueSend` / `enqueue` 串行队列 |
| NapCat 报 `识别URL失败` | 给 `upload_*_file` 传了本地路径；必须走一次性 URL |
| 表情包/图片功能静默失效 | `mediaDir`/`stickerDir`/`jmDir` 被配到 `cwd` 外，代码只记 warn 并停用 |
| subagent 出现在 QQ 会话里 | 预设用了 `standard`，`tools.restrict()` 收不到作用域内注册的工具（§7） |
| agent 会话突然没能力了 | `agentPreset` 没 join 到预设，或 `allowTools` 挡掉了 |
| `/jm` 回「没启用」 | `.venv` 里缺 `jmcomic` / `img2pdf`，或路径不是 `jmPython` 指的那个 |

## 11. 运行环境（本机）

```
profile   ~/.dsh/profiles/qqbot/      bundles: dsh-base + dsh-web-app + @qqbot/dsh-plugin-qq
安装方式  @qqbot/dsh-plugin-qq -> link:~/Projects/qqbot
UI        http://127.0.0.1:3081/
启动      systemctl --user restart qqbot   或   dsh --profile qqbot --port 3081 --no-open
日志      journalctl --user -u qqbot -f
OneBot    容器 napcat（mlikiowa/napcat-docker），端口 3001 = WebSocket **服务器**
凭据      DEEPSEEK_API_KEY：推荐在 3081 的 Web UI Models 页填一次（写入
          $DSH_HOME/.credentials.yaml，任何启动方式都生效）
```

调试实时行为可以直接开 3081 的 Web UI 看 QQ 会话（每个 QQ 会话就是一个 Session）。
