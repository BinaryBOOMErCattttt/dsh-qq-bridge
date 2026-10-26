/**
 * 发送链路：拆条、标点清洗、引用/@ 指向、串行队列、私聊「正在输入」。
 *
 * 从 `index.js` 的 `apply()` 闭包里搬出来（第一批拆分）。搬的时候只做了一件事：
 * 把原来直接读闭包的地方改成 `deps` 传进来 —— 逻辑与注释逐字保留，`index.js` 仍然
 * 用同名函数，调用点一个都没动。这样 `bridge.test.mjs` 仍然只 import 插件入口。
 *
 * 依赖表（`deps`）就是「能碰什么」的清单：
 *   - `client` / `settings` / `report` / `cwd`：宿主连接、配置、日志、工作目录；
 *   - `imageMaxBytes` / `imageAllowed` / `stickerSendSource` / `noteStickerFailure`：
 *     出站图片与表情包的那套边界（`image.js` / `index.js` 的 sticker 区）；
 *   - `stickerLabel` / `moodSticker`：收藏目录的展示路径与心情门控（只有收藏目录里的
 *     表情受门控；`.qq-media` 的普通图片不受限，否则「发张截图」也会被心情卡住）；
 *   - `styleParams` / `chatMaxChars`：标点清洗与「聊天型 / 信息型」门槛；
 *   - `chatter` / `conversationMentions`：引用指向的进度读数与 `[[@昵称]]` 的会话侧解析
 *     （`quoteHead` 也在这个模块里）；
 *   - `describeConversation` / `noteOwnMessage`：日志名与「我自己刚说过话」的记账；
 *   - `conversations`：`stopAllTyping` 在插件卸载时要按 key 找回会话记录。
 *
 * **不 import `index.js`**（那会成环）。纯函数尽量从叶子模块直接 import。
 *
 * @module @qqbot/dsh-plugin-qq/send
 */
import { chunkText, splitBurst, splitStickerLines, typingDelayMs } from './onebot.js';
import { hasMentionMarker, mentionSegments } from './mention.js';
import { imageSegment, loadOutgoingImage } from './image.js';
import { classifyReply, sanitizeBubble } from './style.js';
import { errorText } from './util.js';

/** 私聊输入状态每 4 秒续一次（协议端只替我们亮几秒）。 */
const TYPING_REFRESH_MS = 4000;
/** `set_input_status` 单次调用的超时：失败绝不能拖住消息本身。 */
const TYPING_CALL_TIMEOUT_MS = 3000;
/** 一条回复最多亮多久的输入状态：防止异常情况下定时器无限续。 */
const TYPING_MAX_MS = 2 * 60 * 1000;

/**
 * 建一组发送函数。
 *
 * @param deps - 见文件头的依赖表。
 * @returns `enqueueSend` / `sendToConversation` / `sendLiteral` / `replyPieces` /
 *   `sendOne` / `startTyping` / `stopTyping` / `stopAllTyping`。
 */
