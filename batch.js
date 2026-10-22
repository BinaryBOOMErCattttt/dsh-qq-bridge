/**
 * 攒批：把前后脚到的消息合成一条再投给 Agent（含「忙的时候到的那一波」）。
 *
 * 从 `index.js` 的 `apply()` 闭包里搬出来（第四批）。函数名与注释保持不变，
 * `index.js` 只装配并解构同名别名；`handleEvent` / `turn/end` / `/reset` / 提醒的
 * 调用点一个都没动。
 *
 * 依赖表：
 *   - `settings` / `client` / `report` / `memory` / `submitted`：配置、连接、日志、
 *     记忆工具可见性、投递归属账；
 *   - `sendToConversation`：`enqueue` 失败时回一句「我这边出错了」；
 *   - `groupTalkActive` / `busyWithTurn`：倾听倍数与「忙不忙」的两个读数；
 *   - `findRecent` / `mediaFor` / `resolveForwards` / `resolveQuote` / `imageAllowed` /
 *     `dropPrefix` / `quotePrefix` / `registerParticipant` / `ensureAgent` / `userMessageFor` /
 *     `describeConversation`：投递一批消息时要用到的会话侧动作。
 *
 * `renderBacklog` / `recallLine` / `interjectLine` / `fetchPageTitle` 等叶子能力直接 import。
 * **不 import `index.js`**。
 *
 * @module @qqbot/dsh-plugin-qq/batch
 */
import { atMentions, messageToText } from './onebot.js';
import {
  batchCap as batchCapRule,
  batchScale as batchScaleRule,
  batchWindow as batchWindowRule,
} from './speaking-rules.js';
import { renderBacklog } from './backlog.js';
import { recallLine } from './recall.js';
import { interjectBatchPrompt, interjectLine } from './speech-policy.js';
import { fetchPageTitle, previewLine } from './links.js';
import { MAX_TIMER_MS } from './settings.js';

/** 攒批被「还忙着」挡住时，隔多久再看一眼（毫秒）。 */
const BACKLOG_POLL_MS = 1000;

/**
 * 一批里的一条消息 → 正文行。
 *
 * 普通消息折成一行（旧行为：一行一条才看得出「这是几条消息」）；带合并转发块的消息
 * 保留换行 —— 那个块本身就是多行排好的，压平会把层级和归属一起压没。`forward` 由
 * `submitBatch` 在转发展开成功时打上；续行的缩进由调用方按自己的前缀补。
 *
 * @param entry - `{ name, body, forward }`。
 * @returns 至少一行的正文；带转发的多行块按原样拆行。
 */
function entryBodyLines(entry) {
  const text = String(entry?.body ?? '').trim();
  if (entry?.forward === true && text.includes('\n')) return text.split('\n');
  return [text.replace(/\s+/g, ' ')];
}

/**
 * 建一组攒批函数。
 * @param deps - 见文件头的依赖表。
 * @returns `enqueue` / `holdForBatch` / `backlogBusy` / `backlogShouldHold` /
 *   `flushBatch` / `flushIfIdle` / `batchScale` / `batchWindow` / `batchCap`。
 */
