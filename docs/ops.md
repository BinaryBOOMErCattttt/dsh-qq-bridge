# 运维（`scripts/ops.mjs`）

> 一套命令覆盖 Linux systemd / Windows 桌面版 / 容器里的 NapCat。`doctor` 回答「哪儿坏了」，
> `--json` 让 agent 只看结构化事实。下面还有八个真实场景的排查顺序，以及模型凭据的每日轮换。
> 安装见 [install.md](install.md)，Windows 专有步骤见 [windows.md](windows.md)。

## 一键运维（`node scripts/ops.mjs`）

三套部署（Linux systemd / Windows 桌面版 / 容器里的 NapCat）共用一条命令。它是给**人和
agent** 一起用的：`--json` 时 stdout 只有一个对象，`schema: 1` 是协议版本号。

```bash
node scripts/ops.mjs doctor --json            # 我现在到底哪儿坏了？
node scripts/ops.mjs status --json            # 在跑吗？连上了吗？最后 20 行日志
node scripts/ops.mjs doctor --fix             # 只做 cwd 内的事（建 data/、写 .env.example）
node scripts/ops.mjs logs -n 200              # journalctl / 日志文件 / docker logs，按平台
node scripts/ops.mjs restart                  # systemd 重启；Windows 只重启能独立管理的部分
node scripts/ops.mjs install --apply          # 写 unit / 计划任务 / profile（默认只给计划）
node scripts/ops.mjs napcat config|start|autologin|webui
node scripts/ops.mjs selftest --json          # 不需要外部依赖的自检（node 版本、目录、依赖）
```

输出长这样（`doctor --json`）：

```json
{
  "schema": 1,
  "ok": false,
  "action": "doctor",
  "platform": { "os": "linux", "systemd": true, "container": true, "elevated": false },
  "findings": [
    { "level": "error", "code": "ONEBOT_UNREACHABLE",
      "message": "ws://127.0.0.1:3001 连不上",
      "fix": "确认 napcat 容器在跑、端口映射到 3001",
      "requires": "human" }
  ],
  "steps": [
    { "id": "fix-ONEBOT_UNREACHABLE", "status": "planned", "requires": "human",
      "command": "docker ps", "note": "先看 napcat 容器" }
  ]
}
```

**三条纪律**：

- **退出码是接口的一部分**：`0` 全部通过；`1` 有 error 级 findings；`2` 需要人工或提权；
  `3` 脚本自身出错。agent 只看 `findings[].level` 决定要不要找用户。
- **`--apply` 默认关**：写 `cwd` 外的步骤（systemd unit、计划任务、NapCat 配置、profile）
  一律带 `requires: human | root`，不带 `--apply` 只打印计划；带 `--apply` 也只执行
  `workspace` 那批，剩下的把命令原样打给你。**不假装能重启桌面版**：Windows 上那一项就是
  一句「请重启桌面版」和 `requires: human`，比静默失败诚实。
- **幂等**：重复执行不重复写；写前备份（沿用 `napcat.js` / `desktop.js` 的备份约定）。

`node scripts/napcat-setup.mjs` **保留为兼容入口**（肌肉记忆），内部走同一批计划函数。
下面八个场景是给 agent 的排查配方（连不上、不回复、人设没生效、摘要没跑、key 没轮换、
Windows 装了不加载、计划任务没起来、日志在哪）。

## 一条命令看全貌

```bash
node scripts/ops.mjs doctor --json
```

返回 `{ schema, ok, action, platform, findings, steps }`。`findings[].level` 是
`error | warn | info`，每条都有 `code`、`message`、`fix` 与 `requires`。常见 code：

