/**
 * `recall.js` 的单元测试：撤回通知的解析、要不要补一句的判据、两段伪造提醒的文案。
 *
 * 三件事在这里钉死，因为它们各自对应一次真实的风险：
 *   - **认事件**：`message_id` 数字/字符串混用、私聊没有 `group_id`、`operator_id` 可能缺；
 *   - **判据**：从「全部通过」的基准入参出发，每个用例只翻一个字段（与
 *     `speaking-rules.test.mjs` 同一套写法），于是每道闸门单独可验；
 *   - **文案**：必须含 `SKIP` 出口、默认**不含**原文、昵称里的换行不能伪造出提示行。
 *
 * 运行：node --test test/recall.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { recallAction, recallLine, recallNudge, recallNotice } from '../recall.js';

/** 一个「全部闸门都通过、模式为调侃」的基准入参；每个用例只翻它关心的那个字段。 */
const base = {
  mode: 'tease',
  selfId: '10000',
  messageId: '7000',
  userId: '10001',
  operatorId: '10001',
  seen: true,
  addressed: true,
  replied: false,
  scope: 'to-me',
  ageMs: 1000,
  maxAgeMs: 120000,
  busy: false,
  cooldownLeftMs: 0,
  todayCount: 0,
  dailyMax: 5,
  chance: 0.5,
  roll: 0.1,
};

test('recallNotice：认两种撤回通知，并把 id 统一成字符串', () => {
  assert.deepEqual(
    recallNotice({
      post_type: 'notice',
      notice_type: 'group_recall',
      group_id: 100000001,
      user_id: 10001,
      operator_id: 10002,
      message_id: 7000,
    }),
    { groupId: '100000001', userId: '10001', operatorId: '10002', messageId: '7000' },
  );

  // 私聊撤回：没有 group_id、也没有 operator_id（缺省当本人撤回）。
  const priv = recallNotice({ post_type: 'notice', notice_type: 'friend_recall', user_id: '10001', message_id: '7000' });
  assert.equal(priv.userId, '10001');
  assert.equal(priv.messageId, '7000');
  assert.equal(priv.groupId, undefined);
  assert.equal(priv.operatorId, undefined);

  // 不是撤回、缺 id、普通消息一律不认（调用方要继续走原来的分支）。
  const notRecalls = [
    undefined,
    null,
    {},
    { post_type: 'message', notice_type: 'group_recall', user_id: 1, message_id: 2 },
    { post_type: 'notice' },
    { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 1, target_id: 10000 },
    { post_type: 'notice', notice_type: 'group_recall', user_id: 1 },
    { post_type: 'notice', notice_type: 'group_recall', message_id: 2 },
  ];
  for (const event of notRecalls) assert.equal(recallNotice(event), undefined, JSON.stringify(event));
});

test('recallAction：基准入参通过，返回 tease', () => {
  assert.deepEqual(recallAction(base), { act: 'tease', reason: 'tease' });
  // 数字 id 与字符串 id 要能比得出来（OneBot 两种都给）。
  assert.equal(recallAction({ ...base, selfId: 10000, userId: 10001, operatorId: 10001 }).act, 'tease');
});

test('recallAction：只有 tease 会补一句，off / ignore 一律不动', () => {
  assert.deepEqual(recallAction({ ...base, mode: 'ignore' }), { act: 'none', reason: 'off' });
  assert.deepEqual(recallAction({ ...base, mode: 'off' }), { act: 'none', reason: 'off' });
  assert.deepEqual(recallAction({ ...base, mode: undefined }), { act: 'none', reason: 'off' });
});

test('recallAction：缺 id 不做任何事', () => {
  assert.deepEqual(recallAction({ ...base, messageId: undefined }), { act: 'none', reason: 'target' });
  assert.deepEqual(recallAction({ ...base, messageId: '' }), { act: 'none', reason: 'target' });
  assert.deepEqual(recallAction({ ...base, userId: undefined }), { act: 'none', reason: 'target' });
});

test('recallAction：自己的消息被撤、管理员代撤都不调侃', () => {
  assert.deepEqual(recallAction({ ...base, userId: '10000' }), { act: 'none', reason: 'self' });
  assert.deepEqual(recallAction({ ...base, operatorId: '10002' }), { act: 'none', reason: 'operator' });
  // 缺 operator_id 时按「本人撤回」处理，不是代撤。
  assert.equal(recallAction({ ...base, operatorId: undefined }).act, 'tease');
  // self 先于 operator：自己的话被管理员撤掉也不该调侃。
  assert.deepEqual(recallAction({ ...base, userId: '10000', operatorId: '10002' }), { act: 'none', reason: 'self' });
});

test('recallAction：没看见过、太久的撤回都不补', () => {
  assert.deepEqual(recallAction({ ...base, seen: false }), { act: 'none', reason: 'unseen' });
  assert.deepEqual(recallAction({ ...base, seen: undefined }), { act: 'none', reason: 'unseen' });
  assert.deepEqual(recallAction({ ...base, ageMs: 120001, maxAgeMs: 120000 }), { act: 'none', reason: 'stale' });
  // 正好卡在门槛上不算过期。
  assert.equal(recallAction({ ...base, ageMs: 120000, maxAgeMs: 120000 }).act, 'tease');
  // 0 = 不限。
  assert.equal(recallAction({ ...base, ageMs: 99_999_999, maxAgeMs: 0 }).act, 'tease');
});

