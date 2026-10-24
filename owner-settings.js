/**
 * 主人设置覆盖层：`qq_settings` 工具、`设置` 指令与「直接改一个 JSON 文件」共用同一份数据。
 *
 * 为什么不直接改写 profile 的 `cordis.patch.yml`：那份文件是**整块替换**语义，里面还有
 * `!!js process.env…` 表达式（endpoint / cwd / resetUsers）。从插件里安全地重写它需要
 * 一个能保留那些表达式的 YAML 序列化器，而插件是零依赖的 —— 一旦序列化错一处，重启
 * 之后连接直接断掉。相比之下，一个**只含白名单键**的 JSON 覆盖层：
 *
 *   - 不会碰连接 / 路径 / 凭据这些部署级字段；
 *   - 主人可以直接用记事本改（GUI 里改的是基础值，覆盖层优先）；
 *   - 删掉一个键（或 `qq_settings unset` / `设置 clear`）就回到 GUI 配置。
 *
 * 生效方式是**插件重启**（`ctx.fiber.restart()`）：`createSettings` 在 `apply()` 里跑
 * 一次，热改一个字段不会重跑它。重启不断进程，QQ 会话 id 是确定性的，下一条消息照样
 * resume 出同一个 Session。
 *
 * @module @qqbot/dsh-plugin-qq/owner-settings
 */

/**
 * 核心字段的显式规格：类型 / 取值范围 / 人话说明。
 *
 * 其余**行为类**字段走 `EXTRA_WRITABLE_KEYS` + 按当前值推断类型（bool / number /
 * string / string[]），这样加一个配置项不必回来补一份 spec。部署级字段（连接、目录、
 * 凭据、白名单、模型路由）永远不在可写名单里。
 */
export const OWNER_SETTING_KEYS = {
  groupTrigger: { type: 'enum', values: ['mention', 'prefix', 'all'], description: '群消息触发方式' },
  prefix: { type: 'string', description: 'groupTrigger=prefix 时的唤醒词' },
  resetCommand: { type: 'string', description: '新开一轮会话的指令（空 = 禁用）' },
  commands: { type: 'boolean', description: '是否启用 @bot 指令路由' },
  guestCommands: { type: 'boolean', description: '是否允许访客使用公开指令' },
  tts: { type: 'boolean', description: '是否启用语音（需要先在 tts.js 注册 provider）' },
  ttsMaxChars: { type: 'number', integer: true, min: 1, max: 1000, description: '一次语音最多多少字' },
  proactive: { type: 'boolean', description: '冷场时是否主动说话' },
  activeFollow: { type: 'boolean', description: '活跃对话里是否免 @ 接话' },
  activeChimeMax: { type: 'number', integer: true, min: 0, max: 100, description: '回完话后最多补几句' },
  activeChimeIdleMs: { type: 'number', integer: true, min: 0, max: 86_400_000, description: '补一句前等多久（毫秒）' },
  batchWindowMs: { type: 'number', integer: true, min: 0, max: 600_000, description: '攒批窗口（毫秒）' },
  batchMaxWaitMs: { type: 'number', integer: true, min: 0, max: 600_000, description: '一批最多等多久（毫秒）' },
  ambientMessages: { type: 'number', integer: true, min: 0, max: 200, description: '每轮注入的群聊上下文条数' },
  ambientLineChars: { type: 'number', integer: true, min: 1, max: 2000, description: '群聊上下文每条最多多少字' },
  humanize: { type: 'boolean', description: '是否拆条 + 打字延迟' },
  replyStyle: { type: 'enum', values: ['auto', 'plain', 'quote', 'at'], description: '群聊回复的指向方式' },
  memory: { type: 'boolean', description: '是否启用长期记忆' },
  digestMinLines: { type: 'number', integer: true, min: 1, max: 1000, description: '摘要前至少攒多少条新消息' },
  repeat: { type: 'boolean', description: '是否自动复读' },
  pokeReply: { type: 'boolean', description: '被戳一戳是否回应' },
  imageSend: { type: 'boolean', description: '是否允许主动发图 / 表情包' },
  mutePersist: { type: 'boolean', description: '静默状态是否落盘' },
  trustedWrite: { type: 'boolean', description: '是否注册受信写盘工具' },
  writeMaxBytes: { type: 'number', integer: true, min: 1024, max: 1_048_576, description: '受信写盘单文件字节上限' },
};

/**
 * 额外可写的行为字段（类型按当前值推断）。
 *
 * 刻意**不含**：endpoint / accessToken / cwd / 各类目录 / provider / model / agentPreset /
 * approvalPolicy / allowTools / resetUsers / allowUsers / allowGroups / apiKey* / persona /
 * instructions —— 这些是部署级、安全或整段提示词字段，改错的代价远大于方便。
 */
