/**
 * QQ Bridge —— QQ（OneBot v11）与 Harness Agent 之间的双向桥接插件。
 *
 * 入站（QQ → Agent）：每个 QQ 会话（一个私聊对象，或一个群）独占一个持久化
 * Harness Session。收到的消息按会话串行投递给该 Session 的 Agent，等这一轮
 * turn 结束后，把最后一条有文本的 assistant 回复发回 QQ。
 *
 * 出站（Agent → QQ）：注册全局工具，任何 Harness Agent 都能主动发 QQ
 * 消息、发图片/表情包、按需查询当前在线的好友/群列表，以及把禁漫本子下成 PDF 发过去。
 *
 * 复读（QQ → QQ）：群里连着出现同一条消息时，插件自己跟着复读一句（同一张表情包也会被
 * 原样发回去），不经过 Agent（见 `maybeRepeat`）—— 复读机的笑点就在「原样接上」，
 * 等模型想一句俏皮话早就过去了。
 *
 * 文件结构（自上而下）：
 *   1. 插件身份与配置 schema（name / inject / Config）
 *   2. 纯函数工具（sessionIdFor / visibleText）
 *   3. apply()：闭包内维护全部运行时状态、事件路由与工具注册
 *
 * 媒体分两边：**入站**（QQ 的图 → 本地文件，给模型 read_image 看）在 `media.js`；
 * **出站**（本地文件 / URL → QQ 的 image 段）在 `image.js`。这里只负责路由、
 * 提示词与工具：什么时候该发、发给谁。
 *
 * @module @qqbot/dsh-plugin-qq
 */
import crypto from 'node:crypto';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { OneBotClient, chunkText, collectMedia, findReply, mediaPlaceholder, mentions, mentionsOthers, messageToText, repeatableText, splitBurst, splitStickerLines, typingDelayMs } from './onebot.js';
import { createMediaStore } from './media.js';
import { hashDistance, perceptualHash } from './perceptual.js';
import { DEFAULT_IMAGE_MAX_BYTES, imageSegment, insideDirectory, loadOutgoingImage } from './image.js';
import { createJmService, parseJmRef } from './jm.js';

/** 插件在 Loader 中的稳定标识（改名会导致配置/状态对不上）。 */
export const name = 'qq-bridge';

/**
 * 激活前必须就绪的 Host 服务：注册工具需要 `tools`，创建会话需要 `agents`，
 * 摘要与主动说话的循环需要 `timer`。
 *
 * `timer` 必须在列：`ctx.interval` / `ctx.timeout` 不是 ctx 上的普通方法，而是
 * `@deepseek-ai/cordis-plugin-timer` 的服务通过 `ctx.mixin('timer', [...])` 挂上来的，
 * 而 cordis **只允许插件访问 inject 里声明过的服务**。少写它，`ctx.interval` 一取就抛
 * `cannot get property "timer" without inject`，`apply()` 当场失败、插件不激活 ——
 * 外面看到的现象是「bot 完全不回复」（进程还活着，所以 systemd 显示 active）。
 */
export const inject = ['tools', 'agents', 'timer'];

/**
 * 系统提示中「QQ 渠道」小节的排序值：靠后，但仍排在交付物/Web 相关小节之前。
 * 数值越大越靠后，具体取值只需与部署里其它小节的排序错开即可。
 */
const CHANNEL_SECTION_ORDER = 8950;

/**
 * `agentPreset` 配置的哨兵值：不挂载任何预设。
 * 用于明确要求「QQ 会话只用宿主平面的工具」（例如自建部署里预设平面不存在，
 * 或使用者故意不给它任何文件/联网能力）。
 */
const PRESET_NONE = 'none';

/**
 * 「（引用 某某: …）」里最多保留多少字的被引用正文。
 *
 * 引用只是给模型一个「他在回哪条」的锚点，不需要把整段原文搬进来：太长既挤占上下文，
 * 又会让模型误以为对方重复说了一遍。图片/表情包不受这个上限影响 —— 它们被换成
 * 带本地路径的占位符，模型想知道内容应当去 `read_image`。
 */
const QUOTE_TEXT_CHARS = 200;

/**
 * 取被引用消息的超时（毫秒），比 OneBot 调用的默认 15 秒短得多。
 *
 * 这一趟跑在会话的串行队列上（取完才投递），也就是**挡在**用户消息前面：实现不支持
 * `get_msg`、或者它卡住时，一个 15 秒的默认超时会让这条消息晚 15 秒才被看见。引用只是
 * 锦上添花，卡住就放弃（正文里保留 `[回复]`），别让它拖住聊天。
 */
const QUOTE_FETCH_TIMEOUT_MS = 5000;

/**
 * 渠道提示里最多列几个表情包文件名。
 *
 * 列出来是为了让模型**知道有什么**（名字通常就是意思，比如 `笑死.gif`），省掉一次
 * `glob`；但目录是使用者随手往里丢的，可能一下就几百张 —— 提示词不该被它撑爆，
 * 超出的部分模型仍然可以用 glob 自己看。
 */
const STICKER_PROMPT_MAX = 40;

/**
 * 默认的「群友口吻」要求，注入系统提示的 QQ 渠道小节。
 * 配置里的 `persona` 非空时整段替换它（格式与身份红线仍然保留，见 channelPrompt）。
 */
const DEFAULT_PERSONA = [
  '你在用 QQ 聊天：大家的消息是一条条刷出来的，你也是一条一条地发；群里好几个人同时说话很正常，接不上就不接。',
  '',
  '说话方式（像真人群友一样）：',
  '- 一条回复只有一个形状：**要么短（一句话说完，几个字也行），要么长（把一件事完整讲清楚）**。不要把「一句短的 + 一段长的」拼在一起 —— 尤其别用「先嘴硬 / 先吐槽 / 先敷衍一句，再补一段正经的」这种两拍，那是最像机器人的写法。',
  '- 是非题只给答案：问你「知不知道 / 会不会 / 有没有 / 是不是 / 能不能」这类，整条就写「知道」「不知道」「会」「不会」（或者「是」「否」），可以带点语气，但别接解释 —— 想听细节的会追问。',
  '- 该敷衍就几个字，真要解释才多说；长短跟着内容走，不必每条都配个开场白。',
  '- 口语。用平时聊天的说法，可以有「啊 / 吧 / 呢 / 嘛 / 草 / 笑死 / 6 / 啊这」这类词。',
  '- 是群友，不是客服：不用每条都热情帮忙、也不用答得滴水不漏，群友之间经常只是搭一句话；可以吐槽、可以接梗、可以反问、可以敷衍，也可以只回两个字。',
  '- 群友之间可以互损、可以跟着起哄，但玩笑是善意的，不是真嫌弃谁。',
  '- 不要列点、不要总结、不要「首先 / 其次 / 总之」，不要写小作文。',
  '- 别复述对方的话，别用「关于你提到的问题」这种书面腔。',
].join('\n');

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
  resetCommand: z.string().default('/reset').description('清空当前 QQ 会话记忆的指令：在 QQ 里单独发送该指令即生效；留空表示禁用'),
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
  activeWindowMs: z.number().default(10 * 60 * 1000).description('「活跃对话」窗口（毫秒）：被叫到 / 接上话之后这么久之内算还在跟它聊；群里中间有别人插话就不算了。0 = 整套关闭（既不免 @ 接话，也不补一句）'),
  activeFollow: z.boolean().default(false).description('活跃对话里**免 @ 接话**：窗口内同一个人接着说的话也当成在跟它聊（默认关闭 —— 它放松了「群里只在被 @ 时才说话」这条默认约定，想更像真人再打开）；只在群聊生效，私聊本来就不需要 @'),
  activeMaxTurns: z.number().default(10).description('一次「活跃对话」里最多免 @ 接几轮：接够这么多轮就要重新 @ 它；0 = 不限'),
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
  replyStyle: z.union(['auto', 'plain', 'quote', 'at']).default('auto').description('群聊回复的指向方式：auto = 只在「回的那条后面又有人说话」时才引用（默认），quote = 引用被回复的那条消息，at = @ 对方，plain = 直接发；指向只挂在第一条上，私聊始终为 plain'),
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
});

/**
 * 由会话 key 派生出稳定的、UUID 形状的 Session id。
 *
 * 确定性正是关键：同一个 QQ 会话在 Harness 反复重启后仍然得到同一个
 * Session id，因此可以 resume 历史会话，聊天记忆不会丢。
 * 做法是把 SHA-256 摘要裁剪成 UUID 形状，并把版本位/变体位写成固定值，
 * 以便通过 Harness 对 session id 的格式校验。
 *
 * @param key - 会话 key，例如 `group:100000001`。
 * @returns 版本 5 形状的 UUID 字符串。
 */
function sessionIdFor(key) {
  const hex = crypto.createHash('sha256').update(`dsh-qq-bridge:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 把一条 assistant 消息里可见的文本块拼起来。
 * 工具调用、思考等非 text 块都会被忽略。
 * @param content - 持久化消息的 content 块数组。
 * @returns 拼接后的可见文本（已 trim）。
 */
function visibleText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * 把任意异常压成一行短文本：日志与 QQ 回复都用它，避免把多行堆栈糊进聊天。
 * @param error - 任意抛出物。
 * @returns 单行、最多 200 字的说明。
 */
function errorText(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown error';
}

// ---- 长期记忆：纯函数工具 ---------------------------------------------------------
//
// 这一层刻意不碰任何闭包状态（不认 cwd、不认配置），只做「把会话 key 变成目录名」
// 「把一行记忆安全地拼进一个文件」「读写一个文件」这几件纯事：记忆的边界检查、
// 摘要的触发条件都留在 apply() 里对着配置算。

/** 索引片段（INDEX.md）最多这么大：它每次提示词装配都会被读一遍，不能无节制地长。 */
const MEMORY_INDEX_MAX_CHARS = 4096;

/** 转录里单条消息最多保留多少字：摘要只需要「大概说了什么」，不需要全文。 */
const MEMORY_LINE_MAX_CHARS = 500;

/**
 * `qq_memory read` 一次最多返回多少字符。
 *
 * 读不设「拒绝」的硬上限（该翻的时候要能翻个够），但一次工具结果塞进上下文的东西
 * 必须有数：超出的部分截断并明说，模型据此自己决定要不要用 search 精确定位。
 */
const MEMORY_FILE_RETURN_CHARS = 12000;

/**
 * 会话 key 里所有会被当成路径分隔符或非法文件名的字符。
 *
 * 冒号在 `group:123` 里是分隔符，但在 Windows 上不能出现在文件名里，也会让
 * `.qq-memory/conversations/group:123/` 这种路径在所有平台上都难读 —— 所以它
 * 和空格、斜杠一样折成 `-`（`MEMORY_SLUG_UNSAFE` 之外的字符才原样保留）。
 */
const MEMORY_SLUG_UNSAFE = /[^A-Za-z0-9._-]+/g;

/**
 * 把会话 key（`group:100000001` / `private:100000002`）变成安全的目录名。
 *
 * 只做「可逆地可读」：`group:` 换成 `group-`（冒号在部分文件系统上不合法），
 * 其余非法字符一律折成 `-`。真正的稳定性靠 key 本身而不是这个变换 —— 调用方
 * 每个进程只算一次并存进 `memorySlugs`，同一个会话永远只有一个目录。
 * @param key - 会话 key。
 * @returns 目录名，例如 `group-100000001`。
 */
function memorySlug(key) {
  const slug = String(key ?? '').replace(MEMORY_SLUG_UNSAFE, '-').replace(/^[.-]+/, '');
  return slug.length > 0 ? slug.slice(0, 120) : 'unknown';
}

/** 本地日期（`YYYY-MM-DD`）：聊天记录按人所在地的日期切分，不用 UTC。 */
function localDate(at = Date.now()) {
  const date = new Date(at);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 本地日期时间（`YYYY-MM-DD HH:MM:SS`）：转录输出与日志里统一用它。
 *
 * 与 {@link localDate} 一样刻意用**本地时间** —— 「上一次摘要是昨天还是今天」这件事
 * 必须按人所在地的日界线算，否则东八区的凌晨 4 点会被算成前一天的 UTC。
 * @param at - 毫秒时间戳。
 * @returns 本地时间戳字符串。
 */
function localStamp(at) {
  const date = new Date(Number(at) || Date.now());
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 计算「下一个每天 `hour` 点」距今多少毫秒。
 *
 * 定时摘要只在每天固定的一个时刻醒来，所以间隔不是常数：醒来一次之后必须重新算到
 * 明天的那个点。跨过夏令时/时区变更时以本地时间为准（差一小时无所谓，摘要不是列车
 * 时刻表），但**刚过点时必须排到明天**，否则会在同一个点上反复醒来。
 * @param hour - 本地小时（0~23）。
 * @param now - 当前时刻（毫秒），测试里可注入。
 * @returns 距下一次触发点的毫秒数，至少 1 秒。
 */
function msUntilDailyHour(hour, now = Date.now()) {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return Math.max(1000, next.getTime() - now);
}

/** 本地 `HH:00`：日志与报错里描述触发点的写法。 */
function hourLabel(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

/**
 * 某个本地小时在不在「可以主动说话」的时段里。
 *
 * 真人半夜不会突然在群里冒泡，所以主动说话只发生在配置的时段内。取值一律按本地小时
 * （与摘要的 `digestAtHour` 同一个口径：东八区的晚上十点就是 22，不是 UTC 的 14）。
 * 三条规则：
 *   - `from` 到 `to` **左闭右开**：9 → 23 是 09:00~22:59；
 *   - 两边相等表示「全天」（`from = to = 0` 时不必写成 0 → 24）；
 *   - `from > to` 表示跨零点，例如 22 → 3 = 22:00 到次日 02:59。
 * 非法值按「不设限」处理（from 兜底 0、to 兜底 23），因为这里的目标是别让一个配错的
 * 小时数把功能整体打死 —— 真要收紧该由 `proactive` 开关负责。
 *
 * 导出只为让测试能直接验边界（跨零点、左闭右开、全天）：它不碰任何闭包状态。
 *
 * @param from - 起始本地小时（0~23）。
 * @param to - 结束本地小时（0~23，不含）。
 * @param hour - 要判断的本地小时（0~23）。
 * @returns 可以说话时为 true。
 */
export function withinActiveHours(from, to, hour) {
  const start = Number.isFinite(Number(from)) ? Math.min(23, Math.max(0, Math.floor(Number(from)))) : 0;
  const end = Number.isFinite(Number(to)) ? Math.min(23, Math.max(0, Math.floor(Number(to)))) : 23;
  const at = Number.isFinite(Number(hour)) ? Math.min(23, Math.max(0, Math.floor(Number(hour)))) : 0;
  if (start === end) return true;
  return start < end ? at >= start && at < end : at >= start || at < end;
}

/** 把一行记忆里的换行折掉：记忆是「一行一条事实」，格式被换行破坏就没法读了。 */
function memoryOneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 把模型给的路径解析成记忆目录内的相对路径；越界（`../`、绝对路径）时返回 undefined。
 *
 * 这是 qq_memory 的写边界：模型只能动 `.qq-memory/` 里的东西。故意不做 glob、
 * 不跟随符号链接 —— 这里的目标是「模型不会因为一次幻觉把仓库写坏」，不是完整的
 * 沙箱（真正的沙箱在 Harness 的 fs 工具那一侧）。
 * @param base - 记忆目录的绝对路径（以分隔符结尾）。
 * @param raw - 模型给的路径。
 * @returns 规范化后的相对路径（正斜杠）；越界或为空时 undefined。
 */
function memoryRelativePath(base, raw) {
  const text = String(raw ?? '').trim().replace(/\\/g, '/');
  if (text.length === 0) return undefined;
  const trimmed = text.replace(/^\.\/+/, '');
  if (trimmed.startsWith('/')) return undefined;
  const segments = trimmed.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return undefined;
  const absolute = resolve(base, ...segments);
  if (absolute !== resolve(base) && !absolute.startsWith(base)) return undefined;
  return segments.join('/');
}

/**
 * 把一个 JSON 对象原子地写进文件：先写同目录的临时文件再 rename。
 *
 * 记忆文件很小、写得也少，但「写到一半进程被杀」会留下一个半截 JSON —— 而它正是
 * 摘要 Agent 每次开工都要读的东西。rename 在同一个文件系统内是原子的。
 * @param absolute - 目标绝对路径。
 * @param payload - 可 JSON 序列化的值。
 */
async function writeJsonAtomic(absolute, payload) {
  const temp = `${absolute}.tmp`;
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(temp, absolute);
}

/**
 * 把一段文本原子地写进文件（同上，用于 Markdown 记忆文件）。
 * @param absolute - 目标绝对路径。
 * @param text - 文件正文。
 */
async function writeTextAtomic(absolute, text) {
  const temp = `${absolute}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, absolute);
}