| code | 意思 | 谁该动手 |
|---|---|---|
| `ONEBOT_UNREACHABLE` | `endpoint` 的端口连不上 | human（NapCat 没起 / 端口没映射） |
| `NAPCAT_CONFIG_MISSING` | NapCat 的 `config/onebot11_<QQ>.json` 里没有监听我们端口的 ws 服务器 | human（`napcat-setup.mjs` 或 WebUI） |
| `SYSTEMD_NOT_ACTIVE` / `SYSTEMD_UNIT_MISSING` | user unit 没跑 / 没装 | human |
| `PROFILE_LINK_MISSING` / `PROFILE_LINK_ELSEWHERE` | 桌面版 profile 里插件没装 / 链接指着旧仓库 | human |
| `ENV_MISSING` | 启动目录没有 `.env` | workspace（`doctor --fix` 会写一份 `.env.example`） |
| `CREDENTIAL_MISSING` | `$DSH_HOME/.credentials.yaml` 里没有模型 key | human（Web UI Models 页填） |
| `KEY_POOL_MISSING` / `KEY_POOL_TOO_SMALL` | `data/api-keys.txt` 不存在 / 只有 0~1 个 key | human（轮换本来就不做事，不是故障） |
| `STALE_TOOL_ALLOWLIST` | `allowTools` 里有代码里已不存在的工具名 | workspace（改配置） |
| `CWD_NOT_WRITABLE` | 工作目录不可写 | human |
| `DEPS_MISSING` | 裸跑测试需要的三个 peer 包不在 | human（`dev-node-modules.mjs`） |

`undefined` 的事实**不会**变成 finding：未知 ≠ 坏了。

## 八个场景

### 1. 它一句话都不说

1. `node scripts/ops.mjs doctor --json` → 有 `ONEBOT_UNREACHABLE` / `NAPCAT_CONFIG_MISSING`
   就先修那两个（插件这边一切正常时，NapCat 没开 ws 服务器的现象就是「它永远不说话」）。
2. `node scripts/ops.mjs logs -n 200`，找 `qq-bridge: connected`、`qq-bridge: ←`、`qq-bridge: →`。
   没有 `connected` 就是连接问题；有 `←` 没有 `→` 看下一节。
3. 群消息是不是没 @ 它？默认 `groupTrigger: mention`；`activeFollow` 默认开（窗口内接话另算）。
4. `doctor` 里若有 `STALE_TOOL_ALLOWLIST`，`allowTools` 里可能写着不存在的工具 ——
   模型会拿着一份「推荐了却调不到」的工具清单。

### 2. 连上了但不回复

- `qq-bridge: connected` 之后有没有 `qq-bridge: ← …`？没有 = 消息没被准入
  （白名单 / 群白名单 / 渠道开关 / 没 @）。
- 有 `←` 没有 `→`：看 `qq-bridge: → …`。判成 `SKIP` 的那一轮会打一行「判成 SKIP，不发送」。
- 报 `no model for QQ sessions`：`provider` / `model` 没配，而部署也没有默认选择
  （`doctor` 的 `CREDENTIAL_MISSING` 通常同时出现）。
- 报 `could not resolve agent preset`：`agentPreset` 配错了 —— QQ 会话会退化成只有宿主平面的
  `qq_*` 工具。

### 3. 人设没生效

启动日志里找这几行（每次 apply 都会打）：

```
qq-bridge: 人设来自 .qq-persona/PERSONA.md（N 条启用的性格）
qq-bridge: 表达规则来自 .qq-persona/STYLE.md；气泡：最多 3 个，第二个 55% 起 …
```

- 打的是「用内置那份」→ 文件不在 `cwd` 里、或路径被配到了 `cwd` 外（会有一条 warn）。
- 打的是「配置 persona」→ `PERSONA.md` 不存在。**两套人设不叠加**：文件在时配置被忽略。
- 只改了一部分没生效：`personaSceneOverlays: false` 会让四个场景共用一套；
  `### 私聊` 之类的 `###` 标题必须准确（只认 私聊 / 群聊 / 主动搭话 / 被戳一戳）。
