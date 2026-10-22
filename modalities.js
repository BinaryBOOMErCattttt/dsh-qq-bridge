/**
 * 感知层：OneBot 消息段 → `Observation` → 模型能读懂的占位文本。
 *
 * 为什么要把这件事从 `onebot.js` 里拆出来：
 *   - 「这条消息里有什么」（图 / 表情 / 语音 / 视频 / 文件 / 卡片 / 合并转发）与
 *     「该怎么写给模型看」是两件事。以前它们一起挤在 `segmentToText` 的 switch 里，
 *     加一种感知类型就要动消息文本化的主路径；拆开之后新类型只在这里长，
 *     `messageToText` 的调用方一行都不用改。
 *   - 这里**只负责渲染，不做任何 IO**：链接卡片解析、封面与语音的下载都由调用方
 *     先做完，把结果（`replacement` / `meta.coverPath`）交进来。纯函数才可能被单测，
 *     也才不会在「把消息变成文本」时莫名其妙发一次网络请求。
 *
 * 依赖方向：本模块是**叶子** —— 只 import `links.js` 的卡片解析（纯函数），
 * 不 import `onebot.js` / `media.js` / `index.js`。`onebot.js` 反过来从这里取
 * `mediaLabel` / `mediaPlaceholder` / `renderMessage`，所以这里绝不能反向依赖它，
 * 否则 ESM 会在加载期炸成 `Cannot access before initialization`。
 *
 * @module qq-bridge/modalities
 */

import { parseCard } from './links.js';

/**
 * 消息段的观测结果（见 docs/media.md 的占位符表）。
 *
 * 字段说明（`?` 表示可能没有）：
 *   - `kind`：归一化后的种类。`mface` 归成 `sticker`（商城表情），
 *     `record` 归成 `voice`（语音），`json`/`xml` 归成 `card`（卡片），
 *     `node` 归成 `forward`（转发里套转发的段）；
 *   - `order`：原来在消息段数组里的下标，调用方按它对齐 / 排序；
 *   - `label`：该段给人看（也常给模型看）的短标签，例如图片摘要、@ 的名字；
 *   - `text`：只有 `text` 段有，正文原样；
 *   - `localPath`：已经落盘的相对路径（调用方下载完才填，本模块不碰磁盘）；
 *   - `url`：QQ 给的原始下载地址（不可信输入，只当数据看）；
 *   - `meta`：各类型自带的补充信息（字节数、时长、标题、条数……）；
 *   - `status`：`ok`（无需取值）/ `fetched`（调用方已经取到，含 `replacement`）/
 *     `skipped`（本模块刻意没取，例如语音只做占位）/ `failed`（取过但失败）；
 *   - `reason`：失败或跳过的原因，会出现在占位符里；
 *   - `render`：**已经渲染好的替身文本**。这是对 §4.3 模型的一个刻意扩展：
 *     媒体落盘后的占位符（`[图片 没能取到文件: HTTP 404]` 之类）带着本次运行的
 *     具体信息，由调用方 `mediaPlaceholder(...)` 拼好；再让这里按字段重拼一遍，
 *     就可能与既有输出逐字节不一致。所以给出来时 {@link renderObservation} 原样返回。
 *
 * @typedef {object} Observation
 * @property {'text'|'image'|'sticker'|'face'|'voice'|'video'|'file'|'card'|'forward'|'at'|'reply'|'poke'|'unknown'} kind
 * @property {number} order
 * @property {string} label
 * @property {string} [text]
 * @property {string} [localPath]
 * @property {string} [url]
 * @property {object} meta
 * @property {'ok'|'fetched'|'skipped'|'failed'} status
 * @property {string} [reason]
 * @property {string} [render]
 */

/** 标签的最大长度：和 `mediaLabel` 同一个口径，别让一段摘要把一行上下文撑爆。 */
const LABEL_MAX_CHARS = 40;

