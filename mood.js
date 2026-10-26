/**
 * 心情门控：模型给心情打分，插件决定「这一轮能不能发表情」。
 *
 * 为什么要有它：表情是最容易被滥用的表达 —— 模型一旦发现「发一张表情就能结束这一轮」，
 * 它会在所有轮次里都发。所以门控不能靠提示词自觉（它只看得到「别滥用」，看不到代价），
 * 得有一条**机械**的限制：心情分满阈值才放行一次，或者用户明确要表情时放行一次。
 *
 * 分工照快照：**打分的是模型**（被夸 / 被损时在正文末尾写 `[[mood:upN]]` /
 * `[[mood:downN]]`），**解析与删 tag 的是插件**（模型不该看见自己的 tag 被回灌），
 * **判断「用户是不是在要表情」的也是模型**（它就是读聊天记录的那一方，插件读文本猜只会
 * 猜错）。插件只做三件机械的事：累分、冷场衰减、放行 / 拒绝。
 *
 * 分数按会话独立存在 `data/chat-state.json` 的 `mood` 段（与米饭 / 木鱼共用一本账）：
 * 一个群热络不该让另一个群也突然可以发表情；重启之后心情也没必要重来（那等于每次重启
 * 都送一次表情许可）。
 *
 * 「满阈值只放行一次、放完清零」是刻意的：心情满了 = 这一刻气氛够，发一张；发完就回到
 * 零，下一次要靠新的夸奖 / 玩笑重新攒。不这样做的话，阈值一旦达到就永久开着，
 * 门控等于没有。
 *
 * 这个模块碰的是 `gameData` / `save` 这两个**由 index.js 递进来的动作**，不 import
 * `index.js`（会成环），也不自己读磁盘 —— 单测可以直接喂一份假账本。
 *
 * @module @qqbot/dsh-plugin-qq/mood
 */

/** 单次衰减乘数：每安静一个 `moodDecayIdleMs`，分数乘它。 */
const DECAY_FACTOR = 0.75;

/**
 * 建一个心情门控。
 *
 * @param deps - 依赖表：
 *   - `settings`：`moodMax` / `moodTagMax*` / `moodTrigger*` / `moodDecayIdleMs` /
 *     `moodZeroIdleMs`（已在 settings.js 夹紧）；
 *   - `gameData(name)`：取 `data/chat-state.json` 里的一段（与其它小功能共用）；
 *   - `save()`：标脏落盘（chat-state 自己合并写盘）；
 *   - `appModeOf()`：现读运行模式（门控要认斗图模式）；
 *   - `moduleEnabled(name)`：`moduleEmojiMood` 关掉时整条门控放行；
 *   - `report(level, message)`：日志（心情满阈值时记一条 info，方便排查）。
 * @returns 见文件末尾的返回对象。
 */
