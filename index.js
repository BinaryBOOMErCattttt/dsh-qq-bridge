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
 * 十一个宿主平面工具的**声明**在 `tools.js`（依赖由这里显式传进去，那边不持有状态）；
 * 本文件留的是它们的**能力来源**——收件人解析、发送队列这些真正有状态的东西。
 * 长期记忆整个子系统（转录 / 记忆文件 / 摘要循环）在 `memory.js`，同样由这里显式递依赖。
 *
 * @module @qqbot/dsh-plugin-qq
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { OneBotClient, atMentions, blankMessageLabel, collectMedia, findReply, isEmojiOnlyMessage, isStickerSegment, mediaPlaceholder, mentions, mentionsOthers, messageToText, repeatableText, userDisplayName } from './onebot.js';
import { createMediaStore } from './media.js';
import { createStickerFrames } from './sticker-frames.js';
import { hashDistance, perceptualHash } from './perceptual.js';
import { DEFAULT_IMAGE_MAX_BYTES, imageSegment, insideDirectory, loadOutgoingImage } from './image.js';
import { endpointTarget, findNapcatDir, repairNapcat } from './napcat.js';
import { registerQqTools } from './tools.js';
import { createEditor, defaultSkillRoot, expandHome } from './editor.js';
import { matchWakeCommand, parseMuteState, serializeMuteState } from './mute.js';
import { OWNER_SETTING_KEYS, applyOwnerSettings, coerceOwnerSetting, isWritableKey, parseOwnerSettings, settingKind } from './owner-settings.js';
import { helpText, parseCommand, usageLine } from './commands.js';
import { weatherReport } from './weather.js';
import { fetchBalance, renderBalance } from './balance.js';
import { createChatState } from './chat-state.js';
import { dailyFortune, flipCoin, formatFortune, parseDice, pickRandom, rollDice } from './fun.js';
import { renderSong, searchSong } from './music.js';
import { synthesize } from './tts.js';
import { createSettings, MAX_TIMER_MS } from './settings.js';
import { createChatter } from './chatter.js';
import { buildMentionResolver, isAllMention } from './mention.js';
import { createSender } from './send.js';
import { createStickerStore } from './sticker.js';
import { createReminderRuntime } from './reminder-runtime.js';
import { createBatcher } from './batch.js';
import { registerRoutes } from './routes.js';
import { createKeyRotation } from './key-rotation.js';
import { createPromptKit } from './prompt.js';
import {
  activeFollowAllows as activeFollowAllowsRule,
  activeTurnsLeft as activeTurnsLeftRule,
  chimeAllows,
  chimeDelay as chimeDelayRule,
  privateAfterthoughtAllows,
  proactiveEligible as proactiveEligibleRule,
  proactiveSkip,
} from './speaking-rules.js';
import { createMemory } from './memory.js';
import { createReminders, describeTask } from './reminders.js';
import { builtinStyle, createStyle, renderStyleContract } from './style.js';
import { createPersona, renderPersona } from './persona.js';
import { observationOf, renderObservation, renderSegment } from './modalities.js';
import { expandForward, forwardId } from './forward.js';
import { pokeAction, pokeActionType, pokeNudge, pokeNotice } from './interactions.js';
import { recallAction, recallNudge, recallNotice } from './recall.js';
import { decideGroupTurn } from './speech-policy.js';
import {
  errorText,
  hourLabel,
  liveConfig,
  localDate,
  localMinute,
  memorySlug,
  sessionIdFor,
  visibleText,
  weekdayLabel,
  withinActiveHours,
} from './util.js';
import { readJsonl, readTextOrUndefined, writeBytesAtomic, writeJsonAtomic, writeTextAtomic } from './filestore.js';

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
 * 一条消息里最多展开几个合并转发。
 *
 * QQ 正常一条消息只会带一个转发段；给到 2 是留一点余量（个别实现会把「转发 + 文字」
 * 拆成多个段）。再多就只保留占位符 —— 否则一条消息能拖出几十次 `get_forward_msg`
 * 与几十段聊天记录，而它们本来也不该被当成「这句话的内容」。
 */
const FORWARD_MAX_PER_MESSAGE = 2;

/**
 * 「上一轮那张表情没发出去」这条提醒在提示词里保留多久（毫秒）。
 *
 * 失败的原因（路径不存在 / 不在收藏目录）模型必须知道，否则它会照着自己编的路径
 * 再试一次 —— 真实事故：它写了一个 `.qq-media/<哈希>`，被拒之后下一轮又编了另一个。
 * 但这条提醒是短时效的：十轮之后还在说「上一轮」，模型会以为那是一句没做完的指令。
 */
const STICKER_FAILURE_TTL_MS = 10 * 60 * 1000;

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
 * 归属表（`submitted` / `turnOwners`）的兜底超时：一条消息投出去之后，如果永远等不到
 * `agent/inbox/claimed` 或 `turn/end`（模型端挂死、宿主在别处 dispose 了这个 Agent），
 * 那个条目不能永久占着会话 —— `busyWithTurn` 会一直为 true，主动说话 / 补一句 /
 * agent 提醒全部静默失效。一小时足够覆盖任何正常的一轮，也短到不会让人等到忘记。
 */
const OWNER_TTL_MS = 60 * 60 * 1000;

/**
 * `submitted` 的软上限。超过时按投递时间淘汰最旧的，**不能整表 `clear()`**：
 * 那会把正在飞的消息归属一起抹掉，之后 `turn/end` 找不到 owner，模型回复被静默丢弃。
 */