export const EXTRA_WRITABLE_KEYS = [
  'privateChat', 'groupChat', 'blankReply', 'maxReplyChars',
  'mediaDownload', 'mediaMaxBytes', 'mediaCacheFiles', 'mediaTimeoutMs', 'quoteMedia', 'ambientMedia',
  'imageMaxBytes', 'stickerMaxFiles',
  'linkPreview', 'linkPreviewTimeoutMs', 'linkPreviewMaxBytes', 'linkAllowPrivateHosts', 'videoCover', 'videoMaxBytes',
  'pokeMode', 'pokeReplyChance', 'pokeCooldownMs', 'pokeDailyMax',
  'recallMode', 'recallAddressed', 'recallScope', 'recallChance', 'recallCooldownMs', 'recallDailyMax',
  'recallMaxAgeMs', 'recallTeaseQuote', 'recallPrivate', 'recallMemoryMark',
  'batchBacklog', 'batchBacklogEntries', 'batchBacklogChars', 'batchBacklogHoldMs', 'mediaHoldMs',
  'repeatMedia', 'repeatCount', 'repeatDistinct', 'repeatWindowMs', 'repeatMaxChars', 'repeatChance', 'repeatImageTolerance',
  'proactiveCheckMs', 'proactiveChance', 'proactiveIdleMs', 'proactiveFreshMs', 'proactiveGapMs',
  'proactiveDailyMax', 'proactiveFromHour', 'proactiveToHour',
  'activeWindowMs', 'activeMaxTurns', 'activeTalkChance', 'activeTalkChanceStep', 'activeTalkChanceMax',
  'activeGroupLines', 'activeGroupSpeakers', 'activeGroupBatchScale',
  'activeChimeDailyMax',
  'reminder', 'reminderMentionOthers', 'reminderAllowAll', 'reminderDailyMax', 'reminderMaxActive',
  'reminderGraceMs', 'reminderModes', 'reminderAgentTimeoutMs', 'reminderAgentDailyMax',
  'burstMaxChars', 'burstMaxParts', 'burstMaxMessages', 'burstSingleMaxChars',
  'readDelayMs', 'charsPerSecond', 'minDelayMs', 'maxDelayMs', 'delayJitter',
  'personaMaxChars', 'personaSceneOverlays', 'styleMaxChars', 'stripShortPeriod', 'shortPeriodMaxChars',
  'privateAfterthought', 'privateAfterthoughtChance', 'privateAfterthoughtIdleMs', 'privateAfterthoughtDailyMax',
  'memoryPromptChars', 'memoryRecallK', 'memoryPeopleMax', 'memoryArchive', 'memoryArchiveRatio',
  'memoryVocabHint', 'memorySearchHits', 'digestAtHour', 'digestMaxChars', 'digestTimeoutMs',
  'digestCatchUp', 'digestRollover', 'digestConsolidate',
  'wakeTriggers', 'wakeText',
];

const WRITABLE = new Set([...Object.keys(OWNER_SETTING_KEYS), ...EXTRA_WRITABLE_KEYS]);

/** 枚举字段的合法取值（不在表里的字符串按自由文本处理）。 */
const ENUM_VALUES = {
  groupTrigger: ['mention', 'prefix', 'all'],
  replyStyle: ['auto', 'plain', 'quote', 'at'],
  pokeMode: ['random', 'poke', 'text', 'ignore'],
  recallMode: ['off', 'ignore', 'tease'],
  recallAddressed: ['answer', 'drop'],
  recallScope: ['to-me', 'all'],
  reminderModes: ['text', 'agent', 'prompt'],
};

/** 逗号/顿号分隔的列表字段。 */
const LIST_KEYS = new Set(['wakeTriggers']);

