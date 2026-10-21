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
  `qq_save_sticker` 把别人发的存进 `.qq-stickers/`、`qq_rename_sticker` 给已收藏的改名（文件与目录一起搬，见 §6 表）。
- **不走模型的旁路**：群里的**自动复读**（见 §4.C）。
- **主动说话**（`proactive`，默认开；闸门很多，见 §4.E）：群里安静下来后，插件往**该群自己的会话**里伪造一条提醒，
  让它带着环境上下文与长期记忆自己冒个泡。
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
index.js  插件本体：运行时状态、事件路由、发送/准入/复读/存表情包/戳一戳/主动说话/活跃对话、连接生命周期
persona.js  `PERSONA.md` 的解析与渲染：身份 / 背景 / 性格（底色 + 点缀）/ 场景；坏文件回退上一版
style.js  表达层：聊天型 / 信息型判定、标点清洗、表达契约渲染；`STYLE.md` 的热读（**没有**掷骰 / 随机数）
prompt.js  系统提示的装配（人设 / 表达 / 能力 / 硬性规则；只放稳定内容）
speech-policy.js  「这条群消息该不该进 Agent、以什么身份进」：intent（addressed / continued / interject / none）+ C 路四条排除
cognition.js  认知库与表情包目录的**纯解析**：`COGNITION.md` / `STICKERS.md` 的条目、热梗段、目录行
docfile.js  cwd 内的热读文档（同步 + `size:mtime` 缓存 + 截断 + 越界拒绝），人设与表达共用
modalities.js  感知层：消息段 → `Observation` → 占位符（图片/表情/语音/视频/文件/卡片/转发）
links.js  卡片解析 + URL 预览（SSRF 防护、重定向逐跳校验、大小/超时/内容类型上限）
interactions.js  戳一戳的纯判据：该不该回、回戳还是走一轮、冷却 / 每日上限
recall.js  被撤回的消息的纯判据：认事件、要不要补一句（12 条闸门）、两段伪造提醒的文案
reminders.js  定时提醒：时间推算 / 校验 / 模式决策（纯函数）+ 任务文件、单定时器、重试与兜底
ops.js  运维的**纯计划**：平台识别、doctor findings、service/install 步骤、退出码
scripts/ops.mjs  运维执行器 + CLI（`doctor` / `status` / `restart` / `logs` / `install` / `napcat` / `migrate` / `cleanup` / `selftest`），`--json` + `--apply`
scripts/migrate-cognition.mjs  老 `COGNITION.md` 的路径条目一次性迁到 `STICKERS.md`（画面指纹认图、默认 dry-run、写前备份）
scripts/persona-check.mjs  人设自检 CLI：不启动机器人，直接跑 `parsePersonaDoc` / `renderPersona` / `parseStyleDoc` / `lintStyleDoc`，打印「模型会看到什么」+ findings；退出码 0/1/2，`--json` / `--strict`
chatter.js  群里「谁在说话」的三本账（插话序号 / 回答指向 / 热度窗口）：只暴露语义动作，不暴露 Map
send.js  发送链路：拆条 / 标点清洗 / 引用与 @ 指向 / 串行队列 / 私聊「正在输入」；依赖由 `index.js` 显式传入（第一批从闭包拆出的运行时模块）
sticker.js  表情包目录：列文件 / 裸名字补全 / 存图 / 改名 / 三个写边界；依赖由 `index.js` 显式传入（第二批）
batch.js  攒批：窗口 / 积压一波 / 提交 / 渲染；依赖由 `index.js` 显式传入（第四批）
reminder-runtime.js  定时提醒的发送 / Agent 轮 / 守卫；任务生命周期仍在 reminders.js（第三批）
routes.js  设置页路由：会话 / 重置、任务看板；只做 HTTP 形状（第五批）
key-rotation.js  每日轮换模型凭据：池子 / 探测 / 定时器（第五批）
mention.js  `[[@昵称]]` → OneBot `at` 段：纯函数解析 + 「昵称 → QQ 号」名单（名单挂在会话记录上）
speaking-rules.js  「什么时候该主动开口」的纯判据（闸门 / 抽卡 / 补一句 / 私聊补一句）：普通入参 → 布尔
backlog.js  长任务期间那波「迟到的消息」的**纯函数**：裁条数 / 裁字数 / 相对时间 / 整段正文（见 §4.A 与 `docs/speaking.md` 1.1）
util.js  **不碰运行时状态**的纯函数：sessionIdFor / 文本压缩 / 本地时间 / 写边界 / key 池解析与打码 / withinActiveHours 等（完整清单见本节末尾）
filestore.js  「原子写 / 尽力而为读」（读不到返回空而不是抛错），记忆、转录、表情包都走它；`writeTextAtomicUtf16` 专给 Windows 那两个产物
config.js  配置 schema（**唯一真相来源**）：纯数据，一百多条带中文 .description() 的字段；**根上是 `.volatile()`**（设置页的前提，见 §5.12）
settings.js  配置的运行时视图：取默认值 / 强制类型 / 夹紧 / 去空白全在这里，`index.js` 只读 settings.*
client.js  **浏览器半侧**（手写 bundle）：把 schema 投影成设置页自己的一页（`settings.section`），7 个 `TABS` / 15 个 `SECTIONS`；保存走 Host 的 settings 写路径（见 §5.12）
tools.js  宿主平面工具的**声明**（qq_send_* / qq_poke / qq_save_sticker / qq_rename_sticker / qq_list_conversations / qq_transcript / qq_memory / qq_remind_*），依赖由 index.js 显式传入
memory.js  长期记忆子系统：转录落盘、记忆文件读写（两个记忆工具的能力来源）、检索式注入的装配、人物迁移、滚档、每日摘要循环；依赖由 index.js 显式传入
memory-select.js  长期记忆的**纯函数**：markdown → record（人物 / 事实 / 惯例 / 在追 / 梗）、scope 过滤与打分、按节配额打包、archivePlan 滚档、MEMORY.md / PEOPLE.md 的 upsert / remove
onebot.js  OneBot v11 客户端 + 纯函数（分条/复读/延迟/媒体采集/@ 名单提取）；文本渲染委托 `modalities.js`
media.js  入站媒体：QQ 的图/表情包 → 按内容哈希落盘 → 给模型 read_image 的本地路径
image.js  出站图片：本地路径 / URL → 校验（大小、格式、目录越界）→ base64:// 段；收藏目录里的表情额外带 `sub_type: 1`（QQ 的「大表情」）
napcat.js  NapCat 那一侧：目录探测（强判据 = 有账号配置；弱判据 = 有它自带的启动件）、只读探测与**幂等**写 websocketServers（含备份）、快速登录 / 日志改文件 / WebUI 地址、`startPlan`（提权）、`hiddenStartPlan`（`wscript //B` + VBS 隐藏窗口）、`scheduledTask*Plan`；插件自检与一键脚本共用
desktop.js  装进桌面版 profile 的纯函数：`.env` 段落幂等替换、manifest 改写、`pluginLinkState`（链接指着谁）/ `removePluginLink`（junction 对 `unlink` 是 EPERM，退到 `rmdir`）
perceptual.js  图片指纹：JPEG(DC)/PNG/GIF → 16×16 灰度 → dHash（复读判同一张画面）
scripts/napcat-setup.mjs + .cmd  Windows 一键配置（网络配置 + 快速登录 + .env + 装进 desktop profile；`--start` / `--autostart` / `--window`），幂等 + 先备份
scripts/dev-node-modules.mjs      Windows 上铺 `node_modules`（按依赖闭包拷贝真实文件），只服务开发与测试
scripts/release.mjs               打发布包（`git archive` 源码树 + 干净的 NapCat → `dist/<名>.zip`），打完体检，命中账号配置/登录态就整体失败
docs/{install,windows,configuration}.md  安装与运行 / Windows 桌面版 / 配置项
docs/{persona-style,speaking,repeat,proactive,media,recall,memory,reminders}.md  行为分册（人格 / 说话 / 复读 / 主动开口 / 媒体 / 撤回 / 记忆 / 定时提醒）
docs/persona-workshop.md  写人设的入口：模板 / 18 题 / 组装规则 / 自检 / 常见坑 / 为什么提示词不进 `.dsh/skills`
docs/{sessions,tools,security,ops,development}.md  会话 / 工具与能力面 / 安全 / 运维排查 / 开发测试
.dsh/skills/message-digest/SKILL.md    聊天记录 → 长期记忆的流程（定时摘要与「以前说过什么」用它）
.dsh/skills/learn-meme/SKILL.md        文字梗 / 黑话 / 谐音 → COGNITION.md 的流程
.dsh/skills/learn-sticker/SKILL.md     表情包 → 先 qq_save_sticker 收藏、再写 STICKERS.md 的流程
.dsh/skills/update-cognition/SKILL.md  **兼容壳**：只做一句话分诊（旧名字还在用）
.dsh/skills/moegirl/SKILL.md           二次元梗 → 萌娘百科 MediaWiki 接口查意思的流程（只读，不落盘）
test/harness.mjs  集成测试夹具：假 OneBot 服务端 + 假 Harness ctx（含假 timer）+ boot / until；用例按主题在 bridge*.test.mjs
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
test/media.test.mjs  `fetchBytes` 的重定向与逐跳校验契约（SSRF 修复的单元层）
test/filestore.test.mjs 原子读写与「读不到就返回空/undefined，不抛错」这条失败语义
test/perceptual.test.mjs  图片指纹的单元测试（同图不同编码 / 异图 / 畸形输入 / 解压炸弹）
test/persona-template.test.mjs  人设模板 / 提示词 / 自检脚本的契约：零解析警告、STYLE 零体检、只一条底色、长度不超上限、文档不失链、退出码语义
test/image-fixtures.mjs  测试共用的图片 fixture（真编码的字节）
cordis.patch.yml      插件自带 bundle patch：注册 `qq` Agent 预设（含 skill 平面）+ 插件 config
locale/{zh,en}.json   插件在 Web UI 里的标题/描述
deploy/qqbot.{service,env.example}  systemd user unit 与凭据模板
deploy/persona/{PERSONA,STYLE}.template.md  复制就能用的两份模板（零解析警告 / 零体检命中，`test/persona-template.test.mjs` 钉着）
deploy/persona/PROMPT.md  人设编写提示词：先问「一次答完还是一题一题来」，再 18 道选择题，最后落盘 + 自检；**刻意不放进 `.dsh/skills/`**（那个目录对 QQ 会话也可见）
README.md             用户文档摘要 + 文档地图（细节在 docs/；改行为要同步对应分册；「30 秒开始」一节指路 Releases）
CHANGELOG.md          更新记录（发 Release 的说明从对应那一节里粘）
AGENTS.md             **本文件**：给改代码的智能体的说明书（DSH 会自动注入上下文）
```

**数据目录**（运行时生成在 `cwd` 下）：`data/`（会话缓存 + `/reset` 标记 + `api-keys.txt` 池子 +
`reminders.json` 提醒任务，gitignore）、`.qq-media/`（入站图 LRU，gitignore）、`.qq-stickers/`（表情包，gitignore）、
`.qq-memory/`（转录 + 摘要 + 认知 + `STICKERS.md` + `PEOPLE.md` + 冷层 `archive/`，gitignore）、
`.qq-persona/`（**人设与表达规则，是部署者的资产，故意提交进仓库**）。前四个**必须在 `cwd`
内**，否则各自记 warn 并停用；`.qq-persona/` 同样必须在 `cwd` 内，配到外面只记 warn 并回退
到配置 / 内置人设。

### 依赖方向（保持单向，别造环）

```
index.js ──▶ config.js（schema）/ settings.js ──▶ image.js（只借 DEFAULT_IMAGE_MAX_BYTES）
         ──▶ send.js ──▶ onebot.js / mention.js / image.js / style.js / util.js（发送链路；index.js 只装配 deps）
         ──▶ sticker.js ──▶ image.js / filestore.js / util.js（表情包目录；memory 从 deps 传入）
         ──▶ batch.js ──▶ speaking-rules / backlog / recall / speech-policy / onebot / links（攒批；会话侧动作走 deps）
         ──▶ reminder-runtime.js ──▶ onebot / util（提醒运行时；发送与攒批走 deps）
         ──▶ routes.js ──▶ reminders.js / util.js（设置页路由；会话动作走 deps）
         ──▶ key-rotation.js ──▶ util.js / filestore.js（凭据轮换；ctx / settings 走 deps）
         ──▶ tools.js ──▶ mention.js / onebot.js / image.js
         ──▶ chatter.js（三本账）/ mention.js（`[[@昵称]]` → at 段）/ speaking-rules.js（纯判据）
         ──▶ backlog.js（积压一波的裁剪与渲染，**纯函数**）
         ──▶ speech-policy.js ──▶ speaking-rules.js（intent 判定；C 路四条排除也在这里）
         ──▶ persona.js ──▶ docfile.js ──▶ util.js（pathInside）/ style.js ──▶ docfile.js；prompt.js ──▶ persona.js / style.js
         ──▶ modalities.js（消息段渲染）/ interactions.js（戳一戳）/ links.js（卡片与 URL 预览）
         ──▶ cognition.js（认知与表情包目录的纯解析；memory.js 也用它）
         ──▶ memory-select.js（记忆的记录模型 / 检索 / 滚档，**纯函数**；memory.js 用它）
         ──▶ docfile.js（人设 / 表达规则的热读）
         ──▶ memory.js ──▶ util.js / filestore.js / memory-select.js（长期记忆子系统）
         ──▶ reminders.js ──▶ util.js / filestore.js（定时提醒的任务/调度；发送与 Agent 轮留在 index.js）
         ──▶ util.js（纯函数，无 IO）/ filestore.js（原子读写）
         ──▶ onebot.js / media.js / image.js / perceptual.js
         ──▶ napcat.js（配置探测与幂等写入 + 快速登录 / 启动计划）
                      └── index.js 自检与 scripts/napcat-setup.mjs 共用
         ──▶ ops.js（运维纯计划）──▶ napcat.js / desktop.js；scripts/ops.mjs 执行它
         ──▶ desktop.js（.env 段落、manifest 改写）
                      └── scripts/napcat-setup.mjs 用它，test/desktop.test.mjs 钉它
                      └── media.js 用到 onebot.js 的占位符/嗅探约定（image.js 从 util.js 取 pathInside）
