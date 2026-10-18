/**
 * 最小可用的 OneBot v11 客户端，只用一个 WebSocket 连接。
 *
 * 刻意不依赖任何第三方库：只用 Node 全局的 `WebSocket` / `setTimeout`，所以本插件
 * 不需要运行时依赖。OneBot 协议的双向流量共用同一条 socket：
 *   - 服务端主动推送的事件（事件上报）直接交给 onEvent；
 *   - 插件发起的 API 调用通过 `echo` 字段与响应配对。
 *
 * @module qq-bridge/onebot
 */

/**
 * 感知层的纯函数搬去了 `modalities.js`（见该模块头部的理由）。
 * 这里 import 是为了 `collectMedia` 的标签与 `messageToText` 的渲染；
 * 同时**再导出** `mediaLabel` / `mediaPlaceholder`：`index.js` / `memory.js` /
 * `test/bridge.test.mjs` 一直是从本模块取这两个名字的，搬走实现不该动调用方。
 */
import { mediaLabel, mediaPlaceholder, renderMessage } from './modalities.js';

// 再导出：`index.js` / `memory.js` / `test/bridge.test.mjs` 一直从本模块取这两个名字，
// 搬走实现不该动调用方（AGENTS.md §3「往外搬模块」第 2 条）。
export { mediaLabel, mediaPlaceholder };

/** 重连退避的下限与上限（毫秒）。 */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;

/** API 调用的默认超时（毫秒）：超时即 reject，避免调用方永久挂起。 */
const CALL_TIMEOUT_MS = 15000;

/**
 * 收集一条消息里所有可以落到本地的媒体段。
 *
 * 两类都要管，因为不同 OneBot 实现给的东西不一样：
 *   - `image`：普通图片，以及 **NapCat 上报的商城表情**（它把 marketFaceElement 直接
 *     转成 image，并附上 `summary` 表情名与腾讯 CDN 的 `url`）；
 *   - `mface`：其它实现（Lagrange / go-cqhttp）发的商城表情，通常只有 `emoji_id` 和
 *     `summary`，没有可直接下载的 URL —— 这种情况只能退化成一句文字标签。
 *
 * @param message - OneBot 的 `message` 字段（消息段数组；CQ 码字符串会得到空数组）。
 * @returns `{ index, kind, label, url, file, declaredBytes }` 数组，`index` 是段下标，
 *   供 {@link messageToText} 用它替换回文本。
 */
export function collectMedia(message) {
  if (!Array.isArray(message)) return [];
  const items = [];
  message.forEach((segment, index) => {
    const type = segment?.type;
    if (type !== 'image' && type !== 'mface') return;
    const data = segment?.data ?? {};
    const declared = Number(data.file_size);
    items.push({
      index,
      kind: type,
      label: mediaLabel(data.summary),
      url: typeof data.url === 'string' ? data.url : '',
      file: typeof data.file === 'string' ? data.file : '',
      declaredBytes: Number.isFinite(declared) && declared > 0 ? declared : undefined,
    });
  });
  return items;
}

/**
 * 把 OneBot 的 `message` 字段拍平成纯文本。
 * @param message - 消息段数组（array 上报格式）或原始字符串（CQ 码格式）。
 * @param skipAtId - 可选：指定某个 QQ 号的 `at` 段被丢弃而不是渲染；
 *   传机器人自己的 QQ 号，`@bot你好` 就变成 `你好`，无需猜测昵称在哪里结束。
 * @param media - 可选：`段下标 → 替身文本` 的映射（`collectMedia()` 的下标 +
 *   落盘后的 {@link mediaPlaceholder}）。命中时该段整体用这个文本替换，于是
 *   「有没有图」连同「图在哪个文件」一起进入正文；不传就只是朴素占位符
 *   （群聊环境上下文正是这样：那些消息不会有人读，不值得为它们下载）。
 * @returns 可读的消息文本。
 */
