/**
 * 定时提醒：任务模型、时间推算、权限校验、持久化与调度。
 *
 * 为什么单独一个模块：提醒是**跨轮**的东西 —— 用户说「明早 8 点提醒我」时那一轮已经
 * 结束了，模型不在场；到点必须由插件把这件事做完。因此它需要自己的状态文件、自己的
 * 定时器，以及一条不依赖 Agent 的发送路径。把这些塞进 `index.js` 的闭包里，会让那张
 * 已经四千多行的文件再多出一整套「到点之后」的分支。
 *
 * 三条边界（与 index.js 的分工）：
 *   1. **本模块不 import index.js**：会话、Agent、OneBot 都由 `deps` 传进来；
 *   2. **本模块只管任务的生命周期**：到点该发什么、发完算不算成功、失败怎么重试；
 *      「怎么发」是 `deps.deliverText` / `deps.deliverModel` 的事；
 *   3. **纯函数全部导出**：时间推算、校验、模式决策都能单测，不用起 Harness。
 *
 * 三种模式：
 *   - `text`：原样发固定文案。最可靠，不花 token，**任何时候都是兜底**；
 *   - `agent`：到点跑一轮模型，把文案用它的语气说出来；模型失败/超时/SKIP 时回退到
 *     固定文案 —— 提醒是承诺，不能因为模型抽风就消失；
 *   - `prompt`：到点跑一轮模型，按指令做事（可调工具）。默认关闭，且只给受信者。
 *
 * @module @qqbot/dsh-plugin-qq/reminders
 */
import { randomBytes } from 'node:crypto';
import { localDate, localMinute, parseLocalMinute } from './util.js';
import { readTextOrUndefined, writeJsonAtomic } from './filestore.js';

/** 三种模式，顺序同时表示「能力上限」：`text` < `agent` < `prompt`。 */
export const REMINDER_MODES = ['text', 'agent', 'prompt'];

/** 周期类型。`none` 是一次性任务。 */
export const REMINDER_REPEATS = ['none', 'daily', 'weekdays', 'weekly', 'monthly'];

/**
 * 设置页读取任务列表的 Host 路由（Connection 的 `/api` 认证栅栏内）。
 *
 * `client.js` 是浏览器 bundle，不能 import 这个模块，所以那条字符串在两边各写一份；
 * `test/client.test.mjs` 断言两处相等，改路径时漏改一边会红。
 */
export const REMINDER_ROUTE_PATH = '/api/qq-bridge/reminders';

/** 固定文案/agent 文案的长度上限：提醒不是小作文。 */
const TEXT_MAX = 200;

/**
 * prompt 模式的上限比文案宽：它是一段「要做什么」的说明，不是最终发出去的那句话。
 * 仍然有上限 —— 它会被拼进提示词，不该成为一次上下文注入。
 */
const PROMPT_MAX = 500;

/** 一条任务最多 @ 几个人：再多就接近刷屏了。 */
const MENTION_MAX = 5;

/** 最远能提前多久：再远的事，部署重启/迁移之后也未必还成立。 */
const HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * 最早能提前多久：至少要留出一拍，否则「现在提醒我」会在同一轮里立刻发出去，
 * 既没有意义，也容易和正在发送的回复抢队列。
 */
const MIN_LEAD_MS = 30 * 1000;

/** 历史任务（done / missed / failed / cancelled）保留多久，供 `qq_remind_list` 查。 */
const HISTORY_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** 任务文件最多留多少条，防止手工/滥用把文件撑大。 */
const MAX_TASKS = 500;

/**
 * 定时器一次最多睡多久。
 *
 * `setTimeout` 的上限是 `2^31-1` 毫秒（约 24.8 天），超过会溢出成 1ms 疯狂空转；
 * 这里再压到 1 小时：系统时钟被改、进程被挂起之后，最多一小时就能自己校正回来，
 * 而空闲时一小时醒一次的成本可以忽略。
 */
const MAX_SLEEP_MS = 60 * 60 * 1000;

/** 断线/发送失败后的重试间隔（还要受 grace 约束）。 */
const RETRY_MS = 15 * 1000;

/** `qq_remind_list` 一次最多返回多少条。 */
const LIST_MAX = 20;

/** 同一会话 + 同一时刻 + 同一内容的去重窗口：模型重试时不该建出两条。 */
const DUPLICATE_WINDOW_MS = 60 * 1000;

/** 本地 `YYYY-MM-DD HH:MM`。 */
function atLabel(at) {
  return localMinute(at);
}

/** 周期类型的中文说明（日志与工具结果用）。 */
export function repeatLabel(repeat) {
  if (repeat === null || repeat === undefined) return '一次';
  if (repeat.kind === 'daily') return '每天';
  if (repeat.kind === 'weekdays') return '工作日';
  if (repeat.kind === 'weekly') return `每周${'一二三四五六日'[repeat.weekday - 1] ?? ''}`;
  if (repeat.kind === 'monthly') return `每月 ${repeat.day} 日`;
  return repeat.kind;
}

/** 模式的中文说明（日志用）。 */
export function modeLabel(mode) {
  if (mode === 'agent') return 'Agent 组织';
  if (mode === 'prompt') return 'Agent 执行';
  return '固定文案';
}

/**
 * 把一段不可信文本洗成「可以直接发出去」的样子。
 *
 * 只做三件事：统一换行、去掉控制字符、去首尾空白。**不做任何标记解析** ——
 * `[[图片: …]]` / `[[@某人]]` 在提醒里必须是六个字符的原文，否则群友就能借一条
 * 定时任务让机器人到点发图或 @ 任意的人（那是把不可信输入直接接到发送侧）。
 * @param raw - 原始文本。
 * @param max - 字符上限（按 code point 数）。
 * @param label - 报错里用的字段名。
 * @returns 清洗后的文本。
 */