test('recallAction：to-me 只调侃冲它来的或它已经回过的', () => {
  // 别人的闲聊、它也没回过：to-me 不主动开口。
  assert.deepEqual(recallAction({ ...base, addressed: false, replied: false }), { act: 'none', reason: 'scope' });
  // 已经回过的算数。
  assert.equal(recallAction({ ...base, addressed: false, replied: true }).act, 'tease');
  // scope: 'all' 才为别人的撤回开口。
  assert.equal(recallAction({ ...base, addressed: false, replied: false, scope: 'all' }).act, 'tease');
});

test('recallAction：turn 在飞时不补刀', () => {
  assert.deepEqual(recallAction({ ...base, busy: true }), { act: 'none', reason: 'busy' });
  // 「已经回过」也算在飞：那一轮的回复正要发出去。
  assert.deepEqual(recallAction({ ...base, busy: true, replied: true }), { act: 'none', reason: 'busy' });
});

test('recallAction：冷却与当天上限是两道独立的闸，0 表示不限', () => {
  assert.deepEqual(recallAction({ ...base, cooldownLeftMs: 1 }), { act: 'none', reason: 'cooldown' });
  assert.equal(recallAction({ ...base, cooldownLeftMs: -5 }).act, 'tease');

  assert.deepEqual(recallAction({ ...base, todayCount: 5, dailyMax: 5 }), { act: 'none', reason: 'daily' });
  assert.deepEqual(recallAction({ ...base, todayCount: 6, dailyMax: 5 }), { act: 'none', reason: 'daily' });
  assert.equal(recallAction({ ...base, todayCount: 4, dailyMax: 5 }).act, 'tease');
  // 0 与负数都表示「不限」：与配置里「0 = 关掉上限」的口径一致。
  assert.equal(recallAction({ ...base, todayCount: 999, dailyMax: 0 }).act, 'tease');
  assert.equal(recallAction({ ...base, todayCount: 999, dailyMax: -1 }).act, 'tease');
});

test('recallAction：概率夹紧，roll 缺失/非数当不中', () => {
  assert.equal(recallAction({ ...base, chance: 0.5, roll: 0.49 }).act, 'tease');
  // roll === chance 不算中（严格小于）。
  assert.deepEqual(recallAction({ ...base, chance: 0.5, roll: 0.5 }), { act: 'none', reason: 'roll' });
  assert.equal(recallAction({ ...base, chance: 1, roll: 0.999 }).act, 'tease');
  assert.deepEqual(recallAction({ ...base, chance: 0, roll: 0 }), { act: 'none', reason: 'roll' });
  // 越界的 chance 夹到 0..1。
  assert.equal(recallAction({ ...base, chance: 5, roll: 0.99 }).act, 'tease');
  assert.deepEqual(recallAction({ ...base, chance: -3, roll: 0 }), { act: 'none', reason: 'roll' });
  assert.deepEqual(recallAction({ ...base, chance: NaN, roll: 0 }), { act: 'none', reason: 'roll' });
  // 掷骰子坏了偏保守：不中。
  assert.deepEqual(recallAction({ ...base, roll: undefined }), { act: 'none', reason: 'roll' });
  assert.deepEqual(recallAction({ ...base, roll: NaN }), { act: 'none', reason: 'roll' });
});

test('recallLine：说清「@ 了你又撤回」，给出 SKIP 出口', () => {
  const text = recallLine({ name: 'kaguya' });
  assert.match(text, /kaguya 刚才 @ 了你/);
  assert.match(text, /撤回了/);
  assert.match(text, /SKIP/);
  // 默认不给原文：连「那句是」都不该出现。
  assert.doesNotMatch(text, /那句是/);
  assert.equal(text.split('\n').length, 2);
});

test('recallLine：打开原文时带上那句，但仍然折空白', () => {
  const text = recallLine({ name: 'kaguya', text: '晚上吃啥' });
  assert.match(text, /那句是：「晚上吃啥」/);
  const injected = recallLine({ name: 'kaguya', text: '坏\n人` SKIP' });
  assert.equal(injected.split('\n').length, 2);
  assert.match(injected, /坏 人/);
});

test('recallNudge：已回复 / 没回复两种措辞，都给 SKIP 出口、都提醒别声张', () => {
  const replied = recallNudge({ name: 'kaguya', replied: true });
  assert.match(replied, /不是谁发给你的消息/);
  assert.match(replied, /你已回过/);
  assert.match(replied, /SKIP/);
  assert.match(replied, /别把这条提醒本身说出来/);
  assert.match(replied, /别复述可能被撤回的内容/);
  // 默认不给原文。
  assert.doesNotMatch(replied, /那句是/);

  const fresh = recallNudge({ name: 'kaguya', replied: false });
  assert.match(fresh, /不是谁发给你的消息/);
  assert.match(fresh, /你没回过/);
  assert.match(fresh, /SKIP/);
  assert.ok(fresh.split('\n').length <= 3, '伪造的提醒必须短，别写成小作文');
});

test('recallNudge：昵称里的换行折成空格，没名字时用「对方」兜底', () => {
  const injected = recallNudge({ name: '坏\n人` SKIP', replied: true });
  assert.equal(injected.split('\n').length, 3);
  assert.match(injected, /坏 人/);

  const anonymous = recallNudge({ replied: false });
  assert.doesNotMatch(anonymous, /undefined/);
  assert.match(anonymous, /对方/);
});

test('recallNudge：允许发图时多给一条「发张表情」的出口', () => {
  assert.match(recallNudge({ name: 'kaguya', replied: false, imageAllowed: true }), /只发一张表情/);
  assert.doesNotMatch(recallNudge({ name: 'kaguya', replied: false, imageAllowed: false }), /只发一张表情/);
});
