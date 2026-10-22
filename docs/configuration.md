# 配置项

> 全部配置项的唯一真相是 `config.js` 的 schema；这一页按字段逐条解释，schema 上的中文
> `.description()` 是同一份说明的源头（也会显示在 Web UI 设置页）。想让它在 Web UI 里改、
> 以及哪些值应该走环境变量，见下一节的「设置页」。安装见 [install.md](install.md)。

在 `cordis.patch.yml` 的 `config:` 下配置，也可以在 Web UI 的插件设置里改。

> ⚠️ **不要手写一个只有几个字段的 `config:` 去覆盖它。**
> DSH 的 patch 语义是：按 id 命中的行**整块替换** `config`，**不深合并**（`dsh-app-boot` 的
> `applyEntryPatches` 就是 `target.config = patch.config`）。在那边只写一个 `resetUsers`
> 也会把仓库 patch 里的整套配置一起顶掉 —— `activeFollow` / `proactive` / `batchWindowMs` /
> `persona` 静默退回 schema 默认值，表现就是「群里不 @ 它就不说话」「人设没了」；更糟的是
> `agentPreset` 也一起丢，QQ 会话会挂上部署默认的 `standard` 预设，等于把 shell / 子代理
> 暴露给不可信的群消息（`allowTools` 白名单同时失效）。
>
> 想改配置：改仓库里的 `cordis.patch.yml`（bundle 层，配置的唯一真相），或在 Web UI 的插件
> 设置里改 —— 后者写的是**完整** config（见下一节），不是上面那种「手写几个字段」。本机私有的
> `resetUsers` 白名单仍然走环境变量，见[新开一轮会话](sessions.md#新开一轮会话reset)。

## 在 Web UI 的设置页里改

侧栏底部的 **设置** → 左边导航里的 **QQ Bridge**：本插件的全部配置都在这单独的一页里
（这个入口是刻意保留的顶级入口，不挂到「设置 → 插件」的 tab 下 —— 一百多项埋在插件页里
会被彻底忽略）。页面按用途分成 **7 个下划线 tab**：

| tab | 全称 | 装什么 |
|---|---|---|
| 连接 | 连接与准入 | 连接与运行环境 / 准入与触发 |
| 会话 | 会话与节奏 | QQ 会话与 Agent / 攒批与群聊上下文 / 说话方式与节奏 |
| 人格 | 人格与表达 | 人格与提示词（PERSONA.md 优先）/ 表达（STYLE.md / 气泡 / 标点 / 补一句） |
| 群聊 | 群聊互动 | 自动复读 / 主动说话 / 活跃对话 |
| 提醒 | 定时提醒 | 定时提醒的配置；这一页最上面是**已记录的定时任务**（只读，每 15 秒刷新） |
| 感知 | 感知与媒体 | 图片与表情包 / 感知与互动（链接 / 视频 / 戳一戳 / 撤回） |
| 记忆 | 记忆与运维 | 长期记忆 / 模型凭据轮换 |

默认打开「连接」；每个 tab 里是几个**扁平区块**（标题 + 分隔线 + 一行一个字段），
不再是以前那种一叠折叠卡片。只有「人格」tab 里的旧 `persona` 折进
「兼容：旧 persona（文件存在时不生效）」一处，其余字段全部平铺 —— 藏起来只会让人找不到。

- **按类型给控件**：布尔是开关（行标题 + 说明在左、开关在右）；枚举是下拉
  （`groupTrigger` / `approvalPolicy` / `pokeMode` / `recallMode` / `replyStyle`，每个取值都有中文说明）；
  数字 / 文本是输入框；列表（白名单、工具白名单）在输入框下面把当前值做成可点的 Pill，
  点 × 删掉那一个；`persona` / `instructions` 是整段提示词，用多行输入框改。
- **数字带量纲**：`proactiveIdleMs: 2700000` 这类字段下面会多一句只读的「= 45 分钟」
  （`= 35%` / `= 8 MB` / `= 04:00` / `= ×2` 同理）。输入框里始终是原始值，不做双向换算。
- **搜索**：顶部搜索框按 **短标签 / 字段名 / 描述 / 区块标题** 跨 tab 匹配
  （`proactive`、`proactive_idle_ms`、`攒批窗口` 都能命中），命中的行本身就能改，
  右侧 Tag 标着它属于哪个 tab；`Esc` 清空回到分组视图，不做 `/` 快捷键。
- **已改 / 只看已改**：工具栏右边的 Tag 是「已改 N 项」（保存会留下一层覆盖的行数），
  旁边的「只看已改」把页面过滤成这几行，可以和搜索叠加；有填错的项时还会多一个
  「N 项待修正」。计数与过滤都只是视图，保存仍然只有**页头**那一个按钮（见下一条）。
- **保存按钮在页头右侧、与标题同一行**，页头 sticky（滚到哪它都在）：只有这一个保存按钮 ——
  没有改动、有字段还非法、正在保存或本部署只读时它是灰的，左边会写明原因（「有未保存的修改」/
  「N 项待修正」/ 保存失败的提示）。页头底色就是内容区的底色（`bg-layer-2`），不是一条
  横贯整页的深色带。离开这一页会丢弃还没保存的草稿。
- 每一项都带说明，点字段右边的 ⓘ 看完整解释与配置项名（也就是 `config.js` 里的键名）。
- 它读的就是 `config.js` 这份 schema，所以**加了新配置项，页面上自动多一个字段**，不用改界面。

「人格」tab 里字段顺序是**文件优先**：先是 `cwd/.qq-persona/PERSONA.md` / `STYLE.md` 的
路径与预算，旧 `persona` 在「兼容」里，`instructions` 在正文；区块顶上还有一行说明，
告诉你文件存在时哪一项不生效、哪一项照常叠加。注意人设现在优先读
`cwd/.qq-persona/PERSONA.md`：那个文件存在时 `persona` 这一项会被忽略（日志里有一条 info），
见[人格与表达](persona-style.md#人格与表达personamd--stylemd)。「表达」tab 里的机器参数按
**标点 / 私聊** 分了小标题，散文（`STYLE.md`）与参数互不解析。

保存时发生的事，值得先知道：

- 写的是**当前 profile** 的 `cordis.patch.yml`，内容是**完整配置**：其余字段按当时
  **生效的值**一起写进去。所以保存之后这一层就固定住了当时的取值 —— 以后再改仓库 patch 的
  默认值，那份 profile 里的值不会跟着变。想回到「跟着仓库 patch 走」，把那一段 `config:`
  删掉，或在字段上点「恢复默认」。
- **`!!js` 表达式原样保留**：`endpoint` / `accessToken` / `cwd` / `resetUsers` 这些从
  环境变量读的值是以表达式写回去的，不会因为在界面上点了一次保存就变成写死的字面量
  （除非你就是在那个字段里填了个新值 —— 那本来就是要覆盖它）。
- 保存之后插件会**重启一次**：配置走的是 Loader 的 volatile 热更新，它不重跑 `apply()`，
  而连接、定时器、工具注册都是 `apply()` 里装配的。重启会断一次 OneBot 连接，**聊天记忆
  不受影响** —— 会话 id 是确定性的，下一条消息照样 resume 出同一个 Session。
- **`accessToken` 目前还是普通字段**：它的值会随表单下发到浏览器，页面里就是一个可见的
  输入框（把它改成密钥字段要动 schema 的 `role('secret')`，属于单独的行为变化）。保存时它作为
  完整配置的一部分写进 profile patch（那个文件是 0600）。在意这一点的话，用环境变量
  `QQBOT_ACCESS_TOKEN` 给值、界面上留空。

| 字段 | 默认 | 说明 |
|---|---|---|
| `endpoint` | `ws://127.0.0.1:3001` | OneBot v11 正向 WebSocket 地址（可用 `QQBOT_ENDPOINT` 覆盖，见 [Windows 桌面版](windows.md#windows-桌面版napcatshell)） |
| `accessToken` | `''` | OneBot access_token，未设置则留空（`QQBOT_ACCESS_TOKEN`） |
| `cwd` | 进程当前目录 | QQ 会话 Agent 的工作目录（也是沙箱根）；**Windows 桌面版上那个「进程当前目录」是 `~/.dsh/profiles/desktop`**，所以一键脚本会写一个 `QQBOT_CWD` 指到 `~/.dsh/qq-bot` |
| `napcatDir` | `''` | NapCat 安装目录（里面有 `config/onebot11_<QQ号>.json`）：启动时读它做一次**只读**自检，把「NapCat 那边还差什么」直接写进日志。留空 = 自动探测本仓库 / 当前目录 / 家目录下的 `NapCat.Shell`（`QQBOT_NAPCAT_DIR`） |
| `napcatAutoConfig` | `false` | 自检发现 NapCat 缺一条监听 `endpoint` 端口的 WebSocket 服务器时，**是否让插件自己写进去**（写前备份原文件，只动 `websocketServers` 里我们那一条）。默认关：那是另一个软件的配置。一键脚本会显式打开（`QQBOT_NAPCAT_AUTOCONFIG=1`） |
| `privateChat` | `true` | 是否响应私聊 |
| `groupChat` | `true` | 是否响应群消息 |
| `groupTrigger` | `mention` | 群消息触发：`mention` / `prefix` / `all`（`activeFollow` 打开时，被叫到之后的窗口内同一个人接着说的话、以及群里聊热之后的「多人搭话」也都算，见[聊起来之后保持搭话](proactive.md#聊起来之后保持搭话活跃对话)） |
| `prefix` | `/` | `groupTrigger=prefix` 时的前缀 |
| `blankReply` | `true` | 是否理会「没有正文」的消息：群里单纯 @ 它一下、或私聊发一个空格，都照常交给模型（正文位置写明「@了你一下，没有说别的」），由它看着上下文决定回「？」、发张表情还是接上一句；`false` = 静默丢弃，见[没有正文的消息](speaking.md#没有正文的消息blankreply) |
| `allowUsers` | `[]` | 私聊白名单；空 = 不限制 |
| `allowGroups` | `[]` | 群白名单；空 = 不限制 |
| `agentPreset` | `qq` | QQ 会话 Agent 挂载的 Agent 预设 id：默认 `qq`（本 bundle 自带：只读文件 + 检索 + 联网，没有 shell / 子代理）。空 = 用**部署的默认预设**（可能是带 shell 的 `standard`，QQ 消息是不可信输入，别轻易这么配），`none` = 不挂预设（只剩宿主平面的 `qq_*`） |
| `provider` / `model` | `''` | QQ 会话使用的模型；空 = 用默认 |
| `approvalPolicy` | `never` | `never` = 无人值守时一律拒绝需要审批的操作 |
| `allowTools` | 18 个工具名 | QQ 会话可用的工具白名单：默认 `read` / `read_image` / `glob` / `grep` / `web_search` / `web_fetch` / `skill` + 十一个 `qq_*` —— **没有 write / edit / bash**。空 = 不限制（全给它继承到的工具）；写错的名字会被丢掉并记 warn，见[限制 QQ 会话的工具](tools.md#限制-qq-会话的工具allowtools) |
| `resetCommand` | `/reset` | 新开一轮会话（旧会话留在磁盘上当存档）的指令；空 = 禁用 |
| `resetUsers` | `[]` | 允许用 `resetCommand` 的 QQ 号；**留空 = 谁都不能重置**（与 `allowUsers` 反过来，见[新开一轮会话](sessions.md#新开一轮会话reset)）。本仓库的 `cordis.patch.yml` 把这一项接在 `QQBOT_RESET_USERS` 环境变量上（写进 `<启动 cwd>/.env`，逗号分隔）—— 免得把自己的号提交进仓库 |
| `idleResetHours` | `0` | 会话**静默**超过这么多小时之后，下一条消息自动开新一轮（与 `/reset` 同一套机制，长期记忆不动）；`0` = 关。不需要 `resetUsers` 权限；「静默」按这个会话最后一条别人的消息算（含没 @ 机器人的闲聊），见[静默太久自动换一轮](sessions.md#静默太久自动换一轮idleresethours) |
| `maxReplyChars` | `1500` | 单条 QQ 消息最大字符数（协议上限），超出自动分段 |
| `mediaDownload` | `true` | 是否把消息里的图片/表情包下载到本地（模型只能读本地文件，不下载就只看到占位符） |
| `mediaDir` | `.qq-media` | 媒体缓存目录，相对 `cwd`；必须落在 `cwd` 内，否则自动停用下载 |
| `mediaMaxBytes` | `8388608` | 单张图的字节上限，超过就不下载（只留占位符） |
| `mediaCacheFiles` | `200` | 缓存最多保留几个文件，按最近使用时间淘汰最旧的 |
| `mediaTimeoutMs` | `15000` | 单张图的下载超时（毫秒） |
| `quoteMedia` | `true` | 是否把「被引用（回复）的那条消息」也取回来：引用里的图和正文都会进正文，见[引用消息](media.md#被引用的那条消息也能看见) |
| `ambientMedia` | `true` | 群聊环境上下文（没 @ 机器人的那几条）里的图是否也落盘；`false` = 只留占位符，不为闲聊花带宽和磁盘 |
| `imageSend` | `true` | 是否允许 Agent **主动发图/表情包**：`qq_send_image` 工具 + 回复正文里的 `[[图片: …]]` 标记（只发表情就靠它）；`false` = 两个都关，提示词里也不再提 |
| `stickerDir` | `.qq-stickers` | 给它的表情包目录，相对 `cwd`（必须落在 `cwd` 内）：文件名会列进每轮的「本轮情境」，模型据此往标记/工具里写路径；留空 = 不提示这个目录 |
| `imageMaxBytes` | `8388608` | 单张出站图片的字节上限（8MB）：超过直接报错，不做静默压缩 |
| `stickerMaxFiles` | `60` | 表情包目录最多保留几张：`qq_save_sticker` 存图时目录里已经有这么多就拒绝（QQ 那头是不可信输入，群里谁都能让它一直存）；`0` = 不限制（不建议） |
| `linkPreview` | `false` | 正文里的裸 URL 是否抓一次标题：打开后只抓 `<title>` / `og:title`，有 SSRF 防护（拒内网 / 回环 / 保留地址，重定向逐跳复核），超时与大小都有上限。卡片消息（json/xml）不联网就能解析，不受这个开关影响 |
| `linkPreviewTimeoutMs` | `8000` | 抓链接标题的超时（毫秒） |
| `linkPreviewMaxBytes` | `524288` | 抓链接标题最多读多少字节（512KB）：超过就只看已读到的部分里有没有 `<title>` |
| `linkAllowPrivateHosts` | `false` | 是否允许抓内网地址（自建 wiki 之类才打开）：关着时 localhost / `*.local` / `*.internal` / 私有与保留 IP 一律拒绝。**它只放开字面量判定，不放开 scheme**，见[安全提醒](security.md) |
| `forwardRead` | `true` | 是否展开合并转发（`forward`）的正文：打开后每条子消息渲染成「谁: 什么」，子消息里的图也照常落盘；`false` = 只留 `[合并转发 N 条]` 占位符，见[合并转发](media.md#合并转发forward) |
| `forwardMaxNodes` | `20` | 一条合并转发最多展开多少条子消息：超出的部分写一句「还有 N 条没展开」 |
| `forwardMaxChars` | `1200` | 一条合并转发展开后的字符上限（含开头那行）：到顶就停，避免一条长转发撑爆整轮上下文 |
| `forwardMaxDepth` | `1` | 合并转发最多展开几层：`1` = 只展开最外层，转发里套的转发仍是占位符；`0` = 一层都不展开 |
| `forwardTimeoutMs` | `5000` | 没有内联内容、需要调 `get_forward_msg` 时的超时（毫秒）：卡住就保留占位符，不拖住投递 |
| `videoCover` | `true` | 视频消息是否下载封面图（只下封面，不下整段视频）：开着时正文是「[视频 12 秒 · 封面: .qq-media/…]」，模型能 `read_image` 看一帧 |
| `videoMaxBytes` | `0` | 整段视频的下载上限（字节）：`0` = 不下载整段（默认，只有封面）。非 0 时会先校验大小再下；插件不做转码、模型也读不了视频，一般不需要开 |
| `pokeReply` | `true` | 被戳一戳（双击头像）时是否回应 |
| `pokeMode` | `random` | 怎么回应戳一戳：`random` = 按 `pokeReplyChance` 在「回戳」与「走一轮模型」之间掷（默认）/ `poke` = 总是回戳 / `text` = 走一轮模型（正文是「X 戳了你一下」，允许 SKIP）/ `ignore` = 不回 |
| `pokeReplyChance` | `0.7` | `pokeMode: random` 时选择「回戳」的概率（0~1）：其余情况走一轮模型 |
| `pokeCooldownMs` | `30000` | 同一个会话两次回应戳一戳之间至少隔多久（毫秒）：**防回戳死循环**，冷却里不管戳几下都只回一次 |
| `pokeDailyMax` | `20` | 同一个会话一天最多回应几次戳一戳（本地日界线，重启归零）；`0` = 不限 |
| `batchWindowMs` | `2000` | 收到要回的消息后先等这么久（毫秒）看还有没有下一条：几个人同时 @ / 一个人连发几句会攒成一条消息只回一轮；`0` = 关闭攒批 |
| `batchMaxWaitMs` | `5000` | 一直有人接着说时，一批最多以第一条为起点攒这么久（毫秒）就发出去 |
| `batchBacklog` | `true` | 上一轮还没跑完时收到的 @ 先攒成一波，等它闲下来只接一轮（十条以上时不再排成十几轮回复）；见[长任务期间的 @](speaking.md#11-长任务期间的-先攒一波忙完挑着接)。关掉 = 回到「每 `batchMaxWaitMs` 一批排队」 |
| `batchBacklogEntries` | `20` | 这一波最多贴几条（至少 2）：超过就保留最早 2 条 + 最近的，中间折成一句「更早还有 N 条」 |
| `batchBacklogChars` | `2000` | 这一波最多带多少字：超出时继续从最老的那条开始折掉，但永远保留最后一条 |
| `batchBacklogHoldMs` | `120000` | 这一波最多憋多久（毫秒）：还忙着就先投进队列（退回排队），免得它卡住时这些消息永远投不出去；`0` = 不攒（等于关掉这一项） |
| `ambientMessages` | `12` | 群聊里注入给 Agent 的最近消息条数；`0` = 关闭 |
| `ambientLineChars` | `120` | 群聊上下文里每条消息最多保留的字符数 |
| `repeat` | `true` | 群里连着出现同一条消息时跟着复读一句：不经过模型、不建会话，见[自动复读](repeat.md#自动复读repeat) |
| `repeatMedia` | `true` | 是否连表情包一起复读（整条就是一张图/一个系统表情时，连着两个一样的就跟着发第三个）；它不额外下载，用的就是环境上下文那次落盘 |
| `repeatCount` | `2` | 连着几条相同的消息之后跟着复读；`2` = 有人接了一句就跟（至少 2） |
| `repeatDistinct` | `true` | 是否要求这些相同的消息来自至少两个不同的人；`false` = 一个人自己连发两遍也跟 |
| `repeatWindowMs` | `300000` | 间隔超过这么久就不算「连着」了，重新开始数（毫秒）；`0` = 不限间隔 |
| `repeatMaxChars` | `100` | 纯文字复读的长度上限：只复读不超过这么多字的短消息；`0` = 不限 |
| `repeatChance` | `1` | 真要复读时的概率（0~1）：`1` = 每次都跟 |
| `repeatImageTolerance` | `0.08` | 表情包「算是同一张」的宽松度：QQ 会把同一张表情包按发送者重新编码，字节不同时再比一次**画面指纹**，位差不超过这个值就算同一张；`0` = 只认字节完全相同 |
| `proactive` | `true` | 是否让机器人偶尔**主动**在群里说话（不等 @）；默认开，只对已经聊过的群生效，而且要先过「时段 / 安静够久 / 不是自言自语 / 当天没超次数 / 概率」那一串闸（`proactiveIdleMs` 默认 45 分钟），见[偶尔主动说话](proactive.md#偶尔主动说话proactive)。不想让它开话头就设 `false` |
| `proactiveCheckMs` | `600000` | 每隔多久看一次「有没有群值得搭句话」（毫秒）：这是考虑的节奏，不是说话频率 |
| `proactiveChance` | `0.35` | 每次检查时真的开口的概率（0~1）；`0` = 永不主动说话 |
| `proactiveIdleMs` | `2700000` | 群里安静至少这么久才考虑搭话（毫秒）：正在聊的群不插嘴 |
| `proactiveFreshMs` | `86400000` | 群最近这么久之内有人说过话才值得搭话（毫秒）；`0` = 不限制 |
| `proactiveGapMs` | `7200000` | 同一个群两次主动说话之间至少隔这么久（毫秒） |
| `proactiveDailyMax` | `4` | 同一个群一天最多主动说几次（本地日界线；重启后计数清零） |
| `proactiveFromHour` / `proactiveToHour` | `9` / `23` | 只在这个本地时段内主动说话（左闭右开，跨零点也认，两边相同 = 全天） |
| `activeWindowMs` | `60000` | 「活跃对话」窗口：管它回完之后多久之内可能**补一句**，以及多人搭话的热度（最近这么久里够条数、够人数就算聊热了）；`0` = 整套关闭。一对一的免 @ 接话不看它，那是 `activeFollowIdleMs`。见[聊起来之后保持搭话](proactive.md#聊起来之后保持搭话活跃对话) |
| `activeFollow` | `true` | 活跃对话里**免 @ 接话**：被叫到之后，跟它聊的那个人接着说的话不用再 @，而且**每条都回**（A 路不抽卡）；群里聊热了还会进入**多人搭话**（那一路才按 `activeTalkChance` 抽卡）。默认开 —— 它放松了「群里只在被 @ 时才说话」这条约定；不想让它接闲聊就设 `false`（多人搭话也跟着关） |
| `activeFollowIdleMs` | `180000` | 免 @ 接话的**断聊间隔**：同一个人两条消息之间超过这么久，这段一对一就算结束，要重新 @ 它；只管一对一（补一句与多人搭话热度仍看 `activeWindowMs`）；`0` = 关掉一对一的免 @ 接话 |
| `activeMaxTurns` | `10` | 一次一对一的活跃对话里最多免 @ 回几条，够这么多条要重新 @ 它；多人搭话不看这个；`0` = 不限 |
| `activeTalkChance` | `0.05` | **多人搭话**的起始概率（0~1，抽卡那套）：够资格之后先掷这个概率，没抽中就把下一次的概率加上 `activeTalkChanceStep`；掷中或被明确 @ 到之后归零。一对一的免 @ 接话不抽卡 |
| `activeTalkChanceStep` | `0.1` | 多人搭话里，每多一条**没抽中**的消息，搭话概率增加多少（0~1），直到 `activeTalkChanceMax` 封顶 |
| `activeTalkChanceMax` | `0.8` | 多人搭话概率的上限（0~1）：攒到这么多就不再涨，留一点不确定性，免得在热群里变成每条都回 |
| `activeGroupLines` | `6` | 多人搭话的进入门槛：最近 `activeWindowMs` 里群里（除它以外）累计说了这么多条话（进入之后仍按 `activeTalkChance` 抽卡决定接哪句）；`0` = 关掉多人搭话 |
| `activeGroupSpeakers` | `2` | 多人搭话还要求最近窗口里至少有这么多**不同的人**说过话（一个人刷屏不算） |
| `activeGroupBatchScale` | `2` | 搭话状态里的「倾听时间」倍数：攒批窗口与整批上限一起放大，多听几句再合成一轮回复；`1` = 不放大 |
| `activeChimeIdleMs` | `20000` | 它回完话、对方安静这么久之后可能自己再补一句（毫秒，按 `delayJitter` 抖动）；`0` = 不补；需要 `proactive: true` |
| `activeChimeMax` | `1` | 对方每说一句之后最多自己补几句；`0` = 不补 |
| `activeChimeDailyMax` | `12` | 同一个会话一天最多自己补几句（与 `proactiveDailyMax` 分开算）；`0` = 不限 |
| `reminder` | `true` | 是否启用定时提醒（`qq_remind_create` / `qq_remind_list` / `qq_remind_cancel`）：到点由插件发消息，不依赖模型醒着；关掉后三个工具不注册、已有任务留在文件里不丢，见[定时提醒](reminders.md) |
| `reminderFile` | `data/reminders.json` | 提醒任务文件，相对 `cwd`；必须落在 `cwd` 内，否则整个功能记 warn 并停用 |
| `reminderUsers` | `[]` | 允许创建提醒的 QQ 号白名单；留空 = 不限制（与 `allowUsers` 同语义）。名单里的人额外视为**受信者**：可以 @ 别人、指定别的会话、建 prompt 模式 |
| `reminderMentionOthers` | `false` | 是否允许普通群友的提醒 @ 创建者以外的人；默认关（定时 @ 人比即时 @ 更敏感）。受信者不受这一项限制 |
| `reminderAllowAll` | `false` | 是否允许 `@全体成员`；默认关，且只有受信者（`reminderUsers` 里的人或 Web 操作员）能用 |
| `reminderDailyMax` | `5` | 同一个人一天最多新建几条提醒（本地日界线，按任务文件里今天的记录算，重启不清零）；`0` = 不限；Web 操作员不受限 |
| `reminderMaxActive` | `20` | 同一个会话最多同时有多少条待发提醒；满了就拒绝新建，直到发掉或取消 |
| `reminderGraceMs` | `600000` | 补发窗口：进程重启 / 断线错过时刻后，超过这么久就不再补发，只把任务标成 `missed` |
| `reminderModes` | `agent` | 允许的最高模式：`text` 只发固定文案（最可靠、不花 token）/ `agent` 让模型用自己的语气说（失败、超时、SKIP 都退回固定文案）/ `prompt` 到点按指令做事（可调工具，默认关闭，只给受信者） |
| `reminderAgentTimeoutMs` | `120000` | agent/prompt 模式的硬超时：超过这么久模型还没给出可发送的正文，就发固定文案（prompt 模式没有兜底文案且允许跳过时丢弃），迟到的回复不再发送 |
| `reminderAgentDailyMax` | `20` | 同一个会话一天最多跑几次 Agent 提醒；超过之后新的 agent/prompt 提醒自动退回固定文案；`0` = 不限；`text` 不计入 |
| `humanize` | `true` | 自动回复是否拆成几条短消息 + 加打字延迟；`false` = 一条整段发出 |
| `burstMaxChars` | `60` | 把一行长句拆开时的单条目标长度；`0` = 不按长度拆（换行仍然分条） |
| `burstMaxParts` | `3` | 单行长句最多拆成几条；超出部分并进该行最后一条 |
| `burstMaxMessages` | `0` | 一轮回复最多发几条消息（换行分出来的也算）：`1` = 永远只发一条，全并进这一条；`0` = 不限（默认）。这是唯一保留的条数上限，默认关着 —— 关着时模型写几条就发几条 |
| `burstSingleMaxChars` | `100` | **聊天型 / 信息型的门槛**（去掉空白算）：不超过它就按聊天型处理 —— 发送途中对方又说话了，剩下的气泡不再发；超过就按信息型完整发完。`0` = 全部按聊天型。条数本身不设上限 |
| `privateTyping` | `true` | 私聊里显示「对方正在输入」：从它开始准备回复（模型思考那几秒也算）到消息真正发出去，对方的 QQ 上一直显示「正在输入」（每 4 秒续一次）。需要协议端支持 `set_input_status`（NapCat 支持）；不支持时只记一条 warn 并停用，不影响消息本身。群聊不显示 |
| `readDelayMs` | `800` | 发出第一条前的「读消息」基础延迟（毫秒） |
| `charsPerSecond` | `15` | 模拟打字速度（字符/秒），用来按字数算延迟 |
| `minDelayMs` / `maxDelayMs` | `300` / `5000` | 单条消息前延迟的上下限（毫秒） |
| `delayJitter` | `0.4` | 延迟的随机抖动比例（0 = 固定延迟） |
| `replyStyle` | `auto` | 群聊回复的指向：`auto` 只在中途又出现消息（包括机器人自己发的那几条）时引用 / `quote` 引用被回复的那条 / `at` @ 对方 / `plain` 直接发；只挂在第一条上。被回复的那条**本身只有表情时不引用**（引用块会把那张图再贴一遍），`at` 不受影响。**搭话轮（活跃窗口里免 @ 接上的那句、群里聊热后的多人插话）不挂任何指向**，配成 `quote` / `at` 也一样 —— 那一轮不是在回某一条 |
| `persona` | `''` | **旧人设（回退用）**：整段替换内置的「群友口吻」段落（可以写多行）；空 = 用内置的那份。设置页里它在「人格」tab 的「人格与提示词（PERSONA.md 优先）」区块里、折进「兼容」、用多行框改，排在人设文件那几个参数**后面** —— 只要 `personaFile` 指向的文件存在且能解析，这一项就不生效 |
| `instructions` | `''` | 额外要求：可以写多行，追加到 QQ 会话系统提示末尾；与内置口吻叠加，不替换任何东西 |
| `personaFile` | `.qq-persona/PERSONA.md` | 人设文件（相对 `cwd`，必须落在 `cwd` 内）：身份 / 背景 / 性格（底色 + 点缀）/ 场景，见[人格与表达](persona-style.md#人格与表达personamd--stylemd)。留空或文件不存在 = 用 `persona`，再没有就用内置 |
| `personaMaxChars` | `4000` | 人设文件最多读多少字符；超出截断并记 warn |
| `personaSceneOverlays` | `true` | 是否按场景叠加人设里的「私聊 / 群聊 / 主动搭话 / 被戳一戳」四段；`false` = 四场景共用一套（排查用） |
| `styleFile` | `.qq-persona/STYLE.md` | 表达规则文件（相对 `cwd`）：气泡、标点、表情、私聊 / 群聊的散文；留空/不存在 = 只用内置契约 |
| `styleMaxChars` | `2000` | 表达规则文件最多读多少字符 |
| `stripShortPeriod` | `true` | 短气泡句末的「。」是否在发送前剥掉；只动句末唯一的一个「。」，不碰「！？…～」、不碰句中、不碰长气泡 |
| `shortPeriodMaxChars` | `40` | 「短气泡」的字数门槛（去掉空白算） |
| `privateAfterthought` | `true` | 私聊补一句：回完对方、对方安静一小会儿后，最多再开一轮看还有没有想补充的（可 SKIP）。**不搭 `proactive` 那趟车**，见[私聊补一句](proactive.md#私聊补一句l2默认开) |
| `privateAfterthoughtChance` | `0.3` | 私聊补一句的概率 |
| `privateAfterthoughtIdleMs` | `15000` | 对方安静多久之后才考虑补一句（毫秒，按 `delayJitter` 抖动） |
| `privateAfterthoughtDailyMax` | `10` | 同一个私聊一天最多补几句（本地日界线） |
| `recallMode` | `ignore` | 有人撤回消息时怎么办：`off` 只做安全层（清掉指向它的引用 + 记忆里留标记）/ `ignore` 假装没看到（没 @ 它的不再投给模型，被 @ 的照常答）/ `tease` 多一种反应（被 @ 的改写成调侃、已回过的补一句），见[被撤回的消息](recall.md#被撤回的消息recallmode)。**「别引用一条已经不在的消息」永远生效，不受这一项影响** |
| `recallAddressed` | `drop` | 被 @ 的那条还没投出去就被撤回时还回不回：`drop` = 从待回批次里摘掉，**真的不回**（默认，「撤回 = 当没收到」）/ `answer` = 照常答、只是不引用（`tease` 时这一轮改成调侃） |
| `recallScope` | `to-me` | `tease` 时调侃谁：`to-me` 只调侃冲它来的、或它已经回过的 / `all` 群里别人撤回的闲聊也调侃一句（等于承认它每条都看，用法接近 `proactive`） |
| `recallChance` | `0.5` | `tease` 时补一句的概率（0~1）：够资格不等于一定开口 |
| `recallCooldownMs` | `60000` | 同一个会话两次撤回调侃之间至少隔多久（毫秒）：群里「撤回测试」是常见行为，没有这道闸会被刷成复读机 |
| `recallDailyMax` | `5` | 同一个会话一天最多为撤回补几句（本地日界线，内存计数）；`0` = 不限 |
| `recallMaxAgeMs` | `120000` | 消息发出后多久之内撤回才值得提（毫秒）：太久的撤回接一句只像复读机；`0` = 不限 |
| `recallTeaseQuote` | `false` | 调侃时要不要把被撤回的原文交给模型：默认不要（复述别人撤掉的话是最常见的社交事故） |
| `recallPrivate` | `true` | 私聊撤回（`friend_recall`）要不要处理：默认处理（还没投给模型的那条就不回）。关掉 = 私聊里的撤回当没发生（照常回答、只是不引用）；`recallMode: tease` 时建议关掉（私聊里调侃「你撤什么」很容易变成冒犯） |
| `recallMemoryMark` | `true` | 被撤回的消息是否在长期记忆（转录）里追加一行「已撤回」：摘要时不会把它当成事实；`false` = 彻底假装没看到 |
| `memory` | `true` | 是否启用长期记忆（聊天记录落盘 + 定时摘要 + 认知库 + 两个记忆工具 + `.dsh/skills` 里的 `message-digest` / `update-cognition` skill） |
| `memoryDir` | `.qq-memory` | 长期记忆目录，相对 `cwd`；必须落在 `cwd` 内，否则整个功能记 warn 并停用 |
| `memoryFileMaxBytes` | `32768` | 单个记忆文件的字节上限：整份 `write` 超了会报错；热层超过 `memoryArchiveRatio` 时由滚档把最不活跃的条目挪进 `archive/`（不再靠删条目） |
| `memoryPromptChars` | `6000` | 每轮注入提示词的记忆预算（字符）：按当前消息检索后按节配额打包；低于 200 按 200、非法值退回 6000 |
| `memoryRecallK` | `12` | 每轮最多取多少条检索结果（人物与消息里原样出现的梗是必进的，不占这个名额的硬上限） |
| `memoryPeopleMax` | `20` | 每轮最多注入多少个人物（`PEOPLE.md`）；`0` = 不注入人物 |
| `memoryArchive` | `true` | 是否启用冷层归档：热层超阈值时把最不活跃的非置顶条目挪进 `archive/YYYY-MM.md`，`qq_memory search` 仍然搜得到 |
| `memoryArchiveRatio` | `0.75` | 热层占 `memoryFileMaxBytes` 的比例，超过就滚档（夹在 0.1~1） |
| `memoryVocabHint` | `true` | 是否在提示词里附一行「全部梗的写法」词汇表（不给含义，只让模型知道这些写法存在） |
| `memorySearchHits` | `40` | `qq_memory` / `qq_transcript` 一次 search 最多返回多少条命中（搜会话 `MEMORY.md` 时包含 `archive/`） |
| `digestAtHour` | `4` | 每天几点做摘要（本地时间，0~23）：默认凌晨 4 点，群里没人说话的时候 |
| `digestMinLines` | `20` | 当天至少攒够多少条新消息才值得跑一次摘要；不够就留到明天 |
| `digestMaxChars` | `24000` | 一次摘要最多喂给摘要 Agent 多少字符（超出按最近优先截断） |
| `digestTimeoutMs` | `600000` | 单次摘要的硬超时；卡住的摘要 Agent 会被销毁，下次重开 |
| `digestCatchUp` | `true` | 错过摘要点（那一刻进程在重启、或会话是之后才有人说话的）时，一开口就补一次，不用等到明天 |
| `digestRollover` | `true` | 摘要成功之后是否执行滚档（先写 `archive/`，成功才改热层；写失败时热层原样不动） |
| `digestConsolidate` | `false` | 摘要之后再跑一次「周合并」：合并重复事实、刷新人物 one-liner、清过期计划（多一次模型调用） |
| `apiKeyRotate` | `true` | 每天在 `apiKeyRotateHour` 点尝试把 `apiKeyRef` 指向的模型凭据换成 `apiKeyFile` 里的下一个 key；池子文件不存在 / 只有一个 key 时什么都不做，见[每天轮换 API key](ops.md#每天轮换-api-keyapikeyrotate) |
| `apiKeyRotateHour` | `4` | 每天几点尝试轮换模型凭据（本地时间，0~23）：默认凌晨 4 点，与摘要同一个时刻 |
| `apiKeyFile` | `data/api-keys.txt` | 候选 API key 池：一行一个 key，`#` 开头的行是注释；相对 `cwd`，必须落在 `cwd` 内，否则整个轮换记 warn 并停用 |
| `apiKeyRef` | `DEEPSEEK_API_KEY` | 要轮换的凭据引用名，也就是 `$DSH_HOME/.credentials.yaml` 里的那个 ref |
| `apiKeyProbeUrl` | `https://api.deepseek.com/models` | 切换前 GET 一下候选 key 能不能用（2xx 才算能用，不消耗 token）；留空 = 不探测、按池子顺序直接换 |
| `apiKeyProbeTimeoutMs` | `15000` | 探测单个候选 key 的超时；网络不通按「这个候选不可用」处理，继续试下一个 |
