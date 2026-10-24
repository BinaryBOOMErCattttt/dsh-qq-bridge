/**
 * `fun.js` 的单元测试：运势稳定、骰子边界、硬币。
 * 运行：node --test test/fun.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dailyFortune, flipCoin, hash32, parseDice, rollDice } from '../fun.js';

test('dailyFortune：同一天同一个人结果稳定，换日期会变', () => {
  const a = dailyFortune({ userId: '10001', date: '2026-10-23' });
  const b = dailyFortune({ userId: '10001', date: '2026-10-23' });
  assert.deepEqual(a, b);
  assert.ok(['大吉', '中吉', '小吉', '吉', '末吉', '凶', '大凶'].includes(a.level));
  assert.ok(a.lucky.length > 0);
});

test('hash32：稳定且区分输入', () => {
  assert.equal(hash32('abc'), hash32('abc'));
  assert.notEqual(hash32('abc'), hash32('abd'));
});

test('parseDice：d6 / 2d6 / 裸数字；越界报错', () => {
  assert.deepEqual(parseDice('d6'), { count: 1, sides: 6 });
  assert.deepEqual(parseDice('2d6'), { count: 2, sides: 6 });
  assert.deepEqual(parseDice('20'), { count: 1, sides: 20 });
  assert.throws(() => parseDice('nope'), /骰子/);
  assert.throws(() => parseDice('11d6'), /最多 10/);
  assert.throws(() => parseDice('1d101'), /100 面/);
});

test('rollDice / flipCoin：注入随机源，结果可复现', () => {
  const result = rollDice({ count: 3, sides: 6 }, () => 0);
  assert.deepEqual(result.rolls, [1, 1, 1]);
  assert.equal(result.total, 3);
  assert.equal(flipCoin(() => 0), '正面');
  assert.equal(flipCoin(() => 0.9), '反面');
});
