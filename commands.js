/**
 * QQ 侧指令的**纯声明与解析**：`@bot + 空格 + 指令`；私聊直接发指令（不需要 @）。
 *
 * 为什么指令要在插件里先判一遍，而不是全丢给模型：
 *
 *   1. 「帮助 / 天气 / 余额 / 设置 / 抽签 / 吃饭」这些是**确定性动作**，让模型转一手
 *      只会多花一次 token，还可能把参数理解歪（城市、配置键名尤其容易）。
 *   2. 权限要按 QQ 号判（主人 / 访客），模型看不见 QQ 号，也没法替插件拒绝。
 *   3. 指令是**短句**：第一个空白前的词命中登记表才算指令；「天气不错」这种正常聊天
 *      不会被误判（`天气不错` 是一个词，不等于 `天气`）。
 *
 * 只有创作 / 需要看图的指令会走模型：看图表、总结链接、梗百科、日报、记忆查询、提醒、
 * 小作文、白饭、按语义挑表情。它们由插件整理成一段说明再投给会话。
 *
 * @module @qqbot/dsh-plugin-qq/commands
 */

/**
 * 指令登记表。
 *
 * - `level`：`guest` 所有人可用；`owner` 只有主人可用。
 * - `kind`：`plugin` 插件自己执行；`agent` 交给模型。
 * - `group`：帮助页里的分区（玩 / 查 / 聊 / 管）。
 */
export const COMMANDS = [
  { name: '帮助', aliases: ['help', '菜单', '指令'], level: 'guest', kind: 'plugin', group: '查', args: '', summary: '看小助手现在会哪些指令' },
  // —— 玩 ——
  { name: '抽签', aliases: ['今日运势', '运势'], level: 'guest', kind: 'plugin', group: '玩', args: '', summary: '今日运势签（同一天结果稳定）' },
  { name: '吃饭', aliases: ['吃一碗', '干饭'], level: 'guest', kind: 'plugin', group: '玩', args: '', summary: '米饭计数器 +1' },
  { name: '饭量', aliases: ['今天吃了几碗', '米饭'], level: 'guest', kind: 'plugin', group: '玩', args: '', summary: '看自己今天 / 累计吃了几碗' },
  { name: '敲木鱼', aliases: ['木鱼', '功德'], level: 'guest', kind: 'plugin', group: '玩', args: '', summary: '功德 +1（本群共修）' },
  { name: '骰子', aliases: ['roll', '掷骰'], level: 'guest', kind: 'plugin', group: '玩', args: '[NdN]', summary: '掷骰子，例如 roll 2d6' },
  { name: '抛硬币', aliases: ['硬币', 'flip'], level: 'guest', kind: 'plugin', group: '玩', args: '', summary: '正面 / 反面' },
  { name: '点歌', aliases: ['搜歌', '找歌'], level: 'guest', kind: 'plugin', group: '玩', args: '<歌名>', summary: '搜歌并回链接（不播放）' },
  { name: '随机点名', aliases: ['点名'], level: 'guest', kind: 'plugin', group: '玩', args: '', summary: '从最近说过话的人里随机点一个' },
  { name: '接一个', aliases: ['表情接龙', '接梗'], level: 'guest', kind: 'plugin', group: '玩', args: '', summary: '按上一张表情的含义接一张' },
  { name: '投票', aliases: ['发起投票'], level: 'guest', kind: 'plugin', group: '玩', args: '[选项…] / 序号 / 截止 / 结果', summary: '群投票：发起 / 投票 / 截止 / 看结果' },
  // —— 查 ——
  { name: '天气', aliases: ['weather', '查天气'], level: 'guest', kind: 'plugin', group: '查', args: '<城市>', summary: '播报今天天气' },
  { name: '群热度', aliases: ['热度', '潜水榜'], level: 'guest', kind: 'plugin', group: '查', args: '', summary: '今天群里谁话多 / 谁潜水' },
  { name: '随机表情', aliases: ['来个表情', '随机表情包', '发表情'], level: 'guest', kind: 'plugin', group: '查', args: '', summary: '随机发一张表情包' },
  { name: '状态', aliases: ['status'], level: 'owner', kind: 'plugin', group: '查', args: '', summary: '连接 / 静默 / 记忆 / 会话状态' },
  { name: '余额', aliases: ['balance', '查余额'], level: 'owner', kind: 'plugin', group: '查', args: '', summary: 'DeepSeek API 剩余余额' },
  { name: '设置', aliases: ['settings', '配置'], level: 'owner', kind: 'plugin', group: '查', args: '[键] [值] / 全部', summary: '查看全部配置 / 改一项' },
  // —— 聊 ——
  { name: '表情', aliases: ['要表情', '表情包'], level: 'guest', kind: 'agent', group: '聊', args: '<描述>', summary: '按语义挑一张相近的表情包' },
  { name: '白饭', aliases: ['每日白饭', '摆烂', '摸鱼'], level: 'guest', kind: 'agent', group: '聊', args: '', summary: '一句摆烂语录（≤25 字）' },
  { name: '小作文', aliases: ['作文', '写小作文'], level: 'guest', kind: 'agent', group: '聊', args: '<主题> [要素…]', summary: '写一篇小作文（≤800 字）' },
  { name: '语音', aliases: ['念', '说话'], level: 'guest', kind: 'plugin', group: '聊', args: '<文字>', summary: '用 TTS 念一段话（≤200 字，需要本机 edge-tts）' },
  { name: '看图', aliases: ['看这张', '图里是什么'], level: 'guest', kind: 'agent', group: '聊', args: '[图片路径]', summary: '看最近一张图 / 引用图' },
  { name: '总结链接', aliases: ['链接总结', '总结'], level: 'guest', kind: 'agent', group: '聊', args: '<URL>', summary: '抓取并总结一个网页' },
  { name: '梗', aliases: ['梗百科', '黑话'], level: 'guest', kind: 'agent', group: '聊', args: '<词>', summary: '查梗 / 黑话（萌娘百科）' },
  { name: '日报', aliases: ['群日报', '今日总结'], level: 'owner', kind: 'agent', group: '聊', args: '', summary: '把今天群里聊的压成三五条' },
  { name: '记忆', aliases: ['翻旧账', '查记忆'], level: 'owner', kind: 'agent', group: '聊', args: '<关键词>', summary: '查长期记忆 / 聊天记录' },
  { name: '提醒', aliases: ['remind', '叫我'], level: 'guest', kind: 'agent', group: '聊', args: '<时间> <内容>', summary: '建一条定时提醒，例如「提醒 明天8点 交作业」' },
  { name: '存表情', aliases: ['收藏表情', '收表情'], level: 'guest', kind: 'plugin', group: '聊', args: '<名字>', summary: '把最近一张图存进表情包目录' },
  { name: '关注', aliases: ['订阅'], level: 'owner', kind: 'plugin', group: '管', args: '<关键词> / <群号> <关键词>', summary: '有人提到这个词就私聊告诉你' },
  { name: '取消关注', aliases: ['取关'], level: 'owner', kind: 'plugin', group: '管', args: '<关键词>', summary: '取消一个关键词关注' },
  { name: '关注列表', aliases: ['订阅列表'], level: 'owner', kind: 'plugin', group: '管', args: '', summary: '看当前关注的关键词' },
  { name: '纪念日', aliases: ['记纪念日'], level: 'owner', kind: 'plugin', group: '管', args: '<MM-DD> <内容>', summary: '记一个每年提醒的纪念日' },
  { name: '模式', aliases: ['mode', '运行模式'], level: 'guest', kind: 'plugin', group: '管', args: '[完整|简洁]', summary: '看当前运行模式；主人可在私聊里切完整 / 简洁' },
  { name: '定档', aliases: ['交接', '存档重开'], level: 'owner', kind: 'plugin', group: '管', args: '', summary: '把上下文写进交接文档，归档旧会话并新开一轮' },
  { name: '纪念日列表', aliases: ['纪念日们'], level: 'owner', kind: 'plugin', group: '管', args: '', summary: '看已记的纪念日' },
  { name: '别复读', aliases: ['关复读', '闭嘴复读'], level: 'owner', kind: 'plugin', group: '管', args: '', summary: '这个群不再自动复读' },
  { name: '可以复读', aliases: ['开复读'], level: 'owner', kind: 'plugin', group: '管', args: '', summary: '恢复这个群的自动复读' },
];

