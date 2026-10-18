# 工具与能力面

> QQ 会话能用哪些工具、预设从哪来、`allowTools` 怎么收窄。
> 默认预设是**刻意最小**的：只读文件 + 检索 + 联网 + 本地 skill，没有 shell / 子代理。

## 工具

| 工具 | 作用 |
|---|---|
| `qq_send_message` | 向指定 QQ 号（私聊）或群号（群）发送文本，超长自动分段；正文里可以写 `[[@昵称]]` / `[[@全体成员]]` @ 人（见[「像真实群友一样说话」](speaking.md#像真实群友一样说话)的第 6 条） |
| `qq_send_image` | 向指定 QQ 号或群发一张图 / 表情包：来源是 `cwd` 里的图片路径（含 `.qq-stickers/…`、`.qq-media/…`）或一个 http(s) 图片链接；从 QQ 会话里调用时默认发回当前会话 |
| `qq_save_sticker` | 把一张图**存进表情包目录**（`.qq-stickers/<名字>.<真格式>`）变成以后能挑的表情：来源同上，名字会被清洗成单层文件名、同名不覆盖、张数受 `stickerMaxFiles` 限制；图片本身不可用（目录没配 / 配到 `cwd` 外）或白名单没放开时**根本不注册** |
| `qq_rename_sticker` | 给一张**已收藏**的表情改名：文件与 `STICKERS.md` 那一条一起搬（含义 / 场景 / 日期跟着走），目标名被占用就拒绝；只改含义不用它（用 `qq_memory` 的 `upsert` 按原名改）。白名单按名字算，目录不可用时同样**根本不注册** |
| `qq_list_conversations` | 列出在线群/好友列表，以及本 Harness 已处理过的 QQ 会话、当前 Session id 与轮次（`session_round`） |
| `qq_transcript` | 读某个 QQ 会话的聊天记录：`list` / `read` / `search`（长期记忆的原料，见[长期记忆](memory.md#长期记忆聊天记录--摘要--认知)） |
| `qq_memory` | 读 / 搜索 / **逐条 upsert / remove** / 整理用的 write 长期记忆文件：`conversations/<slug>/MEMORY.md`、`PEOPLE.md`、`COGNITION.md`、`STICKERS.md`、`INDEX.md`；整份 `write` 有「条目数不能掉 10%」护栏（四个结构化文件都管），写前留 `.history/` 备份；写被限制在 `memoryDir` 之内，**私聊不能写 `COGNITION.md` / `PEOPLE.md`**（scope 闸门）；搜会话 `MEMORY.md` 时包含 `archive/` |
| `qq_remind_create` | 建一条到点的提醒：到点由插件直接发消息（`text` 原样 / `agent` 让模型换语气 / `prompt` 到点做事），可 `@` 创建者或名单里的人；时间用本地 `YYYY-MM-DDTHH:MM` 或 `in_minutes`，周期支持每天 / 工作日 / 每周 / 每月，见[定时提醒](reminders.md) |
| `qq_remind_list` | 列出提醒：默认这个会话的，`scope: "mine"` 只看自己建的，`scope: "all"` 只在 Web 操作员那里可用；带状态、下一次时间与失败原因 |
| `qq_remind_cancel` | 按 id 取消一条还没发的提醒；只有创建者本人（或 Web 操作员）能取消 |

这十个都是纯宿主平面的全局工具，所有 Agent（包括 Web UI 里的主会话）都能用。
`qq_send_image` / `qq_save_sticker` / `qq_rename_sticker` 见[它也能发表情包](media.md#它也能发表情包)；
`qq_transcript` / `qq_memory` 见[长期记忆](memory.md#长期记忆聊天记录--摘要--认知)，
关掉 `memory` 后它们**根本不会注册**；关掉 `reminder`（或任务文件配到 `cwd` 外）后
`qq_remind_*` 三个**根本不会注册**。

## QQ 会话的工具从哪来（`agentPreset`）

在 **Web 表面**（本 profile 用的 `@deepseek-ai/dsh-web-app`）里，`bash` / `read` /
`glob` / `grep` / `web_search` / `web_fetch` 这些「agent 平面」的工具**不在宿主上**：
它们被搬进了每个 Agent 预设，只有 join 了预设的 Agent 才继承得到。直接
`ctx.agents.create()` 出来的 Agent 不 join 任何预设，于是它只有宿主平面的全局工具
——也就是本插件的 `qq_*` 那几个（发消息 / 发图 / 存表情 / 会话列表 / 记忆）。

所以插件会在 `setup()` 里先给 QQ 会话 Agent 挂一个预设，再施加 `allowTools`。
挂的是 **bundle 自带的 `qq` 预设**（声明在 `cordis.patch.yml`）：

```yaml
agentPreset: qq   # 就是默认值；留空 = 用部署默认预设（可能带 shell），none = 不挂
```

`qq` 预设只放五样东西：`tool-fs`（read / read_image / write / edit）、
`tool-fs-search`（glob / grep）、`tool-web`（web_search / web_fetch）、
`skill-filesystem` + `tool-skill`（发现并加载 `.dsh/skills` 下的 skill）、以及压缩
（compaction / tool-result-pruner）。没有 shell、没有子代理、没有 workflow、没有计划模式。

预设里的 `compaction-basic` **显式钉了压缩门槛**（`thresholdRatio: 0.06` /
`retainRatio: 0.02`：上下文到约 6 万 token 就把最老的一段压成 checkpoint，逐字保留
最近约 1.5 万）。不配的话，默认门槛是 `min(上下文×0.8, 上下文−请求 maxTokens−headroom)`
—— deepseek-flash 声明 100 万上下文，算下来约 **67.8 万 token** 才会触发，而 QQ 会话
是长驻的（一个群一个会话，重启还在，只有 `/reset` 才开新一轮），永远到不了那个量级。于是历史
只增不减，**每一轮都把整段历史重发一遍**，上下文越大每轮越贵。压到 6 万之后单轮上下文
才有上限；觉得它记事不够就往上调，想更省就往下调（`retainRatio` 必须小于 `thresholdRatio`）。

**为什么不直接挂 `standard`**（踩过的坑）：

- `standard` 的 `subagent` 行开了 `modelSelectionSettings: true`。这个模式下
  `dsh-tool-subagent` 会在每个 Agent 创建时通过 `agent.ctx.inject(...)` **在 Agent
  自己的作用域里**再注册一份 `subagent` 工具。而 `tools.restrict()` 按设计只收窄
  **继承来的**工具，放过「该作用域自己的注册」（那是给 Agent 作答所依赖的机制留的口子），
  于是 `subagent` 会绕过 `allowTools` 出现在 QQ 会话的工具表里。
  同一预设里的 `subagent_fork` / `workflow` 是普通注册，反而被白名单挡住了
  —— 只有走 per-agent 注册路径的那个漏出来。
- `standard` 还带了 bash / write / subagent / workflow / ask_user / plan-mode 等一大
  堆 QQ 用不到的东西。**能力面应该在组合层面收窄**，而不是先给全量、再指望白名单兜住。

其它要点：

- 顺序是**先挂预设，再收窄**：`tools.restrict()` 只能收窄这个 Agent **继承得到**的
  工具，白名单给不出它本来就没有的能力。
- `allowTools` 是第二层：预设里的 `write` / `edit` 就靠它挡掉（它们在预设层，属继承工具，
  收得掉）。
- 从 `dsh-base` 起的组合（如 headless）根本没有预设平面，`ctx.get('agentPresets')`
  取不到东西，插件会跳过挂载、直接收窄宿主工具，行为与老版本一致。

**排查「QQ 会话突然不能联网 / 读文件」**：插件的日志会直接写在进程的 stderr 上
（systemd 收进 journal），所以：

```bash
journalctl --user -u qqbot -f | grep qq-bridge
```

- `qq-bridge: … joined agent preset qq` —— 预设挂上了，工具存在。
- `qq-bridge: … limited to tools: read, …, web_search, …` —— 白名单**完整**生效。
- `qq-bridge: allowTools rejected (...); keeping only the visible names: … — a whitelist
  cannot grant tools this Agent does not have` —— 白名单里有这个 Agent 拿不到的名字
  （没挂预设、预设里没有该工具，或名字拼错）；冒号后面列出的就是真正生效的那几个。
- `qq-bridge: could not resolve agent preset "…"` —— 预设名不存在或激活失败（原因跟在
  后面）。这种情况下 QQ 会话会退化成只有 `qq_*` 那几个工具。

> 为什么要自己写 stderr：这个部署没有把 cordis 的 logger 接到 stdout/stderr 上
> （`ctx.logger.warn` 只进内存缓冲与 OTel），只调 `ctx.logger` 的话 journal 里
> 一个字都看不到。插件因此每条日志都镜像一行到 stderr。

## 限制 QQ 会话的工具（`allowTools`）

QQ 那头是**不可信输入**：谁都能给机器人发消息，而这个机器人背后是一个能读写
文件、跑命令的 Agent。`approvalPolicy: never` 只挡住了「需要审批」的操作，
`allowTools` 是把能力面收窄的第二层。

```yaml
allowTools:
  - read          # 只读文件
  - qq_send_message
```

- **只影响 QQ 会话**：收窄施加在「由 QQ 消息创建出来的那个 Agent」自己的作用域上
  （DSH 的 `tools.restrict()`），Web UI 主会话等其它 Agent 完全不受影响。
- **默认就是收窄过的**（18 个：只读文件 + 检索 + 联网 + 十一个 `qq_*`）—— 这样即使
  `agentPreset: qq` 的预设里带了 `write` / `edit`，QQ 会话也拿不到它们。
- **显式写空数组 = 不限制**（与 `allowUsers` / `allowGroups` 同一套语义）：把这个 Agent
  继承到的工具全给它。想放开某一项，就把默认那 17 个抄下来再加减，别直接清空。
- 过滤的是**继承来的**工具（宿主平面的全局工具 + 这个 Agent join 的预设里的工具）。
  ⚠️ Agent **自己作用域里注册**的工具不受影响 —— 这是设计使然（它回头作答所依赖的
  机制不能被收走），但也意味着某个预设行可能绕过白名单，典型例子就是 `standard`
  预设下开了 `modelSelectionSettings` 的 `subagent`（见上一节）。要收紧能力面，
  **换一个更小的预设**，别指望 `allowTools` 兜底。
- 白名单只能**收窄**，不能**授予**：列了 `web_search` 但预设里没有 `tool-web`，
  结果就是该工具不存在，会被当成不认识的名字丢掉 —— 见上一节。
- 名字写错时不会拖垮对话：不认识的名字会被丢掉并打一条 `warn` 日志；如果一个都
  不认识，该会话将被收走全部工具（fail-closed —— 你明确要的是白名单，不能悄悄
  退回全量工具）。
- 提示词会跟着联动：没被放开的 `qq_*` 工具不会再出现在渠道说明里。
- 生效时机是**创建/恢复 Agent 时**。已经在跑的 QQ 会话 Agent 不会被追溯，
  改完配置要重启 Harness 进程才作用于已有会话。

⚠️ 别把「能开出新 Agent」的工具放进白名单：`subagent`、`workflow`、`run_code`
这类工具会启动**自己的**工具集，不再受这张白名单约束。要收紧能力面，就把它们
留在白名单之外。同理，`run_code` 是 PTC 模式（`tools.mode: ptc/both`）自带的
传输工具、无法被列进白名单，但它能调到的子工具仍然受白名单约束。
