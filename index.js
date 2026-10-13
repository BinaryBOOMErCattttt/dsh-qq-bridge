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
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { OneBotClient, blankMessageLabel, chunkText, collectMedia, findReply, mediaPlaceholder, mentions, mentionsOthers, messageToText, repeatableText, splitBurst, splitStickerLines, typingDelayMs } from './onebot.js';
import { createMediaStore } from './media.js';
import { hashDistance, perceptualHash } from './perceptual.js';
import { DEFAULT_IMAGE_MAX_BYTES, imageSegment, insideDirectory, loadOutgoingImage } from './image.js';
import { createJmService, parseJmRef } from './jm.js';
import { registerQqTools } from './tools.js';
import { createSettings, MAX_TIMER_MS } from './settings.js';
import { createChatter } from './chatter.js';
import {
  activeFollowAllows as activeFollowAllowsRule,
  activeTurnsLeft as activeTurnsLeftRule,
  batchCap as batchCapRule,
  batchScale as batchScaleRule,
  batchWindow as batchWindowRule,
  chimeAllows,
  chimeDelay as chimeDelayRule,
  proactiveEligible as proactiveEligibleRule,
  proactiveSkip,
} from './speaking-rules.js';
import { createMemory } from './memory.js';
import {
  apiKeyFingerprint,
  errorText,
  hourLabel,
  localDate,
  memorySlug,
  msUntilDailyHour,
  parseApiKeyPool,
  sessionIdFor,
  visibleText,
  withinActiveHours,
} from './util.js';
import { readTextOrUndefined, writeJsonAtomic } from './filestore.js';

