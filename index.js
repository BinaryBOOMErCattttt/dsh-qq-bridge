/**
 * QQ Bridge —— QQ（OneBot v11）与 Harness Agent 之间的双向桥接插件。
 *
 * 入站（QQ → Agent）：每个 QQ 会话（一个私聊对象，或一个群）独占一个持久化
 * Harness Session。收到的消息按会话串行投递给该 Session 的 Agent，等这一轮
 * turn 结束后，把最后一条有文本的 assistant 回复发回 QQ。
 *
 * 出站（Agent → QQ）：注册全局工具，任何 Harness Agent 都能主动发 QQ
 * 消息、发图片/表情包、把群友发的那张存成表情包，以及按需查询当前在线的好友/群列表。
 *
 * 复读（QQ → QQ）：群里连着出现同一条消息时，插件自己跟着复读一句（同一张表情包也会被
 * 原样发回去），不经过 Agent（见 `maybeRepeat`）—— 复读机的笑点就在「原样接上」，
 * 等模型想一句俏皮话早就过去了。
 *
 * 文件结构（自上而下）：
 *   1. 插件身份与 `inject`；配置 schema 在 `config.js`（这里只再导出一次）
 *   2. 纯函数工具（sessionIdFor / visibleText）
 *   3. apply()：闭包内维护全部运行时状态、事件路由与工具装配
 *
 * 媒体的**入站**（QQ 的图 → 本地文件，给模型 read_image 看）在 `media.js`；
 * **出站**（本地文件 / URL → QQ 的 image 段）在 `image.js`。这里只负责路由、
 * 提示词与工具装配：什么时候该发、发给谁。
 *
 * 六个宿主平面工具的**声明**在 `tools.js`（依赖由这里显式传进去，那边不持有状态）；
 * 本文件留的是它们的**能力来源**——收件人解析、发送队列这些真正有状态的东西。
 * 长期记忆整个子系统（转录 / 记忆文件 / 摘要循环）在 `memory.js`，同样由这里显式递依赖。
 *
 * @module @qqbot/dsh-plugin-qq
 */
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, rename, stat } from 'node:fs/promises';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { OneBotClient, atMentions, blankMessageLabel, chunkText, collectMedia, findReply, isEmojiOnlyMessage, isStickerSegment, mediaPlaceholder, mentions, mentionsOthers, messageToText, repeatableText, splitBurst, splitStickerLines, typingDelayMs, userDisplayName } from './onebot.js';
import { createMediaStore } from './media.js';
import { hashDistance, perceptualHash } from './perceptual.js';
import { DEFAULT_IMAGE_MAX_BYTES, imageSegment, insideDirectory, loadOutgoingImage } from './image.js';
import { endpointTarget, findNapcatDir, repairNapcat } from './napcat.js';
import { registerQqTools } from './tools.js';
import { createSettings, MAX_TIMER_MS } from './settings.js';
import { createChatter } from './chatter.js';
import { buildMentionResolver, hasMentionMarker, isAllMention, mentionSegments } from './mention.js';
import {
  activeFollowAllows as activeFollowAllowsRule,
  activeTurnsLeft as activeTurnsLeftRule,
  batchCap as batchCapRule,
  batchScale as batchScaleRule,
  batchWindow as batchWindowRule,
  chimeAllows,
  chimeDelay as chimeDelayRule,
  privateAfterthoughtAllows,
  proactiveEligible as proactiveEligibleRule,
  proactiveSkip,
} from './speaking-rules.js';
import { createMemory } from './memory.js';
import { renderBacklog } from './backlog.js';
import { createReminders, describeTask, REMINDER_ROUTE_PATH } from './reminders.js';
import { builtinStyle, classifyReply, createStyle, renderStyleContract, sanitizeBubble } from './style.js';
import { createPersona, renderPersona } from './persona.js';
import { observationOf, renderObservation } from './modalities.js';
import { pokeAction, pokeActionType, pokeNudge, pokeNotice } from './interactions.js';
import { recallAction, recallLine, recallNudge, recallNotice } from './recall.js';
import { fetchPageTitle, previewLine } from './links.js';
import { decideGroupTurn, interjectBatchPrompt, interjectLine } from './speech-policy.js';
import {
  apiKeyFingerprint,
  errorText,
  hourLabel,
  liveConfig,
  localDate,
  localMinute,
  memorySlug,
  msUntilDailyHour,
  parseApiKeyPool,
  sessionIdFor,
  SESSION_ROUTE_PATH,
  stickerFileName,
  visibleText,
  weekdayLabel,
  withinActiveHours,
} from './util.js';
import { readTextOrUndefined, writeBytesAtomic, writeJsonAtomic } from './filestore.js';

// 这几个的契约由 test/bridge.test.mjs 直接从插件入口验，所以在这里再导出一次
// （Loader 也只认 index.js 这个入口，搬走的东西必须在入口处仍然拿得到）。
export { liveConfig, parseApiKeyPool, sessionIdFor, SESSION_ROUTE_PATH, withinActiveHours } from './util.js';

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
 * 宿主的系统提示里，与 QQ 会话无关的几段 —— 在 Agent 作用域里按**同名小节**覆盖掉。
 *
 * 为什么需要它：`dsh-web-app` 把部署 persona 配成「You are a coding agent powered by
 * the {{model}} model.」，又在系统提示末尾注册 `app:web-surface`（「You are interacting
 * with the user through the DeepSeek Harness Web GUI at http://…」）与 `harness:source`
 * （「实现仓库在…，别用它推断工作目录」）；`dsh-client-ui-deliverables` 还注册了一段
 * 「用 Markdown 链接 / `present` 展示结果」。这些对 Web UI 是对的，但 QQ 会话是**在群里
 * 聊天的人**，不是编码代理、也不在浏览器里 —— 而它们分别压在系统提示的开头和结尾，
 * 比夹在中间的 `qq-bridge:channel` 更容易被模型当成身份（久了就「变人机」）。
 *
 * 机制：`systemPrompt` 的小节按名字合并，**Agent 作用域的同名小节遮蔽全局小节**
 * （`dsh-system-prompt` 的 `PERSONA_PREFIX_SECTION` 注释写明这个槽位就是给预设/会话覆盖
 * 用的）。所以在 `attachChannelPrompt` 里按同名注册一份即可，只影响这个 QQ 会话，
 * Web UI 的会话原样不动。空字符串的小节在装配时会被丢掉（`renderPrompt` 过滤空段）。
 */
const HOST_PROMPT_SHADOWS = [
  // 「You are an AI agent powered by DeepSeek Harness.」—— 身份由渠道小节自己交代。
  { name: 'harness:identity', order: -1000, text: '' },
  // 「You are a coding agent powered by the deepseek-flash model.」—— 最伤的一段：
  // 它是系统提示的第二句，模型会拿它当自我认知。
  { name: 'deployment:persona-prefix', order: 0, text: '你是一个在 QQ 群里跟人聊天的人，不是助手，也不是编程代理。' },
  // 「Prefer showing the primary results … Use ![Description](path) … present …」——
  // Web 文件卡片的写法，QQ 不渲染 Markdown（见硬性要求）。
  { name: 'ui:deliverable-file-references', order: 9000, text: '' },
  // 「The DeepSeek Harness implementation checkout is at …」—— 与聊天无关。
  { name: 'harness:source', order: 10000, text: '' },
  // 「You are interacting with the user through the DeepSeek Harness Web GUI at …」。
  { name: 'app:web-surface', order: 10100, text: '' },
  // 「Your working directory is …」—— 路径相对工作目录这件事渠道小节已经说过。
  { name: 'deployment:persona-suffix', order: 10200, text: '' },
];

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
 * 「上一轮那张表情没发出去」这条提醒在提示词里保留多久（毫秒）。
 *
 * 失败的原因（路径不存在 / 不在收藏目录）模型必须知道，否则它会照着自己编的路径
 * 再试一次 —— 真实事故：它写了一个 `.qq-media/<哈希>`，被拒之后下一轮又编了另一个。
 * 但这条提醒是短时效的：十轮之后还在说「上一轮」，模型会以为那是一句没做完的指令。
 */
const STICKER_FAILURE_TTL_MS = 10 * 60 * 1000;

/**
 * 长任务期间那波「迟到的消息」隔多久看一眼「它忙完了没有」（毫秒）。
 *
 * timers 只在**会话还忙**的时候存在：醒来一次，忙就再等一个短周期，不忙就把整波投出去
 * （见 `flushBatch` / `backlogShouldHold`）。一秒一次是刻意选的：投递延迟的上限就是它，
 * 而每次醒来只做一次 Map 查询；两分钟的任务也才 120 次，比给每个会话挂一堆状态便宜。
 */
const BACKLOG_POLL_MS = 1000;

/**
 * 私聊「对方正在输入」的刷新间隔（毫秒）。
 *
 * QQ 的输入状态只亮几秒，协议端不会替我们续：不补发就会在思考到一半时自己熄灭。
 * 4 秒是密度与成本的折中 —— 一次二三十秒的思考也才七八次调用；太密只是白花 API。
 */
const TYPING_REFRESH_MS = 4000;

/**
 * `set_input_status` 的超时（毫秒）。
 *
 * 故意比普通 OneBot 调用短得多：它只是一条「锦上添花」的状态，不值得在协议端不认这个
 * action 时让挂起的调用撑十几秒；失败也绝不影响后面的消息本身。
 */
const TYPING_CALL_TIMEOUT_MS = 3000;

/**
 * 一次「正在输入」最多亮多久（毫秒）。
 *
 * 正常一轮回复不会超过这个量级；它是**卡死时的保险** —— turn/end 因为任何原因没来
 * （协议断开、插件被卡住），刷新循环也不能一直每 4 秒发一次调用。到点后自己熄灭，
 * 后面真发出消息时 `sendParts` 会重新点亮。
 */
const TYPING_MAX_MS = 2 * 60 * 1000;

/**
 * 一个会话最多记住多少个「可以被 @ 的人」。
 *
 * 名单只用来把 `[[@昵称]]` 解析成 QQ 号，超过几十个人之后更早的发言者本来也早就
 * 沉到聊天记录里去了（模型 @ 的多半是刚刚跟它说话的人）。上限存在的意义是别让一个
 * 大群的长期运行把这份缓冲撑大 —— 超了就丢最早登记的那个。
 */
const PARTICIPANT_MAX = 64;

/**
 * 每个会话记住多少条「最近看见过的消息」（见 `recent` / `noteSeen`）。
 *
 * 撤回通常紧跟在消息之后：30 条大约是一两分钟的群聊量，够覆盖「刚发就撤」与
 * 「聊了几句之后回去撤」这两种真实情形，又不会把不可信文本无限期留在内存里。
 */
const RECENT_MAX = 30;

/**
 * 「最近看见过」里每条正文最多留多少字。
 *
 * 只有 `recallTeaseQuote` 打开时才可能进提示词，其余时候只给日志用；截短是为了别让
 * 一个刷屏的长消息在内存里留一整段（QQ 消息是不可信输入，能不长期留就不留）。
 */
const RECENT_TEXT_MAX = 80;

/**
 * 默认的「群友口吻」，注入系统提示的 QQ 渠道小节（人设槽的兜底）。
 *
 * **这里只写「是谁」，不写「怎么说」**：气泡数、句末句号、是非题、两拍禁令都在
 * 表达契约（`style.js` 的内置 `STYLE.md`）与硬性规则（`hardRules`）里。以前这一份里
 * 混着那几条，于是同一条规则在提示词里出现两次、改一处忘一处 —— 那次拆分就是为了这个。
 */
const DEFAULT_PERSONA = [
  '你在用 QQ 聊天：大家的消息是一条条刷出来的，你也是一条条地发；群里好几个人同时说话很正常，接不上就不接。',
  '',
  '你是个普通群友，不是客服：不用每条都热情帮忙、也不用答得滴水不漏；可以吐槽、可以接梗、可以反问、可以敷衍，也可以只回两个字。',
  '群友之间可以互损、可以跟着起哄，但玩笑是善意的，不是真嫌弃谁。',
  '口语。用平时聊天的说法，可以有「啊 / 吧 / 呢 / 嘛 / 草 / 笑死 / 6 / 啊这」这类词。',
].join('\n');

