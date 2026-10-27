/**
 * 定档（交接）：把最近上下文写进 Markdown、归档旧会话、新开一轮，并让新 Agent 先读那份文档。
 *
 * 为什么不是简单的 `/reset`：上下文清零之后模型会「失忆」，群里正聊到一半它会像换了个人。
 * 交接文档把「最近说了什么、还有什么没做完、当前静默 / 提醒状态」留下来，新会话先读它，
 * 接得上再开口；旧会话目录移到 `data/handoff/archive/`，不再被 resume。
 *
 * 这里有两条触发路径，共用同一套动作：
 *
 *   1. **主人发 `定档`**（`reason: 'manual'`）—— 明确的动作，回一句「写好了」；
 *   2. **兜底**：主人说了「睡觉去」这类话，模型本该调 `qq_quiet` 让它静默；12 秒内
 *      没真的静默（模型没调、或者调了别的群），就自动走定档（`reason: 'sleep-fallback'`）。
 *      为什么要有这条兜底：`qq_quiet` 是**模型**判断的，它偶尔会答一句「好，睡了」却
 *      没真的调工具 —— 那样群里下一句还是会把它叫醒，主人的意思完全落空。定档是插件侧
 *      一定能做到的收尾。
 *
 * 模块开关（`moduleHandoff`）必须两层都认：指令侧由 `COMMAND_MODULES` 拦（简洁模式也
 * 放行这一条），而**兜底这条不经过指令分流**，所以这里自己再判一次 —— 关掉定档之后，
 * 主人说「睡觉去」不该还悄悄写一份交接文档、换一代会话。
 *
 * 依赖全部由 `index.js` 显式传入（会话反查、发送、换代、转录），本模块不 import
 * `index.js`，也不持有全局状态；文档正文的拼法是导出的纯函数，可以单独验。
 *
 * @module @qqbot/dsh-plugin-qq/handoff
 */
