/**
 * 「什么时候该主动开口」的**纯判据**。
 *
 * 这些条件原本内联在 `index.js` 的闭包里，靠事件与定时器驱动，只能从集成测试上观察；
 * 而它们恰恰是全项目最难维护的一批规则（AGENTS.md 的 §4.F / §4.G 花了很长篇幅解释）。
 * 搬出来之后每条判据都能用普通入参直接验：想要「安静够久但刚说过话」这种时刻，
 * 传两个数就行，不用把假 timer 和假 OneBot 都架起来。
 *
 * 边界刻意划在**判据**上，不划在流程上：
 *   - 这里**只有** `(普通值) → boolean / number`，没有 `ctx`、没有会话表、不读写磁盘、
 *     不记日志。所以它可以直接单测，也可以在任意上下文里调。
 *   - 定时器的排布、队列的投递、`submitted` 的记账、概率的掷骰子**不在这里** ——
 *     那些是 `index.js` 的编排，它们决定「什么时候问这些问题」，而这里只回答
 *     「答案是什么」。
 *
 * 唯一一处不那么纯粹的地方是入参里带了 `roll`（已掷好的随机数）而不是在这里
 * `Math.random()`：判据要可重复才测得动边界。调用方掷、这里判。
 *
 * @module @qqbot/dsh-plugin-qq/speaking-rules
 */

/** 把 0~1 的概率夹到合法区间；非法值（NaN）保持 NaN —— 与旧行为一致，`NaN > 0` 为 false。 */
function clampChance(value) {
  return Math.min(1, Math.max(0, Number(value)));
}

/**
 * 这个群现在值不值得**主动**搭一句话（冷场那条路，见 AGENTS.md §4.F）。
 *
 * 五道闸门加两个节奏闸，缺一不可：
 *   1. 只群聊 —— 私聊不打扰（这是刻意不给开关的，见 index.js 的说明）；
 *   2. 没有正在进行的对话：攒批里有待投的消息、或者有 turn 在飞，都不插嘴；
 *   3. 安静够久（`idleMs`）：群里刚才还在聊，就不该轮到它开口；
 *   4. 不是独白：上一次说话之后一直没人接话（`lastBotSpeakAt >= lastActiveAt`）；
 *   5. 不算诈尸：`freshMs` 之内还有人说过话的群才搭（`freshMs <= 0` = 不限制）。
 *   6. 同一个群两次主动说话至少隔 `gapMs`（`lastProactiveAt` 为 0 = 还没主动说过，不受限）；
 *   7. 当天次数还没到 `dailyMax`。
 *
 * **时段**（`proactiveFromHour` / `proactiveToHour`）与**概率**不在这里：那是「整轮检查」
 * 的性质，一次醒来只判一次（见 `withinActiveHours` 与 index.js 的 `proactiveSweep`）。
 *
 * @param {object} input
 * @param {string} input.type - 会话类型，只认 `'group'`。
 * @param {boolean} input.hasQueuedBatch - 攒批里还有待投的消息（或攒批定时器挂着）。
 * @param {boolean} input.busy - 这个会话有 turn 在飞（index.js 的 `busyWithTurn`）。
 * @param {number} input.lastActiveAt - 群里最后一次有人说话的时刻（0 = 从来没人说过）。
 * @param {number} input.lastBotSpeakAt - 机器人最后一次在这个群说话的时刻。
 * @param {number} input.lastProactiveAt - 上一次主动搭话的时刻（0 = 没有过）。
 * @param {number} input.todayCount - 当天已主动说话次数。
 * @param {number} input.now - 当前时刻（毫秒）。
 * @param {number} input.idleMs / input.freshMs / input.gapMs / input.dailyMax - 配置。
 * @returns {boolean} 可以开口时为 true。
 */
