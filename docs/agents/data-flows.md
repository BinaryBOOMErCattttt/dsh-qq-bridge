# 十条数据流（AGENTS.md §4 的完整正文）

> 这一册是从 [`AGENTS.md`](../../AGENTS.md) 拆出来的。原因很实际：AGENTS.md 会被 DSH
> 自动注入到每个 Agent 的上下文，而它的注入预算是 65536 字节；原文 93273 字节，截断点
> 落在 §5 中间，§6 之后的「怎么改 / 测试与验证 / 检查清单 / 常见坑」全部看不到。
>
> 现在 AGENTS.md 只留索引与硬约束，**改行为前按小节打开这里**。小节编号（§4.A–§4.J）
> 与代码注释、`docs/` 里的引用保持一致，没有重排。

## 4. 十条数据流（改任何一条先读对应的那条）

### A. 入站消息 → Agent → QQ（主链路）

```
QQ ─▶ NapCat ─ws─▶ OneBotClient.onEvent ─▶ handleEvent
                                              │ noteSeen()：记「最近看见过什么」（撤回时唯一的信息源）
                                              │ admit()：白名单 / 渠道开关 / 群触发方式
                                              │ rememberTranscript()：记一行转录（长期记忆的原料）
                                              │ noteChatter + rememberAmbient（群环境上下文）
                                              │ maybeRepeat()：能复读就直接发，到此为止
                                              ▼
                                       conversationFor(type,id,sender)  建/取会话
                                              ▼
                                       enqueue() → holdForBatch()
                                          batchWindowMs 内攒批；batchMaxWaitMs 封顶
                                              ▼
                                       submitBatch() → createUserMessage → agent.inbox.submit
                                              ▼
   ctx.on('agent/inbox/claimed')  记账 turnOwners[`${agentId}:${turn}`]
   ctx.on('session/event')        assistant/message → transcripts 累积
                                  turn/end        → 取**最后一条有文本的** assistant 消息，
                                                     aborted/forked/interrupted 静默丢弃，
                                                    error 回一句固定道歉（主动搭话除外，见 §4.E），
                                                     空回复 → 重问一次（`emptyReplyNudge`）
                                              ▼
                       sendToConversation(..., { human:true, quote }) → sendParts()
```

空回复不是 `SKIP`：`SKIP` 是模型**选择**不说，空回复是这一轮**没产出正文**（只写了思考 /
工具调用完就停了）。以前它被静默丢弃 —— QQ 那头看到的是「它没理人」，模型下一轮还会以为
自己说过（它看见的是自己的思考），于是回一句「上一条说秃了」（2026-10-22 23:50 私聊的真实
事故）。现在对着真人的轮次会往同一个会话再投一条 `emptyReplyNudge` 重问一次
（`owner.emptyRetry` 防循环）；主动搭话 / 补一句 / 撤回调侃（`proactive`）不重问，还有消息在
攒批窗口 / 积压里等着回时也不重问（那些消息马上会换来一轮回复）。空回复本身永远不会变成
QQ 上的一条空气泡。

⚠️ `rememberTranscript` 必须在 `handleEvent` 的两个提前 `return`（环境上下文、`/reset`）**之前**
调用，否则那些消息不会进转录。它也要**在 `admit` 之前**判定自己的准入规则（渠道开关 / 白名单），
因为 `admit === undefined` 的闲聊同样要记 —— 长期记忆的原料正是那些没人 @ 机器人的话。它**不建
会话记录**（`conversations` 是「处理过哪些会话」的表），只按 key 往记忆目录追加。

`submitBatch` 里对每条消息**并行**做三件异步的事：本条消息的图片/表情落盘（`mediaFor`）、
被引用那条的取回（`resolveQuote`，其中也包含转发）、本条消息里合并转发的展开（`resolveForwards`）。
转发展开失败只保留 `[合并转发 N 条]` 占位符，绝不打断投递；条数 / 字数 / 嵌套深度在
`forwardMax*` 里裁。嵌套块会另起一行、缩进并以 `[/合并转发]` 收尾；批量 / 积压里保留块，
普通消息仍一行一条（见 `docs/media.md`「合并转发」）。

### B. 出站：Agent 主动发

`qq_send_message` / `qq_send_image` 直接调 `client.call('send_*', …)`；`qq_list_conversations`
只查询；`qq_save_sticker` 只写表情包目录、`qq_rename_sticker` 只在那个目录里改名（都**不发消息**，见 §6 表与 docs/media.md）；`qq_transcript` /
`qq_memory` 只读写记忆目录。注意区别：**工具**（显式动作）只按协议上限 `chunkText` 分段，
**不加**打字延迟；拟人节奏只加在 A 链路的自动回复上。