/** 指令名或别名 → 登记项（大小写不敏感，中文原样）。 */
const BY_NAME = new Map();
for (const command of COMMANDS) {
  BY_NAME.set(command.name.toLowerCase(), command);
  for (const alias of command.aliases) BY_NAME.set(String(alias).toLowerCase(), command);
}

/**
 * 按名字找指令。
 * @param {unknown} name
 * @returns {object | undefined}
 */
export function findCommand(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (key.length === 0) return undefined;
  return BY_NAME.get(key);
}

/**
 * 解析一条「已经是正文」的消息：`指令 [参数…]`。
 *
 * 只认**第一个空白分隔的词**完全等于某个指令名 / 别名。这样：
 *   - `天气 杭州` → 天气 + `杭州`
 *   - `小作文 我的青春 夏天 蝉鸣` → 小作文 + `我的青春 夏天 蝉鸣`
 *   - `天气不错` → undefined（一个词，不是 `天气`，交给模型当聊天）
 * @param {unknown} text
 * @returns {{ command: object, args: string } | undefined}
 */
export function parseCommand(text) {
  const raw = String(text ?? '').trim();
  if (raw.length === 0) return undefined;
  const match = /^(\S+)(?:[\s\u3000]+([\s\S]*))?$/u.exec(raw);
  if (match === null) return undefined;
  const command = findCommand(match[1]);
  if (command === undefined) return undefined;
  return { command, args: String(match[2] ?? '').trim() };
}

/** 一条指令的用法行。 */
export function usageLine(command) {
  const suffix = command.args.length > 0 ? ` ${command.args}` : '';
  return `@机器人 ${command.name}${suffix} — ${command.summary}`;
}

/**
 * 帮助文本：按「玩 / 查 / 聊 / 管」分区；访客看不到 owner 指令。
 * @param {boolean} isOwner
 * @returns {string}
 */
export function helpText(isOwner) {
  const visible = COMMANDS.filter((command) => isOwner || command.level === 'guest');
  const order = ['玩', '查', '聊', '管'];
  const lines = ['小助手现在会的指令（@我 + 空格 + 指令；私聊直接发）：'];
  for (const group of order) {
    const commands = visible.filter((command) => command.group === group);
    if (commands.length === 0) continue;
    lines.push('', `【${group}】`);
    for (const command of commands) lines.push(`· ${usageLine(command)}`);
  }
  if (!isOwner) lines.push('', '带【管】的那几条是主人专用的，你叫不动。');
  return lines.join('\n');
}
