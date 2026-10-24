# 移植说明（服务器分支 → 上游基线）

这份代码是 **`flyinstar/dsh-qq-bridge` 的上游主线** + **一份从服务器运行版导出的功能分支** 的合并结果。
分支带来的新功能全部保留，上游后来修的安全与稳定性问题也一条没丢。

- 上游：<https://github.com/flyinstar/dsh-qq-bridge>（MIT）
- 本仓库：你的 fork（`main` 已同步上游，功能在 `feat/port-server` 上）
- 运行环境：DSH 插件 / Node ≥ 22 / 纯 ESM / 零运行时依赖

## 一、为什么不是「直接覆盖」

服务器那份是 **较老内核 + 一批新功能**；上游主线是 **同一内核的较新版本**。
直接把分支文件拷过来，会用旧代码顶掉上游在这期间的 26 处修复（安全、隐私、稳定性），
实测覆盖后 758 条用例里有 26 条真回归：

| 被顶掉的东西 | 后果 |
| --- | --- |
| `links.js` 的 `fetchBytes` 逐跳重定向校验 | **SSRF 加固回退**（内网地址 / 重定向绕过重新可用） |
| 记忆的跨会话隔离（`qq_transcript` / `qq_memory`） | 一个群能读到另一个群的记忆 |
| `util.js` 的 `SESSION_ROUTE_PATH` 等导出 | 13 个测试文件直接加载失败 |
| `media.js` 的 GIF 分镜 | 动图只剩一张首帧 |
| `scripts/ops.mjs` 的 `forget` | 运维命令表缺一条 |

所以走的是 **三方合并**，不是覆盖。

## 二、怎么合的

1. 在两个仓库的历史里找「分支最可能从哪个 commit 分出去」——对上游每个改过 `index.js` 的提交，
   算它与分支快照的差异行数，最小的是 `5eb17d4`（2026-10-18，差 1715 行）。把它当共同基线。
2. 对每个被分支改过的文件跑 `git merge-file`：**ours = 上游 main**，**base = 5eb17d4**，**theirs = 分支快照**。
3. 冲突按「以上游结构为准、把分支的新功能塞进去」解：
   - `index.js` 6 处（其中两处是上游把发送 / 攒批 / 提醒搬成模块后删掉的大段，取上游的删除）
   - `config.js` / `settings.js` / `client.js` / 文档若干（两侧都是新增，基本取并集）
4. 每步跑测试，红一条修一条。

## 三、新增了什么

| 模块 | 作用 |
| --- | --- |
| `commands.js` | `@bot + 空格 + 指令` 的登记表与解析（第一个空白前的词才算指令，「天气不错」不误判） |
| `mute.js` | 静默：唤醒词只认主人、状态只收群聊 key（私聊永不静默，它是控制通道） |
| `owner-settings.js` | 主人侧配置覆盖层：可写键白名单 + 按当前值推断类型 |
| `editor.js` | 受信写盘（`qq_write` / `qq_edit` / `qq_skill`）：路径边界、唯一匹配、写前备份 |
| `weather.js` / `balance.js` | 天气（Open-Meteo）/ 余额（DeepSeek `/user/balance`），`fetch` 注入可单测 |
| `music.js` | 点歌：网易云搜索，只回「歌名 - 歌手 + 链接」，不发卡片、不下载 |
| `tts.js` | 语音 **框架**：只有 `registerTtsProvider` / `synthesize`，仓库不接任何在线语音服务 |
| `fun.js` / `chat-state.js` | 运势 / 骰子 / 硬币 / 点名；`data/chat-state.json` 小账本 |

配套的工具与行为：`qq_quiet`（模型说「睡觉去」时由模型决定、插件执行）、`qq_settings`（改行为类配置）、
主人识别（`resetUsers`，为空时 `ownerAutoClaim` 认第一个私聊联系人）、指令的两级权限
（访客 / 主人）、`mediaHoldMs`（图 + 配文攒进同一轮）。完整指令表见 `docs/commands.md`。

## 四、上游这些修复被保住了