export function proactiveEligible(input) {
  if (input.type !== 'group') return false;
  if (input.hasQueuedBatch || input.busy) return false;
  const lastActive = Number(input.lastActiveAt) || 0;
  // 从来没人在这个群说过话（例如会话是被出站工具建出来的壳）就没有可搭的话头。
  if (lastActive <= 0 || input.now < lastActive) return false;
  // 独白：上一条是我说的，之后没人接话。
  if ((Number(input.lastBotSpeakAt) || 0) >= lastActive) return false;
  if (input.now - lastActive < input.idleMs) return false;
  const freshMs = Number(input.freshMs) || 0;
  if (freshMs > 0 && input.now - lastActive > freshMs) return false;
  const gapMs = Number(input.gapMs) || 0;
  const lastProactive = Number(input.lastProactiveAt) || 0;
  if (lastProactive > 0 && input.now - lastProactive < gapMs) return false;
  return (Number(input.todayCount) || 0) < input.dailyMax;
}

/**
 * 主动搭话的「我不说话」信号：第一行以 `SKIP` 开头（容忍各种括号与前后空白）。
 *
 * 宽松一点是有意的：模型经常顺手把自己的决定解释一下（`SKIP（没什么可说的）`），
 * 那半句同样不该发到群里 —— 它是在解释内部决定，不是群友会说的话。只看第一行，
 * 后面的解释直接丢掉。`skip` 后面要求一个词边界，免得把 `skipping` 这类正文吞掉。
 * @param {string} text - 这一轮的回复正文。
 * @returns {boolean} 整条都不该发出去时为 true。
 */