function cleanText(raw, max, label) {
  const text = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    // 保留 \n 与 \t，其余 C0 控制字符去掉：它们会让日志与 QQ 客户端出现奇怪的空行。
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim();
  if (text.length === 0) throw new Error(`${label} is required`);
  const length = [...text].length;
  if (length > max) throw new Error(`${label} is too long (${length} > ${max} characters)`);
  return text;
}

/**
 * 从一次性的 `at` 推导出周期规格。
 *
 * 周期只存**日历分量**（时/分/星期/日号），不存「下次的毫秒数」：后者在跨天、
 * 跨月、夏令时切换之后会算错，而日历分量每次都能重新推出正确的下一个时刻。
 * @param kind - `none` / `daily` / `weekdays` / `weekly` / `monthly`。
 * @param at - 第一次触发的毫秒时刻（提供时/分与星期/日号）。
 * @returns 周期规格；`none` 时为 null。
 */
export function repeatSpec(kind, at) {
  const value = String(kind ?? 'none').trim().toLowerCase();
  if (!REMINDER_REPEATS.includes(value)) {
    throw new Error(`repeat must be one of ${REMINDER_REPEATS.join(' / ')}`);
  }
  if (value === 'none') return null;
  const date = new Date(Number(at));
  const spec = { kind: value, hour: date.getHours(), minute: date.getMinutes() };
  if (value === 'weekly') spec.weekday = date.getDay() === 0 ? 7 : date.getDay();
  if (value === 'monthly') spec.day = date.getDate();
  return spec;
}

/**
 * 严格晚于 `after` 的下一个周期时刻（本地时间）。
 *
 * 各周期的算法：
 *   - `daily`：今天的 HH:MM，已过就明天；
 *   - `weekdays`：跳过周六/周日（最多往后看 8 天）；
 *   - `weekly`：算到目标星期的天数，已过就 +7 天；
 *   - `monthly`：按日号算，**小月夹到月末**（31 号在 2 月落到 28/29 号），
 *     再往后逐月找第一个严格晚于 `after` 的。
 *
 * 一律用 `new Date(y, m, d, h, min)` 从日历分量构造，而不是 `after + 24h`：
 * 后者在夏令时切换当天会偏一小时。本地时间不存在的那一小时（春季跳表）由
 * `Date` 自己归一化到下一个有效时刻，提醒晚一小时好过不发。
 *
 * @param spec - {@link repeatSpec} 的返回值。
 * @param after - 毫秒时刻。
 * @returns 下一次触发的毫秒时刻（严格大于 `after`）。
 */
export function nextOccurrence(spec, after) {
  const date = new Date(Number(after));
  const { hour, minute } = spec;
  const at = (year, month, day) => new Date(year, month, day, hour, minute, 0, 0).getTime();
  if (spec.kind === 'daily') {
    const today = at(date.getFullYear(), date.getMonth(), date.getDate());
    return today > after ? today : at(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  }
  if (spec.kind === 'weekdays') {
    for (let offset = 0; offset < 8; offset += 1) {
      const candidate = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset, hour, minute, 0, 0);
      const day = candidate.getDay();
      if (day === 0 || day === 6) continue;
      if (candidate.getTime() > after) return candidate.getTime();
    }
    throw new Error('could not find the next weekday');
  }
  if (spec.kind === 'weekly') {
    const current = date.getDay() === 0 ? 7 : date.getDay();
    const delta = (spec.weekday - current + 7) % 7;
    let candidate = at(date.getFullYear(), date.getMonth(), date.getDate() + delta);
    if (candidate <= after) candidate = at(date.getFullYear(), date.getMonth(), date.getDate() + delta + 7);
    return candidate;
  }
  if (spec.kind === 'monthly') {
    for (let offset = 0; offset < 24; offset += 1) {
      const first = new Date(date.getFullYear(), date.getMonth() + offset, 1, hour, minute, 0, 0);
      const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      const candidate = at(first.getFullYear(), first.getMonth(), Math.min(spec.day, daysInMonth));
      if (candidate > after) return candidate;
    }
    throw new Error('could not find the next monthly occurrence');
  }
  throw new Error(`unknown repeat kind: ${spec.kind}`);
}

/**
 * 校验并归一化 `@` 名单。
 *
 * 名字到 QQ 号的解析在 `index.js`（名单挂在会话记录上），这里只负责三件事：
 * 去重、数量上限、以及**权限** —— 不能 @ 名单外的人、不能 @ 全体成员。
 * @param mentions - `{ id, name }[]`（调用方已经解析成稳定的 QQ 号）。
 * @param options.callerId - 创建者的 QQ 号（`@me` 解析后的那个）。
 * @param options.canMentionOthers - 能不能 @ 创建者以外的人。
 * @param options.canAll - 能不能 @全体成员。
 * @returns 归一化后的名单（`@all` 单独一个）。
 */
export function normalizeMentions(mentions, { callerId = '', canMentionOthers = false, canAll = false } = {}) {
  const list = Array.isArray(mentions) ? mentions : [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const id = String(entry?.id ?? '').trim();
    const name = String(entry?.name ?? '').trim();
    if (id.length === 0 || name.length === 0 || seen.has(id)) continue;
    if (id === 'all') {
      if (!canAll) throw new Error('@all is not allowed in this deployment (reminderAllowAll is false)');
      // @all 吸收其余的人：一条消息里既有全体又有个人只是噪音。
      return [{ id: 'all', name: '全体成员' }];
    }
    if (id !== String(callerId) && !canMentionOthers) {
      throw new Error('mentioning other people is disabled (reminderMentionOthers is false)');
    }
    seen.add(id);
    out.push({ id, name });
  }
  if (out.length > MENTION_MAX) throw new Error(`at most ${MENTION_MAX} people can be mentioned`);
  return out;
}

