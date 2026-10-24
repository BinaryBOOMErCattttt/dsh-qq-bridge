# @qqbot/dsh-plugin-qq — QQ ↔ DSH 桥接插件

> 个人自用项目，顺手传到 GitHub 方便朋友下载。文档里的配置与取舍都是照着
> 我这一台机器的用法写的，没有做成通用插件，也不保证开箱即用 ——
> 想拿去玩的话，照着文档慢慢改就行。

把 QQ（通过 OneBot v11，如 NapCat / Lagrange / go-cqhttp）接到 DeepSeek Harness：
入站消息交给一个专属的 DSH Agent 会话处理，结果自动发回 QQ；任何 DSH Agent 也能主动往外发。

---

## ⚠️ 免责声明

**在装之前请先读完这一段。用这个项目等于你接受下面全部内容。**

1. **这是个人玩的项目，不是产品。** 没有任何担保（包括可用性、稳定性、数据完整性）。
   作者不为任何直接或间接损失负责 —— 包括但不限于：账号被封、消息发错人、
   记忆写坏、定时提醒在该响的时候没响、服务器被你自己配崩。
2. **账号风险自负。** 它依赖 OneBot v11 实现（NapCat / Lagrange / go-cqhttp）驱动一个真实 QQ 号。
   **这类第三方协议端并不在腾讯的许可范围内**，用它登录、自动化收发消息，理论上都有被风控、
   限制甚至封号的可能。请用小号或你自己的号，并自行评估风险；不要拿公司号、主号去试。
3. **内容责任是你的。** 模型说的话由提示词、人设与群里的输入共同决定，插件不保证它「说得对」
   「说得体」。群里发出去的东西代表的是**你**，不是作者。别把它放进你无法承担后果的群里。
4. **隐私：它会往磁盘写聊天记录。** 长期记忆默认开：每句话落到 `.qq-memory/`（转录），
   每天由独立会话整理成记忆文件，包含发言人昵称与 QQ 号。这些目录都在你的 `cwd` 里、
   `.gitignore` 已挡住，但**请自己确认备份、权限与清理策略**；不要把它部署在共享机器上。
5. **第三方服务各有各的条款。** 天气走 Open-Meteo，余额走 DeepSeek 官方接口，点歌走网易云公开搜索，
   梗百科走萌娘百科，链接总结会去抓取你给的 URL。用它们之前请自行确认对应服务的条款与限额；
   **语音（TTS）只留框架，仓库不内置、也不代理任何在线语音服务** —— 要接就自己接，并遵守那个服务的条款。
6. **版权：点歌只回链接、不下载不转发音频；表情包来自群聊上下文，请勿用于二次分发。**
7. **别拿它干违法或骚扰的事。** 群发、刷屏、自动私聊陌生人、绕过平台限制这类用途与本项目无关，
   也不被支持；出了事自己担。
