# 安全提醒

> 这一页列出所有会扩大能力面 / 主动发消息的开关，以及默认值为什么是这样。
> 改任何一条之前先想一遍：群里任何人都能触发它。

- QQ 消息是**不可信输入**。默认 `approvalPolicy: never`，需要审批的操作
  会被直接拒绝，避免机器人被群里的人指使去执行危险命令。
- 默认只在被 @ 时响应群消息；如果要放开，建议同时用 `allowGroups`
  限定群范围。
- **`proactive` 默认开**：它会**主动**给群里发消息（私聊不会），也就是说绕开了「只在被叫到
  时才说话」这条约束。它只对已经聊过的群生效，并且要先过「时段 / 安静 ≥ 45 分钟 / 不是
  自言自语 / 群还活跃 / 距上次 ≥ 2 小时 / 当天没超次数 / 概率」这一串闸。不想要这个行为就
  设 `proactive: false`；想留但怕越界，就收紧 `allowGroups`、`proactiveFromHour` /
  `proactiveToHour` 与 `proactiveDailyMax`。
- **`activeFollow` 默认开**：它会让它在群里回应**没有 @ 它**的消息：既包括「正在跟它聊的
  那个人、且中间没人插话、且没 @ 别人」的一对一接话，也包括**多人搭话** —— 群里一段时间里
  够条数、够人数地聊起来之后，谁接话都算数（直到大家停下来）。这一步放松了「群里只在被叫到
  才说话」这条约定，所以**不放心就设 `false`**；想留也可以把 `activeMaxTurns` 调小、
  把 `activeGroupLines` 调高或设成 `0` 关掉多人搭话。
  另外，这些「免 @ 搭话」还要过 `activeTalkChance` 一族的**抽卡**才会真的开口（默认 5% 起、
  每条没抽中 +10%、上限 80%）—— 它是让频率更像真人的那一层，不是安全边界：真想收紧就照上
  面那样关掉资格，或者把 `activeTalkChance` / `activeTalkChanceStep` 都设成 `0`。
- **API key 轮换（`apiKeyRotate`）会改写全局凭据文件** `$DSH_HOME/.credentials.yaml`：
  它默认开着，但只在 `apiKeyFile` 里存在「另一个探测通过的 key」时才会真的写。也就是说
  **谁能在 `cwd` 里放这个文件，谁就能决定 bot 用哪把 key** —— 池子文件别放在别人写得到
  的地方，也不要把它提交进 git（`data/` 已经在 `.gitignore` 里）。它只能改 `apiKeyRef`
  指定的那一个引用，不会动凭据文件里的其它记录（浏览器会话等由凭据层自己维护）。
  不想要这个行为就把 `apiKeyRotate` 设成 `false`。
- Agent 跑在 `cwd` 指定的目录里，受沙箱策略约束。
- **私聊补一句（`privateAfterthought`，默认开）是对「主动消息只有一个总开关」的一次语义例外**：
  群聊的主动消息归 `proactive`，而私聊的补一句是「刚聊完再看有没有想补充的」，有自己的开关、
  概率与每日上限。它仍然是「主动给真人发消息」，所以五道闸门一条不少（只在正常回复后、对方
  没接话、一次一条、有日上限、可 SKIP）。不想让它开口就设 `privateAfterthought: false`。
- **`linkPreview` 默认关**：打开它等于替群里任何人访问任意 URL（暴露本机出口 IP、留下一次可
  被用来探测的请求）。它带完整的 SSRF 防护（私有网段、localhost、数值变形的 IPv4、每一跳
  重定向重新校验、大小与超时上限），但**默认仍然关着** —— 卡片消息不联网就能解析，已经够用。
  `linkAllowPrivateHosts: true` 只该在自建 wiki 这类明确内网需求下开。
- **戳一戳的回应是「QQ 消息驱动的动作」**：`pokeMode: poke` 会让群里任何人戳它一下、它就戳
  回去一下。防循环靠 `pokeCooldownMs`（每个会话 30 秒只回一次）与 `pokeDailyMax`；回戳只打给
  戳它的人，**不会**打给第三人。受不了就设 `pokeMode: ignore` 或 `pokeReply: false`。
- **撤回的调侃默认只冲它来的**（`recallScope: to-me`）：`all` 会让它为群里任何人的撤回开一次口，
  那等于当着全群承认它每条都看。另外 `recallMode: tease` 会真的多发一条消息，所以它带冷却、
  当天上限与时效三道闸；`ignore`（默认）除了「清引用 + 记忆留标记」之外什么都不做。
- **定时提醒（`reminder`，默认开）会把「机器人未来要说什么」落盘**：`qq_remind_create` 让
  插件往 `reminderFile`（默认 `data/reminders.json`）写一条任务，到点由插件直接发消息，
  **不经过模型**。它新增的风险不是「能发消息」（`qq_send_message` 现在就能），而是
  **时间上的突袭**（凌晨 @ 人）和**目标本人没同意**，所以默认：只能提醒创建者自己、
  @ 别人与 @全体都关、每人每天 5 条、每会话 20 条待发。`reminderUsers` 是受信名单
  （可 @ 别人、指定别的会话、建 prompt 模式），`reminderModes` 是模式上限（默认 `agent`，
  设 `text` 就只剩固定文案）。提醒正文**原样发送**，不解析 `[[图片]]` / `[[@]]` 标记；
  @ 只来自创建时解析好的 QQ 号。`prompt` 模式是「无人在场的指令执行」，默认关闭且只给
  受信者。详见[定时提醒](reminders.md)。
- **`qq_save_sticker` 是唯一一个让 QQ 会话直接按自己给的字节写磁盘的工具**（`allowTools`
  里可以去掉它）：它只往 `stickerDir` 里写一个文件名被洗成单层的图片，字节还要先过魔数与
  大小校验，张数受 `stickerMaxFiles` 限制，同名不覆盖。`qq_rename_sticker` 也能动那个目录，
  但它只能给**已收藏的**文件换个名字（不引入新字节、不越出 `stickerDir`、目标名占用就拒绝，
  目录写失败还会回滚文件改名）。`qq_remind_create` 也会让插件写盘，
  但写的是 `reminderFile` 里**由纯函数校验过字段**的任务（不是模型给的任意路径/字节），
  两者不是同一类能力。除此之外 QQ 会话没有 write / edit / bash ——
  这是「群里谁都能让它存一张图」与「工作区不能被群里的人写坏」之间的那条线，别随手挪。

## 相关分册

[主动开口](proactive.md) · [定时提醒](reminders.md) · [被撤回的消息](recall.md) · [图片、表情包与感知](media.md) ·
[长期记忆](memory.md) · [运维（key 轮换）](ops.md) · [配置项](configuration.md)
