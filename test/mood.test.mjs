/**
 * mood.js 的纯函数测试：心情分数、mood tag、冷场衰减、表情门控。
 *
 * 这里不经过 Harness：喂一份假的 chat-state 账本与 settings 就能跑。端到端
 * （模型正文里的 tag、qq_send_image 的 user_requested、斗图模式）在
 * test/bridge-mood.test.mjs。
 *
 * 运行：node --test test/mood.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMoodGate } from '../mood.js';

/** 默认口径（与 settings.js 的夹紧结果一致）。 */
const SETTINGS = {
  moodMax: 100,
  moodTagMaxFull: 100,
  moodTagMaxSimple: 50,
  moodTriggerFull: 100,
  moodTriggerSimple: 100,
  moodDecayIdleMs: 180_000,
  moodZeroIdleMs: 1_200_000,
};

/** 建一个只含内存账本的门控（save 只记调用次数）。 */
function gateOf({ settings = SETTINGS, mode = 'full', moduleOn = true } = {}) {
  const data = {};
  let saves = 0;
  const gate = createMoodGate({
    settings,
    gameData: (name) => {
      data[name] ??= {};
      return data[name];
    },
    save: () => { saves += 1; },
    appModeOf: () => mode,
    moduleEnabled: () => moduleOn,
    report: () => {},
  });
  return { gate, data, saves: () => saves };
}

const conversation = { key: 'private:10001' };

test('moodFor：第一次访问建账，坏字段就地修好（不为一个手滑丢整份心情）', () => {
  const { data, gate } = gateOf();
  data.mood = { 'private:10001': { score: 'nope', lastAt: null, grant: 'yes', request: 1 } };
  const mood = gate.moodFor(conversation);
  assert.equal(mood.score, 0);
  assert.equal(typeof mood.lastAt, 'number');
  assert.equal(mood.grant, false);
  assert.equal(mood.request, false);
});

test('tagCap / trigger：完整与简洁各读各的配置，且都被 moodMax 夹住', () => {
  const full = gateOf().gate;
  assert.equal(full.tagCap(), 100);
  assert.equal(full.trigger(), 100);

  const simple = gateOf({ mode: 'simple' }).gate;
  assert.equal(simple.tagCap(), 50);
  assert.equal(simple.trigger(), 100);

  // moodMax 调小之后，阈值与单次涨幅都不能超过它（否则门控永远够不到）。
  const small = gateOf({ settings: { ...SETTINGS, moodMax: 30, moodTagMaxFull: 100, moodTriggerFull: 100 } }).gate;
  assert.equal(small.tagCap(), 30);
  assert.equal(small.trigger(), 30);
});

test('applyTags：加/减分、按 cap 截断、tag 从正文删掉、没 tag 时逐字返回', () => {
  const { gate } = gateOf({ settings: { ...SETTINGS, moodTagMaxFull: 20, moodTriggerFull: 100 } });
  const first = gate.applyTags('被夸了 [[mood:up15]]', conversation);
  assert.equal(first, '被夸了');
  assert.equal(gate.moodFor(conversation).score, 15);

  // 单次最多 +20：写 up100 也只加 20。
  const second = gate.applyTags('又被夸了[[mood:up100]]', conversation);
  assert.equal(second, '又被夸了');
  assert.equal(gate.moodFor(conversation).score, 35);
  assert.equal(gate.moodFor(conversation).grant, false);

  // down 减分；不会减到负数。
  gate.applyTags('[[mood:down100]]', conversation);
  assert.equal(gate.moodFor(conversation).score, 15);
  gate.applyTags('[[mood:down100]]', conversation);
  assert.equal(gate.moodFor(conversation).score, 0);

  // 没有 tag 的正文一个字都不动（包括换行）。
  const plain = '第一行\n\n第二行';
  assert.equal(gate.applyTags(plain, conversation), plain);
});

test('applyTags：分数到阈值就放行一次，放完清零（门控不会永久开着）', () => {
  const { gate } = gateOf({ settings: { ...SETTINGS, moodTagMaxFull: 100, moodTriggerFull: 60 } });
  gate.applyTags('夸一下 [[mood:up60]]', conversation);
  const mood = gate.moodFor(conversation);
  assert.equal(mood.score, 60);
  assert.equal(mood.grant, true);

  assert.equal(gate.stickerBefore(conversation), 'mood');
  gate.stickerAfter(conversation, 'mood');
  assert.equal(gate.moodFor(conversation).score, 0);
  assert.equal(gate.moodFor(conversation).grant, false);
  // 用掉之后再发就该被拒。
  assert.throws(() => gate.stickerBefore(conversation), /表情权限没开/);
});

test('decay：每个间隔 ×0.75，到归零时间直接清零并收回许可', () => {
  const { gate } = gateOf();
  const mood = gate.moodFor(conversation);
  mood.score = 80;
  mood.grant = true;
  mood.lastAt = Date.now() - 3 * SETTINGS.moodDecayIdleMs - 1;

  gate.decay(conversation);
  // 80 × 0.75³ ≈ 33.75 → 34；没到阈值，许可必须收回。
  assert.equal(gate.moodFor(conversation).score, 34);
  assert.equal(gate.moodFor(conversation).grant, false);

  gate.moodFor(conversation).score = 90;
  gate.moodFor(conversation).grant = true;
  gate.moodFor(conversation).lastAt = Date.now() - SETTINGS.moodZeroIdleMs - 1;
  gate.decay(conversation);
  assert.equal(gate.moodFor(conversation).score, 0);
  assert.equal(gate.moodFor(conversation).grant, false);
});

test('stickerBefore：用户明确要表情 / 斗图模式 / 模块关掉都放行，且原因分得清', () => {
  const { gate } = gateOf();
  assert.throws(() => gate.stickerBefore(conversation), /表情权限没开/);
  assert.equal(gate.stickerBefore(conversation, true), 'request');
  // 用户请求不消耗心情，也不该把 grant 设上。
  gate.stickerAfter(conversation, 'request');
  assert.equal(gate.moodFor(conversation).grant, false);
  assert.equal(gate.moodFor(conversation).score, 0);

  const sticker = gateOf({ mode: 'sticker' }).gate;
  assert.equal(sticker.stickerBefore(conversation), 'free');

  const off = gateOf({ moduleOn: false }).gate;
  assert.equal(off.stickerBefore(conversation), 'free');

  // 没有会话（Web 主会话 / 操作员）不受门控。
  assert.equal(gate.stickerBefore(undefined), 'free');
});

test('stickerAfter：只认 mood / request，别的 kind 只更新 lastAt', () => {
  const { gate } = gateOf({ settings: { ...SETTINGS, moodTagMaxFull: 100, moodTriggerFull: 100 } });
  gate.applyTags('[[mood:up100]]', conversation);
  const before = gate.moodFor(conversation).lastAt;
  gate.stickerAfter(conversation, 'free');
  assert.equal(gate.moodFor(conversation).score, 100);
  assert.equal(gate.moodFor(conversation).grant, true);
  assert.ok(gate.moodFor(conversation).lastAt >= before);
});
