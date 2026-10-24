/**
 * `commands.js` 的单元测试：指令解析、别名、权限帮助文本。
 *
 * 运行：node --test test/commands.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { helpText, parseCommand, usageLine } from '../commands.js';

test('parseCommand：第一个空白前的词命中指令，其余全是参数', () => {
  assert.equal(parseCommand('帮助').command.name, '帮助');
  assert.equal(parseCommand('help').command.name, '帮助');
  assert.deepEqual(
    { name: parseCommand('天气 杭州').command.name, args: parseCommand('天气 杭州').args },
    { name: '天气', args: '杭州' },
  );
  assert.equal(parseCommand('小作文 我的青春 夏天 蝉鸣').args, '我的青春 夏天 蝉鸣');
  assert.equal(parseCommand('设置 batchWindowMs 3000').command.name, '设置');
  assert.equal(parseCommand('设置 batchWindowMs 3000').args, 'batchWindowMs 3000');
});

test('parseCommand：普通聊天不被误判', () => {
  assert.equal(parseCommand('天气不错'), undefined);
  assert.equal(parseCommand('今天天气 杭州'), undefined, '第一个词不是指令');
  assert.equal(parseCommand('帮助我写作业'), undefined);
  assert.equal(parseCommand(''), undefined);
});

test('usageLine / helpText：访客看不到主人专用段', () => {
  const line = usageLine(parseCommand('天气').command);
  assert.match(line, /@机器人 天气 <城市>/);
  const guest = helpText(false);
  assert.match(guest, /帮助/);
  assert.match(guest, /天气/);
  assert.doesNotMatch(guest, /余额/);
  assert.doesNotMatch(guest, /主人专用：/);
  const owner = helpText(true);
  assert.match(owner, /【管】/);
  assert.match(owner, /余额/);
  assert.match(owner, /设置/);
});
