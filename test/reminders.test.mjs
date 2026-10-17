/**
 * 定时提醒的纯函数与存储/调度测试。
 *
 * 分成两层：
 *   1. 时间推算与校验是纯函数，逐格钉边界（月末、闰年、工作日、模式权限）；
 *   2. `createReminders` 用假时钟 + 假定时器 + 假发送，验「到点发什么、失败怎么退」。
 *
 * 不启动 Harness：这一层不需要 OneBot，也不该被它的时序拖慢。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  createReminders,
  countCreatedToday,
  describeTask,
  nextOccurrence,
  normalizeTaskInput,
  normalizeMentions,
  pruneTasks,
  reminderOutcome,
  reminderOverview,
  repeatSpec,
} from '../reminders.js';
import { parseLocalMinute, weekdayLabel, localMinute } from '../util.js';

const dirs = [];

after(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempFile() {
  const dir = await mkdtemp(join(tmpdir(), 'qq-reminders-'));
  dirs.push(dir);
  return join(dir, 'reminders.json');
}

/** 固定的本地时间：2026-08-20 是周四。 */
function at(y, m, d, h, min) {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

function fakeTimers() {
  const entries = [];
  return {
    entries,
    schedule(callback, ms) {
      const entry = { callback, ms, cleared: false };
      entries.push(entry);
      return () => {
        entry.cleared = true;
      };
    },
    live() {
      return entries.filter((entry) => !entry.cleared);
    },
    fire() {
      // 取**最新**的那个：`arm()` 会先取消旧定时器再排新的，但旧条目的 disposer
      // 要等调用时才生效；取最后一个才不会在重试用例里误触上一轮的定时器。
      const entry = this.live().at(-1);
      assert.ok(entry, 'a timer should be armed');
      entry.callback();
      return entry;
    },
  };
}

async function until(check, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * 造一个提醒实例：默认所有发送都成功，`runTurn` 返回一句正常回复。
 * 用例只覆盖自己关心的那几项。
 */
function makeReminders({ file, clock, limits = {}, deliverText, deliverModel, runTurn, isBusy, report } = {}) {
  const timers = fakeTimers();
  const calls = { text: [], model: [], turns: [] };
  const instance = createReminders({
    file,
    now: () => clock.value,
    schedule: timers.schedule,
    deliverText: async (task, text) => {
      calls.text.push({ task, text });
      return deliverText ? deliverText(task, text, calls) : { ok: true };
    },
    deliverModel: async (task, text) => {
      calls.model.push({ task, text });
      return deliverModel ? deliverModel(task, text, calls) : { ok: true };
    },
    runTurn: async (task) => {
      calls.turns.push(task);
      return runTurn ? runTurn(task, calls) : { kind: 'reply', text: '收到' };
    },
    isBusy: (task) => (isBusy ? isBusy(task, calls) : false),
    report: report ?? (() => {}),
    limits: { maxActive: 20, dailyMax: 5, graceMs: 10 * 60 * 1000, modeMax: 'agent', agentDailyMax: 20, ...limits },
  });
  return { instance, timers, calls, clock };
}

// ---- 纯函数：时间 ----------------------------------------------------------

test('parseLocalMinute accepts T and space separators and rejects impossible dates', () => {
  assert.equal(parseLocalMinute('2026-08-21T08:00').text, '2026-08-21 08:00');
  assert.equal(parseLocalMinute('2026-08-21 08:00').at, at(2026, 8, 21, 8, 0));
  assert.equal(parseLocalMinute('2026-02-30T08:00'), undefined);
  assert.equal(parseLocalMinute('2026-13-01T08:00'), undefined);
  assert.equal(parseLocalMinute('2026-08-21T24:00'), undefined);
  assert.equal(parseLocalMinute('2026-08-21'), undefined);
  assert.equal(parseLocalMinute('明天早上八点'), undefined);
});

test('localMinute and weekdayLabel render local time', () => {
  assert.equal(localMinute(at(2026, 8, 20, 14, 32)), '2026-08-20 14:32');
  assert.equal(weekdayLabel(at(2026, 8, 20, 14, 32)), '周四');
});

test('nextOccurrence: daily rolls to tomorrow once the time has passed', () => {
  const spec = repeatSpec('daily', at(2026, 8, 20, 9, 0));
  assert.equal(nextOccurrence(spec, at(2026, 8, 20, 8, 0)), at(2026, 8, 20, 9, 0));
  assert.equal(nextOccurrence(spec, at(2026, 8, 20, 9, 0)), at(2026, 8, 21, 9, 0));
  assert.equal(nextOccurrence(spec, at(2026, 8, 20, 10, 0)), at(2026, 8, 21, 9, 0));
});

test('nextOccurrence: weekdays skip the weekend', () => {
  const spec = repeatSpec('weekdays', at(2026, 8, 21, 9, 0)); // 周五
  // 周五 10:00 之后 → 周一 9:00
  assert.equal(nextOccurrence(spec, at(2026, 8, 21, 10, 0)), at(2026, 8, 24, 9, 0));
  // 周六 → 周一
  assert.equal(nextOccurrence(spec, at(2026, 8, 22, 10, 0)), at(2026, 8, 24, 9, 0));
  // 周日 → 周一
  assert.equal(nextOccurrence(spec, at(2026, 8, 23, 10, 0)), at(2026, 8, 24, 9, 0));
});

test('nextOccurrence: weekly goes to the same weekday next week', () => {
  const spec = repeatSpec('weekly', at(2026, 8, 20, 9, 0)); // 周四
  assert.equal(spec.weekday, 4);
  assert.equal(nextOccurrence(spec, at(2026, 8, 20, 8, 0)), at(2026, 8, 20, 9, 0));
  assert.equal(nextOccurrence(spec, at(2026, 8, 20, 9, 1)), at(2026, 8, 27, 9, 0));
});

test('nextOccurrence: monthly clamps 31 to the end of shorter months', () => {
  const spec = repeatSpec('monthly', at(2026, 1, 31, 9, 0));
  assert.equal(nextOccurrence(spec, at(2026, 1, 31, 10, 0)), at(2026, 2, 28, 9, 0));
  assert.equal(nextOccurrence(spec, at(2026, 2, 28, 10, 0)), at(2026, 3, 31, 9, 0));
  assert.equal(nextOccurrence(spec, at(2026, 3, 31, 10, 0)), at(2026, 4, 30, 9, 0));
  // 闰年 2 月 29
  const leap = repeatSpec('monthly', at(2028, 1, 31, 9, 0));
  assert.equal(nextOccurrence(leap, at(2028, 1, 31, 10, 0)), at(2028, 2, 29, 9, 0));
});

test('nextOccurrence is strictly after the given moment', () => {
  const spec = repeatSpec('daily', at(2026, 8, 20, 9, 0));
  const next = nextOccurrence(spec, at(2026, 8, 20, 9, 0));
  assert.ok(next > at(2026, 8, 20, 9, 0));
});

// ---- 纯函数：校验与权限 ----------------------------------------------------

const base = { now: at(2026, 8, 20, 14, 0), maxMode: 'agent', callerId: '100000002' };

test('normalizeTaskInput requires exactly one of at / in_minutes', () => {
  assert.throws(() => normalizeTaskInput({ text: 'x' }, base), /exactly one/);
  assert.throws(() => normalizeTaskInput({ text: 'x', at: '2026-08-21T08:00', inMinutes: 5 }, base), /exactly one/);
});

test('normalizeTaskInput rejects a one-shot time in the past and rolls a repeating one forward', () => {
  assert.throws(() => normalizeTaskInput({ text: 'x', at: '2026-08-20T13:00' }, base), /too soon/);
  const rolled = normalizeTaskInput({ text: 'x', at: '2026-08-20T09:00', repeat: 'daily' }, base);
  assert.equal(rolled.dueAt, at(2026, 8, 21, 9, 0));
});

test('normalizeTaskInput enforces the minimum lead and the horizon', () => {
  assert.throws(() => normalizeTaskInput({ text: 'x', inMinutes: 0 }, base), /positive/);
  const soon = normalizeTaskInput({ text: 'x', inMinutes: 1 }, base);
  assert.equal(soon.dueAt, base.now + 60 * 1000);
  assert.throws(() => normalizeTaskInput({ text: 'x', inMinutes: 366 * 24 * 60 }, base), /too far/);
});

test('normalizeTaskInput enforces the mode ceiling', () => {
  assert.throws(() => normalizeTaskInput({ text: 'x', inMinutes: 5, mode: 'agent' }, { ...base, maxMode: 'text' }), /disabled/);
  assert.throws(() => normalizeTaskInput({ prompt: 'x', inMinutes: 5, mode: 'prompt' }, base), /disabled/);
  const prompt = normalizeTaskInput({ prompt: '整理今天的群聊', inMinutes: 5, mode: 'prompt' }, { ...base, maxMode: 'prompt', canMentionOthers: true, trusted: true });
  assert.equal(prompt.mode, 'prompt');
  assert.equal(prompt.allowSkip, true);
  // 即使 reminderModes 开到 prompt，普通群友也不该能建 prompt（无人在场的指令执行）。
  assert.throws(
    () => normalizeTaskInput({ prompt: 'x', inMinutes: 5, mode: 'prompt' }, { ...base, maxMode: 'prompt' }),
    /trusted users/,
  );
});

test('prompt mode: allow_skip=false requires a fallback text', () => {
  assert.throws(
    () => normalizeTaskInput({ prompt: 'x', inMinutes: 5, mode: 'prompt', allowSkip: false }, { ...base, maxMode: 'prompt', trusted: true }),
    /fallback_text/,
  );
  const ok = normalizeTaskInput(
    { prompt: 'x', inMinutes: 5, mode: 'prompt', allowSkip: false, fallbackText: '没做成' },
    { ...base, maxMode: 'prompt', trusted: true },
  );
  assert.equal(ok.fallbackText, '没做成');
});

test('mentions: others need permission, @all needs its own switch, duplicates collapse', () => {
  assert.throws(
    () => normalizeMentions([{ id: '100000003', name: '张三' }], { callerId: '100000002' }),
    /other people/,
  );
  assert.throws(
    () => normalizeMentions([{ id: 'all', name: '全体成员' }], { callerId: '100000002', canMentionOthers: true }),
    /@all/,
  );
  const ok = normalizeMentions(
    [{ id: '100000003', name: '张三' }, { id: '100000003', name: '张三' }],
    { callerId: '100000002', canMentionOthers: true },
  );
  assert.deepEqual(ok, [{ id: '100000003', name: '张三' }]);
  assert.deepEqual(
    normalizeMentions([{ id: 'all', name: '全体成员' }, { id: '100000003', name: '张三' }], { canAll: true, canMentionOthers: true }),
    [{ id: 'all', name: '全体成员' }],
  );
});

test('text length is capped by code points', () => {
  assert.throws(() => normalizeTaskInput({ text: '字'.repeat(201), inMinutes: 5 }, base), /too long/);
  const ok = normalizeTaskInput({ text: '字'.repeat(200), inMinutes: 5 }, base);
  assert.equal([...ok.text].length, 200);
});

// ---- 纯函数：模式决策 ------------------------------------------------------

test('reminderOutcome covers the decision table', () => {
  assert.equal(reminderOutcome({ mode: 'agent', reply: '记得交作业' }), 'model');
  assert.equal(reminderOutcome({ mode: 'agent', reply: 'SKIP', skipped: true }), 'fallback');
  assert.equal(reminderOutcome({ mode: 'agent', reply: '' }), 'fallback');
  assert.equal(reminderOutcome({ mode: 'agent', failed: true }), 'fallback');
  assert.equal(reminderOutcome({ mode: 'prompt', reply: '今天的摘要' }), 'model');
  assert.equal(reminderOutcome({ mode: 'prompt', skipped: true, allowSkip: true }), 'drop');
  assert.equal(reminderOutcome({ mode: 'prompt', skipped: true, allowSkip: false, hasFallback: true }), 'fallback');
  assert.equal(reminderOutcome({ mode: 'prompt', failed: true, allowSkip: true, hasFallback: false }), 'drop');
  assert.equal(reminderOutcome({ mode: 'agent', sent: true }), 'none');
});

test('countCreatedToday and pruneTasks keep the books small', () => {
  const now = at(2026, 8, 20, 14, 0);
  const tasks = [
    { createdBy: 'a', createdAt: now, status: 'active' },
    { createdBy: 'a', createdAt: now - 1000, status: 'done' },
    { createdBy: 'b', createdAt: now, status: 'active' },
    { createdBy: 'a', createdAt: now - 24 * 60 * 60 * 1000, status: 'done' },
  ];
  assert.equal(countCreatedToday(tasks, 'a', now), 2);
  const pruned = pruneTasks(
    [
      { id: 'old', status: 'done', createdAt: 0, lastFiredAt: now - 8 * 24 * 60 * 60 * 1000 },
      { id: 'fresh', status: 'done', createdAt: now, lastFiredAt: now },
      { id: 'alive', status: 'active', createdAt: 0, dueAt: now },
    ],
    now,
  );
  assert.deepEqual(pruned.map((task) => task.id), ['alive', 'fresh']);
});

test('describeTask is readable', () => {
  const line = describeTask({
    dueAt: at(2026, 8, 21, 9, 0),
    repeat: { kind: 'weekly', weekday: 5, hour: 9, minute: 0 },
    mode: 'text',
    text: '交作业',
    mentions: [{ id: '1', name: '张三' }],
  });
  assert.match(line, /2026-08-21 09:00/);
  assert.match(line, /每周五/);
  assert.match(line, /@张三/);
  assert.match(line, /交作业/);
});

test('reminderOverview is a read-only projection sorted for the settings page', () => {
  const later = {
    id: 'r-later',
    status: 'active',
    mode: 'text',
    repeat: { kind: 'daily', hour: 9, minute: 0 },
    dueAt: at(2026, 8, 22, 9, 0),
    type: 'group',
    targetId: '100000001',
    key: 'group:100000001',
    text: '明早的提醒',
    mentions: [{ id: '1', name: '张三' }],
    createdBy: '100000002',
    createdByName: '李四',
    createdAt: at(2026, 8, 20, 14, 0),
    fireCount: 2,
    lastFiredAt: at(2026, 8, 21, 9, 0),
    lastError: '',
    retryText: '不该出现在页面上的内部账',
    agentCount: 3,
  };
  const sooner = {
    ...later,
    id: 'r-sooner',
    status: 'firing',
    dueAt: at(2026, 8, 21, 16, 0),
    repeat: null,
    mode: 'prompt',
    prompt: '查一下天气',
    text: '天气提醒',
  };
  const failed = {
    ...later,
    id: 'r-failed',
    status: 'failed',
    dueAt: at(2026, 8, 21, 8, 0),
    lastFiredAt: at(2026, 8, 21, 8, 0),
    lastError: 'bot 没连上',
  };
  const view = reminderOverview([failed, later, sooner], at(2026, 8, 21, 12, 0));

  assert.equal(view.now, at(2026, 8, 21, 12, 0));
  assert.equal(view.pending, 2, 'active + firing 都算待发');
  assert.equal(view.total, 3);
  assert.deepEqual(view.tasks.map((task) => task.id), ['r-sooner', 'r-later', 'r-failed'], '待发按到期时间，历史按最近一次');

  const first = view.tasks[0];
  assert.equal(first.mode, 'prompt');
  assert.equal(first.text, '查一下天气', 'prompt 模式展示的是指令，不是标签文案');
  assert.equal(first.dueLabel, '2026-08-21 16:00');
  assert.equal(first.type, 'group');
  assert.equal(first.targetId, '100000001');
  assert.deepEqual(first.mentions, ['张三']);
  assert.equal(first.createdBy, '李四', '创建者优先显示昵称');
  assert.deepEqual(Object.keys(first).sort(), [
    'createdAt',
    'createdBy',
    'createdLabel',
    'dueAt',
    'dueLabel',
    'error',
    'fallbackText',
    'fireCount',
    'id',
    'key',
    'lastFiredAt',
    'lastFiredLabel',
    'mentions',
    'mode',
    'repeat',
    'repeating',
    'status',
    'targetId',
    'text',
    'type',
  ], '内部账（retryText / agentCount / scheduledAt）不能跟着出去');

  const recurring = view.tasks[1];
  assert.equal(recurring.repeating, true);
  assert.equal(recurring.repeat, '每天');
  assert.equal(recurring.lastFiredLabel, '2026-08-21 09:00');
  assert.equal(view.tasks[2].error, 'bot 没连上');

  const unknown = reminderOverview([{ id: 'r-x', status: 'weird', mode: 'nope' }], 0);
  assert.equal(unknown.tasks[0].status, 'unknown');
  assert.equal(unknown.tasks[0].mode, 'text', '坏数据退回最保守的模式');
  assert.equal(unknown.tasks[0].type, 'private');
});

// ---- 存储与调度 ------------------------------------------------------------

test('create persists a task and a fresh instance loads it back', async () => {
  const file = await tempFile();
  const clock = { value: at(2026, 8, 20, 14, 0) };
  const first = makeReminders({ file, clock });
  await first.instance.load();
  const { task } = await first.instance.create({
    key: 'group:100000001',
    type: 'group',
    targetId: '100000001',
    callerId: '100000002',
    callerName: '李四',
    text: '交作业',
    inMinutes: 5,
    mentions: [{ id: '100000002', name: '李四' }],
  });
  assert.equal(task.status, 'active');
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.tasks.length, 1);

  const clock2 = { value: clock.value };
  const second = makeReminders({ file, clock: clock2 });
  await second.instance.load();
  const list = second.instance.list({ key: 'group:100000001' });
  assert.equal(list.length, 1);
  assert.equal(list[0].text, '交作业');
});

test('text mode fires at due time and marks a one-shot done', async () => {
  const file = await tempFile();
  const clock = { value: at(2026, 8, 20, 14, 0) };
  const { instance, timers, calls } = makeReminders({ file, clock });
  await instance.load();
  await instance.create({
    key: 'group:100000001',
    type: 'group',
    targetId: '100000001',
    callerId: '100000002',
    text: '交作业',
    inMinutes: 1,
    mentions: [{ id: '100000002', name: '李四' }],
  });
  clock.value += 61 * 1000;
  timers.fire();
  await until(() => calls.text.length === 1, 'the reminder text to be delivered');
  assert.equal(calls.text[0].text, '交作业');
  assert.equal(instance.snapshot()[0].status, 'done');
});

test('a repeating task advances to the next occurrence after firing', async () => {
  const file = await tempFile();
  const clock = { value: at(2026, 8, 20, 14, 0) };
  const { instance, timers, calls } = makeReminders({ file, clock });
  await instance.load();
  const { task } = await instance.create({
    key: 'group:100000001',
    type: 'group',
    targetId: '100000001',
    callerId: '100000002',
    text: '早安',
    at: '2026-08-21T09:00',
    repeat: 'daily',
  });
  assert.equal(task.dueAt, at(2026, 8, 21, 9, 0));
  clock.value = at(2026, 8, 21, 9, 0);
  timers.fire();
  await until(() => calls.text.length === 1, 'the daily reminder');
  await until(() => instance.snapshot()[0].status === 'active', 'the task to stay active');
  assert.equal(instance.snapshot()[0].dueAt, at(2026, 8, 22, 9, 0));
  assert.equal(instance.snapshot()[0].fireCount, 1);
});

test('agent mode sends the model reply; a skip falls back to the fixed text', async () => {
  const file = await tempFile();
  const clock = { value: at(2026, 8, 20, 14, 0) };
  let nextOutcome = { kind: 'reply', text: '该交作业了' };
  const { instance, timers, calls } = makeReminders({
    file,
    clock,
    runTurn: async () => nextOutcome,
  });
  await instance.load();
  await instance.create({
    key: 'group:100000001',
    type: 'group',
    targetId: '100000001',
    callerId: '100000002',
    text: '交作业',
    inMinutes: 1,
    mode: 'agent',
  });
  clock.value += 61 * 1000;
  timers.fire();
  await until(() => calls.model.length === 1, 'the model reply');
  assert.equal(calls.model[0].text, '该交作业了');
  assert.equal(instance.snapshot()[0].status, 'done');

  // 第二条：模型判 SKIP → 固定文案兜底。
  clock.value = at(2026, 8, 20, 15, 0);
  nextOutcome = { kind: 'skip' };
  await instance.create({
    key: 'group:100000001',
    type: 'group',
    targetId: '100000001',
    callerId: '100000002',
    text: '开会',
    inMinutes: 1,
    mode: 'agent',
  });
  clock.value += 61 * 1000;
  timers.fire();
  await until(() => calls.text.length === 1, 'the fallback text');
  assert.equal(calls.text[0].text, '开会');
});

test('agent failure and timeout both fall back to text', async () => {
  for (const outcome of [{ kind: 'failure' }, { kind: 'timeout' }]) {
    const file = await tempFile();
    const clock = { value: at(2026, 8, 20, 14, 0) };
    const { instance, timers, calls } = makeReminders({ file, clock, runTurn: async () => outcome });
    await instance.load();
    await instance.create({
      key: 'private:100000002',
      type: 'private',
      targetId: '100000002',
      callerId: '100000002',
      text: '吃药',
      inMinutes: 1,
      mode: 'agent',
    });
    clock.value += 61 * 1000;
    timers.fire();
    await until(() => calls.text.length === 1, `the ${outcome.kind} fallback`);
    assert.equal(calls.text[0].text, '吃药');
  }
});

test('a busy conversation makes agent mode use the fixed text instead of a turn', async () => {
  const file = await tempFile();
  const clock = { value: at(2026, 8, 20, 14, 0) };
  const { instance, timers, calls } = makeReminders({ file, clock, isBusy: () => true });
  await instance.load();
  await instance.create({
    key: 'group:100000001',
    type: 'group',
    targetId: '100000001',
    callerId: '100000002',
    text: '开会',
    inMinutes: 1,
    mode: 'agent',
  });
  clock.value += 61 * 1000;
  timers.fire();
  await until(() => calls.text.length === 1, 'the fixed text while busy');
  assert.equal(calls.turns.length, 0);
});

test('an unconnected deliver retries within the grace window, then gives up', async () => {
  const file = await tempFile();
  const clock = { value: at(2026, 8, 20, 14, 0) };
  let connected = false;
  const { instance, timers, calls } = makeReminders({
    file,
    clock,
    deliverText: () => (connected ? { ok: true } : { ok: false, retryable: true, reason: 'not connected' }),
  });
  await instance.load();
  await instance.create({
    key: 'group:100000001',
    type: 'group',
    targetId: '100000001',
    callerId: '100000002',
    text: '交作业',
    inMinutes: 1,
  });
  clock.value += 61 * 1000;
  timers.fire();
  await until(() => calls.text.length === 1, 'the first attempt');
  await until(() => instance.snapshot()[0].status === 'active', 'the task to stay active');
  // 等第一次 dispatch 走完 finally（inFlight 清空）：生产里重试间隔是 15 秒，不会撞上。
  await new Promise((resolve) => setTimeout(resolve, 30));
  // 15 秒后重试；这次连通了。
  connected = true;
  clock.value += 16 * 1000;
  timers.fire();
  await until(() => calls.text.length === 2, 'the retry');
  await until(() => instance.snapshot()[0].status === 'done', 'the task to finish');
});

test('a firing task left by a crash is recovered as text within the grace window', async () => {
  const file = await tempFile();
  const clock = { value: at(2026, 8, 20, 14, 0) };
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: 'r-crash',
          key: 'group:100000001',
          type: 'group',
          targetId: '100000001',
          mode: 'agent',
          text: '交作业',
          fallbackText: '交作业',
          dueAt: clock.value - 1000,
          status: 'firing',
          firingAt: clock.value - 1000,
          repeat: null,
          mentions: [],
          createdAt: clock.value - 5000,
          createdBy: '100000002',
        },
      ],
    }),
    'utf8',
  );
  const { instance, timers, calls } = makeReminders({ file, clock });
  await instance.load();
  assert.equal(instance.snapshot()[0].status, 'active');
  assert.equal(instance.snapshot()[0].retryText, '交作业');
  timers.fire();
  await until(() => calls.text.length === 1, 'the recovered text');
  assert.equal(calls.text[0].text, '交作业');
});

