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

/** 重连退避的下限与上限（毫秒）。 */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;

/** API 调用的默认超时（毫秒）：超时即 reject，避免调用方永久挂起。 */
const CALL_TIMEOUT_MS = 15000;

/**
 * 归一化图片/表情包自带的 `summary`。
 *
 * QQ 会给「动画表情」这种图配一句 `[动画表情]` 的占位摘要，商城表情给的则是表情名。
 * 去掉方括号、折掉换行、截个长度，让它能安全地塞进一行上下文里。
 * @param summary - 段里的 `summary` 字段。
 * @returns 可读标签；没有可用内容时为空串。
 */
export function mediaLabel(summary) {
  const text = String(summary ?? '').replace(/\s+/g, ' ').trim();
  if (text.length === 0) return '';
  const stripped = text.replace(/^\[+|\]+$/g, '').trim();
  return stripped.slice(0, 40);
}

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
 * 媒体段的替身文本：模型看到的「这里有张图」以及它该去读哪个文件。
 *
 * 三种情况分开写，因为它们对模型的含义完全不同：
 *   - 有本地路径 → 可以 `read_image` 真的看图；
 *   - 明确取文件失败 → 别去读一个不存在的路径，也别假装看见了；
 *   - 只是顺带提及（群聊环境上下文，不做下载）→ 朴素占位符。
 * @param media - {@link collectMedia} 给出的媒体描述。
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
 * 把单个 OneBot 消息段渲染成模型能读懂的纯文本。
 * 图片/语音等非文本内容用方括号占位，让模型知道「这里有个东西」但不至于读到空串。
 * @param segment - 一个 `{ type, data }` 消息段。
 * @param replacement - 可选：该段已被替换成的文本（媒体落盘后的路径形式）。
 * @returns 该段的可读替身文本。
 */
function segmentToText(segment, replacement) {
  if (typeof replacement === 'string') return replacement;
  const type = segment?.type;
  const data = segment?.data ?? {};
  switch (type) {
    case 'text':
      return typeof data.text === 'string' ? data.text : '';
    case 'at':
      return data.qq === 'all' ? '@全体成员' : `@${data.name ?? data.qq ?? '某人'}`;
    case 'image':
      return mediaPlaceholder({ kind: 'image', label: mediaLabel(data.summary) });
    case 'mface':
      return mediaPlaceholder({ kind: 'mface', label: mediaLabel(data.summary) });
    case 'face':
      return '[表情]';
    case 'reply':
      return '[回复]';
    case 'record':
      return '[语音]';
    case 'video':
      return '[视频]';
    case 'file':
      return `[文件 ${data.name ?? ''}]`.trim();
    case 'json':
    case 'xml':
      return '[卡片消息]';
    case 'forward':
      return '[合并转发]';
    case 'poke':
      return '[戳一戳]';
    default:
      return type === undefined ? '' : `[${type}]`;
  }
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
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message
    .map((segment, index) => {
      if (skipAtId !== undefined && segment?.type === 'at' && String(segment?.data?.qq) === String(skipAtId)) return '';
      return segmentToText(segment, media instanceof Map ? media.get(index) : undefined);
    })
    .join('');
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
 * 不约束「模型自己写了几行」：模型显式写了 5 行就是要发 5 条。
 *
 * 超过 `maxParts` 的余量会并进该行的最后一条（调用方还会再按协议上限硬分一次），
 * 避免模型偶尔写长了就刷屏。
 *
 * @param text - 模型给出的完整回复。
 * @param maxChars - 单条目标长度；非正数表示不按长度/标点拆（换行仍然拆）。
 * @param maxParts - 单行最多拆成几条（小于 2 视为 1，即不拆）。
 * @returns 一个或多个分段；不需要拆时就是 `[text.trim()]`。
 */
export function splitBurst(text, maxChars = 60, maxParts = 3) {
  const max = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : 0;
  const body = String(text ?? '').trim();
  if (body.length === 0) return [];
  const limit = Number.isSafeInteger(maxParts) && maxParts > 1 ? maxParts : 1;
  // 空行（连续换行）不算一条消息，顺带把每行两端的空白裁掉。
  const lines = body
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (max === 0) return lines;
  return lines.flatMap((line) => {
    if (line.length <= max) return [line];
    const parts = [];
    let rest = line;
    while (parts.length < limit - 1 && rest.length > max) {
      const cut = burstCut(rest, max);
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest.length > 0) parts.push(rest);
    return parts.filter((part) => part.length > 0);
  });
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