export function createMoodGate({
  settings,
  gameData,
  save = () => {},
  appModeOf = () => 'full',
  moduleEnabled = () => true,
  report = () => {},
}) {
  /**
   * 取（或建）某个会话的心情记录。
   *
   * 字段：
   *   - `score`：0..moodMax；
   *   - `lastAt`：上一次有动静的时刻（打分 / 发图 / 衰减结算），冷场从它算起；
   *   - `grant`：满阈值后的一次性表情许可；
   *   - `request`：旧版本留下的「用户要表情」标记（现在由工具参数直接放行，
   *     保留字段只是为了不改旧账本的结构）。
   *
   * 为什么容错到每个字段：这份账是手写 JSON、也可能被旧版本写过；一个字段类型不对
   * 就让整份心情失效不值得（丢的只是分数）。
   * @param conversation - 目标会话。
   * @returns 心情记录（就地挂在账本上）。
   */
  function moodFor(conversation) {
    const all = gameData('mood');
    const key = conversation.key;
    if (all[key] === undefined || all[key] === null || typeof all[key] !== 'object') {
      all[key] = { score: 0, lastAt: Date.now(), grant: false, request: false };
    }
    const mood = all[key];
    if (typeof mood.score !== 'number' || !Number.isFinite(mood.score)) mood.score = 0;
    if (typeof mood.lastAt !== 'number' || !Number.isFinite(mood.lastAt)) mood.lastAt = Date.now();
    if (typeof mood.grant !== 'boolean') mood.grant = false;
    if (typeof mood.request !== 'boolean') mood.request = false;
    return mood;
  }

  /** 心情上限（settings.js 已夹到 1..100）。 */
  function moodMax() {
    return Math.max(1, Math.min(100, Math.round(Number(settings.moodMax) || 100)));
  }

  /** 单次 mood tag 的涨幅上限：简洁模式默认只有完整模式的一半。 */
  function moodTagCap() {
    const cap = appModeOf() === 'simple' ? settings.moodTagMaxSimple : settings.moodTagMaxFull;
    return Math.max(1, Math.min(moodMax(), Math.round(Number(cap) || 1)));
  }

  /** 放行一次表情所需的分数：简洁 / 完整各有一套阈值。 */
  function moodTrigger() {
    const trigger = appModeOf() === 'simple' ? settings.moodTriggerSimple : settings.moodTriggerFull;
    return Math.max(1, Math.min(moodMax(), Math.round(Number(trigger) || moodMax())));
  }

  /**
   * 冷场衰减：安静 `moodDecayIdleMs` 乘 0.75，安静到 `moodZeroIdleMs` 直接归零。
   *
   * 为什么用「隔了 n 个间隔」一次乘完，而不是每次调用只乘一次：这个函数只在收到消息时
   * 被调用，群里没人说话时它根本不会跑 —— 按次数衰减会漏掉整段安静期，心情永远停在
   * 上次离开时的样子。按时间算才能表达「冷场」。
   *
   * 分数掉到阈值以下时**顺手收回还没有用掉的那次许可**：许可代表「现在气氛够」，
   * 冷场之后气氛已经没了；留着它等于让下一句无关的话也能发表情。
   * @param conversation - 目标会话。
   */
  function decayMood(conversation) {
    const mood = moodFor(conversation);
    const idle = Date.now() - mood.lastAt;
    const zeroAfter = Math.max(1000, Number(settings.moodZeroIdleMs) || 1_200_000);
    if (idle >= zeroAfter) {
      mood.score = 0;
      mood.grant = false;
      mood.request = false;
      mood.lastAt = Date.now();
      save();
      return;
    }
    const step = Math.max(1000, Number(settings.moodDecayIdleMs) || 180_000);
    const steps = Math.floor(idle / step);
    if (steps > 0) {
      mood.score = Math.max(0, Math.round(mood.score * DECAY_FACTOR ** steps));
      if (mood.score < moodTrigger()) mood.grant = false;
      mood.lastAt = Date.now();
      save();
    }
  }

  /**
   * 解析回复里的 `[[mood:upN]]` / `[[mood:downN]]`，返回去掉 tag 的正文。
   *
   * 只认数字 1..cap：模型偶尔会写 `[[mood:up10]]` 或 `[[mood:up0]]`，前者按 cap
   * 截断、后者按 1 算 —— 让「写大了」不至于直接送满一次许可，也让「写 0」不会变成
   * 一个永远无法触发的空操作。
   *
   * 删 tag 之后会并掉多余空格：tag 通常贴在句末，不清理会留下「。  」这种尾巴。
   * **不做更多文本加工** —— 分条、标点清洗是发送链路的活，这里改多了会和那边打架。
   * @param text - 模型这一轮的正文。
   * @param conversation - 目标会话。
   * @returns 去掉 tag 的正文（没有 tag 时逐字返回）。
   */
  function applyMoodTags(text, conversation) {
    const raw = String(text ?? '');
    if (!raw.includes('[[mood:')) return raw;
    const mood = moodFor(conversation);
    const cap = moodTagCap();
    let score = mood.score;
    let touched = false;
    const cleaned = raw.replace(/\[\[mood:(up|down)\s*(\d{1,3})\]\]/giu, (_match, dir, amount) => {
      const value = Math.max(1, Math.min(cap, Math.round(Number(amount) || 0)));
      score = Math.max(0, Math.min(moodMax(), score + (String(dir).toLowerCase() === 'down' ? -value : value)));
      touched = true;
      return '';
    }).replace(/\s{2,}/gu, ' ').trim();
    if (!touched) return raw;
    mood.score = score;
    mood.lastAt = Date.now();
    if (score >= moodTrigger()) {
      mood.grant = true;
      report('info', `${conversation.key} 心情 ${score}/${moodMax()}，放开一次表情许可`);
    }
    save();
    return cleaned;
  }
  /**
   * 这一轮能不能发表情：`free`（不受门控）/ `request`（用户明确要）/ `mood`（心情满）。
   *
   * 单独成函数而不是返回布尔：放行之后要按**哪一种**放行做不同的收尾 —— 心情许可
   * 用掉就清零，用户请求不消耗心情。返回字符串让调用方不需要再猜一遍原因。
   *
   * 斗图模式无条件 `free`：这个模式的语义就是「表情常驻」，再让它受心情限制等于
   * 切进斗图之后还要先夸它几句才能发图。
   * @param conversation - 目标会话（工具路径下调用方从 exec 反查；查不到 = 不受门控）。
   * @param requested - 模型判断「用户明确要表情」（`qq_send_image` 的 `user_requested`）。
   * @returns {'free' | 'request' | 'mood'} 放行原因。
   * @throws 既没满阈值、用户也没要时抛错 —— 调用方据此拒绝发送。
   */
  function moodStickerBefore(conversation, requested = false) {
    if (conversation === undefined) return 'free';
    if (appModeOf() === 'sticker') return 'free';
    if (!moduleEnabled('emojiMood')) return 'free';
    if (requested === true) return 'request';
    const mood = moodFor(conversation);
    if (mood.grant === true) return 'mood';
    throw new Error('表情权限没开：要么模型判断用户明确要表情（user_requested），要么心情满阈值后再发');
  }

  /**
   * 发出去之后收尾：心情许可用掉就清零，用户请求只清标记。
   *
   * 只在**真的发出去之后**调用（发送失败不消耗许可）：模型下一轮还应该能再试一次。
   * @param conversation - 目标会话。
   * @param kind - `moodStickerBefore` 的返回值。
   */
  function moodStickerAfter(conversation, kind) {
    if (conversation === undefined) return;
    const mood = moodFor(conversation);
    if (kind === 'mood') {
      mood.grant = false;
      mood.score = 0;
    } else if (kind === 'request') {
      mood.request = false;
    }
    mood.lastAt = Date.now();
    save();
  }

  return {
    moodFor,
    max: moodMax,
    tagCap: moodTagCap,
    trigger: moodTrigger,
    decay: decayMood,
    applyTags: applyMoodTags,
    stickerBefore: moodStickerBefore,
    stickerAfter: moodStickerAfter,
  };
}
