/**
 * 插件配置的 schema —— **配置的唯一真相来源**。
 *
 * 放在单独的文件里而不是 `index.js` 里，是因为它是一份纯数据：不碰闭包状态、不依赖
 * 任何运行时，却有一百多条带中文 `.description()` 的字段（那些描述就是 Web UI 上给
 * 使用者看的文档）。混在运行时逻辑里时，改一个默认值要先翻过半屏的 if。
 *
 * 加配置项的三处同步（别漏）：这里的字段 + `index.js` 读数 + README 配置表。
 *
 * @module @qqbot/dsh-plugin-qq/config
 */
import z from '@deepseek-ai/schemastery';


/**
 * 插件配置的校验 schema（bundle 的 config: 段或 Web UI 插件设置里填写）。
 * 这里同时充当配置文档：每个字段的 .description 会显示在界面上给使用者看。
 */
export const Config = z.object({
  endpoint: z.string().default('ws://127.0.0.1:3001').description('OneBot v11 正向 WebSocket 地址（NapCat 的 websocketServers 端口）'),
  accessToken: z.string().default('').description('OneBot access_token；NapCat 未设置 token 时留空'),
  cwd: z.string().default('').description('QQ 会话 Agent 的工作目录；留空则使用 Harness 进程的当前目录'),
  privateChat: z.boolean().default(true).description('是否响应 QQ 私聊消息'),
  groupChat: z.boolean().default(true).description('是否响应 QQ 群消息'),
  groupTrigger: z.union(['mention', 'prefix', 'all']).default('mention').description('群消息触发方式：@机器人 / 前缀 / 全部消息（另外：被叫到之后的 activeWindowMs 内，同一个人接着说的话可以算作还在跟你聊，见 activeFollow）'),
  prefix: z.string().default('/').description('groupTrigger=prefix 时使用的前缀'),
  allowUsers: z.array(z.string()).default([]).description('私聊白名单（QQ 号）；留空表示不限制'),
  allowGroups: z.array(z.string()).default([]).description('群白名单（群号）；留空表示不限制'),
  provider: z.string().default('').description('QQ 会话使用的模型服务商；留空使用默认'),
  model: z.string().default('').description('QQ 会话使用的模型；留空使用默认'),
  approvalPolicy: z.union(['never', 'inherit']).default('never').description('QQ 会话的工具审批策略：never 表示无人值守时一律拒绝需要审批的操作'),
  agentPreset: z.string().default('').description('QQ 会话 Agent 挂载的 Agent 预设 id（本 bundle 自带 qq：只读文件 + 检索 + 联网）；留空表示用部署的默认预设；填 none 表示不挂载预设（QQ 会话将只有宿主平面的全局工具）'),
  allowTools: z.array(z.string()).default([]).description('QQ 会话 Agent 可用的工具白名单（工具名）；留空表示不限制，非空时未列出的工具一律对 QQ 会话隐藏'),
  resetCommand: z.string().default('/reset').description('新开一轮会话的指令：在 QQ 里单独发送该指令即生效（旧的会话留在磁盘上当存档，新的一轮从零开始）；留空表示禁用'),
  resetUsers: z.array(z.string()).default([]).description('允许使用 resetCommand 的 QQ 号白名单；留空表示**谁都不能**重置（群里任何一个人都能把会话记忆重置掉显然不合适，所以这一项默认就是关的）'),
  maxReplyChars: z.number().default(1500).description('单条 QQ 消息的最大字符数（协议上限），超出自动分段'),
  // ---- 图片/表情包：下载到本地，让 Agent 能用 read_image 真的看见 ----
  mediaDownload: z.boolean().default(true).description('是否把 QQ 消息里的图片/表情包下载到本地（模型只能读本地文件，不下载就只看到一句占位符）'),
  mediaDir: z.string().default('.qq-media').description('媒体缓存目录，相对 cwd（必须落在 cwd 内，否则自动停用下载）'),
  mediaMaxBytes: z.number().default(8 * 1024 * 1024).description('单个图片/表情包的字节上限，超过就不下载（只留占位符）'),
  mediaCacheFiles: z.number().default(200).description('媒体缓存最多保留多少个文件，超出按最近使用时间淘汰最旧的'),
  mediaTimeoutMs: z.number().default(15000).description('单个媒体的下载超时（毫秒）'),
  quoteMedia: z.boolean().default(true).description('是否把「被引用（回复）的那条消息」也取回来一起看：图片/表情包照常落盘，正文里给出「（引用 某某: …）」前缀；false = 引用段仍是 `[回复]`，什么也看不到'),
  ambientMedia: z.boolean().default(true).description('群聊环境上下文（没 @ 机器人的那几条）里的图片/表情包是否也落盘：开着时「群里最近的消息」里也带可 read_image 的路径（同一张表情包按内容哈希去重，磁盘只存一份，但每次发仍会重新下载一遍字节）'),
  // ---- 表情包 / 图片：反过来，让 Agent 能主动往 QQ 发图 ----
  imageSend: z.boolean().default(true).description('是否允许 Agent 主动往 QQ 发图片/表情包：qq_send_image 工具 + 回复正文里的 `[[图片: 路径]]` 标记（整条回复只写这一行就是「只发一张表情、一个字都不说」）；关掉后两个都不可用，提示词里也不再提'),
  stickerDir: z.string().default('.qq-stickers').description('表情包目录，相对 cwd（必须落在 cwd 内）：放你给它的表情包，文件名会列进渠道提示，模型据此挑选或用 read_image 先看一眼；留空 = 不提示表情包目录（照样能发工作目录里的其它图）'),
  imageMaxBytes: z.number().default(8 * 1024 * 1024).description('单张出站图片的字节上限：超过直接报错，不做静默压缩（默认 8MB，体积会按 base64 膨胀约 4/3）'),
  // ---- 一次只回一轮：前后脚到的消息先攒一攒，再合成一条交给 Agent ----
  batchWindowMs: z.number().default(1200).description('收到一条要回的消息后，先等这么久（毫秒）看还有没有下一条：群里几个人同时 @、或者一个人连发几句，都会攒成一条消息只回一轮；0 = 关闭（来一条回一条）'),
  batchMaxWaitMs: z.number().default(5000).description('一直有人接着说时，一批最多攒这么久（毫秒）就必须发出去，避免机器人一直不吭声；小于 batchWindowMs 时按 batchWindowMs 算'),
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
  // 这一组默认**关闭**：它会主动给真人发消息，开不开、开给哪些群该由使用者决定。
  // 只对已经聊过的群生效（`conversations` 里有的群），私聊永远不会被主动打扰。
  proactive: z.boolean().default(false).description('是否让机器人偶尔主动在群里说话（不等别人 @ 它）：默认关闭。只对**已经聊过的群**生效（有人 @ 过它、或它回过话的群），私聊永远不主动打扰；开了之后还要过「时段 / 安静够久 / 不是自言自语 / 群还活跃 / 距上次够久 / 当天没超次数 / 概率」这一串闸，详见 README「偶尔主动说话」'),
  proactiveCheckMs: z.number().default(10 * 60 * 1000).description('每隔多久看一次「有没有群值得主动搭句话」（毫秒）：这是「考虑」的节奏，不是说话频率 —— 每次醒来还要过一遍所有条件、再掷一次概率'),
  proactiveChance: z.number().default(0.35).description('每次检查时真的开口的概率（0~1）：0.35 ≈ 三次考虑里说一次，让开口的时刻不可预测；0 = 永不主动说话，1 = 一有机会就说'),
  proactiveIdleMs: z.number().default(45 * 60 * 1000).description('群里安静至少这么久才考虑搭话（毫秒）：正在聊的群不插嘴，等大家停了它才冒泡；0 = 不用等（一般只用于测试）'),
  proactiveFreshMs: z.number().default(24 * 60 * 60 * 1000).description('群最近活跃过才值得搭话（毫秒）：超过这么久没动静的群不会突然诈尸；0 = 不限制'),
  proactiveGapMs: z.number().default(2 * 60 * 60 * 1000).description('同一个群两次主动说话之间至少隔这么久（毫秒）'),
  proactiveDailyMax: z.number().default(4).description('同一个群一天最多主动说几次（本地日界线；计数在内存里，重启后清零）'),
  proactiveFromHour: z.number().default(9).description('只在本地时间的这个小时之后主动说话（0~23）：真人凌晨不会突然在群里冒泡'),
  proactiveToHour: z.number().default(23).description('只在这个小时之前主动说话（0~23，不含该点）：与 proactiveFromHour 相同表示全天都可以；跨零点（如 22 → 3）也认'),
  // ---- 活跃对话：聊起来之后保持搭话（见 README「聊起来之后保持搭话」）----
  // 上面的 proactive* 只在**冷场**时开口；这一组管的是「正聊着」的时候：被叫到之后
  // 接着说的话也算在跟它聊（activeFollow），以及它自己回完隔一会儿再补一句（activeChime*）。
  activeWindowMs: z.number().default(60 * 1000).description('「活跃对话」窗口（毫秒）：被 @ 到之后这么久之内，同一个人接着说的话算还在跟它聊；「多人搭话」也用它 —— 最近这么久里累计够 activeGroupLines 条、activeGroupSpeakers 个人说过话就进入搭话状态，之后群里谁接话都算。0 = 整套关闭（既不免 @ 接话，也不补一句、不搭话）'),
  activeFollow: z.boolean().default(false).description('活跃对话里**免 @ 接话**：被叫到之后的窗口内同一个人接着说的话也当成在跟它聊；群里聊热了（见 activeGroupLines）还会进入**多人搭话** —— 那时候谁接话都免 @，直到最近这段时间里凑不齐 activeGroupSpeakers 个人（默认关闭 —— 它放松了「群里只在被 @ 时才说话」这条默认约定，想更像真人再打开）；只在群聊生效，私聊本来就不需要 @'),
  activeMaxTurns: z.number().default(10).description('一次一对一的活跃对话里最多免 @ 接几轮（按免 @ 进来的消息条数算）：接够这么多就要重新 @ 它一次；多人搭话不看这个，它的闸门是「够条数、够人数」。0 = 不限'),
  activeGroupLines: z.number().default(6).description('「多人搭话」的进入门槛：最近 activeWindowMs 里群里（除它以外）累计说了这么多条话，就说明大家聊起来了；0 = 关掉多人搭话（只保留一对一的免 @ 接话）'),
  activeGroupSpeakers: z.number().default(2).description('「多人搭话」还要求最近窗口里至少有这么多**不同的人**说过话：两个人有来有回才算聊起来，一个人自己刷屏不算（与 activeGroupLines 同时满足才进入）'),
  activeGroupBatchScale: z.number().default(2).description('搭话状态里的「倾听时间」倍数：攒批窗口与整批等待上限都乘上它，于是它会多听几句、再合成一轮回复（1 = 不放大，只在群聊的搭话状态里生效）'),
  activeChimeIdleMs: z.number().default(20 * 1000).description('它回完话、对方安静这么久之后，它可能自己再补一句（毫秒，实际会按 delayJitter 抖动）；0 = 不补。需要 proactive: true 才会补'),
  activeChimeMax: z.number().default(1).description('对方每说一句之后，它最多自己补几句：1 = 顶多追一句「啊对了…」，想让它更黏就调大；0 = 不补'),
  activeChimeDailyMax: z.number().default(12).description('同一个会话一天最多自己补几句（本地日界线，与 proactiveDailyMax 分开算；重启后计数清零）；0 = 不限'),
  humanize: z.boolean().default(true).description('自动回复是否像真人：按换行/短句拆成几条独立消息并加入打字延迟（换行 = 分条）；false = 一条整段直接发出（旧行为）'),
  burstMaxChars: z.number().default(60).description('把一行长句拆开时的单条目标长度；0 = 不按长度拆（换行仍然分条）'),
  burstMaxParts: z.number().default(3).description('单行长句最多拆成几条；超出部分并进该行最后一条，避免刷屏'),
  burstMaxMessages: z.number().default(0).description('一轮回复最多发几条消息（连换行分出来的那些一起算）：1 = 永远只发一条（换行与长句都并进这一条，超出的用一个空格接上）；0 = 不限（默认，换行 = 分条）。注意「不超过 burstSingleMaxChars 字的短回复」优先级更高：那种回复无论这里填几都只发一条'),
  burstSingleMaxChars: z.number().default(0).description('「日常闲聊并成一条」的字数门槛（去掉空白后算）：整轮回复不超过这么多字时并成一条发出去（模型爱写成「短句 + 长句」两拍，这个门槛保证闲聊永远只有一个气泡）；超过门槛就按换行 / burstMaxChars / burstMaxParts / burstMaxMessages 正常拆成多条短句（需要展开讲的时候用）；0 = 关掉这条豁免（完全按 burstMaxMessages 走）'),
  readDelayMs: z.number().default(800).description('发出第一条前的「读消息」基础延迟（毫秒）'),
  charsPerSecond: z.number().default(15).description('模拟打字速度（字符/秒），用于按字数计算每条消息发出前的延迟'),
  minDelayMs: z.number().default(300).description('单条消息前延迟的下限（毫秒）'),
  maxDelayMs: z.number().default(5000).description('单条消息前延迟的上限（毫秒）'),
  delayJitter: z.number().default(0.4).description('延迟的随机抖动比例（0 = 固定延迟，0.4 = 上下浮动 40%）'),
  replyStyle: z.union(['auto', 'plain', 'quote', 'at']).default('auto').description('群聊回复的指向方式：auto = 只在「回的那条后面又出现了消息（包括我自己发的）」时才引用（默认），quote = 引用被回复的那条消息，at = @ 对方，plain = 直接发；指向只挂在第一条上，私聊始终为 plain'),
  persona: z.string().default('').description('替换默认的「群友口吻」段落；留空使用插件内置的那份'),
  instructions: z.string().default('').description('追加到 QQ 会话系统提示的额外要求'),
  // ---- 禁漫（JM / 18comic）下载 → PDF → 发到 QQ ----
  // 依赖外部 python：见 README「禁漫下载」。关掉 jmDownload 后一条网络请求都不会发。
  jmDownload: z.boolean().default(true).description('是否启用禁漫（JM）下载：把整本/单话合并成 PDF 并发到 QQ'),
  jmCommand: z.string().default('/jm').description('QQ 里直接触发下载的指令（如 `/jm 422866`，也接受 18comic 链接）；留空表示禁用该指令，只保留 Agent 工具'),
  jmDir: z.string().default('.qq-jm').description('禁漫 PDF 的存放目录，相对 cwd（必须落在 cwd 内，否则自动停用）'),
  jmPython: z.string().default('.venv/bin/python').description('跑 jmcomic 的 python 解释器：绝对路径，或相对 cwd（仓库自带 .venv）'),
  jmScript: z.string().default('').description('下载脚本路径；留空使用插件自带的 scripts/jm_download.py'),
  jmMaxChapters: z.number().default(0).description('整本下载的话数上限；0 = 不限制（超出时回一句提示而不是闷头下几百话）'),
  jmMaxPages: z.number().default(0).description('单次下载的总页数上限；0 = 不限制'),
  jmTimeoutMs: z.number().default(15 * 60 * 1000).description('单次下载的硬超时（毫秒），到点强杀 python 子进程'),
  jmRequestTimeoutMs: z.number().default(30000).description('jmcomic 单次 HTTP 请求超时（毫秒）'),
  jmUploadTimeoutMs: z.number().default(10 * 60 * 1000).description('把 PDF 交给 NapCat 上传的超时（毫秒）；NapCat 拉完文件才回响应，大文件要慢慢等'),
  jmMaxFiles: z.number().default(20).description('PDF 目录最多保留几个文件，超出按最近使用时间淘汰最旧的'),
  jmMaxJobs: z.number().default(1).description('同时进行的下载数上限（多个会话同时点车时排队，而不是一起压到禁漫）'),
  jmFileHost: z.string().default('172.17.0.1').description('NapCat 取 PDF 时访问的地址：容器里要能连到宿主机，默认 docker 网桥 172.17.0.1（只在本机容器网段可达）'),
  jmFilePort: z.number().default(0).description('给 NapCat 用的 HTTP 文件服务端口；0 = 由系统分配'),
  jmUrlTtlMs: z.number().default(10 * 60 * 1000).description('交给 NapCat 的一次性下载 URL 有效期（毫秒）'),
  // ---- 长期记忆：聊天记录落盘 + 定时摘要 + 认知库（见 README「长期记忆」）----
  memory: z.boolean().default(true).description('是否启用长期记忆：把聊天记录写进 memoryDir、每天在 digestAtHour 点让一个专用「摘要 Agent」写成摘要与认知，并提供 qq_transcript / qq_memory 工具（配套 skill 在 .dsh/skills/ 里）'),
  memoryDir: z.string().default('.qq-memory').description('长期记忆目录，相对 cwd（必须落在 cwd 内）：聊天记录、摘要、认知库都在这里；同时充当 qq_memory / qq_transcript 的写入边界'),
  memoryFileMaxBytes: z.number().default(32768).description('单个记忆文件的字节上限：超过时 qq_memory 的 write 会报错，append 也只按剩余空间写入，逼着摘要 Agent 保持精炼'),
  memorySearchHits: z.number().default(40).description('qq_transcript / qq_memory 一次 search 最多返回多少条命中'),
  digestAtHour: z.number().default(4).description('每天几点做长期记忆的摘要（本地时间，0~23）：默认凌晨 4 点，群里没人说话的时候。同一个会话**一天至多摘要一次**（靠记忆目录里记的日期，重启也不会重复）；没有新消息的会话直接跳过'),
  digestMinLines: z.number().default(20).description('当天攒够多少条新消息才值得为这个会话跑一次摘要：不够就留到明天，避免为零星几句花费一次模型调用（首次摘要不受此限）'),
  digestMaxChars: z.number().default(24000).description('一次摘要最多把多少字符的聊天记录喂给摘要 Agent：超出部分按最近优先截断（更早的内容留给上一次摘要）'),
  digestTimeoutMs: z.number().default(10 * 60 * 1000).description('单次摘要的硬超时（毫秒）：超时就把摘要 Agent 销毁（下次重开一个），避免一个卡住的 turn 让摘要永远不再发生'),
  digestCatchUp: z.boolean().default(true).description('是否补课：如果今天的摘要点已经过了、而某个会话在重启之后才有人说话（或者摘要那一刻进程正在重启），它一开口就补一次摘要，不用等到明天；关掉则只在 digestAtHour 点摘要'),
  // ---- 每天轮换模型凭据（见 README「每天轮换 API key」）----
  // 池子是一个 cwd 里的纯文本文件而不是配置项：配置会显示在 Web UI 上、也会被复制粘贴到
  // 别处，key 不该走那条路（见 README「安全提醒」）。
  apiKeyRotate: z.boolean().default(true).description('是否每天在 apiKeyRotateHour 点尝试把 apiKeyRef 指向的模型凭据换成 apiKeyFile 里的下一个 key：只在池子里还有「另一个探测通过的 key」时才真的改写凭据，池子文件不存在 / 只写了当前这一个 key 时什么都不做'),
  apiKeyRotateHour: z.number().default(4).description('每天几点尝试轮换模型凭据（本地时间，0~23）：默认凌晨 4 点，与长期记忆的摘要同一个时刻'),
  apiKeyFile: z.string().default('data/api-keys.txt').description('候选 API key 池：一行一个 key，`#` 开头的行是注释；相对 cwd（必须落在 cwd 内，否则整个轮换记 warn 并停用）。当前生效的 key 在池子里的下一个就是第一个候选'),
  apiKeyRef: z.string().default('DEEPSEEK_API_KEY').description('要轮换的那个凭据引用名：写进 $DSH_HOME/.credentials.yaml 的就是它（必须是 A-Za-z_ 开头的变量名写法）'),
  apiKeyProbeUrl: z.string().default('https://api.deepseek.com/models').description('切换前先 GET 一下候选 key 是否可用（2xx 才算可用，不消耗 token）；留空 = 不探测、直接按顺序换下一个。DeepSeek 的 OpenAI 兼容面用 Authorization 头、Anthropic 面用 x-api-key，插件两个头一起带'),
  apiKeyProbeTimeoutMs: z.number().default(15000).description('探测单个候选 key 的超时（毫秒）；网络不通时按「这个候选不可用」处理，继续试下一个'),
});