### C. 自动复读（不经过模型、不建会话）

`maybeRepeat` → `repeatStateFor(groupId)` → 私有串行队列 `repeatStep` → `repeatCandidate`（文字
按归一化正文 / 图片按「字节哈希 + 画面指纹」/ 系统表情按 id）→ `sameCandidate` 判「跟刚才那条
算不算同一个」→ `sendRepeat`。配置项是 `repeat*` 一族，细节见 docs/repeat.md「自动复读」（改前必读）。

不能踩的：

- **图片来源判定必须留两层**：字节相同只是快路；QQ 会把同一张表情包按发送者重新编码（实测同一张
  图三种字节、画面 SSIM ≥ 0.985）。第二层是 `sketchOf` 的画面指纹，阈值 `repeatImageTolerance`
  （0 = 关）。指纹**懒算 + 按路径缓存**：只在真要比较两条字节不同的图时读盘，别挪到
  `repeatCandidate` 里让每条表情包都白解一遍。
- **指纹是对不可信字节的二进制解析**：`perceptual.js` 的尺寸/块数/解压长度都有硬上限，畸形输入
  只允许返回 undefined（不抛异常、不大块分配）。加格式（如 WebP）先补这几条上限。
- **`sketchOf` 只读 `.qq-media` 里刚落盘的那一张**，别让它读工作目录里的任意文件（那等于把群
  消息变成读文件的入口）。
- **「表情还是普通图片」要在链上累加**（`repeatStep` 的 `sticker = candidate.sticker || previous.sticker`）：
  同一张图只要链上出现过一次表情（`sub_type` 非 0 / `emoji_id`），后面被另存/转发成普通图片
  也按表情复读。别改回「只看触发复读的最后一条」—— 19:53 表情、19:54 同图当图片发，就会把
  表情复读成照片样式的图（真实事故）。`sendRepeat` 必须收到补过 `sticker` 的链条目，不是原始 candidate。

### D. 长期记忆（转录 → 定时摘要 → 认知）

实现分两层：**落盘与摘要循环在 `memory.js`**，**记录模型 / 检索 / 滚档 / 逐条写入的纯函数在
`memory-select.js`**（`createMemory(deps)` 只装配 `memory.js`，index.js 只装配并在几个点调用）。
下面这张图是**行为规格**，改任何一处先对着它读。

```
handleEvent ─▶ rememberTranscript ─▶ .qq-memory/conversations/<slug>/log/YYYY-MM-DD.jsonl
                                     （后台串行追加，不等落盘；路径按会话 key 派生）
              ├─▶ submitBatch 写 conversation.recallQuery = { text, at, speakers }（不落盘）
              └─▶ maybeCatchUpDigest（错过了今天的摘要点就立刻补一轮，每次启动至多一轮）

channelTurnContext（每轮 user message 的「本轮情境」块）─▶ memory.recallText(conversation)
       同步读 PEOPLE.md / COGNITION.md / 本会话 MEMORY.md（size:mtime 缓存）
       ─▶ memory-select.renderMemoryBlock：
            scope 硬过滤（global + 本会话；private 对其他会话不可见）
            → 打分（entity 3 / lexical 2 / recency 1 / salience 0.8 / prior 0.5 / expired -5）
            → 按节配额 + round-robin 打包（memoryPromptChars / memoryRecallK / memoryPeopleMax）
            → 出处（MEMORY.md#L23）+ 词汇表（memoryVocabHint）+ archive 聚合行（现算）
       ─▶ recallLedger：已给过的记录 / 索引 / 词汇表 / 归档行不再重复（换代清账）；
            这是上下文增长的主控 —— 每轮重发 4~6k，三十几轮就会触发压缩
       ─▶ 命中的记录在 memory.index.json 里累加 hits / lastSeen（防抖写盘；坏了只降级）

ctx.interval（排到下一个 digestAtHour，默认 04:00）─▶ runDigestSweep
       判据：今天这条会话还没摘要过（localDate(lastDigestAt) ≠ 今天）且 memoryDirty ≥ digestMinLines
             └─▶ enqueueDigest（串行链 digestChain，一次只跑一个会话）
                     │ 先 await 该会话未完成的转录写入（写入是后台的，不等会读到空目录）
                     │ 读转录窗口 → renderTranscriptWindow（最近优先截断）
                     ▼
                 runDigest ─▶ ensureDigestAgent（sessionIdFor('bridge:digest')，独立会话）
                     │          followup(转录正文) → await whenIdle()（有 digestTimeoutMs 守卫）
                     │          digestTarget = 被摘要的会话（私聊写入闸门靠它）
                     ▼
                 模型自己用 qq_transcript / qq_memory 读转录、upsert MEMORY.md / PEOPLE.md
                     │  （私聊轮写 COGNITION.md / PEOPLE.md 会被工具直接拒绝）
                     ├─▶ 成功后才滚档（digestRollover）：archivePlan → 先写 archive/、成功才改热层
                     ├─▶ 可选周合并（digestConsolidate）：第二次 followup 只整理、不新增事实
                     └─▶ 最后才写 digest.json 的 lastDigestAt + lastDigestDate（失败/超时不推进）
```