8. **上游与本分支的关系：** 内核来自 [flyinstar/dsh-qq-bridge](https://github.com/flyinstar/dsh-qq-bridge)（MIT），
   本仓库是在它之上并入了一份自用功能分支（见 [PORTING.md](PORTING.md)）。上游作者与本分支作者
   都**不为你的部署负责**。

---

## ⭐ 本分支新增（相对上游）

如果你是从上游过来的，这一段是差异全貌；完整合并说明见 [PORTING.md](PORTING.md)。

### 1. 指令系统：`@bot + 空格 + 指令`（私聊不用 @）

35 条指令，分「玩 / 查 / 聊 / 管」四类。**确定性的由插件直接回（零 token）**，创作类才交给模型：

| 类别 | 指令 |
| --- | --- |
| 玩 | `抽签` `吃饭` `饭量` `敲木鱼` `骰子` `抛硬币` `点歌` `随机点名` `接一个` `投票` |
| 查 | `帮助` `天气 <城市>` `群热度` `随机表情` `状态` `余额` `设置 [键] [值]` |
| 聊 | `表情 <描述>` `白饭` `小作文` `语音 <文字>` `看图` `总结链接` `梗` `日报` `记忆` `提醒` `存表情` |
| 管 | `关注` `取消关注` `关注列表` `纪念日` `定档` `别复读` `可以复读` |

- **两级权限**：访客能用公开的那批；`状态` / `余额` / `设置` / `日报` / `记忆` / `关注` / `定档` 只有主人能用。
- **判据是短句**：第一个空白前的词命中登记表才算指令，`天气不错` 不会被当成指令。
- 完整表与参数见 [指令](docs/commands.md)。

### 2. 主人与受信写盘

- 主人按 **QQ 号**认（`resetUsers`）；为空时 `ownerAutoClaim`（默认开）把**第一个私聊联系人**认成主人
  —— 群里说话不算，所以不会因为群里有人先说句话就被人认主。
- 主人专用工具：`qq_quiet`（静默）、`qq_settings`（从 QQ 里改行为类配置）、
  `qq_write` / `qq_edit` / `qq_skill`（工作目录内的 .md/.txt/.json/.yml 与 SKILL.md）。
- **权限不靠提示词**：这几把工具在 `execute()` 里按**这一轮发言人**复核，攒批里混进一个群友，
  这一轮就没有写盘能力；内建 `write` / `edit` 仍然不在白名单里。

### 3. 静默（qq_quiet）

主人说「睡觉去 / 静默 / 别聊了」时由模型决定、插件执行：该群的消息在准入之前就被丢掉，
不花 token 也不回 `SKIP`。**私聊永远不静默**（它是控制通道）；叫醒只剩 `wakeTriggers` 这条旁路
（默认：起床 / 醒醒 / 醒来 / 别睡了 / 重启），且只认主人。

### 4. 零 token 的小玩意

`天气`（Open-Meteo，WMO 码映射成中文）/ `余额`（DeepSeek `/user/balance`）/ `点歌`（只回链接）
/ `抽签` `骰子` `抛硬币` `随机点名` / `吃饭` `敲木鱼` `群热度` `投票` `纪念日`（落 `data/chat-state.json`，几百字节一改）。

### 5. 语音（TTS）只留框架

`tts.js` 只提供 `registerTtsProvider()` / `synthesize()`，**仓库不内置 Edge-TTS / Azure / 任何在线语音 API**。
默认 `tts: false`，未注册 provider 时 `语音` 只回「未配置」，不会联网。

### 6. 图文攒批

`mediaHoldMs`（默认 1500）把「图 + 配文」攒进同一轮再投给 Agent，避免图先到、文字后到各开一轮。

---

## 它能做什么

🆕 标记的是本分支新增的能力。

| 能力 | 一句话 | 细节 |
|---|---|---|
| 双向聊天 | 一个 QQ 会话 = 一个持久 Session，重启后 `resume`，聊天记忆不丢 | [会话与轮次](docs/sessions.md) |
| 🆕 指令 | `@bot + 空格 + 指令`，35 条；确定性动作零 token，两级权限 | [指令](docs/commands.md) |
| 🆕 静默 | 主人一句话让它闭嘴，只认私聊叫醒；私聊永不静默 | [指令](docs/commands.md) |
| 🆕 主人与受信写盘 | `qq_write` / `qq_edit` / `qq_skill` / `qq_settings` / `qq_quiet`，按这一轮发言人复核 | [工具与能力面](docs/tools.md) |
| 🆕 零 token 小玩意 | 天气 / 余额 / 点歌 / 抽签 / 骰子 / 硬币 / 点名 / 吃饭 / 木鱼 / 群热度 / 投票 / 纪念日 | [指令](docs/commands.md) |
| 🆕 语音框架 | `语音 <文字>`，需要自己注册 provider，默认关、不联网 | [配置项](docs/configuration.md) |
| 人格与表达 | 「是谁」写 `PERSONA.md`，「怎么说」写 `STYLE.md`，都热读 | [人格与表达](docs/persona-style.md) |
| 群友式说话 | 攒批、气泡条数（模型自己写）、分条与打字延迟、私聊「正在输入」、引用 / @、`[[@昵称]]` | [说话方式与节奏](docs/speaking.md) |
| 自动复读 | 群里刷同一个字 / 同一张表情时，插件不经过模型跟着发 | [自动复读](docs/repeat.md) |
| 主动开口 | 冷场冒泡、免 @ 接话、回完补一句（私聊永远不主动打扰） | [主动开口](docs/proactive.md) |
| 图片与表情包 | 看图（动图拆分镜图）、发表情、存表情；链接 / 视频 / 语音 / 戳一戳各有下场 | [图片与感知](docs/media.md) |
| 被撤回的消息 | 清引用是安全层；要不要调侃是配置 | [被撤回的消息](docs/recall.md) |
| 定时提醒 | 到点发固定文案 / 让模型换语气 / 到点做事，可 @ 人 | [定时提醒](docs/reminders.md) |
| 长期记忆 | 转录 → 每日摘要 → `MEMORY.md` / `archive/` / `PEOPLE.md` / `COGNITION.md` / `STICKERS.md` → 检索式注入 | [长期记忆](docs/memory.md) |
| 工具与能力面 | 自带最小 `qq` 预设 + `allowTools` 白名单（23 个工具） | [工具与能力面](docs/tools.md) |
| 运维 | `doctor` / `status` / `logs` / `restart` / `forget`，三套部署共用 | [运维](docs/ops.md) |

## 30 秒开始

1. 装好 DSH，在 Web UI 的 **Models** 页填一次模型凭据。
2. 拿代码：到 [Releases](../../releases) 下载发布包，或者 `git clone` 本仓库。
   Windows 上解压后双击 `scripts\napcat-setup.cmd`，它会把 NapCat 与插件一起配好。
3. 让 NapCat 开一个 **WebSocket 服务器**（不是 websocketClients），端口与
   `endpoint` 一致（默认 `3001`），扫码登录。
4. 起常驻进程：`dsh --profile qqbot --port 3081 --no-open`（或 `deploy/qqbot.service`）。
5. 私聊机器人发一句话，它在 QQ 里回你就说明整条链路通了。
6. 认主：`resetUsers` 留空时，**第一个私聊它的人**就是主人（`ownerAutoClaim`）；想指定就在配置里写 QQ 号。

想让它像某个具体的人：照[写人设：模板与问答](docs/persona-workshop.md)走 —— 复制两份模板改四处，
或者让 agent 用 18 道选择题问你一遍，再跑一个自检脚本看看「模型会看到什么」。

| 你的平台 | 照着哪一页装 |
|---|---|
| Windows（桌面版 DSH 与 NapCat 在同一台机器上） | [Windows 桌面版](docs/windows.md) |
| Linux / 容器（NapCat 跑在 docker 里） | [安装与运行](docs/install.md) |

改了什么、这个版本有什么，见 [CHANGELOG.md](CHANGELOG.md)；这次移植怎么合的见 [PORTING.md](PORTING.md)。

## 工作原理

```
QQ 客户端 ──▶ NapCat ──(OneBot v11 WebSocket)──▶ 本插件
                                                    │
                                    每个会话映射一个 DSH Session
                                                    │
                                    Agent 产出最终回复 ──▶ 发回 QQ
```

- 一个 QQ 会话（一个私聊对象 / 一个群）= 一个持久化 Session。Session id 由会话 key 经
  SHA-256 派生，是**确定性**的：Harness 重启后同一个人再发消息，插件会 `resume` 原有会话。
  `/reset` 不改这个算法，只是把「第几轮」也算进摘要（见[会话与轮次](docs/sessions.md)）。
- Agent 的回复取该 turn 里**最后一条有文本的 assistant 消息**；中间步骤的工具调用不会发给 QQ。
- 前后脚到的消息先攒一个窗口（`batchWindowMs`，默认 2 秒）再投给 Agent；回复会拆成几条短消息、
  按打字节奏发出，被叫到时按 `replyStyle` 引用 / @ 该指的人 —— **它自己凑上来的「搭话」不挂任何
  指向**（见[说话方式与节奏](docs/speaking.md)）。
- 群消息默认只在被 @ 时触发；私聊 / 群里的「没有正文」消息、复读、主动搭话、
  表情包那几条旁路各有自己的闸门，默认值都偏保守（见[安全提醒](docs/security.md)）。
- 指令与静默是**准入之前的旁路**：命中指令就不进模型，静默中的群消息直接丢弃。

## 配置

全部配置项在 `cordis.patch.yml` 的 `config:` 下（schema 在 `config.js`，字段上的中文
`.description()` 就是给用户看的说明），也可以在 Web UI 的 **设置 → QQ Bridge** 里改。
完整的字段表与设置页说明见 [配置项](docs/configuration.md)。

> ⚠️ **不要手写一个只有几个字段的 `config:` 去覆盖它。** DSH 的 patch 是**整块替换**、
> 不是深合并：只写一个 `resetUsers` 也会把 `agentPreset` / `allowTools` / `proactive` 一起顶掉，
> QQ 会话会挂上带 shell 的默认预设。改配置走仓库 patch 或 Web UI；每台部署不同的值走环境变量。

常改的几项：

| 字段 | 默认 | 说明 |
|---|---|---|
| `endpoint` | `ws://127.0.0.1:3001` | OneBot v11 正向 WebSocket 地址（`QQBOT_ENDPOINT`） |
| `accessToken` | `''` | OneBot access_token（`QQBOT_ACCESS_TOKEN`） |
| `cwd` | 进程当前目录 | QQ 会话 Agent 的工作目录，也是媒体 / 记忆 / 人设的落点 |
| `groupTrigger` | `mention` | 群消息触发：`mention` / `prefix` / `all` |
| 🆕 `commands` / `guestCommands` | `true` / `true` | 指令总开关 / 访客能否用公开指令 |
| 🆕 `resetUsers` / `ownerAutoClaim` | `[]` / `true` | 主人名单；为空时认第一个私聊联系人 |
| 🆕 `trustedWrite` / `writeMaxBytes` | `true` / `65536` | 受信写盘开关与单次上限 |
| 🆕 `tts` / `ttsMaxChars` | `false` / `200` | 语音框架（需自己注册 provider）/ 单次字数 |
| 🆕 `wakeTriggers` | 起床/醒醒/醒来/别睡了/重启 | 叫醒静默的旁路词（只认主人） |
| `allowUsers` / `allowGroups` | `[]` | 私聊 / 群白名单；空 = 不限制 |
| `agentPreset` | `qq` | QQ 会话挂的 Agent 预设（自带的最小预设，没有 shell） |
| `allowTools` | 23 个工具 | 工具白名单；默认没有 write / edit / bash（受信写盘走主人专用的三把） |
| `proactive` | `true` | 允许它在群里主动开口（私聊不会） |
| `activeFollow` | `true` | 群里免 @ 接话：@ 一次后接着聊，最多 10 条、间隔超 3 分钟算断聊 |
| `memory` | `true` | 长期记忆：转录 + 每日摘要 + 认知库 + 人物表 + 检索式注入 |
| `recallMode` | `ignore` | 被撤回的消息：清引用永远做，调侃要显式开 `tease` |
| `reminder` | `true` | 定时提醒；默认只能提醒自己，@ 别人 / @全体默认关 |
| `apiKeyRotate` | `true` | 每天 04:00 从 `data/api-keys.txt` 轮换一把探测通过的 key |

## 安全（先看这四条）

- **QQ 消息是不可信输入**：默认 `approvalPolicy: never`、群消息只在被 @ 时触发。
  `activeFollow` / `proactive` / `privateAfterthought` 默认开，是**刻意**放松了「只在被叫到时说话」，
  每一条都有自己的闸门与上限；不放心就关掉。
- **群友能触发的、唯一一条「按自己给的字节写盘」的通道是 `qq_save_sticker`**：只写表情包目录、
  文件名洗成单层、同名不覆盖、张数受上限约束。`qq_rename_sticker` 只能给已收藏的文件改名
  （不引入新字节、失败会回滚）。`qq_remind_create` 也会落盘，但写的是纯函数校验过字段的任务。
- **主人专用的受信写盘**（`qq_write` / `qq_edit` / `qq_skill`）：范围只有工作目录内的
  `.md` / `.txt` / `.json` / `.yml` 与 `<skill 根>/<名字>/SKILL.md`，写前备份到 `.dsh/.history/`，
  `.qq-memory/` 与 `data/` 拒绝；每次执行按**这一轮发言人**复核主人身份。
  内建 `write` / `edit` 仍然不在白名单里 —— 这不是「放开了写文件」。
- **会写全局状态的两处**：`apiKeyRotate` 改 `$DSH_HOME/.credentials.yaml`；
  `linkPreview` 默认关（开了等于替群里任何人访问任意 URL）。**定时提醒**会把「未来要说的话」
  写进 `data/reminders.json` 并在到点发出，所以默认只能提醒自己、@ 别人默认关。
  细节与取舍见[安全提醒](docs/security.md)。

## 文档地图

| 文档 | 内容 |
|---|---|
| [移植说明](PORTING.md) | 本分支相对上游改了什么、怎么合的、测试与遗留 |
| [安装与运行](docs/install.md) | Linux / 容器：下载、NapCat 要求、`qqbot` profile、systemd、凭据 |
| [Windows 桌面版](docs/windows.md) | 一键脚本、隐藏窗口、提权、装进 `desktop` profile、自检与排查 |
| [指令](docs/commands.md) | 玩 / 查 / 聊 / 管四类指令、访客与主人两级权限、静默的起床话 |
| [配置项](docs/configuration.md) | 全部字段、Web UI 设置页、改配置的正确姿势 |
| [工具与能力面](docs/tools.md) | 工具表、`agentPreset`、`allowTools`、主人与受信写盘 |
| [人格与表达](docs/persona-style.md) | `PERSONA.md` / `STYLE.md` 的格式、组合规则、三道防线 |
| [写人设：模板与问答](docs/persona-workshop.md) | 两份复制就能用的模板、一份会提问的提示词、一个自检脚本 |
| [说话方式与节奏](docs/speaking.md) | 攒批、气泡条数、分条 / 打字延迟、指向、`[[@昵称]]`、空消息 |
| [自动复读](docs/repeat.md) | 文字与表情包复读、画面指纹、带宽账 |
| [主动开口](docs/proactive.md) | 偶尔主动说话、活跃对话、私聊补一句 |
| [图片、表情包与感知](docs/media.md) | 看图、发表情、存表情、base64、链接 / 视频 / 语音 / 戳一戳 |
| [被撤回的消息](docs/recall.md) | 三层处理、模式矩阵、配置与实现要点 |
| [定时提醒](docs/reminders.md) | 三种模式、时间规则、权限与额度、重启/断线/`/reset` |
| [长期记忆](docs/memory.md) | 转录、每日摘要、检索式注入、冷热分层、人物表、认知库、五个 skill |
| [会话与轮次](docs/sessions.md) | 确定性 Session id、`/reset`、旧会话存档、Web UI 的「重置对话」按钮 |
| [运维](docs/ops.md) | `scripts/ops.mjs`、`doctor` 的 finding、八个排查场景、key 轮换 |
| [本机开发与测试](docs/development.md) | 依赖、重启规则、`node --test`、行为覆盖清单 |
| [安全提醒](docs/security.md) | 所有扩大能力面 / 主动发消息的开关与默认值 |
| [AGENTS.md](AGENTS.md) | 给要改这个项目的 agent 的代码说明书（不面向用户） |

## 开发

```bash
node --test test/                    # 全部用例
node --test test/settings.test.mjs   # 只跑配置取值口径
node --test --experimental-test-isolation=none "test/*.test.mjs"   # 沙箱里 spawn 被拒时用这个
```

**改完源码必须重启 Harness**（Loader 按 URL 缓存模块，停用 / 启用插件拿不回新代码）。
本机依赖怎么铺、测试覆盖了什么、Windows / 沙箱里的跑法，见
[本机开发与测试](docs/development.md)；代码结构、模块依赖与「改哪里」的索引见
[AGENTS.md](AGENTS.md)。

## 许可

[MIT](LICENSE)。上游版权与许可声明原样保留；本分支的改动同样以 MIT 发布。

**再次提醒：这是个自用玩具，出了事（封号、发错、丢数据）都是你自己担。** 玩得开心。