/**
 * 校验并归一化一次创建请求（纯函数）。
 *
 * 时间的三条规则：
 *   - `at`（本地 `YYYY-MM-DDTHH:MM`）与 `in_minutes` 二选一；
 *   - 一次性任务必须比现在晚至少 {@link MIN_LEAD_MS}；
 *   - 周期任务如果第一次时刻已经过去，就**滚到下一个未来时刻**（「每天 9 点」在 10 点
 *     说也成立），而不是报错。
 *
 * @param input - `{ mode, text, prompt, fallbackText, allowSkip, at, inMinutes, repeat, mentions }`。
 * @param options.now - 当前毫秒时刻。
 * @param options.maxMode - 部署允许的最高模式。
 * @param options.callerId - 创建者 QQ 号。
 * @param options.canMentionOthers - 见 {@link normalizeMentions}。
 * @param options.canAll - 见 {@link normalizeMentions}。
 * @returns 归一化后的任务字段（不含 id / 创建者 / 状态）。
 */
export function normalizeTaskInput(input, { now = Date.now(), maxMode = 'text', callerId = '', canMentionOthers = false, canAll = false, trusted = false } = {}) {
  const mode = String(input?.mode ?? 'text').trim().toLowerCase();
  if (!REMINDER_MODES.includes(mode)) throw new Error(`mode must be one of ${REMINDER_MODES.join(' / ')}`);
  if (!REMINDER_MODES.includes(maxMode)) throw new Error(`unknown max mode: ${maxMode}`);
  if (REMINDER_MODES.indexOf(mode) > REMINDER_MODES.indexOf(maxMode)) {
    throw new Error(`mode "${mode}" is disabled in this deployment (reminderModes is "${maxMode}")`);
  }
  // prompt 是「无人在场的指令执行」：即使部署把 reminderModes 开到 prompt，也只给受信者。
  if (mode === 'prompt' && trusted !== true) throw new Error('prompt mode is only allowed for trusted users');

  const prompt = mode === 'prompt' ? cleanText(input?.prompt, PROMPT_MAX, 'prompt') : '';
  // prompt 模式的 text 只是标签/兜底候选；没给就从指令里截一段，日志里才看得出是哪条。
  const text = mode === 'prompt'
    ? (String(input?.text ?? '').trim().length > 0 ? cleanText(input.text, TEXT_MAX, 'text') : [...prompt].slice(0, TEXT_MAX).join(''))
    : cleanText(input?.text, TEXT_MAX, 'text');
  const fallbackText = String(input?.fallbackText ?? '').trim().length > 0
    ? cleanText(input.fallbackText, TEXT_MAX, 'fallback_text')
    : (mode === 'prompt' ? '' : text);
  const allowSkip = mode === 'prompt' ? input?.allowSkip !== false : false;
  if (mode === 'prompt' && allowSkip === false && fallbackText.length === 0) {
    throw new Error('fallback_text is required when allow_skip is false');
  }

  const hasAt = input?.at !== undefined && String(input.at).trim().length > 0;
  const hasIn = input?.inMinutes !== undefined && input?.inMinutes !== null && String(input.inMinutes).trim().length > 0;
  if (hasAt === hasIn) throw new Error('exactly one of at / in_minutes is required');
  if (hasIn && String(input?.repeat ?? 'none').toLowerCase() !== 'none') {
    throw new Error('repeat requires an absolute "at" time');
  }

  let dueAt;
  if (hasAt) {
    const parsed = parseLocalMinute(input.at);
    if (parsed === undefined) throw new Error('at must look like 2026-08-21T08:00 (local time)');
    dueAt = parsed.at;
  } else {
    const minutes = Number(input.inMinutes);
    if (!Number.isFinite(minutes) || minutes < 1) throw new Error('in_minutes must be a positive number');
    dueAt = now + Math.round(minutes * 60 * 1000);
  }

  const repeat = repeatSpec(input?.repeat, dueAt);
  if (repeat !== null && dueAt <= now) dueAt = nextOccurrence(repeat, now);
  if (dueAt <= now + MIN_LEAD_MS) {
    throw new Error(`the reminder time is too soon; it must be at least ${Math.round(MIN_LEAD_MS / 1000)} seconds from now`);
  }
  if (dueAt - now > HORIZON_MS) throw new Error('the reminder time is too far in the future (more than 365 days)');

  const mentions = normalizeMentions(input?.mentions, { callerId, canMentionOthers, canAll });
  return { mode, text, prompt, fallbackText, allowSkip, dueAt, repeat, mentions };
}

/**
 * 到点之后「这一轮该怎么收尾」的纯判断。
 *
 * 把这张表从闭包里拿出来，是因为这里最容易写错、也最需要逐格验：
 *
 * | 模式   | 情况                                   | 结果       |
 * |--------|----------------------------------------|------------|
 * | 任意   | 已经发过                               | `none`     |
 * | agent  | 模型正常有文本                         | `model`    |
 * | agent  | SKIP / 空 / 失败 / 超时                | `fallback` |
 * | prompt | 模型正常有文本                         | `model`    |
 * | prompt | SKIP 且允许跳过                        | `drop`     |
 * | prompt | SKIP 且不允许跳过，或失败/超时         | `fallback`（没有兜底文案才 `drop`） |
 *
 * `text` 模式不经过这里：它本来就没有「模型回复」这一步。
 *
 * @param options.mode - 任务模式。
 * @param options.allowSkip - 仅 prompt：模型说 SKIP 时允许什么都不发。
 * @param options.hasFallback - 有没有可发的兜底文案。
 * @param options.reply - 模型这一轮的最终文本。
 * @param options.skipped - 模型正文是否判成 SKIP。
 * @param options.failed - 这一轮是否失败/中止/超时。
 * @param options.sent - 是否已经成功发出过。
 * @returns `model` / `fallback` / `drop` / `none`。
 */
