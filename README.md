# @qqbot/dsh-plugin-qq — QQ ↔ DSH 桥接插件

把 QQ（通过 OneBot v11，如 NapCat / Lagrange / go-cqhttp）接到 DeepSeek Harness：

- **入站**：QQ 私聊或群里 @机器人 的消息 → 交给一个专属的 DSH Agent 会话处理 → 处理结果自动发回 QQ。
- **出站**：任何 DSH Agent（包括你在 Web UI 里的主会话）都能调用工具主动发 QQ 消息。
- **表情包**：它真的会发表情包 —— 自己在群里聊天时可以挑一张甩出来，也能把别人刚发的那张原样发回去；**整条回复只写一行标记，就只发一张表情、一个字都不说**。见[它也能发表情包](#它也能发表情包)。
- **禁漫下载**：QQ 里发 `/jm 422866`（或让 Agent 调 `qq_jm_pdf`）→ 下载整本、合并成
  一个 PDF、直接把文件发回会话。见[禁漫（JM）下载](#禁漫jm下载车号--pdf--发到-qq)。

## 工作原理

```
QQ 客户端 ──▶ NapCat ──(OneBot v11 WebSocket)──▶ 本插件
                                                    │
                                    每个会话映射一个 DSH Session
                                                    │
                                    Agent 产出最终回复 ──▶ 发回 QQ
```

- 一个 QQ 会话（一个私聊对象 / 一个群）= 一个持久化 Session。
- Session id 由会话 key 经 SHA-256 派生，是**确定性**的：Harness 重启后
  同一个人再发消息，插件会 `resume` 原有会话，聊天记忆不会丢。
- Agent 的回复取该 turn 里**最后一条有文本的 assistant 消息**；中间步骤的
  工具调用不会发给 QQ。
- 群消息默认只在被 @ 时触发。
- 前后脚到的消息先攒一个窗口（`batchWindowMs`，默认 1.2 秒）再投给 Agent：
  群里几个人同时 @，它一轮里一起接住，而不是一条一条地分别答复每个人 —— 见
  [像真实群友一样说话](#像真实群友一样说话)。
- 回复会拆成几条短消息、按打字节奏发出，并引用被回复的那条 —— 见
  [像真实群友一样说话](#像真实群友一样说话)。换行就是分条：模型写几行就发几条，
  不会把几行挤在同一条消息里；指向（引用 / @）只挂在第一条上。

## 配置项

在 `cordis.patch.yml` 的 `config:` 下配置，也可以在 Web UI 的插件设置里改。

| 字段 | 默认 | 说明 |
|---|---|---|
| `endpoint` | `ws://127.0.0.1:3001` | OneBot v11 正向 WebSocket 地址 |
| `accessToken` | `''` | OneBot access_token，未设置则留空 |
| `cwd` | 进程当前目录 | QQ 会话 Agent 的工作目录（也是沙箱根） |
| `privateChat` | `true` | 是否响应私聊 |
| `groupChat` | `true` | 是否响应群消息 |
| `groupTrigger` | `mention` | 群消息触发：`mention` / `prefix` / `all` |
| `prefix` | `/` | `groupTrigger=prefix` 时的前缀 |
| `allowUsers` | `[]` | 私聊白名单；空 = 不限制 |
| `allowGroups` | `[]` | 群白名单；空 = 不限制 |
| `agentPreset` | `''` | QQ 会话 Agent 挂载的 Agent 预设 id；空 = 用部署的默认预设，`none` = 不挂预设（本 bundle 自带的是 `qq`） |
| `provider` / `model` | `''` | QQ 会话使用的模型；空 = 用默认 |
| `approvalPolicy` | `never` | `never` = 无人值守时一律拒绝需要审批的操作 |
| `allowTools` | `[]` | QQ 会话可用的工具白名单；空 = 不限制 |
| `resetCommand` | `/reset` | 清空当前会话记忆的指令；空 = 禁用 |
| `maxReplyChars` | `1500` | 单条 QQ 消息最大字符数（协议上限），超出自动分段 |
| `mediaDownload` | `true` | 是否把消息里的图片/表情包下载到本地（模型只能读本地文件，不下载就只看到占位符） |
| `mediaDir` | `.qq-media` | 媒体缓存目录，相对 `cwd`；必须落在 `cwd` 内，否则自动停用下载 |
| `mediaMaxBytes` | `8388608` | 单张图的字节上限，超过就不下载（只留占位符） |
| `mediaCacheFiles` | `200` | 缓存最多保留几个文件，按最近使用时间淘汰最旧的 |
| `mediaTimeoutMs` | `15000` | 单张图的下载超时（毫秒） |
| `quoteMedia` | `true` | 是否把「被引用（回复）的那条消息」也取回来：引用里的图和正文都会进正文，见[引用消息](#被引用的那条消息也能看见) |
| `ambientMedia` | `true` | 群聊环境上下文（没 @ 机器人的那几条）里的图是否也落盘；`false` = 只留占位符，不为闲聊花带宽和磁盘 |
| `imageSend` | `true` | 是否允许 Agent **主动发图/表情包**：`qq_send_image` 工具 + 回复正文里的 `[[图片: …]]` 标记（只发表情就靠它）；`false` = 两个都关，提示词里也不再提 |
| `stickerDir` | `.qq-stickers` | 给它的表情包目录，相对 `cwd`（必须落在 `cwd` 内）：文件名会列进渠道提示，模型据此往标记/工具里写路径；留空 = 不提示这个目录 |
| `imageMaxBytes` | `8388608` | 单张出站图片的字节上限（8MB）：超过直接报错，不做静默压缩 |
| `batchWindowMs` | `1200` | 收到要回的消息后先等这么久（毫秒）看还有没有下一条：几个人同时 @ / 一个人连发几句会攒成一条消息只回一轮；`0` = 关闭攒批 |
| `batchMaxWaitMs` | `5000` | 一直有人接着说时，一批最多以第一条为起点攒这么久（毫秒）就发出去 |
| `ambientMessages` | `12` | 群聊里注入给 Agent 的最近消息条数；`0` = 关闭 |
| `ambientLineChars` | `120` | 群聊上下文里每条消息最多保留的字符数 |
| `humanize` | `true` | 自动回复是否拆成几条短消息 + 加打字延迟；`false` = 一条整段发出 |
| `burstMaxChars` | `60` | 把一行长句拆开时的单条目标长度；`0` = 不按长度拆（换行仍然分条） |
| `burstMaxParts` | `3` | 单行长句最多拆成几条；超出部分并进该行最后一条 |
| `readDelayMs` | `800` | 发出第一条前的「读消息」基础延迟（毫秒） |
| `charsPerSecond` | `15` | 模拟打字速度（字符/秒），用来按字数算延迟 |
| `minDelayMs` / `maxDelayMs` | `300` / `5000` | 单条消息前延迟的上下限（毫秒） |
| `delayJitter` | `0.4` | 延迟的随机抖动比例（0 = 固定延迟） |
| `replyStyle` | `auto` | 群聊回复的指向：`auto` 只在中途有人插话时引用 / `quote` 引用被回复的那条 / `at` @ 对方 / `plain` 直接发；只挂在第一条上 |
| `persona` | `''` | 替换内置的「群友口吻」段落；空 = 用内置的那份 |
| `instructions` | `''` | 追加到 QQ 会话系统提示的额外要求 |
| `jm*` | 见下文 | 禁漫（JM）下载 → PDF → 发到 QQ 的一组开关，单独一张表：见[禁漫下载](#禁漫jm下载车号--pdf--发到-qq) |

## 像真实群友一样说话

默认配置下，QQ 会话的自动回复会刻意模仿真人在群里聊天的样子。五件事：

**1. 几个人同时 @ 它，它只接一轮（`batchWindowMs`）**

群聊里最扎眼的「人机感」是：三个人几乎同时 @ 机器人，机器人就一条一条地分别答复三个人。
根子在 Harness 的收件箱 —— `next-turn` 每次只认领**一条**消息，也就是「一条消息 = 一轮 =
一条回复」，逐条投递必然逐条回复。

所以插件在投递前先攒一下：收到一条要回的消息后，先等 `batchWindowMs`（默认 1200 毫秒）
看还有没有下一条。窗口内到的消息会攒成**一条** user message，每行标出是谁说的，
并在开头交代一句来由：

```
（下面 3 条是几乎同时到的，kaguya、iroha、mutsumi 都在跟你说话）
kaguya: 你俩在吗
iroha: 帮我看看这个
mutsumi: 我也想问
```

于是一轮里模型就同时看到三个人的话，回一条、把该接的接住；「QQ 渠道」小节里的
「几乎同时在跟你说话的是：…」也会把这几个人都列出来。要点：

- **只有一条消息时完全按原样投递**：不加表头、行为与以前一模一样。
- 窗口从**最后一条**往后算（还有人接着说就再等一个窗口），但整批以第一条到达时刻为起点
  卡一个上限 `batchMaxWaitMs`（默认 5 秒）—— 否则群里你一句我一句地 @ 下去，
  机器人会永远不吭声。
- 一批都是**同一个人连着发的**时，回复仍然指向他最后那条；一批里**有好几个人**时
  不挂任何指向 —— 引用谁的截图都像是只在回他。
- 私聊同样适用：一个人连发几句，本来也常常是同一个意思。
- `/reset` 会先把攒着的那批投出去再清空（那些话是清空前说的）；`/jm` 这类旁路同理。
- `batchWindowMs: 0` 关掉攒批，回到「来一条回一条」。

**2. 它看得到群里在聊什么（`ambientMessages`）**

只有**被 @ 的那几句**会作为 user message 送进会话（前后脚到的会攒成一条，见上一条）；
其余群消息进一个每群独立的环形缓冲
（`{昵称: 内容}`，最多 `ambientMessages` 条），在每次提示词装配时渲染进「QQ 渠道」小节：

```
群里最近的消息（旧 → 新；都不是发给你的，只是让你知道大家在聊什么，不必逐条回应）：
  kaguya: 晚上吃啥
  iroha: 随便啊，你们定
  kaguya: [图片]
```

这样模型是「读着聊天记录回话」，而不是每句都像客服首问。要点：

- 缓冲在**内存**里（进程重启即空），且不会因为一条没人 @ 的消息就凭空建出会话。
- 只对**允许的群**记账（`allowGroups` / `groupChat` 同样适用），机器人自己的消息不进缓冲。
- 被 @ 的那条不进缓冲 —— 否则同一句话在 user message 和上下文里各出现一次。
- `/reset` 会连带清掉该群的上下文缓冲。

**3. 它分开几条、按打字节奏发（`humanize` / `burst*` / `*Delay*`）**

一条 1500 字的回复糊在群里是最不像人的地方。开启 `humanize` 后，回复会拆成
**一条条独立的消息**（不是一条消息里换行），每条发出前等一段「打字时间」：

```
第 1 条前：readDelayMs + 本条字数 / charsPerSecond
其余每条：本条字数 / charsPerSecond
每次延迟再上下浮动 delayJitter，并夹在 [minDelayMs, maxDelayMs] 内
```

拆分的规则是两层：

- **换行 = 分条**。模型写了几行，就发几条 —— 一行一条独立消息，正文里不会留下换行。
  系统提示因此告诉模型「想连说几句就直接换行，每一行都会单独发出去」，同时提醒它别用
  换行给一段话排版（那会变成连着刷好几条）。
- **一行太长才自动拆**。单行超过 `burstMaxChars`（默认 60 字，差不多一两句话）时，
  按句末标点 → 句内标点 → 硬切的顺序断句，单行最多拆 `burstMaxParts` 条（默认 3），
  超出的余量并进该行的最后一条。`burstMaxChars: 0` 只关掉这一层，换行照样分条。
  正文里的 `[[图片: …]]` 标记也占一条 —— 只不过它那条发出去的是一张图，见
  [只发表情、一个字都不说](#只发表情一个字都不说)。

默认（60 字上限、15 字/秒、读消息 0.8s）大概是「三句话、六七秒发完」。想让它秒回就调小
这几个值，或者直接 `humanize: false` 回到旧行为（一条整段直接发出，只在超过
`maxReplyChars` 时分段）。

- 每条都还会按 `maxReplyChars` 做一次硬校验 —— 模型偶尔写超长时仍然不会突破协议上限。
- 同一会话的发送是**串行**的：延迟让一次回复持续好几秒，不排队的话下一轮会插进来，
  群里看到的就是两条消息交错。
- `qq_send_message` 工具**不做**拟人处理：那是 Agent 的显式动作（「就发这段」），
  只按协议上限分段。

**4. 口吻是「普通群友」（`persona` / `instructions`）**

「QQ 渠道」小节现在明确它**是群里的一个普通群友，不是客服**，并给了可执行的约束：
短、口语、可以吐槽/接梗/敷衍/只回两个字，不要列点、不要总结、不要 Markdown
（QQ 根本不渲染）、不要自称 AI。`persona` 非空时整段替换这份口吻描述；
格式与身份那几条红线始终保留，`instructions` 仍然是追加。

**5. 回复有指向（`replyStyle`）**

群里人一多，裸文本看不出在回谁。默认的 `auto` 只在**需要点名**时才挂指向：入站时记下这条消息
在群里的进度，真要发出去时再看一眼 —— 中间又有人插话，回复的第一条就带 `reply` 段引用被回复的
那条消息；紧挨着回的（没人插话）保持纯文本，不刷引用块。`quote` 是引用被回复的那条消息，`at` 改成 @ 回
提问者，`plain` 一律纯文本。指向只挂在**第一条**上 —— 一次回复拆成好几条时，只有第一条带引用，
后面的都是裸文本（真人也不会每条都 @ 一遍，引用刷屏更烦）。私聊始终是 `plain`。

> 上面这些提示词都是**函数**而不是字符串：`SystemPrompt.section()` 每次装配都会重新求值，
> 所以群里换了个人说话、或者中间又聊了几句，模型下一轮看到的就是最新的。
> （旧版把文本算成字符串，建 Agent 那一刻就定死了，「当前发言者」会永远停在第一个人；
> 同时入站事件会把已查到的群名冲成空串 —— 这两个 bug 一并修掉了。）

## 图片与表情包：它能真的「看」图

QQ 那边发来的图，在 OneBot 里只是一个**会过期的下载链接**：NapCat 上报的 `image` 段长这样

```json
{"type":"image","data":{
  "summary":"[动画表情]",
  "file":"695E1A06A7D44ECF81DE064CCF51674E.jpg",
  "sub_type":1,
  "url":"https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=…&rkey=…",
  "file_size":"11279"}}
```

而模型要「看见」图只能靠 `read_image` 读**本地文件**。所以插件在消息入队前多了一步：
取字节 → 按魔数认出真正的格式 → 以内容哈希命名落进 `mediaDir` → 把路径写进正文。

```
QQ: [一张表情包] 你看这个
        ↓
Agent 收到的正文： [图片(动画表情): .qq-media/6ab290670daf12d2688c6364efca45d5.jpg] 你看这个
        ↓
Agent 调 read_image(".qq-media/6ab290670daf12d2688c6364efca45d5.jpg") —— 真的看到了
```

几个要点：

- **为什么必须马上下载**：那个 `rkey` 是有时效的签名，过一会儿同一个 URL 就 403 了。
  发给机器人的那条在消息入队时下载（同一会话串行，所以顺序是「先落盘、再交给模型」，
  被引用的那条也一样）；群里闲聊的那条则在后台下载，不挡任何人的消息。
  抓不动时还有一层兜底：把 `file` 段丢回 OneBot 的 **`get_image`**，让它把图（可能以
  base64 形式）给我们。
- **`mediaDir` 下的文件**按内容哈希命名、扩展名来自**字节里的魔数**（腾讯的链接根本不带
  扩展名）。同一张表情包被反复发只会存一份；超过 `mediaCacheFiles` 就按最近使用时间淘汰
  最旧的；单个文件超过 `mediaMaxBytes` 连请求都不发。`mediaDir` 必须在 `cwd` 里 ——
  写到工作区外面 Agent 反而读不到，所以这种情况下插件会整体停用下载并打一条 warn。
- **正文里可能出现三种形态**，含义不同：
  - `[图片(动画表情): .qq-media/…jpg]` —— 已落盘，路径相对 `cwd`，可以直接 `read_image`；
  - `[图片(动画表情) 没能取到文件: HTTP 403]` —— 抓失败了（rkey 过期、CDN 抽风），别去读
    一个不存在的路径，可以直说图挂了；
  - `[图片(动画表情)]` —— 没有本地路径的纯占位符：下载整体关掉（`mediaDownload: false`）、
    闲聊里的图还没在后台落完（`ambientMedia`）、或者这张连字节都没认出来时会是这样。
- **群聊环境上下文里的图也下载**（`ambientMessages` 那一段，`ambientMedia: true` 默认）。
  「别人刚才发的那张表情包」是最常被接着问的东西，所以闲聊里的图也会落盘，只是下载在
  后台进行：等提示词渲染时那一行已经变成 `kaguya: [图片(动画表情): .qq-media/…jpg]`。
  同一张表情包按内容哈希去重，磁盘只存一份；但每次发出来仍会重新下载一遍字节 ——
  腾讯的下载链接每次都带新的 `rkey`，没法只靠 URL 判断「这张我见过」。
  不想为闲聊花带宽就设 `ambientMedia: false`，那时上下文里只有 `kaguya: [图片(动画表情)]`。

### 被引用的那条消息也能看见

QQ 的「引用回复」在 OneBot 里只有一个 `reply` 段，里面**只有被引用消息的 id** ——
没有正文、没有图。所以「引用一张表情包再 @ 它问这是啥」这种最常见的用法，光看入站事件
是什么也看不到的。插件因此在入队时多取一趟：

```
QQ: [引用 kaguya 的表情包] @bot 这啥
      ↓  reply 段只有一个 message_id → get_msg
Agent 收到的正文：（引用 kaguya: [图片(动画表情): .qq-media/6ab290670daf12d2688c6364efca45d5.jpg]）
              这啥
      ↓
Agent 调 read_image(".qq-media/6ab290670daf12d2688c6364efca45d5.jpg")
```

- 引用的**正文**也会带进来（最多 200 字，够当锚点又不挤上下文）；引用段本身那个
  `[回复]` 占位符会被替换掉，不会出现「一半有内容、一半是噪音」的正文。
- `get_msg` 拿不到时（实现不支持、消息已撤回、网络抖动）只记一条 warn，正文里保留
  `[回复]`，消息照常投递 —— 引用只是锦上添花，不该拖垮聊天。
- 只取**一层**：被引用的那条自己再引用别的东西，不会跟着递归下去。
- 关掉：`quoteMedia: false`（回到「引用段就是一句 `[回复]`」，一次 `get_msg` 都不发）。
- 合并转发（`forward`）不吃这一套，仍是 `[合并转发]`。

### 商城表情 / 系统表情 / CQ 码，各是什么下场

| QQ 里的东西 | OneBot 上报成 | 插件怎么处理 |
|---|---|---|
| 普通图片、图片表情包（含动图） | `image`（带 `url`） | 下载 + 落盘，模型能看 |
| 商城表情 / 收藏表情包 | **NapCat 上报成 `image`**（带腾讯 CDN 的 `url` 和表情名 `summary`） | 同上；表情名会进占位符的括号里 |
| 商城表情（其它实现，如 Lagrange / go-cqhttp） | `mface`：只有 `emoji_id` + `summary`，没有可下载的 URL | 只渲染 `[表情包(表情名)]`，不下图 |
| QQ 系统小表情 | `face`：只有数字 id | 仍是 `[表情]` —— 这个段里没有图、也没有语义表，要「读懂」得配一张 id→含义的表，属于另一件事 |
| 引用回复 | `reply`：只有被引用消息的 `message_id` | 多调一次 `get_msg` 把被引用的那条取回来：正文与图都进正文，见[被引用的那条消息也能看见](#被引用的那条消息也能看见) |

> 上面这张表是拿真实 NapCat（`mlikiowa/napcat-docker`）的事件实测出来的，不是照着协议
> 猜的：QQ 的 marketFaceElement 在 NapCat 里会被直接转成 `image` 段并附上
> `https://gxh.vip.qq.com/…` 之外的 `multimedia.nt.qq.com.cn` 下载链接。

### 前提：模型得支持读图，工具得放开

- `read_image` 只有当前模型声明了 **image 输入**才可用（部署默认的 `deepseek-flash`
  声明了 `["text","image"]`）。换成纯文本模型时 `read_image` 会直接报
  `model "…" does not declare image input` —— 那时落盘仍在发生，只是模型读不到，
  它在正文里看到的仍是一句带路径的占位符。
- 部署的附件服务只接受 **PNG / JPEG / WebP / GIF**，所以插件只认这四种（认不出就不落盘）。
- `qq` 预设里有 `tool-fs`（含 `read_image`），`allowTools` 里也放开了它。**如果白名单把
  `read_image` 挡掉**，插件不会再在提示词里推荐它（免得模型去调一个看不见的工具），
  图也就只能停在占位符上。
- 关掉整个功能：`mediaDownload: false`。此时一条网络请求都不会发，正文里只有朴素占位符。

排查用 `/reset` 一样清不掉的东西就是缓存本身（它按内容去重，与某个会话无关）；想手动清：

```bash
rm -rf ~/Projects/qqbot/.qq-media
journalctl --user -u qqbot -f | grep 'qq-bridge: media:'   # 每张图的落盘/失败都会记一行
```

## 它也能发表情包

上面那一大节是「QQ 的图 → 本地文件」，让模型能**看**图；这一节是反方向：让模型能**发**图。

```
模型想接个梗 / 想回一张图
      ↓  回复正文里写一行「表情包标记」：[[图片: .qq-stickers/笑死.gif]]
插件读字节 → 认格式 → 校验大小（只认 PNG/JPEG/WebP/GIF，默认 ≤ 8MB）
      ↓  send_group_msg / send_private_msg 的 image 段：{"type":"image","data":{"file":"base64://…"}}
NapCat 解码 → 上传 → 图出现在 QQ 里
```

### 只发表情、一个字都不说

这是最要紧的一条：**整条回复只写一行 `[[图片: 路径]]`，就只会发出那一张图，一条文字都没有。**

```
模型的回复正文：
[[图片: .qq-stickers/笑死.gif]]
        ↓
群里只多了一张表情包 —— 没有「给你发张表情包」这种话
```

为什么不用工具做这件事：工具调用发生在整轮文字**之前**，而且「不说话」在纯文本回复里
根本表达不出来（模型总得写点什么）。把表情写成正文里的一处标记，位置就跟着正文走：

```
模型的回复正文：                    群里依次看到：
今天真累啊                          今天真累啊
[[图片: .qq-stickers/摸摸头.gif]]   [一张摸头图]
早点睡                              早点睡
```

标记里的路径也可以**只写文件名**（`[[图片: 笑死]]`、`[[图片: 笑死.png]]`）：
在 `.qq-stickers/` 里找得到就用那一张（带不带扩展名都行），找不到才按工作目录的相对路径算。
关键字给几种写法（`图片` / `图片表情` / `表情包` / `表情` / `贴图` / `sticker` / `image` /
`img`），全角冒号也认。**认不出来的方括号一律当普通文字发出去** —— 宁可群里露出一行 `[[音频: x]]`，
也不要静默吞掉模型说的话。发不出去时（路径写错、文件被缓存淘汰）会回一句
「（表情包没发出去）」并记一条 warn：只发表情的那条回复要是静默失败，看起来就是
「机器人没理人」。

### `qq_send_image` 工具（显式动作，可以发给别人）

标记只能作用于「正在回的这条会话」；要给**别的**群/好友发图，或者就是要一个明确的
「把这张图发过去」，用 `qq_send_image` 工具。它接受同样的来源，另外还接受 http(s)
图片链接（插件先在**宿主机**把它下下来，顺便校验格式与大小，而不是让容器里的 NapCat
去够那个链接）。它是立刻发出去的，不跟在正文的行序里。

要点：

- **表情包放哪儿**：`stickerDir`（默认 `.qq-stickers/`，插件启动时会自动建好）。
  往里丢几张图就能用 —— 文件名会列进「QQ 渠道」提示，所以**名字起得有意义**最划算
  （`笑死.gif`、`摸摸头.png`）；名字看不出来的，模型可以先 `read_image` 看一眼再挑。
  目录里超过 40 张时只列前 40 个（按文件名字典序），其余靠它自己 `glob`。
- **别人发的图也能发回去**：入站那张已经落到 `.qq-media/…`、正文里也给了路径，
  把它写进标记（或交给 `qq_send_image`）就是「把这张表情包原样发回去」——
  这是群里最常用的一种接梗方式，零配置可用。
- **权限边界没变**：本地路径只允许 `cwd` 里的文件，而且必须真的是 PNG/JPEG/WebP/GIF
  （按魔数判断，`.txt` 改名成 `.png` 也蒙不过去）—— QQ 那头是不可信输入，没理由为了
  发张图把工作区捅开。标记还**跟着 `allowTools` 走**：白名单里没有 `qq_send_image`
  时，回复里也不能用标记发图（那时它就是一行普通文字）。
- **提示词里已经写了这件事**：模型知道标记怎么写、知道「整条只写这一行就是只发表情」、
  也知道表情包目录里有哪几张、还知道「一次最多一张、别每句都配一张」。想让它更爱发或
  更克制，用 `persona` / `instructions` 补两句就行。
- **关掉**：`imageSend: false` 一次关掉标记与工具（工具调用会明确报错
  `sending images is disabled`，提示词里也不再提标记）；`imageMaxBytes` 调小可以进一步
  限制它能发多大。

### 为什么是 base64，而不是把路径丢给 NapCat

和 PDF 那边（[为什么是「发个 URL 让它自己拉」](#为什么是发个-url-让它自己拉而不是直接把路径给-napcat)）
是同一个现实：NapCat 跑在**容器**里、插件跑在**宿主机**上，容器的文件系统里没有
`.qq-media/xxxx.jpg`。给 `upload_*_file` 传本地路径实测会回 `识别URL失败`（它的
`enableLocalFile2Url` 默认还是关的），image 段里的本地路径同理。

所以这里用 OneBot image 段的 **`base64://`**：字节直接跟在 `file` 字段里发过去，
NapCat 自己解码落进它的临时目录（实测：同样一段 base64 喂给 NapCat 的 `download_file`，
容器里落出来的文件与宿主机的图 md5 完全一致），之后的链路与手动发图一模一样。
好处是不依赖任何「容器能不能连到宿主机」的假设 —— PDF 那边的 URL 方案必须绑在
docker 网桥上，这里不需要；代价是体积膨胀约 4/3，所以有 `imageMaxBytes` 上限。

NapCat 的 WebSocket 服务端 `maxPayload` 实测是 **50MB**，默认 8MB 离它还很远。
真发超大图时唯一的代价是慢：`timeout.uploadSpeedKBps` 默认 256 KB/s，八兆的图要等
半分钟左右，所以默认值刻意压在「表情包 / 截图」的量级。

排查：

```bash
journalctl --user -u qqbot -f | grep 'qq-bridge: →'   # 每张发出去的图都记一行（目标、格式、字节数、来源）
ls -la ~/Projects/qqbot/.qq-stickers       # 表情包目录：丢几张图进去就能用
```

## 禁漫（JM）下载：车号 → PDF → 发到 QQ

在 QQ 里发 `/jm 422866`（`jm 422866` 也行，18comic 的 `album` / `photo` 链接同样认），
机器人把这本下下来、合并成**一个 PDF**、直接把文件发到当前会话：

```
QQ: /jm 422866
      ↓  插件旁路：不建 Agent 会话、不烧 token
   python 子进程（jmcomic）：下载 + 解密打乱 + 合并
      ↓  .qq-jm/《…》.pdf
   本机 HTTP 服务（一次性 URL，只绑 docker 网桥）
      ↓  NapCat 自己来拉这个 URL
   upload_private_file / upload_group_file → 文件出现在 QQ 里
```

也可以不记指令：群里 @ 机器人说「帮我下 jm422866」就行 —— QQ 会话的 Agent 会调
`qq_jm_pdf` 工具，效果一样（它会自己把 PDF 发回**问它的那个会话**）。

### 一次性准备：python 环境

```bash
cd ~/Projects/qqbot
python3 -m venv .venv
.venv/bin/pip install jmcomic img2pdf
```

装完就不用再管了（配置里的 `jmPython` 默认指向 `.venv/bin/python`）。

**为什么用现成的 python 库**：禁漫的移动端接口会做 APP 版本协商（版本落后直接回
`Not legal.api`）、响应体是 AES 加密的、图片还按本子 id **竖切打乱**需要解密，
域名也在 Cloudflare 后面经常换。[jmcomic](https://github.com/hect0x7/JMComic-Crawler-Python)
把这些（以及域名表自动更新）都做好了，自己造一遍只会持续被域名和签名折腾。

### 为什么是「发个 URL 让它自己拉」，而不是直接把路径给 NapCat

NapCat 跑在 **容器** 里、插件跑在 **宿主机** 上，容器里根本没有那个 PDF 文件。
实测把本地路径丢给 `upload_private_file` 会被直接拒掉：

```
{"status":"failed","retcode":1200,"message":"识别URL失败, uri= ~/Projects/qqbot/.qq-jm/x.pdf"}
```

（NapCat 的 `enableLocalFile2Url` 默认还是关的。）所以插件在下完 PDF 之后，会在本机
起一个极小的 HTTP 服务，给它一个**带一次性 token 的 URL**，由 NapCat 自己来取：

```
http://172.17.0.1:41234/f/<32位随机token>/<文件名>.pdf
```

要点：

- 服务**只绑 docker 网桥**（默认 `172.17.0.1`），只有本机与容器够得着；校园网 /
  局域网都访问不到它。绑不上时（比如没有 docker）会退回 `127.0.0.1` 并打一条 warn
  —— 那时容器里的 NapCat 取不到文件，日志里能一眼看到原因。
- URL 只在 `jmUrlTtlMs`（默认 10 分钟）内有效，且 token 是一次性的哈希值，猜不到。
- NapCat 的 `timeout.downloadSpeedKBps` 默认会限速（256 KB/s），所以大文件上传会慢，
  `jmUploadTimeoutMs` 就是给它留的时间。
- 实测（NapCat 4.18.15）：私聊 `upload_private_file`、群 `upload_group_file`
  （`folder: ''`）都能用；群文件需要机器人有上传权限，失败时插件会把原因回给 QQ。

### 整本还是单话

`/jm <车号>` 的判据是**车号指向哪里**，与禁漫自己的结构对齐：

| 你发的 | 会发生什么 |
|---|---|
| 本子 id（`/jm 422866`，它同时是第一话的 id） | 整本：所有话按顺序合并成一个 PDF |
| 某一话的 id（`/jm 498681`，属于本子 400222） | 只下那一话 |
| `/album/422866/` 链接 | 整本 |
| `/photo/498681/` 链接 | 只下那一话 |

判断靠的是 `/chapter?id=X` 给出的 `album_id`：等于 X 说明 X 就是这本本子，否则 X 只是
其中一话。工具参数里的 `kind`（`auto` / `album` / `chapter`）可以显式覆盖。

整本可能大得离谱（有的本子 146 话、几千页），所以留了两个护栏：`jmMaxChapters`
与 `jmMaxPages`（默认 0 = 不限制）。超限时**不会闷头下**，而是回一句
「这本有 146 话，超过上限 20；请指定单话，或调大 jmMaxChapters」。

### 行为细节

- `/jm` 走的是**旁路**：消息不进会话队列、也不会为它建 Agent 会话。整本要下十几分钟，
  排在队列里会把后面所有消息堵死。准入规则照旧（私聊 / 群白名单、群里的 @ 触发），
  `/jm` 带上多余内容（`/jm 422866 谢谢`）也照常识别。
- 同一个会话同时只允许一个下载（第二个会回「还在下上一本，等下」）；不同会话按
  `jmMaxJobs` 排队，默认 1 —— 一起压禁漫只会大家一起慢。
- 进度会说人话：先回「收到，去下 jm422866 了…」，一两秒后拿到本子元信息再回一句
  「找到了：《…》（2 话 · 3 页）」，下完把文件发上来，最后一句「下好了」。
- 失败也是一句话（「没下成：…」/「下好了，但文件发不出去：…」），不会静默，
  也不会把 turn 拖死：下载有硬超时（`jmTimeoutMs`，默认 15 分钟），到点**连子进程组
  一起杀**。
- PDF 落在 `jmDir`（默认 `.qq-jm`，必须在 `cwd` 里，否则整个功能自动停用）；下载用的
  图片是中间产物，下完即删；目录里只保留最近 `jmMaxFiles` 个 PDF（默认 20，按最近使用淘汰）。
- 环境里的 `HTTP_PROXY` / `HTTPS_PROXY` 等会被**显式摘掉**，jmcomic 侧也写了
  `proxies: None`：这台机器直连禁漫，代理设置一旦被 curl 捡走，轻则超时重则触发风控。
- 关掉整个功能：`jmDownload: false`（工具与 `/jm` 都会回一句「没开」，不会假装成功）；
  只想去掉指令就设 `jmCommand: ''`。

排查：

```bash
journalctl --user -u qqbot -f | grep 'qq-bridge: jm'   # 下载开始 / 元信息 / 落盘 / 上传结果
ls -la ~/Projects/qqbot/.qq-jm             # 生成的 PDF
rm -rf ~/Projects/qqbot/.qq-jm             # 手动清
```

### 相关配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `jmDownload` | `true` | 是否启用禁漫下载（关掉后工具与指令都会明说没开） |
| `jmCommand` | `/jm` | QQ 里直接触发的指令；留空 = 只保留 `qq_jm_pdf` 工具 |
| `jmDir` | `.qq-jm` | PDF 目录，相对 `cwd`；必须落在 `cwd` 内 |
| `jmPython` | `.venv/bin/python` | 跑 jmcomic 的解释器 |
| `jmScript` | `''` | 留空 = 用插件自带的 `scripts/jm_download.py` |
| `jmMaxChapters` / `jmMaxPages` | `0` / `0` | 话数 / 页数上限，0 = 不限制 |
| `jmTimeoutMs` | `900000` | 单次下载硬超时（毫秒） |
| `jmRequestTimeoutMs` | `30000` | jmcomic 单次 HTTP 请求超时（毫秒） |
| `jmUploadTimeoutMs` | `600000` | 交给 NapCat 上传的超时（毫秒） |
| `jmMaxFiles` | `20` | PDF 最多保留几个（LRU） |
| `jmMaxJobs` | `1` | 同时进行的下载数 |
| `jmFileHost` / `jmFilePort` | `172.17.0.1` / `0` | 给 NapCat 取文件用的地址与端口（0 = 自动） |
| `jmUrlTtlMs` | `600000` | 一次性下载 URL 的有效期（毫秒） |

## QQ 会话的工具从哪来（`agentPreset`）

在 **Web 表面**（本 profile 用的 `@deepseek-ai/dsh-web-app`）里，`bash` / `read` /
`glob` / `grep` / `web_search` / `web_fetch` 这些「agent 平面」的工具**不在宿主上**：
它们被搬进了每个 Agent 预设，只有 join 了预设的 Agent 才继承得到。直接
`ctx.agents.create()` 出来的 Agent 不 join 任何预设，于是它只有宿主平面的全局工具
——也就是本插件的 `qq_*` 那几个（发消息 / 发图 / 会话列表 / 禁漫）。

所以插件会在 `setup()` 里先给 QQ 会话 Agent 挂一个预设，再施加 `allowTools`。
挂的是 **bundle 自带的 `qq` 预设**（声明在 `cordis.patch.yml`）：

```yaml
agentPreset: qq   # 留空 = 用部署默认预设；none = 不挂
```

`qq` 预设只放四样东西：`tool-fs`（read / read_image / write / edit）、
`tool-fs-search`（glob / grep）、`tool-web`（web_search / web_fetch）、以及压缩
（compaction / tool-result-pruner）。没有 shell、没有子代理、没有 workflow、没有计划模式。

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
- **空 = 不限制**，与 `allowUsers` / `allowGroups` 一致；填了才生效。
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

## 清空会话（`/reset`）

在 QQ 里**单独发送** `resetCommand`（默认 `/reset`）即可清空**当前这个会话**的记忆：

- 只影响发指令的那个会话（私聊对象 / 群），别的会话不受影响；
  群聊的上下文缓冲（`ambientMessages`）也一起清掉。
- 整条消息恰好等于指令才触发；`/reset 你好` 这种带内容的消息会照常交给 Agent。
- 生效方式是两步：先销毁活着的 Agent（连同它的 Session 与写出句柄），再删掉
  磁盘上的会话记录，然后回一句「已清空本会话记忆。」。少了任何一步，下一条消息
  都会把旧记忆带回来。
- 之后的消息会新建一个空会话，`qq_list_conversations` 里的 Session id 不变
  （id 由会话 key 派生，与记忆无关）。
- 把 `resetCommand` 设为空串即可禁用该指令。

## 工具

| 工具 | 作用 |
|---|---|
| `qq_send_message` | 向指定 QQ 号（私聊）或群号（群）发送文本，超长自动分段 |
| `qq_send_image` | 向指定 QQ 号或群发一张图 / 表情包：来源是 `cwd` 里的图片路径（含 `.qq-stickers/…`、`.qq-media/…`）或一个 http(s) 图片链接；从 QQ 会话里调用时默认发回当前会话 |
| `qq_list_conversations` | 列出在线群/好友列表，以及本 Harness 已处理过的 QQ 会话及其 Session id |
| `qq_jm_pdf` | 下载禁漫（JM）整本/单话 → 合并成一个 PDF → 发到 QQ（从 QQ 会话里调用时默认发回当前会话） |

这四个都是纯宿主平面的全局工具，所有 Agent（包括 Web UI 里的主会话）都能用。
`qq_send_image` 见[它也能发表情包](#它也能发表情包)；`qq_jm_pdf` 需要 python 环境与
NapCat 能访问到本机（见[禁漫下载](#禁漫jm下载车号--pdf--发到-qq)），关掉 `jmDownload`
后调用会明确报错。

## NapCat 端要求

NapCat 需要开启一个 **WebSocket 服务器**（不是 websocketClients）。
在 NapCat WebUI 的「网络配置」里新建 WebSocket 服务器，端口与本插件
`endpoint` 一致；若设了 token，同步填到 `accessToken`。

当前这份配置对应的容器：

```
容器     napcat (mlikiowa/napcat-docker:latest)
端口     3001  → OneBot WebSocket 服务器（name: qqbot, token 为空）
配置文件 /app/napcat/config/onebot11_<QQ号>.json
```

查看配置：

```bash
docker exec napcat cat /app/napcat/config/onebot11_100000000.json
```

## 运行方式：独立的 `qqbot` profile

插件装在专属 profile 里，和日常用的 `web` profile 完全隔离。

```
profile   ~/.dsh/profiles/qqbot/         （从 dsh 自带的 web 模板克隆）
bundles   @deepseek-ai/dsh-base
          @deepseek-ai/dsh-web-app
          @qqbot/dsh-plugin-qq
依赖      @qqbot/dsh-plugin-qq -> link:~/Projects/qqbot
UI        http://127.0.0.1:3081/
```

启动：

```bash
dsh --profile qqbot --port 3081 --no-open
```

没有"常驻但无 UI"的官方模板可用（`headless` 是一次性任务，`acp`/`sdk` 是
stdio JSON-RPC 服务），所以从 `web` 模板克隆：进程常驻，并且可以顺便在
浏览器里实时看 QQ 会话。

### 常驻运行

**不要**把它挂在一个 agent 会话的后台任务里：DSH 的 bash 工具跑在
`bwrap --die-with-parent` 沙箱内，沙箱一销毁子进程就跟着死。常驻必须由你
自己的登录会话或 systemd 托管。仓库里备好了 user unit：

```bash
cp ~/Projects/qqbot/deploy/qqbot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now qqbot

systemctl --user status qqbot          # 状态
journalctl --user -u qqbot -f          # 日志（含带 token 的 Web UI 地址）

# 想让它在没有桌面登录时也能跑：
loginctl enable-linger "$USER"
```

`Restart=always`，崩了 5 秒后自动拉起。改完源码后
`systemctl --user restart qqbot` 即可（等价于"重启 Harness"）。

临时手动跑（放 tmux 里，别用 agent 的后台任务）：

```bash
tmux new -s qqbot 'dsh --profile qqbot --port 3081 --no-open'
```

### 凭据

QQ 会话用的模型是 `deepseek-official/deepseek-flash`（继承 `dsh-base` 的
`agent-default-model` 默认值），它需要 `DEEPSEEK_API_KEY`。解析顺序是：

```
继承的环境变量
  > $DSH_HOME/.credentials.yaml
    > <启动 cwd>/.env
      > $DSH_HOME/.env
```

注意 Harness 会用 `scrubbedParentEnv` 把敏感变量从**所有子进程**里抹掉，
所以 `env` 里看不到它属于正常现象。如果从没有该变量的环境启动（systemd、
别的 shell、CI），会报 `MISSING_CREDENTIAL`。

**推荐做法**：在 3081 的 Web UI 里打开 Models 页面填一次 key。它写入全局的
`$DSH_HOME/.credentials.yaml`，之后任何 profile、任何启动方式都不再依赖 shell 环境。
从自己的 `~/.zshrc`（已 export 该变量）里启动也可以，但只在那一个 shell 有效。

## 本机开发

插件以 `link:` 方式装进 profile，源码就在当前目录。为了让 Node 能从本目录
解析 `@deepseek-ai/*` 包，仓库里有一个指向 dsh 依赖目录的软链接：

```
node_modules -> ~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules
```

**这个软链接不能删**，否则插件会以 `failed to import` 报错
（`link:` 安装按真实路径解析依赖，而真实路径下没有 `@deepseek-ai/*`）。

仓库里还有一个 `.venv`（python 虚拟环境），只给禁漫下载用：

```
.venv/                     python3 -m venv .venv
.venv/bin/pip install jmcomic img2pdf
```

它和插件本体无关 —— 没有它，其它功能照常工作，只有 `/jm` 与 `qq_jm_pdf` 会回一句
「禁漫下载没启用」。配置里的 `jmPython` 就是指向它的，换位置改这个字段即可。

### 改完源码必须重启 Harness

Loader 在进程内按 URL 缓存插件模块，**停用/启用插件不会重新加载代码**
（已验证：`set_plugin` 会注销并重新注册工具，但模块仍是第一代；改入口文件名、
`remove_bundle` + `install_bundle` 同样无效）。改了 `index.js` / `onebot.js`
之后必须重启 `dsh --profile qqbot` 进程：

```bash
# Ctrl-C 后重新执行
dsh --profile qqbot --port 3081 --no-open
```

只有插件 `cordis.patch.yml` 里的配置改动可以热生效，源码改动必须重启。

（禁漫下载是**例外**：下载逻辑在 `scripts/jm_download.py` 里，插件每次下载都重新
spawn 它，所以改这个脚本不用重启，下一条 `/jm` 就生效。改了 `jm.js` / `index.js`
仍然要重启。）

### 跑测试

`test/bridge.test.mjs` 会起一个假的 OneBot WebSocket 服务端 + 假的 Harness
上下文，跑完整的入站/出站链路（真实使用 `ws` 与本插件的 OneBot 客户端）：

```bash
node --test test/
```

覆盖：私聊往返、群里 @ 触发与 `@机器人你好` 的 mention 剥离、白名单与
未开启渠道的丢弃、模型路由（配置优先、否则继承部署默认）、出站工具、
超长消息分段、会话列表，以及「像真实群友」那一组：群聊上下文进入提示词并可关闭、
攒批（三个人几乎同时 @ 只变成一条消息、只发一条回复且不逐人引用、`batchWindowMs: 0`
回到逐条、一直有人说话时按 `batchMaxWaitMs` 的上限发出、`/reset` 先把攒着的那批投出去）、
自动回复按换行/短句拆成多条且打字延迟真的接上了配置、多条时引用只挂在第一条、
`humanize: false` 回到单条、群聊引用/@ 指向、
群名与「当前发言者」不再过期，外加 `splitBurst` / `typingDelayMs` 两个纯函数的边界用例。

还有「读表情包」那一组：图片真的落盘且字节未变、内容哈希去重与按最近使用淘汰、群聊
环境上下文默认也落盘（`ambientMedia: false` 时退回不下载）、
引用消息走 `get_msg` 把被引用那条的图取回来（引用段换成引用前缀、纯文本引用进正文、
实现不支持 `get_msg` 时安静降级、`quoteMedia: false` 一次都不发）、
抓不到时降级成占位符并能靠 `get_image` 的 base64 兜底、
`mediaDownload: false` 与超限跳过、`mediaDir` 被配到 `cwd` 外面即整体停用，外加
`collectMedia` / `mediaPlaceholder` / `sniffImageExtension` 的纯函数用例（测试里的假
OneBot 按真实形状回 `image` 段，另外起一个 HTTP 服务假装腾讯的图片 CDN）。

还有「发表情包」那一组：发出去的确实是一个 `image` 段且 `base64://` 解出来就是原字节、
从 QQ 会话里调用默认发回当前会话（群里也能显式指定群号）、把会话里刚收到的那张图
（正文给了 `.qq-media/…` 路径）原样发回去、非图片 / 超过 `imageMaxBytes` / `cwd` 之外的
路径一律在发消息之前就失败、`imageSend: false` 直接报错、渠道提示里列出 `.qq-stickers/`
的文件名（被 `allowTools` 挡掉或目录在 `cwd` 外时一个字都不提），外加
`loadOutgoingImage` / `imageSegment` 的纯函数用例（本地路径、`file://`、URL、大小与格式校验）。

以及「只发表情」那一组：`[[图片: …]]` 标记的纯函数用例（关键字与全角冒号、夹在正文中间
时顺序不变、空载荷与不认识的方括号都退回普通文字）、整条回复只有标记时**只发一张图、
一个字都不发**（`humanize` 开着关着都一样）、夹在文字中间时位置正确、只写文件名也能认到
`.qq-stickers/` 里的那张（工具那边同一套解析）、群聊里引用指向挂在图本身那条上、
发不出去时回「（表情包没发出去）」而不是静默、`imageSend: false` 或白名单没放开时标记
退回普通文字。

最后是「禁漫下载」那一组（`test/jm.test.mjs` + `bridge.test.mjs` 里的几个用例）：
车号/链接解析与文件名清洗、目录越界即停用、spawn 假 python 走完整协议、失败与
「进程没吐结果」的报错、硬超时会**连子进程组一起杀**、同一会话不能并发下载、
一次性 URL 真的取得到 PDF（错 token 404）、PDF 按 LRU 淘汰，以及插件层的
`/jm` 旁路（不进 Agent、不建会话）、群/私聊分别走 `upload_group_file` /
`upload_private_file`、上传失败与下载失败的措辞、`qq_jm_pdf` 从 QQ 会话里默认发回
当前会话、以及 `allowTools` 挡掉它之后提示词里不再提它。

## 安全提醒

- QQ 消息是**不可信输入**。默认 `approvalPolicy: never`，需要审批的操作
  会被直接拒绝，避免机器人被群里的人指使去执行危险命令。
- 默认只在被 @ 时响应群消息；如果要放开，建议同时用 `allowGroups`
  限定群范围。
- Agent 跑在 `cwd` 指定的目录里，受沙箱策略约束。