/** 读取一个文本文件；不存在时返回 undefined（而不是抛错）。 */
async function readTextOrUndefined(absolute) {
  try {
    return await readFile(absolute, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/**
 * 读一个 JSONL 转录文件；单行坏掉（写到一半被杀、手工编辑出错）时跳过那一行，
 * 不让一条坏记录把整个会话的历史变成读不出来。
 * @param absolute - 转录文件的绝对路径。
 * @returns 解析成功的记录数组。
 */
async function readJsonl(absolute) {
  const text = await readTextOrUndefined(absolute);
  if (text === undefined) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') out.push(parsed);
    } catch {
      // 坏行直接跳过：转录是「尽力而为」的历史，不是账本。
    }
  }
  return out;
}

/** 列出一个目录下的文件名；目录不存在时返回空数组。 */
async function readdirOrEmpty(absolute) {
  try {
    return await readdir(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
    throw error;
  }
}

/**
 * 在一个 Harness Host 组合上注册 QQ 桥接。
 * @param ctx - 插件上下文（tools / agents / logger / 事件总线）。
 * @param config - 已通过 Config 校验的 bundle 配置。
 */
export function apply(ctx, config) {
  const logger = ctx.logger;

  /**
   * 运维可见的运行日志：logger + 一行 stderr。
   *
   * 这个部署（`dsh-web-app` 表面）没有把 cordis 的 logger 接到 stdout/stderr 上：
   * 实测 `ctx.logger.warn()` 只进内存缓冲与 OTel，`journalctl --user -u qqbot` 里
   * 一个字都看不到 —— 而排查「QQ 会话怎么突然没能力了」只能靠 journal。
   * 所以每条日志除了 logger 之外再直接写一行 stderr（systemd 收进 journal；
   * 前台运行时就是终端）。
   *
   * 只有真实宿主里 cordis 的 LoggerService 门面才带 `exporter()`；测试用的日志桩
   * 没有，于是测试输出不会被这些行淹没。
   */
  const mirrorToStderr = typeof logger.exporter === 'function';

  /**
   * @param level - logger 方法名：info / warn / error。
   * @param message - 不含 `qq-bridge: ` 前缀的正文。
   */
  function report(level, message) {
    logger[level](`qq-bridge: ${message}`);
    if (mirrorToStderr) process.stderr.write(`qq-bridge: ${message}\n`);
  }
  // cwd 留空时退回 Harness 进程当前目录；它既是 Agent 工作目录，也是沙箱根。
  const cwd = config.cwd.trim().length > 0 ? config.cwd : process.cwd();
  const approvalPolicy = config.approvalPolicy;
  // 工具白名单：去掉空白项与重复项。空数组 = 不限制，与 allowUsers / allowGroups 语义一致。
  const allowTools = [...new Set(config.allowTools.map((name) => name.trim()).filter((name) => name.length > 0))];
  // 会话重置指令：大小写不敏感，空串表示禁用。
  const resetCommand = config.resetCommand.trim().toLowerCase();
  // 部署 persona 里的 `{{model}}` 取的是 `agent.options.model`，请求路由读的也是
  // 同一组字段，所以程序化创建的 Agent 必须显式带上模型选择：否则提示词装配会
  // 失败，turn 在消息被 claim 之前就死掉。下面的 route 记录当前生效的选择，
  // 也通过 qq_list_conversations 暴露出来便于排查。
  const route = { provider: '', model: '', reasoningEffort: undefined, source: 'none', error: '' };

  /**
   * 解析 QQ 会话应当使用的 provider/model。
   * 优先用配置里显式填写的；只填了一半或都没填时，回退到部署默认选择
   * （agentDefaultModel 服务的 currentSelection()）。
   * @returns 实时更新的 route 记录，也可从 qq_list_conversations 读到。
   */
  function resolveRoute() {
    const configuredProvider = config.provider.trim();
    const configuredModel = config.model.trim();
    if (configuredProvider.length > 0 && configuredModel.length > 0) {
      Object.assign(route, {
        provider: configuredProvider,
        model: configuredModel,
        reasoningEffort: undefined,
        source: 'config',
        error: '',
      });
      return route;
    }
    let selection;
    try {
      const service = ctx.get('agentDefaultModel');
      if (service === undefined) route.error = 'service "agentDefaultModel" is not visible from this plugin';
      else selection = service.currentSelection();
    } catch (error) {
      route.error = error?.message ?? String(error);
    }
    // 只有两个字段都没配置时，才连 reasoningEffort 一起继承默认值。
    const useDefault = configuredProvider.length === 0 && configuredModel.length === 0;
    Object.assign(route, {
      provider: configuredProvider.length > 0 ? configuredProvider : (selection?.provider ?? ''),
      model: configuredModel.length > 0 ? configuredModel : (selection?.model ?? ''),
      reasoningEffort: useDefault ? selection?.reasoningEffort : undefined,
      source: selection === undefined ? 'none' : 'default',
    });
    if (selection === undefined && route.error.length === 0) route.error = 'the default model selection is empty';
    return route;
  }

  // ---- 运行时状态（全部是进程内内存态，随 Harness 重启清空，会话历史则留在磁盘上）----

  /** 会话 key（`private:<QQ号>` / `group:<群号>`）→ 会话记录。 */
  const conversations = new Map();
  /** Session id → 会话 key，用于把 session 事件路由回来源会话。 */
  const sessionIndex = new Map();
  /** `<sessionId>:<turn>` → `{ key, quote }`，标记这一轮欠 QQ 一条回复，并记住该回复谁。 */
  const turnOwners = new Map();
  /** 已提交的消息 id → `{ key, quote }`，用来把「消息被 claim」归属到对应会话。 */
  const submitted = new Map();
  /** `<sessionId>:<turn>` → 本轮已累积的 assistant 文本片段。 */
  const transcripts = new Map();
  /**
   * 群号 → 群里的最近消息（`{ name, text }`，旧 → 新）。
   *
   * 只记「不是发给机器人的」那些消息：真人回话前是先看着群里在聊什么，
   * 而不是只看到 @ 自己的那一句。缓冲单独按群号存，而不是挂在会话记录上 ——
   * 没被 @ 的消息不该因此凭空造出一条会话。
   */
  const ambient = new Map();
  /**
   * 群号 → 群里迄今收到的消息条数（单调递增的「聊天进度」）。
   *
   * `auto` 回复指向靠它判断「我回的那条后面还有没有别人说话」：入站时快照一个数，
   * 真要发出去时再读一次 —— 变大了说明中间有人插话，裸文本会让人看不出在回谁。
   */
  const chatterSeq = new Map();
  /**
   * 群号 → 复读状态 `{ chain, queue }`（见 `maybeRepeat`）。
   *
   * - `chain` 是「最近一条还值得跟的东西」：`{ kind, key, count, senders, at, … }`，
   *   三种 kind 各自带自己的载荷（文字原文 / 表情包本地路径 / 系统表情 id）。
   *   跟过一句、或者中间有人说了别的，这条链就没了 —— 不按群累积历史。
   * - `queue` 是这个群自己的串行链：判断表情包要先把图下载下来（异步），同一个群里
   *   两条消息谁先回来并不确定，不排队的话链上的顺序就跟群里说话的顺序对不上了。
   */
  const repeatStates = new Map();
  /** 消息对象 → 这条消息的媒体解析 Promise（见 `mediaFor`）：环境上下文与表情包复读共用一次下载。 */
  const mediaResolutions = new WeakMap();
  /** `.qq-media/…` 路径 → 画面指纹（见 `sketchOf`）：只在真要比较两条图时才算，算过就留着。 */
  const sketches = new Map();

  // OneBot 客户端：事件回调统一 try/catch，保证单个消息处理失败不会打穿 socket 回调。
  const client = new OneBotClient({
    endpoint: config.endpoint,
    accessToken: config.accessToken,
    // onEvent：OneBot 主动推送的事件（含消息、心跳、通知等），这里只关心 message。
    onEvent: (event) => {
      try {
        handleEvent(event);
      } catch (error) {
        report('warn', `inbound handling failed: ${error?.message ?? error}`);
      }
    },
    // onError：客户端内部错误（socket 异常、事件处理器抛错等），仅记日志。
    onError: (error) => report('warn', `${error.message}`),
    // onStateChange：连接建立/断开，用于日志与（未来）状态展示。
    onStateChange: (connected, selfId) => {
      if (connected) report('info', `connected to ${config.endpoint}${selfId ? ` as ${selfId}` : ''}`);
      else report('info', `disconnected from ${config.endpoint}`);
    },
  });

  /**
   * 图片/表情包的本地缓存。
   *
   * QQ 上报的 `image` 段里只有一串会过期的下载 URL（腾讯的 rkey 有时效），而 Agent
   * 要「看见」图只能靠 `read_image` 读本地文件 —— 这个 store 负责取字节、按内容哈希
   * 落盘、并返回相对 `cwd` 的路径。取不到时只回一句占位文本，不会打断消息链路。
   *
   * `resolveViaOneBot` 是兜底：URL 抓不动（rkey 过期、NapCat 与 Harness 不在同一台
   * 机器）时把 `file` 段原样丢回 OneBot 的 `get_image`，让它替我们下载。
   */
  const mediaStore = createMediaStore({
    cwd,
    dir: config.mediaDir,
    maxBytes: config.mediaMaxBytes,
    maxFiles: config.mediaCacheFiles,
    timeoutMs: config.mediaTimeoutMs,
    enabled: config.mediaDownload,
    report,
    resolveViaOneBot: (item) => client.call('get_image', { file: item.file }),
  });

  /**
   * 出站图片（表情包）的开关、上限与表情包目录。
   *
   * 和入站那半边（mediaStore）刚好反过来：那边把 QQ 的图落到本地给模型看，这边把
   * 工作目录里的图发到 QQ。传输细节在 `image.js`（走 image 段的 `base64://`）。
   *
   * `stickerDir` 只是一个「你自己给它的表情包」约定目录：渠道提示里会列出里面的
   * 文件名，模型据此挑一张。它必须在 `cwd` 内（否则模型的 read_image / glob 够不到，
   * 列出来只会让它去调一个读不到的工具），配到外面就只记一条 warn、不提示。
   */
  const imageSend = config.imageSend !== false;
  const imageMaxBytes = Number.isFinite(config.imageMaxBytes) && config.imageMaxBytes > 0
    ? Math.floor(config.imageMaxBytes)
    : DEFAULT_IMAGE_MAX_BYTES;
  const stickerRoot = config.stickerDir.trim().length > 0 ? resolve(cwd, config.stickerDir.trim()) : undefined;
  const stickerInside = stickerRoot !== undefined && insideDirectory(resolve(cwd), stickerRoot);
  /**
   * 表情包复读里「算同一张画面」的位差上限（0 = 只认字节完全相同）。
   *
   * 上限夹到 0.3：这个值放大到 1 就等于「任何两张图都算同一张」，那是配置事故而不是
   * 功能 —— 真想要那种效果该关掉复读的图（`repeatMedia: false`），而不是让它乱跟。
   */
  const repeatImageTolerance = Math.min(0.3, Math.max(0, Number(config.repeatImageTolerance) || 0));
  if (stickerRoot !== undefined && !stickerInside) {
    report('warn', `stickerDir "${config.stickerDir.trim()}" resolves outside cwd (${cwd}); the sticker pack will not be advertised`);
  }
  /** 表情包目录的展示路径（相对 cwd、正斜杠），就是模型该写进 qq_send_image 的那种写法。 */
  const stickerLabel = stickerInside ? relative(resolve(cwd), stickerRoot).split(sep).join('/') : undefined;

  // ---- 长期记忆：目录、布局边界与内存态 ----
  //
  // 三样东西同住 memoryDir（默认 `.qq-memory`，必须在 cwd 内 —— 它是 qq_memory 工具的
  // 写入边界，也是摘要 Agent 唯一允许动手的地方）：
  //
  //   conversations/<key>/{meta.json,log/YYYY-MM-DD.jsonl}   每个会话的聊天记录（原始事实）
  //   conversations/<key>/MEMORY.md                           这个群的长期记忆
  //   COGNITION.md                                            跨会话的公共认知（梗 / 表情包含义）
  //   INDEX.md                                                两份索引的拼接，注入渠道提示
  //
  // 插件只负责**记**（每条入站消息同步落一行），**读/写**交给模型通过
  // qq_transcript / qq_memory 两个工具做 —— 好处是纯宿主平面工具，QQ 会话不用为了
  // 记忆拿到 write / bash；摘要则由下面的定时器驱动一个独立会话跑 message-digest skill。
  const memoryOn = config.memory !== false;
  const memoryCfg = typeof config.memoryDir === 'string' ? config.memoryDir.trim() : '';
  const memoryRoot = memoryCfg.length > 0 ? resolve(cwd, memoryCfg) : undefined;
  const memoryInside = memoryRoot !== undefined && insideDirectory(resolve(cwd), memoryRoot);
  if (memoryOn && memoryRoot !== undefined && !memoryInside) {
    report('warn', `memoryDir "${memoryCfg}" resolves outside cwd (${cwd}); episodic memory is disabled`);
  } else if (memoryOn && memoryRoot === undefined) {
    report('warn', 'memory is enabled but memoryDir is empty; episodic memory is disabled');
  }
  const memoryEnabled = memoryOn && memoryInside;
  /** 记忆目录的展示路径（相对 cwd、正斜杠），提示词与工具返回值里都用它。 */
  const memoryLabel = memoryEnabled ? relative(resolve(cwd), memoryRoot).split(sep).join('/') : '';
  /**
   * 记忆目录的绝对路径（以 `/` 结尾），给「写盘」这一侧用。
   *
   * 相对路径在概念上是相对 **Agent 的 cwd** 的，所以这里必须解析成绝对路径再拼；
   * 而兼容旧配置的那条分支（memoryDir 与 stickerDir 同名时复用已解析的 stickerRoot）
   * 说明 stderr 上确实出现过「相对进程 cwd」的写法，两种都认。
   */
  const memoryBase = memoryEnabled
    ? (stickerRoot !== undefined && memoryCfg === config.stickerDir.trim()
        ? `${stickerRoot}${sep}`
        : `${memoryRoot}${sep}`)
    : undefined;
  /** 会话 key → 记忆目录下的安全子目录名（见 memorySlug）。 */
  const memorySlugs = new Map();
  /** 会话 key → 上一次成功摘要之后、这个会话又来了多少条消息（内存计数，重启归零）。 */
  const memoryDirty = new Map();
  /**
   * 会话 key → 上一次成功摘要的时间戳。
   *
   * 启动时从 `digest.json` 预读进内存，之后每次摘要就地更新：它既是转录窗口的起点，
   * 也是「今天这条会话摘要过没有」的判据（见 `runDigestSweep`），而 `runDigestSweep`
   * 是定时器回调（每天 `digestAtHour` 点一次），不该每次都去磁盘上读一遍状态。
   */
  const memoryLastDigest = new Map();
  /** 记忆文件的写盘队列（每个文件一条串行链，见 writeMemoryFile）。 */
  const memoryWrites = new Map();
  /** 这次启动是否已经跑过一轮「补课」摘要（见 maybeCatchUpDigest）。 */
  let digestCatchUpKicked = false;

  /** 摘要点（本地小时，0~23）：配置非法时退回 4 点。 */
  function digestAtHour() {
    const raw = Math.floor(Number(config.digestAtHour));
    return Number.isFinite(raw) ? Math.min(23, Math.max(0, raw)) : 4;
  }
  /** 摘要 Agent 的会话 id（确定性派生，重启后 resume，摘要历史不会断）。 */
  const digestSessionId = sessionIdFor('bridge:digest');
  /** 摘要任务的串行链：一次只跑一个会话，也不与自己的下一轮重叠。 */
  let digestChain = Promise.resolve();
  /** 已经排进队列、还没跑完的会话 key，避免同一个会话被重复排队。 */
  const digestQueued = new Set();

  /**
   * 取一个会话在记忆目录下的安全目录名（每个进程只算一次，保证稳定）。
   * @param key - 会话 key。
   * @returns 目录名，例如 `group-100000001`。
   */
  function memorySlugFor(key) {
    let slug = memorySlugs.get(key);
    if (slug === undefined) {
      slug = memorySlug(key);
      memorySlugs.set(key, slug);
    }
    return slug;
  }

  /** 某个会话在记忆目录下的绝对路径集合（会话目录、转录目录、记忆文件）。 */
  function memoryPaths(key) {
    const slug = memorySlugFor(key);
    const dir = join(memoryRoot, 'conversations', slug);
    return {
      slug,
      dir: `${dir}${sep}`,
      logDir: `${join(dir, 'log')}${sep}`,
      memoryFile: join(dir, 'MEMORY.md'),
      metaFile: join(dir, 'meta.json'),
    };
  }

  /** 索引片段与认知库的绝对路径（两者都在记忆目录顶层）。 */
  const memoryIndexFile = memoryEnabled ? join(memoryRoot, 'INDEX.md') : undefined;
  const memoryCognitionFile = memoryEnabled ? join(memoryRoot, 'COGNITION.md') : undefined;

  /**
   * 某个目录下已经排队的转录写入（用来在**读**之前把写等干净）。
   *
   * 读转录的两条路（摘要、`qq_transcript`）都可能紧跟在一条消息后面发生，而写入是
   * 后台排队的 —— 这里把在飞的 Promise 交出去，调用方 `await` 一下就得到「写完了」
   * 这个确定状态。
   * @param dir - 转录目录的绝对路径（以分隔符结尾）。
   * @returns 该目录下所有未完成的写入 Promise。
   */
  function writesFor(dir) {
    const pending = [];
    for (const [file, promise] of memoryWrites) {
      if (file.startsWith(dir)) pending.push(promise);
    }
    return pending;
  }

  /**
   * 把聊天记录按会话串行追加到当天转录里（qq_transcript 的原料）。
   *
   * 这里刻意**不**等落盘：`handleEvent` 是 OneBot 事件的热路径（攒批定时器也在它
   * 里面），一次 await 就会把「消息有没有被及时接住」交给磁盘。所以写是后台的，
   * 按会话排队（`memoryWrites`），失败只记一条 warn。
   *
   * @param conversation - 归属的会话记录。
   * @param line - 已渲染成一行的一条记录。
   * @param date - 日期（`YYYY-MM-DD`）。
   */
  function appendTranscript(key, line, date, conversation) {
    const paths = memoryPaths(key);
    const file = join(paths.logDir, `${date}.jsonl`);
    const previous = memoryWrites.get(file) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        await mkdir(paths.logDir, { recursive: true });
        await appendFile(file, `${JSON.stringify(line)}\n`, 'utf8');
      })
      .catch((error) => {
        report('warn', `could not append transcript for ${key}: ${errorText(error)}`);
      });
    memoryWrites.set(file, next);
    // 这个会话还没有目录（第一次说话）时落一份元信息，qq_transcript 的 list 靠它认出群名。
    if (conversation !== undefined && conversation.metaWritten !== true) {
      conversation.metaWritten = true;
      void (async () => {
        try {
          await mkdir(paths.dir, { recursive: true });
          const existing = await readTextOrUndefined(paths.metaFile);
          const parsed = existing === undefined ? undefined : JSON.parse(existing);
          await writeJsonAtomic(paths.metaFile, {
            key: conversation.key,
            type: conversation.type,
            id: conversation.id,
            name: conversation.name || conversation.senderName,
            createdAt: parsed?.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        } catch (error) {
          report('warn', `could not write memory meta for ${conversation.key}: ${errorText(error)}`);
        }
      })();
    }
  }

  /**
   * 收下一条入站消息时顺手记一行转录。
   *
   * 只记**别人的**消息（机器人自己发出去的话会以 message 事件回灌，那是回音不是历史），
   * 并且限定在插件本来就允许处理的范围内（私聊开关、群白名单、私聊白名单）——
   * 记忆不该成为绕过准入规则的后门。
   * @param event - 已解码的 OneBot 事件。
   * @param selfId - 机器人自己的 QQ 号。
   * @param state - `handleEvent` 已有的判定结果 `{ admitted, jmCommand, reset }`。
   */
  function rememberTranscript(event, selfId, state) {
    if (!memoryEnabled) return;
    if (event?.post_type !== 'message') return;
    if (selfId === '' || String(event.user_id ?? '') === String(selfId)) return;
    const isGroup = event.message_type === 'group';
    if (isGroup) {
      if (!config.groupChat) return;
      const groupId = String(event.group_id);
      if (config.allowGroups.length > 0 && !config.allowGroups.includes(groupId)) return;
    } else {
      if (!config.privateChat) return;
      const userId = String(event.user_id);
      if (config.allowUsers.length > 0 && !config.allowUsers.includes(userId)) return;
    }
    const message = event.message ?? event.raw_message;
    const text = memoryOneLine(messageToText(message, selfId)).slice(0, MEMORY_LINE_MAX_CHARS);
    const sender = event.sender ?? {};
    const name = isGroup
      ? String(sender.card ?? sender.nickname ?? event.user_id ?? '')
      : String(sender.nickname ?? sender.card ?? event.user_id ?? '');
    const write = (key, extra = {}, conversation) => {
      const date = localDate();
      appendTranscript(key, {
        at: Date.now(),
        date,
        // state 由 handleEvent 一次算好：被 @ 的（进会话）与只是路过的（环境上下文）都记，
        // 但标出来 —— 摘要时「它是被叫到才说话」和「它只是看着」是两种不同的事实。
        kind: isGroup ? 'group' : 'private',
        addressed: state.admitted !== undefined,
        command: state.jmCommand !== undefined ? 'jm' : state.reset ? 'reset' : undefined,
        id: String(event.message_id ?? ''),
        user: String(event.user_id ?? ''),
        name,
        text,
        hasMedia: collectMedia(message).length > 0,
        ...extra,
      }, date, conversation);
      memoryDirty.set(key, (memoryDirty.get(key) ?? 0) + 1);
    };
    // 没被 @ 的群消息**不建**会话记录（`conversations` 是「这个 Harness 处理过哪些会话」
    // 的表，qq_list_conversations 与摘要调度都读它 —— 让一条闲聊把某个群「变成处理过」
    // 是行为上的谎言）。转录仍然照记：长期记忆的原料正是那些没人 @ 它的闲聊。
    const admitted = state.admitted;
    if (admitted === undefined) {
      write(`${isGroup ? 'group' : 'private'}:${isGroup ? event.group_id : event.user_id}`);
      return;
    }
    write(admitted.conversation.key, {}, admitted.conversation);
    // 顺手看一眼这个会话是不是「本该在今天的摘要点被摘要、却错过了」—— 比如凌晨 4 点
    // 那一刻进程正好在重启，或者这个会话是重启之后才有人说话的（启动时的补课扫不到它：
    // 那时 conversations 还是空的）。判据由 cd 时间决定，所以一天最多补一次。
    maybeCatchUpDigest(admitted.conversation);
  }

  /**
   * 「今天已经过了摘要点、但这个会话今天还没摘要过」时补一次。
   *
   * 为什么不能只在启动时扫一遍：`conversations` 是运行时状态（重启即空），凌晨重启后
   * 第一个说话的人才是这条会话「重新出现」的时刻 —— 补课必须挂在这个时刻上，
   * 否则那一天的记忆要等到明天的 4:00。
   * @param conversation - 刚收到消息的会话。
   */
  function maybeCatchUpDigest(conversation) {
    if (!memoryEnabled || config.digestCatchUp === false) return;
    const atHour = digestAtHour();
    const now = new Date();
    if (now.getHours() < atHour) return; // 今天还没到点，等定时器
    const last = memoryLastDigest.get(conversation.key) ?? 0;
    if (last > 0 && localDate(last) === localDate(now.getTime())) return; // 今天摘要过了
    if (digestCatchUpKicked) return; // 一次启动只补一轮，别变成每条消息扫一遍
    digestCatchUpKicked = true;
    runDigestSweep();
  }

  /**
   * 读记忆目录里的 `digest.json`：每个会话上一次成功摘要的时间与日期。
   *
   * 放在磁盘上而不是内存里，是为了让「本该摘要但进程重启了」不会把那批消息算丢：
   * 重启后 `lastDigestAt` 还是旧值，日期判据认得出「今天还没摘要」，于是补一次。
   * @returns `{ conversations: { <key>: { lastDigestAt, lastDigestDate, lastLines, lastLabel } } }`。
   */
  async function readDigestState() {
    const text = await readTextOrUndefined(join(memoryRoot, 'digest.json'));
    if (text === undefined) return { conversations: {} };
    try {
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.conversations !== 'object' || parsed.conversations === null) {
        return { conversations: {} };
      }
      return { conversations: parsed.conversations };
    } catch (error) {
      report('warn', `could not parse digest.json (starting over): ${errorText(error)}`);
      return { conversations: {} };
    }
  }

  /** 把摘要状态写回磁盘（原子写）。 */
  async function writeDigestState(state) {
    await mkdir(memoryRoot, { recursive: true });
    await writeJsonAtomic(join(memoryRoot, 'digest.json'), state);
  }

  /**
   * 把一批转录记录渲染成给摘要 Agent 看的正文（旧 → 新）。
   *
   * 超长时**从最旧的一端**截断并明确告诉模型「前面还有更早的记录没给你」：摘要
   * 最怕的是模型以为手上这批就是全部，于是把「群里最近很安静」写成结论。
   * @param lines - 转录记录（按时间升序）。
   * @param budget - 字符预算。
   * @returns `{ text, included, dropped }`。
   */
  function renderTranscriptWindow(lines, budget) {
    const rendered = lines.map((line) => {
      const when = new Date(Number(line.at) || Date.now());
      const pad = (value) => String(value).padStart(2, '0');
      const stamp = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
      const who = String(line.name ?? line.user ?? '?');
      const tags = [line.kind === 'private' ? '私聊' : '群'];
      if (line.addressed === true) tags.push('被叫到');
      if (line.command !== undefined) tags.push(`指令:${line.command}`);
      if (line.hasMedia === true) tags.push('带图');
      return `${stamp} [${tags.join(' ')}] ${who}: ${String(line.text ?? '')}`;
    });
    let used = 0;
    const kept = [];
    for (let index = rendered.length - 1; index >= 0; index -= 1) {
      const line = rendered[index];
      if (used + line.length + 1 > budget && kept.length > 0) break;
      used += line.length + 1;
      kept.push(line);
    }
    kept.reverse();
    return { text: kept.join('\n'), included: kept.length, dropped: rendered.length - kept.length };
  }

  /**
   * 摘要 Agent：跑 message-digest skill 的那个独立会话。
   *
   * 为什么必须是独立会话而不是「往正在聊天的会话里塞一条」：QQ 会话的 persona 是
   * 一个正在群里唠嗑的群友，让它「现在开始写摘要」既污染聊天上下文，又会把摘要当
   * 聊天内容发回 QQ。独立会话则干净、可 resume（摘要历史连续）、而且它的输出本来
   * 就不经过回复链路（`sessionIndex` 里没有它）。
   */
  async function ensureDigestAgent(notice) {
    const live = ctx.agents.get(digestSessionId);
    if (live !== undefined) {
      if (digestHandle?.agent !== live) digestHandle = undefined;
      return live;
    }
    const chosen = resolveRoute();
    const agentOptions = {};
    if (chosen.provider.length > 0) agentOptions.provider = chosen.provider;
    if (chosen.model.length > 0) agentOptions.model = chosen.model;
    if (chosen.model.length === 0) {
      throw new Error(`qq-bridge: no model for the digest agent (${chosen.error}); set provider/model on the plugin`);
    }
    const presetId = await resolveAgentPreset();
    const setup = async (agentCtx, agent) => {
      await mountAgentPreset(agentCtx, agent, presetId);
      restrictAgentTools(agentCtx, agent);
      const prompt = agentCtx.get?.('systemPrompt');
      if (prompt === undefined) return;
      prompt.variable('model', () => agentOptions.model);
      prompt.variable('provider', () => agentOptions.provider);
      prompt.section({
        name: 'qq-bridge:digest',
        order: CHANNEL_SECTION_ORDER + 10,
        interpolate: false,
        text: () => digestPrompt(notice),
      });
    };
    let handle;
    try {
      handle = await ctx.agents.resume({ resumeSessionId: digestSessionId, agentOptions, setup });
      report('info', `resumed digest session ${digestSessionId}`);
    } catch {
      handle = await ctx.agents.create({
        sessionId: digestSessionId,
        meta: presetId.length > 0 ? { cwd, agentPreset: presetId } : { cwd },
        agentOptions,
        setup,
      });
      report('info', `created digest session ${digestSessionId}`);
    }
    digestHandle = handle;
    if (approvalPolicy === 'never') {
      const approval = ctx.get('approval');
      try {
        approval?.setPolicy(handle.agent, 'never');
      } catch (error) {
        report('warn', `could not set approval policy on the digest agent: ${errorText(error)}`);
      }
    }
    return handle.agent;
  }

  /** 摘要 Agent 的句柄（只在 /reset 之外的生命周期里复用；超时销毁后置空）。 */
  let digestHandle;

  /**
   * 提示词里那段「记忆索引」的缓存。
   *
   * `SystemPrompt.section()` 的 text provider 是**同步**求值的（每次装配提示词都会
   * 重新算），所以这里只能读缓存、由后台异步刷新 —— 与表情包目录用同步 readdir 的
   * 理由一样，只是记忆文件在磁盘上、大小不定，同步读会把一次可观测的 IO 放进装配路径。
   * @type {{ at: number, text: string }}
   */
  let memoryIndexCache = { at: 0, text: '' };

  /**
   * 读一小段记忆索引（`INDEX.md` + 当前会话的 `MEMORY.md`）供提示词使用。
   *
   * 只取开头的 `MEMORY_INDEX_MAX_CHARS` 个字：索引是「摘要 Agent 替大家维护的目录」，
   * 它的长度由摘要 Agent 的写法决定，插件这边只做兜底截断 —— 提示词被记忆撑爆比
   * 记忆不够详细糟糕得多。
   * @param conversation - 目标会话。
   * @returns 可直接拼进提示词的若干行；没有内容时为空串。
   */
  function memoryIndexText(conversation) {
    if (!memoryEnabled) return '';
    if (Date.now() - memoryIndexCache.at > 15000) {
      // 先发一次刷新（不 await），这一轮用上一份缓存 —— 冷启动时是空的，15 秒后就位。
      memoryIndexCache.at = Date.now();
      if (!memoryIndexRefreshing) {
        memoryIndexRefreshing = true;
        void (async () => {
          try {
            const paths = memoryPaths(conversation.key);
            const parts = [];
            const index = await readTextOrUndefined(memoryIndexFile);
            if (index !== undefined && index.trim().length > 0) parts.push(index.trim());
            const own = await readTextOrUndefined(paths.memoryFile);
            if (own !== undefined && own.trim().length > 0) {
              parts.push(`### ${conversation.type === 'group' ? '本群' : '与这个人'}的记忆（${memoryLabel}/conversations/${paths.slug}/MEMORY.md）\n${own.trim()}`);
            }
            const text = parts.join('\n\n').slice(0, MEMORY_INDEX_MAX_CHARS);
            memoryIndexCache = { at: Date.now(), text };
          } catch (error) {
            report('warn', `could not read the memory index: ${errorText(error)}`);
            memoryIndexCache = { at: Date.now(), text: memoryIndexCache.text };
          } finally {
            memoryIndexRefreshing = false;
          }
        })();
      }
    }
    return memoryIndexCache.text;
  }

  /** 索引刷新是否正在进行（避免一个慢磁盘把刷新任务堆起来）。 */
  let memoryIndexRefreshing = false;

  /**
   * 解析 `qq_memory` 要操作的文件。
   *
   * 三种来源，按优先级：
   *   1. 显式 `path`（相对记忆目录，越界直接报错）；
   *   2. 说了 `conversation`、没说 path → 那个会话的 `MEMORY.md`；
   *   3. 都没说 → 当前 QQ 会话的 `MEMORY.md`；连会话都没有就是 `INDEX.md`。
   * @param args - 工具参数。
   * @param tool - 工具名（报错用）。
   * @param exec - 工具执行上下文。
   * @returns 记忆目录内的相对路径（正斜杠）。
   */
  function resolveMemoryPath(args, tool, exec) {
    const raw = String(args?.path ?? '').trim();
    if (raw.length > 0) {
      const relative = memoryRelativePath(memoryBase, raw);
      if (relative === undefined) {
        throw new Error(`${tool}: path "${raw}" is not inside the memory directory ${memoryLabel}/ (no absolute paths, no "..")`);
      }
      return relative;
    }
    const fromAgent = exec?.agent?.id !== undefined ? conversations.get(sessionIndex.get(exec.agent.id)) : undefined;
    const wanted = String(args?.conversation ?? '').trim();
    if (wanted.length > 0 || fromAgent !== undefined) {
      const target = resolveMemoryConversation(args, exec, tool);
      return `conversations/${target.slug}/MEMORY.md`;
    }
    return 'INDEX.md';
  }

  /** 记忆目录下已存在的文件（相对路径），按名称排序；没有时是空数组。 */
  async function listMemoryFiles() {
    const out = [];
    for (const top of ['INDEX.md', 'COGNITION.md', 'digest.json']) {
      if ((await readTextOrUndefined(join(memoryBase, top))) !== undefined) out.push(`${memoryLabel}/${top}`);
    }
    for (const slug of await readdirOrEmpty(join(memoryBase, 'conversations'))) {
      for (const name of await readdirOrEmpty(join(memoryBase, 'conversations', slug))) {
        if (name.endsWith('.md') || name.endsWith('.json')) out.push(memoryRelativeConvPath(slug, name));
      }
    }
    return { action: 'list', files: out.sort(), returned: out.length, truncated: false };
  }

  /**
   * 读一个记忆文件，带行号。
   * @param relative - 记忆目录内的相对路径。
   * @returns 工具输出。
   */
  async function readMemoryFile(relative) {
    const text = await readTextOrUndefined(join(memoryBase, relative));
    if (text === undefined) {
      return { action: 'read', path: `${memoryLabel}/${relative}`, bytes: 0, lines_total: 0, returned: 0, truncated: false, note: '(file does not exist yet — append to create it)' };
    }
    const lines = text.split('\n');
    // 行号让模型能引用「第 12 行」，也让长文件的截断看得出来是截断。
    const numbered = lines.map((line, index) => `${String(index + 1).padStart(4, ' ')} | ${line}`).join('\n');
    const truncated = numbered.length > MEMORY_FILE_RETURN_CHARS;
    return {
      action: 'read',
      path: `${memoryLabel}/${relative}`,
      bytes: Buffer.byteLength(text, 'utf8'),
      lines_total: lines.length,
      returned: lines.length,
      truncated,
      text: truncated ? `${numbered.slice(0, MEMORY_FILE_RETURN_CHARS)}\n…（已截断）` : numbered,
    };
  }

  /**
   * 在记忆文件里按子串搜索（不区分大小写），返回命中行及其上下文。
   * @param relative - 记忆目录内的相对路径。
   * @param query - 要找的文本。
   * @param limit - 最多返回多少条命中。
   * @returns 工具输出。
   */
  async function searchMemoryFile(relative, query, limit) {
    const text = await readTextOrUndefined(join(memoryBase, relative));
    const hits = [];
    if (text !== undefined) {
      const lines = text.split('\n');
      const needle = query.trim().toLowerCase();
      const max = Math.max(1, Math.floor(Number(limit) || Number(config.memorySearchHits) || 40));
      for (let index = 0; index < lines.length && hits.length < max; index += 1) {
        if (!lines[index].toLowerCase().includes(needle)) continue;
        const from = Math.max(0, index - 2);
        const to = Math.min(lines.length, index + 3);
        hits.push(lines.slice(from, to).map((line, offset) => `${String(from + offset + 1).padStart(4, ' ')} | ${line}`).join('\n'));
      }
    }
    return {
      action: 'search',
      path: `${memoryLabel}/${relative}`,
      returned: hits.length,
      truncated: hits.length >= Math.max(1, Math.floor(Number(limit) || Number(config.memorySearchHits) || 40)),
      text: hits.length > 0 ? hits.join('\n---\n') : '(no match)',
      bytes: text === undefined ? 0 : Buffer.byteLength(text, 'utf8'),
    };
  }

  /**
   * 追加或覆盖一个记忆文件。
   *
   * 顺序是「先校验大小、再写盘」：写一半才发现超限会留下一个半截文件（记忆文件是
   * 摘要 Agent 下一次开工要读的输入，半截比不写更坏）。写走 `writeMemoryFile` 的
   * 串行队列 —— 同一个文件的两次写入可能来自同一轮里的两个并行工具调用。
   * @param relative - 记忆目录内的相对路径。
   * @param text - 要写入的 markdown。
   * @param append - true = 追加，false = 覆盖。
   * @returns 工具输出。
   */
  async function writeMemoryFile(relative, text, append) {
    const absolute = join(memoryBase, relative);
    const maxBytes = Math.max(256, Math.floor(Number(config.memoryFileMaxBytes) || 0));
    const body = append ? `\n${text.replace(/\s+$/, '')}\n` : `${text.replace(/\s+$/, '')}\n`;
    const previousRaw = (await readTextOrUndefined(absolute)) ?? '';
    const previousBytes = Buffer.byteLength(previousRaw, 'utf8');
    const bodyBytes = Buffer.byteLength(body, 'utf8');
    if (!append && bodyBytes > maxBytes) {
      throw new Error(`qq_memory: ${bodyBytes} bytes exceeds memoryFileMaxBytes (${maxBytes}); write less, or split it across files`);
    }
    if (append && previousBytes + bodyBytes > maxBytes) {
      const room = maxBytes - previousBytes;
      throw new Error(
        `qq_memory: appending ${bodyBytes} bytes would exceed memoryFileMaxBytes (${maxBytes}) — ` +
          `\`${memoryLabel}/${relative}\` is already ${previousBytes} bytes (room for ${Math.max(0, room)} more). ` +
          'Rewrite it shorter with action "write" (keep only what still matters), or put the new fact in a different file.',
      );
    }
    const next = append ? `${previousRaw.replace(/\s*$/, '')}\n${text.replace(/\s+$/, '')}\n` : body;
    const queueKey = absolute;
    const previous = memoryWrites.get(queueKey) ?? Promise.resolve();
    const done = previous
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(absolute), { recursive: true });
        await writeTextAtomic(absolute, next);
      });
    memoryWrites.set(queueKey, done);
    await done;
    return {
      action: append ? 'append' : 'write',
      path: `${memoryLabel}/${relative}`,
      bytes: Buffer.byteLength(next, 'utf8'),
      lines_total: next.split('\n').length,
      returned: 1,
      truncated: false,
      note: append ? `appended ${bodyBytes} bytes` : `replaced ${previousBytes} bytes with ${bodyBytes} bytes`,
    };
  }

  /** 一条转录记录在工具结果里的一行文本。 */
  function describeTranscriptLine(line) {
    if (line.conversation !== undefined) return `[${line.date ?? '?'}] ${line.conversation} — ${line.messages ?? 0} 条，最后 ${line.last_at ?? '?'} ${line.last_text ?? ''}`.trim();
    const tags = [];
    if (line.kind !== undefined) tags.push(line.kind);
    if (line.addressed === true) tags.push('被叫到');
    if (line.command !== undefined) tags.push(`指令:${line.command}`);
    if (line.media === true) tags.push('带图');
    const tag = tags.length > 0 ? `[${tags.join(' ')}] ` : '';
    return `${line.at ?? ''} ${tag}${line.user ?? '?'}: ${line.text ?? ''}`.trim();
  }

  /** 转录工具共享的参数上限。 */
  function transcriptLimit(raw, fallback) {
    const value = Math.floor(Number(raw) || 0);
    if (value > 0) return Math.min(value, 2000);
    return fallback;
  }

  /** `qq_transcript list`：磁盘上有记录的会话、条数与最后一条消息。 */
  async function listTranscripts() {
    const lines = [];
    const root = join(memoryBase, 'conversations');
    for (const slug of await readdirOrEmpty(root)) {
      const dir = join(root, slug);
      const files = (await readdirOrEmpty(join(dir, 'log'))).filter((name) => name.endsWith('.jsonl')).sort();
      if (files.length === 0) continue;
      let messages = 0;
      let newest;
      for (const name of files) {
        const records = await readJsonl(join(dir, 'log', name));
        messages += records.length;
        for (const record of records) {
          if (newest === undefined || (Number(record.at) || 0) > (Number(newest.at) || 0)) newest = record;
        }
      }
      let meta;
      try {
        meta = JSON.parse((await readTextOrUndefined(join(dir, 'meta.json'))) ?? '{}');
      } catch {
        meta = {};
      }
      lines.push({
        conversation: String(meta.key ?? slug),
        name: String(meta.name ?? ''),
        date: `${files[0]} → ${files[files.length - 1]}`,
        messages,
        last_at: newest === undefined ? '' : localStamp(newest.at),
        last_text: newest === undefined ? '' : String(newest.text ?? '').slice(0, 80),
      });
    }
    // 最近活跃的排在前面：摘要时第一眼该看到有人在说话的群。
    lines.sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
    return { action: 'list', lines, returned: lines.length, truncated: false };
  }

  /**
   * `qq_transcript read`：读一个会话的转录。
   * @param target - `{ key, slug, label }`。
   * @param args - 工具参数（`date` / `since` / `until` / `limit`）。
   */
  async function readTranscript(target, args) {
    const dir = join(memoryBase, 'conversations', target.slug, 'log');
    const available = (await readdirOrEmpty(dir)).filter((name) => name.endsWith('.jsonl')).sort();
    const limit = transcriptLimit(args.limit, 200);
    const day = typeof args.date === 'string' ? args.date.trim() : '';
    const from = typeof args.since === 'string' ? args.since.trim() : '';
    const to = typeof args.until === 'string' ? args.until.trim() : '';
    const inRange = (name) => {
      const date = name.replace(/\.jsonl$/, '');
      if (day.length > 0) return date === day;
      if (from.length > 0 && date < from) return false;
      if (to.length > 0 && date > to) return false;
      return true;
    };
    const wanted = available.filter(inRange);
    const records = [];
    for (const name of wanted) records.push(...await readJsonl(join(dir, name)));
    records.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
    // 超限时保留**最近**的那些：问「刚刚/后来怎么样了」远多于问「最开始是什么」。
    const truncated = records.length > limit;
    const kept = truncated ? records.slice(records.length - limit) : records;
    return {
      action: 'read',
      conversation: target.key,
      returned: kept.length,
      truncated,
      note: truncated ? `只给了最近 ${kept.length} 条（共 ${records.length} 条）` : '',
      lines: kept.map((record) => ({
        at: localStamp(record.at),
        user: String(record.name ?? record.user ?? '?'),
        text: String(record.text ?? ''),
        kind: String(record.kind ?? ''),
        addressed: record.addressed === true,
        command: record.command === undefined ? undefined : String(record.command),
        media: record.hasMedia === true,
      })),
    };
  }

  /**
   * `qq_transcript search`：在某个会话的转录里按子串找（文本、昵称、日期都算）。
   * @param target - `{ key, slug, label }`。
   * @param args - 工具参数（`query` / `limit`）。
   */
  async function searchTranscript(target, args) {
    const dir = join(memoryBase, 'conversations', target.slug, 'log');
    const limit = transcriptLimit(args.limit, Math.max(1, Math.floor(Number(config.memorySearchHits) || 40)));
    const needle = String(args.query).trim().toLowerCase();
    const hits = [];
    for (const name of (await readdirOrEmpty(dir)).filter((file) => file.endsWith('.jsonl')).sort().reverse()) {
      for (const record of await readJsonl(join(dir, name))) {
        const haystack = `${record.text ?? ''}\n${record.name ?? ''}\n${record.date ?? ''}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
        hits.push({
          at: localStamp(record.at),
          user: String(record.name ?? record.user ?? '?'),
          text: String(record.text ?? ''),
          kind: String(record.kind ?? ''),
          addressed: record.addressed === true,
          media: record.hasMedia === true,
        });
      }
    }
    hits.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const kept = hits.slice(0, limit);
    return {
      action: 'search',
      conversation: target.key,
      returned: kept.length,
      truncated: hits.length > kept.length,
      note: hits.length > kept.length ? `共 ${hits.length} 条命中，只给了最新的 ${kept.length} 条` : '',
      lines: kept,
    };
  }

  /**
   * 记忆文件的展示路径（相对 cwd）：工具返回值里给模型看的永远是这一种写法，
   * 它同时也是 `qq_memory` 下次调用时该回传的 `path`。
   * @param slug - 会话目录名。
   * @param file - 会话目录内的文件名。
   * @returns 形如 `.qq-memory/conversations/group-123/MEMORY.md`。
   */
  function memoryRelativeConvPath(slug, file) {
    return `${memoryLabel}/conversations/${slug}/${file}`;
  }

  /**
   * 解析工具调用「在说哪个会话」，并给出它的记忆目录。
   *
   * 两条来源，按优先级：
   *   1. 调用它的那个 Agent 就是某个 QQ 会话的 Agent（`exec.agent.id` → 会话 key）；
   *   2. 显式给的 `conversation`（`group:100000001` / `private:100000002`）——
   *      摘要会话不是任何 QQ 会话的 Agent，必须走这条。
   *
   * 显式给的名字会先按「已见过的会话」核对：记忆目录是按 key 派生目录名的，一个
   * 拼错的 key 会安静地开出一个新的空目录，看起来就像「记忆丢了」。核对不上就报错。
   *
   * @param args - 工具参数（可能带 `conversation`）。
   * @param exec - 工具执行上下文（`exec.agent.id`）。
   * @param tool - 工具名，只用于报错。
   * @returns `{ key, slug, label, memoryFile }`；无法确定时抛错。
   */
  function resolveMemoryConversation(args, exec, tool) {
    if (!memoryEnabled) throw new Error(`${tool} is unavailable: long-term memory is disabled (qq-bridge config memory/memoryDir)`);
    const fromAgent = exec?.agent?.id !== undefined ? conversations.get(sessionIndex.get(exec.agent.id)) : undefined;
    const explicit = String(args?.conversation ?? '').trim();
    let conversation = fromAgent;
    if (explicit.length > 0) {
      // 容忍「裸群号」这类写法：权威格式是 `group:<id>` / `private:<id>`，其余尽量往
      // 已知会话上靠；靠不上且本来就不是 key 形态时报错，而不是开一个新目录。
      const known = explicit.includes(':') ? explicit : [...conversations.keys()].find((key) => key.endsWith(`:${explicit}`));
      conversation = known !== undefined ? conversations.get(known) : undefined;
      if (conversation === undefined && !explicit.includes(':')) {
        throw new Error(`${tool}: unknown conversation "${explicit}"; use a key like "group:123456" (see qq_transcript list)`);
      }
    }
    const key = conversation?.key ?? explicit;
    if (key.length === 0) {
      throw new Error(`${tool}: cannot tell which conversation this is about; pass conversation: "group:<群号>" or "private:<QQ号>"`);
    }
    const paths = memoryPaths(key);
    const label = conversation !== undefined
      ? `${conversation.type === 'group' ? '群' : '私聊'} ${conversation.name || conversation.id}`
      : key;
    return { key, slug: paths.slug, label, memoryFile: paths.memoryFile };
  }

  /**
   * 记忆工具到底能不能用：开关开着，并且没有被 `allowTools` 挡在外面。
   *
   * 白名单是使用者的明确意图（「只给 read」），提示词里推荐一个被挡掉的工具会让模型
   * 去撞一次「工具不存在」；记忆相关的提示、索引注入都跟着这个判定走。
   * @returns 两个记忆工具都可见时为 true。
   */
  function memoryToolsAllowed() {
    if (!memoryEnabled) return false;
    if (allowTools.length === 0) return true;
    return allowTools.includes('qq_memory') && allowTools.includes('qq_transcript');
  }

  /**
   * 摘要 Agent 的系统提示：不放人格，只放规矩与「今天要处理哪个会话」。
   * @param notice - `{ key, label, since, until }`。
   * @returns 系统提示小节正文。
   */
  function digestPrompt(notice) {
    if (notice === undefined) {
      return [
        '## 记忆维护会话',
        '',
        '你不是在跟任何人聊天。这个会话只有一个用途：在后台把 QQ 群的聊天记录整理成',
        `长期记忆，写进 \`${memoryLabel}/\` 里的 Markdown 文件。你写的字不会发给任何人，也不会有人回复你。`,
        '',
        `- 永远先加载 \`message-digest\` skill（\`skill\` 工具，名字就叫 message-digest），按它写的流程做。`,
        `- 只写 \`${memoryLabel}/\` 里的文件，用 \`qq_memory\` 工具写；不要试图写别的位置。`,
        '- 没有实质内容就什么都不写，回一句「无事」即可 —— 空摘要比编造的摘要好。',
      ].join('\n');
    }
    return [
      '## 记忆维护会话',
      '',
      '你不是在跟任何人聊天。这个会话只有一个用途：在后台把 QQ 群的聊天记录整理成',
      `长期记忆，写进 \`${memoryLabel}/\` 里的 Markdown 文件。你写的字不会发给任何人，也不会有人回复你。`,
      '',
      `本轮要处理的会话：**${notice.label}**（\`${notice.key}\`，目录 \`${memoryLabel}/conversations/${notice.slug}/\`），`,
      `时间窗：${notice.since} 之后到 ${notice.until}（本地时间）为止。`,
      '',
      '做法：',
      `1. 用 \`skill\` 工具加载 \`message-digest\` skill，按它写的流程做（它是这一步的准绳）。`,
      `2. 用 \`qq_transcript\` 读这个会话在这个时间窗里的记录${notice.queue && notice.queue.length > 0 ? `；本批还有其它会话排队（${notice.queue.join('、')}），它们各有自己的一轮，不用在这里处理` : ''}。`,
      `3. 用 \`qq_memory\` 更新 \`conversations/${notice.slug}/MEMORY.md\`；只有出现**新的**梗或表情包含义时才动 \`COGNITION.md\`（加载 \`update-cognition\` skill 按它的规矩写）。`,
      `4. 严格止步于 \`${memoryLabel}/\` 之内：不要读源码、不要改仓库里任何其它文件、不要发 QQ 消息。`,
      '',
      '如果这个时间窗里没有值得一提的内容，就什么都不写，回一句「无事」即可 —— 空摘要比编造的摘要好。',
    ].join('\n');
  }

  /**
   * 真正跑一次摘要：把转录窗口交给摘要 Agent，等这一轮结束。
   *
   * 摘要 Agent 的上下文只由转录与它自己写下的记忆两样东西决定，所以「模型忘了」
   * 不构成丢记忆的理由：记忆在磁盘上，摘要只是它的读者与改写者。
   * @param notice - 见 {@link digestPrompt}。
   * @returns 消耗的字符数，供日志用。
   */
  async function runDigest(notice) {
    const agent = await ensureDigestAgent(notice);
    const message = createUserMessage({
      content: [{ type: 'text', text: notice.instruction }],
      source: { kind: 'user' },
    });
    agent.followup(message);
    const timeoutMs = Math.max(1000, Math.floor(Number(config.digestTimeoutMs) || 0));
    let timer;
    const timeout = new Promise((resolve) => {
      // ctx.timeout 把定时器挂在当前 fiber 上，插件卸载时自动清掉；它返回 disposer。
      timer = typeof ctx.timeout === 'function' ? ctx.timeout(() => resolve('timeout'), timeoutMs) : setTimeout(() => resolve('timeout'), timeoutMs);
      timer?.unref?.();
    });
    const outcome = await Promise.race([agent.whenIdle?.().then(() => 'idle') ?? Promise.resolve('idle'), timeout]);
    if (typeof timer === 'function') timer();
    else clearTimeout(timer);
    if (outcome === 'timeout') {
      // 卡住的 turn 不该把摘要永久堵死：销毁这个 Agent，下一次重新开一个（转录还在磁盘上）。
      report('warn', `digest for ${notice.key} timed out after ${timeoutMs}ms; disposing the digest agent`);
      try {
        await digestHandle?.dispose();
      } catch (error) {
        report('warn', `could not dispose the digest agent: ${errorText(error)}`);
      }
      digestHandle = undefined;
      throw new Error(`digest timed out after ${timeoutMs}ms`);
    }
  }

  /**
   * 扫描所有会话，把「今天该摘要」的排进串行队列。
   *
   * 每天在 `digestAtHour` 点醒一次，所以判据不是「距上次多久」而是**日期**：这条会话
   * 今天已经摘要过就跳过（记在 `digest.json` 里的日期，重启也不会在同一天重复摘要，
   * 比「距上次 ≥ N 小时」稳）。外加一条 `digestMinLines`：今天没攒够新消息就留到明天
   * —— 为一两句话白跑一次模型调用不值得，消息也不会丢（dirty 计数按天累加）。
   */
  function runDigestSweep() {
    if (!memoryEnabled) return;
    digestChain = digestChain
      .then(async () => {
        // 状态都不必现读磁盘：`memoryLastDigest` 在启动时从 `digest.json` 预热、每次
        // 摘要成功后就地更新；`memoryDirty` 是本进程攒的计数（重启归零，靠日期重新算）。
        const today = localDate();
        const minLines = Math.max(1, Math.floor(Number(config.digestMinLines) || 1));
        const queue = [];
        for (const conversation of conversations.values()) {
          if (digestQueued.has(conversation.key)) continue;
          const lastDigestAt = memoryLastDigest.get(conversation.key) ?? 0;
          // 今天已经摘要过：同一个会话一天至多一次。
          if (lastDigestAt > 0 && localDate(lastDigestAt) === today) continue;
          const dirty = memoryDirty.get(conversation.key) ?? 0;
          // 攒够新消息才值得跑一次模型调用：没攒够就留到明天，消息不会丢
          // （dirty 计数一直累加，明天的窗口里还是它们）。
          if (dirty < minLines) continue;
          queue.push({ conversation, since: lastDigestAt });
        }
        for (const item of queue) {
          // 排进队列这一刻就把 dirty 清零：这一轮之后无论成败，都不该把同一批消息再喂一遍
          // （失败的时间戳不会推进，明天的摘要会把它们连同新消息一起补上）。
          memoryDirty.set(item.conversation.key, 0);
          void enqueueDigest(item.conversation, item.since);
        }
      })
      .catch((error) => {
        report('warn', `digest sweep failed: ${errorText(error)}`);
      });
  }

  /**
   * 把一个会话的摘要任务挂到串行链尾；完成后记一次状态。
   * @param conversation - 目标会话。
   * @param since - 上一次摘要的时间戳（0 = 头一次）。
   */
  function enqueueDigest(conversation, since) {
    digestQueued.add(conversation.key);
    digestChain = digestChain
      .then(async () => {
        const paths = memoryPaths(conversation.key);
        // 先把已经排队的转录落盘等干净：转录是**后台**追加的（不挡事件热路径），而
        // 「补课」这条路是收到消息后立刻触发的 —— 不等的话会读到一个还没写出来的日志
        // 目录，摘要就被静默跳过了（消息不会丢，但要等到明天的摘要点）。
        await Promise.all(writesFor(paths.logDir));
        const files = (await readdirOrEmpty(paths.logDir)).filter((name) => name.endsWith('.jsonl')).sort();
        // 多读一天：跨越午夜时「今天」和「昨天」两个文件都要，靠 at 时间戳再筛一次。
        const cutoff = since > 0 ? since - 24 * 60 * 60 * 1000 : 0;
        const lines = [];
        for (const name of files) {
          for (const line of await readJsonl(join(paths.logDir, name))) {
            if ((Number(line.at) || 0) >= cutoff) lines.push(line);
          }
        }
        lines.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
        const window = lines.filter((line) => (Number(line.at) || 0) > since);
        if (window.length === 0) return;
        const budget = Math.max(1000, Math.floor(Number(config.digestMaxChars) || 0));
        const rendered = renderTranscriptWindow(window, budget);
        if (rendered.included === 0) return;
        const until = new Date().toLocaleString('zh-CN', { hour12: false });
        const label = `${conversation.type === 'group' ? '群' : '私聊'} ${conversation.name || conversation.id}`;
        const header = rendered.dropped > 0
          ? `本批共 ${window.length} 条（${new Date(since || window[0].at).toLocaleString('zh-CN', { hour12: false })} 起），为了让这次摘要放得下，只给了你**最近**的 ${rendered.included} 条，更早的 ${rendered.dropped} 条这次没给（它们大多在上一次摘要里已经处理过了）。\n\n`
          : `本批共 ${window.length} 条。\n\n`;
        const instruction =
          `处理 ${label} 的聊天记录：${conversation.key}\n` +
          `（窗口起点：${since > 0 ? new Date(since).toLocaleString('zh-CN', { hour12: false }) : '首次摘要，看你能拿到的全部'}）\n\n` +
          `${header}${rendered.text}`;
        report('info', `digest ${conversation.key}: ${rendered.included}/${window.length} lines, ${rendered.text.length} chars`);
        await runDigest({
          key: conversation.key,
          label,
          slug: paths.slug,
          since: since > 0 ? new Date(since).toLocaleString('zh-CN', { hour12: false }) : '（此前没有摘要）',
          until,
          queue: [...digestQueued].filter((key) => key !== conversation.key),
          instruction,
        });
        const state = await readDigestState();
        const finishedAt = Date.now();
        memoryLastDigest.set(conversation.key, finishedAt);
        state.conversations[conversation.key] = {
          ...(state.conversations[conversation.key] ?? {}),
          // `at` 与 `date` 都要写：`date` 是「今天摘要过没有」的判据（本地日界线），
          // `at` 是转录窗口的起点。两份都在，读的时候就不必再换算时区。
          lastDigestAt: finishedAt,
          lastDigestDate: localDate(finishedAt),
          lastLines: window.length,
          lastLabel: label,
        };
        await writeDigestState(state);
      })
      .catch((error) => {
        report('warn', `digest for ${conversation.key} failed: ${errorText(error)}`);
      })
      .finally(() => {
        digestQueued.delete(conversation.key);
      });
  }


  /**
   * 禁漫（JM）下载服务：起 python 子进程下载 → 合并 PDF → 用一次性 URL 交给 NapCat。
   *
   * 为什么绕这么大一圈：NapCat 跑在容器里，插件跑在宿主机上，`upload_private_file`
   * 只认 URL（实测传本地路径会回 `识别URL失败`）。所以 PDF 落盘之后，插件在本机
   * docker 网桥上开一个小 HTTP 服务，把文件交给 NapCat 自己来拉。
   */
  const jmService = createJmService({
    cwd,
    dir: config.jmDir,
    python: config.jmPython,
    script: config.jmScript.trim().length > 0 ? config.jmScript : fileURLToPath(new URL('./scripts/jm_download.py', import.meta.url)),
    enabled: config.jmDownload,
    maxChapters: config.jmMaxChapters,
    maxPages: config.jmMaxPages,
    timeoutMs: config.jmTimeoutMs,
    requestTimeoutMs: config.jmRequestTimeoutMs,
    maxFiles: config.jmMaxFiles,
    maxJobs: config.jmMaxJobs,
    fileHost: config.jmFileHost,
    filePort: config.jmFilePort,
    urlTtlMs: config.jmUrlTtlMs,
    report,
  });

  /**
   * 取出（或创建）某个 QQ 会话所对应的 Agent。
   *
   * 查找顺序：先看 Harness 里该 session id 是否已活着（热路径，直接复用）；
   * 否则先 resume 已持久化的会话，resume 失败（首次对话）再 create 新建。
   * @param conversation - 要绑定的会话记录。
   * @returns 存活的 Agent。
   */
  async function ensureAgent(conversation) {
    const sessionId = sessionIdFor(conversation.key);
    const live = ctx.agents.get(sessionId);
    if (live !== undefined) {
      conversation.agent = live;
      // 句柄只在「还是同一个 Agent」时保留：换了 Agent 对象说明旧句柄已经失效。
      if (conversation.handle?.agent !== live) conversation.handle = undefined;
      sessionIndex.set(live.id, conversation.key);
      return live;
    }
    // 群名只影响提示词和会话列表的可读性，查询失败绝不能挡住回复链路。
    if (conversation.type === 'group' && conversation.name.length === 0) {
      conversation.name = await client
        .call('get_group_info', { group_id: Number(conversation.id) })
        .then((info) => String(info?.group_name ?? ''))
        .catch(() => '');
    }
    // 组装 agentOptions：只带上真正有值的字段，避免把空串当成显式选择。
    const chosen = resolveRoute();
    const agentOptions = {};
    if (chosen.provider.length > 0) agentOptions.provider = chosen.provider;
    if (chosen.model.length > 0) agentOptions.model = chosen.model;
    if (chosen.reasoningEffort !== undefined) agentOptions.reasoningEffort = chosen.reasoningEffort;
    if (chosen.model.length === 0) {
      throw new Error(`qq-bridge: no model for QQ sessions (${chosen.error}); set provider/model on the plugin`);
    }
    // Agent 预设：Web 表面（`dsh-web-app`）把 bash / fs / web_search 这些「agent 平面」
    // 的工具从宿主搬进了每个 Agent 预设，程序化创建的 Agent 必须先 join 一个预设，
    // 这些工具才会成为它继承来的工具。预设 id 在 create 之前解析，好让 meta 一并记录。
    const presetId = await resolveAgentPreset();
    // 部署 persona 会用 `agent.options` 里的值替换 `{{model}}`；这里再在 Agent 自己的
    // 作用域里覆盖一次，让「早于本次模型选择就存在」的 resume 会话也能正常渲染提示词，
    // 而不会让整个 turn 失败。同时把 QQ 渠道说明作为独立小节注入系统提示。
    const setup = async (agentCtx, agent) => {
      // 顺序不能反：先 join 预设（工具此刻才存在），再按白名单收窄，最后装配提示词
      // —— 提示词里提到的工具必须确实是这个 Agent 能看见的。
      await mountAgentPreset(agentCtx, agent, presetId);
      restrictAgentTools(agentCtx, agent);
      const prompt = agentCtx.get?.('systemPrompt');
      if (prompt === undefined) return;
      prompt.variable('model', () => agentOptions.model);
      prompt.variable('provider', () => agentOptions.provider);
      prompt.section({
        name: 'qq-bridge:channel',
        order: CHANNEL_SECTION_ORDER,
        interpolate: false,
        // 传函数而不是字符串：`SystemPrompt.section()` 会在每次装配时重新求值，
        // 群聊里换了发言者 / 群里又聊了几句都能立刻反映到提示词里。
        text: () => channelPrompt(conversation),
      });
    };
    let handle;
    try {
      handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup });
      report('info', `resumed ${sessionId} for ${conversation.key}`);
    } catch {
      handle = await ctx.agents.create({
        sessionId,
        meta: presetId.length > 0 ? { cwd, agentPreset: presetId } : { cwd },
        agentOptions,
        setup,
      });
      report('info', `created ${sessionId} for ${conversation.key}`);
    }
    conversation.agent = handle.agent;
    // 保留句柄：/reset 需要用它销毁这个 Agent（连同它的 Session 与写出句柄）。
    conversation.handle = handle;
    sessionIndex.set(handle.agent.id, conversation.key);
    // 无人值守的 QQ 会话默认一律拒绝需要审批的操作（工具会直接报「被拒绝」），
    // 避免群里的人通过机器人指挥它执行危险命令。
    if (approvalPolicy === 'never') {
      const approval = ctx.get('approval');
      try {
        approval?.setPolicy(handle.agent, 'never');
      } catch (error) {
        report('warn', `could not set approval policy: ${error?.message ?? error}`);
      }
    }
    return handle.agent;
  }

  /**
   * 解析 QQ 会话应当挂载的 Agent 预设 id。
   *
   * Web 表面（`dsh-web-app`）把 bash / fs / read / web_search 这些「agent 平面」的行
   * 从宿主搬进了每个 Agent 预设：宿主上不再有这些工具，程序化创建的 Agent 必须先
   * join 一个预设，它们才会出现在这个 Agent 继承来的工具里。不 join 预设的 Agent
   * 只有宿主平面注册的全局工具（本插件的 `qq_*`），于是 `allowTools` 里的
   * read / web_search 全部是「不存在的工具名」——白名单收窄得再准也给不出不存在的能力。
   *
   * 解析结果为 '' 表示不挂载：要么配置成 `none`，要么这个组合根本没有预设平面
   * （例如从 `dsh-base` 起的 headless 部署，工具本来就在宿主上）。
   * @returns 预设 id；不需要/无法挂载时为空串。
   */
  async function resolveAgentPreset() {
    const wanted = config.agentPreset.trim();
    if (wanted.toLowerCase() === PRESET_NONE) return '';
    const presets = ctx.get('agentPresets');
    // 没有预设平面：工具仍按老样子在宿主上，照常走白名单收窄即可。
    if (presets === undefined) return '';
    try {
      return (await presets.resolve(wanted.length > 0 ? wanted : undefined)).id;
    } catch (error) {
      // 配错预设名不能打死回复链路；但没有预设就没有 agent 平面的工具，白名单会
      // 退化成「只有 qq_*」，所以这条 warn 必须带上原因。
      report('warn', `could not resolve agent preset "${wanted.length > 0 ? wanted : '(default)'}": ${error?.message ?? error}`);
      return '';
    }
  }

  /**
   * 把某个 Agent join 到预设修订上（`agentPresets.mount()`）。
   *
   * 必须在 setup 里、用 Agent 自己的 ctx 调用：join 会把 Agent 作用域的父节点绑到
   * 预设的 standing key 上，预设里的工具随之成为 Agent **继承**来的工具，
   * `tools.restrict()` 才可能按白名单收窄它们。
   * @param agentCtx - Agent 自己的作用域上下文（setup 的第一个参数）。
   * @param agent - 刚创建/恢复的 Agent（仅用于日志）。
   * @param presetId - 已解析的预设 id；空串表示不挂载。
   */
  async function mountAgentPreset(agentCtx, agent, presetId) {
    if (presetId.length === 0) return;
    const presets = ctx.get('agentPresets');
    if (presets === undefined) return;
    try {
      await presets.mount(agentCtx, presetId);
      report('info', `${agent?.id ?? 'agent'} joined agent preset ${presetId}`);
    } catch (error) {
      report('warn', `could not mount agent preset ${presetId} on ${agent?.id ?? 'agent'}: ${error?.message ?? error}`);
    }
  }

  /**
   * 把配置里的工具白名单施加到某个 QQ 会话 Agent 自己的作用域上。
   *
   * `tools.restrict()` 只收窄「调用它的那个作用域」所继承的工具，所以必须用 Agent
   * 自己的 ctx 调用：它过滤掉继承来的全局/预设工具，而该作用域内注册的工具不受影响
   * （这也是 DSH 子代理 toolFilter 的同一套机制）。白名单为空 = 不限制。
   *
   * 前提是 Agent 已经 join 了预设（见 mountAgentPreset）：只放开**继承得到**的工具名，
   * 收窄得再准也变不出这个 Agent 组合里根本没有的能力。
   *
   * 名字写错时 `restrict()` 会直接抛错（它拒绝一切未知的工具名）。为了不让一个
   * 拼写错误打死整条 QQ 回复链路，这里退化成「当前真正看得见的那部分」：写错的名字
   * 丢掉并告警；一个都不剩时等于把工具全部收走 —— 使用者明确要的是白名单，所以
   * 宁可无工具（fail-closed），也不能悄悄退回全量工具。
   * @param agentCtx - Agent 自己的作用域上下文（其中的 tools 服务是作用域绑定的）。
   * @param agent - 刚创建/恢复的 Agent，同时作为 restrict/get 的视角 scope。
   */
  function restrictAgentTools(agentCtx, agent) {
    if (allowTools.length === 0) return;
    const tools = agentCtx?.tools;
    if (tools === undefined) {
      // 没有作用域绑定就没法收窄（全局 restrict 会遮蔽所有 Agent，被 DSH 明确拒绝）。
      report('warn', 'allowTools is configured but the Agent scope exposes no tools service; tools stay unrestricted');
      return;
    }
    try {
      tools.restrict({ allow: allowTools });
      report('info', `${agent?.id ?? 'agent'} limited to tools: ${allowTools.join(', ')}`);
      return;
    } catch (error) {
      const visible = allowTools.filter((name) => tools.get(name, agent) !== undefined);
      report('warn',
        `allowTools rejected (${error?.message ?? error}); keeping only the visible names: ${visible.join(', ') || '(none)'}` +
          // 这句是给「QQ 会话突然没有联网/读文件能力」准备的诊断线索：白名单只能收窄
          // 这个 Agent 组合里已有的工具，给不出它没有的能力。
          (visible.length < allowTools.length
            ? ' — a whitelist cannot grant tools this Agent does not have; check the agent preset mount (config agentPreset)'
            : ''),
      );
      try {
        tools.restrict({ allow: visible });
      } catch (fallbackError) {
        report('warn', `could not apply allowTools: ${fallbackError?.message ?? fallbackError}`);
      }
    }
  }

  /**
   * 渲染「群里最近在聊什么」小段。
   * 每次提示词装配时现算，因此拿到的一定是最新的群聊，而不是建 Agent 那一刻的快照。
   * @param conversation - 目标会话。
   * @returns 若干行；私聊或没缓冲到东西时为空数组。
   */
  function ambientPrompt(conversation) {
    if (conversation.type !== 'group') return [];
    const list = ambient.get(conversation.id) ?? [];
    if (list.length === 0) return [];
    return [
      '群里最近的消息（旧 → 新；都不是发给你的，只是让你知道大家在聊什么，不必逐条回应）：',
      ...list.map((entry) => `  ${entry.name}: ${entry.text}`),
      '',
    ];
  }

  /**
   * 「现在是谁在跟你说话」那一行。
   *
   * 只有一个人时就是原来那句；几个人几乎同时说话（一批攒到一起）时把人都列出来 ——
   * 只报最后一个会让模型以为只有那一个人在问，回出来就是漏人的客服式答复。
   * @param conversation - 目标会话。
   * @returns 一行提示词。
   */
  function speakerLine(conversation) {
    const speakers = conversation.speakers ?? [];
    if (speakers.length > 1) {
      const list = speakers.map((speaker) => `${speaker.name}（QQ ${speaker.id}）`).join('、');
      return `几乎同时在跟你说话的是：${list} —— 他们的话是一起到的，按聊天的节奏挑着接。`;
    }
    return `刚跟你说话的人：${conversation.senderName}（QQ ${conversation.senderId}）。`;
  }

  /**
   * 表情包目录里认得出来的图片文件名（**不带**目录前缀）；目录不存在/不可用时为空。
   *
   * 用同步 readdir 而不是 async：`SystemPrompt.section()` 的 text provider 是**同步**
   * 求值的（每次装配提示词都要重新算，群聊上下文正是靠这个才不过期），而这里读的是一个
   * 一层、几十个文件的小目录 —— 一次 readdir 的代价远小于为它引入缓存与失效逻辑。
   * 只认 PNG/JPEG/WebP/GIF（发送侧也只认这四种，列个 README.md 出来只会让模型去撞一次错）。
   */
  function stickerFiles() {
    if (stickerRoot === undefined || !stickerInside) return [];
    try {
      return readdirSync(stickerRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && /\.(png|jpe?g|gif|webp)$/i.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      return []; // 还没建 / 被删了 / 没权限：当作「没有表情包」，不影响其余提示词。
    }
  }

  /**
   * 表情包目录里认得出来的图片路径（相对 cwd，带目录前缀），供渠道提示列候选。
   * @returns 形如 `['.qq-stickers/笑死.gif', …]` 的数组，最多 `STICKER_PROMPT_MAX` 个。
   */
  function stickerNames() {
    if (stickerLabel === undefined) return [];
    return stickerFiles()
      .sort()
      .slice(0, STICKER_PROMPT_MAX)
      .map((name) => `${stickerLabel}/${name}`);
  }

  /**
   * 把「一个表情包文件名」补成真路径。
   *
   * 模型很可能不写全 `.qq-stickers/笑死.gif` 而只写 `笑死` / `笑死.gif`（提示词里两种
   * 写法都在眼前），`loadOutgoingImage` 按 cwd 相对路径去找就会落空、只能回一句
   * 「表情包没发出去」。所以裸文件名先在表情包目录里找：先精确匹配，再忽略扩展名匹配。
   *
   * 只兜**裸文件名**：带路径分隔符或协议的写法原样交出去，绝不改写
   * （`.qq-media/xxx.jpg`、`https://…` 都不该被这层碰）。
   *
   * @param source - 标记或工具参数里给的来源。
   * @returns 能认出来就是相对 cwd 的路径，否则原样返回。
   */
  function resolveStickerSource(source) {
    const raw = String(source ?? '').trim();
    if (raw.length === 0 || stickerLabel === undefined) return raw;
    if (/[/\\]/.test(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
    const files = stickerFiles().sort(); // 排序只是为了「同名不同扩展名」时挑哪个是确定的
    const exact = files.find((name) => name === raw);
    const byBase = exact ?? files.find((name) => name.replace(/\.[^.]+$/, '') === raw);
    return byBase === undefined ? raw : `${stickerLabel}/${byBase}`;
  }

  /**
   * 生成「每个会话各不相同」的系统提示补充段落（渠道身份、群聊上下文、说话方式）。
   *
   * 注意这个函数是作为 `text` 的 provider 注册的、每次提示词装配都会被调用：
   * 群聊里换个人说话、或者群里又聊了几句，模型下一轮就能看到最新的 —— 若改成
   * 建 Agent 时算一次的字符串，提示词里的「当前发言者」会永远停在第一个人。
   */
  function channelPrompt(conversation) {
    const isGroup = conversation.type === 'group';
    const title = conversation.name.length > 0 ? `「${conversation.name}」` : '';
    const who = isGroup
      ? `你正在 QQ 群${title}（群号 ${conversation.id}）里潜水，身份是群里的一个普通群友 —— 不是客服，也不是助手。`
      : `你正在用 QQ 私聊：对方 ${conversation.name}（QQ ${conversation.id}）。`;
    const lines = [
      '## QQ 渠道',
      '',
      who,
      '',
      ...(isGroup
        ? [speakerLine(conversation), '', ...ambientPrompt(conversation)]
        : []),
      (config.persona.trim().length > 0 ? config.persona.trim() : DEFAULT_PERSONA),
      '',
    ];
    // 长期记忆：把「已记住的东西」摆到眼前，模型才不会每次都从零开始 —— 并明确
    // 告诉它「忘了就去查」，而不是凭印象编。索引是摘要 Agent 维护的，这里只读。
    if (memoryToolsAllowed()) {
      const index = memoryIndexText(conversation);
      if (index.length > 0) {
        lines.push('你记得的事（长期记忆的索引；原文件在 `' + memoryLabel + '/`）：', '', index, '');
      } else {
        lines.push(`你的长期记忆在 \`${memoryLabel}/\` 里（现在还是空的）。`, '');
      }
    }
    // 「一轮发几条」这条规则必须跟当前配置一致：设了 burstMaxMessages: 1 之后还告诉模型
    // 「想连说几句就直接换行」，就是一条它照做也做不到的指示（换行会被并回同一条）。
    // 混合模式（burstSingleMaxChars > 0）则要同时说清「闲聊别拆」和「展开就分条」。
    const messageCap = burstMessageCap();
    const singleUnder = burstSingleUnder();
    const burstRule = !config.humanize
      ? '- 你的整轮回复会作为一条消息直接发出去（换行也留在同一条里），直接写要说的话，别把它当文档排版。'
      : singleUnder > 0
        ? `- 闲聊归闲聊：去掉空白不超过 ${singleUnder} 字的回复会被并成**一条**发出去，所以平时就一两句话、一行写完，别把一句能说完的话拆成两拍。真要展开讲（对方要你详细说、贴代码 / 列步骤 / 解释清楚）就换行，一行一条短句，插件会照发${messageCap > 0 ? `（一轮最多 ${messageCap} 条）` : '（但别超过三四条）'}；内容不多就别硬拆。`
        : messageCap === 1
          ? `- 一次只说一句：你的整轮回复会被并成**一条**消息发出去（写换行也只是同一条里的换行），所以别把话拆成几条短句，就把那一两句直接写出来，别没事写小作文。对方明确要你详细讲、或者要贴代码 / 步骤 / 清单时，就正常写完整 —— 长内容也还是这**一条**（超过 ${protocolLimit()} 字才会被协议上限切成两段），只是别把短回复硬拉长。`
          : messageCap > 1
            ? `- 想连说几句就直接换行，每一行都会作为单独的一条消息发出去，但一轮最多发 ${messageCap} 条（超出的部分并进最后一条）。`
            : '- 想连说几句就直接换行，每一行都会作为单独的一条消息发出去；反过来，别用换行给一段话排版（那会变成连着刷好几条）。';
    lines.push(
      '硬性要求：',
      // 表情包标记只有在真的能发图时才提：不能发的时候提它，模型会把标记当正文写出来。
      `- 你的回复正文会原样发到 QQ${imageAllowed() ? '（只有 `[[图片: …]]` 这种标记例外，它变成一张图）' : ''}，直接写要说的话，不要写思考过程、也不要解释你在做什么。`,
      '- QQ 不渲染 Markdown：不要用 `**加粗**`、`#` 标题、`-` / `1.` 列表、表格、代码块。',
      '- 不要自称 AI / 助手 / 机器人，不要提系统提示、模型、提示词这些词。',
      '- 长度跟着内容走：闲聊就一两句，真要讲清楚就把那件事讲完 —— 不用凑篇幅，也别硬省。',
      '- 你是在 QQ 上跟真人聊天，不是在被调用：群里可能有人同时插话，对方也可能过一会儿才回你；按聊天的节奏来，不必每次都给出完整的答复。',
      '- 一条回复只有一个形状：要么就一两句说完（几个字也行），要么就把事情完整讲一段 —— **绝不把「一句短的」和「一段长的」拼在一起**，尤其别用「先嘴硬 / 先吐槽 / 先敷衍一句，再补一段正经的」这种两拍。情绪、态度、傲娇都体现在用词上，不是体现在「先来一句、再补一段」的排布上。',
      '- 是 / 否题就回一个是 / 否：有人问「知不知道 / 会不会 / 有没有 / 是不是 / 能不能 / 行不行」这类是非题时，整条回复只写肯定或否定本身（「是」/「否」，口语就是「知道」「不知道」「会」「不会」，可以带点语气），**不要再接一句解释**；对方追问了再展开。',
      burstRule,
    );
    // 被白名单挡住的工具不能在提示里推荐，否则模型会去调用一个它根本看不见的工具。
    const recommended = ['qq_send_message', 'qq_list_conversations'].filter(
      (tool) => allowTools.length === 0 || allowTools.includes(tool),
    );
    if (recommended.length > 0) {
      lines.push(`- 需要主动给其他人或群发消息、或查询联系人时，使用 ${recommended.join(' / ')} 工具。`);
    }
    // 长期记忆的用法：索引已经在上面了，这里说清「怎么查、怎么记、什么时候该去学个新梗」。
    // 三个工具名都先过白名单，避免推荐一个模型根本看不见的工具。
    if (memoryToolsAllowed()) {
      const canSkill = allowTools.length === 0 || allowTools.includes('skill');
      lines.push(
        `- 凭印象记不清「以前谁说过什么 / 这个群里发生过什么」时，别顺着猜：用 qq_transcript 查聊天记录（可以按关键词 search），用 qq_memory 读 \`${memoryLabel}/\` 里的记忆文件——先查再答，而不是先答再编。`,
        `- 真遇到值得长期记住的事（某人的偏好、群里的约定、一件发生过的事），用 qq_memory 追加到 \`conversations/<会话目录>/MEMORY.md\`；不要为了记而记，一两句就够。`,
        canSkill
          ? '- 遇到看不懂的梗、黑话或表情包（图里写了什么、为什么大家都在笑），先用 read_image 看那张图，再加载 `update-cognition` skill 按它的规矩把它记进认知库；弄懂了再接着聊，不要不懂装懂、也不要一本正经地解释网络梗。'
          : '- 遇到看不懂的梗、黑话或表情包，先用 read_image 看那张图；弄不懂就直接说不懂，不要不懂装懂、也不要一本正经地解释网络梗。',
      );
    }
    // 图片/表情包只有落盘之后才「看得见」：把路径告诉模型，还得告诉它该用哪个工具读。
    // 没有 read_image 就别提这件事，否则模型会去调用一个它根本看不见的工具。
    const canReadImages = mediaStore.enabled && (allowTools.length === 0 || allowTools.includes('read_image'));
    if (canReadImages) {
      lines.push(
        '- 消息里、`（引用 …）` 前缀里、以及下面「群里最近的消息」里的 `[图片: 路径]`（也可能是 `[图片(动画表情): 路径]`、`[表情包: 路径]`）都是已经下载到本地的图，路径相对工作目录：想知道图里是什么就用 read_image 读它，别靠猜；带「没能取到文件」的是没下下来，可以直说图挂了。这些路径是给你自己看的，别原样写进回复。',
      );
    }
    // 反过来：模型也能主动往 QQ 甩图 / 表情包。两条路：
    //   ① 正文里的 `[[图片: …]]` 标记 —— 按它在正文里的位置发出去，整条回复只有这一行时
    //      就是「只发一张表情、一个字都不说」（这也是唯一能表达「不说话」的方式，模型光靠
    //      工具做不到：工具调用之外它总得写点什么）；
    //   ② qq_send_image 工具 —— 显式动作，可以指定别的目标。
    // 标记不是工具，但**跟着同一个开关走**：`allowTools` 把 qq_send_image 挡在外面时，
    // 回复里也不该还能发图 —— 否则白名单就漏了一层（operator 明确说了「只给 read」）。
    if (imageAllowed()) {
      lines.push(
        '- 想发表情包 / 甩张图时，在回复正文里写 `[[图片: 路径]]`（路径的写法就是正文里那些 `[图片: …]` 里的样子，例如 `[[图片: .qq-media/ab12….jpg]]`）：这个标记会作为**一张图**发出去，位置就在它出现的地方。**想只发一张表情、一个字都不说，整条回复就只写这一行** —— 别配「给你发张表情包」这种话。别人刚发的那张图也能这样发回去，把正文里给它的路径写进标记就行。',
        '- 要给**别的**群 / 好友发图、或者就是「把这张图发过去」这种明确动作，用 qq_send_image 工具（它也接受 http(s) 图片链接；它是立刻发出去的，不跟在正文的行序里）。',
      );
      const names = stickerNames();
      if (stickerLabel !== undefined) {
        lines.push(
          names.length > 0
            ? `- 你自己的表情包在 ${stickerLabel}/ 里：${names.join('、')}。文件名通常就是它的意思${canReadImages ? '，拿不准的先 read_image 看一眼' : ''}；想发哪张就把它的路径写进标记里。表情包别滥用 —— 一次最多一张，也别每句都配一张。`
            : `- 你自己的表情包目录 ${stickerLabel}/ 目前是空的，没有现成的表情包可挑（别人刚发的那张图仍然可以发回去）。`,
        );
      }
    }
    // 引用前缀是插件加上去的，得告诉模型它是什么，否则会被当成对方原话的一部分。
    // 它同时也带正文，所以不依赖 read_image 是否可用。
    if (config.quoteMedia) {
      lines.push(
        '- 正文开头的 `（引用 某某: …）` 表示对方是在**回复那条消息**：内容是插件替你取回来的（里面可能带图片路径），别当成对方又重复说了一遍，也别再问「你说的是哪条」。',
      );
    }
    // 禁漫下载：工具会把 PDF 直接发到这个会话，模型只要接一句话就行。
    if (jmService.enabled && (allowTools.length === 0 || allowTools.includes('qq_jm_pdf'))) {
      lines.push(
        '- 有人甩过来禁漫（JM / 18comic）的车号或 album / photo 链接让你下载时，用 qq_jm_pdf 工具：它会把整本合并成一个 PDF 并直接把文件发到这个会话。别自己复述车号或链接，也别承诺页数，下完说一句「下好了」之类的就行（下不动就把原因说清楚）。',
      );
    }
    if (config.instructions.trim().length > 0) {
      lines.push('', config.instructions.trim());
    }
    return lines.join('\n');
  }

  /** 协议允许的单条消息长度上限（`maxReplyChars` 非法时回退 1500）。 */
  function protocolLimit() {
    return Number.isSafeInteger(config.maxReplyChars) && config.maxReplyChars > 0 ? config.maxReplyChars : 1500;
  }

  /**
   * 这个 Agent 能不能往 QQ 发图。
   *
   * 两个条件：`imageSend` 开着；配了 `allowTools` 时里面得有 `qq_send_image`。
   * 回复正文里的 `[[图片: …]]` 标记也走这个判断 —— 它不是工具，但同一个开关得管住它，
   * 否则「白名单只给 read」的会话仍然能靠一个标记把图发出去（详见 channelPrompt）。
   */
  function imageAllowed() {
    return imageSend && (allowTools.length === 0 || allowTools.includes('qq_send_image'));
  }

  /**
   * 一轮回复最多发几条（`burstMaxMessages`；非正数 / 非法值 = 不限）。
   *
   * 提示词与拆条都要读它：提示词在「一次只发一条」时不能再说「想连说几句就换行」，
   * 否则模型会照着一条它做不到的规则写。
   */
  function burstMessageCap() {
    return Number.isFinite(config.burstMaxMessages) ? Math.max(0, Math.floor(config.burstMaxMessages)) : 0;
  }

  /**
   * 「日常闲聊并成一条」的字数门槛（`burstSingleMaxChars`；非正数 = 关掉）。
   *
   * 按去掉空白后的字数算：换行、缩进这些排版字符不该把一条闲聊顶过门槛。
   */
  function burstSingleUnder() {
    return Number.isFinite(config.burstSingleMaxChars) && config.burstSingleMaxChars > 0
      ? Math.floor(config.burstSingleMaxChars)
      : 0;
  }

  /**
   * 把一段回复拆成「像真人连着发的」几条消息。
   *
   * 不开启 `humanize` 时就是旧行为（只在超过协议上限时分段）。开启后先把换行拆成
   * 一条条独立消息（换行 = 分条，不再是同一条里的排版），再对每一行按标点/长度拆成
   * 短句（受 `burstMaxChars` / `burstMaxParts` 约束），最后每段都接受一次协议上限的
   * 硬校验 —— 模型偶尔写超长时，最后一段仍可能被 `chunkText` 再切开。
   *
   * 「发几条」分两种情形，**由长度自动切换**（`burstSingleMaxChars`）：
   * - **短回复 = 闲聊**：不超过门槛时强制并成一条（等价于把上限压到 1）。模型爱把
   *   一句话写成「短句 + 长句」两拍、或者在同一个 turn 里连写两段，光靠提示词压不住，
   *   所以闲聊的一条是硬保证 —— 但内容一个都不删，只是并回同一条。
   * - **长回复 = 真要展开**（贴代码、列步骤、详细解释）：这时并成一条反而难读，
   *   于是照常拆成多条短句，条数由 `burstMaxMessages`（0 = 不限）与
   *   `burstMaxParts` 一起决定。
   *
   * @param text - 模型给出的完整回复。
   * @returns 按发送顺序排列的分段。
   */
  function burstParts(text) {
    const limit = protocolLimit();
    if (!config.humanize) return chunkText(text, limit);
    const burst = Number.isSafeInteger(config.burstMaxChars) && config.burstMaxChars > 0
      ? Math.min(config.burstMaxChars, limit)
      : limit;
    const maxParts = Number.isFinite(config.burstMaxParts) ? Math.max(1, Math.floor(config.burstMaxParts)) : 3;
    const singleUnder = burstSingleUnder();
    const short = singleUnder > 0 && text.replace(/\s+/g, '').length <= singleUnder;
    const maxMessages = short ? 1 : burstMessageCap();
    return splitBurst(text, burst, maxParts, maxMessages).flatMap((part) => chunkText(part, limit));
  }

  /** 发送前等待（`ms <= 0` 时立即返回）；unref 让待发的延迟不拖住进程退出。 */
  function sleep(ms) {
    if (!(ms > 0)) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  /**
   * 把一次发送挂到会话的串行链上。
   *
   * 同一个会话的发送挂在 `conversation.sending` 上串行执行：拟人延迟会让一次回复
   * 持续好几秒，若不排队，下一轮回复（或一句复读）会插进来，群里看到的就是两条
   * 消息交错。前一次失败也要继续排下一次，所以两个分支都接上 `run`。
   *
   * @param conversation - 目标会话。
   * @param run - 真正的发送步骤（调用方保证自己不会 reject）。
   * @returns 本次发送完成时兑现的 Promise，绝不 reject。
   */
  function enqueueSend(conversation, run) {
    const chained = (conversation.sending ?? Promise.resolve()).then(run, run);
    conversation.sending = chained.then(
      () => {},
      () => {},
    );
    return chained;
  }

  /**
   * 把一条回复发到 QQ：拆段、按真人打字节奏加延迟，任一段失败即停止。
   *
   * 正文里的 `[[图片: 路径]]` 标记会变成一张真的图（见 `replyPieces`）——「只发表情、
   * 一个字都不说」就是整条正文只有那一处标记。
   *
   * @param conversation - 目标会话。
   * @param text - 要发送的正文（可含表情包标记）。
   * @param options - `human`：拆短句 + 打字延迟（自动回复用）；`quote`：本轮的回复指向
   *   `{ messageId, userId, seq }`，仅群聊生效，且只挂在第一条上。
   * @returns 本次发送（含延迟）完成时兑现的 Promise，绝不 reject。
   */
  function sendToConversation(conversation, text, { human = false, quote } = {}) {
    return enqueueSend(conversation, () => sendParts(conversation, text, human, quote ?? { messageId: '', userId: '', seq: 0 }));
  }

  /**
   * 把一段正文**原样**发给会话：不认 `[[图片: …]]` 标记、不拆短句、不加打字延迟。
   *
   * 复读专用 —— 群里有人把 `[[图片: .qq-media/…]]` 这种字样打两遍时，那是两句**文字**，
   * 不是让机器人发文件的指令：标记只解析模型写的回复（`replyPieces`）。复读机的正文
   * 全部来自不可信的群消息，所以这里一步都不多做，只按协议上限分段。
   *
   * @param conversation - 目标会话。
   * @param text - 要原样发出的正文。
   * @returns 本次发送完成时兑现的 Promise，绝不 reject。
   */
  function sendLiteral(conversation, text) {
    return enqueueSend(conversation, async () => {
      for (const part of chunkText(text, protocolLimit())) {
        if (!(await sendOne(conversation, part))) return;
      }
    });
  }

  /**
   * 把一条回复拆成「要一条条发出去的东西」：文字段与表情包段，顺序照原文。
   *
   * 正文里的 `[[图片: 路径]]`（见 `splitStickerLines`）在这里被认出来变成一张图 ——
   * 于是「只发表情、一个字都不说」就是整条回复只写这一行：拆出来只有一个图片段，
   * 一条文字都不会发出去。没允许发图时（`imageAllowed()`）它退回普通文字，
   * 别让一个错标记变成一次「发不出去的图」。
   *
   * @param text - 模型给出的完整回复。
   * @param human - 是否按拟人节奏拆短句（与 `burstParts` 同一套规则）。
   * @returns `{ kind: 'text', text }` 或 `{ kind: 'image', source, raw }` 的数组。
   */
  function replyPieces(text, human) {
    const asText = (value) => (human ? burstParts(value) : chunkText(value, protocolLimit())).map((part) => ({ kind: 'text', text: part }));
    return splitStickerLines(text).flatMap((piece) => {
      if (piece.kind === 'text') return asText(piece.text);
      if (!imageAllowed()) return asText(piece.raw); // 没允许发图时标记只是普通文字
      return [piece];
    });
  }

  /**
   * 发一条已经组装好的 `message`。
   * @returns 成功为 true；失败只记一条 warn（调用方决定是否继续发后面的）。
   */
  async function sendOne(conversation, message) {
    // 群聊与私聊走不同的 OneBot action，参数名也不同。
    const action = conversation.type === 'group' ? 'send_group_msg' : 'send_private_msg';
    const idKey = conversation.type === 'group' ? 'group_id' : 'user_id';
    try {
      await client.call(action, { [idKey]: conversation.id, message });
      // 记下「我最后在这里说话是什么时候」：主动说话靠它避免对着没人的群自说自话
      // （见 proactiveEligible）。所有真正发出去的消息都走这个函数，所以自动回复、
      // 复读、主动搭话都会被记上；出站工具那条路自己发，不计也无关紧要。
      conversation.lastBotSpeakAt = Date.now();
      return true;
    } catch (error) {
      report('warn', `could not send to ${conversation.key}: ${error?.message ?? error}`);
      return false;
    }
  }

  /** `sendToConversation` 的实际发送步骤（调用方已保证同一会话串行）。 */
  async function sendParts(conversation, text, human, quote) {
    const pieces = replyPieces(text, human);
    for (const [index, piece] of pieces.entries()) {
      if (human) {
        // 第一条前多等一个「读消息」的时间；后续每条只算打字时间。
        // 表情包没有字数可算，等一个下限就够（第一张仍然算「读消息」那一段时间）。
        // 字段逐个显式传：`delayJitter` 与纯函数的 `jitter` 不同名，整包展开会静默丢掉抖动。
        await sleep(typingDelayMs(piece.kind === 'text' ? piece.text.length : 0, {
          charsPerSecond: config.charsPerSecond,
          minDelayMs: config.minDelayMs,
          maxDelayMs: config.maxDelayMs,
          jitter: config.delayJitter,
          baseMs: index === 0 ? config.readDelayMs : 0,
        }));
      }
      const head = quoteHead(conversation, index, quote);
      if (piece.kind === 'text') {
        // 没有指向时仍然发纯字符串：与旧版发送格式完全一致，也少一个出错点。
        if (!(await sendOne(conversation, head === undefined ? piece.text : [head, { type: 'text', data: { text: piece.text } }]))) return;
        continue;
      }
      let bytes;
      try {
        bytes = (await loadOutgoingImage({ source: resolveStickerSource(piece.source), cwd, maxBytes: imageMaxBytes })).bytes;
      } catch (error) {
        // 表情包发不出去**不能静默**：整条回复只有这一行时，静默就等于「机器人没理人」。
        report('warn', `sticker ${piece.source} could not be sent: ${errorText(error)}`);
        const notice = '（表情包没发出去）';
        if (!(await sendOne(conversation, head === undefined ? notice : [head, { type: 'text', data: { text: notice } }]))) return;
        continue;
      }
      const segment = imageSegment(bytes);
      if (!(await sendOne(conversation, head === undefined ? [segment] : [head, segment]))) return;
    }
  }

  /**
   * 本轮回复第一条上的「指向」段（引用 / @）。
   *
   * 只有群聊的**第一条**才带指向：真人不会每条都 @ 一遍，引用刷屏也很烦。
   * @param conversation - 目标会话。
   * @param index - 在本轮分段里的序号（0 = 第一条）。
   * @param quote - 被回复消息的 `{ messageId, userId, seq }`。
   * @returns 要挂在前面的段；不需要指向时 undefined。
   */
  function quoteHead(conversation, index, quote) {
    if (index !== 0 || conversation.type !== 'group') return undefined;
    const style = config.replyStyle;
    if (style === 'auto') {
      // 只在「我回的那条后面又有人说话」时才引用。紧挨着回时引用是纯噪音：一轮问答
      // 本来就看得出来在回谁，每条都挂个引用块反而像机器人在逐条点着回复。
      // 中间隔了别人的话才需要点名，不然接不上话头。
      const drifted = typeof quote.seq === 'number' && (chatterSeq.get(conversation.id) ?? 0) > quote.seq;
      if (!drifted || quote.messageId.length === 0) return undefined;
      return { type: 'reply', data: { id: quote.messageId } };
    }
    if (style === 'quote' && quote.messageId.length > 0) return { type: 'reply', data: { id: quote.messageId } };
    if (style === 'at' && quote.userId.length > 0) return { type: 'at', data: { qq: quote.userId } };
    return undefined;
  }

  // ---- 禁漫（JM）下载 → PDF → 发到 QQ ----------------------------------------
  // `/jm <车号|链接>` 指令与 `qq_jm_pdf` 工具走的是同一条链路：下载（jm.js 里的
  // python 子进程）→ 拿一次性 URL 交给 NapCat 上传。区别只在于「谁点的」和
  // 「要不要先回一句」。

  /**
   * 指令匹配器：`jmCommand` 里的斜杠可有可无（群聊 `groupTrigger: prefix` 会把
   * 开头的 `/` 当触发前缀吃掉，两种写法都得认识）。
   */
  const jmCommandPattern = (() => {
    const command = config.jmCommand.trim();
    if (command.length === 0) return undefined;
    const bare = command.replace(/^\/+/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^/?${bare}(?:\\s+|$)`, 'i');
  })();

  /**
   * 读一条「直接下载」指令。
   * @param text - 已 trim 的正文。
   * @returns `{ rest }`（命中指令，`rest` 是指令后面的参数）或 `{ rest, ref }`；没命中时 undefined。
   */
  function readJmCommand(text) {
    if (jmCommandPattern === undefined) return undefined;
    const match = jmCommandPattern.exec(text);
    if (match === null) return undefined;
    const rest = text.slice(match[0].length).trim();
    return { rest, ref: rest.length > 0 ? parseJmRef(rest) : undefined };
  }

  /** 把 `meta` 事件渲染成一句人话（标题 / 话数 / 页数）。 */
  function describeJm(meta) {
    const title = typeof meta?.title === 'string' && meta.title.length > 0 ? `《${meta.title}》` : `jm${meta?.id ?? ''}`;
    const extra = [];
    if (Number(meta?.chapters) > 1) extra.push(`${meta.chapters} 话`);
    if (Number(meta?.pages) > 0) extra.push(`${meta.pages} 页`);
    return extra.length > 0 ? `${title}（${extra.join(' · ')}）` : title;
  }

  /**
   * 取一个可用的发送目标：已经有会话记录就复用（发送串行链也一起复用），
   * 否则给一个一次性的壳 —— 出站工具可能指向一个从没聊过的群/好友。
   */
  function targetConversation(type, id) {
    const key = `${type}:${id}`;
    const existing = conversations.get(key);
    if (existing !== undefined) return existing;
    return blankConversation(key, type, id);
  }

  /**
   * 解析出站工具（`qq_send_image` / `qq_jm_pdf`）该发给谁。
   *
   * 优先用显式给的 `target_type` / `target_id`；没给就看调用它的 Agent 是不是某个
   * QQ 会话的 Agent —— 从 QQ 会话里调用时，「发回当前会话」才是最自然的默认值，
   * 模型不该为了回一张图先去查一遍自己的 QQ 号。两者都没有（Web UI 主会话里调用）
   * 就必须报错，而不是猜一个收件人。
   *
   * @param args - 工具参数（可能带 `target_type` / `target_id`）。
   * @param exec - 工具执行上下文（`exec.agent.id` 用来反查 QQ 会话）。
   * @param toolName - 工具名，只用来拼报错信息。
   * @returns `{ conversation, type, id }`：目标会话记录与归一化后的类型/号。
   */
  function resolveTarget(args, exec, toolName) {
    const fromAgent = exec?.agent?.id !== undefined ? conversations.get(sessionIndex.get(exec.agent.id)) : undefined;
    const type = args.target_type ?? fromAgent?.type;
    const id = args.target_id !== undefined ? String(args.target_id).trim() : fromAgent?.id;
    if (type === undefined || id === undefined || id.length === 0) {
      throw new Error(`${toolName} needs target_type and target_id when it is not called from a QQ conversation`);
    }
    // 目标就是调用方自己那个会话时复用它的记录（发送也就跟着那条串行链走）。
    const conversation = fromAgent !== undefined && fromAgent.type === type && fromAgent.id === id
      ? fromAgent
      : targetConversation(type, id);
    return { conversation, type, id };
  }

  /**
   * 把 PDF 交给 NapCat 发到 QQ。
   *
   * NapCat 在容器里、插件在宿主机上，只能给它一个 URL 让它自己来拉（传本地路径会
   * 回 `识别URL失败`，因为容器里根本没有那个文件）。群文件还要机器人有上传权限，
   * 失败时如实把原因带回去，由调用方决定怎么措辞。
   * @returns `{ ok: true }` 或 `{ ok: false, error }`。
   */
  async function sendJmFile(conversation, job) {
    let url;
    try {
      url = await jmService.serve(job.path, job.name);
    } catch (error) {
      return { ok: false, error: `file server: ${errorText(error)}` };
    }
    const group = conversation.type === 'group';
    const action = group ? 'upload_group_file' : 'upload_private_file';
    // 群文件接口允许带 folder；NapCat 接受空串，显式给一个免得别的实现报缺参。
    const params = group
      ? { group_id: conversation.id, file: url, name: job.name, folder: '' }
      : { user_id: conversation.id, file: url, name: job.name };
    try {
      await client.call(action, params, config.jmUploadTimeoutMs);
      report('info', `jm: uploaded ${job.name} (${job.bytes} bytes) to ${conversation.key}`);
      return { ok: true };
    } catch (error) {
      const reason = errorText(error);
      report('warn', `jm: ${action} to ${conversation.key} failed: ${reason}`);
      return { ok: false, error: reason };
    }
  }

  /**
   * 跑一次「下载 + 发送」。下载本身在 jm.js 里（python 子进程 + 并发键）。
   * @param options.conversation - 目标会话。
   * @param options.ref - `{ id, kind }`。
   * @param options.onMeta - 拿到元信息时回调（进度提示用）。
   * @returns 下载结果（含 `path` / `name` / `pages` / `bytes` / `title`）。
   */
  async function downloadJm({ conversation, ref, onMeta }) {
    if (!jmService.enabled) {
      throw new Error('禁漫下载没启用（检查 jmDownload / jmDir / jmPython / jmScript）');
    }
    if (jmService.isRunning(conversation.key)) {
      const busy = new Error('这个会话已经有一个下载在跑了');
      busy.code = 'JM_BUSY';
      throw busy;
    }
    return jmService.run({ id: ref.id, kind: ref.kind, key: conversation.key, onMeta });
  }

  /**
   * `/jm <车号>` 的完整直线：先回一句「收到」，拿到元信息再回一句「找到了」，
   * 下完把 PDF 发上去。全程不进 Agent —— 车号是明确的任务，没必要让模型参与。
   * 任何失败都变成一句人话回给 QQ（这条链路是无人值守的）。
   */
  async function runJmCommand(conversation, ref, quote) {
    if (!jmService.enabled) {
      await sendToConversation(conversation, '（禁漫下载没开：jmDownload 关了，或者 jmDir / jmPython 配得不对）', { quote });
      return;
    }
    if (jmService.isRunning(conversation.key)) {
      await sendToConversation(conversation, '（还在下上一本，等下）', { quote });
      return;
    }
    await sendToConversation(conversation, `收到，去下 jm${ref.id} 了…`, { quote });
    try {
      const job = await downloadJm({
        conversation,
        ref,
        // 元信息一到就先报一句：整本可能下十几分钟，不能让群里干等。
        onMeta: (meta) => {
          void sendToConversation(conversation, `找到了：${describeJm(meta)}，下完直接发文件`);
        },
      });
      const sent = await sendJmFile(conversation, job);
      if (sent.ok) await sendToConversation(conversation, `下好了：${describeJm({ id: ref.id, title: job.title, chapters: job.chapters, pages: job.pages })}`);
      else await sendToConversation(conversation, `下好了，但文件发不出去：${sent.error}`);
    } catch (error) {
      if (error?.code === 'JM_BUSY') {
        await sendToConversation(conversation, '（还在下上一本，等下）');
        return;
      }
      await sendToConversation(conversation, `没下成：${errorText(error)}`);
    }
  }

  /**
   * 找出并删除某个 Session 在磁盘上的持久化记录。
   *
   * 位置来自 sessionPersistence 服务自己解析出的 `root`（jsonl 后端把 root 作为
   * 公开字段暴露出来），布局是 `<root>/<项目目录>/<会话 id>/`；这里按「项目目录」
   * 通配一层，而不是自己重算项目目录的编码规则，避免和宿主的命名逻辑绑死。
   * 只用服务给出的这一个根目录：多扫一个候选根目录意味着可能碰到不属于本进程的
   * 数据（测试里就出现过「按真实 ~/.dsh 路径删掉线上会话」的危险），所以拿不到
   * `root` 时才退回 `$DSH_HOME/sessions`（默认 `~/.dsh/sessions`）。
   * @param sessionId - 要清除的 Session id。
   * @returns 实际删掉的会话目录数（0 表示磁盘上本来就没有）。
   */
  async function deleteStoredSession(sessionId) {
    const service = ctx.get('sessionPersistence');
    const envHome = process.env.DSH_HOME?.trim();
    const fallback = join(envHome && envHome.length > 0 ? envHome : join(homedir(), '.dsh'), 'sessions');
    const root = typeof service?.root === 'string' && service.root.length > 0 ? service.root : fallback;
    let projects;
    try {
      projects = await readdir(root, { withFileTypes: true });
    } catch {
      return 0; // 根目录不存在（或没有权限）：磁盘上就是没有记录。
    }
    let removed = 0;
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const dir = join(root, project.name, sessionId);
      try {
        if (!(await stat(dir)).isDirectory()) continue;
      } catch {
        continue; // 这个项目目录下没有该会话。
      }
      try {
        await rm(dir, { recursive: true, force: true });
        removed += 1;
        report('info', `removed stored session at ${dir}`);
      } catch (error) {
        report('warn', `could not remove ${dir}: ${error?.message ?? error}`);
      }
    }
    return removed;
  }

  /**
   * 清空一个 QQ 会话的记忆：`/reset` 的实际动作。
   *
   * 两步缺一不可 —— 先销毁活着的 Agent（内存里的对话历史、以及它持有的 Session
   * 写出句柄都随之释放），再删掉磁盘上的会话记录。只做前者，下一条消息会 resume
   * 出旧记录；只做后者，活着的 Agent 会把文件写回来且记忆仍在。
   * @param conversation - 要重置的会话记录。
   * @returns 是否成功清空（false 表示磁盘记录还在，调用方据此回复）。
   */
  async function resetConversation(conversation) {
    const sessionId = sessionIdFor(conversation.key);
    // 1) 销毁 Agent（handle.dispose() 是幂等的）。
    const live = conversation.agent ?? ctx.agents.get(sessionId);
    if (live !== undefined) {
      try {
        if (conversation.handle?.agent === live) await conversation.handle.dispose();
        // HMR/配置热重载后句柄可能丢了，退回 Agent 自己的作用域销毁（ReAct 循环把
        // scope 挂在 Agent 上）。
        else if (typeof live.scope?.dispose === 'function') await live.scope.dispose();
        else throw new Error('no disposer available for the live agent');
      } catch (error) {
        // 销毁失败就必须保留磁盘记录：半清状态下记忆会以更隐蔽的方式回来。
        report('warn', `could not dispose ${sessionId}: ${error?.message ?? error}`);
        return false;
      }
    }
    // 2) 删掉磁盘记录，让下一条消息 resume 失败、走 create 新建空会话。
    const removed = await deleteStoredSession(sessionId);
    // 3) 清掉插件自己的记账，避免旧会话的 turn 结果串到新会话上。
    conversation.agent = undefined;
    conversation.handle = undefined;
    sessionIndex.delete(sessionId);
    for (const [slot, owner] of turnOwners) {
      if (owner?.key === conversation.key || slot.startsWith(`${sessionId}:`)) turnOwners.delete(slot);
    }
    for (const [slot, owner] of submitted) {
      if (owner?.key === conversation.key) submitted.delete(slot);
    }
    for (const slot of [...transcripts.keys()]) {
      if (slot.startsWith(`${sessionId}:`)) transcripts.delete(slot);
    }
    // 群聊上下文也算「刚才那些话」，一起忘掉；否则重置后模型还知道群里之前聊了什么。
    if (conversation.type === 'group') {
      ambient.delete(conversation.id);
      repeatStates.delete(conversation.id);
      // 主动说话的节奏也跟着忘掉：刚 /reset 完不该还被「两小时前主动说过」挡着。
      // 只清计时与计数，不动 `lastActiveAt` / `lastBotSpeakAt` —— 那两个描述的是群里
      // 真实发生过什么（谁最后说的话），不是这个会话的记忆。
      conversation.lastProactiveAt = 0;
      conversation.proactiveDay = '';
      conversation.proactiveCount = 0;
    }
    // 活跃对话（私聊也有）：清空会话就该把「还聊着」这件事也忘掉，并撤掉挂着的补一句。
    cancelChime(conversation);
    conversation.activeUntil = 0;
    conversation.activeSpeakerId = '';
    conversation.activeSeq = 0;
    conversation.activeTurns = 0;
    conversation.chimeCount = 0;
    conversation.chimeDay = '';
    conversation.chimeToday = 0;
    report('info', `reset ${conversation.key} (${sessionId}), removed ${removed} stored log(s)`);
    return true;
  }

  /**
   * 一条会话记录的初始形状（入站会话与出站用的临时壳共用，免得两边字段漂移）。
   *
   * - `queue` 是入站串行链：同一个会话的消息按到达顺序依次处理（媒体落盘、投递），避免并发 turn。
   * - `sending` 是出站串行链：拟人延迟会让一次回复持续若干秒，这期间的后续回复必须排队，
   *   否则群里会看到两条消息交错着冒出来。
   * - `pending` / `batchTimer` 是攒批状态：收下但还在等「有没有下一条」的消息，以及那个定时器。
   * - `handle` 是 Harness 给出的 Agent 句柄，`/reset` 靠它销毁 Agent。
   */
  function blankConversation(key, type, id) {
    return {
      key,
      type,
      id: String(id),
      name: '',
      senderId: '',
      senderName: '',
      agent: undefined,
      handle: undefined,
      queue: Promise.resolve(),
      sending: Promise.resolve(),
      pending: [],
      batchTimer: undefined,
      speakers: [],
      /** 记忆元信息（群名等）是否已经写过一次，避免每条消息都重写一遍 meta.json。 */
      metaWritten: false,
      /**
       * 「群里最后一条**别人的**消息」是什么时候到的（含没 @ 机器人的闲聊）。
       *
       * 主动说话靠它判断「这个群现在是不是没人说话了」：只有安静下来才轮到它开口，
       * 正在聊的时候插嘴是最不像人的地方。机器人自己的消息不算（见 `touchActivity`）。
       */
      lastActiveAt: 0,
      /**
       * 机器人自己最后一次在这个会话里说话的时刻。
       *
       * 用来**避免独白**：如果上一条是我说的、之后一直没人接话，就不该再自己开口
       * （真人也不会对着没人的群一句接一句）。它由 `sendOne` 在所有真正发出去的
       * 消息上更新 —— 自动回复、复读、主动搭话都算。
       */
      lastBotSpeakAt: 0,
      /** 上一次主动说话的时刻（间隔闸）；重启归零。 */
      lastProactiveAt: 0,
      /** 主动说话的当日计数：`{ 日期, 次数 }`，跨天就地重置。 */
      proactiveDay: '',
      proactiveCount: 0,
      /**
       * 「活跃对话」状态：这个会话是不是正跟人聊着（见 README「聊起来之后保持搭话」）。
       *
       * `activeUntil` 是这次聊天的截止时刻（每接一句就往后滑），`activeSpeakerId` 是正在
       * 跟它聊的那个人 —— 群里只有这个人接着说的话才可能免 @ 算进来（别人插话就另说了）。
       * `activeSeq` 是那条消息在群里的进度序号，用来判断「中间有没有别人说过话」；
       * `activeTurns` 是这次活跃对话里已经免 @ 接了几轮（受 activeMaxTurns 约束）。
       */
      activeUntil: 0,
      activeSpeakerId: '',
      activeSeq: 0,
      activeTurns: 0,
      /**
       * 「自己补一句」的定时器与记账（见 scheduleChime）。
       *
       * `chimeSeq` 是「现在这条消息对应的补一句」的编号：新消息一来就 +1，旧定时器醒来
       * 发现编号对不上就什么都不做 —— 比到处记得 clearTimeout 更不容易漏。
       * `chimeCount` 是对方这一句之后已经补了几句（受 activeChimeMax 约束，收到新消息归零）；
       * `chimeDay` / `chimeToday` 是当天的补一句计数（受 activeChimeDailyMax 约束）。
       */
      chimeTimer: undefined,
      chimeSeq: 0,
      chimeCount: 0,
      chimeDay: '',
      chimeToday: 0,
    };
  }

  /** 日志里的会话名：`群 100000001` / `私聊 100000002`。 */
  function describeConversation(conversation) {
    return conversation.type === 'group' ? `群 ${conversation.id}` : `私聊 ${conversation.id}`;
  }

  /** 取出（或新建）一条入站消息所属的会话记录，并刷新发送者信息。 */
  function conversationFor(type, id, sender) {
    const key = `${type}:${id}`;
    let conversation = conversations.get(key);
    if (conversation === undefined) {
      conversation = blankConversation(key, type, id);
      conversations.set(key, conversation);
    }
    if (type === 'group') {
      // 群名只有 get_group_info 才知道，入站事件里没有：只在拿到非空值时覆盖，
      // 否则第二条消息就会把已查到的群名冲成空串。
      const groupName = String(sender?.groupName ?? '');
      if (groupName.length > 0) conversation.name = groupName;
      conversation.senderId = String(sender?.userId ?? '');
      conversation.senderName = String(sender?.userName ?? '');
    } else {
      conversation.name = String(sender?.userName ?? '');
      conversation.senderId = String(sender?.userId ?? '');
      conversation.senderName = conversation.name;
    }
    return conversation;
  }

  /**
   * prefix 触发时，把开头的指令前缀从正文里去掉。
   * 入站时先在占位文本上判定一次（决定这条消息要不要理），媒体落盘后再对真正的
   * 正文调用一次（那才是发给模型的内容）—— 两处用的是同一个函数。
   * @param text - 已 trim 的正文。
   * @returns 去掉前缀后的正文。
   */
  function dropPrefix(text) {
    return config.groupTrigger === 'prefix' ? text.slice(config.prefix.length).trim() : text;
  }

  /**
   * 准入判断：这条入站消息该不该送到它的 Agent。
   *
   * 只做**同步**判定（渠道开关、白名单、@/前缀触发、活跃对话窗口、正文非空），绝不碰
   * 网络：媒体落盘发生在 `handleEvent` 把它收进攒批队列之后。返回的 `message` 是原始
   * 消息段数组，真正的正文由调用方在媒体落盘后用 `messageToText(message, selfId, media)`
   * 再渲染一次；`preview` 是此刻（媒体还没落盘、只有占位符）的正文，只用来同步判定
   * `/reset` 这类指令。
   * @param event - 已解码的 OneBot 事件。
   * @param selfId - 机器人自己的 QQ 号。
   * @returns `{ conversation, message, preview, quote, continued }`；该丢弃时为 undefined。
   *   `continued` 表示这条不是「被叫到」而是「活跃对话里接上的一句」（正文没有前缀可去）。
   */
  function admit(event, selfId) {
    if (event?.post_type !== 'message') return undefined;
    // 机器人自己发的消息会以 message 事件回灌，必须排除；selfId 未就绪时也一律不处理。
    if (String(event.user_id ?? '') === String(selfId) || selfId === '') return undefined;
    const message = event.message ?? event.raw_message;
    const isGroup = event.message_type === 'group';
    const sender = event.sender ?? {};
    if (isGroup) {
      if (!config.groupChat) return undefined;
      const groupId = String(event.group_id);
      if (config.allowGroups.length > 0 && !config.allowGroups.includes(groupId)) return undefined;
      const userId = String(event.user_id ?? '');
      const at = mentions(message, selfId);
      const prefixed = config.groupTrigger === 'prefix' && messageToText(message).trimStart().startsWith(config.prefix);
      // 显式触发：@ 了机器人、按配置用了前缀、或者 groupTrigger 本来就允许所有消息。
      const explicit = config.groupTrigger === 'all' || at || prefixed;
      // 这里只用**占位符**版本判定「这条消息有没有内容」：媒体下载是异步的，此刻还没
      // 落盘，而 `[图片]` 这样的占位符已经足够说明「他发了点东西」。真正的正文在
      // handleEvent 里等媒体落盘后再渲染一次。
      // 传入 selfId 是为了按 account 精确剔除 @机器人 段，而不是事后从扁平文本里砍掉
      // 开头的 `@…` —— 这样 `@bot你好` 才能完整保留成 `你好`（昵称含空格也不会被误删）。
      const rawText = messageToText(message, selfId).trim();
      // 前缀只在**显式带前缀**的那条上剥掉：活跃对话里接上的那句本来就没有前缀，
      // 按前缀长度硬切会把「然后呢」切成「后呢」（见 dropPrefix）。
      const preview = prefixed ? dropPrefix(rawText) : rawText;
      if (preview.length === 0) return undefined;
      // 活跃对话：没被叫到，但同一个人正在跟它聊，接着说的这句也算。（只认**已经存在**
      // 的会话 —— 闲聊不该因为「窗口」把某个群变成「处理过」的群。）
      const existing = conversations.get(`group:${groupId}`);
      const continued = !explicit && existing !== undefined && activeFollowAllows(existing, userId, message, selfId);
      if (!explicit && !continued) return undefined;
      const conversation = conversationFor('group', groupId, {
        groupName: '',
        userId: event.user_id,
        userName: sender.card ?? sender.nickname ?? String(event.user_id),
      });
      noteActiveMessage(conversation, userId, continued);
      return {
        conversation,
        message,
        preview,
        continued,
        // 回复指向：引用被回复的那条消息（`reply` 段要 message_id），或 @ 回提问者（要 QQ 号）。
        // `seq` 是这条消息在群里的进度，供 `auto` 判断「等我回话时有没有人插话」。三样都
        // 在这里一次性快照：发送在几秒后，那时会话记录和群里的进度都可能已经变了。
        quote: { messageId: String(event.message_id ?? ''), userId: String(event.user_id ?? ''), seq: chatterSeq.get(groupId) ?? 0 },
      };
    }
    if (!config.privateChat) return undefined;
    const userId = String(event.user_id);
    if (config.allowUsers.length > 0 && !config.allowUsers.includes(userId)) return undefined;
    const text = messageToText(message, selfId).trim();
    if (text.length === 0) return undefined;
    const conversation = conversationFor('private', userId, {
      userId,
      userName: sender.nickname ?? sender.card ?? userId,
    });
    // 私聊的每条消息本来就都是「跟它说的」，所以活跃对话在私聊里不需要额外判定 ——
    // 只要把这个窗口往后滑，它回完之后才可能自己补一句（见 scheduleChime）。
    noteActiveMessage(conversation, userId, false);
    return {
      conversation,
      message,
      preview: dropPrefix(text),
      continued: false,
      // 私聊始终是 plain，`seq` 只是让 quote 的字段形状保持一致。
      quote: { messageId: String(event.message_id ?? ''), userId: String(event.user_id ?? ''), seq: 0 },
    };
  }

  /**
   * 记一次「群里又有人说话了」，返回该群当前的进度序号。
   *
   * 每条**别人的**群消息都算（被 @ 的和没被 @ 的都算）：`auto` 回复指向靠入站与
   * 发送两个时刻的序号差判断该不该引用。机器人自己发的消息会作为 message 事件回灌，
   * 那是我自己的话、不是「有人插话」，所以按 selfId 剔除。
   * @param event - 已解码的 OneBot 事件。
   * @param selfId - 机器人自己的 QQ 号。
   * @returns 该群在计入这条消息之后的序号。
   */
  function noteChatter(event, selfId) {
    if (event?.message_type !== 'group') return 0;
    if (String(event.user_id ?? '') === String(selfId)) return 0;
    const groupId = String(event.group_id);
    const next = (chatterSeq.get(groupId) ?? 0) + 1;
    chatterSeq.set(groupId, next);
    // 兜底：见过面的群不该这么多；真超了就丢掉最早的那个群，它接下来的回复退化成 plain。
    if (chatterSeq.size > 512) {
      const oldest = chatterSeq.keys().next().value;
      if (oldest !== undefined && oldest !== groupId) chatterSeq.delete(oldest);
    }
    return next;
  }

  /**
   * 记一次「这个会话刚才有人在说话」，供主动说话判断群是不是安静了。
   *
   * 与 `noteChatter` 的区别：那个记的是「群里的进度序号」（回复指向用），只对群有效；
   * 这个记的是「时间」，而且**含没 @ 机器人的闲聊** —— 群里正聊得热火朝天时，
   * 主动搭话恰恰最不该发生，所以那些没人理机器人的消息也必须算作活跃。
   *
   * 只更新**已经存在**的会话记录：没聊过的群不该因为一条闲聊就变成候选（这也是
   * 「主动说话只对已经聊过的群生效」的落点）。机器人自己的消息会回灌，按 selfId 排除。
   * @param event - 已解码的 OneBot 事件。
   * @param selfId - 机器人自己的 QQ 号。
   */
  function touchActivity(event, selfId) {
    if (event?.post_type !== 'message') return;
    if (selfId === '' || String(event.user_id ?? '') === String(selfId)) return;
    const type = event.message_type === 'group' ? 'group' : 'private';
    const id = type === 'group' ? String(event.group_id ?? '') : String(event.user_id ?? '');
    const conversation = conversations.get(`${type}:${id}`);
    if (conversation === undefined) return;
    conversation.lastActiveAt = Date.now();
  }

  /**
   * 把一条「不是发给机器人」的群消息记进环境缓冲。
   *
   * 只有被 admit 丢掉的消息才会走到这里：被 @ 的那条会作为 user message 进入会话，
   * 再在环境里重复一遍反而会让模型以为对方说了两次。于是模型看到的是
   * 「群里刚才在聊这些」+「现在有人 @ 我说了这句」，和真人的感知顺序一致。
   * @param event - 已解码的 OneBot 事件。
   * @param selfId - 机器人自己的 QQ 号（机器人自己的消息不进缓冲）。
   */
  function rememberAmbient(event, selfId) {
    const limit = Math.floor(Number(config.ambientMessages) || 0);
    if (limit <= 0) return;
    if (!config.groupChat || event?.message_type !== 'group') return;
    if (String(event.user_id ?? '') === String(selfId)) return;
    const groupId = String(event.group_id);
    if (config.allowGroups.length > 0 && !config.allowGroups.includes(groupId)) return;
    // 折掉换行：多行消息会破坏「昵称: 内容」一行一条的版式。
    // 媒体默认**也**落盘（`ambientMedia`），这样「有人刚才发了张表情包」之后被 @ 时它真的
    // 看得见；关掉这个开关就退回成「只留一句占位符」，不为闲聊花带宽和磁盘。
    const raw = event.message ?? event.raw_message;
    const text = messageToText(raw).replace(/\s+/g, ' ').trim();
    if (text.length === 0) return;
    const sender = event.sender ?? {};
    const name = String(sender.card ?? sender.nickname ?? event.user_id ?? '某人');
    const lineChars = Math.max(1, Math.floor(Number(config.ambientLineChars) || 120));
    const list = ambient.get(groupId) ?? [];
    const entry = { name, text: text.slice(0, lineChars) };
    list.push(entry);
    while (list.length > limit) list.shift();
    ambient.set(groupId, list);
    // 先按占位符入缓冲（提示词立刻可用），下载完成后再就地改写成带路径的版本。
    if (config.ambientMedia) void hydrateAmbientMedia(raw, entry, lineChars);
  }

  /**
   * 自动复读：群里**连着**出现同一条消息时，跟着复读一句（或把那张表情包发回去）。
   *
   * 这是插件自己的行为，不经过模型、也不建会话 —— 群里刷「6」的时候，等模型想一句
   * 俏皮话再回来，那个梗早就过去了；复读机的笑点就在于同一句话、同一张图被原样接上。
   *
   * 记账范围是所有**别人的**群消息（被 @ 的那条也算，它同样会打断「连着」），
   * 但真跟不跟还要看这几条：
   *   - 只有**没 @ 机器人**的那条才跟：被 @ 的会走 Agent 去回答，再复读一遍等于
   *     同一句话回两遍（`groupTrigger: all` 时每条都算被 @，于是复读不会触发）；
   *   - 只有两种消息跟得动：**纯文字**（trim + 折叠空白后一样，`6` 和 `6 ` 算同一句）
   *     与**整条就是一张表情包**（图片来源判定分两层：字节完全相同，或画面指纹足够近 ——
   *     QQ 会把同一张表情包按发送者重新编码，只看字节永远认不出「同一张」，见 `sketchOf`）；
   *   - 中间有任何人说了别的话就重新数（认不出的消息也一样打断：群里插了别的话，
   *     前后两条就不再是「连着」的）；
   *   - 间隔超过 `repeatWindowMs` 也不续链；默认还要至少两个不同的人说过
   *     （一个人自己连发两遍是手滑，不是复读）；文字太长（`repeatMaxChars`）不跟。
   * 跟过一次之后链就断掉：否则群里一直刷同一个字时，它会一句不落地跟着刷。
   *
   * 判定要下载表情包才知道是不是同一张（异步），所以整个判定挂在每个群自己的串行链
   * `state.queue` 上按到达顺序跑 —— 见 `repeatStates`。
   *
   * @param event - 已解码的 OneBot 事件。
   * @param selfId - 机器人自己的 QQ 号（机器人自己的消息不入链，也不打断链）。
   * @param canAct - 这条消息能不能触发复读（被 @ 的那条只能记账，不能跟）。
   */
  function maybeRepeat(event, selfId, canAct) {
    if (!config.repeat) return;
    if (!config.groupChat || event?.message_type !== 'group') return;
    const groupId = String(event.group_id);
    if (config.allowGroups.length > 0 && !config.allowGroups.includes(groupId)) return;
    const userId = String(event.user_id ?? '');
    if (userId === String(selfId)) return;
    const message = event.message ?? event.raw_message;
    const state = repeatStateFor(groupId);
    // 判定要下载表情包（异步），`arrivedAt` 记的是**消息到达**的时刻：链上的时间戳
    // 该按「群里什么时候说的」算，而不是「我们什么时候判完的」。
    const arrivedAt = Date.now();
    // 判定失败不该打穿这条链：出错只记一条 warn，后面的消息照常排队。
    const step = async () => {
      try {
        await repeatStep(state, groupId, message, userId, canAct, arrivedAt);
      } catch (error) {
        report('warn', `repeat check failed: ${errorText(error)}`);
      }
    };
    state.queue = state.queue.then(step, step);
  }

  /** 取（或建）某个群的复读状态 `{ chain, queue }`。 */
  function repeatStateFor(groupId) {
    let state = repeatStates.get(groupId);
    if (state === undefined) {
      state = { chain: undefined, queue: Promise.resolve() };
      repeatStates.set(groupId, state);
      // 兜底：见过面的群不该这么多；真超了就丢掉最早的那个群，它接下来的复读退化成「从头攒」。
      if (repeatStates.size > 512) {
        const oldest = repeatStates.keys().next().value;
        if (oldest !== undefined && oldest !== groupId) repeatStates.delete(oldest);
      }
    }
    return state;
  }

  /**
   * 复读判定的正题：把这条消息接到链上，够条件就跟着发一条。
   *
   * @param state - 该群的复读状态（`chain` 就地更新）。
   * @param groupId - 群号（发送目标）。
   * @param message - OneBot 的 `message` 字段。
   * @param userId - 发送者 QQ 号。
   * @param canAct - 这条消息能不能触发复读（被 @ 的那条只能记账）。
   * @param arrivedAt - 这条消息到达的时刻（链上的时间戳一律用它，见 `maybeRepeat`）。
   */
  async function repeatStep(state, groupId, message, userId, canAct, arrivedAt) {
    const candidate = await repeatCandidate(message);
    const previous = state.chain;
    // 认不出的消息（@、卡片、太长、抓不到的图）同样是「群里又说了别的话」，把链打断。
    if (candidate === undefined) {
      state.chain = undefined;
      return;
    }
    const windowMs = Math.max(0, Math.floor(Number(config.repeatWindowMs) || 0));
    const chained =
      previous !== undefined &&
      (windowMs <= 0 || arrivedAt - previous.at <= windowMs) &&
      (await sameCandidate(previous, candidate));
    const senders = chained ? [...new Set([...previous.senders, userId])] : [userId];
    const count = chained ? previous.count + 1 : 1;
    const threshold = Math.max(2, Math.floor(Number(config.repeatCount) || 0));
    const distinct = config.repeatDistinct ? senders.length >= 2 : true;
    const entry = { ...candidate, count, senders, at: arrivedAt };
    if (!canAct || count < threshold || !distinct) {
      state.chain = entry;
      return;
    }
    const chance = Math.min(1, Math.max(0, Number(config.repeatChance)));
    if (!(Math.random() < chance)) {
      // 这次没跟：链留着，下一条相同的消息再掷一次，而不是重新攒人数。
      state.chain = entry;
      return;
    }
    // 跟过就断链，免得群里刷屏时它一句不落地跟着刷。
    state.chain = undefined;
    const conversation = targetConversation('group', groupId);
    report('info', `→ ${describeConversation(conversation)}: ${describeRepeat(candidate)}（复读）`);
    sendRepeat(conversation, candidate);
  }

  /**
   * 复读候选：这条消息「值不值得跟」，以及要跟的话拿什么去跟。
   *
   * 两种消息跟得动：
   *   1. **纯文字**：整条都是 `text` 段（见 `repeatableText`），正文不能超过
   *      `repeatMaxChars`（复读机跟的是「6」「草」这种短句，不是一整段话）；比较用的
   *      `key` 归一化空白，真正发出去的是原样正文（`raw`）—— 复读机不该改人家的字。
   *   2. **整条就是一张表情包**：只有一个 `image` / `mface` 段，或只有一个系统表情
   *      （`face`）段。图片得先落盘，`key` 就是内容哈希路径 —— 同一张图重新上传会拿到
   *      不同的 `file` / URL；画面指纹（{@link sketchOf}）只在真要比两条字节不同的图时
   *      才懒算。系统表情不用下载，`id` 就是它的身份。
   *
   * 图 + 文字、两张图、@ 别人的消息都不算候选：复读要的是「原样接上一句/一张」，把图
   * 和话拆开复读、或者把 @ 段再发一遍都不是那回事。它们照样会打断链（调用方的处理）。
   *
   * @param message - OneBot 的 `message` 字段。
   * @returns `{ kind, key, raw }` / `{ kind, key, path }` / `{ kind, key, id }`；不复读时 undefined。
   */
  async function repeatCandidate(message) {
    const text = repeatableText(message);
    if (text !== undefined) {
      const raw = text.trim();
      if (raw.length === 0) return undefined;
      const maxChars = Math.floor(Number(config.repeatMaxChars));
      if (Number.isFinite(maxChars) && maxChars > 0 && raw.length > maxChars) return undefined;
      return { kind: 'text', key: `text:${raw.replace(/\s+/g, ' ')}`, raw };
    }
    // 表情包复读**不自己下载**：判「是不是同一张」只能靠内容哈希，而那份字节正是环境上下文
    // 落盘时留下的（`mediaFor` 按消息对象共用同一次下载，所以默认配置下它一次带宽都不多花）。
    // 于是关掉 `ambientMedia`、或者把 `ambientMessages` 设成 0（群聊上下文整个关掉）时，
    // 群里的图根本不会被取下来 —— 表情包复读自动退化成「只复读文字」，不会偷偷花带宽。
    const ambientDownloads = config.ambientMedia && Math.floor(Number(config.ambientMessages) || 0) > 0;
    if (!config.repeatMedia || !imageSend || !ambientDownloads) return undefined;
    if (!Array.isArray(message) || message.length !== 1) return undefined;
    const only = message[0];
    if (only?.type === 'face') {
      const id = String(only.data?.id ?? '');
      // 只认纯数字 id：这条路径的输入完全不可信，别把乱七八糟的字段原样发回去。
      if (!/^\d{1,12}$/.test(id)) return undefined;
      return { kind: 'face', key: `face:${id}`, id };
    }
    if (only?.type !== 'image' && only?.type !== 'mface') return undefined;
    const resolved = await mediaFor(message);
    const outcome = resolved?.outcomes?.get(0);
    // 拿不到字节（URL 过期、实现没有可下载地址、下载功能关着）就不复读：
    // 「是不是同一张」只能由内容哈希说了算，猜不得。
    if (outcome?.path === undefined) return undefined;
    // 出站上限比这张图还小的话，跟了也发不出去，不如别跟（链照样被它打断）。
    if (outcome.bytes > imageMaxBytes) return undefined;
    return { kind: 'image', key: `image:${outcome.path}`, path: outcome.path };
  }

  /**
   * 一张已落盘表情包的**画面指纹**（见 perceptual.js），按路径缓存。
   *
   * 为什么要多这一步：QQ 会把同一张表情包按发送者重新编码 —— 实测同一张「寿来」在群里
   * 出现过 94657B(progressive) / 131307B(baseline) / 79284B 三种字节，画面 SSIM ≥ 0.985
   * 却没有两份字节相同。只比内容哈希的话，群里连着发同一张表情包时复读**永远**不触发
   * （2026-10-13 那天就是：12:30:47 与 12:31:12 两个人发了同一张「寿来」，机器人一声不吭）。
   *
   * 为什么是**懒算 + 缓存**：绝大多数表情包消息都不参与复读（链是空的、旁边没人接），
   * 每条都解码一遍纯属浪费；只有在真的要拿两条**字节不同**的图比画面时才读盘解一次。
   * 缓存按路径（内容哈希命名，同一张图就是同一个路径），只存指纹字符串，上限 64 条。
   *
   * 失败一律返回 undefined —— 那张图仍然能靠「字节完全相同」复读，只是不参与画面比对
   * （文件已被 LRU 淘汰、格式不支持、画面太小太素都是这种）。`repeatImageTolerance: 0`
   * 时连读盘都不做。
   *
   * @param path - `.qq-media/…` 这样的相对路径（内容哈希命名）。
   * @returns 十六进制指纹串或 undefined。
   */
  async function sketchOf(path) {
    if (repeatImageTolerance <= 0 || path === undefined) return undefined;
    if (sketches.has(path)) return sketches.get(path);
    let sketch;
    try {
      sketch = perceptualHash(await readFile(resolve(cwd, path)));
    } catch (error) {
      report('warn', `could not fingerprint the sticker ${path}: ${errorText(error)}`);
      sketch = undefined;
    }
    sketches.set(path, sketch);
    if (sketches.size > 64) sketches.delete(sketches.keys().next().value);
    return sketch;
  }

  /**
   * 复读链上的「这跟刚才那条算不算同一个」。
   *
   * 文字与系统表情只能靠 `key` 完全相等（它们本来就是确定的字符串/编号）；图片多一层：
   * 字节不同但画面指纹足够近也算同一张（QQ 重新编码过的同一张表情包），阈值就是
   * `repeatImageTolerance`，两侧任一没有指纹时退回字节判定。
   *
   * @param left - 链上留下的候选。
   * @param right - 这一条的候选。
   * @returns 视为同一个时 true（可能要读盘解一次指纹，所以是异步的）。
   */
  async function sameCandidate(left, right) {
    if (left.kind !== right.kind) return false;
    if (left.key === right.key) return true;
    if (left.kind !== 'image') return false;
    const [leftSketch, rightSketch] = [await sketchOf(left.path), await sketchOf(right.path)];
    if (leftSketch === undefined || rightSketch === undefined) return false;
    return hashDistance(leftSketch, rightSketch) <= repeatImageTolerance;
  }

  /** 复读的日志措辞：文字给正文，表情包给一张「占位符」。 */
  function describeRepeat(candidate) {
    if (candidate.kind === 'text') return candidate.raw.slice(0, 120);
    if (candidate.kind === 'image') return `[表情包 ${candidate.path}]`;
    return `[表情 ${candidate.id}]`;
  }

  /**
   * 把复读发出去（按候选类型选载体），全都挂在会话的发送队列上。
   *
   * 图片走 `loadOutgoingImage` + `imageSegment`：和 Agent 主动发表情包同一条出站链路
   * （读本地文件、校验格式与大小、base64 交给 NapCat）。发不出去只记一条 warn ——
   * 复读本来就是插话，静默不跟比在群里喊一句「我发不出去」更像真人。
   *
   * @param conversation - 目标会话。
   * @param candidate - {@link repeatCandidate} 的结果。
   */
  function sendRepeat(conversation, candidate) {
    if (candidate.kind === 'text') {
      void sendLiteral(conversation, candidate.raw);
      return;
    }
    if (candidate.kind === 'face') {
      void enqueueSend(conversation, () => sendOne(conversation, [{ type: 'face', data: { id: candidate.id } }]));
      return;
    }
    void enqueueSend(conversation, async () => {
      let bytes;
      try {
        bytes = (await loadOutgoingImage({ source: candidate.path, cwd, maxBytes: imageMaxBytes })).bytes;
      } catch (error) {
        report('warn', `could not repeat the sticker ${candidate.path}: ${errorText(error)}`);
        return;
      }
      await sendOne(conversation, [imageSegment(bytes)]);
    });
  }

  // ---- 主动说话：不等 @，自己偶尔在群里开个话头 ---------------------------------
  //
  // 复读是「跟着别人说」，这一块是反过来：群里安静下来之后，机器人**自己**想一句
  // 冒个泡。它走完整的 Agent 链路（同一张会话、同一套提示词、同一份长期记忆），
  // 只是那条 user message 是插件伪造的「提醒」而不是真人说的话。
  //
  // 为什么值得这么绕：不经过模型的主动消息只能靠模板（「在吗」「大家好啊」），
  // 一开口就露馅；让它带着群里的上下文（环境缓冲 + 长期记忆）自己想一句，
  // 才可能真的像群友。代价是每次搭话都有一次模型调用，所以下面那一堆闸门是必须的。

  /**
   * 主动说话总开关。
   *
   * 默认**关**：它会主动给真人发消息，这种事不该由「升级插件」替使用者决定。
   * 开着时也只在**群**里说话 —— 私聊对象是具体的人，被机器人无端戳一下更冒犯，
   * 而且私聊会话一多，主动搭话很容易变成骚扰。
   */
  const proactiveEnabled = config.proactive === true;

  /** 一个毫秒配置项：非法值退回 `fallback`，负数按 0 算。 */
  function proactiveMs(name, fallback) {
    const raw = Math.floor(Number(config[name]));
    return Number.isFinite(raw) ? Math.max(0, raw) : fallback;
  }

  /** 每群每天最多主动说几次；非法或负数按 0（= 不说）算。 */
  function proactiveDailyMax() {
    const raw = Math.floor(Number(config.proactiveDailyMax));
    return Number.isFinite(raw) ? Math.max(0, raw) : 4;
  }

  /** 主动说话的检查间隔（毫秒）：下限 1 秒，上限受 Node 定时器能表达的范围约束。 */
  function proactiveCheckMs() {
    return Math.min(MAX_TIMER_MS, Math.max(1000, proactiveMs('proactiveCheckMs', 10 * 60 * 1000)));
  }

  /**
   * 这个会话的「今天」计数（跨天就地归零），返回今天已经主动说过几次。
   *
   * 计数刻意放在**内存**里：重启后归零是可以接受的（重启本身很稀有，而且重启后
   * 至少要等 `proactiveIdleMs` 才可能开口），换成落盘状态得多维护一个文件，
   * 与 `ambient` / `chatterSeq` / 复读链这些运行时状态的口径也一致。
   * @param conversation - 目标会话。
   * @returns 今天已主动说话的次数。
   */
  function proactiveTodayCount(conversation) {
    const today = localDate();
    if (conversation.proactiveDay !== today) {
      conversation.proactiveDay = today;
      conversation.proactiveCount = 0;
    }
    return conversation.proactiveCount ?? 0;
  }

  /**
   * 这个会话此刻是不是正欠着 QQ 一轮回复（包括主动搭话自己那一轮）。
   *
   * 主动搭话要挑**没人说话、也没在等回复**的时刻：上一轮还没结束就再塞一条，
   * 群里会看到它自问自答；而且 `submitted` / `turnOwners` 是靠 turn 号记账的，
   * 两个 turn 交错时回复归属也可能串。
   * @param conversation - 目标会话。
   * @returns 有在飞的 turn 时为 true。
   */
  function busyWithTurn(conversation) {
    const prefix = `${sessionIdFor(conversation.key)}:`;
    for (const slot of turnOwners.keys()) {
      if (slot.startsWith(prefix)) return true;
    }
    for (const owner of submitted.values()) {
      if (owner.key === conversation.key) return true;
    }
    return false;
  }

  /**
   * 这个群现在值不值得主动搭一句话。五道闸门，缺一不可：
   *
   *   1. **只群聊**（`conversation.type === 'group'`）—— 私聊不打扰；
   *   2. **没有正在进行的对话**：攒批里有待投的消息、或者有 turn 在飞，都不插嘴；
   *   3. **安静够久**（`proactiveIdleMs`）：群里刚才还在聊，就不该轮到它开口；
   *   4. **不是独白**：上一次说话之后一直没人接话，就不再自说自话
   *      （`lastBotSpeakAt >= lastActiveAt` 就是这种情况）；
   *   5. **不算诈尸**：`proactiveFreshMs` 之内还有人说过话的群才搭；隔了好几天的
   *      冷群突然冒一句最吓人。
   *
   * 外加两个节奏闸：同一个群两次主动说话至少隔 `proactiveGapMs`，一天不超过
   * `proactiveDailyMax` 次。**时段**（`proactiveFromHour` / `proactiveToHour`）与概率
   * 不在这里 —— 那是整轮检查的性质，在 `proactiveSweep` 里判一次。
   *
   * @param conversation - 候选会话。
   * @param now - 当前时刻（毫秒）。
   * @returns 可以开口时为 true。
   */
  function proactiveEligible(conversation, now) {
    if (conversation.type !== 'group') return false;
    if (conversation.pending.length > 0 || conversation.batchTimer !== undefined) return false;
    if (busyWithTurn(conversation)) return false;
    const lastActive = Number(conversation.lastActiveAt) || 0;
    // 从来没人在这个群说过话（例如会话是被出站工具建出来的壳）就没有可搭的话头。
    if (lastActive <= 0 || now < lastActive) return false;
    // 独白：上一条是我说的，之后没人接话。
    if ((Number(conversation.lastBotSpeakAt) || 0) >= lastActive) return false;
    if (now - lastActive < proactiveMs('proactiveIdleMs', 45 * 60 * 1000)) return false;
    const freshMs = proactiveMs('proactiveFreshMs', 24 * 60 * 60 * 1000);
    if (freshMs > 0 && now - lastActive > freshMs) return false;
    const gapMs = proactiveMs('proactiveGapMs', 2 * 60 * 60 * 1000);
    if ((Number(conversation.lastProactiveAt) || 0) > 0 && now - conversation.lastProactiveAt < gapMs) return false;
    return proactiveTodayCount(conversation) < proactiveDailyMax();
  }

  /**
   * 主动搭话时那条「伪造的 user message」。
   *
   * 它必须同时说清三件事，否则模型很容易答非所问：
   *   - **这条不是谁发来的消息**（否则它会当成一个人在跟它说话，回一句「怎么了」）；
   *   - **可以什么都不说**（给一个 `SKIP` 出口。不给出路时，模型面对「没话找话」的
   *     场景会硬编一句，那正是最像机器人的地方）；
   *   - **别暴露机制**（不能说「我注意到好久没人说话了」，也不能提这条提醒本身）。
   *
   * 只提真的能用的表达方式：`imageSend` 关着时不说 `[[图片: …]]`，否则模型会把标记
   * 当正文写出去（与 `channelPrompt` 的处理一致）。
   * @param quietMs - 这个群已经安静了多久（毫秒）。
   * @returns user message 正文。
   */
  function proactiveNudge(quietMs) {
    const minutes = Math.max(1, Math.round(quietMs / 60000));
    return [
      `（这条不是谁发给你的消息，是插件在提醒你：这个群已经安静了大约 ${minutes} 分钟，你可以自己冒个泡。）`,
      '',
      '要不要说话、说什么都由你定：',
      imageAllowed()
        ? '- 想接一句之前的话题、吐槽一句、问一句，或者甩一张合适的表情包（正文只写 `[[图片: 路径]]`），都行；'
        : '- 想接一句之前的话题、吐槽一句、问一句，都行；',
      '- 觉得没什么可说的、或者刚说过话不想重复，就整条回复只写 `SKIP` —— 那样一个字都不会发出去，这是很正常的选择。',
      '',
      '注意：',
      '- 别提前面这条提醒，也别说「好久没人说话了」这种旁白；就当自己突然想冒个泡。',
      '- 别重复你刚说过的话，也别每次都问「在吗」。',
      '- 一条就够，别刷屏。',
    ].join('\n');
  }

  /**
   * 主动搭话的「我不说话」信号：第一行以 `SKIP` 开头（容忍各种括号与前后空白）。
   *
   * 宽松一点是有意的：模型经常顺手把自己的决定解释一下（`SKIP（没什么可说的）`），
   * 那半句同样不该发到群里 —— 它是在解释内部决定，不是群友会说的话。只看第一行，
   * 后面的解释直接丢掉。`skip` 后面要求一个词边界，免得把 `skipping` 这类正文吞掉。
   * @param text - 这一轮的回复正文。
   * @returns 整条都不该发出去时为 true。
   */
  function proactiveSkip(text) {
    const first = String(text ?? '')
      .split('\n')
      .find((line) => line.trim().length > 0) ?? '';
    return /^[(（[\s]*skip\b/i.test(first.trim());
  }

  /**
   * 让机器人主动开口：伪造一条 user message 投进**它自己那个会话**，回复照常发回群里。
   *
   * 走同一条会话而不是另开一个（与摘要 Agent 相反）：主动搭话必须看得见这段聊天
   * 本身的历史与环境上下文，否则它说的那句和刚刚聊的内容接不上。
   *
   * 记账刻意是**先记后说**：模型可能判成 `SKIP`、这一轮也可能失败，但「这次掷中了」
   * 本身就该消耗掉当天的一次机会与 `proactiveGapMs` —— 否则每次检查都会重新掷骰子，
   * 开口频率会失控（`SKIP` 反而变成「再来一次」）。
   *
   * @param conversation - 目标群会话。
   * @param now - 判定通过的时刻（毫秒）。
   */
  function proactiveSpeak(conversation, now) {
    conversation.proactiveCount = proactiveTodayCount(conversation) + 1;
    conversation.lastProactiveAt = now;
    const quietMs = Math.max(0, now - (Number(conversation.lastActiveAt) || now));
    report('info', `${describeConversation(conversation)} 已经安静 ${Math.round(quietMs / 60000)} 分钟，主动开个话头`);
    enqueue(conversation, async () => {
      try {
        const text = proactiveNudge(quietMs);
        const agent = await ensureAgent(conversation);
        const userMessage = createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        });
        // `proactive: true` 是本轮唯一的身份标记：turn 结束时靠它区分「主动搭话」
        // 与「回别人的话」—— 前者判成 SKIP 要静默丢弃，出错也不该在群里道歉。
        submitted.set(userMessage.id, {
          key: conversation.key,
          quote: { messageId: '', userId: '', seq: 0 },
          proactive: true,
        });
        agent.followup(userMessage);
      } catch (error) {
        // 主动搭话起不来就安静算了：`enqueue` 的兜底会在群里发一句「我这边出错了」，
        // 而这次根本没人问它，平白多一条噪音。
        report('warn', `proactive turn for ${conversation.key} could not start: ${errorText(error)}`);
      }
    });
  }

  /**
   * 主动说话的定时轮：醒来只是「看一眼」，说不说还要过条件与概率。
   *
   * 每次最多只有一个群开口（先洗牌、再逐个掷概率、掷中就结束）—— 一次醒来在好几个
   * 群里同时冒泡，比不说话更像机器人。
   */
  function proactiveSweep() {
    if (!proactiveEnabled) return;
    // 还没连上 OneBot（selfId 未知）时发不出去，也认不出自己的消息。
    if (client.selfId === '') return;
    const from = Number(config.proactiveFromHour);
    const to = Number(config.proactiveToHour);
    if (!withinActiveHours(from, to, new Date().getHours())) return;
    const chance = Math.min(1, Math.max(0, Number(config.proactiveChance)));
    if (!(chance > 0)) return;
    const now = Date.now();
    const candidates = [];
    for (const conversation of conversations.values()) {
      if (proactiveEligible(conversation, now)) candidates.push(conversation);
    }
    if (candidates.length === 0) return;
    // 洗牌只是为了「多个群都满足条件时挑哪个」也随机 —— 否则永远是 Map 里最早的那个。
    for (let index = candidates.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [candidates[index], candidates[swap]] = [candidates[swap], candidates[index]];
    }
    for (const conversation of candidates) {
      if (!(Math.random() < chance)) continue;
      proactiveSpeak(conversation, now);
      return;
    }
  }

  // ---- 活跃对话：聊起来之后保持搭话 ---------------------------------------------
  //
  // 上面那块 `proactive` 管的是**冷场**（群里安静 45 分钟之后自己开个话头）；这一块管
  // 「正聊着」的时候。真人不会让对方每句都叫一遍自己的名字，也不会在对方安静十秒之后
  // 就把话题掐掉。两件事共用一个「活跃对话」窗口（`activeUntil`）：
  //
  //   A. 免 @ 接话（`activeFollow`）：窗口内、正在跟它聊的那个人接着说的话也算在跟它聊；
  //   B. 自己补一句（`activeChime*`）：它回完之后对方安静了一小会儿，它可能再追一句。
  //
  // 窗口只靠**别人发来的消息**往后滑（机器人自己说的话不算，否则它自己就能给窗口续命）；
  // 群里中间有别人插话，这次「你跟我聊」就算断了，要重新叫它一次。

  /** 活跃对话窗口（毫秒）：0 表示整套关闭（免 @ 接话与自己补一句都不做）。 */
  function activeWindowMs() {
    return proactiveMs('activeWindowMs', 10 * 60 * 1000);
  }

  /** 一次活跃对话里最多免 @ 接几轮；0 = 不限。 */
  function activeMaxTurns() {
    return proactiveMs('activeMaxTurns', 10);
  }

  /** 「自己补一句」的静默门槛（毫秒）；0 = 不补。 */
  function activeChimeIdleMs() {
    return proactiveMs('activeChimeIdleMs', 20 * 1000);
  }

  /** 对方每说一句之后最多自己补几句；0 = 不补。 */
  function activeChimeMax() {
    return proactiveMs('activeChimeMax', 1);
  }

  /** 同一个会话一天最多自己补几句；0 = 不限。 */
  function activeChimeDailyMax() {
    return proactiveMs('activeChimeDailyMax', 12);
  }

  /**
   * 记一次「这个会话正聊着」，把活跃窗口往后滑。
   *
   * 由 `admit` 在两条路上调用：**被叫到**（`continued === false`，会重置免 @ 接话的轮数）
   * 与**窗口内接上话**（`continued === true`，轮数 +1）。私聊的每条消息都算「被叫到」，
   * 所以私聊不需要 `activeFollow` 也能有「补一句」——窗口照样在滑。
   *
   * `activeSeq` 记的是这条消息在群里的进度序号：用来判断「这条之后有没有别人说过话」，
   * 见 `activeFollowAllows` 与 `runChime`。
   *
   * @param conversation - 这条消息所属的会话。
   * @param userId - 发消息的人（群里只有他接着说的话才可能免 @ 算进来）。
   * @param continued - 这条是不是「窗口内接上的」（而不是被叫到）。
   */
  function noteActiveMessage(conversation, userId, continued) {
    conversation.activeUntil = Date.now() + activeWindowMs();
    conversation.activeSpeakerId = userId;
    conversation.activeTurns = continued ? (conversation.activeTurns ?? 0) + 1 : 0;
    if (conversation.type === 'group') conversation.activeSeq = chatterSeq.get(conversation.id) ?? 0;
    // 对方又说话了：这一句对应的「补一句」额度重新算，旧的那个定时器也就作废了。
    conversation.chimeCount = 0;
    cancelChime(conversation);
  }

  /**
   * 这条**没被叫到**的群消息能不能算「接着聊」（`activeFollow`）。
   *
   * 四条同时成立才算，缺一条都不理它 —— 这一步放松的是「群里只在被 @ 时才说话」这条
   * 默认约定，宁可少接一句也别抢话：
   *   1. 说话的就是**正在跟它聊的那个人**（别人插一句不该被它抢答）；
   *   2. 还在窗口内（`activeWindowMs`，每接一句往后滑）；
   *   3. 这次对话里免 @ 接的轮数还没到 `activeMaxTurns`；
   *   4. 中间**没有别人说过话**（群里插了话，这次一对一就断了，得重新 @ 它）；
   *   5. 这句没有 @ 别人（`@别人` / `@全体` 明确不是跟它说的）。
   *
   * @param conversation - 已有的会话记录。
   * @param userId - 发消息的人。
   * @param message - OneBot 的 `message` 字段。
   * @param selfId - 机器人自己的 QQ 号。
   * @returns 可以当「接话」时为 true。
   */
  function activeFollowAllows(conversation, userId, message, selfId) {
    if (config.activeFollow !== true) return false;
    if (activeWindowMs() <= 0) return false;
    // 私聊不需要「免 @」：那边的每条消息本来就都是跟它说的。
    if (conversation.type !== 'group') return false;
    if (String(conversation.activeSpeakerId ?? '') !== String(userId)) return false;
    if ((Number(conversation.activeUntil) || 0) <= Date.now()) return false;
    const maxTurns = activeMaxTurns();
    if (maxTurns > 0 && (conversation.activeTurns ?? 0) >= maxTurns) return false;
    // `activeSeq` 停在上一次接话那条上；这里已经比它大 1 以上就说明中间有人插过话
    // （当前这条自己会把序号 +1，所以「紧跟着的下一条」正好是 +1）。
    if ((chatterSeq.get(conversation.id) ?? 0) > (Number(conversation.activeSeq) || 0) + 1) return false;
    if (mentionsOthers(message, selfId)) return false;
    return true;
  }

  /**
   * 取消这个会话挂着的「补一句」定时器。
   *
   * 做法是把 `chimeSeq` 加一：旧回调醒来发现编号对不上就什么都不做。比在每个可能的
   * 取消点都记得 `clearTimeout` 更省心（`clearTimeout` 照样调，只是不作为正确性的依赖）。
   * @param conversation - 目标会话。
   */
  function cancelChime(conversation) {
    conversation.chimeSeq = (conversation.chimeSeq ?? 0) + 1;
    if (conversation.chimeTimer !== undefined) {
      clearTimeout(conversation.chimeTimer);
      conversation.chimeTimer = undefined;
    }
  }

  /**
   * 「自己补一句」的延迟（毫秒）：在 `activeChimeIdleMs` 上按 `delayJitter` 抖动。
   *
   * 掐着表 20 秒整补一句比不补还像机器人；复用打字延迟那个抖动比例，不额外加配置。
   */
  function chimeDelay() {
    const idle = activeChimeIdleMs();
    const jitter = Math.min(1, Math.max(0, Number(config.delayJitter) || 0));
    return Math.max(500, Math.round(idle * (1 + (Math.random() * 2 - 1) * jitter)));
  }

  /**
   * 挂一个「过一会儿也许补一句」的定时器。
   *
   * 只在**正常回完一轮**之后挂（见 turn/end 那条路）：这样「补一句」一定发生在它已经
   * 说过话之后，而不是抢在自己回复前面。主动搭话自己的那一轮不再挂（`owner.proactive`
   * 那条路直接 return）—— 否则它补一句、再补一句，就成了自言自语。
   *
   * 用裸 `setTimeout` 而不是 `ctx.interval`：这是**每条消息一次**的短定时器（和攒批那个
   * 同一性质），生命周期由 `ctx.effect` 的收尾统一清掉，不需要额外的调度框架。
   * @param conversation - 刚回完话的会话。
   */
  function scheduleChime(conversation) {
    if (!proactiveEnabled) return; // 总开关：不允许主动发消息就什么都不挂
    if (activeWindowMs() <= 0 || activeChimeIdleMs() <= 0 || activeChimeMax() <= 0) return;
    cancelChime(conversation);
    // 先取消（编号 +1）再抓编号：这条定时器因此是「目前唯一有效」的那一个。
    const seq = conversation.chimeSeq;
    const timer = setTimeout(() => {
      conversation.chimeTimer = undefined;
      try {
        runChime(conversation, seq);
      } catch (error) {
        report('warn', `chime check failed: ${errorText(error)}`);
      }
    }, chimeDelay());
    timer.unref?.();
    conversation.chimeTimer = timer;
  }

  /** 这个会话今天已经自己补了几句（跨天就地归零）。 */
  function chimeTodayUsed(conversation) {
    const today = localDate();
    if (conversation.chimeDay !== today) {
      conversation.chimeDay = today;
      conversation.chimeToday = 0;
    }
    return conversation.chimeToday ?? 0;
  }

  /**
   * 「补一句」的正题（定时器醒来时再判一遍 —— 这一小会儿里什么都可能变了）。
   *
   * 判据一条都不能少：窗口还热着、没有被后来的消息取代、没有正在飞的回复、这一句之后
   * 还没补够、今天还没超量、**我回过之后确实没人接话**（有人接的话那条消息自己会走
   * 正常回复，而它一到就会把这个定时器作废）、群里中间也没别人插话。
   * @param conversation - 目标会话。
   * @param seq - 挂这个定时器时的编号（对不上说明已经被取代）。
   */
  function runChime(conversation, seq) {
    if (conversation.chimeSeq !== seq) return;
    if (!proactiveEnabled) return;
    const now = Date.now();
    if ((Number(conversation.activeUntil) || 0) <= now) return;
    if (conversation.pending.length > 0 || conversation.batchTimer !== undefined) return;
    if (busyWithTurn(conversation)) return;
    const max = activeChimeMax();
    if (max > 0 && (conversation.chimeCount ?? 0) >= max) return;
    const dailyMax = activeChimeDailyMax();
    if (dailyMax > 0 && chimeTodayUsed(conversation) >= dailyMax) return;
    if ((Number(conversation.lastBotSpeakAt) || 0) <= (Number(conversation.lastActiveAt) || 0)) return;
    // 群里中间又有人说话了：那不是接在我这句后面的事，插进去就是抢话。
    if (conversation.type === 'group' && (chatterSeq.get(conversation.id) ?? 0) !== (Number(conversation.activeSeq) || 0)) return;
    const chance = Math.min(1, Math.max(0, Number(config.proactiveChance)));
    if (!(chance > 0) || !(Math.random() < chance)) return;
    chimeSpeak(conversation, now);
  }

  /**
   * 真的补一句：和 `proactiveSpeak` 一样伪造一条提醒投进这个会话，只是说的事情不同 ——
   * 那边是「群里没人说话了」，这边是「你已经回过他了，还有想说的吗」。
   *
   * 记账先记后说（同 `proactiveSpeak`）：模型判成 `SKIP`、或者这一轮失败，这次机会
   * 照样用掉 —— 否则它会一直重试同一句「再补一句」。
   * @param conversation - 目标会话。
   * @param now - 定时器醒来的时刻（毫秒）。
   */
  function chimeSpeak(conversation, now) {
    conversation.chimeCount = (conversation.chimeCount ?? 0) + 1;
    conversation.chimeToday = chimeTodayUsed(conversation) + 1;
    const silenceSec = Math.max(1, Math.round((now - (Number(conversation.lastActiveAt) || now)) / 1000));
    report('info', `${describeConversation(conversation)} 对话还热着（对方安静了约 ${silenceSec} 秒），主动补一句`);
    enqueue(conversation, async () => {
      try {
        const agent = await ensureAgent(conversation);
        const userMessage = createUserMessage({
          content: [{ type: 'text', text: chimeNudge() }],
          source: { kind: 'user' },
        });
        // 与主动搭话同一个标记：turn 结束时按它分流（SKIP 静默、出错不道歉）。
        submitted.set(userMessage.id, {
          key: conversation.key,
          quote: { messageId: '', userId: '', seq: 0 },
          proactive: true,
        });
        agent.followup(userMessage);
      } catch (error) {
        report('warn', `chime turn for ${conversation.key} could not start: ${errorText(error)}`);
      }
    });
  }

  /**
   * 「补一句」那条伪造的提醒。
   *
   * 和冷场的 `proactiveNudge` 的区别只有两处：这里的前提是**它刚回过话、对方安静了
   * 一小会儿**，所以要说清「别重复刚说过的」，并且明确这是可有可无的一句。
   * @returns user message 正文。
   */
  function chimeNudge() {
    return [
      '（这不是谁发给你的消息，是插件在提醒你：刚才那轮你已经回过话了，对方安静了一小会儿。还有想补充的、想追问的，可以再说一句。）',
      '',
      '要不要说由你定：',
      imageAllowed()
        ? '- 想补一句刚才没说完的、追问一句你正好奇的，或者甩一张合适的表情包（正文只写 `[[图片: 路径]]`），都行；'
        : '- 想补一句刚才没说完的、追问一句你正好奇的，都行；',
      '- 没什么想说的就整条回复只写 `SKIP` —— 那样一个字都不会发出去，这是很正常的选择。',
      '',
      '注意：',
      '- 别重复你刚说过的话，也别把那句换个说法再说一遍；',
      '- 别提前面这条提醒，也别说「你怎么不说话了」这种旁白；一条就够。',
    ].join('\n');
  }

  /**
   * 把一条消息里的图片/表情包落到本地，并给出「段下标 → 替身文本」的映射。
   *
   * 三个调用点：发给机器人的那条（`submitBatch`）、被它引用的那条（`resolveQuote`）、
   * 以及群里闲聊进了环境缓冲的那条（`hydrateAmbientMedia`，由 `ambientMedia` 控制）。
   * 同一张图被反复发也没关系 —— 缓存按内容哈希命名，命中的是同一个文件。
   *
   * @param message - OneBot 的 `message` 字段。
   * @returns `{ rendered, fetched, outcomes }`：`rendered` 是「段下标 → 替身文本」的映射，
   *   `fetched` 是真正落盘成功的个数（用来让调用方区分「这张图拿到了」与「全是取不到文件
   *   的占位符」），`outcomes` 是「段下标 → 落盘结果」（`{ path, bytes, cached }` 或
   *   `{ error }`，表情包复读靠它拿内容哈希路径）；这条消息里没有媒体段、或下载功能被
   *   关掉时返回 undefined。
   */
  async function resolveMessageMedia(message) {
    if (!mediaStore.enabled) return undefined;
    const items = collectMedia(message);
    if (items.length === 0) return undefined;
    const rendered = new Map();
    const outcomes = new Map();
    let fetched = 0;
    // 并行取：一条消息里同时发几张图很常见，串行会一条条排队。
    await Promise.all(
      items.map(async (item) => {
        const outcome = await mediaStore.resolve(item);
        outcomes.set(item.index, outcome);
        if (outcome.path !== undefined) {
          fetched += 1;
          report('info', `media: ${item.kind}${item.label.length > 0 ? ` "${item.label}"` : ''} → ${outcome.path} (${outcome.bytes} bytes)`);
          rendered.set(item.index, mediaPlaceholder(item, outcome.path));
          return;
        }
        // 取不到不是错误路径上的意外：消息照常投递，只是模型看到的是一句「这里本来有张图」。
        report('warn', `media: could not fetch ${item.kind}${item.label.length > 0 ? ` "${item.label}"` : ''}: ${outcome.error}`);
        rendered.set(item.index, mediaPlaceholder(item, '', outcome.error));
      }),
    );
    return { rendered, fetched, outcomes };
  }

  /**
   * 一条消息的媒体解析结果，按**消息对象**记忆（同一个对象的解析只做一次）。
   *
   * 同一条群消息里的图会被两处需要：环境上下文要把路径写进提示词（`hydrateAmbientMedia`），
   * 表情包复读要拿落盘后的内容哈希判断「是不是同一张」（`maybeRepeat`）。两边各下载一遍
   * 就是白白多拉一次 CDN —— 所以共用同一个 Promise。事件对象是短命的，WeakMap 不会留住它。
   * @param message - OneBot 的 `message` 字段。
   * @returns 与 {@link resolveMessageMedia} 同形的 Promise（非消息段数组时为 undefined）。
   */
  function mediaFor(message) {
    if (typeof message !== 'object' || message === null) return Promise.resolve(undefined);
    let pending = mediaResolutions.get(message);
    if (pending === undefined) {
      pending = resolveMessageMedia(message);
      mediaResolutions.set(message, pending);
    }
    return pending;
  }

  /**
   * 把「这条消息在回复的那一条」取回来，渲染成引用前缀。
   *
   * 为什么非要多一次 `get_msg`：OneBot 的 `reply` 段里只有一个 message_id，被引用消息
   * 的图与正文都不在入站事件里。群里刷屏时最常见的用法正是「引用一张表情包再 @ 它问
   * 这是啥」，不取这一趟就只能看见一句 `[回复]`。
   *
   * 任何失败（实现不支持 `get_msg`、老消息已被撤回、网络抖动）都只降级成「没有引用
   * 前缀」，绝不打断消息投递 —— QQ 那头是无人值守的。
   *
   * @param message - 入站消息的 `message` 字段。
   * @returns `{ name, text, index }`（`index` 是 `reply` 段的下标，供渲染时替换掉那个
   *   没有信息量的 `[回复]` 占位符）；没有引用段、取不到、或 `quoteMedia` 关着时 undefined。
   */
  async function resolveQuote(message) {
    if (!config.quoteMedia) return undefined;
    const reply = findReply(message);
    if (reply === undefined) return undefined;
    const { id, index } = reply;
    let info;
    try {
      // NapCat 的 message_id 是整数；纯数字就按整数传，其余原样（个别实现用字符串 id）。
      info = await client.call('get_msg', { message_id: /^\d+$/.test(id) ? Number(id) : id }, QUOTE_FETCH_TIMEOUT_MS);
    } catch (error) {
      report('warn', `quote: could not fetch message ${id}: ${errorText(error)}`);
      return undefined;
    }
    const quoted = info?.message ?? info?.raw_message;
    if (quoted === undefined || quoted === null) return undefined;
    const resolved = await resolveMessageMedia(quoted);
    const text = messageToText(quoted, undefined, resolved?.rendered).replace(/\s+/g, ' ').trim();
    const sender = info?.sender ?? {};
    const name = String(sender.card ?? sender.nickname ?? info?.user_id ?? '某人');
    return { name, text: text.slice(0, QUOTE_TEXT_CHARS), index };
  }

  /**
   * 把引用渲染成一行前缀。被引用的是纯图时 `text` 就是占位符本身，模型据此去读文件。
   * @param quote - {@link resolveQuote} 的结果。
   * @returns 例如 `（引用 kaguya: [图片(动画表情): .qq-media/ab12….jpg]）`。
   */
  function quotePrefix(quote) {
    return quote.text.length > 0 ? `（引用 ${quote.name}: ${quote.text}）` : `（引用 ${quote.name} 的消息）`;
  }

  /**
   * 让环境上下文里那条闲聊消息的图也落盘，落完把带路径的文本回填到缓冲区条目上。
   *
   * 环境上下文是每次装配提示词时现读缓冲区的，所以这里 fire-and-forget 就够了：
   * 下载在「别人闲聊」与「有人 @ 它」之间那段时间里完成，等提示词真正渲染时条目
   * 已经被改写成带路径的版本。整条链路失败也只是继续显示朴素占位符。
   *
   * @param message - 那条闲聊消息的 `message` 字段。
   * @param entry - 已推进 `ambient` 缓冲区的条目（`{ name, text }`，就地改写 `text`）。
   * @param lineChars - 单行字符上限（与初次渲染时用的是同一个值）。
   */
  async function hydrateAmbientMedia(message, entry, lineChars) {
    try {
      const resolved = await mediaFor(message);
      // 一张都没拿到（URL 过期、CDN 报错）时保留原来的朴素占位符：环境上下文里
      // 「没能取到文件: HTTP 403」只是一行噪音，没人会去追。
      if (resolved === undefined || resolved.fetched === 0) return;
      const rendered = messageToText(message, undefined, resolved.rendered).replace(/\s+/g, ' ').trim();
      if (rendered.length > 0) entry.text = rendered.slice(0, lineChars);
    } catch (error) {
      report('warn', `ambient media failed: ${errorText(error)}`);
    }
  }

  // ---- 攒批：几个人同时 @ 时只回一轮 -----------------------------------------

  /**
   * `setTimeout` 能表达的最大延迟。
   *
   * 配置写成天文数字时不能让 Node 的定时器溢出 —— 那会退化成「1 毫秒后立刻醒」，
   * 也就是把「几乎无限地等」变成「立刻发出去」，方向完全反了。
   */
  const MAX_TIMER_MS = 2 ** 31 - 1;

  /** 攒批窗口（毫秒）；配置非法或为 0 时返回 0，表示关闭攒批、来一条回一条。 */
  function batchWindow() {
    const raw = Math.floor(Number(config.batchWindowMs));
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  /** 一批最多等多久（毫秒）。配置比窗口还小时没有意义，按下限（= 窗口）算。 */
  function batchCap(window) {
    const raw = Math.floor(Number(config.batchMaxWaitMs));
    return Number.isFinite(raw) && raw > window ? raw : window;
  }

  /**
   * 把一件「按到达顺序处理」的事挂到会话队列尾。
   *
   * 队列是每个会话一条的串行链：媒体落盘、确保 Agent 就绪、投递消息都在这条链上，
   * 处理顺序因此与消息到达顺序一致（否则「先发图、再说那句话」会被下载耗时颠倒）。
   * 失败时把原因回给发消息的人 —— 静默会被群里当成「机器人不理人」。
   */
  function enqueue(conversation, job) {
    conversation.queue = conversation.queue
      .then(job)
      .catch((error) => {
        const detail = error?.message ?? String(error);
        report('warn', `could not queue for ${conversation.key}: ${detail}`);
        void sendToConversation(conversation, `（我这边出错了：${detail}）`);
      });
  }

  /**
   * 收下一条要回的消息，先压着不投给 Agent：等一个窗口，看还有没有人接着说。
   *
   * 这是「几个人同时 @ 时不要分开回复」的关键。Harness 的 inbox 每次只从 next-turn
   * 里认领**一条**消息，也就是「一条消息 = 一轮 = 一条回复」；前后脚到的消息若逐条投递，
   * 群里看到的必然是机器人一条一条地分别答复每个人。攒成一条，才有一轮里把几个人
   * 一起接住的机会。
   *
   * 窗口从**最后一条**往后算（还有人接着说就再等一个窗口），但整批的等待以第一条
   * 到达时刻为起点卡一个上限（`batchMaxWaitMs`）—— 否则群里你一句我一句地 @ 下去，
   * 机器人会永远不吭声。
   *
   * @param conversation - 目标会话。
   * @param entry - 已准入的这条消息 `{ message, name, userId, quote, at }`。
   */
  function holdForBatch(conversation, entry) {
    const window = batchWindow();
    if (window <= 0) {
      submitBatch(conversation, [entry]);
      return;
    }
    conversation.pending.push(entry);
    const cap = batchCap(window);
    const since = conversation.pending[0].at;
    const wait = Math.max(0, Math.min(window, since + cap - Date.now(), MAX_TIMER_MS));
    if (conversation.batchTimer !== undefined) clearTimeout(conversation.batchTimer);
    conversation.batchTimer = setTimeout(() => flushBatch(conversation), wait);
    // 等待中的批次不该拖着进程不让退出（与 sleep 一致）。
    conversation.batchTimer.unref?.();
  }

  /** 结束等待，把攒下的消息作为**一条** user message 投进会话队列。 */
  function flushBatch(conversation) {
    if (conversation.batchTimer !== undefined) {
      clearTimeout(conversation.batchTimer);
      conversation.batchTimer = undefined;
    }
    const batch = conversation.pending.splice(0);
    if (batch.length === 0) return;
    submitBatch(conversation, batch);
  }

  /**
   * 把一批消息渲染成一条 user message 交给会话的 Agent。
   *
   * 媒体在这里才落盘（在队列上串行），一条里的图和话都按原样呈现给模型。
   * 只带 @ 没有正文的消息会被丢掉；整批都不剩东西时什么都不发。
   */
  function submitBatch(conversation, batch) {
    enqueue(conversation, async () => {
      const selfId = client.selfId;
      const entries = [];
      for (const item of batch) {
        // 本条自己的图和「它在回复的那条」里的图一起取：两件事互不依赖，串起来等只是白等。
        const [resolved, quote] = await Promise.all([mediaFor(item.message), resolveQuote(item.message)]);
        // 引用成功时把 `[回复]` 占位符换成真正的引用前缀：否则模型会看到
        // 「（引用 kaguya: …）\n[回复]这啥」这种一半有内容、一半是噪音的正文。
        const rendered = new Map(resolved?.rendered ?? []);
        if (quote !== undefined) rendered.set(quote.index, '');
        // 活跃对话里接上的那句没有前缀可去：按前缀长度硬切会把「然后呢」切成「后呢」。
        const raw = messageToText(item.message, selfId, rendered.size > 0 ? rendered : undefined).trim();
        const body = item.continued === true ? raw : dropPrefix(raw);
        if (body.length === 0 && quote === undefined) continue;
        const composed = quote === undefined
          ? body
          : body.length > 0
            ? `${quotePrefix(quote)}\n${body}`
            : quotePrefix(quote);
        entries.push({ name: item.name, id: item.userId, body: composed });
      }
      if (entries.length === 0) return;
      const text = renderBatch(entries);
      const names = [...new Set(entries.map((entry) => entry.name))].join('、');
      report('info', `← ${describeConversation(conversation)} ${names}${entries.length > 1 ? `（${entries.length} 条）` : ''}: ${text.slice(0, 120)}`);
      // 发言人：提示词里要说得清「现在是谁在跟你说话」，所以几个人的话都记下来。
      const speakers = new Map();
      for (const entry of entries) speakers.set(entry.id, { name: entry.name, id: entry.id });
      conversation.speakers = [...speakers.values()];
      const agent = await ensureAgent(conversation);
      const userMessage = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      });
      submitted.set(userMessage.id, { key: conversation.key, quote: batchQuote(batch) });
      agent.followup(userMessage);
    });
  }

  /**
   * 一批消息的回复指向。
   *
   * 只有「整批都是同一个人说的」才值得指向他最后那条；几个人一起问的时候引用谁的
   * 截图都像是只在回他，所以裸文本发出去，谁的话谁自己认领。
   * @param batch - 这一批 `{ userId, quote }`。
   * @returns 要挂在本轮第一条上的 `{ messageId, userId, seq }`。
   */
  function batchQuote(batch) {
    const senders = new Set(batch.map((entry) => entry.userId));
    if (senders.size === 1) return batch[batch.length - 1].quote;
    return { messageId: '', userId: '', seq: 0 };
  }

  /**
   * 把一批消息渲染成一条 user message 的正文。
   *
   * 只有一条时原样返回 —— 旧行为完全不变。多条时每行标出是谁说的、并在开头点一句
   * 「这些是几乎同时到的」，否则模型会把它读成一个人自说自话的一整段。
   * @param entries - `{ name, body }`，按到达顺序。
   */
  function renderBatch(entries) {
    if (entries.length === 1) return entries[0].body;
    // 折掉换行：一行一条才看得出「这是几条消息」，也才说得清每句是谁说的。
    const lines = entries.map((entry) => `${entry.name}: ${entry.body.replace(/\s+/g, ' ').trim()}`);
    const names = [...new Set(entries.map((entry) => entry.name))];
    const note = names.length > 1
      ? `（下面 ${lines.length} 条是几乎同时到的，${names.join('、')} 都在跟你说话）`
      : `（下面 ${lines.length} 条是${names[0]}连着发的）`;
    return [note, ...lines].join('\n');
  }

  /** 处理一条已解码的 OneBot 事件（由 OneBotClient 的 onEvent 调用）。 */
  function handleEvent(event) {
    const selfId = client.selfId;
    if (event?.post_type !== 'message') return;
    if (selfId === '') return;
    // 先记「群里又有人说了一句」，`admit` 紧接着快照的序号才算上这条自己 ——
    // 快照与发送时读到的值相等就说明没人插话，`auto` 便不引用。
    noteChatter(event, selfId);
    // 同一时刻记一次「这个会话是活跃的」：主动说话只挑安静下来的群（见 touchActivity）。
    touchActivity(event, selfId);
    const admitted = admit(event, selfId);
    // 复读链在所有别人的群消息上进账（被 @ 的那条也打断「连着」），但只有没被 @ 的才真的跟。
    maybeRepeat(event, selfId, admitted === undefined);
    // 长期记忆：把这条消息记进这个会话的转录（**所有**别人的消息，包括没 @ 机器人的
    // 群聊）。放在复读/环境上下文之前 —— 那两条路都会提前 return，而转录不该漏掉任何一条。
    // 「活跃对话里接上的一句」（`continued`）**不算指令**：`/jm` 与 `/reset` 这类旁路要求
    // 明确叫了它（@ 或前缀）才认 —— 否则窗口里一句闲聊「jm 123」就会绕开模型去下本子。
    const commanded = admitted !== undefined && admitted.continued !== true;
    const jmCommandForLog = commanded ? readJmCommand(messageToText(admitted.message, selfId).trim()) : undefined;
    rememberTranscript(event, selfId, {
      admitted,
      jmCommand: jmCommandForLog,
      reset: commanded && resetCommand.length > 0 && admitted.preview.toLowerCase() === resetCommand,
    });
    if (admitted === undefined) {
      rememberAmbient(event, selfId);
      return;
    }
    const { conversation, message, preview, quote } = admitted;
    const sender = event.sender ?? {};
    const who = describeConversation(conversation);
    // 兜底清理归属表，避免「消息入队了但 turn 始终没被 claim」导致无限增长。
    if (submitted.size > 512) submitted.clear();
    // 禁漫下载指令走**旁路**：它不进会话队列、也不建 Agent 会话。整本要下十几分钟，
    // 排在队列里会把后面所有消息堵死；而且「/jm 123」是一个明确任务，不需要模型参与。
    const jmCommand = jmCommandForLog;
    if (jmCommand !== undefined) {
      // 攒着的那批比这条指令先到，先放它们走，回复顺序才不颠倒。
      flushBatch(conversation);
      report('info', `← ${who} ${sender.nickname ?? ''}: ${jmCommand.ref === undefined ? '（/jm 缺车号）' : `jm ${jmCommand.ref.id}`}`);
      if (jmCommand.ref === undefined) {
        void sendToConversation(conversation, `用法：${config.jmCommand.trim() || '/jm'} <车号 或 18comic 链接>`, { quote });
      } else {
        void runJmCommand(conversation, jmCommand.ref, quote);
      }
      return;
    }
    // 会话重置指令：整条消息恰好等于指令才触发，且只清空「发指令的这个会话」。
    // 攒着的那批是在清空之前收到的，必须先投出去，否则那几句话会被一起忘掉。
    if (commanded && resetCommand.length > 0 && preview.toLowerCase() === resetCommand) {
      flushBatch(conversation);
      enqueue(conversation, async () => {
        const cleared = await resetConversation(conversation);
        await sendToConversation(conversation, cleared ? '已清空本会话记忆。' : '（清空失败：没能删掉会话记录，请查看机器人日志）');
      });
      return;
    }
    // 其余消息都先攒一会儿：同一个群里几个人同时 @、或者一个人连发几句，
    // 攒成一条只回一轮（见 holdForBatch）。
    holdForBatch(conversation, {
      message,
      quote,
      // 「活跃对话里接上的一句」正文里没有前缀可去（见 admit / dropPrefix）。
      continued: admitted.continued === true,
      userId: String(event.user_id ?? ''),
      name: String(sender.card ?? sender.nickname ?? event.user_id ?? '某人'),
      at: Date.now(),
    });
  }

  // ---- 持久化事件路由 --------------------------------------------------------
  // 回复链路：submitted（消息 → 会话）→ agent/inbox/claimed（开启 turn）→
  // session/event 累积 assistant 文本 → turn/end 时把最后一条文本发回 QQ。

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    // 只认自己提交过的消息；认领后即可从 submitted 移除，改由 turnOwners 记账。
    const owner = submitted.get(message.id);
    if (owner === undefined) return;
    submitted.delete(message.id);
    turnOwners.set(`${agent.id}:${turn}`, owner);
  });

  ctx.on('session/event', (session, event) => {
    // 与本插件无关的会话事件直接忽略。
    const key = sessionIndex.get(session.id);
    if (key === undefined) return;
    if (event.type === 'assistant/message') {
      // 逐条累积：一轮里可能有多步 assistant 消息，最后一轮的第一条与最后一条不一定相同。
      const text = visibleText(event.data.message.content);
      if (text.length === 0) return;
      const slot = `${session.id}:${event.data.turn}`;
      const list = transcripts.get(slot) ?? [];
      list.push(text);
      transcripts.set(slot, list);
      return;
    }
    if (event.type !== 'turn/end') return;
    // turn 结束：取走累积文本与归属信息（无论是否要回复，都要清理，防止泄漏）。
    const slot = `${session.id}:${event.data.turn}`;
    const list = transcripts.get(slot);
    transcripts.delete(slot);
    const owner = turnOwners.get(slot);
    turnOwners.delete(slot);
    if (owner === undefined) return;
    const conversation = conversations.get(owner.key);
    if (conversation === undefined) return;
    const reason = event.data.reason?.kind;
    // 被打断 / fork 掉 / 中止的 turn 不是有效回复，静默丢弃。
    if (reason === 'aborted' || reason === 'forked' || reason === 'interrupted') return;
    if (reason === 'error') {
      // 主动搭话是我自己挑起来的话头，没人问过它：出错就安静地算了，
      // 别反过来在群里贴一句「我这边出错了」。
      if (owner.proactive !== true) void sendToConversation(conversation, '（我这边处理时出错了，稍后再试试）');
      return;
    }
    // 只发该 turn 里最后一条有文本的 assistant 消息；中间步骤的工具调用等不发给 QQ。
    const reply = list?.[list.length - 1]?.trim() ?? '';
    if (reply.length === 0) return;
    if (owner.proactive === true) {
      // 主动搭话允许「想了想，不说了」：`SKIP` 或空回复都一个字都不发（见 proactiveNudge）。
      if (proactiveSkip(reply)) {
        report('info', `→ ${conversation.key}: （主动搭话时决定不说话）`);
        return;
      }
      report('info', `→ ${conversation.key}: ${reply.slice(0, 120)}（主动）`);
      // 同一条「拟人」通道：拆短句 + 打字延迟。主动搭话没有可指向的消息，quote 为空。
      void sendToConversation(conversation, reply, { human: true, quote: owner.quote });
      return;
    }
    report('info', `→ ${conversation.key}: ${reply.slice(0, 120)}`);
    // 自动回复走「拟人」通道：拆短句 + 打字延迟 + 引用/@ 对方。
    // 等这一轮真的发完再挂「过一会儿也许补一句」的定时器（见 scheduleChime）：
    // 补一句必须排在它这次回复**之后**，而且得等打完字才算「对方安静了」。
    void sendToConversation(conversation, reply, { human: true, quote: owner.quote }).then(() => {
      scheduleChime(conversation);
    });
  });

  // ---- 工具注册 --------------------------------------------------------------

  /**
   * 工具一：qq_send_message —— 主动向某个 QQ 号或群号发文本（超长自动分段）。
   * 面向所有 Harness Agent 全局可用，包括 Web UI 里的主会话。
   */
  ctx.tools.register(
    defineTool({
      name: 'qq_send_message',
      description:
        'Send a text message through the connected QQ (OneBot) account to one QQ contact or group. Requires the QQ bridge plugin to be connected; use qq_list_conversations first when the target id is unknown.',
      parameters: {
        target_type: {
          type: 'string',
          enum: ['private', 'group'],
          required: true,
          description: 'Whether the target id is a QQ number (private) or a group number (group).',
        },
        target_id: {
          type: 'string',
          required: true,
          description: 'The QQ number for private targets, or the group number for group targets.',
        },
        message: {
          type: 'string',
          required: true,
          description: 'The plain-text message body to send. Long text is split automatically.',
        },
      },
      // 输出结构：回显目标与实际发送的段数，便于模型确认「发了几条」。
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            target_type: { type: 'string', required: true },
            target_id: { type: 'string', required: true },
            parts: { type: 'integer', required: true },
          },
        },
        // render 决定这条工具结果如何呈现给调用它的 Agent（人可读的摘要）。
        render: (_args, value) => [
          { type: 'text', text: `Sent ${value.parts} QQ message part(s) to ${value.target_type} ${value.target_id}.` },
        ],
      },
      async execute(args) {
        // 未连接时直接报错，而不是静默丢弃消息。
        if (!client.connected) throw new Error(`QQ bridge is not connected to ${config.endpoint}; start NapCat or check the endpoint.`);
        const targetType = args.target_type;
        const targetId = String(args.target_id).trim();
        const body = String(args.message ?? '').trim();
        if (targetId.length === 0) throw new Error('qq_send_message requires a non-empty target_id');
        if (body.length === 0) throw new Error('qq_send_message requires a non-empty message');
        const action = targetType === 'group' ? 'send_group_msg' : 'send_private_msg';
        const idKey = targetType === 'group' ? 'group_id' : 'user_id';
        // 这是 Agent 的显式动作（「就发这段」），所以只按协议上限分段：
        // 不做拆句、不加打字延迟 —— 拟人节奏只加在 QQ 会话的自动回复上。
        const parts = chunkText(body, protocolLimit());
        for (const part of parts) await client.call(action, { [idKey]: targetId, message: part });
        return { target_type: targetType, target_id: targetId, parts: parts.length };
      },
    }),
  );

  /**
   * 工具二：qq_send_image —— 主动往 QQ 发一张图 / 一个表情包。
   *
   * 传输走 OneBot image 段的 `base64://`（见 `image.js` 里的取舍说明）：NapCat 在
   * 容器里，本地路径它读不到，而 base64 不依赖任何网络可达性假设。
   *
   * 从 QQ 会话里调用可以不给目标（默认发回当前会话）—— 「回一张表情包」不该先让
   * 模型去查自己在哪个群。
   */
  ctx.tools.register(
    defineTool({
      name: 'qq_send_image',
      description:
        'Send one image (a picture or a meme/sticker, PNG/JPEG/WebP/GIF) through the connected QQ (OneBot) account to one QQ contact or group. The image source is either a path inside the working directory (such as a sticker under the sticker directory, or a picture the conversation already downloaded into the media cache) or an http(s) image URL. Called from inside a QQ conversation, the current conversation is the default recipient.',
      parameters: {
        image: {
          type: 'string',
          required: true,
          description: 'The image to send: a path relative to the working directory (e.g. ".qq-stickers/笑死.gif" or ".qq-media/ab12….jpg"), an absolute path inside the working directory, an http(s) image URL, or just the file name of a sticker from the sticker directory (with or without its extension).',
        },
        target_type: {
          type: 'string',
          enum: ['private', 'group'],
          description: 'Where to send the image. Defaults to the QQ conversation this tool was called from.',
        },
        target_id: {
          type: 'string',
          description: 'QQ number (private) or group number (group) to send the image to. Defaults to the current QQ conversation.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            target_type: { type: 'string', required: true },
            target_id: { type: 'string', required: true },
            bytes: { type: 'integer', required: true },
            format: { type: 'string', required: true },
            source: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `Sent a ${value.format} image (${value.bytes} bytes) from ${value.source} to ${value.target_type} ${value.target_id}.`,
          },
        ],
      },
      async execute(args, exec) {
        if (!imageSend) throw new Error('sending images is disabled (qq-bridge config imageSend: false)');
        if (!client.connected) throw new Error(`QQ bridge is not connected to ${config.endpoint}; start NapCat or check the endpoint.`);
        const { type, id } = resolveTarget(args, exec, 'qq_send_image');
        // 先取字节、先校验：任一步失败都在发消息之前报错，不会给 QQ 留下半张图。
        const image = await loadOutgoingImage({ source: resolveStickerSource(args.image), cwd, maxBytes: imageMaxBytes });
        const action = type === 'group' ? 'send_group_msg' : 'send_private_msg';
        const idKey = type === 'group' ? 'group_id' : 'user_id';
        await client.call(action, { [idKey]: id, message: [imageSegment(image.bytes)] });
        report('info', `→ ${type === 'group' ? '群' : '私聊'} ${id}: ${image.format} 图 ${image.bytes.length} bytes（来源 ${image.label}）`);
        return { target_type: type, target_id: id, bytes: image.bytes.length, format: image.format, source: image.label };
      },
    }),
  );

  /**
   * 工具三：qq_list_conversations —— 列出在线群/好友，以及本 Harness 已处理过的
   * QQ 会话及其 Session id，同时附带当前生效的模型路由（便于排查 MISSING_CREDENTIAL
   * 之类的模型问题）。
   */
  ctx.tools.register(
    defineTool({
      name: 'qq_list_conversations',
      description:
        'List QQ contacts reachable through the connected OneBot account: the live group and friend lists, plus every QQ conversation this Harness has already handled and its Session id.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            connected: { type: 'boolean', required: true },
            self_id: { type: 'string' },
            groups: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                },
              },
            },
            friends: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                },
              },
            },
            sessions: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  conversation: { type: 'string', required: true },
                  type: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  session_id: { type: 'string', required: true },
                },
              },
            },
            route: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                provider: { type: 'string', required: true },
                model: { type: 'string', required: true },
                source: { type: 'string', required: true },
                error: { type: 'string', required: true },
              },
            },
          },
        },
        render: (_args, value) => {
          const lines = [`QQ bridge connected: ${value.connected}${value.self_id ? ` (account ${value.self_id})` : ''}`];
          lines.push(`QQ session model: ${value.route.model || '(none)'} via ${value.route.provider || '(none)'} [${value.route.source}]`);
          if (value.route.error.length > 0) lines.push(`Route warning: ${value.route.error}`);
          if (value.groups.length > 0) lines.push('', 'Groups:', ...value.groups.map((g) => `  ${g.id} ${g.name}`));
          if (value.friends.length > 0) lines.push('', 'Friends:', ...value.friends.map((f) => `  ${f.id} ${f.name}`));
          if (value.sessions.length > 0) {
            lines.push('', 'Handled conversations:', ...value.sessions.map((s) => `  ${s.conversation} (${s.name}) → session ${s.session_id}`));
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute() {
        const groups = [];
        const friends = [];
        // 未连接时这两项为空数组（而不是报错），其余信息照常返回，方便定位问题。
        if (client.connected) {
          try {
            for (const group of (await client.call('get_group_list')) ?? []) {
              groups.push({ id: String(group.group_id), name: String(group.group_name ?? '') });
            }
          } catch (error) {
            report('warn', `get_group_list failed: ${error?.message ?? error}`);
          }
          try {
            for (const friend of (await client.call('get_friend_list')) ?? []) {
              friends.push({ id: String(friend.user_id), name: String(friend.nickname ?? '') });
            }
          } catch (error) {
            report('warn', `get_friend_list failed: ${error?.message ?? error}`);
          }
        }
        const chosen = resolveRoute();
        return {
          connected: client.connected,
          self_id: client.selfId,
          groups,
          friends,
          route: { provider: chosen.provider, model: chosen.model, source: chosen.source, error: chosen.error },
          // sessions 来自已处理过的会话表；session_id 现场派生，因此与 QQ 号一一对应且稳定。
          sessions: [...conversations.values()].map((conversation) => ({
            conversation: conversation.key,
            type: conversation.type,
            name: conversation.name || conversation.senderName,
            session_id: sessionIdFor(conversation.key),
          })),
        };
      },
    }),
  );

  /**
   * 工具四：qq_jm_pdf —— 下载禁漫（JM）本子/单话，合并成 PDF，并发到 QQ。
   *
   * 从 QQ 会话里调用时可以不填目标：调用它的那个 Agent 对应的会话就是收件人
   * （`exec.agent.id` → 会话 key）。Web UI 里的主会话调用时必须显式给目标。
   */
  ctx.tools.register(
    defineTool({
      name: 'qq_jm_pdf',
      description:
        'Download a JM (18comic) album or chapter, merge every page into one PDF, and send that PDF to a QQ contact or group through the OneBot bridge. Accepts a bare JM id, "JM123456", or an 18comic album/photo URL. Called from inside a QQ conversation, the current conversation is the default recipient. Long: a whole multi-chapter album can take minutes, and the file upload itself is slow.',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: 'JM album id or chapter id (digits), "JM123456", or a full 18comic album/photo URL.',
        },
        kind: {
          type: 'string',
          enum: ['auto', 'album', 'chapter'],
          description: 'auto (default): the whole album when the id is an album id, otherwise just that chapter. album = every chapter merged into one PDF. chapter = only the chapter with this id.',
        },
        target_type: {
          type: 'string',
          enum: ['private', 'group'],
          description: 'Where to send the PDF. Defaults to the QQ conversation this tool was called from.',
        },
        target_id: {
          type: 'string',
          description: 'QQ number (private) or group number (group) to send the PDF to. Defaults to the current QQ conversation.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file_name: { type: 'string', required: true },
            path: { type: 'string', required: true },
            title: { type: 'string', required: true },
            pages: { type: 'integer', required: true },
            bytes: { type: 'integer', required: true },
            chapters: { type: 'integer', required: true },
            target_type: { type: 'string', required: true },
            target_id: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `Downloaded ${value.title || value.file_name} (${value.chapters} chapter(s), ${value.pages} page(s), ${value.bytes} bytes) ` +
              `into ${value.path} and sent ${value.file_name} to ${value.target_type} ${value.target_id}.`,
          },
        ],
      },
      async execute(args, exec) {
        const ref = parseJmRef(args.id);
        if (ref === undefined) throw new Error(`qq_jm_pdf could not find a JM id in "${args.id}"`);
        const kind = args.kind ?? ref.kind;
        // 收件人：显式给的优先；否则是调用它的那个 QQ 会话。
        const { conversation, type: targetType, id: targetId } = resolveTarget(args, exec, 'qq_jm_pdf');
        const job = await downloadJm({ conversation, ref: { id: ref.id, kind } });
        const sent = await sendJmFile(conversation, job);
        if (!sent.ok) throw new Error(`downloaded ${job.name} but could not send it to QQ: ${sent.error}`);
        return {
          file_name: job.name,
          path: job.path,
          title: job.title,
          pages: job.pages,
          bytes: job.bytes,
          chapters: job.chapters,
          target_type: targetType,
          target_id: String(targetId),
        };
      },
    }),
  );

  // ---- 长期记忆：两个宿主平面的工具 ------------------------------------------
  //
  // 都注册在宿主平面上（和 qq_send_message 一样），因此**任何** Agent 都能用：QQ 会话
  // 的 Agent 用它查/记，摘要会话用它读写记忆文件。好处是 QQ 会话不必为了「记忆」拿到
  // write / edit / bash —— 写只发生在 memoryDir 之内，边界由插件自己守。
  if (memoryEnabled) {
    /**
     * 工具五：qq_transcript —— 查某个 QQ 会话的聊天记录（长期记忆的原料）。
     *
     * 这是「想不起来就去查」的那条路：`ambientMessages` 只喂最近十来条，一旦真需要
     * 「上周三讨论的那个链接是什么」就必须能翻到更早的记录，而不是靠模型编。
     */
    ctx.tools.register(
      defineTool({
        name: 'qq_transcript',
        description:
          'Read the recorded chat transcript of a QQ conversation (long-term memory raw material). Use it when you need details of what was said earlier — who said what, when, and what was shared — instead of guessing from the short recent-message context. Actions: "list" (which conversations have records, with message counts and the newest time), "read" (messages, oldest first, optionally limited to a date range), "search" (substring match across the records).',
        parameters: {
          action: {
            type: 'string',
            enum: ['list', 'read', 'search'],
            description: 'list = the conversations on disk with counts; read = messages of one conversation; search = find a keyword across a conversation\'s records.',
          },
          conversation: {
            type: 'string',
            description: 'Conversation key such as "group:100000001" or "private:100000002". Defaults to the QQ conversation this tool was called from. Not needed for "list".',
          },
          query: {
            type: 'string',
            description: 'The text to look for (action: search). Matched case-insensitively as a substring of the message text, sender name, or date.',
          },
          date: {
            type: 'string',
            description: 'Local date to read, "YYYY-MM-DD" (action: read). Defaults to today.',
          },
          since: {
            type: 'string',
            description: 'Earliest date to include, "YYYY-MM-DD" (action: read). Use with until.',
          },
          until: {
            type: 'string',
            description: 'Latest date to include, "YYYY-MM-DD" (action: read).',
          },
          limit: {
            type: 'integer',
            description: 'Maximum messages/hits to return (default 200 for read, memorySearchHits for search).',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: { type: 'string', required: true },
              conversation: { type: 'string' },
              lines: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    conversation: { type: 'string' },
                    name: { type: 'string' },
                    date: { type: 'string' },
                    messages: { type: 'integer' },
                    last_at: { type: 'string' },
                    last_text: { type: 'string' },
                    at: { type: 'string' },
                    time: { type: 'string' },
                    user: { type: 'string' },
                    text: { type: 'string' },
                    kind: { type: 'string' },
                    addressed: { type: 'boolean' },
                    command: { type: 'string' },
                    media: { type: 'boolean' },
                  },
                },
              },
              returned: { type: 'integer', required: true },
              truncated: { type: 'boolean', required: true },
              note: { type: 'string' },
            },
          },
          render: (_args, value) => {
            const head = value.action === 'list'
              ? `${value.lines.length} conversation(s) with recorded transcripts.`
              : `${value.returned} line(s)${value.truncated ? ' (truncated)' : ''}${value.conversation !== undefined ? ` for ${value.conversation}` : ''}.`;
            return [{ type: 'text', text: [head, value.note ?? '', ...value.lines.map((line) => describeTranscriptLine(line))].filter((part) => part.length > 0).join('\n') }];
          },
        },
        async execute(args, exec) {
          if (args.action === 'list') return listTranscripts();
          const target = resolveMemoryConversation(args, exec, 'qq_transcript');
          if (args.action === 'search') {
            if (typeof args.query !== 'string' || args.query.trim().length === 0) throw new Error('qq_transcript: "query" is required for action "search"');
            return searchTranscript(target, args);
          }
          return readTranscript(target, args);
        },
      }),
    );

    /**
     * 工具六：qq_memory —— 读/追加/覆盖记忆文件（`MEMORY.md` / `COGNITION.md` / `INDEX.md`）。
     *
     * 写路径被限制在 memoryDir 之内（`memoryRelativePath`），单个文件也有字节上限：
     * 记忆的价值在「精炼且总是被读到」，一个无限增长的文件只会把提示词撑爆。
     * 读不设上限（要翻就翻个够），只按 `memorySearchHits` 限制搜索命中数。
     */
    ctx.tools.register(
      defineTool({
        name: 'qq_memory',
        description:
          'Read, append to, search, or overwrite a long-term memory file for the QQ bridge. All paths live under the memory directory and are relative to it, for example "conversations/group-100000001/MEMORY.md" (one conversation\'s memory, "write"/"append" create it if missing), "COGNITION.md" (shared knowledge about memes, slang, emoji and sticker meanings), or "INDEX.md" (the short index that is injected into every QQ agent\'s prompt — keep it to a handful of lines). Paths outside the memory directory are rejected.',
        parameters: {
          action: {
            type: 'string',
            enum: ['read', 'append', 'write', 'search', 'list'],
            description: 'read = full file (with line numbers); append = add text at the end (the normal way to record something new); write = replace the whole file (only when reorganising); search = substring match with context lines; list = the files that already exist.',
          },
          path: {
            type: 'string',
            description: 'Memory-relative file path, e.g. "conversations/group-100000001/MEMORY.md", "COGNITION.md", "INDEX.md". For read/write/append it defaults to this conversation\'s MEMORY.md when a conversation is known.',
          },
          conversation: {
            type: 'string',
            description: 'Conversation key such as "group:100000001". Defaults to the QQ conversation this tool was called from; the digest session must pass it.',
          },
          text: {
            type: 'string',
            description: 'The markdown to append or write (action: append / write).',
          },
          query: {
            type: 'string',
            description: 'The text to look for (action: search).',
          },
          limit: {
            type: 'integer',
            description: 'Maximum hits to return (action: search; default memorySearchHits).',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: { type: 'string', required: true },
              path: { type: 'string' },
              bytes: { type: 'integer' },
              lines_total: { type: 'integer' },
              returned: { type: 'integer', required: true },
              truncated: { type: 'boolean', required: true },
              files: { type: 'array', items: { type: 'string' } },
              text: { type: 'string' },
              note: { type: 'string' },
            },
          },
          render: (_args, value) => {
            if (value.action === 'list') {
              return [{ type: 'text', text: `memory files:\n${(value.files ?? []).join('\n') || '(none yet)'}` }];
            }
            const head = `${value.action} ${value.path ?? ''} (${value.bytes ?? 0} bytes)${value.truncated ? ', truncated' : ''}`;
            return [{ type: 'text', text: [head, value.note ?? '', value.text ?? ''].filter((part) => part.length > 0).join('\n') }];
          },
        },
        async execute(args, exec) {
          if (args.action === 'list') return listMemoryFiles();
          const path = resolveMemoryPath(args, 'qq_memory', exec);
          if (args.action === 'read') return readMemoryFile(path);
          if (args.action === 'search') {
            if (typeof args.query !== 'string' || args.query.trim().length === 0) throw new Error('qq_memory: "query" is required for action "search"');
            return searchMemoryFile(path, args.query, args.limit);
          }
          if (typeof args.text !== 'string' || args.text.trim().length === 0) throw new Error(`qq_memory: "text" is required for action "${args.action}"`);
          return writeMemoryFile(path, args.text, args.action === 'append');
        },
      }),
    );
  }

  // ---- 连接生命周期 ----------------------------------------------------------

  // 用 ctx.effect 托管连接：插件卸载/停用时自动 dispose，不留悬挂的定时器与 socket。
  // 注意：Loader 按 URL 缓存插件模块，改源码后必须重启进程才生效（见 README）。
  ctx.effect(() => {
    client.start();
    return () => {
      // 还在等「有没有下一条」的批次跟着一起停：插件都卸了，不该再有定时器醒过来。
      for (const conversation of conversations.values()) {
        if (conversation.batchTimer !== undefined) {
          clearTimeout(conversation.batchTimer);
          conversation.batchTimer = undefined;
        }
        // 「补一句」的短定时器同理（见 scheduleChime）。
        if (conversation.chimeTimer !== undefined) {
          clearTimeout(conversation.chimeTimer);
          conversation.chimeTimer = undefined;
        }
        conversation.pending.length = 0;
      }
      client.dispose();
    };
  }, 'qq-bridge:onebot');

  // 下载链路的托管：关掉那个给 NapCat 取文件的小 HTTP 服务与一次性 token。
  ctx.effect(() => () => jmService.close(), 'qq-bridge:jm');

  // ---- 长期记忆：定时摘要的生命周期 -------------------------------------------
  //
  // 用 `ctx.interval`（dsh-base 的 timer 服务）而不是裸 setInterval：定时器挂在当前
  // fiber 上，插件卸载时自动清掉，不会留下一个还在跑的摘要循环。测试用的 Host 桩
  // 没有 timer 服务，所以有裸 setInterval 的退路。
  if (memoryEnabled) {
    const atHour = digestAtHour();
    const tick = () => {
      try {
        runDigestSweep();
      } catch (error) {
        report('warn', `digest sweep threw: ${errorText(error)}`);
      }
    };
    // 预热：把落盘的摘要时间读进内存，`runDigestSweep` 才能判断「今天这条会话摘要过没有」。
    // 注意**不**在这里立刻扫一遍：`conversations` 是运行时状态，此刻还是空的，扫也扫不到
    // 任何东西。真正需要补的那次由 `maybeCatchUpDigest` 在第一条消息到达时触发。
    void (async () => {
      try {
        const state = await readDigestState();
        for (const [key, entry] of Object.entries(state.conversations)) {
          const at = Number(entry?.lastDigestAt) || 0;
          if (at > 0) memoryLastDigest.set(key, at);
        }
        report('info', `memory: ${memoryLastDigest.size} conversation(s) with a previous digest`);
      } catch (error) {
        report('warn', `could not load digest state: ${errorText(error)}`);
      }
    })();
    let digestTimerDisposer;
    ctx.effect(() => {
      // 每天醒一次，醒来跑完摘要再排下一次：每次算的都是「距离下一个整点还有多久」，
      // 所以刚过点时会排到明天，不会在同一个点上反复醒。
      const schedule = () => {
        const wait = msUntilDailyHour(atHour);
        if (typeof ctx.interval === 'function') {
          digestTimerDisposer = ctx.interval(() => {
            digestTimerDisposer?.();
            tick();
            schedule();
          }, wait);
          return;
        }
        // 没有 timer 服务（例如测试桩或最小组合）时退回裸定时器：同样是「跑完再排」，
        // 不是固定周期。
        const handle = setTimeout(() => {
          tick();
          schedule();
        }, wait);
        handle.unref?.();
        digestTimerDisposer = () => clearTimeout(handle);
      };
      schedule();
      return () => {
        digestTimerDisposer?.();
        digestTimerDisposer = undefined;
      };
    }, 'qq-bridge:memory-digest');
    report('info', `memory enabled at ${memoryLabel} (daily digest at ${hourLabel(atHour)}; a conversation needs ${Math.max(1, Math.floor(Number(config.digestMinLines) || 1))} new lines, once a day)`);
  }

  // ---- 主动说话：定时器 --------------------------------------------------------
  //
  // 与摘要循环同一套托管方式（`ctx.interval`，插件卸载即清掉）。区别在于节奏：
  // 摘要是「每天一个整点」，主动说话是「每隔一会儿看一眼」—— 醒来不一定开口，
  // 说不说交给 `proactiveSweep` 的条件与概率决定（这样开口的时刻才是不可预测的）。
  if (proactiveEnabled) {
    const checkMs = proactiveCheckMs();
    const tick = () => {
      try {
        proactiveSweep();
      } catch (error) {
        report('warn', `proactive sweep threw: ${errorText(error)}`);
      }
    };
    let proactiveTimerDisposer;
    ctx.effect(() => {
      const schedule = () => {
        if (typeof ctx.interval === 'function') {
          proactiveTimerDisposer = ctx.interval(() => {
            proactiveTimerDisposer?.();
            tick();
            schedule();
          }, checkMs);
          return;
        }
        // 没有 timer 服务（测试桩或最小组合）时退回裸定时器：同样是「跑完再排」。
        const handle = setTimeout(() => {
          tick();
          schedule();
        }, checkMs);
        handle.unref?.();
        proactiveTimerDisposer = () => clearTimeout(handle);
      };
      schedule();
      return () => {
        proactiveTimerDisposer?.();
        proactiveTimerDisposer = undefined;
      };
    }, 'qq-bridge:proactive');
    // 启动自述：把「哪几个开关真的生效了」写清楚 —— 排查「它怎么不主动说话」时，
    // 第一件事就是看这几行里有没有你配的那一项，而不是去猜配置有没有读进去。
    const fromHour = Math.min(23, Math.max(0, Math.floor(Number(config.proactiveFromHour)) || 0));
    const toHour = Math.min(23, Math.max(0, Math.floor(Number(config.proactiveToHour)) || 0));
    report(
      'info',
      `proactive on — cold openers in groups only: check every ${Math.round(checkMs / 60000)} min, ` +
        `quiet for ${Math.round(proactiveMs('proactiveIdleMs', 45 * 60 * 1000) / 60000)} min, ` +
        `gap ${Math.round(proactiveMs('proactiveGapMs', 2 * 60 * 60 * 1000) / 60000)} min, ` +
        `at most ${proactiveDailyMax()}/day, ${hourLabel(fromHour)}-${hourLabel(toHour)}`,
    );
    if (activeWindowMs() > 0 && activeChimeIdleMs() > 0 && activeChimeMax() > 0) {
      report(
        'info',
        `active conversation — chime: about ${Math.round(activeChimeIdleMs() / 1000)}s after its reply, ` +
          `at most ${activeChimeMax()}/message and ${activeChimeDailyMax() || '不限'}/day (groups and private)`,
      );
    } else {
      report('info', 'active conversation — chime is off (activeWindowMs / activeChimeIdleMs / activeChimeMax)');
    }
    if (config.activeFollow === true && activeWindowMs() > 0) {
      report(
        'info',
        `active conversation — activeFollow on: a group follow-up from the person it is talking to needs no @ ` +
          `(window ${Math.round(activeWindowMs() / 60000)} min, at most ${activeMaxTurns() || '不限'} turns)`,
      );
    } else {
      report('info', 'active conversation — activeFollow is off: group messages still need an explicit @ (or the configured prefix)');
    }
  }

  // 表情包目录：启动时确保它存在 —— 「往里丢几张图就能用」比「先读文档建目录」友好。
  // 建不出来（只读挂载、权限不对）只是没有表情包可挑，发图本身照常，所以只记一条 warn。
  if (imageSend && stickerRoot !== undefined && stickerInside) {
    void mkdir(stickerRoot, { recursive: true }).catch((error) => {
      report('warn', `could not create stickerDir ${stickerRoot}: ${errorText(error)}`);
    });
  }
}
