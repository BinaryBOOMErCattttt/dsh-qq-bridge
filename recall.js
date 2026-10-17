/**
 * 被撤回的消息（recall）的**纯判据**：认事件、决定要不要补一句、两段伪造提醒怎么写。
 *
 * 形状照抄 `interactions.js`（戳一戳），理由也一样：
 *
 *   1. **QQ 不给回查**。消息撤了就撤了，`get_msg` 要么报错要么返回空 —— 所以「它撤了
 *      哪句」只能由插件在收到消息时自己记（见 index.js 的 `noteSeen` / `recent`）。这里
 *      只消费那份账的读数（`seen` / `addressed` / `replied` / `ageMs`），不碰任何 Map。
 *   2. **频率由调用方读状态后当参数传进来**（`cooldownLeftMs` / `todayCount` / `dailyMax`）。
 *      随机数同样由调用方掷（`roll`），于是每个分支都能用固定序列钉住。
 *   3. 两段文案都是**伪造的 user message**：必须说清它不是谁发来的、并给出 `SKIP` 出口，
 *      否则模型会硬编一句 —— 与 `pokeNudge` / `proactiveNudge` / `chimeNudge` 同一条规矩。
 *
 * 边界：不 import `index.js`、不读磁盘、不记日志、不碰 `ctx`。
 *
 * @module @qqbot/dsh-plugin-qq/recall
 */

/** 昵称最多留多少字（显示名来自 QQ，不可信；也防它撑爆一行）。 */
const NAME_MAX = 40;

/** 被撤回的原文最多带多少字（只有 `recallTeaseQuote` 打开时才用得上）。 */
const TEXT_MAX = 80;

/**
 * 把一条 OneBot 事件认成「撤回通知」，并把 id 统一成字符串。
 *
 * 只认 `notice_type: 'group_recall'` 与 `'friend_recall'`；别的通知（戳一戳、入群、
 * 退群）一律返回 undefined，让调用方继续走原来的分支。
 *
 * 三处实现差异必须容错（`NapCat.Shell/napcat.mjs` 的事件类）：
 *   - `message_id` 可能是数字或字符串；
 *   - `operator_id` 有的实现不给 —— 缺省当「本人撤回」，所以字段本身保留 undefined
 *     （`recallAction` 据此区分「管理员代撤」）；
 *   - 私聊撤回（`friend_recall`）没有 `group_id`、也没有 `operator_id`。
 *
 * @param {unknown} event - OneBot v11 的原始事件。
 * @returns {{ groupId?: string, userId: string, operatorId?: string, messageId: string } | undefined}
 *   `userId` 是被撤回那条的发送者，`operatorId` 是撤的人（管理员代撤时 ≠ `userId`）。
 */
export function recallNotice(event) {
  if (!isObject(event)) return undefined;
  if (event.post_type !== 'notice') return undefined;
  if (event.notice_type !== 'group_recall' && event.notice_type !== 'friend_recall') return undefined;
  const messageId = toId(event.message_id);
  const userId = toId(event.user_id);
  // 少了哪一个都做不成事：不知道撤了哪条就没法清引用，不知道谁发的就没法调侃。
  if (messageId === undefined || userId === undefined) return undefined;
  return { groupId: toId(event.group_id), userId, operatorId: toId(event.operator_id), messageId };
}