- `fetchBytes` 的逐跳校验与重定向上限（SSRF）
- 记忆的 scope 硬过滤与私聊不升级；`qq_transcript` / `qq_memory` 的越界拒绝
- GIF 分镜（`gif.js` / `storyboard.js` / `sticker-frames.js`）
- `scripts/ops.mjs forget`、设置页路由（`routes.js`）、私聊「正在输入」（`privateTyping`）
- 断线重连、`idleResetHours`、`activeFollowIdleMs`、合并转发（`forward*`）
- 上游把发送 / 攒批 / 提醒 / 路由 / 密钥轮换拆成模块的重构（分支里还是内联写法）

## 五、验证

```bash
node --test --experimental-test-isolation=none "test/*.test.mjs"
```

| 代码树 | 用例 | 通过 | 失败 |
| --- | --- | --- | --- |
| 纯净上游（基线，受限沙箱） | 760 | 757 | 3 |
| 覆盖方案（已废弃） | 758 | 729 | 29 |
| **本分支（三方合并，受限沙箱）** | 789 | 786 | 3 |
| **本分支（允许起子进程）** | **789** | **789** | **0** |

那 3 条只在受限沙箱里红，是 `persona-template.test.mjs` 里真起子进程跑 `scripts/persona-check.mjs` 的用例：
沙箱给 `spawnSync` 返回 `EPERM`，**纯净上游同样红**，不是代码问题。放开子进程后全绿。

`node scripts/check.mjs`：规则 2（`config.js` ↔ `docs/configuration.md` 字段同步）与规则 3 为绿；
规则 1（`AGENTS.md` 体积）与规则 4（逐文件 `node --check`）受环境限制（同样是 spawn 被拒），
其中规则 1 在**上游主线本来就是红的**（66195 字节 > 65536 预算），本分支合并后是 70040。

## 六、配置项

合并后共 170 个配置键：上游 155 个 + 分支新增 15 个，上游的 8 个键（`forward*` / `idleResetHours` /
`activeFollowIdleMs` / `privateTyping`）一个没删。新增的是：

`commands`、`guestCommands`、`tts`、`ttsMaxChars`、`wakeTriggers`、`wakeText`、`mutePersist`、`muteFile`、
`ownerAutoClaim`、`ownerFile`、`ownerSettingsFile`、`trustedWrite`、`skillWriteDir`、`writeMaxBytes`、`mediaHoldMs`。

设置页（Web UI → 设置 → QQ Bridge）已经给它们分好组：「指令」进准入页，「静默 / 主人与受信写盘」进会话页，
「语音（TTS）」进感知页，`mediaHoldMs` 进攒批组。

## 七、怎么跑

服务器（和上游一致）：

```bash
systemctl --user restart qqbot
journalctl --user -u qqbot -f
```

Windows / 本机开发：先把依赖铺进插件目录（`node_modules` 不是软链），再 `node --test`。
改完源码必须**重启** Harness —— Loader 在进程内按 URL 缓存模块，停用/启用插件拿不到新代码。

## 八、已知遗留

1. **`AGENTS.md` 超出注入预算**（70040 > 65536）。上游主线本来就超，合并后更超。
   要变绿得砍约 4.5KB，属于「要不要动上游正文」的决定，暂时保留。
2. **三条 `persona-check` 用例在受限沙箱里红**（`spawnSync` 被拒），普通终端或放开子进程后全绿。
3. **天气 / 余额没有配置项**（模块直接读环境与参数），所以设置页里没有对应分组。
4. **`FORK.md` / `HANDOFF.md`** 是导出手册，留着当历史背景；不需要可以直接删。
5. **TTS 只有框架**：`tts: true` 之前得先在 `tts.js` 里 `registerTtsProvider()`，否则「语音」只回「未配置」，不会联网。

## 九、以后怎么跟上游

本仓库 `main` = 上游；功能在这条 `feat/port-server` 上。上游更新时：

```bash
git fetch upstream
git checkout feat/port-server
git rebase upstream/main     # 冲突集中在 index.js 的指令分流与静默落点
```

指令 / 静默 / 受信写盘这三处是分支独有的入口，上游改动 `admit` 或 `handleEvent` 时最容易撞，
解冲突的原则是：**保留上游的新结构，把这三段旁路重新挂进去**，别反过来把结构退回去。