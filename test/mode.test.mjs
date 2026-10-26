/**
 * mode.js 的纯函数测试：模式名、参数解析、三档白名单。
 *
 * 这里钉的是「切模式时到底收窄了什么」：工具白名单只收窄不放宽、简洁模式自己必须能切回去、
 * 指令 → 模块的映射不漏。端到端（重建会话 / 保留上下文 / 落盘）在
 * test/bridge-mode.test.mjs。
 *
 * 运行：node --test test/mode.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COMMAND_MODULES,
  MODES,
  SIMPLE_ALLOWED_COMMANDS,
  SIMPLE_MODULES,
  SIMPLE_TOOL_SET,
  modeLabel,
  parseModeArg,
  toolsForMode,
} from '../mode.js';

test('modeLabel：完整 / 简洁 / 斗图，未知值退回完整（默认档）', () => {
  assert.equal(modeLabel('full'), '完整');
  assert.equal(modeLabel('simple'), '简洁');
  assert.equal(modeLabel('sticker'), '斗图');
  assert.equal(modeLabel('whatever'), '完整');
  assert.deepEqual(MODES, ['full', 'simple', 'sticker']);
});

test('parseModeArg：中文 / 英文 / 大小写 / 空白都认，别的都不认', () => {
  assert.equal(parseModeArg('完整'), 'full');
  assert.equal(parseModeArg('full'), 'full');
  assert.equal(parseModeArg('FULL'), 'full');
  assert.equal(parseModeArg(' 简洁 '), 'simple');
  assert.equal(parseModeArg('simple'), 'simple');
  assert.equal(parseModeArg('斗图'), 'sticker');
  assert.equal(parseModeArg('sticker'), 'sticker');
  assert.equal(parseModeArg('表情包'), 'sticker');
  assert.equal(parseModeArg(''), undefined);
  assert.equal(parseModeArg(undefined), undefined);
});

test('toolsForMode：完整模式原样，简洁模式只收窄、不修改入参', () => {
  const base = ['read', 'qq_send_image', 'qq_memory', 'qq_transcript', 'qq_settings', 'qq_quiet'];
  assert.equal(toolsForMode(base, 'full'), base, '完整模式直接用部署白名单（不复制）');
  assert.deepEqual(toolsForMode(base, 'simple'), ['read', 'qq_memory', 'qq_transcript', 'qq_settings', 'qq_quiet']);
  assert.deepEqual(base, ['read', 'qq_send_image', 'qq_memory', 'qq_transcript', 'qq_settings', 'qq_quiet'], '基础白名单没被改动');
});

test('toolsForMode：基础白名单为空（= 不限制）时展开成简洁模式那份固定集合', () => {
  const result = toolsForMode([], 'simple');
  assert.deepEqual([...result].sort(), [...SIMPLE_TOOL_SET].sort());
  // 简洁模式不发送图、不复读、不建提醒：这些能力在完整模式才放出来。
  for (const forbidden of ['qq_send_image', 'qq_send_message', 'qq_save_sticker', 'qq_remind_create', 'qq_write']) {
    assert.equal(SIMPLE_TOOL_SET.has(forbidden), false, forbidden + ' 不该出现在简洁模式');
  }
  // 聊天 / 记忆 / 静默 / 设置必须留着，否则简洁模式连「切回去」和「别说话」都做不到。
  for (const required of ['read', 'read_image', 'web_search', 'qq_memory', 'qq_transcript', 'qq_quiet', 'qq_settings']) {
    assert.equal(SIMPLE_TOOL_SET.has(required), true, required + ' 必须留在简洁模式');
  }
});

test('SIMPLE_ALLOWED_COMMANDS：模式自己必须在里面（否则切进去就出不来）', () => {
  assert.equal(SIMPLE_ALLOWED_COMMANDS.has('模式'), true);
  for (const name of ['状态', '设置', '记忆', '定档']) assert.equal(SIMPLE_ALLOWED_COMMANDS.has(name), true, name);
  // 玩 / 查 / 创作类都不放行：简洁模式的承诺是「只聊天」。帮助也不放行（快照口径），
  // 免得它把一整页「有哪些指令」又带回简洁模式。
  for (const name of ['帮助', '抽签', '天气', '余额', '小作文', '表情', '点歌']) {
    assert.equal(SIMPLE_ALLOWED_COMMANDS.has(name), false, name);
  }
});

test('SIMPLE_MODULES：简洁模式只认定档与心情门控', () => {
  assert.equal(SIMPLE_MODULES.has('handoff'), true);
  // 心情门控在简洁模式里仍然生效（快照口径）：收窄的是能力面与主动性，不是表情。
  assert.equal(SIMPLE_MODULES.has('emojiMood'), true);
  for (const name of ['fun', 'lookup', 'tts', 'reminders']) {
    assert.equal(SIMPLE_MODULES.has(name), false, name + ' 在简洁模式里必须被强制关掉');
  }
});

test('COMMAND_MODULES：已搬进来的指令都归到一个模块，没有指向不存在的模块', () => {
  const known = new Set(['fun', 'lookup', 'reminders', 'tts', 'handoff']);
  assert.equal(COMMAND_MODULES.抽签, 'fun');
  assert.equal(COMMAND_MODULES.天气, 'lookup');
  assert.equal(COMMAND_MODULES.提醒, 'reminders');
  assert.equal(COMMAND_MODULES.语音, 'tts');
  assert.equal(COMMAND_MODULES.定档, 'handoff');
  for (const [command, module] of Object.entries(COMMAND_MODULES)) {
    assert.equal(known.has(module), true, command + ' 指向了未接线的模块 ' + module);
  }
});