/**
 * 「现在这一刻，适合为这条撤回说句话吗」。
 *
 * **只管补一句，不管投递。** 摘除 / 改写要看 `pending` / `ambient` / `submitted` 这些
 * 运行时状态，那是调用方的事；这里只回答一个布尔式的问题。
 *
 * 判据顺序（先排除，再决策）：
 *   1. `mode !== 'tease'`                → `off`
 *   2. `messageId` / `userId` 缺失        → `target`
 *   3. `userId === selfId`（自己发的话被撤）→ `self`
 *   4. `operatorId` 存在且 ≠ `userId`（管理员代撤）→ `operator`
 *   5. 账里没有（`seen !== true`）        → `unseen`
 *   6. `ageMs > maxAgeMs`（0 = 不限）      → `stale`
 *   7. `scope === 'to-me'` 且既没 @ 过它、它也没回过 → `scope`
 *   8. `busy === true`（turn 在飞）        → `busy`
 *   9. 冷却未过                            → `cooldown`
 *   10. 当天次数到上限（0 = 不限）          → `daily`
 *   11. 概率没中（`roll >= chance`）        → `roll`
 *   12. 全过                               → `tease`
 *
 * `chance` 夹到 0..1、NaN 当 0；`roll` 缺失/非数当 1（不中）—— 掷骰子坏了偏保守，与
 * `activeTalkAllows` / `pokeAction` 同口径。
 *
 * @param {{
 *   mode?: string,
 *   selfId?: unknown,
 *   messageId?: unknown,
 *   userId?: unknown,
 *   operatorId?: unknown,
 *   seen?: unknown,
 *   addressed?: unknown,
 *   replied?: unknown,
 *   scope?: string,
 *   ageMs?: unknown,
 *   maxAgeMs?: unknown,
 *   busy?: unknown,
 *   cooldownLeftMs?: unknown,
 *   todayCount?: unknown,
 *   dailyMax?: unknown,
 *   chance?: unknown,
 *   roll?: unknown,
 * }} [input]
 * @returns {{ act: 'tease' | 'none', reason: string }}
 */
export function recallAction(input = {}) {
  const {
    mode,
    selfId,
    messageId,
    userId,
    operatorId,
    seen,
    addressed,
    replied,
    scope,
    ageMs,
    maxAgeMs,
    busy,
    cooldownLeftMs,
    todayCount,
    dailyMax,
    chance,
    roll,
  } = input ?? {};

  // 1) 只有 tease 会「补一句」：off / ignore 在别处就把投递决策做完了。
  if (mode !== 'tease') return { act: 'none', reason: 'off' };

  const message = toId(messageId);
  const from = toId(userId);
  if (message === undefined || from === undefined) return { act: 'none', reason: 'target' };

  // 3) 自己的话被撤（多半是管理员操作）不调侃：那是另一件事。
  if (toId(selfId) === from) return { act: 'none', reason: 'self' };

  // 4) 管理员替别人撤了话：调侃他等于公开处刑，而且对象错了。缺 operator_id 时按本人撤回算。
  const operator = toId(operatorId);
  if (operator !== undefined && operator !== from) return { act: 'none', reason: 'operator' };

  // 5) 没看见过就没什么可说的（那几十毫秒里它可能压根没收到）。
  if (seen !== true) return { act: 'none', reason: 'unseen' };

  // 6) 太久的撤回不值得提：群里翻出十分钟前的一条撤了，接一句只像复读机。0 = 不限。
  const age = Number(ageMs);
  const maxAge = Number(maxAgeMs);
  if (Number.isFinite(maxAge) && maxAge > 0 && Number.isFinite(age) && age > maxAge) {
    return { act: 'none', reason: 'stale' };
  }

  // 7) to-me：只调侃冲它来的、或它已经回过的；别人的闲聊不主动开口（那更接近 proactive）。
  if (scope !== 'all' && addressed !== true && replied !== true) return { act: 'none', reason: 'scope' };

  // 8) turn 在飞：这一轮的回复本身就是回应，再补一句是连发两条。
  if (busy === true) return { act: 'none', reason: 'busy' };

  // 9) 冷却：群里「撤回测试」是常见行为，没有这道闸会被刷成复读机。
  const cooldown = Number(cooldownLeftMs);
  if (Number.isFinite(cooldown) && cooldown > 0) return { act: 'none', reason: 'cooldown' };

  // 10) 当天上限：0 与负数表示不限，与 pokeDailyMax 同口径。
  const count = Number(todayCount);
  const max = Number(dailyMax);
  if (Number.isFinite(max) && max > 0 && Number.isFinite(count) && count >= max) {
    return { act: 'none', reason: 'daily' };
  }

  // 11) 概率：骰子缺失/非数当 1（不中），配置坏了宁可不说。
  const probability = clampChance(chance);
  const dice = Number.isFinite(Number(roll)) ? Number(roll) : 1;
  if (dice >= probability) return { act: 'none', reason: 'roll' };

  return { act: 'tease', reason: 'tease' };
}

