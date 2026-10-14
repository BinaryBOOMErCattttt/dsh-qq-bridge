/**
 * 回复正文里的「@ 某人」标记：`[[@昵称]]` → OneBot 的 `at` 段。
 *
 * 为什么需要这个东西：模型只会写**纯文本**，而 QQ 的 @ 是消息里的一种**段**
 * （`{ type: 'at', data: { qq } }`）。没有标记这条通道，它想点名某个人就只剩一招 ——
 * 把 QQ 号当正文写出来（「@100000003 你来说」），那既不像真人，也让一串号码在群里裸奔。
 *
 * 所以渠道提示里**不再印任何 QQ 号**（见 index.js 的 `channelPrompt` / `speakerLine`），
 * 改用「谁刚才跟你说过话」的名单；模型写 `[[@名单里的昵称]]`，这里负责把它换成真正的
 * at 段。`@全体成员` 是唯一的通配写法，只在群聊里放行（见 `buildMentionResolver`）。
 *
 * 解析是**纯函数**（同样的输入永远同样的输出、不碰任何状态），因此可以单独测：
 * 标记的边界、畸形写法、「认不出来就丢」的失败方向都钉在 `test/mention.test.mjs` 里。
 *
 * @module @qqbot/dsh-plugin-qq/mention
 */

/**
 * 「这条正文要不要走标记解析」的探测门槛（字符）。
 *
 * 为什么要有上限：正常回复在几行之内（`maxReplyChars` 1500、单条目标长度 60），
 * 远超这个数的正文只可能出自某个畸形输入；对那种字符串做一次全量扫描没有意义。
 *
 * **只在没有标记时才按它截断**（见 `mentionSegments`）：有标记的正文一律整段解析，
 * 一个字都不丢 —— 否则一条超长回复会在第一个 `[[@…]]` 那里被悄悄截掉尾巴，
 * 「少了一段话」比「多一次扫描」严重得多。
 */
const MENTION_PROBE_CHARS = 4000;

/**
 * 标记里**不算昵称**的字符：`[` / `]` / 换行。中文昵称里 `（）` 很常见，所以不拦括号。
 *
 * 为什么要拦 `[`：正则遇到「写了一半的标记」（`[[@a]`）时会一路吃到行尾，把后面正常
 * 的正文也吞进「昵称」里。宁可让这种畸形写法落回普通文本（`[[@a]` 原样发出去），
 * 也不能悄悄吃掉半句话。
 */
const NAME_BREAK = /[[\]\n]/;

/**
 * 一个纯文本段。
 *
 * 刻意**不 trim** 传进来的内容：拆条的纯函数（`onebot.js` 的 `splitBurst`）按标点断句，
 * `[[@kaguya]] 你来说` 里的那个空格是断点之一 —— 位置完全由它决定，这里再动一次
 * 就会和它打架。
 */
function textSegment(text) {
  return { type: 'text', data: { text } };
}

/**
 * 一个名字能不能 @ 得出来。
 *
 * @param name - 标记里写的名字。
 * @param resolveMention - `(name) => string | undefined`：给出名字对应的 QQ 号
 *   （`'all'` 表示全体成员），认不出来返回 undefined。名单由调用方维护 ——
 *   本模块不持有任何状态。
 * @returns 要发出去的 `at` 段；认不出来时 undefined。
 */
function mentionSegment(name, resolveMention) {
  if (typeof resolveMention !== 'function') return undefined;
  const qq = resolveMention(name);
  const value = String(qq ?? '').trim();
  if (value.length === 0) return undefined;
  return { type: 'at', data: { qq: value } };
}

/**
 * 「@全体成员」的几种写法归一化。
 *
 * 模型可能写 `[[@全体成员]]`，也可能顺手写成 `[[@all]]`（提示词里两个都出现过）；
 * 两种都认，但只在**群聊**里才真的发得出去 —— 这个判断交给调用方。
 *
 * @param name - 标记里的名字。
 * @returns 是「全体成员」时为 true。
 */
export function isAllMention(name) {
  const value = String(name ?? '').trim().toLowerCase();
  return value === 'all' || value === '全体成员';
}

/**
 * 把一段回复正文里的 `[[@昵称]]` 换成 `at` 段，其余文字原样保留。
 *
 * **认不出来的名字整个丢掉**（而不是原样发出去）：留着就意味着一串 `[[@…]]` 直接糊到
 * 群里；而模型 @ 的多半是刚才跟它说话的人，正常路径下永远解析得到。丢掉的代价是
 * 「没 @ 上」，保留的代价是「群里出现一串乱码」，后者更糟。
 *
 * @param text - 一段正文（已经过拆条，一条消息的量）。
 * @param resolveMention - 见 {@link mentionSegment}。
 * @returns OneBot 消息段数组：`{ type: 'text' }` / `{ type: 'at' }`，按原文顺序；
 *   整段只有空白时为空数组。
 */