几条不能踩的：

- **摘要 Agent 不是记忆的载体**：它只读磁盘上的转录、只写磁盘上的记忆文件，被压缩/销毁/重启都
  不影响记忆 —— 别把「记住」实现成会话上下文里的东西。
- **一天至多一次靠日期判据**（`localDate(lastDigestAt)` vs 今天），不是「距上次 ≥ N 小时」。
- **`digest.json` 只在成功之后才推进**；排队中的消息靠内存 `memoryDirty` 计数（重启归零、靠
  `lastDigestAt` 重新数），所以摘要没跑成不会把消息算丢。
- **别在启动时扫一遍**（`conversations` 那刻还是空的）：补课挂在「重启后第一条消息到达」上。
- **读转录前先等写入**（`writesFor` + `Promise.all`），否则会读到还没写出来的目录然后静默跳过。
- **认知与表情包是两个文件**：`COGNITION.md` 只有语言（键是文字写法），`STICKERS.md` 是表情包
  （键是收藏后的文件名）。解析在 `cognition.js`；`qq_save_sticker` 存完图顺手补一行，
  `qq_rename_sticker` 改名时把那一行一起搬（`cognition.js` 的 `renameStickerRow`）。
- **摘要 Agent 不在 `sessionIndex` 里**，它的 turn/end 因此不会往 QQ 发东西 —— 这是「后台会话」
  与「QQ 会话」唯一的区别机制，别把 digest session 注册进去。
- **写边界只有一处**：`memoryRelativePath`（模块级纯函数）。`qq_memory` 的写路径必须过它，
  `../` 与绝对路径都要被拒。要放开范围之前先想清楚 QQ 消息是不可信输入。
- **`memoryDir` 校验与 `mediaDir` / `stickerDir` 同一套路**：配到 `cwd` 外记 warn 并整个停用。

**结构化文件只走字段级写入**（0.2.0 之后的修订，对应三次真实事故）：

| 事 | 落点 | 为什么 |
|---|---|---|
| `qq_memory` 的 `upsert` / `remove` | `cognition.js` 的 `upsertCognitionRow` / `upsertStickerRow` / `remove*`；`memory.js` 的 `upsertMemoryEntry` / `removeMemoryEntry` | 模型只给字段，格式与分节由纯函数生成：它写不坏格式、不会重复标题、不会因为整份重写丢行 |
| 写入归一化 | `normalizeCognitionDoc` / `normalizeStickerDoc`，在 `writeMemoryFile` 里对这两个文件强制跑 | `append` 一段带 `## 黑话与缩写` 的 markdown 是最常见的写法，落盘时就合并掉，别指望模型自觉 |
| 整份重写的护栏 | `writeMemoryFile` 里「条目数掉到 90% 以下就拒绝」（`force: true` 放行） | 模型漏抄几行时文件照样「写成功」，护栏是唯一能拦住它的地方 |
| `.history/` 备份 | `backupMemoryFile`，每次写入前留一份，每个文件最近 20 份 | 写坏了至少能人工翻回去 |

- **私聊内容永不升级（scope）**：`COGNITION.md` / `PEOPLE.md` 只收 `global`；私聊会话对这两个
  文件的任何写请求在 `memory.js` 的 `assertGlobalWrite` 里**直接拒绝**（摘要 Agent 走
  `digestTarget` 同一条闸门）；检索在打分**之前**按 scope 硬过滤。`PEOPLE.md` 的启动迁移
  只扫群目录，不碰 `private-*`。
- **无日期条目按文件位置排**（`hotCognitionLines` 的 `effectiveDate`）：继承它前面最近一个
  有日期的条目的日期，不再一律当最旧（设计 §1.2 的回归）。
- **滚档只搬不删**：`archivePlan`（纯函数）只减不增、没有可滚条目时返回原因、热层不写指针行；
  `memory.js` 先写 `archive/`、成功才重写热层，失败时热层原样不动。`qq_memory search` 覆盖
  `archive/`，`list` 也列得出冷层。
- **检索的兜底绝不取文件头**：没有命中时按 pinned / salience / 最近取；每人每轮看到的记忆由
  `memoryPromptChars` 预算约束，而不是文件长度。
