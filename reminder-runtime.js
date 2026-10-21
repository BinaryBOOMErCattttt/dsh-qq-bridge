/**
 * 定时提醒的运行时：到点怎么发、agent 那一轮怎么等、超时守卫怎么结算。
 *
 * 任务的生命周期（到点没到点、失败怎么退、重启怎么补）在 `reminders.js`；这里只做
 * `index.js` 原来那一块「发送 + Agent 轮 + 守卫」的事。从 `apply()` 闭包搬出来（第三批），
 * 函数名与注释保持不变，`index.js` 只装配并解构同名别名。
 *
 * 依赖表：
 *   - `ctx` / `client` / `settings` / `report`：定时器服务、连接、配置、日志；
 *   - `enqueueSend` / `sendOne` / `sendToConversation`：发送链路（`send.js`）；
 *   - `enqueue` / `targetConversation` / `ensureAgent` / `userMessageFor` /
 *     `submitted` / `noteRecallFallback`：攒批与 Agent 那一轮的闭包状态；
 *   - `pendingReminderTurns`：守卫账，**仍由 `index.js` 持有**（生命周期收尾要遍历它）。
 *
 * **不 import `index.js`**。
 *
 * @module @qqbot/dsh-plugin-qq/reminder-runtime
 */
import { chunkText } from './onebot.js';
import { errorText, localMinute } from './util.js';

/**
 * 建一组提醒运行时函数。
 * @param deps - 见文件头的依赖表。
 * @returns `scheduleTimer` / `deliverText` / `deliverModel` / `nudge` / `settle` / `run`。
 */
