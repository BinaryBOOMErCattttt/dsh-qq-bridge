# @qqbot/dsh-plugin-qq — QQ ↔ DSH 桥接插件

> 个人自用项目，顺手传到 GitHub 方便朋友下载。文档里的配置与取舍都是照着
> 我这一台机器的用法写的，没有做成通用插件，也不保证开箱即用 ——
> 想拿去玩的话，照着文档慢慢改就行。

把 QQ（通过 OneBot v11，如 NapCat / Lagrange / go-cqhttp）接到 DeepSeek Harness：

- **入站**：QQ 私聊或群里 @机器人 的消息 → 交给一个专属的 DSH Agent 会话处理 → 结果自动发回 QQ。
- **出站**：任何 DSH Agent（包括 Web UI 里的主会话）都能调用 `qq_send_*` 主动发消息 / 图片。
- **像群友一样说话**：几条消息攒成一轮、回复拆成短气泡、按打字节奏发出、引用 / @ 指向该指的人。
- **它自己的小动作**：群里刷同一个字时跟着**复读**；安静下来后偶尔**主动**冒个泡；
  聊起来之后免 @ 接话、回完再补一句；别人撤回消息时会清掉引用（默认假装没看到）。
- **图片与表情包**：能 `read_image` 真的看图；能发表情包；能把你发的表情**存进**自己的收藏目录。
- **定时提醒**：让它在明早 8 点提醒谁、每周一 @ 谁开会 —— 到点由插件直接发，重启不丢。
- **长期记忆**：每句话落盘，每天由独立摘要会话整理成「这个群记得什么」；聊天时按**当前消息检索**相关条目（含全局人物表与梗），不再只读文件开头，文件满了会滚进 `archive/` 而不是删掉。

## 它能做什么

| 能力 | 一句话 | 细节 |
|---|---|---|
| 双向聊天 | 一个 QQ 会话 = 一个持久 Session，重启后 `resume`，聊天记忆不丢 | [会话与轮次](docs/sessions.md) |
| 人格与表达 | 「是谁」写 `PERSONA.md`，「怎么说」写 `STYLE.md`，都热读 | [人格与表达](docs/persona-style.md) |
| 群友式说话 | 攒批、气泡条数（模型自己写）、分条与打字延迟、引用 / @、`[[@昵称]]` | [说话方式与节奏](docs/speaking.md) |
| 自动复读 | 群里刷同一个字 / 同一张表情时，插件不经过模型跟着发 | [自动复读](docs/repeat.md) |
| 主动开口 | 冷场冒泡、免 @ 接话、回完补一句（私聊永远不主动打扰） | [主动开口](docs/proactive.md) |
| 图片与表情包 | 看图、发表情、存表情；链接 / 视频 / 语音 / 戳一戳各有下场 | [图片与感知](docs/media.md) |
| 被撤回的消息 | 清引用是安全层；要不要调侃是配置 | [被撤回的消息](docs/recall.md) |
| 定时提醒 | 到点发固定文案 / 让模型换语气 / 到点做事，可 @ 人 | [定时提醒](docs/reminders.md) |
| 长期记忆 | 转录 → 每日摘要 → `MEMORY.md` / `archive/` / `PEOPLE.md` / `COGNITION.md` / `STICKERS.md` → 检索式注入 | [长期记忆](docs/memory.md) |
| 工具与能力面 | 自带最小 `qq` 预设 + `allowTools` 白名单 | [工具与能力面](docs/tools.md) |
| 运维 | `doctor` / `status` / `logs` / `restart`，三套部署共用 | [运维](docs/ops.md) |

## 30 秒开始

1. 装好 DSH，在 Web UI 的 **Models** 页填一次模型凭据。
2. 拿代码：到 [Releases](../../releases) 下载发布包，或者 `git clone` 本仓库。
   Windows 上解压后双击 `scripts\napcat-setup.cmd`，它会把 NapCat 与插件一起配好。
3. 让 NapCat 开一个 **WebSocket 服务器**（不是 websocketClients），端口与
   `endpoint` 一致（默认 `3001`），扫码登录。
4. 起常驻进程：`dsh --profile qqbot --port 3081 --no-open`（或 `deploy/qqbot.service`）。
5. 私聊机器人发一句话，它在 QQ 里回你就说明整条链路通了。

| 你的平台 | 照着哪一页装 |
|---|---|
| Windows（桌面版 DSH 与 NapCat 在同一台机器上） | [Windows 桌面版](docs/windows.md) |
| Linux / 容器（NapCat 跑在 docker 里） | [安装与运行](docs/install.md) |

改了什么、这个版本有什么，见 [CHANGELOG.md](CHANGELOG.md)。

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
  按打字节奏发出，并引用被回复的那条（见[说话方式与节奏](docs/speaking.md)）。