/**
 * 投递前**改写**用的正文：那条还没进模型就被撤了，把这一句换成「他 @ 了我又撤了」。
 *
 * 为什么改写比「摘掉再另开一轮」好：后者会变成「先回一句正经的、再补一句调侃」的两连发，
 * 而这一轮本来就是为它开的 —— 模型在**本来就要开的这一轮**里看到撤回，回一句就够。
 *
 * @param {{ name?: unknown, text?: unknown, imageAllowed?: unknown }} [input]
 *   `text` 只在 `recallTeaseQuote` 打开时给（默认不给原文，见 docs/security.md）。
 * @returns {string} 两行中文 user message 正文。
 */
export function recallLine(input = {}) {
  const { name, text, imageAllowed } = input ?? {};
  const who = capText(name, NAME_MAX) || '对方';
  const quoted = capText(text, TEXT_MAX);
  const head = quoted.length > 0
    ? `（${who} 刚才 @ 了你，接着又把自己那条撤回了。那句是：「${quoted}」）`
    : `（${who} 刚才 @ 了你，接着又把自己那条撤回了。）`;
  const choice = imageAllowed === true
    ? '你想回就回一句，也可以顺口调侃一句「撤什么呀，我看见了」，或者只发一张表情；不想回就只写 SKIP。'
    : '你想回就回一句，也可以顺口调侃一句「撤什么呀，我看见了」；不想回就只写 SKIP。';
  return [head, choice].join('\n');
}

/**
 * 「补一句」用的正文（已经回过 / 别人的闲聊被撤回）。
 *
 * 四件事必须同时说到，少一件模型就会乱来：
 *   1. 这条**不是谁发给它的消息**（否则它会当成一个人在跟它说话）；
 *   2. 它可以调侃，也可以什么都不做（`SKIP` 出口）；
 *   3. **别复述被撤回的内容**（默认连原文都不给它）；
 *   4. **别把这条提醒本身说出去**。
 *
 * `replied` 决定措辞：`true` 才说「你已经回过了」；`false` 只说「刚撤了一条」，
 * 一个字都不替它下结论。
 *
 * @param {{ name?: unknown, text?: unknown, replied?: unknown, imageAllowed?: unknown }} [input]
 * @returns {string} 三行中文 user message 正文。
 */
export function recallNudge(input = {}) {
  const { name, text, replied, imageAllowed } = input ?? {};
  const who = capText(name, NAME_MAX) || '对方';
  const quoted = capText(text, TEXT_MAX);
  const suffix = quoted.length > 0 ? `那句是：「${quoted}」` : '';
  const head = replied === true
    ? `（这条不是谁发给你的消息，是插件转告你：${who} 刚才把一条你已回过的话撤回了。${suffix}）`
    : `（这条不是谁发给你的消息，是插件转告你：群里 ${who} 刚撤回了一条消息，你没回过。${suffix}）`;
  // 两个分支都必须写出 `SKIP`：`proactiveSkip` 认的是那个字面量，少一个字模型就只有
  // 「硬编一句话」这一条路可走 —— 而它落在一个没人在等它说话的场景里。
  const choice = replied === true
    ? '想补一句「撤得有点晚，我都回了」就补，不想说就整条只写 SKIP。'
    : imageAllowed === true
      ? '想接一句就接（比如「撤什么呀，我看见了」），不想说就整条只写 SKIP，或者只发一张表情。'
      : '想接一句就接（比如「撤什么呀，我看见了」），不想说就整条只写 SKIP。';
  return [
    head,
    choice,
    '注意：别把这条提醒本身说出来，也别复述可能被撤回的内容。',
  ].join('\n');
}

/**
 * id 归一成字符串。空串/缺失一律 undefined —— 与 `interactions.js` 的 `toId` 同口径
 * （OneBot 实现有时给数字、有时给字符串，比较前必须先归一）。
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
 * 折叠空白 + 按码点截断。
 *
 * 昵称与原文都来自 QQ（不可信）：群名片可以随便改、正文可以带换行，不折一遍就能在
 * 提示词里伪造出额外的「提示行」。与 `pokeNudge` 的昵称是同一条线。
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
