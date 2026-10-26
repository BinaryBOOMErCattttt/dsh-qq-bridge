/**
 * 运行模式：完整 / 简洁 / 斗图。
 *
 * 这里只放**纯函数与常量**（同样输入永远同样输出，可以脱离 Harness 单测）；会话重建、
 * 落盘与全局状态在 `index.js`（`appMode` / `switchMode` / `modeContextText`）。
 *
 * 为什么简洁模式是一张**固定集合**而不是一堆布尔开关：简洁模式的卖点是「切过去就安静」，
 * 让用户再逐项配一遍就失去意义了。完整模式里的 `module*` 是另一件事 —— 那是一组可以
 * 单独关掉的功能片；简洁模式直接忽略它们，只认下面的 `SIMPLE_MODULES`。
 *
 * 斗图（sticker）模式不是「更简洁」或「更完整」：它改的是**发表情的门控**（常驻、不受
 * 心情限制、每轮都要看到目录）。工具面与完整模式一样用部署白名单，所以它不参与
 * `toolsForMode` 的收窄。
 *
 * @module @qqbot/dsh-plugin-qq/mode
 */

/** 当前支持的模式值（落盘在 `cwd/data/mode.json`）。 */
export const MODES = ['full', 'simple', 'sticker'];

/**
 * 简洁模式放行的指令。
 *
 * `模式` 自己必须在里面 —— 否则切进简洁模式之后就再也切不回来了。
 * `推理强度` 还没搬过来，留在列表里是**策略**而不是实现：名字不在指令登记表里就永远
 * 不会命中，等那一天搬过来时不必再回来改这一行。
 */
export const SIMPLE_ALLOWED_COMMANDS = new Set(['模式', '状态', '设置', '记忆', '定档', '推理强度']);

/**
 * 简洁模式仍然算「核心」的模块。
 *
 * 完整模式读配置里的 `module*`，简洁模式只认这个集合 —— 这就是「简洁模式强制关掉
 * 非核心模块」的落点。心情 / 表情门控在简洁模式里仍然**开着**（快照口径）：简洁模式
 * 收窄的是能力面与主动性，不是「连一张表情都不许发」；它的门控口径与完整模式一致。
 */
export const SIMPLE_MODULES = new Set(['handoff', 'emojiMood']);

/**
 * 指令 → 所属模块。模块关掉时整条指令直接不可用（在 `runCommand` 里统一拦）。
 *
 * 只收**已经搬进本仓库**的指令；`debug` / `overdebug`（调试分片）等落地后再补。
 * 一条指令只归一个模块：它能被关掉的理由应当只有一个，否则「关了却还能用」很难解释。
 */
export const COMMAND_MODULES = {
  抽签: 'fun', 吃饭: 'fun', 饭量: 'fun', 敲木鱼: 'fun', 骰子: 'fun', 抛硬币: 'fun',
  随机点名: 'fun', 点歌: 'fun', 接一个: 'fun', 投票: 'fun', 关注: 'fun', 取消关注: 'fun',
  关注列表: 'fun', 纪念日: 'fun', 纪念日列表: 'fun', 别复读: 'fun', 可以复读: 'fun',
  存表情: 'fun', 表情: 'fun',
  天气: 'lookup', 余额: 'lookup', 群热度: 'lookup', 随机表情: 'lookup',
  提醒: 'reminders', 语音: 'tts', 定档: 'handoff',
};

/**
 * 简洁模式只挂这些工具：聊天 / 记忆 / 静默 / 设置需要的那几格。
 *
 * 与完整模式一样，白名单只能**收窄**：基础白名单为空（= 部署明确说不限制）时才展开
 * 成这一份；非空时取交集。`qq_time` / `qq_topic` 等工具还没搬，等对应分片落地再补。
 */
export const SIMPLE_TOOL_SET = new Set([
  'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'skill',
  'qq_memory', 'qq_transcript', 'qq_quiet', 'qq_settings',
]);

/**
 * 模式的中文名（日志 / 回复 / `状态` 指令共用）。
 * @param {string} mode - `full` / `simple` / `sticker`。
 * @returns {string} 完整 / 简洁 / 斗图。
 */
export function modeLabel(mode) {
  if (mode === 'simple') return '简洁';
  if (mode === 'sticker') return '斗图';
  return '完整';
}

/**
 * 解析 `模式 <参数>`：中文与英文别名都认，大小写不敏感。
 *
 * 「表情包」也算斗图的别名：用户更容易这么叫它，而模式值本身必须保持 `sticker`
 * （落盘 / 代码里都用英文，别把中文塞进 `mode.json`）。
 * @param {unknown} raw - 指令参数。
 * @returns {'full' | 'simple' | 'sticker' | undefined} 认不出来时 undefined（调用方回用法提示）。
 */
export function parseModeArg(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (/^(简洁|simple)$/u.test(text)) return 'simple';
  if (/^(斗图|sticker|表情包)$/u.test(text)) return 'sticker';
  if (/^(完整|full)$/u.test(text)) return 'full';
  return undefined;
}

/**
 * 这个模式下实际能用的工具白名单。
 *
 * 返回新数组（或原数组）都不改入参：调用方 `index.js` 会把结果**原地灌进**模块们
 * 共享的那个数组里，所以这里绝不能顺手 `push` / `splice` 基础白名单。
 * @param {string[]} baseTools - 部署配置的完整白名单；空数组 = 不限制。
 * @param {string} mode - 当前模式。
 * @returns {string[]} 当前模式下的白名单。
 */
export function toolsForMode(baseTools, mode) {
  if (mode !== 'simple') return baseTools;
  if (baseTools.length === 0) return [...SIMPLE_TOOL_SET];
  return baseTools.filter((name) => SIMPLE_TOOL_SET.has(name));
}