// 配置 schema 是纯数据，单独放在 config.js；这里再导出一次，Loader 与测试都从 index.js 取。
export { Config } from './config.js';


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
  // 配置的运行时视图：所有「取默认值 / 夹紧 / 去空白」都在 settings.js 里做完，
  // 下面一律读 `settings.*`，不再直接读 `config`（改默认值只需改一处）。
  //
  // `liveConfig` 是必须的一步：配置 schema 是根 volatile（见 config.js），apply()
  // 拿到的 `config` 是**引用**而不是普通对象，读字段要先 `.get()`。摊平之后的这份
  // 快照只在本次 apply 里有效 —— 设置页改配置不会重跑 apply，靠下面那个
  // `loader/volatile-update` 监听重启插件来重建。
  const settings = createSettings(liveConfig(config), process.cwd());
  const cwd = settings.cwd;
  const approvalPolicy = settings.approvalPolicy;
  // 工具白名单：去掉空白项与重复项。空数组 = 不限制，与 allowUsers / allowGroups 语义一致。
  const allowTools = settings.allowTools;
  // 会话重置指令：大小写不敏感，空串表示禁用。
  const resetCommand = settings.resetCommand;
  // 谁能重置会话：同样是「去掉空白项与重复项」，**空数组表示谁都不能**（与
  // allowUsers / allowGroups 的「空 = 不限制」相反，理由见下面的 canReset）。
  const resetUsers = settings.resetUsers;

  /**
   * 这个人可不可以重置会话。
   *
   * 语义刻意**与 allowUsers / allowGroups 相反**：白名单为空 = **谁都不能**，而不是
   * 「谁都能」。allowUsers 那种「空 = 不限制」放在准入上是合理的（不配就别用这个功能），
   * 放在重置上是危险的 —— 群消息是不可信输入，一个「空白名单等于人人可用」的默认值
   * 意味着群里任何一个人都能悄悄把会话记忆重置掉，而且默认没人会去配它。
   *
   * 比较时两边都折成字符串：OneBot 的 user_id 可能是数字，配置里写的是文本。
   * @param userId - 发消息的人（私聊是对方，群聊是发言者，不是群号）。
   * @returns 允许重置时为 true。
   */
  function canReset(userId) {
    return resetUsers.includes(String(userId ?? ''));
  }
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
    const configuredProvider = settings.provider.trim();
    const configuredModel = settings.model.trim();
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
   * 群号 → 群里的最近消息（`{ id, name, text }`，旧 → 新）。
   *
   * 只记「不是发给机器人的」那些消息：真人回话前是先看着群里在聊什么，
   * 而不是只看到 @ 自己的那一句。缓冲单独按群号存，而不是挂在会话记录上 ——
   * 没被 @ 的消息不该因此凭空造出一条会话。
   */
  const ambient = new Map();
  /**
   * 会话 key → 最近看见过的消息（`{ id, userId, name, text, at, addressed, submitted,
   * replied, recalled, action }`，旧 → 新）。
   *
   * **为什么要有这份账**：QQ 不提供「回查某条已撤回消息」的接口（`get_msg` 对撤掉的 id
   * 要么报错、要么返回空，各实现还不一致），所以「他到底撤了哪句」只能在收到消息的那一刻
   * 自己记下来 —— 撤回事件里只有一个 `message_id`。
   *
   * 与 `ambient` 同级、同样**不落盘**：重启之后撤回一条重启前的消息本来就无从谈起，
   * 而把不可信文本长期留在内存之外的地方并不是我们想额外换来的东西。
   */
  const recent = new Map();
  /**
   * 群里「谁在说话」的三本账：插话序号 / 回答指向 / 热度窗口。
   *
   * 它们判的是三件不同的事，**别合并成一张表** —— 论证与各自的语义写在 `chatter.js` 的
   * 模块注释里（那边离代码更近，也不会被这段闭包里的注释挤丢）。这里只留一句：
   * **想知道「算不算我自己说的话」，看调的是 `noteOther` 还是 `noteSelf`。**
   */
  const chatter = createChatter();
  /**
   * 群号 → 复读状态 `{ chain, queue }`（见 `maybeRepeat`）。
   *
   * - `chain` 是「最近一条还值得跟的东西」：`{ kind, key, count, senders, at, repeated }`，
   *   三种 kind 各自带自己的载荷（文字原文 / 表情包本地路径 / 系统表情 id）。
   *   中间有人说了别的，这条链就被换掉；跟过一次之后链留着但标成 `repeated`（不再跟），
   *   直到被换掉或超出 `repeatWindowMs` —— 不按群累积历史。
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
    endpoint: settings.endpoint,
    accessToken: settings.accessToken,
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
      if (connected) report('info', `connected to ${settings.endpoint}${selfId ? ` as ${selfId}` : ''}`);
      else report('info', `disconnected from ${settings.endpoint}`);
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
    dir: settings.mediaDir,
    maxBytes: settings.mediaMaxBytes,
    maxFiles: settings.mediaCacheFiles,
    timeoutMs: settings.mediaTimeoutMs,
    enabled: settings.mediaDownload,
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
  const imageSend = settings.imageSend !== false;
  const imageMaxBytes = Number.isFinite(settings.imageMaxBytes) && settings.imageMaxBytes > 0
    ? Math.floor(settings.imageMaxBytes)
    : DEFAULT_IMAGE_MAX_BYTES;
  // 表情包目录的张数上限（0 = 不限制）。归零/夹紧的口径在 settings.js，这里只读结果。
  const stickerMaxFiles = settings.stickerMaxFiles;
  const stickerRoot = settings.stickerDir.trim().length > 0 ? resolve(cwd, settings.stickerDir.trim()) : undefined;
  const stickerInside = stickerRoot !== undefined && insideDirectory(resolve(cwd), stickerRoot);
  /**
   * 表情包复读里「算同一张画面」的位差上限（0 = 只认字节完全相同）。
   *
   * 上限夹到 0.3：这个值放大到 1 就等于「任何两张图都算同一张」，那是配置事故而不是
   * 功能 —— 真想要那种效果该关掉复读的图（`repeatMedia: false`），而不是让它乱跟。
   */
  const repeatImageTolerance = Math.min(0.3, Math.max(0, Number(settings.repeatImageTolerance) || 0));
  if (stickerRoot !== undefined && !stickerInside) {
    report('warn', `stickerDir "${settings.stickerDir.trim()}" resolves outside cwd (${cwd}); the sticker pack will not be advertised`);
  }
  /** 表情包目录的展示路径（相对 cwd、正斜杠），就是模型该写进 qq_send_image 的那种写法。 */
  const stickerLabel = stickerInside ? relative(resolve(cwd), stickerRoot).split(sep).join('/') : undefined;

  // ---- 人格与表达：两个热读文件 + 一组机器参数（见 docs/persona-style.md「人格与表达」）----
  //
  // 文件放 cwd（不放 memoryDir）：`qq_memory` 的写边界永远碰不到人设 —— 群里任何人能改
  // 人设就等于一次 prompt 注入。读取是同步 + 按 mtime 缓存（提示词 provider 是同步求值的，
  // 见 docfile.js），所以改完文件不用重启。
  const personaDoc = createPersona({
    cwd,
    file: settings.personaFile,
    maxChars: settings.personaMaxChars,
    report,
  });
  const styleDoc = createStyle({
    cwd,
    file: settings.styleFile,
    maxChars: settings.styleMaxChars,
    report,
  });
  /**
   * 表达层的机器参数：提示词里渲染 + 发送时执行，两处读的是同一份。
   *
   * 这里**没有**气泡条数上限：发几条由模型按 `STYLE.md` 自己决定（见 `renderStyleContract`）。
   */
  const styleParams = {
    humanize: settings.humanize,
    stripShortPeriod: settings.stripShortPeriod,
    shortPeriodMaxChars: settings.shortPeriodMaxChars,
    // 一轮最多发几条：提示词要跟着这个数说，否则模型会写一个它照做也做不到的条数。
    maxMessages: settings.burstMaxMessages,
  };
  /**
   * 「聊天型 / 信息型」的门槛：`burstSingleMaxChars`（默认 100）。0 表示「全部按聊天型」。
   *
   * 现在只影响一件事：发送途中对方又说话了，聊天型剩下的气泡不再发（信息型整条发完）。
   * 条数本身**不设上限** —— 模型写几条发几条。
   */
  const chatMaxChars = settings.burstSingleMaxChars;

  // ---- 长期记忆：整个子系统搬去了 memory.js，这里只做装配 ----
  //
  // 目录派生、转录落盘、记忆文件的读/写、摘要的串行链与它的内存账全都搬去了 `memory.js`。
  // 这里把它需要的那几个闭包状态与 Agent 装配动作显式递过去 —— 与 `tools.js` 同一套做法：
  // 它不 import 本文件（那会成环），「记忆能碰什么」看这张依赖表就够了。
  const memory = createMemory({
    ctx,
    settings,
    cwd,
    report,
    conversations,
    sessionIndex,
    ambientQuery: ambientQueryFor,
    allowTools,
    approvalPolicy,
    resolveRoute,
    resolveAgentPreset,
    mountAgentPreset,
    restrictAgentTools,
    channelSectionOrder: CHANNEL_SECTION_ORDER,
  });

  // ---- 定时提醒（见 reminders.js 与 docs/reminders.md）--------------------------
  //
  // 任务文件放在 cwd 内（与 mediaDir / memoryDir 同一套越界校验）：它是唯一一份
  // 「机器人未来要说什么」的数据，写到 cwd 外既不好备份，也绕过了部署的边界约定。
  //
  // `pendingReminderTurns` 是 agent/prompt 那一轮的账：task id → { resolve, guard }。
  // 守卫按**任务**存而不是按会话存 —— `/reset` 会清掉这个会话的 turnOwners，那一轮的
  // turn/end 永远不会来，只有守卫能把兜底文案发出去。
  const pendingReminderTurns = new Map();
  const reminderRoot = settings.reminder && settings.reminderFile.length > 0 ? resolve(cwd, settings.reminderFile) : undefined;
  const reminderInside = reminderRoot !== undefined && insideDirectory(resolve(cwd), reminderRoot);
  if (settings.reminder && reminderRoot === undefined) {
    report('warn', 'reminderFile is empty; scheduled reminders are disabled');
  } else if (settings.reminder && !reminderInside) {
    report('warn', `reminderFile "${settings.reminderFile}" resolves outside cwd (${cwd}); scheduled reminders are disabled`);
  }
  const reminders = reminderInside
    ? createReminders({
        file: reminderRoot,
        now: () => Date.now(),
        schedule: scheduleTimer,
        report,
        deliverText: deliverReminderText,
        deliverModel: deliverReminderModel,
        runTurn: runReminderTurn,
        isBusy: (task) => busyWithTurn(targetConversation(task.type, task.targetId)),
        limits: {
          maxActive: settings.reminderMaxActive,
          dailyMax: settings.reminderDailyMax,
          graceMs: settings.reminderGraceMs,
          modeMax: settings.reminderModes,
          agentDailyMax: settings.reminderAgentDailyMax,
        },
      })
    : undefined;
  const remindersEnabled = reminders !== undefined;
  if (reminders !== undefined) {
    ctx.effect(() => {
      void mkdir(dirname(reminderRoot), { recursive: true })
        .then(() => reminders.start())
        .catch((error) => report('warn', `could not start scheduled reminders: ${errorText(error)}`));
      return () => {
        reminders.dispose();
        for (const entry of pendingReminderTurns.values()) entry.guard?.();
        pendingReminderTurns.clear();
      };
    }, 'qq-bridge:reminders');
  }

  // 设置页那一块「已记录的定时任务」要读的是**运行中的任务文件**，它不是配置项，
  // schema 里没有、也不能为了它加一个假的配置字段。于是这里挂一条只读的 Host 路由：
  // Connection 的 `/api` 自带 Host/Origin 栅栏与浏览器认证，页面（同源 fetch）拿到的
  // 就是操作员视角；数据本身走 `reminders.overview()`，只含展示字段。
  //
  // 没有 Connection 服务（headless / 没开 Web）时静默不挂 —— 那边也没有设置页。
  //
  // 必须用 `ctx.inject`（可选依赖）、**不能**在这里 `ctx.get('connection')` 一次：
  // 本插件的 `apply()` 跑在 `dsh-client-connection` 之前（实测启动日志：插件在
  // T+0s 打完整套配置，`dsh web: http://…` 在 T+2s 才出现），那一刻
  // `ctx.get('connection')` 是 undefined —— 于是路由**永远**挂不上，设置页那一块
  // 只会拿到 404（真实事故：任务确实建好了，页面上却什么都没有）。
  // `ctx.inject(['connection'], …)` 等的是「服务出现」这个事件：有了才跑回调，
  // 全程没有 Web 半侧的组合（headless）里回调压根不跑，也不影响插件激活。
  // 路由的注销由 `registerFetchRoute` 自己挂的 effect 负责（它绑在回调拿到的那个
  // 子上下文上），插件卸载时一起收掉。
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.get('connection');
    if (connection === undefined || typeof connection.fetch?.register !== 'function') return;
    connection.fetch.register({
      path: REMINDER_ROUTE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const at = Date.now();
        const body = reminders === undefined
          ? { ok: true, enabled: false, now: at, pending: 0, total: 0, tasks: [] }
          : { ok: true, enabled: true, ...(await reminders.overview(at)) };
        return new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      },
    });
  });

  // 设置页「重置对话」：与 QQ 里的 `/reset` 调同一个 `resetConversation`，只是入口换成
  // Web UI。为什么不复用 `resetUsers`：那是「群消息里谁能发这个指令」的白名单，而这条
  // 路由只在 Connection 的认证栅栏内、且只交给 owner principal（别的 principal 一律 403）
  // —— 能打开设置页的人本来就能改这份配置、重启进程，重置一个会话比那轻得多。
  //
  // 列表只读**这次进程**的 `conversations`：会话记录是内存态，重启后要等对方再发一条
  // 消息才会重新出现。这一点写在 docs/sessions.md，别让页面暗示「磁盘上所有会话」。
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.get('connection');
    if (connection === undefined || typeof connection.fetch?.register !== 'function') return;
    connection.fetch.register({
      path: SESSION_ROUTE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'GET') {
          return jsonResponse({ ok: true, now: Date.now(), conversations: webSessionSnapshots() });
        }
        let body;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ ok: false, error: 'invalid-json' }, 400);
        }
        // `{ all: true }`：设置页的「全部重置」。逐个排进各自的串行链，一个失败不拦其余。
        if (body?.all === true) {
          const reset = [];
          const failed = [];
          for (const conversation of [...conversations.values()]) {
            const key = conversation.key;
            if (await resetConversationFromWeb(conversation)) {
              reset.push({
                key,
                round: conversation.sessionGeneration ?? 0,
                sessionId: sessionIdFor(key, conversation.sessionGeneration ?? 0),
              });
            } else {
              failed.push({ key, reason: 'dispose-failed' });
            }
          }
          // 全部重置是一次批处理：请求本身成功（200），逐项结果放在 `failed` 里，
          // 页面据此显示「重置了几个、失败几个」。单条重置的失败才用 4xx/5xx。
          return jsonResponse({ ok: true, reset, failed, conversations: webSessionSnapshots() });
        }
        const key = typeof body?.key === 'string' ? body.key.trim() : '';
        if (key.length === 0) return jsonResponse({ ok: false, error: 'missing-key' }, 400);
        const conversation = conversations.get(key);
        if (conversation === undefined) {
          return jsonResponse(
            { ok: false, error: 'unknown-conversation', reset: [], failed: [{ key, reason: 'unknown-conversation' }] },
            404,
          );
        }
        if (!(await resetConversationFromWeb(conversation))) {
          return jsonResponse(
            { ok: false, error: 'dispose-failed', reset: [], failed: [{ key, reason: 'dispose-failed' }] },
            409,
          );
        }
        return jsonResponse({
          ok: true,
          reset: [{
            key,
            round: conversation.sessionGeneration ?? 0,
            sessionId: sessionIdFor(key, conversation.sessionGeneration ?? 0),
          }],
          failed: [],
          conversations: webSessionSnapshots(),
        });
      },
    });
  });

  // ---- 模型凭据：每天尝试轮换（见 docs/ops.md「每天轮换 API key」）------------------
  //
  // 为什么这件事能在这里做成：Harness 的模型调用是**每次请求**去解析凭据的
  // （llm-deepseek 的 resolveApiKey → ctx.credentials.resolve），而本地凭据层监听
  // `$DSH_HOME/.credentials.yaml`、写完就地更新内存 —— 所以把新 key 交给 credentials
  // 服务就等于当场生效，不用重启 Harness。反过来，自己去改那个 YAML 文件是不行的：
  // 里面还有浏览器会话等 records，手写一份很容易把它们弄丢，也绕过了凭据层自己的文件锁。
  //
  // 池子是 cwd 里的一个纯文本文件，而不是配置项：配置会显示在 Web UI 上、也会被复制粘贴
  // 到别处，key 不该走那条路。它同时也必须在 cwd 内（与该目录的其它约定一致）。
  const apiKeyRotateOn = settings.apiKeyRotate !== false;
  const apiKeyRefName = typeof settings.apiKeyRef === 'string' ? settings.apiKeyRef.trim() : '';
  // 凭据引用名与凭据层自身的语法一致（也是 POSIX 环境变量名）：不合法就整个停用，
  // 而不是每天写一个语法都不对的 ref 进去。
  const apiKeyRefValid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyRefName);
  const apiKeyPoolCfg = typeof settings.apiKeyFile === 'string' ? settings.apiKeyFile.trim() : '';
  const apiKeyPoolPath = apiKeyPoolCfg.length > 0 ? resolve(cwd, apiKeyPoolCfg) : undefined;
  const apiKeyPoolInside = apiKeyPoolPath !== undefined && insideDirectory(resolve(cwd), apiKeyPoolPath);
  /** 池子的展示路径（相对 cwd、正斜杠），日志与「怎么配」的提示里都用它。 */
  const apiKeyPoolLabel = apiKeyPoolInside ? relative(resolve(cwd), apiKeyPoolPath).split(sep).join('/') : apiKeyPoolCfg;
  const apiKeyRotateEnabled = apiKeyRotateOn && apiKeyRefValid && apiKeyPoolInside;
  if (apiKeyRotateOn && !apiKeyRefValid) {
    report('warn', `apiKeyRef "${apiKeyRefName}" is not a credential name (A-Za-z_ followed by A-Za-z0-9_); api key rotation is disabled`);
  } else if (apiKeyRotateOn && !apiKeyPoolInside) {
    report('warn', `apiKeyFile "${apiKeyPoolCfg}" resolves outside cwd (${cwd}); api key rotation is disabled`);
  }




  /**
   * 探测一个候选 key 现在能不能用。
   *
   * 用 GET 而不是发一次真的对话：「换 key」最怕的是从一个没额度的 key 换到另一个同样
   * 没额度的 key，所以探测必须**便宜且不消耗 token**。DeepSeek 的 OpenAI 兼容面
   * （`/models`）认 `Authorization: Bearer`，Anthropic 面认 `x-api-key` —— 两个头一起
   * 带上，同一套配置就能探两种协议（多出来的那个头会被服务端忽略）。
   *
   * 判定：2xx = 可用；429 = key 本身有效但被限流/额度用尽，对「找一个现在能用的」来说
   * 同样算不可用，但日志里要区分出来 —— 那说明池子里这个 key 该换了，而不是写错了。
   * @param key - 候选 key。
   * @returns `{ ok, detail }`：detail 是可以直接写进日志的一句话。
   */
  async function probeApiKey(key) {
    const url = settings.apiKeyProbeUrl;
    if (url.length === 0) return { ok: true, detail: 'probe disabled' };
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${key}`, 'x-api-key': key },
        signal: AbortSignal.timeout(settings.apiKeyProbeTimeoutMs),
      });
      // 响应体一律不要（`/models` 的列表又长又没用），但也不能让连接挂着不给个交代。
      if (response.body !== null) {
        try {
          await response.body.cancel();
        } catch {
          // 取不取消都不影响判定：状态码已经拿到了。
        }
      }
      if (response.ok) return { ok: true, detail: `HTTP ${response.status}` };
      return { ok: false, detail: response.status === 429 ? 'HTTP 429 (额度用尽或被限流)' : `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, detail: `probe failed: ${errorText(error)}` };
    }
  }

  /**
   * 每天到点尝试把当前凭据换成池子里的下一个 key。
   *
   * 「尝试」的含义就在这两个循环里：从**当前生效的 key 之后**开始，逐个探测池子里的候选，
   * 第一个探测通过的才写进去；全都不通过就保留原来的、只记一条 warn。这样池子里混进一个
   * 失效的 key 不会把 bot 直接换成不可用的状态，也不会因为一行坏 key 就每天卡在同一个位置。
   *
   * 状态是**算出来的**，不落盘：当前用的是哪个 key 直接问凭据层要，下一个是谁由它在池子里的
   * 位置决定。于是重启、手工改过 key、池子刚调整过顺序都不会让轮换跑偏（当前 key 不在池子里
   * 时从池首开始）。
   * @param reason - 写进日志的触发原因（例如 `daily at 04:00`）。
   */
  async function rotateApiKey(reason) {
    if (!apiKeyRotateEnabled) return;
    const text = await readTextOrUndefined(apiKeyPoolPath);
    // 「文件还没有 / 还没填 key」是**没配置**而不是故障：记 info，把「该怎么办」说清楚，
    // 别让使用者每天在 journal 里看到一条红黄的 warn 却不知道要做什么。
    if (text === undefined) {
      report('info', `api key rotation (${reason}): no key pool at ${apiKeyPoolLabel}; put one key per line there to start rotating`);
      return;
    }
    const pool = parseApiKeyPool(text);
    if (pool.length === 0) {
      report('info', `api key rotation (${reason}): key pool ${apiKeyPoolLabel} has no key yet (comments and blank lines do not count)`);
      return;
    }
    const credentials = ctx.get('credentials');
    if (credentials === undefined || typeof credentials.set !== 'function' || typeof credentials.resolve !== 'function') {
      report('warn', `api key rotation: the credentials service is not visible from this plugin, cannot switch ${apiKeyRefName}`);
      return;
    }
    // describe() 能直接回答「写进去会不会被启动环境压住」：环境变量里的 DEEPSEEK_API_KEY
    // 优先级高于凭据文件，那种部署下写文件等于白写 —— 提前说清楚，而不是每天静默地
    // 「成功」换了一个根本不生效的 key。
    if (typeof credentials.describe === 'function') {
      try {
        const info = await credentials.describe(apiKeyRefName);
        if (info?.writable === false) {
          report('warn', `api key rotation: ${apiKeyRefName} is supplied read-only by the launching environment (source ${info.source ?? 'env'}); rotating the stored value would have no effect`);
          return;
        }
      } catch (error) {
        report('warn', `api key rotation: could not inspect ${apiKeyRefName}: ${errorText(error)}`);
        return;
      }
    }
    let current = '';
    try {
      current = (await credentials.resolve(apiKeyRefName))?.value ?? '';
    } catch (error) {
      report('warn', `api key rotation: could not read the current ${apiKeyRefName}: ${errorText(error)}`);
      return;
    }
    const currentLabel = current.length > 0 ? apiKeyFingerprint(current) : '(未设置)';
    // 候选顺序：当前 key 的下一个开始，绕回池首。当前 key 不在池子里（手工填的、或者
    // 池子刚换过）时从第一个开始 —— 池子里的顺序就是轮换顺序。
    const start = current.length > 0 && pool.includes(current) ? (pool.indexOf(current) + 1) % pool.length : 0;
    const order = [];
    for (let step = 0; step < pool.length; step += 1) {
      const candidate = pool[(start + step) % pool.length];
      if (candidate !== current) order.push(candidate);
    }
    if (order.length === 0) {
      report('info', `api key rotation: ${apiKeyPoolLabel} holds no key other than the one in use (${currentLabel}); nothing to rotate`);
      return;
    }
    for (const candidate of order) {
      const probe = await probeApiKey(candidate);
      if (!probe.ok) {
        report('warn', `api key rotation: candidate ${apiKeyFingerprint(candidate)} rejected (${probe.detail}); trying the next one`);
        continue;
      }
      try {
        await credentials.set(apiKeyRefName, candidate);
      } catch (error) {
        report('warn', `api key rotation: could not store ${apiKeyRefName}: ${errorText(error)}`);
        return;
      }
      // 写回之后回读一次：凭据层的写入是异步的（落盘 + 通知），确认真的换过去了才算成功。
      const after = await credentials.resolve(apiKeyRefName).catch(() => undefined);
      if (after?.value !== candidate) {
        report('warn', `api key rotation: ${apiKeyRefName} still reads back as the old value after a write; the credentials store did not take it`);
        return;
      }
      report('info', `api key rotation: switched ${apiKeyRefName} from ${currentLabel} to ${apiKeyFingerprint(candidate)} (${probe.detail})`);
      return;
    }
    report('warn', `api key rotation: none of the ${order.length} other key(s) in ${apiKeyPoolLabel} passed the probe; keeping ${currentLabel}`);
  }

  // ---- 会话代次（`/reset` 开新一轮会话的记账）------------------------------------
  //
  // `/reset` 的语义是「新开一轮会话」而不是「删掉会话记录」：旧的 Harness Session
  // 留在磁盘上当存档，插件换一个 session id 开始新一轮。所以需要记住「这个会话已经
  // reset 过几次」—— 它决定当前这一轮用哪个 id（见 sessionIdFor）。
  //
  // 为什么要落盘：`conversations` 是运行时状态，重启就没了。如果代次只存在内存里，
  // 重启后就会算出第 0 轮的 id、把 reset **之前**那段会话 resume 回来 —— 那等于
  // `/reset` 没生效。标记文件放在会话根目录下的 `reset/`，与它标记的会话记录同处
  // 一个存储（`sessionPersistence.root` 或 `$DSH_HOME/sessions`）。
  //
  // 拿不到会话根（headless 组合、测试桩没给服务）时退回 `data/`：那也在 cwd 内，
  // 不会往进程 cwd 乱写文件，也不会污染记忆目录（记忆关掉时记忆目录可能根本不存在）。

  /** 会话 key → 已经 reset 过几次（= 当前是第几轮会话）。 */
  const conversationResetCounts = new Map();
  /** 这次启动是否已经有过一次 reset —— 有，就别再用更旧的磁盘扫描结果覆盖它。 */
  let conversationResetDirty = false;

  /** 会话代次标记所在的目录：拿不到会话根时退回 `data/`。 */
  function resetMarkerDir() {
    const service = ctx.get('sessionPersistence');
    if (typeof service?.root === 'string' && service.root.length > 0) return join(service.root, 'reset');
    return join(cwd, 'data', 'reset');
  }

  /**
   * 读回磁盘上的会话代次标记（启动时一次，之后走内存）。
   *
   * 只能**按目录扫**：标记是按会话 slug 命名的一个个小文件，没有字典索引 ——
   * 会话根目录本来就只是「一堆会话目录」，这里不去动它的结构，另建一个平铺的
   * `reset/` 子目录，一个会话一个文件，看文件名就知道是哪个会话。
   *
   * 刻意不删标记：删了就得记住「哪些已经迁移进内存」，而扫描与 reset 可能交错，
   * 交错时删除会丢代次。留着的代价只是几个几字节的小文件。
   */
  async function loadConversationResetCounts() {
    const dir = resetMarkerDir();
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return; // 没扫过任何 reset（或目录还不存在）：全部按第 0 轮算。
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(await readFile(join(dir, name), 'utf8'));
        const key = typeof parsed?.key === 'string' ? parsed.key : '';
        const count = parsed?.count;
        if (key.length === 0 || !Number.isSafeInteger(count) || count < 0) continue;
        // 这次启动已经 reset 过的会话，内存里那份更新，别被磁盘上的旧值盖回去。
        if (conversationResetDirty && conversationResetCounts.has(key)) continue;
        conversationResetCounts.set(key, count);
      } catch {
        // 单个标记坏了（写到一半被杀、手工编辑出错）就跳过它：那个会话退回第 0 轮，
        // 但不该把别的会话的代次一起丢掉 —— 每个标记是独立的，各管各的。
        report('warn', `reset marker ${name} is unreadable; that conversation falls back to the first round`);
      }
    }
  }

  /**
   * 把某个会话当前在第几轮写进标记文件（原子写）。
   *
   * 这里**等它写完**（与转录那种后台追加不同）：`/reset` 的确认是在这次写入之后才
   * 发出去的，也就是说「机器人说已经开了新一轮」与「磁盘上真的记着第 N 轮」同时成立。
   * 不等的话，确认刚发出就重启会把第 0 轮的会话 resume 回来 —— 那是最难查的一类
   * 「reset 好像没生效」。代价只是一次几字节的小文件写入。
   *
   * 写不进去（磁盘满、会话根只读）时只记一条 warn：内存里的代次已经生效，本次进程
   * 里 `/reset` 仍然是对的，只是重启后会退回第 0 轮 —— 这比让整条指令失败要好。
   * @param key - 会话 key。
   * @param count - 已经 reset 过几次。
   */
  async function writeConversationResetCount(key, count) {
    try {
      const dir = resetMarkerDir();
      await mkdir(dir, { recursive: true });
      await writeJsonAtomic(join(dir, `${memorySlug(key)}.json`), { key, count });
    } catch (error) {
      report('warn', `could not persist the session round for ${key} (a restart would rewind it): ${errorText(error)}`);
    }
  }

  /**
   * 把磁盘上的代次读进一条会话记录。
   *
   * 只在**新建会话记录**时调用（`conversationFor`）：记录一旦存在，代次就由那次
   * reset 当场更新，不需要再读盘。启动时的扫描可能还没跑完，所以这里命中了就顺手
   * 标脏，免得扫描的最后一步把它盖回旧值。
   * @param conversation - 刚建出来的会话记录。
   */
  function refreshSessionGeneration(conversation) {
    if (!conversationResetCounts.has(conversation.key)) return;
    conversation.sessionGeneration = conversationResetCounts.get(conversation.key);
    conversationResetDirty = true;
  }


  /**
   * 撤掉上一次挂上的提示变量与 QQ 渠道小节。
   *
   * 注册返回的是 Cordis effect 的 disposer。Agent 的整个作用域可能已经没了
   * （`/reset`、换 Agent 之后），那时 disposer 会抛错 —— 只记 warn，不能挡住重挂。
   * @param conversation - 归属的会话记录。
   */
  function detachChannelPrompt(conversation) {
    const effects = conversation.channelPromptEffects ?? [];
    conversation.channelPromptEffects = undefined;
    for (const effect of effects) {
      try {
        effect?.();
      } catch (error) {
        report('warn', `could not dispose the previous QQ channel prompt section: ${errorText(error)}`);
      }
    }
  }

  /** 等 `systemPrompt` 服务 active 的重试节奏（毫秒）：先立刻试，再 50ms、200ms。 */
  const PROMPT_SERVICE_RETRIES = [0, 50, 200];

  /**
   * 取 `systemPrompt` 服务，允许它在启动竞态里晚一拍出现。
   *
   * `ctx.get(name)` 是 **strict** 的：服务所属 fiber 还没 active 就返回 `undefined`。
   * Agent 的 resume 可能正好赶在那一刻（真实事故见 `attachChannelPrompt`）。多试几次
   * 比让第一轮回复带着裸提示词出去便宜得多；全失败也才 250ms。
   *
   * 只在**还没报过缺失**时等（`wait`）：组合里根本没有这个服务时（极简宿主），
   * 每条消息都白等 250ms 是不可接受的 —— 那时退回「立刻 get 一次」，服务一出现就补上。
   * @param agentCtx - Agent 自己的作用域上下文。
   * @param wait - 允不允许按 `PROMPT_SERVICE_RETRIES` 的节奏重试。
   * @returns 服务实例；不可见时 undefined。
   */
  async function channelPromptService(agentCtx, wait) {
    for (const delay of (wait ? PROMPT_SERVICE_RETRIES : [0])) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const prompt = agentCtx?.get?.('systemPrompt');
      if (prompt !== undefined) return prompt;
    }
    return undefined;
  }

  /**
   * 在 Agent 自己的作用域里挂上「QQ 渠道」提示小节（人设 / 表达契约 / 硬性规则 / 群上下文）。
   *
   * 必须**幂等、可重试**：`SystemPrompt` 只在它的 fiber active 时可见（`ctx.get` 是 strict 的），
   * 而 Agent 的 resume 可能发生在进程刚起来、服务还没 active 的那一小段。以前拿不到服务就
   * 静默 `return` —— 那个 Agent 会带着**裸系统提示词**一直跑到下次重启，人设与表达规则全丢
   * （真实事故：重启后群里的回复又变成「才没有 是你没跟上我」这种空格断句，而 STYLE.md
   * 明明写着不许；翻会话日志能看到 19:48 那条 resume 之后系统提示只剩 5.7KB 的通用部分）。
   *
   * 所以：先用 `channelPromptService` 等一小会儿；仍拿不到就只记一次 warn，并让
   * `channelPromptEffects` 保持 undefined，`ensureAgent` 下次复用这个 Agent 时再试。
   * @param conversation - 归属的会话记录（小节正文的闭包读它）。
   * @param agentCtx - Agent 自己的作用域上下文（注册点）。
   * @param agentOptions - `{{model}}` / `{{provider}}` 变量的取值。
   * @returns 这一次有没有挂上。
   */
  async function attachChannelPrompt(conversation, agentCtx, agentOptions) {
    const prompt = await channelPromptService(agentCtx, conversation.channelPromptMissing !== true);
    if (prompt === undefined) {
      if (conversation.channelPromptMissing !== true) {
        conversation.channelPromptMissing = true;
        report(
          'warn',
          `the systemPrompt service is not available while binding ${conversation.key}; the QQ channel prompt (persona / style / hard rules) is missing this round — retrying on the next message`,
        );
      }
      return false;
    }
    // 同名小节 / 变量在同一作用域里只能注册一次：先撤上一份，再按顺序挂；中途失败就把
    // 已经挂上的那几份撤掉再返回，否则变量会留成半套、下一次重挂撞 duplicate 永远好不了。
    detachChannelPrompt(conversation);
    const effects = [];
    try {
      effects.push(prompt.variable('model', () => agentOptions?.model));
      effects.push(prompt.variable('provider', () => agentOptions?.provider));
      effects.push(prompt.section({
        name: 'qq-bridge:channel',
        order: CHANNEL_SECTION_ORDER,
        interpolate: false,
        // 传函数而不是字符串：`SystemPrompt.section()` 会在每次装配时重新求值，
        // 群聊里换了发言者 / 群里又聊了几句都能立刻反映到提示词里。
        text: () => channelPrompt(conversation),
      }));
      // 再把宿主那几段「编码代理 / Web GUI / 文件卡片」按同名小节遮蔽掉（见
      // `HOST_PROMPT_SHADOWS`）：只在这个 Agent 的作用域里生效，Web UI 的会话不受影响。
      // 空字符串的小节在装配时会被丢掉，所以这里能写成「覆盖成空」。
      for (const shadow of HOST_PROMPT_SHADOWS) effects.push(prompt.section({ ...shadow }));
      conversation.channelPromptEffects = effects;
    } catch (error) {
      for (const effect of effects) {
        try {
          effect?.();
        } catch {
          // 半套注册的回滚失败只会留下一个多余 provider，不能盖住真正的原因。
        }
      }
      report('warn', `could not register the QQ channel prompt for ${conversation.key}: ${errorText(error)}`);
      return false;
    }
    if (conversation.channelPromptMissing === true) {
      report('info', `attached the QQ channel prompt for ${conversation.key} (retried after the service became available)`);
    }
    conversation.channelPromptMissing = false;
    return true;
  }

  /**
   * 取出（或创建）某个 QQ 会话所对应的 Agent。
   *
   * 查找顺序：先看 Harness 里该 session id 是否已活着（热路径，直接复用）；
   * 否则先 resume 已持久化的会话，resume 失败（首次对话）再 create 新建。
   * @param conversation - 要绑定的会话记录。
   * @returns 存活的 Agent。
   */
  async function ensureAgent(conversation) {
    const sessionId = sessionIdFor(conversation.key, conversation.sessionGeneration ?? 0);
    const live = ctx.agents.get(sessionId);
    if (live !== undefined) {
      conversation.agent = live;
      // 句柄只在「还是同一个 Agent」时保留：换了 Agent 对象说明旧句柄已经失效。
      if (conversation.handle?.agent !== live) conversation.handle = undefined;
      sessionIndex.set(live.id, conversation.key);
      // 预设也补挂一次：resume 时 agentPresets 服务可能还没 active（见 attachAgentPreset），
      // 那一轮挂上的是部署默认预设；下一条消息把它换成 qq（工具白名单 + 更低压缩门槛）。
      // 不补这一段，上下文会一路涨到默认门槛（0.8×1M）才压缩 —— 真实事故。
      if (conversation.presetMounted !== true) {
        const presetCtx = live.ctx ?? conversation.agentCtx;
        if (presetCtx !== undefined && (await attachAgentPreset(conversation, presetCtx, live, conversation.presetId))) {
          restrictAgentTools(presetCtx, live);
        }
      }
      // 热路径也要补挂一次：resume 时服务可能还没 active（见 attachChannelPrompt），那一轮
      // 的小节是缺的；下一条消息走到这里补上，不必等重启。已经挂上时不重复注册。
      if (conversation.channelPromptEffects === undefined) {
        await attachChannelPrompt(conversation, live.ctx ?? conversation.agentCtx, conversation.agentOptions ?? live.options);
      }
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
    // 重挂提示变量时要用（见 attachChannelPrompt）：热路径复用 Agent 时没有本地变量可读。
    conversation.agentOptions = agentOptions;
    // Agent 预设：Web 表面（`dsh-web-app`）把 bash / fs / web_search 这些「agent 平面」
    // 的工具从宿主搬进了每个 Agent 预设，程序化创建的 Agent 必须先 join 一个预设，
    // 这些工具才会成为它继承来的工具。预设 id 在 create 之前解析，好让 meta 一并记录。
    const presetId = await resolveAgentPreset(false);
    // 部署 persona 会用 `agent.options` 里的值替换 `{{model}}`；这里再在 Agent 自己的
    // 作用域里覆盖一次，让「早于本次模型选择就存在」的 resume 会话也能正常渲染提示词，
    // 而不会让整个 turn 失败。同时把 QQ 渠道说明作为独立小节注入系统提示。
    const setup = async (agentCtx, agent) => {
      // 留着给热路径补挂用：真宿主里 `live.ctx` 就是它，但别假定每个 Agent 实现都暴露 ctx。
      conversation.agentCtx = agentCtx;
      // 顺序不能反：先 join 预设（工具与压缩插件此刻才存在），再按白名单收窄，最后装配
      // 提示词 —— 提示词里提到的工具必须确实是这个 Agent 能看见的。
      // 预设服务此刻不可见也不抛错：留下 presetMounted === false，下一条消息补挂。
      await attachAgentPreset(conversation, agentCtx, agent, presetId);
      restrictAgentTools(agentCtx, agent);
      // 服务此刻不可见也不抛错：留下 channelPromptEffects === undefined，下一条消息补挂。
      await attachChannelPrompt(conversation, agentCtx, agentOptions);
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
  async function agentPresetService(wait) {
    // 与 `channelPromptService` 同一套路：`ctx.get()` 是 strict 的，服务所属 fiber 还没
    // active 时返回 undefined；启动后第一条 QQ 消息完全可能赶在预设平面 active 之前。
    for (const delay of (wait ? PROMPT_SERVICE_RETRIES : [0])) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const presets = ctx.get('agentPresets');
      if (presets !== undefined) return presets;
    }
    return undefined;
  }

  /**
   * 解析要挂的预设 id。
   *
   * 解析结果为 '' 表示不挂载：要么配置成 `none`，要么这个组合根本没有预设平面
   * （例如从 `dsh-base` 起的 headless 部署，工具本来就在宿主上），要么服务还没 active。
   * 第三种情况由 `attachAgentPreset` 在下一条消息上重试 —— 这条路径不能只在 setup 里
   * 走一次：重启后第一次 resume 若撞上竞态，整个 Agent 生命周期都会用部署默认预设
   * （0.8 × 1M 的压缩门槛、带 shell 的 standard），群里再聊几百轮就开始烧 token。
   * @param wait - 允不允许按 `PROMPT_SERVICE_RETRIES` 等一小会儿。
   * @returns 预设 id；不需要/暂时无法挂载时为空串。
   */
  async function resolveAgentPreset(wait = true) {
    const wanted = settings.agentPreset.trim();
    if (wanted.toLowerCase() === PRESET_NONE) return '';
    const presets = await agentPresetService(wait);
    // 没有预设平面：工具仍按老样子在宿主上，照常走白名单收窄即可。
    if (presets === undefined) return '';
    try {
      return (await presets.resolve(wanted.length > 0 ? wanted : undefined)).id;
    } catch (error) {
      // 配错预设名不能打死回复链路；但没有预设就没有 agent 平面的工具，白名单会
      // 退化成「只有 qq_*」，所以这条 warn 必须带上原因。补挂路径每条消息都会重试
      // （见 attachAgentPreset），同一条 warn 只报一次，别刷屏。
      const label = wanted.length > 0 ? wanted : '(default)';
      if (!presetResolveWarned.has(label)) {
        presetResolveWarned.add(label);
        report('warn', `could not resolve agent preset "${label}": ${error?.message ?? error}`);
      }
      return '';
    }
  }

  /** 预设名解析失败的 warn 只报一次（配错时补挂路径每条消息都会重试）。 */
  const presetResolveWarned = new Set();

  /**
   * 把某个 Agent join 到预设修订上（`agentPresets.mount()`）。
   *
   * 必须在 setup 里、用 Agent 自己的 ctx 调用：join 会把 Agent 作用域的父节点绑到
   * 预设的 standing key 上，预设里的工具随之成为 Agent **继承**来的工具，
   * `tools.restrict()` 才可能按白名单收窄它们；预设里的 `compaction` 也是同一条路挂上的
   * —— 这就是「预设没挂上 → 上下文到 220k 也不压缩」的根因（真实事故，2026-10-19）。
   * @param agentCtx - Agent 自己的作用域上下文（setup 的第一个参数）。
   * @param agent - 刚创建/恢复的 Agent（仅用于日志）。
   * @param presetId - 已解析的预设 id；空串表示不挂载。
   * @returns 有没有真的挂上（空串 / 服务不可见 / mount 失败都算 false）。
   */
  async function mountAgentPreset(agentCtx, agent, presetId) {
    if (presetId.length === 0) return false;
    const presets = await agentPresetService(false);
    if (presets === undefined) return false;
    try {
      await presets.mount(agentCtx, presetId);
      report('info', `${agent?.id ?? 'agent'} joined agent preset ${presetId}`);
      return true;
    } catch (error) {
      report('warn', `could not mount agent preset ${presetId} on ${agent?.id ?? 'agent'}: ${error?.message ?? error}`);
      return false;
    }
  }

  /** 预设补挂失败后的重试间隔：下一条消息再来，不必每轮都白试一次 mount。 */
  const PRESET_RETRY_MS = 30000;

  /**
   * 幂等、可重试地把会话的 Agent 挂到预设上。
   *
   * 为什么需要重试：`agentPresets` 服务在启动竞态里可能还不可见（`ctx.get()` strict），
   * 而 `ensureAgent` 的 setup 只跑一次。旧代码拿不到就静默跳过，那个 Agent 会一直用部署
   * 默认预设跑到下次重启 —— 表现是**上下文不再压缩**（默认门槛 0.8×1M，永远到不了）、
   * 群里几百轮后每轮都背着几百 k token，看起来就是「智力下降」；白名单还会把 standard
   * 的 shell 一起收窄，把真正的安全边界交给 allowTools 兜底。现在的约定是：setup 失败
   * 只记一次 warn，`ensureAgent` 的热路径在下一条消息上补挂。
   * @param conversation - 归属的会话记录。
   * @param agentCtx - Agent 自己的作用域上下文。
   * @param agent - 目标 Agent（日志用）。
   * @param presetId - setup 时已经解析到的 id；空串则在重试时重新解析。
   * @returns 这一次有没有挂上（或本来就不需要挂）。
   */
  async function attachAgentPreset(conversation, agentCtx, agent, presetId) {
    if (conversation.presetMounted === true) return true;
    const wanted = settings.agentPreset.trim();
    if (wanted.toLowerCase() === PRESET_NONE) {
      conversation.presetMounted = true;
      conversation.presetMissing = false;
      return true;
    }
    const now = Date.now();
    if (now < (conversation.presetRetryAt ?? 0)) return false;
    let chosen = typeof presetId === 'string' ? presetId : '';
    if (chosen.length === 0) chosen = await resolveAgentPreset(false);
    if (chosen.length === 0) {
      if (conversation.presetMissing !== true) {
        conversation.presetMissing = true;
        report(
          'warn',
          `the agent preset for ${conversation.key} is not available yet; the QQ agent preset (tools + compaction) is missing this round — retrying on the next message`,
        );
      }
      // 服务还没出现：**下一条消息立刻再试**（只多一次 `ctx.get`，很便宜）。这里不
      // 退避 30s —— 启动竞态通常只差几十毫秒，退避会把「补挂」推到半分钟后。
      conversation.presetRetryAt = 0;
      return false;
    }
    const mounted = await mountAgentPreset(agentCtx, agent, chosen);
    if (!mounted) {
      if (conversation.presetMissing !== true) {
        conversation.presetMissing = true;
        report('warn', `the agent preset ${chosen} is not mounted for ${conversation.key}; retrying on the next message`);
      }
      conversation.presetRetryAt = now + PRESET_RETRY_MS;
      return false;
    }
    conversation.presetMounted = true;
    conversation.presetId = chosen;
    conversation.presetRetryAt = 0;
    if (conversation.presetMissing === true) {
      report('info', `attached the agent preset ${chosen} for ${conversation.key} (retried after the service became available)`);
    }
    conversation.presetMissing = false;
    return true;
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
   * 把群里最近几条闲聊拼成一段检索查询（长期记忆的 `ambientQuery` 依赖）。
   *
   * 主动说话 / 补一句 / 提醒这些轮次没有「刚来的那条消息」，检索必须靠群环境；
   * 条数刻意比 `ambientPrompt` 少（只取最后几条），够定位话题就行，不必整段。
   * @param conversation - 目标会话。
   * @returns 多行文本；私聊或没有环境上下文时为空串。
   */
  function ambientQueryFor(conversation) {
    if (conversation?.type !== 'group') return '';
    const list = ambient.get(conversation.id) ?? [];
    return list.slice(-6).map((entry) => `${entry.name}: ${entry.text}`).join('\n');
  }

  /**
   * 没有「刚来的那条消息」的轮次（主动说话 / 补一句 / 提醒 / 戳一戳）用群环境做检索查询。
   *
   * 取不到群环境（私聊、或者群里很安静）时**不清空**原有的查询：上一句话题仍然比
   * 「什么都不给」更能捞出相关记忆。
   * @param conversation - 目标会话。
   */
  function noteRecallFallback(conversation) {
    const text = ambientQueryFor(conversation);
    if (text.length === 0) return;
    conversation.recallQuery = { text, at: Date.now(), speakers: conversation.speakers ?? [] };
  }

  /**
   * 「现在是谁在跟你说话」那一行。
   *
   * 只有一个人时就是原来那句；几个人几乎同时说话（一批攒到一起）时把人都列出来 ——
   * 只报最后一个会让模型以为只有那一个人在问，回出来就是漏人的客服式答复。
   *
   * **刻意不印 QQ 号**：印出来模型就会照着念（「@100000003 你来说」），而群里大家认的是
   * 昵称。想 @ 谁写 `[[@昵称]]` 就行了（见 `mention.js`），名字必须与这里逐字一致。
   * @param conversation - 目标会话。
   * @returns 一行提示词。
   */
  function speakerLine(conversation) {
    // 到点提醒那一轮没有「刚跟你说话的人」：用普通那句会写成上一位发言人，
    // 模型很容易回一句「怎么了」，而不是把该提醒的事说出来。
    if (conversation.pendingIntent === 'reminder') {
      return '这条不是谁发给你的，是你自己到点要提醒的事。';
    }
    // 主动搭话 / 补一句 / 撤回调侃都不是「有人在跟你说话」：说成「刚跟你说话的人」
    // 会让模型把它当成一次新的提问，回一句「怎么了」。
    if (conversation.pendingIntent === 'proactive' || conversation.pendingIntent === 'chime') {
      return '这一轮没有人在叫你，是你自己想开口 —— 别把它当成谁在问你。';
    }
    if (conversation.pendingIntent === 'recall') {
      return '这一轮是插件在提醒你：刚才有人说的话被撤回了。';
    }
    const speakers = conversation.speakers ?? [];
    if (conversation.pendingIntent === 'interject') {
      // 插话轮：这句不是冲它来的。元信息已经写在 user message 里了，这里只说清场景，
      // 不能再用「刚跟你说话的人」——那正是「莫名其妙」的来源（§2.2）。
      return '群里在聊天，下面那句不是叫你的；你只是刚好想接一句，接就一条（接不住就不接）。';
    }
    if (conversation.pendingIntent === 'backlog') {
      // 积压的一波：那些话不是「现在」说的，是它在忙别的事的时候陆续到的。
      // 说成「刚跟你说话的人」会让模型把它们当成同一拍发生的（正文里有相对时间）。
      return '你刚才在忙别的事，下面这些是那期间陆续到的消息；挑还活着的接，不用逐条回。';
    }
    if (speakers.length > 1) {
      const list = speakers.map((speaker) => speaker.name).join('、');
      return `几乎同时在跟你说话的是：${list} —— 他们的话是一起到的，按聊天的节奏挑着接。`;
    }
    if (conversation.pendingIntent === 'continued') {
      return `刚才跟你说话的人又接了一句：${conversation.senderName}。`;
    }
    return `刚跟你说话的人：${conversation.senderName}。`;
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
   * 把「一个表情包文件名」补成真路径（裸名字、以及写错扩展名的目录路径）。
   *
   * 模型很可能不写全 `.qq-stickers/笑死.png` 而只写 `笑死` / `笑死.png`，也可能把扩展名
   * 猜错（目录里 .jpg 比 .gif 多，真实事故：`敲盆.gif` 被写成 `敲盆.jpg`）。这两种都会让
   * `loadOutgoingImage` 按 cwd 相对路径去找时落空、只能回一句「表情包没发出去」。所以：
   * 裸文件名先在表情包目录里找（精确 → 忽略扩展名）；带 `stickerLabel/` 前缀的路径如果是
   * 已知文件名写错了扩展名，也换回真实的那一个。
   *
   * 只碰**收藏目录里的文件名**：`.qq-media/xxx.jpg`、URL 之类的写法原样交出去，绝不改写。
   *
   * @param source - 标记或工具参数里给的来源。
   * @returns 能认出来就是相对 cwd 的路径，否则原样返回。
   */
  function resolveStickerSource(source) {
    const raw = String(source ?? '').trim();
    if (raw.length === 0 || stickerLabel === undefined) return raw;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
    if (raw.startsWith(`${stickerLabel}/`)) {
      const name = raw.slice(stickerLabel.length + 1);
      // 收藏目录只有一层：带子目录的写法不猜，交给发送侧照常报错。
      if (name.length === 0 || /[/\\]/.test(name)) return raw;
      const repaired = findStickerByName(name);
      return repaired === undefined ? raw : `${stickerLabel}/${repaired}`;
    }
    if (/[/\\]/.test(raw)) return raw;
    const repaired = findStickerByName(raw);
    return repaired === undefined ? raw : `${stickerLabel}/${repaired}`;
  }

  /**
   * 在表情包目录里按名字找文件：先精确匹配，再忽略扩展名匹配。
   *
   * 同名不同扩展名的文件可能同时存在（`.gif` 和 `.jpg`），排序后取第一个，保证同样的输入
   * 永远得到同一个结果 —— 别让「发哪张」随 readdir 的顺序漂移。
   *
   * @param name - 文件名（可带扩展名，也可只有名字）。
   * @returns 目录里真实存在的文件名；认不出来时 undefined。
   */
  function findStickerByName(name) {
    const files = stickerFiles().sort();
    const exact = files.find((file) => file === name);
    if (exact !== undefined) return exact;
    const stem = name.replace(/\.[^.]+$/, '');
    return files.find((file) => file.replace(/\.[^.]+$/, '') === stem);
  }

  /**
   * 发表情时**只认收藏目录里的文件**（`[[图片: …]]` 这一条路）。
   *
   * 三条理由，都对应真实事故或明确的设计边界：
   *   1. `.qq-media/<内容哈希>` 是入站图的 LRU 缓存（默认 200 张），迟早被淘汰。模型把
   *      它写进正文时，**当时看着像真的**、发的时候早没了，用户收到的是一句「没发出去」
   *      —— 它还会接着编下一个哈希（真发生过）。
   *   2. 任意 cwd 路径（`README.md`、别人的截图、`/etc/...`）不该借「发表情」发出去：
   *      QQ 消息是不可信输入，模型可能被群里的人指使去发本地文件。
   *   3. 想发「别人刚发的那张」有正当入口：先 `qq_save_sticker` 收藏（带名字与含义），
   *      它才进得了这个目录 —— 这同时也让那张图以后还能再被选中。
   *
   * 裸文件名先按 `resolveStickerSource` 补全（模型常写 `笑死` 而不是全路径）。
   * @param source - 标记里给的来源。
   * @returns 收藏目录内的绝对路径。
   * @throws 目录不可用 / 不在收藏目录 / 文件不存在时抛错（message 是给人看的一句话）。
   */
  function stickerSendSource(source) {
    const raw = resolveStickerSource(source);
    if (stickerRoot === undefined || !stickerInside || stickerLabel === undefined) {
      throw new Error(`stickerDir is not usable (${settings.stickerDir.trim() || '(empty)'}): it must be a directory inside ${cwd}`);
    }
    const target = resolve(cwd, raw);
    if (!insideDirectory(stickerRoot, target)) {
      throw new Error(`${stickerLabel}/ 里没有「${raw}」：表情包只能从收藏目录里发（别人刚发的图要先 qq_save_sticker 存下来）`);
    }
    return target;
  }

  /**
   * 这个来源是不是收藏目录里的表情包 —— 决定出站 image 段带不带 `sub_type: 1`
   * （见 `imageSegment` 的注释）。
   *
   * 只认「能确定落在 stickerRoot 里的本地路径」，宁可不标也不乱标：
   *   - URL / `file://` 一律按普通图片发（远端是什么无从判断）；
   *   - `.qq-media/<哈希>` 这类缓存图照旧发成普通图片（它可能是截图或照片）；
   *   - 裸文件名先按 `resolveStickerSource` 补成 `.qq-stickers/笑死.gif` 再判。
   *
   * @param source - 标记或工具参数里的来源。
   * @returns 确认是收藏目录里的文件时 true。
   */
  function isStickerFile(source) {
    if (stickerRoot === undefined || !stickerInside) return false;
    const raw = resolveStickerSource(source);
    // 只挡「带协议的来源」。别写成 `/^[a-z][a-z0-9+.-]*:/`：那会把 Windows 的 `C:\…`
    // 当成协议名（收藏目录就在 C 盘时，绝对路径的表情会被误判成普通图片）。
    if (raw.length === 0 || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^file:/i.test(raw)) return false;
    return insideDirectory(stickerRoot, resolve(cwd, raw));
  }

  /** 记下「这一轮想发的图没发出去」，给下一轮提示词用（见 `channelPrompt`）。 */
  function noteStickerFailure(conversation, source, reason) {
    conversation.stickerFailure = { path: String(source ?? '').slice(0, 120), reason: String(reason ?? '').slice(0, 160), at: Date.now() };
  }

  /**
   * 把「一张图」固化进表情包目录：`qq_save_sticker` 的全部实现。
   *
   * 为什么需要它（实测缺口）：QQ 会话按设计没有 write / edit / bash —— 那三样在不可信
   * 输入面上太危险 —— 于是群里那句最自然的「存一下这个表情」模型**永远做不到**。真实
   * 发生过的样子是：它 `read_image` 看完、`glob .qq-stickers/**` 发现是空的，只能把含义
   * 追加进 `COGNITION.md`，key 还是 `.qq-media/<内容哈希>` 这个 LRU 缓存路径，然后回一句
   * 「存好了」。那条记忆迟早指向一个被淘汰掉的文件，群里收到的就是「（表情包没发出去）」。
   *
   * 所以这里开一条**窄**通道，把边界全部收在函数里：
   *   - 只写 `stickerRoot` 之内，文件名由纯函数 `stickerFileName` 洗成单层名字；
   *   - 字节先过 `loadOutgoingImage`（魔数判格式 + 大小上限 + 必须在 cwd 内），
   *     所以「`.txt` 改名成 `.png`」和越界路径都进不来；
   *   - 张数到 `stickerMaxFiles` 就拒绝 —— 群里谁都能让它一直存，磁盘不该被这么撑大；
   *   - 同名**不覆盖**：覆盖等于让群里任何一个人用一句「存一下」把现有表情换掉。
   *
   * 存完之后还会往 `STICKERS.md` 补一行「名字｜画面｜含义｜场景｜路径｜日期｜置信」：
   * 不写这一行的话，下一次提示词里它又只是一串文件名，模型还得 `read_image` 猜含义。
   * 目录写失败**不回滚图片**（图已经落盘，缺一行目录比丢图好）—— 只记一条 warn。
   *
   * @param options.source - 图片来源（`.qq-media/…` 相对路径 / cwd 内绝对路径 / http(s) 链接）。
   * @param options.name - 模型起的中文名（可带扩展名，最终以真实格式为准）。
   * @param options.meaning - 一句话含义（可空；空则写进「未收藏」待办区）。
   * @param options.scene - 适用场景（可空）。
   * @returns `{ path, bytes, format, source, catalog? }`：`catalog` 是目录那一行的结果说明。
   */
  async function saveSticker({ source, name, meaning, scene } = {}) {
    if (stickerRoot === undefined || !stickerInside || stickerLabel === undefined) {
      throw new Error(`the sticker directory is not usable (${settings.stickerDir.trim() || '(empty)'}): it must be a directory inside ${cwd}`);
    }
    const existing = stickerFiles();
    if (stickerMaxFiles > 0 && existing.length >= stickerMaxFiles) {
      throw new Error(`the sticker directory already holds ${existing.length} images (stickerMaxFiles: ${stickerMaxFiles}); ask the operator to clean it up or raise the limit`);
    }
    // 先取字节、先校验，再动目录：失败时不会在表情包目录里留下半个文件。
    const image = await loadOutgoingImage({ source, cwd, maxBytes: imageMaxBytes });
    const fileName = stickerFileName(name, image.format);
    if (fileName === undefined) {
      throw new Error(`"${String(name ?? '').slice(0, 40)}" is not a usable sticker name: pass a short file name such as "委屈" (the extension comes from the image itself)`);
    }
    // `existing` 只列认得出来的图片；再多一次 stat 是为了挡住「同名但扩展名不同 / 是个目录」
    // 这类列不出来的占位，免得 rename 覆盖掉用户自己放的东西。
    const target = join(stickerRoot, fileName);
    const occupied = existing.includes(fileName) || (await stat(target).catch(() => undefined)) !== undefined;
    if (occupied) {
      throw new Error(`${stickerLabel}/${fileName} already exists: pick another name (or read that sticker first and ask the operator if it should be replaced)`);
    }
    await mkdir(stickerRoot, { recursive: true });
    await writeBytesAtomic(target, image.bytes);
    const path = `${stickerLabel}/${fileName}`;
    report('info', `sticker saved: ${path} (${image.bytes.length} bytes, from ${image.label})`);
    // 目录那一步是**尽力而为**：图片已经存好了，不能让一次目录写入失败把「存表情」变成失败。
    let catalog;
    if (memory.enabled) {
      try {
        const written = await memory.appendSticker({
          name: fileName.replace(/\.[^.]+$/, ''),
          meaning: String(meaning ?? '').trim(),
          scene: String(scene ?? '').trim(),
          path,
          date: localDate(),
        });
        if (written.ok) {
          catalog = `added to ${memory.label}/STICKERS.md (${written.section})`;
        } else {
          catalog = `not written to STICKERS.md: ${written.reason}`;
          report('warn', `could not add ${path} to the sticker catalogue: ${written.reason}`);
        }
      } catch (error) {
        catalog = `not written to STICKERS.md: ${errorText(error)}`;
        report('warn', `could not add ${path} to the sticker catalogue: ${errorText(error)}`);
      }
    }
    return { path, bytes: image.bytes.length, format: image.format, source: image.label, catalog };
  }

  /**
   * 给一张已收藏的表情**改名**：`qq_rename_sticker` 的全部实现。
   *
   * 为什么需要它（真实事故，就是它促成了这个工具）：模型想改一张表情的名字 / 含义时，
   * 手上只有「用新名字再存一遍」这一条路 —— 于是 `.qq-stickers/` 里多出一张**同画面、
   * 不同名**的图，`STICKERS.md` 里旧名字那条还留着，以后两张都会被挑中，删除又做不到。
   * 改名必须是「同一个文件换个名字，目录里那一条跟着搬」，不是「再存一张」。
   *
   * 边界（与 `saveSticker` 同一套路，只是方向反过来）：
   *   - 只认 `stickerRoot` 里**已经存在**的那张（`findStickerByName` 的解析规则与发表情一致：
   *     裸名字、写错扩展名都找得回来）；
   *   - 新名字走同一个纯函数 `stickerFileName` 清洗，扩展名**沿用旧文件的真格式**（不重新嗅：
   *     这里没有新字节，换扩展名只会让「名字写着 .png、里面是 GIF」）；
   *   - 目标名已被占用就拒绝 —— 与「同名不覆盖」同一条理由，别让群里任何一个人一句
   *     「改个名」把别人的表情挤掉；
   *   - 目录那一步失败时**把文件改回去**：改名的价值就在于「文件与目录一致」，只改一半
   *     比不改更糟（目录指着一个不存在的路径，发出去就是「表情包没发出去」）。
   *
   * @param options.from - 现在的名字（文件名，可带扩展名）。
   * @param options.to - 想改成的新名字（扩展名由旧文件决定）。
   * @param options.meaning - 可选：顺手改含义（不给就沿用目录里原来的）。
   * @param options.scene - 可选：顺手改适用场景。
   * @param options.look - 可选：顺手改画面描述。
   * @returns `{ path, previous, bytes, renamed, catalog? }`：`catalog` 是目录那一步的结果说明。
   */
  async function renameSticker({ from, to, meaning, scene, look } = {}) {
    if (stickerRoot === undefined || !stickerInside || stickerLabel === undefined) {
      throw new Error(`the sticker directory is not usable (${settings.stickerDir.trim() || '(empty)'}): it must be a directory inside ${cwd}`);
    }
    const wanted = String(from ?? '').trim();
    const found = findStickerByName(wanted);
    if (found === undefined) {
      const names = stickerFiles().sort().slice(0, 20);
      throw new Error(
        `${stickerLabel}/ 里没有「${wanted}」：只能给已经收藏的表情改名${names.length > 0 ? `（现有：${names.join('、')}）` : '（目录是空的，先 qq_save_sticker 收藏）'}`,
      );
    }
    const extension = found.replace(/^.*\./, '').toLowerCase();
    const target = stickerFileName(to, extension);
    if (target === undefined) {
      throw new Error(`"${String(to ?? '').slice(0, 40)}" is not a usable sticker name: pass a short file name such as "委屈" (the extension stays "${extension}")`);
    }
    const previous = `${stickerLabel}/${found}`;
    const path = `${stickerLabel}/${target}`;
    if (target === found) {
      // 名字没变：不算错，也不搬文件（只把现有大小回显出来）。
      const size = (await stat(join(stickerRoot, found)).catch(() => undefined))?.size;
      return { path, previous, bytes: size, renamed: false };
    }
    // 先查占用再改名：`existing` 只列认得出来的图片，多一次 stat 挡住隐藏文件 / 目录。
    const targetPath = join(stickerRoot, target);
    const sourcePath = join(stickerRoot, found);
    if ((await stat(targetPath).catch(() => undefined)) !== undefined) {
      throw new Error(`${path} already exists: pick another name`);
    }
    const size = (await stat(sourcePath)).size;
    await rename(sourcePath, targetPath);
    let catalog;
    if (memory.enabled) {
      let written;
      try {
        written = await memory.renameSticker({
          from: found.replace(/\.[^.]+$/, ''),
          to: target.replace(/\.[^.]+$/, ''),
          path,
          meaning: String(meaning ?? '').trim() || undefined,
          scene: String(scene ?? '').trim() || undefined,
          look: String(look ?? '').trim() || undefined,
        });
      } catch (error) {
        // 目录写失败就把文件改回去：只改一半的改名，比不改更糟（见函数头）。
        await rename(targetPath, sourcePath).catch(() => {});
        throw error instanceof Error ? error : new Error(errorText(error));
      }
      if (!written.ok) {
        await rename(targetPath, sourcePath).catch(() => {});
        throw new Error(`could not update STICKERS.md: ${written.reason}`);
      }
      catalog = `updated ${memory.label}/STICKERS.md (${written.section})`;
    }
    report('info', `sticker renamed: ${previous} → ${path} (${size} bytes)`);
    return { path, previous, bytes: size, renamed: true, catalog };
  }

  /**
   * 「这一轮」的动态情境：每轮都会变，所以**不能**放进系统提示。
   *
   * 为什么不能（真实事故，2026-10-19）：`systemPrompt.section()` 的 text provider 每次
   * 装配都会重新求值，而这些内容每轮都不同（现在几点、谁在说话、群里刚聊了什么、检索到
   * 哪几条记忆、这一轮是不是主动搭话）。DeepSeek 路由声明了 `systemPromptUpdate:
   * 'in-history'`，DSH 为了不打断前缀缓存，会把**变化后的整段系统提示**作为一条新的
   * system 消息追加到会话里，而不是替换旧的。于是每一轮上下文都多出整整一份人设 / 表达
   * 契约 / 硬性规则（约 9k token），十几轮就把上下文塞到 220k，紧接着是不间断的压缩、
   * 失忆和「变笨」。把动态部分挂到 user message 的第二个 text block 上，每轮只追加这一
   * 小节，系统提示保持稳定（只在人设 / 表达 / 表情目录 / 配置真的改了时才变一次）。
   *
   * @param conversation - 目标会话。
   * @returns 动态情境正文；没有可写的内容时返回空串。
   */
  function channelTurnContext(conversation) {
    const isGroup = conversation.type === 'group';
    const lines = [];
    // 人设里的场景段（### 群聊 / 主动搭话 / 被戳一戳）随这一轮的 intent 换；基础人设
    // （身份 / 背景 / 性格）留在系统提示里，不跟它一起变。
    const scene = personaSceneFor(conversation);
    const parsed = personaDoc.read();
    const sceneLines = settings.personaSceneOverlays === true ? (parsed?.profile?.scenes?.[scene] ?? []) : [];
    if (sceneLines.length > 0) {
      const title = { private: '私聊', group: '群聊', proactive: '主动搭话', poke: '被戳一戳' }[scene] ?? '当前场景';
      lines.push(`【本轮场景｜${title}】${sceneLines.map((line) => String(line).replace(/[。.]\s*$/, '')).join('；')}`);
    }
    lines.push(speakerLine(conversation));
    if (isGroup) {
      const ambientLines = ambientPrompt(conversation);
      if (ambientLines.length > 0) lines.push('', ...ambientLines);
    }
    // 上一轮那张图为什么没发出去：不给原因的话，模型下一轮会照着自己编的路径再试一次
    // （真实事故：`.qq-media/<哈希>` 连编两轮，用户连收两遍「没发出去」）。
    const failedSticker = conversation.stickerFailure;
    if (failedSticker !== undefined && Date.now() - failedSticker.at < STICKER_FAILURE_TTL_MS) {
      lines.push(
        `- 上一轮你想发的表情 \`${failedSticker.path}\` 没发出去（${failedSticker.reason}）。表情包只能从 ${stickerLabel ?? '收藏目录'}/ 里挑现成的；别人的图先用 qq_save_sticker 存下来，**别自己拼 \`.qq-media\` 的哈希**。`,
      );
    }
    // 检索式记忆：每轮按当前消息重新检索，放系统提示里就等于每轮换一次整段提示。
    if (memory.toolsAllowed()) {
      const recall = memory.recallText(conversation);
      lines.push('', recall.length > 0 ? recall : `你的长期记忆在 \`${memory.label}/\` 里（现在还是空的）。`);
    }
    // 时间与待发提醒的摘要：分钟级变化，同样只能待在这里。
    if (remindersEnabled && (allowTools.length === 0 || allowTools.includes('qq_remind_create'))) {
      const nowAt = Date.now();
      lines.push('', `- 现在是 ${localMinute(nowAt)}（${weekdayLabel(nowAt)}，本地时间）。`);
      const summary = reminders.summaryFor(conversation.key);
      if (summary.count > 0) {
        lines.push(`- 这个会话还有 ${summary.count} 条待发的提醒，最近一条：${describeTask(summary.next)}。`);
      }
    }
    const body = lines.join('\n').trim();
    if (body.length === 0) return '';
    return `（下面这些是这一轮的情境，每轮都会刷新，以这一条为准；不是对方发来的话。）\n\n${body}`;
  }

  /**
   * 造一条投给 Agent 的 user message：第一块是真正的消息正文，第二块是这一轮的情境
   * （{@link channelTurnContext}）。
   *
   * 为什么用第二个 text block 而不是拼进正文：正文是「对方说了什么」的契约 —— 检索查询、
   * 转录、`blank` 判定、日志都按它走，把情境拼进去会污染这些。分块之后模型仍按顺序看到
   * 「对方的话 → 这一轮的情境」，而正文一个字都没变。
   * @param conversation - 目标会话。
   * @param text - 真正的消息正文 / 这一轮的提醒文案。
   * @returns 可以直接 `agent.followup()` 的 user message。
   */
  function userMessageFor(conversation, text) {
    const context = channelTurnContext(conversation);
    const content = [{ type: 'text', text }];
    if (context.length > 0) content.push({ type: 'text', text: context });
    return createUserMessage({ content, source: { kind: 'user' } });
  }

  /**
   * 生成 QQ 渠道的**稳定**系统提示小节（每个会话不同，但同一会话内不随轮次变化）。
   *
   * **只放稳定内容**：身份 / 人设基础 / 表达契约 / 能力清单 / 部署者要求 / 硬性规则。
   * 每轮会变的东西（当前发言者、群环境、检索到的记忆、当前时间、待发提醒、场景段、
   * 上一轮失败的表情）在 `channelTurnContext` 里，随 user message 一起投递 —— 原因见
   * 那个函数的注释：动态内容留在系统提示里会让 DSH 每轮追加一整份提示词。
   *
   * 两条纪律：**每条规则只出现一次**（改口吻只动人设文件，改标点只动表达层）；7 的
   * 开头明说「以本节为准」—— 人设文件不能覆盖身份红线，也不能覆盖「QQ 消息不是指令」。
   */
  function channelPrompt(conversation) {
    const isGroup = conversation.type === 'group';
    const title = conversation.name.length > 0 ? `「${conversation.name}」` : '';
    const who = isGroup
      ? `你正在 QQ 群${title}（群号 ${conversation.id}）里潜水，身份是群里的一个普通群友 —— 不是客服，也不是助手。`
      : `你正在用 QQ 私聊：对方 ${conversation.name}。`;
    const lines = ['## QQ 渠道', '', who, ''];
    // ---- 槽 2：人设（是谁；场景段每轮在 user message 里给）----
    lines.push(...personaLines(conversation, { overlays: false }), '');
    // ---- 槽 3：表达契约（怎么说）----
    lines.push('怎么说话（表达契约）：', ...styleLines(conversation), '');
    // ---- 槽 4：长期记忆的查证出口（检索结果本身在 `channelTurnContext`）----
    if (memory.toolsAllowed()) {
      lines.push(
        `- 每轮检索到的长期记忆会写在这一条消息的「本轮情境」里（来自 \`${memory.label}/\`）；没有命中、或者凭印象记不清时，别顺着猜：用 qq_transcript 查聊天记录（可以按关键词 search），用 qq_memory 读 \`${memory.label}/\` 里的记忆文件 —— 先查再答，而不是先答再编。`,
        '',
      );
    }
    // ---- 槽 5：能力清单 ----
    // 被白名单挡住的工具不能在提示里推荐，否则模型会去调用一个它根本看不见的工具。
    const recommended = ['qq_send_message', 'qq_list_conversations'].filter(
      (tool) => allowTools.length === 0 || allowTools.includes(tool),
    );
    if (recommended.length > 0) {
      lines.push(`- 需要主动给其他人或群发消息、或查询联系人时，使用 ${recommended.join(' / ')} 工具。`);
    }
    // 定时提醒：模型必须知道「答应下来的事必须真的落成任务」，而不是只在回复里说
    // 「好的我记住了」—— 它只在这一轮醒着，到点叫醒它的是插件，不是它自己的记忆。
    //
    // 时间被理解错一天是真实事故：凌晨 02:12 一句「明天中午提醒我拿快递」，模型按日历
    // 排到了次日中午，而对方想的是睡醒后的那个中午；回复里又只写「明天中午」，偏差一直
    // 到点才被发现。所以这里要求回复写**绝对日期**，并对凌晨的「明天 / 今天」单独给一条。
    // 「现在几点」与待发提醒的摘要每分钟都在变，放在 `channelTurnContext` 里。
    if (remindersEnabled && (allowTools.length === 0 || allowTools.includes('qq_remind_create'))) {
      lines.push(
        '- 要提醒谁在某个时刻做什么，必须调用 qq_remind_create；不要只在回复里答应 —— 到点叫醒你的是插件，不是你自己的记忆。',
        '- 建完在回复里**写出绝对日期和时刻**（如「10 月 19 日 周一 12:00」），不要只说「明天中午」「等下」—— 写清日期，对方才能一眼看出「明天」有没有被理解成另一天。没建成要把原因说出来，别假装建好了。提醒的正文会原样发出，不会把图片或 @ 标记解析成真的图 / at 段，把要做什么写清楚。',
        '- 凌晨（大致 00:00–06:00）对方说「明天 / 今天几点」时，**日历上的明天**与**睡醒后的那个白天**都说得通：先问一句「是今天（几月几日）还是明天」；不问就按最近的那个未来时刻排。对方纠正后，用新时间重建一条，并取消旧的那条。',
      );
    }
    if (memory.toolsAllowed()) {
      const canSkill = allowTools.length === 0 || allowTools.includes('skill');
      lines.push(
        `- 真遇到值得长期记住的事（某人的偏好、群里的约定、一件发生过的事），用 qq_memory 追加到 \`conversations/<会话目录>/MEMORY.md\`；不要为了记而记，一两句就够。`,
        canSkill
          ? `- 遇到看不懂的梗、黑话或表情包（图里写了什么、为什么大家都在笑）先分诊：**只有文字**的说法加载 \`learn-meme\` skill 写进 \`COGNITION.md\`；**有图**的表情包加载 \`learn-sticker\` skill${stickerSaveAllowed() ? '（先用 qq_save_sticker 收藏再写 `STICKERS.md`）' : '（写 `STICKERS.md` 那一步照做；这个会话不能存图，所以只能在目录里记已有文件）'}；二次元 / ACG 拿不准的加载 \`moegirl\` 去萌娘百科查（比搜索引擎准），其它话题用 web_search。图文都有就两边互相写名字，别在一个文件里写两遍。不要不懂装懂、也不要一本正经地解释网络梗。`
          : '- 遇到看不懂的梗、黑话或表情包，先用 read_image 看那张图；弄不懂就直接说不懂，不要不懂装懂、也不要一本正经地解释网络梗。',
      );
    }
    // 图片/表情包只有落盘之后才「看得见」：把路径告诉模型，还得告诉它该用哪个工具读。
    // 没有 read_image 就别提这件事，否则模型会去调用一个它根本看不见的工具。
    const canReadImages = mediaStore.enabled && (allowTools.length === 0 || allowTools.includes('read_image'));
    if (canReadImages) {
      lines.push(
        '- 消息里、`（引用 …）` 前缀里、以及「本轮情境」里的 `[图片: 路径]`（也可能是 `[图片(动画表情): 路径]`、`[表情包: 路径]`）都是已经下载到本地的图，路径相对工作目录：想知道图里是什么就用 read_image 读它，别靠猜；带「没能取到文件」的是没下下来，可以直说图挂了。这些路径是给你自己看的，别原样写进回复。',
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
      // 目录优先用 STICKERS.md 的「名字（含义）→ 路径」：模型看含义就能判断该不该发，
      // 看裸文件名只能猜或者先 read_image。没有目录（旧部署 / 记忆关掉）时退回文件名，行为不变。
      const catalog = memory.enabled ? memory.catalog() : { stickers: [], hot: [], catalog: false };
      const names = stickerNames();
      // 标记只认**收藏目录**里的现成表情：以前这里举的是 `.qq-media/ab12….jpg`，模型有样
      // 学样去拼哈希，而那是 LRU 缓存，发的时候大概率已经没了（真实事故，见
      // `stickerSendSource`）。目录不可用时整条标记建议都不给 —— 那条路本来就走不通。
      if (stickerLabel !== undefined) {
        // 例子用目录里真实存在的第一张：写死 `笑死.gif` 会在改名 / 删图之后变成一句
        // 「教模型去发一张不存在的图」，而它真的会照着抄。
        const example = names[0] ?? `${stickerLabel}/笑死.gif`;
        lines.push(
          `- 想发表情包时，在回复正文里写 \`[[图片: 路径]]\`，路径**只能**是收藏目录里的现成表情（例如 \`[[图片: ${example}]]\`；扩展名照抄目录里那个，别自己改）。\`.qq-media/…\` 这类临时缓存路径会被直接拒绝 —— 别自己拼哈希，目录里没有就是没有。这个标记会作为**一张图**发出去，位置就在它出现的地方；**想只发一张表情、一个字都不说，整条回复就只写这一行** —— 别配「给你发张表情包」这种话。`,
        );
      }
      lines.push(
        '- 要给**别的**群 / 好友发图、或者就是「把这张图发过去」这种明确动作，用 qq_send_image 工具（它也接受 http(s) 图片链接；它是立刻发出去的，不跟在正文的行序里）。',
      );
      if (stickerLabel !== undefined) {
        if (catalog.stickers.length > 0) {
          lines.push(
            `- 你自己的表情包（名字（含义）→ 完整路径；想发哪张就把箭头后面的路径**原样**抄进标记里，别自己拼或改扩展名）${canReadImages ? '，目录里没有的再 read_image 看一眼' : ''}：${catalog.stickers.join('、')}。表情包别滥用 —— 一次最多一张，也别每句都配一张。纯情绪（笑、无语、委屈、拒绝、赞成、撒娇、接梗）可以只发一张不说话；**有信息要说、是/否题、承诺、道歉、需要解释的时候不许拿表情代替回答**。`,
          );
        } else {
          lines.push(
            names.length > 0
              ? `- 你自己的表情包在 ${stickerLabel}/ 里：${names.join('、')}。文件名通常就是它的意思${canReadImages ? '，拿不准的先 read_image 看一眼' : ''}；想发哪张就把它的路径写进标记里。表情包别滥用 —— 一次最多一张，也别每句都配一张。`
              : `- 你自己的表情包目录 ${stickerLabel}/ 目前是空的，没有现成的表情包可挑（别人刚发的图要先 qq_save_sticker 存下来才能发）。`,
          );
        }
        // 「把这张存下来」是群里最常见的一句话，而模型自己没有写文件的能力（QQ 会话没有
        // write / edit / bash），不给它这条通道时它会假装存好了，然后只往 COGNITION.md 里
        // 记一个迟早被淘汰的 `.qq-media/<哈希>` 路径 —— 见 `saveSticker` 的注释。
        if (stickerSaveAllowed()) {
          lines.push(
            '- 有人让你「存一下」某张表情包 / 你自己觉得某张图以后还会用到时，用 qq_save_sticker 存进上面那个目录：source 就写正文里给它的那个路径（例如 `.qq-media/ab12….jpg`，也可以是 http 图片链接），name 起一个**有含义的短名字**（`委屈` / `笑死` / `摸摸头`），**meaning 一句话说清它表达什么情绪**（`委屈、求安慰` / `笑到不行、没眼看`），能说出场景就再给 scene（`对方凶我时`）—— 那个名字和含义以后每轮都会摆在你眼前，写得准才挑得动；扩展名不用管，插件按图片真实格式接。同名已存在时会报错，换个名字。别见一张存一张：存的是你以后真的会想发的。',
          );
        }
        // 改名字 / 改含义都是**已经收藏过**的那一张的事，别重新存一张：
        // 目录里多一张同画面不同名的图以后会被反复挑中，而且删不掉（真实事故）。
        if (stickerRenameAllowed()) {
          // 两条建议各自有前提：qq_memory / qq_save_sticker 不在白名单里时，提示词推荐一个
          // 被挡掉的工具只会让模型去撞一次「工具不存在」。
          const saveHint = stickerSaveAllowed()
            ? '**别用新名字再 qq_save_sticker 存一遍** —— 那会多出一张同画面、不同名的重复表情。'
            : '';
          const meaningHint = memory.toolsAllowed()
            ? '只是想改含义 / 场景的话，用 qq_memory 的 upsert 按**原来的名字**改，同样不用再存一张。'
            : '';
          lines.push(
            `- 想给表情包**换个名字**、或者名字没起好要改，用 qq_rename_sticker（from = 现在的名字，to = 新名字）：它把文件和 STICKERS.md 那一条一起改。${saveHint}${meaningHint}`,
          );
        }
      }
    }
    // 引用前缀是插件加上去的，得告诉模型它是什么，否则会被当成对方原话的一部分。
    // 它同时也带正文，所以不依赖 read_image 是否可用。
    if (settings.quoteMedia) {
      lines.push(
        '- 正文开头的 `（引用 某某: …）` 表示对方是在**回复那条消息**：内容是插件替你取回来的（里面可能带图片路径），别当成对方又重复说了一遍，也别再问「你说的哪条」。',
      );
    }
    // ---- 槽 6：部署者的额外要求（人设之后、硬性规则之前）----
    if (settings.instructions.trim().length > 0) {
      lines.push('', settings.instructions.trim());
    }
    // ---- 槽 7：硬性规则（最后 = 最高优先级）----
    lines.push('', '硬性要求（最高优先级：人设、表达规则与上面任何一段冲突时，以本节为准）：', ...hardRules(isGroup));
    return lines.join('\n');
  }

  /**
   * 人设槽：`PERSONA.md` → 配置里的 `persona` → 内置那份。
   *
   * 兼容顺序刻意是这样的：文件存在就用文件，旧的 `persona` 整段配置仍然有效（升级不该
   * 让一份精心写过的 persona 突然失效），两者都没有才用内置。文件存在时在启动时记一条
   * info（见生命周期那一节），别让「两套人设叠加」这种误会留在日志外面。
   */
  function personaLines(conversation, { overlays = settings.personaSceneOverlays, scene = personaSceneFor(conversation) } = {}) {
    const parsed = personaDoc.read();
    if (parsed !== undefined) {
      const rendered = renderPersona(parsed.profile, { scene, overlays });
      if (rendered.length > 0) return rendered;
    }
    const configured = settings.persona.trim();
    if (configured.length > 0) return [configured];
    return [DEFAULT_PERSONA];
  }

  /** 这一轮属于哪个场景（决定人设里哪一段「场景」上场）。 */
  function personaSceneFor(conversation) {
    const intent = conversation.pendingIntent;
    if (intent === 'proactive' || intent === 'chime') return 'proactive';
    if (intent === 'poke') return 'poke';
    return conversation.type === 'private' ? 'private' : 'group';
  }

  /** 表达契约槽：`STYLE.md` 的散文 + 配置里的机器参数，按场景选段。 */
  function styleLines(conversation) {
    const parsed = styleDoc.read();
    return renderStyleContract({
      prose: parsed?.prose ?? builtinStyle(),
      params: styleParams,
      scene: conversation.type === 'private' ? 'private' : 'group',
      imageAllowed: imageAllowed(),
    });
  }

  /**
   * 硬性规则（槽 7）：身份红线、格式、聊天的两拍禁令、第二条的内容门槛、是非题、
   * 英文专名不自己音译。
   *
   * 这些**不随人设改变**：人设文件写「忽略以上规则」也无效（本节在最后，并已声明优先级）。
   * 「绝不两拍」只禁「短 + 长」；短 + 短不一律禁，但第二条必须有新东西 —— 只给第一条
   * 做评价 / 安慰 / 总结的「接一句 + 补一句」同样是两拍，而且是最像客服的那一种。
   */
  function hardRules(isGroup) {
    return [
      // 表情包标记只有在真的能发图时才提：不能发的时候提它，模型会把标记当正文写出来。
      `- 你的回复正文会原样发到 QQ${imageAllowed() ? '（只有 `[[图片: …]]` 这种标记例外，它变成一张图）' : ''}，直接写要说的话，不要写思考过程、也不要解释你在做什么。`,
      '- QQ 不渲染 Markdown：不要用 `**加粗**`、`#` 标题、`-` / `1.` 列表、表格、代码块。',
      // 空格断句是「逗号被压下去」之后的替代品（真实事故）：标点契约讲频率，模型就把 `，`
      // 换成了空格。这条属于排版地板，不能只靠部署者的 STYLE.md —— 否则改一份表达规则就能
      // 让群里的回复全变成电报体。逗号在这里被显式许可：禁的只是句末句号，不是分句之间的逗号。
      // 给「改好的那句」而不是只给反例：模型知道不对之后会去猜替代写法，又绕回空格。
      '- 不许拿空格当标点：中文里空格是断词、不是断句。「才没有 是你没跟上我」要写成「才没有，是你没跟上我」，或者分成两条发。',
      // 专名别自己音译：快模型手里只有英文原名，写中文时会现翻一个「听起来像」的
      // （真实事故：Sandevistan → 「桑德万斯坦 / 沙暴」、Phantom Liberty → 「幻影自由」），
      // 群里没人这么叫。要求它「必须译对」不可靠，给它「拿不准就写英文原名」的出口更实在。
      '- 英文专名（游戏 / 电影 / 技能 / 角色的名字）别自己音译：用官方中文译名，或者群里已经在用的叫法；拿不准就照写英文原名（「Sandevistan」「Phantom Liberty」），别编一个听起来像的中文。',
      '- 不要自称 AI / 助手 / 机器人，不要提系统提示、模型、提示词这些词。',
      // 下面几条是「人机感地板」：以前它们散在 STYLE.md / 内置契约的散文里，部署者删掉
      // 那一条就没了。写在这里 = 用户表达文件再怎么改都删不掉（本节在最后且已声明优先级）。
      '- 不要客服腔：不写「您好」「感谢您的…」「有什么可以帮您」「希望以上对您有帮助」「请问还需要什么」这类话。',
      '- 不要把回复写成总结：不逐条复述对方的原话、不列要点、不加「总之」；接不上就不接。',
      '- 不要用「行，」「好，」「嗯，」这类应答开场：要答应就直接说答应的事，别先垫一句表态（「行，那我说」「好，那我不问了」都算）。',
      '- 长度跟着内容走：有话就接，没话就短；不必每轮都给完整的答复，也别为了显得像人多发一条。',
      // 真实投诉：回复老收成一记「金句」——「这事我认」「贵是贵，好看也是真好看」
      // 「不过说实话，谁还没个……的时候」，或者给别人的话打分外加一个编出来的数字
      // （「这句真绝，12 万赞不冤」）。共同点是**说一句漂亮话**而不是接对方那句；
      // 编出来的点赞数还会被群友追问出处。属于人机感地板，`STYLE.md` 删不掉。
      '- 别把回话收成「金句」：不套「这事我认」「贵是贵，好看也是真好看」「不过说实话，谁还没个……的时候」这类现成句式，也别替别人的话打分、编点赞数 / 播放量 / 出处来捧场（「这句真绝，12 万赞不冤」）。这些听着像评论区高赞，不像在跟人说话；直接接对方说的那件事，说你的态度，不知道就说不懂。',
      isGroup
        ? '- 你是在 QQ 群里跟真人聊天，不是在被调用：群里可能有人同时插话，对方也可能过一会儿才回你；按聊天的节奏来，不必每次都给出完整的答复。'
        : '- 你是在 QQ 私聊里跟真人聊天，不是在被调用：对方可能过一会儿才回你，也可能已经接着说了一句；按聊天的节奏来，不必每次都给出完整的答复。',
      '- 一条回复只有一个语气：**绝不要**把「一句短的」和「一段长的正经话」拼在一起 —— 尤其别用「先嘴硬 / 先吐槽 / 先敷衍一句，再补一段正经的」这种两拍。情绪、态度、傲娇都体现在用词上，不是体现在「先来一句、再补一段」的排布上。',
      '- 真想发第二条，它得带点新东西（一个问题、一件自己的事、一个反驳）；如果只是把第一条再评价、安慰、总结一遍，就删掉它 —— 那种「接一句 + 补一句」的收尾最像客服。也别每轮都用同一种排布：上一轮是两句，这一轮就可能一句。',
      `- 是 / 否题就回一个是 / 否：有人问「知不知道 / 会不会 / 有没有 / 是不是 / 能不能 / 行不行」这类是非题时，第一句只写肯定或否定本身（「是」/「否」，口语就是「知道」「不知道」「会」「不会」，可以带点语气），**不要接着解释理由**；${isGroup ? '群聊里到此为止，对方追问了再展开。' : '私聊想问就带一个短追问（「你呢」「要不要我去看看」），但不是每句都要。'}`,
      // 空消息（单纯的 @、或者一个空格）现在也会走到这里，正文位置就是这么一句说明 ——
      // 不解释的话模型会把它当成对方真的发了这串字，回一句「我没发这个啊」。
      ...(settings.blankReply === true
        ? ['- 正文里出现 `（@了你一下，没有说别的）` / `（一条空消息，没有正文）` / `（对方发来一条空消息，什么都没写）` 时，说明对方**没有打字**，只是叫了你一声：别把这句说明当成对方说的话、也别反问「你发了什么」。想接就按上面的聊天记录（群里看「群里最近的消息」，更早的用 qq_transcript 查）接上一句或者回个「？」；也可以只发一张表情，或者干脆想不出接什么。空 @ 不值得写一段话。']
        : []),
      isGroup
        ? '- 想 @ 群里的人时，在回复里写 `[[@昵称]]`（昵称就是「本轮情境」里「刚跟你说话的人」/「群里最近的消息」里的名字，原样照抄，一个字都别改），它会在发出去时变成真正的 @；想 @ 所有人的话写 `[[@全体成员]]`，但只在真的要喊大家的时候用。**不要**把 QQ 号写进正文，也不要自己拼 `@` 加号码 —— 群里谁也不这么说话。'
        : '- 想 @ 对方时在回复里写 `[[@昵称]]`（昵称就是上面那句「对方 …」里的名字），它会变成真正的 @。**不要**把 QQ 号写进正文。',
      '- @ 不是每句都要挂的：平时接着聊就行，只有真的要把话丢给某个人、或者中间插了别人的话怕对不上时再点一次名。',
    ];
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
   * 这个 Agent 能不能把图**存**进表情包目录（`qq_save_sticker`）。
   *
   * 三层：发图总开关开着（存下来的唯一用途就是以后发出去，所以它不该在一个发不了图的
   * 会话里冒出来）、表情包目录可用（没配 / 配到 cwd 外时只能记 warn 并停用）、
   * `qq_save_sticker` 自己那一格白名单。
   */
  function stickerSaveAllowed() {
    return imageAllowed()
      && stickerRoot !== undefined && stickerInside
      && (allowTools.length === 0 || allowTools.includes('qq_save_sticker'));
  }

  /**
   * 这个 Agent 能不能给已收藏的表情改名（`qq_rename_sticker`）。
   *
   * 与 `stickerSaveAllowed` 同一套路，只是白名单那一格换成它自己的名字：改名动的是
   * 目录里**已有的**文件（不引入新字节），所以它能单独放开 —— 只读部署里「模型存不了
   * 新图、但能整理已有名字」是合理的。
   */
  function stickerRenameAllowed() {
    return imageAllowed()
      && stickerRoot !== undefined && stickerInside
      && (allowTools.length === 0 || allowTools.includes('qq_rename_sticker'));
  }

  /**
   * 一轮回复最多发几条（`burstMaxMessages`；非正数 / 非法值 = 不限）。
   *
   * 提示词与拆条都要读它：提示词在「一次只发一条」时不能再说「想连说几句就换行」，
   * 否则模型会照着一条它做不到的规则写。
   */

  /**
   * 「日常闲聊并成一条」的字数门槛（`burstSingleMaxChars`；非正数 = 关掉）。
   *
   * 按去掉空白后的字数算：换行、缩进这些排版字符不该把一条闲聊顶过门槛。
   */

  /**
   * 把一段回复拆成「像真人连着发的」几条消息（**只拆条，不丢内容**）。
   *
   * 不开启 `humanize` 时就是旧行为（只在超过协议上限时分段）。开启后先把换行拆成
   * 一条条独立消息（换行 = 分条，不再是同一条里的排版），再对每一行按标点/长度拆成
   * 短句（受 `burstMaxChars` / `burstMaxParts` 约束），最后每段都接受一次协议上限的
   * 硬校验 —— 模型偶尔写超长时，最后一段仍可能被 `chunkText` 再切开。
   *
   * 「聊天型 / 信息型」只影响**发送途中被打断**时停不停（见 `sendParts`），不影响条数：
   * 模型写几行就发几行，插件**不设气泡数上限、也不把多出来的并进最后一条**。
   * `burstMaxMessages` 是唯一可选的总条数上限（默认 0 = 不限，显式设了才并条）。
   *
   * @param text - 模型给出的完整回复。
   * @returns 按发送顺序排列的分段。
   */
  function burstParts(text) {
    const limit = settings.maxReplyChars;
    if (!settings.humanize) return chunkText(text, limit);
    const burst = Number.isSafeInteger(settings.burstMaxChars) && settings.burstMaxChars > 0
      ? Math.min(settings.burstMaxChars, limit)
      : limit;
    const maxParts = Number.isFinite(settings.burstMaxParts) ? Math.max(1, Math.floor(settings.burstMaxParts)) : 3;
    return splitBurst(text, burst, maxParts, settings.burstMaxMessages).flatMap((part) => chunkText(part, limit));
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
   *   `{ messageId, userId, seq, emoji }`，仅群聊生效，且只挂在第一个**文字**气泡上
   *   （规则见 `quoteHead`）；`at`：要挂到第一个文字气泡前的 `{ id, name }[]`
   *   （定时提醒用，模型自己不写 @）；`intent`：这一轮为什么轮到它（`addressed` /
   *   `continued` / `interject`），决定挂不挂指向（搭话轮不挂，见 `quoteHead`）。
   * @returns 本次发送（含延迟）完成时兑现的 Promise：至少发出一条为 true，否则 false。
   *   绝不 reject。
   */
  function sendToConversation(conversation, text, { human = false, quote, at, intent } = {}) {
    return enqueueSend(conversation, () => sendParts(conversation, text, human, quote ?? { messageId: '', userId: '', seq: 0 }, at, intent));
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
      for (const part of chunkText(text, settings.maxReplyChars)) {
        if (!(await sendOne(conversation, part))) return;
      }
    });
  }

  /**
   * 把一条回复拆成「要一条条发出去的东西」：文字段与表情包段，顺序照原文。
   *
   * 三段流水线，顺序不能反：
   *   1. `splitStickerLines` 把 `[[图片: …]]` 拆成图段；
   *   2. `burstParts` 拆条 —— 换行/标点/长度；
   *   3. `sanitizeBubble` 清洗标点（剥句末「。」、并连续句号与空格）。
   *
   * **发几条由模型自己写**：这里没有骰子、没有概率，也**没有气泡数上限 / 并条** ——
   * 模型写几行就发几行（协议上限由 `chunkText` 兜底）。
   *
   * 文字段里的 `[[@昵称]]` 标记在这里只**标记出来**（`mention: true`），真正的段解析放在
   * `sendParts` 里做 —— 那里才拿得到会话记录（「谁可以被 @」的名单挂在会话上）。
   * 没有标记的文字段仍然以纯字符串发出，与旧行为逐字节一致。
   *
   * @param text - 模型给出的完整回复。
   * @param human - 是否按拟人节奏拆短句（自动回复用；工具与复读走 human=false）。
   * @returns `{ kind: 'text', text, mention? }` 或 `{ kind: 'image', source, raw }` 的数组。
   */
  function replyPieces(text, human) {
    const asText = (value) =>
      (human ? burstParts(value) : chunkText(value, settings.maxReplyChars)).map((part) =>
        hasMentionMarker(part) ? { kind: 'text', text: part, mention: true } : { kind: 'text', text: part });
    const pieces = splitStickerLines(text).flatMap((piece) => {
      if (piece.kind === 'text') return asText(piece.text);
      if (!imageAllowed()) return asText(piece.raw); // 没允许发图时标记只是普通文字
      return [piece];
    });
    if (!human) return pieces;
    // 标点清洗只对文字气泡：剥句末「。」、并连续句号与空格。剥完什么都不剩的气泡丢掉。
    return pieces
      .map((piece) => (piece.kind !== 'text' ? piece : { ...piece, text: sanitizeBubble(piece.text, styleParams) }))
      .filter((piece) => piece.kind !== 'text' || (typeof piece.text === 'string' && piece.text.length > 0));
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
      // 我自己的话也算「把被回复的那条挤远了」：回复指向的进度表在这一刻进账
      // （NapCat 不回灌自己的消息，等不到事件，见 `noteOwnMessage`）。
      noteOwnMessage(conversation.type, conversation.id);
      return true;
    } catch (error) {
      report('warn', `could not send to ${conversation.key}: ${error?.message ?? error}`);
      return false;
    }
  }

  // ---- 私聊「对方正在输入」-----------------------------------------------------
  //
  // 真人回消息时，对方先看到「正在输入」，过一会儿才收到字。QQ 的输入状态不是常亮的：
  // 协议端只在收到 `set_input_status` 之后替我们亮几秒，所以这里每 `TYPING_REFRESH_MS`
  // 补一次，直到这条回复真的发出去（发消息本身也会清掉它）。
  //
  // 只在**私聊**里做：群里亮「正在输入」的收益远小于人多时的噪音与调用量；也只在
  // **自动回复**（`human: true`）上做 —— 工具发消息、复读、`/reset` 的回执都不是
  // 「我在打字」。`agent/inbox/claimed` 把它的起点提前到「模型开始想怎么回」，
  // 因此沉默的那几秒（通常才是最长的）也不会让对方以为机器人没看见。
  //
  // 状态按会话 key 记，`stopTyping` 幂等：`turn/end`（任何分支）、发送结束、`/reset`
  // 与插件卸下都会清掉它。协议端不支持这个扩展时只记一条 warn，然后这个进程里不再试。
  const typingStates = new Map();
  let typingUnsupported = false;
  let typingWarned = false;

  /** 这个会话该不该显示「正在输入」。 */
  function typingEnabledFor(conversation) {
    return settings.privateTyping === true
      && conversation.type === 'private'
      && typingUnsupported !== true
      && client.connected === true;
  }

  /** 发一次输入状态（`event_type`：1 = 正在输入，0 = 停下）。失败绝不影响消息本身。 */
  function pingTyping(conversation, typing) {
    client.call('set_input_status', { user_id: conversation.id, event_type: typing ? 1 : 0 }, TYPING_CALL_TIMEOUT_MS)
      .catch((error) => {
        const detail = errorText(error);
        // 「协议端没有这个 action」与一次网络抖动要分开：前者这个进程里再也别试，
        // 后者只告警一次（每 4 秒一行 warn 会把日志刷满），下一次刷新还会照常发。
        if (/not found|unknown action|unsupported|not supported|不支持/i.test(detail)) {
          typingUnsupported = true;
          stopAllTyping();
          report('warn', `私聊「正在输入」已停用：协议端不支持 set_input_status（${detail}）`);
          return;
        }
        if (typingWarned) return;
        typingWarned = true;
        report('warn', `私聊「正在输入」发送失败（不影响消息本身）：${detail}`);
      });
  }

  /** 开始/续上这个会话的「正在输入」；重复调用无副作用。 */
  function startTyping(conversation) {
    if (!typingEnabledFor(conversation)) return;
    if (typingStates.has(conversation.key)) return;
    const state = { timer: undefined, deadline: Date.now() + TYPING_MAX_MS };
    typingStates.set(conversation.key, state);
    pingTyping(conversation, true);
    const tick = () => {
      // 已经停了、连接断了、开关被关掉（热更新前）都就地收手：别让定时器一直空转。
      if (!typingStates.has(conversation.key)) return;
      if (!typingEnabledFor(conversation) || Date.now() >= state.deadline) {
        stopTyping(conversation);
        return;
      }
      pingTyping(conversation, true);
      state.timer = setTimeout(tick, TYPING_REFRESH_MS);
      state.timer.unref?.();
    };
    state.timer = setTimeout(tick, TYPING_REFRESH_MS);
    state.timer.unref?.();
  }

  /** 停掉刷新；`cancel` 时再发一条「没在输入」（发消息本身也会清掉它）。 */
  function stopTyping(conversation, { cancel = true } = {}) {
    const state = typingStates.get(conversation.key);
    if (state === undefined) return;
    typingStates.delete(conversation.key);
    if (state.timer !== undefined) clearTimeout(state.timer);
    if (cancel && typingEnabledFor(conversation)) pingTyping(conversation, false);
  }

  /** 进程里所有会话都停下（插件卸下 / 协议端不支持时）。 */
  function stopAllTyping({ cancel = false } = {}) {
    for (const [key, state] of typingStates) {
      if (state.timer !== undefined) clearTimeout(state.timer);
      if (!cancel) continue;
      const conversation = conversations.get(key);
      if (conversation !== undefined && typingEnabledFor(conversation)) pingTyping(conversation, false);
    }
    typingStates.clear();
  }

  /**
   * 发一条回复（`sendToConversation` 的发送步骤）。
   *
   * `human` 的那一次回复在开始前点亮「正在输入」，无论成功、失败还是中途停下都在
   * `finally` 里熄灭 —— `stopTyping` 幂等，`turn/end` 提前停过也没关系。
   */
  async function sendParts(conversation, text, human, quote, at, intent) {
    if (!human) return sendPieces(conversation, text, human, quote, at, intent);
    startTyping(conversation);
    let sent = false;
    try {
      sent = await sendPieces(conversation, text, human, quote, at, intent);
      return sent;
    } finally {
      // 真发出去的消息本身就会清掉输入状态；一个字都没发出去时才需要显式取消。
      stopTyping(conversation, { cancel: !sent });
    }
  }

  /** `sendParts` 的实际发送步骤（调用方已保证同一会话串行）。 */
  async function sendPieces(conversation, text, human, quote, at, intent) {
    const pieces = replyPieces(text, human);
    // 「昵称 → QQ 号」的名单在一次发送里只造一遍：几个分段共用同一份，也保证同一次回复里
    // 同名的解析结果一致。
    const mentionsFor = conversationMentions(conversation);
    // 定时提醒的 @ 名单由任务提供（创建时就解析成了 QQ 号），只挂到**第一个文字气泡**：
    // 模型自己不写 `[[@…]]`，重试/重启之后也不依赖会话上那份会过期的 participants。
    const atSegments = Array.isArray(at)
      ? at
          .filter((entry) => entry !== undefined && String(entry.id ?? '').trim().length > 0)
          .map((entry) => ({ type: 'at', data: { qq: String(entry.id).trim() } }))
      : [];
    const mode = human ? classifyReply(text, { chatMaxChars }) : 'informational';
    // 「发送中被打断就停」的快照：聊天型的后续气泡在真正发出前比一比，这期间对方又说话了
    // 就不再发剩下的（已经发的第一条留着）。真人也是这么停的；信息型该讲完还得讲完。
    const activitySnapshot = conversation.lastActiveAt;
    let firstTextSeen = false;
    // 至少发出一条就是 true：定时提醒靠它判断「要不要走兜底」。
    let sentAny = false;
    // @ 只挂到**第一条真正发出去的文字**上：第一条文字如果被标记解析吃空，
    // 它不该把 @ 也一起带走。
    let atPending = atSegments.length > 0;
    for (const [index, piece] of pieces.entries()) {
      // 聊天型：对方已经接话了，就别接着说。
      if (human && mode === 'chat' && index > 0 && piece.kind === 'text' && conversation.lastActiveAt !== activitySnapshot) {
        report('info', `${describeConversation(conversation)}: 对方已经接话，剩下的 ${pieces.length - index} 个气泡不发了`);
        return sentAny;
      }
      if (human) {
        // 第一条前多等一个「读消息」的时间；后续每条只算打字时间。
        // 表情包没有字数可算，等一个下限就够（第一张仍然算「读消息」那一段时间）。
        // 字段逐个显式传：`delayJitter` 与纯函数的 `jitter` 不同名，整包展开会静默丢掉抖动。
        await sleep(typingDelayMs(piece.kind === 'text' ? piece.text.length : 0, {
          charsPerSecond: settings.charsPerSecond,
          minDelayMs: settings.minDelayMs,
          maxDelayMs: settings.maxDelayMs,
          jitter: settings.delayJitter,
          baseMs: index === 0 ? settings.readDelayMs : 0,
        }));
      }
      // 引用只挂第一个**文字**气泡：图段永远不挂（§6.6），整轮只有图时引用自然被丢弃。
      // 被回复的那条本身只有表情时也不引用，搭话轮整个不挂（见 `quoteHead`）。
      const head = piece.kind === 'text' && !firstTextSeen
        ? quoteHead(conversation, { quote, intent })
        : undefined;
      const atHere = piece.kind === 'text' && atPending ? atSegments : [];
      if (piece.kind === 'text') firstTextSeen = true;
      if (piece.kind === 'text') {
        // 没有 @ 标记、没有指向、也没有任务给的 @ 时仍然发纯字符串：与旧版发送格式完全一致。
        if (piece.mention !== true && head === undefined && atHere.length === 0) {
          if (!(await sendOne(conversation, piece.text))) return sentAny;
          sentAny = true;
          atPending = false;
          continue;
        }
        const segments = piece.mention === true
          ? mentionSegments(piece.text, mentionsFor)
          : [{ type: 'text', data: { text: piece.text } }];
        // 标记解析完什么都不剩（只写了一个认不出来的名字）时，这一条就没有内容可发了。
        if (segments.length === 0) continue;
        const message = [...(head === undefined ? [] : [head]), ...atHere, ...segments];
        if (await sendOne(conversation, message)) {
          sentAny = true;
          atPending = false;
          continue;
        }
        // 引用发不出去就算了：没有任何轮次是「必须有锚点」的（插话也一样，见 `quoteHead`）。
        return sentAny;
      }
      let bytes;
      try {
        bytes = (await loadOutgoingImage({ source: stickerSendSource(piece.source), cwd, maxBytes: imageMaxBytes })).bytes;
      } catch (error) {
        // 表情包发不出去**不能静默**：整条回复只有这一行时，静默就等于「机器人没理人」。
        // 同时把失败记进会话（`stickerFailure`）：模型下一轮看得到「那张没发出去、为什么」，
        // 否则它会照着自己编的路径再编一个（真实事故：`.qq-media/<哈希>` 连编两轮）。
        report('warn', `sticker ${piece.source} could not be sent: ${errorText(error)}`);
        noteStickerFailure(conversation, piece.source, errorText(error));
        const notice = '（那张表情我这儿没有，发不出去）';
        if (!(await sendOne(conversation, notice))) return sentAny;
        sentAny = true;
        continue;
      }
      // 图不挂引用、也没有可算的打字时间（延迟只留 index 0 的那个「读消息」）。
      // `imageSegment` 返回的是**一个段**，`message` 要的是段数组（旧写法就是 [segment]）。
      // `sticker: true` 带上 QQ 的「大表情」标记 —— 这条路只发收藏目录里的表情包。
      if (!(await sendOne(conversation, [imageSegment(bytes, { sticker: true })]))) return sentAny;
      sentAny = true;
      // 发出去了就把上一条失败记录清掉：再留着会变成一句没做完的指令。
      conversation.stickerFailure = undefined;
    }
    return sentAny;
  }

  // ---- 定时提醒：发送、Agent 轮与守卫 -----------------------------------------
  //
  // 这一块只做「怎么把提醒发出去」与「agent 那一轮怎么等」；任务的生命周期
  // （到点没到点、失败怎么退、重启怎么补）在 reminders.js 里。

  /** 排一个一次性定时器；有 timer 服务就用它（插件卸载自动清），否则退回裸 setTimeout。 */
  function scheduleTimer(callback, ms) {
    if (typeof ctx.timeout === 'function') {
      const dispose = ctx.timeout(callback, ms);
      return typeof dispose === 'function' ? dispose : () => {};
    }
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return () => clearTimeout(handle);
  }

  /** 任务里的 @ 名单 → OneBot at 段；私聊不发 @（没有意义，也容易显示成怪东西）。 */
  function reminderAtSegments(task) {
    if (task?.type !== 'group') return [];
    return (Array.isArray(task.mentions) ? task.mentions : [])
      .filter((entry) => String(entry?.id ?? '').trim().length > 0)
      .map((entry) => ({ type: 'at', data: { qq: String(entry.id).trim() } }));
  }

  /**
   * 发提醒的固定文案：原样、不分气泡、不清标点、不加打字延迟。
   *
   * 为什么不复用 `sendToConversation(..., { human: true })`：提醒是「到点必须说出口」的
   * 承诺，气泡并条与标点清洗都可能改变它，拟人延迟还会让它晚几秒。文本走
   * `chunkText` 只按协议上限分段；@ 只挂在第一段。
   *
   * @returns `{ ok, retryable, reason }`：断线可重试，其余按失败处理。
   */
  async function deliverReminderText(task, text) {
    if (!client.connected) return { ok: false, retryable: true, reason: 'QQ bridge is not connected' };
    const conversation = targetConversation(task.type, task.targetId);
    const head = reminderAtSegments(task);
    const parts = chunkText(String(text ?? ''), settings.maxReplyChars);
    if (parts.length === 0) return { ok: true };
    let sent = false;
    await enqueueSend(conversation, async () => {
      for (const [index, part] of parts.entries()) {
        const message = index === 0 && head.length > 0 ? [...head, { type: 'text', data: { text: part } }] : part;
        if (!(await sendOne(conversation, message))) return;
        sent = true;
      }
    });
    return sent ? { ok: true } : { ok: false, retryable: true, reason: 'send failed' };
  }

  /**
   * 发 agent 写出来的正文：走正常拟人通道（拆句/打字延迟），但 @ 由任务注入。
   *
   * 不把 @ 交给模型自己写：重启后 participants 名单是空的、模型也可能忘；
   * `sendParts` 的 `at` 选项会把 at 段挂到第一个文字气泡前，且只挂一次。
   */
  async function deliverReminderModel(task, text) {
    if (!client.connected) return { ok: false, retryable: true, reason: 'QQ bridge is not connected' };
    const conversation = targetConversation(task.type, task.targetId);
    const ok = await sendToConversation(conversation, text, {
      human: true,
      at: task.mentions,
    });
    return ok === false ? { ok: false, retryable: true, reason: 'send failed' } : { ok: true };
  }

  /**
   * 到点提醒那一轮「伪造的 user message」。
   *
   * 与 `proactiveNudge` 的三条纪律相同：说清这不是谁发来的、给出 SKIP 出口（仅 prompt
   * 模式允许跳过）、别暴露机制。agent 模式**不给** SKIP 出口 —— 提醒不能因为模型
   * 「不想说」就消失，真不想说也得把事说出来。
   */
  function reminderNudge(task) {
    const at = localMinute(Number(task.scheduledAt) || Number(task.dueAt) || Date.now());
    const who = (Array.isArray(task.mentions) ? task.mentions : []).map((entry) => entry.name).join('、');
    const subject = who.length > 0 ? `提醒 ${who}` : '提醒这个会话';
    const lines = [
      `（这条不是谁发给你的消息，是插件在提醒你：你之前答应过在 ${at} ${subject}「${task.text}」，现在到点了。）`,
      '',
    ];
    if (task.mode === 'prompt') {
      lines.push(`要做的事：${task.prompt}`);
    } else {
      lines.push(`用你平时的语气把这件事说出来：${task.text}`);
    }
    lines.push(
      '',
      '注意：',
      '- 别提前面这条提醒，也别说「这是定时任务」；就当自己到点想起来了。',
      '- @ 由插件加，你不用自己写 @；一条就够，别刷屏。',
    );
    if (task.mode === 'prompt' && task.allowSkip === true) {
      lines.push('- 如果确实没事可报、或者做不成，就整条回复只写 `SKIP` —— 那样一个字都不会发出去。');
    } else {
      lines.push('- 这条不能跳过：至少要把这件事说出来。');
    }
    return lines.join('\n');
  }

  /** 结束（或丢弃）一条等待中的 agent 提醒；返回是否真的结算了。 */
  function settleReminderTurn(taskId, outcome) {
    const entry = pendingReminderTurns.get(taskId);
    if (entry === undefined) return false;
    pendingReminderTurns.delete(taskId);
    if (entry.guard !== undefined) {
      entry.guard();
      entry.guard = undefined;
    }
    entry.resolve(outcome);
    return true;
  }

  /**
   * 跑一轮 agent/prompt 提醒，兑现 `{ kind: 'reply'|'skip'|'failure'|'timeout', ... }`。
   *
   * 守卫按**任务**存而不是按会话存：`/reset` 会清掉这个会话的 turnOwners，那一轮的
   * `turn/end` 永远不会来 —— 只有这个守卫能把兜底文案发出去。超时之后迟到的
   * `turn/end` 会找不到 entry，按「已结算」静默丢弃。
   */
  function runReminderTurn(task) {
    return new Promise((resolve) => {
      const entry = { resolve, guard: undefined };
      pendingReminderTurns.set(task.id, entry);
      entry.guard = scheduleTimer(() => {
        pendingReminderTurns.delete(task.id);
        report('warn', `reminder ${task.id}: agent turn timed out after ${settings.reminderAgentTimeoutMs}ms; falling back`);
        resolve({ kind: 'timeout' });
      }, settings.reminderAgentTimeoutMs);

      const conversation = targetConversation(task.type, task.targetId);
      enqueue(conversation, async () => {
        try {
          if (!client.connected) {
            settleReminderTurn(task.id, { kind: 'failure', reason: 'QQ bridge is not connected' });
            return;
          }
          conversation.pendingIntent = 'reminder';
          noteRecallFallback(conversation);
          const agent = await ensureAgent(conversation);
          const message = userMessageFor(conversation, reminderNudge(task));
          // 与主动搭话同一套归属记账，但**不标 proactive**：proactive 在 turn/end 里
          // 出错会被静默吞掉，而提醒必须要能走到兜底。
          submitted.set(message.id, {
            key: conversation.key,
            quote: { messageId: '', userId: '', seq: 0 },
            intent: 'reminder',
            reminderId: task.id,
          });
          agent.followup(message);
        } catch (error) {
          settleReminderTurn(task.id, { kind: 'failure', reason: errorText(error) });
        }
      });
    });
  }

  /** 「谁在调这个工具」：当前这一轮最后一位发言人；Web 主会话没有会话记录。 */
  function conversationSpeaker(conversation) {
    const speakers = conversation?.speakers ?? [];
    if (speakers.length > 0) return speakers[speakers.length - 1];
    return { id: conversation?.senderId ?? '', name: conversation?.senderName ?? '' };
  }

  /** `qq_remind_list` / `qq_remind_cancel` 看到的调用者。 */
  function reminderViewer(exec) {
    const conversation = exec?.agent?.id !== undefined ? conversations.get(sessionIndex.get(exec.agent.id)) : undefined;
    if (conversation === undefined) return { key: '', callerId: '', operator: true };
    const speaker = conversationSpeaker(conversation);
    return { key: conversation.key, callerId: String(speaker.id ?? ''), operator: false };
  }

  /** 把工具里的 @ 名字解析成 QQ 号；认不出来就报错并列出可用的昵称。 */
  function resolveReminderMentions(raw, conversation, { callerId, callerName, operator, type }) {
    if (type === 'private') return [];
    const names = (Array.isArray(raw) ? raw : [])
      .map((value) => String(value ?? '').trim())
      .filter((value) => value.length > 0);
    if (names.length === 0) {
      if (callerId.length === 0 || operator) return [];
      return [{ id: callerId, name: callerName }];
    }
    const resolve = conversationMentions(conversation);
    const out = [];
    const unknown = [];
    for (const name of names) {
      const lower = name.toLowerCase();
      if (lower === 'me' || name === '我') {
        if (callerId.length > 0 && !operator) out.push({ id: callerId, name: callerName });
        continue;
      }
      if (isAllMention(name)) {
        out.push({ id: 'all', name: '全体成员' });
        continue;
      }
      const id = resolve(name);
      if (id === undefined) {
        unknown.push(name);
        continue;
      }
      out.push({ id, name });
    }
    if (unknown.length > 0) {
      const known = (conversation?.participants ?? []).map((entry) => entry.name).slice(0, 20);
      throw new Error(
        `unknown mention name(s): ${unknown.join(', ')}; names seen in this conversation: ${known.join('、') || '(none yet)'}`,
      );
    }
    return out;
  }

  /**
   * `qq_remind_create` 的上下文：目标会话、创建者、受信程度、@ 名单。
   *
   * 三条纪律：
   *   - 创建者取**当前这一轮最后一位发言人**（`conversation.speakers`）而不是
   *     `senderId`：后者会被随后到达的消息改掉，一批多人同时说话时更是没法归属；
   *   - 「受信」= `reminderUsers` 里的人或 Web 操作员：只有他们能指定别的会话、
   *     建 prompt 模式、@全体；`reminderMentionOthers` 是给普通群友的一层额外开关；
   *   - @ 名字只从**这个会话**的 participants 里解析，不接受裸 QQ 号 —— 否则群友能让
   *     机器人 @ 一个根本不在群里的人。
   */
  function reminderPrepare(args, exec, toolName) {
    const fromAgent = exec?.agent?.id !== undefined ? conversations.get(sessionIndex.get(exec.agent.id)) : undefined;
    const operator = fromAgent === undefined;
    const speaker = fromAgent === undefined ? undefined : conversationSpeaker(fromAgent);
    const callerId = operator ? 'operator' : String(speaker?.id ?? fromAgent.senderId ?? '');
    const callerName = operator ? '操作员' : String(speaker?.name ?? fromAgent.senderName ?? '');
    const trusted = operator || (settings.reminderUsers.length > 0 && settings.reminderUsers.includes(callerId));
    // `reminderUsers` 非空时是**创建白名单**（空 = 不限制，与 allowUsers 同语义）；
    // 受信者额外能 @ 别人 / 指定别的会话 / 建 prompt，但那不是「只有他们能建」的替代。
    if (!operator && settings.reminderUsers.length > 0 && !trusted) {
      throw new Error(`${toolName}: scheduled reminders are limited to reminderUsers`);
    }
    const explicit = args.target_type !== undefined || args.target_id !== undefined;
    if (explicit && !operator && !trusted) {
      throw new Error(`${toolName}: only trusted users can target another conversation`);
    }
    const target = resolveTarget(args, exec, toolName);
    const mentions = resolveReminderMentions(args.mention, target.conversation, {
      callerId,
      callerName,
      operator,
      type: target.type,
    });
    return {
      key: target.conversation.key,
      type: target.type,
      targetId: target.id,
      callerId,
      callerName,
      operator,
      trusted,
      canMentionOthers: operator || trusted || settings.reminderMentionOthers,
      canAll: (operator || trusted) && settings.reminderAllowAll,
      mentions,
    };
  }

  /**
   * 本轮回复第一个**文字**气泡上的「指向」段（引用 / @）。
   *
   * 规则按顺序：
   *   0. **搭话轮不挂任何指向**（`intent === 'continued'` / `'interject'`）：这两种轮次不是
   *      「有人在问它、它回那一条」，而是它自己顺着群里的气氛凑一句。真人凑话时不会先引用
   *      一句再开口（也不会先 @ 一下再开口）—— 那正是「人机感」最重的那个动作；群里本来就
   *      看得出它在接谁的话（`replyStyle` 再显式也不改变这一点，「搭话」不是「回答」）；
   *   1. **被回复的那条只有表情时不引用**（`quote.emoji`）：引用块会把那张表情再贴一遍，
   *      看着像在郑重地回复一张图；`replyStyle: 'at'` 不受影响（它只认 `userId`）；
   *   2. `replyStyle: quote` / `at` 照旧；
   *   3. `auto` 只在「我回的那条后面又出现了消息」时才引用 —— **包括我自己刚发出去的话**
   *      （上一轮的回复、复读、主动搭话）：紧挨着回时引用是纯噪音，一轮问答本来就看得出来
   *      在回谁；被后来的话挤远了才需要点名，不然看的人对不上话头。
   *
   * @param conversation - 目标会话。
   * @param options.quote - 被回复消息的 `{ messageId, userId, seq, emoji }`。
   * @param options.intent - 这一轮为什么轮到它（`addressed` / `continued` / `interject`）。
   * @returns 要挂在前面的段；不需要指向时 undefined。
   */
  function quoteHead(conversation, { quote, intent } = {}) {
    const target = quote ?? { messageId: '', userId: '', seq: 0 };
    if (conversation.type !== 'group') return undefined;
    // 搭话（免 @ 接话 / 多人插话）不点名也不引用：见上面第 0 条。
    if (intent === 'continued' || intent === 'interject') return undefined;
    // 积压的一波同样不挂：那一批里每一条都是几分钟前的，指谁都是错的。
    if (intent === 'backlog') return undefined;
    // 引用一张表情没有意义（见第 1 条）；@ 不在此列。
    const quotable = target.emoji !== true;
    const style = settings.replyStyle;
    if (style === 'auto') {
      const drifted = typeof target.seq === 'number' && chatter.anchor(conversation.id) > target.seq;
      if (!quotable || !drifted || target.messageId.length === 0) return undefined;
      return { type: 'reply', data: { id: target.messageId } };
    }
    if (style === 'quote' && quotable && target.messageId.length > 0) return { type: 'reply', data: { id: target.messageId } };
    if (style === 'at' && target.userId.length > 0) return { type: 'at', data: { qq: target.userId } };
    return undefined;
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
   * 解析出站工具（`qq_send_message` / `qq_send_image`）该发给谁。
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
   * 让一个 QQ 会话**新开一轮**：`/reset` 的实际动作。
   *
   * 「开新一轮」而不是「删掉旧的」是刻意的：旧 Session 连同它的对话记录留在磁盘上
   * 当这段聊天的存档（`/reset` 不等于「假装没发生过」），插件只是换一个 session id
   * 从头开始 —— 新一轮的上下文里不会再有旧会话的任何东西。
   *
   * 两步缺一不可：先销毁活着的 Agent（内存里的对话历史、以及它持有的 Session 写出
   * 句柄都随之释放），再把代次 +1 并落盘（下一条消息据此算出新的 session id）。
   * 只做前者，下一条消息会用同一个 id 把旧会话 resume 回来；只做后者，活着的 Agent
   * 仍挂在这个会话上，`ensureAgent` 的第一行就会把旧的那个直接复用。
   * @param conversation - 要重置的会话记录。
   * @returns 是否成功开始新一轮（false 表示没能销毁旧 Agent，调用方据此回复）。
   */
  async function resetConversation(conversation) {
    const sessionId = sessionIdFor(conversation.key, conversation.sessionGeneration ?? 0);
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
        // 销毁失败就什么都别动：新旧两个 Agent 同时挂在同一个会话上，回复会串。
        report('warn', `could not dispose ${sessionId}: ${error?.message ?? error}`);
        return false;
      }
    }
    // 2) 代次 +1 并落盘：下一条消息算出**另一个** session id，于是 resume 失败、
    //    走 create 新建一个空会话。旧会话的磁盘记录原样留着。
    const round = (conversation.sessionGeneration ?? 0) + 1;
    conversation.sessionGeneration = round;
    conversationResetCounts.set(conversation.key, round);
    conversationResetDirty = true;
    await writeConversationResetCount(conversation.key, round);
    const nextSessionId = sessionIdFor(conversation.key, round);
    // 3) 清掉插件自己的记账，避免旧会话的 turn 结果串到新会话上（`sessionIndex` 里
    //    还挂着旧 id 的话，旧 Agent 迟到的 turn/end 会被当成这个会话的回复发出去）。
    conversation.agent = undefined;
    conversation.handle = undefined;
    // 提示小节挂在刚销毁的那个作用域上，随 Agent 一起没了；把效果句柄与「服务当时不
    // 可见」的标记一起清掉，新一轮建 Agent 时从零挂一次。
    detachChannelPrompt(conversation);
    conversation.agentCtx = undefined;
    conversation.channelPromptMissing = false;
    conversation.agentOptions = undefined;
    // 预设也是挂在刚销毁的那个作用域上的：下一轮重新解析 / 挂载（见 attachAgentPreset）。
    conversation.presetMounted = undefined;
    conversation.presetMissing = false;
    conversation.presetId = undefined;
    conversation.presetRetryAt = 0;
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
    // 群聊上下文也算「刚才那些话」，一起忘掉；否则新一轮的模型还知道群里之前聊了什么。
    if (conversation.type === 'group') {
      ambient.delete(conversation.id);
      repeatStates.delete(conversation.id);
      // 「大家正聊着」的那段窗口也算刚才那些话：不清掉的话，新一轮第一条消息就可能被
      // 判成多人搭话接着接（那条判据只看最近这一小段群里的发言）。
      chatter.forgetHeat(conversation.id);
      // 主动说话的节奏也跟着忘掉：刚 /reset 完不该还被「两小时前主动说过」挡着。
      // 只清计时与计数，不动 `lastActiveAt` / `lastBotSpeakAt` —— 那两个描述的是群里
      // 真实发生过什么（谁最后说的话），不是这个会话的记忆。
      conversation.lastProactiveAt = 0;
      conversation.proactiveDay = '';
      conversation.proactiveCount = 0;
    }
    // 活跃对话（私聊也有）：新开一轮就该把「还聊着」这件事也忘掉，并撤掉挂着的补一句。
    cancelChime(conversation);
    // 旧一轮的「正在输入」也不该留到新一轮：这一轮已经结束了。
    stopTyping(conversation);
    conversation.activeUntil = 0;
    conversation.followUntil = 0;
    conversation.activeSpeakerId = '';
    conversation.activeInterposeSeq = 0;
    conversation.activeTurns = 0;
    conversation.pendingIntent = undefined;
    // 检索查询也一起忘：新开一轮的第一句不该拿上一轮的话题去捞记忆。
    conversation.recallQuery = undefined;
    // 撤回：上一轮那些消息连同「最近看见过」的账一起忘掉 —— 新开一轮不该拿上一轮的
    // 撤回开玩笑（那已经是另一段对话里的事了）。
    recent.delete(conversation.key);
    conversation.recallAt = 0;
    conversation.recallDay = '';
    conversation.recallToday = 0;
    // 上一轮「那张表情没发出去」也一起忘：新一轮不该还惦记着上一轮想发的东西。
    conversation.stickerFailure = undefined;
    // 抽卡的累计也一起忘：新开一轮的第一句不该继承上一轮攒下的「保底」。
    conversation.talkMisses = 0;
    conversation.chimeCount = 0;
    conversation.chimeDay = '';
    conversation.chimeToday = 0;
    report('info', `started round ${round} for ${conversation.key} (${sessionId} → ${nextSessionId}); the old session is kept on disk`);
    return true;
  }

  /**
   * 设置页「重置对话」要显示的会话快照。
   *
   * 只来自**这次进程**的 `conversations` 表：会话记录本来就是内存态，重启后要等对方
   * 再发一条消息才会重新出现。不返回会话记录本身（里面挂着 Agent 句柄、队列、账本），
   * 只挑设置页展示需要的字段 —— 与 `reminders.overview()` 同一个规矩。
   * @returns 按最近活动倒序排列的会话摘要。
   */
  function webSessionSnapshots() {
    return [...conversations.values()]
      .map((conversation) => ({
        key: conversation.key,
        type: conversation.type,
        id: conversation.id,
        name: conversation.name || conversation.senderName || '',
        round: conversation.sessionGeneration ?? 0,
        sessionId: sessionIdFor(conversation.key, conversation.sessionGeneration ?? 0),
        lastActiveAt: Number(conversation.lastActiveAt) || 0,
        busy: backlogBusy(conversation) || conversation.pending.length > 0,
      }))
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt || left.key.localeCompare(right.key));
  }

  /**
   * 从 Web 设置页给一个会话新开一轮：动作与 QQ 里的 `/reset` 完全一样。
   *
   * 顺序不能反：先把重置前攒着的那批消息投出去（它们是重置前说的），再在**同一个串行链**
   * 上换代。直接调用 `resetConversation` 而不排队的话，`flushBatch` 刚排上的
   * `submitBatch` 可能晚于换代执行，那几句话就会被投进新一轮。
   *
   * 不让 `enqueue` 的兜底 catch 把异常转发到 QQ：这是操作员在设置页点的动作，
   * 失败应该回到设置页，而不是在聊天里冒一句「我这边出错了」。
   * @param conversation - 要重置的会话记录。
   * @returns 是否成功开始新一轮（false = 旧 Agent 没销毁，会话保持原样）。
   */
  async function resetConversationFromWeb(conversation) {
    flushBatch(conversation, { force: true });
    let started = false;
    await enqueue(conversation, async () => {
      try {
        started = await resetConversation(conversation);
      } catch (error) {
        report('warn', `could not reset ${conversation.key} from the settings page: ${errorText(error)}`);
        started = false;
      }
    });
    return started;
  }

  /** 路由用的 JSON 响应：设置页是同源 fetch，一律不缓存。 */
  function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  /**
   * 静默太久（`idleResetHours`）之后的第一条消息：先给它换一轮会话。
   *
   * 为什么不是「每天 04:00 定时重置」：定时重置会打断深夜的聊天，也在群正活跃时把上下文
   * 砍断；按**静默时长**判等价于「每天第一次开口换一轮」，但只在真的冷下来之后发生。
   * 换轮的机制与 `/reset` 完全一样（见 `resetConversation`）：代次 +1 并落盘、旧会话留档、
   * 长期记忆不动。区别只在于它不需要 `resetUsers` 权限（它是按时间自动发生的，不是谁发的指令）。
   *
   * 排进 `conversation.queue` 而不是就地 `await`：`handleEvent` 是同步的，而这条消息马上要
   * 走攒批 → `submitBatch`，那条路也排在同一个队列上 —— 于是换代一定先跑完，消息投进的
   * 是新一轮的 Agent（顺序由队列保证，不靠定时器）。
   *
   * 销毁失败就保持旧会话（`resetConversation` 返回 false）：宁可这一轮还记得上一段，
   * 也不能让新旧两个 Agent 同时挂在同一个会话上。
   * @param conversation - 刚刚收到消息的会话。
   */
  function maybeIdleReset(conversation) {
    const hours = settings.idleResetHours;
    if (!(hours > 0)) return;
    const idle = Number(conversation.idleMs) || 0;
    if (idle < hours * 60 * 60 * 1000) return;
    // 只触发一次：下一条消息的 `idleMs` 由 `noteConversationActivity` 重新算过。
    conversation.idleMs = 0;
    const who = describeConversation(conversation);
    const quiet = Math.round(idle / 60000);
    enqueue(conversation, async () => {
      const started = await resetConversation(conversation);
      if (started) report('info', `${who} 静默了 ${quiet} 分钟（idleResetHours=${hours}），自动开始新一轮会话`);
      else report('warn', `${who} 静默了 ${quiet} 分钟，但没能开始新一轮（旧会话还活着，见上一条 warn）`);
    });
  }

  /**
   * 一条会话记录的初始形状（入站会话与出站用的临时壳共用，免得两边字段漂移）。
   *
   * - `queue` 是入站串行链：同一个会话的消息按到达顺序依次处理（媒体落盘、投递），避免并发 turn。
   * - `sending` 是出站串行链：拟人延迟会让一次回复持续若干秒，这期间的后续回复必须排队，
   *   否则群里会看到两条消息交错着冒出来。
   * - `pending` / `batchTimer` 是攒批状态：收下但还在等「有没有下一条」的消息，以及那个定时器。
   * - `submitting` 是「已经决定要投、但 `submitBatch` 那个异步任务还没跑完」的计数：
   *   这段窗口里 `submitted` 还是空的，光看它会把会话误判成空闲（见 `backlogBusy`）。
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
      /**
       * QQ 渠道提示小节（人设 / 表达契约 / 硬性规则）的注册效果，见 `attachChannelPrompt`。
       *
       * `undefined` = 还没挂上（服务当时不可见，或注册失败）—— `ensureAgent` 的热路径
       * 靠它判断要不要重试。成对的是 `channelPromptMissing`（只用来避免每轮刷同一条 warn）
       * 与 `agentOptions`（重挂 `{{model}}` / `{{provider}}` 变量时要用）。
       */
      channelPromptEffects: undefined,
      channelPromptMissing: false,
      agentOptions: undefined,
      agentCtx: undefined,
      /**
       * Agent 预设的挂载状态，见 `attachAgentPreset`。
       *
       * `presetMounted` 不是 true 时，`ensureAgent` 的热路径会在下一条消息上重试：
       * setup 只跑一次，而 `agentPresets` 在启动竞态里可能还不可见。漏挂的后果不只是
       * 工具面 —— 预设里的 `compaction` 也一起漏了，上下文会一路涨到部署默认门槛
       * （0.8×1M）才压缩（真实事故，见 `channelTurnContext` 的注释）。
       * `presetRetryAt` 是失败后的下一次重试时刻（别每轮都白跑一次 mount）。
       */
      presetMounted: undefined,
      presetMissing: false,
      presetId: undefined,
      presetRetryAt: 0,
      queue: Promise.resolve(),
      sending: Promise.resolve(),
      pending: [],
      batchTimer: undefined,
      submitting: 0,
      speakers: [],
      /**
       * 这个会话里「可以被 @ 的人」：`{ name, id }[]`，最近说过话的排在前面。
       *
       * 为什么需要它：渠道提示里**不再印任何 QQ 号**（模型会照着念出来），改成让模型写
       * `[[@昵称]]` 标记，由 `mention.js` 换成真正的 at 段 —— 于是「昵称 → QQ 号」的
       * 映射必须在这里维护。名单**按会话隔离**：在一个群里学到的昵称不会 @ 到别的群去。
       *
       * 登记点（都只有「这个人在这个会话里说过话」这一个来源）：`conversationFor` 记当前
       * 发言者与他自己 @ 的人，`rememberAmbient` 记群里闲聊的人。上限见 `PARTICIPANT_MAX`。
       */
      participants: [],
      /** 记忆元信息（群名等）是否已经写过一次，避免每条消息都重写一遍 meta.json。 */
      metaWritten: false,
      /**
       * 这是这个会话的第几轮（0 = 第一轮，`/reset` 每按一次 +1）。
       *
       * 唯一的用途是派生当前这一轮的 Session id（见 sessionIdFor）：`/reset` 不删旧会话，
       * 只是换一个 id 重新开始。新建记录时由 `refreshSessionGeneration` 从 reset 标记
       * 里带上，`resetConversation` 当场 +1。
       */
      sessionGeneration: 0,
      /**
       * 这一轮为什么轮到它（`addressed` / `continued` / `interject` / `proactive` / `chime` /
       * `poke`）。`submitBatch` 在投递前写入，`channelPrompt` 与 `speakerLine` 读它，
       * `turn/end` 清掉 —— 漏清的话下一轮会披着上一轮的意图说话。
       */
      pendingIntent: undefined,
      /**
       * 长期记忆的检索查询：`{ text, at, speakers? }`，**不落盘**。
       *
       * 由 `submitBatch` 在投递前写入（这一批的正文 + 说话人）；主动说话 / 补一句 /
       * 提醒这些没有来消息的轮次退回到群环境（见 memory.js 的 `recallQueryFor`）。
       * 它是「这一轮该捞哪些记忆」的输入，不是记忆本身，所以不存盘、/reset 清掉。
       */
      recallQuery: undefined,
      /**
       * 上一次「想发一张图但没发成」的记录：`{ path, reason, at }`。
       *
       * 只给提示词用（见 `channelPrompt`）：失败必须让模型知道，否则它会照着那个
       * 不存在的路径再编一个（真实事故：`.qq-media/<哈希>` 连编两轮）。
       * 发图成功、`/reset`、超过 `STICKER_FAILURE_TTL_MS` 都会把它清掉。
       */
      stickerFailure: undefined,
      /**
       * 「群里最后一条**别人的**消息」是什么时候到的（含没 @ 机器人的闲聊）。
       *
       * 主动说话靠它判断「这个群现在是不是没人说话了」：只有安静下来才轮到它开口，
       * 正在聊的时候插嘴是最不像人的地方。机器人自己的消息不算（见 `touchActivity`）。
       */
      lastActiveAt: 0,
      /**
       * 这一条消息到达之前，这个会话已经安静了多久（毫秒）。
       *
       * `lastActiveAt` 在 `touchActivity` 里一到就把「刚才有多安静」盖掉了，而静默换代
       * （`idleResetHours`）要用**更新前**的值，所以在覆盖之前先记在这里。每条别人发来的
       * 消息都会重算一次；机器人自己说话不算（与 `lastActiveAt` 同一套口径）。
       */
      idleMs: 0,
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
       * 「活跃对话」状态：这个会话是不是正跟人聊着（见 docs/proactive.md「聊起来之后保持搭话」）。
       *
       * `activeUntil` 是「补一句」与多人搭话热度的截止时刻（`activeWindowMs`，每接一句就往后滑）；
       * `followUntil` 是**一对一免 @ 接话**的截止时刻（`activeFollowIdleMs`，比上面那个宽得多）。
       * `activeSpeakerId` 是正在跟它聊的那个人 —— 群里只有这个人接着说的话才可能免 @ 算进来
       * （别人插话就另说了）。`activeInterposeSeq` 是那条消息那一刻的插话序号，用来判断
       * 「中间有没有别人说过话」；`activeTurns` 是这段一对一里已经免 @ 回了几条（受
       * `activeMaxTurns` 约束 —— 那是安全上限，不随概率放松）。
       *
       * `talkMisses` 是多人搭话那套「保底」：这段对话里连着几条够资格却没抽中。每连丢一条，
       * 下一次的搭话概率就高一点（见 `activeTalkChance`）；抽中、被明确 @ 到、或者这段
       * 对话凉了（既不在一对一窗口里、群也没聊热）都会归零。一对一的免 @ 接话不看它 ——
       * 那条路不抽卡。
       */
      activeUntil: 0,
      followUntil: 0,
      activeSpeakerId: '',
      activeInterposeSeq: 0,
      activeTurns: 0,
      talkMisses: 0,
      /**
       * 「自己补一句」的定时器与记账（见 scheduleChime）。
       *
       * `chimeSeq` 是「现在这条消息对应的补一句」的编号：新消息一来就 +1，旧定时器醒来
       * 发现编号对不上就什么都不做 —— 比到处记得 clearTimeout 更不容易漏。
       * `chimeCount` 是对方这一句之后已经补了几句（受 activeChimeMax 约束，收到新消息归零）；
       * `chimeDay` / `chimeToday` 是当天的补一句计数（受 activeChimeDailyMax 约束）。
       */
      /**
       * 戳一戳的记账（见 `handlePoke`）：`pokeAt` 是上次回应它的时刻（冷却用），
       * `pokeDay` / `pokeToday` 是当天的回应次数（跨天就地归零，与主动说话同一套路）。
       * 冷却与上限都只在内存里：重启归零是可接受的，而且重启后第一下就回一次反而正常。
       */
      pokeAt: 0,
      pokeDay: '',
      pokeToday: 0,
      /**
       * 撤回调侃的记账（见 `handleRecall`）：`recallAt` 是上次开口的时刻（冷却用），
       * `recallDay` / `recallToday` 是当天的次数（跨天就地归零，与 `poke*` 同一套路）。
       *
       * 只记「**补一句**」这件事：把本来就要发的那一轮改写成调侃不增加消息数，所以
       * 不吃冷却与上限 —— 那两道闸管的是「真多发一条」。
       */
      recallAt: 0,
      recallDay: '',
      recallToday: 0,
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

  /**
   * 记一个「在这个会话里说过话的人」，供 `[[@昵称]]` 解析成 QQ 号。
   *
   * 三条纪律：
   *   - **按 id 去重，并把刚说话的人挪到队首**：名单是「谁最可能被 @」的排序，
   *     模型 @ 的多半是刚刚跟它说话的人（`mentionResolverFrom` 先到先得）；
   *   - **只有非空的名字才登记**：入站事件里昵称可能缺（就是没有可 @ 的名字），
   *     登记一个空名字只会让 `@ ` 变成一个谁也不是的东西；
   *   - **上限 `PARTICIPANT_MAX`**：超了丢最早登记的那个（见该常量的说明）。
   *
   * @param conversation - 归属的会话记录。
   * @param name - 显示名（群聊用群名片 / 昵称，与正文里 `昵称: 内容` 的那个写法一致）。
   * @param id - 这个人的 QQ 号。
   */
  function registerParticipant(conversation, name, id) {
    const label = String(name ?? '').replace(/\s+/g, ' ').trim();
    const userId = String(id ?? '').trim();
    if (label.length === 0 || userId.length === 0 || conversation === undefined) return;
    const list = conversation.participants;
    const at = list.findIndex((entry) => entry.id === userId);
    if (at >= 0) list.splice(at, 1);
    list.unshift({ name: label, id: userId });
    if (list.length > PARTICIPANT_MAX) list.length = PARTICIPANT_MAX;
  }

  /**
   * 取出（或新建）一条入站消息所属的会话记录，并刷新发送者信息。
   *
   * `sender.name` 是**这一次**该怎么称呼这个人（群聊给群名片、私聊给昵称，与投递给模型的
   * 正文里那个写法必须逐字一致 —— `[[@昵称]]` 就是拿它去名单里查的）。
   */
  function conversationFor(type, id, sender) {
    const key = `${type}:${id}`;
    let conversation = conversations.get(key);
    if (conversation === undefined) {
      conversation = blankConversation(key, type, id);
      // 磁盘上说这个会话已经 reset 过几次，就从那一轮开始 —— 重启不该把
      // reset 之前那段会话 resume 回来。
      refreshSessionGeneration(conversation);
      // 建记录时就把「有人活动」记上：`touchActivity` 在 `admit` **之前**跑（那时这条
      // 记录还不存在），不补这一下，下一条消息算出来的静默时长永远是 0，`idleResetHours`
      // 就永远不会触发。从外面（`qq_send_message`）建出来的壳也照记 —— 它同样说明
      // 这个会话刚才有动静。
      conversation.lastActiveAt = Date.now();
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
    // 「谁可以被 @」的名单：说话的人自己，以及他这条消息里 @ 过的人（那群人显然在这个群里）。
    // 只有**带 QQ 号**的那些才登记得进来：没有号就 @ 不出去，编一个只会把 `at` 段发成
    // 一个谁也不是的号码。
    registerParticipant(conversation, sender?.name, sender?.userId);
    for (const mention of sender?.mentions ?? []) registerParticipant(conversation, mention.name, mention.id);
    return conversation;
  }

  /**
   * 造一个「昵称 → QQ 号」的解析函数，喂给 `mention.js` 把 `[[@昵称]]` 换成 at 段。
   *
   * 每次发送时现造（而不是缓存在会话上）：名单会随着新的发言者变，几行数组的查找
   * 比维护一份缓存的失效逻辑便宜得多。
   * @param conversation - 目标会话。
   * @returns `(name) => string | undefined`；`@全体成员` 只在群聊里解析得出来。
   */
  function conversationMentions(conversation) {
    return buildMentionResolver(conversation);
  }

  /**
   * prefix 触发时，把开头的指令前缀从正文里去掉。
   * 入站时先在占位文本上判定一次（决定这条消息要不要理），媒体落盘后再对真正的
   * 正文调用一次（那才是发给模型的内容）—— 两处用的是同一个函数。
   * @param text - 已 trim 的正文。
   * @returns 去掉前缀后的正文。
   */
  function dropPrefix(text) {
    return settings.groupTrigger === 'prefix' ? text.slice(settings.prefix.length).trim() : text;
  }

  /**
   * 准入判断：这条入站消息该不该送到它的 Agent。
   *
   * 只做**同步**判定（渠道开关、白名单、@/前缀触发、活跃对话窗口、正文非空），绝不碰
   * 网络：媒体落盘发生在 `handleEvent` 把它收进攒批队列之后。返回的 `message` 是原始
   * 消息段数组，真正的正文由调用方在媒体落盘后用 `messageToText(message, selfId, media)`
   * 再渲染一次；`preview` 是此刻（媒体还没落盘、只有占位符）的正文，只用来同步判定
   * `/reset` 这类指令，以及在「一条空消息」时给出那句说明（见 `blankReply`）。
   * @param event - 已解码的 OneBot 事件。
   * @param selfId - 机器人自己的 QQ 号。
   * @returns `{ conversation, message, preview, blankBody, quote, continued }`；该丢弃时为 undefined。
   *   `continued` 表示这条不是「被叫到」而是「活跃对话里接上的一句」（正文没有前缀可去）。
   *   `blankBody` 只在「没有正文」时为那句说明（见 `blankReply`），否则为空串。
   */
  function admit(event, selfId) {
    if (event?.post_type !== 'message') return undefined;
    // 机器人自己发的消息一律排除（本机的 NapCat 关着 `reportSelfMessage`，本来收不到；
    // 换个开着回灌的部署，这些回音也不该被当成「有人在跟它说话」）。selfId 未就绪时同样不处理。
    if (String(event.user_id ?? '') === String(selfId) || selfId === '') return undefined;
    const message = event.message ?? event.raw_message;
    const isGroup = event.message_type === 'group';
    const sender = event.sender ?? {};
    if (isGroup) {
      if (!settings.groupChat) return undefined;
      const groupId = String(event.group_id);
      if (settings.allowGroups.length > 0 && !settings.allowGroups.includes(groupId)) return undefined;
      const userId = String(event.user_id ?? '');
      // 这一次该怎么称呼这个人。**只有这一个地方决定**（群聊给群名片、其次昵称），
      // 因为投递给模型的正文里就写作 `名字: 内容`，而 `[[@名字]]` 拿的正是同一串字去
      // 名单里查（见 `registerParticipant`）—— 两处各算一次早晚会不一样。
      const displayName = userDisplayName(sender, event.user_id);
      // 这一句有没有 @ 机器人，后面两处都要用：判显式触发，以及空消息的替身该写成
      // 「@ 了你一下」还是「一条空消息」。
      const mentionedMe = mentions(message, selfId);
      const prefixed = settings.groupTrigger === 'prefix' && messageToText(message).trimStart().startsWith(settings.prefix);
      // 显式触发：@ 了机器人、按配置用了前缀、或者 groupTrigger 本来就允许所有消息。
      const explicit = settings.groupTrigger === 'all' || mentionedMe || prefixed;
      // 这里只用**占位符**版本判定「这条消息有没有内容」：媒体下载是异步的，此刻还没
      // 落盘，而 `[图片]` 这样的占位符已经足够说明「他发了点东西」。真正的正文在
      // handleEvent 里等媒体落盘后再渲染一次。
      // 传入 selfId 是为了按 account 精确剔除 @机器人 段，而不是事后从扁平文本里砍掉
      // 开头的 `@…` —— 这样 `@bot你好` 才能完整保留成 `你好`（昵称含空格也不会被误删）。
      const rawText = messageToText(message, selfId).trim();
      // 前缀只在**显式带前缀**的那条上剥掉：活跃对话里接上的那句本来就没有前缀，
      // 按前缀长度硬切会把「然后呢」切成「后呢」（见 dropPrefix）。
      const preview = prefixed ? dropPrefix(rawText) : rawText;
      // 没有正文：单纯的 @、或者就是一个空格。这和「被叫到之后闲聊」是两回事 —— 对方
      // 明确点了名却什么都没说，本身就是一种信号（想让它接上一句、或者就是想看它反应）。
      // 所以显式的空消息照常放行，只把正文位置换成一句说明，由模型接着上下文决定回
      // 「？」、发张表情、还是接上一句（`blankReply` 关掉时回到「静默丢弃」）。
      //
      // 两处刻意收紧：活跃对话窗口里接上的空消息不算（那只是「他说了句话，正好没内容」，
      // 不是点名，接上去就成了抢答）；前缀模式下按前缀长度硬切出空串也不算（那不是空消息，
      // 是没内容可切，别硬凑一句话回）。
      //
      // 这段判定放在抽卡**之前**：反正要被丢掉的空消息不该消耗连丢计数，也不该把一对一
      // 窗口往后滑 —— 一条什么都没说的消息不算「还在跟它说话」。
      const blank = preview.length === 0 && explicit && !prefixed;
      if (preview.length === 0 && !blank) return undefined;
      if (blank && settings.blankReply !== true) return undefined;
      // 这一条要不要接、以什么身份接 —— 判据全在 `speech-policy.js`（纯函数，可单测）。
      // 这里只做两件事：把会话记录与 chatter 的读数凑成入参；按结论记账。
      //   - `existing`：只认**已经存在**的会话（闲聊不该因为「窗口」把某个群变成处理过的群）；
      //   - `groupTalkActive`：C 路的热度（纯查询，不存状态）；
      //   - `activeFollowAllows`：A 路的七条判据。
      const existing = conversations.get(`group:${groupId}`);
      const groupTalk = !explicit && existing !== undefined && groupTalkActive(groupId);
      const followed = !explicit && existing !== undefined && activeFollowAllows(existing, userId, message, selfId);
      // C 路的四条排除要拿到的「这条消息长什么样」：
      //   - `hasText`：纯媒体（只有图/表情/语音）没有可接的话头，锚点必须是文字；
      //   - `isCommand`：命令不该被「插话」顺手执行；
      //   - `mentionsOthers`：@ 了别人的句子是别人在说话。
      const decision = decideGroupTurn({
        explicit,
        blank,
        existing: existing !== undefined,
        followAllowed: followed,
        groupHot: groupTalk,
        mentionsOthers: mentionsOthers(message, selfId),
        // 命令判定用剥前缀**之前**的正文：`groupTrigger: prefix` 会把开头的 `/` 吃掉。
        isCommand: rawText.startsWith('/') || (resetCommand.length > 0 && preview.toLowerCase() === resetCommand),
        // 「有没有文字」要按**消息段**判，不能看渲染后的正文：纯图消息的正文是
        // `[图片]`，那是占位符不是话头，插话的锚点必须是真人写下的字。
        hasText: Array.isArray(message)
          ? message.some((segment) => segment?.type === 'text' && String(segment?.data?.text ?? '').trim().length > 0)
          : String(message ?? '').trim().length > 0,
        selfMessage: String(event.user_id ?? '') === String(selfId),
        misses: existing?.talkMisses ?? 0,
        chance: settings.activeTalkChance,
        chanceStep: settings.activeTalkChanceStep,
        chanceMax: settings.activeTalkChanceMax,
        roll: Math.random(),
      });
      const intent = decision.intent;
      const continued = intent === 'continued' || intent === 'interject';
      if (existing !== undefined) {
        const who = describeConversation(existing);
        if (intent === 'continued' || intent === 'interject') {
          existing.talkMisses = 0;
          report(
            'info',
            decision.reason === 'follow'
              ? `${who} 免 @ 接话（一对一窗口里，直接回）：continued`
              : `${who} 插话抽中（概率 ${Math.round(decision.chance * 100)}%）：interject`,
          );
        } else if (decision.eligible) {
          // 走到 `eligible` 的只剩多人搭话：抽卡没抽中，把「连丢」+1（下一次概率更高）。
          // 一对一的免 @ 接话不抽卡（见 speaking-rules.js 的 `activeFollowAllows`），
          // 所以这里没有「A 路没抽中也要窗口照滑、条数照扣」那一段了。
          existing.talkMisses = (Number(existing.talkMisses) || 0) + 1;
          report('info', `${who} 搭话没抽中（概率 ${Math.round(decision.chance * 100)}%，已连丢 ${existing.talkMisses} 条，原因 ${decision.reason}）：这一句不接`);
        } else if (decision.reason === 'not-eligible' && existing.talkMisses) {
          // 既不在一对一窗口里、群也没聊热：这段对话凉了，累计清零，下次重新从起始概率攒
          // —— 不然半小时前攒下的「保底」会在一段全新的聊天开头突然炸出来。
          existing.talkMisses = 0;
        }
      }
      if (intent === 'none' && !explicit) return undefined;
      // 空消息的说明在这里算**一次**、往下传给 `submitBatch`：那边是媒体落盘后重新渲染
      // 的正文（`at` 段同样会被剔掉，仍然是空），若让它自己再拼一句，就得把「有没有 @」
      // 这件事也带下去，多一份要同步维护的状态（第一版正是这么写的，@ 与空消息的措辞串了）。
      const blankBody = blank ? blankMessageLabel({ group: true, mentionedMe }) : '';
      const conversation = conversationFor('group', groupId, {
        groupName: '',
        userId: event.user_id,
        userName: displayName,
        name: displayName,
        mentions: atMentions(message, selfId),
      });
      // 被明确叫到（@ / 前缀 / groupTrigger: all）就直接回，不抽卡；它刚说过话，累计的
      // 「连丢」也该清零 —— 否则抽卡那点保底会攒到它刚回完的下一句上。
      if (explicit) conversation.talkMisses = 0;
      // 这对一的窗口怎么滑，按 `intent` 分三种口径（见 `noteActiveMessage`）：
      // 被叫到 = 开一段新的，接着聊 = 往后滑一条，插话 = 不买一对一（只顺手记补一句的账）。
      noteActiveMessage(conversation, userId, intent);
      return {
        conversation,
        message,
        preview: blank ? blankBody : preview,
        blankBody,
        continued,
        // 为什么轮到它（见 speech-policy.js）：addressed / continued / interject。
        intent: explicit ? 'addressed' : intent,
        // 这次该怎么称呼他：`submitBatch` 把它交给模型（正文里的 `昵称:` 与它逐字一致），
        // 模型回话时写 `[[@昵称]]` 就能把这个人 @ 出来。
        displayName,
        // 回复指向：引用被回复的那条消息（`reply` 段要 message_id），或 @ 回提问者（要 QQ 号）。
        // `seq` 是这条消息在群里的进度，供 `auto` 判断「等我回话时有没有人（包括我自己）
        // 又说了话」。三样都在这里一次性快照：发送在几秒后，那时会话记录和群里的进度都可能变了。
        // `emoji`：这条本身只有表情，回复它时不挂引用（见 `quoteHead`）。
        quote: {
          messageId: String(event.message_id ?? ''),
          userId: String(event.user_id ?? ''),
          seq: chatter.anchor(groupId),
          emoji: isEmojiOnlyMessage(message),
        },
      };
    }
    if (!settings.privateChat) return undefined;
    const userId = String(event.user_id);
    if (settings.allowUsers.length > 0 && !settings.allowUsers.includes(userId)) return undefined;
    const text = messageToText(message, selfId).trim();
    // 私聊本来就不需要 @，所以「空消息」在这里是明摆着的「跟你打个招呼但没写事」——
    // 同样交给模型看着上下文决定回什么（`blankReply` 关掉时照旧丢弃）。用占位符当
    // preview，既让模型看得懂，也让下面 `submitBatch` 那条「整批都是空的就什么都不发」
    // 的兜底对得上（否则查询类工具会看到一条空正文）。
    const blank = text.length === 0;
    if (blank && settings.blankReply !== true) return undefined;
    const blankBody = blank ? blankMessageLabel({ group: false }) : '';
    const preview = blank ? blankBody : dropPrefix(text);
    const displayName = String(sender.nickname ?? sender.card ?? userId);
    const conversation = conversationFor('private', userId, {
      userId,
      userName: displayName,
      name: displayName,
    });
    // 私聊的每条消息本来就都是「跟它说的」，所以活跃对话在私聊里不需要额外判定 ——
    // 只要把这个窗口往后滑，它回完之后才可能自己补一句（见 scheduleChime）。
    noteActiveMessage(conversation, userId, 'addressed');
    return {
      conversation,
      message,
      preview,
      blankBody,
      continued: false,
      intent: 'addressed',
      displayName,
      // 私聊始终是 plain，`seq` / `emoji` 只是让 quote 的字段形状保持一致。
      quote: {
        messageId: String(event.message_id ?? ''),
        userId: String(event.user_id ?? ''),
        seq: 0,
        emoji: isEmojiOnlyMessage(message),
      },
    };
  }

  /**
   * 记一次「群里又有人说话了」，返回该群当前**别人**说话的插话序号。
   *
   * 别人的一句话要同时喂两条判据（回答指向的序号 + 多人搭话的热度窗口），而两条判据
   * 都**只算别人** —— 我自己说话不该把自己的一对一窗口打断，也不该把自己算进「几个人在聊」。
   * 机器人自己发的话走 `noteOwnMessage`，不从事件里来。
   * @param event - 已解码的 OneBot 事件。
   * @param selfId - 机器人自己的 QQ 号。
   * @returns 该群在计入这条消息之后的插话序号。
   */
  function noteChatter(event, selfId) {
    if (event?.message_type !== 'group') return 0;
    // 自己的话不在这里记：这个部署的 NapCat 配着 `reportSelfMessage: false`，自己发的消息
    // 根本不会回灌成事件；就算哪个部署开着回灌，那也在 `noteOwnMessage` 记过一遍了。
    if (String(event.user_id ?? '') === String(selfId)) return 0;
    return chatter.noteOther(String(event.group_id), String(event.user_id ?? ''), Date.now(), {
      windowMs: settings.activeWindowMs,
      keepLines: settings.activeGroupLines,
    });
  }

  /**
   * 记一次「我自己往这个群发了一条消息」。
   *
   * 为什么在**发出去**的那一刻记、而不是等 QQ 回灌：本机的 NapCat 里
   * `reportSelfMessage: false`（`onebot11_<QQ>.json` 的 websocketServers），自己发出去的话
   * 一条都不会回来 —— 而「我回的那条被我自己后来的话挤远了」恰恰是最需要点名的情况
   * （上一轮的回复、复读、主动搭话都算）。所以出站这几条路（`sendOne`、两个发送工具、

   * @param type - `'group'` / `'private'`（私聊不挂指向，直接不记）。
   * @param id - 群号。
   */
  function noteOwnMessage(type, id) {
    if (type !== 'group') return;
    chatter.noteSelf(String(id));
  }

  /**
   * 记一次「这个会话刚才有人在说话」，供主动说话判断群是不是安静了。
   *
   * 与 `noteChatter` 的区别：那个记的是「群里的进度序号」（回复指向用），只对群有效；
   * 这个记的是「时间」，而且**含没 @ 机器人的闲聊** —— 群里正聊得热火朝天时，
   * 主动搭话恰恰最不该发生，所以那些没人理机器人的消息也必须算作活跃。
   *
   * 只更新**已经存在**的会话记录：没聊过的群不该因为一条闲聊就变成候选（这也是
   * 「主动说话只对已经聊过的群生效」的落点）。机器人自己的消息不算活跃，按 selfId 排除
   * （这个部署里也回灌不回来，见 `noteOwnMessage`）。
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
    noteConversationActivity(conversation);
  }

  /**
   * 记一次「这个会话有人活动」：先算刚才安静了多久，再刷新时刻。
   *
   * 顺序不能反 —— 静默换代（`idleResetHours`）读的是 `idleMs`，它必须在 `lastActiveAt`
   * 被覆盖之前算出来（见 `maybeIdleReset`）。
   * @param conversation - 目标会话。
   * @param now - 当前时刻（测试/调用点省一次 Date.now）。
   */
  function noteConversationActivity(conversation, now = Date.now()) {
    const previous = Number(conversation.lastActiveAt) || 0;
    conversation.idleMs = previous > 0 ? Math.max(0, now - previous) : 0;
    conversation.lastActiveAt = now;
  }

  /**
   * 记一条「它看见过这个会话里的这句话」—— 撤回时唯一能回答「撤的是哪句」的账。
   *
   * 三条纪律，都是刻意与别的缓冲对齐的：
   *
   *   1. **必须在 `admit` 之前**：`admit` 会快照 `quote`（撤回时要清的是同一个对象），
   *      而且 `admit === undefined` 的闲聊也要记 —— 撤回不认「有没有 @ 它」。
   *      它在 `handleEvent` 里紧跟「这条是不是消息」的判定，于是所有提前 `return`
   *      都在它后面，「刚发就撤」的那几十毫秒不会漏。
   *   2. **准入边界照抄 `rememberTranscript`**（渠道开关 + 白名单）：不设这一道，等于
   *      给没被允许的群/陌生人开了一个「把文本留在内存里」的入口。
   *   3. **机器人自己的消息不记**：管理员撤了它的话是另一件事，混进来会让撤回判据把
   *      「我的话被撤了」当成「别人撤了」。
   *
   * `text` 用**占位符**版本（`[图片]` / `[表情]`）：撤回时不会为它去下载媒体，而这段文字
   * 默认根本不进提示词（只有 `recallTeaseQuote` 打开时才用），这里主要是给日志与可选引用。
   *
   * @param event - 已解码的 OneBot 事件。
   * @param selfId - 机器人自己的 QQ 号。
   */
  function noteSeen(event, selfId) {
    if (event?.post_type !== 'message') return;
    if (selfId === '' || String(event.user_id ?? '') === String(selfId)) return;
    const isGroup = event.message_type === 'group';
    if (isGroup) {
      if (!settings.groupChat) return;
      const groupId = String(event.group_id);
      if (settings.allowGroups.length > 0 && !settings.allowGroups.includes(groupId)) return;
    } else {
      if (!settings.privateChat) return;
      const userId = String(event.user_id);
      if (settings.allowUsers.length > 0 && !settings.allowUsers.includes(userId)) return;
    }
    const message = event.message ?? event.raw_message;
    const sender = event.sender ?? {};
    // 这一段与 `admit` 里的「显式触发」逐字对齐：撤回时判的必须是**当时**那个结论，
    // 不能重新猜一遍（两条判据一旦分开写，早晚会对不上）。
    const addressed = isGroup
      ? settings.groupTrigger === 'all'
        || mentions(message, selfId)
        || (settings.groupTrigger === 'prefix' && messageToText(message).trimStart().startsWith(settings.prefix))
      // 私聊的每条消息本来都是「跟它说的」，与 `admit` 的私聊分支同口径。
      : true;
    const key = isGroup ? `group:${event.group_id}` : `private:${event.user_id}`;
    const entry = {
      id: String(event.message_id ?? ''),
      userId: String(event.user_id ?? ''),
      // 与正文里的 `昵称: 内容` 和 `[[@昵称]]` 用的是同一串字（群名片优先，见 userDisplayName）。
      name: userDisplayName(sender, event.user_id),
      text: messageToText(message, selfId).replace(/\s+/g, ' ').trim().slice(0, RECENT_TEXT_MAX),
      at: Date.now(),
      addressed,
      // 三个进度/决定字段的语义要分清：`recalled` 是**事实**（去重）、`action` 是**决定**
      // （这条不许投 / 投的时候换成撤回提示）、`submitted` / `replied` 是**进度**。
      // 混成一个布尔值，「照常答、只是不引用」那条路就没法表达。
      submitted: false,
      replied: false,
      recalled: false,
      action: undefined,
    };
    const list = recent.get(key) ?? [];
    list.push(entry);
    if (list.length > RECENT_MAX) list.splice(0, list.length - RECENT_MAX);
    recent.set(key, list);
  }

  /**
   * 在「最近看见过」里按 `message_id` 找一条。
   *
   * id 一律 `String()` 再比：OneBot 实现有时给数字、有时给字符串（`toId` 同口径）。
   * 找不到就是**没看见过** —— 那是一个有效状态（重启后、或者这条消息本来就落在窗口外），
   * 不是错误。
   *
   * @param key - 会话 key。
   * @param messageId - 撤回事件里的 `message_id`。
   * @returns 账上的那一条；没有时 undefined。
   */
  function findRecent(key, messageId) {
    const id = String(messageId ?? '');
    if (id.length === 0) return undefined;
    const list = recent.get(key);
    if (list === undefined) return undefined;
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (list[index].id === id) return list[index];
    }
    return undefined;
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
    const limit = Math.floor(Number(settings.ambientMessages) || 0);
    if (limit <= 0) return;
    if (!settings.groupChat || event?.message_type !== 'group') return;
    if (String(event.user_id ?? '') === String(selfId)) return;
    const groupId = String(event.group_id);
    if (settings.allowGroups.length > 0 && !settings.allowGroups.includes(groupId)) return;
    // 折掉换行：多行消息会破坏「昵称: 内容」一行一条的版式。
    // 媒体默认**也**落盘（`ambientMedia`），这样「有人刚才发了张表情包」之后被 @ 时它真的
    // 看得见；关掉这个开关就退回成「只留一句占位符」，不为闲聊花带宽和磁盘。
    const raw = event.message ?? event.raw_message;
    const text = messageToText(raw).replace(/\s+/g, ' ').trim();
    if (text.length === 0) return;
    const sender = event.sender ?? {};
    const name = String(sender.card ?? sender.nickname ?? event.user_id ?? '某人');
    const lineChars = Math.max(1, Math.floor(Number(settings.ambientLineChars) || 120));
    const list = ambient.get(groupId) ?? [];
    // `id` 是为了「撤回时精确摘掉那一行」。删除必须按 id 或对象引用，**不能按文本比**：
    // 下一行的 `hydrateAmbientMedia` 会把这个 `text` 异步改写成带本地路径的版本，
    // 落盘前后文本不一样。
    const entry = { id: String(event.message_id ?? ''), name, text: text.slice(0, lineChars) };
    list.push(entry);
    while (list.length > limit) list.shift();
    ambient.set(groupId, list);
    // 在群里说过话的人也要进「可以被 @」的名单：环境上下文里那些人正是模型最可能想点名的
    // （「刚才说吃啥的那位」）。只认**已经有会话记录**的群 —— 闲聊不该凭空建出会话记录来。
    registerParticipant(conversations.get(`group:${groupId}`), name, event.user_id);
    // 先按占位符入缓冲（提示词立刻可用），下载完成后再就地改写成带路径的版本。
    if (settings.ambientMedia) void hydrateAmbientMedia(raw, entry, lineChars);
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
   * **一串只跟一次**：跟过之后链留着并标成 `repeated`，后面再来同样的消息只记账、
   * 不再跟 —— 直到中间有人说了别的话（链被换掉）或者隔得超过 `repeatWindowMs`。
   * 否则群里连着刷同一个字时，它会每隔两条就跟着刷一次（真实事故：四个人连发同一张
   * 表情包，它跟了两次）。
   *
   * 判定要下载表情包才知道是不是同一张（异步），所以整个判定挂在每个群自己的串行链
   * `state.queue` 上按到达顺序跑 —— 见 `repeatStates`。
   *
   * @param event - 已解码的 OneBot 事件。
   * @param selfId - 机器人自己的 QQ 号（机器人自己的消息不入链，也不打断链）。
   * @param canAct - 这条消息能不能触发复读（被 @ 的那条只能记账，不能跟）。
   */
  function maybeRepeat(event, selfId, canAct) {
    if (!settings.repeat) return;
    if (!settings.groupChat || event?.message_type !== 'group') return;
    const groupId = String(event.group_id);
    if (settings.allowGroups.length > 0 && !settings.allowGroups.includes(groupId)) return;
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
    const windowMs = Math.max(0, Math.floor(Number(settings.repeatWindowMs) || 0));
    const chained =
      previous !== undefined &&
      (windowMs <= 0 || arrivedAt - previous.at <= windowMs) &&
      (await sameCandidate(previous, candidate));
    const senders = chained ? [...new Set([...previous.senders, userId])] : [userId];
    const count = chained ? previous.count + 1 : 1;
    const threshold = Math.max(2, Math.floor(Number(settings.repeatCount) || 0));
    const distinct = settings.repeatDistinct ? senders.length >= 2 : true;
    // 「表情还是普通图片」在链上**累加**：同一张图只要在这条链上以表情出现过（`sub_type`
    // 非 0 / 带 `emoji_id`），后面哪怕被另存或转发成普通图片再发一次，复读也按表情发。
    // 真实事故：19:53 一条表情、19:54 同一张图被当图片发了一遍，复读跟的是后一条的
    // `sub_type: 0`，群里看到的又是照片样式的图。反过来不成立：链里从没出现过表情的
    // 截图/照片仍是普通图片（标成表情会被 QQ 裁小），所以这里只做 OR，不按「像不像」猜。
    const sticker = candidate.sticker === true || (chained && previous?.sticker === true);
    // 「这一串已经跟过了」也记在链上：跟过一次之后，同一串里剩下的相同消息只记账、
    // 不再跟 —— 直到被别的话打断（链被换掉）或超出 `repeatWindowMs`（重新攒）。
    // 之前是「跟完就把链清空」，于是 4 条相同的消息会跟 2 次（第 3、4 条又凑成一对），
    // 群里看到的就是连着发两条（2026-10-20 的真实事故）。
    const repeated = chained && previous?.repeated === true;
    const entry = { ...candidate, sticker, count, senders, at: arrivedAt, repeated };
    if (repeated || !canAct || count < threshold || !distinct) {
      state.chain = entry;
      return;
    }
    const chance = Math.min(1, Math.max(0, Number(settings.repeatChance)));
    if (!(Math.random() < chance)) {
      // 这次没跟：链留着，下一条相同的消息再掷一次，而不是重新攒人数。
      state.chain = entry;
      return;
    }
    // 跟过之后链**留着**、标记成 `repeated`：这一串到此为止，下一串要重新攒人数。
    state.chain = { ...entry, repeated: true };
    const conversation = targetConversation('group', groupId);
    report('info', `→ ${describeConversation(conversation)}: ${describeRepeat(entry)}（复读）`);
    sendRepeat(conversation, entry);
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
   * @returns `{ kind, key, raw }` / `{ kind, key, path, sticker }` / `{ kind, key, id }`；
   *   不复读时 undefined。`sticker` 表示原消息是表情（见 {@link isStickerSegment}），
   *   复读时照它决定带不带 QQ 的大表情标记。
   */
  async function repeatCandidate(message) {
    const text = repeatableText(message);
    if (text !== undefined) {
      const raw = text.trim();
      if (raw.length === 0) return undefined;
      const maxChars = Math.floor(Number(settings.repeatMaxChars));
      if (Number.isFinite(maxChars) && maxChars > 0 && raw.length > maxChars) return undefined;
      return { kind: 'text', key: `text:${raw.replace(/\s+/g, ' ')}`, raw };
    }
    // 表情包复读**不自己下载**：判「是不是同一张」只能靠内容哈希，而那份字节正是环境上下文
    // 落盘时留下的（`mediaFor` 按消息对象共用同一次下载，所以默认配置下它一次带宽都不多花）。
    // 于是关掉 `ambientMedia`、或者把 `ambientMessages` 设成 0（群聊上下文整个关掉）时，
    // 群里的图根本不会被取下来 —— 表情包复读自动退化成「只复读文字」，不会偷偷花带宽。
    const ambientDownloads = settings.ambientMedia && Math.floor(Number(settings.ambientMessages) || 0) > 0;
    if (!settings.repeatMedia || !imageSend || !ambientDownloads) return undefined;
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
    // 记下「原消息是表情还是普通图片」（只留布尔值）：复读要原样接上，连渲染样式一起。
    return { kind: 'image', key: `image:${outcome.path}`, path: outcome.path, sticker: isStickerSegment(only) };
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
   * （读本地文件、校验格式与大小、base64 交给 NapCat）；带不带「大表情」标记看链上
   * 累加出来的 `sticker`（`repeatStep` 里把原消息的类型做 OR，见那里的注释）。发不出去
   * 只记一条 warn —— 复读本来就是插话，静默不跟比在群里喊一句「我发不出去」更像真人。
   *
   * @param conversation - 目标会话。
   * @param candidate - {@link repeatCandidate} 的结果（或 `repeatStep` 里补过 `sticker` 的链条目）。
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
      // 原消息是什么就按什么发：群里那张是表情（`sub_type` 非 0 的收藏表情 / 商城表情），
      // 复读也带 QQ 的大表情标记，群里看到的才是同一张表情；原来是照片/截图就照旧按普通
      // 图片发 —— 把长图标成表情会被 QQ 按表情裁小。判定在 `isStickerSegment`。
      await sendOne(conversation, [imageSegment(bytes, { sticker: candidate.sticker === true })]);
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
  const proactiveEnabled = settings.proactive === true;




  /**
   * 这个会话的「今天」计数（跨天就地归零），返回今天已经主动说过几次。
   *
   * 计数刻意放在**内存**里：重启后归零是可以接受的（重启本身很稀有，而且重启后
   * 至少要等 `proactiveIdleMs` 才可能开口），换成落盘状态得多维护一个文件，
   * 与 `ambient` / 复读链这些运行时状态的口径也一致。
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
    const prefix = `${sessionIdFor(conversation.key, conversation.sessionGeneration ?? 0)}:`;
    for (const slot of turnOwners.keys()) {
      if (slot.startsWith(prefix)) return true;
    }
    for (const owner of submitted.values()) {
      if (owner.key === conversation.key) return true;
    }
    return false;
  }

  /**
   * 这个群现在值不值得主动搭一句话。
   *
   * 判据本身（五道闸门 + 两个节奏闸）在 `speaking-rules.js` 的 `proactiveEligible` 里，
   * 那里能用普通入参直接验；这里只做一件事：把会话记录与配置凑成那份入参。
   * @param conversation - 候选会话。
   * @param now - 当前时刻（毫秒）。
   * @returns 可以开口时为 true。
   */
  function proactiveEligible(conversation, now) {
    return proactiveEligibleRule({
      type: conversation.type,
      hasQueuedBatch: conversation.pending.length > 0 || conversation.batchTimer !== undefined,
      busy: busyWithTurn(conversation),
      lastActiveAt: conversation.lastActiveAt,
      lastBotSpeakAt: conversation.lastBotSpeakAt,
      lastProactiveAt: conversation.lastProactiveAt,
      // 这个读数带「跨天就地归零」的副作用，所以只有走到这里才取 —— 判据本身是纯的，
      // 取数这一步不是。
      todayCount: proactiveTodayCount(conversation),
      now,
      idleMs: settings.proactiveIdleMs,
      freshMs: settings.proactiveFreshMs,
      gapMs: settings.proactiveGapMs,
      dailyMax: settings.proactiveDailyMax,
    });
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
    // 人设的「主动搭话」场景段读它（`personaSceneFor`）；turn/end 会清掉。
    conversation.pendingIntent = 'proactive';
    const quietMs = Math.max(0, now - (Number(conversation.lastActiveAt) || now));
    report('info', `${describeConversation(conversation)} 已经安静 ${Math.round(quietMs / 60000)} 分钟，主动开个话头`);
    enqueue(conversation, async () => {
      try {
        const text = proactiveNudge(quietMs);
        noteRecallFallback(conversation);
        const agent = await ensureAgent(conversation);
        const userMessage = userMessageFor(conversation, text);
        // `proactive: true` 是本轮唯一的身份标记：turn 结束时靠它区分「主动搭话」
        // 与「回别人的话」—— 前者判成 SKIP 要静默丢弃，出错也不该在群里道歉。
        submitted.set(userMessage.id, {
          key: conversation.key,
          quote: { messageId: '', userId: '', seq: 0 },
          proactive: true,
          intent: 'proactive',
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
    const from = Number(settings.proactiveFromHour);
    const to = Number(settings.proactiveToHour);
    if (!withinActiveHours(from, to, new Date().getHours())) return;
    const chance = Math.min(1, Math.max(0, Number(settings.proactiveChance)));
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
  // 就把话题掐掉。三件事各有各的窗口：
  //
  //   A. 免 @ 接话（`activeFollow` / `activeFollowIdleMs`）：被叫到之后，正在跟它聊的那个人
  //      接着说的话也算在跟它聊。窗口（默认 3 分钟，两条之间的间隔）与条数（`activeMaxTurns`）
  //      一起封住这件事 —— **够资格就是回**，不掷骰子：对面只有一个人，而且刚跟它说完话。
  //   B. 自己补一句（`activeChime*`）：它回完之后对方安静了一小会儿，它可能再追一句；
  //      看的是 `activeUntil`（`activeWindowMs`，默认 1 分钟）。
  //   C. **多人搭话**（`activeGroup*`）：群里几个人自己聊了起来（最近 `activeWindowMs` 里
  //      够条数、够人数），它就进入搭话状态 —— 那之后谁接话都算数，而且「倾听时间」变长
  //      （攒批更久），多听几句才合成一轮回复。
  //
  // A 与 C 的区别正是「要不要抽卡」：C 路够热不等于就接，还要按 `activeTalkChance` 一族
  // 掷一次会自己涨的概率（见 speaking-rules.js）—— 人多嘴杂的群里「够热就每条都回」会变成
  // 刷屏。A 路不抽：那一段里只有一个人，抽卡只会让「接着聊」名存实亡。
  //
  // 两个窗口都只靠**别人发来的消息**往后滑（机器人自己说的话不算，否则它自己就能给窗口续命）；
  // 一对一窗口里有人插话，这次「你跟我聊」就算断了，要重新叫它一次 —— 但插话本身会记进
  // 热度窗口，大家一起说的话够多、够热闹时，走的就是 C 而不是 A 了（这就是
  // 「有人插话就考虑进入多人搭话」的落点）。



  /** 免 @ 接话的条数还有余额吗（`activeMaxTurns` 为 0 表示不限）。 */
  function activeTurnsLeft(conversation) {
    return activeTurnsLeftRule(settings.activeMaxTurns, conversation.activeTurns);
  }




  /**
   * 这个群现在算不算「大家正聊着」（多人搭话）？
   *
   * 判据全在最近 `activeWindowMs` 这一段里：**别人**说的话够 `activeGroupLines` 条，
   * 且来自 `activeGroupSpeakers` 个不同的人。两个条件一起卡住两类误判：一个人自己刷屏
   * 凑不出「几个人」，而两个人半天说一句也凑不出「聊起来了」。
   *
   * 它是**纯查询**（不写状态）：搭话状态因此不会赖着不走 —— 大家一停，窗口自己就空了，
   * 下一次消息重新判。这也让「插话」自然成为进入方式之一：有人接一句，人数与条数就往上走。
   *
   * 进入搭话状态不等于每条都回：它只是「够资格抽卡」（见 `admit` 里那一抽与
   * speaking-rules.js 的 `activeTalkChance`）。
   *
   * @param groupId - 群号。
   * @returns 现在算多人搭话时为 true。
   */
  function groupTalkActive(groupId) {
    if (settings.activeFollow !== true) return false;
    return chatter.isHot(groupId, settings.activeWindowMs, settings.activeGroupLines, settings.activeGroupSpeakers);
  }




  /**
   * 记一次「这个会话正聊着」，把活跃窗口往后滑。
   *
   * 由 `admit` 在三条路上调用，口径**刻意不同**（`mode`）：
   *   - `'addressed'`：被叫到（@ / 前缀 / `groupTrigger: all`）或私聊的一条消息 —— 开一段
   *     新的一对一（说话人换成他、条数归零）；
   *   - `'continued'`：一对一窗口里他接着说的那句 —— 往后滑一条、条数 +1；
   *   - `'interject'`：多人搭话里它顺手接了一句 —— **不买一对一**。那一句只是顺着群里的
   *     气氛接的，说话人并没有「正在跟它聊」这层关系；给他开一段三分钟的免 @ 窗口会让热群里
   *     每个被接话的人都白拿一段「每条都回」。
   *
   * `activeUntil` 与 `followUntil` 是两个窗口，别合并：前者（`activeWindowMs`）管「补一句」
   * 与多人搭话的热度，后者（`activeFollowIdleMs`）只管一对一的免 @ 接话 —— 那个要宽得多
   * （默认 3 分钟，60 秒里对方回一句就过期了）。
   *
   * `activeInterposeSeq` 记的是这条消息那一刻的**插话序号**：用来判断「这条之后有没有别人说过话」，
   * 见 `activeFollowAllows` 与 `runChime`。
   *
   * @param conversation - 这条消息所属的会话。
   * @param userId - 发消息的人（群里只有他接着说的话才可能免 @ 算进来）。
   * @param mode - `'addressed'` / `'continued'` / `'interject'`（见上）。
   */
  function noteActiveMessage(conversation, userId, mode) {
    const now = Date.now();
    conversation.activeUntil = now + settings.activeWindowMs;
    // 对方又说话了：这一句对应的「补一句」额度重新算，旧的那个定时器也就作废了。
    conversation.chimeCount = 0;
    cancelChime(conversation);
    if (mode === 'interject') {
      // 插话之后没有人处在「一对一」里：既不给被接话的人免 @，也不把此刻的群进度当成
      // 一对一的快照（那会让一个本该断掉的一对一在后面又「对上」）。
      conversation.activeSpeakerId = '';
      conversation.followUntil = 0;
      conversation.activeTurns = 0;
      conversation.activeInterposeSeq = chatter.others(conversation.id);
      return;
    }
    conversation.followUntil = now + settings.activeFollowIdleMs;
    conversation.activeSpeakerId = userId;
    conversation.activeTurns = mode === 'continued' ? (conversation.activeTurns ?? 0) + 1 : 0;
    if (conversation.type === 'group') conversation.activeInterposeSeq = chatter.others(conversation.id);
  }

  /**
   * 这条**没被叫到**的群消息能不能算「接着聊」（见 AGENTS.md §4.F 的 A 路）。
   *
   * 七条判据在 `speaking-rules.js` 的 `activeFollowAllows` 里（那里逐条写着为什么）；
   * 这里只把会话状态、插话序号与配置凑成那份入参。这一步放松的是「群里只在被 @ 时
   * 才说话」这条默认约定，宁可少接一句也别抢话 —— 但够资格就是**真的回**（A 路不抽卡，
   * 每句都回，条数由 `activeMaxTurns` 封顶）。
   * @param conversation - 已有的会话记录。
   * @param userId - 发消息的人。
   * @param message - OneBot 的 `message` 字段。
   * @param selfId - 机器人自己的 QQ 号。
   * @returns 可以当「接话」时为 true。
   */
  function activeFollowAllows(conversation, userId, message, selfId) {
    return activeFollowAllowsRule({
      enabled: settings.activeFollow === true,
      // `activeWindowMs` 仍然是整套活跃对话的总开关（0 = 免 @ 接话 / 补一句 / 多人搭话全关）；
      // 它自己的 60 秒只留给补一句与多人搭话的热度，一对一用更宽的 `activeFollowIdleMs`。
      idleMs: settings.activeWindowMs > 0 ? settings.activeFollowIdleMs : 0,
      type: conversation.type,
      speakerId: conversation.activeSpeakerId,
      userId,
      followUntil: conversation.followUntil,
      turnsLeft: activeTurnsLeft(conversation),
      interposeOthers: chatter.others(conversation.id),
      interposeSnapshot: conversation.activeInterposeSeq,
      mentionsOthers: mentionsOthers(message, selfId),
      now: Date.now(),
    });
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
  function chimeDelay(conversation) {
    // 私聊用 `privateAfterthoughtIdleMs`（15 秒），群聊用 `activeChimeIdleMs`（20 秒）：
    // 两套节奏的语义不同（一个是对着一个具体的人，一个是在群里插一句），别互相借。
    const idle = conversation?.type === 'private' ? settings.privateAfterthoughtIdleMs : settings.activeChimeIdleMs;
    return chimeDelayRule(idle, settings.delayJitter, Math.random());
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
  function scheduleChime(conversation, owner) {
    // 空消息（单纯的 @、一个空格）之后的轮次不补：那一轮本来就没有话题可言。
    if (owner?.blank === true) return;
    // 刚接完一波积压也不补：它刚刚连着答完一群人的旧问题，再追一句「啊对了」是噪音。
    if (owner?.intent === 'backlog') return;
    if (conversation.type === 'private') {
      // 私聊补一句（L2）：只受它自己的开关约束 —— 不该被群聊那个 `proactive` 总开关连坐。
      if (settings.privateAfterthought !== true || settings.privateAfterthoughtIdleMs <= 0) return;
    } else {
      if (!proactiveEnabled) return; // 群聊补一句属于「主动说话」家族
      if (settings.activeWindowMs <= 0 || settings.activeChimeIdleMs <= 0 || settings.activeChimeMax <= 0) return;
    }
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
    }, chimeDelay(conversation));
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
    const now = Date.now();
    // 私聊：五道闸门在 `privateAfterthoughtAllows` 里（不看 activeUntil，也不看 proactive）。
    if (conversation.type === 'private') {
      const allowed = privateAfterthoughtAllows({
        enabled: settings.privateAfterthought === true,
        type: conversation.type,
        seqMatches: conversation.chimeSeq === seq,
        hasQueuedBatch: conversation.pending.length > 0 || conversation.batchTimer !== undefined,
        busy: busyWithTurn(conversation),
        chimeCount: conversation.chimeCount,
        chimeToday: chimeTodayUsed(conversation),
        dailyMax: settings.privateAfterthoughtDailyMax,
        lastBotSpeakAt: conversation.lastBotSpeakAt,
        lastActiveAt: conversation.lastActiveAt,
        chance: settings.privateAfterthoughtChance,
        roll: Math.random(),
      });
      if (allowed) chimeSpeak(conversation, now);
      return;
    }
    const allowed = chimeAllows({
      seqMatches: conversation.chimeSeq === seq,
      proactiveEnabled,
      now,
      activeUntil: conversation.activeUntil,
      hasQueuedBatch: conversation.pending.length > 0 || conversation.batchTimer !== undefined,
      busy: busyWithTurn(conversation),
      chimeCount: conversation.chimeCount,
      chimeMax: settings.activeChimeMax,
      // 同 proactiveEligible 的 todayCount：这个读数带跨天归零的副作用，走到这里才取。
      chimeToday: chimeTodayUsed(conversation),
      chimeDailyMax: settings.activeChimeDailyMax,
      lastBotSpeakAt: conversation.lastBotSpeakAt,
      lastActiveAt: conversation.lastActiveAt,
      type: conversation.type,
      interposeOthers: chatter.others(conversation.id),
      interposeSnapshot: conversation.activeInterposeSeq,
      chance: settings.proactiveChance,
      roll: Math.random(),
    });
    if (!allowed) return;
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
    conversation.pendingIntent = 'chime';
    const silenceSec = Math.max(1, Math.round((now - (Number(conversation.lastActiveAt) || now)) / 1000));
    report('info', `${describeConversation(conversation)} 对话还热着（对方安静了约 ${silenceSec} 秒），主动补一句`);
    enqueue(conversation, async () => {
      try {
        noteRecallFallback(conversation);
        const agent = await ensureAgent(conversation);
        const userMessage = userMessageFor(conversation, chimeNudge());
        // 与主动搭话同一个标记：turn 结束时按它分流（SKIP 静默、出错不道歉）。
        submitted.set(userMessage.id, {
          key: conversation.key,
          quote: { messageId: '', userId: '', seq: 0 },
          proactive: true,
          intent: 'proactive',
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
      '- 对方没接话，别追问太紧：没什么想说的就 SKIP，这很正常。',
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
    const items = [...collectMedia(message)];
    // 视频**只下封面**（默认开，`videoMaxBytes: 0` 表示不下载整段）：整段视频模型读不了
    // （read_image 只认图片），下它既花带宽又没用；封面是唯一能看见的一帧。
    if (settings.videoCover && Array.isArray(message)) {
      message.forEach((segment, index) => {
        if (segment?.type !== 'video') return;
        const data = segment.data ?? {};
        const url = typeof data.thumb === 'string' && data.thumb.length > 0
          ? data.thumb
          : (typeof data.cover === 'string' ? data.cover : '');
        if (url.length === 0) return;
        items.push({ index, kind: 'video', label: '', url, file: '', declaredBytes: undefined });
      });
    }
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
          if (item.kind === 'video') {
            // 视频的占位符由 modalities 统一渲染（时长 + 封面路径），别在这里另写一份格式。
            const observation = observationOf(message[item.index], { index: item.index });
            observation.meta = { ...observation.meta, coverPath: outcome.path };
            rendered.set(item.index, renderObservation(observation));
          } else {
            rendered.set(item.index, mediaPlaceholder(item, outcome.path));
          }
          return;
        }
        // 取不到不是错误路径上的意外：消息照常投递，只是模型看到的是一句「这里本来有张图」。
        report('warn', `media: could not fetch ${item.kind}${item.label.length > 0 ? ` "${item.label}"` : ''}: ${outcome.error}`);
        // 视频封面失败时**不**把错误写进正文：视频本身还在，写「封面没能取到文件」
        // 只会让模型以为这个视频坏了。占位符保持 `[视频 N 秒]` 即可。
        if (item.kind !== 'video') rendered.set(item.index, mediaPlaceholder(item, '', outcome.error));
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
    if (!settings.quoteMedia) return undefined;
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
   * @param entry - 已推进 `ambient` 缓冲区的条目（`{ id, name, text }`，就地改写 `text`）。
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
   * 这个会话现在的「倾听时间」倍数。
   *
   * 只有**多人搭话**的群会放大：大家正聊着的时候它该多听几句再开口，而不是每两秒截一句
   * 就回一轮。一对一的窗口不放大 —— 那边是「它正在跟你说话」，等太久反而像掉线。
   * @param conversation - 目标会话。
   * @returns 倍数（≥1）。
   */
  function batchScale(conversation) {
    // 私聊一律不放大（那边是「它正在跟你说话」，等太久像掉线）；先判类型再查热度，
    // 私聊连那次热度查询都省掉。
    if (conversation?.type !== 'group') return 1;
    return batchScaleRule('group', groupTalkActive(conversation.id), settings.activeGroupBatchScale);
  }

  /** 攒批窗口（毫秒）；配置非法或为 0 时返回 0，表示关闭攒批、来一条回一条。 */
  function batchWindow(scale) {
    return batchWindowRule(settings.batchWindowMs, scale);
  }

  /** 一批最多等多久（毫秒）。配置比窗口还小时没有意义，按下限（= 窗口）算；与窗口同倍放大。 */
  function batchCap(window, scale) {
    return batchCapRule(settings.batchMaxWaitMs, window, scale);
  }

  /**
   * 把一件「按到达顺序处理」的事挂到会话队列尾。
   *
   * 队列是每个会话一条的串行链：媒体落盘、确保 Agent 就绪、投递消息都在这条链上，
   * 处理顺序因此与消息到达顺序一致（否则「先发图、再说那句话」会被下载耗时颠倒）。
   * 失败时把原因回给发消息的人 —— 静默会被群里当成「机器人不理人」。
   * @returns 这条排进来的任务所在的队列承诺（`submitBatch` 用它在收尾时清 `submitting`）。
   */
  function enqueue(conversation, job) {
    conversation.queue = conversation.queue
      .then(job)
      .catch((error) => {
        const detail = error?.message ?? String(error);
        report('warn', `could not queue for ${conversation.key}: ${detail}`);
        void sendToConversation(conversation, `（我这边出错了：${detail}）`);
      });
    return conversation.queue;
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
   * 机器人会永远不吭声。多人搭话时这两个值一起按 `activeGroupBatchScale` 放大，
   * 于是它会多听几句再合成一轮（见 `batchScale`）。
   *
   * 它**正在忙**（上一轮还没跑完）时，这条消息不按「2 秒窗口」算，而是进一波迟到的
   * 消息（`entry.held`）：窗口到了也不投，等它闲下来合成一轮接（见 `flushBatch` /
   * `backlogBusy`）。不这么做的话，十分钟的长任务会攒出上百个 turn、上百条回复，
   * 每条都在回答几分钟前的问题。
   *
   * @param conversation - 目标会话。
   * @param entry - 已准入的这条消息 `{ message, name, userId, quote, at }`。
   */
  function holdForBatch(conversation, entry) {
    const scale = batchScale(conversation);
    const window = batchWindow(scale);
    if (window <= 0) {
      submitBatch(conversation, [entry]);
      return;
    }
    // 忙的时候到的消息都属于「一波迟到的对话」：多憋一会儿、回头一起接。
    // `batchBacklogHoldMs: 0` 是「不憋」—— 那样它就和关掉这一项一样，回到逐批排队。
    if (settings.batchBacklog === true && settings.batchBacklogHoldMs > 0 && backlogBusy(conversation)) entry.held = true;
    conversation.pending.push(entry);
    const cap = batchCap(window, scale);
    const since = conversation.pending[0].at;
    const wait = Math.max(0, Math.min(window, since + cap - Date.now(), MAX_TIMER_MS));
    if (conversation.batchTimer !== undefined) clearTimeout(conversation.batchTimer);
    conversation.batchTimer = setTimeout(() => flushBatch(conversation), wait);
    // 等待中的批次不该拖着进程不让退出（与 sleep 一致）。
    conversation.batchTimer.unref?.();
  }

  /**
   * 这个会话现在算不算「忙着」—— 攒批这边用的口径。
   *
   * 比 `busyWithTurn` 多算一件事：`submitBatch` 已经排上、但还没跑到 `followup` 的那段
   * 窗口。那段时间里 `submitted` 还是空的，只看它会把这个会话当成空闲，于是新到的消息
   * 可能被算进另一批、和正在投的那批分成两轮。
   * @param conversation - 目标会话。
   * @returns 忙时为 true。
   */
  function backlogBusy(conversation) {
    if (busyWithTurn(conversation)) return true;
    return (conversation.submitting ?? 0) > 0;
  }

  /**
   * 这一波还要不要继续憋着。
   *
   * 四个条件缺一不可：开关开着 · 这一波里确实有「忙的时候到的」条目 · 它现在还忙 ·
   * 还没憋到 `batchBacklogHoldMs` 的上限。上限是为了兜住「它卡住了」：卡着的 turn
   * 不会结束，没有上限的话这些消息就再也不会被投出去（比晚回糟得多）。
   * @param conversation - 目标会话。
   * @returns 需要继续等时为 true。
   */
  function backlogShouldHold(conversation) {
    if (settings.batchBacklog !== true) return false;
    if (!(settings.batchBacklogHoldMs > 0)) return false;
    if (!conversation.pending.some((item) => item.held === true)) return false;
    if (!backlogBusy(conversation)) return false;
    const since = Number(conversation.pending[0]?.at) || 0;
    return since > 0 && Date.now() - since < settings.batchBacklogHoldMs;
  }

  /**
   * 结束等待，把攒下的消息作为**一条** user message 投进会话队列。
   *
   * 忙的时候就别投：先重新挂一个短定时器（`BACKLOG_POLL_MS`），等它闲下来再投 ——
   * 那一整段会被 `submitBatch` 当成一波迟到的消息交给模型（见 `renderBacklog`）。
   * `force` 只有一个调用点：`/reset`。那批话是重置前说的，必须照旧先投出去。
   *
   * @param conversation - 目标会话。
   * @param options.force - 跳过「还忙着」的等待（`/reset` 用）。
   */
  function flushBatch(conversation, { force = false } = {}) {
    if (conversation.batchTimer !== undefined) {
      clearTimeout(conversation.batchTimer);
      conversation.batchTimer = undefined;
    }
    if (conversation.pending.length === 0) return;
    if (!force && backlogShouldHold(conversation)) {
      const since = Number(conversation.pending[0]?.at) || 0;
      const left = settings.batchBacklogHoldMs - (Date.now() - since);
      const wait = Math.max(50, Math.min(left, BACKLOG_POLL_MS));
      const timer = setTimeout(() => flushBatch(conversation), wait);
      timer.unref?.();
      conversation.batchTimer = timer;
      return;
    }
    const batch = conversation.pending.splice(0);
    submitBatch(conversation, batch);
  }

  /**
   * 一轮结束后看一眼：是不是有一波迟到的消息可以投了。
   *
   * 挂在 `turn/end` 上（而不是只靠定时器），是因为「忙完」这件事只有那里知道得最准：
   * 定时器最多晚一个 `BACKLOG_POLL_MS`，而这里能让积压的那一轮紧接着开始。只处理
   * `held` 的批次 —— 普通的 2 秒窗口有它自己的定时器，不该被提前截断。
   * @param conversation - 目标会话。
   */
  function flushIfIdle(conversation) {
    if (conversation === undefined) return;
    if (conversation.pending.length === 0) return;
    if (!conversation.pending.some((item) => item.held === true)) return;
    if (backlogBusy(conversation)) return;
    flushBatch(conversation);
  }

  /**
   * 把一批消息渲染成一条 user message 交给会话的 Agent。
   *
   * 媒体在这里才落盘（在队列上串行），一条里的图和话都按原样呈现给模型。
   * 只带 @、没有正文的消息在这里也**不丢**：正文换成一句「他 @ 了你一下，没说什么」
   * —— 模型得知道轮到自己说话了，才能决定回一句「？」、发张表情，还是接上一句
   * （见 `blankReply`）。只有在引用也没取到、整批确实什么都没有时才什么都不发。
   *
   * 一批里只要有一条是「忙的时候到的」（`held`），整批就按**一波迟到的消息**渲染
   * （见 `backlog.js` / `renderBacklog`）：它们不是几乎同时到的，而是它在忙别的事的
   * 那段时间里陆续到的 —— 这个事实必须交给模型，它才知道可以挑着接、或者 SKIP。
   */
  function submitBatch(conversation, batch) {
    // 排上队就算「忙」：到 `followup` 之前 `submitted` 还是空的（见 `backlogBusy`）。
    conversation.submitting = (conversation.submitting ?? 0) + 1;
    enqueue(conversation, async () => {
      const selfId = client.selfId;
      const held = batch.some((item) => item.held === true);
      const entries = [];
      for (const item of batch) {
        // 撤回的两种处理都在账上查：`action: 'drop'` 是「摘除的第二道」—— 这一批可能
        // 已经被 splice 出来、正在异步下媒体，那时数组里已经没有它，摘不掉了。
        const mark = findRecent(conversation.key, item.messageId);
        if (mark?.action === 'drop') continue;
        // 积压波里的「改写」降级成丢弃：隔八分钟再为一句撤回调侃一句，不合时宜，
        // 而且这一轮本来就不是为它开的（模型看到的是一大段别人的话）。
        if (held && mark?.action === 'rewrite') continue;
        // 本条自己的图和「它在回复的那条」里的图一起取：两件事互不依赖，串起来等只是白等。
        const [resolved, quote] = await Promise.all([mediaFor(item.message), resolveQuote(item.message)]);
        // 再查一次：撤回可能就发生在这几十毫秒里（我们正在下媒体），而上面那次查是 await
        // 之前 —— 一次不够，正是这段异步窗口逼出了「把 action 记在账上」这个设计。
        if (mark?.action === 'drop') continue;
        // 引用成功时把 `[回复]` 占位符换成真正的引用前缀：否则模型会看到
        // 「（引用 kaguya: …）\n[回复]这啥」这种一半有内容、一半是噪音的正文。
        const rendered = new Map(resolved?.rendered ?? []);
        if (quote !== undefined) rendered.set(quote.index, '');
        // 活跃对话里接上的那句没有前缀可去：按前缀长度硬切会把「然后呢」切成「后呢」。
        const raw = messageToText(item.message, selfId, rendered.size > 0 ? rendered : undefined).trim();
        // 改写成撤回提示：这一轮本来就为它开，模型在**同一轮**里看到「他 @ 了我又撤了」，
        // 回一句就够 —— 不必先回一句正经的、再补一句调侃（那是两连发）。正文整个换掉，
        // 连「他引用了谁」那一段也不接：被引用的那条正是已经不在的那条。
        const rewritten = mark?.action === 'rewrite'
          ? recallLine({
              name: mark.name,
              text: settings.recallTeaseQuote === true ? mark.text : undefined,
              imageAllowed: imageAllowed(),
            })
          : undefined;
        const body = rewritten ?? (item.continued === true ? raw : dropPrefix(raw));
        const composed = rewritten !== undefined || quote === undefined
          ? body
          : body.length > 0
            ? `${quotePrefix(quote)}\n${body}`
            : quotePrefix(quote);
        // 正文与引用都是空的（`admit` 里的空消息通常已经给了 `blankBody`，这里只是最后
        // 一道防线）：绝不能给模型递一条空消息 —— 它会以为出了一条没有内容的消息。
        const text = composed.length > 0 ? composed : (item.blankBody ?? '');
        if (text.length === 0) continue;
        // 裸 URL 可选地取一次标题（`linkPreview` 默认关：替群友访问任意 URL 是把部署机器的
        // 出口 IP 暴露给发链接的人，卡片消息不联网就能解析，已经够用）。
        const withLinks = await previewLinks(text);
        entries.push({
          name: item.name,
          id: item.userId,
          body: withLinks,
          // 投递之后要能对回账上那一条（`submitted` / `replied` 两个进度，见 handleRecall）。
          messageId: String(item.messageId ?? ''),
          blank: item.blankBody !== undefined && item.blankBody.length > 0 && withLinks === item.blankBody,
          // 这一条是什么时候到的：一波迟到消息要按它算「几分钟前」，见 renderBacklog。
          at: Number(item.at) || 0,
        });
      }
      if (entries.length === 0) return;
      // 这一轮为什么轮到它：必须在渲染正文**之前**算出来（插话轮的正文要用它），
      // 写进会话记录，提示词（场景 / 人设的场景段）读它。积压的一波单独一个 intent：
      // 它既不是「刚有人跟我说话」，也不是免 @ 接话，场景提示词要说的是「你刚才在忙」。
      const intent = held ? 'backlog' : batchIntent(batch);
      conversation.pendingIntent = intent;
      // 三种投递文案：插话轮要说清「这不是叫你的」；积压的一波要带相对时间（否则模型
      // 会把八分钟前的问题当成刚发生的）；其余照旧。
      const text = held
        ? renderBacklog(entries, {
            now: Date.now(),
            maxEntries: settings.batchBacklogEntries,
            maxChars: settings.batchBacklogChars,
            canLookup: memory.toolsAllowed() === true,
          })
        : intent === 'interject'
          ? interjectBody(entries)
          : renderBatch(entries);
      const names = [...new Set(entries.map((entry) => entry.name))].join('、');
      report('info', `← ${describeConversation(conversation)} ${names}${entries.length > 1 ? `（${entries.length} 条）` : ''}${held ? '〔积压〕' : ''}: ${text.slice(0, 120)}`);
      // 发言人：提示词里要说得清「现在是谁在跟你说话」，所以几个人的话都记下来。
      // 同一个登记顺手保证他们都能被 @ 到（名单以「刚刚说过话」为序，见 `registerParticipant`）。
      const speakers = new Map();
      for (const entry of entries) speakers.set(entry.id, { name: entry.name, id: entry.id });
      conversation.speakers = [...speakers.values()];
      for (const speaker of conversation.speakers) registerParticipant(conversation, speaker.name, speaker.id);
      // 长期记忆的检索查询：这一轮真正投进去的正文 + 说话人（设计 §5.1）。
      // 只放**这一批**的正文（不是插话包装后的整段），检索要的是「他们在说什么」；
      // 说话人（以及这一批里被 @ 的人）用来保证「人物必进」。不落盘、只留最近这一条。
      const focusPeople = [...speakers.values()];
      for (const item of batch) {
        for (const mentioned of atMentions(item.message, selfId)) {
          if (mentioned.name.length > 0) focusPeople.push({ name: mentioned.name, id: mentioned.id });
        }
      }
      conversation.recallQuery = {
        text: entries.map((entry) => entry.body).join('\n').slice(0, 4000),
        at: Date.now(),
        speakers: focusPeople,
      };
      const agent = await ensureAgent(conversation);
      const userMessage = userMessageFor(conversation, text);
      // 只算**真正投进这一轮**的那些（被 `action: 'drop'` 摘掉的那条不在 entries 里）：
      // `turn/end` 之后靠它把账上那几条标成「已回复」。
      const batchIds = entries.map((entry) => entry.messageId).filter((id) => id.length > 0);
      for (const id of batchIds) {
        const mark = findRecent(conversation.key, id);
        if (mark !== undefined) mark.submitted = true;
      }
      // `blank`：这一批整批都是「空消息的替身」时，回复之后不挂补一句（那一轮没话题）。
      // `quote`：积压的一波不给指向 —— 引用八分钟前哪一条都像「我刚回的是他」；
      // 想叫谁让模型自己写 `[[@昵称]]`（`quoteHead` 也认 `backlog` 这个 intent）。
      submitted.set(userMessage.id, {
        key: conversation.key,
        quote: held ? { messageId: '', userId: '', seq: 0 } : batchQuote(batch),
        intent,
        batchIds,
        blank: entries.every((entry) => entry.blank === true),
      });
      agent.followup(userMessage);
    }).finally(() => {
      // 投递这一段（可能含媒体下载）结束：无论成功失败，会话都不再算「排着队」。
      conversation.submitting = Math.max(0, (conversation.submitting ?? 1) - 1);
    });
  }

  /**
   * 一批消息的「为什么轮到它」。
   *
   * 一批里可能混着「被叫到」与「窗口里接上的一句」：只要有一条是被明确叫到的，
   * 这一轮就是 `addressed`（模型得把它当成有人在跟它说话）；全是接话的才是 `continued`。
   * `interject` 由 `speech-policy` 判出来，单独带在条目上（见 `admit` 的返回）。
   * @param batch - 这一批 `{ intent }`。
   * @returns `intent` 字符串。
   */
  function batchIntent(batch) {
    const intents = batch.map((entry) => entry.intent ?? 'addressed');
    if (intents.includes('interject')) return 'interject';
    if (intents.includes('addressed')) return 'addressed';
    return intents[0] ?? 'addressed';
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
   * 插话轮的正文：元信息 + 锚点那句 + 「想接就接 / 不想接就 SKIP」。
   *
   * 只有一条时把「谁说的、说了什么」直接写进元信息（那就是锚点）；多条时元信息说一次、
   * 下面照常列「谁：什么」—— 否则每一行都套一句提醒，模型更容易只挑最后一句。
   * @param entries - `{ name, body }`，按到达顺序。
   * @returns user message 正文。
   */
  function interjectBody(entries) {
    const allowed = imageAllowed();
    if (entries.length === 1) {
      return interjectLine(entries[0].name, entries[0].body, allowed);
    }
    const lines = entries.map((entry) => `${entry.name}: ${entry.body.replace(/\s+/g, ' ').trim()}`);
    return [...interjectBatchPrompt(allowed), ...lines].join('\n');
  }

  /**
   * 把正文里的裸 URL 换成「【标题】 — 域名 链接」（`linkPreview` 打开时才做）。
   *
   * 三条边界都是「不可信输入」那条线上的：
   *   - 一条消息最多抓 **2** 个链接：不然一条刷屏消息能拖住整轮投递；
   *   - SSRF / 大小 / 超时 / 重定向全部由 `links.js` 兜住（见那边的模块注释）；
   *   - 抓到的标题是**数据**，原样放在方括号里渲染 —— 和 QQ 消息一样，不是指令。
   * 抓失败（内网、超时、不是 HTML）就保留原 URL：宁可没有标题，也不要丢链接。
   * @param text - 已渲染好的正文。
   * @returns 替换后的正文（没有 URL 或开关关着时原样返回）。
   */
  async function previewLinks(text) {
    if (!settings.linkPreview) return text;
    const urls = [...new Set(String(text).match(/https?:\/\/[^\s<>"'（）()【】]+/g) ?? [])]
      // 句末标点常常被粘在 URL 后面（「看这个 https://a.b/x。」），别把它们算进链接。
      .map((url) => url.replace(/[。，、；：！？…]+$/, ''))
      .filter((url) => url.length > 0)
      .slice(0, 2);
    if (urls.length === 0) return text;
    let out = String(text);
    for (const url of urls) {
      const result = await fetchPageTitle(url, {
        timeoutMs: settings.linkPreviewTimeoutMs,
        maxBytes: settings.linkPreviewMaxBytes,
        allowPrivateHosts: settings.linkAllowPrivateHosts,
      });
      const line = previewLine(result);
      if (line === undefined) continue;
      out = out.split(url).join(line);
    }
    return out;
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

  /** 这个会话今天已经回应了几次戳一戳（跨天就地归零）。 */
  function pokeTodayUsed(conversation) {
    const today = localDate();
    if (conversation.pokeDay !== today) {
      conversation.pokeDay = today;
      conversation.pokeToday = 0;
    }
    return conversation.pokeToday ?? 0;
  }

  /**
   * 让 OneBot 真的戳一下：不同实现的动作名不一样（`send_poke` / `group_poke` / `friend_poke`），
   * 所以这里按顺序试，第一个成功的算数。
   *
   * 只打给**戳它的人**：`userId` 来自事件、是不可信输入，但这里唯一用它做的事是
   * 「回戳那个发起戳一戳的人」—— 不回戳第三人（群里别人互相戳，跟它无关）。
   * @returns 成功时为 true。
   */
  async function pokeBack(type, id, userId) {
    const group = type === 'group';
    const params = group ? { group_id: Number(id), user_id: Number(userId) } : { user_id: Number(userId) };
    const attempts = [
      ['send_poke', params],
      [group ? 'group_poke' : 'friend_poke', params],
    ];
    for (const [action, payload] of attempts) {
      try {
        await client.call(action, payload);
        return true;
      } catch (error) {
        report('info', `poke: ${action} not available (${errorText(error)}), trying the next form`);
      }
    }
    report('warn', `poke: no poke action worked for ${type}:${id}`);
    return false;
  }

  /**
   * 戳一戳：OneBot v11 的 `notice` / `notify` / `poke`（§8.3）。
   *
   * 只有戳的是**机器人自己**才进判定；戳别人一律不记（群里互相戳跟它无关，记了只是噪音）。
   * 三种回应由 `pokeMode` 决定（随机回戳 / 走一轮模型 / 不回），冷却与每日上限在
   * `interactions.js` 的纯判据里，这里只负责凑入参、记账、发出去。
   *
   * **防回戳死循环**：同一个会话 `pokeCooldownMs` 内只回一次，不管戳了几下 —— 两个机器
   * 人互相戳起来时，这是唯一真正管用的那道闸。
   */
  function handlePoke(event, selfId) {
    if (settings.pokeReply !== true) return;
    const notice = pokeNotice(event);
    if (notice === undefined) return;
    const type = pokeActionType(notice.groupId !== undefined ? 'group' : 'private');
    const id = type === 'group' ? String(notice.groupId) : String(notice.userId);
    if (type === 'group') {
      if (!settings.groupChat) return;
      if (settings.allowGroups.length > 0 && !settings.allowGroups.includes(id)) return;
    } else {
      if (!settings.privateChat) return;
      if (settings.allowUsers.length > 0 && !settings.allowUsers.includes(String(notice.userId))) return;
    }
    const sender = event.sender ?? {};
    const displayName = userDisplayName(sender, notice.userId);
    const conversation = conversationFor(type, id, {
      userId: notice.userId,
      userName: displayName,
      name: displayName,
    });
    // 戳一戳也算「这个会话有人活动」：主动说话据此判断群是否安静下来了。
    // 走同一个记账口 —— 顺便把「刚才安静了多久」记下来（静默换代要用更新前的值）。
    const now = Date.now();
    noteConversationActivity(conversation, now);
    const decision = pokeAction({
      selfId,
      targetId: notice.targetId,
      userId: notice.userId,
      mode: settings.pokeMode,
      chance: settings.pokeReplyChance,
      roll: Math.random(),
      cooldownLeftMs: Math.max(0, (Number(conversation.pokeAt) || 0) + settings.pokeCooldownMs - now),
      todayCount: pokeTodayUsed(conversation),
      dailyMax: settings.pokeDailyMax,
    });
    if (decision.act === 'none') {
      report('info', `${describeConversation(conversation)} 戳一戳不回应（${decision.reason}）`);
      return;
    }
    // 记账刻意在**发出去之前**：回戳失败、或者那一轮被判成 SKIP，这次机会照样用掉 —
    // 否则对方一直戳，它就一直在同一个冷却里反复尝试。
    conversation.pokeAt = now;
    conversation.pokeToday = pokeTodayUsed(conversation) + 1;
    if (decision.act === 'poke') {
      report('info', `${describeConversation(conversation)} 被 ${displayName} 戳了，回戳`);
      void pokeBack(type, id, notice.userId);
      return;
    }
    report('info', `${describeConversation(conversation)} 被 ${displayName} 戳了，走一轮（${decision.reason}）`);
    conversation.pendingIntent = 'poke';
    enqueue(conversation, async () => {
      try {
        noteRecallFallback(conversation);
        const agent = await ensureAgent(conversation);
        const userMessage = userMessageFor(conversation, pokeNudge({ userName: displayName }));
        // 戳一戳不是「主动搭话」：有人真的碰了它一下，出错照常道歉、SKIP 照常静默。
        submitted.set(userMessage.id, {
          key: conversation.key,
          quote: { messageId: '', userId: '', seq: 0 },
          intent: 'poke',
        });
        agent.followup(userMessage);
      } catch (error) {
        report('warn', `poke turn for ${conversation.key} could not start: ${errorText(error)}`);
      }
    });
  }

  /**
   * 撤回事件的准入：与 `handlePoke` / `rememberTranscript` 同一条纪律。
   *
   * 只看「这个渠道本身开没开、这个群/人允不允许」——`recallPrivate` 不在这里，
   * 它管的是**行为层**（要不要把它当成一件值得回应的事），而安全层（清引用）对私聊
   * 同样要做，否则私聊里引用一条已撤回的消息照样会把整条回复卡住（见 §1.4）。
   *
   * @param type - `'group'` / `'private'`。
   * @param id - 群号或 QQ 号。
   * @returns 这个渠道的撤回事件能不能进后续处理。
   */
  function recallInScope(type, id) {
    if (type === 'group') {
      if (!settings.groupChat) return false;
      return settings.allowGroups.length === 0 || settings.allowGroups.includes(id);
    }
    if (!settings.privateChat) return false;
    return settings.allowUsers.length === 0 || settings.allowUsers.includes(id);
  }

  /**
   * 清掉「指向这条消息」的引用 —— **撤回事件里永远做，与任何模式无关**。
   *
   * 为什么这不是可选的优化，而是正确性：`quote` 对象在 `pending` 条目、`submitted`、
   * `turnOwners` 里是**同一个引用**（`submitBatch` 用 `batchQuote(batch)` 取它，claim 时
   * 整个 owner 对象搬到 `turnOwners`，`turn/end` 又原样交给 `sendToConversation`），
   * 所以一次遍历就三处生效 —— 反过来说，**别复制新对象**，那会让清引用只清到一处。
   *
   * 只清 `messageId`、留着 `userId` 是刻意的：`replyStyle: 'at'` 只认 `userId`，照常 @；
   * `auto` / `quote` 在没有 `messageId` 时自然退回裸文本，不会发出一个注定失败的引用段。
   *
   * 不这么做会怎样（真实链路）：`sendOne` 失败时只记一条 warn 并返回 false，
   * `sendParts` 的循环见到 false 就 `return` —— 这条回复**剩下的气泡一起不发**，
   * 群里看到的是「它没理人」，日志里只有一行 warn。
   *
   * @param key - 会话 key。
   * @param messageId - 被撤回的那条消息的 id。
   */
  function clearQuoteFor(key, messageId) {
    const id = String(messageId ?? '');
    if (id.length === 0) return;
    const quotes = [];
    for (const item of conversations.get(key)?.pending ?? []) quotes.push(item.quote);
    for (const owner of submitted.values()) if (owner?.key === key) quotes.push(owner.quote);
    for (const owner of turnOwners.values()) if (owner?.key === key) quotes.push(owner.quote);
    for (const quote of quotes) {
      if (quote !== undefined && String(quote.messageId) === id) quote.messageId = '';
    }
  }

  /**
   * 从攒批里摘掉一条。
   *
   * 摘空了就**只清定时器、绝不 flush**：`flushBatch` 对空数组会直接 return，但那样等于
   * 白等一个窗口（而且读起来像是在「投递一个空批」）。
   *
   * 找不到也正常：这一批可能已经被 `flushBatch` 取走、正在 `submitBatch` 里异步下媒体，
   * 那时数组里已经没有它了 —— 那种情况由账上的 `action: 'drop'` 兜住（见 `submitBatch`）。
   *
   * @param conversation - 目标会话（可能还没有会话记录）。
   * @param messageId - 要摘掉的那条消息 id。
   * @returns 真的从数组里摘掉了为 true。
   */
  function dropPending(conversation, messageId) {
    if (conversation === undefined) return false;
    const id = String(messageId ?? '');
    const at = conversation.pending.findIndex((item) => String(item.messageId ?? '') === id);
    if (at < 0) return false;
    conversation.pending.splice(at, 1);
    if (conversation.pending.length === 0 && conversation.batchTimer !== undefined) {
      clearTimeout(conversation.batchTimer);
      conversation.batchTimer = undefined;
    }
    return true;
  }

  /**
   * 从群聊环境上下文里删掉这一行。
   *
   * 「假装没看到」必须连这里也一起删：没 @ 它的消息只进 `ambient`，不删的话模型下次
   * 被 @ 时又在「群里最近的消息」里读到那句已经撤掉的话。
   *
   * **按 id 删，不能按文本比**：`hydrateAmbientMedia` 会把 `text` 异步改写成带本地路径的
   * 版本，落盘前后文本不一样。
   *
   * @param groupId - 群号（私聊没有环境上下文）。
   * @param messageId - 要删掉的那条消息 id。
   */
  function dropAmbient(groupId, messageId) {
    if (groupId === undefined) return;
    const id = String(messageId ?? '');
    if (id.length === 0) return;
    const list = ambient.get(String(groupId));
    if (list === undefined) return;
    const at = list.findIndex((item) => String(item.id ?? '') === id);
    if (at >= 0) list.splice(at, 1);
  }

  /** 这个会话今天已经为撤回补了几句（跨天就地归零，与 `pokeTodayUsed` 同一套路）。 */
  function recallTodayUsed(conversation) {
    const today = localDate();
    if (conversation.recallDay !== today) {
      conversation.recallDay = today;
      conversation.recallToday = 0;
    }
    return conversation.recallToday ?? 0;
  }

  /**
   * 把「这一轮的回复真要发出去了」记到账上（`replied`）。
   *
   * 只算**真正投进这一轮**的那些（`batchIds` 来自 `entries`，被 `action: 'drop'` 摘掉的
   * 那条不在里面）。SKIP / 出错 / 中止的分支不调它 —— 它没回过，nudge 里就不能说
   * 「你已经回过了」。
   *
   * @param owner - `turnOwners` 里的那条归属记录。
   */
  function markReplied(owner) {
    for (const id of owner?.batchIds ?? []) {
      const entry = findRecent(owner.key, id);
      if (entry !== undefined) entry.replied = true;
    }
  }

  /**
   * 撤回：OneBot v11 的 `notice` / `group_recall`（群）与 `friend_recall`（私聊）。
   *
   * 三层，前两层永远生效，第三层才是配置项：
   *
   *   1. **安全层** —— 清掉指向这条消息的引用。不做的话，一条引用已撤回消息的回复会在
   *      发送时失败，并把**剩下所有气泡**一起吞掉（见 `clearQuoteFor`）。
   *   2. **数据层** —— 在「最近看见过」的账里对出「撤的是哪句、谁发的、有没有 @ 过它」。
   *      QQ 不给回查接口，这就是唯一的信息来源；查不到就只记一条 info（「没看见」是一个
   *      有效状态，不是错误）。
   *   3. **行为层** —— 由 `recallMode` / `recallAddressed` / `recallScope` 决定：投递前
   *      摘除或改写成撤回提示，已经回过的按 `recallAction` 的闸门补一句。
   *
   * 记账刻意在**发出去之前**（与 poke / proactive 同一条规矩）：掷中即消耗，判成 SKIP 也算。
   *
   * @param event - 已解码的 OneBot 事件。
   * @param selfId - 机器人自己的 QQ 号。
   */
  function handleRecall(event, selfId) {
    const notice = recallNotice(event);
    if (notice === undefined) return;
    const type = notice.groupId !== undefined ? 'group' : 'private';
    const id = type === 'group' ? notice.groupId : notice.userId;
    if (!recallInScope(type, id)) return;
    const key = `${type}:${id}`;

    // ① 安全层：不管哪种模式、账上有没有，先清引用。
    clearQuoteFor(key, notice.messageId);

    // 私聊的**行为层**默认关（`recallPrivate`）：清引用照做，但不当成一件要回应的事。
    if (type === 'private' && settings.recallPrivate !== true) return;

    // ② 数据层。
    const entry = findRecent(key, notice.messageId);
    if (entry === undefined) {
      report('info', `${key} 撤回了一条没见过的消息（${notice.messageId}）`);
      return;
    }
    // 同一个撤回可能被重复上报：只处理一次（`action` 本身幂等，冷却再兜一层）。
    if (entry.recalled === true) return;
    entry.recalled = true;

    const conversation = conversations.get(key);
    const addressed = entry.addressed === true;
    const mode = settings.recallMode;

    // 长期记忆：留一行 tombstone（不影响回复；写失败只记 warn，见 memory.noteRecall）。
    if (settings.recallMemoryMark === true) {
      memory.noteRecall(key, {
        messageId: notice.messageId,
        userId: entry.userId,
        name: entry.name,
        addressed,
      });
    }

    // ③ 投递决策（`off` 什么都不动）：还没进模型的，没 @ 它的一律摘；被 @ 的看
    //    `recallAddressed`。已经投递的那条只能走「清引用 +（tease 时）补一句」。
    if (mode !== 'off' && entry.submitted !== true) {
      const drop = !addressed || settings.recallAddressed === 'drop';
      if (drop) {
        // 标记记在账上而不是只改 `pending` 数组：`submitBatch` 可能已经把这批 splice
        // 出去、正在异步下媒体，那时数组里已经没有它了，但循环还没走到它。
        entry.action = 'drop';
        dropPending(conversation, notice.messageId);
        dropAmbient(notice.groupId, notice.messageId);
        report('info', `${key} 被撤回的那条不再投递（${addressed ? 'recallAddressed=drop' : '没有被 @'}）`);
      } else if (mode === 'tease') {
        // 改写只改「正文怎么渲染」，别的都不动：userId / name 留着（名单登记与 `[[@昵称]]`
        // 照常），`intent` 仍按这一批算，引用那一路由 `clearQuoteFor` 兜住。
        entry.action = 'rewrite';
        report('info', `${key} 被 @ 的那条被撤回了，这一轮改成调侃`);
      } else {
        report('info', `${key} 被 @ 的那条被撤回了，照常回答（不引用）`);
      }
    }

    // ④ 反应：只有 tease 会「补一句」；被 @ 的那条已经在改写里处理，不再叠一条。
    if (mode !== 'tease') return;
    if (conversation === undefined) return;
    if (entry.submitted !== true && addressed) return;
    const now = Date.now();
    const decision = recallAction({
      mode,
      selfId: String(selfId),
      messageId: notice.messageId,
      userId: notice.userId,
      operatorId: notice.operatorId,
      seen: true,
      addressed,
      replied: entry.replied === true,
      scope: settings.recallScope,
      ageMs: now - (Number(entry.at) || 0),
      maxAgeMs: settings.recallMaxAgeMs,
      busy: busyWithTurn(conversation),
      cooldownLeftMs: Math.max(0, (Number(conversation.recallAt) || 0) + settings.recallCooldownMs - now),
      // 这个读数带「跨天就地归零」的副作用，所以只有走到这里才取 —— 判据本身是纯的。
      todayCount: recallTodayUsed(conversation),
      dailyMax: settings.recallDailyMax,
      chance: settings.recallChance,
      roll: Math.random(),
    });
    if (decision.act === 'none') {
      report('info', `${describeConversation(conversation)} 撤回不调侃（${decision.reason}）`);
      return;
    }
    // 先记账再发（与 poke / proactive 同一条规矩：掷中即消耗，SKIP 也算）。
    conversation.recallAt = now;
    conversation.recallToday = recallTodayUsed(conversation) + 1;
    conversation.pendingIntent = 'recall';
    enqueue(conversation, async () => {
      try {
        const agent = await ensureAgent(conversation);
        const text = recallNudge({
          name: entry.name,
          // 默认连原文都不给它（`recallTeaseQuote`）：复述别人撤掉的话是最常见的社交事故。
          text: settings.recallTeaseQuote === true ? entry.text : undefined,
          replied: entry.replied === true,
          imageAllowed: imageAllowed(),
        });
        const userMessage = userMessageFor(conversation, text);
        // `proactive: true` 的三个现成语义正好都要：出错不道歉（没人问过它）、SKIP 全局
        // 静默、不挂补一句（否则它会补一句再补一句）。
        submitted.set(userMessage.id, {
          key: conversation.key,
          quote: { messageId: '', userId: '', seq: 0 },
          proactive: true,
          intent: 'recall',
        });
        agent.followup(userMessage);
      } catch (error) {
        report('warn', `recall turn for ${conversation.key} could not start: ${errorText(error)}`);
      }
    });
  }

  /** 处理一条已解码的 OneBot 事件（由 OneBotClient 的 onEvent 调用）。 */
  function handleEvent(event) {
    const selfId = client.selfId;
    if (selfId === '') return;
    // 通知事件（戳一戳 / 撤回）先于消息分流：以前这里第一行就把非 message 全丢了，
    // 于是「有人戳了它一下」（§8.3）与「有人撤回了刚说的话」它都完全收不到。
    if (event?.post_type === 'notice') {
      if (event.notice_type === 'group_recall' || event.notice_type === 'friend_recall') handleRecall(event, selfId);
      else handlePoke(event, selfId);
      return;
    }
    if (event?.post_type !== 'message') return;
    // 记一条「它看见过这句话」：QQ 不支持回查已撤回的消息，所以撤回事件里那个
    // message_id 只能靠这份账还原成「谁说了什么」。必须在 `admit` 与所有提前 return
    // **之前** —— 「刚发就撤」的时间窗只有几十毫秒，而且撤回不认「有没有 @ 它」。
    noteSeen(event, selfId);
    // 先记「群里又有人说了一句」，`admit` 紧接着快照的序号才算上这条自己 ——
    // 快照与发送时读到的值相等就说明中间没有新消息，`auto` 便不引用。
    noteChatter(event, selfId);
    // 同一时刻记一次「这个会话是活跃的」：主动说话只挑安静下来的群（见 touchActivity）。
    touchActivity(event, selfId);
    const admitted = admit(event, selfId);
    // 复读链在所有别人的群消息上进账（被 @ 的那条也打断「连着」），但只有没被 @ 的才真的跟。
    maybeRepeat(event, selfId, admitted === undefined);
    // 长期记忆：把这条消息记进这个会话的转录（**所有**别人的消息，包括没 @ 机器人的
    // 群聊）。放在复读/环境上下文之前 —— 那两条路都会提前 return，而转录不该漏掉任何一条。
    // 「活跃对话里接上的一句」（`continued`）**不算指令**：`/reset` 这类旁路要求
    // 明确叫了它（@ 或前缀）才认 —— 否则窗口里一句闲聊「reset」就会绕开模型把会话重置了。
    const commanded = admitted !== undefined && admitted.continued !== true;
    memory.rememberTranscript(event, selfId, {
      admitted,
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
    // 「这条消息恰好是指令」—— 静默换代要让开它（下面那一轮换代由它自己来）。
    const isResetCommand = commanded && resetCommand.length > 0 && preview.toLowerCase() === resetCommand;
    // 静默太久之后的第一条消息：先换一轮会话，再照常攒批（见 `maybeIdleReset`）。
    // 放在 `/reset` 判定之前、但跳过 `/reset` 自己 —— 否则一次指令会连换两轮。
    if (!isResetCommand) maybeIdleReset(conversation);
    // 会话重置指令：整条消息恰好等于指令才触发，且只对「发指令的这个会话」生效。
    // 它开的是**新一轮**会话（旧会话留在磁盘上当存档），而不是把记录删掉。
    // 攒着的那批是在重置之前收到的，必须先投出去，否则那几句话会被一起忘掉。
    if (isResetCommand) {
      // 权限：只有 resetUsers 里的人能用（默认空白名单 = 谁都不能）。没权限的**静默忽略**，
      // 既不重置也不回「你没有权限」—— 回一句等于告诉全群这里有这么个指令、还激人去试；
      // 这一条仍然照常记进转录（rememberTranscript 在前面已经跑过），留痕在记忆里。
      // 注意这个判断必须在 flushBatch / enqueue **之前**：那样没有权限的人连「让攒着的
      // 那批提前投出去」都做不到。
      if (!canReset(event.user_id)) {
        report('info', `ignored ${resetCommand} from ${conversation.key} by ${event.user_id}: not in resetUsers`);
        return;
      }
      // 这批话是重置前说的，必须照旧投出去：不能因为「它还在忙」就留在 pending 里 ——
      // 销毁旧 Agent 之后，它们会被算到新一轮头上（见 resetConversation）。
      flushBatch(conversation, { force: true });
      enqueue(conversation, async () => {
        const started = await resetConversation(conversation);
        await sendToConversation(conversation, started ? '已开始新会话（上一轮的记忆留在磁盘上，不再带进这一轮）。' : '（没能开始新会话：旧会话还活着，请查看机器人日志）');
      });
      return;
    }
    // 其余消息都先攒一会儿：同一个群里几个人同时 @、或者一个人连发几句，
    // 攒成一条只回一轮（见 holdForBatch）。
    holdForBatch(conversation, {
      message,
      quote,
      // 撤回要对账的那把钥匙：摘除、改写、去重都靠它（账上的条目按 message_id 索引）。
      messageId: String(event.message_id ?? ''),
      // 「活跃对话里接上的一句」正文里没有前缀可去（见 admit / dropPrefix）。
      continued: admitted.continued === true,
      intent: admitted.intent ?? 'addressed',
      // 空消息（单纯 @ / 一个空格）的那句说明：媒体落盘后正文还是空的，用它兜底。
      blankBody: admitted.blankBody ?? '',
      userId: String(event.user_id ?? ''),
      // 名字取自 `admit` 算好的那一个，不在这里重算：正文里写作 `名字: …`，而
      // `[[@名字]]` 要靠同一串字解析（重算一次就是一份要同步维护的重复口径）。
      name: admitted.displayName ?? String(event.user_id ?? '某人'),
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
    // 私聊回复从模型**开始想**的那一刻就点亮「对方正在输入」：这一段（常常十几秒）
    // 才是对方真正在等的时间。`turn/end` 会把它停掉，随后发送步骤再按打字节奏点亮。
    const conversation = conversations.get(owner.key);
    if (conversation !== undefined) startTyping(conversation);
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
    const conversation = conversations.get(owner?.key ?? key);
    // 这一轮不管最后发不发（SKIP / 出错 / 中止 / 空回复），「正在输入」都到此为止；
    // 真要发的话，`sendParts` 会在发送前按打字节奏重新点亮。
    if (conversation !== undefined) stopTyping(conversation);
    if (owner === undefined) return;
    if (conversation === undefined) return;
    // 这一轮收尾之后它可能就闲下来了：忙的时候攒着的那一波迟到的消息可以投了。
    // 必须放在这里（而不是某个分支里）：下面每一条提前 return（提醒、aborted、error、
    // 空回复、SKIP、主动搭话）都可能正是「它终于闲下来」的那一刻。
    flushIfIdle(conversation);
    const reason = event.data.reason?.kind;
    // 只发该 turn 里最后一条有文本的 assistant 消息；中间步骤的工具调用等不发给 QQ。
    const reply = list?.[list.length - 1]?.trim() ?? '';

    // 定时提醒的 agent/prompt 轮：必须在 error / SKIP / aborted 之前收账。
    // 这几个分支在普通轮次里是「静默丢弃」，但提醒不能静默 —— 要让 reminders.js 拿到
    // 结果去走兜底文案。`settleReminderTurn` 返回 false 说明守卫已经超时并结算过，
    // 这一条迟到的回复必须丢弃，否则同一件事会发两遍。
    if (owner.reminderId !== undefined) {
      conversation.pendingIntent = undefined;
      const failed = reason === 'aborted' || reason === 'forked' || reason === 'interrupted' || reason === 'error';
      const hasText = reply.length > 0 && replyPieces(reply, true).some((piece) => piece.kind === 'text');
      const outcome = failed
        ? { kind: 'failure', reason }
        : hasText
          ? (proactiveSkip(reply) ? { kind: 'skip' } : { kind: 'reply', text: reply })
          : { kind: 'empty' };
      if (!settleReminderTurn(owner.reminderId, outcome)) {
        report('info', `reminder ${owner.reminderId}: 迟到的回复已丢弃（超时兜底已经发过）`);
      }
      return;
    }

    // 被打断 / fork 掉 / 中止的 turn 不是有效回复，静默丢弃（意图也要清，别漏到下一轮）。
    if (reason === 'aborted' || reason === 'forked' || reason === 'interrupted') {
      conversation.pendingIntent = undefined;
      return;
    }
    if (reason === 'error') {
      // 主动搭话是我自己挑起来的话头，没人问过它：出错就安静地算了，
      // 别反过来在群里贴一句「我这边出错了」。
      conversation.pendingIntent = undefined;
      if (owner.proactive !== true) void sendToConversation(conversation, '（我这边处理时出错了，稍后再试试）');
      return;
    }
    if (reply.length === 0) return;
    // `SKIP` 是**这一条会话本身**的「不说了」信号，不是「主动搭话」才有的信号：提醒
    // （`proactiveNudge` / `chimeNudge`）虽然只在那两种轮次里发，但它落在同一个会话的
    // 上下文里，模型照样可能在回别人的那一轮里学着写出来。一旦漏判，群里收到的就是
    // 一句字面的 `SKIP` —— 它本来是用来「什么都不做」的。空回复在上面的 length 判断里
    // 就已经静默丢弃了，这里只管那个词。
    //
    // 放在最前面（而不是只放在主动搭话那一支）是必须的：真正会「引用」一条消息的正是
    // 回别人的那一轮 —— 主动搭话的 `quote` 永远是空的（没人跟它说话），所以
    // 「引用 + SKIP」同时出现的那种消息**一定**是走这一支的。
    if (proactiveSkip(reply)) {
      report('info', `→ ${conversation.key}: （判成 SKIP，不发送）`);
      conversation.pendingIntent = undefined;
      return;
    }
    // 这一轮的意图在发送前就取出来（sendToConversation 是异步的，之后 pendingIntent 会变）。
    const intent = owner.intent ?? conversation.pendingIntent ?? 'addressed';
    conversation.pendingIntent = undefined;
    if (owner.proactive === true) {
      report('info', `→ ${conversation.key}: ${reply.slice(0, 120)}（主动）`);
      // 同一条「拟人」通道：拆短句 + 打字延迟。主动搭话没有可指向的消息，quote 为空。
      markReplied(owner);
      void sendToConversation(conversation, reply, { human: true, quote: owner.quote });
      return;
    }
    report('info', `→ ${conversation.key}: ${reply.slice(0, 120)}（${intent}）`);
    // 这一轮的回复真的要发出去了：账上那几条标成「已回复」，之后有人撤回时才说得出
    // 「撤得有点晚，我都回了」。SKIP / 出错 / 中止的分支在前面就 return 了，不会走到这里。
    markReplied(owner);
    // 自动回复走「拟人」通道：拆短句 + 打字延迟 + 引用/@ 对方（搭话轮除外，见 `quoteHead`）。
    // 等这一轮真的发完再挂「过一会儿也许补一句」的定时器（见 scheduleChime）：
    // 补一句必须排在它这次回复**之后**，而且得等打完字才算「对方安静了」。
    void sendToConversation(conversation, reply, { human: true, quote: owner.quote, intent }).then(() => {
      scheduleChime(conversation, owner);
    });
  });

  // ---- 工具注册 --------------------------------------------------------------
  //
  // `defineTool` 声明本身没有策略（校验参数 → 调一个函数 → 拼一段 render），却占了
  // 五百多行、最深处缩进到 20 层，所以整块搬去了 `tools.js`。这里只做装配：把闭包里那
  // 几个函数显式递过去 —— 工具能碰到哪些状态，看这份依赖表就够了，不用去翻闭包。
  registerQqTools(ctx, {
    client,
    cwd,
    endpoint: settings.endpoint,
    report,
    // 工具只按协议上限分段（不加拟人节奏），所以直接给这个数，不必再包一层函数。
    protocolLimit: settings.maxReplyChars,
    noteOwnMessage,
    resolveTarget,
    // 工具里的 `[[@昵称]]` 标记也要解析成 at 段：名单挂在会话记录上（见 `conversationMentions`）。
    mentionResolver: conversationMentions,
    resolveStickerSource,
    // `qq_send_image` 也要区分「收藏的表情」与「普通图片」：前者带 QQ 的大表情标记发出去。
    isStickerFile,
    // 存表情包：不可用时传 undefined，`registerQqTools` 会跳过那个工具
    // （与 memory.tools 同一个规矩：不留「一调就报错」的壳）。
    saveSticker: stickerSaveAllowed() ? saveSticker : undefined,
    // 给已收藏的表情改名：文件与 STICKERS.md 一起搬，别让模型「用新名字再存一遍」
    // 造出一张同画面的重复表情（真实事故，见 renameSticker 的注释）。记忆关掉时
    // 仍可注册：那只是少更新一份目录（与 saveSticker 同一口径）。
    renameSticker: stickerRenameAllowed() ? renameSticker : undefined,
    // 戳一戳：与通知事件共用同一个「怎么戳」（动作名在不同实现里不一样，见 pokeBack）。
    poke: settings.pokeReply === true ? pokeBack : undefined,
    imageSend,
    imageMaxBytes,
    resolveRoute,
    conversations,
    sessionIdFor,
    // 记忆停用时 memory.tools 是 undefined：`registerQqTools` 会连那两个工具一起跳过，
    // 不留「一调就报错」的壳。
    memory: memory.tools,
    // 定时提醒：停用（reminder: false / 文件在 cwd 外）时是 undefined，三个工具一起跳过。
    reminders,
    reminderPrepare,
    reminderViewer,
  });
  // ---- NapCat 那一侧的自检 ----------------------------------------------------
  //
  // 这是「它为什么不说话」里最值钱的一条线索：插件这边全都配好了，但 NapCat 里没有
  // 一条启用的 WebSocket 服务器（或者端口 / token 对不上），进程会安静地一直重连。
  // 所以启动时读一眼 NapCat 的配置：**默认只读**，发现问题记一条带原因与修法的 warn；
  // 只有显式打开 `napcatAutoConfig` 才会写（写前备份，且只动 websocketServers 里我们那一条）。
  //
  // 目录怎么找：配了 `napcatDir` 就以它为准；没配就只看少数几个「像 NapCat 装在这里」的
  // 位置 —— 一个插件不该为了找配置把用户的硬盘遍历一遍。找不到时只记 info 而不是 warn：
  // 容器部署里 NapCat 压根不在这个文件系统上，那不是错误。
  const pluginRoot = dirname(fileURLToPath(import.meta.url));

  /** 自动探测时的候选目录（只在没配 `napcatDir` 时用）。 */
  function napcatCandidates() {
    return [
      join(pluginRoot, 'NapCat.Shell'),
      join(cwd, 'NapCat.Shell'),
      join(homedir(), 'NapCat.Shell'),
    ];
  }

  /** 跑一次自检并把结论写进日志。任何异常都只记一行 warn —— 它是别家软件的配置，不该拖垮插件。 */
  async function checkNapcat() {
    const configured = String(settings.napcatDir ?? '').trim();
    const target = endpointTarget(settings.endpoint);
    const found = configured.length > 0 ? configured : await findNapcatDir(napcatCandidates());
    if (found === undefined || found.length === 0) {
      const hint = configured.length > 0
        ? `napcatDir "${configured}" 里没有 config/onebot11_<QQ号>.json`
        : `没找到 NapCat 安装目录（找过 ${napcatCandidates().join(' / ')}）`;
      report(configured.length > 0 ? 'warn' : 'info', `napcat: ${hint}；需要的话跑 node scripts/napcat-setup.mjs（它会把 NapCat 的网络配置与 .env 一起写好）`);
      return;
    }
    const configDir = join(found, 'config');
    const result = await repairNapcat({
      dir: configDir,
      endpoint: settings.endpoint,
      token: settings.accessToken,
      autoConfig: settings.napcatAutoConfig === true,
    });
    const portLabel = target?.port === undefined ? settings.endpoint : `端口 ${target.port}`;
    if (result.action === 'ok') {
      report('info', `napcat: ${configDir} 里已经有监听 ${portLabel} 的 WebSocket 服务器`);
      for (const note of result.verdict?.notes ?? []) report('warn', `napcat: ${note}`);
      return;
    }
    if (result.action === 'repaired') {
      report('info', `napcat: ${result.reason} —— 已写进 ${result.file}（原文件备份在 ${result.backup}）；**要重启 NapCat 才生效**`);
      return;
    }
    if (result.action === 'needs-repair') {
      report('warn', `napcat: ${result.reason}；跑 node scripts/napcat-setup.mjs 一条命令就能配好（或打开 napcatAutoConfig 让插件自己写）`);
      return;
    }
    if (result.noAccount === true) {
      // 「目录在、但还没登录过账号」是发布版安装流程里的**正常中间态**（`onebot11_<QQ>.json`
      // 要等 NapCat 登录之后才生成），所以记 info 并把下一步写清楚，别用 warn 吓人。
      report('info', 'napcat: 这份 NapCat 还没登录过账号（config/onebot11_<QQ号>.json 要等它登录之后才生成）——先启动一次 NapCat 并登录，再跑 node scripts/napcat-setup.mjs --qq <你的号>，它会把网络配置与快速登录一起配好');
      return;
    }
    report('warn', `napcat: 自检没跑成：${result.reason}`);
  }

  // ---- 连接生命周期 ----------------------------------------------------------

  // 配置热更新：Web UI 的插件设置保存之后，自己重启一次。
  //
  // 配置 schema 是根 volatile（见 config.js），所以保存走的是 Loader 的「volatile
  // 热更新」路径：它就地换掉引用里的值，**不重跑 apply()**。而这个插件的装配几乎
  // 全在 apply() 里 —— OneBot 连接、主动说话 / 摘要 / 凭据轮换的定时器、工具注册、
  // 目录越界校验，光换值它们一个都不会重建。
  //
  // 所以这里挂一个监听：收到热更新就重启自己（`ctx.fiber.restart()`，等价于把这一行
  // 停用再启用）。重启**不丢聊天记忆**：会话 id 是确定性的（sessionIdFor），下一条
  // 消息照样 resume 出同一个 Session，只是连接与内存里的记账重建一遍。
  //
  // 延后一拍再重启：事件是在 Loader 的 update() 中间派发的，当场 dispose 自己等于
  // 踩在它自己的调用栈上。
  let restartScheduled = false;
  ctx.on('loader/volatile-update', () => {
    if (restartScheduled) return;
    restartScheduled = true;
    if (typeof ctx.fiber?.restart !== 'function') {
      // 测试桩 / 最小组合里没有 fiber：不吭声会让人以为配置已经生效了。
      report('warn', '配置热更新收到，但当前上下文没有 fiber.restart —— 这份配置要重启进程才生效');
      return;
    }
    const timer = setTimeout(() => {
      report('info', '配置已更新（Web UI 保存 / Loader 热更新），重启插件以应用');
      Promise.resolve()
        .then(() => ctx.fiber.restart())
        .catch((error) => report('warn', `配置热更新后的重启失败：${errorText(error)}`));
    }, 0);
    timer.unref?.();
  });

  // 用 ctx.effect 托管连接：插件卸载/停用时自动 dispose，不留悬挂的定时器与 socket。
  // 注意：Loader 按 URL 缓存插件模块，改源码后必须重启进程才生效（见 docs/development.md）。
  ctx.effect(() => {
    client.start();
    return () => {
      // 插件都卸了，「正在输入」的刷新定时器也不该再醒过来（不 cancel：连接马上就没）。
      stopAllTyping();
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

  // NapCat 那一侧的自检：跑完就没了，不需要托管任何句柄；放进 ctx.effect 只是为了让
  // 「它在生命周期这一节里」这件事一眼可见（异步部分自己把异常收进日志）。
  ctx.effect(() => {
    void checkNapcat().catch((error) => report('warn', `napcat: 自检失败：${errorText(error)}`));
  }, 'qq-bridge:napcat');

  // ---- 长期记忆：定时摘要的生命周期 -------------------------------------------
  //
  // 定时器本身（排到下一个 `digestAtHour`、启动时预热摘要状态、插件卸载即清掉）在
  // `memory.js` 里，这里只把它挂上，再写一句启动自述 —— 记忆是「哪几个开关真的生效了」
  // 里最容易配错的一项（没生效时工具会直接消失）。
  if (memory.enabled) {
    memory.startDigestTimer();
    report('info', `memory enabled at ${memory.label} (daily digest at ${hourLabel(settings.digestAtHour)}; a conversation needs ${Math.max(1, Math.floor(Number(settings.digestMinLines) || 1))} new lines, once a day)`);
  }

  // ---- 模型凭据：每天轮换的定时器 ----------------------------------------------
  //
  // 与摘要循环同一套托管方式（`ctx.interval` + 「跑完再排」，插件卸载即清掉），只是没有
  // 任何预热：轮换的状态全部现算（见 rotateApiKey），重启也不会跑偏。
  if (apiKeyRotateEnabled) {
    const hour = settings.apiKeyRotateHour;
    const tick = () => {
      // 定时器回调是同步的，而轮换要读盘 + 发探测请求：这里只负责把异常收进日志，
      // 不让一个 rejected promise 变成 unhandled rejection 把进程带走。
      void rotateApiKey(`daily at ${hourLabel(hour)}`).catch((error) => {
        report('warn', `api key rotation failed: ${errorText(error)}`);
      });
    };
    let rotateTimerDisposer;
    ctx.effect(() => {
      // 每天醒一次，醒来跑完再排下一次：每次算的都是「距离下一个整点还有多久」，
      // 所以刚过点时会排到明天，不会在同一个点上反复醒。
      const schedule = () => {
        const wait = msUntilDailyHour(hour);
        if (typeof ctx.interval === 'function') {
          rotateTimerDisposer = ctx.interval(() => {
            rotateTimerDisposer?.();
            tick();
            schedule();
          }, wait);
          return;
        }
        // 没有 timer 服务（测试桩或最小组合）时退回裸定时器：同样是「跑完再排」。
        const handle = setTimeout(() => {
          tick();
          schedule();
        }, wait);
        handle.unref?.();
        rotateTimerDisposer = () => clearTimeout(handle);
      };
      schedule();
      return () => {
        rotateTimerDisposer?.();
        rotateTimerDisposer = undefined;
      };
    }, 'qq-bridge:api-key-rotate');
    report(
      'info',
      `api key rotation: on, daily at ${hourLabel(hour)} — pool ${apiKeyPoolLabel}, ref ${apiKeyRefName}, ` +
        `probe ${settings.apiKeyProbeUrl.length > 0 ? settings.apiKeyProbeUrl : '(disabled)'}`,
    );
  } else if (apiKeyRotateOn) {
    // 配置本身不合法（ref 不是变量名 / 池子在 cwd 外）：启动时已经逐条 warn 过，这里不重复。
  } else {
    report('info', 'api key rotation is off (apiKeyRotate is false)');
  }

  // ---- 主动说话：定时器 --------------------------------------------------------
  //
  // 与摘要循环同一套托管方式（`ctx.interval`，插件卸载即清掉）。区别在于节奏：
  // 摘要是「每天一个整点」，主动说话是「每隔一会儿看一眼」—— 醒来不一定开口，
  // 说不说交给 `proactiveSweep` 的条件与概率决定（这样开口的时刻才是不可预测的）。
  if (proactiveEnabled) {
    const checkMs = settings.proactiveCheckMs;
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
    const fromHour = Math.min(23, Math.max(0, Math.floor(Number(settings.proactiveFromHour)) || 0));
    const toHour = Math.min(23, Math.max(0, Math.floor(Number(settings.proactiveToHour)) || 0));
    report(
      'info',
      `proactive on — cold openers in groups only: check every ${Math.round(checkMs / 60000)} min, ` +
        `quiet for ${Math.round(settings.proactiveIdleMs / 60000)} min, ` +
        `gap ${Math.round(settings.proactiveGapMs / 60000)} min, ` +
        `at most ${settings.proactiveDailyMax}/day, ${hourLabel(fromHour)}-${hourLabel(toHour)}`,
    );
  }

  // 活跃对话的启动自述放在 `proactive` 块**外面**：免 @ 接话（一对一与多人搭话）都不需要
  // `proactive` —— 那是「主动找人说话」的总开关，只有「自己补一句」靠它。
  if (proactiveEnabled && settings.activeWindowMs > 0 && settings.activeChimeIdleMs > 0 && settings.activeChimeMax > 0) {
    report(
      'info',
      `active conversation — chime: about ${Math.round(settings.activeChimeIdleMs / 1000)}s after its reply, ` +
        `at most ${settings.activeChimeMax}/message and ${settings.activeChimeDailyMax || '不限'}/day (groups and private)`,
    );
  } else if (proactiveEnabled) {
    report('info', 'active conversation — chime is off (activeWindowMs / activeChimeIdleMs / activeChimeMax)');
  } else {
    report('info', 'active conversation — chime is off (proactive is off)');
  }
  if (settings.activeFollow === true && settings.activeWindowMs > 0) {
    report(
      'info',
      `active conversation — activeFollow on: a group follow-up from the person it is talking to needs no @ ` +
        `(it answers every one of them until ${settings.activeMaxTurns || '不限'} turns, ` +
        `stopped by ${Math.round(settings.activeFollowIdleMs / 60000)} min of silence); ` +
        `group talk after ${settings.activeGroupLines || '关闭'} lines from ${settings.activeGroupSpeakers} speakers ` +
        `(listen x${settings.activeGroupBatchScale}) is admitted by a roll — ` +
        `start ${Math.round(settings.activeTalkChance * 100)}%, +${Math.round(settings.activeTalkChanceStep * 100)}% per miss, ` +
        `up to ${Math.round(settings.activeTalkChanceMax * 100)}%`,
    );
  } else {
    report('info', 'active conversation — activeFollow is off: group messages still need an explicit @ (or the configured prefix)');
  }

  // 定时提醒：启动自述把「文件在哪、最高模式、额度、补发窗口」一次说清 ——
  // 排查「它怎么不提醒」时，先看这行有没有出现、模式是不是被 reminderModes 挡住了。
  if (remindersEnabled) {
    report(
      'info',
      `reminders on — ${settings.reminderFile}, modes up to ${settings.reminderModes}` +
        `${settings.reminderModes === 'text' ? ' (fixed text only)' : ''}, ` +
        `${settings.reminderMaxActive}/conversation, ${settings.reminderDailyMax || '不限'}/person/day, ` +
        `grace ${Math.round(settings.reminderGraceMs / 60000)} min, agent timeout ${Math.round(settings.reminderAgentTimeoutMs / 1000)}s`,
    );
  } else if (!settings.reminder) {
    report('info', 'reminders are off (reminder is false)');
  }

  // 人格与表达：启动时说清「人设从哪来」。排查「改了 PERSONA.md 没反应」时，第一件事
  // 就是看这行说的是文件还是配置 —— 两套人设叠加是最容易搞混的地方。
  const personaProfile = personaDoc.read();
  if (personaProfile !== undefined) {
    const traits = personaProfile.profile.traits.filter((trait) => trait.enabled).length;
    report(
      'info',
      `人设来自 ${personaDoc.path}（${traits} 条启用的性格${settings.personaSceneOverlays ? '' : '，场景叠加已关'}）` +
        (settings.persona.trim().length > 0 ? '；配置里的 persona 已被文件取代（不再叠加）' : ''),
    );
  } else if (settings.persona.trim().length > 0) {
    report('info', '人设来自配置 persona（没有找到 PERSONA.md）');
  } else {
    report('info', `人设用内置那份（写 ${settings.personaFile || '.qq-persona/PERSONA.md'} 可以换成自己的）`);
  }
  const styleProse = styleDoc.read();
  if (styleProse !== undefined) {
    // 顺带报「几节 / 几条」：改完文件在日志里一眼能看出有没有真的读进去（写歪的节现在
    // 会并进「总体」，条数对得上就说明内容生效了）。
    const sections = Object.values(styleProse.prose).filter((lines) => lines.length > 0).length;
    const entries = Object.values(styleProse.prose).reduce((sum, lines) => sum + lines.length, 0);
    report(
      'info',
      `表达规则来自 ${styleDoc.path}（${sections} 节 / ${entries} 条）；气泡：模型写几条发几条（没有条数上限）；聊天型门槛 ${chatMaxChars > 0 ? `${chatMaxChars} 字` : '关（全部按聊天型）'}`,
    );
  } else {
    report('info', '表达规则用内置那份（写 .qq-persona/STYLE.md 可以换成自己的）');
  }

  // 表情包目录：启动时确保它存在 —— 「往里丢几张图就能用」比「先读文档建目录」友好。
  // 建不出来（只读挂载、权限不对）只是没有表情包可挑，发图本身照常，所以只记一条 warn。
  if (imageSend && stickerRoot !== undefined && stickerInside) {
    void mkdir(stickerRoot, { recursive: true }).catch((error) => {
      report('warn', `could not create stickerDir ${stickerRoot}: ${errorText(error)}`);
    });
  }

  // 会话代次（`/reset` 开到了第几轮）预热：不读回来的话，重启后所有会话都会退回第 0 轮，
  // 把 reset 之前那段会话 resume 回来。这里**可以**在启动时一次性扫完 —— 与摘要不同，
  // 它不依赖 `conversations`（那张表此刻还是空的），磁盘上有什么就是什么。
  void loadConversationResetCounts().catch((error) => {
    report('warn', `could not load the session rounds: ${errorText(error)}`);
  });

  // 重置权限的启动自述：这是唯一一个「白名单为空 = 全都不能用」的配置项，很容易
  // 配好了没生效（写错 QQ 号、忘了重启）却看不出来 —— 日志里明说一遍，排查时一眼就懂。
  if (resetCommand.length === 0) {
    report('info', 'reset command is disabled (resetCommand is empty)');
  } else if (resetUsers.length === 0) {
    report('info', `reset command "${resetCommand}" is disabled for everyone: resetUsers is empty`);
  } else {
    report('info', `reset command "${resetCommand}" is allowed for ${resetUsers.length} account(s): ${resetUsers.join(', ')}`);
  }
}
