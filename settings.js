/**
 * 插件配置的**运行时视图**：把「取默认值 / 强制类型 / 夹到合法区间」这些再加工
 * 收在一处。
 *
 * 为什么要单独一层：散在 `index.js` 各处的 `Math.max(256, Math.floor(Number(config.x) || 0))`
 * 这类表达式，读的时候看不出「这个开关的合法范围到底是什么」，改一个默认值也得全局搜。
 * 收进来之后，`index.js` 只读 `settings.x`，而「x 到底允许什么值」在这里一眼可见。
 *
 * 两条纪律：
 *
 *   1. **纯函数**：只读配置，不碰 `ctx`、不读磁盘、不发日志。路径的越界校验留在
 *      `index.js`（那里才有 `report` 可以记 warn），这里只负责把配置值本身整理干净。
 *   2. **快照是安全的**：cordis 的 `Plugin.update()` 是 `this.config = config` 之后
 *      `restart()`（重新跑一遍 `apply`，见 cordis 的 `update` 实现），所以配置一改整个
 *      闭包就重建。`index.js` 本来就有 `stickerRoot` / `memoryEnabled` 这些 apply 时
 *      算好的常量，本模块只是把这件事做彻底 —— 热改配置仍然生效。
 *
 * 最后一行 `...config` 是刻意的：schema 已经保证类型与默认值的字段直接透传，只有需要
 * 再加工的字段才在下面覆盖。这样加一个配置项时不必来改这里（旧写法会脱节）。
 *
 * @module @qqbot/dsh-plugin-qq/settings
 */
import { DEFAULT_IMAGE_MAX_BYTES } from './image.js';

/**
 * `setTimeout` 能表达的最大延迟。
 *
 * 配置写成天文数字时不能让 Node 的定时器溢出 —— 那会退化成「1 毫秒后立刻醒」，
 * 也就是把「几乎无限地等」变成「立刻发出去」，方向完全反了。攒批定时器也用这个上限。
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** 去掉空白的字符串字段（schema 保证类型，但配置仍可能被手写成空白）。 */
function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 去重、去空白的字符串列表：白名单里重复项没有意义，空白项更不该算一项。 */
function deduped(value) {
  return [...new Set((value ?? []).map((item) => String(item).trim()).filter((item) => item.length > 0))];
}

