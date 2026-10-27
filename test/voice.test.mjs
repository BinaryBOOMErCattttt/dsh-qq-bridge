/**
 * `voice.js`（语音转文字）的测试。
 *
 * 这里钉两件事：
 *   - 转写文字怎么变成模型读到的那一句（格式、单位、截断、折行）；
 *   - 什么时候**不该**发请求（段里自带文字、没有 message_id、不是语音），
 *     以及请求失败时只降级、不抛错。
 *
 * 全部用假 `call`：不连 NapCat、不联网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VOICE_TRANSCRIPT_ACTION,
  isVoiceSegment,
  normalizeVoiceTranscript,
  resolveVoiceTranscripts,
  voiceTranscriptPlaceholder,
} from '../voice.js';

/** 造一个消息段：测试里只关心 `type` 与 `data`。 */
const seg = (type, data = {}) => ({ type, data });

test('isVoiceSegment 认 record 与 voice，别的都不算', () => {
  assert.equal(isVoiceSegment(seg('record')), true);
  assert.equal(isVoiceSegment(seg('voice')), true);
  assert.equal(isVoiceSegment(seg('text', { text: 'hi' })), false);
  assert.equal(isVoiceSegment(null), false);
  assert.equal(isVoiceSegment(undefined), false);
});

test('normalizeVoiceTranscript 折成一行、去首尾空白、超长截断', () => {
  assert.equal(normalizeVoiceTranscript('  你好\n世界\t！  '), '你好 世界 ！');
  assert.equal(normalizeVoiceTranscript(''), '');
  assert.equal(normalizeVoiceTranscript('   '), '');
  assert.equal(normalizeVoiceTranscript(undefined), '');
  assert.equal(normalizeVoiceTranscript(123), '');
  // 截断：保留 maxChars 个字，再补一个省略号说明后面还有。
  assert.equal(normalizeVoiceTranscript('一二三四五六', 4), '一二三四…');
  // 正好等于上限时不加省略号。
  assert.equal(normalizeVoiceTranscript('一二三四', 4), '一二三四');
  // 非法 maxChars 退回默认 500（这里只验证不抛错、内容完整）。
  assert.equal(normalizeVoiceTranscript('短句', 0), '短句');
});

test('voiceTranscriptPlaceholder 沿用 modalities 的时长口径，并标明这是语音转文字', () => {
  assert.equal(
    voiceTranscriptPlaceholder(seg('record', { duration: 3000 }), '今天天气不错'),
    '[语音 3 秒｜这是一条语音消息，语音转文字内容如下：今天天气不错]',
  );
  // 没有时长时与旧占位符同一个头（`[语音]`），只是括号里多了转写。
  assert.equal(
    voiceTranscriptPlaceholder(seg('record', {}), '嗯'),
    '[语音｜这是一条语音消息，语音转文字内容如下：嗯]',
  );
  // 空转写退回原来的占位符，不拼一个空的「内容如下：」。
  assert.equal(voiceTranscriptPlaceholder(seg('record', { duration: 2 }), ''), '[语音 2 秒]');
});

test('段里自带转写时不发请求', async () => {
  let calls = 0;
  const map = await resolveVoiceTranscripts([seg('record', { duration: 2, text: ' 自带文字\n第二行 ' })], {
    messageId: '123',
    call: async () => {
      calls += 1;
      return { text: '不该用这个' };
    },
  });
  assert.equal(calls, 0);
  assert.equal(map.get(0), '[语音 2 秒｜这是一条语音消息，语音转文字内容如下：自带文字 第二行]');
});

test('调 fetch_ptt_text：数字 message_id 传成 number，结果落回语音那一段', async () => {
  const seen = [];
  const map = await resolveVoiceTranscripts(
    [seg('text', { text: '听一下这个' }), seg('record', { duration: 3000 })],
    {
      messageId: '987654321',
      call: async (action, params) => {
        seen.push([action, params]);
        return { text: ' 好的\n我知道了 ' };
      },
    },
  );
  assert.deepEqual(seen, [[VOICE_TRANSCRIPT_ACTION, { message_id: 987654321 }]]);
  // 只替换语音段，文字段不动（Map 里没有下标 0）。
  assert.equal(map.has(0), false);
  assert.equal(map.get(1), '[语音 3 秒｜这是一条语音消息，语音转文字内容如下：好的 我知道了]');
});

test('非数字 message_id 原样传字符串（部分实现用字符串 id）', async () => {
  let params;
  await resolveVoiceTranscripts([seg('record', {})], {
    messageId: 'abc-def',
    call: async (_action, p) => {
      params = p;
      return { text: 'x' };
    },
  });
  assert.deepEqual(params, { message_id: 'abc-def' });
});

test('取不到 / 空文字 / 没有 message_id / 不是语音：都只返回 undefined，不抛错', async () => {
  const failing = async () => {
    throw new Error('action not supported');
  };
  assert.equal(await resolveVoiceTranscripts([seg('record', {})], { messageId: '1', call: failing }), undefined);
  assert.equal(
    await resolveVoiceTranscripts([seg('record', {})], { messageId: '1', call: async () => ({ text: '   ' }) }),
    undefined,
  );
  assert.equal(
    await resolveVoiceTranscripts([seg('record', {})], { messageId: '1', call: async () => ({}) }),
    undefined,
  );

  let calls = 0;
  const counting = async () => {
    calls += 1;
    return { text: 'x' };
  };
  assert.equal(await resolveVoiceTranscripts([seg('record', {})], { messageId: '', call: counting }), undefined);
  assert.equal(calls, 0);
  assert.equal(await resolveVoiceTranscripts([seg('record', {})], { call: counting }), undefined);
  assert.equal(calls, 0);

  assert.equal(await resolveVoiceTranscripts([seg('text', { text: 'hi' })], { messageId: '1', call: counting }), undefined);
  assert.equal(await resolveVoiceTranscripts('not-an-array', { messageId: '1', call: counting }), undefined);
  assert.equal(await resolveVoiceTranscripts(null, {}), undefined);
});

test('一条消息里有多段语音时只转写第一段（其余保留占位符）', async () => {
  const map = await resolveVoiceTranscripts(
    [seg('record', { duration: 1 }), seg('record', { duration: 2 })],
    { messageId: '5', call: async () => ({ text: '第一段' }) },
  );
  assert.equal(map.size, 1);
  assert.equal(map.get(0), '[语音 1 秒｜这是一条语音消息，语音转文字内容如下：第一段]');
});

test('maxChars 生效：接口给的超长转写也会被截断', async () => {
  const map = await resolveVoiceTranscripts([seg('record', { duration: 1 })], {
    messageId: '5',
    maxChars: 4,
    call: async () => ({ text: '一二三四五六' }),
  });
  assert.equal(map.get(0), '[语音 1 秒｜这是一条语音消息，语音转文字内容如下：一二三四…]');
});

test('带内联转写 + 另一段需要接口时，两段都处理', async () => {
  const map = await resolveVoiceTranscripts(
    [
      seg('record', { duration: 1, text: '自带' }),
      seg('record', { duration: 2 }),
    ],
    { messageId: '9', call: async () => ({ text: '接口' }) },
  );
  assert.equal(map.get(0).includes('自带'), true);
  assert.equal(map.get(1).includes('接口'), true);
});