export function createSender(deps) {
  const {
    client,
    settings,
    report,
    cwd,
    imageMaxBytes,
    styleParams,
    chatMaxChars,
    conversations,
    chatter,
    imageAllowed,
    stickerLabel,
    stickerSendSource,
    noteStickerFailure,
    moodSticker = { before: () => 'free', after: () => {} },
    conversationMentions,
    describeConversation,
    noteOwnMessage,
  } = deps;

  /**
   * 把一段回复拆成「像真人连着发的」几条消息（**只拆条，不丢内容**）。
   *
   * 不开启 `humanize` 时就是旧行为（只在超过协议上限时分段）。开启后先把换行拆成
   * 一条条独立消息（换行 = 分条，不再是同一条里的排版），再对每一行按标点/长度拆成
   * 短句（受 `burstMaxChars` / `burstMaxParts` 约束），最后每段都接受一次协议上限的
   * 硬校验 —— 模型偶尔写超长时，最后一段仍可能被 `chunkText` 再切开。
   *
   * 「聊天型 / 信息型」只影响**发送途中被打断**时停不停（见 `sendParts`），不影响条数：
   * 模型写几行就发几行，插件**不设气泡数上限、也不把多出来的并进最后一条**。
   * `burstMaxMessages` 是唯一可选的总条数上限（默认 0 = 不限，显式设了才并条）。
   *
   * @param text - 模型给出的完整回复。
   * @returns 按发送顺序排列的分段。
   */
  function burstParts(text) {
    const limit = settings.maxReplyChars;
    if (!settings.humanize) return chunkText(text, limit);
    const burst = Number.isSafeInteger(settings.burstMaxChars) && settings.burstMaxChars > 0
      ? Math.min(settings.burstMaxChars, limit)
      : limit;
    const maxParts = Number.isFinite(settings.burstMaxParts) ? Math.max(1, Math.floor(settings.burstMaxParts)) : 3;
    return splitBurst(text, burst, maxParts, settings.burstMaxMessages).flatMap((part) => chunkText(part, limit));
  }

  /** 发送前等待（`ms <= 0` 时立即返回）；unref 让待发的延迟不拖住进程退出。 */
  function sleep(ms) {
    if (!(ms > 0)) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  /**
   * 把一次发送挂到会话的串行链上。
   *
   * 同一个会话的发送挂在 `conversation.sending` 上串行执行：拟人延迟会让一次回复
   * 持续好几秒，若不排队，下一轮回复（或一句复读）会插进来，群里看到的就是两条
   * 消息交错。前一次失败也要继续排下一次，所以两个分支都接上 `run`。
   *
   * @param conversation - 目标会话。
   * @param run - 真正的发送步骤（调用方保证自己不会 reject）。
   * @returns 本次发送完成时兑现的 Promise，绝不 reject。
   */
  function enqueueSend(conversation, run) {
    const chained = (conversation.sending ?? Promise.resolve()).then(run, run);
    conversation.sending = chained.then(
      () => {},
      () => {},
    );
    return chained;
  }

  /**
   * 把一条回复发到 QQ：拆段、按真人打字节奏加延迟，任一段失败即停止。
   *
   * 正文里的 `[[图片: 路径]]` 标记会变成一张真的图（见 `replyPieces`）——「只发表情、
   * 一个字都不说」就是整条正文只有那一处标记。
   *
   * @param conversation - 目标会话。
   * @param text - 要发送的正文（可含表情包标记）。
   * @param options - `human`：拆短句 + 打字延迟（自动回复用）；`quote`：本轮的回复指向
   *   `{ messageId, userId, seq, emoji }`，仅群聊生效，且只挂在第一个**文字**气泡上
   *   （规则见 `quoteHead`）；`at`：要挂到第一个文字气泡前的 `{ id, name }[]`
   *   （定时提醒用，模型自己不写 @）；`intent`：这一轮为什么轮到它（`addressed` /
   *   `continued` / `interject`），决定挂不挂指向（搭话轮不挂，见 `quoteHead`）。
   * @returns 本次发送（含延迟）完成时兑现的 Promise：至少发出一条为 true，否则 false。
   *   绝不 reject。
   */
  function sendToConversation(conversation, text, { human = false, quote, at, intent } = {}) {
    return enqueueSend(conversation, () => sendParts(conversation, text, human, quote ?? { messageId: '', userId: '', seq: 0 }, at, intent));
  }

  /**
   * 把一段正文**原样**发给会话：不认 `[[图片: …]]` 标记、不拆短句、不加打字延迟。
   *
   * 复读专用 —— 群里有人把 `[[图片: .qq-media/…]]` 这种字样打两遍时，那是两句**文字**，
   * 不是让机器人发文件的指令：标记只解析模型写的回复（`replyPieces`）。复读机的正文
   * 全部来自不可信的群消息，所以这里一步都不多做，只按协议上限分段。
   *
   * @param conversation - 目标会话。
   * @param text - 要原样发出的正文。
   * @returns 本次发送完成时兑现的 Promise，绝不 reject。
   */
  function sendLiteral(conversation, text) {
    return enqueueSend(conversation, async () => {
      for (const part of chunkText(text, settings.maxReplyChars)) {
        if (!(await sendOne(conversation, part))) return;
      }
    });
  }

  /**
   * 把一条回复拆成「要一条条发出去的东西」：文字段与表情包段，顺序照原文。
   *
   * 三段流水线，顺序不能反：
   *   1. `splitStickerLines` 把 `[[图片: …]]` 拆成图段；
   *   2. `burstParts` 拆条 —— 换行/标点/长度；
   *   3. `sanitizeBubble` 清洗标点（剥句末「。」、并连续句号与空格）。
   *
   * **发几条由模型自己写**：这里没有骰子、没有概率，也**没有气泡数上限 / 并条** ——
   * 模型写几行就发几行（协议上限由 `chunkText` 兜底）。
   *
   * 文字段里的 `[[@昵称]]` 标记在这里只**标记出来**（`mention: true`），真正的段解析放在
   * `sendParts` 里做 —— 那里才拿得到会话记录（「谁可以被 @」的名单挂在会话上）。
   * 没有标记的文字段仍然以纯字符串发出，与旧行为逐字节一致。
   *
   * @param text - 模型给出的完整回复。
   * @param human - 是否按拟人节奏拆短句（自动回复用；工具与复读走 human=false）。
   * @returns `{ kind: 'text', text, mention? }` 或 `{ kind: 'image', source, raw }` 的数组。
   */
  function replyPieces(text, human) {
    const asText = (value) =>
      (human ? burstParts(value) : chunkText(value, settings.maxReplyChars)).map((part) =>
        hasMentionMarker(part) ? { kind: 'text', text: part, mention: true } : { kind: 'text', text: part });
    const pieces = splitStickerLines(text).flatMap((piece) => {
      if (piece.kind === 'text') return asText(piece.text);
      if (!imageAllowed()) return asText(piece.raw); // 没允许发图时标记只是普通文字
      return [piece];
    });
    if (!human) return pieces;
    // 标点清洗只对文字气泡：剥句末「。」、并连续句号与空格。剥完什么都不剩的气泡丢掉。
    return pieces
      .map((piece) => (piece.kind !== 'text' ? piece : { ...piece, text: sanitizeBubble(piece.text, styleParams) }))
      .filter((piece) => piece.kind !== 'text' || (typeof piece.text === 'string' && piece.text.length > 0));
  }

  /**
   * 本轮回复第一个**文字**气泡上的「指向」段（引用 / @）。
   *
   * 规则按顺序：
   *   0. **搭话轮不挂任何指向**（`intent === 'continued'` / `'interject'`）：这两种轮次不是
   *      「有人在问它、它回那一条」，而是它自己顺着群里的气氛凑一句。真人凑话时不会先引用
   *      一句再开口（也不会先 @ 一下再开口）—— 那正是「人机感」最重的那个动作；群里本来就
   *      看得出它在接谁的话（`replyStyle` 再显式也不改变这一点，「搭话」不是「回答」）；
   *   1. **被回复的那条只有表情时不引用**（`quote.emoji`）：引用块会把那张表情再贴一遍，
   *      看着像在郑重地回复一张图；`replyStyle: 'at'` 不受影响（它只认 `userId`）；
   *   2. `replyStyle: quote` / `at` 照旧；
   *   3. `auto` 只在「我回的那条后面又出现了消息」时才引用 —— **包括我自己刚发出去的话**
   *      （上一轮的回复、复读、主动搭话）：紧挨着回时引用是纯噪音，一轮问答本来就看得出来
   *      在回谁；被后来的话挤远了才需要点名，不然看的人对不上话头。
   *
   * @param conversation - 目标会话。
   * @param options.quote - 被回复消息的 `{ messageId, userId, seq, emoji }`。
   * @param options.intent - 这一轮为什么轮到它（`addressed` / `continued` / `interject`）。
   * @returns 要挂在前面的段；不需要指向时 undefined。
   */
  function quoteHead(conversation, { quote, intent } = {}) {
    const target = quote ?? { messageId: '', userId: '', seq: 0 };
    if (conversation.type !== 'group') return undefined;
    // 搭话（免 @ 接话 / 多人插话）不点名也不引用：见上面第 0 条。
    if (intent === 'continued' || intent === 'interject') return undefined;
    // 积压的一波同样不挂：那一批里每一条都是几分钟前的，指谁都是错的。
    if (intent === 'backlog') return undefined;
    // 引用一张表情没有意义（见第 1 条）；@ 不在此列。
    const quotable = target.emoji !== true;
    const style = settings.replyStyle;
    if (style === 'auto') {
      const drifted = typeof target.seq === 'number' && chatter.anchor(conversation.id) > target.seq;
      if (!quotable || !drifted || target.messageId.length === 0) return undefined;
      return { type: 'reply', data: { id: target.messageId } };
    }
    if (style === 'quote' && quotable && target.messageId.length > 0) return { type: 'reply', data: { id: target.messageId } };
    if (style === 'at' && target.userId.length > 0) return { type: 'at', data: { qq: target.userId } };
    return undefined;
  }

  /**
   * 发一条已经组装好的 `message`。
   * @returns 成功为 true；失败只记一条 warn（调用方决定是否继续发后面的）。
   */
  async function sendOne(conversation, message) {
    // 群聊与私聊走不同的 OneBot action，参数名也不同。
    const action = conversation.type === 'group' ? 'send_group_msg' : 'send_private_msg';
    const idKey = conversation.type === 'group' ? 'group_id' : 'user_id';
    try {
      await client.call(action, { [idKey]: conversation.id, message });
      // 记下「我最后在这里说话是什么时候」：主动说话靠它避免对着没人的群自说自话
      // （见 proactiveEligible）。所有真正发出去的消息都走这个函数，所以自动回复、
      // 复读、主动搭话都会被记上；出站工具那条路自己发，不计也无关紧要。
      conversation.lastBotSpeakAt = Date.now();
      // 我自己的话也算「把被回复的那条挤远了」：回复指向的进度表在这一刻进账
      // （NapCat 不回灌自己的消息，等不到事件，见 `noteOwnMessage`）。
      noteOwnMessage(conversation.type, conversation.id);
      return true;
    } catch (error) {
      report('warn', `could not send to ${conversation.key}: ${error?.message ?? error}`);
      return false;
    }
  }

  // ---- 私聊「对方正在输入」-----------------------------------------------------
  //
  // 真人回消息时，对方先看到「正在输入」，过一会儿才收到字。QQ 的输入状态不是常亮的：
  // 协议端只在收到 `set_input_status` 之后替我们亮几秒，所以这里每 `TYPING_REFRESH_MS`
  // 补一次，直到这条回复真的发出去（发消息本身也会清掉它）。
  //
  // 只在**私聊**里做：群里亮「正在输入」的收益远小于人多时的噪音与调用量；也只在
  // **自动回复**（`human: true`）上做 —— 工具发消息、复读、`/reset` 的回执都不是
  // 「我在打字」。`agent/inbox/claimed` 把它的起点提前到「模型开始想怎么回」，
  // 因此沉默的那几秒（通常才是最长的）也不会让对方以为机器人没看见。
  //
  // 状态按会话 key 记，`stopTyping` 幂等：`turn/end`（任何分支）、发送结束、`/reset`
  // 与插件卸下都会清掉它。协议端不支持这个扩展时只记一条 warn，然后这个进程里不再试。
  const typingStates = new Map();
  let typingUnsupported = false;
  let typingWarned = false;

  /** 这个会话该不该显示「正在输入」。 */
  function typingEnabledFor(conversation) {
    return settings.privateTyping === true
      && conversation.type === 'private'
      && typingUnsupported !== true
      && client.connected === true;
  }

  /** 发一次输入状态（`event_type`：1 = 正在输入，0 = 停下）。失败绝不影响消息本身。 */
  function pingTyping(conversation, typing) {
    client.call('set_input_status', { user_id: conversation.id, event_type: typing ? 1 : 0 }, TYPING_CALL_TIMEOUT_MS)
      .catch((error) => {
        const detail = errorText(error);
        // 「协议端没有这个 action」与一次网络抖动要分开：前者这个进程里再也别试，
        // 后者只告警一次（每 4 秒一行 warn 会把日志刷满），下一次刷新还会照常发。
        if (/not found|unknown action|unsupported|not supported|不支持/i.test(detail)) {
          typingUnsupported = true;
          stopAllTyping();
          report('warn', `私聊「正在输入」已停用：协议端不支持 set_input_status（${detail}）`);
          return;
        }
        if (typingWarned) return;
        typingWarned = true;
        report('warn', `私聊「正在输入」发送失败（不影响消息本身）：${detail}`);
      });
  }

  /** 开始/续上这个会话的「正在输入」；重复调用无副作用。 */
  function startTyping(conversation) {
    if (!typingEnabledFor(conversation)) return;
    if (typingStates.has(conversation.key)) return;
    const state = { timer: undefined, deadline: Date.now() + TYPING_MAX_MS };
    typingStates.set(conversation.key, state);
    pingTyping(conversation, true);
    const tick = () => {
      // 已经停了、连接断了、开关被关掉（热更新前）都就地收手：别让定时器一直空转。
      if (!typingStates.has(conversation.key)) return;
      if (!typingEnabledFor(conversation) || Date.now() >= state.deadline) {
        stopTyping(conversation);
        return;
      }
      pingTyping(conversation, true);
      state.timer = setTimeout(tick, TYPING_REFRESH_MS);
      state.timer.unref?.();
    };
    state.timer = setTimeout(tick, TYPING_REFRESH_MS);
    state.timer.unref?.();
  }

  /** 停掉刷新；`cancel` 时再发一条「没在输入」（发消息本身也会清掉它）。 */
  function stopTyping(conversation, { cancel = true } = {}) {
    const state = typingStates.get(conversation.key);
    if (state === undefined) return;
    typingStates.delete(conversation.key);
    if (state.timer !== undefined) clearTimeout(state.timer);
    if (cancel && typingEnabledFor(conversation)) pingTyping(conversation, false);
  }

  /** 进程里所有会话都停下（插件卸下 / 协议端不支持时）。 */
  function stopAllTyping({ cancel = false } = {}) {
    for (const [key, state] of typingStates) {
      if (state.timer !== undefined) clearTimeout(state.timer);
      if (!cancel) continue;
      const conversation = conversations.get(key);
      if (conversation !== undefined && typingEnabledFor(conversation)) pingTyping(conversation, false);
    }
    typingStates.clear();
  }

  /**
   * 发一条回复（`sendToConversation` 的发送步骤）。
   *
   * `human` 的那一次回复在开始前点亮「正在输入」，无论成功、失败还是中途停下都在
   * `finally` 里熄灭 —— `stopTyping` 幂等，`turn/end` 提前停过也没关系。
   */
  async function sendParts(conversation, text, human, quote, at, intent) {
    if (!human) return sendPieces(conversation, text, human, quote, at, intent);
    startTyping(conversation);
    let sent = false;
    try {
      sent = await sendPieces(conversation, text, human, quote, at, intent);
      return sent;
    } finally {
      // 真发出去的消息本身就会清掉输入状态；一个字都没发出去时才需要显式取消。
      stopTyping(conversation, { cancel: !sent });
    }
  }

  /** `sendParts` 的实际发送步骤（调用方已保证同一会话串行）。 */
  async function sendPieces(conversation, text, human, quote, at, intent) {
    const pieces = replyPieces(text, human);
    // 「昵称 → QQ 号」的名单在一次发送里只造一遍：几个分段共用同一份，也保证同一次回复里
    // 同名的解析结果一致。
    const mentionsFor = conversationMentions(conversation);
    // 定时提醒的 @ 名单由任务提供（创建时就解析成了 QQ 号），只挂到**第一个文字气泡**：
    // 模型自己不写 `[[@…]]`，重试/重启之后也不依赖会话上那份会过期的 participants。
    const atSegments = Array.isArray(at)
      ? at
          .filter((entry) => entry !== undefined && String(entry.id ?? '').trim().length > 0)
          .map((entry) => ({ type: 'at', data: { qq: String(entry.id).trim() } }))
      : [];
    const mode = human ? classifyReply(text, { chatMaxChars }) : 'informational';
    // 「发送中被打断就停」的快照：聊天型的后续气泡在真正发出前比一比，这期间对方又说话了
    // 就不再发剩下的（已经发的第一条留着）。真人也是这么停的；信息型该讲完还得讲完。
    const activitySnapshot = conversation.lastActiveAt;
    let firstTextSeen = false;
    // 至少发出一条就是 true：定时提醒靠它判断「要不要走兜底」。
    let sentAny = false;
    // @ 只挂到**第一条真正发出去的文字**上：第一条文字如果被标记解析吃空，
    // 它不该把 @ 也一起带走。
    let atPending = atSegments.length > 0;
    for (const [index, piece] of pieces.entries()) {
      // 聊天型：对方已经接话了，就别接着说。
      if (human && mode === 'chat' && index > 0 && piece.kind === 'text' && conversation.lastActiveAt !== activitySnapshot) {
        report('info', `${describeConversation(conversation)}: 对方已经接话，剩下的 ${pieces.length - index} 个气泡不发了`);
        return sentAny;
      }
      if (human) {
        // 第一条前多等一个「读消息」的时间；后续每条只算打字时间。
        // 表情包没有字数可算，等一个下限就够（第一张仍然算「读消息」那一段时间）。
        // 字段逐个显式传：`delayJitter` 与纯函数的 `jitter` 不同名，整包展开会静默丢掉抖动。
        await sleep(typingDelayMs(piece.kind === 'text' ? piece.text.length : 0, {
          charsPerSecond: settings.charsPerSecond,
          minDelayMs: settings.minDelayMs,
          maxDelayMs: settings.maxDelayMs,
          jitter: settings.delayJitter,
          baseMs: index === 0 ? settings.readDelayMs : 0,
        }));
      }
      // 引用只挂第一个**文字**气泡：图段永远不挂（§6.6），整轮只有图时引用自然被丢弃。
      // 被回复的那条本身只有表情时也不引用，搭话轮整个不挂（见 `quoteHead`）。
      const head = piece.kind === 'text' && !firstTextSeen
        ? quoteHead(conversation, { quote, intent })
        : undefined;
      const atHere = piece.kind === 'text' && atPending ? atSegments : [];
      if (piece.kind === 'text') firstTextSeen = true;
      if (piece.kind === 'text') {
        // 没有 @ 标记、没有指向、也没有任务给的 @ 时仍然发纯字符串：与旧版发送格式完全一致。
        if (piece.mention !== true && head === undefined && atHere.length === 0) {
          if (!(await sendOne(conversation, piece.text))) return sentAny;
          sentAny = true;
          atPending = false;
          continue;
        }
        const segments = piece.mention === true
          ? mentionSegments(piece.text, mentionsFor)
          : [{ type: 'text', data: { text: piece.text } }];
        // 标记解析完什么都不剩（只写了一个认不出来的名字）时，这一条就没有内容可发了。
        if (segments.length === 0) continue;
        const message = [...(head === undefined ? [] : [head]), ...atHere, ...segments];
        if (await sendOne(conversation, message)) {
          sentAny = true;
          atPending = false;
          continue;
        }
        // 引用发不出去就算了：没有任何轮次是「必须有锚点」的（插话也一样，见 `quoteHead`）。
        return sentAny;
      }
      // 心情门控只卡**收藏目录里的表情**：`.qq-media` 的截图 / 照片不是「表情包」，
      // 拿它去凑心情门槛只会让「发张截图」也失败。斗图模式与用户明确要表情由门控放行
      // （见 mood.js 的 stickerBefore），这里只负责「拒绝时静默丢掉这一段」。
      const stickerPath = stickerLabel !== undefined && String(piece.source ?? '').startsWith(`${stickerLabel}/`);
      let moodGrant;
      if (stickerPath) {
        try {
          moodGrant = moodSticker.before(conversation);
        } catch (error) {
          // 整条回复只有一张表情时，静默丢掉等于「机器人没理人」；但提示词已经说清默认
          // 关闭，模型仍写标记属于越界，不能反过来用一句「不许发」把正文也顶掉。
          report('info', `sticker blocked for ${conversation.key}: ${errorText(error)}`);
          continue;
        }
      }
      let bytes;
      try {
        bytes = (await loadOutgoingImage({ source: stickerSendSource(piece.source), cwd, maxBytes: imageMaxBytes })).bytes;
      } catch (error) {
        // 表情包发不出去**不能静默**：整条回复只有这一行时，静默就等于「机器人没理人」。
        // 同时把失败记进会话（`stickerFailure`）：模型下一轮看得到「那张没发出去、为什么」，
        // 否则它会照着自己编的路径再编一个（真实事故：`.qq-media/<哈希>` 连编两轮）。
        report('warn', `sticker ${piece.source} could not be sent: ${errorText(error)}`);
        noteStickerFailure(conversation, piece.source, errorText(error));
        const notice = '（那张表情我这儿没有，发不出去）';
        if (!(await sendOne(conversation, notice))) return sentAny;
        sentAny = true;
        continue;
      }
      // 图不挂引用、也没有可算的打字时间（延迟只留 index 0 的那个「读消息」）。
      // `imageSegment` 返回的是**一个段**，`message` 要的是段数组（旧写法就是 [segment]）。
      // `sticker: true` 带上 QQ 的「大表情」标记 —— 这条路只发收藏目录里的表情包。
      if (!(await sendOne(conversation, [imageSegment(bytes, { sticker: true })]))) return sentAny;
      sentAny = true;
      // 斗图模式靠这个标记判断「这一轮发过图了」（见 turn/end 的连发提醒）。
      conversation.stickerSentThisTurn = true;
      // 只在这张**真的发出去**之后才消耗心情许可：发送失败时模型下一轮还该能再试一次。
      if (moodGrant !== undefined) moodSticker.after(conversation, moodGrant);
      // 发出去了就把上一条失败记录清掉：再留着会变成一句没做完的指令。
      conversation.stickerFailure = undefined;
      // 记下「上一张发出去的表情」：`接一个` 要避开它，别原地复读自己。
      const sentPath = String(piece.source ?? '');
      if (stickerPath) conversation.lastSticker = sentPath.slice(stickerLabel.length + 1);
    }
    return sentAny;
  }

  return {
    enqueueSend,
    sendToConversation,
    sendLiteral,
    replyPieces,
    sendOne,
    startTyping,
    stopTyping,
    stopAllTyping,
  };
}