- **`type` → 二级标题的路由在 `sectionForType`**：`缩写`/`谐音`/`专名`/`其它`。认知条目
  **有日期的按首见日期、没有日期的按文件位置**参与排序（`hotCognitionLines` 的
  `effectiveDate` 让无日期条目继承前面最近一个日期）—— 否则整理一次文件就等于换掉它
  每轮记得什么，而没写日期的老条目会被永远当成最旧。
- **认不出来的行不删**：`parseCognition` / `parseStickerCatalog` 只记 warn；`qq_memory read`
  会把它们点出来（`readWarningNote`），`ops doctor` 也会（`COGNITION_UNPARSED` 等五条）。

### E. 主动说话（`proactive`，默认开）

```
ctx.interval（每 proactiveCheckMs）─▶ proactiveSweep
   ① 没连上（selfId 为空）/ 不在 proactiveFromHour~ToHour / 概率没掷中 → 直接返回
   ② 每个群过一遍 proactiveEligible（全是「不做」的条件）：
        只群聊 · 没有待投的批次/在飞的 turn · 有人说话晚于我的最后一句话（**不做独白**）
        · 安静 ≥ proactiveIdleMs · 活跃于 proactiveFreshMs 之内 · 距上次 ≥ proactiveGapMs
        · 当天次数 < proactiveDailyMax
   ③ 洗牌后逐个掷 proactiveChance，**一次醒来最多一个群**开口
        └─▶ proactiveSpeak：先记 lastProactiveAt / 当天次数（**掷中即消耗**，SKIP 也算），
            再 enqueue(该群会话) → ensureAgent → followup(proactiveNudge(...))
                                  └─ submitted.set(msg.id, { …, proactive: true })
   turn/end ─┬─ 正文判成 SKIP（`proactiveSkip`）→ 什么都不发（**不分是不是主动那一轮**）
             ├─ proactive 且 reason === 'error' → 静默（没人问过它，不道歉）
             └─ 否则照常 sendToConversation(..., { human: true })（拆句 + 打字延迟）
```

不能踩的：

- **伪造的 user message 必须说清「这不是谁发来的」并给出 `SKIP` 出口**：不给出路时模型会硬编
  一句，比不说话更像机器人（文案见 `proactiveNudge`）。
- **`SKIP` 判定对 `所有` 轮次生效**：提醒落在同一会话的上下文里，模型在**回别人**的那一轮也会
  学着写 `SKIP`（真实事故：它引用了别人的表情包，正文写着「SKIP」）。判据在 `proactiveSkip`。
- **掷中即消耗**：`SKIP` / 失败也算用掉当天额度与 `proactiveGapMs`（先记账再 followup）。
- **走的是这个群自己的会话**（与摘要 Agent 相反），所以它在 `sessionIndex` 里、回复照常回 QQ。
- **`lastBotSpeakAt` 由 `sendOne` 记账**（不做独白的判据），别绕过它直接 `client.call`。
- **`lastActiveAt` 由 `touchActivity` 更新**，含**没被 @** 的群消息；只更新**已有**的会话
  （「只对已经聊过的群生效」就落在这里）。
- **状态全在内存**：重启归零，别把 `proactiveIdleMs` 配成 0 又反复重启。
- **只群聊**：第一行就 `type !== 'group'` 返回 false（刻意不给私聊开关）。
- **`withinActiveHours` 是纯函数**（左闭右开 / 相等 = 全天 / `from > to` 跨零点），改语义就改它。
- **闸门本身是纯函数**（`proactiveEligible` / `proactiveSkip`）：五道闸门 + 两个节奏闸收在
  `(普通入参) → boolean` 里；`index.js` 里只是凑入参的适配器（含带跨天归零副作用的计数读数）。

### F. 活跃对话（`activeFollow` / `activeFollowIdleMs` / `activeGroup*` / `activeChime*`）

E 管的是**冷场**；这一块管「正聊着」。三个旋钮，别合并：

- `activeUntil` / `activeWindowMs`（默认 60 秒）：B 的补一句 + C 的热度；
- `followUntil` / `activeFollowIdleMs`（默认 3 分钟）：A 的断聊间隔（两条之间超过它就结束）；
- `activeMaxTurns`（默认 10）：A 的条数硬上限。