/** 布尔值的可接受写法（QQ 里主人经常写「开 / 关」）。 */
const TRUE_WORDS = new Set(['true', '1', 'yes', 'on', '开', '是', '启用', '打开']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off', '关', '否', '禁用', '关闭']);

/** 这个键能不能从 QQ 侧改。 */
export function isWritableKey(key) {
  return WRITABLE.has(String(key ?? ''));
}

/**
 * 字段类型（用于设置页 / 指令展示）：core 用 spec，其余按当前值推断。
 * @param {string} key
 * @param {unknown} current
 * @returns {'boolean' | 'number' | 'enum' | 'list' | 'string'}
 */
export function settingKind(key, current) {
  const spec = OWNER_SETTING_KEYS[key];
  if (spec !== undefined) {
    if (spec.type === 'enum') return 'enum';
    return spec.type;
  }
  if (Array.isArray(current)) return 'list';
  if (typeof current === 'boolean') return 'boolean';
  if (typeof current === 'number') return 'number';
  if (ENUM_VALUES[key] !== undefined) return 'enum';
  return 'string';
}

/**
 * 把一个原始值转成配置值；不合法时抛错（不静默忽略）。
 * @param {string} key - 配置键（必须在可写名单里）。
 * @param {unknown} raw - 工具参数 / JSON / 指令里的原始值。
 * @param {unknown} [current] - 当前生效值（额外字段按它的类型推断）。
 * @returns {string | number | boolean | string[]}
 */
export function coerceOwnerSetting(key, raw, current) {
  if (!isWritableKey(key)) {
    throw new Error(`「${key}」不在可调整名单里（用「设置」看可调项；部署项只能改配置文件）`);
  }
  const spec = OWNER_SETTING_KEYS[key];
  if (spec !== undefined) {
    if (spec.type === 'boolean') return coerceBoolean(key, raw);
    if (spec.type === 'number') return coerceNumber(key, raw, spec.integer, spec.min, spec.max);
    if (spec.type === 'enum') return coerceEnum(key, raw, spec.values);
    return String(raw ?? '').trim();
  }
  if (LIST_KEYS.has(key) || Array.isArray(current)) {
    const text = String(raw ?? '').trim();
    const items = text.split(/[,，、]+/u).map((item) => item.trim()).filter((item) => item.length > 0);
    if (items.length === 0) throw new Error(`「${key}」要一个非空列表（逗号分隔）`);
    return items;
  }
  if (ENUM_VALUES[key] !== undefined) return coerceEnum(key, raw, ENUM_VALUES[key]);
  if (typeof current === 'boolean') return coerceBoolean(key, raw);
  if (typeof current === 'number') return coerceNumber(key, raw, Number.isInteger(current));
  return String(raw ?? '').trim();
}

function coerceBoolean(key, raw) {
  if (typeof raw === 'boolean') return raw;
  const text = String(raw ?? '').trim().toLowerCase();
  if (TRUE_WORDS.has(text)) return true;
  if (FALSE_WORDS.has(text)) return false;
  throw new Error(`「${key}」要布尔值（true / false / 开 / 关）`);
}

function coerceNumber(key, raw, integer, min, max) {
  const value = Number(String(raw ?? '').trim());
  if (!Number.isFinite(value)) throw new Error(`「${key}」要一个数字`);
  let rounded = integer === true ? Math.floor(value) : value;
  // 概率 / 比例类一律夹在 0~1；小时夹在 0~23；其余只挡明显不合法的负数。
  if (/Chance$|Ratio$|Tolerance$/.test(key)) rounded = Math.min(1, Math.max(0, rounded));
  else if (/Hour$/.test(key)) rounded = Math.min(23, Math.max(0, rounded));
  else if (rounded < 0) throw new Error(`「${key}」不能是负数`);
  if (min !== undefined && rounded < min) throw new Error(`「${key}」不能小于 ${min}`);
  if (max !== undefined && rounded > max) throw new Error(`「${key}」不能大于 ${max}`);
  return rounded;
}

function coerceEnum(key, raw, values) {
  const text = String(raw ?? '').trim();
  if (!values.includes(text)) {
    throw new Error(`「${key}」只能是 ${values.map((value) => (value === '' ? '空' : value)).join(' / ')}`);
  }
  return text;
}

/**
 * 解析覆盖层文件：只留可写键；核心字段当场校验，额外字段留着原值等 `apply` 时按当前类型转。
 * @param {unknown} raw - 文件里的 JSON。
 * @param {(level: string, message: string) => void} [report]
 * @returns {{ values: Record<string, unknown> }}
 */
export function parseOwnerSettings(raw, report = () => {}) {
  const values = {};
  if (raw === null || typeof raw !== 'object') return { values };
  const source = raw.values !== null && typeof raw.values === 'object' ? raw.values : raw;
  for (const [key, value] of Object.entries(source)) {
    if (key === 'version') continue;
    if (!isWritableKey(key)) {
      report('warn', `owner settings: ignoring non-writable key "${key}"`);
      continue;
    }
    const spec = OWNER_SETTING_KEYS[key];
    if (spec === undefined) {
      values[key] = value;
      continue;
    }
    try {
      values[key] = coerceOwnerSetting(key, value);
    } catch (error) {
      report('warn', `owner settings: dropping "${key}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { values };
}

/**
 * 把覆盖层合并到已经归一化过的 settings 快照上（返回新对象，不改入参）。
 * @param {object} settings - `createSettings()` 的结果。
 * @param {Record<string, unknown>} values - 覆盖值（可含原始 JSON 值）。
 * @param {(level: string, message: string) => void} [report]
 * @returns {{ settings: object, applied: string[], rejected: Array<{ key: string, reason: string }> }}
 */
export function applyOwnerSettings(settings, values, report = () => {}) {
  const next = { ...settings };
  const applied = [];
  const rejected = [];
  for (const [key, raw] of Object.entries(values ?? {})) {
    if (!isWritableKey(key)) continue;
    try {
      next[key] = coerceOwnerSetting(key, raw, settings[key]);
      applied.push(key);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      rejected.push({ key, reason });
      report('warn', `owner settings: dropping "${key}": ${reason}`);
    }
  }
  // 派生开关跟着覆盖层走：`memoryOn` 是 memory.js 的开关名。
  if (next.memory !== undefined) next.memoryOn = next.memory !== false;
  return { settings: next, applied, rejected };
}