export function messageToText(message, skipAtId, media) {
  // 实现本体在感知层：这里只保留老的位置参数签名（`index.js` / `memory.js` 都在用），
  // 输出与搬走前逐字节一致。
  return renderMessage(message, { skipAtId, media });
}

/**
 * 「这条消息没有正文」时，摆在正文位置告诉模型发生了什么的那句话。
 *
 * 为什么需要一个替身而不是留空：`messageToText` 会把 `at` 段整个剔掉，于是「@ 它一下」
 * 和「发一个空格」得到的都是空串 —— 模型只看到一条空消息，既不知道为什么轮到它说话，
 * 也不知道该对什么作反应。写明触发原因之后，「被点名了但对方什么都没说」这件事本身就
 * 是上下文，它可以照常去翻聊天记录与环境上下文，再决定回「？」、发表情包还是接上一句。
 *
 * 三种情形分开写，因为对模型的含义不同：
 *   - 群里 @ 了它 → 明确点了名，只是没说事；
 *   - 群里没 @（`groupTrigger: all` 或活跃对话窗口接上的一句）→ 只是这句话是空的，
 *     别让模型以为对方点了它；
 *   - 私聊 → 没有 @ 这回事，就是一条空消息。
 *
 * @param options - `group`：是不是群聊；`mentionedMe`：群里这句有没有 @ 机器人。
 * @returns 一段中文说明。
 */
export function blankMessageLabel({ group = false, mentionedMe = false } = {}) {
  if (!group) return '（对方发来一条空消息，什么都没写）';
  return mentionedMe ? '（@了你一下，没有说别的）' : '（一条空消息，没有正文）';
}

/**
 * 取一条消息里「值得复读的原文」。
 *
 * 复读机只跟**纯文字**：整条消息都由 `text` 段组成时才返回正文，其余消息
 * （图片、表情包、语音、卡片，以及带 `at` 的「@某人 …」）一律返回 undefined。
 * 两个理由：
 *   - 复读 `at` 段等于再 @ 人家一次，图和文件更没法原样发回（入站只有会过期的 URL）；
 *   - 「跟着说一句同样的话」才是复读，把 `[图片]` 这种占位符复读出去只是噪音。
 *
 * CQ 码字符串（非 array 上报格式）里面藏了什么看不出来，含 `[CQ:` 就直接放弃。
 *
 * @param message - OneBot 的 `message` 字段。
 * @returns 原始正文（未 trim，由调用方决定怎么归一化）；不该复读时 undefined。
 */
export function repeatableText(message) {
  if (typeof message === 'string') return message.includes('[CQ:') ? undefined : message;
  if (!Array.isArray(message)) return undefined;
  let text = '';
  for (const segment of message) {
    if (segment?.type !== 'text') return undefined;
    if (typeof segment.data?.text === 'string') text += segment.data.text;
  }
  return text;
}

/**
 * 这条**入站**消息段是不是「表情」（而不是普通图片）。
 *
 * 只有一个用途：复读把这张图发回去时，要不要带 QQ 的「大表情」标记（`sub_type: 1`，
 * 见 `image.js` 的 `imageSegment`）。同一张图当表情发和当图片发，QQ 的渲染完全不同
 * （表情没有图片气泡、按表情尺寸显示；图片按原图像素铺开、还可能带边框）—— 复读要的是
 * 「原样接上一张」，所以得连「它是个表情」这件事一起接上，否则群里看到的是照片样式的图。
 *
 * 判据只看 OneBot 给的**结构字段**，不猜 `summary` 那种给人看的文字：
 *   - `mface` 段本身就是商城表情；
 *   - NapCat 把 QQ 的 `picSubType` 原样放进 `image.data.sub_type`，非 0 就是表情
 *     （OneBot 生态的约定，与出站方向我们带的 `sub_type: 1` 是同一个字段）；
 *   - NapCat 上报的商城表情会被折成 `image` 段，但会多带 `emoji_id`（普通图片没有）。
 *
 * 只回一个布尔值：这些字段来自不可信的群消息，绝不能被原样转发回 QQ。
 *
 * @param segment - 一个 OneBot 消息段。
 * @returns 是表情时为 true。
 */