// 这三个的契约由 test/bridge.test.mjs 直接从插件入口验，所以在这里再导出一次
// （Loader 也只认 index.js 这个入口，搬走的东西必须在入口处仍然拿得到）。
export { parseApiKeyPool, sessionIdFor, withinActiveHours } from './util.js';

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
  const settings = createSettings(config, process.cwd());
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
   * 群号 → 群里的最近消息（`{ name, text }`，旧 → 新）。
   *
   * 只记「不是发给机器人的」那些消息：真人回话前是先看着群里在聊什么，
   * 而不是只看到 @ 自己的那一句。缓冲单独按群号存，而不是挂在会话记录上 ——
   * 没被 @ 的消息不该因此凭空造出一条会话。
   */
  const ambient = new Map();
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
    allowTools,
    approvalPolicy,
    resolveRoute,
    resolveAgentPreset,
    mountAgentPreset,
    restrictAgentTools,
    channelSectionOrder: CHANNEL_SECTION_ORDER,
  });

  // ---- 模型凭据：每天尝试轮换（见 README「每天轮换 API key」）------------------
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
   * 禁漫（JM）下载服务：起 python 子进程下载 → 合并 PDF → 用一次性 URL 交给 NapCat。
   *
   * 为什么绕这么大一圈：NapCat 跑在容器里，插件跑在宿主机上，`upload_private_file`
   * 只认 URL（实测传本地路径会回 `识别URL失败`）。所以 PDF 落盘之后，插件在本机
   * docker 网桥上开一个小 HTTP 服务，把文件交给 NapCat 自己来拉。
   */
  const jmService = createJmService({
    cwd,
    dir: settings.jmDir,
    python: settings.jmPython,
    script: settings.jmScript.trim().length > 0 ? settings.jmScript : fileURLToPath(new URL('./scripts/jm_download.py', import.meta.url)),
    enabled: settings.jmDownload,
    maxChapters: settings.jmMaxChapters,
    maxPages: settings.jmMaxPages,
    timeoutMs: settings.jmTimeoutMs,
    requestTimeoutMs: settings.jmRequestTimeoutMs,
    maxFiles: settings.jmMaxFiles,
    maxJobs: settings.jmMaxJobs,
    fileHost: settings.jmFileHost,
    filePort: settings.jmFilePort,
    urlTtlMs: settings.jmUrlTtlMs,
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
    const sessionId = sessionIdFor(conversation.key, conversation.sessionGeneration ?? 0);
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
    const wanted = settings.agentPreset.trim();
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
      (settings.persona.trim().length > 0 ? settings.persona.trim() : DEFAULT_PERSONA),
      '',
    ];
    // 长期记忆：把「已记住的东西」摆到眼前，模型才不会每次都从零开始 —— 并明确
    // 告诉它「忘了就去查」，而不是凭印象编。索引是摘要 Agent 维护的，这里只读。
    if (memory.toolsAllowed()) {
      const index = memory.indexText(conversation);
      if (index.length > 0) {
        lines.push('你记得的事（长期记忆的索引；原文件在 `' + memory.label + '/`）：', '', index, '');
      } else {
        lines.push(`你的长期记忆在 \`${memory.label}/\` 里（现在还是空的）。`, '');
      }
    }
    // 「一轮发几条」这条规则必须跟当前配置一致：设了 burstMaxMessages: 1 之后还告诉模型
    // 「想连说几句就直接换行」，就是一条它照做也做不到的指示（换行会被并回同一条）。
    // 混合模式（burstSingleMaxChars > 0）则要同时说清「闲聊别拆」和「展开就分条」。
    const messageCap = settings.burstMaxMessages;
    const singleUnder = settings.burstSingleMaxChars;
    const burstRule = !settings.humanize
      ? '- 你的整轮回复会作为一条消息直接发出去（换行也留在同一条里），直接写要说的话，别把它当文档排版。'
      : singleUnder > 0
        ? `- 闲聊归闲聊：去掉空白不超过 ${singleUnder} 字的回复会被并成**一条**发出去，所以平时就一两句话、一行写完，别把一句能说完的话拆成两拍。真要展开讲（对方要你详细说、贴代码 / 列步骤 / 解释清楚）就换行，一行一条短句，插件会照发${messageCap > 0 ? `（一轮最多 ${messageCap} 条）` : '（但别超过三四条）'}；内容不多就别硬拆。`
        : messageCap === 1
          ? `- 一次只说一句：你的整轮回复会被并成**一条**消息发出去（写换行也只是同一条里的换行），所以别把话拆成几条短句，就把那一两句直接写出来，别没事写小作文。对方明确要你详细讲、或者要贴代码 / 步骤 / 清单时，就正常写完整 —— 长内容也还是这**一条**（超过 ${settings.maxReplyChars} 字才会被协议上限切成两段），只是别把短回复硬拉长。`
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
    // 空消息（单纯的 @、或者一个空格）现在也会走到这里，正文位置就是这么一句说明 ——
    // 不解释的话模型会把它当成对方真的发了这串字，回一句「我没发这个啊」。同时点明
    // 「怎么翻上下文」：群里看得到「群里最近的消息」，更早的用 qq_transcript 查，
    // 只想表示「看到了 / 无语」时「？」或者一张表情就够了 —— 空 @ 不该换来一篇小作文。
    if (settings.blankReply === true) {
      lines.push(
        '- 正文里出现 `（@了你一下，没有说别的）` / `（一条空消息，没有正文）` / `（对方发来一条空消息，什么都没写）` 时，说明对方**没有打字**，只是叫了你一声：别把这句说明当成对方说的话、也别反问「你发了什么」。想接就按上面的聊天记录（群里看「群里最近的消息」，更早的用 qq_transcript 查）接上一句或者回个「？」；也可以只发一张表情（见下），或者干脆想不出接什么。空 @ 不值得写一段话。',
      );
    }
    // 被白名单挡住的工具不能在提示里推荐，否则模型会去调用一个它根本看不见的工具。
    const recommended = ['qq_send_message', 'qq_list_conversations'].filter(
      (tool) => allowTools.length === 0 || allowTools.includes(tool),
    );
    if (recommended.length > 0) {
      lines.push(`- 需要主动给其他人或群发消息、或查询联系人时，使用 ${recommended.join(' / ')} 工具。`);
    }
    // 长期记忆的用法：索引已经在上面了，这里说清「怎么查、怎么记、什么时候该去学个新梗」。
    // 三个工具名都先过白名单，避免推荐一个模型根本看不见的工具。
    if (memory.toolsAllowed()) {
      const canSkill = allowTools.length === 0 || allowTools.includes('skill');
      lines.push(
        `- 凭印象记不清「以前谁说过什么 / 这个群里发生过什么」时，别顺着猜：用 qq_transcript 查聊天记录（可以按关键词 search），用 qq_memory 读 \`${memory.label}/\` 里的记忆文件——先查再答，而不是先答再编。`,
        `- 真遇到值得长期记住的事（某人的偏好、群里的约定、一件发生过的事），用 qq_memory 追加到 \`conversations/<会话目录>/MEMORY.md\`；不要为了记而记，一两句就够。`,
        canSkill
          ? '- 遇到看不懂的梗、黑话或表情包（图里写了什么、为什么大家都在笑），先用 read_image 看那张图；二次元 / ACG 那一类加载 `moegirl` skill 去萌娘百科查（比搜索引擎准），其它话题用 web_search。弄懂后按 `update-cognition` skill 的规矩记进认知库；不要不懂装懂、也不要一本正经地解释网络梗。'
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
    if (settings.quoteMedia) {
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
    if (settings.instructions.trim().length > 0) {
      lines.push('', settings.instructions.trim());
    }
    return lines.join('\n');
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

  /**
   * 「日常闲聊并成一条」的字数门槛（`burstSingleMaxChars`；非正数 = 关掉）。
   *
   * 按去掉空白后的字数算：换行、缩进这些排版字符不该把一条闲聊顶过门槛。
   */

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
    const limit = settings.maxReplyChars;
    if (!settings.humanize) return chunkText(text, limit);
    const burst = Number.isSafeInteger(settings.burstMaxChars) && settings.burstMaxChars > 0
      ? Math.min(settings.burstMaxChars, limit)
      : limit;
    const maxParts = Number.isFinite(settings.burstMaxParts) ? Math.max(1, Math.floor(settings.burstMaxParts)) : 3;
    const singleUnder = settings.burstSingleMaxChars;
    const short = singleUnder > 0 && text.replace(/\s+/g, '').length <= singleUnder;
    const maxMessages = short ? 1 : settings.burstMaxMessages;
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
      for (const part of chunkText(text, settings.maxReplyChars)) {
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
    const asText = (value) => (human ? burstParts(value) : chunkText(value, settings.maxReplyChars)).map((part) => ({ kind: 'text', text: part }));
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
      // 我自己的话也算「把被回复的那条挤远了」：回复指向的进度表在这一刻进账
      // （NapCat 不回灌自己的消息，等不到事件，见 `noteOwnMessage`）。
      noteOwnMessage(conversation.type, conversation.id);
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
          charsPerSecond: settings.charsPerSecond,
          minDelayMs: settings.minDelayMs,
          maxDelayMs: settings.maxDelayMs,
          jitter: settings.delayJitter,
          baseMs: index === 0 ? settings.readDelayMs : 0,
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
    const style = settings.replyStyle;
    if (style === 'auto') {
      // 只在「我回的那条后面又出现了消息」时才引用 —— **包括我自己刚发出去的话**
      // （上一轮的回复、复读、主动搭话）：紧挨着回时引用是纯噪音，一轮问答本来就看得出来
      // 在回谁；被后来的话挤远了才需要点名，不然看的人对不上话头。
      const drifted = typeof quote.seq === 'number' && chatter.anchor(conversation.id) > quote.seq;
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
    const command = settings.jmCommand.trim();
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
      await client.call(action, params, settings.jmUploadTimeoutMs);
      // 传进群里的这份 PDF 也是一条「我自己发的消息」（见 `noteOwnMessage`）。
      noteOwnMessage(conversation.type, conversation.id);
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
    conversation.activeUntil = 0;
    conversation.activeSpeakerId = '';
    conversation.activeInterposeSeq = 0;
    conversation.activeTurns = 0;
    conversation.chimeCount = 0;
    conversation.chimeDay = '';
    conversation.chimeToday = 0;
    report('info', `started round ${round} for ${conversation.key} (${sessionId} → ${nextSessionId}); the old session is kept on disk`);
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
       * 这是这个会话的第几轮（0 = 第一轮，`/reset` 每按一次 +1）。
       *
       * 唯一的用途是派生当前这一轮的 Session id（见 sessionIdFor）：`/reset` 不删旧会话，
       * 只是换一个 id 重新开始。新建记录时由 `refreshSessionGeneration` 从 reset 标记
       * 里带上，`resetConversation` 当场 +1。
       */
      sessionGeneration: 0,
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
       * `activeInterposeSeq` 是那条消息那一刻的插话序号，用来判断「中间有没有别人说过话」；
       * `activeTurns` 是这次活跃对话里已经免 @ 接了几轮（受 activeMaxTurns 约束）。
       */
      activeUntil: 0,
      activeSpeakerId: '',
      activeInterposeSeq: 0,
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
      // 磁盘上说这个会话已经 reset 过几次，就从那一轮开始 —— 重启不该把
      // reset 之前那段会话 resume 回来。
      refreshSessionGeneration(conversation);
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
      // 活跃对话：没被叫到，但同一个人正在跟它聊，接着说的这句也算。（只认**已经存在**
      // 的会话 —— 闲聊不该因为「窗口」把某个群变成「处理过」的群。）
      const existing = conversations.get(`group:${groupId}`);
      // 多人搭话：这个群最近自己聊热了（够条数、够人数），那之后谁接话都算 —— 这也是
      // 「有人插话就进入多人搭话」的落点：插话的人与那句话本身就记在 chatter 的热度窗口里，
      // 大家说得够多就整体升级，而不是像一对一那样被一句话打断。
      //
      // 它**不**消耗 `activeMaxTurns`：那个上限是防「一个人揪着它刷屏」的，而这里的闸门
      // 本身就是「窗口里够条数、够人数」—— 大家一停，窗口自己就空了。再叠一层轮数上限，
      // 只会让它在最热闹的时候接几句就哑掉（那正是搭话状态该起作用的时候）。
      const groupTalk = !explicit && existing !== undefined && groupTalkActive(groupId);
      const followed = !explicit && existing !== undefined && activeFollowAllows(existing, userId, message, selfId);
      const continued = groupTalk || followed;
      if (!explicit && !continued) return undefined;
      // 没有正文：单纯的 @、或者就是一个空格。这和「被叫到之后闲聊」是两回事 —— 对方
      // 明确点了名却什么都没说，本身就是一种信号（想让它接上一句、或者就是想看它反应）。
      // 所以显式的空消息照常放行，只把正文位置换成一句说明，由模型接着上下文决定回
      // 「？」、发张表情、还是接上一句（`blankReply` 关掉时回到「静默丢弃」）。
      //
      // 两处刻意收紧：活跃对话窗口里接上的空消息不算（那只是「他说了句话，正好没内容」，
      // 不是点名，接上去就成了抢答）；前缀模式下按前缀长度硬切出空串也不算（那不是空消息，
      // 是没内容可切，别硬凑一句话回）。
      const blank = preview.length === 0 && explicit && !prefixed;
      if (preview.length === 0 && !blank) return undefined;
      if (blank && settings.blankReply !== true) return undefined;
      // 空消息的说明在这里算**一次**、往下传给 `submitBatch`：那边是媒体落盘后重新渲染
      // 的正文（`at` 段同样会被剔掉，仍然是空），若让它自己再拼一句，就得把「有没有 @」
      // 这件事也带下去，多一份要同步维护的状态（第一版正是这么写的，@ 与空消息的措辞串了）。
      const blankBody = blank ? blankMessageLabel({ group: true, mentionedMe }) : '';
      const conversation = conversationFor('group', groupId, {
        groupName: '',
        userId: event.user_id,
        userName: sender.card ?? sender.nickname ?? String(event.user_id),
      });
      noteActiveMessage(conversation, userId, continued);
      return {
        conversation,
        message,
        preview: blank ? blankBody : preview,
        blankBody,
        continued,
        // 回复指向：引用被回复的那条消息（`reply` 段要 message_id），或 @ 回提问者（要 QQ 号）。
        // `seq` 是这条消息在群里的进度，供 `auto` 判断「等我回话时有没有人（包括我自己）
        // 又说了话」。三样都在这里一次性快照：发送在几秒后，那时会话记录和群里的进度都可能变了。
        quote: { messageId: String(event.message_id ?? ''), userId: String(event.user_id ?? ''), seq: chatter.anchor(groupId) },
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
      preview,
      blankBody,
      continued: false,
      // 私聊始终是 plain，`seq` 只是让 quote 的字段形状保持一致。
      quote: { messageId: String(event.message_id ?? ''), userId: String(event.user_id ?? ''), seq: 0 },
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
   * JM 上传）各记一次，不依赖任何回灌配置。
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
    const entry = { name, text: text.slice(0, lineChars) };
    list.push(entry);
    while (list.length > limit) list.shift();
    ambient.set(groupId, list);
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
    const entry = { ...candidate, count, senders, at: arrivedAt };
    if (!canAct || count < threshold || !distinct) {
      state.chain = entry;
      return;
    }
    const chance = Math.min(1, Math.max(0, Number(settings.repeatChance)));
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
   * 主动搭话的「我不说话」信号：第一行以 `SKIP` 开头（容忍各种括号与前后空白）。
   *
   * 宽松一点是有意的：模型经常顺手把自己的决定解释一下（`SKIP（没什么可说的）`），
   * 那半句同样不该发到群里 —— 它是在解释内部决定，不是群友会说的话。只看第一行，
   * 后面的解释直接丢掉。`skip` 后面要求一个词边界，免得把 `skipping` 这类正文吞掉。
   * @param text - 这一轮的回复正文。
   * @returns 整条都不该发出去时为 true。
   */
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
  // 就把话题掐掉。三件事共用一个「活跃对话」窗口（`activeUntil`）：
  //
  //   A. 免 @ 接话（`activeFollow`）：被叫到之后的窗口内、正在跟它聊的那个人接着说的话
  //      也算在跟它聊（window 默认 1 分钟 —— 一个人 @ 一次只买这一小段）；
  //   B. 自己补一句（`activeChime*`）：它回完之后对方安静了一小会儿，它可能再追一句；
  //   C. **多人搭话**（`activeGroup*`）：群里几个人自己聊了起来（最近窗口里够条数、够人数），
  //      它就进入搭话状态 —— 那之后谁接话都免 @，而且「倾听时间」变长（攒批更久），
  //      多听几句才合成一轮回复。
  //
  // 窗口只靠**别人发来的消息**往后滑（机器人自己说的话不算，否则它自己就能给窗口续命）；
  // 一对一窗口里有人插话，这次「你跟我聊」就算断了，要重新叫它一次 —— 但插话本身会记进
  // 热度窗口，大家一起说的话够多、够热闹时，走的就是 C 而不是 A 了（这就是
  // 「有人插话就考虑进入多人搭话」的落点）。



  /** 免 @ 接话的轮数还有余额吗（`activeMaxTurns` 为 0 表示不限）。 */
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
   * 由 `admit` 在两条路上调用：**被叫到**（`continued === false`，会重置免 @ 接话的轮数）
   * 与**窗口内接上话**（`continued === true`，轮数 +1）。私聊的每条消息都算「被叫到」，
   * 所以私聊不需要 `activeFollow` 也能有「补一句」——窗口照样在滑。
   *
   * `activeInterposeSeq` 记的是这条消息那一刻的**插话序号**：用来判断「这条之后有没有别人说过话」，
   * 见 `activeFollowAllows` 与 `runChime`。
   *
   * @param conversation - 这条消息所属的会话。
   * @param userId - 发消息的人（群里只有他接着说的话才可能免 @ 算进来）。
   * @param continued - 这条是不是「窗口内接上的」（而不是被叫到）。
   */
  function noteActiveMessage(conversation, userId, continued) {
    conversation.activeUntil = Date.now() + settings.activeWindowMs;
    conversation.activeSpeakerId = userId;
    conversation.activeTurns = continued ? (conversation.activeTurns ?? 0) + 1 : 0;
    if (conversation.type === 'group') conversation.activeInterposeSeq = chatter.others(conversation.id);
    // 对方又说话了：这一句对应的「补一句」额度重新算，旧的那个定时器也就作废了。
    conversation.chimeCount = 0;
    cancelChime(conversation);
  }

  /**
   * 这条**没被叫到**的群消息能不能算「接着聊」（见 AGENTS.md §4.G 的 A 路）。
   *
   * 七条判据在 `speaking-rules.js` 的 `activeFollowAllows` 里（那里逐条写着为什么）；
   * 这里只把会话状态、插话序号与配置凑成那份入参。这一步放松的是「群里只在被 @ 时
   * 才说话」这条默认约定，宁可少接一句也别抢话。
   * @param conversation - 已有的会话记录。
   * @param userId - 发消息的人。
   * @param message - OneBot 的 `message` 字段。
   * @param selfId - 机器人自己的 QQ 号。
   * @returns 可以当「接话」时为 true。
   */
  function activeFollowAllows(conversation, userId, message, selfId) {
    return activeFollowAllowsRule({
      enabled: settings.activeFollow === true,
      windowMs: settings.activeWindowMs,
      type: conversation.type,
      speakerId: conversation.activeSpeakerId,
      userId,
      activeUntil: conversation.activeUntil,
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
  function chimeDelay() {
    return chimeDelayRule(settings.activeChimeIdleMs, settings.delayJitter, Math.random());
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
    if (settings.activeWindowMs <= 0 || settings.activeChimeIdleMs <= 0 || settings.activeChimeMax <= 0) return;
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
    const now = Date.now();
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
   * 机器人会永远不吭声。多人搭话时这两个值一起按 `activeGroupBatchScale` 放大，
   * 于是它会多听几句再合成一轮（见 `batchScale`）。
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
    conversation.pending.push(entry);
    const cap = batchCap(window, scale);
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
   * 只带 @、没有正文的消息在这里也**不丢**：正文换成一句「他 @ 了你一下，没说什么」
   * —— 模型得知道轮到自己说话了，才能决定回一句「？」、发张表情，还是接上一句
   * （见 `blankReply`）。只有在引用也没取到、整批确实什么都没有时才什么都不发。
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
        const composed = quote === undefined
          ? body
          : body.length > 0
            ? `${quotePrefix(quote)}\n${body}`
            : quotePrefix(quote);
        // 正文与引用都是空的（`admit` 里的空消息通常已经给了 `blankBody`，这里只是最后
        // 一道防线）：绝不能给模型递一条空消息 —— 它会以为出了一条没有内容的消息。
        const text = composed.length > 0 ? composed : (item.blankBody ?? '');
        if (text.length === 0) continue;
        entries.push({ name: item.name, id: item.userId, body: text });
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
    // 快照与发送时读到的值相等就说明中间没有新消息，`auto` 便不引用。
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
    memory.rememberTranscript(event, selfId, {
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
        void sendToConversation(conversation, `用法：${settings.jmCommand.trim() || '/jm'} <车号 或 18comic 链接>`, { quote });
      } else {
        void runJmCommand(conversation, jmCommand.ref, quote);
      }
      return;
    }
    // 会话重置指令：整条消息恰好等于指令才触发，且只对「发指令的这个会话」生效。
    // 它开的是**新一轮**会话（旧会话留在磁盘上当存档），而不是把记录删掉。
    // 攒着的那批是在重置之前收到的，必须先投出去，否则那几句话会被一起忘掉。
    if (commanded && resetCommand.length > 0 && preview.toLowerCase() === resetCommand) {
      // 权限：只有 resetUsers 里的人能用（默认空白名单 = 谁都不能）。没权限的**静默忽略**，
      // 既不重置也不回「你没有权限」—— 回一句等于告诉全群这里有这么个指令、还激人去试；
      // 这一条仍然照常记进转录（rememberTranscript 在前面已经跑过），留痕在记忆里。
      // 注意这个判断必须在 flushBatch / enqueue **之前**：那样没有权限的人连「让攒着的
      // 那批提前投出去」都做不到。
      if (!canReset(event.user_id)) {
        report('info', `ignored ${resetCommand} from ${conversation.key} by ${event.user_id}: not in resetUsers`);
        return;
      }
      flushBatch(conversation);
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
      // 「活跃对话里接上的一句」正文里没有前缀可去（见 admit / dropPrefix）。
      continued: admitted.continued === true,
      // 空消息（单纯 @ / 一个空格）的那句说明：媒体落盘后正文还是空的，用它兜底。
      blankBody: admitted.blankBody ?? '',
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
  //
  // 六份 `defineTool` 声明本身没有策略（校验参数 → 调一个函数 → 拼一段 render），却占了
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
    resolveStickerSource,
    imageSend,
    imageMaxBytes,
    resolveRoute,
    conversations,
    sessionIdFor,
    downloadJm,
    sendJmFile,
    // 记忆停用时 memory.tools 是 undefined：`registerQqTools` 会连那两个工具一起跳过，
    // 不留「一调就报错」的壳。
    memory: memory.tools,
  });
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
        `(window ${Math.round(settings.activeWindowMs / 60000)} min, at most ${settings.activeMaxTurns || '不限'} turns); ` +
        `group talk after ${settings.activeGroupLines || '关闭'} lines from ${settings.activeGroupSpeakers} speakers ` +
        `(listen x${settings.activeGroupBatchScale})`,
    );
  } else {
    report('info', 'active conversation — activeFollow is off: group messages still need an explicit @ (or the configured prefix)');
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