```
admit（群聊）
  ├─ 被叫到（@ / 前缀 / groupTrigger=all）→ 不抽卡直接回；talkMisses 清零
  │      → noteActiveMessage(..., 'addressed')：activeTurns 归零、followUntil/activeUntil 一起滑、
  │        记 activeInterposeSeq 快照、清 chime
  ├─ A 没被叫到 → activeFollowAllows？（七条，逐条见 speaking-rules.js）
  │      └─ 成立 → **不抽卡**，intent = continued（A 路每句都回；条数由 activeMaxTurns 封顶）
  │           → noteActiveMessage(..., 'continued')：activeTurns +1、两个窗口一起滑
  └─ C 没被叫到 → groupTalkActive(群号)？（热度窗口够条数、够人数，纯查询）
        └─ 成立 → **抽卡**（activeTalkAllows；四条排除见 speech-policy.js）：
             概率 = min(activeTalkChanceMax, activeTalkChance + activeTalkChanceStep × talkMisses)
               ├─ 抽中 → talkMisses = 0，intent = interject
               │    └─ noteActiveMessage(..., 'interject')：**不买一对一** —— activeSpeakerId /
               │       followUntil / activeTurns 清掉，只滑 activeUntil 与 chime 快照
               └─ 没抽中 → talkMisses +1，这条不进 Agent（转录/环境上下文/热度照记）
             两个资格都不成立 → talkMisses 清零（这段对话凉了，保底不跨对话）

holdForBatch → batchScale()：C 生效时 batchWindowMs / batchMaxWaitMs 一起 ×
   activeGroupBatchScale（「倾听时间变长，多听几句再合成一轮回复」）

turn/end（正常回复发完之后）
  └─ scheduleChime：proactive 开着 + activeWindowMs/chimeIdleMs/chimeMax 都 > 0
       → 排一个裸 setTimeout（chimeIdleMs 按 delayJitter 抖动），编号记在 chimeSeq
            └─ runChime：编号还对得上 · 窗口还热 · 没有在飞的 turn/批次
                 · chimeCount < activeChimeMax · 当天 < activeChimeDailyMax
                 · lastBotSpeakAt > lastActiveAt（我回过、对方没接）
                 · 群里 chatter.others() == activeInterposeSeq（中间没人插话）
                 · 掷中 proactiveChance
                    └─ chimeSpeak：先记账再 enqueue → followup(chimeNudge())
                         submitted.set(msg.id, { …, proactive: true })  ← 与 E 共用分流
```

不能踩的：

- **两个窗口都只靠别人发来的消息往后滑**（机器人自己的话不滑），否则它自己就能给窗口续命。
- **三本账别合并**：都在 `chatter.js`，只暴露语义动作 —— `noteOther`（别人：序号 +1、记热度）/
  `noteSelf`（我自己：只推回答指向）/ `others`（比大小，判有没有人插话）/ `anchor`（含我自己，
  判我回的那条被挤远没有）/ `isHot`（比时间，判最近够不够热）/ `forgetHeat`（`/reset`）。
  `test/chatter.test.mjs` 把这些不变量钉成断言 ——**合并两本账会直接红**。
- **多人搭话是纯查询**（`groupTalkActive`），不存「搭话状态」；也**不消耗 `activeMaxTurns`**
  （那是防一个人刷屏的，这里的闸门是「够条数、够人数」）。
- **只有 C 路抽卡**：A 路够资格就回（对面只有一个人、而且刚跟它说完话），抽卡留给「热群里
  每条都回会刷屏」的场合。抽中、被 @ 到、或两个资格都不成立时 `talkMisses` 归零。
  空消息在判据之前就被丢掉。
- **`activeFollowIdleMs` 不能合并进 `activeWindowMs`**：那 60 秒同时量着补一句与热度，
  拉长会让群更容易被判成聊热（更多插话）。A 路要宽，就给它自己的窗口。
- **`noteActiveMessage` 的第三个参数是三档 `mode`**（`addressed` / `continued` / `interject`），
  别再塞布尔值：插话**不买一对一**（否则热群里每个被接话的人都白拿一段「每条都回」的窗口），
  而且它不能拿插话那一刻的群进度当一对一的快照（那会把一个本该断掉的一对一「接回来」）。
- **只放大攒批（`batchScale`），不放大打字延迟**：窗口与上限两处必须同倍，否则
  `batchMaxWaitMs` 会把「多听几句」又卡回去。
- **`continued` 一路要传到 `submitBatch`**：前缀模式下按前缀长度硬切会切掉正文首字
  （`dropPrefix` 只对**显式带前缀**的那条调用）。
- **窗口接上的那句不是指令**：`handleEvent` 里 `commanded`（= 被叫到且不是 continued）
  挡在 `/reset` 这种旁路前面 —— 否则窗口里一句「reset」就绕开模型把会话重置了。
- **`admit` 里先看 `conversations` 里有没有这个群**：窗口回话（A 与 C 都是）不能凭空创建会话
  记录（那会让没被 @ 的闲聊把群变成「处理过」的会话，破坏长期记忆那条旧不变量）。