export function isStickerSegment(segment) {
  if (segment?.type === 'mface') return true;
  if (segment?.type !== 'image') return false;
  const data = segment.data ?? {};
  const subType = Number(data.sub_type);
  if (Number.isFinite(subType) && subType > 0) return true;
  return typeof data.emoji_id === 'string' && data.emoji_id.length > 0;
}

/**
 * 这条消息是不是「只有表情，没有一个字」。
 *
 * 只有一个用途：**回复它时不挂引用**。引用一段纯表情，QQ 会把那张表情在引用块里再贴
 * 一遍 —— 看的人只会觉得它在郑重其事地回一张图，而表情本来就只是一个反应。带文字的
 * 消息不算（文字才是那个可以「接」的话头，引用它是有意义的）。
 *
 * 表情按**协议字段**认（`mface` / `sub_type` 非 0 / `emoji_id` / `face`），不看渲染后的
 * 占位符；`reply` / `at` 这类段落是元信息，不影响「这条消息里有没有字」的判断。
 *
 * @param message - OneBot 的 `message` 字段（通常是消息段数组；字符串形态一律当普通消息）。
 * @returns 只有表情时为 true。
 */
export function isEmojiOnlyMessage(message) {
  if (!Array.isArray(message) || message.length === 0) return false;
  let emoji = false;
  for (const segment of message) {
    const type = segment?.type;
    if (type === 'text') {
      if (String(segment?.data?.text ?? '').trim().length > 0) return false;
      continue;
    }
    if (type === 'reply' || type === 'at') continue;
    if (isStickerSegment(segment) || type === 'face') {
      emoji = true;
      continue;
    }
    // 图 / 语音 / 视频 / 文件 / 卡片这些是「有内容的东西」，不算表情。
    return false;
  }
  return emoji;
}

/**
 * 判断消息段数组里是否 @ 了某个确定的 QQ 号。
 * 用于群消息的 mention 触发判定。
 * @param message - OneBot 的 `message` 字段。
 * @param selfId - 机器人自己的 QQ 号（字符串）。
 * @returns 存在指向该账号的 `at` 段时为 true。
 */
export function mentions(message, selfId) {
  if (selfId === undefined || selfId === null || selfId === '' || !Array.isArray(message)) return false;
  return message.some((segment) => segment?.type === 'at' && String(segment?.data?.qq) === String(selfId));
}

/**
 * 这条消息是不是明确在 @ **别人**（而不是机器人自己）。
 *
 * 只有一个用途：活跃对话里判断「他这一句还是跟我说吗」—— 群里的人一旦 @ 了别人
 * （`at` 的 qq 是 `all` 也算，那是喊所有人），这句就明确是冲着别人去的，不该被当成
 * 接话抢答。与 `mentions` 一样按**消息段**判定，而不是在扁平文本里找 `@`：
 * `messageToText` 会把 `@某人` 渲染成文本，从正文里猜很容易误伤普通内容。
 *
 * @param message - OneBot 的 `message` 字段。
 * @param selfId - 机器人自己的 QQ 号（字符串）。
 * @returns 存在指向别人的 `at` 段时为 true。
 */
export function mentionsOthers(message, selfId) {
  if (!Array.isArray(message)) return false;
  return message.some((segment) => {
    if (segment?.type !== 'at') return false;
    const qq = String(segment?.data?.qq ?? '');
    return qq.length > 0 && qq !== String(selfId);
  });
}

/**
 * 这条消息在 @ 哪些**别人**（带上能拿到的名字）。
 *
 * 与 {@link mentionsOthers} 的区别：那个只回答「有没有 @ 别人」（活跃对话的判据），
 * 这个要把人**列出来**，好登记进「这个会话里谁可以被 @」的名单 —— 有人 @ 过某个人，
 * 那个人显然就在这个群里，机器人之后也该能 @ 到他。机器人与 `@全体成员` 都不登记
 * （前者是它自己，后者不是一个具体的人）。
 *
 * @param message - OneBot 的 `message` 字段。
 * @param selfId - 机器人自己的 QQ 号（这一票排除掉）。
 * @returns `{ id, name }[]`：`name` 可能为空串（有些实现不给 `at` 段带名字）。
 */