export function createReminderRuntime(deps) {
  const {
    ctx,
    client,
    settings,
    report,
    enqueueSend,
    sendOne,
    sendToConversation,
    enqueue,
    targetConversation,
    ensureAgent,
    userMessageFor,
    submitted,
    noteRecallFallback,
    pendingReminderTurns,
  } = deps;

  // ---- 定时提醒：发送、Agent 轮与守卫 -----------------------------------------
  //
  // 这一块只做「怎么把提醒发出去」与「agent 那一轮怎么等」；任务的生命周期
  // （到点没到点、失败怎么退、重启怎么补）在 reminders.js 里。

  /** 排一个一次性定时器；有 timer 服务就用它（插件卸载自动清），否则退回裸 setTimeout。 */
  function scheduleTimer(callback, ms) {
    if (typeof ctx.timeout === 'function') {
      const dispose = ctx.timeout(callback, ms);
      return typeof dispose === 'function' ? dispose : () => {};
    }
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return () => clearTimeout(handle);
  }

  /** 任务里的 @ 名单 → OneBot at 段；私聊不发 @（没有意义，也容易显示成怪东西）。 */
  function reminderAtSegments(task) {
    if (task?.type !== 'group') return [];
    return (Array.isArray(task.mentions) ? task.mentions : [])
      .filter((entry) => String(entry?.id ?? '').trim().length > 0)
      .map((entry) => ({ type: 'at', data: { qq: String(entry.id).trim() } }));
  }

  /**
   * 发提醒的固定文案：原样、不分气泡、不清标点、不加打字延迟。
   *
   * 为什么不复用 `sendToConversation(..., { human: true })`：提醒是「到点必须说出口」的
   * 承诺，气泡并条与标点清洗都可能改变它，拟人延迟还会让它晚几秒。文本走
   * `chunkText` 只按协议上限分段；@ 只挂在第一段。
   *
   * @returns `{ ok, retryable, reason }`：断线可重试，其余按失败处理。
   */
  async function deliverReminderText(task, text) {
    if (!client.connected) return { ok: false, retryable: true, reason: 'QQ bridge is not connected' };
    const conversation = targetConversation(task.type, task.targetId);
    const head = reminderAtSegments(task);
    const parts = chunkText(String(text ?? ''), settings.maxReplyChars);
    if (parts.length === 0) return { ok: true };
    let sent = false;
    await enqueueSend(conversation, async () => {
      for (const [index, part] of parts.entries()) {
        const message = index === 0 && head.length > 0 ? [...head, { type: 'text', data: { text: part } }] : part;
        if (!(await sendOne(conversation, message))) return;
        sent = true;
      }
    });
    return sent ? { ok: true } : { ok: false, retryable: true, reason: 'send failed' };
  }

  /**
   * 发 agent 写出来的正文：走正常拟人通道（拆句/打字延迟），但 @ 由任务注入。
   *
   * 不把 @ 交给模型自己写：重启后 participants 名单是空的、模型也可能忘；
   * `sendParts` 的 `at` 选项会把 at 段挂到第一个文字气泡前，且只挂一次。
   */
  async function deliverReminderModel(task, text) {
    if (!client.connected) return { ok: false, retryable: true, reason: 'QQ bridge is not connected' };
    const conversation = targetConversation(task.type, task.targetId);
    const ok = await sendToConversation(conversation, text, {
      human: true,
      at: task.mentions,
    });
    return ok === false ? { ok: false, retryable: true, reason: 'send failed' } : { ok: true };
  }

  /**
   * 到点提醒那一轮「伪造的 user message」。
   *
   * 与 `proactiveNudge` 的三条纪律相同：说清这不是谁发来的、给出 SKIP 出口（仅 prompt
   * 模式允许跳过）、别暴露机制。agent 模式**不给** SKIP 出口 —— 提醒不能因为模型
   * 「不想说」就消失，真不想说也得把事说出来。
   */
  function reminderNudge(task) {
    const at = localMinute(Number(task.scheduledAt) || Number(task.dueAt) || Date.now());
    const who = (Array.isArray(task.mentions) ? task.mentions : []).map((entry) => entry.name).join('、');
    const subject = who.length > 0 ? `提醒 ${who}` : '提醒这个会话';
    const lines = [
      `（这条不是谁发给你的消息，是插件在提醒你：你之前答应过在 ${at} ${subject}「${task.text}」，现在到点了。）`,
      '',
    ];
    if (task.mode === 'prompt') {
      lines.push(`要做的事：${task.prompt}`);
    } else {
      lines.push(`用你平时的语气把这件事说出来：${task.text}`);
    }
    lines.push(
      '',
      '注意：',
      '- 别提前面这条提醒，也别说「这是定时任务」；就当自己到点想起来了。',
      '- @ 由插件加，你不用自己写 @；一条就够，别刷屏。',
    );
    if (task.mode === 'prompt' && task.allowSkip === true) {
      lines.push('- 如果确实没事可报、或者做不成，就整条回复只写 `SKIP` —— 那样一个字都不会发出去。');
    } else {
      lines.push('- 这条不能跳过：至少要把这件事说出来。');
    }
    return lines.join('\n');
  }

  /** 结束（或丢弃）一条等待中的 agent 提醒；返回是否真的结算了。 */
  function settleReminderTurn(taskId, outcome) {
    const entry = pendingReminderTurns.get(taskId);
    if (entry === undefined) return false;
    pendingReminderTurns.delete(taskId);
    if (entry.guard !== undefined) {
      entry.guard();
      entry.guard = undefined;
    }
    entry.resolve(outcome);
    return true;
  }

  /**
   * 跑一轮 agent/prompt 提醒，兑现 `{ kind: 'reply'|'skip'|'failure'|'timeout', ... }`。
   *
   * 守卫按**任务**存而不是按会话存：`/reset` 会清掉这个会话的 turnOwners，那一轮的
   * `turn/end` 永远不会来 —— 只有这个守卫能把兜底文案发出去。超时之后迟到的
   * `turn/end` 会找不到 entry，按「已结算」静默丢弃。
   */
  function runReminderTurn(task) {
    return new Promise((resolve) => {
      const entry = { resolve, guard: undefined };
      pendingReminderTurns.set(task.id, entry);
      entry.guard = scheduleTimer(() => {
        pendingReminderTurns.delete(task.id);
        report('warn', `reminder ${task.id}: agent turn timed out after ${settings.reminderAgentTimeoutMs}ms; falling back`);
        resolve({ kind: 'timeout' });
      }, settings.reminderAgentTimeoutMs);

      const conversation = targetConversation(task.type, task.targetId);
      enqueue(conversation, async () => {
        try {
          if (!client.connected) {
            settleReminderTurn(task.id, { kind: 'failure', reason: 'QQ bridge is not connected' });
            return;
          }
          conversation.pendingIntent = 'reminder';
          noteRecallFallback(conversation);
          const agent = await ensureAgent(conversation);
          const message = userMessageFor(conversation, reminderNudge(task));
          // 与主动搭话同一套归属记账，但**不标 proactive**：proactive 在 turn/end 里
          // 出错会被静默吞掉，而提醒必须要能走到兜底。
          submitted.set(message.id, {
            key: conversation.key,
            quote: { messageId: '', userId: '', seq: 0 },
            intent: 'reminder',
            reminderId: task.id,
            at: Date.now(),
          });
          agent.followup(message);
        } catch (error) {
          settleReminderTurn(task.id, { kind: 'failure', reason: errorText(error) });
        }
      });
    });
  }

  return {
    scheduleTimer,
    deliverText: deliverReminderText,
    deliverModel: deliverReminderModel,
    nudge: reminderNudge,
    settle: settleReminderTurn,
    run: runReminderTurn,
  };
}