- 文件被写成半截：日志里会有「没有可用的内容，继续用上一版/内置人设」—— 那是刻意回退。
- **整段丢**（人设、表达契约、硬性规则都没了，回复退化成空格断句 / 客服腔）：先 grep
  `the systemPrompt service is not available while binding`。那是 Agent 创建 / resume
  赶在服务 active 之前，渠道小节没挂上；从当前版本起下一条消息会自动补挂（成功时另有
  一条 `attached the QQ channel prompt … (retried …)` 的 info），不需要重启。若只见到
  那条 warn、始终没有补挂成功的 info，说明宿主本身没提供 `systemPrompt` 服务（组合问题），
  那几条规则确实进不去。

### 3.1 越聊越笨 / 上下文越滚越大（群会话）

症状：某个群最近开始答非所问、忘掉刚说过的话、越回越短；日志里没什么错，但会话变得又慢又贵，
压缩越来越频繁。翻会话记录（`~/.dsh/sessions/<cwd slug>/<session id>/session.v4.jsonl.zstd`，
`sessionIdFor('group:<群号>', 0)`）能看到**系统提示每轮都在变长**（每次 `system/message` 十几 KB），
或者 `request/context` 里 `contextWindow` 是 1M、而上下文已经几百 k 还没压缩。

三个成因：前两个 2026-10-19 修的，第三个是 2026-10-20 从会话日志里查出来的：

- **动态内容混进系统提示**：当前发言者 / 群环境 / 检索到的记忆 / 当前时间 / 待发提醒 / 人设场景段
  以前都在 `channelPrompt` 里。DeepSeek 路由声明了 `systemPromptUpdate: 'in-history'`，系统提示
  一变，DSH 会把**整段新提示**追加成一条新 system 消息（为保住前缀缓存），于是每轮多背 8~9k token。
  现在这些走 `channelTurnContext`，写在 user message 的第二个 text block 里；系统小节只在人设 /
  表达 / 表情目录 / 配置真的改了时才变。**别再往 `channelPrompt` 里加 `Date.now()` /
  `speakerLine` / `ambientPrompt` / `memory.recallText`。**
- **预设漏挂 → 压缩门槛退回默认**：`agentPresets` 与 `systemPrompt` 一样是 strict 的。重启后
  第一次 resume 撞上竞态时，旧代码会一直用部署默认预设（`compaction` 也一起漏掉，门槛从
  0.06×1M 变成 0.8×1M）。现在 `attachAgentPreset` 会在**下一条消息**上补挂；日志里分别有
  `the agent preset for … is not available yet`（warn）和
  `attached the agent preset … (retried after the service became available)`（info）。
- **压缩门槛压得太低 → 每 3 轮重写一遍摘要**（0.06 = 60k 门槛那版）：系统提示 + 工具 schema
  本身约 10k、每轮 +4k，60k 门槛意味着压缩几乎每回一次话就重写一遍摘要，而摘要是一条英文技术
  备忘录（`## Primary Request and Intent` / `## Key Technical Concepts`），旧摘要还会被并进
  新摘要。10-20 那个群 97 轮压了 27 次，模型对聊天的「记忆」只剩备忘 + 最近 3~4 轮原话 ——
  群里看到的就是「越聊越人机」。现在预设改成 `thresholdRatio: 0.15` / `retainRatio: 0.06`
  （150k 触发、逐字保留约 45k）。查自己部署的门槛：`grep thresholdRatio cordis.patch.yml`；
  查实际压了几次：把 `session.v4.jsonl.zstd` 解压后数 `compaction/start` 的条数
  （`node -e 'console.log(require("node:zlib").zstdDecompressSync(require("node:fs").readFileSync(process.argv[1])).toString())' <文件>`）。