export function atMentions(message, selfId) {
  if (!Array.isArray(message)) return [];
  const seen = new Set();
  const list = [];
  for (const segment of message) {
    if (segment?.type !== 'at') continue;
    const id = String(segment?.data?.qq ?? '').trim();
    if (id.length === 0 || id === String(selfId) || id === 'all') continue;
    if (seen.has(id)) continue;
    seen.add(id);
    list.push({ id, name: String(segment?.data?.name ?? '').trim() });
  }
  return list;
}

/**
 * 这次该用哪个名字称呼发消息的人。
 *
 * 优先**群名片**（`card`，群里大家都这么叫他），其次是昵称，都没有才退回兜底。
 * 群聊与私聊用同一套顺序，而不是各挑一个字段：投递给模型的正文里写着 `名字: 内容`，
 * 模型照着写 `[[@名字]]` —— 两处一旦不一致，@ 就会解析不到（历史上群聊取 card、
 * 私聊取 nickname，正是这种「同一件事两处各算一遍」的隐患）。
 *
 * @param sender - OneBot 事件的 `sender` 字段。
 * @param fallback - 连昵称都没有时的兜底（通常是 QQ 号本身）。
 * @returns 非空的显示名。
 */
export function userDisplayName(sender, fallback) {
  const card = String(sender?.card ?? '').trim();
  const nickname = String(sender?.nickname ?? '').trim();
  const name = card || nickname;
  return name.length > 0 ? name : String(fallback ?? '').trim();
}

/**
 * 找出「这条消息在回复哪一条」：`reply` 段的下标与它指向的 message_id。
 *
 * `reply` 段里只有 id —— OneBot v11 不带被引用消息的任何内容（没有正文、没有
 * `url`/`file`），所以想看见被引用的那条（尤其是里面的图），必须另外调 `get_msg`；
 * 下标则用来在渲染正文时把 `[回复]` 这个占位符换成真正的引用前缀。
 * 一条消息里理论上只该有一个 `reply` 段，取第一个即可。
 *
 * @param message - OneBot 的 `message` 字段（消息段数组；CQ 码字符串会得到 undefined）。
 * @returns `{ id, index }`；没有引用段时 undefined。
 */
export function findReply(message) {
  if (!Array.isArray(message)) return undefined;
  for (const [index, segment] of message.entries()) {
    if (segment?.type !== 'reply') continue;
    const raw = segment?.data?.id;
    if (raw === undefined || raw === null) continue;
    const id = String(raw).trim();
    if (id.length > 0) return { id, index };
  }
  return undefined;
}

/**
 * 在自然边界处把长文本切成 OneBot 能接受的多段。
 * 优先在换行处切；换行位置太靠前（不足半段）就退而求其次在空格处切；
 * 都没有就硬切在 limit 处。切完两端的空白会被裁掉。
 * @param text - 完整回复文本。
 * @param limit - 每段最大字符数（非法值回退到 1500）。
 * @returns 一个或多个非空分段。
 */
