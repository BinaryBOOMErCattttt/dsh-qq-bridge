/**
 * 「这次为什么轮到它说话」的**纯判据**：把准入、A/C 抽卡、插话准入收成一个函数。
 *
 * 它回答的是一句话：这一条群消息该不该进 Agent，以及进去的话是哪种 `intent`：
 *
 *   - `addressed`  —— 被叫到（@ / 前缀 / `groupTrigger: all`）；
 *   - `continued`  —— A 路：一对一窗口里，正在跟它聊的那个人接着说；
 *   - `interject`  —— C 路：群里聊热了，抽中插话（这一轮回的是哪条见 `index.js` 的 quoteHead）；
 *   - `none`       —— 不接（只在内部用，调用方据此丢弃这条）。
 *
 * 为什么要把这件事从 `admit` 里搬出来（原先是四十多行 if 套 if）：
 *   - 它决定「群里什么时候会冒出一句话」，是全项目行为影响最大的一段，却最难测 ——
 *     藏在事件回调里只能从集成测试上观察；
 *   - 抽卡、热度的语义与 `speaking-rules.js` / `chatter.js` 是同一套，散在闭包里会
 *     慢慢长出第二份口径。
 *
 * 边界照旧：**纯函数**，没有 `ctx`、没有会话表、不读写磁盘、不记日志。随机数由调用方掷
 * （`roll`），所以每个分支都能用固定序列钉住。三本账一行不改 —— 这里只消费
 * `chatter` 算出来的数字（`groupHot` / `followAllowed` 由 index.js 凑好传进来）。
 *
 * @module @qqbot/dsh-plugin-qq/speech-policy
 */
import { activeTalkAllows, activeTalkChance } from './speaking-rules.js';

/**
 * C 路（插话）的四条排除，缺一条都不接。
 *
 * A 路已经有 `mentionsOthers` 这类判据（在 `speaking-rules.js` 的 `activeFollowAllows` 里），
 * C 路原先只要「群够热」就放行，于是一句「@小李 你看这个」也可能被它接走 —— 那是别人在
 * 跟别人说话。四条都在这里挡掉：
 *
 *   1. 这条 @ 了别人（或 @全体）→ 不是冲它来的；
 *   2. 这条是命令（`/reset` 之类）→ 命令不该被「插话」顺手执行；
 *   3. 这条是纯媒体、没有文字 → 没有可接的话头（锚点必须是文字，§7.3）；
 *   4. 这条来自机器人自己 → 调用方已经排除（这里再兜一层）。
 *
 * @param {object} input - 见 {@link decideGroupTurn}。
 * @returns `string|undefined`：被排除的原因；没被排除时 undefined。
 */
export function interjectExclusion(input) {
  if (input.selfMessage === true) return 'self';
  if (input.mentionsOthers === true) return 'mentions-others';
  if (input.isCommand === true) return 'command';
  if (input.hasText !== true) return 'media-only';
  return undefined;
}

/**
 * 这条群消息该不该进 Agent、以什么身份进。
 *
 * 判据顺序就是「该有多确定」的顺序：
 *   1. 被明确叫到 → 直接 `addressed`，不抽卡（这是唯一不需要理由的开口）；
 *   2. 空消息 → `none`（空 @ 的替身由调用方处理，不消耗抽卡计数）；
 *   3. 这个群还没有会话记录 → `none`（闲聊不该凭空把群变成「处理过」的会话）；
 *   4. 够资格（A 路窗口里，或 C 路群够热）→ **抽一次卡**（A/C 共用，见 `activeTalkChance`）：
 *      掷中就 `continued` / `interject`，没掷中就 `none` 并把「连丢」交给调用方 +1；
 *   5. 不够资格 → `none`（调用方据此把「连丢」清零：这段对话凉了）。
 *
 * @param {object} input
 * @param {boolean} input.explicit - 被叫到（@ / 前缀 / groupTrigger: all）。
 * @param {boolean} input.blank - 这条是空消息（只有 @ 或空格）。
 * @param {boolean} input.existing - 这个群已经有会话记录。
 * @param {boolean} input.followAllowed - A 路：`activeFollowAllows` 的结果。
 * @param {boolean} input.groupHot - C 路：`chatter.isHot` 的结果（群聊热不热）。
 * @param {boolean} [input.mentionsOthers] - 这条 @ 了别人（C 路排除）。
 * @param {boolean} [input.isCommand] - 这条是命令（C 路排除）。
 * @param {boolean} [input.hasText] - 这条有文字（C 路排除纯媒体）。
 * @param {boolean} [input.selfMessage] - 这条是机器人自己发的（兜底排除）。
 * @param {number} input.misses - 这段对话里已连丢几条（`conversation.talkMisses`）。
 * @param {number} input.chance / input.chanceStep / input.chanceMax - 抽卡参数。
 * @param {number} input.roll - 已掷好的 0~1 随机数。
 * @returns `{ intent: 'addressed'|'continued'|'interject'|'none', reason: string, eligible: boolean, chance: number }`。
 */