export function mentionSegments(text, resolveMention) {
  const raw = String(text ?? '');
  if (!raw.includes('[[')) {
    const plain = raw.slice(0, MENTION_PROBE_CHARS);
    return plain.trim().length > 0 ? [textSegment(plain)] : [];
  }
  const body = raw;
  const segments = [];
  // `from` 是「还没成为段的正文」的起点，`scan` 只用来找下一个标记：两者分开是必须的
  // —— 认不出来的标记要被吃掉，但它前面的那句话一个字都不能丢。
  let from = 0;
  let scan = 0;
  while (scan < body.length) {
    const start = body.indexOf('[[@', scan);
    if (start < 0) break;
    // 从名字的第一个字符开始扫，遇到 `[` / `]` / 换行就停下 —— 这一刀同时定义了两件事：
    // 名字到哪里结束，以及畸形标记（`[[@a]`）为什么不会吃穿整行。
    let end = start + 3;
    while (end < body.length && !NAME_BREAK.test(body[end])) end += 1;
    const closed = body.startsWith(']]', end);
    const name = body.slice(start + 3, end).trim();
    // 没闭合的（`[[@a`）与空名字（`[[@]]`）都不算标记：`from` 留在它前面（`scan` 往前走
    // 只是换个位置再找标记，它自己会留在最后那段正文里被原样发出去）。
    if (!closed || name.length === 0) {
      scan = start + 2;
      continue;
    }
    // 标记之前的正文先落地。**认不出来时也要落地**：变的是「标记没了」，不是「这半句没了」。
    if (start > from) segments.push(textSegment(body.slice(from, start)));
    const segment = mentionSegment(name, resolveMention);
    if (segment !== undefined) segments.push(segment);
    // 认不出来的标记就落在这段被跳过的区间里（下一段正文从 `end + 2` 接上）。
    from = end + 2;
    scan = from;
  }
  if (from < body.length) segments.push(textSegment(body.slice(from)));
  // 收尾：丢掉空段，并把被「吃掉的标记」切成两半的文字接回去。
  // 为什么不省这一步：`在吗 [[@查无此人]] 说句话` 会拆成两段文字，接回去之后
  // 「认出来的名字」与「认不出来的名字」得到的正文完全一样 —— 后者不该留下痕迹。
  const merged = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (segment.type === 'text') {
      if (segment.data.text.length === 0) continue;
      if (last?.type === 'text') last.data.text += segment.data.text;
      else merged.push(segment);
      continue;
    }
    merged.push(segment);
  }
  return merged;
}

/**
 * `[[@…]]` 标记的探测正则：**只用来判断「有没有」**，不参与切分。
 *
 * 切分由 {@link mentionSegments} 的扫描负责（它要处理未闭合、名字里有括号等情形，
 * 正则做不到）。留着这个独立的探测是因为「这条正文要不要走 @ 解析」是个高频问题：
 * 绝大多数回复里没有标记，先做一次廉价的 `includes`/`test` 就能直接原样发字符串，
 * 与旧行为逐字节一致。
 */
const MENTION_MARKER = /\[\[@[^[\]\n]*\]\]/;

/**
 * 这段正文里有没有 `[[@…]]` 标记（含 `@全体成员` 这种写法）。
 * @param text - 一段正文。
 * @returns 有标记时为 true。
 */
export function hasMentionMarker(text) {
  return MENTION_MARKER.test(String(text ?? ''));
}

/**
 * 从一份「昵称 → QQ 号」名单造一个解析函数。
 *
 * 名单的形状刻意是一组二元组而不是对象：同名不同人（群成员重名）在 QQ 里很常见，
 * 要能保留两个候选，按登记顺序先到先得。
 *
 * 名字比较**先精确、再忽略大小写**：英文昵称的大小写是随手写的，`Kaguya` 与 `kaguya`
 * 该算同一个人；而中文昵称走精确那条路，不受影响。
 *
 * @param entries - `{ name, id }[]`，调用方按「谁最可能被 @」排序（最近的发言者在前）。
 * @returns `(name) => string | undefined`；`buildMentionResolver` 与 `mentionSegments` 的入参。
 */
export function mentionResolverFrom(entries) {
  const list = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({ name: String(entry?.name ?? '').trim(), id: String(entry?.id ?? '').trim() }))
    .filter((entry) => entry.name.length > 0 && entry.id.length > 0);
  return (name) => {
    const value = String(name ?? '').trim();
    if (value.length === 0) return undefined;
    const exact = list.find((entry) => entry.name === value);
    if (exact !== undefined) return exact.id;
    const lower = value.toLowerCase();
    return list.find((entry) => entry.name.toLowerCase() === lower)?.id;
  };
}

/**
 * 给一个会话造解析函数。**@ 的名单就在这个会话自己身上**（`conversation.participants`，
 * 见 index.js 的 `registerParticipant`）：刚跟它说过话的人、群里最近冒过泡的人、私聊对方。
 *
 * 名单是**按会话隔离**的，所以会话之间不会串号 —— 在 A 群学到的昵称不可能被 @ 到 B 群去。
 *
 * @param conversation - 会话记录（要 `type` 与可选的 `participants`）。
 * @param options.allowAll - 这个会话允不允许 `@全体成员`。默认只允许群聊。
 * @returns `(name) => string | undefined`。
 */
export function buildMentionResolver(conversation, { allowAll } = {}) {
  const group = conversation?.type === 'group';
  const all = allowAll ?? group;
  const resolve = mentionResolverFrom(conversation?.participants);
  return (name) => {
    if (isAllMention(name)) return all ? 'all' : undefined;
    return resolve(name);
  };
}