const SUBMITTED_MAX = 512;

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
  const baseSettings = createSettings(liveConfig(config), process.cwd());
  const cwd = baseSettings.cwd;
  // 小功能共用的状态文件（米饭 / 木鱼 / 关注 / 投票 / 纪念日 / 接龙）。读坏了退回空对象。
  const chatState = createChatState({ file: resolve(cwd, 'data/chat-state.json'), report });
  // 主人覆盖层（qq_settings / 直接改 data/owner-settings.json）：只含白名单键，
  // 叠在 GUI 的基础配置之上。坏值在读入时就丢掉并记 warn，绝不因为一个手滑把 bot
  // 起不来 —— 覆盖层不是配置的唯一真相，GUI 才是。
  const ownerSettingsRoot = baseSettings.ownerSettingsFile.length > 0 ? resolve(cwd, baseSettings.ownerSettingsFile) : undefined;
  const ownerSettingsInside = ownerSettingsRoot !== undefined && insideDirectory(resolve(cwd), ownerSettingsRoot);
  if (baseSettings.ownerSettingsFile.length > 0 && ownerSettingsRoot !== undefined && !ownerSettingsInside) {
    report('warn', `ownerSettingsFile "${baseSettings.ownerSettingsFile}" resolves outside cwd (${cwd}); owner overrides are disabled`);
  }
  const ownerSettingsValues = loadOwnerSettings();
  const { settings, applied: ownerSettingsApplied } = applyOwnerSettings(baseSettings, ownerSettingsValues, report);
  const approvalPolicy = settings.approvalPolicy;
  if (ownerSettingsApplied.length > 0) {
    report('info', `owner settings applied: ${ownerSettingsApplied.join(', ')} (from ${baseSettings.ownerSettingsFile})`);
  }

  /** 启动时读主人覆盖层（同步：`apply()` 期间就要拿它去算 settings）。 */
  function loadOwnerSettings() {
    if (!ownerSettingsInside) return {};
    try {
      const raw = JSON.parse(readFileSync(ownerSettingsRoot, 'utf8'));
      const parsed = parseOwnerSettings(raw, report);
      return parsed.values;
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      report('warn', `could not read ${baseSettings.ownerSettingsFile}: ${errorText(error)}`);
      return {};
    }
  }

  /** 把覆盖层落盘（原子写；工具出错时把原因交给模型）。 */
  function persistOwnerSettings(values) {
    if (!ownerSettingsInside) {
      throw new Error('ownerSettingsFile 不在 cwd 内，主人覆盖层已停用（改配置里的 ownerSettingsFile）');
    }
    return mkdir(dirname(ownerSettingsRoot), { recursive: true }).then(() =>
      writeJsonAtomic(ownerSettingsRoot, { version: 1, values }),
    );
  }

  /**
   * 覆盖层改动之后重启一次插件（`createSettings` 只在 apply() 里跑）。
   *
   * 延后 8 秒：先让这一轮回复（含打字延迟）真的发出去，否则主人只看到「设置改好了」
   * 然后 QQ 掉线、一个字都没收到。重启不结束进程，QQ 会话下一句照样 resume。
   */
  let settingsRestartTimer;
  function scheduleSettingsRestart() {
    if (settingsRestartTimer !== undefined) return;
    if (typeof ctx.fiber?.restart !== 'function') {
      report('warn', 'owner settings written, but this context has no fiber.restart — restart the service to apply');
      return;
    }
    settingsRestartTimer = setTimeout(() => {
      settingsRestartTimer = undefined;
      report('info', 'owner settings changed — restarting the plugin to apply');
      Promise.resolve()
        .then(() => ctx.fiber.restart())
        .catch((error) => report('warn', `owner settings restart failed: ${errorText(error)}`));
    }, 8000);
    settingsRestartTimer.unref?.();
  }
  // 工具白名单：去掉空白项与重复项。空数组 = 不限制，与 allowUsers / allowGroups 语义一致。
  const allowTools = settings.allowTools;
  // 会话重置指令：大小写不敏感，空串表示禁用。
  const resetCommand = settings.resetCommand;
  // ---- 主人（受信者）：QQ 号确认，最高权限 ----
  //
  // 优先级：配置里写了 `resetUsers` 就用那份名单（部署者明确指定，最可控）；名单为空
  // 时才走「第一个在私聊里跟它说话的人自动认主」，认到的号落盘到 ownerFile —— 重启
  // 不丢，也不需要重启才能生效。昵称可以随便改，权限只认 QQ 号。
  const configuredOwners = settings.resetUsers;
  const ownerFileRoot = settings.ownerFile.length > 0 ? resolve(cwd, settings.ownerFile) : undefined;
  const ownerFileInside = ownerFileRoot !== undefined && insideDirectory(resolve(cwd), ownerFileRoot);
  if (settings.ownerFile.length > 0 && ownerFileRoot !== undefined && !ownerFileInside) {
    report('warn', `ownerFile "${settings.ownerFile}" resolves outside cwd (${cwd}); the owner will only live in memory`);
  }
  /** 主人 QQ 号列表（配置优先，否则是自动认主那一位）。 */
  const ownerState = { ids: [...configuredOwners] };
  if (configuredOwners.length === 0 && settings.ownerAutoClaim) loadOwnerState();

  /** 启动时把自动认主的结果读回来。 */
  function loadOwnerState() {
    if (!ownerFileInside) return;
    try {
      const parsed = JSON.parse(readFileSync(ownerFileRoot, 'utf8'));
      const id = String(parsed?.id ?? parsed?.userId ?? '').trim();
      if (/^\d{5,12}$/.test(id)) {
        ownerState.ids = [id];
        report('info', `owner restored from ${settings.ownerFile}: ${id}`);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      report('warn', `could not read ${settings.ownerFile}: ${errorText(error)}`);
    }
  }

  /** 落盘自动认主的结果（失败只记 warn：内存里已经生效）。 */
  function persistOwnerState() {
    if (!ownerFileInside) return;
    void mkdir(dirname(ownerFileRoot), { recursive: true })
      .then(() => writeJsonAtomic(ownerFileRoot, { version: 1, id: ownerState.ids[0] ?? '', at: Date.now() }))
      .catch((error) => report('warn', `could not save ${settings.ownerFile}: ${errorText(error)}`));
  }

  /**
   * 第一个在**私聊**里跟它说话的 QQ 号 = 主人（只发生一次）。
   *
   * 群聊里说话不算：一个刚装好的 bot 被拉进群时，第一条消息往往来自群友；把那种
   * 「第一个说话的人」当成主人等于把最高权限送给陌生人。私聊才是「加好友」的那条路。
   * @returns 这次是否刚认主。
   */
  function claimOwnerIfNeeded(event, selfId) {
    if (!settings.ownerAutoClaim || configuredOwners.length > 0) return false;
    if (event?.message_type !== 'private') return false;
    if (ownerState.ids.length > 0) return false;
    const userId = String(event.user_id ?? '');
    if (userId === '' || userId === String(selfId)) return false;
    ownerState.ids = [userId];
    persistOwnerState();
    report('info', `owner claimed by the first private contact: ${userId} (set resetUsers to pin it)`);
    return true;
  }

  /**
   * 这个人可不可以做「主人的事」：重置会话、通过 qq_quiet 静默、用受信写盘工具。
   *
   * 语义刻意**与 allowUsers / allowGroups 相反**：名单为空且没认主 = **谁都不能**，
   * 而不是「谁都能」。群消息是不可信输入，一个「空白名单等于人人可用」的默认值意味着
   * 群里任何一个人都能悄悄重置记忆、改人设或者把 bot 按停。
   *
   * 比较时两边都折成字符串：OneBot 的 user_id 可能是数字，配置里写的是文本。
   * @param userId - 发消息的人（私聊是对方，群聊是发言者，不是群号）。
   * @returns 有这个权限时为 true。
   */
  function canReset(userId) {
    return ownerState.ids.includes(String(userId ?? ''));
  }
  // 受信写盘、静默、重置共用同一份名单：只配一处，免得出现「能重置但不能改人设」。
  const canOperate = canReset;
  // 受信写盘（qq_write / qq_edit / qq_skill）：只在 trustedWrite 打开时装配。
  // skillRoot 默认 `$DSH_HOME/skills`（也就是 ~/.dsh/skills），同样由配置覆盖。
  const skillRoot = settings.trustedWrite ? (expandHome(settings.skillWriteDir) || defaultSkillRoot()) : '';
  const editor = settings.trustedWrite
    ? createEditor({ cwd, skillRoot, maxBytes: settings.writeMaxBytes, report })
    : undefined;
  // 静默状态文件：配置成 cwd 外时只记在内存里（并记一条 warn），不阻断功能。
  const muteRoot = settings.mutePersist && settings.muteFile.length > 0 ? resolve(cwd, settings.muteFile) : undefined;
  const muteInside = muteRoot !== undefined && insideDirectory(resolve(cwd), muteRoot);
  if (settings.mutePersist && muteRoot !== undefined && !muteInside) {
    report('warn', `muteFile "${settings.muteFile}" resolves outside cwd (${cwd}); quiet state will only live in memory`);
  }
  /** 静默状态：`global` 覆盖全部会话，`keys` 是单个会话。 */
  const muteState = { global: false, keys: new Set(), at: 0, by: '' };
  if (muteInside) loadMuteState();

  /** 这个群现在是不是被静默了（私聊永远不静默：它是控制通道）。 */
  function isMuted(key) {
    if (typeof key !== 'string' || !key.startsWith('group:')) return false;
    return muteState.global || muteState.keys.has(key);
  }

  /** 启动时把静默状态读回内存（同步：设置页保存后插件重启，第一条消息就不该漏）。 */
  function loadMuteState() {
    try {
      const raw = readFileSync(muteRoot, 'utf8');
      const parsed = parseMuteState(JSON.parse(raw));
      muteState.global = parsed.global;
      muteState.keys = new Set(parsed.keys);
      muteState.at = parsed.at;
      muteState.by = parsed.by;
      if (muteState.global || muteState.keys.size > 0) {
        report('info', `quiet state restored: ${muteState.global ? 'all conversations' : `${muteState.keys.size} conversation(s)`}`);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      report('warn', `could not read ${settings.muteFile}; starting awake: ${errorText(error)}`);
    }
  }

  /** 落盘静默状态（失败只记 warn：内存里已经生效）。 */
  function persistMuteState() {
    if (!settings.mutePersist || !muteInside) return;
    void mkdir(dirname(muteRoot), { recursive: true })
      .then(() => writeJsonAtomic(muteRoot, serializeMuteState(muteState)))
      .catch((error) => report('warn', `could not save the quiet state: ${errorText(error)}`));
  }

  /** 一个会话身上挂着的、还没发出去的东西（攒批 / 补一句）一起清掉。 */
  function clearPendingFor(conversation) {
    if (conversation === undefined) return;
    if (conversation.pending.length > 0) conversation.pending.length = 0;
    if (conversation.batchTimer !== undefined) {
      clearTimeout(conversation.batchTimer);
      conversation.batchTimer = undefined;
    }
    cancelChime(conversation);
  }

  /**
   * 已知的群（群号 → 群名）：静默目标要按**群号**定位，群名只是给主人用的写法。
   *
   * 数据来自两处：插件已经聊过的会话（有群名）+ OneBot 的 `get_group_list`（更全）。
   * 缓存 60 秒：同一句话里连着列几个群时不该重复打接口。
   * @param {boolean} [force] - 跳过缓存。
   * @returns {Promise<Array<{ id: string, name: string }>>}
   */
  const groupDirectory = { at: 0, list: [] };
  async function knownGroups(force = false) {
    if (!force && groupDirectory.list.length > 0 && Date.now() - groupDirectory.at < 60_000) {
      return groupDirectory.list;
    }
    const map = new Map();
    for (const conversation of conversations.values()) {
      if (conversation.type !== 'group') continue;
      map.set(conversation.id, { id: conversation.id, name: conversation.name || `群${conversation.id}` });
    }
    if (client.connected) {
      try {
        const rows = await client.call('get_group_list');
        for (const row of Array.isArray(rows) ? rows : []) {
          const id = String(row?.group_id ?? row?.groupId ?? '').trim();
          if (id.length === 0) continue;
          const name = String(row?.group_name ?? row?.groupName ?? '').trim() || `群${id}`;
          map.set(id, { id, name });
        }
      } catch (error) {
        report('warn', `could not list QQ groups: ${errorText(error)}`);
      }
    }
    groupDirectory.list = [...map.values()].sort((left, right) => left.id.localeCompare(right.id));
    groupDirectory.at = Date.now();
    return groupDirectory.list;
  }

  /** 群号 → 群名（查不到时给一个「群<号>」，绝不让提示词里出现空名字）。 */
  function groupNameOf(id) {
    const target = String(id ?? '');
    const hit = groupDirectory.list.find((group) => group.id === target);
    if (hit !== undefined) return hit.name;
    return conversations.get(`group:${target}`)?.name || `群${target}`;
  }

  /**
   * 把「群号 / 群名 / 全部」解析成要静默的目标。
   *
   * 群号是唯一标识（群名可以改，也可能重名），所以群名只是入口：匹配到唯一一个群就
   * 换成它的群号；匹配到多个时**要求用群号**，而不是替主人猜一个。
   * @param {unknown} raw - 工具参数 target。
   * @param {object} [conversation] - 调用方会话（在群里时默认就是它）。
   * @returns {Promise<{ all: boolean, id?: string, name?: string }>}
   */
  async function resolveQuietTarget(raw, conversation) {
    const text = String(raw ?? '').trim();
    if (text.length === 0) {
      if (conversation?.type === 'group') {
        return { all: false, id: conversation.id, name: conversation.name || groupNameOf(conversation.id) };
      }
      throw new Error('静默哪个群要说清楚：给群号或群名（例如「123456789」「XX群」）；所有群都睡写「全部」');
    }
    if (/^(?:all|全部|所有|全部群|所有群|都睡|全都)$/iu.test(text)) return { all: true };
    if (/^\d{5,12}$/.test(text)) return { all: false, id: text, name: groupNameOf(text) };
    const groups = await knownGroups();
    const exact = groups.filter((group) => group.name === text);
    if (exact.length === 1) return { all: false, id: exact[0].id, name: exact[0].name };
    const hits = groups.filter((group) => group.name.includes(text));
    if (hits.length === 1) return { all: false, id: hits[0].id, name: hits[0].name };
    if (hits.length > 1) {
      throw new Error(`「${text}」匹配到多个群：${hits.map((group) => `${group.name}(${group.id})`).join('、')}；请直接给群号`);
    }
    const known = groups.slice(0, 20).map((group) => `${group.name}(${group.id})`).join('、');
    throw new Error(`找不到群「${text}」${known.length > 0 ? `；已知的群：${known}` : '（还没有已知的群；先让它在那个群说过话）'}`);
  }

  /**
   * 静默一个 / 全部群：只影响群聊，私聊永远醒着。清掉待发批次与 chime，落盘。
   * @param {object} options
   * @param {unknown} options.target - 群号 / 群名 / 全部 / 空（调用方所在的群）。
   * @param {object} [options.conversation] - 调用方会话。
   * @param {string} [options.by] - 下命令的 QQ 号（只写日志与落盘）。
   * @returns {Promise<{ all: boolean, id?: string, name?: string }>}
   */
  async function quietSleep({ target, conversation, by }) {
    const resolved = await resolveQuietTarget(target, conversation);
    // 真的静默成功：取消「12 秒后定档」的兜底，否则会在睡着之后又把它重开。
    if (resolved.all) {
      for (const item of conversations.values()) clearSleepIntent(item);
    } else {
      clearSleepIntent(conversations.get(`group:${resolved.id}`));
    }
    muteState.at = Date.now();
    muteState.by = String(by ?? '');
    if (resolved.all) {
      muteState.global = true;
      muteState.keys.clear();
      for (const item of conversations.values()) clearPendingFor(item);
      report('info', `quiet: all groups (by ${muteState.by || 'operator'})`);
    } else {
      const key = `group:${resolved.id}`;
      muteState.keys.add(key);
      clearPendingFor(conversations.get(key));
      report('info', `quiet: group ${resolved.id} ${resolved.name} (by ${muteState.by || 'operator'})`);
    }
    persistMuteState();
    return resolved;
  }

  /**
   * 结束静默：不给 target = 全部叫醒；给 target = 只叫醒那一个群。
   *
   * 「全局静默里叫醒一个群」的语义是「其余群继续睡」：把 global 展开成具体群号，
   * 只是这一轮的样子 —— 不展开的话，叫醒一个群等于把全部群都叫醒。
   * @param {object} options
   * @param {unknown} options.target - 群号 / 群名 / 全部 / 空（= 全部）。
   * @param {object} [options.conversation] - 调用方会话。
   * @param {string} [options.by] - 下命令的 QQ 号。
   * @returns {Promise<{ all: boolean, wasMuted: boolean, id?: string, name?: string }>}
   */
  async function quietWake({ target, conversation, by }) {
    const text = String(target ?? '').trim();
    const all = text.length === 0 || /^(?:all|全部|所有|全部群|所有群)$/iu.test(text);
    muteState.at = Date.now();
    muteState.by = String(by ?? '');
    if (all) {
      const wasMuted = muteState.global || muteState.keys.size > 0;
      muteState.global = false;
      muteState.keys.clear();
      for (const item of conversations.values()) cancelChime(item);
      persistMuteState();
      report('info', `quiet: wake all (by ${muteState.by || 'operator'})`);
      return { all: true, wasMuted };
    }
    const resolved = await resolveQuietTarget(text, conversation);
    if (muteState.global) {
      muteState.global = false;
      const groups = await knownGroups();
      for (const group of groups) {
        if (group.id !== resolved.id) muteState.keys.add(`group:${group.id}`);
      }
    } else {
      muteState.keys.delete(`group:${resolved.id}`);
    }
    cancelChime(conversations.get(`group:${resolved.id}`));
    persistMuteState();
    report('info', `quiet: wake group ${resolved.id} ${resolved.name} (by ${muteState.by || 'operator'})`);
    return { all: false, wasMuted: true, id: resolved.id, name: resolved.name };
  }

  /** 当前静默状态（给 `qq_quiet status` 用）：全局时列出所有已知群。 */
  async function quietStatus() {
    const groups = await knownGroups();
    if (muteState.global) return { global: true, groups };
    const muted = groups.filter((group) => muteState.keys.has(`group:${group.id}`));
    for (const key of muteState.keys) {
      const id = key.slice('group:'.length);
      if (!muted.some((group) => group.id === id)) muted.push({ id, name: groupNameOf(id) });
    }
    return { global: false, groups: muted };
  }

  /**
   * 睡着之后消息根本到不了模型，所以「起床」必须由插件直接识别（唯一旁路）。
   *
   * 只认主人、且只在**已经静默**时生效：醒着的时候「你几点起床」是一句普通聊天，
   * 不该被插一句「醒着呢」。群里不要求 @ / 前缀 —— 静默的群本来就已经没人说话了。
   * @param event - OneBot 消息事件。
   * @param selfId - 机器人自己的 QQ 号。
   * @returns 唤醒命令；不是命令时 undefined。
   */
  function wakeCommandFor(event, selfId) {
    if (settings.wakeTriggers.length === 0) return undefined;
    if (!muteState.global && muteState.keys.size === 0) return undefined;
    const type = event?.message_type === 'group' ? 'group' : event?.message_type === 'private' ? 'private' : undefined;
    if (type === undefined) return undefined;
    const userId = String(event.user_id ?? '');
    if (userId === '' || userId === String(selfId) || !canOperate(userId)) return undefined;
    const raw = messageToText(event.message ?? event.raw_message, selfId).trim();
    if (raw.length === 0) return undefined;
    const text = type === 'group' && settings.groupTrigger === 'prefix' && raw.startsWith(settings.prefix)
      ? dropPrefix(raw)
      : raw;
    const trigger = matchWakeCommand(text, {
      wakeTriggers: settings.wakeTriggers,
      prefixes: [settings.prefix],
    });
    if (trigger === undefined) return undefined;
    const id = type === 'group' ? String(event.group_id) : userId;
    const displayName = userDisplayName(event.sender ?? {}, event.user_id);
    const conversation = conversationFor(type, id, {
      userId,
      userName: displayName,
      name: displayName,
      mentions: type === 'group' ? atMentions(event.message, selfId) : undefined,
    });
    return { trigger, conversation, userId };
  }

  /** 执行唤醒：回一句固定文案；如果睡着期间群里聊过，再让模型说一句「梦话」。 */
  function applyWakeCommand(command) {
    clearSleepIntent(command.conversation);
    void quietWake({ target: 'all', conversation: command.conversation, by: command.userId })
      .then(() => {
        void sendToConversation(command.conversation, settings.wakeText);
        const dream = dreamLines.splice(0).join('\n');
        if (dream.length > 0) {
          startAgentTurn(
            command.conversation,
            [
              '（插件转告：你刚睡醒。睡着期间群里聊过这些：）',
              dream,
              '请用一句「刚睡醒的梦话」总结（不超过 80 字），像真的刚从午睡里抬头，别逐条复述。',
            ].join('\n'),
            { quote: command.quote, intent: 'command', command: '梦话' },
          );
        }
      })
      .catch((error) => report('warn', `wake command failed: ${errorText(error)}`));
  }

  /**
   * 主人从 QQ 侧调整 **bot 配置**（`qq_settings`）：只碰白名单键，改完 8 秒后重启插件。
   *
   * 与 GUI 的关系：GUI 改的是基础配置，这里写的是覆盖层（`data/owner-settings.json`），
   * 覆盖层优先。`unset` / `clear` 就回到 GUI 的值。模型路由（provider / model）不在
   * 白名单里 —— 那是部署级设置，不该由聊天改。
   */
  const settingsAdmin = {
    list: () => Object.keys(settings)
      .filter((key) => key !== 'memoryOn')
      .map((key) => {
        const spec = OWNER_SETTING_KEYS[key];
        return {
          key,
          value: settings[key],
          writable: isWritableKey(key),
          kind: settingKind(key, settings[key]),
          description: spec?.description ?? '',
        };
      }),
    get: (key) => {
      if (key !== undefined && settings[key] === undefined) {
        throw new Error(`没有「${key}」这个配置项（用 action: list 看全部）`);
      }
      const keys = key === undefined ? Object.keys(settings).filter((name) => name !== 'memoryOn') : [key];
      const current = {};
      const pending = {};
      for (const name of keys) {
        current[name] = settings[name];
        if (ownerSettingsValues[name] !== undefined) pending[name] = ownerSettingsValues[name];
      }
      return { current, pending };
    },
    async set(key, raw) {
      const value = coerceOwnerSetting(key, raw, settings[key]);
      ownerSettingsValues[key] = value;
      await persistOwnerSettings(ownerSettingsValues);
      scheduleSettingsRestart();
      return { key, value };
    },
    async unset(key) {
      if (!isWritableKey(key)) throw new Error(`「${key}」不是可在 QQ 侧修改的项`);
      delete ownerSettingsValues[key];
      await persistOwnerSettings(ownerSettingsValues);
      scheduleSettingsRestart();
      return { key };
    },
    async clear() {
      for (const key of Object.keys(ownerSettingsValues)) delete ownerSettingsValues[key];
      await persistOwnerSettings(ownerSettingsValues);
      scheduleSettingsRestart();
      return { cleared: true };
    },
  };

  // ---- 指令路由（@bot + 空格 + 指令）------------------------------------------
  //
  // 能确定性回答的指令由插件直接回（零 token）；只有「小作文 / 白饭 / 表情（按语义挑图）」
  // 才整理成一段说明投给会话。命令表与解析在 commands.js，那里可以脱离 Harness 单测。

  /** 同一条指令在同一个会话里的最小间隔（毫秒）：天气 / 余额 / 随机表情不该被连点。 */
  const COMMAND_COOLDOWN_MS = 3000;
  const commandCooldowns = new Map();

  /**
   * 解析「@bot + 空格 + 指令」。群聊要求 @ / 前缀 / all 触发；私聊直接判。
   * @param event - OneBot 消息事件。
   * @param selfId - 机器人自己的 QQ 号。
   * @returns 指令描述；不是指令时 undefined。
   */
  function commandFor(event, selfId) {
    if (settings.commands !== true) return undefined;
    const type = event?.message_type === 'group' ? 'group' : event?.message_type === 'private' ? 'private' : undefined;
    if (type === undefined) return undefined;
    const userId = String(event.user_id ?? '');
    if (userId === '' || userId === String(selfId)) return undefined;
    const raw = messageToText(event.message ?? event.raw_message, selfId).trim();
    if (raw.length === 0) return undefined;
    let text = raw;
    if (type === 'group') {
      if (!settings.groupChat) return undefined;
      // 静默中的群：指令一律不进来（叫醒只能靠主人说「起床」那条旁路）。
      if (isMuted(`group:${event.group_id}`)) return undefined;
      const prefixed = settings.groupTrigger === 'prefix' && raw.startsWith(settings.prefix);
      const explicit = settings.groupTrigger === 'all' || mentions(event.message, selfId) || prefixed;
      if (!explicit) return undefined;
      if (prefixed) text = dropPrefix(raw);
    } else if (!settings.privateChat) {
      return undefined;
    }
    const parsed = parseCommand(text);
    if (parsed === undefined) return undefined;
    const id = type === 'group' ? String(event.group_id) : userId;
    const displayName = userDisplayName(event.sender ?? {}, event.user_id);
    const conversation = conversationFor(type, id, {
      userId,
      userName: displayName,
      name: displayName,
      mentions: type === 'group' ? atMentions(event.message, selfId) : undefined,
    });
    return {
      command: parsed.command,
      args: parsed.args,
      conversation,
      userId,
      owner: canOperate(userId),
      quote: {
        messageId: String(event.message_id ?? ''),
        userId,
        seq: type === 'group' ? chatter.anchor(String(event.group_id)) : 0,
        emoji: false,
      },
    };
  }

  /** 指令回复走和自动回复同一条发送队列（拆条 / 打字延迟都沿用）。 */
  function commandReply(command, text) {
    void sendToConversation(command.conversation, text);
  }

  /** 把合成好的 MP3 作为 QQ 语音发出去（OneBot 的 `record` 段，NapCat 已实测可发）。 */
  function sendVoice(conversation, bytes) {
    const action = conversation.type === 'group' ? 'send_group_msg' : 'send_private_msg';
    const idKey = conversation.type === 'group' ? 'group_id' : 'user_id';
    return enqueueSend(conversation, async () => {
      await client.call(action, {
        [idKey]: Number(conversation.id),
        message: [{ type: 'record', data: { file: `base64://${bytes.toString('base64')}` } }],
      });
      noteOwnMessage(conversation.type, conversation.id);
    });
  }

  /** 按字节/字符裁断（指令的硬上限，比如白饭 ≤25 字）。 */
  function clipChars(text, max) {
    const chars = [...String(text ?? '')];
    return chars.length <= max ? String(text ?? '') : chars.slice(0, max).join('');
  }

  /** 拿 apiKeyRef 指向的凭据：优先走 DSH 凭据层，其次环境变量。 */
  async function resolveApiKey() {
    const credentials = ctx.get('credentials');
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      try {
        const record = await credentials.resolve(settings.apiKeyRef);
        return String(record?.value ?? '');
      } catch {
        return '';
      }
    }
    return String(process.env[settings.apiKeyRef] ?? '');
  }

  /** 当前静默状态的一句话（状态指令用）。 */
  function quietSummary() {
    if (muteState.global) return '全部群';
    if (muteState.keys.size > 0) return `${muteState.keys.size} 个群`;
    return '醒着';
  }

  // ---- 小功能的共享状态与读转录 ------------------------------------------------
  // 米饭 / 木鱼 / 关注 / 投票 / 纪念日 / 接龙都放在 data/chat-state.json，按 section 分。
  // 读不到就退回空对象 —— 丢几个计数，比让 bot 起不来划算。

  function gameData(name) {
    return chatState.section(name, {});
  }

  function gameList(name) {
    if (!Array.isArray(chatState.data[name])) chatState.data[name] = [];
    return chatState.data[name];
  }

  /** 今天这个会话的转录行（记忆关掉 / 文件不存在时是空数组）。 */
  async function todayTranscript(key) {
    if (settings.memory === false) return [];
    const dir = resolve(cwd, settings.memoryDir, 'conversations', memorySlug(key), 'log');
    return readJsonl(join(dir, `${localDate()}.jsonl`));
  }

  /** 今天群里的发言统计：条数 / 人数 / 话最多 / 最近一小时 / 潜水的人。 */
  async function groupStats(conversation) {
    const lines = (await todayTranscript(conversation.key)).filter((line) => line.kind === 'group' && line.command === undefined);
    const byName = new Map();
    for (const line of lines) {
      const name = String(line.name || line.user || '').trim();
      if (name.length === 0) continue;
      byName.set(name, (byName.get(name) ?? 0) + 1);
    }
    const top = [...byName.entries()].sort((left, right) => right[1] - left[1]).slice(0, 3);
    const recent = lines.filter((line) => Number(line.at) >= Date.now() - 3_600_000).length;
    const quiet = (conversation.participants ?? [])
      .map((person) => person.name)
      .filter((name) => name.length > 0 && !byName.has(name))
      .slice(0, 5);
    return { total: lines.length, speakers: byName.size, top, recent, quiet };
  }

  /** 米饭计数：按会话 + 人，跨天把 today 归零。 */
  function riceEntry(key, userId) {
    const rice = gameData('rice');
    const today = localDate();
    if (rice[key] === undefined || rice[key] === null || typeof rice[key] !== 'object') {
      rice[key] = { total: 0, today: 0, date: today };
    }
    if (rice[key].date !== today) {
      rice[key].date = today;
      rice[key].today = 0;
    }
    rice[key].byUser ??= {};
    rice[key].byUser[String(userId)] ??= { total: 0, today: 0 };
    if (rice[key].byUser[String(userId)].date !== today) {
      rice[key].byUser[String(userId)].date = today;
      rice[key].byUser[String(userId)].today = 0;
    }
    return rice[key];
  }

  /** 纪念日：`MM-DD 内容`，只在创建它的会话里提醒。 */
  function anniversaryList() {
    return gameList('anniversaries');
  }

  /** 关注词：只记 {key, keyword, by, at, lastHit}。 */
  function watchList() {
    return gameList('watches');
  }

  /** 群成员进出：用固定文案（零 token），名字取群名片，取不到就用 QQ 号。 */
  async function memberName(groupId, userId) {
    try {
      const info = await client.call('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId), no_cache: true });
      return String(info?.card || info?.nickname || userId);
    } catch {
      return String(userId);
    }
  }

  async function handleGroupMember(event) {
    if (!settings.groupChat) return;
    const groupId = String(event.group_id ?? '');
    if (groupId.length === 0) return;
    if (settings.allowGroups.length > 0 && !settings.allowGroups.includes(groupId)) return;
    const type = event.notice_type === 'group_increase' ? 'increase' : event.notice_type === 'group_decrease' ? 'decrease' : undefined;
    if (type === undefined) return;
    const userId = String(event.user_id ?? '');
    if (userId.length === 0) return;
    const name = await memberName(groupId, userId);
    const conversation = targetConversation('group', groupId);
    const text = type === 'increase'
      ? `（尾巴甩了两下）欢迎 ${name}，我是群里的普通群友，叫我小助手就行。`
      : `（尾巴垂了垂）${name} 走了，群里安静了一点。`;
    void sendToConversation(conversation, text);
    report('info', `${describeConversation(conversation)} 群成员${type === 'increase' ? '加入' : '离开'}：${name}`);
  }

  /**
   * 睡着期间把群消息留一小段（最多 40 条 / 2000 字）：醒来时拿它说一句「梦话」。
   * 只放内存：重启就忘，不值得落盘。
   */
  const dreamLines = [];
  function noteDreamLine(event, selfId) {
    const text = messageToText(event.message ?? event.raw_message, selfId).trim();
    if (text.length === 0) return;
    const name = userDisplayName(event.sender ?? {}, event.user_id);
    dreamLines.push(`${name}: ${text.slice(0, 80)}`);
    while (dreamLines.length > 40) dreamLines.shift();
    while (dreamLines.join('\n').length > 2000 && dreamLines.length > 1) dreamLines.shift();
  }

  /** 把「有人提到关键词」私聊给关注人；同一个词 10 分钟内只提醒一次。 */
  async function checkWatches(conversationKey, text, senderName) {
    if (typeof text !== 'string' || text.length === 0) return;
    const now = Date.now();
    let changed = false;
    for (const watch of watchList()) {
      if (watch.key !== conversationKey) continue;
      if (!text.includes(String(watch.keyword ?? ''))) continue;
      if (now - (Number(watch.lastHit) || 0) < 10 * 60 * 1000) continue;
      watch.lastHit = now;
      changed = true;
      try {
        await client.call('send_private_msg', {
          user_id: String(watch.by),
          message: `群里有人提到「${watch.keyword}」：${senderName}：${text.slice(0, 120)}`,
        });
      } catch (error) {
        report('warn', `watch notify failed: ${errorText(error)}`);
      }
    }
    if (changed) chatState.save();
  }

  /** 今天是不是某个纪念日（每个会话一天只提醒一次）。 */
  function checkAnniversaries(conversation) {
    const today = localDate();
    if (conversation.lastAnniversaryDate === today) return;
    conversation.lastAnniversaryDate = today;
    const mmdd = today.slice(5);
    const hits = anniversaryList().filter((item) => item.key === conversation.key && item.mmdd === mmdd);
    if (hits.length === 0) return;
    const lines = hits.map((item) => `· ${item.text}`);
    void sendToConversation(conversation, `（尾巴拍了拍水面）今天是纪念日：\n${lines.join('\n')}`);
  }

  /** 从模型回复 / 入站正文里抠出最后一张图的路径（给「看图」「存表情」用）。 */
  function lastImagePathOf(text) {
    const matches = [...String(text ?? '').matchAll(/\[(?:图片|图片\(动画表情\)|表情包)[^\]]*?: ([^\]\n]+)\]/gu)];
    return matches.length > 0 ? matches[matches.length - 1][1].trim() : undefined;
  }

  /**
   * 通用的「交给模型」入口：指令 / 梦话 / 关注都走这里。
   * @param conversation - 目标会话。
   * @param text - 给模型看的说明。
   * @param meta - `{ quote, intent, command }`。
   */
  function startAgentTurn(conversation, text, meta = {}) {
    conversation.pendingIntent = meta.intent ?? 'command';
    enqueue(conversation, async () => {
      try {
        const agent = await ensureAgent(conversation);
        const userMessage = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
        submitted.set(userMessage.id, {
          key: conversation.key,
          quote: meta.quote,
          intent: meta.intent ?? 'command',
          command: meta.command,
        });
        agent.followup(userMessage);
      } catch (error) {
        report('warn', `agent turn for ${conversation.key} could not start: ${errorText(error)}`);
      }
    });
  }

  /**
   * 定档（交接）：把最近上下文与可能未完成的事写进 Markdown，归档旧会话，再新开一轮，
   * 让新 Agent 的第一件事就是读这份文档。
   *
   * 为什么不是简单 `/reset`：上下文清零之后模型会「失忆」，群里正聊到一半它会像换了个人。
   * 交接文档把「最近说了什么、还有什么没做完、当前静默/提醒状态」留下来，新会话先读它，
   * 接得上再开口；旧会话目录移到 `data/handoff/archive/`，不再被 resume。
   */
  const HANDOFF_FALLBACK_MS = 12_000;

  /** 主人说「睡觉去」这类短句时返回会话；群聊要求 @ / 前缀 / all。 */
  function sleepIntentFor(event, selfId) {
    if (event?.post_type !== 'message') return undefined;
    const type = event.message_type === 'group' ? 'group' : event.message_type === 'private' ? 'private' : undefined;
    if (type === undefined) return undefined;
    const userId = String(event.user_id ?? '');
    if (userId === '' || userId === String(selfId) || !canOperate(userId)) return undefined;
    const raw = messageToText(event.message ?? event.raw_message, selfId).trim();
    if (raw.length === 0) return undefined;
    let text = raw;
    if (type === 'group') {
      const prefixed = settings.groupTrigger === 'prefix' && raw.startsWith(settings.prefix);
      const explicit = settings.groupTrigger === 'all' || mentions(event.message, selfId) || prefixed;
      if (!explicit) return undefined;
      if (prefixed) text = dropPrefix(raw);
    }
    const compact = text.replace(/[\s\u3000]+/gu, '');
    if (compact.length > 12) return undefined;
    if (!/^(睡觉去|去睡吧|睡吧|休眠|静默|该睡了|该睡啦|睡吧你)/u.test(compact)) return undefined;
    const id = type === 'group' ? String(event.group_id) : userId;
    const displayName = userDisplayName(event.sender ?? {}, event.user_id);
    return conversationFor(type, id, {
      userId,
      userName: displayName,
      name: displayName,
      mentions: type === 'group' ? atMentions(event.message, selfId) : undefined,
    });
  }

  /** 记下「主人刚说了睡」：12 秒内没真的静默，就走定档兜底。 */
  function markSleepIntent(conversation) {
    conversation.sleepIntentAt = Date.now();
    if (conversation.sleepTimer !== undefined) clearTimeout(conversation.sleepTimer);
    const timer = setTimeout(() => {
      conversation.sleepTimer = undefined;
      if (conversation.sleepIntentAt === undefined) return;
      if (isMuted(conversation.key)) {
        conversation.sleepIntentAt = undefined;
        return;
      }
      conversation.sleepIntentAt = undefined;
      report('info', `${describeConversation(conversation)} 说了睡但没真的静默，改走定档`);
      void handoffConversation(conversation, 'sleep-fallback');
    }, HANDOFF_FALLBACK_MS);
    timer.unref?.();
    conversation.sleepTimer = timer;
  }

  /** 清掉「等它静默」的定时器（静默成功 / 被叫醒 / 已定档时调用）。 */
  function clearSleepIntent(conversation) {
    if (conversation === undefined) return;
    conversation.sleepIntentAt = undefined;
    if (conversation.sleepTimer !== undefined) {
      clearTimeout(conversation.sleepTimer);
      conversation.sleepTimer = undefined;
    }
  }

  /** 把最近上下文写成交接文档；返回相对 cwd 的路径。 */
  async function writeHandoffDoc(conversation, reason) {
    const lines = await todayTranscript(conversation.key);
    const tail = lines.slice(-80);
    const tasks = lines
      .filter((line) => /提醒|任务|待办|记得|别忘|答应/u.test(String(line.text ?? '')))
      .slice(-10);
    const ambientTail = conversation.type === 'group' ? (ambient.get(conversation.id) ?? []).slice(-12) : [];
    const parts = [
      '# 交接文档',
      '',
      `- 会话：${conversation.key}${conversation.name ? `（${conversation.name}）` : ''}`,
      `- 时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      `- 原因：${reason === 'sleep-fallback' ? '主人说睡但静默失败，自动定档' : '主人手动定档'}`,
      `- 会话轮次：${conversation.sessionGeneration ?? 0}`,
      `- 静默状态：${isMuted(conversation.key) ? '静默中' : '醒着'}`,
      '',
      '## 最近对话（旧 → 新，最多 80 条）',
      '',
      ...(tail.length > 0
        ? tail.map((line) => `- ${line.name ?? line.user ?? '某人'}：${String(line.text ?? '').replace(/\s+/gu, ' ').slice(0, 200)}`)
        : ['（今天的转录是空的，下面是群聊环境缓冲）', ...ambientTail.map((line) => `- ${line.name}：${line.text}`)]),
      '',
      '## 可能未完成的事（关键词命中，供参考）',
      '',
      ...(tasks.length > 0
        ? tasks.map((line) => `- ${line.name ?? line.user ?? '某人'}：${String(line.text ?? '').slice(0, 200)}`)
        : ['（没有明显命中的任务；以最近对话为准）']),
      '',
      '## 备注',
      '',
      '- 旧会话已归档到 `data/handoff/archive/`，长期记忆仍在 `.qq-memory/`。',
      '- 读完这份文档后，先接上当前话题，不要逐条复述。',
    ];
    const body = parts.join('\n').slice(0, 12_000);
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const rel = `data/handoff/${memorySlug(conversation.key)}-${stamp}.md`;
    await mkdir(join(cwd, 'data', 'handoff'), { recursive: true });
    await writeTextAtomic(join(cwd, rel), `${body}\n`);
    return rel;
  }

  /** 把旧会话目录移出 sessions 根目录（保留作归档，不再被 resume）。 */
  async function archiveSessionDir(sessionId) {
    const persistence = ctx.get('sessionPersistence');
    const root = persistence?.root;
    if (typeof root !== 'string' || root.length === 0) return;
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const source = join(root, entry.name, sessionId);
        const info = await stat(source).catch(() => undefined);
        if (info?.isDirectory() !== true) continue;
        const target = join(cwd, 'data', 'handoff', 'archive', `${sessionId}-${Date.now()}`);
        await mkdir(dirname(target), { recursive: true });
        await rename(source, target);
        report('info', `handoff: archived ${sessionId} → ${target}`);
        return;
      }
    } catch (error) {
      report('warn', `handoff: could not archive ${sessionId}: ${errorText(error)}`);
    }
  }

  /** 定档：写文档 → 归档旧会话 → 新开一轮 → 第一句话读文档。 */
  async function handoffConversation(conversation, reason) {
    if (conversation.handoffBusy === true) return;
    conversation.handoffBusy = true;
    clearSleepIntent(conversation);
    try {
      conversation.pending.length = 0;
      if (conversation.batchTimer !== undefined) {
        clearTimeout(conversation.batchTimer);
        conversation.batchTimer = undefined;
      }
      const oldSessionId = sessionIdFor(conversation.key, conversation.sessionGeneration ?? 0);
      const rel = await writeHandoffDoc(conversation, reason);
      const ok = await resetConversation(conversation);
      if (!ok) {
        void sendToConversation(conversation, '（定档失败：旧会话没能关掉，先别急着重开）');
        return;
      }
      await archiveSessionDir(oldSessionId);
      void sendToConversation(conversation, `（交接文档写好了：\`${rel}\`，旧会话已归档，正在新开一轮）`);
      startAgentTurn(
        conversation,
        [
          `（插件转告：你刚接手这个会话。先用 read 读交接文档 \`${rel}\`，`,
          '里面是上一段对话的最近上下文、可能未完成的事和当前状态。',
          '读完用一两句话确认你接上了；不要逐条复述，也不要说“交接文档”这四个字。）',
        ].join('\n'),
        { intent: 'handoff', command: '定档' },
      );
    } finally {
      conversation.handoffBusy = false;
    }
  }


  function commandPrompt(name, args) {
    if (name === '表情') {
      return [
        `（插件转告：有人用「表情」指令，想要一张和「${args}」语义相近的表情包。）`,
        '从上面的表情包目录里挑一张最接近的，正文只写 `[[图片: 路径]]`，不要配文字。',
        '一张都不像就只回一句「没有相近的」。别自己拼路径，别用 `.qq-media`。',
      ].join('\n');
    }
    if (name === '白饭') {
      return '（插件转告：有人点了「每日白饭」。说一句摆烂 / 摸鱼 / 不想干活的语录，不超过 25 个字。不要解释、不要引号、不要重复上一句。）';
    }
    if (name === '看图') {
      return `（插件转告：有人让你看一张图，本地路径是 \`${args}\`。）用 read_image 看一眼，用一两句说出图里是什么、有没有好笑的地方；别复述路径，别编看不见的细节。`;
    }
    if (name === '总结链接') {
      return `（插件转告：有人让你总结这个链接：${args}。）用 web_fetch 抓一次，然后用三句话以内说清「这是什么 / 讲了什么 / 值不值得点开」。抓不到就直说。`;
    }
    if (name === '梗') {
      return `（插件转告：有人问「${args}」是什么梗。）先加载 moegirl skill 去萌娘百科查；查不到再用 web_search。用一两句话解释，别写成百科条目。`;
    }
    if (name === '日报') {
      return '（插件转告：有人要今天的群日报。）用 qq_transcript 读今天这个会话的记录，压成 3~5 条「今天群里聊了什么」，每条不超过 40 字；不要逐条复述，不要编。';
    }
    if (name === '记忆') {
      return `（插件转告：主人在查记忆，关键词「${args}」。）用 qq_transcript 搜聊天记录、用 qq_memory 搜记忆文件，挑 3 条以内最相关的说；查不到就说没记到，别编。`;
    }
    if (name === '提醒') {
      return `（插件转告：主人要建一条提醒：${args}。）调用 qq_remind_create 建任务；时间用绝对日期时刻，建完把「什么时候提醒什么」说清楚；建不成把原因说出来。`;
    }
    return [
      `（插件转告：有人点了「小作文」。主题与要素：${args || '（没给，自己编一个日常主题）'}。）`,
      '写一篇不超过 800 字的小作文，第一人称，像群友在聊天；不要 Markdown、不要标题、不要分点。',
    ].join('\n');
  }

  /** 指令：把一条指令交给模型（带 quote / command 标记，turn/end 里按它裁长度）。 */
  function startCommandTurn(command, text) {
    startAgentTurn(command.conversation, text, {
      quote: command.quote,
      intent: 'command',
      command: command.command.name,
    });
  }

  /** 复读开关：`data/chat-state.json` 里记一份关掉的会话 key。 */
  function repeatOffList() {
    return gameList('repeatOff');
  }

  function isRepeatOff(conversation) {
    return conversation.repeatOff === true || repeatOffList().includes(conversation.key);
  }

  /** 投票的排版：带条形，最多 10 个选项。 */
  function renderPoll(poll) {
    const lines = [`投票：${poll.question}${poll.open ? '' : '（已截止）'}`];
    poll.options.forEach((option, index) => {
      const votes = Object.values(poll.votes ?? {}).filter((vote) => Number(vote) === index).length;
      const bar = '▇'.repeat(Math.min(10, votes));
      lines.push(`${index + 1}. ${option} ${votes} 票${bar ? ` ${bar}` : ''}`);
    });
    const total = Object.keys(poll.votes ?? {}).length;
    lines.push(`共 ${total} 票；投票发「投票 序号」，截止发「投票 截止」。`);
    return lines.join('\n');
  }

  /** 设置指令：不带参数看摘要，`全部` 看所有项，`键` 看一项，`键 值` 改一项。 */
  async function settingsCommand(command) {
    const arg = String(command.args ?? '').trim();
    if (arg.length === 0) {
      const entries = settingsAdmin.list();
      const writable = entries.filter((entry) => entry.writable);
      const preview = writable.slice(0, 18).map((entry) => entry.key).join('、');
      commandReply(
        command,
        `可改 ${writable.length} 项 / 只读 ${entries.length - writable.length} 项。\n` +
          `· 「设置 全部」看全部当前值\n· 「设置 键」看一项\n· 「设置 键 值」改一项（8 秒后重启生效）\n` +
          `可改的有：${preview}${writable.length > 18 ? '…' : ''}`,
      );
      return;
    }
    const parts = arg.split(/[\s\u3000]+/u);
    const key = parts[0];
    if (parts.length === 1) {
      if (key === '全部' || key.toLowerCase() === 'all') {
        const lines = settingsAdmin.list().map(
          (entry) => `${entry.key}=${JSON.stringify(entry.value)}${entry.writable ? '' : '（只读）'}`,
        );
        commandReply(command, `共 ${lines.length} 项：\n${lines.join('\n')}`);
        return;
      }
      const hit = settingsAdmin.list().find((entry) => entry.key === key);
      if (hit === undefined) {
        commandReply(command, `没有「${key}」这一项。用「设置 全部」看全部。`);
        return;
      }
      commandReply(
        command,
        `${key} = ${JSON.stringify(hit.value)}（${hit.writable ? '可改' : '只读'}，${hit.kind}）` +
          (hit.description.length > 0 ? `\n${hit.description}` : ''),
      );
      return;
    }
    if (!isWritableKey(key)) {
      commandReply(command, `「${key}」是部署项，只能在 GUI / 配置文件里改。`);
      return;
    }
    const value = arg.slice(key.length).trim();
    try {
      const result = await settingsAdmin.set(key, value);
      commandReply(command, `已把 ${key} 改成 ${JSON.stringify(result.value)}，8 秒后插件重启生效。`);
    } catch (error) {
      commandReply(command, `没改成：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 执行一条指令（插件侧 / 模型侧在这里分流）。 */
  async function runCommand(command) {
    const name = command.command.name;
    if (command.command.level === 'owner' && !command.owner) {
      commandReply(command, '这个指令只有主人能用。');
      return;
    }
    if (!command.owner && settings.guestCommands !== true) {
      commandReply(command, '访客指令现在关着，等主人开。');
      return;
    }
    // 连点保护只给会打网络 / 会发图的三条；帮助 / 设置 / 状态不需要。
    if (['天气', '余额', '随机表情', '点歌', '语音'].includes(name)) {
      const slot = `${command.conversation.key}:${name}`;
      const now = Date.now();
      if (now - (commandCooldowns.get(slot) ?? 0) < COMMAND_COOLDOWN_MS) return;
      commandCooldowns.set(slot, now);
      if (commandCooldowns.size > 512) commandCooldowns.clear();
    }
    if (name === '帮助') {
      commandReply(command, helpText(command.owner));
      return;
    }
    if (name === '天气') {
      const city = command.args.trim();
      if (city.length === 0) {
        commandReply(command, '要播报哪个城市？例如：@机器人 天气 杭州');
        return;
      }
      try {
        commandReply(command, await weatherReport(city));
      } catch (error) {
        commandReply(command, `天气没查成：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (name === '随机表情') {
      const names = stickerFiles();
      if (stickerLabel === undefined || names.length === 0) {
        commandReply(command, '表情包目录还是空的，先往 .qq-stickers 里丢几张图。');
        return;
      }
      const pick = names[Math.floor(Math.random() * names.length)];
      void sendToConversation(command.conversation, `[[图片: ${stickerLabel}/${pick}]]`);
      return;
    }
    if (name === '余额') {
      const apiKey = await resolveApiKey();
      if (apiKey.length === 0) {
        commandReply(command, '没拿到 API key（apiKeyRef 指向的凭据为空），检查 .credentials.yaml 或环境变量。');
        return;
      }
      try {
        commandReply(command, renderBalance(await fetchBalance({ apiKey })));
      } catch (error) {
        commandReply(command, `查余额失败：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (name === '设置') {
      await settingsCommand(command);
      return;
    }
    if (name === '状态') {
      commandReply(
        command,
        [
          `连接：${client.connected ? `已连 ${client.selfId}` : '未连接'}`,
          `静默：${quietSummary()}`,
          `表情：${stickerLabel === undefined ? '目录不可用' : `${stickerFiles().length} 张`}`,
          `记忆：${memory.enabled ? '开' : '关'}`,
          `主人：${ownerState.ids.join('、') || '未认主'}`,
          `已聊会话：${conversations.size} 个`,
        ].join('\n'),
      );
      return;
    }
    if (name === '表情') {
      if (command.args.length === 0) {
        commandReply(command, '要什么感觉的表情？例如：@机器人 表情 委屈');
        return;
      }
      startCommandTurn(command, commandPrompt(name, command.args));
      return;
    }
    if (name === '白饭') {
      startCommandTurn(command, commandPrompt(name, ''));
      return;
    }
    if (name === '小作文') {
      if (command.args.length === 0) {
        commandReply(command, '小作文要主题，例如：@机器人 小作文 我的青春 夏天 蝉鸣');
        return;
      }
      startCommandTurn(command, commandPrompt(name, command.args));
      return;
    }
    if (name === '抽签') {
      const who = command.owner ? '主人' : '你';
      commandReply(command, formatFortune(dailyFortune({ userId: command.userId, date: localDate() }), who));
      return;
    }
    if (name === '吃饭') {
      const entry = riceEntry(command.conversation.key, command.userId);
      entry.total += 1;
      entry.today += 1;
      entry.byUser[command.userId].total += 1;
      entry.byUser[command.userId].today += 1;
      chatState.save();
      commandReply(command, `（扒了一口饭）第 ${entry.today} 碗，今天累计 ${entry.today} 碗，一辈子 ${entry.total} 碗。`);
      return;
    }
    if (name === '饭量') {
      const entry = riceEntry(command.conversation.key, command.userId);
      const mine = entry.byUser[command.userId];
      commandReply(command, `今天 ${entry.today} 碗（你 ${mine.today} 碗），这个会话一共 ${entry.total} 碗。`);
      return;
    }
    if (name === '敲木鱼') {
      const wood = gameData('woodfish');
      wood[command.conversation.key] = (wood[command.conversation.key] ?? 0) + 1;
      chatState.save();
      commandReply(command, `功德 +1（本群共 ${wood[command.conversation.key]}）${command.owner ? '' : '，尾巴也 +1'}`);
      return;
    }
    if (name === '群热度') {
      const stats = await groupStats(command.conversation);
      if (stats.total === 0) {
        commandReply(command, '今天这个会话还没记到消息（记忆关着或还没人说话）。');
        return;
      }
      const top = stats.top.map(([person, count]) => `${person}(${count})`).join('、') || '没有';
      const quiet = stats.quiet.length > 0 ? stats.quiet.join('、') : '没有';
      commandReply(
        command,
        [
          `今日 ${stats.total} 条 / ${stats.speakers} 人；最近一小时 ${stats.recent} 条。`,
          `· 话最多：${top}`,
          `· 潜水：${quiet}`,
        ].join('\n'),
      );
      return;
    }
    if (name === '骰子') {
      try {
        const spec = parseDice(command.args || 'd6');
        const result = rollDice(spec);
        commandReply(command, `🎲 ${spec.count}d${spec.sides}：${result.rolls.join(' + ')} = ${result.total}`);
      } catch (error) {
        commandReply(command, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (name === '抛硬币') {
      commandReply(command, `🪙 ${flipCoin()}`);
      return;
    }
    if (name === '随机点名') {
      const lines = await todayTranscript(command.conversation.key);
      const names = [...new Set(lines.map((line) => String(line.name ?? '').trim()).filter((name) => name.length > 0))];
      const pick = pickRandom(names);
      commandReply(command, pick === undefined ? '今天还没人说话，点不到。' : `（尾巴一指）就你了，${pick}。`);
      return;
    }
    if (name === '接一个') {
      const names = stickerFiles().filter((sticker) => sticker !== command.conversation.lastSticker);
      if (stickerLabel === undefined || names.length === 0) {
        commandReply(command, '表情包目录是空的，接不了。');
        return;
      }
      const pick = pickRandom(names);
      commandReply(command, `[[图片: ${stickerLabel}/${pick}]]`);
      return;
    }
    if (name === '语音') {
      if (settings.tts !== true) {
        commandReply(command, '语音功能没开：让主人设置 `tts true`（需要本机 Python + edge-tts）。');
        return;
      }
      const text = command.args.trim();
      if (text.length === 0) {
        commandReply(command, '要念什么？例如：@机器人 语音 今天也要好好吃饭');
        return;
      }
      const clipped = [...text].slice(0, settings.ttsMaxChars).join('');
      try {
        const { bytes } = await synthesize({ text: clipped });
        await sendVoice(command.conversation, bytes);
      } catch (error) {
        commandReply(command, `语音没合成：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (name === '点歌') {
      if (command.args.length === 0) {
        commandReply(command, '要搜什么歌？例如：@机器人 点歌 稻香');
        return;
      }
      try {
        commandReply(command, renderSong(await searchSong(command.args)));
      } catch (error) {
        commandReply(command, `没搜到：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (name === '投票') {
      const polls = gameData('polls');
      const key = command.conversation.key;
      const arg = command.args.trim();
      const poll = polls[key];
      if (arg.length === 0 || arg === '结果') {
        commandReply(command, poll === undefined ? '这个会话还没有投票。发「投票 选项A 选项B」发起一个。' : renderPoll(poll));
        return;
      }
      if (arg === '截止') {
        if (poll === undefined) {
          commandReply(command, '还没有投票。');
          return;
        }
        poll.open = false;
        chatState.save();
        commandReply(command, renderPoll(poll));
        return;
      }
      if (/^\d+$/u.test(arg) && poll !== undefined && poll.open) {
        const index = Number(arg) - 1;
        if (index < 0 || index >= poll.options.length) {
          commandReply(command, `序号要在 1~${poll.options.length} 之间。`);
          return;
        }
        poll.votes ??= {};
        poll.votes[command.userId] = index;
        chatState.save();
        commandReply(command, `已投给「${poll.options[index]}」。`);
        return;
      }
      const options = arg.split(/[\s\u3000]+/u).filter((item) => item.length > 0).slice(0, 10);
      if (options.length < 2) {
        commandReply(command, '投票至少要两个选项，例如：投票 吃火锅 吃烧烤 吃米饭');
        return;
      }
      polls[key] = { question: options.join(' / '), options, votes: {}, open: true, at: Date.now(), by: command.userId };
      chatState.save();
      commandReply(command, renderPoll(polls[key]));
      return;
    }
    if (name === '关注' || name === '取消关注' || name === '关注列表') {
      const watches = watchList();
      if (name === '关注列表') {
        const mine = watches.filter((watch) => watch.by === command.userId);
        if (mine.length === 0) {
          commandReply(command, '还没有关注任何关键词。发「关注 演唱会」试试。');
          return;
        }
        commandReply(command, mine.map((watch) => `· ${watch.key} → ${watch.keyword}`).join('\n'));
        return;
      }
      if (name === '取消关注') {
        const keyword = command.args.trim();
        const before = watches.length;
        for (let index = watches.length - 1; index >= 0; index -= 1) {
          if (watches[index].by === command.userId && watches[index].keyword === keyword) watches.splice(index, 1);
        }
        chatState.save();
        commandReply(command, watches.length === before ? `没找到「${keyword}」这个关注。` : `已取消关注「${keyword}」。`);
        return;
      }
      let targetKey = command.conversation.key;
      let keyword = command.args.trim();
      if (command.conversation.type === 'private') {
        const parts = keyword.split(/[\s\u3000]+/u);
        if (parts.length < 2) {
          commandReply(command, '私聊里要带上群：关注 <群号或群名> <关键词>');
          return;
        }
        try {
          const resolved = await resolveQuietTarget(parts[0], command.conversation);
          if (resolved.all) {
            commandReply(command, '关注要指定一个群，不能用「全部」。');
            return;
          }
          targetKey = `group:${resolved.id}`;
          keyword = parts.slice(1).join(' ');
        } catch (error) {
          commandReply(command, error instanceof Error ? error.message : String(error));
          return;
        }
      }
      if (keyword.length === 0) {
        commandReply(command, '关注什么词？例如：关注 演唱会');
        return;
      }
      if (watches.some((watch) => watch.key === targetKey && watch.keyword === keyword && watch.by === command.userId)) {
        commandReply(command, `已经在关注「${keyword}」了。`);
        return;
      }
      watches.push({ key: targetKey, keyword, by: command.userId, at: Date.now() });
      chatState.save();
      commandReply(command, `好，有人提到「${keyword}」我就私聊你。`);
      return;
    }
    if (name === '定档') {
      commandReply(command, '（开始定档：写交接文档 → 归档旧会话 → 新开一轮）');
      void handoffConversation(command.conversation, 'manual');
      return;
    }
    if (name === '纪念日' || name === '纪念日列表') {
      if (name === '纪念日列表') {
        const mine = anniversaryList().filter((item) => item.key === command.conversation.key);
        commandReply(command, mine.length === 0 ? '这个会话还没有纪念日。' : mine.map((item) => `· ${item.mmdd} ${item.text}`).join('\n'));
        return;
      }
      const match = /^(\d{1,2})-(\d{1,2})[\s\u3000]+(.+)$/u.exec(command.args.trim());
      if (match === null) {
        commandReply(command, '格式：纪念日 10-01 主人生日');
        return;
      }
      const mmdd = `${String(Number(match[1])).padStart(2, '0')}-${String(Number(match[2])).padStart(2, '0')}`;
      anniversaryList().push({ key: command.conversation.key, mmdd, text: match[3].trim(), by: command.userId, at: Date.now() });
      chatState.save();
      commandReply(command, `记下了：每年 ${mmdd}，${match[3].trim()}。`);
      return;
    }
    if (name === '别复读' || name === '可以复读') {
      const list = repeatOffList();
      const off = name === '别复读';
      if (off && !list.includes(command.conversation.key)) list.push(command.conversation.key);
      if (!off) {
        const index = list.indexOf(command.conversation.key);
        if (index >= 0) list.splice(index, 1);
      }
      command.conversation.repeatOff = off;
      chatState.save();
      commandReply(command, off ? '好，这个群不跟复读了。' : '好，又能跟着复读了。');
      return;
    }
    if (name === '存表情') {
      const source = command.conversation.lastImage;
      if (source === undefined) {
        commandReply(command, '没找到可存的图：先发一张图 / 表情，再发「存表情 名字」。');
        return;
      }
      const sticker = command.args.trim();
      if (sticker.length === 0) {
        commandReply(command, '给它起个名字，例如：存表情 委屈');
        return;
      }
      try {
        const saved = await saveSticker({ source, name: sticker });
        commandReply(command, `存好了：${saved.path}`);
      } catch (error) {
        commandReply(command, `没存成：${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (name === '看图') {
      const source = command.args.trim() || command.conversation.lastImage;
      if (source === undefined || source.length === 0) {
        commandReply(command, '没找到图：先发一张，或「看图 路径」。');
        return;
      }
      startCommandTurn(command, commandPrompt(name, source));
      return;
    }
    if (name === '总结链接') {
      if (command.args.length === 0) {
        commandReply(command, '给个链接，例如：总结链接 https://example.com');
        return;
      }
      startCommandTurn(command, commandPrompt(name, command.args));
      return;
    }
    if (name === '梗') {
      if (command.args.length === 0) {
        commandReply(command, '查什么梗？例如：梗 哦鲸鲸');
        return;
      }
      startCommandTurn(command, commandPrompt(name, command.args));
      return;
    }
    if (name === '日报') {
      startCommandTurn(command, commandPrompt(name, ''));
      return;
    }
    if (name === '记忆') {
      if (command.args.length === 0) {
        commandReply(command, '查什么？例如：记忆 上次那个展');
        return;
      }
      startCommandTurn(command, commandPrompt(name, command.args));
      return;
    }
    if (name === '提醒') {
      if (command.args.length === 0) {
        commandReply(command, '格式：提醒 明天8点 交作业');
        return;
      }
      startCommandTurn(command, commandPrompt(name, command.args));
      return;
    }
    commandReply(command, `这条指令还没接上：${name}`);
  }

  // 部署 persona 里的 `{{model}}` 取的是 `agent.options.model`，请求路由读的也是
  // 同一组字段，所以程序化创建的 Agent 必须显式带上模型选择：否则提示词装配会
  // 失败，turn 在消息被 claim 之前就死掉。下面的 route 记录当前生效的选择，
  // 也通过 qq_list_conversations 暴露出来便于排查。
  const route = { provider: '', model: '', reasoningEffort: undefined, source: 'none', error: '' };

  // ---- 模型路由：配置优先，否则继承部署默认 ---------------------------------------------------

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
   * 已收藏的动图表情也要看得见动作：`sticker-frames.js` 在后台把收藏目录里的 GIF 拆成
   * 分镜图（落在媒体目录的子目录里），表情包目录那一行会附上「哪张是动图、分镜图在哪」。
   * 媒体下载关掉时不写任何东西（分镜图也是下载链路的产物，`mediaDir` 同样必须在 cwd 里）。
   */
  const stickerFrames = createStickerFrames({
    cwd,
    stickerDir: settings.stickerDir,
    mediaDirectory: mediaStore.directory,
    enabled: mediaStore.enabled,
    report,
  });
  // 启动就扫一遍收藏目录：已收藏的动图不用等到下一次存图才有分镜图。
  // 扫描在后台跑（每张之间让出事件循环），不挡连接与消息链路。
  stickerFrames.refreshSoon();

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
  /**
   * 表情包复读里「算同一张画面」的位差上限（0 = 只认字节完全相同）。
   *
   * 上限夹到 0.3：这个值放大到 1 就等于「任何两张图都算同一张」，那是配置事故而不是
   * 功能 —— 真想要那种效果该关掉复读的图（`repeatMedia: false`），而不是让它乱跟。
   */
  const repeatImageTolerance = Math.min(0.3, Math.max(0, Number(settings.repeatImageTolerance) || 0));

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
    isMuted,
    channelSectionOrder: CHANNEL_SECTION_ORDER,
  });

  // 表情包目录的读写边界搬去了 sticker.js；这里只装配，并把字段解构成同名函数，
  // 调用点（channelTurnContext / send / tools / 目录创建）一个都没改。
  const stickers = createStickerStore({
    settings,
    cwd,
    report,
    memory,
    imageMaxBytes,
    imageAllowed,
    allowTools,
    canReadImages,
    stickerFrames,
  });
  const {
    root: stickerRoot,
    inside: stickerInside,
    label: stickerLabel,
    catalogLines: stickerCatalogLines,
    resolveSource: resolveStickerSource,
    sendSource: stickerSendSource,
    isFile: isStickerFile,
    noteFailure: noteStickerFailure,
    save: saveSticker,
    rename: renameSticker,
    saveAllowed: stickerSaveAllowed,
    renameAllowed: stickerRenameAllowed,
  } = stickers;

  // 发送链路（拆条 / 引用 / 输入状态 / 串行队列）搬去了 send.js；这里只装配依赖。
  //
  // 依赖里的 `conversationMentions` / `describeConversation` / `noteOwnMessage`
  // 仍然是本闭包里的函数声明（函数提升，位置在下面不影响装配）。
  const sender = createSender({
    client,
    settings,
    report,
    cwd,
    imageMaxBytes,
    styleParams,
    chatMaxChars,
    conversations,
    chatter,
    imageAllowed,
    stickerSendSource,
    noteStickerFailure,
    conversationMentions,
    describeConversation,
    noteOwnMessage,
  });
  const {
    enqueueSend,
    sendToConversation,
    sendLiteral,
    replyPieces,
    sendOne,
    startTyping,
    stopTyping,
    stopAllTyping,
  } = sender;

  // 攒批（窗口 / 积压 / 提交）搬去了 batch.js；这里只装配并解构同名别名。
  const batcher = createBatcher({
    settings,
    client,
    report,
    memory,
    submitted,
    sendToConversation,
    groupTalkActive,
    busyWithTurn,
    findRecent,
    mediaFor,
    resolveForwards,
    resolveQuote,
    imageAllowed,
    dropPrefix,
    quotePrefix,
    registerParticipant,
    ensureAgent,
    userMessageFor,
    describeConversation,
  });
  const {
    enqueue,
    holdForBatch,
    backlogBusy,
    backlogShouldHold,
    flushBatch,
    flushIfIdle,
    batchScale,
    batchWindow,
    batchCap,
  } = batcher;

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
  // 定时提醒的运行时（发送 / Agent 轮 / 守卫）搬去了 reminder-runtime.js；这里只装配。
  const reminderRuntime = createReminderRuntime({
    ctx,
    client,
    settings,
    report,
    enqueueSend,
    sendOne,
    sendToConversation,
    enqueue,
    targetConversation,
    ensureAgent,
    userMessageFor,
    submitted,
    noteRecallFallback,
    pendingReminderTurns,
  });
  const {
    scheduleTimer,
    deliverText: deliverReminderText,
    deliverModel: deliverReminderModel,
    nudge: reminderNudge,
    settle: settleReminderTurn,
    run: runReminderTurn,
  } = reminderRuntime;

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

  // ---- 系统提示：人设 / 表达契约 / 硬性规则（实现在 prompt.js）-------------------------------
  //
  // 这里只装配并解构同名函数，调用点（attachChannelPrompt 的 `text:` / channelTurnContext /
  // speakerLine 的场景）一个都没动。依赖表见 prompt.js 文件头。
  const {
    channelPrompt,
    hardRules,
    personaLines,
    personaSceneFor,
    styleLines,
  } = createPromptKit({
    settings,
    allowTools,
    remindersEnabled,
    personaDoc,
    styleDoc,
    styleParams,
    memory,
    stickerLabel,
    stickerSaveAllowed,
    stickerRenameAllowed,
    imageAllowed,
    canReadImages,
  });

  // 设置页的两条 Host 路由（会话列表 / 重置、定时任务看板）搬去了 routes.js；
  // 这里只装配：路由只做 HTTP 形状，会话动作仍是本文件的 webSessionSnapshots /
  // resetConversationFromWeb（它们要碰会话队列与 resetConversation）。
  registerRoutes(ctx, {
    reminders,
    conversations,
    snapshots: webSessionSnapshots,
    resetFromWeb: resetConversationFromWeb,
  });

  // ---- 模型凭据：每天尝试轮换（见 docs/ops.md「每天轮换 API key」）------------------
  //
  // 整个轮换器（池子 / 探测 / 写回 / 每日定时器）搬去了 key-rotation.js；这里只装配。
  // `start()` 在下面的「生命周期」里调用 —— 它要挂定时器并写启动自述。
  const keyRotation = createKeyRotation({ ctx, settings, cwd, report });

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

  // ---- Agent 装配：渠道提示、预设、工具白名单 -----------------------------------------------

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
  // sessionId → 正在进行的 `ctx.agents.create()`：并发调用合并成一次（见 ensureAgent）。
  const agentsInFlight = new Map();

  async function ensureAgent(conversation) {
    // 群名只影响日志、会话列表与「本轮情境」的可读性，查询失败绝不能挡住回复链路。
    // 放在最前面：重启后会话记录是空的，`resume` 那条路是**每一条消息**都会走的，
    // 只在建 Agent 时查一次的话，程序重启一次群名就永久丢了（见 `channelTurnContext`）。
    // 只试一次（进程内）：查询失败就空着，别每条消息都打一次 API。
    if (conversation.type === 'group' && conversation.name.length === 0 && conversation.nameLookup !== true) {
      conversation.nameLookup = true;
      conversation.name = await client
        .call('get_group_info', { group_id: Number(conversation.id) })
        .then((info) => String(info?.group_name ?? ''))
        .catch(() => '');
    }
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
      // 同一个会话可能有两个入口同时走到这里（攒批的任务 + 主动补一句 / 指令），
      // 而 `ctx.agents.create()` 对同一个 sessionId 不是幂等的：第二个会报
      // `session "…" already exists`。用一个 per-session 的 Promise 把并发创建合并成
      // 一次；仍然撞上「已存在」时（例如旧 Agent 还没释放），先看 live，再 resume 一次。
      let creating = agentsInFlight.get(sessionId);
      if (creating === undefined) {
        creating = ctx.agents.create({
          sessionId,
          meta: presetId.length > 0 ? { cwd, agentPreset: presetId } : { cwd },
          agentOptions,
          setup,
        });
        agentsInFlight.set(sessionId, creating);
      }
      try {
        handle = await creating;
        report('info', `created ${sessionId} for ${conversation.key}`);
      } catch (error) {
        if (!/already exists/iu.test(error?.message ?? String(error))) throw error;
        const again = ctx.agents.get(sessionId);
        if (again !== undefined) {
          handle = { agent: again };
          report('warn', `create raced for ${sessionId}; reusing the live Agent`);
        } else {
          handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup });
          report('info', `resumed ${sessionId} after a create race`);
        }
      } finally {
        agentsInFlight.delete(sessionId);
      }
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

  // ---- 每轮上下文：环境、发言者、记忆、时间 ---------------------------------------------------

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
    // 空回复之后的重问：这条 user message 是插件写的，不是对方真的又说了什么 ——
    // 说成「又接了一句」会让模型回一句「接什么？」，说成「刚跟你说话的人」又像一次新提问。
    if (conversation.pendingIntent === 'retry') {
      return '这一轮是插件在提醒你：你上一条回复没有写出要发的话，那一轮什么都没发出去；按刚才的话题直接接上就行。';
    }
    const speakers = conversation.speakers ?? [];
    if (conversation.pendingIntent === 'interject') {
      // 插话轮：这句不是冲它来的。元信息已经写在 user message 里了，这里只说清场景，
      // 不能再用「刚跟你说话的人」——那正是「莫名其妙」的来源（§2.2）。
      return '群里在聊天，下面那句不是叫你的；你只是刚好想接一句，接住那一句就行（想再说一句自己的、关心一句，可以另起一条，接不住就不接）。';
    }
    if (conversation.pendingIntent === 'backlog') {
      // 积压的一波：那些话不是「现在」说的，是它在忙别的事的时候陆续到的。
      // 说成「刚跟你说话的人」会让模型把它们当成同一拍发生的（正文里有相对时间）。
      return '你刚才在忙别的事，下面这些是那期间陆续到的消息；挑还活着的接，不用逐条回。';
    }
    if (speakers.length > 1) {
      const list = speakers.map((speaker) => speakerLabel(speaker)).join('、');
      return `几乎同时在跟你说话的是：${list} —— 他们的话是一起到的，按聊天的节奏挑着接。`;
    }
    if (conversation.pendingIntent === 'continued') {
      const label = speakers.length > 0 ? speakerLabel(speakers[0]) : speakerLabel({ id: conversation.senderId, name: conversation.senderName });
      return `刚才跟你说话的人又接了一句：${label}。`;
    }
    const label = speakers.length > 0 ? speakerLabel(speakers[0]) : speakerLabel({ id: conversation.senderId, name: conversation.senderName });
    return `刚跟你说话的人：${label}。`;
  }

  /**
   * 发言人的展示名；受信者（主人）后面缀一个「（主人）」。
   *
   * 为什么不在提示词里写 QQ 号：模型会照着念出来（见 `speakerLine` 的注释）。缀一个
   * 中文标签既能让它认出「这是主人、请求优先」，又不用把号暴露出去；写盘权限本身
   * 不靠这个标签，靠工具执行时的 `writeAuthority` 再核一次。
   */
  function speakerLabel(speaker) {
    const name = String(speaker?.name ?? '');
    return canOperate(speaker?.id) ? `${name}（主人）` : name;
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
   * 小节，系统提示保持稳定（只在人设 / 表达 / 配置真的改了时才变一次；表情包目录也搬到了
   * 这里，见 `stickerCatalogLines`）。
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
    // 群名 / 对方名字放在这里（而不是系统提示里）：它来自 `get_group_info` 的一次查询，
    // 重启后可能暂时查不到，群里也可能改名 —— 系统提示跟着变一次，DSH 就会把整份人设
    // 再追加一遍（见 `channelPrompt`）。每轮现给，查到就有、查不到就不提。
    if (conversation.name.length > 0) {
      lines.push(isGroup ? `- 这个群叫「${conversation.name}」（群号 ${conversation.id}）。` : `- 这个私聊窗口是跟 ${conversation.name} 的。`);
    }
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
    // 表情包目录：存图 / 改名之后它就得让模型看见，但它也是会变的 —— 放系统提示里等于
    // 每存一张就追加一整份人设 + 硬规则（见 `stickerCatalogLines`）。这里只在本会话第一次
    // 或目录变了时给一次。
    const catalogLines = stickerCatalogLines(conversation);
    if (catalogLines.length > 0) lines.push('', ...catalogLines);
    // 检索式记忆：每轮按当前消息重新检索，放系统提示里就等于每轮换一次整段提示。
    // 「同一条只给一次」的账在 memory.js（`recallLedger`）：这一轮没有新东西时一个字都不加，
    // 也不再补一句「记忆还是空的」—— 系统提示里已经说清它去哪儿查，而这块每轮都会留在
    // 历史里，重复一次就是一次额外的上下文。
    if (memory.toolsAllowed()) {
      const recall = memory.recallText(conversation);
      if (recall.length > 0) lines.push('', recall);
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
    // 分条：系统提示里那条「能分就分 / 说到气口就发」模型执行得并不稳 —— 2026-10-22 重启后
    // 私聊仍然是「没呢，你怎么也还没睡」这种两句一条。那一轮的情境里还有一句人设的
    // 「别连着轰炸」在反向拉，两者都改掉之后，再在这里补一枪：这一行离模型开口最近。
    // 用**正向**写法、不写条数；reminder 轮的原样发送不走拟人分条，humanize 关掉时也没有。
    if (settings.humanize === true && conversation.pendingIntent !== 'reminder') {
      lines.push('', '- 想说的话一句一条，分几条发（换行 = 分条）。');
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

  // ---- 系统提示：人设 / 表达契约 / 硬性规则 ------------------------------------------------
  //
  // 实现在 `prompt.js`（`createPromptKit`）；`channelTurnContext`（每轮情境）仍在上面，
  // 它用的是同一组 `personaLines` / `personaSceneFor`。
  // ---- 能力判定与工具依赖：图片、提醒、目标解析 -------------------------------------------------

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
   * 这个 Agent 能不能用 `read_image` 看图。
   *
   * 提示词里「拿不准的先 read_image 看一眼」这句话只在真能用的时候才该出现 —— 否则
   * 模型会去调用一个它看不见的工具。`channelPrompt` 与表情包目录那段共用这一处判断。
   */
  function canReadImages() {
    return mediaStore.enabled && (allowTools.length === 0 || allowTools.includes('read_image'));
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

  /** 工具执行上下文 → 它来自哪个 QQ 会话（Web 主会话没有）。 */
  function conversationOfExec(exec) {
    if (exec?.agent?.id === undefined) return undefined;
    return conversations.get(sessionIndex.get(exec.agent.id));
  }

  /**
   * 这一轮说话的人有没有写盘 / 静默权限（`qq_write` / `qq_edit` / `qq_skill` / `qq_quiet`）。
   *
   * 判据刻意是「这一批发言人**全部**在主人名单里」：攒批会把前后脚的消息合进一轮，
   * 只要混进一个群友，这一轮就不该有这些能力 —— 宁可让主人单独再说一句，也不要把
   * 「群里任何人都能借主人的话头改文件 / 让 bot 睡觉」这种缝隙留着。
   *
   * Web 主会话（不在 `sessionIndex` 里）视为操作员：那是部署者自己在用。
   * @param exec - 工具执行上下文（`exec.agent.id` 用来反查 QQ 会话）。
   * @returns `{ allowed, operator, key, callerId, reason }`。
   */
  function writeAuthority(exec) {
    const conversation = conversationOfExec(exec);
    if (conversation === undefined) {
      return { allowed: true, operator: true, key: '', callerId: 'operator', reason: '' };
    }
    const speakers = conversation.speakers ?? [];
    if (speakers.length === 0) {
      return {
        allowed: false,
        operator: false,
        key: conversation.key,
        callerId: String(conversation.senderId ?? ''),
        reason: '还不知道这一轮是谁在说话',
      };
    }
    const allowed = speakers.every((speaker) => canOperate(speaker.id));
    return {
      allowed,
      operator: false,
      key: conversation.key,
      callerId: String(speakers[speakers.length - 1]?.id ?? ''),
      reason: allowed ? '' : '这一轮里有人不在主人名单（只有主人能改文件 / 让 bot 静默）',
    };
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

  // ---- 会话生命周期：/reset、设置页重置、静默换代 ---------------------------------------------

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

  // ---- 会话记录：字段、参与者、群名 -------------------------------------------------------

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
      /**
       * 群名只在进程内查一次（`get_group_info`）：重启后会话记录是空的，而 `ensureAgent`
       * 的 `resume` 路径每条消息都会走 —— 不补查的话群名会一直空到下一次换代。
       * 标记写在记录上（不是模块变量），换代之后会自然地再查一次。
       */
      nameLookup: false,
      /**
       * 表情包目录「上次给过哪一份」的账（`{ generation, key }`），见 `stickerCatalogLines`。
       * `undefined` = 本会话还没给过，下一轮会补一次。
       */
      stickerCatalog: undefined,
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
    if (settings.groupTrigger !== 'prefix') return text;
    const prefix = settings.prefix;
    // 只有**真的以唤醒词开头**才剥。原实现直接按长度硬切，于是私聊里（前缀模式对私聊
    // 同样生效）每条消息都会被削掉开头两个字：短句被削成空串后整条丢掉，长句开头被吃掉。
    if (prefix.length === 0 || !text.startsWith(prefix)) return text;
    return text.slice(prefix.length).trim();
  }

  // ---- 准入：这条消息该不该进 Agent、以什么身份进 ---------------------------------------------

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
      // 静默中的群：消息在入口就丢掉（不建 turn、不花 token）；「起床」那条已经在
      // handleEvent 里先一步处理掉了，所以这里丢掉不会让它醒不过来。
      if (isMuted(`group:${groupId}`)) return undefined;
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
    if (isMuted(`private:${userId}`)) return undefined;
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

  // ---- 群聊记账：谁在说话、会话活跃度 ------------------------------------------------------

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

  // ---- 撤回的账：最近看见过什么（环境与撤回共用） ------------------------------------------------

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

  // ---- 自动复读：文字 / 图片 / 表情 ----------------------------------------------------

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
    // 静默的群不跟着复读：复读虽然不花 token，但「不说话」就得真的一个字都不发。
    if (isMuted(`group:${groupId}`)) return;
    const existing = conversations.get(`group:${groupId}`);
    if (existing !== undefined && isRepeatOff(existing)) return;
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
   * 读一个「今天用了多少次」的计数；跨天就地归零。
   *
   * 主动说话 / 补一句 / 戳一戳 / 撤回调侃四处共用这一套，字段名不同只是因为它们
   * 在 `blankConversation` 里按功能成组出现：`dayKey` 存日期、`countKey` 存次数。
   * 计数刻意放在**内存**里：重启后归零可以接受（重启本身很稀有），换成落盘状态
   * 得多维护一个文件，与 `ambient` / 复读链这些运行时状态的口径也一致。
   *
   * @param conversation - 目标会话。
   * @param dayKey - 会话记录上存「上次计数是哪天」的字段名。
   * @param countKey - 会话记录上存次数的字段名。
   * @returns 今天已经用掉的次数。
   */
  function dailyCount(conversation, dayKey, countKey) {
    const today = localDate();
    if (conversation[dayKey] !== today) {
      conversation[dayKey] = today;
      conversation[countKey] = 0;
    }
    return conversation[countKey] ?? 0;
  }

  /**
   * 清理归属表里已经超时的条目。
   *
   * 正常路径由 `agent/inbox/claimed` / `turn/end` 删除；这里是兜底：模型端挂死、
   * 宿主在别处 dispose 了这个 Agent、或者 `agent.followup()` 异步失败，都可能让
   * 条目永远留着。`busyWithTurn` 一旦看到它，这个会话的主动说话 / 补一句 / 提醒
   * 就永久失效 —— 比丢一轮回复更隐蔽。
   *
   * 顺带把 `submitted` 压回上限：超过 `SUBMITTED_MAX` 时淘汰最旧的，而不是整表 clear。
   * @param now - 当前时刻（测试可注入）。
   */
  function sweepOwnership(now = Date.now()) {
    for (const [slot, owner] of turnOwners) {
      if (now - (Number(owner?.at) || 0) < OWNER_TTL_MS) continue;
      turnOwners.delete(slot);
      transcripts.delete(slot);
      report('warn', `turn ${slot} 超过 ${Math.round(OWNER_TTL_MS / 60000)} 分钟没有结束，已从归属表移除`);
    }
    for (const [id, owner] of submitted) {
      if (now - (Number(owner?.at) || 0) < OWNER_TTL_MS) continue;
      submitted.delete(id);
      report('warn', `message ${id} 超过 ${Math.round(OWNER_TTL_MS / 60000)} 分钟没有被 claim，已从投递表移除`);
    }
    if (submitted.size > SUBMITTED_MAX) {
      const oldest = [...submitted.entries()].sort((a, b) => (Number(a[1]?.at) || 0) - (Number(b[1]?.at) || 0));
      for (const [id] of oldest.slice(0, submitted.size - SUBMITTED_MAX)) submitted.delete(id);
    }
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
    sweepOwnership();
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
      todayCount: dailyCount(conversation, 'proactiveDay', 'proactiveCount'),
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
      // 不写「吐槽一句」：它直接邀请一句点评，而「观鸟人这精神状态，我服」正是那个路子。
      // 主动搭话也要落在具体的事上 —— 说句自己的、问一句，比给别人的事下判断更像聊天。
      imageAllowed()
        ? '- 想接一句之前的话题、说句自己的、问一句，或者甩一张合适的表情包（正文只写 `[[图片: 路径]]`），都行；'
        : '- 想接一句之前的话题、说句自己的、问一句，都行；',
      '- 觉得没什么可说的、或者刚说过话不想重复，就整条回复只写 `SKIP` —— 那样一个字都不会发出去，这是很正常的选择。',
      '',
      '注意：',
      '- 别提前面这条提醒，也别说「好久没人说话了」这种旁白；就当自己突然想冒个泡。',
      '- 别重复你刚说过的话，也别每次都问「在吗」。',
      // 「一条就够」说的是**这一轮只冒一次泡**，不是「只能一个气泡」：真人主动开口
      // 也常是两条短消息（「哎」「你们在聊什么」），压成一个气泡反而像客服。
      '- 这一轮冒一次泡就够，别刷屏；想说的短句可以分几条发，别写成一整段。',
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
    conversation.proactiveCount = dailyCount(conversation, 'proactiveDay', 'proactiveCount') + 1;
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
          at: Date.now(),
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
      if (isMuted(conversation.key)) continue;
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
    // 静默中不安排「补一句」：回完这一轮就该彻底安静，20 秒后再醒一次等于没睡。
    if (isMuted(conversation.key)) return;
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
    // 定时器挂上之后才被静默的：到点再判一次，静默优先于任何「补一句」的理由。
    if (isMuted(conversation.key)) return;
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
        chimeToday: dailyCount(conversation, 'chimeDay', 'chimeToday'),
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
      chimeToday: dailyCount(conversation, 'chimeDay', 'chimeToday'),
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
    conversation.chimeToday = dailyCount(conversation, 'chimeDay', 'chimeToday') + 1;
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
          at: Date.now(),
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
      '- 别提前面这条提醒，也别说「你怎么不说话了」这种旁白；补一两句短的就行，别写成一整段。',
      '- 对方没接话，别追问太紧：没什么想说的就 SKIP，这很正常。',
    ].join('\n');
  }

  /**
   * 模型空回复之后那条「重问」。
   *
   * 2026-10-22 23:50 的真实事故：私聊里模型最后一步只输出了思考，没有正文
   * （`deepseek-flash` 偶发；思考里已经写好了「不想说就不说 / 还拿我顶着盆的图来挡」），
   * 插件把它当空回复静默丢了。对方等了半分钟发「？」，它下一轮还回了「上一条说秃了」——
   * 那句话只存在于它自己的思考里，QQ 上从来没出现过。
   *
   * 空回复不是「选择不说」（那是 `SKIP`），而是这一轮**没有产出可发的东西**；对着一个
   * 真人的轮次不能就这么算了。重问一次的成本远小于让人干等，而且模型通常第二次就能把
   * 话说出来（它上一轮的思考里已经有了答案）。只说清「那一轮什么都没发出去」，不解释
   * 机制、不让它道歉 —— 否则回复会变成一句「刚才卡了一下」，那比不说话更像机器人。
   *
   * 这条消息会留在会话历史里，所以它必须说清「不是对方发来的」；重问也只会发生一次
   * （见 `emptyRetry`），不会和模型互相追问下去。
   */
  function emptyReplyNudge() {
    return [
      '（这不是对方发来的消息，是插件在提醒你：你上一条回复没有写出要发的话，那一轮什么都没发出去。现在直接把要说的话写出来。）',
      '',
      '别解释这条提醒，直接把要说的话发出来；像平时那样接话就行。',
    ].join('\n');
  }

  // ---- 媒体：入站图片与引用的落盘 --------------------------------------------------------

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
            rendered.set(item.index, mediaPlaceholder(item, outcome.path, undefined, outcome.animation));
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
   * 把一条消息里的合并转发展开成「谁说了什么」。
   *
   * 为什么放在投递链路的异步段（与媒体、引用并列），而不是塞进 `modalities.js`：
   *   - NapCat 默认把子消息**内联**在 `data.content` 里，但别的实现只给一个 id，要补一次
   *     `get_forward_msg` —— 这一步有 IO，不能留在纯渲染层；
   *   - 子消息里的图还要落盘（否则模型只看到 `[图片]`），那是 `resolveMessageMedia` 的活；
   *   - 展开会把一整段聊天记录喂进上下文，条数 / 字数 / 嵌套深度必须在**投递前**就裁掉。
   *
   * 拿不到内容时返回 undefined，调用方保留 `[合并转发 N 条]` 占位符 —— 转发取不到不该
   * 打断消息投递。`depth` 是嵌套层数：0 = 最外层，只有 `forwardMaxDepth` 放行时才往下。
   *
   * @param message - OneBot 的 `message` 字段（消息段数组）。
   * @param depth - 当前嵌套层数。
   * @returns `段下标 → 展开文本` 的映射；没有可展开的转发时 undefined。
   */
  async function forwardReplacements(message, depth = 0) {
    if (settings.forwardRead !== true) return undefined;
    if (!Array.isArray(message)) return undefined;
    // 0 = 整条关掉（`forwardRead` 也可以关，两个都留着是为了单测边界更直白）。
    if (depth >= settings.forwardMaxDepth) return undefined;
    const targets = [];
    message.forEach((segment, index) => {
      // `node` 是 NapCat 把「转发里还有转发」上报成的段；它本身也是一条子消息。
      if (segment?.type !== 'forward' && segment?.type !== 'node') return;
      targets.push({ index, segment });
    });
    if (targets.length === 0) return undefined;
    const rendered = new Map();
    for (const { index, segment } of targets.slice(0, FORWARD_MAX_PER_MESSAGE)) {
      const text = await expandForward(segment, {
        // 超时由 `client.call` 的第三个参数控制：卡住的实现不能把整轮投递拖到 15 秒。
        call: (action, params) => client.call(action, params, settings.forwardTimeoutMs),
        maxNodes: settings.forwardMaxNodes,
        maxChars: settings.forwardMaxChars,
        // 普通正文由 `renderForwardNodeBody` 折成一行；这里只负责保留嵌套块排好的换行。
        multiline: true,
        // 嵌套块才要结束标记：最外层消息本身就到头了，不加能省一行。
        closing: depth > 0,
        renderNode: async (node) => {
          // 子消息里的图与嵌套转发一起解析：两件事互不依赖，串起来等只是白等。
          const [media, nested] = await Promise.all([
            resolveMessageMedia(node.message),
            forwardReplacements(node.message, depth + 1),
          ]);
          const replacements = new Map(media?.rendered ?? []);
          for (const [nestedIndex, nestedText] of nested ?? []) replacements.set(nestedIndex, nestedText);
          return renderForwardNodeBody(node.message, replacements, nested);
        },
      });
      if (text !== undefined) {
        // 块前后如果还有别的段，补一个换行：否则 `看这个[合并转发…` 或
        // `…笑死怎么样` 会把块和正文粘在同一行，块的头尾都不清楚。
        // **只给最外层补**：嵌套块的新行/缩进由 `renderForwardNodeBody` 负责，
        // 这里再补一次会在父行和块之间多出一个空行。
        const outer = depth === 0;
        const before = outer && message.slice(0, index).some((segment) => segment?.type !== 'reply');
        const after = outer && message.slice(index + 1).some((segment) => segment?.type !== 'reply');
        rendered.set(index, `${before ? '\n' : ''}${text}${after ? '\n' : ''}`);
        continue;
      }
      const id = forwardId(segment);
      if (id !== '') report('info', `forward: 没能展开 ${id.slice(0, 32)}（消息照常投递，正文保留占位符）`);
    }
    return rendered.size > 0 ? rendered : undefined;
  }

  /**
   * 投递一条消息时用的转发解析入口（固定从最外层开始）。
   *
   * 单独包一层是为了让 `batch.js` 的依赖表只看见「一条消息 → 段下标映射」这件事，
   * 不用知道递归、深度与超时。
   * @param message - OneBot 的 `message` 字段。
   * @returns 与 {@link forwardReplacements} 同形。
   */
  function resolveForwards(message) {
    return forwardReplacements(message, 0);
  }

  /**
   * 渲染转发里的一条子消息：普通段折成一行，嵌套转发块另起一行并缩进。
   *
   * 为什么不能直接用 `messageToText`：它会把嵌套块当成普通正文拼进去，换行、缩进、
   * 结束标记都没了，模型只能靠 `[合并转发 N 条]` 猜层级。这里按段走一遍：
   *   - 普通段（文字 / 图 / 表情 / 卡片 / 深到上限的转发占位符）照常渲染，空白折成一行；
   *   - `nested` 里的段是**已经展开好的嵌套块**，前面补一个换行、整体缩进两格；
   *   - 块后面的文字另起一行，回到父层（不再缩进）。
   *
   * @param message - 子消息的 `message` 字段（消息段数组或 CQ 码字符串）。
   * @param media - `段下标 → 替身文本`（图片/视频封面等）。
   * @param nested - `段下标 → 嵌套转发的展开文本`（`forwardReplacements` 给出）。
   * @returns 供 `renderForwardNodes` 使用的正文（可能含换行）。
   */
  function renderForwardNodeBody(message, media, nested) {
    if (typeof message === 'string') return message.replace(/\s+/g, ' ').trim();
    if (!Array.isArray(message)) return '';
    const parts = [];
    let afterBlock = false;
    message.forEach((segment, index) => {
      const block = nested?.get(index);
      if (block !== undefined) {
        // 父行已经有文字时，块另起一行、整块缩进两格；父行只有这个块时，
        // 第一行跟着 `名字: ` 走，后续行再缩进（否则会多出一行空行）。
        const text = indentForwardBlock(block, parts.length === 0 ? 0 : 2);
        parts.push(parts.length === 0 ? text : `\n${text}`);
        afterBlock = true;
        return;
      }
      const rendered = String(renderSegment(segment, media?.get(index)) ?? '').replace(/\s+/g, ' ');
      if (rendered.length === 0) return;
      // 块后面的文字必须另起一行，否则会粘在 `[/合并转发]` 后面。
      parts.push(afterBlock ? `\n${rendered}` : rendered);
      afterBlock = false;
    });
    return parts.join('').trim();
  }

  /**
   * 给一段嵌套转发的每一行加缩进。
   *
   * 第一行的缩进由父行有没有文字决定：有文字就另起一行缩进两格，没有就跟着 `名字: `。
   * 其余行固定两格 —— 更深的层级已经在块内部自己缩进过了，这里只负责平移。
   *
   * @param text - 已经排好版的嵌套块。
   * @param firstIndent - 第一行的缩进空格数。
   * @returns 缩进后的块。
   */
  function indentForwardBlock(text, firstIndent) {
    return String(text)
      .split('\n')
      .map((line, index) => `${' '.repeat(index === 0 ? firstIndent : 2)}${line}`)
      .join('\n');
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
    // 被引用的那条自己也可能是一个合并转发：图与转发都取，谁先好都行。
    const [resolved, forwards] = await Promise.all([resolveMessageMedia(quoted), forwardReplacements(quoted, 0)]);
    const replacements = new Map(resolved?.rendered ?? []);
    for (const [index, text] of forwards ?? []) replacements.set(index, text);
    const text = messageToText(quoted, undefined, replacements.size > 0 ? replacements : undefined).replace(/\s+/g, ' ').trim();
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

  // ---- 戳一戳：判据、回戳、走一轮 --------------------------------------------------------

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
    // 静默中不回应戳一戳：连「回戳」都算冒泡，睡觉就该彻底没反应。
    if (isMuted(conversation.key)) {
      report('info', `${describeConversation(conversation)} 戳一戳不回应（静默中）`);
      return;
    }
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
      todayCount: dailyCount(conversation, 'pokeDay', 'pokeToday'),
      dailyMax: settings.pokeDailyMax,
    });
    if (decision.act === 'none') {
      report('info', `${describeConversation(conversation)} 戳一戳不回应（${decision.reason}）`);
      return;
    }
    // 记账刻意在**发出去之前**：回戳失败、或者那一轮被判成 SKIP，这次机会照样用掉 —
    // 否则对方一直戳，它就一直在同一个冷却里反复尝试。
    conversation.pokeAt = now;
    conversation.pokeToday = dailyCount(conversation, 'pokeDay', 'pokeToday') + 1;
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
          at: Date.now(),
        });
        agent.followup(userMessage);
      } catch (error) {
        report('warn', `poke turn for ${conversation.key} could not start: ${errorText(error)}`);
      }
    });
  }

  // ---- 撤回：清引用、改写、补一句 --------------------------------------------------------

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
      todayCount: dailyCount(conversation, 'recallDay', 'recallToday'),
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
    conversation.recallToday = dailyCount(conversation, 'recallDay', 'recallToday') + 1;
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
          at: Date.now(),
        });
        agent.followup(userMessage);
      } catch (error) {
        report('warn', `recall turn for ${conversation.key} could not start: ${errorText(error)}`);
      }
    });
  }

  // ---- 入站事件路由：消息、戳一戳、撤回 -----------------------------------------------------

  /** 处理一条已解码的 OneBot 事件（由 OneBotClient 的 onEvent 调用）。 */
  function handleEvent(event) {
    const selfId = client.selfId;
    if (selfId === '') return;
    // 通知事件（戳一戳 / 撤回）先于消息分流：以前这里第一行就把非 message 全丢了，
    // 于是「有人戳了它一下」（§8.3）与「有人撤回了刚说的话」它都完全收不到。
    if (event?.post_type === 'notice') {
      if (event.notice_type === 'group_increase' || event.notice_type === 'group_decrease') {
        void handleGroupMember(event);
        return;
      }
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
    // 睡着期间把群消息留一小段（只放内存），醒来时用来说一句「梦话」。
    if (event.message_type === 'group' && isMuted(`group:${event.group_id}`)) noteDreamLine(event, selfId);
    // 静默 / 唤醒：入睡由模型调用 qq_quiet 完成（语义判断在那一边）；这里只处理
    // 睡着之后**唯一**能进来的东西 —— 主人说「起床」。它必须在准入之前判，否则
    // 静默中的群会把这条也一起丢掉，只能去私聊里叫它。
    claimOwnerIfNeeded(event, selfId);
    const wakeCommand = wakeCommandFor(event, selfId);
    if (wakeCommand !== undefined) {
      memory.rememberTranscript(event, selfId, { admitted: undefined, reset: false });
      applyWakeCommand(wakeCommand);
      return;
    }
    // 「睡觉去」这类话：先让模型照常处理（它应该调 qq_quiet）；12 秒内没真的静默，
    // 就自动走定档——写交接文档、归档旧会话、新开一轮。
    const sleepConversation = sleepIntentFor(event, selfId);
    if (sleepConversation !== undefined) markSleepIntent(sleepConversation);
    // 「@bot + 空格 + 指令」在准入之前分流：帮助 / 天气 / 余额 / 随机表情 / 设置 / 状态
    // 由插件直接回（零 token）；小作文 / 白饭 / 表情 才整理成说明投给模型。
    const command = commandFor(event, selfId);
    if (command !== undefined) {
      memory.rememberTranscript(event, selfId, { admitted: undefined, reset: false });
      void runCommand(command).catch((error) => report('warn', `command failed: ${errorText(error)}`));
      return;
    }
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
      // 没人叫它的群消息：先看有没有主人关注的关键词（命中只私聊通知，零 token）。
      if (event.message_type === 'group') {
        const watchKey = `group:${event.group_id}`;
        void checkWatches(watchKey, messageToText(event.message ?? event.raw_message, selfId), userDisplayName(event.sender ?? {}, event.user_id));
      }
      rememberAmbient(event, selfId);
      return;
    }
    const { conversation, message, preview, quote } = admitted;
    // 今天是不是这个会话的纪念日（每个会话一天只提醒一次）。
    checkAnniversaries(conversation);
    const sender = event.sender ?? {};
    const who = describeConversation(conversation);
    // 兜底清理归属表，避免「消息入队了但 turn 始终没被 claim」导致无限增长：
    // 超时条目按 TTL 清掉，`submitted` 超上限时只淘汰最旧的几条。
    // **不能整表 clear()**：那会把正在飞的消息归属一起抹掉，之后 turn/end 找不到 owner，
    // 模型回复被静默丢弃（群里表现为「不理人」）。
    sweepOwnership();
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
        report('info', `ignored ${resetCommand} from ${conversation.key} by ${event.user_id}: not an owner`);
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
    // TTL 从 claim 这一刻重新算：模型开始跑的轮次才是「可能挂死」的那一段。
    owner.at = Date.now();
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
    if (conversation !== undefined) {
      stopTyping(conversation);
      // 这一轮收尾之后它可能就闲下来了：忙的时候攒着的那一波迟到的消息可以投了。
      // 必须放在这里（而不是某个分支里）：下面每一条提前 return（提醒、aborted、error、
      // 空回复、SKIP、主动搭话）都可能正是「它终于闲下来」的那一刻。
      flushIfIdle(conversation);
    }
    if (owner === undefined) return;
    const reason = event.data.reason?.kind;
    // 只发该 turn 里最后一条有文本的 assistant 消息；中间步骤的工具调用等不发给 QQ。
    let reply = list?.[list.length - 1]?.trim() ?? '';

    // 定时提醒的 agent/prompt 轮：必须在 error / SKIP / aborted 之前收账。
    // 这几个分支在普通轮次里是「静默丢弃」，但提醒不能静默 —— 要让 reminders.js 拿到
    // 结果去走兜底文案。`settleReminderTurn` 返回 false 说明守卫已经超时并结算过，
    // 这一条迟到的回复必须丢弃，否则同一件事会发两遍。
    //
    // **必须排在 `conversation === undefined` 之前**：重启之后 `conversations` 还是空的，
    // 提醒走 `targetConversation` 造的一次性壳（不写进会话表），turn/end 这里按 key 查
    // 不到会话。若先 return，模型这一轮的回复就白丢了，120 秒后只剩兜底文案。
    if (owner.reminderId !== undefined) {
      if (conversation !== undefined) conversation.pendingIntent = undefined;
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
    if (conversation === undefined) return;

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
    if (reply.length === 0) {
      // 空回复有两种：模型**选择**不说（那会写成 `SKIP`，下面才处理）与这一轮**没产出**
      // （只写了思考 / 工具调用完就停了）。后者当空回复静默丢掉，QQ 那头看到的就是
      // 「它没理人」，而模型下一轮还会以为自己说过 —— 它的思考里已经写好了那句话
      // （真实事故：2026-10-22 23:50 私聊，对方等了半分钟发「？」，它回「上一条说秃了」）。
      //
      // 所以对着真人的轮次重问一次：主动搭话 / 补一句 / 撤回调侃（`proactive`）本来就
      // 可以不说，重问只会平白多一次开口。`emptyRetry` 保证只重问一次，不会循环；
      // 还有消息等着回（攒批窗口 / 积压一波）时也不重问，那些消息马上会换来一轮回复。
      const waiting = conversation.pending.length > 0 || (conversation.submitting ?? 0) > 0;
      if (reason === 'completed' && owner.proactive !== true && owner.emptyRetry !== true && !waiting) {
        const retryIntent = owner.intent ?? conversation.pendingIntent ?? 'addressed';
        report('info', `→ ${conversation.key}: 模型这一轮没有写出正文（turn ${event.data.turn}），重问一次`);
        void enqueue(conversation, async () => {
          try {
            const agent = await ensureAgent(conversation);
            // 重问这一轮的情境用 `retry`：`speakerLine` 得说清「这条不是谁发来的」，
            // 原来的 `continued` / `interject` 会让它以为对方又接了一句 / 群里又有人说话了。
            conversation.pendingIntent = 'retry';
            const userMessage = userMessageFor(conversation, emptyReplyNudge());
            submitted.set(userMessage.id, {
              key: conversation.key,
              quote: owner.quote,
              // 发送侧的意图仍是原来那个（决定挂不挂引用 / @），与情境用的 `retry` 分开。
              intent: retryIntent,
              // 账上那几条消息的「已回复」要等重问真正发出去时才记（与普通轮次一致）。
              batchIds: owner.batchIds,
              // 空消息那一轮本来就没有话题，重问发出去之后也别再追一句「补一句」。
              blank: owner.blank,
              emptyRetry: true,
              at: Date.now(),
            });
            agent.followup(userMessage);
          } catch (error) {
            // 重问起不来就算了（`enqueue` 的兜底会在群里发一句「我这边出错了」，
            // 那一句对「模型空回复」这件事没有帮助）。
            report('warn', `empty-reply retry for ${conversation.key} could not start: ${errorText(error)}`);
          }
        });
        return;
      }
      conversation.pendingIntent = undefined;
      report('info', `→ ${conversation.key}: 模型这一轮没有正文可发（turn ${event.data.turn}），不发消息`);
      return;
    }
    // `SKIP` 是**这一条会话本身**的「不说了」信号，不是「主动搭话」才有的信号：提醒
    // （`proactiveNudge` / `chimeNudge`）虽然只在那两种轮次里发，但它落在同一个会话的
    // 上下文里，模型照样可能在回别人的那一轮里学着写出来。一旦漏判，群里收到的就是
    // 一句字面的 `SKIP` —— 它本来是用来「什么都不做」的。空回复在上一段就重问 / 丢弃了，
    // 这里只管那个词。
    //
    // 放在最前面（而不是只放在主动搭话那一支）是必须的：真正会「引用」一条消息的正是
    // 回别人的那一轮 —— 主动搭话的 `quote` 永远是空的（没人跟它说话），所以
    // 「引用 + SKIP」同时出现的那种消息**一定**是走这一支的。
    if (proactiveSkip(reply)) {
      report('info', `→ ${conversation.key}: （判成 SKIP，不发送）`);
      conversation.pendingIntent = undefined;
      return;
    }
    // 指令的硬上限：白饭 ≤25 字（配置写着「不超过 25 字」，模型偶尔会多写）；
    // 小作文 ≤800 字（主人明确要求的上限）。只裁这两类，普通聊天不裁。
    if (owner.command === '白饭') reply = clipChars(reply, 25);
    else if (owner.command === '小作文') reply = clipChars(reply, 800);
    else if (owner.command === '梦话') reply = clipChars(reply, 80);
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
    // 受信写盘：editor 缺失（trustedWrite 关掉）时不注册那三个工具；权限在
    // writeAuthority 里按「这一轮谁在说话」现判（见 docs/tools.md「受信写盘」）。
    editor,
    writeAuthority,
    // 静默：工具层的语义判断（睡哪个群）在模型那边，这里只执行与查询。
    quiet: {
      sleep: (target, exec) => quietSleep({
        target,
        conversation: conversationOfExec(exec),
        by: writeAuthority(exec).callerId,
      }),
      wake: (target, exec) => quietWake({
        target,
        conversation: conversationOfExec(exec),
        by: writeAuthority(exec).callerId,
      }),
      status: () => quietStatus(),
    },
    // 主人侧 bot 配置（qq_settings）：白名单键 + 覆盖层 + 重启生效。
    settingsAdmin,
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
  // 定时器、启动自述与三种开关状态的日志都在 key-rotation.js 的 `start()` 里；这里只负责
  // 在生命周期这一节把它挂上（与摘要循环同一套托管方式）。
  keyRotation.start();

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

  // 主人 / 静默 / 覆盖层的启动自述：排查「它怎么不听话 / 怎么没睡 / 改的设置没生效」
  // 时先看这几行。主人名单为空且没认主 = 重置 / 静默 / 写盘全关，这是刻意的失败方向。
  if (ownerState.ids.length > 0) {
    report('info', `owner: ${ownerState.ids.join(', ')}${configuredOwners.length > 0 ? ' (resetUsers)' : ' (auto-claimed)'} — reset / quiet / trusted write allowed`);
  } else {
    report('info', `owner: none yet${settings.ownerAutoClaim ? ' — the first private contact will be claimed' : ' (ownerAutoClaim is off)'}; reset / quiet / trusted write are disabled`);
  }
  report(
    'info',
    `quiet: ${muteState.global ? 'all groups' : muteState.keys.size > 0 ? `${muteState.keys.size} group(s)` : 'awake'}` +
      `${settings.mutePersist ? `, state at ${settings.muteFile}` : ', state in memory only'}; wake triggers: ${settings.wakeTriggers.join('、') || 'none'}`,
  );
  if (resetCommand.length === 0) {
    report('info', 'reset command is disabled (resetCommand is empty)');
  } else if (ownerState.ids.length === 0) {
    report('info', `reset command "${resetCommand}" is disabled until an owner exists`);
  } else {
    report('info', `reset command "${resetCommand}" is allowed for ${ownerState.ids.length} owner(s)`);
  }
  report(
    'info',
    `trusted write: ${editor !== undefined ? `on, skills at ${skillRoot}` : 'off'}; ` +
      `owner settings overlay: ${ownerSettingsApplied.length > 0 ? `${ownerSettingsApplied.length} key(s) from ${settings.ownerSettingsFile}` : 'none'}`,
  );
  report(
    'info',
    `commands: ${settings.commands === true ? 'on' : 'off'}; guest commands: ${settings.guestCommands === true ? 'on' : 'off'} — @bot + space + 帮助/天气/表情/白饭/小作文 (guest), 状态/余额/设置 (owner)`,
  );
}

