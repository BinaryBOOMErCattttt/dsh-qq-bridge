/**
 * 定档（`handoff.js`）：交接文档、归档、换代、模块闸，以及「睡觉去」12 秒兜底。
 *
 * 端到端（主人发 `定档` → 真写文件、真换代、新会话第一句话读文档）在
 * `test/bridge-handoff.test.mjs`；这里只验拼文档与定时器这些**机械**部分。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HANDOFF_FALLBACK_MS, HANDOFF_TAIL, createHandoff, handoffDocText } from '../handoff.js';
import { sessionIdFor } from '../util.js';

const OWNER_ID = '100000002';
const CONVERSATION = {
  key: 'private:100000002',
  type: 'private',
  id: '100000002',
  name: '主人',
  sessionGeneration: 2,
  pending: [],
};

const SETTINGS = { groupTrigger: 'mention', prefix: '/' };

/** 一条入站消息（`onebot.js` 的 messageToText 认这个形状）。 */
function messageEvent({ text = '睡觉去', type = 'private', userId = OWNER_ID, groupId = '100000001', at = true } = {}) {
  const segments = [{ type: 'text', data: { text } }];
  if (at) segments.unshift({ type: 'at', data: { qq: '100000000' } });
  return {
    post_type: 'message',
    message_type: type,
    user_id: Number(userId),
    group_id: Number(groupId),
    message_id: 7100,
    message: type === 'group' && !at ? [{ type: 'text', data: { text } }] : segments,
    raw_message: text,
    sender: { nickname: '主人', card: '主人' },
  };
}

/**
 * 建一套定档动作：会话、转录、发送、换代、归档根全是假的，只有文档写入是真的
 * （写进临时 cwd，好断言文件名与内容）。
 */
async function fixture({ moduleEnabled = () => true, muted = false, transcript = [] } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'qq-handoff-'));
  const sent = [];
  const turns = [];
  const timers = [];
  const conversation = { ...CONVERSATION };
  const handoff = createHandoff({
    cwd,
    settings: SETTINGS,
    moduleEnabled,
    canOperate: (id) => String(id) === OWNER_ID,
    conversationFor: (_type, _id, sender) => ({ ...conversation, name: sender.name }),
    todayTranscript: async () => transcript,
    ambientTail: () => [],
    isMuted: () => muted,
    describe: (item) => item.key,
    send: (item, text) => sent.push({ key: item.key, text }),
    resetConversation: async (item) => {
      item.sessionGeneration = (item.sessionGeneration ?? 0) + 1;
      return true;
    },
    startAgentTurn: (item, text, meta) => turns.push({ key: item.key, text, meta }),
    sessionRoot: () => join(cwd, 'sessions'),
    now: () => Date.UTC(2026, 9, 26, 22, 0, 0),
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false, unref: () => {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { if (timer !== undefined) timer.cleared = true; },
  });
  return { cwd, handoff, conversation, sent, turns, timers };
}

test('HANDOFF_FALLBACK_MS：说了睡之后等 12 秒', () => {
  assert.equal(HANDOFF_FALLBACK_MS, 12_000);
});

