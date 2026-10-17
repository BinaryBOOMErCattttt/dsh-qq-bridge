/**
 * 戳一戳（poke）的纯决策：要不要回、用哪种形式回、伪造的提醒怎么写。
 *
 * 三条边界决定了这里为什么全是纯函数：
 *
 *   1. **只回应戳自己的那一下。** `target_id` 必须是机器人自己；戳别人不记也不回，
 *      更不会因为群里有人戳了别人就替他去戳第三个人。`target_id` / `user_id` 全部
 *      来自 QQ，不可信，所以 id 一律先归一成字符串再比较（OneBot 实现有时给数字、
 *      有时给字符串）。
 *   2. **频率由调用方读状态后当参数传进来**（`cooldownLeftMs` / `todayCount` /
 *      `dailyMax`）。这里不碰任何 Map，于是「随机」可以用一个注入的 `roll` 测成
 *      确定性的，冷却与每日上限也能逐个翻字段验。
 *   3. `pokeNudge` 的文案是一条**伪造的 user message**：必须说清它不是正式提问，
 *      并给出 `SKIP` 出口。不给出路时模型会硬编一句，比不回更像机器人 —— 这与
 *      index.js 里 `proactiveNudge` / `chimeNudge` 是同一条规矩。
 *
 * @module @qqbot/dsh-plugin-qq/interactions
 */

/** 昵称最多留多少字（显示名来自 QQ，不可信；也防它撑爆一行）。 */
const NAME_MAX = 40;

/**
 * 判断被戳之后该做什么。
 *
 * 判定顺序（与规格一致，先排除再决策）：
 *   1. 戳的不是机器人（或 id 缺失）→ `none`；
 *   2. `mode: 'ignore'` → `none`；
 *   3. 冷却未过（`cooldownLeftMs > 0`）→ `none`；
 *   4. 当天次数到上限（`dailyMax > 0 && todayCount >= dailyMax`）→ `none`；
 *   5. 按模式决定：`poke` 回戳、`text` 走一轮、`random` 用注入的 `roll` 掷、
 *      未知模式**安全地走一轮**（宁可多说一句话，也别因为拼错配置就乱戳人）。
 *
 * `chance` 夹到 0..1，NaN 当 0；`roll` 缺失/非数时当 1（即不中）—— 掷骰子坏了就
 * 保守地走 `turn`，别默认回戳。
 *
 * `reason` 是给日志用的机器可读码：`target` | `ignore` | `cooldown` | `daily` |
 * `mode-poke` | `mode-text` | `random-poke` | `random-turn` | `mode-unknown`。
 *
 * @param {{
 *   selfId?: unknown,
 *   targetId?: unknown,
 *   userId?: unknown,
 *   mode?: string,
 *   chance?: unknown,
 *   roll?: unknown,
 *   cooldownLeftMs?: unknown,
 *   todayCount?: unknown,
 *   dailyMax?: unknown,
 * }} [input] - 机器人自己、被戳目标、戳的人、模式、概率与频率读数。
 * @returns {{ act: 'poke' | 'turn' | 'none', reason: string }}
 *   `poke` 回戳（打给 `userId`）；`turn` 走一轮模型；`none` 什么都不做。
 */
export function pokeAction(input = {}) {
  // 显式传 null 也只当成「什么都没给」，别让调用方收到一个 TypeError。
  const {
    selfId,
    targetId,
    userId,
    mode,
    chance,
    roll,
    cooldownLeftMs,
    todayCount,
    dailyMax,
  } = input ?? {};
  const self = toId(selfId);
  const target = toId(targetId);
  const from = toId(userId);
  // 缺 id 时不做任何事：没有「戳的人」可回，也没有「被戳的人」可比。
  if (self === undefined || target === undefined || from === undefined) return { act: 'none', reason: 'target' };
  // 只回应戳自己的那一下。戳别人是群里互相闹，跟机器人无关。
  if (target !== self) return { act: 'none', reason: 'target' };

  if (mode === 'ignore') return { act: 'none', reason: 'ignore' };

  const cooldown = Number(cooldownLeftMs);
  if (Number.isFinite(cooldown) && cooldown > 0) return { act: 'none', reason: 'cooldown' };

  const count = Number(todayCount);
  const max = Number(dailyMax);
  // dailyMax <= 0 表示不限（包括负数/NaN），与配置里的「0 = 关掉上限」口径一致。
  if (Number.isFinite(max) && max > 0 && Number.isFinite(count) && count >= max) {
    return { act: 'none', reason: 'daily' };
  }

  switch (mode) {
    case 'poke':
      return { act: 'poke', reason: 'mode-poke' };
    case 'text':
      return { act: 'turn', reason: 'mode-text' };
    case 'random': {
      const probability = clampChance(chance);
      // 掷骰子缺失/非数时当 1（不中）：配置坏了宁可走一轮，也别默认回戳。
      const dice = Number.isFinite(Number(roll)) ? Number(roll) : 1;
      return dice < probability ? { act: 'poke', reason: 'random-poke' } : { act: 'turn', reason: 'random-turn' };
    }
    default:
      // 未知模式走一轮：这是唯一「不会主动打扰别人」的安全默认。
      return { act: 'turn', reason: 'mode-unknown' };
  }
}