export function decideGroupTurn(input) {
  if (input.selfMessage === true) return { intent: 'none', reason: 'self', eligible: false, chance: 0 };
  if (input.explicit === true) return { intent: 'addressed', reason: 'explicit', eligible: false, chance: 0 };
  if (input.blank === true) return { intent: 'none', reason: 'blank', eligible: false, chance: 0 };
  if (input.existing !== true) return { intent: 'none', reason: 'no-conversation', eligible: false, chance: 0 };
  const follow = input.followAllowed === true;
  const hot = input.groupHot === true;
  if (!follow && !hot) return { intent: 'none', reason: 'not-eligible', eligible: false, chance: 0 };
  // C 路（只有热度、没有一对一窗口）先过四条排除：别人在跟别人说话时别抢。
  if (!follow) {
    const excluded = interjectExclusion(input);
    if (excluded !== undefined) return { intent: 'none', reason: excluded, eligible: false, chance: 0 };
  }
  const chance = activeTalkChance(input.chance, input.chanceStep, input.chanceMax, input.misses);
  const hit = activeTalkAllows({ eligible: true, chance, roll: input.roll });
  if (!hit) return { intent: 'none', reason: 'roll', eligible: true, chance };
  // 一对一窗口优先：那说明它在跟具体某个人聊，而不是在热群里随便接一句。
  return { intent: follow ? 'continued' : 'interject', reason: follow ? 'follow' : 'hot', eligible: true, chance };
}

/**
 * 「插话」那一轮的 user message 前缀（§7.2）。
 *
 * 现在的写法是 `kaguya: 晚上吃啥` —— 模型于是按「回答 kaguya」组织语言，群里看到的是
 * 答非所问 / 自来熟。**kaguya 并没有问它**。所以要把两件事分开说：
 *   - 第一行是元信息：这是群里的聊天，不是叫你；
 *   - 第二行是选择权：想接就接这一句，不想接就 SKIP。
 *
 * 刻意不暴露机制（不说「插件检测到群里很热」）—— 只说「群里在聊天」。
 *
 * @param {string} speaker - 说话的人（锚点那条的显示名）。
 * @param {string} body - 锚点那条的正文（可能很长时由调用方截断）。
 * @param {boolean} imageAllowed - 能不能发图（不能就不提只发表情）。
 * @returns 一段可以直接拼在正文前面的中文说明。
 */
export function interjectLine(speaker, body, imageAllowed = false) {
  const name = String(speaker ?? '').trim() || '有人';
  const text = String(body ?? '').replace(/\s+/g, ' ').trim();
  return [
    `（群里在聊天，这句不是叫你的。${name} 说：${text}）`,
    imageAllowed
      ? '你要接就接这一句，别把它当成在问你；不想接就只写 SKIP，或者只发一张表情。'
      : '你要接就接这一句，别把它当成在问你；不想接就只写 SKIP。',
  ].join('\n');
}

/**
 * 「几乎同时到的几条」在插话轮里的说明（一批里不止一条时）。
 *
 * 为什么不给每一行都套一个「不是叫你的」：那会把 batch 渲染成一大段提醒，模型更容易
 * 只挑最后一句。元信息说一次、下面照常列「谁：什么」，最后给选择权就够。
 *
 * @param {boolean} imageAllowed - 能不能发图。
 * @returns 两行说明（为空数组时表示不需要）。
 */
export function interjectBatchPrompt(imageAllowed = false) {
  return [
    '（下面这些是群里刚才的聊天，都不是叫你的）',
    `你要接就接其中一句，别把它们当成在问你；不想接就只写 SKIP${imageAllowed ? '，或者只发一张表情' : ''}。`,
  ];
}
