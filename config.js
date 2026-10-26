/**
 * 插件配置的 schema —— **配置的唯一真相来源**。
 *
 * 放在单独的文件里而不是 `index.js` 里，是因为它是一份纯数据：不碰闭包状态、不依赖
 * 任何运行时，却有一百多条带中文 `.description()` 的字段（那些描述就是 Web UI 上给
 * 使用者看的文档）。混在运行时逻辑里时，改一个默认值要先翻过半屏的 if。
 *
 * 加配置项的三处同步（别漏）：这里的字段 + `index.js` 读数 + docs/configuration.md 的配置表。
 *
 * @module @qqbot/dsh-plugin-qq/config
 */
import z from '@deepseek-ai/schemastery';


/**
 * 插件配置的校验 schema（bundle 的 config: 段或 Web UI 插件设置里填写）。
 * 这里同时充当配置文档：每个字段的 .description 会显示在界面上给使用者看。
 *
 * **末尾的 `.volatile()` 是 Web UI 设置页的前提**，不是随手加的：DSH 的设置表单
 * （`dsh-settings` 的 `volatileForm`）只把「volatile 节点底下的字段」投影成可编辑
 * 表单，没有它的话这份 schema 在设置面板里连一个命名空间都不会出现（`describe()`
 * 直接跳过没有 volatile 字段的条目）。为什么加在根上而不是每个字段上：根上的
 * volatile 让**整份配置**成为一个稳定引用（schemastery 的 `validateVolatileSchema`
 * 不允许 volatile 套 volatile，所以根上打一次是最省的写法），插件拿到的 `config`
 * 因此要用 `.get()` 取值（见 util.js 的 `liveConfig`）。
 *
 * 由此带来的两条语义，改代码前先读：
 *   1. 配置改动**不会**重跑 `apply()` —— Loader 判定「只有 volatile 变了」之后就
 *      就地换引用里的值（`loader/volatile-update`），所以 `index.js` 自己挂了一个
 *      监听：收到就重启插件（连接、定时器、工具注册都是 apply 时装配的）。
 *   2. 设置页保存写的是**整份配置**（普通字段保留 `!!js` 表达式原样，见
 *      `projectForm` 的 isExpression 分支），所以 `QQBOT_*` 环境变量覆盖不会因为
 *      在界面上点了一次保存而失效。
 */