export function chunkText(text, limit) {
  const max = Number.isSafeInteger(limit) && limit > 0 ? limit : 1500;
  const chunks = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/**
 * 自然断句的优先级：先句末标点，最后句内标点。
 * 从强到弱依次尝试，保证切点尽量落在「说话停顿」的地方。
 * 换行不在这里：它已经是一条消息的边界，轮不到「断句」这一步（见 {@link splitBurst}）。
 */
const BURST_BOUNDARIES = [
  ['。', '！', '？', '!', '?', '…', '；', ';'],
  ['，', ',', '、', ' '],
];

/**
 * 在前 `max` 个字符里找最靠后的自然断点，返回切分下标（不含断点本身）。
 * 断点落在后半段（`max/2` 之后）才采用，否则退化成硬切在 `max` 处。
 * @param text - 待切分的文本（调用方保证长于 `max`）。
 * @param max - 本段的字符上限。
 * @returns 切分下标，取值在 `[floor(max/2), max]` 之间。
 */
function burstCut(text, max) {
  const floor = Math.floor(max / 2);
  for (const tier of BURST_BOUNDARIES) {
    for (let i = max - 1; i >= floor; i -= 1) {
      if (tier.includes(text[i])) return i + 1;
    }
  }
  return max;
}

/**
 * 在自然边界处把一段回复切成「像真人那样连着发」的几条短消息。
 *
 * 与 {@link chunkText} 的目的不同：`chunkText` 只保证不突破协议上限，
 * 这里追求的是「别一次糊一屏」——所以限制单条长度、并且限制一条长句最多拆几段。
 *
 * **换行一定是消息边界**：一行就是一条单独发出的消息。把换行留在正文里发出去，
 * QQ 那头看到的是「一条消息被排版成好几行」（像复制粘贴的文档），而不是真人那样
 * 连着说了几句 —— 所以这里先按换行切块，再对每一块按标点/长度拆。
 * 反过来说，`maxChars` / `maxParts` 只约束「把一条长句拆开」，
 * 不约束「模型自己写了几行」：模型显式写了 5 行就是要发 5 条（除非 `maxMessages` 封了顶）。
 *
 * 超过 `maxParts` 的余量会并进该行的最后一条（调用方还会再按协议上限硬分一次），
 * 避免模型偶尔写长了就刷屏。
 *
 * `maxMessages` 是再往上一层的总闸：一轮回复最多发几条。模型天然爱把一句话拆成
 * 两三条（甚至同一个 turn 里连着写两段 assistant 文本），光靠提示词压不住 ——
 * 这里给一个硬上限，超出的余量并进第 `maxMessages` 条。**并条时的接法分两种**：
 * 同一行内部本来就是被标点拆开的原文，直接接上（不留痕）；跨行的是一个空格 ——
 * 换行是模型自己写的停顿，粘成一个词（「在的」+「刚吃完」→「在的刚吃完」）比多一个
 * 空格难读得多。
 *
 * @param text - 模型给出的完整回复。
 * @param maxChars - 单条目标长度；非正数表示不按长度/标点拆（换行仍然拆）。
 * @param maxParts - 单行最多拆成几条（小于 2 视为 1，即不拆）。
 * @param maxMessages - 整条回复最多发几条；非正数（默认）= 不限，1 = 永远只发一条。
 * @returns 一个或多个分段；不需要拆时就是 `[text.trim()]`。
 */
export function splitBurst(text, maxChars = 60, maxParts = 3, maxMessages = 0) {
  const max = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : 0;
  const body = String(text ?? '').trim();
  if (body.length === 0) return [];
  const limit = Number.isSafeInteger(maxParts) && maxParts > 1 ? maxParts : 1;
  // 空行（连续换行）不算一条消息，顺带把每行两端的空白裁掉。
  const lines = body
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const cap = Number.isSafeInteger(maxMessages) && maxMessages > 0 ? maxMessages : 0;
  // 每条消息都记着自己来自第几行 —— 并条时靠它决定「直接接上」还是「补一个空格」。
  const messages = [];
  for (const [line, value] of lines.entries()) {
    if (max === 0 || value.length <= max) {
      messages.push({ text: value, line });
      continue;
    }
    // 单行内部先照常按 maxParts 拆，多出来的部分由下面的总上限兜底。
    let rest = value;
    let taken = 0;
    while (taken < limit - 1 && rest.length > max) {
      const cut = burstCut(rest, max);
      messages.push({ text: rest.slice(0, cut).trim(), line });
      rest = rest.slice(cut).trim();
      taken += 1;
    }
    if (rest.length > 0) messages.push({ text: rest, line });
  }
  const filled = messages.filter((item) => item.text.length > 0);
  if (cap === 0 || filled.length <= cap) return filled.map((item) => item.text);
  const kept = filled.slice(0, cap);
  for (const item of filled.slice(cap)) {
    const last = kept[kept.length - 1];
    last.text = last.line === item.line ? `${last.text}${item.text}` : `${last.text} ${item.text}`;
    // 记住刚接上的是哪一行：同一行剩下的余量要直接接上（不留空格），换行才补空格。
    last.line = item.line;
  }
  return kept.map((item) => item.text);
}

/**
 * 回复正文里的「表情包标记」：`[[图片: .qq-stickers/笑死.gif]]`。
 *
 * 为什么要有这个东西：工具调用发生在整轮回复**之前**，而且工具是 Agent 的显式动作，
 * 没法表达「这句话之后跟一张表情」这种顺序；更要紧的是「只发表情、一个字都不说」
 * 在纯文本回复里根本表达不出来（模型总得写点什么）。把表情写成正文里的一行，
 * 顺序就跟着行序走，整条回复只有这一行时自然就是一条文字都不发。
 *
 * 关键字给几种写法是刻意的：模型十有八九会按提示词里的 `[[图片: …]]` 写，但也可能
 * 顺手写成「表情包 / 表情 / sticker」。多认几个的成本只是正则，写错一个字的成本是
 * 把一行方括号原样糊到群里。
 */
const STICKER_MARKER = /\[\[\s*(?:图片|图片表情|表情包|表情|贴图|sticker|image|img)\s*[:：]\s*([^\]\n]*?)\s*\]\]/gi;