test('an overdue task beyond the grace window is marked missed, not sent', async () => {
  const file = await tempFile();
  const clock = { value: at(2026, 8, 20, 14, 0) };
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: 'r-old',
          key: 'group:100000001',
          type: 'group',
          targetId: '100000001',
          mode: 'text',
          text: '交作业',
          dueAt: clock.value - 20 * 60 * 1000,
          status: 'active',
          repeat: null,
          mentions: [],
          createdAt: clock.value - 30 * 60 * 1000,
          createdBy: '100000002',
        },
      ],
    }),
    'utf8',
  );
  const { instance, timers, calls } = makeReminders({ file, clock });
  await instance.load();
  assert.equal(instance.snapshot()[0].status, 'missed');
  assert.equal(timers.live().length, 0);
  assert.equal(calls.text.length, 0);
});

test('daily limit, active limit and duplicate creation are enforced', async () => {
  const file = await tempFile();
  const clock = { value: at(2026, 8, 20, 14, 0) };
  const { instance } = makeReminders({ file, clock, limits: { dailyMax: 1, maxActive: 2 } });
  await instance.load();
  const draft = {
    key: 'group:100000001',
    type: 'group',
    targetId: '100000001',
    callerId: '100000002',
    text: '交作业',
    inMinutes: 5,
  };
  const first = await instance.create(draft);
  const second = await instance.create(draft);
  assert.equal(second.duplicate, true);
  assert.equal(second.task.id, first.task.id);
  await assert.rejects(
    () => instance.create({ ...draft, text: '另一件事', inMinutes: 10 }),
    /daily reminder limit/,
  );
  // 操作员不受每日额度限制，但仍受每会话待发上限约束。
  await instance.create({ ...draft, operator: true, text: '第二件事', inMinutes: 10 });
  await assert.rejects(
    () => instance.create({ ...draft, operator: true, text: '第三件事', inMinutes: 15 }),
    /pending reminders/,
  );
});

test('cancel is limited to the creator (or the operator) and list scopes are separated', async () => {
  const file = await tempFile();
  const clock = { value: at(2026, 8, 20, 14, 0) };
  const { instance } = makeReminders({ file, clock });
  await instance.load();
  const { task } = await instance.create({
    key: 'group:100000001',
    type: 'group',
    targetId: '100000001',
    callerId: '100000002',
    text: '交作业',
    inMinutes: 5,
  });
  await assert.rejects(() => instance.cancel(task.id, { id: '999' }), /only the person/);
  assert.equal(instance.list({ key: 'group:100000001', scope: 'mine', creatorId: '999' }).length, 0);
  assert.equal(instance.list({ key: 'group:100000001', scope: 'mine', creatorId: '100000002' }).length, 1);
  assert.throws(() => instance.list({ scope: 'all' }), /operator/);
  const cancelled = await instance.cancel(task.id, { id: '100000002' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(instance.list({ key: 'group:100000001' }).length, 0);
});
