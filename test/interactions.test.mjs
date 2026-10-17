/**
 * `interactions.js` 的单元测试：戳一戳的纯决策与通知解析。
 *
 * 这里钉的是**安全与频率**两条线：只回应戳机器人自己的那一下（戳别人绝不替他去戳
 * 第三个人）、冷却与每日上限先于模式生效、未知模式走「不打扰别人」的安全默认；
 * 随机模式靠注入的 `roll` 变成确定性的，不依赖真随机。
 *
 * 运行：node --test test/interactions.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pokeAction, pokeActionType, pokeNudge, pokeNotice } from '../interactions.js';

/** 一个「通过全部闸门、模式为回戳」的基准入参；每个用例只翻它关心的那个字段。 */
const base = {
  selfId: '10000',
  targetId: '10000',
  userId: '10001',
  mode: 'poke',
  chance: 0.7,
  roll: 0,
  cooldownLeftMs: 0,
  todayCount: 0,
  dailyMax: 20,
};

test('pokeNotice：只认 notify/poke 通知，并把 id 统一成字符串', () => {
  assert.deepEqual(
    pokeNotice({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 10001, target_id: 10000, group_id: 20002 }),
    { userId: '10001', targetId: '10000', groupId: '20002' },
  );

  // 私聊戳没有 group_id。
  const priv = pokeNotice({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: '10001', target_id: 10000 });
  assert.equal(priv.userId, '10001');
  assert.equal(priv.targetId, '10000');
  assert.equal(priv.groupId, undefined);

  // 别的通知 / 缺 id / 普通消息都不能被认成戳一戳。
  const notPokes = [
    undefined,
    null,
    {},
    { post_type: 'message' },
    { post_type: 'notice', notice_type: 'group_increase', sub_type: 'approve' },
    { post_type: 'notice', notice_type: 'notify', sub_type: 'poke' },
    { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 1 },
    { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', target_id: 1 },
  ];
  for (const event of notPokes) assert.equal(pokeNotice(event), undefined, JSON.stringify(event));
});

test('pokeAction：只回应戳自己的那一下，戳别人/缺 id 一律 none', () => {
  assert.deepEqual(pokeAction(base), { act: 'poke', reason: 'mode-poke' });
  // 数字 id 与字符串 id 要能比得出来（OneBot 两种都给）。
  assert.deepEqual(pokeAction({ ...base, selfId: 10000, targetId: 10000 }), { act: 'poke', reason: 'mode-poke' });
  // 戳的是别人：群里互相戳跟机器人无关，绝不替他去戳第三个人。
  assert.deepEqual(pokeAction({ ...base, targetId: '10002' }), { act: 'none', reason: 'target' });
  assert.deepEqual(pokeAction({ ...base, targetId: undefined }), { act: 'none', reason: 'target' });
  assert.deepEqual(pokeAction({ ...base, userId: undefined }), { act: 'none', reason: 'target' });
  assert.deepEqual(pokeAction({ ...base, selfId: undefined }), { act: 'none', reason: 'target' });
  assert.deepEqual(pokeAction(), { act: 'none', reason: 'target' });
});

test('pokeAction：冷却期内不回（reason=cooldown）', () => {
  assert.deepEqual(pokeAction({ ...base, cooldownLeftMs: 1 }), { act: 'none', reason: 'cooldown' });
  assert.deepEqual(pokeAction({ ...base, cooldownLeftMs: 30000 }), { act: 'none', reason: 'cooldown' });
  // 冷却已过/为负：照常走模式。
  assert.equal(pokeAction({ ...base, cooldownLeftMs: 0 }).act, 'poke');
  assert.equal(pokeAction({ ...base, cooldownLeftMs: -5 }).act, 'poke');
});

test('pokeAction：当天次数到上限就不回，dailyMax=0 表示不限', () => {
  assert.deepEqual(pokeAction({ ...base, todayCount: 20, dailyMax: 20 }), { act: 'none', reason: 'daily' });
  assert.deepEqual(pokeAction({ ...base, todayCount: 21, dailyMax: 20 }), { act: 'none', reason: 'daily' });
  assert.equal(pokeAction({ ...base, todayCount: 19, dailyMax: 20 }).act, 'poke');
  // 0 与负数都表示「不限」：与配置里「0 = 关掉上限」的口径一致。
  assert.equal(pokeAction({ ...base, todayCount: 999, dailyMax: 0 }).act, 'poke');
  assert.equal(pokeAction({ ...base, todayCount: 999, dailyMax: -1 }).act, 'poke');
});

test('pokeAction：poke 回戳、text 走一轮、ignore 不回', () => {
  assert.deepEqual(pokeAction({ ...base, mode: 'poke' }), { act: 'poke', reason: 'mode-poke' });
  assert.deepEqual(pokeAction({ ...base, mode: 'text' }), { act: 'turn', reason: 'mode-text' });
  assert.deepEqual(pokeAction({ ...base, mode: 'ignore' }), { act: 'none', reason: 'ignore' });
  // ignore 说明「关掉」，它优先于冷却与其它读数。
  assert.deepEqual(pokeAction({ ...base, mode: 'ignore', cooldownLeftMs: 9999 }), { act: 'none', reason: 'ignore' });
});

test('pokeAction：random 按注入的 roll 决定，chance 夹紧且 NaN 当 0', () => {
  const random = { ...base, mode: 'random', chance: 0.7 };
  assert.deepEqual(pokeAction({ ...random, roll: 0.69 }), { act: 'poke', reason: 'random-poke' });
  // roll === chance 不算中（严格小于）。
  assert.deepEqual(pokeAction({ ...random, roll: 0.7 }), { act: 'turn', reason: 'random-turn' });
  assert.deepEqual(pokeAction({ ...random, roll: 0.71 }), { act: 'turn', reason: 'random-turn' });
  assert.equal(pokeAction({ ...random, chance: 1, roll: 0.999 }).act, 'poke');
  assert.equal(pokeAction({ ...random, chance: 0, roll: 0 }).act, 'turn');
  // chance 越界要夹紧到 0..1。
  assert.equal(pokeAction({ ...random, chance: 5, roll: 0.99 }).act, 'poke');
  assert.equal(pokeAction({ ...random, chance: -3, roll: 0 }).act, 'turn');
  assert.equal(pokeAction({ ...random, chance: NaN, roll: 0 }).act, 'turn');
  // 骰子缺失/非数：保守地走一轮，别默认回戳。
  assert.equal(pokeAction({ ...random, roll: undefined }).act, 'turn');
  assert.equal(pokeAction({ ...random, roll: NaN }).act, 'turn');
});

test('pokeAction：未知模式走一轮（不打扰别人的安全默认）', () => {
  assert.deepEqual(pokeAction({ ...base, mode: 'pkoe' }), { act: 'turn', reason: 'mode-unknown' });
  assert.deepEqual(pokeAction({ ...base, mode: undefined }), { act: 'turn', reason: 'mode-unknown' });
  // 配置里写了大小写不对的值，同样落到安全默认，而不是猜成回戳。
  assert.deepEqual(pokeAction({ ...base, mode: 'POKE' }), { act: 'turn', reason: 'mode-unknown' });
});

test('pokeNudge：说清谁戳了、不是正式提问、给出 SKIP，且不超过 6 行', () => {
  const text = pokeNudge({ userName: '小明' });
  assert.match(text, /小明 戳了你一下/);
  assert.match(text, /不是正式提问/);
  assert.match(text, /SKIP/);
  assert.ok(text.split('\n').length <= 6, '伪造的提醒必须短，别写成小作文');

  // 昵称来自 QQ（不可信）：换行要折成空格，不能让它伪造出额外的「提示行」。
  const injected = pokeNudge({ userName: '坏\n人` SKIP' });
  assert.equal(injected.split('\n').length, 5);
  assert.match(injected, /坏 人/);

  // 没名字时用「对方」兜底，不能把 undefined 写进正文。
  const anonymous = pokeNudge({});
  assert.doesNotMatch(anonymous, /undefined/);
  assert.match(anonymous, /对方 戳了你一下/);
});

test('pokeActionType：群聊用 group，其余都用 private', () => {
  assert.equal(pokeActionType('group'), 'group');
  assert.equal(pokeActionType('private'), 'private');
  assert.equal(pokeActionType('friend'), 'private');
  assert.equal(pokeActionType(undefined), 'private');
  assert.equal(pokeActionType(null), 'private');
});