- 群消息默认只在被 @ 时触发；私聊 / 群里的「没有正文」消息、复读、主动搭话、
  表情包那几条旁路各有自己的闸门，默认值都偏保守（见[安全提醒](docs/security.md)）。

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
| `allowUsers` / `allowGroups` | `[]` | 私聊 / 群白名单；空 = 不限制 |
| `agentPreset` | `qq` | QQ 会话挂的 Agent 预设（自带的最小预设，没有 shell） |
| `allowTools` | 17 个工具 | QQ 会话的工具白名单；默认没有 write / edit / bash |
| `proactive` | `true` | 允许它在群里主动开口（私聊不会） |
| `activeFollow` | `true` | 群里聊起来之后免 @ 接话（刻意放松「只在被 @ 时说话」） |
| `memory` | `true` | 长期记忆：转录 + 每日摘要 + 认知库 + 人物表 + 检索式注入 + 两个记忆工具 |
| `recallMode` | `ignore` | 被撤回的消息：清引用永远做，调侃要显式开 `tease` |
| `reminder` | `true` | 定时提醒；默认只能提醒自己，@ 别人 / @全体默认关 |
| `apiKeyRotate` | `true` | 每天 04:00 从 `data/api-keys.txt` 轮换一把探测通过的 key |

## 安全（先看这三条）

- **QQ 消息是不可信输入**：默认 `approvalPolicy: never`、群消息只在被 @ 时触发。
  `activeFollow` / `proactive` / `privateAfterthought` 默认开，是**刻意**放松了「只在被叫到时说话」，
  每一条都有自己的闸门与上限；不放心就关掉。
- **`qq_save_sticker` 是唯一让 QQ 会话按自己给的字节直接写磁盘的工具**：只写表情包目录、
  文件名洗成单层、同名不覆盖、张数受上限约束。`qq_rename_sticker` 也能动那个目录，但它只能
  给已收藏的文件换个名字（不引入新字节、失败会回滚）。`qq_remind_create` 也会落盘，但写的是
  `reminderFile` 里由纯函数校验过字段的任务。除此之外 QQ 会话没有 write / edit / bash。
- **会写全局状态的两处**：`apiKeyRotate` 改 `$DSH_HOME/.credentials.yaml`；
  `linkPreview` 默认关（开了等于替群里任何人访问任意 URL）。**定时提醒**会把「未来要说的话」
  写进 `data/reminders.json` 并在到点发出，所以默认只能提醒自己、@ 别人默认关。
  细节与取舍见[安全提醒](docs/security.md)。

## 文档地图

| 文档 | 内容 |
|---|---|
| [安装与运行](docs/install.md) | Linux / 容器：下载、NapCat 要求、`qqbot` profile、systemd、凭据 |
| [Windows 桌面版](docs/windows.md) | 一键脚本、隐藏窗口、提权、装进 `desktop` profile、自检与排查 |
| [配置项](docs/configuration.md) | 全部字段、Web UI 设置页、改配置的正确姿势 |
| [人格与表达](docs/persona-style.md) | `PERSONA.md` / `STYLE.md` 的格式、组合规则、三道防线 |
| [说话方式与节奏](docs/speaking.md) | 攒批、气泡条数（模型自己写）、分条 / 打字延迟、指向、`[[@昵称]]`、空消息 |
| [自动复读](docs/repeat.md) | 文字与表情包复读、画面指纹、带宽账 |
| [主动开口](docs/proactive.md) | 偶尔主动说话、活跃对话、私聊补一句 |
| [图片、表情包与感知](docs/media.md) | 看图、发表情、存表情、base64、链接 / 视频 / 语音 / 戳一戳 |
| [被撤回的消息](docs/recall.md) | 三层处理、模式矩阵、配置与实现要点 |
| [定时提醒](docs/reminders.md) | 三种模式、时间规则、权限与额度、重启/断线/`/reset` |
| [长期记忆](docs/memory.md) | 转录、每日摘要、检索式注入、冷热分层、人物表、认知库、表情包目录、五个 skill |
| [会话与轮次](docs/sessions.md) | 确定性 Session id、`/reset`、旧会话存档 |
| [工具与能力面](docs/tools.md) | 工具表、`agentPreset`、`allowTools` |
| [运维](docs/ops.md) | `scripts/ops.mjs`、`doctor` 的 finding、八个排查场景、key 轮换 |
| [本机开发与测试](docs/development.md) | 依赖、重启规则、`node --test`、行为覆盖清单 |
| [安全提醒](docs/security.md) | 所有扩大能力面 / 主动发消息的开关与默认值 |
| [AGENTS.md](AGENTS.md) | 给要改这个项目的 agent 的代码说明书（不面向用户） |

## 开发

```bash
node --test test/                    # 全部用例
node --test test/settings.test.mjs   # 只跑配置取值口径
```

**改完源码必须重启 Harness**（Loader 按 URL 缓存模块，停用 / 启用插件拿不回新代码）。
本机依赖怎么铺、测试覆盖了什么、Windows / 沙箱里的跑法，见
[本机开发与测试](docs/development.md)；代码结构、模块依赖与「改哪里」的索引见
[AGENTS.md](AGENTS.md)。

## 许可

[MIT](LICENSE)。
