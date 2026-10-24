/**
 * `owner-settings.js` 的单元测试：白名单、类型校验、覆盖层合并。
 *
 * 这份覆盖层是「主人在 QQ 里改 bot 配置」的落点，所以两条边界最重要：
 *   - 只认白名单键（写错一个键不能变成任意配置注入）；
 *   - 坏值在启动时被丢掉，不能让一次手滑把 bot 起不来。
 *
 * 运行：node --test test/owner-settings.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  OWNER_SETTING_KEYS,
  applyOwnerSettings,
  coerceOwnerSetting,
  isWritableKey,
  parseOwnerSettings,
  settingKind,
} from '../owner-settings.js';

test('可写名单：不含模型路由、连接、凭据、访问白名单', () => {
  for (const forbidden of [
    'provider', 'model', 'endpoint', 'accessToken', 'cwd', 'resetUsers', 'allowUsers', 'allowGroups',
    'apiKeyFile', 'persona', 'instructions', 'mediaDir', 'stickerDir', 'memoryDir',
  ]) {
    assert.equal(isWritableKey(forbidden), false, `${forbidden} 不该能被 QQ 侧改`);
  }
  for (const allowed of ['proactive', 'batchWindowMs', 'pokeMode', 'repeatChance', 'wakeTriggers', 'commands']) {
    assert.equal(isWritableKey(allowed), true, `${allowed} 应当可改`);
  }
});

test('coerceOwnerSetting：布尔 / 数字 / 枚举 / 列表都校验，未知键直接拒绝', () => {
  assert.equal(coerceOwnerSetting('proactive', '关'), false);
  assert.equal(coerceOwnerSetting('proactive', 'true'), true);
  assert.equal(coerceOwnerSetting('batchWindowMs', '3500'), 3500);
  assert.throws(() => coerceOwnerSetting('batchWindowMs', '3.9s'), /数字/);
  assert.throws(() => coerceOwnerSetting('ambientMessages', -1), /不能是负数|不能小于/);
  assert.throws(() => coerceOwnerSetting('groupTrigger', 'sometimes'), /只能是/);
  assert.equal(coerceOwnerSetting('groupTrigger', 'prefix'), 'prefix');
  assert.throws(() => coerceOwnerSetting('not-a-key', '1'), /不在可调整名单/);
  // 额外字段按当前值推断类型。
  assert.equal(coerceOwnerSetting('pokeMode', 'poke', 'random'), 'poke');
  assert.throws(() => coerceOwnerSetting('pokeMode', 'nope', 'random'), /只能是/);
  assert.equal(coerceOwnerSetting('repeatChance', '2', 0.5), 1, '概率类夹在 0~1');
  assert.deepEqual(coerceOwnerSetting('wakeTriggers', '起床, 醒醒', ['起床']), ['起床', '醒醒']);
  assert.throws(() => coerceOwnerSetting('provider', 'x', 'deepseek'), /不在可调整名单/);
});

test('settingKind：按核心 spec / 当前值推断', () => {
  assert.equal(settingKind('proactive', true), 'boolean');
  assert.equal(settingKind('batchWindowMs', 2000), 'number');
  assert.equal(settingKind('groupTrigger', 'prefix'), 'enum');
  assert.equal(settingKind('wakeTriggers', ['起床']), 'list');
  assert.equal(settingKind('prefix', '/'), 'string');
});

test('parseOwnerSettings：只留可写键，坏值丢掉并记 warn', () => {
  const warnings = [];
  const parsed = parseOwnerSettings(
    {
      version: 1,
      values: {
        proactive: false,
        batchWindowMs: '4000',
        groupTrigger: 'nope',
        provider: 'evil',
        'not-a-key': 1,
      },
    },
    (level, message) => warnings.push(`${level}:${message}`),
  );
  assert.deepEqual(parsed.values, { proactive: false, batchWindowMs: 4000 });
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some((line) => line.includes('groupTrigger')));
  assert.ok(warnings.some((line) => line.includes('provider')));
  assert.ok(warnings.some((line) => line.includes('not-a-key')));
});

test('applyOwnerSettings：返回新对象、不改入参，并同步派生开关', () => {
  const base = { proactive: true, batchWindowMs: 2000, memory: true, memoryOn: true, imageSend: true };
  const { settings, applied, rejected } = applyOwnerSettings(base, { proactive: false, memory: false });
  assert.equal(base.proactive, true, '入参不能被改');
  assert.equal(settings.proactive, false);
  assert.equal(settings.memoryOn, false);
  assert.deepEqual(applied.sort(), ['memory', 'proactive']);
  assert.deepEqual(rejected, []);
  // 未知 / 只读键被忽略。
  const ignored = applyOwnerSettings(base, { provider: 'x' });
  assert.deepEqual(ignored.applied, []);
  assert.equal(ignored.settings.provider, undefined);
});
