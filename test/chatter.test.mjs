/**
 * `chatter.js` 的契约测试。
 *
 * 这个模块存在的唯一理由，就是让「哪本账算不算我自己说的话」「谁比大小、谁比时间」
 * 这些判据**不靠注释维持**。所以用例写的不是实现细节，而是那几条最容易被后来人
 * 「顺手合并成一张表」的不变量 —— 合并了这里就会红。
 *
 * 不经过 Harness：`createChatter` 是纯内存结构。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createChatter } from '../chatter.js';

const MIN = { windowMs: 60_000, keepLines: 6 };

test('别人的话同时推进「插话序号」与「回答指向」，且返回的是插话序号', () => {
  const c = createChatter();
  assert.equal(c.others('g1'), 0);
  assert.equal(c.anchor('g1'), 0);

  assert.equal(c.noteOther('g1', 'u1', 1000, MIN), 1);
  // 两本账都被推进：回答指向靠它判「我回的那条被挤远了没有」。
  assert.equal(c.others('g1'), 1);
  assert.equal(c.anchor('g1'), 1);

  assert.equal(c.noteOther('g1', 'u2', 2000, MIN), 2);
  assert.equal(c.others('g1'), 2);
  assert.equal(c.anchor('g1'), 2);
});

test('我自己发的话只推进「回答指向」，不打断别人那本账', () => {
  const c = createChatter();
  c.noteOther('g1', 'u1', 1000, MIN);
  c.noteSelf('g1');
  // 这正是不能把两本账合并的原因：合并之后「我自己说了一句」会让插话序号也涨，
  // 于是正在聊的那个人接着说话时会以为自己被插了话。
  assert.equal(c.others('g1'), 1);
  assert.equal(c.anchor('g1'), 2);
});

test('插话序号是单调的，「紧跟着的下一条」恰好是快照 + 1', () => {
  // `activeFollowAllows` 靠这个等式判「中间有没有别人插过话」，别改成时间戳。
  const c = createChatter();
  const snapshot = c.others('g1');
  c.noteOther('g1', 'u1', 1000, MIN);
  assert.equal(c.others('g1'), snapshot + 1);
  c.noteOther('g1', 'u2', 1001, MIN);
  assert.equal(c.others('g1'), snapshot + 2);
});

test('别的群互不干扰', () => {
  const c = createChatter();
  c.noteOther('g1', 'u1', 1000, MIN);
  c.noteOther('g2', 'u1', 1000, MIN);
  c.noteOther('g2', 'u2', 1001, MIN);
  assert.equal(c.others('g1'), 1);
  assert.equal(c.others('g2'), 2);
  assert.equal(c.others('g3'), 0);
});

test('「聊热了」要同时够条数与够人数：一个人刷屏不算', () => {
  const c = createChatter();
  const now = 10_000;
  // makeHot 用的参数与生产一致：2 条 + 2 个人。
  for (let i = 0; i < 6; i += 1) c.noteOther('g1', 'u1', now - 100, { windowMs: 60_000, keepLines: 6 });
  assert.equal(c.isHot('g1', 60_000, 2, 2, now), false, '只有一个人：凑不出「大家聊起来了」');

  c.noteOther('g1', 'u2', now - 50, { windowMs: 60_000, keepLines: 6 });
  assert.equal(c.isHot('g1', 60_000, 2, 2, now), true);
});

test('「聊热了」比较的是时间：窗口一过就自动退出', () => {
  const c = createChatter();
  c.noteOther('g1', 'u1', 1000, MIN);
  c.noteOther('g1', 'u2', 1001, MIN);
  assert.equal(c.isHot('g1', 60_000, 2, 2, 2000), true);
  // 过了窗口：条目还在缓冲里，但判据会按时间把它们排除掉。
  assert.equal(c.isHot('g1', 60_000, 2, 2, 1000 + 60_001), false);
});

test('「聊热了」是纯查询：反复问不会改变状态', () => {
  // 存一个「搭话状态」就得处理「谁负责过期」；纯查询没有这个问题，因此要钉住。
  const c = createChatter();
  c.noteOther('g1', 'u1', 1000, MIN);
  c.noteOther('g1', 'u2', 1001, MIN);
  const before = c.others('g1');
  for (let i = 0; i < 5; i += 1) assert.equal(c.isHot('g1', 60_000, 2, 2, 2000), true);
  assert.equal(c.others('g1'), before);
  assert.equal(c.anchor('g1'), before);
});

test('门槛配得比缓冲默认上限还大时，缓冲要跟着留够', () => {
  // 上限取 max(默认 64, activeGroupLines)：否则把门槛配到 100 之后永远凑不够，
  // 这个功能会在最需要它的时候静默失效。
  const big = createChatter();
  for (let i = 0; i < 100; i += 1) big.noteOther('g1', 'u1', 1000 + i, { windowMs: 600_000, keepLines: 100 });
  assert.equal(big.isHot('g1', 600_000, 100, 1, 2000), true);

  const small = createChatter();
  for (let i = 0; i < 100; i += 1) small.noteOther('g1', 'u1', 1000 + i, { windowMs: 600_000, keepLines: 10 });
  assert.equal(small.isHot('g1', 600_000, 100, 1, 2000), false, '门槛小于默认上限时只留 64 条');
});

test('窗口长度非正、门槛非正时一律判「没热」', () => {
  const c = createChatter();
  c.noteOther('g1', 'u1', 1000, { windowMs: 0, keepLines: 6 });
  c.noteOther('g1', 'u2', 1001, { windowMs: 0, keepLines: 6 });
  assert.equal(c.isHot('g1', 0, 2, 2, 2000), false, 'activeWindowMs = 0 表示整套关着');
  assert.equal(c.isHot('g1', 60_000, 0, 2, 2000), false, 'activeGroupLines = 0 表示关掉多人搭话');
  assert.equal(c.isHot('g1', 60_000, 2, 0, 2000), false);
});

test('forgetHeat 只忘热度窗口，不动两本序号', () => {
  // /reset 用它。序号刻意不清：快照与 activeUntil 同时归零，接话本来就要重新 @ 一次，
  // 清不清都到不了那条判据 —— 那就别动它，少一处状态变更少一份风险。
  const c = createChatter();
  c.noteOther('g1', 'u1', 1000, MIN);
  c.noteOther('g1', 'u2', 1001, MIN);
  assert.equal(c.isHot('g1', 60_000, 2, 2, 2000), true);
  c.forgetHeat('g1');
  assert.equal(c.isHot('g1', 60_000, 2, 2, 2000), false);
  assert.equal(c.others('g1'), 2);
  assert.equal(c.anchor('g1'), 2);
});

test('每个群表最多记 512 个群，超出丢掉最早的那个', () => {
  const c = createChatter();
  for (let i = 0; i < 600; i += 1) c.noteOther(`g${i}`, 'u1', 1000, { windowMs: 600_000, keepLines: 6 });
  assert.equal(c.others('g0'), 0, '最早的群被丢掉了');
  assert.equal(c.anchor('g0'), 0);
  assert.equal(c.others('g599'), 1, '最新的群还在');
  // 丢掉只影响那个群「要不要引用」的判断，不影响别的群。
  assert.equal(c.others('g300'), 1);
});