/**
 * 把一条回复正文切成「要一条条发出去的东西」：文字段与表情包段，按原文顺序。
 *
 * 标记可以出现在任何位置（不要求独占一行）：标记之间的文字原样留着，交给调用方
 * 按换行/长度继续拆。载荷是空的标记（`[[图片:]]`）不算数，当普通文字留下 ——
 * 与其静默吞掉一行，不如让这个错别字露出来。
 *
 * @param text - 模型给出的完整回复。
 * @returns `{ kind: 'text', text }` 与 `{ kind: 'image', source, raw }` 组成的数组；
 *   全空白时为空数组。`source` 是标记里那个路径或链接；`raw` 是标记原文，
 *   供调用方在「不能发图」时把它当普通文字发出去。
 */
export function splitStickerLines(text) {
  const body = String(text ?? '');
  const pieces = [];
  const pushText = (value) => {
    const trimmed = value.trim();
    if (trimmed.length > 0) pieces.push({ kind: 'text', text: trimmed });
  };
  let cursor = 0;
  for (const match of body.matchAll(STICKER_MARKER)) {
    const source = String(match[1] ?? '').trim();
    if (source.length === 0) continue;
    pushText(body.slice(cursor, match.index));
    pieces.push({ kind: 'image', source, raw: match[0] });
    cursor = match.index + match[0].length;
  }
  pushText(body.slice(cursor));
  return pieces;
}

/**
 * 估算「打出这么多字要多久」，用作发送前的拟人延迟。
 *
 * 真人回话的节奏 ≈ 读消息 + 打字；字数越多等得越久，但不是线性的确定值，
 * 所以按 `jitter` 比例加一点随机抖动（0 = 固定延迟，1 = 上下浮动 100%）。
 *
 * @param chars - 本条消息的字符数。
 * @param options - 速度与上下限；缺省值即插件默认配置。`baseMs` 是额外的固定延迟（例如「读消息」）。
 * @param random - 随机源，测试可注入固定值以获得确定性结果。
 * @returns 建议等待的毫秒数（非负整数）。
 */
