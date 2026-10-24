/**
 * 静默模式（mute）的纯函数：唤醒词匹配 + 落盘状态的解析与序列化。
 *
 * 与最初「插件按关键词判睡」的设计不同，**入睡由模型主动调用 `qq_quiet` 决定**：
 * 主人说「睡觉去 / 静默 / 别说话了」这类意思时，模型（最懂语义的那一层）调用
 * `qq_quiet(action: 'sleep')`，插件只负责执行「以后这个群的消息在入口就丢掉」。
 * 这样不会因为一句「我去睡觉了」把机器人误按停，也不要求部署者维护一份触发词表。
 *
 * 这里保留的**唤醒词**是唯一的插件侧旁路：睡着之后群里的消息根本到不了模型，
 * 所以「起床」必须由插件直接识别（只认主人，且不经过模型、零 token），否则就只能
 * 去私聊里叫它 —— 那是备用通道，不是唯一通道。
 *
 * 三条边界：
 *
 *   1. **只认短句**：唤醒词之外的话一律不当命令；有人问「你几点起床」不该把它叫醒。
 *   2. **只有主人能唤醒**：QQ 消息是不可信输入，群里任何人都能喊一句「起床」就等于
 *      谁都能把它从静默里拽出来。主人由 QQ 号确定（见 index.js 的 owner 解析）。
 *   3. **私聊永远不静默**：私聊是控制通道。`global` 只覆盖群聊，否则主人睡着之后
 *      连让它醒来的那条消息都投不进去。
 *
 * @module @qqbot/dsh-plugin-qq/mute
 */

/** 默认的「起床」词。只对主人、且整句很短时生效。 */
export const DEFAULT_WAKE_TRIGGERS = ['起床', '醒醒', '醒来', '别睡了', '重启'];

/** 唤醒词的长度上限（去掉空白后）：超过就当成普通聊天，不改变静默状态。 */
export const WAKE_MAX_CHARS = 24;

/**
 * 归一化一句候选命令：去掉空白（含全角空格）、首尾标点、转小写。
 * @param {unknown} text - 原始正文。
 * @returns {string} 归一化后的正文。
 */
export function normalizeCommandText(text) {
  return String(text ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/^[，。！？、,.!?~～…：:；;]+/u, '')
    .replace(/[，。！？、,.!?~～…：:；;]+$/u, '')
    .toLowerCase();
}

/**
 * 在一组触发词里找第一个命中的（包含即命中）。
 * @param {unknown} text - 正文。
 * @param {string[]} triggers - 触发词。
 * @returns {string | undefined} 命中的那个触发词（原始写法）。
 */
export function matchTrigger(text, triggers) {
  const normalized = normalizeCommandText(text);
  if (normalized.length === 0) return undefined;
  for (const trigger of Array.isArray(triggers) ? triggers : []) {
    const needle = normalizeCommandText(trigger);
    if (needle.length > 0 && normalized.includes(needle)) return trigger;
  }
  return undefined;
}

/**
 * 判一条消息是不是「起床」。
 *
 * 只认**以唤醒词开头**的短句（允许前面带一个称呼：`小助手起床了` / `小助手醒醒`）。
 * 这样「你一般几点起床」不会被当成叫醒 —— 它在问问题，不是在喊它。
 *
 * @param {unknown} text - 已剥掉 @ / 前缀的正文。
 * @param {object} [options]
 * @param {string[]} [options.wakeTriggers] - 唤醒词表。
 * @param {string[]} [options.prefixes] - 允许出现在唤醒词前的称呼（`小助手` / `小助手` / 配置的 prefix）。
 * @returns {string | undefined} 命中的唤醒词；不是唤醒命令时 undefined。
 */
export function matchWakeCommand(text, options = {}) {
  const normalized = normalizeCommandText(text);
  if (normalized.length === 0 || normalized.length > WAKE_MAX_CHARS) return undefined;
  const triggers = Array.isArray(options.wakeTriggers) ? options.wakeTriggers : DEFAULT_WAKE_TRIGGERS;
  const prefixes = (Array.isArray(options.prefixes) ? options.prefixes : [])
    .map((prefix) => normalizeCommandText(prefix))
    .filter((prefix) => prefix.length > 0);
  for (const trigger of triggers) {
    const needle = normalizeCommandText(trigger);
    if (needle.length === 0) continue;
    if (normalized.startsWith(needle)) return trigger;
    for (const prefix of prefixes) {
      if (normalized.startsWith(prefix) && normalized.slice(prefix.length).startsWith(needle)) return trigger;
    }
  }
  return undefined;
}

/** 会话 key 的合法形状：`group:<群号>` / `private:<QQ号>`。 */
const KEY_PATTERN = /^(?:group|private):[^\s:]+$/;

/**
 * 把磁盘上的静默状态解析成内存形状（坏数据一律当「没有静默」）。
 *
 * 静默是**安全侧**的状态：文件写坏时退回「醒着」而不是「全静默」—— 一个坏掉的 JSON
 * 不应该让机器人从此在群里一句话都不说，且没人记得为什么。
 * @param {unknown} raw - `JSON.parse` 之后的对象。
 * @returns {{ global: boolean, keys: string[], at: number, by: string }}
 */
export function parseMuteState(raw) {
  const state = { global: false, keys: [], at: 0, by: '' };
  if (raw === null || typeof raw !== 'object') return state;
  state.global = raw.global === true;
  state.at = Number.isFinite(Number(raw.at)) ? Math.max(0, Number(raw.at)) : 0;
  state.by = typeof raw.by === 'string' ? raw.by : '';
  const keys = Array.isArray(raw.keys) ? raw.keys : [];
  // 只有群聊可以被单独静默：私聊是控制通道，写进来也不认。
  state.keys = [...new Set(
    keys
      .map((key) => String(key ?? ''))
      .filter((key) => KEY_PATTERN.test(key) && key.startsWith('group:')),
  )];
  return state;
}

/**
 * 把内存状态序列化成落盘形状。
 * @param {{ global: boolean, keys: Iterable<string>, at: number, by: string }} state - 内存状态。
 * @returns {{ version: number, global: boolean, keys: string[], at: number, by: string }}
 */
export function serializeMuteState(state) {
  return {
    version: 1,
    global: state?.global === true,
    keys: [...(state?.keys ?? [])]
      .map((key) => String(key))
      .filter((key) => KEY_PATTERN.test(key) && key.startsWith('group:'))
      .sort(),
    at: Number.isFinite(Number(state?.at)) ? Math.max(0, Number(state.at)) : 0,
    by: typeof state?.by === 'string' ? state.by : '',
  };
}