/** 毫秒配置项：非法值退回 `fallback`，负数按 0 算（原本是 `proactiveMs` 的口径）。 */
function msOf(raw, fallback) {
  const value = Math.floor(Number(raw));
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

/** 取整并夹在 `low`~`high`；非法值退回 `fallback`（用于小时、超时这类有明确上下界的项）。 */
function clampedInt(raw, low, high, fallback) {
  const value = Math.floor(Number(raw));
  return Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;
}

/**
 * 把已通过 `Config` 校验的配置整理成运行时视图。
 *
 * @param {object} config - `Config(...)` 校验后的配置对象。
 * @param {string} defaultCwd - `config.cwd` 留空时用的工作目录（即 `process.cwd()`）。
 * @returns {object} 平铺的设置对象：schema 字段透传 + 下面这些再加工过的字段。
 */
export function createSettings(config, defaultCwd) {
  // —— 工作目录与路由 ——
  // 注意返回的是**未去空白**的 `config.cwd`（与旧行为一致）：只做「空不空」的判断。
  const cwd = config.cwd.trim().length > 0 ? config.cwd : defaultCwd;
  const provider = trimmed(config.provider);
  const model = trimmed(config.model);
  const agentPreset = trimmed(config.agentPreset);

  // —— 准入与文案 ——
  // 只有这两个列表原本就去重 + 去空白；`allowUsers` / `allowGroups` 是逐字比较的，
  // 不能顺手也 trim 一遍 —— 那会把「配了带空格的号」从「不匹配」变成「匹配」，是行为改动。
  const allowTools = deduped(config.allowTools);
  const resetUsers = deduped(config.resetUsers);
  const resetCommand = trimmed(config.resetCommand).toLowerCase();
  const persona = trimmed(config.persona);
  const instructions = trimmed(config.instructions);

  // —— 目录（只去空白；越界与否由 index.js 结合 cwd 判定并记 warn）——
  const stickerDir = trimmed(config.stickerDir);
  const memoryDir = trimmed(config.memoryDir);

  // —— 图片 / 表情包 ——
  const imageSend = config.imageSend !== false;
  const imageMaxBytes = Number.isFinite(config.imageMaxBytes) && config.imageMaxBytes > 0
    ? Math.floor(config.imageMaxBytes)
    : DEFAULT_IMAGE_MAX_BYTES;
  // 表情包张数上限：0 是**明确的不限制**，但非法值要退回默认的 60 —— 这里不能照抄
  // 别处 `Number(x) || 0` 的写法，那会把一次手滑（拼错的字段、字符串）变成最危险的那种值。
  const stickerMaxFilesRaw = Math.floor(Number(config.stickerMaxFiles));
  const stickerMaxFiles = Number.isFinite(stickerMaxFilesRaw) && stickerMaxFilesRaw >= 0 ? stickerMaxFilesRaw : 60;
  // 上限 0.3 是「同一套画风只换了字」的实测下限（16%~23%）留出的安全边距，见 perceptual.js。
  const repeatImageTolerance = Math.min(0.3, Math.max(0, Number(config.repeatImageTolerance) || 0));

  // —— 自动复读 ——
  const repeatWindowMs = Math.max(0, Math.floor(Number(config.repeatWindowMs) || 0));
  const repeatCount = Math.max(2, Math.floor(Number(config.repeatCount) || 0));
  const repeatChance = Math.min(1, Math.max(0, Number(config.repeatChance)));
  // `repeatMaxChars` 的 0 与「非法」同义（都是不限），所以直接把非法值并到 0。
  const repeatMaxCharsRaw = Math.floor(Number(config.repeatMaxChars));
  const repeatMaxChars = Number.isFinite(repeatMaxCharsRaw) ? repeatMaxCharsRaw : 0;

  // —— 攒批（0 = 关闭）——
  const batchWindowMsRaw = Math.floor(Number(config.batchWindowMs));
  const batchWindowMs = Number.isFinite(batchWindowMsRaw) && batchWindowMsRaw > 0 ? batchWindowMsRaw : 0;
  const batchMaxWaitMsRaw = Math.floor(Number(config.batchMaxWaitMs));
  const batchMaxWaitMs = Number.isFinite(batchMaxWaitMsRaw) && batchMaxWaitMsRaw > 0 ? batchMaxWaitMsRaw : 0;

  // —— 群聊环境上下文 ——
  const ambientMessages = Math.floor(Number(config.ambientMessages) || 0);
  const ambientLineChars = Math.max(1, Math.floor(Number(config.ambientLineChars) || 120));

  // —— 一条回复怎么发 ——
  const maxReplyChars = Number.isSafeInteger(config.maxReplyChars) && config.maxReplyChars > 0 ? config.maxReplyChars : 1500;
  const burstMaxChars = Number.isSafeInteger(config.burstMaxChars) && config.burstMaxChars > 0 ? config.burstMaxChars : 0;
  const burstMaxParts = Number.isFinite(config.burstMaxParts) ? Math.max(1, Math.floor(config.burstMaxParts)) : 3;
  const burstMaxMessages = Number.isFinite(config.burstMaxMessages) ? Math.max(0, Math.floor(config.burstMaxMessages)) : 0;
  const burstSingleMaxChars = Number.isFinite(config.burstSingleMaxChars) && config.burstSingleMaxChars > 0
    ? Math.floor(config.burstSingleMaxChars)
    : 0;
  const delayJitter = Math.min(1, Math.max(0, Number(config.delayJitter) || 0));

  // —— 人格与表达（文件路径只去空白，越界校验在 index.js）——
  const personaFile = trimmed(config.personaFile);
  const personaMaxChars = Math.max(200, Math.floor(Number(config.personaMaxChars) || 0) || 4000);
  const personaSceneOverlays = config.personaSceneOverlays !== false;
  const styleFile = trimmed(config.styleFile);
  const styleMaxChars = Math.max(200, Math.floor(Number(config.styleMaxChars) || 0) || 2000);
  const bubbleGamble = config.bubbleGamble !== false;
  // 概率三项：夹到 0~1，NaN 保持 NaN（与 activeTalkChance 同口径：NaN 进判据时 `roll < NaN`
  // 恒假 = 不追加第二个气泡，是比「按随机数乱来」更安全的失败方向）。
  const bubbleContinueChance = Math.min(1, Math.max(0, Number(config.bubbleContinueChance)));
  const bubbleContinueDecay = Math.min(1, Math.max(0, Number(config.bubbleContinueDecay)));
  const bubbleGambleMaxChars = Math.max(0, Math.floor(Number(config.bubbleGambleMaxChars) || 0));
  const bubbleChatMax = Math.max(1, Math.floor(Number(config.bubbleChatMax) || 0) || 3);
  const stripShortPeriod = config.stripShortPeriod !== false;
  const shortPeriodMaxChars = Math.max(1, Math.floor(Number(config.shortPeriodMaxChars) || 0) || 40);
  const interjectQuote = config.interjectQuote !== false;
  const privateAfterthought = config.privateAfterthought !== false;
  const privateAfterthoughtChance = Math.min(1, Math.max(0, Number(config.privateAfterthoughtChance)));
  const privateAfterthoughtIdleMs = msOf(config.privateAfterthoughtIdleMs, 15000);
  const privateAfterthoughtDailyMax = msOf(config.privateAfterthoughtDailyMax, 10);

  // —— 感知与互动 ——
  const linkPreview = config.linkPreview === true;
  const linkPreviewTimeoutMs = Math.max(1000, Math.floor(Number(config.linkPreviewTimeoutMs) || 0) || 8000);
  const linkPreviewMaxBytes = Math.max(1024, Math.floor(Number(config.linkPreviewMaxBytes) || 0) || 524288);
  const linkAllowPrivateHosts = config.linkAllowPrivateHosts === true;
  const videoCover = config.videoCover !== false;
  // 0 是**明确的不下载**（默认），非法值也并到 0：视频整段下载本来就不该随手打开。
  const videoMaxBytes = Math.max(0, Math.floor(Number(config.videoMaxBytes) || 0));
  const pokeReply = config.pokeReply !== false;
  const pokeReplyChance = Math.min(1, Math.max(0, Number(config.pokeReplyChance)));
  const pokeCooldownMs = msOf(config.pokeCooldownMs, 30000);
  const pokeDailyMax = msOf(config.pokeDailyMax, 20);
  // 撤回：概率夹到 0~1（NaN 保持 NaN —— `recallAction` 里 `roll < NaN` 恒假 = 不补一句，
  // 比「按一个莫名其妙的概率乱开口」安全）；其余三项是毫秒/次数，负数按 0 算（= 不限）。
  const recallChance = Math.min(1, Math.max(0, Number(config.recallChance)));
  const recallCooldownMs = msOf(config.recallCooldownMs, 60000);
  const recallDailyMax = msOf(config.recallDailyMax, 5);
  const recallMaxAgeMs = msOf(config.recallMaxAgeMs, 120000);

  // —— 主动说话 ——
  const proactiveIdleMs = msOf(config.proactiveIdleMs, 45 * 60 * 1000);
  const proactiveFreshMs = msOf(config.proactiveFreshMs, 24 * 60 * 60 * 1000);
  const proactiveGapMs = msOf(config.proactiveGapMs, 2 * 60 * 60 * 1000);
  const proactiveCheckMs = Math.min(MAX_TIMER_MS, Math.max(1000, msOf(config.proactiveCheckMs, 10 * 60 * 1000)));
  const proactiveDailyMax = (() => {
    const value = Math.floor(Number(config.proactiveDailyMax));
    return Number.isFinite(value) ? Math.max(0, value) : 4;
  })();
  // 这两个**不做夹紧**：`withinActiveHours` 自己会把非法值/越界值归一化（NaN → 0 与 23），
  // 而「NaN 的 to」要退化成 23（全天）而不是 0 —— 在这里夹紧会把它变成「全天等价」以外的
  // 另一件事（start === end），所以原样留着，由那个纯函数负责语义。
  const proactiveFromHour = Number(config.proactiveFromHour);
  const proactiveToHour = Number(config.proactiveToHour);
  const proactiveChance = Math.min(1, Math.max(0, Number(config.proactiveChance)));

  // —— 活跃对话（免 @ 接话 / 补一句 / 多人搭话）——
  const activeWindowMs = msOf(config.activeWindowMs, 60 * 1000);
  const activeMaxTurns = msOf(config.activeMaxTurns, 10);
  // 抽卡概率三项都夹到 0~1；NaN 保持 NaN（与 proactiveChance 同口径）。NaN 进到判据里
  // 会让 `roll < chance` 恒假 = 一句都不接 —— 这是比「按一个莫名其妙的概率乱接」更安全
  // 的失败方向，所以这里刻意不退回默认值。
  const activeTalkChance = Math.min(1, Math.max(0, Number(config.activeTalkChance)));
  const activeTalkChanceStep = Math.min(1, Math.max(0, Number(config.activeTalkChanceStep)));
  const activeTalkChanceMax = Math.min(1, Math.max(0, Number(config.activeTalkChanceMax)));
  const activeGroupLines = msOf(config.activeGroupLines, 6);
  const activeGroupSpeakers = msOf(config.activeGroupSpeakers, 2);
  const activeChimeIdleMs = msOf(config.activeChimeIdleMs, 20 * 1000);
  const activeChimeMax = msOf(config.activeChimeMax, 1);
  const activeChimeDailyMax = msOf(config.activeChimeDailyMax, 12);
  const activeGroupBatchScale = (() => {
    const value = Number(config.activeGroupBatchScale);
    return Number.isFinite(value) && value > 1 ? value : 1;
  })();

  // —— 定时提醒（见 reminders.js）——
  // 额度三项的 0 都是「明确的不限」，但非法值要退回默认 —— 不能把一次手滑变成无上限。
  const reminder = config.reminder !== false;
  const reminderFile = trimmed(config.reminderFile);
  const reminderUsers = deduped(config.reminderUsers);
  const reminderMentionOthers = config.reminderMentionOthers === true;
  const reminderAllowAll = config.reminderAllowAll === true;
  const reminderDailyMaxRaw = Math.floor(Number(config.reminderDailyMax));
  const reminderDailyMax = Number.isFinite(reminderDailyMaxRaw) && reminderDailyMaxRaw >= 0 ? reminderDailyMaxRaw : 5;
  const reminderMaxActiveRaw = Math.floor(Number(config.reminderMaxActive));
  const reminderMaxActive = Number.isFinite(reminderMaxActiveRaw) && reminderMaxActiveRaw >= 1 ? reminderMaxActiveRaw : 20;
  const reminderGraceMs = msOf(config.reminderGraceMs, 10 * 60 * 1000);
  // 模式是枚举：非法值退回默认的 agent（而不是 text）—— text 会把用户已经习惯的
  // agent 提醒静默降级；而 prompt 不该因为一次手滑就被打开。
  const reminderModes = ['text', 'agent', 'prompt'].includes(config.reminderModes) ? config.reminderModes : 'agent';
  const reminderAgentTimeoutMs = Math.max(5000, Math.floor(Number(config.reminderAgentTimeoutMs) || 0) || 120000);
  const reminderAgentDailyMaxRaw = Math.floor(Number(config.reminderAgentDailyMax));
  const reminderAgentDailyMax = Number.isFinite(reminderAgentDailyMaxRaw) && reminderAgentDailyMaxRaw >= 0 ? reminderAgentDailyMaxRaw : 20;

  // —— 长期记忆 ——
  const memoryOn = config.memory !== false;
  const memorySearchHits = Math.max(1, Math.floor(Number(config.memorySearchHits) || 40));
  const memoryFileMaxBytes = Math.max(256, Math.floor(Number(config.memoryFileMaxBytes) || 0));
  const digestAtHour = clampedInt(config.digestAtHour, 0, 23, 4);
  const digestMinLines = Math.max(1, Math.floor(Number(config.digestMinLines) || 1));
  const digestMaxChars = Math.max(1000, Math.floor(Number(config.digestMaxChars) || 0));
  const digestTimeoutMs = Math.max(1000, Math.floor(Number(config.digestTimeoutMs) || 0));

  // —— 每天轮换模型凭据 ——
  const apiKeyRotateHour = clampedInt(config.apiKeyRotateHour, 0, 23, 4);
  const apiKeyRef = trimmed(config.apiKeyRef);
  const apiKeyFile = trimmed(config.apiKeyFile);
  const apiKeyProbeUrl = trimmed(config.apiKeyProbeUrl);
  const apiKeyProbeTimeoutMs = (() => {
    const value = Math.floor(Number(config.apiKeyProbeTimeoutMs));
    return Number.isFinite(value) && value >= 1000 ? value : 15000;
  })();

  return {
    // schema 里已经是对的类型、也没有再加工余地的字段直接透传（`approvalPolicy`、
    // `groupChat`、`replyStyle`、`media*` 的其余项等等）。
    ...config,
    cwd,
    provider,
    model,
    agentPreset,
    allowTools,
    resetUsers,
    resetCommand,
    persona,
    instructions,
    stickerDir,
    memoryDir,
    imageSend,
    imageMaxBytes,
    stickerMaxFiles,
    repeatImageTolerance,
    repeatWindowMs,
    repeatCount,
    repeatChance,
    repeatMaxChars,
    batchWindowMs,
    batchMaxWaitMs,
    ambientMessages,
    ambientLineChars,
    maxReplyChars,
    burstMaxChars,
    burstMaxParts,
    burstMaxMessages,
    burstSingleMaxChars,
    delayJitter,
    personaFile,
    personaMaxChars,
    personaSceneOverlays,
    styleFile,
    styleMaxChars,
    bubbleGamble,
    bubbleContinueChance,
    bubbleContinueDecay,
    bubbleGambleMaxChars,
    bubbleChatMax,
    stripShortPeriod,
    shortPeriodMaxChars,
    interjectQuote,
    privateAfterthought,
    privateAfterthoughtChance,
    privateAfterthoughtIdleMs,
    privateAfterthoughtDailyMax,
    linkPreview,
    linkPreviewTimeoutMs,
    linkPreviewMaxBytes,
    linkAllowPrivateHosts,
    videoCover,
    videoMaxBytes,
    pokeReply,
    pokeReplyChance,
    pokeCooldownMs,
    pokeDailyMax,
    recallChance,
    recallCooldownMs,
    recallDailyMax,
    recallMaxAgeMs,
    proactiveIdleMs,
    proactiveFreshMs,
    proactiveGapMs,
    proactiveCheckMs,
    proactiveDailyMax,
    proactiveFromHour,
    proactiveToHour,
    proactiveChance,
    activeWindowMs,
    activeMaxTurns,
    activeTalkChance,
    activeTalkChanceStep,
    activeTalkChanceMax,
    activeGroupLines,
    activeGroupSpeakers,
    activeChimeIdleMs,
    activeChimeMax,
    activeChimeDailyMax,
    activeGroupBatchScale,
    reminder,
    reminderFile,
    reminderUsers,
    reminderMentionOthers,
    reminderAllowAll,
    reminderDailyMax,
    reminderMaxActive,
    reminderGraceMs,
    reminderModes,
    reminderAgentTimeoutMs,
    reminderAgentDailyMax,
    memoryOn,
    memorySearchHits,
    memoryFileMaxBytes,
    digestAtHour,
    digestMinLines,
    digestMaxChars,
    digestTimeoutMs,
    apiKeyRotateHour,
    apiKeyRef,
    apiKeyFile,
    apiKeyProbeUrl,
    apiKeyProbeTimeoutMs,
  };
}