export function reminderOutcome({ mode, allowSkip = true, hasFallback = false, reply = '', skipped = false, failed = false, sent = false } = {}) {
  if (sent === true) return 'none';
  const text = typeof reply === 'string' ? reply.trim() : '';
  if (failed !== true && skipped !== true && text.length > 0) return 'model';
  if (mode === 'agent') return 'fallback';
  if (failed === true || allowSkip !== true) return hasFallback ? 'fallback' : 'drop';
  return 'drop';
}

/** 一条任务「说了什么」的可比较内容（去重与展示用）。 */
export function taskContent(task) {
  return task?.mode === 'prompt' ? String(task.prompt ?? '') : String(task.text ?? '');
}

/** 同一个创建者今天已经建了几条（按本地日界线；从任务文件现算，重启不会洗掉）。 */
export function countCreatedToday(tasks, creatorId, now = Date.now()) {
  const today = localDate(now);
  return (Array.isArray(tasks) ? tasks : []).filter(
    (task) => String(task?.createdBy ?? '') === String(creatorId ?? '') && localDate(Number(task?.createdAt) || 0) === today,
  ).length;
}

/**
 * 清理历史任务：terminal 状态只留 7 天，总数超过 {@link MAX_TASKS} 时优先丢旧的。
 * 活跃任务（active / firing）永远保留。
 */
export function pruneTasks(tasks, now = Date.now()) {
  const alive = [];
  const history = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (task?.status === 'active' || task?.status === 'firing') alive.push(task);
    else if (now - (Number(task?.lastFiredAt) || Number(task?.updatedAt) || Number(task?.createdAt) || 0) <= HISTORY_KEEP_MS) history.push(task);
  }
  history.sort((a, b) => (Number(b.lastFiredAt) || Number(b.createdAt) || 0) - (Number(a.lastFiredAt) || Number(a.createdAt) || 0));
  const out = [...alive, ...history];
  return out.length > MAX_TASKS ? out.slice(0, MAX_TASKS) : out;
}

/** 一条任务的中文摘要（日志、工具 render、提示词里的「最近一条」都用它）。 */
export function describeTask(task) {
  const who = (Array.isArray(task?.mentions) ? task.mentions : []).map((entry) => `@${entry.name}`).join(' ');
  const content = task?.mode === 'prompt' ? task.prompt : task?.text;
  return `${atLabel(task?.dueAt)}（${repeatLabel(task?.repeat)}，${modeLabel(task?.mode)}）${who.length > 0 ? ` ${who}` : ''} ${String(content ?? '').slice(0, 80)}`;
}

/** 任务状态。设置页按这个集合配色；`cancelled` 只在 cancel() 里出现。 */
export const REMINDER_STATUSES = ['active', 'firing', 'done', 'missed', 'failed', 'cancelled'];

/** 设置页一次最多列出多少条（任务文件最多 500 条，页面不该把它们全画出来）。 */
const VIEW_MAX = 100;

/**
 * 设置页「已记录的定时任务」的只读视图（纯函数）。
 *
 * 为什么不直接把 `snapshot()` 丢给浏览器：任务文件里的字段一半是内部账
 * （`retryText` / `agentCount` / `scheduledAt`），浏览器半侧既用不到、也不该
 * 顺着一条 GET 泄漏出去。这里只挑展示需要的字段，并在 Host 侧算好本地时间
 * 标签 —— 浏览器与 Host 的时区可能不同，`dueAt` 的「几点」必须以 Host 为准。
 *
 * @param tasks - `snapshot()` 的任务数组。
 * @param now - 当前毫秒时刻（发起这次读取的时刻）。
 * @returns `{ now, pending, total, tasks }`。
 */
export function reminderOverview(tasks, now = Date.now()) {
  const list = Array.isArray(tasks) ? tasks : [];
  const rows = list.map((task) => {
    const created = Number(task?.createdAt) || 0;
    const fired = Number(task?.lastFiredAt) || 0;
    return {
      id: String(task?.id ?? ''),
      status: REMINDER_STATUSES.includes(task?.status) ? task.status : 'unknown',
      mode: REMINDER_MODES.includes(task?.mode) ? task.mode : 'text',
      repeat: repeatLabel(task?.repeat),
      repeating: task?.repeat !== null && task?.repeat !== undefined,
      dueAt: Number(task?.dueAt) || 0,
      dueLabel: Number(task?.dueAt) ? atLabel(task.dueAt) : '',
      type: task?.type === 'group' ? 'group' : 'private',
      targetId: String(task?.targetId ?? ''),
      key: String(task?.key ?? ''),
      text: taskContent(task),
      fallbackText: String(task?.fallbackText ?? ''),
      mentions: (Array.isArray(task?.mentions) ? task.mentions : []).map((entry) => String(entry?.name ?? '')).filter((name) => name.length > 0),
      createdBy: String(task?.createdByName || task?.createdBy || ''),
      createdAt: created,
      createdLabel: created > 0 ? atLabel(created) : '',
      fireCount: Number(task?.fireCount) || 0,
      lastFiredAt: fired,
      lastFiredLabel: fired > 0 ? atLabel(fired) : '',
      error: String(task?.lastError ?? ''),
    };
  });
  // 待发的按「最近该醒的」在最前；历史按「最近弄完的」在最前。
  rows.sort((left, right) => {
    const leftAlive = left.status === 'active' || left.status === 'firing' ? 0 : 1;
    const rightAlive = right.status === 'active' || right.status === 'firing' ? 0 : 1;
    if (leftAlive !== rightAlive) return leftAlive - rightAlive;
    if (leftAlive === 0) return left.dueAt - right.dueAt;
    return right.lastFiredAt - left.lastFiredAt || right.createdAt - left.createdAt;
  });
  return {
    now,
    pending: rows.filter((row) => row.status === 'active' || row.status === 'firing').length,
    total: rows.length,
    tasks: rows.slice(0, VIEW_MAX),
  };
}