- **补一句只在正常回复之后挂**（`turn/end` 的非 proactive 分支），主动搭话自己那一轮不再挂 ——
  否则它会补一句再补一句、对着空气自言自语。
- **补一句的九条闸门是纯函数**（`speaking-rules.js` 的 `chimeAllows`）：编号、总开关、窗口、队列、
  两个上限、**对方有没有接**、群里插话、概率全在一个判据里，同样有逐条翻动的用例。`runChime`
  只剩「凑入参 → 掷骰子 → 叫 chimeSpeak」。
- **`chimeSeq` 是防漏的保险**：新消息（`noteActiveMessage`）与 `/reset`、插件卸载都会
  `cancelChime`，但正确性只依赖「编号对不对得上」，不依赖取消点记得 `clearTimeout`。
- **`activeFollow` 默认开**（放松「群里只在被 @ 时才说话」，属于安全面 §5.6）：`false` 时
  一对一的免 @ 接话与多人搭话一起关掉。改这个默认值要同步 docs/configuration.md 的配置表与 docs/security.md。
- **`/reset` 要清热度窗口**（`chatter.forgetHeat`），两个序号刻意不清（理由写在 `forgetHeat`）；
  `followUntil` 也要归零（与 `activeUntil` 一起）。
- **群聊的 B 需要 `proactive: true`**；**私聊的补一句不需要**（那是刻意的语义例外，见
  `privateAfterthoughtAllows` 的注释与 docs/proactive.md「私聊补一句」）。

### G. 会话轮次（`/reset` 开新一轮）

`/reset` 不删旧会话，而是**换一个 Session id 从头开始**。代次（第几轮）是这套东西的全部状态：

```
conversationFor ──▶ refreshSessionGeneration：新建会话记录时从内存代次表里带上
                     （内存代次表由启动时的 loadConversationResetCounts 从磁盘扫进来）
ensureAgent     ──▶ sessionIdFor(key, conversation.sessionGeneration ?? 0)
                     → 该 id 的 Session 不在就 resume（第 0 轮的老会话），失败则 create

QQ 里发 /reset ─▶ handleEvent 的旁路（先 flushBatch）─▶ resetConversation
   ① 销毁活着的 Agent（句柄没了就退 scope.dispose）；销毁失败 → 整件事放弃、回一句失败
   ② 代次 +1，写进内存表 + 标记文件（`<会话根>/reset/<slug>.json`，**await 落盘成功**）
   ③ 清记账：sessionIndex / turnOwners / submitted / transcripts / ambient / repeatStates /
      主动说话计数 / 活跃对话窗口与 chime
   ④ 下一句消息算出**新的** id → resume 不到 → create 一个空会话（第 N 轮）

静默太久（idleResetHours > 0）：
noteConversationActivity（touchActivity / 戳一戳）先记下 `idleMs`（**更新前的** `lastActiveAt`）
   ─▶ handleEvent 里 admitted 之后、`/reset` 判定之前 ─▶ maybeIdleReset
        idleMs ≥ idleResetHours → enqueue(resetConversation)（它排在 submitBatch 前面）
```

不能踩的：

- **代次必须落盘**（§5.4）：只在内存里的话，重启会把第 0 轮的会话 resume 回来。
- **`/reset` 之后旧会话仍在磁盘上**（存档，刻意不删）：别清理它，也别重新注册进 `sessionIndex`
  （旧 Agent 迟到的 turn/end 会被当成这个会话的回复发出去）。
- **长期记忆与轮次无关**：转录 / `MEMORY.md` 按会话 key（`memorySlug`）落，`/reset` 不动它们。
- **第 0 轮的 id 是历史契约**（§5.3）：`sessionIdFor(key, 0)` 必须与改动前逐位相同。
- **重置要过权限**（`canReset` / `Config.resetUsers`）：`resetUsers` 非空时以它为准，为空时由
  `ownerAutoClaim` 认第一个私聊联系人，两者都没有才是谁都不能 —— 全项目唯一一个「名单空 = 默认
  收紧」的配置项（与 `allowUsers` 相反），别顺手统一。判断点在 `handleEvent` 的 `/reset` 分支里、
  `flushBatch` **之前**（否则没权限的人也能让攒着的消息提前投出去），没权限时静默 return。
- **静默换代的 `idleMs` 只能在 `lastActiveAt` 被覆盖之前算**（`noteConversationActivity`）：
  `touchActivity` 在 `admit` 之前跑，一到就把「刚才有多安静」盖掉了；而新建会话记录时
  `conversationFor` 必须补一次 `lastActiveAt`，否则第二条消息算出来的静默永远是 0。