export function proactiveSkip(text) {
  const first = String(text ?? '')
    .split('\n')
    .find((line) => line.trim().length > 0) ?? '';
  return /^[(（[\s]*skip\b/i.test(first.trim());
}

/**
 * 免 @ 接话的轮数还有余额吗（见 AGENTS.md §4.G 的 A 路）。
 * @param {number} maxTurns - `activeMaxTurns`；`<= 0` 表示不限。
 * @param {number} activeTurns - 这次活跃对话里已经免 @ 接了几轮。
 * @returns {boolean} 还有余额时为 true。
 */
export function activeTurnsLeft(maxTurns, activeTurns) {
  const max = Number(maxTurns) || 0;
  return max <= 0 || (Number(activeTurns) || 0) < max;
}

/**
 * 这条**没被叫到**的群消息能不能算「接着聊」（A 路，`activeFollow`）。
 *
 * 七条同时成立才算，缺一条都不理它 —— 这一步放松的是「群里只在被 @ 时才说话」这条
 * 默认约定，宁可少接一句也别抢话：
 *   1. `activeFollow` 开着，且活跃窗口开着（`windowMs > 0`）；
 *   2. 是群聊 —— 私聊每条消息本来就都是跟它说的，不需要「免 @」；
 *   3. 说话的就是**正在跟它聊的那个人**（别人插一句不该被它抢答）；
 *   4. 还在窗口内（`now < activeUntil`）；
 *   5. 这次对话里免 @ 接的轮数还没用完；
 *   6. 中间**没有别人说过话**（一对一被插了话就断了，得重新 @ 它 —— 除非那一句把群聊
 *      推过了门槛，那时走的是多人搭话，见 `chatter.isHot`）；
 *   7. 这句没有 @ 别人（`@别人` / `@全体` 明确不是跟它说的）。
 *
 * @param {object} input
 * @param {boolean} input.enabled - `activeFollow === true`。
 * @param {number} input.windowMs - `activeWindowMs`。
 * @param {string} input.type - 会话类型。
 * @param {string} input.speakerId - 会话记的「正在跟它聊的人」。
 * @param {string} input.userId - 这条消息的发送者。
 * @param {number} input.activeUntil - 这个窗口的截止时刻。
 * @param {boolean} input.turnsLeft - 还有免 @ 轮数（见 `activeTurnsLeft`）。
 * @param {number} input.interposeOthers - 当前插话序号（`chatter.others`）。
 * @param {number} input.interposeSnapshot - 上一次接话时记下的插话序号快照。
 * @param {boolean} input.mentionsOthers - 这条消息 @ 了别人（`mentionsOthers`）。
 * @param {number} input.now - 当前时刻（毫秒）。
 * @returns {boolean} 可以当「接话」时为 true。
 */
export function activeFollowAllows(input) {
  if (input.enabled !== true) return false;
  if (input.windowMs <= 0) return false;
  if (input.type !== 'group') return false;
  if (String(input.speakerId ?? '') !== String(input.userId)) return false;
  if ((Number(input.activeUntil) || 0) <= input.now) return false;
  if (input.turnsLeft !== true) return false;
  // 快照停在上一次接话那条上；这里已经比它大 1 以上就说明中间有人插过话
  // （当前这条自己会把序号 +1，所以「紧跟着的下一条」正好是 +1）。
  if (input.interposeOthers > (Number(input.interposeSnapshot) || 0) + 1) return false;
  if (input.mentionsOthers === true) return false;
  return true;
}

/**
 * 「免 @ 搭话」的累计概率（抽卡那套保底，见 AGENTS.md §4.G）。
 *
 * A 路（一对一窗口里同一个人接着说的话）与 C 路（多人搭话）**共用同一条曲线**：够资格
 * 不等于就接 —— 每够资格一次就按这个概率掷一回，没掷中就把「连丢」计数 +1，下一次更接近
 * 上限；掷中、或者被明确 @ 到（那是不用抽的直接回复）之后计数归零，重新从起始概率攒。
 *
 * 三处刻意的取值：
 *   - `max < base` 时按 `base` 封顶，而不是让配反的上限把起始概率也压掉；
 *   - 任何非有限值（NaN，配置写坏）都当 0 —— 宁可一句不接，也不要按一个莫名其妙的
 *     概率乱接（与 `proactiveChance` 的 NaN → 不开口是同一种失败方向）；
 *   - `max` 自己 NaN（没填）时当成「没有上限」。
 *
 * @param {number} base - `activeTalkChance`（起始概率，0~1）。
 * @param {number} step - `activeTalkChanceStep`（每连丢一条加多少）。
 * @param {number} max - `activeTalkChanceMax`（上限）。
 * @param {number} misses - 这段对话里已经连丢了几条（`conversation.talkMisses`）。
 * @returns {number} 这一次的搭话概率（0~1）。
 */
export function activeTalkChance(base, step, max, misses) {
  const start = clampChance(base);
  const grow = clampChance(step);
  const count = Math.max(0, Math.floor(Number(misses) || 0));
  const raw = start + grow * count;
  if (!Number.isFinite(raw)) return 0;
  const cap = clampChance(max);
  return Math.min(Number.isFinite(cap) ? Math.max(start, cap) : 1, raw);
}

/**
 * 这一次搭话掷中了吗。
 *
 * 与 `chimeAllows` 的最后一条同构：`chance > 0 && roll < chance`，`roll` 由调用方掷
 * （判据要可重复才测得动边界）。`eligible` 是 A/C 两路是否够资格 —— 不够资格时连概率
 * 都不用算，这里一并挡住。
 *
 * @param {object} input
 * @param {boolean} input.eligible - 够资格（一对一窗口里，或者群聊进了搭话状态）。
 * @param {number} input.chance - 已算好的概率（见 `activeTalkChance`）。
 * @param {number} input.roll - 已掷好的 0~1 随机数。
 * @returns {boolean} 这一句该接时为 true。
 */
export function activeTalkAllows(input) {
  if (input.eligible !== true) return false;
  const chance = clampChance(input.chance);
  return chance > 0 && input.roll < chance;
}

/**
 * 「自己补一句」的延迟（毫秒）：在 `idleMs` 上按 `jitter` 抖动，下限 500。
 *
 * 掐着表 20 秒整补一句比不补还像机器人；复用打字延迟那个抖动比例，不额外加配置。
 * @param {number} idleMs - `activeChimeIdleMs`。
 * @param {number} jitter - `delayJitter`（0~1）。
 * @param {number} roll - 已掷好的 0~1 随机数（判据要可重复，所以由调用方掷）。
 * @returns {number} 延迟毫秒数。
 */
export function chimeDelay(idleMs, jitter, roll) {
  const ratio = Math.min(1, Math.max(0, Number(jitter) || 0));
  return Math.max(500, Math.round(Number(idleMs) * (1 + (roll * 2 - 1) * ratio)));
}

/**
 * 「补一句」的闸门（B 路）—— 定时器醒来时**再判一遍**，因为这一小会儿里什么都可能变了。
 *
 * 判据一条都不能少，顺序也就是下面这个顺序：
 *   1. 编号还对得上（对不上说明这条提醒已经被后来的消息取代了）；
 *   2. `proactive` 开着 —— 「允许它主动发消息」只有这一个总开关，别让补一句绕过它；
 *   3. 窗口还热着；
 *   4. 没有待投的批次、也没有在飞的 turn（否则插进去就是抢话）；
 *   5. 这一句之后还没补够（`chimeMax` 为 0 表示不限）；
 *   6. 当天还没超量（`chimeDailyMax` 为 0 表示不限）；
 *   7. **我回过之后确实没人接话**（有人接的话那条消息自己会走正常回复，而它一到就会把
 *      这个定时器作废）。`lastBotSpeakAt <= lastActiveAt` 就是「对方没接」；
 *   8. 群里中间也没别人插过话（序号与快照相等）；
 *   9. 概率掷中（`chance > 0` 且 `roll < chance`）。
 *
 * @param {object} input
 * @param {boolean} input.seqMatches - 编号与挂定时器时一致。
 * @param {boolean} input.proactiveEnabled - `proactive === true`。
 * @param {number} input.now - 当前时刻（毫秒）。
 * @param {number} input.activeUntil - 活跃窗口的截止时刻。
 * @param {boolean} input.hasQueuedBatch - 有待投批次或攒批定时器。
 * @param {boolean} input.busy - 有 turn 在飞。
 * @param {number} input.chimeCount - 对方这一句之后已经补了几句。
 * @param {number} input.chimeMax - `activeChimeMax`（0 = 不限）。
 * @param {number} input.chimeToday - 当天已经补了几句。
 * @param {number} input.chimeDailyMax - `activeChimeDailyMax`（0 = 不限）。
 * @param {number} input.lastBotSpeakAt / input.lastActiveAt - 两个时刻。
 * @param {string} input.type - 会话类型。
 * @param {number} input.interposeOthers / input.interposeSnapshot - 插话序号与其快照。
 * @param {number} input.chance - `proactiveChance`。
 * @param {number} input.roll - 已掷好的 0~1 随机数。
 * @returns {boolean} 可以补一句时为 true。
 */
export function chimeAllows(input) {
  if (input.seqMatches !== true) return false;
  if (input.proactiveEnabled !== true) return false;
  if ((Number(input.activeUntil) || 0) <= input.now) return false;
  if (input.hasQueuedBatch || input.busy) return false;
  const max = Number(input.chimeMax) || 0;
  if (max > 0 && (Number(input.chimeCount) || 0) >= max) return false;
  const dailyMax = Number(input.chimeDailyMax) || 0;
  if (dailyMax > 0 && (Number(input.chimeToday) || 0) >= dailyMax) return false;
  if ((Number(input.lastBotSpeakAt) || 0) <= (Number(input.lastActiveAt) || 0)) return false;
  if (input.type === 'group' && input.interposeOthers !== (Number(input.interposeSnapshot) || 0)) return false;
  const chance = clampChance(input.chance);
  return chance > 0 && input.roll < chance;
}

/**
 * 「倾听时间」倍数（见 AGENTS.md §4.G 的 C 路）。
 *
 * 只有**多人搭话**的群会放大：大家正聊着的时候它该多听几句再开口，而不是每两秒截一句
 * 就回一轮。一对一的窗口不放大 —— 那边是「它正在跟你说话」，等太久反而像掉线。
 * @param {string} type - 会话类型。
 * @param {boolean} groupTalkActive - 这个群现在算「大家正聊着」（`chatter.isHot`）。
 * @param {number} scale - `activeGroupBatchScale`。
 * @returns {number} 倍数（≥1）。
 */
export function batchScale(type, groupTalkActive, scale) {
  if (type !== 'group') return 1;
  if (groupTalkActive !== true) return 1;
  return Number(scale) || 1;
}

/**
 * 攒批窗口（毫秒）；配置为 0（关闭攒批）时返回 0。
 * @param {number} windowMs - `settings.batchWindowMs`（已经归一化过：0 或正整数）。
 * @param {number} scale - 倾听倍数。
 * @returns {number} 实际窗口。
 */
export function batchWindow(windowMs, scale) {
  const base = Number(windowMs) || 0;
  if (base <= 0) return 0;
  return Math.max(1, Math.round(base * scale));
}

/**
 * 一批最多等多久（毫秒）。
 *
 * 配置比窗口还小时没有意义，按下限（= 窗口）算；与窗口同倍放大 —— 两处必须同倍，
 * 只放大窗口不放大上限时 `batchMaxWaitMs` 会把「多听几句」又卡回去。
 * @param {number} maxWaitMs - `settings.batchMaxWaitMs`（0 或正整数）。
 * @param {number} window - 已经算好的窗口（见 `batchWindow`）。
 * @param {number} scale - 倾听倍数。
 * @returns {number} 实际上限。
 */
export function batchCap(maxWaitMs, window, scale) {
  const base = Number(maxWaitMs) || 0;
  const scaled = base > 0 ? Math.round(base * scale) : 0;
  return scaled > window ? scaled : window;
}

/**
 * 私聊「补一句」的闸门（L2，见设计文档 §6.5）。
 *
 * 它与群聊的 `chimeAllows` 是**两套语义**，所以刻意分成两个函数：
 *
 *   - 群聊的补一句属于「主动说话」家族，第一道闸就是 `proactive === true`；
 *   - 私聊的补一句是「刚跟一个人聊完，看还有没有想补充的」，**不该被群里那个总开关
 *     连坐**（`proactive` 的文案与风险模型都是「在群里开话头」）。所以它有自己的开关
 *     `privateAfterthought` 与自己的日上限，而且**默认开**。
 *
 * 五道闸门一条不少（少一条都会变成骚扰）：
 *   1. 只私聊 —— 群聊的补一句仍归 B 路（`activeChime*`），别混；
 *   2. 编号还对得上（后来的消息会把旧定时器作废）；
 *   3. 没有待投的批次、也没有在飞的 turn（插进去就是抢话）；
 *   4. **对方没有接着说话**（`lastBotSpeakAt > lastActiveAt`）：对方接了话，那一句自己会
 *      走正常回复，这次补一句就该让位；
 *   5. 这一条用户消息之后还没补过（一次用户消息最多补一句，不连锁）；
 *   6. 当天没到 `dailyMax`（0 = 不限）；
 *   7. 概率掷中。
 *
 * @param {object} input
 * @param {boolean} input.enabled - `privateAfterthought`。
 * @param {string} input.type - 会话类型，只认 `'private'`。
 * @param {boolean} input.seqMatches - 编号与挂定时器时一致。
 * @param {boolean} input.hasQueuedBatch - 有待投批次或攒批定时器。
 * @param {boolean} input.busy - 有 turn 在飞。
 * @param {number} input.chimeCount - 这一条用户消息之后已补了几句。
 * @param {number} input.chimeToday - 今天已补几句。
 * @param {number} input.dailyMax - `privateAfterthoughtDailyMax`（0 = 不限）。
 * @param {number} input.lastBotSpeakAt / input.lastActiveAt - 两个时刻。
 * @param {number} input.chance - `privateAfterthoughtChance`。
 * @param {number} input.roll - 已掷好的 0~1 随机数。
 * @returns {boolean} 可以补一句时为 true。
 */
export function privateAfterthoughtAllows(input) {
  if (input.enabled !== true) return false;
  if (input.type !== 'private') return false;
  if (input.seqMatches !== true) return false;
  if (input.hasQueuedBatch || input.busy) return false;
  // 「一次用户消息最多补一句」是硬规则（不是配置）：补完再补就成了自言自语。
  if ((Number(input.chimeCount) || 0) >= 1) return false;
  const dailyMax = Number(input.dailyMax) || 0;
  if (dailyMax > 0 && (Number(input.chimeToday) || 0) >= dailyMax) return false;
  if ((Number(input.lastBotSpeakAt) || 0) <= (Number(input.lastActiveAt) || 0)) return false;
  const chance = clampChance(input.chance);
  return chance > 0 && input.roll < chance;
}
