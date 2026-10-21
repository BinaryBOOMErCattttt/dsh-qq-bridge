# 会话与轮次（`/reset`）

> 一个 QQ 会话 = 一个**确定性**的 DSH Session：重启后同一个人再发消息，插件 `resume` 原来那个。
> `/reset` 不删旧会话，而是把「第几轮」+1、换一个新 id 从头开始。

## 新开一轮会话（`/reset`）

在 QQ 里**单独发送** `resetCommand`（默认 `/reset`）即可给**当前这个会话**开新的一轮：

- 只影响发指令的那个会话（私聊对象 / 群），别的会话不受影响；
  群聊的上下文缓冲（`ambientMessages`）也一起清掉。
- 整条消息恰好等于指令才触发；`/reset 你好` 这种带内容的消息会照常交给 Agent。
- **只有 `resetUsers` 里的 QQ 号能重置**，而且这一项**默认是空的 —— 也就是谁都不能**。
  这一条与 `allowUsers` 的「留空 = 不限制」刻意相反：群消息是不可信输入，一个「没配就等于
  人人可用」的重置指令意味着群里任何一个人都能悄悄把会话重开一轮，而且默认没人会去配它。
  所以想用这个指令必须显式写号。本仓库的写法是把号放进**环境变量**（DSH 启动时会读
  `<启动 cwd>/.env` 和 `$DSH_HOME/.env`）：

  ```bash
  # <仓库根>/.env（已被 .gitignore 盖住）
  QQBOT_RESET_USERS=123456789,987654321
  ```

  `cordis.patch.yml` 里那行 `resetUsers: !!js …` 会把逗号分隔的变量拆成数组、去空白，
  变量不存在或为空时就是空数组（= 谁都不能，与默认值一致）。**改完要重启进程**（`.env`
  只在启动时读一次）。也可以在 Web UI 的插件设置里直接填 `resetUsers` —— 那边写的是完整
  config；但别去 profile 的 `cordis.patch.yml` 里单写这一个字段（见[配置项](configuration.md#配置项)开头的警告）。
  群里看的是**发言者**的 QQ 号（不是群号）；私聊看的是对方。
- **没权限的人发 `/reset` 会被静默忽略**：不重置，也不回一句「你没有权限」—— 回话等于告诉
  全群这里有这么个指令、还激人去试。这条消息仍然照常记进转录（留痕在长期记忆里），但不会
  交给模型，也不会把当时攒着的那批消息提前投出去。
- 启动日志里会明说权限状态（`reset command "/reset" is allowed for 1 account(s): …` /
  `… is disabled for everyone: resetUsers is empty`）—— 配错了不用猜。
- **`/reset` 不是「删掉会话」，而是「换一个会话重新开始」**：先销毁活着的 Agent
  （连同它内存里的上下文与 Session 写出句柄），再把「这个会话开到了第几轮」+1
  并落盘。下一条消息据此算出一个**新的** Session id，于是从头开始。
- 上一轮的 Session 记录**留在磁盘上**当那段聊天的存档，不会被删；只是不再被带进
  新一轮的上下文里。想真删掉它是运维动作（删 `$DSH_HOME/sessions/<项目>/<会话 id>/`），
  不是聊天指令 —— 聊天里没有「把说过的话抹掉」这种能力。
- 「第几轮」是落盘的，所以**重启不会把上一轮 resume 回来** —— 否则 `/reset` 等于白按。
  标记文件在会话根目录下的 `reset/<会话>.json`（拿不到会话根时退回 `cwd` 下的
  `data/reset/`）。
- `qq_list_conversations` 里报的 `session_id` 会换成新一轮的 id，`session_round`
  是当前轮次（0 = 从没 `/reset` 过）。
- 长期记忆（`.qq-memory/`）**不受影响**：转录、`MEMORY.md` 是按会话 key 落的，
  与轮次无关 —— 「上一轮聊过什么」仍然记得，只是不再占着上下文。
- 把 `resetCommand` 设为空串即可禁用该指令。

## 在 Web UI 里重置（设置页按钮）

不想在 QQ 里发指令，也可以打开 **设置 → QQ Bridge → 会话**，用页面顶部的「重置对话」：

- 列表是**这次进程处理过**的会话（`conversations` 是运行时内存表）。重启之后要等对方
  再发一条消息，会话才会重新出现在这里；它不会去扫磁盘上的历史会话。
- 每条右边的「重置」= 对那个会话执行一次 `/reset`：销毁活着的 Agent、代次 +1 并落盘，
  下一句从空会话开始；旧会话留在磁盘上当存档，长期记忆（转录 / `MEMORY.md`）不动。
- 「全部重置」要按两下（第一下只是把按钮换成「确定全部重置？」），它会对列表里的每个
  会话各换一轮。
- 重置前**攒着还没投的那批消息会先投出去**，与 QQ 里的 `/reset` 完全一致 —— 那几句话是
  重置前说的，不该被新一轮忘掉。
- 它**不受 `resetUsers` 限制**：那是「QQ 群里谁能发这个指令」的白名单。这条路由挂在
  Connection 的认证栅栏后面，只有已登录的 Web UI 操作员能访问（其他 principal 一律
  403）；能打开设置页的人本来就能改配置、重启进程。把 `resetCommand` 设成空串只会禁用
  QQ 里的指令，不影响这个按钮。
- 接口是 `GET /api/qq-bridge/sessions`（列表）与 `POST` 同一个路径（body 为
  `{ "key": "group:123" }` 或 `{ "all": true }`）。它是运行状态的动作，不是配置项，
  所以不在 `Config` schema 里，也不会出现在搜索里。

## 静默太久自动换一轮（`idleResetHours`）

`/reset` 要有人手动发，长期跑下来没人按；而会话越老，模型手里的「记忆」越可能只剩压缩摘要。
`idleResetHours` 把「每天翻篇」做成自动的：

- 会话**静默**超过这么多小时（默认 `0` = 关，本仓库的 `cordis.patch.yml` 置成 `12`）之后，
  下一条消息先开**新一轮**（机制与 `/reset` 完全一样：代次 +1、旧会话留档、长期记忆不动），
  再照常回这条消息。
- 「静默」按**这个会话最后一条别人的消息**算 —— 群里一直在说话（哪怕没 @ 它）就不算静默；
  戳一戳也算活动。机器人自己说的话不算。重启后内存里的时刻是空的，所以进程刚起的那条消息
  不会触发（保守：宁可少换一次，也不要在刚重启时把上下文砍断）。
- 它不需要 `resetUsers` 权限：这不是谁发的指令，是按时间自动发生的。`/reset` 自己不会触发
  两次换代（那条消息走的是指令分支）。
- 为什么是「静默」而不是「每天 04:00 定时」：定时会打断深夜的聊天，也会在群正活跃时把上下文
  砍断；按静默时长判，效果等价于「每天第一次开口换一轮」。
- 换代只清会话上下文：`.qq-memory/` 里的转录、`MEMORY.md`、认知库都不动，所以「昨天聊过
  什么」仍然查得到，只是不再占着模型的上下文。

## 系统提示里宿主的那几段（QQ 会话会覆盖掉）

宿主（`dsh-web-app` 的 patch）把部署 persona 配成「You are a coding agent powered by the
model.」，还在系统提示末尾注册「You are interacting with the user through the DeepSeek Harness
Web GUI at …」「The DeepSeek Harness implementation checkout is at …」，`dsh-client-ui-deliverables`
再补一段「用 Markdown 链接 / `present` 展示结果」。这些对 Web UI 是对的，对 QQ 会话是错的：
它们分别压在系统提示的开头和结尾，比夹在中间的 `qq-bridge:channel` 更像「我是谁」。

插件在**每个 QQ 会话自己的作用域**里按同名小节把它们覆盖掉（`harness:identity` /
`deployment:persona-prefix` / `ui:deliverable-file-references` / `harness:source` /
`app:web-surface` / `deployment:persona-suffix`），Web UI 的会话不受影响。以后升级 DSH 时
如果发现 QQ 会话又开始自称「编码代理 / 在网页里」，先看 `index.js` 的 `HOST_PROMPT_SHADOWS`
是不是漏了新加的小节。