- **`maybeIdleReset` 要跳过 `/reset` 自己**（否则一次指令连换两轮），并且**排进
  `conversation.queue`** 而不是就地 await：`handleEvent` 是同步的，而这条消息马上要经
  攒批 → `submitBatch`（也排在同一队列上），队列顺序是「先换轮、再投递」的唯一保证。
- **销毁失败就不换**（`resetConversation` 返回 false）：宁可这一轮还带着上一段，也不能让新旧
  两个 Agent 同时挂在同一个会话上。
- **Web UI 的「重置对话」按钮走同一个 `resetConversation`**（`GET/POST /api/qq-bridge/sessions`，
  路径常量在 `util.js` 的 `SESSION_ROUTE_PATH`，挂在 Connection 的认证栅栏内）。它**不套
  `resetUsers`**：那是 QQ 侧的白名单，而这条路由只交给已登录的操作员。列表只读本进程的
  `conversations`（重启后要等会话再说一句才出现）；单条 / 全部重置都先 `flushBatch` 再排进
  `conversation.queue`，与 `/reset` 同一顺序。细节见 `docs/sessions.md`。


### H. 每天轮换模型凭据（`apiKeyRotate`，默认开）

```
ctx.interval（排到下一个 apiKeyRotateHour，默认 04:00）─▶ key-rotation.js 的 rotate()
   ① 读 cwd 里的 apiKeyFile（默认 data/api-keys.txt）→ parseApiKeyPool
        文件不存在 / 一行 key 都没有 → 记 info 说「该建在哪」，到此为止
   ② ctx.get('credentials')：拿不到 set/resolve → 记 warn，到此为止
   ③ credentials.describe(apiKeyRef) 说 writable === false（key 来自启动环境）→ 记 warn，到此为止
   ④ credentials.resolve(apiKeyRef) 拿当前 key → 决定候选顺序
        从「当前 key 在池子里的下一个」开始绕圈；当前 key 不在池子里就从池首开始
   ⑤ 逐个候选 probeApiKey(apiKeyProbeUrl)：GET，2xx 才算能用（429 = 有效但没额度）
        第一个通过的 → credentials.set(apiKeyRef, key) → 回读确认 → 记 info
        全都不通过 → 记 warn，**保留原来的 key**
```

不能踩的：

- **必须走 `ctx.credentials`，别手改 `$DSH_HOME/.credentials.yaml`**（那里还有浏览器会话等
  records；凭据层自带文件锁与写后通知，`set()` 之后不用重启）。
- **`ctx.get('credentials')` 而不是写进 `inject`**：写进 inject 会让没有凭据服务的组合整个插件
  不激活（§10 第一条），而轮换只是顺带的事。
- **探测必须便宜**：`GET /models`，不是发一次真对话；两个鉴权头一起带（OpenAI 面 + Anthropic 面）。
- **日志绝不出现完整 key**：一律走 `apiKeyFingerprint`。
- **「当前是哪个 key」现算、不落盘**：靠 `credentials.resolve` + 池子里的位置，别加「上次换到
  第几个」的状态（重启、手改 key、调顺序都会让它跑偏）。
- **探测不通过就不写**（宁可不换，也不能把 bot 换成不可用的状态）；**key 来自环境变量时提前
  退场**（`describe()` 的 `writable: false`）；**池子文件必须在 `cwd` 内**。

### I. 被撤回的消息（`recallMode`，默认 `ignore`）

形态照抄戳一戳：**判据全在 `recall.js`，`index.js` 只凑入参、记账、投递**。三层 —— 安全层
（清引用）与数据层（内存里的「最近看见过什么」账）**永远生效**，行为层才是配置项。
完整规格（用户视角 + 实现要点 + 坑清单）见 `docs/recall.md`。

```
message 分支最前面 ─▶ noteSeen（recent[key] 压一条：id / userId / name / text / at /
                        addressed / submitted / replied / recalled / action）
notice 分支 ─▶ handleRecall
   ① recallInScope ─▶ ② clearQuoteFor（安全层，所有模式都做）
   ─▶ ③ 私聊且 !recallPrivate → 停 ─▶ ④ findRecent（对不上只记 info，不是错误）
   ─▶ ⑤ memory.noteRecall（转录追加 kind:"recall"）
   ─▶ ⑥ 还没投递：!addressed 或 recallAddressed==='drop' → action='drop' +
        dropPending + dropAmbient；addressed 且 tease → action='rewrite'
   ─▶ ⑦ 只有 tease 继续：recallAction 的 12 条闸门 → 掷中先记账、再 enqueue 一条 nudge
```

不能踩的：