/**
 * 归一化图片/表情包自带的 `summary`。
 *
 * QQ 会给「动画表情」这种图配一句 `[动画表情]` 的占位摘要，商城表情给的则是表情名。
 * 去掉方括号、折掉换行、截个长度，让它能安全地塞进一行上下文里。
 *
 * @param summary - 段里的 `summary` 字段。
 * @returns 可读标签；没有可用内容时为空串。
 */
export function mediaLabel(summary) {
  const text = String(summary ?? '').replace(/\s+/g, ' ').trim();
  if (text.length === 0) return '';
  const stripped = text.replace(/^\[+|\]+$/g, '').trim();
  return stripped.slice(0, LABEL_MAX_CHARS);
}

/**
 * 媒体段的替身文本：模型看到的「这里有张图」以及它该去读哪个文件。
 *
 * 三种情况分开写，因为它们对模型的含义完全不同：
 *   - 有本地路径 → 可以 `read_image` 真的看图；
 *   - 明确取文件失败 → 别去读一个不存在的路径，也别假装看见了；
 *   - 只是顺带提及（群聊环境上下文，不做下载）→ 朴素占位符。
 *
 * 这个函数的输出是**既有契约**（`test/bridge.test.mjs` 钉着），
 * 所以它从 `onebot.js` 搬过来时逐字没动，包括 `kind` 仍收 `mface` 这种协议名。
 *
 * @param media - 媒体描述：`{ kind, label }`（`collectMedia()` 给出的是超集）。
 * @param localPath - 已落盘的相对路径；空串表示没有。
 * @param reason - 失败原因；给出时附在占位符里。
 * @returns 例如 `[图片(动画表情): .qq-media/ab12….gif]`。
 */
export function mediaPlaceholder(media, localPath = '', reason = '') {
  const kind = media?.kind === 'mface' ? '表情包' : '图片';
  const label = typeof media?.label === 'string' && media.label.length > 0 ? `(${media.label})` : '';
  if (typeof localPath === 'string' && localPath.length > 0) return `[${kind}${label}: ${localPath}]`;
  if (typeof reason === 'string' && reason.length > 0) return `[${kind}${label} 没能取到文件: ${reason}]`;
  return `[${kind}${label}]`;
}

/**
 * 一段时长（毫秒或秒，取决于实现）→ 取整到秒。
 *
 * 为什么要猜单位：NapCat 上报语音时 `duration` 有时是毫秒、有时是秒（同一个字段，
 * 版本/部署不同），而 OneBot 其它实现（go-cqhttp）也有拿 `duration` 当秒用的。
 * 用 1000 当分界很安全 —— 1000 秒以上的语音本来就不存在，1000 毫秒的语音却很常见。
 * 最小值取 1：一段「0 秒」的语音在模型眼里等于没有，写「1 秒」至少说明有声音。
 *
 * @param value - 段里的 `duration` 字段（可能是字符串）。
 * @returns 整秒数；没有可用时长时 undefined。
 */
function durationSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  // > 1000 当毫秒（秒数太夸张了，不可能有这么长的语音/视频）。
  const seconds = number > 1000 ? number / 1000 : number;
  return Math.max(1, Math.round(seconds));
}

/**
 * 时长同时记一份毫秒数进 `meta.durationMs`：渲染只要秒，但调用方（提示词、日志）
 * 可能想要更细的值，而单位猜过一次之后不该再猜第二次。
 * @param value - 段里的 `duration` 字段。
 * @returns 毫秒数；没有可用时长时 undefined。
 */
function durationMilliseconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return number > 1000 ? Math.round(number) : Math.round(number * 1000);
}

/**
 * `meta.durationMs` → 整秒数。
 *
 * 渲染**只读毫秒**：单位在 {@link durationMilliseconds} 里已经猜过一次了，
 * 渲染时再猜一次就可能出现「观测说 1 秒、渲染说没有时长」这种自相矛盾。
 * 同样保留「最小 1 秒」的口径（见 {@link durationSeconds}）。
 *
 * @param value - `meta.durationMs`。
 * @returns 整秒数；没有可用时长时 undefined。
 */
function secondsFromMilliseconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.max(1, Math.round(number / 1000));
}

/** 文件大小的单位。只用十进制常见的这四个，够覆盖 QQ 发得出来的文件。 */
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/**
 * 字节数 → `1.2 MB` 这样的可读大小。
 *
 * 保留 1 位小数并把末尾的 `.0` 去掉：`1.2 MB` 有信息量，`1.0 MB` 没有，
 * 而 `1 MB` 读起来更像人写的。`0` / 负数 / 非数字一律当作「没有大小」。
 *
 * @param bytes - `data.file_size`（可能是字符串）。
 * @returns 可读大小；没有可用值时为空串。
 */
function sizeLabel(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024) return `${Math.round(value)} B`;
  let scaled = value / 1024;
  let unit = 1;
  while (scaled >= 1024 && unit < SIZE_UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${Number(scaled.toFixed(1))} ${SIZE_UNITS[unit]}`;
}

/**
 * 从一个 `face` 段里找出可读的表情名。
 *
 * 不同实现给的字段不一样：有的给 `name`，有的把名字塞在 `summary`，NapCat 新版本
 * 还会给 `face_text`。**不查 id→名称表**：那张表又大又容易过时，猜错了比
 * 只说「[表情]」更误导模型（模型会拿着错的含义去回话）。
 *
 * @param data - 段的 `data` 字段。
 * @returns 表情名；三个字段都没有可用内容时为空串。
 */
function faceLabel(data) {
  for (const field of [data?.name, data?.summary, data?.face_text]) {
    const label = mediaLabel(field);
    if (label.length > 0) return label;
  }
  return '';
}

/**
 * 卡片/链接的渲染：`[链接: 【标题】 — example.com https://…]`。
 *
 * 标题存在才算「看得见的链接」；解析失败或卡片压根没标题时退回 `[卡片消息]`，
 * 而不是拼一个空标题的方括号让模型去猜。域名与 URL 都来自 QQ（不可信输入），
 * 这里只当数据原样展示。
 *
 * @param meta - `{ title, desc, site, url }`。
 * @returns 渲染结果。
 */
function renderCard(meta) {
  const title = typeof meta?.title === 'string' ? meta.title.trim() : '';
  if (title.length === 0) return '[卡片消息]';
  const site = typeof meta?.site === 'string' ? meta.site.trim() : '';
  const url = typeof meta?.url === 'string' ? meta.url.trim() : '';
  // 域名和链接都有时依次列出；只有一个时只列那一个（不拿空格凑数）。
  const tail = [site, url].filter((part) => part.length > 0).join(' ');
  return tail.length > 0 ? `[链接: 【${title}】 — ${tail}]` : `[链接: 【${title}】]`;
}

/**
 * 把一个 OneBot 消息段变成 `Observation`。
 *
 * 只做「看懂」，不做「取到」：图片/封面/语音文件的下载都在调用方（`media.js` 那一侧），
 * 下载结果通过 `replacement` 交回来 —— 于是同一个函数既能用于「还没下载」的群聊环境
 * 上下文，也能用于「已经落盘」的投递正文，语义只由那个参数区分。
 *
 * @param segment - 一个 `{ type, data }` 消息段（可能为 null / 结构不对）。
 * @param options - `index`：段在消息里的下标（写进 `order`）；
 *   `replacement`：该段已经渲染好的替身文本（媒体落盘后由调用方给出）。
 * @returns {Observation} 观测结果。
 */
export function observationOf(segment, { index = 0, replacement } = {}) {
  const type = segment?.type;
  const data = segment?.data ?? {};
  /** @type {Observation} */
  const base = { kind: 'unknown', order: index, label: '', meta: {}, status: 'ok' };

  // 调用方已经把这一段渲染好了（媒体落盘/取文件失败）：原样保留那段文字。
  // 状态统一记 `fetched`：对调用方来说这一段已经「处理完」，无论成功还是失败
  // 都已经在正文里写清楚了。
  if (typeof replacement === 'string') {
    return {
      ...base,
      kind: mediaKind(type),
      label: mediaLabel(data.summary),
      url: typeof data.url === 'string' ? data.url : undefined,
      status: 'fetched',
      render: replacement,
    };
  }

  switch (type) {
    case 'text': {
      const text = typeof data.text === 'string' ? data.text : '';
      return { ...base, kind: 'text', label: text, text };
    }
    case 'at': {
      // 与原 `segmentToText` 完全一致：`name` 是空串时也照用（不 trim、不兜底），
      // 因为 `@` 后面跟一个空名字至少还看得出「这里 @ 了谁」，改成「某人」会让
      // 模型以为那真是对方的名字。
      const label = data.qq === 'all' ? '@全体成员' : `@${data.name ?? data.qq ?? '某人'}`;
      return { ...base, kind: 'at', label, meta: { qq: data.qq } };
    }
    case 'image':
    case 'mface': {
      // 协议里的 `mface`（商城表情）在观测模型里统一叫 `sticker`；`meta.sourceKind`
      // 留着原始类型，渲染时还要用它还原 `[表情包…]` 这个既有文案。
      return {
        ...base,
        kind: type === 'mface' ? 'sticker' : 'image',
        label: mediaLabel(data.summary),
        url: typeof data.url === 'string' ? data.url : undefined,
        meta: { sourceKind: type },
        status: 'skipped',
      };
    }
    case 'face': {
      const label = faceLabel(data);
      return { ...base, kind: 'face', label, meta: { id: data.id } };
    }
    case 'record':
    case 'voice': {
      // 语音本轮只做时长占位，不转写也不下载（见 doc §8.5）——所以是 skipped。
      return {
        ...base,
        kind: 'voice',
        url: typeof data.url === 'string' ? data.url : undefined,
        meta: { durationMs: durationMilliseconds(data.duration) },
        status: 'skipped',
      };
    }
    case 'video': {
      // 封面由调用方下载后写进 `meta.coverPath`；整段视频默认不下载（doc §8.5）。
      // 这里只把 QQ 给的封面地址（`thumb` / `cover`，不同实现叫法不同）留在 meta 里，
      // 让调用方有个「要不要下、下哪个」的依据 —— 本模块绝不自己发请求。
      const videoMeta = { durationMs: durationMilliseconds(data.duration) };
      if (typeof data.thumb === 'string' && data.thumb.length > 0) videoMeta.thumb = data.thumb;
      if (typeof data.cover === 'string' && data.cover.length > 0) videoMeta.cover = data.cover;
      return {
        ...base,
        kind: 'video',
        url: typeof data.url === 'string' ? data.url : undefined,
        meta: videoMeta,
        status: 'skipped',
      };
    }
    case 'file': {
      const name = String(data.name ?? '').trim();
      const bytes = Number(data.file_size);
      return {
        ...base,
        kind: 'file',
        label: name,
        meta: { bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : undefined },
        status: 'skipped',
      };
    }
    case 'json':
    case 'xml': {
      // 卡片解析是纯的、不联网（doc §8.4）；解析器抛错只影响这一段，不能连累整条消息。
      let card;
      try {
        card = parseCard(segment);
      } catch {
        card = undefined;
      }
      const meta = {
        title: typeof card?.title === 'string' ? card.title : '',
        desc: typeof card?.desc === 'string' ? card.desc : '',
        site: typeof card?.site === 'string' ? card.site : '',
        url: typeof card?.url === 'string' ? card.url : '',
      };
      return { ...base, kind: 'card', label: meta.title, meta, status: meta.title.length > 0 ? 'ok' : 'skipped' };
    }
    case 'forward':
    case 'node': {
      // 合并转发本轮只给条数（展开是 `forward.js` 的事，展开会撑爆上下文）。
      // `node` 是部分实现表示「转发里套转发」的段（NapCat 的 `get_forward_msg` 解析路径
      // 会产出这种形状）；把它当转发占位符，别让模型看到协议名 `[node]`。
      // `forward` 用 `content`，`node` 用 `message`，两者都认。
      const content = Array.isArray(data.content) ? data.content : Array.isArray(data.message) ? data.message : undefined;
      return { ...base, kind: 'forward', meta: { count: content?.length ?? 0 }, status: 'skipped' };
    }
    case 'poke':
      return { ...base, kind: 'poke' };
    case 'reply':
      return { ...base, kind: 'reply' };
    default:
      // 不认识的类型保留原文（`[share]` 之类），让模型至少知道这里有个东西；
      // 连 `type` 都没有的段渲染成空串（与原 `segmentToText` 一致）。
      return { ...base, kind: 'unknown', label: type === undefined ? '' : String(type), meta: { type } };
  }
}

/**
 * 一个段的类型 → 观测种类（`replacement` 分支里用）。
 * @param type - 段的 `type`。
 * @returns 观测种类。
 */
function mediaKind(type) {
  if (type === 'image' || type === 'mface') return type === 'mface' ? 'sticker' : 'image';
  return 'unknown';
}

/**
 * 把观测渲染成模型读到的那段文本。
 *
 * 格式是**行为契约**（doc §8.1），改动会直接改变模型看到的世界，也会打到
 * `test/bridge.test.mjs` 的端到端断言上：
 *   - 文字 → 原文；`at` → `@名` / `@全体成员`；`reply` → `[回复]`；
 *   - 图片 / 表情包 → 走 {@link mediaPlaceholder}（既有文案逐字不变）；
 *   - 系统表情 → `[表情: 名称]`，没有名字才退回 `[表情]`；
 *   - 语音 → `[语音 3 秒]`，没有时长就 `[语音]`；
 *   - 视频 → `[视频 12 秒]`，有封面再缀 ` · 封面: 路径`；
 *   - 文件 → `[文件 report.pdf（1.2 MB）]`，没有大小就不带括号；
 *   - 卡片 → `[链接: 【标题】 — example.com https://…]`，没标题 → `[卡片消息]`；
 *   - 合并转发 → `[合并转发 8 条]`，没有内容 → `[合并转发]`；
 *   - 戳一戳 → `[戳一戳]`；不认识的类型 → `[类型]`，连类型都没有 → 空串。
 *
 * @param observation - {@link observationOf} 或调用方自己拼出来的观测。
 * @returns 该段的替身文本。
 */
export function renderObservation(observation) {
  if (observation === null || typeof observation !== 'object') return '';
  // 调用方已经渲染好的文本（媒体落盘/取失败）：原样用，保证占位符逐字节不变。
  if (typeof observation.render === 'string') return observation.render;
  const meta = observation.meta ?? {};
  switch (observation.kind) {
    case 'text':
      return typeof observation.text === 'string' ? observation.text : '';
    case 'at':
      return typeof observation.label === 'string' ? observation.label : '';
    case 'reply':
      return '[回复]';
    case 'image':
    case 'sticker':
      // `kind: 'sticker'` 对应协议里的 `mface`，`mediaPlaceholder` 认的是协议名。
      return mediaPlaceholder({ kind: observation.kind === 'sticker' ? 'mface' : 'image', label: observation.label }, observation.localPath, observation.reason);
    case 'face': {
      const label = typeof observation.label === 'string' ? observation.label.trim() : '';
      return label.length > 0 ? `[表情: ${label}]` : '[表情]';
    }
    case 'voice': {
      const seconds = secondsFromMilliseconds(meta.durationMs);
      return seconds === undefined ? '[语音]' : `[语音 ${seconds} 秒]`;
    }
    case 'video': {
      const seconds = secondsFromMilliseconds(meta.durationMs);
      const head = seconds === undefined ? '视频' : `视频 ${seconds} 秒`;
      const cover = typeof meta.coverPath === 'string' && meta.coverPath.length > 0 ? ` · 封面: ${meta.coverPath}` : '';
      return `[${head}${cover}]`;
    }
    case 'file': {
      const name = typeof observation.label === 'string' ? observation.label.trim() : '';
      if (name.length === 0) return '[文件]';
      const size = sizeLabel(meta.bytes);
      return size.length > 0 ? `[文件 ${name}（${size}）]` : `[文件 ${name}]`;
    }
    case 'card':
      return renderCard(meta);
    case 'forward': {
      const count = Number(meta.count);
      return Number.isFinite(count) && count > 0 ? `[合并转发 ${count} 条]` : '[合并转发]';
    }
    case 'poke':
      return '[戳一戳]';
    default: {
      // 不认识的段：`type` 有值就原样括起来；`type === undefined`（全是空壳）→ 空串。
      const label = typeof observation.label === 'string' ? observation.label : '';
      return label.length === 0 && meta.type === undefined ? '' : `[${label}]`;
    }
  }
}

/**
 * 把一条消息拆成 `Observation[]`。
 *
 * `skipAtId` 沿用 `messageToText` 的老语义：指向机器人自己的 `at` 段**整段丢掉**，
 * 于是 `@bot你好` 变成 `你好`。这里丢掉而不是保留一个「渲染成空串」的观测：
 * 观测数组是「这条消息里有什么」的答案，一个不该出现的段留在里面只会让下游多写
 * 一个判断；而拼出来的正文与「渲染成空串」逐字节相同。
 *
 * CQ 码字符串（非 array 上报格式）看不出来里面有什么，整条当一个文字观测。
 *
 * @param message - OneBot 的 `message` 字段（消息段数组 / 字符串 / 结构不对）。
 * @param options - `skipAtId`：要丢弃的 `at` 目标；`media`：`段下标 → 替身文本` 的映射
 *   （`collectMedia()` 的下标 + 落盘后的 `mediaPlaceholder`）。
 * @returns {Observation[]} 观测列表；不是消息段数组时为空数组。
 */
export function observationsOf(message, { skipAtId, media } = {}) {
  if (typeof message === 'string') {
    const text = message;
    return [{ kind: 'text', order: 0, label: text, text, meta: {}, status: 'ok' }];
  }
  if (!Array.isArray(message)) return [];
  const list = [];
  message.forEach((segment, index) => {
    if (skipAtId !== undefined && segment?.type === 'at' && String(segment?.data?.qq) === String(skipAtId)) return;
    list.push(observationOf(segment, { index, replacement: media instanceof Map ? media.get(index) : undefined }));
  });
  return list;
}

/**
 * 把 OneBot 的 `message` 字段拍平成纯文本（`messageToText` 的实现本体）。
 *
 * @param message - 消息段数组（array 上报格式）或原始字符串（CQ 码格式）。
 * @param options - `skipAtId` / `media`，含义见 {@link observationsOf}。
 * @returns 可读的消息文本。
 */
export function renderMessage(message, options = {}) {
  return observationsOf(message, options).map(renderObservation).join('');
}

/**
 * 把单个 OneBot 消息段渲染成模型能读懂的纯文本。
 *
 * 这是老 `segmentToText` 改名后的版本：`replacement` 给出时整段替换，
 * 其余情况按 {@link renderObservation} 的格式渲染。保留成独立导出的理由：
 * 调用方（引用消息、戳一戳文案）常常只有一个段要渲染，不值得先拆成数组。
 *
 * @param segment - 一个 `{ type, data }` 消息段。
 * @param replacement - 可选：该段已被替换成的文本（媒体落盘后的路径形式）。
 * @returns 该段的可读替身文本。
 */
export function renderSegment(segment, replacement) {
  if (typeof replacement === 'string') return replacement;
  return renderObservation(observationOf(segment));
}