import { mkdir, readdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { atMentions, mentions, messageToText, userDisplayName } from './onebot.js';
import { errorText, memorySlug, sessionIdFor } from './util.js';
import { writeTextAtomic } from './filestore.js';

/** 说了「睡觉去」之后等多久：这段时间里模型该调 `qq_quiet` 把群静默掉。 */
export const HANDOFF_FALLBACK_MS = 12_000;

/** 交接文档里「最近对话」最多写多少条。 */
export const HANDOFF_TAIL = 80;

/** 交接文档正文上限：再长就不像一份交接，而像一份日志了。 */
export const HANDOFF_DOC_MAX = 12_000;

/** 「可能未完成的事」的关键词：只做提示，不保证准 —— 文档里就是这么写的。 */
const TASK_HINT = /提醒|任务|待办|记得|别忘|答应/u;

/** 「睡觉去」这类短句（去掉空白后整句匹配，超过 12 字就不算）。 */
const SLEEP_PATTERN = /^(睡觉去|去睡吧|睡吧|休眠|静默|该睡了|该睡啦|睡吧你)/u;

/** 转录行 → 文档里的一行（去换行、裁长度）。 */
function lineOf(entry) {
  const who = entry?.name ?? entry?.user ?? '某人';
  return `- ${who}：${String(entry?.text ?? '').replace(/\s+/gu, ' ').slice(0, 200)}`;
}

/**
 * 拼交接文档的正文（纯函数：同样的入参永远同样的字符串，不碰磁盘）。
 *
 * @param input - `{ conversation, reason, tail, tasks, ambientTail, muted, generation, at }`：
 *   `tail` 是最近对话（旧 → 新），`tasks` 是关键词命中的行，`ambientTail` 是群里最近的
 *   环境缓冲（今天没有转录时用它兜底）。
 * @returns Markdown 正文（不含尾部换行）。
 */
export function handoffDocText({ conversation, reason, tail = [], tasks = [], ambientTail = [], muted = false, generation = 0, at = Date.now() }) {
  const conversationLabel = conversation.name.length > 0 ? `${conversation.key}（${conversation.name}）` : conversation.key;
  const recent = Array.isArray(tail) && tail.length > 0
    ? tail.slice(-HANDOFF_TAIL).map(lineOf)
    : ['（今天的转录是空的，下面是群聊环境缓冲）', ...ambientTail.map(lineOf)];
  const pending = Array.isArray(tasks) && tasks.length > 0
    ? tasks.map(lineOf)
    : ['（没有明显命中的任务；以最近对话为准）'];
  return [
    '# 交接文档',
    '',
    `- 会话：${conversationLabel}`,
    `- 时间：${new Date(at).toLocaleString('zh-CN', { hour12: false })}`,
    `- 原因：${reason === 'sleep-fallback' ? '主人说睡但静默失败，自动定档' : '主人手动定档'}`,
    `- 会话轮次：${generation}`,
    `- 静默状态：${muted ? '静默中' : '醒着'}`,
    '',
    `## 最近对话（旧 → 新，最多 ${HANDOFF_TAIL} 条）`,
    '',
    ...recent,
    '',
    '## 可能未完成的事（关键词命中，供参考）',
    '',
    ...pending,
    '',
    '## 备注',
    '',
    '- 旧会话已归档到 `data/handoff/archive/`，长期记忆仍在 `.qq-memory/`。',
    '- 读完这份文档后，先接上当前话题，不要逐条复述。',
  ].join('\n').slice(0, HANDOFF_DOC_MAX);
}

/**
 * 建一套定档动作。
 *
 * @param deps - 依赖表：
 *   - `cwd` / `settings` / `report`；
 *   - `moduleEnabled(name)`：`moduleHandoff` 关掉时整条通道不可用（含兜底）；
 *   - `canOperate(userId)`：主人判定（「睡觉去」只认主人）；
 *   - `conversationFor(type, id, sender)`：取 / 建会话记录；
 *   - `todayTranscript(key)`：今天这个会话的转录行；
 *   - `ambientTail(conversation)`：群里最近的消息（转录为空时兜底）；
 *   - `isMuted(key)`：当前是否静默；
 *   - `describe(conversation)`：日志里的会话名；
 *   - `send(conversation, text)`：发一句话（不等待）；
 *   - `resetConversation(conversation)`：销毁旧 Agent、代次 +1（返回是否成功）；
 *   - `startAgentTurn(conversation, text, meta)`：开一轮交给模型；
 *   - `sessionRoot()`：Session 持久化根（拿不到就不归档）；
 *   - `now()` / `setTimeout` / `clearTimeout`：测试注入用。
 * @returns 见文件末尾的返回对象。
 */
export function createHandoff({
  cwd,
  settings,
  report = () => {},
  moduleEnabled = () => true,
  canOperate = () => false,
  conversationFor = () => undefined,
  todayTranscript = async () => [],
  ambientTail = () => [],
  isMuted = () => false,
  describe = (conversation) => conversation.key,
  send = () => {},
  resetConversation = async () => false,
  startAgentTurn = () => {},
  sessionRoot = () => undefined,
  now = () => Date.now(),
  setTimeout: setTimeoutOf = setTimeout,
  clearTimeout: clearTimeoutOf = clearTimeout,
}) {
  /**
   * 主人说「睡觉去」这类短句时返回会话；群聊要求 @ / 前缀 / all。
   *
   * 与 `qq_quiet` 的分工：这里**不执行**静默，只是记一笔「这家伙刚说要睡」，12 秒后
   * 检查静默真的发生了没有。所以它认的句子必须同时是「会交给模型处理」的那些 ——
   * 否则模型根本没机会调 `qq_quiet`。
   * @param event - 入站事件。
   * @param selfId - 机器人自己的 QQ 号。
   * @returns 会话记录；不是这句话 / 不是主人 / 不是消息事件时 undefined。
   */
  function sleepIntentFor(event, selfId) {
    if (event?.post_type !== 'message') return undefined;
    if (!moduleEnabled('handoff')) return undefined;
    const type = event.message_type === 'group' ? 'group' : event.message_type === 'private' ? 'private' : undefined;
    if (type === undefined) return undefined;
    const userId = String(event.user_id ?? '');
    if (userId === '' || userId === String(selfId) || !canOperate(userId)) return undefined;
    const raw = messageToText(event.message ?? event.raw_message, selfId).trim();
    if (raw.length === 0) return undefined;
    let text = raw;
    if (type === 'group') {
      const prefixed = settings.groupTrigger === 'prefix' && raw.startsWith(settings.prefix);
      const explicit = settings.groupTrigger === 'all' || mentions(event.message, selfId) || prefixed;
      if (!explicit) return undefined;
      if (prefixed) text = raw.slice(settings.prefix.length).trim();
    }
    const compact = text.replace(/[\s\u3000]+/gu, '');
    if (compact.length > 12) return undefined;
    if (!SLEEP_PATTERN.test(compact)) return undefined;
    const id = type === 'group' ? String(event.group_id) : userId;
    const displayName = userDisplayName(event.sender ?? {}, event.user_id);
    return conversationFor(type, id, {
      userId,
      userName: displayName,
      name: displayName,
      mentions: type === 'group' ? atMentions(event.message, selfId) : undefined,
    });
  }

  /** 记下「主人刚说了睡」：12 秒内没真的静默，就走定档兜底。 */
  function markSleepIntent(conversation) {
    if (conversation === undefined) return;
    conversation.sleepIntentAt = now();
    if (conversation.sleepTimer !== undefined) clearTimeoutOf(conversation.sleepTimer);
    const timer = setTimeoutOf(() => {
      conversation.sleepTimer = undefined;
      if (conversation.sleepIntentAt === undefined) return;
      if (isMuted(conversation.key)) {
        conversation.sleepIntentAt = undefined;
        return;
      }
      conversation.sleepIntentAt = undefined;
      report('info', `${describe(conversation)} 说了睡但没真的静默，改走定档`);
      void handoff(conversation, 'sleep-fallback');
    }, HANDOFF_FALLBACK_MS);
    timer?.unref?.();
    conversation.sleepTimer = timer;
  }

  /** 清掉「等它静默」的定时器（静默成功 / 被叫醒 / 已定档时调用）。 */
  function clearSleepIntent(conversation) {
    if (conversation === undefined) return;
    conversation.sleepIntentAt = undefined;
    if (conversation.sleepTimer !== undefined) {
      clearTimeoutOf(conversation.sleepTimer);
      conversation.sleepTimer = undefined;
    }
  }

  /** 把最近上下文写成交接文档；返回相对 cwd 的路径。 */
  async function writeDoc(conversation, reason) {
    const lines = await todayTranscript(conversation.key);
    const doc = handoffDocText({
      conversation,
      reason,
      tail: lines.slice(-HANDOFF_TAIL),
      tasks: lines.filter((line) => TASK_HINT.test(String(line?.text ?? ''))).slice(-10),
      ambientTail: conversation.type === 'group' ? ambientTail(conversation).slice(-12) : [],
      muted: isMuted(conversation.key),
      generation: conversation.sessionGeneration ?? 0,
      at: now(),
    });
    const stamp = new Date(now()).toISOString().replace(/[:.]/gu, '-');
    const rel = `data/handoff/${memorySlug(conversation.key)}-${stamp}.md`;
    await mkdir(join(cwd, 'data', 'handoff'), { recursive: true });
    await writeTextAtomic(join(cwd, rel), `${doc}\n`);
    return rel;
  }

  /** 把旧会话目录移出 sessions 根目录（保留作归档，不再被 resume）。 */
  async function archiveSessionDir(oldSessionId) {
    const root = sessionRoot();
    if (typeof root !== 'string' || root.length === 0) return;
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const source = join(root, entry.name, oldSessionId);
        const info = await stat(source).catch(() => undefined);
        if (info?.isDirectory() !== true) continue;
        const target = join(cwd, 'data', 'handoff', 'archive', `${oldSessionId}-${now()}`);
        await mkdir(dirname(target), { recursive: true });
        await rename(source, target);
        report('info', `handoff: archived ${oldSessionId} → ${target}`);
        return;
      }
    } catch (error) {
      report('warn', `handoff: could not archive ${oldSessionId}: ${errorText(error)}`);
    }
  }

  /**
   * 定档：写文档 → 归档旧会话 → 新开一轮 → 第一句话读文档。
   * @param conversation - 目标会话。
   * @param reason - `manual` / `sleep-fallback`。
   */
  async function handoff(conversation, reason) {
    if (conversation.handoffBusy === true) return;
    // 兜底那条不经过指令分流，模块开关只能在这里判（见文件头第 3 段）。
    if (!moduleEnabled('handoff')) {
      report('info', `handoff: module is off (${reason}), skipped for ${describe(conversation)}`);
      if (reason === 'manual') send(conversation, '定档模块现在是关的；要开就在设置里把 moduleHandoff 设成 true。');
      return;
    }
    conversation.handoffBusy = true;
    clearSleepIntent(conversation);
    try {
      // 攒着的那批消息属于**上一轮**：先把它们丢掉，否则它们会被算进新会话的第一轮，
      // 而新 Agent 还没读过交接文档。字段与 `holdForBatch` 用的是同一对（pending / batchTimer）。
      conversation.pending.length = 0;
      if (conversation.batchTimer !== undefined) {
        clearTimeoutOf(conversation.batchTimer);
        conversation.batchTimer = undefined;
      }
      const oldSessionId = sessionIdFor(conversation.key, conversation.sessionGeneration ?? 0);
      const rel = await writeDoc(conversation, reason);
      const ok = await resetConversation(conversation);
      if (!ok) {
        send(conversation, '（定档失败：旧会话没能关掉，先别急着重开）');
        return;
      }
      await archiveSessionDir(oldSessionId);
      send(conversation, `（交接文档写好了：\`${rel}\`，旧会话已归档，正在新开一轮）`);
      startAgentTurn(
        conversation,
        [
          `（插件转告：你刚接手这个会话。先用 read 读交接文档 \`${rel}\`，`,
          '里面是上一段对话的最近上下文、可能未完成的事和当前状态。',
          '读完用一两句话确认你接上了；不要逐条复述，也不要说“交接文档”这四个字。）',
        ].join('\n'),
        { intent: 'handoff', command: '定档' },
      );
    } finally {
      conversation.handoffBusy = false;
    }
  }

  return { sleepIntentFor, markSleepIntent, clearSleepIntent, writeDoc, archiveSessionDir, handoff };
}