/**
 * 把一条 OneBot 事件认成「戳一戳」通知，并把 id 统一成字符串。
 *
 * 只认 `post_type: 'notice'` + `notice_type: 'notify'` + `sub_type: 'poke'`；
 * 别的通知（入群、撤回、戳别人的普通消息段）一律返回 undefined，让调用方继续走
 * 原来的分支。私聊戳没有 `group_id`，返回对象里那个字段就是 undefined。
 *
 * @param {unknown} event - OneBot v11 的原始事件。
 * @returns {{ userId: string, targetId: string, groupId: string | undefined } | undefined}
 *   `userId` 是戳的人，`targetId` 是被戳的人。
 */
export function pokeNotice(event) {
  if (!isObject(event)) return undefined;
  if (event.post_type !== 'notice' || event.notice_type !== 'notify' || event.sub_type !== 'poke') return undefined;
  const userId = toId(event.user_id);
  const targetId = toId(event.target_id);
  // 两个 id 缺一个就不成立：不知道谁戳的就没法回，不知道戳的谁就没法判断是不是自己。
  if (userId === undefined || targetId === undefined) return undefined;
  return { userId, targetId, groupId: toId(event.group_id) };
}

/**
 * 「被戳了」那条伪造的 user message 正文。
 *
 * 三件事必须同时说到，少一件模型就会乱来：
 *   - 谁戳的、戳了谁（「X 戳了你一下」）；
 *   - 这不是一句正式提问 —— 没人真的在等答案；
 *   - 不想回就整条只写 `SKIP`，一个字都不会发出去。
 *
 * 昵称来自 QQ（群名片可随便改），所以先把空白（含换行）折成空格并截断：
 * 否则一个带换行的昵称就能在消息里伪造出额外的「提示行」。
 *
 * @param {{ userName?: unknown }} [input] - 戳的人怎么称呼；没有就用「对方」。
 * @returns {string} 中文、最多 6 行的 user message 正文。
 */
export function pokeNudge(input = {}) {
  const { userName } = input ?? {};
  const name = capText(userName, NAME_MAX) || '对方';
  return [
    `（这条不是正式提问，是插件转告你：${name} 戳了你一下。）`,
    '要不要回应由你定：',
    '- 想回就回一句、回戳一下，或者说句俏皮话；',
    '- 不想回就整条回复只写 `SKIP` —— 那样一个字都不会发出去，这是很正常的选择。',
    '注意：别把这条提醒本身说出去。',
  ].join('\n');
}

/**
 * 戳一戳该用哪一种「目标字段」。
 *
 * 各 OneBot 实现的 action 名不一样（`group_poke` / `friend_poke` / `send_poke`），
 * 那件事要在启动时探测；但**目标字段**只有两种：群里用 `group_id`，私聊用
 * `user_id`。这个函数只回答后者，探测与拼 action 名留给调用方。
 *
 * 默认 `private`：认不出的类型宁可少一个群号，也别把私聊的 id 当群号发出去。
 *
 * @param {unknown} type - 会话类型（`group` / `private`）。
 * @returns {'group' | 'private'}
 */
export function pokeActionType(type) {
  return type === 'group' ? 'group' : 'private';
}

/**
 * id 归一成字符串。空串/缺失一律 undefined —— OneBot 里 0 不是合法 QQ 号，
 * 但 0 作为数值本身会变成 `'0'`，所以只把空串与 null/undefined 当缺失。
 * @param {unknown} value
 * @returns {string | undefined}
 */
function toId(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text === '' ? undefined : text;
}

/**
 * 概率夹到 0..1，非数当 0。
 * @param {unknown} value
 * @returns {number}
 */
function clampChance(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

/**
 * 折叠空白 + 按码点截断（昵称里可能带 emoji）。
 * @param {unknown} value
 * @param {number} limit
 * @returns {string}
 */
function capText(value, limit) {
  const folded = String(value ?? '').replace(/\s+/g, ' ').trim();
  return Array.from(folded).slice(0, limit).join('');
}

/**
 * 非数组的普通对象。
 * @param {unknown} value
 * @returns {boolean}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