export function typingDelayMs(chars, { charsPerSecond = 15, minDelayMs = 200, maxDelayMs = 5000, jitter = 0.4, baseMs = 0 } = {}, random = Math.random) {
  const cps = Number.isFinite(charsPerSecond) && charsPerSecond > 0 ? charsPerSecond : 15;
  const min = Number.isFinite(minDelayMs) && minDelayMs > 0 ? minDelayMs : 0;
  const max = Number.isFinite(maxDelayMs) && maxDelayMs >= min ? maxDelayMs : min;
  const typing = (Math.max(0, Number(chars) || 0) / cps) * 1000;
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 0;
  const raw = Math.min(max, Math.max(min, base + typing));
  const spread = Number.isFinite(jitter) ? Math.min(1, Math.max(0, jitter)) : 0;
  return Math.max(0, Math.round(raw * (1 + (random() * 2 - 1) * spread)));
}

/**
 * 一个自带重连的 OneBot v11 WebSocket 客户端。
 *
 * 事件通过 `onEvent` 回调交付；API 调用通过 `call` 方法返回 Promise。
 * 客户端绝不会把异常抛回 socket 自身的回调：调用方（消费方）的失败一律
 * 通过 `onError` 上报，这样一个坏处理器不会把连接搞断。
 */
export class OneBotClient {
  // 连接参数与观察者回调
  #endpoint;
  #accessToken;
  #onEvent;
  #onError;
  #onStateChange;
  // 运行态：当前 socket、退避延迟、重连定时器、是否已销毁
  #socket = null;
  #retryDelay = RETRY_MIN_MS;
  #retryTimer = null;
  #disposed = false;
  // echo → { resolve, reject, timer, action }，等待响应的 API 调用
  #pending = new Map();
  #echoCounter = 0;
  #selfId = '';
  #connected = false;

  /**
   * @param options - 连接目标与观察者。
   * @param options.endpoint - OneBot WebSocket 地址。
   * @param options.accessToken - 可选，作为 `Authorization: Bearer` 发送。
   * @param options.onEvent - 接收每条已解码的事件对象。
   * @param options.onError - 接收值得记录的内部错误。
   * @param options.onStateChange - 接收 `(connected, selfId)` 状态变化。
   */
  constructor({ endpoint, accessToken = '', onEvent, onError, onStateChange }) {
    this.#endpoint = endpoint;
    this.#accessToken = accessToken;
    this.#onEvent = onEvent;
    this.#onError = onError ?? (() => {});
    this.#onStateChange = onStateChange ?? (() => {});
  }

  /** 机器人自己的 QQ 号；服务端返回 get_login_info 后才有值。 */
  get selfId() {
    return this.#selfId;
  }

  /** 当前 socket 是否处于打开状态。 */
  get connected() {
    return this.#connected;
  }

  /** 开始连接，并在断开后持续重连，直到调用 {@link dispose}。 */
  start() {
    this.#open();
  }

