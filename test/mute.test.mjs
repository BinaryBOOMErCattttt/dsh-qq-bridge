/**
 * `mute.js` 的单元测试：唤醒词与静默状态。
 *
 * 入睡现在由模型调用 `qq_quiet` 决定，所以这里只剩两件事：
 *   1. 唤醒词只认短句（「你几点起床」不该把 bot 叫醒）；
 *   2. 私聊不是可静默目标（它被写进状态文件也不认）—— 私聊是控制通道。
 *
 * 运行：node --test test/mute.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_WAKE_TRIGGERS,
  matchTrigger,
  matchWakeCommand,
  normalizeCommandText,
  parseMuteState,
  serializeMuteState,
} from '../mute.js';

test('normalizeCommandText：去空白、首尾标点与大小写，保留句中标点', () => {
  assert.equal(normalizeCommandText('  起床啦！！ '), '起床啦');
  assert.equal(normalizeCommandText('小助手　起床了。'), '小助手起床了');
  assert.equal(normalizeCommandText('你好，世界'), '你好，世界');
  assert.equal(normalizeCommandText(''), '');
});

test('matchTrigger：包含即命中（词表里的写法原样返回）', () => {
  assert.equal(matchTrigger('小助手起床了', DEFAULT_WAKE_TRIGGERS), '起床');
  assert.equal(matchTrigger('今天天气不错', DEFAULT_WAKE_TRIGGERS), undefined);
});

test('matchWakeCommand：以唤醒词开头的短句才算', () => {
  assert.equal(matchWakeCommand('起床'), '起床');
  assert.equal(matchWakeCommand('小助手醒醒', { prefixes: ['小助手'] }), '醒醒');
  assert.equal(matchWakeCommand('别睡了，起来干活'), '别睡了');
  // 问句不是叫醒。
  assert.equal(matchWakeCommand('你一般几点起床啊，我最近老是睡过头'), undefined);
  assert.equal(matchWakeCommand('你几点起床'), undefined);
  // 空消息 / 只有标点。
  assert.equal(matchWakeCommand('   '), undefined);
  assert.equal(matchWakeCommand('。。。'), undefined);
  // 自定义词表。
  assert.equal(matchWakeCommand('wake up now', { wakeTriggers: ['wake up'] }), 'wake up');
});

test('parseMuteState：坏数据当「没静默」，只收群聊 key', () => {
  assert.deepEqual(parseMuteState(null), { global: false, keys: [], at: 0, by: '' });
  assert.deepEqual(parseMuteState('nope'), { global: false, keys: [], at: 0, by: '' });
  assert.deepEqual(
    parseMuteState({
      global: false,
      keys: ['group:1', 'group:1', 'private:2', 'nope', 'group:'],
      at: 123,
      by: '9',
    }),
    { global: false, keys: ['group:1'], at: 123, by: '9' },
  );
  assert.equal(parseMuteState({ global: 'true' }).global, false);
  assert.equal(parseMuteState({ global: true }).global, true);
});

test('serializeMuteState：排序、去重、版本号；与 parse 往返一致', () => {
  const raw = serializeMuteState({ global: true, keys: new Set(['group:2', 'group:1', 'private:9']), at: 456, by: '9' });
  assert.equal(raw.version, 1);
  assert.deepEqual(raw.keys, ['group:1', 'group:2']);
  const back = parseMuteState(raw);
  assert.equal(back.global, true);
  assert.deepEqual(back.keys, ['group:1', 'group:2']);
  assert.equal(back.at, 456);
  assert.equal(back.by, '9');
});
