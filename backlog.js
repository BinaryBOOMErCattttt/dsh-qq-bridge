/**
 * 一波「迟到的消息」的纯函数：裁剪 + 渲染（行为规格见 docs/speaking.md「长任务期间的 @」）。
 *
 * 为什么单独一个模块：`index.js` 里只该做「把会话记录凑成入参」，而「这一波留几条、
 * 每条标多旧、开头怎么交代」全是 `普通入参 → 字符串`，不碰闭包也不碰磁盘 —— 与
 * `speech-policy.js` / `speaking-rules.js` 同一个位置，单测不必启动机器人。
 *
 * 一条纪律：**这里不做「合并同类项」，也不判哪句该接**。它只负责让模型看见「这些话是
 * 陆续到的、各自多旧」，接不接、接哪句由模型决定（出口是 SKIP）。阈值（条数 / 字数 /
 * 憋多久）只是防止它被一百条消息淹掉，不是语义判断。
 *
 * @module @qqbot/dsh-plugin-qq/backlog
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 把「多旧」写成模型读得懂的一句话。
 *
 * 只说粗粒度：这一波最多憋 `batchBacklogHoldMs`（默认两分钟），所以前几档就够用了；
 * 更长的两档是给把这个值配得很大（或者进程被挂起过）的部署留的 —— 宁可有话说，
 * 也不要退回「几乎同时」那种谎话。
 *
 * @param deltaMs - 距今多少毫秒；负数 / 非数字按「刚刚」（时钟回拨不该写成「-3 秒前」）。
 * @returns 例如 `刚刚` / `12 秒前` / `8 分钟前` / `2 小时前`。
 */
export function relativeTime(deltaMs) {
  const delta = Number(deltaMs);
  if (!Number.isFinite(delta) || delta < 15 * 1000) return '刚刚';
  if (delta < MINUTE) return `${Math.floor(delta / 1000)} 秒前`;
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} 分钟前`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)} 小时前`;
  return `${Math.floor(delta / DAY)} 天前`;
}

/** 折成一行：消息里的换行、连续空白都要压掉，否则「一行一条」的排布就断了。 */
function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 一条消息在积压波里的正文行。
 *
 * 普通消息折成一行；带合并转发块的消息保留多行（块本身已经排好版），续行由调用方
 * 缩进到发言人下面。`forward` 由 `submitBatch` 在转发展开成功时打上。
 *
 * @param entry - `{ name, body, forward }`。
 * @returns 至少一行的正文。
 */
function bodyLines(entry) {
  const text = String(entry?.body ?? '').trim();
  if (entry?.forward === true && text.includes('\n')) return text.split('\n');
  return [oneLine(text)];
}

/** 一条消息在预算里占多少字（名字 + 正文；时间与括号的固定开销忽略不计）。 */
function costOf(entry) {
  return String(entry?.name ?? '').length + String(entry?.body ?? '').length;
}

/**
 * 从一波里挑出真正要贴给模型的那几条。
 *
 * 两条规则（都是为了「别淹掉，也别丢最新的」）：
 *   - 条数超了：保留**最早 2 条**（那常常是这波真正的由头）+ **最近的一截**，中间折成
 *     「更早还有 N 条」。只留最近一截的问题是把「一开始找我干什么」丢了。
 *   - 字数超了：从最老的一头继续丢，**永远不会丢掉最后一条** —— 最后那条最可能还有活要干。
 *
 * @param entries - `{ name, body, at }[]`，按到达顺序。
 * @param options.maxEntries - 最多留几条（下限 2：至少「第一条 + 最后一条」）。
 * @param options.maxChars - 正文总字数上限（下限 1）。
 * @returns `{ kept, omitted }`：留下的条目与「没贴出来」的条数。
 */
export function partitionBacklog(entries, { maxEntries = 20, maxChars = 2000 } = {}) {
  const list = Array.isArray(entries)
    ? entries.filter((entry) => entry !== undefined && entry !== null)
    : [];
  const count = Math.max(2, Math.floor(Number(maxEntries)) || 0);
  const budget = Math.max(1, Math.floor(Number(maxChars)) || 0);
  // 至少 1 条「最早」+ 1 条「最新」；上限是 2 + 其余全给最近的一截。
  const head = Math.min(2, Math.max(1, count - 1));
  let kept = list.slice();
  if (kept.length > count) {
    const tail = count - head;
    kept = [...kept.slice(0, head), ...kept.slice(kept.length - tail)];
  }
  let total = kept.reduce((sum, entry) => sum + costOf(entry), 0);
  while (total > budget && kept.length > 1) {
    // 先丢「前两条之后最老的那条」；只剩前两条 + 最后一条时，再从最前面丢。
    const index = kept.length > head + 1 ? head : 0;
    total -= costOf(kept[index]);
    kept.splice(index, 1);
  }
  return { kept, omitted: list.length - kept.length };
}

/**
 * 把一波当成**一条** user message 交给模型。
 *
 * 与 `renderBatch` 的区别不是排版，而是**事实**：那些话不是「几乎同时到的」，是它在忙
 * 别的事的时候陆续到的。不给这个交代，模型会把八分钟前的问题当成刚发生的，接着答得
 * 驴唇不对马嘴；给了交代，它才有机会像人一样挑着接、或者干脆 SKIP。
 *
 * @param entries - `{ name, body, at }[]`，按到达顺序。
 * @param options.now - 当前时刻（毫秒），用来算相对时间。
 * @param options.maxEntries - 透传 `partitionBacklog`。
 * @param options.maxChars - 透传 `partitionBacklog`。
 * @param options.canLookup - 模型有没有 `qq_transcript`（有才提那句「翻记录」）。
 * @returns user message 正文；没有可贴的条目时返回空串。
 */
export function renderBacklog(entries, { now = Date.now(), maxEntries, maxChars, canLookup = false } = {}) {
  const { kept, omitted } = partitionBacklog(entries, { maxEntries, maxChars });
  if (kept.length === 0) return '';
  const at = Number(now);
  const lines = kept.flatMap((entry) => {
    const age = at - (Number(entry.at) || at);
    const prefix = `${String(entry.name ?? '某人')}（${relativeTime(age)}）: `;
    const [first, ...rest] = bodyLines(entry);
    return [`${prefix}${first}`, ...rest.map((line) => `  ${line}`)];
  });
  const parts = [
    '（你刚才在忙别的事，下面这些是那期间陆续到的消息，你现在才抬头看到）',
    ...lines,
  ];
  if (omitted > 0) {
    parts.push(
      canLookup
        ? `（更早还有 ${omitted} 条没贴出来；想查就用 qq_transcript 翻记录）`
        : `（更早还有 ${omitted} 条没贴出来）`,
    );
  }
  parts.push(
    '',
    '要接就接还活着的：谁还在等、哪句还没被别人答掉。别把它们当成刚发生的事，也别一条一条点着名字回答。',
    '想叫谁就用 [[@昵称]]；都过去了，就只写 SKIP。',
  );
  return parts.join('\n');
}