- **清引用是正确性**：`quote` 在 `pending` / `submitted` / `turnOwners` 里是**同一个对象**
  （`batchQuote` 取的就是 `admit` 快照那个，所以**别在别处复制新对象**）。不清的话，引用一条
  已撤回消息的回复会在 `sendOne` 失败，而 `sendParts` 见到失败就 `return` —— 整条回复剩下的
  气泡一起不发。只清 `messageId`、留 `userId`（`replyStyle: 'at'` 仍要用它，`auto` / `quote` 没
  有 `messageId` 时自然退回裸文本）。
- **`noteSeen` 在 `admit` 与所有提前 `return` 之前**；**`action` 记在 `recent` 账上而不是只改
  `pending` 数组**（那一批可能已被 splice 出去、正在 `submitBatch` 里异步下媒体）。
- **`recalled` / `action` / `submitted` / `replied` 是四种东西，别合一个布尔**；`replied` 只在
  `turn/end` 真要发回复时由 `markReplied` 置（`owner.batchIds` 只含真正投进这一轮的那些）。
- **改写不另开一轮**（否则是两连发）；**在飞不补刀**；**管理员代撤 / 自己的消息被撤不调侃**。
- **补一句要过闸门，改写不吃闸门**（它不多发消息）；nudge 用 `proactive: true`。
- **`/reset` 清 `recent[key]` 与 `recallAt` / `recallToday`**；转录只追加 tombstone、不删行。

### J. 定时提醒（`reminder`，默认开）

完整规格见 `docs/reminders.md`；实现分两层：**任务与调度在 `reminders.js`**，**发送与
agent 轮在 `reminder-runtime.js`**（`index.js` 只装配并解构同名函数）。

```
到点 ─▶ reminders.fireDue
          ├─ text   → deliverReminderText（原样 + at 段，不分气泡、不加延迟）
          └─ agent/prompt
               ├─ 先落盘 status=firing（at-most-once）
               ├─ 会话正忙 / Agent 日额度用完 → 固定文案
               └─ runReminderTurn：enqueue → ensureAgent → followup(reminderNudge)
                    ├─ turn/end 的 reminder 分支（必须排在 error/SKIP/aborted 之前）
                    │    ├─ 正常有文字 → deliverReminderModel（拟人发送 + at）
                    │    └─ SKIP/空/error/aborted → 按 reminderOutcome 兜底或丢弃
                    ├─ 守卫超时 → 固定文案；迟到的 turn/end 丢弃
                    └─ 重启时仍是 firing → grace 内补固定文案，超过标 missed
```

不能踩的：

- **reminder 分支必须在 `turn/end` 的最前面**：普通轮次里 error / SKIP / aborted 都是静默
  `return`，提醒照抄就会静默消失。`settleReminderTurn` 返回 false = 守卫已结算，丢弃迟到的回复。
- **不要给提醒轮标 `proactive: true`**：`proactive` 的 error 分支会静默吞掉，提醒必须能走到兜底。
- **@ 由任务注入，不让模型写**：`sendParts(..., at)` 把 at 段挂到第一个文字气泡；模型只写正文。
  文本原样发送，**不解析** `[[图片]]` / `[[@]]` 标记（群聊文本是不可信输入）。
- **守卫按任务 id 存**（`pendingReminderTurns`），不按会话：`/reset` 会清 `turnOwners`，
  `turn/end` 不会再来，守卫是唯一兜底。
- **一个会话同时只跑一条 Agent 提醒**（`busyWithTurn`）；同一分钟的第二条直接发固定文案。
- **提醒轮不挂 `scheduleChime`**：提醒分支提前 `return`，否则它会补一句再补一句。
- **每会话 Agent 日额度**（`reminderAgentDailyMax`）在派发前扣；`text` 不计入。
- **任务文件 `reminderFile` 必须在 cwd 内**；读回时逐条校验，坏条目跳过，不拖垮插件。
- **设置页的「已记录的定时任务」是运行状态的只读投影**：它在独立的「提醒」tab 最上面
  （提醒也服务私聊，别塞回「群聊」页）；`reminderOverview`（纯函数）挑展示字段，
  `reminders.overview()` 先等首次读盘；`index.js` 在 Connection 的认证栅栏内挂一条
  exact Fetch route（`REMINDER_ROUTE_PATH = /api/qq-bridge/reminders`），`client.js` 的
  `ReminderTasks` 同源 `fetch` 它。**别把 `snapshot()` 直接序列化出去**，也不要把这块数据
  塞进配置 schema（任务不是配置）；路由必须用 `ctx.inject(['connection'], …)` 等那个服务
  出现 —— 本插件的 `apply()` 跑在 `dsh-client-connection` 之前，`ctx.get('connection')`
  那一刻是 `undefined`，路由会永远挂不上（设置页只有 404；真实事故）。没有 Connection
  服务的组合里 `inject` 的回调不跑，等于静默不挂。