/** 一个任务能不能被 `viewer` 取消：创建者本人，或 Web 操作员。 */
function canCancel(task, viewer) {
  if (viewer?.operator === true) return true;
  return String(task?.createdBy ?? '') === String(viewer?.id ?? '');
}

/** 任务 id：短、可读、便于在列表里引用；碰撞概率低，撞了就再抽一次。 */
function newId(tasks) {
  for (;;) {
    const id = `r-${randomBytes(3).toString('hex')}`;
    if (!tasks.some((task) => task.id === id)) return id;
  }
}

/**
 * 创建提醒子系统。
 *
 * @param {object} deps - 依赖全部显式传入，本模块不碰 Harness：
 * @param {string} deps.file - 任务文件的绝对路径（必须在 cwd 内，调用方已校验）。
 * @param {() => number} deps.now - 当前时刻（测试可注入）。
 * @param {(callback: () => void, ms: number) => (() => void)} deps.schedule - 排一个一次性定时器，返回 disposer。
 * @param {(task: object, text: string) => Promise<{ ok: boolean, retryable?: boolean }>} deps.deliverText -
 *   发一条固定文案（带 @）。
 * @param {(task: object, text: string) => Promise<{ ok: boolean, retryable?: boolean }>} deps.deliverModel -
 *   发模型这一轮写出来的正文（带 @、走拟人发送链路）。
 * @param {(task: object) => Promise<object>} deps.runTurn - 跑一轮 agent/prompt，兑现
 *   `{ kind: 'reply'|'skip'|'failure'|'timeout', text?, reason? }`。
 * @param {(task: object) => boolean} deps.isBusy - 这个会话此刻是否正忙（忙则 agent 回退文案）。
 * @param {(level: string, message: string) => void} deps.report - 日志。
 * @param {object} deps.limits - `{ maxActive, dailyMax, graceMs, modeMax, agentDailyMax }`。
 * @returns 提醒子系统的公开接口。
 */