export const Config = z.object({
  endpoint: z.string().default('ws://127.0.0.1:3001').description('OneBot v11 正向 WebSocket 地址（NapCat 的 websocketServers 端口）'),
  accessToken: z.string().default('').description('OneBot access_token；NapCat 未设置 token 时留空'),
  cwd: z.string().default('').description('QQ 会话 Agent 的工作目录；留空则使用 Harness 进程的当前目录（Windows 桌面版是 ~/.dsh/profiles/desktop，可用环境变量 QQBOT_CWD 指定到别处）'),
  // ---- NapCat 那一侧的配置：启动自检 +（可选的）自动写入 ----
  // 为什么要插件管这件事：NapCat 里没开 WebSocket 服务器、或者端口/token 对不上时，
  // 插件这边一切正常、只是永远连不上，用户看到的现象是「它一句话都不说」。
  // 启动时读一眼 NapCat 的配置，把原因直接写进日志（实现在 napcat.js，与一键脚本同一批函数）。
  napcatDir: z.string().default('').description('NapCat 安装目录（里面有 config/onebot11_<QQ号>.json）；留空 = 自动探测本仓库里的 NapCat.Shell 等少数几个常见位置。启动时读它做一次自检，**只读不改**'),
  napcatAutoConfig: z.boolean().default(false).description('自检发现 NapCat 那边缺一条监听 endpoint 端口的 WebSocket 服务器时，是否自动写进去（写前先备份原文件，只动 websocketServers 里我们那一条）。默认关：那是另一个软件的配置，不该被悄悄改；一键脚本 scripts/napcat-setup.mjs 会显式打开'),
  privateChat: z.boolean().default(true).description('是否响应 QQ 私聊消息'),
  groupChat: z.boolean().default(true).description('是否响应 QQ 群消息'),
  groupTrigger: z.union(['mention', 'prefix', 'all']).default('mention').description('群消息触发方式：@机器人 / 前缀 / 全部消息（另外：被叫到之后的 activeWindowMs 内，同一个人接着说的话可以算作还在跟你聊，见 activeFollow）'),
  prefix: z.string().default('/').description('groupTrigger=prefix 时使用的前缀'),
  blankReply: z.boolean().default(true).description('是否理会「没有正文」的消息：群里单纯 @ 它一下、或者私聊发一个空格 —— 这类消息照常交给模型（正文位置写明「@了你一下，没有说别的」/「发来一条空消息」），由它看着这段聊天的上下文决定回一句「？」、发张表情包、还是接上一句；false = 和以前一样静默丢弃（群里被人反复空 @ 时可以一键关掉）'),
  commands: z.boolean().default(true).description('是否启用「@bot + 空格 + 指令」的指令路由：帮助 / 天气 / 随机表情 / 表情 / 白饭 / 小作文（访客可用）、状态 / 余额 / 设置（主人专用）。关掉后这些词全部当普通聊天交给模型'),
  guestCommands: z.boolean().default(true).description('是否允许访客（非主人）使用公开指令：帮助 / 天气 / 随机表情 / 表情 / 白饭 / 小作文；关掉后只有主人能用指令。主人专用指令始终只认主人'),
  // ---- 运行模式：完整 / 简洁（私聊发「模式」切换，见 docs/commands.md）----
  // 为什么是一组模块开关而不是把功能写死：完整模式要能单独关掉一片（例如不想让它玩骰子），
  // 简洁模式则是**整套**收窄 —— 它只认固定的核心集合，这里的 module* 在简洁模式里不生效
  // （见 mode.js 的 SIMPLE_MODULES）。只收已经搬进本仓库的模块；调试 / 心情 / 软命令那几个
  // 开关等对应分片落地时再加，免得出现「配了却没有任何行为」的死字段。
  moduleFun: z.boolean().default(true).description('玩类模块：抽签 / 吃饭 / 骰子 / 硬币 / 点名 / 点歌 / 接一个 / 投票 / 复读 / 存表情等指令'),
  moduleLookup: z.boolean().default(true).description('查询模块：天气 / 余额 / 群热度 / 随机表情'),
  moduleReminders: z.boolean().default(true).description('提醒模块：`提醒` 指令（定时任务本身仍由 reminder 开关控制，关掉这一项不会让已建的任务失效）'),
  moduleTts: z.boolean().default(true).description('语音模块：`语音` 指令（还需要 tts 打开并注册 provider）'),
  moduleHandoff: z.boolean().default(true).description('定档模块：`定档` 指令'),
  simpleReplyMaxChars: z.number().default(400).description('简洁模式一次回复的硬上限（字符）：超过直接截断，避免啰嗦；0 = 不截断（协议上限仍是 maxReplyChars）'),
  fullReplyMaxChars: z.number().default(800).description('完整模式一次回复的硬上限（字符）：超过直接截断；协议上限仍是 maxReplyChars；0 = 不截断'),
  // ---- 语音（TTS）：只留框架，仓库不内置任何第三方语音服务 ----
  tts: z.boolean().default(false).description('是否启用「语音 <文字>」指令：需要先在 tts.js 里注册一个 provider（本地 Kokoro / Piper / 自建服务，或你自己的授权 API）。默认关，未注册时指令只回「未配置」，不会联网'),
  ttsMaxChars: z.number().default(200).description('一次语音最多念多少字（超过截断）：QQ 语音太长会失败，200 字大约 40 秒'),
  allowUsers: z.array(z.string()).default([]).description('私聊白名单（QQ 号）；留空表示不限制'),
  allowGroups: z.array(z.string()).default([]).description('群白名单（群号）；留空表示不限制'),
  provider: z.string().default('').description('QQ 会话使用的模型服务商；留空使用默认'),
  model: z.string().default('').description('QQ 会话使用的模型；留空使用默认'),
  approvalPolicy: z.union(['never', 'inherit']).default('never').description('QQ 会话的工具审批策略：never 表示无人值守时一律拒绝需要审批的操作'),
  agentPreset: z.string().default('qq').description('QQ 会话 Agent 挂载的 Agent 预设 id；默认 qq（本 bundle 自带：只读文件 + 检索 + 联网，没有 shell / 子代理）。留空表示用**部署的默认预设**（可能是带 shell 的 standard 预设 —— QQ 消息是不可信输入，别轻易这么配）；填 none 表示不挂载预设（QQ 会话只有宿主平面的全局工具）'),
  allowTools: z
    .array(z.string())
    .default([
      'read',
      'read_image',
      'glob',
      'grep',
      'web_search',
      'web_fetch',
      'skill',
      'qq_memory',
      'qq_transcript',
      'qq_send_message',
      'qq_send_image',
      'qq_save_sticker',
      'qq_rename_sticker',
      // 静默开关（只有主人能真正执行）：插件入口拦截，不再把群消息投给模型。
      'qq_quiet',
      // 主人侧 bot 配置（只含行为白名单，不含模型路由）。
      'qq_settings',
      // 受信写盘（只有 resetUsers 里的人能让它动）：内建 write / edit 仍然不给。
      'qq_write',
      'qq_edit',
      'qq_skill',
      'qq_list_conversations',
      'qq_poke',
      'qq_remind_create',
      'qq_remind_list',
      'qq_remind_cancel',
    ])
    .description(
      'QQ 会话 Agent 可用的工具白名单（工具名）：默认只放开「只读文件 + 检索 + 联网 + 十六个 qq_*」（23 个），没有 write / edit / bash —— QQ 消息是不可信输入；受信写盘是单独的 qq_write / qq_edit / qq_skill，执行时按发言人核对主人。留空表示**不限制**（把这个 Agent 继承到的工具全给它，含预设里的一切）；写错的名字会被丢掉并记 warn（白名单只能收窄，不能凭空给出能力）',
    ),
  resetCommand: z.string().default('/reset').description('新开一轮会话的指令：在 QQ 里单独发送该指令即生效（旧的会话留在磁盘上当存档，新的一轮从零开始）；留空表示禁用'),
  resetUsers: z.array(z.string()).default([]).description('受信者（通常是主人）的 QQ 号：名单里的人能用 resetCommand 新开一轮、能通过 qq_quiet 让机器人静默、也是唯一能让 Agent 动写盘工具（qq_write / qq_edit / qq_skill）的人。留空 = 走 ownerAutoClaim 自动认主；自动认主也关掉时表示**谁都不能**重置、静默与写盘'),
  idleResetHours: z.number().default(0).description('会话静默超过这么多小时之后，下一条消息自动开新一轮（与 resetCommand 同一套机制：换代次、旧会话留档、长期记忆不动；0 = 关闭，默认关）。它按时间自动发生，不需要 resetUsers 权限；「静默」按这个会话最后一条别人的消息算（含没 @ 机器人的闲聊）'),
  // ---- 静默模式：主人说一句「睡觉去」，模型调用 qq_quiet，插件在入口把群消息拦掉 ----
  // 与「让它回 SKIP」的区别：SKIP 仍然要为每条消息付一次模型调用；静默是**根本不投递**。
  // 入睡由模型判断（它懂语义），插件只执行；唤醒词是插件侧唯一的旁路（睡着之后群里
  // 的消息到不了模型，只能由插件直接把主人叫醒）。
  wakeTriggers: z.array(z.string()).default(['起床', '醒醒', '醒来', '别睡了', '重启']).description('主人说这些词时由**插件直接**结束静默（不经过模型、零 token）：睡着之后群消息根本到不了模型，所以起床必须有一条插件侧旁路。只认主人（resetUsers 或自动认主的那位）；群里不需要 @，私聊直接说即可。留空 = 只能靠 qq_quiet 的 wake'),
  wakeText: z.string().default('（揉揉眼睛）醒了醒了，刚睡过去。').description('插件侧唤醒时回的那一句（固定文案，不经过模型）'),
  mutePersist: z.boolean().default(true).description('静默状态是否落盘：开着时重启进程仍然安静（不会因为一次重启就在群里突然开口）；关掉 = 只记在内存里，重启即恢复'),
  muteFile: z.string().default('data/mutes.json').description('静默状态文件，相对 cwd（必须落在 cwd 内，否则只记在内存里并记一条 warn）'),
  // ---- 主人（受信者）：默认第一个在私聊里跟它说话的人 ----
  // 由 QQ 号确认，不看昵称（昵称可以随便改，号不会）。配置里写了 resetUsers 时以那份
  // 名单为准、不再自动认主；只有名单为空时才落到 ownerFile 里记下的那位。
  ownerAutoClaim: z.boolean().default(true).description('名单为空时，是否把**第一个在私聊里跟它说话的 QQ 号**认作主人（落盘到 ownerFile，重启不丢；群里说话不算）。认到之后这个号拥有最高权限：重置、静默、受信写盘。想手工指定就配 resetUsers，或把这一项关掉自己写 ownerFile'),
  ownerFile: z.string().default('data/owner.json').description('自动认主记下的主人 QQ 号，相对 cwd（必须落在 cwd 内）；只在 resetUsers 为空时生效'),
  ownerSettingsFile: z.string().default('data/owner-settings.json').description('主人从 QQ 侧调整 bot 配置的覆盖层（只含白名单键，优先于 GUI 里的基础配置）；qq_settings 读写它，删掉某个键就回到 GUI 配置'),
  // ---- 受信写盘：只有受信者能让 Agent 改文件（见 docs/tools.md「受信写盘」）----
  trustedWrite: z.boolean().default(true).description('是否注册受信写盘工具（qq_write / qq_edit / qq_skill）：只有 resetUsers 里的人在**当前这一轮**说话时才真的能写；内建 write / edit 仍然不在白名单里'),
  skillWriteDir: z.string().default('').description('qq_skill 能读写的 skill 根目录：留空 = $DSH_HOME/skills（没有 DSH_HOME 时 ~/.dsh/skills）。只允许碰 <根>/<名字>/SKILL.md，写前备份'),
  writeMaxBytes: z.number().default(65536).description('受信写盘单个文件的字节上限（默认 64KB）：超过就报错，不静默截断'),
  maxReplyChars: z.number().default(1500).description('单条 QQ 消息的最大字符数（协议上限），超出自动分段'),
  // ---- 图片/表情包：下载到本地，让 Agent 能用 read_image 真的看见 ----
  mediaDownload: z.boolean().default(true).description('是否把 QQ 消息里的图片/表情包下载到本地（模型只能读本地文件，不下载就只看到一句占位符）'),
  mediaDir: z.string().default('.qq-media').description('媒体缓存目录，相对 cwd（必须落在 cwd 内，否则自动停用下载）'),
  mediaMaxBytes: z.number().default(8 * 1024 * 1024).description('单个图片/表情包的字节上限，超过就不下载（只留占位符）'),
  mediaCacheFiles: z.number().default(200).description('媒体缓存最多保留多少个文件，超出按最近使用时间淘汰最旧的'),
  mediaTimeoutMs: z.number().default(15000).description('单个媒体的下载超时（毫秒）'),
  quoteMedia: z.boolean().default(true).description('是否把「被引用（回复）的那条消息」也取回来一起看：图片/表情包照常落盘，正文里给出「（引用 某某: …）」前缀；false = 引用段仍是 `[回复]`，什么也看不到'),
  ambientMedia: z.boolean().default(true).description('群聊环境上下文（没 @ 机器人的那几条）里的图片/表情包是否也落盘：开着时「群里最近的消息」里也带可 read_image 的路径（同一张表情包按内容哈希去重，磁盘只存一份，但每次发仍会重新下载一遍字节）'),
  // ---- 合并转发：把「谁转了什么」展开成一段有界的聊天记录 ----
  // 默认开：QQ 里的转发十有八九是「你看这个」，只给条数等于什么都没看见；但条数、
  // 字数、嵌套深度都必须有上限，否则一条几十条的转发就能把整轮上下文撑爆。
  forwardRead: z.boolean().default(true).description('是否展开合并转发（forward）的正文：打开后每条被转发的子消息渲染成「谁: 什么」，模型真的能看见内容；关掉只留 `[合并转发 N 条]` 占位符。子消息里的图也会照常落盘'),
  forwardMaxNodes: z.number().default(20).description('一条合并转发最多展开多少条子消息：超出的部分只写一句「还有 N 条没展开」'),
  forwardMaxChars: z.number().default(1200).description('一条合并转发展开后的字符上限（含开头那行）：到顶就停，避免一条长转发把整轮上下文撑爆'),
  forwardMaxDepth: z.number().default(1).description('合并转发最多展开几层：0 = 一层都不展开（只留占位符）；1 = 只展开最外层，转发里套的转发仍是占位符；2 = 再展开一层……（越深越容易撑上下文，一般不用改）'),
  forwardTimeoutMs: z.number().default(5000).description('没有内联内容、需要调 get_forward_msg 取转发内容时的超时（毫秒）：卡住就保留占位符，不拖住消息投递'),
  // ---- 表情包 / 图片：反过来，让 Agent 能主动往 QQ 发图 ----
  imageSend: z.boolean().default(true).description('是否允许 Agent 主动往 QQ 发图片/表情包：qq_send_image 工具 + 回复正文里的 `[[图片: 路径]]` 标记（整条回复只写这一行就是「只发一张表情、一个字都不说」）；关掉后两个都不可用，提示词里也不再提'),
  stickerDir: z.string().default('.qq-stickers').description('表情包目录，相对 cwd（必须落在 cwd 内）：放你给它的表情包，文件名会列进渠道提示，模型据此挑选或用 read_image 先看一眼；留空 = 不提示表情包目录（照样能发工作目录里的其它图）'),
  imageMaxBytes: z.number().default(8 * 1024 * 1024).description('单张出站图片的字节上限：超过直接报错，不做静默压缩（默认 8MB，体积会按 base64 膨胀约 4/3）'),
  stickerMaxFiles: z.number().default(60).description('表情包目录最多保留多少张：Agent 用 qq_save_sticker 存图时，目录里已经有这么多就拒绝（QQ 那头是不可信输入，群里谁都可以让它一直存，磁盘不该被这么撑大）；0 = 不限制（不建议）'),
  // ---- 感知与互动：图片 / 表情之外的几类消息（链接、视频封面、语音、戳一戳）----
  // 默认值全部偏保守：替群友访问一个任意 URL、或者一被戳就回，都是不可信输入面上的动作。
  linkPreview: z.boolean().default(false).description('正文里的裸 URL 是否抓一次标题（默认关）：打开后只抓 <title> / og:title，有 SSRF 防护（拒内网 / 回环 / 保留地址），超时与大小都有上限。卡片消息（json/xml）不联网就能解析，不受这个开关影响'),
  linkPreviewTimeoutMs: z.number().default(8000).description('抓链接标题的超时（毫秒）'),
  linkPreviewMaxBytes: z.number().default(524288).description('抓链接标题最多读多少字节（512KB）：超过就只看已读到的部分里有没有 <title>'),
  linkAllowPrivateHosts: z.boolean().default(false).description('是否允许抓内网地址（自建 wiki 之类才打开）：关着时 localhost / *.local / *.internal / 私有与保留 IP 一律拒绝'),
  videoCover: z.boolean().default(true).description('视频消息是否下载封面图（只下封面，不下整段视频）：开着时正文是「[视频 12 秒 · 封面: .qq-media/…]」，模型能 read_image 看一帧'),
  videoMaxBytes: z.number().default(0).description('整段视频的下载上限（字节）：0 = 不下载整段（默认；只有封面）。非 0 时会先校验大小再下，但插件不做转码、模型也读不了视频，一般不需要开'),
  pokeReply: z.boolean().default(true).description('被戳一戳（双击头像）时是否回应'),
  pokeMode: z.union(['random', 'poke', 'text', 'ignore']).default('random').description('怎么回应戳一戳：random = 按 pokeReplyChance 在「回戳」与「走一轮模型」之间掷（默认）；poke = 总是回戳（最快、最像群友）；text = 走一轮模型（正文是「X 戳了你一下」，允许 SKIP）；ignore = 不回'),
  pokeReplyChance: z.number().default(0.7).description('pokeMode: random 时选择「回戳」的概率（0~1）：其余情况走一轮模型'),
  pokeCooldownMs: z.number().default(30000).description('同一个会话两次回应戳一戳之间至少隔多久（毫秒）：**防回戳死循环**，冷却里不管戳几下都只回一次'),
  pokeDailyMax: z.number().default(20).description('同一个会话一天最多回应几次戳一戳（本地日界线，重启归零）；0 = 不限'),
  // ---- 被撤回的消息：假装没看到，或者调侃一下（见 docs/recall.md「被撤回的消息」）----
  // 前两项是「行为」，后八项是它的闸门与开关；清理引用（不发一条指向已撤回消息的
  // 回复）永远生效，不受这些开关影响。
  recallMode: z.union(['off', 'ignore', 'tease']).default('ignore').description('有人撤回消息时怎么处理：off = 只做安全层（清掉指向它的引用、记忆里留个标记），行为上完全不变；ignore = 假装没看到（没 @ 它的那条不再投给模型，被 @ 的照常回答、只是不引用）；tease = 在此基础上多一种反应 —— 被 @ 的那条改写成一句调侃，已经回过的补一句'),
  recallAddressed: z.union(['answer', 'drop']).default('drop').description('被 @ 的那条还没投出去就被撤回时还回不回：drop = 从待回批次里摘掉，真的不回（默认，等于「撤回 = 当没收到」）；answer = 照常回答、只是不引用（@ 是一次明确点名，摘掉等于点名了却不吭声 —— 想「撤回只影响引用」就选它；tease 时这一轮会改成调侃）'),
  recallScope: z.union(['to-me', 'all']).default('to-me').description('tease 时调侃谁：to-me = 只调侃冲它来的、或它已经回过的（默认）；all = 群里别人撤回的闲聊也调侃一句 —— 那等于当着全群承认它每条都看，语义接近主动说话，打开前先想清楚'),
  recallChance: z.number().default(0.5).description('tease 时补一句的概率（0~1）：够资格不等于一定开口，掷中了才补'),
  recallCooldownMs: z.number().default(60000).description('同一个会话两次撤回调侃之间至少隔多久（毫秒）：群里「撤回测试」是常见行为，没有这道闸会被刷成复读机'),
  recallDailyMax: z.number().default(5).description('同一个会话一天最多为撤回补几句（本地日界线，计数在内存里，重启归零）；0 = 不限'),
  recallMaxAgeMs: z.number().default(120000).description('消息发出后多久之内撤回才值得提（毫秒）：太久的撤回接一句只像复读机；0 = 不限'),
  recallTeaseQuote: z.boolean().default(false).description('调侃时要不要把被撤回的原文交给模型（默认不要）：复述别人撤掉的话是最常见的社交事故，而模型本来就有上下文'),
  recallPrivate: z.boolean().default(true).description('私聊撤回（friend_recall）要不要处理：默认处理（撤回的那条还没投给模型就不回）。关掉 = 私聊里的撤回当没发生（照常回答，只是不引用那条）—— 私聊里调侃「你撤什么」很容易变成冒犯，所以 recallMode: tease 时这一项建议关'),
  recallMemoryMark: z.boolean().default(true).description('被撤回的消息是否在长期记忆（转录）里追加一行「已撤回」标记：摘要时不会把它当成事实；关掉就是彻底的假装没看到'),
  // ---- 一次只回一轮：前后脚到的消息先攒一攒，再合成一条交给 Agent ----
  batchWindowMs: z.number().default(2000).description('收到一条要回的消息后，先等这么久（毫秒）看还有没有下一条：群里几个人同时 @、或者一个人连发几句，都会攒成一条消息只回一轮；0 = 关闭（来一条回一条）'),
  batchMaxWaitMs: z.number().default(5000).description('一直有人接着说时，一批最多攒这么久（毫秒）就必须发出去，避免机器人一直不吭声；小于 batchWindowMs 时按 batchWindowMs 算'),
  mediaHoldMs: z.number().default(1500).description('这一批里有图片 / 表情包时，在窗口之外再多等这么久（毫秒）再投给模型：QQ 里图和配文经常分两条发，多等一会儿能把「图 + 那句话」攒进同一轮，模型就能先 read_image 再回答，不会先回一句文字、图片那条又单独来一轮。0 = 不额外等'),
  // ---- 长任务期间的 @：先攒着，忙完当「一波迟到的消息」一起接 ----
  // 没有这一组的话，十分钟的长任务会按 batchMaxWaitMs 攒出上百批、上百个 turn，每批一条
  // 回复、每轮重发一遍完整上下文，而且每条都在回答几分钟前的问题（见 backlog.js）。
  batchBacklog: z.boolean().default(true).description('上一轮还没跑完时收到的 @ 是否先攒着，等它闲下来当成「一波迟到的消息」一起接（默认开）。关掉的话，它在忙时前后脚到的消息会每 batchMaxWaitMs 一批排进收件箱：几分钟的任务能攒出几十轮、几十条回复，而且每条都在回答几分钟前的问题；只在 batchWindowMs > 0 时生效'),
  batchBacklogEntries: z.number().default(20).description('一波迟到的消息最多贴几条（至少 2）：超过就保留最早 2 条 + 最近的，中间折成一句「更早还有 N 条」—— 模型要看可以自己用 qq_transcript 翻记录'),
  batchBacklogChars: z.number().default(2000).description('一波迟到的消息最多带多少字：超出时继续从最老的那条开始折掉，但永远保留最后一条（最新那句最可能还有活要干）'),
  batchBacklogHoldMs: z.number().default(120000).description('一波迟到的消息最多憋多久（毫秒，默认 2 分钟）：还忙着就先投进队列（退回「排队等它忙完」的老行为），免得它卡住时这些消息永远投不出去；0 = 不憋（等于关掉这一项）'),
  // ---- 以下为「像真人一样在群里说话」的开关，默认全部开启 ----
  ambientMessages: z.number().default(12).description('群聊里注入给 Agent 的最近消息条数（让它知道大家在聊什么，不只是被 @ 的那一句）；0 = 关闭'),
  ambientLineChars: z.number().default(120).description('群聊上下文里每条消息最多保留的字符数'),
  // ---- 自动复读：群里连着出现同一条消息时，跟着复读一句（不经过模型）----
  repeat: z.boolean().default(true).description('是否自动复读：群里连着出现相同的消息时跟着复读一句；复读不经过模型（直接发原文/原图），只认没 @ 机器人的群消息（纯文字，或整条就是一张表情包）'),
  repeatMedia: z.boolean().default(true).description('是否连表情包一起复读：整条消息就是一张图或一个系统表情时，连着出现两个一样的就跟着发第三个（图片按内容哈希判断是不是同一张）。它不额外下载：用的是环境上下文那次落盘，所以 ambientMedia: false 或 ambientMessages: 0 时自动退化成只复读文字，imageSend: false 时同样不发图'),
  repeatCount: z.number().default(2).description('连着几条相同的消息之后跟着复读；2 = 有人接了一句就跟（至少 2）'),
  repeatDistinct: z.boolean().default(true).description('是否要求这些相同的消息来自至少两个不同的人：true = 一个人自己连发两遍只是手滑，算不上复读；false = 连发两遍也跟'),
  repeatWindowMs: z.number().default(300000).description('间隔超过这么久就不算「连着」了，重新开始数（毫秒）：免得早上有人说过的一句，晚上再被跟一遍；0 = 不限间隔'),
  repeatMaxChars: z.number().default(100).description('纯文字复读的长度上限：只复读不超过这么多字的短消息（复读机跟的是「6」「草」这种短句，不是一整段话）；0 = 不限'),
  repeatChance: z.number().default(1).description('真要复读时的概率（0~1）：1 = 每次都跟，调小可以让它偶尔不跟（下一条相同的消息会再掷一次）'),
  repeatImageTolerance: z.number().default(0.08).description('表情包「算是同一张」的宽松度：QQ 会把同一张表情包按发送者重新编码（字节不同、画面一样），所以字节不同时还会比一次缩略图指纹（16×16 dHash）—— 位差比例不超过这个值就算同一张，跟着复读。0 = 只认字节完全相同的图（关掉画面比对）；默认 0.08（实测同一张重新编码差 0%~2%，同一套画风只换了字的差 16%~23%）'),
  // ---- 主动说话：不等别人 @，自己偶尔在群里开个话头 ----
  // 这一组默认**开启**：它会主动给真人发消息，所以闸门必须一直在（时段 / 安静够久 / 不是
  // 自言自语 / 群还活跃 / 距上次够久 / 当天没超次数 / 概率）。只想让它被动回话就设成 false。
  // 只对已经聊过的群生效（`conversations` 里有的群），私聊永远不会被主动打扰。
  proactive: z.boolean().default(true).description('是否让机器人偶尔主动在群里说话（不等别人 @ 它）：默认开。只对**已经聊过的群**生效（有人 @ 过它、或它回过话的群），私聊永远不主动打扰；开口前还要过「时段 / 安静够久 / 不是自言自语 / 群还活跃 / 距上次够久 / 当天没超次数 / 概率」这一串闸（安静阈值默认 45 分钟，所以刚聊完的群不会插嘴），详见 docs/proactive.md「偶尔主动说话」。只想让它被动回话就关掉'),
  proactiveCheckMs: z.number().default(10 * 60 * 1000).description('每隔多久看一次「有没有群值得主动搭句话」（毫秒）：这是「考虑」的节奏，不是说话频率 —— 每次醒来还要过一遍所有条件、再掷一次概率'),
  proactiveChance: z.number().default(0.35).description('每次检查时真的开口的概率（0~1）：0.35 ≈ 三次考虑里说一次，让开口的时刻不可预测；0 = 永不主动说话，1 = 一有机会就说'),
  proactiveIdleMs: z.number().default(45 * 60 * 1000).description('群里安静至少这么久才考虑搭话（毫秒）：正在聊的群不插嘴，等大家停了它才冒泡；0 = 不用等（一般只用于测试）'),
  proactiveFreshMs: z.number().default(24 * 60 * 60 * 1000).description('群最近活跃过才值得搭话（毫秒）：超过这么久没动静的群不会突然诈尸；0 = 不限制'),
  proactiveGapMs: z.number().default(2 * 60 * 60 * 1000).description('同一个群两次主动说话之间至少隔这么久（毫秒）'),
  proactiveDailyMax: z.number().default(4).description('同一个群一天最多主动说几次（本地日界线；计数在内存里，重启后清零）'),
  proactiveFromHour: z.number().default(9).description('只在本地时间的这个小时之后主动说话（0~23）：真人凌晨不会突然在群里冒泡'),
  proactiveToHour: z.number().default(23).description('只在这个小时之前主动说话（0~23，不含该点）：与 proactiveFromHour 相同表示全天都可以；跨零点（如 22 → 3）也认'),
  // ---- 活跃对话：聊起来之后保持搭话（见 docs/proactive.md「聊起来之后保持搭话」）----
  // 上面的 proactive* 只在**冷场**时开口；这一组管的是「正聊着」的时候：被叫到之后
  // 接着说的话也算在跟它聊（activeFollow），以及它自己回完隔一会儿再补一句（activeChime*）。
  activeWindowMs: z.number().default(60 * 1000).description('「活跃对话」窗口（毫秒）：它管两件事 —— 它回完之后这么久之内可能**补一句**；以及**多人搭话**的热度（最近这么久里累计够 activeGroupLines 条、activeGroupSpeakers 个人说过话就进入搭话状态）。一对一的免 @ 接话不看它，那是 activeFollowIdleMs。0 = 整套关闭（既不免 @ 接话，也不补一句、不搭话）'),
  activeFollow: z.boolean().default(true).description('活跃对话里**免 @ 接话**：被叫到之后，同一个人接着说的话也当成在跟它聊 —— 这段一对一里他的**每一条都会回**（不抽卡），直到 activeMaxTurns 用完或者断聊（activeFollowIdleMs）；群里聊热了（见 activeGroupLines）还会进入**多人搭话**，那一路才按 activeTalkChance 抽卡。默认开，代价是它放松了「群里只在被 @ 时才说话」这条约定（不想让人看见它接闲聊就关掉）；只在群聊生效，私聊本来就不需要 @'),
  activeFollowIdleMs: z.number().default(3 * 60 * 1000).description('免 @ 接话的断聊间隔（毫秒）：一对一的对话里，同一个人每接一句就把它往后滑这么久 —— 两条消息之间超过它，这段「你跟我聊」就算结束，要重新 @ 它一次。它只管一对一的免 @ 接话（补一句与多人搭话的热度仍看 activeWindowMs）。0 = 关掉一对一的免 @ 接话（多人搭话不受影响）'),
  activeMaxTurns: z.number().default(10).description('一次一对一的活跃对话里最多免 @ 回几条：窗口里这个人的每一条都会回，够这么多条就要重新 @ 它一次；多人搭话不看这个，它的闸门是「够条数、够人数」。0 = 不限'),
  activeTalkChance: z.number().default(0.05).description('**多人搭话**的起始概率（0~1，抽卡那套）：群里进入搭话状态之后不是每句都接，而是先掷这个概率；每多一条没抽中的消息，下一次的概率就加上 activeTalkChanceStep（「保底」越攒越高），直到 activeTalkChanceMax 封顶。掷中、或者被明确 @ 到（不用抽直接回）之后归零重新攒。一对一的免 @ 接话**不抽卡**（每句都回），这一组只影响多人搭话。0 = 起步为 0（仍会随着没抽中往上攒）'),
  activeTalkChanceStep: z.number().default(0.1).description('多人搭话里，每多一条**没抽中**的消息，搭话概率增加多少（0~1）：这就是「越聊越可能接一句」的那一步；实际概率不超过 activeTalkChanceMax'),
  activeTalkChanceMax: z.number().default(0.8).description('多人搭话概率的上限（0~1）：攒到这么多就不再涨，留一点不确定性，免得在热群里变成每条都回；配得比 activeTalkChance 还小时按起始概率算'),
  activeGroupLines: z.number().default(6).description('「多人搭话」的进入门槛：最近 activeWindowMs 里群里（除它以外）累计说了这么多条话，就说明大家聊起来了（进入之后仍按 activeTalkChance 抽卡决定接哪句）；0 = 关掉多人搭话（只保留一对一的免 @ 接话）'),
  activeGroupSpeakers: z.number().default(2).description('「多人搭话」还要求最近窗口里至少有这么多**不同的人**说过话：两个人有来有回才算聊起来，一个人自己刷屏不算（与 activeGroupLines 同时满足才进入）'),
  activeGroupBatchScale: z.number().default(2).description('搭话状态里的「倾听时间」倍数：攒批窗口与整批等待上限都乘上它，于是它会多听几句、再合成一轮回复（1 = 不放大，只在群聊的搭话状态里生效）'),
  activeChimeIdleMs: z.number().default(20 * 1000).description('它回完话、对方安静这么久之后，它可能自己再补一句（毫秒，实际会按 delayJitter 抖动）；0 = 不补。需要 proactive: true 才会补'),
  activeChimeMax: z.number().default(1).description('对方每说一句之后，它最多自己补几句：1 = 顶多追一句「啊对了…」，想让它更黏就调大；0 = 不补'),
  activeChimeDailyMax: z.number().default(12).description('同一个会话一天最多自己补几句（本地日界线，与 proactiveDailyMax 分开算；重启后计数清零）；0 = 不限'),
  // ---- 定时提醒：到点由插件发一条消息，并可 @ 指定的人（见 docs/reminders.md）----
  // 这是唯一一个「机器人会在未来某个时刻主动开口」的功能，所以默认值按两条收：
  // 默认只能提醒创建者自己、@全体默认关、每人每天有额度；agent/prompt 模式再叠一层开关。
  reminder: z.boolean().default(true).description('是否启用定时提醒：Agent 可以用 qq_remind_create 建一条到点发送的任务（一次性或每天/工作日/每周/每月），到点由插件直接发消息，不依赖模型醒着；关掉后工具不注册、已有任务留在文件里不丢'),
  reminderFile: z.string().default('data/reminders.json').description('定时提醒的任务文件，相对 cwd（必须落在 cwd 内，否则整个功能记 warn 并停用）；任务在这里持久化，重启不丢'),
  reminderUsers: z.array(z.string()).default([]).description('允许创建提醒的 QQ 号白名单；留空表示不限制（与 allowUsers 同语义）。名单里的人额外视为受信者：可以 @ 别人、可以指定别的会话、可以建 prompt 模式'),
  reminderMentionOthers: z.boolean().default(false).description('是否允许提醒 @ 创建者以外的人：默认关（群里任何人都能让机器人在未来某个时刻点名别人，这比即时 @ 更敏感）；reminderUsers 里的受信者不受这一项限制'),
  reminderAllowAll: z.boolean().default(false).description('是否允许提醒 @全体成员：默认关，且只有受信者（reminderUsers 里的人或 Web 操作员）能用；群里的定时 @全体 是最容易被滥用的组合'),
  reminderDailyMax: z.number().default(5).description('同一个人一天最多新建几条提醒（本地日界线；按任务文件里今天的记录算，重启不会清零）；0 = 不限。Web 操作员不受这一项限制'),
  reminderMaxActive: z.number().default(20).description('同一个会话最多同时有多少条待发的提醒：满了就拒绝新建，直到发掉或取消；至少 1'),
  reminderGraceMs: z.number().default(600000).description('补发窗口（毫秒）：进程重启 / 断线导致错过时刻时，超过这么久就不再补发，只把任务标成 missed；默认 10 分钟'),
  reminderModes: z.union(['text', 'agent', 'prompt']).default('agent').description('允许的最高模式：text = 只发固定文案（最可靠、不花 token）；agent = 到点跑一轮模型，把文案用它的语气说出来，失败/超时/SKIP 时退回固定文案；prompt = 到点按指令做事（可调工具，默认关闭，只给受信者）。默认 agent：text 永远是兜底，agent 只是让语气自然一点'),
  reminderAgentTimeoutMs: z.number().default(120000).description('agent/prompt 模式的硬超时（毫秒）：超过这么久模型还没给出可发送的正文，就发固定文案（prompt 模式没有兜底文案时按任务设置丢弃），迟到的回复不再发送'),
  reminderAgentDailyMax: z.number().default(20).description('同一个会话一天最多跑几次 Agent 提醒（本地日界线）：超过之后新的 agent/prompt 提醒自动退回固定文案；0 = 不限。text 模式不计入'),
  humanize: z.boolean().default(true).description('自动回复是否像真人：按换行/短句拆成几条独立消息并加入打字延迟（换行 = 分条）；false = 一条整段直接发出（旧行为）'),
  burstMaxChars: z.number().default(60).description('把一行长句拆开时的单条目标长度；0 = 不按长度拆（换行仍然分条）'),
  burstMaxParts: z.number().default(3).description('单行长句最多拆成几条；超出部分并进该行最后一条，避免刷屏'),
  burstMaxMessages: z.number().default(0).description('一轮回复最多发几条消息（连换行分出来的那些一起算）：1 = 永远只发一条（换行与长句都并进这一条，超出的用一个空格接上）；0 = 不限（默认）。这是唯一保留的条数上限，默认关着 —— 关着时模型写几条就发几条'),
  burstSingleMaxChars: z.number().default(100).description('「聊天型 / 信息型」的字数门槛（去掉空白后算）：不超过它就按聊天型处理 —— 发送途中对方又说话了，剩下的气泡不再发；超过就按信息型完整发完（贴代码 / 列步骤 / 解释一件事时该讲完的讲完）。0 = 全部按聊天型'),
  privateTyping: z.boolean().default(true).description('私聊里显示「对方正在输入」：从它开始准备回复（模型思考也算）到消息真正发出去，对方的 QQ 上会一直显示「正在输入」；需要协议端支持 set_input_status（NapCat 支持），不支持时只记一条 warn 并自动停用。群聊不显示'),
  readDelayMs: z.number().default(800).description('发出第一条前的「读消息」基础延迟（毫秒）'),
  charsPerSecond: z.number().default(15).description('模拟打字速度（字符/秒），用于按字数计算每条消息发出前的延迟'),
  minDelayMs: z.number().default(300).description('单条消息前延迟的下限（毫秒）'),
  maxDelayMs: z.number().default(5000).description('单条消息前延迟的上限（毫秒）'),
  delayJitter: z.number().default(0.4).description('延迟的随机抖动比例（0 = 固定延迟，0.4 = 上下浮动 40%）'),
  replyStyle: z.union(['auto', 'plain', 'quote', 'at']).default('auto').description('群聊回复的指向方式：auto = 只在「回的那条后面又出现了消息（包括我自己发的）」时才引用（默认），quote = 引用被回复的那条消息，at = @ 对方，plain = 直接发；指向只挂在第一条上，私聊始终为 plain'),
  persona: z.string().default('').description('旧人设（回退用）：整段替换默认的「群友口吻」段落，可以写多行。人设优先读 personaFile 指向的文件（默认 cwd/.qq-persona/PERSONA.md）：那个文件存在且能解析时这一项不生效（启动日志会说明人设来自文件还是配置）；两者都没有才用插件内置的那份'),
  instructions: z.string().default('').description('额外要求：可以写多行，追加到 QQ 会话系统提示的末尾；与内置口吻叠加，不替换任何东西'),
  // ---- 人格与表达：人设 = 「是谁」，风格 = 「怎么说」（见 docs/persona-style.md「人格与表达」）----
  // 两者都放 cwd 里的文件，只有部署者能改（QQ 会话没有写权限）：群里任何人能改人设
  // 就等于一次 prompt 注入。文件是热读的（每次装配提示词现读），改完不用重启。
  personaFile: z.string().default('.qq-persona/PERSONA.md').description('人设文件，相对 cwd（必须落在 cwd 内）：分「身份 / 背景 / 性格 / 场景」四节，性格按「底色 / 点缀」分层。留空或文件不存在 = 用下面 persona 那一段（旧行为），再没有就用内置人设'),
  personaMaxChars: z.number().default(4000).description('人设文件最多读多少字符：超过就截断并记一条 warn（提示词预算，别让人设文件把上下文撑爆）'),
  personaSceneOverlays: z.boolean().default(true).description('是否按场景叠加人设文件里的「私聊 / 群聊 / 主动搭话 / 被戳一戳」四段；false = 四个场景共用一套（排查「某段人设没生效」时用）'),
  styleFile: z.string().default('.qq-persona/STYLE.md').description('表达规则文件，相对 cwd（必须落在 cwd 内）：只写「怎么说」的散文（气泡数、标点、表情、简答），机器参数在下面这些 burst* / stripShortPeriod 里。留空或文件不存在 = 只用内置契约'),
  styleMaxChars: z.number().default(2000).description('表达规则文件最多读多少字符：超过就截断并记 warn'),
  stripShortPeriod: z.boolean().default(true).description('短气泡句末的「。」是否在发送前剥掉（默认开）：只动句末唯一的一个「。」，不碰「！？…～」、不碰句中、不碰长气泡。这是唯一一条机械标点规则 —— 逗号绝不做字符串替换（会改动断句与语义）'),
  shortPeriodMaxChars: z.number().default(40).description('「短气泡」的字数门槛（去掉空白后算）：不超过它的气泡才剥句末句号；长气泡保持正常标点'),
  privateAfterthought: z.boolean().default(true).description('私聊「补一句」（默认开）：回完对方、对方安静一小会儿之后，最多再主动开一轮，看还有没有想补充的（可 SKIP）。只对私聊生效；群聊的补一句是 activeChime*，跟着 proactive 那个总开关走。它属于「主动给真人发消息」，不满足条件时静默跳过'),
  privateAfterthoughtChance: z.number().default(0.3).description('私聊补一句的概率（0~1）：静下来之后先掷这个，再开那一轮'),
  privateAfterthoughtIdleMs: z.number().default(15000).description('对方安静多久之后才考虑补一句（毫秒，会按 delayJitter 抖动）：太早补会像抢话'),
  privateAfterthoughtDailyMax: z.number().default(10).description('同一个私聊一天最多补几句（本地日界线，重启归零）；0 = 不限（不建议）'),
  // ---- 长期记忆：聊天记录落盘 + 定时摘要 + 认知库（见 docs/memory.md「长期记忆」）----
  memory: z.boolean().default(true).description('是否启用长期记忆：把聊天记录写进 memoryDir、每天在 digestAtHour 点让一个专用「摘要 Agent」写成摘要与认知，并提供 qq_transcript / qq_memory 工具（配套 skill 在 .dsh/skills/ 里）'),
  memoryDir: z.string().default('.qq-memory').description('长期记忆目录，相对 cwd（必须落在 cwd 内）：聊天记录、摘要、认知库都在这里；同时充当 qq_memory / qq_transcript 的写入边界'),
  memoryFileMaxBytes: z.number().default(32768).description('单个记忆文件的字节上限：超过时 qq_memory 的 write / append 都会报错；热层超过 memoryArchiveRatio 时由滚档把最不活跃的条目挪进 archive/（不再靠删条目）'),
  memoryPromptChars: z.number().default(6000).description('每轮注入提示词的记忆预算（字符）：按「和当前消息的相关度」检索后按节配额打包，不再是文件开头截断；0 或非法值退回 6000'),
  memoryRecallK: z.number().default(12).description('每轮最多取多少条检索结果：人物与「消息里原样出现的梗」是必进的，其余按相关度+活跃度排序后取前 K 条'),
  memoryPeopleMax: z.number().default(20).description('每轮最多注入多少个人物（PEOPLE.md 里的全局人物表）：够资格的人物全量给，一人一行；0 = 不注入人物'),
  memoryArchive: z.boolean().default(true).description('是否启用冷层归档：热层 MEMORY.md 超过 memoryFileMaxBytes × memoryArchiveRatio 时，把最不活跃的非置顶条目挪进 archive/YYYY-MM.md —— 条目只是变冷，不再被删掉；qq_memory search 仍然搜得到'),
  memoryArchiveRatio: z.number().default(0.75).description('热层占 memoryFileMaxBytes 的比例：超过它就开始滚档（夹在 0.1~1；默认 0.75）。归到冷层的条目按「最近命中 / 事实日期 / 文件位置」挑最不活跃的'),
  memoryVocabHint: z.boolean().default(true).description('是否在提示词里附一行「全部梗的写法」词汇表（不给含义，只让模型知道这些写法存在，听不懂时能主动 qq_memory search）：这是最便宜的一道防「不懂装懂」保险'),
  memorySearchHits: z.number().default(40).description('qq_transcript / qq_memory 一次 search 最多返回多少条命中'),
  digestAtHour: z.number().default(4).description('每天几点做长期记忆的摘要（本地时间，0~23）：默认凌晨 4 点，群里没人说话的时候。同一个会话**一天至多摘要一次**（靠记忆目录里记的日期，重启也不会重复）；没有新消息的会话直接跳过'),
  digestMinLines: z.number().default(20).description('当天攒够多少条新消息才值得为这个会话跑一次摘要：不够就留到明天，避免为零星几句花费一次模型调用（首次摘要不受此限）'),
  digestMaxChars: z.number().default(24000).description('一次摘要最多把多少字符的聊天记录喂给摘要 Agent：超出部分按最近优先截断（更早的内容留给上一次摘要）'),
  digestTimeoutMs: z.number().default(10 * 60 * 1000).description('单次摘要的硬超时（毫秒）：超时就把摘要 Agent 销毁（下次重开一个），避免一个卡住的 turn 让摘要永远不再发生'),
  digestCatchUp: z.boolean().default(true).description('是否补课：如果今天的摘要点已经过了、而某个会话在重启之后才有人说话（或者摘要那一刻进程正在重启），它一开口就补一次摘要，不用等到明天；关掉则只在 digestAtHour 点摘要'),
  digestRollover: z.boolean().default(true).description('摘要之后是否执行滚档：热层超过阈值就把最不活跃的条目先写进 archive/ 再从热层删掉（写归档失败时热层原样不动）。关掉后热层只能靠模型自己整理，文件会一直顶到 memoryFileMaxBytes'),
  digestConsolidate: z.boolean().default(false).description('摘要之后是否再跑一次「周合并」：合并重复事实、刷新人物 one-liner、清掉过期计划（多一次模型调用，默认关）。它只是让文件更整齐，不开也不会丢记忆'),
  // ---- 每天轮换模型凭据（见 docs/ops.md「每天轮换 API key」）----
  // 池子是一个 cwd 里的纯文本文件而不是配置项：配置会显示在 Web UI 上、也会被复制粘贴到
  // 别处，key 不该走那条路（见 docs/security.md「安全提醒」）。
  apiKeyRotate: z.boolean().default(true).description('是否每天在 apiKeyRotateHour 点尝试把 apiKeyRef 指向的模型凭据换成 apiKeyFile 里的下一个 key：只在池子里还有「另一个探测通过的 key」时才真的改写凭据，池子文件不存在 / 只写了当前这一个 key 时什么都不做'),
  apiKeyRotateHour: z.number().default(4).description('每天几点尝试轮换模型凭据（本地时间，0~23）：默认凌晨 4 点，与长期记忆的摘要同一个时刻'),
  apiKeyFile: z.string().default('data/api-keys.txt').description('候选 API key 池：一行一个 key，`#` 开头的行是注释；相对 cwd（必须落在 cwd 内，否则整个轮换记 warn 并停用）。当前生效的 key 在池子里的下一个就是第一个候选'),
  apiKeyRef: z.string().default('DEEPSEEK_API_KEY').description('要轮换的那个凭据引用名：写进 $DSH_HOME/.credentials.yaml 的就是它（必须是 A-Za-z_ 开头的变量名写法）'),
  apiKeyProbeUrl: z.string().default('https://api.deepseek.com/models').description('切换前先 GET 一下候选 key 是否可用（2xx 才算可用，不消耗 token）；留空 = 不探测、直接按顺序换下一个。DeepSeek 的 OpenAI 兼容面用 Authorization 头、Anthropic 面用 x-api-key，插件两个头一起带'),
  apiKeyProbeTimeoutMs: z.number().default(15000).description('探测单个候选 key 的超时（毫秒）；网络不通时按「这个候选不可用」处理，继续试下一个'),
// 根 volatile：整份配置一个稳定引用（理由见文件头的注释）。
}).volatile();