export function createBatcher(deps) {
  const {
    settings,
    client,
    report,
    memory,
    submitted,
    sendToConversation,
    groupTalkActive,
    busyWithTurn,
    findRecent,
    mediaFor,
    resolveForwards,
    resolveQuote,
    imageAllowed,
    dropPrefix,
    quotePrefix,
    registerParticipant,
    ensureAgent,
    userMessageFor,
    describeConversation,
  } = deps;

  // ---- 攒批：几个人同时 @ 时只回一轮 -----------------------------------------

  /**
   * 这个会话现在的「倾听时间」倍数。
   *
   * 只有**多人搭话**的群会放大：大家正聊着的时候它该多听几句再开口，而不是每两秒截一句
   * 就回一轮。一对一的窗口不放大 —— 那边是「它正在跟你说话」，等太久反而像掉线。
   * @param conversation - 目标会话。
   * @returns 倍数（≥1）。
   */
  function batchScale(conversation) {
    // 私聊一律不放大（那边是「它正在跟你说话」，等太久像掉线）；先判类型再查热度，
    // 私聊连那次热度查询都省掉。
    if (conversation?.type !== 'group') return 1;
    return batchScaleRule('group', groupTalkActive(conversation.id), settings.activeGroupBatchScale);
  }

  /** 攒批窗口（毫秒）；配置非法或为 0 时返回 0，表示关闭攒批、来一条回一条。 */
  function batchWindow(scale) {
    return batchWindowRule(settings.batchWindowMs, scale);
  }

  /** 一批最多等多久（毫秒）。配置比窗口还小时没有意义，按下限（= 窗口）算；与窗口同倍放大。 */
  function batchCap(window, scale) {
    return batchCapRule(settings.batchMaxWaitMs, window, scale);
  }

  /**
   * 把一件「按到达顺序处理」的事挂到会话队列尾。
   *
   * 队列是每个会话一条的串行链：媒体落盘、确保 Agent 就绪、投递消息都在这条链上，
   * 处理顺序因此与消息到达顺序一致（否则「先发图、再说那句话」会被下载耗时颠倒）。
   * 失败时把原因回给发消息的人 —— 静默会被群里当成「机器人不理人」。
   * @returns 这条排进来的任务所在的队列承诺（`submitBatch` 用它在收尾时清 `submitting`）。
   */
  function enqueue(conversation, job) {
    conversation.queue = conversation.queue
      .then(job)
      .catch((error) => {
        const detail = error?.message ?? String(error);
        report('warn', `could not queue for ${conversation.key}: ${detail}`);
        void sendToConversation(conversation, `（我这边出错了：${detail}）`);
      });
    return conversation.queue;
  }

  /**
   * 收下一条要回的消息，先压着不投给 Agent：等一个窗口，看还有没有人接着说。
   *
   * 这是「几个人同时 @ 时不要分开回复」的关键。Harness 的 inbox 每次只从 next-turn
   * 里认领**一条**消息，也就是「一条消息 = 一轮 = 一条回复」；前后脚到的消息若逐条投递，
   * 群里看到的必然是机器人一条一条地分别答复每个人。攒成一条，才有一轮里把几个人
   * 一起接住的机会。
   *
   * 窗口从**最后一条**往后算（还有人接着说就再等一个窗口），但整批的等待以第一条
   * 到达时刻为起点卡一个上限（`batchMaxWaitMs`）—— 否则群里你一句我一句地 @ 下去，
   * 机器人会永远不吭声。多人搭话时这两个值一起按 `activeGroupBatchScale` 放大，
   * 于是它会多听几句再合成一轮（见 `batchScale`）。
   *
   * 它**正在忙**（上一轮还没跑完）时，这条消息不按「2 秒窗口」算，而是进一波迟到的
   * 消息（`entry.held`）：窗口到了也不投，等它闲下来合成一轮接（见 `flushBatch` /
   * `backlogBusy`）。不这么做的话，十分钟的长任务会攒出上百个 turn、上百条回复，
   * 每条都在回答几分钟前的问题。
   *
   * @param conversation - 目标会话。
   * @param entry - 已准入的这条消息 `{ message, name, userId, quote, at }`。
   */
  function holdForBatch(conversation, entry) {
    const scale = batchScale(conversation);
    const window = batchWindow(scale);
    if (window <= 0) {
      submitBatch(conversation, [entry]);
      return;
    }
    // 忙的时候到的消息都属于「一波迟到的对话」：多憋一会儿、回头一起接。
    // `batchBacklogHoldMs: 0` 是「不憋」—— 那样它就和关掉这一项一样，回到逐批排队。
    if (settings.batchBacklog === true && settings.batchBacklogHoldMs > 0 && backlogBusy(conversation)) entry.held = true;
    conversation.pending.push(entry);
    const cap = batchCap(window, scale);
    const since = conversation.pending[0].at;
    const wait = Math.max(0, Math.min(window, since + cap - Date.now(), MAX_TIMER_MS));
    if (conversation.batchTimer !== undefined) clearTimeout(conversation.batchTimer);
    conversation.batchTimer = setTimeout(() => flushBatch(conversation), wait);
    // 等待中的批次不该拖着进程不让退出（与 sleep 一致）。
    conversation.batchTimer.unref?.();
  }

  /**
   * 这个会话现在算不算「忙着」—— 攒批这边用的口径。
   *
   * 比 `busyWithTurn` 多算一件事：`submitBatch` 已经排上、但还没跑到 `followup` 的那段
   * 窗口。那段时间里 `submitted` 还是空的，只看它会把这个会话当成空闲，于是新到的消息
   * 可能被算进另一批、和正在投的那批分成两轮。
   * @param conversation - 目标会话。
   * @returns 忙时为 true。
   */
  function backlogBusy(conversation) {
    if (busyWithTurn(conversation)) return true;
    return (conversation.submitting ?? 0) > 0;
  }

  /**
   * 这一波还要不要继续憋着。
   *
   * 四个条件缺一不可：开关开着 · 这一波里确实有「忙的时候到的」条目 · 它现在还忙 ·
   * 还没憋到 `batchBacklogHoldMs` 的上限。上限是为了兜住「它卡住了」：卡着的 turn
   * 不会结束，没有上限的话这些消息就再也不会被投出去（比晚回糟得多）。
   * @param conversation - 目标会话。
   * @returns 需要继续等时为 true。
   */
  function backlogShouldHold(conversation) {
    if (settings.batchBacklog !== true) return false;
    if (!(settings.batchBacklogHoldMs > 0)) return false;
    if (!conversation.pending.some((item) => item.held === true)) return false;
    if (!backlogBusy(conversation)) return false;
    const since = Number(conversation.pending[0]?.at) || 0;
    return since > 0 && Date.now() - since < settings.batchBacklogHoldMs;
  }

  /**
   * 结束等待，把攒下的消息作为**一条** user message 投进会话队列。
   *
   * 忙的时候就别投：先重新挂一个短定时器（`BACKLOG_POLL_MS`），等它闲下来再投 ——
   * 那一整段会被 `submitBatch` 当成一波迟到的消息交给模型（见 `renderBacklog`）。
   * `force` 只有一个调用点：`/reset`。那批话是重置前说的，必须照旧先投出去。
   *
   * @param conversation - 目标会话。
   * @param options.force - 跳过「还忙着」的等待（`/reset` 用）。
   */
  function flushBatch(conversation, { force = false } = {}) {
    if (conversation.batchTimer !== undefined) {
      clearTimeout(conversation.batchTimer);
      conversation.batchTimer = undefined;
    }
    if (conversation.pending.length === 0) return;
    if (!force && backlogShouldHold(conversation)) {
      const since = Number(conversation.pending[0]?.at) || 0;
      const left = settings.batchBacklogHoldMs - (Date.now() - since);
      const wait = Math.max(50, Math.min(left, BACKLOG_POLL_MS));
      const timer = setTimeout(() => flushBatch(conversation), wait);
      timer.unref?.();
      conversation.batchTimer = timer;
      return;
    }
    const batch = conversation.pending.splice(0);
    submitBatch(conversation, batch);
  }

  /**
   * 一轮结束后看一眼：是不是有一波迟到的消息可以投了。
   *
   * 挂在 `turn/end` 上（而不是只靠定时器），是因为「忙完」这件事只有那里知道得最准：
   * 定时器最多晚一个 `BACKLOG_POLL_MS`，而这里能让积压的那一轮紧接着开始。只处理
   * `held` 的批次 —— 普通的 2 秒窗口有它自己的定时器，不该被提前截断。
   * @param conversation - 目标会话。
   */
  function flushIfIdle(conversation) {
    if (conversation === undefined) return;
    if (conversation.pending.length === 0) return;
    if (!conversation.pending.some((item) => item.held === true)) return;
    if (backlogBusy(conversation)) return;
    flushBatch(conversation);
  }

  /**
   * 把一批消息渲染成一条 user message 交给会话的 Agent。
   *
   * 媒体在这里才落盘（在队列上串行），一条里的图和话都按原样呈现给模型。
   * 只带 @、没有正文的消息在这里也**不丢**：正文换成一句「他 @ 了你一下，没说什么」
   * —— 模型得知道轮到自己说话了，才能决定回一句「？」、发张表情，还是接上一句
   * （见 `blankReply`）。只有在引用也没取到、整批确实什么都没有时才什么都不发。
   *
   * 一批里只要有一条是「忙的时候到的」（`held`），整批就按**一波迟到的消息**渲染
   * （见 `backlog.js` / `renderBacklog`）：它们不是几乎同时到的，而是它在忙别的事的
   * 那段时间里陆续到的 —— 这个事实必须交给模型，它才知道可以挑着接、或者 SKIP。
   */
  function submitBatch(conversation, batch) {
    // 排上队就算「忙」：到 `followup` 之前 `submitted` 还是空的（见 `backlogBusy`）。
    conversation.submitting = (conversation.submitting ?? 0) + 1;
    enqueue(conversation, async () => {
      const selfId = client.selfId;
      const held = batch.some((item) => item.held === true);
      const entries = [];
      for (const item of batch) {
        // 撤回的两种处理都在账上查：`action: 'drop'` 是「摘除的第二道」—— 这一批可能
        // 已经被 splice 出来、正在异步下媒体，那时数组里已经没有它，摘不掉了。
        const mark = findRecent(conversation.key, item.messageId);
        if (mark?.action === 'drop') continue;
        // 积压波里的「改写」降级成丢弃：隔八分钟再为一句撤回调侃一句，不合时宜，
        // 而且这一轮本来就不是为它开的（模型看到的是一大段别人的话）。
        if (held && mark?.action === 'rewrite') continue;
        // 本条自己的图、它在回复的那条（含转发）、以及本条里的合并转发一起取：
        // 三件事互不依赖，串起来等只是白等（转发展开自己还会再等子消息里的图）。
        const [resolved, quote, forwards] = await Promise.all([
          mediaFor(item.message),
          resolveQuote(item.message),
          resolveForwards(item.message),
        ]);
        // 再查一次：撤回可能就发生在这几十毫秒里（我们正在下媒体），而上面那次查是 await
        // 之前 —— 一次不够，正是这段异步窗口逼出了「把 action 记在账上」这个设计。
        if (mark?.action === 'drop') continue;
        // 引用成功时把 `[回复]` 占位符换成真正的引用前缀：否则模型会看到
        // 「（引用 kaguya: …）\n[回复]这啥」这种一半有内容、一半是噪音的正文。
        const rendered = new Map(resolved?.rendered ?? []);
        for (const [index, expanded] of forwards ?? []) rendered.set(index, expanded);
        if (quote !== undefined) rendered.set(quote.index, '');
        // 活跃对话里接上的那句没有前缀可去：按前缀长度硬切会把「然后呢」切成「后呢」。
        const raw = messageToText(item.message, selfId, rendered.size > 0 ? rendered : undefined).trim();
        // 改写成撤回提示：这一轮本来就为它开，模型在**同一轮**里看到「他 @ 了我又撤了」，
        // 回一句就够 —— 不必先回一句正经的、再补一句调侃（那是两连发）。正文整个换掉，
        // 连「他引用了谁」那一段也不接：被引用的那条正是已经不在的那条。
        const rewritten = mark?.action === 'rewrite'
          ? recallLine({
              name: mark.name,
              text: settings.recallTeaseQuote === true ? mark.text : undefined,
              imageAllowed: imageAllowed(),
            })
          : undefined;
        const body = rewritten ?? (item.continued === true ? raw : dropPrefix(raw));
        const composed = rewritten !== undefined || quote === undefined
          ? body
          : body.length > 0
            ? `${quotePrefix(quote)}\n${body}`
            : quotePrefix(quote);
        // 正文与引用都是空的（`admit` 里的空消息通常已经给了 `blankBody`，这里只是最后
        // 一道防线）：绝不能给模型递一条空消息 —— 它会以为出了一条没有内容的消息。
        const text = composed.length > 0 ? composed : (item.blankBody ?? '');
        if (text.length === 0) continue;
        // 裸 URL 可选地取一次标题（`linkPreview` 默认关：替群友访问任意 URL 是把部署机器的
        // 出口 IP 暴露给发链接的人，卡片消息不联网就能解析，已经够用）。
        const withLinks = await previewLinks(text);
        entries.push({
          name: item.name,
          id: item.userId,
          body: withLinks,
          // 这条消息里有展开成功的转发块：多消息批次要保留它的换行（见 entryBodyLines）。
          forward: forwards !== undefined,
          // 投递之后要能对回账上那一条（`submitted` / `replied` 两个进度，见 handleRecall）。
          messageId: String(item.messageId ?? ''),
          blank: item.blankBody !== undefined && item.blankBody.length > 0 && withLinks === item.blankBody,
          // 这一条是什么时候到的：一波迟到消息要按它算「几分钟前」，见 renderBacklog。
          at: Number(item.at) || 0,
        });
      }
      if (entries.length === 0) return;
      // 这一轮为什么轮到它：必须在渲染正文**之前**算出来（插话轮的正文要用它），
      // 写进会话记录，提示词（场景 / 人设的场景段）读它。积压的一波单独一个 intent：
      // 它既不是「刚有人跟我说话」，也不是免 @ 接话，场景提示词要说的是「你刚才在忙」。
      const intent = held ? 'backlog' : batchIntent(batch);
      conversation.pendingIntent = intent;
      // 三种投递文案：插话轮要说清「这不是叫你的」；积压的一波要带相对时间（否则模型
      // 会把八分钟前的问题当成刚发生的）；其余照旧。
      const text = held
        ? renderBacklog(entries, {
            now: Date.now(),
            maxEntries: settings.batchBacklogEntries,
            maxChars: settings.batchBacklogChars,
            canLookup: memory.toolsAllowed() === true,
          })
        : intent === 'interject'
          ? interjectBody(entries)
          : renderBatch(entries);
      const names = [...new Set(entries.map((entry) => entry.name))].join('、');
      report('info', `← ${describeConversation(conversation)} ${names}${entries.length > 1 ? `（${entries.length} 条）` : ''}${held ? '〔积压〕' : ''}: ${text.slice(0, 120)}`);
      // 发言人：提示词里要说得清「现在是谁在跟你说话」，所以几个人的话都记下来。
      // 同一个登记顺手保证他们都能被 @ 到（名单以「刚刚说过话」为序，见 `registerParticipant`）。
      const speakers = new Map();
      for (const entry of entries) speakers.set(entry.id, { name: entry.name, id: entry.id });
      conversation.speakers = [...speakers.values()];
      for (const speaker of conversation.speakers) registerParticipant(conversation, speaker.name, speaker.id);
      // 长期记忆的检索查询：这一轮真正投进去的正文 + 说话人（设计 §5.1）。
      // 只放**这一批**的正文（不是插话包装后的整段），检索要的是「他们在说什么」；
      // 说话人（以及这一批里被 @ 的人）用来保证「人物必进」。不落盘、只留最近这一条。
      const focusPeople = [...speakers.values()];
      for (const item of batch) {
        for (const mentioned of atMentions(item.message, selfId)) {
          if (mentioned.name.length > 0) focusPeople.push({ name: mentioned.name, id: mentioned.id });
        }
      }
      conversation.recallQuery = {
        text: entries.map((entry) => entry.body).join('\n').slice(0, 4000),
        at: Date.now(),
        speakers: focusPeople,
      };
      const agent = await ensureAgent(conversation);
      const userMessage = userMessageFor(conversation, text);
      // 只算**真正投进这一轮**的那些（被 `action: 'drop'` 摘掉的那条不在 entries 里）：
      // `turn/end` 之后靠它把账上那几条标成「已回复」。
      const batchIds = entries.map((entry) => entry.messageId).filter((id) => id.length > 0);
      for (const id of batchIds) {
        const mark = findRecent(conversation.key, id);
        if (mark !== undefined) mark.submitted = true;
      }
      // `blank`：这一批整批都是「空消息的替身」时，回复之后不挂补一句（那一轮没话题）。
      // `quote`：积压的一波不给指向 —— 引用八分钟前哪一条都像「我刚回的是他」；
      // 想叫谁让模型自己写 `[[@昵称]]`（`quoteHead` 也认 `backlog` 这个 intent）。
      submitted.set(userMessage.id, {
        key: conversation.key,
        quote: held ? { messageId: '', userId: '', seq: 0 } : batchQuote(batch),
        intent,
        batchIds,
        blank: entries.every((entry) => entry.blank === true),
        at: Date.now(),
      });
      agent.followup(userMessage);
    }).finally(() => {
      // 投递这一段（可能含媒体下载）结束：无论成功失败，会话都不再算「排着队」。
      conversation.submitting = Math.max(0, (conversation.submitting ?? 1) - 1);
    });
  }

  /**
   * 一批消息的「为什么轮到它」。
   *
   * 一批里可能混着「被叫到」与「窗口里接上的一句」：只要有一条是被明确叫到的，
   * 这一轮就是 `addressed`（模型得把它当成有人在跟它说话）；全是接话的才是 `continued`。
   * `interject` 由 `speech-policy` 判出来，单独带在条目上（见 `admit` 的返回）。
   * @param batch - 这一批 `{ intent }`。
   * @returns `intent` 字符串。
   */
  function batchIntent(batch) {
    const intents = batch.map((entry) => entry.intent ?? 'addressed');
    if (intents.includes('interject')) return 'interject';
    if (intents.includes('addressed')) return 'addressed';
    return intents[0] ?? 'addressed';
  }

  /**
   * 一批消息的回复指向。
   *
   * 只有「整批都是同一个人说的」才值得指向他最后那条；几个人一起问的时候引用谁的
   * 截图都像是只在回他，所以裸文本发出去，谁的话谁自己认领。
   * @param batch - 这一批 `{ userId, quote }`。
   * @returns 要挂在本轮第一条上的 `{ messageId, userId, seq }`。
   */
  function batchQuote(batch) {
    const senders = new Set(batch.map((entry) => entry.userId));
    if (senders.size === 1) return batch[batch.length - 1].quote;
    return { messageId: '', userId: '', seq: 0 };
  }

  /**
   * 插话轮的正文：元信息 + 锚点那句 + 「想接就接 / 不想接就 SKIP」。
   *
   * 只有一条时把「谁说的、说了什么」直接写进元信息（那就是锚点）；多条时元信息说一次、
   * 下面照常列「谁：什么」—— 否则每一行都套一句提醒，模型更容易只挑最后一句。
   * @param entries - `{ name, body }`，按到达顺序。
   * @returns user message 正文。
   */
  function interjectBody(entries) {
    const allowed = imageAllowed();
    if (entries.length === 1) {
      // 单条插话的文案是 `（… 某某 说：…）` 的包裹句；多行转发块塞进去会把包裹切断，
      // 所以单条仍用 `interjectLine` 压成一行。多条走下面的 `名字: 正文` 形式，能保留块。
      return interjectLine(entries[0].name, entries[0].body, allowed);
    }
    const lines = entries.flatMap((entry) => {
      const [first, ...rest] = entryBodyLines(entry);
      return [`${entry.name}: ${first}`, ...rest.map((line) => `  ${line}`)];
    });
    return [...interjectBatchPrompt(allowed), ...lines].join('\n');
  }

  /**
   * 把正文里的裸 URL 换成「【标题】 — 域名 链接」（`linkPreview` 打开时才做）。
   *
   * 三条边界都是「不可信输入」那条线上的：
   *   - 一条消息最多抓 **2** 个链接：不然一条刷屏消息能拖住整轮投递；
   *   - SSRF / 大小 / 超时 / 重定向全部由 `links.js` 兜住（见那边的模块注释）；
   *   - 抓到的标题是**数据**，原样放在方括号里渲染 —— 和 QQ 消息一样，不是指令。
   * 抓失败（内网、超时、不是 HTML）就保留原 URL：宁可没有标题，也不要丢链接。
   * @param text - 已渲染好的正文。
   * @returns 替换后的正文（没有 URL 或开关关着时原样返回）。
   */
  async function previewLinks(text) {
    if (!settings.linkPreview) return text;
    const urls = [...new Set(String(text).match(/https?:\/\/[^\s<>"'（）()【】]+/g) ?? [])]
      // 句末标点常常被粘在 URL 后面（「看这个 https://a.b/x。」），别把它们算进链接。
      .map((url) => url.replace(/[。，、；：！？…]+$/, ''))
      .filter((url) => url.length > 0)
      .slice(0, 2);
    if (urls.length === 0) return text;
    let out = String(text);
    for (const url of urls) {
      const result = await fetchPageTitle(url, {
        timeoutMs: settings.linkPreviewTimeoutMs,
        maxBytes: settings.linkPreviewMaxBytes,
        allowPrivateHosts: settings.linkAllowPrivateHosts,
      });
      const line = previewLine(result);
      if (line === undefined) continue;
      out = out.split(url).join(line);
    }
    return out;
  }

  /**
   * 把一批消息渲染成一条 user message 的正文。
   *
   * 只有一条时原样返回 —— 旧行为完全不变。多条时每行标出是谁说的、并在开头点一句
   * 「这些是几乎同时到的」，否则模型会把它读成一个人自说自话的一整段。
   * @param entries - `{ name, body }`，按到达顺序。
   */
  function renderBatch(entries) {
    if (entries.length === 1) return entries[0].body;
    // 普通消息折成一行（一行一条才看得出「这是几条消息」）；带转发的块保留多行，
    // 续行缩进到发言人下面 —— 否则一行里会冒出 `a: [合并转发] kaguya: …` 这种归属不明。
    const lines = entries.flatMap((entry) => {
      const [first, ...rest] = entryBodyLines(entry);
      return [`${entry.name}: ${first}`, ...rest.map((line) => `  ${line}`)];
    });
    const names = [...new Set(entries.map((entry) => entry.name))];
    const note = names.length > 1
      ? `（下面 ${entries.length} 条是几乎同时到的，${names.join('、')} 都在跟你说话）`
      : `（下面 ${entries.length} 条是${names[0]}连着发的）`;
    return [note, ...lines].join('\n');
  }

  return {
    enqueue,
    holdForBatch,
    backlogBusy,
    backlogShouldHold,
    flushBatch,
    flushIfIdle,
    batchScale,
    batchWindow,
    batchCap,
  };
}