test('handoffDocText：头信息 / 最近 80 条 / 关键词命中的待办 / 静默状态', () => {
  const tail = Array.from({ length: 100 }, (_item, index) => ({ name: '甲', text: `第${index}条` }));
  const text = handoffDocText({
    conversation: { key: 'group:1', name: '测试群' },
    reason: 'manual',
    tail,
    tasks: [{ name: '乙', text: '提醒 明天八点 交作业' }],
    ambientTail: [],
    muted: true,
    generation: 3,
    at: Date.UTC(2026, 9, 26, 22, 0, 0),
  });
  assert.match(text, /^# 交接文档/m);
  assert.match(text, /- 会话：group:1（测试群）/);
  assert.match(text, /- 原因：主人手动定档/);
  assert.match(text, /- 会话轮次：3/);
  assert.match(text, /- 静默状态：静默中/);
  // 只留最近 80 条：第 20 条（最旧）被切掉，第 99 条（最新）在。
  assert.match(text, /第99条/);
  assert.doesNotMatch(text, /第19条/);
  assert.match(text, /- 乙：提醒 明天八点 交作业/);
  const lines = text.split('\n').filter((line) => line.startsWith('- 甲：'));
  assert.equal(lines.length, HANDOFF_TAIL);
});

test('handoffDocText：没有转录时用群环境缓冲兜底；没有待办时给一句说明', () => {
  const text = handoffDocText({
    conversation: { key: 'group:1', name: '' },
    reason: 'sleep-fallback',
    tail: [],
    tasks: [],
    ambientTail: [{ name: '丙', text: '他们在聊展' }],
    muted: false,
    generation: 0,
  });
  assert.match(text, /- 会话：group:1\n/, '没有群名时只写 key');
  assert.match(text, /- 原因：主人说睡但静默失败，自动定档/);
  assert.match(text, /- 静默状态：醒着/);
  assert.match(text, /（今天的转录是空的，下面是群聊环境缓冲）/);
  assert.match(text, /- 丙：他们在聊展/);
  assert.match(text, /（没有明显命中的任务；以最近对话为准）/);
});

test('handoffDocText：正文有 12000 字上限', () => {
  const tail = Array.from({ length: 80 }, (_item, index) => ({ name: '长', text: `${index}` + '字'.repeat(400) }));
  const text = handoffDocText({ conversation: { key: 'group:1', name: '' }, reason: 'manual', tail, tasks: [], generation: 1 });
  assert.equal(text.length, 12_000);
});

test('sleepIntentFor：只认主人的「睡觉去」，群里要 @ 或前缀，模块关掉就不认', async () => {
  const { handoff } = await fixture();
  assert.ok(handoff.sleepIntentFor(messageEvent(), '100000000'), '主人私聊直接说');
  assert.ok(handoff.sleepIntentFor(messageEvent({ text: '去睡吧' }), '100000000'));
  assert.equal(handoff.sleepIntentFor(messageEvent({ userId: '999' }), '100000000'), undefined, '不是主人');
  assert.equal(handoff.sleepIntentFor(messageEvent({ text: '我睡觉去了明天见' }), '100000000'), undefined, '超过 12 字的长句');
  assert.equal(handoff.sleepIntentFor(messageEvent({ text: '睡觉去', type: 'group', at: false }), '100000000'), undefined, '群里没 @ 它');
  assert.ok(handoff.sleepIntentFor(messageEvent({ text: '睡觉去', type: 'group' }), '100000000'), '群里 @ 它就算');
  assert.equal(handoff.sleepIntentFor(messageEvent({ userId: '100000000' }), '100000000'), undefined, '它自己说的不算');
  assert.equal(handoff.sleepIntentFor({ post_type: 'notice' }, '100000000'), undefined, '不是消息事件');

  const off = await fixture({ moduleEnabled: () => false });
  assert.equal(off.handoff.sleepIntentFor(messageEvent(), '100000000'), undefined, 'moduleHandoff 关掉时不登记兜底');
});

test('markSleepIntent：12 秒后没静默才定档；真静默了就什么都不做', async () => {
  const awake = await fixture();
  awake.handoff.markSleepIntent(awake.conversation);
  assert.equal(awake.conversation.sleepIntentAt, Date.now() > 0 ? awake.conversation.sleepIntentAt : 0);
  assert.equal(awake.timers.length, 1);
  assert.equal(awake.timers[0].ms, HANDOFF_FALLBACK_MS);
  awake.timers[0].fn();
  // 定档是异步的（写文档 → 换代 → 开一轮），等一个 tick。
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(awake.conversation.sessionGeneration, CONVERSATION.sessionGeneration + 1, '兜底真的换代了');
  assert.equal(awake.sent[0].text.includes('交接文档写好了'), true);
  assert.equal(awake.conversation.sleepIntentAt, undefined);

  const slept = await fixture({ muted: true });
  slept.handoff.markSleepIntent(slept.conversation);
  slept.timers[0].fn();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(slept.conversation.sessionGeneration, CONVERSATION.sessionGeneration, '已经静默了就不该定档');
  assert.equal(slept.sent.length, 0);
});

test('clearSleepIntent：静默成功 / 被叫醒时把定时器撤掉', async () => {
  const { handoff, conversation, timers } = await fixture();
  handoff.markSleepIntent(conversation);
  handoff.clearSleepIntent(conversation);
  assert.equal(conversation.sleepIntentAt, undefined);
  assert.equal(timers[0].cleared, true);
});

test('handoff：写文档 → 换代 → 归档 → 新会话先读文档', async () => {
  const transcript = [
    { name: '甲', text: '周六去看展吗' },
    { name: '乙', text: '记得提醒我买票' },
  ];
  const { cwd, handoff, conversation, sent, turns } = await fixture({ transcript });
  // 老会话目录：名字是**确定性**的 sessionIdFor(key, 第几轮)；归档就是把它从
  // <root>/<任意层>/ 挪进 data/handoff/archive/。
  const oldSessionId = sessionIdFor(conversation.key, conversation.sessionGeneration);
  await mkdir(join(cwd, 'sessions', 'qq', oldSessionId), { recursive: true });
  await writeFile(join(cwd, 'sessions', 'qq', oldSessionId, 'log.jsonl'), '{}\n', 'utf8');

  await handoff.handoff(conversation, 'manual');
  assert.equal(conversation.sessionGeneration, CONVERSATION.sessionGeneration + 1);

  const dir = join(cwd, 'data', 'handoff');
  const files = (await readdir(dir)).filter((name) => name.endsWith('.md'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^private-100000002-\d{4}-\d{2}-\d{2}T/u);
  const doc = await readFile(join(dir, files[0]), 'utf8');
  assert.match(doc, /甲：周六去看展吗/);
  assert.match(doc, /乙：记得提醒我买票/, '关键词「记得」命中的也会进待办');

  // 归档：旧目录从 sessions 根里消失了，archive 下有它。
  assert.equal(existsSync(join(cwd, 'sessions', 'qq', oldSessionId)), false);
  const archived = await readdir(join(dir, 'archive'));
  assert.equal(archived.length, 1);
  assert.match(archived[0], new RegExp('^' + oldSessionId + '-\\d+$', 'u'));

  // 先回一句「写好了」，再开一轮让模型读文档（文档路径要能对上）。
  assert.match(sent[0].text, /交接文档写好了/);
  assert.match(sent[0].text, new RegExp(files[0].replace('.', '\\.')));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].meta.command, '定档');
  assert.equal(turns[0].meta.intent, 'handoff');
  assert.match(turns[0].text, /先用 read 读交接文档/);
  assert.match(turns[0].text, new RegExp(files[0].replace('.', '\\.')));
});

test('handoff：模块关着时不动会话（指令侧另有一道闸，兜底这条靠这里）', async () => {
  const { cwd, handoff, conversation, sent, turns } = await fixture({ moduleEnabled: () => false });
  await handoff.handoff(conversation, 'sleep-fallback');
  assert.equal(conversation.sessionGeneration, CONVERSATION.sessionGeneration, '没换代');
  assert.equal(sent.length, 0, '兜底失败时安静跳过，不打扰群里');
  assert.equal(turns.length, 0);
  assert.equal(existsSync(join(cwd, 'data', 'handoff')), false, '一个字都不写');

  // 手动那条会回一句原因（主人按了指令，总得知道为什么没动）。
  await handoff.handoff(conversation, 'manual');
  assert.match(sent[0].text, /moduleHandoff/);
});

test('handoff：同一次定档还没跑完时，第二次调用直接忽略', async () => {
  const { handoff, conversation, sent } = await fixture();
  conversation.handoffBusy = true;
  await handoff.handoff(conversation, 'manual');
  assert.equal(sent.length, 0);
  assert.equal(conversation.sessionGeneration, CONVERSATION.sessionGeneration);
});