test/*  ──▶ 直接 import 上述模块（不经过 Harness）；harness.mjs 只 import index.js
```

**没有环**，这条要守住：`tools.js` / `settings.js` / `memory.js` / `reminders.js` / `napcat.js` / `desktop.js` /
`routes.js` / `key-rotation.js`
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
| 配置 schema | **不在这里**：在 `config.js`（入口只做 `export { Config } from './config.js'`） | 唯一真相来源，`.description()` 就是 Web UI 上给用户看的文档 |
| 配置的取值 | **不在这里**：`settings = createSettings(liveConfig(config), process.cwd())`之后一律读 `settings.*` | 取默认值/夹紧/去空白都在 `settings.js`；`index.js` 里**没有一处**直接读 `config.xxx`。`liveConfig` 必须调：schema 是根 volatile（§5.12），`apply()` 拿到的是引用 |
| 运行时状态 | `apply` 开头的一段 | `conversations`(key→会话) / `sessionIndex`(sessionId→key) / `turnOwners` / `submitted` / `transcripts` / `ambient` / **`chatter`**（三本账，见 `chatter.js`；搬出去前叫 `chatterSeq` / `groupChatter` / `quoteSeq`）/ `repeatStates` / `mediaResolutions`（记忆的账已搬去 `memory.js`）/ **`recent`**（「最近看见过什么」，见 §4.I；不落盘）；会话记录里还挂着 `sessionGeneration`（第几轮，`/reset` +1）/ `lastActiveAt` / `lastBotSpeakAt` / `activeInterposeSeq`（插话序号快照）与主动说话、活跃对话的记账（见 `blankConversation`） |
| Agent 装配 | `ensureAgent` `resolveAgentPreset` `mountAgentPreset` `restrictAgentTools` `stickerCatalogLines`；提示词装配**在 `prompt.js`** | 见 §7。`channelPrompt` 是**槽位化**的：场景 → 人设 → 表达契约 → 记忆查证出口 → 能力 → 额外要求 → **硬性规则（最后）**。`stickerCatalogLines` 是表情包目录**唯一**的渲染处（走「本轮情境」，别搬回系统提示） |
| 发送链路 | `enqueueSend` `sendToConversation` `replyPieces` `sendParts` `sendPieces` `sendOne` `quoteHead` `conversationMentions` `startTyping` `stopTyping` | **实现在 `send.js`**（`createSender(deps)`）；`index.js` 只装配并解构同名函数，调用点没变。`quoteHead` 也搬进了 `send.js`；`conversationMentions` 仍是本文件的函数声明，作为 deps 传进去。串行队列保证同一会话不乱序；`sendOne` 顺带记 `lastBotSpeakAt`；`replyPieces` 走「拆标记 → 拆条 → **标点清洗**」；**没有掷骰 / 随机数 / 条数上限**（模型写几行发几行）；`quoteHead` 只给第一个**文字**气泡挂指向（图永不挂；被回复的那条只有表情时也不引用；**搭话轮 `continued` / `interject` 整个不挂**，`replyStyle` 再显式也一样）；正文里的 `[[@昵称]]` 在 `sendPieces` 里换成 `at` 段。`sendParts` 只是「私聊正在输入」的开关壳（`human` 时亮/灭），真正的拆分与发送在 `sendPieces`；输入状态从 `agent/inbox/claimed` 亮到这一轮结束，每 4 秒续一次（`TYPING_REFRESH_MS`），协议端不支持 `set_input_status` 时只 warn 一次并停用（`privateTyping` 默认开，只私聊） |
| 会话管理 | `resetConversation` `conversationFor` `sessionIdFor` `resetMarkerDir` `loadConversationResetCounts` `writeConversationResetCount` `refreshSessionGeneration` `webSessionSnapshots` `resetConversationFromWeb` | `/reset` 开新一轮（**不删旧会话**，代次 +1 并落盘），以及在线会话列表（新一轮时连主动说话的节奏一起清） |
| 设置页路由 | `registerRoutes(ctx, { … })`；**实现在 `routes.js`** | 会话列表 / 重置与定时任务看板；必须用 `ctx.inject(['connection'], …)`，不能一次性 `ctx.get`（服务晚于 `apply()` 就绪） |
| 准入与复读 | `admit` `noteChatter` `touchActivity` `rememberAmbient` `registerParticipant` `maybeRepeat` `repeatStep` `sketchOf` `sameCandidate` | 白名单、群触发判定、环境上下文（**顺带登记「谁可以被 @」**）、复读状态机；`admit` 里的 A/C 准入与 C 路抽卡**收在 `speech-policy.js`**，这里只剩凑入参 + 记账 |
| 戳一戳 | `handlePoke` `pokeBack` `dailyCount` | 通知事件（`notice/notify/poke`）；判据在 `interactions.js`，冷却 / 每日上限在会话记录上；回戳只打给戳它的人 |
| 撤回 | `noteSeen` `findRecent` `handleRecall` `clearQuoteFor` `dropPending` `dropAmbient` `markReplied` | 通知事件（`notice/group_recall` / `friend_recall`）；判据在 `recall.js`；见 §4.I |
| 主动说话 | `proactiveSweep` `proactiveEligible`（适配器）`proactiveSpeak` `proactiveNudge` `busyWithTurn` `dailyCount` | 见 §4.E；**闸门在 `speaking-rules.js`**（`proactiveEligible` / `proactiveSkip`），这里只是把会话记录凑成入参的适配器；`withinActiveHours`（util.js）是纯函数 |
| 活跃对话 | `noteActiveMessage` `activeFollowAllows` / `activeTurnsLeft` / `activeTalkChance` / `activeTalkAllows` / `chimeAllows` / `chimeDelay` / `batchScale`（适配器）`groupTalkActive` `scheduleChime` `cancelChime` `runChime` `chimeSpeak` `chimeNudge` `dailyCount` | 见 §4.F；A（一对一免 @，不抽卡）与 C（多人搭话，抽卡用 `talkMisses`）在 `admit` 里判；`noteActiveMessage` 按三档 `mode` 分别处理（插话不买一对一）；倾听倍数在 `holdForBatch`，B（补一句）挂在 `turn/end` 之后 |
| 攒批 | `enqueue` `holdForBatch` `flushBatch` `flushIfIdle` `backlogBusy` `backlogShouldHold` `submitBatch` `renderBatch` `renderBacklog`；**实现在 `batch.js`**（`createBatcher(deps)`），`index.js` 只装配并解构同名函数；`batchWindow` / `batchCap` / `batchScale` 是 3 行适配器，算法在 `speaking-rules.js` / `backlog.js` | 前后脚到的消息合成一条再投给 Agent；多人搭话时窗口与上限同倍放大（见 §4.F）。**上一轮还没跑完时**（`backlogBusy`，含 `submitting`）到的消息标 `held`、只攒不投，等 `turn/end` 后由 `flushIfIdle` 合成**一波迟到的消息**（带相对时间 + SKIP 出口），不再排成几十轮；上限见 `batchBacklog*`（见 §4.A） |
| 媒体 | `resolveMessageMedia` `mediaFor` `resolveQuote` `hydrateAmbientMedia` | 环境上下文与复读**共用同一次下载**（`mediaResolutions` 这个 WeakMap 就是干这个的） |
| 事件轮转 | `handleEvent`（约 90 行）+ 持久化事件路由 | 见 §4.A / §4.I；`notice`（戳一戳 / 撤回）先于 `message` 分流（`handlePoke` / `handleRecall`）；`turn/end` 里按 `owner.proactive` / `owner.intent` 分流 |
| 定时提醒 | `reminders` `deliverReminderText` `deliverReminderModel` `runReminderTurn` `settleReminderTurn` `reminderNudge` `pendingReminderTurns` | 见 §4.J；任务生命周期在 `reminders.js`，**发送 / agent 轮 / 守卫在 `reminder-runtime.js`**（`createReminderRuntime(deps)`），`index.js` 只装配并解构同名函数；@ 由 `sendParts` 的 `at` 注入 |
| 长期记忆 | 只剩一行装配（`const memory = createMemory({ … })`）与几个调用点（`handleEvent` 的 `recallQuery` / `channelTurnContext` 的 `memory.recallText`（**不是**系统提示）/ 生命周期 / 各 nudge 的 `noteRecallFallback`） | 整个子系统在 `memory.js`，纯函数在 `memory-select.js`（见 §4.D）；依赖表就在那一行里。`recallLedger` 保证同一轮次里同一条记忆只进一次历史（每轮重发会在三十几轮后触发压缩 → 英文技术备忘录 → 人机） |
| 模型凭据轮换 | `createKeyRotation({ … })` / `keyRotation.start()`；**实现在 `key-rotation.js`** | 见 §4.H；每天到点挑下一个探测通过的 key 交给 `ctx.credentials.set()`（**不用重启**）。时段/超时/探测地址在 `settings` 上；`index.js` 只在装配处创建、在生命周期处 `start()` |
| 工具装配 | `registerQqTools(ctx, { … })` | 一张**依赖表**：把上面那些函数递给 `tools.js`（记忆是 `memory.tools`，存表情包是 `saveSticker`，戳一戳是 `poke`）。工具声明在 `tools.js`，不在这里 |
| 生命周期 | `ctx.effect(...)` + `ctx.on('loader/volatile-update', …)` | 托管 socket、主动说话的定时器；API key 轮换定时器由 `keyRotation.start()` 挂，摘要定时器由 `memory.startDigestTimer()` 挂。volatile-update 监听是**设置页保存之后唯一的生效路径**（延后一拍 `ctx.fiber.restart()`，见 §5.12） |

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
2. `index.js` 里**保留再导出**（`export { Config } from './config.js'`）—— `bridge*.test.mjs`
   经 harness 只 import `index.js`，Loader 也只认插件入口，搬走的东西必须在入口处仍然拿得到。

**模块级纯函数都不在本文件里**：`util.js` 放「同样输入永远同样输出」的那批（`sessionIdFor` /
`memorySlug` / `localDate` / `localStamp` / `msUntilDailyHour` / `hourLabel` /
`withinActiveHours` / `memoryRelativePath` / `stickerFileName` / `parseApiKeyPool` /
`apiKeyFingerprint` / `visibleText` / `errorText` / `memoryOneLine`），
`filestore.js` 放碰磁盘的（`writeJsonAtomic` / `writeTextAtomic` / `writeBytesAtomic` /
`readTextOrUndefined` / `readJsonl` / `readdirOrEmpty`）。

判断一个新函数该放哪：**碰闭包状态留 `index.js`，碰磁盘去 `filestore.js`，其余去 `util.js`。**
`util.js` 里不许引入闭包状态 —— 保持纯粹才可能被单测。
`sessionIdFor` / `parseApiKeyPool` / `withinActiveHours` 的契约由 `bridge*.test.mjs` 从
**插件入口**验，所以 `index.js` 里对这三个保留再导出（见上面的两条纪律）。
`msUntilDailyHour` 尤其值得单独测边界（刚过点要排到明天，不能原地反复醒）。

## 4. 十条数据流（改任何一条先读对应的那条）

> **完整正文在 [docs/agents/data-flows.md](docs/agents/data-flows.md)。** 这一节原来有
> 33 KB（ASCII 图 + 每条「不能踩的」），会把本文件顶过 DSH 的 65536 字节注入预算，
> 截断点落在 §5 中间。现在这里只留索引：动行为前按编号打开完整规格，小节编号
> （§4.A–§4.J）与代码注释、`docs/` 里的引用保持一致。

| 流 | 一句话 | 小节 |
|---|---|---|
| A 入站 → Agent → QQ | `handleEvent` → `admit` → 攒批 → `submitBatch` → `turn/end` → `sendParts`；`rememberTranscript` 必须在两个提前 return 之前 | §4.A |
| B 出站工具 | `qq_send_*` 直接 `client.call`；工具**不加**打字延迟，拟人节奏只在 A 链路 | §4.B |
| C 自动复读 | 文字 / 图片字节 + 画面指纹 / 表情 id；`sticker` 要在链上累加，别只看最后一条 | §4.C |
| D 长期记忆 | 转录 → 摘要 → 认知；scope 硬过滤 + 私聊不升级；结构化文件只走字段级写入 | §4.D |
| E 主动说话 | 五道闸 + 两个节奏闸，一次醒来最多一个群；掷中即消耗，`SKIP` 对所有轮次生效 | §4.E |
| F 活跃对话 | 一对一无 @ 接话 / 多人搭话抽卡 / 补一句；三本账别合并，只放大攒批 | §4.F |
| G 会话轮次 | `/reset` 不删旧会话，换 Session id 并落盘代次；销毁失败就不换 | §4.G |
| H 凭据轮换 | 走 `ctx.credentials`；探测通过才写，日志只用指纹 | §4.H |
| I 撤回 | `noteSeen` 账 + 清引用（安全层永远生效）；改写不另开一轮 | §4.I |
| J 定时提醒 | `turn/end` 的 reminder 分支必须最前；@ 由任务注入，不让模型写 | §4.J |

迁移、数据目录、依赖方向仍在 §2 与 §3；事务性细节在完整正文里。
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
   见 docs/media.md 的同名小节）；`qq_rename_sticker` 也只能给那个目录里**已有**的文件改名
   （不引入新字节、目标名占用就拒绝、目录写失败会回滚），是同一类窄通道而不是新能力；`qq_remind_create` 也会让插件写提醒任务文件，但写的是
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
    量纲与控件映射见 `client.js` 顶部注释），整页只有**页头右侧那一个保存按钮**（`SaveBar`，
    与标题同一行、sticky；不要退回官方 `SettingsForm` 的底栏 —— 一百多项配置根本滚不到那里，
    真实事故就是一整次改动没落盘）；页头底色用页面自己的 `bg-layer-2`（用 `bg-base` 会在
    内容区上留下一条深色带）；改设置页只动 `client.js`。
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
| 改提示词 / 人设 | `prompt.js`（`channelPrompt` 槽位、`DEFAULT_PERSONA`）、`Config.persona` / `.instructions`；**「是谁」写 `.qq-persona/PERSONA.md`、「怎么说」写 `STYLE.md`**（`persona.js` / `style.js`） |
| 改「怎么写人设」（模板 / 题库 / 自检） | `deploy/persona/{PERSONA,STYLE}.template.md`（必须能直接跑）+ `deploy/persona/PROMPT.md` 的 18 题题库 + `docs/persona-workshop.md` 的速查表 + `scripts/persona-check.mjs` + `test/persona-template.test.mjs`；**题库 / 速查表 / 模板 / 测试要一起改**，测试会红 |
| 改气泡数 / 标点 / 引用规则 | 气泡条数由模型按 `STYLE.md` 自己写，插件**不设上限**；标点与中断在 `style.js`（`sanitizeBubble` / `classifyReply` / `renderStyleContract`）+ `Config` 的 `burstSingleMaxChars` / `stripShortPeriod` / `replyStyle` + `send.js` 的 `burstParts` / `replyPieces` / `sendParts` / `quoteHead`（被回复的那条只有表情时不引用：`onebot.js` 的 `isEmojiOnlyMessage`；搭话轮 `continued` / `interject` 整个不挂） |
| 改私聊补一句 | `speaking-rules.js` 的 `privateAfterthoughtAllows` + index.js 的 `scheduleChime` / `runChime` / `chimeNudge` + `Config.privateAfterthought*` |
| 改群聊「谁该开口」 / 插话 | `speech-policy.js`（`decideGroupTurn` / `interjectExclusion` / `interjectLine`）+ `speaking-rules.js` + index.js 的 `admit` / `submitBatch` / `speakerLine` |
| 改认知 / 表情包目录 | `cognition.js`（纯解析与 `upsertStickerRow` / `renameStickerRow` / `removeStickerRow`）+ `memory.js` 的 `catalogState` / `appendSticker` / `renameStickerEntry` + index.js 的 `stickerCatalogLines`（目录**只**从这里进「本轮情境」）与 `stickerNames` + `tools.js` 的 `qq_save_sticker` / `qq_rename_sticker` + 三个 skill + `scripts/migrate-cognition.mjs` |
| 改消息段的渲染 / 新加一种段 | `modalities.js`（`observationOf` / `renderObservation`）；卡片解析在 `links.js` |
| 加运维动作 / 改 doctor | `ops.js`（纯计划）+ `scripts/ops.mjs`（执行器）+ `test/ops.test.mjs`；写 cwd 外的步骤必须带 `requires: human|root` |
| 加一个 Agent 工具 | 在 `tools.js` 里照 `qqSendMessage` 抄结构（`defineTool` + `output.schema` + `render` + 中文报错），再在 `registerQqTools` 里注册、在 `index.js` 的 `deps` 里补上它需要的能力；**别 import `index.js`** |
| 改分条/打字节奏 | `onebot.js` 的 `splitBurst` / `splitStickerLines` / `typingDelayMs`（**纯函数，优先在这里改**） |
| 改图片落盘/去重/淘汰 | `media.js` |
| 改出站图片校验或传输（含表情的 `sub_type` 大表情标记） | `image.js` 的 `imageSegment` + `sticker.js` 的 `isStickerFile`（收藏目录来源算表情）+ `onebot.js` 的 `isStickerSegment`（复读时单条消息算不算表情）+ `repeatStep` 的链上 OR（`sendRepeat` 收到的是补过 `sticker` 的链条目）+ `send.js` 的 `replyPieces` / `sendRepeat` 两处调用 |
| 改「存表情包」（写边界 / 名字清洗 / 张数上限 / 什么时候能存） | `util.js` 的 `stickerFileName`（纯函数写边界）+ `sticker.js` 的 `saveSticker` / `stickerSaveAllowed` + `tools.js` 的 `qq_save_sticker` + `Config.stickerMaxFiles` + `filestore.js` 的 `writeBytesAtomic` + `allowTools` |
| 改「给表情改名」 | `cognition.js` 的 `renameStickerRow`（纯函数：按旧名字搬整行、同区原地替换）+ `memory.js` 的 `renameStickerEntry` + `sticker.js` 的 `renameSticker` / `stickerRenameAllowed`（文件 `rename` + 目录写失败回滚）+ `tools.js` 的 `qq_rename_sticker` + `docs/media.md` 同名小节 |
| 改群触发/白名单/复读 | index.js 的 `admit` / `maybeRepeat` 区块 |
| 改回复的指向（引用 / @） | `send.js` 的 `quoteHead` + `admit` 里快照的 `chatter.anchor()` + `Config.replyStyle`；`intent` 从 `submitBatch` 的 `submitted` 一路带到 `sendParts`，**`continued` / `interject` 在 `quoteHead` 第一行就返回 undefined**（搭话不点名，别只改 `auto` 那一支）；进度读数**含机器人自己发的话**（`noteSelf`），别换成只算别人的 `others()`，也别把 `noteOwnMessage` 那几处删了（NapCat 的 `reportSelfMessage: false`，自己发的话等不到回灌） |
| 改「@ 人」的行为（标记语法 / 名单来源 / 认不出来怎么办） | `mention.js`（纯函数解析与名单查询）+ `Config` 里**没有**配置项 + index.js 的 `registerParticipant` / `conversationMentions` / `sendParts` 与 `admit` 里登记的 `sender.mentions` + `tools.js` 的 `qq_send_message` + 提示词里那两条 `[[@昵称]]` 硬要求；名字的显示口径（群名片优先）在 `onebot.js` 的 `userDisplayName`，**正文与名单必须来自同一个值** |
| 改「被撤回的消息」 | `recall.js`（4 个纯函数）+ index.js 的 `handleRecall` 一族与 `submitBatch` 里的 `action` 分支 + `Config.recall*` + `memory.noteRecall` + docs/recall.md（见 §4.I） |
| 改「定时提醒」 | `reminders.js`（时间推算 / 校验 / 模式决策 / 调度）+ `reminder-runtime.js` 的 `deliverReminderText` / `deliverReminderModel` / `runReminderTurn` / `settleReminderTurn` + `index.js` 的 `turn/end` reminder 分支 + `tools.js` 的三个工具 + `Config.reminder*` + docs/reminders.md（见 §4.J） |
| 改「两张图算不算同一张」 | `perceptual.js`（指纹方案与阈值校准都写在文件头和 docs/repeat.md「表情包那半边的账要算清」里）+ `Config.repeatImageTolerance` |
| 改主动说话的闸门 | `speaking-rules.js` 的 `proactiveEligible`（五道闸门 + 两个节奏闸）+ 它的用例；index.js 那边只是适配器 |
| 改主动说话的文案 / 流程 | index.js 的 `proactiveNudge` / `proactiveSweep` / `proactiveSpeak` + `Config` 的 `proactive*` + docs/proactive.md「偶尔主动说话」（见 §4.E） |
| 改主动说话的时段语义 | `withinActiveHours`（**模块级纯函数**，导出给测试用）+ 它的边界用例 |
| 改「聊起来之后保持搭话」/ 抽卡 | `speaking-rules.js`（`activeFollowAllows` / `activeTurnsLeft` / `activeTalkChance` / `activeTalkAllows` / `chimeAllows` / `chimeDelay` / `batchScale`）+ index.js 的编排（`noteActiveMessage` 的三档 `mode` / `groupTalkActive` / `scheduleChime` / `runChime` / `chimeNudge`）+ `speech-policy.js` 的 `decideGroupTurn`（A 不抽卡、C 抽卡）+ `chatter.js`（三本账）+ `admit` 里那两条免 @ 分支 + `holdForBatch` + `settings` 的 `active*` + docs/proactive.md「聊起来之后保持搭话」（见 §4.F） |
| 改「谁算在跟它聊」 | `speaking-rules.js`（`activeFollowAllows` 的七条）与 `chatter.js`。一对一：`others()` 与 `activeInterposeSeq` 比大小（`noteActiveMessage` / `activeFollowAllows` / `runChime`）—— 别改成时间戳，它判的是「有没有人插话」；多人搭话：`isHot()` 的时间窗口（`groupTalkActive`）—— 别改成序号，它判的是「最近够不够热」。**两条判据的语义差别写在模块注释里，还有 `test/chatter.test.mjs` 守着** |
| 改 `/reset` 的行为（轮次的算法 / 标记落盘 / 清哪些记账） | `sessionIdFor` + `resetConversation` + `resetMarkerDir` / `loadConversationResetCounts`（见 §4.G、§5.3、§5.4） |
| 改「谁能重置会话」 | `Config.resetUsers` + `canReset` + `handleEvent` 里的 `/reset` 分支（**空白名单 = 谁都不能**，别改成 `allowUsers` 那种语义）+ docs/sessions.md「新开一轮会话」 |
| 改 QQ 会话能用哪些工具 | `cordis.patch.yml` 的 `preset-qq` + `Config.allowTools`（见 §7） |
| 改长期记忆的行为 | `Config` 的 `memory*` / `digest*` + `memory.js`（落盘 / 摘要 / 装配）+ `memory-select.js`（记录模型 / 检索 / 滚档）+ docs/memory.md「长期记忆」（见 §4.D） |
| 改检索 / 打分 / 打包 | `memory-select.js`（`renderMemoryBlock` / `scoreRecords` / `queryTokens` / `vocabularyOf`）+ `memory.js` 的 `recallText` / `recallQueryFor` / **`recallLedger`（同一轮次只给一次）** + `batch.js` 的 `submitBatch`（写 `recallQuery`）与 `noteRecallFallback` + `test/memory-select.test.mjs` / `test/memory.test.mjs` |
| 改记忆文件的写入方式（逐条 / 归一化 / 护栏 / 历史） | `cognition.js` 的 `upsert*` / `remove*` / `normalize*` / `sectionForType` + `memory-select.js` 的 `upsertMemoryRow` / `upsertPersonRow` + `memory.js` 的 `writeMemoryFile` / `backupMemoryFile` + `tools.js` 的 `qq_memory` 参数 + `test/cognition.test.mjs` / `test/memory-select.test.mjs` 与 bridge 里搜索 `upsert` 的那组 |
| 改滚档（热层 → `archive/`） | `memory-select.js` 的 `archivePlan` / `archiveLineOf` + `memory.js` 的 `rolloverMemory` / `searchMemoryFile`（覆盖 archive）/ `listMemoryFiles` + `Config.memoryArchive*` / `digestRollover` + `test/memory-select.test.mjs` 的滚档组 |
| 改人物表 / scope 闸门 | `memory-select.js` 的 `parsePeopleDoc` / `upsertPersonRow` + `memory.js` 的 `assertGlobalWrite` / `writeScopeOf` / `migratePeopleDoc` + `tools.js` 的 `qq` / `aliases` 参数 + `test/memory-select.test.mjs` 与 bridge 的私聊写入用例 |
| 改「发表情只能从收藏目录发」 | `index.js` 的 `stickerSendSource` + `prompt.js` 的标记文案与 `stickerFailure` 回灌 + bridge 里「只认收藏目录」那组；`qq_send_image` 是显式动作，**没有**这条限制 |
| 改摘要的触发时刻 | `digestAtHour` + `msUntilDailyHour`（模块级纯函数）+ `memory.js` 里 `runDigestSweep` 的日期判据 |
| 改 API key 轮换（池子格式 / 探测 / 什么时候换） | `Config` 的 `apiKeyRotate*` + `key-rotation.js`（池子 / 探测 / 写回 / 定时器）+ 模块级 `parseApiKeyPool` / `apiKeyFingerprint` + docs/ops.md「每天轮换 API key」（见 §4.H） |
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

`allowTools` 白名单在 `restrictAgentTools` 里生效。**默认值不是空的**：18 个名字（只读文件 +
检索 + 联网 + 十一个 `qq_*`），所以 `qq` 预设里带的 `write` / `edit` 默认拿不到；显式写空数组才是
「不限制」。名字写错会被丢掉并记 warn（白名单只能收窄）。

**渠道提示小节必须可重试地挂**（`attachChannelPrompt` / `detachChannelPrompt`）：
`agentCtx.get('systemPrompt')` 是 **strict** 的 —— 服务所属 fiber 还没 active 就返回
`undefined`，而 Agent 的 resume 可能正好赶在那一小段。旧代码拿不到就静默 `return`，
于是那个 Agent 带着**裸系统提示词**跑到下次重启：人设、表达契约、硬性规则全丢
（真实事故：重启后群里的回复又变成「才没有 是你没跟上我」这种空格断句，
会话日志里系统提示从 16KB 掉到 5.7KB）。现在的约定是：拿不到只记一次 warn、
把 `conversation.channelPromptEffects` 留成 `undefined`，`ensureAgent` 的热路径
在**下一条消息**上补挂（含 `{{model}}` / `{{provider}}` 变量）；`/reset` 时清掉。
**别改回「拿不到就 return」**，也别在注册前不撤旧的那一份（同名注册会抛 duplicate）。

**预设也必须可重试地挂**（`attachAgentPreset`）：`ctx.get('agentPresets')` 同样是 strict 的，
而 `ensureAgent` 的 `setup` 只跑一次。旧代码服务不可见时静默跳过，那个 Agent 会一直用部署
默认预设跑到下次重启 —— **预设里的 `compaction` 一起漏掉**，压缩门槛从 `qq` 预设的
0.06×1M 变成默认的 0.8×1M，上下文一路涨到几百 k 才压（真实事故：群会话 712 轮时 220k，
每轮还在涨 9k，看起来就是「越聊越笨」）。现在的约定与提示小节一样：setup 失败只记一次
warn、`presetMounted` 留成 `false`，`ensureAgent` 热路径在下一条消息上补挂（服务没出现时
不退避；真的 mount 失败才退避 30s）。**别把「预设」只当成工具面** —— 压缩、工具、提示
都挂在它下面。

**渠道提示小节只能放稳定内容**（`channelPrompt`），每轮会变的东西走
`channelTurnContext` → user message 的第二个 text block（`userMessageFor`）：当前发言者、
群环境、检索到的记忆、当前时间、待发提醒、人设的场景段、上一轮没发出去的表情。
DeepSeek 路由声明 `systemPromptUpdate: 'in-history'`，DSH 为保住前缀缓存会把**变化后的整段
系统提示**作为新 system 消息追加（不是替换）；动态小节留在系统提示里 = 每轮多一份 8~9k
token 的人设/表达/硬性规则，十几轮就 220k，然后不间断压缩、失忆。**别把 `Date.now()`、
`speakerLine`、`ambientPrompt`、`memory.recallText`、群名 / 对方名字、表情包目录放回
`channelPrompt`**；要加新的动态信息，加到 `channelTurnContext` 里（群名是 `get_group_info`
查来的，重启后第一次查询可能失败 —— 一个查空的群名就够让整份人设再追加一份，见
`test/bridge-send.test.mjs`「the channel section does not depend on the group name lookup」；
表情包目录同理，它每存一张就变，见 `stickerCatalogLines` 与
「the sticker catalogue rides on the turn context」）。系统小节只在人设 / 表达 / 配置真的
改了时才变一次 —— 这是 `test/bridge.test.mjs`「the channel system section stays stable」钉住的。

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

- 测试是唯一能自动验证的东西：**改完必须跑，且必须全绿**（基线：`test/` 下全部用例全过、0 跳过；
  数量以 `node --test test/` 的输出为准，别写死）。0.2.0 删掉 JM 之后**不再有「跳过」**：原先 13 条探针需要真 spawn
  外部进程，沙箱里只能跳过，随 JM 一起删掉了。
- 已知偶发：**全量同进程连跑**时偶尔红一条、且每次红的那条都不同（见过 `proactive` 节奏、
  `allowTools`、群聊图片、`qq_transcript` 四组的用例），单独跑永远绿 —— 是 `until` 轮询与真实
  计时的竞态，重跑确认即可，**别为了「让它稳」去放宽断言**。
- 加行为就加用例，用例名/注释用中文写清意图。**改哪个模块就跑哪个文件**：
  `config.js`/`settings.js`→`settings.test.mjs`；`chatter.js` 与活跃对话判定→`chatter.test.mjs`；
  `speaking-rules.js` 或 `admit` 里凑入参那几行→`speaking-rules.test.mjs`；
  `mention.js`/`registerParticipant`/`sendParts`→`mention.test.mjs` + `bridge-send.test.mjs` 那组端到端；
  `perceptual.js` 或复读的图片判定→`perceptual.test.mjs`；`stickerFileName`/`saveSticker`→
  `util.test.mjs` + `bridge-stickers.test.mjs` 里搜 `qq_save_sticker` / `qq_rename_sticker`（改名还要看 `test/cognition.test.mjs` 的 `renameStickerRow`）；记忆相关→`bridge-memory.test.mjs`；
  主动说话→`bridge-proactive.test.mjs`（靠 `digestMinLines: 9999` 隔离摘要循环，
  假 `fireInterval()` 会唤醒**所有**周期定时器）；`sessionIdFor`/`resetConversation`/`canReset`
  →`bridge.test.mjs` 里搜 `reset`；`key-rotation.js`（轮换 / 探测 / 池子）→
  `bridge-ops.test.mjs`；`napcat.js`/`desktop.js`→`napcat.test.mjs` / `desktop.test.mjs`；
  `util.js`/`filestore.js`→各自的用例；`client.js`（设置页）→`client.test.mjs`（它同时钉住
  「每个配置项都有分组」这条）；`persona.js`/`style.js`/`speech-policy.js`/`modalities.js`/
  `links.js`/`interactions.js`/`recall.js`/`cognition.js`/`ops.js`→同名 `test/<模块>.test.mjs`；
  撤回的端到端（三种位置 × 三种模式）→`bridge-recall.test.mjs`；迁移脚本→
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
      `test/cognition.test.mjs` + `test/bridge-memory.test.mjs` 里搜索 `upsert` 的那组，并确认
      「整份重写丢行会被拒」「重复标题会被合并」两条仍然成立
- [ ] 加/改了配置项 → 跑 `test/client.test.mjs`（分组别漏、标签别退化成字段名）
- [ ] 动过引用链（`quote` / `clearQuoteFor` / `batchQuote`）→ 确认「清一处三处生效」，且
      `test/bridge-recall.test.mjs` 仍然绿（它们钉住「不许给已撤回的消息挂 reply 段」）

## 10. 常见坑速查

| 症状 | 真因 |
|---|---|
| 改了代码没生效 | Loader 按 URL 缓存模块 → 必须重启进程（§5.1） |
| **bot 完全不回复**，但 `systemctl --user is-active qqbot` 显示 active | `inject` 漏声明了代码里用到的服务：`ctx.interval` / `ctx.timeout` 属于 `timer`，cordis 不允许访问未声明的服务，`apply()` 当场抛错 → 插件整体不激活（journal 里是 `cannot get property "timer" without inject` + `dsh: warning: 1 entry did not activate`）。代码里用到的每个服务都要进 `inject` |
| 测试全绿但真宿主上插件不激活 | 假 Host 桩比真宿主宽松（例如无条件提供 `ctx.interval`）；改桩时要连 cordis 的 inject 检查一起复现（见 `test/harness.mjs` 的 `requireTimerService`） |
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
