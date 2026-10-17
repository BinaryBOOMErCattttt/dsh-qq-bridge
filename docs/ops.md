# 运维排查配方（`scripts/ops.mjs`）

给 **agent 与人** 一起用的一页：先说 `doctor` 能回答什么，再给八个真实场景的排查顺序。
命令都能加 `--json`（stdout 只有一个对象，`schema: 1`），也都能在你的 shell 里直接跑。

> **`--apply` 默认关。** 写 `cwd` 之外的步骤（systemd unit、计划任务、NapCat 配置、桌面版
> profile）都带 `requires: human | root`；不带 `--apply` 只打印计划，带了也只执行 `workspace`
> 那批，剩下的把命令原样打给你复制。这是刻意的：agent 能自动的自动，不能自动的给出可复制的
> 命令，而不是假装自动化然后静默失败。
>
> 退出码：`0` 全部通过 / `1` 有 error 级 findings / `2` 需要人工或提权 / `3` 脚本自身出错。

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
3. 群消息是不是没 @ 它？默认 `groupTrigger: mention`；`activeFollow` 默认关。
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

## 迁移与清理

```bash
node scripts/ops.mjs migrate cognition --json     # 只报告：哪些条目能搬到 STICKERS.md
node scripts/ops.mjs migrate cognition --apply    # 写（先备份成 *.bak-<时间戳>）
node scripts/ops.mjs cleanup jm --json            # 列 .qq-jm/ 里的文件（不删）
node scripts/ops.mjs cleanup jm --apply           # 只删 .qq-jm/，绝不碰 .venv
```

`migrate cognition` 退出码 `2` = 有认不出来的条目（要人看一眼），报告里逐条列出。
`cleanup jm` 是**显式动作**：JM 下载已经移除，但旧的 PDF 与 venv 不会自动删。