export function createReminders(deps) {
  const {
    file,
    now = Date.now,
    schedule,
    deliverText,
    deliverModel,
    runTurn,
    isBusy = () => false,
    report = () => {},
    limits = {},
  } = deps;
  const maxActive = Math.max(1, Math.floor(Number(limits.maxActive) || 20));
  const dailyMax = Math.max(0, Math.floor(Number(limits.dailyMax) || 0));
  const graceMs = Math.max(0, Math.floor(Number(limits.graceMs) || 0));
  const modeMax = REMINDER_MODES.includes(limits.modeMax) ? limits.modeMax : 'text';
  const agentDailyMax = Math.max(0, Math.floor(Number(limits.agentDailyMax) || 0));

  /** @type {object[]} */
  let tasks = [];
  let timer;
  /** 正在跑（或正在发）的任务 id：防止同一个 tick 里重复派发。 */
  const inFlight = new Set();
  /** 正在跑 Agent 轮的会话 key：同一会话同时只跑一条，第二条直接发固定文案。 */
  const agentBusy = new Set();
  /** 保存链：几次改动连着来的时候按顺序落地，最后一次写的是最新快照。 */
  let saveChain = Promise.resolve();
  /** 启动时的读盘：`create` / `cancel` 先等它，避免和 load 抢同一份 tasks。 */
  let ready = Promise.resolve();

  function persist() {
    const snapshot = { version: 1, tasks };
    saveChain = saveChain.then(() => writeJsonAtomic(file, snapshot)).catch((error) => {
      report('warn', `could not save reminders to ${file}: ${error?.message ?? error}`);
    });
    return saveChain;
  }

  function cancelTimer() {
    if (timer !== undefined) {
      timer();
      timer = undefined;
    }
  }

  /** 找到最早该醒的时刻并排一个定时器；没有活跃任务就不留定时器。 */
  function arm() {
    cancelTimer();
    const at = now();
    let earliest = Infinity;
    for (const task of tasks) {
      if (task.status !== 'active') continue;
      const due = Number(task.dueAt) || 0;
      if (due < earliest) earliest = due;
    }
    if (!Number.isFinite(earliest)) return;
    const wait = Math.max(0, Math.min(earliest - at, MAX_SLEEP_MS));
    timer = schedule(() => {
      timer = undefined;
      fireDue();
    }, wait);
  }

  /** 一条任务从 `firing` 收尾：一次性置 done，周期任务推进到下一次。 */
  async function finish(task, { sent = false, note = '', completed = false } = {}) {
    const at = now();
    task.lastError = note;
    task.lastFiredAt = at;
    if (sent) task.sentAt = at;
    task.fireCount = (Number(task.fireCount) || 0) + 1;
    task.retryText = '';
    task.firingAt = 0;
    task.updatedAt = at;
    if (task.repeat !== null && task.repeat !== undefined) {
      try {
        task.dueAt = nextOccurrence(task.repeat, at);
        task.scheduledAt = task.dueAt;
        task.status = 'active';
      } catch (error) {
        // 理论上走不到（创建与读回都校验过）；真坏了也别把任务永远挂在 firing 上。
        task.status = 'failed';
        task.lastError = `could not compute the next occurrence: ${error?.message ?? error}`;
      }
    } else {
      task.status = sent || completed ? 'done' : 'missed';
    }
    await persist();
    arm();
  }

  /** 永久失败（不是断线那种可重试的错误）。 */
  async function fail(task, reason) {
    task.status = 'failed';
    task.lastError = String(reason ?? '');
    task.retryText = '';
    task.updatedAt = now();
    report('warn', `reminder ${task.id} failed: ${task.lastError}`);
    await persist();
    arm();
  }

  /** 可重试：留在 active，过一会儿再发（仍然受 grace 约束）。 */
  async function retryLater(task, text, reason) {
    const at = now();
    const scheduledAt = Number(task.scheduledAt) || Number(task.dueAt) || at;
    if (at - scheduledAt > graceMs) {
      await fail(task, `${reason}（超过补发窗口）`);
      return;
    }
    task.status = 'active';
    task.dueAt = at + RETRY_MS;
    task.retryText = text;
    task.attempts = (Number(task.attempts) || 0) + 1;
    task.lastError = String(reason ?? '');
    task.updatedAt = at;
    report('info', `reminder ${task.id}: ${reason}，${Math.round(RETRY_MS / 1000)} 秒后重试`);
    await persist();
    arm();
  }

  /** 发一条文本；失败按「断线可重试 / 已连接但发不出去」分流。 */
  async function sendText(task, text, kind) {
    let result;
    try {
      result = kind === 'model' ? await deliverModel(task, text) : await deliverText(task, text);
    } catch (error) {
      result = { ok: false, retryable: true, reason: error?.message ?? String(error) };
    }
    if (result?.ok === true) {
      await finish(task, { sent: true });
      return true;
    }
    const reason = result?.reason ?? 'send failed';
    if (result?.retryable === true) {
      // 模型正文发不出去时重试**固定文案**，不重试模型那段：它可能含只剩标记的正文，
      // 而且重发一遍模型回复既贵又可能和已经发出去的一半重复。
      await retryLater(task, kind === 'model' ? (task.fallbackText || task.text) : text, reason);
      return false;
    }
    await fail(task, reason);
    return false;
  }

  /**
   * 到点派发一条任务。
   *
   * 先落盘 `firing` 再发送：进程若死在「已记账、没发出去」之间，重启后会在 grace 内
   * 补一条文本，至少提醒不会消失；反过来（发完再记账）则会在崩溃后重复打扰。
   * 这是刻意选的 at-most-once。
   */
  async function dispatch(task) {
    if (inFlight.has(task.id)) return;
    if (task.status !== 'active') return;
    inFlight.add(task.id);
    try {
      const at = now();
      task.status = 'firing';
      task.firingAt = at;
      task.scheduledAt = task.dueAt;
      task.updatedAt = at;
      // 断线重试只剩「发文本」这一步：不再重跑模型（那会重复花费一次调用）。
      const retryText = String(task.retryText ?? '');
      if (retryText.length > 0) {
        await persist();
        await sendText(task, retryText, 'text');
        return;
      }
      await persist();

      if (task.mode === 'text') {
        await sendText(task, task.text, 'text');
        return;
      }

      // 会话正忙（有人在等回复 / 已有一条提醒在跑）时不再排一轮模型：直接发文案。
      // 两条提醒同一分钟到点时，第二条走 text 是可预期且不抢队列的选择。
      // `agentBusy` 是本地账：`isBusy` 要等 submitted 写进去才看得见，同一 tick 里
      // 两条都还没提交时会同时放行，所以两者都要查。
      if (agentBusy.has(task.key) || isBusy(task)) {
        report('info', `reminder ${task.id}: 会话正忙，改用固定文案`);
        await sendText(task, task.fallbackText || task.text, 'text');
        return;
      }

      agentBusy.add(task.key);
      try {
        // 每个会话每天最多跑几次模型：prompt/agent 花的是真金白银，得有个闸。
        // 计数按「会话 + 本地日期」记在任务上；跨天必须归零，否则昨天的次数会压住今天。
        if (agentDailyMax > 0) {
          const today = localDate(at);
          const used = tasks.filter(
            (item) => item.key === task.key && item.agentDay === today && Number(item.agentCount) > 0,
          ).reduce((sum, item) => sum + (Number(item.agentCount) || 0), 0);
          if (used >= agentDailyMax) {
            report('info', `reminder ${task.id}: 今天的 Agent 提醒额度已用完，改用固定文案`);
            await sendText(task, task.fallbackText || task.text, 'text');
            return;
          }
          if (task.agentDay !== today) {
            task.agentDay = today;
            task.agentCount = 0;
          }
          task.agentCount = (Number(task.agentCount) || 0) + 1;
          await persist();
        }

        let outcome;
        try {
          outcome = await runTurn(task);
        } catch (error) {
          outcome = { kind: 'failure', reason: error?.message ?? String(error) };
        }
      const result = reminderOutcome({
        mode: task.mode,
        allowSkip: task.allowSkip,
        hasFallback: (task.fallbackText || task.text).length > 0,
        reply: outcome?.text ?? '',
        skipped: outcome?.kind === 'skip',
        failed: outcome?.kind === 'failure' || outcome?.kind === 'timeout',
      });
      if (result === 'model') {
        await sendText(task, String(outcome.text).trim(), 'model');
        return;
      }
      if (result === 'fallback') {
        await sendText(task, task.fallbackText || task.text, 'text');
        return;
      }
      if (result === 'drop') {
        // SKIP/空是「这条任务正常地决定不说」；失败/超时且没有兜底才是 missed。
        const intentional = outcome?.kind === 'skip' || outcome?.kind === 'empty';
        report('info', `reminder ${task.id}: ${intentional ? '模型判成 SKIP，按任务设置不发送' : '没有可发的兜底文案'}`);
        await finish(task, { sent: false, note: intentional ? 'skipped' : 'no fallback', completed: intentional });
        return;
      }
      // 'none'：runTurn 自己已经发过了（当前实现不会走到，留着防重）。
      await finish(task, { sent: true });
      } finally {
        agentBusy.delete(task.key);
      }
    } finally {
      inFlight.delete(task.id);
    }
  }

  /** 醒来：把到点的任务都派发出去，然后重新排定时器。 */
  function fireDue() {
    const at = now();
    const due = tasks
      .filter((task) => task.status === 'active' && Number(task.dueAt) <= at)
      .sort((a, b) => Number(a.dueAt) - Number(b.dueAt));
    for (const task of due) {
      void dispatch(task).catch((error) => {
        report('warn', `reminder ${task.id} dispatch failed: ${error?.message ?? error}`);
      });
    }
    arm();
  }

  /** 读任务文件；坏条目跳过并记一条 warn，绝不让一条坏数据拖垮整个功能。 */
  async function load() {
    const raw = await readTextOrUndefined(file);
    if (raw === undefined) {
      tasks = [];
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      report('warn', `reminders file ${file} is not valid JSON: ${error?.message ?? error}`);
      tasks = [];
      return;
    }
    const list = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    const valid = [];
    let dropped = 0;
    for (const item of list) {
      const task = normalizeLoadedTask(item);
      if (task === undefined) {
        dropped += 1;
        continue;
      }
      valid.push(task);
    }
    if (dropped > 0) report('warn', `reminders: dropped ${dropped} malformed task(s) from ${file}`);
    tasks = valid;
    const at = now();
    let changed = dropped > 0;
    for (const task of tasks) {
      if (task.status === 'firing') {
        // 进程死在 agent 轮里：不知道模型说没说出口，重启后发一条文本兜底。
        if (at - (Number(task.firingAt) || 0) <= graceMs) {
          task.status = 'active';
          task.dueAt = at;
          task.retryText = task.retryText || task.fallbackText || task.text;
          task.attempts = (Number(task.attempts) || 0) + 1;
          report('info', `reminder ${task.id}: 上次启动在发送途中被打断，补发文本`);
        } else {
          task.status = 'missed';
          task.lastError = '进程未运行，已过期';
        }
        changed = true;
        continue;
      }
      if (task.status !== 'active') continue;
      const due = Number(task.dueAt) || 0;
      if (due > at) continue;
      if (task.repeat !== null && task.repeat !== undefined) {
        // 周期任务不补历史：错过的那几次没有意义，直接排到下一个未来时刻。
        task.dueAt = nextOccurrence(task.repeat, at);
        task.scheduledAt = task.dueAt;
        changed = true;
        continue;
      }
      if (at - due > graceMs) {
        task.status = 'missed';
        task.lastError = '进程未运行，已过期';
        changed = true;
      }
    }
    tasks = pruneTasks(tasks, at);
    if (changed) await persist();
    arm();
  }

  /** 校验从磁盘读回来的任务；形状不对就返回 undefined（整体跳过，不抛）。 */
  function normalizeLoadedTask(item) {
    if (item === null || typeof item !== 'object') return undefined;
    const id = String(item.id ?? '').trim();
    const key = String(item.key ?? '').trim();
    const type = item.type === 'group' || item.type === 'private' ? item.type : undefined;
    const targetId = String(item.targetId ?? '').trim();
    const mode = REMINDER_MODES.includes(item.mode) ? item.mode : 'text';
    const dueAt = Number(item.dueAt);
    const status = ['active', 'firing', 'done', 'missed', 'failed', 'cancelled'].includes(item.status) ? item.status : 'active';
    if (id.length === 0 || key.length === 0 || type === undefined || targetId.length === 0 || !Number.isFinite(dueAt)) return undefined;
    let repeat = item.repeat === null || item.repeat === undefined ? null : item.repeat;
    if (repeat !== null && repeat.kind === 'none') repeat = null;
    if (repeat !== null) {
      if (!REMINDER_REPEATS.includes(repeat.kind)) return undefined;
      const hour = Number(repeat.hour);
      const minute = Number(repeat.minute);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
      if (repeat.kind === 'weekly' && (!Number.isInteger(Number(repeat.weekday)) || Number(repeat.weekday) < 1 || Number(repeat.weekday) > 7)) return undefined;
      if (repeat.kind === 'monthly' && (!Number.isInteger(Number(repeat.day)) || Number(repeat.day) < 1 || Number(repeat.day) > 31)) return undefined;
      repeat = { kind: repeat.kind, hour, minute, ...(repeat.kind === 'weekly' ? { weekday: Number(repeat.weekday) } : {}), ...(repeat.kind === 'monthly' ? { day: Number(repeat.day) } : {}) };
    }
    const loadedText = String(item.text ?? '');
    const loadedPrompt = mode === 'prompt' ? String(item.prompt ?? '') : '';
    if (mode === 'prompt' ? loadedPrompt.length === 0 : loadedText.length === 0) return undefined;
    return {
      ...item,
      id,
      key,
      type,
      targetId,
      mode,
      dueAt,
      status,
      repeat,
      text: String(item.text ?? ''),
      prompt: mode === 'prompt' ? String(item.prompt ?? '') : '',
      fallbackText: String(item.fallbackText ?? item.text ?? ''),
      mentions: (Array.isArray(item.mentions) ? item.mentions : [])
        .map((entry) => ({ id: String(entry?.id ?? '').trim(), name: String(entry?.name ?? '').trim() }))
        .filter((entry) => entry.id.length > 0 && entry.name.length > 0)
        .slice(0, MENTION_MAX),
      allowSkip: mode === 'prompt' ? item.allowSkip !== false : false,
      createdBy: String(item.createdBy ?? ''),
      createdByName: String(item.createdByName ?? ''),
      createdAt: Number(item.createdAt) || 0,
      fireCount: Number(item.fireCount) || 0,
      lastFiredAt: Number(item.lastFiredAt) || 0,
      sentAt: Number(item.sentAt) || 0,
      firingAt: Number(item.firingAt) || 0,
      attempts: Number(item.attempts) || 0,
      retryText: String(item.retryText ?? ''),
      lastError: String(item.lastError ?? ''),
    };
  }

  /**
   * 创建一条任务。
   * @param input - 归一化前的请求（含 key / type / targetId / caller）。
   * @returns `{ task, duplicate }`。
   */
  async function create(input) {
    await ready;
    const at = now();
    const normalized = normalizeTaskInput(input, {
      now: at,
      maxMode: modeMax,
      callerId: input.callerId,
      canMentionOthers: input.canMentionOthers === true,
      canAll: input.canAll === true,
      trusted: input.trusted === true,
    });
    const creator = String(input.callerId ?? '');
    const content = normalized.mode === 'prompt' ? normalized.prompt : normalized.text;
    const mentionKey = normalized.mentions.map((entry) => entry.id).sort().join(',');
    const duplicate = tasks.find(
      (task) =>
        task.key === input.key &&
        task.status !== 'cancelled' &&
        taskContent(task) === content &&
        task.mentions.map((entry) => entry.id).sort().join(',') === mentionKey &&
        Math.abs(Number(task.dueAt) - normalized.dueAt) <= DUPLICATE_WINDOW_MS,
    );
    if (duplicate !== undefined) return { task: duplicate, duplicate: true };

    const activeCount = tasks.filter((task) => task.key === input.key && (task.status === 'active' || task.status === 'firing')).length;
    if (activeCount >= maxActive) throw new Error(`this conversation already has ${activeCount} pending reminders (max ${maxActive})`);

    // 额度只在「真的要新建一条」时消耗：上面的重复返回不该占掉一次每日额度。
    if (dailyMax > 0 && input.operator !== true && creator.length > 0 && countCreatedToday(tasks, creator, at) >= dailyMax) {
      throw new Error(`daily reminder limit reached (${dailyMax} per person per day)`);
    }

    const task = {
      id: newId(tasks),
      key: String(input.key),
      type: input.type === 'group' ? 'group' : 'private',
      targetId: String(input.targetId),
      ...normalized,
      createdAt: at,
      createdBy: creator,
      createdByName: String(input.callerName ?? ''),
      fireCount: 0,
      lastFiredAt: 0,
      sentAt: 0,
      firingAt: 0,
      attempts: 0,
      retryText: '',
      lastError: '',
      status: 'active',
      updatedAt: at,
    };
    tasks.push(task);
    await persist();
    arm();
    report('info', `reminder ${task.id} created for ${task.key} at ${atLabel(task.dueAt)} (${modeLabel(task.mode)}, ${repeatLabel(task.repeat)})`);
    return { task, duplicate: false };
  }

  /** 取消一条任务；只有创建者本人或操作员可以。 */
  async function cancel(id, viewer = {}) {
    await ready;
    const task = tasks.find((item) => item.id === String(id ?? '').trim());
    if (task === undefined) throw new Error(`no such reminder: ${id}`);
    if (!canCancel(task, viewer)) throw new Error('only the person who created it can cancel this reminder');
    if (task.status !== 'active' && task.status !== 'firing') throw new Error(`reminder ${task.id} is already ${task.status}`);
    task.status = 'cancelled';
    task.updatedAt = now();
    await persist();
    arm();
    report('info', `reminder ${task.id} cancelled`);
    return task;
  }

  /** 列任务：默认只列这个会话的；`mine` 只列自己建的；`all` 只给操作员。 */
  function list({ key, creatorId = '', scope = 'conversation', operator = false } = {}) {
    let out = tasks.filter((task) => task.status !== 'cancelled');
    if (scope === 'all') {
      if (!operator) throw new Error('only the operator can list reminders across conversations');
    } else if (scope === 'mine') {
      out = out.filter((task) => String(task.createdBy) === String(creatorId));
    } else {
      out = out.filter((task) => task.key === key);
    }
    out.sort((a, b) => {
      const alive = (task) => (task.status === 'active' || task.status === 'firing' ? 0 : 1);
      const diff = alive(a) - alive(b);
      if (diff !== 0) return diff;
      return alive(a) === 0 ? Number(a.dueAt) - Number(b.dueAt) : Number(b.lastFiredAt) - Number(a.lastFiredAt);
    });
    return out.slice(0, LIST_MAX).map((task) => ({
      id: task.id,
      mode: task.mode,
      at: atLabel(task.dueAt),
      repeat: repeatLabel(task.repeat),
      mentions: task.mentions.map((entry) => entry.name),
      text: task.mode === 'prompt' ? task.prompt : task.text,
      status: task.status,
      created_by: task.createdByName || task.createdBy,
      fire_count: Number(task.fireCount) || 0,
      error: task.lastError || undefined,
    }));
  }

  /** 给提示词用的一行摘要：这个会话还有几条待发、最近的是哪条。 */
  function summaryFor(key) {
    const alive = tasks
      .filter((task) => task.key === key && (task.status === 'active' || task.status === 'firing'))
      .sort((a, b) => Number(a.dueAt) - Number(b.dueAt));
    return { count: alive.length, next: alive[0] };
  }

  /**
   * 设置页用：等首次读盘完成后再给只读视图。
   * 页面可能在 `start()` 的读盘还没回来时就打开，那时直接 `snapshot()` 会看到空列表。
   */
  async function overview(at = now()) {
    await ready;
    return reminderOverview(tasks, at);
  }

  return {
    load,
    start() {
      ready = load();
      return ready;
    },
    kick: () => arm(),
    fireDue,
    create,
    cancel,
    list,
    summaryFor,
    overview,
    /** 测试/运维只看不改的只读快照。 */
    snapshot: () => tasks.map((task) => ({ ...task })),
    dispose() {
      cancelTimer();
      inFlight.clear();
    },
  };
}