升级后**已经涨大的旧会话不会自己缩回去**（新门槛下它可能一直不压缩，直到长到 150k）；
最省事的做法是在那个群发一次 `/reset`（需要 `resetUsers` 里有你）—— 只换会话，**长期记忆
（`.qq-memory/`）不动**。之后用 `node scripts/ops.mjs logs -n 200` 确认新会话的系统提示稳定。
如果只是想让它「每天翻篇」，把 `idleResetHours` 配成 12：静默超过 12 小时后的第一条消息自动
开新一轮，不用记着去发指令（见[会话与轮次](sessions.md#静默太久自动换一轮idleresethours)）。

### 4. 摘要没跑

- `doctor` 看 `memory` 相关（`memoryDir` 越界会整个停用，日志里有一条 warn）。
- `node scripts/ops.mjs logs -n 500`，grep `qq-bridge: digest`：
  - 没有任何 digest 行：`memory: false`、或今天还没到 `digestAtHour`、
    或 `digestMinLines` 没攒够（首次摘要不受条数限制）。
  - 有「digest 失败 / 超时」：多半是预设里没有 `skill` 工具，或 `qq_memory` / `qq_transcript`
    被 `allowTools` 挡掉了（摘要 Agent 用同一份预设与白名单）。
- 明细状态在 `.qq-memory/digest.json`（`lastDigestAt` / `lastDigestDate`）。

### 5. key 没轮换

`doctor` 的 `KEY_POOL_MISSING` / `KEY_POOL_TOO_SMALL`：

- 池子文件是 `data/api-keys.txt`（相对 `cwd`），一行一个 key，`#` 是注释。
- 只有一个 key（就是当前用的那个）时**什么都不做**，这是设计：没有可换的。
- `credentials.describe()` 说 key 来自启动环境（`writable: false`）时也不做 ——
  环境变量优先级更高，写文件不生效。
- 日志里 grep `api key rotation`：每个候选的探测结果都有一行，绝不含完整 key（只有指纹）。

### 6. Windows 桌面版装了不加载

- `doctor` 的 `PROFILE_LINK_MISSING` / `PROFILE_LINK_ELSEWHERE`：profile 的
  `node_modules/@qqbot/dsh-plugin-qq` 链接没装、或指着旧仓库。
  `scripts/napcat-setup.mjs` 会装（`--dry-run` 先看计划）。
- 启动日志里 `skipping profile bundle "@qqbot/dsh-plugin-qq": cannot resolve …` = **静默跳过**，
  DSH 照常启动，群里当然没反应。
- 改完源码要**重启整个桌面版**（不是重启插件）。

### 7. 计划任务没起来

```bash
node scripts/ops.mjs status --json     # Windows 上会查 schtasks
node scripts/ops.mjs install --json    # 看计划里那几条 human 步骤
```

Windows 上「重启」不能替你做：`restart` 只重启能独立管理的部分，其余输出
「请重启桌面版」+ `requires: human`。计划任务的手工命令原样在 `steps[].command` 里。

### 8. 日志在哪

| 平台 | 看什么 |
|---|---|
| Linux（systemd） | `node scripts/ops.mjs logs -n 200` → `journalctl --user -u qqbot` |
| Windows 桌面版 | NapCat 的日志文件（`napcatAutoConfig` / `--no-log-to-file` 决定），以及桌面版自己的日志 |
| 容器 | `node scripts/ops.mjs logs -n 200` → `docker logs --tail 200 napcat` |

插件自己的日志**同时**写 logger 与 stderr（`report()`），所以 journal / 终端里一定看得到
`qq-bridge: …` 开头的行。

## 每天轮换 API key（`apiKeyRotate`）

一个 key 用得久了会碰到额度、限流或者单纯的「今天不太对劲」。这一节让它**每天凌晨 4:00
自己换一把**：从你自己的 key 池里挑下一个**现在真的能用**的，写进 Harness 的凭据文件。

**它换的是哪个 key**：`apiKeyRef`（默认 `DEEPSEEK_API_KEY`）—— 也就是 QQ 会话和 Web UI
调模型时用的那一个。插件不碰别的东西。

**key 池怎么建**：`apiKeyFile`（默认 `data/api-keys.txt`，相对 `cwd`，已在 `.gitignore` 里）
是一个纯文本文件，一行一个 key：

```text
# data/api-keys.txt —— 一行一个 key，`#` 开头的行是注释
sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
sk-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
# 备注也可以单独写一行
sk-cccccccccccccccccccccccccccccccc
```

池子的顺序**就是轮换顺序**：每次从「当前正在用的那个 key」的下一个开始，绕回开头。
当前 key 不在池子里（手工填的、或者池子刚调整过）时从第一个开始。文件不存在、还没填 key、
或者池子里只有当前这一个 —— 都什么都不做，只在日志里说一句该怎么办：

```text
qq-bridge: api key rotation (daily at 04:00): no key pool at data/api-keys.txt; put one key per line there to start rotating
```

**「尝试」体现在探测上**：候选 key 会先用 `apiKeyProbeUrl`（默认
`https://api.deepseek.com/models`）GET 一下，**2xx 才算可用** —— 这个探测不消耗 token。
探测不过就试池子里的下一个；全都不通过就**保留原来的 key**，只记一条 warn。所以池子里
混进一把失效的 key 不会把 bot 换成不可用的状态，也不会每天卡在同一行上：

```text
qq-bridge: api key rotation: candidate sk-bbb…#3f2a91cd rejected (HTTP 401); trying the next one
qq-bridge: api key rotation: switched DEEPSEEK_API_KEY from sk-aaa…#d1c0be27 to sk-ccc…#9ab41f02 (HTTP 200)
```

几个行为细节：

- **立刻生效，不用重启**：Harness 的模型调用是每次请求都去解析凭据的，本地凭据层又是
  监听文件的，所以换完当场就用新的；正在跑的那一轮不受影响。
- **改的是 `$DSH_HOME/.credentials.yaml` 这一个全局凭据**，而这个文件是所有 profile
  共用的 —— 也就是说它同时影响 Web UI。这是有意的（一把 key 通吃），但值得知道。
- **key 来自启动环境时不换**：如果 `DEEPSEEK_API_KEY` 是从 shell / `EnvironmentFile`
  传进来的，它的优先级高于凭据文件，写文件不会生效 —— 那种部署下插件只记一条 warn 说明
  原因，而不是每天假装换成功。
- **key 来自 `<cwd>/.env` 或 `$DSH_HOME/.env` 时照换**：凭据文件排在它们前面，写进去有效。
- **`apiKeyRotateHour` 只是「几点试一次」**，不落盘「今天换过没有」：重启不会导致当天换
  两次（定时器每次都算「距下一个整点还有多久」），但如果这个时刻正好在重启、那一轮就跳过，
  第二天再换。
- **日志里永远看不到完整的 key**：只打前 6 个字符 + 内容摘要前 8 位，例如
  `sk-aaa…#d1c0be27`。
- 想关掉：`apiKeyRotate: false`（启动日志里会写 `api key rotation is off`）。
  想验证一次而不用等到凌晨 4 点：把 `apiKeyRotateHour` 设成**下一个整点**，重启即可
  （定时器每次都按「距下一个整点还有多久」排期）。

## 迁移与清理

```bash
node scripts/ops.mjs migrate cognition --json     # 只报告：哪些条目能搬到 STICKERS.md
node scripts/ops.mjs migrate cognition --apply    # 写（先备份成 *.bak-<时间戳>）
node scripts/ops.mjs cleanup jm --json            # 列 .qq-jm/ 里的文件（不删）
node scripts/ops.mjs cleanup jm --apply           # 只删 .qq-jm/，绝不碰 .venv
```

`migrate cognition` 退出码 `2` = 有认不出来的条目（要人看一眼），报告里逐条列出。
`cleanup jm` 是**显式动作**：JM 下载已经移除，但旧的 PDF 与 venv 不会自动删。