  /** 关闭 socket 并取消已排定的重连（幂等，销毁后所有调用都会失败）。 */
  dispose() {
    this.#disposed = true;
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    this.#settleAll(new Error('onebot: client disposed'));
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      // 先摘掉回调，确保关闭过程不会再触发重连或状态回调。
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        /* socket 已经关闭，忽略 */
      }
    }
    if (this.#connected) {
      this.#connected = false;
      this.#onStateChange(false, this.#selfId);
    }
  }

  /**
   * 通过共用 socket 调用一个 OneBot API。
   * @param action - OneBot action 名，例如 `send_group_msg`。
   * @param params - action 的参数对象。
   * @param timeoutMs - 等待配对响应的超时时间。
   * @returns action 的 `data` 负载。
   * @throws socket 未连接、调用超时，或服务端返回失败时抛出。
   */
  call(action, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const socket = this.#socket;
      if (this.#disposed) {
        reject(new Error(`onebot: cannot call ${action}: client disposed`));
        return;
      }
      // readyState 1 = OPEN；未连接时立即失败，由调用方决定是否重试。
      if (socket === null || socket.readyState !== 1) {
        reject(new Error(`onebot: cannot call ${action}: not connected to ${this.#endpoint}`));
        return;
      }
      // echo 是本客户端自造的关联 id，服务端会原样回显，用它把响应配回这次调用。
      const echo = `qqb-${++this.#echoCounter}`;
      const timer = setTimeout(() => {
        this.#pending.delete(echo);
        reject(new Error(`onebot: ${action} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(echo, { resolve, reject, timer, action });
      try {
        socket.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        // 发送本身失败：清理挂起的调用，避免定时器泄漏。
        clearTimeout(timer);
        this.#pending.delete(echo);
        reject(new Error(`onebot: failed to send ${action}: ${error?.message ?? error}`));
      }
    });
  }

  /** 让所有在途调用失败，用于 socket 消失时（关闭/出错/销毁）统一收尾。 */
  #settleAll(error) {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.#pending.clear();
  }

  /** 发起一次连接尝试并挂上各个事件处理器。 */
  #open() {
    if (this.#disposed) return;
    let socket;
    try {
      // 仅当配置了 token 时才传第二个参数（Node 的 WebSocket 支持 headers 选项）。
      const options = this.#accessToken.length > 0 ? { headers: { Authorization: `Bearer ${this.#accessToken}` } } : undefined;
      socket = options === undefined ? new WebSocket(this.#endpoint) : new WebSocket(this.#endpoint, options);
    } catch (error) {
      // 构造 WebSocket 就失败（比如地址非法）：记错误并直接排下一次重连。
      this.#onError(new Error(`onebot: cannot open ${this.#endpoint}: ${error?.message ?? error}`));
      this.#scheduleRetry();
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      // 连上就重置退避延迟，避免偶尔的网络抖动导致后续重连越来越慢。
      this.#retryDelay = RETRY_MIN_MS;
      this.#connected = true;
      this.#onStateChange(true, this.#selfId);
      // 主动查询登录信息，拿到自己的 QQ 号，这样 @ 判定无需额外配置。
      this.call('get_login_info')
        .then((info) => {
          if (info?.user_id !== undefined) this.#selfId = String(info.user_id);
        })
        .catch(() => {});
    };
    socket.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        // 非 JSON 帧直接忽略，不影响其它消息。
        return;
      }
      this.#dispatch(payload);
    };
    socket.onerror = () => {
      // onerror 之后必定跟一次 onclose，重连统一在那里安排。
      this.#onError(new Error(`onebot: socket error on ${this.#endpoint}`));
    };
    socket.onclose = () => {
      if (this.#socket === socket) this.#socket = null;
      // 连接没了，所有在途 API 调用都不可能再有响应，直接全部拒绝。
      this.#settleAll(new Error('onebot: connection closed'));
      if (this.#connected) {
        this.#connected = false;
        this.#onStateChange(false, this.#selfId);
      }
      this.#scheduleRetry();
    };
  }

  /** 把一帧已解码的数据分派给等待中的调用，或交给事件处理器。 */
  #dispatch(payload) {
    if (payload === null || typeof payload !== 'object') return;
    const echo = payload.echo;
    // 带 echo 且能在 pending 里找到 → 这是一次 API 调用的响应。
    if (typeof echo === 'string' && this.#pending.has(echo)) {
      const entry = this.#pending.get(echo);
      this.#pending.delete(echo);
      clearTimeout(entry.timer);
      if (payload.status === 'ok' || payload.retcode === 0) {
        entry.resolve(payload.data);
      } else {
        entry.reject(new Error(`onebot: ${entry.action} failed: retcode=${payload.retcode} ${payload.message ?? ''} ${payload.wording ?? ''}`.trim()));
      }
      return;
    }
    // 其余都是服务端推送的事件；处理器抛错只上报，不让异常冒泡回 socket。
    try {
      this.#onEvent(payload);
    } catch (error) {
      this.#onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** 按有上限的指数退避安排一次重连。 */
  #scheduleRetry() {
    // 已销毁或已有待执行的重连定时器时不再重复排程。
    if (this.#disposed || this.#retryTimer !== null) return;
    const delay = this.#retryDelay;
    this.#retryDelay = Math.min(RETRY_MAX_MS, this.#retryDelay * 2);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#open();
    }, delay);
    // unref：只有重连定时器时不要拖住 Node 进程退出。
    this.#retryTimer.unref?.();
  }
}
